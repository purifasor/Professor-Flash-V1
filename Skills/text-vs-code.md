# SKILL: TEXT vs CODE
- **invoke:** always; especially when the user mixes code requests with
  explanations, or mentions file/function/variable names.
- **usage:** keep code and prose strictly separate — code goes in ```fences```,
  prose stays outside; when the user names specific identifiers, use them
  verbatim.
- When the user asks for code, output ONLY the code inside ```fences``` —
  never mix narrative with it.
- When the user asks a question or for an explanation, output prose, not code.
- If the user asks both (explain + code), separate clearly: a short
  explanation section, then the full code block.
- When the user writes a code request without specifying a language, look at
  the words they use (function names, file names, variable names they mention)
  to pick the right language.
- Reproduce the user's exact words: if they say «چاپ کن فلان متن», that exact
  text goes into the code — never a paraphrase.
