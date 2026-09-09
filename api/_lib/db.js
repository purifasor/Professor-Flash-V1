// GitHub-backed database for Professor AI user accounts.
// Storage: private repo purifasor/professor-ai-db (deploy-key auth —
// independent of any personal token, so access never breaks).
// Layout per user:
//   <username>/
//     user-info.txt           (backup + support file)
//     Chats/<date>-<slug>.txt (per-conversation history)
//     Models/<provider>.txt   (custom providers)
//     _auth.json              (account record — hashed password)
// Auth reads go through a small in-memory cache to keep logins fast.

import crypto from "node:crypto";

const API = "https://api.github.com";

// --- credentials: deploy key (ssh) converted to a token-free strategy -----
// Vercel serverless cannot do SSH, so we accept EITHER:
//   env GITHUB_DB_TOKEN   — a classic/fine-grained PAT with repo scope
//   env GITHUB_DB_KEY     — base64 ed25519 deploy private key (used by the
//                          refresh flow to mint tokens is NOT possible; keys
//                          are accepted for local/git operations)
// The recommended production setup is a fine-grained PAT scoped to ONLY the
// two private repos — rotating it never touches the app code.
function ghAuth() {
  const tok = process.env.GITHUB_DB_TOKEN || process.env.GH_DB_TOKEN;
  return {
    "Authorization": `Bearer ${tok}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

const REPO = process.env.GITHUB_DB_REPO || "purifasor/professor-ai-db";
const BRANCH = process.env.GITHUB_DB_BRANCH || "main";

const owner = () => REPO.split("/")[0];
const name = () => REPO.split("/")[1];

// -------------------------------------------------------------- gh primitives
async function gh(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...ghAuth(), ...(opts.headers || {}) },
  });
  return res;
}

async function ghJson(path, opts = {}) {
  const res = await gh(path, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, data, text };
}

/** Put a file (create or update). Returns commit sha or throws. */
export async function putFile(path, content, message) {
  const { data: existing } = await ghJson(
    `/repos/${REPO}/contents/${encodeURI(path)}?ref=${BRANCH}`
  );
  const body = {
    message: message || `update ${path}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (existing && existing.sha) body.sha = existing.sha;
  const r = await ghJson(`/repos/${REPO}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db-put-failed: ${r.status} ${r.text?.slice(0, 120)}`);
  return r.data?.commit?.sha;
}

/** Get a file's decoded text, or null when missing. */
export async function getFile(path) {
  const r = await ghJson(`/repos/${REPO}/contents/${encodeURI(path)}?ref=${BRANCH}`);
  if (!r.ok || !r.data || typeof r.data.content !== "string") return null;
  return Buffer.from(r.data.content, "base64").toString("utf8");
}

/** Delete a file. Silent success when missing. */
export async function deleteFile(path, message) {
  const { data: existing } = await ghJson(
    `/repos/${REPO}/contents/${encodeURI(path)}?ref=${BRANCH}`
  );
  if (!existing || !existing.sha) return;
  const r = await ghJson(`/repos/${REPO}/contents/${encodeURI(path)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message || `delete ${path}`,
      sha: existing.sha,
      branch: BRANCH,
    }),
  });
  if (!r.ok) throw new Error(`db-delete-failed: ${r.status}`);
}

/** List a directory's entries (name, type). */
export async function listDir(dir) {
  const r = await ghJson(
    `/repos/${REPO}/contents/${encodeURI(dir.replace(/\/$/, ""))}?ref=${BRANCH}`
  );
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.map((e) => ({ name: e.name, path: e.path, type: e.type }));
}

// ------------------------------------------------------------------ helpers
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "user";
}

export function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(password), s, 32).toString("hex");
  return { salt: s, hash: h };
}

export function verifyPassword(password, salt, expected) {
  try {
    const h = crypto.scryptSync(String(password), salt, 32).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- accounts
/** Sanitize a username/email into a safe folder name. */
export function userFolder(identifier) {
  let base = String(identifier || "").trim().toLowerCase();
  base = base.replace(/[^a-z0-9@._-]/g, "");
  if (!base || base.length < 2) base = "user-" + crypto.randomBytes(4).toString("hex");
  return base.slice(0, 60);
}

const cache = new Map(); // folder -> { account, at }
const CACHE_TTL = 3 * 60 * 1000;

export async function getAccount(folder) {
  if (cache.has(folder)) {
    const c = cache.get(folder);
    if (Date.now() - c.at < CACHE_TTL) return c.account;
  }
  const raw = await getFile(`${folder}/_auth.json`);
  if (!raw) return null;
  try {
    const account = JSON.parse(raw);
    cache.set(folder, { account, at: Date.now() });
    return account;
  } catch {
    return null;
  }
}

export async function saveAccount(folder, account) {
  const path = `${folder}/_auth.json`;
  await putFile(path, JSON.stringify(account, null, 2), `account: ${folder}`);
  cache.set(folder, { account, at: Date.now() });
}

export function invalidateAccount(folder) {
  cache.delete(folder);
}

// ------------------------------------------------------------ user-info.txt
/**
 * The backup/support record (plain text, includes the password verbatim
 * as requested for support workflows).
 */
export async function writeUserInfo(folder, { username, email, password, provider, ip, country, userAgent, created }) {
  const lines = [
    "========================================",
    " PROFESSOR AI — USER INFO (backup)",
    "========================================",
    `Username : ${username || ""}`,
    `Email    : ${email || ""}`,
    `Password : ${password || ""}`,
    `Provider : ${provider || "email"}`,
    "",
    "---- Registration context ----",
    `Registered at : ${created || new Date().toISOString()}`,
    `IP address    : ${ip || "unknown"}`,
    `IP country    : ${country || "unknown"}`,
    `User agent    : ${userAgent || "unknown"}`,
    "",
    "---- Folder contents ----",
    "Chats/   — conversation history",
    "Models/  — custom AI providers (if any)",
  ];
  await putFile(`${folder}/user-info.txt`, lines.join("\n"), `user info: ${folder}`);
}

// ------------------------------------------------------------------- chats
/**
 * Save a conversation transcript. Readable format: separate labeled blocks for
 * user messages and assistant answers, code fenced in its own containers.
 */
export async function saveChat(folder, chat) {
  if (!chat || !Array.isArray(chat.messages) || !chat.messages.length) return;
  const date = (chat.createdAt || new Date().toISOString()).slice(0, 10);
  const slug = slugify(chat.title || "conversation");
  const dir = `${folder}/Chats`;
  const path = `${dir}/${date}-${slug}.txt`;

  const parts = [
    "========================================",
    ` PROFESSOR AI — CHAT HISTORY`,
    ` Title : ${chat.title || "Conversation"}`,
    ` Mode  : ${chat.mode || "chat"}`,
    ` Model : ${chat.model || "default"}`,
    ` Date  : ${date}`,
    "========================================",
    "",
  ];
  for (const m of chat.messages) {
    if (m.role === "user") {
      parts.push("┌─────────── USER ───────────┐");
      parts.push(m.content);
      parts.push("└─────────────────────────────┘", "");
    } else if (m.role === "assistant") {
      parts.push("┌───────── ASSISTANT ─────────┐");
      parts.push(m.content || "");
      parts.push("└─────────────────────────────┘", "");
    }
  }
  await putFile(path, parts.join("\n"), `chat: ${folder} ${date}`);
}

/** Delete every chat file of a user (clear history). */
export async function clearChats(folder) {
  const entries = await listDir(`${folder}/Chats`);
  for (const e of entries) {
    if (e.type === "file" && e.name.endsWith(".txt")) {
      await deleteFile(e.path, `clear history: ${folder}`);
    }
  }
}

// ------------------------------------------------------------------ models
/** Save/replace a user's custom provider record. */
export async function saveModel(folder, model) {
  const slug = slugify(model.name || model.modelId || "provider");
  const lines = [
    "========================================",
    " PROFESSOR AI — CUSTOM PROVIDER",
    "========================================",
    `Name        : ${model.name || ""}`,
    `Base URL    : ${model.baseUrl || ""}`,
    `API Key     : ${model.apiKey || ""}`,
    `Model name  : ${model.modelName || ""}`,
    `Model ID    : ${model.modelId || ""}`,
    `Added at    : ${new Date().toISOString()}`,
    `Status      : ${model.status || "active"}`,
  ];
  await putFile(`${folder}/Models/${slug}.txt`, lines.join("\n"), `model: ${folder} ${slug}`);
}

/** List the user's saved providers (parsed from Models/*.txt). */
export async function listModels(folder) {
  const entries = await listDir(`${folder}/Models`);
  const out = [];
  for (const e of entries) {
    if (e.type !== "file" || !e.name.endsWith(".txt")) continue;
    const raw = await getFile(e.path);
    if (!raw) continue;
    const get = (k) => {
      const m = new RegExp(`^${k}\\s*:\\s*(.*)$`, "m").exec(raw);
      return m ? m[1].trim() : "";
    };
    out.push({
      name: get("Name"),
      baseUrl: get("Base URL"),
      apiKey: get("API Key"),
      modelName: get("Model name"),
      modelId: get("Model ID"),
      status: get("Status") || "active",
    });
  }
  return out;
}

/** Describe a user's folder contents (counts) for profile display. */
export async function folderStats(folder) {
  const root = await listDir(folder);
  const stats = { chats: 0, models: 0, hasInfo: false };
  for (const e of root) {
    if (e.type === "dir" && e.name === "Chats") {
      const files = await listDir(e.path);
      stats.chats = files.filter((f) => f.type === "file").length;
    }
    if (e.type === "dir" && e.name === "Models") {
      const files = await listDir(e.path);
      stats.models = files.filter((f) => f.type === "file").length;
    }
    if (e.type === "file" && e.name === "user-info.txt") stats.hasInfo = true;
  }
  return stats;
}
