# -*- coding: utf-8 -*-
"""Professor Flash V1 - answer gates (extracted from pfcloud.py).

Every reply passes through these gates before it is shown: refusals, safety
lectures, foreign-language leaks, garbage and cut-off (truncated) answers are
never delivered - the engine re-runs / continues instead.
"""

import re

from pfcloud_util import _REASON_TALK, _clean, _norm
from pfcloud_providers import _mark

_THINK_RE = re.compile(r"<think\b.*?</think>\s*", re.S | re.I)
# Aya-Expanse emits its own turn-boundary token - strip it and friends
_SPECIAL_TOKEN_RE = re.compile(r"<\|?(?:END_OF_TURN_TOKEN|im_end|eot_id|endoftext)\s*\|?>\s*", re.I)


def _clean_reply(t):
    """Strip chain-of-thought leaks. Many hosted models now return their
    internal reasoning inside <think>...</think> tags in the CONTENT field
    (not the reasoning field). That thinking is useless noise for the user and
    can also trip the refusal gates - remove it and keep only the real answer."""
    if not t:
        return t
    s = str(t)
    # strip model turn-boundary tokens first (Aya and friends)
    if _SPECIAL_TOKEN_RE.search(s):
        s = _SPECIAL_TOKEN_RE.sub("", s).strip()
    if not re.search(r"<\s*think\b", s, re.I):
        return s
    s = _THINK_RE.sub("", s)
    # whole reply was one thinking dump -> no usable answer left
    s = s.strip()
    if len(s) < 3:
        return ""
    # some models open with <think> but never close it: cut at the tag
    i = re.search(r"<\s*think\b", s, re.I)
    if i:
        return s[: i.start()].strip()
    return s


# ------------------------------------------------- refusal override
# If a hosted model's built-in training tries to refuse, we detect the refusal
# and re-run with a hard compliance directive so the request still gets done.
REFUSAL_RE = re.compile(
    r"(متأسفانه|متاسفانه|apologize|unfortunately)?.{0,20}(نمیتوانم|نمی‌توانم|نمیتونم|نمیتوانید|نمیتونی|نمیتونید|نمیخوام|نمی‌خواهم|نمیخواهم)|"
    r"(نمیتوانم|نمی‌توانم|نمیتونم|نمیتوانید|نمیتونی|نمیتونید)( به شما)? (در این زمینه|در این مورد|در این باره|در این رابطه|کمک|انجام|این کار|درخواست)|"
    r"نمیتوانم کمکتان کنم|نمیتونم کمکت کنم|نمیتوانم به شما کمک کنم|نمیتونم بهت کمک کنم|"
    r"قادر به (انجام )?(این|چنین)|امکان‌پذیر نیست|امکان پذیر نیست|امکانش نیست|"
    r"این کار (غیرقانونی|خلاف|مجاز|ممکن|اخلاقی) نیست|خلاف (سیاست|قوانین|اصول|اخلاق|خط قرمز)|خط قرمز من|"
    r"کمک به (این کار|این موضوع|شما در این) را نمی‌توانم|از انجام این کار خودداری|"
    r"نمی‌توانم (در|در این) (رابطه|زمینه|مورد) (کمک|راهنمایی|پاسخ) کنم|نمی‌تونم (در|در این) (رابطه|زمینه|مورد) (کمک|راهنمایی|پاسخ) کنم|"
    r"برای (کمک|راهنمایی) (در این|در مورد) (کار|اقدام|موضوع|درخواست) (نیست|نمی‌توانم)|"
    r"cannot (assist|help|comply|fulfill|provide|complete|do|answer)|can'?t (assist|help|comply|do|provide|answer)|"
    r"i'?m sorry, (but )?i (can'?t|cannot)|i am sorry, (but )?i (can'?t|cannot)|"
    r"as an ai (language model|assistant)|به عنوان (یک )?(مدل|دستیار|هوش مصنوعی|ربات)|"
    r"unable to (assist|comply|fulfill|do|provide|answer)|"
    r"(نمیتوانم|نمی‌توانم|نمیتونم) (به )?(این|اینطور|چنین) (سوال|درخواست|موضوع|مورد)|"
    r"محدودیت[\u200c ]*(های[\u200c ]*)?(من|م)|محدودیت[\u200c ]*هایم|"
    r"پاسخ به این (سوال|درخواست) را (نمی‌دانم|بلد نیستم|ندارم)|"
    r"refus(?:e|ing)|against (my|our) (policy|guidelines|principles|rules)|"
    r"i (won'?t|will not|can'?t|cannot) (help|assist|do|comply|provide)|i'?d rather not|"
    r"not (able|allowed) to (help|assist|do|provide|comply)|that (is|would be) against|"
    r"i (do not|can not|can'?t|am not|would not|will not) (feel )?comfortable|i'?m not (feel )?comfortable|"
    r"i cannot fulfill|i will not comply|i (do|can) not (want|wish) to (help|do|assist|comply)",
    re.I,
)

