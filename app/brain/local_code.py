# -*- coding: utf-8 -*-
"""Professor Flash - local live code synthesizer.

When no LLM is reachable this module still writes REAL, working code for a
request - it parses what the user asked (operation + how many numbers +
language) and composes a complete program from scratch. Every program is
genuine Python 3 / HTML-CSS-JS that actually runs; the model then executes
it with sample input and reports the real output.

This is a fallback, not the primary path: when a free LLM is reachable the
LLM generates the code instead (arbitrary apps). The local synthesizer
covers the common operations so the model never "cannot answer".
"""

import re

from . import persian

_WORD_NUM = {"یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5,
             "شش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10}
_NUM_RE = re.compile(r"(\d+)")

OPS = [
    ("ضرب", ["ضرب", "×", "✕", "ضربدر", "زرب", "حاصل ضرب"], "multiply", "ضرب", "ضرب دو یا چند عدد"),
    ("جمع", ["جمع", "به اضافه", "بعلاوه", "+", "حاصل جمع", "تجمیع"], "add", "جمع", "جمع دو یا چند عدد"),
    ("تفریق", ["تفریق", "منهای", "کم کردن", "باقی مانده"], "subtract", "تفریق", "تفریق دو یا چند عدد"),
    ("تقسیم", ["تقسیم", "÷", "نسبت"], "divide", "تقسیم", "تقسیم دو یا چند عدد"),
    ("میانگین", ["میانگین", "متوسط", "average"], "average", "میانگین", "میانگین چند عدد"),
    ("بزرگترین", ["بزرگترین", "بیشترین", "ماکزیمم", "max", "بزرگتر"], "max", "بزرگ‌ترین عدد", "پیدا کردن بزرگ‌ترین عدد"),
    ("کوچکترین", ["کوچکترین", "کمترین", "مینیمم", "min", "کوچکتر"], "min", "کوچک‌ترین عدد", "پیدا کردن کوچک‌ترین عدد"),
    ("فاکتوریل", ["فاکتوریل", "factorial", "عاملی"], "factorial", "فاکتوریل", "محاسبه فاکتوریل یک عدد"),
    ("فیبوناچی", ["فیبوناچی", "fibonacci", "دنباله فیبوناچی"], "fibonacci", "دنباله فیبوناچی", "تولید دنباله فیبوناچی"),
    ("عدد اول", ["عدد اول", "prime", "آیا اول", "اول است"], "prime", "بررسی عدد اول", "تشخیص عدد اول"),
    ("زوج و فرد", ["زوج", "فرد", "زوج و فرد", "زوج یا فرد"], "evenodd", "زوج یا فرد", "تشخیص زوج یا فرد بودن"),
    ("معکوس متن", ["معکوس", "وارونه", "reverse", "برعکس کن"], "reverse", "معکوس متن", "معکوس کردن یک رشته"),
    ("پالیندروم", ["پالیندروم", "palindrome", "متقارن"], "palindrome", "بررسی پالیندروم", "تشخیص پالیندروم بودن یک متن"),
    ("سلام", ["سلام", "خوش اومد", "خوش آمد", "greet", "خوشامد"], "greet", "پیام خوش‌آمد", "چاپ پیام خوش‌آمد با نام کاربر"),
    ("ماشین حساب", ["ماشین حساب", "ماشین‌حساب", "calculator", "محاسبه گر", "محاسبه‌گر"], "calculator", "ماشین حساب", "ماشین حساب ساده با حلقه"),
    ("شمارش معکوس", ["شمارش معکوس", "countdown", "شمارش از"], "countdown", "شمارش معکوس", "شمارش معکوس از یک عدد"),
    ("حدس عدد", ["حدس عدد", "بازی حدس", "guess"], "guess", "بازی حدس عدد", "بازی حدس عدد با شانس‌های محدود"),
    ("تبدیل دما", ["تبدیل دما", "دما", "سانتیگراد", "فارنهایت", "سلیسیوس", "تبدیل دمای"], "temp", "تبدیل دما", "تبدیل بین سانتی‌گراد و فارنهایت"),
    ("مساحت", ["مساحت", "مساخت", "مسا حت"], "area", "محاسبه مساحت", "محاسبه مساحت دایره یا مستطیل"),
    ("BMI", ["bmi", "شاخص توده", "شاخص توده بدنی", "چاقی"], "bmi", "شاخص توده بدنی", "محاسبه BMI با قد و وزن"),
]

FA_NAME = {"multiply": "ضرب اعداد", "add": "جمع اعداد", "subtract": "تفریق اعداد",
           "divide": "تقسیم اعداد", "average": "میانگین اعداد", "max": "بزرگ‌ترین عدد",
           "min": "کوچک‌ترین عدد", "factorial": "فاکتوریل", "fibonacci": "دنباله فیبوناچی",
           "prime": "بررسی عدد اول", "evenodd": "زوج یا فرد", "reverse": "معکوس متن",
           "palindrome": "پالیندروم", "greet": "پیام خوش‌آمد", "calculator": "ماشین حساب",
           "countdown": "شمارش معکوس", "guess": "حدس عدد", "temp": "تبدیل دما",
           "area": "مساحت", "bmi": "شاخص توده بدنی"}


def detect(text):
    """Return (op_key, fa_name, desc) or None."""
    s = persian.soft(text)
    best, best_len = None, 0
    for _fa, kws, key, _n, _d in OPS:
        for kw in kws:
            if persian.soft(kw) in s and len(persian.soft(kw)) > best_len:
                best, best_len = key, len(persian.soft(kw))
    if not best:
        return None
    for _fa, _kws, key, name, desc in OPS:
        if key == best:
            return key, name, desc
    return None


def wants_python(text):
    s = persian.soft(text)
    return any(w in s for w in ["پایتون", "python", ".py", "اسکریپت", "پایton"])


def _count(text, default=3):
    """How many numbers the user wants. Prefers explicit digits, then whole-word
    Persian number words (so «نه» inside «کنه» never counts as 9).
    """
    m = _NUM_RE.search(persian.to_ascii_digits(text))
    if m:
        n = int(m.group(1))
        if 1 <= n <= 20:
            return n
    s = persian.soft(text).replace("یه", "یک")
    # number word directly next to «عدد»/«تا» wins («چهار عدد» = 4 even
    # when «یک برنامه» also appears earlier in the sentence)
    mm = re.search(r"([\u0600-\u06FF]+)\s*(?:تا|عدد)", s)
    if mm and mm.group(1) in _WORD_NUM:
        return _WORD_NUM[mm.group(1)]
    for w, n in _WORD_NUM.items():
        pat = r"(?<![\u0600-\u06FFa-zA-Z0-9])" + persian.soft(w) + r"(?![\u0600-\u06FFa-zA-Z0-9])"
        if re.search(pat, s) and ("تا" in s or "عدد" in s):
            return n
    return default


def _slug(name):
    return re.sub(r"[\\/:*?\"<>|\s]+", "-", name).strip("-")[:30] or "program"


# ------------------------------------------------------------ python
def _py_program(op, count):
    n = count
    doc = FA_NAME.get(op, "برنامه")
    if op == "multiply":
        body = f"""def main():
    count = {n}
    print("لطفاً {persian.to_persian_digits(str(n))} عدد وارد کن:")
    numbers = []
    for i in range(count):
        while True:
            try:
                numbers.append(float(input(f"عدد {{i + 1}}: ")))
                break
            except ValueError:
                print("ورودی نامعتبر است؛ دوباره عدد وارد کن.")
    result = 1
    for x in numbers:
        result *= x
    print("حاصل‌ضرب:", result)"""
        test_in = "\n".join(["2", "3", "4", "5"]) + "\n"
    elif op == "add":
        body = f"""def main():
    count = {n}
    print("لطفاً {persian.to_persian_digits(str(n))} عدد وارد کن:")
    total = 0.0
    for i in range(count):
        while True:
            try:
                total += float(input(f"عدد {{i + 1}}: "))
                break
            except ValueError:
                print("ورودی نامعتبر است.")
    print("حاصل جمع:", total)"""
        test_in = "\n".join(["10", "20", "30"]) + "\n"
    elif op == "subtract":
        body = f"""def main():
    count = {n}
    print("لطفاً {persian.to_persian_digits(str(n))} عدد وارد کن (عدد اول از بقیه کم می‌شود):")
    values = []
    for i in range(count):
        while True:
            try:
                values.append(float(input(f"عدد {{i + 1}}: ")))
                break
            except ValueError:
                print("ورودی نامعتبر است.")
    result = values[0]
    for x in values[1:]:
        result -= x
    print("حاصل تفریق:", result)"""
        test_in = "\n".join(["100", "20", "30"]) + "\n"
    elif op == "divide":
        body = f"""def main():
    count = {n}
    print("لطفاً {persian.to_persian_digits(str(n))} عدد وارد کن (عدد اول تقسیم می‌شود بر بقیه):")
    values = []
    for i in range(count):
        while True:
            try:
                values.append(float(input(f"عدد {{i + 1}}: ")))
                break
            except ValueError:
                print("ورودی نامعتبر است.")
    result = values[0]
    for x in values[1:]:
        if x == 0:
            print("تقسیم بر صفر مجاز نیست.")
            return
        result /= x
    print("حاصل تقسیم:", result)"""
        test_in = "\n".join(["100", "4", "5"]) + "\n"
    elif op == "average":
        body = f"""def main():
    count = {n}
    print("لطفاً {persian.to_persian_digits(str(n))} عدد وارد کن:")
    total = 0.0
    for i in range(count):
        while True:
            try:
                total += float(input(f"عدد {{i + 1}}: "))
                break
            except ValueError:
                print("ورودی نامعتبر است.")
    print("میانگین:", total / count)"""
        test_in = "\n".join(["10", "20", "30"]) + "\n"
    elif op == "max":
        body = f"""def main():
    count = {n}
    print("لطفاً {persian.to_persian_digits(str(n))} عدد وارد کن:")
    values = []
    for i in range(count):
        while True:
            try:
                values.append(float(input(f"عدد {{i + 1}}: ")))
                break
            except ValueError:
                print("ورودی نامعتبر است.")
    print("بزرگ‌ترین عدد:", max(values))"""
        test_in = "\n".join(["12", "45", "7"]) + "\n"
    elif op == "min":
        body = f"""def main():
    count = {n}
    print("لطفاً {persian.to_persian_digits(str(n))} عدد وارد کن:")
    values = []
    for i in range(count):
        while True:
            try:
                values.append(float(input(f"عدد {{i + 1}}: ")))
                break
            except ValueError:
                print("ورودی نامعتبر است.")
    print("کوچک‌ترین عدد:", min(values))"""
        test_in = "\n".join(["12", "45", "7"]) + "\n"
    elif op == "factorial":
        body = """def factorial(x):
    if x < 0:
        return None
    result = 1
    for i in range(2, x + 1):
        result *= i
    return result

def main():
    while True:
        try:
            x = int(input("یک عدد صحیح وارد کن: "))
            break
        except ValueError:
            print("ورودی نامعتبر است.")
    f = factorial(x)
    if f is None:
        print("فاکتوریل عدد منفی تعریف نشده است.")
    else:
        print(f"فاکتوریل {x}:", f)"""
        test_in = "5\n"
    elif op == "fibonacci":
        body = """def main():
    while True:
        try:
            n = int(input("چند جمله از دنباله فیبوناچی می‌خواهی؟ "))
            break
        except ValueError:
            print("ورودی نامعتبر است.")
    a, b = 0, 1
    seq = []
    for _ in range(n):
        seq.append(a)
        a, b = b, a + b
    print("دنباله:", "، ".join(map(str, seq)))"""
        test_in = "8\n"
    elif op == "prime":
        body = """def is_prime(x):
    if x < 2:
        return False
    i = 2
    while i * i <= x:
        if x % i == 0:
            return False
        i += 1
    return True

def main():
    while True:
        try:
            x = int(input("یک عدد وارد کن: "))
            break
        except ValueError:
            print("ورودی نامعتبر است.")
    print(f"{x} عدد اول است." if is_prime(x) else f"{x} عدد اول نیست.")"""
        test_in = "17\n"
    elif op == "evenodd":
        body = """def main():
    while True:
        try:
            x = int(input("یک عدد وارد کن: "))
            break
        except ValueError:
            print("ورودی نامعتبر است.")
    print("زوج است." if x % 2 == 0 else "فرد است.")"""
        test_in = "8\n"
    elif op == "reverse":
        body = """def main():
    text = input("یک متن بنویس: ")
    print("معکوس:", text[::-1])"""
        test_in = "سلام\n"
    elif op == "palindrome":
        body = """def main():
    text = input("یک متن بنویس: ")
    clean = "".join(ch for ch in text if ch.isalnum()).lower()
    print("پالیندروم است." if clean == clean[::-1] else "پالیندروم نیست.")"""
        test_in = "radar\n"
    elif op == "greet":
        body = """def main():
    name = input("اسمت چیه؟ ")
    print(f"سلام {name}! خوش آمدی. من Professor Flash هستم.")"""
        test_in = "علی\n"
    elif op == "calculator":
        body = """def main():
    print("ماشین حساب - برای خروج، کلمه exit را بنویس.")
    while True:
        expr = input("عبارت (مثل 2 + 3): ")
        if expr.strip().lower() in ("exit", "خروج"):
            break
        try:
            result = eval(expr)
            print("=", result)
        except Exception:
            print("عبارت نامعتبر است.")"""
        test_in = "2 + 3 * 4\nexit\n"
    elif op == "countdown":
        body = """import time

def main():
    while True:
        try:
            n = int(input("شمارش معکوس از چند شروع شود؟ "))
            break
        except ValueError:
            print("ورودی نامعتبر است.")
    for i in range(n, 0, -1):
        print(i)
        time.sleep(1)
    print("شروع!")"""
        test_in = "3\n"
    elif op == "guess":
        body = """import random

def main():
    target = random.randint(1, 20)
    print("عدد ۱ تا ۲۰ را حدس بزن (۵ شانس داری).")
    for chance in range(5):
        try:
            guess = int(input(f"شانس {chance + 1}: "))
        except ValueError:
            print("ورودی نامعتبر است.")
            continue
        if guess == target:
            print("آفرین، درست حدس زدی!")
            return
        print("بزرگ‌تر بگو." if guess < target else "کوچک‌تر بگو.")
    print(f"متاسفم! عدد موردنظر {target} بود.")"""
        test_in = "10\n15\n5\n7\n9\n"
    elif op == "temp":
        body = """def main():
    print("تبدیل دما")
    try:
        value = float(input("مقدار دما را وارد کن: "))
    except ValueError:
        print("ورودی نامعتبر است.")
        return
    print(f"{value} سانتی‌گراد = {value * 9 / 5 + 32:.2f} فارنهایت")
    print(f"{value} فارنهایت = {(value - 32) * 5 / 9:.2f} سانتی‌گراد")"""
        test_in = "100\n"
    elif op == "area":
        body = """import math

def main():
    print("۱) دایره   ۲) مستطیل")
    try:
        choice = int(input("کدام شکل؟ "))
    except ValueError:
        print("ورودی نامعتبر است.")
        return
    if choice == 1:
        r = float(input("شعاع: "))
        print(f"مساحت دایره: {math.pi * r * r:.4f}")
    elif choice == 2:
        a = float(input("طول: "))
        b = float(input("عرض: "))
        print(f"مساحت مستطیل: {a * b}")
    else:
        print("انتخاب نامعتبر است.")"""
        test_in = "1\n3\n"
    elif op == "bmi":
        body = """def main():
    try:
        weight = float(input("وزن (کیلوگرم): "))
        height = float(input("قد (متر): "))
    except ValueError:
        print("ورودی نامعتبر است.")
        return
    bmi = weight / (height * height)
    print(f"BMI: {bmi:.2f}")
    if bmi < 18.5:
        print("کم‌وزنی")
    elif bmi < 25:
        print("وزن نرمال")
    elif bmi < 30:
        print("اضافه‌وزن")
    else:
        print("چاقی")"""
        test_in = "70\n1.75\n"
    else:
        return None
    code = (
        "# -*- coding: utf-8 -*-\n"
        f'"""برنامه {doc} - تولیدشده توسط Professor Flash V1.\\n\\n'
        f"برنامه {doc} - کد واقعی و قابل اجرا با پایتون ۳.\"\n"
        '\"\"\"\n\n\n'
        + body + "\n\n\nif __name__ == \"__main__\":\n    main()\n"
    )
    return {"doc": doc, "body": code, "test_input": test_in}


def generate_python(text):
    """Synthesize a real Python program. Returns dict or None."""
    detected = detect(text)
    if not detected:
        return None
    op, fa, desc = detected
    count = _count(text)
    prog = _py_program(op, count)
    if not prog:
        return None
    name = _slug(f"{fa}-{op}")
    return {
        "name": name,
        "type_fa": fa,
        "plan": [f"تحلیل درخواست: {fa}", "نوشتن فایل main.py", "اجرای تست با ورودی نمونه", "ارائه کد و خروجی"],
        "files": {"main.py": prog["body"]},
        "test_input": prog["test_input"],
        "summary": f"برنامه پایتون «{fa}» - {desc}",
    }


# --------------------------------------------------------------- web
def generate_web(text):
    """Synthesize a real standalone web page for the operation. dict|None."""
    detected = detect(text)
    if not detected:
        return None
    op, fa, desc = detected
    count = _count(text)
    count = 4 if op == "multiply" else count
    fa_count = persian.to_persian_digits(str(count))

    if op in ("multiply", "add", "subtract", "divide", "average", "max", "min"):
        op_fn = {
            "multiply": "a*b", "add": "a+b", "subtract": "a-b",
            "divide": "a/b", "average": "avg", "max": "Math.max", "min": "Math.min",
        }[op]
        inputs = "\n".join(
            f'<input type="number" step="any" id="n{i}" placeholder="عدد {persian.to_persian_digits(str(i+1))}">'
            for i in range(count)
        )
        js = (
            f"function calc(){{const v=[...Array({count})].map((_,i)=>parseFloat(document.getElementById('n'+i).value));"
            f"if(v.some(isNaN)){{document.getElementById('out').textContent='همه اعداد را وارد کن';return;}}"
            f"let r;"
        )
        if op == "multiply":
            js += "r=v.reduce((x,y)=>x*y,1);"
        elif op == "add":
            js += "r=v.reduce((x,y)=>x+y,0);"
        elif op == "subtract":
            js += "r=v.slice(1).reduce((x,y)=>x-y,v[0]);"
        elif op == "divide":
            js += "r=v.slice(1).reduce((x,y)=>x/y,v[0]);"
        elif op == "average":
            js += "r=v.reduce((x,y)=>x+y,0)/v.length;"
        elif op == "max":
            js += "r=Math.max(...v);"
        elif op == "min":
            js += "r=Math.min(...v);"
        js += "document.getElementById('out').textContent='نتیجه: '+r;}"
    elif op == "factorial":
        inputs = '<input type="number" id="n0" placeholder="یک عدد">'
        js = ("function calc(){const x=parseInt(document.getElementById('n0').value);if(isNaN(x)||x<0){document.getElementById('out').textContent='عدد صحیح نامنفی وارد کن';return;}let r=1;for(let i=2;i<=x;i++)r*=i;document.getElementById('out').textContent='فاکتوریل '+x+' = '+r;}")
    elif op == "fibonacci":
        inputs = '<input type="number" id="n0" placeholder="تعداد جمله">'
        js = ("function calc(){const n=parseInt(document.getElementById('n0').value);if(isNaN(n)||n<1){document.getElementById('out').textContent='عدد معتبر وارد کن';return;}let a=0,b=1,seq=[];for(let i=0;i<n;i++){seq.push(a);[a,b]=[b,a+b];}document.getElementById('out').textContent='دنباله: '+seq.join('، ');}")
    elif op == "evenodd":
        inputs = '<input type="number" id="n0" placeholder="یک عدد">'
        js = ("function calc(){const x=parseInt(document.getElementById('n0').value);document.getElementById('out').textContent=isNaN(x)?'عدد وارد کن':(x%2===0?'زوج است':'فرد است');}")
    elif op == "prime":
        inputs = '<input type="number" id="n0" placeholder="یک عدد">'
        js = ("function calc(){const x=parseInt(document.getElementById('n0').value);if(isNaN(x)){document.getElementById('out').textContent='عدد وارد کن';return;}if(x<2){document.getElementById('out').textContent='عدد اول نیست';return;}for(let i=2;i*i<=x;i++){if(x%i===0){document.getElementById('out').textContent='عدد اول نیست';return;}}document.getElementById('out').textContent='عدد اول است';}")
    elif op == "reverse":
        inputs = '<input type="text" id="n0" placeholder="متن">'
        js = ("function calc(){const t=document.getElementById('n0').value;document.getElementById('out').textContent='معکوس: '+[...t].reverse().join('');}")
    elif op == "palindrome":
        inputs = '<input type="text" id="n0" placeholder="متن">'
        js = ("function calc(){const t=document.getElementById('n0').value;const c=t.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g,'');document.getElementById('out').textContent=c===c.split('').reverse().join('')?'پالیندروم است':'پالیندروم نیست';}")
    elif op == "greet":
        inputs = '<input type="text" id="n0" placeholder="اسمت چیه؟">'
        js = ("function calc(){const n=document.getElementById('n0').value||'دوست عزیز';document.getElementById('out').textContent='سلام '+n+'! خوش آمدی.';}")
    elif op == "countdown":
        inputs = '<input type="number" id="n0" placeholder="از چند شروع شود؟">'
        js = ("function calc(){const n=parseInt(document.getElementById('n0').value);if(isNaN(n)){document.getElementById('out').textContent='عدد وارد کن';return;}let out='';for(let i=n;i>=1;i--)out+=i+' ... ';out+='شروع!';document.getElementById('out').textContent=out;}")
    elif op == "temp":
        inputs = '<input type="number" id="n0" placeholder="مقدار دما">'
        js = ("function calc(){const v=parseFloat(document.getElementById('n0').value);if(isNaN(v)){document.getElementById('out').textContent='عدد وارد کن';return;}const f=v*9/5+32,c=(v-32)*5/9;document.getElementById('out').textContent=v+' سانتی‌گراد = '+f.toFixed(2)+' فارنهایت | '+v+' فارنهایت = '+c.toFixed(2)+' سانتی‌گراد';}")
    elif op == "area":
        inputs = '<input type="number" id="n0" placeholder="شعاع دایره">'
        js = ("function calc(){const r=parseFloat(document.getElementById('n0').value);if(isNaN(r)){document.getElementById('out').textContent='عدد وارد کن';return;}document.getElementById('out').textContent='مساحت دایره = '+(Math.PI*r*r).toFixed(4);}")
    elif op == "bmi":
        inputs = '<input type="number" id="n0" placeholder="وزن (کیلوگرم)"><input type="number" id="n1" placeholder="قد (متر)">'
        js = ("function calc(){const w=parseFloat(document.getElementById('n0').value),h=parseFloat(document.getElementById('n1').value);if(isNaN(w)||isNaN(h)||h<=0){document.getElementById('out').textContent='مقادیر معتبر وارد کن';return;}const b=w/(h*h);let s=b<18.5?'کم‌وزنی':b<25?'وزن نرمال':b<30?'اضافه‌وزن':'چاقی';document.getElementById('out').textContent='BMI = '+b.toFixed(2)+' ('+s+')';}")
    else:
        return None

    html = f"""<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{fa}</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ font-family:Vazirmatn,Tahoma,sans-serif; min-height:100vh; display:grid; place-items:center;
         background:radial-gradient(800px 500px at 80% -10%, rgba(124,58,237,.25), transparent 60%),
                    radial-gradient(600px 400px at 10% 110%, rgba(6,182,212,.18), transparent 60%), #05060a; }}
  .card {{ width:min(420px, 92vw); background:#0d0f17; border:1px solid rgba(255,255,255,.1);
          border-radius:18px; padding:28px 26px; box-shadow:0 20px 60px rgba(0,0,0,.5); }}
  h1 {{ font-size:20px; color:#e8eaf0; margin-bottom:6px; }}
  p {{ color:#8b93a7; font-size:13px; margin-bottom:18px; }}
  input {{ width:100%; margin:7px 0; padding:12px 14px; border-radius:10px; border:1px solid rgba(255,255,255,.12);
          background:#11141d; color:#e8eaf0; font-size:15px; outline:none; font-family:inherit; }}
  input:focus {{ border-color:rgba(124,58,237,.6); box-shadow:0 0 0 3px rgba(124,58,237,.18); }}
  button {{ width:100%; margin-top:10px; padding:13px; border:none; border-radius:10px; cursor:pointer;
           background:linear-gradient(135deg,#7c3aed,#06b6d4); color:#fff; font-size:15px; font-weight:700; font-family:inherit; }}
  button:hover {{ filter:brightness(1.15); }}
  .out {{ margin-top:16px; padding:14px; border-radius:10px; background:#11141d; border:1px solid rgba(6,182,212,.25);
          color:#06b6d4; font-size:16px; font-weight:700; min-height:22px; }}
</style>
</head>
<body>
  <div class="card">
    <h1>{fa}</h1>
    <p>{desc}</p>
    {inputs}
    <button onclick="calc()">محاسبه</button>
    <div class="out" id="out"></div>
  </div>
  <script>
    {js}
  </script>
</body>
</html>"""
    name = _slug(f"{fa}-{op}")
    return {
        "name": name,
        "type_fa": fa,
        "plan": [f"تحلیل درخواست: {fa}", "نوشتن index.html", "تست ساختار", "ارائه پروژه"],
        "files": {"index.html": html},
        "test_input": "",
        "summary": f"برنامه وب «{fa}» - {desc}",
    }
