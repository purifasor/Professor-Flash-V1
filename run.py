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
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║     ╔═╗╔═╗╔═╗ ╔╦╗╔═╗╔═╗╔╦╗  ╦  ╦╔═╗╦╔╦╗╔═╗╦═╗           ║
║     ║  ╠╣ ║╣   ║ ║╣ ║╣  ║   ║  ║║  ║ ║ ╠═╣╠╦╝           ║
║     ╚═╝╚  ╚═╝  ╩ ╚═╝╚═╝ ╩   ╚═╝╚═╝╩ ╩ ╩ ╩╩╚═           ║
║                                                          ║
║        V1  -  AI App Builder (Offline)                   ║
║                                                          ║
║     Free  ·  Offline  ·  Persian  ·  Agent               ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
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
    info = {"node": False, "ollama": False}
    if shutil.which("node"):
        info["node"] = True
        log("Node.js detected (برای تست واقعی جاوااسکریپت)")
    else:
        log("Node.js not found (تست ساختاری انجام می‌شود)")
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=1):
            info["ollama"] = True
            log("Ollama detected (اختیاری - برای پاسخ‌های باز)")
    except Exception:
        log("Ollama not detected (اختیاری)")
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


def main():
    print(BANNER)
    print("          Professor Flash V1  -  AI App Builder (Offline)")
    print("          Free  ·  Offline  ·  Persian  ·  Agent")
    print("=" * 62)
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
            os.execv(py, [py] + sys.argv)
        else:
            warn("Virtual environment is incomplete; continuing with the system interpreter.")

    if not ensure_packages(py):
        warn("Some packages could not be installed; continuing anyway.")

    detect_tools()

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
        os._exit(0)


if __name__ == "__main__":
    main()
