// Professor AI — profile modal: user info, settings, providers CRUD,
// clear-history with English confirmation, sign out.
window.PFProfile = (() => {
  const $ = (id) => document.getElementById(id);

  let user = null;
  let stats = { chats: 0, models: 0 };
  let providers = [];

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.message || d.error || "Request failed");
    return d;
  }

  function switchTab(name) {
    for (const t of ["profile", "providers", "danger"]) {
      $("ptab" + t[0].toUpperCase() + t.slice(1)).classList.toggle("active", name === t);
      $("ppane" + t[0].toUpperCase() + t.slice(1)).hidden = name !== t;
    }
  }

  function renderProfile() {
    if (!user) return;
    const name = user.username || "Account";
    $("pmName").textContent = name;
    $("pmEmail").textContent = user.email || "—";
    $("pmAvatar").textContent = name[0].toUpperCase();
    $("pfUsername").textContent = user.username || "—";
    $("pfEmail").textContent = user.email || "—";
    $("pfProvider").textContent = user.provider === "google" ? "Google" : "Email & password";
    $("pfCreated").textContent = user.createdAt
      ? new Date(user.createdAt).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" })
      : "—";
    $("pfChats").textContent = String(stats.chats);
    $("pfModels").textContent = String(stats.models);
    renderProviders();
  }

  function renderProviders() {
    const list = $("provList");
    list.innerHTML = "";
    for (const p of providers) {
      const el = document.createElement("div");
      el.className = "prov-default custom";
      el.innerHTML =
        `<div class="pd-head"><span class="pd-dot on"></span><strong>${PFMD.esc(p.name || p.modelId)}</strong>` +
        `<span class="pd-badge">custom</span></div>` +
        `<p class="pd-sub" dir="ltr">${PFMD.esc(p.modelName || p.modelId)} · ${PFMD.esc(p.baseUrl)}</p>`;
      list.appendChild(el);
    }
  }

  function open() {
    if (!user) return;
    $("profileModal").hidden = false;
    renderProfile();
  }
  function close() {
    $("profileModal").hidden = true;
    $("providerModal").hidden = true;
    $("clearConfirm").hidden = true;
  }

  async function load(u) {
    user = u;
    try {
      const d = await api("/api/profile");
      user = d.user;
      stats = d.stats || { chats: 0, models: 0 };
      providers = d.providers || [];
      if (window.PFApp && PFApp.setProviders) PFApp.setProviders(providers);
    } catch {
      // profile load failure is non-fatal
    }
  }

  async function clearHistory() {
    try {
      await api("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear-history", confirm: "DELETE" }),
      });
      if (window.PFApp) PFApp.toast("All chat history deleted");
      $("clearConfirm").hidden = true;
      load(user);
    } catch (e) {
      if (window.PFApp) PFApp.toast(e.message || "Could not clear history");
    }
  }

  function testResult(ok, detail, latency) {
    const el = $("provTestResult");
    el.hidden = false;
    el.className = "prov-test-result " + (ok ? "ok" : "bad");
    el.textContent = ok
      ? `✓ Connected in ${latency}ms — model responded`
      : `✕ ${detail}`;
  }

  async function addProvider() {
    const rec = {
      action: "save",
      name: $("provName").value.trim(),
      baseUrl: $("provBaseUrl").value.trim(),
      apiKey: $("provApiKey").value.trim(),
      modelName: $("provModelName").value.trim(),
      modelId: $("provModelId").value.trim(),
    };
    if (!rec.baseUrl || !rec.modelId) {
      testResult(false, "Base URL and Model ID are required.");
      return;
    }
    try {
      await api("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rec),
      });
      $("providerModal").hidden = true;
      if (window.PFApp) PFApp.toast("Provider added — select it under the chat box");
      await load(user);
    } catch (e) {
      testResult(false, e.message);
    }
  }

  async function testProvider() {
    const rec = {
      action: "test",
      baseUrl: $("provBaseUrl").value.trim(),
      apiKey: $("provApiKey").value.trim(),
      modelId: $("provModelId").value.trim() || $("provModelName").value.trim(),
    };
    if (!rec.baseUrl || !rec.modelId) {
      testResult(false, "Base URL and Model ID are required.");
      return;
    }
    $("btnTestProvider").disabled = true;
    $("provTestResult").hidden = false;
    $("provTestResult").className = "prov-test-result";
    $("provTestResult").textContent = "Testing connection…";
    try {
      const d = await api("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rec),
      });
      testResult(d.ok, d.detail, d.latencyMs);
    } catch (e) {
      testResult(false, e.message);
    } finally {
      $("btnTestProvider").disabled = false;
    }
  }

  function init() {
    $("btnProfile").addEventListener("click", open);
    $("btnCloseProfile").addEventListener("click", close);
    $("profileModal").addEventListener("click", (e) => {
      if (e.target === $("profileModal")) close();
    });
    $("ptabProfile").addEventListener("click", () => switchTab("profile"));
    $("ptabProviders").addEventListener("click", () => switchTab("providers"));
    $("ptabDanger").addEventListener("click", () => switchTab("danger"));

    $("btnClearHistory").addEventListener("click", () => {
      $("clearConfirm").hidden = false;
    });
    $("btnCancelClear").addEventListener("click", () => {
      $("clearConfirm").hidden = true;
    });
    $("btnConfirmClear").addEventListener("click", clearHistory);
    $("btnLogout").addEventListener("click", () => PFAuth && PFAuth.logout());

    $("btnAddProvider").addEventListener("click", () => {
      $("providerModal").hidden = false;
      $("provTestResult").hidden = true;
    });
    $("btnCloseProvider").addEventListener("click", () => ($("providerModal").hidden = true));
    $("providerModal").addEventListener("click", (e) => {
      if (e.target === $("providerModal")) $("providerModal").hidden = true;
    });
    $("btnTestProvider").addEventListener("click", testProvider);
    $("btnSaveProvider").addEventListener("click", addProvider);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("profileModal").hidden) close();
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  return { load, open };
})();
