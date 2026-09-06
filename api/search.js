// GET /api/search?q=... — live web search (DuckDuckGo + Wikipedia).

import { searchWeb } from "./_lib/search.js";

export default async function handler(req, res) {
  const q = (req.query && req.query.q) || "";
  if (!q.trim()) {
    res.status(400).json({ error: "missing-q" });
    return;
  }
  try {
    const data = await searchWeb(q);
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "search-failed", message: e.message });
  }
}
