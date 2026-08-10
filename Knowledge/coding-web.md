# توسعه وب (HTML/CSS/JS)

## ساختار HTML5
- `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>` برای معناداری.
- متای سئو در `<head>`: `title`, `meta name="description"`, `meta name="viewport"`, `og:title`, `og:description`.
- `lang="fa"` و `dir="rtl"` برای سایت فارسی؛ `lang="en"` برای انگلیسی.
- تصاویر: `alt` توضیحی، `loading="lazy"`, `width`/`height`.
- دسترس‌پذیری: `aria-label` روی دکمه‌های آیکونی، `role` در صورت نیاز، کنتراست بالا.

## CSS
- ریسپانسیو با `flexbox`/`grid` و `clamp()`، `min-width`/`max-width`.
- تم تیره: پس‌زمینه `#0a0a0f`-`#12121a`، متن `#e8e8f0`، رنگ تأکید (نیون) `#00e5ff`/`#ff2d95`/`#7c4dff`.
- فونت فارسی: `Vazirmatn` یا `Vazir` از CDN گوگل‌فونت‌ز؛ `font-family: "Vazirmatn", sans-serif;`.
- انیمیشن: `@keyframes` برای ورود المان‌ها، `transition` برای hover، `transform: translateY(-2px)`.
- دکمه hover: تغییر رنگ/سایه + `cursor: pointer`؛ حالت `:focus-visible` را فراموش نکن.
- `margin`/`padding` منظم و یکدست؛ فضای سفید کافی.

## جاوااسکریپت
- المنت‌ها را با `document.getElementById`/`querySelector` بگیر؛ رویداد با `addEventListener`.
- DOM را بعد از load بساز یا `defer` بگذار.
- `fetch` برای API:
```js
fetch("/api/data").then(r => r.json()).then(d => { /* render */ }).catch(e => console.error(e));
```
- ورودی کاربر را اعتبارسنجی کن (`parseInt` با `isNaN` چک).
- خطاها را با try/catch بگیر و به کاربر پیام بده.

## الگوهای کلیدی
- ماشین‌حساب: دکمه‌ها با `data-action`/`data-num`، یک تابع برای همه، `eval` نزن.
- بازی: حلقه با `requestAnimationFrame`، وضعیت در متغیر، برخورد با مختصات.
- فرم: preventDefault، جمع‌آوری مقادیر، نمایش نتیجه.

## قوانین تحویل
- همه فایل‌ها باید به هم لینک شوند (index.html → style.css/app.js) با مسیرهای درست.
- کد بدون کامنت باشد مگر کاربر خواسته باشد؛ کامل و بدون خطا.
- کد را یک‌تکه بده و هرگز وسطش قطع نکن.
