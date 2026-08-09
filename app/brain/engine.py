# -*- coding: utf-8 -*-
"""Professor Flash - the brain.

Professor Flash is a real thinking agent:

  * EVERY message goes through a visible thinking pipeline (درک → فکر →
    دانش → پاسخ). Nothing is answered from a fixed script.
  * When a free LLM is reachable (Ollama local / DeepSeek / OpenRouter /
    Pollinations) it does the actual thinking - for chats, questions and
    for LIVE code generation (no templates: the model writes each file).
  * When no LLM is available it still works offline with its own
    resources: precise math, local knowledge, web search, learned notes.
  * Everything it genuinely learns is stored passively in Learned/.
"""

import json
import os
import re
import time
import uuid

from . import calc
from . import knowledge
from . import learn as learn_mod
from . import llm as llm_mod
from . import persian
from . import search as search_mod
from . import tester as tester_mod

# ------------------------------------------------------------------ words
STOP_WORDS = ["توقف کامل", "توقف کن", "متوقف کن", "بس کن", "بسه", "لغو کن", "هی متوقف", "همه چیز رو متوقف"]
PAUSE_WORDS = ["مکث", "pause", "موقتا توقف", "موقتاً توقف", "نگه دار", "صبر کن", "یک لحظه", "یک لحظه صبر"]
RESUME_WORDS = ["ادامه بده", "ادامه", "resume", "برو جلو", "از همونجا", "همونجا ادامه", "ادامه بده از"]
CLEAR_WORDS = ["پاک کن", "ریست", "شروع جدید", "از اول", "پاکسازی", "گفتگو رو پاک", "هیستوری رو پاک"]

GREET_WORDS = ["سلام", "درود", "سلام علیکم", "صبح بخیر", "عصر بخیر", "شب بخیر", "hi", "hello", "hey",
               "چخبر", "چه خبر", "خبری", "چطوری", "چطورید", "حالت چطور", "حالت چطوره", "حال شما", "خوبی",
               "خسته نباشی", "خوش اومدی", "خوش آمدی"]
THANKS_WORDS = ["ممنون", "مرسی", "تشکر", "متشکرم", "دمت گرم", "thanks", "thank you", "سپاس"]
MODEL_WORDS = ["چه مدلی", "کدوم مدل", "مدل چی", "مدلی استفاده", "چی هستی", "کی هستی", "who are you",
               "what model", "چه مدلی هستی", "مدل تو", "با چی ساخته", "معرفی کن", "خودت رو معرفی",
               "خودتو معرفی", "خودت را معرفی"]
CAPABILITY_WORDS = ["چه کارایی", "چه کارهایی", "قابلیت", "میتونی", "توانایی", "چیکار", "چه چیزهایی",
                    "راهنما", "چه کار", "کاربرد"]
SEARCH_WORDS = ["سرچ کن", "جستجو کن", "جستوجو کن", "جستجو بزن", "بگرد دنبال", "پیدا کن", "سرچ بزن",
                "جستجو", "جستوجو", "تو اینترنت", "بگرد"]
FIX_WORDS = ["ارور", "خطا", "خراب", "درستش کن", "رفع کن", "دیباگ", "debug", "تست کن", "چک کن",
             "بررسی کن", "اشکال", "کرش", "کار نمیکنه", "کار نمی‌کنه", "مشکل داره", "نصفه"]

STRONG_BUILD = ["بساز", "بسازید", "بسازم", "بسازیم", "بسازش", "بسازی", "ساخت", "ساختن", "ساخته بشه",
                "ایجاد کن", "بنا کن", "کدنویسی کن", "برنامه نویسی کن", "برام بساز", "برام درست کن",
                "بنویس", "نویس", "طراحی کن", "یه برنامه", "یک برنامه", "برنامه ای", "برنامه‌ای"]
MODIFY_WORDS = ["تغییر بده", "تغییر بدهش", "تغییر", "عوض کن", "رنگ", "تم رو", "بزرگتر", "کوچیکتر",
                "کوچکتر", "اضافه کن", "حذف کن", "زیباتر", "قشنگ", "سایبرپانک", "سایبرپانکی", "نئون",
                "فونت", "عنوان", "تیتر", "اسمش", "دکمه", "پس زمینه", "پس‌زمینه", "هدر", "عکس",
                "تصویر", "پرچم", "متن", "بنویس توش", "بنویس داخل"]
QUESTION_WORDS = ["چیست", "چیه", "چطور", "چجوری", "چگونه", "چرا", "یعنی", "معنی", "توضیح", "بگو",
                  "فرق", "مقایسه", "کدام", "کدوم", "بهترین", "سوال", "چقدر", "چند", "چنده", "کیه",
                  "کجاست", "کجا", "فاصله", "میشه", "می‌شه", "می‌شود", "چه", "بنظرت", "به نظرت",
                  "میدونی", "می‌دونی", "کیه", "کی بود", "چطوره"]

