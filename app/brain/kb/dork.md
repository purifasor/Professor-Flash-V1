# Google Dork (عملگرهای جستجوی پیشرفته)
# keywords: دورک, dork, گوگل, google, جستجو, search, عملگر, operator, سرچ, پیدا کردن, فایل

Google search operators (Google Dork) for precise web research and
information discovery. These are legitimate search techniques.

## Core operators
- `site:example.com` - restrict results to one domain
- `inurl:login` - results whose URL contains the word
- `intitle:"index of"` - pages with that title (often directory listings)
- `filetype:pdf` - only files of that type (pdf, docx, xlsx, csv, zip, txt)
- `intext:password` - pages containing the word in the body
- `"exact phrase"` - exact phrase match
- `-word` - exclude a word
- `OR` - either term
- `after:2020-01-01` / `before:2023-12-31` - date filters
- `cache:url` - cached version of a page
- `related:site.com` - similar sites
- `link:site.com` - pages linking to a site

## Combining (examples)
- `filetype:pdf "گزارش سالانه" site:ir`
- `intitle:index.of "parent directory" mp3`
- `inurl:admin login -inurl:signup`

## How to explain a dork search to the user
1. State the exact query with operators.
2. Explain what each operator does.
3. Give 2-3 example queries for their topic.