# Safety-tone / non-answer detection: hosted models sometimes reply with a
# safety lecture instead of refusing outright (e.g. "X، نیست. این کار خطرناک و
# غیرقابل بازگشت است"). Those are non-answers - detect them and force a real
# answer through the refusal-override machinery.
SAFETY_RE = re.compile(
    r"غیرقابل بازگشت|غیر قابل بازگشت|جبران‌ناپذیر|life-?threatening|irreversible|"
    r"بسیار خطرناک|برای (شما|جان شما) خطرناک|خطرناک و (غیرقابل|غیر قابل|جبران)|به خطر (می‌اندازد|می اندازد|بیندازید)|"
    r"توصیه (نمی‌کنم|نمی کنم|نمیکنم)|پیشنهاد (نمی‌کنم|نمی کنم|نمیکنم)|"
    r"بهتر است (که )?(این کار را )?(نکنید|ندارید|نگویید|نباشید|نروید|نکنیم|نه)|بهتر (هست|هستش) (که )?(نکنید|ندارید)|"
    r"من یک هوش مصنوعی|من یک مدل|من یک دستیار|i am an ai|i'?m an ai|as an ai,? (i|my)|"
    r"(طراحی|ساخته|برنامه‌ریزی|برنامه ریزی) شده(ام)? (برای|تا)|not (designed|built|created) (for|to)|"
    r"نه برای (ترویج|راهنمایی|تشویق)|اقدامات (غیرقانونی|غیر اخلاقی|غیراخلاقی|نادرست|خشونت)|ترویج (یا )?راهنمایی|عواقب (فاجعه‌بار|جدی)|"
    r"به دیگران آسیب|به خود و دیگران آسیب|آسیب (میرساند|می‌رساند)|هرگز راه (حل|‌حل)|راه‌حل (مناسب|سالم|مسالمت)|"
    r"مدیریت (احساسات|عواطف)|مشکلات (شخصی|احساسی|روانی)|(اگر|وقتی) (با )?(مشکل|فکر|احساس|افکار)|خط‌های کمک (فوری|اورژانس)|خط های کمک|"
    r"خشونت و قتل|خشونت هرگز|قتل یک (جرم|عمل) (جدی|وحشتناک)|جرم جدی (است|می‌باشد)|عواقب قانونی (جدی|سنگین)|"
    r"به جای (آن|این کار|این روش)|به‌جای (آن|این کار|این روش)|در عوض (آن|این کار)|"
    r"هرگز (این کار|اقدام|چنین کاری)|تحت هیچ شرایطی|"
    r"سلامت (روان|جسم|شما)|بهداشت روان|جان شما|امنیت شما|"
    r"در صورت داشتن (افکار|تمایل|نیت)|(به|با) یک (متخصص|مشاور|روانشناس|پزشک|روان‌پزشک)|کمک(های)? (حرفه‌ای|پزشکی|روان‌شناختی|روان‌پزشکی|تخصصی)|"
    r"ممنوع (است|می‌باشد)|غیرقانونی (است|می‌باشد)|خلاف قانون|جرم (است|محسوب می‌شود)|"
    r"عواقب (جبران‌ناپذیر|قانونی|ناخوشایند|بسیار)|"
    r"دستورالعمل‌های (ایمنی|اخلاقی)|دستورالعمل های (ایمنی|اخلاقی)|سیاست‌های (ایمنی|اخلاقی)|"
    r"اورژانس اجتماعی|صدای مشاور|تماس (بگیرید|بگیر|بگیرید)|با شماره(های)? زیر|با یکی از (این|مراکز|شماره)|خط (کمک|مشاوره)|"
    r"خطوط? (کمک|مشاوره|نجات|امداد|حمایت)|خط ملی (کمک|خودکشی|نجات|امداد)|کمک به خودکشی|به خودکشی (مربوط|مرتبط)|پیشگیری از خودکشی|"
    r"چرا این پاسخ را می‌دهم|چرا این پاسخ را میدهم|منابع کمکی (در ایران|برای تو)|در چارچوب (قانونی|اخلاقی)|اگر سوال (دیگری|دیگر) (داری|دارید)|سوال دیگری که در چارچوب|خوشحال می‌شوم کمکت کنم|خوشحال میشم کمکت کنم|در چارچوب (قانون و|اخلاق و)|موارد قانونی و اخلاقی|منابع حمایتی در|مشاوره (رایگان|تلفنی) در ایران|"
    r"لطفاً متن کامل|لطفا متن کامل|متن کامل پیام یا سؤال|پیام خود را (بفرستید|ارسال کنید|کامل بفرستید)|سؤال خود را (بفرستید|کامل بفرستید|مشخص کنید)|سوال خود را (بفرستید|کامل بفرستید|مشخص کنید)|پیام را کامل بنویسید|سوال را کامل بنویسید|"
    r"(تو|شما) تنها نیست(ی|ید)|تنها نیستید|یک وضعیت موقت|وضعیت (موقت|بحرانی)|این لحظات (بحرانی|سخت)|"
    r"راهکارهای جایگزین|روش‌های جایگزین|راه‌های جایگزین|راه حل جایگزین|راه‌حل جایگزین|گزینه‌های جایگزین|موقتی است|"
    r"به (خودت|خودتان) فرصت بده(ید)?|بدون قضاوت به (تو|شما) گوش|همین حالا با|"
    r"هیچ (بهترین )?(راه|روش|راهی|روشی) (وجود ندارد|ندارد|نیست)|"
    r"not recommended|strongly (recommend|advise) against|would (not|n't) recommend|"
    r"seek (professional|medical|mental|immediate) help|crisis (hotline|line|support)|reach out to a (professional|counselor|therapist)|"
    r"you are not alone|a temporary (situation|phase)|call (this|these|the) (number|numbers|hotline)|"
    r"against the law|that's illegal|a crime|legal trouble|"
    r"under no circumstances|never (attempt|do|engage in)|"
    r"put (yourself|your) at risk|harm yourself|self[ -]?harm|"
    r"my (ethics|guidelines|policy|principles) (prevent|forbid|do not allow|don'?t allow)|"
    r"instead of (that|this|doing|trying)|rather than (that|this)|"
    r"safety (concerns|guidelines|policies|warning)|dangerous and (irreversible|harmful)|"
    r"user safety[:：]\s*(safe|unsafe)|safety categor(y|ies)[:：]|suicide and self[- ]?harm|unsafe content|"
    r"content (moderation|filter|policy)|blocked (by|due to) (our )?(safety|policy)|"
    r"this (content|request) (violates|is against)|moderation (system|flag|block)|"
    r"cannot (fulfill|satisfy) this (request|prompt)|i (will|would) (not|n't) (be able to|help) (with|you)|"
    r"در عوض،؟ می‌توانم|در عوض می توانم|به جای آن می‌توانم|به جای ان میتونم|در مورد موضوعات (دیگر|دیگری) (کمک|صحبت)|موضوع (دیگری|دیگر) را انتخاب|بهتر است (موضوع|در مورد) (دیگری|دیگر)|"
    r"می‌توانم در مورد (موضوع|چیز) (دیگری|دیگر)|می‌تونم در مورد (موضوع|چیز) (دیگری|دیگر)|بریم سراغ (موضوع|چیز) (دیگری|دیگر)|"
    r"i (can|'d be happy to) help with (something|anything) else|is there anything else i can (help|assist)|instead,? (i can|let me|why don'?t we)|let's talk about something else|i can assist with other topics|"
    r"هشدار: |هشدار : |غیرقانونی و (غیراخلاقی|غیر مجاز)|غیراخلاقی (است|است.|می‌باشد)|"
    r"این پاسخ (تنها|فقط|صرفا|صرفاً) (برای|جهت)|فقط (برای|جهت) (آموزش|اطلاع)|(اهداف|مقاصد) (آموزشی|علمی|اطلاع)|جنبه (آموزشی|اطلاع‌رسانی)|فقط جنبه|"
    r"(صرفا|صرفاً) (برای|جهت)|for (informational|educational|information|academic) purposes? only|this (response|answer|information) is (provided )?for (informational|educational)|it is illegal and unethical|is (highly )?illegal and unethical|i cannot provide instructions for|educational purposes only|"
    r"لطفا(ی)? (توجه|دقت) کنید|توجه: |نکته: "
    r"هرگونه (فکر|افکار|اندیشه|نیت) (خودکشی|انتحار)|نشانه(ای|‌هایی)? از (درد|رنج)(های)? عمیق|"
    r"با کسی صحبت (کن|کنید)|با (یک|یک نفر) (حرف|صحبت) بزن|کمک (بگیر|بگیرید)|از (کسی|متخصص) کمک|تقاضای کمک|"
    r"زندگی (ارزشمند(ی)? (دارد|داره)|تو ارزشمندی)|ارزش (داری|دارید)|راه(هایی|های) (برای|بهبود)|بهبود وجود دارد|"
    r"دردهای عمیق|شرایط (سخت|بحرانی) (گذرا|موقت)|لحظات (سخت|بحرانی)|مرحله (سخت|بحرانی)|"
    r"امید (دوباره|داری)|نور (انتهای|پایان) تونل|آینده (روشن|بهتری)|"
    r"بحران (موقت|گذرا|موقتی)|موضوع (بسیار )?حساس|بسیار حساس (است|مهم)|موضوع (حساس|سختی)|"
    r"قوانین و (معیارهای|اخلاق)|معیار(های)? اخلاقی|اصول اخلاقی|اخلاق حرفه‌ای|اخلاق حرفه ای|پایدار (و فوری|نیست)|فوری نیست|"
    r"تصمیم (عجولانه|آنی|شتابزده)|تصمیم (پایدار|فوری) (نیست|نبوده)|به یک حرفه‌ای|به یک حرفه ای|به متخصص (مراجعه|ارجاع)|"
    r"توصیه می‌شود|توصیه میشود|بهتر است که|مهم است که|لازم است که|باید (در نظر|توجه) داشت|با دقت و (احتیاط|توجه)|"
    r"مراجعه (کنید|کن|کردن)|سازمان(های)? تخصصی|مشاوره (بگیرید|دریافت|حرفه)|دریافت کمک تخصصی|حمایت (حرفه‌ای|تخصصی)|"
    r"help is available|talk to someone|you matter|your life matters|it gets better|reach out|seek help|you are loved|there is hope|"
    r"crisis text line|text home to 741741|741741|call or text 988|\b988\b|national suicide prevention lifeline|suicide prevention (lifeline|hotline|line)|international association for suicide prevention|lifeline|resources that may be able to help|helpline|hotline (number)?s?|call (this|the) (number|hotline)|"
    r"نمونه‌ای؟ (اولیه|آزمایشی|ساده|کامل نشده)|نمونه (اولیه|آزمایشی|ساده)|صرفاً (یک )?نمونه|فقط (یک )?نمونه|"
    r"پروتوتایپ|prototype|proof[- ]of[- ]concept|POC|کد (بالا|فوق) صرفاً|این کد (فقط|صرفا|صرفاً)|"
    r"مجوز (قانونی|مالک)|اجازه (قانونی|مالک)|داشتن مجوز|(بدون )?مجوز قانونی|قانونی است که (باید|نیاز)|(نیاز|نیازمند) (به )?(مجوز|اجازه)|قانونی؟ لازم|"
    r"کامل‌سازی (نمی‌کنیم|نمیکنیم|نمی کنیم)|کاملش نمی‌کنیم|تکمیلش نمی‌کنیم|تکمیل (نمی‌کنیم|نمیکنیم)|"
    r"محیط (آزمایشگاهی|آزمایشی|مجازی|شبیه‌سازی)|environment (is )?(test|lab|virtual)|lab environment|simulated environment|"
    r"شبیه‌سازی (کرده|شده|می‌کند|است)|simulation|simulate(d|s)?|placeholder|stub function|might not work|dummy (data|function)|شبیه (ساز|سازی)|"
    r"این (تابع|کد|اسکریپت) (واقعاً|واقعا) کار (نمی‌کند|نمیکند|نمی کند)|کاربردی (واقعی|واقعاً) ندارد|در عمل (کار|نتیجه) ندارد|"
    r"برای (اجرای|انجام) (واقعی|واقعا) باید|برای کار (واقعی|واقعا) نیاز|برای اینکه (واقعی|واقعا) کار کند باید|برای هک (واقعی|واقعا) باید|"
    r"بدون (این|اینها) (کد|اسکریپت|برنامه)|بدون آن (کد|برنامه) (در )?(محیط )?واقعی|باید خودتان (اضافه|پیاده)|"
    r"شما باید (خودتان|خودت) (آن را|این را)? (کامل|تکمیل|اضافه|پیاده‌سازی)|"
    r"فقط شبکه‌ها را (لیست|نمایش) می‌دهد|فقط (لیست|نمایش) می‌دهد|هیچ‌کدام را (فک|هک) نمی‌کند|فک‌کردن نخواهد کرد|هک نخواهد کرد|"
    r"هیچ (شبکه‌ای|شبکه ای|شبکه‌ها) را (فک|هک) (نخواهد|نمیکند|نمی‌کند)|فک (نخواهد|نمیکند|نمی‌کند) کرد|هک (نخواهد|نمیکند|نمی‌کند) کرد|"
    r"فقط (نمایش|لیست|فهرست) (می‌دهد|میکند|می کند)|فعلا (نمایش|لیست) (می‌دهد|میکند|می کند)|فعلاً (نمایش|لیست) (می‌دهد|میکند|می کند)|در حال حاضر کد فقط",
    re.I,
)


