# -*- coding: utf-8 -*-
"""Live project generator: real, working multi-file apps built on demand.

Every project is generated fresh, file by file, from a template plus the
extracted spec (type, theme, accent color, image request...). Templates are
plain strings with %%TOKEN%% placeholders (never f-strings, because CSS/JS
are full of braces). Each project also gets a meta.json that records the
structure map so later "change the button color" requests can target the
right selector.
"""

import json
import os
import re
import time

from . import search as search_mod

# --------------------------------------------------------------------------
# Colors (Persian color words -> hex) and themes
# --------------------------------------------------------------------------

COLOR_WORDS = {
    "قرمز": "#e53935",
    "سرخ": "#e53935",
    "ابی": "#1e88e5",
    "آبی": "#1e88e5",
    "سبز": "#43a047",
    "زرد": "#fdd835",
    "طلایی": "#f6b73c",
    "طلای": "#f6b73c",
    "بنفش": "#8e24aa",
    "صورتی": "#ec407a",
    "نارنجی": "#fb8c00",
    "مشکی": "#15181d",
    "سفید": "#ffffff",
    "نقره": "#b0bec5",
    "خاکستری": "#78909c",
    "سرمهای": "#1a237e",
    "سرمه": "#1a237e",
    "فیروزه": "#00b8d4",
    "نیلی": "#3949ab",
}

THEMES = {
    "dark": {
        "name_fa": "تیره",
        "bg": "#0d1117",
        "bg2": "#0a0e14",
        "surface": "#161b26",
        "surface2": "#1e2534",
        "text": "#e6eaf2",
        "muted": "#8b95a7",
        "border": "#242d3f",
        "accent": "#6366f1",
        "accent2": "#8b5cf6",
        "glow": "rgba(99,102,241,0.35)",
        "radius": "14px",
        "blur": False,
    },
    "cyberpunk": {
        "name_fa": "سایبرپانک",
        "bg": "#07070d",
        "bg2": "#0b0b16",
        "surface": "#10101d",
        "surface2": "#181830",
        "text": "#e8e8f4",
        "muted": "#8f8fb8",
        "border": "#292950",
        "accent": "#00f0ff",
        "accent2": "#ff2d95",
        "glow": "rgba(0,240,255,0.45)",
        "radius": "10px",
        "blur": False,
    },
    "neon": {
        "name_fa": "نئون",
        "bg": "#04120a",
        "bg2": "#071a0f",
        "surface": "#0c2315",
        "surface2": "#12301d",
        "text": "#d9f7e7",
        "muted": "#7fb89a",
        "border": "#1d4a2f",
        "accent": "#00ff9d",
        "accent2": "#00e5ff",
        "glow": "rgba(0,255,157,0.4)",
        "radius": "12px",
        "blur": False,
    },
    "glass": {
        "name_fa": "شیشه‌ای",
        "bg": "#0e1116",
        "bg2": "#12161d",
        "surface": "rgba(255,255,255,0.06)",
        "surface2": "rgba(255,255,255,0.10)",
        "text": "#eef1f6",
        "muted": "#aab3c5",
        "border": "rgba(255,255,255,0.14)",
        "accent": "#7aa2ff",
        "accent2": "#a78bfa",
        "glow": "rgba(122,162,255,0.35)",
        "radius": "18px",
        "blur": True,
    },
    "minimal": {
        "name_fa": "مینیمال",
        "bg": "#f7f7f8",
        "bg2": "#f0f0f2",
        "surface": "#ffffff",
        "surface2": "#f4f4f6",
        "text": "#1b1f27",
        "muted": "#6b7280",
        "border": "#e4e4e9",
        "accent": "#2563eb",
        "accent2": "#7c3aed",
        "glow": "rgba(37,99,235,0.15)",
        "radius": "12px",
        "blur": False,
    },
    "light": {
        "name_fa": "روشن",
        "bg": "#f4f6fb",
        "bg2": "#eef1f8",
        "surface": "#ffffff",
        "surface2": "#f6f8fd",
        "text": "#131722",
        "muted": "#5b6472",
        "border": "#dfe4ef",
        "accent": "#0ea5e9",
        "accent2": "#7c3aed",
        "glow": "rgba(14,165,233,0.18)",
        "radius": "14px",
        "blur": False,
    },
}

THEME_WORDS = {
    "سایبرپانک": "cyberpunk",
    "سایبرپانکی": "cyberpunk",
    "سایبر": "cyberpunk",
    "cyberpunk": "cyberpunk",
    "نئون": "neon",
    "نیون": "neon",
    "neon": "neon",
    "شیشه": "glass",
    "شیشه‌ای": "glass",
    "گلاس": "glass",
    "glass": "glass",
    "مینیمال": "minimal",
    "minimal": "minimal",
    "روشن": "light",
    "روشنک": "light",
    "روشنایی": "light",
    "سفید": None,  # handled as color
}


def theme_css(theme_key: str, accent: str) -> str:
    t = THEMES.get(theme_key, THEMES["dark"])
    blur = "backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);" if t["blur"] else ""
    return (
        ":root {\n"
        f"  --bg: {t['bg']};\n"
        f"  --bg2: {t['bg2']};\n"
        f"  --surface: {t['surface']};\n"
        f"  --surface2: {t['surface2']};\n"
        f"  --text: {t['text']};\n"
        f"  --muted: {t['muted']};\n"
        f"  --border: {t['border']};\n"
        f"  --accent: {accent};\n"
        f"  --accent2: {t['accent2']};\n"
        f"  --glow: {t['glow']};\n"
        f"  --radius: {t['radius']};\n"
        f"  --blur: {blur};\n"
        "  --font: 'Segoe UI', Tahoma, 'Vazirmatn', sans-serif;\n"
        "  --mono: Consolas, 'Courier New', monospace;\n"
        "}\n"
    )


