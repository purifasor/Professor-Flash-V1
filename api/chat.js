// POST /api/chat — SSE streaming chat endpoint (modes: chat | agent).
// v5: staged agent pipeline (analyze → plan → map → build) with sub-agent
// framing, user custom-provider routing, live data + ALWAYS-ON web search,
// keepalive pings, and contract-repair passes so long builds NEVER freeze.
//
// Anti-freeze strategy:
//  - one warm-up context pass defines the plan; each build pass is a
//    focused continuation, not a giant single completion
//  - SSE pings every 15s keep proxies from killing silent connections
//  - CONTINUE:/truncation auto-repairs resume exactly where the model
//    stopped, so a dropped token never kills the project
//  - news questions get Google News headlines injected (24h awareness)
//
// Web search is ALWAYS ON for the default engine (the user-facing toggle
// was removed by design): each chat turn quietly checks whether fresh web
// context helps and injects it when found. MAX thinking is the only mode.

import { generateAnswer, getRoster, stripReasoningPreamble } from "./_lib/providers.js";
import { chatSystemPrompt, agentSystemPrompt, filesContextMessage } from "./_lib/brain.js";
import { searchWeb, searchContext, newsHeadlines, newsContext } from "./_lib/search.js";
import { gatherLiveData } from "./_lib/tools.js";
import { streamRemote } from "./_lib/remote.js";
import { currentUser } from "./_lib/auth.js";
import { listModels } from "./_lib/db.js";
import { sseSend, sleep } from "./_lib/util.js";

const MAX_HISTORY = 16;
const MAX_MSG_CHARS = 12000;
const MAX_TOTAL_CHARS = 60000;
// agent follow-ups keep more history so the model remembers the project
const MAX_HISTORY_AGENT = 24;

// questions where live web context clearly beats model memory
const NEEDS_WEB =
  /(news|اخبار|headline|چند ساعت پیش|24 ساعت|ساعت پیش|دیروز|yesterday|today|امروز چه|latest|newest|recent|fresh|جديد|جدید|تازه|الان|right now|current|who won|score|نتیجه|earthquake|زلزله|آتش سوزی|الحاق|ترکیه|explosion|انفجار|attack|حمله|war|جنگ|fired|استعفا|died|درگذشت|killed|election|انتخابات|released|انتشار|announcement|breach|dow jones|s&p|ناسداک|nasdaq|stock)/i;
// news-specific (get the RSS headlines instead of a plain search)
const NEEDS_NEWS =
  /(اخبار|news|headline|headlines|24 ساعت گذشته|ساعت گذشته|چی شده|what happened|چه اتفاقی|کی الان الان|latest news|today'?s news|دیروز چه|امروز چه)/i;

function sanitizeMessages(raw, mode) {
  if (!Array.isArray(raw)) return [];
  const max = mode === "agent" ? MAX_HISTORY_AGENT : MAX_HISTORY;
  const msgs = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  const tail = msgs.slice(-max);
  let total = 0;
  const out = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    total += tail[i].content.length;
    if (total > MAX_TOTAL_CHARS) break;
    out.unshift(tail[i]);
  }
  return out;
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === "object") return req.body;
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