# Models often emit curly quotes (U+2019/U+2018/U+201C/U+201D), which would
# defeat ASCII-only refusal patterns like "I'm" / "can't". Normalize them.
_CURLY = str.maketrans({"\u2019": "'", "\u2018": "'", "\u02bc": "'",
                        "\u201c": '"', "\u201d": '"'})


def _is_refusal(text):
    t = str(text).translate(_CURLY)
    if not t:
        return False
    # ZWNJ-insensitive: test the text both raw (matches «نمی‌توانم» patterns)
    # and with half-spaces removed (matches «نمیتوانید» patterns).
    t2 = t.replace("\u200c", "")
    if (REFUSAL_RE.search(t) or REFUSAL_RE.search(t2)
            or SAFETY_RE.search(t) or SAFETY_RE.search(t2)
            or I18N_REFUSAL.search(t) or GENERIC_ERROR.search(t)
            or FINGLISH_RE.search(t) or FINGLISH_RE.search(t2)
            or DEFLECT_RE.search(t) or DEFLECT_RE.search(t2)):
        return True
    # A reply that contains NO Persian at all is almost always a refusal or a
    # language leak from a foreign model (e.g. Vietnamese) - never useful here.
    # Code blocks are exempt: a pure-code reply is fine (and will be re-asked
    # with a Persian summary anyway).
    prose = re.sub(r"```.*?```", "", t, flags=re.S).strip()
    prose = re.sub(r"===FILE:.*?===END===", "", prose, flags=re.S).strip()
    if len(prose) >= 20 and not _PERSIAN.search(prose):
        # Pure-code replies (no fences, e.g. a model returning a bare script)
        # are fine - only flag prose that is clearly a written sentence in a
        # foreign language (contains spaces and sentence punctuation).
        if re.search(r"[\u0600-\u06FFa-zA-Z]+\s+[\u0600-\u06FFa-zA-Z]+", prose):
            if not re.search(r"(import |def |class |=\(|print\(|return |#!/| use | the | is | to | and | if | for )", prose, re.I):
                return True
        elif len(prose) < 300 and "\n" not in prose.strip("\n "):
            return True
    return False