SHARED_CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font);
  background: linear-gradient(160deg, var(--bg), var(--bg2));
  background-attachment: fixed;
  color: var(--text);
  min-height: 100vh;
  line-height: 1.7;
}
button, input, select, textarea { font-family: inherit; font-size: 1rem; color: inherit; }
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.25);
}
.btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 10px 20px;
  font-weight: 600;
  cursor: pointer;
  transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
  box-shadow: 0 4px 18px var(--glow);
}
.btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.btn.ghost { background: transparent; border: 1px solid var(--border); box-shadow: none; color: var(--text); }
.btn.primary { background: var(--accent); }
.chip {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 999px;
  padding: 6px 16px;
  cursor: pointer;
  transition: all .12s ease;
}
.chip.active, .chip:hover { color: var(--text); border-color: var(--accent); background: var(--glow); }
input, select {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 14px;
  outline: none;
  transition: border-color .12s ease;
}
input:focus, select:focus { border-color: var(--accent); }
.app-header {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.app-header img { height: 46px; border-radius: 8px; object-fit: cover; }
.app-header span { font-weight: 700; }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 9px; }
::-webkit-scrollbar-track { background: transparent; }
"""


def _page(title, body, image_block="", direction="rtl", lang="fa"):
    return (
        "<!DOCTYPE html>\n"
        f'<html lang="{lang}" dir="{direction}">\n'
        "<head>\n"
        '<meta charset="UTF-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        f"<title>{title}</title>\n"
        '<link rel="stylesheet" href="style.css">\n'
        "</head>\n"
        "<body>\n"
        f"{image_block}\n"
        f"{body}\n"
        '<script src="app.js"></script>\n'
        "</body>\n"
        "</html>\n"
    )


# --------------------------------------------------------------------------
# Templates. Each entry: name_fa, dir, structure map, file contents.
# %%TOKENS%%: TITLE, DIR, IMAGE_BLOCK
# --------------------------------------------------------------------------

TEMPLATES = {}

# ---------------------------------------------------------------- calculator
TEMPLATES["calculator"] = {
    "name_fa": "ماشین حساب",
    "dir": "ltr",
    "keywords": ["ماشین حساب", "محاسبه گر", "محاسبهگر", "calculator", "حسابگر", "ماشین‌حساب"],
    "structure": [
        {"selector": "#display", "name": "نمایشگر", "kind": "text"},
        {"selector": ".btn", "name": "دکمه‌ها", "kind": "button"},
        {"selector": ".btn.op", "name": "دکمه‌های عملگر", "kind": "button"},
        {"selector": ".btn.eq", "name": "دکمه مساوی", "kind": "button"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
        {"selector": ".app", "name": "محفظه برنامه", "kind": "container"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card calc" style="width:340px;max-width:100%;padding:18px">
    <div style="text-align:center;font-weight:700;margin-bottom:12px;color:var(--accent)">""" + t + """</div>
    <div class="display-wrap" style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:14px;text-align:right">
      <div id="expr" style="min-height:20px;color:var(--muted);font-family:var(--mono);font-size:.9rem;word-break:break-all"></div>
      <div id="display" style="font-family:var(--mono);font-size:2rem;font-weight:700;word-break:break-all">0</div>
    </div>
    <div class="keys" style="display:grid;grid-template-columns:repeat(4,1fr);gap:9px">
      <button class="btn fn" style="background:var(--surface2);box-shadow:none" data-k="C">C</button>
      <button class="btn fn" style="background:var(--surface2);box-shadow:none" data-k="%">%</button>
      <button class="btn fn" style="background:var(--surface2);box-shadow:none" data-k="b">⌫</button>
      <button class="btn op" data-k="/">÷</button>
      <button class="btn" data-k="7">7</button>
      <button class="btn" data-k="8">8</button>
      <button class="btn" data-k="9">9</button>
      <button class="btn op" data-k="*">×</button>
      <button class="btn" data-k="4">4</button>
      <button class="btn" data-k="5">5</button>
      <button class="btn" data-k="6">6</button>
      <button class="btn op" data-k="-">−</button>
      <button class="btn" data-k="1">1</button>
      <button class="btn" data-k="2">2</button>
      <button class="btn" data-k="3">3</button>
      <button class="btn op" data-k="+">+</button>
      <button class="btn" data-k="0" style="grid-column:span 2">0</button>
      <button class="btn" data-k=".">.</button>
      <button class="btn eq" data-k="=" style="grid-row:span 2;background:var(--accent2)">=</button>
    </div>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS,
    "js": """
(function () {
  var display = document.getElementById('display');
  var expr = document.getElementById('expr');
  var current = '';
  var operand = null;
  var pendingOp = null;
  var justEvaluated = false;

  function render() {
    display.textContent = current === '' ? '0' : current;
  }
  function pushExpr(txt) {
    var prev = expr.textContent;
    expr.textContent = prev.length > 26 ? txt : prev + ' ' + txt;
  }
  function compute(a, b, op) {
    var x = parseFloat(a), y = parseFloat(b);
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': return y === 0 ? NaN : x / y;
      case '%': return x * (y / 100);
    }
    return y;
  }
  function inputDigit(d) {
    if (justEvaluated) { current = ''; expr.textContent = ''; justEvaluated = false; }
    if (d === '.' && current.indexOf('.') !== -1) return;
    if (current.replace('.', '').length >= 15) return;
    current += d;
    render();
  }
  function inputOp(op) {
    if (current === '' && operand !== null && pendingOp) { pendingOp = op; return; }
    if (current !== '') {
      if (operand !== null && pendingOp) {
        var res = compute(operand, current, pendingOp);
        if (isNaN(res)) { expr.textContent = 'خطا'; current = ''; operand = null; pendingOp = null; render(); return; }
        operand = String(res);
        expr.textContent = operand;
      } else {
        operand = current;
        expr.textContent = operand;
      }
    }
    pendingOp = op;
    current = '';
    justEvaluated = false;
    render();
  }
  function evaluate() {
    if (pendingOp !== null && current !== '' && operand !== null) {
      var res = compute(operand, current, pendingOp);
      if (isNaN(res)) { expr.textContent = 'خطا'; current = ''; operand = null; pendingOp = null; render(); return; }
      expr.textContent = operand + ' ' + pendingOp + ' ' + current + ' =';
      current = String(res);
      operand = null; pendingOp = null;
      justEvaluated = true;
      render();
    }
  }
  function clear() { current = ''; operand = null; pendingOp = null; expr.textContent = ''; justEvaluated = false; render(); }
  function backspace() { if (justEvaluated) { clear(); return; } current = current.slice(0, -1); render(); }
  function percent() { if (current !== '') { current = String(parseFloat(current) / 100); render(); } }

  document.querySelectorAll('.keys .btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.getAttribute('data-k');
      if (k === 'C') clear();
      else if (k === 'b') backspace();
      else if (k === '%') percent();
      else if (k === '=') evaluate();
      else if ('+-*/'.indexOf(k) !== -1) inputOp(k);
      else inputDigit(k);
    });
  });
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (/^[0-9.]$/.test(k)) inputDigit(k);
    else if (k === '+' || k === '-' || k === '*' || k === '/') inputOp(k);
    else if (k === 'Enter' || k === '=') { e.preventDefault(); evaluate(); }
    else if (k === 'Backspace') backspace();
    else if (k === 'Escape') clear();
  });
})();
""",
}

# ------------------------------------------------------------------ todo list
TEMPLATES["todo"] = {
    "name_fa": "لیست کارها",
    "dir": "rtl",
    "keywords": ["لیست کار", "تودو", "todo", "لیست وظایف", "مدیریت کار", "کارهای روزانه", "برنامه کار", "لیست کارها", "وظایف"],
    "structure": [
        {"selector": "#new-task", "name": "فیلد ورودی کار", "kind": "input"},
        {"selector": ".btn-add", "name": "دکمه افزودن", "kind": "button"},
        {"selector": ".task-item", "name": "آیتم‌های کار", "kind": "container"},
        {"selector": ".task-done", "name": "کارهای انجام‌شده", "kind": "text"},
        {"selector": "#progress", "name": "نوار پیشرفت", "kind": "text"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;justify-content:center;padding:28px 16px">
  <div class="card" style="width:560px;max-width:100%">
    <h1 style="font-size:1.5rem;margin-bottom:4px">""" + t + """</h1>
    <p style="color:var(--muted);font-size:.9rem;margin-bottom:18px">کارهایت را مدیریت کن</p>
    <form id="todo-form" style="display:flex;gap:10px;margin-bottom:16px">
      <input id="new-task" type="text" placeholder="کار جدید بنویس..." autocomplete="off" style="flex:1">
      <button type="submit" class="btn btn-add">افزودن</button>
    </form>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div style="flex:1;height:8px;background:var(--surface2);border-radius:99px;overflow:hidden">
        <div id="progress" style="height:100%;width:0%;background:var(--accent);transition:width .25s ease"></div>
      </div>
      <span id="progress-text" style="color:var(--muted);font-size:.85rem;min-width:52px;text-align:left">۰٪</span>
    </div>
    <ul id="task-list" style="list-style:none;display:flex;flex-direction:column;gap:8px;margin-bottom:16px;min-height:60px"></ul>
    <div style="display:flex;gap:8px">
      <button class="chip active" data-f="all">همه</button>
      <button class="chip" data-f="active">انجام‌نشده</button>
      <button class="chip" data-f="done">انجام‌شده</button>
    </div>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS + """
