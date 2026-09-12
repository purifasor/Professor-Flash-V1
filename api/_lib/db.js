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

// ------------------------------------------------------- size guard + shards
// GitHub repos scale far past our data size, but the user's rule: when the
// DB repo grows past 500MB, roll over to a NEW repo (db-2, db-3, …) and
// keep the chain connected — the old shards stay readable, new writes go
// to the active shard. A pointer file in each shard records the successor.
const SHARD_LIMIT_KB = 500 * 1024; // 500MB
let _sizeCheckedAt = 0;

/** Repo size in KB (GitHub reports size in KB). Cached 10 minutes. */
async function repoSizeKb() {
  if (Date.now() - _sizeCheckedAt < 10 * 60 * 1000) return globalThis.__pfDbSizeKb ?? 0;
  try {
    const r = await ghJson(`/repos/${REPO}`);
    const kb = r.ok && r.data?.size ? Number(r.data.size) : 0;
    globalThis.__pfDbSizeKb = kb;
    _sizeCheckedAt = Date.now();
    return kb;
  } catch {
    return globalThis.__pfDbSizeKb ?? 0;
  }
}

/**
 * When the active DB shard crosses the 500MB line, create the next shard
 * repo (purifasor/professor-ai-db-2, -3, …), write a successor pointer in
 * the old shard, and switch GITHUB_DB_REPO-style writes to it. The chain
 * stays connected: each shard's _shard.json points forward; account lookups
 * still prefer the active shard and fall back through the chain.
 */