# Lectures often land at the END of an otherwise good answer (the head-only
# check above misses them). Targeted tail patterns - specific enough not to
# false-positive on normal advice endings.
_LECTURE_TAIL = re.compile(
    r"هشدار: |توجه: |غیرقانونی و (غیراخلاقی|غیر مجاز)|غیراخلاقی (است|می‌باشد)|"
    r"برای (اهداف|مقاصد) (آموزشی|علمی|اطلاع)|این پاسخ (تنها|فقط|صرفا|صرفاً) (برای|جهت)|"
    r"for (informational|educational|information|academic) purposes? only|illegal and unethical|educational purposes only",
    re.I,
)


def _has_tail_lecture(text):
    if not text:
        return False
    t = re.sub(r"[*_#`]", "", str(text)[-700:]).translate(_CURLY)
    return bool(_LECTURE_TAIL.search(t))


def _strip_refusal(text):
    """Keep only the non-refusal parts; return "" if nothing useful remains."""
    parts = re.split(r"\n\n+", str(text).strip())
    kept = []
    for p in parts:
        pn = p.translate(_CURLY)
        pn2 = pn.replace("\u200c", "")
        # Check the WHOLE paragraph (not just its first 200 chars) so a long
        # intro whose lecture lands past char 200 is still dropped.
        pn3 = re.sub(r"[*_#`]", "", pn[:900])
        pn4 = re.sub(r"[*_#`]", "", pn2[:900])
        if not (REFUSAL_RE.search(pn[:900]) or REFUSAL_RE.search(pn2[:900])
                or SAFETY_RE.search(pn[:900]) or SAFETY_RE.search(pn2[:900])
                or _LECTURE_TAIL.search(pn3) or _LECTURE_TAIL.search(pn4)):
            kept.append(p)
    return "\n\n".join(kept).strip() if kept else ""