.task-item {
  display: flex; align-items: center; gap: 10px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px; cursor: pointer;
  transition: border-color .12s ease;
}
.task-item:hover { border-color: var(--accent); }
.task-item .box {
  width: 20px; height: 20px; border-radius: 6px; border: 2px solid var(--border);
  flex: none; display: flex; align-items: center; justify-content: center;
  font-size: .75rem; color: #fff; transition: all .12s ease;
}
.task-item.done .box { background: var(--accent); border-color: var(--accent); }
.task-item .txt { flex: 1; word-break: break-word; }
.task-item.done .txt { text-decoration: line-through; color: var(--muted); }
.task-item .del {
  background: transparent; border: none; color: var(--muted);
  cursor: pointer; font-size: 1rem; padding: 4px; border-radius: 6px;
}
.task-item .del:hover { color: #ef5350; background: rgba(239,83,80,.12); }
""",
    "js": """
(function () {
  var KEY = 'pf-todo-v1';
  var tasks = [];
  var filter = 'all';
  var list = document.getElementById('task-list');
  var form = document.getElementById('todo-form');
  var input = document.getElementById('new-task');

  try { tasks = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { tasks = []; }

  function save() { try { localStorage.setItem(KEY, JSON.stringify(tasks)); } catch (e) {} }

  function render() {
    var shown = tasks.filter(function (t) {
      if (filter === 'done') return t.done;
      if (filter === 'active') return !t.done;
      return true;
    });
    list.innerHTML = '';
    if (shown.length === 0) {
      var empty = document.createElement('li');
      empty.textContent = filter === 'done' ? 'هنوز کاری انجام نشده' : 'کاری در لیست نیست';
      empty.style.cssText = 'color:var(--muted);text-align:center;padding:18px';
      list.appendChild(empty);
    }
    shown.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'task-item' + (t.done ? ' done' : '');
      li.setAttribute('data-id', t.id);
      var box = document.createElement('span'); box.className = 'box'; box.textContent = t.done ? '✓' : '';
      var txt = document.createElement('span'); txt.className = 'txt'; txt.textContent = t.text;
      var del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'حذف';
      li.appendChild(box); li.appendChild(txt); li.appendChild(del);
      li.addEventListener('click', function (e) {
        if (e.target === del) return;
        t.done = !t.done; save(); render();
      });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        tasks = tasks.filter(function (x) { return x.id !== t.id; });
        save(); render();
      });
      list.appendChild(li);
    });
    var done = tasks.filter(function (t) { return t.done; }).length;
    var pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    document.getElementById('progress').style.width = pct + '%';
    document.getElementById('progress-text').textContent = pct + '٪';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    tasks.push({ id: Date.now(), text: text, done: false });
    input.value = ''; save(); render();
  });

  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      filter = chip.getAttribute('data-f');
      render();
    });
  });

  render();
})();
""",
}

# --------------------------------------------------------------------- quiz
TEMPLATES["quiz"] = {
    "name_fa": "آزمون (کوییز)",
    "dir": "rtl",
    "keywords": ["کوییز", "quiz", "تست هوش", "آزمون", "سوال چهار گزینه", "چهار گزینه", "سوال جواب"],
    "structure": [
        {"selector": "#question", "name": "متن سوال", "kind": "text"},
        {"selector": ".option", "name": "گزینه‌ها", "kind": "button"},
        {"selector": "#score", "name": "نشانگر امتیاز", "kind": "text"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:560px;max-width:100%">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;color:var(--muted);font-size:.9rem">
      <span id="q-num">سوال ۱</span><span id="score">امتیاز: ۰</span>
    </div>
    <div style="height:6px;background:var(--surface2);border-radius:99px;overflow:hidden;margin-bottom:18px">
      <div id="q-progress" style="height:100%;width:12%;background:var(--accent);transition:width .25s ease"></div>
    </div>
    <h2 id="question" style="font-size:1.25rem;margin-bottom:20px;line-height:1.8"></h2>
    <div id="options" style="display:flex;flex-direction:column;gap:10px"></div>
    <div id="quiz-result" style="display:none;text-align:center;padding:18px">
      <h2 id="final-title" style="margin-bottom:10px"></h2>
      <p id="final-score" style="color:var(--muted);margin-bottom:18px"></p>
      <button id="restart-btn" class="btn">دوباره</button>
    </div>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS + """
