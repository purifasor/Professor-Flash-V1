# -*- coding: utf-8 -*-
"""Professor Flash - passive learning store (Learned/ folder).

The model writes what it genuinely learns - answers that came from the
LLM/web and were NOT already known, and build techniques - into a folder
named `Learned/` next to the app. Files are small JSON notes with a plain
text field, so they are fast to read even on weak hardware, and an
`index.json` makes recall O(1)-ish.

Learning is passive: it never drives the conversation, and it never stores
raw user messages. It only stores knowledge that is new and non-trivial,
deduplicated by content digest.
"""

import hashlib
import json
import os
import threading
import time

MAX_ENTRIES = 300
MIN_CONTENT = 40
MIN_TOPIC = 4


class Learn:
    def __init__(self, root: str):
        self.root = os.path.join(root, "Learned")
        self.lock = threading.Lock()
        os.makedirs(self.root, exist_ok=True)
        self.index_path = os.path.join(self.root, "index.json")
        self.index = {"entries": []}  # [{digest, topic, question, source, learned_at}]
        self._load_index()

    # ------------------------------------------------------------------ io
    def _load_index(self):
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                self.index = json.load(f)
            if not isinstance(self.index.get("entries"), list):
                self.index = {"entries": []}
        except Exception:
            self.index = {"entries": []}

    def _save_index(self):
        tmp = self.index_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.index, f, ensure_ascii=False)
            os.replace(tmp, self.index_path)
        except Exception:
            pass

    def _digest(self, text):
        return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]

    def count(self):
        return len(self.index["entries"])

    # -------------------------------------------------------------- recall
    def recall(self, question: str):
        """Return the best matching learned note or None (score >= 0.55)."""
        from . import persian
        s = persian.soft(question)
        best, best_score = None, 0.0
        for entry in self.index["entries"]:
            q = persian.soft(entry.get("question", ""))
            t = persian.soft(entry.get("topic", ""))
            if not q and not t:
                continue
            # containment scores
            if q and (q in s or s in q):
                sc = min(1.0, len(q) / max(len(s), 1)) + 0.35
            elif t and (t in s or s in t):
                sc = min(0.8, len(t) / max(len(s), 1)) + 0.15
            else:
                # token overlap
                qw = set(persian.words(q)) if q else set()
                sw = set(persian.words(s))
                if qw and sw:
                    inter = len(qw & sw)
                    if inter >= 2:
                        sc = inter / max(len(sw), 1)
                    else:
                        sc = 0
                else:
                    sc = 0
            if sc > best_score:
                best_score = sc
                best = entry
        if best is None or best_score < 0.55:
            return None
        try:
            with open(os.path.join(self.root, best["digest"] + ".json"), "r", encoding="utf-8") as f:
                note = json.load(f)
            return note.get("content", "")
        except Exception:
            return None

    # --------------------------------------------------------------- learn
    def learn(self, topic: str, question: str, content: str, source: str = "llm"):
        """Passively store a genuinely-new piece of knowledge.

        Returns True when stored, False when skipped (too short / duplicate).
        """
        topic = (topic or "").strip()
        content = (content or "").strip()
        question = (question or "").strip()
        if len(content) < MIN_CONTENT or len(topic) < MIN_TOPIC:
            return False
        with self.lock:
            digest = self._digest(topic + "|" + content)
            for entry in self.index["entries"]:
                if entry["digest"] == digest:
                    return False
            # avoid flooding: same question already learned?
            from . import persian
            sq = persian.soft(question)
            if sq:
                for entry in self.index["entries"]:
                    eq = persian.soft(entry.get("question", ""))
                    if eq and len(eq) >= 8 and (eq in sq or sq in eq):
                        return False
            note = {
                "digest": digest,
                "topic": topic,
                "question": question,
                "source": source,
                "learned_at": time.time(),
                "content": content,
            }
            try:
                with open(os.path.join(self.root, digest + ".json"), "w", encoding="utf-8") as f:
                    json.dump(note, f, ensure_ascii=False, indent=1)
            except Exception:
                return False
            self.index["entries"].append(
                {"digest": digest, "topic": topic, "question": question,
                 "source": source, "learned_at": note["learned_at"]}
            )
            self.index["entries"] = self.index["entries"][-MAX_ENTRIES:]
            self._save_index()
            return True
