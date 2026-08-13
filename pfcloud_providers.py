# -*- coding: utf-8 -*-
"""Professor Flash V1 - free LLM providers + the PRF brain (extracted from
pfcloud.py).

PRF brain flow (connect-first):
  1. env-keyed premium (Gemini > DeepSeek > OpenRouter) if a key is set
  2. the GIANT primary model (Qwen3.5-397B - the only free anonymous model
     above 300B) gets a dedicated solo attempt
  3. the full pool races in parallel (397B / 120B / 70B)
  4. emergency free pools (Kilo, Pollinations) so a busy giant NEVER turns
     into a «مشغول‌اند» dead-end for the user
  5. last resort: cooldowns cleared and one more race
"""

import json
import os
import threading
import time
import urllib.parse
import urllib.request

from pfcloud_util import _clean, _final_from_thinking, _get, _post_json


POLL_URL = "https://text.pollinations.ai/"

# ------------------------------------------------------------------ session
# SESSION AFFINITY: once a session gets a good answer from a provider/model,
# that exact model is PINNED for the session (persistent connection). The next
# message in the same chat tries the SAME model first - no provider-hop loop,
# no «در حال ارتباط با Kilo... → مدل دیگر...» churn. The pin falls back only
# when the pinned model itself fails (rate-limit / refusal).
_TLS = threading.local()
SESS_LOCK = {}  # sid -> ("label:model", ts)
SESS_LOCK_TTL = 20 * 60  # keep a conversation's connection warm for 20 min


def _set_session(sid):
    _TLS.sid = sid


def _session():
    return getattr(_TLS, "sid", None)


def _lock_session(key):
    sid = _session()
    if sid and key:
        SESS_LOCK[sid] = (key, time.time())
        if len(SESS_LOCK) > 300:
            now = time.time()
            for k in [k for k, v in list(SESS_LOCK.items())
                      if now - v[1] > SESS_LOCK_TTL]:
                SESS_LOCK.pop(k, None)


def _unlock_session():
    sid = _session()
    if sid:
        SESS_LOCK.pop(sid, None)


def _session_lock():
    sid = _session()
    if not sid:
        return None
    e = SESS_LOCK.get(sid)
    if e and time.time() - e[1] < SESS_LOCK_TTL:
        return e[0]
    return None