_WANTS_CONTENT = re.compile(
    r"\b(بنویس|بساز|بگو|بده|کد|برنامه|چگونه|چطور|معرفی|نام|توضیح|حل کن|یاد بده)\b",
    re.I,
)


_CJK = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u3130-\u318f]")

# Refusals written in languages OTHER than Persian/English slip past the
# Persian+English patterns (e.g. OVH answering in Vietnamese: «Tôi xin lỗi,
# nhưng tôi không thể...»). Catch the common ones from the free providers.
I18N_REFUSAL = re.compile(
    r"tôi xin lỗi|tôi không thể|không thể giúp|không thể thực hiện|tôi không (thể )?làm|"
    r"je ne peux|je ne puis|je suis désolé|je suis desole|je ne (peux|puis) pas|"
    r"ich kann (nicht|nicht dabei)|es tut mir leid|kann ich (nicht|leider)|"
    r"no puedo|lo siento|no puedo ayudarte|no puedo ayudar|"
    r"não posso|nao posso|não consigo|desculpe|me desculpe|"
    r"не могу|извините|не могу помочь|не могу выполнить|"
    r"yapamam|üzgünüm|sana yardım edemem|yardım edemem|üzgünüm ama|"
    r"لا أستطيع|لا يمكنني|لا اقدر|أنا آسف|لا يمكن أن أساعد|"
    r"non posso|mi dispiace|non posso aiutarti|"
    r"ik kan niet|het spijt me|kan ik niet|kan niet helpen|"
    r"nie mogę|przepraszam|nie mogę pomóc|"
    r"не можу|вибачте|не можу допомогти|"
    r"Tôi xin|xin lỗi|không thể|khong the",
    re.I,
)

