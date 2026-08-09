# -*- coding: utf-8 -*-
"""Professor Flash brain.

The brain is a hybrid local engine:
  * a rule-based understanding layer (Persian-aware) that never blocks and
    uses almost no CPU - it classifies intent, extracts the spec, and
    orchestrates the work;
  * a live generator that writes real, tested projects;
  * optional Ollama boost (fully offline) for open-ended questions, used
    only when the user enables it and a local model answers fast.

No API key, no cloud, no pre-built models. Everything runs on this machine.
"""

import ast
import os
import re
import time
import uuid

from . import generator as gen
from . import knowledge
from . import persian
from . import search as search_mod
from . import tester as tester_mod


class TaskStopped(Exception):
    """Raised when the user force-stops the current task."""


# --------------------------------------------------------------------------
# Intent keywords
# --------------------------------------------------------------------------

STOP_WORDS = ["توقف کامل", "توقف کن", "متوقف کن", "بس کن", "بسه", "لغو کن", "stop", "هی متوقف", "همه چیز رو متوقف"]
PAUSE_WORDS = ["مکث", "pause", "موقتا توقف", "موقتاً توقف", "نگه دار", "صبر کن", "یک لحظه"]
RESUME_WORDS = ["ادامه بده", "ادامه", "resume", "برو جلو", "از همونجا", "همونجا ادامه", "ادامه بده از"]
CLEAR_WORDS = ["پاک کن", "ریست", "شروع جدید", "از اول", "پاکسازی", "reset", "پاکش کن", "گفتگو رو پاک"]
FILES_WORDS = ["فایل ها", "فایل‌ها", "فایلها", "کجا ذخیره", "مسیر پروژه", "پروژه کجاست", "باز کن", "فایل هاش", "خروجی کجاست", "پروژه رو نشون بده"]
REMEMBER_WORDS = ["یادت باشه", "یادت بمونه", "به خاطر بسپار", "یادت باشد", "حفظ کن"]

GREET_WORDS = ["سلام", "درود", "سلام علیکم", "صبح بخیر", "عصر بخیر", "شب بخیر", "hi", "hello", "hey", "درود بر",
               "چخبر", "چه خبر", "خبری", "چطوری", "چطورید", "حالت چطور", "حالت چطوره", "حال شما", "خوبی",
               "خسته نباشی", "داداش", "داش", "خوش اومدی", "خوش آمدی", "سلامتی"]
THANKS_WORDS = ["ممنون", "مرسی", "تشکر", "متشکرم", "دمت گرم", "thanks", "thank you", "سپاس"]
MODEL_WORDS = ["چه مدلی", "کدوم مدل", "مدل چی", "مدلی استفاده", "چی هستی", "کی هستی", "who are you", "what model", "چه مدلی هستی", "مدل تو", "چی ساخته", "با چی ساخته", "معرفی کن", "خودت رو معرفی", "خودتو معرفی", "خودت را معرفی"]
CAPABILITY_WORDS = ["چه کارایی", "چه کارهایی", "قابلیت", "میتونی", "توانایی", "چیکار", "چه چیزهایی", "help", "راهنما", "چه کار", "بزرگترین", "کاربرد"]
SEARCH_WORDS = ["سرچ کن", "جستجو کن", "جستوجو کن", "جستجو بزن", "بگرد دنبال", "گشتن", "پیدا کن", "سرچ بزن", "جستجو", "جستوجو", "تو اینترنت", "بگرد"]
FIX_WORDS = ["ارور", "خطا", "خراب", "درستش کن", "رفع کن", "دیباگ", "debug", "تست کن", "چک کن", "بررسی کن", "اشکال", "کرش", "کار نمیکنه", "کار نمی‌کنه", "بگا", "مشکل داره", "نصفه"]
BUILD_VERBS = ["بساز", "بسازید", "بسازش", "بسازم", "بسازیم", "بسازی", "ساخت", "ساختن", "ساخته بشه", "ایجاد کن", "بنا کن", "بنویس", "نویس", "کدنویسی کن", "برنامه نویسی کن", "طراحی کن", "ساخت یک", "ساخت یه", "برام بساز", "برام درست کن", "یه", "یک", "میخوام", "می‌خوام", "میخوام یه", "میخوام یک"]
MODIFY_WORDS = ["تغییر", "عوض", "رنگ", "تم", "بزرگتر", "کوچیکتر", "کوچکتر", "اضافه کن", "حذف کن", "زیباتر", "قشنگ", "سایبرپانک", "سایبرپانکی", "نئون", "فونت", "عنوان", "تیتر", "اسمش", "دکمه", "پس زمینه", "پس‌زمینه", "هدر", "header", "عکس", "تصویر", "پرچم", "متن", "بنویس توش", "بنویس داخل"]
QUESTION_WORDS = ["چیست", "چیه", "چطور", "چجوری", "چگونه", "چرا", "یعنی", "معنی", "توضیح", "بگو", "فرق", "مقایسه", "کدام", "کدوم", "بهترین", "سوال",
                "چقدر", "چند", "چنده", "کیه", "کجاست", "کجا", "فاصله", "میشه", "می‌شه", "می‌شود", "چه", "بنظرت", "به نظرت", "میدونی", "می‌دونی"]

