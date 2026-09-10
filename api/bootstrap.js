// GET /api/bootstrap — tiny public config for the frontend (no secrets).
// Returns the Google OAuth client ID when GOOGLE_CLIENT_ID is set at deploy
// time, so Google sign-in works the moment the owner adds the env var —
// zero code changes needed.

export default async function handler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  const googleClientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  if (googleClientId) {
    // inject into the page's meta tag for Google Identity Services
    res.status(200).json({ googleClientId });
  } else {
    res.status(200).json({ googleClientId: null });
  }
}
