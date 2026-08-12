/* Professor Flash V1 - client (chat + agent pages) */

const PAGE = document.body.dataset.page || "chat";
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  taskId: null,
  pollTimer: null,
  busy: false,
  todoShown: false,
  agent: null, // {path, name}
};

/* ------------------------------------------------- client identity + local history
   Every browser (client) gets its own stable id (cookie `pf_client`), and ALL
   chat history lives in that browser's localStorage keyed by the client id -
   so each user's chats are private and never mix with other users' chats.
   The server never stores conversations: it only receives the recent context
   with each request and forgets it. */
function getCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 864e5);
  document.cookie = name + "=" + encodeURIComponent(value) + "; path=/; expires=" + d.toUTCString() + "; SameSite=Lax";
}

function clientId() {
  let id = getCookie("pf_client") || localStorage.getItem("pf_client");
  if (!id) {
    id = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    setCookie("pf_client", id, 365);
    try { localStorage.setItem("pf_client", id); } catch (e) { /* private mode */ }
  }
  return id;
}

const LS_KEY = () => "pf_sessions_" + clientId();

function lsLoad() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY()) || "{}");
  } catch (e) {
    return {};
  }
}

function lsSave(d) {
  try { localStorage.setItem(LS_KEY(), JSON.stringify(d)); } catch (e) { /* full */ }
}

function newSessionObj(mode) {
  return {
    id: "s" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    title: "گفتگوی جدید",
    messages: [],
    updated: Math.floor(Date.now() / 1000),
    mode: mode || "chat",
  };
}

function lsEnsureActive(mode) {
  const d = lsLoad();
  const ok = d.active && (d.sessions || []).some((s) => s.id === d.active);
  if (!ok) {
    const s = newSessionObj(mode);
    d.sessions = d.sessions || [];
    d.sessions.push(s);
    d.active = s.id;
    lsSave(d);
  }
  return lsLoad();
}

function lsFind(sid) {
  return (lsLoad().sessions || []).find((s) => s.id === sid) || null;
}

function lsAppend(sid, role, text) {
  const d = lsLoad();
  const s = (d.sessions || []).find((x) => x.id === sid);
  if (!s) return;
  s.messages = s.messages || [];
  s.messages.push({ role: role, text: String(text), id: "m" + Math.random().toString(36).slice(2, 10), time: Math.floor(Date.now() / 1000) });
  if (role === "user" && s.title === "گفتگوی جدید") {
    s.title = String(text).trim().replace(/\s+/g, " ").slice(0, 40) || s.title;
  }
  s.updated = Math.floor(Date.now() / 1000);
  lsSave(d);
}

function lsContext(sid, n) {
  const s = lsFind(sid);
  if (!s) return [];
  return (s.messages || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-(n || 8))
    .map((m) => ({ role: m.role, text: m.text }));
}

/* ------------------------------------------------------------ helpers */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ------- lightweight markdown for messages: headings, lists, hr, bold,
   inline code - so model answers are structured and easy to read. Everything
   is HTML-escaped first (safe), code fences stay untouched. */
function inlineMd(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return t;
}

