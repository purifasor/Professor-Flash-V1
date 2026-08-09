# -*- coding: utf-8 -*-
"""Professor Flash - real LLM layer (fast-fail).

Professor Flash is NOT a wrapper around one fixed API. It is a model with
its own local brain that uses *free* LLM providers as thinking engines
whenever one is available:

  1. Ollama     - local model on this machine (fully offline, no internet)
  2. DeepSeek   - used when the user sets DEEPSEEK_API_KEY (cheap, strong)
  3. OpenRouter - used when the user sets OPENROUTER_API_KEY (free models)
  4. Pollinations - free anonymous API, no key needed (used automatically)

The chain is tried in order and the first one that answers wins. It is
built to fail FAST: a connectivity check skips all online providers when
there is no internet, failing providers get a cooldown, and every call has
a hard deadline - so the local brain takes over within seconds and the
user never waits for a dead service.
"""

import json
import os
import re
import threading
import time
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
POLLINATIONS_URL = "https://text.pollinations.ai/"

_lock = threading.Lock()
_status = {
    "ollama": {"ok": None, "model": None},
    "deepseek": {"ok": None, "model": None},
    "openrouter": {"ok": None, "model": None},
    "pollinations": {"ok": None, "model": None},
}
_cooldown = {}            # provider key -> time.monotonic() of last failure
_net_state = {"ok": None, "at": 0.0}
_ollama_cache = {"models": None, "at": 0.0}


def _post_json(url, body, headers=None, timeout=30):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"User-Agent": UA, "Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _post_raw(url, body, headers=None, timeout=20):
    """POST JSON, return the raw response body as text (or None)."""
    try:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"User-Agent": UA, "Content-Type": "application/json", **(headers or {})},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


# ------------------------------------------------------------- network
def _net_ok():
    """Fast cached connectivity check (20s TTL)."""
    now = time.monotonic()
    if _net_state["ok"] is not None and now - _net_state["at"] < 20:
        return _net_state["ok"]
    ok = False
    try:
        req = urllib.request.Request("https://www.google.com/generate_204", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=3):
            ok = True
    except Exception:
        ok = False
    _net_state["ok"] = ok
    _net_state["at"] = now
    return ok


def _in_cooldown(key):
    return time.monotonic() - _cooldown.get(key, 0.0) < 45


def _mark_fail(key):
    _cooldown[key] = time.monotonic()


# ---------------------------------------------------------------- ollama
def _ollama_models():
    now = time.monotonic()
    if _ollama_cache["models"] is not None and now - _ollama_cache["at"] < 20:
        return _ollama_cache["models"]
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=1.5) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
        names = [m.get("name", "") for m in data.get("models", [])]
        _ollama_cache["models"] = [n for n in names if n]
    except Exception:
        _ollama_cache["models"] = []
    _ollama_cache["at"] = now
    return _ollama_cache["models"]


def _ollama_chat(messages, timeout=90):
    models = _ollama_models()
    if not models:
        return None
    model = models[0]
    body = {"model": model, "messages": messages, "stream": False, "options": {"temperature": 0.7}}
    data = _post_json("http://127.0.0.1:11434/api/chat", body, timeout=timeout)
    return (data.get("message") or {}).get("content"), model


# ------------------------------------------------------------- deepseek
def _deepseek_chat(messages, timeout=40):
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        return None
    body = {"model": "deepseek-chat", "messages": messages, "temperature": 0.7}
    data = _post_json(
        DEEPSEEK_URL, body,
        headers={"Authorization": "Bearer " + key}, timeout=timeout,
    )
    return (data.get("choices") or [{}])[0].get("message", {}).get("content"), "deepseek-chat"


