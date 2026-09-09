// Provider chain for Professor AI (default engine).
// Free, keyless OpenAI-compatible providers, read live from brain/models.json.
// Always strongest-first with reasoning ON ("maximum focus" is the only mode
// — the MAX/CODE toggle was removed by design).
//
// Anti-freeze measures for long agent builds:
//  - per-attempt timeouts + cooldowns so a stuck provider never blocks the
//    chain; the next model takes over mid-flight
//  - streaming kept alive; if a stream dies mid-answer, what was collected
//    is kept and the pipeline repair passes continue from it
//  - models that reject reasoning params are remembered and retried with
//    effort:low automatically

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
      id: "kilo",
      label: "Kilo Gateway",
      url: "https://api.kilo.ai/api/gateway/chat/completions",
      type: "openai",
      chat: [
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3.5-lightning:free",
        "stepfun/step-3.7-flash:free",
        "thinkingmachines/inkling:free",
      ],
      agent: [
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "cohere/north-mini-code:free",
        "poolside/laguna-s-2.1:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "stepfun/step-3.7-flash:free",
      ],
    },
    {
      id: "ovh",
      label: "OVHcloud AI",
      url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
      type: "openai",
      chat: ["gpt-oss-120b", "Qwen3-32B", "Meta-Llama-3_3-70B-Instruct"],
      agent: [
        "Qwen3-Coder-30B-A3B-Instruct",
        "gpt-oss-120b",
        "Qwen3-32B",
        "Meta-Llama-3_3-70B-Instruct",
      ],
    },
    {
      id: "pollinations",
      label: "Pollinations",
      url: "https://text.pollinations.ai/openai",
      type: "openai",
      reasoningOff: false,
      chat: ["openai-fast"],
      agent: ["openai-fast"],
    },
  ],
  limits: {
    chatMaxTokens: 4096,
    agentMaxTokens: 30000,
    firstTokenDeadlineMs: 45000,
    batchSize: 1,
    temperatureChat: 0.7,
    temperatureAgent: 0.3,
  },
};

let _rosterCache = { at: 0, data: null };

export function getRoster() {
  if (_rosterCache.data && Date.now() - _rosterCache.at < 5 * 60 * 1000) {
    return _rosterCache.data;
  }
  let data = FALLBACK_ROSTER;
  const candidates = ["brain/models.json", "Model/models.json"];
  for (const rel of candidates) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), ...rel.split("/")), "utf8")
      );
      if (parsed && Array.isArray(parsed.providers) && parsed.providers.length) {
        data = {
          providers: parsed.providers,
          limits: { ...FALLBACK_ROSTER.limits, ...(parsed.limits || {}) },
        };
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  _rosterCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------- cooldowns
const COOLDOWNS = new Map();

function cooled(key) {
  return (COOLDOWNS.get(key) || 0) > Date.now();
}
function cool(key, secs) {
  COOLDOWNS.set(key, Date.now() + secs * 1000);
  if (COOLDOWNS.size > 400) COOLDOWNS.clear();
}

// ---------------------------------------------------- reasoning-param memory
const REASONING_LOW = new Set();

function isReasoningMandatoryError(text) {
  const s = String(text || "").toLowerCase();
  return s.includes("reasoning is mandatory") || s.includes("cannot be disabled");
}

function reasoningParam(prov, model) {
  if (prov.reasoningOff === false) return null;
  return REASONING_LOW.has(`${prov.id}:${model}`) ? { effort: "low" } : { effort: "high" };
}

function buildBody(prov, model, base) {
  const body = { ...base, model };
  const r = reasoningParam(prov, model);
  if (r) body.reasoning = r;
  return body;
}

// ------------------------------------------------------------ streaming try
async function* streamOpenAI({ prov, model, body, signal }) {
  const res = await fetchTimeout(
    prov.url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(buildBody(prov, model, { ...body, stream: true })),
      signal,
    },
    60000
  );
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok || !ctype.includes("event-stream")) {
    const text = await res.text().catch(() => "");
    if (isReasoningMandatoryError(text)) throw new Error("reasoning-mandatory");
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
async function raceStreaming(prov, models, body, { deadlineMs, signal }, onDelta) {
  const ctrls = models.map(() => new AbortController());
  const onOuter = () => ctrls.forEach((c) => c.abort());
  if (signal) {
    if (signal.aborted) onOuter();
    else signal.addEventListener("abort", onOuter, { once: true });
  }
  const gens = models.map((m, i) =>
    streamOpenAI({ prov, model: m, body, signal: ctrls[i].signal })
  );
  const pending = new Map();
  gens.forEach((g, i) =>
    pending.set(
      i,
      g
        .next()
        .then((r) => ({ i, ok: !r.done && !!r.value, value: r.value, err: null }))
        .catch((e) => ({ i, ok: false, err: e?.message || "fail" }))
    )
  );
  const deadline = sleep(deadlineMs).then(() => ({ timeout: true }));
  const alive = new Set(models.map((_, i) => i));
  let winner = -1;
  let firstValue = "";
  const errs = [];
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
      if (res.err) errs.push(`${models[res.i]}:${res.err}`);
    }
    if (winner < 0) {
      const e = new Error(errs.join("|") || "no-winner");
      e.reasoningMandatory = errs.some((x) => x.includes("reasoning-mandatory"));
      throw e;
    }
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
async function completeOpenAI({ prov, model, body, signal, timeoutMs = 55000 }) {
  const res = await fetchTimeout(
    prov.url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(prov, model, { ...body, stream: false })),
      signal,
    },
    timeoutMs
  );
  const text = await res.text().catch(() => "");
  if (isReasoningMandatoryError(text)) throw new Error("reasoning-mandatory");
  if (isRateLimitPayload(res.status, text)) throw new Error("rate-limited");
  if (!res.ok) throw new Error(`http-${res.status}`);
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    const clean = text.trim();
    if (clean && !clean.startsWith("<")) return { text: clean, routedModel: model };
    throw new Error("bad-json");
  }
  if (d.error) throw new Error("api-error");
  const ans = extractAnswer(d.choices?.[0]?.message);
  if (!ans) throw new Error("empty");
  return { text: ans, routedModel: d.model || model };
}