function mdToHtml(text) {
  const lines = String(text).split("\n");
  let html = "";
  let listType = null;
  const closeList = () => { if (listType) { html += "</" + listType + ">"; listType = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { closeList(); continue; }
    m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) { closeList(); const lv = m[1].length; html += `<h${lv}>${inlineMd(m[2])}</h${lv}>`; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); html += "<hr>"; continue; }
    m = line.match(/^\s*[-*+]\s+(.*)$/);
    if (m) { if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
    m = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (m) { if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
    // a line that is ONLY bold text (model-style pseudo-heading) becomes a heading
    m = line.match(/^\*\*\s*([^*]+?)\s*\*\*$/);
    if (m) { closeList(); html += `<h4>${inlineMd(m[1])}</h4>`; continue; }
    closeList();
    html += `<p>${inlineMd(line)}</p>`;
  }
  closeList();
  return html;
}

/* Render message text: fenced code blocks (```) become styled <pre> blocks,
   everything else gets the light markdown treatment above. */
function renderContent(text) {
  const parts = String(text).split(/```/);
  if (parts.length === 1) return mdToHtml(text);
  let html = "";
  let codeId = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 0) {
      if (p) html += mdToHtml(p);
    } else {
      let lang = "";
      let code = p;
      const nl = p.indexOf("\n");
      const first = (nl === -1 ? p : p.slice(0, nl)).trim();
      if (first && !/[<>{}()\s]/.test(first)) {
        lang = first;
        code = nl === -1 ? "" : p.slice(nl + 1);
      }
      const id = "code-" + (++codeId) + "-" + Math.random().toString(36).slice(2, 7);
      html += `<div class="code-head">`;
      html += (lang ? `<span class="code-label">${esc(lang)}</span>` : `<span></span>`);
      html += `<button class="code-copy" data-code="${id}" title="کپی فقط کد">${icon("copy")}<span>کپی کد</span></button>`;
      html += `</div>`;
      html += `<pre class="code-block" data-code-body="${id}"><code>${esc(code)}</code></pre>`;
    }
  }
  // cloud build deliveries: [[DOWNLOAD:base64]] -> real zip download button
  html = html.replace(/\[\[DOWNLOAD:([A-Za-z0-9+/=]+)\]\]/g,
    (m, b64) => `<a class="dl-btn" download="project.zip" href="data:application/zip;base64,${b64}">${icon("copy")} دانلود پروژه (ZIP)</a>`);
  return html;
}

async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/* toast notification (always visible, top-center, auto-fade) */
let toastTimer = null;
function showToast(text, ok) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.className = "toast show" + (ok === false ? " err" : "");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, 1600);
}

function timeAgo(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "لحظاتی پیش";
  if (d < 3600) return Math.floor(d / 60) + " دقیقه پیش";
  if (d < 86400) return Math.floor(d / 3600) + " ساعت پیش";
  return Math.floor(d / 86400) + " روز پیش";
}

function icon(name) {
  const icons = {
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-10" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  return icons[name] || "";
}

/* ----------------------------------------------------------- elements */
const chatEl = $("chat");
const heroEl = $("hero");
const sessionsEl = $("sessions");
const inputEl = $("input");
const controlsEl = $("controls");
const taskStateEl = $("taskState");
const taskStatusEl = $("taskStatus");
const cmdEl = $("cmd");

/* -------------------------------------------------------------- model */
async function loadModel() {
  try {
    const r = await fetch("/api/model");
    const m = await r.json();
    const badge = $("brainText");
    const dot = $("brainDot");
    if (m.activeProvider) {
      badge.textContent = "موتور فکری: " + m.activeProvider;
      dot.className = "dot ok";
    } else {
      badge.textContent = "حالت محلی (بدون موتور فکری)";
      dot.className = "dot local";
    }
    if ($("learnedChip")) $("learnedChip").textContent = "یادگیری: " + (m.learnedCount || 0);
    if ($("pathChip") && m.projectsRoot) $("pathChip").textContent = m.projectsRoot;
  } catch (e) { /* offline */ }
}

/* ------------------------------------------------------------ messages */
function avatarHtml(role) {
  if (role === "user") return '<div class="avatar">شما</div>';
  return '<div class="avatar"><img src="/img/logo-128.png" alt="PF"></div>';
}

function addMessage(role, text, mid, animate) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "user" : "bot");
  wrap.dataset.mid = mid || "";
  // copy button on EVERY message - appears above it on hover
  const actions = `<button class="act-copy" title="کپی پیام">${icon("copy")}</button>`;
  wrap.dataset.raw = String(text);
  wrap.innerHTML = `
    ${avatarHtml(role)}
    <div class="bubble">${renderContent(text)}</div>
    <div class="msg-side">${actions}</div>`;
  chatEl.appendChild(wrap);
  if (animate !== false) scrollDown(role === "user");
  return wrap;
}

/* live todo checklist in the chat (ticked off as tasks complete) */
let todoLiveEl = null;
function setTodoLive(todos) {
  if (!todoLiveEl) {
    todoLiveEl = document.createElement("div");
    todoLiveEl.className = "msg bot";
    todoLiveEl.innerHTML = `${avatarHtml("bot")}<div class="bubble todo-live"></div>`;
    chatEl.appendChild(todoLiveEl);
  }
  const box = todoLiveEl.querySelector(".todo-live");
  box.innerHTML = `<div class="todo-title">برنامه کار:</div>` +
    todos.map((t, i) =>
      `<div class="todo-row ${t.done ? "done" : ""}" data-i="${i}"><span class="tick">${icon("check")}</span><span>${esc(t.text)}</span></div>`
    ).join("");
  scrollDown();
}

function clearTodoLive() {
  if (todoLiveEl) { todoLiveEl.remove(); todoLiveEl = null; }
}

function addNote(text) {
  const n = document.createElement("div");
  n.className = "note";
  n.textContent = text;
  chatEl.appendChild(n);
  scrollDown();
  return n;
}

function thinkingBubble() {
  const wrap = document.createElement("div");
  wrap.className = "msg bot";
  wrap.id = "thinking";
  wrap.innerHTML = `
    ${avatarHtml("bot")}
    <div class="bubble thinking">
      <div class="spinner"></div>
      <span class="think-text">در حال تفکر...</span>
    </div>`;
  chatEl.appendChild(wrap);
  scrollDown();
  return wrap;
}

const THINK_MSGS = [
  "در حال تفکر...", "در حال تحلیل...", "در حال جستجو در دانش...", "در حال ساختن پاسخ...",
];
let thinkTick = 0;
function updateThinking() {
  const el = $("thinking");
  if (el) {
    const m = THINK_MSGS[thinkTick % THINK_MSGS.length];
    el.querySelector(".think-text").textContent = m;
    thinkTick++;
  }
}

function removeThinking() {
  const el = $("thinking");
  if (el) el.remove();
}

function nearBottom() {
  const sc = $("chatScroll");
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
}

function scrollDown(force) {
  const sc = $("chatScroll");
  if (force || nearBottom()) sc.scrollTop = sc.scrollHeight;
  $("btnScrollDown").hidden = nearBottom();
}

$("chatScroll").addEventListener("scroll", () => {
  $("btnScrollDown").hidden = nearBottom();
});
$("btnScrollDown").addEventListener("click", () => scrollDown(true));

/* --------------------------------------- wait square (0->100 then morph)
   A crimson square appears IN the chat when a message is sent: a spinning
   ring + the real counter (0-100) driven by the time the server actually
   spends answering. When the reply arrives it bursts and morphs away, so
   the user always knows exactly how far the thinking has progressed. */
let waitTimer = null;

function createWaitSquare() {
  let wrap = $("waitSquareMsg");
  if (wrap) return wrap;
  wrap = document.createElement("div");
  wrap.className = "msg bot wait-msg";
  wrap.id = "waitSquareMsg";
  wrap.innerHTML = `
    ${avatarHtml("bot")}
    <div class="wait-square" id="waitSquare">
      <div class="ws-ring"></div>
      <div class="ws-count"><span id="wsCount">0</span><span class="ws-pct">٪</span></div>
      <span class="ws-phase" id="wsPhase">در حال ارسال درخواست...</span>
    </div>`;
  chatEl.appendChild(wrap);
  scrollDown();
  return wrap;
}

/* the counter is MONOTONIC within one run: real progress events can arrive
   out of order (a retry boost reports a lower stage number than a reply that
   already arrived), so the displayed percent only ever goes up - it never
   resets or jumps back to «برقراری اتصال». It resets only on a new send. */
let dispPct = 0;
function setProgress(pct, phase) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  if (p < dispPct && p !== 100) return; // ignore stale/lower events
  dispPct = p;
  const cnt = $("wsCount");
  if (cnt) cnt.textContent = p;
  const sq = $("waitSquare");
  if (sq) sq.style.setProperty("--p", p);
  const ph = $("wsPhase");
  if (ph && phase) ph.textContent = phase;
}

/* burst: the square scales up into a glow and morphs away - the moment the
   real answer bubble rises in right behind it */
function hideProgress(burst) {
  if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
  const wrap = $("waitSquareMsg");
  if (wrap) {
    const sq = $("waitSquare");
    if (sq && burst) sq.classList.add("burst");
    setTimeout(() => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, burst ? 620 : 10);
  }
}

/* the counter is tied to REAL server activity only: it starts at 0 and moves
   exclusively on real progress events streamed by /api/chat - never on a fake
   timer. It reaches 100 only when the answer arrives. */
let lastLogLen = 0;
function startWaiting() {
  createWaitSquare();
  lastLogLen = 0;
  dispPct = 0;
  setProgress(0, "در حال برقراری ارتباط با موتور فکری...");
}

/* ------------------------------------------------------------- sandbox */
function setTaskStatus(status) {
  if (!taskStatusEl) return;
  taskStatusEl.textContent =
    status === "running" ? "در حال اجرا" :
    status === "queued" ? "در صف" :
    status === "paused" ? "متوقف موقت" :
    status === "done" ? "انجام شد" :
    status === "stopped" ? "متوقف شد" :
    status === "error" ? "خطا" : "آماده";
  taskStatusEl.className = "task-status " +
    (status === "running" ? "run" : status === "done" ? "done" :
     status === "error" ? "err" : status === "queued" || status === "paused" ? "queued" : "");
}

/* CMD console - shows what the agent is doing, errors and problems.
   Per-task log counter tracks how many lines of THIS task were rendered. */
let cmdRendered = 0;
function cmdLine(text, cls) {
  if (!cmdEl) return;
  const el = document.createElement("div");
  el.className = "cmd-line " + (cls || "");
  el.innerHTML = `<span class="cmd-prompt">PF&gt;</span> ${esc(text)}`;
  cmdEl.appendChild(el);
  cmdEl.scrollTop = cmdEl.scrollHeight;
  return el;
}

function renderLogs(logs) {
  if (!cmdEl || !logs) return;
  for (let i = cmdRendered; i < logs.length; i++) {
    const l = logs[i];
    const time = l.time ? new Date(l.time * 1000).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " " : "";
    cmdLine(time + l.text, l.level === "error" ? "err" : l.level === "skip" ? "skip" : "");
    cmdRendered = i + 1;
  }
}

/* ------------------------------------------------------------- polling */
async function pollTask(tid) {
  try {
    const r = await fetch("/api/task/" + tid);
    const t = await r.json();
    if (r.status !== 200) return stopPolling();

    setTaskStatus(t.status);
    renderLogs(t.logs);

    // live todo checklist in the chat (ticked off as steps complete)
    if (t.todos && t.todos.length && state.taskId === tid) {
      state.todoShown = true;
      setTodoLive(t.todos);
      // the loader must stay the LAST message: move it under the todo list
      const th = $("thinking");
      if (th && th.parentNode) th.parentNode.appendChild(th);
      const ws = $("waitSquareMsg");
      if (ws && ws.parentNode) ws.parentNode.appendChild(ws);
    }

    if (t.status === "running" || t.status === "queued" || t.status === "paused") {
      updateThinking();
      controlsEl.hidden = false;
      $("btnPause").disabled = t.status !== "running";
      $("btnResume").disabled = t.status !== "paused";
      taskStateEl.textContent = t.status === "queued" ? "پیام شما در صف است؛ بعد از کار جاری پاسخ می‌دهم" : "";
      // real task progress: builds expose a todo checklist - tick it live;
      // otherwise new server logs are REAL activity, so jump the counter
      if (t.todos && t.todos.length) {
        const done = t.todos.filter((x) => x.done).length;
        setProgress(88 + Math.round(11 * done / t.todos.length), "در حال انجام کارها (" + done + "/" + t.todos.length + ")...");
      } else if (t.logs && t.logs.length > lastLogLen) {
        lastLogLen = t.logs.length;
        const cur = parseInt((($("wsCount") || {}).textContent || "4"), 10) || 4;
        setProgress(Math.min(92, cur + 5), "مدل فکری در حال کار...");
      } else if (t.status === "queued") {
        setProgress(84, "در صف انتظار...");
      }
      state.pollTimer = setTimeout(() => pollTask(tid), 700);
      return;
    }

    // finished - the answer is here: hit 100, burst the square, remove the
    // todo checklist too, then show the reply
    stopPolling(true);
    setProgress(100, "پاسخ آماده شد");
    setTimeout(() => hideProgress(true), 180);
    clearTodoLive();
    removeThinking();
    controlsEl.hidden = true;
    taskStateEl.textContent = "";
    if (t.status === "error") {
      addNote("خطا: " + (t.error || "نامشخص"));
      return;
    }
    if (t.status === "stopped") {
      addNote("کار متوقف شد.");
      if (t.reply) addMessage("assistant", t.reply, null);
      return;
    }
    if (t.reply) {
      // «شلوغ بود» is a rate-limit hiccup, not an answer: retry the SAME
      // message automatically (up to 3 times) so the user never sees a dead end.
      const busy = /شلوغ/.test(t.reply) && t.reply.length < 200 && !/```/.test(t.reply);
      if (busy && (state.autoRetries || 0) < 3) {
        state.autoRetries = (state.autoRetries || 0) + 1;
        stopPolling();
        const txt = state.pendingText;
        addNote("سرویس‌های رایگان شلوغ بودند؛ تلاش مجدد خودکار (" + state.autoRetries + "/3)...");
        setTimeout(() => { state.busy = false; send(txt, true); }, 3500 * state.autoRetries);
        return;
      }
      state.autoRetries = 0;
      addMessage("assistant", t.reply, null);
      lsAppend(state.sessionId, "assistant", t.reply);
    }
    loadModel(); // refresh brain badge + learned count
    refreshSessions(); // refresh sidebar counts (keeps the chat DOM intact)
  } catch (e) {
    stopPolling();
  }
}