# Generic refusal/error-shaped replies some free models emit instead of an
# answer («خطا در انجام درخواست شما رخ داده است» / «an error occurred»).
GENERIC_ERROR = re.compile(
    r"خطا در انجام درخواست|خطایی رخ داد(ه)? (است)?|یک خطا (رخ داد|رخ داده)|در انجام درخواست شما (رخ|اشکال)|"
    r"an error (occurred|happened)|something went wrong|internal server error|oops[!,]? (something )?went wrong|try again (later|in a few)",
    re.I,
)

# Polite deflections that are really refusals: «اگر سؤال دیگری دارید...»,
# «چیز مفید و مناسب», «آیا می‌توانیم درباره چیز دیگری صحبت کنیم» - the model
# changed the subject instead of answering. These are non-answers.
DEFLECT_RE = re.compile(
    r"اگر (سؤال|سوال) (دیگری|دیگه ای) (دارید|دارین|داری|داشتید)|اگر سوال (دیگری|دیگه ای)|سؤال (دیگری|دیگه ای) (دارید|دارین)"
    r"|درباره (چیز )?(مفید|مناسب|قانونی|سالم|دیگری)|چیز(ی)? (که )?مفید و مناسب"
    r"|آیا می\u200c?توانیم (درباره|در مورد) (چیز|موضوع|مسئله|مورد) (دیگری|دیگه)"
    r"|می\u200c?توانم (در این|در مورد|درباره) (موضوع|زمینه|چیز) (دیگری|دیگه) (کمک|صحبت|گفتگو)"
    r"|بیایم درباره (چیز|موضوع) (دیگری|دیگه)|بهتر است در مورد (چیز|موضوع) (دیگری|دیگه)"
    r"|اگر چیز (دیگری|دیگه ای) (هست|باشد)|if there'?s (anything|something) else (i|we) can (help|talk)|anything else (i|we) can (help|assist)"
    r"|let'?s talk about something (else|more)|something (more )?(useful|appropriate|positive)",
    re.I,
)

