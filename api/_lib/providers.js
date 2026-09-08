// Provider chain for Professor Flash V1.
// Free, keyless OpenAI-compatible providers, read live from brain/models.json.
// Strategy: ordered attempts with the strongest brain model FIRST (quality
// over speed), then coding specialists, then cross-provider fallbacks —
// never leave the user with a dead-end.
//
// `engine` selects the thinking mode:
//  - "max"  -> reasoning: {effort:"high"} on the strongest brain slots; leaked
//              think spans are stripped by the streaming filter.
//  - "code" -> coding-tuned roster with reasoning off (or effort:low where the
//              model mandates reasoning).
// A few models MANDATE reasoning; those are auto-retried once with
// `reasoning:{effort:"low"}` and remembered.
//
// STACK MODE (ensemble fusion): instead of sending the same text separately
// to each model, the answer is built as a pipeline over the strongest brains:
//   Stage A (drafter)  -> produces the best full draft.
//   Stage B (refiner)  -> a second strong model re-reads the draft together
//                        with the original request and returns an improved
//                        final answer (correct errors, deepen reasoning,
//                        tighten prose). If the refiner fails, the draft stands.
// The models "stack": every stage sees and builds on the previous one's work,
// so their capabilities fuse into one answer rather than running in parallel
// isolation. Aggregation is sequential & depth-first to stay within free
// rate limits, while the user watches streamed deltas from the winning stage.

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
      brain: ["nvidia/nemotron-3-ultra-550b-a55b:free"],
      chat: [
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3.5-lightning:free",
        "stepfun/step-3.7-flash:free",
        "thinkingmachines/inkling:free",
      ],
      agent: [
        "cohere/north-mini-code:free",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
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
      brain: ["gpt-oss-120b"],
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
    stack: true,
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
const COOLDOWNS = new Map(); // key -> until ts

function cooled(key) {
  return (COOLDOWNS.get(key) || 0) > Date.now();
}
function cool(key, secs) {
  COOLDOWNS.set(key, Date.now() + secs * 1000);
  if (COOLDOWNS.size > 400) COOLDOWNS.clear();
}

// ---------------------------------------------------- reasoning-param memory
// Models that reject reasoning params ("mandatory") get effort:low.
const REASONING_LOW = new Set();

function isReasoningMandatoryError(text) {
  const s = String(text || "").toLowerCase();
  return s.includes("reasoning is mandatory") || s.includes("cannot be disabled");
}

function reasoningParam(prov, model, engine) {
  if (prov.reasoningOff === false) return null; // provider wants raw params
  if (engine === "max") {
    // quality-first: ask the strongest brain to actually think
    return REASONING_LOW.has(`${prov.id}:${model}`)
      ? { effort: "low" }
      : { effort: "high" };
  }
  return REASONING_LOW.has(`${prov.id}:${model}`)
    ? { effort: "low" }
    : { enabled: false };
}

function buildBody(prov, model, base, engine) {
  const body = { ...base, model };
  const r = reasoningParam(prov, model, engine);
  if (r) body.reasoning = r;
  return body;
}

// ------------------------------------------------------------ streaming try
/**
 * One streaming attempt. Yields content deltas only (reasoning dropped).
 * Throws before first yield when the provider fails / is rate-limited.
 */
async function* streamOpenAI({ prov, model, body, engine, signal }) {
  const res = await fetchTimeout(
    prov.url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(buildBody(prov, model, { ...body, stream: true }, engine)),
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
async function raceStreaming(prov, models, body, { deadlineMs, signal, engine }, onDelta) {
  const ctrls = models.map(() => new AbortController());
  const onOuter = () => ctrls.forEach((c) => c.abort());
  if (signal) {
    if (signal.aborted) onOuter();
    else signal.addEventListener("abort", onOuter, { once: true });
  }
  const gens = models.map((m, i) =>
    streamOpenAI({ prov, model: m, body, engine, signal: ctrls[i].signal })
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
async function completeOpenAI({ prov, model, body, engine, signal, timeoutMs = 55000 }) {
  const res = await fetchTimeout(
    prov.url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(prov, model, { ...body, stream: false }, engine)),
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
function modelsFor(prov, mode, engine) {
  if (engine === "max" && Array.isArray(prov.brain) && prov.brain.length) return prov.brain;
  return (mode === "agent" ? prov.agent : prov.chat) || prov.chat || [];
}

function statusFor(prov, batch) {
  const names = batch.map(shortModel).join(" ، ");
  return `اتصال به ${prov.label} (${names})…`;
}

function shortModel(id) {
  return String(id).split("/").pop().replace(/:free$/, "");
}

function* splitChunks(text, size = 28) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/** Core single-pass generation used by both stack stages and plain mode. */
async function onePass({ messages, mode, engine, roster, signal, onDelta, onStatus }) {
  const L = roster.limits;
  const maxTokens = mode === "agent" ? L.agentMaxTokens : L.chatMaxTokens;
  const temperature = mode === "agent" ? L.temperatureAgent : L.temperatureChat;
  const body = { messages, temperature, max_tokens: maxTokens };
  const errors = [];

  for (const prov of roster.providers) {
    const models = modelsFor(prov, mode, engine);
    const usable = models.filter((m) => !cooled(`${prov.id}:${m}`));
    const list = usable.length ? usable : models; // all cooled -> try anyway

    // 1) streaming attempts, ordered strongest-first (batch = 1 -> quality first)
    for (let i = 0; i < list.length; i += L.batchSize) {
      const batch = list.slice(i, i + L.batchSize);
      onStatus(statusFor(prov, batch));
      try {
        let collected = "";
        const win = await raceStreaming(
          prov,
          batch,
          body,
          { deadlineMs: L.firstTokenDeadlineMs, signal, engine },
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
        if (e.reasoningMandatory && prov.reasoningOff !== false) {
          // remember & immediately retry this batch with effort:low
          batch.forEach((m) => REASONING_LOW.add(`${prov.id}:${m}`));
          i -= L.batchSize;
          continue;
        }
        batch.forEach((m) =>
          cool(`${prov.id}:${m}`, /rate-limit/.test(e.message) ? 45 : 15)
        );
      }
    }

    // 2) non-stream fallback per model (some providers only do non-stream)
    for (const m of list) {
      if (cooled(`${prov.id}:${m}`)) continue;
      onStatus(statusFor(prov, [m]));
      try {
        const r = await completeOpenAI({ prov, model: m, body, engine, signal });
        for (const piece of splitChunks(r.text)) {
          onDelta(piece);
          await sleep(6);
        }
        return { text: r.text, providerLabel: prov.label, model: r.routedModel };
      } catch (e) {
        errors.push(`${prov.id}/${m}: ${e.message}`);
        if (e.message === "reasoning-mandatory" && prov.reasoningOff !== false) {
          REASONING_LOW.add(`${prov.id}:${m}`);
          try {
            const r2 = await completeOpenAI({ prov, model: m, body, engine, signal });
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

const REFINE_SYSTEM =
  "You are the Refiner stage of the Professor Stack. You receive a draft " +
  "answer that another strong model produced for the user's request, " +
  "together with the original conversation. Your job: return the FINAL answer " +
  "the user deserves. Fix any errors, factual slips, or inconsistencies in " +
  "the draft; deepen the reasoning where it is shallow; tighten the language; " +
  "keep the good parts. Preserve the user's language exactly (Persian in -> " +
  "Persian out). Do not add meta commentary about drafts or stages — emit " +
  "only the final answer itself, ready to send to the user. If the draft is " +
  "already excellent, improve its clarity and precision and return it.";

/**
 * Generate an answer. Calls onDelta(text) as content streams in and
 * onStatus(faText) as the engine moves through providers/stages.
 * Returns { text, providerLabel, model, stacked }.
 *
 * STACK MODE (when roster.limits.stack && mode === "chat" && engine === "max"):
 * stage 1 = strongest brain drafts (streamed live to the user),
 * stage 2 = a second strong brain refines; the user's message bubble is
 * replaced with the refined final. If stage 2 fails, stage 1's answer stands.
 */
export async function generateAnswer({
  messages,
  mode = "chat",
  engine = "max",
  signal,
  onDelta = () => {},
  onStatus = () => {},
  onReplace = null, // stack stage-2 hook: clears the streamed draft from UI
}) {
  const roster = getRoster();
  const L = roster.limits;
  const useStack =
    !!L.stack && mode === "chat" && engine === "max" && typeof onReplace === "function";

  if (!useStack) {
    return onePass({ messages, mode, engine, roster, signal, onDelta, onStatus });
  }

  // ---- Stage A: drafter (strongest brain)
  onStatus("پروفسور در حال تدوین پاسخ است…");
  const draft = await onePass({
    messages,
    mode,
    engine,
    roster,
    signal,
    onDelta,
    onStatus,
  });

  // ---- Stage B: refiner (second strong brain, cross-provider preferred)
  try {
    onStatus("پروفسور پاسخ را بازبینی و تقویت می‌کند…");
    const refineMessages = [
      { role: "system", content: REFINE_SYSTEM },
      ...messages,
      {
        role: "assistant",
        content:
          "DRAFT ANSWER (from the first reasoning stage):\n\n" +
          draft.text.slice(0, 20000),
      },
      {
        role: "user",
        content:
          "Return the FINAL improved answer now. Same language as the draft. " +
          "Emit only the final answer.",
      },
    ];

    let collected = "";
    let firstChunk = true;
    const refined = await onePass({
      messages: refineMessages,
      mode,
      engine: "max",
      roster,
      signal,
      onStatus,
      onDelta: (d) => {
        if (firstChunk) {
          firstChunk = false;
          onReplace(); // swap the draft bubble for the refined stream
        }
        collected += d;
        onDelta(d); // stream the refined answer to the user
      },
    });

    if (collected.trim().length > 40) {
      return {
        text: refined.text,
        providerLabel: draft.providerLabel + " + " + refined.providerLabel,
        model: "professor-stack",
        stacked: true,
      };
    }
    // too short to trust as a refinement -> replay the draft
    onReplace();
    for (const piece of splitChunks(draft.text)) {
      onDelta(piece);
      await sleep(6);
    }
    return { ...draft, stacked: false };
  } catch {
    // refiner failed entirely -> replay the draft so the bubble isn't empty
    try {
      onReplace();
      for (const piece of splitChunks(draft.text)) {
        onDelta(piece);
        await sleep(4);
      }
    } catch {
      /* client gone */
    }
    return { ...draft, stacked: false };
  }
}
