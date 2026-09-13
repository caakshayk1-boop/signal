/* ── GEMS — the daily crux ────────────────────────────────────────────────────
 *
 * ONE PAGE, AND IT ENDS HERE. The first version was a set of summaries that
 * each handed off to signal.askakshay.com for the actual working, which made it
 * a table of contents rather than a product: every section was three figures
 * and a link out. Those links are gone. Anything worth knowing about a row is
 * now UNDER the row — the verdict and its evidence, the ladder drawn to scale,
 * the engine's own record — so the page is read to its end rather than left.
 *
 * IT READS THE SAME FEEDS AS THE FULL SITE. Not a copy, not a snapshot — the
 * same /api routes and the same JSON. A digest that could disagree with the
 * site it summarises would be worse than no digest, and this repo has already
 * had two surfaces drift until one had to be frozen. For the same reason
 * NOTHING HERE RE-IMPLEMENTS A MODEL: the verdicts are the screen's own calls
 * and the R multiples are the ledger's own grades. A second scoring function
 * living here would be a second answer to the same question.
 *
 * WHAT IT WILL NOT DO: invent a number to fill a section. Every section renders
 * from what its feed actually returned, says so when that is nothing, and never
 * substitutes a plausible figure for a missing one. Where a feed is older than
 * today — the screen is priced at its last build, not live — the page says so
 * on the section rather than letting the figure pass as current.
 *
 * DISCLOSURE IS NOT DECORATION. The record section leads with a losing number
 * because that is the number. A digest that buries its own expectancy under
 * five setups is an advertisement.
 * ───────────────────────────────────────────────────────────────────────────── */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const jump = document.getElementById('jump');
  const LAUNCH = '2026-09-02';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Number(null) IS 0, AND 0 IS FINITE.
   * This read `Number.isFinite(Number(v)) ? … : null`, so every null numeric
   * in every feed became a real zero. A signal with target3:null drew a level
   * at ₹0 on its ladder, which pulled the scale's minimum to zero, squeezed
   * the real levels into the right-hand third, and printed "T3 is 18.7R" for
   * a target that does not exist. Number('') and Number([]) are 0 too.
   * Only an actual number, or a string that is one, is a number here. */
  const num = v => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v.trim()) : NaN);
    return Number.isFinite(n) ? n : null;
  };
  const pct = v => { const n = num(v); return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`; };
  const pp = v => { const n = num(v); return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)} pp`; };
  const rr = v => { const n = num(v); return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(3)}R`; };
  const inr = v => { const n = num(v); return n == null ? '—' : '₹' + n.toLocaleString('en-IN',
    { maximumFractionDigits: n >= 1000 ? 0 : 2 }); };
  /* SIX OF THE FORTY-FIVE OPEN SIGNALS ARE NOT IN RUPEES.
   * The ledger carries US equities and COMEX commodities alongside the NSE
   * book and labels each row's own `currency`. Hardcoding ₹ printed DUOL, a
   * dollar-priced US listing, at "₹154.46" — the same currency hole that once
   * sized a US name to ₹2.9 crore, this time on the page instead of in the
   * position. Money is formatted in the currency the row says it is. */
  const money = (v, cur) => {
    const n = num(v); if (n == null) return '—';
    const c = cur || '₹';
    return c === '₹' ? inr(n)
      : c + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  };
  const dir = v => { const n = num(v); return n > 0 ? 'up' : n < 0 ? 'dn' : ''; };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /* NaN is not JSON, and this book's feed has historically carried bare NaN
     tokens that stop JSON.parse dead. Stripped on the way in rather than
     letting one bad field take the whole page down. */
  const get = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(14000) });
      if (!r.ok) return null;
      return JSON.parse((await r.text()).replace(/\bNaN\b/g, 'null'));
    } catch { return null; }
  };

  const sec = (id, kicker, crux, body, note) => `
    <section class="sec" id="${id}">
      <div class="sec-h"><span class="sec-k">${esc(kicker)}</span>
        ${note ? `<span class="sec-n">${esc(note)}</span>` : ''}</div>
      <p class="crux">${crux}</p>
      ${body}
    </section>`;

  /* LABEL FIRST — the same change the full site made to both its tile
   * helpers. A figure printed above its own name has to be read twice: the
   * reader meets "51", then "47", then "0", and only on the second line of
   * each learns what was counted. Four of them in a row is that cost four
   * times. Name, then figure. */
  const figs = (items) => `<div class="figs">${items.filter(Boolean).map(([v, l, c]) =>
    `<div class="fig"><span>${esc(l)}</span><b class="${c || ''}">${v}</b></div>`).join('')}</div>`;

  /* ── THE EXPANDING ROW ────────────────────────────────────────────────────
   * <details>, not a JS toggle. It is keyboard-operable, screen-reader
   * labelled and open-able with JS disabled for free, and this page has no
   * other reason to ship an interaction layer. */
  const xr = (summary, detail) => detail
    ? `<details class="xr"><summary class="row">${summary}<span class="xr-c" aria-hidden="true"></span></summary>
         <div class="xd">${detail}</div></details>`
    : `<div class="row">${summary}</div>`;

  const rowHead = (rank, name, sub, val, sub2, tag, sym) => `
    <span class="rk">${rank}</span>
    <span class="rn"><b>${esc(name)}</b><span>${esc(sub)}</span>
      ${tag ? `<span class="tag ${tag[1]}">${esc(tag[0])}</span>` : ''}</span>
    <span class="rv"${sym ? ` data-gpx="${esc(sym)}"` : ''}>${val}${
      sub2 ? `<i class="${sub2[1]}">${sub2[0]}</i>` : ''}</span>`;

  /* ── WIDGETS ──────────────────────────────────────────────────────────────
   * Every one of these renders at its FINAL value and animates from a
   * transform, so the resting state is correct even when the animation never
   * runs — which is the normal case in a background tab, where rAF and CSS
   * animation are both throttled or stopped. Nothing here reads a value out
   * of an animation frame. */

  /* A proportion, drawn. Two segments and a hairline at the midpoint, because
     "268 advanced, 469 fell" is a shape before it is a pair of numbers. */
  const splitBar = (a, b, la, lb) => {
    const t = a + b; if (!t) return '';
    const ap = a / t * 100;
    return `<div class="sb" role="img" aria-label="${a} ${la}, ${b} ${lb}">
      <span class="sb-a" style="width:${ap.toFixed(2)}%"></span>
      <span class="sb-b" style="width:${(100 - ap).toFixed(2)}%"></span>
      <em class="sb-mid" aria-hidden="true"></em>
    </div>
    <div class="sb-l"><span class="up">${a} ${esc(la)}</span>
      <span class="dim">${ap.toFixed(0)}% / ${(100 - ap).toFixed(0)}%</span>
      <span class="dn">${b} ${esc(lb)}</span></div>`;
  };

  /* A 0–100 meter with its own midpoint marked, so 44% reads as "under half"
     without the reader doing arithmetic. */
  const meter = (label, v, good = 50) => {
    const n = num(v); if (n == null) return '';
    return `<div class="mt"><span class="mt-l">${esc(label)}</span>
      <span class="mt-t"><i class="${n >= good ? 'up' : 'dn'}" style="width:${clamp(n, 0, 100)}%"></i>
        <u style="left:${good}%" aria-hidden="true"></u></span>
      <span class="mt-v ${n >= good ? 'up' : 'dn'}">${n.toFixed(1)}%</span></div>`;
  };

  /* A diverging bar for a signed quantity, zero in the middle. Reading a
     negative as "a shorter positive bar" is the classic chart lie. */
  const divBar = (v, max) => {
    const n = num(v); if (n == null || !max) return '';
    const w = clamp(Math.abs(n) / max * 50, 0, 50);
    return `<span class="db" role="img" aria-label="${pp(n)}">
      <i class="${n < 0 ? 'dn' : 'up'}" style="${n < 0 ? `right:50%` : `left:50%`};width:${w}%"></i>
      <u aria-hidden="true"></u></span>`;
  };

  /* The cumulative-R curve. Drawn from the ledger's own graded multiples — no
     re-grading here, and the zero line is always in frame so a curve that
     never crosses it cannot be cropped into looking like one that does. */
  const curve = (pts) => {
    if (!pts || pts.length < 5) return null;
    const W = 700, H = 150, P = 4;
    const ys = pts.map(p => p.cum_r);
    const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
    const span = (hi - lo) || 1;
    const x = i => P + i / (pts.length - 1) * (W - P * 2);
    const y = v => P + (hi - v) / span * (H - P * 2);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cum_r).toFixed(1)}`).join('');
    const zero = y(0);
    const end = pts[pts.length - 1].cum_r;
    return `<div class="cv-w">
      <svg class="cv" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="Cumulative R over ${pts.length} closed trades, ending ${rr(end)}">
        <line class="cv-0" x1="0" y1="${zero.toFixed(1)}" x2="${W}" y2="${zero.toFixed(1)}"/>
        <path class="cv-l ${end >= 0 ? 'up' : 'dn'}" d="${d}"/>
      </svg>
      <div class="cv-x"><span>${esc(pts[0].date)}</span>
        <span class="${end >= 0 ? 'up' : 'dn'}">${rr(end)} cumulative</span>
        <span>${esc(pts[pts.length - 1].date)}</span></div>
    </div>`;
  };

  /* The ladder, to scale. Stop, entry and every target on one axis, so a
     target three times further away than the stop LOOKS three times further
     away. This is the whole reason the section stopped linking out. */
  const ladder = (r) => {
    const cur = r.currency || '₹';
    const e = num(r.entry), s = num(r.sl);
    /* > 0, not just non-null: a level of zero is a missing level however it
     * arrived, and one of them rescales the entire drawing. */
    const ts = [num(r.target1), num(r.target2), num(r.target3)].filter(v => v != null && v > 0);
    if (e == null || s == null || !ts.length) return '';
    const lo = Math.min(e, s, ...ts), hi = Math.max(e, s, ...ts);
    const span = (hi - lo) || 1;
    const at = v => ((v - lo) / span * 100).toFixed(2);
    const risk = Math.abs(e - s);
    /* MARKS ARE EMITTED IN POSITION ORDER AND STAGGERED WHEN THEY CROWD.
     *
     * Stop and entry are one risk-unit apart, and on a ladder whose full span
     * is ten risk-units that is a tenth of the width — so their price labels
     * overlapped and printed as a single illegible string on half the setups
     * measured. A second row is used only when the previous label is close
     * enough to collide, so a well-spread ladder still reads on one line.
     *
     * Emitting them sorted also makes the first/last edge-clamping in the CSS
     * correct: those rules exist to stop the outermost labels hanging off the
     * track, and they can only find the outermost marks if the outermost
     * marks are the first and last in the DOM. */
    const marks = [{ v: s, cls: 'dn', lab: 'Stop' }, { v: e, cls: 'ac', lab: 'Entry' }]
      .concat(ts.map((v, i) => ({ v, cls: 'up', lab: 'T' + (i + 1) })))
      .sort((a, b2) => a.v - b2.v);
    let lastPos = -99, lastRow = 1;
    const drawn = marks.map(m => {
      const pos = Number(at(m.v));
      const row = (pos - lastPos) < 14 ? (lastRow ? 0 : 1) : 0;
      lastPos = pos; lastRow = row;
      return `<i class="ld-m ${m.cls}${row ? ' r1' : ''}" style="left:${pos.toFixed(2)}%">
        <b>${esc(m.lab)}</b><em>${money(m.v, cur)}</em></i>`;
    }).join('');
    return `<div class="ld" role="img" aria-label="Levels from ${money(lo, cur)} to ${money(hi, cur)}">
        <span class="ld-t"></span>
        <span class="ld-risk" style="left:${at(Math.min(e, s))}%;width:${(Math.abs(e - s) / span * 100).toFixed(2)}%"></span>
        ${drawn}
      </div>
      <div class="ld-n">Risk ${money(risk, cur)} a share. ${ts.map((t, i) =>
        `<b>T${i + 1}</b> is ${(Math.abs(t - e) / risk).toFixed(1)}R`).join(' · ')}.</div>
      ${(Math.abs(ts[ts.length - 1] - e) / risk) > 10 ? `<p class="ld-warn">
        <b>These levels look wrong, and they are shown as filed.</b> The furthest target sits
        more than ten times the risk away. The best move this book has ever measured on a
        closed trade is <b>4.43R</b>, and the 90th percentile of open profit is 2.28R — a
        target at this distance is not a target, it is an artefact of a stop set too close
        to the entry.</p>` : ''}`;
  };

  /* ── the page ───────────────────────────────────────────────────────────── */
  async function build() {
    const [screen, stats, sigs, insti, ipo, ipoLive] = await Promise.all([
      get('/screen.json'), get('/api/stats'), get('/api/signals?limit=400'),
      get('/institutional.json'), get('/ipo.json'),
      /* THE SUBSCRIPTION BOOK HAS TO BE LIVE OR IT IS WORTHLESS.
       * ipo.json is built once, around midnight, so its subscription_x was
       * up to a full day stale — and a book moves fastest on its final day,
       * which is exactly when someone is deciding. /api/ipo-live reads NSE's
       * current-issue endpoint behind a 15-minute edge cache; the full site
       * already used it and this page did not. */
      get('/api/ipo-live'),
    ]);

    const d = new Date();
    document.getElementById('topDate').textContent =
      d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }).toUpperCase();

    const rows = (screen && screen.rows) || [];
    const ledger = (sigs && (sigs.signals || sigs.rows)) || [];
    const since = ledger.filter(r => String(r.date || '').slice(0, 10) >= LAUNCH);
    const out = [];
    const nav = [];
    const add = (id, label, html) => { nav.push([id, label]); out.push(html); };
    /* The ledger writes NIACL.NS and the screen keys on NIACL, so the join
     * goes through a stripped symbol rather than the string it was handed. */
    const bare = s => String(s || '').trim().toUpperCase().replace(/\.(NS|BO)$/, '');
    const SCR_BY = new Map(rows.map(r => [bare(r.sym), r]));
    const screenOf = s => SCR_BY.get(bare(s)) || null;
    const nameOf = s => (screenOf(s) || {}).name || '';

    /* ── THE YEAR'S RANGE, AND MOMENTUM ON A MONTHLY CLOCK ──────────────────
     * A setup card carried entry, stop, targets and R:R and nothing about
     * where the name sits in its own year or whether it is already extended.
     * Both are on the screen row already — high52/low52, and rsi_m, which the
     * screen computes by sampling closes every 21 trading days. 705 of the 750
     * rows carry it; the rest say so rather than showing a blank. */
    const rangeBlock = (sr, sym, market) => {
      /* THREE CASES, AND EACH ONE SAYS WHICH IT IS.
       *
       * A row of em-dashes under "52W HIGH" reads as a bug. There are three
       * distinct reasons this block can be empty and they are not the same
       * fact, so the page names them instead of blanking:
       *
       *   1. The name is not on the 750-stock screen at all — six of the open
       *      setups are US equities and COMEX commodities (COIN, DUOL, MRK,
       *      NGAS, SMCI, XAUUSD), which that screen does not cover.
       *   2. It is on the screen but has not traded a full year, so there is
       *      no 52-week range to quote. JAINREC is one: listed recently, real
       *      price, real daily RSI, no high52 and no monthly RSI, because the
       *      screen requires 240 sessions for one and fifteen months for the
       *      other.
       *   3. It has both, and they are shown. */
      if (!sr) {
        return `<h4 class="xd-h">The year, and momentum</h4>
          <p class="said"><b>${esc(sym || 'This name')}</b> is not on the Indian
            screen${market && market !== 'NSE' ? ` — it is ${esc(market)}` : ''}, so its
            52-week range and monthly RSI are not measured here. The levels above are the
            engine's own and stand on their own.</p>`;
      }
      const lo = num(sr.low52), hi = num(sr.high52), px = num(sr.price);
      const rsiD = num(sr.rsi), rsiM = num(sr.rsi_m);
      const hasRange = lo != null && hi != null && hi > lo && px != null;
      const at = hasRange ? Math.max(0, Math.min(100, (px - lo) / (hi - lo) * 100)) : null;
      const tone = v => v == null ? '' : v >= 70 ? 'dn' : v <= 35 ? 'up' : '';
      const young = !hasRange;
      return `<h4 class="xd-h">The year, and momentum</h4>
        ${hasRange ? `<div class="yr" role="img"
            aria-label="${inr(px)} sits ${at.toFixed(0)}% up a 52-week range of ${inr(lo)} to ${inr(hi)}">
            <i style="left:${at.toFixed(1)}%"></i></div>
          <div class="yr-l"><span>${inr(lo)}<em>52w low</em></span>
            <span class="dim">${at.toFixed(0)}% up the range</span>
            <span>${inr(hi)}<em>52w high</em></span></div>` : ''}
        ${figs([
          hasRange ? [num(sr.from_high) == null ? '—' : Number(sr.from_high).toFixed(1) + '%', 'off 52w high'] : null,
          [rsiD == null ? '—' : Math.round(rsiD), 'RSI daily', tone(rsiD)],
          [rsiM == null ? 'not measured' : Math.round(rsiM), 'RSI monthly', tone(rsiM)],
          [num(sr.atr_pct) == null ? '—' : Number(sr.atr_pct).toFixed(1) + '%', 'a typical day'],
        ].filter(Boolean))}
        ${young ? `<p class="said"><b>No 52-week range, and no monthly RSI.</b>
          ${esc(sr.sym)} has not traded long enough: the screen needs 240 sessions before it
          will quote a year's high and low, and about fifteen months before a monthly RSI
          means anything. Both are left unmeasured rather than computed off a short history
          and presented as if they were the real thing.</p>` : ''}
        ${!young && rsiM != null && rsiM >= 70 ? `<p class="said"><b>Monthly RSI is
          ${Math.round(rsiM)}.</b> On a monthly clock that is stretched — the setup can still
          work, but it is being taken late in a move rather than early in one.</p>` : ''}
        ${!young && rsiM == null ? `<p class="said">Monthly RSI needs about fifteen months of
          closes and this name does not have them, so it is shown as not measured.</p>` : ''}`;
    };

    /* THE SCREEN IS PRICED AT ITS LAST BUILD, NOT AT THIS MOMENT.
     * Its own price_date is the only honest label for every figure derived
     * from it, and on a Monday morning that is Friday's close. The radar on
     * the full site shipped a stock at +17.70% for four days on exactly this
     * mistake. Every screen-derived section carries the date. */
    const asOf = (screen && screen.price_date) || (screen && screen.built_on) || '';
    const stale = asOf ? `screen priced ${asOf}` : '';

    /* ── 1. THE MARKET ─────────────────────────────────────────────────────
     * Breadth over 750 names, not an index level. An index says what fifty
     * weighted names did; breadth says what the market did. */
    const b = screen && screen.breadth;
    if (b) {
      const adv = b.counted ? b.advancing / b.counted * 100 : null;
      const tone = adv == null ? '' : adv >= 55 ? 'up' : adv <= 42 ? 'dn' : '';
      const word = adv == null ? 'unclear' : adv >= 55 ? 'broad strength'
        : adv <= 42 ? 'broad decline' : 'mixed';
      add('market', 'Market', sec('market', 'The market',
        `<b>${b.advancing}</b> of ${b.counted} names advanced and <b>${b.declining}</b> fell —
         <span class="${tone}">${word}</span>. <b>${b.above200}%</b> hold their 200-day.`,
        splitBar(b.advancing, b.declining, 'advancing', 'declining') +
        `<div class="mts">
          ${meter('Above the 20-day', b.above20)}
          ${meter('Above the 50-day', b.above50)}
          ${meter('Above the 200-day', b.above200)}
        </div>` +
        figs([
          [`${b.at_52w_high}`, 'at 52w high'],
          [pct(b.median_1m), 'median 1M', dir(b.median_1m)],
          [pct(b.nifty_1m), 'Nifty 1M', dir(b.nifty_1m)],
          [esc(b.label || '—'), 'breadth reading'],
        ]) +
        `<p class="said">The meters mark the halfway line, not a target. More than half a
          market above its 200-day is an uptrend by the only definition that does not
          require an opinion; below it, the average name is in a downtrend whatever the
          index says.</p>`,
        b.as_of ? `breadth as of ${b.as_of}` : stale));
    }

    /* ── 2. THE SCREEN'S OWN CALL ──────────────────────────────────────────
     * One verdict per stock, already computed on the full site. This section
     * DOES NOT re-derive it: it counts the calls and shows the reasoning the
     * screen attached, including the flags that argue against each name. */
    const vds = rows.map(r => r.vd && r.vd.c).filter(Boolean);
    if (vds.length) {
      const cnt = k => vds.filter(v => v === k).length;
      const order = [['BUY', 'up'], ['WATCH', 'flat'], ['WAIT', 'warn'], ['AVOID', 'dn']];
      const buys = rows.filter(r => r.vd && r.vd.c === 'BUY' && (r.turnover_cr ?? 0) >= 5)
        .sort((x, y) => (num(y.rs3m) ?? -1e9) - (num(x.rs3m) ?? -1e9)).slice(0, 6);
      add('verdicts', 'Verdicts', sec('verdicts', `The call on ${rows.length} names`,
        `<b>${cnt('BUY')}</b> rate a buy, <b>${cnt('WATCH')}</b> a watch,
         <b class="dn">${cnt('AVOID')}</b> an avoid. Most of a market is
         <span class="dim">neither</span> at any moment, and a screen that says otherwise
         is not screening.`,
        `<div class="vd-bar" role="img" aria-label="${order.map(([k]) => `${cnt(k)} ${k}`).join(', ')}">
          ${order.map(([k, c]) => {
            const w = cnt(k) / vds.length * 100;
            return w < 0.5 ? '' : `<span class="vd-s ${c}" style="width:${w.toFixed(2)}%"
              title="${k} ${cnt(k)}"><em>${w >= 8 ? esc(k) : ''}</em></span>`;
          }).join('')}
        </div>
        <div class="vd-k">${order.map(([k, c]) =>
          `<span><i class="${c}"></i>${esc(k)} <b>${cnt(k)}</b></span>`).join('')}</div>` +
        (buys.length ? `<h3 class="sub">Buy-rated, strongest relative strength</h3>
          <div class="rows">${buys.map((r, i) => xr(
            rowHead(i + 1, r.sym, `${esc(r.sector || r.ind || '')}${r.vd.l ? ' · ' + esc(r.vd.l) : ''}`,
              inr(r.price), [pct(r.r1m) + ' 1M', dir(r.r1m)], ['Buy', 'up'], r.sym),
            `<p class="xd-q">${esc(r.vd.o || '')}</p>
             ${figs([
               [pct(r.r1w), '1 week', dir(r.r1w)],
               [pct(r.r3m), '3 months', dir(r.r3m)],
               [num(r.from_high) == null ? '—' : `${Number(r.from_high).toFixed(1)}%`, 'off 52w high'],
               [num(r.rsi) == null ? '—' : Number(r.rsi).toFixed(0), 'RSI'],
             ])}
             ${(r.vd.f && r.vd.f.length) ? `<h4 class="xd-h">What argues against it</h4>
               <ul class="flags">${r.vd.f.map(f =>
                 `<li><b>${esc(f.w)}</b>${f.e ? `<span>${esc(f.e)}</span>` : ''}</li>`).join('')}</ul>`
               : `<p class="said">The screen attached no warning flags to this name.</p>`}
             <p class="said">Conviction <b>${esc(r.vd.k || '—')}</b>. A verdict is the screen's
               reading of price and statements — not a recommendation, and not a position.</p>`
          )).join('')}</div>` : '') +
        /* NSE's Nifty500 Ahimsa index — MEMBERSHIP, not a score, and the screen
         * publishes no per-company quotient because NSE publishes none. Three
         * states, and the third matters: true, false, and null for "the list
         * could not be read", which is not the same as being left out of it.
         * Counted only over rows that state it, so an unreadable list reports
         * nothing rather than reporting zero. */
        (() => {
          const known = rows.filter(r => r.ahimsa === true || r.ahimsa === false);
          if (!known.length) {
            return `<p class="said">NSE's Nifty500 Ahimsa list could not be read on this
              build, so no name on this page is marked either way.</p>`;
          }
          const inIdx = known.filter(r => r.ahimsa === true);
          const buyIn = inIdx.filter(r => r.vd && r.vd.c === 'BUY').length;
          return `<p class="said"><b>${inIdx.length}</b> of the ${known.length} names here sit in
            NSE's <b>Nifty500 Ahimsa</b> index${buyIn ? `, and <b>${buyIn}</b> of those rate a buy` : ''}.
            It is membership in an index, not a score: NSE publishes the list and no
            per-company figure, so there is none to show — and it is deliberately kept out
            of the composite, because nothing measured says a constituent outperforms.</p>`;
        })() +
        `<p class="said">Every call above is the screen's, computed on the same run that
          priced this page. Nothing on this page re-scores a stock.</p>`,
        stale));
    }

    /* ── 3. THE RECORD, above any idea ─────────────────────────────────────
     * A digest that leads with picks and buries the record is an advert. */
    const T = stats && stats.totals;
    const H = stats && stats.headline;
    const eng = (stats && stats.by_signal_type) || [];
    /* ── WHICH LEDGER IS THIS? ─────────────────────────────────────────────
     * /api/stats is ALL TIME — it opens at 2026-08-03, weeks before this site
     * started keeping its own record. The headline therefore read "85 closed
     * trades, 14.1% winners, −0.516R" on a page whose every other section
     * counts from LAUNCH, where TWO have closed. Both numbers are true and
     * only one of them is this site's, so the crux now leads with the one it
     * is accountable for and the older ledger is shown underneath, labelled.
     * Same fault, and same fix, as the engine cards on /engines. */
    const closedSince = since.filter(r => String(r.status || '').toUpperCase() !== 'OPEN'
                                       && r.r_multiple != null);
    const openSince = since.filter(r => String(r.status || '').toUpperCase() === 'OPEN');
    const winSince = closedSince.filter(r => num(r.r_multiple) > 0).length;
    /* The curve, drawn from this site's OWN closes in the order they closed.
     * It used to render stats.equity_curve, which starts 2026-08-03 and is the
     * pre-launch book. Below five points a line is noise with a trend through
     * it, so it simply does not appear. */
    const sinceCurve = (() => {
      const cl = closedSince.slice().sort((a, b) =>
        String(a.closed_at || a.date || '').localeCompare(String(b.closed_at || b.date || '')));
      let cum = 0;
      return cl.map((r, i) => ({ i: i + 1, date: String(r.closed_at || r.date || '').slice(0, 10),
                                 r: num(r.r_multiple), cum_r: (cum += (num(r.r_multiple) || 0)) }));
    })();
    const sumR = closedSince.reduce((a, r) => a + (num(r.r_multiple) || 0), 0);
    if (T && H) {
      const maxAbs = Math.max(...eng.map(e => Math.abs(num(e.avg_r) || 0)), 0.001);
      add('record', 'Record', sec('record', 'The record',
        closedSince.length === 0
          ? `<b>${since.length}</b> signals published since ${LAUNCH} and
             <b>${openSince.length}</b> are still open — <b>none has closed</b>. This site has
             <span class="dim">no win rate and no expectancy of its own yet</span>, and it will
             not invent one from the older ledger below.`
          : `<b>${closedSince.length}</b> closed since ${LAUNCH},
             <b>${winSince}</b> of them winners, <b class="${dir(sumR)}">${rr(sumR / closedSince.length)}</b>
             each. At ${closedSince.length} closed that is <span class="dim">far too few to mean
             anything</span>. <b>No engine is cleared for capital.</b>`,
        /* Written out by hand rather than through figs(); it has to carry the
         * same order, or this one block reads upside down against every other
         * on the page. */
        `<div class="figs">
          <div class="fig"><span>published since ${esc(LAUNCH)}</span><b>${since.length}</b></div>
          <div class="fig"><span>still open</span><b>${openSince.length}</b></div>
          <div class="fig"><span>closed and scored</span><b>${closedSince.length}</b></div>
          <div class="fig"><span>per trade</span><b class="${closedSince.length ? dir(sumR) : ''}">${
            closedSince.length ? rr(sumR / closedSince.length) : '—'}</b></div>
        </div>` +
        (closedSince.length >= 5 ? (curve(sinceCurve) || '') : '') +
        `<div class="call dnb"><h3>Read this before the setups below</h3>
          <p>Everything here is <b>paper</b>. The bar is <b>30 closed trades at t&nbsp;≥&nbsp;2</b>
             and nothing has reached it${closedSince.length
               ? ` — this site has <b>${closedSince.length}</b> closed` : ''}. These are setups
             to examine, not calls to take.</p></div>
        ${/* ── THE PRE-LAUNCH LEDGER IS NOT ON THIS PAGE ────────────────────
            * It was: 86 trades closed before launch, a -40.4R curve, and an
            * all-time table of every engine. All of it true, none of it this
            * site's, and it dominated the section by volume — a reader saw a
            * long red line and four figures from a configuration that no
            * longer exists before reaching the two trades that are actually
            * this book's record.
            *
            * Removed on instruction, and the same call already made on
            * /signals. It is not deleted from anywhere: the full history is in
            * the ledger and on the full site's own record. It is simply not
            * what a page headed "the record" should lead with. */''}`,
        `since ${esc(LAUNCH)}`));
    }

    /* ── 4. TODAY'S SETUPS ─────────────────────────────────────────────────
     * Open signals since launch, each opening onto its own ladder. */
    /* INDIAN ONLY, because this page says so at the top.
     * The ledger carries every engine, and top5_pick trades US equities and
     * COMEX gold alongside the NSE ones. Ordering is newest-first, so on any
     * day that engine published last the "Indian market in one page" opened
     * with AAPL, META and a gold future — 18 of the 158 open setups are not
     * Indian and they were crowding out the 140 that are. Filtered on the
     * rupee, which is the currency field the feed sets per row, rather than on
     * a symbol suffix: `.NS` is absent on plenty of NSE rows and present on
     * none of the US ones. The full multi-market ledger stays on Signal. */
    const open = since.filter(r => String(r.status || '').toUpperCase() === 'OPEN'
                               && r.entry && r.sl && r.target1
                               && String(r.currency || '₹') === '₹');
    const seen = new Set();
    const picks = open.filter(r => {
      const k = String(r.symbol || '').toUpperCase();
      if (seen.has(k)) return false; seen.add(k); return true;
    /* NOT SORTED BY REWARD:RISK.
     * That ranking put the widest ratio first, and the widest ratio is
     * produced by the tightest stop rather than the best setup — so the six
     * it chose were the six with the most questionable levels, led by a 38R
     * target. Newest first: this is a daily page, and the useful ordering is
     * what the engines published most recently. */
    }).sort((a, b2) => String(b2.date || '').localeCompare(String(a.date || ''))).slice(0, 6);
    add('setups', 'Setups', sec('setups', 'Open setups',
      picks.length
        ? `<b>${open.length}</b> open since ${LAUNCH}. These are the ${picks.length} most
           recently published — <span class="dim">an order of arrival, not of merit</span>.`
        : 'Nothing is open. An empty list is a result — the engines publish when a setup clears their floors, and not otherwise.',
      picks.length
        ? `<div class="rows">${picks.map((r, i) => xr(
            rowHead(i + 1, r.symbol, `${esc(r.signal_type || '')} · ${esc(r.timeframe || '')}${
                r.market && r.market !== 'NSE' ? ' · ' + esc(r.market) : ''}`,
              money(r.entry, r.currency), [`stop ${money(r.sl, r.currency)}`, 'dn'],
              num(r.rr) ? [`${Number(r.rr).toFixed(1)}R`, 'flat'] : null),
            ladder(r) +
            rangeBlock(screenOf(r.symbol), r.symbol, r.market) +
            figs([
              [money(r.entry, r.currency), 'entry'],
              [money(r.sl, r.currency), 'stop', 'dn'],
              [money(r.target1, r.currency), 'first target', 'up'],
              [num(r.rr) ? Number(r.rr).toFixed(2) + 'R' : '—', 'reward:risk'],
            ]) +
            (nameOf(r.symbol) ? `<p class="said"><b>${esc(nameOf(r.symbol))}</b></p>` : '') +
            (r.remarks ? `<p class="xd-q">${esc(String(r.remarks).slice(0, 240))}</p>` : '') +
            `<p class="said">Published ${esc(String(r.date || '').slice(0, 10))} by
              <b>${esc(r.signal_type || 'an engine')}</b>, which is on <b>paper</b>. The levels
              are the engine's; the outcome is recorded whichever way it goes.</p>`
          )).join('')}</div>`
        : `<div class="empty">No open setup carries complete levels today.</div>`,
      `${open.length} open since launch`));

    /* ── 5. INSTITUTIONAL FLOW — the distinctive one ───────────────────────
     * The only section here that no free Indian markets page carries: FII and
     * DII holding quarter on quarter, from the companies' own filings. */
    if (insti && insti.rows) {
      const iv = Object.entries(insti.rows).filter(([, x]) => x.quality === 'complete');
      const accum = iv.filter(([, x]) => x.signal === 'strong_accumulation')
        .sort((a, b2) => (b2[1].insti_pp || 0) - (a[1].insti_pp || 0)).slice(0, 6);
      const nAcc = iv.filter(([, x]) => x.signal === 'strong_accumulation').length;
      const dist = iv.filter(([, x]) => x.signal === 'distribution').length;
      const maxPp = Math.max(...iv.map(([, x]) => Math.abs(num(x.insti_pp) || 0)), 0.001);
      add('flow', 'Flow', sec('flow', 'Institutional flow',
        nAcc
          ? `<b>${nAcc}</b> companies had both foreign and domestic institutions add last
             quarter; <b class="dn">${dist}</b> had both cut. Measured on
             <b>${iv.length}</b> of the ${Object.keys(insti.rows).length} screened.`
          : `No company had both foreign and domestic institutions add materially last quarter.`,
        figs([
          [iv.length, 'measured'],
          [nAcc, 'both adding', 'up'],
          [dist, 'both cutting', 'dn'],
          [iv.filter(([, x]) => x.insti_streak >= 3).length, '3Q+ streak'],
        ]) +
        (accum.length ? `<div class="rows">${accum.map(([sym, x], i) => xr(
            rowHead(i + 1, sym, nameOf(sym) || x.period, pp(x.insti_pp),
              [`FII ${pp(x.fii_pp)}`, dir(x.fii_pp)], ['Both adding', 'up']),
            `<div class="db-w">${divBar(x.insti_pp, maxPp)}</div>
             ${figs([
               [pp(x.fii_pp), 'FII quarter', dir(x.fii_pp)],
               [pp(x.dii_pp), 'DII quarter', dir(x.dii_pp)],
               [x.insti_streak == null ? '—' : x.insti_streak + 'Q', 'adding streak'],
               [esc(x.period || '—'), 'period'],
             ])}
             <p class="said">${esc(x.signal_label || 'Both institution types added.')}
               A quarter-on-quarter change is measured only across <b>consecutive</b> filed
               quarters — a gap is left unmeasured rather than filled with a zero.</p>`
          )).join('')}</div>` : '') +
        `<p class="said">Filed quarterly, within 21 days of the quarter end — this is
          <b>weeks to months old by design</b>. It says who owned the company at a past
          date, not who is buying today.</p>`,
        insti.latest_period_end ? `latest ${insti.latest_period_end}` : ''));
    }

    /* ── 6. IPO ────────────────────────────────────────────────────────────── */
    const openIpo = (ipo && ipo.open) || [];
    const upcoming = (ipo && ipo.upcoming) || [];
    /* The live book, keyed by symbol, so a row can prefer it over the mirror. */
    const liveBook = new Map(((ipoLive && ipoLive.issues) || []).map(i => [i.symbol, i]));
    const cr = v => { const n = num(v); return n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN') + ' cr'; };
    const xfmt = v => { const n = num(v); return n == null ? null : `${n.toFixed(2)}x`; };
    if (openIpo.length || upcoming.length) {
      const anyLive = [...liveBook.values()].length;
      add('ipo', 'IPO', sec('ipo', 'Primary market',
        openIpo.length
          ? `<b>${openIpo.length}</b> book${openIpo.length === 1 ? '' : 's'} open now,
             <b>${upcoming.length}</b> coming.${anyLive
               ? ` Subscription is read <b>live from NSE</b>, not from this morning's build.` : ''}`
          : `No book is open. <b>${upcoming.length}</b> upcoming.`,
        `<div class="rows">${[...openIpo, ...upcoming].slice(0, 8).map((x, i) => {
          const L = liveBook.get(x.symbol);
          const subLive = L ? num(L.total_x) : null;
          const subMirror = num(x.subscription_x);
          const sub = subLive != null ? subLive : subMirror;
          const subSrc = subLive != null ? 'live' : subMirror != null ? "today's build" : null;
          const pe = num(x.pe_post_issue), ppe = num(x.peer_pe);
          return xr(
            rowHead(i + 1, x.symbol || '—', `${esc(x.company || '')}${x.sector ? ' · ' + esc(x.sector) : ''}`,
              x.price_band ? esc(String(x.price_band).replace(/Rs\./g, '₹')) : '—',
              sub != null ? [`${xfmt(sub)} subscribed`, sub >= 1 ? 'up' : 'dn'] : null,
              x.phase === 'open' ? ['Open now', 'up'] : ['Upcoming', 'flat']),
            figs([
              [cr(x.issue_size_cr), 'issue size'],
              [num(x.lot_size) == null ? '—' : String(Math.round(x.lot_size)), 'shares a lot'],
              [num(x.min_investment) == null ? '—' : inr(x.min_investment), 'minimum'],
              [x.gmp_text ? esc(x.gmp_text) : 'not measured', 'grey market'],
            ]) +
            (L && L.categories && L.categories.length
              ? `<h4 class="xd-h">The book right now</h4>
                 <div class="rows">${L.categories.map(c => `<div class="row">
                   ${rowHead('', c.cat, `${(num(c.bid) || 0).toLocaleString('en-IN')} of ${(num(c.offered) || 0).toLocaleString('en-IN')} shares`,
                     `<span class="${num(c.x) >= 1 ? 'up' : 'dn'}">${xfmt(c.x) || '—'}</span>`, null, null)}
                 </div>`).join('')}</div>
                 <p class="said">Read from NSE at
                   <b>${esc(String(ipoLive.at || '').slice(11, 16))} UTC</b>, cached fifteen
                   minutes. Retail, NII and QIB are the headline categories; the sub-totals
                   underneath them are not repeated.</p>`
              : sub != null
                ? `<p class="said">Subscribed <b>${xfmt(sub)}</b>, from ${esc(subSrc)}.
                   ${subLive == null ? 'NSE did not answer for this issue, so this is the figure from the overnight build and may be well behind the book.' : ''}</p>`
                : `<p class="said">No subscription figure — the book has not opened.</p>`) +
            `<h4 class="xd-h">What it earns, and what it costs</h4>` +
            figs([
              [cr(x.revenue_cr), 'revenue'],
              [cr(x.pat_cr), 'profit after tax'],
              [pe == null ? 'not measured' : pe.toFixed(1), 'P/E post issue'],
              [ppe == null ? 'not measured' : ppe.toFixed(1),
                x.peer_pe_n ? `peer median (${x.peer_pe_n})` : 'peer median'],
            ]) +
            (pe != null && ppe != null ? `<p class="said">Priced at
              <b>${pe.toFixed(1)}</b> against a peer median of <b>${ppe.toFixed(1)}</b> —
              <b class="${pe <= ppe ? 'up' : 'dn'}">${pe <= ppe
                ? `${((1 - pe / ppe) * 100).toFixed(0)}% below its peers`
                : `${((pe / ppe - 1) * 100).toFixed(0)}% above its peers`}</b>.
              ${num(x.roce_pct) != null ? `ROCE ${Number(x.roce_pct).toFixed(1)}%.` : ''}</p>` : '') +
            ((x.reads_for && x.reads_for.length) ? `<h4 class="xd-h">Reads for</h4>
              <ul class="flags flags-ok">${x.reads_for.map(f =>
                `<li><b>${esc(typeof f === 'string' ? f : (f.t || f.w || ''))}</b>${
                  (f && f.k) ? `<span>${esc(f.k)}</span>` : ''}</li>`).join('')}</ul>` : '') +
            ((x.reads_against && x.reads_against.length) ? `<h4 class="xd-h">Reads against</h4>
              <ul class="flags">${x.reads_against.map(f =>
                `<li><b>${esc(typeof f === 'string' ? f : (f.t || f.w || ''))}</b>${
                  (f && f.k) ? `<span>${esc(f.k)}</span>` : ''}</li>`).join('')}</ul>` : '') +
            `<p class="said">Grey-market prices are unofficial, unregulated and not a
              forecast. Everything else here is from the prospectus and NSE.</p>`
          );
        }).join('')}</div>`,
        `${openIpo.length} open · ${upcoming.length} upcoming`));
    }

    /* ── 7. AT A LEVEL ─────────────────────────────────────────────────────
     *
     * THE WIRE IS GONE. It read /news.json, which this repo pulls from the
     * trading-dashboard build — the same feed that makes news.askakshay.com.
     * A digest of the signal desk that closed on somebody else's headlines was
     * borrowing its last section, and it was the one section here whose source
     * was not this site's own measurement.
     *
     * What replaced it is the question the rest of the page sets up and never
     * answers: which names are actually AT a level right now. Everything here
     * is from the screen — the year's range and the moving averages — and a
     * name qualifies by arithmetic, not by selection. */
    const near = rows
      .filter(r => (r.turnover_cr ?? 0) >= 5 && num(r.price) && num(r.high52) && num(r.sma200))
      .map(r => {
        const px = num(r.price);
        const cands = [
          [num(r.high52), '52-week high'], [num(r.low52), '52-week low'],
          [num(r.sma50), '50-day average'], [num(r.sma200), '200-day average'],
        ].filter(([v]) => v);
        let best = null;
        for (const [v, l] of cands) {
          const d = Math.abs(px - v) / px * 100;
          if (best == null || d < best.d) best = { d, v, l };
        }
        if (!best || best.d > 2) return null;
        /* A LEVEL'S SIDE IS NOT DECIDED BY A ROUNDING TIE.
         * This set `above: v > px`, so a stock sitting exactly ON its 52-week
         * high failed that test by a fraction of a rupee and was labelled
         * "on support" — under a sentence reading "trades 0.0% above its
         * 52-week high". A year's high is resistance until it is cleared, and
         * a year's low is support until it breaks; only the moving averages
         * take their side from where the price happens to be. */
        const AT = 0.15;                       // inside this, it is simply AT the level
        const at = best.d < AT;
        const isHigh = /high/.test(best.l), isLow = /low/.test(best.l);
        const side = isHigh ? (px > best.v ? 'sup' : 'res')
                   : isLow  ? (px < best.v ? 'res' : 'sup')
                   : best.v > px ? 'res' : 'sup';
        return { r, ...best, at, side };
      })
      .filter(Boolean)
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);

    add('levels', 'Levels', sec('levels', 'At a level',
      near.length
        ? `<b>${near.length}</b> liquid names sit within <b>2%</b> of a level that matters —
           the year's high or low, or the average that defines their trend. A level is only
           interesting while price is at it.`
        : `No liquid name is within 2% of its 52-week range or a defining average today.`,
      near.length
        ? `<div class="rows">${near.map((x, i) => xr(
            rowHead(i + 1, x.r.sym, `${esc(x.r.name || '')}`,
              inr(x.r.price), [x.at ? 'at the level' : `${x.d.toFixed(1)}% away`,
                x.side === 'res' ? 'dn' : 'up'],
              [x.at ? `At its ${x.l.replace('-week', 'w')}` : x.side === 'res' ? 'Under resistance' : 'On support',
               x.at ? 'warn' : x.side === 'res' ? 'warn' : 'up'], x.r.sym),
            `<p class="xd-q">${esc(x.r.sym)} trades ${x.at
               ? `right at its <b>${esc(x.l)}</b> of ${inr(x.v)}`
               : `${x.d.toFixed(1)}% ${x.v > num(x.r.price) ? 'below' : 'above'}
                  its <b>${esc(x.l)}</b> at ${inr(x.v)}`}.</p>
             ${figs([
               [pct(x.r.r1m), '1 month', dir(x.r.r1m)],
               [num(x.r.rsi) == null ? '—' : Math.round(x.r.rsi), 'RSI 14'],
               [num(x.r.from_high) == null ? '—' : Number(x.r.from_high).toFixed(1) + '%', 'off 52w high'],
               [num(x.r.atr_pct) == null ? '—' : Number(x.r.atr_pct).toFixed(1) + '%', 'a typical day'],
             ])}
             ${x.r.lad && x.r.lad.s != null ? `<h4 class="xd-h">If it were traded</h4>
               ${figs([
                 [inr(x.r.lad.e), 'entry'],
                 [inr(x.r.lad.s), 'stop', 'dn'],
                 [x.r.lad.t && x.r.lad.t[0] ? inr(x.r.lad.t[0][0]) : '—', 'first target', 'up'],
                 [num(x.r.lad.rr) == null ? '—' : Number(x.r.lad.rr).toFixed(2) + 'R', 'reward:risk'],
               ])}` : ''}
             <p class="said">${x.r.vd && x.r.vd.o ? esc(x.r.vd.o) + ' ' : ''}A level being NEAR
               is not a signal — it is where a decision gets made. Nothing here is a call.</p>`
          )).join('')}</div>`
        : `<div class="empty">Nothing is at a level worth naming today.</div>`,
      stale));

    app.innerHTML = out.join('');
    jump.innerHTML = nav.map(([id, label]) =>
      `<button type="button" data-to="${id}">${esc(label)}</button>`).join('');
    wire_up(nav);

    /* ── LIVE PRICES OVER THE SCREEN'S BUILD ──────────────────────────────
     * Every price in the Verdicts and Levels sections comes from screen.json,
     * which is priced at its last build — on a Monday morning that is Friday's
     * close. The full site's radar shipped a stock at +17.70% for four days on
     * exactly that, so this page does not repeat it: one request for the names
     * it actually shows, applied after paint, and the row says "live" once it
     * has landed. Nothing here waits on it — a page that renders is worth more
     * than a page that is a fraction more current. */
    const syms = [...new Set([...app.querySelectorAll('[data-gpx]')]
      .map(el => el.getAttribute('data-gpx')).filter(Boolean))].slice(0, 40);
    if (syms.length) {
      const q = await get(`/api/signals?px=${syms.map(encodeURIComponent).join(',')}`);
      const quotes = q && q.quotes;
      if (quotes) {
        for (const el of app.querySelectorAll('[data-gpx]')) {
          const v = quotes[el.getAttribute('data-gpx')];
          if (!v || v.price == null) continue;
          const sub = el.querySelector('i');
          el.textContent = inr(v.price);
          if (sub) el.appendChild(sub);
          const tag = document.createElement('em');
          tag.className = 'gpx-live';
          tag.textContent = 'live';
          el.appendChild(tag);
        }
        for (const s of app.querySelectorAll('.sec-n')) {
          if (/screen priced/.test(s.textContent)) s.textContent += ' · prices live';
        }
      }
    }
  }

  function wire_up(nav) {
    jump.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      const el = document.getElementById(btn.dataset.to);
      if (el) el.scrollIntoView({ block: 'start' });
    }));
    const mark = (id) => jump.querySelectorAll('button').forEach(b =>
      b.setAttribute('aria-current', String(b.dataset.to === id)));
    if (nav.length) mark(nav[0][0]);

    /* WHICH SECTION IS THE READER IN — COMPUTED, NOT OBSERVED.
     *
     * This was an IntersectionObserver, which is the right tool and is also
     * the one that cannot be verified: an IO never fires in a tab whose
     * visibilityState is "hidden", so there was no way to tell a working
     * scrollspy from a dead one. Measured directly — 0 callbacks over 1.5s in
     * a hidden tab, and the tab would not scroll either.
     *
     * A plain calculation off scrollY has no such hole: it is the same answer,
     * derived rather than delivered, and it can be checked by calling it. It
     * runs coalesced on a timeout rather than per scroll event — and NOT on
     * requestAnimationFrame, which is the other thing that stops in a hidden
     * tab, so an rAF-throttled version would freeze on whatever section it
     * last saw.
     *
     * The section in view is the LAST one whose top has passed under the
     * sticky header. Nearest-to-zero is the obvious rule and the wrong one: it
     * flips to the next section while most of the current one is still on
     * screen. */
    const update = () => {
      const line = (document.querySelector('.top')?.getBoundingClientRect().height || 120) + 16;
      let cur = nav.length ? nav[0][0] : null;
      for (const [id] of nav) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) cur = id;
      }
      // At the very bottom the last section may never cross the line.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4 && nav.length) {
        cur = nav[nav.length - 1][0];
      }
      if (cur) mark(cur);
    };
    let pending = null;
    addEventListener('scroll', () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; update(); }, 90);
    }, { passive: true });
    addEventListener('resize', () => update(), { passive: true });
    update();
    // Exposed so the behaviour can be checked without a scroll event, which is
    // the only way to check it in an environment that will not scroll.
    window.__gemsSpy = update;
  }

  document.getElementById('theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('sig:theme', next); } catch {}
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', next === 'dark' ? '#0B0F14' : '#FFFFFF');
  });

  build().catch((err) => {
    /* THE ERROR USED TO BE DISCARDED.
     * This caught and threw away the exception, so every failure — a feed that
     * did not answer, and a genuine bug in the rendering — produced the same
     * sentence about feeds. One of those is not the feeds' fault, and there
     * was no way to tell them apart from the page. */
    console.error('gems build failed:', err);
    const msg = String((err && err.message) || err || 'unknown');
    app.innerHTML = `<div class="empty">
      <b>Today's page could not be built.</b>
      <br>${esc(msg)}
      <br><br>Nothing here is stale data pretending to be current — the page would rather
      show nothing than show yesterday's numbers as today's.</div>`;
  });
})();
