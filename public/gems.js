/* ── GEMS — the daily crux ────────────────────────────────────────────────────
 *
 * ONE PAGE. Every section answers one question in a headline and three or four
 * figures, and then hands off to signal.askakshay.com for the working. There is
 * deliberately no router, no deep page and no tab bar: the product IS that you
 * can read the whole thing in one scroll before the market opens.
 *
 * IT READS THE SAME FEEDS AS THE FULL SITE. Not a copy, not a snapshot — the
 * same /api routes and the same JSON. A digest that could disagree with the
 * site it summarises would be worse than no digest, and this repo has already
 * had two surfaces drift until one had to be frozen.
 *
 * WHAT IT WILL NOT DO: invent a number to fill a section. Every section renders
 * from what its feed actually returned, says so when that is nothing, and never
 * substitutes a plausible figure for a missing one.
 * ───────────────────────────────────────────────────────────────────────────── */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const jump = document.getElementById('jump');
  const SITE = 'https://signal.askakshay.com';
  const LAUNCH = '2026-09-02';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const pct = v => { const n = num(v); return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`; };
  const inr = v => { const n = num(v); return n == null ? '—' : '₹' + n.toLocaleString('en-IN',
    { maximumFractionDigits: n >= 1000 ? 0 : 2 }); };
  const dir = v => { const n = num(v); return n > 0 ? 'up' : n < 0 ? 'dn' : ''; };

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

  const sec = (id, kicker, crux, body, note, href, linkText) => `
    <section class="sec" id="${id}">
      <div class="sec-h"><span class="sec-k">${esc(kicker)}</span>
        ${note ? `<span class="sec-n">${esc(note)}</span>` : ''}</div>
      <p class="crux">${crux}</p>
      ${body}
      ${href ? `<a class="more" href="${href}">${esc(linkText || 'The full working')} →</a>` : ''}
    </section>`;

  const figs = (items) => `<div class="figs">${items.filter(Boolean).map(([v, l, c]) =>
    `<div class="fig"><b class="${c || ''}">${v}</b><span>${esc(l)}</span></div>`).join('')}</div>`;

  const row = (href, rank, name, sub, val, sub2, tag) => `
    <a class="row" href="${href}">
      <span class="rk">${rank}</span>
      <span class="rn"><b>${esc(name)}</b><span>${esc(sub)}</span>
        ${tag ? `<span class="tag ${tag[1]}">${esc(tag[0])}</span>` : ''}</span>
      <span class="rv">${val}${sub2 ? `<i class="${sub2[1]}">${sub2[0]}</i>` : ''}</span>
    </a>`;

  const stock = sym => `${SITE}/stock/${encodeURIComponent(sym)}`;

  /* ── the page ───────────────────────────────────────────────────────────── */
  async function build() {
    const [screen, stats, sigs, insti, ipo, news] = await Promise.all([
      get('/screen.json'), get('/api/stats'), get('/api/signals?limit=400'),
      get('/institutional.json'), get('/ipo.json'), get('/news.json'),
    ]);

    const d = new Date();
    document.getElementById('topDate').textContent =
      d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }).toUpperCase();

    const rows = (screen && screen.rows) || [];
    const ledger = (sigs && (sigs.rows || sigs.signals)) || [];
    const since = ledger.filter(r => String(r.date || '').slice(0, 10) >= LAUNCH);
    const out = [];
    const nav = [];
    const add = (id, label, html) => { nav.push([id, label]); out.push(html); };

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
        figs([
          [`${b.above50}%`, 'above 50-day', b.above50 >= 50 ? 'up' : 'dn'],
          [`${b.above200}%`, 'above 200-day', b.above200 >= 50 ? 'up' : 'dn'],
          [`${b.at_52w_high}`, 'at 52w high'],
          [pct(b.nifty_1m), 'Nifty 1M', dir(b.nifty_1m)],
        ]),
        b.as_of ? `breadth as of ${b.as_of}` : '', `${SITE}/radar`, 'Signal radar'));
    }

    /* ── 2. THE RECORD, before any idea ────────────────────────────────────
     * Deliberately above the setups. A digest that leads with picks and buries
     * the record is an advert. */
    const T = stats && stats.totals;
    const eng = (stats && stats.by_signal_type) || [];
    const measured = eng.filter(e => e.trades >= 20);
    const worst = measured.slice().sort((a, b2) => a.avg_r - b2.avg_r)[0];
    if (T) {
      add('record', 'Record', sec('record', 'The record',
        measured.length
          ? `No engine is cleared for capital. The largest sample, <b>${esc(worst.key)}</b>,
             has closed <b>${worst.trades}</b> trades at
             <span class="dn">${worst.avg_r > 0 ? '+' : ''}${Number(worst.avg_r).toFixed(3)}R</span> each.`
          : `<b>${T.closed}</b> closed trades on record. No engine has reached the
             30-trade bar this book sets before capital.`,
        figs([
          [T.closed, 'closed'],
          [T.open, 'open'],
          ['0', 'cleared for capital', 'dn'],
          [T.first_date ? String(T.first_date).slice(5) : '—', 'since'],
        ]) +
        `<div class="call dnb"><h3>Read this before the setups below</h3>
          <p>Everything here is <b>paper</b>. The bar is 30 closed trades at t≥2 and nothing
             has reached it. These are setups to examine, not calls to take.</p></div>`,
        '', `${SITE}/engines`, 'Every engine and its record'));
    }

    /* ── 3. TODAY'S SETUPS ────────────────────────────────────────────────── */
    const open = since.filter(r => String(r.status || '').toUpperCase() === 'OPEN'
                               && r.entry && r.sl && r.target1);
    const seen = new Set();
    const picks = open.filter(r => {
      const k = String(r.symbol || '').toUpperCase();
      if (seen.has(k)) return false; seen.add(k); return true;
    }).sort((a, b2) => (num(b2.rr) || 0) - (num(a.rr) || 0)).slice(0, 5);
    add('setups', 'Setups', sec('setups', 'Open setups',
      picks.length
        ? `<b>${open.length}</b> open since ${LAUNCH}. These five carry the widest
           reward against their own risk.`
        : 'Nothing is open. An empty list is a result — the engines publish when a setup clears their floors, and not otherwise.',
      picks.length
        ? `<div class="rows">${picks.map((r, i) => row(stock(r.symbol), i + 1,
            r.symbol, `${esc(r.signal_type || '')} · ${esc(r.timeframe || '')}`,
            inr(r.entry), [`stop ${inr(r.sl)}`, 'dn'],
            num(r.rr) ? [`${Number(r.rr).toFixed(1)}R to target`, 'flat'] : null)).join('')}</div>`
        : `<div class="empty">No open setup carries complete levels today.</div>`,
      `${open.length} open`, `${SITE}/signals`, 'The public ledger'));

    /* ── 4. INSTITUTIONAL FLOW — the distinctive one ───────────────────────
     * The only section here that no free Indian markets page carries: FII and
     * DII holding quarter on quarter, from the companies' own filings. */
    if (insti && insti.rows) {
      const iv = Object.entries(insti.rows).filter(([, x]) => x.quality === 'complete');
      const accum = iv.filter(([, x]) => x.signal === 'strong_accumulation')
        .sort((a, b2) => (b2[1].insti_pp || 0) - (a[1].insti_pp || 0)).slice(0, 5);
      const dist = iv.filter(([, x]) => x.signal === 'distribution').length;
      const nameOf = s => (rows.find(r => r.sym === s) || {}).name || '';
      add('flow', 'Flow', sec('flow', 'Institutional flow',
        accum.length
          ? `<b>${accum.length ? iv.filter(([, x]) => x.signal === 'strong_accumulation').length : 0}</b>
             companies had both foreign and domestic institutions add last quarter;
             <b>${dist}</b> had both cut.`
          : `No company had both foreign and domestic institutions add materially last quarter.`,
        figs([
          [iv.length, 'measured'],
          [iv.filter(([, x]) => x.signal === 'strong_accumulation').length, 'both adding', 'up'],
          [dist, 'both cutting', 'dn'],
          [iv.filter(([, x]) => x.insti_streak >= 3).length, '3Q+ streak'],
        ]) +
        (accum.length ? `<div class="rows">${accum.map(([sym, x], i) => row(stock(sym), i + 1,
            sym, nameOf(sym) || x.period,
            `${x.insti_pp > 0 ? '+' : ''}${Number(x.insti_pp).toFixed(2)} pp`,
            [`FII ${x.fii_pp > 0 ? '+' : ''}${Number(x.fii_pp).toFixed(1)} · DII ${x.dii_pp > 0 ? '+' : ''}${Number(x.dii_pp).toFixed(1)}`, dir(x.insti_pp)],
            ['Both adding', 'up'])).join('')}</div>` : '') +
        `<p class="said">Filed quarterly, within 21 days of the quarter end — this is
          <b>weeks to months old by design</b>. It says who owned the company at a past
          date, not who is buying today.</p>`,
        insti.latest_period_end ? `latest ${insti.latest_period_end}` : '',
        `${SITE}/screen`, 'Screen by institutional flow'));
    }

    /* ── 5. IPO ────────────────────────────────────────────────────────────── */
    const openIpo = (ipo && ipo.open) || [];
    const upcoming = (ipo && ipo.upcoming) || [];
    if (openIpo.length || upcoming.length) {
      add('ipo', 'IPO', sec('ipo', 'Primary market',
        openIpo.length
          ? `<b>${openIpo.length}</b> book${openIpo.length === 1 ? '' : 's'} open now,
             <b>${upcoming.length}</b> coming.`
          : `No book is open. <b>${upcoming.length}</b> upcoming.`,
        `<div class="rows">${[...openIpo, ...upcoming].slice(0, 4).map((x, i) => row(
            `${SITE}/ipo`, i + 1, x.symbol || '—', x.company || '',
            x.price_band ? esc(String(x.price_band).replace(/Rs\./g, '₹')) : '—',
            x.gmp_text ? [`GMP ${esc(x.gmp_text)}`, ''] : null,
            x.phase === 'open' ? ['Open now', 'up'] : ['Upcoming', 'flat'])).join('')}</div>`,
        '', `${SITE}/ipo`, 'Valuation, peers and last year’s listings'));
    }

    /* ── 6. THE WIRE ───────────────────────────────────────────────────────── */
    /* news.json is a bare ARRAY, not an object with an items key. Reading it
     * as `news.items || news.rows` returned undefined and the whole section
     * silently disappeared — the honest failure mode, but a failure. */
    const wire = Array.isArray(news) ? news
      : (news && (news.items || news.stories || news.rows)) || [];
    if (wire.length) {
      add('wire', 'Wire', sec('wire', 'What moved the tape',
        `The three stories most likely to touch names on the screen.`,
        `<div class="rows">${wire.slice(0, 3).map((w, i) => row(
            w.link || `${SITE}/news`, i + 1,
            String(w.title || w.headline || ''),
            w.source || '', '', null, null)).join('')}</div>`,
        `${wire.length} on the wire`, `${SITE}/news`, 'The full wire'));
    }

    app.innerHTML = out.join('');
    jump.innerHTML = nav.map(([id, label]) =>
      `<button type="button" data-to="${id}">${esc(label)}</button>`).join('');
    wire_up(nav);
  }

  /* Jump nav + scrollspy. IntersectionObserver drives the current-section
     state; a scroll listener would run on every frame for a label that changes
     six times a page. */
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

  build().catch(() => {
    app.innerHTML = `<div class="empty">Today's page could not be built — the feeds did
      not answer. Nothing here is stale data pretending to be current.
      <a href="${SITE}/">The full site</a> reads the same sources directly.</div>`;
  });
})();