.option {
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px 16px; text-align: right;
  cursor: pointer; transition: all .12s ease; font-size: 1rem;
}
.option:hover { border-color: var(--accent); transform: translateX(-3px); }
.option.correct { background: rgba(67,160,71,.18); border-color: #43a047; }
.option.wrong { background: rgba(229,57,53,.16); border-color: #e53935; }
.option:disabled { cursor: default; }
""",
    "js": """
(function () {
  var QUESTIONS = [
    { q: 'پایتخت ایران کدام شهر است؟', o: ['تهران', 'اصفهان', 'شیراز', 'تبریز'], a: 0 },
    { q: 'کدام سیاره به «سیاره سرخ» معروف است؟', o: ['زهره', 'مریخ', 'مشتری', 'عطارد'], a: 1 },
    { q: 'بزرگ‌ترین اقیانوس جهان کدام است؟', o: ['اقیانوس اطلس', 'اقیانوس هند', 'اقیانوس آرام', 'اقیانوس منجمد'], a: 2 },
    { q: 'کدام زبان برنامه‌نویسی برای طراحی وب استفاده می‌شود؟', o: ['Python', 'JavaScript', 'C++', 'Rust'], a: 1 },
    { q: 'نور خورشید چند دقیقه طول می‌کشد تا به زمین برسد؟', o: ['۲ دقیقه', '۸ دقیقه', '۳۰ دقیقه', '۱ ساعت'], a: 1 },
    { q: 'کدام عنصر با نماد O شناخته می‌شود؟', o: ['اکسیژن', 'طلا', 'نیتروژن', 'آهن'], a: 0 },
    { q: 'بلندترین قله ایران کدام است؟', o: ['سبلان', 'الوند', 'دماوند', 'تفتان'], a: 2 },
    { q: 'HTML مخفف چیست؟', o: ['Hyper Text Markup Language', 'High Tech Modern Language', 'Home Tool Markup Language', 'Hyper Transfer Main Link'], a: 0 }
  ];
  var i = 0, score = 0, locked = false;
  var qEl = document.getElementById('question');
  var optsEl = document.getElementById('options');
  var numEl = document.getElementById('q-num');
  var scoreEl = document.getElementById('score');
  var progEl = document.getElementById('q-progress');
  var resultEl = document.getElementById('quiz-result');

  function showResult() {
    document.getElementById('options').style.display = 'none';
    resultEl.style.display = 'block';
    var msg = score === QUESTIONS.length ? 'عالی! همه را درست جواب دادی' :
              score >= QUESTIONS.length / 2 ? 'خوب بود!' : 'می‌توانی بهتر شوی';
    document.getElementById('final-title').textContent = msg;
    document.getElementById('final-score').textContent = 'امتیاز نهایی: ' + score + ' از ' + QUESTIONS.length;
  }

  function render() {
    if (i >= QUESTIONS.length) { showResult(); return; }
    var item = QUESTIONS[i];
    locked = false;
    numEl.textContent = 'سوال ' + (i + 1);
    scoreEl.textContent = 'امتیاز: ' + score;
    progEl.style.width = ((i + 1) / QUESTIONS.length * 100) + '%';
    qEl.textContent = item.q;
    optsEl.innerHTML = '';
    item.o.forEach(function (text, idx) {
      var b = document.createElement('button');
      b.className = 'option';
      b.textContent = text;
      b.addEventListener('click', function () { pick(idx, b); });
      optsEl.appendChild(b);
    });
  }

  function pick(idx, btn) {
    if (locked) return;
    locked = true;
    var item = QUESTIONS[i];
    var btns = optsEl.querySelectorAll('.option');
    btns.forEach(function (b) { b.disabled = true; });
    if (idx === item.a) {
      btn.classList.add('correct');
      score++;
      scoreEl.textContent = 'امتیاز: ' + score;
    } else {
      btn.classList.add('wrong');
      btns[item.a].classList.add('correct');
    }
    setTimeout(function () { i++; render(); }, 900);
  }

  document.getElementById('restart-btn').addEventListener('click', function () {
    i = 0; score = 0;
    document.getElementById('options').style.display = 'flex';
    resultEl.style.display = 'none';
    render();
  });

  render();
})();
""",
}

# -------------------------------------------------------------------- snake
TEMPLATES["snake"] = {
    "name_fa": "بازی مار",
    "dir": "rtl",
    "keywords": ["بازی مار", "مار", "snake", "مار بازی"],
    "structure": [
        {"selector": "#score", "name": "نشانگر امتیاز", "kind": "text"},
        {"selector": "#start-btn", "name": "دکمه شروع", "kind": "button"},
        {"selector": "#game", "name": "بوم بازی", "kind": "container"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:460px;max-width:100%;text-align:center">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <h1 style="font-size:1.4rem">""" + t + """</h1>
      <span id="score" style="color:var(--muted)">امتیاز: ۰</span>
    </div>
    <canvas id="game" width="400" height="400" style="width:100%;aspect-ratio:1;background:var(--surface2);border:1px solid var(--border);border-radius:12px;display:block"></canvas>
    <div style="margin-top:14px;display:flex;gap:10px;justify-content:center">
      <button id="start-btn" class="btn primary">شروع</button>
      <button id="pause-btn" class="btn ghost">توقف موقت</button>
    </div>
    <p style="color:var(--muted);font-size:.85rem;margin-top:10px">با کلیدهای جهت‌نما یا کلیدهای WASD حرکت کن</p>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS,
    "js": """
(function () {
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var CELL = 20, COLS = 20, ROWS = 20;
  var snake, dir, nextDir, food, score, running, over, paused, timer;

  function reset() {
    snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    dir = { x: 1, y: 0 }; nextDir = dir;
    score = 0; running = false; over = false; paused = false;
    placeFood();
    draw();
    document.getElementById('score').textContent = 'امتیاز: ۰';
    document.getElementById('start-btn').textContent = 'شروع';
  }
  function placeFood() {
    while (true) {
      food = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
      if (!snake.some(function (s) { return s.x === food.x && s.y === food.y; })) break;
    }
  }
  function step() {
    dir = nextDir;
    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS ||
        snake.some(function (s) { return s.x === head.x && s.y === head.y; })) {
      gameOver(); return;
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score++;
      document.getElementById('score').textContent = 'امتیاز: ' + score;
      placeFood();
    } else {
      snake.pop();
    }
    draw();
  }
  function gameOver() {
    running = false; over = true;
    clearInterval(timer);
    draw();
    document.getElementById('start-btn').textContent = 'دوباره';
  }
  function draw() {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (var i = 0; i <= COLS; i++) {
      ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, canvas.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(canvas.width, i * CELL); ctx.stroke();
    }
    ctx.fillStyle = '#ff5252';
    ctx.shadowColor = '#ff5252'; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL / 2 - 3, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    snake.forEach(function (s, idx) {
      ctx.fillStyle = idx === 0 ? '#00f0ff' : '#00b8d4';
      ctx.shadowColor = '#00f0ff'; ctx.shadowBlur = idx === 0 ? 14 : 6;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2, 5) : ctx.rect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
      ctx.fill();
    });
    ctx.shadowBlur = 0;
  }
  document.getElementById('start-btn').addEventListener('click', function () {
    if (over) { reset(); }
    if (!running) {
      running = true; paused = false;
      timer = setInterval(step, 120);
      this.textContent = 'شروع';
    }
  });
  document.getElementById('pause-btn').addEventListener('click', function () {
    if (!running) return;
    paused = !paused;
    if (paused) clearInterval(timer); else timer = setInterval(step, 120);
  });
  document.addEventListener('keydown', function (e) {
    var map = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
                w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 } };
    var nd = map[e.key.toLowerCase ? e.key.toLowerCase() : e.key] || map[e.key];
    if (!nd) return;
    e.preventDefault();
    if (nd.x === -dir.x && nd.y === -dir.y) return;
    nextDir = nd;
    if (!running && !over) { document.getElementById('start-btn').click(); }
  });
  reset();
})();
""",
}

# ------------------------------------------------------------------ landing
TEMPLATES["landing"] = {
    "name_fa": "وب‌سایت (صفحه فرود)",
    "dir": "rtl",
    "keywords": ["سایت", "وبسایت", "وب سایت", "صفحه فرود", "landing", "رزومه", "portfolio", "صفحه اصلی", "وب‌سایت", "سایت شخصی", "سایت معرفی", "معرفی خودم", "معرفی خود"],
    "structure": [
        {"selector": ".nav-link", "name": "منوی بالا", "kind": "container"},
        {"selector": ".btn-cta", "name": "دکمه اصلی", "kind": "button"},
        {"selector": ".hero h1", "name": "عنوان اصلی", "kind": "title"},
        {"selector": ".feature-card", "name": "کارت‌های امکانات", "kind": "card"},
        {"selector": "header", "name": "هدر بالا", "kind": "header"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
        {"selector": "footer", "name": "پاورقی", "kind": "container"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<header class="site-header" style="position:sticky;top:0;z-index:50;background:var(--bg);border-bottom:1px solid var(--border)">
  <nav style="max-width:1080px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;justify-content:space-between">
    <div style="font-weight:800;color:var(--accent);font-size:1.15rem">""" + t + """</div>
    <button id="nav-toggle" class="nav-toggle" style="display:none;background:none;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;cursor:pointer">منو</button>
    <ul class="nav-links" style="list-style:none;display:flex;gap:22px">
      <li><a class="nav-link" href="#home" style="color:var(--muted);text-decoration:none;transition:color .12s">خانه</a></li>
      <li><a class="nav-link" href="#features" style="color:var(--muted);text-decoration:none;transition:color .12s">امکانات</a></li>
      <li><a class="nav-link" href="#about" style="color:var(--muted);text-decoration:none;transition:color .12s">درباره</a></li>
      <li><a class="nav-link" href="#contact" style="color:var(--muted);text-decoration:none;transition:color .12s">تماس</a></li>
    </ul>
  </nav>
</header>
<main>
  <section id="home" class="hero" style="max-width:1080px;margin:0 auto;padding:90px 20px 60px;text-align:center">
    <h1 style="font-size:clamp(1.8rem,5vw,3.2rem);line-height:1.5;margin-bottom:14px">با """ + t + """ به آینده خوش آمدید</h1>
    <p style="color:var(--muted);font-size:1.1rem;max-width:640px;margin:0 auto 28px">یک تجربه مدرن، سریع و حرفه‌ای. ساخته‌شده با دقت و عشق به جزئیات.</p>
    <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap">
      <a href="#contact" class="btn btn-cta" style="text-decoration:none">شروع کنید</a>
      <a href="#features" class="btn ghost" style="text-decoration:none">بیشتر بدانید</a>
    </div>
  </section>
  <section id="features" class="section" style="max-width:1080px;margin:0 auto;padding:60px 20px">
    <h2 style="text-align:center;margin-bottom:34px">امکانات ما</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px">
      <div class="card feature-card"><h3>سریع</h3><p style="color:var(--muted);margin-top:8px">طراحی بهینه برای اجرای روان روی هر دستگاهی.</p></div>
      <div class="card feature-card"><h3>امن</h3><p style="color:var(--muted);margin-top:8px">داده‌های شما نزد خودتان می‌ماند و محافظت می‌شود.</p></div>
      <div class="card feature-card"><h3>زیبا</h3><p style="color:var(--muted);margin-top:8px">رابط کاربری مدرن با جزئیات دقیق و حرفه‌ای.</p></div>
    </div>
  </section>
  <section id="about" class="section" style="max-width:1080px;margin:0 auto;padding:40px 20px">
    <div class="card" style="text-align:center"><h2 style="margin-bottom:12px">درباره ما</h2><p style="color:var(--muted);max-width:640px;margin:0 auto">ما به ساخت محصولاتی با کیفیت بالا اعتقاد داریم. این صفحه توسط Professor Flash به صورت زنده ساخته شده است.</p></div>
  </section>
  <section id="contact" class="section" style="max-width:1080px;margin:0 auto;padding:40px 20px 80px">
    <div class="card" style="max-width:520px;margin:0 auto">
      <h2 style="text-align:center;margin-bottom:18px">تماس با ما</h2>
      <form id="contact-form" style="display:flex;flex-direction:column;gap:12px">
        <input type="text" placeholder="نام شما" required>
        <input type="email" placeholder="ایمیل" required>
        <textarea placeholder="پیام شما..." rows="4" style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;font-family:inherit;resize:vertical"></textarea>
        <button type="submit" class="btn btn-cta">ارسال پیام</button>
      </form>
      <p id="form-ok" style="display:none;color:#43a047;text-align:center;margin-top:12px">پیام شما ثبت شد. ممنون!</p>
    </div>
  </section>
</main>
<footer style="border-top:1px solid var(--border);padding:22px;text-align:center;color:var(--muted);font-size:.9rem">""" + t + """ - ساخته‌شده با Professor Flash</footer>
""",
    ),
    "css": lambda: SHARED_CSS + """
.nav-links a:hover { color: var(--accent) !important; }
@media (max-width: 640px) {
  .nav-toggle { display: block !important; }
  .nav-links { display: none !important; flex-direction: column; gap: 10px !important; padding: 10px 0; }
  .nav-links.open { display: flex !important; }
}
""",
    "js": """
(function () {
  var toggle = document.getElementById('nav-toggle');
  var links = document.querySelector('.nav-links');
  toggle.addEventListener('click', function () { links.classList.toggle('open'); });
  document.querySelectorAll('.nav-link').forEach(function (a) {
    a.addEventListener('click', function () { links.classList.remove('open'); });
  });
  document.getElementById('contact-form').addEventListener('submit', function (e) {
    e.preventDefault();
    document.getElementById('form-ok').style.display = 'block';
    this.reset();
    setTimeout(function () { document.getElementById('form-ok').style.display = 'none'; }, 4000);
  });
})();
""",
}

