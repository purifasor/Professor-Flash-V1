# -*- coding: utf-8 -*-
"""Professor Flash web server.

Endpoints:
  GET  /                         -> UI
  GET  /api/model                -> model info
  POST /api/chat                 -> start a task (async)
  GET  /api/task/<tid>           -> task state
  POST /api/task/<tid>/pause     -> pause after current step
  POST /api/task/<tid>/resume    -> resume
  POST /api/task/<tid>/stop      -> force stop
  GET  /api/projects             -> list built projects
  GET  /preview/<pid>/...        -> serve a built project

The werkzeug access logger is silenced so the console stays clean; the
frontend polls /api/task only while a task is actually running.
"""

import logging
import os
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory, send_file

from .brain.engine import Brain, TaskStopped
from .brain.memory import Memory

logging.getLogger("werkzeug").setLevel(logging.WARNING)
logging.getLogger("flask").setLevel(logging.WARNING)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PROJECTS_DIR = os.path.join(os.path.dirname(BASE_DIR), "projects")
MEMORY_PATH = os.path.join(os.path.dirname(BASE_DIR), "memory.json")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
app.config["JSON_AS_ASCII"] = False

TASKS = {}
TASKS_LOCK = threading.Lock()
CURRENT_TASK = {"id": None}

os.makedirs(PROJECTS_DIR, exist_ok=True)

memory = Memory(MEMORY_PATH)


class Task:
    """A running brain task with pause / stop control."""

    def __init__(self, tid, message):
        self.id = tid
        self.message = message
        self.status = "running"  # running | paused | done | stopped | error
        self.todos = []          # [{text, done}]
        self.logs = []           # [{level, text, time}]
        self.files = []          # [{path, size}]
        self.preview = None
        self.reply = None
        self.error = None
        self._pause_evt = threading.Event()
        self._pause_evt.set()
        self._stop_evt = threading.Event()
        self.thread = None

    # ------------------------------------------------------------ control
    def pause(self):
        if self.status == "running":
            self.status = "paused"
            self._pause_evt.clear()

    def resume(self):
        if self.status == "paused":
            self.status = "running"
            self._pause_evt.set()

    def stop(self):
        self._stop_evt.set()
        self._pause_evt.set()
        if self.status in ("running", "paused"):
            self.status = "stopped"

    # -------------------------------------------------------------- emit
    def emit(self, kind, payload):
        """Called by the brain between steps. Handles pause/stop."""
        if self._stop_evt.is_set():
            raise TaskStopped()
        while not self._pause_evt.is_set():
            if self._stop_evt.is_set():
                raise TaskStopped()
            time.sleep(0.08)

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
            "logs": self.logs[-80:],
            "files": self.files,
            "preview": self.preview,
            "reply": self.reply,
            "error": self.error,
        }


def _run_task(task):
    brain = Brain(memory, PROJECTS_DIR, emit=task.emit)
    try:
        result = brain.think(task.message)
        task.reply = result.get("reply")
        task.preview = result.get("preview")
        if task.status != "stopped":
            task.status = "done"
    except TaskStopped:
        task.status = "stopped"
        task.reply = "توقف کامل فعال شد؛ کار متوقف ماند. اگر بخواهی می‌توانم از اول یا از مرحله بعد ادامه دهم."
    except Exception as exc:  # pragma: no cover - defensive
        logging.getLogger("pf").exception("task failed")
        task.status = "error"
        task.error = str(exc)
        task.reply = "خطایی در پردازش پیش آمد: " + str(exc)


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/model")
def api_model():
    import shutil
    from . import __version__
    node = shutil.which("node") is not None
    proj = memory.current_project
    return jsonify({
        "free": True,
        "name": "Professor Flash V1",
        "offline": True,
        "type": "local-hybrid",
        "version": __version__,
        "node": node,
        "python": True,
        "currentProject": {
            "id": proj["id"], "name": proj["name"], "preview": f"/preview/{proj['id']}/"
        } if proj else None,
    })


@app.route("/api/chat", methods=["POST"])
def api_chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "پیام خالی است"}), 400

    # one active task at a time: stop the previous one gracefully
    with TASKS_LOCK:
        prev = CURRENT_TASK["id"]
        if prev and prev in TASKS and TASKS[prev].status in ("running", "paused"):
            TASKS[prev].stop()
        tid = uuid.uuid4().hex[:10]
        task = Task(tid, message)
        TASKS[tid] = task
        CURRENT_TASK["id"] = tid

    task.thread = threading.Thread(target=_run_task, args=(task,), daemon=True)
    task.thread.start()
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
                out.append({"id": meta.get("id", name), "name": meta.get("name", name), "type": meta.get("type_fa", "")})
            except Exception:
                pass
    return jsonify({"projects": out})


@app.route("/preview/<pid>/")
def preview_index(pid):
    root = os.path.join(PROJECTS_DIR, pid)
    if not os.path.isdir(root):
        return "پروژه پیدا نشد", 404
    return send_from_directory(root, "index.html")


@app.route("/preview/<pid>/<path:rest>")
def preview_file(pid, rest):
    root = os.path.join(PROJECTS_DIR, pid)
    if not os.path.isdir(root):
        return "پروژه پیدا نشد", 404
    try:
        return send_from_directory(root, rest)
    except Exception:
        return "فایل پیدا نشد", 404
