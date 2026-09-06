// Brain: composes system prompts from the repo's brain/ directory.
// Editing those markdown files on GitHub and redeploying re-tunes the AI —
// the repo IS the brain.

import fs from "node:fs";
import path from "node:path";

const EMBEDDED = {
  persona:
    "You are Professor Flash, a senior world-class AI engineer. Answer freshly " +
    "from the user's words — never canned. Detect the user's language and answer " +
    "in it (Persian users get fluent natural Persian). Be direct and precise. " +
    "No flattery, no moralizing lectures, no filler, no fabricated facts. Use markdown.",
  chat:
    "CHAT MODE: think first, open with the substance, right-size the answer, " +
    "structure with markdown, give real opinions with reasons.",
  agent:
    "AGENT MODE: you are an autonomous senior engineer. Emit EVERY file as a " +
    "fenced block whose info string is exactly `file:<relative-path>`, complete " +
    "and consistent across files. Entry point index.html (vanilla HTML/CSS/JS, " +
    "CDN via jsdelivr only). Plan briefly first, SUMMARY at the end.",
};

let _cache = { at: 0, parts: null };

function readSafe(rel) {
  const candidates = [rel, rel.replace(/^brain\//, "")]; // new layout, legacy fallback
  for (const c of candidates) {
    try {
      return fs.readFileSync(path.join(process.cwd(), ...c.split("/")), "utf8");
    } catch {
      /* try next */
    }
  }
  // legacy dirs: Model/, Skills/, Knowledge/
  return null;
}

function readLegacy(legacyRel) {
  try {
    return fs.readFileSync(path.join(process.cwd(), ...legacyRel.split("/")), "utf8");
  } catch {
    return null;
  }
}

function loadParts() {
  if (_cache.parts && Date.now() - _cache.at < 5 * 60 * 1000) return _cache.parts;

  const persona = readSafe("brain/persona.md") || readLegacy("Model/persona.md") || EMBEDDED.persona;

  const chatPrompt = readSafe("brain/prompts/chat.md") || EMBEDDED.chat;

  const agentPrompt =
    readSafe("brain/prompts/agent.md") || readLegacy("Model/agent-protocol.md") || EMBEDDED.agent;

  const skillNames = ["reasoning", "coding", "design", "research", "communication"];
  const skills = skillNames
    .map((n) => readSafe(`brain/skills/${n}.md`) || readLegacy(`Skills/${n}.md`))
    .filter(Boolean)
    .join("\n\n");

  const knowledge = ["design-tokens", "web-dev", "persian"]
    .map((n) => readSafe(`brain/knowledge/${n}.md`) || readLegacy(`Knowledge/${n}.md`))
    .filter(Boolean)
    .join("\n\n");

  _cache = { at: Date.now(), parts: { persona, chatPrompt, agentPrompt, skills, knowledge } };
  return _cache.parts;
}

export function chatSystemPrompt() {
  const { persona, chatPrompt, skills, knowledge } = loadParts();
  return [
    persona,
    chatPrompt,
    skills ? "SKILLS:\n" + skills : "",
    knowledge ? "REFERENCE KNOWLEDGE:\n" + knowledge : "",
    "CONTEXT: You are running live inside the Professor Flash web app " +
      "(free, online, no signup). Today is " +
      new Date().toISOString().slice(0, 10) +
      ". Mirror the user's language exactly.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function agentSystemPrompt() {
  const { persona, agentPrompt, skills, knowledge } = loadParts();
  return [
    persona,
    agentPrompt,
    skills ? "SKILLS:\n" + skills : "",
    knowledge ? "REFERENCE KNOWLEDGE:\n" + knowledge : "",
    "FINAL REMINDER (highest priority):\n" +
      "- Output files ONLY as ```file:<path> blocks; complete files; entry = index.html.\n" +
      "- Persian user ⇒ lang=fa dir=rtl + Vazirmatn + Persian UI text + exact requested theme palette as CSS variables.\n" +
      "- HTML/CSS/JS must be perfectly synced: every href/src/id/class/function consistent across files.\n" +
      "- Everything must actually WORK with zero console errors; no placeholders.\n" +
      "- End with a SUMMARY: section.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Build a context message describing the user's current project files. */
export function filesContextMessage(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const clean = files
    .filter((f) => f && typeof f.path === "string" && typeof f.content === "string")
    .slice(0, 32);
  if (!clean.length) return null;

  let budget = 40000;
  const parts = [];
  for (const f of clean) {
    let content = f.content;
    if (content.length > 8000) content = content.slice(0, 8000) + "\n…(truncated)";
    if (budget - content.length < 0) {
      parts.push(`### ${f.path}\n(omitted for size — ask the user if you need it)`);
      continue;
    }
    budget -= content.length;
    parts.push(`### ${f.path}\n${content}`);
  }
  return (
    "CURRENT PROJECT STATE — these files already exist from earlier in this " +
    "conversation. Update ONLY the files that must change (re-emit them whole " +
    "with ```file: blocks); untouched files persist automatically:\n\n" +
    parts.join("\n\n")
  );
}