# ------------------------------------------------------------ openrouter
def _openrouter_chat(messages, timeout=40):
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        return None
    body = {
        "model": os.environ.get("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free"),
        "messages": messages,
        "temperature": 0.7,
    }
    data = _post_json(
        OPENROUTER_URL, body,
        headers={"Authorization": "Bearer " + key}, timeout=timeout,
    )
    return (data.get("choices") or [{}])[0].get("message", {}).get("content"), body["model"]


# ---------------------------------------------------------- pollinations
def _pollinations_chat(messages, timeout=25):
    """Free anonymous LLM API (no key). Returns (text, model) or (None, None).

    Tries several endpoint shapes because the service changes them often.
    """
    body = {"messages": messages, "temperature": 0.7}
    candidates = [
        (POLLINATIONS_URL, body),
        (POLLINATIONS_URL + "openai", {"model": "openai", "messages": messages, "temperature": 0.7}),
        (POLLINATIONS_URL + "openai", {"model": "gpt-4o-mini", "messages": messages}),
    ]
    per_attempt = min(timeout, 5)
    for url, b in candidates:
        raw = _post_raw(url, b, timeout=per_attempt)
        if not raw:
            continue
        if raw.lstrip().startswith("{"):
            try:
                data = json.loads(raw)
                if isinstance(data, dict):
                    if data.get("error") or data.get("status") in (402, 429, 500, 502, 503):
                        continue
                    content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
                    if content:
                        return content, (data.get("model") or "openai")
            except Exception:
                pass
        else:
            txt = raw.strip()
            if txt and not txt.startswith("<!DOCTYPE") and len(txt) < 8000:
                return txt, "openai"
    return None, None


# ------------------------------------------------------------------ core
_PROVIDERS = [
    ("ollama", _ollama_chat, "Ollama (محلی - آفلاین)"),
    ("deepseek", _deepseek_chat, "DeepSeek"),
    ("openrouter", _openrouter_chat, "OpenRouter"),
    ("pollinations", _pollinations_chat, "Pollinations"),
]
_ONLINE_KEYS = ("deepseek", "openrouter", "pollinations")


