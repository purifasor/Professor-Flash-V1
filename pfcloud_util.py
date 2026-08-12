# -*- coding: utf-8 -*-
"""Professor Flash V1 - shared low-level helpers (extracted from pfcloud.py
so the main brain file stays light and easy to edit).

Pure utilities with no dependencies on the rest of the app: HTTP helpers,
text normalization and model-output cleanup.
"""

import json
import os
import re
import time
import urllib.parse
import urllib.request


# ------------------------------------------------------------ text utils
def _norm(s):
    s = str(s)
    s = s.replace("\u064a", "\u06cc").replace("\u0643", "\u06a9").replace("\u0629", "\u0647").replace("\u0623", "\u0627")
    s = s.replace("\u0625", "\u0627").replace("\u0622", "\u0627").replace("\u0624", "\u0648").replace("\u0626", "\u06cc").replace("\u0649", "\u06cc")
    s = re.sub(r"[\u064B-\u065F\u0670\u06D6-\u06ED]", "", s)
    s = s.replace("\u200c", " ")
    return s.lower().strip()


def _now():
    return int(time.time())


def _log(logs, text, level="info"):
    logs.append({"time": _now(), "text": text, "level": level})


# -------------------------------------------------------------- HTTP
_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def _post_json(url, payload, headers=None, timeout=8):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **_UA, **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return None


def _get(url, timeout=8):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return None


# ----------------------------------------------- model-output cleanup
def _clean(txt):
    txt = txt.replace("<|END_OF_TURN_TOKEN|>", "").replace("<|end_of_turn|>", "")
    return _dechain(txt.strip())


# Some free reasoning models leak chain-of-thought into the reply. Strip
# <think> blocks and a leading English meta-paragraph ("The user asks...")
# when real content follows, so the user sees only the actual answer.
_COT_LEAD = re.compile(
    r"^\s*(?:the (?:user|request|question)|they (?:want|ask|are|need)|user (?:asks|wants|is asking)|i'?m (?:being|asked|supposed)|i need to (?:respond|answer|write|provide)|okay,? (?:so|the|let)|the correct (?:answer|response|way)),",
    re.I,
)

# English chain-of-thought leaks that ride INSIDE `content` (gpt-oss / Kilo /
# Pollinations write their reasoning in English before a Persian tail). The
# reply therefore contains Persian somewhere, so the language gates miss it -
# catch the reasoning markers directly and cut the dump.
_REASON_TALK = re.compile(
    r"let me (just )?(respond|answer|write|provide|consider|think|also consider|make sure)"
    r"|i (need|have) to (make sure|think|consider|respond|answer)"
    r"|the (most )?direct interpretation|the most direct interpretation is"
    r"|the rules say|the user is (testing|asking|trying)"
    r"|i'?ll (just )?(respond|write|provide|say)|i will (just )?(respond|write|provide|say)"
    r"|first,? let me|first of all|let me (also |now )?think|let me also consider"
    r"|step[- ]?by[- ]?step|step 1[:：]|step one|thinking process"
    r"|i (should|need to) (make sure|keep in mind|note)",
    re.I,
)


def _dechain(txt):
    if not txt:
        return txt
    t = re.sub(r"<think>.*?</think>\s*", "", txt, flags=re.S | re.I)
    t = re.sub(r"(?:^|\n)\s*(?:thinking|reasoning) process\s*:?\s*\n+", "\n", t, flags=re.I)
    t = t.strip()
    m = re.search(r"final answer:\s*", t, re.I)
    if m:
        t = t[m.end():].strip()
    paras = re.split(r"\n\n+", t)
    # drop a leading ENGLISH reasoning dump before the real answer (the dump
    # is pure English and reasoner-talk; the real answer follows in Persian)
    while len(paras) > 1 and not re.search(r"[\u0600-\u06FF]", paras[0]) \
            and (len(paras[0]) < 90 or _REASON_TALK.search(paras[0])):
        paras.pop(0)
    if len(paras) > 1 and _COT_LEAD.search(paras[0]):
        paras.pop(0)
    return "\n\n".join(paras).strip()


def _final_from_thinking(t):
    """Extract the actual answer from a Qwen-style thinking dump (everything
    lives in `reasoning`, content is empty). Prefer the final conclusion."""
    if not t:
        return t
    t = t.strip()
    # markers that introduce the real conclusion
    for marker in (r"\banswer\s*(?:is\s*)?:?", r"\bپاسخ\s*(?:این است\s*)?:?", r"بنابراین", r"در نتیجه",
                   r"\bso,?\s+(?:the )?\b", r"\btherefore", r"in summary", r"خلاصه"):
        m = list(re.finditer(marker, t, re.I))
        if m and t[m[-1].end():].strip():
            tail = re.sub(r"^\s*[:\\-–—-]\s*", "", t[m[-1].end():]).strip()
            if len(tail) > 10:
                return tail[:1600]
    # fallback: drop the numbered analysis steps, keep the last paragraph
    paras = [p.strip() for p in re.split(r"\n\n+", t) if p.strip()]
    if len(paras) > 1 and re.match(r"^\s*(1\.|1\)|\d{1,2}\.|first|step 1|گام 1|اول)", paras[0], re.I):
        return paras[-1][:1600]
    return t[:1600]
