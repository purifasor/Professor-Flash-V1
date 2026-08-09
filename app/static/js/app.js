/* Professor Flash V1 - client */

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  taskId: null,
  pollTimer: null,
  busy: false,
};

/* ------------------------------------------------------------ helpers */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
const logsEl = $("logs");
const todosEl = $("todos");
const filesEl = $("files");
const sessionsEl = $("sessions");
const inputEl = $("input");
const controlsEl = $("controls");
const taskStateEl = $("taskState");
const taskStatusEl = $("taskStatus");

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
    $("learnedChip").textContent = "یادگیری: " + (m.learnedCount || 0);
    if (m.projectsRoot) $("pathChip").textContent = m.projectsRoot;
  } catch (e) { /* offline */ }
}

/* ------------------------------------------------------------ messages */
function addMessage(role, text, mid, animate) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "user" : "bot");
  wrap.dataset.mid = mid || "";
  const actions = mid
    ? `<div class="actions">
         <button class="act-copy" title="کپی">${icon("copy")}</button>
         <button class="act-del" title="حذف">${icon("trash")}</button>
       </div>`
    : "";
  wrap.innerHTML = `
    <div class="avatar">${role === "user" ? "شما" : "PF"}</div>
    <div class="bubble">${esc(text)}${actions}</div>`;
  chatEl.appendChild(wrap);
  if (animate !== false) scrollDown();
  return wrap;
}

function addNote(text) {
  const n = document.createElement("div");
  n.className = "note";
  n.textContent = text;
  chatEl.appendChild(n);
  scrollDown();
  return n;
}

function thinkingBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg bot";
  wrap.id = "thinking";
  wrap.innerHTML = `
    <div class="avatar">PF</div>
    <div class="bubble thinking">
      <div class="dots"><span></span><span></span><span></span></div>
      <span class="think-text">${esc(text || "در حال فکر کردن...")}</span>
    </div>`;
  chatEl.appendChild(wrap);
  scrollDown();
  return wrap;
}

function updateThinking(text) {
  const el = $("thinking");
  if (el) el.querySelector(".think-text").textContent = text || "در حال فکر کردن...";
}

function removeThinking() {
  const el = $("thinking");
  if (el) el.remove();
}

function scrollDown() {
  const sc = $("chatScroll");
  sc.scrollTop = sc.scrollHeight;
}

/* ------------------------------------------------------------- sandbox */
function setTaskStatus(status) {
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

function renderTodos(todos) {
  todosEl.innerHTML = "";
  if (!todos || !todos.length) {
    todosEl.innerHTML = '<div class="empty">هنوز وظیفه‌ای تعریف نشده است.</div>';
    return;
  }
  const firstUndone = todos.findIndex((t) => !t.done);
  todos.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "todo" + (t.done ? " done" : "") + (i === firstUndone ? " now" : "");
    el.innerHTML = `<div class="check">${icon("check")}</div><div>${esc(t.text)}</div>`;
    todosEl.appendChild(el);
  });
}

function renderLogs(logs) {
  if (!logs || !logs.length) {
    logsEl.innerHTML = '<div class="empty">گزارش فعالیت‌ها اینجا نمایش داده می‌شود.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  logs.forEach((l) => {
    const el = document.createElement("div");
    el.className = "log " + (l.level === "error" ? "err" : l.level === "skip" ? "skip" : "");
    const t = new Date(l.time * 1000);
    const ts = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
    el.innerHTML = `<span class="t">${ts}</span>${esc(l.text)}`;
    frag.appendChild(el);
  });
  logsEl.innerHTML = "";
  logsEl.appendChild(frag);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function renderFiles(files) {
  filesEl.innerHTML = "";
  if (!files || !files.length) {
    filesEl.innerHTML = '<div class="empty">فایل‌های ساخته‌شده اینجا نمایش داده می‌شوند.</div>';
    return;
  }
  files.forEach((f) => {
    const el = document.createElement("div");
    el.className = "file";
    el.innerHTML = `<span class="fname">${esc(f.path)}</span><span class="fsize">${Number(f.size).toLocaleString("fa-IR")} B</span>`;
    filesEl.appendChild(el);
  });
}

/* ------------------------------------------------------------- polling */
async function pollTask(tid) {
  try {
    const r = await fetch("/api/task/" + tid);
    const t = await r.json();
    if (r.status !== 200) return stopPolling();

    setTaskStatus(t.status);
    if (t.todos) renderTodos(t.todos);
    if (t.logs) renderLogs(t.logs);
    if (t.files) renderFiles(t.files);

    if (t.status === "running" || t.status === "queued" || t.status === "paused") {
      const pending = (t.todos || []).find((x) => !x.done);
      updateThinking(pending ? pending.text : t.status === "queued" ? "در صف انتظار..." : "در حال فکر کردن...");
      controlsEl.hidden = false;
      $("btnPause").disabled = t.status !== "running";
      $("btnResume").disabled = t.status !== "paused";
      taskStateEl.textContent = t.status === "queued" ? "پیام شما در صف است؛ بعد از کار جاری پاسخ می‌دهم" : "";
      state.pollTimer = setTimeout(() => pollTask(tid), 700);
      return;
    }

    // finished
    stopPolling();
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
    if (t.reply) addMessage("assistant", t.reply, null);
    loadModel(); // refresh brain badge + learned count
    loadSessions(); // refresh sidebar counts
  } catch (e) {
    stopPolling();
  }
}

