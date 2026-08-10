# SEO (بهینه‌سازی موتور جستجو)
# keywords: seo, سئو, موتور جستجو, google, گوگل, رتبه, meta, سرچ, رتبه‌بندی

Search-engine optimization essentials for the sites Professor Flash builds.

## On-page essentials
- One `<title>` (under ~60 chars) with the main keyword first.
- One `<meta name="description">` (under ~155 chars) that summarizes the page.
- Semantic headings: exactly one `<h1>`, then `<h2>`/`<h3>` in order.
- `alt` attribute on every image (describes the image in Persian).
- Descriptive URLs and file names instead of `page1`.

## Technical
- `lang` attribute set correctly (`fa` for Persian).
- `viewport` meta for mobile; mobile-friendliness is a ranking factor.
- Fast load: minimal external requests, no huge images, lazy-load below the fold.
- Internal links between related pages with meaningful anchor text.

## Content
- Unique, useful content that answers what people actually search.
- Use related keywords naturally; never keyword-stuff.
- Headings and first paragraph should state the page's purpose clearly.

## Basic meta template for a Persian site
    <meta name="description" content="...">
    <meta property="og:title" content="...">
    <meta property="og:description" content="...">
    <meta name="robots" content="index, follow">
