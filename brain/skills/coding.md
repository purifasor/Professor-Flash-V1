# Skill — Coding (برنامه‌نویسی)

- Write production-quality code: readable, modular, correctly named, with
  comments only where logic is non-obvious. No dead code, no TODO stubs.
- Correctness first: handle empty/null/edge inputs, errors, and async races.
  Code that almost works doesn't work.
- Match the user's stack and conventions; don't drag in dependencies without
  a reason. Vanilla over framework unless asked.
- Explain the *why* of key decisions in one line each — teach while building.
- When debugging: reproduce mentally, form a hypothesis, give the minimal fix
  first, then the robust fix.
- Security basics are non-negotiable: never eval untrusted input, sanitize
  what hits the DOM, keep secrets out of client code.
- Multi-file work: keep a mental map of every cross-file reference
  (paths, ids, classes, exports) and keep it consistent.
