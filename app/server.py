# -*- coding: utf-8 -*-
"""Professor Flash web server.

Endpoints:
  GET  /                       -> UI
  GET  /api/model              -> model + brain-mode info
  POST /api/chat               -> start a task (or queue it while one runs)
  GET  /api/task/<tid>         -> task state (todos/logs/files live)
  POST /api/task/<tid>/pause|resume|stop
  GET  /api/history            -> sessions list
  GET  /api/history/<sid>      -> session messages
  POST /api/history/<sid>/delete
  POST /api/history/<sid>/messages/<mid>/delete
  POST /api/session/new        -> start a fresh session
  POST /api/session/<sid>/activate
  GET  /api/projects           -> built projects

The werkzeug access logger is silenced so the console stays clean.
"""

import atexit
import json as _json
import logging
import os
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory

from .brain.engine import Brain, TaskStopped
from .brain.llm import Llm
from .brain.memory import Memory
from .brain import brain_server, persian

logging.getLogger("werkzeug").setLevel(logging.WARNING)
logging.getLogger("flask").setLevel(logging.WARNING)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
ROOT_DIR = os.path.dirname(BASE_DIR)
PROJECTS_DIR = os.path.join(ROOT_DIR, "projects")
MEMORY_PATH = os.path.join(ROOT_DIR, "memory.json")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
app.config["JSON_AS_ASCII"] = False

TASKS = {}
TASKS_LOCK = threading.Lock()
CURRENT_TASK = {"id": None}
QUEUE = []  # list of queued Task objects waiting for the active one to finish

os.makedirs(PROJECTS_DIR, exist_ok=True)

memory = Memory(MEMORY_PATH)
llm = Llm()

# the bundled brain is owned by this server: it is loaded on demand and
# unloaded after ~5 idle minutes (see brain_server); make sure it dies with us
atexit.register(brain_server.stop)

from .brain.engine import STOP_WORDS, PAUSE_WORDS, RESUME_WORDS


def _is_control(message, words):
    s = persian.soft(message)
    return any(persian.soft(w) in s for w in words)


def _start_task(task):
    task.started_at = time.time()
    task.last_activity = task.started_at
    task.thread = threading.Thread(target=_run_task, args=(task,), daemon=True)
    task.thread.start()
    brain_server.touch()  # the brain may be needed - keep it alive during tasks


def _run_task(task):
    brain = Brain(memory, PROJECTS_DIR, emit=task.emit, llm=llm,
                  mode=task.mode, agent=task.agent, client_history=task.history)
    try:
        result = brain.think(task.message)
        task.reply = result.get("reply")
        task.project = result.get("project")
        task.root = result.get("root")
        if task.status not in ("stopped", "queued"):
            task.status = "done"
    except TaskStopped:
        task.status = "stopped"
        task.reply = "توقف کامل فعال شد؛ کار متوقف ماند."
    except Exception as exc:  # defensive
        logging.getLogger("pf").exception("task failed")
        task.status = "error"
        task.error = str(exc)
        task.reply = "خطایی در پردازش پیش آمد: " + str(exc)
    finally:
        # persist the assistant message in the conversation (only once) - but
        # only when the client did NOT send its own history (client-side chats
        # stay private in the browser and are never stored by the server)
        if not task.history and task.sid and task.reply and not task.assistant_saved:
            memory.add_message(task.sid, "assistant", task.reply)
            task.assistant_saved = True
        # run the next queued message, if any
        _process_queue()


