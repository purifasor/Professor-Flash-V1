# Web Development (HTML/CSS/JS)
# keywords: html, css, js, javascript, وب, سایت, ریسپانسیو, responsive, rtl, انیمیشن, animation, flexbox, grid, فونت, font

Professional single-page web app patterns.

## Structure
- `index.html` links `style.css` in <head> and `app.js` before </body>.
- Persian pages: `<html lang="fa" dir="rtl">`.
- Include SEO meta: title, description, viewport, og:title, og:description.

## RTL + mixed text
- Use `dir="rtl"` on the container and `unicode-bidi: plaintext` on text
  nodes so English words inside Persian sentences keep natural order.
- Numbers render correctly with `font-variant-numeric: tabular-nums`.

## Responsive (mobile-first)
    .container { display: grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 640px) { .container { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 960px) { .container { grid-template-columns: repeat(3, 1fr); } }

## Layout
- Flexbox for 1D rows/columns; Grid for 2D.
- `gap` instead of margins between siblings.
- `min-height: 100vh` + `display:flex; flex-direction:column` for app shells.

## Animation (cheap, GPU-friendly)
    .card { transition: transform .2s ease, box-shadow .2s ease; }
    .card:hover { transform: translateY(-4px); box-shadow: 0 10px 30px rgba(0,0,0,.3); }
- Animate `transform`/`opacity` only (never `top`/`left`), keep it smooth on weak GPUs.
- `@keyframes` + `animation` for entrances; respect `prefers-reduced-motion`.

## Persian fonts (offline-friendly)
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700&display=swap" rel="stylesheet">
    body { font-family: "Vazirmatn", "Segoe UI", Tahoma, sans-serif; }

## Dark theme
    :root { --bg:#0b0f17; --panel:#141a26; --line:#232b3b; --text:#e6e9f0; --muted:#8a93a6; --accent:#7c3aed; }
    body { background:var(--bg); color:var(--text); }

## JS
- Attach events after DOM ready: `document.addEventListener("DOMContentLoaded", ...)` or
  place the script at the end of body.
- Use `querySelector`/`querySelectorAll`; delegate clicks with `closest()`.
- `textContent` for text (XSS-safe); `innerHTML` only for trusted markup.
- No external CDN dependencies unless required; keep apps self-contained.
