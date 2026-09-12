// Remote (user-added) AI providers for Professor AI.
// Works with ANY OpenAI-compatible endpoint (new, old, unknown models):
//   POST {baseUrl}/chat/completions  with Authorization: Bearer <apiKey>
// Auto-discovers the right path when the base URL already includes
// /chat/completions or /v1. Handles streaming and non-streaming responses,
// plus a connection test used by the Add Provider screen.
//
// Resilience: slow/queued providers (some free gateways hold requests for
// minutes behind SSE keepalive comments) are tolerated — comment lines keep
// the read alive, the first-token deadline is generous, and a stream that
// dies mid-answer returns what it collected instead of throwing it away
// (the agent repair passes in chat.js resume from it).

import { fetchTimeout, extractAnswer, isRateLimitPayload, createThinkFilter } from "./util.js";

export function normalizeBaseUrl(raw) {
  let u = String(raw || "").trim().replace(/\s+/g, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/(chat\/completions|completions)$/i, "");
  if (!/\/v\d+$/i.test(u)) u += "/v1";
  return u;
}

export function chatUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl) + "/chat/completions";
}

/**
 * Test a user provider: simple 1-message completion with a short timeout.
 * Returns { ok, latencyMs, detail }.
 */
export async function testProvider({ baseUrl, apiKey, modelId }) {
  const t0 = Date.now();
  try {
    const res = await fetchTimeout(
      chatUrl(baseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey || ""}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
          stream: false,
        }),
      },
      45000
    );
    const text = await res.text().catch(() => "");
    if (res.ok) {
      let d = null;
      try { d = JSON.parse(text); } catch { /* some gateways return plain text */ }
      if (d && d.error) {
        return { ok: false, latencyMs: Date.now() - t0, detail: String(d.error.message || "api error").slice(0, 200) };
      }
      const ans = d ? extractAnswer(d.choices?.[0]?.message) : text.trim();
      if (ans || (!d && res.ok)) {
        return { ok: true, latencyMs: Date.now() - t0, detail: "connected", model: d?.model || modelId };
      }
      return { ok: false, latencyMs: Date.now() - t0, detail: "empty response" };
    }
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      detail: `HTTP ${res.status} ${text.slice(0, 120) || isRateLimitPayload(res.status, text) ? "rate limited" : ""}`.trim(),
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, detail: e?.message || "connection failed" };
  }
}

// internal: read an SSE stream to completion; tolerant of comment keepalives
// (": KILO PROCESSING" style) and long generation gaps after first token.
async function readSSEStream(res, onDelta, firstTokenDeadlineMs = 300000) {
  const filter = createThinkFilter();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let reasoningAcc = "";
  let gotFirst = false;
  let firstAt = 0;

  for (;;) {
    const chunkTimeout = gotFirst ? 900000 : firstTokenDeadlineMs;
    const read = await Promise.race([
      reader.read(),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error(gotFirst ? "stream-stalled" : "first-token-timeout")),
          chunkTimeout - (gotFirst ? Date.now() - firstAt : 0)
        )
      ),
    ]);
    const { done, value } = read;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith(":")) continue; // blank / keepalive comment
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") {
        const tail = filter.flush();
        if (tail) { full += tail; onDelta(tail); }
        // reasoning-only stream (content never arrived): use the reasoning
        // tail as the answer instead of dying with provider-empty
        if (!full.trim() && reasoningAcc.trim()) {
          full = reasoningAcc;
          onDelta(full);
        }
        if (!full.trim()) throw new Error("provider-empty");
        return full;
      }
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.error) throw new Error(String(d.error.message || "provider stream error").slice(0, 200));
      const delta = d.choices?.[0]?.delta;
      // content first; reasoning/reasoning_content only as a keepalive when
      // content never flows (some engines stream the answer inside reasoning)
      const piece =
        typeof delta?.content === "string" && delta.content
          ? delta.content
          : typeof d.choices?.[0]?.text === "string" && d.choices[0].text
            ? d.choices[0].text
            : null;
      const rPiece =
        piece === null &&
        ((typeof delta?.reasoning === "string" && delta.reasoning) ||
         (typeof delta?.reasoning_content === "string" && delta.reasoning_content) ||
         null);
      if (piece || rPiece) {
        if (!gotFirst) { gotFirst = true; firstAt = Date.now(); }
        if (piece) {
          const clean = filter.push(piece);
          if (clean) { full += clean; onDelta(clean); }
        } else if (rPiece) {
          reasoningAcc += rPiece;
          onDelta(""); // keepalive: no visible text, keeps timers alive
        }
      }
    }
  }
  const tail = filter.flush();
  if (tail) { full += tail; onDelta(tail); }
  // reasoning-only stream: the tail is the answer
  if (!full.trim() && reasoningAcc.trim()) {
    full = reasoningAcc;
    onDelta(full);
  }
  if (!full.trim()) throw new Error("provider-empty");
  return full;
}