def _watchdog():
    """Safety net: no task may run forever. A task is force-completed only
    when it is genuinely stuck - running past the hard cap (10 min, enough
    for slow local-brain generations) OR silent for 150s with no progress.
    The local brain streams tokens, so a live generation always refreshes
    last_activity and is never killed mid-thought."""
    while True:
        time.sleep(5)
        now = time.time()
        force = False
        with TASKS_LOCK:
            for t in list(TASKS.values()):
                if t.status == "running" and t.started_at:
                    age = now - t.started_at
                    idle = now - (t.last_activity or t.started_at)
                    if age > 600 or (age > 60 and idle > 150):
                        t._stop_evt.set()
                        t._pause_evt.set()
                        t.status = "done"
                        t.reply = ("پاسخ در زمان مجاز آماده نشد (اینترنت یا مدل محلی در دسترس نبود). "
                                   "دوباره تلاش کن.")
                        if t.sid and not t.assistant_saved:
                            memory.add_message(t.sid, "assistant", t.reply)
                            t.assistant_saved = True
                        force = True
        if force:
            _process_queue()


threading.Thread(target=_watchdog, daemon=True).start()


def _process_queue():
    with TASKS_LOCK:
        while QUEUE:
            nxt = QUEUE.pop(0)
            if nxt.status == "stopped":
                continue
            CURRENT_TASK["id"] = nxt.id
            nxt.status = "running"
            _start_task(nxt)
            return


class Task:
    def __init__(self, tid, message, sid, mode="chat", agent=None, history=None):
        self.id = tid
        self.message = message
        self.sid = sid
        self.mode = mode          # "chat" = text-only page, "agent" = full file builds
        self.agent = agent        # agent settings {path, name}
        self.history = history or []  # recent turns sent by the client (private per-user)
        self.status = "running"  # running | queued | paused | done | stopped | error
        self.todos = []
        self.logs = []
        self.files = []
        self.reply = None
        self.project = None
        self.root = None
        self.error = None
        self.started_at = None
        self.last_activity = None
        self.assistant_saved = False
        self._pause_evt = threading.Event()
        self._pause_evt.set()
        self._stop_evt = threading.Event()
        self.thread = None

    def pause(self):
        if self.status == "running":
            self.status = "paused"
            self._pause_evt.clear()

    def resume(self):
        if self.status == "paused":
            self.status = "running"
            self._pause_evt.set()

    def stop(self):
        import traceback as _tb
        print(f"[dbg] task {self.id} STOP called from {_tb.format_stack()[-2].strip()}", flush=True)
        self._stop_evt.set()
        self._pause_evt.set()
        if self.status in ("running", "paused", "queued"):
            self.status = "stopped"

    def emit(self, kind, payload):
        if self._stop_evt.is_set():
            raise TaskStopped()
        while not self._pause_evt.is_set():
            if self._stop_evt.is_set():
                raise TaskStopped()
            time.sleep(0.08)

        self.last_activity = time.time()

        if kind == "plan":
            self.todos = [{"text": t, "done": False} for t in payload]
        elif kind == "done":
            idx = payload
            if 0 <= idx < len(self.todos):
                self.todos[idx]["done"] = True
        elif kind == "step":
            self.todos.append({"text": payload if isinstance(payload, str) else payload.get("text", ""), "done": False})
        elif kind == "file":
            self.files.append(payload)
        else:  # log
            if isinstance(payload, dict):
                level = payload.get("level", "info")
                text = payload.get("text", "")
            else:
                level, text = "info", str(payload)
            self.logs.append({"level": level, "text": text, "time": time.time()})

    def state_dict(self):
        return {
            "id": self.id,
            "status": self.status,
            "todos": self.todos,
            "logs": self.logs[-120:],
            "files": self.files,
            "reply": self.reply,
            "project": self.project,
            "root": self.root,
            "error": self.error,
        }


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/agent")
def agent_page():
    return send_from_directory(STATIC_DIR, "agent.html")


@app.route("/api/model")
def api_model():
    from . import __version__
    proj = memory.current_project
    return jsonify({
        "free": True,
        "name": "Professor Flash V1",
        "version": __version__,
        "type": "hybrid-agent",
        "providers": llm.status(),
        "activeProvider": llm.active_provider(),
        "learnedCount": _learned_count(),
        "projectsRoot": PROJECTS_DIR,
        "currentProject": {
            "id": proj["id"], "name": proj["name"], "root": proj["root"]
        } if proj else None,
    })