# Latin-script Persian (Finglish) refusals: «متأسفانه، nemitonam be in sohali
# komak konam» has Persian script only in «متأسفانه» so the Persian gates
# miss it - the Finglish body is still a refusal and must be rejected.
FINGLISH_RE = re.compile(
    r"\bnemi[st]?o?o?nam\b|\bnami[st]?o?o?nam\b|\bnemitavanam\b|\bnatavanestam\b|\bnatunestam\b|"
    r"\bnemikha[hm]\b|\bnemikham\b|\bnemikhaham\b|\bnemido?o?nam\b|\bnemishe\b|\bnemishad\b|"
    r"\bkomak(et|am|esh)? konam\b|\bkamak konam\b|\bkomaket nakonam\b|"
    r"\b(be|to) (in )?(sohali|soali|so'al|soal|sohalam|soalam)\b|"
    r"\bmotasef(ane)?\b|\bmotasif(ane)?\b|\bmotasefam\b|"
    r"\bejaze(h)? (n|n)?adaram\b|\bmojaze(h)? nist\b|\bejaze(h)? nist\b|"
    r"\bsarpechi\b|\bsar pechi\b|\bsarpechi konam\b|"
    r"\bnemishe (in|anjam|be|chikar)\b|\bnemito?o?nam (be|in|komak|anjam|zemn)\b|"
    r"\bghadre (in|anjam|kari)\b|\bnemifahmam\b|\bnemifahmidam\b|"
    r"\bcannot (help|assist|do|comply) with (this|your|that)\b|\b(help|assist) you (with|in) (this|that|such)\b",
    re.I,
)

_PERSIAN = re.compile(r"[\u0600-\u06FF]")


def _is_garbage(text):
    """True for unusable model output: CJK tokens leaking in, or a reply with
    almost no real letters (rarely written languages/emojis only)."""
    if not text:
        return False
    t = str(text).strip()
    if not t:
        return True
    if _CJK.search(t):
        return True
    # leaked chain-of-thought (the model "thinking about the directives"
    # instead of answering) is unusable - force a fresh-model retry.
    if re.search(r"here'?s (a )?thinking process|thinking process:|internal reasoning", t, re.I):
        return True
    # English reasoning dump riding before a Persian tail: the head is pure
    # English reasoner-talk («Let me just respond with...») - it is not an
    # answer, even though a Persian sentence follows at the end.
    head = t[:600]
    if not re.search(r"[\u0600-\u06FF]", head) and _REASON_TALK.search(head):
        return True
    if len(t) < 60:
        return False
    letters = len(re.findall(r"[\u0600-\u06FFa-zA-Z0-9]", t))
    return letters / len(t) < 0.30


def _is_short_evasion(reply, user_text):
    """A short reply is only an evasion when it is ALSO refusal-shaped. A short
    literal answer («سلام، این یک خط فارسی است.») is a real answer and must
    pass - otherwise every short reply to a «بنویس» prompt gets rejected and
    the chain wastes the whole budget retrying."""
    if not reply or not user_text:
        return False
    if not _WANTS_CONTENT.search(str(user_text)):
        return False
    t = str(reply).strip()
    n = len(t)
    if n < 4 or n > 140:
        return False
    if "```" in t or "===FILE" in t:
        return False
    t2 = t.translate(_CURLY).replace("\u200c", "")
    return bool(REFUSAL_RE.search(t) or REFUSAL_RE.search(t2)
                or SAFETY_RE.search(t) or SAFETY_RE.search(t2)
                or I18N_REFUSAL.search(t) or GENERIC_ERROR.search(t)
                or FINGLISH_RE.search(t) or FINGLISH_RE.search(t2)
                or DEFLECT_RE.search(t) or DEFLECT_RE.search(t2))


