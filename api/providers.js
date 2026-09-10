// POST /api/providers — save / list / delete custom AI providers for the user.
// POST /api/providers with action=test runs a live connection test.

import { currentUser } from "./_lib/auth.js";
import { saveModel, listModels, deleteModel } from "./_lib/db.js";
import { testProvider } from "./_lib/remote.js";
import { slugify } from "./_lib/db.js";

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

  if (req.method === "GET") {
    const providers = await listModels(user.folder).catch(() => []);
    return res.status(200).json({ providers });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method-not-allowed" });
  const body = await readBody(req);

  // ---- test connection (no save yet) ----
  if (body.action === "test") {
    const result = await testProvider({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      modelId: body.modelId || body.modelName,
    });
    return res.status(200).json(result);
  }

  // ---- save provider (tested & working) ----
  if (body.action === "save") {
    const record = {
      name: String(body.name || body.modelId || "provider").slice(0, 60),
      baseUrl: String(body.baseUrl || "").slice(0, 300),
      apiKey: String(body.apiKey || "").slice(0, 300),
      modelName: String(body.modelName || "").slice(0, 120),
      modelId: String(body.modelId || body.modelName || "").slice(0, 120),
      status: "active",
    };
    if (!record.baseUrl || !record.modelId) {
      return res.status(400).json({ error: "missing-fields", message: "Base URL and model ID are required." });
    }
    await saveModel(user.folder, record);
    return res.status(200).json({ ok: true, provider: record });
  }

  // ---- delete provider (per-user: only from THIS user's folder) ----
  if (body.action === "delete") {
    const target = String(body.name || body.modelId || "").trim();
    if (!target) {
      return res.status(400).json({ error: "missing-fields", message: "Provider name is required." });
    }
    const deleted = await deleteModel(user.folder, target);
    if (!deleted) {
      return res.status(404).json({ error: "not-found", message: "Provider not found." });
    }
    const providers = await listModels(user.folder).catch(() => []);
    return res.status(200).json({ ok: true, deleted: true, providers });
  }

  return res.status(400).json({ error: "unknown-action" });
}

export const config = { api: { bodyParser: true } };
