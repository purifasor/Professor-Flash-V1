# -*- coding: utf-8 -*-
"""Professor Flash - offline knowledge banks.

Curated reference documents (app/brain/kb/*.md) about programming, web
development, SEO, Google Dork, thinking frameworks and design. They are
loaded once (tiny) and retrieved by cheap keyword scoring - no heavy
embeddings, no RAM cost - then injected into the model's prompts as
reference context, so answers and generated code get stronger without
touching the hardware.

File format:
    # Title
    # keywords: kw1, kw2, ...
    ...markdown body...
"""

import os
import re

from . import persian

_KB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kb")

_docs = None


def _load():
    global _docs
    docs = []
    if not os.path.isdir(_KB_DIR):
        _docs = docs
        return
    for name in sorted(os.listdir(_KB_DIR)):
        if not name.endswith(".md"):
            continue
        try:
            with open(os.path.join(_KB_DIR, name), "r", encoding="utf-8") as f:
                raw = f.read()
        except Exception:
            continue
        title = ""
        keywords = []
        body_lines = []
        for line in raw.splitlines():
            if line.startswith("# keywords:"):
                keywords = [k.strip().lower() for k in line[len("# keywords:"):].split(",") if k.strip()]
            elif line.startswith("# "):
                title = line[2:].strip()
            elif line.startswith("#"):
                continue
            else:
                body_lines.append(line)
        body = "\n".join(body_lines).strip()
        docs.append({
            "name": name.replace(".md", ""),
            "title": title,
            "keywords": keywords,
            "body": body,
        })
    _docs = docs


def _word_set(text):
    s = persian.soft(text).lower()
    return set(re.findall(r"[\u0600-\u06FFa-zA-Z0-9]+", s))


def retrieve(question, limit=2):
    """Return the most relevant knowledge docs for a question.

    Each doc is {title, body}. Scoring: full keywords/title words present
    in the question count heavily; any token overlap counts a little.
    """
    if _docs is None:
        _load()
    if not _docs:
        return []
    qwords = _word_set(question)
    scored = []
    for d in _docs:
        score = 0
        hay = set(d["keywords"]) | _word_set(d["title"])
        for w in hay:
            if not w:
                continue
            if persian.soft(w) in persian.soft(question).lower():
                score += len(w) * 3
        # token overlap bonus
        overlap = qwords & _word_set(d["title"])
        score += len(overlap) * 2
        if score > 0:
            scored.append((score, d))
    scored.sort(key=lambda x: -x[0])
    out = []
    for score, d in scored[:limit]:
        body = d["body"]
        if len(body) > 2600:
            body = body[:2600].rsplit("\n", 1)[0]
        out.append({"title": d["title"], "body": body})
    return out


def doc_by_keyword(kw):
    """Fetch a specific doc whose keywords contain kw (e.g. "seo")."""
    if _docs is None:
        _load()
    for d in _docs:
        if kw.lower() in d["keywords"] or kw == d["name"]:
            body = d["body"]
            if len(body) > 2600:
                body = body[:2600].rsplit("\n", 1)[0]
            return {"title": d["title"], "body": body}
    return None


def all_titles():
    if _docs is None:
        _load()
    return [d["title"] for d in _docs]
