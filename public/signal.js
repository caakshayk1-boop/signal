/* next.js — router and views for the mobile-first surface.
 *
 * No framework, on purpose. The audit found Style & Layout at 2,917 ms of a
 * 5,300 ms main thread on the broadsheet page; a framework would add script
 * evaluation to a problem that was never about script. What fixes it is
 * shipping less DOM, and a hash router over static JSON does that with ~10 KB.
 *
 * THREE RULES THIS FILE KEEPS
 *
 *  1. Reserve before you fetch. Every async block paints a skeleton of the
 *     same height first, so nothing that arrives late moves anything already
 *     read. The broadsheet's CLS of 0.303 is one element reflowing.
 *  2. Fail out loud. A dead endpoint renders what failed and when it was last
 *     good — never a spinner that never resolves, and never an empty panel
 *     that reads as "no data" when it means "no answer".
 *  3. Serve stale before nothing. Every payload is cached in sessionStorage;
 *     on a failed refetch the last good copy renders with its age stated.
 */
(() => {
  'use strict';

  /* ── data ──────────────────────────────────────────────────────────────── */
  const CACHE = 'sig:';
  const TIMEOUT = 8000;

  /* ── IS THERE ANY REASON TO REPAINT? ───────────────────────────────────
   *
   * The page replaced its entire contents every sixty seconds whether or not
   * a single number had moved. Outside market hours that is every repaint:
   * the same DOM torn down and rebuilt, sparklines redrawn, hover and text
   * selection dropped, for no new information at all. It reads as the page
   * twitching at you.
   *
   * FEEDS remembers the last body seen per URL and bumps feedRev when one
   * genuinely differs. routeUrls remembers which feeds the current route
   * actually read, so refresh() can re-fetch exactly those, compare, and
   * return without rendering when nothing moved.
   *
   * MICRO exists only to make that probe free: the render that follows a
   * changed probe would otherwise request the same URLs a second time within
   * milliseconds. Five seconds is long enough to cover probe-then-render and
   * far too short to serve anyone a stale price. */
  const FEEDS = new Map();
  const MICRO = new Map();
  /* ── TELL SOMEONE WHEN THIS BREAKS ───────────────────────────────────────
   *
   * The Today route threw on every load for a day and nothing knew. The deploy
   * gate's error listener only visited two routes; Cloudflare observability
   * sees the Worker, not a TypeError in a reader's browser — and this whole
   * site is client-rendered, so that is where its failures live.
   *
   * Deliberately tiny and deliberately quiet: no vendor, no third-party
   * script, no identifier of any kind. A message, a stack, the route and the
   * build. It caps itself at five reports per session and dedupes by message,
   * because the failure mode of an error reporter is a broken page reporting
   * the same fault a thousand times.
   *
   * Everything here is wrapped: a reporter that throws while reporting an
   * error is the one bug nobody can debug. */
  const ERR_SEEN = new Set();
  let errSent = 0;
  function reportError(message, stack) {
    try {
      const msg = String(message || '').slice(0, 500);
      if (!msg || errSent >= 5) return;
      const route = (location.pathname || '/').slice(0, 120);
      const key = route + '|' + msg;
      if (ERR_SEEN.has(key)) return;
      ERR_SEEN.add(key);
      errSent++;
      // keepalive so a report survives the navigation that often follows.
      fetch('/api/client-error', {
        method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: msg, route,
          stack: String(stack || '').slice(0, 2000),
          build: (window.__BUILD || ''),
        }),
      }).catch(() => {});
    } catch (e) { /* never let the reporter be the problem */ }
  }
  window.addEventListener('error', e => reportError(e && e.message, e && e.error && e.error.stack));
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason;
    reportError(r && (r.message || r), r && r.stack);
  });

  const MICRO_MS = 5000;
  let feedRev = 0;
  let routeUrls = new Set();

  /* What get() already holds for a URL, without going to the network. Lets a
   * route render immediately on the feeds it has and come back for the rest,
   * instead of every caller awaiting the slowest thing it needs. */
  const CACHED = url => {
    const m = MICRO.get(url);
    if (m && Date.now() - m.at < MICRO_MS) return { ...m.res, ready: true };
    return { ok: false, ready: false, data: null, error: 'still loading' };
  };

  /* ── THE LAST PAYLOAD, WHATEVER ITS AGE ─────────────────────────────────
   *
   * MICRO_MS is a REQUEST-COALESCING window — it stops two sections asking for
   * the same feed in one tick — and CACHED() was being used as if it were a
   * freshness policy as well. Those are different questions, and conflating
   * them silently deleted sections from the page.
   *
   * HOW IT PRESENTED. The front page fires twelve concurrent requests; a
   * browser opens six connections per origin over HTTP/1.1, so the rest queue,
   * and on a loaded server the last of them can sit in that queue past get()'s
   * eight-second abort. By the time the route rendered, the screen and regime
   * payloads had arrived but were older than five seconds, so CACHED() said
   * "still loading" about data sitting in the map, and the heatmap and the
   * regime panel were simply absent from a page that had every byte it needed
   * to draw them. Seven sections instead of nine, no error, nothing in the
   * console. The code's own comment already records this happening twice
   * before — "same fault the heatmap strip had, reintroduced one section
   * over" — which is the signal that the timing was never the bug.
   *
   * These are DAILY feeds. A screen built at 02:10 is not less true at
   * 5.001 seconds after it was read than at 4.999. Age belongs to the
   * freshness bar, which measures and reports it honestly; it does not belong
   * in the decision about whether a section exists.
   *
   * `ready` is deliberately untouched: the heavy-fetch trigger uses it to
   * decide whether to go and get the full screen, and that IS a question about
   * the window. This is a second, narrower accessor for the callers that only
   * want the bytes. */
  const HELD = url => {
    const m = MICRO.get(url);
    return m && m.res && m.res.ok && m.res.data ? m.res : null;
  };

  /* ── TWO CALLERS, ONE REQUEST ─────────────────────────────────────────────
   * The micro-cache below keys on a RESOLVED response, so it cannot see a
   * request that is still in the air — and the duplicates on this site are all
   * concurrent, not sequential. Measured on the front page: 24 requests for 18
   * distinct URLs, with /api/wire, /api/ipo-live and /today.json each fetched
   * twice because two sections asked for them in the same tick.
   *
   * INFLIGHT holds the PROMISE. A second caller for a URL already being
   * fetched waits on the first instead of opening its own connection, and both
   * get the same object. Cleared in a finally so a failed request is retried
   * rather than a rejected promise being handed to every future caller. */
  const INFLIGHT = new Map();

  /* ── WHAT EVERY FEED IS CALLED, IN ONE PLACE ─────────────────────────────
   *
   * Akshay: "I need for all pages freshness widgets animations presentations
   * for each & every line section page entirely."
   *
   * Freshness was reported by six loaders and therefore by whichever routes
   * happened to call them — /research, /engines, /radar, /watch and the stock
   * pages said only "Loaded HH:MM", which is worse than silence because it
   * looks like an answer.
   *
   * Adding a noteFresh() call to twenty routes would be twenty places to
   * forget. get() already sees every fetch the site makes, so the label lives
   * beside the URL and a route reports whatever it touches without knowing
   * this exists. A feed added next year gets one line here and is covered
   * everywhere at once. */
  const FEED_NAMES = {
    '/pulse.json': 'Market pulse', '/signal_v2.json': 'V2 plans',
    '/screen.json': 'Screen', '/screen-lite.json': 'Screen',

    '/ipo.json': 'IPO book', '/funds.json': 'Fund screen',
    '/news.json': 'News', '/edition.json': 'Edition',
    '/swot.json': 'Company notes', '/weekly_reads.json': 'Weekly reads',
    '/data-health.json': 'Pipeline health',
    '/barometer.json': 'Barometer', '/seasonality.json': 'Seasonality',
    '/regime.json': 'Regime',
    '/api/markets': 'Markets', '/api/ticker': 'Live prices',
    '/api/wire': 'Wire', '/api/flows': 'FII & DII', '/api/calendar': 'Calendar',
    '/api/stats': 'All-time stats', '/api/ipo-live': 'IPO demand',
  };
  /* ── FEEDS THE FRESHNESS BAR WILL NOT DOWNLOAD ───────────────────────────
   * url → the FEED_AGE row it fills. A row listed here is passive: the bar
   * never fetches it, and it is filled by whatever route loads the file for
   * its own reasons. The screen is here because it is the largest asset on
   * the site (253 KB brotli, 1.98 MB raw) and the bar was fetching it on
   * every cold load of every route to read one timestamp off the top.
   * Both projections map to the same row — they carry the same stamp, because
   * lite_payload() copies every key but `rows` straight across. */
  const PASSIVE_AGE_ROWS = {
    '/screen.json': 'Stock screen', '/screen-lite.json': 'Stock screen',
  };
  /* The stamp a feed carries is not the same field twice: a build writes
     generated_at, a mirror writes built_on, the screen writes price_date.
     Asked in the order a reader would trust them. */
  const feedStampOf = (d) => {
    if (!d || typeof d !== 'object') return null;
    return d.generated_at || d.at || d.built_at || d.built_on
        || d.price_date || d.date || d.fetched_at || d.published_at || null;
  };

  /* ── ONE LIVE PRICE, WHEREVER THE PAGE ASKS FOR IT ──────────────────────
   *
   * Akshay, with the Volume spurts sheet beside a TradingView chart: the sheet
   * said TATACHEM ₹731.80, "-0.40% today"; the chart said ₹693.25, -11.04%.
   * The heatmap on the SAME PAGE said -11.04% and was right.
   *
   * Neither number was invented. ₹731.80 is the close the screen was BUILT
   * from — screen-lite.json is generated at 02:10 IST and every fundamental on
   * it belongs to that build. ₹693.25 is where the stock trades. The defect
   * was that the sheet printed the build's figure and labelled it "today",
   * which is the one thing it is not, on a day the name fell eleven per cent.
   *
   * This is the same fault liveMark() was written for on the company page, and
   * it was fixed there and nowhere else — so the fix travelled with the page
   * instead of with the data. /api/ticker already carries a `ledger` of 103
   * live quotes and the heatmap already reads it; nothing else could, because
   * it was a local variable in one route.
   *
   * Filled HERE, in the one function every fetch goes through, so any surface
   * that can name a symbol can ask what it trades at without threading the
   * ticker through its callers or paying for a second request. */
  let LIVE_PX = Object.create(null);
  /* Its own normaliser, NOT the bareSym() defined further down. That one
     already exists and does the same job — and declaring a second const of
     that name in the same scope is a SyntaxError that takes the entire bundle
     down, which is how this was caught. This one is scoped to the lookup and
     strips only the suffixes the ledger's keys can carry.
     Number() directly rather than sn(), because this sits far above sn's own
     declaration: every real call happens later, but a helper that depends on
     declaration order is one refactor from a dead-zone crash on the front
     page. */
  const pxKey = (x) => String(x || '').trim().toUpperCase().replace(/\.(NS|BO|BSE|NSE)$/i, '');
  const livePx = (sym) => {
    const k = pxKey(sym);
    const q = k && LIVE_PX[k];
    /* `q.price != null` FIRST, and the guard suite caught that it was missing.
       Number(null) is 0 and 0 is finite, so a ledger entry carrying a null
       price would have passed this test and been returned as a live quote —
       and the sheet would have printed ₹0 beside a real volume multiple, on a
       stock that simply had no mark. This repo has a named rule for exactly
       that coercion and this is the fourth place it has been written wrong. */
    if (!q || q.price == null) return null;
    return Number.isFinite(Number(q.price)) ? q : null;
  };

  async function get(url) {
    routeUrls.add(url);
    const micro = MICRO.get(url);
    if (micro && Date.now() - micro.at < MICRO_MS) return micro.res;
    const flying = INFLIGHT.get(url);
    if (flying) return flying;
    const p = _get(url);
    INFLIGHT.set(url, p);
    try { return await p; } finally { INFLIGHT.delete(url); }
  }

  async function _get(url) {
    const key = CACHE + url;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      /* NAME THE FAILURE WHEN A FEED IS NOT A FEED.
       * A missing .json used to come back as the SPA shell — 200, text/html —
       * and r.json() then failed with a parser message about an unexpected
       * "<", which describes the symptom and not the cause. */
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) throw new Error('not JSON — got an HTML page');
      const j = await r.json();
      /* The live quotes, taken off any ticker response regardless of which
         route asked for it. Guarded end to end: a ticker without a ledger
         leaves the previous map alone rather than emptying it, so a degraded
         response cannot turn every live price on the site back into a stale
         one. */
      try {
        if (String(url).split('?')[0] === '/api/ticker' && j && j.ledger
            && typeof j.ledger === 'object' && Object.keys(j.ledger).length) {
          LIVE_PX = j.ledger;
        }
        /* The per-engine R:R floors, from the file that already computes them.
           Same reason as the price map: the rule was reachable from one route
           and every other surface published without it. */

      } catch (e) { /* a price overlay must never break a feed read */ }
      /* Named here, so a route reports every feed it touched without having to
         know which ones those were. Guarded: a missing label or a feed with no
         stamp is simply not reported, never an error. */
      try {
        const base = String(url).split('?')[0];
        const label = FEED_NAMES[base];
        if (label) noteFresh(label, feedStampOf(j));
        /* AND THE HEADER BAR'S ROW, FOR THE FEEDS IT REFUSES TO FETCH ITSELF.
         * The screen row is filled from whichever projection a route loaded;
         * hooking it HERE rather than in the routes is the same reason
         * noteFresh is here — get() sees every fetch this site makes, and a
         * route added next year inherits it without knowing this exists. The
         * first version hung it off noteScreenMeta(), which four of the nine
         * screen-loading routes do not call, so the front page — which loads
         * screen-lite.json on every visit — reported its own screen as not
         * used on the page. */
        if (PASSIVE_AGE_ROWS[base]) noteFeedAge(PASSIVE_AGE_ROWS[base], j, base);
      } catch (e) { /* freshness must never break a fetch */ }
      // Content, not timestamps: two fetches a minute apart with identical
      // bodies are the same edition and must not trigger a repaint.
      const body = JSON.stringify(j);
      const prev = FEEDS.get(url);
      FEEDS.set(url, body);
      if (prev !== undefined && prev !== body) feedRev++;
      /* ── ONE SERIALISATION, AND NOT DURING THE LOAD ──────────────────────
       *
       * This was `JSON.stringify({ at: Date.now(), j })` — a SECOND full
       * serialisation of an object that had just been serialised on the line
       * above. On screen-lite.json, 1.26 MB, the pair measured 7 ms + 12 ms on
       * a desktop and a phone is three to five times slower. `body` is already
       * that object's JSON, so the wrapper is two literals and a splice; the
       * bytes are identical, which is what makes it a substitution rather than
       * a reimplementation.
       *
       * And it is written when the main thread is next free, not in the
       * middle of the load. A 1.26 MB sessionStorage write is SYNCHRONOUS —
       * another ~10 ms desktop, ~40 ms mobile, blocking paint — and what it
       * buys is a fallback for a LATER failed fetch. Nothing on this load
       * reads it, so nothing on this load should wait for it.
       *
       * The catch names quota first because that is what actually fires here:
       * the origin allowance is ~5 MB and this site's feeds do not fit in it.
       * Silent is correct — the cache is an optimisation and a page that
       * cannot write it is not a page in trouble — but "private mode" named
       * the rarer cause and sent the next reader looking in the wrong place. */
      const stash = () => {
        try { sessionStorage.setItem(key, '{"at":' + Date.now() + ',"j":' + body + '}'); }
        catch (e) { /* over quota, or storage denied (private mode) — either way
                       the stale-copy fallback is simply not available */ }
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(stash, { timeout: 2000 });
      else setTimeout(stash, 0);
      const res = { ok: true, data: j, stale: false };
      MICRO.set(url, { at: Date.now(), res });
      return res;
    } catch (err) {
      let cached = null;
      try { cached = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { /* ignore */ }
      if (cached) return { ok: true, data: cached.j, stale: true, age: Date.now() - cached.at };
      return { ok: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
    } finally { clearTimeout(t); }
  }

  /* ── format ────────────────────────────────────────────────────────────── */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Crore / lakh. "₹1,00,00,000" makes the reader count digit groups to tell a
  // crore from ten lakh, which is the work a headline number exists to save.
  const money = v => {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    const s = n < 0 ? '-' : '', a = Math.abs(n);
    if (a >= 1e7) return s + '₹' + trim(a / 1e7) + ' Cr';
    if (a >= 1e5) return s + '₹' + trim(a / 1e5) + ' L';
    return s + '₹' + Math.round(a).toLocaleString('en-IN');
  };
  const trim = x => String(x.toFixed(2)).replace(/\.?0+$/, '');

  /* ── ONE PRICE FORMAT, EVERYWHERE ────────────────────────────────────────
   *
   * Three formats were live on a single screen. The brief's ladder printed
   * ₹12,540, ₹12,427.44 and ₹8,778.6 one under the other — no decimals, two
   * decimals, and one decimal — because two different local `f` helpers and a
   * `maximumFractionDigits: 2` were formatting the same column. The last of
   * those drops a trailing zero, which is where the single decimal came from.
   *
   * Paise on a ₹12,000 stock are not precision, they are noise: the levels are
   * derived from an ATR measured to the nearest rupee, so printing them to
   * 1/100th claims an accuracy the inputs never had. Below ₹1,000 the second
   * decimal starts carrying real information, and under ₹100 it always does.
   *
   * The rule was already in this file as fmtN(), used by the screen table and
   * nowhere else. It is lifted here so there is one answer rather than four.
   *
   *     >= 1000   no decimals      ₹12,540
   *      < 1000   two decimals     ₹847.25
   */
  /* A LEVEL, OR NOTHING. Every guard around the target ladder asked
   * Number.isFinite, and Number(null) is 0, which is finite — so a blanked
   * target passed every check and was then divided by, priced, and labelled.
   * No traded instrument has a level of zero, so zero is absence here. */
  const lvl = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const price = (v, cur = '₹') => {
    /* NULL IS NOT ZERO, AND Number(null) IS 0.
     *
     * The API blanks a target that collapsed into the one before it — TECHM
     * had T1 and T2 five rupees apart on 24 rupees of risk — and returns null
     * for it, which is the honest answer. This turned that null into 0 and
     * printed "TARGET 2  ₹0.00" on the card, a price no engine ever published
     * and one that reads as a real number. Empty string does the same thing.
     * Only undefined and NaN were ever caught. */
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    /* ── ABOVE ₹1,000 THE PAISE WERE DROPPED, AND LEVELS COLLIDED ──────────
     *
     * Rounding to whole rupees over ₹1,000 is right for a market cap and
     * wrong for a LEVEL. ACE filed an entry at 1229.20 against a close of
     * 1229.45 and the brief printed "₹1,229" for both — two different
     * decisions, one number, and no way for a reader to tell which line was
     * which. The entry slider held the true 1229.2 and therefore disagreed
     * with the text beside it.
     *
     * A price is kept to two decimals whenever it HAS them. A round number
     * still prints round — ₹1,229 stays ₹1,229 — so nothing gains noise it
     * did not have; only a value carrying paise shows them, which is exactly
     * when dropping them loses information. */
    const abs = Math.abs(n);
    const hasPaise = Math.round(abs * 100) % 100 !== 0;
    return cur + abs.toLocaleString('en-IN', (abs >= 1000 && !hasPaise)
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .replace(/^/, n < 0 ? '-' : '');
  };
  /* A SIGNED ZERO IS A LIE ABOUT DIRECTION.
   *
   * This printed the sign from the raw value and the digits from toFixed(2),
   * which disagree either side of half a basis point: -0.001 came out as
   * "-0.00%" and +0.0049 as "+0.00%". Both claim a direction the printed
   * number does not support, on a page where the sign is deliberately the
   * only carrier of direction that does not depend on colour.
   *
   * The sign is now taken from the ROUNDED value, so it always agrees with
   * the digits beside it, and an unchanged instrument prints a bare 0.00% —
   * which is the whole truth about a move of zero. */
  const pct = v => {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    const r = Number(n.toFixed(2));
    return (r > 0 ? '+' : '') + (r === 0 ? '0.00' : r.toFixed(2)) + '%';
  };
  const dir = v => Number(v) > 0 ? 'up' : Number(v) < 0 ? 'dn' : '';
  /* LENDERS ARE READ DIFFERENTLY — the screen's rule, word for word
     (stock_screen.py::_is_financial). A bank or NBFC borrows to lend, so debt/
     equity of 4 is its business model and operating cash flow swings with its
     loan book; the screen leaves leverage, cash conversion, interest cover,
     margins and ROCE out of its scores and risk grade for these names. This
     page used to judge them anyway ("leveraged", "not all arriving as cash")
     beside a Risk LOW the screen had graded correctly. guard.mjs holds this
     copy, insight.js's and the Python to the same four words. */
  const isLender = r => /financial|bank|insurance|real estate/.test(`${(r && r.sector) || ''} ${(r && r.ind) || ''}`.toLowerCase());
  const LENDER_NOTE = 'a lender borrows to lend — not judged here';
  /* ── "OFF ITS HIGH" MUST NOT BE A POSITIVE NUMBER ────────────────────────
   * from_high is measured against the 52-week high as of the last complete
   * bar, so a stock printing a new high today comes back POSITIVE — and the
   * cell rendered "0.4%" under a label that says "off its high", which reads
   * as 0.4% below when it is 0.4% above. FINCABLES showed exactly that.
   * Above the range top is not a distance from it; it is a new high. */
  const offHigh = v => {
    const n = Number(v);
    if (v === null || v === undefined || !Number.isFinite(n)) return null;
    return n >= 0 ? { txt: 'at a new high', cls: 'up' }
                  : { txt: n.toFixed(1) + '%', cls: dir(n) };
  };


  const ago = ms => { const m = Math.round(ms / 60000); return m < 60 ? m + 'm' : Math.round(m / 60) + 'h'; };

  /* Outbound detail links.
   *
   * Deliberately NOT a modal fed by screen-detail.json: that file is 3.1 MB,
   * and this surface exists because a phone should not download 3.1 MB to read
   * one company. Screener.in already renders the filings better than a modal
   * would, and TradingView already renders the chart — linking out costs one
   * tap and zero bytes until the reader asks.
   */
  const chartUrl  = (sym, tv) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tv || ('NSE:' + sym))}`;
  const detailUrl = sym => `https://www.screener.in/company/${encodeURIComponent(sym)}/consolidated/`;
  /* VISION IS THE CHILD PRODUCT: Signal says what deserves attention, Vision
     is where one company is understood. Every link to it goes through these
     two — guard.mjs allows no other spelling of the host. The file key rule is
     the one scripts/company-pages.mjs writes company pages under. */
  const VISION_URL = 'https://vision.askakshay.com';
  const visionUrl = sym => `${VISION_URL}/company/${String(sym).toUpperCase().replace(/\.NS$/, '').replace(/[^A-Z0-9-]/g, '_')}`;
  const symLinks = (sym, tv) => !sym ? '' :
    `<span class="lnks">
      ${!tv || /^NSE:/.test(tv) ? `<a href="${visionUrl(sym)}" title="Open ${esc(sym)} in Vision — what matters, what changed">Vision ↗</a>` : ''}
      <a href="${detailUrl(sym)}" target="_blank" rel="noopener" title="Fundamentals on Screener.in">Details</a>
      <a href="${chartUrl(sym, tv)}" target="_blank" rel="noopener" title="Chart on TradingView">Chart</a>
    </span>`;

  /* Live prices for arbitrary symbols, from /api/signals?px=.
   * Batched into one request — 30 cards asking individually is 30 round trips
   * and Yahoo rate-limits long before that. */
  async function quotes(syms) {
    // Every quote this page fetches is also an alert check. No worker, no
    // push, no server — an alert fires while you are looking at the site,
    // which is the honest limit of a static front end over a read-only API.

    /* ── .slice(0, 40) WAS SILENTLY THROWING AWAY THE TAIL ─────────────────
     *
     * The endpoint takes 40 symbols a call, and this respected that by
     * TRUNCATING the list — so the 41st symbol onward was never asked about,
     * and the page rendered "no mark" beside it as though no price existed.
     *
     * Measured on the live ledger: 58 open signals, 40 quoted, and exactly
     * 18 rows reading "no mark" — CEMPRO, ASHOKLEY, MINDACORP and fifteen
     * others. MINDACORP is the proof it was never a data gap: asked for on
     * its own, /api/signals?px=MINDACORP returns ₹707. The quote existed the
     * whole time; the request for it was cut off.
     *
     * "No mark" is a real state and still has to exist — a US equity, a
     * commodity or a crypto pair in this ledger genuinely has no NSE quote,
     * and saying so is honest. But it must mean "there is no price for this",
     * never "I stopped asking at forty".
     *
     * So: chunk instead of truncate, and run the chunks in parallel — two
     * requests for 58 symbols, not one request and a shrug. */
    const list = [...new Set((syms || []).filter(Boolean))];
    if (!list.length) return {};
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));

    const parts = await Promise.all(batches.map(b =>
      get('/api/signals?px=' + encodeURIComponent(b.join(',')))));

    const all = {};
    for (const r of parts) {
      if (r.ok && r.data && r.data.quotes) Object.assign(all, r.data.quotes);
    }
    /* One alert pass over the whole set, not one per batch: checkAlerts
       dedupes by symbol, and firing it twice re-notifies the first 40. */
    if (Object.keys(all).length) {
      try { checkAlerts(all); } catch (e) { /* never break a quote fetch */ }
    }
    return all;
  }
  // Unrealised move on an unfilled order or an open signal. Direction-aware:
  // a SELL signal that falls is winning, and treating every position as long
  // is how a short book reports its losses as gains.
  const pnlOf = (entry, last, action) => {
    const e = Number(entry), l = Number(last);
    if (!isFinite(e) || !isFinite(l) || e === 0) return null;
    const raw = (l - e) / e * 100;
    return /SELL|SHORT/i.test(String(action || '')) ? -raw : raw;
  };

  const skel = (cls, n) => Array.from({ length: n }, () => `<div class="sk ${cls}"></div>`).join('');
  const fail = (what, why) =>
    `<div class="note err"><b>${esc(what)} did not load.</b> ${esc(why)}. Everything else on this page is unaffected.</div>`;
  const staleNote = age =>
    `<div class="note">Showing the last good copy, <b>${ago(age)}</b> old — the live call did not answer just now.</div>`;

  /* ── shell ─────────────────────────────────────────────────────────────── */
  const main = document.getElementById('main');
  /* Every route repaints <main> wholesale, so listeners bound to nodes inside
   * it die with them. Listeners bound to WINDOW or DOCUMENT do not — the brief
   * binds a scroll handler and a keyboard handler that would otherwise stack
   * up one copy per repaint, and the page repaints itself every 60 seconds.
   * paint() fires a teardown first so those can remove themselves. */
  /* THE FIRST SKELETON MUST NOT WIPE THE SNAPSHOT.
   *
   * index.html ships with a small pre-rendered summary of the day inside
   * <main> (scripts/prerender.mjs), so anything that does not run JavaScript
   * still gets content. Every route then opens by painting its skeleton — and
   * on a fast connection that is invisible, but on a slow one it replaced real
   * content with grey boxes and then put real content back. Measured at 1.2s
   * per request: 986 characters of readable summary became 138 characters of
   * skeleton for several seconds.
   *
   * So the very first paint is allowed to be skipped if it is only a skeleton.
   * The snapshot holds until the route has something real — data, or an error
   * state, both of which say more than a grey box. Exactly once: after any
   * non-skeleton paint the flag drops and paint() behaves normally forever. */
  let preIntact = !!main.querySelector('.pre');
  /* ── SORTING, ON EVERY LIST, WITHOUT REWRITING EVERY LIST ────────────────
   *
   * Akshay: "Research floor page etc — sorting on table allow, all pages
   * sorting option enable."
   *
   * The signals page already sorts, because its route owns its rows and can
   * re-sort the DATA and redraw. Every other list on this site — the research
   * floor's two grids, the alert log, the engine lists — renders straight to
   * HTML and had no sort at all. Writing a bespoke sorter into each route
   * would be the same forty lines copied eight times, and each copy would
   * drift.
   *
   * So this sorts the RENDERED ROWS instead: one enhancer, run after every
   * paint, over any `.sg-head` grid on the page. It is a view operation, which
   * is exactly what sorting a list is.
   *
   * THREE THINGS IT HAS TO GET RIGHT, and each is a bug if missed:
   *
   * 1. A ROW IS NOT ONE ELEMENT. xrow() emits the row AND a sibling `.xd`
   *    detail panel holding its ladder and brief. Sorting the rows alone
   *    shuffles summaries over other rows' details — every expanded fold
   *    would then show another signal's numbers. Rows move as pairs.
   *
   * 2. A PRICE IS NOT A STRING. "₹1,189.60", "-2.30%" and "4.52R" must order
   *    as numbers or the sort is alphabetical nonsense — ₹9 above ₹1,189.
   *    Strip the currency, commas, percent and trailing R, then fall back to
   *    locale string compare for genuinely textual columns.
   *
   * 3. BLANKS SINK IN BOTH DIRECTIONS. An unpriced row is not a small one —
   *    the same rule the signals route already applies to its own sort, kept
   *    identical here so the two cannot disagree.
   *
   * Routes that own their sort keep it: a `.sg-head` whose cells already
   * carry data-sg is skipped, so the signals page still sorts its full data
   * set rather than only the rows currently in the DOM. */
  const GRID_NUM = /^[₹$€£\s]*-?[\d,]+(\.\d+)?\s*[%RrxX]?$/;
  const gridVal = (cell) => {
    const raw = (cell ? cell.textContent : '').trim();
    if (!raw || raw === '—' || /^no mark$/i.test(raw)) return null;
    if (GRID_NUM.test(raw)) {
      const n = Number(raw.replace(/[₹$€£,\s%RrxX]/g, ''));
      if (Number.isFinite(n)) return n;
    }
    return raw.toLowerCase();
  };

  const sortableGrids = (scope) => {
    scope.querySelectorAll('.sg-head').forEach(head => {
      // The route owns this one — leave it alone.
      if (head.querySelector('[data-sg]')) return;
      const body = head.nextElementSibling;
      if (!body || !body.children.length) return;

      const cells = [...head.children];
      // Pair each row with its detail panel so they travel together.
      const units = [];
      for (const el of [...body.children]) {
        if (el.classList.contains('xd')) {
          if (units.length) units[units.length - 1].push(el);
          continue;
        }
        units.push([el]);
      }
      if (units.length < 2) return;

      cells.forEach((cell, i) => {
        const label = cell.textContent.trim();
        if (!label) return;               // spacer column (the direction dot)
        cell.setAttribute('role', 'button');
        cell.tabIndex = 0;
        cell.classList.add('sg-h');
        cell.setAttribute('aria-sort', 'none');
        cell.title = `Sort by ${label}`;

        const hit = () => {
          const was = cell.dataset.dir;
          /* FIRST CLICK GOES THE WAY THE COLUMN IS READ. A name column wants
             A-Z; a price or a score wants the biggest first. Decided from the
             column's own first non-blank value, so it is right for a column
             this sorter has never seen. Same rule the signals route uses for
             its own header. */
          let dir;
          if (was) dir = was === 'desc' ? 'asc' : 'desc';
          else {
            let probe = null;
            for (const u of units) {
              probe = gridVal(u[0].children[i]);
              if (probe != null) break;
            }
            dir = typeof probe === 'number' ? 'desc' : 'asc';
          }
          cells.forEach(c => {
            delete c.dataset.dir;
            c.setAttribute('aria-sort', 'none');
            c.classList.remove('on');
            const ar = c.querySelector('.scr-ar'); if (ar) ar.remove();
          });
          cell.dataset.dir = dir;
          cell.classList.add('on');
          cell.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
          cell.insertAdjacentHTML('beforeend',
            `<i class="scr-ar">${dir === 'asc' ? '▲' : '▼'}</i>`);

          const sign = dir === 'asc' ? 1 : -1;
          units.sort((ua, ub) => {
            const va = gridVal(ua[0].children[i]), vb = gridVal(ub[0].children[i]);
            const na = va == null, nb = vb == null;
            if (na !== nb) return na ? 1 : -1;   // blanks sink either way
            if (na) return 0;
            if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
            return String(va).localeCompare(String(vb)) * sign;
          });
          const frag = document.createDocumentFragment();
          units.forEach(u => u.forEach(el => frag.appendChild(el)));
          body.appendChild(frag);
        };

        cell.addEventListener('click', hit);
        cell.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hit(); }
        });
      });
    });
  };

  /* ── WHEN WHAT YOU ARE READING WAS LAST WRITTEN ──────────────────────────
   *
   * Akshay: "add last refresh time page on each page, small details."
   *
   * He asked immediately after the ledger handed him a copy that predated a
   * scan he knew had run — 61 published, no sign of the two filed minutes
   * earlier. The edge was serving a cached copy and the page said nothing,
   * so the only reading available was "the site is broken".
   *
   * FRESHNESS IS PER FEED, NOT PER PAGE, and that is the whole point. This
   * site draws one route from as many as four sources — the ledger over
   * Turso, a nightly screen file, an hourly wire, the exchange calendar —
   * and they age at completely different rates. A single "updated 5m ago"
   * would be a lie about three of them. Each route reports the feeds it
   * actually read, with each one's own stamp.
   *
   * "Loaded" is always shown and is deliberately the LAST item: it is the
   * one timestamp that says nothing about the data, and a reader who sees
   * only that knows the route reported no feed rather than being told
   * something fresh. */
  let FRESH = [];
  const freshFmt = (ts) => {
    const h = ageHours(ts);
    if (h == null) return null;
    const m = Math.round(h * 60);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (h < 36) return Math.round(h) + 'h ago';
    return Math.round(h / 24) + 'd ago';
  };
  const renderFresh = () => {
    const el = document.getElementById('freshBar');
    if (!el) return;
    const loaded = new Date();
    const hhmm = String(loaded.getHours()).padStart(2, '0') + ':'
               + String(loaded.getMinutes()).padStart(2, '0');
    /* ── OLDEST FIRST, AND NOT ALL OF THEM ────────────────────────────────
     * Reporting every feed a route touched turned out to be ten items on
     * /research, which is a paragraph of small print nobody reads — and the
     * one number that matters is buried in it.
     *
     * The risk is always the OLDEST feed, so that leads. Six are shown and
     * the rest are counted, because a reader who wants to know whether the
     * page is current needs the worst case, not an inventory. */
    const scored = FRESH
      .map(([label, ts]) => ({ label, ts, w: freshFmt(ts), h: ageHours(ts) }))
      .filter((x) => x.w);
    scored.sort((a, b) => (b.h || 0) - (a.h || 0));
    const SHOW = 6;
    const parts = scored.slice(0, SHOW).map((x) => {
      // Anything past a day is worth marking, not just stating.
      const old = (x.h || 0) >= 24;
      return `<span${old ? ' class="is-old"' : ''}><i>${esc(x.label)}</i> ${esc(x.w)}</span>`;
    });
    if (scored.length > SHOW) {
      parts.push(`<span><i>+${scored.length - SHOW}</i> fresher</span>`);
    }
    parts.push(`<span><i>Loaded</i> ${hhmm}</span>`);
    el.innerHTML = parts.join('');
  };
  /* Called by a route once it knows what it read. Later calls for the same
     label replace the earlier one rather than stacking a second copy. */
  const noteFresh = (label, ts) => {
    if (!ts) return;
    const i = FRESH.findIndex(x => x[0] === label);
    if (i >= 0) FRESH[i] = [label, ts]; else FRESH.push([label, ts]);
    try { renderFresh(); } catch (e) { /* never break a route over a timestamp */ }
  };
  // Cleared on NAVIGATION, not on paint: one route paints several times as
  // its feeds land, and clearing per paint would blank what it just reported.
  const resetFresh = () => { FRESH = []; try { renderFresh(); } catch (e) {} };

  /* ── LAY THE SECTIONS OUT AS A GRID, AFTER THE ROUTE HAS WRITTEN THEM ────
   *
   * Done here rather than by changing twenty routes to emit a wrapper. Each
   * route still returns a flat list of sections and knows nothing about the
   * layout — which is what lets a route added later inherit it for free, and
   * what lets the whole thing be removed by deleting this function.
   *
   * WHAT OPTS OUT, and why each one has to:
   *   · the LEAD section — it is the answer the page exists to give;
   *   · anything holding a table, a board, a chart or the full-width folds —
   *     a 989-row screen or the 71-instrument board in half a column is not a
   *     compromise, it is unreadable.
   * Everything else pairs up, which is where the width on a desktop finally
   * goes to work.
   */
  /* WHAT GENUINELY NEEDS THE FULL WIDTH — tables, boards and multi-column
     card grids. NOT the widgets: a split bar, a ring and a meter were written
     to work in a column and listing them here made "Breadth" a full-width
     panel holding one bar, which then sat between two half-width sections and
     stopped them pairing. A widget that fits is not an exception. */
  const WIDE_SEL = '.rank,.board,table,.mkgrid,.sgrid,.scr-t,.cards-2,.mbg,.ipo-t,#ipotbl,.v2-wide';
  const gridSections = (scope) => {
    const secs = [...scope.querySelectorAll(':scope > section.sec')];
    if (secs.length < 3) return;                 // two panels is not a grid
    for (const el of secs) {
      if (el.classList.contains('is-lead')) continue;
      /* A WIDE THING BEHIND A CLOSED FOLD IS NOT WIDE YET.
       * The first version asked only "does this section contain a table", and
       * on the front page three of the four opt-outs were tables inside
       * COLLAPSED disclosures — a heading and one line of summary, claiming
       * the full width for content nobody has opened. Only one pair formed
       * out of seven sections, which is the layout doing the opposite of what
       * it was added for.
       * So the question is whether the wide content is currently VISIBLE.
       * Open the fold and the section is still half a column, which is the
       * one case this cannot fix from here — but a reader who opens a
       * 989-row table has asked for it, and the table scrolls in its own
       * container either way. */
      const wide = [...el.querySelectorAll(WIDE_SEL)].some((w) => {
        const fold = w.closest('details');
        return !fold || fold.open;
      });
      if (wide) el.classList.add('sec-wide');
    }
    /* ── TWO REAL COLUMNS, NOT ONE MULTICOL CONTAINER ────────────────────
     *
     * THE BUG THIS FIXES MADE THE SITE LOOK BROKEN. The previous version put
     * every section into one `.secgrid` and let CSS `column-count:2` pack
     * them. That removed the voids a row-based grid leaves, and introduced
     * something far worse: a multicol container RE-BALANCES EVERY COLUMN
     * whenever any child changes height. This page is full of <details>. So a
     * reader scrolled to "Open the 5 ranked names", clicked it, and the five
     * cards were laid out at the TOP OF THE RIGHT-HAND COLUMN — measured at
     * y=155 while the summary they clicked sat near y=1100. The content was
     * there, correct and complete, and entirely outside the part of the page
     * they were looking at. Every fold on the site behaved this way: the IPO
     * books, the engine roster, the conviction names. It reads as "I clicked
     * and nothing happened", which is exactly how it was reported.
     *
     * Two explicit column elements do not have that property. A section that
     * grows pushes only the sections BELOW IT IN ITS OWN COLUMN; the other
     * column does not move, and nothing is re-ordered. It is the difference
     * between a layout that packs once and a layout that re-packs on every
     * interaction.
     *
     * ALTERNATING, not height-balanced. Balancing needs measurement, and
     * measurement after paint is a reflow loop — which on this site means
     * rAF, which does not run in a hidden tab, which is a documented trap
     * here. Alternating is deterministic, preserves top-to-bottom order down
     * each column, and is the same pairing the row-based grid produced before
     * any of this. What it costs is a ragged BOTTOM edge on one column, which
     * is one void at the end of a run rather than one under every pair.
     *
     * A FULL-WIDTH SECTION CLOSES THE RUN. `column-span:all` used to do this
     * for free; here a lead or wide section ends the current pair of columns
     * and the sections after it start a fresh one, which is the same reading
     * order and the same chapter-break behaviour. */
    let run = null;
    const closeRun = () => { run = null; };
    const openRun = (before) => {
      const wrap = document.createElement('div');
      wrap.className = 'secgrid';
      const a = document.createElement('div'); a.className = 'secgrid-col';
      const b = document.createElement('div'); b.className = 'secgrid-col';
      wrap.append(a, b);
      before.before(wrap);
      run = { wrap, cols: [a, b], n: 0 };
      return run;
    };
    for (const el of secs) {
      const full = el.classList.contains('is-lead') || el.classList.contains('sec-wide');
      if (full) {
        /* Left exactly where it is in the flow, spanning the content width on
           its own. Moving it into a wrapper would change nothing except the
           number of elements between it and the page. */
        closeRun();
        continue;
      }
      const r = run || openRun(el);
      r.cols[r.n % 2].appendChild(el);
      r.n += 1;
    }
    /* A run that ended up with one section is not a pair — unwrap it so the
       section takes the full width rather than sitting in a half-width column
       beside nothing. */
    for (const wrap of scope.querySelectorAll(':scope > .secgrid')) {
      const kids = [...wrap.querySelectorAll(':scope > .secgrid-col > section.sec')];
      if (kids.length > 1) continue;
      for (const k of kids) wrap.before(k);
      wrap.remove();
    }
  };

  /* `placeholder` is DECLARED BY THE CALLER, not sniffed out of the markup.
   *
   * THE BUG THIS FIXES, which had been live and invisible. The rule is right —
   * a skeleton payload must not replace the prerendered snapshot, or a direct
   * load flashes real content away and puts grey bars back. The TEST was
   * wrong: it asked whether the html contained a skeleton class, and
   * stockCard() legitimately ships one — `<div id="ccHost"><div class="sk">`
   * is the slot the price chart is drawn into after the series arrives.
   *
   * So every DIRECT load of /stock/:sym — a refresh, a bookmark, a shared
   * link, a search result — built 23 KB of company card, handed it to paint(),
   * and had the whole thing discarded on account of one 150px chart slot. The
   * reader was left looking at the prerendered front page under a title that
   * said CRIZAC. In-app navigation worked, because preIntact was already false
   * by then, which is exactly why it survived: the only way to see it was to
   * arrive at the URL cold, and the suite navigates.
   *
   * A payload cannot tell you what it is FOR by what it contains. The ten
   * call sites that paint a placeholder now say so, the heuristic is gone, and
   * a real page carrying a skeleton slot renders. */
  const paint = (html, placeholder) => {
    if (preIntact) {
      if (placeholder) return;
      preIntact = false;
    }
    main.dispatchEvent(new CustomEvent('sig:teardown'));
    main.innerHTML = html;
    /* After the route has written its markup, never before: the grids do not
       exist until it has. Guarded because a sorter must never be the reason a
       page fails to render. */
    try { gridSections(main); } catch (e) { /* a single column still reads */ }
    try { sortableGrids(main); } catch (e) { /* a list that cannot sort still reads */ }
    /* Decoration on top of figures that are ALREADY correct on screen. If this
       throws, or never runs because the tab is hidden, the page is unchanged —
       which is the whole reason the widgets render their finished state. */
    try { runWidgets(main); } catch (e) { /* never break a page over an animation */ }
  };

  // A mono eyebrow, a serif headline, one line of standfirst — the brief's
  // masthead rhythm, now the rhythm of every route. `eyebrow` defaults to the
  // product name so a route that says nothing still gets the structure.
  /* The brief runs to roughly 1,400 words plus its levels. At an unhurried
   * 200 wpm that is about seven minutes to read in full, and about sixty
   * seconds to get the setup, the stop and the target — which is what the CTA
   * promises. Stated here once so the header and the hero cannot disagree. */
  const CURVE_MIN = '60 seconds';

  /* DAY ONE. Every performance figure on this site counts from here and says
   * so. It was a local inside the signals route, which is why the brief's own
   * record section was still quoting the all-time ledger — two populations
   * under one product. */
  /* THE RECORD RESTARTS ON THE DAY THE STOP RULES CHANGED.
   *
   * 2026-09-02 is not an arbitrary line. Measured over 113 closed trades,
   * breakout's stop sat at 0.29x the name's own ATR and ohl's at 0.78x — both
   * inside the range those instruments cover in a normal session, so they were
   * taken out by noise rather than by the trade being wrong (90.9% and 91.7%
   * stop-out). Both were corrected today, along with breakout sizing a
   * weeks-long trade off daily bars.
   *
   * Every signal before this line was generated under stops this site now says
   * were wrong. Showing them under a heading that reads "the record" would be
   * grading the new rules with the old rules' results.
   *
   * THIS IS A FILTER, NOT A DELETION, AND THAT IS DELIBERATE. Both sites read
   * one Turso table; deleting those rows would erase news.askakshay.com's
   * history too, which is where they are still published in full. Nothing is
   * lost — signal.askakshay.com simply stops claiming them as its own record.
   *
   * The cutoff was 2026-08-29, the publish date. Moving it costs the site
   * 22 published and 5 closed trades, all five of them losses. */
  const LAUNCH = ENGINE_BOOK.LAUNCH;   /* one date, in engines.js */

  /* ONE CUTOFF, ON THE PUBLISH DATE, EVERYWHERE.
   *
   * This read `closed_at || date`, which let a signal PUBLISHED on 3 August
   * through the filter because it CLOSED after launch. The record tiles used a
   * different rule — publish date — so one page reported "25 published, 0
   * closed" beside a cumulative-R curve built from 13 closed signals, none of
   * which this site had published. The curve was drawing an engine's history
   * under a heading that said "every alert this site has sent".
   *
   * The question this page answers is "what has this site published and how
   * did it do", so the only date that can decide membership is the date it was
   * published. A trade that closes after launch but was called before it is
   * not part of the record; it is part of what came before, which is not shown
   * here at all. */
  const pubDay = r => String(r.alert_date || r.date || '').slice(0, 10);
  const sinceLaunch = r => pubDay(r) >= LAUNCH;

  /* Wins, losses and expectancy over an arbitrary set of ledger rows. The site
   * used /api/stats for this, which is all-time and cannot be filtered. */
  /* ── WHAT COUNTS AS A SCORED TRADE — ONE DEFINITION, THREE CALLERS ───────
   *
   * r_multiple != null FIRST: Number(null) is 0 and 0 is finite, so an
   * ungraded row would otherwise be counted as a closed trade booked at
   * exactly 0R — in the trade count, the win rate and the expectancy this
   * site publishes.
   *
   * THIS WAS FIXED HERE AND NOWHERE ELSE, WHICH IS WHY IT CAME BACK. Three
   * places asked the same question and two of them dropped the null guard:
   * the per-engine roster and the equity curve. On 2026-09-15 the roster's
   * columns summed to SIX closed trades under a header that said FIVE, and
   * the sixth was TATAINVEST — a WITHDRAWN setup, never taken, ungraded —
   * entering the table as a closed trade at 0R and pulling TIDAL's win rate
   * down with it. The equity curve had the same hole, under a comment
   * promising "rows without one are skipped rather than assumed flat".
   *
   * A predicate copied into three files is three chances to fix two of them.
   * This is the definition; everything that counts closed trades calls it. */
  /* A withdrawn setup is not a signal: pulled before it could be taken, and
   * excluded from every expectancy query upstream. It is kept in the ledger
   * and reported by the API — it just never appears as an idea or a trade.
   * Defined here, beside isScored, because /signals was hiding it while the
   * FRONT PAGE still counted it: Akshay saw TATAINVEST on the home record
   * the day after it came off the ledger page. */
  const withdrawn = r => (r.badge || '').toLowerCase() === 'cancelled'
                      || String(r.status || '').toUpperCase() === 'CANCELLED';

  const isScored = r => r != null && r.r_multiple != null
    && Number.isFinite(Number(r.r_multiple))
    && (r.badge || '') !== 'open';

  /* ── HOW A CLOSE READS, AND WHEN IT HAPPENED ─────────────────────────────
   * The front page shows the record as totals and as single trades. These are
   * the words and dates the single trades use, in one place, so the home page
   * and anything after it say "stopped out" for SL_HIT the same way. An
   * EXPIRED or TIME_STOP close has an R marked at the last close rather than
   * realised at an exit, and it says so — that is not the same sentence as a
   * stop or a target. */
  const CLOSE_WORD = { SL_HIT: 'stopped out', T1_HIT: 'first target', T2_HIT: 'second target',
                       T3_HIT: 'third target', TIME_STOP: 'time stop, marked at the close',
                       EXPIRED: 'expired, marked at the close' };
  const closeWord = r => CLOSE_WORD[String(r.status || '').toUpperCase()]
    || String(r.status || r.badge || 'closed').toLowerCase().replace(/_/g, ' ');
  const closedDay = r => String(r.closed_at || '').slice(0, 10);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}` : '—';
  const signedR = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + 'R';
  /* Today in IST, as YYYY-MM-DD — the exchange's calendar, not the reader's. */
  const istDay = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  /* The trailing window, not the calendar month. A month-to-date figure reads
     "no closes" on the 1st of every month, which is the one day a reader most
     wants to know how the last few weeks went. */
  const windowOf = (closed, days = 30) => {
    const from = new Date(Date.parse(istDay() + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
    const inW = closed.filter(r => closedDay(r) >= from);
    return { n: inW.length, wins: inW.filter(r => Number(r.r_multiple) > 0).length,
             sum: inW.reduce((a, r) => a + Number(r.r_multiple), 0), days };
  };

  /* ── "TOO FEW TO SETTLE ANYTHING" WAS A CLAIM, AND IT WAS FALSE ──────────
   *
   * The front page printed that caveat whenever fewer than thirty trades had
   * closed. On 2026-09-19 it sat under 13 closed, 1 win, -0.765R — a result
   * that IS significant:
   *
   *     t = -2.79 on 12 df, two-sided p = 0.016
   *     95% CI on expectancy [-1.363R, -0.168R] — excludes zero
   *     P(1 win or fewer in 13 | 50% win rate) = 0.0017
   *
   * A small sample and an inconclusive one are different things, and a page
   * whose whole argument is that it reports its own losses honestly cannot
   * soften the one number that is unambiguously bad. This is the same defect
   * as the Math.abs(t) bug fixed on the regime panel — a test that could only
   * congratulate, never conclude.
   *
   * THE T-TEST LEADS, NOT THE COIN FLIP. A 50% win rate is the wrong null for
   * a system with asymmetric payoffs: at a 1.6R first target the break-even
   * win rate is about 38%, so "12 losses in 13 would be a 1-in-585 coin flip"
   * overstates the case. The t-test is on the R multiples themselves, which
   * prices the asymmetry directly and asks the question that matters: is the
   * expectancy different from zero.
   *
   * WHAT IT STILL MAY NOT CLAIM. Significance fixes the SIGN, not the size —
   * that interval runs from -0.17R to -1.36R, which is the difference between
   * a small leak and a catastrophe, and 13 trades cannot tell them apart. So
   * the sentence states the direction as settled and the magnitude as open,
   * and never rounds the sample up into an authority it does not have.
   *
   * Everything is computed from the rows. A hardcoded p-value is a number that
   * goes stale the next time a trade closes. */
  const tStat = R => {
    const n = R.length;
    if (n < 2) return null;
    const m = R.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(R.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    if (!(sd > 0)) return null;
    return m / (sd / Math.sqrt(n));
  };
  /* Student's t two-sided p, via the regularised incomplete beta. Written out
     because the alternative is a table of critical values, and a table is a
     hardcoded answer to a question whose inputs move every time a trade
     closes. */
  const lgamma = x => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
               -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, t = x + 5.5;
    t -= (x + 0.5) * Math.log(t);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -t + Math.log(2.5066282746310005 * ser / x);
  };
  const betacf = (a, b, x) => {
    const MAX = 200, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAX; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  };
  const betai = (a, b, x) => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b)
                        + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2)
      ? bt * betacf(a, b, x) / a
      : 1 - bt * betacf(b, a, 1 - x) / b;
  };
  const tPValue = (t, df) => (t == null || !(df > 0)) ? null
    : betai(df / 2, 0.5, df / (df + t * t));

  /* ── WHAT THE RECORD IS ENTITLED TO SAY ABOUT ITSELF ────────────────────
   * One sentence, three branches, computed from the interval rather than from
   * the trade count. `thin` used to decide this and a count cannot: thirteen
   * trades is a small sample AND a significant result, and those are not in
   * conflict. Returns '' when there is genuinely nothing to conclude. */
  /* `short` for the hero, full for the record. The conclusion belongs in the
     largest type; the interval, the t and the p belong beside the tiles that
     produced them. Printing all of it twice made the fold 613px to say what
     the second sentence already said. */
  const verdictOf = (rec, short) => {
    if (!rec || !rec.trades) return '';
    const n = rec.trades, ci = rec.ci;
    if (!ci) return `One closed trade settles nothing in either direction.`;
    if (!rec.significant) {
      return short
        ? `Too few to settle anything — the 95% interval still includes zero.`
        : `At ${n} closed the 95% interval runs ${fmtR(ci[0])} to ${fmtR(ci[1])}
           and includes zero — too few to settle anything, and shown anyway.`;
    }
    const dir = ci[1] < 0 ? 'negative' : 'positive';
    if (short) {
      return `<b>Statistically ${dir}</b> — the 95% interval excludes zero
        (${fmtR(ci[0])} to ${fmtR(ci[1])}), so the sign is settled even though
        ${n} trades cannot settle the size.`;
    }
    return `<b>Statistically ${dir}</b>, not merely unlucky: the 95% interval on
      expectancy runs ${fmtR(ci[0])} to ${fmtR(ci[1])} and <b>excludes zero</b>
      (t&nbsp;=&nbsp;${rec.t}, p&nbsp;=&nbsp;${fmtP(rec.p)} on ${n} closed).
      ${n < 30 ? `That fixes the <b>sign</b> and not the <b>size</b> — an interval
        that wide is the difference between a small leak and a bad one, and ${n}
        trades cannot tell them apart. Still short of the 30 this book requires
        before it trusts an engine.` : ''}`;
  };
  const fmtR = v => `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}R`;

  /* ── SIGNAL INTEGRITY ─────────────────────────────────────────────────
   * The arithmetic of the book, as an instrument rather than a sentence:
   * every signal in the book in exactly one bucket, the buckets summing to
   * the total in plain sight, and the population, cutoff and as-of beside
   * them. It was a sentence ("50 published = 15 + 35 + 0 + 0"), which a
   * reader has to parse to audit — and which printed `undefined` four times
   * the one week the book had nothing closed.
   *
   * The sum is ASSERTED here, not left to the reader: if the buckets ever
   * fail to add up the block says so in red rather than rounding it away. */
  const integrityBlock = (LR) => {
    const b = LR.bucket || { closed: 0, open: 0, withdrawn: 0, expired: 0, other: 0 };
    const cells = [['Closed', b.closed, 'graded to an R multiple'], ['Open', b.open, 'not yet resolved'],
                   ['Expired', b.expired, 'never filled'], ...(b.other ? [['Other', b.other, 'no recognised state']] : [])];
    const sum = cells.reduce((a, c) => a + (Number(c[1]) || 0), 0);
    const ok = sum === LR.published;
    const at = LR.asOf ? new Date(LR.asOf) : null;
    const when = at && Number.isFinite(at.getTime())
      ? at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST'
      : null;
    return `<div class="integ" role="group" aria-label="Signal integrity">
      <div class="integ-h"><b>Signal integrity</b><span>${LR.live === false ? 'build-time snapshot' : 'live ledger'}</span></div>
      <div class="integ-r">
        <div class="integ-c tot"><b>${LR.published}</b><em>in the book</em></div>
        <i class="integ-eq" aria-hidden="true">=</i>
        ${cells.map(([k, v, t], n) => `${n ? '<i class="integ-eq" aria-hidden="true">+</i>' : ''}<div class="integ-c${v ? '' : ' z'}" title="${esc(t)}"><b>${v}</b><em>${esc(k)}</em></div>`).join('')}
      </div>
      ${ok ? '' : `<p class="integ-bad">These do not sum to ${LR.published} (they sum to ${sum}). That is a defect in this page, not rounding — the ledger itself is the authority.</p>`}
      <dl class="integ-m">
        <div><dt>Population</dt><dd>Long signals from live engines, rupee-quoted</dd></div>
        <div><dt>Cutoff</dt><dd>Published on or after ${esc(LAUNCH)}</dd></div>
        ${LR.withdrawnN != null ? `<div><dt>Withdrawn</dt><dd>${LR.withdrawnN} pulled before entry — outside the book, listed on the ledger</dd></div>` : ''}
        <div><dt>As of</dt><dd>${when ? esc(when) : LR.asOfDay ? `snapshot, newest row filed ${esc(LR.asOfDay)}` : 'the ledger carried no timestamp'}</dd></div>
      </dl>
      <a class="integ-a" href="/methodology">How this is calculated →</a></div>`;
  };
  const fmtP = v => v == null ? '—'
    : v < 0.001 ? '&lt;0.001'
    : Number(v).toFixed(3);

  const recordOf = rows => {
    const closed = rows.filter(isScored);
    /* THE BUCKETS COME FIRST, BECAUSE AN EMPTY BOOK STILL HAS THEM.
     * They were counted after the early return below, so a book with nothing
     * closed returned no `bucket` at all — and the front page's reconciliation
     * line, reading `LR.bucket || {}`, printed "47 published = undefined closed
     * and graded + undefined still open + undefined withdrawn before entry +
     * undefined expired unfilled" on every day before the first close. The
     * zero-closed case is exactly the day a new reader most needs the
     * arithmetic, and it was the one day it could not be shown. */
    const bucket = { closed: 0, open: 0, withdrawn: 0, expired: 0, other: 0 };
    for (const r of rows) {
      const st = String(r.status || '').toUpperCase();
      const bd = String(r.badge || '').toLowerCase();
      if (isScored(r)) bucket.closed += 1;
      else if (withdrawn(r)) bucket.withdrawn += 1;
      else if (st === 'EXPIRED') bucket.expired += 1;
      else if (st === 'OPEN' || bd === 'open') bucket.open += 1;
      else bucket.other += 1;
    }
    if (!closed.length) return { bucket, trades: 0, wins: 0, losses: 0, win_rate: null,
                                 expectancy_r: null, t: null, p: null,
                                 ci: null, significant: false };
    const wins = closed.filter(r => Number(r.r_multiple) > 0).length;
    const sum = closed.reduce((a, r) => a + Number(r.r_multiple), 0);
    const R = closed.map(r => Number(r.r_multiple));
    const n = R.length, mean = sum / n;
    const t = tStat(R);
    const p = t == null ? null : tPValue(t, n - 1);
    /* The interval, because the sign and the size are two different claims and
       only one of them is settled here. */
    let ci = null;
    if (n > 1) {
      const sd = Math.sqrt(R.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
      const se = sd / Math.sqrt(n);
      /* 95% two-sided critical t. Solved by bisection on the same distribution
         the p-value uses rather than read off a table, so it is right for any
         df instead of for the ones somebody happened to type in. */
      let lo = 0, hi = 100;
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        (tPValue(mid, n - 1) > 0.05) ? (lo = mid) : (hi = mid);
      }
      const crit = (lo + hi) / 2;
      ci = [Math.round((mean - crit * se) * 1000) / 1000,
            Math.round((mean + crit * se) * 1000) / 1000];
    }
    /* ── EVERY PUBLISHED SIGNAL IS IN EXACTLY ONE BUCKET ─────────────────
     * An external audit: "account for all 65: open / triggered /
     * never-triggered / expired / withdrawn. Gaps read as survivorship
     * filtering." The page printed a published count and a closed count and
     * left the difference to inference — which, on a site whose entire claim
     * is that it does not hide its losses, is the one arithmetic a reader is
     * entitled to see closed.
     *
     * Zero-count buckets are PRINTED, not omitted. A withdrawn count of zero
     * is information; a missing withdrawn row is the thing that looks like
     * filtering. */
    return { bucket, trades: n, wins, losses: n - wins,
             win_rate: Math.round(wins / n * 1000) / 10,
             expectancy_r: Math.round(mean * 1000) / 1000,
             t: t == null ? null : Math.round(t * 100) / 100,
             p: p == null ? null : p,
             ci,
             /* Significant when the interval excludes zero, which is the same
                statement as p < 0.05 and is the one a reader can check against
                the two numbers printed beside it. */
             significant: !!(ci && (ci[1] < 0 || ci[0] > 0)) };
  };

  const head = (title, sub, eyebrow) =>
    `<div class="route-h"><span class="eyebrow">${esc(eyebrow || 'Signal')}</span>
      <h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;
  // `lead` is the serif line under the label: the label says what the block
  // IS, the lead says what it MEANS. Blocks with nothing to add omit it.
  /* `opts.lead` marks the ONE block a route is actually about.
   *
   * Every section carried identical weight, so a page of nine offered no
   * answer to "which of these am I meant to read" — the reader had to infer it
   * from source order, which is not a hierarchy, it is a list. A newspaper
   * answers that with SIZE.
   *
   * It is a flag rather than a position because the lead is not always first:
   * /signals leads with the book, not with the filter bar above it. Exactly
   * one per route — the CSS demotes any second one, because two leads is no
   * lead. */
  const sec = (label, body, n, lead, opts) =>
    `<section class="sec${opts && opts.lead ? ' is-lead' : ''}"><div class="sec-h"><h2>${esc(label)}</h2>${n ? `<span class="sec-n">${esc(n)}</span>` : ''}</div>${lead ? `<p class="sec-lead">${esc(lead)}</p>` : ''}${body}</section>`;
  /* ── ONE EXPANDING ROW, USED EVERYWHERE ───────────────────────────────────
   *
   * Most tables on this site already answer a tap: the screen and the funds
   * sheet open a card, markets opens a sector. The IPO listing table was the
   * one that did not — 61 rows of eight columns each, every one of them a dead
   * end. On a phone those columns stack into a labelled list and the row gets
   * tall, which is exactly where the extra detail should live instead.
   *
   * This is a PRIMITIVE, not a fourth bespoke implementation. `xrow` emits the
   * summary row and a panel after it; a single delegated listener bound once at
   * startup toggles any of them on any route. Nothing to wire per table, and
   * nothing to re-wire after a repaint — which is the failure mode of the
   * per-route handlers this replaces the need for.
   *
   * The panel is a SIBLING, not a child. A grid row cannot contain a full-width
   * block without breaking its own column template, and nesting it inside the
   * row would also put the detail inside the row's own click target.
   *
   * Keyboard: the row is a real button to the assistive tree, Enter and Space
   * toggle it, and aria-expanded/aria-controls carry the state. */
  let xrSeq = 0;
  /* ── THE DETAIL IS PARKED IN A <template>, NOT IN THE DOCUMENT ────────────
   *
   * Measured on /signals: 8,712 DOM nodes, of which 6,982 — EIGHTY PER CENT —
   * sat inside collapsed panels nobody had opened. /ipo was 40%. Every one of
   * those nodes is parsed, styled, laid out and kept in memory so that a
   * reader who opens two rows out of forty-one can see them instantly.
   *
   * A <template>'s content is an inert DocumentFragment: it is not in the
   * document tree, never matched by selectors, never styled and never laid
   * out. Cloning it on first open costs a fraction of a millisecond for the
   * one row being opened, against laying out forty panels for every reader.
   *
   * Call sites are unchanged — detail is still a string, built the same way —
   * because a refactor that touched all thirty of them to pass a thunk would
   * risk far more than it saved. What changes is only where the string is put.
   *
   * The panel div stays in the document so `hidden`, aria-controls and the
   * sibling-panel logic that filters and sorts depend on all keep working;
   * it is simply empty until it is needed.
   */
  /* ── A LONG LIST IS CAPPED, NOT TRUNCATED ─────────────────────────────────
   *
   * Measured on a 375x812 phone: /ideas was 24.3 screens and "AI long-term
   * ideas" alone was 12.1 of them — twelve cards at about 820px each. Nobody
   * reaches the end of that, so the twelfth card is not information, it is
   * weight.
   *
   * The tail is RENDERED and HIDDEN rather than dropped: everything stays on
   * the page for search-in-page, for the reader who does want it, and for the
   * counts printed above the list to keep matching what is under it. What
   * changes is only what is laid out before someone asks.
   *
   * display:contents on the wrapper so the tail's children stay direct
   * participants in a parent grid — wrapping them in a block would put twelve
   * cards into one grid cell. When hidden, the [hidden] rule at the top of the
   * stylesheet wins and the wrapper collapses entirely, which is the whole
   * reason that rule had to exist.
   */
  let capSeq = 0;
  const capList = (parts, n, noun = 'more') => {
    if (!Array.isArray(parts) || parts.length <= n) return (parts || []).join('');
    const id = `cap${++capSeq}`;
    return parts.slice(0, n).join('')
      + `<div class="cap-rest" id="${id}" hidden>${parts.slice(n).join('')}</div>`
      + `<button type="button" class="chip cap-more" data-cap="${id}">`
      + `Show the other ${parts.length - n} ${esc(noun)}</button>`;
  };
  /* Risers / fallers on the markets board. Delegated at the document for the
     same reason every other handler here is: the markets route repaints on a
     live tick, and a listener bound to the button would be gone after the
     first one. Toggles `hidden` rather than display, per the shell's reset. */
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('button[data-mv]');
    if (!b) return;
    const want = b.dataset.mv;
    const scope = b.closest('section') || document;
    scope.querySelectorAll('button[data-mv]').forEach(x =>
      x.classList.toggle('is-on', x.dataset.mv === want));
    scope.querySelectorAll('[data-mv-p]').forEach(x => { x.hidden = x.dataset.mvP !== want; });
  });

  /* Bound once at the document, like the row toggle — survives every repaint. */
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('button[data-cap]');
    if (!b) return;
    const rest = document.getElementById(b.getAttribute('data-cap'));
    if (rest) rest.hidden = false;
    b.remove();                      // one-way: nothing re-hides it
  });

  /* A SECTION THAT KEEPS ITS HEADING AND FOLDS ITS BODY.
   *
   * Used where a block is genuinely worth having on the page but is not what
   * the page is FOR — the long-horizon research under a page whose top is
   * today's orders, the books nobody is being told to apply to. The heading,
   * the count in the section rail and the standfirst all still render, so the
   * reader can see the block exists and what is in it; only the rows wait for
   * a tap. Nothing is removed and nothing becomes unreachable. */
  const foldBody = (summary, html) =>
    `<details class="foldb"><summary>${esc(summary)}</summary>${html}</details>`;

  const xrow = (summary, detail, opts = {}) => {
    if (!detail) return `<div class="rank-r ${opts.cls || ''}" ${opts.attrs || ''}>${summary}</div>`;
    const id = `xr${++xrSeq}`;
    return `<div class="rank-r ${opts.cls || ''} xr" data-xr="${id}" role="button"
        tabindex="0" aria-expanded="false" aria-controls="${id}" ${opts.attrs || ''}>${summary}
        <span class="xr-caret" aria-hidden="true"></span></div>
      <div class="xd" id="${id}" role="region" hidden
        ><template class="xd-src">${detail}</template></div>`;
  };

  /* Bound once, at the document. Survives every repaint on every route. */
  const xrToggle = (row) => {
    const panel = document.getElementById(row.getAttribute('aria-controls'));
    if (!panel) return;
    // First open: move the parked markup into the document. Once only — the
    // template is removed, so a second open finds real nodes and does nothing.
    const src = panel.querySelector(':scope > template.xd-src');
    if (src) {
      panel.appendChild(src.content.cloneNode(true));
      src.remove();
    }
    const open = panel.hidden;
    panel.hidden = !open;
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    row.classList.toggle('is-open', open);
  };
  document.addEventListener('click', (ev) => {
    // A link or a button inside the summary keeps its own behaviour.
    if (ev.target.closest('a, button, .wstar')) return;
    const row = ev.target.closest('.xr[data-xr]');
    if (row) xrToggle(row);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (!ev.target.closest) return;
    if (ev.target.closest('a, button')) return;
    const row = ev.target.closest('.xr[data-xr]');
    if (row) { ev.preventDefault(); xrToggle(row); }
  });

  /* ── SNAPSHOT ─────────────────────────────────────────────────────────────
   *
   * One line at the top of a route that answers "what is the state of this
   * page" before any scrolling. Four routes had no such line: markets opened
   * on a sector heatmap, screen on a 750-row table, news on a filter box, and
   * ideas on a card — each of them making the reader assemble the summary
   * themselves from the detail below.
   *
   * It is a STRIP, not a grid of tiles. The tiles this site already uses are
   * for a section's own numbers and take a lot of vertical space; a route
   * summary has to cost almost nothing above the content it summarises, or it
   * pushes the content it describes off the screen.
   *
   * Every item is label + value, with an optional third element for the one
   * word of context that stops a bare number being a riddle. Values are
   * tabular so a repaint cannot make the row jitter, and the strip scrolls
   * sideways on a narrow phone rather than wrapping into three lines.
   *
   * A null value renders an em dash. Nothing here invents a figure: a route
   * that cannot compute an item omits it rather than showing a zero. */
  const snap = (items, note) => {
    const live = (items || []).filter(x => x && x[0]);
    if (!live.length) return '';
    return `<div class="snap" role="group" aria-label="Summary">
      <div class="snap-r">${live.map(([k, v, sub, cls]) => `<div class="snap-i">
        <span class="snap-k">${esc(k)}</span>
        <span class="snap-v cnum ${cls || ''}">${v == null || v === '' ? '—' : v}</span>
        ${sub ? `<span class="snap-s">${esc(sub)}</span>` : ''}
      </div>`).join('')}</div>
      ${note ? `<p class="snap-n">${note}</p>` : ''}
    </div>`;
  };

  /* LABEL FIRST.
   *
   * The tile printed value → qualifier → label, so a reader met "41" and
   * "since 2026-09-02" and only then learned, on the third line, that it was
   * the count of published signals. A figure whose name arrives last has to
   * be read twice, and a row of four of them has to be read twice four times.
   *
   * Label, then figure, then the one line that qualifies it. The qualifier
   * sits on the floor of the tile so a row of tiles still shares one baseline
   * however far a label wraps. */
  /* `tipKey` puts a "?" beside the LABEL, never beside the number.
   *
   * The disclosure order this site keeps is answer, then reason, then
   * evidence, then method. A tile is the answer; its explanation must not
   * compete with it for the eye, so the control sits on the small grey label
   * and opens the same tip card every other help mark on the site uses. */
  /* `cnum` marks a tile's figure: tabular numerals, one place to change them.
     It no longer animates — see "NO FIGURE COUNTS UP" below. */
  const tile = (v, k, sub, cls, tipKey) =>
    `<div class="tile"><div class="k">${esc(k)}${tipKey ? ' ' + tip(tipKey) : ''}</div><div class="v cnum ${cls || ''}">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

  /* ── ANIMATED NUMBER ─────────────────────────────────────────────────────
   * One implementation, used everywhere a figure is worth watching arrive.
   *
   * Rules it keeps: it animates only when the value MEANINGFULLY changes, it
   * preserves the caller's decimal precision, it uses tabular numerals so the
   * element never changes width mid-count, and it does nothing at all under
   * prefers-reduced-motion — the final value is written on the first frame.
   *
   * rAF is used because this is genuinely frame-driven, and it is safe here
   * for the same reason it is unsafe elsewhere on this site: it drives a
   * one-shot count that is allowed not to run in a hidden tab, rather than a
   * layout the page depends on. If the tab is hidden the value is simply
   * already correct.
   */
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  function countTo(el, to, opts) {
    const o = opts || {};
    const dp = o.dp == null ? 0 : o.dp;
    const pre = o.pre || '', post = o.post || '';
    const write = v => { el.textContent = pre + v.toFixed(dp) + post; };
    const from = Number(el.dataset.cv);
    if (!Number.isFinite(to)) { el.textContent = o.blank || '—'; delete el.dataset.cv; return; }
    el.dataset.cv = String(to);
    // "Meaningfully" = different at the precision actually displayed.
    if (REDUCED || !Number.isFinite(from) || from.toFixed(dp) === to.toFixed(dp)) { write(to); return; }
    const t0 = performance.now(), ms = Math.min(900, 260 + Math.abs(to - from) * 6);
    let done = false;
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      write(from + (to - from) * (1 - Math.pow(1 - k, 3)));   // easeOutCubic
      if (k < 1) requestAnimationFrame(step); else done = true;
    };
    requestAnimationFrame(step);
    /* rAF DOES NOT RUN IN A HIDDEN TAB — not in the preview pane, and not in a
     * real reader's background tab either. Without this guard a page opened in
     * the background renders every animated figure stuck on its start value,
     * so the confidence score reads 0 and the loss reads nothing. The timer
     * keeps running where rAF does not; if the chain never finished, the final
     * value is written outright. */
    setTimeout(() => { if (!done) write(to); }, ms + 140);
  }

  /* ── SPARKLINE ───────────────────────────────────────────────────────────
   * One <path> from real daily closes. A series that is missing, too short or
   * genuinely flat draws NOTHING — a flat line reads as "this market did not
   * move", which is a different claim from "this was not measured".
   */
  const sparkline = (series, w, h) => {
    if (!Array.isArray(series) || series.length < 3) return '';
    const W = w || 96, H = h || 26;
    const lo = Math.min.apply(null, series), hi = Math.max.apply(null, series);
    const span = hi - lo;
    if (!(span > 0)) return '';
    const n = series.length, pad = 2;
    const X = i => (i / (n - 1)) * W;
    const Y = v => pad + (1 - (v - lo) / span) * (H - pad * 2);
    const d = series.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
    const cls = series[n - 1] > series[0] ? 'up' : series[n - 1] < series[0] ? 'dn' : '';
    return `<svg class="spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      aria-hidden="true" focusable="false"><path class="fill" d="${d} L${W} ${H} L0 ${H} Z"/>
      <path class="ln" d="${d}"/></svg>`;
  };

  /* ── 52-WEEK RANGE BAR ───────────────────────────────────────────────────
   * Where the price sits between the year's low and its high. Rendered only
   * when the API gave BOTH extremes; a bar drawn from a guessed range is a
   * lie with a gradient on it.
   */
  const rangeBar = r => r.range_pos == null ? '' : `<div class="rng"
      title="${esc(r.w52_low_f || '')} low · ${esc(r.w52_high_f || '')} high">
      <span class="rng-e">${esc(r.w52_low_f || '—')}</span>
      <span class="rng-t"><span class="rng-f" style="width:${r.range_pos}%"></span
        ><span class="rng-m" style="left:${r.range_pos}%"></span></span>
      <span class="rng-e">${esc(r.w52_high_f || '—')}</span></div>`;

  /* ── TIME ────────────────────────────────────────────────────────────────
   * "in 3h 12m" / "14m ago", from a real epoch. Used for the exchange session
   * window, which comes from the quote's own trading period rather than a
   * hardcoded table of market hours that goes wrong on every holiday.
   */
  const dur = secs => {
    const m = Math.round(Math.abs(secs) / 60);
    if (m < 1) return 'under a minute';
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return rm ? h + 'h ' + rm + 'm' : h + 'h';
    return Math.round(h / 24) + 'd';
  };
  const clockAt = (epochSec, tz) => {
    if (!Number.isFinite(epochSec)) return '';
    try {
      return new Date(epochSec * 1000).toLocaleTimeString('en-GB',
        { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  };

  /* Volume, at the scale a reader actually thinks in. Never "0" — an index
   * reports 0 because it has no volume, not because nothing traded. */
  const vol = v => !Number.isFinite(v) || v <= 0 ? null
    : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
    : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v));

  /* ── SMART TOOLTIPS ──────────────────────────────────────────────────────
   * A real <button>, toggled by class. Hover alone is invisible to a keyboard
   * and unusable on a phone, so every tip opens on click/Enter as well and
   * closes on Escape. Definitions live in one place so the same term never
   * gets two explanations on two pages.
   */
  const TIPS = {
    /* ── THE DECISION NUMBERS ────────────────────────────────────────────
     * TIPS covered nine mechanics — the 52-week range, the session, R:R —
     * and none of the four figures a reader actually decides on. A help mark
     * on "zone" and none on "win rate" explains the easy number and leaves
     * the load-bearing one unexplained.
     *
     * Each of these states the rule this site already enforces in code, so
     * the explanation cannot drift from the behaviour: the five-trade floor
     * is real and is applied two lines below, the composite's weights are
     * published in the payload, and a verdict carries its own reason string. */
    score: ['Composite score', 'A weighted blend of four separately-computed scores — quality, growth, valuation and technical. The weights are published with the payload rather than hidden here. Missing data scores nothing and leaves the denominator: a company that reports less gets a lower confidence, never a higher score. It is a MODEL, not a measurement.'],
    call: ['The call', 'A rule applied to the screen\u2019s own numbers at build time, not a forecast and not advice. Each carries the reason it was reached. It is stamped when the screen is built — if the stop has since been breached the setup is void and the card says so, because the facts moved and the verdict did not.'],
    risk: ['Risk flags', 'Conditions the screen found in the filings that argue against the name — cash not matching profit, leverage, dilution. They are reasons for caution that the score already carries; the flags are the working, not a second opinion. Open the company to read them in full.'],
    range52: ['52-week range', 'Where the current price sits between the lowest and highest price of the past year. 0% is the year’s low, 100% its high.'],
    session: ['Session', 'Whether the exchange is inside its regular trading hours right now, taken from the exchange’s own published session window — not from this page’s refresh.'],
    basis: ['Price basis', 'Which feed the number came from. “Spot” means the price is a spot quote while the 52-week range belongs to the futures contract, so the two are not from the same series.'],
  };
  /* ONE CARD, PARENTED TO <body>, NOT ONE PER TRIGGER.
   *
   * Two problems killed the per-trigger version, and the portal fixes both.
   *
   * 1. A transformed ancestor becomes the containing block for a fixed
   *    descendant. `.sec` carries a translateY(8px) from the reveal pass, so
   *    every tooltip inside a section was positioned against the section
   *    rather than the viewport and landed thousands of pixels off screen.
   * 2. N hidden cards is N elements taking part in layout. Absolutely
   *    positioned and merely visibility:hidden, they widened the document to
   *    458px inside a 390px phone.
   *
   * A single card on <body> has no transformed ancestor and no hidden copies.
   * The trigger carries only a key; the card is filled on open. */
  const tipCard = document.createElement('div');
  tipCard.className = 'tipc';
  tipCard.id = 'tipcard';
  tipCard.setAttribute('role', 'tooltip');
  document.body.appendChild(tipCard);
  let tipOwner = null;
  let tipOpenedAt = 0;

  const tip = key => TIPS[key]
    ? `<button type="button" class="tipb" data-tip="${esc(key)}" aria-describedby="tipcard"
        aria-expanded="false" aria-label="What is ${esc(TIPS[key][0])}?">?</button>` : '';

  /* HOVER OPENS, CLICK PINS. Without the distinction the two gestures fought:
   * moving the mouse onto a help mark opened the card, and the click that
   * followed saw it already open and closed it again — so on a desktop the
   * tooltip could not be clicked open at all. Pinned cards survive the pointer
   * leaving; Escape, an outside click and a scroll all unpin. */
  let tipPinned = false;
  const closeTips = () => {
    if (tipOwner) tipOwner.setAttribute('aria-expanded', 'false');
    tipOwner = null;
    tipPinned = false;
    tipCard.classList.remove('on');
  };

  const openTip = b => {
    const t = TIPS[b.dataset.tip];
    if (!t) return;
    tipOwner = b;
    tipOpenedAt = Date.now();
    b.setAttribute('aria-expanded', 'true');
    tipCard.innerHTML = `<b>${esc(t[0])}</b>${esc(t[1])}`;
    // Inside the brief the ground is near-black, so the card inverts there.
    tipCard.classList.add('on');

    const pad = 10;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const tb = b.getBoundingClientRect();
    tipCard.classList.remove('below');
    tipCard.style.left = '0px'; tipCard.style.top = '0px';
    const cb = tipCard.getBoundingClientRect();
    const x = Math.max(pad, Math.min(tb.left + tb.width / 2 - cb.width / 2, vw - pad - cb.width));
    const below = tb.top - cb.height - 10 < pad;
    const y = below ? tb.bottom + 10 : tb.top - cb.height - 10;
    tipCard.classList.toggle('below', below);
    tipCard.style.left = x.toFixed(0) + 'px';
    tipCard.style.top = Math.max(pad, Math.min(y, vh - pad - cb.height)).toFixed(0) + 'px';
    tipCard.style.setProperty('--ax', (tb.left + tb.width / 2 - x).toFixed(0) + 'px');
  };

  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('.tipb');
    const wasPinnedHere = b && b === tipOwner && tipPinned;
    closeTips();
    if (b && !wasPinnedHere) { openTip(b); tipPinned = true; }
  });
  // Hover is an ADDITION to the click behaviour, never the only way in.
  document.addEventListener('pointerover', ev => {
    const b = ev.target.closest && ev.target.closest('.tipb');
    if (b && ev.pointerType === 'mouse' && b !== tipOwner) openTip(b);
  });
  document.addEventListener('pointerout', ev => {
    const b = ev.target.closest && ev.target.closest('.tipb');
    if (b && ev.pointerType === 'mouse' && b === tipOwner && !tipPinned) closeTips();
  });
  // Keyboard users get the same card on focus, and lose it on blur.
  document.addEventListener('focusin', ev => {
    const b = ev.target.closest && ev.target.closest('.tipb');
    if (b && b !== tipOwner) openTip(b);
  });
  document.addEventListener('focusout', ev => {
    const b = ev.target.closest && ev.target.closest('.tipb');
    if (b && b === tipOwner && !tipPinned) closeTips();
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeTips(); });
  // A fixed card cannot follow the page, so scrolling closes it rather than
  // leaving it hanging over unrelated content.
  /* The 250ms grace matters: clicking a help mark can itself scroll the page —
   * the browser brings a partly-visible trigger into view, and the brief's own
   * section jump animates for a beat afterwards. Without it the card opened and
   * closed in the same gesture and the tooltip looked broken. */
  window.addEventListener('scroll', () => {
    if (tipOwner && Date.now() - tipOpenedAt > 250) closeTips();
  }, { passive: true });

  /* ── THE LEDGER: LIVE FIRST, BUILD ARTEFACT AS THE FALLBACK ──────────────
   *
   * alerts.json is written by generate.py at build time. Everything the
   * scanner publishes AFTER that build is in Turso and invisible to this page
   * until the next one — which on 2026-08-29 meant the Saturday weekly screen
   * (12 magic + 7 magicmagic) ran at 10:48 UTC, five hours after the 05:41
   * build, and the site showed none of it. alerts.json held zero rows dated
   * that day while /api/signals held twenty.
   *
   * So the API is asked first. Every field this page reads is on it, and the
   * two it lacks — alert_date and tv — already had fallbacks at every use
   * (`r.alert_date || r.date`, and chartUrl() defaults to NSE:<symbol>).
   * It is also uncapped, where alerts.json is trimmed to 200 rows.
   *
   * alerts.json remains as the fallback rather than being deleted: if Turso is
   * unreachable the page still renders this morning's ledger instead of an
   * error. The caller is told which source answered so it can say so — a page
   * showing yesterday's data must never look like a page showing today's.
   */
  /* ── WHICH ENGINES THIS SITE PUBLISHES ────────────────────────────────────
   *
   * The ledger carries twelve engines. This site surfaces seven of them, and
   * the filter is applied once here so every surface agrees — the ledger page,
   * the brief's choice of setup, the record, the open count.
   *
   * OHL and commodities are excluded on instruction. So are cf_1h, top5_pick
   * and sip_bucket, which are simply not on the list of what this site is for.
   *
   * BREAKOUT WAS ADDED 2026-09-02, on instruction, and it changes what the
   * record says rather than merely adding a row. Four of the five engines here
   * had never closed a trade and the fifth was 0-for-6, so the published
   * record stood at two closed trades and could not move quickly. Breakout
   * brings the largest closed sample of any engine on the ledger — and the
   * sample it brings is a losing one, 22 closed at a 9.1% win rate.
   *
   * That is the honest trade: the record becomes able to say something, and
   * the first thing it says is worse. It is added anyway because a whitelist
   * chosen to keep the number small is a track record chosen to stay quiet.
   *
   * BOTH magic AND magicmagic are kept, and the reason is worth stating: the
   * instruction was to keep whichever is better, and the ledger cannot answer
   * that. magic has FOUR closed trades and magicmagic has ONE. A single trade
   * that happened to win is not a win rate, and picking the engine with the
   * prettier number off one sample is exactly the kind of false precision the
   * rest of this site refuses. They are shown as one family until enough have
   * closed to separate them; the Signals page is where that will show up.
   */
  /* ── THE ENGINE REGISTRY ─────────────────────────────────────────────────
   *
   * NAMES ARE A DISPLAY LAYER AND THAT IS DELIBERATE. `signal_type` is the
   * primary key for 600+ ledger rows, every per-engine floor, the dedupe
   * between magic and magicmagic, and the expectancy table. Renaming it in the
   * database would orphan every one of those and silently reset the 30-day
   * measurement that is about to start. So the key never moves; only what a
   * reader sees does.
   *
   * `magic` and `magicmagic` are the same screen at two depths off the 52-week
   * high — >15% and 20-40%. They are presented as one engine with two bands,
   * because that is what they are, and kept as two keys because that is what
   * the ledger recorded.
   *
   * `hunts` is the one line that has to survive a reader who knows nothing:
   * what does this thing go looking for.
   *
   * THE DATA MOVED TO engines.js AND THIS IS NOW A POINTER. gems.askakshay.com
   * is a separate bundle and kept its own hand-typed copy of these names and
   * of which ones still run — two of its keys, `strict` and `reclaim`, are in
   * no feed and never were. One file, loaded by both pages, the way
   * heatcore.js already shares the heatmap's arithmetic. */
  const ENGINE_REGISTRY = ENGINE_BOOK.REGISTRY;

  /* ── A LANE IS NOT A DATABASE KEY EITHER ──────────────────────────────────
   *
   * BUOY runs two lanes and the alert log printed the raw value: a row read
   * "HINDCOPPER  buoy · reclaim" and nothing on the page said what "reclaim"
   * meant. That is the same fault engine_names.py exists to prevent one level
   * down — alerts print names, never keys — and it had simply been missed
   * because a lane is a field on the row rather than the row's engine.
   *
   * It matters more than a wording nit here, because the two lanes are not two
   * flavours of one result. They have SEPARATE measured records, and the
   * bigger sample is the looser rule:
   *
   *   Strict   n=35   +0.002R  t=+0.01   the rule as specified
   *   Reclaim  n=348  +0.010R  t=+0.16   the same rule minus the filter
   *
   * A reader told only "reclaim" cannot tell which of those they are looking
   * at, and the larger n belongs to the lane that discards the filter — the
   * opposite of the intuition. So the lane carries its own n wherever it is
   * shown.
   *
   * `n` is read from the payload's own backtest block at render time, never
   * typed here; these keys are the ones scan_research.py publishes. */
  const LANES = {
    strict:  { name: 'Strict',
               what: 'the full rule — the 200-period reclaim WITH a bullish RSI '
                   + 'divergence behind it',
               nKey: 'n', expKey: 'exp', tKey: 't' },
    reclaim: { name: 'Reclaim only',
               what: 'the reclaim alone, with the divergence filter dropped — a '
                   + 'looser rule, and the larger sample',
               nKey: 'n_no_div', expKey: 'exp_no_div', tKey: 't_no_div' },
  };
  /** A lane rendered for a reader: "Reclaim only" rather than "reclaim". */
  const laneName = k => (LANES[k] && LANES[k].name) || (k == null ? '' : String(k));
  /** The lane's own measured record, read off the engine's backtest block. */
  const laneStat = (k, bt) => {
    const L = LANES[k];
    if (!L || !bt) return null;
    const n = bt[L.nKey], e = bt[L.expKey], t = bt[L.tKey];
    return n == null ? null : { n, exp: e, t };
  };

  /* ── WHAT EACH ENGINE ACTUALLY FIRES ON ───────────────────────────────────
   *
   * This exists because the honest answer to "why did this signal appear?" was
   * previously nowhere on the site. The roster on /methodology said what each
   * engine HUNTS in one sentence; it did not say what has to be true for it to
   * fire, where the stop comes from, or what would prove it wrong.
   *
   * `triggers` are the conditions. `stop` and `targets` say how the levels are
   * built — this matters more than it sounds, because the levels are the whole
   * trade: the same setup with a stop inside the noise is a different engine.
   * `wrong` is the invalidation, stated before the fact.
   *
   * Wording is taken from what each engine writes into its own ledger rows, not
   * from a description of them written afterwards. Where an engine has been
   * corrected the correction is named, because a reader comparing an old signal
   * to a new one is otherwise looking at two different engines with one name. */
  const ENGINE_RULES = {
    breakout: {
      triggers: ['Close clears a 52-week, 20-week or 6-month high',
                 'Volume confirms the break',
                 'Liquidity gate on 20-day turnover'],
      stop: 'ATR-based, scaled to the HOLDING horizon by the square root of time '
          + '(2.24x weekly, 4.69x monthly), floored at 1.41x daily ATR, capped 6–20%.',
      targets: 'Ladder at 1.6 / 2.5 / 3.3 R.',
      wrong: 'A close back inside the range it broke out of.',
      fixed: 'Until 2026-09-02 the stop was 0.29x ATR — a day-sized stop on a '
           + 'weeks-long trade, which produced a 90.9% stop-out rate.',
    },
    magic: {
      triggers: ['Quality name more than 15% off its high',
                 'Weekly momentum already turning back up',
                 'Daily close confirms'],
      stop: 'The WIDER of the structural level and the ATR band.',
      targets: 'First target floored at 1.6R.',
      wrong: 'A daily close under the structural level the setup is built on.',
      fixed: 'Corrected 2026-09-03: it took the TIGHTER of the two stop '
           + 'candidates, and T1 was floored at 1.0R — one times risk, which '
           + 'loses money at any win rate this engine has shown.',
    },
    magicmagic: {
      triggers: ['The same screen as TIDAL, 20–40% off the high',
                 'Weekly momentum turning up', 'Daily close confirms'],
      stop: 'Same levels function as TIDAL — the wider of structure and ATR.',
      targets: 'First target floored at 1.6R.',
      wrong: 'A daily close under the structural level.',
    },
    equity_measured: {
      triggers: ['Daily-close swing setup on the completed bar',
                 'Sized against the weekly regime'],
      stop: 'Structural, on the completed daily bar — 1.94x ATR in practice, the '
          + 'widest of the equity engines and the lowest stop-out rate at 54.5%.',
      targets: 'House ladder.',
      wrong: 'A daily close through the structural stop.',
    },
    multibagger: {
      triggers: ['Near its highs with institutional volume behind it',
                 'CAN SLIM-style leadership screen'],
      stop: 'Published for reference at 1.57x ATR.',
      targets: 'Reference levels only.',
      wrong: 'RESEARCH IDEA, NOT A TRADE. The engine claims no exit rule and '
           + 'none should be inferred from the levels on the card.',
    },
    momentum_quant: {
      triggers: ['Cross-sectional rank over the full NSE screen',
                 '12-month and 6-month returns, each skipping the most recent '
                 + 'month because it reverses',
                 'Each divided by the name’s own ATR, then z-scored across '
                 + 'the universe and averaged',
                 'Tilted toward low scaled turnover'],
      stop: 'ATR band on a monthly horizon.',
      targets: 'House ladder.',
      wrong: 'The rank decays out of the top of the universe, or the stop closes through.',
      note: 'NSE Indices’ own Nifty500 Momentum 50 construction.',
    },
    ai_longterm: {
      triggers: ['Long-horizon screen, run weekly against the whole board'],
      stop: '200-day moving average — the thesis breaking, not a volatility band.',
      targets: 'None. This is an ownership idea measured in years.',
      wrong: 'The business thesis changes, or price loses the 200-day structure.',
    },
    ledge: {
      triggers: ['A Darvas box: 10–60 bars where neither the high nor the low '
                 + 'has been taken out, and the range is under 14% deep',
                 'Today’s CLOSE above the box top — a wick through it does not count',
                 'Volume at least 1.5x its own 20-day average',
                 'At least 12% below the 52-week high, so the move is early rather '
                 + 'than extended',
                 '20-day average flat or rising, and 20-day turnover above ₹3 cr'],
      stop: 'Under the box floor — the level at which the base has failed by '
          + 'definition — but never closer than 1x ATR, so it cannot sit inside '
          + 'a normal session’s range. Checked on the CLOSE.',
      targets: 'The box’s own height projected from its top: T1 at 1x, T2 at 2x. '
             + 'Over 188 backtested signals T1 was reached by 58.5% and T2 by 31.9%. '
             + 'A third target at 4x was tested and dropped — only 10.1% ever '
             + 'reached it, which makes it decoration rather than a target.',
      wrong: 'A daily CLOSE back under the stop. The base failed and the reason '
           + 'for the trade is gone.',
    },
    keel: {
      triggers: ['Price makes a lower low than a previous swing low',
                 'RSI(14) makes a HIGHER low at the same time — the selling is '
                 + 'losing force',
                 'The two lows are 8–60 bars apart and the divergence is under '
                 + '40 bars old',
                 'Price CLOSES back above the level of the earlier low it undercut '
                 + '— the divergence alone is not the trade, the reclaim is',
                 'Volume at least 1.3x its 20-day average, and at least 12% below '
                 + 'the 52-week high'],
      stop: 'Under the divergence low — if that gives way the momentum argument '
          + 'is simply wrong — floored at 1x ATR. Checked on the CLOSE.',
      targets: 'The highest high between the two lows, floored at 1.6R.',
      wrong: 'A daily CLOSE under the divergence low.',
    },
  };

  /* ── WHAT EACH ENGINE IS CLEARED TO DO ────────────────────────────────────
   *
   * The bar this book sets before an engine may size capital is 30 or more
   * CLOSED trades at t >= 2. It is deliberately hard and, as of today, NOTHING
   * clears it — including the two engines added above, whose numbers come from
   * a backtest and not from a single live closed trade.
   *
   * LIVE      cleared for capital
   * PAPER     published and tracked, no capital
   * RESEARCH  an idea, published as an idea, never as a call
   * BLOCKED   measured and found wanting
   *
   * A backtest is never promoted to LIVE here. Backtests are run by the person
   * who wants the answer, on the universe that exists today, which is why the
   * survivorship note below travels with every number. */
  const ENGINE_TIER = {
    equity_measured: 'PAPER', breakout: 'PAPER', magic: 'PAPER',
    magicmagic: 'PAPER', momentum_quant: 'PAPER', multibagger: 'RESEARCH',
    ai_longterm: 'RESEARCH', ledge: 'PAPER', keel: 'RESEARCH',
    /* RESEARCH on day one and for a long while after. PIVOT has no closed
       trade and no measured expectancy, so it is logged, shown, and never
       alerted. The bar is 30 closed at t >= 2 and it will be held to it like
       everything else — a new engine promoting itself on the day it was
       written is the claim this whole record exists to refuse. */
    pivot: 'RESEARCH',
    /* Seventeen closed at t=3.69 — the best record here, and thirteen trades
       short of the bar. RESEARCH until it has thirty. */
    intraday: 'RESEARCH',
  };

  /* Backtested records for the engines that have no live sample yet. Kept
   * separate from the live record on purpose and NEVER merged with it — a
   * backtest and a live result are different claims and the card says which. */
  const ENGINE_BACKTEST = {
    ledge: { n: 188, exp: 0.224, win: 59.0, t: 3.20, pf: 1.73, maxdd: -7.73,
             from: '2025-01', to: '2026-08' },
    keel:  { n: 42,  exp: 0.125, win: 42.9, t: 0.52, pf: 1.19, maxdd: -7.01,
             from: '2025-01', to: '2026-09' },
  };

  /* A retired engine keeps its NAME so its closed trades still render, and is
     absent from everything that describes what the site publishes now. One
     predicate, used by every consumer, so the two cannot drift. */
  const LIVE_ENGINES = () => ENGINE_BOOK.live();

  /* ── TWO QUESTIONS, AND ANSWERING BOTH FROM ONE SET WAS THE BUG ──────────
   *
   * "What does this site publish?" and "what does this key render as?" are
   * different questions, and answering both from one Set is what put a
   * retired engine's trades back into the published record.
   *
   * eng()/engName() read the registry DIRECTLY and are never filtered, so a
   * historical row whose engine has since been switched off still renders its
   * name rather than a raw key. Nothing else needs the full key list, and an
   * ENGINES_ALL Set was written here and deleted again rather than left
   * unused with a comment claiming it did something.
   *
   * ENGINES is the POPULATION: the engines publishing today. Every count on
   * this site — published, closed, win rate, expectancy, the roster — is
   * drawn from it, so a retirement removes an engine from the record the
   * moment it is marked, without a second list to remember.
   *
   * THE BUG THIS FIXES, stated so it is not re-introduced. ENGINES was
   * `new Set(Object.keys(ENGINE_REGISTRY))` — every key, retired included —
   * and engineOk() is the ledger's admission gate. So on 2026-09-19 the front
   * page read 65 published / 12 closed / 8.3% / -0.746R, and those figures
   * carried 20 rows and one closed trade from magic and equity_measured,
   * two engines the same page said out loud were retired. The roster below
   * it offered "all 10" while the paragraph beside it said eight publish
   * here. The corrected population is 45 published, 11 closed, 9.1% won,
   * -0.723R at t=-2.22. Every one of those numbers is worse or smaller than
   * the one it replaces, which is the direction an honesty fix usually runs. */
  const ENGINES = new Set(ENGINE_BOOK.keys());
  const eng = k => ENGINE_BOOK.get(k);
  const engName = k => ENGINE_BOOK.name(k);
  /* ── A FILTER OPTION HAS TO NAME ONE THING ────────────────────────────────
   * Two registry keys deliberately share a display name: `magic` and
   * `magicmagic` are the same screen read at two depths off the 52-week high,
   * so both render as TIDAL. On a card that is correct — the band is written
   * out underneath it. In a dropdown it produced two options reading
   * "TIDAL (12)" and "TIDAL (6)" with nothing to choose between them.
   * Where a name is shared, the filter appends the band that separates them;
   * where it is unique, the plain name is left alone. */
  const engLabel = k => ENGINE_BOOK.label(k);
  /* ── HOW MANY ENGINES ARE THERE? ONE ANSWER, NOT THREE ──────────────────
   *
   * Three pages counted this three different ways and none of them showed
   * their working, so a reader moving between them met a contradiction:
   *
   *   /          8   the roster groups by DISPLAY NAME, and TIDAL runs two
   *                  bands, so its two registry keys merge into one row
   *   /signals   9   "9 of 9 working" — one card per registry KEY
   *   /engines   9   the same nine keys
   *   /research  3   BUOY, ANCHOR and BEDROCK, named on no other page
   *
   * Every one of those numbers is correct about a different thing, which is
   * the worst kind of inconsistency: nothing to fix in the arithmetic, and a
   * reader who cannot tell that. The research three are the sharper problem —
   * the site publishes twelve engines and the two pages a reader would look
   * at named nine of them, which is the omission /engines' own comment says
   * this site exists not to make.
   *
   * So the counts come from here, both pages print the same sentence, and the
   * sentence states the arithmetic instead of asserting a total. */
  const ENGINE_KEYS = () => LIVE_ENGINES().map(([k]) => k);
  const ENGINE_NAMES = () => ENGINE_BOOK.names();
  /* The research floor's own count, read from its feed rather than hardcoded —
   * a fourth engine added there must not leave a "three" behind on two other
   * pages. Null until /research.json has been fetched by any route this
   * session, and the sentence simply omits the clause until it has. */
  let RESEARCH_N = null;
  /* Filled on demand, from the feed, at 9.7 KB — small enough that a page
   * showing the tally can pay for it, and the only way the clause is true
   * for a reader who never visits /research. get() de-duplicates concurrent
   * callers and caches for the session, so asking from two routes costs one
   * request. A failure leaves the count null and the sentence simply omits
   * the clause rather than guessing a number. */
  const engineTally = () => {
    const names = ENGINE_NAMES().length, keys = ENGINE_KEYS().length;
    const bands = keys > names
      ? ` — ${names} names over ${keys} configurations, because TIDAL runs two bands`
      : '';
    return { names, keys, research: RESEARCH_N, bands };
  };
  const engineTallyNote = () => {
    const t = engineTally();
    return `<b>${t.names} engine${t.names === 1 ? '' : 's'} publish here</b>${t.bands}.`
      + (t.research
         ? ` A further <b>${t.research}</b> are measured but <b>not cleared to publish</b> —
            they sit on <a href="/research">the research floor</a> with the null results that
            keep them there, and nothing they produce is filed as a signal.`
         : '');
  };

  const ENGINE_LABEL = new Proxy({}, { get: (_, k) => engName(k) });
  /* ── OLD NAMES IN STORED PROSE ───────────────────────────────────────────
   * The registry renames what the site RENDERS, but `remarks` is free text
   * written into the ledger at signal time and it says things like
   * "Magic-levels screen (v1 engine)". Those rows are history and must not be
   * rewritten in the database — so the substitution happens on the way out,
   * the same place the key itself is translated. Longest keys first, or
   * "magic" would eat the front of "magicmagic". */
  const ENGINE_WORDS = LIVE_ENGINES()
    .map(([k, v]) => [k, v.name])
    .concat([['Magic-levels', 'TIDAL levels'], ['MagicMagic', 'TIDAL'], ['Magic', 'TIDAL']])
    .sort((a, b) => b[0].length - a[0].length);
  const engineWords = t => ENGINE_WORDS.reduce(
    (acc, [k, n]) => acc.replace(new RegExp('\\b' + k + '\\b', 'g'), n), String(t || ''));

  /* ── THE UNIVERSE SIZE IS A FACT, NOT A STRING ───────────────────────────
   * Three user-facing sentences said "750 names". The screen carries 989 rows
   * from a 1,000-name universe and has for some time — the universe was
   * widened and the copy was not, so the site advertised a smaller screen than
   * it runs. Read from the feed, so it cannot go stale again; the fallback is
   * only for the moment before any feed has loaded. */
  const universeN = () => {
    const n = (window.__PULSE && (window.__PULSE.universe || window.__PULSE.universe_size))
      || (Array.isArray(SCREEN) && SCREEN.length)
      || (window.__SCREEN_META && window.__SCREEN_META.count);
    return Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 989;
  };

  /* THE ADMISSION GATE. One predicate, one population — see ENGINES above.
   * A row from a retired engine, or from an engine this site never ran
   * (commodity and top5_pick are news.askakshay.com's, and arrive in the same
   * feed), is not in this site's record. */
  /* ── IS THE PLAN PLAYABLE AT ALL? ────────────────────────────────────────
   *
   * Akshay, on the brief for TATACHEM: "how is this even correct, who gives
   * such kind of signals."
   *
   * He is right and the numbers are not close. That setup published:
   *
   *     entry  734.90    stop 597.00    risk 18.76% of entry
   *     target 1  758.20   =  0.169R
   *     target 2  837.30   =  0.743R
   *     target 3  absent
   *
   * A first target at 0.169R needs an 85.5% win rate merely to break even.
   * This book's win rate is 7.7%. Both published targets sit below 1R, which
   * means the plan cannot pay for its own stop even if BOTH print. And the
   * page rendered it as "90 HIGH CONVICTION".
   *
   * THE FLOOR ALREADY EXISTED AND WAS ENFORCED NOWHERE. engines.json states
   * the rule in its own `basis` field — break-even R:R is (1-p)/p plus a 15%
   * margin, default 2.0 below 25 closed trades — and publishes a `floor` per
   * engine. Nothing on the site ever compared a signal's geometry against it.
   * `ledge` is not even in that file, so its floor is the 2.0 default and its
   * first target came in at a twelfth of that.
   *
   * THE CONVICTION SCORE IS NOT THE PROBLEM, AND MUST NOT BE THE FIX. It
   * deliberately excludes reward-to-risk, with a reasoned note: a conviction
   * score answers "what does the evidence say", and the plan's geometry is a
   * separate question. That reasoning is right. What was wrong is that only
   * the first half reached the page, in large type, under a confident word.
   *
   * So geometry becomes its own gate rather than being folded into a score it
   * does not belong in: a setup that cannot clear its engine's floor is not
   * presented as an action, whatever the evidence says about the company. */
  const rrFloor = (engine) => {
    const e = ENG_FLOORS[String(engine || '')];
    const f = e && Number(e.floor);
    /* 2.0 is engines.json's own default for an engine without a measured win
       rate. An engine missing from that file gets the same default rather than
       a free pass — absence is not permission, the rule this repo already
       applies to the capital book. */
    return Number.isFinite(f) && f > 0 ? f : 2;
  };
  /* Filled from engines.json wherever it is fetched; the floor falls back to
     2.0 until it arrives, which is the strict direction. */
  let ENG_FLOORS = {};
  const rrOf = (sig) => {
    const entry = lvl(sig && sig.entry), stop = lvl(sig && sig.sl), t1 = lvl(sig && sig.target1);
    if (entry == null || stop == null || t1 == null) return null;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;
    return Math.abs(t1 - entry) / risk;
  };
  /* Returns null when the geometry cannot be read — unknown is not the same as
     unplayable, and a row without levels is simply not a plan. */
  const playable = (sig) => {
    const rr = rrOf(sig);
    if (rr == null) return null;
    return rr >= rrFloor(sig && sig.signal_type);
  };

  const engineOk = r => ENGINES.has(String(r.signal_type || ''));

  /* ── AND NOTHING SHORT ────────────────────────────────────────────────────
   *
   * The book is long-only, and the rule is not a preference. standalone_scan's
   * longs_only() states it: "nothing short is put in front of a reader as an
   * action", and swing_rulebook refuses to size one (SHORT_NOT_TAKEN).
   *
   * That filter is applied to the TELEGRAM list and to nothing else, on
   * purpose — every engine keeps filing shorts and the ledger keeps every one,
   * because deleting them would destroy the evidence for whether refusing them
   * costs anything. This site was reading the ledger, so it published them
   * anyway: on 2 Sep the first entry in the restarted record was WIPRO SELL,
   * an alert that was never sent to anyone.
   *
   * Two things were wrong with that at once. It put a short in front of a
   * reader as an action, which is the one thing the rule forbids. And the page
   * describes itself as "every alert this site has sent" while showing one it
   * had not sent — the record claiming credit for a call nobody received.
   *
   * Shorts remain in the ledger and remain published in full on
   * news.askakshay.com, which is the site that reports everything the engines
   * do rather than everything this book acts on. */
  const longOnly = r => String(r.action || 'BUY').toUpperCase() !== 'SELL';

  /* (ledger() removed at the Signal V2 cutover: the V1 ledger is retired.) */

  /* ── THE SCREEN INDEX ────────────────────────────────────────────────────
   * symbol → its row on the NSE screen. Built once and reused, so the
   * 237 KB (gzipped) feed is fetched at most once per session however many
   * routes want a technical field.
   *
   * Loaded AFTER the table has painted, never before: the columns are already
   * in the markup showing em dashes, so filling them shifts nothing, and a
   * page that waits on a quarter-megabyte before showing the movers is a worse
   * page than one that shows them and completes itself a moment later. */
  window.__SCRIDX = null;
  async function screenIndex() {
    if (window.__SCRIDX) return window.__SCRIDX;
    if (!SCREEN) {
      const g = await getScreen(false); const r = noteLadder(g.r);
      if (!r.ok) return null;
      noteScreenMeta(r.data); setScreen((r.data.rows || []).filter(x => x && x.sym), g.lite);
    }
    const idx = {};
    for (const r of SCREEN) idx[r.sym] = r;
    window.__SCRIDX = idx;
    return idx;
  }

  /* Repaint any level table in place once the index is available. */
  async function fillLevels(render) {
    if (window.__SCRIDX) return;              // already joined on first paint
    const idx = await screenIndex();
    if (idx && typeof render === 'function') render();
  }


  /* ══ WATCHLIST AND ALERTS ══════════════════════════════════════════════
   *
   * ON localStorage, AND NOT ON AN ACCOUNT. Deliberately. An account would
   * mean a password to store, a session to protect, a deletion request to
   * honour and a support burden — for a feature whose entire job is to
   * remember a dozen ticker symbols. This site collects one email address for
   * one purpose and nothing else, and the Privacy page says so; adding auth to
   * hold a watchlist would make that page start lying.
   *
   * The cost is stated plainly in the UI rather than hidden: it lives in THIS
   * browser. Clear your site data and it is gone. That is a real limitation
   * and a reader deserves to know it before they build a list of forty names.
   *
   * Alerts are evaluated on the SAME quotes the page already fetches — there
   * is no background worker, no push, no server. An alert fires when you are
   * looking at the site, which is the honest limit of what a static front end
   * over a read-only API can promise.
   */
  const WKEY = 'sig:watch', AKEY = 'sig:alerts', AFIRED = 'sig:fired';
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; }
                            catch (e) { return false; } };   // private mode, quota

  const watchAll = () => lsGet(WKEY, []);
  const isWatched = sym => watchAll().includes(sym);
  const toggleWatch = sym => {
    const w = watchAll();
    const i = w.indexOf(sym);
    if (i >= 0) w.splice(i, 1); else w.push(sym);
    lsSet(WKEY, w);
    // Repaint every star for this symbol wherever it appears on the page.
    document.querySelectorAll(`[data-watch="${CSS.escape(sym)}"]`).forEach(b => {
      const on = w.includes(sym);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', (on ? 'Remove ' : 'Add ') + sym + (on ? ' from' : ' to') + ' your watchlist');
    });
    return w.includes(sym);
  };
  const watchBtn = sym => !sym ? '' : `<button type="button" class="wstar" data-watch="${esc(sym)}"
      aria-pressed="${isWatched(sym)}"
      aria-label="${isWatched(sym) ? 'Remove' : 'Add'} ${esc(sym)} ${isWatched(sym) ? 'from' : 'to'} your watchlist"
    ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4 4.2 13.4l.7-4.3-3.1-3 4.3-.6z"/></svg></button>`;

  // A star anywhere on the page toggles, without each route wiring it up.
  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('.wstar');
    if (!b) return;
    ev.stopPropagation();                 // never open the card behind the star
    ev.preventDefault();
    toggleWatch(b.dataset.watch);
  });

  /* ── ALERTS ──────────────────────────────────────────────────────────────
   * {sym, op:'above'|'below', px, note, made}. Checked against whatever quote
   * the page last fetched for that symbol. A fired alert is recorded so it
   * announces once rather than on every sixty-second repaint. */
  /* ── SINCE YOUR LAST VISIT ───────────────────────────────────────────────
   * What changed for THIS reader since they were last here — without an
   * account. Everything it needs is already on the device: the ledger ids
   * they had seen, the price of each starred name, the alerts that fired.
   *
   * The baseline is fixed for the whole browsing session (sessionStorage), so
   * the 60-second refresh and every repaint compare against the same visit
   * instead of against a minute ago. The stored visit is rewritten on every
   * home render, and only becomes the baseline when the next session starts.
   * Nothing leaves the browser. */
  const VKEY = 'sig:visit';
  const visitBase = (() => {
    try {
      const held = sessionStorage.getItem(VKEY);
      if (held) return JSON.parse(held);
      const prev = lsGet(VKEY, null);
      sessionStorage.setItem(VKEY, JSON.stringify(prev));
      return prev;
    } catch (e) { return null; }
  })();
  /* A render without the ledger or the screen (a failed fetch, the first of
     the front page's two passes) must not wipe what the last visit recorded,
     so each half is only replaced when this render actually has it. */
  const noteVisit = (closedIds, px) => {
    const was = lsGet(VKEY, {}) || {};
    lsSet(VKEY, { at: Date.now(),
                  seen: closedIds.length ? closedIds.slice(0, 600) : (was.seen || []),
                  px: Object.keys(px).length ? px : (was.px || {}) });
  };
  const agoWord = ms => { const h = (Date.now() - ms) / 3600000;
    return h < 1 ? 'under an hour ago' : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`; };
  const sinceLine = (closed, screenRows) => {
    const watched = watchAll();
    const pxNow = {};
    for (const r of screenRows || []) if (r && watched.includes(r.sym) && Number.isFinite(Number(r.price))) pxNow[r.sym] = Number(r.price);
    const ids = closed.map(r => String(r.id ?? `${r.symbol}|${r.sent_at}`));
    noteVisit(ids, pxNow);
    const b = visitBase;
    if (!b || !b.at) return '';
    const parts = [];
    if (Array.isArray(b.seen)) {
      const seen = new Set(b.seen);
      const fresh = closed.filter((r, i) => !seen.has(ids[i]));
      if (fresh.length) {
        const won = fresh.filter(r => Number(r.r_multiple) > 0).length;
        const sum = fresh.reduce((a, r) => a + Number(r.r_multiple), 0);
        parts.push(`<b>${fresh.length}</b> signal${fresh.length === 1 ? '' : 's'} closed — ${won} won, ${fresh.length - won} lost
          (<b class="${sum < 0 ? 'dn' : sum > 0 ? 'up' : ''}">${signedR(sum)}</b>)`);
      }
    }
    const moves = Object.keys(pxNow).filter(k => b.px && Number.isFinite(b.px[k]) && b.px[k] > 0)
      .map(k => [k, (pxNow[k] / b.px[k] - 1) * 100]).filter(([, c]) => Math.abs(c) >= 3)
      .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3);
    if (moves.length) parts.push(moves.map(([k, c]) =>
      `<a href="/stock/${encodeURIComponent(k)}">${esc(k)}</a> <b class="${c < 0 ? 'dn' : 'up'}">${c > 0 ? '+' : ''}${c.toFixed(1)}%</b>`).join(', ') + ' on your watchlist');
    const fired = Object.values(lsGet(AFIRED, {})).filter(t => Number(t) > b.at).length;
    if (fired) parts.push(`<b>${fired}</b> alert${fired === 1 ? '' : 's'} fired`);
    return parts.length ? `<p class="since" title="Kept in this browser only">Since your last visit, ${esc(agoWord(b.at))}:
      ${parts.join(' · ')}.</p>` : '';
  };
  const alertsAll = () => lsGet(AKEY, []);
  /* THE BELL. Alerts that fired since the reader last opened the watchlist,
     where the alerts are listed. Opening /watch marks them seen. */
  const FSEEN = 'sig:firedSeen';
  const paintBell = () => {
    const b = document.getElementById('bellBtn');
    if (!b) return;
    const seen = Number(lsGet(FSEEN, 0)) || 0;
    const n = Object.values(lsGet(AFIRED, {})).filter(t => Number(t) > seen).length;
    const dot = b.querySelector('.bell-n');
    if (dot) { dot.hidden = !n; dot.textContent = n > 9 ? '9+' : String(n); }
    b.setAttribute('aria-label', n ? `Watchlist and price alerts — ${n} fired since you last looked`
                                   : 'Watchlist and price alerts');
  };
  const addAlert = a => { const l = alertsAll(); l.push(a); return lsSet(AKEY, l); };
  const dropAlert = i => { const l = alertsAll(); l.splice(i, 1); lsSet(AKEY, l); };

  function checkAlerts(quotes) {
    const list = alertsAll();
    if (!list.length || !quotes) return;
    const fired = lsGet(AFIRED, {});
    const hits = [];
    list.forEach((a, i) => {
      const q = quotes[a.sym];
      const px = q && Number(q.price);
      if (!Number.isFinite(px)) return;
      const hit = a.op === 'above' ? px >= Number(a.px) : px <= Number(a.px);
      const key = `${a.sym}|${a.op}|${a.px}`;
      if (hit && !fired[key]) { fired[key] = Date.now(); hits.push({ ...a, px_now: px }); }
      if (!hit && fired[key]) delete fired[key];        // re-arm once it crosses back
    });
    lsSet(AFIRED, fired);
    paintBell();
    hits.forEach(h => toast(`${h.sym} is ${h.op} ${h.px}`,
      `Now ${h.px_now}. ${h.note || ''}`.trim()));
    // The browser notification is an ADDITION, never the only channel — it is
    // off unless the reader has granted it, and the toast fires regardless.
    if (hits.length && 'Notification' in window && Notification.permission === 'granted') {
      hits.forEach(h => { try {
        new Notification(`${h.sym} ${h.op} ${h.px}`, { body: `Now ${h.px_now}`, tag: h.sym });
      } catch (e) { /* some browsers refuse outside a user gesture */ } });
    }
  }

  function toast(title, body) {
    let host = document.getElementById('toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}
      <button type="button" aria-label="Dismiss">✕</button>`;
    el.querySelector('button').addEventListener('click', () => el.remove());
    host.appendChild(el);
    setTimeout(() => el.remove(), 12000);
  }

  /* ── shared widgets ────────────────────────────────────────────────────── */

  // Five steps each way, on the sector's own median. A continuous ramp reads
  // as decoration; steps read as a scale you can compare two tiles against.
  /* heatClass is calibrated for SECTOR medians, where 1.5% is a big day. The
   * same thresholds on a 1-month return or a distance from the 200-day put
   * every row at maximum tint and say nothing. This takes the scale the column
   * lives on and maps onto the same seven steps, so the tint means "large for
   * this column" rather than "large for a sector's daily median".
   *
   * A tint, not a replacement for the sign: the number keeps its + or - and
   * its text colour, so the column still reads correctly in greyscale and to
   * anyone who cannot separate the two hues. */
  const heatCell = (v, scale) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !scale) return '';
    return heatClass(n / scale * 1.5);
  };
  const heatClass = v => v >= 1.5 ? 'h-p3' : v >= .6 ? 'h-p2' : v > .1 ? 'h-p1'
                       : v <= -1.5 ? 'h-n3' : v <= -.6 ? 'h-n2' : v < -.1 ? 'h-n1' : 'h-z';

  // Tiles are buttons. A heat map that shows a median and refuses "which
  // names" is half an answer, and the drill-down data is already in the
  // digest — no extra request, no 1.26 MB download.
  window.__sectors = {};
  window.__heatKey = 'r1w';
  const heatmap = (sectors, key) => { window.__heatKey = key || 'r1w'; return !sectors || !sectors.length ? '' :
    `<div class="heat">${sectors.map(s => {
      window.__sectors[s.name] = s;
      // Width carries the sector's weight in names, so a 105-name move and a
      // 12-name move are not the same rectangle.
      const grow = Math.max(1, Math.round(s.n / 8));
      return `<button type="button" class="heat-t ${heatClass(s.median)}" style="flex-grow:${grow}"
                   data-sector="${esc(s.name)}"
                   title="${esc(s.name)} — open the names behind this move">
        <span class="hs">${esc(s.name)}</span>
        <span class="hv">${pct(s.median)}</span>
        <span class="hn">${s.n} names · ${s.up} up</span>
      </button>`; }).join('')}</div>`; };

  // One delegated listener for every heat tile on every route.
  // One delegated listener for every heat tile AND every symbol, bound once.
  // Per-route binding is what left most of the site dead: a row rendered by a
  // route that forgot to bind was unclickable, and every route forgot.
  document.addEventListener('click', ev => {
    if (!ev.target.closest) return;
    const t = ev.target.closest('.heat-t');
    if (t && t.dataset.sector) { openSector(t.dataset.sector); return; }
    /* ANY row carrying a fund code, not only .fnd. The leaders' board renders
     * .fld rows with data-fund and role="button" — and with the selector
     * pinned to .fnd they were twenty rows that looked clickable and did
     * nothing, which is precisely the fault the comment above this handler
     * exists to describe. Bind on the DATA the row carries, not on the class
     * that happened to carry it first. */
    const fd = ev.target.closest('[data-fund]');
    if (fd && fd.dataset.fund) { openFund(fd.dataset.fund); return; }
    const bl = ev.target.closest('[data-brief]');
    if (bl) { briefSym = bl.dataset.brief; return; }   // the href does the routing
    if (ev.target.closest('a')) return;          // never hijack a real link
    /* A click that started on the watchlist star is NOT a click on the row.
     * stopPropagation() in the star's own handler cannot prevent this one:
     * both are delegated on `document`, and stopping propagation does not stop
     * other listeners already bound to the same node. The row has to check. */
    if (ev.target.closest('.wstar')) return;
    const n = ev.target.closest('[data-sym]');
    if (n && n.dataset.sym) openStock(n.dataset.sym);
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (!ev.target.closest || ev.target.closest('.wstar')) return;
    const n = ev.target.closest('[data-sym]');
    if (n && n.dataset.sym) { ev.preventDefault(); openStock(n.dataset.sym); return; }
    /* FUND ROWS TOO. Every one of them carries role="button" and tabindex="0"
     * — it says it is a button and takes focus — and Enter did nothing,
     * because only the mouse path was ever wired. A row that announces itself
     * to a screen reader as operable and then is not is worse than one that
     * never claimed to be. */
    const f = ev.target.closest('[data-fund]');
    if (f && f.dataset.fund) { ev.preventDefault(); openFund(f.dataset.fund); }
  });

  function openSector(name) {
    const s = window.__sectors[name];
    if (!s) return;
    const k = window.__heatKey;
    const list = rows => rows && rows.length ? `<div class="rank">${rows.map((r, i) => `
        <div class="rank-r" data-sym="${esc(r.sym)}" role="button" tabindex="0">
          <span class="i">${i + 1}</span>
          <span class="s">${watchBtn(r.sym)}<b>${esc(r.sym)}</b><span>${esc(r.name || '')}</span></span>
          <span class="x" style="color:var(--dim)">${r.rsi != null ? 'RSI ' + Math.round(r.rsi) : ''}</span>
          <span class="m ${dir(r[k])}">${pct(r[k])}</span>
          <span class="pl-w">${priceLine(r)}</span>
        </div>`).join('')}</div>` : `<div class="empty">No names.</div>`;
    sheet(`${esc(name)}`,
      `<p class="hint" style="margin:0 0 14px">Median <b class="${dir(s.median)}">${pct(s.median)}</b>
        ${k === 'r1d' ? 'today' : 'on the week'} across <b>${s.n}</b> names, <b>${s.up}</b> of them up.</p>` +
      // "Held it back" implied losses. When a sector is broadly up its weakest
      // five are still positive — that is the +0.60% sitting under a "losers"
      // heading. Strongest and weakest; the numbers say whether either is red.
      sec('Strongest five', list(s.top)) +
      sec('Weakest five', list(s.bottom) + PLKEY));
  }

  /* A bottom sheet on a phone, a centred dialog on a desk. <dialog> gives the
   * focus trap and Escape for free — reimplementing either by hand is how
   * modals end up unreachable by keyboard. */
  function sheet(title, html) {
    let d = document.getElementById('sheet');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'sheet'; d.className = 'sheet';
      document.body.appendChild(d);
      d.addEventListener('click', e => { if (e.target === d) d.close(); });
    }
    d.innerHTML = `<div class="sheet-in">
      <div class="sheet-h"><h2>${title}</h2>
        <button type="button" class="icon-btn" data-x aria-label="Close">✕</button></div>
      <div class="sheet-b">${html}</div></div>`;
    d.querySelector('[data-x]').addEventListener('click', () => d.close());
    if (!d.open) d.showModal();
  }

  /* ── A BOARD ROW ─────────────────────────────────────────────────────────
   * The old row was name / price / change. Everything else on the response was
   * being discarded, so a reader could see that Nifty moved +0.35% and not
   * whether that was a fifth of the way up its year or a whisker off the high.
   *
   * Collapsed, a row carries: name, exchange session, a month of shape, the
   * live price, the day's move and the 52-week position. Expanded, it carries
   * the rest. Nothing here is computed on the client from a guess — every
   * field is either present in the payload or printed as "Not measured".
   */
  let mkSeq = 0;
  /* THE DRAWER IS BUILT ON FIRST OPEN, NOT ON PAINT.
   *
   * Rendering all sixty-six drawers up front put 4,063 nodes on the markets
   * route against 649 before — a six-fold increase for detail that nobody had
   * asked to see yet. The row's data is parked in a map and the drawer's
   * markup is produced the first time it is opened, which keeps the route at
   * roughly the DOM it had while carrying far more information than it did.
   * The map is rebuilt on every paint, so it cannot outgrow the page. */
  let MKDATA = new Map();

  const mkRow = r => {
    const id = 'mkd' + (++mkSeq);
    MKDATA.set(id, r);
    /* The chip marks what is OPEN and nothing else. A "CLOSED" badge on all
     * sixteen India rows under a segment header that already says Closed is
     * sixteen repetitions of one fact, and it crowded out the instrument name.
     * The state is still stated in words twice — in the segment header and in
     * the row's own Session field — so nothing is carried by absence alone. */
    const sess = r.session === 'open' ? `<span class="sess is-open"><i></i>Live</span>` : '';
    return `<button type="button" class="mk" aria-expanded="false" aria-controls="${id}">
        <span class="mk-n"><span class="mk-chev" aria-hidden="true">›</span>
          <span class="mk-nm">${esc(r.name || r.symbol || '')}</span>${sess}</span>
        <span class="mk-sp">${sparkline(r.trend)
          || '<span class="mk-nosp" title="No daily close history is published for this instrument">no history</span>'}</span>
        <span class="mk-rng">${rangeBar(r)}</span>
        <span class="mk-p">${esc(r.price ?? '—')}</span>
        <span class="mk-c ${dir(r.change_pct) || 'fl'}">${pct(r.change_pct)}</span>
        ${/* EVERY INDEX CARRIES ITS OWN SCORE, and only an index does.
            * Akshay: "score engine for market, each indexes, each 1000 stock."
            * The market has the barometer above and each stock has the
            * screen's composite; this is the middle one that did not exist.
            * Two inputs, both the instrument's own: where it sits in its
            * 52-week range, and which way its published trend has gone. NOT
            * breadth — that is a market-wide figure and mixing it in would
            * print the same number beside every index on the board. */''}
        ${(() => {
          if (String(r.kind || '').toUpperCase() !== 'INDEX') return '';
          const ix = indexScore(r);
          return ix ? `<span class="mk-sc ${esc(ix.call.c)}"
            title="Where it sits in its own 52-week range, and the direction of its published trend">
            <b class="cnum">${ix.score}</b><i>${esc(ix.call.t)}</i></span>` : '';
        })()}
      </button>
      <div class="mk-d" id="${id}"><div></div></div>`;
  };

  /* Everything below is either present in the payload or printed as
   * "Not measured". Nothing here is inferred on the client. */
  const mkDrawer = r => {
    const na = '<span class="v na">Not measured</span>';
    const cell = (k, v) => `<div><span class="k">${esc(k)}</span>${
      v == null || v === '' ? na : `<span class="v">${v}</span>`}</div>`;
    const signed = v => Number.isFinite(v) ? `<span class="v ${dir(v)}">${pct(v)}</span>` : na;

    // The session window is the exchange's own, so this holds on a holiday.
    const nowS = Date.now() / 1000;
    let when = null;
    if (r.session === 'open' && Number.isFinite(r.session_end))
      when = `Closes ${clockAt(r.session_end, r.tz)} · in ${dur(r.session_end - nowS)}`;
    else if (r.session === 'closed' && Number.isFinite(r.session_start))
      when = `Closed · last session opened ${clockAt(r.session_start, r.tz)}`;

    const asOf = r.as_of ? new Date(r.as_of) : null;
    const staleMin = asOf ? (Date.now() - asOf.getTime()) / 60000 : null;

    return `<div class="mk-dg">
      ${cell('52-week high', r.w52_high_f)}
      ${cell('52-week low', r.w52_low_f)}
      <div><span class="k">From 52w high</span>${signed(r.from_high_pct)}</div>
      <div><span class="k">Above 52w low</span>${signed(r.from_low_pct)}</div>
      ${cell('Position in range', r.range_pos == null ? null : r.range_pos.toFixed(1) + '%')}
      ${cell("Day's range", r.day_low && r.day_high ? `${esc(r.day_low)} – ${esc(r.day_high)}` : null)}
      <div><span class="k">Past month</span>${signed(r.trend_pct)}</div>
      ${cell('Volume', vol(r.volume))}
      ${cell('Session', when || r.session)}
      ${cell('Quoted at', asOf ? `${asOf.toLocaleTimeString('en-GB',
          { hour: '2-digit', minute: '2-digit' })} · ${dur((Date.now() - asOf.getTime()) / 1000)} ago` : null)}
      ${cell('Instrument', r.full_name ? `${esc(r.full_name)}${r.kind ? ` · ${esc(r.kind.toLowerCase())}` : ''}` : null)}
      ${cell('Currency', r.ccy)}
      ${r.range_basis === 'futures' ? `<div class="mk-foot"><b>The price and the range are
        different feeds.</b> This row's price is a spot quote; its 52-week high and low belong to the
        futures contract, which carries a cost of carry against spot. The range position is measured
        on the futures series so the two halves agree with each other.</div>` : ''}
      ${staleMin != null && staleMin > 90 && r.session === 'open' ? `<div class="mk-foot">
        This quote is <b>${dur(staleMin * 60)}</b> old while the exchange is open — the upstream feed
        has not updated it.</div>` : ''}
      ${/* THE SAME CARD AS EVERYWHERE ELSE.
          * A board row expands into quote detail — range, session, volume — and
          * stopped there. For an index or a commodity that is the whole story,
          * but the gainers, losers and multibagger blocks are COMPANIES, and on
          * every other surface of this site tapping a company opens its card.
          * Here it opened a different, smaller thing, so the same tap did two
          * different things depending on which page you were on.
          *
          * Offered only when there is a card to open: the button is drawn from
          * the row's bare symbol and openStock() is what decides whether that
          * symbol is in the NSE screen. */''}
      ${/* WHERE A PICK CAME FROM. A weekly idea shown beside a live price and a
          * target, with no date and no entry, cannot be checked by the person
          * reading it — the two numbers that would let them judge it are the
          * ones that were being dropped. */''}
      ${r.pick_date || r.pick_entry != null ? `<div class="mk-prov">
        <b>Picked by the weekly scan.</b>
        ${r.pick_date ? ` Selected <b>${esc(r.pick_date)}</b>` : ''}${
          r.pick_entry != null ? ` at <b>₹${esc(fmtN(r.pick_entry))}</b>` : ''}${
          r.pick_target != null ? `, target <b>₹${esc(fmtN(r.pick_target))}</b>` : ''}${
          r.pick_score != null ? `, score <b>${esc(Math.round(r.pick_score))}</b>` : ''}.
        ${r.pick_entry != null && Number.isFinite(Number(r.price_raw))
          ? `Since then it is <b class="${dir((r.price_raw - r.pick_entry) / r.pick_entry * 100)}">${
              pct((r.price_raw - r.pick_entry) / r.pick_entry * 100)}</b>.` : ''}
      </div>` : ''}
      ${mkStockSym(r) ? `<div class="mk-more">
        <button type="button" class="mk-card" data-card="${esc(mkStockSym(r))}">
          Open the full company card for ${esc(mkStockSym(r))} &rarr;</button>
      </div>` : ''}
    </div>`;
  };

  /* The board carries indices (^NSEI), futures (GC=F), pairs (USDINR=X) and
   * plain equities (TCS.NS). Only the last has a company card, and it is the
   * only shape without one of those markers. */
  const mkStockSym = r => {
    const raw = String(r.symbol || '').trim();
    if (!raw || /[\^=]/.test(raw)) return null;
    const bare = raw.replace(/\.(NS|BO)$/i, '');
    return /^[A-Z0-9&-]{2,}$/.test(bare) ? bare : null;
  };

  /* Delegated, like the row toggle below it: the drawers are built on first
   * open, so a listener bound at paint time would miss every one of them. */
  document.addEventListener('click', e => {
    // ANY element carrying data-card, not just the board's button. The volume,
    // corporate-action and results rows all open the same card, and scoping
    // this to one class is why they did not.
    const b = e.target.closest && e.target.closest('[data-card]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    openStock(b.dataset.card);
  });

  /* One delegated toggle for every board row on the page. */
  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('.mk');
    if (!b) return;
    const id = b.getAttribute('aria-controls');
    const d = document.getElementById(id);
    if (!d) return;
    const inner = d.firstElementChild;
    if (inner && !inner.innerHTML) {
      const r = MKDATA.get(id);
      if (r) inner.innerHTML = mkDrawer(r);
    }
    const open = b.getAttribute('aria-expanded') === 'true';
    b.setAttribute('aria-expanded', open ? 'false' : 'true');
    d.classList.toggle('open', !open);
  });

  /* The segment's own clock: how many of its markets are trading right now,
   * and when the next one opens or closes. Both from the exchange's published
   * session window, so a public holiday is handled by the data rather than by
   * a table of market hours that nobody maintains. */
  const segWhen = items => {
    const known = items.filter(x => x.session);
    if (!known.length) return '';
    const open = known.filter(x => x.session === 'open').length;
    if (open) return `<span class="when">${open} of ${known.length} trading now</span>`;
    const nowS = Date.now() / 1000;
    // The next regular open across the segment, where the feed published one
    // in the future. Yahoo's window is the CURRENT session, so a past start is
    // simply not a forecast and is skipped rather than guessed forward.
    const next = known.map(x => x.session_start).filter(t => Number.isFinite(t) && t > nowS).sort((a, b) => a - b)[0];
    return next ? `<span class="when">Opens in ${dur(next - nowS)}</span>`
                : `<span class="when">Closed</span>`;
  };

  const breadthWidget = b => {
    if (!b || !b.counted) return '';
    const up = b.up / b.counted * 100, dn = b.down / b.counted * 100;
    return `<div class="breadth">
      <div class="breadth-n">
        <span><b class="up">${b.up}</b> <span style="color:var(--dim)">up</span></span>
        <span style="color:var(--dim);font:400 11px/1 var(--mono)">${b.counted} names · past week${
          Math.max(0, b.counted - b.up - b.down) > 0
            ? ` · ${Math.max(0, b.counted - b.up - b.down)} unchanged` : ''}</span>
        <span><b class="dn">${b.down}</b> <span style="color:var(--dim)">down</span></span>
      </div>
      ${/* THE UNCHANGED NAMES WERE MISSING FROM THE PICTURE. Two bars for up
           and down leave a gap that reads as nothing when it is in fact every
           name that did not move — 11 of 989 the day this was written. The
           split bar carries all three, so the widths add to the universe and
           a reader can check the arithmetic on the page. */''}
      ${splitBar(b.up, b.down, b.counted, 'over the past week')}
      <div class="breadth-sub">Median name ${pct(b.median)} on the week ·
        <b style="color:var(--muted)" class="cnum">${b.above_200dma}</b> hold their 200-day ·
        <b style="color:var(--muted)" class="cnum">${b.at_52w_high}</b> at a 52-week high</div>
    </div>`;
  };

  // Every column is labelled. The first version printed "₹1,036cr" and "16.1"
  // with no header, and the honest reading of that is: nobody can tell what
  // either number is. A figure without its unit is decoration.
  /* Levels, not turnover. Turnover says how much traded, which almost never
   * changes a decision; where price sits against its own 50-day and 200-day,
   * and whether it is stretched on the daily AND the monthly, does. */
  const levelTable = rows => !rows || !rows.length ?
    `<div class="empty">Nothing qualifies today.</div>` :
    PLKEY + `<div class="rank">
      <div class="rank-r lvl-r rank-head">
        <span class="i">#</span><span class="s">Name</span>
        <span class="x">Price</span><span class="x">vs 50D</span><span class="x">vs 200D</span>
        <span class="x">RSI 14D</span><span class="x">RSI 1M</span><span class="m">1W</span>
      </div>
      ${rows.map((r, i) => {
        /* The movers feed carries sym, name, price, sector, r1w, r1m and
         * turnover — and NOT sma50, sma200, rsi or rsi_m. Four of this table's
         * eight columns were therefore permanently em dashes on the markets
         * page. The values exist: every one is on the NSE screen, keyed by
         * the same symbol. fillLevels() joins them in after paint. */
        const sc = (window.__SCRIDX && window.__SCRIDX[r.sym]) || r;
        const v50 = sc.sma50 && sc.price ? (sc.price - sc.sma50) / sc.sma50 * 100 : null;
        const v200 = sc.sma200 && sc.price ? (sc.price - sc.sma200) / sc.sma200 * 100 : null;
        const hot = v => v == null ? 'var(--dim)' : v > 70 ? 'var(--warn)' : v < 35 ? 'var(--accent)' : 'var(--dim)';
        return `<div class="rank-r lvl-r" data-sym="${esc(r.sym)}" role="button" tabindex="0">
          <span class="i">${i + 1}</span>
          <span class="s"><b>${esc(r.sym)}</b><span>${esc(r.name || r.sector || '')}</span></span>
          <span class="x" data-l="Price" data-px>₹${esc(r.price ?? '—')}</span>
          <span class="x ${dir(v50)}">${v50 == null ? '—' : pct(v50)}</span>
          <span class="x ${dir(v200)}">${v200 == null ? '—' : pct(v200)}</span>
          <span class="x" style="color:${hot(sc.rsi)}">${sc.rsi != null ? Math.round(sc.rsi) : '—'}</span>
          <span class="x" style="color:${hot(sc.rsi_m)}">${sc.rsi_m != null ? Math.round(sc.rsi_m) : '—'}</span>
          <span class="m ${dir(r.r1w)}">${pct(r.r1w)}</span>
          <span class="pl-w">${priceLine(sc)}</span>
        </div>`; }).join('')}</div>`;

  const COLHEAD = {
    turnover_cr: 'Turnover', vol_spike: 'Volume vs avg', rsi: 'RSI',
    r1w: '1 week', r1m: '1 month', from_high: 'From high'
  };
  const rankList = (rows, valKey, fmt, subKey) => !rows || !rows.length ?
    `<div class="empty">Nothing qualifies today.</div>` :
    `<div class="rank">
      <div class="rank-r rank-head">
        <span class="i">#</span>
        <span class="s">Name</span>
        <span class="x">${esc(COLHEAD[subKey] || '')}</span>
        <span class="m">${esc(COLHEAD[valKey] || '')}</span>
      </div>
      ${rows.map((r, i) => `
      <div class="rank-r">
        <span class="i">${i + 1}</span>
        <span class="s"><b>${esc(r.sym)}</b><span>${esc(r.name || r.sector || '')}</span>${symLinks(r.sym)}</span>
        <span class="x" style="color:var(--dim)">${subKey && r[subKey] != null ? esc(fmtSub(subKey, r[subKey])) : ''}</span>
        <span class="m ${dir(r[valKey])}">${fmt(r[valKey])}</span>
      </div>`).join('')}</div>`;
  const fmtSub = (k, v) => k === 'turnover_cr' ? '₹' + Math.round(v).toLocaleString('en-IN') + ' cr'
                         : k === 'vol_spike' ? v.toFixed(1) + '×'
                         : k === 'rsi' ? Math.round(v) : String(v);

  /* ── routes ────────────────────────────────────────────────────────────── */
  const R = {};

  /* (V1 handler removed at the Signal V2 cutover; see the V2 block below.) */

  const convictionCard = p => {
  /* Decided ONCE, here, because three parts of this card have to agree about
     it: the header pills, the banner, and the plan. Read from the live quote
     this route already awaited, so there is no overlay and no flash of a card
     that says Buy before it says void. */
  const voided = stopVoid(p._live && p._live.price, p.stop);
  const voidWhy = voided ? STOP_VOID_WHY(p._live.price, p.stop) : '';
  return `<article class="card cv${voided ? ' is-void' : ''}" data-sym="${esc(p.sym)}" role="button" tabindex="0">
    ${/* IN THE FLOW, NOT OVER IT. The star was absolutely positioned at the
        * card's top right — which is exactly where the sector pill already
        * sits, so at 390px it sat on top of "Healthcare", "Industrials" and
        * every other sector name. Measured on four cards. It belongs in the
        * header row, which is a flex row that already knows how to make
        * room. */''}
    <div class="card-h">
      ${watchBtn(p.sym)}
      <span class="sym">${esc(p.sym)}</span>
      ${/* 81.27 was printed to two decimals. A composite score is a rank
          * order, not a measurement to a hundredth of a point, and the gap
          * between 81.27 and 79.44 is not a thing this screen can resolve.
          * Rounded, and given its denominator so the number means something
          * on its own. */''}
      ${/* NOT RECOMPUTED WHEN THE SETUP IS VOID — stamped. A fresh score
          * invented in the browser is the made-up figure this site refuses
          * elsewhere; a score that quietly keeps reading as current is the
          * fault directly above. So it keeps its number and says when. */''}
      <span class="pill pill-ac" title="Composite score${voided ? ', measured at the build price' : ''}">${
        Math.round(Number(p.score))}/100${voided ? ' <i>at build</i>' : ''}</span>
      ${p.rr ? `<span class="pill ${voided ? '' : 'pill-up'}" title="Reward to risk, entry to the second target${
        voided ? ' — measured before the stop was broken'
               : ''}">${esc(p.rr)}:1</span>` : ''}
      ${p.brk52w ? `<span class="pill pill-up">52w high</span>` : ''}
      <span class="spacer"></span>
      <span class="pill">${esc(p.sector || '')}</span>
    </div>
    <div class="card-body" style="color:var(--text);font-weight:500">${esc(p.name || '')}</div>
    ${/* ABOVE THE VIEW AND THE GRID, not below the plan. A reader who stops
        * reading after the first two lines must have been told. */''}
    ${voided ? `<p class="cv-void" title="${esc(voidWhy)}">
      <b>Setup void · stop breached.</b> ${esc(voidWhy)}</p>` : ''}
    ${/* THE SENTENCE, NOT THE SENTENCE AND ITS OWN BULLET POINTS.
        * `view` and `reasons` are the same four facts twice: SMLMAH's view
        * reads "ROCE 29%, Piotroski 7/9, up 71% in three months, at 52-week
        * high" and its four bullets are "ROCE 29%", "Piotroski 7/9", "+71%
        * over three months", "at a 52-week high". Each of those four then
        * appears a THIRD time in the grid below — ROCE, Piotroski, 3M, and
        * the 52w-high pill in the header. Nothing was wrong; all of it was
        * said three ways, on five cards, on the front page.
        *
        * The sentence survives because it reads. The bullets go. What was
        * MISSING is now in the header: r:r, which is in conviction.json, is
        * the number that decides whether an idea is worth taking, and was on
        * no card while ROCE was on every card three times. */''}
    ${p.view ? `<div class="cv-view"><span>View</span>${esc(p.view)}</div>` : ''}
    <div class="kv">
      <div><span class="kk">${p._live ? 'Live' : 'Price'}</span><span class="vv${p._live ? ' lv' : ''}">${p._live ? price(p._live.price) : price(p.price)}</span></div>
      <div><span class="kk">Today</span><span class="vv ${p._live ? dir(p._live.change_pct) : ''}">${p._live && p._live.change_pct != null ? pct(p._live.change_pct) : '—'}</span></div>
      <div><span class="kk">1M</span><span class="vv ${dir(p.r1m)}">${pct(p.r1m)}</span></div>
      <div><span class="kk">3M</span><span class="vv ${dir(p.r3m)}">${pct(p.r3m)}</span></div>
      <div><span class="kk">ROCE</span><span class="vv ${dir(p.roce)}">${p.roce != null ? p.roce.toFixed(1) + '%' : '—'}</span></div>
      <div><span class="kk">Piotroski</span><span class="vv">${p.piotroski != null ? p.piotroski + '/9' : '—'}</span></div>
      <div><span class="kk">RSI 14D</span><span class="vv">${p.rsi != null ? Math.round(p.rsi) : '—'}</span></div>
      ${/* ── FOUR FIGURES THE SCREEN COMPUTES AND NOTHING SHOWED ──────────
          * sd1y on all 750 rows, r3y_cagr on 635, roce_trend on 679 and
          * next_earnings on 274 — computed on every build, shipped in a 1.5MB
          * file the page downloads anyway, and rendered nowhere. The card
          * showed seven pure technicals a broker gives away.
          *
          * Volatility is here because it is the denominator VECTOR ranks on
          * and the thing that decides position size. ROCE trend is here
          * because a returns figure without its direction is half a fact —
          * "18%, peaked" and "18%, improving" are different companies. */''}
      ${p.sd1y == null ? '' : `<div><span class="kk">Volatility <i class="kk-q">1y</i></span><span class="vv">${
        Number(p.sd1y).toFixed(0)}%</span></div>`}
      ${p.r3y_cagr == null ? '' : `<div><span class="kk">3Y CAGR</span><span class="vv ${dir(p.r3y_cagr)}">${
        Number(p.r3y_cagr).toFixed(0)}%</span></div>`}
      ${!p.roce_trend ? '' : `<div><span class="kk">ROCE trend</span><span class="vv">${
        esc(String(p.roce_trend))}</span></div>`}
      ${(() => {
        /* ── THE ONE DATE THAT CHANGES A SWING TRADE ──────────────────────
         * A setup that runs into a results print is a different trade from the
         * same setup two weeks clear of one, and the screen has known the date
         * all along. Counted in days rather than shown as a date, because
         * "in 4 days" is the form the decision is made in. */
        if (!p.next_earnings) return '';
        const d = new Date(p.next_earnings + 'T00:00:00');
        const days = Math.round((d - new Date()) / 86400000);
        const near = days >= 0 && days <= 10;
        return `<div><span class="kk">Results</span><span class="vv${near ? ' warn' : ''}">${
          days < 0 ? esc(String(p.next_earnings).slice(5)) :
          days === 0 ? 'today' : 'in ' + days + 'd'}</span></div>`;
      })()}
    </div>
    ${p.entry ? `<div class="kv lv-plan${voided ? ' is-void' : ''}">
      <div><span class="kk">Entry</span><span class="vv">${price(p.entry)}</span></div>
      ${/* price(), like every other figure on this card. Raw, this printed
          * "₹5818.09" beside an entry of "₹6,394" — the same card grouping
          * two prices in two different number formats. */''}
      <div><span class="kk">Stop</span><span class="vv dn">${price(p.stop)} <i>${esc(p.stop_pct)}%</i></span></div>
      <div><span class="kk">Target 1</span><span class="vv up">${price(p.t1)} <i>+${esc(p.t1_pct)}%</i></span></div>
      <div><span class="kk">Target 2</span><span class="vv up">${price(p.t2)} <i>+${esc(p.t2_pct)}%</i></span></div>
    </div>
    ${/* THE STOP PATH AND THE SCALE-OUT GO WITH THE PLAN. The first pass
        * struck through Entry/Stop/Target and left the block below them
        * reading "20% at ₹1,219.10 · first target · 2.0R" in live colour —
        * the instruction restated, one block down from the strike-through,
        * on a setup that no longer exists. Wrapped rather than given a
        * parameter: trailPlan() is called from four surfaces and this is a
        * fact about THIS card's quote, not about the ladder. */''}
    ${voided ? `<div class="lv-trail-void" aria-hidden="false">${
      trailPlan(p.entry, p.stop, p.t1, p.t2, p.t3, 'BUY')}</div>`
      : trailPlan(p.entry, p.stop, p.t1, p.t2, p.t3, 'BUY')}` : ''}
    <div class="card-foot">
      <span class="mono" style="font-size:var(--t-2);color:var(--dim)">₹${p.turnover_cr != null ? Math.round(p.turnover_cr) : '—'} cr traded · not advice</span>
      ${symLinks(p.sym)}
    </div>
  </article>`;
  };

  const ideaCard = (p, lead) => {
    const cur = p.currency || '₹';
    return `<article class="card" data-sym="${esc(p.symbol || '')}" role="button" tabindex="0">
      <div class="card-h">
        <span class="sym">${esc(p.symbol || '')}</span>
        ${p.score != null ? `<span class="pill pill-ac">${esc(p.score)}/100</span>` : ''}
        <span class="spacer"></span>
        <span class="num ${dir(p.change_1d)}" style="font-size:var(--t-4)">${pct(p.change_1d)}</span>
      </div>
      ${lead && p.target_basis ? `<div class="card-body">Target is ${esc(p.target_basis)}; the stop is ${esc(p.stop_basis || 'below the trend')}.</div>` : ''}
      <!-- The chart slot is emitted EMPTY and filled after paint, at its final
           height, so the six-month line arriving shifts nothing. A card whose
           series never loads keeps a labelled blank rather than collapsing. -->
      <div class="idea-cx" data-cx="${esc(p.symbol || '')}" aria-hidden="true"></div>
      <div class="kv">
        <div><span class="kk">Price</span><span class="vv">${cur}${esc(p.price)}</span></div>
        <div><span class="kk">Target</span><span class="vv up">${cur}${esc(p.target)}</span></div>
        <div><span class="kk">Stop</span><span class="vv dn">${cur}${esc(p.stop_loss)}</span></div>
        <div><span class="kk">R:R</span><span class="vv">${esc(p.rr)}</span></div>
        <div><span class="kk">1M</span><span class="vv ${dir(p.mom_1m)}">${pct(p.mom_1m)}</span></div>
        <div><span class="kk">Horizon</span><span class="vv" style="font-size:var(--t-3)">${esc(p.timeframe || '—')}</span></div>
      </div>
    </article>`;
  };

  /* ── IDEA CARD CHARTS ────────────────────────────────────────────────────
   * Six months of real daily closes on every idea, with the target and the
   * stop drawn as rules across it — so the reader can see whether the level
   * being asked for is a short step or a long one before reading a number.
   *
   * Fetched one symbol at a time and drawn as it arrives, deliberately: a
   * dozen cards means a dozen small requests the browser pipelines, against a
   * cache that already holds most of them, and no card waits on any other. A
   * symbol with no published history keeps its slot and says so, which is the
   * same rule the markets board follows.
   */
  async function fillIdeaCharts(picks) {
    const slots = [...main.querySelectorAll('.idea-cx[data-cx]')];
    await Promise.all(slots.map(async el => {
      const sym = el.dataset.cx;
      if (!sym) return;
      const pick = (picks || []).find(x => (x.symbol || '') === sym) || {};
      const r = await get('/api/signals?series=' + encodeURIComponent(sym) + '&range=6mo');
      if (!el.isConnected) return;                 // route changed while fetching
      const pts = r.ok && Array.isArray(r.data.points) ? r.data.points : null;
      if (!pts || pts.length < 5) {
        el.innerHTML = `<span class="idea-nocx">no published price history</span>`;
        return;
      }
      const closes = pts.map(x => x.c);
      const lv = [Number(pick.target), Number(pick.stop_loss)].filter(Number.isFinite);
      const lo = Math.min(...closes, ...lv), hi = Math.max(...closes, ...lv);
      const span = (hi - lo) || 1, W = 300, H = 64, PAD = 3;
      const X = i => (i / Math.max(1, closes.length - 1)) * W;
      const Y = v => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
      const d = closes.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(2)).join(' ');
      const rule = (v, cls) => Number.isFinite(v)
        ? `<line class="ic-l ${cls}" x1="0" x2="${W}" y1="${Y(v).toFixed(2)}" y2="${Y(v).toFixed(2)}"/>` : '';
      const up = closes[closes.length - 1] >= closes[0];
      el.innerHTML = `<svg class="ic ${up ? 'up' : 'dn'}" viewBox="0 0 ${W} ${H}"
          preserveAspectRatio="none" role="img"
          aria-label="${esc(sym)}: ${pts.length} daily closes from ${esc(pts[0].t || '')} to ${esc(pts[pts.length - 1].t || '')}">
          <path class="ic-f" d="${d} L${W} ${H} L0 ${H} Z"/>
          <path class="ic-p" d="${d}"/>
          ${rule(Number(pick.target), 't')}${rule(Number(pick.stop_loss), 's')}
        </svg>`;
    }));
  }

  // The verdict leads. Someone deciding whether to apply wants the call and
  // the reason before the lot size.
  let IPO_AGE_H = null, IPO_STAMP = '', IPO_LIVE = null, IPO_LIVE_AT = null;

  /* ONE RENDERER FOR THE SUBSCRIPTION BLOCK, USED TWICE.
   *
   * Once with the mirrored figure at paint, once with the live book when it
   * arrives. Two copies of this markup is how the two states drift apart —
   * the live one gaining a caveat the mirrored one never got, or the reverse. */
  const subsInner = (mirrorX, lv) => {
    const liveX = lv && Number.isFinite(Number(lv.total_x)) ? Number(lv.total_x) : null;
    const shown = liveX != null ? liveX : (Number.isFinite(Number(mirrorX)) ? Number(mirrorX) : null);
    if (shown == null) return '';
    const wide = Math.min(100, shown / 10 * 100);
    const cats = (lv && lv.categories) || [];
    return `<span class="subs-v">${shown.toFixed(2)}×</span>
      <span class="subs-bar" style="--one:10%"><i style="width:${wide.toFixed(0)}%"></i></span>
      <span class="subs-v" style="color:var(--dim);font-size:var(--t-2)">of 10×</span>
      ${liveX != null
        ? `<span class="subs-age is-live">Live from NSE${IPO_LIVE_AT
             ? ` · read ${esc(String(IPO_LIVE_AT).slice(11, 16))} UTC` : ''}</span>`
        /* THE VINTAGE IS THE CARD'S; THE CAVEAT IS THE PAGE'S.
         * "and a book moves fastest on its last day" is a fact about IPO
         * books, not about this issue, and it printed on every card still
         * reading from the morning mirror. The sentence is said once, under
         * the block. See ipoStaleNote().
         *
         * ── AND THE STAMP WAS NOT PER-CARD EITHER ──────────────────────
         * The note above kept the stamp on each card because "those differ
         * per card". They do not. IPO_STAMP and IPO_AGE_H are module-level
         * globals read from ONE morning build, so every card that misses a
         * live NSE read prints a byte-identical sentence — four copies of
         * "as at 2026-09-13 23:56 · 1d 14h old" down one column, which is
         * what the duplicate-sentence check caught.
         *
         * It reads as flaky because it is data-dependent: a card that gets a
         * live read shows "Live from NSE" instead, so the number of copies
         * changes with how many live reads succeed. That is a latent fault
         * that happens to be invisible on a good day.
         *
         * What is per-card is WHICH SOURCE the card used, and that is all
         * this now says. The timestamp it refers to is stated once, below. */
        : (IPO_AGE_H != null ? `<span class="subs-age${IPO_AGE_H > 6 ? ' is-old' : ''}"
            title="From the morning build, as at ${esc(IPO_STAMP)}">Morning build</span>` : '')}
      ${cats.length ? `<span class="subs-cat">${cats.slice(0, 4).map(c =>
          `<i><u>${esc(c.cat)}</u><b>${Number(c.x).toFixed(2)}×</b></i>`).join('')}</span>` : ''}`;
  };

  /* Said once, under whichever block is showing mirrored figures, instead of
   * on every card that happens to be reading from the morning build. */
  /* ── SAID ONCE PER PAGE, WHICHEVER BLOCK ASKS FIRST ──────────────────────
   * Moving the stamp off the cards created the opposite bug the moment a
   * SECOND block rendered the note: /ipo showed the identical three sentences
   * twice, once under the open books and once under the upcoming ones. Both
   * call sites are correct — each needs its cards explained — so the guard
   * belongs in the note, not in the callers. First caller per render gets it;
   * the rest get nothing. Reset by the route before it paints. */
  let ipoNoteShown = false;
  const ipoStaleNote = () => {
    if (IPO_AGE_H == null || ipoNoteShown) return '';
    ipoNoteShown = true;
    /* The stamp lives HERE now, not on each card — it is one value from one
       build, so printing it per card was the same sentence repeated. Stated
       whatever the age, because a card saying "Morning build" has to be able
       to tell you WHICH morning; the staleness warning is the part that is
       conditional on the figure actually being old. */
    return `<p class="hint">Figures marked <b>Morning build</b> are as at
       <b>${esc(IPO_STAMP)}</b>${IPO_AGE_H > 6 ? ` — <b>${esc(ageWord(IPO_AGE_H))}</b>` : ''},
       not read from NSE just now.${IPO_AGE_H > 6
         ? ' A book moves fastest on its last day, so treat a subscription figure that old as a'
           + ' floor rather than a reading.' : ''}
       Anything marked <b>Live from NSE</b> was read on this page load.</p>`;
  };

  /* Fetch the live book once and patch every card on screen. A targeted DOM
   * update, not a re-render: re-entering a route when a deferred fetch
   * resolves is what put the front page into an infinite repaint loop, and
   * this cannot. A symbol NSE does not carry keeps its mirrored figure and
   * its vintage. */
  async function fillIpoLive() {
    const hosts = [...document.querySelectorAll('.subs[data-ipo]')];
    /* IT USED TO RETURN HERE WHEN THERE WERE NO CARDS TO PATCH.
     *
     * That is precisely backwards. No cards means the morning build carried no
     * open book — either because it never ran, or because every book it knew
     * about has since closed. That is the one moment the live NSE list is the
     * only thing standing between the reader and an empty section, and it was
     * the one moment this function refused to fetch it. Carry on as long as
     * there is anywhere at all to render. */
    const extras = [...document.querySelectorAll('#ipoExtra, #ipoExtraHome')];
    if (!hosts.length && !extras.length) return;
    const r = await get('/api/ipo-live');
    if (!r.ok || !r.data || !r.data.ok) return;
    IPO_LIVE = r.data;
    IPO_LIVE_AT = r.data.at || null;
    const bySym = new Map((r.data.issues || []).map(x => [String(x.symbol).toUpperCase(), x]));
    for (const host of hosts) {
      const lv = bySym.get(host.getAttribute('data-ipo'));
      if (!lv) continue;
      const first = host.querySelector('.subs-v');
      const mirror = first ? Number(String(first.textContent).replace(/[^0-9.]/g, '')) : NaN;
      host.innerHTML = subsInner(mirror, lv);
    }

    /* THE PROSE QUOTES THE FIGURE IT WAS WRITTEN WITH.
     *
     * verdict_why is generated during the daily build, so it opens
     * "Subscribed 27.8x, but the book is small" — and once the headline number
     * was upgraded to the live 104.69x the card carried both figures at once
     * and contradicted itself in its own sentence.
     *
     * Only the subscription clause is rewritten; the rest of the sentence is
     * about book size and is still true. A sentence that does not match the
     * pattern is left exactly as the build wrote it rather than guessed at. */
    /* Anything NSE calls active that the page has not already shown. */
    const extra = document.getElementById('ipoExtra') || document.getElementById('ipoExtraHome');
    if (extra) {
      const shown = new Set([...document.querySelectorAll('.subs[data-ipo]')]
        .map(x => x.getAttribute('data-ipo')));
      const missing = (r.data.issues || []).filter(x => !shown.has(String(x.symbol).toUpperCase()));
      extra.innerHTML = missing.length ? `<section class="sec">
        <div class="sec-h"><h2>${hosts.length ? 'Also open on NSE' : 'Open on NSE'}</h2>
          <span class="sec-n">${missing.length} not in the screen</span></div>
        <p class="sec-lead">${hosts.length
          ? "Books NSE lists as active that this morning's build did not carry."
          : "Read live from NSE. The build that carries bands, lots and verdicts has not run since these opened."}</p>
        <div class="rank">${missing.map(x => `<div class="rank-r xtra">
          <span class="s"><b>${esc(x.symbol)}</b><span>${esc(x.company || '')}</span></span>
          ${/* Number(null) is 0, not NaN, so an unpublished book rendered as
              * "0.00×" — a real figure claiming nobody has bid. Check the value
              * before coercing it. */''}
          <span class="x">${x.total_x != null && Number.isFinite(Number(x.total_x))
            ? Number(x.total_x).toFixed(2) + '×' : 'no book yet'}</span>
          <span class="x">${esc(x.closes || '—')}</span>
        </div>`).join('')}</div>
        <p class="hint">Subscription is live from NSE. There is no verdict, band or lot for these —
          the build had not enriched them when it ran, and a rating invented to fill the row would be
          worth less than the gap.</p>
      </section>` : '';
    }

    for (const el of document.querySelectorAll('.ipo-why[data-why]')) {
      const lv = bySym.get(el.getAttribute('data-why'));
      const x = lv && Number.isFinite(Number(lv.total_x)) ? Number(lv.total_x) : null;
      if (x == null) continue;
      const was = el.textContent;
      const now = was.replace(/Subscribed\s+[\d.]+\s*x/i, `Subscribed ${x.toFixed(1)}x`);
      if (now !== was) el.textContent = now;
    }
  }
  /* A BOOK'S LAST DAY IS A FACT ABOUT THE CALENDAR, NOT ABOUT THE BUILD.
   *
   * days_left is computed by the daily build and then frozen into the feed.
   * On 1 Sep the live site still showed LUMINO — a book that closed on 31 Aug
   * — carrying the pill "closes today", because days_left had been 0 since the
   * morning of the 31st and nothing ever recomputed it. A stale feed is a
   * recoverable state the page already labels; a stale feed ASSERTING that a
   * shut book closes today is a reader placing an application that cannot be
   * filled. That is the difference between old and wrong.
   *
   * close_date sits in the feed and was never read by this file. These derive
   * the number from it against the Indian trading day, so the claim decays to
   * the truth as the feed ages instead of repeating the morning it was built. */
  /* ── MOVED TO engines.js, WHICH BOTH SITES LOAD ──────────────────────────
   * These three lived here, and gems.askakshay.com — a separate bundle that
   * cannot see them — read ipo.open raw instead. So signal showed two open
   * books and gems showed five, three of which had stopped taking bids the
   * previous day, under a heading that said "open". Not a stale feed: one site
   * applying a rule the other did not know existed. */
  const istToday = SIGNAL_RULES.istToday;
  const daysLeftFor = SIGNAL_RULES.daysLeft;
  const ipoOpenNow = SIGNAL_RULES.ipoOpenNow;

  // NSE keys on the symbol; the mirror sometimes carries a name and no symbol.
  const ipoLiveFor = r => {
    if (!IPO_LIVE) return null;
    const sym = String(r.symbol || r.sym || '').trim().toUpperCase();
    const nm = String(r.company || r.name || '').toLowerCase();
    return (IPO_LIVE.issues || []).find(x =>
      (sym && x.symbol === sym) ||
      (nm && x.company && nm.startsWith(String(x.company).toLowerCase().split(' ')[0]))) || null;
  };
  const ipoCard = r => {
    const v = String(r.verdict || '').toUpperCase();
    const cls = v.startsWith('APPLY') ? 'v-apply' : v === 'AVOID' ? 'v-avoid' : 'v-watch';
    const sub = Number(r.subscription_x);
    const pctOfTen = isFinite(sub) ? Math.min(100, sub / 10 * 100) : 0;
    const forr = r.reads_for || [], agn = r.reads_against || [];
    return `<article class="ipo" data-sym="${esc(r.symbol || r.sym || '')}" role="button" tabindex="0">
      <div class="ipo-h">
        <span class="sym">${esc(r.symbol || r.sym || '')}</span>
        ${r.verdict ? `<span class="pill ${cls}">${esc(r.verdict)}</span>` : ''}
        <span class="spacer"></span>
        ${(() => { const dl = daysLeftFor(r); return dl == null ? ''
          : `<span class="pill${dl < 0 ? ' v-avoid' : ''}">${
              dl < 0 ? 'book closed' : dl === 0 ? 'closes today' : esc(dl) + 'd left'}</span>`; })()}
        <span class="co">${esc(r.company || '')}</span>
      </div>
      ${r.verdict_why ? `<div class="ipo-why" data-why="${esc(String(r.symbol || r.sym || '').toUpperCase())}">${
        esc(r.verdict_why)}</div>` : ''}
      ${/* A SUBSCRIPTION NUMBER WITHOUT ITS VINTAGE IS A TRAP.
          * This feed is a daily mirror. On the day this was written it was 31
          * hours old and showed Lumino at 2.86x while the book had reached
          * 28.6x — the figure was not wrong when it was written, it was
          * ten times out of date, and nothing on the card said so. An IPO
          * subscription number moves fastest on the last day, which is exactly
          * when someone is deciding, so this one has to carry its own age. */''}
      ${isFinite(sub) ? `<div class="subs" data-ipo="${esc(String(r.symbol || r.sym || '').toUpperCase())}">
        ${subsInner(sub, null)}
      </div>` : ''}
      <div class="kv">
        <div><span class="kk">Band</span><span class="vv" style="font-size:var(--t-3)">${esc(r.price_band || '—')}</span></div>
        <div><span class="kk">Lot</span><span class="vv">${esc(r.lot_size ?? '—')}</span></div>
        <div><span class="kk">Min</span><span class="vv">${r.min_investment ? money(r.min_investment) : '—'}</span></div>
        <div><span class="kk">Size</span><span class="vv">${r.issue_size_cr ? '₹' + Math.round(r.issue_size_cr) + 'cr' : '—'}</span></div>
        <div><span class="kk">GMP</span><span class="vv">${esc(r.gmp_text || '—')}</span></div>
        <div><span class="kk">P/E post</span><span class="vv">${r.pe_post_issue ? r.pe_post_issue.toFixed(1) + '×' : '—'}</span></div>
      </div>
      ${(forr.length || agn.length) ? `<div class="reads">
        ${forr.slice(0, 2).map(x => `<div class="read read-for">${esc(x)}</div>`).join('')}
        ${agn.slice(0, 2).map(x => `<div class="read read-against">${esc(x)}</div>`).join('')}
      </div>` : ''}
      ${r.verdict_caveat ? `<div class="ipo-caveat">${esc(r.verdict_caveat)}</div>` : ''}
    </article>`;
  };


  /* ── THE WORLD, AND WHO IS AWAKE IN IT ────────────────────────────────────
   *
   * This board carries instruments from six exchanges, and until now the only
   * hint of that was a per-segment "Opens in 6h 9m". A reader looking at a
   * flat Nikkei at midnight in Dubai could not tell whether it was flat
   * because nothing happened or flat because Tokyo has been shut for hours —
   * which is the difference between information and no information.
   *
   * Hours are LOCAL to each exchange and the clocks are built with
   * Intl.DateTimeFormat, so daylight saving is handled by the platform rather
   * than by a table in this file that would be wrong twice a year.
   *
   * HOLIDAYS USED TO BE THE HOLE, AND THE DATA WAS ALREADY IN THE BUILDING.
   *
   * Akshay, 2026-09-14: "NSE shows open on market page but today is holiday."
   * He was right. 14 September 2026 is Ganesh Chaturthi, NSE was shut all day,
   * and this strip read "NSE · OPEN · Closes in 5h 12m" through the entire
   * session, because the only thing it knew was the clock and the weekday.
   *
   * The fix needed no new source. /api/calendar has fetched NSE's own
   * holiday-master since it was written, and returns exactly this:
   *     { date: "2026-09-14", day: "Monday", why: "Ganesh Chaturthi" }
   * The clock simply never asked it. It asks now, and a matching date makes
   * the exchange shut with the holiday's name shown instead of a countdown to
   * an open that will not happen.
   *
   * SCOPE, STATED HONESTLY. NSE is the only exchange this covers, because
   * NSE's list is the only one the site fetches. Thanksgiving and Boxing Day
   * will still show NYSE and LSE as open, so the strip keeps saying so — for
   * those five, not for all six. A widget that overstates its own coverage is
   * the bug being fixed here, and replacing it with a quieter version of the
   * same overstatement would not be a fix.
   */
  /* Filled by whichever route has already loaded /api/calendar. Empty until
     then, and an empty table simply means no holiday is known — never that a
     market is open. */
  let NSE_HOLIDAYS = Object.create(null);
  const setHolidays = (rows) => {
    for (const r of rows || []) if (r && r.date) NSE_HOLIDAYS[r.date] = r.why || 'Exchange holiday';
    /* Repaint the masthead clock now, not at its next minute: until then it
       read the eve of a holiday as "opens tomorrow". Before the clock exists
       this throws in its temporal dead zone, which is fine — it paints itself. */
    try { tickClock(); } catch (e) { /* clock not set up yet */ }
  };
  // Today's date in a zone, as YYYY-MM-DD — the key the calendar feed uses.
  const zoneDay = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const EXCHANGES = [
    ['Mumbai',    'NSE',   'Asia/Kolkata',   9.25, 15.5,  72.83],
    ['Hong Kong', 'HKEX',  'Asia/Hong_Kong', 9.5,  16.0,  114.16],
    ['Tokyo',     'TSE',   'Asia/Tokyo',     9.0,  15.0,  139.69],
    ['Dubai',     'DFM',   'Asia/Dubai',     10.0, 15.0,  55.27],
    ['London',    'LSE',   'Europe/London',  8.0,  16.5,  -0.13],
    ['New York',  'NYSE',  'America/New_York', 9.5, 16.0, -74.01],
  ];

  // Local wall-clock parts for a zone, without pulling in a date library.
  function zoneNow(tz) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
    return { wd: parts.weekday, h: +parts.hour % 24, m: +parts.minute, s: +parts.second };
  }

  const fmtGap = mins => {
    const d = Math.max(0, Math.round(mins));
    return d >= 60 ? `${Math.floor(d / 60)}h ${d % 60}m` : `${d}m`;
  };

  function exchangeState(tz, open, close, code) {
    const t = zoneNow(tz);
    const now = t.h + t.m / 60 + t.s / 3600;
    const weekend = t.wd === 'Sat' || t.wd === 'Sun';
    /* A holiday outranks the clock. Checked against the exchange's OWN local
       date, not the reader's — in MYT it is already tomorrow in New York's
       evening, and comparing against the wrong day is how a holiday widget
       goes wrong in the other direction. */
    if (code === 'NSE') {
      const why = NSE_HOLIDAYS[zoneDay(tz)];
      if (why) return { open: false, label: esc(why), holiday: true, t };
    }
    if (!weekend && now >= open && now < close)
      return { open: true, label: 'Closes in ' + fmtGap((close - now) * 60), t };
    // Next open: later today on a trading day, otherwise the next weekday
    // morning — and for the NSE, the next day that is not an exchange holiday
    // either. Skipping weekends alone said "opens in 15h" the evening before
    // a holiday (audit item 18).
    let wait;
    const todayHoliday = code === 'NSE' && !!NSE_HOLIDAYS[zoneDay(tz)];
    if (!weekend && !todayHoliday && now < open) wait = (open - now) * 60;
    else {
      const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const base = new Date(zoneDay(tz) + 'T00:00:00Z');
      let daysAhead = 1;
      for (; daysAhead < 15; daysAhead++) {
        const d = new Date(base.getTime() + daysAhead * 86400000);
        const wd = WD[d.getUTCDay()];
        if (wd === 'Sat' || wd === 'Sun') continue;
        if (code === 'NSE' && NSE_HOLIDAYS[d.toISOString().slice(0, 10)]) continue;
        break;
      }
      wait = ((24 - now) + open + (daysAhead - 1) * 24) * 60;
    }
    return { open: false, label: 'Opens in ' + fmtGap(wait), t };
  }

  // An analog face. Hands are plain rotations — no per-frame work, and the
  // whole thing is redrawn once a second by one timer for all six.
  const clockFace = (h, m) => {
    const hh = ((h % 12) + m / 60) * 30, mm = m * 6;
    return `<svg class="wc-f" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="18.5" class="wc-dial"/>
      ${[0, 3, 6, 9].map(i => {
        const a = i * 30 * Math.PI / 180;
        return `<line x1="${20 + 14.5 * Math.sin(a)}" y1="${20 - 14.5 * Math.cos(a)}"
                      x2="${20 + 16.8 * Math.sin(a)}" y2="${20 - 16.8 * Math.cos(a)}" class="wc-tk"/>`;
      }).join('')}
      <line x1="20" y1="20" x2="20" y2="11.5" class="wc-h" transform="rotate(${hh} 20 20)"/>
      <line x1="20" y1="20" x2="20" y2="7.5"  class="wc-m" transform="rotate(${mm} 20 20)"/>
      <circle cx="20" cy="20" r="1.5" class="wc-pin"/>
    </svg>`;
  };

  /* The globe is ornament, and is built so that it costs nothing: one SVG,
   * rotated by a CSS animation rather than a script. It therefore stops on
   * its own in a background tab, needs no requestAnimationFrame — which does
   * not run in a hidden tab anyway — and disappears entirely under
   * prefers-reduced-motion. The dots are the six exchanges at their real
   * longitudes, so the one that is lit is the one that is trading. */
  const globe = live => `<svg class="wc-globe" viewBox="0 0 120 120" role="img"
      aria-label="A globe marking the six exchanges on this board">
    <defs><clipPath id="gclip"><circle cx="60" cy="60" r="52"/></clipPath></defs>
    <circle cx="60" cy="60" r="52" class="wc-sea"/>
    <g clip-path="url(#gclip)">
      ${[-40, -20, 0, 20, 40].map(lat =>
        `<ellipse cx="60" cy="${60 + lat * 1.15}" rx="52" ry="${Math.max(2, 52 - Math.abs(lat) * 1.05)}"
                  class="wc-par"/>`).join('')}
      <g class="wc-spin">
        ${Array.from({ length: 12 }, (_, i) =>
          `<ellipse cx="60" cy="60" rx="${52 * Math.abs(Math.cos(i * Math.PI / 12))}" ry="52"
                    class="wc-mer"/>`).join('')}
      </g>
    </g>
    <circle cx="60" cy="60" r="52" class="wc-rim"/>
    ${EXCHANGES.map(([city, , , , , lon], i) => {
      // Longitude to x across the disc; latitude is stylised, not surveyed.
      const x = 60 + (lon / 180) * 46, y = 60 - [8, 14, 18, 2, 30, 20][i];
      return `<circle cx="${x.toFixed(1)}" cy="${y}" r="${live[i] ? 3.4 : 2.2}"
                class="wc-city${live[i] ? ' on' : ''}"><title>${esc(city)}</title></circle>`;
    }).join('')}
  </svg>`;

  function worldClocksHtml() {
    const st = EXCHANGES.map(([, code, tz, o, c]) => exchangeState(tz, o, c, code));
    const openCount = st.filter(x => x.open).length;
    return { openCount, html: `<div class="wc">
      <div class="wc-g">${globe(st.map(x => x.open))}</div>
      <div class="wc-r">${EXCHANGES.map(([city, code], i) => {
        const x = st[i];
        return `<div class="wc-i${x.open ? ' on' : ''}">
          ${clockFace(x.t.h, x.t.m)}
          <div class="wc-x">
            <span class="wc-c">${esc(city)}</span>
            <span class="wc-t">${String(x.t.h).padStart(2, '0')}:${String(x.t.m).padStart(2, '0')}</span>
            <span class="wc-e">${esc(code)} · <b>${
              x.holiday ? 'Holiday' : x.open ? 'Open' : 'Closed'}</b></span>
            <span class="wc-n">${esc(x.label)}</span>
          </div>
        </div>`;
      }).join('')}</div></div>` };
  }

  // One timer for all six faces, ticking on setInterval rather than rAF so it
  // keeps correct time in a background tab and costs one DOM write a second.
  function wireWorldClocks() {
    const host = document.getElementById('wcHost');
    if (!host) return;
    const tick = () => {
      const { html, openCount } = worldClocksHtml();
      host.innerHTML = html;
      const n = document.getElementById('wcN');
      if (n) n.textContent = openCount === 0 ? 'all shut'
        : `${openCount} of ${EXCHANGES.length} open`;
    };
    tick();
    const id = setInterval(tick, 1000);
    main.addEventListener('sig:teardown', () => clearInterval(id), { once: true });
  }


  /* ── RSI, AND DIVERGENCE AGAINST IT ──────────────────────────────────────
   *
   * The screen publishes a single RSI value per name. A DIVERGENCE is not a
   * value, it is a relationship between two series over time — price making a
   * higher high while RSI makes a lower one — so it cannot be read off the
   * screen and has to be computed from the daily closes. That is one request
   * per name, which is why it is a button the reader presses rather than
   * something this page does to twenty symbols on open.
   *
   * Wilder's smoothing, not a simple moving average: the first average is the
   * mean of the opening `period` changes and every one after it is smoothed
   * by (prev*(n-1) + current)/n. A simple average gives a different number and
   * every chart package in the world uses Wilder's, so a simple one would
   * disagree with whatever the reader is comparing against.
   */
  function rsiSeries(closes, period = 14) {
    if (!closes || closes.length <= period) return [];
    const out = new Array(closes.length).fill(null);
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
      loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /* Swing points, not the highest bar in the window. A divergence drawn
   * between "the max of the last 30 closes" and "the max of the 30 before
   * that" will fire on any trending series; it has to be drawn between two
   * PIVOTS — a bar higher (or lower) than the `w` bars on both sides of it. */
  function pivotsOf(arr, w, kind) {
    const out = [];
    for (let i = w; i < arr.length - w; i++) {
      const v = arr[i];
      if (v == null) continue;
      let ok = true;
      for (let j = i - w; j <= i + w && ok; j++) {
        if (j === i || arr[j] == null) continue;
        if (kind === 'high' ? arr[j] > v : arr[j] < v) ok = false;
      }
      if (ok) out.push(i);
    }
    return out;
  }

  /* Regular divergence over the recent window. Returns null when there are not
   * two comparable pivots — "no divergence found" and "not enough history to
   * look" are different answers and the caller says which. */
  function rsiDivergence(closes, lookback = 90) {
    const px = closes.slice(-lookback);
    if (px.length < 40) return { ok: false, why: 'not enough daily history' };
    const rsi = rsiSeries(px);
    if (!rsi.length) return { ok: false, why: 'not enough daily history' };
    const W = 4;
    const hi = pivotsOf(px, W, 'high').filter(i => rsi[i] != null).slice(-2);
    const lo = pivotsOf(px, W, 'low').filter(i => rsi[i] != null).slice(-2);

    if (hi.length === 2 && px[hi[1]] > px[hi[0]] && rsi[hi[1]] < rsi[hi[0]])
      return { ok: true, kind: 'bearish', bars: px.length - hi[1],
               note: `price made a higher high (${fmtN(px[hi[0]])} → ${fmtN(px[hi[1]])}) while RSI made a lower one (${Math.round(rsi[hi[0]])} → ${Math.round(rsi[hi[1]])})` };
    if (lo.length === 2 && px[lo[1]] < px[lo[0]] && rsi[lo[1]] > rsi[lo[0]])
      return { ok: true, kind: 'bullish', bars: px.length - lo[1],
               note: `price made a lower low (${fmtN(px[lo[0]])} → ${fmtN(px[lo[1]])}) while RSI made a higher one (${Math.round(rsi[lo[0]])} → ${Math.round(rsi[lo[1]])})` };
    return { ok: true, kind: 'none', note: 'the last two swings in price and RSI point the same way' };
  }

  /* One at a time in fours: twenty symbols at once is twenty concurrent
   * requests to the same origin, which the browser queues anyway and the
   * upstream is entitled to refuse. */
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; }
      }
    }));
    return out;
  }

  /* ── THE FIVE TILES, OPENED ───────────────────────────────────────────────
   * Parked on one object at paint time rather than re-fetched on click: every
   * dataset behind these was already loaded to draw the tile, and asking NSE
   * again to show what is on screen is a request for nothing. */
  let TODAY5 = null;
  let heavyTried = false;
  /* True when the front page rendered before its heavy feeds arrived. */
  let homeLacked = false;
  /* Same shape as heavyTried: one retry per visit, never a loop on failure. */
  let regimeTried = false;
  /* ── THE SCREEN ROWS, HELD ONCE SEEN ──────────────────────────────────────
   * The front page renders more than once — the heavy pass re-enters it, and
   * so does the regime fetch — and CACHED() only answers for MICRO_MS, which
   * is five seconds. So a re-entry that lands six seconds later finds the
   * screen "not ready" and the heatmap strip silently disappears from a page
   * that had just drawn it. Measured exactly that way: the strip present on
   * one render and absent on the next, with nothing in the console.
   *
   * The rows do not expire in five seconds — the micro-cache is about not
   * re-requesting, not about the data going stale. Held here so any render
   * can draw the strip regardless of which pass it is. */
  let FRONT_SCREEN = null;
  /* Same reason, same fix: see the note at the regime section. */
  let FRONT_REGIME = null;

  // "2026-09-14" -> "14 Sep". Day first, because that is the part that
  // answers "how soon".
  const t5DM = d => {
    if (!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? esc(d)
      : `${dt.getDate()} ${dt.toLocaleDateString('en-GB', { month: 'short' }).replace(/\.$/, '').slice(0, 3)}`;
  };

  const t5Date = d => {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? esc(d)
      : dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  function openToday5(which) {
    const T = TODAY5;
    if (!T) return;
    const rowsOf = k => (T.cal && T.cal[k] && T.cal[k].rows) || [];
    const dead = k => T.cal && T.cal[k] && T.cal[k].ok === false
      ? `<div class="empty">NSE did not answer: ${esc(T.cal[k].error || 'no reason given')}.</div>` : null;

    if (which === 'news') {
      const uni = [];
      const list = (T.wire || []).map(x => ({ x, n: T.wireTop ? 0 : 0 }));
      return sheet('The wire, by reach', `
        <p class="hint" style="margin:0 0 14px">Ordered by how many screened names each
          story mentions. That is a measure of reach, not of importance — this feed carries no data
          that would support ranking importance.</p>
        ${(T.wire || []).length ? `<div class="t5l">${(T.wire || []).slice(0, 18).map(x => `
          <a class="t5i" href="${esc(x.link || '#')}" ${x.link ? 'target="_blank" rel="noopener"' : ''}>
            <span class="t5s">${esc(x.source || 'wire')}</span>
            <span class="t5t">${esc(x.title || '')}</span>
            ${x.summary ? `<span class="t5d">${esc(String(x.summary).slice(0, 170))}</span>` : ''}
          </a>`).join('')}</div>
          <p class="hint"><a class="more-l" href="/news">Open the full wire, with the names each story touches &rarr;</a></p>`
        : `<div class="empty">The wire is quiet.</div>`}`);
    }

    if (which === 'vol') {
      const v = T.spurts || [];
      const rsiZone = n => n == null ? ['', 'not measured']
        : n < 30 ? ['dn', 'oversold'] : n < 50 ? ['', 'soft']
        : n < 70 ? ['up', 'firm'] : ['wn', 'overbought'];
      const rowHtml = (r, div) => {
        const [zc, zw] = rsiZone(r.rsi);
        return `<div class="t5i t5v" data-sym="${esc(r.sym)}">
          <span class="t5s">${esc(r.sym)} · ${esc(r.sector || '')}</span>
          <span class="t5row">
            <button type="button" class="t5name" data-card="${esc(r.sym)}">${esc(r.name || '')}</button>
            ${watchBtn(r.sym)}
          </span>
          ${/* LIVE WHERE THERE IS A LIVE QUOTE, AND SAID SO WHERE THERE IS NOT.
               This printed the screen's build-time close and its build-time
               1-day return under the word "today". On 18 Sep that read
               "TATACHEM -0.40% today · ₹731.80" while the stock was at ₹693.25,
               down 11.04%, and the heatmap two sections above said so. */''}
          ${(() => {
            const q = livePx(r.sym);
            const px = q ? sn(q.price) : lvl(r.price);
            const ch = q ? sn(q.change_pct) : sn(r.r1d);
            return `<span class="t5m"><b>${Number(r.vol_spike).toFixed(2)}×</b> average volume
              · <i class="${dir(ch)}">${pct(ch)}</i> ${q ? 'today' : 'on the screen build'}
              · ₹${esc(fmtN(px))}${q ? '' : ' <em class="t5stale">screen close</em>'}
              · RSI <b class="${zc}">${r.rsi != null ? Math.round(r.rsi) : '—'}</b> <em>${esc(zw)}</em></span>`;
          })()}
          <span class="t5div" data-div="${esc(r.sym)}">${div || ''}</span>
        </div>`;
      };
      sheet('Volume spurts', `
        <p class="hint" style="margin:0 0 12px">Names trading at <b>1.5×</b> or more of their own
          recent average volume, largest first. Volume confirms a move or contradicts it; on its own
          it says only that more people than usual are trading this name today.</p>
        ${v.length ? `<div class="t5tools">
            <button type="button" class="chip" id="divRun">Check RSI divergence on the daily chart</button>
            <button type="button" class="chip" id="divOnly" aria-pressed="false" hidden>Only names with divergence</button>
            <span class="t5note" id="divNote"></span>
          </div>
          <div class="t5l" id="volList">${v.map(r => rowHtml(r, '')).join('')}</div>`
        : `<div class="empty">No screened name is trading at 1.5× its average volume today.</div>`}`);

      /* DIVERGENCE IS A BUTTON, NOT A DEFAULT.
       * It needs one daily series per name — twenty requests — so it runs when
       * asked and reports progress rather than making the sheet wait on it. */
      const run = document.getElementById('divRun');
      if (!run) return;
      let results = null;
      const note = document.getElementById('divNote');
      const only = document.getElementById('divOnly');
      const redraw = filtered => {
        const list = document.getElementById('volList');
        if (!list) return;
        const rows = filtered ? v.filter(r => (results[r.sym] || {}).kind && results[r.sym].kind !== 'none') : v;
        list.innerHTML = rows.length ? rows.map(r => {
          const d = results && results[r.sym];
          const tag = !d ? ''
            : !d.ok ? `<em class="dv dv-na">${esc(d.why)}</em>`
            : d.kind === 'none' ? `<em class="dv dv-na">No divergence — ${esc(d.note)}</em>`
            : `<em class="dv dv-${esc(d.kind)}">${d.kind === 'bullish' ? 'Bullish' : 'Bearish'} RSI divergence</em>
               <em class="dv-n">${esc(d.note)}, ${esc(d.bars)} bars ago</em>`;
          return rowHtml(r, tag);
        }).join('') : `<div class="empty">None of these names shows an RSI divergence.</div>`;
      };
      run.addEventListener('click', async () => {
        run.disabled = true;
        results = {};
        let done = 0;
        note.textContent = `reading ${v.length} daily charts…`;
        await mapLimit(v, 4, async r => {
          const res = await get(`/api/signals?series=${encodeURIComponent(r.sym)}&range=1y`);
          const pts = res.ok ? (res.data.points || []) : [];
          results[r.sym] = pts.length
            ? rsiDivergence(pts.map(x => Number(x.c)).filter(Number.isFinite))
            : { ok: false, why: 'no daily series' };
          note.textContent = `read ${++done} of ${v.length}…`;
        });
        const n = Object.values(results).filter(d => d.ok && d.kind && d.kind !== 'none').length;
        note.textContent = n ? `${n} of ${v.length} show a divergence` : `no divergence in these ${v.length}`;
        run.hidden = true;
        if (n) { only.hidden = false; }
        redraw(false);
      });
      only.addEventListener('click', () => {
        const on = only.getAttribute('aria-pressed') === 'true';
        only.setAttribute('aria-pressed', String(!on));
        redraw(!on);
      });
      return;
    }

    if (which === 'acts') {
      const rows = rowsOf('actions');
      return sheet('Corporate actions', dead('actions') || `
        <p class="hint" style="margin:0 0 14px">From NSE, ordered with the ones that change a share
          count or a quoted price first — <b>bonus, split, rights</b> — then buybacks and dividends.
          The ex-date is the day the price adjusts.</p>
        ${rows.length ? `<div class="t5l">${rows.slice(0, 30).map(r => `
          <div class="t5i">
            <span class="t5s"><b class="t5k t5k-${esc(String(r.kind).toLowerCase())}">${esc(r.kind)}</b>
              ${esc(r.sym || '')}</span>
            <span class="t5row">
              <button type="button" class="t5name" data-card="${esc(r.sym || '')}">${esc(r.company || '')}</button>
              ${watchBtn(r.sym)}
            </span>
            <span class="t5m">${esc(r.detail || '')}${r.ex ? ` · ex ${t5Date(r.ex)}` : ''}</span>
          </div>`).join('')}</div>`
        : `<div class="empty">NSE lists no corporate actions in this window.</div>`}`);
    }

    if (which === 'res') {
      const rows = rowsOf('results');
      const res = rows.filter(x => x.isResult), rest = rows.filter(x => !x.isResult);
      return sheet('Results and board meetings', dead('results') || `
        <p class="hint" style="margin:0 0 14px">NSE's board-meeting calendar. Meetings called to
          approve <b>results</b> are listed first; the rest are fund-raising and administrative
          filings, kept because a board meeting is itself news.</p>
        ${rows.length ? `<div class="t5l">${[...res, ...rest].slice(0, 30).map(r => `
          <div class="t5i">
            <span class="t5s">${r.isResult ? '<b class="t5k t5k-result">Results</b> ' : ''}${esc(r.sym || '')}
              ${r.date ? `· ${t5Date(r.date)}` : ''}</span>
            <span class="t5row">
              <button type="button" class="t5name" data-card="${esc(r.sym || '')}">${esc(r.company || '')}</button>
              ${watchBtn(r.sym)}
            </span>
            <span class="t5m">${esc(r.purpose || '')}</span>
          </div>`).join('')}</div>`
        : `<div class="empty">NSE lists no board meetings in this window.</div>`}`);
    }

    if (which === 'hol') {
      const rows = rowsOf('holidays');
      return sheet('Market holidays', dead('holidays') || `
        <p class="hint" style="margin:0 0 14px">Cash-market trading holidays from NSE, from today
          onward. On these days no Indian price on this site will move, and the clock strip on
          Markets will still show the exchange as open — it tracks session hours, not the calendar.</p>
        ${rows.length ? `<div class="t5l">${rows.map(r => `
          <div class="t5i t5h">
            <span class="t5t">${t5Date(r.date)}</span>
            <span class="t5m">${esc(r.why || '')}</span>
          </div>`).join('')}</div>`
        : `<div class="empty">NSE lists no further holidays this year.</div>`}`);
    }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-t5]');
    if (!b) return;
    e.preventDefault();
    openToday5(b.dataset.t5);
  });

  R['/markets'] = async () => {
    paint(head('Markets', 'The indices, sectors, currencies and commodities that set the tone — and how the wider screen did underneath them.', 'The board') +
      sec('Breadth', `<div class="sk" style="height:104px"></div>`) +
      sec('Sector heat', `<div class="sk" style="height:120px"></div>`) +
      sec('The board', `<div class="board">${skel('sk-row', 8)}</div>`), true);

    /* The calendar comes along for the holiday list. A reader who lands
       straight on /markets never runs the front page, so without this the
       world strip would be holiday-blind on the one page it appears — which
       is exactly how it showed NSE open on Ganesh Chaturthi. Fetched
       alongside, never awaited on its own: a holiday name is worth a slot in
       an existing round trip, not a delay to the whole board. */
    const [m, p, cl, tk] = await Promise.all([
      get('/api/markets'), get('/pulse.json'), get('/api/calendar').catch(() => ({ ok: false })),
      /* The ticker carries every index's 52-week range and its own trend
         series, which /api/markets does not — and the barometer leads this
         page, so it cannot wait for the board's own fetch further down. */
      get('/api/ticker'),
    ]);
    if (cl && cl.ok && cl.data && cl.data.ok && cl.data.holidays) setHolidays(cl.data.holidays.rows);
    let out = head('Markets', 'Live prices, and how the wider market did underneath them.', 'The board');
    const pu = p.ok ? p.data : {};
    if (pu && pu.universe) window.__PULSE = pu;
    /* The page opened on a sector heatmap and left the reader to work out the
     * state of the market from it. These are the four numbers that heatmap is
     * an elaboration of. */
    {
      const br = pu.breadth || {}, up = Number(br.up), cnt = Number(br.counted);
      const nifty = (m.ok ? (m.data.markets || []) : []).find(x => /nifty 50/i.test(x.name || ''));
      out += snap([
        nifty && ['Nifty 50', esc(nifty.price ?? '—'), pct(nifty.change_pct) + ' today', dir(nifty.change_pct)],
        Number.isFinite(up) && Number.isFinite(cnt) && cnt
          ? ['Advancing', `${up}<span style="color:var(--dim)">/${cnt}</span>`,
             Math.round(up / cnt * 100) + '% of the screen', up / cnt >= 0.5 ? 'up' : 'dn'] : null,
        Number.isFinite(Number(br.at_52w_high)) ? ['At 52-week high', br.at_52w_high, 'names', 'ac'] : null,
        ['Screened', pu.universe || 1000, 'names re-run daily'],
      ]);
    }

    /* ── THE BAROMETER LEADS THE BOARD ───────────────────────────────────
     * It is the one reading on this page that is ABOUT the page — every
     * number below it is an instrument, and this says what they add up to.
     * Published with every input and weight visible, because a score whose
     * derivation is hidden is a horoscope. */
    {
      const bmVix = (() => {
        if (!tk || !tk.ok) return null;
        for (const seg of (tk.data.segments || [])) {
          const h = (seg.items || []).find(x => /india vix/i.test(x.name || ''));
          if (h) return Number(h.price_raw != null ? h.price_raw : h.price);
        }
        return null;
      })();
      const bmNifty = (() => {
        if (!tk || !tk.ok) return null;
        for (const seg of (tk.data.segments || [])) {
          const h = (seg.items || []).find(x => /nifty 50/i.test(x.name || ''));
          if (h) return h;
        }
        return null;
      })();
      /* ── PREFER THE PUBLISHED SCORE ──────────────────────────────────
       * barometer.py owns the formula now and writes barometer.json daily,
       * because a history recorded by one implementation and displayed by
       * another drifts the first time either is touched — four engines with
       * four target ladders is what that looks like.
       * The client keeps its own barometer() as a FALLBACK for the window
       * before the job first runs, and for a day the feed does not answer.
       * When the file is there, the file wins. */
      const bj = await get('/barometer.json').catch(() => ({ ok: false }));
      const BP = (bj && bj.ok && bj.data && bj.data.ok) ? bj.data : null;
      const B = BP ? (() => {
        const t = BP.today;
        return { score: t.score, band: t.band, counted: t.counted,
                 /* barometer.py ships this; the browser fallback below
                    computes its own. Either way the score must arrive with
                    the share of its own weight that produced it. */
                 coverage: t.coverage || null,
                 parts: (t.parts || []).map(x => ({ ...x, score: Number(x.score) })),
                 acc: t.stage ? { stage: t.stage, hits: [], dd: t.drawdown_pct,
                                  aboveP: t.above_200dma_pct } : null,
                 outcomes: BP.outcomes || null, history: BP.history || [] };
      })() : barometer(bmNifty, pu.breadth || {}, bmVix);
      if (B) {
        out += sec('The barometer', `
          <div class="baro">
            <div class="baro-s ${esc(B.band.c)}">
              ${ringGauge(B.score, B.band.t, B.band.c, 132)}
            </div>
            <div class="baro-p">${(() => {
              /* DERIVED WHEN THE PRODUCER DOES NOT SAY. The payload path
                 reads a committed barometer.json that may predate the
                 `coverage` field; BARO_W is always here, so the page counts
                 the gap itself rather than waiting to be told about it. */
              const cv = B.coverage;
              const have = (B.parts || []).map(x => x.key).filter(Boolean);
              const total = (cv && (cv.partsTotal || cv.parts_total))
                || Object.keys(BARO_W).length;
              const n = cv ? cv.parts : have.length;
              if (!total || n >= total) return '';
              const miss = (cv && cv.missing && cv.missing.length) ? cv.missing
                : Object.keys(BARO_W).filter(k => !have.includes(k));
              const used = (cv && (cv.weightUsed || cv.weight_used))
                || have.reduce((a, k) => a + (Number(BARO_W[k]) || 0), 0);
              const all = Object.values(BARO_W).reduce((a, b) => a + b, 0);
              const pct = all ? Math.round(used / all * 100) : null;
              return `<p class="baro-cov">Built on <b>${n}</b> of <b>${total}</b>
                components${pct != null ? ` — <b>${pct}%</b> of the score's weight` : ''}.
                ${miss.length ? esc(miss.join(' and ')) + ' did not answer, so this'
                  : 'This'} is not comparable with a full reading.</p>`;
            })()}${B.parts.map(pt => `
              <div class="baro-i">
                <span class="baro-k">${esc(pt.label)}<i>${pt.weight}%</i></span>
                ${meter(pt.score, pt.score >= 55 ? 'up' : pt.score <= 30 ? 'dn' : '')}
                <span class="baro-v cnum">${pt.score.toFixed(0)}</span>
                <span class="baro-d">${esc(pt.detail)}</span>
              </div>`).join('')}</div>
          </div>
          ${B.acc ? `<div class="baro-acc acc-${esc(B.acc.stage.k)}">
            <span class="acc-h ${esc(B.acc.stage.c)}">${esc(B.acc.stage.t)}</span>
            <p>${esc(B.acc.stage.say)}</p>
            ${B.acc.hits.length ? `<ul class="acc-l">${B.acc.hits.map(h =>
              `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
          </div>` : ''}
          ${/* ── DOES THIS READING ACTUALLY WORK? ────────────────────────
              * The site scores every signal it publishes and, until now, never
              * scored this. Each day's reading is recorded and what the index
              * did 3, 6 and 12 months later is written beside it.
              * It starts EMPTY and says so, because the breadth this score
              * needs is not published historically — computing past readings
              * from the components that do exist would be a different formula
              * wearing the same name. It fills forward from today. */''}
          ${(() => {
            const o = B.outcomes || {};
            const rows = Object.entries(o).filter(([, r]) => r.readings > 0);
            const anyScored = rows.some(([, r]) => r.m3 || r.m6 || r.m12);
            if (!rows.length) {
              return `<p class="hint" style="margin-top:14px"><b>This reading is being
                scored.</b> Every day's value is recorded, and what the index did three,
                six and twelve months later will be shown here. It starts empty because
                the breadth figure it needs has never been published historically —
                filling it with a back-computed number would be a different measure
                wearing this one's name.</p>`;
            }
            return `<div style="margin-top:16px">
              <div class="sg-head" role="row"><span>When it read</span><span>Times</span>
                <span>3 months</span><span>6 months</span><span>12 months</span></div>
              <div class="rank">${rows.map(([, r]) => {
                const cell = (x) => x ? `<span class="${dir(x.avg)}">${pct(x.avg)}<em> ${
                  x.hit}% up · n${x.n}</em></span>` : '<span class="bo-w">not yet</span>';
                return `<div class="rank-r bo-r">
                  <span><b>${esc(r.label)}</b></span>
                  <span class="mono">${r.readings}</span>
                  ${cell(r.m3)}${cell(r.m6)}${cell(r.m12)}
                </div>`;
              }).join('')}</div>
              <p class="hint">What the index did after each reading, measured forward from
                the day it was made. ${anyScored ? 'Only windows that have actually elapsed are counted.'
                  : 'No window has elapsed yet.'}</p>
            </div>`;
          })()}
          ${foldBody('How this number is made', `
            <p class="hint"><b>What goes into it.</b> Five measures, weighted as shown.
              Where Nifty sits in its own year. How many of ${B.counted} names are above their
              200-day average. How many rose today. India VIX, grouped into bands rather than
              scaled, because 11 and 13 are the same market but 13 and 30 are not. And how many
              names are at a one-year high.</p>
            <p class="hint"><b>Why there are two numbers, not one.</b> They are meant to
              disagree. When conditions look worst is usually when buying pays best — March 2020
              scored badly on every trend measure there is, and was the best entry in a decade.
              One number cannot say both things, so you get both.</p>
            <p class="hint"><b>This has not been backtested.</b> It is a way to read
              conditions, not a signal, and it has no track record. Nothing here claims an edge it
              has not measured. The weights are shown because nothing has earned the right to
              hide them.</p>`)}`,
          `${B.score}/100 · ${esc(B.band.t)}`, null, { lead: true });
      }
    }

    /* The world strip goes FIRST, above breadth. Whether the exchange behind a
     * number is currently trading qualifies every number below it, the same
     * way the freshness badge in the header qualifies the page. */
    out += sec('The trading day', `<div id="wcHost"></div>
      <p class="hint">Local time at each exchange, with regular cash-session hours.
        <b>Holidays are not tracked</b> — on Diwali or Thanksgiving a market will show
        as open here when it is shut.</p>`,
      '', 'Six exchanges, and which of them is awake.');

    out += sec('Breadth', breadthWidget(pu.breadth) || `<div class="empty">Screen not built yet.</div>`,
      '', 'How many names went up, out of every name measured.');
    out += sec(`Sector heat — the week, all ${pu.universe || 1000}`, heatmap(pu.sectors, 'r1w') +
      `<p class="hint">Median move over the <b>past week</b> across the full <b>${pu.universe || 1000}-name</b>
        screen — the wider, slower view. The front page shows today over the largest 250.
        Width is how many names the sector holds; tap one for the names behind it.</p>`
      + heatKey(1.5, 'Sector move'),
      pu.sectors ? `${pu.sectors.length} sectors · one week` : '');

    // /api/ticker, not /api/markets: markets returns a curated NINE, the
    // ticker returns all 71 across eleven segments — Asia, India, Europe, US,
    // commodities, FX (USD/INR, MYR/INR, USD/MYR, AED/INR), crypto. The board
    // was showing a twelfth of what the origin already computes.
    /* Already fetched at the top of the route for the barometer. */
    if (tk.ok) {
      const segs = (tk.data.segments || []).filter(sg => (sg.items || []).length);
      MKDATA = new Map();   // one map per paint; the route repaints every 60s
      /* ELEVEN SEGMENTS, ALL OPEN, IS NOT A BOARD — IT IS A LIST.
       *
       * Forty-six instruments in eleven segments rendered expanded, so a
       * reader who came for crypto scrolled past forty rows of Asia, India,
       * the Nifty movers, Europe, the US, the US top ten, FX and commodities
       * to reach three. On a phone that is the longest block on the site.
       *
       * Each segment is a disclosure now, and the summary carries what the
       * segment header already carried — icon, name, how many instruments,
       * how many of them are trading — plus how many are up, so the closed
       * state still answers "is anything happening in there".
       *
       * INDIA stays open. This is a site about Indian markets and that
       * segment is the reason most readers are on this page; folding it would
       * be tidiness at the cost of the point. The Nifty gainers and losers
       * open with it, because "which names moved" is the question the Indian
       * indices immediately raise. */
      /* ── ONE SEGMENT OPEN, NOT THREE ─────────────────────────────────
       * Measured: this section rendered 2,472px — over three phone screens
       * of a page that is already seven. India, gainers and losers all
       * opened by default, and the gainers and losers are the SAME sixteen
       * Indian names the India segment above them just listed, re-sorted.
       * A reader scrolled past the Nifty constituents three times before
       * reaching Asia.
       * India stays open because this is an Indian market site and it is
       * what the page is for. Every other segment keeps its count in the
       * summary, so the page still says what is behind each one. */
      const OPEN_SEGS = new Set(['india']);
      out += sec('The board',
        segs.map(sg => {
          const up = sg.items.filter(x => x.up).length;
          return `<details class="segd"${OPEN_SEGS.has(sg.key) ? ' open' : ''}>
            <summary class="segh">${esc(sg.icon || '')} ${esc(sg.label)}
              ${segWhen(sg.items)}<span class="cnt">${up}/${sg.items.length} up</span></summary>
            <div class="board">${sg.items.map(mkRow).join('')}</div>
          </details>`;
        }).join('') +
        `<p class="sec-note"><b>Every row opens.</b> The line under each name is the past month of
          real daily closes; the bar beside it is where the price sits between its own 52-week low
          and high ${tip('range52')}${tip('basis')}. Tap a row for the extremes, the day's range, volume, the exchange session ${tip('session')} and
          the exact time the quote was taken. A figure this site cannot measure says
          <b>Not measured</b> — it is never filled in.</p>`,
        `${tk.data.live ?? 0} of ${tk.data.total ?? 0} live`,
        /* COUNTED, NOT SPELLED OUT. The lead read "Forty-six instruments"
         * while the count beside it came from the feed, so the two could
         * disagree the moment a segment was added or a symbol stopped
         * resolving — a hardcoded number in a sentence about live data is a
         * claim with no source. It is the same figure the rail already
         * reports, in words. */
        `${segs.reduce((n, sg) => n + sg.items.length, 0)} instruments across
         ${segs.length} segments, each with the year behind it.`);
    } else { out += sec('The board', fail('The live board', tk.error)); }

    /* ── ONE SECTION, BOTH DIRECTIONS ──────────────────────────────────────
     * These were two sections of eight rows, 798px and 764px, stacked — and
     * they are not two subjects. They are one week's moves, sorted twice, and
     * the second heading ("The other half of the same week") said so.
     * One block, one table, a chip to flip the direction. Half the height and
     * the comparison is now possible rather than being two screens apart. */
    const movers = () => {
      const up = (pu.movers_up || []).slice(0, 8);
      const dn = (pu.movers_dn || []).slice(0, 8);
      if (!up.length && !dn.length) return '';
      return sec('Biggest moves, one week',
        `<div class="chips mv-t" role="group" aria-label="Direction">
           <button type="button" class="chip is-on" data-mv="up">Risers</button>
           <button type="button" class="chip" data-mv="dn">Fallers</button>
         </div>
         <div data-mv-p="up">${levelTable(up)}</div>
         <div data-mv-p="dn" hidden>${levelTable(dn)}</div>`,
        `${up.length} up · ${dn.length} down`,
        'The biggest moves of the week — a day is mostly noise.');
    };
    const before = out;
    paint(out + movers());
    wireWorldClocks();          // starts the one-second tick; teardown clears it
    // Then join the technical columns and repaint those two tables in place.
    // The markup is identical apart from four cells, so nothing moves.
    // Repainting drops the clock strip's timer with the DOM, so it is restarted
    // alongside every repaint of this route rather than only the first.
    fillLevels(() => {
      if (routeOf() !== '/markets') return;
      paint(before + movers());
      wireWorldClocks();
    });
  };

  /* (V1 handler removed at the Signal V2 cutover; see the V2 block below.) */

  R['/ipo'] = async () => {
    paint(head('IPO', 'Books open now, what is coming, and how the last year of listings actually did.', 'Primary market') +
      sec('Open now', skel('sk-card', 2)), true);
    /* THE BOOK AS IT STANDS, WITH THE MIRROR AS A FALLBACK.
     * ipo.json is a daily build; an IPO book moves fastest on its last day.
     * On 31 August the mirror showed ESDS at 1.54x while NSE's live book had
     * it at 19.6x. The live figure wins where NSE answers, and each card says
     * which of the two it is showing. */
    /* THE LIVE BOOK ARRIVES AFTER THE PAGE, NOT BEFORE IT.
     *
     * /api/ipo-live asks NSE for the current issue list and then one detail
     * call per issue for the category split — measured at 5.0s on a cold edge
     * cache and 0.13s warm. Awaiting it here made the first visitor of every
     * fifteen-minute window wait five seconds for a page whose mirrored copy
     * was already in hand.
     *
     * So the cards render from the mirror and are PATCHED in place when the
     * live figures land. Patched, not re-rendered: re-entering a route when a
     * deferred fetch resolves is what put the front page into an infinite
     * repaint loop, and a targeted DOM update cannot loop. */
    const io = await get('/ipo.json');
    IPO_STAMP = io.ok ? String(feedStamp(io.data) || '').slice(0, 16).replace('T', ' ') : '';
    IPO_AGE_H = io.ok ? ageHours(feedStamp(io.data)) : null;
    if (io.ok) noteFresh('IPO book', feedStamp(io.data));
    let out = head('IPO', 'Books open now, what is coming, and how the last year of listings actually did.', 'Primary market');
    if (!io.ok) { paint(out + fail('The IPO radar', io.error)); return; }
    const d = io.data, c = d.counts || {};

    /* THE CALL RANKS THE PAGE.
     *
     * Ten books were listed in feed order under one heading, every one of them
     * a full card — so comparing ten verdicts meant reading ten cards. The
     * verdict is the only thing on an IPO card that changes what somebody
     * does next, so it sorts the section and it names the headings.
     *
     * Nothing is hidden and no card is trimmed: the books that were not rated
     * apply sit in a disclosure directly underneath, which says how many it
     * holds and opens on a tap. fillIpoLive() patches by document query, so a
     * card inside a closed panel still gets its live subscription figure. */
    const dOpen = ipoOpenNow(d.open);
    const vRank = r => { const v = String(r.verdict || '').toUpperCase();
      return v.startsWith('APPLY') ? 0 : v === 'AVOID' ? 2 : 1; };
    const ordered = dOpen.slice().sort((a, b) =>
      vRank(a) - vRank(b) || (Number(b.subscription_x) || 0) - (Number(a.subscription_x) || 0));
    const applyBooks = ordered.filter(r => vRank(r) === 0);
    const otherBooks = ordered.filter(r => vRank(r) !== 0);

    out += sec('Where it stands', `<div class="grid">
        ${tile(c.apply ?? applyBooks.length, 'Rated apply', 'on public demand and pricing',
               (c.apply ?? applyBooks.length) ? 'up' : '')}
        ${tile(dOpen.length, 'Books open', 'bidding today', dOpen.length ? 'ac' : '')}
        ${tile((d.upcoming || []).length, 'Upcoming', 'announced, not open')}
        ${tile((d.awaiting_listing || []).length, 'Awaiting listing', 'closed, not yet traded')}
      </div>`, '', dOpen.length
        ? `${applyBooks.length || 'None'} of ${dOpen.length} open book${dOpen.length === 1 ? '' : 's'} ${
            applyBooks.length === 1 ? 'is' : 'are'} rated apply.`
        : 'No mainboard book is open today.');

    out += sec('Worth applying', applyBooks.length
      ? `<div class="${applyBooks.length > 1 ? 'cards-2' : ''}">${applyBooks.map(ipoCard).join('')}</div>` + ipoStaleNote()
      : dOpen.length
        ? `<div class="empty">Nothing open today clears the bar. That is a result, not a gap —
             an issue is rated on demand and on what it is priced against, and neither becomes
             negotiable because a book happens to be open.</div>`
        : `<div class="empty">No mainboard book is open today.</div>`,
      dOpen.length ? `${applyBooks.length} of ${dOpen.length} open` : '');

    if (otherBooks.length) out += sec('Open, not recommended',
      `<details class="meth ipo-rest"><summary>${otherBooks.length} other book${
        otherBooks.length === 1 ? '' : 's'} bidding today — the full card on each</summary>
        <div class="cards-2">${otherBooks.map(ipoCard).join('')}</div></details>`,
      `${otherBooks.length}`);

    /* NSE'S LIST IS LONGER THAN THE MIRROR'S.
     *
     * The daily build carries the issues it could enrich — band, lot, GMP,
     * financials, a verdict. NSE was showing six active books this afternoon
     * and the mirror had four, so two open issues were simply absent from a
     * page headed "Open now". Absent is worse than thin: a reader cannot tell
     * the difference between "not open" and "we did not cover it".
     *
     * Filled after paint by fillIpoLive() from the live list, with only what
     * NSE gives — symbol, close date, subscription. No verdict, because none
     * was computed for them, and inventing one to make the row look complete
     * is the thing this site refuses. */
    out += `<div id="ipoExtra"></div>`;

    /* The note goes wherever ipoCard goes. Moving the timestamp off the cards
       and into one note only works if every block that renders a card also
       renders the note — this block did not, so its cards said "Morning
       build" with the actual morning surviving in a title attribute nobody
       on a phone can hover. */
    if ((d.upcoming || []).length) out += sec('Upcoming', `<div class="cards-2">${d.upcoming.map(ipoCard).join('')}</div>` + ipoStaleNote());
    if ((d.awaiting_listing || []).length)
      /* 1,238px of cards for issues nobody can act on — the book has closed
         and the shares are not trading. Real information, and the least
         urgent on the page: the count stays in the heading, the cards open on
         request. */
      out += sec('Awaiting listing', foldBody(
        `Open ${d.awaiting_listing.length} issue${d.awaiting_listing.length === 1 ? '' : 's'} — closed, not yet trading`,
        `<div class="cards-2">${d.awaiting_listing.map(ipoCard).join('')}</div>`),
        `${d.awaiting_listing.length}`);

    /* ── THE LISTINGS TABLE, WITH ITS LABELS ─────────────────────────────
     *
     * It read `r.listed_on` and `r.sym`. NEITHER FIELD EXISTS — the feed
     * publishes `listing_date` and `symbol` — so every row on this table has
     * rendered the words "listed —" since it shipped, and the em dash was the
     * fallback doing its job on a field name that was never there.
     *
     * It also had no header row at all: six columns of numbers with nothing
     * naming any of them. The labels are here now and they are sticky, so
     * they survive the scroll down twenty-four rows. */
    /* NEWEST FIRST, NOT BEST FIRST.
     * This sorted by since_listing_pct, so the table opened on a listing from
     * September 2024 and the most recent IPO — the one a reader is actually
     * deciding about — was twenty rows down. A table of listings is a
     * chronology; performance is a way to READ it, which is what the sort
     * control below is for. */
    const rec = (d.recent_listed || []).slice().sort((a, b) =>
      String(b.listing_date || '').localeCompare(String(a.listing_date || '')));
    /* THE ROW SHOWS EIGHT COLUMNS AND STILL COULD NOT ANSWER THE QUESTION.
     * "How did it list?" needs the issue price beside the first close, and the
     * table never carried the band and the listing price in a form you could
     * subtract. That is the whole reason to expand a row rather than add a
     * ninth column nobody can read on a phone. */
    /* THE BAND ARRIVES AS PROSE, NOT AS NUMBERS.
     * `recent_listed` rows carry price_band as "Rs.66 to Rs.70" and have no
     * price_low/price_high — those two fields exist only on the open and
     * upcoming rows. Reading Number(r.price_high) off a listed row gives NaN,
     * so the first version of this panel told every reader the issue price
     * "could not be read" on all sixty rows. The top of the band is what an
     * applicant at cut-off actually pays, so that is the number taken. */
    const bandTop = (s) => {
      const nums = String(s || '').match(/\d+(?:\.\d+)?/g);
      if (!nums || !nums.length) return null;
      const v = Math.max(...nums.map(Number));
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const ipoDetail = (r) => {
      // recent_listed carries NO price_high — that field exists only on the
      // open and upcoming rows. Reading it here was a dead branch hidden behind
      // an `||`, which is how the first version of this panel came to tell all
      // sixty rows that the issue price "could not be read". The band is the
      // only source a listed row has, so it is the only one consulted.
      const issue = bandTop(r.price_band);
      const first = Number(r.first_close);
      const pop = Number.isFinite(issue) && Number.isFinite(first) && issue
        ? (first - issue) / issue * 100 : null;
      /* NO "MOVE AFTER LISTING" ROW.
       * It was here and it was `(last - first) / first`, which is precisely
       * what since_listing_pct already is — the panel printed +225.20% and
       * +225.22% one under the other for the same fact. What the table cannot
       * already tell you is the LISTING GAIN, issue price against first close,
       * and the total from the applicant's own cost. */
      const total = Number.isFinite(issue) && issue && r.last_close != null
        ? (Number(r.last_close) - issue) / issue * 100 : null;
      const line = (l, v, cls) => v == null || v === '' ? '' :
        `<div class="yy"><span>${esc(l)}</span><b class="${cls || ''}">${v}</b></div>`;
      return `<div class="yoy">
          ${line('Issue price (band top)', Number.isFinite(issue) ? price(issue) : null)}
          ${line('Listed at', r.first_close != null ? price(r.first_close) : null)}
          ${line('Listing gain', pop == null ? null : pct(pop), dir(pop))}
          ${line('Since listing', r.since_listing_pct == null ? null : pct(r.since_listing_pct), dir(r.since_listing_pct))}
          ${line('Total from issue price', total == null ? null : pct(total), dir(total))}
          ${line('Issue closed', String(r.close_date || '').slice(0, 10) || null)}
          ${line('Sessions measured', r.sessions != null ? r.sessions : null)}
          ${/* MOVED IN FROM THE ROW. On a phone the row rendered every column
              * as a self-labelling chip, which is why a listing row was 224px
              * tall — three and a half times the signals row and seven of them
              * to a screen. The chips are collapsed on mobile now, so the four
              * facts that lived only there have to live here or they are lost:
              * the band, the last price, the range since, and how far off its
              * own high it is. */''}
          ${line('Price band', r.price_band ? String(r.price_band).replace(/Rs\./g, '₹') : null)}
          ${line('Last', r.last_close != null ? price(r.last_close) : null)}
          ${line('Range since listing', r.low != null && r.high != null
            ? `${price(r.low)} – ${price(r.high)}` : null)}
          ${line('Off its high since', r.from_high_pct != null ? pct(r.from_high_pct) : null,
                 dir(r.from_high_pct))}
        </div>
        <p class="hint">${pop == null
          ? 'No price band was published for this listing, so no listing gain is shown rather than a guessed one.'
          : `Listed <b>${pct(pop)}</b> against the top of its band, and is
             <b>${total == null ? '—' : pct(total)}</b> from that issue price today.
             An applicant who got an allotment and held has the second number;
             the table's "since listing" measures from the first close instead,
             which is what a buyer on day one has.`}
        </p>`;
    };
    const ipoRow = (r, i) => xrow(`
      <span class="i">${i + 1}</span>
      <span class="s"><b>${esc(r.symbol || '')}</b><span>${esc(r.company || '')}</span>${
        symLinks(r.symbol)}</span>
      <span class="x" data-l="Listed">${esc(String(r.listing_date || '').slice(0, 10) || '—')}</span>
      <span class="x" data-l="Price band">${esc(r.price_band || '—')}</span>
      <span class="x" data-l="Listed at">${r.first_close != null ? price(r.first_close) : '—'}</span>
      <span class="x" data-l="Last">${r.last_close != null ? price(r.last_close) : '—'}</span>
      <span class="x" data-l="Range since">${r.low != null && r.high != null
        ? price(r.low) + '–' + price(r.high) : '—'}</span>
      ${(() => { const o = offHigh(r.from_high_pct); return `<span class="x ${
        o ? o.cls : ''}" data-l="Off high">${o ? esc(o.txt) : '—'}</span>`; })()}
      <span class="m ${dir(r.since_listing_pct)}" data-l="Since listing">${
        pct(r.since_listing_pct)}</span>`,
      ipoDetail(r),
      { cls: 'lvl-r ipo-lr',
        // The up/below-issue chips filter on this. Dropping it when the row
        // became expandable silently broke both chips — the rows stayed put
        // and nothing errored.
        // data-ld / data-mv are what the sort and period controls read; they
        // are on the row so neither has to re-render the table.
        attrs: `data-since="${Number(r.since_listing_pct) >= 0 ? 'up' : 'dn'}"`
             + ` data-ld="${esc(String(r.listing_date || ''))}"`
             + ` data-mv="${Number(r.since_listing_pct) || 0}"`
             // data-rank is the row's place in the CURRENT order, rewritten by
             // the sort. The default view shows the first IPO_SHOW of them.
             + ` data-rank="${i}"` });
    /* NINE CELLS, AND THE ROW BELOW IT HAS NINE TOO — so both need nine
     * tracks. `.rank-r.lvl-r` declares eight, so "Since listing" wrapped onto
     * a second grid line and sized itself to track one: a 24px box under the
     * rank number, in the header AND in every row. Measured on the live page,
     * the header label sat at x=130 in 24px while its column heading was at
     * x=1230 — the last column of this table has been unreadable since the
     * "Range since" column was added. `.ipo-lr` now carries the count, and it
     * is on the header as well as the rows so the two cannot drift. */
    const ipoHead = `<div class="rank-r lvl-r ipo-lr rank-head">
      <span class="i">#</span><span class="s">Company</span>
      <span class="x">Listed</span><span class="x">Price band</span>
      <span class="x">Listed at</span><span class="x">Last</span>
      <span class="x">Range since</span>
      <span class="x">Off high</span><span class="m">Since listing</span></div>`;
    const up = rec.filter(r => Number(r.since_listing_pct) >= 0).length;
    out += sec('How recent listings have done', rec.length
      ? foldBody(`Open the table — ${rec.length} listings, filterable and sortable`,
        `<div class="chips" id="ipoflt">
           <button type="button" class="chip" data-f="all" aria-pressed="true">All ${rec.length}</button>
           <button type="button" class="chip" data-f="up" aria-pressed="false">Above issue ${up}</button>
           <button type="button" class="chip" data-f="dn" aria-pressed="false">Below issue ${rec.length - up}</button>
         </div>
         <div class="sgf-bar" id="iposort">
           <label class="sgf"><span>Sort</span>
             <select data-ipos="order" aria-label="Sort listings">
               <option value="new">Newest listed</option>
               <option value="old">Oldest listed</option>
               <option value="best">Best since listing</option>
               <option value="worst">Worst since listing</option>
             </select></label>
           <label class="sgf"><span>Listed within</span>
             <select data-ipos="within" aria-label="Filter by how recently it listed">
               <option value="all">Any time</option>
               <option value="90">3 months</option>
               <option value="180">6 months</option>
               <option value="365">1 year</option>
             </select></label>
         </div>
         ${/* NOT capList HERE, AND THE REASON IS WORTH KEEPING.
              * Capping this table looked identical to capping the others and
              * would have broken it: applySort() re-orders by calling
              * tbl.appendChild(row) on every row it finds, and appendChild
              * MOVES a node. The first sort would have lifted all forty-eight
              * hidden rows out of capList's wrapper, revealed them, and left
              * the "show the other 48" button pointing at an empty div.
              * The whole section folds instead — controls and all — so the
              * sort still owns a flat table when it is open. */''}
         <div class="rank" id="ipotbl">${ipoHead}${rec.map(ipoRow).join('')}</div>
         ${/* ── TWENTY-FIVE SCREENS IS NOT A PAGE ────────────────────────────
             * Measured on a 375x812 phone: /ipo was 20,780px, 25.6 screens.
             * Sixty listing rows is the whole of it. The rows STAY in the DOM
             * — sort and both filters read them, and slicing the array would
             * mean sorting a subset and calling it the table — but the default
             * view shows the first fifteen. A reader who wants the other
             * forty-five asks for them, which is one tap against twenty-five
             * screens of scrolling for everyone who does not. */''}
         ${rec.length > IPO_SHOW ? `<button type="button" class="chip ipo-more" data-ipo-more>
            Show all ${rec.length} listings</button>` : ''}
         ${(() => {
           /* THE TABLE CALLED ITSELF "RECENT" AND WAS NOT.
            * recent_listed runs 2024-09-16 to 2025-08-14 — its newest row was
            * 390 days old on the day this was checked — while the same file's
            * own counts claim listed_12m: 166 and listed_measured: 157. So the
            * upstream build knows about far more listings than it carries, and
            * every one it carries predates the last year entirely. That is a
            * gap in the feed, not something this page can compute its way out
            * of; the only honest thing it can do is say so on the table. */
           const ds = rec.map(r => String(r.listing_date || '')).filter(Boolean).sort();
           if (!ds.length) return '';
           const newest = ds[ds.length - 1];
           const ageD = Math.round((Date.now() - Date.parse(newest + 'T00:00:00Z')) / 86400000);
           const claimed = Number(c.listed_12m);
           return ageD > 60 || (Number.isFinite(claimed) && claimed > rec.length)
             ? `<div class="note"><b>This table is not current, and it is labelled that way
                  deliberately.</b> It carries <b>${rec.length}</b> listings from
                  <b>${esc(ds[0])}</b> to <b>${esc(newest)}</b> — the newest is
                  <b>${ageD} days</b> old.${Number.isFinite(claimed) && claimed > rec.length
                    ? ` The feed's own counter says <b>${claimed}</b> mainboard listings in the
                       last twelve months, so ${claimed - rec.length} of them are missing from
                       what it hands this site.` : ''}
                  The rows below are real and measured; the window they cover is stale, and
                  filtering to a recent period will correctly return nothing.</div>`
             : '';
         })()}
         <p class="hint">Mainboard listings, newest first.
           <b>Price band</b> is what the book was offered at. <b>Listed at</b> is the first
           traded close, not the issue price — NSE's issue-price data is not reliable and a
           listing gain computed off a guessed one is fabricated, so this site measures from
           the first price the market actually set. <b>Range since</b> is the high and low it
           has traded between since. A book that never traded above its band is the case this
           table exists to make visible.</p>`)
      : `<div class="empty">No listings in the window.</div>`,
      `${rec.length} listings`);
    paint(out);

    /* Filtering by attribute rather than re-rendering: the rows are already in
     * the DOM and re-running the map would drop the live figures fillIpoLive
     * writes into them a moment later. */
      let ipoShowAll = false;
    /* SORT AND PERIOD, BY MOVING NODES RATHER THAN REBUILDING THE TABLE.
     * Each row is followed by its own expanded panel as a SIBLING, so a sort
     * that moved only the rows would leave every panel behind and attach each
     * one to whichever row happened to land above it. The pair moves together
     * or not at all. */
    const sortBar = main.querySelector('#iposort');
    const tbl = main.querySelector('#ipotbl');
    /* Declared at the route's scope, not inside the guard: the chip handler and
     * the show-all button below both call it, and a function defined inside an
     * `if` is not in scope for either. */
    const applySort = () => {
      if (!sortBar || !tbl) return;
      {
        const order = sortBar.querySelector('[data-ipos="order"]').value;
        const within = sortBar.querySelector('[data-ipos="within"]').value;
        const rows = [...tbl.querySelectorAll('.rank-r[data-ld]')];
        const key = (el) => ({
          new:   () => String(el.dataset.ld || ''),
          old:   () => String(el.dataset.ld || ''),
          best:  () => Number(el.dataset.mv) || 0,
          worst: () => Number(el.dataset.mv) || 0,
        })[order]();
        const desc = order === 'new' || order === 'best';
        rows.sort((a, b) => {
          const ka = key(a), kb = key(b);
          const c = typeof ka === 'string' ? ka.localeCompare(kb) : ka - kb;
          return desc ? -c : c;
        });
        for (const row of rows) {
          const panel = row.nextElementSibling &&
            row.nextElementSibling.classList.contains('xd') ? row.nextElementSibling : null;
          tbl.appendChild(row);
          if (panel) tbl.appendChild(panel);
        }
        // The period filter is a second, independent axis; it hides rather
        // than removes so the up/below-issue chips keep working over it.
        const cut = within === 'all' ? null
          : new Date(Date.now() - Number(within) * 86400000).toISOString().slice(0, 10);
        /* ── ONE PLACE DECIDES VISIBILITY ─────────────────────────────────
         * Three independent axes now — the up/below-issue chips, the period
         * select, and the fifteen-row cap. Each was written to set row.hidden
         * itself, and three writers of one property is how "Above issue"
         * silently brought back rows the period filter had removed. They are
         * predicates here; exactly one line assigns. */
        let shownRank = 0;
        for (const row of rows) {
          const tooOld = cut != null && String(row.dataset.ld || '') < cut;
          row.dataset.period = tooOld ? 'out' : 'in';
          const on = flt && flt.querySelector('.chip[aria-pressed="true"]');
          const f = on ? on.dataset.f : 'all';
          const wrongSide = f !== 'all' && row.dataset.since !== f;
          const passes = !tooOld && !wrongSide;
          // The cap counts only rows that already passed the filters, so
          // "show 15" means fifteen VISIBLE rows rather than fifteen minus
          // however many the filters happened to remove.
          const capped = passes && !ipoShowAll && shownRank >= IPO_SHOW;
          if (passes && !capped) shownRank++;
          row.hidden = !passes || capped;
          if (row.hidden) {
            const panel = row.nextElementSibling;
            if (panel && panel.classList.contains('xd')) {
              panel.hidden = true;
              row.setAttribute('aria-expanded', 'false');
              row.classList.remove('is-open');
            }
          }
        }
        const moreBtn = main.querySelector('[data-ipo-more]');
        if (moreBtn) {
          const hiddenByCap = rows.filter(r => r.hidden && r.dataset.period !== 'out').length;
          moreBtn.hidden = ipoShowAll || hiddenByCap === 0;
          moreBtn.textContent = `Show all ${shownRank + hiddenByCap} listings`;
        }
        const shown = rows.filter(r => !r.hidden).length;
        const n = main.querySelector('#ipotbl');
        if (n) n.setAttribute('aria-label', `${shown} listings shown`);
        /* A TABLE THAT GOES BLANK LOOKS BROKEN.
         * "Listed within 3 months" legitimately matches nothing here, because
         * the newest row in the feed is over a year old — so the empty result
         * has to say which of those two it is. */
        let msg = tbl.querySelector('.ipo-none');
        if (!shown) {
          if (!msg) {
            msg = document.createElement('div');
            msg.className = 'empty ipo-none';
            tbl.appendChild(msg);
          }
          const newest = rows.map(r => r.dataset.ld).filter(Boolean).sort().pop();
          msg.innerHTML = within === 'all'
            ? 'No listing matches that filter.'
            : `<b>Nothing listed in that window.</b> The newest listing this feed carries is
               <b>${esc(newest || '—')}</b>, so a ${within}-day window is empty — the filter
               is working; the data behind it stops there.`;
          msg.hidden = false;
        } else if (msg) { msg.hidden = true; }
      }
    };
    if (sortBar) sortBar.addEventListener('change', applySort);

    const flt = main.querySelector('#ipoflt');
    if (flt) flt.addEventListener('click', e => {
      const b = e.target.closest('.chip[data-f]');
      if (!b) return;
      flt.querySelectorAll('.chip').forEach(c =>
        c.setAttribute('aria-pressed', String(c === b)));
      // Visibility is decided in ONE place; this only records the choice.
      applySort();
    });
    const moreBtn = main.querySelector('[data-ipo-more]');
    if (moreBtn) moreBtn.addEventListener('click', () => { ipoShowAll = true; applySort(); });
    applySort();
    fillIpoLive();   // upgrades the mirrored figures in place, after paint
  };

  // The tool. Filters run over the pulse digest, not over screen.json — the
  // answers are already computed, so a chip is a re-render and not a download.
  /* THE SCREEN — all 750 names, not the digest.
   *
   * The digest answers four fixed questions in 23 KB. A screener has to answer
   * the reader's question, which means the whole file: screen.json, 1.26 MB
   * raw and ~260 KB over the wire. It is fetched ONLY when this route opens
   * and cached for the session, so every other route still costs nothing —
   * which is the whole reason the digest exists and why both can coexist.
   */
  let SCREEN = null;
  /* The payload's META, not its rows. screen.json ships weights, changes and
     the core/extension split and NOTHING rendered any of them — the page could
     not say how its own composite is weighted, what moved since the last
     build, or that 250 of its names are not index constituents. Captured
     wherever the screen is fetched so any route can read it. */
  let SCREEN_META = {};
  const noteScreenMeta = (d) => {
    if (!d || typeof d !== 'object') return d;
    for (const k of ['weights', 'changes', 'universe', 'universe_size',
                     'universe_core', 'universe_ext', 'built_on']) {
      if (d[k] !== undefined) SCREEN_META[k] = d[k];
    }
    /* The screen is a NIGHTLY file and the ledger is live, so a route reading
       both is reading two different moments. price_date is the close the
       table was built on, which is the figure a reader is actually comparing
       a live quote against. */
    noteFresh('Screen', d.price_date || d.built_on || null);
    return d;
  };
  /* ── WHICH TABLE IS IN THE CACHE ─────────────────────────────────────────
   *
   * The screen table ships in two projections. screen-lite.json is what nine
   * routes read: the same rows with 29 fields the frontend never touches
   * removed, and the per-company PROSE — risk.flags, vd.f — moved to the
   * detail payload. 298 KB gzipped becomes 206 KB, on every route that lists
   * companies rather than examining one.
   *
   * SCREEN is a module-level cache shared by all of them, so without this flag
   * the first light route to load would poison the two routes that need the
   * prose: /screen and /stock/:id both open with `if (!SCREEN)`, would find a
   * populated cache, and would render a company page with its risk flags
   * silently absent. Not an error — an empty section, on the page whose entire
   * job is to explain one company.
   *
   * So the two full-payload routes ask `!SCREEN || SCREEN_LITE` and re-fetch
   * over the top. A reader who lands on Home and taps into a company pays for
   * the full table once, at the moment it is actually needed; a reader who
   * never opens one never pays for it at all. */
  let SCREEN_LITE = false;
  /* Set by the light routes' fetch so their setScreen() cannot claim `lite`
     when the fallback served the full table. */
  let LITE_GOT = true;
  const LITE_URL = '/screen-lite.json', FULL_URL = '/screen.json';
  /* ── AND IF THE LITE TABLE IS NOT THERE, USE THE FULL ONE ────────────────
   *
   * screen-lite.json is produced by the newspaper build and arrives here by
   * sync. Those are two pipelines with two clocks, so there is a window —
   * measured, on the deploy that shipped this — where the code asking for it
   * is live and the file is not. On that deploy /radar fetched a 404 and
   * rendered ZERO names, and the live UI check caught it.
   *
   * A missing projection is not a missing answer: the full table has every
   * field the lite one does. Falling back costs ~100 KB and produces a correct
   * page; not falling back produces an empty one. That is the same trade this
   * site makes everywhere else — stale, or slower, is a state to handle; gone
   * is not.
   *
   * It is deliberately NOT silent about which it got: `lite` comes back false
   * on the fallback path, so the two routes that need the prose do not then
   * re-fetch a table they already hold in full. */
  const getScreen = async (wantFull) => {
    if (wantFull) return { r: await get(FULL_URL), lite: false };
    const r = await get(LITE_URL);
    if (r.ok) return { r, lite: true };
    return { r: await get(FULL_URL), lite: false };
  };
  /* The index is derived from SCREEN and must be dropped whenever SCREEN is,
   * or it goes on answering from the projection that has been replaced. */
  const setScreen = (rows, lite) => {
    SCREEN = rows; SCREEN_LITE = !!lite; window.__SCRIDX = null;
  };
  /* FILTERS COMBINE. They used to be radio buttons wearing the shape of
   * chips: picking "Debt-free" threw away "Breaking out", so the one question
   * a screen exists to answer — which names clear SEVERAL bars at once — was
   * the one question it could not be asked. scrPresets is a Set and the
   * predicates are ANDed. Empty means everything, which is what "All" now
   * does rather than being a filter that happens to return true. */
  let scrQ = '', scrPresets = new Set(), scrSort = 'comp', scrPage = 0, SCRDIV = null;
  /* Every screen sort was hardcoded descending, which is right for a rank and
     wrong for a column: cheapest-first and worst-performer-first are the
     questions a reader actually clicks a heading to ask. */
  let scrDir = 'desc';

  /* ── A FILTERED SCREEN IS A PLACE, AND A PLACE NEEDS AN ADDRESS ───────────
   *
   * All of the state above lived only in these variables, so a reader who had
   * narrowed 750 names down to nine could not send anyone the result, could
   * not bookmark it, and lost it on reload. The screen's whole value is the
   * filtering, and none of it survived the tab being closed.
   *
   * It goes in the query string, which is the part of a URL that is FOR this:
   *   /screen?q=bank&p=debt-free,breaking-out&s=roce&fii=accumulating&pg=2
   *
   * replaceState, not pushState: typing in a search box should not fill the
   * back button with a history entry per keystroke. The back button still
   * leaves the route, which is what a reader means by "back" here.
   *
   * Reading is deliberately forgiving — an unknown preset or sort key is
   * dropped rather than throwing, because a hand-edited or truncated link
   * should degrade to a wider view, never to a broken page. */
  const SCR_STATE = {
    read() {
      const q = new URLSearchParams(location.search);
      scrQ = (q.get('q') || '').slice(0, 80);
      scrSort = SORTS[q.get('s')] ? q.get('s') : 'comp';
      scrPresets = new Set((q.get('p') || '').split(',')
        .filter(k => k && PRESETS[k]));
      const pg = parseInt(q.get('pg') || '0', 10);
      scrPage = Number.isFinite(pg) && pg > 0 ? pg : 0;
      const chip = q.get('fii') || '';
      instiChip = INSTI_CHIPS[chip] ? chip : '';
      const pre = q.get('fiip') || '';
      instiPreset = INSTI_PRESETS[pre] ? pre : '';
      const tr = parseInt(q.get('streak') || '0', 10);
      instiTrend = Number.isFinite(tr) && tr > 0 ? Math.min(tr, 12) : 0;
    },
    write() {
      const q = new URLSearchParams();
      if (scrQ) q.set('q', scrQ);
      if (scrPresets.size) q.set('p', [...scrPresets].join(','));
      if (scrSort && scrSort !== 'comp') q.set('s', scrSort);
      if (scrPage) q.set('pg', String(scrPage));
      if (instiChip) q.set('fii', instiChip);
      if (instiPreset) q.set('fiip', instiPreset);
      if (instiTrend) q.set('streak', String(instiTrend));
      const s = q.toString();
      const url = location.pathname + (s ? '?' + s : '');
      if (url !== location.pathname + location.search) history.replaceState({}, '', url);
    },
  };

  /* ── INSTITUTIONAL MOVEMENT ────────────────────────────────────────────────
   *
   * Who is buying a company is a different question from whether its chart is
   * breaking out, and it is the one question on this screen that cannot be
   * derived from price. It comes from the shareholding pattern every listed
   * company files with the exchange each quarter — FII against DII, in
   * percentage points, quarter on quarter.
   *
   * NOTHING IS COMPUTED HERE. institutional.json arrives with the changes,
   * streaks, classification and score already worked out by
   * scripts/institutional/ — a browser must never be asked to reconstruct a
   * trend from 22 quarters of filings, and more importantly the rule that
   * makes the arithmetic honest (subtract ADJACENT quarters only, never span a
   * gap) has to live in one place with tests around it. This file reads
   * fields; it does not derive them.
   *
   * THREE THINGS IT HAS TO ANSWER, in this order:
   *   1. are institutions buying or selling
   *   2. is the move big enough to matter        (0.25 pp is the gate)
   *   3. is it one quarter or an established trend
   *
   * PERCENTAGE POINTS, ALWAYS. FII 10% → 12% is +2.00 pp. It is never +20%,
   * and every label on screen says "pp" so the two can never be read as one.  */

  let RADAR_BREADTH = null, RADAR_NODES = null, RADAR_CORE = null;
  let RADAR_LIVE = null, SCREEN_DATE = null;
  const RADAR_SERIES = {};   // sym -> closes, filled after paint
  let INSTI = null;                    // sym → the precomputed row
  let INSTI_META = null;               // coverage and period, for the footnote
  let instiChip = '';                  // one of INSTI_CHIPS, or none
  let instiPreset = '';                // one of INSTI_PRESETS, or none
  let instiTrend = 0;                  // minimum streak length, 0 = off
  let instiAdvOpen = false;
  const instiAdv = { fiiMin: '', fiiMax: '', diiMin: '', diiMax: '', holdMin: '', holdMax: '' };

  const TH_PP = 0.25;                  // materiality gate, mirrors compute.mjs
  const instiOf = sym => (INSTI && INSTI[sym]) || null;

  /* Loaded once, alongside the screen. Its own request rather than a field on
   * screen.json because it refreshes on a QUARTERLY cadence while the screen
   * refreshes daily: bundling them would push a 1.4 MB rebuild through the
   * pipeline every time a company filed, and would drop institutional data
   * entirely on any day the screen build failed. */
  async function loadInsti() {
    if (INSTI) return INSTI;
    const r = await get('/institutional.json');
    if (!r.ok) { INSTI = {}; INSTI_META = null; return INSTI; }
    INSTI = r.data.rows || {};
    INSTI_META = r.data;
    return INSTI;
  }

  /* Signed, two decimals, with the unit attached. A change of exactly zero
   * prints "0.00 pp" rather than "+0.00 pp" — a plus sign on nothing reads as
   * a rounded-down increase. */
  const ppFmt = v => v == null ? '—'
    : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} pp`;
  /* The same number at badge precision. Shares ppFmt's sign so a row and its
   * own tooltip cannot show a typographic minus in one and a hyphen in the
   * other for the identical figure. */
  const sign1 = v => v == null ? '—'
    : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;

  /* THE GLYPH CARRIES THE MEANING, NOT THE COLOUR. Every institutional state
   * is legible in greyscale, in a screenshot, and to anyone who does not
   * distinguish red from green — which on a screen whose whole claim is
   * "accumulation" versus "distribution" is not an accessibility nicety, it is
   * whether the row is readable at all. Colour repeats the glyph; it never
   * replaces it. */
  const INSTI_LOOK = {
    strong_accumulation: ['▲▲', 'up',   'Strong accumulation',  'Both FII and DII added'],
    fii_accumulation:    ['▲',  'up',   'FII accumulation',     'Foreign institutions added, domestic flat'],
    dii_accumulation:    ['▲',  'up',   'DII accumulation',     'Domestic institutions added, foreign flat'],
    rotation:            ['⇄',  'warn', 'Rotation',             'One side bought what the other sold'],
    fii_reduction:       ['▼',  'dn',   'FII reducing',         'Foreign institutions cut, domestic flat'],
    dii_reduction:       ['▼',  'dn',   'DII reducing',         'Domestic institutions cut, foreign flat'],
    distribution:        ['▼▼', 'dn',   'Distribution',         'Both FII and DII cut'],
    neutral:             ['·',  'flat', 'No material change',   `Neither side moved more than ${TH_PP} pp`],
    unknown:             ['?',  'flat', 'Not measurable',       'No comparable previous quarter'],
  };

  /* The five quick filters. Each is a predicate over the PRECOMPUTED fields —
   * no arithmetic, so a filter can never disagree with the badge beside it. */
  const INSTI_CHIPS = {
    fii_acc:  ['FII accumulating',  x => x.fii_pp != null && x.fii_pp >= TH_PP],
    dii_acc:  ['DII accumulating',  x => x.dii_pp != null && x.dii_pp >= TH_PP],
    both_acc: ['Both accumulating', x => x.signal === 'strong_accumulation'],
    dist:     ['Distribution',      x => x.signal === 'distribution'],
    rot:      ['Rotation',          x => x.signal === 'rotation'],
  };

  /* Saved screens. Each states its own rule in the interface, because a preset
   * whose logic is hidden is a recommendation wearing a filter's clothes.
   *
   * There is deliberately no fourth "exit warning" preset: FII down AND DII
   * down IS the Distribution chip above, and shipping the same query twice
   * under two names would make the screen look richer than it is. */
  const INSTI_PRESETS = {
    smart:      ['Smart money accumulation', 'FII ≥ +0.50 pp and DII ≥ +0.25 pp',
                 x => x.fii_pp != null && x.dii_pp != null && x.fii_pp >= 0.5 && x.dii_pp >= TH_PP],
    conviction: ['Strong FII conviction', 'FII up 2+ quarters running, and ≥ +0.50 pp this quarter',
                 x => x.fii_streak >= 2 && x.fii_pp != null && x.fii_pp >= 0.5],
    turnaround: ['Institutional turnaround', 'Combined holding fell last quarter and rose this one',
                 x => x.insti_prev_pp != null && x.insti_pp != null
                      && x.insti_prev_pp <= -TH_PP && x.insti_pp >= TH_PP],
  };

  /* Which holding the trend-duration control is talking about. It follows the
   * chip so the two controls can never contradict each other, and the label is
   * rewritten to say which — an unlabelled "2Q+" beside an FII filter is a
   * question, not a control. */
  const instiTrendKey = () =>
    instiChip === 'fii_acc' ? ['fii_streak', 'FII']
    : instiChip === 'dii_acc' ? ['dii_streak', 'DII']
    : ['insti_streak', 'Institutions'];

  const instiFiltered = () => instiChip || instiPreset || instiTrend
    || Object.values(instiAdv).some(v => v !== '');

  /* One predicate for every institutional control. A row with no institutional
   * data FAILS any active institutional filter — it is excluded, not assumed
   * flat. "Not measured" is not a value that can satisfy "FII accumulating". */
  const instiPass = r => {
    if (!instiFiltered()) return true;
    const x = instiOf(r.sym);
    if (!x) return false;
    if (instiChip && !INSTI_CHIPS[instiChip][1](x)) return false;
    if (instiPreset && !INSTI_PRESETS[instiPreset][2](x)) return false;
    if (instiTrend) {
      const v = x[instiTrendKey()[0]];
      if (!(typeof v === 'number' && v >= instiTrend)) return false;
    }
    const rng = (v, lo, hi) => {
      if (lo === '' && hi === '') return true;
      if (v == null) return false;
      if (lo !== '' && v < Number(lo)) return false;
      if (hi !== '' && v > Number(hi)) return false;
      return true;
    };
    return rng(x.fii_pp, instiAdv.fiiMin, instiAdv.fiiMax)
        && rng(x.dii_pp, instiAdv.diiMin, instiAdv.diiMax)
        && rng(x.insti,  instiAdv.holdMin, instiAdv.holdMax);
  };

  const instiReset = () => {
    instiChip = ''; instiPreset = ''; instiTrend = 0;
    for (const k of Object.keys(instiAdv)) instiAdv[k] = '';
  };

  /* The row badge. Compact by necessity — this sits inside a table cell on a
   * 360 px phone — so it carries the two numbers and the glyph, and the full
   * reading (levels, streak, score, the two periods compared) lives on the
   * card a tap away.
   *
   * IT RENDERS ON EVERY MEASURED ROW, INCLUDING THE FLAT ONES.
   * The first version suppressed neutral rows to keep the table quiet. That
   * was the wrong instrument: with 744 of 750 names measured it left a third
   * of the table blank, and a blank cell could not be told apart from a name
   * with no filing at all — the exact "no data" / "no change" conflation this
   * whole module is built to prevent, reintroduced in the presentation layer.
   * Noise is handled by WEIGHT instead: a flat quarter renders muted, with a
   * mid dot and no colour, so the eye still lands on the movers while the
   * reader can see that flat was measured and flat is what it was.
   *
   * A row with no comparable quarter renders nothing here, because it has
   * nothing to report; its card says why. */
  const instiBadge = sym => {
    const x = instiOf(sym);
    if (!x || x.quality !== 'complete') return '';
    const [g, cls, label] = INSTI_LOOK[x.signal] || INSTI_LOOK.neutral;
    return `<i class="scr-ins is-${cls}" title="${esc(label)} · FII ${ppFmt(x.fii_pp)}, DII ${ppFmt(x.dii_pp)} in ${esc(x.period)} vs ${esc(x.prev_period)}">
      ${/* A span, not a <b>. The symbol in this cell is the <b>, and a second
           one here made `.s b` ambiguous — it broke an existing test that
           reads the ticker off the row, which is the right complaint: this
           glyph is a decorative restatement of the label beside it, not a
           second piece of emphasis. */''}<span class="ins-g" aria-hidden="true">${g}</span><span class="vh">${esc(label)}. </span>FII ${sign1(x.fii_pp)} · DII ${sign1(x.dii_pp)} pp</i>`;
  };

  const PRESETS = {
    all:        ['Everything',     () => true],
    /* Verdict filters come first because they answer the question a reader
     * actually arrives with. The NSE screen was 89 correct columns and no
     * answer: on the 2026-09-04 build 203 rows carried no tags and no horizon
     * at all, and nothing anywhere said "don't touch this" or "right business,
     * wrong entry". verdict.py supplies one call per row — see its header for
     * every threshold. It is a reading of the evidence, not a forecast. */
    buy_lt:     ['Criteria met · long term', r => r.vd?.c === 'BUY' && r.vd?.h === 'long term'],
    buy_pos:    ['Criteria met · positional', r => r.vd?.c === 'BUY' && r.vd?.h === 'positional'],
    buy_swing:  ['Criteria met · swing', r => r.vd?.c === 'BUY' && r.vd?.h === 'swing'],
    waiting:    ['Entry not met', r => r.vd?.c === 'WAIT'],
    avoid:      ['Red flags',      r => r.vd?.c === 'AVOID' || (r.vd?.f || []).length > 0],
    breakout:   ['Breaking out',   r => (r.setup?.tags || []).some(t => /BREAKOUT/.test(t))],
    rsleader:   ['RS leaders',     r => (r.setup?.tags || []).includes('RS LEADER')],
    volume:     ['Volume spike',   r => (r.vol_spike ?? 0) >= 2],
    oversold:   ['Oversold',       r => (r.rsi ?? 99) < 35],
    quality:    ['High quality',   r => (r.q ?? 0) >= 70],
    value:      ['Cheap',          r => (r.v ?? 0) >= 70],
    debtfree:   ['Debt-free',      r => (r.de ?? 9) <= 0.1],
    compounder: ['Compounders',    r => (r.roce ?? 0) >= 20 && (r.rev_cagr ?? 0) >= 12],
    /* ── NIFTY500 AHIMSA ─────────────────────────────────────────────────
     * NSE Indices launched it on 10 July 2026: the Nifty 500 filtered to
     * companies not engaged in activities harmful to animals, 326 of the 500
     * at launch. The flag was being PRINTED on a card and there was no way to
     * act on it — a field you can read one company at a time is not a screen.
     *
     * `=== true` deliberately. The flag is three-state: true, false, and null
     * when the build could not read NSE's constituent list. A truthy filter
     * would silently include the unknowns in "not in the index", which is an
     * ethics claim manufactured by a failed fetch — the same trap the card
     * avoids by printing "not stated". A run with no list simply returns
     * nothing here, and the empty state says the filter found none. */
    ahimsa:     ['Nifty500 Ahimsa', r => r.ahimsa === true],
  };
  const SORTS = { comp: 'Composite', q: 'Quality', g: 'Growth', v: 'Value',
                  tech: 'Technical', r1m: '1M return', roce: 'ROCE', mcap_cr: 'Size',
                  // The columns the headings sort by, listed here too so the
                  // dropdown and the headings speak one vocabulary. Without
                  // this the select still read "Rank by Composite" while the
                  // page was sorted by Price — a control disagreeing with the
                  // thing it controls. They are also the only way to reach
                  // these sorts on a narrow screen, where the headings are
                  // tight enough to be awkward targets.
                  sym: 'Name (A-Z)', price: 'Price', r1d: 'Today', v50: 'vs 50-day',
                  v200: 'vs 200-day', rsi: 'RSI',
                  // Institutional sorts read from institutional.json rather than
                  // from the row, so they go through sortVal() below. They are
                  // listed last deliberately: institutional movement is one
                  // input among many, and putting it at the top of the ranking
                  // menu would imply the screen rates it above everything else.
                  i_fii: 'FII change', i_dii: 'DII change',
                  i_tot: 'Institutional change', i_score: 'Institutional score',
                  i_streak: 'Accumulation streak', i_dist: 'Heaviest selling' };

  /* Sorting reaches across two feeds. A row's own fields come off the row; the
   * six institutional keys come from the precomputed feed keyed by symbol.
   * Returning null (not 0) for a name with no institutional filing is what
   * keeps unmeasured companies at the BOTTOM of an institutional sort instead
   * of in the middle of it pretending to be flat. */
  const sortVal = (r, k) => {
    /* Columns the HEADER offers. `vs 50D` and `vs 200D` are rendered as a
     * distance computed per row, not stored, so sorting on the raw sma would
     * rank by price level instead of by distance — the opposite of what the
     * column shows. `sym` is text and is handled by the comparator, not here. */
    if (k === 'v50')  return r.sma50  ? (r.price - r.sma50)  / r.sma50  * 100 : null;
    if (k === 'v200') return r.sma200 ? (r.price - r.sma200) / r.sma200 * 100 : null;
    if (!k.startsWith('i_')) return r[k];
    const x = instiOf(r.sym);
    if (!x) return null;
    switch (k) {
      case 'i_fii':    return x.fii_pp;
      case 'i_dii':    return x.dii_pp;
      case 'i_tot':    return x.insti_pp;
      case 'i_score':  return x.score;
      case 'i_streak': return x.insti_streak;
      // Descending on the negated change, so the heaviest selling sorts first
      // in the same one-direction sort every other column uses.
      case 'i_dist':   return x.insti_pp == null ? null : -x.insti_pp;
      default:         return null;
    }
  };

  /* ── THE INSTITUTIONAL FILTER GROUP ───────────────────────────────────────
   *
   * Its own labelled group rather than five more chips in the existing row.
   * The chips above filter on price and fundamentals; these filter on who owns
   * the company, which is a different question and a different data source
   * with a different refresh cadence. Mixing them would imply they are all
   * measured the same way and all as fresh as each other, and they are not:
   * one is today's close, the other is last quarter's filing.
   *
   * Three tiers, and only the first is open by default:
   *   · five chips        — the whole question, most of the time
   *   · three saved screens, each printing its own rule
   *   · numeric ranges    — behind <details>, for the reader who wants them
   *
   * <details> because it opens with no JavaScript, closes on Escape, and is
   * announced correctly — the three things a hand-rolled disclosure has to be
   * rebuilt to do. */
  const instiTools = () => {
    if (!INSTI) return '';
    if (!INSTI_META || !INSTI_META.measured) {
      // Present but empty. Said once, plainly, rather than rendering five
      // controls that would every one of them return nothing.
      return `<p class="hint insti-none">Institutional movement is not available for this
        build — no shareholding filings were resolved.</p>`;
    }
    const [, trendWho] = instiTrendKey();
    /* `attr` names which group the chip belongs to — data-ic for the quick
     * filters, data-ip for the saved screens. They were both emitting data-ic
     * and the preset chips were told apart by ALSO carrying data-ip, which
     * made "how many quick filters are there" unanswerable by selector and
     * left the click handler branching on an attribute rather than on which
     * control was pressed. One attribute each. */
    const chip = (attr, k, on, label, extra = '') =>
      `<button type="button" class="chip${on ? ' on' : ''}" ${extra}
        ${attr}="${esc(k)}" aria-pressed="${on}">${esc(label)}</button>`;
    const num = (k, ph, lab) => `<label class="ia-f"><span>${esc(lab)}</span>
      <input type="number" step="0.05" inputmode="decimal" class="ia-in" data-ia="${esc(k)}"
             value="${esc(instiAdv[k])}" placeholder="${esc(ph)}" aria-label="${esc(lab)}"></label>`;
    const active = instiFiltered();

    /* CLOSED UNTIL IT IS WANTED.
     *
     * This block opened expanded on every visit: a heading, a sub-line, seven
     * quick chips, five saved screens, a ranges disclosure and a coverage
     * paragraph. On a phone that is roughly two screens of secondary filters
     * standing between the reader and the first row of the thing they came
     * for — and it sits below the primary preset chips, which most sessions
     * never scroll past.
     *
     * It is not removed and nothing inside it changes. It opens on a tap, and
     * it opens BY ITSELF whenever one of its filters is active, so the panel
     * can never be closed over a filter that is silently narrowing the table.
     * The summary says so too. */
    return `<details class="insti-g"${active || instiAdvOpen ? ' open' : ''}>
      <summary class="insti-h">
        <h3>Institutional movement</h3>
        <span class="insti-sub">FII and DII holding, ${esc(INSTI_META.latest_period_end
          ? 'latest quarterly filings' : 'quarterly filings')} · change in percentage points</span>
        ${active ? `<b class="insti-on">filtering</b>` : ''}
      </summary>
      ${active ? `<button type="button" class="insti-clear" id="insti-clear">Clear institutional filters</button>` : ''}
      <div class="chips" role="group" aria-label="Institutional quick filters">
        ${chip('data-ic', '', !instiChip && !instiPreset, 'Any')}
        ${Object.entries(INSTI_CHIPS).map(([k, [l]]) => chip('data-ic', k, instiChip === k, l)).join('')}
      </div>
      <div class="chips insti-p" role="group" aria-label="Saved institutional screens">
        ${Object.entries(INSTI_PRESETS).map(([k, [l, rule]]) =>
          chip('data-ip', k, instiPreset === k, l, `title="${esc(rule)}"`)).join('')}
      </div>
      ${instiPreset ? `<p class="hint insti-rule"><b>${esc(INSTI_PRESETS[instiPreset][0])}</b>
        — ${esc(INSTI_PRESETS[instiPreset][1])}.</p>` : ''}
      <details class="insti-adv"${instiAdvOpen ? ' open' : ''}>
        <summary>Ranges and trend length</summary>
        <div class="ia-grid">
          <div class="ia-row"><b>FII change</b>${num('fiiMin', 'min pp', 'Minimum FII change, percentage points')}${num('fiiMax', 'max pp', 'Maximum FII change, percentage points')}</div>
          <div class="ia-row"><b>DII change</b>${num('diiMin', 'min pp', 'Minimum DII change, percentage points')}${num('diiMax', 'max pp', 'Maximum DII change, percentage points')}</div>
          <div class="ia-row"><b>Total institutional holding</b>${num('holdMin', 'min %', 'Minimum institutional holding, percent')}${num('holdMax', 'max %', 'Maximum institutional holding, percent')}</div>
          <div class="ia-row ia-tr"><b>${esc(trendWho)} rising for</b>
            <div class="chips" role="group" aria-label="Trend length">
              ${[[0, 'Any'], [1, '1Q'], [2, '2Q'], [3, '3Q+']].map(([n, l]) =>
                `<button type="button" class="chip${instiTrend === n ? ' on' : ''}"
                  data-it="${n}" aria-pressed="${instiTrend === n}">${l}</button>`).join('')}
            </div>
          </div>
        </div>
        <p class="hint">Changes are in <b>percentage points</b>: a holding that goes from
          10% to 12% has risen <b>2.00 pp</b>, not 20%. A move under
          ${TH_PP} pp is treated as no change.</p>
      </details>
      <p class="hint insti-cov">Measured for <b>${INSTI_META.measured}</b> of
        ${INSTI_META.universe} names${INSTI_META.latest_period_end
          ? ` · latest filing ${esc(INSTI_META.latest_period_end)}` : ''}.
        Names with no comparable quarter are excluded from these filters rather
        than counted as unchanged. <a href="/methodology">How this is measured →</a></p>
    </details>`;
  };

  /* Every institutional control, delegated from one place. Called after each
   * draw() because draw() replaces the whole subtree. */
  const wireInsti = (draw) => {
    const root = main.querySelector('.insti-g');
    if (!root) return;
    const redraw = () => { scrPage = 0; draw(); };
    root.querySelectorAll('.chip[data-ic]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.ic;
      instiChip = (k === '' || instiChip === k) ? '' : k;
      if (k === '') instiPreset = '';            // "Any" clears both groups
      redraw();
    }));
    root.querySelectorAll('.chip[data-ip]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.ip;
      instiPreset = instiPreset === k ? '' : k;
      redraw();
    }));
    root.querySelectorAll('.chip[data-it]').forEach(b => b.addEventListener('click', () => {
      instiTrend = Number(b.dataset.it) || 0; redraw();
    }));
    const adv = root.querySelector('.insti-adv');
    if (adv) adv.addEventListener('toggle', () => { instiAdvOpen = adv.open; });
    root.querySelectorAll('.ia-in').forEach(inp => inp.addEventListener('input', () => {
      // Coalesced and focus-preserving, the same way the search box is: a
      // redraw on every keystroke would otherwise steal the caret mid-number.
      clearTimeout(inp._t);
      inp._t = setTimeout(() => {
        instiAdv[inp.dataset.ia] = inp.value.trim();
        const k = inp.dataset.ia, at = inp.selectionStart;
        redraw();
        const n = main.querySelector(`.ia-in[data-ia="${k}"]`);
        if (n) { n.focus(); try { n.setSelectionRange(at, at); } catch (e) { /* number input */ } }
      }, 220);
    }));
    const clr = root.querySelector('#insti-clear');
    if (clr) clr.addEventListener('click', () => { instiReset(); redraw(); });
  };

  /* ── OWNERSHIP, ON THE CARD ───────────────────────────────────────────────
   *
   * This block replaced one built on Yahoo's `heldPercentInsiders` and
   * `heldPercentInstitutions`. Two things were wrong with it and neither was
   * visible on screen:
   *   · "Promoters / insiders" was Yahoo's insiders bucket, which is WIDER
   *     than SEBI's promoter definition — the upstream fetcher's own comment
   *     records Dixon reading 40.1% against a real promoter stake nearer 32%.
   *   · "Institutions" was a single undated snapshot with no FII/DII split and
   *     no history, so it could not answer the only question worth asking of
   *     an ownership number: which way is it moving.
   * Both now come from the company's own quarterly filing, and the block names
   * the two periods it compared. Where there is no filing the Yahoo figure is
   * still shown — labelled as the estimate it is, not as the filing.
   *
   * The share-count warning is kept verbatim: it is about dilution, comes from
   * the accounts rather than the shareholding pattern, and is orthogonal. */
  const instiCard = (r) => {
    const dil = r.shares_changed == null ? '' :
      `<div class="yy"><span>Share count</span><b class="${r.shares_changed ? 'dn' : 'up'}">${
        r.shares_changed ? 'Changed — check dilution' : 'Unchanged'}</b></div>`;
    const x = instiOf(r.sym);

    if (!x || x.quality === 'unavailable') {
      return `<div class="yoy">
        ${r.insiders != null ? `<div class="yy"><span>Insiders <i class="u">estimate</i></span><b>${Number(r.insiders).toFixed(1)}%</b></div>` : ''}
        ${r.instis != null ? `<div class="yy"><span>Institutions <i class="u">estimate</i></span><b>${Number(r.instis).toFixed(1)}%</b></div>` : ''}
        ${dil}</div>
      <p class="hint">No quarterly shareholding filing was resolved for this name, so the
        figures above are Yahoo's wider estimate rather than the company's filing.
        They carry no FII/DII split and no comparison quarter.</p>`;
    }

    const lvl = (l, v) => v == null ? '' :
      `<div class="yy"><span>${esc(l)}</span><b>${Number(v).toFixed(2)}<i class="u">%</i></b></div>`;

    const levels = `<div class="yoy">
      ${lvl('Promoters', x.promoter)}${lvl('FII', x.fii)}${lvl('DII', x.dii)}
      ${lvl('Public', x.publicHold)}${dil}</div>`;

    // Partial: say exactly what is missing instead of printing a change that
    // was measured across a gap.
    if (x.quality !== 'complete') {
      return levels + `<p class="hint">Holdings as filed for <b>${esc(x.period)}</b>.
        No quarter-on-quarter change is shown — ${esc(x.reason || 'no comparable previous quarter')}.</p>`;
    }

    const [glyph, cls, label, gloss] = INSTI_LOOK[x.signal] || INSTI_LOOK.neutral;
    const mv = (l, v, streak) => `<div class="yy"><span>${esc(l)}</span>
      <b class="${dir(v)}">${ppFmt(v)}</b>${streak ? `<i class="u">${esc(streak)}</i>` : ''}</div>`;
    const streakWord = n => !n ? '' :
      `${Math.abs(n)}Q ${n > 0 ? 'rising' : 'falling'}`;

    /* THE SCORE, WITH ITS WORKING SHOWN. A 0–100 composite is an opinion, and
     * an opinion presented as a bare number is the thing this site exists not
     * to do. Every weight and every input is printed beside it, and each input
     * is also printed raw above, so the reader can disagree with the model
     * without having to reconstruct it. */
    const bandCls = x.score == null ? '' : x.score >= 65 ? 'up' : x.score <= 39 ? 'dn' : '';
    const comp = (w, l, raw, shown) => `<div class="isc-r">
      <span class="isc-w">${w}%</span><span class="isc-l">${esc(l)}</span>
      <span class="isc-v ${dir(raw)}">${esc(shown)}</span></div>`;
    const scoreBlock = x.score == null ? '' : `
      <div class="isc">
        <div class="isc-h"><span class="isc-n ${bandCls}">${x.score}</span>
          <span class="isc-b">${esc(x.band_label || '')}<em>Institutional strength · 0–100</em></span></div>
        ${comp(40, 'FII change this quarter', x.fii_pp, ppFmt(x.fii_pp))}
        ${comp(30, 'DII change this quarter', x.dii_pp, ppFmt(x.dii_pp))}
        ${comp(20, 'Multi-quarter consistency', x.insti_streak,
               x.insti_streak ? streakWord(x.insti_streak) : 'no run')}
        ${comp(10, 'Acceleration', (x.fii_accel_pp ?? 0) + (x.dii_accel_pp ?? 0),
               x.fii_accel_pp == null && x.dii_accel_pp == null ? 'not measurable'
                 : `FII ${ppFmt(x.fii_accel_pp)} · DII ${ppFmt(x.dii_accel_pp)}`)}
        <p class="isc-n2">A weighted reading of the four figures above, each capped so one
          outsized quarter cannot carry the score. It ranks names; it does not value them.</p>
      </div>`;

    return levels + `
      <div class="insti-v is-${esc(cls)}">
        <span class="iv-g" aria-hidden="true">${glyph}</span>
        <span class="iv-t"><b>${esc(label)}</b>
          <em>${esc(x.signal_direction || gloss)}</em></span>
      </div>
      <div class="yoy">
        ${mv('FII, quarter on quarter', x.fii_pp, streakWord(x.fii_streak))}
        ${mv('DII, quarter on quarter', x.dii_pp, streakWord(x.dii_streak))}
        ${mv('Combined institutional', x.insti_pp, streakWord(x.insti_streak))}
      </div>
      ${instiSpark(x)}
      ${scoreBlock}
      <p class="hint">Holdings as filed. Latest <b>${esc(x.period)}</b> (${esc(x.period_end)}),
        compared with <b>${esc(x.prev_period)}</b> — consecutive quarters.
        Changes are in percentage points; a move under ${TH_PP} pp is treated as no change.
        Source: the company's shareholding pattern filed with the exchange.</p>`;
  };

  /* Eight quarters of FII and DII as two thin bars per quarter. Deliberately
   * not a line chart: the question is "which way, and for how long", which
   * paired bars answer at a glance and at 40 px tall. Values are in the table
   * behind it for anyone who cannot use the picture. */
  const instiSpark = (x) => {
    const s = (x.series || []).filter(q => q.f != null || q.d != null);
    if (s.length < 3) return '';
    const max = Math.max(...s.flatMap(q => [q.f ?? 0, q.d ?? 0]), 1);
    return `<figure class="ispark">
      <figcaption>FII and DII holding, last ${s.length} quarters filed</figcaption>
      <div class="isp-r" role="img" aria-label="${esc(s.map(q =>
        `${q.p}: FII ${q.f == null ? 'not filed' : q.f.toFixed(1) + '%'}, DII ${q.d == null ? 'not filed' : q.d.toFixed(1) + '%'}`).join('. '))}">
        ${s.map(q => `<div class="isp-q">
          <div class="isp-bars">
            <i class="isp-f" style="height:${((q.f ?? 0) / max * 100).toFixed(1)}%"></i>
            <i class="isp-d" style="height:${((q.d ?? 0) / max * 100).toFixed(1)}%"></i>
          </div><span>${esc(q.p.replace(/^Q(\d) FY/, 'Q$1·'))}</span>
        </div>`).join('')}
      </div>
      <p class="isp-k"><i class="isp-f"></i>FII <i class="isp-d"></i>DII</p>
    </figure>`;
  };

  R['/screen'] = async () => {
    /* The URL is the source of truth on arrival: a shared link, a bookmark or
     * a reload must land on the same nine names the sender was looking at. */
    SCR_STATE.read();
    const screenSnap = rows => ((num) => snap([
      ['Universe', rows.length, (() => {
        /* WHAT THE UNIVERSE IS MADE OF. 250 of these names are not Nifty Total
           Market constituents — they are the most liquid listings outside it —
           and the page said only "names screened", which reads as one index. */
        const c = SCREEN_META.universe_core, e = SCREEN_META.universe_ext;
        return (c && e) ? `${c} in the index · ${e} by turnover` : 'names screened';
      })()],
      ['Above 200-day', rows.filter(r => num(r.price) && num(r.sma200) && num(r.price) > num(r.sma200)).length,
       'in an uptrend', 'up'],
      ['At 52-week high', rows.filter(r => r.brk52w).length, 'breaking out', 'ac'],
      ['Median ATR', (() => {
        const a = rows.map(r => num(r.atr_pct)).filter(x => x != null).sort((x, y) => x - y);
        return a.length ? a[Math.floor(a.length / 2)].toFixed(2) + '%' : null;
      })(), 'daily range'],
    ]))(v => { if (v == null || v === '') return null;
               const x = Number(v); return Number.isFinite(x) ? x : null; });

    /* ── WHAT THE SCREEN ACTUALLY SAYS, AS A SHAPE ────────────────────────
     * 989 rows and four summary tiles, and no picture of what the verdicts
     * add up to. The screen already publishes a call on every name — BUY,
     * WAIT, WATCH, AVOID — and the one thing a reader wants before scrolling
     * a thousand rows is how many fall into each. That is a split bar, not a
     * table: the widths ARE the answer.
     * Colours follow the calls rather than the palette: buy is the up colour,
     * avoid the down one, and the two middle states share the neutral, since
     * "wait" and "watch" are both "not yet". */
    const verdictBar = (rows) => {
      const c = { BUY: 0, WAIT: 0, WATCH: 0, AVOID: 0 };
      for (const r of rows) {
        const v = String((r.vd && r.vd.c) || '').toUpperCase();
        if (v in c) c[v] += 1;
      }
      const total = c.BUY + c.WAIT + c.WATCH + c.AVOID;
      if (!total) return '';
      const seg = (n, cls, label) => n <= 0 ? '' :
        `<i class="${cls}" style="flex:0 0 ${(n / total * 100).toFixed(1)}%"
            title="${label}: ${n} of ${total}">${(n / total * 100) > 9 ? n : ''}</i>`;
      const W = verdictWord;
      return `<div class="splitb" role="img"
          aria-label="${c.BUY} ${W('BUY')}, ${c.WAIT} ${W('WAIT')}, ${c.WATCH} ${W('WATCH')}, ${c.AVOID} ${W('AVOID')}">
          ${seg(c.BUY, 'sb-u', W('BUY'))}${seg(c.WAIT, 'sb-f', W('WAIT'))}
          ${seg(c.WATCH, 'sb-f', W('WATCH'))}${seg(c.AVOID, 'sb-d', W('AVOID'))}
        </div>
        <div class="splitl"><span><b class="up">${c.BUY}</b> ${W('BUY').toLowerCase()}</span>
          <span>${c.WAIT + c.WATCH} ${W('WAIT').toLowerCase()} or watch</span>
          <span><b class="dn">${c.AVOID}</b> ${W('AVOID').toLowerCase()}</span></div>
        <p class="hint">The screen's own call on every name it can judge. A call is
          not a recommendation — no engine here has proved itself yet.</p>`;
    };

    const shell = body => head('Screen',
      'Every NSE name on the screen, scored on quality, growth, value and trend. Search, filter, or open any row for its full card.',
      'Every name, ranked') + body;
    if (!SCREEN) paint(shell(`<div class="note">Loading the full universe — about 260 KB, once per session.</div>` +
      `<div class="sk" style="height:320px"></div>`));

    /* `|| SCREEN_LITE` — a cache filled by a light route is missing the
     * per-company prose this surface exists to show, so it is re-fetched over
     * the top rather than rendered with the sections silently empty. */
    if (!SCREEN || SCREEN_LITE) {
      // In parallel, and institutional data is allowed to fail: it is one
      // section of one screen, and losing it must never cost the reader the
      // 750 rows they actually came for.
      const [r] = await Promise.all([get(FULL_URL).then(noteLadder), loadInsti()]);
      if (!r.ok) { paint(shell(fail('The screen', r.error))); return; }
      noteScreenMeta(r.data); setScreen((r.data.rows || []).filter(x => x && x.sym), false);
    } else await loadInsti();

    let shownRows = [];          // the page the live quote call must ask for
    const draw = () => {
      // Every redraw is a state change worth being able to link to.
      SCR_STATE.write();
      const q = scrQ.trim().toLowerCase();
      const rows = SCREEN
        .filter(r => [...scrPresets].every(k => PRESETS[k][1](r)))
        .filter(r => !q || (r.sym || '').toLowerCase().includes(q)
                        || (r.name || '').toLowerCase().includes(q)
                        || (r.sector || '').toLowerCase().includes(q))
        .filter(instiPass)
        .sort((a, b) => {
          const dir = scrDir === 'asc' ? -1 : 1;
          if (scrSort === 'sym') {
            return dir * String(b.sym || '').localeCompare(String(a.sym || ''));
          }
          const va = sortVal(a, scrSort), vb = sortVal(b, scrSort);
          /* Missing values sink in BOTH directions. Falling back to -1e9 put
             every unpriced row at the top of an ascending sort, which reads as
             "cheapest" and is simply "unknown". */
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return dir * (vb - va);
        });

      main.innerHTML = shell(
        screenSnap(SCREEN) +
        /* The shape of the screen's verdicts, before the thousand rows. */
        (verdictBar(SCREEN) ? sec('What the screen says', verdictBar(SCREEN),
                                  `${SCREEN.length} names`, null, { lead: true }) : '') +
        /* THE PROVENANCE LINE. Both halves were in the payload and neither was
           rendered: a reader could rank by Composite without being told what
           the composite weighs, and could not see that a quarter of the table
           turned over since the last build. */
        (() => {
          const w = SCREEN_META.weights || {}, ch = SCREEN_META.changes || {};
          const parts = Object.entries(w)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${esc(k)} ${Math.round(v * 100)}%`);
          const bits = [];
          if (parts.length) bits.push(`<b>Composite</b> = ${parts.join(' · ')}`);
          if (ch.compared_with && (ch.new != null || ch.moved != null)) {
            bits.push(`<b>${ch.new ?? 0}</b> new and <b>${ch.moved ?? 0}</b> re-ranked since ${esc(ch.compared_with)}`);
          }
          return bits.length
            ? `<p class="hint scr-prov">${bits.join(' &nbsp;·&nbsp; ')}</p>` : '';
        })() +
        `<div class="tools">
          <input type="search" id="scrq" class="scr-in" placeholder="Symbol, company or sector"
                 value="${esc(scrQ)}" aria-label="Search the screen">
          <select id="scrs" class="scr-sel" aria-label="Rank by">
            ${Object.entries(SORTS).map(([k, l]) =>
              `<option value="${k}"${scrSort === k ? ' selected' : ''}>Rank by ${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="chips" role="group" aria-label="Screen filters">${
          Object.entries(PRESETS).map(([k, [l]]) => {
            const on = k === 'all' ? scrPresets.size === 0 : scrPresets.has(k);
            return `<button type="button" class="chip${on ? ' on' : ''}" data-p="${k}"
                     aria-pressed="${on}">${esc(l)}</button>`;
          }).join('')}
        </div>
        <div class="t5tools" style="margin:2px 0 12px">
          ${/* PER PAGE, NOT PER UNIVERSE. A divergence needs a daily series,
              * and 750 names is 750 requests — which is not a filter, it is an
              * outage. It runs on the forty rows on screen, which is also the
              * only set the reader is looking at, and says so. */''}
          <button type="button" class="chip" id="scrDiv">Check RSI divergence on this page</button>
          <button type="button" class="chip" id="scrDivOnly" aria-pressed="false" hidden>Only divergences</button>
          <span class="t5note" id="scrDivNote"></span>
        </div>
        <p class="hint chips-hint">${scrPresets.size > 1
          ? `Showing names that clear <b>all ${scrPresets.size}</b> of these at once.`
          : 'Filters combine — pick as many as you like.'}</p>` +
        instiTools() +
        // 40, not 60: /api/signals?px= takes 40 symbols a call, so a 40-row
        // page is exactly one request and every visible row can carry a live
        // mark. A 60-row page would leave a third of the screen showing the
        // morning close beside two thirds showing live — worse than either.
        (() => {
          /* PAGINATED, NOT CAPPED. The page size stays 40 for the reason above
           * — one page is exactly one quote request, so every visible row can
           * carry a live mark. What was wrong was that rows 41 to 750 were
           * simply unreachable: the header said "750 of 750" while the table
           * showed forty, which reads as a broken table rather than a page. */
          /* FORTY ON A DESK, TWENTY ON A PHONE.
           *
           * Forty rows is one quote request and, at 72px a row on a desk,
           * 2,900px — a table you can scan. The same forty on a phone are
           * stacked cards at ~200px each: 8,000px, four names on screen at a
           * time, and a "screen" that can only be scrolled rather than
           * scanned. Twenty is still one request (the cap is 40 symbols), the
           * pager is already there and already says which page of how many,
           * and no row becomes unreachable — which was the whole point of
           * paginating rather than capping in the first place. */
          const PER = window.matchMedia('(max-width:700px)').matches ? 20 : 40;
          const pages = Math.max(1, Math.ceil(rows.length / PER));
          if (scrPage >= pages) scrPage = 0;          // a filter change shortens the list
          const from = scrPage * PER;
          const page = rows.slice(from, from + PER);
          shownRows = page;          // the rows the live quote call must ask for
          const nav = pages < 2 ? '' : `<div class="pager">
            <button type="button" class="pg" data-pg="prev" ${scrPage === 0 ? 'disabled' : ''}>← Previous</button>
            <span class="pg-n">Showing <b>${from + 1}–${Math.min(from + PER, rows.length)}</b>
              of <b>${rows.length}</b>${rows.length !== SCREEN.length ? ` matching (of ${SCREEN.length})` : ''}
              · page ${scrPage + 1} of ${pages}</span>
            <button type="button" class="pg" data-pg="next" ${scrPage >= pages - 1 ? 'disabled' : ''}>Next →</button>
          </div>`;
          const key = PLKEY;
          /* THE HEADING HAS TO NAME EVERY ACTIVE FILTER.
           * It read only the price/fundamental chips, so a screen filtered to
           * "FII accumulating + Institutional turnaround" was headed
           * "Everything" above 20 of 750 rows — a heading that contradicts the
           * count beside it. */
          const parts = [...scrPresets].map(k => PRESETS[k][0]);
          if (instiChip) parts.push(INSTI_CHIPS[instiChip][0]);
          if (instiPreset) parts.push(INSTI_PRESETS[instiPreset][0]);
          if (instiTrend) parts.push(`${instiTrendKey()[1]} rising ${instiTrend}Q+`);
          if (Object.values(instiAdv).some(v => v !== '')) parts.push('custom ranges');
          const title = parts.length ? parts.join(' + ') : PRESETS.all[0];
          return sec(title, rows.length
              ? key + heatKey(20, 'Distance from the moving averages') + screenTable(page, from) + nav
            : `<div class="empty">Nothing matches. Try a different preset or clear the search.</div>`,
            `${rows.length} of ${SCREEN.length}`);
        })());

      main.querySelectorAll('.pg').forEach(b => b.addEventListener('click', () => {
        scrPage += b.dataset.pg === 'next' ? 1 : -1;
        draw();
        // Back to the top of the table, not the top of the document: the reader
        // is paging through a list, not starting the page again.
        const t = main.querySelector('.rank, .scr');
        if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 90,
                                 behavior: REDUCED ? 'auto' : 'smooth' });
      }));

      const inp = main.querySelector('#scrq');
      inp.addEventListener('input', () => {
        // Coalesced: 750 rows re-filtered on every keystroke is 750 rows of
        // work per keystroke, and the phone feels it.
        clearTimeout(inp._t);
        inp._t = setTimeout(() => { scrQ = inp.value; scrPage = 0; const at = inp.selectionStart; draw();
          const n = main.querySelector('#scrq'); n.focus(); n.setSelectionRange(at, at); }, 160);
      });
      main.querySelector('#scrs').addEventListener('change', e => {
        scrSort = e.target.value; scrDir = 'desc'; draw();
      });
      /* Headings. Delegated from main because draw() replaces the grid whole,
         and bound for the keyboard as well: a span with role=button that only
         answers a mouse is a control half the readers cannot use. */
      main.addEventListener('click', (e) => {
        const h = e.target.closest && e.target.closest('.scr-h');
        if (!h || !main.contains(h)) return;
        const k = h.getAttribute('data-s');
        if (!k) return;
        // Same column toggles direction; a new column starts descending, which
        // is "best first" for every column except the name.
        if (scrSort === k) scrDir = scrDir === 'desc' ? 'asc' : 'desc';
        else { scrSort = k; scrDir = k === 'sym' ? 'asc' : 'desc'; }
        scrPage = 0;
        draw();
      });
      main.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const h = e.target.closest && e.target.closest('.scr-h');
        if (!h) return;
        e.preventDefault();
        h.click();
      });
      /* [data-p], not every .chip on the page. This handler bound itself to
       * ALL chips, so adding two unrelated ones to the Screen's toolbar made
       * them behave as filter presets: b.dataset.p was undefined, undefined
       * went into the preset Set, and the next draw threw on
       * PRESETS[undefined][1]. A delegated handler has to name what it owns. */
      wireInsti(draw);
      main.querySelectorAll('.chip[data-p]').forEach(b =>
        b.addEventListener('click', () => {
          const k = b.dataset.p;
          if (k === 'all') scrPresets.clear();
          else if (scrPresets.has(k)) scrPresets.delete(k);
          else scrPresets.add(k);
          scrPage = 0;   // a changed filter invalidates the page number
          SCRDIV = null; // and invalidates any divergence run against the old page
          draw();
        }));

      /* The same engine the volume sheet uses, pointed at the visible page. */
      const dv = document.getElementById('scrDiv');
      if (dv) {
        const note = document.getElementById('scrDivNote');
        const only = document.getElementById('scrDivOnly');
        const syms = [...document.querySelectorAll('.scr-r:not(.rank-head)')]
          .map(r => r.getAttribute('data-sym')).filter(Boolean);
        const mark = () => {
          document.querySelectorAll('.scr-r:not(.rank-head)').forEach(row => {
            const d = SCRDIV && SCRDIV[row.getAttribute('data-sym')];
            row.querySelectorAll('.scr-dv').forEach(e => e.remove());
            if (!d || !d.ok || !d.kind || d.kind === 'none') return;
            const s2 = row.querySelector('.s');
            if (s2) s2.insertAdjacentHTML('beforeend',
              `<i class="scr-dv dv-${esc(d.kind)}">${d.kind === 'bullish' ? 'BULL' : 'BEAR'} RSI DIV</i>`);
          });
          if (only && only.getAttribute('aria-pressed') === 'true') {
            document.querySelectorAll('.scr-r:not(.rank-head)').forEach(row => {
              const d = SCRDIV && SCRDIV[row.getAttribute('data-sym')];
              row.hidden = !(d && d.ok && d.kind && d.kind !== 'none');
            });
          } else {
            document.querySelectorAll('.scr-r:not(.rank-head)').forEach(r => { r.hidden = false; });
          }
        };
        dv.addEventListener('click', async () => {
          dv.disabled = true;
          SCRDIV = {};
          let done = 0;
          note.textContent = `reading ${syms.length} daily charts…`;
          await mapLimit(syms, 4, async sym => {
            const res = await get(`/api/signals?series=${encodeURIComponent(sym)}&range=1y`);
            const pts = res.ok ? (res.data.points || []) : [];
            SCRDIV[sym] = pts.length
              ? rsiDivergence(pts.map(x => Number(x.c)).filter(Number.isFinite))
              : { ok: false, why: 'no daily series' };
            note.textContent = `read ${++done} of ${syms.length}…`;
          });
          const n = Object.values(SCRDIV).filter(d => d.ok && d.kind && d.kind !== 'none').length;
          note.textContent = `${n} of ${syms.length} on this page show a divergence`;
          dv.hidden = true;
          if (n) only.hidden = false;
          mark();
        });
        if (only) only.addEventListener('click', () => {
          only.setAttribute('aria-pressed', String(only.getAttribute('aria-pressed') !== 'true'));
          mark();
        });
        if (SCRDIV) mark();
      }
      /* No per-row listener here. A delegated handler on `document` already
       * opens any [data-sym], so this bound forty more on every repaint — and
       * being bound directly to the element it also fired for clicks on the
       * watchlist star inside it, which the delegated handler correctly
       * ignores. Forty listeners fewer, and one bug fewer. */

      /* Live marks for the rows actually on screen. Fired after paint so the
       * table is readable immediately and the quotes fill in — a screen that
       * waits for a network call before showing 750 names it already has is
       * slower for no reason. Stamped by symbol, so a re-render mid-flight
       * cannot write a price into the wrong row. */
      /* THE PAGE ON SCREEN, NOT THE FIRST PAGE OF THE LIST.
       *
       * This asked for rows.slice(0, 40) — always page one — and then wrote
       * the answers into `[data-sym=...]` cells that only exist on page one.
       * So page 2 and every page after it silently kept the WEEKLY build
       * price, which is what the screen is for and what it was not doing:
       * 710 of 750 rows showed a price up to seven days old with no mark that
       * it was stale. One page is one quote request either way. */
      const shown = shownRows.map(r => r.sym);
      const bySym = new Map(shownRows.map(r => [r.sym, r]));
      const token = ++drawToken;
      quotes(shown).then(q => {
        if (token !== drawToken) return;          // a newer draw has replaced this one
        for (const sym of shown) {
          const live = q[sym];
          if (!live || !Number.isFinite(Number(live.price))) continue;
          const row = main.querySelector(`[data-sym="${CSS.escape(sym)}"]`);
          if (!row) continue;
          const cell = row.querySelector('[data-px]');
          if (cell) { cell.textContent = price(live.price); cell.classList.add('lv'); }
          const day = row.querySelector('[data-day]');
          if (day && live.change_pct != null) {
            day.textContent = pct(live.change_pct);
            day.className = 'x ' + dir(live.change_pct);
          }
          /* A LIVE PRICE BESIDE WEEK-OLD PERCENTAGES IS A WORSE ROW THAN A
           * CONSISTENT STALE ONE. vs50D and vs200D were computed at build time
           * against the build-time price, so refreshing only the price left
           * the two columns disagreeing with the number beside them. The
           * moving averages themselves barely move in a week — a 200-day mean
           * shifts by a fraction of a percent — so they are re-measured
           * against the live price and the stored average, which is the small
           * error rather than the large one. */
          const r0 = bySym.get(sym), px = Number(live.price);
          for (const [sel, sma, scale] of [['[data-v50]', r0 && r0.sma50, 8],
                                           ['[data-v200]', r0 && r0.sma200, 20]]) {
            const c = row.querySelector(sel);
            const m = Number(sma);
            if (!c || !Number.isFinite(m) || m <= 0) continue;
            const v = (px / m - 1) * 100;
            c.textContent = pct(v);
            c.className = 'x ' + dir(v) + ' ' + heatCell(v, scale);
          }
        }
      });
    };
    draw();
  };
  let drawToken = 0;

  // Turnover is out. It says how much traded, which almost never changes a
  // decision — where price sits against its own 50 and 200 day, and whether
  // it is stretched, does.
  /* ── THE PRICE LINE ──────────────────────────────────────────────────────
   * The markets board's range bar, stretched into a full price ladder and
   * given to every one of the screened names.
   *
   * On one linear scale from the 52-week low to the 52-week high it marks the
   * 200-day, the 50-day, the 20-day and where the price is now. Those three
   * averages ARE the support and resistance most of this screen's engines
   * trade against — drawn rather than listed, so "price is above the 50 but
   * under the 200" is a glance instead of three subtractions.
   *
   * ZERO EXTRA REQUESTS. Every field is already on the screen row: 720 of 750
   * carry the 52-week range, 750 carry the 20 and 50-day, 736 the 200-day. A
   * name missing its range gets no line rather than a made-up one.
   */
  /* THE KEY TO THE LINE, WHEREVER THE LINE IS.
   *
   * This legend existed once, at the bottom of the Screen. The same component
   * is drawn on the sector drill, the ranked idea tables, the movers and the
   * watchlist, and on every one of those a reader met four unexplained ticks
   * on a coloured bar. A chart component that needs a key needs it on every
   * page that draws it, or it is decoration on all but one of them. */
  /* ── THE HEAT LEGEND ─────────────────────────────────────────────────────
   * Four surfaces shade cells by value — the screen, the fund table, the movers
   * and the ideas list — and not one of them said what the shading meant. A
   * colour that encodes a number and never states its scale is decoration that
   * looks like information, which is worse than no colour: the reader assumes
   * a threshold that is not there. `scale` is the same number passed to
   * heatCell, so the legend cannot drift from the cells it explains. */
  const heatKey = (scale, what) => `<p class="heat-key">
    <span>${esc(what)}, shaded by size:</span>
    <span><i class="hk h-n3"></i>−${scale}%</span>
    <span><i class="hk h-n1"></i></span>
    <span><i class="hk h-z"></i>0</span>
    <span><i class="hk h-p1"></i></span>
    <span><i class="hk h-p3"></i>+${scale}%</span>
    <span>and beyond at the ends.</span></p>`;

  /* A KEY BELOW FORTY ROWS IS A KEY NOBODY READS.
   *
   * This sat under the table, so the reader met forty bars carrying four
   * unexplained tick marks and found out what they were after scrolling past
   * every one of them. It goes above the rows it explains.
   *
   * Shorter, too: the line's two ends now carry their own labels on every
   * row, so the key no longer has to say what the bar spans — only what the
   * marks on it are. */
  const PLKEY = `<p class="pl-key">
    <span>Marks on each row's 52-week line:</span>
    <span><i class="know"></i>price now</span>
    <span><i class="k200"></i>200-day</span>
    <span><i class="k50"></i>50-day</span>
    <span><i class="k20"></i>20-day</span></p>`;

  const priceLine = r => {
    const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
    const lo = n(r.low52), hi = n(r.high52), px = n(r.price);
    // lo <= 0 is rejected as well as lo >= hi. A zero bound reaches the client
  // from feeds this file does not control (see readMeta in src/api/ticker.js:
  // Yahoo published a 52-week low of 0 for KOSPI), and a range anchored at
  // zero draws every instrument pinned to the top of its own year. No line at
  // all is the honest render; the row still carries price and change.
  if (lo == null || hi == null || px == null || lo <= 0 || hi <= lo) return '';
    const at = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    const mark = (v, cls, label) => v == null ? ''
      : `<i class="pl-m ${cls}" style="left:${at(v).toFixed(2)}%" title="${esc(label)} ${esc(fmtN(v))}"></i>`;
    return `<span class="pl" role="img"
        aria-label="${esc(r.sym)} at ${esc(fmtN(px))}, ${at(px).toFixed(0)} per cent of the way from its 52-week low ${esc(fmtN(lo))} to its high ${esc(fmtN(hi))}">
      <i class="pl-t"></i>
      <i class="pl-f" style="width:${at(px).toFixed(2)}%"></i>
      ${mark(n(r.sma200), 'is-200', '200-day')}
      ${mark(n(r.sma50), 'is-50', '50-day')}
      ${mark(n(r.sma20), 'is-20', '20-day')}
      <i class="pl-now" style="left:${at(px).toFixed(2)}%"></i>
    </span>`;
  };
  // Compact Indian-format number for the labels and titles above.
  // The rule this defined now lives in price(); kept as a name the screen
  // table already uses, delegating rather than holding a second copy.
  const fmtN = v => price(v, '');

  /* THE VERDICT — the call on the STOCK, and the only thing on this site
   * entitled to that word. Buy / Wait / Watch / Avoid, from verdict.py.
   * One call per name, computed in verdict.py at build time and published on
   * the row as `vd`. Rendered here rather than derived in the browser so the
   * page, the Telegram bot and the tests cannot disagree about what a stock
   * was called on a given day.
   *
   * The reasons are deliberately NOT in the payload: the two panes below this
   * block already render why_now and risk.flags off the same row, and
   * carrying both would have put 251 KB onto a file the front page fetches on
   * first paint. What the reader cannot get elsewhere is the call, the
   * horizon, and — for a WAIT — the level that would change it. */
  const VD_CLASS = { BUY: 'pill-up', WAIT: 'pill-wn', AVOID: 'pill-dn',
                     WATCH: 'pill-ac', UNRATED: 'pill-ac' };
  /* ── ONE VERDICT VOCABULARY, BECAUSE THERE WERE TWO ──────────────────────
   *
   * `vd.c` is a single field with a single meaning, and this site rendered it
   * two different ways depending on which page you were on:
   *
   *     vd.c        the screen said     the radar said
   *     BUY         Act                 Buy
   *     AVOID       Ignore              Avoid
   *     WAIT        Wait                Wait for entry
   *
   * Same company, same build, same field, two answers. A reader moving from
   * the screen to the radar had no way to know they were reading the same
   * verdict — and "Act" is a stronger word than anything this site is entitled
   * to say about an engine with no cleared record.
   *
   * VERDICT is now the one source. It is the radar's vocabulary because that
   * is the set test/ui.mjs already pins against the live page — the screen's
   * was the outlier, and it was the outlier precisely because no test looked
   * at it. VD_WORD and VERDICT_LOOK are both derived from it so the two call
   * shapes keep working without a third spelling appearing.
   *
   * UNRATED is here as well as being the fallback: the radar had no entry for
   * it and reached the default by accident, which works right up until someone
   * changes the default. */
  /* DESCRIPTIONS, NOT INSTRUCTIONS (2026-09-30).
   *
   * The words were "Buy" and "Avoid" — instructions, on a site whose own
   * disclaimer says nothing here is a recommendation to buy or sell, run by a
   * publisher not registered with SEBI as an RA or IA. verdict.py's codes are
   * unchanged (BUY, WAIT, WATCH, AVOID stay in the data, in the tests and in
   * every filter); what a reader sees now says which of the screen's rules
   * passed, which is what the code has always meant:
   *
   *   BUY    tradeable, thesis holds, entry quality passes  → Criteria met
   *   WAIT   thesis holds, the entry does not               → Entry not met
   *   AVOID  failed a tradeability or accounts gate          → Fails screen
   */
  const VERDICT = {
    BUY:     ['up',   'Criteria met'],
    WAIT:    ['warn', 'Entry not met'],
    WATCH:   ['',     'Watch'],
    AVOID:   ['dn',   'Fails screen'],
    UNRATED: ['',     'Not rated'],
  };
  const verdictWord = c => (VERDICT[c] || VERDICT.UNRATED)[1];
  const VD_WORD = Object.fromEntries(
    Object.entries(VERDICT).map(([k, [, w]]) => [k, w]));

  /* ── A BREACHED STOP VOIDS THE SETUP, WHEREVER THE SETUP IS SHOWN ────────
   *
   * The rule was written INSIDE wireRadar, as four characters of comparison
   * buried in a live-price overlay, so it was true on /radar and nowhere
   * else. The front page's conviction slate is the worse case: it awaits live
   * quotes and then prints
   *
   *     Live ₹482.10          (live)
   *     Stop ₹511.00  -4.2%   (at the build)
   *     84/100 · 2.4:1        (at the build)
   *
   * with the live price and the dead stop four lines apart in the same card,
   * and nothing saying the plan between them no longer applies. Five names,
   * on the first screen of the front page.
   *
   * Not "pauses": the entry was chosen because of a level that has since
   * failed, so re-entering there is acting on a falsified premise. What is
   * NOT done is recompute the score — inventing a fresh number in the browser
   * is the fault this site avoids everywhere else. It keeps its value and
   * says when it was taken.
   *
   * NULLISH IS REJECTED BEFORE ANY COERCION, and the first version of this
   * did not do it. `stopVoid(p._live && p._live.price, p.stop)` hands over
   * `null` when the quote endpoint has not answered; `Number(null)` is 0, 0
   * is finite, and 0 is below every stop — so every card on the front page
   * voided the moment the price feed was down, and the route then threw
   * reading `.price` off the null it had just called a breach. A feed outage
   * rendered as five broken setups, which is the opposite of the truth.
   *
   * So: both must be PRESENT, both must be finite, and the live price must be
   * above zero — a zero quote is a missing one, not a stock that went to
   * nothing. A missing quote is not a breach; a missing stop is not a setup
   * that survives, it is one this cannot speak about, so it says nothing. */
  const stopVoid = (live, stop) => {
    if (live == null || stop == null || live === '' || stop === '') return false;
    const p = Number(live), st = Number(stop);
    return Number.isFinite(p) && p > 0 && Number.isFinite(st) && st > 0 && p <= st;
  };
  const STOP_VOID_WHY = (live, stop) =>
    `The published stop ${price(stop)} was broken at ${price(live)}. The call, `
    + `the score and the reward-to-risk beside it were measured at the build `
    + `price, before this. A new setup needs a new level, not this one again.`;

  const verdictBlock = r => {
    const v = r.vd;
    if (!v) return '';
    const flags = (v.f || []).map(f =>
      `<div class="vd-flag"><b>${esc(f.w)}</b><span>${esc(f.e)}</span></div>`).join('');
    return `<div class="vd vd-${esc((v.c || '').toLowerCase())}">
      <div class="vd-head">
        <span class="pill ${VD_CLASS[v.c] || 'pill-ac'}">${esc(VD_WORD[v.c] || v.c)}</span>
        <b>${esc(v.l || '')}</b>
        ${v.k ? `<span class="vd-conf" title="How well the underlying data supports this reading — not how likely it is to work.">${esc(v.k)} confidence</span>` : ''}
      </div>
      <p class="vd-line">${esc(v.o || '')}</p>
      ${v.t ? `<p class="vd-trig"><i>What would change it</i> ${esc(v.t)}</p>` : ''}
      ${v.a?.length ? `<p class="vd-also">Also reads as a ${v.a.map(esc).join(' and a ')} case.</p>` : ''}
      ${flags}
      <p class="vd-foot">A rules-based reading of the published accounts and price data — every
        threshold is fixed in advance and visible in <code>verdict.py</code>. It is not a forecast,
        carries no expectancy, and is not advice.</p>
    </div>`;
  };

  /* THE TARGET LADDER.
   * Three targets that sit on levels price actually turned at, each carrying
   * the MEASURED share of closed trades that ran that far — see targets.py.
   *
   * The reach percentages are deliberately unflattering. Stripping cf_1h,
   * whose record is FX pairs with 0.08% stops against claimed 21% moves, the
   * ledger says T1 is reached 19% of the time and T3 3%. Publishing a target
   * without that number is what made the old 4.0R level look like a plan; it
   * had never once been hit.
   *
   * `basis` is an index into screen.json's ladder.basis legend — the same few
   * dozen strings repeat across 750 rows, so they ship once. */
  /* The legend is captured wherever the feed is read, not at one call site:
   * /screen.json is fetched from six places (the screen route, the front
   * page's second pass, the command bar, the record). Hooking one of them left
   * the "Because" column blank whenever the card was reached by another. */
  /* Kept on `window` deliberately. The legend arrives with whichever
   * /screen.json read happens first, and the company card can be opened from
   * routes that resolved theirs earlier — a module-local `let` read empty on
   * whichever path lost that race, and the "Because" column shipped blank. On
   * window it is also inspectable from the console when it does go wrong. */
  const noteLadder = feed => {
    // get() resolves to a WRAPPER — {ok, data, error} — while CACHED() and a
    // plain fetch resolve to the feed itself. Reading only `feed.ladder`
    // silently missed every get() call, which is all of them, and the
    // "Because" column shipped blank while the data was perfectly correct.
    const f = feed && feed.data ? feed.data : feed;
    if (f && f.ladder && !window.__ladderMeta) window.__ladderMeta = f.ladder;
    return feed;
  };
  const ladderMeta = () => window.__ladderMeta || null;
  const basisText = i => (typeof i === 'number'
    ? (ladderMeta()?.basis?.[i] ?? '') : (i || ''));

  const reachClass = n => n >= 15 ? 'pill-up' : n >= 7 ? 'pill-wn' : 'pill-dn';

  /* The screen's own entry/stop/target ladder was a SECOND set of levels for
     a stock (audit item 5: STLTECH carried three different plans). Signal V2
     has one plan per stock, from one feed, so the screen no longer prints
     levels of its own. */
  const ladderBlock = () => '';

  /* THE CALL IS A COLUMN.
   *
   * Every one of the 750 rows carries `vd` — verdict.py's call on the stock,
   * computed at build time: 204 BUY, 24 WAIT, 19 AVOID, 503 WATCH today. None
   * of it reached the table. A reader ranked 750 names by composite score and
   * had to open a sheet, one name at a time, to find out whether the site
   * thought any of them was actionable. The one field that changes what
   * somebody does was the one field behind a tap.
   *
   * It leads the numbers, because it is the reason for the row rather than one
   * more measurement of it.
   *
   * ── AND THE TRACKS NOW MATCH THE CELLS ─────────────────────────────────
   * `.scr-r` declared eight grid tracks and this function emitted TEN cells.
   * The last two — 52w low and 52w high — wrapped onto a second grid line and
   * landed in tracks one and two, so they rendered underneath the rank number
   * and the company name at 24px and 700px wide, and their headers did the
   * same. Measured on the live page: "52w low" sat at x=130 in a 24px box.
   * Two columns of the table were unreadable and unlabelled, which is the
   * exact failure the comment above the CSS rule was written about.
   *
   * They are not given tracks; they are given to the price line. That line
   * already RUNS from the 52-week low to the 52-week high — labelling its two
   * ends is what those two numbers are for, it removes two columns from an
   * eleven-column table, and it makes the line legible without a key. */
  /* A heading that sorts. The screen is a div grid rather than a <table> — it
     has to be, because each row carries a 52-week bar under it — so the
     generic table sorter does not reach it and the columns needed wiring to
     the ranking the page already had. */
  const hCol = (k, label, cls = 'x') => {
    const on = scrSort === k;
    return `<span class="${cls} scr-h${on ? ' on' : ''}" data-s="${k}" role="button"
      tabindex="0" aria-sort="${on ? (scrDir === 'asc' ? 'ascending' : 'descending') : 'none'}"
      title="Sort by ${esc(label)}">${esc(label)}${
        on ? `<i class="scr-ar">${scrDir === 'asc' ? '▲' : '▼'}</i>` : ''}</span>`;
  };

  const screenTable = (rows, offset) => `<div class="rank">
    <div class="rank-r rank-head scr-r scr-call">
      <span class="i">#</span>${hCol('sym', 'Name', 's')}
      <span class="x">Call ${tip('call')}</span>
      ${hCol('price', 'Price')}${hCol('r1d', 'Today')}${hCol('v50', 'vs 50D')}
      ${hCol('v200', 'vs 200D')}${hCol('rsi', 'RSI 14D')}${hCol('r1m', '1M', 'm')}
    </div>
    ${rows.map((r, i) => {
      const v50 = r.sma50 ? (r.price - r.sma50) / r.sma50 * 100 : null;
      const v200 = r.sma200 ? (r.price - r.sma200) / r.sma200 * 100 : null;
      const vc = (r.vd && r.vd.c) || null;
      /* data-sym opens the sheet, which keeps your place in 750 rows.
       * data-href gives the same row a real destination, so the company page
       * is reachable and shareable rather than existing only behind a tap. */
      return `<div class="rank-r scr-r scr-call" data-sym="${esc(r.sym)}" data-href="/stock/${encodeURIComponent(r.sym)}" role="button" tabindex="0">
        <span class="i">${(offset || 0) + i + 1}</span>
        <span class="s">${watchBtn(r.sym)}<b>${esc(r.sym)}</b><span>${esc(r.name || '')}</span>${instiBadge(r.sym)}</span>
        <span class="x" data-l="Call">${vc
          ? `<span class="vtag v-${esc(vc.toLowerCase())}" title="${esc((r.vd.o || '') + (r.vd.l ? ' · ' + r.vd.l : ''))}">${esc(VD_WORD[vc] || vc)}</span>`
          : '—'}</span>
        <span class="x" data-l="Price" data-px>₹${esc(r.price ?? '—')}</span>
        <!-- Filled by the live quote call below. An em dash, not a bullet: a
             cell that never fills should read as "not measured" like every
             other unmeasured cell on this site, not as a decorative dot. -->
        <span class="x" data-l="Today" data-day style="color:var(--dim)">—</span>
        <span class="x ${dir(v50)} ${heatCell(v50, 8)}" data-l="vs 50D" data-v50>${v50 == null ? '—' : pct(v50)}</span>
        <span class="x ${dir(v200)} ${heatCell(v200, 20)}" data-l="vs 200D" data-v200>${v200 == null ? '—' : pct(v200)}</span>
        <span class="x" data-l="RSI" style="color:${(r.rsi ?? 50) > 70 ? 'var(--warn)' : (r.rsi ?? 50) < 35 ? 'var(--accent)' : 'var(--dim)'}">${r.rsi != null ? Math.round(r.rsi) : '—'}</span>
        <span class="m ${dir(r.r1m)} ${heatCell(r.r1m, 12)}" data-l="1 month">${pct(r.r1m)}</span>
        <span class="pl-w">${priceLine(r)}${plEnds(r)}</span>
      </div>`; }).join('')}</div>`;

  /* The two ends of the line, named. The bar was drawn between two numbers the
   * reader could not see; these are those numbers, each with how far the close
   * sits from it. */
  const plEnds = r => {
    if (r.low52 == null || r.high52 == null || !(Number(r.high52) > Number(r.low52))) return '';
    return `<span class="pl-ends">
      <span><em>52w low</em>${price(r.low52)}${r.price ? gap(r.price, r.low52) : ''}</span>
      <span><em>52w high</em>${price(r.high52)}${r.price ? gap(r.price, r.high52) : ''}</span>
    </span>`;
  };

  /* THE DISTANCE FROM AN EXTREME, WITHOUT A SIGNED ZERO.
   *
   * Both cells used `.toFixed(0)` on the raw ratio, and `(-0.195).toFixed(0)`
   * is the string "-0". Nine of today's 750 rows print "-0%" against their
   * 52-week high — and they are precisely the rows a breakout screen exists to
   * surface, so the defect lands on the most-read numbers in the table. The
   * site already fixed this once in pct(); this pair of cells never got it.
   *
   * The low-side cell also hardcoded a "+" and the up colour, which would
   * render "+-4%" in green for a price that had broken below its own 52-week
   * low. No row does that today — low52 is rebuilt with the price — but a
   * formatter that can emit "+-4%" is one build away from doing it.
   *
   * Under 1% the digit is kept, because "0%" and "0.4% off the high" are
   * different facts at exactly the place on this table where the difference
   * matters. */
  const gap = (px, ref) => {
    const a = Number(px), b = Number(ref);
    if (!isFinite(a) || !isFinite(b) || b === 0) return '';
    const raw = (a - b) / b * 100;
    const r = Math.abs(raw) < 1 ? Number(raw.toFixed(1)) : Math.round(raw);
    const txt = r === 0 ? '0%' : (r > 0 ? '+' : '') + r + '%';
    return `<i class="u52 ${r > 0 ? 'up' : r < 0 ? 'dn' : ''}">${txt}</i>`;
  };

  /* THE CARD. Same fields the broadsheet's modal shows, from the same
   * screen.json — the 3.1 MB screen-detail.json is not needed for any of it,
   * and downloading it would undo the point of this surface. */
  /* Any symbol, from any route.
   *
   * openStock needed SCREEN, and SCREEN was only fetched by the Screen route —
   * so a name on Today, Markets, Ideas or a sector drill-down looked clickable
   * and did nothing. That is why COFORGE, QPOWER and ATHERENERG would not
   * open. The universe is now fetched on first use from wherever the reader
   * is, and cached for the session. */

  /* ── THE PRICE HISTORY ON A COMPANY CARD ─────────────────────────────────
   *
   * Daily, weekly and monthly are three different questions, not three zoom
   * levels of one: daily is "what has it done lately", monthly is "what has
   * it done at all". So each timeframe shows the window that timeframe is
   * good for, and says which window that is, rather than pretending 24 points
   * and 130 points are the same chart at different magnifications.
   *
   * One 2-year daily request per card feeds all three. Weekly and monthly are
   * the LAST CLOSE of each week and month — the same convention the rest of
   * this site uses for a period's price, and the only one that can be derived
   * from closes without inventing a high or a low the feed never sent.
   */
  const CHARTC = new Map();          // sym -> 2y of daily closes, per session

  const isoWeekKey = d => {
    // Thursday of the same week decides the year, which is what makes an ISO
    // week in late December belong to the right one.
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
  };

  // Last close per bucket, order preserved.
  const bucketLast = (pts, keyOf) => {
    const m = new Map();
    for (const p of pts) m.set(keyOf(p.t), p);
    return [...m.values()];
  };

  const TFS = {
    d: ['Daily',   p => p.slice(-130)],
    w: ['Weekly',  p => bucketLast(p, isoWeekKey)],
    m: ['Monthly', p => bucketLast(p, t => t.slice(0, 7))],
  };

  /* THE LABEL IS MEASURED FROM THE DATA, NOT DECLARED ABOVE IT.
   *
   * These captions were fixed strings — "2 years of weekly closes" — and were
   * wrong for every name younger than the window. QPOWER listed in 2025, so
   * its weekly chart is eighteen months and was captioned two years, with the
   * axis underneath printing the real first date and contradicting it. The
   * request asks for two years; what came back is what the company has. */
  const humanSpan = (a, b) => {
    const months = Math.round((new Date(b) - new Date(a)) / 2629800000);
    if (months < 2) return 'a few weeks';
    if (months < 22) return `${months} months`;
    const y = months / 12;
    return `${y % 1 < 0.15 ? Math.round(y) : y.toFixed(1)} years`;
  };

  /* Area + line + endpoint. Coloured by the direction of the WINDOW being
   * shown, not of the day — on a monthly chart the day's move is not the
   * story. viewBox units with preserveAspectRatio="none" so it stretches to
   * whatever width the card has without a resize listener. */
  function cardChart(pts) {
    if (!pts || pts.length < 2) return `<div class="empty">No price history for this name.</div>`;
    const W = 600, H = 150, PAD = 4;
    const ys = pts.map(p => p.c);
    const lo = Math.min(...ys), hi = Math.max(...ys), span = (hi - lo) || 1;
    const x = i => (i / (pts.length - 1)) * W;
    const y = v => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
    const up = ys[ys.length - 1] >= ys[0];
    const chg = ((ys[ys.length - 1] - ys[0]) / ys[0]) * 100;
    return `<div class="cc-w">
      <svg class="cc-s ${up ? 'up' : 'dn'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
           role="img" aria-label="${esc(pts.length)} closes, ${pct(chg)} over the window">
        <path class="cc-a" d="${d}L${W},${H}L0,${H}Z"/>
        <path class="cc-l" d="${d}"/>
      </svg>
      <div class="cc-ax">
        <span>${esc(pts[0].t)}</span>
        <span class="cc-hl">low <b>${fmtN(lo)}</b> · high <b>${fmtN(hi)}</b></span>
        <span>${esc(pts[pts.length - 1].t)}</span>
      </div>
      <div class="cc-sum">
        <b class="${up ? 'up' : 'dn'}">${pct(chg)}</b> over this window ·
        ${pts.length} closes
      </div>
    </div>`;
  }

  async function wireCardChart(sym) {
    const host = document.getElementById('ccHost');
    if (!host) return;
    let pts = CHARTC.get(sym);
    if (!pts) {
      const r = await get(`/api/signals?series=${encodeURIComponent(sym)}&range=2y`);
      if (!r.ok || !(r.data.points || []).length) {
        host.innerHTML = `<div class="empty">Price history did not load${r.ok ? '' : ' — ' + esc(r.error)}.</div>`;
        return;
      }
      pts = r.data.points;
      CHARTC.set(sym, pts);
    }
    let tf = 'd';
    const draw = () => {
      const [label, fn] = TFS[tf];
      const shown = fn(pts);
      const blurb = shown.length > 1
        ? `${humanSpan(shown[0].t, shown[shown.length - 1].t)} of ${label.toLowerCase()} closes`
        : 'not enough history';
      host.innerHTML = `<div class="cc-h">
          <div class="chips cc-tabs" role="group" aria-label="Timeframe">
            ${Object.entries(TFS).map(([k, [l]]) =>
              `<button type="button" class="chip" data-tf="${k}" aria-pressed="${k === tf}">${esc(l)}</button>`).join('')}
          </div>
          <span class="cc-b">${esc(blurb)}</span>
        </div>${cardChart(shown)}`;
      host.querySelectorAll('[data-tf]').forEach(b =>
        b.addEventListener('click', () => { tf = b.dataset.tf; draw(); }));
    };
    draw();
  }

  /* The same card as a PAGE. The sheet is for keeping your place in a table;
   * this is for a link you can send someone. One builder, two frames. */
  /* ══ INDICATORS, THE BIBLE, AND THE ACTION PLAN ═══════════════════════════
   *
   * Akshay: "verdict, bible summary, action plan, seasonality — unique
   * indicators from tradingview that help decision making."
   *
   * WHAT AN INDICATOR IS FOR HERE. The screen already publishes ninety raw
   * fields per name, and a reader still has to hold six of them in their head
   * to reach a view. These are DERIVED: each answers a question the raw
   * numbers only imply, and each says WHICH WAY IT LEANS, so a picture can be
   * assembled rather than interpreted.
   *
   * Every one is computed from fields already on the row. No new feed, and no
   * indicator that needs tick data this site does not have — the same limit
   * the PIVOT engine states about orderflow applies here, for the same reason.
   */

  /* SIGNED, unlike lvl(). lvl() treats zero and below as absence because no
     traded instrument has a price of zero — correct for a level, and WRONG for
     a six-month return of −7.4%, which it would silently turn into "no data".
     Returns, distances and spreads go through this one. */
  const sn = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /* ── THE BENCHMARK IS THE SCREEN'S OWN MEDIAN, NOT THE NIFTY ──────────────
   * Relative strength needs something to be relative TO, and the obvious
   * choice — the index — is the wrong one here. The Nifty is 50 names; this
   * screen is 989, most of them outside it. Measuring a smallcap against the
   * Nifty tells you about large-cap flows, not about whether this name beat
   * its own peers.
   *
   * The median of the 989 is computed from the SAME rows being ranked, so it
   * can never be stale relative to them and needs no second feed. Memoised
   * because it walks the whole screen; invalidated by length, which changes
   * whenever the screen is replaced.
   */
  let _bench = null, _benchN = -1;
  const benchmark6m = () => {
    if (!Array.isArray(SCREEN) || !SCREEN.length) return null;
    if (_benchN === SCREEN.length) return _bench;
    const v = SCREEN.map(r => sn(r.r6m)).filter(x => x != null).sort((a, b) => a - b);
    _benchN = SCREEN.length;
    _bench = v.length < 50 ? null : v[Math.floor(v.length / 2)];
    return _bench;
  };

  const indicators = (r) => {
    const out = [];
    const add = (k, v, lean, why) => out.push({ k, v, lean, why });

    const px = lvl(r.price), hi = lvl(r.high52), lo = lvl(r.low52);
    const s50 = lvl(r.sma50), s200 = lvl(r.sma200), atr = lvl(r.atr_pct);

    /* 1. RELATIVE STRENGTH — the comparative study TradingView users reach for
          first, and the one thing a raw return cannot tell you. A stock up 4%
          in a market up 12% is WEAK; printing "+4%" says the opposite. */
    const bench = benchmark6m(), r6 = sn(r.r6m);
    if (r6 != null && bench != null) {
      const rs = r6 - bench;
      add('Relative strength', (rs > 0 ? '+' : '') + rs.toFixed(1) + 'pp',
          rs > 8 ? 'up' : rs < -8 ? 'dn' : '',
          `Six months against the median of all ${SCREEN.length} names on the screen — ${
            rs > 0 ? 'ahead of' : 'behind'} the typical stock by ${Math.abs(rs).toFixed(1)} points.`);
    }

    /* 2. DISTANCE TO THE 200-DAY, IN ATR. A percentage is not comparable
          across names: a stock that moves 4% a day sitting 8% above its
          average is closer, in the only unit that matters, than a quiet one
          4% above. This is the unit every stop on this site is set in. */
    if (px != null && s200 != null && atr != null) {
      const d = (px - s200) / px * 100 / atr;
      add('Distance to the 200-day', (d > 0 ? '+' : '') + d.toFixed(1) + ' ATR',
          Math.abs(d) < 1.5 ? '' : d > 0 ? 'up' : 'dn',
          Math.abs(d) < 1.5
            ? 'Sitting on its own 200-day — the level a reaction is most likely from, either way.'
            : d > 0 ? 'Well clear of its 200-day, so the obvious stop is a long way below.'
                    : 'Below its 200-day, which becomes resistance from underneath.');
    }

    /* 3. WHERE IT SITS IN ITS OWN YEAR. */
    if (px != null && hi != null && lo != null && hi > lo) {
      const pos = (px - lo) / (hi - lo) * 100;
      add('Position in its year', Math.round(pos) + '%',
          pos > 80 ? 'up' : pos < 20 ? 'dn' : '',
          pos > 80 ? 'Near the top of its 52-week range — where breakouts happen, and where they fail.'
            : pos < 20 ? 'Near the bottom of its range. Cheap, or still falling; the range cannot tell them apart.'
            : 'Mid-range, so there is no extreme to lean on in either direction.');
    }

    /* 4. THE SHAPE THE CHART OFFERS. Room to the year's high against the fall
          to the 200-day — the closest thing a chart gives you to a reward-to-
          risk before any engine is involved. Only computed when price is ABOVE
          the 200-day; below it the denominator is a rise, not a risk. */
    if (px != null && hi != null && s200 != null && px > s200 && hi > px) {
      const rr = (hi - px) / (px - s200);
      add('Chart reward to risk', rr.toFixed(1) + 'x',
          rr >= 2 ? 'up' : rr < 1 ? 'dn' : '',
          `Room to the 52-week high measured against the drop to its 200-day. Not a trade — the shape is ${
            rr >= 2 ? 'favourable' : rr < 1 ? 'poor' : 'unremarkable'} before anything else is considered.`);
    }

    /* 5. PARTICIPATION. */
    const vs = sn(r.vol_spike);
    if (vs != null && vs > 0) {
      add('Volume against its norm', vs.toFixed(2) + 'x',
          vs >= 1.5 ? 'up' : vs < 0.7 ? 'dn' : '',
          vs >= 1.5 ? 'Trading well above its own average — something is being acted on.'
            : vs < 0.7 ? 'Quieter than usual. A move on thin volume convinces less.'
            : 'Ordinary participation.');
    }

    /* 6. THE TREND STACK — one of the few places a three-state answer is the
          honest one, and the screen already computes it as `stack`. */
    if (px != null && s50 != null && s200 != null) {
      const stacked = px > s50 && s50 > s200, broken = px < s200;
      add('Trend alignment', stacked ? 'Aligned' : broken ? 'Broken' : 'Mixed',
          stacked ? 'up' : broken ? 'dn' : '',
          stacked ? 'Price over the 50-day over the 200-day — the textbook uptrend, stated plainly.'
            : broken ? 'Price is under its 200-day: the long trend is down, whatever the last month did.'
            : 'The two averages disagree with each other. Nothing to lean on.');
    }

    /* 7. WHAT THE BOOKS SAY, IN ONE NUMBER. Piotroski is nine yes/no tests of
          profitability, leverage and efficiency — a fundamental counterweight
          to six technical readings, and already on the row. */
    const pio = sn(r.piotroski), pof = sn(r.piotroski_of) || 9;
    if (pio != null) {
      add('Piotroski score', pio + ' of ' + pof,
          pio >= 7 ? 'up' : pio <= 3 ? 'dn' : '',
          pio >= 7 ? 'Passes most of the nine accounting tests — the books agree with the chart or argue with it.'
            : pio <= 3 ? 'Fails most of the nine accounting tests. A technical case here is fighting the statements.'
            : 'Middling on the nine accounting tests.');
    }

    /* 8. HOW EXPENSIVE, AGAINST ITSELF. A PE means nothing across sectors; a
          PE percentile against the name's OWN history means something. */
    const pep = sn(r.pe_pctile);
    if (pep != null) {
      add('Valuation vs its own history', Math.round(pep) + 'th pct',
          pep <= 30 ? 'up' : pep >= 80 ? 'dn' : '',
          pep <= 30 ? 'Cheaper than it has usually traded on its own earnings.'
            : pep >= 80 ? 'More expensive than it has usually been. Multiple expansion is doing the work.'
            : 'Priced about where it normally is.');
    }
    return out;
  };

  /* ── SEASONALITY, AS TWELVE BARS ─────────────────────────────────────────
   * The CURRENT month is outlined, because that is the only one a reader is
   * deciding inside. Names without eight completed observations show "not
   * enough history" rather than a number — a three-year hit rate would read
   * exactly as confident as a ten-year one, which is the whole trap. */
  const seasBlock = (sym) => {
    const d = SEAS && SEAS.stocks && SEAS.stocks[sym];
    if (!d || !d.m) {
      return `<p class="hint">No seasonal record for this name. A calendar month needs
        eight completed observations over eleven years to appear here at all, and this one
        does not have them — shown as unknown rather than as a number.</p>`;
    }
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date().getMonth();
    return `<div class="seas">${d.m.map((m, i) => {
      const hit = m ? m[0] : null;
      const cls = hit == null ? 'sx-na' : hit >= 67 ? 'sx-hi' : hit >= 50 ? 'sx-mid' : 'sx-lo';
      return `<div class="sx ${cls}${i === now ? ' sx-now' : ''}" title="${esc(names[i])}: ${
          m ? `rose in ${m[0]}% of ${m[2]} years, median ${m[1] > 0 ? '+' : ''}${m[1]}%` : 'not enough history'}">
          <i style="height:${m ? Math.max(6, hit) : 4}%"></i>
          <span>${esc(names[i])}</span><em>${m ? m[0] + '%' : '—'}</em>
        </div>`;
    }).join('')}</div>
    <p class="hint">How often ${esc(bareSym(sym))} rose in each calendar month across ${d.y} years —
      the bar is the hit rate, the tooltip carries the median move, and this month is outlined.
      <b>Historical, not predictive.</b> A calendar has no claim on a price; this records what
      repeatedly happened, which is a weaker and more honest statement than a forecast.</p>`;
  };

  /* ── THE ACTION PLAN ─────────────────────────────────────────────────────
   *
   * Akshay asked for both readings: the mechanical plan, and the diagnostic
   * folded underneath it.
   *
   * THE HARD PART IS THAT THIS SITE'S OWN LEDGER SAYS NO ENGINE HAS EARNED
   * TRUST — nothing has cleared 30 closed trades at t ≥ 2. So the plan states
   * what the levels ARE and what acting on them would mean, and never says
   * "buy". That is not hedging. It is the position every other surface here
   * holds, and a page that dropped it to sound decisive would be contradicting
   * the record two clicks away.
   */
  const actionPlan = (r) => {
    const px = lvl(r.price), s200 = lvl(r.sma200), atr = lvl(r.atr_pct), hi = lvl(r.high52);
    const vd = String((r.vd && r.vd.c) || '').toUpperCase();
    const ind = indicators(r);
    const agree = ind.filter(x => x.lean === 'up').length;
    const against = ind.filter(x => x.lean === 'dn').length;

    /* THE STOP IS A LEVEL, NOT A PERCENTAGE — the rule the PIVOT engine and
       signals/indicators.py both hold. Below the 200-day when price is above
       it, floored at 8% so a name 40% extended does not get a stop nobody
       would ever honour. Otherwise an ATR band, because there is no structure
       underneath to use. */
    const stop = (px != null && s200 != null && px > s200)
      ? Math.max(s200, px * 0.92)
      : (px != null && atr != null ? px * (1 - Math.min(0.08, atr * 1.5 / 100)) : null);
    const risk = (px != null && stop != null && px > stop) ? (px - stop) / px * 100 : null;

    const seas = SEAS && SEAS.stocks && SEAS.stocks[r.sym];
    const thisM = seas && seas.m ? seas.m[new Date().getMonth()] : null;

    const L = [];
    if (px != null && stop != null && risk != null) {
      const onStop = stop === s200;
      L.push(`<li><b>The level that says you were wrong</b> — ${price(stop, '₹')}${
        onStop ? ', its 200-day average' : ''}, which is ${risk.toFixed(1)}% below today's price.
        Everything else follows from that number rather than from the entry.</li>`);
      /* Sized off the stop, not off the price — the same arithmetic sizerHtml()
         does for an open signal, stated here for a name that has no ticket. */
      const shares = Math.floor(5000 / (risk / 100) / px);
      if (shares > 0) {
        L.push(`<li><b>What one percent of risk buys.</b> On a ₹5,00,000 account, risking 1%
          against a ${risk.toFixed(1)}% stop is <b>${shares.toLocaleString('en-IN')} shares</b>
          — about ${price(shares * px, '₹')} of stock. Size comes off the stop distance; a wider
          stop buys fewer shares, not a bigger loss.</li>`);
      }
    }
    if (hi != null && px != null && hi > px) {
      L.push(`<li><b>The first place sellers are known to have been</b> — the 52-week high at
        ${price(hi, '₹')}, ${((hi - px) / px * 100).toFixed(1)}% away.</li>`);
    }
    if (thisM) {
      L.push(`<li><b>This calendar month, historically.</b> Rose in <b>${thisM[0]}%</b> of the last
        ${thisM[2]}, median <b>${thisM[1] > 0 ? '+' : ''}${thisM[1]}%</b>. ${
        thisM[0] >= 67 ? 'A supportive month on the record — context, not a reason.'
        : thisM[0] <= 40 ? 'A weak month on the record. Worth knowing before adding to it.'
        : 'No seasonal tilt either way.'}</li>`);
    }
    L.push(`<li><b>What would end it.</b> A daily <i>close</i> below ${
      stop != null ? price(stop, '₹') : 'the 200-day'} — not a dip toward it, a close through it.
      Intraday wicks took 58% of the stop-outs this site has measured.</li>`);

    return `<ol class="plan">${L.join('')}</ol>
      <p class="hint"><b>No engine here has cleared 30 closed trades at t ≥ 2</b>, so none of this
        is a recommendation. It is what the levels are and what acting on them would mean — a
        different thing, and the only one the record supports.</p>
      ${foldBody(`What agrees and what does not — ${agree} for, ${against} against`, `
        <div class="inds">${ind.map(x => `<div class="ind-r">
          <span class="ind-k">${esc(x.k)}</span>
          <span class="ind-v ${esc(x.lean)}">${esc(String(x.v))}</span>
          <span class="ind-w">${esc(x.why)}</span></div>`).join('')}</div>
        <p class="hint">The screen's own call is <b>${esc(vd || 'not scored')}</b>. Where these
          readings disagree with it, the disagreement is the interesting part — a name every
          measure likes is rarely still cheap.</p>`)}`;
  };

  /* ── THE BIBLE ───────────────────────────────────────────────────────────
   *
   * Akshay: "each thing can be seen like a verdict, bible summary, action
   * plan, seasonality."
   *
   * WHAT MAKES THIS A BIBLE RATHER THAN A FACTSHEET. The card below it already
   * prints every number. What no surface on this site did was JOIN them into
   * sentences — say what the company is, what it earns on the money it uses,
   * whether the growth is real, what you are paying for it, and where the
   * price sits — in the order a person actually forms a view.
   *
   * IT IS ASSEMBLED, NOT GENERATED. Every clause is a template over a field
   * that exists on the row, so there is no model call, nothing to rate-limit,
   * and no sentence that can assert a number the screen does not hold. A
   * missing field drops its clause rather than reaching for a filler phrase —
   * which is why the paragraphs vary in length between names, and should.
   */
  const bibleHtml = (r) => {
    const n = sn, N = (v, d = 1) => Number(v).toFixed(d).replace(/\.0$/, '');
    const nm = r.name || r.sym;
    const P = [];

    /* ─ What it is, and how big ─ */
    /* lvl(), not sn(): 24 of the 989 rows carry mcap_cr 0.0, which is absence
       written as a number — RELIANCE is one of them. sn() passes zero through
       and the lead sentence read "valued at ₹0 crore". No listed company has
       a market value of zero, so zero is missing here, and the clause drops. */
    const mc = lvl(r.mcap_cr);
    const tierWord = { mega: 'one of the largest companies on the exchange',
      large: 'a largecap', mid: 'a midcap', small: 'a smallcap',
      micro: 'a microcap — thinly traded, and the liquidity is part of the risk' }[r.tier];
    /* A crore figure, in the units an Indian reader actually uses. The first
       version divided by 1,000 and appended the string ",000 crore", which
       printed CRIZAC's ₹3,281 crore as "₹3.3,000 crore" — a number that is
       not wrong so much as not a number. Indian grouping does the work. */
    const crore = (v) => v >= 100000
      ? '₹' + (v / 100000).toFixed(2).replace(/\.?0+$/, '') + ' lakh crore'
      : '₹' + Math.round(v).toLocaleString('en-IN') + ' crore';
    P.push(`<p><b>${esc(nm)}</b> is ${esc(r.ind || r.sector || 'an NSE-listed company')}${
      mc != null ? `, valued at ${crore(mc)}` : ''}${
      tierWord ? ` — ${esc(tierWord)}` : ''}.</p>`);

    /* ─ What it earns on the money it uses. The single most important
         fundamental question, and the one a PE cannot answer. ─ */
    const roce = n(r.roce), roce_med = n(r.roce_med), nm_margin = n(r.net_margin);
    if (roce != null) {
      const drift = (roce_med != null && Math.abs(roce - roce_med) >= 3)
        ? ` Its own five-year median is ${N(roce_med)}%, so returns are ${
            roce > roce_med ? 'better than usual right now' : 'below what it has typically managed'}.`
        : '';
      P.push(`<p><b>What it earns on the money it uses.</b> ${N(roce)}% return on capital employed${
        roce >= 20 ? ' — genuinely high; a business that can reinvest at this rate compounds without needing to raise anything'
        : roce >= 12 ? ' — respectable, roughly what a decent business earns'
        : ' — low. Capital going in is not coming back at a rate that beats a fixed deposit by much'}.${drift}${
        nm_margin != null ? ` It keeps ${N(nm_margin)}% of revenue as profit.` : ''}</p>`);
    }

    /* ─ Is the growth real, and is it funded by debt? ─ */
    const rc = n(r.rev_cagr), ec = n(r.eps_cagr), de = n(r.de), cfp = n(r.cfo_pat);
    if (rc != null || ec != null) {
      const gap = (rc != null && ec != null)
        ? (ec > rc + 5 ? ' Earnings are growing faster than sales, which is margin expansion — real, but it cannot repeat forever.'
           : ec < rc - 5 ? ' Earnings are growing slower than sales, so margins are being squeezed on the way up.'
           : ' Earnings and sales are growing at about the same rate, which is the healthiest version of growth.')
        : '';
      P.push(`<p><b>Growth.</b> ${rc != null ? `Revenue has compounded at ${N(rc)}% a year` : ''}${
        rc != null && ec != null ? ', and earnings at ' + N(ec) + '%' : ec != null ? `Earnings have compounded at ${N(ec)}%` : ''}.${gap}${
        isLender(r) ? (de != null && de < 0 ? ' Debt to equity is below zero — negative equity, which is insolvency.'
          : ' It is a lender, so cash conversion and debt to equity are not read as quality here: it borrows to lend, and its operating cash flow moves with the loan book. Return on equity is the measure that applies.')
        : `${cfp != null ? ` Cash from operations covers ${N(cfp, 2)}x of reported profit${
          cfp >= 0.8 ? ' — the profit is arriving as cash' : ', so a meaningful part of the profit is not cash yet'}.` : ''}${
        de != null ? ` Debt to equity is ${N(de, 2)}${
          de < 0 ? ' — negative equity, which is insolvency' : de <= 0.1 ? ' — effectively debt-free' : de >= 1.5 ? ', which is leveraged; earnings swing harder in both directions' : ''}.` : ''}`}</p>`);
    }

    /* ─ What you are paying ─ */
    const pe = n(r.pe), pb = n(r.pb), pep = n(r.pe_pctile), dy = n(r.div_yield);
    if (pe != null || pb != null) {
      P.push(`<p><b>What it costs.</b> ${pe != null ? `${N(pe)}x earnings` : ''}${
        pe != null && pb != null ? ' and ' : ''}${pb != null ? `${N(pb, 2)}x book` : ''}.${
        pep != null ? ` Against its own history that is the ${Math.round(pep)}th percentile — ${
          pep <= 30 ? 'cheaper than it usually trades' : pep >= 80 ? 'dearer than it usually trades'
          : 'about where it normally sits'}.` : ''}${
        dy != null && dy > 0.5 ? ` It pays ${N(dy, 2)}% as dividend.` : ''}
        <span class="hint-i">A multiple is only ever a comparison. Against a different sector it means nothing;
        against its own ten years it means something.</span></p>`);
    }

    /* ─ Who holds it ─ */
    const ins = n(r.insiders), ist = n(r.instis);
    if (ins != null) {
      P.push(`<p><b>Who owns it.</b> Promoters hold ${N(ins)}%${
        ins >= 60 ? ' — a controlling stake, so the family and the minority shareholder are in the same boat'
        : ins <= 30 ? ' — a low promoter stake; no single owner has much at risk' : ''}${
        ist != null ? `, institutions ${N(ist)}%` : ''}.${
        ist != null && ist < 3 ? ' Almost no institutional ownership, which usually means nobody professional has looked, or they looked and passed.' : ''}</p>`);
    }

    /* ─ Where the price sits. Last, deliberately: the chart is the least
         durable of these facts and reading it first anchors everything after. ─ */
    const px = lvl(r.price), hi = lvl(r.high52), lo = lvl(r.low52);
    const fh = n(r.from_high), y1 = n(r.r1y), rsi = n(r.rsi);
    if (px != null) {
      P.push(`<p><b>Where the price is.</b> ${price(px, '₹')}${
        hi != null && lo != null ? `, inside a 52-week range of ${price(lo, '₹')} to ${price(hi, '₹')}` : ''}.${
        fh != null ? ` It is ${N(Math.abs(fh))}% ${fh < 0 ? 'below' : 'above'} that high.` : ''}${
        y1 != null ? ` Over a year it is ${y1 > 0 ? 'up' : 'down'} ${N(Math.abs(y1))}%.` : ''}${
        rsi != null ? ` RSI ${Math.round(rsi)}${rsi >= 70 ? ' — overbought on the standard reading' : rsi <= 30 ? ' — oversold on the standard reading' : ''}.` : ''}</p>`);
    }

    /* ─ The risks the screen itself flagged. Not editorial — these come off
         the row, and showing them here means the case and its objections sit
         on one screen instead of the objections living three folds down. ─ */
    /* A flag is {s: severity, t: what, k: the figure behind it} — an OBJECT,
       not a string. Joining the array directly printed [object Object] on the
       first name tested, which is the same shape of bug as printing a null
       target: the page renders, and what it renders is meaningless. */
    const flags = ((r.risk && r.risk.flags) || []).filter(f => f && f.t);
    if (flags.length) {
      P.push(`<p><b>What the screen holds against it.</b></p>
        <ul class="bible-f">${flags.map(f => `<li class="rf-${esc(f.s || 'med')}">
          ${esc(f.t)}${f.k ? ` <em>${esc(f.k)}</em>` : ''}</li>`).join('')}</ul>`);
    }

    /* THE VERDICT'S OWN KEYS, CHECKED AGAINST THE FEED RATHER THAN ASSUMED.
       `h` is the horizon bucket ("swing"), not a headline, and there is no `w`
       at all — the readable line is `l` and the reasoning is `o`. Guessing
       those would have rendered an empty heading under every call. */
    const vd = r.vd || {};
    return `${vd.c ? `<div class="bible-vd vd-${esc(String(vd.c).toLowerCase())}">
        <span class="bvd-k">${esc(verdictWord(String(vd.c).toUpperCase()))}</span>
        <span class="bvd-h">${esc(vd.l || '')}</span>
        ${vd.o ? `<p>${esc(vd.o)}.</p>` : ''}
        ${vd.t ? `<p class="bvd-t"><b>What would trigger it:</b> ${esc(vd.t)}.</p>` : ''}</div>` : ''}
      <div class="bible">${P.join('')}</div>
      <p class="hint">Assembled from the screen's own fields — every figure above is on this
        company's row and nothing here is written by a model. Where a number is missing, the
        sentence that needed it is absent rather than guessed.</p>`;
  };

  /* ── THE PAGE, IN THE ORDER A VIEW IS ACTUALLY FORMED ─────────────────────
   *
   * The sheet and the page share stockCard() and always will. What the PAGE
   * adds — and the sheet deliberately does not — is the four surfaces Akshay
   * asked for: the call, the written summary, the plan, and the seasonal
   * record. They are page-only because they are a five-minute read, and a
   * bottom sheet opened from the middle of a 989-row table is not where anyone
   * settles in for one.
   *
   * ORDER IS THE ARGUMENT. Verdict and written summary first, because they are
   * what a reader came for; the plan next, because it is only meaningful once
   * you know what the company is; seasonality after that, as context rather
   * than as a reason; and the full numeric card last, for anyone who wants to
   * check the assembly against its parts.
   */
  /* ── THE LIVE MARK, BECAUSE THE PAGE WAS THE ONLY SURFACE WITHOUT ONE ────
   *
   * Akshay, with four screenshots: "pure mismatch everywhere — if the heatmap
   * is right the inside is wrong, if the inside is right the chart is wrong.
   * All should be related and correctly flown."
   *
   * He was right about the flow. The numbers he compared were the heatmap at
   * ACMESOLAR ₹410, the chart at ₹410, and this page at ₹420.40 — one stock,
   * two answers, and the page a reader lands on FROM the heatmap was the one
   * disagreeing.
   *
   * NEITHER FIGURE WAS WRONG. ₹420.40 is the close the screen was BUILT from,
   * and every level under it — the entry, the stop, all three targets — is
   * measured from that close. ₹410 is where it trades now. The fault was that
   * the page showed only the first, labelled it "Screen close" in 11px at the
   * bottom of a card, and left the reader to find the other number elsewhere.
   *
   * So the live mark goes at the TOP, the gap between the two is stated in
   * words rather than left to be inferred, and the levels say out loud which
   * of the two they were set from. A page showing one price while the heatmap
   * shows another is a bug even when both figures are accurate. */
  const liveMark = (r, q) => {
    const close = lvl(r.price);
    if (!q || sn(q.price) == null) {
      return close == null ? '' : `<div class="lmk lmk-na">
        <span class="lmk-l">Screen close</span><b>${price(close, '₹')}</b>
        <span class="lmk-w">The live mark did not load. Everything below is measured from
          this close, which is what the screen was built on.</span></div>`;
    }
    const live = sn(q.price), chg = sn(q.change_pct);
    const gap = (close != null && live != null && close > 0)
      ? (live - close) / close * 100 : null;
    // The label follows the NSE session and calendar: a quote taken while the
    // exchange is shut is the last price, not "trading now" (audit item 17).
    const nseOpen = exchangeState('Asia/Kolkata', 9.25, 15.5, 'NSE').open;
    return `<div class="lmk ${chg > 0 ? 'is-up' : chg < 0 ? 'is-dn' : ''}">
      <span class="lmk-l">${nseOpen ? 'Trading now · delayed' : 'Last price · market closed'}</span><b>${price(live, '₹')}</b>
      ${chg == null ? '' : `<span class="lmk-c ${dir(chg)}">${pct(chg)} today</span>`}
      ${close == null ? '' : `<span class="lmk-w">
        The screen was built at <b>${price(close, '₹')}</b>${
          gap == null || Math.abs(gap) < 0.05 ? ', which is where it still trades'
            : `, ${Math.abs(gap).toFixed(1)}% ${gap > 0 ? 'below' : 'above'} this`}.
        The research figures below are measured from that close.</span>`}
    </div>`;
  };

  const stockPage = (r, q) => {
    const { body } = stockCard(r);
    return `<div class="route-h stock-h">
        <span class="eyebrow">Company · ${esc(r.sector || 'NSE')}${r.ind ? ' · ' + esc(r.ind) : ''}</span>
        <h1>${watchBtn(r.sym)}${esc(r.sym)}</h1>
        <p>${esc(r.name || '')} · <a class="to-vision" href="${visionUrl(r.sym)}">Open in Vision — what matters, what changed ↗</a></p>
      </div>
      ${liveMark(r, q)}
      ${/* NOT { lead: true }. That flag gives a section the route's hero
            treatment — display size, the full standfirst measure — and this
            page already has a hero: the ticker and the company name directly
            above. Two heroes stacked put a 60px sentence about assembly above
            the verdict it was introducing. The standfirst is a standfirst. */''}
      ${sec('The call, and the company behind it', bibleHtml(r), null,
            'What it does, what it earns, what it costs, and where the price sits — '
          + 'assembled from this company’s own row.')}
      ${sec('Signal V2 plan', v2StockBlock(r.sym), null,
            'The one canonical plan for this stock, if there is one — the same plan every page and Vision show.')}
      ${sec('What this month has historically done', seasBlock(r.sym), null,
            'Eleven years of calendar months. A record of what repeatedly happened, which is '
          + 'a weaker claim than a forecast and the only one the data supports.')}
      ${sec('Every number on its row', `<div class="stock-pg">${body}</div>`, null,
            'The card the screen opens, unchanged — so the summary above can be checked '
          + 'against the figures it was built from.')}
      <p class="hint stock-back"><a href="/screen">← All names</a> ·
        <a href="/map">The map</a> · <a href="/opportunities">Opportunities</a> ·
        <a href="/methodology">How a plan is made</a></p>`;
  };
  /* The sheet wires its own chart on open; the page has to do the same. */
  const wireStockPage = (r) => { wireCardChart(r.sym); };

  /* ── THE COMPANY CARD, BUILT ONCE ─────────────────────────────────────────
   *
   * Rendered in two places: as a bottom sheet from any table (keeps your place
   * in a 750-row list) and as the /stock/:sym page (has a URL, so it can be
   * shared, bookmarked and opened in a tab). They are the SAME markup from
   * this one function — the alternative is two cards that agree until one of
   * them is edited, which is the fault this file has already recorded twice
   * in other places.
   *
   * Returns {title, body}. It renders nothing itself and touches no DOM. */
  function stockCard(r) {
    const bar = (v, max = 100) => `<span class="mini-bar"><i style="width:${Math.max(0, Math.min(100, (v ?? 0) / max * 100)).toFixed(0)}%"></i></span>`;
    const score = (k, l) => r[k] == null ? '' : `<div class="sc-t">
      <span class="sc-l">${esc(l)}</span><span class="sc-v">${Number(r[k]).toFixed(1)}</span>${bar(r[k])}</div>`;
    const why = [];
    for (const t of (r.setup?.tags || [])) {
      if (/52W BREAKOUT/.test(t)) why.push(['Broke to a 52-week high', 'close above the prior 52-week range']);
      else if (/50D BREAKOUT/.test(t)) why.push(['Broke its 50-day high', 'close above the prior 50-day range']);
      else if (/20D BREAKOUT/.test(t)) why.push(['Broke its 20-day high', 'close above the prior 20-day range']);
      else if (t === 'RS LEADER') why.push(['Leads the market on relative strength', 'outperforming the index over 3 and 12 months']);
      else if (t === 'TREND INTACT') why.push(['Trend intact', 'price above the 50-day, 50 above the 200']);
      else if (t === 'OVERSOLD') why.push(['Oversold', `RSI ${r.rsi != null ? Math.round(r.rsi) : '—'}`]);
      else if (t === 'VOLUME') why.push(['Trading above its own average volume', `${(r.vol_spike ?? 0).toFixed(1)}x its average`]);
    }
    if ((r.roce ?? 0) >= 20) why.push([`Earns ${Math.round(r.roce)}% on capital employed`, 'ROCE, invested capital']);
    if ((r.de ?? 9) <= 0.1) why.push(['Effectively debt-free', `D/E ${r.de}`]);
    const flags = (r.risk?.flags || []);
    /* yoy() colours by sign, which is right for a growth rate and wrong for a
     * PE, a current ratio or a tax rate — none of which is "good" for being
     * positive. fact() states the number and lets the reader judge it. */
    /* One bounded reading. `zones` is [from, to, class, word] and decides both
     * the colour and the word beside the number, so the bar is never the only
     * carrier of meaning — the zone is written out for anyone who cannot see
     * the colour, or is reading it in grayscale. */
    const baro = (label, v, lo, hi, zones, fmt) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return `<div class="bar-r"><span class="bar-l">${esc(label)}</span>
        <span class="bar-v na">Not measured</span></div>`;
      const at = Math.max(0, Math.min(100, ((n - lo) / (hi - lo)) * 100));
      const z = zones.find(x => n >= x[0] && n < x[1]) || zones[zones.length - 1];
      return `<div class="bar-r">
        <span class="bar-l">${esc(label)}</span>
        <span class="bar-t"><i class="bar-f is-${esc(z[2] || 'flat')}" style="width:${at.toFixed(1)}%"></i>
          <i class="bar-p" style="left:${at.toFixed(1)}%"></i></span>
        <span class="bar-v ${esc(z[2] || '')}">${fmt(n)}<em>${esc(z[3])}</em></span>
      </div>`;
    };

    const fact = (l, v, unit = '%') => v == null || v === '' ? '' :
      `<div class="yy"><span>${esc(l)}</span><b>${
        typeof v === 'number' ? Number(v).toFixed(2).replace(/\.00$/, '') : esc(v)
      }${unit === 'pctile' ? '<i class="u">th pct</i>' : unit ? `<i class="u">${esc(unit)}</i>` : ''}</b></div>`;

    const yoy = (l, v, unit = '%') => v == null ? '' :
      `<div class="yy"><span>${esc(l)}</span><b class="${dir(v)}">${v > 0 ? '+' : ''}${Number(v).toFixed(1)}${unit}</b></div>`;
    /* A LEVEL IS NOT A CHANGE. Cash conversion, ROCE and debt/equity went
     * through yoy(), so every positive level printed "+" in green — a D/E of
     * 4.02 read "+4.0" as if it were good news. They are levels: no sign, no
     * colour. For a lender the three that do not apply say so. */
    const lvl = (l, v, unit = '', dp = 2) => v == null ? '' :
      `<div class="yy"><span>${esc(l)}</span><b>${Number(v).toFixed(dp)}${unit ? `<i class="u">${esc(unit)}</i>` : ''}</b></div>`;
    const na = l => `<div class="yy"><span>${esc(l)}</span><b class="na" title="${esc(LENDER_NOTE)}">n/a · lender</b></div>`;
    const lender = isLender(r);

    /* THE SAME LINE THE TABLES USE, AT CARD SIZE. It is the first thing on the
     * card because it answers the first question — where is this price in its
     * own year, and which of its own moving averages is it under — before any
     * ratio is read. Labelled here, unlike in a table row, because a card is
     * read on its own rather than under a header. */
    const cardLine = priceLine(r) ? `<div class="cardline">
      ${priceLine(r)}
      <div class="cardline-k">
        <span><b>₹${esc(r.low52)}</b> 52w low</span>
        <span><i class="k200"></i>200-day <b>₹${esc(r.sma200 ?? '—')}</b></span>
        <span><i class="k50"></i>50-day <b>₹${esc(r.sma50 ?? '—')}</b></span>
        <span><i class="k20"></i>20-day <b>₹${esc(r.sma20 ?? '—')}</b></span>
        <span><b>₹${esc(r.high52)}</b> 52w high</span>
      </div>
    </div>` : '';

    const title = `${watchBtn(r.sym)}${esc(r.sym)} <small>${esc(r.name || '')}</small>`;
    const body = `
      ${/* LABEL THE NUMBERS. This line read "₹1363.1 · Capital Goods ·
          * ₹10,556 cr · accounts to FY26" — two unexplained figures on the
          * first line of a company card. The first is the close the screen was
          * built from (the live mark is in the box below and will differ); the
          * second is market capitalisation. Neither says so, and a reader
          * asking "what is 1363?" is asking a fair question. */''}
      ${verdictBlock(r)}
      ${ladderBlock(r)}
      <div class="cardmeta">
        ${/* Named for what it IS. "Screen close" reads as a rival to the live
              mark above it; "the close the levels were set from" is the same
              figure doing its actual job, and stops a reader treating a
              difference between the two as an error. */''}
        <span><i>Close the levels use</i><b>₹${esc(r.price)}</b></span>
        <span><i>Market cap</i><b>₹${r.mcap_cr != null
          ? Math.round(r.mcap_cr).toLocaleString('en-IN') : '—'} cr</b></span>
        <span><i>Industry</i><b>${esc(r.ind || r.sector || '—')}</b></span>
        <span><i>Accounts to</i><b>${esc(r.fy || '—')}</b></span>
        ${/* ── FOUR FIGURES THE SCREEN COMPUTES AND NOTHING SHOWED ──────────
            * sd1y on all 750 rows, r3y_cagr on 635, roce_trend on 679,
            * next_earnings on 274 — computed every build, shipped inside a
            * 1.5MB file this page downloads anyway, rendered nowhere.
            *
            * Volatility because it is the denominator VECTOR ranks on and the
            * number that decides position size. ROCE trend because a return
            * without its direction is half a fact: "18%, peaked" and "18%,
            * improving" are different companies. And the results date because
            * a swing setup running into a print is a different trade — counted
            * in days, which is the form the decision is made in. */''}
        <span><i>Volatility 1y</i><b>${r.sd1y != null
          ? Number(r.sd1y).toFixed(0) + '%' : '—'}</b></span>
        <span><i>3Y CAGR</i><b class="${dir(r.r3y_cagr)}">${r.r3y_cagr != null
          ? Number(r.r3y_cagr).toFixed(0) + '%' : '—'}</b></span>
        <span><i>ROCE trend</i><b>${r.roce_trend ? esc(String(r.roce_trend)) : '—'}</b></span>
        ${(() => {
          if (!r.next_earnings) return '<span><i>Results</i><b>—</b></span>';
          const d = new Date(String(r.next_earnings).slice(0, 10) + 'T00:00:00');
          const days = Math.round((d - new Date()) / 86400000);
          const near = days >= 0 && days <= 10;
          return `<span><i>Results</i><b class="${near ? 'warn' : ''}">${
            days < 0 ? esc(String(r.next_earnings).slice(5, 10))
            : days === 0 ? 'today' : 'in ' + days + 'd'}</b></span>`;
        })()}
      </div>
      ${cardLine}
      <div id="ccHost" class="cc"><div class="sk" style="height:150px"></div></div>
      <div class="tags">${(r.setup?.tags || []).map(t => `<span class="pill pill-ac">${esc(t)}</span>`).join('')}
        ${r.risk?.level ? `<span class="pill ${r.risk.level === 'LOW' ? 'pill-up' : r.risk.level === 'HIGH' ? 'pill-dn' : 'pill-wn'}">RISK ${esc(r.risk.level)}</span>` + tip('risk') : ''}</div>
      <div class="sec-h" style="margin-top:var(--s-4)"><h2>Scores ${tip('score')}</h2></div>
      <div class="scores">
        ${score('comp', 'Composite')}${score('q', 'Quality')}${score('g', 'Growth')}
        ${score('em', 'Earnings mom.')}${score('cf', 'Cash flow')}${score('v', 'Value')}${score('tech', 'Technical')}
      </div>
      <div class="two">
        <div class="pane pane-ok"><h4>Why now</h4>${why.length ? why.map(([t, k]) =>
          `<div class="read read-for"><b>${esc(t)}</b><span>${esc(k)}</span></div>`).join('')
          : '<p class="hint">No setup is firing on this name today.</p>'}</div>
        <div class="pane pane-risk"><h4>What can go wrong</h4>${flags.length ? flags.map(f =>
          `<div class="read read-against"><b>${esc(f.t)}</b><span>${esc(f.k || '')}</span></div>`).join('')
          : '<p class="hint">No flags raised by the risk screen.</p>'}</div>
      </div>
      ${/* ── CAPITAL ALLOCATION ───────────────────────────────────────────
          * The card carried seven composite scores and not one plain fact
          * about the business: no PE, no book value, no ownership, no balance
          * sheet, no sign of how many years of accounts any of it rests on.
          * A screen that says "Quality 82.4" and cannot say what the company
          * earns on capital is asking to be taken on faith.
          *
          * The headline here is the Piotroski F-score, which is already in the
          * feed as a count out of nine — a real x/9 rather than a number
          * invented to look like one. It is nine yes/no tests on profitability,
          * leverage and operating efficiency, and it is the closest thing in
          * this data to a capital-allocation grade. */''}
      ${/* BAROMETERS, NOT A LIST OF NUMBERS.
          * RSI 66 and "+38.74% vs 200D" are readings on bounded scales, and a
          * bar shows where on the scale they sit in a way a numeral cannot.
          * Colour is by ZONE, not by sign: an RSI of 78 is not "good for being
          * high", it is overbought, and the bar says so. */''}
      <h4 class="sh">Where it is trading</h4>
      <div class="baro">
        ${baro('RSI (14)', r.rsi, 0, 100, [[0,30,'dn','oversold'],[30,50,'','soft'],[50,70,'up','firm'],[70,100,'wn','overbought']], v => Math.round(v))}
        ${baro('vs 20-day', r.sma20 && r.price ? (r.price - r.sma20) / r.sma20 * 100 : null, -20, 20,
               [[-20,-2,'dn','below'],[-2,2,'','at'],[2,20,'up','above']], v => pct(v))}
        ${baro('vs 50-day', r.sma50 && r.price ? (r.price - r.sma50) / r.sma50 * 100 : null, -30, 30,
               [[-30,-3,'dn','below'],[-3,3,'','at'],[3,30,'up','above']], v => pct(v))}
        ${baro('vs 200-day', r.sma200 && r.price ? (r.price - r.sma200) / r.sma200 * 100 : null, -50, 60,
               [[-50,-5,'dn','below'],[-5,5,'','at'],[5,60,'up','above']], v => pct(v))}
        ${baro('Volume vs own average', r.vol_spike, 0, 4,
               [[0,0.8,'dn','thin'],[0.8,1.5,'','normal'],[1.5,4,'up','heavy']], v => v.toFixed(2) + '×')}
        ${baro('From 52-week high', r.from_high, -60, 0,
               [[-60,-20,'dn','well below'],[-20,-5,'','below'],[-5,0,'up','near high']], v => pct(v))}
      </div>

      ${r.piotroski != null ? `<h4 class="sh">Capital allocation</h4>
      <div class="alloc">
        <div class="alloc-s">
          <b>${esc(r.piotroski)}<i>/${esc(r.piotroski_of ?? 9)}</i></b>
          <span class="alloc-bar"><i style="width:${
            Math.max(0, Math.min(100, (r.piotroski / (r.piotroski_of || 9)) * 100)).toFixed(0)}%"></i></span>
          <span class="alloc-l">Piotroski F-score${
            r.piotroski >= 7 ? ' · strong' : r.piotroski >= 5 ? ' · middling' : ' · weak'}</span>
        </div>
        <p class="alloc-n">Nine pass/fail tests on profit, leverage and efficiency.
          ${r.piotroski >= 7 ? 'Passing seven or more is the band associated with the better half of the market.'
            : r.piotroski >= 5 ? 'Five or six is unremarkable — it clears no bar and fails none.'
            : 'Below five is the band this test exists to flag.'}</p>
      </div>` : ''}

      <h4 class="sh">What you are paying${r.fy_count ? ` <em>· accounts for ${esc(r.fy_count)} year${r.fy_count > 1 ? 's' : ''}</em>` : ''}</h4>
      <div class="yoy">${fact('Price / earnings', r.pe, '')}${fact('Price / book', r.pb, '')}
        ${fact('PE vs its own 5-year range', r.pe_pctile, 'pctile')}${fact('Dividend yield', r.div_yield)}</div>

      <h4 class="sh">Balance sheet</h4>
      <div class="yoy">${fact('Debt / equity', r.de, '')}${lender ? na('Interest cover') + na('Current ratio') : `${fact('Interest cover', r.icover, 'x')}
        ${fact('Current ratio', r.curr, 'x')}`}${fact('Tax rate', r.tax)}</div>
      ${lender ? `<p class="alloc-n">A lender: debt/equity is its business model, not a risk reading. The screen leaves leverage, cash conversion, interest cover and ROCE out of this name's scores and risk grade.</p>` : ''}

      <h4 class="sh">Who owns it</h4>
      ${instiCard(r)}

      <h4 class="sh">Growth${r.fy_count ? ` <em>· compound, over ${esc(r.fy_count)} years of accounts</em>` : ''}</h4>
      <div class="yoy">${yoy('Revenue CAGR', r.rev_cagr)}${yoy('EBITDA CAGR', r.ebitda_cagr)}
        ${yoy('EPS CAGR', r.eps_cagr)}${fact('Earnings momentum', r.em_label, '')}</div>

      <h4 class="sh">Latest year on year</h4>
      <div class="yoy">${yoy('Revenue', r.rev_yoy)}${yoy('EBITDA', r.ebitda_yoy)}${yoy('Profit', r.pat_yoy)}
        ${yoy('EPS', r.eps_yoy)}${yoy('EBIT margin', r.margin_delta, 'pt')}</div>
      <h4 class="sh">Cash quality</h4>
      <div class="yoy">${lender ? na('Cash conversion (CFO/PAT)') + na('Free cash / profit') + na('ROCE') + lvl('ROE', r.roe, '%', 1)
        : `${lvl('Cash conversion (CFO/PAT)', r.cfo_pat, 'x')}${lvl('Free cash / profit', r.fcf_pat, 'x')}
        ${lvl('ROCE', r.roce, '%', 1)}${lvl('Debt / equity', r.de)}`}</div>
      <h4 class="sh">Where price sits</h4>
      <div class="yoy">${yoy('vs 50-day', r.sma50 ? (r.price - r.sma50) / r.sma50 * 100 : null)}
        ${yoy('vs 200-day', r.sma200 ? (r.price - r.sma200) / r.sma200 * 100 : null)}
        ${yoy('From 52w high', r.from_high)}${yoy('RSI', r.rsi, '')}</div>
      <div class="card-foot" style="margin-top:14px">${symLinks(r.sym)}</div>`;
    return { title, body };
  }

  /* SYMBOLS ARRIVE IN TWO SPELLINGS.
   * SCREEN stores bare NSE symbols (PAYTM). Several feeds — and every Yahoo
   * round-trip — carry the exchange suffix (PAYTM.NS). A card opened from one
   * of those looked the symbol up verbatim, missed, and told the reader the
   * company "is not in the NSE screen", which is a sentence about the
   * universe used to report a string-format mismatch. This repo has already
   * been bitten by the same suffix in the sector cap and the dedupe guard.
   * Normalised once, here, so every caller agrees. */
  /* The screen row behind a ledger symbol. The ledger writes NIACL.NS and the
   * screen keys on NIACL, which is why this goes through bareSym rather than
   * matching the string it was given. */
  /* ── WHY THIS SIGNAL? ─────────────────────────────────────────────────
   * The card printed the engine's `remarks` — a standing rule that describes
   * EVERY trade the engine files — with no label, in the spot where a reader
   * looks for the reason behind THIS one. The pipeline keeps those two apart
   * on purpose (engine_names.why_lines vs engine_rule) so a generic rule can
   * never be printed under a heading that claims it describes one trade. The
   * card did exactly that.
   *
   * So the panel answers in layers, each labelled with what kind of claim it
   * is: what was MEASURED at filing (metadata.why, only the engines that write
   * it), the engine's standing RULE, what INVALIDATES it, the engine's RECORD
   * against the book's own trust gate (30 closed and t ≥ 2), the engine's
   * SCORE with its scale stated, and how the name reads on the SCREEN today —
   * which is the screen's view, not the engine's, and says so.
   *
   * A <details>, so it costs no vertical space until asked for and needs no
   * state: a card list re-rendered on every filter change keeps nothing. */
  const SCORE_SCALE = (rows) => {
    const by = {};
    for (const r of rows || []) {
      const v = r.score == null || r.score === '' ? null : Number(r.score);
      (by[r.signal_type] = by[r.signal_type] || []).push(Number.isFinite(v) ? v : null);
    }
    const out = {};
    for (const [k, vs] of Object.entries(by)) {
      const real = vs.filter(v => v != null && v !== 0);
      /* LEDGE, BREACH and KEEL file 0 on every row: a placeholder, not a
         rating. VECTOR files a statistic near 3: its own scale, not 0–100. */
      out[k] = !real.length ? 'none' : Math.max(...real) < 10 ? 'own' : 'pct';
    }
    return out;
  };
  const gateStrip = (rec) => {
    const n = rec ? rec.trades : 0, t = rec ? rec.t : null;
    const nPct = Math.min(100, n / 30 * 100);
    return `<div class="gate" role="img" aria-label="${n} of 30 closed trades needed; t ${t == null ? 'not measurable' : t} against 2">
      <div class="gate-r"><span class="gate-k">Sample</span><span class="gate-b"><i style="width:${nPct.toFixed(1)}%"></i><em style="left:100%"></em></span><span class="gate-v">${n} / 30</span></div>
      <div class="gate-r"><span class="gate-k">t</span><span class="gate-b gate-t">${t == null ? '' : `<i class="${t < 0 ? 'neg' : ''}" style="left:${(Math.max(-4, Math.min(4, t)) + 4) / 8 * 100}%"></i>`}<em style="left:75%"></em><em class="z" style="left:50%"></em></span><span class="gate-v">${t == null ? '—' : t}</span></div>
    </div>`;
  };
  const whyPanel = (r, ctx) => {
    const k = r.signal_type, eng = ENGINE_BOOK.get(k) || {}, md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
    const why = Array.isArray(md.why) ? md.why.filter(Boolean) : (md.why ? [String(md.why)] : []);
    const open = (r.badge || '').toLowerCase() === 'open';
    const rec = ctx && ctx.rec ? ctx.rec[k] : null;
    const sc = (ctx && ctx.scale && ctx.scale[k]) || 'none';
    const v = r.score == null || r.score === '' ? null : Number(r.score);
    const scoreTxt = sc === 'none' || !Number.isFinite(v) ? `${esc(engName(k))} does not score its signals`
      : sc === 'own' ? `${v.toFixed(2)} — ${esc(engName(k))}'s own statistic, not on a 0–100 scale`
      : `${Math.round(v)} / 100 — ${esc(engName(k))}'s own rating at filing, not a probability`;
    const sent = r.sent_at ? new Date(r.sent_at) : null;
    const when = sent && Number.isFinite(sent.getTime())
      ? sent.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST'
      : esc(String(r.alert_date || r.date || '').slice(0, 10));
    const sr = screenRow(r.symbol);
    const parts = sr ? radarParts(sr) : null;
    const PW = { trend: 'Trend', momentum: 'Momentum', volume: 'Volume', institutional: 'Institutional' };
    const bars = parts ? Object.keys(PW).map(p => {
      const x = parts[p];
      return `<div class="why-f"><span>${PW[p]}</span><span class="why-fb${x == null ? ' na' : ''}"><i style="width:${x == null ? 0 : Math.round(x)}%"></i></span><b>${x == null ? 'not measured' : Math.round(x)}</b></div>`;
    }).join('') : '';
    const ms = parts ? radarScore(parts) : null;
    return `<details class="why">
      <summary><span class="why-q">Why this signal?</span><span class="why-s">${esc(engName(k))} · ${when}${rec ? ` · ${rec.trades} closed` : ''}</span></summary>
      <div class="why-b">
        <div class="why-sec"><h4><i class="ek ek-r">Measured</i> On the bar that fired</h4>${why.length
          ? `<ul>${why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
          : `<p>${esc(engName(k))} does not record per-trade reasons, so nothing here describes this trade on its own.</p>`}</div>
        ${eng.hunts ? `<div class="why-sec"><h4><i class="ek ek-m">Rule</i> What ${esc(engName(k))} looks for</h4><p>${esc(eng.hunts)}</p><p class="why-n">Describes every trade this engine files — not a reason specific to ${esc(bareSym(r.symbol))}.</p></div>` : ''}
        ${open && md.invalidate ? `<div class="why-sec"><h4><i class="ek ek-f">Exit</i> Invalidated by</h4><p>${esc(md.invalidate)}</p></div>` : ''}
        <div class="why-sec"><h4><i class="ek ek-res">Record</i> ${esc(engName(k))} in this book</h4>${rec && rec.trades
          ? `<p>${rec.trades} closed · ${rec.win_rate}% won · ${rec.expectancy_r > 0 ? '+' : ''}${rec.expectancy_r}R a trade${rec.ci ? ` · 95% interval ${fmtR(rec.ci[0])} to ${fmtR(rec.ci[1])}` : ''}.</p>`
          : `<p>No closed trade since ${esc(LAUNCH)} — nothing to report, which is itself the answer.</p>`}
          ${gateStrip(rec)}<p class="why-n">The book trusts an engine at 30 closed trades and t ≥ 2. ${(rec && rec.trades >= 30 && rec.t >= 2) ? `${esc(engName(k))} has cleared it.` : `${esc(engName(k))} has not.`}</p></div>
        <div class="why-sec"><h4><i class="ek ek-m">Score</i> Engine score</h4><p>${scoreTxt}.</p></div>
        ${parts ? `<div class="why-sec"><h4><i class="ek ek-v">Screen</i> How the name reads today</h4>${bars}
          <p class="why-n">Move score ${ms == null ? 'not scored' : ms} — from the daily screen, not from the engine that filed this. Missing components are left out, never scored zero.</p></div>` : ''}
        <p class="why-l"><a class="why-a" href="/engines">How ${esc(engName(k))} works →</a><a class="why-a" href="/methodology">How this is measured →</a></p>
      </div></details>`;
  };

  const screenRow = (sym) => {
    if (!SCREEN) return null;
    const k = bareSym(sym);
    return SCREEN.find(x => bareSym(x.sym) === k) || null;
  };

  const bareSym = (s) => String(s || '').trim().toUpperCase()
    .replace(/\.(NS|BO|BSE|NSE)$/i, '');

  async function openStock(rawSym) {
    const sym = bareSym(rawSym);
    /* `|| SCREEN_LITE` — a cache filled by a light route is missing the
     * per-company prose this surface exists to show, so it is re-fetched over
     * the top rather than rendered with the sections silently empty. */
    if (!SCREEN || SCREEN_LITE) {
      sheet(esc(sym), `<div class="sk" style="height:210px"></div>
        <p class="hint">Loading the full screen — about 300 KB, once per session.</p>`);
      const r0 = noteLadder(await get(FULL_URL));
      if (!r0.ok) { sheet(esc(sym), fail('The company card', r0.error)); return; }
      noteScreenMeta(r0.data); setScreen((r0.data.rows || []).filter(x => x && x.sym), false);
    }
    // The card can be opened from Today, Markets, Ideas or search, none of
    // which touch the Screen route, so the institutional feed is requested
    // here too. It resolves instantly on the second card.
    await loadInsti();
    const r = (SCREEN || []).find(x => x.sym === sym);
    if (!r) {
      sheet(esc(sym), `<div class="empty">${esc(sym)} is not in the NSE screen,
        so there is no card for it — it may be an index, a commodity, or a name
        outside the screened universe.</div>`);
      return;
    }
    const { title: cardTitle, body: cardBody } = stockCard(r);
    sheet(cardTitle, cardBody);

    /* One live quote, for the name actually being read. Marking all 750 is not
     * possible — Yahoo takes 20 symbols a call — and marking the 60 on screen
     * would re-fetch on every keystroke. The card is where the price matters,
     * and it is one symbol. */
    quotes([r.sym]).then(q => {
      const live = q[r.sym];
      if (!live) return;
      const host = document.querySelector('#sheet .hint');
      if (!host) return;
      const mv = r.price ? (live.price - r.price) / r.price * 100 : null;
      host.insertAdjacentHTML('afterend',
        `<div class="livebox"><span class="lv-k">Live</span>
          <b class="lv-p">${price(live.price)}</b>
          ${live.change_pct != null ? `<span class="lv-c ${dir(live.change_pct)}">${pct(live.change_pct)} today</span>` : ''}
          ${mv != null ? `<span class="lv-s">${pct(mv)} vs the ${esc(String(r.last_date || 'screen'))} close</span>` : ''}
        </div>`);
    });

    // After the sheet exists: one 2-year request, cached per symbol.
    wireCardChart(r.sym);
  }

  /* Fifteen rows is about four screens on a phone with the header and the
   * controls above them — enough to see the shape of the table and decide
   * whether the rest is worth asking for. Module scope, not route scope: the
   * table's markup reads it while it is being BUILT, which is before anything
   * declared inside the route body exists. */
  const IPO_SHOW = 15;

  let sigFilter = 'all';
  /* The other three axes of the signals table. Status stays in `sigFilter`
   * because the chips that carry it also carry the counts. */
  let SIGF = { eng: 'all', dir: 'all', tf: 'all' };
  /* The alerts ledger sorts too. Its header was aria-hidden decoration and the
     rows came out in feed order, so the one question a ledger is opened with —
     which of these is furthest along, which is worst — could not be asked. */
  let sgSort = '', sgDir = 'desc';
  const SG_SORT = {
    symbol: r => String(r.symbol || '').toUpperCase(),
    entry:  r => Number(r.entry),
    sl:     r => Number(r.sl),
    target1: r => Number(r.target1),
    rr:     r => Number(r.rr),
    result: r => (r.pnl_pct == null ? null : Number(r.pnl_pct)),
  };
  const sigDir = r => /SELL|SHORT/i.test(r.action || '') ? 'short' : 'long';

  /* ── WHICH ENGINES ARE ALLOWED TO PUBLISH ────────────────────────────────
   *
   * The single most-asked question about this page is "why is nothing firing",
   * and the answer was unreadable from outside. Each engine must clear an R:R
   * floor derived from its OWN measured win rate — break-even is (1-p)/p — and
   * an engine whose required floor hits the cap stops publishing entirely.
   * That table lived in a cache file on a CI runner that is destroyed after
   * every job, so an engine the system had switched off and an engine having a
   * quiet day looked identical from here: silence.
   *
   * It is on the page now, with the arithmetic, because an engine disabled by
   * its own record is the most interesting thing this site can say about it. */
  /* ── THE FLOOR ───────────────────────────────────────────────────────────
   *
   * Every engine on this site, as an operator would see a trading floor: who
   * is working, what each one hunts, what its own record says it must earn,
   * and the last thing it actually filed.
   *
   * It replaces a six-column table. The table was accurate and unreadable —
   * "breakout 103 closed 27.2% win needs 2.68R floor 3.08R" is five numbers in
   * a row with no statement of what any of them means or whether that engine
   * is currently allowed to trade. The single most-asked question about this
   * page is "why is nothing firing", and a row of digits does not answer it.
   *
   * Each card answers it in order: is it on, what does it look for, what has
   * it done, and what did it last file. The bar is the engine's win rate
   * against the win rate its own floor demands — the one comparison that
   * decides whether it publishes, drawn rather than left to arithmetic. */
  /* A heading INSIDE a section — the floor holds two blocks that need naming
   * without either becoming a section of its own in the page's rhythm. */
  function floorHtml(d, rows) {
    // Still needed by each card's footer ("what this engine filed last"), which
    // is not what the removed Latest-filings log did.
    const last = new Map();
    for (const r of (rows || [])) {
      const k = String(r.signal_type || '');
      if (!last.has(k)) last.set(k, r);          // rows arrive newest first
    }
    const seen = new Set();
    const cards = LIVE_ENGINES().map(([key, meta]) => {
      const v = (d.engines || {})[key] || {};
      const trades = v.trades || 0;
      const win = v.win_rate;
      const floor = v.floor != null ? Number(v.floor) : 2.0;
      /* ── WHAT THIS BAR MUST NOT BE ────────────────────────────────────────
       * The first version drew the measured win rate against the win rate the
       * floor demands, and that comparison is TAUTOLOGICAL: the floor is
       * derived from the win rate as breakeven x 1.15, so measured clears
       * required by exactly the safety margin, every time, for every engine.
       * A bar that always says the same thing is not information.
       *
       * What genuinely varies, and decides whether anything appears below, is
       * the floor itself — how much a single setup must earn before this
       * engine is allowed to file it. 2.0R is the default every engine starts
       * at; 6.0R is the cap, at which point it cannot honestly produce a
       * qualifying trade and stops. The bar is that span, so a reader can see
       * at a glance which engines are working under a raised bar and which are
       * effectively shut. */
      const FLOOR_MIN = 2.0, FLOOR_CAP = 6.0;
      const strain = Math.max(0, Math.min(1, (floor - FLOOR_MIN) / (FLOOR_CAP - FLOOR_MIN)));
      /* AN UNPROVEN ENGINE DOES NOT GET THE GREEN. This checked trades === 0
       * only, so PLUMB — 0% win rate over 7 closed — drew the same "live"
       * chip in the site's own up-colour as an engine at 41% over 17. The
       * feed already says which are unproven: below 25 closed trades the win
       * rate is not evidence, and engines.json marks them
       * insufficient-sample. Green is a claim, and this one was not earned. */
      const proven = trades > 0 && v.status !== 'insufficient-sample';
      const state = v.status === 'disabled' || floor >= FLOOR_CAP ? 'off'
        : !proven ? 'new'
        : floor > FLOOR_MIN + 0.01 ? 'under'
        : 'on';
      const chip = {
        on:    ['live', 'Open · 2R bar'],
        under: ['warn', `Raised bar · ${floor}R`],
        off:   ['off',  'Switched off'],
        new:   ['new',  trades ? `Open · ${trades} closed, not evidence` : 'Open · none closed yet'],
      }[state];
      const L = last.get(key);
      // magic and magicmagic are one engine at two depths; the name heads the
      // first card and the second is labelled by its band alone.
      const dupe = seen.has(meta.name); seen.add(meta.name);
      /* EXPANDABLE, because the card alone cannot answer "why that floor".
       * <details> rather than a scripted toggle: it is keyboard-operable and
       * screen-reader labelled without this file shipping an interaction for
       * it, and it works before the JS that draws the rest of the page runs. */
      return `<details class="ag ag-${state}"><summary class="ag-sum">
        <header class="ag-h">
          <span class="ag-n">${esc(meta.name)}${meta.band
            ? `<i>${esc(meta.band)}</i>` : ''}</span>
          <span class="ag-r">${esc(meta.role)}</span>
        </header>
        <div class="ag-chip ${chip[0]}">${esc(chip[1])}</div>
        <p class="ag-hunt">${esc(meta.hunts)}</p>
        <div class="ag-bar" role="img"
             aria-label="floor ${floor}R on a scale from 2R to 6R">
          <i style="width:${(strain * 100).toFixed(0)}%"></i>
        </div>
        <div class="ag-m">
          <span><b>${floor}R</b>a setup must earn</span>
          <span><b>${win == null ? '—' : win + '%'}</b>win rate that set it</span>
          ${/* NOT "closed". This is engines.json's sample — 107 trades for
              * BREACH — which is the history the floor was computed from, and
              * it stretches back long before this site's record began. Calling
              * it "closed" put a four-figure-old number under a card on a page
              * whose every other count starts at LAUNCH. */''}
          <span><b>${trades}</b>trades behind it</span>
        </div>
        <footer class="ag-f">
          <span>${esc(meta.tf)}</span>
          <span>${L ? esc(String(L.symbol || '').replace('.NS', '')) + ' · '
                      + esc(String(L.date || '').slice(5, 10)) : 'nothing filed yet'}</span>
        </footer>
        <span class="ag-c" aria-hidden="true"></span>
      </summary>
      <div class="ag-d">
        <h4 class="ag-dh">What it hunts</h4>
        <p class="ag-dp">${esc(meta.hunts)}</p>
        ${(R2 => R2 ? `
          ${Array.isArray(R2.triggers) && R2.triggers.length ? `<h4 class="ag-dh">When it fires</h4>
            <ul class="ag-rules">${R2.triggers.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${R2.stop ? `<h4 class="ag-dh">Where the stop comes from</h4>
            <p class="ag-dp">${esc(R2.stop)}</p>` : ''}
          ${R2.targets ? `<h4 class="ag-dh">Targets</h4><p class="ag-dp">${esc(R2.targets)}</p>` : ''}
          ${R2.wrong ? `<h4 class="ag-dh">What would prove it wrong</h4>
            <p class="ag-dp">${esc(R2.wrong)}</p>` : ''}
          ${R2.fixed ? `<p class="ag-dp ag-fix"><b>Changed:</b> ${esc(R2.fixed)}</p>` : ''}
        ` : '')(ENGINE_RULES[key])}
        <h4 class="ag-dh">Why this floor</h4>
        <p class="ag-dp">A setup must offer <b>${floor}R</b> before this engine may file it.
          That is not a preference: break-even reward-to-risk at a
          <b>${win == null ? 'n/a' : win + '%'}</b> win rate is (1−p)/p, plus a 15% margin.
          ${trades ? `It is computed over <b>${trades}</b> closed trades stretching back before
          this site's record began — so it is the bar this engine has earned, not a
          statement about what it has done here.` : 'Below 25 closed trades the default 2.0R stands.'}
          ${floor >= 6 ? ` At the 6R cap an engine cannot honestly produce a qualifying setup,
          so it stops publishing — switched off by its own record.` : ''}</p>
        ${ENGINE_BACKTEST[key] ? (b => `<h4 class="ag-dh">Backtest</h4>
          <p class="ag-dp">${b.n} signals · <b class="${dir(b.exp)}">${b.exp > 0 ? '+' : ''}${b.exp.toFixed(3)}R</b>
            · ${b.win.toFixed(0)}% win · t=${b.t.toFixed(2)} · ${esc(b.from)} → ${esc(b.to)}.
            <b>Not a live record.</b></p>`)(ENGINE_BACKTEST[key]) : ''}
        <p class="ag-dp"><a href="/engines">The full roster and every rule →</a></p>
      </div>
      </details>`;
    }).join('');

    const on = LIVE_ENGINES().filter(([k]) => {
      const v = (d.engines || {})[k] || {}; return v.status !== 'disabled';
    }).length;

    /* "LATEST FILINGS" IS DELETED, NOT RESTYLED.
     * It listed date, engine, symbol, entry, R:R and a badge for the last
     * twelve signals — six columns with no headers, so a row read
     * "₹1,037  3.24R  open" and the reader had to guess what each was. And it
     * sat on the same page as the signals table, which carries the same rows
     * with headers, filters and the full ladder under each. Two renderings of
     * one dataset is not extra information; the weaker one was removed. */
    /* REFERENCE, FOLDED. Nine engine cards ran to 2,073px on a phone — a
     * third of this page — under a heading whose own note calls the block
     * reference: who is on the roster and what each must earn. It is worth
     * having and it is not what somebody opens the ledger to read, so the
     * heading, the working count and the standfirst stay in the flow and the
     * cards wait for a tap. */
    return sec('The floor', foldBody(
      `${ENGINE_KEYS().length} configurations — what each hunts, what it must earn, and the record behind that bar`,
      `<div class="floor">${cards}</div>
      <p class="hint">The bar is how far each engine's floor has been raised above the
        2R default, toward the 6R cap at which it stops publishing altogether. That floor
        comes from the engine's own win rate — break-even R:R is (1−p)/p — so an engine
        that wins less often has to earn more per trade before it is allowed to file one.
        A raised bar is not a fault; it is the system refusing trades that record says
        lose money.</p>
      <p class="hint">${engineTallyNote()} This floor lists one card per <b>configuration</b>, so
        TIDAL appears twice — once per band. The roster on <a href="/">the front page</a> groups
        by name and shows ${ENGINE_NAMES().length} rows for the same set.</p>`),
      `${on} of ${ENGINE_KEYS().length} working`,
      'Who is on the floor, what each one hunts, and what it has to earn to file a trade.');
  }

  /* ── THE SIGNALS TABLE ─────────────────────────────────────────────────────
   *
   * The ledger was thirty large cards in a two-column grid. Reading it meant
   * scrolling past every signal to compare any two, and the only filter was
   * the outcome badge — so "show me the weekly LEDGE longs" was a manual scan.
   *
   * This is the same data as rows: one line per signal, the six figures that
   * decide whether it is worth opening, and the whole card underneath when it
   * is. Filtering is on the four axes a signal actually varies along — engine,
   * status, direction, timeframe — and each one is a native <select>, which on
   * a phone opens the platform picker instead of a bespoke menu.
   *
   * Sorting is newest first and stays there: this is a chronological record,
   * and a table that reorders itself loses the one ordering that is a fact
   * about the data rather than a view of it. */
  const sigOpts = (rows, key, label) => {
    const seen = new Map();
    for (const r of rows) {
      const v = key(r); if (!v) continue;
      seen.set(v, (seen.get(v) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])
      .map(([v, n]) => [v, `${label(v)} (${n})`]);
  };

  const sigSelect = (id, name, cur, opts) =>
    `<label class="sgf"><span>${esc(name)}</span>
      <select data-sgf="${id}" aria-label="Filter by ${esc(name.toLowerCase())}">
        <option value="all"${cur === 'all' ? ' selected' : ''}>All</option>
        ${opts.map(([v, l]) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select></label>`;

  const sigPass = (r) => {
    const b = (r.badge || '').toLowerCase();
    /* "Closed" is every graded outcome — won, lost or expired — so the ledger
       can be read as one finished record without choosing a side first. */
    if (sigFilter === 'closed') { if (!['win', 'loss', 'expired'].includes(b)) return false; }
    else if (sigFilter !== 'all' && b !== sigFilter) return false;
    if (SIGF.eng !== 'all' && String(r.signal_type || '') !== SIGF.eng) return false;
    if (SIGF.dir !== 'all' && sigDir(r) !== SIGF.dir) return false;
    if (SIGF.tf !== 'all' && String(r.timeframe || '') !== SIGF.tf) return false;
    return true;
  };

  /* ── THE SAME NAME, FILED BY TWO DIFFERENT ENGINES ───────────────────────
   *
   * Akshay: "entire site no duplicacy."
   *
   * The duplicates he means are gone: the ledger now carries ONE open ticket
   * per name per engine — measured on the live feed the day this was written,
   * 133 open rows and zero repeated (symbol, engine) pairs.
   *
   * What is left is NOT duplication and must not be deleted. Two kinds:
   *
   *   1. A closed trade and a later re-entry. STLTECH shows twice because the
   *      first was booked at target 2 for +17.7% on 3 September and the engine
   *      re-entered on the 12th. That is a record doing its job.
   *
   *   2. Seven names open under TWO engines — CGCL under BREACH and ASCENT,
   *      OFSS under NORTH and ASCENT, five more. Two engines independently
   *      reaching the same name is a signal in itself, and deleting one would
   *      erase a real filing by a real screen.
   *
   * But the reader's hazard is real: sized off both rows, those seven carry
   * twice the intended risk on one company. So the row says so — once, on
   * each side — and nothing is removed. */
  let OPEN_TWICE = new Map();
  const alsoOpen = (r) => {
    const others = OPEN_TWICE.get(bareSym(r.symbol));
    if (!others) return '';
    const rest = others.filter(e => e !== engName(r.signal_type));
    if (!rest.length) return '';
    return `<span class="sg-dbl" title="Open under ${esc(rest.join(' and '))} as well — one position, not ${
      rest.length + 1}. Sizing both is ${rest.length + 1}x the intended risk on one company."
      >also ${esc(rest.join(', '))}</span>`;
  };

  const sigRow = (r, px, detail) => {
    const cur = r.currency || '₹';
    const b = (r.badge || '').toLowerCase();
    const open = b === 'open';
    const live = px[r.symbol];
    const move = open ? (live ? pnlOf(r.entry, live.price, r.action) : null)
                      : (r.pnl_pct == null ? null : Number(r.pnl_pct));
    /* Same rule as the card: a flat move is flat, not a loss. */
    const mcls = move == null ? 'pill-ac' : move > 0 ? 'pill-up' : move < 0 ? 'pill-dn' : 'pill-flat';
    const e = lvl(r.entry), sx = lvl(r.sl);
    const far = lvl(r.target3) || lvl(r.target2) || lvl(r.target1);
    const which = lvl(r.target3) ? 'T3' : lvl(r.target2) ? 'T2' : 'T1';
    const rr = (e && sx && far && e !== sx) ? Math.abs(far - e) / Math.abs(e - sx) : null;
    const short = sigDir(r) === 'short';
    const summary = `<span class="sg-d ${short ? 'dn' : 'up'}" title="${short ? 'Short' : 'Long'}"></span>
      <span class="sg-id"><b>${esc(r.symbol || '')}</b>
        <span>${esc(engName(r.signal_type))}${r.timeframe ? ' · ' + esc(r.timeframe) : ''}${
          open ? alsoOpen(r) : ''}</span></span>
      <span class="sg-n" title="Entry">${price(r.entry, cur)}</span>
      <span class="sg-n dn" title="Stop">${price(r.sl, cur)}</span>
      <span class="sg-n up" title="First target">${lvl(r.target1) == null ? '—' : price(r.target1, cur)}</span>
      <span class="sg-n" title="Reward to risk, measured to ${which}">${rr == null ? '—' : rr.toFixed(2)}</span>
      ${/* ── THE TWO LABELS WERE THE WRONG WAY ROUND ──────────────────────
          * This read:  move == null ? (open ? 'no mark' : 'open') : …
          *
          * So a signal with no price mark showed "no mark" when it was OPEN —
          * correct — and the literal word "open" when it was NOT. Every
          * withdrawn or closed row without a mark was labelled open on the
          * public ledger. TATAINVEST was cancelled in the database, reported
          * cancelled by /api/signals, and still read "open" here.
          *
          * A row that is not open has a state worth naming, and the API
          * already computes it: badgeOf(status, lifecycle_status). Use it,
          * rather than a word chosen by the wrong branch of a ternary. */''}
      <span class="sg-r-out"><span class="pill ${mcls}">${
        move == null
          ? (open ? 'no mark' : esc(String(r.badge || r.status || 'closed')
                                      .replace(/_/g, ' ').toLowerCase()))
          : pct(move) + (open ? ' live' : '')}</span>
        <em>${esc(String(r.alert_date || r.date || '').slice(0, 10))}</em></span>`;
    return xrow(summary, detail, { cls: 'sg-r', attrs: `data-sgsym="${esc(r.symbol || '')}"` });
  };

  R['/404'] = async () => {
    /* The status was already sent by the Worker; this is the body that has to
     * agree with it — including the robots tag, which setHead writes from the
     * META table and which must not say index on a page that does not exist. */
    paint(head('Not found', 'There is no page at this address.', '404') +
      `<div class="empty" style="text-align:left;padding:26px 22px">
        <b style="color:var(--text);font-size:var(--t-5)">There is no page at
          <code>${esc((location.pathname || '').slice(0, 80))}</code>.</b>
        <p style="margin:10px 0 0">This address does not match any section of the site. It was
          either mistyped, or it is a link to something that has been renamed — the routes
          changed from <code>#/name</code> to <code>/name</code>, so an old bookmark with a
          <code>#</code> in it should still work, and anything else will not.</p>
        <p style="margin:14px 0 0">Where you probably meant to go:</p>
        <div class="chips" style="margin-top:10px">
          <a class="chip" href="/">Today</a>
          <a class="chip" href="/opportunities">Opportunities</a>
          <a class="chip" href="/screen">The NSE screen</a>
          <a class="chip" href="/radar">Radar</a>
          <a class="chip" href="/ipo">IPO</a>
          <a class="chip" href="/performance">Performance</a>
        </div>
      </div>`);
  };

  /* ── BUOY — an UNPROVEN engine, shown as one ─────────────────────────────
   *
   * The rule: a name at least 12% off its 52-week high closes a FOUR-HOUR
   * candle back above its 200-PERIOD average, having been under it, with a
   * bullish RSI divergence already behind it. 200 periods of 4H is about a
   * hundred sessions, so it is the long-term line on that chart.
   *
   * An NSE session makes TWO 4H candles — 09:15-13:15 and 13:15-15:30 — which
   * is the convention TradingView uses and the one the resampler reproduces.
   *
   * IT DOES NOT HAVE AN EDGE THAT ANYONE HAS MEASURED, and this page leads
   * with that rather than burying it under ten tickers. Every figure below
   * comes from backtest_buoy.py and the feed carries them so this surface
   * cannot quietly drift from what was actually measured. */
  /* ── THE RESEARCH FLOOR ──────────────────────────────────────────────────
   *
   * Three engines that have NOT earned capital, published on instruction, and
   * published in the only way that is defensible: every one of them leads with
   * its own measured record, and no watchlist row can be read without the
   * numbers that argue against it being on the same screen.
   *
   * The distinction this page has to hold is between an unproven engine shown
   * WITH its null result and an unproven engine shown as a list of tickers.
   * The second is what a tip sheet is. So the verdict comes before the names,
   * a REJECTED engine says so in its own heading, and the feed itself refuses
   * to carry a symbol without the engine's status and sample beside it.
   */
  const STATUS_LOOK = {
    RESEARCH: ['warn', 'Research — no measured edge'],
    REJECTED: ['dn', 'Rejected on measurement'],
    PAPER:    ['warn', 'Paper'],
    LIVE:     ['up', 'Cleared'],
  };

  const researchEngine = (e) => {
    const B = e.backtest || {};
    const [cls, label] = STATUS_LOOK[e.status] || ['', e.status || ''];
    const rows = e.top || [];
    const fig = (v, l, c) => `<div class="fig"><b class="${c || ''}">${v}</b><span>${esc(l)}</span></div>`;
    const rr3 = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(3)}R`;
    /* The sample and expectancy a reader should judge this engine on. Where an
     * engine has two lanes the WIDER one is the honest headline — it is the
     * larger sample, and on both engines that carry one it measured the same
     * to within a rounding error. */
    const n = B.n_no_div ?? B.n;
    const exp = B.exp_no_div ?? B.exp;
    const tt = B.t_no_div ?? B.t;
    const lo = B.ci_lo_no_div ?? B.ci_lo, hi = B.ci_hi_no_div ?? B.ci_hi;
    return sec(esc(e.name), `
      <div class="rs-h">
        <span class="pill pill-${cls === 'dn' ? 'dn' : cls === 'up' ? 'up' : 'wn'}">${esc(label)}</span>
        <span class="rs-tf">${esc(e.timeframe || '')}</span>
      </div>
      ${/* `hunts` is already the section's standfirst — sec() renders it as the
          * serif lead above this block, and it was printed again here as body
          * text three lines down. Every one of the three engines carried the
          * same sentence twice on the same screen. The lead keeps it; this
          * copy goes. */''}
      <div class="note ${e.status === 'REJECTED' ? 'note-dn' : ''}">
        <b>${e.status === 'REJECTED' ? 'This engine was rejected, and is shown anyway.'
                                     : 'This engine has no measured edge.'}</b>
        ${esc(e.verdict || '')}</div>
      <div class="figs">
        ${fig(n ?? '—', 'backtested trades')}
        ${fig(rr3(exp), 'per trade', exp > 0 ? 'up' : exp < 0 ? 'dn' : '')}
        ${fig(tt == null ? '—' : `${tt > 0 ? '+' : ''}${Number(tt).toFixed(2)}`, 't-statistic',
              Math.abs(tt ?? 0) >= 2 ? '' : 'dn')}
        ${fig(lo == null ? '—' : `${lo.toFixed(2)} to ${hi > 0 ? '+' : ''}${hi.toFixed(2)}`,
              '95% interval, R')}
      </div>
      ${rows.length ? `
        <div class="sg-head" aria-hidden="true"><span></span><span>Name</span>
          <span>Entry</span><span>Stop</span><span>Target 1</span><span>Risk</span><span>Since</span></div>
        <div class="rank sg-t">${rows.map(x => xrow(`
          <span class="sg-d ${x.lane === 'reclaim' ? 'ac' : 'up'}"></span>
          <span class="sg-id"><b>${esc(x.symbol)}</b>
            <span>${x.lane ? esc(laneName(x.lane)) + ' · ' : ''}${x.bars_ago === 0 ? 'this bar'
              : `${x.bars_ago} bars ago`}${x.touches ? ` · floor held ${x.touches}x` : ''}</span></span>
          <span class="sg-n">${price(x.entry)}</span>
          <span class="sg-n dn">${price(x.sl)}</span>
          <span class="sg-n up">${price(x.target1)}</span>
          <span class="sg-n">${x.risk_pct == null ? '—' : x.risk_pct + '%'}</span>
          <span class="sg-r-out"><span class="pill ${x.since_pct > 0 ? 'pill-up' : x.since_pct < 0 ? 'pill-dn' : 'pill-flat'}">${
            pct(x.since_pct)}</span><em>${price(x.last)}</em></span>`,
          `<div class="yoy">
             <div class="yy"><span>Entry, at the bar that fired</span><b>${price(x.entry)}</b></div>
             ${x.ma != null ? `<div class="yy"><span>The 200-period average it crossed</span><b>${price(x.ma)}</b></div>` : ''}
             ${x.floor != null ? `<div class="yy"><span>The floor it is standing on</span><b>${price(x.floor)}${
               x.touches ? ` · held ${x.touches} separate times` : ''}</b></div>` : ''}
             <div class="yy"><span>Stop</span><b class="dn">${price(x.sl)} · ${esc(String(x.risk_pct))}% of entry${
               x.risk_atr ? ` · ${esc(String(x.risk_atr))}x ATR` : ''}</b></div>
             <div class="yy"><span>Targets 1 / 2 / 3</span><b class="up">${price(x.target1)} · ${price(x.target2)} · ${price(x.target3)}</b></div>
             ${x.from_high_pct != null ? `<div class="yy"><span>Off its 52-week high</span><b>${esc(String(x.from_high_pct))}%</b></div>` : ''}
             ${x.above_floor_pct != null ? `<div class="yy"><span>Above the floor at entry</span><b>${esc(String(x.above_floor_pct))}%</b></div>` : ''}
             ${x.rsi != null ? `<div class="yy"><span>RSI when it fired</span><b>${esc(String(x.rsi))}</b></div>` : ''}
             <div class="yy"><span>Since it fired</span><b class="${dir(x.since_pct)}">${pct(x.since_pct)} · now ${price(x.last)}</b></div>
           </div>
           <p class="hint"><b>${esc(e.name)} is ${esc(e.status.toLowerCase())}.</b>
             ${esc(e.verdict || '')} No position is taken on this.</p>`,
          { cls: 'sg-r' })).join('')}</div>`
        : `<div class="empty">${e.status === 'REJECTED'
             ? `Nothing fired. ${esc(e.name)} is strict and was rejected on its record; an empty list is its normal state.`
             : `Nothing fired this scan. ${esc(e.scanned)} names were checked and none met the rule.`}</div>`}`,
      `${rows.length} of ${e.fired} · ${e.scanned} scanned`,
      esc(e.hunts || ''));
  };

  /* (V1 handler removed at the Signal V2 cutover; see the V2 block below.) */

  /* /buoy predates the other two engines and was linked before this page
   * existed. It is an alias, not a second copy — one page, one dataset. */
  /* (V1 handler removed at the Signal V2 cutover; see the V2 block below.) */


  /* (V1 handler removed at the Signal V2 cutover; see the V2 block below.) */

  /* THE TRAILING RULE, ON EVERY TRADE.
   *
   * The engines write entry, stop and targets. None of them writes a trailing
   * level, so this DERIVES the management rule from the levels that were
   * actually sent — it invents no price the signal did not carry.
   *
   * It is shown as a RULE, and it deliberately does NOT re-grade anything.
   * exit_rule_study.py simulated this over 470 closed trades on the same bars,
   * every trade subject to the rule in both directions:
   *
   *     baseline            +0.194R
   *     break-even @ 1.0R   +0.166R   <- worse
   *     break-even @ 0.5R   +0.220R   (+0.026R, about a quarter of one SE)
   *
   * Trailing does not pay on this ledger: the same volatility that carries a
   * trade to +1R carries winners back through entry and scratches them. So the
   * ledger stays scored on the stop the signal was sent with, and this is
   * published as what to DO with an open position — not as an edge, and not as
   * a silent rewrite of the record.
   */
  /* ── THE NOTE THAT USED TO SIT UNDER EVERY CARD ──────────────────────────
   * "Published as a management rule… measured worse than the fixed stop over
   * 470 closed trades" is one fact about how this site grades trades. It was
   * printed inside trailPlan, so it appeared once per open signal: twenty
   * identical paragraphs down /signals and five more on the front page, which
   * is most of what a reader scrolled past between one trade and the next.
   *
   * A caveat repeated twenty times is not twenty times as honest. It is said
   * once, under the list it applies to. */
  const TRAIL_NOTE = `<p class="hint trail-note"><b>Sold on the ladder, the whole
    position returns 3.54R if every target prints, against 4.62R for holding all of it
    to the last one</b> — the same arithmetic for every signal here, because the ladder
    is fixed in R. Taking money off the table costs that difference; it buys the
    certainty of having taken it.<br><b>The trail and the scale-out are
    management rules, not part of the grade.</b> Every signal above is still scored on
    the single stop it was sent with — a break-even trail measured <b>worse</b> than the
    fixed stop over 470 closed trades, so publishing it as the graded rule would flatter
    the record. The stop path runs from where the signal was sent to break-even once the
    first target prints, then to the first target once the second does. Each card's
    <b>laddered</b> figure is what the scale-out banks if every target prints, against
    <b>held</b> for carrying the whole position to the last target — the difference is what
    taking money off the table costs, and what the certainty of having taken it buys.</p>`;

  /* ══ WIDGETS ═════════════════════════════════════════════════════════════
   *
   * Akshay: "widgets animations info graphs wherever required."
   *
   * THE ONE RULE ALL OF THESE FOLLOW. Every widget renders its FINISHED state
   * in markup and CSS. The animation only ever moves it from there. That is
   * not a stylistic preference — rAF does not run in a hidden tab and
   * IntersectionObserver does not fire in one either, both of which are on
   * file in this estate, so a widget that starts at zero and waits to be
   * animated is a widget that is permanently blank for a reader whose tab was
   * in the background. Correct first, animated second.
   */

  /* A number that counts up to the value already printed in it.
   *
   * The ELEMENT CARRIES THE FINAL TEXT. This only rewrites it while running
   * and puts the original back at the end, so a thrown error, a hidden tab or
   * no JS at all leaves the true figure on screen. */
  /* ── NO FIGURE COUNTS UP ─────────────────────────────────────────────────
   * There was a count-up here: every tile's number ran from 0 to its value on
   * paint. It shipped wrong figures twice in one evening. A frame timestamp
   * earlier than the start made progress negative ("Published -18,139"), and
   * once clamped, any reader whose frames and timers stop — a background tab,
   * a crawler, a captured page — kept the first frame: "Published 0", a 0.0%
   * win rate. A site whose argument is that its numbers can be trusted cannot
   * print a false one as decoration, however briefly. DESIGN.md already said
   * it: "no number that counts up". The figure is in the markup and stays. */
  /* A 0-100 ring. The arc length is computed here and written INLINE, so the
     ring is already correct before the sweep keyframe touches it. */
  const ringGauge = (score, label, cls = '', size = 116) => {
    const v = Math.max(0, Math.min(100, Number(score) || 0));
    const r = (size / 2) - 6;
    const circ = 2 * Math.PI * r;
    const off = circ * (1 - v / 100);
    return `<span class="ringw">
      <svg class="ring" viewBox="0 0 ${size} ${size}" style="--ring-sz:${size}px"
           role="img" aria-label="${esc(label)}: ${v} out of 100">
        <circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}"></circle>
        <circle class="ring-fg ${esc(cls)}" cx="${size / 2}" cy="${size / 2}" r="${r}"
          style="--circ:${circ.toFixed(1)};stroke-dasharray:${circ.toFixed(1)};
                 stroke-dashoffset:${off.toFixed(1)}"></circle>
      </svg>
      <span class="ring-c"><b class="cnum">${Math.round(v)}</b><span>${esc(label)}</span></span>
    </span>`;
  };

  /* Advancers / unchanged / decliners as one bar. The widths are real
     percentages written inline; `grow` only animates from zero-basis. */
  /* `win` names the window the counts cover. pulse.breadth is ONE-WEEK
     returns, and "427 advancing" with no window reads as today. */
  /* `words` renames the three buckets. The ledger's book-shape bar passed
     wins, open and losses through this and printed "1 advancing · 35
     unchanged · 14 declining" under a record of trades. */
  const splitBar = (up, down, total, win, words) => {
    const W = Object.assign({ u: 'advancing', f: 'unchanged', d: 'declining', us: 'up', ds: 'down',
                              ua: 'advanced', da: 'declined' }, words || {});
    const u = Number(up) || 0, d = Number(down) || 0, t = Number(total) || 0;
    if (!t) return '';
    const flat = Math.max(0, t - u - d);
    const pc = (n) => (n / t * 100);
    const seg = (n, cls, txt) => n <= 0 ? '' :
      `<i class="${cls}" style="flex:0 0 ${pc(n).toFixed(1)}%">${pc(n) > 11 ? esc(txt) : ''}</i>`;
    return `<div class="splitb" role="img"
        aria-label="${u} ${W.ua}, ${flat} ${W.f}, ${d} ${W.da} of ${t}${win ? ' ' + esc(win) : ''}">
        ${seg(u, 'sb-u', u + ' ' + W.us)}${seg(flat, 'sb-f', flat)}${seg(d, 'sb-d', d + ' ' + W.ds)}
      </div>
      ${/* ── THE THIRD BUCKET IS NAMED, NOT LEFT AS A GAP ───────────────────
           * The BAR always carried the unchanged slice; the LABELS under it
           * did not, so the page printed "160 advancing" and "818 declining"
           * beside "985 names screened" and left a reader to notice that those
           * do not add up. An external audit did notice, and it is the kind of
           * gap that reads as filtering rather than as an omission. Seven
           * names went nowhere; the page says so. */''}
      <div class="splitl"><span>${u} ${W.u}</span>${
        flat > 0 ? `<span class="sb-fl">${flat} ${W.f}${win ? ' · ' + esc(win) : ''}</span>` : (win ? `<span class="sb-fl">${esc(win)}</span>` : '')
      }<span>${d} ${W.d}</span></div>`;
  };

  /* A labelled 0-100 meter. */
  const meter = (v, cls = '') =>
    `<div class="meter ${esc(cls)}"><i style="--w:${Math.max(0, Math.min(100, Number(v) || 0)).toFixed(0)}%"></i></div>`;

  /* A small infographic tile: label, figure, its own trend line, and the move.
     The path is real data; its length is measured and written inline so the
     draw-in has something true to animate from. */
  const sparkCard = (label, value, series, deltaPct) => {
    const pts = (series || []).map(Number).filter(Number.isFinite);
    let svg = '';
    if (pts.length > 2) {
      const lo = Math.min(...pts), hi = Math.max(...pts), span = (hi - lo) || 1;
      const W = 120, H = 30;
      const d = pts.map((p, i) =>
        `${i ? 'L' : 'M'}${(i / (pts.length - 1) * W).toFixed(1)},${(H - (p - lo) / span * H).toFixed(1)}`
      ).join(' ');
      // Rough path length: enough for a dasharray that always exceeds the
      // real one, which makes the draw-in start fully hidden and end exact.
      const len = Math.round(W * 1.6 + H);
      svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="draw" d="${d}" style="--len:${len};stroke-dasharray:${len};
          stroke-dashoffset:0"></path></svg>`;
    }
    const dcls = deltaPct == null ? '' : dir(deltaPct);
    return `<div class="spk ${esc(dcls)}">
      <span class="spk-k">${esc(label)}</span>
      <span class="spk-v cnum">${esc(value)}</span>
      ${svg}
      <span class="spk-f"><span class="spk-d ${esc(dcls)}">${
        deltaPct == null ? '' : pct(deltaPct)}</span></span>
    </div>`;
  };

  /* Run the count-ups after a paint. Called from paint(), guarded, and
     deliberately NOT observer-gated: the numbers are already on screen and
     this is decoration on top of them. */
  const runWidgets = () => { /* figures are printed, never animated — see above */ };

  /* ── THE BAROMETER, AND WHEN A BAD MARKET BECOMES AN OPPORTUNITY ─────────
   *
   * Akshay: "market barometer — use historical figures, imp. supports etc to
   * arrive at a figure... also suggest if it's too bad, even at bad when can
   * we start investing — for eg covid market was bad but at those lows
   * whoever invested became rich."
   *
   * TWO READINGS, BECAUSE THEY ANSWER OPPOSITE QUESTIONS AND MOVE TOGETHER.
   * A barometer alone says "conditions are poor" at exactly the moment the
   * second reading should be saying "this is the entry". March 2020 scored
   * terribly on every trend measure ever built, and it was the best entry in
   * a decade. A single number cannot hold both, so this publishes both and
   * says plainly that they are inversely related by design.
   *
   * EVERY INPUT IS MEASURED ON THIS SITE ALREADY. No new feed, no history
   * this site does not hold:
   *   · where the index sits in its OWN 52-week range        (ticker)
   *   · how many of 989 names hold their 200-day average     (pulse breadth)
   *   · how many advanced today                              (pulse breadth)
   *   · India VIX                                            (ticker)
   *   · how many names are at a 52-week high                 (pulse breadth)
   *
   * WHAT IT IS NOT. It is not backtested and it does not carry a record, so
   * it is a FRAMEWORK, not a signal — the same bar every engine on this site
   * is held to. The weights below are stated in the open precisely because
   * nothing has earned the right to hide them. */
  const BARO_W = { trend: 30, breadth: 30, participation: 15, volatility: 15, highs: 10 };

  const barometer = (nifty, breadth, vix) => {
    const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const counted = n(breadth && breadth.counted);
    if (!counted) return null;

    const parts = [];
    const add = (key, label, score, detail) => {
      if (score == null) return;
      parts.push({ key, label, score: Math.max(0, Math.min(100, score)),
                   weight: BARO_W[key], detail });
    };

    /* WHERE THE INDEX SITS IN ITS OWN YEAR, not against a round number. A
       level means nothing without the range it sits in. */
    const pos = n(nifty && nifty.range_pos);
    if (pos != null) {
      add('trend', 'Where the index sits', pos,
          `Nifty is ${pos.toFixed(0)}% up its own 52-week range, ${
            Math.abs(n(nifty.from_high_pct) || 0).toFixed(1)}% below the high`);
    }

    /* THE 200-DAY IS THE LINE THIS MEASURES AGAINST, across 989 names rather
       than one index — an index can hold its average while most of the market
       does not, and that divergence is the thing worth knowing. */
    const above = n(breadth.above_200dma);
    const aboveP = above == null ? null : above / counted * 100;
    if (aboveP != null) {
      add('breadth', 'Names above their 200-day', aboveP,
          `${above} of ${counted} hold their 200-day average`);
    }

    const up = n(breadth.up);
    if (up != null) {
      /* Every caller passes pulse.breadth, whose `up` is r1w > 0 — the WEEK.
         It was labelled "Advancing today". */
      add('participation', 'Advancing over the week', up / counted * 100,
          `${up} of ${counted} rose over the past week`);
    }

    /* VIX INVERTED, AND BANDED RATHER THAN SCALED. 11 and 13 are the same
       market; 13 and 30 are not. The bands are where behaviour changes, not
       an arithmetic stretch between two arbitrary ends. */
    const v = n(vix);
    if (v != null) {
      const sc = v < 12 ? 85 : v < 16 ? 70 : v < 20 ? 50 : v < 26 ? 28 : 10;
      add('volatility', 'Volatility', sc,
          `India VIX at ${v.toFixed(2)} — ${v < 12 ? 'very calm' : v < 16 ? 'normal'
            : v < 20 ? 'unsettled' : v < 26 ? 'jumpy' : 'stressed'}`);
    }

    /* Leadership. A market making new highs somewhere is a different animal
       from one where nothing is. Capped: 5% of names at a 52-week high is
       already broad, so the scale tops out there rather than at 100%. */
    const hi = n(breadth.at_52w_high);
    if (hi != null) {
      add('highs', 'Names at a 52-week high', Math.min(100, hi / counted * 100 / 5 * 100),
          `${hi} of ${counted} at a 52-week high`);
    }

    /* ── THE DENOMINATOR HAS TO TRAVEL WITH THE SCORE ────────────────────
       wsum is the weight of the components that ANSWERED, not the weight
       this model declares. Dividing by it renormalises over whatever had
       data and then publishes "N out of 100" — the same number a complete
       reading gives, with nothing to tell them apart.

       Measured 2026-09-21: trend and volatility both came back null, so 45
       of the declared 100 weight was missing — including trend, the single
       heaviest at 30 — and the page printed 42/100 from 55% of its own
       scale. barometer.py had this fault too, written independently in the
       other language; both are fixed the same way. */
    const wsum = parts.reduce((a, p) => a + p.weight, 0);
    if (!wsum) return null;
    const wTotal = Object.values(BARO_W).reduce((a, b) => a + b, 0);
    const missing = Object.keys(BARO_W).filter(k => !parts.some(p => p.key === k));
    const coverage = { parts: parts.length, partsTotal: Object.keys(BARO_W).length,
                       weightUsed: wsum, weightTotal: wTotal,
                       missing, complete: wsum === wTotal };
    const score = Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0) / wsum);
    const band = score >= 70 ? { k: 'strong', t: 'Strong', c: 'up' }
               : score >= 55 ? { k: 'firm', t: 'Firm', c: 'up' }
               : score >= 40 ? { k: 'mixed', t: 'Mixed', c: '' }
               : score >= 25 ? { k: 'weak', t: 'Weak', c: 'dn' }
               : { k: 'poor', t: 'Poor', c: 'dn' };

    /* ── THE SECOND READING ───────────────────────────────────────────────
     * What a fall has actually PUT ON OFFER. Three conditions, because any
     * one of them alone is a bull trap: a deep drawdown with breadth intact
     * is a rotation, washed-out breadth without a drawdown is a narrow
     * market, and high VIX without either is a scare.
     *
     * The thresholds are the ones that have historically marked a bottom
     * rather than a dip — and they are NOT a promise about this one. A
     * market 25% off its high has always eventually recovered on the index;
     * an individual name has not, which is why the wording is about tranches
     * and never about timing the low. */
    const dd = nifty ? Math.abs(n(nifty.from_high_pct) || 0) : null;
    const acc = (() => {
      if (dd == null || aboveP == null) return null;
      const hits = [];
      if (dd >= 25) hits.push(`the index is ${dd.toFixed(0)}% off its high`);
      else if (dd >= 15) hits.push(`the index is ${dd.toFixed(0)}% off its high`);
      else if (dd >= 10) hits.push(`the index is ${dd.toFixed(0)}% off its high`);
      if (aboveP <= 20) hits.push(`only ${aboveP.toFixed(0)}% of the market holds its 200-day`);
      else if (aboveP <= 35) hits.push(`${aboveP.toFixed(0)}% of the market holds its 200-day`);
      if (v != null && v >= 25) hits.push(`VIX at ${v.toFixed(0)} is pricing real fear`);

      const deep = dd >= 25 && aboveP <= 25;
      const real = dd >= 15 && aboveP <= 40;
      const early = dd >= 10;
      const stage = deep ? {
        k: 'deep', t: 'Genuinely cheap', c: 'up',
        say: 'The conditions that marked March 2020 and March 2009 — a fall this deep with '
           + 'participation this washed out. Nobody rings a bell at the low, so this is an '
           + 'argument for buying in tranches on a schedule, not for calling the bottom.' }
        : real ? {
        k: 'real', t: 'Worth buying in instalments', c: 'up',
        say: 'A real correction rather than a wobble. Historically the zone where staged '
           + 'buying has paid — in instalments, because it can always go further.' }
        : early ? {
        k: 'early', t: 'Slightly cheaper', c: '',
        say: 'Cheaper than it was, and nowhere near the levels that have marked a bottom. '
           + 'Worth a first tranche at most.' }
        : {
        k: 'none', t: 'Nothing on sale', c: '',
        say: 'No meaningful fall to buy. Accumulating here is paying up, which is a different '
           + 'decision from the one this reading is about.' };
      return { stage, hits, dd, aboveP };
    })();

    return { score, band, parts, acc, counted, coverage };
  };

  /* Each index, scored the same way on the two things an index can tell you
     about itself: where it sits in its own year, and which way it has been
     going. Breadth is a market-wide figure and deliberately NOT mixed in
     here — it would make every index carry the same number. */
  const indexScore = (it) => {
    const pos = Number(it && it.range_pos);
    const tr = Number(it && it.trend_pct);
    if (!Number.isFinite(pos)) return null;
    const trendScore = !Number.isFinite(tr) ? null
      : Math.max(0, Math.min(100, 50 + tr * 4));   // ±12.5% over the window spans the scale
    const score = trendScore == null ? Math.round(pos)
                : Math.round(pos * 0.6 + trendScore * 0.4);
    return {
      score,
      pos,
      trend: Number.isFinite(tr) ? tr : null,
      call: score >= 70 ? { t: 'Leading', c: 'up' }
          : score >= 55 ? { t: 'Firm', c: 'up' }
          : score >= 40 ? { t: 'Mixed', c: '' }
          : score >= 25 ? { t: 'Lagging', c: 'dn' }
          : { t: 'Weak', c: 'dn' },
    };
  };

  /* ── THE SIZER ───────────────────────────────────────────────────────────
   * Akshay: "convert signal website into a smart website with smart tools."
   *
   * Every signal on this site publishes an entry, a stop and three targets,
   * and then leaves the only question a reader actually has to answer —
   * HOW MUCH — as mental arithmetic done on a phone. That is the gap a tool
   * should fill: not another chart, not another score, the one calculation
   * that stands between reading a setup and acting on it.
   *
   * IT SIZES OFF THE STOP, WHICH IS THE ONLY HONEST WAY. Risk per share is
   * entry minus stop; shares are the rupees you are willing to lose divided
   * by that. A sizer that works backwards from "how much do I want to buy"
   * is a tool for talking yourself into a position, and this site's own
   * ledger is the argument against building one.
   *
   * THE CAP IS PART OF THE ANSWER. A 1.5%-risk position on a stop that sits
   * 2% away is 75% of the account in one name, which is arithmetically
   * correct and ruinous. When the sizer would exceed a quarter of the book it
   * says so and shows the capped number instead.
   *
   * Account size lives in localStorage and never leaves the browser — it is
   * nobody's business, least of all this site's. */
  const SIZER_KEY = 'sig.sizer.v1';
  const sizerRead = () => {
    try {
      const v = JSON.parse(localStorage.getItem(SIZER_KEY) || '{}');
      return { cap: Number(v.cap) > 0 ? Number(v.cap) : 500000,
               risk: Number(v.risk) > 0 ? Number(v.risk) : 1 };
    } catch (e) { return { cap: 500000, risk: 1 }; }
  };
  const sizerWrite = (cap, risk) => {
    try { localStorage.setItem(SIZER_KEY, JSON.stringify({ cap, risk })); } catch (e) {}
  };

  const MAX_POS_PCT = 25;        // of the book, in one name

  const sizerHtml = (entry, sl, t1, t2, t3, action, cur = '₹') => {
    const e = lvl(entry), st = lvl(sl);
    if (e == null || st == null || e === st) return '';
    const short = /SELL|SHORT/i.test(String(action || ''));
    const perShare = Math.abs(e - st);
    const { cap, risk } = sizerRead();
    const rupees = cap * (risk / 100);
    let qty = Math.floor(rupees / perShare);
    const raw = qty;
    const capped = Math.floor((cap * MAX_POS_PCT / 100) / e);
    const hitCap = qty > capped;
    if (hitCap) qty = capped;
    const value = qty * e;
    const payAt = (t) => {
      const v = lvl(t);
      if (v == null || !qty) return null;
      const move = short ? e - v : v - e;
      return move * qty;
    };
    const money = (v) => cur + Math.round(v).toLocaleString('en-IN');
    const rung = (label, t) => {
      const p = payAt(t);
      return p == null ? '' : `<span><i>${label}</i><b class="${p >= 0 ? 'up' : 'dn'}">${
        (p >= 0 ? '+' : '') + money(p)}</b></span>`;
    };
    return `<div class="szr" data-szr>
      <div class="szr-in">
        <label><span>Account</span><input type="text" inputmode="numeric" data-szr-cap
          value="${esc(String(cap))}" aria-label="Account size in rupees"></label>
        <label><span>Risk %</span><input type="text" inputmode="decimal" data-szr-risk
          value="${esc(String(risk))}" aria-label="Percent of the account risked on this trade"></label>
      </div>
      <div class="szr-out">
        <span class="szr-q"><i>Size</i><b>${qty.toLocaleString('en-IN')}</b><em>shares</em></span>
        <span><i>Costs</i><b>${money(value)}</b></span>
        <span><i>Risks</i><b class="dn">${money(Math.min(rupees, qty * perShare))}</b></span>
      </div>
      <div class="szr-r">${rung('At T1', t1)}${rung('At T2', t2)}${rung('At T3', t3)}</div>
      <p class="szr-n">${hitCap
        ? `Sized down from <b>${raw.toLocaleString('en-IN')}</b>: risking ${risk}% with a stop
           ${(perShare / e * 100).toFixed(1)}% away would put
           <b>${Math.round(raw * e / cap * 100)}%</b> of the book in one name. Capped at
           ${MAX_POS_PCT}%.`
        : `${money(perShare)} a share at risk · stop is ${(perShare / e * 100).toFixed(1)}% away.`}
        Your account size stays in this browser. Nothing here is advice.</p>
    </div>`;
  };

  /* One delegated handler for every sizer on the page. Recomputes by asking
     the row to re-render itself is not possible here — the card is a string —
     so it patches the numbers in place, which is also why the inputs keep
     focus while you type. */
  document.addEventListener('input', (ev) => {
    const el = ev.target.closest && ev.target.closest('[data-szr] input');
    if (!el) return;
    const box = el.closest('[data-szr]');
    const capEl = box.querySelector('[data-szr-cap]');
    const riskEl = box.querySelector('[data-szr-risk]');
    const cap = Number(String(capEl.value).replace(/[^\d.]/g, ''));
    const risk = Number(String(riskEl.value).replace(/[^\d.]/g, ''));
    if (!(cap > 0) || !(risk > 0)) return;
    sizerWrite(cap, risk);
    /* Every other sizer on the page is now stale — they all read the same
       account. Repaint the route rather than patch nine of them by hand. */
    clearTimeout(window.__szrT);
    window.__szrT = setTimeout(() => {
      const box2 = document.querySelector('[data-szr] input:focus');
      if (!box2) render();
    }, 700);
  });

  const trailPlan = (entry, sl, t1, t2, t3, action) => {
    /* EVERY NUMBER HERE IS A PRICE, SO ZERO MEANS ABSENT.
     *
     * This read Number(t2). The API returns null for a target that collapsed
     * into the one before it, Number(null) is 0, and 0 is finite — so a target
     * that does not exist became a price of zero and then passed every guard
     * below it. Published on the live card as:
     *
     *     50%  at ₹0.00   second target · 6.7R
     *     30%  at ₹613.41 the balance, at the third · 8.8R
     *
     * on a stock trading at ₹264 with a real third target of ₹371.59. The 6.7R
     * is the distance from ₹264 down to ₹0 measured in risk. */
    const e = lvl(entry), s0 = lvl(sl), a = lvl(t1), b = lvl(t2), c = lvl(t3);
    if (e === null || s0 === null || a === null || e === s0) return '';
    const short = /SELL|SHORT/i.test(String(action || ''));
    const f = v => price(v);
    const steps = [
      [`Stop stays at ${f(s0)}`, 'until the first target prints'],
      [`After T1, trail to ${f(e)}`, 'break-even — never back below it'],
    ];
    if (b !== null) steps.push([`After T2, trail to ${f(a)}`, 'locking the first target in']);
    /* ── THE SCALE-OUT, BESIDE THE TRAIL ──────────────────────────────────
     * 20% at the first target, 50% at the second, the balance at the third.
     *
     * The trail above says where the stop goes; it never said how much to
     * sell, so a reader following it held the whole position to a single exit.
     * These are two halves of one plan and were only ever half published.
     *
     * The fractions are the operator's, and the arithmetic beside each rung is
     * what they actually bank — 20% of a position at 1.6R is 0.32R of the
     * whole, which is the figure worth seeing rather than the percentage on
     * its own. Weighted across all three rungs the plan returns 0.20x1.6 +
     * 0.50x2.5 + 0.30x3.3 = 2.56R if every target prints, against 3.3R for
     * holding it all to the last one. That is the cost of taking money off the
     * table, and it is stated rather than left for the reader to discover.
     *
     * Same standing as the trail: a management rule, not a re-grade. The
     * ledger is still scored to the single stop the signal was sent with. */
    /* THE THIRD TARGET IS THE ONE THE ENGINE PUBLISHED, NOT ONE DERIVED FROM
     * THE SECOND. This synthesised it as T2 scaled by 3.3/2.5 while the row
     * carried a real target3 the whole time — so the rung shown was never a
     * level anyone had underwritten, and when T2 was blank it was arithmetic
     * on zero. The house ladder ratio is a fallback for rows that genuinely
     * have no third, and it is derived from T1 there, which always exists. */
    const third = c !== null ? c
      : (b !== null ? e + (short ? -1 : 1) * Math.abs(b - e) * (3.3 / 2.5) : null);
    const rOf = lv => Math.abs(lv - e) / Math.abs(e - s0);
    const rungs = [
      ['20%', a, 'first target'],
      b !== null ? ['50%', b, 'second target'] : null,
      third !== null && (b === null || Math.abs(third - b) > 1e-9)
        ? ['30%', third, 'the balance, at the third'] : null,
    ].filter(Boolean);
    /* Two rungs, not three, when a target was blanked — and then the split has
     * to add up. Publishing 20/50 of a position and never saying where the
     * other 30% goes is worse than not publishing a ladder at all. */
    if (rungs.length === 2) { rungs[0][0] = '30%'; rungs[1][0] = '70%'; }
    /* ONE TARGET IS NOT A LADDER. "100% at ₹1,569" reads like a scale-out
     * plan with one rung; it is simply the whole position at the only exit
     * this signal has, and saying so is shorter and truer. */
    if (rungs.length === 1) { rungs[0][0] = 'All'; rungs[0][2] = 'the only target'; }
    const banked = rungs.reduce((x, [pcStr, lv]) => x + parseFloat(pcStr) / 100 * rOf(lv), 0);
    /* SAY THE PRICES PER CARD; SAY THE SENTENCE ONCE PER PAGE.
     *
     * Every number below differs from card to card. None of the WORDS did.
     * "until the first target prints", "break-even — never back below it",
     * "locking the first target in", "first target", "second target", "the
     * balance, at the third", and a forty-word closing paragraph about what
     * taking money off the table costs — all identical on every card, on a
     * page carrying five of them, and again on /signals under thirty rows.
     *
     * The stop path becomes one line of three prices. The ladder keeps a line
     * per rung, because each rung is a different price at a different R. The
     * closing paragraph is deleted from the card: TRAIL_NOTE already states
     * the same standing once, under the list it applies to, and the two
     * figures it was carrying survive as the line beneath the rungs.
     *
     * Eleven lines to five, and not one number lost. */
    /* THE RULE NAMES THE LEVELS; THE GRID ABOVE HOLDS THE PRICES.
     *
     * This line printed the three prices again — stop, entry, target 1 — every
     * one of which is in the key-value grid four rows above it. On the
     * conviction cards that put target 1 on the card THREE times: once in the
     * plan grid, once here, and once more as the first scale-out rung.
     *
     * A stop path is a rule, and a rule reads better as roles than as
     * repeated figures: "as sent, then break-even once the first target
     * prints, then the first target once the second does" is the whole
     * management plan and contains nothing the reader has to reconcile
     * against the numbers beside it. */
    const hops = ['as sent', 'break-even after T1'];
    if (b !== null) hops.push('target 1 after T2');
    return `<div class="trail">
      <div class="tr-1"><span class="tr-k">Stop path</span>
        <span class="tr-v">${hops.map(esc).join('<i>→</i>')}</span></div>
      <div class="tr-sc">
        <span class="tr-sch">Scale-out</span>
        ${rungs.map(([pcStr, lv, lab]) => `<div class="tr-r">
          <b>${esc(pcStr)}</b><span>at ${f(lv)}</span><i>${esc(lab)} · ${rOf(lv).toFixed(1)}R</i>
        </div>`).join('')}
        ${/* ── THE BLEND IS A PROPERTY OF THE LADDER, NOT OF THIS SIGNAL ──────
            * It read "3.54R laddered · 4.62R held to the last target" on the
            * card. Since the ladder was frozen in R — every 2R engine files
            * T1 2.0R, T2 2.9R, T3 3.7R — that arithmetic is IDENTICAL for
            * every signal the engine publishes. Measured on the front page:
            * five different names, five identical sentences.
            *
            * A line that is the same on every card tells the reader nothing
            * about the card it is on. It is a fact about the ladder, so it is
            * stated once beneath the list, with the rungs above still carrying
            * the per-signal prices and R-multiples that do differ. */''}
      </div>
    </div>`;
  };

  /* Where price sits between the stop and the first target. The number says
   * how far; the bar says how far RELATIVE TO THE RISK TAKEN, which is the
   * thing a stop and a target exist to frame. */
  const progressToTarget = (entry, sl, t1, last, action) => {
    const lo = Math.min(sl, t1), hi = Math.max(sl, t1);
    if (!(hi > lo)) return '';
    const at = Math.max(0, Math.min(100, (last - lo) / (hi - lo) * 100));
    const entryAt = Math.max(0, Math.min(100, (entry - lo) / (hi - lo) * 100));
    return `<div class="prog" title="Stop ${sl} · entry ${entry} · target ${t1}">
      <span class="prog-bar"><i style="width:${at.toFixed(1)}%"></i>
        <em style="left:${entryAt.toFixed(1)}%"></em></span>
      <span class="prog-l"><span>stop</span><span>entry</span><span>target</span></span>
    </div>`;
  };

  /* ── JOIN ────────────────────────────────────────────────────────────────
   * An honest early-access capture, not a fake login.
   *
   * It posts to /api/subscribe, which already exists and already does the
   * hard parts: RFC-ish validation, a honeypot, a minimum time-on-page, one
   * row per address, and a per-IP hourly cap enforced in SQL because lambdas
   * do not share memory. The raw IP is never stored — it is salted and hashed
   * only so the rate limit can work.
   *
   * There is deliberately no password field. A password box that does not
   * authenticate anything is the worst thing this page could ship: it teaches
   * a reader to hand over a credential to a form that cannot check it. Real
   * accounts need a session store and a thirteenth serverless function, and
   * this project is at Vercel's twelve-function cap — see the note in
   * api/signals.js. That is a decision to take deliberately, not a box to draw.
   */
  const MOUNTED_AT = Date.now();
  R['/join'] = async () => {
    paint(`<div class="join">
      <div class="join-l">
        <h1>Join the morning list.</h1>
        <p class="join-sub">The daily email is <b>not being sent yet</b>. Leave your address and
          you will get the first one when it starts: what moved, the sector heat, the books open
          that day and the names the engine put up — with the levels it put them up at.
          Until then, <a href="/brief">today’s brief</a> is here every morning.</p>
        <ul class="join-ul">
          <li><b>Free.</b> No card, no trial that expires into a charge.</li>
            <li><b>The record is public.</b> Every signal is scored when it closes — losers
            included, which is the point of publishing it.</li>
          <li><b>One email a day, once it starts.</b> Unsubscribe in one click, and the list
            is a table we own rather than a mailing vendor's.</li>
        </ul>
      </div>
      <div class="join-r">
        <form id="joinF" novalidate>
          <label for="joinE">Email address</label>
          <input id="joinE" name="email" type="email" inputmode="email" autocomplete="email"
                 placeholder="you@example.com" required>
          <!-- Bots fill this. Humans never see it. -->
          <div class="hp" aria-hidden="true">
            <label for="joinW">Website</label>
            <input id="joinW" name="website" type="text" tabindex="-1" autocomplete="off">
          </div>
          <button type="submit" class="btn-primary" id="joinB">Join the list</button>
          <p class="join-note" id="joinM">Nothing is sent until the daily email starts. Then one a day, nothing else.</p>
        </form>
      </div>
    </div>`);

    const f = document.getElementById('joinF');
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const btn = document.getElementById('joinB');
      const msg = document.getElementById('joinM');
      const email = document.getElementById('joinE').value.trim();
      // Validate here as well as on the server: a round trip to be told the
      // address has no @ in it is a round trip wasted.
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) {
        msg.className = 'join-note bad';
        msg.textContent = 'That address does not look right — check for a typo.';
        return;
      }
      btn.disabled = true; btn.textContent = 'Sending…';
      msg.className = 'join-note'; msg.textContent = 'One moment.';
      try {
        const r = await fetch('/api/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email, website: document.getElementById('joinW').value,
            elapsed: Date.now() - MOUNTED_AT,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok !== false) {
          /* THE RECEIPT SAYS WHAT HAPPENS NEXT, AND NOTHING THAT WILL NOT.
             It promised "the next brief goes out before tomorrow's open"; no
             job sends it yet (the list is exported, not mailed), so a reader
             was told to watch for an email that was never coming. */
          f.innerHTML = `<div class="join-ok" role="status"><b>You are on the list.</b>
            Nothing will be sent until the daily email starts; the first one will say so.
            Until then, <a href="/brief">today's brief</a> is on this site every morning.</div>`;
        } else {
          msg.className = 'join-note bad';
          msg.textContent = j.error || 'That did not go through. Try again in a moment.';
          btn.disabled = false; btn.textContent = 'Join the list';
        }
      } catch (e) {
        msg.className = 'join-note bad';
        msg.textContent = 'No connection. Your address was not sent — try again.';
        btn.disabled = false; btn.textContent = 'Join the list';
      }
    });
  };

  /* ══════════════════════════════════════════════════════════════════════
   * THE TRADING SIGNAL BRIEF
   *
   * A research document you can interrogate, not a page you read. Everything
   * on it is derived from three real sources — the published ledger, the
   * NSE screen, and six months of actual daily closes — and anything
   * those three cannot answer is printed as unmeasured rather than filled in.
   *
   * WHAT CHANGED, AND WHY THE CAPTION CHANGED WITH IT.
   * This page used to carry a "level map" and a caption explaining that no
   * feed here served price history. That was true of the ROUTES, not of the
   * upstream: the same spark endpoint the market rail already calls returns a
   * close series. /api/signals?series= now exposes it, so the chart is drawn
   * from prices that happened. There are still no candles, because there is
   * still no open/high/low — and the caption says exactly that, rather than
   * implying the chart is complete.
   *
   * WHAT IS DELIBERATELY ABSENT.
   *   · Scenario probabilities. The engine publishes no probability model, so
   *     the scenarios carry the ledger's own base rate — labelled as a base
   *     rate over N closed trades — and never a per-trade percentage.
   *   · An intraday development timeline. The ledger records the signal date
   *     and the send time; it does not record "momentum confirmed at 09:24".
   *     The timeline shows what is recorded and says so.
   * ══════════════════════════════════════════════════════════════════════ */

  let briefSym = null;                 // set when arriving from a signal card
  /* WHAT THE READER IS LOOKING AT, kept across refreshes.
   *
   * briefSym was consumed on first use and set back to null. The page repaints
   * itself every 60 seconds, and on that repaint the symbol was gone — so the
   * brief fell back to "highest reward-to-risk open setup" and silently swapped
   * a different company in while someone was reading. Click JMFINANCIL, scroll
   * for a minute, find yourself reading JKTYRE.
   *
   * briefPick holds the choice for as long as the reader is on this route.
   * render() clears it when they leave, so arriving fresh still picks the best
   * available setup rather than resurrecting an old one. */
  let briefPick = null;
  let briefRange = '6mo';              // the chart window the reader last chose

  /* Realised volatility and trend persistence, both computed from the real
   * close series. Returns null rather than a number when the series is too
   * short to support one — 20 closes is the floor for a 20-day mean. */
  function regimeOf(closes) {
    if (!Array.isArray(closes) || closes.length < 30) return null;
    const rets = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    }
    if (rets.length < 20) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
    const vol = Math.sqrt(varr) * Math.sqrt(252) * 100;      // annualised, %

    // Trend persistence: over the last 60 closes, the share that sat above
    // their own trailing 20-day mean. 50% is a coin flip and reads as a range;
    // a sustained trend pins it high or low.
    const W = 20, look = Math.min(60, closes.length - W);
    let above = 0;
    for (let i = closes.length - look; i < closes.length; i++) {
      let s = 0; for (let k = i - W; k < i; k++) s += closes[k];
      if (closes[i] > s / W) above++;
    }
    const persist = (above / look) * 100;
    const net = (closes[closes.length - 1] / closes[0] - 1) * 100;
    const trending = persist >= 66 || persist <= 34;
    return {
      vol, persist, net, look,
      label: trending ? (persist >= 66 ? 'TRENDING UP' : 'TRENDING DOWN') : 'RANGING',
      volLabel: vol >= 45 ? 'HIGH VOLATILITY' : vol >= 22 ? 'NORMAL VOLATILITY' : 'LOW VOLATILITY',
    };
  }

  /* THE CHART. One <svg> in a fixed 1000×340 user space, stretched to fit with
   * preserveAspectRatio="none" — so it fills any width at any height without a
   * measurement pass, and without ResizeObserver, which never fires in a
   * hidden tab. Strokes stay a constant visual width through
   * vector-effect:non-scaling-stroke, and every LABEL is HTML positioned by
   * percentage rather than SVG text, because stretched text is unreadable.
   *
   * The overlays are emitted hidden. The scroll story turns them on in the
   * order the argument is made. */
  function priceChart(pts, levels, cur) {
    const W = 1000, H = 340, PADT = 14, PADB = 14;
    const cs = pts.map(p => p.c);
    const lv = levels.filter(l => Number.isFinite(l.v));
    const lo = Math.min.apply(null, cs.concat(lv.map(l => l.v)));
    const hi = Math.max.apply(null, cs.concat(lv.map(l => l.v)));
    const span = (hi - lo) || 1;
    const X = i => (i / Math.max(1, pts.length - 1)) * W;
    const Y = v => PADT + (1 - (v - lo) / span) * (H - PADT - PADB);
    const yp = v => ((Y(v) / H) * 100);              // percent, for HTML labels
    const d = cs.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(2)).join(' ');

    const line = (l, i) => `<line class="lvl ${l.c} b-ov" data-ov="${l.step}" x1="0" x2="${W}"
        y1="${Y(l.v).toFixed(2)}" y2="${Y(l.v).toFixed(2)}"/>`;
    const zone = (a, b, cls, step) => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
      const y1 = Math.min(Y(a), Y(b)), h = Math.abs(Y(a) - Y(b));
      return `<rect class="zone ${cls} b-ov" data-ov="${step}" x="0" y="${y1.toFixed(2)}"
        width="${W}" height="${Math.max(1, h).toFixed(2)}"/>`;
    };
    const lab = l => `<span class="b-px-lab ${l.c} b-ov" data-ov="${l.step}"
        style="top:${yp(l.v).toFixed(2)}%">${esc(l.k)} <b>${esc(l.f)}</b></span>`;

    return {
      html: `<div class="b-px-c" id="pxc">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs><linearGradient id="bgrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="currentColor" stop-opacity=".16"/>
            <stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
          ${zone(cur.stop, cur.entry, 'r', 6)}
          ${zone(cur.entry, cur.t2, 'g', 7)}
          <path class="parea" d="${d} L${W} ${H} L0 ${H} Z"/>
          <path class="price" d="${d}"/>
          ${lv.map(line).join('')}
          <line class="cross" id="pxcross" x1="0" x2="0" y1="0" y2="${H}" style="opacity:0"/>
        </svg>
        <div class="b-px-labs">${lv.map(lab).join('')}</div>
        <span class="b-px-dot" id="pxdot"></span>
        <div class="b-px-t" id="pxt"></div>
        <div class="b-px-hit" id="pxhit" role="img"
          aria-label="${esc(pts.length)} daily closes from ${esc(pts[0].t || '')} to ${esc(pts[pts.length - 1].t || '')}, with the published entry, stop and targets overlaid"></div>
      </div>`,
      X, Y, lo, hi, span, W, H,
    };
  }

  /* ── THE BRIEF IS A ONE-PAGER, AND THE REST IS ONE CLICK ─────────────────
   *
   * Twelve sections and 9,800px. Asked for a one-pager three times, and I kept
   * returning the decision — which sections die — because it is a judgement
   * about the product. It is my call to make and here it is, stated so it can
   * be overruled in one line.
   *
   * THREE STAY, because they are what a reader needs to act:
   *   the levels        you cannot take the trade without them
   *   the chart         the context those levels sit in
   *   the plan          what to do, and when to stop doing it
   *
   * THE OTHER EIGHT ARE THE WORKUP: scoring, confluence, fundamentals,
   * regime, scenarios, cost-if-wrong, the paper trail, the record. Every one
   * is worth reading and none of them is worth scrolling past to reach the
   * stop-loss. They fold into one block, open in a click, and nothing is
   * deleted — this is a change to the ORDER OF ATTENTION, not to what the
   * page says.
   *
   * Done in the DOM after paint rather than by restructuring a 700-line
   * template: the sections are already siblings, and moving them is a smaller
   * and far more reversible change than rewriting how they are built. */
  /* ── WHAT A ONE-PAGER IS, CORRECTED ──────────────────────────────────────
   *
   * The first cut kept levels, chart and plan — "how to trade it" — and folded
   * the other ten. That buried the company's own financials and the SWOT, and
   * Akshay's read was exactly right: from the front, the brief had no
   * fundamentals. The fold's summary named them, but a reader scanning the
   * page sees no fundamentals, and a summary is not a substitute for the
   * thing.
   *
   * For a swing trade on a single company, what you would OWN is not the
   * workup. It is half the case. Five sections now, and they answer the
   * questions in the order anyone actually asks them:
   *
   *   the levels      where price sits against the plan
   *   b-chart         where it has been
   *   b-business      what the company earns — P/E, ROCE, Piotroski, margins
   *   b-fund          what you would own, and what could go wrong (the SWOT)
   *   b-plan          what to do, and when to stop
   *
   * What stays folded is genuinely internal: how the score is composed, which
   * factors agree, the regime test, the three scenarios, the cost if wrong,
   * the paper trail and the engine's record. Every one is worth reading and
   * none is worth scrolling past to reach a stop-loss. */
  const BRIEF_KEEP = ['b-chart', 'b-business', 'b-fund', 'b-plan'];
  function foldBrief(main) {
    try {
      const secs = [...main.querySelectorAll('.b-sec')];
      if (secs.length < 6) return;                 // nothing to fold
      const keep = new Set();
      secs.forEach((el, i) => {
        if (i === 0) keep.add(el);                 // the levels, always first
        if (BRIEF_KEEP.includes(el.id)) keep.add(el);
      });
      const rest = secs.filter(el => !keep.has(el));
      if (rest.length < 3) return;
      const d = document.createElement('details');
      d.className = 'b-fold';
      d.innerHTML = `<summary><span>The full workup</span>
        <i>${rest.length} sections — how the score is composed, which factors agree,
        the regime test, the three scenarios, what it costs if it is wrong, the paper
        trail and this engine's record</i></summary>`;
      rest[0].parentNode.insertBefore(d, rest[0]);
      rest.forEach(el => d.appendChild(el));
      /* The reveal animation is driven by an observer that has already run on
       * these nodes; moving them leaves the class behind, so it is reapplied
       * rather than left to a second observer pass that will not come. */
      rest.forEach(el => el.classList.add('in'));
    } catch (e) { /* a fold that throws must not cost the brief */ }
  }

  /* (V1 handler removed at the Signal V2 cutover; see the V2 block below.) */



  /* ══ COMMAND PALETTE ═══════════════════════════════════════════════════
   * ⌘K / Ctrl+K. Every destination it offers is a route that exists, and the
   * symbol search runs against the screen this site already loads — nothing
   * here promises a capability the product does not have.
   *
   * Built as a <dialog>, so the browser supplies the modal semantics, the
   * focus trap and Escape for free. Rolling those by hand is how a search box
   * ends up unreachable by keyboard.
   */
  const CMD_ROUTES = [
    ['/', 'Today', 'The latest session, the next one, and the V2 plans'],
    ['/opportunities', 'Opportunities', 'Every V2 plan by state, eligible first'],
    ['/performance', 'Performance', 'The V2 forward record, from 1 Oct 2026'],
    ['/markets', 'Markets', 'The board: 71 instruments with a year of context'],
    ['/ipo', 'IPO', 'Books open now, and how last year’s listings did'],
    ['/screen', 'Screen', 'All names, searchable'],
    ['/watch', 'Watchlist', 'Names you starred, and your price alerts'],
    ['/news', 'News', 'The full wire, and the screened names each story touches'],
    ['/brief', 'Brief', 'The current plan, in full'],
    ['/discover', 'Discover', 'Every way into the screen'],
    ['/radar', 'Signal radar', 'What the market is doing, and which names carry it'],
    ['/methodology', 'Methodology', 'How every number on this site is made'],
    ['/sources', 'Data sources', 'Where the prices come from, and what that means'],
    ['/terms', 'Terms', 'What this is and is not'],
    ['/privacy', 'Privacy', 'What is stored, which is almost nothing'],
  ];

  let cmdEl = null, cmdIdx = 0, cmdRows = [];
  function buildCmd() {
    if (cmdEl) return cmdEl;
    cmdEl = document.createElement('dialog');
    cmdEl.className = 'cmd';
    cmdEl.innerHTML = `
      <form method="dialog" class="cmd-in" role="search">
        <input id="cmdQ" type="search" autocomplete="off" spellcheck="false"
               placeholder="Search sections and companies…" aria-label="Search sections and companies">
        <div class="cmd-list" id="cmdList" role="listbox" aria-label="Results"></div>
        <div class="cmd-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close</div>
      </form>`;
    document.body.appendChild(cmdEl);
    cmdEl.addEventListener('click', e => { if (e.target === cmdEl) cmdEl.close(); });
    const q = cmdEl.querySelector('#cmdQ');
    q.addEventListener('input', () => drawCmd(q.value));
    q.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        cmdIdx = Math.max(0, Math.min(cmdRows.length - 1, cmdIdx + (ev.key === 'ArrowDown' ? 1 : -1)));
        markCmd();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const hit = cmdRows[cmdIdx];
        if (hit) { cmdEl.close(); if (hit.ext) location.href = hit.href; else go(hit.href); }
      }
    });
    return cmdEl;
  }
  const markCmd = () => {
    const list = cmdEl.querySelector('#cmdList');
    [...list.children].forEach((el, i) => {
      el.setAttribute('aria-selected', i === cmdIdx ? 'true' : 'false');
      if (i === cmdIdx) el.scrollIntoView({ block: 'nearest' });
    });
  };
  function drawCmd(term) {
    const t = String(term || '').trim().toLowerCase();
    const routes = CMD_ROUTES
      .filter(([, name, desc]) => !t || name.toLowerCase().includes(t) || desc.toLowerCase().includes(t))
      .map(([href, name, desc]) => ({ href, name, desc, kind: 'Section' }));
    // Company search only searches what is loaded. If the screen has not been
    // fetched yet it offers nothing rather than pretending to have looked.
    const names = t.length >= 2 && SCREEN
      ? SCREEN.filter(r => (r.sym || '').toLowerCase().includes(t)
                        || (r.name || '').toLowerCase().includes(t))
              .slice(0, 6)
              .map(r => ({ href: '/stock/' + encodeURIComponent(r.sym), name: r.sym, desc: r.name || '', kind: 'Company',
                           sym: r.sym }))
      : [];
    // The top match also offers the deep page, in the child product.
    if (names.length) names.splice(1, 0, { href: visionUrl(names[0].sym), name: `Open ${names[0].sym} in Vision`,
      desc: 'What matters, what changed — sourced', kind: 'Vision', ext: true });
    const vis = !t || 'vision company research'.includes(t) ? [{ href: VISION_URL + '/', name: 'Vision ↗', desc: 'Company research — understand any NSE company', kind: 'Vision', ext: true }] : [];
    cmdRows = routes.concat(vis, names);
    cmdIdx = 0;
    const list = cmdEl.querySelector('#cmdList');
    list.innerHTML = cmdRows.length ? cmdRows.map((r, i) => `
      <button type="button" class="cmd-r" role="option" aria-selected="${i === 0}" data-i="${i}">
        <span class="k">${esc(r.kind)}</span>
        <span class="n">${esc(r.name)}</span>
        <span class="d">${esc(r.desc)}</span>
      </button>`).join('')
      : `<p class="cmd-none">Nothing matches “${esc(t)}”.${SCREEN ? ''
          : ' Company search needs the Screen page opened once first.'}</p>`;
    list.querySelectorAll('.cmd-r').forEach(b => b.addEventListener('click', () => {
      const hit = cmdRows[Number(b.dataset.i)];
      cmdEl.close();
      if (hit.ext) location.href = hit.href;
      else if (hit.sym) go('/stock/' + encodeURIComponent(hit.sym));
      else go(hit.href);
    }));
    markCmd();
  }
  function openCmd() {
    const d = buildCmd();
    drawCmd('');
    if (!d.open) d.showModal();
    const q = d.querySelector('#cmdQ');
    q.value = ''; q.focus();
  }
  document.addEventListener('keydown', ev => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openCmd(); }
    // "/" is the other convention, but only when the reader is not typing.
    const t = ev.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (ev.key === '/' && !typing && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); openCmd(); }
  });

  /* ══ DATA FRESHNESS ════════════════════════════════════════════════════
   * "9 / 12 datasets current", from the same health artefact the newspaper
   * build writes. It is a summary in the header and the full table behind a
   * click — the detail belongs on Methodology, not in the chrome.
   */
  /* ONLY THE DATASETS THIS SITE ACTUALLY RENDERS.
   *
   * data-health.json is the newspaper's artefact and describes twelve
   * datasets, most of which belong to a different product — Careers, Podcasts,
   * Smart Reads, Fund screen. Two of the three it was reporting as degraded
   * were feeds nothing on this site reads, so the header said "9/12 current"
   * about a site whose own data was fine.
   *
   * A freshness badge that counts other people's data is worse than no badge:
   * it is a number that looks like it means something about the page you are
   * on. Scoped to what this site serves, and anything not on the list is
   * ignored rather than counted against us. */
  const OUR_DATASETS = [
    /signal ledger/i,      // the alerts and the record
    /stock screen/i,       // screen.json — Screen, Ideas, Brief
    /^markets$/i,          // the board
    /trade ideas/i,        // today.json
    /new listings/i,       // ipo.json — the IPO route
    /world news/i,         // news.json — the wire on Today
  ];
  let HEALTH = null;
  /* The bar's resolved rows and its repaint, held so a row this bar refuses to
     fetch can be filled by the route that legitimately loads it. Both stay
     null until paintFreshness() has run; every writer checks. */
  let FRESH_ROWS = null, freshPaint = null;
  /* ── A FEED'S AGE, FROM THE COPY THE PAGE ALREADY HAS ────────────────────
   * Called by noteScreenMeta() wherever a screen payload lands, full or lite.
   * It costs nothing: the bytes are already parsed and in memory, and this is
   * the only path by which the Stock screen row is ever filled.
   * The payload names its own projection (`is_lite`), so the panel's URL line
   * reports the file that was actually read rather than a guess. */
  const noteFeedAge = (label, d, url) => {
    if (!FRESH_ROWS || !d) return;
    const row = FRESH_ROWS.find(x => x.label === label);
    if (!row) return;
    const ts = feedStamp(d);
    if (!ts) return;
    row.ts = ts; row.ok = true; row.url = url; row.passive = false;
    row.h = ageHours(ts);
    try { if (freshPaint) freshPaint(); } catch (e) { /* never break a route over a timestamp */ }
  };
  /* ── FRESHNESS, MEASURED HERE ─────────────────────────────────────────────
   *
   * This read a status string out of data-health.json and reported it. On the
   * morning this was rewritten, that file said five of six datasets were
   * "current" — and the file itself was 31 hours old, as was every feed it
   * described. A freshness indicator that can be 31 hours stale about
   * staleness is worse than none: it converts a visible gap into an invisible
   * one, on the one part of the page whose entire job is telling the reader
   * whether to trust the rest.
   *
   * So age is now measured against the clock, from the timestamp inside each
   * file the page actually loaded. The upstream status is still shown in the
   * detail — it says whether the SOURCE thinks a pipeline is healthy, which is
   * a different question from how old this copy is — but it can no longer
   * decide the badge.
   */
  /* [label, url, hours before it counts as behind].
   *
   * ONE THRESHOLD FOR EVERYTHING WAS WRONG. It was 26 hours for every feed,
   * which is right for a daily build and useless for anything faster: the IPO
   * tracker showed green at 19 hours old while the book it describes had moved
   * from 27x to 104x, and the live wire would have shown green a day after it
   * stopped. A feed's tolerance belongs to the feed. */
  /* ── THE SCREEN'S AGE, WITHOUT DOWNLOADING THE SCREEN ────────────────────
   *
   * This row named '/screen.json' — the largest asset on the site, 1.98 MB
   * raw and 253 KB brotli — and paintFreshness runs on EVERY route. So every
   * page load on this site downloaded the full screen table to read one
   * timestamp off the top of it, including the seven routes that had
   * deliberately fetched screen-lite.json instead precisely so they would not
   * have to. The lite projection exists to save ~70 KB on those routes and
   * the chrome above them was spending 253 KB undoing it.
   *
   * It also filled sessionStorage. get() caches every feed there, screen.json
   * is 1.98 MB of a ~5 MB origin quota, and on /radar — screen + lite +
   * institutional — the quota was already exhausted, so the stale-fallback
   * write for whatever loaded next threw and was swallowed.
   *
   * The stamp is IDENTICAL in the two files, not merely similar:
   * stock_screen.lite_payload() copies every top-level key except `rows`
   * straight across, so generated_at, built_at and built_on are the same
   * bytes. Asserted in test/guard.mjs rather than trusted.
   *
   * SO THIS ROW NO LONGER FETCHES AT ALL. paintFreshness() runs ONCE, at
   * boot, on the line before render() — so its requests always start before
   * any route body has run, and picking "the cheaper projection" here just
   * moved the bill: on a cold load of /screen the bar fetched the lite table
   * and the route then fetched the full one, 182 KB spent to avoid 253 KB and
   * 435 KB paid in total.
   *
   * The screen's age comes from the payload the ROUTE loads, handed over by
   * noteScreenMeta() the moment it lands — free, exact, and whichever
   * projection that route legitimately needed. A route that loads no screen
   * says so, which is what the panel above already promises: "every feed THIS
   * PAGE loaded". Forcing a 253 KB download so the sentence could stay true
   * was the sentence describing the bar instead of the page.
   *
   * CACHED(), not HELD(). HELD ignores age by design — it answers "have we
   * ever had this" — and get() only serves from the micro-cache inside
   * MICRO_MS, so a HELD hit outside that window would have made get()
   * re-download the file this note exists to stop paying for. */
  const screenAgeUrl = () => {
    for (const u of [FULL_URL, LITE_URL]) if (CACHED(u).ready || INFLIGHT.has(u)) return u;
    return null;
  };
  const FEED_AGE = [
    ['Stock screen',   screenAgeUrl,       30],
    ['Market pulse',   '/pulse.json',      30],
    ['V2 plans',       '/signal_v2.json',  30],
    /* WAS 8, BECAUSE THE SUBSCRIPTION FIGURE IN THIS FILE WENT STALE INSIDE A
     * SESSION — it showed green at 19 hours while the book it described had
     * moved from 27x to 104x.
     *
     * That is no longer what this file supplies. /api/ipo-live reads the book
     * straight from NSE on every render, the card carries its own "read HH:MM
     * UTC", and the volatile number is never the mirrored one any more. What
     * is left here — band, lot, issue size, the verdict and its reasoning — is
     * a once-daily build like every other artefact above it.
     *
     * Holding it to 8 hours meant the chip went amber every single morning by
     * about nine and stayed there all day, describing a file whose only
     * fast-moving field had already been replaced. A warning that is always on
     * is not a warning. */
    ['IPO tracker',    '/ipo.json',        30],
    ['Wire',           '/api/wire',         1],   // live, refreshed every 15 min
    ['Edition',        '/edition.json',    30],
  ];

  // The timestamp a feed carries, whatever it happens to call it. A feed with
  // no timestamp at all is reported as unknown rather than assumed fresh.
  const feedStamp = d => {
    if (!d || Array.isArray(d)) return null;
    // 'at' is what the Worker's own routes stamp themselves with; without it
    // /api/wire fell through to the inherited edition build time and reported
    // itself as eleven hours old while being minutes old.
    for (const k of ['generated_at', 'built_at', 'at', 'built_on', 'date', 'fetched_at']) {
      if (d[k]) return String(d[k]);
    }
    return null;
  };
  /* A DATE IS NOT MIDNIGHT.
   *
   * This appended T00:00:00 to a date-only stamp, so pulse.json and today.json
   * — which publish "2026-08-31" with no time — were aged from midnight. At
   * 02:28 the following morning both read "1d 2h old" in red, when the build
   * that wrote them had in fact run at 15:26 the previous afternoon and they
   * were about eleven hours old. The panel was calling fresh feeds stale.
   *
   * A date-only stamp carries one day of uncertainty and the honest reading is
   * the most favourable one inside it — the end of that day — with the display
   * saying it is a date rather than a time. */
  const isDateOnly = ts => /^\d{4}-\d{2}-\d{2}$/.test(String(ts || '').trim());
  /* A NAIVE TIMESTAMP IS UTC, AND THE BROWSER ASSUMES IT IS LOCAL.
   *
   * new Date("2026-09-01T23:49:16") — no Z, no offset — is parsed as LOCAL
   * time per the spec. The Python that writes these feeds works in UTC and
   * emits some of them without an offset, so every such stamp was read as
   * being the reader's own UTC offset older than it was.
   *
   * That is not a rounding error, it is the reader's longitude: this site is
   * operated from Malaysia at UTC+8, so a feed built eight hours ago reported
   * as sixteen. The freshness chip read "15h old" about an IPO file that was
   * genuinely 8h old, on a page whose entire claim is that it tells you when
   * to stop trusting it. A staleness indicator that overstates staleness
   * trains the reader to ignore it, which costs exactly as much as one that
   * understates it.
   *
   * Stamps that DO carry an offset (+05:30 on the screen, Z on the wire) are
   * untouched — this only supplies the zone the producer omitted. */
  const ageHours = ts => {
    if (!ts) return null;
    const dateOnly = isDateOnly(ts);
    let v = String(ts);
    if (!dateOnly && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(v)) v += 'Z';
    const dt = new Date(dateOnly ? ts + 'T23:59:59' : v);
    if (isNaN(dt)) return null;
    return Math.max(0, (Date.now() - dt.getTime()) / 36e5);
  };
  /* How old a single story is. RSS gives every item a pubDate, which is the
   * thing the daily wire never had: "12m ago" is what tells a reader the wire
   * is moving, and no amount of restating the file's age does that. */
  /* ── ONE STORY, ONCE ──────────────────────────────────────────────────────
   *
   * Ten wires covering one market print the same event five times. Measured on
   * a live pull of 60 stories: six clusters — oil and US-Iran (6 headlines),
   * the $127bn NRI deposit number (4), tomorrow's Nifty open (7), the
   * HDFC/ICICI Nifty crown (2), the Lumino listing (2), Swiggy's MSCI removal
   * (2). Two of them were the SAME outlet contradicting itself on the same
   * open — "Gift Nifty hints cautious start" beside "Gift Nifty hints a
   * positive start".
   *
   * Exact-title matching finds none of this: every wire writes its own
   * headline. Plain word overlap does not find it either — "Oil prices edge
   * lower on US-Iran war uncertainty" and "Oil prices edge lower as markets
   * weigh renewed US-Iran supply risks" share four words in ten and score 0.4
   * on a Jaccard, under any threshold loose enough to be safe.
   *
   * So the comparison is IDF-WEIGHTED: a word is worth what it is rare. In a
   * batch about the Indian market, "market" and "stocks" carry nothing and
   * "NRI", "Lumino" and "127" carry the story. Document frequency is computed
   * over the batch in hand, so the weighting adapts to what the day is about
   * instead of relying on a stop-list somebody has to maintain.
   *
   * DUPLICATES ARE MERGED, NOT DROPPED. That a story ran on four wires is
   * information — it is the closest thing this feed has to a measure of how
   * big the story is — so the first one keeps its place and the others become
   * a byline. Nothing is hidden; it is counted.
   *
   * The threshold is 0.34, the middle of a plateau: 0.28, 0.32 and 0.36 all
   * merge the same eight pairs, and every one of those eight is a genuine
   * duplicate on inspection. Above 0.42 it starts missing them. It errs toward
   * under-merging, because two stories wrongly merged loses one, and two
   * stories wrongly kept costs a line.
   */
  const WIRE_STOP = new Set(['this', 'that', 'with', 'from', 'their', 'they', 'will',
    'have', 'been', 'after', 'more', 'than', 'over', 'into', 'amid', 'says', 'said',
    'ahead', 'check', 'live', 'updates', 'today', 'stock', 'stocks', 'share', 'shares',
    'market', 'markets', 'price', 'prices', 'news']);
  const wireToks = t => [...new Set(String(t || '').toLowerCase()
    .replace(/[^a-z0-9₹$ ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !WIRE_STOP.has(w)))];

  function dedupeWire(stories, threshold = 0.34) {
    const list = Array.isArray(stories) ? stories : [];
    if (list.length < 2) return list;
    const toks = list.map(x => wireToks(x.title));
    const df = new Map();
    for (const t of toks) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
    const idf = w => Math.log(list.length / (1 + (df.get(w) || 0)));
    const sim = (a, b) => {
      const B = new Set(b);
      let inter = 0, ua = 0, ub = 0;
      for (const w of a) { ua += idf(w); if (B.has(w)) inter += idf(w); }
      for (const w of b) ub += idf(w);
      const d = Math.sqrt(ua * ub);
      return d > 0 ? inter / d : 0;
    };
    /* THE TITLE IS NOT THE ONLY THING THAT REPEATS.
     *
     * This compared headlines and nothing else, so two wires running the same
     * story under different headlines but the SAME body both printed — and the
     * page showed one paragraph twice. Caught on /news: "The Fed's indication
     * of another rate hike in 2026 kept investors cautious…" under two
     * different titles from two sources.
     *
     * An identical summary is not a similarity judgement to tune a threshold
     * for; it is the same text. Checked exactly, before the fuzzy title pass,
     * and the second one becomes a byline on the first exactly as a
     * title-match would. */
    const bodyKey = (x) => String(x && x.summary || '')
      .toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
    const byBody = new Map();

    const kept = [];
    for (let i = 0; i < list.length; i++) {
      let host = null;
      const bk = bodyKey(list[i]);
      if (bk.length >= 60 && byBody.has(bk)) {
        host = byBody.get(bk);
      } else {
        for (const k of kept) { if (sim(toks[i], toks[k.i]) >= threshold) { host = k; break; } }
      }
      if (host) {
        // The byline, not a deletion. Same source twice is not worth printing.
        const src = list[i].source;
        if (src && src !== list[host.i].source && !host.also.includes(src)) host.also.push(src);
      } else {
        const k = { i, also: [] };
        kept.push(k);
        if (bk.length >= 60) byBody.set(bk, k);
      }
    }
    return kept.map(k => (k.also.length
      ? { ...list[k.i], _also: k.also, _wires: k.also.length + 1 }
      : list[k.i]));
  }

  const storyAge = iso => {
    if (!iso) return '';
    const m = (Date.now() - Date.parse(iso)) / 60000;
    if (!Number.isFinite(m) || m < 0) return '';
    if (m < 1) return 'just now';
    if (m < 60) return `${Math.round(m)}m ago`;
    if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
  };

  const ageWord = h => h == null ? 'no timestamp'
    : h < 1 ? 'under an hour old'
    : h < 24 ? `${Math.round(h)}h old`
    : `${Math.floor(h / 24)}d ${Math.round(h % 24)}h old`;

  async function paintFreshness() {
    const btn = document.getElementById('freshBtn');
    if (!btn) return;

    /* Some feeds carry no stamp at all — alerts.json is a bare array, and the
     * wire used to be one. They are written by the same build as edition.json,
     * so that is their age, marked as inherited rather than claimed. */
    const edr = await get('/edition.json');
    const edTs = edr.ok ? feedStamp(edr.data) : null;

    const rows = await Promise.all(FEED_AGE.map(async ([label, src, maxH]) => {
      /* A row may name its feed, or name a FUNCTION that picks one. The
         function is allowed to answer NOTHING, and that is the point: it
         means "only if it is already paid for". Such a row is left passive
         and filled later by the route, never fetched by this bar. */
      const url = typeof src === 'function' ? src() : src;
      if (!url) return { label, url: null, ok: false, ts: null, inherited: false,
                         maxH, h: null, passive: true };
      const r = await get(url);
      let ts = r.ok ? feedStamp(r.data) : null;
      let inherited = false;
      if (!ts && r.ok && edTs && url !== '/edition.json') { ts = edTs; inherited = true; }
      return { label, url, ok: r.ok, ts, inherited, maxH, h: ageHours(ts) };
    }));

    /* Kept, so a passive row can be filled when its feed arrives and the chip
       repainted from the SAME array the panel reads. Two copies of this state
       is how a header and the sheet behind it end up disagreeing about one
       number, which is the fault this whole bar was rewritten to remove. */
    FRESH_ROWS = rows;

    freshPaint = () => {
    const dated = rows.filter(x => x.h != null);
    if (!dated.length) { btn.hidden = true; return; }
    // Each feed against its OWN tolerance; "worst" is the one furthest past it,
    // not simply the oldest — a weekly screen at 20 hours is fine and an IPO
    // book at 20 hours is not.
    const over = x => x.h / (x.maxH || 26);
    const fresh = dated.filter(x => over(x) <= 1).length;
    const worstRow = dated.reduce((a, b) => (over(b) > over(a) ? b : a));
    const worst = worstRow.h;

    btn.hidden = false;
    btn.className = 'fresh ' + (fresh === dated.length ? 'all'
                               : fresh >= dated.length * 0.6 ? 'most' : 'few');
    document.getElementById('freshTxt').textContent =
      /* "8/8 current" was a fraction with no noun; say what the eight are. */
      fresh === dated.length ? `${fresh} of ${dated.length} feeds current` : `${ageWord(worst)}`;
    btn.setAttribute('aria-label',
      `Data freshness: oldest feed is ${ageWord(worst)}. Open the detail.`);

    btn.onclick = async () => {
      const hr = await get('/data-health.json');
      /* SCOPED THE SAME WAY THE HEADER BADGE ALREADY WAS. OUR_DATASETS was
       * written for the "n of m current" chip and never applied here, so the
       * panel behind it listed all twelve — Careers, Podcasts, Smart Reads —
       * feeds that belong to a different product and that nothing on this page
       * reads. The one row showing DEGRADED was the careers feed, which is not
       * this site's data at all: the panel was reporting someone else's
       * outage as this site's health. */
      const upstream = (hr.ok ? (hr.data.datasets || []) : [])
        .filter(d => OUR_DATASETS.some(re => re.test(String(d.dataset || ''))));
      const upstreamAge = ageHours(feedStamp(hr.ok ? hr.data : null));
      sheet('Data freshness', `
        <p class="sheet-p">Every feed <b>this page</b> loaded, and how old the copy it loaded is —
          measured against your clock, from the timestamp inside the file. Each is judged against its
          own tolerance, because they do not move at the same speed: the wire is live and allowed an
          hour, an IPO book eight, a daily build thirty. A stamp that carries a date and no time is
          marked <b>(date only)</b> and read at the most favourable hour inside that day, since
          nothing narrower is published.</p>
        <div class="board" style="margin-top:14px">
          ${rows.map(x => `<div class="board-row">
            <span class="n">${esc(x.label)}<br>
              <em style="font-style:normal;color:var(--dim);font-size:var(--t-3)">${esc(x.url || 'not fetched by this bar')}</em></span>
            <span class="p">${x.ts
              ? esc(isDateOnly(x.ts) ? String(x.ts) + ' (date only)' : String(x.ts).slice(0, 16).replace('T', ' '))
              : '—'}${x.inherited ? '<br><em style="font-style:normal;color:var(--dim);font-size:var(--t-2)">from the edition build</em>' : ''}</span>
            <span class="c ${x.h == null ? '' : x.h <= (x.maxH || 26) ? 'up' : 'dn'}">${
              /* "did not load" is a FAILURE and a passive row is not one — it
                 is a feed this page had no reason to download. Printing the
                 first for the second is the bar reporting an outage that did
                 not happen. */
              x.ok ? esc(ageWord(x.h)) : x.passive ? 'not used on this page' : 'did not load'}</span>
          </div>`).join('')}
        </div>
        ${upstream.length ? `<p class="sheet-p" style="margin-top:16px">
          <b>What the source says about itself.</b> This is the pipeline's own health report, and it
          is a different question from the ages above — it describes whether the build believes its
          jobs ran, not how old this site's copy is. Its own file is
          <b>${esc(ageWord(upstreamAge))}</b>, so read it accordingly.</p>
          <div class="board" style="margin-top:10px">
            ${upstream.slice(0, 14).map(d => `<div class="board-row">
              <span class="n">${esc(d.dataset || '')}</span>
              <span class="p">${esc(d.freshness_age || '—')}</span>
              <span class="c ${/current|fresh|ok|live/i.test(String(d.status)) ? 'up' : 'wn'}">${esc(d.status || '—')}</span>
            </div>`).join('')}
          </div>` : ''}
        <p class="sheet-p" style="margin-top:14px">
          <a href="/methodology" style="color:var(--accent)">How this is measured →</a></p>`);
    };
    };
    freshPaint();
  }

  /* ══ THE TRUST PAGES ═══════════════════════════════════════════════════
   * Methodology, Data sources, Terms, Privacy. Four pages that did not exist,
   * and the reason they now do is that this site publishes numbers about money
   * — every claim on it should be checkable, and the things it CANNOT do
   * should be as easy to find as the things it can.
   *
   * Written as prose rather than a wall of headings on purpose: a disclosure
   * nobody reads is a disclosure that failed.
   */
  const prose = (eyebrow, title, sub, body) =>
    head(title, sub, eyebrow) + `<div class="prose">${body}</div>`;


  /* ── NEWS ─────────────────────────────────────────────────────────────────
   *
   * The front page showed six of eighteen stories under a caption that said
   * eighteen. This is the rest of them, and the reason the section is worth
   * its own route rather than a longer list.
   *
   * WHAT "IMPACT" MEANS HERE, AND WHAT IT DOES NOT.
   *
   * The obvious version of this feature is a paragraph of generated
   * commentary under each headline explaining why it matters. This site does
   * not do that, for the same reason it draws closing prices instead of
   * candles: it would be inventing the part the reader cannot check.
   *
   * What it does instead is a join. Each story's text is matched against the
   * 750 screened names, and every name it mentions is shown with the move
   * that name actually made. That is a measured reaction, not an opinion
   * about one — and it answers the question a reader of a market wire is
   * really asking, which is not "what does this mean" but "does this touch
   * anything I hold".
   *
   * The matcher is deliberately conservative. It requires a whole-word hit on
   * either the ticker or a distinctive leading phrase of the company name,
   * both at least five characters, with a stoplist for the words that would
   * otherwise match half the market ("Energy", "Finance", "India"). A missed
   * link costs the reader nothing; a wrong one puts a price move under a
   * headline it has nothing to do with, which is the failure that matters.
   */
  const NEWS_STOP = new Set(['india','energy','finance','power','motors','steel','bank',
    'industries','limited','ltd','corporation','company','national','general','united',
    'first','global','capital','holdings','services','technologies','international']);

  // "Zydus Lifesciences Ltd." -> "zydus lifesciences". Legal suffixes carry no
  // identifying information and stop the phrase matching running text.
  const newsPhrase = name => String(name || '')
    .replace(/\b(ltd|limited|inc|plc|corp|corporation|company|co)\b\.?/gi, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    .split(' ').slice(0, 2).join(' ');

  /* CAPITALISATION IS THE EVIDENCE.
   *
   * The first cut of this matched lower-cased text against lower-cased names
   * and produced, out of four matches, three wrong ones: "US central bank
   * chair" was filed under Central Bank of India, and "Every bank says I need
   * her signature" under Signatureglobal. Both are the same mistake — an
   * English phrase that happens to spell a company.
   *
   * A stoplist cannot fix that; the list would have to be the dictionary. The
   * fix is to stop throwing away the evidence that was in the text all along.
   * A company is a proper noun and is capitalised: "HDFC Bank" in a headline
   * is the bank, "central bank" is not a company, and a ticker written in
   * prose is upper-case. So the search runs against the ORIGINAL casing and a
   * hit only counts if it looks like a name where it was found.
   *
   * This trades recall for precision on purpose. A story whose only mention
   * of a company is lower-cased goes unlinked, and that costs the reader
   * nothing. A price move printed under a headline it has nothing to do with
   * is the site telling the reader something false.
   */
  const reEsc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function newsMatch(story, universe) {
    const raw = `${story.title || ''} — ${story.summary || ''}`;
    const hits = [];
    for (const r of universe) {
      const sym = String(r.sym || '').trim();
      const phrase = newsPhrase(r.name);
      let hit = false;

      // A ticker in running prose is upper-case. Case-SENSITIVE on purpose:
      // this is what separates the ticker SIGNATURE from the word signature.
      if (sym.length >= 4 && new RegExp(`\\b${reEsc(sym)}\\b`).test(raw)) hit = true;

      // A company phrase must be capitalised where it appears. Found case-
      // insensitively, then checked against the original text.
      if (!hit && phrase.length >= 5 && !NEWS_STOP.has(phrase.split(' ')[0])) {
        const m = raw.match(new RegExp(`\\b${reEsc(phrase).replace(/ /g, '\\s+')}\\b`, 'i'));
        if (m && m[0].split(/\s+/).every(w => /^[A-Z0-9]/.test(w))) hit = true;
      }

      if (hit) hits.push(r);
      if (hits.length >= 4) break;   // a headline touching five names is a match bug
    }
    return hits;
  }

  let newsQ = '', newsSrc = '';
  /* ── FUNDS ────────────────────────────────────────────────────────────────
   *
   * The SIP screen that has run weekly for months and only ever appeared in
   * the newspaper's HTML. It reads docs/funds.json, the build artefact added
   * for this route, so both sites rank the same NAVs from the same run.
   *
   * WHAT THIS PAGE REFUSES TO DO. It does not rank funds against each other
   * across categories. A small-cap fund returning 22% and a large-cap
   * returning 14% are not first and second in one list — they are two
   * different risks, and a single leaderboard implies a comparison the data
   * does not support. So categories are the unit, and every table says which
   * one it is.
   *
   * It also does not claim to know cost. Per-scheme TER is not in the free
   * AMFI feed; Direct-vs-Regular is the one cost lever the data shows, the
   * screen is Direct-only by construction, and the page says so rather than
   * implying it screened on expense.
   */
  const fundRow = (f, i) => {
    // Registered on render, keyed by code, so the delegated click below can
    // find the whole record without re-fetching or re-searching the feed.
    if (f && f.code != null) window.__FUNDS[String(f.code)] = f;
    const r5 = Number(f.r5), r3 = Number(f.r3), r1 = Number(f.r1);
    const vol = Number(f.volatility), dd = Number(f.dd3);
    return `<div class="rank-r fnd" data-fund="${esc(String(f.code ?? ''))}" role="button" tabindex="0">
      <span class="i">${i + 1}</span>
      <span class="s"><b>${esc(f.name || '—')}</b>
        <span>${esc(f.category || '')}${f.nav != null ? ` · NAV ${price(f.nav)}` : ''}</span></span>
      ${/* data-l on every cell. On a phone .rank-r stacks and each metric
          * labels itself from this attribute — the mechanism every other
          * table on the site uses. Without it these rendered as three bare
          * numbers under a header that is hidden at that width: "17.15%",
          * "-23.7%", "18.6", with nothing saying which was which. */''}
      <span class="x ${dir(r3)} ${heatCell(r3, 25)}" data-l="3-year"><b>${Number.isFinite(r3) ? r3.toFixed(2) + '%' : '—'}</b></span>
      <span class="x ${dir(r5)} ${heatCell(r5, 25)}" data-l="5-year">${Number.isFinite(r5) ? r5.toFixed(2) + '%' : '—'}</span>
      <span class="x ${dir(r1)} ${heatCell(r1, 40)}" data-l="1-year">${Number.isFinite(r1) ? r1.toFixed(1) + '%' : '—'}</span>
      <!-- A DEEPER FALL AND A HIGHER VOLATILITY ARE WORSE, so the heat is
           inverted: these two are the only columns where a bigger number is
           the bad one, and shading them on the same scale as the returns would
           have painted the riskiest funds green. -->
      <span class="x ${heatCell(-Math.abs(dd), 30)}" data-l="Worst fall" title="Worst peak-to-trough fall over three years">${
        Number.isFinite(dd) ? dd.toFixed(1) + '%' : '—'}</span>
      <span class="x ${heatCell(-Math.abs(vol - 14), 12)}" data-l="Volatility" title="Annualised volatility, three years — shaded against a 14% typical equity fund">${
        Number.isFinite(vol) ? vol.toFixed(1) : '—'}</span>
    </div>`;
  };

  /* ── ONE FUND, IN FULL ────────────────────────────────────────────────────
   *
   * The table ranks; this answers "what am I actually looking at". Opened by
   * clicking a row, which is the same gesture every other table on this site
   * already uses for detail.
   *
   * The SIP block is the headline because it is the number people came for,
   * and it is shown as invested-against-value rather than a single figure: a
   * ₹22 lakh corpus means nothing until you can see the ₹12 lakh that went in.
   * It is computed from the fund's own NAV series, buying units on each
   * monthly anniversary at the NAV that actually printed — not from a CAGR
   * projection, which is the same number twice and hides when the money went
   * in.
   *
   * Drawdown sits beside the returns rather than under them. A fund that
   * returned 18% through a 40% fall is a different proposition from one that
   * returned 16% through a 20% fall, and only one of those is a number people
   * survive holding.
   */
  window.__FUNDS = {};
  function openFund(code) {
    const f = window.__FUNDS[String(code)];
    if (!f) return;
    const n = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    const r1 = n(f.r1), r3 = n(f.r3), r5 = n(f.r5), dd = n(f.dd3), vol = n(f.volatility);
    const sip = f.sip10 && n(f.sip10.value) ? f.sip10 : null;
    const bar = (v, scale) => {
      const x = n(v);
      if (x == null) return '<span class="fd-b"><i style="width:0"></i></span>';
      const w = Math.max(2, Math.min(100, Math.abs(x) / scale * 100));
      return `<span class="fd-b"><i class="${x < 0 ? 'dn' : 'up'}" style="width:${w.toFixed(0)}%"></i></span>`;
    };
    /* `txt` marks a value that is a NAME, not a measurement — it drops the mono
     * tabular figures the numbers need and takes the width a name needs. */
    const row = (k, v, sub, b, txt) => `<div class="fd-r"><span class="fd-k">${esc(k)}</span>
      <span class="fd-v${txt ? ' txt' : ''}">${v}</span>${b || ''}${
        sub ? `<span class="fd-s">${sub}</span>` : ''}</div>`;

    sheet(f.name || 'Fund', `
      <p class="hint" style="margin:0 0 14px">${esc(f.category || '')}${
        f.house ? ` · ${esc(f.house)}` : ''}${
        f.nav != null ? ` · NAV ${price(f.nav)}${f.nav_date ? ` on ${esc(String(f.nav_date).slice(0, 10))}` : ''}` : ''}</p>

      ${sip ? sec('A ₹10,000 monthly SIP, ten years', `
        <div class="fd-sip">
          <div><span class="fd-k">You would have put in</span><b>${money(sip.invested)}</b>
            <span class="fd-s">${sip.months} instalments</span></div>
          <div><span class="fd-k">It would be worth</span><b class="up">${money(sip.value)}</b>
            <span class="fd-s">${(sip.value / sip.invested).toFixed(2)}× the money in</span></div>
        </div>
        <p class="hint">Units bought at the NAV that actually printed on each monthly
          anniversary, valued at the latest NAV. Not a projection from a CAGR — that would
          be the return restated, and would hide the fact that a SIP's result depends on
          <b>when</b> each instalment bought.</p>`) : ''}

      ${sec('The fund itself', `
        ${row('Age', f.history_years != null ? `<b>${Number(f.history_years).toFixed(1)} yrs</b>` : '—',
              f.inception ? `first NAV ${esc(String(f.inception).slice(0, 10))}` : '')}
        ${row('Since inception', f.since_inception != null
              ? `<b class="${dir(f.since_inception)}">${Number(f.since_inception).toFixed(2)}%</b>` : '—',
              'annualised over its whole life')}
        ${row('Fund house', f.house ? `<b>${esc(f.house)}</b>` : '—', '', '', true)}
        ${row('AMFI category', f.category ? `<b>${esc(f.category)}</b>` : '—',
              'ranked only against this', '', true)}
        ${row('Plan', '<b>Direct · Growth</b>',
              'the screen holds no Regular or IDCW plan', '', true)}
        <p class="hint">${f.history_years != null && Number(f.history_years) < 5
          ? `<b>This fund is ${Number(f.history_years).toFixed(1)} years old.</b> A three-year number on it
             covers a period this fund has only just lived through, and any window longer than its
             age is blank above rather than shortened.`
          : `Age matters because it bounds every return beside it — a fund cannot show you a
             drawdown it was not alive for.`}</p>`)}

      ${(() => {
        /* THE MOST USEFUL NUMBER ON THE SHEET, COMPUTED SINCE LAUNCH AND NEVER
         * PUBLISHED. rolling3y and percentile_r3 are in every funds.json build
         * and appeared nowhere in this file.
         *
         * A trailing 3-year CAGR is ONE window — the one ending today — and it
         * silently rewards whoever got lucky with an end date. The rolling
         * figures answer the question people actually have: if I had started
         * at any month, what would three years have paid? Worst, median and
         * best across every window is the honest form, and the SPREAD between
         * them is the risk that a single CAGR hides completely.
         *
         * A range with a central marker, not a chart: the data's job is one
         * magnitude and its dispersion. `above_7pct` is a proportion and gets
         * a sentence, not a plot. */
        const R = f.rolling3y;
        if (!R || R.windows == null) return '';
        const w = n(R.worst), m = n(R.median), b = n(R.best);
        if (w == null || b == null) return '';
        const lo = Math.min(0, w), hi = Math.max(b, 0);
        const span = (hi - lo) || 1;
        const pos = v => ((v - lo) / span * 100);
        const zero = lo < 0 ? pos(0) : null;
        const pct = n(R.above_7pct), rank = n(f.percentile_r3);
        return sec('Whenever you had started', `
          <div class="fd-band" role="img"
               aria-label="Rolling three-year returns: worst ${w}%, median ${m ?? '-'}%, best ${b}%, across ${R.windows} windows">
            <div class="fd-band-tr">
              ${zero != null ? `<i class="fd-band-zero" style="left:${zero.toFixed(1)}%"></i>` : ''}
              <i class="fd-band-fill ${w < 0 ? 'neg' : ''}"
                 style="left:${pos(w).toFixed(1)}%;width:${(pos(b) - pos(w)).toFixed(1)}%"
                 title="Every 3-year window landed between ${w}% and ${b}%"></i>
              ${m != null ? `<i class="fd-band-med" style="left:${pos(m).toFixed(1)}%"
                 title="Median 3-year window: ${m}%"></i>` : ''}
            </div>
            <div class="fd-band-lb">
              <span class="${w < 0 ? 'dn' : ''}"><b>${w.toFixed(1)}%</b><i>worst</i></span>
              ${m != null ? `<span class="mid"><b>${m.toFixed(1)}%</b><i>median</i></span>` : ''}
              <span><b>${b.toFixed(1)}%</b><i>best</i></span>
            </div>
          </div>
          <p class="hint">Annualised, across ${R.windows} overlapping three-year windows since
            launch${pct != null ? `. <b>${pct}%</b> of them beat 7% a year — roughly what a fixed
            deposit pays, and the bar a fund has to clear to be worth the volatility` : ''}${
            rank != null ? `. Its trailing 3-year return ranks <b>${rank}</b> of 100 in this
            category` : ''}.
            The headline 3-year figure is just the window ending today; the spread above is what a
            single CAGR hides.</p>`);
      })()}

      ${(() => {
        const cal = Array.isArray(f.calendar) ? f.calendar.filter(x => x && x.ret != null) : [];
        if (!cal.length) return '';
        const mx = Math.max(...cal.map(x => Math.abs(Number(x.ret) || 0)), 1);
        /* YEAR BY YEAR, NOT ANOTHER AVERAGE.
         * A CAGR is one number standing in for a decade, and it hides the
         * shape completely: 18% a year and 45%/−20%/30%/−15% can be the same
         * figure. The bars are the answer to "would I have held this", which
         * the annualised number cannot give. Already computed by the screen
         * and never published until now. */
        return sec('Year by year', `<div class="fd-cal">${cal.map(x => {
          const v = Number(x.ret);
          return `<div class="fd-cy">
            <span class="fd-cl">${esc(x.year)}</span>
            <span class="fd-cb"><i class="${v < 0 ? 'dn' : 'up'}"
              style="width:${(Math.abs(v) / mx * 100).toFixed(0)}%"></i></span>
            <span class="fd-cv ${dir(v)}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>
          </div>`; }).join('')}</div>
          <p class="hint">Calendar years, computed from the NAV series. An annualised return is
            one number standing in for all of these, and two funds with the same CAGR can have
            got there in ways nobody would have sat through equally.</p>`);
      })()}

      ${(() => {
        const p = f.portfolio;
        if (!p || !(p.top_stocks || []).length) return '';
        /* WHAT IT OWNS, NOT HOW IT DID.
         * Two flexi-caps with the same 3Y CAGR can be a banks-and-IT book and a
         * smallcap-industrials one. The return columns cannot tell them apart;
         * this can, and it is the only part of the sheet that answers "does
         * adding this diversify anything I already hold". */
        const mxS = Math.max(...p.top_sectors.map(x => x.pct), 1);
        const mxH = Math.max(...p.top_stocks.map(x => x.pct), 1);
        const wt = (v, mx) => `<span class="fd-b"><i class="up" style="width:${(v / mx * 100).toFixed(0)}%"></i></span>`;
        return sec('What it owns', `
          <div class="fd-own">
            <div>
              <h4 class="fd-oh">Top 3 sectors</h4>
              ${p.top_sectors.map(x => `<div class="fd-or">
                <span class="fd-on">${esc(x.name)}</span>${wt(x.pct, mxS)}
                <span class="fd-op">${x.pct.toFixed(2)}%</span></div>`).join('')}
              <p class="hint" style="margin-top:9px">Summed from the individual holdings, not read
                off the fund house's sector chart — a weight that cannot be reconciled against the
                rows beside it will eventually disagree with them.</p>
            </div>
            <div>
              <h4 class="fd-oh">Top 10 holdings</h4>
              ${p.top_stocks.map((x, i) => `<div class="fd-or">
                <span class="fd-oi">${i + 1}</span>
                <span class="fd-on">${esc(x.name)}</span>${wt(x.pct, mxH)}
                <span class="fd-op">${x.pct.toFixed(2)}%</span></div>`).join('')}
            </div>
          </div>
          <div class="fd-ometa">
            ${p.holdings_count != null ? `<span><b>${p.holdings_count}</b> holdings in all</span>` : ''}
            ${p.equity_pct != null ? `<span><b>${p.equity_pct.toFixed(1)}%</b> of the fund is in
              these shares${p.equity_pct < 90 ? ' — the rest is cash, debt or overseas units' : ''}</span>` : ''}
            ${p.as_on ? `<span>Portfolio as on <b>${esc(p.as_on)}</b></span>` : ''}
          </div>
          <p class="hint">Holdings are disclosed monthly, so this is the latest published portfolio
            and not today's. The percentages are of the whole fund, not of the equity sleeve.</p>`);
      })()}

      ${sec('What this screen cannot tell you', `
        ${row('Expense ratio', '<b class="fd-u">Not published here</b>',
              'each AMC releases per-scheme TER as a monthly PDF; it is not in the AMFI feed')}
        ${row('AUM', '<b class="fd-u">Not published here</b>',
              'AMFI publishes it monthly in a separate file this screen does not read')}
        ${row('Exit load', '<b class="fd-u">Not published here</b>',
              'in the scheme document — typically 1% inside a year on equity funds')}
        ${f.portfolio && (f.portfolio.top_stocks || []).length ? '' :
          row('Top holdings and sectors', '<b class="fd-u">Not published here</b>',
              'no published portfolio table resolved for this scheme')}
        ${f.url ? row('Factsheet', `<a href="${esc(f.url)}" target="_blank" rel="noopener">AMFI page →</a>`,
              'where the missing figures are published') : ''}
        <p class="hint">These are listed rather than omitted because a gap you can see is worth
          more than one you cannot. This screen reads AMFI's daily NAV file and nothing else, so
          everything above is a real limit of the source — not a shortcut. Where a number is
          missing, the scheme document and the AMC's monthly factsheet carry it.
          <b>Direct-vs-Regular is the one cost lever the NAV data does show</b>, and the screen is
          Direct-only by construction, which is the low-cost half of the universe.</p>`)}

      <p class="hint"><b>Direct plan, Growth option.</b> Per-scheme expense ratio is not in
        the free AMFI feed, so this screen does not claim to know it. Ranked only against
        its own category. Past returns, not a recommendation and not a forecast.</p>`);
  }

  R['/funds'] = async () => {
    const head0 = head('Funds',
      'A SIP screen over AMFI\'s official NAV file. Direct plans only, ranked inside each category.',
      'Fund screen');
    paint(head0 + sec('Loading', `<div class="sk" style="height:280px"></div>`));
    const fr = await get('/funds.json');
    if (fr.ok && fr.data) noteFresh('Fund screen', feedStamp(fr.data));
    if (!fr.ok || !fr.data || !fr.data.ok) {
      paint(head0 + fail('The fund screen', (fr.data && fr.data.error) || fr.error
        || 'the weekly screen has not published yet'));
      return;
    }
    const d = fr.data;
    const cats = (d.categories || []).filter(c => (c.funds || []).length);
    const allN = cats.reduce((n, c) => n + c.funds.length, 0);
    let out = head0 + snap([
      ['Categories', cats.length, 'ranked separately'],
      ['Funds screened', allN, 'Direct + Growth only', 'ac'],
      ['Best 5-year', (() => {
        const b = cats.flatMap(c => c.funds).map(f => Number(f.r5))
          .filter(Number.isFinite).sort((a, b2) => b2 - a);
        return b.length ? b[0].toFixed(1) + '%' : null;
      })(), 'annualised', 'up'],
      ['Screen run', d.generated_at ? String(d.generated_at).slice(0, 10) : null, 'weekly'],
    ], 'Ranked on the 3-year return — the arrow marks the column. Three years is the longest '
     + 'window most of this shelf actually has, and a 5-year sort would silently drop every '
     + 'fund younger than that rather than rank it. Every figure is computed from the NAV '
     + 'series AMFI publishes, not taken from a fund house page.')
     + heatKey(25, 'Returns');

    /* ── THE SHELF IN ONE TABLE, WHICH THIS PAGE NEVER HAD ─────────────────
     *
     * Twenty categories were rendered as twenty open tables, one under the
     * next, 11,844px on a phone. Every one of them answers "which fund inside
     * this category" and NOTHING on the page answered the question a reader
     * actually arrives with, which is which category to be in at all. To
     * compare Small Cap's drawdown against Balanced Advantage's you had to
     * scroll four screens and remember a number.
     *
     * WHAT THIS DELIBERATELY IS NOT: a single ranked list of all sixty funds.
     * That is the obvious build and it would be dishonest — a Gold fund and a
     * Small Cap fund do not compete for the same money, and sorting them
     * against each other on three-year return would put the riskiest thing on
     * the shelf at the top with nothing beside it saying so. The feed's own
     * basis says "ranked inside each category" for exactly that reason.
     *
     * One row per CATEGORY instead: its leader, and the risk columns next to
     * the return columns so the comparison a reader has to make anyway is on
     * one screen instead of in their head. Published order is kept because it
     * is itself a structure — broad equity, then size, then tax, then index,
     * then hybrid, then sector, then asset — and re-sorting it by return
     * would bury that. */
    const leaderRow = (c, i) => {
      const best = c.funds[0] || {};
      const r3 = Number(best.r3), r5 = Number(best.r5);
      const dd = Number(best.dd3), vol = Number(best.volatility);
      return `<div class="rank-r fld" data-fund="${esc(String(best.code ?? ''))}" role="button" tabindex="0">
        <span class="i">${i + 1}</span>
        <span class="s"><b>${esc(c.label || c.key)}</b>
          <span>${esc(best.name || '—')}</span></span>
        <span class="x ${dir(r3)} ${heatCell(r3, 25)}" data-l="3-year"><b>${Number.isFinite(r3) ? r3.toFixed(1) + '%' : '—'}</b></span>
        <span class="x ${dir(r5)} ${heatCell(r5, 25)}" data-l="5-year">${Number.isFinite(r5) ? r5.toFixed(1) + '%' : '—'}</span>
        <span class="x ${heatCell(-Math.abs(dd), 30)}" data-l="Worst fall" title="Worst peak-to-trough fall over three years">${
          Number.isFinite(dd) ? dd.toFixed(1) + '%' : '—'}</span>
        <span class="x ${heatCell(-Math.abs(vol - 14), 12)}" data-l="Volatility" title="Annualised volatility over three years">${
          Number.isFinite(vol) ? vol.toFixed(1) : '—'}</span>
        <span class="m" data-l="Funds" style="color:var(--dim)">${c.funds.length}</span>
      </div>`;
    };
    out += sec('The shelf, one row per category', `<div class="rank">
        <div class="rank-r rank-head fld">
          <span class="i">#</span><span class="s">Category · its leader</span>
          <span class="x">3-year</span><span class="x">5-year</span>
          <span class="x">Worst fall</span><span class="x">Volatility</span><span class="m">Funds</span>
        </div>
        ${cats.map(leaderRow).join('')}
      </div>
      <p class="hint"><b>Read the two right-hand columns with the two on the left.</b> A category
        whose leader returned more almost always fell further doing it — that is the trade being
        made, not a flaw in the fund. Categories are <b>not</b> ranked against each other here,
        because a gold fund and a small-cap fund are not competing for the same money; the order is
        the shelf's own, broad equity through to single assets. Tap any row for that fund's card.</p>`,
      `${cats.length} categories · ${allN} funds`,
      /* The lead described "the twenty tables below", which is what was below
       * it before this edit and is not what is there now. A sentence that
       * describes the previous layout is the same fault as a hardcoded count
       * beside a live one. */
      'Which shelf to be on, before which fund on it — the comparison the per-category tables cannot make one at a time.');

    /* ONE SECTION HOLDING TWENTY FOLDS, NOT TWENTY SECTIONS.
     *
     * Each category had a section of its own: a rail, a count, and a serif
     * standfirst, twenty times, ahead of three rows. Folding the rows still
     * left twenty headings and twenty standfirsts — about 4,000px of chrome
     * on a phone for sixty rows of data.
     *
     * The categories are all one thing, so they are one section. Every blurb
     * survives, on the fold it belongs to, where it reads as the answer to
     * "what is this category" at the moment somebody opens it. The leaders'
     * board above already names all twenty, so nothing is lost by not
     * repeating them as headings. */
    out += sec('Every fund, by category', cats.map(c => {
      const best = Number((c.funds[0] || {}).r3);
      return `<details class="foldb fcat">
        <summary><b>${esc(c.label || c.key)}</b>
          <i>${c.funds.length} fund${c.funds.length === 1 ? '' : 's'}${
            Number.isFinite(best) ? ` · best 3-year ${best.toFixed(1)}%` : ''}</i></summary>
        ${c.blurb ? `<p class="hint fcat-b">${esc(c.blurb)}</p>` : ''}
        <div class="rank">
          <div class="rank-r rank-head fnd" aria-hidden="false">
            <span class="i">#</span><span class="s">Scheme</span>
            <span class="x">3-year ↓</span><span class="x">5-year</span><span class="x">1-year</span>
            <span class="x">Worst fall</span><span class="x">Volatility</span>
          </div>
          ${c.funds.map(fundRow).join('')}
        </div>
      </details>`;
    }).join(''), `${cats.length} categories · ${allN} funds`,
      'The full shelf. Each opens to its ranked funds and what the category is for.');

    out += sec('What this screen knows, and what it does not', `
      <p class="sec-note"><b>Direct plans only, and that is the cost lever.</b> Per-scheme expense
        ratio is not published in the free AMFI feed — each AMC releases it as a monthly PDF — so
        this screen does not claim to know it. What the data does show is Direct against Regular,
        where the same scheme, same portfolio and same manager costs typically 0.5–1.2% a year more
        in the Regular plan because the distributor commission sits inside its TER. Screening
        Direct-only takes the low-cost half of the universe by construction.</p>
      <p class="sec-note"><b>Growth, not IDCW.</b> IDCW payouts are taxed at slab rate, which makes
        a like-for-like return comparison impossible.</p>
      <p class="sec-note"><b>Past returns, ranked.</b> Nothing here is a recommendation and none of
        it forecasts anything. A category leader over five years is a fact about five years that
        have already happened.</p>
      <p class="hint">${esc(d.basis || '')}</p>`);
    paint(out);
  };

  R['/news'] = async () => {
    const [n, sc, pu, ed, lw] = await Promise.all(
      [get('/news.json'), getScreen(false).then(g => g.r), get('/pulse.json'), get('/edition.json'),
       get('/api/wire')]);
    /* The wire and the daily edition age at different rates and the page
       carries both, which is the case the per-feed bar exists for. */
    if (ed.ok && ed.data) noteFresh('Edition', feedStamp(ed.data));
    if (lw.ok && lw.data) noteFresh('Wire', lw.data.at || feedStamp(lw.data));
    const live = lw.ok && lw.data && lw.data.ok ? lw.data : null;
    /* Same reasoning as the front page: the wire carries no timestamp of its
     * own, so it borrows the build stamp of the edition it was written with. */
    const wireStamp = ed.ok ? feedStamp(ed.data) : null;
    const wireH = ageHours(wireStamp);
    if (!n.ok) { paint(head('The wire', '', 'Every story') + fail('The wire', n.error)); return; }
    const all = dedupeWire(live ? live.stories : (Array.isArray(n.data) ? n.data : []));
    const universe = sc.ok ? (sc.data.rows || sc.data.data || []) : [];
    // Median sector move today, so a matched story can say what its sector did
    // rather than only which company it named.
    const secMove = new Map();
    for (const x of (pu.ok ? (pu.data.sectors_day || pu.data.sectors || []) : []))
      if (x && x.sector) secMove.set(x.sector, x.r1d ?? x.r1w ?? null);

    const draw = () => {
      const q = newsQ.trim().toLowerCase();
      const rows = all.filter(x =>
        (!newsSrc || (x.source || '') === newsSrc) &&
        (!q || `${x.title} ${x.summary} ${x.source}`.toLowerCase().includes(q)));
      const sources = [...new Set(all.map(x => x.source).filter(Boolean))].sort();
      const linked = all.filter(x => universe.length && newsMatch(x, universe).length).length;

      /* THE STORIES THAT TOUCH THE SCREEN COME FIRST.
       *
       * The tile above this list says "1 of 18 name a screened company" — and
       * that one story sat eleventh, in feed order, ten headlines about US
       * rents and Polish equities ahead of the only item on the page that
       * names something this site tracks. The page already computes the
       * match; it just was not allowed to decide anything.
       *
       * MORE names touched sorts higher, because that is measured. Nothing
       * beyond that: within each group the wire's own order is kept, because
       * grading a story's importance is precisely what the standfirst above
       * says this feed carries no data to support — and inventing a ranking
       * here would contradict it on the same screen. */
      const touches = new Map(rows.map(x =>
        [x, universe.length ? newsMatch(x, universe).length : 0]));
      rows.sort((a, b) => (touches.get(b) || 0) - (touches.get(a) || 0));

      const body = rows.length ? `<div class="nwg">${rows.map(x => {
        const hits = universe.length ? newsMatch(x, universe) : [];
        /* THE BADGE STATES A MEASURED FACT, NOT A GRADE.
         *
         * The obvious thing to copy here is a LOW / MEDIUM / HIGH IMPACT
         * chip. This feed carries a headline, a summary, a source and a link
         * — no timestamp, no clustering, no analysis — so an impact grade
         * would be a number I made up, printed in the typeface the rest of
         * this site reserves for measured things. What CAN be established is
         * whether a story names a company in the NSE screen, and what
         * that company and its sector actually did. That is the badge. */
        const secs = [...new Set(hits.map(h => h.sector).filter(Boolean))];
        const secs0 = secs;
        const mv = secs.length === 1 ? secMove.get(secs[0]) : null;
        return `<article class="nwc">
          <div class="nwc-h">
            <span class="nwc-s">${esc(x.source || 'wire')}${
              x._also && x._also.length
                ? ` <i class="w-also" title="${esc(x._also.join(', '))}">+${x._also.length} more</i>` : ''}${
              x.at ? ` · ${esc(storyAge(x.at))}` : ''}</span>
            ${/* A story that names no screened company gets no badge at all.
                * "No screened company named" was a label announcing an absence
                * on two thirds of the wire — noise that told the reader
                * nothing they could use. Where there IS a link, the badge says
                * the sector it lands in, which is the useful half. */''}
            ${hits.length ? `<span class="nwc-b is-on">${
              secs0.length === 1 ? esc(secs0[0]) : `${hits.length} sectors`
            }</span>` : ''}
          </div>
          <h3 class="nwc-t">${x.link
            ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title || '')}</a>`
            : esc(x.title || '')}</h3>
          ${x.summary ? `<p class="nwc-d">${esc(x.summary)}</p>` : ''}
          ${hits.length ? `<div class="nwc-w">
            <span class="nwc-wl">What it touches</span>
            <div class="nwc-cs">${hits.map(r => `<a class="nw-c ${dir(r.r1d)}" href="/screen"
                 title="${esc(r.name || '')} — ${esc(r.sector || '')}">
               <b>${esc(r.sym)}</b><i>${pct(r.r1d)}</i></a>`).join('')}</div>
            ${secs.length ? `<p class="nwc-sec">${esc(secs.join(' · '))}${
              mv != null ? ` — the sector's median move today is <b class="${dir(mv)}">${pct(mv)}</b>` : ''
            }.</p>` : ''}
          </div>` : ''}
        </article>`;
      }).join('')}</div>`
        : `<div class="empty">No story matches that.</div>`;

      paint(head('The wire', 'Every story on the tape today, and the screened names each one mentions.', 'The full file') +
        /* The page opened on a filter box. How many stories there are, how
         * many wires filed them, how many were merged as the same story and
         * how many touch a screened name are the four things worth knowing
         * before deciding whether to read any of them. */
        snap([
          ['Stories', all.length, rows.length !== all.length ? `${rows.length} shown` : 'after merging'],
          ['Wires', sources.length, 'filed today'],
          [
            'Merged', all.filter(x => x._also && x._also.length).length || '0',
            'same story, two desks', 'ac'],
          ['Touch the screen', linked, `of ${all.length} name a screened company`, linked ? 'up' : ''],
        ]) +
        sec('Filter', `<div class="tools">
            <input type="search" id="nwq" class="scr-in" value="${esc(newsQ)}"
                   placeholder="Search headlines, summaries or sources" aria-label="Search the wire">
          </div>
          <div class="chips" role="group" aria-label="Source">
            <button type="button" class="chip" data-s="" aria-pressed="${!newsSrc}">All sources</button>
            ${sources.map(sv => `<button type="button" class="chip"
               data-s="${esc(sv)}" aria-pressed="${newsSrc === sv}">${esc(sv)}</button>`).join('')}
          </div>`, `${rows.length} of ${all.length}`) +
        sec('Stories', body,
          `${linked} market-linked${live
            ? ` · live from ${live.sources} wires`
            : (wireH != null ? ` · daily file, ${ageWord(wireH)}` : '')}`,
          'A story is linked to a company only when it names it as a proper noun. Everything under a headline here is measured — which names it mentions, and what those names did. Nothing on this page grades a story’s importance, because this feed carries no data that would support it.') +
        /* ── THIS SECTION DENIED THREE THINGS THE PAGE DOES ─────────────────
         *
         * It read: "There is no timestamp, no story clustering and no analysis
         * in it, so this page cannot show time since publication, '+N more
         * sources', an impact grade, or a written why it matters."
         *
         * Three of those four are on the screen directly above it:
         *   · storyAge(x.at) prints the age on every story the LIVE wire
         *     carries — /api/wire stamps each one;
         *   · dedupeWire() is TF-IDF clustering with an exact body-match pass
         *     in front of it, and the "+N more" byline is its output;
         *   · the Merged tile counts the clusters it found.
         *
         * The text was written for the MIRRORED daily file, which carries only
         * link, source, summary and title — and it is still true of that file's
         * timestamps and nothing else. Printed unconditionally, it described
         * the worse of two feeds while the better one was on screen.
         *
         * Which matters more than a stale sentence, because the fourth item is
         * not a limitation at all — it is this site's central refusal. A reader
         * who notices that three of the four claims are false has no reason to
         * read the fourth as a principle rather than another excuse. So the
         * refusal is stated on its own, and the data limitation is stated
         * separately and only when it applies. */
        sec('What this page will not do', `<p class="hint" style="margin-top:0">
          <b>No impact grade, and no written “why it matters”.</b> This is a choice, not a
          missing feed. Ranking a headline's importance, or writing a sentence about what it
          means, would put an invented judgement in the typeface this site reserves for measured
          things — the same rule that keeps a probability off every other page here. What the
          page does instead is measured all the way down: which screened names a story mentions
          as proper nouns, and what those names and their sectors actually did today.</p>
          ${live ? `<p class="hint">Everything else the wire supports is on: each story carries
          its age, and stories the clustering finds to be the same event are merged with the
          other desks named on the byline.</p>`
          : `<p class="hint"><b>No time since publication on this file.</b> The live wire stamps
          every story; this page is currently serving the mirrored daily file, which carries a
          headline, a summary, a source and a link and no timestamp. Clustering still runs — it
          reads the headline and the summary — so the merge count and the “+N more” bylines
          above are real.</p>`}
          <p class="hint">news.askakshay.com carries a written brief on each story because it is
          generated during that site's daily build and written into its pages. It is not
          published as a feed, so there is nothing here to mirror.</p>`));

      const qi = document.getElementById('nwq');
      if (qi) {
        qi.addEventListener('input', () => {
          newsQ = qi.value;
          const at = qi.selectionStart;
          draw();
          const again = document.getElementById('nwq');
          if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (e) { /* not text */ } }
        });
      }
      document.querySelectorAll('.chip[data-s]').forEach(b =>
        b.addEventListener('click', () => { newsSrc = b.dataset.s; draw(); }));
    };
    draw();
  };

  /* ── THE FLOOR ────────────────────────────────────────────────────────────
   *
   * One screen that answers the question this site could not previously answer
   * at all: what is each engine, what makes it fire, and what has it actually
   * done. It replaces reading a roster paragraph and then hunting the ledger
   * for that engine's rows.
   *
   * The layout is a core surrounded by its engines. On a phone that is a
   * single column with the core on top, because eight nodes arranged in a ring
   * on a 375px screen is a diagram nobody can read. On a wider screen the same
   * cards flow into a grid around the core. No absolute positioning and no
   * connector geometry to break — the arrangement is a grid, so it cannot
   * overlap itself at a width nobody tested.
   *
   * MOTION IS CSS, NEVER requestAnimationFrame. rAF does not run in a hidden
   * tab, so an rAF-driven pulse would freeze on whatever frame it stopped on
   * and the floor would look dead to anyone returning to the tab. A CSS
   * keyframe animation resumes correctly and honours prefers-reduced-motion
   * for free.
   *
   * NOTHING HERE IS DECORATIVE. A dot pulses only where an engine has open
   * positions; the bar under each card is its real win rate; a card with too
   * small a sample says so instead of showing a number. */
  /* (V1 handler removed at the Signal V2 cutover; see the V2 block below.) */

  /* ── /stock/:sym — THE DEEP LINK ──────────────────────────────────────────
   *
   * Every company card on this site was a bottom sheet: it had no URL, so it
   * could not be shared, bookmarked, opened in a new tab, or returned to with
   * the back button. Under hash routing there was nowhere to put one.
   *
   * The sheet stays — it is the right shape for "glance at this while I keep
   * my place in a 750-row table". This route is the other half: the same card
   * as a page you can send someone. Both render from ONE function, so they
   * cannot drift; the sheet is the page in a drawer.
   *
   * ORDER IS THE ARGUMENT. Signal first, then why, then evidence, then the
   * detail — a reader deciding whether to spend more time on a name should not
   * have to read a balance sheet to find out the engine has no position. */
  R['/stock/:id'] = async () => {
    const sym = bareSym(routeParam());
    if (!sym) { go('/screen', { replace: true }); return; }
    paint(head(sym, 'Loading the card…', 'Company') + skel('sk-card', 3), true);

    /* `|| SCREEN_LITE` — a cache filled by a light route is missing the
     * per-company prose this surface exists to show, so it is re-fetched over
     * the top rather than rendered with the sections silently empty. */
    if (!SCREEN || SCREEN_LITE) {
      const r0 = noteLadder(await get(FULL_URL));
      if (r0.ok) setScreen((r0.data.rows || []).filter(x => x && x.sym), false);
    }
    await Promise.all([loadInsti(), v2Load().catch(() => null)]);
    const r = (SCREEN || []).find(x => x.sym === sym);
    if (!r) {
      paint(head(esc(sym), '', 'Company') + `<div class="empty">
        <b>${esc(sym)}</b> is not in the NSE screen, so there is no card for it.
        It may be an index, a commodity, or a name outside the screened universe.
        <p style="margin-top:12px"><a href="/screen">Browse the screen →</a></p></div>`);
      return;
    }
    /* The page's own head — ALL of it, not just the title.
     * The first version set title, description and canonical and left og:* on
     * the homepage's copy, so a company link pasted into a chat unfurled as
     * "Signal — Indian markets, every morning". The social card is the half of
     * the metadata anyone actually sees. */
    const title = `${sym} — ${r.name || 'Company'} · Signal`;
    const desc = `${r.name || sym}: price against its own year, trend, quality and value scores, `
               + `and FII/DII holding quarter on quarter from the company's own filings.`;
    const url = ORIGIN + '/stock/' + encodeURIComponent(sym);
    document.title = title;
    const set = (sel, attr, val) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute(attr, val);
    };
    set('meta[name="description"]', 'content', desc);
    set('link[rel="canonical"]', 'href', url);
    set('meta[property="og:title"]', 'content', title);
    set('meta[property="og:description"]', 'content', desc);
    set('meta[property="og:url"]', 'content', url);
    set('meta[name="twitter:title"]', 'content', title);
    set('meta[name="twitter:description"]', 'content', desc);

    /* SEASONALITY IS AWAITED, NOT FIRED AND FORGOTTEN. Three of the four
       sections on this page read SEAS, and a null SEAS renders "not enough
       history" for a name that has eleven years of it — a wrong answer that
       looks exactly like a right one. It is one 512 KB fetch, memoised for
       the session, and it only happens on this route. */
    await seasonality();

    /* THE LIVE MARK, FETCHED FOR THIS ONE NAME. One request, the same route
       the ledger and the heatmap quote from, so the three surfaces cannot
       report different prices for the same stock in the same minute — which
       is exactly what they were doing. A failure here costs the mark and
       nothing else; the page still renders from the screen. */
    let q = null;
    try {
      const qr = await get('/api/signals?px=' + encodeURIComponent(sym));
      q = (qr.ok && qr.data && qr.data.quotes && qr.data.quotes[sym]) || null;
    } catch (e) { /* the page must not fail over a decoration */ }

    paint(stockPage(r, q));
    wireStockPage(r);
  };

  /* ── SIGNAL RADAR ─────────────────────────────────────────────────────────
   *
   * One screen for "what is the market doing, and which names are carrying it".
   *
   * THE SCORE IS A MODEL AND SAYS SO. There was no 0–100 per-stock composite in
   * this data; it is built here from four things the screen already measures,
   * and every component is printed beside the total. The alternative — a bare
   * number — is the thing this site exists not to do.
   *
   * IT DOES NOT INVENT A SECOND VOCABULARY. A radar with STRONG_BUY / BUY /
   * ACCUMULATING / WEAKENING labels would be a second taxonomy competing with
   * the verdict already published on every row of the screen (BUY / WAIT /
   * WATCH / AVOID, from verdict.py). Two vocabularies for one idea is how a
   * product stops being trusted, so the radar shows the EXISTING verdict and
   * uses the score only for strength.
   *
   * MOBILE IS NOT A SHRUNKEN RADAR. Eight nodes on a ring is unreadable at
   * 375px, so the phone gets a ranked vertical feed of the same data and the
   * ring is opt-in. Same numbers, different shape.
   *
   * MOTION IS CSS. requestAnimationFrame does not run in a hidden tab — a trap
   * this repo has already hit — so an rAF-driven pulse would freeze mid-frame
   * and the radar would look dead on return. */

  /* Bounded 0–100 from a value's position in a range. Saturating, so one
   * outlier cannot own a component. */
  const band = (v, lo, hi) => {
    /* NULL IS NOT ZERO, AND Number(null) IS 0 — the same trap price() names.
     * radarParts calls band(r.r1m, …) and band(r.r3m, …) with no null guard of
     * their own, so an unmeasured return coerced to 0 and landed at 46 out of
     * 100: a mid-band momentum score for a stock with no measured momentum.
     * The radar's own panel tells the reader that missing components are left
     * out of the mean rather than scored, so this contradicted the page. */
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, ((n - lo) / (hi - lo)) * 100));
  };
  const avg = (xs) => {
    const v = xs.filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  /* The four components. Each returns 0–100 or null; a missing one is dropped
   * from the mean rather than scored zero, which would push every thinly
   * covered name toward the middle and call that "neutral". */
  /* ── WHAT IS ABOVE AND BELOW THE PRICE ─────────────────────────────────────
   * The radar answered "how strong does this read" and never "at what price".
   * Every level here is already on the screen row — the year's range and the
   * three moving averages — so nothing is derived or forecast: they are
   * sorted against the last price, and the ones under it are support and the
   * ones over it are resistance, which is all those words mean.
   *
   * A level equal to the price within a tenth of a percent is neither, and is
   * labelled as being AT the price rather than assigned to a side it is not
   * really on. */
  /* ── SUPPORT 1 & 2, RESISTANCE 1 & 2 — AND WHY EACH ONE IS A LEVEL ───────
   *
   * The first version listed the year's range and the three moving averages,
   * sorted, labelled "support" or "resistance". That says WHERE but never WHY,
   * and "why" is the whole difference between a level and a horizontal line: a
   * 200-day average matters because a great many people act on it; a prior
   * swing high matters because it is where sellers actually appeared, and how
   * many times they appeared there is a measurable fact the screen already
   * carries in its ladder basis.
   *
   * So every candidate arrives with a reason attached, they are sorted by
   * distance from the LIVE price, and the nearest two on each side are named
   * S1/S2 and R1/R2. Anything further out is still listed underneath, because
   * the third level up is not nothing — it is just not the one that decides
   * the next move.
   *
   * SORTED AGAINST THE LIVE PRICE, NOT THE BUILD'S. Using r.price put NIACL's
   * marker at ₹229.90 — its 4 September close — while it traded at ₹209.80,
   * which made every level below read as support when ₹229.90 had become the
   * nearest resistance. A support table sorted against a four-day-old price is
   * worse than none: it is confidently the wrong way round.
   */
  const levelsBlock = (r) => {
    const lq = RADAR_LIVE && (RADAR_LIVE[r.sym] || RADAR_LIVE[bareSym(r.sym)]);
    const live = lq && lvl(lq.price);
    const px = live || lvl(r.price);
    const stale = !live && SCREEN_DATE ? SCREEN_DATE : null;
    if (px == null) return '';

    const L = r.lad || {};
    const cand = [];
    const add = (v, name, why) => {
      const n = lvl(v);
      if (n != null && why) cand.push({ v: n, name, why });
    };
    add(r.high52, "The year's high", 'the highest it has traded in 52 weeks — the level every holder from the last year is above water below');
    add(r.low52,  "The year's low",  'the lowest it has traded in 52 weeks — where the last round of selling stopped');
    add(r.sma20,  '20-day average',  'the short-term trend line; a great many systematic traders act on it');
    add(r.sma50,  '50-day average',  'the medium-term trend line, and the level the screen most often finds price testing');
    add(r.sma200, '200-day average', 'the line the market itself uses to call a trend up or down');
    /* The ladder's own levels carry a MEASURED reason — "prior swing high,
     * tested 6x" — which is the strongest kind available here, so they are
     * added last and win the de-duplication below.
     *
     * THEY ARE THE SCREEN'S TARGETS AND THEY MUST SAY SO.
     *
     * These were named "Target 1" and "Target 2". The card directly above this
     * table shows the SIGNAL's targets, under those same two words. On SARDAEN
     * that read: Target 1 ₹594.82 and Target 2 ₹649.21 on the card, then
     * Target 2 ₹576.44 and Target 1 ₹557.96 in the table — four numbers, two
     * labels, one screen, and no way for a reader to tell which pair to act on
     * or which one was wrong.
     *
     * Neither was wrong. `r.lad` is the SCREEN's ladder for the name — where
     * the daily screen would place levels on it — and the card carries what
     * the ENGINE published when it filed the signal. Two different questions
     * with two different answers, and the table was answering the one it was
     * not being asked.
     *
     * The stop below already made this distinction in as many words. The
     * targets were simply missed when it was written. */
    if (Array.isArray(L.t)) {
      L.t.forEach(([p, , reach, b], k) => add(p, `The screen's target ${k + 1}`,
        `${basisText(b) || "a level the screen's ladder targets"}${reach != null ? ` · reached by ${reach}% of closed trades` : ''}`
        + ' — the screen\u2019s own level, not the target this signal was filed with'));
    }
    if (Array.isArray(L.w)) add(L.w[0], 'In the way',
      `${basisText(L.w[2]) || 'a level between price and the first target'} — the trade has to clear it`);
    if (L.s != null) add(L.s, "The screen's stop",
      'where the SCREEN would place a stop on this name — not the stop the engine '
      + 'published for this signal, which is on the card above');

    if (!cand.length) return '';
    // Two levels within 0.4% of each other are one level. The later entry wins
    // because the ladder's reasons are measured and the averages' are generic.
    const uniq = [];
    for (const c of cand) {
      const hit = uniq.findIndex(u => Math.abs(u.v - c.v) / Math.max(u.v, c.v) < 0.004);
      if (hit >= 0) uniq[hit] = c; else uniq.push(c);
    }
    const below = uniq.filter(x => x.v < px).sort((a, b) => b.v - a.v);
    const above = uniq.filter(x => x.v > px).sort((a, b) => a.v - b.v);
    const at = uniq.filter(x => Math.abs(x.v - px) / px < 0.001);

    const row = (x, tag, cls) => `<div class="lv-r ${cls}">
      <span class="lv-k">${esc(tag)}</span>
      <span class="lv-p">${price(x.v)}</span>
      <span class="lv-d ${dir((x.v - px) / px * 100)}">${((x.v - px) / px * 100) > 0 ? '+' : ''}${((x.v - px) / px * 100).toFixed(1)}%</span>
      <span class="lv-w"><b>${esc(x.name)}</b><em>${esc(x.why)}</em></span>
    </div>`;

    const rest = [...above.slice(2).map(x => [x, 'Above', 'res']),
                  ...below.slice(2).map(x => [x, 'Below', 'sup'])]
      .sort((a, b) => b[0].v - a[0].v);

    return `<h4 class="sh">Support and resistance, and why</h4>
      <div class="lv">
        ${above.slice(0, 2).reverse().map((x, i) =>
          row(x, `R${above.slice(0, 2).length - i}`, 'res')).join('')}
        ${at.map(x => row(x, 'At price', 'at')).join('')}
        <div class="lv-r now"><span class="lv-k">Now</span>
          <span class="lv-p">${price(px)}</span>
          <span class="lv-d"></span>
          <span class="lv-w"><b>${live ? 'Live' : `Close of ${esc(stale || '—')}`}</b>
            <em>${live ? 'every distance above and below is measured from here'
                       : 'the screen has not been rebuilt since; distances move with the price'}</em></span></div>
        ${below.slice(0, 2).map((x, i) => row(x, `S${i + 1}`, 'sup')).join('')}
        ${rest.map(([x, tag, cls]) => row(x, tag, cls)).join('')}
      </div>
      <p class="hint" style="margin:8px 0 0">Levels are the year's range, the three moving
        averages and the screen's own ladder — nothing is drawn by hand.
        ${r.atr_pct != null ? `A typical day moves this name <b>${Number(r.atr_pct).toFixed(1)}%</b>,
        so anything inside that is noise rather than a test of a level.` : ''}</p>`;
  };

  const radarParts = (r) => {
    const x = instiOf(r.sym);
    const trend = avg([
      r.sma50 && r.price ? band((r.price - r.sma50) / r.sma50 * 100, -8, 12) : null,
      r.sma200 && r.price ? band((r.price - r.sma200) / r.sma200 * 100, -20, 30) : null,
      r.above_mas != null ? band(r.above_mas, 0, 3) : null,
    ]);
    const momentum = avg([
      band(r.r1m, -12, 14), band(r.r3m, -20, 28),
      r.rs3m != null ? band(r.rs3m, -1.2, 1.6) : null,
    ]);
    const volume = r.vol_spike != null ? band(r.vol_spike, 0.7, 2.6) : null;
    // Institutional is the only component with a real external source.
    const institutional = x && x.quality === 'complete' && x.score != null ? x.score : null;
    return { trend, momentum, volume, institutional };
  };
  const RADAR_W = { momentum: 0.30, trend: 0.30, volume: 0.20, institutional: 0.20 };

  /* PRIORITY IS NOT THE SCORE. The score says how strong the setup reads;
   * priority says how much it deserves the middle of the screen. Liquidity and
   * freshness belong in one and not the other — a stale signal on a thin name
   * can still be a strong reading, it just should not be the first thing you
   * look at. */
  const radarPriority = (r, score, parts) => {
    const liq = band(Math.log10(Math.max(1, r.turnover_cr || 1)), 0.7, 3.2) ?? 0;
    const conf = Object.values(parts).filter(v => v != null).length / 4 * 100;
    return score * 0.62 + liq * 0.18 + conf * 0.20;
  };

  /* RISK IS STATED, NOT IMPLIED BY A COLOUR. Distance above the 200-day and
   * daily range are the two things that make a strong reading fragile. */
  const radarRisk = (r) => {
    const ext = r.sma200 && r.price ? (r.price - r.sma200) / r.sma200 * 100 : null;
    const vol = r.atr_pct;
    const flags = [];
    if (ext != null && ext > 35) flags.push(`Extended — ${Math.round(ext)}% above its 200-day`);
    if (vol != null && vol > 4) flags.push(`Daily range ${Number(vol).toFixed(1)}% — volatile`);
    if (r.from_high != null && r.from_high > -3) flags.push('At the top of its 52-week range');
    if ((r.turnover_cr ?? 0) < 25) flags.push(`Thin — ₹${Math.round(r.turnover_cr || 0)} cr a day`);
    const level = flags.length >= 2 ? 'HIGH' : flags.length === 1 ? 'MEDIUM' : 'LOW';
    return { level, flags };
  };

  /* A 24-point sparkline path. No library: it is nine numbers of arithmetic and
   * a heavy charting dependency for a 60px line is the definition of cost
   * without benefit. Returns null when there is nothing real to draw — an
   * invented flat line would read as "no movement", which is a claim. */
  const sparkPath = (pts, w = 74, h = 22) => {
    const v = (pts || []).filter(x => Number.isFinite(x));
    if (v.length < 4) return null;
    const lo = Math.min(...v), hi = Math.max(...v), rng = (hi - lo) || 1;
    const step = w / (v.length - 1);
    const d = v.map((x, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - ((x - lo) / rng) * h).toFixed(1)}`).join('');
    return { d, up: v[v.length - 1] >= v[0], area: `${d}L${w},${h}L0,${h}Z` };
  };
  const radarScore = (parts) => {
    const live = Object.entries(parts).filter(([, v]) => v != null);
    if (live.length < 2) return null;             // two components is not a score
    const w = live.reduce((s, [k]) => s + RADAR_W[k], 0);
    return Math.round(live.reduce((s, [k, v]) => s + RADAR_W[k] * v, 0) / w);
  };

  /* MARKET CORE. Breadth is the honest centre of "what is the market doing" —
   * an index level says what fifty weighted names did, breadth says what 750
   * actually did. Every term is printed in the drawer. */
  const marketCore = (b) => {
    if (!b) return null;
    const rows = [
      ['Breadth · above the 50-day', band(b.above50, 20, 80), 30],
      ['Trend · above the 200-day', band(b.above200, 25, 85), 25],
      ['Participation · advancing', band(b.counted ? b.advancing / b.counted * 100 : null, 25, 75), 20],
      ['Momentum · median 1-month', band(b.median_1m, -8, 8), 15],
      ['Leadership · at a 52-week high', band(b.counted ? b.at_52w_high / b.counted * 100 : null, 0, 8), 10],
    ].filter(r => r[1] != null);
    if (!rows.length) return null;
    const wsum = rows.reduce((s, r) => s + r[2], 0);
    const score = Math.round(rows.reduce((s, r) => s + r[1] * r[2], 0) / wsum);
    const state = score >= 66 ? ['Risk-on', 'up'] : score >= 45 ? ['Neutral', ''] : ['Risk-off', 'dn'];
    return { score, state, rows, wsum };
  };

  /* Derived from VERDICT — see the note there. It was a second, hand-kept copy
     of the same table and had drifted from the screen's on three of five. */
  const VERDICT_LOOK = VERDICT;
  const strengthWord = (s) => s == null ? 'Not scored'
    : s >= 75 ? 'Strong' : s >= 60 ? 'Firm' : s >= 45 ? 'Moderate' : s >= 30 ? 'Soft' : 'Weak';

  R['/radar'] = async () => {
    const shell = body => head('Signal radar',
      'What the market is doing, and which names are carrying it.', 'Radar') + body;
    paint(shell(`<div class="sk" style="height:420px"></div>`));

    if (!SCREEN) {
      const g0 = await getScreen(false); const r0 = noteLadder(g0.r);
      if (!r0.ok) { paint(shell(fail('The radar', r0.error))); return; }
      setScreen((r0.data.rows || []).filter(x => x && x.sym), g0.lite);
      RADAR_BREADTH = r0.data.breadth || null;
      SCREEN_DATE = r0.data.price_date || null;
    }
    await loadInsti();
    const core = marketCore(RADAR_BREADTH);
    RADAR_CORE = core;

    /* RANKED, NOT SAMPLED. Liquidity is a gate rather than a term: a name that
     * cannot be bought does not become interesting because its score is high. */
    const ranked = SCREEN
      .filter(r => (r.turnover_cr ?? 0) >= 5)
      .map(r => {
        const parts = radarParts(r);
        const score = radarScore(parts);
        return score == null ? null
          : { r, parts, score, priority: radarPriority(r, score, parts), risk: radarRisk(r) };
      })
      .filter(Boolean)
      .sort((a, b) => b.priority - a.priority);

    if (!ranked.length) {
      paint(shell(`<div class="empty">No name has enough measured components to score today.
        The radar needs at least two of trend, momentum, volume and institutional flow.</div>`));
      return;
    }
    const nodes = ranked.slice(0, 8);
    RADAR_NODES = nodes;

    paint(shell(
      (core ? `<section class="rd-core-wrap">
        <button type="button" class="rd-core" id="rdCore" aria-expanded="false" aria-controls="rdCoreD">
          <span class="rd-core-k">Market signal</span>
          <span class="rd-core-n ${core.state[1]}">${core.score}<em>/100</em></span>
          <span class="rd-core-s ${core.state[1]}">${core.state[0]}</span>
          <span class="rd-core-h">How this is built ▾</span>
        </button>
        <div class="rd-core-d" id="rdCoreD" hidden>
          ${core.rows.map(([l, v, w]) => `<div class="rd-cr">
            <span class="rd-cw">${w}%</span><span class="rd-cl">${esc(l)}</span>
            <span class="rd-cv">${Math.round(v)}</span>
            <span class="rd-cb"><i style="width:${Math.round(v)}%"></i></span>
          </div>`).join('')}
          <p class="rd-cn">A weighted reading of breadth over <b>${RADAR_BREADTH.counted}</b> names,
            as of ${esc(RADAR_BREADTH.as_of || '—')}. It describes the market, not any one stock,
            and it is a <b>model</b> — every term and weight is above.</p>
        </div>
      </section>` : '') +
      `<div class="rd-stage" id="rdStage">${radarSvg(nodes)}
         <button type="button" class="rd-full" id="rdFull" aria-label="Expand the radar">Expand ⤢</button>
       </div>` +
      /* THE UNIVERSE STRIP. The ring shows eight; this shows the next tier
       * without making anyone open another page. Horizontal on a phone because
       * a strip of small cards is the one thing sideways scrolling is actually
       * good at. */
      sec('Signal universe', `<div class="rd-strip" role="list">${
        ranked.slice(0, 20).map(nd => `<button type="button" class="rd-u" role="listitem"
          data-rsym="${esc(nd.r.sym)}" aria-label="${esc(nd.r.sym)}, score ${nd.score} of 100">
          ${radarCardInner(nd)}</button>`).join('')
      }</div>`, 'swipe →') +
      /* "top 20 of 694" over a strip, then "8 of 694 scored" over a list of 8,
       * read as one section contradicting the next. Each count now describes
       * the thing directly under it, and the strip says how to see the rest of
       * its twenty rather than claiming a number the screen does not show. */
      sec('Top signals', `<div class="rd-feed">${nodes.map((n, i) => radarRow(n, i)).join('')}</div>`,
          `${nodes.length} shown`) +
      `<p class="hint rd-foot"><b>Prices are live; the score is not.</b> The four components
        are computed from the screen's daily build${SCREEN_DATE ? `, priced ${esc(SCREEN_DATE)}` : ''},
        so a name that moved sharply today is still scored on where it stood then —
        <span id="rdLive">prices updating…</span>.
        <br><b>The score is a model, not a measurement.</b> It weights
        momentum 30, trend 30, volume 20 and institutional flow 20, over the screen's own
        fields; a name missing a component is scored on the rest rather than penalised.
        The verdict beside it (Buy / Wait / Watch / Avoid) is the screen's own reading and is
        not derived from this score. <b>${ranked.length}</b> of the screened names could be
        scored — the rest are under ₹5 cr of daily turnover, or have fewer than two of the
        four components measurable. The strip above carries the top 20; the ring and the
        list carry the top ${nodes.length}.
        <a href="/methodology">How every number here is made →</a></p>`
    ));
    wireRadar(nodes, ranked);
  };

  /* THE RING.
   *
   * Node position is not decoration: ANGLE spreads the set evenly so nothing
   * collides, RADIUS carries priority — the names that most deserve attention
   * sit closest to the core. Card size is fixed so eight of them tile without
   * overlap; the ring radius is derived from that, not guessed.
   *
   * Cards are foreignObject, so they are real HTML — the same type scale,
   * tokens and tabular numerals as everything else, rather than SVG <text>
   * that has to reimplement all of it and still wraps badly.
   *
   * Line weight and opacity carry signal strength. A weakening reading fades
   * rather than changing hue, so strength and direction stay separable. */
  const CARD_W = 148, CARD_H = 92;
  const radarSvg = (nodes) => {
    const W = 940, H = 620, cx = W / 2, cy = H / 2;
    const n = nodes.length;
    const maxP = Math.max(...nodes.map(x => x.priority)), minP = Math.min(...nodes.map(x => x.priority));
    const spanP = (maxP - minP) || 1;
    return `<svg class="rd-svg" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Signal radar. ${nodes.map(x => `${x.r.sym} ${x.score} of 100`).join('. ')}.">
      <defs>
        <radialGradient id="rdGlow"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".16"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></radialGradient>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="196" class="rd-ring"/>
      <circle cx="${cx}" cy="${cy}" r="140" class="rd-ring"/>
      <circle cx="${cx}" cy="${cy}" r="112" class="rd-glow" fill="url(#rdGlow)"/>
      ${nodes.map((nd, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        /* THE MINIMUM RADIUS IS GEOMETRY, NOT TASTE.
         * Two adjacent cards on a ring of n are 2·r·sin(π/n) apart. At n=8
         * that is 0.765·r, so a 148px card with a 16px gap needs r > 214 or
         * neighbours overlap — which two of them did at r=168. The band is
         * therefore 218–272: still enough travel for priority to read as
         * distance, and no collision at any ranking. */
        const R_IN = 218, R_OUT = 272;
        const rad = R_OUT - ((nd.priority - minP) / spanP) * (R_OUT - R_IN);
        const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
        const edgeX = cx + Math.cos(a) * 104, edgeY = cy + Math.sin(a) * 104;
        const s = nd.score;
        const cls = s >= 65 ? 'is-up' : s < 42 ? 'is-dn' : 'is-mid';
        const wgt = (0.7 + (s / 100) * 2.4).toFixed(2);
        const op = (0.30 + (s / 100) * 0.55).toFixed(2);
        return `<g class="rd-n ${cls}" data-rsym="${esc(nd.r.sym)}">
          <line class="rd-link" x1="${edgeX.toFixed(1)}" y1="${edgeY.toFixed(1)}"
                x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"
                stroke-width="${wgt}" stroke-opacity="${op}"/>
          <circle class="rd-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>
          <foreignObject x="${(x - CARD_W / 2).toFixed(1)}" y="${(y - CARD_H / 2).toFixed(1)}"
                         width="${CARD_W}" height="${CARD_H}">
            <div xmlns="http://www.w3.org/1999/xhtml" class="rd-card" role="button" tabindex="0"
                 data-rsym="${esc(nd.r.sym)}">${radarCardInner(nd)}</div>
          </foreignObject>
        </g>`;
      }).join('')}
      <circle cx="${cx}" cy="${cy}" r="62" class="rd-hub"/>
      <foreignObject x="${cx - 58}" y="${cy - 40}" width="116" height="80">
        <div xmlns="http://www.w3.org/1999/xhtml" class="rd-hubc">
          <span>Market</span><b id="rdHubN">${RADAR_CORE ? RADAR_CORE.score : '—'}</b>
          <em>${RADAR_CORE ? esc(RADAR_CORE.state[0]) : ''}</em>
        </div>
      </foreignObject>
    </svg>`;
  };

  /* The card that sits on a node, and the same markup reused by the strip
   * below the ring — one component, two placements. */
  const radarCardInner = (nd) => {
    const r = nd.r, x = instiOf(r.sym);
    const sp = sparkPath(RADAR_SERIES[r.sym]);
    const v = (r.vd && r.vd.c) || '';
    const [vcls, vlabel] = VERDICT_LOOK[v] || ['', 'Not rated'];
    return `<span class="rdc-t"><b>${esc(r.sym)}</b>
        <i class="${dir(r.r1d)}">${pct(r.r1d)}</i></span>
      <span class="rdc-v ${vcls}">${esc(vlabel)}</span>
      <span class="rdc-b"><i style="width:${nd.score}%"></i></span>
      <span class="rdc-m"><u>${nd.score}</u>
        ${sp ? `<svg class="rdc-sp ${sp.up ? 'up' : 'dn'}" viewBox="0 0 74 22" aria-hidden="true">
                  <path class="rdc-spa" d="${sp.area}"/><path class="rdc-spl" d="${sp.d}"/></svg>`
             : `<em class="rdc-nosp">no series</em>`}
        ${x && x.quality === 'complete' && x.insti_pp != null
          ? `<em class="rdc-fii ${dir(x.insti_pp)}">${x.insti_pp > 0 ? '▲' : x.insti_pp < 0 ? '▼' : '·'}</em>` : ''}
      </span>`;
  };

  /* ── THE FIGURES THE SCORE BARS THROW AWAY ─────────────────────────────────
   * Trend/Momentum/Volume/Institutional are each normalised to 0-100, which
   * strips them of their units — a reader cannot recover RSI, the month's
   * return, or where the price sits in its 52-week band from a bar. These are
   * the raw numbers, and they are ONE renderer because the radar and Ideas
   * both show them and two copies would drift.
   *
   * from_high and the stop are stamped at the screen's build, so both carry a
   * data attribute and are re-read against the live quote by the overlay in
   * wireRadar. IFCI printed "off its high 0.0%" — true on 4 September, when it
   * WAS the high — beside a live price 8.7% under it, and its published stop
   * of ₹94.54 sat above the ₹92.61 it traded at, which is a broken trade the
   * row said nothing about. */
  const factsStrip = (r, opts) => {
    if (!r) return '';
    return `<span class="rd-facts">
      <span class="rd-f"><em>RSI daily</em><b class="${r.rsi >= 70 ? 'dn' : r.rsi <= 35 ? 'up' : ''}">${
        r.rsi == null ? '—' : Math.round(r.rsi)}</b></span>
      ${/* The screen carries a MONTHLY RSI for 705 of the screened names, sampled
          * every 21 sessions. On a swing ladder it answers a question the daily
          * one cannot: whether the move is early or already long in the tooth. */''}
      <span class="rd-f"><em>RSI monthly</em><b class="${r.rsi_m >= 70 ? 'dn' : r.rsi_m <= 35 ? 'up' : ''}">${
        r.rsi_m == null ? 'n/m' : Math.round(r.rsi_m)}</b></span>
      <span class="rd-f"><em>1 month</em><b class="${dir(r.r1m)}">${pct(r.r1m)}</b></span>
      <span class="rd-f"><em>3 months</em><b class="${dir(r.r3m)}">${pct(r.r3m)}</b></span>
      ${/* ── A SHORTER WINDOW IS STILL A MEASURED ONE ─────────────────────
          * These two cells read "—" on 69 of 983 names — LENSKART, GROWW,
          * EMMVEE and the rest of the recent listings, plus the demerged
          * tickers whose price series restarts: VEDL, SKFINDIA, TIMEX.
          *
          * The screen nulls high52 under 240 bars, correctly, because
          * everything derived from it CLAIMS A YEAR. But a high is not an
          * average: the max of 96 bars is the true max of those 96 bars, and
          * blanking it hid a fact the series plainly contains — on cards that
          * still carried a BUY with an entry, a stop and a target, where the
          * screen could not say where the price sat in its own range.
          *
          * So the screen now publishes that window under its own keys with
          * the number of sessions it covers, and this is the one place that
          * decides what to call it. FOUR MONTHS IS NOT A YEAR and the label
          * says which it is — including "at a new high", which must not read
          * as a 52-week high when the window is 96 sessions. */''}
      ${(() => {
        const full = r.low52 != null && r.high52 != null;
        const short = !full && r.rng_lo != null && r.rng_hi != null;
        const hi   = full ? r.high52 : short ? r.rng_hi : null;
        const lo   = full ? r.low52  : short ? r.rng_lo : null;
        const fh   = full ? r.from_high : short ? r.rng_from_hi : null;
        const sess = short ? Number(r.rng_sessions) : null;
        const win  = full ? '52w' : sess ? `${sess}-session` : '';
        const o = offHigh(fh);
        const since = short
          ? ` title="The high and low of every session on file — ${sess} of them. Less than a year of trading, so this is not a 52-week range and is not compared with one."`
          : '';
        return `<span class="rd-f"${since}><em>${full ? '52w range' : short ? `${win} range` : '52w range'}</em><b>${
          hi == null || lo == null ? '—' : `${price(lo)} – ${price(hi)}`}</b></span>
      <span class="rd-f"${since}>
        <em>${o && o.txt === 'at a new high' ? `${win || '52w'} high` : 'Off its high'}</em>
        <b data-fhigh="${esc(String(hi ?? ''))}" data-fwin="${esc(win)}" class="${o ? o.cls : ''}">${
          o ? esc(o.txt) : '—'}</b></span>`;
      })()}
      ${/* ── NIFTY500 AHIMSA ─────────────────────────────────────────────
          * NSE Indices launched this on 10 July 2026 — the Nifty 500 filtered
          * to companies not engaged in activities harmful to animals, 326 of
          * the 500 at launch.
          *
          * MEMBERSHIP, NOT A SCORE. NSE publishes the constituent list and no
          * per-company quotient, so there is none to show; inventing one would
          * put a number with no source beside a table where every other number
          * has one. It is also not an input to the composite, because nothing
          * measured says a constituent outperforms.
          *
          * THREE STATES, NOT TWO. A missing key means the build could not read
          * NSE's list, which is not the same as NSE leaving the name out — so
          * it reads "not stated" rather than silently taking the No branch and
          * marking all 500 names as failing an ethics test on a failed
          * fetch. */''}
      <span class="rd-f"><em>Nifty500 Ahimsa</em><b class="${
        r.ahimsa === true ? 'up' : r.ahimsa === false ? '' : ''}" title="${
        r.ahimsa === true ? 'NSE Indices includes this name in the Nifty500 Ahimsa index'
        : r.ahimsa === false ? 'NSE Indices does not include this name in the Nifty500 Ahimsa index'
        : "NSE's constituent list was not readable for this build"}">${
        r.ahimsa === true ? 'In' : r.ahimsa === false ? 'Not in' : 'not stated'}</b></span>
      ${/* ── THE LADDER, AND ONLY WHERE THERE IS NOT ALREADY ONE ─────────
          * A stop and a first target with NO ENTRY beside them cannot be
          * read: R is measured from the entry, so without it neither number
          * says how much is at risk. EDELWEISS carried "Stop ₹125.46 · First
          * target ₹144.34" over an entry of ₹132.72 that was in the data and
          * simply not rendered.
          *
          * AND THE WHOLE BLOCK IS SUPPRESSED WHERE THE CARD HAS ITS OWN.
          * This strip is reused under the signals-page ledger card, which
          * already prints the ENGINE's entry, stop and targets. Both were
          * shown, unlabelled, and they are different numbers computed from
          * different prices: SARDAEN on 2026-09-09 read "Entry ₹545.85 ·
          * Stop ₹483.61 · Target 1 ₹594.82" from the LEDGE signal filed that
          * morning, over "Stop ₹490.41 · First target ₹557.96" from a screen
          * row built at ₹508.55 — a 7% different price, and a verdict of
          * WATCH, "Nothing to act on", under a card headed BUY.
          *
          * The screen's context (the year's range, RSI, the returns) is what
          * that card wanted. Its ladder is a second opinion nobody asked for. */''}
      ${/* ── AND THEY ARE THE SCREEN'S LEVELS, SO THEY SAY SO ──────────────
          * Suppressing the block where a card has its own was half the fix.
          * The other half is that where it DOES show, it was labelled "Entry /
          * Stop / First target" — the same three words the signal's own levels
          * carry — so IFCI read Stop 95.56 and First target 113.64 on the
          * radar against Stop 92.65 and Target 1 122.23 on the front page.
          * Same company, same session, same words, different numbers, and
          * nothing on either surface saying which was which.
          *
          * Neither is wrong. r.lad is where the daily SCREEN would place
          * levels; the card carries what the ENGINE published when it filed.
          * The support-and-resistance table was corrected this way already —
          * this is the same three fields in a different component, and it was
          * missed the first time. */''}
      ${r.lad && r.lad.s != null && !(opts && opts.noLadder) ? `
        <span class="rd-f"><em>Screen entry</em><b
          title="The screen's reference price — not the price this signal was filed at. The stop and targets below are measured from here, so R means nothing without it."
          >${r.lad.e != null ? price(r.lad.e) : '—'}</b></span>
        <span class="rd-f"><em>Screen stop</em>
          <b class="dn" data-stop="${esc(String(r.lad.s))}"
             title="Where the SCREEN would place a stop on this name — not the stop the engine published for this signal.">${price(r.lad.s)}</b></span>
        <span class="rd-f"><em>Screen target</em><b class="up"
          title="The screen's first target, not the signal's.">${
          r.lad.t && r.lad.t[0] ? price(r.lad.t[0][0]) : '—'}</b></span>` : ''}
    </span>`;
  };

  /* Where it sits in the year, drawn. A number between a low and a high is a
   * position on a line before it is a percentage. */
  const bandLine = (r) => {
    if (!r || r.low52 == null || r.high52 == null || !(r.high52 > r.low52)) return '';
    const at = Math.max(0, Math.min(100, (r.price - r.low52) / (r.high52 - r.low52) * 100));
    return `<span class="rd-band" role="img"
      aria-label="${price(r.price)} in a 52-week range of ${price(r.low52)} to ${price(r.high52)}">
      <i style="left:${at.toFixed(1)}%"></i></span>`;
  };

  const radarRow = (nd, i) => {
    const r = nd.r, x = instiOf(r.sym);
    const v = (r.vd && r.vd.c) || '';
    const [vcls, vlabel] = VERDICT_LOOK[v] || ['', 'Not rated'];
    const p = nd.parts;
    /* ── A BAR WITH NOTHING TO READ IT AGAINST ──────────────────────────
     * Four bars in one colour, each a length and nothing else. A reader can
     * see that Institutional is shorter than Trend and cannot see whether
     * either is pulling the score up or down, which is the only question the
     * four are on the card to answer.
     *
     * The tick is the card's OWN composite, already printed two lines above,
     * placed on each track. Nothing is computed here that is not already on
     * the card, and no second colour is introduced — length stays the
     * encoding, the tick is the reference. */
    const bar = (l, val) => `<span class="rd-p"><em>${esc(l)}</em>
      <i style="--at:${Math.max(0, Math.min(100, Number(nd.score) || 0))}%"
         ><b style="width:${val == null ? 0 : Math.round(val)}%"></b></i>
      <u>${val == null ? '—' : Math.round(val)}</u></span>`;
    return `<article class="rd-row" data-rsym="${esc(r.sym)}" role="button" tabindex="0">
      <span class="rd-rank">${i + 1}</span>
      <span class="rd-id"><b>${esc(r.sym)}</b><span>${esc(r.name || '')}</span>
        <em class="rd-v ${vcls}">${esc(vlabel)}</em></span>
      <span class="rd-px">${price(r.price)}<i class="${dir(r.r1d)}">${pct(r.r1d)}</i></span>
      ${/* WHICH SCORE THIS IS. The screen publishes a fundamental composite
          * too, and for IFCI on 2026-09-09 that read 39.6 while this read 89 —
          * both correct, measuring different things, with nothing on the card
          * saying which was which. A reader seeing "89 Strong" has no way to
          * know the same site scores the same name 39.6 on quality, growth and
          * valuation. The number is unchanged; it now says what it is of. */''}
      <span class="rd-sc" title="Trend, momentum, volume and institutional flow, each normalised to 0-100 and averaged. This is a score of the MOVE, not of the business — the screen's fundamental composite (quality, growth, valuation, technical) is a separate number on the stock's own page."><b>${nd.score}</b><em>${esc(strengthWord(nd.score))}</em></span>
      <span class="rd-parts" title="Each component normalised to 0-100. The tick on every bar is this name's own composite score, so a bar reaching past it is carrying the score and one falling short is holding it back.">${bar('Trend', p.trend)}${bar('Momentum', p.momentum)}${bar('Volume', p.volume)}${bar('Institutional', p.institutional)}</span>
      ${/* ── THE NUMBERS THE FOUR BARS DO NOT CARRY ────────────────────────
          * Trend/Momentum/Volume/Institutional are the SCORE's components —
          * each normalised to 0-100 and therefore stripped of its own unit.
          * A reader cannot get RSI, the month's return or where the price
          * sits in its 52-week band back out of them, and those are the
          * three that decide whether a 90 is a fresh move or a spent one.
          * They are printed raw, beside the bars that hide them. */''}
      ${factsStrip(r)}${bandLine(r)}
      ${x && x.quality === 'complete' && x.signal !== 'neutral' && x.signal !== 'unknown'
        ? `<span class="rd-fii">FII ${ppFmt(x.fii_pp)} · DII ${ppFmt(x.dii_pp)}</span>` : ''}
    </article>`;
  };

  const wireRadar = (nodes, ranked) => {
    const core = document.getElementById('rdCore');
    if (core) core.addEventListener('click', () => {
      const d = document.getElementById('rdCoreD');
      const open = d.hidden; d.hidden = !open;
      core.setAttribute('aria-expanded', open ? 'true' : 'false');
      core.classList.toggle('is-open', open);
    });
    const open = (sym) => {
      /* LOOK IN THE WHOLE RANKED SET, NOT JUST THE RING.
       * This searched RADAR_NODES, which holds the eight on the ring — so the
       * twelve strip cards below them did nothing at all when tapped, silently.
       * The strip is drawn from `ranked`; the lookup has to be too. */
      const nd = (ranked || []).find(n => n.r.sym === sym)
              || (RADAR_NODES || []).find(n => n.r.sym === sym);
      if (!nd) return;
      const p = nd.parts, r = nd.r, x = instiOf(sym);
      const line = (l, w, val) => `<div class="isc-r"><span class="isc-w">${w}%</span>
        <span class="isc-l">${esc(l)}</span>
        <span class="isc-v">${val == null ? 'not measured' : Math.round(val)}</span></div>`;
      sheet(`${esc(sym)} <small>${esc(r.name || '')}</small>`, `
        <div class="isc"><div class="isc-h">
          <span class="isc-n ${nd.score >= 60 ? 'up' : nd.score < 40 ? 'dn' : ''}">${nd.score}</span>
          <span class="isc-b">${esc(strengthWord(nd.score))}<em>Radar score · 0–100 · a model</em></span></div>
          ${line('Momentum', 30, p.momentum)}${line('Trend', 30, p.trend)}
          ${line('Volume', 20, p.volume)}${line('Institutional flow', 20, p.institutional)}
          <p class="isc-n2">Components missing for this name are left out of the mean rather than
            scored zero. The score ranks names; it does not value them.</p></div>
        ${nd.risk && nd.risk.flags.length ? `<h4 class="sh">Risk flags</h4>
          <ul class="rd-risk">${nd.risk.flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
          : `<h4 class="sh">Risk flags</h4><p class="ef-p">None of the four checked —
             extension above the 200-day, daily range, position in the 52-week band,
             and daily turnover.</p>`}
        <h4 class="sh">The screen's own verdict</h4>
        <p class="ef-p">${esc((r.vd && r.vd.l) || 'Not rated')}${r.vd && r.vd.o ? ` — ${esc(r.vd.o)}` : ''}</p>
        ${/* THE LEVELS, WHICH THIS PANEL USED TO OMIT ENTIRELY.
            * It showed a score out of 100 and never the price the score was
            * about — no entry, no stop, no target, nothing above or below.
            * ladderBlock is the screen's own ladder renderer, reused rather
            * than rebuilt: same entry, same 1.41xATR stop, same measured
            * "reached" percentages and the same reason under each level. */''}
        ${ladderBlock(r)}
        ${(() => {
          /* THE LADDER IS NOT RE-PRICED, AND THAT HAS TO BE SAID.
           * Its entry and stop are what the screen published on its build, so
           * rewriting them against today's price would falsify the plan the
           * site actually issued. But a reader looking at an entry of ₹229.91
           * on a stock trading at ₹209.80 needs to be told, not left to spot
           * it. The levels stay; the gap is named. */
          const L = r.lad, live = RADAR_LIVE && RADAR_LIVE[r.sym] && lvl(RADAR_LIVE[r.sym].price);
          const e = L && lvl(L.e);
          if (!e || !live) return '';
          const gap = (live - e) / e * 100;
          if (Math.abs(gap) < 1) return '';
          return `<p class="hint" style="margin:8px 0 0"><b>The ladder above is the plan as
            published${SCREEN_DATE ? ` on ${esc(SCREEN_DATE)}` : ''}, not a live one.</b>
            It trades at ${price(live)} now — <b class="${dir(gap)}">${gap > 0 ? '+' : ''}${gap.toFixed(1)}%</b>
            ${gap > 0 ? 'above' : 'below'} that entry, so the risk and the reward on it are no
            longer the ones written in the table.</p>`;
        })()}
        ${levelsBlock(r)}
        ${x && x.quality === 'complete' ? `<h4 class="sh">Institutional flow</h4>
          <div class="yoy">
            <div class="yy"><span>FII, quarter on quarter</span><b class="${dir(x.fii_pp)}">${ppFmt(x.fii_pp)}</b></div>
            <div class="yy"><span>DII, quarter on quarter</span><b class="${dir(x.dii_pp)}">${ppFmt(x.dii_pp)}</b></div>
            <div class="yy"><span>Reading</span><b>${esc(x.signal_label || '')}</b></div>
          </div>` : ''}
        <p class="hint" style="margin-top:14px">
          <a href="/stock/${encodeURIComponent(sym)}">Open the full company card →</a></p>`);
    };
    /* data-rsym, NOT data-sym.
     * The global click handler claims every [data-sym] and opens the company
     * card, so binding the radar's own panel to the same attribute meant both
     * fired and the card won — the score decomposition this screen exists to
     * show was unreachable. One attribute, one owner; the panel links to the
     * full card for anyone who wants it. */
    /* SELECTING A NAME DIMS THE REST.
     * The ring, the strip and the list are three views of one set, so a
     * selection has to land on all three or the reader has to re-find the name
     * they just clicked. One class on the container, everything else in CSS. */
    let picked = null;
    const select = (sym) => {
      picked = picked === sym ? null : sym;
      main.classList.toggle('rd-picked', !!picked);
      main.querySelectorAll('[data-rsym]').forEach(el => {
        el.classList.toggle('is-sel', !!picked && el.getAttribute('data-rsym') === picked);
      });
    };
    main.querySelectorAll('[data-rsym]').forEach(el => {
      const sym = el.getAttribute('data-rsym');
      el.addEventListener('click', (ev) => { ev.stopPropagation(); select(sym); open(sym); });
      el.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(sym); open(sym); }
      });
    });

    /* FULL-SCREEN RADAR. On a phone the ring is not rendered inline — eight
     * labelled cards on a circle at 375px is unreadable — so this is how the
     * visual gets seen there at all, without the list paying for it. */
    const fs = document.getElementById('rdFull');
    if (fs) fs.addEventListener('click', () => {
      const st = document.getElementById('rdStage');
      const on = st.classList.toggle('is-full');
      document.body.style.overflow = on ? 'hidden' : '';
      fs.textContent = on ? 'Close ✕' : 'Expand ⤢';
      fs.setAttribute('aria-label', on ? 'Close the radar' : 'Expand the radar');
    });
    addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const st = document.getElementById('rdStage');
      if (st && st.classList.contains('is-full')) { st.classList.remove('is-full');
        document.body.style.overflow = ''; if (fs) fs.textContent = 'Expand ⤢'; }
    });

    /* LIVE PRICES, BECAUSE screen.json IS A DAILY ARTEFACT.
     *
     * The radar rendered r.price and r.r1d straight off the build. On the
     * morning this was found that build carried price_date 2026-09-04 while
     * the date was the 8th, so NIACL showed ₹229.91 and +17.70% against a live
     * ₹204.60 and −11.5% — the site reported a stock up 18% while it was down
     * 11%. Nothing was wrong with the data; it was four days old and presented
     * as current, which is the one failure this whole site is built to avoid.
     *
     * The Screen route already solves this for its visible rows. The radar now
     * does the same: one request for every symbol it shows, applied in place
     * after paint, and the footnote says which figures are live and which are
     * the build's. */
    const liveSyms = [...new Set([...nodes, ...ranked.slice(0, 20)].map(n => n.r.sym))];
    (async () => {
      const q = await get(`/api/signals?px=${liveSyms.slice(0, 40).map(encodeURIComponent).join(',')}`);
      if (!q.ok || !q.data || !q.data.quotes) return;
      RADAR_LIVE = q.data.quotes;
      for (const [sym, v] of Object.entries(q.data.quotes)) {
        if (v == null || v.price == null) continue;
        main.querySelectorAll(`[data-rsym="${CSS.escape(sym)}"]`).forEach(el => {
          const px = el.querySelector('.rdc-t i, .rd-px');
          if (!px) return;
          const cp = v.change_pct;
          if (el.classList.contains('rd-row')) {
            el.querySelector('.rd-px').innerHTML =
              `${price(v.price)}<i class="${dir(cp)}">${pct(cp)}</i>`;
          } else {
            const i = el.querySelector('.rdc-t i');
            if (i) { i.textContent = pct(cp); i.className = dir(cp); }
            const b = el.querySelector('.rdc-t b');
            if (b) b.title = `${sym} · ${price(v.price)} live`;
          }
          // Re-read the two build-stamped facts against the live price.
          /* ── THROUGH offHigh(), NOT THE RAW PERCENTAGE ──────────────────
           * This wrote `d.toFixed(1) + '%'` straight into the cell, so a live
           * price ABOVE the 52-week high produced a POSITIVE number under a
           * label reading "Off its high" — which reads as that far below when
           * it is that far above.
           *
           * That is the exact fault offHigh() was written for, reinstated by
           * a second path that did not call it. Measured on ACMESOLAR,
           * 2026-09-22: live ₹458.65 against a 52-week high of ₹440.70 on the
           * same card, rendering "4.1% · Off its high". FINCABLES showed the
           * same thing at build before offHigh() existed, and the comment on
           * that helper says so.
           *
           * It is the sibling of the bug two blocks below, where the stop
           * comparison "used to BE the rule, which is why the rule existed
           * only here". A rule with two call sites and one implementation is
           * the only shape that cannot drift.
           *
           * THE LABEL MOVES WITH THE VALUE. The <em> beside it is chosen at
           * build — "52-week high" when the name is at one, "Off its high"
           * otherwise — and writing only the <b> leaves a correct number
           * under a stale heading, which is the same defect one element to
           * the left. */
          const fh = el.querySelector('[data-fhigh]');
          if (fh) {
            const hi = Number(fh.getAttribute('data-fhigh'));
            if (Number.isFinite(hi) && hi > 0) {
              const o = offHigh((v.price - hi) / hi * 100);
              if (o) {
                fh.textContent = o.txt;
                fh.className = o.cls;
                /* THE WINDOW COMES FROM THE CELL, NOT FROM THIS FUNCTION.
                 * data-fhigh is whatever high the row actually has — a year
                 * for most names, the sessions on file for the 69 that have
                 * less than one. Writing "52-week high" here would put a year
                 * on a 96-session window every time one of those made a new
                 * high, which is the same false sentence the producer's gate
                 * exists to prevent. */
                const win = fh.getAttribute('data-fwin') || '52w';
                const lab = fh.parentElement && fh.parentElement.querySelector('em');
                if (lab) lab.textContent = o.txt === 'at a new high' ? `${win} high` : 'Off its high';
              }
            }
          }
          const st = el.querySelector('[data-stop]');
          if (st) {
            const s = Number(st.getAttribute('data-stop'));
            if (Number.isFinite(s)) {
              /* stopVoid(), not `v.price <= s`. This comparison used to BE
                 the rule, which is why the rule existed only here. */
              const hit = stopVoid(v.price, s);
              st.textContent = price(s) + (hit ? ' · breached' : '');
              st.className = hit ? 'dn is-hit' : 'dn';
              /* ── THE HALF-FIX THIS COMPLETES ────────────────────────────
               * Marking the stop breached made the FACTS live and left the
               * CALL stamped at the build, so a card could read:
               *
               *   IFCI  ·  Buy  ·  89 Strong
               *   Off its high  -13.1%      (live)
               *   Stop  ₹95.56 · breached   (live)
               *
               * measured on 2026-09-09, where the verdict's own stated reason
               * was "Broke its 52-week high" — a premise the line above it now
               * contradicts. Two live facts under two stale ones, with nothing
               * reconciling them, and the stale pair is the headline.
               *
               * A breached stop VOIDS the setup. Not pauses it: the entry was
               * chosen because of a level that has since failed, so waiting to
               * re-enter there is acting on a falsified premise. The verdict
               * says so, and the score keeps its number while saying when it
               * was taken — the number is not recomputed here, because
               * inventing a fresh score in the browser is exactly the kind of
               * made-up figure this site refuses elsewhere. */
              el.classList.toggle('is-void', hit);
              const vd = el.querySelector('.rd-v, .rdc-v');
              if (vd) {
                if (hit) {
                  if (!vd.dataset.was) vd.dataset.was = vd.textContent;
                  vd.textContent = 'Setup void · stop breached';
                  vd.className = vd.className.replace(/\b(up|warn)\b/g, '') + ' dn';
                  vd.title = STOP_VOID_WHY(v.price, s);
                } else if (vd.dataset.was) {
                  vd.textContent = vd.dataset.was;
                  delete vd.dataset.was;
                }
              }
              const sw = el.querySelector('.rd-sc em');
              if (sw && hit) sw.textContent = 'at build';
            }
          }
        });
      }
      const stamp = document.getElementById('rdLive');
      if (stamp) stamp.textContent = 'prices live';
    })();

    /* SERIES AFTER PAINT, never before it. Twenty symbols is twenty requests;
     * awaiting them would hold the whole page for a 74px line. They fill in,
     * and a card with no series says so rather than drawing a flat one. */
    const want = [...new Set([...nodes, ...ranked.slice(0, 20)].map(n => n.r.sym))];
    (async () => {
      for (const sym of want) {
        if (RADAR_SERIES[sym]) continue;
        const res = await get(`/api/signals?series=${encodeURIComponent(sym)}`);
        if (!res.ok || !res.data || !Array.isArray(res.data.points)) continue;
        RADAR_SERIES[sym] = res.data.points.slice(-40).map(p => Number(p.c)).filter(Number.isFinite);
        const sp = sparkPath(RADAR_SERIES[sym]);
        if (!sp) continue;
        /* rdc-, not rc-. The rename that fixed the namespace collision covered
         * the renderer and stopped at wireRadar — this selector sat just past
         * it, so every placeholder kept saying "no series" while the data was
         * arriving fine. A rename is only done when the SELECTORS move too. */
        main.querySelectorAll(`[data-rsym="${CSS.escape(sym)}"] .rdc-nosp`).forEach(ph => {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', `rdc-sp ${sp.up ? 'up' : 'dn'}`);
          svg.setAttribute('viewBox', '0 0 74 22');
          svg.setAttribute('aria-hidden', 'true');
          svg.innerHTML = `<path class="rdc-spa" d="${sp.area}"/><path class="rdc-spl" d="${sp.d}"/>`;
          ph.replaceWith(svg);
        });
      }
    })();
  };

  /* ── DISCOVER ─────────────────────────────────────────────────────────────
   * The seven pages that used to live inside a dropdown. A menu hides what it
   * holds behind a tap and a guess; a page shows what each one is FOR, which
   * is the thing a reader needs to choose between them. Ordered by how often
   * they answer a question rather than alphabetically. */
  const DISCOVER = [
    ['/heat',    'The heatmap',   'Today, in each name’s own units',
                 'Colour is the move measured against that stock’s own average range, not in percent — so a quiet megacap having a violent day outshines a smallcap having a normal one.'],
    ['/map',     'The map',       'Every NSE name on one screen',
                 'Colour the whole market by the call, momentum, value, or what each month has historically done.'],
    ['/reads',   'Weekly reads',  'Seven companies, studied properly',
                 'One per sector, written every Saturday — what they sell, how the money works, and what would break it.'],
    ['/radar',   'Signal radar',  'The market score, and the eight names carrying it',
                 `How broad the move is across ${universeN()} names, with the full working shown.`],
    ['/screen',  'Screen',        'All names, filterable',
                 'Price, trend, quality and value for every name — plus who is buying.'],
    ['/markets', 'Markets',       'The board — 71 instruments',
                 'Each one measured against its own year, not against the others.'],
    ['/ipo',     'IPO',           'Books open now, and how last year listed',
                 'Demand, pricing and peers — plus how last year’s listings have done.'],
    ['/news',    'News',          'The wire, filtered to names you screen',
                 'Every story carries the screened companies it touches.'],
    ['/funds',   'Funds',         'SIP screen over AMFI NAV',
                 'Return against worst fall and volatility. Direct plans only.'],
  ];
  /* ── MORE ─────────────────────────────────────────────────────────────────
   * A sheet, not a route, because it is a jumping-off point rather than a
   * place to be. The pages here are reference and trust material — you visit
   * them to check something and leave. Nothing critical lives only here: the
   * floor and the brief are also linked from the pages that cite them. */
  const MORE = [
    ['Track', [
      ['/brief',       'The brief',   'The current plan, in full'],
      ['/performance', 'Performance', 'The V2 forward record'],
    ]],
    ['How this works', [
      ['/methodology', 'Methodology', 'How every number here is made'],
      ['/sources',     'Data sources', 'Where each figure comes from, and how fresh'],
    ]],
    ['Legal', [
      ['/terms',   'Terms',   ''],
      ['/privacy', 'Privacy', ''],
    ]],
  ];
  /* ── PROVENANCE, AT THE FOOT OF THE RECORD ──────────────────────────────
   *
   * These links were behind a bottom-bar button labelled "More" — a junk
   * drawer in a five-slot navigation, whose label told a reader nothing and
   * whose most-used contents (theme, density, search, freshness) are in the
   * header anyway. What was actually in there and nowhere else is provenance:
   * how the numbers are made, where they come from, and the engine floor.
   *
   * Provenance belongs with the record it qualifies, not in a drawer, so it
   * sits at the bottom of the Ledger. That is also the spec's own answer:
   * methodology and sources are Ledger, not a sixth destination.
   *
   * It is LAST on the page deliberately. Methodology must never compete with
   * the number it explains — the reader gets the record, then the evidence,
   * then how it was made, in that order. */
  const provenance = () => sec('How this record is made',
    `<div class="more">${MORE.map(([grp, items]) => `
      <div class="more-g"><h4>${esc(grp)}</h4>
        ${items.map(([href, name, sub]) => `<a class="more-i" href="${esc(href)}">
          <b>${esc(name)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}
        </a>`).join('')}</div>`).join('')}</div>`,
    null,
    'Every figure above is produced by a run that can be repeated. These say how.');


  /* ── WEEKLY READS ────────────────────────────────────────────────────────
   *
   * Akshay, 2026-09-16: seven companies out of the thousand-name screen,
   * studied properly, for the weekend — "know in & out of any company", and
   * good enough to speak from afterwards.
   *
   * This is the one surface on the site that is not about a trade. Everything
   * else answers "what should I do"; this answers "what IS this business".
   * They are different questions and the second one compounds, which is why
   * the archive matters more here than anywhere else on the site: fifty of
   * these a year is an education, and a page that only ever shows this
   * Saturday would throw away forty-nine of them.
   *
   * A STUDY IS LONG, SO IT OPENS ON DEMAND. Seven of them inline is fifteen
   * minutes of scrolling before the reader has chosen anything. The list is
   * the choice; the study is the read.
   */
  // Minimal markdown, scoped to exactly what the generator emits: headings,
  // bold, bullets, tables and paragraphs. Not a general renderer — a general
  // renderer is a security surface, and this input is written by a model.
  const mdBits = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    /* An UNMATCHED marker is left behind when a line is bolded and then
       wrapped in quotes, and it renders as literal asterisks mid-sentence.
       The prompt now forbids the construction; this makes the page robust to
       it anyway, because prose is generated and will surprise us again. */
    .replace(/\*\*/g, '')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>');

  const mdToHtml = (src) => {
    const out = [];
    let list = null, table = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeTable = () => {
      if (!table) return;
      out.push(`<div class="rd-tw"><table class="rd-t"><thead><tr>${
        table.head.map(h => `<th>${mdBits(h)}</th>`).join('')}</tr></thead><tbody>${
        table.rows.map(r => `<tr>${r.map(c => `<td>${mdBits(c)}</td>`).join('')}</tr>`).join('')
      }</tbody></table></div>`);
      table = null;
    };
    for (const raw of String(src || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const cells = line.trim().startsWith('|') && line.trim().endsWith('|')
        ? line.trim().slice(1, -1).split('|').map(c => c.trim()) : null;
      if (cells) {
        // The divider row under a header is formatting, not data.
        if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
        closeList();
        if (!table) table = { head: cells, rows: [] };
        else table.rows.push(cells);
        continue;
      }
      closeTable();
      if (!line.trim()) { closeList(); continue; }
      const h = /^(#{2,4})\s+(.*)$/.exec(line);
      if (h) { closeList(); out.push(`<h3 class="rd-h">${mdBits(h[2])}</h3>`); continue; }
      const li = /^\s*[-*]\s+(.*)$/.exec(line);
      if (li) {
        if (list !== 'ul') { closeList(); out.push('<ul class="rd-l">'); list = 'ul'; }
        out.push(`<li>${mdBits(li[1])}</li>`); continue;
      }
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ol) {
        if (list !== 'ol') { closeList(); out.push('<ol class="rd-l">'); list = 'ol'; }
        out.push(`<li>${mdBits(ol[1])}</li>`); continue;
      }
      closeList();
      out.push(`<p>${mdBits(line)}</p>`);
    }
    closeList(); closeTable();
    return out.join('');
  };

  let READS_WEEK = null;      // which edition the reader is looking at

  R['/reads'] = async () => {
    const intro = 'Seven companies a week, one per sector, studied for what they are rather than '
                + 'what they might do next. Five to seven minutes each.';
    paint(head('Weekly reads', intro, 'Weekly reads') + skel('sk-card', 3), true);
    const r = await get('/weekly_reads.json');
    let out = head('Weekly reads', intro, 'Weekly reads');
    if (!r.ok || !r.data || !r.data.ok) {
      paint(out + fail('The weekly reads', (r.data && r.data.error) || r.error
        || 'no edition has been written yet'));
      return;
    }
    noteFresh('Weekly reads', r.data.generated_at);
    const eds = r.data.editions || [];
    if (!eds.length) {
      paint(out + `<div class="empty">The first edition is written this Saturday.</div>`);
      return;
    }

    const draw = () => {
      const ed = eds.find(e => e.week === READS_WEEK) || eds[0];
      const studies = ed.studies || [];
      const mins = studies.reduce((a, s) => a + (s.read_minutes || 0), 0);
      let body = head('Weekly reads', intro, 'Weekly reads');

      body += snap([
        ['This edition', studies.length, 'companies'],
        ['Sectors', new Set(studies.map(s => s.sector)).size, 'one study each'],
        ['Reading time', mins + ' min', 'for the set'],
        ['In the archive', eds.length, eds.length === 1 ? 'edition' : 'editions'],
      ], 'Not signals. No entry, no target, no call — these exist so a name on the '
       + '<a href="/screen">screen</a> stops being a ticker.');

      if (eds.length > 1) {
        body += `<div class="sgf-bar"><label class="sgf"><span>Edition</span>
          <select data-reads-week aria-label="Choose an edition">${eds.map(e =>
            `<option value="${esc(e.week)}"${e.week === ed.week ? ' selected' : ''}>${
              esc(e.week)} · ${(e.studies || []).length} studies</option>`).join('')}</select>
          </label></div>`;
      }

      body += sec(`Saturday ${esc(ed.week)}`, studies.map(s => {
        const facts = (s.facts || []).slice(0, 4);
        return `<details class="rd-c"><summary class="rd-s">
            <span class="rd-sym"><b>${esc(s.sym)}</b><em>${esc(s.sector || '')}</em></span>
            <span class="rd-nm">${esc(s.name || '')}</span>
            <span class="rd-meta">${s.mcap_cr ? '₹' + fmtN(s.mcap_cr) + ' cr' : ''}
              ${s.read_minutes ? ` · ${s.read_minutes} min read` : ''}</span>
            <span class="xr-caret" aria-hidden="true"></span>
          </summary>
          <div class="rd-b">
            ${facts.length ? `<div class="rd-f">${facts.map(f =>
              `<span>${esc(f)}</span>`).join('')}</div>` : ''}
            <article class="rd-a">${mdToHtml(s.study)}</article>
            <p class="hint">Written from the screen's own figures for
              ${esc(s.sym)} — every number in it is checked back against them.
              ${(s.approximate_figures || []).length
                ? `${(s.approximate_figures || []).length} figure${
                    (s.approximate_figures || []).length === 1 ? ' is' : 's are'} rounded or
                   derived rather than quoted directly.` : ''}
              <a href="/stock/${encodeURIComponent(s.sym)}">${esc(s.sym)} on the screen →</a></p>
          </div>
        </details>`;
      }).join(''), `${studies.length} studies`, null, { lead: true });

      body += `<p class="hint">A new set is written every Saturday, and no company comes back inside
        eight weeks — so this builds into a library rather than going round in circles. There are
        no entries, stops or targets here on purpose: understanding a business and trading it are
        two different jobs.</p>`;

      paint(body);
      const sel = main.querySelector('select[data-reads-week]');
      if (sel) sel.addEventListener('change', () => { READS_WEEK = sel.value; draw(); });
    };
    draw();
  };

  /* ══ THE MAP — every NSE name on one screen ═══════════════════════════════
   *
   * Akshay: "a world map = NSE scrips & each thing can be seen — verdict,
   * bible summary, action plan, seasonality — take unique ideas from
   * tradingview, tickertape/screener.in, investtech.com."
   *
   * WHAT MAKES THIS DIFFERENT FROM THE SCREEN, which already lists the same
   * 989 names: the screen is a TABLE, and a table answers "tell me about this
   * name". A map answers "what does the whole market look like right now" —
   * you see 989 cells at once and the colour IS the answer, before you have
   * read a single label. Heatmaps elsewhere colour by one day's move; this
   * colours by whichever dimension the reader picks, including two the
   * screen has never carried.
   *
   * THE DIMENSION NOBODY ELSE PUBLISHES IS SEASONALITY. Investtech built a
   * business on it and no Indian site does it properly: whether a name has a
   * calendar month it has repeatedly risen or fallen in, over eleven years,
   * with the hit rate printed beside the median so a single outlier year
   * cannot masquerade as a pattern. 626 of 989 names clear the eight-year
   * floor; the rest are drawn grey and say why.
   *
   * IT IS LOADED ON DEMAND. The seasonality feed is 512 KB and only this
   * surface needs it, so it is fetched when the map opens rather than on
   * every route like the screen was.
   */
  let SEAS = null;
  const seasonality = async () => {
    if (SEAS) return SEAS;
    const r = await get('/seasonality.json');
    SEAS = (r.ok && r.data && r.data.ok) ? r.data : { stocks: {}, ok: false };
    return SEAS;
  };

  const MAP_DIMS = {
    verdict: { label: 'The call',
      help: 'The screen’s own verdict on each name.',
      of: (r) => ({ BUY: 92, WAIT: 55, WATCH: 45, AVOID: 8 })[String((r.vd && r.vd.c) || '').toUpperCase()],
      fmt: (r) => (r.vd && r.vd.c) ? verdictWord(String(r.vd.c).toUpperCase()) : '—' },
    momentum: { label: 'Momentum',
      help: 'Six-month return, scaled across the universe.',
      of: (r) => { const v = lvl(r.r6m); return v == null ? null : Math.max(0, Math.min(100, 50 + v * 1.2)); },
      fmt: (r) => pct(r.r6m) },
    value: { label: 'Value',
      help: 'The screen’s value score — cheap is bright.',
      of: (r) => lvl(r.v), fmt: (r) => lvl(r.v) == null ? '—' : Math.round(lvl(r.v)) },
    quality: { label: 'Quality',
      help: 'Return on capital, margins and balance sheet.',
      of: (r) => lvl(r.q), fmt: (r) => lvl(r.q) == null ? '—' : Math.round(lvl(r.q)) },
    year: { label: 'Where in its year',
      help: 'Position between the 52-week low and high.',
      of: (r) => { const p = lvl(r.price), lo = lvl(r.low52), hi = lvl(r.high52);
        return (p == null || lo == null || hi == null || hi <= lo) ? null : (p - lo) / (hi - lo) * 100; },
      fmt: (r) => { const p = lvl(r.price), lo = lvl(r.low52), hi = lvl(r.high52);
        return (p == null || lo == null || hi == null || hi <= lo) ? '—' : Math.round((p - lo) / (hi - lo) * 100) + '%'; } },
    season: { label: 'This month, historically',
      help: 'How often this name has risen in the current calendar month, over eleven years. '
          + 'Historical, not predictive — and grey means it has no decade to judge by.',
      of: (r) => { const d = SEAS && SEAS.stocks && SEAS.stocks[r.sym];
        const m = d && d.m && d.m[new Date().getMonth()];
        return m ? m[0] : null; },
      fmt: (r) => { const d = SEAS && SEAS.stocks && SEAS.stocks[r.sym];
        const m = d && d.m && d.m[new Date().getMonth()];
        return m ? m[0] + '%' : 'no record'; } },
  };

  let MAP_DIM = 'verdict', MAP_SECTOR = 'all';

  /* The colour ramp. Five steps rather than a continuous gradient, because a
     reader is comparing cells to each other and to a legend, not reading an
     absolute value off a colour — and five is the most anyone can hold. */
  const mapClass = (v) => v == null ? 'mc-na'
    : v >= 75 ? 'mc-5' : v >= 58 ? 'mc-4' : v >= 42 ? 'mc-3' : v >= 25 ? 'mc-2' : 'mc-1';

  /* ══ THE LIVE HEATMAP ═════════════════════════════════════════════════════
   *
   * Akshay: "a smart AI-level live heat map, unique, colour changing, with
   * additional values on the tiles like volume or news — make it unique, which
   * no one has ever built."
   *
   * ────────────────────────────────────────────────────────────────────────
   * WHY EVERY OTHER HEATMAP IS THE SAME HEATMAP
   * ────────────────────────────────────────────────────────────────────────
   * Finviz, TradingView, every terminal: tile SIZE is market cap and tile
   * COLOUR is percentage change. Two channels, and the second one is broken in
   * a way nobody fixes — a raw percentage is not comparable across names. A
   * 2% day in HDFCBANK, which typically moves 0.9%, is a violent session. A 2%
   * day in a smallcap that routinely swings 5% is a quiet one. Colouring both
   * the same green teaches the eye to look at exactly the wrong tiles, which
   * is why every heatmap is a wall of dramatic smallcaps and dead megacaps.
   *
   * ────────────────────────────────────────────────────────────────────────
   * FIVE CHANNELS ON ONE TILE. THIS IS THE PART THAT DOES NOT EXIST ELSEWHERE
   * ────────────────────────────────────────────────────────────────────────
   *  1. HUE — direction. Up or down, live.
   *
   *  2. INTENSITY — THE MOVE IN THE STOCK'S OWN UNITS. |change| divided by
   *     that name's average true range. A tile only saturates when the move is
   *     large FOR THAT STOCK. This is the axis nobody ships, and it is the
   *     whole point of the page: it makes a 1.4% move in a quiet megacap burn
   *     brighter than a 3% move in something that does that every Tuesday.
   *
   *  3. BORDER — THE SITE'S OWN VERDICT. So a tile can be green today while
   *     the screen says AVOID, and you can SEE the disagreement rather than
   *     having to remember it. A heatmap that only knows today has no memory;
   *     this one carries the standing call underneath the move.
   *
   *  4. A DOT — this name is in today's wire. Movement with a reason attached
   *     is a different object to movement without one.
   *
   *  5. SIZE — market cap, the one convention worth keeping.
   *
   * ────────────────────────────────────────────────────────────────────────
   * WHAT IT REFUSES TO DO
   * ────────────────────────────────────────────────────────────────────────
   * IT DOES NOT DRAW A TILE IT CANNOT MARK. The live board carries prices for
   * the names this site has published a signal on — that is what is genuinely
   * live, and it is what is drawn. Filling the grid out to 989 names with
   * last night's closes, coloured as though they were current, is the single
   * dishonesty this whole estate exists to avoid: a stale number wearing a
   * live badge. The count is stated on the page.
   *
   * IT DOES NOT SATURATE A TILE IT CANNOT SCALE. A name with no ATR on its row
   * gets the flat step and is hatched, because an unscaled move rendered at
   * full intensity would be the loudest tile on the screen for no reason.
   */
  const HEAT_MS = 60000;

  /* ── THE ARITHMETIC AND THE TILE LIVE IN heatcore.js ─────────────────────
   * Loaded by this page and by gems.askakshay.com, which is a separate bundle
   * sharing no runtime with it. Keeping a second copy here would mean the same
   * stock rendering as a different green on the two sites, with each page
   * internally consistent and no way to tell which was wrong. */
  const HEAT_WORDS = HEAT.WORDS;
  const heatStep = HEAT.step;
  const heatTile = HEAT.tile;
  const heatRows = (t, idx) => HEAT.rows((t && t.ledger) || {}, idx, WIRE_CACHE || []);

  const heatClock = (it) => ({ open: HEAT.isOpen(it) });

  /* Where the screen's sectors line up with a LIVE index, and only where that
     is honest. Industrials and Utilities have no Nifty sector index on the
     ticker, so they head their band with nothing rather than with a proxy.
     (This was deleted along with the block the shared core replaced, and
     /heat threw "HEAT_IDX is not defined" and rendered its error panel — the
     front page kept working, because the strip does not group by sector.) */
  const HEAT_IDX = {
    'Technology': 'Nifty IT', 'Financial Services': 'Nifty Fin Svc',
    'Healthcare': 'Nifty Pharma', 'Basic Materials': 'Nifty Metal',
    'Energy': 'Nifty Energy', 'Consumer Defensive': 'Nifty FMCG',
    'Real Estate': 'Nifty Realty', 'Consumer Cyclical': 'Nifty Auto',
  };

  /* The wire, fetched once for the dots. Its absence costs the page a channel
     and nothing else — every tile still renders. */
  let WIRE_CACHE = null;

  /* ══ THE REGIME ═══════════════════════════════════════════════════════════
   *
   * What kind of market this is, and — the part that matters — what this
   * book's own closed trades did in it.
   *
   * THE REFERENCE THIS CAME FROM ASSERTS ITS MAPPING. Calm 1.0, trending 0.7,
   * crisis 3.0, with no sample behind any of it. regime.py measures instead,
   * and this renders what it measured including when that is nothing: a cell
   * under eight closed trades prints no figure at all, and the site's actual
   * bar for believing one is thirty closed at t ≥ 2.
   *
   * THE HEADLINE IS THE HONEST NUMBER, NOT THE FLATTERING ONE. Before the
   * population was restricted to NSE equities this read +0.163R at t=2.52 and
   * looked like a discovery; 355 of those 617 trades were gold, crude and
   * currency pairs, labelled by Indian equity volatility. On the 239 trades
   * the label actually describes it reads −0.008R. That is what goes on the
   * page.
   */
  const regimeSec = (d, liveRec) => {
    const t = d && d.today;
    if (!t || !t.regime) return '';
    const cell = ((d.measured || {}).cells || {})[t.regime];
    const yr = d.last_year || {};
    const tot = Object.values(yr).reduce((a, b) => a + b, 0) || 1;
    const order = Object.entries(yr).sort((a, b) => b[1] - a[1]);
    const NAMES = d.regimes || {};

    const verdict = !cell ? `<p class="said"><b>This book has never closed a trade in this
        regime.</b> Not a judgement about it — the dated ledger starts in June and this
        market has not been in this state since. There is nothing to report and nothing is
        invented to fill the space.</p>`
      : !cell.readable ? `<p class="said">Only <b>${cell.n}</b> closed
        ${cell.n === 1 ? 'trade' : 'trades'} in this regime, which is below the
        ${(d.thresholds || {}).min_cell || 8} this page will read anything into. The figure
        exists and is deliberately not shown: a handful of trades produces a confident
        number and no evidence.</p>`
      : `<div class="rgm-n">
          <span><i>Closed here</i><b>${cell.n}</b></span>
          <span><i>Per trade</i><b class="${cell.avg_r > 0 ? 'up' : cell.avg_r < 0 ? 'dn' : ''}">${
            cell.avg_r > 0 ? '+' : ''}${cell.avg_r.toFixed(3)}R</b></span>
          <span><i>Win rate</i><b>${cell.win_rate}%</b></span>
          <span><i>t-statistic</i><b>${cell.t == null ? '—' : cell.t.toFixed(2)}</b></span>
        </div>
        ${/* A SIGNIFICANT LOSS IS NOT A BAR CLEARED. This tested Math.abs(t),
             so a t of -2.32 on -0.768R would have read "that clears the
             significance bar" — congratulating the page on losing money
             reliably. Significance and direction are two facts and the
             sentence has to carry both. */''}
        <p class="said">${(cell.t || 0) >= 2
          ? `<b>That clears the significance bar</b>, on ${cell.n} trades — the only cell on
             this page that does.`
          : (cell.t || 0) <= -2
          ? `<b>Significantly negative.</b> A t of ${cell.t.toFixed(2)} over ${cell.n} trades
             says the losses are not bad luck. That is a harder result than "no edge" and it
             is the one this book has in this market.`
          : `<b>Not significant.</b> A t of ${cell.t == null ? '—' : cell.t.toFixed(2)} over
             ${cell.n} trades is indistinguishable from chance, which is the honest reading
             of this book in this market and not a placeholder for a better one.`}</p>`;

    /* ── TWO CLOCKS, NOT TWO POPULATIONS ──────────────────────────────────
     *
     * The record above this panel is computed in the browser from the live
     * ledger. This panel is a SNAPSHOT: regime.py writes regime.json on a
     * schedule, because labelling every past session by trend and trailing
     * volatility is not work a page can do on load.
     *
     * Since 2026-09-19 both use the identical population rule, so they agree
     * the moment they are computed together — verified at 11 closed, 9.1%,
     * -0.723R from two different stores in two different languages. What they
     * cannot do is agree CONTINUOUSLY: two KEEL trades closed at -1R in the
     * two hours after one particular snapshot, and the page went straight back
     * to showing 13 closed at 7.7% above 11 closed at 9.1% — which is exactly
     * the pair of numbers that started this, with the cause moved rather than
     * removed.
     *
     * A reader cannot be expected to infer a stale timestamp from a figure. So
     * the panel says when it was measured, and when the live count has since
     * moved it says that too, with both numbers. The gap is a fact about the
     * clock and it is printed as one. */
    const liveN = liveRec && Number.isFinite(Number(liveRec.trades)) ? Number(liveRec.trades) : null;
    /* The SNAPSHOT'S WHOLE POPULATION, summed across every regime cell — not
       `cell.n`, which is only the trades that fall in TODAY'S regime. The two
       are equal today because every closed trade since launch happens to sit
       in calm_range, and comparing the record's all-regime total against one
       cell would start lying the moment that stops being true. */
    const snapN = (() => {
      const cells = (d.measured || {}).cells;
      if (!cells) return null;
      const tot = Object.values(cells)
        .reduce((a, c) => a + (Number.isFinite(Number(c && c.n)) ? Number(c.n) : 0), 0);
      return tot || null;
    })();
    /* ageHours, not Date.parse: a stamp with no offset parses as LOCAL time,
       which is the bug that once added 8 hours to every feed age on this site
       in MYT. regime.json carries +00:00, and the helper handles both. */
    /* The field is `generated_at`. Written as `computed_at` first, which is
       falsy and silently degraded the sentence to "at the last run" — a stamp
       that reads as deliberate vagueness rather than as a missing field. */
    const stampAge = d.generated_at ? ageWord(ageHours(d.generated_at)) : null;
    /* ── ONE LINE, NOT A PARAGRAPH ────────────────────────────────────────
     * This said the same thing three times: that the panel is a snapshot, that
     * the record is live, and why the labels are rebuilt on a schedule. The
     * reader needs the first two and can be told the third if they ask. Four
     * consecutive paragraphs of justification under four numbers is the shape
     * that makes a page feel defensive rather than measured. */
    const drift = (liveN != null && snapN != null && liveN !== snapN)
      ? `<p class="hint">Measured ${stampAge ? esc(stampAge) : 'at the last run'}, on
          <b>${snapN}</b> closed. The record above reads <b>${liveN}</b> —
          ${liveN > snapN ? `${liveN - snapN} more ${liveN - snapN === 1 ? 'has' : 'have'} closed since`
                          : `this panel is the older count`}.
          Same engines, same rule, <a href="/methodology">different clock</a>.</p>`
      : (stampAge && snapN ? `<p class="hint">Measured ${esc(stampAge)}, on ${snapN} closed
          ${snapN === 1 ? 'trade' : 'trades'} — the same engines and the same rule the record
          above uses.</p>` : '');
    /* `stampAge && snapN`, not `stampAge` alone. With an empty or broken feed
       snapN is null and this read "Measured 2h old, on the closed trades",
       printed directly under a verdict that had just said this book has never
       closed a trade in this regime. A sentence with no number in it is not
       worth the line. */

    return sec('What kind of market this is', `
      <div class="rgm">
        <div class="rgm-h">
          <span class="rgm-k">${esc(t.t || t.regime)}</span>
          <span class="rgm-d">day ${d.run_days} of it</span>
        </div>
        <p class="rgm-w">${esc(t.d || '')}</p>
        <div class="rgm-n">
          <span><i>Volatility</i><b>${t.vol_ann_pct == null ? '—' : t.vol_ann_pct + '%'}</b>
            <em>${t.vol_pctile == null ? '' : Math.round(t.vol_pctile) + 'th percentile of its own two years'}</em></span>
          <span><i>Off the year's high</i><b>${t.drawdown_pct == null ? '—' : t.drawdown_pct.toFixed(1) + '%'}</b></span>
          <span><i>Above its 200-day</i><b>${t.above_200dma == null ? '—' : t.above_200dma ? 'Yes' : 'No'}</b></span>
        </div>
      </div>
      <h3 class="sub">What this book has done in it</h3>
      ${verdict}
      ${drift}
      ${/* `.inds/.ind-r`, not `.rank/.rank-r`: the rank row is two columns and
           these are three — name, figure, working — so the engine name and its
           R multiple overlapped. The company page's indicator grid already
           solves this exact shape. */
        (cell && cell.readable && cell.engines || []).filter(e => e.readable).length
        ? `<div class="inds">${cell.engines.filter(e => e.readable).map(e => `<div class="ind-r">
            <span class="ind-k">${esc(engName(e.engine))}</span>
            <span class="ind-v ${e.avg_r > 0 ? 'up' : e.avg_r < 0 ? 'dn' : ''}">${
              e.avg_r > 0 ? '+' : ''}${e.avg_r.toFixed(3)}R</span>
            <span class="ind-w">${e.n} closed · ${e.win_rate}% won · t ${
              e.t == null ? '—' : e.t.toFixed(2)}${e.trusted
                ? ' · <b>clears the bar</b>' : ''}${e.retired
                ? ` · <b class="rgm-off">${esc(e.retired)}</b>` : ''}</span></div>`).join('')}</div>
          ${(cell.engines || []).some(e => e.readable && e.retired && e.avg_r > 0)
            ? `<p class="said">The engine with the best record here is <b>switched off</b>.
               That is shown rather than tidied away: an earlier version of this table
               dropped retired engines and, in doing so, hid the only one that made money
               while leaving three that lost it — which is survivorship bias pointed
               backwards. Whether it should be switched back on is a question the numbers
               raise and do not answer: it cleared the significance bar on
               <b>seventeen</b> trades, and this site's own rule is thirty.</p>` : ''}`
        : ''}
      ${/* ── THE ONE THING THE LAUNCH FILTER CANNOT SHOW ────────────────────
           * Akshay asked for both: count only this site's record, AND keep
           * GUST's 17 closed at +1.472R. Those cannot be one number — those 17
           * trades are from June and July, before this site's record began, so
           * the launch filter is exactly what removes them.
           *
           * They are two different claims and both are true, so both are
           * printed and labelled. The cell above is what THIS SITE has done.
           * The line below is the measured record the ENGINE was brought back
           * on, which is a fact about the engine and not a figure this site
           * takes credit for. Collapsing them into one average is how the
           * +0.163R that started this whole thread happened. */''}
      ${/* SHORTENED, NOT DROPPED. The point survives — GUST's record is real,
           it predates this site, and the two are never added — but it was
           four sentences to make it, directly under three other paragraphs of
           reasoning. The engine floor carries the full basis. */''}
      <p class="hint">GUST's <b>+1.472R over 17 closed</b> (t=3.69) is not in the figure
        above: those trades predate ${esc(LAUNCH)}.
        <a href="/engines">The engine's basis</a>, not this site's record.</p>

      <h3 class="sub">The last year, by regime</h3>
      <div class="rgm-bar" role="img" aria-label="${order.map(([k, n]) =>
        `${(NAMES[k] || {}).t || k} ${Math.round(n / tot * 100)}%`).join(', ')}">
        ${order.map(([k, n]) => `<span class="rgm-s rgm-${esc(k)}${k === t.regime ? ' is-now' : ''}"
          style="width:${(n / tot * 100).toFixed(1)}%" title="${esc((NAMES[k] || {}).t || k)}: ${n} sessions"></span>`).join('')}
      </div>
      <div class="rgm-key">${order.map(([k, n]) => `<span><i class="rgm-${esc(k)}"></i>${
        esc((NAMES[k] || {}).t || k)} <b>${Math.round(n / tot * 100)}%</b></span>`).join('')}</div>
      ${/* THE METHOD GOES BEHIND A FOLD, AND THE FOLD SAYS WHAT IS IN IT.
           This was the fourth consecutive paragraph of reasoning in one
           section. It is all true and none of it is what a reader came for —
           they came for the regime and what the book did in it. A reader who
           wants to know how the label is derived will open a summary that
           says so; one who does not is no longer reading past four
           justifications to reach the chart. */''}
      ${foldBody('How this label is derived', `
        <p class="hint">Trend and trailing realised volatility only — the two things
          computable for every past session. Breadth is not an input: it has no history, and
          a regime that cannot be backfilled cannot be measured against the ledger. Every
          window is trailing, so a label cannot change when later prices arrive.
          <b>Only NSE equity trades are counted</b> — ${(d.measured || {}).excluded_non_nse || 0}
          closed trades are COMEX commodities or FX pairs, which an Indian equity regime says
          nothing about.</p>`)}`,
      `day ${d.run_days}`);
  };

  /* ── THE STRIP THAT SITS BELOW THE HERO ──────────────────────────────────
   *
   * Akshay asked for a live board "below the hero" and I built it as its own
   * route, reachable only through Discover — two clicks from a page nothing
   * linked it from. It was deployed and green and, from the front page, it did
   * not exist. Shipping something where nobody walks is the same as not
   * shipping it.
   *
   * The strip is not the page. Twelve sector bands is a thing you go and
   * study; what belongs above the fold is the handful of names having a day
   * that is unusual FOR THEM, ranked by exactly that, with the door to the
   * rest of it. */
  const heatStrip = (t, idx, n = 24) => {
    const rows = heatRows(t, idx);
    if (!rows.length) return '';
    const india = ((t.segments || []).find(x => x.key === 'india') || {}).items || [];
    const open = HEAT.isOpen(india.find(x => x.name === 'Nifty 50') || india[0]);
    const big = rows.filter(x => x.h && x.h.sig != null)
      .sort((a, b) => b.h.sig - a.h.sig).slice(0, n);
    if (!big.length) return '';
    const up = rows.filter(x => x.change_pct > 0).length;
    const notable = rows.filter(x => x.h && x.h.k >= 3).length;
    return sec('Moving, in their own units', `
      <div class="ht-bar ht-bar-s">
        <span class="ht-live ${open ? 'is-open' : 'is-shut'}"><i></i>${
          open ? 'Live' : 'Market closed'}</span>
        <span class="ht-meta"><b>${up}</b> of ${rows.length} up ·
          <b>${notable}</b> having a genuinely unusual day for themselves</span>
        <a class="ht-more" href="/heat">All ${rows.length}, by sector →</a>
      </div>
      <div class="hgrid hgrid-s">${big.map(heatTile).join('')}</div>
      <p class="hint">Brightness is the move measured against each name's <b>own</b> average
        daily range, not in percent — so a quiet large cap having a violent day outshines a
        smallcap having an ordinary one. The outline is the screen's standing call, and a dot
        means the name is in today's wire.
        <a href="/heat">The full heatmap →</a></p>`,
      null, null, null);
  };

  const heatHtml = (t, idx) => {
    const led = Object.entries((t && t.ledger) || {})
      .map(([sym, v]) => ({ sym, ...v }))
      .filter(x => sn(x.change_pct) != null);
    if (!led.length) {
      return fail('The heatmap', 'the live board carried no marks to draw');
    }
    const india = ((t.segments || []).find(x => x.key === 'india') || {}).items || [];
    const byName = (n) => india.find(x => x.name === n);
    const clock = heatClock(byName('Nifty 50') || india[0]);

    const rows = heatRows(t, idx);

    const bySec = {};
    for (const x of rows) (bySec[x.sector] = bySec[x.sector] || []).push(x);
    const order = Object.entries(bySec).sort((a, b) => b[1].length - a[1].length);

    const up = rows.filter(x => x.change_pct > 0).length;
    const big = rows.filter(x => x.h && x.h.k >= 3).length;
    const newsN = rows.filter(x => x.news).length;
    const dis = rows.filter(x => {
      const c = String((x.r.vd || {}).c || '').toUpperCase();
      return (c === 'AVOID' && x.change_pct > 0) || (c === 'BUY' && x.change_pct < 0);
    }).length;

    const tile = heatTile;

    const band = ([name, items]) => {
      const ix = byName(HEAT_IDX[name] || '');
      items.sort((a, b) => (b.h ? b.h.k : 0) - (a.h ? a.h.k : 0)
                        || Math.abs(b.change_pct) - Math.abs(a.change_pct));
      const secUp = items.filter(x => x.change_pct > 0).length;
      return `<section class="hband">
        <div class="hb-h">
          <h3>${esc(name)}</h3>
          <span class="hb-n">${secUp}/${items.length} up</span>
          ${ix ? `<span class="hb-i">${esc(ix.name)}
            <b class="${dir(ix.change_pct)}">${pct(ix.change_pct)}</b></span>`
               : `<span class="hb-i hb-none">no live sector index</span>`}
        </div>
        <div class="hgrid">${items.map(tile).join('')}</div>
      </section>`;
    };

    return `<div class="ht-bar">
        <span class="ht-live ${clock.open ? 'is-open' : 'is-shut'}"><i></i>${
          clock.open ? 'Live' : 'Market closed'}</span>
        <span class="ht-meta"><b>${rows.length}</b> names marked live · <b>${up}</b> up ·
          <b>${big}</b> moving more than 1.25× their own range ·
          <b>${newsN}</b> in today's wire${dis ? ` · <b>${dis}</b> moving against the screen's call` : ''}</span>
        <span class="ht-at">${t.fetched_at
          ? 'as of ' + esc(new Date(t.fetched_at).toLocaleTimeString('en-IN',
              { hour: '2-digit', minute: '2-digit' })) : ''}</span>
      </div>
      ${order.map(band).join('')}`;
  };

  const heatLegend = () => sec('How to read it', `
    <div class="hleg">
      <div class="hl-i"><span class="hl-sw"><i class="ht ht-u4"></i><i class="ht ht-u2"></i>
        <i class="ht ht-f0"></i><i class="ht ht-d2"></i><i class="ht ht-d4"></i></span>
        <div><b>Brightness is the move in the stock's own units</b>, not in percent.
          A tile only burns when the move is large <i>for that name</i> — its change divided
          by its own average daily range. This is the whole reason the page exists: on every
          other heatmap a 2% day looks identical in a megacap that never moves and in a
          smallcap that does it weekly, and only one of those is news.
          <br><span class="hl-r">Palest, under a quarter of its range: barely moved.
          Then an ordinary drift, then a real move, then a tile that has travelled its
          <b>whole typical daily range in one direction</b>, and brightest of all a day of
          more than one and a half.</span></div></div>
      <div class="hl-i"><span class="hl-sw"><i class="ht ht-f0 ht-vbuy"></i>
        <i class="ht ht-f0 ht-vavoid"></i></span>
        <div><b>The outline is the screen's standing call</b> — green for buy, red for avoid.
          A green tile in a red outline is a name going up that this site does not rate, and
          that disagreement is the most interesting thing on the page.</div></div>
      <div class="hl-i"><span class="hl-sw"><i class="ht ht-f0"><b class="ht-n"></b></i></span>
        <div><b>A dot means the name is in today's wire.</b> A move with a reason attached is
          a different object to a move without one.</div></div>
      <div class="hl-i"><span class="hl-sw"><i class="ht ht-f0 ht-s3"></i><i class="ht ht-f0 ht-s1"></i></span>
        <div><b>Size is market capitalisation</b>, the one convention worth keeping.
          A hatched tile has no average range on its row, so its move could not be scaled and
          is deliberately shown flat rather than guessed at.</div></div>
    </div>
    <p class="hint">The 200 most-traded names on the screen are drawn, each with a quote taken
      when the page loaded. Filling the grid out to the full screened universe with last night's
      closes — coloured as if they were current — is the one thing this estate refuses to do. The
      number drawn is stated above.</p>`);

  R['/heat'] = async () => {
    paint(head('Heatmap', 'The market coloured by how far each name has moved in its own '
      + 'terms, not in percent — with the screen’s standing call around every tile.',
      'Live') + skel('sk-card', 2), true);

    if (!SCREEN || SCREEN_LITE) {
      const r0 = noteLadder(await get(FULL_URL));
      if (r0.ok) setScreen((r0.data.rows || []).filter(x => x && x.sym), false);
    }
    const idx = {};
    for (const r of (SCREEN || [])) idx[r.sym] = r;

    if (WIRE_CACHE == null) {
      /* THE LIVE WIRE, NOT LAST NIGHT'S BUILD. news.json is written by the
         nightly job, so a dot could only ever mark a name that was in
         YESTERDAY'S news — on the day this was found it held 18 stories and
         not one of them mentioned Tata, while the live wire held 60 and led
         with the story that moved two Tata names 5-6%. The channel meant to
         explain a move was reading a file written before the move happened.
         /api/wire returns { stories: [...] }, not a bare array. */
      const w = await get('/api/wire');
      WIRE_CACHE = (w.ok && w.data && Array.isArray(w.data.stories)) ? w.data.stories : [];
    }

    const shell = (body) => head('Heatmap',
      'The most-traded names on the screen, coloured by how far each has moved in its own '
      + 'terms rather than in percent, and outlined by the screen’s research tag.',
      'Live') + `<div id="heatHost">${body}</div>` + heatLegend();

    /* SIGNAL V2: the marks are the 200 most-traded screen names from the
       edge-cached /api/heat shard, not the retired V1 ledger's symbols. */
    const withMarks = async (t) => {
      if (!t.ok || !t.data) return t;
      const h = await get('/api/heat?part=0').catch(() => ({ ok: false }));
      return { ...t, data: { ...t.data, ledger: (h.ok && h.data && h.data.quotes) || {} } };
    };
    const draw = async () => {
      const t = await withMarks(await get('/api/ticker'));
      const host = document.getElementById('heatHost');
      if (!t.ok || !t.data) {
        if (host && !host.dataset.ok) host.innerHTML = fail('The heatmap', t.error || 'the live board did not answer');
        return null;
      }
      if (!host) { paint(shell(heatHtml(t.data, idx))); return t.data; }
      host.dataset.ok = '1';
      host.innerHTML = heatHtml(t.data, idx);
      return t.data;
    };

    const first = await withMarks(await get('/api/ticker'));
    paint(shell(first.ok && first.data
      ? heatHtml(first.data, idx)
      : fail('The heatmap', first.error || 'the live board did not answer')));

    /* One delegated listener: any tile opens that company's card, which is
       where the chart, the plan and the eleven-year record already live. */
    const host = document.getElementById('heatHost');
    if (host) {
      host.dataset.ok = '1';
      host.addEventListener('click', (e) => {
        const b = e.target.closest('[data-hsym]');
        if (b) go('/stock/' + encodeURIComponent(b.dataset.hsym));
      });
    }

    /* SAME DISCIPLINE AS THE LIVE BOARD: a minute while it trades, a slow beat
       when it does not — never a dead timer, or a page left open overnight
       never sees the next session — and nothing at all in a hidden tab.
       Cleared on teardown so leaving the route stops the polling. */
    let timer = null, beat = 0;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } beat = 0; };
    const at = (ms) => { if (beat === ms && timer) return; stop(); beat = ms;
      timer = setInterval(tick, ms); };
    async function tick() {
      if (document.hidden) return;
      const d = await draw();
      const ii = d && ((d.segments || []).find(x => x.key === 'india') || {}).items;
      at(ii && ii.length && heatClock(ii[0]).open ? HEAT_MS : HEAT_MS * 15);
    }
    if (!document.hidden) at(HEAT_MS);
    const onVis = () => { if (document.hidden) stop(); else tick(); };
    document.addEventListener('visibilitychange', onVis);
    main.addEventListener('sig:teardown', () => {
      stop(); document.removeEventListener('visibilitychange', onVis);
    }, { once: true });
  };

  R['/map'] = async () => {
    const intro = 'Every name on the screen, on one page. Colour it by the call, by momentum, '
                + 'by value, or by what each month has historically done.';
    paint(head('The map', intro, 'The map') + skel('sk-card', 3), true);

    const [sc] = await Promise.all([
      SCREEN ? Promise.resolve({ ok: false }) : getScreen(false).then(g => (LITE_GOT = g.lite, g.r)),
      seasonality(),
    ]);
    if (sc && sc.ok && sc.data) {
      noteScreenMeta(sc.data);
      if (!SCREEN) setScreen((sc.data.rows || []).filter(x => x && x.sym), LITE_GOT);
    }
    const rows = (SCREEN || []).filter(r => r && r.sym);
    if (!rows.length) { paint(head('The map', intro, 'The map') + fail('The map', 'the screen did not load')); return; }

    const sectors = [...new Set(rows.map(r => String(r.sector || '').trim()).filter(Boolean))].sort();

    const draw = () => {
      const D = MAP_DIMS[MAP_DIM];
      const view = MAP_SECTOR === 'all' ? rows
        : rows.filter(r => String(r.sector || '').trim() === MAP_SECTOR);
      /* Ordered by the dimension being shown, so the map reads as a gradient
         rather than as alphabetical noise — the shape of the distribution is
         itself information. Unknowns sink. */
      const scored = view.map(r => ({ r, v: D.of(r) }));
      scored.sort((a, b) => (b.v == null ? -1 : b.v) - (a.v == null ? -1 : a.v));
      const known = scored.filter(x => x.v != null).length;

      let body = head('The map', intro, 'The map');
      body += snap([
        ['Names', view.length, MAP_SECTOR === 'all' ? 'the whole screen' : esc(MAP_SECTOR)],
        ['Measured', known, `on ${esc(D.label.toLowerCase())}`],
        ['Not measured', view.length - known, 'no data for this view', (view.length - known) ? 'dn' : ''],
        ['Sectors', sectors.length, 'on the screen'],
      ], esc(D.help));

      body += `<div class="mapbar">
        <div class="chips" role="group" aria-label="Colour by">
          ${Object.entries(MAP_DIMS).map(([k, d]) =>
            `<button type="button" class="chip${k === MAP_DIM ? ' is-on' : ''}" data-mapd="${k}">${esc(d.label)}</button>`).join('')}
        </div>
        <label class="sgf"><span>Sector</span>
          <select data-maps aria-label="Filter by sector">
            <option value="all">All sectors</option>
            ${sectors.map(x => `<option value="${esc(x)}"${x === MAP_SECTOR ? ' selected' : ''}>${esc(x)}</option>`).join('')}
          </select></label>
        <div class="maplg" aria-hidden="true">
          <span>low</span>${['mc-1','mc-2','mc-3','mc-4','mc-5'].map(c => `<i class="${c}"></i>`).join('')}<span>high</span>
          <i class="mc-na"></i><span>no data</span>
        </div>
      </div>`;

      body += `<div class="mapg">${scored.map(({ r, v }) => `
        <button type="button" class="mcell ${mapClass(v)}" data-mapsym="${esc(r.sym)}"
          title="${esc(r.name || r.sym)} · ${esc(D.label)}: ${esc(String(D.fmt(r)))}">
          <b>${esc(bareSym(r.sym))}</b><i>${esc(String(D.fmt(r)))}</i>
        </button>`).join('')}</div>`;

      body += `<p class="hint">Every cell is a name; the colour is
        <b>${esc(D.label.toLowerCase())}</b>. Tap one to open its full page — the call, the
        levels, the fundamentals and its month-by-month record. Grey means this site has no
        measurement for that name on this view, which is a different thing from a low score.</p>`;

      paint(body);
      main.querySelectorAll('[data-mapd]').forEach(b => b.addEventListener('click', () => {
        MAP_DIM = b.dataset.mapd; draw();
      }));
      const sel = main.querySelector('[data-maps]');
      if (sel) sel.addEventListener('change', () => { MAP_SECTOR = sel.value; draw(); });
      main.querySelectorAll('[data-mapsym]').forEach(b => b.addEventListener('click', () => {
        go('/stock/' + encodeURIComponent(b.dataset.mapsym));
      }));
    };
    draw();
  };

  R['/discover'] = async () => {
    /* COUNTED, NOT SPELLED OUT — the same rule the ticker lead already follows.
     * This read "Seven ways" over a list of eleven: four doors were added to
     * DISCOVER and the sentence above them was not, so the page contradicted
     * itself in the space of one screen. A number typed beside a list is a
     * claim that the list will never grow, and this one already had. */
    paint(head('All tools', `${DISCOVER.length} ways into the same ${universeN()} names. Each answers a different question.`,
               'Discover') +
      `<div class="disc">${DISCOVER.map(([href, name, sub, why]) => `
        <a class="disc-c" href="${esc(href)}">
          <span class="disc-n">${esc(name)}</span>
          <span class="disc-s">${esc(sub)}</span>
          <span class="disc-w">${esc(why)}</span>
          <span class="disc-go" aria-hidden="true">→</span>
        </a>`).join('')}</div>`);
  };

  R['/methodology'] = async () => {
    paint(prose('How Signal V2 works', 'How a plan is made, followed and counted.',
      'One end-of-day process, one plan per stock, and a record that counts every plan it publishes.', `
      <h3>What a plan is</h3>
      <p>A plan is a conditional paper instruction for the <b>next session</b>, published after the NSE close.
        It names an entry range and a cap, a stop, three targets, and how much of the position each
        target sells (40%, 35% and 25% of the original quantity). It is valid for a stated number of
        sessions. It is not a forecast, and no probability is attached to it.</p>

      <h3>How it is made</h3>
      <p>Liquid NSE equities are scanned after each completed session by one private end-of-day process.
        A setup must first qualify on the completed daily bar. The plan is then built risk-first. The stop
        goes below the structure that would prove the setup wrong, and it is never pulled closer to meet
        a percentage cap. The targets come from levels already on the chart, and they are never stretched
        to reach a reward-to-risk floor. If three defensible targets do not exist, or the risk is too large,
        no plan is published. The rules and thresholds are kept private. That does not make them
        impossible to infer from the published plans over time.</p>
      <p>Every stock has at most one plan, and every page shows the same one. Today, Opportunities, the plan
        page, the stock card and Vision all read the same published file.</p>

      <h3>How a plan is followed</h3>
      <ul>
        <li><b>Next session only.</b> A plan made after Tuesday's close can first fill at Wednesday's open, never at the close that made it.</li>
        <li><b>Inside the range, never above the cap.</b> An open inside the range fills at the open. An open above the cap fills only if price later trades back to the cap.</li>
        <li><b>Cancelled before entry</b> if price reaches the stop first. <b>Expired</b> if it never fills in its window.</li>
        <li><b>Stop.</b> A session that trades at or below the stop exits everything. If a session opens below the stop, the exit is at that open, not at the stop. A stop does not cap a gap loss.</li>
        <li><b>Targets</b> sell their portion when touched. A target is never revised after publication. Whatever remains after the time limit is sold at the next open.</li>
      </ul>
      <p>Fills and exits are <b>simulated</b> from daily bars. Where a bar cannot show the order of events, the
        less favourable order is assumed and the plan is flagged. Costs are an assumed Indian delivery schedule:
        STT, exchange, SEBI and stamp charges, GST, DP charges and slippage. No order is placed anywhere.</p>

      <h3>How the record is counted</h3>
      <ul>
        <li>Every published plan is counted. Plans that never filled are counted as expired or cancelled and are not in any win rate.</li>
        <li>A closed trade is a win, loss or breakeven by its <b>net profit and loss after costs</b>, not by which level it touched. A target touched while the rest of the position is still open is not a completed win.</li>
        <li>R is measured against the risk fixed at entry. Mean R per trade is a diagnostic, not a portfolio return.</li>
        <li>No win rate is shown until enough trades have closed. A record with nothing closed says so; it never shows 0%.</li>
      </ul>
      <p><b>V2 forward record begins 1 October 2026. Previous model results are excluded.</b> The engines that ran
        before that date were retired. Their calls are not counted, compared or carried into V2 plans. Backtests are
        never imported into the forward record.</p>

      <h3>Strategy status</h3>
      <p>A rule's status is published beside it on Opportunities and Performance. <i>Research</i> means it has not
        shown a reliable edge and publishes nothing. <i>Shadow</i> means it is tracked privately and publishes nothing.
        <i>Forward paper</i> means it publishes paper plans. No status means a rule is proven, and none places a trade.</p>

      <h3>The screen and company research</h3>
      <p>The screen covers the liquid NSE universe that the nightly build can read (the exact count is printed on
        the screen). Its quality, growth, value and trend scores describe companies. They are research tags, not
        trade plans and not buy or sell calls. Company research is on Vision.</p>`));
  };

  R['/sources'] = async () => {
    const h = await get('/api/health');
    const p = h.ok && h.data.provider ? h.data.provider : null;
    paint(prose('Data sources', 'Where the prices come from.',
      'And, more usefully, what that does and does not entitle this site to do.', `
      ${p ? `<div class="note"><b>Live provider: ${esc(p.label)}.</b> ${esc(p.terms)}</div>` : ''}
      <h3>Quotes and price history</h3>
      <p>Index levels, equity quotes, commodity and FX prices and every daily close on this site
        come from <b>Yahoo Finance</b>'s public endpoints. Those endpoints are undocumented.
        They carry no service level, no redistribution right and no guarantee of accuracy, and
        they can change without notice. They are adequate for research read by one person. They
        are <b>not</b> a licensed market-data feed, and this site does not resell, redistribute
        or provide an API over them.</p>

      <h3>Indian exchange data</h3>
      <p>The IPO calendar and parts of the screen universe are read from NSE's public web
        endpoints. NSE licenses real-time, delayed, snapshot and historical data as separate
        commercial products. Nothing here is one of those products, and nothing here should be
        treated as exchange-authorised.</p>

      <h3>Fundamentals</h3>
      <p>Revenue, profit, margin, cash-flow and ownership figures come from company filings as
        aggregated by the screen build. Each company card names the financial year the figures
        belong to. Filings are restated; figures can move.</p>

      <h3>The plans and their record</h3>
      <p>Plans, levels, simulated fills, exits and results are this site's own records, written by one
        private end-of-day process from completed daily bars and published as one file. They are the
        only data here that is not somebody else's. Intraday OHLC, VWAP and tick data are not used.</p>

      <h3>Delay</h3>
      <p>Nothing on this site is real-time. Quotes are fetched when a page loads and refreshed
        about once a minute while it is open. Every price carries the time it was taken; the
        market board shows the exchange's own session window, so a closed market says so.</p>

      <p class="prose-note">If a source cannot be reached, the page shows that it could not be
        reached. It never carries the last value forward and never fills a gap with an estimate.</p>`));
  };

  /* ── THE DISCLAIMER, AS ITS OWN PAGE ─────────────────────────────────────
   *
   * An external audit's first blocker, and it was right: this site publishes
   * ranked, security-specific NSE candidates and carried no registration
   * statement anywhere a reader met before acting. /terms said the right
   * things and nobody reads terms.
   *
   * SEBI's Research Analyst Regulations define "research services" to include
   * buy/sell/hold recommendations, price targets, stop-loss levels and model
   * portfolios — with the trigger being CONSIDERATION. Free publication does
   * not require registration; taking a fee for it does. That is the line this
   * page states plainly, because the honest position today is on the free side
   * of it and the reader is entitled to know which side that is.
   *
   * Nothing here is legal advice and this page says so about itself. */
  R['/disclaimer'] = async () => {
    paint(prose('Disclaimer', 'What this site is, and what it is not.',
      'The short version: educational research, not advice, and not registered.', `
      <div class="note err"><b>Not registered with SEBI as a Research Analyst or an
        Investment Adviser.</b> Everything published here is market research and data,
        for education. Nothing on this site is a recommendation to buy or sell any
        security, and nothing here is personalised to your circumstances.</div>

      <h3>Why the registration line matters</h3>
      <p>SEBI's Research Analyst Regulations treat buy, sell and hold calls, price targets,
        stop-loss levels and model portfolios as <b>research services</b>. The trigger for
        registration is <b>consideration</b> — being paid. Publishing research for free does
        not require registration; charging for it does, in any form, including a paid channel,
        a subscription or a tip jar attached to the same output.</p>
      <p>This site is free, carries no paid tier, no paid channel, no affiliate link to a
        broker and no payment page. If that ever changes, registration comes first and this
        page changes with it. Until then the honest description of what you are reading is
        <b>published research output, not a service you are buying</b>.</p>

      <h3>What the numbers are</h3>
      <p>Each paper plan here states an entry range, a stop and three targets. Every plan is tracked
        to its end and kept, losses included. The record is on <a href="/performance">Performance</a>
        and the method on <a href="/methodology">the methodology page</a>. None of it is a forecast.
        Fills are simulated; a published record describes what happened, not what will.</p>

      <h3>No execution, no custody, no account</h3>
      <p>This site cannot place a trade. It holds no money, connects to no broker for
        execution, and has no view of any account you hold. Anything it describes as a
        position is <b>paper</b> unless it says otherwise.</p>

      <h3>Prices can be wrong</h3>
      <p>Market data comes from third parties over endpoints that carry no service guarantee.
        It may be delayed, stale or wrong. Check any figure against your broker or the
        exchange before you act on it. See <a href="/sources">data sources</a>.</p>

      <h3>Risk</h3>
      <p>Trading and investing carry risk, including the total loss of capital. Past results
        — every figure in the record here included — do not predict future results. This
        site's own measured expectancy is currently <b>negative</b>, and it says so on the
        front page rather than in this paragraph.</p>

      <p class="hint">This page describes how the site operates. It is not legal advice, and
        it is not a substitute for reading SEBI's own regulations at
        <a href="https://www.sebi.gov.in" rel="noopener" target="_blank">sebi.gov.in</a>.</p>
      `));
  };

  /* ── DISCLOSURES ─────────────────────────────────────────────────────────
   * Separate from the disclaimer on purpose. A disclaimer says what the site
   * is; a disclosure says what could bias it. Merging them lets the second
   * hide inside the first. */
  R['/disclosures'] = async () => {
    paint(prose('Disclosures', 'Conflicts, incentives and who pays for this.',
      'What could bias what you are reading.', `
      <h3>Who pays for this</h3>
      <p><b>Nobody.</b> There is no subscription, no paid tier, no sponsorship, no advertising,
        no affiliate arrangement with any broker, exchange, data vendor or product, and no paid
        placement of any name on any list. Nothing on this site is compensated by anyone whose
        security it mentions.</p>

      <h3>Positions</h3>
      <p>The author may hold positions in Indian listed securities in a personal capacity.
        Where a name appears on this site and is also held personally, that is a conflict,
        and the policy is to state it against the name rather than in general terms here.
        <b>No such holding is currently disclosed against any published name.</b> If you are
        reading this and a name here is one the author holds, the omission is a defect —
        <a href="mailto:ca.akshayk1@gmail.com">say so</a>.</p>

      <h3>Employment</h3>
      <p>The author works in a finance role unrelated to Indian capital markets and unrelated
        to any security this site screens. This site is a personal project, built and run
        outside that employment, and represents no employer's view.</p>

      <h3>The rules are not neutral about themselves</h3>
      <p>Every rule here was written by the author, tested by the author's code, and graded against
        conditions the author set. That is a conflict no disclosure removes. The mitigations are that the
        grading conditions are published, every plan is counted including the losses, failed tests are
        recorded, and the V2 record starts empty rather than borrowing an earlier one. See
        <a href="/methodology">how a plan is built and counted</a>.</p>

      <h3>What changes if this ever charges</h3>
      <p>Registration first, this page rewritten second, and the record re-audited third.
        See <a href="/disclaimer">the disclaimer</a>.</p>
      `));
  };

  /* ── ABOUT ───────────────────────────────────────────────────────────────
   * The audit's point: a named, credentialled author is the whole difference
   * between this and an anonymous tips channel, and it was nowhere on the site
   * except eight words in the footer. */
  R['/about'] = async () => {
    paint(prose('About', 'Who builds Signal, and what it is.',
      'A Chartered Accountant, an FP&A day job, and a paper record that counts every plan.', `
      <h3>Who</h3>
      <p><b>Akshay Kothari</b> — Chartered Accountant, working in FP&amp;A. This site is a
        personal project. It is not a firm, not a service and not a product you can buy.</p>

      <h3>What it does</h3>
      <p>Screens liquid NSE equities after each session closes. When a setup qualifies, it publishes a
        conditional paper plan for the next session, with an entry range, a stop and three targets. Every
        plan is then tracked to its end, losses included. The <a href="/methodology">methodology</a>
        explains how a plan is built and counted, and <a href="/performance">Performance</a> shows every
        result.</p>

      <h3>Signal V2</h3>
      <p>V2 forward record begins 1 October 2026. Previous model results are excluded. The earlier engines
        were retired, and none of their calls became a V2 plan. A rule that has not shown a reliable edge
        publishes nothing, so there may be days, or longer, with no plan at all. That is the system
        working as intended.</p>

      <h3>What it is not</h3>
      <p>Not registered with SEBI, not advice, not a tip service, and not something that can
        place a trade. See <a href="/disclaimer">the disclaimer</a> and
        <a href="/disclosures">the disclosures</a>.</p>

      <h3>Contact</h3>
      <p><a href="mailto:ca.akshayk1@gmail.com">ca.akshayk1@gmail.com</a> ·
        <a href="https://www.linkedin.com/in/akkothari" rel="me noopener" target="_blank">LinkedIn</a> ·
        <a href="https://askakshay.com/" rel="me noopener" target="_blank">askakshay.com</a></p>
      <p class="hint">Corrections are welcome. If a number here is wrong, it is a defect in the site — send it.</p>
      `));
  };

  R['/terms'] = async () => {
    paint(prose('Terms', 'What this is, and what it is not.',
      'Read this before acting on anything here.', `
      <div class="note err"><b>This is educational market-intelligence software. It is not
        investment advice.</b> Nothing here is a recommendation to buy or sell any security,
        and nothing here is personalised to your circumstances.</div>

      <h3>No advice, no recommendation</h3>
      <p>This site publishes conditional paper plans and what became of them. It does not
        know your income, your goals, your existing positions or your risk tolerance, and it
        does not attempt to. A plan is a published thesis with a defined invalidation level.
        Whether it is appropriate for you is a question this site cannot answer.</p>

      <h3>No guarantees</h3>
      <p>Markets carry risk, including total loss of capital. Past results — including every
        figure in the record on this site — do not predict future results. No output here is a
        prediction, a tip, or an assured return, and any figure can be wrong.</p>

      <h3>Verify independently</h3>
      <p>Prices come from a third party over undocumented endpoints and may be delayed, stale or
        wrong. Check any number against your broker or the exchange before you act on it.</p>

      <h3>No execution, no custody</h3>
      <p>This site cannot place a trade, cannot connect to a broker and never holds money. The
        position-size calculator is arithmetic on numbers you enter.</p>

      <h3>Availability</h3>
      <p>It is operated by one person on free infrastructure and may be unavailable, delayed or
        wrong at any time, without notice.</p>

      <p class="prose-note">Built by <b>Akshay Kothari</b>. Questions:
        <a href="/join" style="color:var(--accent)">get the brief</a> and reply to it.</p>`));
  };

  R['/privacy'] = async () => {
    paint(prose('Privacy', 'What this site stores, where, and why.',
      'There are no accounts. Most of what is kept stays in your own browser.', `
      <h3>No accounts</h3>
      <p>You cannot sign in. There is no profile, password or server-side session, and nothing
        on the server records which pages or stocks you looked at.</p>

      <h3>What your browser keeps (this device only)</h3>
      <p>These are kept in your browser's local storage on this device. They are never sent to
        this site's server, and clearing site data deletes them:</p>
      <ul>
        <li><b>Watchlist</b> (<code>sig:watch</code>) — the symbols you starred.</li>
        <li><b>Price alerts</b> (<code>sig:alerts</code>, <code>sig:fired</code>) — the levels you set and which ones already fired.
          They are checked only while a Signal page is open; nothing runs in the background.</li>
        <li><b>Position-size calculator</b> (<code>sig.sizer.v1</code>) — the capital and risk you last typed in.</li>
        <li><b>Display settings</b> (<code>sig:theme</code>, <code>sig:density</code>).</li>
      </ul>
      <p>For the current browsing session only (session storage, cleared when the tab closes): a cached copy of the
        public data feeds, so a failed refresh can show the last good copy; the "since your last
        visit" baseline; and a note that prevents reload loops after a new build.</p>
      <p>The watchlist page can export these to a file and import them again. That is the only way
        to move them to another device, because nothing is synced.</p>

      <h3>What the server stores</h3>
      <ul>
        <li><b>Email, only if you subscribe</b> to the morning list. It is stored with a salted hash of your IP
          address, used for rate-limiting; the raw IP is not kept. The address is used only to send
          the list. Ask for removal by replying to any email, and the record is deleted.</li>
        <li><b>Error reports.</b> If a page throws an error, the browser sends the error message, the page path,
          a stack trace and the build number. No identifier, cookie or IP address is attached.</li>
      </ul>

      <h3>Third parties</h3>
      <p>Fonts are served from this domain. The host adds Cloudflare Web Analytics to every page.
        It counts page views and load times in aggregate, without cookies or an identifier for you.
        There is no advertising, no social pixel and no session recording. Prices are fetched by
        the server from the providers named on <a href="/sources">Data sources</a>, not by your browser.</p>

      <h3>Logs</h3>
      <p>The host keeps ordinary request logs, including IP addresses, for a limited period. They
        are not used to build a profile of you.</p>

      <h3>What this page does not claim</h3>
      <p>It describes how the site works. It is not a legal opinion on which data-protection law
        applies, and no certification or registration is claimed.</p>`));
  };


  /* ══ CUMULATIVE R ══════════════════════════════════════════════════════
   * The signature performance visual: every closed signal in order, each
   * adding its own R multiple to a running total.
   *
   * IT CURRENTLY GOES DOWN. Over the closed ledger the curve peaks early and
   * ends deeply negative. That is published rather than hidden, because a site
   * whose entire argument is "here is the record including the losses" cannot
   * then decline to draw the record. The equity curve of a losing engine is
   * still the most honest chart on the page.
   *
   * Drawn from r_multiple only — the field the re-grades corrected. Rows
   * without one are skipped rather than assumed flat, and the caption says how
   * many were used out of how many closed.
   */
  const rCurve = rows => {
    const closed = rows
      .filter(isScored)
      .sort((a, b) => String(a.closed_at || a.date || '').localeCompare(String(b.closed_at || b.date || '')));
    if (closed.length < 5) return null;
    let cum = 0;
    const pts = closed.map(r => {
      cum += Number(r.r_multiple);
      return { t: String(r.closed_at || r.date || '').slice(0, 10), sym: r.symbol,
               r: Number(r.r_multiple), cum, eng: r.signal_type || '' };
    });
    const totalClosed = rows.filter(r => (r.badge || '') !== 'open' && r.badge).length;
    return { pts, used: closed.length, totalClosed, end: cum,
             peak: Math.max(...pts.map(p => p.cum)), trough: Math.min(...pts.map(p => p.cum)) };
  };

  /* Same drawing contract as the brief's chart: a stretched viewBox so it fits
   * any box without a measurement pass, non-scaling strokes, and every label in
   * HTML because stretched SVG text is unreadable. */
  const rCurveHtml = c => {
    const W = 1000, H = 300, PAD = 10;
    const lo = Math.min(0, c.trough), hi = Math.max(0, c.peak);
    const span = (hi - lo) || 1;
    const X = i => (i / Math.max(1, c.pts.length - 1)) * W;
    const Y = v => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
    const d = c.pts.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.cum).toFixed(2)).join(' ');
    const zero = Y(0).toFixed(2);
    const down = c.end < 0;
    return `<div class="rc ${down ? 'is-dn' : 'is-up'}">
      <div class="rc-h">
        <span>Cumulative R · ${c.used} closed signals</span>
        <span class="rc-end ${down ? 'dn' : 'up'}">${c.end >= 0 ? '+' : ''}${c.end.toFixed(2)}R</span>
      </div>
      <div class="rc-c" id="rcC">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs><linearGradient id="rcg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="currentColor" stop-opacity=".16"/>
            <stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
          <line class="rc-zero" x1="0" x2="${W}" y1="${zero}" y2="${zero}"/>
          <path class="rc-fill" d="${d} L${W} ${zero} L0 ${zero} Z"/>
          <path class="rc-line" d="${d}"/>
          <line class="rc-cross" id="rcX" x1="0" x2="0" y1="0" y2="${H}" style="opacity:0"/>
        </svg>
        <span class="rc-dot" id="rcDot"></span>
        <div class="rc-t" id="rcT"></div>
        <div class="rc-hit" id="rcHit" role="img"
          aria-label="Cumulative R across ${c.used} closed signals, from ${esc(c.pts[0].t)} to ${esc(c.pts[c.pts.length - 1].t)}, ending at ${c.end.toFixed(2)} R"></div>
      </div>
      <div class="rc-f">
        <span>Peak <b class="up">+${c.peak.toFixed(2)}R</b></span>
        <span>Trough <b class="dn">${c.trough.toFixed(2)}R</b></span>
        <span>First ${esc(c.pts[0].t)}</span>
        <span>Last ${esc(c.pts[c.pts.length - 1].t)}</span>
      </div>
    </div>
    <p class="sec-note"><b>One unit of R is one unit of the risk taken on that trade.</b> A signal
      stopped out is −1R. The line adds each closed signal's result in the order it closed, so its
      slope is the engine's expectancy and its shape is the order the results arrived in.
      ${c.used} of ${c.totalClosed} closed signals carry a graded R multiple; the rest are
      excluded rather than assumed flat. Open positions are not in this line at all — a position
      that has not closed has a mark, not a result.
      ${c.end < 0 ? `<b> This curve ends below zero. That is the record, and it is published for
      the same reason the winners are.</b>` : ''}
      <a href="/methodology" style="color:var(--accent)">How R is measured →</a></p>`;
  };

  /* Crosshair. Same interaction as the brief's chart so the two read as one
   * product rather than two charts that happen to share a page. */
  const wireRCurve = c => {
    const hit = document.getElementById('rcHit'), tip = document.getElementById('rcT'),
          dot = document.getElementById('rcDot'), cross = document.getElementById('rcX');
    if (!hit) return;
    const W = 1000, H = 300, PAD = 10;
    const lo = Math.min(0, c.trough), hi = Math.max(0, c.peak), span = (hi - lo) || 1;
    const read = clientX => {
      const b = hit.getBoundingClientRect();
      const k = Math.max(0, Math.min(1, (clientX - b.left) / (b.width || 1)));
      const i = Math.round(k * (c.pts.length - 1));
      const p = c.pts[i];
      if (!p) return;
      const xPct = (i / Math.max(1, c.pts.length - 1)) * 100;
      const yPct = ((PAD + (1 - (p.cum - lo) / span) * (H - PAD * 2)) / H) * 100;
      cross.setAttribute('x1', (xPct * 10).toFixed(1));
      cross.setAttribute('x2', (xPct * 10).toFixed(1));
      cross.style.opacity = '1';
      dot.style.left = xPct + '%'; dot.style.top = yPct + '%'; dot.style.opacity = '1';
      tip.innerHTML = `<i>${esc(p.t)}</i><b>${esc(p.sym)}</b> ${esc(p.eng)}<br>
        <em>this trade</em> <span class="${p.r >= 0 ? 'up' : 'dn'}">${p.r >= 0 ? '+' : ''}${p.r.toFixed(2)}R</span><br>
        <em>running</em> <span class="${p.cum >= 0 ? 'up' : 'dn'}">${p.cum >= 0 ? '+' : ''}${p.cum.toFixed(2)}R</span>`;
      tip.classList.add('on');
      tip.style.left = xPct > 60 ? 'auto' : `calc(${xPct}% + 14px)`;
      tip.style.right = xPct > 60 ? `calc(${100 - xPct}% + 14px)` : 'auto';
    };
    const clear = () => { tip.classList.remove('on'); dot.style.opacity = '0'; cross.style.opacity = '0'; };
    hit.addEventListener('pointermove', e => read(e.clientX));
    hit.addEventListener('pointerdown', e => read(e.clientX));
    hit.addEventListener('pointerleave', clear);
    hit.addEventListener('pointercancel', clear);
  };


  /* ── TRIAGE: ACTION, DEVELOPING, WAIT ─────────────────────────────────────
   *
   * A watchlist that is only a table asks the reader to re-derive, every
   * morning, which of their names did something. With ten names that is a
   * glance; with eighty it is work, and the work is identical every day.
   *
   * Every test below is measured off the screen row and the live quote — no
   * interpretation, no sentiment, no invented score. A name is in ACTION
   * because a level it was near has actually been reached, in DEVELOPING
   * because it is close to one, and in WAIT because neither is true. The
   * reason is printed with the name, so the classification can be argued with
   * rather than trusted.
   *
   * A triggered price alert is always ACTION: the reader said, in advance,
   * that this level mattered to them. Nothing this site computes outranks
   * that.
   */
  function triage(sym, r, live, alerts) {
    const px = live && Number.isFinite(live.price) ? live.price : Number(r.price);
    const day = live && Number.isFinite(live.change_pct) ? live.change_pct : Number(r.r1d);
    const near = (a, b, pct) => Number.isFinite(a) && Number.isFinite(b) && b !== 0
      && Math.abs((a - b) / b) * 100 <= pct;
    const reasons = [];
    let rank = 2;                                   // 0 action, 1 developing, 2 wait

    const hit = (alerts || []).find(a => a.sym === sym && Number.isFinite(Number(a.px))
      && Number.isFinite(px)
      && (a.op === 'above' ? px >= Number(a.px) : px <= Number(a.px)));
    if (hit) { rank = 0; reasons.push(`your alert at ₹${esc(hit.px)} has been reached`); }

    if (Number.isFinite(px) && Number.isFinite(Number(r.high52)) && px >= Number(r.high52))
      { rank = 0; reasons.push('at or through its 52-week high'); }
    if (Number.isFinite(px) && Number.isFinite(Number(r.low52)) && px <= Number(r.low52))
      { rank = 0; reasons.push('at or through its 52-week low'); }
    if (Number.isFinite(day) && Math.abs(day) >= 5)
      { rank = 0; reasons.push(`moved ${pct(day)} today`); }
    if (near(px, Number(r.sma200), 0.75))
      { rank = 0; reasons.push('sitting on its 200-day average — the line it trends around'); }

    if (rank > 1) {
      if (near(px, Number(r.high52), 3)) { rank = 1; reasons.push('within 3% of its 52-week high'); }
      else if (near(px, Number(r.low52), 3)) { rank = 1; reasons.push('within 3% of its 52-week low'); }
      if (Number.isFinite(Number(r.rsi)) && (r.rsi >= 70 || r.rsi <= 30))
        { rank = 1; reasons.push(`RSI ${Math.round(r.rsi)} — ${r.rsi >= 70 ? 'overbought' : 'oversold'}`); }
      if (Number(r.vol_spike) >= 2)
        { rank = 1; reasons.push(`trading at ${Number(r.vol_spike).toFixed(1)}× its average volume`); }
      if (near(px, Number(r.sma50), 1))
        { rank = 1; reasons.push('close to its 50-day average'); }
    }
    return { rank, why: reasons };
  }

  const TRIAGE = [
    ['ACTION', 'Something a level you were watching has actually reached.'],
    ['DEVELOPING', 'Close to a level, but not there. Worth a look, not a decision.'],
    ['WAIT', 'Nothing measured has changed. Left here so the list stays complete.'],
  ];

  let watchQ = '', watchSort = 'sym', watchSec = '', WVIEW = null;
  R['/watch'] = async () => {
    lsSet(FSEEN, Date.now()); paintBell();
    const syms = watchAll();
    paint(head('Watchlist', 'Names you starred and price levels you asked to be told about.',
      'Yours, on this device') + skel('sk-row', 4), true);

    // The screen supplies every fundamental and level; live prices come from
    // the same quote route the rest of the site uses.
    const idx = await screenIndex();
    const q = syms.length ? await quotes(syms) : {};
    let out = head('Watchlist', 'Names you starred and price levels you asked to be told about.',
      'Yours, on this device');

    out += `<div class="note"><b>Saved on this device only.</b>
      <span style="display:block;margin-top:7px">Your list and alerts are stored in this browser.
      Nothing is sent to a server, so nobody — including me — can see them.</span>
      <span style="display:block;margin-top:7px"><b>Two things follow from that:</b> the list will
      not appear on your phone, and it is lost if you clear this browser's site data.</span>
      <span style="display:block;margin-top:7px">Alerts are checked whenever this page loads a
      price, so they can only reach you while the site is open in a tab.</span>
      <span class="wio" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button type="button" class="btn" id="wExport">Export list and alerts</button>
        <label class="btn" for="wImport">Import from a file</label>
        <input type="file" id="wImport" accept="application/json,.json" class="vh">
      </span><span id="wIoMsg" role="status" aria-live="polite" style="display:block;margin-top:6px"></span></div>`;

    /* ── FILTERS FOR A LIST THAT GROWS ────────────────────────────────────
     * A watchlist is the one table on this site whose length the reader
     * controls, and the only one with no way to search or order it. At ten
     * names that is fine; at eighty it is a wall. Search, sector and sort,
     * with the same grammar as the Screen so nothing new has to be learned. */
    const WSORT = { sym: 'Symbol', r1d: 'Today', r1m: '1 month', rsi: 'RSI',
                    from_high: 'From 52w high', mcap_cr: 'Size' };
    const wSectors = [...new Set(syms.map(x => (idx && idx[x] || {}).sector).filter(Boolean))].sort();
    out += sec('Filter your list', `<div class="tools">
        <input type="search" id="wq" class="scr-in" value="${esc(watchQ)}"
               placeholder="Search your watchlist" aria-label="Search your watchlist">
        <select id="wsort" class="scr-sel" aria-label="Order by">
          ${Object.entries(WSORT).map(([k, l]) =>
            `<option value="${k}"${watchSort === k ? ' selected' : ''}>Order by ${esc(l)}</option>`).join('')}
        </select>
      </div>
      ${wSectors.length > 1 ? `<div class="chips" role="group" aria-label="Sector">
        <button type="button" class="chip" data-wsec="" aria-pressed="${!watchSec}">All ${syms.length}</button>
        ${wSectors.map(sv => `<button type="button" class="chip" data-wsec="${esc(sv)}"
           aria-pressed="${watchSec === sv}">${esc(sv)}</button>`).join('')}
      </div>` : ''}`, syms.length ? `${syms.length} starred` : '');

    /* Read once, above the first use: triage consults the alerts (a triggered
     * one always outranks anything this site computes) and so does the alert
     * table further down. */
    const al = alertsAll();

    /* The three counts, before the table. This is the answer to "is there
     * anything for me today", which is the only question a watchlist is
     * really asked. */
    const tcount = [0, 0, 0];
    for (const x of syms) tcount[triage(x, (idx && idx[x]) || { sym: x }, q[x], al).rank]++;
    if (syms.length) out += sec('What needs you', `<div class="wtri-sum">
        ${TRIAGE.map(([word, blurb], i) => `<div class="wtri-c wtri-${i}${tcount[i] ? '' : ' is-none'}">
          <b>${tcount[i]}</b><i>${esc(word)}</i><em>${esc(blurb)}</em></div>`).join('')}
      </div>
      <p class="hint">Every test behind these is measured off the screen row and the live quote —
        a level reached, a level approached, or neither. Nothing here is a view on the company.</p>`,
      '', 'Your list, triaged by what actually moved.');

    out += sec('Watching', syms.length ? `<div class="rank">
      <div class="rank-r scr-r rank-head"><span class="i">#</span><span class="s">Name</span>
        <span class="x">Price</span><span class="x">Today</span><span class="x">vs 50D</span>
        <span class="x">vs 200D</span><span class="x">RSI 14D</span><span class="m">1M</span></div>
      ${(() => {
        /* FILTER AND ORDER, THEN NUMBER. The row number has to follow the
         * list the reader is looking at — numbering the unfiltered list and
         * then hiding rows leaves gaps that read as missing data. */
        const wq = watchQ.trim().toLowerCase();
        const rowOf = x => (idx && idx[x]) || { sym: x };
        let view = syms.filter(x => {
          const r = rowOf(x);
          if (watchSec && r.sector !== watchSec) return false;
          if (!wq) return true;
          return `${x} ${r.name || ''} ${r.sector || ''} ${r.ind || ''}`.toLowerCase().includes(wq);
        });
        const val = x => {
          const r = rowOf(x);
          if (watchSort === 'sym') return null;             // handled below
          const v = r[watchSort];
          if (v == null || v === '') return -Infinity;      // Number(null) is 0, not last
          const n = Number(v);
          return Number.isFinite(n) ? n : -Infinity;        // unmeasured sorts last
        };
        /* TRIAGE ORDERS THE LIST UNLESS THE READER ASKED FOR SOMETHING ELSE.
         * "Symbol" was the default, which is alphabetical — an order that has
         * nothing to do with what changed overnight. */
        view = watchSort === 'sym'
          ? view.slice().sort((a, b) => {
              const ta = triage(a, rowOf(a), q[a], al).rank;
              const tb = triage(b, rowOf(b), q[b], al).rank;
              return ta - tb || String(a).localeCompare(String(b));
            })
          : view.slice().sort((a, b) => val(b) - val(a));
        WVIEW = view;
        return view;
      })().map((sym, i) => {
        const r = (idx && idx[sym]) || { sym };
        const live = q[sym];
        const px = live ? live.price : r.price;
        const v50 = r.sma50 && px ? (px - r.sma50) / r.sma50 * 100 : null;
        const v200 = r.sma200 && px ? (px - r.sma200) / r.sma200 * 100 : null;
        return `<div class="rank-r scr-r" data-sym="${esc(sym)}" role="button" tabindex="0">
          <span class="i">${i + 1}</span>
          <span class="s">${watchBtn(sym)}<b>${esc(sym)}</b>
            <span>${esc(r.name || 'not on the screen')}</span>
            ${(() => {
              const tg = triage(sym, r, live, al);
              const [word] = TRIAGE[tg.rank];
              return `<span class="wtri wtri-${tg.rank}">
                <i>${esc(word)}</i>${tg.why.length ? `<em>${esc(tg.why[0])}</em>` : ''}</span>`;
            })()}</span>
          <span class="x">${px != null ? '₹' + esc(px) : '—'}</span>
          <span class="x ${live && dir(live.change_pct)}">${live && Number.isFinite(live.change_pct) ? pct(live.change_pct) : '—'}</span>
          <span class="x ${dir(v50)}">${v50 == null ? '—' : pct(v50)}</span>
          <span class="x ${dir(v200)}">${v200 == null ? '—' : pct(v200)}</span>
          <span class="x">${r.rsi != null ? Math.round(r.rsi) : '—'}</span>
          <span class="m ${dir(r.r1m)}">${pct(r.r1m)}</span>
          <span class="pl-w">${priceLine(r)}</span>
        </div>`; }).join('')}</div>`
      : `<div class="empty">Nothing starred yet. Open <a href="/screen" style="color:var(--accent)">Screen</a>
         or any company card and press the star.</div>`,
      syms.length ? `${syms.length} name${syms.length > 1 ? 's' : ''}` : '');
    if (syms.length) out = out.replace(/<\/section>$/, PLKEY + '</section>');
    // Filtered down to nothing is a different state from "nothing starred".
    if (syms.length && WVIEW && !WVIEW.length)
      out = out.replace(/<div class="rank">[\s\S]*?<\/div>\s*(?=<p class="pl-key")/,
        '<div class="empty">None of your starred names match that filter.</div>');

    /* ── ALERTS ─────────────────────────────────────────────────────────── */
    out += sec('Price alerts', `
      <form class="alform" id="alform">
        <div><label for="alSym">Symbol</label>
          <input id="alSym" list="alSyms" placeholder="e.g. RELIANCE" autocomplete="off" required></div>
        <datalist id="alSyms">${(syms.length ? syms : (idx ? Object.keys(idx).slice(0, 400) : []))
          .map(x => `<option value="${esc(x)}">`).join('')}</datalist>
        <div><label for="alOp">When price is</label>
          <select id="alOp"><option value="above">at or above</option>
            <option value="below">at or below</option></select></div>
        <div><label for="alPx">Level</label>
          <input id="alPx" type="number" step="any" min="0" placeholder="0.00" required></div>
        <div><label for="alNote">Note <span style="color:var(--dim)">optional</span></label>
          <input id="alNote" maxlength="80" placeholder="why this level matters"></div>
        <button type="submit" class="btn-ghost-solid">Add alert</button>
      </form>
      ${al.length ? `<div class="board" style="margin-top:16px">${al.map((a, i) => {
        const live = q[a.sym];
        const px = live ? live.price : ((idx && idx[a.sym] || {}).price);
        const away = Number.isFinite(px) && Number(a.px)
          ? ((Number(a.px) - px) / px * 100) : null;
        return `<div class="board-row">
          <span class="n"><b>${esc(a.sym)}</b> ${esc(a.op === 'above' ? '≥' : '≤')} ${esc(a.px)}
            ${a.note ? `<br><em style="font-style:normal;color:var(--dim);font-size:var(--t-3)">${esc(a.note)}</em>` : ''}</span>
          <span class="p">${px != null ? '₹' + esc(px) : '—'}</span>
          <span class="c ${away == null ? '' : dir(away)}">${away == null ? '—' : pct(away) + ' away'}</span>
          <button type="button" class="alx" data-al="${i}" aria-label="Delete this alert">✕</button>
        </div>`; }).join('')}</div>`
        : `<div class="empty">No alerts set. They are checked against the prices this page fetches —
           so they fire while the site is open, not in the background.</div>`}
      ${'Notification' in window ? `<p class="sec-note" id="notifRow">Alerts always show on the page.
        <button type="button" class="lnk" id="notifBtn">Also allow browser notifications</button>
        — optional, and it changes nothing about what is stored.</p>` : ''}`,
      al.length ? `${al.length} set` : '');

    paint(out);

    const f = document.getElementById('alform');
    f.addEventListener('submit', ev => {
      ev.preventDefault();
      const sym = document.getElementById('alSym').value.trim().toUpperCase();
      const px = Number(document.getElementById('alPx').value);
      if (!sym || !Number.isFinite(px) || px <= 0) return;
      const okSaved = addAlert({ sym, op: document.getElementById('alOp').value, px,
        note: document.getElementById('alNote').value.trim(), made: new Date().toISOString() });
      if (!okSaved) { toast('Could not save', 'This browser is blocking local storage.'); return; }
      // Star it too: an alert on a name you are not watching is a name you
      // will forget you set an alert on.
      if (!isWatched(sym)) toggleWatch(sym);
      R['/watch']();
    });
    main.querySelectorAll('.alx').forEach(b => b.addEventListener('click', () => {
      dropAlert(Number(b.dataset.al)); R['/watch']();
    }));

    /* The filters redraw the whole route, so the caret has to be put back or
     * the field empties itself out from under whoever is typing in it. Same
     * pattern as the Screen and the wire. */
    const wqi = document.getElementById('wq');
    if (wqi) wqi.addEventListener('input', async () => {
      watchQ = wqi.value;
      const at = wqi.selectionStart;
      await R['/watch']();
      const again = document.getElementById('wq');
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (e) { /* not text */ } }
    });
    const wso = document.getElementById('wsort');
    if (wso) wso.addEventListener('change', () => { watchSort = wso.value; R['/watch'](); });
    main.querySelectorAll('[data-wsec]').forEach(b =>
      b.addEventListener('click', () => { watchSec = b.dataset.wsec; R['/watch'](); }));
    /* EXPORT / IMPORT. The only way to move a local-only list between
       devices. The file is the same three keys this page reads; an import is
       validated and MERGED (union of symbols, alerts appended), never a
       silent overwrite of what is already here. */
    const ioMsg = (t) => { const m = document.getElementById('wIoMsg'); if (m) m.textContent = t; };
    const wx = document.getElementById('wExport');
    if (wx) wx.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ kind: 'signal-watchlist', v: 1, exported_at: new Date().toISOString(),
        watch: watchAll(), alerts: lsGet(AKEY, []) }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'signal-watchlist.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      ioMsg(`Exported ${watchAll().length} names and ${lsGet(AKEY, []).length} alerts.`);
    });
    const wi = document.getElementById('wImport');
    if (wi) wi.addEventListener('change', async () => {
      try {
        const f = wi.files && wi.files[0];
        if (!f) return;
        const d = JSON.parse(await f.text());
        if (!d || d.kind !== 'signal-watchlist' || !Array.isArray(d.watch)) throw new Error('not a Signal watchlist export');
        const clean = d.watch.map(x => String(x || '').toUpperCase().replace(/[^A-Z0-9&.-]/g, '')).filter(Boolean).slice(0, 500);
        const w = [...new Set([...watchAll(), ...clean])];
        lsSet(WKEY, w);
        const al = Array.isArray(d.alerts) ? d.alerts.filter(x => x && typeof x === 'object').slice(0, 500) : [];
        if (al.length) lsSet(AKEY, [...lsGet(AKEY, []), ...al]);
        ioMsg(`Imported ${clean.length} names and ${al.length} alerts.`);
        R['/watch']();
      } catch (e) { ioMsg('Import failed: ' + (e && e.message || 'unreadable file') + '. Nothing was changed.'); }
    });
    const nb = document.getElementById('notifBtn');
    if (nb) {
      if (Notification.permission === 'granted') nb.textContent = 'Browser notifications are on';
      else if (Notification.permission === 'denied') nb.textContent = 'Browser notifications are blocked';
      else nb.addEventListener('click', async () => {
        // Requested from a real click, which is the only place browsers allow it.
        const r = await Notification.requestPermission();
        nb.textContent = r === 'granted' ? 'Browser notifications are on'
                       : r === 'denied' ? 'Browser notifications are blocked'
                       : 'Also allow browser notifications';
      });
    }
  };

  /* ══ SIGNAL V2 ════════════════════════════════════════════════════════════
   *
   * ONE FEED, EVERY VIEW. /signal_v2.json is the canonical plan feed written by
   * the private end-of-day engine. Today, Opportunities, the plan page, the
   * brief, a stock's card, Performance and Vision all read it, so a symbol can
   * never carry two different entries, stops or targets in two places. Nothing
   * below computes a level: entry, stop, targets and every R:R are printed as
   * the feed states them. The only arithmetic is current-price risk/reward on a
   * live quote, labelled as such.
   *
   * The metrics block is the feed's own, computed once by the engine. No view
   * counts its own wins. Missing stays missing: a null renders as a word.
   */
  const V2_URL = '/signal_v2.json';
  /* V2 sections keep their reading order at every width: the two-column
     packer (gridSections) alternates columns, which on a phone would put
     "Closed" above "Active". Order is part of the contract here. */
  const vsec = (l, b, n, lead, o) => sec(l, `<div class="v2-wide">${b}</div>`, n, lead, o);
  const V2_FLAG = {
    results_date_unverified: 'Results date not verified for the holding window',
    surveillance_list_unverified: 'Exchange surveillance lists not checked',
    ambiguous: 'One session touched both the stop and a target; booked as the stop',
    gap_through_stop: 'Opened below the stop; exited at the open',
    circuit_blocked: 'A locked circuit delayed an order',
    same_day_stop_after_limit_fill: 'Filled and stopped in the same session',
  };
  const V2_STATE = {
    awaiting_entry:   ['Awaiting entry', 'wait', '○'],
    activated:        ['Active', 'on', '●'],
    partially_exited: ['Active · part sold', 'on', '◐'],
    closed:           ['Closed', 'done', '■'],
    stopped:          ['Stopped out', 'done', '■'],
    time_exited:      ['Time exit', 'done', '■'],
    expired_unfilled: ['Expired unfilled', 'off', '×'],
    cancelled:        ['Cancelled before entry', 'off', '×'],
  };
  const V2_OUTCOME = { win: ['Win', 'up'], loss: ['Loss', 'dn'], breakeven: ['Breakeven', ''] };
  const V2_OPEN = new Set(['activated', 'partially_exited']);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const v2Date = (iso) => {
    if (!iso) return '—';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : esc(iso);
  };
  const v2Time = (iso) => {
    if (!iso) return '—';
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso));
    return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}, ${m[4]}:${m[5]} IST` : esc(iso);
  };
  const v2Num = (v, dp = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const v2R = (v) => (v === null || v === undefined) ? '—' : (Number(v) > 0 ? '+' : '') + v2Num(v, 2) + 'R';
  const v2Inr = (v) => (v === null || v === undefined) ? '—'
    : (Number(v) < 0 ? '−' : '') + '₹' + Math.abs(Number(v)).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const v2Badge = (st) => {
    const [w, c, i] = V2_STATE[st] || [st, '', '·'];
    return `<span class="v2-st is-${c}"><i aria-hidden="true">${i}</i>${esc(w)}</span>`;
  };
  const v2PlanUrl = (p) => '/plan/' + encodeURIComponent(p.id);
  const v2Vision = (sym) => VISION_URL + '/company/' + encodeURIComponent(sym);

  let V2 = null;
  async function v2Load() {
    /* The strip says when NSE next opens, and that is wrong on a holiday eve
       unless the holiday table is filled. Every V2 view draws the strip, so the
       calendar loads here, beside the feed, not only on the routes that remembered. */
    const [r, cal] = await Promise.all([get(V2_URL), get('/api/calendar').catch(() => ({ ok: false }))]);
    if (cal && cal.ok && cal.data && cal.data.ok && cal.data.holidays) setHolidays(cal.data.holidays.rows);
    if (!r.ok || !r.data || r.data.schema !== 'signal-v2-public/1') {
      V2 = null;
      return { ok: false, why: r.ok ? 'the plan feed is in an unknown format' : (r.error || 'no answer') };
    }
    V2 = r.data;
    return { ok: true, d: r.data, stale: r.stale, age: r.age };
  }
  // A plan whose last close is already above its entry cap can still fill —
  // only if price comes back to the cap. Said in words, never a colour alone.
  const v2Extended = (p) => p.state === 'awaiting_entry' && p.last_close != null && p.last_close > p.entry_high;

  /* What a reader needs before they open anything: is this session's scan in,
     is the market open, how much of the universe was read, when is the next. */
  function v2StatusStrip(d) {
    const nse = exchangeState('Asia/Kolkata', 9.25, 15.5, 'NSE');
    const cov = d.coverage || {};
    const covTxt = (cov.with_session_bar != null && cov.universe)
      ? `${cov.with_session_bar.toLocaleString('en-IN')} of ${cov.universe.toLocaleString('en-IN')} liquid NSE names had a complete bar`
      : 'coverage not reported for this run';
    /* A due time that has passed is not "published by X" — it is late, and a
       feed that missed its slot must not keep reading as the current one. */
    const due = Date.parse(d.next_scan_due || '');
    const overdue = Number.isFinite(due) && Date.now() > due;
    /* A failed run keeps the last good plans; the strip must say they are that,
       not describe them as tonight's scan. */
    const bad = { data_unavailable: 'not scanned — data incomplete',
                  error: 'the last run failed — plans as of the last good run' }[d.status] || '';
    const live = nse.open ? `NSE open · ${esc(nse.label)}` : nse.holiday ? `NSE closed · ${nse.label}` : `NSE closed · ${esc(nse.label)}`;
    return `<div class="v2-strip" role="status">
      <div${bad ? ' class="v2-late"' : ''}><span class="k">Latest session</span><b>${v2Date(d.session_date)}</b><span class="s">${esc(bad || 'scanned after the close')}</span></div>
      <div><span class="k">Market</span><b>${live}</b><span class="s">Prices on this site are delayed, not live ticks</span></div>
      <div><span class="k">Coverage</span><b>${cov.with_session_bar != null ? cov.with_session_bar.toLocaleString('en-IN') : '—'}</b><span class="s">${esc(covTxt)}</span></div>
      ${overdue
        ? `<div class="v2-late"><span class="k">Next scan</span><b>Overdue</b><span class="s">The scan due by ${v2Time(d.next_scan_due)} has not published. Everything here is from ${v2Date(d.session_date)}.</span></div>`
        : `<div><span class="k">Next scan</span><b>${v2Date(d.next_session)}, after the close</b><span class="s">published by ${v2Time(d.next_scan_due)} at the latest${d.calendar_verified === false ? ' · exchange calendar not yet confirmed' : ''}</span></div>`}
    </div>`;
  }

  /* THE PLAN CARD. All three targets with their exit portions sit together,
     because a target read without its size is half an instruction. On a phone
     it is a card, never a squeezed table. */
  function v2Card(p, d) {
    const ex = d.exit_plan || {};
    const tgt = (k, pct) => `<div class="v2-t"><span class="k">${k.toUpperCase()} · sell ${pct ?? '—'}%</span>
      <b class="cnum">${price(p[k])}</b><span class="s">${p['rr_' + k] != null ? v2Num(p['rr_' + k]) + 'R from the cap' : '—'}</span></div>`;
    return `<article class="v2-card" aria-labelledby="pc-${esc(p.symbol)}">
      <header><h3 id="pc-${esc(p.symbol)}"><a href="${v2PlanUrl(p)}">${esc(p.symbol)}</a></h3>
        <span class="v2-nm">${esc(p.name || '')}</span>${v2Badge(p.state)}</header>
      <p class="v2-setup">${esc(p.setup || 'Setup')} · published ${v2Time(p.published_at)}${p.outcome ? ` · <b class="${V2_OUTCOME[p.outcome][1]}">${V2_OUTCOME[p.outcome][0]} ${v2R(p.total_r)}</b>` : ''}</p>
      ${v2Extended(p) ? `<p class="v2-warn"><b>Extended.</b> The last close, ${price(p.last_close)}, is above the entry cap. It only fills if price trades back to ${price(p.entry_high)}.</p>` : ''}
      <div class="v2-lv">
        <div class="v2-t"><span class="k">Entry range</span><b class="cnum">${price(p.entry_low)}–${price(p.entry_high)}</b><span class="s">next session, valid through ${v2Date(p.valid_through)}</span></div>
        <div class="v2-t"><span class="k">Stop</span><b class="cnum">${price(p.initial_stop)}</b><span class="s">${p.risk_pct != null ? v2Num(p.risk_pct, 1) + '% below the cap' : ''}</span></div>
        ${tgt('t1', ex.t1_pct)}${tgt('t2', ex.t2_pct)}${tgt('t3', ex.t3_pct)}
      </div>
      <footer><a href="${v2PlanUrl(p)}">Plan ${esc(p.id)} →</a> <a href="${v2Vision(p.symbol)}">Research in Vision ↗</a></footer>
    </article>`;
  }

  /* Why the plan list is empty, in the feed's own terms. "Nothing qualified"
     claims a scan ran and found nothing; a paused model or a session that was
     not scanned is a different sentence, and printing the first over the
     second misstates what happened. */
  const v2NoneWhy = (d) => ({
    paused: `No plans for the ${v2Date(d.next_session)} session — new plans are paused.`,
    data_unavailable: `The ${v2Date(d.session_date)} session was not scanned.`,
    error: 'The last run failed.',
    market_filter: `No new plans for the ${v2Date(d.next_session)} session.`,
  })[d.status] || `No plan qualified for the ${v2Date(d.next_session)} session.`;
  const v2Empty = (d, what) => `<div class="empty v2-empty"><b>${esc(what)}</b>
    <p>${esc(d.status_detail || '')}</p></div>`;

  /* Day 1 shows the absence of a sample, never a 0% that reads as measured. */
  function v2Record(d, compact) {
    const m = d.metrics || {};
    const since = d.forward_record_start;
    const none = !m.closed;
    const rate = m.win_rate != null ? v2Num(m.win_rate, 1) + '%' : '—';
    const tiles = [
      tile(String(m.published ?? '—'), 'Plans published', since ? `since ${v2Date(since)}` : 'forward record not started'),
      tile(String(m.closed ?? '—'), 'Closed', none ? 'no completed trade yet' : `${m.wins} win · ${m.losses} loss · ${m.breakevens} breakeven`),
      tile(esc(rate), 'Win rate', none ? 'No completed sample yet' : m.win_rate == null ? `shown once ${m.min_closed_for_rate} have closed (${m.closed} so far)` : `over ${m.closed} closed`),
      tile(m.mean_r_closed != null ? v2R(m.mean_r_closed) : '—', 'Mean net R per closed trade', none ? 'no completed sample' : `over ${m.closed}`),
    ];
    if (!compact) {
      tiles.push(tile(v2Inr(m.net_pnl_inr), 'Realised net P&L', 'after modelled costs, paper'),
                 tile(v2Inr(m.open_mark_inr), 'Open positions, marked', 'at the last close, not realised'),
                 tile(v2Inr(m.nav_inr), 'Paper NAV', `from ${v2Inr(m.capital_inr)} reference capital`),
                 tile(v2Inr(m.charges_inr), 'Charges paid', 'modelled'));
    }
    const rec = `${m.published ?? 0} published = ${m.awaiting_entry ?? 0} awaiting entry + ${m.active ?? 0} active + ${m.closed ?? 0} closed + ${m.expired_unfilled ?? 0} expired unfilled + ${m.cancelled_before_entry ?? 0} cancelled before entry`;
    return `<div class="grid v2-rec">${tiles.join('')}</div>
      <p class="v2-recon">${esc(rec)}${m.reconciles === false ? ' — <b>does not reconcile; reported as an error</b>' : ''}.</p>
      <p class="v2-disc">V2 forward record begins ${since ? v2Date(since) : 'when the first V2 session is scanned'}. Previous model results are excluded.</p>`;
  }

  function v2Shell(title, sub, body) {
    paint(head(title, sub, 'Signal V2') + body);
  }

  async function v2Need(title, sub) {
    paint(head(title, sub, 'Signal V2') + skel('sk-card', 3), true);
    const r = await v2Load();
    if (!r.ok) {
      paint(head(title, sub, 'Signal V2') + fail('The plan feed', r.why));
      return null;
    }
    return r;
  }

  /* The stock page's plan section. V2 is loaded by R['/stock/:id'] before
     paint; if it is not, the section says so rather than implying no plan. */
  const v2StockBlock = (sym) => {
    if (!V2) return `<p class="muted">The plan feed did not load, so this page cannot say whether ${esc(sym)} has a V2 plan. <a href="/opportunities">Opportunities</a> lists every plan.</p>`;
    const mine = (V2.plans || []).filter(p => p.symbol === sym);
    const live = mine.filter(p => p.state === 'awaiting_entry' || V2_OPEN.has(p.state));
    const done = mine.filter(p => !live.includes(p));
    return (live.length ? `<div class="v2-cards">${live.map(p => v2Card(p, V2)).join('')}</div>`
      : `<p>No Signal V2 plan for ${esc(sym)} right now. The research on this page describes the company; it is not a plan and sets no levels.</p>`)
      + (done.length ? `<p class="muted">Earlier V2 plans: ${done.map(p => `<a href="${v2PlanUrl(p)}">${esc(p.session_date)} · ${esc((V2_STATE[p.state] || [p.state])[0])}</a>`).join(' · ')}</p>` : '');
  };

  // ── TODAY ─────────────────────────────────────────────────────────────
  R['/'] = async () => {
    const H = 'Indian equities, screened after the close.';
    const S = 'Review qualified setups, plan the next session, and track every paper trade.';
    paint(head(H, S, 'Today') + skel('sk-card', 3), true);
    const [r, rg] = await Promise.all([v2Load(), get('/regime.json').catch(() => ({ ok: false }))]);
    if (!r.ok) { paint(head(H, S, 'Today') + fail('The plan feed', r.why)); return; }
    const d = r.d;
    const plans = d.plans || [];
    const next = plans.filter(p => p.state === 'awaiting_entry');
    const active = plans.filter(p => V2_OPEN.has(p.state));
    const watch = watchAll();
    const bySym = Object.fromEntries(plans.map(p => [p.symbol, p]));
    const watchHtml = !watch.length
      ? `<p class="muted">Your watchlist is empty. Add names from the <a href="/screen">screen</a>; it is kept in this browser only.</p>`
      : `<ul class="v2-wl">${watch.slice(0, 12).map(w => {
          const s = String(w.sym || w).toUpperCase();
          const p = bySym[s];
          return `<li><a href="/stock/${encodeURIComponent(s)}">${esc(s)}</a> <span>${p ? `${v2Badge(p.state)} <a href="${v2PlanUrl(p)}">plan</a>` : 'no V2 plan'}</span></li>`;
        }).join('')}</ul>`;
    const reg = rg && rg.ok && rg.data && rg.data.today ? rg.data.today : null;
    const ctx = reg ? `<p class="v2-ctx"><b>Market regime: ${esc(String(reg.regime || '').replace(/_/g, ' '))}.</b>
        Nifty ${reg.close != null ? Number(reg.close).toLocaleString('en-IN') + ' points' : '—'},
        ${reg.drawdown_pct != null ? v2Num(reg.drawdown_pct, 1) + '% below its high' : ''}${reg.above_200dma != null ? `, ${reg.above_200dma ? 'above' : 'below'} its 200-day average` : ''}.
        One regime, defined on <a href="/markets">Market</a>.</p>` : '';
    paint(head(H, S, 'Today') +
      (r.stale ? staleNote(r.age) : '') +
      v2StatusStrip(d) +
      vsec(`Plans for ${v2Date(d.next_session)}`, next.length ? `<div class="v2-cards">${next.map(p => v2Card(p, d)).join('')}</div>`
        : v2Empty(d, v2NoneWhy(d)), String(next.length), null, { lead: true }) +
      vsec('Active paper positions', active.length ? `<div class="v2-cards">${active.map(p => v2Card(p, d)).join('')}</div>`
        : `<p class="muted">No open paper position.</p>`, String(active.length)) +
      vsec('Your watchlist', watchHtml, watch.length ? String(watch.length) : '') +
      vsec('V2 record', v2Record(d, true) + `<p><a href="/performance">Full record →</a></p>`) +
      (ctx ? vsec('Market context', ctx) : '') +
      `<p class="v2-note">${esc(d.notice || '')}</p>`);
  };

  // ── OPPORTUNITIES ─────────────────────────────────────────────────────
  R['/opportunities'] = async () => {
    const T = 'Opportunities', S = 'Every V2 plan by state. Eligible plans come first.';
    const r = await v2Need(T, S);
    if (!r) return;
    const d = r.d, plans = d.plans || [];
    const grp = (f) => plans.filter(f);
    const eligible = grp(p => p.state === 'awaiting_entry' && !v2Extended(p));
    const extended = grp(v2Extended);
    const active = grp(p => V2_OPEN.has(p.state));
    const done = grp(p => ['closed', 'stopped', 'time_exited'].includes(p.state));
    const lapsed = grp(p => ['expired_unfilled', 'cancelled'].includes(p.state));
    const block = (label, list, empty, lead) => vsec(label, list.length
      ? `<div class="v2-cards">${list.map(p => v2Card(p, d)).join('')}</div>` : `<p class="muted">${esc(empty)}</p>`,
      String(list.length), null, lead ? { lead: true } : undefined);
    paint(head(T, S, 'Signal V2') + v2StatusStrip(d) +
      (eligible.length ? '' : v2Empty(d, 'Nothing is eligible for the next session.')) +
      block('Eligible next session', eligible, 'No plan is waiting for entry.', true) +
      block('Extended — above the entry cap', extended, 'No plan is extended.') +
      block('Active', active, 'No paper position is open.') +
      block('Closed', done, 'Nothing has closed yet.') +
      block('Expired or cancelled before entry', lapsed, 'None.') +
      vsec('Rejected candidates', `<p class="muted">Candidates that failed a rule are not published, and neither are their reasons — the rules stay private. The count of names scanned is under Coverage above.</p>`) +
      vsec('Strategies', v2Strategies(d)) +
      `<p class="v2-note">${esc(d.notice || '')}</p>`);
  };

  function v2Strategies(d) {
    const s = d.strategies || [];
    if (!s.length) return '<p class="muted">No strategy is listed.</p>';
    const word = { research: 'Research — not publishing', shadow: 'Shadow — tracked privately, not published',
                   forward_paper: 'Forward paper — publishing paper plans', validated: 'Validated' };
    return `<ul class="v2-strat">${s.map(x => `<li><b>${esc(x.name)}</b> <span class="v2-pill">${esc(word[x.status] || x.status)}</span>
      <p>${esc(x.public_summary || '')}</p></li>`).join('')}</ul>`;
  }

  // ── PLAN DETAIL ───────────────────────────────────────────────────────
  R['/plan/:id'] = async () => {
    const id = routeParam();
    const r = await v2Need('Plan', id);
    if (!r) return;
    const d = r.d;
    const p = (d.plans || []).find(x => x.id === id);
    if (!p) {
      v2Shell('Plan not found', '', `<div class="empty"><b>There is no V2 plan with the id ${esc(id)}.</b>
        <p>V2 plan ids look like <code>2026-10-05:SYMBOL:version</code>. Calls from the retired V1 engines were not carried into V2 and have no plan page.</p>
        <p><a href="/opportunities">All V2 plans →</a></p></div>`);
      return;
    }
    const q = await quotes([p.symbol]).catch(() => ({}));
    const qt = q && q[p.symbol];
    const px = qt && Number.isFinite(Number(qt.price)) ? Number(qt.price) : null;
    const ex = d.exit_plan || {};
    const sh = (k) => ({ t1: ex.t1_pct, t2: ex.t2_pct, t3: ex.t3_pct })[k];
    const curRR = (t) => (px != null && px > p.stop && p[t] > px) ? v2Num((p[t] - px) / (px - p.stop)) + 'R' : '—';
    const elig = p.state !== 'awaiting_entry' ? `Not open for entry — ${(V2_STATE[p.state] || [p.state])[0].toLowerCase()}.`
      : v2Extended(p) ? `Extended: the last close is above the cap. It fills only if price trades back to ${price(p.entry_high)} by ${v2Date(p.valid_through)}.`
      : `Eligible from the ${v2Date(d.next_session)} open through ${v2Date(p.valid_through)}, between ${price(p.entry_low)} and ${price(p.entry_high)}.`;
    const summary = `${p.symbol}: ${(p.setup || 'setup').toLowerCase()}, long. Buy only between ${price(p.entry_low)} and ${price(p.entry_high)} on the next ${d.entry_expiry_sessions} sessions; `
      + `stop ${price(p.initial_stop)}; targets ${price(p.t1)}, ${price(p.t2)} and ${price(p.t3)}, selling ${ex.t1_pct}%, ${ex.t2_pct}% and ${ex.t3_pct}% of the position.`;
    const row = (k, a, b, c) => `<tr><th scope="row">${k}</th><td class="cnum">${a}</td><td class="cnum">${b}</td><td class="cnum">${c}</td></tr>`;
    const levels = `<table class="v2-tbl"><caption class="sr">Plan levels</caption><thead><tr><th scope="col">Level</th><th scope="col">Price</th><th scope="col">From the cap</th><th scope="col">From ${px != null ? 'the latest quote' : 'a live quote'}</th></tr></thead><tbody>
      ${row('Entry range', `${price(p.entry_low)}–${price(p.entry_high)}`, 'cap', px != null ? price(px) : 'no quote')}
      ${row('Stop', price(p.initial_stop), p.risk_pct != null ? '−' + v2Num(p.risk_pct, 1) + '%' : '—', px != null ? v2Num((p.stop - px) / px * 100, 1) + '%' : '—')}
      ${['t1', 't2', 't3'].map(k => row(`${k.toUpperCase()} · sell ${sh(k)}%`, price(p[k]), p['rr_' + k] != null ? v2Num(p['rr_' + k]) + 'R' : '—', curRR(k))).join('')}
    </tbody></table>`;
    const pos = p.fill ? `<dl class="v2-dl">
        <div><dt>Filled</dt><dd>${price(p.fill.price)} on ${v2Date(p.fill.session)} (${esc(p.fill.kind)}, simulated)</dd></div>
        <div><dt>Quantity</dt><dd>${p.qty} shares · ${p.remaining_qty} remaining (${v2Num(p.remaining_pct, 1)}%)</dd></div>
        <div><dt>Current stop</dt><dd>${price(p.stop)}${p.stop !== p.initial_stop ? ` (initial ${price(p.initial_stop)})` : ''}</dd></div>
        <div><dt>Realised</dt><dd>${v2R(p.realized_r)} · ${v2Inr(p.net_pnl_inr)} after charges</dd></div>
        <div><dt>Open, marked</dt><dd>${v2R(p.unrealized_r)} · ${v2Inr(p.open_mark_inr)} at ${price(p.last_close)} (${v2Date(p.last_session)} close)</dd></div>
        ${p.outcome ? `<div><dt>Outcome</dt><dd><b class="${V2_OUTCOME[p.outcome][1]}">${V2_OUTCOME[p.outcome][0]}</b> · ${v2R(p.total_r)} net on the initial risk</dd></div>` : ''}
      </dl>` : `<p class="muted">No fill yet. Paper size at the cap: ${p.qty} shares, risking ${price(p.risk_per_share)} a share.</p>`;
    /* The shared Business renderer (authored in trading-dashboard beside the
       screen that computes every field it reads). A file that did not arrive
       is a stated state, never a silent hole. */
    const scr = await get(FULL_URL).catch(() => ({ ok: false }));
    const scrRow = scr && scr.ok && scr.data && Array.isArray(scr.data.rows)
      ? scr.data.rows.find(x => x && x.sym === p.symbol) : null;
    const fund = !scrRow ? `<p class="muted">${esc(p.symbol)} has no row in the current screen build, so no company figures are shown.</p>`
      : window.BriefFundamentals
        ? window.BriefFundamentals.render(scrRow, {
            symbol: p.symbol,
            screenHref: '/screen?q=' + encodeURIComponent(p.symbol),
            headingTag: 'h3',
          })
        : `<p class="note">The company section could not load (brief_fundamentals.js did not arrive). The plan above is unaffected.</p>`;
    const upd = `<ol class="v2-upd">${(p.updates || []).map(u => `<li><time>${v2Date(u.session)}</time> ${esc(u.what)}</li>`).join('')}</ol>`;
    v2Shell(`${p.symbol} — plan`, p.name || '',
      `<p class="v2-sum">${esc(summary)}</p>
       <p>${v2Badge(p.state)} <span class="muted">Plan ${esc(p.id)} · signal close ${v2Date(p.session_date)} · published ${v2Time(p.published_at)}${px != null ? ` · delayed quote ${price(px)}` : ' · no live quote'}</span></p>
       ${p.flags && p.flags.length ? `<p class="v2-warn"><b>Notes:</b> ${p.flags.map(f => esc(V2_FLAG[f] || f)).join('; ')}.</p>` : ''}` +
      vsec('Entry', `<p>${esc(elig)}</p><p class="muted">Published after the close; it can fill no earlier than the next session's open. An open above the cap is not chased.</p>`, null, null, { lead: true }) +
      vsec('Levels', levels + `<p class="muted">R:R uses the plan's own prices: (target − cap) ÷ (cap − stop). The right-hand column re-measures from a delayed quote and changes nothing in the plan.</p>`) +
      vsec('Stop and management', `<p>${esc(p.stop_rule)}</p><p>${esc(p.management)}</p><p class="muted">After ${d.time_exit_sessions} held sessions, whatever remains is sold at the next open. A stop does not cap a gap loss.</p>`) +
      vsec('Position', pos) +
      vsec('Updates', upd) +
      vsec('Company research', `<p><a href="${v2Vision(p.symbol)}">${esc(p.symbol)} in Vision ↗</a> · <a href="/stock/${encodeURIComponent(p.symbol)}">Screen card</a></p>
        <p class="muted">The research below describes the company. It is not part of the plan's rules and does not change its levels.</p>
        ${fund}`) +
      `<p class="v2-note">${esc(d.notice || '')}</p>`);
  };

  // ── PERFORMANCE ───────────────────────────────────────────────────────
  R['/performance'] = async () => {
    const T = 'Performance', S = 'The Signal V2 forward record: every paper plan, wins and losses alike.';
    const r = await v2Need(T, S);
    if (!r) return;
    const d = r.d, plans = d.plans || [];
    const closed = plans.filter(p => p.outcome);
    const rows = closed.map(p => `<tr><td><a href="${v2PlanUrl(p)}">${esc(p.symbol)}</a></td><td class="hm">${v2Date(p.session_date)}</td>
      <td class="cnum hm">${price(p.fill && p.fill.price)}</td><td class="hm">${esc((V2_STATE[p.state] || [p.state])[0])}</td>
      <td class="${V2_OUTCOME[p.outcome][1]}">${V2_OUTCOME[p.outcome][0]}</td><td class="cnum">${v2R(p.total_r)}</td><td class="cnum">${v2Inr(p.net_pnl_inr)}</td></tr>`).join('');
    const c = d.costs || {};
    paint(head(T, S, 'Signal V2') +
      vsec('The record', v2Record(d, false), null, null, { lead: true }) +
      vsec('Closed trades', closed.length ? `<table class="v2-tbl"><thead><tr><th scope="col">Symbol</th><th scope="col" class="hm">Signal</th><th scope="col" class="hm">Fill</th><th scope="col" class="hm">Exit</th><th scope="col">Outcome</th><th scope="col">Net R</th><th scope="col">Net ₹</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="muted">No V2 trade has closed. A win rate needs closed trades, so none is shown.</p>`, String(closed.length)) +
      vsec('How it is counted', `<ul class="v2-list">
        <li>Fills and exits are simulated from daily bars. No order is placed anywhere.</li>
        <li>Win, loss or breakeven comes from final net P&amp;L after charges, never from which level was touched. Breakeven means within ±${(d.metrics || {}).breakeven_band_r ?? '—'}R. A target touch alone is not a win.</li>
        <li>Unfilled plans (expired or cancelled before entry) are counted, and are not in any win rate.</li>
        <li>R is measured on the risk fixed at entry. Costs assumed: ${esc(c.includes || '—')}; slippage ${c.slippage_bps_per_side ?? '—'} bp a side. Results are also checked at ${c.stress_multiplier_tested ?? '—'}× costs in research.</li>
        <li>Paper NAV starts from ${v2Inr((d.reference_size || {}).capital_inr)} of reference capital at ${(d.reference_size || {}).risk_per_trade_pct ?? '—'}% risk a trade. Mean R per trade is a diagnostic, not a portfolio return.</li>
      </ul>`) +
      vsec('Strategies', v2Strategies(d)) +
      vsec('Model', `<p>Model version <code>${esc(d.model_version)}</code> · mode ${esc(d.mode)} · last scan ${v2Date(d.session_date)} · published ${v2Time(d.published_at)}${d.cutover_at ? ` · V2 activated ${v2Time(d.cutover_at)}` : ''}.</p>
        <p class="muted">Results of the retired V1 engines are excluded and were not carried into this record. They cannot be removed from third-party caches, emails or screenshots.</p>`));
  };

  // ── RETIRED V1 ROUTES ─────────────────────────────────────────────────
  /* An old link lands on a plain statement, never on a different trade that
     happens to share the symbol. */
  const v2Retired = (what) => async () => {
    await v2Load().catch(() => null);
    const since = V2 && V2.forward_record_start;
    v2Shell('This page has been retired', '',
      `<div class="empty v2-retired"><b>${esc(what)} belonged to Signal V1, which was retired on 1 October 2026.</b>
        <p>Signal V2 publishes conditional plans from one end-of-day process and tracks every one in a new forward record${since ? ` that begins ${v2Date(since)}` : ''}. Previous calls and their results are excluded. No V1 call was turned into a V2 plan.</p>
        <p><a class="btn" href="/opportunities">Opportunities</a> <a class="btn" href="/performance">Performance</a></p></div>`);
  };
  R['/signals'] = v2Retired('The ledger');
  R['/engines'] = v2Retired('The engine floor');
  R['/research'] = v2Retired('The research floor');
  R['/buoy'] = v2Retired('BUOY');
  R['/ideas'] = v2Retired('Ideas');

  // ── THE BRIEF: the most recent eligible or active plan, in full ──────
  R['/brief'] = async () => {
    const r = await v2Need('The brief', 'The current plan, in full.');
    if (!r) return;
    const plans = r.d.plans || [];
    const pick = plans.find(p => p.state === 'awaiting_entry') || plans.find(p => V2_OPEN.has(p.state));
    if (pick) { go(v2PlanUrl(pick), { replace: true }); return; }
    v2Shell('The brief', 'The current plan, in full.', v2StatusStrip(r.d) +
      v2Empty(r.d, `There is no plan to brief for the ${v2Date(r.d.next_session)} session.`) +
      `<p class="muted">The brief never substitutes a "best stock of the day" when nothing qualified.</p>`);
  };

  // The phone tab bar's "More" opens the same dialog as the header button.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-more]');
    if (!b) return;
    const m = document.getElementById('moreBtn');
    if (m) { e.preventDefault(); m.click(); }
  });

  /* ── router ──────────────────────────────────────────────────────────────
   *
   * REAL PATHS, NOT HASH FRAGMENTS.
   *
   * Every route used to live behind a `#`. A fragment is never sent to the
   * server, so /markets and /screen were the same URL to everything that is
   * not a browser running our JavaScript: one title, one description, one
   * canonical, one Open Graph card for thirteen different pages. A link to the
   * ledger shared in a chat unfurled as the homepage. The sitemap could
   * honestly list exactly one URL, and did.
   *
   * The Worker now serves index.html for any unknown path
   * (not_found_handling: single-page-application in wrangler.jsonc), so
   * /markets is a real URL that returns real HTML, and setHead() below gives
   * each one its own metadata.
   *
   * OLD LINKS STILL WORK. Anything already shared as /#/markets is rewritten
   * to /markets on boot, before the first render — see the shim at the bottom
   * of this file. Nothing that was ever shared 404s. */
  const routeOf = () => {
    const p = (location.pathname || '/').replace(/\/+$/, '') || '/';
    if (R[p]) return p;
    // /stock/RELIANCE and friends resolve to their pattern.
    const seg = p.split('/').filter(Boolean);
    if (seg.length === 2 && R['/' + seg[0] + '/:id']) return '/' + seg[0] + '/:id';
    /* AN UNKNOWN PATH IS NOT THE HOME PAGE.
     * This returned '/', so /radarr rendered the full front page — headline,
     * record, everything — under a URL that does not exist, with the home
     * page's title and an index,follow robots tag. The Worker had just been
     * taught to send 404 for those paths, and the body it sent was still
     * claiming to be a real page. A 404 status with the front page in it is
     * the same lie told twice. */
    return '/404';
  };
  /* The parameter of a pattern route, e.g. RELIANCE from /stock/RELIANCE. */
  const routeParam = () => {
    const seg = (location.pathname || '/').split('/').filter(Boolean);
    return seg.length === 2 ? decodeURIComponent(seg[1]) : '';
  };

  /* ONE WAY TO CHANGE ROUTE. Assigning location.hash from three places was how
   * the old router worked; a pushState scattered the same way would be worse,
   * because it does not fire an event of its own. */
  const go = (path, { replace = false } = {}) => {
    const to = path.startsWith('#') ? path.slice(1) : path;
    /* ── THE SAME ROUTE IS A SCROLL, NOT A REBUILD ──────────────────────────
     * This called render(), which tears the route down and paints it again
     * from the feeds. Nothing has changed — it is the page you are already
     * on — so the cost is a flash of skeletons on a slow connection in
     * exchange for the scrollTo(0, 0) that render() happens to do first.
     *
     * It matters more than it reads, because on a phone this IS the
     * back-to-top control: the tab bar is pinned to the bottom of the
     * viewport there and the floating button is gone, so tapping the tab you
     * are on is how you get back. That has to be a scroll. */
    if (to === location.pathname) {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      return;
    }
    history[replace ? 'replaceState' : 'pushState'](null, '', to);
    render();
  };

  /* ── PER-ROUTE METADATA ───────────────────────────────────────────────────
   *
   * Under hash routing this could not exist: every route was one URL, so every
   * route shared one title, one description, one canonical and one Open Graph
   * card. Now that /markets is a real URL, it gets its own.
   *
   * Written on every render, from one table, so a route cannot acquire a title
   * without a description or a canonical — the three drift apart the moment
   * they live in three places.
   *
   * This is NOT a substitute for server-rendered HTML. A crawler that executes
   * JavaScript sees these; a link-unfurl bot that does not will see whatever
   * the shell shipped with. scripts/prerender.mjs writes the shell's copy, and
   * the per-route prerender is the remaining half of that job. */
  const META = {
    '/':            ['Signal — Indian equities, screened after the close',
                     'Review qualified setups, plan the next session, and track every paper trade. NSE equities, long only, with a forward record that starts empty.'],
    '/opportunities': ['Opportunities — every V2 plan by state',
                     'Next-session plans for NSE equities, grouped as eligible, extended, active, closed and expired, each with its entry range, stop and three targets.'],
    '/performance': ['Performance — the Signal V2 forward record',
                     'Every V2 paper plan, wins and losses alike, with reconciled counts, net P&L after modelled costs and the date the record began.'],
    '/plan/:id':    ['Plan — Signal V2',
                     'One conditional paper plan: entry range, stop, three targets, exit sizes, expiry and every update since publication.'],
    '/markets':     ['Markets — the board, 71 instruments with a year of context',
                     'Indices, sectors, commodities and currencies on one board, each against its own 52-week range. Sector heat, breadth and what moved today.'],
    /* NO COUNT IN THE TITLE. It said "all 1,000 NSE names" while the feed
       reported 989 — the same defect Akshay caught as "still shows 750
       stocks", in a place the earlier fix did not reach. The home page tile
       reads the real number from pulse.json and this map cannot, because it
       is static and written before any feed loads. A title that cannot stay
       in sync must not assert a figure; the page itself states the exact
       universe, sourced. */
    '/screen':      ['Screen — every NSE name we track, filterable',
                     'Every name in the universe on price, trend, quality, value and institutional flow. FII and DII holding quarter on quarter, from the company’s own filings.'],
    '/signals':     ['Retired — the V1 ledger', 'Signal V1 was retired on 1 October 2026. Its calls are excluded from the V2 record.'],
    '/heat':        ['The heatmap — today in each name’s own units',
                     'The market coloured by how far each name moved against its own average range rather than in percent, outlined by the screen’s standing call, and marked where a name is in today’s wire.'],
    '/map':         ['The map — every NSE name on one screen',
                     'The whole screened market as one picture, coloured by the call, momentum, value, quality, position in its year, or how often each name has risen in this calendar month over eleven years.'],
    '/reads':       ['Weekly reads — seven companies, studied properly',
                     'One company per sector, every Saturday. What it sells, how the money arrives, and what would break it.'],
    /* NO COUNT AND NO ROSTER IN THE META. Same rule as /screen above: this
       table is static and written before DISCOVER is read, so it cannot stay
       in sync with it. It said "seven ways" and then named seven of the
       eleven doors — heatmap, map, weekly reads and the research floor were
       missing from a sentence that reads as exhaustive, and that sentence is
       what a search result and a link unfurl show. The page itself counts. */
    '/discover':    ['Discover — every way into the screened names',
                     'Each section of this site, what question it answers, and which of the same screened names it is looking at.'],
    '/radar':       ['Signal radar — the market, and the names carrying it',
                     'A breadth-based market score with every term printed, and the eight highest-scoring names ranked on trend, momentum, volume and institutional flow.'],
    '/engines':     ['Retired — the V1 engine floor', 'Signal V1 was retired on 1 October 2026.'],
    '/ideas':       ['Retired — V1 ideas', 'Ideas now live in Opportunities, as next-session plans.'],
    '/ipo':         ['IPO — books open now, and how last year’s listings did',
                     'Issues open and upcoming with demand, valuation and peer comparison, plus every recent listing measured against its issue price.'],
    '/news':        ['News — the wire, and the screened names each story touches',
                     'Market news filtered to what touches the NSE screen, with the companies each story affects.'],
    '/funds':       ['Funds — SIP screen over AMFI NAV, Direct plans only',
                     'Mutual funds ranked on three- and five-year return against their own drawdown and volatility. Direct plans only, because the cost difference compounds.'],
    '/watch':       ['Watchlist — your names, sorted by what needs attention',
                     'The names you follow, ranked by what changed rather than alphabetically.'],
    '/brief':       ['The brief — the current plan, in full',
                     'The current V2 plan with every level and condition, or a plain statement that nothing qualified.'],
    '/methodology': ['Methodology — how a V2 plan is built and graded',
                     'Risk-first plans, next-session entry, three targets with fixed exit sizes, simulated fills and how the forward record is counted.'],
    '/sources':     ['Data sources — where each number comes from',
                     'The feed behind every figure on this site, and how fresh each one is.'],
    '/terms':       ['Terms', 'Terms of use for signal.askakshay.com.'],
    '/privacy':     ['Privacy', 'What this site stores, and what it does not.'],
    '/join':        ['The morning list', 'Join the list for the daily email. It is not being sent yet; the brief is on the site every morning.'],
    '/research':    ['Retired — the V1 research floor', 'Signal V1 was retired on 1 October 2026.'],
    '/buoy':        ['Retired — BUOY', 'Signal V1 was retired on 1 October 2026.'],
    /* THESE THREE HAD NO ROW, so each fell through to META['/'] and told a
       crawler, a link preview and the tab bar that it was the front page —
       same title, same description, same canonical. An external audit read it
       as "/about returns the home page". It did, in the head. */
    '/about':       ['About — who builds Signal',
                     'Signal is built by Akshay Kothari, a Chartered Accountant working in FP&A: what the site is, what it is not, and when its V2 record began.'],
    '/disclaimer':  ['Disclaimer — educational research, not investment advice',
                     'Signal is not registered with SEBI as a Research Analyst or Investment Adviser. Nothing on it is a recommendation or personalised advice.'],
    '/disclosures': ['Disclosures — conflicts, incentives and who pays for this',
                     'Who pays for Signal (nobody), personal positions, employment, and the conflict of an author grading his own engines — stated plainly.'],
    '/404':         ['Not found — signal.askakshay.com',
                     'There is no page at this address.'],
  };
  const ORIGIN = 'https://signal.askakshay.com';
  const setHead = (route) => {
    const [title, desc] = META[route] || META['/'];
    const url = ORIGIN + (location.pathname === '/' ? '/' : location.pathname);
    document.title = title;
    const set = (sel, attr, val) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute(attr, val);
    };
    set('meta[name="description"]', 'content', desc);
    set('link[rel="canonical"]', 'href', url);
    set('meta[property="og:title"]', 'content', title);
    set('meta[property="og:description"]', 'content', desc);
    set('meta[property="og:url"]', 'content', url);
    set('meta[name="twitter:title"]', 'content', title);
    set('meta[name="twitter:description"]', 'content', desc);
    /* A 404 MUST NOT ASK TO BE INDEXED, AND MUST NOT CLAIM A CANONICAL.
     * The tag is written once in index.html as index,follow and was never
     * touched again, so a mistyped URL served a noindex-worthy page with an
     * explicit invitation to index it — and a canonical pointing at the bad
     * path, which asks the crawler to treat that URL as the preferred one. */
    const missing = route === '/404';
    set('meta[name="robots"]', 'content',
        missing ? 'noindex,follow' : 'index,follow,max-image-preview:large');
    const can = document.querySelector('link[rel="canonical"]');
    if (can) { if (missing) can.removeAttribute('href'); else can.setAttribute('href', url); }

    /* ── STRUCTURED DATA PER ROUTE, NOT ONE BLOCK FOR THE WHOLE SITE ────────
     *
     * index.html carries a WebSite and a Person and nothing else, so every one
     * of eighteen routes described itself to a crawler as the front page. The
     * ledger, the screen and the IPO board are different things and say so
     * here: a WebPage with this route's own name, description and URL, inside
     * the site graph that already exists.
     *
     * It is written into a SECOND script tag that this function owns, rather
     * than editing the one in the HTML — that block is static, prerendered and
     * correct, and rewriting it from JS would mean the served HTML and the
     * hydrated page disagreed about the site's identity.
     *
     * A 404 gets none of it. Describing a page that does not exist to a
     * crawler is the same claim the robots tag has just withdrawn. */
    let ld = document.getElementById('ld-route');
    if (missing) { if (ld) ld.remove(); return; }
    if (!ld) {
      ld = document.createElement('script');
      ld.type = 'application/ld+json';
      ld.id = 'ld-route';
      document.head.appendChild(ld);
    }
    const SITE_ID = ORIGIN + '/#website';
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': url + '#page',
      url, name: title, description: desc,
      inLanguage: 'en-IN',
      isPartOf: { '@id': SITE_ID },
      about: { '@id': ORIGIN + '/#akshay' },
      breadcrumb: {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Signal', item: ORIGIN + '/' },
        ].concat(route === '/' ? [] : [
          { '@type': 'ListItem', position: 2, name: (WHERE[route] || title.split(' — ')[0]), item: url },
        ]),
      },
    });
  };

  /* The route's own name, shown beside the brand. Empty on Today, because a
   * breadcrumb reading "Today" while you are looking at Today is noise. */
  const WHERE = { '/': '', '/markets': 'Market', '/ideas': 'Retired', '/ipo': 'IPO',
                  '/opportunities': 'Opportunities', '/performance': 'Performance', '/plan/:id': 'Plan',
                  '/screen': 'Screen', '/signals': 'Retired', '/brief': 'Brief', '/watch': 'Watchlist',
                  '/engines': 'Retired', '/radar': 'Market · Radar', '/discover': 'All tools', '/buoy': 'Retired', '/research': 'Retired',
                  '/map': 'Market · Map', '/reads': 'Weekly reads', '/heat': 'Market · Heatmap',
                  '/join': 'The brief', '/methodology': 'Methodology',
                  '/sources': 'Data sources', '/terms': 'Terms', '/privacy': 'Privacy' };

  async function render() {
    const path = routeOf();
    resetFresh();
    /* Restart the transition on every navigation. Removing the class and
       forcing a reflow before re-adding is the only reliable way to replay a
       CSS animation on an element that is not being replaced. */
    try {
      main.classList.remove('is-nav');
      void main.offsetWidth;
      main.classList.add('is-nav');
    } catch (e) { /* motion is never a reason to fail a route */ }
    /* Both the home page and /ipo render IPO cards, so this cannot reset in
       one route: a reader who opened Home first would find /ipo's stamp
       already "shown" and see no vintage at all. */
    ipoNoteShown = false;
    // Title, description, canonical and the social card, every navigation.
    setHead(path);
    const where = document.getElementById('barWhere');
    if (where) where.textContent = WHERE[path] || '';
    /* The tab bar scrolls on a phone, so the active tab can be off-screen.
     * Bring it into view — a "you are here" marker nobody can see is not one. */
    const activeTab = document.querySelector(`.tabs a[data-route="${path}"]`);
    if (activeTab && activeTab.scrollIntoView) {
      try { activeTab.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {}
    }
    // Leaving the brief forgets which signal was pinned, so coming back by the
    // tab picks the best current setup rather than resurrecting an old one.
    if (path !== '/brief') briefPick = null;
    /* A GROUP IS CURRENT WHEN SOMETHING INSIDE IT IS.
     * Otherwise the bar shows no active state at all on five of the nine
     * routes — the reader is on Screen and the navigation looks like they are
     * nowhere. The group also names the page it is holding, so "Discover"
     * reads "Discover · Screen" and the collapsed bar still answers "where am
     * I" without being opened. */
    document.querySelectorAll('.tabs a, .bar-right a.icon-btn[href]').forEach(a =>
      (a.dataset.route || a.getAttribute('href')) === path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    document.querySelectorAll('.tabs .tabg').forEach(g => {
      const inside = g.querySelector(`a[data-route="${path}"]`);
      g.classList.toggle('is-here', !!inside);
      const label = g.querySelector('summary > span');
      if (!label) return;
      const base = label.dataset.base || (label.dataset.base = label.textContent.trim());
      label.textContent = inside ? `${base} · ${inside.querySelector('b').textContent}` : base;
      // Navigating closes the menu; leaving it open over the page you just
      // asked for is a menu that will not get out of the way.
      g.open = false;
    });
    // Scroll first, then paint: painting first lets the old route's height
    // hold the scroll position and the new route lands mid-page.
    window.scrollTo(0, 0);
    /* Only a real navigation animates. The 60-second refresh calls R[path]()
     * directly and never comes through here, so the page someone is reading is
     * never faded out from under them. */
    /* THE CROSS-FADE IS THE BROWSER'S IF IT HAS ONE.
     *
     * startViewTransition snapshots the old page, runs the callback, and
     * cross-fades to the new one — which is smoother than the class-driven
     * routeIn below because the OLD content is still on screen during the
     * fade rather than being replaced by a blank frame first.
     *
     * Feature-detected and never awaited: where it does not exist, or the
     * reader has asked for reduced motion, the existing animation runs and
     * nothing else changes. */
    const useVT = typeof document.startViewTransition === 'function'
      && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!useVT) {
      main.classList.remove('route-in');
      void main.offsetWidth;                     // restart the animation
      main.classList.add('route-in');
    } else {
      main.classList.remove('route-in');
    }
    // A new route reads a different set of feeds; the probe must follow it.
    routeUrls = new Set();
    heavyTried = false;      // a fresh visit may retry the deferred feeds
    homeLacked = false;
    const run = async () => {
      try { await R[path](); } catch (err) {
        paint(fail('This section', err && err.message ? err.message : 'unexpected error'));
      }
    };
    if (useVT) {
      /* THE ABORT IS ABOUT THE ANIMATION, NOT THE RENDER.
       *
       * A route that fetches for more than about four seconds blows the View
       * Transition API's update-callback deadline. The spec's response is to
       * SKIP THE ANIMATION and reject `ready` — the callback keeps running and
       * the page paints normally. Two bugs came out of not knowing that:
       *
       *  · `ready` was never touched, so its rejection was unhandled and
       *    surfaced as a page error — "Transition was aborted because of
       *    timeout in DOM update" — on any slow route;
       *  · the catch below re-ran `run()`, which re-fetched and re-painted a
       *    route that had already rendered. On a slow connection, the exact
       *    condition that triggered it, the remedy was a second full load.
       *
       * `run` swallows its own errors, so updateCallbackDone can only settle
       * fulfilled; there is nothing left for a fallback render to fix. Both
       * animation promises are explicitly ignored instead. */
      const vt = document.startViewTransition(run);
      vt.ready.catch(() => {});                  // skipped animation, not a failure
      vt.finished.catch(() => {});
      await vt.updateCallbackDone.catch(() => {});
    } else {
      await run();
    }
  }

  /* <details> gives open/close and keyboard activation for free but does not
   * close on outside click or Escape — both of which a reader expects from
   * anything that behaves like a menu. */
  document.addEventListener('click', e => {
    document.querySelectorAll('.tabs .tabg[open]').forEach(g => {
      if (!g.contains(e.target)) g.open = false;
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.tabs .tabg[open]');
    if (!open) return;
    open.open = false;
    const sum = open.querySelector('summary');
    if (sum) sum.focus();
  });

  /* A pushState fires nothing, so navigation is driven by two things: the
   * click interceptor below, and the back/forward button. */
  /* #moreBtn is gone from the bar — its slot is the Ledger and its contents
     are the provenance block at the foot of that page. No binding to keep. */

  window.addEventListener('popstate', render);

  /* INTERNAL LINKS ARE INTERCEPTED, EXTERNAL ONES ARE NOT.
   * A plain left-click on a same-origin link routes in place; anything a
   * reader does to open a link in a new tab — middle click, cmd, ctrl, shift,
   * target=_blank, download — is left alone, because breaking that is the
   * fastest way to make an app feel like it is fighting the browser. */
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.getAttribute('rel') === 'external') return;
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('/') || href.startsWith('//')) return;   // external or protocol-relative
    if (href.startsWith('/api/')) return;
    ev.preventDefault();
    go(href);
  });

  /* OLD SHARED LINKS. /#/markets becomes /markets before anything renders, so
   * a link posted months ago lands on the page it named rather than the front
   * page. replaceState, not pushState: the fragment form should not become a
   * back-button step. */
  if (/^#\/[a-z]/i.test(location.hash || '')) {
    history.replaceState(null, '', location.hash.slice(1) + location.search);
  }

  /* LIVE, AROUND THE CLOCK.
   *
   * The page was a snapshot: whatever the data said when you opened it, until
   * you reloaded. A market page left open on a second monitor should not go
   * quietly stale.
   *
   * setInterval, not requestAnimationFrame — rAF does not run in a hidden tab
   * or on a phone with the screen off, which is exactly when a page is left
   * open. The same trap is documented in app.js on the broadsheet.
   *
   * Sixty seconds while visible. When the tab is hidden the timer keeps
   * running but the refresh is SKIPPED, and one runs immediately on return —
   * so a tab left open overnight makes ~0 requests and is current the moment
   * it is looked at again, instead of replaying eight hours of them.
   */
  let lastRefresh = Date.now();
  async function refresh(force) {
    if (!force && document.visibilityState === 'hidden') return;
    paintTicker();
    if (document.getElementById('sheet')?.open) return;   // never yank an open card
    if (document.querySelector('dialog.cmd[open]')) return;      // nor an open search
    /* NEVER REPAINT UNDER SOMEONE'S HANDS. Typing in the screen search or the
     * alert form and having the field replaced mid-word is the worst version
     * of this. The data can wait sixty seconds. */
    const ae = document.activeElement;
    if (!force && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'
                      || ae.tagName === 'SELECT' || ae.isContentEditable)) return;

    /* THE REFRESH USED TO CLOSE WHAT YOU HAD OPEN.
     *
     * Expand a market row to read its 52-week detail and sixty seconds later
     * it shut by itself — measured: openDrawers 1 → 0 at the refresh tick.
     * The route repaints wholesale, so every expanded row went with it, and
     * the reader had no idea why.
     *
     * The instrument NAME is the stable key here: the drawer ids are minted
     * fresh on every paint, so they cannot be matched across one. */
    const wasOpen = [...document.querySelectorAll('.mk[aria-expanded="true"]')]
      .map(b => (b.querySelector('.mk-nm') || {}).textContent)
      .filter(Boolean).map(t => t.trim());
    const y = window.scrollY;

    /* PROBE BEFORE PAINTING.
     *
     * Re-fetch exactly the feeds this route read last time and compare their
     * bodies. If not one of them changed there is nothing to show, and the
     * cheapest, least annoying repaint is the one that does not happen. The
     * render that follows a changed probe re-reads the same URLs out of MICRO,
     * so this costs one set of requests, not two. */
    const probe = [...routeUrls];
    if (probe.length) {
      const rev = feedRev;
      try { await Promise.all(probe.map(u => get(u))); }
      catch (e) { return; }                    // offline: keep what is on screen
      if (feedRev === rev) return;             // nothing moved
    }

    /* What the numbers said BEFORE the repaint, so the ones that moved can be
     * pointed at afterwards. See flashChanged(). */
    const before = snapNums();

    lastRefresh = Date.now();
    try { await R[routeOf()](); } catch (e) { /* a failed refresh keeps what is on screen */ }

    if (wasOpen.length) {
      document.querySelectorAll('.mk').forEach(b => {
        const nm = ((b.querySelector('.mk-nm') || {}).textContent || '').trim();
        if (!wasOpen.includes(nm)) return;
        const d = document.getElementById(b.getAttribute('aria-controls'));
        if (!d) return;
        const inner = d.firstElementChild;
        if (inner && !inner.innerHTML) {
          const r = MKDATA.get(b.getAttribute('aria-controls'));
          if (r) inner.innerHTML = mkDrawer(r);
        }
        b.setAttribute('aria-expanded', 'true');
        d.classList.add('open');
      });
    }
    // A repaint can change the document height; put the reader back where they
    // were rather than wherever the new layout happens to land them.
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);

    const moved = diffNums(before);
    flashChanged(moved);
    announceChanged(moved);
  }

  /* ── WHAT CHANGED, MADE VISIBLE ─────────────────────────────────────────
   *
   * A silent repaint is indistinguishable from a dead page. Sixty seconds
   * pass, numbers move, and nothing tells the reader WHICH ones — so either
   * they re-read the whole table or they trust none of it. Both are the same
   * failure: the page is live and does not look it.
   *
   * The repaint rebuilds the DOM from scratch, so a cell cannot be followed
   * across it by identity. It can be followed by MEANING: every row carries
   * its instrument in data-sym and every cell its column in data-l, and that
   * pair names the same quantity before and after.
   *
   * Only cells whose printed text actually changed are marked, and they are
   * marked in the direction the number moved. A cell that merely re-rendered
   * to the same value stays quiet — a flash that fires on every tick teaches
   * the reader to ignore it, which is worse than not having one.
   */
  const NUMSEL = '[data-sym] .x, [data-sym] .m';
  const numKey = c => {
    const row = c.closest('[data-sym]');
    const sym = row && row.getAttribute('data-sym');
    return sym ? sym + '|' + (c.getAttribute('data-l') || c.className) : null;
  };
  function snapNums() {
    const m = new Map();
    document.querySelectorAll(NUMSEL).forEach(c => {
      const k = numKey(c);
      if (k) m.set(k, c.textContent.trim());
    });
    return m;
  }
  const numOf = t => {
    const n = parseFloat(String(t).replace(/[^0-9.+-]/g, ''));
    return isFinite(n) ? n : null;
  };
  /* THE DIFF IS COMPUTED ONCE AND USED TWICE.
   *
   * It used to be computed inside the flash, which is why only sighted
   * readers ever learned anything from it: the flash returns early under
   * prefers-reduced-motion, so the diff was never taken at all for a reader
   * who had asked for less movement — and the announcement now depends on it.
   * Separating them means neither can silently disable the other. */
  function diffNums(before) {
    const out = [];
    if (!before || !before.size) return out;
    document.querySelectorAll(NUMSEL).forEach(c => {
      const k = numKey(c);
      if (!k || !before.has(k)) return;
      const was = before.get(k), now = c.textContent.trim();
      if (was === now) return;
      const a = numOf(was), b = numOf(now);
      const row = c.closest('[data-sym]');
      out.push({
        cell: c,
        sym: (row && row.getAttribute('data-sym')) || '',
        label: c.getAttribute('data-l') || '',
        now,
        dir: a != null && b != null && b !== a ? (b > a ? 1 : -1) : 0,
      });
    });
    return out;
  }

  function flashChanged(moved) {
    if (!moved.length) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    moved.forEach(({ cell: c, dir: d }) => {
      c.classList.remove('chg-up', 'chg-dn', 'chg');
      // Force a reflow. Without it a cell that moves on two consecutive ticks
      // keeps the class it already had and sits still through the second one.
      void c.offsetWidth;
      c.classList.add(d ? (d > 0 ? 'chg-up' : 'chg-dn') : 'chg');
      setTimeout(() => c.classList.remove('chg-up', 'chg-dn', 'chg'), 1500);
    });
  }

  /* ── AND THE SAME THING, IN WORDS ───────────────────────────────────────
   *
   * NOT GATED ON prefers-reduced-motion. An announcement is not an animation.
   * A reader who has asked the operating system for less movement has asked
   * about movement, not about being told what happened — and on a page that
   * repaints itself every sixty seconds, not being told is the difference
   * between a live page and a dead one.
   *
   * A SUMMARY, NOT A FIREHOSE. A refresh can move sixty cells; reading sixty
   * of them aloud takes longer than the interval before the next refresh, so
   * the reader would never hear the end of one update before the next began.
   * Three named movers and a count is the whole sentence.
   *
   * SILENT WHEN NOTHING MOVED. refresh() already returns before painting when
   * no feed changed, so this is only reached on a real update — but a live
   * region written with the same text twice announces twice in some screen
   * readers, and a page that says "3 figures updated" every minute whether or
   * not they did is the audible version of a flash that fires on every tick.
   */
  function announceChanged(moved) {
    const el = document.getElementById('liveNews');
    if (!el) return;
    if (!moved.length) { el.textContent = ''; return; }
    const named = moved.filter(m => m.sym && m.label);
    const lead = named.slice(0, 3).map(m =>
      `${m.sym} ${m.label} ${m.now}${m.dir ? (m.dir > 0 ? ', up' : ', down') : ''}`);
    const rest = moved.length - lead.length;
    const sentence = [
      `${moved.length} figure${moved.length === 1 ? '' : 's'} updated`,
      lead.length ? lead.join('. ') : '',
      rest > 0 && lead.length ? `and ${rest} more` : '',
    ].filter(Boolean).join('. ') + '.';
    /* ── THE CLEAR HAS TO LAND IN A LATER TASK ──────────────────────────
     * A live region announces a CHANGE. Assigning the same string twice is
     * not one, so two identical updates in a row are reported once — and the
     * obvious remedy, clearing it first, does nothing at all: the
     * accessibility tree is computed when the task ends, so a clear and a set
     * in the same task are only ever seen as the set.
     *
     * Verified rather than assumed — the first version of this did exactly
     * that and a MutationObserver recorded the final text for both records.
     *
     * The timer is cancelled on re-entry, so a refresh that lands while the
     * previous announcement is still pending replaces it instead of queueing
     * two sentences a reader would hear back to back. */
    clearTimeout(announceChanged._t);
    el.textContent = '';
    announceChanged._t = setTimeout(() => { el.textContent = sentence; }, 60);
  }

  /* ── THE TICKER ──────────────────────────────────────────────────────────
   *
   * Twelve instruments across the top of every page, chosen rather than
   * dumped: the three Indian indices a reader here actually checks, the two
   * rupee crosses, gold and crude, then the two US indices that set tomorrow's
   * open. /api/ticker carries 71 across eleven segments; putting all of them
   * up here would be the same as putting none.
   *
   * WHAT IT DOES THAT A MARQUEE CANNOT:
   *
   *  - It says when a market is SHUT. Every Indian row above was "closed" at
   *    the moment this was written, and a scrolling strip would have shown
   *    those prices moving past exactly as it shows a live one. A closed row
   *    is dimmed and carries the word.
   *  - It holds still, so a number can be read and compared to the one beside
   *    it. Scrolling is the reader's, on a swipe or an arrow key.
   *  - The sign is on the number, not only in the colour. Same rule as every
   *    other figure on this site.
   *  - It updates on the existing 60-second refresh rather than owning a
   *    timer, so it cannot drift out of step with the page under it.
   */
  /* ── THE TICKER ──────────────────────────────────────────────────────────
   *
   * Every instrument the markets page carries — all ten segments through to
   * crypto, ~66 rows — moving slowly enough to read.
   *
   * IT MOVES ON A CSS ANIMATION, NOT requestAnimationFrame. The distinction is
   * the whole reason the first version of this refused to move at all: rAF
   * does not run in a background tab, so an rAF marquee freezes the moment you
   * switch away and resumes mid-stride when you come back. A CSS transform
   * animation is driven by the compositor, costs no main-thread work, and
   * keeps its own time whether or not the tab is looked at.
   *
   * SPEED IS SET FROM THE CONTENT, NOT GUESSED. A fixed duration makes a long
   * strip fast and a short one crawl; the duration is computed so the strip
   * always travels at the same ~45 pixels per second, which is slow enough to
   * read a five-character price without tracking it.
   *
   * It pauses on hover and on keyboard focus, so a number can be held still to
   * be read, and it does not move at all under prefers-reduced-motion — where
   * the strip becomes an ordinary scrollable row.
   *
   * The list is duplicated once and translated by exactly -50%, which is what
   * makes the loop seamless: the second copy is under the cursor at the moment
   * the first runs out. aria-hidden on the copy so a screen reader is not read
   * the market twice.
   */
  const TKR_PX_PER_SEC = 60;
  async function paintTicker() {
    const host = document.getElementById('tkr');
    const row = document.getElementById('tkrRow');
    if (!host || !row) return;
    const r = await get('/api/ticker');
    if (!r.ok || !r.data || !Array.isArray(r.data.segments)) return;

    const segs = (r.data.segments || []).filter(sg => (sg.items || []).length);
    if (!segs.length) return;
    const cell = i => {
      const closed = String(i.session || '').toLowerCase() === 'closed';
      const d = dir(i.change_pct);
      return `<span class="tkr-i${closed ? ' is-shut' : ''}">
        <b class="tkr-n">${esc(i.name)}</b>
        <span class="tkr-p">${esc(i.price ?? '—')}</span>
        <span class="tkr-c ${d}">${pct(i.change_pct)}</span>
      </span>`;
    };
    // Segment labels travel with the strip. Without them 66 instruments are an
    // undifferentiated stream and "Copper" arrives with no clue it is a metal
    // rather than a mid-cap.
    const strip = segs.map(sg =>
      `<span class="tkr-seg">${esc(sg.icon || '')} ${esc(sg.label)}</span>` +
      sg.items.map(cell).join('')).join('');

    row.innerHTML = `<div class="tkr-t" id="tkrT"><div class="tkr-h">${strip}</div>` +
                    `<div class="tkr-h" aria-hidden="true">${strip}</div></div>`;
    host.hidden = false;

    /* Duration from measured width, so the speed is the same on a phone and a
     * wide desktop. Measured after paint — before it, scrollWidth is 0 and the
     * animation would be instant. */
    const t = document.getElementById('tkrT');
    const one = t && t.firstElementChild;
    if (one) {
      const w = one.scrollWidth || 0;
      if (w > 0) t.style.setProperty('--tkr-dur', (w / TKR_PX_PER_SEC).toFixed(1) + 's');
    }
  }

  /* ── SCROLL PROGRESS ─────────────────────────────────────────────────────
   *
   * Ported from news.askakshay.com, which has had it for months. These routes
   * run long — the brief is twelve sections, the screen is 750 rows — and on a
   * phone the native scrollbar is either hidden entirely or a hairline that
   * tells you nothing.
   *
   * rAF IS CORRECT HERE, AND WRONG FOR THE TICKER TWO FUNCTIONS UP. The
   * difference is the event: a scroll handler only has work to do while
   * somebody is scrolling, which cannot happen in a background tab, so rAF
   * not running there costs nothing. A marquee has to keep time whether or
   * not it is watched, which is exactly what rAF refuses to do.
   *
   * The rAF is a coalescer, not an animation loop — scroll fires far faster
   * than the screen refreshes, and without it this recomputes layout dozens of
   * times per frame.
   */
  (() => {
    const bar = document.getElementById('scrollprog');
    if (!bar) return;
    let queued = false;
    const draw = () => {
      const d = document.documentElement;
      const h = d.scrollHeight - window.innerHeight;
      const pc = h > 0 ? Math.min(100, Math.max(0, window.scrollY / h * 100)) : 0;
      bar.style.width = pc + '%';
      // Announced as well as drawn: the element is a progressbar to the
      // assistive tree, and a bar with no value is furniture.
      bar.setAttribute('aria-valuenow', Math.round(pc));
      queued = false;
    };
    addEventListener('scroll', () => {
      if (!queued) { queued = true; requestAnimationFrame(draw); }
    }, { passive: true });
    // Route changes replace <main> wholesale, so the height it was measured
    // against is gone; recompute rather than leave the bar describing the
    // previous page.
    addEventListener('hashchange', () => setTimeout(draw, 60));
    addEventListener('resize', draw, { passive: true });
    draw();
  })();

  paintTicker();
  setInterval(() => refresh(false), 60000);
  document.addEventListener('visibilitychange', () => {
    // Back on screen after more than a minute away: refresh at once.
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 60000) refresh(true);
  });

  /* ── EDITION FRESHNESS ──────────────────────────────────────────────────
   *
   * The feeds behind this site are rebuilt once a day. A tab left open
   * overnight kept yesterday's edition and had nothing to say about it — two
   * tabs on the same URL, opened a day apart, disagreeing.
   *
   * The broadsheet answers this by reloading the page, and it is right to:
   * there the HTML *is* the edition, server-rendered once a day, so a reload
   * is the only way to get the new one. Here it is not. Every number on this
   * page was fetched by the renderer after load, which means a new edition is
   * picked up by re-running the refresh the page already does every minute.
   *
   * So this does NOT reload. A reload would throw away the reader's scroll
   * position, their open cards, their sort, their filter and their half-typed
   * search — all of which refresh() is already careful to keep. It swaps the
   * data underneath them and says that it did.
   *
   * Two details worth keeping:
   *   · The first poll RECORDS the build id and announces nothing. Without
   *     that, every cold load has no id to compare against and would either
   *     announce a new edition to someone who just arrived on it, or need a
   *     second request to say the same thing.
   *   · A hidden tab is swapped silently. There is nobody to tell, and a
   *     banner discovered on return is stale news about news.
   */
  (function () {
    /* TWO KINDS OF STALE, AND ONLY ONE OF THEM CAN BE FIXED IN PLACE.
     *
     * New DATA needs no reload: every number was fetched after load, so
     * re-running the refresh picks it up and the reader keeps their scroll,
     * their filters and their open cards.
     *
     * New CODE is the opposite, and this is the case I got wrong. I reasoned
     * that the service worker is network-first for the shell, so a deploy
     * would be picked up "on the next navigation" — but this is a hash-routed
     * SPA and there IS no next navigation. A tab left open runs the
     * JavaScript it loaded when it opened, for as long as it stays open,
     * across any number of deploys. Every fix shipped into that window was
     * invisible to the person looking at the page, and the page said nothing.
     *
     * build.json carries a hash of the shell files. It is a .json, so the
     * service worker's fetch handler skips it and it always comes from the
     * network. Compared against the hash present when this tab loaded, a
     * difference means the code on the server is not the code running here.
     */
    let edition = null, build = null, busy = false, offered = false;
    // Last deliberate interaction. Passive listeners so this cannot cost a
    // frame on scroll.
    let lastTouch = 0;
    const touch = () => { lastTouch = Date.now(); };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
      document.addEventListener(ev, touch, { passive: true });
    const bar = document.getElementById('editionBar');
    const txt = bar && bar.querySelector('.ed-t');
    const go  = bar && bar.querySelector('.ed-go');

    const show = (html, withReload) => {
      if (!bar || !txt) return;
      txt.innerHTML = html;
      if (go) go.hidden = !withReload;
      bar.hidden = false;
      requestAnimationFrame(() => bar.classList.add('on'));
    };

    const grab = async url => {
      const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
      return r.ok ? r.json() : null;
    };

    async function check() {
      if (busy) return;
      busy = true;
      try {
        const [ed, bd] = await Promise.all([
          grab('/edition.json').catch(() => null),
          grab('/build.json').catch(() => null),
        ]);

        /* CODE FIRST. If the running app is out of date then so is every
         * conclusion the reader draws from it, including about the data. */
        if (bd && bd.build) {
          if (build === null) build = bd.build;             // first look: record
          else if (bd.build !== build && !offered) {
            offered = true;
            /* CLEAR THE SHELL CACHE BEFORE ANY RELOAD.
             *
             * The service worker holds signal.js and signal.css. It is
             * network-first, so a healthy reload picks up the new copy — but
             * on a flaky connection it falls back to the cache and serves the
             * OLD code again, which produces a page that keeps asking to be
             * reloaded and never changes when you do. Deleting the caches
             * first makes the reload unambiguous. */
            try {
              if (window.caches) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
              }
            } catch (e) { /* private mode, or no cache API */ }
            // Nothing is lost by reloading a tab nobody is looking at, and a
            // reader who returns to a stale tab should find it current.
            // Guarded once per build so a mid-deploy mismatch cannot loop.
            const KEY = 'sig:reloaded';
            let tried = null;
            try { tried = sessionStorage.getItem(KEY); } catch (e) { /* private mode */ }

            /* RELOAD WITHOUT ASKING WHEN NOTHING WOULD BE LOST.
             *
             * The first version only did this for a hidden tab and showed a
             * banner to a visible one. That is too polite: it makes a reader
             * responsible for noticing a bar and tapping it, and when they do
             * not, they sit on stale code looking at stale numbers and
             * reasonably conclude nothing was fixed. That happened.
             *
             * "Nothing would be lost" is checkable rather than assumed: no
             * open card or search, nothing focused, no text selected, and no
             * interaction in the last fifteen seconds. If any of those is
             * false the bar is shown and the reader decides — a page that
             * reloads out from under someone mid-read is the worse failure.
             *
             * Guarded once per build id either way, so a mid-deploy mismatch
             * cannot loop. */
            const busyNow = document.getElementById('sheet')?.open
              || document.querySelector('dialog.cmd[open]')
              || (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))
              || (window.getSelection && String(window.getSelection()).length > 0)
              || (Date.now() - lastTouch < 15000);

            if ((document.visibilityState === 'hidden' || !busyNow) && tried !== bd.build) {
              try { sessionStorage.setItem(KEY, bd.build); } catch (e) { /* private mode */ }
              location.reload();
              return;
            }
            show('<b>This page has been updated.</b> Reload to get the new version — ' +
                 'nothing you are looking at is lost.', true);
            return;                                          // code beats data
          }
        }

        if (ed && ed.build_id) {
          if (edition === null) { edition = ed.build_id; }    // first look: record
          else if (ed.build_id !== edition) {
            edition = ed.build_id;
            await refresh(true);                             // swapped in place
            if (document.visibilityState === 'hidden') return;
            show('New edition' + (ed.build_date ? ' · <span class="ed-when">' +
                 esc(ed.build_date) + '</span>' : '') + ' — this page is now showing it.', false);
          }
        }
      } catch (e) {
        /* offline, or a host serving neither file — neither is worth saying */
      } finally { busy = false; }
    }

    if (bar) {
      const x = bar.querySelector('.ed-x');
      if (x) x.addEventListener('click', () => {
        bar.classList.remove('on');
        setTimeout(() => { bar.hidden = true; }, 280);
      });
      if (go) go.addEventListener('click', () => location.reload());
    }
    document.addEventListener('visibilitychange', () => {
      // Coming back to the tab is exactly when this has changed.
      if (document.visibilityState === 'visible') check();
    });
    check();
    // Two minutes, not ten: this is now the mechanism that decides whether a
    // reader is looking at the current site at all.
    setInterval(check, 2 * 60 * 1000);
  })();

  /* ── theme ─────────────────────────────────────────────────────────────── */
  const root = document.documentElement;
  // Light is the default; the toggle is the only thing that changes it, and
  // the choice persists. Deliberately not following prefers-color-scheme: the
  // page is designed light first, and an OS set to dark should not silently
  // serve a different design than the one a first-time reader is shown.
  /* THE MACHINE GETS A VOTE, THE READER GETS A VETO.
   *
   * This read "saved === 'dark' ? dark : light", so a reader whose every
   * other application is dark landed on a white page and had to say so by
   * hand, on every device. The OS preference is a preference; ignoring it is
   * a choice this site had made by accident.
   *
   * An explicit choice still wins and still persists — that is the veto. Only
   * when nothing has been chosen does the system decide. And once a reader has
   * chosen, later OS changes leave them where they put themselves. */
  const saved = (() => { try { return localStorage.getItem('sig:theme'); } catch (e) { return null; } })();
  const prefersDark = matchMedia('(prefers-color-scheme: dark)');
  root.setAttribute('data-theme',
    saved === 'dark' || saved === 'light' ? saved
      : (prefersDark.matches ? 'dark' : 'light'));

  // A reader who has never chosen follows the system as it changes — someone
  // on an automatic day/night schedule should not have this one tab stay lit.
  prefersDark.addEventListener('change', e => {
    let chosen = null;
    try { chosen = localStorage.getItem('sig:theme'); } catch (err) { /* private mode */ }
    if (chosen === 'dark' || chosen === 'light') return;
    root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
  });
  document.getElementById('cmdkBtn')?.addEventListener('click', openCmd);
  /* ── BACK TO TOP ────────────────────────────────────────────────────────
   * The Screen runs to forty rows and the brief to roughly 1,400 words, and
   * getting back to the tabs meant a long scroll or a keyboard shortcut
   * nobody was told about. It appears past two viewports — before that there
   * is nothing to come back from, and a button that does nothing is worse
   * than no button.
   *
   * Scroll is listened to passively and read on a timer rather than on every
   * event: a scroll handler that touches the DOM on each frame is how a
   * sticky header ends up thrashing, which this codebase has done before. */
  (function () {
    const btn = document.getElementById('toTop');
    if (!btn) return;
    let ticking = false;
    const sync = () => {
      ticking = false;
      const show = window.scrollY > window.innerHeight * 2;
      if (show === !btn.hidden) return;          // only touch the DOM on a change
      btn.hidden = !show;
    };
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      setTimeout(sync, 120);
    }, { passive: true });
    btn.addEventListener('click', () => {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      // Send focus somewhere sensible rather than leaving it on a button that
      // just hid itself.
      const first = document.querySelector('.tabs a[aria-current="page"]') || document.body;
      if (first.focus) first.focus({ preventScroll: true });
    });
    sync();
  })();

  /* DENSITY. Stamped before first paint by the inline script in index.html
   * for the same reason the theme is: a reader who chose compact should not
   * watch the page relax and then tighten. */
  const densBtn = document.getElementById('densBtn');
  if (densBtn) {
    const syncDens = () => {
      const on = root.getAttribute('data-density') === 'compact';
      densBtn.setAttribute('aria-pressed', String(on));
      densBtn.title = on ? 'Comfortable rows' : 'Compact rows';
      densBtn.setAttribute('aria-label', densBtn.title);
    };
    syncDens();
    densBtn.addEventListener('click', () => {
      const on = root.getAttribute('data-density') === 'compact';
      if (on) root.removeAttribute('data-density');
      else root.setAttribute('data-density', 'compact');
      try { localStorage.setItem('sig:density', on ? 'comfortable' : 'compact'); }
      catch (e) { /* private mode */ }
      syncDens();
    });
  }

  /* ── MORE: EVERY TOOL AND THE SETTINGS, IN ONE SHEET ──────────────────
   * The bar holds five destinations and nothing else. Everything a reader
   * reaches less often — the ten research tools, the watchlist, how the
   * numbers are made, the sibling products, theme and density — is one tap
   * away here. It is filled from DISCOVER, the same table /discover renders,
   * so the sheet and the page cannot list different tools.
   *
   * A native modal <dialog>: showModal() moves focus in and holds it, Escape
   * closes it, and the browser returns focus to the button. Clicking the
   * backdrop closes it too, because a sheet that only a small X dismisses is
   * a sheet that traps a thumb. Following a link closes it before the route
   * paints, so the page asked for is never under a sheet. */
  (() => {
    const btn = document.getElementById('moreBtn');
    const dlg = document.getElementById('moreDlg');
    const body = document.getElementById('moreBody');
    if (!btn || !dlg || !body || typeof dlg.showModal !== 'function') return;
    /* PRIMARY is the phone tab bar. Market is a desktop nav item only, so
       on a phone the sheet is its way in and it must stay listed here. */
    const PRIMARY = new Set(['/', '/opportunities', '/watch', '/performance']);
    const groups = [
      ['Research tools', DISCOVER.filter(([h]) => !PRIMARY.has(h)).map(([h, n, sub]) => [h, n, sub])],
      ['Your desk', [['/brief', 'The brief', 'The current plan, in full'],
                     ['/discover', 'All tools', 'Every way into the screen, with what each is for']]],
      ['How the record is made', [['/methodology', 'Methodology', 'How every number here is made'],
                     ['/sources', 'Data sources', 'Where each figure comes from, and how fresh'],
                     ['/about', 'About', 'Who builds this, and why the losses are published']]],
      ['Also from this desk', [[VISION_URL + '/', 'Vision ↗', 'Research one company in depth'],
                     ['https://news.askakshay.com/', 'The newspaper ↗', 'The long-form daily read']]],
    ];
    body.innerHTML = groups.map(([g, items]) => `<section class="more-g"><h3>${esc(g)}</h3>
      <div class="more-l">${items.map(([h, n, sub]) => `<a href="${esc(h)}"${/^https?:/.test(h) ? ' rel="noopener"' : ''}>
        <b>${esc(n)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</a>`).join('')}</div></section>`).join('');
    btn.addEventListener('click', () => { dlg.showModal(); btn.setAttribute('aria-expanded', 'true'); });
    dlg.addEventListener('close', () => btn.setAttribute('aria-expanded', 'false'));
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]') || e.target.closest('a[href]')) dlg.close();
    });
  })();

  paintBell();

  document.getElementById('themeBtn').addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', next === 'dark' ? '#0F1012' : '#F8F7F4');
    try { localStorage.setItem('sig:theme', next); } catch (e) { /* private mode */ }
  });

  /* ── THE MARKET'S CLOCK, IN IST ───────────────────────────────────────
   * This was a per-second clock in MYT. Two faults in one widget: MYT is the
   * author's timezone, not the NSE reader's, and a clock repainting every
   * second is battery and layout work for no information — no trader reads
   * the seconds. What a trader reads is where the session stands: "Open ·
   * 1h 32m to close", "Closed · opens Mon 09:15". So that is what it says, in
   * IST, repainted once a minute. The date stays, because the page's edition
   * question ("is this today's?") is answered beside it.
   *
   * Hours are NSE's (pre-open 09:00, trading 09:15–15:30, Mon–Fri). Holidays
   * come from NSE_HOLIDAYS, which the calendar fills when /api/calendar
   * answers; before it does, a holiday reads as a weekday and says so only
   * once the calendar arrives — the chip never claims a holiday it has not
   * been told about. */
  const clockEl = document.getElementById('edition');
  /* The edition date and the clock shared this element and overwrote each
     other: the edition fetch wrote the build date, and the per-second tick
     replaced it within a second — so the one fact that answers "is this
     today's paper?" was on screen for under a second. Both live here now. */
  let EDITION_DAY = null;
  function tickClock() {
    if (!clockEl) return;
    const now = new Date(Date.now() + 330 * 60000);             // IST, read via the UTC getters
    const ymd = now.toISOString().slice(0, 10), dow = now.getUTCDay();
    const min = now.getUTCHours() * 60 + now.getUTCMinutes();
    const hol = (typeof NSE_HOLIDAYS === 'object' && NSE_HOLIDAYS) ? NSE_HOLIDAYS[ymd] : null;
    const tradingDay = dow >= 1 && dow <= 5 && !hol;
    const dur = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
    let state, cls;
    if (tradingDay && min >= 555 && min < 930) { state = `Open · ${dur(930 - min)} to close`; cls = 'open'; }
    else if (tradingDay && min >= 540 && min < 555) { state = `Pre-open · ${dur(555 - min)}`; cls = 'pre'; }
    else if (tradingDay && min < 540) { state = `Opens in ${dur(555 - min)}`; cls = 'shut'; }
    else {
      let add = 1, nd;
      for (; add < 10; add++) {
        nd = new Date(now.getTime() + add * 86400000);
        const w = nd.getUTCDay(), k = nd.toISOString().slice(0, 10);
        if (w >= 1 && w <= 5 && !((typeof NSE_HOLIDAYS === 'object' && NSE_HOLIDAYS) && NSE_HOLIDAYS[k])) break;
      }
      const day = add === 1 ? 'tomorrow' : nd.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
      state = `${hol ? 'Holiday' : 'Closed'} · opens ${day} 09:15`; cls = 'shut';
    }
    const edDay = EDITION_DAY ? new Date(EDITION_DAY + 'T00:00:00Z') : null;
    const d = edDay && Number.isFinite(edDay.getTime())
      ? `Edition ${edDay.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}${EDITION_DAY === ymd ? '' : ' · not today'}`
      : now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    const t = now.toISOString().slice(11, 16);
    clockEl.className = (clockEl.className.replace(/\bmkt-\w+\b/g, '') + ' mkt-' + cls).trim();
    clockEl.title = `NSE · ${state}${hol ? ' (' + hol + ')' : ''} · ${t} IST`;
    clockEl.innerHTML = `<span class="clk-d">${d}</span><span class="clk-s">NSE ${esc(state)}</span><span class="clk-t">${t}</span><span class="clk-z">IST</span>`;
  }
  tickClock();
  /* On the minute, not every second. The first tick lands on the next
     minute boundary so the displayed time is never up to 59 s stale. */
  setTimeout(() => { tickClock(); setInterval(tickClock, 60000); }, 60000 - (Date.now() % 60000) + 50);

  /* ── edition stamp and data health ─────────────────────────────────────── */
  paintFreshness();
  get('/edition.json').then(r => {
    if (r.ok && r.data && r.data.build_date) {
      EDITION_DAY = String(r.data.build_date).slice(0, 10);
      tickClock();
    }
  });

  render();
})();

/* ── SORTABLE TABLES ─────────────────────────────────────────────────────────
 * Click a column heading to sort the rows under it; click again to reverse.
 *
 * Delegated from the document rather than bound per table, because every table
 * on this site is rendered into innerHTML by a route and then replaced whole on
 * the next navigation. A listener bound at render time dies with the markup it
 * was bound to, and the ledger is re-rendered on every filter change.
 *
 * The comparison reads the cell, not the model: these tables are built as HTML
 * strings and there is no row object to sort. So a cell is parsed as a number
 * when it looks like one AFTER the currency symbol, thousands separators, sign
 * and percent are stripped — "₹1,206" and "-45.1%" are numbers, "HCLTECH" is
 * not — and compared as text otherwise. An ISO date sorts correctly as text,
 * which is why the date column needs no special case.
 *
 * Blank cells always sink, in both directions. A missing value is not a small
 * one, and letting "—" sort as zero would put every unpriced row at the top of
 * an ascending price sort. */
(function sortableTables() {
  /* Leading + as well as -: change columns are written "+3.50%" and "-45.1%",
     and matching only the minus parsed every gain as TEXT — which sorted the
     gains lexically and the losses numerically, in the same column. */
  const NUM = /^[+-]?[\d,]+(\.\d+)?$/;

  const val = (td) => {
    const raw = (td ? td.textContent : '').trim();
    if (!raw || raw === '—' || raw === '-') return { blank: true, n: 0, s: '' };
    const bare = raw.replace(/[₹$€£,\s%]/g, '');
    if (NUM.test(bare)) return { blank: false, n: parseFloat(bare.replace(/,/g, '')), s: raw };
    return { blank: false, n: null, s: raw.toLowerCase() };
  };

  document.addEventListener('click', (ev) => {
    const th = ev.target.closest ? ev.target.closest('th') : null;
    if (!th) return;
    const table = th.closest('table');
    const head = th.closest('thead');
    if (!table || !head) return;
    const body = table.tBodies && table.tBodies[0];
    if (!body || body.rows.length < 2) return;

    const idx = Array.prototype.indexOf.call(th.parentNode.cells, th);
    if (idx < 0) return;

    const asc = table.getAttribute('data-sort-col') === String(idx)
      ? table.getAttribute('data-sort-dir') !== 'asc'
      : true;

    const rows = Array.prototype.slice.call(body.rows);
    rows.sort((ra, rb) => {
      const a = val(ra.cells[idx]), b = val(rb.cells[idx]);
      if (a.blank !== b.blank) return a.blank ? 1 : -1;   // blanks sink either way
      if (a.blank) return 0;
      const cmp = (a.n !== null && b.n !== null)
        ? a.n - b.n
        : String(a.s).localeCompare(String(b.s));
      return asc ? cmp : -cmp;
    });
    rows.forEach((r) => body.appendChild(r));

    table.setAttribute('data-sort-col', String(idx));
    table.setAttribute('data-sort-dir', asc ? 'asc' : 'desc');
    Array.prototype.forEach.call(head.querySelectorAll('th'), (h, i) => {
      h.style.cursor = 'pointer';
      h.setAttribute('aria-sort', i === idx ? (asc ? 'ascending' : 'descending') : 'none');
      const mark = h.querySelector('.sort-mark');
      if (mark) mark.remove();
      if (i === idx) {
        const s = document.createElement('span');
        s.className = 'sort-mark';
        s.style.cssText = 'opacity:.55;font-size:.85em;margin-left:.3em';
        s.textContent = asc ? '▲' : '▼';
        h.appendChild(s);
      }
    });
  });

  /* The heading only looks clickable once it is, and tables arrive after this
     script runs, so the affordance is applied when one appears rather than at
     load. Cheap: it fires on DOM changes the route already causes. */
  const mark = () => {
    document.querySelectorAll('table thead th').forEach((h) => {
      if (h.style.cursor !== 'pointer') {
        h.style.cursor = 'pointer';
        h.title = h.title || 'Sort by this column';
      }
    });
  };
  /* setTimeout, not an observer: this site is read in a hidden tab often enough
     that MutationObserver/rAF-driven work has been the wrong tool here before. */
  document.addEventListener('click', () => setTimeout(mark, 0));
  setTimeout(mark, 400);
  setTimeout(mark, 1500);
})();

/* ── SWOT INTO THE BRIEF ──────────────────────────────────────────────────────
 * The brief's Business section had ratios and flags but no Strengths /
 * Weaknesses / Opportunities / Threats, because the only copy of them lived in
 * screen-detail.json — 4.1MB, which signal.js deliberately never loads. They
 * are now published as their own slim feed (three per quadrant, ~0.6MB) and
 * filled in here after the brief has painted.
 *
 * Fetched ONCE per session and cached: a reader opening six briefs should pull
 * the feed once, not six times. A failure leaves the placeholder empty rather
 * than printing an error — the rest of the section is unaffected and a panel
 * that silently does not appear is better than one that shouts about a feed.
 *
 * setTimeout rather than an observer, for the reason recorded elsewhere in this
 * file: this site is read in hidden tabs often enough that observer-driven and
 * rAF-driven work has been the wrong tool here before. */
(function briefSwot() {
  let cache = null, inflight = null;

  const load = () => {
    if (cache) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = fetch('/swot.json', { cache: 'force-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { cache = (j && j.swot) || {}; return cache; })
      .catch(() => { cache = {}; return cache; });
    return inflight;
  };

  const fill = () => {
    const box = document.getElementById('b-swot');
    if (!box || box.dataset.done === '1') return;
    const sym = (box.getAttribute('data-sym') || '').toUpperCase();
    if (!sym) return;
    const BF = window.BriefFundamentals;
    if (!BF || typeof BF.swot !== 'function') return;   // older mirrored copy
    box.dataset.done = '1';
    load().then((all) => {
      const sw = all[sym];
      if (!sw) return;                                   // not on the screen
      const html = BF.swot(sw);
      if (html) box.innerHTML = html;
    });
  };

  document.addEventListener('click', () => setTimeout(fill, 60));
  setTimeout(fill, 500);
  setTimeout(fill, 1600);
})();
