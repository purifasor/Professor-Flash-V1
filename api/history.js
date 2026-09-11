// GET/POST /api/history — list + save the user's conversations.
// GET restores the sidebar chat list after re-login (fresh browser, new
// device, or after sign-out/sign-in) from the private GitHub DB.
// POST saves a finished conversation. Silent best-effort either way.

import { currentUser } from "./_lib/auth.js";
import { saveChat, listChats } from "./_lib/db.js";

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

  // ---- GET: list saved conversations (sidebar restore) ----
  if (req.method === "GET") {
    try {
      const chats = await listChats(user.folder, 40);
      return res.status(200).json({ chats });
    } catch {
      return res.status(200).json({ chats: [] }); // best-effort — never block login
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method-not-allowed" });

  const body = await readBody(req);
  if (!body.title || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "bad-payload" });
  }
  try {
    await saveChat(user.folder, {
      title: String(body.title).slice(0, 120),
      mode: body.mode === "agent" ? "agent" : "chat",
      model: String(body.model || "default").slice(0, 80),
      messages: body.messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .slice(-80),
      createdAt: body.createdAt || new Date().toISOString(),
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    // history saving is best-effort; the chat itself must never fail
    res.status(200).json({ ok: false, error: e.message?.slice(0, 80) });
  }
}

export const config = { api: { bodyParser: true } };
