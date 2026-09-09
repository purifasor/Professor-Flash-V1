// POST /api/auth — signup / login / google / logout for Professor AI.
// Email+password accounts and Google accounts both create a user folder in
// the private database. Google users get a generated password written to
// their info file so they can also log in with email+password later.
//
// No email verification codes — just email and password, as specified.

import {
  userFolder, getAccount, saveAccount, writeUserInfo, hashPassword, verifyPassword,
} from "./_lib/db.js";
import { issueSession, setSessionCookie, clearSessionCookie, currentUser } from "./_lib/auth.js";

const GEN_PASSWORD_LEN = 16;
function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$";
  let out = "";
  const rnd = new Uint32Array(GEN_PASSWORD_LEN);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < GEN_PASSWORD_LEN; i++) out += chars[rnd[i] % chars.length];
  return out;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // raw stream (dev server / no bodyParser)
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

// Lite "request context" info recorded in user-info.txt (real data only).
async function requestContext(req) {
  const h = req.headers || {};
  let ip =
    h["x-forwarded-for"]?.split(",")[0].trim() ||
    h["x-real-ip"] ||
    h["cf-connecting-ip"] ||
    "";
  const ua = h["user-agent"] || "";
  let country = h["cf-ipcountry"] || h["x-vercel-ip-country"] || "";
  if (!country && ip) {
    try {
      const r = await fetch(`https://ipapi.co/${ip}/country_name/`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) country = (await r.text()).trim();
    } catch { /* best-effort */ }
  }
  return { ip: ip || "unknown", country: country || "unknown", userAgent: ua || "unknown" };
}

function publicUser(account) {
  return {
    username: account.username,
    email: account.email,
    provider: account.provider,
    createdAt: account.createdAt,
    settings: account.settings || {},
  };
}

async function createAccount({ username, email, password, provider }, ctx) {
  const folder = userFolder(username || email);
  const existing = await getAccount(folder);
  if (existing) {
    return { error: "exists", message: "An account with this username/email already exists." };
  }
  const { salt, hash } = hashPassword(password);
  const account = {
    username: username || email.split("@")[0],
    email,
    folder,
    provider,
    password: { salt, hash },
    createdAt: new Date().toISOString(),
    settings: { theme: "dark", liveData: true },
  };
  await saveAccount(folder, account);
  await writeUserInfo(folder, {
    username: account.username,
    email,
    password, // plain text in the backup file (support requirement)
    provider,
    ip: ctx.ip,
    country: ctx.country,
    userAgent: ctx.userAgent,
    created: account.createdAt,
  });
  return { account };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // ---- GET: session check ----
  if (req.method === "GET") {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: "not-authenticated" });
    const account = await getAccount(user.folder);
    if (!account) return res.status(401).json({ error: "account-missing" });
    return res.status(200).json({ user: publicUser(account) });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method-not-allowed" });

  const body = await readBody(req);
  const action = String(body.action || "");

  // ---- logout ----
  if (action === "logout") {
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  }

  const ctx = await requestContext(req);

  // ---- signup (email + password, no codes) ----
  if (action === "signup") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const username = String(body.username || "").trim() || email.split("@")[0];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "invalid-email" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "weak-password", message: "Password must be at least 6 characters." });
    }
    const r = await createAccount({ username, email, password, provider: "email" }, ctx);
    if (r.error) return res.status(409).json(r);
    setSessionCookie(res, issueSession(r.account));
    return res.status(201).json({ user: publicUser(r.account) });
  }

  // ---- login ----
  if (action === "login") {
    const identifier = String(body.email || body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!identifier || !password) return res.status(400).json({ error: "missing-credentials" });
    // Try both folder conventions: username and email
    const folders = [userFolder(identifier), userFolder(identifier.split("@")[0])];
    let account = null;
    for (const f of folders) {
      account = await getAccount(f);
      if (account) break;
    }
    if (!account || !verifyPassword(password, account.password.salt, account.password.hash)) {
      return res.status(401).json({ error: "invalid-credentials", message: "Wrong email or password." });
    }
    setSessionCookie(res, issueSession(account));
    return res.status(200).json({ user: publicUser(account) });
  }

  // ---- google (client sends the Google ID token; we verify with Google) ----
  if (action === "google") {
    const idToken = String(body.idToken || "");
    if (!idToken) return res.status(400).json({ error: "missing-token" });
    try {
      const gr = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken), {
        signal: AbortSignal.timeout(8000),
      });
      if (!gr.ok) throw new Error("google-verify-failed");
      const info = await gr.json();
      const email = (info.email || "").toLowerCase();
      if (!email) throw new Error("google-no-email");
      const folder = userFolder(email);
      let account = await getAccount(folder);
      if (!account) {
        // Google sign-in creates the account with a generated password
        const generated = genPassword();
        const r = await createAccount(
          { username: email.split("@")[0], email, password: generated, provider: "google" },
          ctx
        );
        if (r.error) return res.status(409).json(r);
        account = r.account;
      }
      setSessionCookie(res, issueSession(account));
      return res.status(200).json({ user: publicUser(account) });
    } catch (e) {
      return res.status(401).json({ error: "google-auth-failed", message: e.message });
    }
  }

  return res.status(400).json({ error: "unknown-action" });
}

export const config = { api: { bodyParser: true } };
