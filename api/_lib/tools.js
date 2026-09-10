// Live data tools for Professor AI — injected into model context on demand:
//  - currency & crypto prices (real-time, no key needed, multi-source)
//  - gold prices (global XAU + Iran local, free-market Toman)
//  - world clocks & dates (any IANA timezone)
// These make every connected model capable of answering time/price questions
// exactly instead of hallucinating.

import { fetchTimeout } from "./util.js";

// ------------------------------------------------------------- FX & crypto
// Free keyless endpoints; each with graceful degradation and backups.

// Iran free-market USD/Toman — multiple sources, first hit wins.
// (Tgju publishes the open-market rate; rates are in Toman per USD.)
async function iranUsdToman() {
  // 1) tgju.org free endpoint (Toman per USD)
  try {
    const res = await fetchTimeout("https://call1.tgju.org/ajax.json", {}, 8000);
    if (res.ok) {
      const d = await res.json();
      const find = (names) => {
        for (const n of names) {
          const v = d?.current?.[n]?.p;
          if (v) return Number(String(v).replace(/,/g, ""));
        }
        return null;
      };
      const usd = find(["price_dollar_rl", "dollar", "usd"]);
      if (usd && usd > 10000) return { rate: usd, source: "tgju.org free market" };
    }
  } catch { /* next source */ }
  // 2) fallback: derive from open.er-api IRR (rial) → toman
  try {
    const res = await fetchTimeout("https://open.er-api.com/v6/latest/USD", {}, 8000);
    if (res.ok) {
      const d = await res.json();
      const irr = d?.rates?.IRR;
      if (irr) return { rate: Math.round(irr / 10), source: "open.er-api (derived)" };
    }
  } catch { /* best-effort */ }
  return null;
}