// ------------------------------------------------------------------ engine
function modelsFor(prov, mode) {
  return (mode === "agent" ? prov.agent : prov.chat) || prov.chat || [];
}

function statusFor(prov, batch) {
  const names = batch.map(shortModel).join(", ");
  return `Connecting to ${prov.label} (${names})…`;
}

function shortModel(id) {
  return String(id).split("/").pop().replace(/:free$/, "");
}

function* splitChunks(text, size = 28) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/**
 * Generate an answer with the default engine.
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

  for (const prov of roster.providers) {
    const models = modelsFor(prov, mode);
    const usable = models.filter((m) => !cooled(`${prov.id}:${m}`));
    const list = usable.length ? usable : models;

    // 1) streaming attempts, strongest-first
    for (let i = 0; i < list.length; i += L.batchSize) {
      const batch = list.slice(i, i + L.batchSize);
      onStatus(statusFor(prov, batch));
      try {
        let collected = "";
        const win = await raceStreaming(
          prov,
          batch,
          body,
          { deadlineMs: L.firstTokenDeadlineMs, signal },
          (d) => {
            collected += d;
            onDelta(d);
          }
        );
        if (win && collected.trim()) {
          return { text: collected, providerLabel: prov.label, model: win.model };
        }
        batch.forEach((m) => cool(`${prov.id}:${m}`, 20));
      } catch (e) {
        errors.push(`${prov.id}/${batch.join(",")}: ${e.message}`);
        if (e.reasoningMandatory) {
          batch.forEach((m) => REASONING_LOW.add(`${prov.id}:${m}`));
          i -= L.batchSize;
          continue;
        }
        batch.forEach((m) =>
          cool(`${prov.id}:${m}`, /rate-limit/.test(e.message) ? 45 : 15)
        );
      }
    }

    // 2) non-stream fallback per model
    for (const m of list) {
      if (cooled(`${prov.id}:${m}`)) continue;
      onStatus(statusFor(prov, [m]));
      try {
        const r = await completeOpenAI({ prov, model: m, body, signal });
        for (const piece of splitChunks(r.text)) {
          onDelta(piece);
          await sleep(6);
        }
        return { text: r.text, providerLabel: prov.label, model: r.routedModel };
      } catch (e) {
        errors.push(`${prov.id}/${m}: ${e.message}`);
        if (e.message === "reasoning-mandatory") {
          REASONING_LOW.add(`${prov.id}:${m}`);
          try {
            const r2 = await completeOpenAI({ prov, model: m, body, signal });
            for (const piece of splitChunks(r2.text)) {
              onDelta(piece);
              await sleep(6);
            }
            return { text: r2.text, providerLabel: prov.label, model: r2.routedModel };
          } catch (e2) {
            errors.push(`${prov.id}/${m}(low): ${e2.message}`);
            cool(`${prov.id}:${m}`, e2.message === "rate-limited" ? 45 : 15);
          }
          continue;
        }
        cool(`${prov.id}:${m}`, e.message === "rate-limited" ? 45 : 15);
      }
    }
  }

  const err = new Error("all-providers-failed");
  err.details = errors.slice(-8);
  throw err;
}
