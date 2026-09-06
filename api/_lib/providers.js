// Provider chain for Professor Flash.
// Free, keyless OpenAI-compatible providers, read live from Model/models.json.
// Strategy: race batches of strong models (streaming, first-token wins),
// fall back to non-streaming providers, never leave the user with a dead-end.

import fs from "node:fs";
import path from "node:path";
import {
  fetchTimeout,
  sleep,
  extractAnswer,
  isRateLimitPayload,
  createThinkFilter,
} from "./util.js";

const FALLBACK_ROSTER = {
  providers: [
    {
      id: "ovh",
      label: "OVHcloud AI",
      url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
      type: "openai",
      chat: [
        "Qwen3.5-397B-A17B",
        "gpt-oss-120b",
        "Qwen3.8-27B",
        "Qwen3.6-27B",
        "Meta-Llama-3_3-70B-Instruct",
        "Mistral-Small-3.2-24B-Instruct-2506",
        "Qwen3-32B",
        "Qwen3-Coder-30B-A3B-Instruct",
      ],
      agent: [
        "Qwen3-Coder-30B-A3B-Instruct",
        "Qwen3.5-397B-A17B",
        "gpt-oss-120b",
        "Qwen3.8-27B",
        "Qwen3.6-27B",
        "Qwen3-32B",
        "Meta-Llama-3_3-70B-Instruct",
      ],
    },
    {
      id: "kilo",
      label: "Kilo Gateway",
      url: "https://api.kilo.ai/api/gateway/chat/completions",
      type: "openai",
      chat: ["openrouter/free", "kilo-auto/free"],
      agent: ["openrouter/free", "kilo-auto/free"],
    },
    {
      id: "pollinations",
      label: "Pollinations",
      url: "https://text.pollinations.ai/openai",
      type: "openai",
      chat: ["openai-fast"],
      agent: ["openai-fast"],
    },
  ],
  limits: {
    chatMaxTokens: 4096,
    agentMaxTokens: 8192,
    firstTokenDeadlineMs: 16000,
    batchSize: 3,
    temperatureChat: 0.75,
    temperatureAgent: 0.35,
  },
};

let _rosterCache = { at: 0, data: null };

export function getRoster() {
  if (_rosterCache.data && Date.now() - _rosterCache.at < 5 * 60 * 1000) {
    return _rosterCache.data;
  }
  let data = FALLBACK_ROSTER;
  try {
    const p = path.join(process.cwd(), "Model", "models.json");
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && Array.isArray(parsed.providers) && parsed.providers.length) {
      data = {
        providers: parsed.providers,
        limits: { ...FALLBACK_ROSTER.limits, ...(parsed.limits || {}) },
      };
    }
  } catch {
    /* bundled fallback */
  }
  _rosterCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------- cooldowns
const COOLDOWNS = new Map(); // key -> until ts

function cooled(key) {
  return (COOLDOWNS.get(key) || 0) > Date.now();
}
function cool(key, secs) {
  COOLDOWNS.set(key, Date.now() + secs * 1000);
  if (COOLDOWNS.size > 400) COOLDOWNS.clear();
}

// ------------------------------------------------------------ streaming try
/**
 * One streaming attempt. Yields content deltas only (reasoning dropped).
 * Throws before first yield when the provider fails / is rate-limited.
 */
async function* streamOpenAI({ url, model, body, signal }) {
  const res = await fetchTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ ...body, model, stream: true }),
      signal,
    },
    45000
  );
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok || !ctype.includes("event-stream")) {
    const text = await res.text().catch(() => "");
    if (isRateLimitPayload(res.status, text)) throw new Error("rate-limited");
    throw new Error(`http-${res.status}`);
  }
  const filter = createThinkFilter();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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
        const tail = filter.flush();
        if (tail) yield tail;
        return;
      }
      let d;
      try {
        d = JSON.parse(payload);
      } catch {
        continue;
      }
      if (d.error || isRateLimitPayload(200, JSON.stringify(d).slice(0, 300))) {
        throw new Error("stream-error");
      }
      const delta = d.choices?.[0]?.delta;
      const piece = delta?.content;
      if (typeof piece === "string" && piece) {
        const clean = filter.push(piece);
        if (clean) yield clean;
      }
    }
  }
  const tail = filter.flush();
  if (tail) yield tail;
}