async function fxRates(base = "USD") {
  const res = await fetchTimeout(
    `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
    {},
    10000
  );
  if (!res.ok) throw new Error("fx-http-" + res.status);
  const d = await res.json();
  if (!d || !d.rates) throw new Error("fx-bad");
  return { base, rates: d.rates, updatedAt: d.time_last_update_utc || "" };
}

async function cryptoPrices(ids = ["bitcoin", "ethereum", "tether"]) {
  const res = await fetchTimeout(
    "https://api.coingecko.com/api/v3/simple/price?ids=" +
      ids.join(",") +
      "&vs_currencies=usd,eur&include_24hr_change=true",
    {},
    10000
  );
  if (!res.ok) throw new Error("cg-http-" + res.status);
  const d = await res.json();
  return d;
}

async function goldPrice() {
  // XAU in USD per troy ounce — source 1
  try {
    const res = await fetchTimeout("https://api.gold-api.com/price/XAU", {}, 8000);
    if (res.ok) {
      const d = await res.json();
      if (d?.price) return { priceUsdPerOunce: d.price, updatedAt: d.updatedAt || d.timestamp || "" };
    }
  } catch { /* next source */ }
  // source 2: coingecko PAXG (gold-backed token ≈ XAU spot)
  try {
    const res = await fetchTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd",
      {},
      8000
    );
    if (res.ok) {
      const d = await res.json();
      const p = d?.["pax-gold"]?.usd;
      if (p) return { priceUsdPerOunce: p, updatedAt: "PAXG spot proxy" };
    }
  } catch { /* best-effort */ }
  throw new Error("gold-unavailable");
}

/** Iran gold (18k gram & mesghal) derived from global XAU + free-market Toman. */
async function iranGold(goldUsdPerOunce, usdToman) {
  if (!goldUsdPerOunce || !usdToman) return null;
  const gram24 = goldUsdPerOunce / 31.1035;
  const gram18 = gram24 * 0.75;
  const mesghal = gram24 * 4.6083;
  return {
    note: "derived from global XAU × free-market USD/Toman",
    gram18k: Math.round(gram18 * usdToman),
    mesghal24k: Math.round(mesghal * usdToman),
    gram24k: Math.round(gram24 * usdToman),
  };
}

// ------------------------------------------------------------------- clocks
function timeIn(tz) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, weekday: "long",
    });
    return fmt.format(now);
  } catch {
    return null;
  }
}

const COMMON_TZ = {
  "iran": "Asia/Tehran", "tehran": "Asia/Tehran", "new york": "America/New_York",
  "usa": "America/New_York", "america": "America/New_York", "los angeles": "America/Los_Angeles",
  "london": "Europe/London", "uk": "Europe/London", "england": "Europe/London",
  "berlin": "Europe/Berlin", "germany": "Europe/Berlin", "europe": "Europe/Berlin",
  "paris": "Europe/Paris", "france": "Europe/Paris", "moscow": "Europe/Moscow",
  "russia": "Europe/Moscow", "dubai": "Asia/Dubai", "uae": "Asia/Dubai",
  "beijing": "Asia/Shanghai", "china": "Asia/Shanghai", "shanghai": "Asia/Shanghai",
  "tokyo": "Asia/Tokyo", "japan": "Asia/Tokyo", "india": "Asia/Kolkata",
  "delhi": "Asia/Kolkata", "istanbul": "Europe/Istanbul", "turkey": "Europe/Istanbul",
  "australia": "Australia/Sydney", "sydney": "Australia/Sydney", "toronto": "America/Toronto",
  "canada": "America/Toronto", "brazil": "America/Sao_Paulo", "sao paulo": "America/Sao_Paulo",
  "egypt": "Africa/Cairo", "cairo": "Africa/Cairo", "saudi": "Asia/Riyadh",
  "riyadh": "Asia/Riyadh", "korea": "Asia/Seoul", "seoul": "Asia/Seoul",
};

// --------------------------------------------------------------- detection
/** Detect whether the user's last message needs live data, and gather it. */
export async function gatherLiveData(lastUserText) {
  const text = String(lastUserText || "").toLowerCase();
  const parts = [];
  const wants = (arr) => arr.some((k) => text.includes(k));

  const wantsPrice =
    wants(["قیمت", "price", "چند", "how much", "نرخ", "rate", "دلار", "dollar",
      "euro", "یورو", "bitcoin", "بیت کوین", "بیت‌کوین", "crypto", "ارز", "currency",
      "gold", "طلا", "طلای", "toman", "تومان", "مصوبه", "سکه", "coin", "usd"]);
  const wantsTime = wants(["ساعت", "time", "date", "تاریخ", "today", "امروز",
    "clock", "what day", "چندمه", "now", "الان"]);

  if (wantsPrice) {
    const [fx, gold, crypto, iran] = await Promise.allSettled([
      fxRates("USD"),
      goldPrice(),
      cryptoPrices(),
      iranUsdToman(),
    ]);

    // free-market Iran rate first (most-asked), then global FX
    const iranRate = iran.status === "fulfilled" ? iran.value : null;
    if (iranRate) {
      parts.push(
        `IRAN FREE MARKET: 1 USD = ${iranRate.rate.toLocaleString("en-US")} Toman ` +
          `(${iranRate.source}, live)`
      );
    }

    if (fx.status === "fulfilled") {
      const r = fx.value;
      const lines = [
        `LIVE FX (base USD, updated ${r.updatedAt}):`,
        `EUR: ${(1 / (r.rates["EUR"] || 1)).toFixed(4)} per USD | GBP: ${(1 / (r.rates["GBP"] || 1)).toFixed(4)} per USD`,
      ];
      if (!iranRate && r.rates["IRR"]) {
        lines.push(`IRR (proxy): 1 USD = ${r.rates["IRR"]} IRR`);
      }
      parts.push(lines.join("\n"));
    }

    if (gold.status === "fulfilled") {
      const g = gold.value;
      parts.push(`GOLD (global spot): $${g.priceUsdPerOunce} per troy ounce (XAU/USD, ${g.updatedAt || "live"})`);
      const toman = iranRate ? iranRate.rate : null;
      const ir = await iranGold(g.priceUsdPerOunce, toman).catch(() => null);
      if (ir) {
        parts.push(
          `GOLD IRAN (derived: XAU × free-market USD/Toman): 18k gram ≈ ${ir.gram18k.toLocaleString("en-US")} T | mesghal ≈ ${ir.mesghal24k.toLocaleString("en-US")} T | 24k gram ≈ ${ir.gram24k.toLocaleString("en-US")} T`
        );
      }
    }

    if (crypto.status === "fulfilled") {
      const c = crypto.value;
      const cLines = Object.keys(c).map((id) => {
        const v = c[id];
        return `${id}: $${v.usd}${v.usd_24h_change != null ? ` (${v.usd_24h_change.toFixed(1)}% 24h)` : ""}`;
      });
      if (cLines.length) parts.push("LIVE CRYPTO: " + cLines.join(" | "));
    }
  }

  if (wantsTime) {
    const zones = ["iran", "london", "new york", "berlin", "dubai", "beijing", "tokyo", "los angeles"];
    const clocks = zones
      .map((z) => `${z}: ${timeIn(COMMON_TZ[z])}`)
      .join(" | ");
    parts.push(`WORLD CLOCKS (live): ${clocks}`);
    parts.push(`UTC now: ${new Date().toISOString()}`);
  }

  if (!parts.length) return null;
  return (
    "LIVE DATA (real-time, gathered just now — trust these numbers over your " +
    "training data; answer price/time questions directly with these figures, " +
    "NO long analysis unless asked):\n\n" +
    parts.join("\n\n")
  );
}
