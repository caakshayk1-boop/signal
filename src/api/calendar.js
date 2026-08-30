/**
 * /api/calendar — the things that happen to a listed company on a date.
 *
 * Three NSE datasets the daily pipeline does not carry: corporate actions
 * (bonus issues, splits, dividends), the board-meeting / results calendar,
 * and the exchange holiday list. Same access note as api/flows.js — NSE's
 * homepage refuses this client while its API answers, so no cookie warm-up.
 *
 * Each block fails on its own. One dataset going dark must not take the other
 * two off the page, so every fetch is settled independently and a failure is
 * reported as an empty list with its reason rather than a 500.
 */
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/",
};

const get = async (url) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// "31-Aug-2026" -> "2026-08-31", so dates sort and compare as strings.
const M = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
            jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const iso = (s) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${M[m[2].toLowerCase()] || "01"}-${m[1].padStart(2, "0")}` : null;
};

/* NSE puts the action in free text: "Bonus 1:1", "Face Value Split From Rs 10
 * To Rs 2", "Interim Dividend Rs 3". Only the first two are structural events
 * that change the share count or the quoted price, which is what a reader
 * scanning for surprises needs to see. Dividends are common and are not that. */
const kindOf = (t) => {
  const s = String(t || "").toLowerCase();
  if (/bonus/.test(s)) return "Bonus";
  if (/split|sub-?division|face value/.test(s)) return "Split";
  if (/right/.test(s)) return "Rights";
  if (/buy ?back/.test(s)) return "Buyback";
  if (/dividend/.test(s)) return "Dividend";
  return "Other";
};

/* Bonus, split and rights change the share count or the quoted price, so they
 * are the ones a reader scanning for surprises has to see first. Dividends are
 * routine — on the day this was written all twenty of NSE's rows were
 * dividends, so filtering to the structural ones alone produced a panel that
 * was permanently empty and looked broken. Everything is carried, and rank
 * decides what surfaces. */
const RANK = { Bonus: 0, Split: 1, Rights: 2, Buyback: 3, Dividend: 4, Other: 5 };

export default async function calendar(req, res) {
  const today = new Date().toISOString().slice(0, 10);

  const [caR, evR, hoR] = await Promise.allSettled([
    get("https://www.nseindia.com/api/corporates-corporateActions?index=equities"),
    get("https://www.nseindia.com/api/event-calendar"),
    get("https://www.nseindia.com/api/holiday-master?type=trading"),
  ]);

  const block = (r, map) => r.status === "fulfilled"
    ? { ok: true, rows: map(r.value) }
    : { ok: false, rows: [], error: String(r.reason && r.reason.message || r.reason) };

  const actions = block(caR, (rows) => (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      sym: x.symbol || null, company: x.comp || null,
      kind: kindOf(x.subject), detail: x.subject || null,
      ex: iso(x.exDate), record: iso(x.recDate),
    }))
    .sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || String(a.ex).localeCompare(String(b.ex))));

  const results = block(evR, (rows) => (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      sym: x.symbol || null, company: x.company || null,
      purpose: x.purpose || null, date: iso(x.date) || null,
      note: x.bm_desc || null,
      // Results are what the panel is for; the rest of the board-meeting
      // calendar is fund-raising and administrative filings, kept but ranked
      // below. Filtering to results alone left one row out of thirty-four.
      isResult: /result|financial/i.test(`${x.purpose || ""} ${x.bm_desc || ""}`),
    }))
    .sort((a, b) => (b.isResult - a.isResult) || String(a.date).localeCompare(String(b.date))));

  const holidays = block(hoR, (d) => {
    // CM is the cash market — the segment every equity on this site trades in.
    const rows = (d && (d.CM || d.cm)) || [];
    return rows.map((x) => ({
      date: iso(x.tradingDate), day: x.weekDay || null, why: x.description || null,
    })).filter((x) => x.date && x.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
  });

  res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=1800");
  res.status(200).json({ ok: true, at: new Date().toISOString(), today, actions, results, holidays });
}
