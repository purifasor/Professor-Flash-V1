// Sessions for Professor AI — signed httpOnly cookie tokens (JWT-style).
// "Stay logged in" is default: 400-day cookie, rolling refresh on each request.

import crypto from "node:crypto";

const SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update("professor-ai-dev-secret").digest("hex");

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(body).digest());
  try {
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const COOKIE = "professor_session";
const YEAR_MS = 400 * 24 * 3600 * 1000; // ~13 months — effectively "stay logged in"

export function issueSession(user) {
  return sign({
    sub: user.folder,
    username: user.username,
    email: user.email,
    iat: Date.now(),
    exp: Date.now() + YEAR_MS,
  });
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${Math.floor(YEAR_MS / 1000)}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Extract the current user from the request cookie. */
export function currentUser(req) {
  const header = req.headers?.cookie || "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(header);
  if (!m) return null;
  const payload = verify(m[1]);
  return payload ? { folder: payload.sub, username: payload.username, email: payload.email } : null;
}