// keep delivering answers even if the tab was in the background
// (browsers throttle timers in background tabs - re-poll on return)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.taskId && !state.pollTimer) {
    pollTask(state.taskId);
  }
});

function stopPolling() {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  state.taskId = null;
  state.busy = false;
  controlsEl.hidden = true;
  setTaskStatus(null);
}

/* --------------------------------------------------------------- send */
async function send(text) {
  text = (text || "").trim();
  if (!text || state.busy) return;
  state.busy = true;

  addMessage("user", text, null);
  heroEl.classList.remove("show");
  thinkingBubble("در حال فکر کردن...");
  renderTodos([]);
  renderLogs([]);
  renderFiles([]);
  setTaskStatus("running");

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId: state.sessionId }),
    });
    const data = await r.json();
    if (!r.ok) {
      removeThinking();
      addNote("خطا: " + (data.error || "نامشخص"));
      state.busy = false;
      return;
    }
    if (data.sessionId) state.sessionId = data.sessionId;
    if (data.control) {
      removeThinking();
      addNote(data.note || "فرمان ثبت شد.");
      state.busy = false;
      return;
    }
    if (data.status === "queued") {
      addNote(data.note || "پیام در صف قرار گرفت.");
    }
    state.taskId = data.taskId;
    pollTask(data.taskId);
    loadSessions();
  } catch (e) {
    removeThinking();
    addNote("اتصال به سرور برقرار نشد.");
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
$("btnSend").addEventListener("click", () => send(inputEl.value));

/* ------------------------------------------------------------ controls */
$("btnPause").addEventListener("click", () => fetch("/api/task/" + state.taskId + "/pause", { method: "POST" }));
$("btnResume").addEventListener("click", () => fetch("/api/task/" + state.taskId + "/resume", { method: "POST" }));
$("btnStop").addEventListener("click", async () => {
  await fetch("/api/task/" + state.taskId + "/stop", { method: "POST" });
  addNote("فرمان توقف کامل ارسال شد.");
});

/* ----------------------------------------------------------- messages */
chatEl.addEventListener("click", async (e) => {
  const bubble = e.target.closest(".bubble");
  if (!bubble) return;
  const wrap = bubble.closest(".msg");
  const mid = wrap.dataset.mid;
  if (!mid) return;

  if (e.target.closest(".act-copy")) {
    const text = bubble.childNodes[0].textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    addNote("کپی شد.");
    return;
  }
  if (e.target.closest(".act-del")) {
    try {
      await fetch(`/api/history/${state.sessionId}/messages/${mid}/delete`, { method: "POST" });
    } catch (err) { /* ignore */ }
    wrap.remove();
  }
});

/* ------------------------------------------------------------ sessions */
async function loadSessions() {
  try {
    const r = await fetch("/api/history");
    const d = await r.json();
    state.sessionId = d.active;
    sessionsEl.innerHTML = "";
    (d.sessions || []).forEach((s) => {
      const el = document.createElement("div");
      el.className = "session" + (s.active ? " active" : "");
      el.innerHTML = `
        <div class="session-title">${esc(s.title)}</div>
        <div class="session-meta">${s.count} پیام · ${timeAgo(s.updated)}</div>
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
    if (d.active) await loadMessages(d.active);
  } catch (e) { /* offline */ }
}

async function switchSession(sid) {
  if (state.busy) return;
  await fetch("/api/session/" + sid + "/activate", { method: "POST" });
  await loadSessions();
}

async function deleteSession(sid, el) {
  if (state.busy) return;
  await fetch("/api/history/" + sid + "/delete", { method: "POST" });
  await loadSessions();
}

$("btnNewSession").addEventListener("click", async () => {
  if (state.busy && !state.taskId) return;
  stopPolling();
  const r = await fetch("/api/session/new", { method: "POST" });
  const d = await r.json();
  state.sessionId = d.sessionId;
  chatEl.innerHTML = "";
  heroEl.classList.add("show");
  renderTodos([]);
  renderLogs([]);
  renderFiles([]);
  setTaskStatus(null);
  await loadSessions();
});

async function loadMessages(sid) {
  try {
    const r = await fetch("/api/history/" + sid);
    const s = await r.json();
    chatEl.innerHTML = "";
    (s.messages || []).forEach((m) => {
      if (m.kind === "note") { addNote(m.text); return; }
      addMessage(m.role, m.text, m.id, false);
    });
    heroEl.classList.toggle("show", !(s.messages || []).length);
    scrollDown();
  } catch (e) { /* offline */ }
}

/* ---------------------------------------------------------------- tabs */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    ["logs", "todos", "files"].forEach((k) => {
      $("tab-" + k).hidden = k !== tab.dataset.tab;
    });
  });
});

/* -------------------------------------------------------------- chips */
const SUGGESTIONS = [
  "یه بازی مار بساز با تم سایبرپانکی",
  "یک سایت معرفی آب و هوا بساز",
  "سیاهچاله چیه؟",
  "۲۵ × ۴ + ۱۰۰",
  "2x + 3 = 11 چنده؟",
  "نیرو با جرم ۵ و شتاب ۲ چقدره؟",
  "سرچ کن درباره تلسکوپ جیمز وب",
];

function renderChips() {
  const wrap = $("chips");
  SUGGESTIONS.forEach((s) => {
    const b = document.createElement("button");
    b.className = "chip-sug";
    b.textContent = s;
    b.addEventListener("click", () => send(s));
    wrap.appendChild(b);
  });
}

/* -------------------------------------------------------------- init */
(async function init() {
  renderChips();
  await loadModel();
  await loadSessions();
})();
