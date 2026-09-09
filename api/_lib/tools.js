// Live data tools for Professor AI — injected into model context on demand:
//  - currency & crypto prices (real-time, no key needed)
//  - gold prices (global XAU + Iran local when available)
//  - world clocks & dates (any IANA timezone)
//  - tiny web search (DDG) for news/current events
// These make every connected model capable of answering time/price questions
// exactly instead of hallucinating.

import { fetchTimeout } from "./util.js";

// ------------------------------------------------------------- FX & crypto
// Free keyless endpoints; each with graceful degradation.
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
      "&vs_currencies=usd,eur,irt&include_24hr_change=true",
    {},
    10000
  );
  if (!res.ok) throw new Error("cg-http-" + res.status);
  const d = await res.json();
  return d;
}

async function goldPrice() {
  // XAU in USD via exchange-rate style endpoint (per-ounce)
  const res = await fetchTimeout("https://api.gold-api.com/price/XAU", {}, 10000);
  if (!res.ok) throw new Error("gold-http-" + res.status);
  const d = await res.json();
  return { priceUsdPerOunce: d.price, updatedAt: d.updatedAt || d.timestamp || "" };
}

/** Iran gold (18k gram & mesghal) derived from global XAU + USD/IRR — flagged as derived. */
async function iranGold(goldUsdPerOunce, usdIrr) {
  if (!goldUsdPerOunce || !usdIrr) return null;
  const gram24 = goldUsdPerOunce / 31.1035;
  const gram18 = gram24 * 0.75;
  const mesghal = gram24 * 4.6083;
  return {
    note: "derived from global XAU × free-market USD/IRR (estimate)",
    gram18k: Math.round(gram18 * usdIrr),
    mesghal24k: Math.round(mesghal * usdIrr),
    gram24k: Math.round(gram24 * usdIrr),
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
      "gold", "طلا", "طلای", "toman", "تومان"]);
  const wantsTime = wants(["ساعت", "time", "date", "تاریخ", "today", "امروز",
    "clock", "what day", "چندمه", "چندمه", "now", "الان"]);

  if (wantsPrice) {
    const [fx, gold, crypto] = await Promise.allSettled([fxRates("USD"), goldPrice(), cryptoPrices()]);
    if (fx.status === "fulfilled") {
      const r = fx.value;
      const usdIrr = r.rates["IRR"] || null;
      const lines = [
        `LIVE FX (base USD, updated ${r.updatedAt}):`,
        `EUR: ${(1 / (r.rates["EUR"] || 1)).toFixed(4)} per USD | GBP: ${(1 / (r.rates["GBP"] || 1)).toFixed(4)} per USD`,
        usdIrr ? `IRR (free-market proxy): 1 USD = ${usdIrr} IRR` : "",
      ].filter(Boolean);
      parts.push(lines.join("\n"));
      if (gold.status === "fulfilled") {
        const g = `GOLD (global): $${gold.value.priceUsdPerOunce} per troy ounce (XAU/USD, ${gold.value.updatedAt || "live"})`;
        parts.push(g);
        const ir = await iranGold(gold.value.priceUsdPerOunce, usdIrr);
        if (ir) {
          parts.push(
            `GOLD IRAN (estimate from XAU × USD/IRR): 18k gram ≈ ${ir.gram18k.toLocaleString()} IRR | mesghal ≈ ${ir.mesghal24k.toLocaleString()} IRR`
          );
        }
      }
    } else if (gold.status === "fulfilled") {
      parts.push(`GOLD (global): $${gold.value.priceUsdPerOunce} per troy ounce`);
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
