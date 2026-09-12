// E2B cloud sandbox runtime for the Professor Agent.
// The user brings their own E2B API key (https://e2b.dev — sign up, copy the
// key from https://console.e2b.dev/?tab=keys). The agent then builds INSIDE
// an E2B Linux sandbox: the model's files land on a real filesystem, the
// sandbox runs the project (node/python/etc.), and the Files tab reads the
// sandbox's actual directory — download included.
//
// Wire protocol (from E2B's public OpenAPI):
//   Platform  https://api.e2b.app          — X-API-Key
//     POST /sandboxes                     — create (templateID "base")
//     GET  /sandboxes?metadata=key=value   — find ours later
//     POST /sandboxes/{id}/connect         — wake/extend
//     POST /sandboxes/{id}/timeout         — keep-alive
//     DELETE /sandboxes/{id}               — kill
//   Sandbox host  https://sandbox.e2b.app — E2b-Sandbox-Id header
//     POST /files?path=…                   — upload (PUT via POST multipart)
//     GET  /files?path=…                   — download bytes
//     POST /filesystem.Filesystem/ListDir — connect+json {path, depth}
//     POST /process.Process/Start          — connect+json {process:{cmd,args,cwd}}
//       (streaming connect protocol: stdout/stderr frames, end frame w/ exit)
// Env vars on our side: E2B_ENVD_PORT (default 49983).

import { fetchTimeout } from "./util.js";

const PLATFORM = "https://api.e2b.app";
const SANDBOX_HOST = "https://sandbox.e2b.app";
const ENVD_PORT = Number(process.env.E2B_ENVD_PORT || 49983);

// ------------------------------------------------------------- key vault
// Keys are per-user, stored sealed in the private DB (user's own folder),
// never in client code. AES-CTR under the SESSION_SECRET — the sealed form
// is what's persisted; nothing plaintext ever hits disk or logs.
import crypto from "node:crypto";

function vaultKey() {
  const base = process.env.SESSION_SECRET || "professor-ai-dev-secret";
  return crypto.createHash("sha256").update("e2b-key-vault:" + base).digest();
}

export function sealKey(apiKey) {
  const salt = crypto.randomBytes(8).toString("hex");
  const cipher = crypto.createCipheriv("aes-256-ctr", vaultKey(), salt);
  const enc = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]).toString("base64");
  return `${salt}.${enc}`;
}

export function unsealKey(sealed) {
  try {
    const [salt, enc] = String(sealed || "").split(".");
    const decipher = crypto.createDecipheriv("aes-256-ctr", vaultKey(), salt);
    return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

/** Pull the user's live E2B key out of their account record. */
export async function getE2BKey(account) {
  const sealed = account?.settings?.e2bKey;
  if (!sealed) return "";
  try { return unsealKey(sealed) || ""; } catch { return ""; }
}

/** Validate a user-supplied E2B key: cheap platform call. */
export async function validateE2BKey(apiKey) {
  if (!apiKey || !/^e2b_[A-Za-z0-9_-]+$/.test(apiKey)) {
    return { ok: false, detail: "That doesn't look like an E2B API key (they start with e2b_)." };
  }
  try {
    const res = await fetchTimeout(
      `${PLATFORM}/sandboxes`,
      { method: "GET", headers: { "X-API-Key": apiKey } },
      15000
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: "Key rejected by E2B (invalid or revoked)." };
    }
    if (!res.ok) {
      return { ok: false, detail: `E2B answered HTTP ${res.status} — try again shortly.` };
    }
    const list = await res.json().catch(() => []);
    return { ok: true, detail: "Connected to E2B ✓", runningSandboxes: Array.isArray(list) ? list.length : 0 };
  } catch (e) {
    return { ok: false, detail: `Could not reach E2B: ${String(e.message || e).slice(0, 90)}` };
  }
}

// ----------------------------------------------------------- envd transport
// All sandbox-host calls go through here. Secure sandboxes authenticate with
// their envdAccessToken (X-Access-Token); routing headers select the sandbox.
function envdHeaders(sbx) {
  return {
    "X-Access-Token": sbx?.envdAccessToken || undefined,
    "E2b-Sandbox-Id": sbx.sandboxID,
    "E2b-Sandbox-Port": String(ENVD_PORT),
  };
}

// ---------------------------------------------------------- sandbox session
// One sandbox per (user, project). Find-or-create so a chat's agent work
// continues in the SAME filesystem across turns.
export async function getOrCreateSandbox(apiKey, meta) {
  const m = meta || {};
  const metaQuery = m.metadata
    ? `?metadata=${encodeURIComponent(m.metadata)}`
    : "";
  // find an existing live sandbox for this project
  if (m.metadata) {
    try {
      const res = await fetchTimeout(
        `${PLATFORM}/sandboxes${metaQuery}`,
        { method: "GET", headers: { "X-API-Key": apiKey } },
        15000
      );
      if (res.ok) {
        const list = await res.json().catch(() => []);
        if (Array.isArray(list) && list.length) {
          const found = list[0];
          const id = found.sandboxID || found.sandboxId;
          // extend its life while we work
          keepAlive(apiKey, id).catch(() => {});
          // the list endpoint omits envdAccessToken — fetch the full detail
          const token = await fetchSandboxToken(apiKey, id);
          return { sandboxID: id, envdAccessToken: token, reused: true };
        }
      }
    } catch { /* fall through to create */ }
  }

  const res = await fetchTimeout(
    `${PLATFORM}/sandboxes`,
    {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: m.templateID || "base",
        timeout: m.timeout || 300, // 5 min default TTL, extended while busy
        secure: true, // sandbox returns envdAccessToken for envd auth
        ...(m.metadata ? { metadata: parseMetadata(m.metadata) } : {}),
      }),
    },
    45000
  );
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = `E2B create failed (HTTP ${res.status})`;
    try {
      const j = JSON.parse(body);
      if (j.error_code) msg += ` — ${j.error_code}`;
      if (j.message) msg += `: ${String(j.message).slice(0, 120)}`;
    } catch { /* plain */ }
    if (res.status === 401) msg = "E2B rejected the API key.";
    const e = new Error(msg);
    e.code = res.status === 401 ? "e2b-bad-key" : "e2b-create-failed";
    throw e;
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("E2B returned a malformed sandbox response"); }
  const id = data.sandboxID || data.sandboxId || data.id;
  if (!id) throw new Error("E2B response carried no sandbox id");
  return { sandboxID: id, envdAccessToken: data.envdAccessToken || null, reused: false };
}

