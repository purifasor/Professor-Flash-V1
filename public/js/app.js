/* Professor Flash — main app: sessions, modes, SSE chat, composer. */
window.PFApp = (() => {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = "pf.sessions.v2";

  const state = {
    mode: "chat",            // 'chat' | 'agent'
    sessions: [],            // [{id,title,mode,messages,files,updatedAt}]
    current: null,           // current session object
    sending: false,
    abort: null,
    searchOn: false,
  };

  /* ================================================== persistence */
  function loadSessions() {
    try {
      state.sessions = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    } catch {
      state.sessions = [];
    }
  }
  function saveSessions() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.sessions.slice(0, 60)));
    } catch { /* quota */ }
  }
  function persistCurrent() {
    if (!state.current || !state.current.messages.length) return;
    const s = state.current;
    s.updatedAt = Date.now();
    if (s.mode === "agent") s.files = PFAgent.getFilesObject();
    const i = state.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) state.sessions.splice(i, 1);
    state.sessions.unshift(s);
    saveSessions();
    renderSessionList();
  }

  /* ================================================== sessions */
  function newSession(mode) {
    state.current = {
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "گفتگوی جدید",
      mode: mode || state.mode,
      messages: [],
      files: {},
      updatedAt: Date.now(),
    };
    renderMessages();
    $("chatTitle").textContent = "گفتگوی جدید";
    $("engineChip").hidden = true;
    $("hero").style.display = "";
    if (state.current.mode === "agent") PFAgent.reset();
  }

  function openSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    state.current = s;
    setMode(s.mode || "chat");
    if (s.mode === "agent" && s.files) PFAgent.setFiles(s.files);
    if (s.mode !== "agent") PFAgent.reset();
    $("chatTitle").textContent = s.title;
    renderMessages();
    closeDrawer();
  }

  function deleteSession(id, ev) {
    ev.stopPropagation();
    state.sessions = state.sessions.filter((x) => x.id !== id);
    saveSessions();
    renderSessionList();
    if (state.current && state.current.id === id) newSession(state.mode);
  }

  function clearCurrent() {
    if (!state.current) return;
    state.current.messages = [];
    state.current.title = "گفتگوی جدید";
    if (state.current.mode === "agent") PFAgent.reset();
    $("chatTitle").textContent = "گفتگوی جدید";
    $("engineChip").hidden = true;
    renderMessages();
    state.sessions = state.sessions.filter((x) => x.id !== state.current.id);
    saveSessions();
    renderSessionList();
  }

  /* ================================================== mode */
  function setMode(mode) {
    state.mode = mode;
    $("app").classList.toggle("agent", mode === "agent");
    $("btnModeChat").classList.toggle("active", mode === "chat");
    $("btnModeAgent").classList.toggle("active", mode === "agent");
    $("bench").hidden = mode !== "agent";
    $("input").placeholder =
      mode === "agent"
        ? "برنامه‌ات را توصیف کن… مثلاً: «یک بازی مار با تم فیروزه‌ای بساز»"
        : "پیامت را بنویس… (Enter = ارسال، Shift+Enter = خط جدید)";
    if (state.current && state.current.mode !== mode && !state.current.messages.length) {
      state.current.mode = mode;
    }
  }

  /* ================================================== rendering */
  const messagesEl = () => $("messages");

  function nearBottom() {
    const el = messagesEl();
    return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }
  function scrollBottom(force) {
    const el = messagesEl();
    if (force || nearBottom()) el.scrollTop = el.scrollHeight;
  }

  function renderMessages() {
    const el = messagesEl();
    el.querySelectorAll(".msg").forEach((n) => n.remove());
    const msgs = state.current ? state.current.messages : [];
    $("hero").style.display = msgs.length ? "none" : "";
    msgs.forEach((m) => el.appendChild(buildMessageEl(m)));
    scrollBottom(true);
  }

  function buildMessageEl(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + m.role;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = m.role === "user" ? "👤" : "⚡";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (m.role === "user") {
      bubble.textContent = m.content;
    } else {
      bubble.innerHTML = PFMD.render(m.content || "");
      if (m.error) bubble.classList.add("error");
      bubble.appendChild(buildMetaEl(m));
    }
    wrap.append(avatar, bubble);
    return wrap;
  }

  function buildMetaEl(m) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    if (m.provider) {
      const chip = document.createElement("span");
      chip.className = "m-chip";
      chip.textContent = `${m.provider} · ${m.model || ""}`;
      meta.appendChild(chip);
    }
    if (m.search && m.search.results && m.search.results.length) {
      const srcWrap = document.createElement("div");
      srcWrap.className = "sources";
      srcWrap.innerHTML = `<span class="src-title">منابع:</span>`;
      m.search.results.slice(0, 4).forEach((r) => {
        const a = document.createElement("a");
        a.href = r.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "🔗 " + (r.title || r.url);
        srcWrap.appendChild(a);
      });
      meta.appendChild(srcWrap);
    }
    const copy = document.createElement("button");
    copy.textContent = "کپی";
    copy.onclick = () => {
      navigator.clipboard.writeText(m.content).then(() => toast("کپی شد ✓"));
    };
    meta.appendChild(copy);
    if (m.role === "assistant") {
      const regen = document.createElement("button");
      regen.textContent = "↻ تولید دوباره";
      regen.onclick = () => regenerate(m);
      meta.appendChild(regen);
    }
    return meta;
  }

  /* -------- live assistant element while streaming -------- */
  function makeLiveAssistant() {
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "⚡";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML =
      `<div class="thinking"><div class="orb"></div>` +
      `<div class="think-text">در حال فکر کردن<span class="think-dots"></span><br>` +
      `<span class="t-status"></span></div>` +
      `<div class="think-elapsed"></div></div>`;
    wrap.append(avatar, bubble);
    return {
      wrap,
      bubble,
      statusEl: bubble.querySelector(".t-status"),
      elapsedEl: bubble.querySelector(".think-elapsed"),
    };
  }

  /* ================================================== sending */
  async function send(text) {
    text = (text || "").trim();
    if (!text || state.sending) return;
    if (!state.current) newSession(state.mode);
    if (state.current.mode !== state.mode && !state.current.messages.length)
      state.current.mode = state.mode;

    $("hero").style.display = "none";
    const userMsg = { role: "user", content: text };
    state.current.messages.push(userMsg);
    messagesEl().appendChild(buildMessageEl(userMsg));
    if (state.current.title === "گفتگوی جدید") {
      state.current.title = text.slice(0, 42) + (text.length > 42 ? "…" : "");
      $("chatTitle").textContent = state.current.title;
    }

    const input = $("input");
    input.value = "";
    autoGrow();
    updateSendBtn();

    const live = makeLiveAssistant();
    messagesEl().appendChild(live.wrap);
    scrollBottom(true);

    state.sending = true;
    state.abort = new AbortController();
    $("btnSend").hidden = true;
    $("btnStop").hidden = false;

    const startedAt = Date.now();
    const timer = setInterval(() => {
      live.elapsedEl.textContent = ((Date.now() - startedAt) / 1000).toFixed(0) + "s";
    }, 500);

    let raw = "";
    let meta = { provider: null, model: null, search: null };
    let renderScheduled = false;

    const scheduleRender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      setTimeout(() => {
        renderScheduled = false;
        live.bubble.innerHTML =
          PFMD.render(raw) + '<span class="stream-caret"></span>';
        scrollBottom(false);
      }, 90);
    };

    try {
      const payload = {
        messages: state.current.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        mode: state.current.mode,
        search: state.searchOn,
      };
      if (state.current.mode === "agent") {
        payload.files = PFAgent.getFilesArray();
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: state.abort.signal,
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
          let data;
          try {
            data = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (data.type === "status") {
            live.statusEl.textContent = data.text;
          } else if (data.type === "delta") {
            raw += data.text;
            scheduleRender();
            if (state.current.mode === "agent") PFAgent.ingestStream(raw);
          } else if (data.type === "done") {
            meta = data;
          } else if (data.type === "error") {
            throw new Error(data.message || "error");
          }
        }
      }
    } catch (e) {
      clearInterval(timer);
      state.sending = false;
      $("btnSend").hidden = false;
      $("btnStop").hidden = true;
      if (e.name === "AbortError") {
        // user pressed stop: keep partial answer if any
        if (raw.trim()) {
          finishAssistantMessage(live, raw, meta);
        } else {
          live.wrap.remove();
        }
        persistCurrent();
        return;
      }
      live.bubble.innerHTML =
        `<p>⚠️ ${escapeHtml(e.message || "خطایی رخ داد.")}</p>` +
        `<p style="color:var(--text-dim);font-size:12px">موتورهای رایگان شلوغ‌اند؛ چند لحظه بعد دوباره بفرست.</p>`;
      const errMsg = { role: "assistant", content: raw || "⚠️ خطا در دریافت پاسخ.", error: true };
      state.current.messages.push(errMsg);
      persistCurrent();
      return;
    }

    clearInterval(timer);
    state.sending = false;
    $("btnSend").hidden = false;
    $("btnStop").hidden = true;

    if (!raw.trim()) {
      live.bubble.innerHTML = "<p>⚠️ پاسخی دریافت نشد. دوباره تلاش کن.</p>";
      return;
    }
    finishAssistantMessage(live, raw, meta);
  }

  function finishAssistantMessage(live, raw, meta) {
    const m = {
      role: "assistant",
      content: raw,
      provider: meta.provider,
      model: meta.model,
      search: meta.search || null,
    };
    state.current.messages.push(m);
    live.bubble.innerHTML = PFMD.render(raw);
    live.bubble.appendChild(buildMetaEl(m));
    if (meta.provider) {
      const chip = $("engineChip");
      chip.hidden = false;
      chip.textContent = `${meta.provider} · ${meta.model || ""}`;
    }
    if (state.current.mode === "agent") {
      const added = PFAgent.ingestFinal(raw);
      if (added.length) {
        PFAgent.switchTab("preview");
        toast(`${added.length} فایل ساخته/به‌روز شد ✓`);
      }
    }
    persistCurrent();
    scrollBottom(false);
  }

  function regenerate(assistantMsg) {
    if (state.sending) return;
    const msgs = state.current.messages;
    const idx = msgs.indexOf(assistantMsg);
    if (idx < 0) return;
    // find the user message that produced this answer
    let uIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { uIdx = i; break; }
    }
    if (uIdx < 0) return;
    const userText = msgs[uIdx].content;
    msgs.splice(uIdx); // drop that user message and everything after it
    renderMessages();
    send(userText);
  }

  /* ================================================== input */
  function autoGrow() {
    const el = $("input");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }
  function updateSendBtn() {
    $("btnSend").disabled = !$("input").value.trim() || state.sending;
  }

  /* ================================================== drawer */
  function renderSessionList() {
    const list = $("sessionList");
    list.innerHTML = "";
    state.sessions.forEach((s) => {
      const b = document.createElement("button");
      b.className =
        "session-item" + (state.current && state.current.id === s.id ? " active" : "");
      b.innerHTML =
        `<span class="s-mode">${s.mode === "agent" ? "عامل" : "چت"}</span>` +
        `<span class="s-title">${escapeHtml(s.title)}</span>` +
        `<span class="s-del" title="حذف">🗑</span>`;
      b.onclick = () => openSession(s.id);
      b.querySelector(".s-del").onclick = (ev) => deleteSession(s.id, ev);
      list.appendChild(b);
    });
    if (!state.sessions.length) {
      list.innerHTML =
        '<p style="color:var(--text-faint);font-size:12px;text-align:center;padding:20px">هنوز گفتگویی نداری.</p>';
    }
  }
  function openDrawer() {
    renderSessionList();
    $("drawer").classList.add("open");
    $("drawerBackdrop").classList.add("show");
  }
  function closeDrawer() {
    $("drawer").classList.remove("open");
    $("drawerBackdrop").classList.remove("show");
  }

  /* ================================================== misc */
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._tm);
    t._tm = setTimeout(() => (t.hidden = true), 2400);
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ================================================== init */
  document.addEventListener("DOMContentLoaded", () => {
    loadSessions();
    newSession("chat");

    $("btnModeChat").onclick = () => {
      setMode("chat");
      if (!state.current || state.current.messages.length) newSession("chat");
    };
    $("btnModeAgent").onclick = () => {
      setMode("agent");
      if (!state.current || state.current.messages.length) newSession("agent");
      toast("حالت عامل کدنویس فعال شد — برنامه‌ات را توصیف کن 🤖");
    };
    $("btnNew").onclick = () => newSession(state.mode);
    $("btnSessions").onclick = openDrawer;
    $("btnCloseDrawer").onclick = closeDrawer;
    $("drawerBackdrop").onclick = closeDrawer;
    $("btnClear").onclick = clearCurrent;

    $("btnSearch").onclick = () => {
      state.searchOn = !state.searchOn;
      $("btnSearch").classList.toggle("on", state.searchOn);
      $("btnSearch").setAttribute("aria-pressed", state.searchOn);
      toast(state.searchOn ? "جستجوی وب روشن شد 🌐" : "جستجوی وب خاموش شد");
    };

    const input = $("input");
    input.addEventListener("input", () => {
      autoGrow();
      updateSendBtn();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(input.value);
      }
    });
    $("btnSend").onclick = () => send(input.value);
    $("btnStop").onclick = () => state.abort && state.abort.abort();

    // hero suggestion cards
    document.querySelectorAll(".hero-card").forEach((card) => {
      card.onclick = () => {
        const mode = card.dataset.try;
        if (mode === "agent") setMode("agent");
        if (mode === "search" && !state.searchOn) $("btnSearch").click();
        if (mode === "search") setMode("chat");
        newSession(state.mode);
        input.value = card.dataset.prompt;
        autoGrow();
        updateSendBtn();
        send(input.value);
      };
    });

    // delegated copy buttons inside markdown
    messagesEl().addEventListener("click", (e) => {
      const btn = e.target.closest(".copy-btn");
      if (!btn) return;
      const code = btn.closest("pre").querySelector(".code-body");
      navigator.clipboard
        .writeText(code.innerText)
        .then(() => {
          btn.textContent = "کپی شد ✓";
          setTimeout(() => (btn.textContent = "کپی"), 1600);
        });
    });
  });

  return { toast, send };
})();
