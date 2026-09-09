// GET/POST /api/profile — user profile, settings, stats, clear history.
// DELETE history requires a confirm:"DELETE" flag (client shows the
// "Are you sure?" warning in English).

import {
  getAccount, clearChats, folderStats, listModels, saveAccount, invalidateAccount,
} from "./_lib/db.js";
import { currentUser } from "./_lib/auth.js";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "not-authenticated" });
  const account = await getAccount(user.folder);
  if (!account) return res.status(401).json({ error: "account-missing" });

  // ---- GET: profile + stats + providers ----
  if (req.method === "GET") {
    const [stats, providers] = await Promise.all([
      folderStats(user.folder),
      listModels(user.folder).catch(() => []),
    ]);
    return res.status(200).json({
      user: {
        username: account.username,
        email: account.email,
        provider: account.provider,
        createdAt: account.createdAt,
        settings: account.settings || {},
      },
      stats,
      providers,
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method-not-allowed" });
  const body = await readBody(req);

  // ---- clear chat history (with confirmation guard) ----
  if (body.action === "clear-history") {
    if (body.confirm !== "DELETE") {
      return res.status(400).json({ error: "confirmation-required" });
    }
    await clearChats(user.folder);
    return res.status(200).json({ ok: true, cleared: true });
  }

  // ---- save settings ----
  if (body.action === "settings") {
    account.settings = { ...(account.settings || {}), ...(body.settings || {}) };
    await saveAccount(user.folder, account);
    return res.status(200).json({ ok: true, settings: account.settings });
  }

  return res.status(400).json({ error: "unknown-action" });
}

export const config = { api: { bodyParser: true } };
