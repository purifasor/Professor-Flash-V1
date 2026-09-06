// GET /api/models — the live roster the engine is using (from Model/models.json).

import { getRoster } from "./_lib/providers.js";

export default async function handler(_req, res) {
  const roster = getRoster();
  res.status(200).json({
    providers: roster.providers.map((p) => ({
      id: p.id,
      label: p.label,
      chat: p.chat,
      agent: p.agent,
    })),
    limits: roster.limits,
  });
}
