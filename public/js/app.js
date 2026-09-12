// Professor AI — main app: chat streaming, sessions, model picker, agent integration.
// English UI. Model choice locks per-conversation once set; the last choice
// becomes the default for new chats. Custom providers (user-added models)
// stream through the same pipeline. Sessions are stored PER ACCOUNT —
// switching accounts never leaks history.
window.PFApp = (() => {
  const $ = (id) => document.getElementById(id);

  /* ============================ state ============================ */
  const LS_SIDE = "professor-ai.side";
  const LS_MODEL = "professor-ai.lastModel";
  let lsPrefix = "public"; // per-account prefix, set on login
  let sessions = [];
  let currentId = null;
  let mode = "chat";
  let streaming = false;
  let abortCtrl = null;
  let userStopped = false; // stop button vs. watchdog abort (watchdog allows resume)
  let lastStreamActivity = 0;
  let stallTimer = null;
  let providers = []; // user's custom providers [{name, modelId,…}]

  const sessionsKey = () => `professor-ai.sessions.${lsPrefix}`;
  const currentKey = () => `professor-ai.current.${lsPrefix}`;

  function loadCurrentId() {
    try { return localStorage.getItem(currentKey()) || null; } catch { return null; }
  }
  function saveCurrentId(id) {
    try {
      if (id) localStorage.setItem(currentKey(), id);
      else localStorage.removeItem(currentKey());
    } catch { /* noop */ }
  }

  function setAccountKey(identifier) {
    const raw = String(identifier || "public").trim().toLowerCase();
    const safe = raw.replace(/[^a-z0-9@._-]/g, "").slice(0, 60) || "public";
    lsPrefix = safe;
    sessions = loadSessions();
    // restore the exact chat the user was in (no new chat on refresh)
    const saved = loadCurrentId();
    currentId = sessions.some((s) => s.id === saved) ? saved : (sessions.length ? sessions[0].id : null);
  }

  function loadSessions() {
    try { return JSON.parse(localStorage.getItem(sessionsKey())) || []; } catch { return []; }
  }
  let saveTimer = null;
  function saveSessions() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(sessionsKey(), JSON.stringify(sessions.slice(0, 60))); } catch { /* full */ }
    }, 250);
  }

  function loadLastModel() {
    try { return localStorage.getItem(LS_MODEL) || ""; } catch { return ""; }
  }
  function saveLastModel(v) {
    try { localStorage.setItem(LS_MODEL, v || ""); } catch { /* noop */ }
  }

  const current = () => sessions.find((s) => s.id === currentId) || null;
  const isMobile = () => window.matchMedia("(max-width: 1023px)").matches;

  /* ============================ ui helpers ============================ */
  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.hidden = true), ms);
  }

  // In-site confirm dialog — a Promise<boolean>. Never uses the browser's
  // native confirm() (blocked by "don't show again" style permissions and
  // inconsistent across browsers).
  function confirmDialog(title, text, okLabel = "Confirm") {
    return new Promise((resolve) => {
      const modal = $("siteConfirm");
      $("siteConfirmTitle").textContent = title;
      $("siteConfirmText").textContent = text;
      const ok = $("siteConfirmOk");
      ok.textContent = okLabel;
      modal.hidden = false;
      const done = (v) => {
        modal.hidden = true;
        ok.removeEventListener("click", okFn);
        $("siteConfirmCancel").removeEventListener("click", cancelFn);
        modal.removeEventListener("click", backdropFn);
        document.removeEventListener("keydown", keyFn);
        resolve(v);
      };
      const okFn = () => done(true);
      const cancelFn = () => done(false);
      const backdropFn = (e) => { if (e.target === modal) done(false); };
      const keyFn = (e) => { if (e.key === "Escape") done(false); };
      ok.addEventListener("click", okFn);
      $("siteConfirmCancel").addEventListener("click", cancelFn);
      modal.addEventListener("click", backdropFn);
      document.addEventListener("keydown", keyFn);
    });
  }

  function scrollBottom(force) {
    const m = $("messages");
    const near = m.scrollHeight - m.scrollTop - m.clientHeight < 220;
    if (force || near) m.scrollTop = m.scrollHeight;
    updateScrollBtn();
  }

  // Circular go-to-bottom button: visible whenever the user has scrolled up
  // away from the newest message (in chat AND agent mode — both share the
  // messages column). Clicking jumps back to the bottom.
  function updateScrollBtn() {
    const m = $("messages");
    const btn = $("btnScrollDown");
    if (!btn) return;
    const away = m.scrollHeight - m.scrollTop - m.clientHeight > 320;
    btn.hidden = !away;
  }

  function wireScrollBtn() {
    const m = $("messages");
    const btn = $("btnScrollDown");
    if (!m || !btn) return;
    m.addEventListener("scroll", updateScrollBtn, { passive: true });
    btn.addEventListener("click", () => scrollBottom(true));
  }

  function setStreaming(on) {
    streaming = on;
    $("btnSend").hidden = on;
    $("btnStop").hidden = !on;
    $("messages").classList.toggle("stream-lock", on);
    $("input").disabled = on && mode === "agent";
    if (window.PFAgent && typeof PFAgent.setBusy === "function") PFAgent.setBusy(on);
    updateSendBtn();
  }

  function updateSendBtn() {
    $("btnSend").disabled = streaming || !$("input").value.trim();
  }

  /* ============================ sessions ============================ */
  function newSession() {
    const s = {
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "New chat",
      mode,
      provider: normalizeEngine(loadLastModel()), // last chosen engine, migrated
      created: Date.now(),
      messages: [],
      files: [],
    };
    sessions.unshift(s);
    currentId = s.id;
    saveCurrentId(s.id);
    saveSessions();
    renderMessages();
    renderSessionList();
    renderModelPicker();
    PFAgent.reset();
    return s;
  }

  function ensureSession() {
    if (!current()) newSession();
    return current();
  }

  function switchSession(id) {
    if (id === currentId) { closeSideMobile(); return; }
    // switching chats mid-stream is allowed: the running answer is stopped
    // and preserved in its own chat
    if (streaming) stop();
    currentId = id;
    saveCurrentId(id);
    const s = current();
    if (s) {
      setMode(s.mode || "chat", { soft: true });
      renderMessages();
      PFAgent.setFiles(s.files || []);
      renderModelPicker();
    }
    closeSideMobile();
    renderSessionList();
  }

  function deleteSession(id, title) {
    confirmDialog(`Delete this conversation?`, `"${title}" — this cannot be undone.`, "Delete").then((yes) => {
      if (!yes) return;
      doDeleteSession(id);
    });
  }

  function doDeleteSession(id) {
    sessions = sessions.filter((s) => s.id !== id);
    if (currentId === id) {
      currentId = null;
      saveCurrentId(null);
      if (sessions.length) {
        const nxt = sessions[0];
        currentId = nxt.id;
        saveCurrentId(nxt.id);
        setMode(nxt.mode || "chat", { soft: true });
        renderMessages();
        PFAgent.setFiles(nxt.files || []);
        renderModelPicker();
      } else {
        newSession();
        return;
      }
    }
    saveSessions();
    renderSessionList();
    toast("Conversation deleted");
  }

  function renderSessionList() {
    const box = $("sessionList");
    if (!sessions.length) {
      box.innerHTML = '<div class="side-empty">No conversations yet.</div>';
      return;
    }
    box.innerHTML = "";
    for (const s of sessions) {
      const b = document.createElement("button");
      b.className = "session-item" + (s.id === currentId ? " active" : "");
      b.innerHTML =
        `<span class="si-ico">${s.mode === "agent" ? "⚡" : "💬"}</span>` +
        `<span class="si-title">${PFMD.esc(s.title)}</span>` +
        `<span class="si-del" title="Delete">✕</span>`;
      b.addEventListener("click", () => switchSession(s.id));
      b.querySelector(".si-del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSession(s.id, s.title);
      });
      box.appendChild(b);
    }
  }

  /* ============================ agent HUD ============================ */
  function makeHud(el) {
    const hud = document.createElement("div");
    hud.className = "agent-hud";
    hud.innerHTML =
      '<div class="hud-row"><span class="hud-spinner"></span><span class="hud-text">Thinking…</span></div>' +
      '<div class="hud-files"></div>';
    el.appendChild(hud);
    return {
      set(text) { hud.querySelector(".hud-text").textContent = text; },
      addFile(path) {
        const row = hud.querySelector(".hud-files");
        const chip = document.createElement("span");
        chip.className = "hud-file";
        chip.textContent = path;
        row.appendChild(chip);
        // keep the HUD readable: show the last 6 files
        while (row.children.length > 6) row.removeChild(row.firstChild);
      },
      // coding state — clearer than a bare "Thinking…"
      coding() { hud.querySelector(".hud-text").textContent = "Writing code…"; },
      remove() { hud.remove(); },
    };
  }

  /* ============================ messages render ============================ */
  function fileChip(path) {
    return `<button class="file-chip" data-file="${PFMD.esc(path)}" title="Open in workshop">📄 ${PFMD.esc(path)}</button>`;
  }

  const EXT_LANG = { html: "html", css: "css", js: "javascript", json: "json", md: "markdown", svg: "xml", txt: "text", py: "python", cpp: "cpp", ts: "typescript" };
  // In CHAT mode the agent's ```file: blocks are NOT rendered as code —
  // file contents live in the workshop Files tab, never in the chat feed.
  // Anything that looks like a leftover file block / raw HTML dump from a
  // truncated stream is collapsed to a single tidy chip.
  function chatifyFileBlocks(text) {
    return String(text)
      // complete file blocks → chip
      .replace(/```file:([^\n`]+)\n[\s\S]*?(?:```|$)/g, (_m, p) => `\n\n\`\`\`file:${p.trim()}\n\`\`\`\n`)
      // leftover "file:path" marker lines from truncated streams → drop
      .replace(/^\s*file:[^\s]+\s*$/gm, "")
      // the "[emitted file: path — note]" summary lines are noise in chat
      .replace(/\[emitted file:[^\]]*\]/g, "");
  }

  // In AGENT mode code NEVER types into the chat feed: file blocks collapse
  // to chips (fileRenderer) and any other fenced code block collapses to a
  // one-line workbench note — prose flows underneath, code stays in the
  // workbench where it belongs.
  function agentifyContent(text) {
    return String(text)
      .replace(/```(?!file:)[^\n`]*\n[\s\S]*?(?:```|$)/g,
        () => "\n\n> ⚙ Code block — written to the workbench, see the FILES tab\n\n");
  }

  function renderContent(text, forMode) {
    return forMode === "agent"
      ? PFMD.render(agentifyContent(text), { fileRenderer: fileChip })
      : PFMD.render(chatifyFileBlocks(text));
  }

  function renderMessages() {
    const box = $("messages");
    const s = current();
    box.innerHTML = "";
    if (!s || !s.messages.length) {
      box.appendChild(buildHero());
      return;
    }
    for (const m of s.messages) box.appendChild(buildMsg(m));

    // After a mid-stream page refresh: the last assistant turn may be
    // truncated (no clean finish). Offer a manual Continue button on that
    // bubble — never auto-send (that re-submits the prompt in a loop).
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === "assistant" && last.content &&
        !/(SUMMARY:|CONTINUE:)\s*$/i.test(last.content.trim()) &&
        s.messages.length > 1) {
      const msgs = box.querySelectorAll(".msg.ai");
      const lastBubble = msgs[msgs.length - 1];
      if (lastBubble && !lastBubble.querySelector(".resume-note")) {
        const note = document.createElement("div");
        note.className = "err-box resume-note";
        note.style.marginTop = "10px";
        note.innerHTML = "<span>⚠ This answer was cut off. Continue it:</span>";
        const again = document.createElement("button");
        again.textContent = "Continue";
        again.addEventListener("click", () => {
          const s2 = current();
          if (!s2) return;
          const prevUser = [...s2.messages].reverse().find((m) => m.role === "user");
          const prevAi = [...s2.messages].reverse().find((m) => m.role === "assistant");
          if (!prevUser || !prevAi) return;
          const ctx = { attempt: 0, raw: prevAi.content, aiMsg: prevAi, msgEl: lastBubble };
          note.remove();
          send(prevUser.content, { reuseLastUser: true, resumeOf: ctx });
        });
        note.appendChild(again);
        const body = lastBubble.querySelector(".msg-content");
        if (body) body.appendChild(note);
      }
    }
    scrollBottom(true);
  }

  function buildHero() {
    const hero = document.createElement("div");
    hero.innerHTML = HERO_HTML;
    const el = hero.firstElementChild;
    // restart the tips rotation inside the fresh hero
    if (window.PFTips) {
      const chatTip = el.querySelector("#heroTip");
      if (chatTip && window.PFTips.startRotation) {
        PFTips.startRotation(chatTip, PFTips.chatTips, 15000);
      }
    }
    return el;
  }

  const HERO_HTML = $("hero") ? $("hero").outerHTML : "";

  function buildMsg(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (m.role === "user" ? "user" : "ai");
    const isUser = m.role === "user";
    const avatar = isUser ? "👤" : "";
    const role = isUser ? "You" : "Professor";
    const modelChip = m.model ? `<span class="model-chip">${PFMD.esc(shortModel(m.model))}</span>` : "";
    const msgMode = m.mode || mode;
    const contentHtml = isUser ? PFMD.esc(m.content) : renderContent(m.content, msgMode);
    const srcBox = m.search?.results?.length
      ? `<div class="src-box">${m.search.results
          .slice(0, 4)
          .map((r) => `<a class="src-link" href="${PFMD.esc(r.url)}" target="_blank" rel="noopener">🔗 ${PFMD.esc(r.title)}</a>`)
          .join("")}</div>`
      : "";
    // per-message copy button (user AND ai messages)
    const copyBtn = `<button class="msg-copy" type="button" title="Copy message" aria-label="Copy message">
      <svg viewBox="0 0 24 24" width="12" height="12"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V5a2 2 0 0 1 2-2h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span>Copy</span></button>`;
    wrap.innerHTML =
      `<div class="msg-avatar">${avatar}</div>` +
      `<div class="msg-body">` +
      `<div class="msg-meta"><span class="msg-role">${role}</span>${modelChip}</div>` +
      `<div class="msg-content md">${contentHtml}</div>${srcBox}` +
      `<div class="msg-actions">${copyBtn}</div></div>`;
    wireMsg(wrap);
    return wrap;
  }

  function wireMsg(wrap) {
    wrap.querySelectorAll(".code-copy").forEach((b) =>
      b.addEventListener("click", async () => {
        const code = b.closest(".code-wrap")?.querySelector("code")?.innerText || "";
        try { await navigator.clipboard.writeText(code); b.textContent = "Copied ✓"; }
        catch { b.textContent = "Error"; }
        setTimeout(() => (b.textContent = "Copy"), 1600);
      })
    );
    wrap.querySelectorAll(".file-chip").forEach((b) =>
      b.addEventListener("click", () => {
        PFAgent.openMobile();
        PFAgent.openFile(b.dataset.file) || PFAgent.switchTab("files");
      })
    );
    const copyBtn = wrap.querySelector(".msg-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const content =
          wrap.querySelector(".msg-content")?.innerText ||
          wrap.querySelector(".msg-content")?.textContent ||
          "";
        try {
          await navigator.clipboard.writeText(content);
          copyBtn.querySelector("span").textContent = "Copied ✓";
        } catch {
          copyBtn.querySelector("span").textContent = "Error";
        }
        setTimeout(() => (copyBtn.querySelector("span").textContent = "Copy"), 1600);
      });
    }
  }

  // Model chip labels. Custom providers keep the name the user chose.
  // Built-in engines show their roster label — readable, honest names.
  function shortModel(id) {
    const raw = String(id || "");
    if (!raw) return "";
    // "providerLabel · modelId" form from the done event → keep the model part
    const modelId = raw.includes("·") ? raw.split("·").pop().trim() : raw;
    const s = modelId.toLowerCase();
    const isCustom = providers.some((p) => {
      const nm = String(p.name || "").toLowerCase();
      const mid = String(p.modelId || "").toLowerCase();
      return s.includes(nm) || s.includes(mid) || nm.includes(s);
    });
    if (isCustom) {
      const p = providers.find((x) => {
        const nm = String(x.name || "").toLowerCase();
        const mid = String(x.modelId || "").toLowerCase();
        return s.includes(nm) || s.includes(mid) || nm.includes(s);
      });
      return (p && (p.name || p.modelId)) || modelId.split("/").pop();
    }
    if (s.includes("qwen3.8")) return "Qwen 3.8";
    if (s.includes("qwen3.5-397b")) return "Qwen 3.5 397B";
    if (s.includes("qwen3.6")) return "Qwen 3.6 Coder";
    if (s.includes("nemotron-3-ultra")) return "Nemotron-3-Ultra 550B";
    if (s.includes("nemotron-3-super")) return "Nemotron-3-Super 120B";
    if (s.includes("nemotron-3.5-lightning")) return "Nemotron-3.5 Lightning";
    if (s.includes("openai-fast") || s.includes("gpt-oss")) return "Nex N2.5 Mini";
    if (s.includes("nex-n2.5-mini")) return "Nex N2.5 Mini";
    return modelId.split("/").pop().replace(/:free$/, "");
  }

  function dropHero() {
    const h = $("messages").querySelector(".hero");
    if (h) h.remove();
  }

  /* ============================ model picker (below composer, upward dropdown) ============================ */
  // Built-in ENGINE list — mirrors brain/models.json "options". Each entry
  // routes to a live-tested free endpoint; "engine:<id>" travels in the
  // provider field and the server pins that exact model first.
  const ENGINES = [
    { id: "qwen", label: "Qwen 3.8" },
    { id: "qwen-coder", label: "Qwen 3.6 Coder" },
    { id: "nemotron-ultra", label: "Nemotron-3-Ultra 550B" },
    { id: "nemotron-super", label: "Nemotron-3-Super 120B" },
    { id: "nemotron-lightning", label: "Nemotron-3.5 Lightning" },
    { id: "llama", label: "Nex N2.5 Mini" },
  ];
  const DEFAULT_ENGINE = "engine:qwen";
  // legacy engine ids from older versions → current ids
  const ENGINE_MIGRATION = {
    auto: "qwen", "qwen-max": "qwen", ling: "nemotron-super",
    step: "nemotron-lightning", "gpt-oss": "llama",
  };
  // Normalize any stored/legacy selection to a live engine id. Custom
  // provider names pass through untouched.
  function normalizeEngine(v) {
    const raw = String(v || "").trim();
    if (!raw) return DEFAULT_ENGINE;
    if (!raw.startsWith("engine:")) return raw; // custom provider name
    const id = raw.slice(7);
    const mapped = ENGINE_MIGRATION[id] || id;
    return ENGINES.some((e) => e.id === mapped) ? "engine:" + mapped : DEFAULT_ENGINE;
  }
  const engineLabel = (id) => {
    const eng = String(id || "").replace(/^engine:/, "");
    return (ENGINES.find((e) => e.id === eng) || {}).label || eng;
  };

  // Per-conversation lock: once a session has messages, its provider is fixed.
  // The last choice is remembered and becomes the default for new chats.
  let mpOpen = false;

  function chosenProvider() {
    const s = current();
    if (s && s.provider) return normalizeEngine(s.provider);
    return normalizeEngine(loadLastModel());
  }

  function providerLabel(v) {
    if (!v) return engineLabel(DEFAULT_ENGINE);
    if (v.startsWith("engine:")) return engineLabel(v.slice(7));
    const p = providers.find((x) => (x.name || x.modelId) === v);
    return p ? p.name || p.modelId : v;
  }

  // Called by profile.js after providers load/delete — keeps the model
  // picker in sync. If the user's chosen provider was removed, gracefully
  // fall back to the default engine (never a dead selection).
  function setProviders(list) {
    providers = Array.isArray(list) ? list : [];
    // engine:<id> selections are always valid (built-in roster) — only
    // custom-provider selections can become dead when a provider is deleted.
    const stillThere = (v) =>
      !v || v.startsWith("engine:") || providers.some((x) => (x.name || x.modelId) === v);
    if (!stillThere(loadLastModel())) {
      saveLastModel(DEFAULT_ENGINE);
    }
    for (const s of sessions) {
      s.provider = normalizeEngine(s.provider);
      if (s.provider && !stillThere(s.provider)) s.provider = DEFAULT_ENGINE;
    }
    saveSessions();
    renderModelPicker();
  }

  function renderModelPicker() {
    const box = $("modelOptions");
    if (!box) return;
    box.innerHTML = "";
    const s = current();
    const locked = s && s.messages && s.messages.length > 0;
    const chosen = chosenProvider();

    const mk = (label, value, kind) => {
      const b = document.createElement("button");
      b.className = "mp-option" + (value === chosen ? " active" : "") + (kind === "custom" ? " custom" : "");
      b.dataset.provider = value;
      b.setAttribute("role", "option");
      const tag = kind === "custom" ? "custom" : "engine";
      b.innerHTML =
        `<span class="mp-name">${PFMD.esc(label)}</span>` +
        `<span class="mp-tag">${tag}</span>`;
      b.disabled = locked && value !== chosen;
      b.addEventListener("click", () => {
        if (locked) return;
        const sess = ensureSession();
        sess.provider = value;
        // remember for the next new chat + drop any stale engine-model pin
        saveLastModel(value);
        sess.engineModel = "";
        saveSessions();
        setMpOpen(false);
        renderModelPicker();
      });
      return b;
    };

    for (const e of ENGINES) {
      box.appendChild(mk(e.label, "engine:" + e.id, "engine"));
    }
    for (const p of providers) {
      box.appendChild(mk(p.name || p.modelId, p.name || p.modelId, "custom"));
    }

    $("mpCurrent").textContent = providerLabel(chosen);
    $("mpLock").hidden = !locked;
    $("modelPickerBar").classList.toggle("locked", locked);
  }

  function setMpOpen(open) {
    mpOpen = open;
    const drop = $("modelOptions");
    drop.hidden = !open;
    $("mpTrigger").setAttribute("aria-expanded", String(open));
    $("modelPickerBar").classList.toggle("open", open);
  }

  /* ============================ mode ============================ */
  function setMode(next, { soft = false } = {}) {
    mode = next === "agent" ? "agent" : "chat";
    $("app").dataset.mode = mode;
    $("modeSwitch").dataset.active = mode;
    $("btnModeChat").classList.toggle("active", mode === "chat");
    $("btnModeAgent").classList.toggle("active", mode === "agent");
    $("btnModeChat").setAttribute("aria-selected", String(mode === "chat"));
    $("btnModeAgent").setAttribute("aria-selected", String(mode === "agent"));
    $("bench").hidden = mode !== "agent";
    $("benchFab").hidden = mode !== "agent";
    $("input").placeholder = mode === "agent"
      ? "Describe the app you want… (e.g. build a 3D first-person shooter with a neon-red dark theme)"
      : "Write your message… (Enter = send, Shift+Enter = new line)";
    if (!soft) {
      const s = current();
      if (s && s.messages.length && s.mode !== mode) {
        newSession();
      } else if (s) {
        s.mode = mode;
        saveSessions();
        renderSessionList();
      }
    }
  }

  /* ============================ sidebar ============================ */
  function openSide() {
    $("app").dataset.side = "open";
    if (isMobile()) $("sideBackdrop").classList.add("show");
    else try { localStorage.setItem(LS_SIDE, "open"); } catch { /* noop */ }
  }
  function closeSide() {
    $("app").dataset.side = "closed";
    $("sideBackdrop").classList.remove("show");
    if (!isMobile()) try { localStorage.setItem(LS_SIDE, "closed"); } catch { /* noop */ }
  }
  function toggleSide() {
    $("app").dataset.side === "open" ? closeSide() : openSide();
  }
  function closeSideMobile() {
    if (isMobile()) closeSide();
  }

  /* ============================ sending / streaming ============================ */
  // A dropped stream resumes AUTOMATICALLY: the partial answer is replayed
  // as assistant context and the server continues from where it stopped
  // (up to MAX_AUTO_RESUME attempts), so a network hiccup, a browser
  // offline moment, or a provider cutoff never kills a long build.
  const MAX_AUTO_RESUME = 5;

  async function send(text, { errors = null, reuseLastUser = false, resumeOf = null } = {}) {
    const resumeCtx = resumeOf || { attempt: 0, raw: "", aiMsg: null, msgEl: null };
    text = String(text || "").trim();
    if (!text || (streaming && !resumeOf)) return;
    const s = ensureSession();
    userStopped = false;
    startStallWatchdog();

    // Resuming NEVER re-sends the user's message: during a resume the last
    // stored record is the live ASSISTANT turn, so the old role check wrongly
    // re-pushed (and re-rendered) the user message above the answer. A resume
    // always continues the existing turn in place.
    const skipUser = !!resumeOf ||
      (reuseLastUser && s.messages.length && s.messages[s.messages.length - 1].role === "user");

    if (!skipUser) {
      if (s.messages.length === 0) s.title = text.slice(0, 46);
      s.mode = mode;
      const userMsg = { role: "user", content: text };
      s.messages.push(userMsg);
      dropHero();
      $("messages").appendChild(buildMsg(userMsg));
      renderModelPicker(); // lock the model now that the conversation started
    }

    // resume keeps the SAME bubble + message record; new turn creates both
    const aiMsg = resumeCtx.aiMsg || { role: "assistant", content: "", model: null, mode, _live: true };
    const msgEl = resumeCtx.msgEl || buildStreamingMsg();
    if (!resumeCtx.msgEl) {
      s.messages.push(aiMsg);
      $("messages").appendChild(msgEl);
    }
    const hud = mode === "agent" ? makeHud(msgEl.querySelector(".msg-body")) : null;
    renderSessionList();
    scrollBottom(true);

    if (mode === "agent") {
      // blur the preview with a loading animation for the whole build
      PFAgent.setCoding(true, resumeCtx.raw ? "" : "");
    }
    setStreaming(true);
    abortCtrl = new AbortController();

    const statusEl = msgEl.querySelector(".status-line");
    let contentEl = msgEl.querySelector(".msg-content");
    const typingEl = msgEl.querySelector(".typing");
    let raw = resumeCtx.raw || "";
    let gotFirst = !!resumeCtx.raw;
    let gotDone = false;
    let renderTimer = null;
    let ingestTimer = null;
    let currentFile = null;

    // AGENT PIPELINE PASSES: the server emits {type:"pass"} between build
    // stages. Each pass becomes its OWN bubble — new messages stack BELOW
    // the user's prompt in order, so a pass-2 answer never rewrites or
    // floats above the user message. All passes accumulate into the same
    // session record (aiMsg.content), keeping one history entry per turn.
    const beginPass = (label) => {
      // close out the previous bubble cleanly
      clearTimeout(renderTimer);
      if (contentEl && raw) contentEl.innerHTML = renderContent(raw, mode);
      // new bubble element under the same message record
      const wrap = buildStreamingMsg();
      if (label) {
        const meta = wrap.querySelector(".msg-meta");
        if (meta) meta.insertAdjacentHTML("beforeend", `<span class="model-chip pass-chip">${PFMD.esc(label)}</span>`);
      }
      msgEl.parentNode.insertBefore(wrap, msgEl.nextSibling);
      passEls.push(wrap);
      contentEl = wrap.querySelector(".msg-content");
      statusEl2 = wrap.querySelector(".status-line");
      scrollBottom(true);
    };
    let statusEl2 = null; // status line of the CURRENT pass bubble
    const passEls = [];

    if (resumeOf) {
      // resuming a dropped stream — show the reconnect state
      statusEl.hidden = false;
      statusEl.querySelector("span:last-child").textContent =
        "Connection dropped — resuming automatically (" + (resumeCtx.attempt + 1) + "/" + MAX_AUTO_RESUME + ")…";
      typingEl.hidden = true;
      if (hud) hud.set("Reconnecting — continuing the build…");
    }

    const scheduleRender = () => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        contentEl.innerHTML = renderContent(raw, mode);
        wireMsg(msgEl);
        scrollBottom();
      }, 140);
    };
    const scheduleIngest = () => {
      if (mode !== "agent" || ingestTimer) return;
      ingestTimer = setTimeout(() => {
        ingestTimer = null;
        PFAgent.ingest(raw);
      }, 400);
    };
    const trackHud = () => {
      if (!hud) return;
      const m = /```file:([^\n`]+)\n/.exec(raw.slice(Math.max(0, raw.length - 400)));
      if (m && m[1] !== currentFile) {
        currentFile = m[1].trim();
        hud.set("Coding — " + currentFile);
        hud.addFile(currentFile);
        // mirror the current file onto the blurred preview overlay
        if (mode === "agent") PFAgent.setCoding(true, currentFile);
      } else if (/SUMMARY:|CONTINUE:/i.test(raw.slice(-120)) && !m) {
        hud.set(/CONTINUE:/i.test(raw.slice(-120)) ? "Continuing build…" : "Wrapping up…");
      } else if (!m && !currentFile && raw.length > 30) {
        hud.coding(); // text output, not files — still generating content
      }
    };

    // History for the model: assistant turns keep a COMPACT summary of files
    // (paths only) — full contents of current files travel via payload.files,
    // so the model always has live access to its own work without bloating.
    const historySource = s.messages.slice();
    if (resumeOf) {
      // the live aiMsg is the last record; replace with the partial content
      historySource.splice(historySource.indexOf(aiMsg), 1, { role: "assistant", content: resumeCtx.raw });
    }
    const history = historySource
      .slice(0, resumeOf ? undefined : -1)
      .map((m) => ({
        role: m.role,
        content:
          m.role === "assistant" && mode === "agent"
            ? m.content.replace(/```file:([^\n`]+)\n[\s\S]*?```/g, (_mm, p) => `\n[emitted file: ${p.trim()} — current content is in the project files block]\n`)
            : m.content,
      }));

    const payload = { mode, messages: history };
    // The model picker ALWAYS has a concrete engine (or custom provider)
    // selected — send it so the server pins exactly that model.
    payload.provider = normalizeEngine(s.provider);
    // conversations started before a model was picked: pin the engine that
    // actually answered, keeping mid-conversation continuity
    if (payload.provider.startsWith("engine:")) {
      const pinned = s.engineModel ||
        (s.messages.find((m) => m.role === "assistant" && m.engineModel) || {}).engineModel;
      if (pinned) payload.preferredModel = pinned;
    }
    if (mode === "agent") {
      payload.files = PFAgent.getFiles();
      if (errors && errors.length) payload.errors = errors;
    }
    // resume: ask the engine to continue from the exact cutoff point
    if (resumeOf) {
      payload.resume = true;
      payload.partial = resumeCtx.raw.slice(-6000);
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abortCtrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("http-" + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          const line = ev.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let d;
          try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (d.type === "ping") { touchStream(); continue; }
          if (d.type === "pass") {
            touchStream();
            if (mode === "agent") beginPass(d.label);
            continue;
          }
          if (d.type === "status") {
            touchStream();
            const line = statusEl2 || statusEl;
            if (hud && !gotFirst) hud.set(d.text);
            if (!gotFirst) {
              line.hidden = false;
              line.querySelector("span:last-child").textContent = d.text;
            }
          } else if (d.type === "delta") {
            touchStream();
            if (!gotFirst) {
              gotFirst = true;
              const line = statusEl2 || statusEl;
              line.hidden = true;
              typingEl.hidden = true;
              if (hud) hud.coding();
            }
            raw += d.text;
            scheduleRender();
            scheduleIngest();
            trackHud();
          } else if (d.type === "replace") {
            // server cleaned the final answer (reasoning preamble removed) —
            // repaint the current bubble with the polished text
            touchStream();
            if (d.text) {
              raw = d.text;
              aiMsg.content = raw;
              contentEl.innerHTML = renderContent(raw, mode);
              wireMsg(msgEl);
              scrollBottom();
            }
          } else if (d.type === "done") {
            gotDone = true;
            aiMsg.model = d.model ? `${d.provider || ""} · ${d.model}` : null;
            // remember which ENGINE model answered → pin it for the whole chat
            if (d.model && !s.provider) {
              aiMsg.engineModel = String(d.model).split("/").pop();
              if (!s.engineModel) s.engineModel = aiMsg.engineModel;
            }
            if (d.search) aiMsg.search = d.search;
          } else if (d.type === "error") {
            throw Object.assign(new Error(d.message || "engine-error"), { details: d.details });
          }
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        raw += raw ? "\n\n⏹ Stopped." : "";
      } else {
        aiMsg._error = e.message;
      }
    }

    clearTimeout(renderTimer);
    clearTimeout(ingestTimer);
    stopStallWatchdog();
    statusEl.hidden = true;
    if (statusEl2) statusEl2.hidden = true;
    typingEl.hidden = true;
    // final paint of every pass bubble (agent multi-pass turns)
    if (raw) contentEl.innerHTML = renderContent(raw, mode);

    // ---- AUTO-RESUME: the stream dropped mid-answer (no done event).
    // If the user did NOT press stop, we still have budget, AND the dropped
    // stream actually produced new content, reconnect and continue from the
    // exact cutoff. No-new-content drops (provider stuck) stop here — the
    // user gets a clear Continue button instead of an infinite retry loop.
    // A watchdog abort (hung stream) still auto-resumes: the user did NOT
    // press stop, so the answer continues instead of freezing on Thinking.
    const producedNew = raw.length > (resumeCtx.raw || "").length;
    if (!gotDone && !aiMsg._error && raw && !userStopped &&
        producedNew && resumeCtx.attempt < MAX_AUTO_RESUME) {
      if (hud) hud.set("Reconnecting…");
      setStreaming(false);
      resumeCtx.attempt++;
      resumeCtx.raw = raw;
      resumeCtx.aiMsg = aiMsg;
      resumeCtx.msgEl = msgEl;
      // progressive backoff before reconnecting (1.2s → 3s) — also covers
      // brief offline gaps without hammering a struggling provider
      setTimeout(() => {
        send(text, { errors, reuseLastUser: true, resumeOf: resumeCtx });
      }, Math.min(3000, 1200 * resumeCtx.attempt));
      return;
    }

    if (hud) {
      if (raw) hud.remove();
      else hud.set(aiMsg._error ? "Failed" : "Stopped");
    }

    if (mode === "agent") PFAgent.ingest(raw, { final: true });
    // build finished — lift the blur so the user finally sees the result
    if (mode === "agent") PFAgent.setCoding(false);

    aiMsg.content = raw;
    delete aiMsg._live;
    const sNow = current();
    if (sNow && mode === "agent") sNow.files = PFAgent.getFiles();
    saveSessions();

    // persist conversation to the private DB (best-effort, silent)
    if (gotDone || raw) {
      fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: sNow?.id || "", // stable per-chat file on the server
          title: sNow?.title || "Conversation",
          mode,
          model: sNow?.provider || "engine:qwen",
          createdAt: new Date(sNow?.created || Date.now()).toISOString(),
          messages: (sNow?.messages || []).filter((m) => !m._live && m.content),
        }),
      }).catch(() => {});
    }

    if (aiMsg._error && !raw) {
      contentEl.innerHTML = "";
      const box = document.createElement("div");
      box.className = "err-box red";
      box.innerHTML = `<span>⚠ ${PFMD.esc(aiMsg._error)}</span>`;
      const retry = document.createElement("button");
      retry.textContent = "Try again";
      retry.addEventListener("click", () => {
        const s2 = current();
        if (s2) { s2.messages.pop(); saveSessions(); }
        msgEl.remove();
        send(text, { errors, reuseLastUser: true });
      });
      box.appendChild(retry);
      contentEl.appendChild(box);
    } else {
      contentEl.innerHTML = renderContent(raw, mode);
      if (!gotDone && raw) {
        const note = document.createElement("div");
        note.className = "err-box";
        note.style.marginTop = "10px";
        note.innerHTML = `<span>⚠ Connection dropped after ${resumeCtx.attempt} auto-reconnect attempt(s). Continue with:</span>`;
        const again = document.createElement("button");
        again.textContent = "Continue";
        again.addEventListener("click", () => {
          resumeCtx.attempt = 0;
          resumeCtx.raw = raw;
          resumeCtx.aiMsg = aiMsg;
          resumeCtx.msgEl = msgEl;
          note.remove();
          send(text, { errors, reuseLastUser: true, resumeOf: resumeCtx });
        });
        note.appendChild(again);
        contentEl.appendChild(note);
      }
      if (aiMsg.model) {
        const meta = msgEl.querySelector(".msg-meta");
        if (!meta.querySelector(".model-chip")) {
          meta.insertAdjacentHTML("beforeend", `<span class="model-chip">${PFMD.esc(shortModel(aiMsg.model))}</span>`);
        }
      }
      wireMsg(msgEl);
    }
    setStreaming(false);
    scrollBottom();
  }

  function buildStreamingMsg() {
    const wrap = document.createElement("div");
    wrap.className = "msg ai";
    wrap.innerHTML =
      `<div class="msg-avatar"></div>` +
      `<div class="msg-body">` +
      `<div class="msg-meta"><span class="msg-role">Professor</span></div>` +
      `<div class="status-line" hidden><span class="status-dot"></span><span>…</span></div>` +
      `<div class="typing"><span></span><span></span><span></span></div>` +
      `<div class="msg-content md"></div></div>`;
    return wrap;
  }

  function stop() {
    userStopped = true;
    if (abortCtrl) abortCtrl.abort();
  }

  // ---- STALL WATCHDOG (fixes the "stuck on Thinking forever" freeze) ----
  // If the SSE connection produces NOTHING (no delta, no ping, no status)
  // for too long — a dead serverless function or a hung provider — the
  // stream is aborted and the normal auto-resume path takes over. A manual
  // stop never triggers this (userStopped flag), so the user is still in
  // charge of stopping.
  function startStallWatchdog() {
    stopStallWatchdog();
    lastStreamActivity = Date.now();
    stallTimer = setInterval(() => {
      if (!streaming || !abortCtrl) { stopStallWatchdog(); return; }
      const budget = mode === "agent" ? 180000 : 90000; // agent models queue longer
      if (Date.now() - lastStreamActivity > budget) {
        stopStallWatchdog();
        try { abortCtrl.abort(); } catch { /* noop */ }
      }
    }, 5000);
  }
  function stopStallWatchdog() {
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  }
  function touchStream() { lastStreamActivity = Date.now(); }

  /* ============================ auto-fix (agent) ============================ */
  function wireAgent() {
    PFAgent.onFixRequest = (errors) => {
      if (streaming) return;
      setMode("agent");
      PFAgent.openMobile();
      PFAgent.pushConsole("log", "auto-fix: asking the agent to repair " + errors.length + " error(s)…");
      send(
        "The preview reported these runtime errors. Find the root cause in the current project files and re-emit the fixed file(s) in full:\n" +
          errors.map((e) => "- " + e).join("\n"),
        { errors }
      );
    };
  }

  /* ============================ init ============================ */
  function init() {
    $("messages").innerHTML = "";
    wireScrollBtn();

    $("btnModeChat").addEventListener("click", () => setMode("chat"));
    $("btnModeAgent").addEventListener("click", () => setMode("agent"));
    // New chat works DURING a stream too: the running answer is stopped
    // (kept as-is in the old chat) and a fresh chat opens — the old code
    // left the user trapped while "Thinking" hung.
    $("btnNew").addEventListener("click", () => {
      if (streaming) stop();
      newSession();
      closeSideMobile();
    });
    $("btnOpenSide").addEventListener("click", openSide);
    $("btnCloseSide").addEventListener("click", closeSide);
    $("btnToggleSide").addEventListener("click", toggleSide);
    $("sideBackdrop").addEventListener("click", closeSide);

    // model picker dropdown (below composer, opens upward)
    $("mpTrigger").addEventListener("click", () => setMpOpen(!mpOpen));
    document.addEventListener("click", (e) => {
      if (mpOpen && !$("modelPickerBar").contains(e.target)) setMpOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mpOpen) setMpOpen(false);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isMobile() && $("app").dataset.side === "open") closeSide();
    });

    const input = $("input");
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 180) + "px";
      updateSendBtn();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (streaming) return;
        const v = input.value;
        input.value = "";
        input.style.height = "auto";
        updateSendBtn();
        send(v);
      }
    });
    $("btnSend").addEventListener("click", () => {
      if (streaming) return;
      const v = input.value;
      input.value = "";
      input.style.height = "auto";
      updateSendBtn();
      send(v);
    });
    $("btnStop").addEventListener("click", stop);

    wireAgent();

    if (isMobile()) {
      $("app").dataset.side = "closed";
    } else {
      let pref = "open";
      try { pref = localStorage.getItem(LS_SIDE) || "open"; } catch { /* noop */ }
      $("app").dataset.side = pref;
    }

    // Restore the last session — refresh keeps the user in the SAME chat.
    // A brand-new empty session is only created when none exists at all.
    if (!current()) newSession();
    renderSessionList();
    renderModelPicker();
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    toast, send, setProviders, confirmDialog,
    onUser(u) {
      // called by auth.js when the session exists — load the user's providers
      // and isolate all local session data under their account key.
      // The user's saved currentId is restored, so a page refresh keeps
      // them in the SAME chat instead of spawning a new one.
      const wasPublic = lsPrefix === "public";
      const prevCurrentId = currentId;
      setAccountKey(u?.email || u?.username || "public");
      renderMessages();
      renderSessionList();
      renderModelPicker();
      if (currentId !== prevCurrentId || wasPublic) PFAgent.reset();
      const s = current();
      if (s) PFAgent.setFiles(s.files || []);
      setMode((s && s.mode) || mode, { soft: true });

      // RESTORE: if this browser has no local sessions for the account
      // (fresh login, new device, sign-out/sign-in), pull the saved
      // conversations from the private DB so the history is never lost.
      // Chats are keyed by their server file suffix (the client-sent chat
      // key), so restored chats keep a STABLE id — refreshing later merges
      // instead of duplicating. The guard tolerates the ONE empty
      // auto-created session that init() may have spawned while the fetch
      // was in flight.
      fetch("/api/history")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const onlyEmptyAuto =
            sessions.length === 1 &&
            !(sessions[0].messages || []).length;
          const canRestore =
            d && Array.isArray(d.chats) && d.chats.length &&
            (!sessions.length || onlyEmptyAuto);
          if (!canRestore) return;
          const imported = [];
          for (const c of d.chats) {
            // stable id from the server file suffix (the chat key we sent
            // when saving); fall back to a path hash for legacy files
            const keyMatch = /-([a-z0-9]{6,42})\.txt$/i.exec(c.path || "");
            const key = keyMatch ? keyMatch[1] : c.path.replace(/[^a-z0-9]/gi, "").slice(-40);
            imported.push({
              id: "srv-" + key,
              title: c.title || "Conversation",
              mode: c.mode === "agent" ? "agent" : "chat",
              provider: normalizeEngine(c.model && c.model !== "default" ? c.model : ""),
              created: c.createdAt ? Date.parse(c.createdAt) || Date.now() : Date.now(),
              messages: (c.messages || []).map((m) => ({
                role: m.role,
                content: m.content,
                model: m.role === "assistant" ? (c.model && c.model !== "default" ? c.model : null) : undefined,
              })),
              files: [],
            });
          }
          // newest-first ordering, then select the most recent chat
          imported.sort((a, b) => (b.created || 0) - (a.created || 0));
          sessions = imported;
          currentId = sessions[0].id;
          saveCurrentId(currentId);
          saveSessions();
          renderMessages();
          renderSessionList();
          renderModelPicker();
          const s2 = current();
          if (s2) {
            setMode(s2.mode || "chat", { soft: true });
            PFAgent.setFiles(s2.files || []);
            PFAgent.reset();
          }
        })
        .catch(() => {});

      // only create a fresh session if the account has none anywhere
      if (!current()) newSession();
      fetch("/api/profile")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setProviders(d.providers || []); })
        .catch(() => {});
    },
    onLogout() {
      // server-side history (private DB) is NEVER touched on sign-out —
      // the next login restores the full conversation list via /api/history
      sessions = [];
      currentId = null;
      saveCurrentId(null);
      try { localStorage.removeItem(sessionsKey()); } catch { /* noop */ }
      renderSessionList();
    },
  };
})();