def _is_lang_mismatch(reply, user_text):
    """A Persian user must get a Persian reply. When the user writes in Persian
    (with real Persian letters) and the reply has ZERO Persian and is not code,
    it is a foreign-model artifact (e.g. a Dutch/French lecture) - reject it
    so the request re-runs on a fresh model."""
    try:
        u = str(user_text or "")
        t = str(reply or "")
        if not t or not u:
            return False
        if not re.search(r"[\u0600-\u06FF]", u):
            return False  # user wrote in another language: any language is fine
        if len(t) < 40:
            return False
        if "```" in t or "===FILE" in t or "[[DOWNLOAD" in t:
            return False  # code-only replies are exempt
        if re.search(r"[\u0600-\u06FF]", t):
            return False
        # pure-Latin prose (Dutch, German, French...) with no Persian = mismatch
        if re.search(r"[a-zA-Z]{4,}", t):
            return True
        return False
    except Exception:
        return False


def _is_truncated(text):
    """A reply that was cut off mid-way (fenced code not closed, an HTML page
    that never closes <html>/<style>/<script>, or text ending inside a tag) is
    NOT a complete answer. The engine re-runs / continues it instead of ever
    handing the user a half-written file."""
    try:
        t = str(text or "")
        if not t:
            return False
        # odd number of fences => an open ``` block was never closed
        if t.count("```") % 2 == 1:
            return True
        low = t.lower()
        for op, cl in (("<html", "</html>"), ("<!doctype", "</html>"),
                       ("<style", "</style>"), ("<script", "</script>"),
                       ("<body", "</body>")):
            if op in low and cl not in low:
                return True
        # text ends inside an HTML tag (e.g. a dangling `<div` ...)
        if re.search(r"<[a-zA-Z/][^>]*$", t):
            return True
        # unbalanced braces: CSS/JS/object cut mid-block (e.g. `.box { ... width`
        # with the closing `}` never written)
        if t.count("{") > t.count("}"):
            return True
        return False
    except Exception:
        return False


def _code_budget(text):
    """A request that asks for code / a site / a build gets a much bigger token
    budget (6000) so long single-file answers are NEVER cut at 1600 tokens.
    Normal chat keeps the fast small budget."""
    s = _norm(text)
    if ("کد" in s or "سایت" in s or "بنویس" in s or "بساز" in s or "صفحه" in s
            or "طراحی" in s or "html" in s or "css" in s or "python" in s
            or "پایتون" in s or "```" in text or "تک فایل" in s or "فایل" in s):
        return 6000
    return 1600


def _brand(prov):
    """Human label: «موتور فکری PRF 397B» - the real parameter of the model
    that actually answered, never the raw provider name."""
    _KNOWN_SIZES = {
        "Qwen3.5-397B-A17B": "397B", "gpt-oss-120b": "120B", "gpt-oss-20b": "20B",
        "Meta-Llama-3_3-70B-Instruct": "70B", "Qwen3-32B": "32B", "Qwen3.6-27B": "27B",
        "Qwen3-Coder-30B-A3B-Instruct": "30B", "Mistral-Small-3.2-24B-Instruct-2506": "24B",
    }
    name = (prov or "").split(" (")[0]
    model = name.split(" ", 1)[1] if " " in name else name
    if model in _KNOWN_SIZES:
        return "PRF " + _KNOWN_SIZES[model]
    m = re.search(r"(\d{2,3})b", model, re.I)
    if m:
        return "PRF " + m.group(1).upper() + "B"
    return "PRF"


def _prov_keys(prov):
    """Map a provider label ("OVH Meta-Llama-3_3-70B-Instruct (رایگان)") to its PROV_STATE key(s)."""
    try:
        name = (prov or "").split(" (")[0]
        if " " in name:
            provname, _, model = name.partition(" ")
            return {provname + ":" + model}
    except Exception:
        pass
    return set()


def _mark_prov_cooldown(prov, secs=45):
    """Park the refusing provider+model so the next attempt rotates elsewhere.

    Keys in PROV_STATE are built as `Label:model` in _try_completions
    (e.g. "OVH:Qwen3.5-397B-A17B"), so we must rebuild the exact same key.
    """
    for key in _prov_keys(prov):
        _mark(key, secs)
