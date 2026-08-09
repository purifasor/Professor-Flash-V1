#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Professor Flash V1 - model downloader.

Downloads the two pieces the bundled offline brain needs:
  1. llama.cpp (CPU build, ~18 MB)           -> engine/llama/
  2. Aya-Expanse-8B (GGUF Q4_K_M, ~5 GB)     -> models/

Aya-Expanse-8B is Apache-2.0, trained on 23 languages (including Persian),
so it genuinely understands and answers in Persian. Everything is free and
runs fully offline afterwards.

Note: this is a large download. On a slower connection you can use a
smaller model by editing MODEL_URL (e.g. Qwen2.5-1.5B-Instruct-GGUF, but
note that Qwen 1.5B does NOT understand Persian well).
"""

import os
import urllib.request
import zipfile

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
LLAMA_ZIP_URL = "https://github.com/ggml-org/llama.cpp/releases/download/b10333/llama-b10333-bin-win-cpu-x64.zip"
MODEL_URL = "https://huggingface.co/bartowski/aya-expanse-8b-GGUF/resolve/main/aya-expanse-8b-Q4_K_M.gguf"
MODEL_NAME = "aya-expanse-8b-Q4_K_M.gguf"


def log(msg):
    print(f"[*] {msg}", flush=True)


def download(url, dest, desc):
    tmp = dest + ".part"
    log(f"Downloading {desc} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    print(f"\r  {done / 1e6:.0f} / {total / 1e6:.0f} MB ({pct}%)", end="", flush=True)
    print()
    os.replace(tmp, dest)
    log(f"Saved: {dest}")


def main():
    engine_dir = os.path.join(PROJECT_DIR, "engine")
    models_dir = os.path.join(PROJECT_DIR, "models")
    os.makedirs(engine_dir, exist_ok=True)
    os.makedirs(models_dir, exist_ok=True)

    exe = os.path.join(engine_dir, "llama", "llama-server.exe")
    if os.path.exists(exe):
        log("llama.cpp already present; skipping.")
    else:
        zip_path = os.path.join(engine_dir, "llama.zip")
        download(LLAMA_ZIP_URL, zip_path, "llama.cpp (CPU)")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(os.path.join(engine_dir, "llama"))
        os.remove(zip_path)
        log("llama.cpp extracted to engine/llama/")

    model_path = os.path.join(models_dir, MODEL_NAME)
    if os.path.exists(model_path) and os.path.getsize(model_path) > 4e9:
        log("Model already present; skipping.")
    else:
        download(MODEL_URL, model_path, "Aya-Expanse-8B (Q4_K_M, ~5 GB)")

    log("Done! Now run: python run.py")


if __name__ == "__main__":
    main()
