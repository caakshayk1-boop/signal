/**
 * /api/wire — the newswire, live, instead of once a day.
 *
 * WHY
 * ---
 * news.json is a build artefact: a bare array with no timestamps, rewritten
 * once a day. A reader refreshing at noon saw the same eighteen headlines
 * they saw at breakfast and could not tell whether the wire was quiet or
 * stuck. It was stuck — by design.
 *
 * These are the same public RSS feeds the daily build reads, fetched here
 * instead. Every item carries its own pubDate, so the page can say how old a
 * story is rather than how old the file is.
 *
 * Cached fifteen minutes at the edge: RSS publishers do not thank you for
 * per-visitor polling, and no reader is acting on a headline's first ninety
 * seconds.
 */
const FEEDS = [
  ["Economic Times",    "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "in"],
  ["ET Economy",        "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", "in"],
  ["Livemint",          "https://www.livemint.com/rss/markets", "in"],
  ["Business Standard", "https://www.business-standard.com/rss/markets-106.rss", "in"],
  ["Moneycontrol",      "https://www.moneycontrol.com/rss/marketreports.xml", "in"],
  ["BusinessLine",      "https://www.thehindubusinessline.com/markets/feeder/default.rss", "in"],
  ["Bloomberg",         "https://feeds.bloomberg.com/markets/news.rss", "global"],
  ["Financial Times",   "https://www.ft.com/rss/home", "global"],
  ["CNBC",              "https://www.cnbc.com/id/10001147/device/rss/rss.html", "global"],
  ["BBC Business",      "http://feeds.bbci.co.uk/news/business/rss.xml", "global"],
];

const UA = { "User-Agent": "Mozilla/5.0 (compatible; signal.askakshay.com/1.0)" };

/* workerd has no DOMParser, so RSS is read with expressions rather than a
 * tree. That is fine for the one shape this needs — <item> blocks with a
 * title, a link and a pubDate — and every field is optional on the way out, so
 * a feed that nests things differently loses a field rather than a story. */
const strip = (v) => String(v ?? "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/\s+/g, " ")
  .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? strip(m[1]) : null;
};

function parseRss(xml, source, scope) {
  const out = [];
  // <item> is RSS, <entry> is Atom. Both appear across these publishers.
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    if (!title) continue;
    let link = tag(b, "link");
    if (!link) {
      const alt = b.match(/<link[^>]*href="([^"]+)"/i);   // Atom puts it in an attribute
      link = alt ? alt[1] : null;
    }
    const when = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated");
    const t = when ? Date.parse(when) : NaN;
    out.push({
      title, link,
      source, scope,
      summary: (tag(b, "description") || tag(b, "summary") || "").slice(0, 260) || null,
      at: Number.isFinite(t) ? new Date(t).toISOString() : null,
      ts: Number.isFinite(t) ? t : 0,
    });
  }
  return out;
}

export default async function wire(req, res) {
  const settled = await Promise.allSettled(FEEDS.map(async ([source, url, scope]) => {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error(`${source} HTTP ${r.status}`);
    return parseRss(await r.text(), source, scope);
  }));

  const stories = [];
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") stories.push(...s.value);
    else failed.push(FEEDS[i][0]);
  });

  // Same headline can appear in two feeds; keep the earliest sighting.
  const seen = new Set();
  const unique = stories
    .sort((a, b) => b.ts - a.ts)
    .filter((x) => {
      const k = x.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 60)
    .map(({ ts, ...rest }) => rest);       // ts was for sorting only

  if (!unique.length) {
    // Every feed failed. Say so rather than returning an empty wire that looks
    // like a quiet news day.
    res.status(200).json({ ok: false, error: "no feed answered", failed, stories: [] });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=900, s-maxage=900");
  res.status(200).json({
    ok: true, at: new Date().toISOString(),
    sources: FEEDS.length - failed.length, failed,
    stories: unique,
  });
}