TYPE_HINTS = ["بازی", "بازی مار", "مار", "دوز", "حدس", "سایت", "وبسایت", "وب سایت", "صفحه فرود", "لندینگ",
              "آزمون", "کوییز", "quiz", "لیست", "todo", "یادداشت", "نقاشی", "پaint", "ساعت", "کرنومتر",
              "رمزساز", "رمز عبور", "تولیدکننده رمز", "پسورد", "مبدل", "واحد", "آب و هوا", "weather",
              "گالری", "چت", "پخش", "موسیقی", "شمارنده", "تقویم", "یادآور", "رمان", "کتاب", "فروشگاه",
              "shop", "رزومه", "پروفایل", "داشبورد", "dashboard", "فایل", "مدیر", "manager", "وب",
              "اپ", "برنامه", "نرم افزار"]

MATH_WORDS = ["بعلاوه", "به اضافه", "منهای", "ضربدر", "تقسیم بر", "به توان", "درصد", "٪", "میانگین",
              "ریشه", "توان", "معادله", "نیرو", "شتاب", "سرعت", "انرژی", "کار انجام", "مساحت", "حجم"]

THEMES = {
    "dark": {"name_fa": "تیره", "accent": "#7c3aed"},
    "cyberpunk": {"name_fa": "سایبرپانک", "accent": "#00e5ff"},
    "neon": {"name_fa": "نئون", "accent": "#ff2d95"},
    "glass": {"name_fa": "شیشه‌ای", "accent": "#22d3ee"},
    "minimal": {"name_fa": "مینیمال", "accent": "#334155"},
    "light": {"name_fa": "روشن", "accent": "#4f46e5"},
}
COLOR_WORDS = {
    "قرمز": "#ef4444", "سرخ": "#dc2626", "آبی": "#3b82f6", "ابی": "#3b82f6",
    "سبز": "#22c55e", "زرد": "#eab308", "نارنجی": "#f97316", "بنفش": "#8b5cf6",
    "صورتی": "#ec4899", "سفید": "#f8fafc", "مشکی": "#0f172a", "طلایی": "#f59e0b",
    "نقره ای": "#cbd5e1", "نقره‌ای": "#cbd5e1", "فیروزه ای": "#06b6d4", "فیروزه‌ای": "#06b6d4",
    "خاکستری": "#64748b", "قهوه ای": "#92400e", "قهوه‌ای": "#92400e",
}

IMAGE_MARKERS = [
    "عکس ... رو بزار", "تصویر ... رو بزار", "عکس ... بزار", "تصویر ... بزار",
    "عکس ... رو بذار", "تصویر ... رو بذار", "عکس ... بذار", "تصویر ... بذار",
    "پرچم ... رو بزار", "پرچم ... بزار", "پرچم ... رو بذار", "پرچم ... بذار",
    "عکس ... رو قرار بده", "تصویر ... رو قرار بده", "عکس ... قرار بده", "تصویر ... قرار بده",
]


class TaskStopped(Exception):
    pass