// Race `models` (same provider): first to emit a content delta wins.
async function raceStreaming(url, models, body, { deadlineMs, signal }, onDelta) {
  const ctrls = models.map(() => new AbortController());
  const onOuter = () => ctrls.forEach((c) => c.abort());
  if (signal) {
    if (signal.aborted) onOuter();
    else signal.addEventListener("abort", onOuter, { once: true });
  }
  const gens = models.map((m, i) =>
    streamOpenAI({ url, model: m, body, signal: ctrls[i].signal })
  );
  const pending = new Map();
  gens.forEach((g, i) =>
    pending.set(
      i,
      g
        .next()
        .then((r) => ({ i, ok: !r.done && !!r.value, value: r.value }))
        .catch(() => ({ i, ok: false }))
    )
  );
  const deadline = sleep(deadlineMs).then(() => ({ timeout: true }));
  const alive = new Set(models.map((_, i) => i));
  let winner = -1;
  let firstValue = "";
  try {
    while (alive.size) {
      const res = await Promise.race(
        [...alive].map((i) => pending.get(i)).concat([deadline])
      );
      if (res.timeout) break;
      alive.delete(res.i);
      if (res.ok) {
        winner = res.i;
        firstValue = res.value;
        break;
      }
    }
    if (winner < 0) return null;
    ctrls.forEach((c, i) => {
      if (i !== winner) c.abort();
    });
    onDelta(firstValue);
    let full = firstValue;
    try {
      for await (const d of gens[winner]) {
        onDelta(d);
        full += d;
      }
    } catch {
      /* upstream dropped mid-stream: keep what we have */
    }
    return { model: models[winner], text: full };
  } finally {
    if (winner < 0) ctrls.forEach((c) => c.abort());
    if (signal) signal.removeEventListener("abort", onOuter);
  }
}

// ---------------------------------------------------------- non-stream try
async function completeOpenAI({ url, model, body, signal, timeoutMs = 40000 }) {
  const res = await fetchTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model, stream: false }),
      signal,
    },
    timeoutMs
  );
  const text = await res.text().catch(() => "");
  if (isRateLimitPayload(res.status, text)) throw new Error("rate-limited");
  if (!res.ok) throw new Error(`http-${res.status}`);
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    // some providers answer with plain text
    const clean = text.trim();
    if (clean && !clean.startsWith("<")) return clean;
    throw new Error("bad-json");
  }
  const ans = extractAnswer(d.choices?.[0]?.message);
  if (!ans) throw new Error("empty");
  return { text: ans, routedModel: d.model || model };
}

// ------------------------------------------------------------------ engine
/**
 * Generate an answer. Calls onDelta(text) as content streams in and
 * onStatus(faText) as the engine moves through providers.
 * Returns { text, providerLabel, model }.
 */
export async function generateAnswer({
  messages,
  mode = "chat",
  signal,
  onDelta = () => {},
  onStatus = () => {},
}) {
  const roster = getRoster();
  const L = roster.limits;
  const maxTokens = mode === "agent" ? L.agentMaxTokens : L.chatMaxTokens;
  const temperature = mode === "agent" ? L.temperatureAgent : L.temperatureChat;
  const body = { messages, temperature, max_tokens: maxTokens };

  const errors = [];
  let collected = "";

  for (const prov of roster.providers) {
    const models = (mode === "agent" ? prov.agent : prov.chat) || prov.chat || [];
    const usable = models.filter((m) => !cooled(`${prov.id}:${m}`));
    const list = usable.length ? usable : models; // all cooled → try anyway

    // 1) streaming races in batches
    for (let i = 0; i < list.length; i += L.batchSize) {
      const batch = list.slice(i, i + L.batchSize);
      onStatus(statusFor(prov, batch));
      try {
        collected = "";
        const win = await raceStreaming(
          prov.url,
          batch,
          body,
          { deadlineMs: L.firstTokenDeadlineMs, signal },
          (d) => {
            collected += d;
            onDelta(d);
          }
        );
        if (win && collected.trim()) {
          return {
            text: collected,
            providerLabel: prov.label,
            model: win.model,
          };
        }
        batch.forEach((m) => cool(`${prov.id}:${m}`, 20));
      } catch (e) {
        errors.push(`${prov.id}/${batch.join(",")}: ${e.message}`);
        batch.forEach((m) => cool(`${prov.id}:${m}`, e.message === "rate-limited" ? 45 : 20));
      }
    }

    // 2) non-stream fallback per model (some providers only do non-stream)
    for (const m of list) {
      if (cooled(`${prov.id}:${m}`)) continue;
      onStatus(statusFor(prov, [m]));
      try {
        const r = await completeOpenAI({ url: prov.url, model: m, body, signal });
        // pseudo-stream the finished answer so the UI feels alive
        for (const piece of splitChunks(r.text)) {
          onDelta(piece);
          await sleep(8);
        }
        return { text: r.text, providerLabel: prov.label, model: r.routedModel };
      } catch (e) {
        errors.push(`${prov.id}/${m}: ${e.message}`);
        cool(`${prov.id}:${m}`, e.message === "rate-limited" ? 45 : 20);
      }
    }
  }

  const err = new Error("all-providers-failed");
  err.details = errors.slice(-8);
  throw err;
}

function statusFor(prov, batch) {
  const names = batch.join(" ، ");
  return `اتصال به ${prov.label} (${names})…`;
}

function* splitChunks(text, size = 28) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}