/**
 * Stream a completion from a user provider.
 * Yields content deltas, returns { text, model }. Throws on failure
 * (chat.js shows a red error). Mid-answer connection drops return the
 * partial text with partial:true so the pipeline can resume.
 * Providers that reject large max_tokens (HTTP 400) are retried smaller.
 */
export async function streamRemote(
  { baseUrl, apiKey, modelId, messages, temperature, maxTokens, signal },
  onDelta
) {
  let maxTok = maxTokens ?? 4096;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await streamRemoteOnce(
        { baseUrl, apiKey, modelId, messages, temperature, maxTokens: maxTok, signal },
        onDelta
      );
    } catch (e) {
      const msg = String(e?.message || "");
      const isMaxTokenError =
        msg.includes("provider-http-400") &&
        attempt < 2 &&
        maxTok > 4096;
      if (isMaxTokenError) {
        maxTok = Math.max(4096, Math.floor(maxTok / 3));
        continue; // retry with a smaller budget
      }
      throw e;
    }
  }
}

async function streamRemoteOnce(
  { baseUrl, apiKey, modelId, messages, temperature, maxTokens, signal },
  onDelta
) {
  const res = await fetchTimeout(
    chatUrl(baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey || ""}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens ?? 4096,
        stream: true,
      }),
      signal,
    },
    90000
  );

  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider-http-${res.status}: ${text.slice(0, 150)}`);
  }

  // Non-SSE JSON response — some providers ignore stream:true
  if (!ctype.includes("event-stream")) {
    const text = await res.text();
    let d = null;
    try { d = JSON.parse(text); } catch { /* plain text */ }
    if (d && d.error) throw new Error(String(d.error.message || "provider error").slice(0, 200));
    const ans = d ? extractAnswer(d.choices?.[0]?.message) : text.trim();
    if (!ans) throw new Error("provider-empty");
    for (let i = 0; i < ans.length; i += 28) {
      onDelta(ans.slice(i, i + 28));
    }
    return { text: ans, model: d?.model || modelId };
  }

  // track what was streamed so a mid-answer death can salvage it
  let streamed = "";
  const wrappedDelta = (d) => { streamed += d; onDelta(d); };
  try {
    const full = await readSSEStream(res, wrappedDelta);
    return { text: full, model: modelId };
  } catch (e) {
    // Mid-answer stream death with substantial content → salvage it as a
    // PARTIAL answer; the client auto-resume continues from the cutoff.
    // Never throw away minutes of generation because the socket dropped.
    if (e.message === "stream-stalled" && streamed.length > 200) {
      return { text: streamed, model: modelId, partial: true };
    }
    throw e;
  }
}

/** Non-stream completion (used by sub-agents where streams are pointless). */
export async function completeRemote({ baseUrl, apiKey, modelId, messages, temperature, maxTokens, signal }, timeoutMs = 240000) {
  const res = await fetchTimeout(
    chatUrl(baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || ""}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: temperature ?? 0.5,
        max_tokens: maxTokens ?? 4096,
        stream: false,
      }),
      signal,
    },
    timeoutMs
  );
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`provider-http-${res.status}`);
  let d = null;
  try { d = JSON.parse(text); } catch { /* plain */ }
  if (d && d.error) throw new Error(String(d.error.message || "provider error").slice(0, 200));
  const ans = d ? extractAnswer(d.choices?.[0]?.message) : text.trim();
  if (!ans) throw new Error("provider-empty");
  return { text: ans, model: d?.model || modelId };
}
