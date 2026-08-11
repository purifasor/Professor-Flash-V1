# الگوهای استاندارد پایتون

## ساختار برنامه
- همیشه از `if __name__ == "__main__": main()` استفاده کن.
- ورودی‌ها را با `input()` بگیر و با `int()`/`float()` تبدیل کن؛ خطای تبدیل را با try/except مدیریت کن.
- خروجی با `print(f"...")`؛ f-string برای الحاق مقادیر.
- برنامه باید با ورودی نمونه واقعی بدون خطا اجرا شود و نتیجه را نشان دهد.

## الگوهای رایج
```python
# گرفتن چند عدد در یک خط
nums = list(map(int, input().split()))
# یا: a, b, c, d = map(int, input().split())

# جابه‌جایی دو متغیر
a, b = b, a

# حلقه روی فهرست با اندیس
for i, x in enumerate(nums):
    print(i, x)

# مدیریت خطای ورودی
try:
    n = int(input("عدد: "))
except ValueError:
    print("ورودی نامعتبر است")
```

## دام‌های رایج (هرگز تکرار نکن)
- آرگومان پیش‌فرض تغییرپذیر: `def f(x, lst=[])` ← باید `lst=None`.
- به‌جای `==` با None از `is None` استفاده کن.
- `input().split()` در پایتون ۳ رشته برمی‌گرداند؛ قبل از محاسبه عدد کن.
- دقت اعشاری: برای پول/محاسبات دقیق از `decimal.Decimal` استفاده کن.
- خواندن فایل: `with open(path, encoding="utf-8") as f:` — همیشه encoding بده.
- `print` در پایتون ۳ تابع است و با پرانتز.
- اگر خطای IndentationError/NameError دیدی، برنامه را کامل بازنویسی کن، وصله نزن.

## تست
- قبل از تحویل، با ۱-۲ ورودی نمونه ذهنی اجرا کن و خروجی را بررسی کن.
- کد را کامل و یک‌تکه بده؛ هرگز وسط کد قطع نکن.
- توضیح «این خط چه می‌کند» نده مگر کاربر خواسته باشد.

## کتابخانه‌های استاندارد مفید
- `os`, `sys`, `subprocess`, `socket`, `threading`, `time`, `random`, `json`, `re`, `math`, `pathlib`.
- مثال subprocess:
```python
import subprocess
r = subprocess.run(["dir"], shell=True, capture_output=True, text=True)
print(r.stdout, r.stderr)
```
- سوکت (socket) نویسی: سوکت یعنی برنامه‌نویسی شبکه — `socket.socket(AF_INET, SOCK_STREAM)` برای TCP، `connect` به سرور، `send/recv` برای ارسال/دریافت، `bind/listen/accept` برای سرور، `socket.connect_ex()` برای بررسی باز بودن پورت.
- مثال socket (بررسی پورت باز):
```python
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(2)
result = s.connect_ex(("127.0.0.1", 80))
print("باز" if result == 0 else "بسته")
s.close()
```
