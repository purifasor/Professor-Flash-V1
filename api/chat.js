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

import { generateAnswer } from "./_lib/providers.js";
import { chatSystemPrompt, agentSystemPrompt, filesContextMessage } from "./_lib/brain.js";
import { searchWeb, searchContext, newsHeadlines, newsContext } from "./_lib/search.js";
import { gatherLiveData } from "./_lib/tools.js";
import { streamRemote } from "./_lib/remote.js";
import { currentUser } from "./_lib/auth.js";
import { listModels } from "./_lib/db.js";
import { sseSend } from "./_lib/util.js";

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

  try {
    const lastUser = messages[messages.length - 1].content;
    const user = currentUser(req);

    // ---------- custom provider (user's own model) ----------
    let custom = null;
    if (user) {
      const saved = await listModels(user.folder).catch(() => []);
      const wanted = String(body.provider || "").trim();
      const rec = wanted
        ? saved.find((p) => p.name === wanted || p.modelId === wanted)
        : saved.find((p) => p.status === "active"); // first active provider
      if (rec) custom = rec;
    }

    const finalMessages = [];

    const runCustomProvider = async () => {
      // Custom provider path: same brain, user's engine, direct streaming.
      const sys = mode === "agent" ? agentSystemPrompt() : chatSystemPrompt(lastUser);
      const msgs = [{ role: "system", content: sys }];

      if (mode === "chat") {
        // live data works for custom providers too
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
      try {
        await streamRemote(
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
            delta("\n\n---\n\n");
            let repair = "";
            await streamRemote(
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
        // The user's provider failed (bad/expired key, rate limit, outage…).
        // Never dead-end the conversation: fall back to the default
        // Professor engine chain so the user ALWAYS gets an answer.
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

    // ALWAYS-ON web search for chat mode: quiet freshness check. A full
    // search runs for news/current/price questions; for everything else a
    // cheap gate keeps latency down.
    let searchData = null;
    if (mode === "chat") {
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
        } else {
          // light search for any non-trivial question (best-effort, silent)
          searchData = await searchWeb(lastUser).catch(() => null);
          if (searchData) {
            const ctx = searchContext(searchData);
            if (ctx) finalMessages.push({ role: "system", content: ctx });
          }
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

    let result = await generateAnswer({
      messages: finalMessages,
      mode,
      signal: abort.signal,
      onDelta: delta,
      onStatus: status,
    });

    // ---- Agent staged pipeline (autopilot: keeps going until complete) ----
    if (mode === "agent") {
      let pass = 0;
      const maxPasses = 6;

      while (pass < maxPasses) {
        pass++;
        const blocks = parseFileBlocks(result.text);
        const hasComplete = blocks.some((b) => !b.truncated);
        const bad = blocks.filter((b) => isEmptyFile(b) || b.truncated);
        const wantsContinue = /(^|\n)\s*CONTINUE:\s*$/i.test(result.text.trim());

        // A) analysis-only answer (no files yet) → orchestrate the build
        if (!hasComplete && !wantsContinue && pass === 1) {
          status("Planning build — dispatching sub-agents…");
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
          delta("\n\n---\n\n");
          result = await generateAnswer({
            messages: buildMsgs,
            mode,
            signal: abort.signal,
            onDelta: delta,
            onStatus: status,
          });
          continue;
        }

        // B) token-budget stop → resume exactly where it stopped
        if (wantsContinue) {
          status("Continuing the build…");
          const lastBlock = blocks[blocks.length - 1];
          const cont = await generateAnswer({
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
          const fill = await generateAnswer({
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
