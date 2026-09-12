// E2B-backed agent pipeline: the model plans, files stream INTO a real E2B
// sandbox, the project actually RUNS there (install + build + dev server or
// script), runtime errors feed back to the model for self-repair, and the
// sandbox's real directory becomes the Files tab source of truth.
//
// Design (runs inside POST /api/chat, mode:"agent"):
//   1. sandbox find-or-create (per user+project, metadata-tagged)
//   2. the model emits files as ```file: blocks (same contract as always)
//   3. files are written to the sandbox filesystem immediately
//   4. an "inspection" pass: `find . -type f` + key file heads, so the model
//      sees the CURRENT state of its project even after reconnects
//   5. runner heuristic: package.json → npm install + npm run build/dev;
//      python → run; static web → mark for preview
//   6. stderr/exit problems are injected back as RUNTIME ERRORS for the
//      model's repair passes (the same self-heal loop, now with real teeth)

import {
  getOrCreateSandbox, writeFile, readFile, listDir, runCommand, keepAlive,
} from "./e2b.js";

const HOME = "/home/user";

/** Write every parsed file block into the sandbox. */
export async function syncFilesToSandbox(apiKey, sbx, files) {
  let wrote = 0;
  for (const f of files) {
    const path = normalizePath(f.path);
    if (!path) continue;
    await writeFile(apiKey, sbx, path, f.content);
    wrote++;
  }
  return wrote;
}

function normalizePath(p) {
  let s = String(p || "").trim();
  if (!s) return "";
  if (s.startsWith("/")) s = s.slice(1);
  if (!s || s.includes("..") || s.includes("\0")) return "";
  return `${HOME}/${s}`;
}

/** A compact listing of what's currently in the sandbox (for the model). */
export async function sandboxInventory(apiKey, sbx) {
  const entries = await listDir(apiKey, sbx, HOME, 4).catch(() => []);
  if (!entries.length) return { listing: "", fileCount: 0 };
  const files = entries.filter((e) => String(e.type || "") !== "dir" && e.name);
  const listing = files
    .slice(0, 120)
    .map((e) => `${relPath(e.path)} (${humanSize(e.size)})`)
    .join("\n");
  return { listing, fileCount: entries.length };
}

function relPath(p) {
  const s = String(p || "");
  return s.startsWith(HOME + "/") ? s.slice(HOME.length + 1) : s.replace(/^\//, "");
}
function humanSize(n) {
  const v = Number(n) || 0;
  if (v > 1048576) return (v / 1048576).toFixed(1) + "MB";
  if (v > 1024) return (v / 1024).toFixed(1) + "KB";
  return v + "B";
}

/**
 * Read every file currently in the sandbox (bounded) — the Files tab and
 * ZIP download are fed from the REAL sandbox directory, so what the user
 * downloads is exactly what ran in the cloud.
 */
export async function readSandboxProject(apiKey, sbx, maxFiles = 200, maxBytesPerFile = 400_000) {
  const entries = await listDir(apiKey, sbx, HOME, 5).catch(() => []);
  const files = entries
    .filter((e) => String(e.type || "") !== "dir" && e.name)
    .filter((e) => !/\/(node_modules|\.git|\.npm|venv|__pycache__)\//.test(e.path))
    .slice(0, maxFiles);
  const out = [];
  let total = 0;
  for (const e of files) {
    if (total > 6_000_000) break;
    const text = await readFile(apiKey, sbx, e.path).catch(() => null);
    if (text == null) continue; // binary or unreadable — skip
    const capped = text.length > maxBytesPerFile ? text.slice(0, maxBytesPerFile) : text;
    total += capped.length;
    out.push({ path: relPath(e.path), content: capped, truncated: text.length > maxBytesPerFile });
  }
  return out;
}

/**
 * Detect + execute the project in the sandbox.
 * Returns { kind, stdout, stderr, exitCode, hint } — hint is a human line
 * for the chat feed; errors flow into the model's repair passes.
 */
export async function runProjectInSandbox(apiKey, sbx) {
  const pkg = await readFile(apiKey, sbx, `${HOME}/package.json`).catch(() => null);
  if (pkg) {
    const installed = await runCommand(apiKey, sbx, "cd /home/user && npm install --no-audit --no-fund --loglevel=error", { timeoutMs: 180000 });
    keepAlive(apiKey, sbx.sandboxID).catch(() => {});
    const hasBuild = /"(build|start|dev)"\s*:/.test(pkg);
    if (hasBuild) {
      const ran = await runCommand(apiKey, sbx, "cd /home/user && (npm run build --silent || npm run start --silent) 2>&1 | tail -40", { timeoutMs: 180000 });
      keepAlive(apiKey, sbx.sandboxID).catch(() => {});
      return {
        kind: "node",
        stdout: (installed.stdout || "") + (ran.stdout || ""),
        stderr: (installed.stderr || "") + (ran.stderr || ""),
        exitCode: ran.code,
        hint: "Ran npm install + build inside your E2B sandbox.",
      };
    }
    return {
      kind: "node",
      stdout: installed.stdout || "",
      stderr: installed.stderr || "",
      exitCode: installed.code,
      hint: "npm install finished in your E2B sandbox.",
    };
  }

  // single python entry
  const pyEntries = await listDir(apiKey, sbx, HOME, 1).catch(() => []);
  const py = (pyEntries || []).find((e) => /main\.py$/i.test(e.name || ""));
  if (py) {
    const ran = await runCommand(apiKey, sbx, "cd /home/user && (python3 main.py 2>&1 || python main.py 2>&1) | tail -40", { timeoutMs: 120000 });
    keepAlive(apiKey, sbx.sandboxID).catch(() => {});
    return { kind: "python", stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.code, hint: "Executed main.py in your E2B sandbox." };
  }

  // static web project — nothing to "run", the preview serves the files
  return { kind: "static", stdout: "", stderr: "", exitCode: 0, hint: "Static project staged in your E2B sandbox." };
}

/** Frame the sandbox state for the model's context. */
export function sandboxContextBlock(inv, run) {
  const parts = [];
  if (inv?.fileCount) {
    parts.push(
      `LIVE E2B SANDBOX STATE (${inv.fileCount} entries in /home/user):\n` +
      (inv.listing || "(empty)")
    );
  }
  if (run) {
    parts.push(
      `LAST RUN IN SANDBOX (${run.kind}) exit=${run.exitCode ?? "?"}:\n` +
      `stdout: ${(run.stdout || "").slice(-1500)}\nstderr: ${(run.stderr || "").slice(-1500)}`
    );
  }
  return parts.join("\n\n");
}

export { getOrCreateSandbox, keepAlive };
