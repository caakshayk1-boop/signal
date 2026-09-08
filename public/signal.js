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

  async function get(url) {
    routeUrls.add(url);
    const micro = MICRO.get(url);
    if (micro && Date.now() - micro.at < MICRO_MS) return micro.res;
    const key = CACHE + url;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // Content, not timestamps: two fetches a minute apart with identical
      // bodies are the same edition and must not trigger a repaint.
      const body = JSON.stringify(j);
      const prev = FEEDS.get(url);
      FEEDS.set(url, body);
      if (prev !== undefined && prev !== body) feedRev++;
      try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), j })); } catch (e) { /* private mode */ }
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
    return cur + Math.abs(n).toLocaleString('en-IN', Math.abs(n) >= 1000
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
  const symLinks = (sym, tv) => !sym ? '' :
    `<span class="lnks">
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
    const list = [...new Set((syms || []).filter(Boolean))].slice(0, 40);
    if (!list.length) return {};
    const r = await get('/api/signals?px=' + encodeURIComponent(list.join(',')));
    if (r.ok && r.data.quotes) { try { checkAlerts(r.data.quotes); } catch (e) { /* never break a quote fetch */ } }
    return (r.ok && r.data && r.data.quotes) ? r.data.quotes : {};
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
  const paint = html => {
    if (preIntact) {
      // A skeleton-only payload is not an improvement on the snapshot.
      if (/class="sk[ "]|class="sk-/.test(html)) return;
      preIntact = false;
    }
    main.dispatchEvent(new CustomEvent('sig:teardown'));
    main.innerHTML = html;
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
  const LAUNCH = '2026-09-02';

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
  const recordOf = rows => {
    const closed = rows.filter(
      r => Number.isFinite(Number(r.r_multiple)) && (r.badge || '') !== 'open');
    if (!closed.length) return { trades: 0, wins: 0, losses: 0, win_rate: null, expectancy_r: null };
    const wins = closed.filter(r => Number(r.r_multiple) > 0).length;
    const sum = closed.reduce((a, r) => a + Number(r.r_multiple), 0);
    return { trades: closed.length, wins, losses: closed.length - wins,
             win_rate: Math.round(wins / closed.length * 1000) / 10,
             expectancy_r: Math.round(sum / closed.length * 1000) / 1000 };
  };

  const head = (title, sub, eyebrow) =>
    `<div class="route-h"><span class="eyebrow">${esc(eyebrow || 'Signal')}</span>
      <h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;
  // `lead` is the serif line under the label: the label says what the block
  // IS, the lead says what it MEANS. Blocks with nothing to add omit it.
  const sec = (label, body, n, lead) =>
    `<section class="sec"><div class="sec-h"><h2>${esc(label)}</h2>${n ? `<span class="sec-n">${esc(n)}</span>` : ''}</div>${lead ? `<p class="sec-lead">${esc(lead)}</p>` : ''}${body}</section>`;
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
  const xrow = (summary, detail, opts = {}) => {
    if (!detail) return `<div class="rank-r ${opts.cls || ''}" ${opts.attrs || ''}>${summary}</div>`;
    const id = `xr${++xrSeq}`;
    return `<div class="rank-r ${opts.cls || ''} xr" data-xr="${id}" role="button"
        tabindex="0" aria-expanded="false" aria-controls="${id}" ${opts.attrs || ''}>${summary}
        <span class="xr-caret" aria-hidden="true"></span></div>
      <div class="xd" id="${id}" role="region" hidden>${detail}</div>`;
  };

  /* Bound once, at the document. Survives every repaint on every route. */
  const xrToggle = (row) => {
    const panel = document.getElementById(row.getAttribute('aria-controls'));
    if (!panel) return;
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
        <span class="snap-v ${cls || ''}">${v == null || v === '' ? '—' : v}</span>
        ${sub ? `<span class="snap-s">${esc(sub)}</span>` : ''}
      </div>`).join('')}</div>
      ${note ? `<p class="snap-n">${note}</p>` : ''}
    </div>`;
  };

  const tile = (v, k, sub, cls) =>
    `<div class="tile"><div class="v ${cls || ''}">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}<div class="k">${esc(k)}</div></div>`;

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
    range52: ['52-week range', 'Where the current price sits between the lowest and highest price of the past year. 0% is the year’s low, 100% its high.'],
    session: ['Session', 'Whether the exchange is inside its regular trading hours right now, taken from the exchange’s own published session window — not from this page’s refresh.'],
    basis: ['Price basis', 'Which feed the number came from. “Spot” means the price is a spot quote while the 52-week range belongs to the futures contract, so the two are not from the same series.'],
    rr: ['Risk / reward', 'Potential reward relative to the risk you have defined. 3 : 1 means the first target is three times as far from entry as the stop is.'],
    confidence: ['Confidence', 'A composite score built from the five components shown beside it. A component with no data is left out of the mean rather than filled in.'],
    invalidation: ['Invalidation', 'The price at which the reason for the trade no longer exists. Not a target and not a suggestion — a level at which the position is closed.'],
    expectancy: ['Expectancy', 'The average result per closed trade, measured in units of the risk taken (R). Negative expectancy means the engine is losing money per trade on this sample.'],
    regime: ['Market regime', 'Whether price is trending or ranging, and how volatile it has been, measured from the recent daily closes of this instrument.'],
    zone: ['Entry zone', 'The band of prices at which the published entry is valid. Above it the move has already happened; below it the setup has not triggered.'],
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
   * what does this thing go looking for. */
  const ENGINE_REGISTRY = {
    breakout:        { name: 'BREACH', role: 'Breakouts',        band: null,
                       hunts: 'Price clearing a level it has been under — 52-week, 20-week and 6-month highs, confirmed on volume.',
                       tf: 'Daily → weeks' },
    magic:           { name: 'TIDAL',  role: 'Recovery',         band: '>15% off the high',
                       hunts: 'Quality names in a dip, with weekly momentum already turning back up.',
                       tf: 'Weekly → months' },
    magicmagic:      { name: 'TIDAL',  role: 'Recovery',         band: '20–40% off the high',
                       hunts: 'The same screen, deeper water — a larger fall, so more room back to the high.',
                       tf: 'Weekly → months' },
    equity_measured: { name: 'PLUMB',  role: 'Measured equity',  band: null,
                       hunts: 'The backtested daily-close engine, sized against the weekly regime. The only one built from a measured edge rather than a pattern.',
                       tf: 'Daily → days' },
    multibagger:     { name: 'ASCENT', role: 'Leaders',          band: null,
                       hunts: 'Names already near their highs with institutional volume behind them — CAN SLIM, held for quarters not weeks.',
                       tf: 'Weekly → 6–12 months' },
    momentum_quant:  { name: 'VECTOR', role: 'Momentum',         band: null,
                       hunts: 'Cross-sectional rank over 750 names: six and twelve month returns over one-year sigma, skipping the last month.',
                       tf: 'Monthly → months' },
    ai_longterm:     { name: 'NORTH',  role: 'Long horizon',     band: null,
                       hunts: 'The long-horizon screen, run weekly against the whole board.',
                       tf: 'Weekly → months' },
    /* ── THE TWO NEW ONES ─────────────────────────────────────────────────
     * Every engine above buys strength that is ALREADY VISIBLE — 52-week
     * highs, names near their highs, twelve-month momentum. None of them looks
     * for the FIRST move off a base, which is the point where the invalidation
     * level is closest and therefore where risk is smallest. These two do,
     * from opposite evidence: LEDGE from price going quiet, KEEL from momentum
     * refusing to confirm a new low. */
    ledge:           { name: 'LEDGE',  role: 'Base breakout',    band: '≥12% off the high',
                       hunts: 'A Darvas box — price gone quiet in a tight range after a fall — '
                            + 'and then a CLOSE out of the top of it on volume.',
                       tf: 'Daily → weeks' },
    keel:            { name: 'KEEL',   role: 'Divergence turn',  band: '≥12% off the high',
                       hunts: 'A lower low in price against a higher low in RSI, traded only '
                            + 'when price reclaims the level it lost.',
                       tf: 'Daily → weeks' },
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
      triggers: ['Cross-sectional rank over the 750-name screen',
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

  const ENGINES = new Set(Object.keys(ENGINE_REGISTRY));
  const eng = k => ENGINE_REGISTRY[String(k || '')] || null;
  const engName = k => (eng(k) || {}).name || String(k || '—');
  /* The old map is kept as the fallback for a row whose engine has since been
   * retired: an unrecognised key renders as itself rather than as blank. */
  const ENGINE_LABEL = new Proxy({}, { get: (_, k) => engName(k) });
  /* ── OLD NAMES IN STORED PROSE ───────────────────────────────────────────
   * The registry renames what the site RENDERS, but `remarks` is free text
   * written into the ledger at signal time and it says things like
   * "Magic-levels screen (v1 engine)". Those rows are history and must not be
   * rewritten in the database — so the substitution happens on the way out,
   * the same place the key itself is translated. Longest keys first, or
   * "magic" would eat the front of "magicmagic". */
  const ENGINE_WORDS = Object.entries(ENGINE_REGISTRY)
    .map(([k, v]) => [k, v.name])
    .concat([['Magic-levels', 'TIDAL levels'], ['MagicMagic', 'TIDAL'], ['Magic', 'TIDAL']])
    .sort((a, b) => b[0].length - a[0].length);
  const engineWords = t => ENGINE_WORDS.reduce(
    (acc, [k, n]) => acc.replace(new RegExp('\\b' + k + '\\b', 'g'), n), String(t || ''));

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

  async function ledger() {
    const live = await get('/api/signals?limit=400');
    if (live.ok) {
      const all = live.data.signals || live.data.rows || [];
      const rows = all.filter(engineOk).filter(longOnly);
      if (all.length) return { ok: true, rows, live: true, at: live.data.generated_at,
                               dropped: all.length - rows.length };
    }
    const snap = await get('/alerts.json');
    if (!snap.ok) return { ok: false, error: live.error || snap.error };
    const all = Array.isArray(snap.data) ? snap.data : (snap.data.rows || []);
    const rows = all.filter(engineOk).filter(longOnly);
    return { ok: true, rows, live: false, error: live.error, dropped: all.length - rows.length };
  }

  /* ── THE SCREEN INDEX ────────────────────────────────────────────────────
   * symbol → its row on the 750-name screen. Built once and reused, so the
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
      const r = noteLadder(await get('/screen.json'));
      if (!r.ok) return null;
      SCREEN = (r.data.rows || []).filter(x => x && x.sym);
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
  const alertsAll = () => lsGet(AKEY, []);
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
    const fd = ev.target.closest('.rank-r.fnd[data-fund]');
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
    if (ev.target.closest && ev.target.closest('.wstar')) return;
    const n = ev.target.closest && ev.target.closest('[data-sym]');
    if (n && n.dataset.sym) { ev.preventDefault(); openStock(n.dataset.sym); }
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
          * symbol is in the 750-name screen. */''}
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
        <span style="color:var(--dim);font:400 11px/1 var(--mono)">${b.counted} names screened</span>
        <span><b class="dn">${b.down}</b> <span style="color:var(--dim)">down</span></span>
      </div>
      <div class="breadth-bar"><i class="bu" style="width:${up.toFixed(1)}%"></i><i class="bd" style="width:${dn.toFixed(1)}%"></i></div>
      <div class="breadth-sub">Median name ${pct(b.median)} on the week ·
        <b style="color:var(--muted)">${b.above_200dma}</b> hold their 200-day ·
        <b style="color:var(--muted)">${b.at_52w_high}</b> at a 52-week high</div>
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
         * page. The values exist: every one is on the 750-name screen, keyed by
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

  R['/'] = async () => {
    paint(head('Today', 'India’s markets, in one screen — rebuilt every morning before the open.', 'The morning edition') +
      sec('The tape', `<div class="grid">${skel('sk-tile', 4)}</div>`) +
      sec('Where the money went', `<div class="sk" style="height:104px"></div>`) +
      sec('The wire', skel('sk-card', 3)));

    /* ── TWO PHASES, BECAUSE ONE OF THESE IS 230 KB ───────────────────────
     *
     * The five event tiles and the wire's ranking both need the 750-name
     * screen, and adding it here put a 230 KB download — by far the largest
     * asset on the site — in front of the front page rendering at all. The
     * shell reaches first paint in about 150ms; blocking the content behind
     * a quarter-megabyte to decide the ORDER of ten headlines is the wrong
     * trade.
     *
     * So the page renders on the four small feeds it actually needs, and the
     * screen and the calendar arrive after. The second pass re-runs this
     * route, which costs one repaint and no extra network: get() serves the
     * first four out of its five-second window, so only the two new feeds go
     * to the wire. Anything that changes between the passes is flagged by the
     * usual change-flash rather than swapping silently. */
    const n2 = { ok: false, data: null };   // filled below; the hero reads its length
    /* /api/stats joins the first wave deliberately. The record is now the
     * front page's lead claim, and a lead claim that arrives in a second pass
     * is one the reader has already scrolled past. It is a Turso aggregate of
     * ~100 rows and returns in about a second, alongside the rest. */
    /* THE RECORD IS THE LAUNCH WINDOW, AND IT HAS TO BE FETCHED THE SAME WAY
     * #/signals FETCHES IT.
     *
     * The first version of the front-page record read /api/stats, which is
     * all-time and cannot be filtered — the exact thing recordOf() was written
     * to replace, and the exact failure the LAUNCH comment above describes.
     * It put "71 closed, 12.7%" at the top of the page while #/signals, two
     * clicks away, reported the launch window. Two populations under one
     * heading, which is what makes a reader distrust both numbers.
     *
     * ?limit=400 matches the signals route, so get()'s window usually serves
     * one of the two calls from cache. /api/stats is still fetched, but only
     * for engine_floors — a property of the engines, not of this site's
     * record, and labelled as such where it is shown. */
    const [t, p, n, m, fl, ed, lw, sgx] = await Promise.all(
      [get('/today.json'), get('/pulse.json'), get('/news.json'), get('/api/markets'),
       get('/api/flows'), get('/edition.json'), get('/api/wire'),
       ledger()]);
    /* THE SITE'S OWN RECORD — THROUGH ledger(), NOT A SECOND COPY OF ITS RULES.
     *
     * The first attempt fetched /api/signals here and filtered it by hand. It
     * matched on the launch cutoff and still disagreed with #/signals: 38
     * published against 19, 8 closed against 2. The missing rule was the
     * engine whitelist — ledger() drops rows whose signal_type is not in
     * ENGINES, and re-deriving the population by hand simply did not know
     * that.
     *
     * Which is the whole lesson twice over. Consistency between two pages
     * cannot come from carefully writing the same filter in both places; it
     * has to come from calling the same function. ledger() also carries the
     * alerts.json fallback, so the front page now degrades the way the signals
     * page does instead of showing nothing. */
    const lrRows = sgx.ok ? (sgx.rows || []).filter(sinceLaunch) : [];
    const LR = recordOf(lrRows);
    LR.published = lrRows.length;
    LR.open = lrRows.filter(r => (r.badge || '').toLowerCase() === 'open').length;
    /* CACHED IS SYNCHRONOUS. It reads the in-memory micro-cache and returns
     * the wrapper itself — {ok, ready, data, error} — not a promise. This line
     * called .then on it, which is undefined, so the Today route threw on
     * every load and rendered its error panel instead of the page.
     *
     * The line below it chains .then onto get(), which IS async and correct.
     * Two calls that look identical, one awaited and one not, is exactly how
     * this got written. noteLadder returns its argument either way, so it
     * composes both ways — the only difference is whether you await it. */
    const heavy = [CACHED('/api/calendar'), noteLadder(CACHED('/screen.json'))];
    const cl = heavy[0], sr = heavy[1];
    /* ONCE PER VISIT, NOT ONCE PER RENDER.
     *
     * This re-entered the route as soon as the heavy feeds resolved — and
     * resolving includes FAILING. With the screen unreachable the second pass
     * found them still not ready, fired them again, and re-entered again:
     * measured as main oscillating 466 → 138 → 466 characters forever, a
     * repaint and two requests every cycle, for as long as the tab stayed
     * open on a broken connection.
     *
     * heavyTried is cleared by render() on every route change, so navigating
     * away and back does try again — the guard stops a loop, not a retry. */
    if (!heavyTried && (!cl.ready || !sr.ready)) {
      heavyTried = true;
      Promise.all([get('/api/calendar'), get('/screen.json').then(noteLadder)]).then(() => {
        if (routeOf() === '/') R['/']();
      });
    }
    /* ── THE HERO ────────────────────────────────────────────────────────
     * The first viewport has to answer four things: what this is, what state
     * the market is in, what to do next, and how long that takes. It replaces
     * a page head that answered only the first.
     *
     * Every figure in it is one this page already loaded. No photograph, no
     * illustration, no number that is not measured elsewhere on the site. */
    n2.ok = n.ok; n2.data = n.ok ? n.data : null;
    const heroMk = m.ok ? (m.data.markets || []) : [];
    const heroNifty = heroMk.find(x => /nifty 50/i.test(x.name || ''));
    const heroSensex = heroMk.find(x => /sensex/i.test(x.name || ''));
    // FII and DII net cash flows, straight from NSE. Not in any mirrored feed
    // — see src/api/flows.js. ok:false means NSE would not answer, and the
    // block says "Not published" rather than showing a zero.
    const flow = fl.ok && fl.data && fl.data.ok ? fl.data : null;
    const heroBr = (p.ok ? p.data : {}).breadth || {};
    const adv = Number(heroBr.up), counted = Number(heroBr.counted);
    // "Risk-on / neutral / risk-off" is NOT invented here — it is the breadth
    // this site already computes, named. Two thirds advancing is the same
    // threshold the breadth widget uses to colour itself.
    const heroRegime = Number.isFinite(adv) && Number.isFinite(counted) && counted
      ? (adv / counted >= 0.6 ? ['RISK-ON', 'up', 'Most of the screen is advancing.']
        : adv / counted <= 0.4 ? ['RISK-OFF', 'dn', 'Most of the screen is declining.']
        : ['NEUTRAL', '', 'The screen is split.'])
      : null;

    let out = `<section class="hero">
      <div class="hero-l">
        <span class="eyebrow">The morning edition · ${esc((t.ok && t.data.date_str) || '')}</span>
        ${/* A CLAIM, THEN THE EVIDENCE FOR IT.
            * "Numbers first. Noise last." is a mood. It tells a first-time
            * reader nothing about what this is or why they would come back
            * tomorrow. The headline now states what the site does; the line
            * under it is the only honest proof — today's actual counts, from
            * the feeds this page has already loaded. If the screen is empty
            * the sentence says so rather than making the claim anyway. */''}
        ${/* THE HEADLINE USED TO SELL THE SIGNALS. THE LEDGER REFUTES THEM.
            *
            * It read "Indian markets, decoded in 60 seconds", under which the
            * subhead promised "one setup written up in full — with the stop,
            * the target and the reason it would be wrong". Every word of that
            * was true about the process and silent about the outcome, while
            * this site's own published record showed 62 losses in 71 closed
            * trades at an expectancy of −0.556R.
            *
            * A page cannot lead with a claim its own measurement contradicts
            * and still call itself measured. So the lead is now the record —
            * including, and especially, when the record is bad. That is the
            * only version of this page that is honest on a losing month, and
            * a page that is only honest on good months is not honest.
            *
            * The numbers are read live from /api/stats, never typed here. If
            * the edge turns positive this headline reports that instead, by
            * the same mechanism and with no edit. */''}
        ${(() => {
          if (!LR.published) {
            /* EMPTY BECAUSE IT RESTARTED IS NOT EMPTY BECAUSE IT BROKE.
             * This branch said "the ledger is not reachable this minute",
             * which was true only of a failed fetch. On the day the cutoff
             * moves it is reached by a page whose ledger answered perfectly
             * and had nothing on or after LAUNCH yet — and telling a reader
             * the site is broken when it is working is its own kind of lie. */
            const reachable = sgx.ok;
            return `<h1>Every signal, graded.<br>The record starts ${esc(LAUNCH)}.</h1>
              <p class="hero-sub">${reachable
                ? `Nothing published yet. The stop rules changed today, so the count starts here.
                   Earlier signals stay on
                   <a href="https://news.askakshay.com">news.askakshay.com</a>.`
                : `The ledger is not answering this minute —
                   <a href="/signals">open the record</a> rather than take this page's word.`}
              </p>`;
          }
          /* BELOW FIVE, THE HEADLINE STATES THE COUNT AND NOT A VERDICT.
           *
           * This page already holds that line elsewhere: rCurve() returns null
           * under five closed trades, and #/signals says in as many words that
           * "a curve needs five before its shape means anything". A headline
           * reading "All 2 that closed, lost" would break that rule in the
           * loudest type on the site — technically true, and a verdict drawn
           * from two data points, which is the same error as claiming an edge
           * from two winners. Being wrong in the pessimistic direction is
           * still being wrong. */
          if (LR.trades && LR.trades < 5) {
            return `<h1>Every signal, graded.<br>The record starts here.</h1>
              <p class="hero-sub"><b>${LR.published}</b> published since ${esc(LAUNCH)},
                <b>${LR.trades}</b> closed so far${LR.wins === 0 && LR.trades
                  ? ` — <b class="dn">${LR.trades === 1 ? 'a loss' : 'both losses'}</b>` : ''}.
                That is too few to mean anything in either direction, and it is shown rather
                than withheld until it flatters. Everything below is research, not a
                recommendation.</p>`;
          }
          if (!LR.trades) {
            return `<h1>Every signal, graded.<br>The record starts here.</h1>
              <p class="hero-sub"><b>${LR.published}</b> signals published since
                ${esc(LAUNCH)}, none closed yet. Nothing to report is reported as nothing,
                not as a clean slate. Everything below is research until it settles.</p>`;
          }
          const neg = LR.expectancy_r < 0;
          const allLost = LR.wins === 0;
          const thin = LR.trades < 30;
          return `<h1>Every signal, graded.<br>${allLost
              ? `All <b class="dn">${LR.trades}</b> that closed, lost.`
              : `Including the <b class="dn">${LR.losses}</b> that lost.`}</h1>
            <p class="hero-sub">
              <b>${LR.published}</b> published since ${esc(LAUNCH)}.
              <b>${LR.trades}</b> have closed, averaging
              <b class="${neg ? 'dn' : 'up'}">${LR.expectancy_r > 0 ? '+' : ''}${LR.expectancy_r}R</b>${
                allLost ? '' : ` at a <b>${LR.win_rate}%</b> win rate`}.
              ${thin ? `Too few to settle anything. Shown anyway.` : ''}
              Everything below is research, not a recommendation.
            </p>`;
        })()}
        <div class="hero-cta">
          <a class="btn-hero" href="/signals">The record
            <em>every trade, graded, with the losses</em></a>
          <a class="btn-ghost" href="/brief">Today’s brief · ${CURVE_MIN} →</a>
        </div>
      </div>
      <div class="hero-r">
        ${/* NIFTY, SENSEX, FLOWS — the three readings, in that order.
            * The lead slot used to hold a "Market state" badge reading RISK-ON
            * or NEUTRAL, which is a restatement of the breadth number printed
            * a few centimetres below it and not a fact about the market that
            * the market itself reports. The index is. */''}
        ${heroNifty ? `<div class="hero-reg ${dir(heroNifty.change_pct)}">
          <span class="k">Nifty 50</span>
          <span class="v">${esc(heroNifty.price ?? '—')}</span>
          <span class="s"><b class="${dir(heroNifty.change_pct)}">${pct(heroNifty.change_pct)}</b> today${
            Number.isFinite(adv) && Number.isFinite(counted) && counted
              ? ` · ${adv} of ${counted} screened names advancing` : ''}</span>
        </div>` : ''}
        ${heroSensex ? `<div class="hero-q">
          <span class="k">Sensex</span>
          <span class="v">${esc(heroSensex.price ?? '—')}</span>
          <span class="c ${dir(heroSensex.change_pct)}">${pct(heroSensex.change_pct)}</span>
        </div>` : ''}
        <div class="hero-q hero-fl">
          <span class="k">FII &amp; DII${flow && flow.date ? ` · ${esc(flow.date)}` : ''}</span>
          ${flow ? `<span class="fl-r">
              <b>FII</b>
              <i class="${dir(flow.fii && flow.fii.net)}">${flow.fii && flow.fii.net != null
                ? (flow.fii.net > 0 ? '+' : '') + '₹' + Math.round(flow.fii.net).toLocaleString('en-IN') + ' cr'
                : 'Not published'}</i>
            </span>
            <span class="fl-r">
              <b>DII</b>
              <i class="${dir(flow.dii && flow.dii.net)}">${flow.dii && flow.dii.net != null
                ? (flow.dii.net > 0 ? '+' : '') + '₹' + Math.round(flow.dii.net).toLocaleString('en-IN') + ' cr'
                : 'Not published'}</i>
            </span>
            <span class="fl-n">Net cash-market buying, last published session.</span>`
          : `<span class="fl-n">Not published — NSE did not answer.</span>`}
        </div>
      </div>
    </section>`;
    if (!t.ok && !p.ok) { paint(out + fail('Today', t.error || p.error)); return; }

    const d = t.ok ? t.data : {}, pu = p.ok ? p.data : {}, br = pu.breadth || {};
    const mk = m.ok ? m.data : null;
    const nifty = mk && (mk.markets || []).find(x => /nifty 50/i.test(x.name || ''));

    /* SENSEX HERE, NOT NIFTY. The hero directly above this already prints
     * Nifty 50 as the headline figure, so the first tile of the tape was the
     * same number a second time, 263px lower — measured. A four-tile summary
     * that spends a quarter of itself repeating the line above it is three
     * tiles long. Sensex is the other index an Indian reader checks. */
    /* ── TODAY'S FIVE ──────────────────────────────────────────────────────
     *
     * This row used to be four breadth tiles — advancing, declining, names at
     * 52-week highs, ideas this week. Two of those numbers are printed again
     * on the Markets page and one of them was the same figure twice on this
     * one, so the top of the front page spent itself restating a count.
     *
     * Breadth is a summary of the day. These five are the day's EVENTS: the
     * story that touches the most names on the screen, the shares trading
     * abnormally against their own average volume, the corporate actions that
     * change a share count or a quoted price, the results calendar and the
     * next day the exchange is shut. Each opens.
     *
     * Every tile states its own count, so an empty one reads as "nothing today"
     * rather than as a panel that failed to load — and a tile whose source did
     * not answer says that instead of showing a zero. */
    /* LIVE FIRST, THE DAILY FILE AS A FALLBACK.
     *
     * /api/wire reads the same RSS publishers the daily build reads, but now,
     * and every story carries its own pubDate. news.json stays as the fallback
     * so a dead RSS host degrades to yesterday's wire rather than to nothing —
     * and the label says which of the two is on screen. */
    const liveWire = lw.ok && lw.data && lw.data.ok ? lw.data : null;
    // Merged before anything counts or slices it, so the section count and the
    // "N of M" line describe stories rather than filings.
    const wire = dedupeWire(liveWire ? liveWire.stories : (n.ok ? n.data : []));
    const wireIsLive = !!liveWire;
    const wireAge = (() => {
      /* SHORT, BECAUSE EVERY STORY ALREADY CARRIES ITS OWN AGE.
       * "read under an hour old" ran to 257px of header on a 320px screen and
       * pushed the page two pixels sideways — while restating, less precisely,
       * what the "35m ago" beside each headline already says. */
      if (liveWire) return 'live';
      /* The daily file has no timestamp of its own, so it borrows the build
       * stamp of the edition it was written with. Fetched with the rest rather
       * than read out of the micro-cache: the edition watcher requests
       * /edition.json?t=… to defeat caching, which is a different key. */
      const h = ageHours(ed.ok ? feedStamp(ed.data) : null);
      return h == null ? '' : `daily · ${ageWord(h)}`;
    })();
    const cal = cl.ok && cl.data && cl.data.ok ? cl.data : null;
    const wireTop = (() => {
      const uni = sr.ok ? (sr.data.rows || []) : [];
      if (!wire.length) return null;
      // "Impactful" measured, not asserted: the story naming the most companies
      // on the 750-name screen.
      const scored = wire.map(x => ({ x, n: uni.length ? newsMatch(x, uni).length : 0 }));
      scored.sort((a, b) => b.n - a.n);
      return scored[0];
    })();
    const spurts = (() => {
      const uni = sr.ok ? (sr.data.rows || []) : [];
      return uni.filter(r => Number(r.vol_spike) >= 1.5 && r.liquid !== false)
                .sort((a, b) => Number(b.vol_spike) - Number(a.vol_spike)).slice(0, 20);
    })();
    TODAY5 = { wire, wireTop, spurts, cal };

    const t5 = (id, v, k, sub, cls) => `<button type="button" class="tile tile-go" data-t5="${id}">
      <div class="v ${cls || ''}">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}
      <div class="k">${esc(k)}</div></button>`;

    /* ── THE RECORD, FIRST ────────────────────────────────────────────────
     * Placed above every pick on the page, and that placement is the whole
     * change. The measurement already existed and was honest; it lived on
     * #/signals, two clicks from anybody who never went looking. A record
     * that only the sceptical reader finds is not disclosure.
     *
     * Nothing here is written by hand. Every figure is read from /api/stats,
     * so this section cannot drift from the ledger, cannot be forgotten on a
     * bad week, and reports an edge that turns positive with the same
     * prominence it reports one that has not. */
    /* ── THE RECORD ───────────────────────────────────────────────────────
     * Counted ONLY from LAUNCH, engines included. The first version of this
     * section printed "0 published · 0 closed" and then a table of 22 closed
     * breakout trades from before the cutoff — the pre-launch history this
     * site had just stopped claiming, restated immediately underneath the zero
     * that says it does not count it. Two answers to one question, and the
     * louder one was the one the page had just disowned.
     *
     * So /api/stats is gone from this section. Every figure below comes from
     * the same rows the tiles do, which makes the section incapable of
     * disagreeing with itself.
     *
     * The prose is short for the same reason. The earlier draft explained the
     * magic/magicmagic merge, named all eleven engines and justified the
     * counting window in a paragraph — argument in place of numbers, on a
     * page whose case is that the numbers speak. */
    if (sgx.ok) {
      const fam = new Map();
      for (const k of ENGINES) {
        const label = ENGINE_LABEL[k] || k;
        if (!fam.has(label)) fam.set(label, { label, pub: 0, closed: 0, wins: 0 });
      }
      for (const r of lrRows) {
        const label = ENGINE_LABEL[r.signal_type] || r.signal_type;
        const f = fam.get(label);
        if (!f) continue;
        f.pub += 1;
        if ((r.badge || '') !== 'open' && Number.isFinite(Number(r.r_multiple))) {
          f.closed += 1;
          if (Number(r.r_multiple) > 0) f.wins += 1;
        }
      }
      const rows = [...fam.values()].sort((a, b) => b.closed - a.closed || b.pub - a.pub);
      const neg = LR.expectancy_r != null && LR.expectancy_r < 0;
      out += sec('The record', `
        <div class="grid">
          ${tile(LR.published, 'Published', `since ${esc(LAUNCH)}`, LR.published ? 'ac' : '')}
          ${tile(LR.trades, 'Closed and scored', LR.open + ' still open')}
          ${tile(LR.trades ? LR.win_rate + '%' : '—', 'Win rate',
                 LR.trades ? `${LR.wins}W / ${LR.losses}L` : 'nothing closed yet',
                 LR.trades ? (LR.win_rate >= 50 ? 'up' : 'dn') : '')}
          ${tile(LR.trades ? (LR.expectancy_r > 0 ? '+' : '') + LR.expectancy_r + 'R' : '—', 'Per trade',
                 'expectancy, closed only', LR.trades ? dir(LR.expectancy_r) : '')}
        </div>
        <p class="sec-note">${!LR.published
          ? ``
          : !LR.trades
          ? `Nothing has closed yet.`
          : `${LR.trades} closed, averaging
             <b class="${neg ? 'dn' : 'up'}">${LR.expectancy_r > 0 ? '+' : ''}${LR.expectancy_r}R</b>.
             ${LR.trades < 30 ? 'Too few to settle anything, and shown anyway.' : ''}`}
        </p>
        <div class="rank">
          <div class="rank-r eng eng-h">
            <span class="s">Engine</span><span class="x">Published</span>
            <span class="x">Closed</span><span class="x">Win rate</span>
          </div>
          ${/* A LINK, NOT A DEAD ROW. These nine were the only rows left on the
              site that showed a name and a number and answered nothing when
              tapped — the floor now holds what each engine fires on, where its
              stop comes from and how it can be wrong, so the roster points at
              it rather than restating a fraction of it. */''}
          ${rows.map(r => `<a class="rank-r eng" href="/engines"
              aria-label="${esc(r.label)} — open the engine floor">
            <span class="s"><b>${esc(r.label)}</b></span>
            <span class="x">${r.pub || '—'}</span>
            <span class="x">${r.closed || '—'}</span>
            <span class="x">${r.closed
              ? (Math.round(r.wins / r.closed * 1000) / 10) + '%' : '—'}</span>
          </a>`).join('')}
        </div>
        <p class="hint">An engine is trusted with capital at 30 closed trades and t&nbsp;≥&nbsp;2.
          None is there. <a href="/engines">What each engine fires on</a> ·
          <a href="/methodology">How this is measured</a> ·
          <a href="/signals">Every trade, one by one</a></p>`,
        `${LR.published} published · ${LR.trades} closed`);
    }

    out += sec('Today', `<div class="grid grid-5">
        ${t5('news', wireTop && wireTop.n ? wireTop.n : (wire.length ? '—' : '0'),
             'Most-connected story',
             wireTop && wireTop.n ? `names ${wireTop.n} screened ${wireTop.n > 1 ? 'companies' : 'company'}`
                                  : (wire.length ? 'none names a screened company' : 'the wire is quiet'), 'ac')}
        ${t5('vol', spurts.length, 'Volume spurts', 'trading above 1.5× their own average',
             spurts.length ? 'ac' : '')}
        ${t5('acts', cal ? (cal.actions.rows || []).length : '—', 'Corporate actions',
             cal ? (() => { const b = (cal.actions.rows || []).filter(x => x.kind === 'Bonus' || x.kind === 'Split').length;
                            return b ? `${b} bonus or split` : 'dividends only'; })()
                 : 'NSE did not answer')}
        ${t5('res', cal ? (cal.results.rows || []).filter(x => x.isResult).length : '—', 'Results due',
             cal ? `of ${(cal.results.rows || []).length} board meetings` : 'NSE did not answer')}
        ${/* "09-14" is a slice of an ISO string, not a date anyone reads.
            * t5DM renders 14 Sep, which is how the day is spoken. */''}
        ${t5('hol', cal && (cal.holidays.rows || []).length ? t5DM(cal.holidays.rows[0].date) : '—',
             'Next market holiday',
             cal && (cal.holidays.rows || []).length ? esc(cal.holidays.rows[0].why || '') : 'NSE did not answer')}
      </div>`, '', 'The day’s events, not the day’s averages.');

    // Today, over the 250 largest — not a week over all 750. A daily paper's
    // front page should answer "what happened today", and a 750-name median is
    // dominated by the 500 small and micro caps most readers never trade.
    // Falls back to the week when the screen predates r1d, and SAYS which one
    // it is showing — an unlabelled heat map is the reader guessing.
    const dayMap = (pu.sectors_day || []).length;
    out += sec(dayMap ? 'Where the money went today' : 'Where the money went this week',
      heatmap(dayMap ? pu.sectors_day : (pu.sectors || []).slice(0, 11), dayMap ? 'r1d' : 'r1w') +
      `<p class="hint">${dayMap
        ? `Median move <b>today</b> per sector, across the <b>${pu.day_universe || 250} largest</b> by market cap. Tile width is how many names it holds.`
        : 'Median move over the <b>week</b>, across all 750 screened names — today\'s figures arrive with the next screen build.'}
        Tap a sector for the names behind it.</p>` + heatKey(1.5, 'Sector move'),
      dayMap ? 'today · large caps' : 'this week · all 750');

    /* ── TEN OF EIGHTEEN, AND THE BOTTOM SIX ROTATE ───────────────────────
     *
     * The wire is a DAILY file. It does not gain stories between builds, so a
     * "refreshes every 15 minutes" that re-fetched it would be churn dressed
     * as news — the same eighteen headlines, re-requested.
     *
     * What can honestly change on that interval is how much of the file you
     * have seen. The four stories that touch the most screened names are
     * pinned for the day, because those are the ones a reader came for and
     * rotating them away would hide the most useful items on the page. The
     * remaining six slots cycle through the rest on a twenty-minute bucket,
     * derived from the clock rather than from a timer, so every tab shows the
     * same rotation and a reload does not reshuffle it.
     */
    const wireView = (() => {
      const uni = sr.ok ? (sr.data.rows || []) : [];
      const ranked = wire.map(x => ({ x, n: uni.length ? newsMatch(x, uni).length : 0 }))
                         .sort((a, b) => b.n - a.n);
      const pinned = ranked.slice(0, 4).map(r => r.x);
      const rest = ranked.slice(4).map(r => r.x);
      if (!rest.length) return pinned;
      const SLOTS = 6;
      /* ROTATION WAS A WORKAROUND FOR A FILE THAT DID NOT CHANGE.
       *
       * When the wire was a daily build, cycling the lower slots was the only
       * way a reader saw more than six of eighteen fixed stories. A live wire
       * has the opposite problem — it changes on its own, and rotating it too
       * would shuffle stories a reader is mid-way through for no reason. Live:
       * newest first, which the endpoint already sorts. Daily: rotate. */
      if (wireIsLive) return pinned.concat(rest.slice(0, SLOTS));
      const bucket = Math.floor(Date.now() / (20 * 60 * 1000));
      const start = rest.length ? (bucket * SLOTS) % rest.length : 0;
      const rotating = Array.from({ length: Math.min(SLOTS, rest.length) },
                                  (_, i) => rest[(start + i) % rest.length]);
      return pinned.concat(rotating);
    })();

    out += sec('The wire', wire.length ? `<div class="wire">${wireView.map(x => `
        <a href="${esc(x.link || '#')}" ${x.link ? 'target="_blank" rel="noopener"' : ''}>
          <span class="ws">${esc(x.source || 'wire')}${
            // HOW MANY WIRES CARRIED IT. The closest thing this feed has to a
            // measure of size: no timestamp, no clustering upstream, but the
            // fact that four desks filed the same story today is real and
            // measured. Named rather than counted, so it can be checked.
            x._also && x._also.length
              ? `<i class="w-also" title="${esc(x._also.join(', '))}">+${x._also.length} more</i>` : ''}${
            x.at ? `<i class="w-at">${esc(storyAge(x.at))}</i>` : ''}</span>
          <span class="wt">${esc(x.title || '')}</span>
          ${x.summary ? `<span class="wd">${esc(String(x.summary).slice(0, 150))}</span>` : ''}
        </a>`).join('')}</div>
        <p class="hint">${wireIsLive
          ? `Read live from <b>${liveWire.sources}</b> newswires, refreshed every fifteen minutes,
             newest first. The four touching the most screened names are pinned; the rest rotate.`
          : `The live wire did not answer, so this is the daily file. The first four are the stories
             touching the most screened names and stay put for the day; the rest rotate every twenty
             minutes so you see more of it.`}
          <a href="/news" class="more-l">Read all ${wire.length}, with the names each one touches &rarr;</a></p>`
      : `<div class="empty">The wire is quiet.</div>`,
      /* "18 stories" over a list of six is a caption contradicting the thing
       * it captions. Say what is on screen, and link to the rest. */
      /* THE WIRE'S VINTAGE.
       *
       * news.json is a bare array — no timestamp inside it, and the asset is
       * served without a Last-Modified header, so there is nothing on the file
       * itself to read. It is written by the same build that writes
       * edition.json, which does carry built_at, so that is the wire's age and
       * it is stated rather than left to be guessed. Without it a reader
       * refreshing a page whose stories do not change has no way to tell
       * whether the wire is quiet or stuck. */
      `${wire.length > wireView.length ? `${wireView.length} of ${wire.length}` : `${wire.length} stories`}${
        wireAge ? ` · ${esc(wireAge)}` : ''}`);

    const cv = await get('/conviction.json');
    if (cv.ok && (cv.data.picks || []).length) {
      const c = cv.data;
      // Five symbols, one call. The slate is priced at the morning build; this
      // is what it is worth now.
      const cvpx = await quotes(c.picks.map(x => x.sym));
      c.picks.forEach(x => { x._live = cvpx[x.sym] || null; });
      out += sec('Today’s conviction', `<div class="cards-2">${c.picks.map(convictionCard).join('')}</div>` +
        TRAIL_NOTE +
        `<details class="meth"><summary>How these five were chosen</summary>
           <p>${esc(c.method)}</p>
           <p class="hint">Ranked ${esc(c.date)} over ${esc(c.universe)} screened names. The slate is
           logged every day, so it can be graded later rather than quietly rewritten.</p>
         </details>`,
        `${c.picks.length} names · ${esc(c.date)}`,
        /* THE LEAD SAYS WHAT THESE ARE, BECAUSE THE HEADING DOES NOT.
         * "Today's conviction" is the language of a recommendation, and on a
         * ledger reading −0.556R a recommendation is not what this can
         * honestly be. Renaming the section would have hidden the history;
         * saying plainly what it is, directly under the name, does not. */
        'Ranked candidates, not positions to take. No engine has cleared the 30-trade bar.');
    } else {
      const pk = (d.picks || [])[0];
      if (pk) out += sec('This week’s top idea', ideaCard(pk, true), null,
        'The week\'s highest-scoring setup. Scored, not endorsed.');
    }

    const io = (await get('/ipo.json'));
    // Filtered on the calendar, not on the build. A feed that missed a night
    // used to keep yesterday's shut books under a heading saying "open".
    const ipoOpen = io.ok ? ipoOpenNow(io.data.open) : [];
    if (ipoOpen.length) {
      out += sec('Open right now', ipoOpen.slice(0, 2).map(ipoCard).join(''),
        `${ipoOpen.length} book${ipoOpen.length === 1 ? '' : 's'} open`);
    }
    // Nothing in the mirror is still open. NSE may well disagree — that is
    // exactly the case fillIpoLive() is for, so give it somewhere to render.
    if (!ipoOpen.length) out += '<div id="ipoExtraHome"></div>';
    paint(out);
    // The front page renders the same IPO card as the IPO route, so it needs
    // the same upgrade to the live book. Wiring it to one route and not the
    // other is why this page still showed a 14-hour-old 27.83x.
    fillIpoLive();
  };

  const convictionCard = p => `<article class="card cv" data-sym="${esc(p.sym)}" role="button" tabindex="0">
    ${/* IN THE FLOW, NOT OVER IT. The star was absolutely positioned at the
        * card's top right — which is exactly where the sector pill already
        * sits, so at 390px it sat on top of "Healthcare", "Industrials" and
        * every other sector name. Measured on four cards. It belongs in the
        * header row, which is a flex row that already knows how to make
        * room. */''}
    <div class="card-h">
      ${watchBtn(p.sym)}
      <span class="sym">${esc(p.sym)}</span>
      <span class="pill pill-ac">${esc(p.score)}</span>
      ${p.brk52w ? `<span class="pill pill-up">52w high</span>` : ''}
      <span class="spacer"></span>
      <span class="pill">${esc(p.sector || '')}</span>
    </div>
    <div class="card-body" style="color:var(--text);font-weight:500">${esc(p.name || '')}</div>
    ${p.view ? `<div class="cv-view"><span>View</span>${esc(p.view)}</div>` : ''}
    ${(p.reasons || []).length ? `<div class="reads">${p.reasons.map(x =>
        `<div class="read read-for">${esc(x)}</div>`).join('')}</div>` : ''}
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
      <div><span class="kk">Volatility <i class="kk-q">1y</i></span><span class="vv">${
        p.sd1y != null ? Number(p.sd1y).toFixed(0) + '%' : '—'}</span></div>
      <div><span class="kk">3Y CAGR</span><span class="vv ${dir(p.r3y_cagr)}">${
        p.r3y_cagr != null ? Number(p.r3y_cagr).toFixed(0) + '%' : '—'}</span></div>
      <div><span class="kk">ROCE trend</span><span class="vv">${
        p.roce_trend ? esc(String(p.roce_trend)) : '—'}</span></div>
      ${(() => {
        /* ── THE ONE DATE THAT CHANGES A SWING TRADE ──────────────────────
         * A setup that runs into a results print is a different trade from the
         * same setup two weeks clear of one, and the screen has known the date
         * all along. Counted in days rather than shown as a date, because
         * "in 4 days" is the form the decision is made in. */
        if (!p.next_earnings) return '<div><span class="kk">Results</span><span class="vv">—</span></div>';
        const d = new Date(p.next_earnings + 'T00:00:00');
        const days = Math.round((d - new Date()) / 86400000);
        const near = days >= 0 && days <= 10;
        return `<div><span class="kk">Results</span><span class="vv${near ? ' warn' : ''}">${
          days < 0 ? esc(String(p.next_earnings).slice(5)) :
          days === 0 ? 'today' : 'in ' + days + 'd'}</span></div>`;
      })()}
    </div>
    ${p.entry ? `<div class="kv lv-plan">
      <div><span class="kk">Entry</span><span class="vv">${price(p.entry)}</span></div>
      <div><span class="kk">Stop</span><span class="vv dn">₹${esc(p.stop)} <i>${esc(p.stop_pct)}%</i></span></div>
      <div><span class="kk">Target 1</span><span class="vv up">${price(p.t1)} <i>+${esc(p.t1_pct)}%</i></span></div>
      <div><span class="kk">Target 2</span><span class="vv up">${price(p.t2)} <i>+${esc(p.t2_pct)}%</i></span></div>
    </div>
    ${trailPlan(p.entry, p.stop, p.t1, p.t2, p.t3, 'BUY')}` : ''}
    <div class="card-foot">
      <span class="mono" style="font-size:var(--t-2);color:var(--dim)">₹${p.turnover_cr != null ? Math.round(p.turnover_cr) : '—'} cr traded · not advice</span>
      ${symLinks(p.sym)}
    </div>
  </article>`;

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
        </svg>
        <span class="idea-cxl">6M closes · target and stop to scale</span>`;
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
        : (IPO_AGE_H != null ? `<span class="subs-age${IPO_AGE_H > 6 ? ' is-old' : ''}">
            as at ${esc(IPO_STAMP)}${IPO_AGE_H > 6
              ? ` · <b>${esc(ageWord(IPO_AGE_H))}</b>, and a book moves fastest on its last day`
              : ''}</span>` : '')}
      ${cats.length ? `<span class="subs-cat">${cats.slice(0, 4).map(c =>
          `<i><u>${esc(c.cat)}</u><b>${Number(c.x).toFixed(2)}×</b></i>`).join('')}</span>` : ''}`;
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
  const istToday = () => {
    // en-CA renders YYYY-MM-DD, which compares correctly as a plain string.
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
    catch { return new Date().toISOString().slice(0, 10); }
  };
  const daysLeftFor = r => {
    const cd = String(r.close_date || '').slice(0, 10);
    // No usable close date: keep whatever the build said rather than invent one.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cd)) return r.days_left != null ? r.days_left : null;
    return Math.round(
      (Date.parse(cd + 'T00:00:00Z') - Date.parse(istToday() + 'T00:00:00Z')) / 86400000);
  };
  /* Books the calendar still says are taking bids. A negative days_left is a
   * closed book, and it must not appear under a heading that says "open". */
  const ipoOpenNow = list => (list || []).filter(r => {
    const dl = daysLeftFor(r);
    return dl == null || dl >= 0;
  });

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
   * What this does NOT know is holidays. Diwali, Thanksgiving and Boxing Day
   * will each show a market as open when it is shut. The strip says so in
   * words rather than quietly being wrong — a market-hours widget that claims
   * more precision than it has is worse than none.
   */
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

  function exchangeState(tz, open, close) {
    const t = zoneNow(tz);
    const now = t.h + t.m / 60 + t.s / 3600;
    const weekend = t.wd === 'Sat' || t.wd === 'Sun';
    if (!weekend && now >= open && now < close)
      return { open: true, label: 'Closes in ' + fmtGap((close - now) * 60), t };
    // Next open: later today on a weekday, otherwise the next weekday morning.
    let wait;
    if (!weekend && now < open) wait = (open - now) * 60;
    else {
      const daysAhead = t.wd === 'Fri' ? 3 : t.wd === 'Sat' ? 2 : 1;
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
    const st = EXCHANGES.map(([, , tz, o, c]) => exchangeState(tz, o, c));
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
            <span class="wc-e">${esc(code)} · <b>${x.open ? 'Open' : 'Closed'}</b></span>
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
        <p class="hint" style="margin:0 0 14px">Ordered by how many of the 750 screened names each
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
          <span class="t5m"><b>${Number(r.vol_spike).toFixed(2)}×</b> average volume
            · <i class="${dir(r.r1d)}">${pct(r.r1d)}</i> today
            · ₹${esc(fmtN(r.price))}
            · RSI <b class="${zc}">${r.rsi != null ? Math.round(r.rsi) : '—'}</b> <em>${esc(zw)}</em></span>
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
    paint(head('Markets', 'The board live, and what the 750-name screen underneath it did.', 'The board') +
      sec('Breadth', `<div class="sk" style="height:104px"></div>`) +
      sec('Sector heat', `<div class="sk" style="height:120px"></div>`) +
      sec('The board', `<div class="board">${skel('sk-row', 8)}</div>`));

    const [m, p] = await Promise.all([get('/api/markets'), get('/pulse.json')]);
    let out = head('Markets', 'The board live, and what the 750-name screen underneath it did.', 'The board');
    const pu = p.ok ? p.data : {};
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
        ['Screened', pu.universe || 750, 'names re-run daily'],
      ]);
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
    out += sec('Sector heat — the week, all 750', heatmap(pu.sectors, 'r1w') +
      `<p class="hint">Median move over the <b>past week</b> across the full <b>${pu.universe || 750}-name</b>
        screen — the wider, slower view. The front page shows today over the largest 250.
        Width is how many names the sector holds; tap one for the names behind it.</p>`
      + heatKey(1.5, 'Sector move'),
      pu.sectors ? `${pu.sectors.length} sectors · one week` : '');

    // /api/ticker, not /api/markets: markets returns a curated NINE, the
    // ticker returns all 71 across eleven segments — Asia, India, Europe, US,
    // commodities, FX (USD/INR, MYR/INR, USD/MYR, AED/INR), crypto. The board
    // was showing a twelfth of what the origin already computes.
    const tk = await get('/api/ticker');
    if (tk.ok) {
      const segs = (tk.data.segments || []).filter(sg => (sg.items || []).length);
      MKDATA = new Map();   // one map per paint; the route repaints every 60s
      out += sec('The board',
        segs.map(sg => `<div class="segh">${esc(sg.icon || '')} ${esc(sg.label)}
            ${segWhen(sg.items)}<span class="cnt">${sg.items.length}</span></div>
          <div class="board">${sg.items.map(mkRow).join('')}</div>`).join('') +
        `<p class="sec-note"><b>Every row opens.</b> The line under each name is the past month of
          real daily closes; the bar beside it is where the price sits between its own 52-week low
          and high ${tip('range52')}. Tap a row for the extremes, the day's range, volume, the exchange session ${tip('session')} and
          the exact time the quote was taken. A figure this site cannot measure says
          <b>Not measured</b> — it is never filled in.</p>`,
        `${tk.data.live ?? 0} of ${tk.data.total ?? 0} live`,
        'Forty-six instruments, each with the year behind it.');
    } else { out += sec('The board', fail('The live board', tk.error)); }

    const movers = () =>
      sec('Biggest movers, one week', levelTable((pu.movers_up || []).slice(0, 8)),
        '', 'What actually moved, over a week rather than a day.') +
      sec('Biggest fallers, one week', levelTable((pu.movers_dn || []).slice(0, 8)),
        '', 'The other half of the same week.');
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

  R['/ideas'] = async () => {
    paint(head('Ideas', 'Ranked names, and the orders a fully-sized book would place against them. Sizes are shown as a share of the book, so they scale to whatever you run.', 'Ranked ideas') +
      sec('Trade ideas', skel('sk-card', 3)));
    const [t, mn, p, tk, lg] = await Promise.all(
      [get('/today.json'), get('/mandate.json'), get('/pulse.json'), get('/api/ticker'), ledger()]);
    let out = head('Ideas', 'Ranked names, and the orders a fully-sized book would place against them. Sizes are shown as a share of the book, so they scale to whatever you run.', 'Ranked ideas');
    if (!t.ok) { paint(out + fail('Ideas', t.error)); return; }
    /* What is on this page, before the cards. A reader arriving here cannot
     * otherwise tell whether "ideas" means five names or fifty, nor which of
     * them the site has any record on. */
    {
      const td = t.data || {};
      const mb = (td.multibaggers || td.multibagger || []).length || null;
      const pk = (td.picks || []).length || null;
      const wk = (td.picks_week || []).length || null;
      out += snap([
        pk ? ['Ranked today', pk, 'daily engine'] : null,
        mb ? ['Multibaggers', mb, 'weekly scan', 'ac'] : null,
        wk ? ['This week', wk, 'top picks'] : null,
        ['Cleared for capital', '0', 'of 7 engines', 'dn'],
      ], 'No engine has 30 closed trades at t&nbsp;≥&nbsp;2, so nothing here is a '
       + 'recommendation. <a href="/signals">The record</a> is the reason.');
    }

    /* ── MULTIBAGGERS LEAD ────────────────────────────────────────────────
     *
     * This page opened on the daily engine's ranked picks. The weekly
     * multibagger scan is the list that is actually meant to be held, and it
     * was buried on the Markets board as a segment of five.
     *
     * Every row carries its own provenance — the date it was picked, the
     * price it was picked at, the target it was given, its score, and what it
     * has done since. A pick shown beside a live price with none of that
     * cannot be checked by the person reading it, which is the whole problem
     * with published ideas.
     *
     * "Replaced every week" is a property of the scan, not of this page: the
     * query takes the newest scan date only, so the list turns over when the
     * Saturday run writes a new one and shows its vintage in the meantime. */
    const mbSeg = tk.ok
      ? (tk.data.segments || []).find(x => /MULTIBAGGER/i.test(x.label || ''))
      : null;
    const mbRows = (mbSeg && mbSeg.items) || [];
    const picked = mbRows.find(r => r.pick_date) || {};

    out += sec('Multibaggers this week', mbRows.length ? `<div class="mbg">${mbRows.map(r => {
        const since = r.pick_entry && Number.isFinite(Number(r.price_raw))
          ? (r.price_raw - r.pick_entry) / r.pick_entry * 100 : null;
        const up = r.pick_target && Number.isFinite(Number(r.price_raw))
          ? (r.pick_target - r.price_raw) / r.price_raw * 100 : null;
        return `<article class="mbc" data-sym="${esc(r.name)}">
          <div class="mbc-h">
            <button type="button" class="mbc-s" data-card="${esc(r.name)}">${esc(r.name)}</button>
            ${watchBtn(r.name)}
            ${r.pick_score != null ? `<span class="mbc-sc">${Math.round(r.pick_score)}</span>` : ''}
          </div>
          <div class="mbc-px">
            <span><i>Now</i><b>${esc(r.price ?? '—')}</b></span>
            <span><i>Picked at</i><b>${r.pick_entry != null ? '₹' + esc(fmtN(r.pick_entry)) : '—'}</b></span>
            <span><i>Target</i><b>${r.pick_target != null ? '₹' + esc(fmtN(r.pick_target)) : '—'}</b></span>
          </div>
          <div class="mbc-m">
            ${since != null ? `<span class="${dir(since)}"><b>${pct(since)}</b> since picked</span>` : ''}
            ${up != null ? `<span><b>${pct(up)}</b> to target</span>` : ''}
            ${r.pick_date ? `<span class="mbc-d">picked ${esc(r.pick_date)}</span>` : ''}
          </div>
        </article>`;
      }).join('')}</div>
      <p class="hint">The scan runs on a Saturday and this list is the newest run — it does not
        change between runs, and the prices beside the names are live, which is what makes a
        stalled-looking list look like a bug rather than the design.</p>`
      : `<div class="empty">The weekly scan has not written a list in the last month, so there is
         nothing current to show. Stale ideas presented as current would be worse.</div>`,
      mbRows.length ? `${mbRows.length} names${picked.pick_date ? ` · ${esc(picked.pick_date)}` : ''}` : '',
      'The weekly list, with what each name was picked at and what it has done since.');

    /* ── AI LONG-TERM IDEAS, IN THREE STAGES ──────────────────────────────
     *
     * The ask was for AI signals in three buckets — swing, short term, long
     * term. The data does not support that reading and it is worth being
     * exact about why, because the honest version is still useful.
     *
     * Every one of these signals carries `timeframe: LONG` and a stated
     * horizon of "2-3 years". There is no swing bucket and no short-term
     * bucket; the engine does not produce them. What each signal DOES carry
     * is three targets — and checked across all seventeen, those targets are
     * always exactly +35%, +75% and +150% from entry. An identical ladder on
     * every name.
     *
     * So they are not three calls at three horizons. They are three
     * milestones on ONE multi-year thesis, and the ladder is a rule rather
     * than per-name analysis. Presenting them as three independent horizons
     * would dress a fixed rule up as three pieces of research.
     *
     * What is genuinely per-name is everything else: the entry, the structure
     * stop, the fundamental and technical scores, and the written thesis. So
     * the stages are shown as stages, the fixed ladder is disclosed once, and
     * the analysis that IS specific to the name is given the room.
     */
    /* ONE ROW PER NAME — THE LATEST.
     *
     * ai_longterm re-runs weekly and files the same names again; nothing closes
     * or supersedes the previous row, so every filing stays OPEN and this page
     * rendered all of them. SHRIRAMFIN appeared FOUR times (05 Aug, 15 Aug,
     * 22 Aug, 05 Sep) at four different entries — 1122.40, 1122, 1130, 1041 —
     * which reads as four separate ideas on one company. It is one idea,
     * restated. 21 open rows collapse to 13 names.
     *
     * The newest filing wins because it is the one whose levels were computed
     * against the price the reader is looking at. The others are not deleted
     * from the ledger — they are the record, and the record is not edited — they
     * are simply not presented as separate ideas. The count of what was folded
     * away is stated, because silently showing 13 of 21 rows is the kind of
     * quiet filtering this site is supposed to make visible. */
    const aiAll = (lg.ok ? lg.rows : []).filter(r =>
      String(r.signal_type) === 'ai_longterm' && String(r.status) === 'OPEN');
    const aiLatest = new Map();
    for (const r of aiAll) {
      const k = String(r.symbol || '').toUpperCase();
      const prev = aiLatest.get(k);
      if (!prev || String(r.date || '') > String(prev.date || '')) aiLatest.set(k, r);
    }
    const aiRows = [...aiLatest.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const aiSuperseded = aiAll.length - aiRows.length;

    const STAGES = [
      ['target1', 'First objective', 'the move that says the thesis is working'],
      ['target2', 'Base case', 'what the engine is actually underwriting'],
      ['target3', 'Full thesis', 'the whole idea, over its stated horizon'],
    ];

    if (aiRows.length) {
      const horizon = ((aiRows[0].metadata || {}).horizon) || 'multi-year';
      out += sec('AI long-term ideas', (aiSuperseded ? `<p class="hint" style="margin:-4px 0 14px">
        Showing the <b>latest</b> filing for each name. The engine re-runs weekly and
        re-files names it still likes, so <b>${aiSuperseded}</b> earlier open row${aiSuperseded === 1 ? '' : 's'}
        for these same companies ${aiSuperseded === 1 ? 'is' : 'are'} folded away here.
        They remain in <a href="/signals">the ledger</a> — the record is not edited.</p>` : '') +
        `<div class="aig">${aiRows.map(r => {
        const md = r.metadata || {};
        const facts = md.facts || {};
        const entry = Number(r.entry), stop = Number(r.sl);
        const now = Number(facts.price) || entry;
        const risk = Math.abs(entry - stop) || 1;
        const top = Number(r.target3) || entry;
        const at = v => Math.max(0, Math.min(100, ((v - stop) / ((top - stop) || 1)) * 100));
        return `<article class="aic">
          <div class="aic-h">
            <button type="button" class="aic-s" data-card="${esc(r.symbol)}">${esc(r.symbol)}</button>
            ${watchBtn(r.symbol)}
            ${r.grade ? `<span class="aic-g">${esc(r.grade)}</span>` : ''}
            ${md.sector ? `<span class="aic-x">${esc(md.sector)}</span>` : ''}
          </div>

          <div class="aic-lv">
            <span><i>Entry</i><b>₹${esc(fmtN(entry))}</b></span>
            <span><i>Structure stop</i><b>₹${esc(fmtN(stop))}</b></span>
            <span><i>Risk per share</i><b>₹${esc(fmtN(risk))}</b></span>
            ${Number.isFinite(Number(md.fund_score)) ? `<span><i>Fundamental</i><b>${Math.round(md.fund_score)}</b></span>` : ''}
            ${Number.isFinite(Number(md.tech_score)) ? `<span><i>Technical</i><b>${Math.round(md.tech_score)}</b></span>` : ''}
          </div>

          ${/* One track, three milestones, and where price stands on it. */''}
          <div class="aic-tr">
            <span class="aic-fill" style="width:${at(now).toFixed(1)}%"></span>
            <i class="aic-now" style="left:${at(now).toFixed(1)}%"></i>
            <u class="aic-nowl" style="left:${at(now).toFixed(1)}%">now ₹${esc(fmtN(now))}</u>
            ${STAGES.map(([k]) => Number.isFinite(Number(r[k]))
              ? `<i class="aic-m" style="left:${at(Number(r[k])).toFixed(1)}%"></i>` : '').join('')}
          </div>

          <ol class="aic-st">
            ${STAGES.map(([k, label, why], i) => {
              const v = Number(r[k]);
              if (!Number.isFinite(v)) return '';
              const gain = ((v - entry) / entry) * 100;
              const R = (v - entry) / risk;
              const away = ((v - now) / now) * 100;
              const done = now >= v;
              return `<li class="aic-s${done ? ' is-done' : ''}">
                <span class="aic-n">${i + 1}</span>
                <span class="aic-b">
                  <b>${esc(label)}</b>
                  <em>${esc(why)}</em>
                </span>
                <span class="aic-v">
                  <b>₹${esc(fmtN(v))}</b>
                  <em>${pct(gain)} from entry · ${R.toFixed(1)}R</em>
                  <u>${done ? 'reached' : `${pct(away)} away`}</u>
                </span>
              </li>`;
            }).join('')}
          </ol>

          ${md.thesis ? `<p class="aic-t">${esc(String(md.thesis))}</p>` : ''}
          ${md.rationale ? `<p class="aic-r">${esc(String(md.rationale))}</p>` : ''}
        </article>`;
      }).join('')}</div>
      <p class="hint"><b>Three stages, one idea — not three calls.</b> Every one of these signals states
        a single horizon of <b>${esc(horizon)}</b>, and its three targets sit at a fixed
        <b>+35%</b>, <b>+75%</b> and <b>+150%</b> from entry on every name without exception. The
        ladder is a rule, so the stages are milestones on one thesis rather than three separate
        pieces of research. What IS specific to each name is the entry, the structure stop, the two
        scores and the written thesis — which is why those are what the card spends its room on.</p>`,
        `${aiRows.length} open · ${esc(horizon)}`,
        'One thesis per name, and the three points at which it would have paid.');
    }

    const picks = t.data.picks || [];
    out += sec('The daily engine’s ranked picks', picks.length ? `<div class="cards-2">${picks.map(x => ideaCard(x, false)).join('')}</div>`
      : `<div class="empty">Nothing clears the bar this week. That is a result, not a gap.</div>`,
      `${picks.length} ranked`, 'A different engine, on a different clock — names that cleared every floor, and the levels that define each one.');

    const pu = p.ok ? p.data : {};
    out += sec('Breaking to 52-week highs',
      levelTable((pu.breakouts || []).slice(0, 12)),
      pu.breakouts ? `${pu.breakouts.length} names` : '');

    if (mn.ok) {
      const d = mn.data, st = d.state || {}, orders = d.admitted || [];
      // Marks for every order in one call, so the page shows what the idea is
      // worth NOW rather than what it was worth at 6 AM.
      const px = await quotes(orders.map(o => o.symbol));
      // Size as a SHARE of the book, not only in rupees. A reader running
      // ₹2 lakh cannot use "₹10 L"; they can use "10% of the book".
      const shareOf = v => d.capital ? (Number(v) / d.capital * 100) : null;

      out += sec('The book', `<div class="grid" style="margin-bottom:10px">
          ${tile(orders.length, 'Orders to place', 'nothing here is bought yet', 'ac')}
          ${tile(st.deployed_pct != null ? st.deployed_pct + '%' : '—', 'Would be deployed',
                 st.heat_pct != null ? st.heat_pct + '% at risk if every stop hits' : '')}
        </div>` + (orders.length ? orders.map(o => {
          const live = px[o.symbol];
          const move = live ? pnlOf(o.entry, live.price, 'BUY') : null;
          const sh = shareOf(o.notional);
          return `<article class="card" data-sym="${esc(o.symbol || '')}" role="button" tabindex="0">
            <div class="card-h"><span class="sym">${esc(o.symbol || '')}</span>
              ${o.engine ? `<span class="pill" title="${esc(String(o.engine))}">${
                esc(engName(o.engine))}</span>` : ''}
              <span class="spacer"></span>
              ${live ? `<span class="pill ${move > 0 ? 'pill-up' : 'pill-dn'}">${pct(move)} vs entry</span>`
                     : `<span class="pill">no mark</span>`}
              ${o.rr ? `<span class="pill pill-up">${esc(o.rr)}:1</span>` : ''}</div>
            <div class="kv">
              <div><span class="kk">Entry</span><span class="vv">₹${esc(o.entry ?? '—')}</span></div>
              <div><span class="kk">Last</span><span class="vv">${live ? price(live.price) : '—'}</span></div>
              <div><span class="kk">Stop</span><span class="vv dn">₹${esc(o.stop ?? '—')}</span></div>
              <div><span class="kk">Size</span><span class="vv">${sh != null ? sh.toFixed(1) + '% of book' : '—'}</span></div>
              <div><span class="kk">Risk</span><span class="vv">${o.risk_pct != null ? o.risk_pct + '%' : (d.capital ? (Number(o.risk_amount) / d.capital * 100).toFixed(2) + '%' : '—')}</span></div>
              <div><span class="kk">Hold</span><span class="vv" style="font-size:var(--t-2)">${esc(o.hold_days || o.horizon || '—')}</span></div>
            </div>
            ${(o.legs || []).length ? `<div class="ladder">
              ${o.legs.map(l => `<div class="leg">
                <span class="leg-l">${esc(l.label)}</span>
                <span class="leg-p">₹${esc(l.price)}</span>
                <span class="leg-q">${esc(l.qty)} sh</span>
                <span class="leg-g up">+${esc(l.gain_pct)}%</span>
                <span class="leg-r">${esc(l.r_multiple)}R</span>
              </div>`).join('')}
            </div>` : ''}
            ${o.trail_note ? `<div class="trail"><span>Trailing stop</span>${esc(o.trail_note)}</div>` : ''}
            <div class="card-foot">
              <span class="mono" style="font-size:var(--t-2);color:var(--dim)">${sh != null ? 'sized at ' + sh.toFixed(1) + '% — scale to your own book' : ''}${o.hold_days ? ' · hold ' + esc(o.hold_days) : ''}</span>
              ${symLinks(o.symbol)}
            </div>
          </article>`; }).join('') : `<div class="empty">No orders clear the mandate today.</div>`));
    }
    paint(out);
    fillIdeaCharts(picks);   // six months of real closes on every idea, after paint

  };

  R['/ipo'] = async () => {
    paint(head('IPO', 'Books open now, what is coming, and how the last year of listings actually did.', 'Primary market') +
      sec('Open now', skel('sk-card', 2)));
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
    let out = head('IPO', 'Books open now, what is coming, and how the last year of listings actually did.', 'Primary market');
    if (!io.ok) { paint(out + fail('The IPO radar', io.error)); return; }
    const d = io.data, c = d.counts || {};

    const dOpen = ipoOpenNow(d.open);
    out += sec('Where it stands', `<div class="grid">
        ${tile(dOpen.length, 'Books open', 'bidding today', dOpen.length ? 'ac' : '')}
        ${tile((d.upcoming || []).length, 'Upcoming', 'announced, not open')}
        ${tile((d.awaiting_listing || []).length, 'Awaiting listing', 'closed, not yet traded')}
        ${tile(c.apply ?? '—', 'Rated apply', 'on public demand only', c.apply ? 'up' : '')}
      </div>`);

    out += sec('Open now', dOpen.length ? `<div class="cards-2">${dOpen.map(ipoCard).join('')}</div>`
      : `<div class="empty">No mainboard book is open today.</div>`);

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

    if ((d.upcoming || []).length) out += sec('Upcoming', `<div class="cards-2">${d.upcoming.map(ipoCard).join('')}</div>`);
    if ((d.awaiting_listing || []).length)
      out += sec('Awaiting listing', `<div class="cards-2">${d.awaiting_listing.map(ipoCard).join('')}</div>`);

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
    const rec = (d.recent_listed || []).slice().sort((a, b) =>
      (b.since_listing_pct ?? -1e9) - (a.since_listing_pct ?? -1e9));
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
      <span class="x ${dir(r.from_high_pct)}" data-l="Off high">${
        r.from_high_pct != null ? pct(r.from_high_pct) : '—'}</span>
      <span class="m ${dir(r.since_listing_pct)}" data-l="Since listing">${
        pct(r.since_listing_pct)}</span>`,
      ipoDetail(r),
      { cls: 'lvl-r ipo-lr',
        // The up/below-issue chips filter on this. Dropping it when the row
        // became expandable silently broke both chips — the rows stayed put
        // and nothing errored.
        attrs: `data-since="${Number(r.since_listing_pct) >= 0 ? 'up' : 'dn'}"` });
    const ipoHead = `<div class="rank-r lvl-r rank-head">
      <span class="i">#</span><span class="s">Company</span>
      <span class="x">Listed</span><span class="x">Price band</span>
      <span class="x">Listed at</span><span class="x">Last</span>
      <span class="x">Range since</span>
      <span class="x">Off high</span><span class="m">Since listing ↓</span></div>`;
    const up = rec.filter(r => Number(r.since_listing_pct) >= 0).length;
    out += sec('How recent listings have done', rec.length
      ? `<div class="chips" id="ipoflt">
           <button type="button" class="chip" data-f="all" aria-pressed="true">All ${rec.length}</button>
           <button type="button" class="chip" data-f="up" aria-pressed="false">Above issue ${up}</button>
           <button type="button" class="chip" data-f="dn" aria-pressed="false">Below issue ${rec.length - up}</button>
         </div>
         <div class="rank" id="ipotbl">${ipoHead}${rec.map(ipoRow).join('')}</div>
         <p class="hint">Two years of mainboard listings, sorted by move since listing.
           <b>Price band</b> is what the book was offered at. <b>Listed at</b> is the first
           traded close, not the issue price — NSE's issue-price data is not reliable and a
           listing gain computed off a guessed one is fabricated, so this site measures from
           the first price the market actually set. <b>Range since</b> is the high and low it
           has traded between since. A book that never traded above its band is the case this
           table exists to make visible.</p>`
      : `<div class="empty">No listings in the window.</div>`,
      `${rec.length} listings`);
    paint(out);

    /* Filtering by attribute rather than re-rendering: the rows are already in
     * the DOM and re-running the map would drop the live figures fillIpoLive
     * writes into them a moment later. */
    const flt = main.querySelector('#ipoflt');
    if (flt) flt.addEventListener('click', e => {
      const b = e.target.closest('.chip[data-f]');
      if (!b) return;
      const f = b.dataset.f;
      flt.querySelectorAll('.chip').forEach(c =>
        c.setAttribute('aria-pressed', String(c === b)));
      main.querySelectorAll('#ipotbl .rank-r[data-since]').forEach(row => {
        const hide = f !== 'all' && row.dataset.since !== f;
        row.hidden = hide;
        /* THE PANEL IS A SIBLING, SO IT HAS TO BE HIDDEN TOO.
         * Filtering only the row left its expanded detail behind — a block of
         * figures under a heading whose row was no longer on screen. A filtered
         * row is also collapsed, because reappearing already-open is a state
         * the reader did not ask for. */
        const panel = document.getElementById(row.getAttribute('aria-controls') || '');
        if (panel) {
          panel.hidden = hide || panel.hidden;
          if (hide) {
            panel.hidden = true;
            row.setAttribute('aria-expanded', 'false');
            row.classList.remove('is-open');
          }
        }
      });
    });
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
  /* FILTERS COMBINE. They used to be radio buttons wearing the shape of
   * chips: picking "Debt-free" threw away "Breaking out", so the one question
   * a screen exists to answer — which names clear SEVERAL bars at once — was
   * the one question it could not be asked. scrPresets is a Set and the
   * predicates are ANDed. Empty means everything, which is what "All" now
   * does rather than being a filter that happens to return true. */
  let scrQ = '', scrPresets = new Set(), scrSort = 'comp', scrPage = 0, SCRDIV = null;

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
     * actually arrives with. The 750-name screen was 89 correct columns and no
     * answer: on the 2026-09-04 build 203 rows carried no tags and no horizon
     * at all, and nothing anywhere said "don't touch this" or "right business,
     * wrong entry". verdict.py supplies one call per row — see its header for
     * every threshold. It is a reading of the evidence, not a forecast. */
    buy_lt:     ['Buy · long term', r => r.vd?.c === 'BUY' && r.vd?.h === 'long term'],
    buy_pos:    ['Buy · positional', r => r.vd?.c === 'BUY' && r.vd?.h === 'positional'],
    buy_swing:  ['Buy · swing',    r => r.vd?.c === 'BUY' && r.vd?.h === 'swing'],
    waiting:    ['Wait for entry', r => r.vd?.c === 'WAIT'],
    avoid:      ['Red flags',      r => r.vd?.c === 'AVOID' || (r.vd?.f || []).length > 0],
    breakout:   ['Breaking out',   r => (r.setup?.tags || []).some(t => /BREAKOUT/.test(t))],
    rsleader:   ['RS leaders',     r => (r.setup?.tags || []).includes('RS LEADER')],
    volume:     ['Volume spike',   r => (r.vol_spike ?? 0) >= 2],
    oversold:   ['Oversold',       r => (r.rsi ?? 99) < 35],
    quality:    ['High quality',   r => (r.q ?? 0) >= 70],
    value:      ['Cheap',          r => (r.v ?? 0) >= 70],
    debtfree:   ['Debt-free',      r => (r.de ?? 9) <= 0.1],
    compounder: ['Compounders',    r => (r.roce ?? 0) >= 20 && (r.rev_cagr ?? 0) >= 12],
  };
  const SORTS = { comp: 'Composite', q: 'Quality', g: 'Growth', v: 'Value',
                  tech: 'Technical', r1m: '1M return', roce: 'ROCE', mcap_cr: 'Size',
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

    return `<section class="insti-g" aria-label="Institutional movement filters">
      <div class="insti-h">
        <h3>Institutional movement</h3>
        <span class="insti-sub">FII and DII holding, ${esc(INSTI_META.latest_period_end
          ? 'latest quarterly filings' : 'quarterly filings')} · change in percentage points</span>
        ${active ? `<button type="button" class="insti-clear" id="insti-clear">Clear</button>` : ''}
      </div>
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
    </section>`;
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
    const screenSnap = rows => ((num) => snap([
      ['Universe', rows.length, 'names screened'],
      ['Above 200-day', rows.filter(r => num(r.price) && num(r.sma200) && num(r.price) > num(r.sma200)).length,
       'in an uptrend', 'up'],
      ['At 52-week high', rows.filter(r => r.brk52w).length, 'breaking out', 'ac'],
      ['Median ATR', (() => {
        const a = rows.map(r => num(r.atr_pct)).filter(x => x != null).sort((x, y) => x - y);
        return a.length ? a[Math.floor(a.length / 2)].toFixed(2) + '%' : null;
      })(), 'daily range'],
    ]))(v => { const x = Number(v); return Number.isFinite(x) ? x : null; });
    const shell = body => head('Screen',
      'Every one of the 750 names, searchable. Tap any row for the full card.',
      'The full universe') + body;
    if (!SCREEN) paint(shell(`<div class="note">Loading the full universe — about 260 KB, once per session.</div>` +
      `<div class="sk" style="height:320px"></div>`));

    if (!SCREEN) {
      // In parallel, and institutional data is allowed to fail: it is one
      // section of one screen, and losing it must never cost the reader the
      // 750 rows they actually came for.
      const [r] = await Promise.all([get('/screen.json').then(noteLadder), loadInsti()]);
      if (!r.ok) { paint(shell(fail('The screen', r.error))); return; }
      SCREEN = (r.data.rows || []).filter(x => x && x.sym);
    } else await loadInsti();

    let shownRows = [];          // the page the live quote call must ask for
    const draw = () => {
      const q = scrQ.trim().toLowerCase();
      const rows = SCREEN
        .filter(r => [...scrPresets].every(k => PRESETS[k][1](r)))
        .filter(r => !q || (r.sym || '').toLowerCase().includes(q)
                        || (r.name || '').toLowerCase().includes(q)
                        || (r.sector || '').toLowerCase().includes(q))
        .filter(instiPass)
        .sort((a, b) => (sortVal(b, scrSort) ?? -1e9) - (sortVal(a, scrSort) ?? -1e9));

      main.innerHTML = shell(
        screenSnap(SCREEN) +
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
          const PER = 40;
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
          return sec(title, rows.length ? screenTable(page, from) + heatKey(20, 'Distance from the moving averages') + key + nav
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
      main.querySelector('#scrs').addEventListener('change', e => { scrSort = e.target.value; draw(); });
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
   * given to every one of the 750 names.
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

  const PLKEY = `<p class="pl-key">
    <span>Each row's line runs from its <b>52-week low</b> to its <b>high</b>:</span>
    <span><i class="know"></i>price now</span>
    <span><i class="k200"></i>200-day</span>
    <span><i class="k50"></i>50-day</span>
    <span><i class="k20"></i>20-day</span>
    <span>— the levels these engines trade against.</span></p>`;

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
  const VD_WORD  = { BUY: 'Act', WAIT: 'Wait', AVOID: 'Ignore',
                     WATCH: 'Watch', UNRATED: 'Not rated' };

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

  const ladderBlock = r => {
    const L = r.lad;
    if (!L || !Array.isArray(L.t)) return '';
    const rows = L.t.map(([px, rr, reach, b], i) => `
      <tr>
        <td class="lad-t">T${i + 1}</td>
        <td class="lad-px">₹${fmtN(px)}</td>
        <td class="lad-r">${rr.toFixed(2)}R</td>
        <td><span class="pill ${reachClass(reach)}">${reach}%</span></td>
        <td class="lad-why">${esc(basisText(b))}</td>
      </tr>`).join('');
    const wall = L.w ? `<p class="lad-wall"><i>In the way</i> ₹${fmtN(L.w[0])}
      (${L.w[1]}R) — ${esc(basisText(L.w[2]))}. The trade has to clear it to reach T1.</p>` : '';
    return `<div class="lad">
      <div class="lad-head">
        <b>If you traded it</b>
        <span class="lad-risk">Entry ₹${fmtN(L.e)} · Stop ₹${fmtN(L.s)} · risking ${L.rk}%</span>
      </div>
      <div class="scroll-x"><table class="lad-tbl">
        <thead><tr><th></th><th>Target</th><th>R</th>
          <th title="Share of closed trades whose best move reached at least this far. Measured, not forecast.">Reached</th>
          <th>Because</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${wall}
      <p class="lad-trail">${L.tr
        ? 'Fundamentals are strong enough to <b>trail</b> after T2 — ratchet a stop under each higher low rather than capping the exit. A fixed target cannot capture an extended move, and this ledger\'s 90th-percentile run is 2.28R.'
        : 'No trail. The fundamental case is not strong enough to justify holding past the last target.'}</p>
      <p class="lad-foot">Stop is ${ladderMeta()?.stop_atr_mult ?? 1.41}× ATR below entry. "Reached" is measured over
        ${ladderMeta()?.reach_sample ?? 120} closed trades${L.ao ? '. Today\'s levels are anchors only — 52-week high and moving averages; swing-high levels arrive with the next weekly screen' : ''}.
        Not advice, and not a forecast.</p>
    </div>`;
  };

  const screenTable = (rows, offset) => `<div class="rank">
    <div class="rank-r rank-head scr-r">
      <span class="i">#</span><span class="s">Name</span>
      <span class="x">Price</span><span class="x">Today</span><span class="x">vs 50D</span>
      <span class="x">vs 200D</span><span class="x">RSI 14D</span><span class="m">1M</span>
      <span class="x">52w low</span><span class="x">52w high</span>
    </div>
    ${rows.map((r, i) => {
      const v50 = r.sma50 ? (r.price - r.sma50) / r.sma50 * 100 : null;
      const v200 = r.sma200 ? (r.price - r.sma200) / r.sma200 * 100 : null;
      /* data-sym opens the sheet, which keeps your place in 750 rows.
       * data-href gives the same row a real destination, so the company page
       * is reachable and shareable rather than existing only behind a tap. */
      return `<div class="rank-r scr-r" data-sym="${esc(r.sym)}" data-href="/stock/${encodeURIComponent(r.sym)}" role="button" tabindex="0">
        <span class="i">${(offset || 0) + i + 1}</span>
        <span class="s">${watchBtn(r.sym)}<b>${esc(r.sym)}</b><span>${esc(r.name || '')}</span>${instiBadge(r.sym)}</span>
        <span class="x" data-l="Price" data-px>₹${esc(r.price ?? '—')}</span>
        <!-- Filled by the live quote call below. An em dash, not a bullet: a
             cell that never fills should read as "not measured" like every
             other unmeasured cell on this site, not as a decorative dot. -->
        <span class="x" data-l="Today" data-day style="color:var(--dim)">—</span>
        <span class="x ${dir(v50)} ${heatCell(v50, 8)}" data-l="vs 50D" data-v50>${v50 == null ? '—' : pct(v50)}</span>
        <span class="x ${dir(v200)} ${heatCell(v200, 20)}" data-l="vs 200D" data-v200>${v200 == null ? '—' : pct(v200)}</span>
        <span class="x" data-l="RSI" style="color:${(r.rsi ?? 50) > 70 ? 'var(--warn)' : (r.rsi ?? 50) < 35 ? 'var(--accent)' : 'var(--dim)'}">${r.rsi != null ? Math.round(r.rsi) : '—'}</span>
        <span class="m ${dir(r.r1m)} ${heatCell(r.r1m, 12)}" data-l="1 month">${pct(r.r1m)}</span>
        ${/* THE YEAR'S RANGE, AS NUMBERS.
             The price line under each row already draws where the close sits
             between the two, but a bar cannot be read off. The distance from
             each extreme is what makes the pair decision-useful: a 52-week
             high of 2,008 means nothing until you know the close is 3% under
             it, and a low means nothing until you know it is 47% above it. */''}
        <span class="x" data-l="52w low">${r.low52 != null
          ? `${price(r.low52)}${r.price ? `<i class="u52 up">+${((r.price - r.low52) / r.low52 * 100).toFixed(0)}%</i>` : ''}`
          : '—'}</span>
        <span class="x" data-l="52w high">${r.high52 != null
          ? `${price(r.high52)}${r.price ? `<i class="u52 ${r.price >= r.high52 ? 'up' : 'dn'}">${((r.price - r.high52) / r.high52 * 100).toFixed(0)}%</i>` : ''}`
          : '—'}</span>
        <span class="pl-w">${priceLine(r)}</span>
      </div>`; }).join('')}</div>`;

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
  const stockPage = (r) => {
    const { body } = stockCard(r);
    return `<div class="route-h stock-h">
        <span class="eyebrow">Company · ${esc(r.sector || 'NSE')}</span>
        <h1>${watchBtn(r.sym)}${esc(r.sym)}</h1>
        <p>${esc(r.name || '')}</p>
      </div>
      <div class="stock-pg">${body}</div>
      <p class="hint stock-back"><a href="/screen">← All 750 names</a> ·
        <a href="/signals">The ledger</a> · <a href="/engines">What fires a signal</a></p>`;
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
        <span><i>Screen close</i><b>₹${esc(r.price)}</b></span>
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
        ${r.risk?.level ? `<span class="pill ${r.risk.level === 'LOW' ? 'pill-up' : r.risk.level === 'HIGH' ? 'pill-dn' : 'pill-wn'}">RISK ${esc(r.risk.level)}</span>` : ''}</div>
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
      <div class="yoy">${fact('Debt / equity', r.de, '')}${fact('Interest cover', r.icover, 'x')}
        ${fact('Current ratio', r.curr, 'x')}${fact('Tax rate', r.tax)}</div>

      <h4 class="sh">Who owns it</h4>
      ${instiCard(r)}

      <h4 class="sh">Growth${r.fy_count ? ` <em>· compound, over ${esc(r.fy_count)} years of accounts</em>` : ''}</h4>
      <div class="yoy">${yoy('Revenue CAGR', r.rev_cagr)}${yoy('EBITDA CAGR', r.ebitda_cagr)}
        ${yoy('EPS CAGR', r.eps_cagr)}${fact('Earnings momentum', r.em_label, '')}</div>

      <h4 class="sh">Latest year on year</h4>
      <div class="yoy">${yoy('Revenue', r.rev_yoy)}${yoy('EBITDA', r.ebitda_yoy)}${yoy('Profit', r.pat_yoy)}
        ${yoy('EPS', r.eps_yoy)}${yoy('EBIT margin', r.margin_delta, 'pt')}</div>
      <h4 class="sh">Cash quality</h4>
      <div class="yoy">${yoy('Cash conversion (CFO/PAT)', r.cfo_pat, 'x')}${yoy('Free cash / profit', r.fcf_pat, 'x')}
        ${yoy('ROCE', r.roce)}${yoy('Debt / equity', r.de, '')}</div>
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
   * company "is not in the 750-name screen", which is a sentence about the
   * universe used to report a string-format mismatch. This repo has already
   * been bitten by the same suffix in the sector cap and the dedupe guard.
   * Normalised once, here, so every caller agrees. */
  const bareSym = (s) => String(s || '').trim().toUpperCase()
    .replace(/\.(NS|BO|BSE|NSE)$/i, '');

  async function openStock(rawSym) {
    const sym = bareSym(rawSym);
    if (!SCREEN) {
      sheet(esc(sym), `<div class="sk" style="height:210px"></div>
        <p class="hint">Loading the screen — about 260 KB, once per session.</p>`);
      const r0 = noteLadder(await get('/screen.json'));
      if (!r0.ok) { sheet(esc(sym), fail('The company card', r0.error)); return; }
      SCREEN = (r0.data.rows || []).filter(x => x && x.sym);
    }
    // The card can be opened from Today, Markets, Ideas or search, none of
    // which touch the Screen route, so the institutional feed is requested
    // here too. It resolves instantly on the second card.
    await loadInsti();
    const r = (SCREEN || []).find(x => x.sym === sym);
    if (!r) {
      sheet(esc(sym), `<div class="empty">${esc(sym)} is not in the 750-name screen,
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

  let sigFilter = 'all';

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
  const sub = (label, body) => `<div class="subsec">
    <h3 class="subsec-h">${esc(label)}</h3>${body}</div>`;

  function floorHtml(d, rows) {
    const last = new Map();
    for (const r of (rows || [])) {
      const k = String(r.signal_type || '');
      if (!last.has(k)) last.set(k, r);          // rows arrive newest first
    }
    const seen = new Set();
    const cards = Object.entries(ENGINE_REGISTRY).map(([key, meta]) => {
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
      return `<article class="ag ag-${state}">
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
          <span><b>${win == null ? '—' : win + '%'}</b>win rate</span>
          <span><b>${trades}</b>closed</span>
        </div>
        <footer class="ag-f">
          <span>${esc(meta.tf)}</span>
          <span>${L ? esc(String(L.symbol || '').replace('.NS', '')) + ' · '
                      + esc(String(L.date || '').slice(5, 10)) : 'nothing filed yet'}</span>
        </footer>
      </article>`;
    }).join('');

    const on = Object.entries(ENGINE_REGISTRY).filter(([k]) => {
      const v = (d.engines || {})[k] || {}; return v.status !== 'disabled';
    }).length;

    /* ── THE ACTIVITY LOG ────────────────────────────────────────────────
     * What the floor has actually DONE, newest first. The cards say what each
     * engine is and what it must earn; none of them says what happened. This
     * is the one strip on the page built from events rather than state, and
     * it is the thing a reader checks first: is anything happening.
     *
     * Real rows only. Where nothing has been filed the strip says so rather
     * than padding itself — an empty log is a true statement about a quiet
     * week, and inventing rows to fill it would make the busiest-looking
     * version of this page the least honest one. */
    const feed = (rows || []).filter(r => ENGINES.has(String(r.signal_type || '')))
      .slice(0, 12);
    const logHtml = !feed.length
      ? `<p class="hint">Nothing filed yet since ${esc(LAUNCH)}.</p>`
      : `<ol class="alog">${feed.map(r => {
          const m = eng(r.signal_type) || {};
          const e = lvl(r.entry), sx = lvl(r.sl), t = lvl(r.target1);
          const rr = (e && sx && t && e !== sx) ? Math.abs(t - e) / Math.abs(e - sx) : null;
          const b = String(r.badge || '').toLowerCase();
          return `<li class="alog-r">
            <span class="alog-d">${esc(String(r.date || '').slice(5, 10))}</span>
            <span class="alog-e">${esc(m.name || r.signal_type)}</span>
            <span class="alog-s">${esc(String(r.symbol || '').replace('.NS', ''))}</span>
            <span class="alog-x">${e ? price(e, r.currency || '₹') : '—'}</span>
            <span class="alog-r2">${rr ? rr.toFixed(2) + 'R' : '—'}</span>
            <span class="alog-b ${b === 'open' ? 'is-open' : 'is-done'}">${esc(b || 'filed')}</span>
          </li>`; }).join('')}</ol>`;

    return sec('The floor', `<div class="floor">${cards}</div>
      ${sub('Latest filings', logHtml)}
      <p class="hint">The bar is how far each engine's floor has been raised above the
        2R default, toward the 6R cap at which it stops publishing altogether. That floor
        comes from the engine's own win rate — break-even R:R is (1−p)/p — so an engine
        that wins less often has to earn more per trade before it is allowed to file one.
        A raised bar is not a fault; it is the system refusing trades that record says
        lose money.</p>`,
      `${on} of ${Object.keys(ENGINE_REGISTRY).length} working`,
      'Who is on the floor, what each one hunts, and what it has to earn to file a trade.');
  }

  R['/signals'] = async () => {
    const intro = 'Every alert this site has sent since it launched, with the levels it was sent at. Scored when it closes — losers included, which is the point of publishing it.';
    paint(head('Signals', intro, 'The public ledger') + skel('sk-card', 4));
    const [a, engRes] = await Promise.all([ledger(), get('/engines.json')]);
    const ENG_TABLE = (engRes && engRes.ok && engRes.data && engRes.data.ok) ? engRes.data : null;
    const base = head('Signals', intro, 'The public ledger')
      + (a.live ? '' : `<div class="note"><b>Showing this morning's snapshot, not the live ledger.</b>
          The live signal feed did not answer${a.error ? ` — ${esc(a.error)}` : ''}, so this page is
          reading the copy written at the last build. Anything the scanner has published since is
          missing from it.</div>`);
    if (!a.ok) { paint(base + fail('The signal ledger', a.error)); return; }
    /* DAY ONE IS TODAY.
     *
     * This surface starts its record from launch. Everything before it was
     * published under a different engine configuration and a ledger that has
     * been re-graded twice, and carrying that history here would mean showing
     * a win rate this site never produced.
     *
     * Nothing is deleted. The ledger still carries every earlier signal and
     * the full performance record — this is a filter on what THIS page counts,
     * not a rewrite of the ledger.
     *
     * Anything sent on or after LAUNCH counts. When there is nothing yet, the
     * page says so rather than showing an empty table that reads as a fault.
     */

    const every = a.rows;
    /* THE CURVE FOLLOWS THE SAME LAUNCH WINDOW AS THE REST OF THE PAGE.
     *
     * It was drawn from the whole ledger and ended at −24.86R over 80 closed
     * trades, on a page whose every other figure counts only from LAUNCH. Two
     * different populations under one heading is the kind of inconsistency
     * that makes a reader distrust both numbers, and rightly.
     *
     * Today that means an EMPTY curve: 25 signals are open and none has
     * closed. So the section says so. An empty record at the start is the
     * truthful state of a record that starts today, and it will fill itself
     * as positions close. The pre-launch history is not deleted — it is
     * summarised below with its own dates attached, so nothing is hidden and
     * nothing is passed off as this site's own result. */
    const CURVE = rCurve(every.filter(sinceLaunch));
    const all = every.filter(sinceLaunch);   // same rule as the curve above

    // Filter on the row's OWN badge, not on arithmetic over pnl_pct.
    // `Number(null) <= 0` is true, so the first version put all 138 open
    // signals under "Losers" — the ledger already labels every row, and
    // re-deriving a label that exists is how you invent a different one.
    const isOpen = r => (r.badge || '').toLowerCase() === 'open';
    const closed = all.filter(r => !isOpen(r) && r.pnl_pct != null);
    const wins = all.filter(r => (r.badge || '').toLowerCase() === 'win').length;
    const losses = all.filter(r => (r.badge || '').toLowerCase() === 'loss').length;
    const opens = all.filter(isOpen);

    // One request for every open signal's mark, not one per card.
    const px = await quotes(opens.map(r => r.symbol));

    const chips = [['all', `All ${all.length}`], ['open', `Open ${opens.length}`],
                   ['win', `Winners ${wins}`], ['loss', `Losers ${losses}`],
                   ['expired', 'Expired']];

    const card = r => {
      const b = (r.badge || '').toLowerCase();
      const cur = r.currency || '₹';
      const live = px[r.symbol];
      const open = isOpen(r);
      const unreal = open && live ? pnlOf(r.entry, live.price, r.action) : null;
      const shown = open ? unreal : (r.pnl_pct == null ? null : Number(r.pnl_pct));
      const pill = shown == null ? `<span class="pill pill-ac">open</span>`
        /* ZERO IS NOT A LOSS. This was a two-way test, so a flat move — which
         * is what an unmoved stock prints, and what every signal filed today
         * shows before its first tick — came out in the down colour.
         * COCHINSHIP read "0.00% live" in red having not moved at all. */
        : `<span class="pill ${shown > 0 ? 'pill-up' : shown < 0 ? 'pill-dn' : 'pill-flat'}">${
            pct(shown)}${open ? ' live' : ''}</span>`;
      return `<article class="card" data-sym="${esc(r.symbol || '')}" role="button" tabindex="0">
        <div class="card-h">
          <span class="sym">${esc(r.symbol || '')}</span>
          ${r.action ? `<span class="pill ${/SELL|SHORT/i.test(r.action) ? 'pill-dn' : 'pill-up'}">${esc(r.action)}</span>` : ''}
          ${r.signal_type ? `<span class="pill" title="${esc(String(r.signal_type))}">${
            esc(engName(r.signal_type))}</span>` : ''}
          ${r.timeframe ? `<span class="pill">${esc(r.timeframe)}</span>` : ''}
          <span class="spacer"></span>${pill}
        </div>
        <div class="kv">
          <div><span class="kk">Entry</span><span class="vv">${price(r.entry, cur)}</span></div>
          <div><span class="kk">${open ? 'Last' : 'Exit'}</span><span class="vv">${
            open ? (live ? price(live.price, cur) : '<span style="color:var(--dim)">no mark</span>')
                 : cur + esc(r.exit_price ?? '—')}</span></div>
          <div><span class="kk">Stop</span><span class="vv dn">${price(r.sl, cur)}</span></div>
          ${/* ── SHOW THE TARGETS THAT EXIST, NOT THE FIRST TWO SLOTS ──────
              * Hardcoded to Target 1 and Target 2. When the read layer blanks
              * T2 — because it collapsed into T1 and is not a separate exit —
              * the card printed "Target 2 —" and never showed T3 at all, while
              * the scale-out underneath paid the balance out at it. COCHINSHIP
              * live: "Target 2 —" above a rung reading "70% at ₹1,971, at the
              * third", a number appearing nowhere in the grid it belongs to.
              *
              * The row is built from the targets the signal actually has and
              * each is labelled by WHICH one it is, so a two-target signal
              * shows T1 and T3 rather than T1 and a blank. */''}
          ${[['Target 1', lvl(r.target1)], ['Target 2', lvl(r.target2)],
             ['Target 3', lvl(r.target3)]]
              .filter(([, v]) => v !== null)
              .map(([k, v]) => `<div><span class="kk">${k}</span>
                <span class="vv up">${price(v, cur)}</span></div>`).join('')}
          ${(() => {
            /* ── R:R MUST REFER TO A TARGET ON THE CARD ────────────────────
             * The stored `rr` is quoted off T2 by the engines that emit one.
             * When the read layer blanks T2 — because it collapsed into T1 and
             * is not a separate exit — the card kept printing that number
             * beside a target it was no longer showing. FSL: "R:R 1.89" above
             * a first target worth 1.60R, and a scale-out rung underneath
             * correctly saying 1.6R. Two numbers for one thing, and the bigger
             * one pointing at a level that is not there.
             *
             * Measured on the live ledger: 13 of 31 rows since launch have no
             * T2, so this was most of the page.
             *
             * The stored value is left in the ledger untouched — it is what the
             * engine published — and the DISPLAY quotes the furthest target it
             * is actually showing, naming which one. */
            const e = lvl(r.entry), sx = lvl(r.sl);
            const far = lvl(r.target3) || lvl(r.target2) || lvl(r.target1);
            const which = lvl(r.target3) ? 'T3' : lvl(r.target2) ? 'T2' : 'T1';
            const shown = (e && sx && far && e !== sx)
              ? Math.abs(far - e) / Math.abs(e - sx) : null;
            return `<div><span class="kk">R:R <i class="kk-q">to ${which}</i></span>
              <span class="vv">${shown != null ? shown.toFixed(2) : esc(r.rr ?? '—')}</span></div>`;
          })()}
        </div>
        ${open && live && isFinite(Number(r.sl)) && isFinite(Number(r.target1))
          ? progressToTarget(Number(r.entry), Number(r.sl), Number(r.target1), live.price, r.action) : ''}
        ${open ? trailPlan(r.entry, r.sl, r.target1, r.target2, r.target3, r.action) : ''}
        <div class="card-foot">
          <span class="mono" style="font-size:var(--t-2);color:var(--dim)">${esc(String(r.alert_date || r.date || '').slice(0, 10))}
            ${r.status ? ' · ' + esc(String(r.status).replace(/_/g, ' ').toLowerCase()) : ''}</span>
          ${open ? `<a class="brief-link" href="/brief" data-brief="${esc(r.symbol)}">Full brief →</a>` : ''}
          ${symLinks(r.symbol, r.tv)}
        </div>
        ${r.remarks ? `<div class="card-body">${esc(engineWords(String(r.remarks).slice(0, 180)))}</div>` : ''}
      </article>`;
    };

    const draw = () => {
      const rows = all.filter(r => {
        const b = (r.badge || '').toLowerCase();
        return sigFilter === 'all' ? true : b === sigFilter;
      }).slice(0, 30);
      if (!all.length) {
        main.innerHTML = base + `<div class="note">
          <b>No signals yet — the record starts today.</b> This page counts only what the
          engine sends from <b>${esc(LAUNCH)}</b> onward, so its win rate is earned here
          rather than inherited. The scanner publishes at 10:30 and 18:30 IST on weekdays
          (13:00 and 21:00 MYT);
          the first entries will appear after those runs.
          <br><br>The full history of ${every.length} earlier signals is unchanged and still
          in the ledger — it is simply older than this page's counting window.
        </div>` + (ENG_TABLE ? floorHtml(ENG_TABLE, all) : '');
        return;
      }
      main.innerHTML = base +
        /* A missing curve is EXPLAINED, not omitted. It needs graded R
         * multiples, and the build-time snapshot this page falls back to when
         * the live ledger is unreachable does not carry them — so on that path
         * the section would simply vanish, which reads as a page that forgot
         * to include it rather than data that is not there. */
        (CURVE ? sec('Cumulative R', rCurveHtml(CURVE), `${CURVE.used} closed`,
          'Every closed signal, in the order it closed.')
         : sec('Cumulative R', `<div class="empty" style="text-align:left;padding:22px 20px">
            <b style="color:var(--text)">The record starts here.</b><br>
            ${/* THE EMPTY STATE HAS TO KNOW WHICH EMPTY IT IS.
                * This said "no signal has closed yet" whether that was true or
                * not. rCurve returns null below five closed trades — three
                * points joined by two lines is not a curve, it is noise with a
                * trend line through it — so on a page whose tiles read "3
                * closed" the copy underneath flatly contradicted them. */''}
            ${!a.live
              ? `The live ledger did not answer, and the morning snapshot does not record graded
                 R multiples, so the curve cannot be drawn from it.`
              : closed.length === 0
                ? `No signal published since ${esc(LAUNCH)} has closed yet, so there is no curve to
                   draw. It appears the moment one does, and every closed trade after that adds a
                   point — up or down.`
                : `<b style="color:var(--text)">${closed.length}</b> of the
                   ${all.length} signals published since ${esc(LAUNCH)} ${closed.length === 1 ? 'has' : 'have'}
                   closed. A curve needs <b style="color:var(--text)">five</b> before its shape means
                   anything — three points joined by two lines is noise with a trend drawn through
                   it. The tiles below carry the record as it stands, and the line appears at five.`}

          </div>`, '', 'Every closed signal, in the order it closed.')) +
        (ENG_TABLE ? floorHtml(ENG_TABLE, all) : '') +
        sec('The record', `<div class="grid">
          ${tile(all.length, 'Signals published', 'since ' + esc(LAUNCH), 'ac')}
          ${tile(opens.length, 'Still open', 'marked to live prices')}
          ${tile(closed.length ? Math.round(wins / (wins + losses) * 100) + '%' : '—', 'Win rate',
                 `${wins}W / ${losses}L closed`, (wins + losses) && wins / (wins + losses) >= .5 ? 'up' : 'dn')}
          ${tile(closed.length, 'Closed and scored', 'expiries counted as losses')}
        </div>`) +
        /* NO PRE-LAUNCH RECORD ON THIS PAGE. A second block used to sit here
         * carrying 80 trades closed before LAUNCH. Removed on instruction: the
         * site is a fresh start, and until a published signal closes this page
         * has no win rate and no expectancy. It says so above rather than
         * filling the space with history nobody could have acted on. */

        `<div class="chips" role="group" aria-label="Signal filter">${chips.map(([k, l]) =>
          `<button type="button" class="chip" data-s="${k}" aria-pressed="${sigFilter === k}">${esc(l)}</button>`).join('')}</div>` +
        sec('Alerts', rows.length
          ? `<div class="cards-2">${rows.map(card).join('')}</div>` + TRAIL_NOTE
          : `<div class="empty">No signals with that state.</div>`, `${rows.length} shown`);
      if (CURVE) wireRCurve(CURVE);
      // Same reason as the Screen's: name the chips this handler owns.
      main.querySelectorAll('.chip[data-s]').forEach(b => b.addEventListener('click', () => {
        sigFilter = b.dataset.s; draw();
      }));
    };
    draw();
  };

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
  const TRAIL_NOTE = `<p class="hint trail-note"><b>The trail and the scale-out are
    management rules, not part of the grade.</b> Every signal above is still scored on
    the single stop it was sent with — a break-even trail measured <b>worse</b> than the
    fixed stop over 470 closed trades, so publishing it as the graded rule would flatter
    the record.</p>`;

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
    return `<div class="trail"><span>Trailing rule</span>
      ${steps.map(([t, k]) => `<div class="tr-s"><b>${esc(t)}</b><i>${esc(k)}</i></div>`).join('')}
      <div class="tr-sc">
        <span class="tr-sch">Scale-out</span>
        ${rungs.map(([pcStr, lv, lab]) => `<div class="tr-r">
          <b>${esc(pcStr)}</b><span>at ${f(lv)}</span><i>${esc(lab)} · ${rOf(lv).toFixed(1)}R</i>
        </div>`).join('')}
        ${rungs.length < 2 ? '' : `<div class="tr-n">Sold this way the whole position returns
          <b>${banked.toFixed(2)}R</b> if every target prints, against
          <b>${rOf(rungs[rungs.length - 1][1]).toFixed(2)}R</b> for holding all of it to the
          last one. Taking money off the table costs that difference; it buys the certainty
          of having taken it.</div>`}
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
        <h1>Get it before the open.</h1>
        <p class="join-sub">One email each morning: what moved, the sector heat, the books
          open today and the names the engine put up — with the levels it put them up at.</p>
        <ul class="join-ul">
          <li><b>Free.</b> No card, no trial that expires into a charge.</li>
            <li><b>The record is public.</b> Every signal is scored when it closes — losers
            included, which is the point of publishing it.</li>
          <li><b>One email a day.</b> Unsubscribe in one click, and the list is a table
            we own rather than a mailing vendor's.</li>
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
          <button type="submit" class="btn-primary" id="joinB">Get the morning brief</button>
          <p class="join-note" id="joinM">We send one email a day. Nothing else, ever.</p>
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
          f.innerHTML = `<div class="join-ok"><b>You are on the list.</b>
            The next brief goes out before tomorrow's open. If it does not arrive,
            check the spam folder once and mark it "not spam" — that is the only
            thing that keeps it landing.</div>`;
        } else {
          msg.className = 'join-note bad';
          msg.textContent = j.error || 'That did not go through. Try again in a moment.';
          btn.disabled = false; btn.textContent = 'Get the morning brief';
        }
      } catch (e) {
        msg.className = 'join-note bad';
        msg.textContent = 'No connection. Your address was not sent — try again.';
        btn.disabled = false; btn.textContent = 'Get the morning brief';
      }
    });
  };

  /* ══════════════════════════════════════════════════════════════════════
   * THE TRADING SIGNAL BRIEF
   *
   * A research document you can interrogate, not a page you read. Everything
   * on it is derived from three real sources — the published ledger, the
   * 750-name screen, and six months of actual daily closes — and anything
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
  const BRIEF_KEEP = ['b-chart', 'b-plan'];
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
        <i>${rest.length} sections — scoring, confluence, fundamentals, regime,
        scenarios, what it costs if it is wrong, and the record</i></summary>`;
      rest[0].parentNode.insertBefore(d, rest[0]);
      rest.forEach(el => d.appendChild(el));
      /* The reveal animation is driven by an observer that has already run on
       * these nodes; moving them leaves the class behind, so it is reapplied
       * rather than left to a second observer pass that will not come. */
      rest.forEach(el => el.classList.add('in'));
    } catch (e) { /* a fold that throws must not cost the brief */ }
  }

  R['/brief'] = async () => {
    /* SKELETON, shaped like the thing that replaces it — an instrument header,
     * a metric rail, a chart. Grey boxes of the wrong shape are why a loading
     * state feels like a broken page. */
    paint(`<div class="brief"><div class="b-wrap">
      <div class="b-hero"><div class="b-eyebrow">Trading signal brief</div>
        <div class="b-sk" style="height:54px;max-width:16ch;margin-top:20px"></div>
        <div class="b-sk" style="height:20px;max-width:46ch;margin-top:18px;border:0"></div></div>
      <div class="b-sk" style="height:88px;margin-top:26px"></div>
      <div class="b-sk" style="height:300px;margin-top:26px"></div></div></div>`);

    const [a, sc, st] = await Promise.all(
      [ledger(), get('/screen.json').then(noteLadder), get('/api/stats')]);
    if (!a.ok) { paint(fail('The signal brief', a.error)); return; }
    const rows = a.rows;
    /* SINCE LAUNCH, LIKE EVERY OTHER SURFACE ON THIS SITE.
     *
     * This filtered ledger()'s rows by status and by having levels, and not by
     * date — so the brief drew from every open row the book has ever carried,
     * back to 2026-06-13, and announced "the highest-scoring of the 148 signals
     * open right now". The front page, the ledger page and the floor all say
     * 35, because they all apply sinceLaunch. A reader moving between them saw
     * the same book claim two populations four times apart.
     *
     * It is the second time this exact fault has been fixed here. The note on
     * the front page's LR block says it: consistency between two pages cannot
     * come from writing the same filter carefully in both places, it has to
     * come from calling the same thing. This now calls the same helper. */
    const open = rows.filter(sinceLaunch)
                     .filter(r => (r.badge || '').toLowerCase() === 'open'
                               && r.entry && r.sl && r.target1);
    if (!open.length) { paint(`<div class="brief"><div class="b-wrap"><div class="b-hero">
      <div class="b-eyebrow">Trading signal brief</div>
      <h1>No setup is live right now.</h1>
      <p class="b-sub">The engine publishes when a setup clears its floors, and not otherwise.
        An empty brief is a result, not a fault.</p>
      <p style="margin-top:22px"><span class="dstate nodata"><i></i>No data</span></p>
      </div></div></div>`); return; }

    const UNIV = sc.ok ? (sc.data.rows || []).filter(x => x && typeof x === 'object') : [];
    // One sorted column per metric, built once.
    const column = fn => {
      const v = UNIV.map(fn).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
      return v.length >= 50 ? v : null;      // too thin to rank against
    };
    const COL = {
      r1m: column(x => Number(x.r1m)),
      vol: column(x => Number(x.vol_spike)),
      trend: column(x => (Number(x.price) && Number(x.sma200))
        ? (x.price - x.sma200) / x.sma200 * 100 : NaN),
      tags: column(x => ((x.setup && x.setup.tags) || []).length),
    };
    /* Share of the universe at or below v, as a percentage. Binary search so
     * this is cheap enough to run per component without a memo. */
    const pctl = (v, col) => {
      if (!Number.isFinite(v) || !col) return null;
      let lo = 0, hi = col.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (col[m] <= v) lo = m + 1; else hi = m; }
      return Math.max(0, Math.min(100, (lo / col.length) * 100));
    };
    // Percentile where the universe allows it; the old band where it does not,
    // so a missing screen degrades to the previous behaviour rather than to
    // nothing.
    const rank = (v, col, lo, hi) => {
      const p = pctl(v, col);
      return p == null ? clamp(v, lo, hi) : p;
    };
    const RANKED = !!(COL.r1m && COL.vol && COL.trend);

    if (sc.ok) SCREEN = SCREEN || (sc.data.rows || []).filter(x => x && x.sym);
    const inScreen = sym => (SCREEN || []).some(x => x.sym === sym);
    /* ── WHAT THE BRIEF PICKS, AND WHY IT USED TO PICK BADLY ──────────────
     *
     * This ranked by `rr` — the ledger's reward-to-risk field. That is the
     * ratio between two numbers the ENGINE chose, the stop and the target,
     * and it is the single property already excluded from the conviction
     * score for exactly that reason: a setup can widen its own target and
     * improve its own ranking without anything happening in the market.
     *
     * So the page led every day with whichever open signal had the most
     * generous target geometry, then scored that setup on the evidence and
     * reported a low number. The two halves of the page were answering
     * different questions, and the reader was left asking why a 37 was being
     * put in front of them. It was not being recommended; it was being
     * selected on the wrong axis.
     *
     * It now ranks on the same measured components the score is the mean of,
     * so the setup shown IS the best-scoring open signal. rr breaks ties. */
    const scoreOf = sym => {
      const row = (SCREEN || []).find(x => x.sym === sym);
      if (!row) return null;
      const parts = [
        COL.tags ? pctl(((row.setup && row.setup.tags) || []).length, COL.tags) : null,
        rank(Number(row.r1m), COL.r1m, -6, 26),
        (row.sma200 && row.price)
          ? rank((row.price - row.sma200) / row.sma200 * 100, COL.trend, -8, 32) : null,
        rank(Number(row.vol_spike), COL.vol, .7, 4),
      ].filter(v => Number.isFinite(v));
      return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    };
    const ranked = open.slice().sort((x, y) => {
      const sx = scoreOf(x.symbol), sy = scoreOf(y.symbol);
      if (sx == null && sy == null) return (y.rr || 0) - (x.rr || 0);
      if (sx == null) return 1;
      if (sy == null) return -1;
      return (sy - sx) || ((y.rr || 0) - (x.rr || 0));
    });
    const want = briefSym || briefPick;
    const askedFor = briefSym;          // set only when the reader just clicked
    briefSym = null;
    const hit = want ? open.find(r => r.symbol === want) : null;
    const sig = hit || ranked.find(r => inScreen(r.symbol)) || ranked[0];
    briefPick = sig.symbol;
    /* A requested symbol that cannot be shown is SAID, not substituted. The
     * brief needs an open row carrying an entry, a stop and a first target;
     * a name whose signal has closed, or which never published all three, has
     * no brief to show. Quietly rendering a different company instead is the
     * failure that looks most like working. */
    const missed = askedFor && !hit ? askedFor : null;
    const row = (SCREEN || []).find(x => x.sym === sig.symbol) || {};

    /* The live quote and six months of closes, fetched together. Sequential
     * awaits would put two round trips on the critical path for no reason. */
    const [q, ser] = await Promise.all([
      quotes([sig.symbol]),
      get('/api/signals?series=' + encodeURIComponent(sig.symbol) + '&range=' + briefRange),
    ]);
    const live = q[sig.symbol];
    const pts = ser.ok && Array.isArray(ser.data.points) ? ser.data.points : null;
    const closes = pts ? pts.map(p => p.c) : null;

    const cur = sig.currency || '₹';
    const N = v => Number(v);
    const entry = N(sig.entry), stop = N(sig.sl), t1 = N(sig.target1), t2 = N(sig.target2 || sig.target1);
    const last = live ? live.price : (N(row.price) || (closes ? closes[closes.length - 1] : entry));
    const isShort = /SELL|SHORT/i.test(sig.action || '');
    const risk = Math.abs(entry - stop);
    /* TWO REWARD-TO-RISK NUMBERS, BECAUSE THERE ARE TWO TARGETS.
     *
     * The ledger publishes one `rr` field and it is measured to TARGET 2. The
     * calculator on this page measures to target 1, because that is the level
     * the trade plan acts on. Printing the ledger's 4.4 in the header while the
     * calculator said 2.5 put two different answers to the same question on one
     * page with nothing to tell them apart.
     *
     * Both are now derived from the published levels — the auditable route —
     * and each says which target it belongs to. The ledger's own field is kept
     * only as a cross-check: if it disagrees with the arithmetic on its own
     * levels, the page says so rather than choosing a winner silently. */
    const rrT1 = Math.abs(t1 - entry) / (risk || 1);
    const rrT2 = Math.abs(t2 - entry) / (risk || 1);
    const rr = rrT1;
    const rrLedger = Number(sig.rr);
    // 0.15 is wider than rounding (the ledger stores one decimal) and narrower
    // than the gap between a T1 and a T2 reading on any real setup.
    const rrDisagrees = Number.isFinite(rrLedger)
      && Math.abs(rrLedger - rrT1) > 0.15 && Math.abs(rrLedger - rrT2) > 0.15;
    const f = v => price(v, cur);
    const dist = v => Number.isFinite(v) && Number.isFinite(last) && last
      ? `${v >= last ? '+' : '−'}${f(Math.abs(v - last)).replace(cur, cur)} · ${pct((v - last) / last * 100)}` : '—';

    /* ── DATA STATE. Six of them, and the page never wears the wrong one. */
    const sigDate = new Date((sig.alert_date || sig.date || '') + 'T00:00:00');
    const ageDays = Number.isFinite(sigDate.getTime())
      ? Math.round((Date.now() - sigDate.getTime()) / 86400000) : null;
    const state = !live ? (row.price ? 'delayed' : 'nodata')
      : ageDays != null && ageDays > 21 ? 'stale' : 'live';
    const stateChip = {
      live: ['live', 'Live', 'The price beside the entry is a live quote taken on this page load.'],
      delayed: ['delayed', 'Last close', 'The live quote did not answer. The price shown is the last close from the screen build.'],
      stale: ['stale', 'Ageing signal', `This setup was published ${ageDays} days ago and is still open. The levels stand; the thesis has had time to change.`],
      nodata: ['nodata', 'No price', 'Neither the live quote nor the screen carries a price for this name right now.'],
    }[state];

    /* ── SCORE. Five components, each a rule over the screen's own fields.
     * A score with no visible derivation is a number asking to be believed. */
    /* ── SCORED AGAINST THE MARKET, NOT AGAINST A CONSTANT ────────────────
     *
     * These components used hand-picked bands: momentum ran -6% to +26%,
     * trend -8% to +32%, volume 0.7x to 4x. Measured against the 750 names
     * the screen actually holds, one of those was not merely off, it was
     * inert:
     *
     *   vol_spike across the universe — median 0.37, p75 0.59, p90 0.94.
     *
     * The Volume band STARTED at 0.7, which is about the 80th percentile. So
     * four names in five scored a flat zero on Volume no matter what they did,
     * and a top-decile name scored six. One of four measured components was
     * dead, and it dragged every score on the site down by roughly a quarter.
     * That is the whole reason the brief kept reading 7 of 100.
     *
     * A band is a guess about the distribution. The distribution is right
     * here, in the screen this page already loads, so the components are now
     * PERCENTILES against it: 50 means the median screened name, 90 means top
     * decile. That is a number a reader can act on, it cannot silently
     * de-calibrate as the market changes, and it makes the four components
     * directly comparable — which the old bands never were.
     *
     * clamp() is kept for the one component that is not a market measurement,
     * and for the fallback when the screen has not loaded. */
    const clamp = (v, lo, hi) => Number.isFinite(v)
      ? Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)) : null;


    const COMPS = [
      ['Structure', 'is-target', row.setup
        ? (COL.tags
            ? Math.min(100, (pctl((row.setup.tags || []).length, COL.tags) ?? 0) + (row.brk52w ? 12 : 0))
            : Math.min(100, ((row.setup.tags || []).length) * 26 + (row.brk52w ? 22 : 0)))
        : null,
        row.brk52w ? 'Price is at a 52-week high, and the screen tags this as a completed breakout.'
                   : `The screen tags ${(row.setup && (row.setup.tags || []).length) || 0} structural conditions on this name. A 52-week breakout is not one of them.`],
      ['Momentum', 'is-now', rank(N(row.r1m), COL.r1m, -6, 26),
        Number.isFinite(N(row.r1m)) ? `One month return is ${pct(N(row.r1m))}, three month ${pct(N(row.r3m))}, RSI ${row.rsi != null ? Math.round(row.rsi) : '—'}.${
          COL.r1m ? ` That one-month figure sits at the ${Math.round(pctl(N(row.r1m), COL.r1m))}th percentile of the screen.` : ''}`
                                    : 'No return history on the screen for this name, so momentum is unscored rather than assumed.'],
      ['Trend', 'is-key', row.sma200 && row.price
        ? rank((row.price - row.sma200) / row.sma200 * 100, COL.trend, -8, 32) : null,
        row.sma200 && row.price ? `Price sits ${pct((row.price - row.sma200) / row.sma200 * 100)} against its 200-day average, with the 50-day ${row.sma50 > row.sma200 ? 'above' : 'below'} it.${
          COL.trend ? ` Against the screen that is the ${Math.round(pctl((row.price - row.sma200) / row.sma200 * 100, COL.trend))}th percentile.` : ''}`
                                : 'No 200-day average on the screen for this name.'],
      ['Volume', '', rank(N(row.vol_spike), COL.vol, .7, 4),
        Number.isFinite(N(row.vol_spike)) ? `Volume is running at ${N(row.vol_spike).toFixed(2)}× its own recent average.${
          COL.vol ? ` The median name on the screen runs ${COL.vol[Math.floor(COL.vol.length / 2)].toFixed(2)}×, so this is the ${Math.round(pctl(N(row.vol_spike), COL.vol))}th percentile — which is what the score reads, not a fixed threshold.` : ' Above 1.0 means participation is confirming the move.'}`
                                          : 'No volume ratio published for this name.'],
      /* NOT COUNTED IN THE SCORE. Flagged false, and the reason matters.
       *
       * The other four components are measurements of the market: where price
       * sits against its 200-day, what it did over a month, whether volume
       * confirmed it, how many structural conditions the screen tags. Reward
       * to risk is not a measurement of anything. It is the ratio between two
       * numbers this engine CHOSE — the stop and the target — and it can be
       * set to whatever the engine likes by moving either one.
       *
       * Averaging it with the other four let a setup score itself up. On the
       * signal this page was showing, the measured components read 26, 4, 0
       * and 0 — a name below its 200-day, on below-average volume, down over a
       * month — and the published conviction was 26 only because reward-to-
       * risk contributed a full 100. The evidence alone gives 7.5.
       *
       * A conviction score is an answer to "what does the evidence say". The
       * trade plan's geometry is a separate question, shown separately below
       * and in the trade plan, where it is genuinely useful. */
      ['Risk / reward', 'is-stop', clamp(rr, 1, 5),
        `The first target is ${rr.toFixed(1)} times as far from entry as the stop is. Anything under 1.5 is a setup that has to win more often than it loses to break even. This is a property of the plan, not of the market, so it is shown here but not counted in the score.`,
        false],
    ];
    /* MEASURED ONLY. See the note on the last component. */
    const MEASURED = COMPS.filter(c => c[4] !== false);
    const have = MEASURED.map(c => c[2]).filter(v => Number.isFinite(v));
    const score = have.length ? Math.round(have.reduce((x, y) => x + y, 0) / have.length) : null;
    /* ONE SET OF BANDS.
     *
     * The score used 70 / 50 and the confluence stance used 60 / 40 — two band
     * systems on one page, applied to the same component numbers, so a
     * component scoring 55 was "moderate" in one table and "neutral" in the
     * other and the page never said they were different scales. They are the
     * same scale now: 60 and above is strong, 40 to 60 is mixed, below 40 is
     * weak, for the overall score and for every component stance. */
    const BANDS = [[60, 'HIGH CONVICTION', 'up'], [40, 'MIXED', ''], [0, 'LOW CONVICTION', 'dn']];
    const bandOf = v => BANDS.find(b => v >= b[0]) || BANDS[BANDS.length - 1];
    const conviction = score == null ? 'UNSCORED' : bandOf(score)[1];
    // Where this setup sits among everything open, for the standfirst below.
    const openRank = ranked.findIndex(r => r.symbol === sig.symbol) + 1;

    /* ── THE LADDER. Every level on one scale, so distance is real. */
    const pts_ = [
      { k: 'Target 2', v: t2, c: 'is-target', step: 7 }, { k: 'Target 1', v: t1, c: 'is-target', step: 7 },
      { k: '52-week high', v: N(row.high52), c: 'is-key', step: 2 },
      { k: 'Now', v: last, c: 'is-now', step: 1 }, { k: 'Entry', v: entry, c: '', step: 5 },
      { k: '200-day', v: N(row.sma200), c: 'is-key', step: 3 },
      { k: 'Stop', v: stop, c: 'is-stop', step: 6 },
    ].filter(x => Number.isFinite(x.v)).sort((x, y) => y.v - x.v);
    const hiL = Math.max.apply(null, pts_.map(p => p.v)), loL = Math.min.apply(null, pts_.map(p => p.v));
    const at = v => ((hiL - v) / ((hiL - loL) || 1)) * 100;

    /* Label de-collision happens AFTER paint, in spaceLadder(), because it
     * needs the ladder's real pixel height. The first attempt did it here in
     * percent and applied it with translateY(<percent>) — which resolves
     * against the ELEMENT'S OWN height, not the container, so a -3.3% nudge on
     * a 12px label moved it a third of a pixel and the labels still sat on top
     * of each other. Percentages and transforms do not mean what they look
     * like they mean. */
    const ladder = pts_.map((p, i) => `<div class="b-lvl ${p.c}" tabindex="0" data-lvl="${esc(p.k)}"
        style="top:${at(p.v).toFixed(2)}%">
        <span class="b-lvl-tag">${esc(p.k)}</span><span class="b-lvl-line"></span>
        <span class="b-lvl-d">${p.k === 'Now' ? 'current' : dist(p.v)}</span>
        <span class="b-lvl-val">${f(p.v)}</span></div>`).join('');

    /* ── THE CHART, from real closes. */
    const chartLevels = [
      { k: 'T2', v: t2, f: f(t2), c: 't', step: 7 }, { k: 'T1', v: t1, f: f(t1), c: 't', step: 7 },
      { k: 'ENTRY', v: entry, f: f(entry), c: 'e', step: 5 },
      { k: 'STOP', v: stop, f: f(stop), c: 's', step: 6 },
      { k: '200D', v: N(row.sma200), f: f(N(row.sma200)), c: 'k', step: 3 },
    ].filter(l => Number.isFinite(l.v));
    const CH = pts ? priceChart(pts, chartLevels, { entry, stop, t1, t2 }) : null;

    /* ── ENTRY STATE. Published levels only — no invented zone width. */
    const zoneState = (() => {
      if (!Number.isFinite(last)) return ['wait', 'Unpriced', 'No live price, so the setup cannot be placed against its own levels right now.'];
      const beyondStop = isShort ? last >= stop : last <= stop;
      if (beyondStop) return ['invalid', 'Invalidated', `Price is beyond the published stop at ${f(stop)}. The structure that produced this setup is gone.`];
      const better = isShort ? last >= entry : last <= entry;
      if (better) return ['active', 'At or better', `Price is at or better than the published entry of ${f(entry)}. The trade plan's condition is met.`];
      const wayThrough = Math.abs(last - entry) > Math.abs(t1 - entry) * 0.5;
      if (wayThrough) return ['missed', 'Extended', `Price has already travelled ${pct(Math.abs(last - entry) / entry * 100)} past the entry, more than half the distance to the first target. Entering here buys a worse price against the same stop.`];
      return ['wait', 'Waiting', `Price is past the entry but not far. The plan calls for entry at or better than ${f(entry)}, so this is a wait rather than a chase.`];
    })();
    const zLo = Math.min(stop, entry, t1, last), zHi = Math.max(stop, entry, t1, last);
    const zAt = v => ((v - zLo) / ((zHi - zLo) || 1)) * 100;

    /* ── REGIME, from the real series. */
    const reg = regimeOf(closes);

    /* ── CONFLUENCE. The same five components, expressed as a stance. */
    const stance = v => !Number.isFinite(v) ? null : v >= 60 ? 0 : v >= 40 ? 1 : 2;
    /* The fifth row carries its exclusion with it. The matrix reads as the
     * evidence for the score directly above it, so a row that is not in the
     * score has to say so here too — otherwise the page shows five factors
     * and a number derived from four, and only one of them admits it. */
    /* A NON-DIRECTIONAL QUANTITY CANNOT TAKE A DIRECTIONAL STANCE.
     *
     * Reward-to-risk was passed through stance(), which buckets a number into
     * bullish / neutral / bearish. A tight target scored 0 and therefore
     * landed under BEARISH — so a reader saw four green dots and one red one
     * and reasonably read it as a factor arguing against the trade. It is not.
     * Bullish and bearish are claims about DIRECTION; the distance between a
     * stop and a target has no view on which way price goes.
     *
     * The row keeps its place, because the geometry matters, and states its
     * actual ratio instead of a colour it cannot earn. */
    const MATRIX = COMPS.map(c => [c[0], c[4] === false ? null : stance(c[2]), c[3], c[4] !== false]);

    /* ── BASE RATE, not a probability. */
    const S = st.ok ? st.data : null;
    /* THE BRIEF'S RECORD IS THIS SITE'S RECORD, NOT THE ENGINE'S WHOLE LIFE.
     *
     * This read /api/stats, which is all-time and cannot be filtered — so the
     * brief published "48 closed since 2026-08-03, 16.7%, −0.414R" on a site
     * whose every other performance figure counts from LAUNCH. Same defect as
     * the curve, in a second place. Computed from the ledger rows this page
     * already has, so it can be scoped.
     *
     * The all-time figures are not discarded; they are shown beneath, labelled
     * as the engine before this site, with their own dates. */
    const HERE = recordOf(rows.filter(sinceLaunch));
    const H = HERE.trades ? HERE : null;
    /* No pre-launch record is cited anywhere on this page. Those trades were
     * graded in a rebuild rather than watched live, and this site is a fresh
     * start — borrowing a number from before it existed to fill a gap is the
     * comparison that number cannot support. */
    const S_ALL = S && S.headline ? S.headline : null;
    /* EVERY FIELD OFF /api/stats IS OPTIONAL.
     * The tiles interpolated H.wins and H.losses straight into the markup, so
     * a headline missing either printed the literal word "undefined" on a page
     * about money. num() renders a missing figure as an em dash, which is the
     * same thing the rest of this site does with anything it cannot measure. */
    const hNum = (v, suffix) => Number.isFinite(Number(v)) ? Number(v) + (suffix || '') : '—';
    const closedRows = rows.filter(r => r.pnl_pct != null && (r.badge || '') !== 'open'
                                     && sinceLaunch(r)).slice(0, 8);

    const thesis = [
      ['Market structure', 'The trend is doing the heavy lifting.',
        row.sma200 && row.price
          ? `Price sits ${pct((row.price - row.sma200) / row.sma200 * 100)} against its 200-day average, with the 50-day ${row.sma50 > row.sma200 ? 'above' : 'below'} it. ${row.sma50 > row.sma200 ? 'The longer structure is intact, so the setup is with the trend rather than against it.' : 'The longer structure has not confirmed, which is why this is sized as a smaller idea.'}`
          : 'Trend data is not available for this name, so the structure leg of the thesis is unscored rather than assumed.',
        [['vs 200-day', row.sma200 ? pct((row.price - row.sma200) / row.sma200 * 100) : '—'],
         ['50 vs 200', row.sma50 && row.sma200 ? (row.sma50 > row.sma200 ? 'above' : 'below') : '—'],
         ['Sector', row.sector ? esc(row.sector) : '—']]],
      ['Momentum', 'Momentum confirms the move.',
        `One-month return is ${pct(N(row.r1m))} and RSI reads ${row.rsi != null ? Math.round(row.rsi) : '—'} on the daily. ${N(row.rsi) > 70 ? 'That is extended, which argues for the entry zone rather than chasing the print.' : 'That leaves room before the move is stretched.'}`,
        [['1 month', pct(N(row.r1m))], ['3 month', pct(N(row.r3m))],
         ['RSI 14D', row.rsi != null ? Math.round(row.rsi) : '—']]],
      ['Levels', 'Price is approaching a level that matters.',
        `Entry sits at ${f(entry)} with the invalidation ${f(stop)} — ${pct(-Math.abs(risk / entry * 100))} away. The first target at ${f(t1)} is ${pct(Math.abs(t1 - entry) / entry * 100)} from entry.`,
        [['Entry', f(entry)], ['Stop', f(stop)], ['Target 1', f(t1)]]],
      ['Risk', 'The setup is attractive because the risk is defined.',
        `Reward to risk is ${rrT1.toFixed(1)} to one against the first target and ${rrT2.toFixed(1)} to one against the second. The stop is a price, not an intention: below ${f(stop)} the reason for the trade is gone and the position is closed.`,
        [['R:R to T1', rrT1.toFixed(1) + ' : 1'], ['R:R to T2', rrT2.toFixed(1) + ' : 1'], ['Risk per share', f(risk)],
         ['Daily ATR', Number.isFinite(N(row.atr_pct)) ? N(row.atr_pct).toFixed(2) + '%' : '—']]],
    ];

    const SECTIONS = [
      ['b-overview', 'Overview', '1', 'Signal', 'the setup exists'],
      ['b-chart', 'Chart', '2', 'Entry', 'where it starts'],
      ['b-thesis', 'Thesis', '3', 'Confirmation', 'why it should work'],
      ['b-plan', 'Trade plan', '4', 'Target', 'what it is worth'],
      ['b-risk', 'Risk', '5', 'Sizing', 'what it costs'],
      ['b-history', 'History', '6', 'Exit', 'what happened before'],
    ];

    paint(`<div class="brief"><div class="b-wrap">

      ${/* HOW THIS ONE GOT HERE. The page is a selection, not a
          * recommendation, and until it said so a reader had no way to know
          * whether the setup in front of them was the best available or
          * simply the first. */''}
      <header class="b-hero" id="b-overview">
        <div class="b-eyebrow">Trading signal brief</div>
        <h1>${esc(sig.symbol)} is ${last > entry ? 'holding above' : 'testing'} its entry zone.</h1>
        <p class="b-sub">${askedFor
          ? `You asked for this one.`
          : `<b>Chosen, not recommended.</b> This is the highest-scoring of the
             <b>${ranked.length}</b> signals open since ${esc(LAUNCH)}, ranked on the measured components —
             what the market did, not on how far the engine placed its own target.`}
          A ${conviction.toLowerCase().replace(' conviction', '-conviction')} setup built from price
          structure, momentum, volume and defined risk. Every figure below comes from the published ledger,
          the same 750-name screen the rest of this site runs on, and ${pts ? `${pts.length} real daily closes` : 'the published levels'}.</p>
      </header>

      ${/* ── THE WHOLE TRADE, BEFORE THE ARGUMENT FOR IT ──────────────────────
          *
          * The brief runs to roughly 1,400 words across twelve sections and
          * the first hard number arrived several screens in. A reader who
          * only wants to know what the trade IS — direction, levels, what it
          * risks, what the engine behind it has actually done — had to read
          * the case for it first.
          *
          * This is that, in one line, immediately under the headline. It
          * adds no new figures: every one already appears below with its
          * working shown. What it changes is the order — the answer first,
          * then the argument, which is the order the rest of this site uses
          * and the one place it was not being used.
          *
          * The engine's own record is on the strip on purpose. It is the
          * single most relevant fact about a setup and it lived in section
          * eleven of twelve. */''}
      ${snap([
        ['Direction', isShort ? 'Short' : 'Long', esc(sig.timeframe || ''), isShort ? 'dn' : 'up'],
        ['Entry', price(entry, cur), last ? `now ${price(last, cur)}` : ''],
        ['Stop', price(stop, cur), `${(Math.abs(entry - stop) / entry * 100).toFixed(2)}% away`, 'dn'],
        ['Target 1', price(t1, cur), `${rrT1.toFixed(1)}× the risk`, 'up'],
        ['Engine', esc(ENGINE_LABEL[sig.signal_type] || sig.signal_type || '—'),
         H ? `${H.trades} closed · ${H.win_rate}% won` : 'nothing closed yet'],
        H ? ['Its expectancy', (H.expectancy_r > 0 ? '+' : '') + H.expectancy_r + 'R',
             'per closed trade', dir(H.expectancy_r)] : null,
      ], 'No engine on this site has cleared 30 closed trades at t&nbsp;≥&nbsp;2, so this is a '
       + 'setup to examine rather than a call to take.')}

      ${/* ── EVIDENCE, NOT "VERDICT" ───────────────────────────────────────────
          * This block was headed EVIDENCE ON THE ENGINE and it is not one. A verdict is
          * the call on the STOCK — Buy / Wait / Watch / Avoid — and the screen
          * already publishes exactly that on every row from verdict.py. What
          * this reports is how much the ENGINE has proved: closed trades
          * against the 30-trade, t>=2 bar. Two different things under one word
          * is the taxonomy collision this product cannot afford, and it made
          * the brief read as though "research only" were the call on CGCL when
          * it is a statement about BREACH's sample size.
          * ─────────────────────────────────────────────────────────────────── */''}
          * Twelve sections of evidence and the page never said what it added
          * up to. Every number was there and the reader had to do the
          * arithmetic that the site's own clearance rule already answers.
          *
          * It is derived, not written: the engine's closed record against the
          * 30-trade, t>=2 bar this site sets before an engine is trusted with
          * capital. There is no path through this that prints "take it" —
          * because on today's ledger no engine clears, and a verdict that
          * cannot say no is not a verdict. If one ever clears, this reports
          * that, by the same rule and with no edit. */''}
      ${(() => {
        const n = H ? H.trades : 0;
        const cleared = n >= 30 && H && H.expectancy_r > 0;
        const cls = cleared ? 'ok' : n >= 8 && H && H.expectancy_r < 0 ? 'no' : 'thin';
        const head = cleared ? 'This engine is cleared for capital'
          : (n >= 8 && H && H.expectancy_r < 0) ? 'This engine is losing money so far'
          : 'This engine has not proved itself yet';
        const body = cleared
          ? `${esc(ENGINE_LABEL[sig.signal_type] || sig.signal_type)} has ${n} closed trades at
             ${H.expectancy_r > 0 ? '+' : ''}${H.expectancy_r}R. It clears the bar this site sets.`
          : (n >= 8 && H && H.expectancy_r < 0)
          ? `${esc(ENGINE_LABEL[sig.signal_type] || sig.signal_type)} has closed <b>${n}</b> trades
             since ${esc(LAUNCH)} at <b>${H.expectancy_r}R</b> each. The setup below may still be
             sound; the engine that found it has not paid so far.`
          : `${esc(ENGINE_LABEL[sig.signal_type] || sig.signal_type)} has closed
             <b>${n || 'no'}</b> trade${n === 1 ? '' : 's'} since ${esc(LAUNCH)} — ${30 - n} short of
             the 30 this site requires before an engine is trusted with capital. Nothing below
             changes that.`;
        return `<div class="b-verdict is-${cls}">
          <div class="b-vk">How much this engine has proved</div>
          <h2>${head}</h2><p>${body}</p>
          <p class="b-vs">The bar is 30 closed trades at a t-statistic of 2 or better.
            <a href="/signals">See the record</a>.</p>
        </div>`;
      })()}

      ${/* ── AT A GLANCE ──────────────────────────────────────────────────────
          * The whole trade as one picture, above twelve sections of prose.
          *
          * THE BAR IS DRAWN TO SCALE, WHICH IS THE POINT. Reward-to-risk
          * printed as "1.6x" is a number a reader has to trust; the same fact
          * drawn as a red block beside a green one three-fifths longer is a
          * fact they can see. A brief whose central claim is a ratio should
          * show the ratio.
          *
          * The outcomes are in PER CENT OF THE POSITION, not R. R is the
          * site's unit and the right one for a ledger, but "what happens to my
          * money if the stop hits" is the question a reader actually has, and
          * -2.7% answers it without them converting anything.
          *
          * The widths animate from zero on first paint. It is one transition
          * on a transform-free property over 700ms — enough to show the
          * proportion arriving, not enough to make anyone wait — and it is
          * skipped entirely under prefers-reduced-motion. */''}
      ${(() => {
        const dStop = Math.abs(entry - stop) / entry * 100;
        const d1 = Math.abs(t1 - entry) / entry * 100;
        const d2 = Math.abs(t2 - entry) / entry * 100;
        const span = dStop + d2 || 1;
        const seg = (v, cls, lab, sub) => `<div class="bg-seg ${cls}" style="--w:${(v / span * 100).toFixed(1)}%">
          <span class="bg-l">${esc(lab)}</span><span class="bg-v">${sub}</span></div>`;
        const band = score == null ? '' : `<div class="bg-score">
          <div class="bg-dial" style="--p:${Math.max(0, Math.min(100, score))}">
            <b>${score}</b><i>/100</i></div>
          <span class="bg-sl">${esc(conviction)}</span></div>`;
        return `<div class="b-glance">
          <div class="bg-h">At a glance</div>
          <div class="bg-bar" role="img"
               aria-label="Risk ${dStop.toFixed(1)}% against reward ${d1.toFixed(1)}% to the first target and ${d2.toFixed(1)}% to the second">
            ${seg(dStop, 'is-risk', 'Risk', '−' + dStop.toFixed(1) + '%')}
            ${seg(d1, 'is-r1', 'Target 1', '+' + d1.toFixed(1) + '%')}
            ${seg(d2 - d1, 'is-r2', 'Target 2', '+' + d2.toFixed(1) + '%')}
          </div>
          <div class="bg-row">
            <div class="bg-i"><span class="bg-k">If the stop hits</span>
              <span class="bg-n dn">−${dStop.toFixed(1)}%</span><span class="bg-s">−1.0R</span></div>
            <div class="bg-i"><span class="bg-k">If target 1 prints</span>
              <span class="bg-n up">+${d1.toFixed(1)}%</span><span class="bg-s">+${rrT1.toFixed(1)}R</span></div>
            <div class="bg-i"><span class="bg-k">If target 2 prints</span>
              <span class="bg-n up">+${d2.toFixed(1)}%</span><span class="bg-s">+${rrT2.toFixed(1)}R</span></div>
            ${band}
          </div>
        </div>`;
      })()}

      ${missed ? `<div class="b-miss"><b>${esc(missed)} has no brief to show.</b>
        A brief needs an open signal carrying an entry, a stop and a first target — that name
        has none right now, so this is the best open setup instead, not a substitute for it.</div>` : ''}

      <nav class="b-qnav" id="qnav" aria-label="Sections of this brief">
        ${SECTIONS.map(([id, lab, key]) => `<a href="#${id}" data-jump="${id}">
          <span class="kb" aria-hidden="true">${key}</span>${esc(lab)}</a>`).join('')}
      </nav>

      <section class="b-status">
        <div class="b-dir ${isShort ? 'is-short' : ''}">
          <span class="b-dir-mark"></span>
          <div><div class="b-dir-l">${isShort ? '▼ SHORT' : '▲ LONG'}</div>
            <div class="b-dir-meta">
              <span class="b-tag">${esc(sig.symbol)}</span>
              <span class="b-tag">${esc(sig.timeframe || '1D')}</span>
              <span class="b-tag"><span id="convN" data-cv="">${score == null ? '—' : '0'}</span> CONFIDENCE</span>
              <span class="dstate ${stateChip[0]}"><i></i>${esc(stateChip[1])}</span>
            </div></div>
        </div>
        <div class="b-metrics">
          <div class="b-m"><span class="k">Entry</span><span class="v">${f(entry)}</span></div>
          <div class="b-m"><span class="k">Current</span><span class="v ${last >= entry ? 'up' : 'dn'}" id="curPx">${f(last)}</span></div>
          <div class="b-m"><span class="k">Day</span><span class="v ${live && live.change_pct >= 0 ? 'up' : 'dn'}">${live && Number.isFinite(live.change_pct) ? pct(live.change_pct) : '—'}</span></div>
          <div class="b-m"><span class="k">Stop</span><span class="v dn">${f(stop)}</span></div>
          <div class="b-m"><span class="k">Target 1</span><span class="v up">${f(t1)}</span></div>
          <div class="b-m"><span class="k">Target 2</span><span class="v up">${f(t2)}</span></div>
          <div class="b-m"><span class="k">R:R to T1</span><span class="v gold">${rrT1.toFixed(1)} : 1</span></div>
          <div class="b-m"><span class="k">R:R to T2</span><span class="v gold">${rrT2.toFixed(1)} : 1</span></div>
          <div class="b-m"><span class="k">Signal age</span><span class="v">${ageDays == null ? '—' : ageDays + 'd'}</span></div>
          <div class="b-m"><span class="k">Sector</span><span class="v" style="font-family:var(--ui);font-size:var(--t-5)">${esc(row.sector || 'Not on screen')}</span></div>
        </div>
      </section>
      <p class="b-p" style="margin-top:14px;font-size:var(--t-4)">${esc(stateChip[2])}
        Reward to risk is shown against <b style="color:var(--b-ink)">both</b> targets, because they are
        different numbers and the trade plan acts on the first one. The ledger's own published field
        reads ${Number.isFinite(rrLedger) ? rrLedger.toFixed(1) : '—'}, which is the reading to target 2.
        ${rrDisagrees ? `<b style="color:var(--b-gold)">It agrees with neither figure computed from its own
          published levels, so the arithmetic above is what this page shows and the ledger field is the
          one to distrust.</b>` : ''}</p>

      <nav class="b-jr" id="journey" aria-label="Where you are in this brief">
        ${SECTIONS.map(([id, , , node, sub]) => `<div class="b-jn" data-node="${id}">
          <i aria-hidden="true"></i><b>${esc(node)}</b><span>${esc(sub)}</span></div>`).join('')}
      </nav>

      <section class="b-sec b-reveal">
        <div class="b-lab">The trade in one view</div>
        <h2 class="b-h2">Everything that defines the position.</h2>
        <dl class="b-view">
          <div class="b-vi"><dt>Setup</dt><dd class="txt">${esc((row.setup && (row.setup.tags || [])[0]) || sig.signal_type || 'Engine signal')}</dd></div>
          <div class="b-vi"><dt>Direction</dt><dd class="txt">${isShort ? 'Short' : 'Long'}</dd></div>
          <div class="b-vi"><dt>Entry</dt><dd>${f(entry)}</dd></div>
          <div class="b-vi"><dt>Stop</dt><dd>${f(stop)}</dd></div>
          <div class="b-vi"><dt>Target 1</dt><dd>${f(t1)}</dd></div>
          <div class="b-vi"><dt>Target 2</dt><dd>${f(t2)}</dd></div>
          <div class="b-vi"><dt>R:R to T1</dt><dd>${rrT1.toFixed(1)} : 1</dd></div>
          <div class="b-vi"><dt>Horizon</dt><dd class="txt">${esc(sig.timeframe === '1D' ? 'Swing' : (sig.timeframe || 'Swing'))}</dd></div>
        </dl>

        <div class="b-zone">
          <div class="b-zone-h">
            <span class="b-zst ${zoneState[0]}">${esc(zoneState[1])}</span>
            <span class="b-lab" style="letter-spacing:.16em">Entry state ${tip('zone')}</span>
          </div>
          <div class="b-zt">
            <span class="band" style="left:${Math.min(zAt(entry), zAt(t1)).toFixed(1)}%;width:${Math.abs(zAt(t1) - zAt(entry)).toFixed(1)}%"></span>
            <span class="stop" style="left:${zAt(stop).toFixed(1)}%"></span>
            <span class="tgt" style="left:${zAt(t1).toFixed(1)}%"></span>
            <span class="now" id="zNow" style="left:${zAt(last).toFixed(1)}%"></span>
          </div>
          <div class="b-zl"><span>Stop ${f(stop)}</span><span>Entry ${f(entry)}</span><span>Target 1 ${f(t1)}</span></div>
          <p class="b-p" style="font-size:var(--t-5)">${esc(zoneState[2])}</p>
        </div>
      </section>

      <section class="b-sec b-reveal" id="b-chart">
        <div class="b-lab">Price structure</div>
        <h2 class="b-h2">Where price has been, and where the thesis ends.</h2>
        ${CH ? `<div class="b-px">
          <div class="b-px-h"><span>${esc(sig.symbol)} · daily closes</span>
            <span class="rgs" role="group" aria-label="Chart window">
              ${['3mo', '6mo', '1y'].map(r => `<button type="button" data-range="${r}"
                aria-pressed="${r === briefRange}">${r.replace('mo', 'M').replace('1y', '1Y')}</button>`).join('')}
            </span></div>
          ${CH.html}
          <div class="b-px-f">
            <span class="p"><i></i>Close</span><span class="e"><i></i>Entry</span>
            <span class="s"><i></i>Stop</span><span class="t"><i></i>Targets</span>
            ${Number.isFinite(N(row.sma200)) ? '<span class="k"><i></i>200-day</span>' : ''}
          </div>
        </div>
        <p class="b-cap"><b>Closing prices, not candles.</b> The line is ${pts.length} real daily closes
          from ${esc(pts[0].t || '')} to ${esc(pts[pts.length - 1].t || '')}. No feed on this site serves
          open-high-low-close data, so there are no candles and no wicks — a chart that drew them would be
          inventing the intraday range on the one page whose job is to be trusted. The levels over it are
          the published ones, on the same scale, so the distance between the stop and the target is the
          actual distance.</p>`
        : `<div class="b-px"><div class="b-px-h"><span>${esc(sig.symbol)} · daily closes</span>
             <span class="rgs"><span class="dstate nodata"><i></i>No history</span></span></div>
           <div style="padding:26px 16px"><p class="b-p" style="margin:0">The price series for this
             instrument did not load${ser.error ? ` — ${esc(ser.error)}` : ''}. The level map below is
             drawn from the published levels alone, which is what this section showed before a series
             was available at all.</p></div></div>`}

        <div class="b-chart" style="margin-top:${pts ? '26px' : '18px'}">
          ${/* ── THE TRADE, AT THE TRADE'S OWN SCALE ─────────────────────────
              * The ladder below is drawn on one linear scale from the stop to
              * the 52-week high, which is correct and is also why it is hard
              * to read: everything a reader has to decide about — now, entry,
              * stop — sits inside about 4% of a range whose top half is empty
              * air. The 52-week high is context; it is not part of the trade.
              *
              * This strip is the same numbers over the span that actually
              * matters, stop to target 2, so the risk and the reward are drawn
              * in proportion to each other and the shape of the trade is the
              * first thing visible. The ladder keeps the full context
              * underneath it — this replaces nothing, it answers first. */''}
          ${(() => {
            const lo = Math.min(stop, t2), hi = Math.max(stop, t2);
            const span = (hi - lo) || 1;
            const at2 = v => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
            /* The label is a SIBLING of the pin, not a child. A pin is a 2px
             * coloured line and its label is a 40px word: nesting them makes
             * the word's containing box that 2px line, which is both wrong for
             * layout and unreadable to any contrast tool walking up from the
             * text to find what it sits on. */
            const pin = (v, cls, label) => Number.isFinite(v)
              ? `<i class="ts-p ${cls}" style="left:${at2(v).toFixed(2)}%"></i>
                 <u class="ts-u ${cls}" style="left:${at2(v).toFixed(2)}%">${esc(label)}</u>` : '';
            return `<div class="ts">
              <div class="ts-t">
                <span class="ts-r" style="left:${at2(Math.min(stop, entry)).toFixed(2)}%;width:${
                  Math.abs(at2(entry) - at2(stop)).toFixed(2)}%"></span>
                <span class="ts-w1" style="left:${at2(entry).toFixed(2)}%;width:${
                  Math.abs(at2(t1) - at2(entry)).toFixed(2)}%"></span>
                <span class="ts-w2" style="left:${at2(t1).toFixed(2)}%;width:${
                  Math.abs(at2(t2) - at2(t1)).toFixed(2)}%"></span>
                ${pin(stop, 'is-stop', 'Stop')}
                ${pin(entry, 'is-entry', 'Entry')}
                ${pin(last, 'is-now', 'Now')}
                ${pin(t1, 'is-t', 'T1')}
                ${pin(t2, 'is-t', 'T2')}
              </div>
              <div class="ts-n">
                <span><i>Risk per share</i><b>${f(risk)}</b></span>
                <span><i>To target 1</i><b>${f(Math.abs(t1 - entry))}</b><em>${rrT1.toFixed(1)}×</em></span>
                <span><i>To target 2</i><b>${f(Math.abs(t2 - entry))}</b><em>${rrT2.toFixed(1)}×</em></span>
                <span><i>Now vs entry</i><b class="${dir(last - entry)}">${pct((last - entry) / entry * 100)}</b></span>
              </div>
              <p class="ts-c">Drawn stop to target 2, so the red band and the green are in the same
                proportion as the money. The 52-week high is context and is on the ladder below,
                not here — it is not part of this trade.</p>
            </div>`;
          })()}
          <div class="b-ladder">
            <div class="b-band risk" style="top:${at(entry).toFixed(1)}%;height:${Math.abs(at(stop) - at(entry)).toFixed(1)}%"></div>
            <div class="b-band reward" style="top:${at(t2).toFixed(1)}%;height:${Math.abs(at(entry) - at(t2)).toFixed(1)}%"></div>
            ${ladder}
          </div>
          <p class="b-cap"><b>The ladder is every published level on one linear scale.</b> Hover or focus a
            level to read its distance from the current price, in currency and in per cent. Colour is never
            the only cue — each line is named.</p>
        </div>
      </section>

      <section class="b-sec b-reveal" id="b-thesis">
        <div class="b-lab">Why this trade</div>
        <h2 class="b-h2">Four things had to line up.</h2>
        <div class="b-steps">
          ${thesis.map(([lab, h, body, mini], i) => `<article class="b-step">
            <div class="b-step-n"><b>0${i + 1}</b> / ${esc(lab.toUpperCase())}</div>
            <div><h3>${esc(h)}</h3><p>${body}</p>
              <div class="b-mini">${(mini || []).map(([k, v]) =>
                `<div><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`).join('')}</div>
            </div></article>`).join('')}
        </div>
      </section>

      <section class="b-sec b-reveal">
        <div class="b-lab">Signal score ${tip('confidence')}</div>
        <h2 class="b-h2">How the setup scores, component by component.</h2>
        <div class="b-conf">
          <div>
            <div class="b-dial" id="dial">
              <svg viewBox="0 0 120 120" role="img" aria-label="Confidence ${score == null ? 'unscored' : score + ' out of 100'}">
                <circle class="trk" cx="60" cy="60" r="50"/>
                ${(() => {
                  const R = 50, C = 2 * Math.PI * R;
                  const n = COMPS.length, seg = C / n, gap = 3;
                  // Read from the live tokens so the dial matches whichever
                  // theme is on, rather than the dark palette it was drawn for.
                  const cs = getComputedStyle(document.documentElement);
                  const tok = n => (cs.getPropertyValue(n) || '').trim();
                  const col = [tok('--up') || '#4E9E72', tok('--accent') || '#7A9BEE',
                               '#8A6208', tok('--dim') || '#98A0AB', tok('--down') || '#C15F54'];
                  return COMPS.map(([nm, , v], i) => {
                    const len = Number.isFinite(v) ? (seg - gap) * (v / 100) : 0;
                    return `<circle class="seg" data-seg="${i}" cx="60" cy="60" r="${R}"
                      stroke="${col[i]}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
                      stroke-dashoffset="${(-i * seg).toFixed(2)}"><title>${esc(nm)}: ${Number.isFinite(v) ? Math.round(v) : 'not measured'}</title></circle>`;
                  }).join('');
                })()}
              </svg>
              <div class="b-dial-c"><b id="dialN" data-cv="">${score == null ? '—' : '0'}</b>
                <i id="dialL">${esc(conviction)}</i></div>
            </div>
            ${/* THE NUMBER NEEDS A SCALE. "8 of 100" told the reader nothing about
                * where 8 sits, and the bands were only ever stated in prose
                * further down. This is the scale, with the reading marked on
                * it — the same bands the confluence table uses. */''}
            ${score == null ? '' : `<div class="b-bands" role="img"
                 aria-label="Score ${Math.round(score)} of 100. Below 40 is weak, 40 to 60 mixed, 60 and above strong.">
              <div class="b-bt">
                <i class="is-lo"></i><i class="is-mid"></i><i class="is-hi"></i>
                <b style="left:${Math.max(0, Math.min(100, score)).toFixed(1)}%"></b>
              </div>
              <div class="b-bl"><span>0</span><span>40 weak</span><span>60 mixed</span><span>100 strong</span></div>
            </div>`}
            <div class="b-cbtns" role="group" aria-label="Confidence view">
              <button type="button" id="cvScore" aria-pressed="true">Score</button>
              <button type="button" id="cvComp" aria-pressed="false">Components</button>
            </div>
          </div>
          <div id="crows">
            ${COMPS.map(([nm, , v, why], i) => {
              // Same five, from the live tokens — see the dial above.
              const _cs = getComputedStyle(document.documentElement);
              const _t = n => (_cs.getPropertyValue(n) || '').trim();
              const col = [_t('--up') || '#4E9E72', _t('--accent') || '#7A9BEE', '#8A6208',
                           _t('--dim') || '#98A0AB', _t('--down') || '#C15F54'][i];
              return `<button type="button" class="b-crow" data-seg="${i}" aria-expanded="false">
                <span class="dot" style="background:${col}" aria-hidden="true"></span>
                <span><span class="nm">${esc(nm)}</span><span class="why">${esc(why)}</span>
                  <span class="tr"><i data-w="${Number.isFinite(v) ? v.toFixed(0) : 0}" style="background:${col}"></i></span></span>
                <span class="sc">${Number.isFinite(v) ? Math.round(v) : '—'}${
                  COMPS[i] && COMPS[i][4] === false ? '<i class="sc-x">not counted</i>' : ''
                }</span></button>`;
            }).join('')}
            <p class="b-verdict ${score == null ? '' : score >= 70 ? 'is-hi' : score >= 50 ? 'is-mid' : 'is-lo'}">
              ${score == null
                ? 'Not enough measured components to score this setup. Treat it as unrated.'
                : score >= 70
                  ? `<b>${Math.round(score)} of 100.</b> Most of what this site measures agrees. That is
                     what a high reading means and nothing more — it is not a forecast, and the ledger
                     on the Signals page is the honest record of how these have actually done.`
                  : score >= 50
                    ? `<b>${Math.round(score)} of 100.</b> The components disagree with each other. A
                       middling score is the site saying it does not have a strong read, not a
                       softened yes.`
                    : `<b>${Math.round(score)} of 100 — this is a weak setup by this site's own
                       measure.</b> It is here because it is the best-scoring signal open right now,
                       which is not the same as a good one: the screen ranks what it has, and on a
                       quiet day the top of a weak field is still a weak field. On a reading this
                       low the honest answer to "should I take this" is no, or not at this size.
                       What a low score buys you is a documented reason to skip it.${
                         H && H.trades ? '' : ` No signal published since ${esc(LAUNCH)} has closed
                           yet, so there is no live record to weigh this against — that is the honest
                           position of a ledger two days old, and it changes as trades close.`}`}
            </p>
            <p class="b-p" style="font-size:var(--t-4)">${RANKED
              ? `Each measured component is a <b>percentile against the ${UNIV.length} names on the
                 screen today</b>, so 50 is the median stock and 90 is the top decile. They used
                 fixed bands, and one of them was inert: volume was scored from 0.7× upward while
                 the median name across the universe runs 0.37× — four in five scored zero on it
                 regardless of what they did, which pulled every score on this site down by about a
                 quarter. A percentile cannot de-calibrate that way, and it makes the four
                 components directly comparable, which the bands never were.`
              : `The screen did not load, so the components fall back to fixed bands rather than to
                 a rank against the market. Read them as rough.`}
              ${/* SHOW THE SUM. "The mean of the measured components" is a
                  * description of arithmetic; the arithmetic itself is four
                  * numbers and a division, and printing it removes any question
                  * about weighting — every measured component counts once. */''}
              <b>Every measured component carries equal weight.</b> Today that is
              <span class="b-sum">${have.map(v => Math.round(v)).join(' + ')} = ${
                Math.round(have.reduce((a, b) => a + b, 0))}, ÷ ${have.length} = <b>${score}</b></span>.
              Reward to risk is listed with them but excluded, because the stop and the target are
              chosen by the engine rather than observed: folding them in let a setup raise its own
              score by moving its own target.
              A component with no data is left out rather than filled in${have.length < MEASURED.length
                ? `, which is why the denominator here is <b style="color:var(--b-ink)">${have.length}</b>,
                   not ${MEASURED.length} — ${MEASURED.length - have.length} measured component${MEASURED.length - have.length > 1 ? 's are' : ' is'}
                   unavailable for this name`
                : `. All ${MEASURED.length} measured components were available for this name`}.</p>
          </div>
        </div>
      </section>

      <section class="b-sec b-reveal">
        <div class="b-lab">Confluence</div>
        <h2 class="b-h2">Which factors agree, and which do not.</h2>
        <div class="b-mx">
          <div class="b-mxh"><span>Factor</span><span>Bullish</span><span>Neutral</span><span>Bearish</span></div>
          ${MATRIX.map(([nm, st_, why, counted], i) => `<button type="button" class="b-mxr${counted ? '' : ' is-out'}" data-mx="${i}" aria-expanded="false">
            <span class="f">${esc(nm)}${counted ? '' : '<i class="mx-out">not scored</i>'}</span>
            ${counted
              ? [0, 1, 2].map(k => `<span class="c ${['bull', 'neu', 'bear'][k]} ${st_ === k ? 'hit' : ''}"
                  >${st_ === k ? `<u aria-label="${['Bullish', 'Neutral', 'Bearish'][k]}"></u>` : '<u></u>'}</span>`).join('')
              : `<span class="c mx-flat">${rrT1.toFixed(1)} : 1 to the first target${
                  rrT2 > rrT1 ? `, ${rrT2.toFixed(1)} : 1 to the second` : ''} — geometry, not direction</span>`}
            <span class="b-mxd"><span>${st_ == null ? 'Not measured — this factor has no data on the screen for this name, so it takes no stance.' : esc(why)}</span></span>
          </button>`).join('')}
        </div>
        <p class="b-p" style="font-size:var(--t-4)">A stance is scored, not asserted: 60 and above reads bullish,
          40 to 60 neutral, below 40 bearish, on the same component scores shown above.
          <b>Risk / reward takes no stance at all.</b> Bullish and bearish are claims about
          direction; the distance between a stop and a target is not one. It is chosen by the engine
          rather than measured off the market, so it shows its ratio and is excluded from the score.
          Tap a row for the reason.</p>
      </section>

      <section class="b-sec b-reveal">
        <div class="b-lab">The business</div>
        <h2 class="b-h2">What the company behind the trade actually earns.</h2>
        ${(() => {
          /* A SETUP IS NOT A COMPANY. Everything above this section is price:
           * levels, momentum, structure, volume. None of it knows whether the
           * business makes money. These are the screen's own fundamental
           * fields for the same name, on the same build — so a reader can see
           * that a clean chart sits on a 78x earnings multiple, or that a
           * breakout is happening in a business whose profit is not arriving
           * as cash.
           *
           * ANNUAL, NOT QUARTERLY, and it says so. The screen carries
           * year-on-year growth off the filings; there is no quarterly series
           * anywhere in this product, so none is shown or implied. */
          const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
          const cell = (k, v, note) => `<div class="b-vi"><dt>${esc(k)}</dt>
            <dd${v == null ? ' class="txt" style="color:var(--b-dim)"' : ''}>${v == null ? 'Not measured' : v}</dd>
            ${note ? `<dd class="b-fn">${esc(note)}</dd>` : ''}</div>`;
          const money = v => n(v) == null ? null
            : n(v) >= 1e5 ? '₹' + (n(v) / 1e5).toFixed(2) + ' lakh cr'
            : '₹' + Math.round(n(v)).toLocaleString('en-IN') + ' cr';
          const x = v => n(v) == null ? null : n(v).toFixed(2) + '×';
          const p1 = v => n(v) == null ? null : n(v).toFixed(1) + '%';
          const has = ['roce', 'roe', 'pe', 'rev_yoy', 'pat_yoy', 'mcap_cr']
            .some(k => n(row[k]) != null);
          if (!has) return `<div class="empty" style="margin-top:22px">This name is not on the
            750-name screen, so no fundamental data is published for it here. The price half of
            this brief still stands; the business half is simply not measured.</div>`;
          return `<dl class="b-view" style="margin-top:22px">
            ${cell('Market cap', money(row.mcap_cr))}
            ${cell('Sector', row.sector ? esc(row.sector) : null)}
            ${cell('P / E', x(row.pe), n(row.pe) != null && n(row.pe) > 50 ? 'richly valued' : '')}
            ${cell('P / B', x(row.pb))}
            ${cell('ROCE', p1(row.roce), n(row.roce_med) != null ? `median ${n(row.roce_med).toFixed(1)}%` : '')}
            ${cell('ROE', p1(row.roe))}
            ${cell('Debt / equity', x(row.de), n(row.de) != null && n(row.de) < 0.5 ? 'lightly geared' : '')}
            ${cell('Piotroski', n(row.piotroski) != null ? `${n(row.piotroski)} / ${n(row.piotroski_of) || 9}` : null)}
          </dl>

          <div class="b-lab" style="margin-top:34px">Latest reported year ${row.fy ? '· ' + esc(row.fy) : ''}</div>
          <dl class="b-view" style="margin-top:14px">
            ${cell('Revenue', n(row.rev_yoy) != null ? `<span class="${dir(row.rev_yoy)}">${pct(row.rev_yoy)}</span>` : null, 'year on year')}
            ${cell('EBITDA', n(row.ebitda_yoy) != null ? `<span class="${dir(row.ebitda_yoy)}">${pct(row.ebitda_yoy)}</span>` : null, 'year on year')}
            ${cell('Profit', n(row.pat_yoy) != null ? `<span class="${dir(row.pat_yoy)}">${pct(row.pat_yoy)}</span>` : null, 'year on year')}
            ${cell('EPS', n(row.eps_yoy) != null ? `<span class="${dir(row.eps_yoy)}">${pct(row.eps_yoy)}</span>` : null, 'year on year')}
            ${cell('Net margin', p1(row.net_margin))}
            ${cell('Cash conversion', x(row.cfo_pat),
                   n(row.cfo_pat) != null && n(row.cfo_pat) < 0.8 ? 'profit is not all arriving as cash' : '')}
            ${cell('Interest cover', x(row.icover),
                   n(row.icover) != null && n(row.icover) < 3 ? 'thin' : '')}
            ${cell('Promoter holding', p1(row.insiders))}
          </dl>

          <p class="b-p" style="font-size:var(--t-4)">Figures come from company filings as aggregated by
            the same 750-name screen the rest of this site runs on${row.fy ? `, for ${esc(row.fy)}` : ''}${
            n(row.fy_count) ? ` across ${n(row.fy_count)} reported years` : ''}.
            <b style="color:var(--b-ink)">They are annual, not quarterly</b> — no quarterly series
            exists in this product, so none is shown. Filings get restated and these figures move.
            Anything the screen does not carry reads <b style="color:var(--b-ink)">Not measured</b>
            rather than being estimated. <a href="/methodology" style="color:var(--b-acc)">How the
            screen is built →</a></p>`;
        })()}
      </section>

      <section class="b-sec b-reveal">
        <div class="b-lab">Market regime ${tip('regime')}</div>
        <h2 class="b-h2">Whether this is the kind of market the setup is built for.</h2>
        ${reg ? `<div class="b-rg">
          <div class="b-rgb"><h4>Structure</h4>
            <div class="b-rgv">${esc(reg.label)}</div>
            <div class="b-rgt"><i style="left:${reg.persist.toFixed(1)}%"></i></div>
            <div class="b-rgl"><span>Below the mean</span><span>Above the mean</span></div>
            <p class="b-rgn">Over the last ${reg.look} closes, price finished above its own trailing
              20-day average <b style="color:var(--b-ink)">${reg.persist.toFixed(0)}%</b> of the time.
              Sustained above 66% or below 34% reads as a trend; in between reads as a range.</p>
            ${/* WHAT IT MEANS, NOT ONLY HOW IT IS MEASURED. This block explained
                * its own method and stopped, so a reader learned that 58% is
                * "ranging" and nothing about whether that helps or hurts the
                * trade in front of them. */''}
            <p class="b-rgw"><b>What that means here.</b> ${
              reg.label === 'RANGING'
                ? `A range keeps returning price to its middle, which is the market a breakout entry
                   is most often given back in. It does not invalidate the setup — the stop does that
                   — but it is the condition this kind of entry works least well in.`
                : reg.label === 'TRENDING UP'
                  ? `A sustained uptrend is the market a long continuation setup is built for: price
                     spends most of its time above its own mean, so the drift is behind the entry
                     rather than against it.`
                  : `Price has spent most of this window below its own mean, so a long entry is taken
                     against the prevailing direction — the hardest version of this trade, and the
                     one that most needs its stop respected.`}</p></div>
          <div class="b-rgb"><h4>Volatility</h4>
            <div class="b-rgv">${esc(reg.volLabel)}</div>
            <div class="b-rgt"><i style="left:${Math.max(0, Math.min(100, reg.vol / 60 * 100)).toFixed(1)}%"></i></div>
            <div class="b-rgl"><span>0%</span><span>60%+</span></div>
            <p class="b-rgn">Realised volatility is
              <b style="color:var(--b-ink)">${reg.vol.toFixed(1)}%</b> annualised — the standard deviation
              of daily returns across this window, scaled by the square root of 252.
              ${Number.isFinite(N(row.atr_pct)) ? `The screen's own daily ATR for this name is ${N(row.atr_pct).toFixed(2)}%.` : ''}</p>
            ${/* THE STOP, IN DAYS OF NORMAL MOVEMENT. "57.8% annualised" is a
                * statistic; "the stop is 1.8 average days away" is a decision.
                * Anything inside about two days of typical range is a stop
                * ordinary noise can reach without the thesis being wrong. */''}
            ${Number.isFinite(N(row.atr_pct)) && N(row.atr_pct) > 0 && Number.isFinite(entry) && Number.isFinite(stop)
              ? (() => {
                  const away = Math.abs(entry - stop) / entry * 100;
                  const days = away / N(row.atr_pct);
                  return `<p class="b-rgw"><b>What that means here.</b> This name moves about
                    <b style="color:var(--b-ink)">${N(row.atr_pct).toFixed(2)}%</b> on an average day and
                    the stop sits <b style="color:var(--b-ink)">${away.toFixed(2)}%</b> from entry —
                    about <b style="color:var(--b-ink)">${days.toFixed(1)}</b> average days of movement.
                    ${days < 2
                      ? `That is inside ordinary noise: this stop can be reached without the thesis
                         being wrong at all.`
                      : days < 4
                        ? `That is a normal working distance — far enough to survive a quiet day,
                           close enough to matter.`
                        : `That is a wide stop. It will not be hit by noise, but it is also the
                           amount you are risking to find out.`}</p>`;
                })() : ''}</div>
        </div>`
        : `<p class="b-p">Regime is not measured for this name — it needs at least 30 daily closes and the
            series did not load. It is left blank rather than guessed from the levels.</p>`}
      </section>

      <section class="b-sec b-reveal" id="b-plan">
        <div class="b-lab">Scenarios</div>
        <h2 class="b-h2">Three ways this resolves.</h2>
        <div class="b-scb" role="group" aria-label="Scenario">
          <button type="button" class="bull" data-sc="0" aria-pressed="false">Bullish</button>
          <button type="button" class="base" data-sc="1" aria-pressed="true">Base case</button>
          <button type="button" class="bear" data-sc="2" aria-pressed="false">Bearish</button>
        </div>
        <div class="b-scp" id="scPane"></div>
        <p class="b-p" style="font-size:var(--t-4)">These are scenarios, not forecasts. No probability is
          attached to any of them, because the engine publishes no probability model — what is shown
          instead is the ledger's own base rate over every closed signal, which describes the engine's
          history and not this trade.</p>
      </section>

      <section class="b-sec b-reveal">
        <div class="b-lab">Trade plan</div>
        <h2 class="b-h2">What to do, and when to stop doing it.</h2>
        <div class="b-plan">
          <div class="b-pr"><span class="st">Before entry</span>
            <span class="tx">Price holding the entry zone on a close, not an intraday wick. No entry if the stop is already broken.</span>
            <span class="px">—</span></div>
          <div class="b-pr"><span class="st">Entry</span>
            <span class="tx">${isShort ? 'Sell' : 'Buy'} at or better than the published level.</span>
            <span class="px">${f(entry)}</span></div>
          <div class="b-pr"><span class="st">Stop</span>
            <span class="tx">Invalidation. A close beyond this removes the reason for the trade.</span>
            <span class="px" style="color:var(--b-bear)">${f(stop)}</span></div>
          <div class="b-pr"><span class="st">Target 1</span>
            <span class="tx">First profit level. The published trailing rule moves the stop to entry once this prints.</span>
            <span class="px" style="color:var(--b-bull)">${f(t1)}</span></div>
          <div class="b-pr"><span class="st">Target 2</span>
            <span class="tx">Extended target, carried only by the remainder.</span>
            <span class="px" style="color:var(--b-bull)">${f(t2)}</span></div>
          <div class="b-pr is-invalid"><span class="st">Invalidation ${tip('invalidation')}</span>
            <span class="tx">Below ${f(stop)} the structure that produced this setup is gone. The position is
              closed at that price — not re-argued, not averaged into, not widened.</span>
            <span class="px" style="color:var(--b-bear)">${f(stop)}</span></div>
        </div>
      </section>

      <section class="b-sec b-reveal" id="b-risk">
        <div class="b-lab">Risk and position size ${tip('rr')}</div>
        <h2 class="b-h2">What this costs if it is wrong.</h2>
        <div class="b-rr">
          <div>
            <div class="b-rrb" id="rrBars">
              <div class="row"><span class="k">Loss</span><span class="b loss" id="barL"></span><span class="v" id="barLv" style="color:var(--b-bear)"></span></div>
              <div class="row"><span class="k">Gain T1</span><span class="b gain" id="barG"></span><span class="v" id="barGv" style="color:var(--b-bull)"></span></div>
              <div class="row"><span class="k">Gain T2</span><span class="b gain" id="barG2"></span><span class="v" id="barG2v" style="color:var(--b-bull)"></span></div>
            </div>
            <div class="b-metrics" style="margin-top:22px" id="rkOut"></div>
            <p class="b-p" style="font-size:var(--t-4)">Position size is the risk amount divided by the distance
              from entry to stop, rounded down to whole shares. It is arithmetic on the numbers you set —
              not a recommendation, and it takes no account of your other positions, liquidity in the name,
              or what you can afford to lose.</p>
          </div>
          <div>
            <div class="b-sl">
              <div><label for="rkA">Account size<span class="lv" id="lvA"></span></label>
                <input id="rkA" type="number" value="1000000" min="0" step="10000"
                  style="width:100%;background:var(--b-hi);border:1px solid var(--b-line2);border-radius:7px;
                  color:var(--b-ink);font:500 15px/1 var(--mono);padding:12px 13px;min-height:44px"></div>
              <div><label for="rkP">Risk per trade<span class="lv" id="lvP"></span></label>
                <input id="rkP" type="range" min="0.1" max="5" step="0.1" value="1"></div>
              <!-- step="any", NOT a rounded step. A range input SNAPS its value to
                   min + n·step, so a step of 1.85 moved the published entry of
                   ₹1,847.40 to ₹1,847.79 the instant the page loaded — the
                   calculator then showed a risk per share that was not the
                   published one, and the simulation warning stayed silent
                   because the drift was under half a per cent. The published
                   levels have to survive first paint exactly. -->
              <div><label for="slE">Entry<span class="lv" id="lvE"></span></label>
                <input id="slE" type="range" min="${(entry * 0.85).toFixed(2)}" max="${(entry * 1.15).toFixed(2)}"
                  step="any" value="${entry}"></div>
              <div><label for="slS">Stop<span class="lv" id="lvS"></span></label>
                <input id="slS" type="range" min="${(Math.min(stop, entry) * 0.8).toFixed(2)}" max="${(Math.max(stop, entry) * 1.05).toFixed(2)}"
                  step="any" value="${stop}"></div>
              <div><label for="slT">Target 1<span class="lv" id="lvT"></span></label>
                <input id="slT" type="range" min="${(Math.min(t1, entry) * 0.95).toFixed(2)}" max="${(Math.max(t1, entry) * 1.4).toFixed(2)}"
                  step="any" value="${t1}"></div>
              <button type="button" class="b-reset" id="rkReset">Reset to published</button>
            </div>
            <p class="b-sim" id="rkSim" hidden>You are looking at a <b>simulation</b>. One or more levels
              have been moved off the published values, so the risk, reward and size below describe a trade
              this site has not signalled.</p>
          </div>
        </div>
      </section>

      <section class="b-sec b-reveal" id="b-history">
        <div class="b-lab">What the ledger records</div>
        <h2 class="b-h2">This signal's own paper trail.</h2>
        <div class="b-tl" id="tl">
          ${[
            [String(sig.alert_date || sig.date || '').slice(0, 10),
             `<b>Signal published.</b> ${esc(engName(sig.signal_type) || 'engine')} engine, ${esc(sig.timeframe || '1D')} timeframe, entry ${f(entry)} with the stop at ${f(stop)}.`],
            sig.sent_at ? [String(sig.sent_at).slice(0, 10) + ' ' + String(sig.sent_at).slice(11, 16),
             `<b>Sent.</b> The alert left the engine at this time and has not been amended since.`] : null,
            [ageDays == null ? '—' : ageDays + ' days',
             `<b>Still open.</b> The ledger carries no exit for this row, so it is marked open and counts toward no closed result yet.`],
            [f(last),
             `<b>Marked at the current price.</b> ${Number.isFinite(last) && Number.isFinite(entry)
               ? `That is ${pct((last - entry) / entry * 100)} against the published entry — unrealised, and not a booked result.` : 'No current price is available.'}`],
          ].filter(Boolean).map(([w, t]) => `<div class="b-tli"><span class="w">${esc(w)}</span><span class="t">${t}</span></div>`).join('')}
        </div>
        <p class="b-p" style="font-size:var(--t-4)">The ledger records when a signal was generated, when it was
          sent, and how it closed. It does <b style="color:var(--b-ink)">not</b> record intraday development
          — there is no row saying momentum confirmed at 09:24 — so none is shown. A timeline of events that
          were never logged would be a story, not a record.</p>
      </section>

      <section class="b-sec b-reveal">
        <div class="b-lab">Signal history</div>
        <h2 class="b-h2">The record, including the part that hurts.</h2>
        ${H ? `<div class="b-metrics" style="margin-top:22px">
          <div class="b-m"><span class="k">Closed</span><span class="v">${hNum(H.trades)}</span></div>
          <div class="b-m"><span class="k">Win rate</span><span class="v">${hNum(H.win_rate, '%')}</span></div>
          <div class="b-m"><span class="k">Wins</span><span class="v up">${hNum(H.wins)}</span></div>
          <div class="b-m"><span class="k">Losses</span><span class="v dn">${hNum(H.losses)}</span></div>
          <div class="b-m"><span class="k">Expectancy</span><span class="v ${H.expectancy_r >= 0 ? 'up' : 'dn'}">${hNum(H.expectancy_r, 'R')}</span></div>
        </div>
        <p class="b-p">${tip('expectancy')} Measured over ${hNum(H.trades)} signals closed since <b style="color:var(--b-ink)">${esc(LAUNCH)}</b>, the day this site started counting.
          Expectancy is <b style="color:var(--b-ink)">${hNum(H.expectancy_r, 'R')}</b>${H.expectancy_r < 0
            ? ' — the engine is currently losing money per trade on this sample, and that is published here for the same reason the winners are.'
            : ' per closed trade on this sample.'}</p>` : ''}
        ${!H ? `<div class="empty" style="text-align:left;padding:22px 20px;margin-top:22px">
            <b style="color:var(--b-ink)">Nothing has closed yet.</b> ${
              rows.filter(r => (r.badge || '') === 'open' && sinceLaunch(r)).length
            } signals are open and none has resolved, so there is no win rate, no expectancy and no
            record to show. It appears the moment one closes.

          </div>` : ''}
        ${closedRows.length ? `<div class="b-hist"><table>
          <thead><tr><th>Date</th><th>Asset</th><th>Direction</th>
            <th class="num">Entry</th><th class="num">Exit</th><th>Result</th><th class="num">P&amp;L</th></tr></thead>
          <tbody>${closedRows.map(r => `<tr>
            <td>${esc(String(r.alert_date || r.date || '').slice(0, 10))}</td>
            <td style="color:var(--b-ink)">${esc(r.symbol)}</td>
            <td>${esc(r.action || '')}</td>
            <td class="num">${price(r.entry, r.currency || '₹')}</td>
            <td class="num">${price(r.exit_price, r.currency || '₹')}</td>
            <td style="color:${(r.badge === 'win') ? 'var(--b-bull)' : 'var(--b-bear)'}">${esc(r.status || r.badge || '')}</td>
            <td class="num" style="color:${Number(r.pnl_pct) > 0 ? 'var(--b-bull)' : 'var(--b-bear)'}">${pct(r.pnl_pct)}</td>
          </tr>`).join('')}</tbody></table></div>` : ''}
        <div class="b-disc"><b>Past performance does not guarantee future results.</b>
          This is a published research setup, not advice and not a recommendation to buy or sell.
          Every figure is drawn from this site's own ledger, its own screen and real published closing
          prices. A signal is a thesis with a defined invalidation — it is not a forecast, and it carries
          no guarantee of any outcome. Position sizing is your decision and your risk.</div>
      </section>
    </div></div>`);

    /* ══ WIRING ═══════════════════════════════════════════════════════════
     * Everything below runs after paint and touches only opacity, transform
     * and width. No layout is animated, nothing runs on an idle loop, and
     * every listener is attached to an element that exists in this paint —
     * the route re-paints wholesale, so the old ones go with the old nodes. */

    const $ = id => document.getElementById(id);

    /* ── THE LADDER'S LABELS, SPACED IN REAL PIXELS ─────────────────────────
     * The ladder is a linear price scale, so two levels a rupee apart land two
     * pixels apart. On JKTYRE the current price (₹380.25) and the entry
     * (₹378.75) are 0.4% apart across a ₹363-599 range and their labels printed
     * exactly on top of each other.
     *
     * Only the TEXT moves. Every rule stays on its true price, because that is
     * the one claim this chart makes — that the distance between the stop and
     * the target is the actual distance. A reader still sees two lines almost
     * touching, and can now read both numbers.
     *
     * Measured rather than computed in percent: the box is clamp(300px,40vw,
     * 400px), so its height is only knowable after layout, and the required
     * gap is the label's own rendered height rather than a guessed fraction.
     */
    const spaceLadder = () => {
      const box = main.querySelector('.b-ladder');
      if (!box) return;
      const rows = [...box.querySelectorAll('.b-lvl')];   // DOM order = high → low
      if (rows.length < 2) return;
      rows.forEach(r => r.style.setProperty('--lnudge', '0px'));
      const H = box.clientHeight;
      if (!H) return;
      const tag = rows[0].querySelector('.b-lvl-tag');
      const gap = Math.max(14, (tag ? tag.getBoundingClientRect().height : 12) + 3);
      const tops = rows.map(r => parseFloat(r.style.top) / 100 * H);
      /* A label is centred on its row, so its own half-height is the margin it
       * needs at each end. Without this the bottom label hung 19px below the
       * box and sat 3px off the caption — the crowding just moved rather than
       * being resolved.
       *
       * Two passes, the standard shape: push down until nothing overlaps, then,
       * if the pile has run past the bottom, pull back up from the last row.
       * Each pass clamps to the usable band, so labels stay inside the box. */
      const half = gap / 2;
      const lo = half, hi = Math.max(half, H - half);
      const lab = tops.slice();
      lab[0] = Math.max(lo, lab[0]);
      for (let i = 1; i < lab.length; i++) {
        lab[i] = Math.max(lab[i], lab[i - 1] + gap);
      }
      if (lab[lab.length - 1] > hi) {
        lab[lab.length - 1] = hi;
        for (let i = lab.length - 2; i >= 0; i--) {
          lab[i] = Math.min(lab[i], lab[i + 1] - gap);
        }
      }
      rows.forEach((r, i) => r.style.setProperty('--lnudge', (lab[i] - tops[i]).toFixed(1) + 'px'));
    };
    setTimeout(spaceLadder, 90);
    // The box is sized in vw, so its height changes with the window. Debounced,
    // and torn down with the route — resize fires in bursts.
    let ladderT = 0;
    const onResize = () => { clearTimeout(ladderT); ladderT = setTimeout(spaceLadder, 120); };
    window.addEventListener('resize', onResize);

    /* ── numbers arrive, they do not appear ─────────────────────────────── */
    if (score != null) {
      countTo($('convN'), score, { dp: 0 });
      countTo($('dialN'), score, { dp: 0 });
    }
    setTimeout(() => {
      main.querySelectorAll('.b-crow .tr i').forEach(i => { i.style.width = i.dataset.w + '%'; });
    }, 80);

    // Fold the workup BEFORE the observer is wired, so the sections it is
    // about to watch are already in their final place in the DOM.
    foldBrief(main);

    /* ── the reveal, and the chart story it drives ──────────────────────────
     * IntersectionObserver where it works, and a hard failsafe where it does
     * not: an observer that never fires would leave the whole page at opacity
     * 0, which is a blank screen, not a subtle animation. */
    const reveals = [...main.querySelectorAll('.b-reveal')];
    const tls = [...main.querySelectorAll('.b-tli')];
    const ovs = [...main.querySelectorAll('.b-ov')];
    const revealAll = () => {
      reveals.forEach(e => e.classList.add('in'));
      tls.forEach(e => e.classList.add('in'));
      ovs.forEach(e => e.classList.add('on'));
    };
    // The chart's overlays come on in the order the argument is made: the
    // price line, then the levels that frame it, then the risk band, then the
    // reward band. Step 1 is always on — it is the price itself.
    const stepOn = n => ovs.forEach(e => { if (Number(e.dataset.ov) <= n) e.classList.add('on'); });

    if ('IntersectionObserver' in window && !REDUCED) {
      const io = new IntersectionObserver(es => es.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        // Each section that arrives advances the chart one more step.
        const step = Number(e.target.dataset.step);
        if (Number.isFinite(step)) stepOn(step);
        io.unobserve(e.target);
      }), { rootMargin: '0px 0px -12% 0px', threshold: .08 });
      reveals.forEach((e, i) => { e.dataset.step = String(3 + i); io.observe(e); });
      tls.forEach(e => io.observe(e));
      // If nothing has revealed within 2.5s the observer is not firing — a
      // hidden tab, a prerender, a browser that throttles it. Show everything.
      setTimeout(() => { if (!main.querySelector('.b-reveal.in')) revealAll(); }, 2500);
      // The chart's own levels never wait on scroll: the reader who lands on
      // #b-chart directly must see them.
      setTimeout(() => stepOn(2), 400);
    } else { revealAll(); }

    /* ── quick nav: where you are, and the keys that take you there ─────── */
    /* Three sticky layers stack above the content on a desk — the bar, the
     * route tabs and this brief's own section nav. A fixed 96px offset cleared
     * two of them and parked the section label underneath the third. The
     * offset is measured from the elements themselves so it stays correct when
     * any of the three changes height. */
    const stickyOffset = () => {
      let h = 0;
      for (const sel of ['.bar', '.tabs', '#qnav']) {
        const e = document.querySelector(sel);
        if (e && getComputedStyle(e).position === 'sticky') h += e.getBoundingClientRect().height;
      }
      return h + 18;
    };
    const jump = id => {
      const el = $(id); if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - stickyOffset();
      /* Smooth ONLY for a short hop. The brief grew long enough that a jump
       * from the hero to the trade plan travels ~6,500px, and smooth-scrolling
       * six screens takes two seconds of blurred content going past — which is
       * slower and more disorienting than simply arriving. Beyond two
       * viewports it cuts. */
      const far = Math.abs(top - window.scrollY) > window.innerHeight * 2;
      window.scrollTo({ top, behavior: (REDUCED || far) ? 'auto' : 'smooth' });
    };
    const qlinks = [...main.querySelectorAll('#qnav a')];
    const jnodes = [...main.querySelectorAll('.b-jn')];
    qlinks.forEach(a => a.addEventListener('click', ev => { ev.preventDefault(); jump(a.dataset.jump); }));

    // One scroll listener for the whole page, throttled to one frame. Reading
    // getBoundingClientRect for six elements per frame is cheap; doing it per
    // element per scroll event is not.
    let ticking = false;
    const markActive = () => {
      ticking = false;
      let active = SECTIONS[0][0];
      for (const [id] of SECTIONS) {
        const el = $(id); if (!el) continue;
        if (el.getBoundingClientRect().top <= stickyOffset() + 24) active = id;
      }
      qlinks.forEach(a => a.setAttribute('aria-current', a.dataset.jump === active ? 'true' : 'false'));
      let seen = false;
      jnodes.forEach(n => {
        const isNow = n.dataset.node === active;
        n.classList.toggle('on', isNow);
        n.classList.toggle('done', !seen && !isNow);
        if (isNow) seen = true;
      });
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(markActive); } };
    window.addEventListener('scroll', onScroll, { passive: true });
    markActive();

    // 1–6 jump to a section, Escape closes any open overlay. Ignored while a
    // field has focus, so typing "1" into the account box does not navigate.
    const onKey = ev => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const i = '123456'.indexOf(ev.key);
      if (i >= 0 && SECTIONS[i]) { ev.preventDefault(); jump(SECTIONS[i][0]); }
    };
    document.addEventListener('keydown', onKey);
    // The route repaints wholesale; the listener must not outlive its markup.
    main.addEventListener('sig:teardown', () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      clearTimeout(ladderT);
      document.removeEventListener('keydown', onKey);
    }, { once: true });

    /* ── the ladder reads its own distances ─────────────────────────────── */
    main.querySelectorAll('.b-lvl').forEach(el => {
      const on = () => el.classList.add('hot'), off = () => el.classList.remove('hot');
      el.addEventListener('pointerenter', on); el.addEventListener('pointerleave', off);
      el.addEventListener('focus', on); el.addEventListener('blur', off);
    });

    /* ── the chart: crosshair, read-out, and the window switch ──────────── */
    if (CH) {
      const hit = $('pxhit'), tip = $('pxt'), dot = $('pxdot'), cross = $('pxcross');
      const read = clientX => {
        const b = hit.getBoundingClientRect();
        const k = Math.max(0, Math.min(1, (clientX - b.left) / (b.width || 1)));
        const i = Math.round(k * (pts.length - 1));
        const p = pts[i];
        if (!p) return;
        const xPct = (i / Math.max(1, pts.length - 1)) * 100;
        const yPct = (CH.Y(p.c) / CH.H) * 100;
        cross.setAttribute('x1', ((i / Math.max(1, pts.length - 1)) * CH.W).toFixed(1));
        cross.setAttribute('x2', ((i / Math.max(1, pts.length - 1)) * CH.W).toFixed(1));
        cross.style.opacity = '1';
        dot.style.left = xPct + '%'; dot.style.top = yPct + '%'; dot.style.opacity = '1';
        const dpc = i > 0 && pts[i - 1].c ? (p.c / pts[i - 1].c - 1) * 100 : null;
        tip.innerHTML = `<i>${esc(p.t || '')}</i>${f(p.c)}` +
          (dpc == null ? '' : ` <em>${pct(dpc)}</em>`) +
          `<br><em>vs entry ${pct((p.c - entry) / entry * 100)}</em>`;
        tip.classList.add('on');
        // Flip the card to the other side near the right edge so it never
        // hangs off the chart.
        tip.style.left = xPct > 62 ? 'auto' : `calc(${xPct}% + 14px)`;
        tip.style.right = xPct > 62 ? `calc(${(100 - xPct)}% + 14px)` : 'auto';
      };
      const clear = () => { tip.classList.remove('on'); dot.style.opacity = '0'; cross.style.opacity = '0'; };
      hit.addEventListener('pointermove', e => read(e.clientX));
      hit.addEventListener('pointerdown', e => read(e.clientX));
      hit.addEventListener('pointerleave', clear);
      hit.addEventListener('pointercancel', clear);

      main.querySelectorAll('.b-px-h .rgs button').forEach(b =>
        b.addEventListener('click', () => { briefRange = b.dataset.range; R['/brief'](); }));
    }

    /* ── confidence: segments, rows, and the two views ──────────────────── */
    const segs = [...main.querySelectorAll('.b-dial .seg')];
    const crows = [...main.querySelectorAll('.b-crow')];
    const focusSeg = i => {
      segs.forEach((s, k) => { s.classList.toggle('hot', k === i); s.classList.toggle('dim', i != null && k !== i); });
      crows.forEach((r, k) => r.classList.toggle('dim', i != null && k !== i));
      const dl = $('dialL'), dn = $('dialN');
      if (i == null) { dl.textContent = conviction; if (score != null) countTo(dn, score, { dp: 0 }); }
      else {
        dl.textContent = COMPS[i][0].toUpperCase();
        const v = COMPS[i][2];
        if (Number.isFinite(v)) countTo(dn, Math.round(v), { dp: 0 }); else dn.textContent = '—';
      }
    };
    segs.forEach((s, i) => {
      s.addEventListener('pointerenter', () => focusSeg(i));
      s.addEventListener('pointerleave', () => focusSeg(null));
    });
    crows.forEach((r, i) => {
      r.addEventListener('pointerenter', () => focusSeg(i));
      r.addEventListener('pointerleave', () => focusSeg(null));
      r.addEventListener('click', () => {
        const open = r.classList.toggle('open');
        r.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      r.addEventListener('focus', () => focusSeg(i));
      r.addEventListener('blur', () => focusSeg(null));
    });
    const cvS = $('cvScore'), cvC = $('cvComp');
    const setView = comp => {
      cvS.setAttribute('aria-pressed', comp ? 'false' : 'true');
      cvC.setAttribute('aria-pressed', comp ? 'true' : 'false');
      segs.forEach(s => { s.style.strokeWidth = comp ? '15' : ''; });
      crows.forEach(r => {
        r.classList.toggle('open', comp);
        r.setAttribute('aria-expanded', comp ? 'true' : 'false');
      });
    };
    cvS.addEventListener('click', () => setView(false));
    cvC.addEventListener('click', () => setView(true));

    /* ── confluence rows ────────────────────────────────────────────────── */
    main.querySelectorAll('.b-mxr').forEach(r => r.addEventListener('click', () => {
      const open = r.classList.toggle('open');
      r.setAttribute('aria-expanded', open ? 'true' : 'false');
    }));

    /* ── scenarios ──────────────────────────────────────────────────────── */
    const baseRate = H && Number.isFinite(Number(H.win_rate)) ? Number(H.win_rate) : null;
    const SC = [
      ['Continuation through both targets.',
       `Price clears ${f(t1)} and carries to ${f(t2)}. That needs the structure that produced this setup to hold — the 50-day above the 200-day, volume staying at or above its recent average, and no close back under ${f(entry)}.`,
       [['Requires', `Above ${f(t1)}`], ['Target', f(t2)], ['Move from here', Number.isFinite(last) ? pct((t2 - last) / last * 100) : '—'],
        ['R multiple', ((Math.abs(t2 - entry)) / (risk || 1)).toFixed(1) + 'R']]],
      ['The published plan, run as written.',
       `Entry at ${f(entry)}, first target ${f(t1)}, stop ${f(stop)}. On the published trailing rule the stop moves to entry once ${f(t1)} prints, so the remainder rides to ${f(t2)} with no capital at risk.`,
       [['Requires', `Entry at or better than ${f(entry)}`], ['Target', f(t1)],
        ['Move from here', Number.isFinite(last) ? pct((t1 - last) / last * 100) : '—'],
        ['R multiple', rrT1.toFixed(1) + 'R']]],
      ['The stop does its job.',
       `A close beyond ${f(stop)} and the position closes for a defined loss of ${f(risk)} a share. This is the outcome the whole structure is built to make survivable: it is a known number decided before entry, not a decision taken while losing.`,
       [['Requires', `Close beyond ${f(stop)}`], ['Loss', '−' + f(risk) + ' / share'],
        ['Move from here', Number.isFinite(last) ? pct((stop - last) / last * 100) : '—'],
        ['R multiple', '−1.0R']]],
    ];
    const scPane = $('scPane');
    const drawSc = i => {
      const [h, body, grid] = SC[i];
      scPane.innerHTML = `<h4>${esc(h)}</h4><p>${esc(body)}</p>
        <div class="b-scg">${grid.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
          <div><span class="k">Engine base rate</span><span class="v">${baseRate == null ? '—' : baseRate + '%'}</span></div></div>
        ${baseRate == null ? '' : `<p style="font-size:var(--t-4);color:var(--b-dim);margin-top:14px;line-height:1.6">
          ${baseRate}% is the share of <b style="color:var(--b-mut)">all ${hNum(H.trades)} closed signals</b> that
          ended in profit. It describes the engine's history, not this trade, and it is the same number
          whichever scenario is selected.</p>`}`;
      main.querySelectorAll('.b-scb button').forEach((b, k) =>
        b.setAttribute('aria-pressed', k === i ? 'true' : 'false'));
    };
    main.querySelectorAll('.b-scb button').forEach(b =>
      b.addEventListener('click', () => drawSc(Number(b.dataset.sc))));
    drawSc(1);

    /* ── risk, reward and size — one calculator, live ───────────────────── */
    const ids = ['rkA', 'rkP', 'slE', 'slS', 'slT'];
    const calc = () => {
      const acct = Number($('rkA').value) || 0;
      const rp = Number($('rkP').value) || 0;
      const e2 = Number($('slE').value), s2 = Number($('slS').value), t1b = Number($('slT').value);
      const risk2 = Math.abs(e2 - s2);
      const rr2 = risk2 > 0 ? Math.abs(t1b - e2) / risk2 : 0;
      const amt = acct * rp / 100;
      const qty = risk2 > 0 ? Math.floor(amt / risk2) : 0;
      const loss = qty * risk2, g1 = qty * Math.abs(t1b - e2), g2 = qty * Math.abs(t2 - e2);

      $('lvA').textContent = f(acct);
      $('lvP').textContent = rp.toFixed(1) + '% · ' + f(amt);
      $('lvE').textContent = f(e2); $('lvS').textContent = f(s2); $('lvT').textContent = f(t1b);

      const peak = Math.max(loss, g1, g2, 1);
      $('barL').style.width = (loss / peak * 100).toFixed(1) + '%';
      $('barG').style.width = (g1 / peak * 100).toFixed(1) + '%';
      $('barG2').style.width = (g2 / peak * 100).toFixed(1) + '%';
      countTo($('barLv'), loss, { dp: 0, pre: '−' + cur });
      countTo($('barGv'), g1, { dp: 0, pre: '+' + cur });
      countTo($('barG2v'), g2, { dp: 0, pre: '+' + cur });

      $('rkOut').innerHTML = `
        <div class="b-m"><span class="k">Position size</span><span class="v">${qty.toLocaleString('en-IN')} sh</span></div>
        <div class="b-m"><span class="k">Notional</span><span class="v">${f(qty * e2)}</span></div>
        <div class="b-m"><span class="k">Risk amount</span><span class="v">${f(amt)}</span></div>
        <div class="b-m"><span class="k">R:R to T1</span><span class="v gold">${rr2.toFixed(1)} : 1</span></div>
        <div class="b-m"><span class="k">Risk per share</span><span class="v">${f(risk2)}</span></div>
        <div class="b-m"><span class="k">Of account</span><span class="v">${acct > 0 ? (qty * e2 / acct * 100).toFixed(1) + '%' : '—'}</span></div>`;

      // Say so, loudly, the moment the numbers stop being the published ones.
      // A tenth of a per cent, not half of one. The wider tolerance existed to
      // absorb the slider's own snapping; with step="any" there is nothing to
      // absorb, and a reader who has moved a level deserves to be told.
      const tol = 0.001 * entry;
      const moved = Math.abs(e2 - entry) > tol || Math.abs(s2 - stop) > tol
                 || Math.abs(t1b - t1) > tol;
      $('rkSim').hidden = !moved;
    };
    ids.forEach(id => $(id).addEventListener('input', calc));
    $('rkReset').addEventListener('click', () => {
      $('slE').value = entry; $('slS').value = stop; $('slT').value = t1; calc();
    });
    calc();
  };



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
    ['/', 'Today', 'The morning edition — tape, sector heat, the wire'],
    ['/markets', 'Markets', 'The board: 71 instruments with a year of context'],
    ['/ideas', 'Ideas', 'Ranked names and the orders a sized book would place'],
    ['/ipo', 'IPO', 'Books open now, and how last year’s listings did'],
    ['/screen', 'Screen', 'All 750 names, searchable'],
    ['/watch', 'Watchlist', 'Names you starred, and your price alerts'],
    ['/news', 'News', 'The full wire, and the screened names each story touches'],
    ['/signals', 'Signals', 'The public ledger — wins and losses'],
    ['/brief', 'Brief', 'Today’s setup, in full'],
    ['/radar', 'Signal radar', 'What the market is doing, and which names carry it'],
    ['/engines', 'The floor', 'Every engine — what fires it, and what it has done'],
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
        if (hit) { cmdEl.close(); go(hit.href); }
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
    cmdRows = routes.concat(names);
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
      if (hit.sym) go('/stock/' + encodeURIComponent(hit.sym));
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
  const FEED_AGE = [
    ['Stock screen',   '/screen.json',     30],
    ['Market pulse',   '/pulse.json',      30],
    ['Trade ideas',    '/today.json',      30],
    ['Signal ledger',  '/alerts.json',     30],
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
    ['Conviction',     '/conviction.json', 30],
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
    const kept = [];
    for (let i = 0; i < list.length; i++) {
      let host = null;
      for (const k of kept) { if (sim(toks[i], toks[k.i]) >= threshold) { host = k; break; } }
      if (host) {
        // The byline, not a deletion. Same source twice is not worth printing.
        const src = list[i].source;
        if (src && src !== list[host.i].source && !host.also.includes(src)) host.also.push(src);
      } else {
        kept.push({ i, also: [] });
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

    const rows = await Promise.all(FEED_AGE.map(async ([label, url, maxH]) => {
      const r = await get(url);
      let ts = r.ok ? feedStamp(r.data) : null;
      let inherited = false;
      if (!ts && r.ok && edTs && url !== '/edition.json') { ts = edTs; inherited = true; }
      return { label, url, ok: r.ok, ts, inherited, maxH, h: ageHours(ts) };
    }));

    const dated = rows.filter(x => x.h != null);
    if (!dated.length) return;
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
      fresh === dated.length ? `${fresh}/${dated.length} current` : `${ageWord(worst)}`;
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
              <em style="font-style:normal;color:var(--dim);font-size:var(--t-3)">${esc(x.url)}</em></span>
            <span class="p">${x.ts
              ? esc(isDateOnly(x.ts) ? String(x.ts) + ' (date only)' : String(x.ts).slice(0, 16).replace('T', ' '))
              : '—'}${x.inherited ? '<br><em style="font-style:normal;color:var(--dim);font-size:var(--t-2)">from the edition build</em>' : ''}</span>
            <span class="c ${x.h == null ? '' : x.h <= (x.maxH || 26) ? 'up' : 'dn'}">${
              x.ok ? esc(ageWord(x.h)) : 'did not load'}</span>
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
      <span class="x ${dir(r3)} ${heatCell(r3, 25)}"><b>${Number.isFinite(r3) ? r3.toFixed(2) + '%' : '—'}</b></span>
      <span class="x ${dir(r5)} ${heatCell(r5, 25)}">${Number.isFinite(r5) ? r5.toFixed(2) + '%' : '—'}</span>
      <span class="x ${dir(r1)} ${heatCell(r1, 40)}">${Number.isFinite(r1) ? r1.toFixed(1) + '%' : '—'}</span>
      <!-- A DEEPER FALL AND A HIGHER VOLATILITY ARE WORSE, so the heat is
           inverted: these two are the only columns where a bigger number is
           the bad one, and shading them on the same scale as the returns would
           have painted the riskiest funds green. -->
      <span class="x ${heatCell(-Math.abs(dd), 30)}" title="Worst peak-to-trough fall over three years">${
        Number.isFinite(dd) ? dd.toFixed(1) + '%' : '—'}</span>
      <span class="x ${heatCell(-Math.abs(vol - 14), 12)}" title="Annualised volatility, three years — shaded against a 14% typical equity fund">${
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

    for (const c of cats) {
      out += sec(c.label || c.key, `<div class="rank">
        <div class="rank-r rank-head fnd" aria-hidden="false">
          <span class="i">#</span><span class="s">Scheme</span>
          <span class="x">3-year ↓</span><span class="x">5-year</span><span class="x">1-year</span>
          <span class="x">Worst fall</span><span class="x">Volatility</span>
        </div>
        ${c.funds.map(fundRow).join('')}
      </div>`, `${c.funds.length} funds`, c.blurb || '');
    }

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
      [get('/news.json'), get('/screen.json'), get('/pulse.json'), get('/edition.json'),
       get('/api/wire')]);
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

      const body = rows.length ? `<div class="nwg">${rows.map(x => {
        const hits = universe.length ? newsMatch(x, universe) : [];
        /* THE BADGE STATES A MEASURED FACT, NOT A GRADE.
         *
         * The obvious thing to copy here is a LOW / MEDIUM / HIGH IMPACT
         * chip. This feed carries a headline, a summary, a source and a link
         * — no timestamp, no clustering, no analysis — so an impact grade
         * would be a number I made up, printed in the typeface the rest of
         * this site reserves for measured things. What CAN be established is
         * whether a story names a company in the 750-name screen, and what
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
        sec('What is not here', `<p class="hint" style="margin-top:0">
          This wire carries a headline, a summary, a source and a link — and nothing else.
          There is no timestamp, no story clustering and no analysis in it, so this page cannot
          show <b>time since publication</b>, <b>“+N more sources”</b>, an <b>impact grade</b>, or a
          written <b>why it matters</b>. Those exist on news.askakshay.com because they are
          generated during that site’s daily build and written into its pages; they are not
          published as a feed, so there is nothing here to mirror. Producing them on this site
          needs either a feed added to that build, or a language-model key on this Worker.</p>`));

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
  R['/engines'] = async () => {
    const shell = body => head('The floor',
      'Every engine, what makes it fire, and what it has actually done.',
      'Engines') + body;
    paint(shell(`<div class="sk" style="height:340px"></div>`));

    const [st, sg] = await Promise.all([get('/api/stats'), get('/api/signals?limit=400')]);
    const live = {};
    if (st.ok) for (const r of (st.data.by_signal_type || [])) live[r.key] = r;
    /* SINCE LAUNCH, LIKE EVERY OTHER SURFACE. THIRD TIME.
     * This counted every OPEN row the book has ever carried, so the floor
     * reported 182 open positions and TIDAL alone showed 49, while the brief
     * and the front page — which apply sinceLaunch — said 33 and 34. Same
     * fault as the brief, same fix, and the reason it happened again is that
     * each surface still derives its own population instead of asking for one. */
    const openBy = {};
    if (sg.ok) for (const r of (sg.data.rows || sg.data.signals || [])) {
      if (!sinceLaunch(r)) continue;
      if (String(r.status || '').toUpperCase() === 'OPEN') openBy[r.signal_type] = (openBy[r.signal_type] || 0) + 1;
    }

    const keys = Object.keys(ENGINE_REGISTRY);
    const tierOrder = { LIVE: 0, PAPER: 1, RESEARCH: 2, BLOCKED: 3 };
    keys.sort((a, b) => (tierOrder[ENGINE_TIER[a]] ?? 9) - (tierOrder[ENGINE_TIER[b]] ?? 9)
                     || ((live[b]?.trades || 0) - (live[a]?.trades || 0)));

    const totalOpen = Object.values(openBy).reduce((s, n) => s + n, 0);
    const cleared = keys.filter(k => ENGINE_TIER[k] === 'LIVE').length;
    const closedAll = keys.reduce((s, k) => s + (live[k]?.trades || 0), 0);

    const card = (k) => {
      const e = ENGINE_REGISTRY[k], tier = ENGINE_TIER[k] || 'RESEARCH';
      const L = live[k], B = ENGINE_BACKTEST[k];
      const open = openBy[k] || 0;
      const n = L?.trades || 0;
      // THE SAMPLE GATE. Under 20 closed trades a win rate is a coin-flip
      // reading of a coin flipped a few times, and printing it as a percentage
      // is the single easiest way for this page to mislead.
      const measured = n >= 20;
      const rec = measured
        ? `<div class="ef-rec">
             <span class="ef-n"><b class="${dir(L.avg_r)}">${L.avg_r > 0 ? '+' : ''}${Number(L.avg_r).toFixed(3)}</b><em>R per trade</em></span>
             <span class="ef-n"><b>${Number(L.win_rate).toFixed(0)}%</b><em>win rate</em></span>
             <span class="ef-n"><b>${n}</b><em>closed</em></span>
           </div>
           <div class="ef-bar" role="img" aria-label="${Number(L.win_rate).toFixed(0)}% of ${n} closed trades were wins">
             <i style="width:${Math.max(2, Math.min(100, L.win_rate)).toFixed(0)}%"></i></div>`
        : `<p class="ef-thin">${n ? `Only <b>${n}</b> closed trade${n === 1 ? '' : 's'}.` : 'No closed trades yet.'}
             Not enough to measure — no win rate is shown, because one drawn from
             ${n || 'nothing'} would read as evidence.</p>`;
      const bt = B ? `<p class="ef-bt"><span class="ef-btk">BACKTEST</span>
             ${B.n} signals · <b class="${dir(B.exp)}">${B.exp > 0 ? '+' : ''}${B.exp.toFixed(3)}R</b>
             · ${B.win.toFixed(0)}% win · t=${B.t.toFixed(2)}
             <em>Not a live record. ${B.from} → ${B.to}, 149 liquid names.</em></p>` : '';
      return `<article class="ef-c" data-eng="${esc(k)}" role="button" tabindex="0"
                aria-label="${esc(e.name)} — ${esc(e.role)}. Open the rules.">
        <header class="ef-h">
          <span class="ef-dot ${open ? 'is-on' : ''}" aria-hidden="true"></span>
          <b class="ef-name">${esc(e.name)}</b>
          ${/* magic and magicmagic are ONE screen at two depths and share the
              name TIDAL, so the roster would otherwise show two identical
              cards. The band is what separates them and it belongs in the
              heading, not three lines down. */''}
          <span class="ef-role">${esc(e.band ? `${e.role} · ${e.band}` : e.role)}</span>
          <span class="ef-tier t-${esc(tier.toLowerCase())}">${esc(tier)}</span>
        </header>
        <p class="ef-hunts">${esc(e.hunts)}</p>
        <p class="ef-meta">${esc(e.tf)}${open ? ` · <b>${open}</b> open` : ''}</p>
        ${rec}${bt}
      </article>`;
    };

    paint(shell(
      snap([
        ['Engines', keys.length, 'on the floor'],
        ['Cleared for capital', cleared, cleared ? 'engines' : 'none of them', cleared ? 'up' : 'dn'],
        ['Open positions', totalOpen, 'being tracked'],
        ['Closed on record', closedAll, 'on rostered engines'],
      ]) +
      `<section class="ef-core">
        <div class="ef-core-in">
          <span class="ef-core-k">Swarm state</span>
          <p class="ef-core-t">${cleared === 0
            ? `<b>No engine is cleared for capital.</b> The bar is 30 or more closed
               trades at t≥2 and nothing on this floor has reached it. Everything
               below is published, tracked and honest about that.`
            : `<b>${cleared}</b> of ${keys.length} engines cleared for capital.`}</p>
          <p class="ef-core-s">Tap any engine for what makes it fire, where its stop
            comes from, and what would prove it wrong.</p>
        </div>
      </section>` +
      `<div class="ef-grid">${keys.map(card).join('')}</div>` +
      (() => {
        /* KEYS IN THE LEDGER THAT ARE NOT ON THIS FLOOR.
         * The roster is a whitelist — it is what the site publishes as an
         * engine. The ledger also carries rows from scans that are not on it
         * (commodity, intraday, bucket allocations). A page headed "every
         * engine" that silently showed nine of fourteen would be the same
         * omission this site exists not to make, so the difference is named
         * and counted. */
        const extra = Object.keys(live).filter(k => !ENGINE_REGISTRY[k] && (live[k].trades || 0) > 0);
        if (!extra.length) return '';
        const tot = extra.reduce((s, k) => s + live[k].trades, 0);
        const totR = extra.reduce((s, k) => s + (live[k].total_r || 0), 0);
        /* THEIR RECORDS TOO, NOT JUST THEIR NAMES.
         * Listing the keys and withholding what they did would be the more
         * comfortable half of the disclosure: `ohl` alone is 29 closed trades
         * at -0.602R. A page that names an engine but hides its result is
         * doing the thing this site exists not to do. */
        return `<div class="ef-extra">
          <p><b>${extra.length}</b> further keys appear in the ledger and are not on this
          floor, carrying <b>${tot}</b> closed trades between them for
          <b class="${dir(totR)}">${totR > 0 ? '+' : ''}${totR.toFixed(2)}R</b>. They are
          commodity, intraday and allocation scans rather than published equity engines,
          so they are recorded but not rostered — and they are in the ledger's totals.</p>
          <div class="ef-ex-l">${extra.map(k => {
            const x = live[k];
            return `<span><code>${esc(k)}</code>
              ${x.trades >= 20
                ? `<b class="${dir(x.avg_r)}">${x.avg_r > 0 ? '+' : ''}${Number(x.avg_r).toFixed(3)}R</b>
                   <em>${x.trades} closed · ${Number(x.win_rate).toFixed(0)}% win</em>`
                : `<em>${x.trades} closed — too few to measure</em>`}</span>`;
          }).join('')}</div></div>`;
      })() +
      `<p class="hint ef-foot">Live records are this book's own closed signals since
         2026-08-03 and include every loss. The counter above is closed trades on the
         <b>rostered</b> engines; the ledger's own total is higher because it also holds
         the unrostered keys listed above. Backtested records are marked as such and
         are not evidence of a live edge — the universe they are measured on is the
         750 names screened today, so companies that collapsed and dropped out are
         missing, which flatters every long-only result.
         <a href="/methodology">How every number here is made →</a></p>`
    ));

    const openEngine = (k) => {
      const e = ENGINE_REGISTRY[k], r = ENGINE_RULES[k] || {}, tier = ENGINE_TIER[k] || 'RESEARCH';
      const L = live[k], B = ENGINE_BACKTEST[k];
      const n = L?.trades || 0;
      sheet(`${esc(e.name)} <small>${esc(e.role)}</small>`, `
        <p class="sh-lead">${esc(e.hunts)}</p>
        <div class="yoy">
          <div class="yy"><span>Status</span><b class="ef-tier t-${esc(tier.toLowerCase())}">${esc(tier)}</b></div>
          <div class="yy"><span>Horizon</span><b>${esc(e.tf)}</b></div>
          ${e.band ? `<div class="yy"><span>Band</span><b>${esc(e.band)}</b></div>` : ''}
          <div class="yy"><span>Ledger key</span><b><code>${esc(k)}</code></b></div>
        </div>
        <h4 class="sh">What makes it fire</h4>
        ${(r.triggers || []).length
          ? `<ul class="ef-rules">${r.triggers.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
          : `<p class="hint">The trigger conditions for this engine are not yet written
               down here. Rather than paraphrase them, this says so.</p>`}
        ${r.stop ? `<h4 class="sh">Where the stop comes from</h4><p class="ef-p">${esc(r.stop)}</p>` : ''}
        ${r.targets ? `<h4 class="sh">Where the targets come from</h4><p class="ef-p">${esc(r.targets)}</p>` : ''}
        ${r.wrong ? `<h4 class="sh">How it can be wrong</h4>
           <p class="ef-p ef-wrong">${esc(r.wrong)}</p>` : ''}
        ${r.fixed ? `<h4 class="sh">What was corrected</h4><p class="ef-p ef-fix">${esc(r.fixed)}</p>` : ''}
        <h4 class="sh">The record</h4>
        ${n >= 20 ? `<div class="yoy">
             <div class="yy"><span>Closed trades</span><b>${n}</b></div>
             <div class="yy"><span>Win rate</span><b>${Number(L.win_rate).toFixed(1)}%</b></div>
             <div class="yy"><span>Average R</span><b class="${dir(L.avg_r)}">${L.avg_r > 0 ? '+' : ''}${Number(L.avg_r).toFixed(3)}</b></div>
             <div class="yy"><span>Total R</span><b class="${dir(L.total_r)}">${L.total_r > 0 ? '+' : ''}${Number(L.total_r).toFixed(2)}</b></div>
           </div>`
          : `<p class="hint"><b>Insufficient evidence.</b> ${n
               ? `${n} closed trade${n === 1 ? '' : 's'} is`
               : 'No closed trades are'} not a sample. No win rate or expectancy is
             shown for this engine, because a figure drawn from it would be read as
             evidence and is not.</p>`}
        ${B ? `<h4 class="sh">Backtest — not a live record</h4>
           <div class="yoy">
             <div class="yy"><span>Signals</span><b>${B.n}</b></div>
             <div class="yy"><span>Expectancy</span><b class="${dir(B.exp)}">${B.exp > 0 ? '+' : ''}${B.exp.toFixed(3)}R</b></div>
             <div class="yy"><span>Win rate</span><b>${B.win.toFixed(1)}%</b></div>
             <div class="yy"><span>t-statistic</span><b>${B.t.toFixed(2)}</b></div>
             <div class="yy"><span>Profit factor</span><b>${B.pf.toFixed(2)}</b></div>
             <div class="yy"><span>Worst drawdown</span><b class="dn">${B.maxdd.toFixed(2)}R</b></div>
           </div>
           <p class="hint">Walk-forward over 149 liquid NSE names, ${B.from} → ${B.to}.
             Entry at the next bar's open, one position per name at a time, stop checked
             before target. <b>Survivorship bias is present</b>: the universe is the names
             screened today, so companies that collapsed and left it are missing.
             ${B.t >= 2 && B.n >= 30
               ? 'This clears the 30-trade t≥2 bar <b>in backtest only</b>, and has no live closed trades.'
               : 'This does <b>not</b> clear the 30-trade t≥2 bar.'}</p>` : ''}`);
    };
    main.querySelectorAll('.ef-c').forEach(el => {
      const go = () => openEngine(el.dataset.eng);
      el.addEventListener('click', go);
      el.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
      });
    });
  };

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
    paint(head(sym, 'Loading the card…', 'Company') + skel('sk-card', 3));

    if (!SCREEN) {
      const r0 = noteLadder(await get('/screen.json'));
      if (r0.ok) SCREEN = (r0.data.rows || []).filter(x => x && x.sym);
    }
    await loadInsti();
    const r = (SCREEN || []).find(x => x.sym === sym);
    if (!r) {
      paint(head(esc(sym), '', 'Company') + `<div class="empty">
        <b>${esc(sym)}</b> is not in the 750-name screen, so there is no card for it.
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

    paint(stockPage(r));
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

  const VERDICT_LOOK = {
    BUY:   ['up',   'Buy'],
    WAIT:  ['warn', 'Wait for entry'],
    WATCH: ['',     'Watch'],
    AVOID: ['dn',   'Avoid'],
  };
  const strengthWord = (s) => s == null ? 'Not scored'
    : s >= 75 ? 'Strong' : s >= 60 ? 'Firm' : s >= 45 ? 'Moderate' : s >= 30 ? 'Soft' : 'Weak';

  R['/radar'] = async () => {
    const shell = body => head('Signal radar',
      'What the market is doing, and which names are carrying it.', 'Radar') + body;
    paint(shell(`<div class="sk" style="height:420px"></div>`));

    if (!SCREEN) {
      const r0 = noteLadder(await get('/screen.json'));
      if (!r0.ok) { paint(shell(fail('The radar', r0.error))); return; }
      SCREEN = (r0.data.rows || []).filter(x => x && x.sym);
      RADAR_BREADTH = r0.data.breadth || null;
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
      }</div>`, `top 20 of ${ranked.length}`) +
      sec('Top signals', `<div class="rd-feed">${nodes.map((n, i) => radarRow(n, i)).join('')}</div>`,
          `${nodes.length} of ${ranked.length} scored`) +
      `<p class="hint rd-foot"><b>The score is a model, not a measurement.</b> It weights
        momentum 30, trend 30, volume 20 and institutional flow 20, over the screen's own
        fields; a name missing a component is scored on the rest rather than penalised.
        The verdict beside it (Buy / Wait / Watch / Avoid) is the screen's own reading and is
        not derived from this score. Names under ₹5 cr of daily turnover are excluded.
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
    return `<span class="rc-t"><b>${esc(r.sym)}</b>
        <i class="${dir(r.r1d)}">${pct(r.r1d)}</i></span>
      <span class="rc-v ${vcls}">${esc(vlabel)}</span>
      <span class="rc-b"><i style="width:${nd.score}%"></i></span>
      <span class="rc-m"><u>${nd.score}</u>
        ${sp ? `<svg class="rc-sp ${sp.up ? 'up' : 'dn'}" viewBox="0 0 74 22" aria-hidden="true">
                  <path class="rc-spa" d="${sp.area}"/><path class="rc-spl" d="${sp.d}"/></svg>`
             : `<em class="rc-nosp">no series</em>`}
        ${x && x.quality === 'complete' && x.insti_pp != null
          ? `<em class="rc-fii ${dir(x.insti_pp)}">${x.insti_pp > 0 ? '▲' : x.insti_pp < 0 ? '▼' : '·'}</em>` : ''}
      </span>`;
  };

  const radarRow = (nd, i) => {
    const r = nd.r, x = instiOf(r.sym);
    const v = (r.vd && r.vd.c) || '';
    const [vcls, vlabel] = VERDICT_LOOK[v] || ['', 'Not rated'];
    const p = nd.parts;
    const bar = (l, val) => `<span class="rd-p"><em>${esc(l)}</em>
      <i><b style="width:${val == null ? 0 : Math.round(val)}%"></b></i>
      <u>${val == null ? '—' : Math.round(val)}</u></span>`;
    return `<article class="rd-row" data-rsym="${esc(r.sym)}" role="button" tabindex="0">
      <span class="rd-rank">${i + 1}</span>
      <span class="rd-id"><b>${esc(r.sym)}</b><span>${esc(r.name || '')}</span>
        <em class="rd-v ${vcls}">${esc(vlabel)}</em></span>
      <span class="rd-px">${price(r.price)}<i class="${dir(r.r1d)}">${pct(r.r1d)}</i></span>
      <span class="rd-sc"><b>${nd.score}</b><em>${esc(strengthWord(nd.score))}</em></span>
      <span class="rd-parts">${bar('Trend', p.trend)}${bar('Momentum', p.momentum)}${bar('Volume', p.volume)}${bar('Institutional', p.institutional)}</span>
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
      const nd = (RADAR_NODES || []).find(n => n.r.sym === sym);
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
        main.querySelectorAll(`[data-rsym="${CSS.escape(sym)}"] .rc-nosp`).forEach(ph => {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', `rc-sp ${sp.up ? 'up' : 'dn'}`);
          svg.setAttribute('viewBox', '0 0 74 22');
          svg.setAttribute('aria-hidden', 'true');
          svg.innerHTML = `<path class="rc-spa" d="${sp.area}"/><path class="rc-spl" d="${sp.d}"/>`;
          ph.replaceWith(svg);
        });
      }
    })();
  };

  R['/methodology'] = async () => {
    paint(prose('How this works', 'Every number, and where it comes from.',
      'No figure on this site is produced by a model that cannot be re-run. This page is how each one is made.', `
      <h3>The screen</h3>
      <p>A universe of about 750 NSE names is rebuilt on a schedule. Each name carries price,
        moving averages, returns over one day to one year, RSI, ATR, a volume ratio and a set of
        fundamental fields where the filings support them. Every field on a company card comes
        from that build; nothing is computed in your browser.</p>

      <h3>The signals</h3>
      <p>Signals come from seven named engines. Each publishes an entry, a stop and one or
        two targets at the moment it fires, and those levels are never edited afterwards. A
        signal is a thesis with a defined invalidation. It is not a forecast.</p>
      <div class="roster">
        ${Object.entries(ENGINE_REGISTRY).map(([k, v]) => `<div class="roster-r">
          <div class="roster-h"><b>${esc(v.name)}</b><span>${esc(v.role)}</span>
            <code>${esc(k)}</code></div>
          ${v.band ? `<em>${esc(v.band)}</em>` : ''}
          <p>${esc(v.hunts)}</p>
        </div>`).join('')}
      </div>
      <p class="hint"><b>The names are what you read; the key is what the ledger stores.</b>
        Every signal ever filed carries its key, and renaming that column would orphan the
        record it is the primary key for — so the key never moves. TIDAL appears twice because
        <code>magic</code> and <code>magicmagic</code> are one screen run at two depths off the
        52-week high, which is what they have always been.</p>

      <h3>Institutional movement — FII and DII</h3>
      <p>Every listed company files a shareholding pattern with the exchange each quarter. The
        Screen reads that filing directly and reports two figures: holding by <b>foreign</b>
        institutions (FII/FPI) and by <b>domestic</b> institutions (DII — mutual funds, insurers,
        banks, pension funds). Neither is estimated and neither comes from a data vendor's
        summary; both are the categories in the company's own filing.</p>
      <p><b>Changes are in percentage points.</b> A holding that moves from 10% to 12% has risen
        <b>2.00 pp</b>. It has not risen 20%, and this site never states it that way. A move
        smaller than <b>0.25 pp</b> is treated as no change at all.</p>
      <p><b>Only consecutive quarters are compared.</b> This is the whole reason the figures can
        be trusted, and it is not automatic: the exchange's own feed mixes quarter-end filings
        with interim ones — a bonus issue, an open offer — and subtracting across them produces
        a number that looks exactly like a quarterly move and is not one. Interim filings are
        dropped, and where the previous quarter is missing the change is reported as
        <b>not measurable</b> rather than as zero. A company with no comparable quarter is
        excluded from the institutional filters instead of being counted as unchanged.</p>
      <p>Each name is classified from the two changes alone: both up is <b>accumulation</b>,
        both down is <b>distribution</b>, opposite directions is <b>rotation</b>, and one side
        moving while the other sits still is named for the side that moved. Most companies in
        most quarters are none of these, and are labelled as such.</p>
      <p>The <b>institutional strength score</b> (0–100) is the one figure here that is a model
        rather than a measurement: 40% this quarter's FII change, 30% the DII change, 20% how
        many consecutive quarters the combined holding has moved one way, 10% whether the move
        is speeding up. Each input is capped before weighting, so a single outsized quarter
        cannot carry the score. It is shown with every input printed beside it, and never
        without the raw percentages. It ranks names; it does not value them.</p>
      <p class="hint">Shareholding is filed quarterly, within 21 days of the quarter end — so
        this data is <b>weeks to months old by design</b>, and is the slowest-moving thing on
        this site. It says who owned the company at a date in the past. It does not say who is
        buying it today.</p>

      <h3>The confidence score</h3>
      <p>Five components — structure, momentum, trend, volume and reward-to-risk — each scored
        from the screen's own fields against a fixed range, then averaged. <b>A component with
        no data is left out of the mean rather than filled in</b>, which is why the denominator
        on a brief is sometimes four rather than five. The brief shows every component, its
        score and the rule behind it.</p>

      <h3>Reward to risk</h3>
      <p>Measured from the published levels: the distance from entry to target divided by the
        distance from entry to stop. It is shown against <b>both</b> targets, because they are
        different numbers. The ledger's own <code>rr</code> field is measured to target 2; where
        it disagrees with the arithmetic on its own levels, the brief says so and shows the
        arithmetic.</p>

      <h3>Position sizing</h3>
      <p>Risk amount divided by the distance from entry to stop, rounded down to whole shares.
        That is all it is. It takes no account of your other positions, of liquidity in the
        name, or of what you can afford to lose.</p>

      <h3>The record</h3>
      <p>Every closed signal is scored in <b>R</b> — multiples of the risk originally taken. A
        trade stopped out is −1R. Expectancy is the mean R across closed trades. Open signals
        are excluded from every performance figure, because a position that has not closed has
        no result yet, only a mark.</p>
      <p>The ledger has been re-graded twice after grading defects were found, and both
        re-grades moved the published numbers <b>down</b>. That history is kept rather than
        quietly corrected.</p>

      <h3>What is not measured</h3>
      <p>There is no open-high-low-close feed here, so there are no candlesticks, no wicks, no
        VWAP and no intraday charts. Where a chart is drawn it is drawn from closing prices and
        says so. Scenario probabilities are not published because no model here computes one;
        the ledger's base rate over all closed trades is shown instead, and it describes the
        engine's history rather than any single trade.</p>

      <p class="prose-note">Anything this site cannot measure prints <b>Not measured</b>. That is
        a deliberate state, not a bug.</p>`));
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

      <h3>The ledger</h3>
      <p>Signals, levels, exits and results are this site's own records, written by its own
        engines, stored in its own database. They are the only data here that is not somebody
        else's.</p>

      <h3>Delay</h3>
      <p>Nothing on this site is real-time. Quotes are fetched when a page loads and refreshed
        about once a minute while it is open. Every price carries the time it was taken; the
        market board shows the exchange's own session window, so a closed market says so.</p>

      <p class="prose-note">If a source cannot be reached, the page shows that it could not be
        reached. It never carries the last value forward and never fills a gap with an estimate.</p>`));
  };

  R['/terms'] = async () => {
    paint(prose('Terms', 'What this is, and what it is not.',
      'Read this before acting on anything here.', `
      <div class="note err"><b>This is educational market-intelligence software. It is not
        investment advice.</b> Nothing here is a recommendation to buy or sell any security,
        and nothing here is personalised to your circumstances.</div>

      <h3>No advice, no recommendation</h3>
      <p>This site publishes what its engines computed and what its ledger recorded. It does not
        know your income, your goals, your existing positions or your risk tolerance, and it
        does not attempt to. A signal is a published thesis with a defined invalidation level.
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
    paint(prose('Privacy', 'What is stored, which is almost nothing.',
      'There are no accounts on this site, so there is very little to collect.', `
      <h3>No accounts</h3>
      <p>You cannot sign in, because there is nothing to sign in to. No profile, no password,
        no session, no tracking of what you looked at.</p>

      <h3>What your browser keeps</h3>
      <p>One item in local storage: your light or dark preference. It never leaves your device
        and this site cannot read it from anywhere else.</p>

      <h3>The one thing collected</h3>
      <p>If you ask for the morning brief, your email address is stored so it can be sent to
        you. It is used for that and nothing else — not sold, not shared, not used to profile
        you. Reply to any brief asking to be removed and the record is deleted.</p>

      <h3>Third parties</h3>
      <p>Fonts are served from this domain, not a font network. There is no analytics script, no
        advertising, no social pixel and no session recording. Price requests go to the data
        providers named on the <a href="/sources" style="color:var(--accent)">Data sources</a>
        page; those requests come from the server, not from your browser.</p>

      <h3>Logs</h3>
      <p>The host keeps ordinary request logs. They are not used to build a profile of you.</p>`));
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
      .filter(r => Number.isFinite(Number(r.r_multiple)) && (r.badge || '') !== 'open')
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
    const syms = watchAll();
    paint(head('Watchlist', 'Names you starred and price levels you asked to be told about.',
      'Yours, on this device') + skel('sk-row', 4));

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
      price, so they can only reach you while the site is open in a tab.</span></div>`;

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
          const n = Number(r[watchSort]);
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
    return '/';
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
    if (to === location.pathname) { render(); return; }
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
    '/':            ['Signal — Indian markets, every morning',
                     'Nifty breadth, sector heat, IPO books open now, ranked trade ideas and a public signal ledger. India’s markets in one screen, rebuilt before every open.'],
    '/markets':     ['Markets — the board, 71 instruments with a year of context',
                     'Indices, sectors, commodities and currencies on one board, each against its own 52-week range. Sector heat, breadth and what moved today.'],
    '/screen':      ['Screen — all 750 NSE names, filterable',
                     'Every name in the universe on price, trend, quality, value and institutional flow. FII and DII holding quarter on quarter, from the company’s own filings.'],
    '/signals':     ['Signals — the public ledger, wins and losses both',
                     'Every call this book has published, open and closed, with the entry, stop and targets it was sent with and what it actually did.'],
    '/radar':       ['Signal radar — the market, and the names carrying it',
                     'A breadth-based market score with every term printed, and the eight highest-scoring names ranked on trend, momentum, volume and institutional flow.'],
    '/engines':     ['The floor — every engine, what fires it, what it has done',
                     'Nine engines with their trigger conditions, where each stop comes from, how each can be wrong, and its measured record. Nothing is cleared for capital.'],
    '/ideas':       ['Ideas — this week’s multibaggers and what they were picked at',
                     'The weekly leadership screen, with the price each name was picked at and what it has done since.'],
    '/ipo':         ['IPO — books open now, and how last year’s listings did',
                     'Issues open and upcoming with demand, valuation and peer comparison, plus every recent listing measured against its issue price.'],
    '/news':        ['News — the wire, and the screened names each story touches',
                     'Market news filtered to what touches the 750-name screen, with the companies each story affects.'],
    '/funds':       ['Funds — SIP screen over AMFI NAV, Direct plans only',
                     'Mutual funds ranked on three- and five-year return against their own drawdown and volatility. Direct plans only, because the cost difference compounds.'],
    '/watch':       ['Watchlist — your names, sorted by what needs attention',
                     'The names you follow, ranked by what changed rather than alphabetically.'],
    '/brief':       ['Today’s brief — one setup, in full',
                     'The highest-scoring open signal, with every figure behind it: levels, evidence, what would invalidate it, and the engine’s own record.'],
    '/methodology': ['Methodology — how every number here is made',
                     'Every engine, every score, every stop and target rule, and the sample size behind each claim.'],
    '/sources':     ['Data sources — where each number comes from',
                     'The feed behind every figure on this site, and how fresh each one is.'],
    '/terms':       ['Terms', 'Terms of use for signal.askakshay.com.'],
    '/privacy':     ['Privacy', 'What this site stores, and what it does not.'],
    '/join':        ['The brief — every morning', 'One setup a day, in full, by email.'],
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
  };

  /* The route's own name, shown beside the brand. Empty on Today, because a
   * breadcrumb reading "Today" while you are looking at Today is noise. */
  const WHERE = { '/': '', '/markets': 'Markets', '/ideas': 'Ideas', '/ipo': 'IPO',
                  '/screen': 'Screen', '/signals': 'Signals', '/brief': 'Brief', '/watch': 'Watchlist',
                  '/engines': 'The floor', '/radar': 'Radar',
                  '/join': 'The brief', '/methodology': 'Methodology',
                  '/sources': 'Data sources', '/terms': 'Terms', '/privacy': 'Privacy' };

  async function render() {
    const path = routeOf();
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
    document.querySelectorAll('.tabs a').forEach(a =>
      a.dataset.route === path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
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

    flashChanged(before);
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
  function flashChanged(before) {
    if (!before || !before.size) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll(NUMSEL).forEach(c => {
      const k = numKey(c);
      if (!k || !before.has(k)) return;
      const was = before.get(k), now = c.textContent.trim();
      if (was === now) return;
      const a = numOf(was), b = numOf(now);
      c.classList.remove('chg-up', 'chg-dn', 'chg');
      // Force a reflow. Without it a cell that moves on two consecutive ticks
      // keeps the class it already had and sits still through the second one.
      void c.offsetWidth;
      c.classList.add(a != null && b != null && b !== a
        ? (b > a ? 'chg-up' : 'chg-dn') : 'chg');
      setTimeout(() => c.classList.remove('chg-up', 'chg-dn', 'chg'), 1500);
    });
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

  document.getElementById('themeBtn').addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', next === 'dark' ? '#0B0F14' : '#FFFFFF');
    try { localStorage.setItem('sig:theme', next); } catch (e) { /* private mode */ }
  });

  /* ── live clock, in MYT ────────────────────────────────────────────────
   * The header carried the EDITION date, which is the day the paper was
   * built — correct, and read as "the site is a day stale" every morning
   * between midnight MYT and the 6 AM build. A running clock says the page
   * is alive; the edition date moves to where it belongs, beside the data
   * that actually carries it. */
  const clockEl = document.getElementById('edition');
  function tickClock() {
    if (!clockEl) return;
    const t = new Date().toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const d = new Date().toLocaleDateString('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short' });
    clockEl.innerHTML = `<span class="clk-d">${d}</span><span class="clk-t">${t}</span><span class="clk-z">MYT</span>`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ── edition stamp and data health ─────────────────────────────────────── */
  paintFreshness();
  get('/edition.json').then(r => {
    if (r.ok && r.data && r.data.build_date) {
      document.getElementById('edition').textContent = r.data.build_date;
    }
  });

  render();
})();
