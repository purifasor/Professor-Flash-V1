# -*- coding: utf-8 -*-
"""Project tester: validates generated files and reports results.

Uses Node.js (`node --check`) when available for real JS syntax
validation; otherwise falls back to structural checks (balanced braces,
parentheses, quotes) so the test still runs on machines without Node.
HTML/CSS get tag/brace balance checks plus a link-reference check.
"""

import os
import re
import shutil
import subprocess
import threading

_lock = threading.Lock()


def _node_available():
    return shutil.which("node") is not None


def _run_node_check(path):
    try:
        r = subprocess.run(
            ["node", "--check", path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return r.returncode == 0, r.stderr.strip()
    except Exception:
        return False, "Node اجرا نشد"


def _balance(text, open_c, close_c):
    depth = 0
    for ch in text:
        if ch == open_c:
            depth += 1
        elif ch == close_c:
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


def _check_js(path, use_node=True):
    with open(path, "r", encoding="utf-8") as f:
        js = f.read()
    checks = []
    if use_node:
        ok, err = _run_node_check(path)
        if ok:
            return True, "نحو صحیح است (Node)"
        return False, err or "خطای نحو"
    # structural fallback
    for name, a, b in [("براکت", "{", "}"), ("پرانتز", "(", ")"), ("کروشه", "[", "]")]:
        if not _balance(js, a, b):
            checks.append(f"{name} نامتوازن")
    # naive quote check
    if len(re.findall(r"'", js)) % 2 or len(re.findall(r'"', js)) % 2:
        checks.append("کوتیشن نامتوازن")
    if checks:
        return False, "؛ ".join(checks)
    return True, "ساختار سالم است (بدون Node، بررسی ساختاری)"


def _check_html(path):
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    problems = []
    for tag in ["html", "head", "body", "main", "script", "style"]:
        opens = len(re.findall(r"<%s[\s>]" % tag, html))
        closes = len(re.findall(r"</%s>" % tag, html))
        if opens != closes:
            problems.append(f"تگ <{tag}>: {opens} باز / {closes} بسته")
    # referenced assets exist
    for m in re.findall(r'(?:src|href)="([^"]+)"', html):
        if m.startswith(("http", "#", "data:", "//")):
            continue
        if not os.path.exists(os.path.join(os.path.dirname(path), m)):
            problems.append(f"فایل ارجاع‌شده نیست: {m}")
    if problems:
        return False, "؛ ".join(problems)
    return True, "ساختار HTML سالم است"


def _check_css(path):
    with open(path, "r", encoding="utf-8") as f:
        css = f.read()
    if not _balance(css, "{", "}"):
        return False, "آکولادهای CSS نامتوازن"
    return True, "ساختار CSS سالم است"


def _inline_scripts(html):
    parts = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
    return "\n".join(parts)


def _check_inline_js(js, use_node=True):
    """Validate the inline <script> of a single-file page (real node check)."""
    if use_node and js.strip():
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix=".js")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(js)
            ok, err = _run_node_check(tmp)
            if ok:
                return True, "نحو صحیح است (Node - داخل index.html)"
            return False, err or "خطای نحو"
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass
    return True, "اسکریپت داخل index.html"


def test_project(root: str, use_node=True):
    """Test a generated project. Returns list of per-file results + overall.

    Single-file pages (everything inline in index.html) are valid too:
    missing style.css/app.js are accepted when the page carries its own
    <style> / <script> blocks, and inline JS is still really checked with
    node --check when Node is available.
    """
    results = []
    overall = True
    html_path = os.path.join(root, "index.html")
    html = ""
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()
    for fname in ["index.html", "style.css", "app.js"]:
        p = os.path.join(root, fname)
        if fname == "index.html":
            if not os.path.exists(p):
                results.append({"file": fname, "ok": False, "detail": "فایل وجود ندارد"})
                overall = False
                continue
            ok, detail = _check_html(p)
        elif fname == "style.css":
            if not os.path.exists(p):
                if "<style" in html:
                    results.append({"file": fname, "ok": True, "detail": "استایل داخل index.html تعریف شده"})
                    continue
                results.append({"file": fname, "ok": False, "detail": "فایل وجود ندارد"})
                overall = False
                continue
            ok, detail = _check_css(p)
        else:  # app.js
            if not os.path.exists(p):
                inline = _inline_scripts(html)
                if inline.strip():
                    ok, detail = _check_inline_js(inline, use_node=use_node)
                else:
                    results.append({"file": fname, "ok": False, "detail": "فایل وجود ندارد"})
                    overall = False
                    continue
            else:
                ok, detail = _check_js(p, use_node=use_node)
        results.append({"file": fname, "ok": ok, "detail": detail})
        if not ok:
            overall = False
    return overall, results


def report_text(results) -> str:
    lines = []
    for r in results:
        mark = "تأیید" if r["ok"] else "خطا"
        lines.append(f"{r['file']}: {mark} - {r['detail']}")
    return "\n".join(lines)
