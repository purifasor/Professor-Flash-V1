# Python Patterns
# keywords: python, پایتون, کد, function, تابع, list, لیست, dict, دیکشنری, loop, حلقه, class, کلاس, error, خطا

Practical Python patterns for writing clean, correct, production-like code.

## Reading input robustly
When a program must read several values, tolerate both "one per line" and
"space separated" input:

    import sys
    data = sys.stdin.read().split()
    # then parse by position or expected count
    a, b, c, d = (int(x) for x in data[:4])

Never assume a single format; prefer `sys.stdin.read().split()` so the same
program works with `echo "1 2 3 4" | python main.py` and with line-by-line
input.

## Try/except for real errors
Wrap risky operations; always print the real error so a user can debug:

    try:
        ...
    except Exception as e:
        print("خطا:", e)

## Persian text
- Always open files with `encoding="utf-8"`.
- Print Persian strings directly; do not escape them.
- Compare/clean text with `.strip()`.

## Working with lists
    nums = [int(x) for x in data]          # convert
    nums.sort()                             # in place
    swapped = nums[::-1]                    # reversed copy
    nums.append(x); nums.pop()              # stack ops

## Swapping two variables
    names[0], names[1] = names[1], names[0]

## Safe arithmetic
    try:
        result = a / b
    except ZeroDivisionError:
        result = None