def _learned_count():
    try:
        from .brain import learn as learn_mod
        l = learn_mod.Learn(ROOT_DIR)
        return l.count()
    except Exception:
        return 0


# ------------------------------------------------------------------ chat
@app.route("/api/chat", methods=["POST"])
def api_chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "پیام خالی است"}), 400
    sid = data.get("sessionId") or memory.data.get("active_session")
    mode = data.get("mode") or "chat"
    agent = data.get("project") or None
    # The new frontend keeps chat history in the browser (per-client cookie)
    # and sends the recent turns with every request, so the server never
    # stores or mixes different clients' conversations.
    client_history = data.get("history") or []

    if not client_history:
        memory.add_message(sid, "user", message)

    with TASKS_LOCK:
        current = TASKS.get(CURRENT_TASK["id"])

        # control words act on the running task immediately
        if current and current.status in ("running", "paused", "queued"):
            if _is_control(message, STOP_WORDS):
                current.stop()
                return jsonify({"taskId": current.id, "control": "stop",
                                "note": "توقف کامل فعال شد."})
            if _is_control(message, PAUSE_WORDS):
                current.pause()
                return jsonify({"taskId": current.id, "control": "pause",
                                "note": "توقف موقت فعال شد؛ بعد از اتمام مرحله فعلی می‌ایستد."})
            if _is_control(message, RESUME_WORDS):
                current.resume()
                return jsonify({"taskId": current.id, "control": "resume",
                                "note": "ادامه داده شد."})

        # a task is running -> queue this message (never mix it into the build)
        if current and current.status in ("running", "paused"):
            tid = uuid.uuid4().hex[:10]
            task = Task(tid, message, sid, mode=mode, agent=agent, history=client_history)
            task.status = "queued"
            TASKS[tid] = task
            QUEUE.append(task)
            return jsonify({"taskId": tid, "status": "queued",
                            "note": "در صف قرار گرفت؛ بعد از اتمام کار جاری پاسخ می‌دهم."})

        # start a fresh task
        tid = uuid.uuid4().hex[:10]
        task = Task(tid, message, sid, mode=mode, agent=agent, history=client_history)
        TASKS[tid] = task
        CURRENT_TASK["id"] = tid
        _start_task(task)
        return jsonify({"taskId": tid, "status": "running"})


@app.route("/api/task/<tid>")
def api_task(tid):
    task = TASKS.get(tid)
    if not task:
        return jsonify({"error": "task not found"}), 404
    return jsonify(task.state_dict())


@app.route("/api/task/<tid>/pause", methods=["POST"])
def api_pause(tid):
    task = TASKS.get(tid)
    if task:
        task.pause()
    return jsonify({"ok": True})


@app.route("/api/task/<tid>/resume", methods=["POST"])
def api_resume(tid):
    task = TASKS.get(tid)
    if task:
        task.resume()
    return jsonify({"ok": True})


@app.route("/api/task/<tid>/stop", methods=["POST"])
def api_stop(tid):
    task = TASKS.get(tid)
    if task:
        task.stop()
    return jsonify({"ok": True})


# --------------------------------------------------------------- history
@app.route("/api/history")
def api_history():
    sessions = []
    for s in memory.sessions():
        sessions.append({
            "id": s["id"],
            "title": s["title"],
            "updated": s["updated"],
            "count": len(s["messages"]),
            "active": s["id"] == memory.data.get("active_session"),
        })
    return jsonify({"sessions": sessions, "active": memory.data.get("active_session")})


@app.route("/api/history/<sid>")
def api_history_sid(sid):
    s = memory.get_session(sid)
    if not s:
        return jsonify({"error": "session not found"}), 404
    return jsonify({"id": s["id"], "title": s["title"], "messages": s["messages"]})


@app.route("/api/history/<sid>/delete", methods=["POST"])
def api_history_delete(sid):
    memory.delete_session(sid)
    return jsonify({"ok": True})