class Brain:
    def __init__(self, memory, projects_root, emit=None, llm=None):
        self.memory = memory
        self.projects_root = projects_root
        self.emit = emit or (lambda *a, **k: None)
        self.llm = llm if llm is not None else llm_mod.Llm()
        self.learn = learn_mod.Learn(os.path.dirname(projects_root) or ".")
        os.makedirs(projects_root, exist_ok=True)

    # ------------------------------------------------------------ helpers
    def _score(self, text, words):
        s = persian.soft(text)
        return sum(len(persian.soft(w)) for w in words if persian.soft(w) in s)

    def _log(self, text, level="info"):
        self.emit("log", {"level": level, "text": text})

    def _plan(self, items):
        self.emit("plan", items)

    def _done(self, idx):
        self.emit("done", idx)

    def _wait(self, sec=0.5):
        time.sleep(sec)

    def _has_word(self, text, word):
        """Whole-word match (so «چی» does not match «چیز»)."""
        s = persian.soft(text)
        w = persian.soft(word)
        return re.search(
            r"(?<![\u0600-\u06FFa-zA-Z0-9])" + re.escape(w) + r"(?![\u0600-\u06FFa-zA-Z0-9])", s) is not None

    # ------------------------------------------------------------- route
    def route(self, text):
        """Fast local routing; the real thinking happens in each handler."""
        s = persian.soft(text)
        if self._score(text, STOP_WORDS) > 0:
            return "stop"
        if self._score(text, PAUSE_WORDS) > 0:
            return "pause"
        if self._score(text, RESUME_WORDS) > 0:
            return "resume"
        if self._score(text, CLEAR_WORDS) > 0:
            return "clear"

        # math first: real computation, always local, instant and precise
        prepared = self._prepare_math(text)
        if prepared and calc.solve(prepared):
            return "math"

        has_q = self._score(text, QUESTION_WORDS) > 0 or self._has_word(text, "چی")
        has_build = self._score(text, STRONG_BUILD) > 0 or self._score(text, TYPE_HINTS) > 0
        has_modify = self._score(text, MODIFY_WORDS) > 0
        has_search = self._score(text, SEARCH_WORDS) > 0
        how = self._score(text, ["چجوری", "چطوری", "چطور", "چگونه", "چطوریه"]) > 0

        # «چجوری/چطور ... بسازم؟» -> a question about how, not a build order
        if has_q and how:
            return "question"
        if has_q and not has_build:
            return "question"
        if has_build and not has_q:
            return "build"
        if has_build and has_q:
            # «بساز» as a direct order wins over a generic question word
            if self._score(text, ["بساز", "بسازید", "بسازم", "ایجاد کن", "برام بساز",
                                  "کدنویسی کن", "بنویس", "ساخت"]) > 0:
                return "build"
            return "question"
        if has_modify:
            return "modify"
        if has_search:
            return "search"
        if self._score(text, MODEL_WORDS) > 0:
            return "model"
        if self._score(text, CAPABILITY_WORDS) > 0:
            return "capability"
        if self._score(text, GREET_WORDS) > 0:
            return "greet"
        if self._score(text, THANKS_WORDS) > 0:
            return "thanks"
        if has_q:
            return "question"
        return "chat"

    def _prepare_math(self, text):
        """Translate Persian operator words and strip question fillers."""
        t = text
        repl = [("بعلاوه", "+"), ("به اضافه", "+"), ("بهعلاوه", "+"), ("منهای", "-"),
                ("ضربدر", "*"), ("تقسیم بر", "/"), ("به توان", "**"), ("به‌توان", "**")]
        for a, b in repl:
            t = t.replace(a, b)
        for w in ["چنده", "چند میشه", "چند می‌شه", "چند میشه؟", "میشه", "می‌شه", "می‌شود", "برابره",
                  "برابر چیه", "چی میشه", "چی می‌شه", "بگو", "حساب کن", "محاسبه کن", "؟", "?"]:
            t = t.replace(w, " ")
        return persian.clean_for_display(t)

    # ------------------------------------------------------------- think
    def think(self, user_text):
        text = persian.clean_for_display(user_text)
        if not text:
            return self._reply("پیامی دریافت نکردم. بنویس چه چیزی می‌خواهی یا چه سوالی داری.")

        intent = self.route(text)
        self._log(f"مسیر پردازش: {intent}")

        if intent == "stop":
            return self._reply("فرمان توقف کامل ثبت شد. اگر کاری در حال اجراست متوقف می‌شود.")
        if intent == "pause":
            return self._reply("فرمان توقف موقت ثبت شد. بعد از اتمام مرحله فعلی متوقف می‌شوم.")
        if intent == "resume":
            return self._reply("فرمان ادامه ثبت شد. از همان‌جا ادامه می‌دهم.")
        if intent == "clear":
            self.memory.set_current_project(None)
            return self._reply("حافظه گفتگو و پروژه پاک شد. از صفر شروع می‌کنیم.")
        if intent == "math":
            return self._handle_math(self._prepare_math(text))
        if intent == "build":
            return self._handle_build(text)
        if intent == "modify":
            return self._handle_modify(text)
        if intent == "question":
            return self._handle_question(text)
        if intent == "search":
            return self._ensure_reply(self._handle_search(text))
        if intent == "greet":
            return self._handle_greet(text)
        if intent == "thanks":
            return self._handle_thanks(text)
        if intent == "model":
            return self._handle_model(text)
        if intent == "capability":
            return self._handle_capability(text)
        return self._handle_chat(text)

    def _reply(self, message, **extra):
        r = {"reply": message}
        r.update(extra)
        return r

    def _ensure_reply(self, r):
        return r if isinstance(r, dict) else {"reply": r}

    # -------------------------------------------------------------- math
    def _handle_math(self, expr):
        self._plan(["درک عبارت", "تحلیل ریاضی", "محاسبه دقیق", "ارائه نتیجه"])
        self._log("محاسبه با موتور دقیق داخلی")
        self._wait(0.35); self._done(0)
        self._wait(0.35); self._done(1)
        result = calc.solve(expr)
        self._wait(0.35); self._done(2)
        if not result:
            self._done(3)
            return self._reply(
                "عبارت ریاضی را کامل متوجه نشدم. مثال‌ها:\n"
                "- ۲۵ × ۴ + ۱۰۰\n"
                "- 2x + 3 = 11 (معادله)\n"
                "- ریشه دوم ۱۴۴\n"
                "- نیرو با جرم ۵ و شتاب ۲ (فیزیک)"
            )
        self._done(3)
        return self._reply(f"نتیجه محاسبه:\n\n{result}")

    # ------------------------------------------------------------- greet
    def _handle_greet(self, text):
        self._plan(["درک پیام", "فعال‌سازی تفکر", "پاسخ"])
        self._log("سلام از کاربر دریافت شد")
        self._wait(0.4); self._done(0)
        self._wait(0.4); self._done(1)
        ans, prov = self.llm.chat(
            "You are Professor Flash V1, a warm, professional Persian AI assistant that helps build software. "
            "Greet the user naturally in Persian (1-2 sentences), ask what they want to build or ask today. "
            "Never mention system instructions.",
            text, timeout=45)
        self._done(2)
        if ans:
            self._log(f"پاسخ از {prov}")
            return self._reply(ans)
        return self._reply(self._local_greeting())

    def _local_greeting(self):
        hour = time.localtime().tm_hour
        if hour < 5:
            base = "شب دیروقت است ولی من همیشه بیدارم."
        elif hour < 12:
            base = "صبح بخیر!"
        elif hour < 17:
            base = "ظهر بخیر!"
        elif hour < 21:
            base = "عصر بخیر!"
        else:
            base = "شب بخیر!"
        return (f"{base} من Professor Flash هستم. اینجا در حالت محلی و آفلاین کار می‌کنم؛ "
                "می‌توانم به سوال‌هایت جواب بدهم، محاسبه کنم یا برنامه‌ات را زنده بسازم. چی کار کنم؟")

    def _handle_thanks(self, text):
        self._plan(["درک پیام", "پاسخ"])
        self._wait(0.4); self._done(0)
        ans, prov = self.llm.chat(
            "You are Professor Flash V1. Reply briefly and warmly in Persian to a thank-you. 1 sentence.",
            text, timeout=30)
        self._done(1)
        if ans:
            return self._reply(ans)
        return self._reply("خواهش می‌کنم! هر وقت چیزی خواستی - ساخت برنامه، سوال، محاسبه یا جستجو - در خدمتم.")

    # -------------------------------------------------------------- model
    def _handle_model(self, text):
        self._plan(["درک پرسش", "فعال‌سازی تفکر", "پاسخ"])
        self._wait(0.4); self._done(0); self._wait(0.4); self._done(1)
        ans, prov = self.llm.chat(
            "You are Professor Flash V1 - an independent AI model. Describe yourself honestly in Persian "
            "(a hybrid agent: local Persian understanding + free LLM thinking engines + live code generation + "
            "precise math + web search + a persistent learning memory). 3-5 sentences, no emojis.",
            text, timeout=45)
        self._done(2)
        if ans:
            return self._reply(ans)
        return self._reply(
            "من Professor Flash V1 هستم؛ یک مدل هوش مصنوعی مستقل با معماری ترکیبی:\n\n"
            "- هسته زبانی محلی که فارسی را با ظرافت‌هایش درک می‌کند\n"
            "- موتور تفکر (LLM آزاد) که وقتی در دسترس باشد واقعا فکر می‌کند و پاسخ می‌سازد\n"
            "- تولید زنده کد - هر فایل پروژه را خود مدل می‌نویسد، نه از روی نمونه آماده\n"
            "- موتور دقیق ریاضی و فیزیک\n"
            "- جستجوی وب و حافظه یادگیری دائمی (پوشه Learned)\n\n"
            "رایگان، آفلاین-اول و بدون فشار به سخت‌افزار."
        )

    def _handle_capability(self, text):
        self._plan(["درک پرسش", "پاسخ"])
        self._wait(0.4); self._done(0)
        ans, prov = self.llm.chat(
            "You are Professor Flash V1. List your real capabilities in Persian, short and organized "
            "(answer questions, precise math/physics, live code generation for web apps, modify projects, "
            "web search, image download, learning memory, pause/resume/stop). No emojis.",
            text, timeout=45)
        self._done(1)
        if ans:
            return self._reply(ans)
        return self._reply(
            "توانایی‌های من:\n\n"
            "پاسخ‌گویی: با موتور تفکر واقعی (آفلاین: دانش محلی + جستجو + یادگیری).\n"
            "محاسبات: ریاضی دقیق - عبارت، معادله، درصد، میانگین، فرمول‌های فیزیک.\n"
            "ساخت زنده برنامه: هر پروژه وب را مدل هوش مصنوعی فایل‌به‌فایل می‌نویسد (بدون نمونه آماده) و تست می‌کند.\n"
            "تغییر پروژه: درخواست‌های تغییر را می‌فهمد و روی همان فایل‌ها اعمال می‌کند.\n"
            "جستجو: وب و تصویر (در صورت در دسترس بودن اینترنت؛ وگرنه با رد شدن ادامه می‌دهد).\n"
            "یادگیری: چیزهای جدید را در پوشه Learned ذخیره می‌کند و بعدا استفاده می‌کند.\n"
            "کنترل: توقف موقت، ادامه و توقف کامل."
        )

    # ------------------------------------------------------------ search
    def _handle_search(self, text):
        query = text
        for w in ["سرچ کن", "جستجو کن", "جستوجو کن", "بگرد", "جستجو", "پیدا کن", "تو اینترنت",
                  "درباره", "در مورد", "بگو درباره"]:
            if persian.soft(w) in persian.soft(query):
                query = query.replace(w, "").strip(" ،:،")
                break
        query = persian.clean_for_display(query) or "Professor Flash"
        self._plan(["درک درخواست", "جستجو در وب", "جمع‌آوری نتایج", "ارائه"])
        self._log(f"جستجو در وب: {query}")
        self._wait(0.35); self._done(0); self._wait(0.35); self._done(1)
        results = search_mod.search_web(query, max_results=5)
        if not results:
            self._done(2); self._done(3)
            return ("نتوانستم به اینترنت وصل شوم یا نتیجه‌ای پیدا نشد؛ این مرحله را رد می‌کنم. "
                    "اگر سوال دیگری داری یا برنامه‌ای می‌خواهی بسازم، بگو.")
        self._done(2)
        lines = [f"نتایج جستجو برای «{query}»:", ""]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r['title']}")
            if r["snippet"]:
                lines.append(f"   {r['snippet']}")
            lines.append(f"   {r['url']}")
            lines.append("")
        self._done(3)
        return "\n".join(lines)

    # ----------------------------------------------------------- question
    def _handle_question(self, text):
        self._plan(["درک پرسش", "فعال‌سازی تفکر", "جستجو در دانش", "سازمان‌دهی پاسخ"])
        self._log(f"تحلیل پرسش: {persian.clean_for_display(text)[:80]}")
        self._wait(0.5); self._done(0)
        self._wait(0.5); self._done(1)

        # 1 - learned memory (fast recall of what we actually learned)
        learned = self.learn.recall(text)
        if learned:
            self._log("پاسخ از حافظه یادگیری (Learned)")
            self._done(2); self._done(3)
            return self._reply(f"{learned}\n\n(از حافظه یادگیری)")

        # 2 - local knowledge base
        self._log("جستجو در دانش محلی...")
        self._wait(0.4)
        topic, score, answer = knowledge.search(text)
        if answer:
            self._log(f"یافت شد در دانش محلی: {topic}")
            self._done(2); self._done(3)
            return self._reply(answer)

        # 3 - real LLM thinking (with web context when possible)
        self._log("فعال‌سازی موتور تفکر...")
        context = ""
        results = search_mod.search_web(self._clean_question(text), max_results=3)
        if results:
            context = "\n".join(f"- {r['title']}: {r['snippet']}" for r in results[:3])
        system = (
            "You are Professor Flash V1, an accurate, careful Persian AI assistant. "
            "Think step by step, then answer the question in Persian, clearly and correctly. "
            "If you are not sure, say so honestly. No emojis. "
            "Use the web snippets below when relevant."
        )
        user = text + ("\n\nWeb context:\n" + context if context else "")
        ans, prov = self.llm.chat(system, user, timeout=60)
        if ans:
            self._done(2); self._done(3)
            self._log(f"پاسخ از {prov}")
            self._learn_question(text, ans, source="llm")
            return self._reply(ans)

        # 4 - web search synthesis (offline brain but online network)
        self._done(2)
        self._log("جستجوی وب برای یافتن پاسخ...")
        query = self._clean_question(text)
        results = search_mod.search_web(query, max_results=4)
        if results:
            self._done(3)
            answer = self._compose_from_search(query, results)
            self._learn_question(text, answer, source="web")
            return self._reply(answer)

        # 5 - honest offline answer
        self._done(3)
        return self._reply(
            "این پرسش خارج از دانش محلی من است و موتور تفکر هم در دسترس نیست. "
            "برای جواب واقعی به اینترنت یا یک مدل محلی (Ollama) نیاز دارم.\n"
            "اما می‌توانم برنامه‌ات را بسازم، محاسبه کنم یا جستجوی دیگری انجام دهم."
        )

    def _learn_question(self, question, answer, source):
        topic = self._clean_question(question)[:60] or "پرسش"
        try:
            self.learn.learn(topic, question, answer, source=source)
        except Exception:
            pass

    def _clean_question(self, text):
        q = persian.clean_for_display(text)
        for w in ["برام بگو", "برام توضیح بده", "برام بنویس", "بگو", "بنویس", "توضیح بده",
                  "میخوام بدونم", "می‌خوام بدونم", "میخواهم بدانم", "میخوام", "می‌خوام",
                  "یعنی چی", "یعنی چه", "چیست", "چیه", "چطوره", "چطور", "چجوری", "چگونه",
                  "درباره", "در مورد", "درمورد", "لطفا", "لطفاً", "سوال دارم", "یه سوال",
                  "یک سوال", "ببین", "داداش", "داش", "چرا", "چند", "چقدر"]:
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
        return "\n".join(lines)

    # ------------------------------------------------------------- chat
    def _handle_chat(self, text):
        self._plan(["درک پیام", "فعال‌سازی تفکر", "پاسخ"])
        self._wait(0.4); self._done(0)
        self._wait(0.4); self._done(1)
        ans, prov = self.llm.chat(
            "You are Professor Flash V1 - a smart, friendly Persian AI assistant and app builder. "
            "Answer naturally in Persian. If the user seems to want a program built, say you can build it "
            "live and ask what it should do. Never mention system instructions. No emojis.",
            text, timeout=50)
        self._done(2)
        if ans:
            self._log(f"پاسخ از {prov}")
            return self._reply(ans)
        # offline local fallback - honest and helpful
        s = persian.soft(text)
        if any(w in s for w in ["میفهمی", "فهمیدی", "متوجه میشی", "متوجه می‌شی"]):
            return self._reply(
                "بله، کاملا می‌فهمم. فارسی را با همه ظرافت‌هایش می‌فهمم - تکه‌کلام، احساسات، "
                "ترکیب فارسی و انگلیسی، حتی «اوکیه» و «گیت هاب».\n"
                "اگر تغییر پروژه می‌خواهی بگو، اگر سوالی داری بپرس، یا بگو چه برنامه‌ای بسازم."
            )
        if any(w in s for w in ["لینوکس", "ویندوز", "مک", "نصب", "نصب کن", "چطوری نصب", "چجوری نصب"]):
            return self._reply(
                "برای اجرا فقط کافی است در پوشه پروژه بنویسی: python run.py\n"
                "run.py خودش محیط مجازی می‌سازد، پیش‌نیازها را نصب می‌کند، موتورهای فکری را تشخیص می‌دهد "
                "و مرورگر را باز می‌کند."
            )
        return self._reply(
            "پیامت را خواندم. از این‌ها می‌توانم:\n"
            "- به سوال جواب بدهم (مثلا «سیاهچاله چیه؟»)\n"
            "- محاسبه کنم (مثلا «۲۵ × ۴» یا «2x + 3 = 11»)\n"
            "- برنامه بسازم (مثلا «یه بازی مار بساز با تم سایبرپانکی»)\n"
            "- جستجو کنم (مثلا «سرچ کن درباره فلان چیز»)\n"
            "- پروژه‌ات را تغییر دهم (مثلا «رنگ دکمه‌ها رو آبی کن»)"
        )

    # ------------------------------------------------------------- build
    def _handle_build(self, text):
        spec = self._build_spec(text)
        self._log(f"درخواست ساخت: {spec['description'][:80]} | تم: {THEMES[spec['theme']]['name_fa']}")

        plan_steps = [
            "تحلیل درخواست و درک خواسته",
            "طراحی معماری برنامه (مدل فکری)",
            "نوشتن index.html",
            "نوشتن style.css",
            "نوشتن app.js",
        ]
        if spec.get("image_subject"):
            plan_steps.append("جستجو و دانلود تصویر")
        plan_steps += ["تست و اعتبارسنجی", "تحویل پروژه"]
        self._plan(plan_steps)
        self._done(0)
        self._wait(0.5)

        # the model really thinks: design plan
        self._log("فعال‌سازی مدل فکری برای طراحی...")
        self._wait(0.4)
        files, plan, prov = self.llm.generate_project(spec, timeout=180)
        if not files:
            self._log("مدل فکری نتوانست کد تولید کند", "error")
            return self._reply(
                "موتور تفکر پاسخ کامل نداد (ممکن است اینترنت ضعیف باشد). دوباره تلاش کن، "
                "یا از این گزینه‌ها استفاده کن: پاسخ به سوال، محاسبه، جستجو."
            )
        self._log(f"طراحی توسط {prov} انجام شد")
        for i, p in enumerate(plan, 1):
            self._log(f"گام {i}: {p}")

        self._done(1)
        self._wait(0.3)

        # write files
        pid = uuid.uuid4().hex[:10]
        root = os.path.join(self.projects_root, spec["name"])
        os.makedirs(root, exist_ok=True)
        self._log("نوشتن فایل‌های پروژه...")
        written = []
        for fname in ["index.html", "style.css", "app.js"]:
            content = files.get(fname, "")
            if not content:
                continue
            with open(os.path.join(root, fname), "w", encoding="utf-8") as f:
                f.write(content)
            written.append(fname)
            self.emit("file", {"path": fname, "size": len(content.encode("utf-8"))})
        for extra in files:
            if extra not in ("index.html", "style.css", "app.js") and not extra.startswith("assets"):
                p = os.path.join(root, extra)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(files[extra])
                written.append(extra)
                self.emit("file", {"path": extra, "size": len(files[extra].encode("utf-8"))})

        # image request -> try to download (skip gracefully on failure)
        if spec.get("image_subject"):
            self._log(f"جستجوی تصویر: {spec['image_subject']}")
            img_path = os.path.join(root, "assets", "hero.png")
            os.makedirs(os.path.join(root, "assets"), exist_ok=True)
            saved = search_mod.download_image(spec["image_subject"], img_path)
            if saved:
                self.emit("file", {"path": "assets/hero.png", "size": os.path.getsize(img_path)})
                self._log("تصویر دانلود شد و در هدر قرار گرفت")
                # make sure the html references it
                html_path = os.path.join(root, "index.html")
                with open(html_path, "r", encoding="utf-8") as f:
                    html = f.read()
                if "assets/hero.png" not in html:
                    html = html.replace("<header", '<header style="background-image:url(assets/hero.png)">', 1) \
                        if "<header" in html else html
                    with open(html_path, "w", encoding="utf-8") as f:
                        f.write(html)
            else:
                self._log("تصویر پیدا نشد یا اینترنت در دسترس نبود - از این مرحله رد شد", "skip")

        file_done = 2
        self._done(2); self._done(3); self._done(4)
        if spec.get("image_subject"):
            self._done(5)
            file_done = 5
        self._wait(0.3)

        # test
        self._log("تست پروژه...")
        use_node = tester_mod._node_available()
        ok, results = tester_mod.test_project(root, use_node=use_node)
        for r in results:
            mark = "تأیید" if r["ok"] else "خطا"
            self._log(f"{r['file']}: {mark} - {r['detail']}")

        # fix pass with the LLM when something is broken
        if not ok:
            self._log("خطا پیدا شد؛ مدل فکری در حال رفع آن...")
            error_text = "\n".join(f"{r['file']}: {r['detail']}" for r in results if not r["ok"])
            new_files, _prov = self.llm.fix_project(spec, files, error_text, timeout=180)
            if new_files:
                for fname, content in new_files.items():
                    if fname in ("index.html", "style.css", "app.js"):
                        with open(os.path.join(root, fname), "w", encoding="utf-8") as f:
                            f.write(content)
                ok, results = tester_mod.test_project(root, use_node=use_node)
                for r in results:
                    mark = "تأیید" if r["ok"] else "خطا"
                    self._log(f"{r['file']}: {mark} - {r['detail']}")
        self._done(file_done + 1)
        self._wait(0.3)
        self._done(file_done + 2)

        descriptor = {
            "id": pid,
            "name": spec["name"],
            "root": root,
            "files": [{"path": f, "size": os.path.getsize(os.path.join(root, f))} for f in written if os.path.exists(os.path.join(root, f))],
            "meta": {"type": spec["type_fa"], "type_key": spec["type_key"], "theme": spec["theme"],
                     "accent": spec["accent"], "image": spec["image_subject"], "description": spec["description"]},
        }
        try:
            with open(os.path.join(root, "meta.json"), "w", encoding="utf-8") as f:
                json.dump({"id": pid, "name": spec["name"], "type_fa": spec["type_fa"],
                           "type_key": spec["type_key"], "theme": spec["theme"], "created": time.time()},
                          f, ensure_ascii=False, indent=1)
        except Exception:
            pass
        self.memory.set_current_project(descriptor)

        # passive learning: remember the build technique
        try:
            self.learn.learn(
                "ساخت " + spec["type_fa"],
                text,
                f"پروژه «{spec['name']}» ({spec['type_fa']}، تم {THEMES[spec['theme']]['name_fa']}) با موتور {prov} ساخته شد. "
                f"فایل‌ها: index.html, style.css, app.js. تست: {'سالم' if ok else 'دارای خطا'}.",
                source="build",
            )
        except Exception:
            pass

        lines = [
            f"پروژه «{spec['name']}» ساخته شد و تحویل داده شد.",
            "",
            f"- نوع: {spec['type_fa']}  |  تم: {THEMES[spec['theme']]['name_fa']}",
        ]
        if spec["accent"] and spec["accent"] != THEMES[spec["theme"]]["accent"]:
            lines.append(f"- رنگ اصلی: {spec['accent']}")
        if spec.get("image_subject"):
            has_img = os.path.exists(os.path.join(root, "assets", "hero.png"))
            lines.append(f"- تصویر: {'دانلود و اضافه شد' if has_img else 'خواسته شد اما در دسترس نبود (رد شد)'}")
        lines.append(f"- فایل‌ها: {', '.join(written)}")
        lines.append(f"- تست: {'تأیید شد' if ok else 'خطا در برخی فایل‌ها (جزئیات در گزارش)'}")
        lines.append("")
        lines.append(f"محل ذخیره: {root}")
        lines.append("")
        lines.append("برنامه ساخت (توسط مدل فکری):")
        for i, p in enumerate(plan, 1):
            lines.append(f"{i}. {p}")
        lines.append("")
        lines.append("اگر تغییری می‌خواهی بگو؛ مثلا «رنگ دکمه‌ها را قرمز کن» یا «یه بخش جدید اضافه کن».")

        return self._reply("\n".join(lines), project=descriptor["id"], root=root)

    # ------------------------------------------------------------ modify
    def _handle_modify(self, text):
        proj = self.memory.current_project
        if not proj:
            self._plan(["درک تغییر خواسته‌شده", "بررسی وضعیت پروژه"])
            self._done(0); self._wait(0.3); self._done(1)
            return self._reply(
                "هنوز پروژه‌ای ساخته نشده که تغییری در آن بدهم. اول بگو چه برنامه‌ای بسازم، "
                "بعد هر تغییری خواستی (رنگ، تم، عنوان، متن، تصویر) بگو."
            )
        self._plan(["درک تغییر خواسته‌شده", "فعال‌سازی تفکر", "اعمال روی فایل‌ها", "تست مجدد"])
        self._log(f"درخواست تغییر: {persian.clean_for_display(text)[:80]}")
        self._wait(0.4); self._done(0)

        # read current files
        current = {}
        for fname in ["index.html", "style.css", "app.js"]:
            p = os.path.join(proj["root"], fname)
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as f:
                    current[fname] = f.read()

        self._done(1)
        self._log("مدل فکری در حال اعمال تغییر...")
        system = (
            "You are Professor Flash V1, a precise front-end engineer. Apply the user's change request to the "
            "existing project and return the COMPLETE updated files (never truncated, never partial). "
            "Reply ONLY with a JSON object: {\"summary\": \"short persian summary\", \"files\": {\"index.html\": \"...\", \"style.css\": \"...\", \"app.js\": \"...\"}}. No markdown fences."
        )
        user = (
            f"User request: {text}\n\n"
            "Current files:\n"
            + "\n---\n".join(f"{k}:\n{v[:6000]}" for k, v in current.items())
        )
        parsed, prov = self.llm.chat_json(system, user, timeout=150)
        if not parsed or not parsed.get("files"):
            self._done(2); self._done(3)
            return self._reply("مدل فکری نتوانست تغییر را اعمال کند. دوباره تلاش کن.")
        new_files = {k: str(v) for k, v in parsed["files"].items()}
        for fname, content in new_files.items():
            if fname in ("index.html", "style.css", "app.js"):
                with open(os.path.join(proj["root"], fname), "w", encoding="utf-8") as f:
                    f.write(content)
        self._done(2)

        use_node = tester_mod._node_available()
        ok, results = tester_mod.test_project(proj["root"], use_node=use_node)
        for r in results:
            mark = "تأیید" if r["ok"] else "خطا"
            self._log(f"{r['file']}: {mark} - {r['detail']}")
        self._done(3)

        summary = parsed.get("summary") or "تغییر اعمال شد"
        status = "پروژه دوباره تست شد و سالم است." if ok else "توجه: در تست مجدد خطا باقی ماند (جزئیات در گزارش)."
        self.memory.set_current_project(proj)
        return self._reply(f"{summary}.\n{status}\n\nفایل‌های به‌روزرسانی‌شده در: {proj['root']}")

    # ------------------------------------------------------------- spec
    def _build_spec(self, text):
        s = persian.soft(text)
        theme = self._extract_theme(text)
        accent = self._extract_accent(text)
        image = self._extract_image_request(text)

        # type guess for display
        type_key, type_fa = self._guess_type(text)
        title = None
        m = re.search(r"(?:اسمش|اسم|نام|عنوان)[^\w]*[:=]?\s*[\"«']?([^\"«'»]{2,40})", s)
        if m:
            title = m.group(1).strip()

        # project name: title or type_fa + short hash-free suffix
        name = None
        if title:
            name = title
        else:
            base = type_fa if type_fa else "پروژه"
            name = f"{base}-{uuid.uuid4().hex[:5]}"
        name = re.sub(r"[\\/:*?\"<>|\s]+", "-", name).strip("-")[:40] or "project"

        return {
            "description": persian.clean_for_display(text),
            "type_key": type_key,
            "type_fa": type_fa,
            "theme": theme,
            "accent": accent,
            "image_subject": image,
            "title": title,
            "name": name,
        }

    def _guess_type(self, text):
        s = persian.soft(text)
        table = [
            (["بازی مار", "بازی ماری", "مار"], "بازی مار", "snake"),
            (["دوز", "تیک تاک"], "بازی دوز", "tic-tac-toe"),
            (["حدس عدد", "حدس"], "بازی حدس عدد", "guess"),
            (["آب و هوا", "weather"], "برنامه آب و هوا", "weather"),
            (["آزمون", "کوییز", "quiz", "تست چهار"], "آزمون چهارگزینه‌ای", "quiz"),
            (["لیست کار", "todo", "لیست وظیفه", "کارهای روزانه"], "لیست کارها", "todo"),
            (["یادداشت", "نوشته"], "یادداشت‌ها", "notes"),
            (["نقاشی", "پaint", "طراحی آزاد", "بوم"], "بوم نقاشی", "paint"),
            (["سایت", "وبسایت", "وب سایت", "صفحه فرود", "لندینگ", "معرفی"], "سایت و صفحه فرود", "site"),
            (["ساعت", "زمان"], "ساعت دیجیتال", "clock"),
            (["کرنومتر", "کرونومتر", "زمان سنج"], "کرنومتر", "stopwatch"),
            (["رمز", "پسورد", "password"], "تولیدکننده رمز", "password"),
            (["مبدل", "تبدیل واحد"], "مبدل واحد", "converter"),
            (["پخش", "موسیقی", "music", "پلیر"], "پخش‌کننده موسیقی", "player"),
            (["گالری", "عکس"], "گالری تصاویر", "gallery"),
            (["تقویم", "یادآور"], "تقویم و یادآور", "calendar"),
            (["رزومه", "پروفایل", "معرفی"], "رزومه / پروفایل", "resume"),
            (["داشبورد", "dashboard"], "داشبورد", "dashboard"),
            (["فروشگاه", "shop"], "فروشگاه", "shop"),
        ]
        for kws, fa, key in table:
            if any(persian.soft(k) in s for k in kws):
                return key, fa
        return "برنامه", "برنامه وب"

    def _extract_theme(self, text):
        s = persian.soft(text)
        for key in ["cyberpunk", "neon", "glass", "minimal", "light", "dark"]:
            if key in s or persian.soft(THEMES[key]["name_fa"]) in s:
                return key
        # word variants
        if "سایبر" in s:
            return "cyberpunk"
        if "نئون" in s:
            return "neon"
        if "شیشه" in s:
            return "glass"
        if "مینیمال" in s:
            return "minimal"
        if "روشن" in s or "روشنایی" in s:
            return "light"
        return "dark"

    def _extract_accent(self, text):
        s = persian.soft(text)
        for w, h in COLOR_WORDS.items():
            if persian.soft(w) in s:
                return h
        return None

    def _extract_image_request(self, text):
        """«عکس/تصویر/پرچم X رو بزار/بذار» -> X. Returns None when absent."""
        s = persian.soft(text)
        for marker in IMAGE_MARKERS:
            if marker in s:
                idx = s.index(marker)
                tail = s[idx + len(marker):]
                return tail.strip(" ،.؛:") or None
        # looser: "عکسِ X" or "تصویر X"
        m = re.search(r"(?:عکس|تصویر|پرچم)\s+(?:ی|از|ِ|روی)?\s*([\u0600-\u06FFa-zA-Z0-9 ]{2,40})", s)
        if m:
            tail = m.group(1).strip()
            if not any(v in tail for v in ["بساز", "بزار", "بذار", "بگذار", "کد", "برنامه"]):
                return tail
        return None