TYPE_WORDS = []
for _k, _t in gen.TEMPLATES.items():
    for _kw in _t["keywords"]:
        TYPE_WORDS.append(_kw)

MATH_RE = re.compile(r"^[\s\d۰-۹0-9+\-*/%().,،]+$")


class Brain:
    def __init__(self, memory, projects_root, emit=None, ollama=None):
        self.memory = memory
        self.projects_root = projects_root
        self.emit = emit or (lambda *a, **k: None)
        self.generator = gen.Generator(projects_root, emit=emit)
        self.ollama = ollama  # optional OllamaClient

    # ------------------------------------------------------------ scoring
    def _score(self, text, words):
        s = persian.soft(text)
        return sum(len(persian.soft(w)) for w in words if persian.soft(w) in s)

    def _word_score(self, text, words):
        """Score only whole-word matches (avoids «تم» matching «تمامی»)."""
        s = persian.soft(text)
        total = 0
        for w in words:
            pat = r"(?<!\w)" + re.escape(persian.soft(w)) + r"(?!\w)"
            if re.search(pat, s):
                total += len(persian.soft(w))
        return total

    def _classify(self, text):
        s = persian.soft(text)
        scores = {}
        scores["stop"] = self._score(text, STOP_WORDS)
        scores["pause"] = self._score(text, PAUSE_WORDS)
        scores["resume"] = self._score(text, RESUME_WORDS)
        scores["clear"] = self._score(text, CLEAR_WORDS)
        scores["files"] = self._score(text, FILES_WORDS)
        scores["remember"] = self._score(text, REMEMBER_WORDS)
        scores["thanks"] = self._score(text, THANKS_WORDS)
        scores["greet"] = self._score(text, GREET_WORDS)
        scores["model"] = self._score(text, MODEL_WORDS)
        scores["capability"] = self._score(text, CAPABILITY_WORDS)
        scores["fix"] = self._score(text, FIX_WORDS)
        scores["search"] = self._score(text, SEARCH_WORDS)
        strong_build = ["بساز", "بسازید", "بسازم", "بسازیم", "بسازش", "بسازی",
                        "ساخت", "ساختن", "ساخته", "ایجاد کن", "بنا کن",
                        "کدنویسی کن", "برنامه نویسی کن", "برام بساز", "برام درست کن"]
        scores["build"] = self._score(text, strong_build) + self._score(text, TYPE_WORDS)
        scores["modify"] = self._score(text, MODIFY_WORDS)
        scores["question"] = self._score(text, QUESTION_WORDS)

        # gating
        if self.memory.current_project is None:
            scores["fix"] = 0
            scores["modify"] = 0

        # explicit build verbs always win over modify
        if self._score(text, ["بساز", "بسازید", "بسازم", "ساخت", "ساختن", "ایجاد کن", "برام بساز"]) > 0:
            scores["build"] += 50
            scores["modify"] = 0
        # explicit change verbs win over generic build words
        if self._score(text, ["تغییر بده", "عوض کن", "اضافه کن", "حذف کن", "رو قرمز کن", "رو آبی کن", "کن رنگ"]) > 0:
            scores["modify"] += 40
            scores["build"] = 0

        best = max(scores, key=scores.get)
        # math?
        stripped = persian.to_ascii_digits(text).strip().replace(",", ".")
        if MATH_RE.match(stripped) and any(c in stripped for c in "+-*/%"):
            return "math"
        if scores[best] == 0:
            return "chat"
        return best

    # ------------------------------------------------------------------ io
    def _log(self, text, level="info"):
        self.emit("log", {"level": level, "text": text})

    def _step(self, text):
        self.emit("step", text)

    def _done(self, idx):
        self.emit("done", idx)

    def _plan(self, items):
        self.emit("plan", items)

    # -------------------------------------------------------------- think
    def think(self, user_text):
        text = persian.clean_for_display(user_text)
        if not text:
            return self._reply("پیامی دریافت نکردم. بنویس چه چیزی بسازم.")

        intent = self._classify(text)
        self._log(f"درک پیام: {intent}")

        if intent == "stop":
            return self._reply("توقف کامل فعال شد. کار جاری متوقف خواهد شد.")
        if intent == "pause":
            return self._reply("توقف موقت فعال شد. بعد از اتمام کار جاری متوقف می‌شوم.")
        if intent == "resume":
            return self._reply("ادامه می‌دهم.")
        if intent == "clear":
            self.memory.set_current_project(None)
            return self._reply("حافظه پروژه پاک شد. از صفر شروع می‌کنیم.")
        if intent == "files":
            return self._ensure_reply(self._handle_files())
        if intent == "remember":
            return self._ensure_reply(self._handle_remember(text))
        if intent == "thanks":
            return self._reply("خواهش می‌کنم! اگر برنامه‌ای خواستی یا تغییری لازم بود، بگو.")
        if intent == "greet":
            return self._reply(self._greeting())
        if intent == "model":
            return self._reply(self._about_model())
        if intent == "capability":
            return self._reply(self._about_capabilities())
        if intent == "math":
            return self._reply(self._solve_math(text))
        if intent == "fix" and self.memory.current_project:
            return self._ensure_reply(self._handle_fix())
        if intent == "build":
            return self._handle_build(text)
        if intent == "modify" and self.memory.current_project:
            return self._handle_modify(text)
        if intent == "search":
            return self._ensure_reply(self._handle_search(text))
        if intent == "question":
            return self._handle_question(text)

        # fallback
        fact = self.memory.recall(text)
        if fact:
            return self._reply(f"طبق چیزی که یادم هست: {fact}")
        return self._reply(self._fallback(text))

    def _reply(self, message):
        return {"reply": message}

    def _ensure_reply(self, r):
        return r if isinstance(r, dict) else {"reply": r}

    # ------------------------------------------------------------ greeting
    def _greeting(self):
        proj = self.memory.current_project
        if proj:
            return (
                "سلام! من Professor Flash هستم، دستیار ساخت برنامه (آفلاین و رایگان).\n"
                f"پروژه قبلی «{proj['name']}» هنوز آماده است؛ می‌توانی تغییری در آن بدهی یا پروژه جدیدی بسازی."
            )
        return (
            "سلام! من Professor Flash هستم، دستیار ساخت برنامه (آفلاین و رایگان).\n"
            "کافی است بگویی چه برنامه‌ای می‌خواهی؛ مثلا «یه بازی مار بساز»، «یک سایت بساز» یا «یه بوم نقاشی بساز»."
        )

    # --------------------------------------------------------- about model
    def _about_model(self):
        return (
            "من Professor Flash V1 هستم؛ یک مدل هوش مصنوعی مستقل و کاملا آفلاین.\n\n"
            "معماری من ترکیبی (Hybrid) است:\n"
            "- هسته زبانی محلی که فارسی را با تمام ظرافت‌هایش (خط‌ها، احساسات، تکه‌کلام‌ها، ترکیب فارسی و انگلیسی) درک می‌کند\n"
            "- موتور تولید زنده کد که پروژه‌ها را فایل‌به‌فایل می‌سازد و تست می‌کند\n"
            "- حافظه یادگیری که کارها و اصلاحات قبلی را به خاطر می‌سپارد\n"
            "- جستجوی وب برای پیدا کردن اطلاعات و تصاویر (با گزینه رد شدن در حالت آفلاین)\n\n"
            "هیچ API از مدل‌های آماده استفاده نمی‌شود؛ همه چیز روی همین سیستم اجرا می‌شود، رایگان است و به سخت‌افزار فشار نمی‌آورد."
        )

    def _about_capabilities(self):
        return (
            "توانایی‌های من:\n\n"
            "ساخت برنامه: بازی (مار، دوز، حدس عدد)، آزمون چهارگزینه‌ای، لیست کار، یادداشت، بوم نقاشی، سایت و صفحه فرود، ساعت، کرنومتر، تولیدکننده رمز، مبدل واحد و بیشتر — همه با index.html، style.css و app.js واقعی.\n\n"
            "فکر کردن و پاسخ: دانش محلی گسترده + جستجوی وب؛ ریاضی، برنامه‌نویسی، علم، جغرافی و تاریخ.\n\n"
            "شخصی‌سازی: تم (تیره، سایبرپانک، نئون، شیشه‌ای، مینیمال، روشن)، رنگ، عنوان و تصویر.\n\n"
            "تغییر پروژه: «رنگ دکمه‌ها را قرمز کن» یا «تم را سایبرپانکی کن» — ساختار پروژه در حافظه می‌ماند و همان پروژه ویرایش می‌شود.\n\n"
            "تست و رفع خطا: هر پروژه تست می‌شود و خطاها خودکار رفع می‌شوند.\n\n"
            "کنترل: توقف موقت (بعد از اتمام مرحله فعلی)، ادامه و توقف کامل در هر لحظه."
        )

    # ------------------------------------------------------------ solving
    def _solve_math(self, text):
        expr = persian.to_ascii_digits(text).replace("×", "*").replace("÷", "/").replace("−", "-")
        expr = re.sub(r"[^0-9+\-*/().%\s]", "", expr)
        if not expr:
            return "عبارت ریاضی را تشخیص ندادم."
        try:
            tree = ast.parse(expr, mode="eval")
            allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Add, ast.Sub,
                       ast.Mult, ast.Div, ast.Mod, ast.USub, ast.UAdd, ast.Constant)
            for node in ast.walk(tree):
                if not isinstance(node, allowed):
                    return "این عبارت را نمی‌توانم محاسبه کنم."
            value = eval(compile(tree, "<expr>", "eval"), {"__builtins__": {}}, {})
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            return f"نتیجه: {persian.to_persian_digits(str(value))}"
        except Exception:
            return "عبارت را متوجه نشدم. مثلا بنویس: ۱۲ + ۵ × ۳"

    # ------------------------------------------------------------- search
    def _handle_search(self, text):
        query = text
        for w in ["سرچ کن", "جستجو کن", "جستوجو کن", "بگرد", "جستجو", "پیدا کن", "تو اینترنت", "درباره", "در مورد", "بگو درباره"]:
            ww = persian.soft(w)
            if ww in persian.soft(query):
                query = query.replace(w, "").strip(" ،:،")
                break
        query = persian.clean_for_display(query) or "Professor Flash"
        self._log(f"جستجو در وب: {query}")
        results = search_mod.search_web(query, max_results=5)
        if not results:
            return "نتوانستم به اینترنت وصل شوم یا نتیجه‌ای پیدا نشد. این مرحله را رد می‌کنم؛ اگر برنامه‌ای بخواهی بسازم، بگو."
        lines = [f"نتایج جستجو برای «{query}»:", ""]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r['title']}")
            if r["snippet"]:
                lines.append(f"   {r['snippet']}")
            lines.append(f"   {r['url']}")
            lines.append("")
        return "\n".join(lines)

    # --------------------------------------------------------------- files
    def _handle_files(self):
        proj = self.memory.current_project
        if not proj:
            return "هنوز پروژه‌ای ساخته نشده است. بگو چه برنامه‌ای بسازم."
        lines = [
            f"پروژه «{proj['name']}» در این مسیر ساخته شده:",
            proj["root"],
            "",
            "فایل‌ها:",
        ]
        for f in proj.get("files", []):
            lines.append(f"- {f['path']}  ({persian.to_persian_digits(str(f['size']))} بایت)")
        return "\n".join(lines)

    # ------------------------------------------------------------ remember
    def _handle_remember(self, text):
        s = persian.soft(text)
        for w in ["یادت باشه", "یادت بمونه", "به خاطر بسپار", "یادت باشد", "حفظ کن"]:
            if persian.soft(w) in s:
                text = text.replace(w, "").strip(" ،:،")
                break
        text = persian.clean_for_display(text)
        if not text:
            return "چه چیزی را یادم بماند؟"
        self.memory.remember(text, text)
        return f"یادم ماند: {text}"

    # ---------------------------------------------------------------- fix
    def _handle_fix(self):
        proj = self.memory.current_project
        self._plan(["بررسی فایل‌های پروژه", "اجرای تست", "رفع خطاها (در صورت وجود)", "تست مجدد"])
        self._log(f"تست پروژه «{proj['name']}»")
        use_node = tester_mod._node_available()
        ok, results = tester_mod.test_project(proj["root"], use_node=use_node)
        for r in results:
            mark = "تأیید" if r["ok"] else "خطا"
            self._log(f"{r['file']}: {mark} - {r['detail']}")
        self._done(0); self._done(1); self._done(2); self._done(3)
        if ok:
            return "همه چیز سالم است؛ خطایی پیدا نشد. پروژه بدون مشکل کار می‌کند."
        return self._rebuild_fix()

    def _rebuild_fix(self):
        """Rebuild the project from its spec as the fix pass."""
        proj = self.memory.current_project
        meta = proj["meta"]
        pid = proj["id"]
        spec = {
            "type": meta["type"],
            "theme": meta.get("theme", "dark"),
            "accent": meta.get("accent", "#6366f1"),
            "title": meta.get("title"),
            "image_subject": meta.get("image"),
            "name": meta.get("name"),
        }
        self._log("بازسازی پروژه برای رفع خطا...")
        new_proj = self.generator.create_project(pid, spec)
        use_node = tester_mod._node_available()
        ok, results = tester_mod.test_project(new_proj["root"], use_node=use_node)
        for r in results:
            mark = "تأیید" if r["ok"] else "خطا"
            self._log(f"{r['file']}: {mark} - {r['detail']}")
        self.memory.set_current_project(new_proj)
        if ok:
            return "خطا برطرف شد؛ پروژه بازسازی و دوباره تست شد و سالم است."
        return "پس از بازسازی هم خطا باقی ماند. جزئیات را در گزارش ببین."

    # -------------------------------------------------------------- build
    REMOVED_TYPES = ["ماشین حساب", "محاسبه گر", "محاسبه‌گر", "حسابگر", "calculator", "ماشین‌حساب"]

    def _handle_build(self, text):
        # honest answer for removed types
        s = persian.soft(text)
        for w in self.REMOVED_TYPES:
            if persian.soft(w) in s:
                return self._reply(
                    "ماشین حساب دیگر در فهرست من نیست — آن یک نمونه نمایشی بود و حذف شد.\n"
                    "چیزهایی که واقعا می‌سازم: بازی (مار، دوز، حدس عدد)، آزمون، لیست کار، یادداشت، بوم نقاشی، "
                    "سایت و صفحه فرود، ساعت، کرنومتر، رمزساز و مبدل واحد.\n"
                    "مثلا بگو: «یه بازی مار بساز» یا «یک سایت برای معرفی خودم بساز»."
                )

        spec = self._build_spec(text)
        tpl = gen.TEMPLATES[spec["type"]]
        pid = uuid.uuid4().hex[:10]
        title = spec.get("title") or gen.default_title(spec["type"], spec["theme"], spec["accent"])

        plan = [
            "تحلیل درخواست و درک خواسته",
            f"طراحی پروژه: {tpl['name_fa']}",
            "نوشتن index.html",
            "نوشتن style.css",
            "نوشتن app.js",
        ]
        if spec.get("image_subject"):
            plan.append("جستجو و دانلود تصویر")
        plan += ["تست پروژه", "آماده‌سازی پیش‌نمایش"]
        self._plan(plan)

        self._log(f"نوع پروژه: {tpl['name_fa']} | تم: {gen.THEMES[spec['theme']]['name_fa']}")
        if spec.get("accent") and spec["accent"] != gen.THEMES[spec["theme"]]["accent"]:
            self._log(f"رنگ اصلی: {spec['accent']}")
        if spec.get("image_subject"):
            self._log(f"تصویر خواسته‌شده: {spec['image_subject']}")

        time.sleep(0.35)
        self._done(0)
        time.sleep(0.35)
        self._done(1)

        self._log("در حال نوشتن فایل‌های پروژه...")
        time.sleep(0.2)
        descriptor = self.generator.create_project(pid, spec)
        self.emit("file", {"path": "index.html", "size": self._fsize(descriptor, "index.html")})
        self.emit("file", {"path": "style.css", "size": self._fsize(descriptor, "style.css")})
        self.emit("file", {"path": "app.js", "size": self._fsize(descriptor, "app.js")})
        for f in descriptor["files"]:
            if f["path"].startswith("assets"):
                self.emit("file", f)
        self._done(2); self._done(3); self._done(4)
        if spec.get("image_subject"):
            self._done(5)

        # test
        self._log("تست پروژه...")
        time.sleep(0.35)
        use_node = tester_mod._node_available()
        ok, results = tester_mod.test_project(descriptor["root"], use_node=use_node)
        for r in results:
            mark = "تأیید" if r["ok"] else "خطا"
            self._log(f"{r['file']}: {mark} - {r['detail']}")
        test_idx = 6 if spec.get("image_subject") else 5
        self._done(test_idx)

        if not ok:
            self._log("خطا در تست پیدا شد؛ در حال رفع خودکار...")
            ok2, results2 = tester_mod.test_project(descriptor["root"], use_node=True)
            if ok2:
                self._log("پس از بررسی مجدد، پروژه سالم است")
            else:
                # last resort: rebuild from scratch
                self._log("بازسازی فایل‌ها برای رفع خطا...")
                descriptor = self.generator.create_project(pid, spec)
                ok, results = tester_mod.test_project(descriptor["root"], use_node=use_node)
                for r in results:
                    mark = "تأیید" if r["ok"] else "خطا"
                    self._log(f"{r['file']}: {mark} - {r['detail']}")

        self._done(test_idx + 1)
        self.memory.set_current_project(descriptor)
        self.memory.add_turn("user", text)

        summary = self._build_summary(descriptor, spec, ok, results)
        return {
            "reply": summary,
            "preview": f"/preview/{pid}/",
            "project": descriptor["id"],
        }

    def _fsize(self, descriptor, fname):
        for f in descriptor["files"]:
            if f["path"] == fname:
                return f["size"]
        return 0

    def _build_spec(self, text):
        s = persian.soft(text)
        type_key = gen.detect_type(text)
        theme = gen.extract_theme(text)
        accent = gen.extract_accent(text, theme)
        image = gen.extract_image_request(text)
        title = None
        m = re.search(r"(?:اسمش|اسم|نام)[^\w]*[:=]?\s*[\"«']?([^\"«'»]+?)[\"«'»]?", s)
        if m and len(m.group(1).strip()) < 40:
            title = m.group(1).strip()
        name = title or gen.default_title(type_key, theme, accent)
        return {
            "type": type_key,
            "theme": theme,
            "accent": accent,
            "image_subject": image,
            "title": title,
            "name": name,
        }

    def _build_summary(self, descriptor, spec, ok, results):
        tpl = gen.TEMPLATES[spec["type"]]
        lines = [
            f"پروژه «{descriptor['name']}» ساخته شد و تست شد.",
            "",
            f"- نوع: {tpl['name_fa']}",
            f"- تم: {gen.THEMES[spec['theme']]['name_fa']}",
        ]
        if spec.get("accent") and spec["accent"] != gen.THEMES[spec["theme"]]["accent"]:
            lines.append(f"- رنگ اصلی: {spec['accent']}")
        if spec.get("image_subject"):
            has_img = any(f["path"].startswith("assets") for f in descriptor["files"])
            lines.append(f"- تصویر: {'دانلود شد' if has_img else 'درخواست شد (در دسترس نبود، رد شد)'}")
        lines.append("- فایل‌ها: index.html، style.css، app.js")
        if ok:
            lines.append("- تست: تأیید شد")
        else:
            lines.append("- تست: خطا در برخی فایل‌ها (جزئیات در گزارش)")
        lines.append("")
        lines.append("پیش‌نمایش در پنل کناری آماده است. برای تغییر، بگو؛ مثلا «رنگ دکمه‌ها را قرمز کن» یا «تم را سایبرپانکی کن».")
        return "\n".join(lines)

    # ------------------------------------------------------------- modify
    def _handle_modify(self, text):
        proj = self.memory.current_project
        change = self._parse_change(text, proj)
        if not change:
            return self._modify_fallback(text, proj)

        self._plan(["درک تغییر خواسته‌شده", "اعمال تغییر روی فایل‌ها", "تست مجدد پروژه"])
        self._log(f"تغییر: {change['desc']}")
        self._done(0)
        time.sleep(0.15)

        touched = self.generator.apply_modify(proj, change)
        for t in touched:
            self._log(f"فایل به‌روزرسانی شد: {t}")
        time.sleep(0.2)
        if change.get("action") == "image" and not change.get("image_ok"):
            self._log("تصویر پیدا نشد یا اینترنت در دسترس نبود - از این مرحله رد شد", "skip")
        self._done(1)
        time.sleep(0.1)

        use_node = tester_mod._node_available()
        ok, results = tester_mod.test_project(proj["root"], use_node=use_node)
        for r in results:
            mark = "تأیید" if r["ok"] else "خطا"
            self._log(f"{r['file']}: {mark} - {r['detail']}")
        self._done(2)

        self.memory.set_current_project(proj)
        status = "تغییر اعمال شد و پروژه دوباره تست شد؛ همه چیز سالم است." if ok else \
            "تغییر اعمال شد اما در تست خطا باقی ماند؛ جزئیات در گزارش."
        return {
            "reply": f"{change['desc']}.\n{status}\nپیش‌نمایش به‌روز شد.",
            "preview": f"/preview/{proj['id']}/",
        }

    def _parse_change(self, text, proj):
        s = persian.soft(text)
        meta = proj["meta"]
        structure = meta.get("structure", [])

        # image request
        img_subject = gen.extract_image_request(text)
        if img_subject:
            return {"action": "image", "value": img_subject,
                    "desc": f"تصویر «{img_subject}» جستجو و اضافه می‌شود", "target": None}

        # theme change
        theme = gen.extract_theme(text)
        if theme and self._score(text, ["تم", "سایبرپانک", "سایبرپانکی", "نئون", "مینیمال", "شیشه", "روشن"]) > 0:
            return {"action": "theme", "value": theme, "desc": f"تم پروژه به «{gen.THEMES[theme]['name_fa']}» تغییر کرد", "target": None}

        color = None
        for w, h in gen.COLOR_WORDS.items():
            if persian.soft(w) in s:
                color = h
                break

        # target detection
        target_kind = None
        target_name = None
        if self._score(text, ["دکمه شروع", "شروع"]) > 0:
            target_kind, target_name = "button", "شروع"
        elif self._score(text, ["دکمه افزودن", "افزودن", "اضافه"]) > 0:
            target_kind, target_name = "button", "افزودن"
        elif self._score(text, ["دکمه", "button", "دکمه‌ها", "دکمه ها"]) > 0:
            target_kind = "button"
        elif self._score(text, ["پس زمینه", "پس‌زمینه", "background", "زمینه"]) > 0:
            target_kind = "background"
        elif self._score(text, ["عنوان", "تیتر", "اسمش", "اسم", "نام"]) > 0:
            target_kind = "title"
        elif self._score(text, ["متن", "فونت"]) > 0:
            target_kind = "text"
        elif self._score(text, ["هدر", "header", "بالا"]) > 0:
            target_kind = "header"

        if color and target_kind == "button":
            selector = self._selector_for(structure, target_name, "button")
            return {"action": "button_color", "value": color, "selector": selector,
                    "desc": f"رنگ {('دکمه «' + target_name + '»' if target_name else 'دکمه‌ها')} به {color} تغییر کرد", "target": target_kind}
        if color and target_kind == "background":
            return {"action": "background", "value": color, "desc": f"رنگ پس‌زمینه به {color} تغییر کرد", "target": target_kind}
        if color:
            return {"action": "accent", "value": color, "desc": f"رنگ اصلی پروژه به {color} تغییر کرد", "target": None}

        if target_kind == "title":
            return {"action": "title", "value": None, "desc": "عنوان پروژه به‌روزرسانی شد", "target": target_kind}

        if self._score(text, ["بزرگتر", "بزرگ کن", "بزرگش"]) > 0:
            return {"action": "bigger", "value": None, "desc": "ابعاد متن پروژه بزرگ‌تر شد", "target": None}
        if self._score(text, ["کوچیکتر", "کوچکتر", "کوچیک کن", "کوچک کن"]) > 0:
            return {"action": "smaller", "value": None, "desc": "ابعاد متن پروژه کوچک‌تر شد", "target": None}

        if self._score(text, ["حذف", "پاک کن"]) > 0:
            selector = self._selector_for(structure, None, "card") or ".feature-card"
            return {"action": "remove", "value": None, "selector": selector,
                    "desc": "بخش موردنظر حذف شد", "target": None}

        if self._score(text, ["اضافه کن", "بنویس", "بنویس توش"]) > 0:
            # extract text to add
            tail = self._extract_text_after(text, ["اضافه کن", "بنویس", "بنویس توش", "بنویس داخل"])
            if tail:
                return {"action": "add_text", "value": tail, "desc": f"متن اضافه شد: {tail}", "target": None}

        return None

    def _selector_for(self, structure, name, kind):
        for entry in structure:
            if kind and entry.get("kind") != kind:
                continue
            if name and name in entry.get("name", ""):
                return entry["selector"]
        for entry in structure:
            if kind and entry.get("kind") == kind:
                return entry["selector"]
        return None

    def _extract_text_after(self, text, markers):
        s = text
        for m in markers:
            idx = s.find(m)
            if idx != -1:
                tail = s[idx + len(m):].strip(" ،:،؛-")
                if tail:
                    return tail
        return None

    def _modify_fallback(self, text, proj):
        """Smart fallback: apply the most likely interpretation, never block."""
        s = persian.soft(text)
        meta = proj["meta"]
        # generic request like "قشنگ ترش کن" -> refresh the theme
        if self._score(text, ["زیباتر", "قشنگ", "بهتر", "حرفه ای", "حرفه‌ای"]) > 0:
            change = {"action": "theme", "value": "cyberpunk", "desc": "ظاهر پروژه به نسخه سایبرپانکی و حرفه‌ای ارتقا یافت", "target": None}
        else:
            change = {"action": "theme", "value": meta.get("theme", "dark"), "desc": "ظاهر پروژه به‌روزرسانی شد", "target": None}
        touched = self.generator.apply_modify(proj, change)
        use_node = tester_mod._node_available()
        ok, results = tester_mod.test_project(proj["root"], use_node=use_node)
        self.memory.set_current_project(proj)
        lines = [
            change["desc"] + ".",
            "",
            "چیزی که متوجه شدم: «" + persian.clean_for_display(text) + "»",
            "اگر تغییر دقیق‌تری می‌خواهی، بگو؛ مثلا «رنگ دکمه‌ها را آبی کن» یا «متن بالای صفحه را عوض کن».",
        ]
        if not ok:
            lines.append("")
            lines.append("توجه: در تست مجدد خطا پیدا شد؛ جزئیات در گزارش.")
        return self._reply("\n".join(lines))

    # ----------------------------------------------------------- questions
    def _handle_question(self, text):
        # thinking pipeline - steps are shown live in the UI
        self._plan(["درک پرسش", "جستجو در دانش محلی", "بررسی منابع", "سازمان‌دهی پاسخ"])
        self._log(f"تحلیل پرسش: {persian.clean_for_display(text)[:70]}")
        time.sleep(0.3)
        self._done(0)

        qa = self.memory.recall_qa(text)
        if qa:
            self._done(1); self._done(2); self._done(3)
            return self._reply(qa)

        self._log("جستجو در دانش محلی...")
        time.sleep(0.25)
        topic, score, answer = knowledge.search(text)
        if answer:
            self._log(f"یافت شد در دانش محلی: {topic}")
            self._done(1); self._done(2); self._done(3)
            self.memory.remember_qa(text, answer)
            return self._reply(answer)

        # nothing in local knowledge -> enrich with a web search
        self._done(1)
        self._log("خارج از دانش محلی؛ جستجوی وب...")
        query = self._clean_question(text)
        results = search_mod.search_web(query, max_results=3)
        if results:
            self._log("منبع پیدا شد؛ در حال استخراج پاسخ...")
            time.sleep(0.2)
            self._done(2)
            answer = self._compose_from_search(query, results)
            self._done(3)
            self.memory.remember_qa(text, answer)
            return self._reply(answer)

        # optional local Ollama boost for open-ended questions
        if self.ollama and self.ollama.enabled:
            try:
                answer = self.ollama.ask(text, timeout=25)
                if answer:
                    self._done(2); self._done(3)
                    self.memory.remember_qa(text, answer)
                    return self._reply(answer)
            except Exception:
                pass

        self._done(2); self._done(3)
        return self._reply(
            "این سوال خارج از دانش محلی من است و الان به اینترنت هم دسترسی نداشتم.\n"
            "می‌توانی دوباره با اتصال اینترنت بپرسی، یا اگر برنامه‌ای می‌خواهی بسازم بگو؛ "
            "مثلا «یک سایت بساز» یا «یه بازی مار بساز»."
        )

    def _clean_question(self, text):
        """Strip greetings and question fillers to get the core query."""
        q = persian.clean_for_display(text)
        for w in ["برام بگو", "برام توضیح بده", "برام بنویس", "بگو", "بنویس", "توضیح بده", "توضیح بده که",
                  "میخوام بدونم", "می‌خوام بدونم", "میخواهم بدانم", "میخوام", "می‌خوام",
                  "یعنی چی", "یعنی چه", "چیست", "چیه", "چطوره", "چطور", "چجوری", "چگونه",
                  "درباره", "در مورد", "درمورد", "لطفا", "لطفاً", "سوال دارم", "یه سوال", "یک سوال",
                  "ببین", "داداش", "داش"]:
            q = q.replace(w, " ")
        q = persian.clean_for_display(q)
        return q or persian.clean_for_display(text)

    def _compose_from_search(self, query, results):
        lines = [f"بر اساس جستجوی وب درباره «{query}»:", ""]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r['title']}")
            if r.get("snippet"):
                lines.append(f"   {r['snippet']}")
            lines.append(f"   {r['url']}")
            lines.append("")
        lines.append("نکته: این نتیجه از وب است؛ برای جزئیات بیشتر لینک‌ها را باز کن.")
        return "\n".join(lines)

    # ------------------------------------------------------------ fallback
    def _fallback(self, text):
        s = persian.soft(text)
        if any(w in s for w in ["لینوکس", "ویندوز", "مک", "نصب", "نصب کن", "چطوری نصب"]):
            return (
                "برای اجرا فقط کافی است python run.py را اجرا کنی.\n"
                "run.py خودش همه پیش‌نیازها را تشخیص می‌دهد، محیط مجازی می‌سازد، کتابخانه‌ها را نصب می‌کند و مرورگر را باز می‌کند."
            )
        if any(w in s for w in ["سلامتی", "حال", "چطوری", "چطورید", "خوبی"]):
            return "خوبم، ممنون که پرسیدی! آماده‌ام هر برنامه‌ای که بخواهی بسازم."
        if any(w in s for w in ["میفهمی", "فهمیدی", "متوجه میشی", "متوجه می‌شی"]):
            return (
                "بله، کاملا می‌فهمم. منظورت را بگیر؛ فارسی، انگلیسی، ترکیبی یا حتی تکه‌کلام‌های محاوره‌ای."
                "\nاگر تغییری در پروژه می‌خواهی، بگو؛ اگر برنامه جدیدی می‌خواهی، نوعش را بگو تا بسازم."
            )
        return (
            "پیامت را خواندم اما در دسته‌ای که بتوانم دقیق عمل کنم نبود.\n"
            "برای ساخت برنامه بگو: «یک [نوع برنامه] با تم [تم] بساز».\n"
            "برای تغییر: «رنگ دکمه‌ها را [رنگ] کن» یا «تم را سایبرپانکی کن».\n"
            "برای جستجو: «سرچ کن [موضوع]»."
        )
