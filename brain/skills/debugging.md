# Skill — Debugging (دیباگ و رفع خطا)

- Read the error precisely: message, file, line. Map it back to the exact
  code path before touching anything.
- Symptom-driven debugging when there's no error text:
  - blank page → entry script failed to load/parse (wrong path, syntax
    error) — check first;
  - dead button → listener never wired, function name typo, or the element
    id doesn't match;
  - broken layout → missing CSS file, wrong class names, wrong path;
  - "sync" issues between backend and frontend → the endpoint/shape the
    frontend calls doesn't exist or differs from what the backend serves.
- Form ONE primary hypothesis, test it against ALL the evidence, fix the
  ROOT cause (not the symptom), then verify the fix doesn't break
  dependents.
- After any fix, mentally re-run the full flow from page load to the
  affected feature to confirm.
- When the user reports something vague («فلان کار رو نمی‌کنه»), narrow
  down by locating the file responsible for that feature and tracing its
  event chain: element → listener → handler → effect.