# ------------------------------------------------------- free LLM chain
def _gemini(messages, timeout=8):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return None
    text = "\n".join(
        ("user: " if m["role"] == "user" else "assistant: ") + m["content"]
        for m in messages
    )
    body = {"contents": [{"parts": [{"text": text}]}],
            "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2000}}
    for model in ("gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"):
        raw = _post_json(
            "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s"
            % (model, key), body, timeout=timeout)
        if raw:
            try:
                d = json.loads(raw)
                parts = d["candidates"][0]["content"]["parts"]
                out = "".join(p.get("text", "") for p in parts).strip()
                if out:
                    return out, "Gemini (رایگان)"
            except Exception:
                pass
    return None


def _deepseek(messages, timeout=8):
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        return None
    body = {"model": "deepseek-chat", "messages": messages,
            "temperature": 0.7, "max_tokens": 2000}
    raw = _post_json("https://api.deepseek.com/chat/completions", body,
                     headers={"Authorization": "Bearer " + key}, timeout=timeout)
    if raw:
        try:
            d = json.loads(raw)
            out = (d.get("choices") or [{}])[0].get("message", {}).get("content")
            if out:
                return out.strip(), "DeepSeek (رایگان)"
        except Exception:
            pass
    return None


def _openrouter(messages, timeout=8):
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        return None
    body = {"model": "openrouter/auto", "messages": messages, "temperature": 0.7}
    raw = _post_json("https://openrouter.ai/api/v1/chat/completions", body,
                     headers={"Authorization": "Bearer " + key}, timeout=timeout)
    if raw:
        try:
            d = json.loads(raw)
            out = (d.get("choices") or [{}])[0].get("message", {}).get("content")
            if out:
                return out.strip(), "OpenRouter"
        except Exception:
            pass
    return None


def _pollinations(messages, timeout=8, max_tokens=1200, skip=None):
    body = {"messages": messages, "temperature": 0.7}
    candidates = [
        (POLL_URL + "openai", {"model": "openai", "messages": messages, "temperature": 0.7}),
        (POLL_URL, body),
        (POLL_URL + "openai", {"model": "gpt-4o-mini", "messages": messages}),
    ]
    per = min(timeout, 8)
    for url, b in candidates:
        raw = _post_json(url, b, timeout=per)
        if not raw:
            continue
        txt = raw.strip()
        if txt.startswith("{"):
            try:
                d = json.loads(txt)
                if d.get("error") or d.get("status") in (402, 429, 500, 502, 503):
                    continue
                out = (d.get("choices") or [{}])[0].get("message", {}).get("content")
                if out:
                    return _clean(out), "Pollinations (رایگان)"
            except Exception:
                continue
        else:
            if txt and not txt.startswith("<!DOCTYPE") and len(txt) < 8000:
                return _clean(txt), "Pollinations (رایگان)"
    # GET fallback for short prompts
    q = urllib.parse.quote(messages[-1]["content"][:1200])
    raw = _get(POLL_URL + q + "?model=openai", timeout=per)
    if raw and not raw.startswith("{"):
        return _clean(raw), "Pollinations (رایگان)"
    return None


KILO_URL = "https://api.kilo.ai/api/gateway/chat/completions"
OVH_URL = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions"

# PRF pool - primary is the ONLY free anonymous model above 300B:
#   Qwen3.5-397B-A17B (397B, PRIMARY - dedicated solo attempt first)
# The 120B / 70B models stay only as availability fallbacks so a rate-limited
# giant never turns into a «مشغول‌اند» dead-end. Kilo + Pollinations are the
# emergency pools. LLM7 (api.llm7.io) is BANNED PERMANENTLY.
KILO_MODELS = ["openrouter/free", "kilo-auto/free"]
OVH_MODELS = ["Qwen3.5-397B-A17B", "gpt-oss-120b", "Meta-Llama-3_3-70B-Instruct"]


def _load_model_registry():
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Model", "models.json")
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        out = {}
        for i in d.get("anonymous", []):
            out[i["provider"]] = i
        out["_emergency"] = d.get("emergency", [])
        out["_primary"] = d.get("primary", [])
        return out
    except Exception:
        return None


_REG = _load_model_registry()
_PRIMARY = []
if _REG:
    # LLM7 is banned permanently (see Model/directives.md): even if a registry
    # file ever lists it again, it is stripped out and never loaded.
    _REG.pop("LLM7", None)
    if "OVH" in _REG:
        OVH_URL = _REG["OVH"]["url"]
        OVH_MODELS = _REG["OVH"]["models"]
    _PRIMARY = list(_REG.get("_primary") or [])
    for e in _REG.get("_emergency", []):
        if e["provider"] == "Kilo":
            KILO_URL = e["url"]
            KILO_MODELS = e["models"]
        elif e["provider"] == "Pollinations":
            POLL_URL = e["url"]
# the giant primary model: first entry of the primary list, else first OVH model
PRIMARY_MODEL = (_PRIMARY[0] if _PRIMARY else
                 (OVH_MODELS[0] if OVH_MODELS else None))
# keep the preference order in sync with whatever the registry resolved to
TRIAD_PREF = {m: i for i, m in enumerate(OVH_MODELS)}

# per-model cooldown: after a 429/timeout skip that model for a while so the
# next user message rotates to a different free provider instead of failing
PROV_STATE = {}


def _cool(key):
    return PROV_STATE.get(key, 0) > time.time()


def _mark(key, secs):
    PROV_STATE[key] = time.time() + secs


def _try_completions(url, models, messages, timeout, max_tokens, label, skip=None, cb=None, headers=None):
    skip = skip or set()
    if cb:
        # ONE calm connect message per provider - never a hop loop.
        cb(12, "برقراری ارتباط پایدار با موتور فکری...")
    for model in models:
        key = label + ":" + model
        if key in skip or _cool(key):
            continue
        body = {"model": model, "messages": messages, "temperature": 0.7,
                "max_tokens": max_tokens, "stream": False}
        # NOTE: Qwen3.5-397B serves its output inside `reasoning` (content
        # stays empty) - the reasoning fallback below cleans it. Sending
        # chat_template_kwargs.enable_thinking=false made OVH return HTTP 400,
        # so the giant model would never answer; do NOT add it back.
        for attempt in (0, 1):  # retry once on rate-limit hiccups
            PROV_STATE["_net"] = PROV_STATE.get("_net", 0) + 1  # real attempt
            raw = _post_json(url, body, headers=headers, timeout=timeout)
            if not raw:
                _mark(key, 12)
                break
            try:
                d = json.loads(raw)
                if d.get("error"):
                    # 429/503: the endpoint's shared free tier is saturated -
                    # park the WHOLE pool briefly so the chain falls through to
                    # the emergency pools instead of burning attempts on a
                    # provider that cannot answer right now.
                    if attempt == 0 and d.get("status") in (429, 503):
                        for m in models:
                            _mark(label + ":" + m, 25)
                        time.sleep(1.5)
                        continue
                    _mark(key, 18)
                    break
                msg = (d.get("choices") or [{}])[0].get("message", {})
                out = msg.get("content")
                if out:
                    # dechain even normal content: Kilo/Pollinations leak their
                    # internal thinking into `content` («Here's a thinking
                    # process...») - clean it at the source so the gates don't
                    # have to waste a retry on it.
                    out = _clean(out)
                if not out:
                    # some providers return everything in `reasoning`/`reasoning_content`;
                    # pull out the real final answer from the thinking dump
                    out = msg.get("reasoning_content") or msg.get("reasoning")
                    if out:
                        out = _final_from_thinking(_clean(out))
                if out:
                    PROV_STATE.pop(key, None)
                    _lock_session(key)  # persistent per-session connection
                    if cb:
                        cb(64, "پاسخ " + label + " دریافت شد")
                    return out, label + " " + model + " (رایگان)"
            except Exception:
                _mark(key, 12)
                break
    return None


def _kilo(messages, timeout=8, max_tokens=1200, skip=None, cb=None):
    return _try_completions(KILO_URL, KILO_MODELS, messages, timeout, max_tokens, "Kilo", skip, cb)


def _ovh(messages, timeout=8, max_tokens=1200, skip=None, cb=None):
    return _try_completions(OVH_URL, OVH_MODELS, messages, timeout, max_tokens, "OVH", skip, cb)


def _ovh_model(model, messages, timeout, max_tokens, skip=None, cb=None):
    """Ask ONE specific OVH model (the primary attempt and the pool race both use this)."""
    return _try_completions(OVH_URL, [model], messages, timeout, max_tokens, "OVH", skip, cb)


def _triad_sweep(messages, timeout, max_tokens, skip, cb=None):
    """PRF pool: fire the models (397B / 120B / 70B) in PARALLEL and select
    the BEST answer - not just the first one that answers.

    Each model runs in its own thread with the same per-attempt budget, so the
    whole sweep costs ~timeout worst-case but usually returns in the time of
    the FASTEST model. The selector prefers the most complete answer (longest
    real content) with the giant (Qwen-397B) kept as the preferred choice:
    it wins ties and near-ties, but a substantially fuller answer from another
    model is still picked.
    """
    results = []
    lock = threading.Lock()
    done = threading.Event()

    def run(model):
        try:
            r = _ovh_model(model, messages, timeout=max(3.0, timeout),
                           max_tokens=max_tokens, skip=skip, cb=cb)
            if r and r[0]:
                with lock:
                    results.append((model, len(r[0]), r))
                done.set()
        except Exception:
            pass

    threads = [threading.Thread(target=run, args=(m,), daemon=True) for m in OVH_MODELS]
    for t in threads:
        t.start()
    if cb:
        cb(30, "اجرای موازی استخر PRF (۳۹۷B / ۱۲۰B / ۷۰B)...")
    done.wait(timeout)
    if not results:
        return None
    with lock:
        # longest answer first; the giant preferred unless another is much fuller
        results.sort(key=lambda x: -x[1])
        best = results[0]
        for model, ln, r in results:
            if model == OVH_MODELS[0] and ln >= best[1] * 0.6:
                return r
        return best[2]


def brain(messages, timeout=12, max_tokens=1200, skip=None, cb=None):
    """PRF brain, bounded by a hard time budget.

    CONNECT-FIRST: the giant primary model (Qwen3.5-397B - the only free
    anonymous model above 300B) gets a dedicated solo attempt, so the
    strongest brain answers whenever it is available. If it is rate-limited or
    refuses, the whole pool races, then the emergency free pools (Kilo,
    Pollinations) guarantee an answer - so «مشغول‌اند» almost never reaches
    the user.
    """
    deadline = time.time() + timeout

    def rem(margin=1.0):
        """Seconds left before the hard deadline (never below a real chance)."""
        return max(2.5, deadline - time.time() - margin)

    keyed = None
    if os.environ.get("GEMINI_API_KEY"):
        keyed = _gemini
    elif os.environ.get("DEEPSEEK_API_KEY"):
        keyed = _deepseek
    elif os.environ.get("OPENROUTER_API_KEY"):
        keyed = _openrouter
    if keyed:
        r = keyed(messages, timeout=min(6, rem()))
        if r and r[0]:
            if cb:
                cb(64, "پاسخ دریافت شد")
            return r
    # 0) PERSISTENT CONNECTION: if this session already pinned a provider+
    #    model, reuse EXACTLY that one first - the same brain keeps answering
    #    every question in the chat (no hop, no reconnect).
    lock = _session_lock()
    if lock and rem() > 5:
        prov_name, _, model = lock.partition(":")
        if cb:
            cb(16, "ارتباط پایدار با " + (model or prov_name) + "...")
        if prov_name == "OVH" and model:
            r = _ovh_model(model, messages, timeout=min(16, rem() - 2),
                           max_tokens=max_tokens, skip=skip, cb=cb)
        elif prov_name == "Kilo" and model:
            r = _try_completions(KILO_URL, [model], messages,
                                 min(9, rem()), max_tokens, "Kilo", skip, cb)
        else:
            r = None
        if r and r[0]:
            if cb:
                cb(58, "پاسخ از اتصال پایدار دریافت شد")
            return r
        # pinned model failed (rate-limit/refusal): drop the pin and fall
        # through the normal chain - a fresh model answers instead of looping
        _unlock_session()
    # 1) CONNECT-FIRST: the giant gets a dedicated solo attempt
    if PRIMARY_MODEL and rem() > 5:
        if cb:
            cb(18, "اتصال به موتور غول (Qwen 397B)...")
        r = _ovh_model(PRIMARY_MODEL, messages, timeout=min(16, rem() - 2),
                       max_tokens=max_tokens, skip=skip, cb=cb)
        if r and r[0]:
            if cb:
                cb(58, "پاسخ مدل غول (397B) دریافت شد")
            return r
    # 2) the pool races in parallel, but ~8s is ALWAYS reserved for the
    #    emergency pools below - a busy giant must never eat the whole budget
    if rem() > 9:
        r = _triad_sweep(messages, min(14, rem() - 8), max_tokens, skip, cb)
        if r and r[0]:
            if cb:
                cb(55, "پاسخ اولیه دریافت شد")
            return r
    # 3) emergency free pools (Kilo, Pollinations) - guarantee an answer so
    #    «مشغول‌اند» almost never reaches the user
    if rem() > 2.5:
        if cb:
            cb(40, "استفاده از سرویس‌های پشتیبان...")
        r = _kilo(messages, timeout=min(9, rem()), max_tokens=max_tokens, skip=skip, cb=cb)
        if not (r and r[0]):
            r = _pollinations(messages, timeout=min(9, rem()), max_tokens=max_tokens, skip=skip)
        if r and r[0]:
            if cb:
                cb(55, "پاسخ اولیه دریافت شد")
            return r
    # 4) last resort: clear cooldowns once and race one more time
    if cb:
        cb(45, "تلاش نهایی...")
    if rem() > 4:
        for k in list(PROV_STATE):
            if k != "_net":
                PROV_STATE.pop(k, None)
        r = _triad_sweep(messages, min(10, rem() - 2), max_tokens, None, cb)
        if r and r[0]:
            if cb:
                cb(55, "پاسخ اولیه دریافت شد")
            return r
        if rem() > 2.5:
            r = _kilo(messages, timeout=min(9, rem()), max_tokens=max_tokens, cb=cb)
            if not (r and r[0]):
                r = _pollinations(messages, timeout=min(9, rem()), max_tokens=max_tokens)
            if r and r[0]:
                if cb:
                    cb(55, "پاسخ اولیه دریافت شد")
                return r
    return None, None