class Llm:
    """Thinking engine. chat() returns (text, provider_name) or (None, None)."""

    def __init__(self):
        self.enabled = True

    # ------------------------------------------------------------ status
    def status(self):
        with _lock:
            return {
                key: {"ok": _status[key]["ok"], "model": _status[key]["model"], "label": fa}
                for key, _, fa in _PROVIDERS
            }

    def active_provider(self):
        """Human description of the first provider that has answered OK.

        Only returns a provider that actually worked before - never probes,
        so layer-1 (fast) messages stay instant.
        """
        for key, _, fa in _PROVIDERS:
            if _status[key].get("ok") is True:
                return fa
        return None

    def note(self, key, ok, model=None):
        with _lock:
            _status[key]["ok"] = ok
            if model:
                _status[key]["model"] = model

    # ------------------------------------------------------------- chat
    def chat(self, system, user, timeout=45):
        """Return (text, provider_name). (None, None) when no provider works.

        Fast-fail: offline check skips online providers, failed providers
        get a 45s cooldown, and a hard deadline bounds the whole call so
        the local brain takes over quickly.
        """
        messages = [{"role": "system", "content": system}]
        if user:
            messages.append({"role": "user", "content": user})

        online = _net_ok()
        per = max(10, min(timeout, 30))
        deadline = time.monotonic() + min(timeout, 45)

        for round_no in range(2):
            for key, fn, _fa in _PROVIDERS:
                if time.monotonic() > deadline:
                    return None, None
                if key in _ONLINE_KEYS:
                    if not online:
                        continue
                    if round_no == 1 and key != "pollinations":
                        continue  # round 2 only retries the flaky keyless API
                    if _in_cooldown(key):
                        continue
                try:
                    out, model = fn(messages, timeout=per)
                    if out and out.strip():
                        self.note(key, True, model)
                        _cooldown.pop(key, None)
                        return out.strip(), _fa
                    if key in _ONLINE_KEYS:
                        _mark_fail(key)
                except Exception:
                    self.note(key, False)
                    if key in _ONLINE_KEYS:
                        _mark_fail(key)
                    continue
            if time.monotonic() > deadline:
                return None, None
            time.sleep(1.0)
        return None, None

    # ------------------------------------------------------ JSON answers
    def chat_json(self, system, user, timeout=70):
        """Ask for a JSON object; returns parsed dict or None (with retry)."""
        for attempt in range(2):
            text, prov = self.chat(system, user, timeout=timeout)
            if not text:
                return None, prov
            parsed = _extract_json(text)
            if parsed is not None:
                return parsed, prov
        return None, prov

    # ----------------------------------------------------------- build
    def generate_project(self, spec, timeout=90):
        """Generate a complete project from a spec dict.

        Returns (files_dict, plan_list, provider) or (None, None, None).
        files_dict: {relative_path: content}
        """
        system = (
            "You are Professor Flash, a professional full-stack developer. "
            "You write complete, working, production-quality web apps. "
            "Persian UI text is fine and welcome. Do NOT wrap the JSON in markdown."
        )
        user = (
            "Build a complete single-page web app for this request:\n\n"
            f"{spec['description']}\n\n"
            f"theme: {spec.get('theme')} | accent color: {spec.get('accent', '#7c3aed')}\n"
            "Requirements:\n"
            "- Three files: index.html, style.css, app.js\n"
            "- index.html must link style.css and app.js and must include every feature the user asked for\n"
            "- style.css: modern professional design matching the theme, responsive\n"
            "- app.js: complete working logic, no placeholders, no TODO comments\n"
            "- RTL layout with lang=\"fa\" and dir=\"rtl\" when the interface is Persian\n"
            "- No external dependencies (no CDN libraries), everything self-contained\n\n"
            "Reply with ONLY a JSON object shaped exactly like this:\n"
            '{"plan": ["step 1", "step 2", ...], "files": {"index.html": "<full html>", "style.css": "<full css>", "app.js": "<full js>"}}\n'
            "The plan must list 4-6 real implementation steps in Persian.\n"
            "Escape all newlines and quotes properly inside the JSON strings."
        )
        parsed, prov = self.chat_json(system, user, timeout=timeout)
        if not parsed:
            return None, None, prov
        files = parsed.get("files")
        plan = parsed.get("plan") or []
        if not isinstance(files, dict) or not files:
            return None, None, prov
        cleaned = {}
        for name, content in files.items():
            name = str(name).strip().lstrip("./")
            if name in ("index.html", "style.css", "app.js") or name.endswith((".html", ".css", ".js")):
                cleaned[name] = str(content)
        if not cleaned.get("index.html"):
            return None, None, prov
        return cleaned, plan, prov

    # ---------------------------------------------------------- fix code
    def fix_project(self, spec, files, error_text, timeout=90):
        """Ask the LLM to repair the generated files; returns new files dict."""
        system = (
            "You are Professor Flash, a senior debugger. Repair the broken code "
            "and reply with ONLY valid JSON, no markdown fences."
        )
        user = (
            "The generated project has errors. Fix them and return the COMPLETE corrected files "
            "(every file fully, never truncated).\n\n"
            f"Request: {spec['description']}\n"
            f"Error report:\n{error_text[:1500]}\n\n"
            "Current files:\n"
            + "\n---\n".join(f"{k}:\n{v[:3000]}" for k, v in files.items())
            + '\n\nReply ONLY: {"files": {"index.html": "...", "style.css": "...", "app.js": "..."}}'
        )
        parsed, prov = self.chat_json(system, user, timeout=timeout)
        if not parsed:
            return None, prov
        files = parsed.get("files")
        if not isinstance(files, dict):
            return None, prov
        return {k: str(v) for k, v in files.items()}, prov


def _extract_json(text):
    """Best-effort extraction of a JSON object from model output."""
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except Exception:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            pass
    return None
