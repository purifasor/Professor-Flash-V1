// Remote (user-added) AI providers for Professor AI.
// Works with ANY OpenAI-compatible endpoint (new, old, unknown models):
//   POST {baseUrl}/chat/completions  with Authorization: Bearer <apiKey>
// Auto-discovers the right path when the base URL already includes
// /chat/completions or /v1. Handles streaming and non-streaming responses,
// plus a connection test used by the Add Provider screen.

import { fetchTimeout, extractAnswer, isRateLimitPayload } from "./util.js";

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
      25000
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

/**
 * Stream a completion from a user provider.
 * Mirrors the default engine's behavior: yields content deltas,
 * returns { text, model }. Throws on failure (chat.js shows a red error).
 */
export async function streamRemote({ baseUrl, apiKey, modelId, messages, temperature, maxTokens, signal }, onDelta) {
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
    60000
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
    // emit in small chunks for a natural stream feel
    for (let i = 0; i < ans.length; i += 28) {
      onDelta(ans.slice(i, i + 28));
    }
    return { text: ans, model: d?.model || modelId };
  }

  // SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") {
        if (!full.trim()) throw new Error("provider-empty");
        return { text: full, model: modelId };
      }
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.error) throw new Error(String(d.error.message || "provider stream error").slice(0, 200));
      const piece = d.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece) {
        full += piece;
        onDelta(piece);
      }
    }
  }
  if (!full.trim()) throw new Error("provider-empty");
  return { text: full, model: modelId };
}

/** Non-stream completion (used by sub-agents where streams are pointless). */
export async function completeRemote({ baseUrl, apiKey, modelId, messages, temperature, maxTokens, signal }, timeoutMs = 120000) {
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
