# -*- coding: utf-8 -*-
"""Persistent memory: conversation history, current project, learned facts.

Everything is stored in a single JSON file (memory.json) so the model can
continue previous work after a restart. Writes are atomic (temp file +
rename) so a crash never corrupts the memory.
"""

import json
import os
import threading
import time


class Memory:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.data = {
            "conversation": [],       # [{role, text, time}]
            "current_project": None,  # project descriptor dict
            "learned_facts": {},      # keyword phrase -> fact text
            "corrections": [],        # [{template, error, fix}] applied fixes
            "qa": {},                 # question soft-text -> answer
            "counters": {},
        }
        self._load()

    # ------------------------------------------------------------------ io
    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                saved = json.load(f)
            for key in self.data:
                if key in saved:
                    self.data[key] = saved[key]
        except Exception:
            pass

    def save(self):
        with self.lock:
            tmp = self.path + ".tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self.data, f, ensure_ascii=False, indent=1)
                os.replace(tmp, self.path)
            except Exception:
                pass

    # ------------------------------------------------------------ history
    def add_turn(self, role: str, text: str):
        self.data["conversation"].append(
            {"role": role, "text": text, "time": time.time()}
        )
        self.data["conversation"] = self.data["conversation"][-200:]
        self.save()

    def last_user_texts(self, n=6):
        return [
            t["text"]
            for t in self.data["conversation"]
            if t["role"] == "user"
        ][-n:]

    # ------------------------------------------------------------- project
    @property
    def current_project(self):
        return self.data["current_project"]

    def set_current_project(self, proj: dict):
        self.data["current_project"] = proj
        self.save()

    # -------------------------------------------------------------- learn
    def remember(self, phrase: str, fact: str):
        from . import persian
        key = persian.soft(phrase)[:120]
        self.data["learned_facts"][key] = fact
        self.save()

    def recall(self, text: str):
        from . import persian
        s = persian.soft(text)
        for phrase, fact in self.data["learned_facts"].items():
            if phrase and phrase in s:
                return fact
        return None

    def add_correction(self, template: str, error: str, fix: str):
        self.data["corrections"].append(
            {"template": template, "error": error[:200], "fix": fix}
        )
        self.data["corrections"] = self.data["corrections"][-50:]
        self.save()

    def recall_correction(self, template: str, error: str):
        for c in reversed(self.data["corrections"]):
            if c["template"] == template and c["error"] in error:
                return c["fix"]
        return None

    def remember_qa(self, question: str, answer: str):
        from . import persian
        key = persian.soft(question)[:160]
        if key not in self.data["qa"]:
            self.data["qa"][key] = answer
            self.save()

    def recall_qa(self, question: str):
        from . import persian
        s = persian.soft(question)
        for q, a in self.data["qa"].items():
            if q and (q in s or s in q):
                return a
        return None
