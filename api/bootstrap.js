// GET /api/bootstrap — tiny public config for the frontend (no secrets).
// Returns the Google OAuth client ID when ANY of these env vars is set at
// deploy time, so Google sign-in works the moment the owner adds one —
// zero code changes needed (GOOGLE_CLIENT_ID preferred; equivalent vars
// are also auto-detected).
export default async function handler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  const candidates = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    process.env.AUTH_GOOGLE_ID,
    process.env.GOOGLE_SIGNIN_CLIENT_ID,
  ];
  const googleClientId = (candidates.find((v) => (v || "").trim()) || "").trim();
  res.status(200).json({ googleClientId: googleClientId || null });
}
