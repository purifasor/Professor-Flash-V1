// Shared helpers for Professor Flash serverless functions.

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch with an AbortController timeout. Returns the raw Response. */
export async function fetchTimeout(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  const outer = options.signal;
  const onOuterAbort = () => ctrl.abort(outer.reason || new Error("aborted"));
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

/** Remove <think>...</think> spans (any case, also handles unclosed tail). */
export function stripThink(text) {
  if (!text) return "";
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // unclosed think block at the end
  out = out.replace(/<think>[\s\S]*$/gi, "");
  return out;
}

/**
 * Streaming think-filter: feed chunks, get back only non-thinking text.
 * Handles tags split across chunk boundaries.
 */
export function createThinkFilter() {
  let buf = "";
  let inThink = false;
  const OPEN = /<think>/i;
  const CLOSE = /<\/think>/i;

  function push(chunk) {
    buf += chunk;
    let out = "";
    for (;;) {
      if (inThink) {
        const m = buf.match(CLOSE);
        if (!m) {
          // keep only a possible partial closing tag in buf
          const partial = buf.match(/<\/t?h?i?n?k?$/i);
          buf = partial ? partial[0] : "";
          break;
        }
        buf = buf.slice(m.index + m[0].length);
        inThink = false;
        continue;
      }
      const m = buf.match(OPEN);
      if (!m) {
        // emit safe prefix, keep possible partial "<think" tail
        const partial = buf.match(/<t?h?i?n?k?$/i);
        const safeLen = partial ? buf.length - partial[0].length : buf.length;
        out += buf.slice(0, safeLen);
        buf = buf.slice(safeLen);
        break;
      }
      out += buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      inThink = true;
    }
    return out;
  }

  function flush() {
    const rest = inThink ? "" : buf;
    buf = "";
    return rest;
  }

  return { push, flush };
}

/**
 * Given an OpenAI-style message object, extract the best final answer text.
 * Some providers stuff everything into `reasoning` / `reasoning_content`.
 */
export function extractAnswer(msg) {
  if (!msg) return "";
  let content = stripThink((msg.content || "").trim());
  if (content) return content;
  const reasoning = stripThink(
    (msg.reasoning_content || msg.reasoning || "").trim()
  );
  if (!reasoning) return "";
  return finalFromReasoning(reasoning);
}

/** Heuristic: pull the actual answer out of a chain-of-thought dump. */
export function finalFromReasoning(text) {
  const t = text.trim();
  if (!t) return "";
  // prefer text after the last "final answer"-ish marker
  const markers = [
    /final answer[:\s]*/gi,
    /پاسخ نهایی[:\s]*/g,
    /answer[:\s]*/gi,
    /conclusion[:\s]*/gi,
  ];
  let best = null;
  for (const re of markers) {
    let m;
    while ((m = re.exec(t))) best = m.index + m[0].length;
  }
  let tail = best != null ? t.slice(best).trim() : "";
  if (tail.length < 12) {
    // fall back to the last non-empty paragraph
    const paras = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    tail = paras.slice(-2).join("\n\n");
  }
  return tail.slice(0, 4000);
}

/** True when a provider payload actually means "rate limited / busy". */
export function isRateLimitPayload(status, text) {
  if (status === 429 || status === 402) return true;
  if (!text) return false;
  const s = text.slice(0, 400).toLowerCase();
  return (
    s.includes("rate limit") ||
    s.includes("too many requests") ||
    s.includes("budget too low") ||
    s.includes("payment required") ||
    s.includes("temporarily unavailable") ||
    s.includes("bad gateway") ||
    s.includes("service unavailable")
  );
}

/** SSE writer helper. */
export function sseSend(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch {
    /* client gone */
  }
}

/** Slice a full text into small pseudo-stream chunks. */
export function* chunkText(text, size = 24) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}
