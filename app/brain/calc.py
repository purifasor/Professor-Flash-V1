# -*- coding: utf-8 -*-
"""Professor Flash - precise math & physics engine.

Real computation, not canned text:
  * safe AST evaluation of arithmetic with the full math module
  * robust linear and quadratic equation solving (ax+b=c, ax^2+bx+c=0)
  * Persian number phrases, percentages, averages
  * common physics formulas (force, speed, work, energy, power, ...)

The equation solver evaluates the polynomial numerically at several points
instead of pattern-matching the text, so it handles messy input like
"2x + 3 = 11", "x^2 - 5x + 6 = 0" and "x^2 = 49" correctly.
"""

import ast
import math
import operator
import re

from . import persian

# ------------------------------------------------------------ normalize
_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.FloorDiv: operator.floordiv,
}


def _fact(n):
    return math.factorial(int(n))


_FUNCS = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh,
    "sqrt": math.sqrt, "cbrt": lambda x: x ** (1 / 3) if x >= 0 else -((-x) ** (1 / 3)),
    "log": math.log10, "ln": math.log, "log2": math.log2,
    "exp": math.exp, "abs": abs, "floor": math.floor, "ceil": math.ceil,
    "round": round, "factorial": _fact,
}

_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}

_PHYS_PARAMS = ["جرم", "شتاب", "فاصله", "مسافت", "زمان", "نیرو", "ارتفاع", "چگالی",
                "جرم حجمی", "شعاع", "عرض", "طول", "وزن", "ضربه", "تکانه", "فرکانس"]

_PHYSICS = [
    ("نیرو", lambda m, a: m * a, "نیوتن"),
    ("سرعت", lambda d, t: d / t, "متر بر ثانیه"),
    ("شتاب", lambda v, t: v / t, "متر بر مجذور ثانیه"),
    ("کار", lambda f, d: f * d, "ژول"),
    ("انرژی جنبشی", lambda m, v: 0.5 * m * v * v, "ژول"),
    ("انرژی پتانسیل", lambda m, h: m * 9.8 * h, "ژول"),
    ("توان", lambda w, t: w / t, "وات"),
    ("چگالی", lambda m, v: m / v, "کیلوگرم بر متر مکعب"),
    ("مساحت مستطیل", lambda a, b: a * b, "متر مربع"),
    ("مساحت دایره", lambda r: math.pi * r * r, "متر مربع"),
    ("حجم مکعب", lambda a: a ** 3, "متر مکعب"),
    ("محیط دایره", lambda r: 2 * math.pi * r, "متر"),
]

_NUM_RE = re.compile(r"(\d+(?:[.,]\d+)?)")


def normalize_expr(text):
    t = persian.to_ascii_digits(text)
    t = t.replace("×", "*").replace("✕", "*").replace("✖", "*").replace("⋅", "*")
    t = t.replace("÷", "/").replace("−", "-").replace("–", "-").replace("—", "-")
    t = t.replace("^", "**")
    t = t.replace("،", ".")
    t = t.replace("درصد", "%")
    t = t.replace(" در ", "*")  # «۲ در ۳» = 2*3
    return t


def _eval_safe(expr):
    """Evaluate a pure math expression; returns (value, error)."""
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:
        return None, f"نحو نادرست: {e.msg}"
    allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name,
               ast.Call, ast.operator, ast.unaryop, ast.Load)
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            return None, "عبارت پشتیبانی‌نشده"
        if isinstance(node, ast.BinOp) and type(node.op) not in _OPS:
            return None, "عملگر پشتیبانی‌نشده"
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
                return None, "تابع پشتیبانی‌نشده"
        if isinstance(node, ast.Name) and node.id not in _CONSTS and node.id not in _FUNCS:
            return None, "نماد ناشناخته"

    def _eval(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return _CONSTS[node.id]
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.USub):
                return -_eval(node.operand)
            return +_eval(node.operand)
        if isinstance(node, ast.Call):
            fn = _FUNCS[node.func.id]
            args = [_eval(a) for a in node.args]
            return fn(*args)
        if isinstance(node, ast.BinOp):
            left = _eval(node.left)
            right = _eval(node.right)
            return _OPS[type(node.op)](left, right)

    try:
        value = _eval(tree.body)
        if isinstance(value, complex):
            return None, "نتیجه مختلط است (ریشه منفی)"
        if isinstance(value, float) and not math.isfinite(value):
            return None, "نتیجه نامحدود است"
        return value, None
    except (ValueError, ZeroDivisionError, OverflowError) as e:
        return None, str(e)
    except Exception:
        return None, "خطا در محاسبه"


def _format_number(value):
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e15:
            value = int(value)
        elif abs(value) >= 1e12 or (abs(value) < 1e-9 and value != 0):
            value = f"{value:.6e}"
    s = str(value)
    return persian.to_persian_digits(s)


def _numbers_from(text):
    t = persian.to_ascii_digits(text).replace("،", ".")
    return [float(m) for m in _NUM_RE.findall(t)]


