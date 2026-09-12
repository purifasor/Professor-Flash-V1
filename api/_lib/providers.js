// Provider chain for Professor AI (default engine).
// Roster v3 — priority chain read live from brain/models.json:
//   1) OVH Qwen3.5-397B-A17B (default) 2) Kilo Nemotron-3-Ultra-550B
//   3) Kilo InclusionAI Ling-3.0 → emergency relay.
//
// Engine hardening for slow/queued providers (Nemotron-Ultra can queue for
// minutes behind "KILO PROCESSING" SSE comments):
//  - streaming requests only; SSE comment lines (": KILO PROCESSING") keep
//    the connection alive and are skipped while waiting for real deltas
//  - first-token deadlines are long (queue-tolerant) and per-mode: agent
//    builds can wait far longer than chat turns
//  - per-attempt timeouts + cooldowns so a stuck provider never blocks the
//    chain; the next model takes over mid-flight
//  - a stream that dies mid-answer keeps what was collected; the pipeline
//    repair passes (chat.js) resumes from it — no total loss
//  - models that reject reasoning params are remembered and retried with
//    effort:low automatically

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolve a repo-root-relative path both locally and on Vercel (bundled). */
function rootPath(rel) {
  // when bundled, cwd is the function root and brain/ is included there
  const viaCwd = path.join(process.cwd(), ...rel.split("/"));
  if (fs.existsSync(viaCwd)) return viaCwd;
  // dev / repo checkout: api/_lib → two levels up
  return path.join(HERE, "..", "..", ...rel.split("/"));
}

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
      label: "Professor Core",
      url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
      type: "openai",
      chat: ["Qwen3.5-397B-A17B"],
      agent: ["Qwen3.5-397B-A17B"],
    },
    {
      id: "kilo",
      label: "Professor Prime",
      url: "https://api.kilo.ai/api/gateway/chat/completions",
      type: "openai",
      chat: ["nvidia/nemotron-3-ultra-550b-a55b:free", "inclusionai/ling-3.0-flash-sante:free"],
      agent: ["nvidia/nemotron-3-ultra-550b-a55b:free", "inclusionai/ling-3.0-flash-sante:free"],
    },
    {
      id: "pollinations",
      label: "Professor Relay",
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
    firstTokenDeadlineChatMs: 90000,
    firstTokenDeadlineAgentMs: 240000,
    batchSize: 1,
    temperatureChat: 0.3,
    temperatureAgent: 0.3,
    rateLimitCooldownS: 90,
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
      const parsed = JSON.parse(fs.readFileSync(rootPath(rel), "utf8"));
      if (parsed && Array.isArray(parsed.providers) && parsed.providers.length) {
        data = {
          providers: parsed.providers,
          options: Array.isArray(parsed.options) ? parsed.options : [],
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
// SSE stream reader that:
//  - skips comment lines (": KILO PROCESSING" keepalives)
//  - waits for the FIRST real content delta before enforcing the
//    first-token deadline (queue-wait doesn't count against generation)
//  - tolerates a dead stream mid-answer (returns what it collected)
async function* streamOpenAI({ prov, model, body, signal, firstTokenDeadlineMs, onQueueStatus }) {
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
  let gotFirst = false;
  let firstAt = 0;
  let queuePings = 0;

  for (;;) {
    // once tokens flow, keep reading until the stream ends (generation can
    // take minutes for 30000-token agent builds — no mid-answer timeout)
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
      if (!t) continue;
      if (t.startsWith(":")) {
        // SSE comment — provider keepalive (e.g. "KILO PROCESSING")
        queuePings++;
        if (onQueueStatus && queuePings % 8 === 1) onQueueStatus();
        continue;
      }
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
        if (!gotFirst) {
          gotFirst = true;
          firstAt = Date.now();
        }
        const clean = filter.push(piece);
        if (clean) yield clean;
      }
    }
  }
  const tail = filter.flush();
  if (tail) yield tail;
}

// Try ONE model streaming to completion. Returns { model, text } or throws.
async function tryStreaming(prov, model, body, { firstTokenDeadlineMs, signal, onDelta, onStatus }) {
  let collected = "";
  const gen = streamOpenAI({
    prov,
    model,
    body,
    signal,
    firstTokenDeadlineMs,
    onQueueStatus: () =>
      onStatus(`Model ${shortModel(model)} is processing (queued) — holding the line…`),
  });
  try {
    for await (const d of gen) {
      collected += d;
      onDelta(d);
    }
  } catch (e) {
    // mid-answer death: if we already have substantial content, keep it —
    // the agent repair passes will resume; otherwise it's a real failure
    if (collected.trim().length > 400) {
      return { model, text: collected, partial: true };
    }
    throw e;
  }
  if (!collected.trim()) throw new Error("empty");
  return { model, text: collected };
}

// ---------------------------------------------------------- non-stream try
async function completeOpenAI({ prov, model, body, signal, timeoutMs = 90000 }) {
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

// ---------------------------------------------------- parallel race engine
/**
 * Race every (provider, model) candidate: start all streams at once, wait
 * for the FIRST real content token; abort the losers and let the winner
 * finish. Returns the completed result or null if every racer failed
 * before any token arrived.
 */
const _racedThisCall = new Set(); // per-call guard (reset each invocation)

function racedTried(key) {
  return _racedThisCall.has(key);
}

async function raceFirstToken({ providersOrdered, body, firstDeadline, signal, onDelta, onStatus, errors }) {
  _racedThisCall.clear();
  const racers = [];
  for (const { prov, models } of providersOrdered) {
    for (const m of models) {
      if (cooled(`${prov.id}:${m}`)) continue;
      racers.push({ prov, m, key: `${prov.id}:${m}` });
    }
  }
  if (!racers.length) return null;

  const outerCtrl = new AbortController();
  const forwardAbort = () => outerCtrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  // per-racer stop handles; the winner kills every loser, the winner itself
  // keeps streaming to completion
  const stops = new Map(); // key → () => abort that racer only
  let winnerKey = null;

  const attempts = racers.map(({ prov, m, key }) => {
    _racedThisCall.add(key);
    const myCtrl = new AbortController();
    stops.set(key, () => myCtrl.abort(new Error("race-lost")));
    outerCtrl.signal.addEventListener("abort", () => myCtrl.abort(new Error("race-lost")), { once: true });

    return (async () => {
      let collected = "";
      let first = false;
      const gen = streamOpenAI({
        prov,
        model: m,
        body,
        signal: myCtrl.signal,
        firstTokenDeadlineMs: Math.min(firstDeadline, 45000), // race window
        onQueueStatus: () => onStatus(`Model ${shortModel(m)} queued — others still racing…`),
      });
      for await (const d of gen) {
        if (!first) {
          first = true;
          if (winnerKey === null) {
            winnerKey = key;
            onStatus(`Answering on ${prov.label} (${shortModel(m)})…`);
            for (const [k, stop] of stops) {
              if (k !== winnerKey) stop(); // kill the losers
            }
          }
          if (winnerKey !== key) return null; // lost the race (already aborted)
        }
        collected += d;
        onDelta(d);
      }
      if (!collected.trim()) throw new Error("empty");
      return { text: collected, providerLabel: prov.label, model: m };
    })().catch((e) => {
      if (e?.message === "race-lost" || myCtrl.signal.aborted) return null;
      errors.push(`race ${prov.id}/${m}: ${e.message}`);
      cool(`${prov.id}:${m}`, /rate-limit|http-429/.test(e.message) ? 20 : 8);
      return null;
    });
  });

  const settled = await Promise.all(attempts);
  if (signal) signal.removeEventListener("abort", forwardAbort);
  const win = settled.find((r) => r && r.text && r.text.trim());
  if (win) return { ...win, partial: false };
  return null; // everyone stalled — caller runs the sequential chain
}

// ------------------------------------------------------------------ engine
function modelsFor(prov, mode) {
  return (mode === "agent" ? prov.agent : prov.chat) || prov.chat || [];
}

function shortModel(id) {
  return String(id).split("/").pop().replace(/:free$/, "");
}

function* splitChunks(text, size = 28) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/**
 * Generate an answer with the default engine (priority chain).
 * `preferredModel` pins the chat to the model that answered its first
 * message — a conversation started on Qwen stays on Qwen (memory stays
 * coherent); the chain is only used when the pinned model is unavailable.
 * Returns { text, providerLabel, model }.
 */
export async function generateAnswer({
  messages,
  mode = "chat",
  signal,
  onDelta = () => {},
  onStatus = () => {},
  preferredModel = "",
}) {
  const roster = getRoster();
  const L = roster.limits;
  const maxTokens = mode === "agent" ? L.agentMaxTokens : L.chatMaxTokens;
  const temperature = mode === "agent" ? L.temperatureAgent : L.temperatureChat;
  const body = { messages, temperature, max_tokens: maxTokens };
  const firstDeadline =
    mode === "agent"
      ? L.firstTokenDeadlineAgentMs || 240000
      : L.firstTokenDeadlineChatMs || 90000;
  const cooldownS = L.rateLimitCooldownS || 90;
  const errors = [];

  // Priority: Qwen → NVIDIA Nemotron → Ling (roster order). When the chat
  // already has a pinned model, its PROVIDER goes first and the model goes
  // first within that provider — the conversation keeps its engine (and
  // the continuity of its reasoning) while the chain stays as fallback.
  // Match tolerantly: the client sends the short form (e.g.
  // "ling-3.0-flash-sante" or "ling-3.0-flash-sante:free") of a roster id
  // like "inclusionai/ling-3.0-flash-sante:free".
  const wanted = String(preferredModel || "").trim().toLowerCase();
  const matchesPin = (m) => {
    if (!wanted) return false;
    const full = m.toLowerCase();
    const short = full.split("/").pop();
    return full === wanted || short === wanted ||
      short.replace(/:free$/, "") === wanted.replace(/:free$/, "");
  };
  const providersOrdered = roster.providers
    .map((prov) => {
      const models = modelsFor(prov, mode);
      if (!wanted) return { prov, models, pinned: false };
      const pinned = models.filter(matchesPin);
      const rest = models.filter((m) => !matchesPin(m));
      return { prov, models: [...pinned, ...rest], pinned: pinned.length > 0 };
    })
    .filter((p) => p.models.length)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)); // pinned provider first

  // ---- RACE MODE: start streams to every candidate model in parallel;
  // the FIRST one to deliver a real token wins, all others are aborted.
  // This kills the "queued for 4 minutes while a free model sat idle"
  // failure mode — the user gets the fastest engine that's actually up.
  // (Sequential chain stays as the fallback when every racer stalls.)
  const raced = await raceFirstToken({
    providersOrdered,
    body,
    firstDeadline,
    signal,
    onDelta,
    onStatus,
    errors,
  });
  if (raced) return raced;

  // ---- sequential fallback (racing failed for every candidate) ----
  for (const { prov, models } of providersOrdered) {
    const usable = models.filter((m) => !cooled(`${prov.id}:${m}`));
    const list = usable.length ? usable : models;

    for (const m of list) {
      if (racedTried(`${prov.id}:${m}`)) continue; // already raced & lost
      onStatus(`Connecting to ${prov.label} (${shortModel(m)})…`);
      try {
        const win = await tryStreaming(prov, m, body, {
          firstTokenDeadlineMs: firstDeadline,
          signal,
          onDelta,
          onStatus,
        });
        if (win && win.text.trim()) {
          return {
            text: win.text,
            providerLabel: prov.label,
            model: win.model,
            partial: !!win.partial,
          };
        }
        cool(`${prov.id}:${m}`, 15);
      } catch (e) {
        errors.push(`${prov.id}/${m}: ${e.message}`);
        if (e.reasoningMandatory) {
          REASONING_LOW.add(`${prov.id}:${m}`);
          continue;
        }
        cool(`${prov.id}:${m}`, /rate-limit|http-429/.test(e.message) ? cooldownS : 15);
      }
    }

    // non-stream fallback per model
    for (const m of list) {
      if (cooled(`${prov.id}:${m}`)) continue;
      onStatus(`Connecting to ${prov.label} (${shortModel(m)})…`);
      try {
        const r = await completeOpenAI({ prov, model: m, body, signal });
        for (const piece of splitChunks(r.text)) {
          onDelta(piece);
          await sleep(6);
        }
        return { text: r.text, providerLabel: prov.label, model: r.routedModel };
      } catch (e) {
        errors.push(`${prov.id}/${m}(ns): ${e.message}`);
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
          }
          continue;
        }
        cool(`${prov.id}:${m}`, e.message === "rate-limited" ? cooldownS : 15);
      }
    }
  }

  const err = new Error("all-providers-failed");
  err.details = errors.slice(-8);
  throw err;
}
