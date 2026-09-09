// Professor AI — main app: chat streaming, sessions, model picker, agent integration.
// English UI. Model choice locks per-conversation once set. Custom providers
// (user-added models) stream through the same pipeline with red errors.
window.PFApp = (() => {
  const $ = (id) => document.getElementById(id);

  /* ============================ state ============================ */
  const LS_KEY = "professor-ai.sessions";
  const LS_SIDE = "professor-ai.side";
  const LS_SEARCH = "professor-ai.search";
  let sessions = loadSessions();
  let currentId = null;
  let mode = "chat";
  let searchOn = loadBool(LS_SEARCH, false);
  let streaming = false;
  let abortCtrl = null;
  let providers = []; // user's custom providers [{name, modelId,...}]

  function loadSessions() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
  }
  function loadBool(k, d) {
    try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch { return d; }
  }
  let saveTimer = null;
  function saveSessions() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(sessions.slice(0, 60))); } catch { /* full */ }
    }, 250);
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
      provider: "", // "" = default; locked on first send
      created: Date.now(),
      messages: [],
      files: [],
    };
    sessions.unshift(s);
    currentId = s.id;
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

  function deleteSession(id, ev) {
    ev.stopPropagation();
    sessions = sessions.filter((s) => s.id !== id);
    if (currentId === id) {
      currentId = null;
      if (sessions.length) {
        const nxt = sessions[0];
        currentId = nxt.id;
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
      b.querySelector(".si-del").addEventListener("click", (e) => deleteSession(s.id, e));
      box.appendChild(b);
    }
  }

  /* ============================ agent HUD ============================ */
  function makeHud(el) {
    const hud = document.createElement("div");
    hud.className = "agent-hud";
    hud.innerHTML =
      '<div class="hud-row"><span class="hud-spinner"></span><span class="hud-text">Thinking…</span></div>';
    el.appendChild(hud);
    return {
      set(text) { hud.querySelector(".hud-text").textContent = text; },
      addFile(path) {
        let row = hud.querySelector(".hud-files");
        if (!row) {
          row = document.createElement("div");
          row.className = "hud-files";
          hud.appendChild(row);
        }
        const chip = document.createElement("span");
        chip.className = "hud-file";
        chip.textContent = path;
        row.appendChild(chip);
      },
      remove() { hud.remove(); },
    };
  }

  /* ============================ messages render ============================ */
  function fileChip(path) {
    return `<button class="file-chip" data-file="${PFMD.esc(path)}" title="Open in workshop">📄 ${PFMD.esc(path)}</button>`;
  }

  const EXT_LANG = { html: "html", css: "css", js: "javascript", json: "json", md: "markdown", svg: "xml", txt: "text", py: "python", cpp: "cpp", ts: "typescript" };
  function chatifyFileBlocks(text) {
    return String(text).replace(/```file:([^\n`]+)\n([\s\S]*?)(?:```|$)/g, (_m, p, body) => {
      const ext = (p.trim().split(".").pop() || "").toLowerCase();
      const lang = EXT_LANG[ext] || "text";
      return `\`\`\`${lang}\n// ${p.trim()}\n${body}\`\`\``;
    });
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
    scrollBottom(true);
  }

  function buildHero() {
    const hero = document.createElement("div");
    hero.innerHTML = HERO_HTML;
    return hero.firstElementChild;
  }

  const HERO_HTML = $("hero") ? $("hero").outerHTML : "";

  function buildMsg(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (m.role === "user" ? "user" : "ai");
    const avatar = m.role === "user" ? "👤" : "⚡";
    const role = m.role === "user" ? "You" : "Professor";
    const modelChip = m.model ? `<span class="model-chip">${PFMD.esc(shortModel(m.model))}</span>` : "";
    const msgMode = m.mode || mode;
    const contentHtml = m.role === "user" ? PFMD.esc(m.content) : renderContent(m.content, msgMode);
    const srcBox = m.search?.results?.length
      ? `<div class="src-box">${m.search.results
          .slice(0, 4)
          .map((r) => `<a class="src-link" href="${PFMD.esc(r.url)}" target="_blank" rel="noopener">🔗 ${PFMD.esc(r.title)}</a>`)
          .join("")}</div>`
      : "";
    wrap.innerHTML =
      `<div class="msg-avatar">${avatar}</div>` +
      `<div class="msg-body">` +
      `<div class="msg-meta"><span class="msg-role">${role}</span>${modelChip}</div>` +
      `<div class="msg-content md">${contentHtml}</div>${srcBox}</div>`;
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
  }

  function shortModel(id) {
    return String(id || "").split("/").pop().replace(/:free$/, "");
  }

  function dropHero() {
    const h = $("messages").querySelector(".hero");
    if (h) h.remove();
  }

  /* ============================ model picker ============================ */
  // Per-conversation lock: once a session has messages, its provider is fixed.
  function renderModelPicker() {
    const box = $("modelOptions");
    if (!box) return;
    box.innerHTML = "";
    const s = current();
    const locked = s && s.messages && s.messages.length > 0;
    const chosen = (s && s.provider) || "";

    const mk = (label, value, isCustom) => {
      const b = document.createElement("button");
      b.className = "mp-option" + ((value || "") === chosen ? " active" : "") + (isCustom ? " custom" : "");
      b.dataset.provider = value || "";
      b.textContent = label;
      b.disabled = locked && (value || "") !== chosen;
      b.title = locked ? "This conversation is locked to its model" : label;
      b.addEventListener("click", () => {
        if (locked) return;
        const sess = current();
        if (sess) {
          sess.provider = value || "";
          saveSessions();
        }
        renderModelPicker();
      });
      return b;
    };

    box.appendChild(mk("Default", "", false));
    for (const p of providers) {
      box.appendChild(mk(p.name || p.modelId, p.name || p.modelId, true));
    }
    $("modelPickerBar").classList.toggle("locked", locked);
  }

  function setProviders(list) {
    providers = Array.isArray(list) ? list : [];
    renderModelPicker();
  }

  /* ============================ mode & search ============================ */
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
    $("composerHint").innerHTML = mode === "agent"
      ? "Coding agent: <b>multi-file</b> projects + live preview + console + auto-fix + ZIP"
      : 'Live prices &amp; time data · fresh answers, never canned · <b>your history stays private</b>';
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

  function setSearch(on, { silent = false } = {}) {
    searchOn = !!on;
    try { localStorage.setItem(LS_SEARCH, on ? "1" : "0"); } catch { /* noop */ }
    $("btnSearch").setAttribute("aria-pressed", String(searchOn));
    if (!silent) toast(searchOn ? "Web search enabled 🌐" : "Web search disabled");
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
  async function send(text, { errors = null, reuseLastUser = false } = {}) {
    text = String(text || "").trim();
    if (!text || streaming) return;
    const s = ensureSession();

    const skipUser =
      reuseLastUser && s.messages.length && s.messages[s.messages.length - 1].role === "user";

    if (!skipUser) {
      if (s.messages.length === 0) s.title = text.slice(0, 46);
      s.mode = mode;
      const userMsg = { role: "user", content: text };
      s.messages.push(userMsg);
      dropHero();
      $("messages").appendChild(buildMsg(userMsg));
      renderModelPicker(); // lock the model now that the conversation started
    }

    const aiMsg = { role: "assistant", content: "", model: null, mode, _live: true };
    s.messages.push(aiMsg);
    const msgEl = buildStreamingMsg();
    $("messages").appendChild(msgEl);
    const hud = mode === "agent" ? makeHud(msgEl.querySelector(".msg-body")) : null;
    saveSessions();
    renderSessionList();
    scrollBottom(true);

    setStreaming(true);
    abortCtrl = new AbortController();

    const statusEl = msgEl.querySelector(".status-line");
    const contentEl = msgEl.querySelector(".msg-content");
    const typingEl = msgEl.querySelector(".typing");
    let raw = "";
    let gotFirst = false;
    let gotDone = false;
    let renderTimer = null;
    let ingestTimer = null;
    let currentFile = null;

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
        hud.set("Writing " + currentFile);
        hud.addFile(currentFile);
      } else if (/SUMMARY:|CONTINUE:/i.test(raw.slice(-120)) && !m) {
        hud.set(/CONTINUE:/i.test(raw.slice(-120)) ? "Continuing build…" : "Wrapping up…");
      }
    };

    const history = s.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content:
        m.role === "assistant"
          ? m.content.replace(/```file:[^\n`]+\n[\s\S]*?```/g, "\n[files emitted]\n")
          : m.content,
    }));

    const payload = { mode, messages: history };
    if (s.provider) payload.provider = s.provider; // custom provider name
    if (mode === "chat" && searchOn) payload.search = true;
    if (mode === "agent") {
      payload.files = PFAgent.getFiles();
      if (errors && errors.length) payload.errors = errors;
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
              if (hud) hud.set("Generating…");
            }
            raw += d.text;
            scheduleRender();
            scheduleIngest();
            trackHud();
          } else if (d.type === "done") {
            gotDone = true;
            aiMsg.model = d.model ? `${d.provider || ""} · ${d.model}` : null;
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
    if (hud) {
      if (raw) hud.remove();
      else hud.set(aiMsg._error ? "Failed" : "Stopped");
    }

    if (mode === "agent") PFAgent.ingest(raw, { final: true });

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
        note.innerHTML = `<span>⚠ Connection dropped before the answer finished.</span>`;
        const again = document.createElement("button");
        again.textContent = "Try again";
        again.addEventListener("click", () => {
          const s2 = current();
          if (s2) { s2.messages.pop(); saveSessions(); }
          msgEl.remove();
          send(text, { errors, reuseLastUser: true });
        });
        note.appendChild(again);
        contentEl.appendChild(note);
      }
      if (aiMsg.model) {
        const meta = msgEl.querySelector(".msg-meta");
        meta.insertAdjacentHTML("beforeend", `<span class="model-chip">${PFMD.esc(shortModel(aiMsg.model))}</span>`);
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
      `<div class="msg-avatar">⚡</div>` +
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
        "The preview reported these runtime errors. Find the root cause and re-emit the fixed file(s) in full:\n" +
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
    $("btnSearch").addEventListener("click", () => setSearch(!searchOn));
    $("btnNew").addEventListener("click", () => { if (!streaming) { newSession(); closeSideMobile(); } });
    $("btnOpenSide").addEventListener("click", openSide);
    $("btnCloseSide").addEventListener("click", closeSide);
    $("btnToggleSide").addEventListener("click", toggleSide);
    $("sideBackdrop").addEventListener("click", closeSide);

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

    if (sessions.length) {
      currentId = sessions[0].id;
      const s = current();
      setMode(s.mode || "chat", { soft: true });
      renderMessages();
      PFAgent.setFiles(s.files || []);
    } else {
      newSession();
    }
    renderSessionList();
    setSearch(searchOn, { silent: true });
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    toast, send, setProviders,
    onUser(u) {
      // called by auth.js when the session exists — load the user's providers
      fetch("/api/profile")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setProviders(d.providers || []); })
        .catch(() => {});
    },
  };
})();