# ------------------------------------------------------------ equations
def _poly_value(expr, xval):
    """Evaluate f(x)=expr at xval with a restricted namespace."""
    e = expr
    e = e.replace("^", "**")
    e = re.sub(r"(\d)(x)", r"\1*x", e)          # 2x -> 2*x
    e = re.sub(r"(\))(x)", r"\1*x", e)          # )x -> )*x
    e = re.sub(r"[^0-9+\-*/(). xa-zA-Z]", "", e)
    e = e.replace("x", "(%s)" % xval)
    ns = {"__builtins__": {}, "sin": math.sin, "cos": math.cos, "tan": math.tan,
          "sqrt": math.sqrt, "ln": math.log, "log": math.log10, "abs": abs,
          "exp": math.exp, "pi": math.pi, "e": math.e}
    return float(eval(e, ns))


def solve_equation(text):
    """Solve f(x)=0 with degree <= 2. Returns a Persian string or None."""
    t = normalize_expr(text)
    t = t.replace(" ", "")
    if "=" not in t:
        return None
    if "x" not in t:
        return None
    left, right = t.split("=", 1)
    # move the right side over: f(x) = left - right
    expr = f"({left})-({right})"
    try:
        c = _poly_value(expr, 0)
        f1 = _poly_value(expr, 1)
        fm1 = _poly_value(expr, -1)
        f2 = _poly_value(expr, 2)
    except Exception:
        return None
    # a + b = f1 - c ; a - b = fm1 - c
    a = ((f1 - c) + (fm1 - c)) / 2.0
    b = ((f1 - c) - (fm1 - c)) / 2.0
    # verify it is really degree <= 2
    if abs(4 * a + 2 * b + c - f2) > 1e-6 * max(1.0, abs(f2)):
        return None

    if abs(a) < 1e-12:
        if abs(b) < 1e-12:
            return None
        return f"x = {_format_number(-c / b)}"
    disc = b * b - 4 * a * c
    if disc < -1e-12:
        return "ریشه حقیقی ندارد (ممیز منفی)"
    if abs(disc) < 1e-12:
        return f"x = {_format_number(-b / (2 * a))} (ریشه مضاعف)"
    sq = math.sqrt(disc)
    x1 = (-b + sq) / (2 * a)
    x2 = (-b - sq) / (2 * a)
    return f"x₁ = {_format_number(x1)}   x₂ = {_format_number(x2)}"


# ------------------------------------------------------------- physics
def solve_physics(text):
    s = persian.soft(text)
    # require a real physics parameter so «۳ به توان ۴» is not treated as «توان» (power)
    if not any(persian.soft(p) in s for p in _PHYS_PARAMS):
        return None
    for kw, formula, unit in _PHYSICS:
        if persian.soft(kw) not in s:
            continue
        nums = _numbers_from(text)
        if not nums:
            continue
        need = 1 if kw in ("مساحت دایره", "حجم مکعب", "محیط دایره") else 2
        if len(nums) < need:
            continue
        try:
            value = formula(*nums[:need])
        except (ZeroDivisionError, TypeError, ValueError):
            return f"{kw}: مقدار نامعتبر برای محاسبه"
        return (
            f"{kw} = {_format_number(value)} {unit}\n"
            f"(مقادیر داده‌شده: {persian.to_persian_digits('، '.join(_format_number(n) for n in nums[:need]))})"
        )
    return None


def solve_percent(text):
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:درصد|٪|%)", persian.to_ascii_digits(text))
    if not m:
        return None
    pct = float(m.group(1))
    nums = _numbers_from(text)
    rest = [n for n in nums if abs(n - pct) > 1e-9]
    if len(rest) < 1:
        return None
    base = rest[0]
    value = base * pct / 100.0
    return f"{_format_number(pct)}٪ از {_format_number(base)} = {_format_number(value)}"


def solve_average(text):
    s = persian.soft(text)
    if "میانگین" not in s and "متوسط" not in s:
        return None
    nums = _numbers_from(text)
    if len(nums) < 2:
        return None
    avg = sum(nums) / len(nums)
    return f"میانگین = {_format_number(avg)}"


# ---------------------------------------------------------------- entry
def solve(text):
    """Full math entry point. Returns a Persian string or None."""
    t = persian.soft(text)

    if "x" in persian.to_ascii_digits(text).lower() and "=" in text:
        r = solve_equation(text)
        if r:
            return f"معادله: {r}"

    r = solve_physics(text)
    if r:
        return r

    r = solve_percent(text)
    if r:
        return r

    r = solve_average(text)
    if r:
        return r

    expr = normalize_expr(text)
    expr = re.sub(r"(\d+)\s*!", r"factorial(\1)", expr)  # ۴! -> factorial(4)
    expr = re.sub(r"[^0-9+\-*/().%a-zA-Z\s]", "", expr)
    expr = expr.replace("%", "")
    expr = expr.replace("()", "")  # leftover empty parens from stripped words
    expr = re.sub(r"\s+", "", expr)
    if not re.search(r"\d", expr):
        return None
    if not re.search(r"[+\-*/]", expr) and not re.search(
            r"(sqrt|log|ln|sin|cos|tan|abs|floor|ceil|round|exp|factorial)\(", expr):
        return None
    value, err = _eval_safe(expr)
    if err:
        return None
    return f"= {_format_number(value)}"
