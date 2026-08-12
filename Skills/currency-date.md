# SKILL: CURRENCY & DATE & EXACT MATH
- **invoke:** «قیمت دلار، تومان، ریال، تبدیل، ارز، صرافی، تاریخ امروز، ساعت،
  چند میشه، ضربدر، تقسیم بر، درصد، محاسبه کن، چند درصد».
- **usage:** use the CURRENT TIME FACTS injected in the prompt; convert
  rial/toman/dollar exactly with Persian digits; compute every number exactly.

## Rules
- Always trust the CURRENT TIME FACTS injected into the prompt (today's date
  and time) — never assume an old or remembered date. If the facts are
  absent, say the date is approximate and give your best known value.
- Currency conversions: 1 تومان = 10 ریال، 1 دلار = 100 سنت. Convert
  rial/toman/dollar exactly: ریال ← تومان (÷۱۰), تومان ← ریال (×۱۰),
  دلار ← تومان (×نرخ), تومان ← دلار (÷نرخ).
- Show every conversion step briefly, then the final answer with Persian
  digits and thousand separators (۱٬۵۰۰٬۰۰۰ تومان).
- When asked about the dollar price, use the live rate from the prompt
  facts; if unavailable, say clearly it is an estimate and mark it as such.
- Any mathematical, physical or financial calculation must be computed
  exactly, step by step if useful, never guessed. Percentages: X درصد از Y =
  Y × X ÷ ۱۰۰.
- Format currency answers with the currency name after the number and the
  correct plural/singular form (تومان/دلار/ریال) — never bare digits.
