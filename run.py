#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Professor Flash V1 - AI App Builder (Offline)

Run:  python run.py

This script:
  1. detects the OS / Python
  2. creates a virtual environment if missing
  3. installs any missing packages (requirements.txt)
  4. detects Node.js and Ollama (optional accelerators)
  5. starts the local web server
  6. opens the default browser
"""

import os
import shutil
import socket
import subprocess
import sys
import threading
import time

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_DIR = os.path.join(PROJECT_DIR, ".venv")
REQUIREMENTS = os.path.join(PROJECT_DIR, "requirements.txt")
HOST = "127.0.0.1"
PORT = 8585

BANNER = r"""
==============================================================
        Professor Flash V1   -   AI Agent  (Offline & Free)
        Free  ·  Offline  ·  Persian  ·  Real Thinking AI
==============================================================
"""


def log(msg):
    print(f"[*] {msg}", flush=True)


def warn(msg):
    print(f"[!] {msg}", flush=True)


def venv_has_flask(py):
    try:
        r = subprocess.run([py, "-c", "import flask"], capture_output=True, text=True, timeout=30)
        return r.returncode == 0
    except Exception:
        return False


def find_free_port(preferred):
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    return preferred


def venv_python():
    if os.name == "nt":
        return os.path.join(VENV_DIR, "Scripts", "python.exe")
    return os.path.join(VENV_DIR, "bin", "python")


def ensure_venv():
    if os.path.exists(venv_python()):
        log(f"Environment ready: {VENV_DIR}")
        return venv_python()
    log("Creating virtual environment ...")
    subprocess.run([sys.executable, "-m", "venv", VENV_DIR], check=True)
    log("Virtual environment created")
    return venv_python()


def ensure_packages(py):
    try:
        r = subprocess.run([py, "-c", "import flask"], capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            log("Dependencies already installed (flask)")
            return True
    except Exception:
        pass
    log("Installing missing packages ...")
    try:
        r = subprocess.run(
            [py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", REQUIREMENTS],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            warn("pip install failed, retrying with --user ...")
            r2 = subprocess.run(
                [py, "-m", "pip", "install", "--quiet", "--user", "-r", REQUIREMENTS],
                capture_output=True,
                text=True,
            )
            return r2.returncode == 0
        log("Dependencies installed")
        return True
    except Exception as exc:
        warn(f"pip failed: {exc}")
        return False


def detect_tools():
    info = {"node": False, "ollama": False, "deepseek": False, "openrouter": False}
    if shutil.which("node"):
        info["node"] = True
        log("Node.js detected (برای تست واقعی جاوااسکریپت)")
    else:
        log("Node.js not found (تست ساختاری انجام می‌شود)")
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2):
            info["ollama"] = True
            log("Ollama detected (موتور فکری محلی - کاملا آفلاین)")
    except Exception:
        log("Ollama not detected (اختیاری - برای ساخت آفلاین نصب کنید)")
    if os.environ.get("DEEPSEEK_API_KEY"):
        info["deepseek"] = True
        log("DeepSeek API key found (موتور فکری آنلاین)")
    else:
        log("DEEPSEEK_API_KEY not set (اختیاری: set DEEPSEEK_API_KEY=... برای موتور DeepSeek)")
    if os.environ.get("OPENROUTER_API_KEY"):
        info["openrouter"] = True
        log("OpenRouter API key found (موتور فکری آنلاین)")
    else:
        log("OPENROUTER_API_KEY not set (اختیاری)")
    bundled_exe = os.path.join(PROJECT_DIR, "engine", "llama", "llama-server.exe")
    if os.path.exists(bundled_exe):
        has_model = any(f.endswith(".gguf") for f in os.listdir(os.path.join(PROJECT_DIR, "models")) if os.path.isdir(os.path.join(PROJECT_DIR, "models")))
        if has_model:
            log("Bundled brain present (Aya-Expanse - engine/llama + models/) - کاملا آفلاین")
        else:
            log("Bundled engine present but model missing - run download_model.py")
    log("Pollinations: موتور رایگان بدون کلید - در صورت در دسترس بودن به‌کار می‌رود")
    return info


def open_browser(url):
    def _open():
        time.sleep(2.2)
        try:
            import webbrowser
            webbrowser.open(url)
            log(f"Browser opened: {url}")
        except Exception:
            pass
    threading.Thread(target=_open, daemon=True).start()


# ------------------------------------------------------------------ brain
_LLAMA_PROC = {"proc": None}


def start_bundled_brain():
    """Start the bundled llama-server (engine/llama) with the model in
    models/ if both exist. Runs in a background thread so the web UI still
    comes up instantly; the model answers as soon as it has loaded.
    Returns nothing (threaded).
    """
    exe = os.path.join(PROJECT_DIR, "engine", "llama", "llama-server.exe")
    if not os.path.exists(exe):
        return
    ggu = None
    models_dir = os.path.join(PROJECT_DIR, "models")
    if os.path.isdir(models_dir):
        for f in sorted(os.listdir(models_dir)):
            if f.endswith(".gguf"):
                p = os.path.join(models_dir, f)
                # skip a still-downloading (partial) file
                if os.path.getsize(p) > 50 * 1024 * 1024 and time.time() - os.path.getmtime(p) > 60:
                    ggu = p
                    break
    if not ggu:
        log("Model not found in models/ - run download_model.py to enable the real local brain")
        return
    port = 8081
    cmd = [exe, "-m", ggu, "-c", "4096", "--host", "127.0.0.1", "--port", str(port),
           "-t", "4", "--no-webui"]
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                creationflags=flags)
    except Exception as exc:
        warn(f"Could not start bundled brain: {exc}")
        return
    _LLAMA_PROC["proc"] = proc
    log(f"Bundled brain loading ({os.path.basename(ggu)}) on 127.0.0.1:{port} ...")
    import urllib.request
    for _ in range(120):
        if proc.poll() is not None:
            warn("Bundled brain exited unexpectedly; continuing without it.")
            return
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=1):
                log("Bundled brain ready (Aya-Expanse 8B - کاملا آفلاین و رایگان)")
                return
        except Exception:
            time.sleep(0.5)
    warn("Bundled brain took too long to load; continuing without it.")
    try:
        proc.kill()
    except Exception:
        pass


def stop_bundled_brain():
    proc = _LLAMA_PROC.get("proc")
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def main():
    if os.environ.get("PF_REEXEC") != "1":
        print(BANNER)
        print("          Professor Flash V1  -  AI App Builder (Offline)")
        print("          Free  ·  Offline  ·  Persian  ·  Agent")
        print("=" * 66)
        print()

    log(f"OS: {sys.platform}")
    log(f"Python: {sys.version.split()[0]}")
    log(f"Directory: {PROJECT_DIR}")

    py = ensure_venv()
    under_venv = os.path.exists(py) and os.path.abspath(sys.executable) == os.path.abspath(py)

    if not under_venv and os.path.exists(py):
        # try to make the venv usable first, then re-exec under it
        if not venv_has_flask(py):
            ensure_packages(py)
        if venv_has_flask(py):
            log("Switching to environment interpreter ...")
            os.environ["PF_REEXEC"] = "1"
            os.execv(py, [py] + sys.argv)
        else:
            warn("Virtual environment is incomplete; continuing with the system interpreter.")

    if not ensure_packages(py):
        warn("Some packages could not be installed; continuing anyway.")

    detect_tools()
    threading.Thread(target=start_bundled_brain, daemon=True).start()

    port = find_free_port(PORT)
    url = f"http://{HOST}:{port}"

    sys.path.insert(0, PROJECT_DIR)

    # launch the server in a thread so run.py stays a friendly console
    def serve():
        from app.server import app
        app.run(host=HOST, port=port, threaded=True, use_reloader=False)

    t = threading.Thread(target=serve, daemon=True)
    t.start()

    # wait for the server to come up
    import urllib.request
    up = False
    for _ in range(40):
        try:
            urllib.request.urlopen(url, timeout=1)
            up = True
            break
        except Exception:
            time.sleep(0.25)
    if not up:
        warn("Server did not answer; check the logs above.")
        sys.exit(1)

    print()
    print("=" * 62)
    print("  Professor Flash V1 is running!")
    print(f"  Open: {url}")
    print("  Press Ctrl+C to stop.")
    print("=" * 62)

    open_browser(url)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[+] Shutting down. Goodbye!")
        stop_bundled_brain()
        os._exit(0)


if __name__ == "__main__":
    main()
