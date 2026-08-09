/* Professor Flash V1 - frontend logic */
(function () {
  "use strict";

  var els = {
    chatLog: document.getElementById("chatLog"),
    input: document.getElementById("input"),
    btnSend: document.getElementById("btnSend"),
    workPane: document.getElementById("workPane"),
    layout: document.getElementById("layout"),
    btnPane: document.getElementById("btnPane"),
    workTitle: document.getElementById("workTitle"),
    workState: document.getElementById("workState"),
    todoList: document.getElementById("todoList"),
    logList: document.getElementById("logList"),
    fileList: document.getElementById("fileList"),
    previewZone: document.getElementById("previewZone"),
    previewFrame: document.getElementById("previewFrame"),
    previewTitle: document.getElementById("previewTitle"),
    btnOpenPreview: document.getElementById("btnOpenPreview"),
    btnClosePreview: document.getElementById("btnClosePreview"),
    btnPause: document.getElementById("btnPause"),
    btnResume: document.getElementById("btnResume"),
    btnStop: document.getElementById("btnStop"),
    badgeText: document.getElementById("badgeText"),
    toast: document.getElementById("toast"),
  };

  var taskId = null;
  var pollTimer = null;
  var busy = false;
  var shownLogCount = 0;
  var currentProjectName = null;
  var currentPreview = null;

  /* ---------------------------------------------------------- helpers */
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function renderMarkdown(text) {
    var out = "";
    var parts = text.split(/```/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out += "<pre>" + esc(parts[i]) + "</pre>";
      } else {
        out += esc(parts[i])
          .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\n/g, "<br>");
      }
    }
    return out;
  }

  function addMessage(role, text) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + role;
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderMarkdown(text);
    wrap.appendChild(bubble);
    els.chatLog.appendChild(wrap);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    return wrap;
  }

  function addTyping() {
    var wrap = document.createElement("div");
    wrap.className = "msg ai";
    wrap.id = "typing";
    var b = document.createElement("div");
    b.className = "bubble typing";
    for (var i = 0; i < 3; i++) {
      var t = document.createElement("span");
      t.className = "tick";
      b.appendChild(t);
    }
    wrap.appendChild(b);
    els.chatLog.appendChild(wrap);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function removeTyping() {
    var t = document.getElementById("typing");
    if (t) t.remove();
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { els.toast.hidden = true; }, 2600);
  }

  /* ------------------------------------------------------- work pane */
  function setBusy(state) {
    busy = state;
    els.btnSend.disabled = state;
    els.btnPause.classList.toggle("hidden", !state);
    els.btnStop.classList.toggle("hidden", !state);
    els.btnResume.classList.toggle("hidden", !(state && els.workState.classList.contains("paused")));
  }

  function setWorkState(label, cls) {
    els.workState.textContent = label;
    els.workState.className = "work-state" + (cls ? " " + cls : "");
    els.btnResume.classList.toggle("hidden", !(busy && cls === "paused"));
  }

  function openWorkPane(title) {
    els.workPane.hidden = false;
    els.layout.classList.add("has-work");
    if (title) els.workTitle.textContent = title;
  }

  function openPreview(url, name) {
    currentPreview = url;
    currentProjectName = name || "پروژه";
    els.previewZone.hidden = false;
    els.layout.classList.add("has-preview");
    els.previewTitle.textContent = "پیش‌نمایش: " + (name || "پروژه");
    els.previewFrame.src = url;
  }

  els.btnClosePreview.addEventListener("click", function () {
    els.previewZone.hidden = true;
    els.layout.classList.remove("has-preview");
    els.previewFrame.src = "about:blank";
  });

  els.btnOpenPreview.addEventListener("click", function () {
    if (currentPreview) window.open(currentPreview, "_blank");
  });

  els.btnPane.addEventListener("click", function () {
    if (els.workPane.hidden) {
      openWorkPane("محیط کار");
    } else {
      els.workPane.hidden = true;
      els.layout.classList.remove("has-work");
    }
  });

  /* tabs */
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var name = tab.getAttribute("data-tab");
      ["todo", "log", "files"].forEach(function (n) {
        document.getElementById("tab-" + n).classList.toggle("hidden", n !== name);
      });
    });
  });

  /* ---------------------------------------------------------- todos */
  function renderTodos(todos) {
    els.todoList.innerHTML = "";
    todos.forEach(function (todo, idx) {
      var li = document.createElement("li");
      li.className = todo.done ? "done" : "";
      var check = document.createElement("span");
      check.className = "check";
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';
      var txt = document.createElement("span");
      txt.textContent = (idx + 1) + ". " + todo.text;
      li.appendChild(check);
      li.appendChild(txt);
      els.todoList.appendChild(li);
    });
    if (!todos.length) {
      var li = document.createElement("li");
      li.textContent = "هنوز وظیفه‌ای تعریف نشده";
      li.style.opacity = "0.6";
      els.todoList.appendChild(li);
    }
  }

  /* ---------------------------------------------------------- logs */
  var LV_FA = { info: "نکته", ok: "تأیید", skip: "رد شد", warn: "هشدار", error: "خطا" };

  function renderLogs(logs) {
    for (var i = shownLogCount; i < logs.length; i++) {
      var l = logs[i];
      var div = document.createElement("div");
      div.className = "log-line";
      var lv = document.createElement("span");
      lv.className = "lv " + (LV_FA[l.level] ? l.level : "info");
      lv.textContent = LV_FA[l.level] || "نکته";
      var txt = document.createElement("span");
      txt.className = "txt";
      txt.innerHTML = esc(l.text);
      div.appendChild(lv);
      div.appendChild(txt);
      els.logList.appendChild(div);
    }
    shownLogCount = logs.length;
    var logTab = document.getElementById("tab-log");
    if (!logTab.classList.contains("hidden")) {
      logTab.scrollTop = logTab.scrollHeight;
    }
  }

  /* ---------------------------------------------------------- files */
  function renderFiles(files) {
    els.fileList.innerHTML = "";
    if (!files.length) {
      var li = document.createElement("li");
      li.textContent = "فایلی ساخته نشده";
      li.style.opacity = "0.6";
      els.fileList.appendChild(li);
      return;
    }
    files.forEach(function (f) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.className = "fname";
      name.textContent = f.path;
      var size = document.createElement("span");
      size.className = "fsize";
      size.textContent = f.size + " بایت";
      li.appendChild(name);
      li.appendChild(size);
      els.fileList.appendChild(li);
    });
  }

  /* ------------------------------------------------------ task poll */
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function pollTask() {
    fetch("/api/task/" + taskId)
      .then(function (r) { return r.json(); })
      .then(function (state) {
        renderTodos(state.todos);
        renderLogs(state.logs);
        renderFiles(state.files);

        if (state.status === "running") {
          setWorkState("در حال انجام", "busy");
        } else if (state.status === "paused") {
          setWorkState("توقف موقت", "paused");
        } else {
          stopPolling();
          finishTask(state);
        }
      })
      .catch(function () { stopPolling(); setBusy(false); });
  }

  function finishTask(state) {
    setBusy(false);
    removeTyping();

    if (state.status === "done") {
      setWorkState("انجام شد", "done");
      if (state.reply) addMessage("ai", state.reply);
      if (state.preview) {
        var name = state.reply ? extractProjectName(state.reply) : null;
        openPreview(state.preview, name);
      }
      showToast("پروژه ساخته و تست شد");
    } else if (state.status === "stopped") {
      setWorkState("متوقف شد", null);
      if (state.reply) addMessage("ai", state.reply);
      showToast("توقف کامل فعال شد");
    } else if (state.status === "error") {
      setWorkState("خطا", "error");
      addMessage("ai", "خطایی پیش آمد: " + (state.error || "ناشناخته"));
      showToast("خطا در پردازش");
    }

    // keep work pane open showing results; allow closing via button
  }

  function extractProjectName(reply) {
    var m = reply.match(/پروژه «([^»]+)»/);
    return m ? m[1] : null;
  }

  /* ----------------------------------------------------------- send */
  function send() {
    var text = els.input.value.trim();
    if (!text || busy) return;
    els.input.value = "";
    autoGrow();
    addMessage("user", text);
    addTyping();

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.taskId) {
          taskId = data.taskId;
          shownLogCount = 0;
          setBusy(true);
          setWorkState("در حال انجام", "busy");
          openWorkPane("محیط کار");
          pollTask();
          pollTimer = setInterval(pollTask, 350);
        } else if (data.error) {
          removeTyping();
          addMessage("ai", "خطا: " + data.error);
        }
      })
      .catch(function () {
        removeTyping();
        setBusy(false);
        addMessage("ai", "نتوانستم به سرور وصل شوم. مطمئن شو run.py در حال اجراست.");
      });
  }

  els.btnSend.addEventListener("click", send);

  els.input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function autoGrow() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 170) + "px";
  }
  els.input.addEventListener("input", autoGrow);

  /* ------------------------------------------------------ controls */
  els.btnPause.addEventListener("click", function () {
    if (!taskId) return;
    fetch("/api/task/" + taskId + "/pause", { method: "POST" });
    setWorkState("توقف موقت", "paused");
  });

  els.btnResume.addEventListener("click", function () {
    if (!taskId) return;
    fetch("/api/task/" + taskId + "/resume", { method: "POST" });
    setWorkState("در حال انجام", "busy");
  });

  els.btnStop.addEventListener("click", function () {
    if (!taskId) return;
    fetch("/api/task/" + taskId + "/stop", { method: "POST" });
    setWorkState("در حال توقف", null);
  });

  /* ----------------------------------------------------------- init */
  function init() {
    // welcome message
    fetch("/api/model")
      .then(function (r) { return r.json(); })
      .then(function (m) {
        if (m.node) {
          els.badgeText.textContent = "آفلاین · رایگان · Node آماده";
        }
        var welcome;
        if (m.currentProject) {
          welcome =
            "سلام! من Professor Flash V1 هستم؛ دستیار ساخت برنامه (آفلاین و رایگان).\n" +
            "پروژه قبلی «" + m.currentProject.name + "» آماده است؛ می‌توانی آن را تغییر بدهی یا پروژه جدیدی بسازی.";
          currentPreview = m.currentProject.preview;
          openPreview(currentPreview, m.currentProject.name);
        } else {
          welcome =
            "سلام! من Professor Flash V1 هستم؛ دستیار ساخت برنامه (آفلاین و رایگان).\n" +
            "کافی است بگویی چه برنامه‌ای می‌خواهی؛ مثلا «یک ماشین حساب بساز» یا «یک بازی مار با تم سایبرپانکی بساز».";
        }
        addMessage("ai", welcome);
      })
      .catch(function () {
        addMessage("ai", "سلام! من Professor Flash هستم. سرویس در حال راه‌اندازی است؛ کمی صبر کن.");
      });
  }

  init();
})();