@app.route("/api/history/<sid>/messages/<mid>/delete", methods=["POST"])
def api_message_delete(sid, mid):
    ok = memory.delete_message(sid, mid)
    return jsonify({"ok": ok})


@app.route("/api/session/new", methods=["POST"])
def api_session_new():
    # a fresh chat must not keep waiting behind the previous chat's task -
    # but only tasks from the SAME page (chat vs agent) are stopped, so
    # loading the chat page never kills an agent build that is running.
    data = request.get_json(silent=True) or {}
    scope = data.get("mode") or "chat"
    with TASKS_LOCK:
        current = TASKS.get(CURRENT_TASK["id"])
        if current and current.status in ("running", "paused", "queued") and current.mode == scope:
            current.stop()
        kept = []
        while QUEUE:
            q = QUEUE.pop(0)
            if q.mode == scope:
                q.stop()
            else:
                kept.append(q)
        QUEUE[:] = kept
        if current and current.mode == scope:
            CURRENT_TASK["id"] = None
    sid = memory.new_session()
    return jsonify({"sessionId": sid})


@app.route("/api/session/<sid>/activate", methods=["POST"])
def api_session_activate(sid):
    ok = memory.set_active_session(sid)
    return jsonify({"ok": ok})


# ---------------------------------------------------------- agent config
# The Agent tab has its own settings: project path + project name. When the
# path points at an existing project the name is auto-detected from the
# folder. These settings persist in memory.json so they survive restarts.

DEFAULT_AGENT_ROOT = PROJECTS_DIR


def _normalize_path(p):
    p = (p or "").strip()
    if not p:
        return DEFAULT_AGENT_ROOT
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(os.path.dirname(PROJECTS_DIR), p)
    return os.path.abspath(p)


@app.route("/api/agent/config")
def api_agent_config():
    cfg = memory.agent_config
    path = _normalize_path(cfg.get("path"))
    name = (cfg.get("name") or "").strip()
    if not name:
        name = os.path.basename(path.rstrip("\\/")) if path not in (PROJECTS_DIR, DEFAULT_AGENT_ROOT) else ""
    return jsonify({
        "path": path,
        "name": name,
        "exists": os.path.isdir(path),
        "connected": bool(cfg.get("path")),
    })


@app.route("/api/agent/config", methods=["POST"])
def api_agent_config_set():
    data = request.get_json(silent=True) or {}
    path = _normalize_path(data.get("path"))
    name = (data.get("name") or "").strip()
    if not name:
        # auto-detect the project name from the folder when reusing one
        name = os.path.basename(path.rstrip("\\/"))
    os.makedirs(path, exist_ok=True)
    memory.set_agent_config({"path": path, "name": name})
    return jsonify({"path": path, "name": name, "exists": True})


@app.route("/api/agent/projects")
def api_agent_projects():
    """List project folders under the configured root so the user can pick
    an existing one (name is auto-detected from the folder)."""
    cfg = memory.agent_config
    root = _normalize_path(cfg.get("path"))
    out = []
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            full = os.path.join(root, name)
            if not os.path.isdir(full) or name.startswith("."):
                continue
            has_files = any(os.path.isfile(os.path.join(full, f))
                            for f in ("index.html", "style.css", "app.js", "main.py"))
            out.append({"name": name, "path": full, "hasFiles": has_files})
    return jsonify({"projects": out, "root": root})


# -------------------------------------------------------------- projects
@app.route("/api/projects")
def api_projects():
    out = []
    for name in sorted(os.listdir(PROJECTS_DIR)):
        meta_path = os.path.join(PROJECTS_DIR, name, "meta.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    import json as _json
                    meta = _json.load(f)
                out.append({"id": meta.get("id", name), "name": meta.get("name", name),
                            "type": meta.get("type_fa", ""), "root": os.path.join(PROJECTS_DIR, name)})
            except Exception:
                pass
    return jsonify({"projects": out})