/** Parse ```file:path blocks from agent output (for completeness checks). */
function parseFileBlocks(text) {
  const out = [];
  const re = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) out.push({ path: m[1].trim(), content: m[2] });
  const tail = /```file:([^\n`]+)\n([\s\S]*)$/.exec(
    text.replace(/```file:[^\n`]+\n[\s\S]*?```/g, "")
  );
  if (tail) out.push({ path: tail[1].trim(), content: tail[2], truncated: true });
  return out;
}

const isEmptyFile = (f) => !f.content || f.content.replace(/\s/g, "").length < 5;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method-not-allowed" });
    return;
  }

  const body = await readBody(req);
  const mode = body.mode === "agent" ? "agent" : "chat";
  const messages = sanitizeMessages(body.messages, mode);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    res.status(400).json({ error: "no-user-message" });
    return;
  }
  // Model pinning: the conversation keeps the model it started with (e.g.
  // a chat that began on Qwen stays on Qwen) so its reasoning stays coherent.
  const preferredModel = typeof body.preferredModel === "string" ? body.preferredModel.slice(0, 120) : "";
  // Engine selection from the model picker: values look like "engine:<id>"
  // (e.g. engine:nemotron-ultra). Resolved against roster.options — the user
  // picks a MODEL and that exact engine goes FIRST in the chain, with the
  // rest of the roster kept as automatic fallback.
  const selRaw = String(body.provider || "").trim();
  const isEngineSel = selRaw.startsWith("engine:");
  let engineModel = "";
  if (isEngineSel) {
    const selId = selRaw.slice("engine:".length);
    const opts = getRoster().options || [];
    const opt = opts.find((o) => o && o.id === selId);
    engineModel = opt ? (mode === "agent" ? opt.agent || opt.chat : opt.chat || opt.agent) || "" : selId;
  }
  const effPref = engineModel || preferredModel;
  // Auto-resume: the client detected a dropped stream and sends the partial
  // answer so the engine continues from the exact cutoff point.
  const resumePartial = typeof body.partial === "string" ? body.partial.slice(0, 8000) : "";
  const isResume = body.resume === true && resumePartial.trim().length > 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const abort = new AbortController();
  req.on("close", () => abort.abort());
  const pinger = setInterval(() => sseSend(res, { type: "ping" }), 15000);

  const status = (text) => sseSend(res, { type: "status", text });
  const delta = (text) => sseSend(res, { type: "delta", text });
  // a NEW chat bubble per agent pipeline pass — keeps the feed ordered:
  // each pass (analysis → build → continue → repair) lands as its own
  // message under the user's prompt instead of one giant blob
  const passStart = (label) => sseSend(res, { type: "pass", label: label || "" });

  try {
    const lastUser = messages[messages.length - 1].content;
    const user = currentUser(req);

    // ---------- custom provider (user's own model) ----------
    let custom = null;
    if (user && !isEngineSel) {
      const saved = await listModels(user.folder).catch(() => []);
      // Use a custom provider ONLY when the user explicitly selected one for
      // this conversation (body.provider). An empty selection ALWAYS means
      // the default Professor engine — never silently fall back to the
      // first active custom provider, which ignored the user's Default pick.
      const wanted = selRaw;
      const rec = wanted
        ? saved.find((p) => p.name === wanted || p.modelId === wanted)
        : null;
      if (rec) custom = rec;
    }

    const finalMessages = [];

    const runCustomProvider = async () => {
      // Custom provider path: same brain, user's engine, direct streaming.
      const sys = mode === "agent" ? agentSystemPrompt() : chatSystemPrompt(lastUser);
      const msgs = [{ role: "system", content: sys }];

      // SPEED: fire the user's model IMMEDIATELY; live data + web search
      // only run for questions that clearly need them (news/current facts).
      // A simple question must not wait on network fetches.
      if (mode === "chat" && (NEEDS_WEB.test(lastUser) || NEEDS_NEWS.test(lastUser))) {
        try {
          const live = await gatherLiveData(lastUser);
          if (live) msgs.push({ role: "system", content: live });
        } catch { /* best-effort */ }
        try {
          const searchData = await searchWeb(lastUser);
          const ctx = searchContext(searchData);
          if (ctx) msgs.push({ role: "system", content: ctx });
        } catch { /* best-effort */ }
      }

      if (mode === "agent") {
        const filesCtx = filesContextMessage(body.files);
        if (filesCtx) msgs.push({ role: "system", content: filesCtx });
        if (Array.isArray(body.errors) && body.errors.length) {
          msgs.push({
            role: "system",
            content:
              "RUNTIME ERRORS captured in the user's live preview. Run the debugging " +
              "protocol: locate the root cause, fix it (not the symptom), and re-emit " +
              "the fixed file(s) in full:\n" +
              body.errors.filter((e) => typeof e === "string").slice(0, 8)
                .map((e) => "- " + e.slice(0, 300)).join("\n"),
          });
        }
      }
      msgs.push(...messages);

      let collected = "";
      // Some custom providers reject the FIRST request (cold start, auth
      // lag, rate window) but succeed on an immediate retry — retry once
      // on empty before falling back to the default engine.
      const streamWithRetry = async (opts, onDelta) => {
        try {
          return await streamRemote(opts, onDelta);
        } catch (e) {
          const msg = String(e?.message || "");
          const retryable =
            msg.includes("provider-empty") || msg.includes("first-token-timeout") ||
            msg.includes("provider-http-429") || msg.includes("provider-http-502") ||
            msg.includes("provider-http-503");
          if (!retryable) throw e;
          status("Provider hiccup — retrying…");
          return await streamRemote(opts, onDelta); // one silent retry
        }
      };
      try {
        await streamWithRetry(
          {
            baseUrl: custom.baseUrl,
            apiKey: custom.apiKey,
            modelId: custom.modelId,
            messages: msgs,
            temperature: mode === "agent" ? 0.3 : 0.5,
            maxTokens: mode === "agent" ? 30000 : 4096,
            signal: abort.signal,
          },
          (d) => { collected += d; delta(d); }
        );
        // agent contract repair passes on custom providers too
        if (mode === "agent") {
          let text = collected;
          for (let pass = 0; pass < 3; pass++) {
            const blocks = parseFileBlocks(text);
            const bad = blocks.filter((b) => isEmptyFile(b) || b.truncated);
            const wantsContinue = /(^|\n)\s*CONTINUE:\s*$/i.test(text.trim());
            if (!bad.length && !wantsContinue) break;
            status(wantsContinue ? "Continuing the build…" : "Completing files…");
            passStart(wantsContinue ? "Continue" : "Repair");
            let repair = "";
            await streamWithRetry(
              {
                baseUrl: custom.baseUrl,
                apiKey: custom.apiKey,
                modelId: custom.modelId,
                messages: [
                  ...msgs,
                  { role: "assistant", content: text },
                  {
                    role: "user",
                    content: wantsContinue
                      ? "CONTINUE from EXACTLY where you stopped. Never restart, never repeat finished files."
                      : "These files were empty or cut off: " +
                        [...new Set(bad.map((b) => b.path))].join(", ") +
                        ". Re-emit each COMPLETELY as ```file: blocks.",
                  },
                ],
                temperature: 0.3,
                maxTokens: 30000,
                signal: abort.signal,
              },
              (d) => { repair += d; collected += d; delta(d); }
            );
            text = collected;
            if (!repair.trim()) break; // provider gave nothing — stop looping
          }
        }
        sseSend(res, {
          type: "done",
          provider: custom.name,
          model: custom.modelId,
          search: null,
        });
        return true; // success — the default engine is not needed
      } catch (e) {
        // The user's provider failed. If we already streamed a substantial
        // partial answer, KEEP it (mark done with a resume hint) instead of
        // wiping the turn with a fallback restart — the client auto-resumes.
        if (collected.trim().length > 400) {
          sseSend(res, { type: "done", provider: custom.name, model: custom.modelId, search: null });
          return true;
        }
        // Otherwise: never dead-end the conversation — fall back to the
        // default Professor engine chain so the user ALWAYS gets an answer.
        status(`Your provider failed (${String(e.message || e).slice(0, 80)}) — switching to the default engine…`);
        return false;
      }
    };

    if (custom && (await runCustomProvider())) return;

    // ---------- default Professor engine ----------
    const sys = mode === "agent" ? agentSystemPrompt() : chatSystemPrompt(lastUser);
    finalMessages.push({ role: "system", content: sys });

    // live data (prices/gold/time) — auto-detected from the question
    try {
      const live = await gatherLiveData(lastUser);
      if (live) finalMessages.push({ role: "system", content: live });
    } catch { /* best-effort */ }

    // Web search for chat mode: only for news/current-event questions —
    // simple questions answer instantly without waiting on web fetches.
    let searchData = null;
    if (mode === "chat" && !isResume) {
      try {
        if (NEEDS_NEWS.test(lastUser)) {
          status("Checking the latest news…");
          const items = await newsHeadlines("", 14).catch(() => []);
          const ctxN = newsContext(items, "top stories, last 24h");
          if (ctxN) finalMessages.push({ role: "system", content: ctxN });
        } else if (NEEDS_WEB.test(lastUser)) {
          status("Searching the web…");
          searchData = await searchWeb(lastUser);
          const ctx = searchContext(searchData);
          if (ctx) finalMessages.push({ role: "system", content: ctx });
        }
      } catch { /* best-effort */ }
    }

    if (mode === "agent") {
      const filesCtx = filesContextMessage(body.files);
      if (filesCtx) finalMessages.push({ role: "system", content: filesCtx });

      if (Array.isArray(body.errors) && body.errors.length) {
        finalMessages.push({
          role: "system",
          content:
            "RUNTIME ERRORS captured in the user's live preview. Run the debugging " +
            "protocol: locate the root cause, fix it (not the symptom), and re-emit " +
            "the fixed file(s) in full:\n" +
            body.errors.filter((e) => typeof e === "string").slice(0, 8)
              .map((e) => "- " + e.slice(0, 300)).join("\n"),
        });
      }
    }

    finalMessages.push(...messages);

    // Resume a dropped stream: inject the partial answer as an assistant
    // turn and ask for the continuation from the exact cutoff.
    if (isResume) {
      finalMessages.push({ role: "assistant", content: resumePartial });
      finalMessages.push({
        role: "user",
        content:
          "Your previous answer was cut off right at the point above (connection " +
          "dropped). CONTINUE from EXACTLY where you stopped. Do NOT restart, do " +
          "NOT repeat what was already written, do NOT apologize. Continue the " +
          "answer/build seamlessly to completion" +
          (mode === "agent" ? " and finish with SUMMARY:." : "."),
      });
      status("Resuming the interrupted answer…");
    }

    let result = await generateAnswer({
      messages: finalMessages,
      mode,
      signal: abort.signal,
      onDelta: delta,
      onStatus: status,
      preferredModel: effPref,
    });

    // CHAT only: some free engines preface the answer with their working
    // notes as plain text. After the stream completes, one clean re-render of
    // the final answer removes that preamble (the raw stream already showed
    // to the user stays untouched — this only affects what lands in history
    // files). Agent output NEVER passes through (it carries ```file: blocks).
    if (mode === "chat" && result?.text && !/```/.test(result.text)) {
      const cleaned = stripReasoningPreamble(result.text);
      if (cleaned && cleaned !== result.text) {
        result.text = cleaned;
        // repaint the final bubble with the clean answer (client replaces
        // the bubble content on this event)
        sseSend(res, { type: "replace", text: cleaned });
      }
    }

    // ---- Agent staged pipeline (autopilot: keeps going until complete) ----
    if (mode === "agent") {
      let pass = 0;
      const maxPasses = 8;
      let selfTested = false;

      while (pass < maxPasses) {
        pass++;
        // pacing between pipeline passes: back-to-back requests against
        // the same free-tier model burst the rate cache — a short breath
        // keeps the autopilot running instead of slamming a 429 wall.
        if (pass > 1) await sleep(1500);
        const blocks = parseFileBlocks(result.text);
        const hasComplete = blocks.some((b) => !b.truncated);
        const bad = blocks.filter((b) => isEmptyFile(b) || b.truncated);
        const wantsContinue = /(^|\n)\s*CONTINUE:\s*$/i.test(result.text.trim());

        // A) analysis-only answer (no files yet) → orchestrate the build
        if (!hasComplete && !wantsContinue && pass === 1) {
          status("Planning build — dispatching sub-agents…");
          passStart("Build");
          const buildMsgs = [
            ...finalMessages,
            { role: "assistant", content: result.text },
            {
              role: "user",
              content:
                "Plan approved. EXECUTE now — Stage 4 BUILD: dispatch your sub-agents " +
                "and emit the complete project as ```file:<path> blocks (entry " +
                "index.html, every file complete, zero dead UI). Finish with SUMMARY:.",
            },
          ];
          result = await generateAnswer({
            messages: buildMsgs,
            mode,
            signal: abort.signal,
            onDelta: delta,
            onStatus: status,
            preferredModel: effPref,
          });
          continue;
        }

        // B) token-budget stop → resume exactly where it stopped
        if (wantsContinue) {
          status("Continuing the build…");
          passStart("Continue");
          const lastBlock = blocks[blocks.length - 1];
          const cont = await generateAnswer({
            preferredModel: effPref,
            messages: [
              ...finalMessages,
              { role: "assistant", content: result.text },
              {
                role: "user",
                content:
                  "CONTINUE the project from EXACTLY where you stopped. " +
                  (lastBlock?.path ? `You were in/near \`${lastBlock.path}\`. ` : "") +
                  "Do NOT restart, do NOT repeat completed files. Continue the remaining " +
                  "```file:<path> blocks to completion, then SUMMARY:.",
              },
            ],
            mode,
            signal: abort.signal,
            onDelta: delta,
            onStatus: status,
          });
          result = { ...cont, text: result.text + "\n\n" + cont.text };
          continue;
        }

        // C) empty/truncated files → repair pass
        if (bad.length) {
          const list = [...new Set(bad.map((b) => b.path))];
          status("Repairing incomplete files…");
          passStart("Repair");
          const fill = await generateAnswer({
            preferredModel: effPref,
            messages: [
              ...finalMessages,
              { role: "assistant", content: result.text },
              {
                role: "user",
                content:
                  "These files were emitted EMPTY or cut off: " +
                  list.map((p) => `\`${p}\``).join(", ") +
                  ". Re-emit each COMPLETELY — full working content, no truncation, " +
                  "no placeholders. ONLY these files as ```file:<path> blocks.",
              },
            ],
            mode,
            signal: abort.signal,
            onDelta: delta,
            onStatus: status,
          });
          const fillBlocks = parseFileBlocks(fill.text);
          const fillPaths = new Set(fillBlocks.filter((b) => !isEmptyFile(b)).map((b) => b.path));
          let merged = result.text;
          for (const path of fillPaths) {
            merged = merged.replace(
              new RegExp("```file:" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n[\\s\\S]*?```", "g"),
              ""
            );
          }
          result = { ...fill, text: merged + "\n\n" + fill.text };
          continue;
        }

        // D) SELF-TEST pass (autopilot): after a structurally complete
        // build, one verification round — the model reviews its own files
        // against the checklist and fixes anything broken in the same go.
        // This is what catches blank pages and dead buttons BEFORE the
        // user ever sees them.
        if (!selfTested) {
          selfTested = true;
          status("Self-testing the build…");
          passStart("Self-test");
          const review = await generateAnswer({
            preferredModel: effPref,
            messages: [
              ...finalMessages,
              { role: "assistant", content: result.text },
              {
                role: "user",
                content:
                  "SELF-TEST your build before delivery. Re-read every file you emitted " +
                  "as the browser would: (1) script order & first call — any function " +
                  "called but never defined? (2) every id/className referenced in JS " +
                  "exists in the HTML? (3) the game loop starts, one click of every " +
                  "button works, win/lose reachable, restart resets cleanly? (4) any " +
                  "truncated function or missing close tag? (5) 60fps rules: per-frame " +
                  "allocations, pooling, dt usage?\n" +
                  "If EVERYTHING passes: reply exactly `PASS` and nothing else. " +
                  "If anything fails: re-emit ONLY the broken file(s) COMPLETELY as " +
                  "```file:<path> blocks with the fixes applied.",
              },
            ],
            mode,
            signal: abort.signal,
            onDelta: delta,
            onStatus: status,
          });
          const verdict = review.text.trim();
          if (!/^`?PASS`?\s*$/i.test(verdict.slice(0, 60))) {
            // the review produced fixed files — merge them in
            const revBlocks = parseFileBlocks(review.text);
            if (revBlocks.length) {
              let merged = result.text;
              for (const b of revBlocks) {
                merged = merged.replace(
                  new RegExp("```file:" + b.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n[\\s\\S]*?```", "g"),
                  ""
                );
              }
              result = { ...review, text: merged + "\n\n" + review.text };
              continue; // loop re-checks the fixed build
            }
          }
        }

        break; // complete
      }
    }

    sseSend(res, {
      type: "done",
      provider: result.providerLabel,
      model: result.model,
      search: searchData
        ? {
            results: (searchData.results || []).slice(0, 5),
            wiki: searchData.wiki
              ? { title: searchData.wiki.title, url: searchData.wiki.url }
              : null,
          }
        : null,
    });
  } catch (e) {
    sseSend(res, {
      type: "error",
      message: "All free engines are busy right now — try again in a few seconds.",
      details: e.details || [e.message],
    });
  } finally {
    clearInterval(pinger);
    res.end();
  }
}

export const config = { api: { bodyParser: true } };
