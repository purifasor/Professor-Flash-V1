// POST /api/chat — SSE streaming chat endpoint (modes: chat | agent).
// engines: "max" (strongest brain, reasoning high) | "code" (coding specialists).

import { generateAnswer } from "./_lib/providers.js";
import { chatSystemPrompt, agentSystemPrompt, filesContextMessage } from "./_lib/brain.js";
import { searchWeb, searchContext } from "./_lib/search.js";
import { sseSend } from "./_lib/util.js";

const MAX_HISTORY = 16;
const MAX_MSG_CHARS = 12000;
const MAX_TOTAL_CHARS = 60000;

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const msgs = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  const tail = msgs.slice(-MAX_HISTORY);
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
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Parse ```file:path blocks from agent output (for completeness checks). */
function parseFileBlocks(text) {
  const out = [];
  const re = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) out.push({ path: m[1].trim(), content: m[2] });
  // trailing unclosed block (stream ended mid-file)
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
  const engine = body.engine === "code" ? "code" : "max"; // quality-first default
  const messages = sanitizeMessages(body.messages);
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

  const status = (text) => sseSend(res, { type: "status", text });
  const delta = (text) => sseSend(res, { type: "delta", text });

  try {
    const sys = mode === "agent" ? agentSystemPrompt() : chatSystemPrompt();
    const finalMessages = [{ role: "system", content: sys }];

    // optional live web search, grounded into context
    let searchData = null;
    if (body.search) {
      status("جستجو در وب…");
      try {
        searchData = await searchWeb(messages[messages.length - 1].content);
        const ctx = searchContext(searchData);
        if (ctx) finalMessages.push({ role: "system", content: ctx });
      } catch {
        /* search is best-effort */
      }
    }

    if (mode === "agent") {
      const filesCtx = filesContextMessage(body.files);
      if (filesCtx) finalMessages.push({ role: "system", content: filesCtx });

      // live-preview runtime errors → the agent fixes them at the root
      if (Array.isArray(body.errors) && body.errors.length) {
        const errs = body.errors
          .filter((e) => typeof e === "string")
          .slice(0, 8)
          .map((e) => "- " + e.slice(0, 300))
          .join("\n");
        finalMessages.push({
          role: "system",
          content:
            "RUNTIME ERRORS captured in the user's live preview. Diagnose the " +
            "root cause and re-emit the fixed file(s) in full:\n" + errs,
        });
      }
    }

    finalMessages.push(...messages);

    let result = await generateAnswer({
      messages: finalMessages,
      mode,
      engine,
      signal: abort.signal,
      onDelta: delta,
      onStatus: status,
    });

    // ---- Agent contract enforcement ----
    if (mode === "agent") {
      const blocks = parseFileBlocks(result.text);

      // A) zero file blocks → one repair pass re-emitting the solution
      if (!blocks.some((b) => !b.truncated)) {
        status("مرتب‌سازی خروجی به فرمت فایل…");
        const repair = [
          ...finalMessages,
          { role: "assistant", content: result.text },
          {
            role: "user",
            content:
              "STOP. You violated the output contract: zero complete " +
              "```file:<path> blocks were emitted. Re-emit the ENTIRE solution " +
              "again strictly as ```file:<path> fenced blocks — complete files, " +
              "entry point index.html. Same content, correct format, no apologies.",
          },
        ];
        delta("\n\n---\n\n");
        result = await generateAnswer({
          messages: repair,
          mode,
          engine,
          signal: abort.signal,
          onDelta: delta,
          onStatus: status,
        });
      }

      // B) empty or truncated files → demand the missing content, verbatim
      const bad = parseFileBlocks(result.text).filter(
        (b) => isEmptyFile(b) || b.truncated
      );
      if (bad.length) {
        const list = [...new Set(bad.map((b) => b.path))];
        status("تکمیل فایل‌های ناقص…");
        const fill = [
          ...finalMessages,
          { role: "assistant", content: result.text },
          {
            role: "user",
            content:
              "These files were emitted EMPTY or cut off before completion: " +
              list.map((p) => `\`${p}\``).join(", ") +
              ". Re-emit each of them COMPLETELY, full working content, no " +
              "truncation, no placeholders, no comments like 'rest of code'. " +
              "Emit ONLY these files as ```file:<path> blocks.",
          },
        ];
        delta("\n\n---\n\n");
        result = await generateAnswer({
          messages: fill,
          mode,
          engine,
          signal: abort.signal,
          onDelta: delta,
          onStatus: status,
        });
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
      message:
        "الان همهٔ موتورهای رایگان اشغال‌اند؛ چند ثانیه بعد دوباره بفرست.",
      details: e.details || [e.message],
    });
  }
  res.end();
}

export const config = { api: { bodyParser: true } };
