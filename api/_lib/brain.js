// Brain: composes system prompts from the repo's brain/ directory.
// Editing those markdown files on GitHub and redeploying re-tunes the AI —
// the repo IS the brain. Any model/provider connected in the future gets
// the same organized skill & knowledge bank via this module.

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
let _bankCache = { at: 0, data: null };

function readSafe(rel) {
  const candidates = [rel, rel.replace(/^brain\//, "")]; // new layout, legacy fallback
  for (const c of candidates) {
    try {
      return fs.readFileSync(path.join(process.cwd(), ...c.split("/")), "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), ...rel.split("/")), "utf8"));
  } catch {
    return null;
  }
}

/** Load the skill/knowledge manifest + every file it registers. */
function loadBank() {
  if (_bankCache.data && Date.now() - _bankCache.at < 5 * 60 * 1000) return _bankCache.data;
  const manifest = readJson("brain/skills/manifest.json") || { skills: [], knowledge: [] };
  const skills = {};
  for (const name of manifest.skills || []) {
    const md = readSafe(`brain/skills/${name}.md`);
    if (md) skills[name] = md;
  }
  const knowledge = {};
  for (const name of manifest.knowledge || []) {
    const md = readSafe(`brain/knowledge/${name}.md`);
    if (md) knowledge[name] = md;
  }
  _bankCache = { at: Date.now(), data: { manifest, skills, knowledge } };
  return _bankCache.data;
}

/** Pick which skills to include, given the user's latest message. */
function routeSkills(manifest, lastUserText) {
  const text = String(lastUserText || "");
  const lower = text.toLowerCase();
  const routing = manifest.routing || {};
  const rules = Array.isArray(routing.rules) ? routing.rules : [];

  for (const rule of rules) {
    const words = Array.isArray(rule.match) ? rule.match : [];
    if (words.some((w) => lower.includes(String(w).toLowerCase()))) {
      return Array.isArray(rule.skills) ? rule.skills : [];
    }
  }
  const def = routing.default;
  return Array.isArray(def) ? def : [];
}

function loadParts() {
  if (_cache.parts && Date.now() - _cache.at < 5 * 60 * 1000) return _cache.parts;

  const persona = readSafe("brain/persona.md") || EMBEDDED.persona;
  const chatPrompt = readSafe("brain/prompts/chat.md") || EMBEDDED.chat;
  const agentPrompt = readSafe("brain/prompts/agent.md") || EMBEDDED.agent;
  const bank = loadBank();

  _cache = {
    at: Date.now(),
    parts: { persona, chatPrompt, agentPrompt, bank },
  };
  return _cache.parts;
}

function skillsSection(bank, prioritized) {
  const all = Object.keys(bank.skills);
  if (!all.length) return "";
  // prioritized (routed) skills first, then the rest
  const ordered = [
    ...prioritized.filter((n) => bank.skills[n]),
    ...all.filter((n) => !prioritized.includes(n)),
  ];
  const parts = ordered.map((n) => bank.skills[n]);
  return parts.length ? "SKILLS:\n" + parts.join("\n\n") : "";
}

function knowledgeSection(bank) {
  const parts = Object.keys(bank.knowledge).map((n) => bank.knowledge[n]);
  return parts.length ? "REFERENCE KNOWLEDGE:\n" + parts.join("\n\n") : "";
}

export function chatSystemPrompt(lastUserText = "") {
  const { persona, chatPrompt, bank } = loadParts();
  const prioritized = routeSkills(bank.manifest, lastUserText);
  return [
    persona,
    chatPrompt,
    skillsSection(bank, prioritized),
    knowledgeSection(bank),
    "CONTEXT: You are running live inside the Professor AI web app " +
      "(free, online). Today is " +
      new Date().toISOString().slice(0, 10) +
      ". Mirror the user's language exactly.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function agentSystemPrompt() {
  const { persona, agentPrompt, bank } = loadParts();
  const all = Object.keys(bank.skills);
  const prioritized = ["coding", "debugging", "game-engineering", "design"].filter((n) =>
    all.includes(n)
  );
  return [
    persona,
    agentPrompt,
    skillsSection(bank, prioritized),
    knowledgeSection(bank),
    "FINAL REMINDER (highest priority):\n" +
      "- Run the 4-stage pipeline: ANALYZE → PLAN (task breakdown) → MAP (sync map) → BUILD.\n" +
      "- Output files ONLY as ```file:<path> blocks; complete files; entry = index.html.\n" +
      "- Persian user ⇒ lang=fa dir=rtl + Vazirmatn + Persian UI text + exact requested theme palette as CSS variables.\n" +
      "- HTML/CSS/JS must be perfectly synced: every href/src/id/class/function consistent across files.\n" +
      "- Every button and control must actually DO something — zero dead UI, zero placeholders.\n" +
      "- If the token budget runs out, end the current file cleanly and write `CONTINUE:` on its own line.\n" +
      "- Everything must actually WORK with zero console errors.\n" +
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

  let budget = 60000;
  const parts = [];
  for (const f of clean) {
    let content = f.content;
    if (content.length > 10000) content = content.slice(0, 10000) + "\n…(truncated — but you built this file; you know it)";
    if (budget - content.length < 0) {
      parts.push(`### ${f.path}\n(omitted for size — ask the user if you need it)`);
      continue;
    }
    budget -= content.length;
    parts.push(`### ${f.path}\n${content}`);
  }
  return (
    "CURRENT PROJECT STATE — YOUR OWN EARLIER WORK. These files already " +
    "exist from earlier turns in this conversation. You have FULL access to " +
    "them: read them above, diagnose issues from the real code, and when " +
    "the user asks for a fix/change, re-emit ONLY the affected file(s) in " +
    "full (client upserts by path). NEVER claim you can't see the files. " +
    "Untouched files persist automatically:\n\n" +
    parts.join("\n\n")
  );
}
