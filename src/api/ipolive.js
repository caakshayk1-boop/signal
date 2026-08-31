/**
 * /api/ipo-live — the subscription book as it stands, not as it was mirrored.
 *
 * WHY THIS EXISTS
 * ---------------
 * ipo.json is a daily mirror. On 31 August it showed Lumino at 2.86x while
 * the QIB book had reached 211x — the figure was not wrong when it was
 * written, it was a day and a half out of date, and an IPO book moves fastest
 * on its final day, which is exactly when someone is deciding.
 *
 * NSE publishes the live book. /api/ipo-current-issue carries one row per
 * category per active issue, with noOfTime as the subscription multiple.
 * Same access note as api/flows.js: NSE's homepage refuses this client while
 * its API answers, so there is no cookie warm-up to do.
 *
 * Cached for fifteen minutes at the edge. The book does not move faster than
 * that in any way a reader can act on, and NSE should not be asked to serve
 * every visitor individually.
 */
const NSE = "https://www.nseindia.com/api/ipo-current-issue";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/",
};

const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/* NSE's category strings are long and inconsistent across issues. These are
 * the three a reader actually reads, and anything else is carried through
 * under its own name rather than dropped — a category this code has not seen
 * before is not a reason to hide a number. */
/* NSE returns a HIERARCHY, not a list. Under Non Institutional Investors sit
 * two more rows — bids above ten lakh, and bids from two to ten lakh — each
 * with its own multiple, and under QIB sit FIIs, mutual funds and others with
 * no multiple at all. Mapping every "non institutional" string to NII printed
 * the same label three times with three different numbers, which reads as a
 * bug even though every figure was real.
 *
 * Only the four headline categories are kept: the aggregate NII, not its two
 * children. Returning null is how a row says "I am a sub-total, skip me". */
const shortCat = (c) => {
  const s = String(c || "").trim();
  if (/qualified institutional/i.test(s)) return "QIB";
  if (/^non\s*institutional\s*investors$/i.test(s)) return "NII";
  if (/non\s*institutional/i.test(s)) return null;      // bNII / sNII sub-buckets
  if (/retail/i.test(s)) return "Retail";
  if (/^employee/i.test(s)) return "Employees";
  if (/^total$/i.test(s)) return "Total";
  return null;                                          // FIIs, mutual funds, cut-off rows
};

export default async function ipolive(req, res) {
  try {
    const r = await fetch(NSE, { headers: UA, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(`NSE HTTP ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error("NSE sent no list");

    // One entry per symbol, its categories underneath.
    const bySym = new Map();
    for (const x of rows) {
      const sym = String(x.symbol || "").trim().toUpperCase();
      if (!sym) continue;
      if (!bySym.has(sym)) {
        bySym.set(sym, {
          symbol: sym,
          company: x.companyName || null,
          series: x.series || null,
          status: x.status || null,
          price_band: x.issuePrice || null,
          opens: x.issueStartDate || null,
          closes: x.issueEndDate || null,
          total_x: null,
          categories: [],
        });
      }
      const e = bySym.get(sym);
      const cat = shortCat(x.category);
      const times = num(x.noOfTime);
      if (cat === "Total") e.total_x = times;
      else if (times != null) e.categories.push({ cat, x: times, offered: num(x.noOfSharesOffered), bid: num(x.noOfsharesBid) });
    }

    /* THE PER-CATEGORY BOOK NEEDS A SECOND CALL.
     *
     * /api/ipo-current-issue carries one Total row per symbol and nothing
     * else — the first cut of this read a `category` field that is only
     * populated on some rows, so the split came back empty for every active
     * issue and the UI rendered a heading with nothing under it.
     *
     * /api/ipo-detail carries bidDetails, which is the real split. It is one
     * request per issue, which is why this route is cached for fifteen
     * minutes: six calls per cache miss rather than six per visitor. A detail
     * that fails leaves that issue with its headline multiple and no split,
     * which is the honest degradation. */
    const detail = async (sym) => {
      try {
        const r = await fetch(
          `https://www.nseindia.com/api/ipo-detail?symbol=${encodeURIComponent(sym)}&series=EQ`,
          { headers: UA, signal: AbortSignal.timeout(7000) });
        if (!r.ok) return [];
        const j = await r.json();
        return (j.bidDetails || [])
          .map((x) => ({ cat: shortCat(x.category), x: num(x.noOfTime),
                         offered: num(x.noOfSharesOffered), bid: num(x.noOfsharesBid) }))
          .filter((c) => c.cat && c.x != null && !/^total$/i.test(c.cat));
      } catch { return []; }
    };

    const list = [...bySym.values()];
    const splits = await Promise.all(list.map((e) => detail(e.symbol)));
    const issues = list.map((e, i) => {
      // Prefer the detail split; keep whatever the list gave us otherwise.
      const cats = splits[i].length ? splits[i] : e.categories;
      e.categories = cats.filter((c) => c.cat && Number.isFinite(c.x))
                         .sort((a, b) => b.x - a.x);
      return e;
    });

    res.setHeader("Cache-Control", "public, max-age=900, s-maxage=900");
    res.status(200).json({ ok: true, at: new Date().toISOString(), source: "NSE", issues });
  } catch (err) {
    // 200 with ok:false — the IPO page still renders on the mirrored figures
    // and says which one it is showing.
    res.status(200).json({ ok: false, error: String((err && err.message) || err), issues: [] });
  }
}
