# -*- coding: utf-8 -*-
"""Web search and image download using only the standard library.

Professor Flash is fully offline-first: if the network is unavailable the
search simply returns [] / None and the caller skips gracefully (the user
explicitly asked for a "skip" option instead of blocking).

Uses DuckDuckGo's HTML endpoint (no API key, free, no rate limits for
light usage). All requests have short timeouts so a dead network never
freezes the model.
"""

import html as html_mod
import json
import re
import time
import urllib.parse
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

SEARCH_TIMEOUT = 6
IMAGE_TIMEOUT = 10


def _get(url, timeout=SEARCH_TIMEOUT, referer=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if referer:
        req.add_header("Referer", referer)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _clean_fragment(frag):
    frag = re.sub(r"<[^>]+>", "", frag)
    return html_mod.unescape(frag).strip()


def search_web(query, max_results=5):
    """Return a list of {title, url, snippet} dicts. [] when offline."""
    try:
        q = urllib.parse.quote(query)
        raw = _get(f"https://html.duckduckgo.com/html/?q={q}")
        text = raw.decode("utf-8", errors="replace")
        blocks = re.findall(
            r'<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)</a>',
            text,
            re.S,
        )
        snippets = re.findall(
            r'<a class="result__snippet"[^>]*>(.*?)</a>', text, re.S
        )
        results = []
        for i, (href, title) in enumerate(blocks[:max_results]):
            url = html_mod.unescape(href)
            if url.startswith("//"):
                url = "https:" + url
            snippet = _clean_fragment(snippets[i]) if i < len(snippets) else ""
            results.append(
                {
                    "title": _clean_fragment(title),
                    "url": url,
                    "snippet": snippet,
                }
            )
        return results
    except Exception:
        return []


def _save_image(raw, dest_path):
    if len(raw) < 512:  # tiny file = likely an error placeholder
        return None
    with open(dest_path, "wb") as f:
        f.write(raw)
    return dest_path


def _ddg_image(query, dest_path, timeout):
    try:
        page_url = (
            "https://duckduckgo.com/?q="
            + urllib.parse.quote(query)
            + "&iax=images&ia=images"
        )
        page = _get(page_url, timeout=timeout).decode("utf-8", errors="replace")
        m = re.search(r"vqd=([\d\-]+)", page)
        if not m:
            return None
        api = (
            "https://duckduckgo.com/i.js?l=us-en&o=json&q="
            + urllib.parse.quote(query)
            + "&vqd="
            + m.group(1)
        )
        data = json.loads(_get(api, timeout=timeout).decode("utf-8", errors="replace"))
        results = data.get("results") or []
        if not results:
            return None
        img_url = results[0].get("image")
        if not img_url:
            return None
        raw = _get(img_url, timeout=timeout, referer="https://duckduckgo.com/")
        return _save_image(raw, dest_path)
    except Exception:
        return None


def _wikimedia_image(query, dest_path, timeout):
    """Fallback: Wikimedia Commons API (free, no key, very reliable)."""
    try:
        api = (
            "https://commons.wikimedia.org/w/api.php?action=query&generator=search"
            "&gsrsearch=" + urllib.parse.quote(query) +
            "&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=900&format=json"
        )
        data = json.loads(_get(api, timeout=timeout).decode("utf-8", errors="replace"))
        pages = (data.get("query") or {}).get("pages") or {}
        for page in pages.values():
            ii = (page.get("imageinfo") or [{}])[0]
            url = ii.get("thumburl") or ii.get("url")
            if not url:
                continue
            raw = _get(url, timeout=timeout, referer="https://commons.wikimedia.org/")
            if _save_image(raw, dest_path):
                return dest_path
        return None
    except Exception:
        return None


def download_image(query, dest_path, timeout=IMAGE_TIMEOUT):
    """Download the first image found for `query` to dest_path.

    Tries DuckDuckGo first, then Wikimedia Commons. Returns dest_path on
    success, None on any failure (offline, blocked, no results) so the
    caller can skip cleanly.
    """
    result = _ddg_image(query, dest_path, timeout) or _wikimedia_image(query, dest_path, timeout)
    return result


def fetch_url_text(url, max_chars=4000, timeout=6):
    """Fetch a page's readable-ish text. Used for 'open X and summarize'."""
    try:
        raw = _get(url, timeout=timeout)
        text = raw.decode("utf-8", errors="replace")
        text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", text)
        text = re.sub(r"<[^>]+>", " ", text)
        text = html_mod.unescape(text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:max_chars]
    except Exception:
        return ""
