// Free keyless web search: DuckDuckGo HTML + Wikipedia summaries (fa/en).

import { fetchTimeout } from "./util.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

async function ddgResults(query, max = 5) {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const res = await fetchTimeout(url, { headers: { "User-Agent": UA } }, 12000);
  if (!res.ok) throw new Error("ddg-" + res.status);
  const html = await res.text();

  const out = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && out.length < max) {
    let href = m[1];
    try {
      const u = new URL(href.startsWith("//") ? "https:" + href : href);
      const real = u.searchParams.get("uddg");
      if (real) href = real;
    } catch {
      /* keep href */
    }
    const title = decodeEntities(m[2] || "");
    // the snippet lives shortly after the title inside the same result block
    const near = html.slice(m.index, m.index + 4000);
    const sm = near.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
    const snippet = sm ? decodeEntities(sm[1]).slice(0, 350) : "";
    if (title) out.push({ title, url: href, snippet });
  }
  return out;
}

async function wikiSummary(query, lang) {
  try {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
      encodeURIComponent(query.replace(/\s+/g, "_"));
    const res = await fetchTimeout(url, { headers: { "User-Agent": UA } }, 8000);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.extract) return null;
    return {
      title: d.title,
      extract: d.extract.slice(0, 700),
      url: d.content_urls?.desktop?.page || "",
      lang,
    };
  } catch {
    return null;
  }
}

/**
 * searchWeb(query) -> { results: [{title,url,snippet}], wiki: {...}|null }
 */
export async function searchWeb(query) {
  const q = String(query || "").slice(0, 300);
  if (!q.trim()) return { results: [], wiki: null };

  const [results, wikiFa, wikiEn] = await Promise.allSettled([
    ddgResults(q),
    wikiSummary(q, "fa"),
    wikiSummary(q, "en"),
  ]);

  return {
    results: results.status === "fulfilled" ? results.value : [],
    wiki:
      (wikiFa.status === "fulfilled" && wikiFa.value) ||
      (wikiEn.status === "fulfilled" && wikiEn.value) ||
      null,
  };
}

/** Format search data as context for the model. */
export function searchContext(data) {
  const parts = [];
  if (data.wiki) {
    parts.push(
      `Wikipedia (${data.wiki.lang}) — ${data.wiki.title}:\n${data.wiki.extract}\n${data.wiki.url}`
    );
  }
  data.results.forEach((r, i) => {
    parts.push(`[${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`);
  });
  if (!parts.length) return null;
  return (
    "LIVE WEB SEARCH RESULTS for the user's last message (ground your answer " +
    "in these when relevant; mention sources by name; do not copy-paste):\n\n" +
    parts.join("\n\n")
  );
}
