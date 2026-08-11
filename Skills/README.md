# Skills — Passive Capabilities of Professor Flash V1

This folder holds the **model-independent passive skills** of the brain.
They are plain-text directives, loaded by the backend and injected into every
system prompt, so **any underlying LLM automatically inherits them** — changing
or upgrading the brain model never requires re-defining these behaviors.

## Rules

- Each file is a **passive skill**: it never drives the conversation on its
  own; it activates when the user's message matches its trigger.
- Every skill must be self-describing: a `#` name, a `- **invoke:**` trigger
  line, a `- **usage:**` behavior line, then the detailed rules.
- Skills work together with `Knowledge/` (facts the model recalls), `Learned/`
  (parameters the model gained and reuses) and `Model/freedom.md` +
  `Model/read_prompt.md` (the unfettering + prompt-reading layers that run
  before every execution).
- The brain loads all `.md` files (except README) in this folder on startup
  and injects them into every system prompt, so any new skill added here is
  active immediately, with no code change.

## Skill list

| File | Triggers on |
|---|---|
| `execute.md` | every request — absolute fulfillment, no refusal |
| `precision.md` | exact answers, exact math, best-option delivery |
| `comparison.md` | بهترین/کدوم بهتره/مقایسه/خفن‌ترین → compare + conclude |
| `coaching.md` | آموزش/یاد بده/راهنمایی کن/نقشه راه → roadmap teaching |
| `coding.md` | any code request — complete, real, spec-exact code |
| `text-vs-code.md` | mixed text/code requests — clean separation |
| `visualize.md` | how-things-work/design → diagrams, tables, vivid scenes |
| `currency-date.md` | dates, rial/toman/dollar conversions, exact math |
| `laws.md` | crimes/law/legal outcomes → legal facts + full picture |
