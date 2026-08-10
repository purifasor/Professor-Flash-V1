# -*- coding: utf-8 -*-
"""Professor Flash - on-demand bundled brain (llama-server) manager.

The heavy offline model (Aya-Expanse 8B, ~5 GB) is loaded ONLY while a
task actually needs it. When the app is idle the model is NOT in memory
at all - this is the answer to "the app eats all my RAM":

  * `ensure()`  - starts llama-server lazily on the first deep request
                  (loads in ~2 s thanks to mmap) and waits for it to answer
  * `is_running()` - cheap liveness probe (process or HTTP, cached)
  * `touch()`   - marks "used just now" so the idle timer stays quiet
  * idle monitor - stops the server after `IDLE_SECONDS` without any use,
                  releasing all RAM back to the OS
  * pid file    - runtime/llama.pid so run.py can clean up orphans that
                  survive a hard crash

The server is started with a small context (2048) and a modest number of
threads, so it stays light on weak laptops without a discrete GPU.
"""

import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXE = os.path.join(PROJECT_DIR, "engine", "llama", "llama-server.exe")
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
RUNTIME_DIR = os.path.join(PROJECT_DIR, "runtime")
PID_FILE = os.path.join(RUNTIME_DIR, "llama.pid")
PORT = 8081
BASE_URL = f"http://127.0.0.1:{PORT}"
CHAT_URL = f"{BASE_URL}/v1/chat/completions"
IDLE_SECONDS = 300      # stop the brain after 5 minutes without any use
LOAD_TIMEOUT = 120      # how long ensure() may wait for the model to load

_lock = threading.Lock()
_state = {
    "proc": None,
    "pid": None,
    "model": None,
    "last_used": 0.0,
    "running_cache": None,
    "running_at": 0.0,
    "starting": False,
}


def model_file():
    """The largest complete .gguf in models/ (a still-downloading file is
    skipped: partial files are younger than 60s or smaller than 50 MB)."""
    if not os.path.isdir(MODELS_DIR):
        return None
    best = None
    for f in os.listdir(MODELS_DIR):
        if not f.endswith(".gguf"):
            continue
        p = os.path.join(MODELS_DIR, f)
        try:
            size = os.path.getsize(p)
            mtime = os.path.getmtime(p)
        except OSError:
            continue
        if size < 50 * 1024 * 1024 or time.time() - mtime < 60:
            continue  # still downloading / partial
        if best is None or size > best[1]:
            best = (p, size)
    return best[0] if best else None


def _pid_on_port(port):
    """Find the PID listening on a TCP port (Windows netstat)."""
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=10
        ).stdout
        for line in out.splitlines():
            m = re.search(rf"127\.0\.0\.1:{port}\s+\S+\s+LISTENING\s+(\d+)", line)
            if m:
                return int(m.group(1))
    except Exception:
        pass
    return None


def _pid_alive(pid):
    if not pid:
        return False
    try:
        r = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True, timeout=10
        )
        return str(pid) in r.stdout
    except Exception:
        return True


def _http_alive():
    """Cheap cached HTTP probe of the bundled brain (5 s TTL)."""
    now = time.monotonic()
    if _state["running_cache"] is not None and now - _state["running_at"] < 5:
        return _state["running_cache"]
    ok = False
    try:
        with urllib.request.urlopen(BASE_URL + "/v1/models", timeout=1.5):
            ok = True
    except Exception:
        ok = False
    _state["running_cache"] = ok
    _state["running_at"] = now
    return ok


def is_running():
    """True when the brain is up (our child, a pid-file orphan, or an HTTP
    responder - the last case lets a second app instance adopt it)."""
    proc = _state.get("proc")
    if proc is not None and proc.poll() is None:
        return True
    if _state.get("pid") and _pid_alive(_state["pid"]):
        return True
    return _http_alive()


def _write_pidfile(pid):
    try:
        os.makedirs(RUNTIME_DIR, exist_ok=True)
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(pid))
    except Exception:
        pass


def _clear_pidfile():
    try:
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    except Exception:
        pass


def ensure(timeout=LOAD_TIMEOUT):
    """Make sure the bundled brain is running. Returns the chat URL or None.

    Fast no-ops: already running, or no model file on disk. The heavy model
    is loaded lazily - nothing is in RAM while the app is idle.
    """
    if is_running():
        touch()
        return CHAT_URL
    model = model_file()
    if not model or not os.path.exists(EXE):
        return None
    with _lock:
        if is_running():
            touch()
            return CHAT_URL
        _state["starting"] = True
        try:
            cores = os.cpu_count() or 4
            threads = max(2, min(cores, 6))
            cmd = [
                EXE, "-m", model,
                "-c", "4096",                     # room for whole multi-file builds
                "--host", "127.0.0.1", "--port", str(PORT),
                "-t", str(threads),               # modest threads on weak CPUs
                "--parallel", "1",
                "--no-webui",
            ]
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            proc = subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=flags,
            )
            _state["proc"] = proc
            _state["pid"] = proc.pid
            _state["model"] = os.path.basename(model)
            _state["running_cache"] = None
            _write_pidfile(proc.pid)
        except Exception:
            _state["starting"] = False
            return None

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if _state["proc"].poll() is not None:
                _state["proc"] = None
                _state["pid"] = None
                _state["starting"] = False
                _clear_pidfile()
                return None
            if _http_alive():
                _state["starting"] = False
                touch()
                return CHAT_URL
            time.sleep(0.5)
        # took too long - give up and clean up
        stop()
        _state["starting"] = False
        return None


def touch():
    _state["last_used"] = time.monotonic()


def _idle_monitor():
    while True:
        time.sleep(20)
        try:
            if is_running() and time.monotonic() - _state["last_used"] > IDLE_SECONDS:
                stop()
        except Exception:
            pass


def stop():
    """Stop the bundled brain and free its RAM. Kills our child, then any
    orphan still listening on the port (from a crashed run)."""
    with _lock:
        proc = _state.get("proc")
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=6)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        _state["proc"] = None
        _state["pid"] = None
        _state["running_cache"] = None

        # orphan cleanup: kill whatever is still serving the port
        pid = _pid_on_port(PORT)
        if pid:
            try:
                subprocess.run(
                    ["taskkill", "/F", "/PID", str(pid)],
                    capture_output=True, timeout=10,
                )
            except Exception:
                pass
        _clear_pidfile()


def stop_orphans():
    """Kill leftover brain processes from previous runs (pid file / port)."""
    pid = None
    try:
        if os.path.exists(PID_FILE):
            with open(PID_FILE, "r", encoding="utf-8") as f:
                pid = int(f.read().strip() or 0)
    except Exception:
        pid = None
    if pid and _pid_alive(pid):
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
        except Exception:
            pass
    _clear_pidfile()
    port_pid = _pid_on_port(PORT)
    if port_pid and port_pid != (os.getpid() if False else None):
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(port_pid)], capture_output=True, timeout=10)
        except Exception:
            pass


def status():
    return {
        "running": is_running(),
        "model": _state.get("model"),
        "port": PORT,
        "url": BASE_URL,
    }


threading.Thread(target=_idle_monitor, daemon=True).start()