// keep delivering answers even if the tab was in the background. Only the
// LEGACY polling path (no streaming) needs this - while a stream is being
// consumed the answer arrives through the stream, so never race it.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.taskId && !state.pollTimer && !state.streaming) {
    pollTask(state.taskId);
  }
});

function stopPolling(keepSquare) {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  state.taskId = null;
  state.streaming = false;
  state.busy = false;
  controlsEl.hidden = true;
  setTaskStatus(null);
  if (!keepSquare) hideProgress(false);
}

/* --------------------------------------------------------------- send */
/* CONNECT-FIRST: the counting square is only shown AFTER the connection to
   the model is established (the server's `start` event). If the server is
   busy/unreachable the user gets a plain note - never a locked counter. The
   counter itself is driven by REAL server progress events, not a fake timer.*/

function streamBusy(reply) {
  return /شلوغ/.test(reply) && reply.length < 200 && !/```/.test(reply);
}

function finishStream(ev, text) {
  state.streaming = false;
  stopPolling(true);
  clearTodoLive();
  removeThinking();
  controlsEl.hidden = true;
  taskStateEl.textContent = "";
  const reply = ev && ev.reply;
  if (ev && ev.todos && ev.todos.length) setTodoLive(ev.todos);
  if (!reply) {
    hideProgress(true);
    addNote("پاسخی دریافت نشد. دوباره تلاش کن.");
    state.busy = false;
    return;
  }
  if (streamBusy(reply) && (state.autoRetries || 0) < 3) {
    state.autoRetries = (state.autoRetries || 0) + 1;
    hideProgress(true);
    addNote("سرویس‌های رایگان شلوغ بودند؛ تلاش مجدد خودکار (" + state.autoRetries + "/3)...");
    setTimeout(() => { state.busy = false; send(text, true); }, 3500 * state.autoRetries);
    return;
  }
  state.autoRetries = 0;
  setProgress(100, "پاسخ آماده شد");
  setTimeout(() => hideProgress(true), 180);
  clearTodoLive();
  addMessage("assistant", reply, null);
  lsAppend(state.sessionId, "assistant", reply);
  loadModel(); // refresh brain badge + learned count
  refreshSessions(); // refresh sidebar counts (keeps the chat DOM intact)
  state.busy = false;
}

async function consumeStream(r, text) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let gotStart = false;
  let doneEvt = null;
  let ev = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.type === "start") {
          gotStart = true;
          state.streaming = true;
          if (ev.taskId) state.taskId = ev.taskId;
          if (ev.sessionId) state.sessionId = ev.sessionId;
          startWaiting(); // connection established - NOW the counter runs
        } else if (ev.type === "progress") {
          setProgress(ev.p, ev.phase);
        } else if (ev.type === "done") {
          doneEvt = ev;
        }
      }
    }
  } catch (e) { /* stream dropped: fall through */ }
  // legacy server that never sent `start`: show the square so the user still
  // sees thinking feedback, then finish with whatever arrived
  if (!gotStart) startWaiting();
  finishStream(doneEvt, text);
}

async function send(text, silentRetry) {
  text = (text || "").trim();
  if (!text || state.busy) return;
  if (PAGE === "agent" && (!state.agent || !state.agent.path)) {
    addNote("اول در تنظیمات Agent مسیر پروژه را مشخص کن و روی «اتصال به پروژه» بزن.");
    return;
  }
  state.busy = true;
  state.pendingText = text;
  state.todoShown = false;
  thinkTick = 0;
  cmdRendered = 0;

  if (!silentRetry) {
    // a sent message opens a NEW page unless we're already on an empty one:
    // refreshing NEVER spawns a page, only a real message does
    const d0 = lsLoad();
    const cur = (d0.sessions || []).find((s) => s.id === d0.active);
    if (cur && (cur.messages || []).length > 0) {
      const s2 = newSessionObj(PAGE);
      d0.sessions = d0.sessions || [];
      d0.sessions.push(s2);
      d0.active = s2.id;
      lsSave(d0);
      state.sessionId = s2.id;
      chatEl.innerHTML = "";
      heroEl.classList.add("show");
      clearTodoLive();
    }
    addMessage("user", text, null);
    lsAppend(state.sessionId, "user", text);
    heroEl.classList.remove("show");
  }
  clearTodoLive();
  setTaskStatus("running");

  // the server never stores chats: it gets this client's recent context with
  // each request and forgets it - history stays private on this machine
  const body = { message: text, sessionId: state.sessionId, clientId: clientId(),
                 history: lsContext(state.sessionId, 8), mode: PAGE, stream: true };
  if (PAGE === "agent") body.project = { path: state.agent.path, name: state.agent.name };

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = "خطا: " + r.status;
      try { msg = "خطا: " + ((await r.json()).error || r.status); } catch (e) { /* keep */ }
      removeThinking();
      hideProgress();
      addNote(msg);
      state.busy = false;
      return;
    }
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("ndjson") || ct.includes("stream")) {
      await consumeStream(r, text);
      return;
    }
    // legacy synchronous fallback (older server): the request already ran,
    // poll the finished task exactly as before
    const data = await r.json();
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    setProgress(90, "در حال دریافت پاسخ...");
    if (data.sessionId) state.sessionId = data.sessionId;
    if (data.control) {
      removeThinking();
      addNote(data.note || "فرمان ثبت شد.");
      state.busy = false;
      return;
    }
    state.taskId = data.taskId;
    pollTask(data.taskId);
  } catch (e) {
    // transient serverless hiccup / cold start: retry once before giving up
    try {
      const r2 = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const ct2 = (r2.headers.get("content-type") || "").toLowerCase();
      if (r2.ok && (ct2.includes("ndjson") || ct2.includes("stream"))) {
        await consumeStream(r2, text);
        return;
      }
      const data2 = await r2.json();
      if (r2.ok && data2.taskId) {
        if (data2.sessionId) state.sessionId = data2.sessionId;
        state.taskId = data2.taskId;
        pollTask(data2.taskId);
        return;
      }
    } catch (e2) { /* give up below */ }
    removeThinking();
    hideProgress();
    addNote("اتصال به سرور برقرار نشد. دوباره تلاش کن.");
    state.busy = false;
  }
}

/* -------------------------------------------------------------- input */
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}

inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const v = inputEl.value;
    inputEl.value = "";
    autoGrow();
    send(v);
  }
});
$("btnSend").addEventListener("click", () => {
  const v = inputEl.value;
  inputEl.value = "";
  autoGrow();
  send(v);
});

/* ---------------------------------------------------- sidebar toggle (hamburger) */
const sidebarEl = $("sidebar");
function toggleSidebar() {
  const app = document.querySelector(".app");
  if (!app) return;
  if (window.innerWidth <= 760) {
    app.classList.toggle("sidebar-open");
  } else {
    app.classList.toggle("sidebar-hidden");
  }
}
const burger = $("btnBurger");
if (burger) burger.addEventListener("click", toggleSidebar);
const backdrop = $("sidebarBackdrop");
if (backdrop) backdrop.addEventListener("click", () => document.querySelector(".app")?.classList.remove("sidebar-open"));
window.addEventListener("resize", () => {
  const app = document.querySelector(".app");
  if (!app) return;
  if (window.innerWidth > 760) app.classList.remove("sidebar-open");
  if (window.innerWidth <= 760) app.classList.remove("sidebar-hidden");
});

/* ------------------------------------------------------------ controls */
$("btnPause").addEventListener("click", () => fetch("/api/task/" + state.taskId + "/pause", { method: "POST" }));
$("btnResume").addEventListener("click", () => fetch("/api/task/" + state.taskId + "/resume", { method: "POST" }));
$("btnStop").addEventListener("click", async () => {
  await fetch("/api/task/" + state.taskId + "/stop", { method: "POST" });
  addNote("فرمان توقف کامل ارسال شد.");
});

/* ----------------------------------------------------------- messages */
chatEl.addEventListener("click", async (e) => {
  const wrap = e.target.closest(".msg");
  if (!wrap) return;

  if (e.target.closest(".code-copy")) {
    const btn = e.target.closest(".code-copy");
    const body = document.querySelector(`pre[data-code-body="${btn.dataset.code}"]`);
    if (body) await copyText(body.textContent);
    showToast("کد کپی شد ✅");
    return;
  }

  // copy the WHOLE message text (the button lives outside the bubble, so it
  // must be handled before any .bubble check)
  if (e.target.closest(".act-copy")) {
    const text = wrap.dataset.raw || "";
    await copyText(text);
    showToast("پیام کپی شد ✅");
    return;
  }
});

/* ------------------------------------------------------------ sessions
   All session data is read/written from this browser's localStorage (keyed
   by the pf_client cookie) - the server stays stateless, so chats of
   different clients are fully isolated and private. */
async function loadSessions() {
  await refreshSessions();
  if (state.sessionId) await loadMessages(state.sessionId);
}

/* refresh only the sidebar list - never touches the chat DOM, so the live
   todo checklist survives task completion */
async function refreshSessions() {
  const d = lsEnsureActive(PAGE);
  state.sessionId = d.active;
  sessionsEl.innerHTML = "";
  (d.sessions || []).forEach((s) => {
    const el = document.createElement("div");
    el.className = "session" + (s.id === d.active ? " active" : "");
    el.innerHTML = `
      <div class="session-title">${esc(s.title)}</div>
      <div class="session-meta">${(s.messages || []).length} پیام · ${timeAgo(s.updated)}</div>
      <button class="session-del" title="حذف گفتگو">${icon("trash")}</button>`;
    el.addEventListener("click", (ev) => {
      if (ev.target.closest(".session-del")) {
        deleteSession(s.id, el);
        return;
      }
      switchSession(s.id);
    });
    sessionsEl.appendChild(el);
  });
}

async function switchSession(sid) {
  if (state.busy) return;
  const d = lsLoad();
  d.active = sid;
  lsSave(d);
  state.sessionId = sid;
  await loadMessages(sid);
  refreshSessions();
}

async function deleteSession(sid, el) {
  if (state.busy) return;
  const d = lsLoad();
  d.sessions = (d.sessions || []).filter((s) => s.id !== sid);
  if (d.active === sid) d.active = d.sessions.length ? d.sessions[d.sessions.length - 1].id : null;
  lsSave(d);
  const nd = lsEnsureActive(PAGE);
  state.sessionId = nd.active;
  await loadMessages(state.sessionId);
  refreshSessions();
}

$("btnNewSession").addEventListener("click", async () => {
  if (state.busy && !state.taskId) return;
  stopPolling();
  const d = lsLoad();
  const s = newSessionObj(PAGE);
  d.sessions = d.sessions || [];
  d.sessions.push(s);
  d.active = s.id;
  lsSave(d);
  state.sessionId = s.id;
  state.todoShown = false;
  chatEl.innerHTML = "";
  heroEl.classList.add("show");
  clearTodoLive();
  if (cmdEl) cmdEl.innerHTML = '<div class="cmd-line boot"><span class="cmd-prompt">PF&gt;</span> Professor Flash V1 — PRF ready. Type anything.</div>';
  setTaskStatus(null);
  await loadSessions();
});

async function loadMessages(sid) {
  const d = lsLoad();
  const s = (d.sessions || []).find((x) => x.id === sid);
  const msgs = s ? s.messages || [] : [];
  chatEl.innerHTML = "";
  msgs.forEach((m) => {
    if (m.kind === "note") { addNote(m.text); return; }
    addMessage(m.role, m.text, m.id, false);
  });
  heroEl.classList.toggle("show", !msgs.length);
  scrollDown();
}

/* -------------------------------------------------- agent tab settings */
async function loadAgentConfig() {
  try {
    const r = await fetch("/api/agent/config");
    const cfg = await r.json();
    state.agent = { path: cfg.path, name: cfg.name, connected: !!cfg.connected };
    if (cfg.connected) {
      showWorkspace();
    } else {
      if ($("projectPath")) $("projectPath").value = cfg.path;
      if ($("projectName")) $("projectName").value = cfg.name || "";
    }
    await loadProjectList();
  } catch (e) { /* offline */ }
}

async function loadProjectList() {
  const box = $("projectList");
  if (!box) return;
  try {
    const r = await fetch("/api/agent/projects");
    const d = await r.json();
    box.innerHTML = "";
    if (!(d.projects || []).length) {
      box.innerHTML = '<div class="note-muted">هنوز پروژه‌ای در این مسیر نیست. مسیر را وارد کن یا پروژه جدید بساز.</div>';
      return;
    }
    (d.projects || []).forEach((p) => {
      const item = document.createElement("div");
      item.className = "project-item" + (p.hasFiles ? "" : " empty");
      item.innerHTML = `<div class="project-item-name">${esc(p.name)}</div>
        <div class="project-item-path" dir="ltr">${esc(p.path)}</div>
        ${p.hasFiles ? '<span class="project-item-badge">دارای فایل</span>' : '<span class="project-item-badge off">خالی</span>'}`;
      item.addEventListener("click", () => {
        if ($("projectPath")) $("projectPath").value = p.path;
        if ($("projectName")) $("projectName").value = p.name;
      });
      box.appendChild(item);
    });
  } catch (e) { /* offline */ }
}

async function connectAgent() {
  const path = ($("projectPath") || {}).value || "";
  const name = ($("projectName") || {}).value || "";
  if (!path.trim()) { addNote("مسیر پروژه را وارد کن."); return; }
  const r = await fetch("/api/agent/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path.trim(), name: name.trim() }),
  });
  const d = await r.json();
  state.agent = { path: d.path, name: d.name, connected: true };
  showWorkspace();
  await loadModel();
  addNote(`به پروژه «${d.name}» متصل شد. مسیر: ${d.path}`);
}

function showWorkspace() {
  if ($("settingsWrap")) $("settingsWrap").hidden = true;
  if ($("workspace")) $("workspace").hidden = false;
  if ($("sandbox")) $("sandbox").hidden = false;
  const chip = $("agentChip");
  if (chip && state.agent) {
    chip.hidden = false;
    chip.textContent = "پروژه: " + state.agent.name + " | " + state.agent.path;
  }
}

/* -------------------------------------------------------------- init */
(async function init() {
  const psAgent = $("psAgent");
  if (psAgent) psAgent.addEventListener("click", () => showToast("قسمت Agent به‌زودی فعال می‌شود"));
  await loadModel();
  if (PAGE === "agent") {
    if ($("btnConnect")) $("btnConnect").addEventListener("click", connectAgent);
    if ($("btnSettingsReset")) $("btnSettingsReset").addEventListener("click", () => {
      if ($("settingsWrap")) $("settingsWrap").hidden = false;
      if ($("workspace")) $("workspace").hidden = true;
      if ($("sandbox")) $("sandbox").hidden = true;
      state.agent = null;
    });
    await loadAgentConfig();
  } else {
    // refresh keeps the SAME chat: reuse the active session (one is only
    // created the very first time). New pages come from real messages only.
    const d = lsEnsureActive(PAGE);
    state.sessionId = d.active;
  }
  await loadSessions();
})();
