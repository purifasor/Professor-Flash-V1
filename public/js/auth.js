// Professor AI — auth UI: sign in / sign up / Google / session bootstrap.
// The app itself stays hidden until a session exists (GET /api/auth).
window.PFAuth = (() => {
  const $ = (id) => document.getElementById(id);

  let mode = "login"; // login | signup
  let user = null;

  function showAuth() {
    $("authScreen").hidden = false;
    $("app").hidden = true;
  }

  function showApp(u) {
    user = u;
    $("authScreen").hidden = true;
    $("app").hidden = false;
    // fill profile bits
    const name = (u && u.username) || "Account";
    $("pbName").textContent = name;
    $("pbAvatar").textContent = name[0].toUpperCase();
    if (window.PFApp && PFApp.onUser) PFApp.onUser(u);
    if (window.PFProfile && PFProfile.load) PFProfile.load(u);
  }

  function authError(msg) {
    const el = $("authError");
    if (!msg) {
      el.hidden = true;
      return;
    }
    el.textContent = msg;
    el.hidden = false;
  }

  function applyMode() {
    const signup = mode === "signup";
    $("fieldUsername").hidden = !signup;
    $("authSubmit").textContent = signup ? "Create account" : "Sign in";
    $("authSub").textContent = signup
      ? "Create your account — email and password, that's it."
      : "Welcome back. Sign in to continue.";
    $("authSwitchText").textContent = signup ? "Already have an account?" : "No account yet?";
    $("authSwitchBtn").textContent = signup ? "Sign in" : "Create one";
    $("authPassword").setAttribute("autocomplete", signup ? "new-password" : "current-password");
    authError("");
  }

  async function submit(e) {
    e.preventDefault();
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    const username = $("authUsername").value.trim();
    if (!email || !password) return;

    $("authSubmit").disabled = true;
    authError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "signup" ? { action: "signup", email, password, username } : { action: "login", email, password }
        ),
      });
      const d = await res.json();
      if (!res.ok) {
        authError(d.message || d.error || "Something went wrong.");
        return;
      }
      showApp(d.user);
    } catch {
      authError("Network error — try again.");
    } finally {
      $("authSubmit").disabled = false;
    }
  }

  function googleSignIn() {
    // Google Identity Services — client ID set at deploy time via meta tag
    // (config.PF_GOOGLE_CLIENT_ID injected at build). Fallback: message.
    const clientId = document.querySelector('meta[name="google-client-id"]')?.content;
    if (!clientId || !window.google?.accounts?.id) {
      authError("Google sign-in is not configured yet — use email and password.");
      return;
    }
    google.accounts.id.prompt();
  }

  async function initGoogle() {
    // Decode Google credential when GIS returns it
    window.addEventListener("message", (e) => {
      if (e.data?.type !== "google-credential") return;
      sendGoogleToken(e.data.idToken);
    });
    // GIS callback (when initialized)
    window.__pfGoogleCb = async (response) => {
      if (response?.credential) await sendGoogleToken(response.credential);
    };
  }

  async function sendGoogleToken(idToken) {
    authError("");
    $("authSubmit").disabled = true;
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "google", idToken }),
      });
      const d = await res.json();
      if (!res.ok) {
        authError(d.message || "Google sign-in failed.");
        return;
      }
      showApp(d.user);
    } catch {
      authError("Network error — try again.");
    } finally {
      $("authSubmit").disabled = false;
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
    } catch { /* best-effort */ }
    location.reload();
  }

  async function init() {
    $("authForm").addEventListener("submit", submit);
    $("authSwitchBtn").addEventListener("click", () => {
      mode = mode === "login" ? "signup" : "login";
      applyMode();
    });
    $("authGoogle").addEventListener("click", googleSignIn);
    initGoogle();

    // session check — stay logged in automatically
    try {
      const res = await fetch("/api/auth", { headers: { "Cache-Control": "no-store" } });
      if (res.ok) {
        const d = await res.json();
        if (d.user) {
          showApp(d.user);
          return;
        }
      }
    } catch { /* offline */ }
    applyMode();
    showAuth();
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    get user() { return user; },
    logout,
    showApp,
  };
})();
