// GET/POST /api/e2b — the user's E2B cloud key (agent sandbox access).
// The key NEVER travels back to the browser — GET returns only a masked
// status (set/unset). POST validates live against E2B before saving, so a
// locked agent can only be unlocked by a working key.

import { currentUser } from "./_lib/auth.js";
import { getAccount, saveAccount, putFile } from "./_lib/db.js";
import { validateE2BKey, sealKey, unsealKey } from "./_lib/e2b.js";

function maskKey(k) {
  const s = String(k || "");
  if (!s) return "";
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "…" + s.slice(-4) + ` (${s.length} chars)`;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "not-authenticated" });
  const account = await getAccount(user.folder);
  if (!account) return res.status(401).json({ error: "account-missing" });

  // ---- GET: masked status only (never the key itself) ----
  if (req.method === "GET") {
    const sealed = account.settings?.e2bKey;
    const key = sealed ? unsealKey(sealed) : "";
    return res.status(200).json({
      connected: !!key,
      masked: key ? maskKey(key) : "",
      signupUrl: "https://e2b.dev",
      keysUrl: "https://console.e2b.dev/?tab=keys",
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method-not-allowed" });
  const body = await readBody(req);

  // ---- validate (no save): the gate's "Verify" button ----
  if (body.action === "validate") {
    const result = await validateE2BKey(String(body.apiKey || ""));
    return res.status(200).json(result);
  }

  // ---- save: validate LIVE first, then store ----
  if (body.action === "save") {
    const key = String(body.apiKey || "").trim();
    const result = await validateE2BKey(key);
    if (!result.ok) return res.status(200).json(result);
    account.settings = { ...(account.settings || {}), e2bKey: sealKey(key) };
    await saveAccount(user.folder, account);
    // private backup record (masked only — the key itself stays sealed)
    await putFile(
      `${user.folder}/e2b.txt`,
      ["E2B SANDBOX KEY (sealed)", `Saved at: ${new Date().toISOString()}`, `Key: ${maskKey(key)}`].join("\n"),
      `e2b key: ${user.folder}`
    ).catch(() => {});
    return res.status(200).json({ ok: true, detail: result.detail, masked: maskKey(key) });
  }

  // ---- disconnect ----
  if (body.action === "delete") {
    delete (account.settings || {}).e2bKey;
    await saveAccount(user.folder, account);
    return res.status(200).json({ ok: true, connected: false });
  }

  return res.status(400).json({ error: "unknown-action" });
}

export const config = { api: { bodyParser: true } };
