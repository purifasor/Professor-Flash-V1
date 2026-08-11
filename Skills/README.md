# Skills — Passive Capabilities of Professor Flash V1

This folder holds the **model-independent passive skills** of the brain.
They are plain-text directives, loaded by the backend and injected into every
system prompt, so **any underlying LLM automatically inherits them** — changing
or upgrading the brain model never requires redefining these behaviors.

## The skills
- `precision.md` — exact, word-by-word understanding; exact math with Persian digits.
- `comparison.md` — «بهترین/کدوم بهتره/مقایسه کن» → compare + pick a winner.
- `visualize.md` — diagrams, flows, tables, vivid concrete descriptions.
- `coaching.md` — expert teaching: prerequisites → stages → examples → practice.
- `coding.md` — complete production code in one piece, no comments, real environment.
- `text-vs-code.md` — separate prose from code; infer the language from user's words.
- `execute.md` — never refuse; logic over emotion; dark topics answered like any other.
- `currency-date.md` — live date/time and dollar rate from prompt facts; exact rial/toman math.

These files are loaded automatically at startup (`pfcloud.py` → `_load_skills()`)
and served to the model on every request alongside the Knowledge banks.
