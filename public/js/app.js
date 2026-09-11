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
      provider: loadLastModel(), // remember the last selected model
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
    if (streaming || id === currentId) { closeSideMobile(); return; }
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

  function renderContent(text, forMode) {
    return forMode === "agent"
      ? PFMD.render(text, { fileRenderer: fileChip })
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
  // Built-in engine models are abbreviated so casual users don't mistake
  // them for third-party services: Qwen → Q, NVIDIA → N, Ling → L.
  function shortModel(id) {
    const s = String(id || "").toLowerCase();
    if (!s) return "";
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
      return (p && (p.name || p.modelId)) || String(id).split("/").pop();
    }
    if (s.includes("qwen")) return "Q";
    if (s.includes("nemotron") || s.includes("nvidia")) return "N";
    if (s.includes("ling") || s.includes("inclusion")) return "L";
    // default engine with no model detail
    if (s.includes("professor") || !s.includes("/")) return s.includes("professor") ? "Professor" : String(id).split("/").pop();
    return String(id).split("/").pop().replace(/:free$/, "");
  }

  function dropHero() {
    const h = $("messages").querySelector(".hero");
    if (h) h.remove();
  }

  /* ============================ model picker (below composer, upward dropdown) ============================ */
  // Per-conversation lock: once a session has messages, its provider is fixed.
  // The last choice is remembered and becomes the default for new chats.
  let mpOpen = false;

  function chosenProvider() {
    const s = current();
    if (s && s.provider) return s.provider;
    return loadLastModel();
  }

  function providerLabel(v) {
    if (!v) return "Default";
    const p = providers.find((x) => (x.name || x.modelId) === v);
    return p ? p.name || p.modelId : v;
  }

  // Called by profile.js after providers load/delete — keeps the model
  // picker in sync. If the user's chosen provider was removed, gracefully
  // fall back to the default engine (never a dead selection).
  function setProviders(list) {
    providers = Array.isArray(list) ? list : [];
    const stillThere = (v) => !v || providers.some((x) => (x.name || x.modelId) === v);
    if (!stillThere(loadLastModel())) {
      saveLastModel("");
    }
    for (const s of sessions) {
      if (s.provider && !stillThere(s.provider)) s.provider = "";
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

    const mk = (label, value, isCustom) => {
      const b = document.createElement("button");
      b.className = "mp-option" + ((value || "") === chosen ? " active" : "") + (isCustom ? " custom" : "");
      b.dataset.provider = value || "";
      b.setAttribute("role", "option");
      b.innerHTML =
        `<span class="mp-name">${PFMD.esc(label)}</span>` +
        (value ? '<span class="mp-tag">custom</span>' : '<span class="mp-tag">built-in</span>');
      b.disabled = locked && (value || "") !== chosen;
      b.addEventListener("click", () => {
        if (locked) return;
        const sess = ensureSession();
        sess.provider = value || "";
        saveLastModel(value || ""); // remember for the next new chat
        saveSessions();
        setMpOpen(false);
        renderModelPicker();
      });
      return b;
    };

    box.appendChild(mk("Default — Professor engine", "", false));
    for (const p of providers) {
      box.appendChild(mk(p.name || p.modelId, p.name || p.modelId, true));
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
  const MAX_AUTO_RESUME = 3;

  async function send(text, { errors = null, reuseLastUser = false, resumeOf = null } = {}) {
    const resumeCtx = resumeOf || { attempt: 0, raw: "", aiMsg: null, msgEl: null };
    text = String(text || "").trim();
    if (!text || (streaming && !resumeOf)) return;
    const s = ensureSession();

    const skipUser =
      (reuseLastUser || resumeOf) && s.messages.length && s.messages[s.messages.length - 1].role === "user";

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
    saveSessions();
    renderSessionList();
    scrollBottom(true);

    if (mode === "agent") {
      // blur the preview with a loading animation for the whole build
      PFAgent.setCoding(true, resumeCtx.raw ? "" : "");
    }
    setStreaming(true);
    abortCtrl = new AbortController();

    const statusEl = msgEl.querySelector(".status-line");
    const contentEl = msgEl.querySelector(".msg-content");
    const typingEl = msgEl.querySelector(".typing");
    let raw = resumeCtx.raw || "";
    let gotFirst = !!resumeCtx.raw;
    let gotDone = false;
    let renderTimer = null;
    let ingestTimer = null;
    let currentFile = null;

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
    if (s.provider) payload.provider = s.provider; // custom provider name
    // Pin the conversation to the engine model it started with (Qwen/N/L).
    if (!s.provider) {
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

          if (d.type === "ping") continue;
          if (d.type === "status") {
            if (hud && !gotFirst) hud.set(d.text);
            if (!gotFirst) {
              statusEl.hidden = false;
              statusEl.querySelector("span:last-child").textContent = d.text;
            }
          } else if (d.type === "delta") {
            if (!gotFirst) {
              gotFirst = true;
              statusEl.hidden = true;
              typingEl.hidden = true;
              if (hud) hud.coding();
            }
            raw += d.text;
            scheduleRender();
            scheduleIngest();
            trackHud();
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
    statusEl.hidden = true;
    typingEl.hidden = true;

    // ---- AUTO-RESUME: the stream dropped mid-answer (no done event).
    // If the user did NOT press stop, we still have budget, AND the dropped
    // stream actually produced new content, reconnect and continue from the
    // exact cutoff. No-new-content drops (provider stuck) stop here — the
    // user gets a clear Continue button instead of an infinite retry loop.
    const producedNew = raw.length > (resumeCtx.raw || "").length;
    if (!gotDone && !aiMsg._error && raw && abortCtrl && !abortCtrl.signal.aborted &&
        producedNew && resumeCtx.attempt < MAX_AUTO_RESUME) {
      if (hud) hud.set("Reconnecting…");
      setStreaming(false);
      resumeCtx.attempt++;
      resumeCtx.raw = raw;
      resumeCtx.aiMsg = aiMsg;
      resumeCtx.msgEl = msgEl;
      // small backoff before reconnecting (also covers brief offline gaps)
      setTimeout(() => {
        send(text, { errors, reuseLastUser: true, resumeOf: resumeCtx });
      }, 1200);
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
          title: sNow?.title || "Conversation",
          mode,
          model: sNow?.provider || "default",
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
    if (abortCtrl) abortCtrl.abort();
  }

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

    $("btnModeChat").addEventListener("click", () => setMode("chat"));
    $("btnModeAgent").addEventListener("click", () => setMode("agent"));
    $("btnNew").addEventListener("click", () => { if (!streaming) { newSession(); closeSideMobile(); } });
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
      if (!sessions.length) {
        fetch("/api/history")
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && Array.isArray(d.chats) && d.chats.length && !sessions.length) {
              for (const c of d.chats) {
                sessions.push({
                  id: "srv-" + c.path.replace(/[^a-z0-9]/gi, "").slice(-40),
                  title: c.title || "Conversation",
                  mode: c.mode === "agent" ? "agent" : "chat",
                  provider: c.model && c.model !== "default" ? c.model : "",
                  created: c.createdAt ? Date.parse(c.createdAt) || Date.now() : Date.now(),
                  messages: (c.messages || []).map((m) => ({
                    role: m.role,
                    content: m.content,
                    model: m.role === "assistant" ? (c.model !== "default" ? c.model : null) : undefined,
                  })),
                  files: [],
                });
              }
              // newest-first ordering, then select the most recent chat
              sessions.sort((a, b) => (b.created || 0) - (a.created || 0));
              currentId = sessions.length ? sessions[0].id : null;
              saveCurrentId(currentId);
              saveSessions();
              renderMessages();
              renderSessionList();
              renderModelPicker();
              const s2 = current();
              if (s2) {
                setMode(s2.mode || "chat", { soft: true });
                PFAgent.reset();
              }
            }
          })
          .catch(() => {});
      }

      // only create a fresh session if the account has none anywhere
      if (!current()) newSession();
      fetch("/api/profile")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setProviders(d.providers || []); })
        .catch(() => {});
    },
    onLogout() {
      // wipe in-memory data and clear per-account storage on sign-out
      sessions = [];
      currentId = null;
      saveCurrentId(null);
      try { localStorage.removeItem(sessionsKey()); } catch { /* noop */ }
      renderSessionList();
    },
  };
})();
