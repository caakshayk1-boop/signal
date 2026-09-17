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

  /* ── A PRICE CHART, ON EVERY SCRIP, DRAWN ONLY WHEN IT IS OPENED ─────────
   *
   * Akshay: "build view chart option entire site — each scrip can be clicked
   * to view details."
   *
   * LAZY IS NOT AN OPTIMISATION HERE, IT IS THE ONLY WORKABLE DESIGN. This
   * page carries roughly forty expandable scrips across its sections. Drawing
   * them on load would be forty series requests before a reader has looked at
   * anything, on a page whose whole promise is that it opens fast on a phone.
   * A <details> announces exactly when someone wants one, so the fetch waits
   * for that and the result is kept for the session.
   *
   * SVG, NOT A LIBRARY. It is a path, an area fill and two labels. Pulling a
   * charting library onto a page that currently ships no dependency at all
   * would cost more than every chart on it.
   *
   * The series is CLOSES, daily, from the same /api/signals?series= route the
   * full site's card chart reads — so the two cannot disagree about what a
   * stock did, which is the rule this whole file is built on. */
  const CHARTS = new Map();

  const chartSvg = (pts, w = 640, h = 150) => {
    if (!pts || pts.length < 2) return '<div class="empty">Not enough history to draw.</div>';
    const cs = pts.map(p => p.c).filter(c => typeof c === 'number' && isFinite(c));
    if (cs.length < 2) return '<div class="empty">Not enough history to draw.</div>';
    const lo = Math.min(...cs), hi = Math.max(...cs);
    // A FLAT SERIES HAS NO RANGE, AND DIVIDING BY IT IS HOW A CHART BECOMES
    // NaN. Pad by 1% of the level so a genuinely flat stock draws a flat line
    // rather than disappearing.
    const pad = (hi - lo) || (hi * 0.01) || 1;
    const x = i => (i / (cs.length - 1)) * w;
    const y = c => h - ((c - lo) / pad) * (h - 8) - 4;
    const d = cs.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(c).toFixed(1)}`).join(' ');
    const up = cs[cs.length - 1] >= cs[0];
    const first = pts.find(p => typeof p.c === 'number'), last = pts[pts.length - 1];
    const chg = ((cs[cs.length - 1] - cs[0]) / cs[0]) * 100;
    return `<div class="gch">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
           aria-label="Closing price, ${esc(first.t)} to ${esc(last.t)}, ${chg > 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(1)}%">
        <path d="${d} L${w} ${h} L0 ${h} Z" class="gch-a ${up ? 'up' : 'dn'}"/>
        <path d="${d}" class="gch-l ${up ? 'up' : 'dn'}" fill="none"/>
      </svg>
      <div class="gch-f">
        <span>${esc(String(first.t).slice(0, 7))}</span>
        <span class="${up ? 'up' : 'dn'}"><b>${chg > 0 ? '+' : ''}${chg.toFixed(1)}%</b>
          over the window</span>
        <span>${inr(lo)} – ${inr(hi)}</span>
      </div>
    </div>`;
  };

  /* A placeholder the delegated listener fills in. `data-chart` carries the
     symbol; the row is inert until someone opens it. */
  const chartSlot = (sym) => sym
    ? `<div class="gch-h" data-chart="${esc(sym)}">
         <div class="sk" style="height:150px"></div></div>`
    : '';

  async function fillChart(host) {
    const sym = host.getAttribute('data-chart');
    if (!sym || host.dataset.done) return;
    host.dataset.done = '1';                       // never fetch the same row twice
    let pts = CHARTS.get(sym);
    if (!pts) {
      const r = await get(`/api/signals?series=${encodeURIComponent(sym)}&range=1y`);
      pts = (r && r.points) || null;
      if (!pts || !pts.length) {
        host.innerHTML = '<div class="empty">Price history did not load for this name.</div>';
        return;
      }
      CHARTS.set(sym, pts);
    }
    host.innerHTML = `<div class="gch-t">One year of daily closes</div>` + chartSvg(pts);
  }

  /* ══ THE LIVE DASHBOARD ═══════════════════════════════════════════════════
   *
   * Akshay: "below the hero, a live snapshot with realtime movement of what is
   * happening in the Indian market — not an EOD thing, 5-10 minute refresh or
   * lower is fine, only unique things."
   *
   * WHAT MAKES IT UNIQUE IS NOT THE PRICES. Every Indian markets site shows
   * Nifty and Sensex. None of them shows, on one screen, WHERE INSIDE TODAY'S
   * OWN RANGE each index is sitting — and that is the difference between
   * "Metal +0.94%" and "Metal +0.94% and pinned at 95% of its day", which are
   * opposite statements about whether the move is being sold into. The feed
   * has carried day_range_pos all along and nothing on either site read it.
   *
   * FOUR THINGS, AND NOTHING ELSE:
   *   1. The session clock — is it open, and how much of it is left. A live
   *      number, because "2h 14m to close" changes how you read everything
   *      under it.
   *   2. Fourteen sector indices ranked live, each with its position in its
   *      OWN day and its own year. Rotation you can see rather than infer.
   *   3. India VIX, live, in words.
   *   4. This site's own open names, marked live — how many are up right now
   *      and which have moved most. No other page in the world has this one,
   *      because no other page has this book.
   *
   * ONE REQUEST. All of it comes from /api/ticker, which the header ticker
   * already fetches — so the dashboard costs a cache hit, not a new feed.
   *
   * IT DOES NOT POLL A MARKET THAT IS SHUT, and it does not poll a tab nobody
   * is looking at. Both are stated on the panel rather than left implicit: a
   * dashboard that says "live" while serving a number from 14 hours ago is the
   * single failure this whole estate is built to avoid.
   */
  const LIVE_MS = 60000;            // a minute while it is trading. The ask was 5-10.
  /* AND A SLOW BEAT WHEN IT IS NOT. The first version called clearInterval the
     moment it saw a closed session, which is right for the night and wrong the
     next morning: a page left open from Thursday's close never polled again,
     so at 09:20 on Friday it was still showing Thursday's last trade under a
     header that would have said "market closed" all day. Backing off instead
     of stopping means the board picks the session up on its own. Fifteen
     minutes costs four requests an hour against a cached edge route. */
  const IDLE_MS = 900000;
  const IST = 'en-IN';

  const clockOf = (it) => {
    const st = Number(it && it.session_start), en = Number(it && it.session_end);
    const sess = String((it && it.session) || '').toLowerCase();
    if (!isFinite(st) || !isFinite(en) || en <= st) return { sess, known: false };
    const now = Date.now() / 1000;
    const through = Math.max(0, Math.min(100, (now - st) / (en - st) * 100));
    const leftMin = Math.max(0, Math.round((en - now) / 60));
    return { sess, known: true, through, leftMin,
             open: sess === 'open' && now >= st && now < en };
  };

  const hhmm = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;

  /* Where a price sits between its own low and high, as a dot on a rail. The
     rail is the DAY by default — the reading nobody publishes. */
  const posBar = (v, lo, hi, cls) => {
    const n = num(v);
    if (n == null) return '<span class="lv-rail lv-na" aria-hidden="true"></span>';
    const at = clamp(n, 0, 100);
    return `<span class="lv-rail" role="img"
        aria-label="${at.toFixed(0)}% of the way from ${esc(lo)} to ${esc(hi)}">
      <i class="lv-dot ${esc(cls || '')}" style="left:${at.toFixed(1)}%"></i></span>`;
  };

  const liveHtml = (t) => {
    const segs = (t && t.segments) || [];
    const segOf = (k) => (segs.find(x => x.key === k) || {}).items || [];
    const india = segOf('india');
    if (!india.length) {
      return `<div class="empty">The live board did not answer. Everything below is the
        morning build and says so on each section.</div>`;
    }
    const by = (n) => india.find(x => x.name === n);
    const nifty = by('Nifty 50'), vix = by('India VIX');
    const clock = clockOf(nifty || india[0]);

    /* SECTORS ONLY. The broad indices are the anchor above; repeating them in
       the rotation table would say the same thing twice, which is the note
       this page keeps having to relearn. */
    /* EVERY BROAD INDEX, not just the three obvious ones. The first list
       excluded Nifty 50, Sensex and VIX — so Bank Nifty and Midcap 100, which
       are ANCHORS six inches above, appeared again inside the rotation table,
       and Smallcap 250 and Nifty Next 50 sat there as "sectors" when they are
       size buckets. A rotation table is only readable if every row is the same
       KIND of thing; mixing a size index into it makes "Midcap leads Pharma"
       look like a sector call when it is a capitalisation one. */
    const BROAD = new Set(['Nifty 50', 'Sensex', 'India VIX', 'Bank Nifty',
                           'Midcap 100', 'Smallcap 250', 'Nifty Next 50']);
    const sect = india.filter(x => !BROAD.has(x.name) && num(x.change_pct) != null)
      .sort((a, b2) => b2.change_pct - a.change_pct);
    const upN = sect.filter(x => x.change_pct > 0).length;

    /* THE BOOK, MARKED LIVE. `ledger` is a flat map of this site's own names to
       their current price and move — the one panel here that cannot be copied,
       because it needs a book to mark. */
    const led = Object.entries((t && t.ledger) || {})
      .map(([sym, v]) => ({ sym, ...v }))
      .filter(x => num(x.change_pct) != null);
    const ledUp = led.filter(x => x.change_pct > 0).length;
    const ledMove = led.slice().sort((a, b2) => Math.abs(b2.change_pct) - Math.abs(a.change_pct)).slice(0, 6);

    const anchor = (it) => it ? `<div class="lv-idx">
        <div class="lv-ih"><span class="lv-in">${esc(it.name)}</span>
          <b class="${dir(it.change_pct)}">${pct(it.change_pct)}</b></div>
        <div class="lv-ip">${esc(String(it.price || ''))}</div>
        <div class="lv-ir">
          <span class="lv-rl">today</span>
          ${posBar(it.day_range_pos, it.day_low, it.day_high, dir(it.change_pct))}
          <span class="lv-rv">${num(it.day_range_pos) == null ? '—'
            : Math.round(it.day_range_pos) + '%'}</span>
        </div>
        <div class="lv-ir">
          <span class="lv-rl">52 weeks</span>
          ${posBar(it.range_pos, it.w52_low, it.w52_high, '')}
          <span class="lv-rv">${num(it.range_pos) == null ? '—'
            : Math.round(it.range_pos) + '%'}</span>
        </div>
      </div>` : '';

    const stamp = t.fetched_at
      ? new Date(t.fetched_at).toLocaleTimeString(IST, { hour: '2-digit', minute: '2-digit' })
      : '';

    return `<div class="lv-h">
        <span class="lv-k">Right now</span>
        <span class="lv-st ${clock.open ? 'is-open' : 'is-shut'}">
          <i></i>${clock.open ? 'Market open' : 'Market closed'}</span>
        ${clock.known && clock.open
          ? `<span class="lv-left">${hhmm(clock.leftMin)} to close</span>
             <span class="lv-prog"><i style="width:${clock.through.toFixed(1)}%"></i></span>`
          : `<span class="lv-left">Showing the last session</span>`}
        <span class="lv-at">${stamp ? `as of ${esc(stamp)}` : ''}</span>
      </div>

      <div class="lv-top">${anchor(nifty)}${anchor(by('Bank Nifty'))}${anchor(by('Midcap 100'))}
        ${vix ? `<div class="lv-idx lv-vix">
          <div class="lv-ih"><span class="lv-in">India VIX</span>
            <b class="${num(vix.change_pct) > 0 ? 'dn' : 'up'}">${pct(vix.change_pct)}</b></div>
          <div class="lv-ip">${esc(String(vix.price || ''))}</div>
          <p class="lv-vw">${num(vix.price_raw) == null ? ''
            : num(vix.price_raw) < 12 ? 'Very calm. Options are cheap and nobody is hedging.'
            : num(vix.price_raw) < 16 ? 'Normal. No one is paying up for protection.'
            : num(vix.price_raw) < 20 ? 'Unsettled — the market is starting to pay for cover.'
            : num(vix.price_raw) < 26 ? 'Jumpy. Protection is expensive and moves are wide.'
            : 'Stressed. This is where falls get violent and bottoms get made.'}</p>
        </div>` : ''}
      </div>

      <h3 class="lv-sh">Sector rotation, and whether the move is holding</h3>
      <p class="lv-note"><b>${upN}</b> of ${sect.length} sector indices are up.
        The second column is the one nobody publishes: where the index sits inside
        <b>today's own range</b>. Near 100% it is being bought into the close; near 0% a
        green number is being sold all the way down.</p>
      <div class="lv-secs">${sect.map(x => `<div class="lv-sec">
        <span class="lv-sn">${esc(x.name.replace(/^Nifty /, ''))}</span>
        <b class="${dir(x.change_pct)}">${pct(x.change_pct)}</b>
        ${posBar(x.day_range_pos, x.day_low, x.day_high, dir(x.change_pct))}
        <span class="lv-rv">${num(x.day_range_pos) == null ? '—'
          : Math.round(x.day_range_pos) + '%'}</span>
      </div>`).join('')}</div>

      ${led.length ? `<h3 class="lv-sh">This site's own names, marked live</h3>
        <p class="lv-note"><b>${ledUp}</b> of the ${led.length} names this site has published a
          signal on are up right now. Not a portfolio — every one of them is on paper, and no
          engine here is cleared for capital. It is the book being marked in public, which is
          the part that does not exist anywhere else.</p>
        <div class="lv-book">${ledMove.map(x => `<div class="lv-bk">
          <span class="lv-bs">${esc(x.sym)}</span>
          <b class="${dir(x.change_pct)}">${pct(x.change_pct)}</b>
          <span class="lv-bp">${esc(x.ccy || '₹')}${Number(x.price).toLocaleString(IST)}</span>
        </div>`).join('')}</div>` : ''}

      <p class="lv-f">Refreshes every minute while this tab is open and the market is
        trading${clock.open ? '' : ' — it is not trading now, so nothing here is moving'}.
        Prices are delayed by whatever the exchange's public feed delays them by; this page
        does not pretend otherwise.</p>`;
  };

  async function liveTick(host) {
    const t = await get('/api/ticker');
    if (!t || !t.segments) {
      if (!host.dataset.ok) {
        host.innerHTML = `<div class="empty">The live board did not answer.</div>`;
      }
      return null;                       // keep the last good board on a blip
    }
    host.dataset.ok = '1';
    host.innerHTML = liveHtml(t);
    return t;
  }

  function startLive() {
    const host = document.getElementById('live');
    if (!host) return;
    let timer = null, beat = 0;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } beat = 0; };
    const at = (ms) => {
      if (beat === ms && timer) return;          // already on the right cadence
      stop();
      beat = ms;
      timer = setInterval(() => { if (!document.hidden) run(); }, ms);
    };
    const run = async () => {
      const t = await liveTick(host);
      /* DO NOT POLL A TRADING MARKET AT THE SAME RATE AS A SHUT ONE. Outside
         09:15-15:30 IST nothing moves, so a minute timer would be a request a
         minute all night for an answer that cannot change — but stopping dead
         means the next session never arrives on a page left open. */
      const india = t && (t.segments.find(x => x.key === 'india') || {}).items;
      const open = india && india.length && clockOf(india[0]).open;
      if (!document.hidden) at(open ? LIVE_MS : IDLE_MS);
    };
    /* FIRST RENDER IS UNCONDITIONAL. It must not be gated on visibility: the
       preview pane reports visibilityState "hidden" permanently, and an
       observer- or visibility-gated first paint is indistinguishable there
       from a broken one. Only the REPEAT is gated. */
    run();
    if (!document.hidden) at(LIVE_MS);        // run() corrects the cadence once it knows
    /* A TAB NOBODY IS LOOKING AT POLLS NOTHING. Coming back to it refetches at
       once rather than waiting out the remainder of a timer, because the first
       thing a returning reader looks at is the number that went stale while
       they were away. */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop(); else run();
    });
  }

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
  /* ── WHAT THIS CALENDAR MONTH HAS HISTORICALLY DONE FOR ONE NAME ────────
   *
   * Investtech built a business on this and neither of these two products
   * showed it. It is also the most misused statistic in retail investing, so
   * the three guards the feed enforces are carried through to the sentence:
   *
   *   · A month needs eight completed observations to appear at all. Below
   *     that the feed stores null and this prints nothing — a three-year hit
   *     rate would read exactly as authoritative as a ten-year one.
   *   · The HIT RATE and the MEDIAN always travel together. "+3.1% in
   *     September" hides whether that is nine small gains or one +40% year
   *     carrying nine losses.
   *   · It says what it is. A calendar has no causal claim on a share price;
   *     this records what repeatedly happened, which is a weaker and more
   *     honest statement than a forecast.
   */
  const seasLine = (seas, sym) => {
    const d = seas && seas.stocks && seas.stocks[sym];
    const m = d && d.m && d.m[new Date().getMonth()];
    if (!m) return '';
    const month = new Date().toLocaleDateString('en-IN', { month: 'long' });
    const tone = m[0] >= 67 ? 'up' : m[0] <= 40 ? 'dn' : '';
    return `<p class="said"><b>${esc(month)}, historically.</b> Rose in
      <b class="${tone}">${m[0]}%</b> of the last ${m[2]}, median
      <b class="${m[1] > 0 ? 'up' : 'dn'}">${m[1] > 0 ? '+' : ''}${m[1]}%</b> —
      over ${d.y} years. ${m[0] >= 67 ? 'A supportive month on the record.'
        : m[0] <= 40 ? 'A weak month on the record.'
        : 'No seasonal tilt either way.'} Historical, not predictive.</p>`;
  };

  /* ── THE FIRST REAL SENTENCE OF A MARKDOWN STUDY ────────────────────────
   * weekly_reads stores each study as Markdown, and slicing it raw put
   * "## In one line Jeena Sikho Lifecare Ltd. (JSLL) is..." on the page —
   * the heading marker, the heading, and the paragraph run together with no
   * space, because a newline is not a space once it is in HTML.
   *
   * This is not a Markdown renderer and must not become one. It finds the
   * first block that is PROSE — not a heading, not a bullet, not the stats
   * block the study opens with — and returns it with the inline emphasis
   * markers stripped. Anything it cannot parse returns empty, and the caller
   * shows nothing rather than a broken excerpt. */
  const firstPara = (md, cap = 420) => {
    const blocks = String(md || '').split(/\n{2,}/);
    for (const raw of blocks) {
      const b = raw.trim();
      if (!b || /^#{1,6}\s/.test(b) || /^[-*>|]/.test(b)) continue;
      if (/^[A-Z][^:\n]{0,40}:\s/.test(b) && b.length < 120) continue;   // a stats line
      const clean = b.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
      if (clean.split(' ').length < 12) continue;
      return clean.length > cap ? clean.slice(0, cap).replace(/\s+\S*$/, '') + '…' : clean;
    }
    return '';
  };

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
    const [screen, sigs, insti, ipo, ipoLive, baro, seas,
           news, pulse, reads, health] = await Promise.all([
      /* /api/stats went with the record section — it was the only reader.
         A fetch nobody consumes is not harmless: it is a request on every
         load, and the next person to see it in the list assumes a section
         depends on it. */
      get('/screen.json'), get('/api/signals?limit=400'),
      get('/institutional.json'), get('/ipo.json'),
      /* THE SUBSCRIPTION BOOK HAS TO BE LIVE OR IT IS WORTHLESS.
       * ipo.json is built once, around midnight, so its subscription_x was
       * up to a full day stale — and a book moves fastest on its final day,
       * which is exactly when someone is deciding. /api/ipo-live reads NSE's
       * current-issue endpoint behind a 15-minute edge cache; the full site
       * already used it and this page did not. */
      get('/api/ipo-live'),
      /* TWO FEEDS THE FULL SITE PUBLISHES AND THIS PAGE DID NOT READ.
       *
       * barometer.json is the SINGLE DEFINITION of the market score. It used
       * to be computed in the browser, and keeping a second copy here would
       * be a second answer to one question — the fault this file's own header
       * warns about and this repo has already paid for four times (four
       * engines, four target ladders). The score is read, never re-derived.
       *
       * seasonality.json carries eleven years of calendar-month records. It
       * is the one dimension neither product showed, and on a digest read at
       * 6am it answers a question the screen cannot: is this a month this
       * name has historically done anything in.
       *
       * Both are optional. get() resolves null on a miss, every reader below
       * guards, and a section whose feed did not answer is absent rather than
       * empty — which is this page's existing rule, not a new one. */
      get('/barometer.json'), get('/seasonality.json'),
      /* ── THE REST OF THE SITE, BECAUSE THIS IS NOW THE WHOLE OF IT ───────
       *
       * Akshay: "make it a single page of truth, incl everything from signal
       * which is relevant — simple, but only relevant things — the entire
       * website as a brief."
       *
       * BOTH HALVES OF THAT ARE INSTRUCTIONS. "Everything relevant" added the
       * four feeds below; "only relevant" is why the map, the radar, the
       * research floor, the methodology and the mandate book are NOT here.
       * A 989-cell map is a tool you go and use; a brief is read straight
       * through in one sitting, and a section you scroll past is worse than a
       * section that does not exist.
       *
       *   news    — what actually moved, and why. A daily brief without the
       *             wire is a spreadsheet.
       *   pulse   — which sectors led and lagged, and the week's movers. The
       *             breadth section was reading only the screen's summary and
       *             throwing the sector cut away.
       *   reads   — the weekend studies, one line each.
       *   health  — whether the pipeline behind all of this actually ran. A
       *             footer line, not a section: it is a trust signal, and a
       *             trust signal that takes a whole screen is an apology. */
      get('/news.json'), get('/pulse.json'),
      get('/weekly_reads.json'), get('/data-health.json'),
    ]);

    const d = new Date();
    document.getElementById('topDate').textContent =
      d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }).toUpperCase();

    const rows = (screen && screen.rows) || [];
    const ledger = (sigs && (sigs.signals || sigs.rows)) || [];
    /* THE SAME POPULATION SIGNAL PUBLISHES, which this page was not using.
     *
     * signal.askakshay.com's ledger() filters the feed twice before anything is
     * counted: engineOk keeps only engines in the registry, and longOnly drops
     * shorts, because the book is long-only and a short is never put in front
     * of a reader as an action. Gems counted the RAW feed, so the same ledger
     * on the same night produced two different records:
     *
     *     signal   64 published · 62 open · 2 closed
     *     gems     84 published · 78 open · 6 closed
     *
     * Neither figure was miscalculated. They were different populations, both
     * labelled "the record", on two sites that say they read one ledger — and
     * the 20 extra were top5_pick's US equities, COMEX gold, and six shorts.
     * The same rows that put AAPL and a gold future on a page titled "today's
     * Indian market".
     *
     * Filtered identically here, so the two pages cannot disagree. The rupee
     * check stays as a guard rather than a filter: applying the engine rule
     * already leaves nothing but Indian names, and if that ever stops being
     * true this page must not silently start showing them. */
    const ENGINE_OK = new Set(['breakout', 'magic', 'magicmagic', 'equity_measured',
      'multibagger', 'momentum_quant', 'ai_longterm', 'ledge', 'keel', 'strict', 'reclaim']);
    const since = ledger.filter(r =>
      String(r.date || '').slice(0, 10) >= LAUNCH
      && ENGINE_OK.has(String(r.signal_type || ''))
      && String(r.action || 'BUY').toUpperCase() !== 'SELL'
      && String(r.currency || '₹') === '₹');
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
    /* ── 0. THE READING, AND WHAT THE FALL HAS PUT ON OFFER ────────────────
     *
     * Akshay's question, in his words: "even at bad, when can we start
     * investing — COVID was bad but whoever invested at those lows became
     * rich." A breadth panel cannot answer that. It says conditions are poor
     * at precisely the moment the answer should be "this is the entry".
     *
     * So TWO readings, and they move against each other on purpose. The
     * barometer scores conditions now. The stage scores what the fall has put
     * on sale — and the second one improves as the first one gets worse.
     * Neither is computed here: barometer.py owns the arithmetic, publishes
     * the weights so the derivation is visible, and this page renders it.
     *
     * IT IS SCORED AFTERWARDS, WHICH IS THE PART THAT MATTERS. Every reading
     * is written down daily, and once a year has passed the file carries what
     * the index actually DID after each one. Where that measurement exists it
     * is printed, including when it is unflattering; where it does not, the
     * page says the window has not closed yet rather than showing an average
     * of the readings that happen to be old enough. */
    const bt = baro && baro.today;
    if (bt && bt.score != null) {
      const band = bt.band || {}, stg = bt.stage || {};
      const out = ((baro.outcomes || {})[stg.k] || {});
      const m12 = out.m12;
      add('reading', 'Reading', sec('reading', 'Where the market stands',
        `<b>${bt.score}</b> out of 100 — <span class="${esc(band.c || '')}">${esc(band.t || '')}</span>.
         On what has been put on sale: <b class="${esc(stg.c || '')}">${esc(stg.t || '—')}</b>.
         These two move <i>against</i> each other, and that is the point.`,
        `<div class="baro" role="img" aria-label="Barometer ${bt.score} of 100, ${esc(band.t || '')}">
          <span class="baro-t"><i class="${esc(band.c || 'flat')}"
            style="width:${clamp(bt.score, 0, 100)}%"></i></span>
          <span class="baro-v">${bt.score}<u>/100</u></span>
        </div>` +
        figs([
          [num(bt.drawdown_pct) == null ? '—' : `${Number(bt.drawdown_pct).toFixed(1)}%`,
           'index off its high', bt.drawdown_pct >= 10 ? 'dn' : ''],
          [num(bt.above_200dma_pct) == null ? '—' : `${Number(bt.above_200dma_pct).toFixed(0)}%`,
           'above their 200-day'],
          [num(bt.vix) == null ? '—' : Number(bt.vix).toFixed(2), 'India VIX'],
          [`${bt.counted || '—'}`, 'names counted'],
        ]) +
        /* The components, with their weights, because a score whose
           derivation you cannot see is a horoscope. The file publishes them
           precisely so this does not have to assume them.
           ONE ROW PER COMPONENT, not a meter list and then a detail list —
           the first build stacked both and printed every label twice, which
           is the exact complaint that started this pass. The bar, the weight,
           the score and the sentence behind it belong to one component and
           now sit in one block. */
        `<div class="bparts">${(bt.parts || []).map(pt => `
          <div class="bpart">
            <div class="bp-h"><span class="bp-l">${esc(pt.label)}</span>
              <span class="bp-w">${pt.weight}% of the score</span>
              <span class="bp-v">${Number(pt.score).toFixed(0)}</span></div>
            <span class="bp-t"><i style="width:${clamp(pt.score, 0, 100)}%"></i></span>
            <p class="bp-d">${esc(pt.detail || '')}</p>
          </div>`).join('')}</div>` +
        (m12 && m12.n
          ? `<p class="said"><b>Measured:</b> after ${m12.n} past ${
              m12.n === 1 ? 'reading' : 'readings'} of
             <b>${esc(stg.t || stg.k)}</b>, the index was <b class="${m12.avg > 0 ? 'up' : 'dn'}">${
             m12.avg > 0 ? '+' : ''}${m12.avg}%</b> a year later, higher ${m12.hit}% of the time.
             That is this framework marking its own homework, and it is published whether or
             not it flatters the framework.</p>`
          : `<p class="said">No measured outcome for this stage yet. The reading is written
             down every day and scored once three, six and twelve months have actually
             passed — a running average that quietly mixed unfinished windows would flatter
             this page, so there is none until a window closes.</p>`) +
        `<p class="said">Weights: ${Object.entries(baro.weights || {})
          .map(([k, v]) => `${esc(k)} ${v}%`).join(' · ')}. Published rather than hidden,
          because a score you cannot take apart is not evidence.</p>`,
        baro.generated_at ? `scored ${String(baro.generated_at).slice(0, 10)}` : stale));
    }

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

    /* ── 1b. WHICH SECTORS, AND WHAT RAN ───────────────────────────────────
     * Breadth says how many names rose. It cannot say WHERE, and "350 of 989
     * advanced" reads identically whether that was every bank or every
     * chemical. pulse.json already cut it by sector and this page was
     * throwing that away. */
    const secs = (pulse && (pulse.sectors_day || pulse.sectors)) || [];
    if (secs.length) {
      const ranked = secs.filter(x => num(x.median) != null)
        .sort((a, b) => b.median - a.median);
      const lead = ranked.slice(0, 4), lag = ranked.slice(-4).reverse();
      const up = (pulse.movers_up || []).slice(0, 5);
      add('sectors', 'Sectors', sec('sectors', 'Where it happened',
        ranked.length
          ? `<b>${esc(ranked[0].name)}</b> led at ${pct(ranked[0].median)} median, and
             <b>${esc(ranked[ranked.length - 1].name)}</b> lagged at
             ${pct(ranked[ranked.length - 1].median)}. A median, not an average — one
             name up 40% cannot carry a sector here.`
          : 'No sector cut on this build.',
        `<div class="secg">${lead.concat(lag).map(x => `
          <div class="secr">
            <span class="secr-n">${esc(x.name)}</span>
            <span class="secr-b"><i class="${x.median >= 0 ? 'up' : 'dn'}"
              style="width:${clamp(Math.abs(x.median) * 18, 3, 100)}%"></i></span>
            <span class="secr-v ${dir(x.median)}">${pct(x.median)}</span>
            <span class="secr-c">${x.up}/${x.n} up</span>
          </div>`).join('')}</div>` +
        (up.length ? `<h3 class="sub">Furthest on the week</h3>
          <div class="movs">${up.map(m => `<div class="mov">
            <span class="mov-s">${esc(m.sym)}</span>
            <span class="mov-n">${esc(m.sector || '')}</span>
            <b class="${dir(m.r1w)}">${pct(m.r1w)}</b>
            <span class="mov-t">${num(m.turnover_cr) == null ? '' : `₹${Number(m.turnover_cr).toFixed(0)}cr traded`}</span>
          </div>`).join('')}</div>` : '') +
        `<p class="said">A week's move is not a reason to buy one. It is where to look
          first, and the screen's call on each of these is in the next section.</p>`,
        stale));
    }

    /* ── 1c. THE WIRE ──────────────────────────────────────────────────────
     * A daily brief without news is a spreadsheet. This is the one section
     * that is not a number, and it is deliberately short: headlines and their
     * source, nothing summarised into a house view. The page does not have an
     * opinion on the news and should not pretend to. */
    const wire = Array.isArray(news) ? news.filter(n => n && n.title).slice(0, 6) : [];
    if (wire.length) {
      add('wire', 'Wire', sec('wire', 'What moved, and why',
        `<b>${wire.length}</b> stories the desk read this morning. Headlines and their
         source — this page does not summarise the news into a view, because a view
         built on a headline is the cheapest thing on any market site.`,
        `<ul class="wire">${wire.map(n => `<li>
          <a href="${esc(n.link || '#')}" target="_blank" rel="noopener nofollow">${esc(n.title)}</a>
          ${n.source ? `<span class="wire-s">${esc(n.source)}</span>` : ''}
          ${n.summary ? `<p>${esc(String(n.summary).slice(0, 260))}${
            String(n.summary).length > 260 ? '…' : ''}</p>` : ''}
        </li>`).join('')}</ul>`,
        ''));
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
            chartSlot(r.sym) +
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
             ${seasLine(seas, r.sym)}
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

    /* ── THE RECORD IS NOT ON THIS PAGE ────────────────────────────────────
     *
     * Removed at Akshay's instruction. Worth writing down WHY it was here, so
     * nobody re-adds it by accident and nobody thinks it was dropped to
     * flatter the page: this section led with a losing number on purpose —
     * "a digest that leads with picks and buries its own expectancy is an
     * advertisement" — and that argument has not changed.
     *
     * What changed is the page's job. Gems is now the whole desk read in one
     * sitting, and a performance ledger is a thing you AUDIT, not a thing you
     * skim before the open. It is unchanged and in full at
     * signal.askakshay.com/signals and /engines, losses included.
     *
     * ONE LINE HAD TO BE RESCUED FROM IT. "No engine is cleared for capital"
     * lived in that crux and nowhere else, so deleting the section quietly
     * deleted the single most important sentence on the page — the whole
     * reason a reader is allowed to look at six open setups without treating
     * them as instructions. It now sits on Setups, which is where someone is
     * actually about to act. */
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
                               && r.entry && r.sl && r.target1);
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
            chartSlot(bare(r.symbol)) +
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
          )).join('')}</div>
          <p class="said"><b>No engine on this site is cleared for capital.</b> The bar is
            30 closed trades at a t-statistic of 2 or better, and nothing has reached it —
            so every setup above is a record of what an engine published, not a position
            anyone took. The full ledger, wins and losses, is at
            <a href="https://signal.askakshay.com/signals">signal.askakshay.com/signals</a>.</p>`
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
            chartSlot(sym) +
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
            chartSlot(x.r.sym) +
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

    /* ── 9. THE CALENDAR ───────────────────────────────────────────────────
     *
     * Akshay: "map related summary if possible, for month specific."
     *
     * THE MAP ITSELF DOES NOT BELONG ON A BRIEF — 989 cells is a tool you go
     * and use, not something you read past. Its most useful DIMENSION does:
     * which names have a record in the month you are standing in, and in the
     * one about to start. That is the one cut of the map that answers a
     * question rather than inviting exploration.
     *
     * BOTH MONTHS, because mid-September the current month is mostly spent
     * and the next one is the decision. The feed ranks the coming month for
     * free; this month is computed from the same stocks block.
     *
     * THREE GUARDS, carried through from the feed rather than re-argued:
     * eight completed observations or the name does not appear; the hit rate
     * and the median always shown together; and it is cross-referenced with
     * the screen's own call, so what a reader sees is two independent
     * readings agreeing or disagreeing, never a calendar on its own. */
    const stocksS = (seas && seas.stocks) || {};
    if (Object.keys(stocksS).length) {
      const MN = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
      const now = new Date().getMonth();
      const rank = (mi) => Object.entries(stocksS).map(([sym, d]) => {
        const m = (d.m || [])[mi];
        return m ? { sym, hit: m[0], med: m[1], n: m[2], r: screenOf(sym) } : null;
      }).filter(Boolean).sort((a, b2) => (b2.hit - a.hit) || (b2.med - a.med));

      const cal = (mi, title) => {
        const all = rank(mi);
        if (!all.length) return '';
        const strong = all.filter(x => x.hit >= 70).slice(0, 5);
        const weak = all.filter(x => x.hit <= 35).slice(-5).reverse();
        /* NO data-gpx HERE, AND THIS IS NOT A STYLE PREFERENCE.
           The live-price pass at the end of this file does
           `el.textContent = inr(v.price)` on every [data-gpx] element — it is
           written for the PRICE SPAN of a row, which holds nothing else. Put
           it on a container and the assignment wipes every child: these cells
           rendered as a bare "₹1,504" with a LIVE badge where the symbol, the
           hit rate and the median had been. A calendar cell has no price on
           it by design; what it carries is an eleven-year record. */
        const cell = (x, kind) => `<div class="cal-c ${kind}">
          <span class="cal-s">${esc(x.sym)}</span>
          <b class="${kind === 'up' ? 'up' : 'dn'}">${x.hit}%</b>
          <span class="cal-m">median ${x.med > 0 ? '+' : ''}${x.med}%</span>
          <span class="cal-n">${x.n} years${x.r && x.r.vd && x.r.vd.c
            ? ` · screen says ${esc(x.r.vd.c)}` : ''}</span>
        </div>`;
        return `<h3 class="sub">${esc(title)} — ${esc(MN[mi])}</h3>
          <p class="said">${all.length} names have ${MN[mi]} on record.
            ${strong.length} rose in 70% or more of them; ${weak.length} in 35% or fewer.</p>
          <div class="calg">${strong.map(x => cell(x, 'up')).join('')}</div>
          ${weak.length ? `<div class="calg cal-w">${weak.map(x => cell(x, 'dn')).join('')}</div>` : ''}`;
      };

      const nxt = (now + 1) % 12;
      add('calendar', 'Calendar', sec('calendar', 'The month, on eleven years of record',
        `Which names have actually done something in <b>${esc(MN[now])}</b>, and in
         <b>${esc(MN[nxt])}</b>. A calendar has no claim on a share price — this records what
         <i>repeatedly happened</i>, which is a weaker and more honest statement than a
         forecast, and it is here as context rather than as a reason.`,
        cal(now, 'This month') + cal(nxt, 'Next month') +
        `<p class="said">Only names with <b>eight or more completed observations</b> of that
          calendar month appear at all — below that a hit rate is a handful of coin flips
          reading exactly as confidently as a decade. ${Object.keys(stocksS).length} of the
          989 screened names clear it. The full month-by-month record for any company is on
          its own page at signal.askakshay.com.</p>`,
        seas.years ? `${seas.years} years of monthly bars` : ''));
    }

    /* ── 8. THE WEEKEND ────────────────────────────────────────────────────
     * Seven company studies, one per sector, written every Saturday. The full
     * text is a 5-7 minute read each and does not belong on a brief — what
     * belongs is that they exist, which ones, and how long they take. This is
     * the only section here about BUSINESSES rather than prices, and that is
     * why it is last: it is the thing to read when the market is shut. */
    const edition = ((reads && reads.editions) || [])[0];
    const studies = (edition && edition.studies) || [];
    if (studies.length) {
      const mins = studies.reduce((a, x) => a + (num(x.read_minutes) || 0), 0);
      add('reads', 'Reads', sec('reads', 'For the weekend',
        `<b>${studies.length}</b> companies, one per sector, <b>${mins}</b> minutes in total.
         No entry, no stop, no target — these are about what a business does and how it
         makes money, which is the part a chart cannot tell you.`,
        `<div class="rows">${studies.map((x, i) => xr(
          rowHead(i + 1, x.sym, `${esc(x.sector || x.industry || '')}${
            num(x.mcap_cr) ? ' · ₹' + Math.round(x.mcap_cr).toLocaleString('en-IN') + ' cr' : ''}`,
            num(x.price) == null ? '—' : inr(x.price),
            [`${x.read_minutes || '—'} min`, ''], ['Read', ''], x.sym),
          chartSlot(x.sym) +
          `<p class="xd-q">${esc(x.name || '')}</p>
           ${(x.facts && x.facts.length)
             ? `<ul class="flags">${x.facts.slice(0, 4).map(f =>
                 `<li><b>${esc(typeof f === 'string' ? f : (f.w || f.t || ''))}</b>${
                   (f && f.e) ? `<span>${esc(f.e)}</span>` : ''}</li>`).join('')}</ul>`
             : ''}
           ${(() => { const e = firstPara(x.study); return e ? `<p class="said">${esc(e)}</p>` : ''; })()}
           <p class="said">Roughly <b>${x.words || '—'}</b> words. Every figure in the full
             study is checked against this company's own row before it is published; a number
             that cannot be checked is cut rather than softened.</p>`
        )).join('')}</div>`,
        edition.week ? `week of ${edition.week}` : ''));
    }

    /* ── THE SIP SHELF IS NOT ON THIS PAGE ─────────────────────────────────
     * Added and removed the same day, at Akshay's instruction. It was the one
     * section here not about the market, which was the argument FOR it and,
     * on a page read before the open, is the better argument against: a
     * monthly SIP is a once-a-month decision and this is a daily brief. It
     * remains in full at signal.askakshay.com/funds. funds.json is no longer
     * fetched. */
    /* ── THE FOOTER LINE: DID ANY OF THIS ACTUALLY RUN ─────────────────────
     * Every figure above came from a job that either ran or silently did not,
     * and this estate has been bitten by the second more than once — a green
     * workflow that published nothing, a feed 390 days stale beside a counter
     * claiming it was current. One line, at the bottom, stating how many of
     * the twelve datasets are healthy. A section would be an apology; a line
     * is a receipt. */
    if (health && health.total) {
      const bad = health.degraded || 0;
      out.push(`<p class="health ${bad ? 'is-bad' : ''}">
        <b>${health.total - bad}</b> of <b>${health.total}</b> datasets behind this page are
        current${bad ? `, and <b>${bad}</b> ${bad === 1 ? 'is' : 'are'} degraded — every figure
        drawn from ${bad === 1 ? 'it is' : 'them is'} older than it should be, and the sections
        above say so where it matters` : ''}.
        ${health.degraded_core ? `<b>${health.degraded_core}</b> of those is a core dataset.`
          : 'No core dataset is degraded.'}</p>`);
    }

    app.innerHTML = out.join('');

    /* ── ONE LISTENER FOR EVERY CHART ON THE PAGE ──────────────────────────
     * Delegated on `toggle`, which fires on the <details> itself and does NOT
     * bubble — so it is captured. The alternative, binding per row, means
     * forty listeners and re-binding after every repaint; this survives both
     * and costs one.
     *
     * A row that is already open at bind time (none today, but a future
     * `open` attribute would do it) is filled immediately, so the chart is
     * never waiting on a toggle that already happened. */
    app.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d || d.tagName !== 'DETAILS' || !d.open) return;
      d.querySelectorAll('[data-chart]').forEach(h => { fillChart(h); });
    }, true);
    app.querySelectorAll('details[open] [data-chart]').forEach(h => { fillChart(h); });

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
    /* THE ACTIVE CHIP HAS TO BE ON SCREEN TO BE OF ANY USE.
     *
     * The nav fitted the page at eight sections. At twelve it is 909px in a
     * 760px rail and scrolls — which is fine, except that the chip marking
     * where you ARE was the one thing scrolled out of sight. A scrollspy whose
     * indicator you cannot see is just a strip of buttons.
     *
     * Only the nav's own rail is scrolled, never the page: scrollIntoView on
     * the element would drag the document to the section as you read past it,
     * which is the opposite of what a reader asked for by scrolling. */
    const mark = (id) => {
      let active = null;
      for (const b of jump.querySelectorAll('button')) {
        const on = b.dataset.to === id;
        b.setAttribute('aria-current', String(on));
        if (on) active = b;
      }
      if (!active) return;
      const pad = 12;
      const l = active.offsetLeft, r = l + active.offsetWidth;
      if (l < jump.scrollLeft + pad) {
        jump.scrollTo({ left: Math.max(0, l - pad), behavior: 'smooth' });
      } else if (r > jump.scrollLeft + jump.clientWidth - pad) {
        jump.scrollTo({ left: r - jump.clientWidth + pad, behavior: 'smooth' });
      }
    };
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
    /* #0C1017, not #0B0F14 — the dark ground moved when this page was ported
       onto signal.css's palette and the toggle kept writing the retired value,
       so the phone's status bar sat a shade off the page it framed. */
    if (m) m.setAttribute('content', next === 'dark' ? '#0C1017' : '#FFFFFF');
  });

  /* THE LIVE BOARD RUNS FIRST AND SEPARATELY.
   * It needs one 40 KB request; build() waits on a 1.5 MB screen. Starting it
   * ahead of the brief puts what the market is doing RIGHT NOW on screen while
   * the rest is still parsing — which is also the honest priority. It is not
   * awaited and its failure cannot take the page down with it. */
  try { startLive(); } catch (e) { console.error('live board failed:', e); }

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
