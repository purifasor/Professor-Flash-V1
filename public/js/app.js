// Professor Flash — main app: chat streaming, sessions, sidebar, agent integration.
// Stability rules: messages are appended incrementally (never rebuilt mid-session),
// so entry animations, avatars and the logo never restart or flicker.
window.PFApp = (() => {
  const $ = (id) => document.getElementById(id);

  /* ============================ state ============================ */
  const LS_KEY = "professor-flash.v3.sessions";
  const LS_SIDE = "professor-flash.side";
  let sessions = loadSessions();
  let currentId = null;
  let mode = "chat";
  let searchOn = false;
  let streaming = false;
  let abortCtrl = null;

  function loadSessions() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
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
    updateSendBtn();
  }

  function updateSendBtn() {
    $("btnSend").disabled = streaming || !$("input").value.trim();
  }

  /* ============================ sessions ============================ */
  function newSession() {
    const s = {
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "گفتگوی جدید",
      mode,
      created: Date.now(),
      messages: [],
      files: [],
    };
    sessions.unshift(s);
    currentId = s.id;
    saveSessions();
    renderMessages();
    renderSessionList();
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
      box.innerHTML = '<div class="side-empty">هنوز گفتگویی نداری.</div>';
      return;
    }
    box.innerHTML = "";
    for (const s of sessions) {
      const b = document.createElement("button");
      b.className = "session-item" + (s.id === currentId ? " active" : "");
      b.innerHTML =
        `<span class="si-ico">${s.mode === "agent" ? "⚡" : "💬"}</span>` +
        `<span class="si-title">${PFMD.esc(s.title)}</span>` +
        `<span class="si-del" title="حذف">✕</span>`;
      b.addEventListener("click", () => switchSession(s.id));
      b.querySelector(".si-del").addEventListener("click", (e) => deleteSession(s.id, e));
      box.appendChild(b);
    }
  }

  /* ============================ messages render ============================ */
  function fileChip(path) {
    return `<button class="file-chip" data-file="${PFMD.esc(path)}" title="باز کردن در کارگاه">📄 ${PFMD.esc(path)}</button>`;
  }

  // In chat mode there is no workbench: ```file: blocks become inline code.
  const EXT_LANG = { html: "html", css: "css", js: "javascript", json: "json", md: "markdown", svg: "xml", txt: "text", py: "python" };
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
    const el = hero.firstElementChild;
    wirePromptButtons(el);
    return el;
  }

  const HERO_HTML = $("hero") ? $("hero").outerHTML : "";

  function wirePromptButtons(root) {
    root.querySelectorAll("[data-prompt]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prompt = btn.dataset.prompt;
        if (btn.dataset.mode) setMode(btn.dataset.mode);
        if (btn.dataset.search) setSearch(true);
        send(prompt);
      });
    });
  }

  function buildMsg(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (m.role === "user" ? "user" : "ai");
    const avatar = m.role === "user" ? "👤" : "⚡";
    const role = m.role === "user" ? "شما" : "پروفسور فلش";
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
        try { await navigator.clipboard.writeText(code); b.textContent = "کپی شد ✓"; }
        catch { b.textContent = "خطا"; }
        setTimeout(() => (b.textContent = "کپی"), 1600);
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

  // Remove the hero exactly once (no re-render, no animation restart).
  function dropHero() {
    const h = $("messages").querySelector(".hero");
    if (h) h.remove();
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
    $("btnSearch").style.display = mode === "chat" ? "" : "none";
    $("input").placeholder = mode === "agent"
      ? "برنامه‌ای که می‌خواهی را توصیف کن… (مثلاً: یک بازی مار با تم نئون قرمز بساز)"
      : "پیامت را بنویس… (Enter = ارسال، Shift+Enter = خط جدید)";
    $("composerHint").innerHTML = mode === "agent"
      ? "عامل کدنویس: پروژهٔ <b>چندفایلی</b> سازمان‌یافته + اجرای زنده در کارگاه + دانلود ZIP"
      : "مدل‌های قوی و رایگان · پاسخ تازه، نه آماده · <b>مغز متصل به گیت‌هاب</b>";
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

  function setSearch(on) {
    searchOn = !!on;
    $("btnSearch").setAttribute("aria-pressed", String(searchOn));
    toast(searchOn ? "جستجوی وب فعال شد 🌐" : "جستجوی وب خاموش شد");
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

    // retry path: the user bubble is already on screen and in history
    const skipUser =
      reuseLastUser && s.messages.length && s.messages[s.messages.length - 1].role === "user";

    if (!skipUser) {
      if (s.messages.length === 0) s.title = text.slice(0, 46);
      s.mode = mode;
      const userMsg = { role: "user", content: text };
      s.messages.push(userMsg);

      // incremental DOM: hero out, user message in — nothing else is touched
      dropHero();
      $("messages").appendChild(buildMsg(userMsg));
    }

    const aiMsg = { role: "assistant", content: "", model: null, mode, _live: true };
    s.messages.push(aiMsg);
    const msgEl = buildStreamingMsg();
    $("messages").appendChild(msgEl);
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

    // build API history (strip heavy file blocks from older agent turns)
    const history = s.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content:
        m.role === "assistant"
          ? m.content.replace(/```file:[^\n`]+\n[\s\S]*?```/g, "\n[فایل‌ها ساخته شد]\n")
          : m.content,
    }));

    const payload = { mode, messages: history };
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

          if (d.type === "status") {
            if (!gotFirst) {
              statusEl.hidden = false;
              statusEl.querySelector("span:last-child").textContent = d.text;
            }
          } else if (d.type === "delta") {
            if (!gotFirst) {
              gotFirst = true;
              statusEl.hidden = true;
              typingEl.hidden = true;
            }
            raw += d.text;
            scheduleRender();
            scheduleIngest();
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
        raw += raw ? "\n\n⏹ متوقف شد." : "";
      } else {
        aiMsg._error = e.message;
      }
    }

    // finalize
    clearTimeout(renderTimer);
    clearTimeout(ingestTimer);
    statusEl.hidden = true;
    typingEl.hidden = true;

    if (mode === "agent") PFAgent.ingest(raw, { final: true });

    aiMsg.content = raw;
    delete aiMsg._live;
    const sNow = current();
    if (sNow && mode === "agent") sNow.files = PFAgent.getFiles();
    saveSessions();

    if (aiMsg._error && !raw) {
      contentEl.innerHTML = "";
      const box = document.createElement("div");
      box.className = "err-box";
      box.innerHTML = `<span>⚠ ${PFMD.esc(aiMsg._error)}</span>`;
      const retry = document.createElement("button");
      retry.textContent = "تلاش دوباره";
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
      if (!gotDone) {
        // connection dropped before completion — offer a retry hint
        const note = document.createElement("div");
        note.className = "err-box";
        note.style.marginTop = "10px";
        note.innerHTML = `<span>⚠ اتصال قبل از پایان کامل پاسخ قطع شد.</span>`;
        const again = document.createElement("button");
        again.textContent = "تلاش دوباره";
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
      `<div class="msg-meta"><span class="msg-role">پروفسور فلش</span></div>` +
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
      send(
        "پیش‌نمایش این خطاها را گرفت. علت اصلی را پیدا کن و فایل(های) اصلاح‌شده را کامل دوباره بساز:\n" +
          errors.map((e) => "- " + e).join("\n"),
        { errors }
      );
    };
  }

  /* ============================ init ============================ */
  function init() {
    // capture hero template once, then clear (rendered via buildHero)
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
        const v = input.value;
        input.value = "";
        input.style.height = "auto";
        updateSendBtn();
        send(v);
      }
    });
    $("btnSend").addEventListener("click", () => {
      const v = input.value;
      input.value = "";
      input.style.height = "auto";
      updateSendBtn();
      send(v);
    });
    $("btnStop").addEventListener("click", stop);

    wirePromptButtons(document);
    wireAgent();

    // sidebar: desktop remembers preference; mobile starts closed
    if (isMobile()) {
      $("app").dataset.side = "closed";
    } else {
      let pref = "open";
      try { pref = localStorage.getItem(LS_SIDE) || "open"; } catch { /* noop */ }
      $("app").dataset.side = pref;
    }

    // restore last session or start fresh
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
    input.focus();
  }

  document.addEventListener("DOMContentLoaded", init);

  return { toast };
})();
