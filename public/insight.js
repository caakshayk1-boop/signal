/* insight.js — "what matters" and "what changed" for one company, computed.
 *
 * ONE IMPLEMENTATION, TWO CALLERS. The Worker (src/seo.js) runs this to write
 * a company page's HTML before any JavaScript loads, and vision.js runs it
 * again in the browser. Two copies of a sentence-generator drift the way this
 * repo's two record calculators once did ("47 published, none closed" beside
 * "11 closed"), so there is one file. It attaches itself to the global scope:
 * a classic <script> in the browser, a side-effect import in the Worker
 * (seo.js reads globalThis.VisionInsight), and the same in the guard's Node.
 *
 * RULES IT KEEPS
 *  - Deterministic. Every sentence is a threshold on a published field, and
 *    every threshold is in T below and printed on the page. No model writes
 *    any of it.
 *  - Every item carries its BASIS (the numbers it compared) and its SOURCE
 *    (which feed, which period). A reader can check each one.
 *  - Missing is silent, never zero. A company with no EPS CAGR gets no EPS
 *    sentence; it does not get "EPS flat".
 *  - Descriptive, not advice. "Revenue growth accelerated" is a fact about
 *    filed numbers; nothing here says what to do about it.
 */
(function (root) {
  'use strict';

  const T = {
    growthPP: 3,    // YoY vs multi-year rate, percentage points
    rocePP: 2,      // latest ROCE vs its own multi-year median
    marginPP: 1,    // EBIT margin, latest FY vs prior FY
    relPP: 5,       // 1-month return vs the screen's median
    volX: 2,        // today's volume vs its average
    earnDays: 45,   // a results date this close is an event
    peHi: 80, peLo: 20, // PE percentile of its own history
    scoreMove: 5,   // screen score change since the previous build
  };

  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  /* LENDERS ARE READ DIFFERENTLY — the screen's own rule, word for word
     (stock_screen.py::_is_financial). A bank or NBFC borrows to lend: debt/
     equity of 4 is its business model, operating cash flow swings with the
     loan book, and EBIT margin and ROCE have no meaning. The screen already
     leaves all four out of its scores and risk grade; this layer printed them
     anyway, so EDELWEISS read "Risk LOW" beside a red "heavily geared" and a
     green 7.64× cash conversion. guard.mjs holds the three copies of this
     rule (Python, here, signal.js) to the same four words. */
  const isFinancial = (r) => /financial|bank|insurance|real estate/.test(`${(r && r.sector) || ''} ${(r && r.ind) || ''}`.toLowerCase());
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f1(Math.abs(v))}%`;
  const pp = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f1(Math.abs(v))} pp`;

  const SRC = {
    fin: (r) => `Company filings via the stock screen — ${r.fy || 'latest FY'}, ${r.fy_count || '?'} fiscal years`,
    px: (r) => `NSE daily prices, close of ${r.last_date || 'the last build'}`,
    ins: (x) => `Exchange shareholding filings — ${x.period} against ${x.prev_period}`,
    scr: (c) => `Stock screen, this build against the build of ${c.compared_with || 'the previous run'}`,
    cal: () => 'Results date as listed on the screen (Yahoo calendar) — check the exchange filing',
    uni: (c) => `The screen's own universe: median 1-month return of ${c.universe || 'all'} names`,
  };

  /* WHAT MATTERS — the handful of numbers that describe the business and the
     stock, each with one line of context. Order is fixed: business first. */
  function matters(r, x, c) {
    c = c || {}; const out = [];
    const add = (k, v, sub, tone, src) => out.push({ k, v, sub, tone: tone || '', src });
    const ry = num(r.rev_yoy), rc = num(r.rev_cagr);
    if (ry != null) add('Revenue', `${pct(ry)} YoY`, rc != null ? `${pct(rc)} a year over ${r.fy_count || 'several'} years` : 'no multi-year rate', ry >= 0 ? 'up' : 'dn', SRC.fin(r));
    const roce = num(r.roce), rm = num(r.roce_med);
    if (roce != null) add('ROCE', `${f1(roce)}%`, rm != null ? `median ${f1(rm)}%${r.roce_trend ? ' · ' + r.roce_trend : ''}` : '', '', SRC.fin(r));
    const fin = isFinancial(r), de = num(r.de);
    if (fin) {
      const roe = num(r.roe), rm = num(r.roe_med);
      if (roe != null) add('ROE', `${f1(roe)}%`, rm != null ? `median ${f1(rm)}% · how a lender is judged` : 'how a lender is judged', '', SRC.fin(r));
      if (de != null) add('Debt / equity', de < 0 ? 'Negative equity' : de.toFixed(2), de < 0 ? 'insolvency, not a clean balance sheet' : 'a lender borrows to lend — not a risk measure here', de < 0 ? 'dn' : '', SRC.fin(r));
    } else {
      const md = num(r.margin_delta), em = num(r.ebit_margin);
      if (md != null || em != null) add('EBIT margin', em != null ? `${f1(em)}%` : '—', md != null ? `${pp(md)} on the prior year` : '', md == null ? '' : md >= 0 ? 'up' : 'dn', SRC.fin(r));
      if (de != null) add('Debt / equity', de < 0 ? 'Negative equity' : de.toFixed(2), de < 0 ? 'insolvency, not a clean balance sheet' : de < 0.3 ? 'lightly geared' : de > 1.5 ? 'heavily geared' : '', de < 0 || de > 1.5 ? 'dn' : '', SRC.fin(r));
      const cp = num(r.cfo_pat);
      /* Far above 1 is not "better": it means profit is a sliver of cash flow —
         thin margins, heavy depreciation, or Ind AS 116 moving lease rent out
         of operating cash (ABLBL read a green 13.16×). Not coloured above 2.5. */
      if (cp != null) add('Cash conversion', `${cp.toFixed(2)}×`, cp > 2.5 ? 'thin profit or lease-heavy accounts, not extra quality' : 'operating cash flow ÷ profit, multi-year median', cp < 0.6 ? 'dn' : cp >= 1 && cp <= 2.5 ? 'up' : '', SRC.fin(r));
    }
    const r1m = num(r.r1m), med = num(c.median_1m);
    if (r1m != null) add('Price, 1 month', pct(r1m), med != null ? `screen median ${pct(med)} → ${pp(r1m - med)} relative` : '', r1m >= 0 ? 'up' : 'dn', SRC.px(r));
    const pe = num(r.pe), pp_ = num(r.pe_pctile);
    if (pe != null) add('Valuation', `PE ${f1(pe)}`, pp_ != null ? `${Math.round(pp_)}th percentile of its own history` : '', '', SRC.fin(r));
    if (x && x.quality === 'complete') add('Institutions', `${(num(x.fii) + num(x.dii)).toFixed(2)}%`, `FII ${pp(num(x.fii_pp))} · DII ${pp(num(x.dii_pp))} q/q`, num(x.insti_pp) > 0 ? 'up' : num(x.insti_pp) < 0 ? 'dn' : '', SRC.ins(x));
    return out;
  }

  /* WHAT CHANGED — four lists, each item a sentence, its basis and its source.
     "improved" and "weakened" describe filed numbers moving; "watch" is
     context a reader should weigh (valuation, leverage) that is not itself a
     change; "events" are dated things. */
  function changes(r, x, c) {
    c = c || {};
    const o = { improved: [], weakened: [], watch: [], events: [] };
    const put = (list, t, basis, src) => o[list].push({ t, basis, src });

    const ry = num(r.rev_yoy), rc = num(r.rev_cagr);
    if (ry != null && rc != null) {
      const d = ry - rc;
      if (d >= T.growthPP) put('improved', 'Revenue growth accelerated', `${pct(ry)} last year against ${pct(rc)} a year over ${r.fy_count || 'several'} years`, SRC.fin(r));
      else if (d <= -T.growthPP) put('weakened', 'Revenue growth slowed', `${pct(ry)} last year against ${pct(rc)} a year over ${r.fy_count || 'several'} years`, SRC.fin(r));
    }
    const fin = isFinancial(r);
    const ey = num(r.ebitda_yoy), ec = num(r.ebitda_cagr);
    if (!fin && ey != null && ec != null) {
      const d = ey - ec;
      if (d >= T.growthPP) put('improved', 'Operating profit growth accelerated', `EBITDA ${pct(ey)} last year against ${pct(ec)} a year`, SRC.fin(r));
      else if (d <= -T.growthPP) put('weakened', 'Operating profit growth slowed', `EBITDA ${pct(ey)} last year against ${pct(ec)} a year`, SRC.fin(r));
    }
    const md = num(r.margin_delta);
    if (!fin && md != null && Math.abs(md) >= T.marginPP) put(md > 0 ? 'improved' : 'weakened', md > 0 ? 'Margins widened' : 'Margins narrowed', `EBIT margin ${pp(md)} on the prior fiscal year`, SRC.fin(r));
    const roce = num(r.roce), rm = num(r.roce_med);
    if (!fin && roce != null && rm != null && Math.abs(roce - rm) >= T.rocePP) put(roce > rm ? 'improved' : 'weakened', roce > rm ? 'Returns on capital above their own norm' : 'Returns on capital below their own norm', `ROCE ${f1(roce)}% against a ${f1(rm)}% multi-year median`, SRC.fin(r));

    if (x && x.quality === 'complete') {
      const th = num(c.threshold_pp) || 0.5, ip = num(x.insti_pp);
      if (ip != null && Math.abs(ip) >= th) put(ip > 0 ? 'improved' : 'weakened', ip > 0 ? 'Institutions added' : 'Institutions reduced', `FII + DII ${pp(ip)} in ${x.period} (FII ${pp(num(x.fii_pp))}, DII ${pp(num(x.dii_pp))})`, SRC.ins(x));
    }
    const r1m = num(r.r1m), med = num(c.median_1m);
    if (r1m != null && med != null && Math.abs(r1m - med) >= T.relPP) put(r1m > med ? 'improved' : 'weakened', r1m > med ? 'Outperformed the market over a month' : 'Lagged the market over a month', `${pct(r1m)} against the screen's median ${pct(med)}`, SRC.uni(c));

    const d = r.delta || {};
    for (const [k, word] of [['comp', 'Composite score'], ['q', 'Quality score'], ['g', 'Growth score'], ['tech', 'Technical score']]) {
      const v = num(d[k]);
      if (v != null && Math.abs(v) >= T.scoreMove) put(v > 0 ? 'improved' : 'weakened', `${word} ${v > 0 ? 'rose' : 'fell'} since the last screen`, `${v > 0 ? '+' : '−'}${f1(Math.abs(v))} points`, SRC.scr(c));
    }

    const de = num(r.de);
    if (de != null && de < 0) put('watch', 'Negative equity', 'Debt/equity below zero means liabilities exceed assets', SRC.fin(r));
    else if (!fin && de != null && de > 1.5) put('watch', 'High leverage', `Debt/equity ${de.toFixed(2)}`, SRC.fin(r));
    const pe = num(r.pe_pctile);
    if (pe != null && pe >= T.peHi) put('watch', 'Valued near the top of its own range', `PE in the ${Math.round(pe)}th percentile of its history`, SRC.fin(r));
    else if (pe != null && pe <= T.peLo) put('watch', 'Valued near the bottom of its own range', `PE in the ${Math.round(pe)}th percentile of its history`, SRC.fin(r));
    const cp = num(r.cfo_pat);
    if (!fin && cp != null && cp < 0.6) put('watch', 'Profit is not turning into cash', `Operating cash flow ${cp.toFixed(2)}× profit (multi-year median)`, SRC.fin(r));
    if (r.shares_changed) put('watch', 'Share count moved structurally', 'EPS growth is withheld: a split, bonus or issue makes it incomparable', SRC.fin(r));

    const vs = num(r.vol_spike);
    if (vs != null && vs >= T.volX) put('events', `Volume ${vs.toFixed(1)}× its average`, `on ${r.last_date || 'the last session'}`, SRC.px(r));
    if (r.brk52w) put('events', 'Closed at a 52-week high', `₹${num(r.high52)}`, SRC.px(r));
    const ne = r.next_earnings, today = c.today ? Date.parse(c.today) : null;
    if (ne && today != null) {
      const days = Math.round((Date.parse(String(ne).slice(0, 10)) - today) / 86400000);
      if (days >= 0 && days <= T.earnDays) put('events', `Results due ${String(ne).slice(0, 10)}`, `in ${days} day${days === 1 ? '' : 's'}`, SRC.cal());
    }
    if (c.vsig) put('events', `${c.vsig.name} from the close of ${String(c.vsig.fired_at).slice(0, 10)}`, `${c.vsig.entry_low != null ? `entry range ₹${c.vsig.entry_low}–₹${c.vsig.entry_high}` : `entry ₹${c.vsig.entry}`} · stop ₹${c.vsig.sl} · ${c.vsig.status}`, 'Signal V2 plan');
    return o;
  }

  /* THE ONE-MINUTE READ — five reads and the next event, each one a WORD
     (the interpretation), the FACT it rests on, and the RULE that turned the
     one into the other. Same thresholds as everything above (T), so the page
     can print them. Missing is silent: a company without a field loses that
     line, it never gets a neutral word for data that is not there. */
  function oneMinute(r, x, c) {
    c = c || {}; const out = { reads: [], event: null };
    const add = (k, word, fact, rule, tone) => out.reads.push({ k, word, fact, rule, tone: tone || '' });
    const fin = isFinancial(r);
    // Business quality: returns against the company's own multi-year norm.
    const q = fin ? [num(r.roe), num(r.roe_med), 'ROE'] : [num(r.roce), num(r.roce_med), 'ROCE'];
    if (q[0] != null && q[1] != null) {
      const d = q[0] - q[1];
      add('Business quality', d >= T.rocePP ? 'above its own norm' : d <= -T.rocePP ? 'below its own norm' : 'in line with its norm',
        `${q[2]} ${f1(q[0])}% against a ${f1(q[1])}% multi-year median`, `±${T.rocePP} pp of its median is in line`,
        d >= T.rocePP ? 'up' : d <= -T.rocePP ? 'dn' : '');
    }
    // Growth: last year against the multi-year rate.
    const ry = num(r.rev_yoy), rc = num(r.rev_cagr);
    if (ry != null && rc != null) {
      const d = ry - rc;
      add('Growth', d >= T.growthPP ? 'accelerating' : d <= -T.growthPP ? 'slowing' : 'steady',
        `Revenue ${pct(ry)} last year against ${pct(rc)} a year over ${r.fy_count || 'several'} years`, `±${T.growthPP} pp of the multi-year rate is steady`,
        d >= T.growthPP ? 'up' : d <= -T.growthPP ? 'dn' : '');
    }
    // Price structure: where the close sits against its 50- and 200-day averages.
    const px = num(r.price), s50 = num(r.sma50), s200 = num(r.sma200);
    if (px != null && s50 != null && s200 != null) {
      const a50 = px > s50, a200 = px > s200;
      add('Price structure', a50 && a200 ? 'above both averages' : !a50 && !a200 ? 'below both averages' : `above the ${a50 ? '50' : '200'}-day, below the ${a50 ? '200' : '50'}-day`,
        `₹${px.toFixed(2)} against ₹${s50.toFixed(2)} (50-day) and ₹${s200.toFixed(2)} (200-day)`, 'close against its 50- and 200-day averages',
        a50 && a200 ? 'up' : !a50 && !a200 ? 'dn' : '');
    }
    // Valuation: PE against its own history, never against other companies.
    const pe = num(r.pe), pc = num(r.pe_pctile);
    if (pe != null && pc != null) {
      add('Valuation', pc >= T.peHi ? 'high in its own range' : pc <= T.peLo ? 'low in its own range' : 'mid-range for itself',
        `PE ${f1(pe)}, the ${Math.round(pc)}th percentile of its own history`, `${T.peLo}th and ${T.peHi}th percentiles mark low and high`);
    }
    // Ownership: the latest quarter's institutional change.
    if (x && x.quality === 'complete' && num(x.insti_pp) != null) {
      const th = num(c.threshold_pp) || 0.5, ip = num(x.insti_pp);
      add('Ownership', ip >= th ? 'institutions added' : ip <= -th ? 'institutions reduced' : 'little changed',
        `FII ${pp(num(x.fii_pp))}, DII ${pp(num(x.dii_pp))} in ${x.period}`, `a move under ${th} pp is no change`,
        ip >= th ? 'up' : ip <= -th ? 'dn' : '');
    }
    // The next dated thing, kept apart from the reads: an event is not a judgement.
    const ne = r.next_earnings, today = c.today ? Date.parse(c.today) : null;
    if (ne && today != null) {
      const days = Math.round((Date.parse(String(ne).slice(0, 10)) - today) / 86400000);
      if (days >= 0) out.event = { t: `Results due ${String(ne).slice(0, 10)}`, s: `in ${days} day${days === 1 ? '' : 's'}`, src: SRC.cal() };
    }
    return out;
  }

  /* KEY DIFFERENCES across a comparison set — the extremes on each measured
     row, stated with both numbers. Only rows where at least two names are
     measured, and only a gap large enough to be a difference. */
  const CMP = [
    ['rev_cagr', 'revenue growth', '%', 5], ['roce', 'ROCE', '%', 5], ['ebit_margin', 'EBIT margin', '%', 5],
    ['de', 'debt/equity', '×', 0.5], ['pe', 'PE', '', 5], ['r3m', '3-month return', '%', 5],
    ['cfo_pat', 'cash conversion', '×', 0.3],
  ];
  function differences(rows) {
    const out = [];
    const LENDER_NA = new Set(['roce', 'ebit_margin', 'de', 'cfo_pat']);
    for (const [k, word, unit, gap] of CMP) {
      const m = rows.filter((r) => !(LENDER_NA.has(k) && isFinancial(r))).map((r) => [r.sym, num(r[k])]).filter(([, v]) => v != null);
      if (m.length < 2) continue;
      m.sort((a, b) => b[1] - a[1]);
      const [hi, lo] = [m[0], m[m.length - 1]];
      if (hi[1] - lo[1] < gap) continue;
      const f = (v) => unit === '×' ? v.toFixed(2) + '×' : unit === '%' ? f1(v) + '%' : f1(v);
      out.push({ k, t: `${hi[0]} has the highest ${word} (${f(hi[1])}); ${lo[0]} the lowest (${f(lo[1])})` });
    }
    return out;
  }

  /* Definitions a reader can open next to the number. Short on purpose. */
  const GLOSSARY = {
    R: 'R is the risk taken on a trade: entry minus stop. A result of +2R made twice what was risked; −1R lost exactly the planned amount.',
    ATR: 'Average true range: how far the price typically moves in one bar, including gaps. Stops and targets are placed in ATR so they fit each stock\'s own noise.',
    ROCE: 'Return on capital employed: operating profit (EBIT) ÷ (equity + debt). Computed from filings — no data vendor publishes it.',
    'Relative strength': 'How a stock moved against a benchmark over the same window. Here the benchmark is the median of the ~1,000 names on the screen — the same universe every other Vision figure describes — rather than the 50 in the Nifty.',
    Breadth: 'How many names rose against how many fell. A broad rise lifts most stocks; a narrow one is carried by a few.',
    'Confidence interval': 'The range the true average plausibly lies in, given how few trades there are. If it spans zero, the sign of the result is not yet settled.',
    'PE percentile': 'Where today\'s price-to-earnings sits within this company\'s own history — 90th means higher than 90% of its past readings.',
    'Cash conversion': 'Operating cash flow ÷ reported profit. Below about 0.6 for years means profits are not arriving as cash.',
    'Weekly RSI': 'Relative strength index on weekly closes, 0–100. Above 50 means recent weekly gains outweigh losses.',
    'Volume spike': 'Today\'s volume ÷ its recent average. 2× means twice the usual shares changed hands.',
  };

  root.VisionInsight = { T, matters, changes, differences, oneMinute, GLOSSARY, SRC, isFinancial };
})(typeof globalThis !== 'undefined' ? globalThis : self);
