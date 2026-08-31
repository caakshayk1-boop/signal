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
const shortCat = (c) => {
  const s = String(c || "");
  if (/qualified institutional/i.test(s)) return "QIB";
  if (/non institutional|nii|hni/i.test(s)) return "NII";
  if (/retail/i.test(s)) return "Retail";
  if (/employee/i.test(s)) return "Employee";
  if (/^total$/i.test(s)) return "Total";
  return s.slice(0, 28);
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

    const issues = [...bySym.values()].map((e) => {
      e.categories.sort((a, b) => b.x - a.x);
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