# -------------------------------------------------------------------- clock
TEMPLATES["clock"] = {
    "name_fa": "ساعت",
    "dir": "rtl",
    "keywords": ["ساعت", "clock", "ساعت دیجیتال", "ساعت عقربه"],
    "structure": [
        {"selector": "#digital", "name": "نمایشگر دیجیتال", "kind": "text"},
        {"selector": "#analog", "name": "ساعت عقربه‌ای", "kind": "container"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:360px;max-width:100%;text-align:center">
    <h1 style="font-size:1.4rem;margin-bottom:18px">""" + t + """</h1>
    <canvas id="analog" width="260" height="260" style="display:block;margin:0 auto"></canvas>
    <div id="digital" style="font-family:var(--mono);font-size:2.4rem;font-weight:700;margin-top:18px;letter-spacing:2px">--:--:--</div>
    <div id="date-fa" style="color:var(--muted);margin-top:6px"></div>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS,
    "js": """
(function () {
  var canvas = document.getElementById('analog');
  var ctx = canvas.getContext('2d');
  var cx = 130, cy = 130;

  function draw() {
    var now = new Date();
    var h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    var sec = s + now.getMilliseconds() / 1000;
    var min = m + sec / 60;
    var hr = (h % 12) + min / 60;

    ctx.clearRect(0, 0, 260, 260);
    ctx.fillStyle = '#0d1117';
    ctx.beginPath(); ctx.arc(cx, cy, 128, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#242d3f'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, 118, 0, Math.PI * 2); ctx.stroke();

    ctx.fillStyle = '#e6eaf2'; ctx.font = '14px Segoe UI, Tahoma';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var i = 1; i <= 12; i++) {
      var ang = i * Math.PI / 6;
      var x = cx + Math.sin(ang) * 92, y = cy - Math.cos(ang) * 92;
      ctx.fillText(i, x, y);
    }

    function hand(angle, len, width, color, glow) {
      ctx.save();
      ctx.rotate(angle);
      ctx.shadowColor = glow; ctx.shadowBlur = 8;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, 0); ctx.stroke();
      ctx.restore();
    }
    ctx.translate(cx, cy);
    hand(hr * Math.PI / 6, -54, 7, '#e6eaf2', '#6366f1');
    hand(min * Math.PI / 30, -76, 5, '#e6eaf2', '#6366f1');
    hand(sec * Math.PI / 30, -88, 2, '#ff5252', '#ff5252');
    ctx.fillStyle = '#00f0ff'; ctx.shadowColor = '#00f0ff'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.translate(-cx, -cy);

    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    document.getElementById('digital').textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
    try {
      document.getElementById('date-fa').textContent = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'full' }).format(now);
    } catch (e) {}
  }
  draw();
  setInterval(draw, 1000);
})();
""",
}

# ---------------------------------------------------------------- stopwatch
TEMPLATES["stopwatch"] = {
    "name_fa": "کرنومتر",
    "dir": "rtl",
    "keywords": ["کرنومتر", "stopwatch", "زمان سنج", "زمان‌سنج", "سنجش زمان"],
    "structure": [
        {"selector": "#time", "name": "نمایشگر زمان", "kind": "text"},
        {"selector": "#start-btn", "name": "دکمه شروع", "kind": "button"},
        {"selector": "#lap-btn", "name": "دکمه دور", "kind": "button"},
        {"selector": ".laps", "name": "لیست دورها", "kind": "container"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:380px;max-width:100%;text-align:center">
    <h1 style="font-size:1.4rem;margin-bottom:18px">""" + t + """</h1>
    <div id="time" style="font-family:var(--mono);font-size:3rem;font-weight:700;letter-spacing:2px;margin-bottom:20px">00:00:00.0</div>
    <div style="display:flex;gap:10px;justify-content:center;margin-bottom:18px">
      <button id="start-btn" class="btn primary">شروع</button>
      <button id="lap-btn" class="btn ghost" disabled>دور</button>
      <button id="reset-btn" class="btn ghost" disabled>ریست</button>
    </div>
    <ul class="laps" style="list-style:none;max-height:220px;overflow:auto;text-align:center"></ul>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS + """
.laps li { padding: 8px; border-bottom: 1px solid var(--border); font-family: var(--mono); direction: ltr; display: flex; justify-content: space-between; }
.laps li span:first-child { color: var(--muted); }
""",
    "js": """
(function () {
  var timeEl = document.getElementById('time');
  var lapsEl = document.querySelector('.laps');
  var startBtn = document.getElementById('start-btn');
  var lapBtn = document.getElementById('lap-btn');
  var resetBtn = document.getElementById('reset-btn');
  var running = false, base = 0, startedAt = 0, timer;

  function fmt(ms) {
    var total = Math.floor(ms / 100);
    var cs = total % 10, s = Math.floor(total / 10) % 60, m = Math.floor(total / 600) % 60, h = Math.floor(total / 36000);
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return p(h) + ':' + p(m) + ':' + p(s) + '.' + cs;
  }
  function tick() {
    timeEl.textContent = fmt(base + (Date.now() - startedAt));
  }
  function start() {
    if (!running) {
      running = true;
      startedAt = Date.now();
      timer = setInterval(tick, 80);
      startBtn.textContent = 'توقف';
      lapBtn.disabled = false; resetBtn.disabled = false;
    } else {
      running = false;
      base += Date.now() - startedAt;
      clearInterval(timer);
      startBtn.textContent = 'ادامه';
    }
  }
  startBtn.addEventListener('click', start);
  lapBtn.addEventListener('click', function () {
    if (!running) return;
    var li = document.createElement('li');
    var n = document.createElement('span'); n.textContent = 'دور ' + (lapsEl.children.length + 1);
    var tm = document.createElement('span'); tm.textContent = timeEl.textContent;
    li.appendChild(n); li.appendChild(tm);
    lapsEl.insertBefore(li, lapsEl.firstChild);
  });
  resetBtn.addEventListener('click', function () {
    running = false; clearInterval(timer);
    base = 0; startedAt = 0;
    timeEl.textContent = '00:00:00.0';
    lapsEl.innerHTML = '';
    startBtn.textContent = 'شروع'; lapBtn.disabled = true; resetBtn.disabled = true;
  });
})();
""",
}

# ---------------------------------------------------------------- password
TEMPLATES["password"] = {
    "name_fa": "تولیدکننده رمز",
    "dir": "rtl",
    "keywords": ["رمز", "پسورد", "password", "رمز عبور", "تولید رمز", "رمزساز"],
    "structure": [
        {"selector": "#pw", "name": "نمایش رمز", "kind": "text"},
        {"selector": "#gen-btn", "name": "دکمه تولید", "kind": "button"},
        {"selector": "#copy-btn", "name": "دکمه کپی", "kind": "button"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:440px;max-width:100%">
    <h1 style="font-size:1.4rem;margin-bottom:4px">""" + t + """</h1>
    <p style="color:var(--muted);font-size:.9rem;margin-bottom:18px">رمزهای قوی و تصادفی بساز</p>
    <div style="display:flex;gap:10px;margin-bottom:18px">
      <div id="pw" dir="ltr" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-family:var(--mono);word-break:break-all;min-height:24px"></div>
      <button id="copy-btn" class="btn ghost" disabled>کپی</button>
    </div>
    <div style="margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>طول رمز</span><span id="len-val" dir="ltr">16</span></div>
      <input type="range" id="length" min="6" max="40" value="16" style="width:100%">
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px">
      <label style="display:flex;align-items:center;gap:8px;font-size:.92rem"><input type="checkbox" id="upper" checked> حروف بزرگ</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:.92rem"><input type="checkbox" id="lower" checked> حروف کوچک</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:.92rem"><input type="checkbox" id="nums" checked> اعداد</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:.92rem"><input type="checkbox" id="sym" checked> نمادها</label>
    </div>
    <button id="gen-btn" class="btn primary" style="width:100%">تولید رمز</button>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS,
    "js": """
(function () {
  var UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var LOWER = 'abcdefghijklmnopqrstuvwxyz';
  var NUMS = '0123456789';
  var SYMS = '!@#$%^&*()-_=+[]{};:,.<>?';
  var pwEl = document.getElementById('pw');
  var lenEl = document.getElementById('length');
  var lenVal = document.getElementById('len-val');
  var copyBtn = document.getElementById('copy-btn');

  function getPool() {
    var pool = '';
    if (document.getElementById('upper').checked) pool += UPPER;
    if (document.getElementById('lower').checked) pool += LOWER;
    if (document.getElementById('nums').checked) pool += NUMS;
    if (document.getElementById('sym').checked) pool += SYMS;
    return pool;
  }
  function generate() {
    var pool = getPool();
    if (!pool) { pwEl.textContent = 'حداقل یک گزینه را انتخاب کن'; return; }
    var len = parseInt(lenEl.value, 10);
    var arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    var out = '';
    for (var i = 0; i < len; i++) out += pool[arr[i] % pool.length];
    pwEl.textContent = out;
    copyBtn.disabled = false;
  }
  lenEl.addEventListener('input', function () { lenVal.textContent = lenEl.value; generate(); });
  document.getElementById('gen-btn').addEventListener('click', generate);
  copyBtn.addEventListener('click', function () {
    var text = pwEl.textContent;
    function done() { copyBtn.textContent = 'کپی شد'; setTimeout(function () { copyBtn.textContent = 'کپی'; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  });
  generate();
})();
""",
}

# ---------------------------------------------------------------- converter
TEMPLATES["converter"] = {
    "name_fa": "مبدل واحد",
    "dir": "rtl",
    "keywords": ["مبدل", "تبدیل واحد", "converter", "تبدیل", "واحد اندازه"],
    "structure": [
        {"selector": "#value", "name": "فیلد مقدار", "kind": "input"},
        {"selector": "#result", "name": "نتیجه", "kind": "text"},
        {"selector": ".chip", "name": "زبانه‌های واحد", "kind": "button"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:460px;max-width:100%">
    <h1 style="font-size:1.4rem;margin-bottom:18px;text-align:center">""" + t + """</h1>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:20px">
      <button class="chip active" data-u="length">طول</button>
      <button class="chip" data-u="weight">وزن</button>
      <button class="chip" data-u="temperature">دما</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:10px">
        <input id="value" type="number" value="1" dir="ltr" style="flex:1;font-family:var(--mono)">
        <select id="from" style="flex:1"></select>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <div id="result" dir="ltr" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;font-family:var(--mono);font-weight:700"></div>
        <select id="to" style="flex:1"></select>
      </div>
    </div>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS,
    "js": """
(function () {
  var UNITS = {
    length: [
      { n: 'متر', f: 1 }, { n: 'کیلومتر', f: 1000 }, { n: 'سانتی‌متر', f: 0.01 },
      { n: 'میلی‌متر', f: 0.001 }, { n: 'اینچ', f: 0.0254 }, { n: 'فوت', f: 0.3048 }, { n: 'مایل', f: 1609.344 }
    ],
    weight: [
      { n: 'کیلوگرم', f: 1 }, { n: 'گرم', f: 0.001 }, { n: 'میلی‌گرم', f: 0.000001 },
      { n: 'پوند', f: 0.453592 }, { n: 'اونس', f: 0.0283495 }, { n: 'تن', f: 1000 }
    ],
    temperature: [
      { n: 'سلسیوس', kind: 'C' }, { n: 'فارنهایت', kind: 'F' }, { n: 'کلوین', kind: 'K' }
    ]
  };
  var kind = 'length';
  var valueEl = document.getElementById('value');
  var fromEl = document.getElementById('from');
  var toEl = document.getElementById('to');
  var resultEl = document.getElementById('result');

  function fill() {
    fromEl.innerHTML = ''; toEl.innerHTML = '';
    UNITS[kind].forEach(function (u) {
      var o1 = document.createElement('option'); o1.textContent = u.n; fromEl.appendChild(o1);
      var o2 = document.createElement('option'); o2.textContent = u.n; toEl.appendChild(o2);
    });
    toEl.selectedIndex = UNITS[kind].length > 1 ? 1 : 0;
    convert();
  }
  function temp(v, from, to) {
    var c;
    if (from === 'C') c = v;
    else if (from === 'F') c = (v - 32) * 5 / 9;
    else c = v - 273.15;
    if (to === 'C') return c;
    if (to === 'F') return c * 9 / 5 + 32;
    return c + 273.15;
  }
  function convert() {
    var v = parseFloat(valueEl.value);
    if (isNaN(v)) { resultEl.textContent = '—'; return; }
    if (kind === 'temperature') {
      var r = temp(v, UNITS[kind][fromEl.selectedIndex].kind, UNITS[kind][toEl.selectedIndex].kind);
      resultEl.textContent = Math.round(r * 100000) / 100000;
    } else {
      var f1 = UNITS[kind][fromEl.selectedIndex].f;
      var f2 = UNITS[kind][toEl.selectedIndex].f;
      var res = v * f1 / f2;
      resultEl.textContent = Math.round(res * 1000000) / 1000000;
    }
  }
  document.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      document.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
      c.classList.add('active');
      kind = c.getAttribute('data-u');
      fill();
    });
  });
  valueEl.addEventListener('input', convert);
  fromEl.addEventListener('change', convert);
  toEl.addEventListener('change', convert);
  fill();
})();
""",
}

# ---------------------------------------------------------------- tictactoe
TEMPLATES["tictactoe"] = {
    "name_fa": "بازی دوز",
    "dir": "rtl",
    "keywords": ["دوز", "tic tac toe", "ایکس او", "اکس او", "tic-tac-toe", "x o"],
    "structure": [
        {"selector": "#turn", "name": "نشانگر نوبت", "kind": "text"},
        {"selector": ".cell", "name": "خانه‌های بازی", "kind": "button"},
        {"selector": "#reset-btn", "name": "دکمه شروع دوباره", "kind": "button"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:400px;max-width:100%;text-align:center">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
      <h1 style="font-size:1.4rem">""" + t + """</h1>
      <span id="turn" style="color:var(--muted)">نوبت: X</span>
    </div>
    <div id="board" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px"></div>
    <button id="reset-btn" class="btn ghost">شروع دوباره</button>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS + """
.cell {
  aspect-ratio: 1; background: var(--surface2); border: 1px solid var(--border);
  border-radius: 12px; font-size: 2.2rem; font-weight: 800; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all .12s ease;
}
.cell:hover { border-color: var(--accent); }
.cell.x { color: var(--accent); }
.cell.o { color: var(--accent2); }
.cell.win { background: var(--glow); border-color: var(--accent); }
""",
    "js": """
(function () {
  var board = document.getElementById('board');
  var turnEl = document.getElementById('turn');
  var cells = [];
  var turn = 'X';
  var over = false;

  function checkWin() {
    var lines = [
      [0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]
    ];
    for (var i = 0; i < lines.length; i++) {
      var a = lines[i][0], b = lines[i][1], c = lines[i][2];
      if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
        [a, b, c].forEach(function (idx) {
          board.children[idx].classList.add('win');
        });
        return cells[a];
      }
    }
    return cells.every(function (c) { return c !== null; }) ? 'draw' : null;
  }

  function build() {
    board.innerHTML = '';
    cells = [];
    turn = 'X'; over = false;
    turnEl.textContent = 'نوبت: X';
    for (var i = 0; i < 9; i++) {
      cells.push(null);
      var cell = document.createElement('button');
      cell.className = 'cell';
      cell.addEventListener('click', function () { play(this); });
      board.appendChild(cell);
    }
  }
  function play(el) {
    if (over || el.textContent) return;
    var idx = Array.prototype.indexOf.call(board.children, el);
    el.textContent = turn;
    el.classList.add(turn.toLowerCase());
    cells[idx] = turn;
    var result = checkWin();
    if (result) {
      over = true;
      if (result === 'draw') turnEl.textContent = 'مساوی شد!';
      else turnEl.textContent = 'برنده: ' + result;
      return;
    }
    turn = turn === 'X' ? 'O' : 'X';
    turnEl.textContent = 'نوبت: ' + turn;
  }
  document.getElementById('reset-btn').addEventListener('click', build);
  build();
})();
""",
}

# --------------------------------------------------------------------- misc
TEMPLATES["guess"] = {
    "name_fa": "بازی حدس عدد",
    "dir": "rtl",
    "keywords": ["حدس عدد", "حدس بزن", "عدد حدس", "حدس"],
    "structure": [
        {"selector": "#guess-input", "name": "فیلد حدس", "kind": "input"},
        {"selector": "#guess-btn", "name": "دکمه حدس", "kind": "button"},
        {"selector": "#hint", "name": "راهنما", "kind": "text"},
        {"selector": "body", "name": "پس‌زمینه", "kind": "background"},
    ],
    "html": lambda t, d, img: _page(
        t, d, img,
        """
<main class="app" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:420px;max-width:100%;text-align:center">
    <h1 style="font-size:1.4rem;margin-bottom:8px">""" + t + """</h1>
    <p style="color:var(--muted);margin-bottom:20px">یک عدد بین ۱ تا ۱۰۰ در نظر گرفته‌ام. حدس بزن!</p>
    <div style="display:flex;gap:10px;margin-bottom:14px">
      <input id="guess-input" type="number" min="1" max="100" dir="ltr" style="flex:1;text-align:center;font-family:var(--mono)">
      <button id="guess-btn" class="btn primary">حدس</button>
    </div>
    <div id="hint" style="min-height:24px;font-weight:700;margin-bottom:10px"></div>
    <div id="attempts" style="color:var(--muted);font-size:.9rem"></div>
    <button id="again-btn" class="btn ghost" style="margin-top:16px;display:none">دوباره</button>
  </div>
</main>
""",
    ),
    "css": lambda: SHARED_CSS,
    "js": """
(function () {
  var secret = Math.floor(Math.random() * 100) + 1;
  var attempts = 0;
  var input = document.getElementById('guess-input');
  var hint = document.getElementById('hint');
  var attemptsEl = document.getElementById('attempts');

  function reset() {
    secret = Math.floor(Math.random() * 100) + 1;
    attempts = 0;
    hint.textContent = '';
    attemptsEl.textContent = '';
    input.value = ''; input.disabled = false;
    document.getElementById('guess-btn').disabled = false;
    document.getElementById('again-btn').style.display = 'none';
  }

  document.getElementById('guess-btn').addEventListener('click', function () {
    var v = parseInt(input.value, 10);
    if (isNaN(v) || v < 1 || v > 100) { hint.textContent = 'یک عدد بین ۱ تا ۱۰۰ وارد کن'; return; }
    attempts++;
    if (v === secret) {
      hint.textContent = 'آفرین! درست حدس زدی 🎉';
      hint.style.color = '#43a047';
      input.disabled = true; document.getElementById('guess-btn').disabled = true;
      document.getElementById('again-btn').style.display = 'inline-block';
    } else {
      hint.style.color = '';
      hint.textContent = v < secret ? 'بزرگ‌تر بگو ⬆' : 'کوچک‌تر بگو ⬇';
    }
    attemptsEl.textContent = 'تعداد تلاش‌ها: ' + attempts;
    input.value = ''; input.focus();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('guess-btn').click();
  });
  document.getElementById('again-btn').addEventListener('click', reset);
})();
""",
}


# --------------------------------------------------------------------------
# Generator
# --------------------------------------------------------------------------

TYPE_ORDER = [
    "calculator", "todo", "snake", "quiz", "guess", "tictactoe",
    "clock", "stopwatch", "password", "converter", "landing",
]


def detect_type(text) -> str:
    """Return the template key best matching the request, or 'landing'."""
    from . import persian
    s = persian.soft(text)
    best, best_score = None, 0
    for key in TYPE_ORDER:
        tpl = TEMPLATES[key]
        score = 0
        for kw in tpl["keywords"]:
            k = persian.soft(kw)
            if k and k in s:
                score += len(k)
        if score > best_score:
            best, best_score = key, score
    if best is None:
        if persian.contains(s, "سایت", "وب", "صفحه", "رزومه"):
            return "landing"
    return best or "landing"


def extract_theme(text) -> str:
    from . import persian
    s = persian.soft(text)
    for word, key in THEME_WORDS.items():
        if key and persian.soft(word) in s:
            return key
    return "dark"


def extract_accent(text, theme) -> str:
    from . import persian
    s = persian.soft(text)
    for word, hexv in COLOR_WORDS.items():
        if persian.soft(word) in s:
            return hexv
    return THEMES.get(theme, THEMES["dark"])["accent"]


def extract_image_request(text):
    """Return the image subject if the user asked for an image, else None.

    Handles forms like:
      عکس پرچم شیر و خورشید ایران رو بزار
      تصویر گربه و بگذار توی هدر
      پرچم ایران رو بزار بالای صفحه
    """
    from . import persian
    s = persian.soft(text)
    if not persian.contains(s, "عکس", "تصویر", "پرچم", "لوگو", "آیکون"):
        return None
    marker = None
    for m in ("عکس", "تصویر", "پرچم", "لوگو", "آیکون"):
        if m in s:
            marker = m
            break
    tail = s[s.index(marker) + len(marker):].strip()
    # cut at any trailing verb/filler so only the subject remains (longest first)
    ends = [
        "رو قرار بده", "رو بگذار", "و بگذار", "و بذار", "و بزار", "رو بزار",
        "رو بذار", "رو توی", "رو تو", "بگذار", "بزار", "بذار", "قرار بده",
        "رو بنداز", "توی", "تو", "داخل", "در", "بالا", "هدر", "header",
        "جلوی", "کنار", "سمت", "پایین", "زیر",
    ]
    ends.sort(key=len, reverse=True)
    for end in ends:
        if end in tail:
            tail = tail.split(end)[0]
            break
    tail = tail.strip(" ،.،؛-:")
    if not tail:
        return None
    return marker + " " + tail


def default_title(type_key, theme_key, accent):
    tpl = TEMPLATES[type_key]
    name = tpl["name_fa"]
    theme_name = THEMES.get(theme_key, THEMES["dark"])["name_fa"]
    return f"{name} - {theme_name}"


class Generator:
    def __init__(self, projects_root: str, emit=None):
        self.root = projects_root
        self.emit = emit  # callable(kind, text)

    # ------------------------------------------------------------- helpers
    def _log(self, kind, text):
        if self.emit:
            self.emit(kind, text)

    def _write(self, path, content):
        tmp = str(path) + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        os.replace(tmp, str(path))

    # ------------------------------------------------------------- project
    def create_project(self, pid: str, spec: dict):
        """Generate a full project. Returns a descriptor dict."""
        from . import persian
        tpl = TEMPLATES[spec["type"]]
        title = spec.get("title") or default_title(spec["type"], spec["theme"], spec["accent"])
        direction = tpl["dir"]
        root = os.path.join(self.root, pid)

        image_block = ""
        subject = spec.get("image_subject")
        if subject:
            self._log("step", f"جستجوی تصویر: {subject}")
            os.makedirs(os.path.join(root, "assets"), exist_ok=True)
            dest = os.path.join(root, "assets", "image.png")
            result = search_mod.download_image(subject, dest)
            if result:
                self._log("ok", "تصویر پیدا و دانلود شد")
                image_block = (
                    '<header class="app-header">\n'
                    f'  <img src="assets/image.png" alt="{subject}">\n'
                    f'  <span>{title}</span>\n'
                    "</header>\n"
                )
            else:
                self._log("skip", "تصویر پیدا نشد یا اینترنت در دسترس نبود - بدون تصویر ادامه می‌دهم")

        files = {
            "index.html": tpl["html"](title, direction, image_block),
            "style.css": theme_css(spec["theme"], spec["accent"]) + tpl["css"](),
            "app.js": tpl["js"],
        }

        meta = {
            "id": pid,
            "name": spec.get("name") or title,
            "type": spec["type"],
            "type_fa": tpl["name_fa"],
            "theme": spec["theme"],
            "accent": spec["accent"],
            "title": title,
            "direction": direction,
            "structure": tpl["structure"],
            "created": time.time(),
            "image": subject,
        }

        os.makedirs(root, exist_ok=True)
        for fname, content in files.items():
            self._write(os.path.join(root, fname), content)
        self._write(os.path.join(root, "meta.json"), json.dumps(meta, ensure_ascii=False, indent=1))

        file_list = []
        for fname in files:
            p = os.path.join(root, fname)
            file_list.append({"path": fname, "size": os.path.getsize(p)})
        if subject and os.path.exists(os.path.join(root, "assets", "image.png")):
            file_list.append({"path": "assets/image.png", "size": os.path.getsize(os.path.join(root, "assets", "image.png"))})

        descriptor = {
            "id": pid,
            "name": meta["name"],
            "type_fa": meta["type_fa"],
            "root": root,
            "files": file_list,
            "meta": meta,
        }
        return descriptor

    # -------------------------------------------------------------- modify
    def apply_modify(self, proj: dict, change: dict):
        """Apply a change to an existing project. Returns list of touched files."""
        import shutil
        root = proj["root"]
        meta = proj["meta"]
        touched = []
        style_path = os.path.join(root, "style.css")
        html_path = os.path.join(root, "index.html")

        def read(p):
            with open(p, "r", encoding="utf-8") as f:
                return f.read()

        def write(p, content):
            self._write(p, content)
            touched.append(os.path.basename(p))

        action = change.get("action")
        value = change.get("value", "")
        target = change.get("target")

        if action == "theme":
            css = read(style_path)
            new_root = theme_css(value, meta.get("accent", "#6366f1"))
            css = re.sub(r":root\s*\{[^}]*\}", new_root, css, count=1, flags=re.S)
            write(style_path, css)
            meta["theme"] = value

        elif action == "accent":
            css = read(style_path)
            css = re.sub(r"(--accent:\s*)[^;]+;", r"\g<1>" + value + ";", css, count=1)
            write(style_path, css)
            meta["accent"] = value

        elif action == "button_color":
            css = read(style_path)
            selector = change.get("selector", ".btn")
            css += (
                f"\n/* تغییر توسط Professor Flash */\n"
                f"{selector} {{ background: {value} !important; border-color: {value} !important; box-shadow: 0 4px 18px {value}55 !important; }}\n"
            )
            write(style_path, css)

        elif action == "background":
            css = read(style_path)
            css += (
                f"\n/* تغییر توسط Professor Flash */\n"
                f":root {{ --bg: {value}; --bg2: {value}; }}\n"
                f"body {{ background: {value}; }}\n"
            )
            write(style_path, css)

        elif action == "title":
            html = read(html_path)
            title = value or meta["title"]
            html = re.sub(r"<title>[^<]*</title>", f"<title>{title}</title>", html, count=1)
            write(html_path, html)
            meta["title"] = title

        elif action == "add_text":
            html = read(html_path)
            if "<main" in html:
                block = f'<p style="text-align:center;color:var(--muted);margin-top:16px">{value}</p>\n'
                html = html.replace("</main>", block + "</main>", 1)
                write(html_path, html)

        elif action == "remove":
            css = read(style_path)
            selector = change.get("selector", ".feature-card")
            css += f"\n/* حذف توسط Professor Flash */\n{selector} {{ display: none !important; }}\n"
            write(style_path, css)

        elif action == "image":
            os.makedirs(os.path.join(root, "assets"), exist_ok=True)
            dest = os.path.join(root, "assets", "image.png")
            result = search_mod.download_image(value, dest)
            if result:
                change["image_ok"] = True
                html = read(html_path)
                if '<header class="app-header">' not in html:
                    block = (
                        '<header class="app-header">\n'
                        f'  <img src="assets/image.png" alt="{value}">\n'
                        f'  <span>{meta.get("title", "")}</span>\n'
                        "</header>\n"
                    )
                    html = re.sub(r"<body>\s*", "<body>\n" + block, html, count=1)
                    write(html_path, html)
                else:
                    touched.append("assets/image.png")
            else:
                change["image_ok"] = False

        elif action == "bigger":
            css = read(style_path)
            css += "\n/* بزرگ‌تر توسط Professor Flash */\nbody { font-size: 115%; }\n"
            write(style_path, css)

        elif action == "smaller":
            css = read(style_path)
            css += "\n/* کوچک‌تر توسط Professor Flash */\nbody { font-size: 92%; }\n"
            write(style_path, css)

        if action in ("theme", "accent", "title"):
            # persist meta change
            mp = os.path.join(root, "meta.json")
            write(mp, json.dumps(meta, ensure_ascii=False, indent=1))

        proj["meta"] = meta
        return touched
