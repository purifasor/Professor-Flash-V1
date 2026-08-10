# سئو و جستجوی پیشرفته (Google Dork / دورک / گوگل دورک)

## سئو (SEO)
- تگ title تا ۶۰ کاراکتر با کلمه کلیدی اصلی در ابتدا.
- meta description تا ۱۵۵ کاراکتر، ترغیب‌کننده با کلمه کلیدی.
- ساختار heading: فقط یک h1، سپس h2/h3 مرتب.
- `alt` برای همه تصاویر با کلمه کلیدی طبیعی.
- URL کوتاه و خوانا: `example.com/آموزش-پایتون` (حروف کوچک، خط تیره).
- سرعت: فشرده‌سازی تصاویر، `loading="lazy"`، کش.
- موبایل‌فرست (mobile-first): viewport و طراحی واکنش‌گرا.
- داده ساخت‌یافته (schema.org): `Product`, `Article`, `FAQPage` با JSON-LD.
- sitemap.xml و robots.txt.
- لینک‌سازی داخلی بین صفحات مرتبط.
- متن جایگزین برای محتوای چندرسانه‌ای و caption.

## Google Dork (عملگرهای جستجو)
- `site:example.com` — فقط یک دامنه.
- `site:example.com filetype:pdf` — فایل‌های خاص.
- `intitle:"کلمه"` — کلمه در عنوان صفحه.
- `inurl:admin` — کلمه در آدرس.
- `intext:"عبارت"` — عبارت در متن صفحه.
- `"عبارت دقیق"` — جستجوی دقیق phrase.
- `-کلمه` — حذف کلمه از نتایج.
- `ext:sql` / `ext:log` — پسوند فایل.
- `filetype:env` — فایل‌های محیطی.
- `allinurl:php?id=` — الگوهای پارامتری.
- `cache:domain.com` — نسخه کش‌شده.
- `related:domain.com` — سایت‌های مشابه.
- `"متن" site:example.com` — ترکیب عملگرها.

## ترکیب‌های کاربردی
- `intitle:"index of" + "parent directory"` — فهرست‌بندی باز.
- `filetype:log "password"` — لاگ‌های درز کرده.
- `inurl:wp-content/uploads` — فایل‌های آپلودشده وردپرس.
- `site:github.com "api_key"` — کلیدهای لو رفته روی گیت‌هاب.
- `inurl:admin login` — پنل‌های مدیریتی.
- `ext:xml inurl:sitemap` — نقشه سایت‌ها.

## قوانین
- عملگرها را دقیق و با مثال کاربردی توضیح بده.
- جستجو را درخواست کردی → با عملگر درست ترکیب کن و به‌کار بگیر.
- نتیجه را منبع‌دار و خلاصه تحویل بده.
