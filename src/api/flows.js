/**
 * /api/flows — what the institutions did with the cash market yesterday.
 *
 * WHY THIS IS A SERVER ROUTE AND NOT A MIRRORED FEED
 * --------------------------------------------------
 * FII and DII net flows are not in any file this site builds. They come from
 * NSE, which publishes them once a day after the session, and no feed in the
 * daily pipeline carries them — so the only honest way to show them is to ask
 * NSE directly.
 *
 * NSE'S OWN HOMEPAGE RETURNS 403 to a plain client while this API endpoint
 * answers, which is the opposite of what its docs and most guides assume; the
 * usual "warm a cookie off the homepage first" dance is therefore skipped
 * rather than cargo-culted. If NSE starts refusing the datacentre addresses
 * this Worker runs on, that is reported as unavailable — the page prints
 * "Not measured" rather than a stale or invented number.
 *
 * Values are ₹ crore, net = buy − sell, for the last published session.
 */
const NSE = "https://www.nseindia.com/api/fiidiiTradeReact";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/",
};

const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export default async function flows(req, res) {
  try {
    const r = await fetch(NSE, { headers: UA, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(`NSE HTTP ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error("NSE sent no rows");

    const pick = (re) => rows.find((x) => re.test(String(x.category || "")));
    const shape = (x) => x ? {
      date: x.date || null,
      buy: num(x.buyValue), sell: num(x.sellValue), net: num(x.netValue),
    } : null;

    const fii = shape(pick(/FII|FPI/i));
    const dii = shape(pick(/DII/i));
    if (!fii && !dii) throw new Error("NSE sent neither category");

    res.setHeader("Cache-Control", "public, max-age=900, s-maxage=900");
    res.status(200).json({
      ok: true, unit: "INR crore",
      date: (fii || dii).date,
      fii, dii,
      // The one number a front page has room for.
      net: (fii?.net ?? 0) + (dii?.net ?? 0),
      at: new Date().toISOString(),
    });
  } catch (err) {
    // 200 with ok:false: this is a nice-to-have panel, and a 5xx here would
    // make a page that is otherwise fine look broken.
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
}
