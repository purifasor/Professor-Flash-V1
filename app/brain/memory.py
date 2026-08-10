# -*- coding: utf-8 -*-
"""Persistent memory: sessions, conversation history, current project.

Everything is stored in a single JSON file (memory.json) so the model can
continue previous work after a restart. Writes are atomic (temp file +
rename) so a crash never corrupts the memory.
"""

import json
import os
import threading
import time
import uuid


class Memory:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.data = {
            "sessions": [],          # [{id, title, messages:[{id,role,text,time,kind}], updated}]
            "active_session": None,  # session id
            "current_project": None, # project descriptor dict
            "agent_config": None,    # agent tab settings {path, name}
            "learned_facts": {},     # keyword phrase -> fact text
            "corrections": [],       # [{template, error, fix}]
            "qa": {},                # question soft-text -> answer
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

    # ------------------------------------------------------------ sessions
    def ensure_session(self):
        """Return the active session, creating one when needed."""
        sid = self.data.get("active_session")
        for s in self.data["sessions"]:
            if s["id"] == sid:
                return s
        s = {"id": uuid.uuid4().hex[:10], "title": "گفتگوی جدید",
             "messages": [], "updated": time.time()}
        self.data["sessions"].insert(0, s)
        self.data["active_session"] = s["id"]
        self.data["sessions"] = self.data["sessions"][:50]
        self.save()
        return s

    def sessions(self):
        return sorted(self.data["sessions"], key=lambda s: s.get("updated", 0), reverse=True)

    def get_session(self, sid):
        for s in self.data["sessions"]:
            if s["id"] == sid:
                return s
        return None

    def set_active_session(self, sid):
        if self.get_session(sid):
            self.data["active_session"] = sid
            self.save()
            return True
        return False

    def new_session(self):
        self.data["active_session"] = None
        self.ensure_session()
        return self.data["active_session"]

    def delete_session(self, sid):
        if self.data.get("active_session") == sid:
            self.data["active_session"] = None
        self.data["sessions"] = [s for s in self.data["sessions"] if s["id"] != sid]
        self.ensure_session()
        self.save()

    def rename_session(self, sid, title):
        s = self.get_session(sid)
        if s:
            s["title"] = (title or "گفتگوی جدید")[:40]
            self.save()

    def add_message(self, sid, role, text, kind="text"):
        s = self.get_session(sid) or self.ensure_session()
        mid = uuid.uuid4().hex[:10]
        s["messages"].append({"id": mid, "role": role, "text": text,
                              "time": time.time(), "kind": kind})
        s["updated"] = time.time()
        s["messages"] = s["messages"][-300:]
        if s["title"] == "گفتگوی جدید" and role == "user":
            s["title"] = text.strip()[:30]
        self.save()
        return mid

    def delete_message(self, sid, mid):
        s = self.get_session(sid)
        if not s:
            return False
        before = len(s["messages"])
        s["messages"] = [m for m in s["messages"] if m["id"] != mid]
        s["updated"] = time.time()
        self.save()
        return len(s["messages"]) != before

    # ------------------------------------------------------------ history
    def add_turn(self, role: str, text: str):
        s = self.ensure_session()
        self.add_message(s["id"], role, text)

    def last_user_texts(self, n=6):
        s = self.ensure_session()
        return [m["text"] for m in s["messages"] if m["role"] == "user"][-n:]

    # ------------------------------------------------------------- project
    @property
    def current_project(self):
        return self.data["current_project"]

    def set_current_project(self, proj: dict):
        self.data["current_project"] = proj
        self.save()

    # ------------------------------------------------------- agent config
    @property
    def agent_config(self):
        return self.data.get("agent_config") or {}

    def set_agent_config(self, cfg: dict):
        self.data["agent_config"] = cfg
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
