// Professor AI — auth UI: sign in / sign up / Google / session bootstrap.
// The app boots from a cached user snapshot (localStorage) so a slow or
// failed session check NEVER kicks the user out (the tab-switch logout bug).
// The cookie session (400 days) remains the source of truth — the snapshot
// only bridges temporary network hiccups.
window.PFAuth = (() => {
  const $ = (id) => document.getElementById(id);
  const LS_USER = "professor-ai.lastUser";

  let mode = "login"; // login | signup
  let user = null;

  function cacheUser(u) {
    try { localStorage.setItem(LS_USER, JSON.stringify({ u, at: Date.now() })); } catch { /* noop */ }
  }
  function cachedUser() {
    try {
      const raw = localStorage.getItem(LS_USER);
      if (!raw) return null;
      const { u, at } = JSON.parse(raw);
      // trust the snapshot for up to 12 hours offline
      if (!u || !u.email || Date.now() - at > 12 * 3600 * 1000) return null;
      return u;
    } catch { return null; }
  }
  function clearCachedUser() {
    try { localStorage.removeItem(LS_USER); } catch { /* noop */ }
  }

  function showAuth() {
    $("authScreen").hidden = false;
    $("app").hidden = true;
  }

  function showApp(u) {
    user = u;
    cacheUser(u);
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

  let googleClientId = null;

  async function loadGoogleConfig() {
    if (googleClientId) return googleClientId;
    try {
      const r = await fetch("/api/bootstrap", { headers: { "Cache-Control": "no-store" } });
      if (r.ok) {
        const d = await r.json();
        if (d.googleClientId) {
          googleClientId = d.googleClientId;
          const meta = document.querySelector('meta[name="google-client-id"]');
          if (meta) meta.content = googleClientId;
        }
      }
    } catch { /* offline — fall back to keyless prompt */ }
    return googleClientId;
  }

  async function googleSignIn() {
    // Google Identity Services — client ID comes from /api/bootstrap
    // (GOOGLE_CLIENT_ID env var at deploy time). With a client ID we run a
    // proper One Tap flow; without it GIS can still show a keyless prompt
    // on some setups, and if GIS is unavailable we guide the user clearly.
    const clientId = await loadGoogleConfig();
    const gis = window.google?.accounts?.id;
    if (gis && clientId) {
      gis.initialize({
        client_id: clientId,
        callback: (response) => response?.credential && sendGoogleToken(response.credential),
      });
      gis.prompt();
      return;
    }
    if (gis) {
      gis.prompt();
      return;
    }
    // GIS script not loaded — retry once after a beat, then explain.
    setTimeout(() => {
      const gis2 = window.google?.accounts?.id;
      if (gis2) { gis2.prompt(); return; }
      authError("Google sign-in is still loading — or use email and password.");
    }, 1500);
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
    clearCachedUser();
    if (window.PFApp && PFApp.onLogout) PFApp.onLogout();
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

    // Optimistic boot: show the app instantly from the cached user while
    // the session check runs. If the cookie is genuinely gone, only THEN
    // show the auth screen. This kills the random logout-on-tab-switch bug.
    const snapshot = cachedUser();
    if (snapshot) showApp(snapshot);

    try {
      const res = await fetch("/api/auth", { headers: { "Cache-Control": "no-store" } });
      if (res.ok) {
        const d = await res.json();
        if (d.user) {
          showApp(d.user);
          return;
        }
      }
      // 401 while we booted from a snapshot → the session really expired
      if (res.status === 401) {
        clearCachedUser();
        applyMode();
        showAuth();
        return;
      }
      // network error but snapshot exists → keep the app open (bridge mode)
      if (!snapshot) {
        applyMode();
        showAuth();
      }
    } catch {
      // offline: snapshot keeps the user in; otherwise show auth
      if (!snapshot) {
        applyMode();
        showAuth();
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    get user() { return user; },
    logout,
    showApp,
  };
})();