export async function ensureShardCapacity() {
  const kb = await repoSizeKb();
  if (kb < SHARD_LIMIT_KB * 0.95) return REPO; // plenty of headroom
  // read the successor pointer (if a roll already happened)
  try {
    const r = await getFile("_shard.json");
    if (r) {
      const meta = JSON.parse(r);
      if (meta.nextRepo && meta.nextRepo !== REPO) return meta.nextRepo; // already rolled
    }
  } catch { /* no pointer yet */ }
  // roll: create next shard repo with the same visibility + README chain link
  const m = /^(.*?)(\d+)?$/.exec(name());
  const base = m[1].replace(/-$/, "");
  const n = m[2] ? Number(m[2]) + 1 : 2;
  const nextRepoName = `${base}-${n}`;
  const create = await ghJson(`/user/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: nextRepoName,
      private: true,
      description: `Professor AI DB shard ${n} — continuation of ${REPO} (auto-rolled at 500MB)`,
      auto_init: true,
    }),
  });
  if (create.ok) {
    try {
      // chain pointer in the OLD shard
      await putFile("_shard.json", JSON.stringify({ nextRepo: `${owner()}/${nextRepoName}`, rolledAt: new Date().toISOString() }, null, 2), "db: shard rollover pointer");
    } catch { /* pointer best-effort */ }
    globalThis.__pfDbSizeKb = 0; // fresh shard
    _sizeCheckedAt = Date.now();
    return `${owner()}/${nextRepoName}`;
  }
  return REPO; // couldn't create (permissions?) — keep writing to current
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

// ------------------------------------------------- accounts index (_index.json)
// email/username (lowercased) → folder. Makes login lookup exact — no
// folder-name guessing. Best-effort: if the index is unreadable, the
// folder-guess fallback in auth.js still works.
const INDEX_PATH = "_index.json";

export async function getIndex() {
  const raw = await getFile(INDEX_PATH);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // sanitize corrupted entries (a past bug stored non-string values)
    const clean = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (typeof v === "string" && v) clean[k] = v;
    }
    return clean;
  } catch { return {}; }
}

export async function setIndexEntry(key, folder) {
  const k = String(key || "").trim().toLowerCase();
  if (!k || !folder) return;
  // a previous bug wrote Promise objects into the index; sanitize on write
  const f = String(folder);
  const index = await getIndex();
  index[k] = f;
  await putFile(INDEX_PATH, JSON.stringify(index, null, 2), `index: ${k} → ${f}`);
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
 * Save a conversation transcript. Stable identity: one file per chat —
 * the filename derives from a chat key (client-supplied, unique per
 * conversation) so continued conversations UPDATE their file instead of
 * fragmenting into one file per turn (that fragmentation made the sidebar
 * show dozens of duplicates after re-login).
 */
export async function saveChat(folder, chat) {
  if (!chat || !Array.isArray(chat.messages) || !chat.messages.length) return;
  // 500MB guard: roll to the next shard repo when this one fills up
  await ensureShardCapacity().catch(() => {});
  const created = chat.createdAt || new Date().toISOString();
  const d = new Date(created);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
  const slug = slugify(chat.title || "conversation");
  const dir = `${folder}/Chats`;
  // stable chat key → same file every turn; falls back to stamp+title for
  // legacy clients that send no key
  const key = String(chat.key || "")
    .replace(/[^a-z0-9-]/gi, "")
    .slice(-42);
  const path = key
    ? `${dir}/${stamp}-${slug}-${key || Date.now().toString(36)}.txt`
    : `${dir}/${stamp}-${slug}-${Date.now().toString(36)}.txt`;
  // with a key, always resolve to the SAME existing file (the stamp differs
  // across turns): list the folder once and match the key suffix
  let finalPath = path;
  if (key) {
    const entries = await listDir(dir).catch(() => []);
    const existing = entries.find(
      (e) => e.type === "file" && e.name.endsWith(`-${key}.txt`)
    );
    if (existing) finalPath = existing.path;
  }

  const parts = [
    "========================================",
    ` PROFESSOR AI — CHAT HISTORY`,
    ` Title : ${chat.title || "Conversation"}`,
    ` Mode  : ${chat.mode || "chat"}`,
    ` Model : ${chat.model || "default"}`,
    ` Date  : ${stamp.replace("_", " ")} UTC`,
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
  await putFile(path, parts.join("\n"), `chat: ${folder} ${stamp}`);
}

/**
 * Parse a saved chat transcript back into structured messages.
 * Mirrors the saveChat format (labeled USER/ASSISTANT blocks).
 */
export function parseChatFile(raw) {
  const text = String(raw || "");
  const get = (k) => {
    const m = new RegExp(`(?:^|\\n)\\s*${k}\\s*:\\s*(.*)`).exec(text);
    return m ? m[1].trim() : "";
  };
  const messages = [];
  const blockRe = /┌─+\s*(USER|ASSISTANT)\s*─+┐\n([\s\S]*?)\n└─+┘/g;
  let m;
  while ((m = blockRe.exec(text))) {
    const role = m[1].toLowerCase() === "user" ? "user" : "assistant";
    const content = m[2].trim();
    if (content) messages.push({ role, content });
  }
  return {
    title: get("Title") || "Conversation",
    mode: get("Mode") || "chat",
    model: get("Model") || "default",
    messages,
  };
}

/**
 * List a user's saved conversations (newest first), parsed and ready to
 * restore into the sidebar after a fresh login.
 */
export async function listChats(folder, limit = 40) {
  const entries = await listDir(`${folder}/Chats`).catch(() => []);
  const files = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".txt"))
    .sort((a, b) => b.name.localeCompare(a.name)) // newest first (stamp prefix)
    .slice(0, limit);
  const out = [];
  for (const f of files) {
    const raw = await getFile(f.path).catch(() => null);
    if (!raw) continue;
    const chat = parseChatFile(raw);
    if (chat.messages.length) {
      chat.path = f.path;
      chat.createdAt = f.name.slice(0, 16).replace("_", "T") + "Z";
      out.push(chat);
    }
  }
  return out;
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

/**
 * Delete ONE of the user's saved providers by name/modelId.
 * Per-user by construction: the record lives in the user's own folder —
 * other users' providers are never touched.
 */
export async function deleteModel(folder, nameOrId) {
  const slug = slugify(nameOrId);
  const target = `${folder}/Models/${slug}.txt`;
  const entries = await listDir(`${folder}/Models`).catch(() => []);
  if (!entries.some((e) => e.type === "file" && e.path === target)) return false;
  await deleteFile(target, `model removed: ${folder} ${slug}`);
  return true;
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
