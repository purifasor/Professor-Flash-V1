// Brain: composes system prompts from the repo's Model/Skills/Knowledge files.
// Editing those markdown files on GitHub and redeploying re-tunes the AI —
// the repo IS the brain.

import fs from "node:fs";
import path from "node:path";

const EMBEDDED = {
  persona:
    "You are Professor Flash, a senior world-class AI engineer. Answer freshly " +
    "from the user's words — never canned. Detect the user's language and answer " +
    "in it (Persian users get fluent natural Persian). Be direct, warm, precise. " +
    "No moralizing lectures, no filler, no fabricated facts. Use markdown.",
  agent:
    "AGENT MODE: you are an autonomous senior engineer. Emit EVERY file as a " +
    "fenced block whose info string is exactly `file:<relative-path>`, complete " +
    "and consistent across files. Entry point index.html (vanilla HTML/CSS/JS, " +
    "CDN via jsdelivr only). Plan briefly first, SUMMARY at the end.",
};

let _cache = { at: 0, parts: null };

function readSafe(rel) {
  try {
    return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  } catch {
    return null;
  }
}

function loadParts() {
  if (_cache.parts && Date.now() - _cache.at < 5 * 60 * 1000) return _cache.parts;

  const persona =
    readSafe("Model/persona.md") ||
    EMBEDDED.persona;

  const skillNames = ["reasoning", "coding", "design", "research", "communication"];
  const skills = skillNames
    .map((n) => readSafe(`Skills/${n}.md`))
    .filter(Boolean)
    .join("\n\n");

  const agent =
    readSafe("Model/agent-protocol.md") ||
    EMBEDDED.agent;

  const knowledge = ["design-tokens", "web-dev"]
    .map((n) => readSafe(`Knowledge/${n}.md`))
    .filter(Boolean)
    .join("\n\n");

  _cache = { at: Date.now(), parts: { persona, skills, agent, knowledge } };
  return _cache.parts;
}

export function chatSystemPrompt() {
  const { persona, skills } = loadParts();
  return [
    persona,
    skills,
    "CONTEXT: You are running inside the Professor Flash web app. The user may " +
      "be Persian-speaking; mirror their language exactly. Today is " +
      new Date().toISOString().slice(0, 10) +
      ".",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function agentSystemPrompt() {
  const { persona, skills, agent, knowledge } = loadParts();
  return [
    persona,
    skills,
    agent,
    knowledge ? "REFERENCE:\n" + knowledge : "",
    "REMINDER: the client parses ```file:<path> blocks exactly. Output ONLY " +
      "complete files with that marker. Default to a stunning, polished, fully " +
      "working result. Entry file MUST be index.html.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Build a context message describing the user's current project files. */
export function filesContextMessage(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const clean = files
    .filter((f) => f && typeof f.path === "string" && typeof f.content === "string")
    .slice(0, 24);
  if (!clean.length) return null;

  let budget = 30000;
  const parts = [];
  for (const f of clean) {
    let content = f.content;
    if (content.length > 6000) content = content.slice(0, 6000) + "\n…(truncated)";
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