/** GET /sandboxes/{id} → SandboxDetail, which carries envdAccessToken. */
async function fetchSandboxToken(apiKey, sandboxID) {
  if (!sandboxID) return null;
  try {
    const res = await fetchTimeout(
      `${PLATFORM}/sandboxes/${sandboxID}`,
      { method: "GET", headers: { "X-API-Key": apiKey } },
      15000
    );
    if (!res.ok) return null;
    const d = await res.json().catch(() => ({}));
    return d.envdAccessToken || null;
  } catch { return null; }
}

/** user=abc&project=xyz → {user:"abc",project:"xyz"} */
function parseMetadata(qs) {
  const out = {};
  for (const part of String(qs).split("&")) {
    const i = part.indexOf("=");
    if (i > 0) out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

/** Keep a sandbox from timing out mid-build. */
export async function keepAlive(apiKey, sandboxID, seconds = 600) {
  if (!sandboxID) return;
  await fetchTimeout(
    `${PLATFORM}/sandboxes/${sandboxID}/timeout`,
    {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: seconds }),
    },
    10000
  ).catch(() => {});
}

export async function killSandbox(apiKey, sandboxID) {
  if (!sandboxID) return;
  await fetchTimeout(
    `${PLATFORM}/sandboxes/${sandboxID}`,
    { method: "DELETE", headers: { "X-API-Key": apiKey } },
    15000
  ).catch(() => {});
}

// ------------------------------------------------------------- filesystem
/** Upload a text file into the sandbox (parents auto-created). */
export async function writeFile(apiKey, sbx, path, content) {
  const res = await fetchTimeout(
    `${SANDBOX_HOST}/files?path=${encodeURIComponent(path)}`,
    {
      method: "POST",
      headers: {
        ...envdHeaders(sbx),
        "Content-Type": "application/octet-stream",
      },
      body: typeof content === "string" ? content : String(content),
    },
    30000
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`e2b write ${path} failed (HTTP ${res.status}) ${t.slice(0, 80)}`);
  }
  return true;
}

/** Download raw bytes of one file from the sandbox. */
export async function readFile(apiKey, sbx, path) {
  const res = await fetchTimeout(
    `${SANDBOX_HOST}/files?path=${encodeURIComponent(path)}`,
    { method: "GET", headers: envdHeaders(sbx) },
    30000
  );
  if (!res.ok) return null;
  return await res.text().catch(() => null);
}

/** List a directory (recursive depth) → [{name,path,type,size}] */
export async function listDir(apiKey, sbx, path = "/home/user", depth = 3) {
  const res = await fetchTimeout(
    `${SANDBOX_HOST}/filesystem.Filesystem/ListDir`,
    {
      method: "POST",
      headers: {
        ...envdHeaders(sbx),
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({ path, depth }),
    },
    30000
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.entries) ? data.entries : [];
}

// ---------------------------------------------------------- process runner
/**
 * Run a command in the sandbox and collect stdout/stderr/exit.
 * Uses E2B's connect-RPC process endpoint; frames arrive as newline-delimited
 * JSON events ({start}/{data:{stdout}}/{end:{exited, status}}).
 */
export async function runCommand(apiKey, sbx, cmd, { cwd = "/home/user", timeoutMs = 120000, onOutput = () => {} } = {}) {
  const res = await fetchTimeout(
    `${SANDBOX_HOST}/process.Process/Start`,
    {
      method: "POST",
      headers: {
        ...envdHeaders(sbx),
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({ process: { cmd: "/bin/sh", args: ["-c", cmd], cwd } }),
    },
    timeoutMs
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`e2b exec failed (HTTP ${res.status}) ${t.slice(0, 120)}`);
  }
  // stream newline-delimited JSON events
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stdout = "";
  let stderr = "";
  let exited = false;
  let status = "";
  const startedAt = Date.now();
  const deadline = startedAt + (timeoutMs - 5000);
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error("e2b command timed out");
      const read = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("e2b read timeout")), Math.max(2000, deadline - Date.now()))),
      ]);
      const { done, value } = read;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith("{")) continue;
        let ev;
        try { ev = JSON.parse(t); } catch { continue; }
        if (ev.data) {
          if (typeof ev.data.stdout === "string") { stdout += ev.data.stdout; onOutput("stdout", ev.data.stdout); }
          if (typeof ev.data.stderr === "string") { stderr += ev.data.stderr; onOutput("stderr", ev.data.stderr); }
        } else if (ev.end) {
          exited = !!ev.end.exited;
          status = String(ev.end.status || "");
          return { stdout, stderr, exited, status, code: parseExit(status) };
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* done */ }
  }
  return { stdout, stderr, exited, status, code: parseExit(status) };
}

function parseExit(status) {
  const m = /exit status (\d+)/.exec(String(status || ""));
  return m ? Number(m[1]) : null;
}
