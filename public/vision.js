/* ── vision.js — the cockpit ────────────────────────────────────────────────
 *
 * vision.askakshay.com. Same Worker, same feeds and the same ledger as
 * signal.askakshay.com, arranged for scanning:
 *
 *     MARKET → SIGNAL → ASSET → REASON → CHART → ACTION
 *
 * WHAT THIS FILE WILL NOT DO
 *  - Invent a number. Every figure is read from a feed; a figure the feed does
 *    not carry renders as its absence, never as zero.
 *  - Compute its own record. The statistics and the move score are copied out
 *    of signal.js by scripts/verbatim.mjs and test/guard.mjs fails the build if
 *    the copy drifts, so the two sites cannot answer "how has this book done"
 *    differently.
 *  - Predict. The engine's score is labelled as the engine's own rating at
 *    filing; nothing here is a probability, target or forecast.
 *  - Phrase its own freshness in prose. Every panel carries one badge, drawn
 *    from the feed's own timestamp by fb().
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const ENGINE_BOOK = window.ENGINE_BOOK;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* RSS titles arrive entity-encoded ("S&amp;P"); decoded once so esc() does
     not print the entity itself. Only the five XML entities and numerics. */
  const dec = (s) => String(s == null ? '' : s).replace(/&(amp|lt|gt|quot|apos|#39|#x27|#\d+);/g, (m, k) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" }[k] || (k[0] === '#' ? String.fromCharCode(+k.slice(1)) : m)));
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const bare = (s) => String(s || '').toUpperCase().trim().replace(/\.NS$/, '');

  /* ── STORAGE — every read and write can throw (private mode, blocked site
     data), and none of it may take the page down. */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* per-viewer convenience only */ } },
  };

  /* ── FORMAT ─────────────────────────────────────────────────────────────
     NA is a dash WITH a reason on hover: in a dense table the word would cost
     a column, but a bare dash cannot say whether it means zero or unknown. */
  const NA = '<span class="na" title="Not in the feed">—</span>';
  const fmt = (v, dp = 2) => v == null ? null
    : Number(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const inr = (v, dp) => {
    const n = num(v); if (n == null) return NA;
    const d = dp != null ? dp : (Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 100 ? 1 : 2);
    return `<span class="num">₹${fmt(n, d)}</span>`;
  };
  const plain = (v, dp = 1) => { const n = num(v); return n == null ? NA : `<span class="num">${fmt(n, dp)}</span>`; };
  const signed = (v, dp = 2, unit = '%') => {
    const n = num(v); if (n == null) return null;
    const r = Number(n.toFixed(dp));        // the sign of what is PRINTED: no "+0.0"
    return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(dp)}${unit}`;
  };
  /* Direction is sign + glyph + hue — never hue alone. */
  const chg = (v, dp = 2, unit = '%') => {
    const n = num(v); if (n == null) return NA;
    const eps = 0.5 * Math.pow(10, -dp);   // a move that rounds to zero is printed flat, not ▲ +0.0
    const c = n >= eps ? 'up' : n <= -eps ? 'dn' : 'flat';
    return `<span class="chg ${c}">${signed(n, dp, unit)}</span>`;
  };
  const cr = (v) => { const n = num(v); return n == null ? NA : `<span class="num">₹${fmt(n, n >= 100 ? 0 : 1)} cr</span>`; };
  const fmtR = (v) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Number(v)).toFixed(2)}R`;

  /* IST, because every date in the ledger is an Indian trading date. */
  const istToday = () => { try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); } catch (e) { return new Date().toISOString().slice(0, 10); } };
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const ageOf = (ms) => {
    if (!(ms >= 0)) return null;
    const m = ms / 60000;
    if (m < 1) return 'now';
    if (m < 60) return `${Math.round(m)}m`;
    if (m < 60 * 36) return `${Math.round(m / 60)}h`;
    return `${Math.round(m / 1440)}d`;
  };
  const dshort = (d) => { const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00Z'); return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—'; };

  /* ── DATA ─────────────────────────────────────────────────────────────── */
  const CACHE = new Map();
  async function get(url, ttl = 60000) {
    const hit = CACHE.get(url);
    if (hit && (hit.p || Date.now() - hit.t < ttl)) return hit.p || hit.v;
    const p = (async () => {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
        const txt = await r.text();
        let data;
        /* A feed the assets binding does not have comes back as HTML with a
           200. Parsing it is how a missing feed announces itself. */
        try { data = JSON.parse(txt); } catch (e) { return { ok: false, error: `${url} is not JSON (HTTP ${r.status})` }; }
        if (!r.ok) return { ok: false, error: (data && data.error) || `HTTP ${r.status}`, data };
        if (data && data.ok === false) return { ok: false, error: data.error || 'feed reported a failure', data };
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: e.name === 'AbortError' ? 'timed out after 15s' : String(e.message || e) };
      } finally { clearTimeout(to); }
    })();
    CACHE.set(url, { p, t: Date.now() });
    const v = await p;
    CACHE.set(url, { v, t: Date.now() });
    return v;
  }

  /* ── FRESHNESS ──────────────────────────────────────────────────────────
     One registry. A badge is drawn from the feed's OWN timestamp and a stated
     cadence; "stale" means older than that cadence allows, and the badge
     prints the age either way so the reader never has to trust the word. */
  const FR = {};
  const CADENCE_H = {
    'Live prices': 0.5, 'Ledger': 2, 'Screen': 72, 'Pulse': 72,
    'Barometer': 72, 'Regime': 72, 'Wire': 3, 'Flows': 72,
    'Institutional': 24 * 120, 'Quotes': 0.5, 'Data health': 36,
  };
  const mark = (name, at, extra) => { FR[name] = Object.assign({ at, ok: true, t: Date.now() }, extra || {}); paintBadges(); };
  const markFail = (name, error) => { FR[name] = { ok: false, error, t: Date.now() }; paintBadges(); };
  const badgeState = (name) => {
    const f = FR[name];
    if (!f) return { cls: '', txt: 'loading', title: `${name}: loading` };
    if (!f.ok) return { cls: 'failed', txt: 'failed', title: `${name}: ${f.error || 'did not load'}` };
    if (f.na) return { cls: '', txt: 'nothing to price', title: `${name}: no symbol needed a quote` };
    const t = Date.parse(f.at);
    if (!Number.isFinite(t)) return { cls: 'stale', txt: 'undated', title: `${name}: the feed carries no timestamp` };
    /* A feed stamped with a DATE only says which session it describes, not
       when it was built — so the badge prints the date, not an hour count
       that would be invented. */
    if (f.dateOnly) {
      const d = dayDiff(String(f.at).slice(0, 10), istToday()), lim = Math.ceil((f.cad || CADENCE_H[name] || 24) / 24);
      return { cls: d > lim ? 'stale' : f.snap ? 'snap' : 'fresh', txt: `${f.snap ? 'snapshot · ' : ''}${d <= 0 ? 'today' : d === 1 ? 'yesterday' : dshort(f.at)}`,
        title: `${name}: built for ${f.at}${d > lim ? ` — older than its ${lim}-day cadence` : ''}` };
    }
    const age = Math.max(0, Date.now() - t);
    const h = f.cad || CADENCE_H[name] || 24;
    const snap = !!f.snap;
    const cls = age > h * 3600e3 ? 'stale' : snap ? 'snap' : (h <= 0.5 ? 'live' : 'fresh');
    const when = new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    return { cls, txt: `${f.word || (snap ? 'snapshot' : '')}${f.word || snap ? ' · ' : ''}${ageOf(age)}`,
      title: `${name}: ${when} IST${cls === 'stale' ? ` — older than its ${h >= 24 ? Math.round(h / 24) + '-day' : h + '-hour'} cadence` : ''}${f.note ? ' · ' + f.note : ''}` };
  };
  const fb = (name) => { const s = badgeState(name);
    return `<span class="fb ${s.cls}" data-fb="${esc(name)}" title="${esc(s.title)}"><i></i>${esc(s.txt)}</span>`; };
  function paintBadges() {
    for (const el of $$('[data-fb]')) {
      const s = badgeState(el.dataset.fb);
      el.className = `fb ${s.cls}`; el.title = s.title; el.innerHTML = `<i></i>${esc(s.txt)}`;
    }
  }

  /* ── FEEDS ────────────────────────────────────────────────────────────── */
  const F = {};
  F.ticker = async (force) => {
    const r = await get('/api/ticker', force ? 0 : 55000);
    if (r.ok) mark('Live prices', r.data.fetched_at); else markFail('Live prices', r.error);
    return r;
  };
  /* The live ledger first and the build-time snapshot second, named
     differently so a reader comparing tabs knows which one they are on. */
  F.ledger = async () => {
    const live = await get('/api/signals?limit=400', 600000);
    if (live.ok && (live.data.signals || []).length) {
      mark('Ledger', live.data.generated_at);
      return { ok: true, rows: live.data.signals, live: true, graded: true };
    }
    const snap = await get('/alerts.json', 600000);
    if (!snap.ok) { markFail('Ledger', live.error || snap.error); return { ok: false, error: live.error || snap.error }; }
    const rows = Array.isArray(snap.data) ? snap.data : (snap.data.rows || []);
    const newest = rows.map((r) => String(r.date || '')).sort().pop();
    /* The snapshot's age is its newest row's date — the file carries no build
       stamp of its own, and today's date would claim a freshness it has not got. */
    mark('Ledger', newest || null, { snap: true, dateOnly: true, cad: 48, note: `build-time snapshot; live ledger unavailable: ${live.error || 'empty'}` });
    /* The snapshot is trimmed to the columns the old table read, and
       r_multiple is not one of them — so every closed trade in it LOOKS
       ungraded. A record computed from it would print "0 closed" over a
       ledger that has closed trades. `graded` lets every consumer refuse. */
    return { ok: true, rows, live: false, graded: rows.some((r) => r && 'r_multiple' in r) };
  };
  const dateFeed = (url, name, pick) => async () => {
    const r = await get(url, 600000);
    if (r.ok) mark(name, pick(r.data)); else markFail(name, r.error);
    return r;
  };
  F.pulse = async () => {
    const r = await get('/pulse.json', 600000);
    if (r.ok) mark('Pulse', r.data.built_on || null, { dateOnly: true }); else markFail('Pulse', r.error);
    return r;
  };
  F.baro = dateFeed('/barometer.json', 'Barometer', (d) => d.generated_at);
  F.regime = dateFeed('/regime.json', 'Regime', (d) => d.generated_at);
  F.flows = dateFeed('/api/flows', 'Flows', (d) => d.at);
  F.health = dateFeed('/data-health.json', 'Data health', (d) => d.generated_at);
  F.screen = async () => {
    const r = await get('/screen-lite.json', 3600e3);
    if (r.ok) {
      mark('Screen', r.data.built_at || r.data.generated_at, r.data.is_fallback ? { note: 'fallback build' } : null);
      if (!SCR) { SCR = {}; for (const x of r.data.rows || []) if (x && x.sym) SCR[x.sym] = x; }
    } else markFail('Screen', r.error);
    return r;
  };
  F.insti = async () => {
    const r = await get('/institutional.json', 3600e3);
    if (r.ok) { INSTI = r.data.rows || {}; mark('Institutional', r.data.generated_at); } else { INSTI = {}; markFail('Institutional', r.error); }
    return r;
  };
  const cleanStory = (x) => Object.assign({}, x, { title: dec(x.title), summary: x.summary ? dec(String(x.summary).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null });
  F.wire = async () => {
    const r = await get('/api/wire', 600000);
    if (r.ok && (r.data.stories || []).length) {
      mark('Wire', r.data.at, r.data.failed && r.data.failed.length ? { note: `${r.data.failed.length} source(s) did not answer` } : null);
      return { ok: true, stories: r.data.stories.map(cleanStory), live: true, failed: r.data.failed || [] };
    }
    const s = await get('/news.json', 600000);
    if (!s.ok) { markFail('Wire', r.error || s.error); return { ok: false, error: r.error || s.error }; }
    const ed = await get('/edition.json', 600000);
    mark('Wire', ed.ok ? ed.data.built_at : null, { snap: true, cad: 36, note: `build-time snapshot; live wire unavailable: ${r.error || 'empty'}` });
    return { ok: true, stories: (s.data || []).map((x) => cleanStory(Object.assign({ scope: null, at: null }, x))), live: false, failed: [] };
  };
  /* Live marks for arbitrary NSE symbols, 40 a request, chunked not truncated. */
  F.quotes = async (syms) => {
    const list = [...new Set((syms || []).map(bare).filter(Boolean))];
    if (!list.length) return {};
    const parts = [];
    for (let i = 0; i < list.length; i += 40) parts.push(list.slice(i, i + 40));
    const rs = await Promise.all(parts.map((b) => get('/api/signals?px=' + encodeURIComponent(b.join(',')), 45000)));
    const all = {};
    let at = null;
    for (const r of rs) if (r.ok && r.data.quotes) { Object.assign(all, r.data.quotes); at = r.data.at; }
    if (at) mark('Quotes', at); else if (rs.some((r) => !r.ok)) markFail('Quotes', (rs.find((r) => !r.ok) || {}).error);
    return all;
  };

  let SCR = null;      // sym → screen row
  let INSTI = null;    // sym → institutional row
  const instiOf = (sym) => (INSTI && INSTI[sym]) || null;

  /* ══ VERBATIM CORE BEGIN — generated by scripts/verbatim.mjs from signal.js. Do not edit. */
  const LAUNCH = ENGINE_BOOK.LAUNCH;
  const pubDay = r => String(r.alert_date || r.date || '').slice(0, 10);
  const sinceLaunch = r => pubDay(r) >= LAUNCH;
  const withdrawn = r => (r.badge || '').toLowerCase() === 'cancelled'
                      || String(r.status || '').toUpperCase() === 'CANCELLED';
  const isScored = r => r != null && r.r_multiple != null
    && Number.isFinite(Number(r.r_multiple))
    && (r.badge || '') !== 'open';
  const tStat = R => {
    const n = R.length;
    if (n < 2) return null;
    const m = R.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(R.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    if (!(sd > 0)) return null;
    return m / (sd / Math.sqrt(n));
  };
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
  const recordOf = rows => {
    const closed = rows.filter(isScored);
    if (!closed.length) return { trades: 0, wins: 0, losses: 0, win_rate: null,
                                 expectancy_r: null, t: null, p: null,
                                 ci: null, significant: false };
    const wins = closed.filter(r => Number(r.r_multiple) > 0).length;
    const sum = closed.reduce((a, r) => a + Number(r.r_multiple), 0);
    const R = closed.map(r => Number(r.r_multiple));
    const n = R.length, mean = sum / n;
    const t = tStat(R);
    const p = t == null ? null : tPValue(t, n - 1);
    
    let ci = null;
    if (n > 1) {
      const sd = Math.sqrt(R.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
      const se = sd / Math.sqrt(n);
      
      let lo = 0, hi = 100;
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        (tPValue(mid, n - 1) > 0.05) ? (lo = mid) : (hi = mid);
      }
      const crit = (lo + hi) / 2;
      ci = [Math.round((mean - crit * se) * 1000) / 1000,
            Math.round((mean + crit * se) * 1000) / 1000];
    }
    
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
    return { bucket, trades: n, wins, losses: n - wins,
             win_rate: Math.round(wins / n * 1000) / 10,
             expectancy_r: Math.round(mean * 1000) / 1000,
             t: t == null ? null : Math.round(t * 100) / 100,
             p: p == null ? null : p,
             ci,
             
             significant: !!(ci && (ci[1] < 0 || ci[0] > 0)) };
  };
  const ENGINES = new Set(ENGINE_BOOK.keys());
  const engineOk = r => ENGINES.has(String(r.signal_type || ''));
  const longOnly = r => String(r.action || 'BUY').toUpperCase() !== 'SELL';
  const band = (v, lo, hi) => {
    
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, ((n - lo) / (hi - lo)) * 100));
  };
  const avg = (xs) => {
    const v = xs.filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
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
    
    const institutional = x && x.quality === 'complete' && x.score != null ? x.score : null;
    return { trend, momentum, volume, institutional };
  };
  const RADAR_W = { momentum: 0.30, trend: 0.30, volume: 0.20, institutional: 0.20 };
  const radarPriority = (r, score, parts) => {
    const liq = band(Math.log10(Math.max(1, r.turnover_cr || 1)), 0.7, 3.2) ?? 0;
    const conf = Object.values(parts).filter(v => v != null).length / 4 * 100;
    return score * 0.62 + liq * 0.18 + conf * 0.20;
  };
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
  const radarScore = (parts) => {
    const live = Object.entries(parts).filter(([, v]) => v != null);
    if (live.length < 2) return null;             
    const w = live.reduce((s, [k]) => s + RADAR_W[k], 0);
    return Math.round(live.reduce((s, [k, v]) => s + RADAR_W[k] * v, 0) / w);
  };
  const strengthWord = (s) => s == null ? 'Not scored'
    : s >= 75 ? 'Strong' : s >= 60 ? 'Firm' : s >= 45 ? 'Moderate' : s >= 30 ? 'Soft' : 'Weak';
  /* ══ VERBATIM CORE END ══ */

  /* ── THE BOOK ───────────────────────────────────────────────────────────
     In the book = a live engine, long, rupee-quoted, published since launch,
     and not withdrawn. The same population signal.askakshay.com reports. */
  const inBook = (r) => ENGINE_BOOK.inBook(r) && !withdrawn(r);
  const engLabel = (k) => ENGINE_BOOK.label(k);
  const isOpen = (r) => String(r.badge || '').toLowerCase() === 'open'
    || (String(r.status || '').toUpperCase() === 'OPEN' && !isScored(r));
  const moveOf = (row) => {
    if (!row) return { parts: null, score: null };
    const parts = radarParts(row);
    return { parts, score: radarScore(parts) };
  };
  /* Where the live price sits against the plan. Long-only: the book files no
     shorts, and a SELL that reached here would be a bug upstream, so it says
     so rather than being read upside down. */
  const planState = (s, px) => {
    const e = num(s.entry), sl = num(s.sl), t1 = num(s.target1);
    if (String(s.action || 'BUY').toUpperCase() === 'SELL') return { k: 'na', t: 'Short — not in this book' };
    if (px == null) return { k: 'na', t: 'No live mark' };
    if (sl != null && px <= sl) return { k: 'dn', t: 'Stop breached' };
    if (t1 != null && px >= t1) return { k: 'up', t: 'Past T1' };
    if (e != null && px >= e) return { k: 'up', t: 'Above entry' };
    return { k: 'warn', t: 'Below entry' };
  };
  /* recordOf returns no buckets when nothing has closed — the one case where
     the other four still need counting. Same predicates, same order. */
  const bucketsOf = (rows) => {
    const rec = recordOf(rows);
    if (rec.bucket) return rec.bucket;
    const b = { closed: 0, open: 0, withdrawn: 0, expired: 0, other: 0 };
    for (const r of rows) {
      if (withdrawn(r)) b.withdrawn += 1;
      else if (String(r.status || '').toUpperCase() === 'EXPIRED') b.expired += 1;
      else if (String(r.status || '').toUpperCase() === 'OPEN' || String(r.badge || '').toLowerCase() === 'open') b.open += 1;
      else b.other += 1;
    }
    return b;
  };
  /* ── THE ENGINE'S SCORE, WHERE IT HAS ONE ──────────────────────────────
     Not every engine scores. LEDGE, BREACH and KEEL write score = 0 as a
     placeholder on every row, and VECTOR writes a rank statistic near 3 that
     is not on a 0–100 scale at all. Printed raw, the first reads as "rated
     zero" and the second as "rated 3 out of 100". So the scale is read from
     the ledger itself: an engine whose every row is 0 is UNSCORED, and one
     whose largest score is under 10 is ON ITS OWN SCALE. */
  let SCALE = null, SCALE_ROWS = null;
  const scaleOf = (k) => {
    const rows = (S.ledger && S.ledger.rows) || [];
    if (SCALE_ROWS !== rows) {
      SCALE_ROWS = rows; SCALE = {};
      const by = {};
      for (const r of rows) { const v = num(r.score); (by[r.signal_type] = by[r.signal_type] || []).push(v); }
      for (const [e, vs] of Object.entries(by)) {
        const real = vs.filter((v) => v != null && v !== 0);
        SCALE[e] = !real.length ? 'none' : Math.max(...real) < 10 ? 'own' : 'pct';
      }
    }
    return SCALE[k] || 'none';
  };
  const engScoreCell = (r) => {
    const sc = scaleOf(r.signal_type), v = num(r.score), nm = engLabel(r.signal_type);
    if (sc === 'none' || v == null) return `<span class="na" title="${esc(nm)} does not score its signals">unscored</span>`;
    if (sc === 'own') return `<span class="num mut" title="${esc(nm)}'s own rank statistic — not on a 0–100 scale, so not comparable with other engines">${fmt(v, 2)}*</span>`;
    return scoreCell(v, `${nm}'s own 0–100 rating at filing. Not a probability and not a forecast.`);
  };
  const engScoreText = (r) => { const sc = scaleOf(r.signal_type), v = num(r.score);
    return sc === 'none' || v == null ? 'unscored' : sc === 'own' ? `${fmt(v, 2)} (own scale)` : String(Math.round(v)); };
  const rrOf = (s) => {
    const e = num(s.entry), sl = num(s.sl), t1 = num(s.target1);
    if (e == null || sl == null || t1 == null || !(Math.abs(e - sl) > 0)) return num(s.rr);
    return Math.abs(t1 - e) / Math.abs(e - sl);
  };

  /* ── SHELL STATE ──────────────────────────────────────────────────────── */
  const S = {
    ledger: null, ticker: null, pulse: null, wire: null,
    quotes: {}, prevPx: {},
    watch: store.get('vis:watch', []),
    alerts: store.get('vis:alerts', []),
  };
  const saveWatch = () => { store.set('vis:watch', S.watch); paintStars(); };
  const watching = (sym) => S.watch.some((w) => w.s === bare(sym));
  const toggleWatch = (sym) => {
    const s = bare(sym); if (!s) return;
    if (watching(s)) { S.watch = S.watch.filter((w) => w.s !== s); toast(`${s} removed from watchlist`); }
    else { S.watch.push({ s, pin: false, added: istToday() }); toast(`${s} added to watchlist`); }
    saveWatch();
  };
  const STAR = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.3l-5.6 2.9 1.1-6.3L2.9 9.5l6.3-.9z"/></svg>';
  const STAR_O = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.3l-5.6 2.9 1.1-6.3L2.9 9.5l6.3-.9z"/></svg>';
  const star = (sym) => { const on = watching(sym);
    return `<button class="star" type="button" data-star="${esc(bare(sym))}" aria-pressed="${on}" aria-label="${on ? 'Remove' : 'Add'} ${esc(bare(sym))} ${on ? 'from' : 'to'} watchlist">${on ? STAR : STAR_O}</button>`; };
  function paintStars() {
    for (const b of $$('[data-star]')) {
      const on = watching(b.dataset.star);
      b.setAttribute('aria-pressed', on); b.innerHTML = on ? STAR : STAR_O;
      b.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${b.dataset.star} ${on ? 'from' : 'to'} watchlist`);
    }
  }

  /* ── SMALL RENDERERS ──────────────────────────────────────────────────── */
  const spark = (pts, w = 44, h = 14) => {
    const v = (pts || []).filter(Number.isFinite);
    if (v.length < 4) return '';
    const lo = Math.min(...v), hi = Math.max(...v), rg = (hi - lo) || 1, st = w / (v.length - 1);
    const d = v.map((x, i) => `${i ? 'L' : 'M'}${(i * st).toFixed(1)},${(h - 1 - ((x - lo) / rg) * (h - 2)).toFixed(1)}`).join('');
    const up = v[v.length - 1] >= v[0];
    return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(${up ? '--up' : '--dn'})" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  };
  const scoreCell = (v, title) => { const n = num(v);
    if (n == null) return `<span class="na" title="${esc(title || 'Not scored')}">—</span>`;
    return `<span class="sc" title="${esc(title || '')}"><b>${Math.round(n)}</b><span class="bar"><i style="width:${clamp(n, 0, 100)}%"></i></span></span>`; };
  /* Ten segments per factor. A missing factor is hatched, not empty: empty
     reads as a zero score, hatched reads as "not measured". */
  const FACTOR_WORD = { trend: 'Trend', momentum: 'Momentum', volume: 'Volume', institutional: 'Institutional' };
  const factors = (rows) => `<dl class="fac">${rows.map(([label, v, hint]) => {
    const n = num(v), on = n == null ? 0 : Math.round(clamp(n, 0, 100) / 10);
    return `<dt title="${esc(hint || '')}">${esc(label)}</dt><dd><div class="segs${n == null ? ' na' : ''}" role="img" aria-label="${esc(label)} ${n == null ? 'not measured' : Math.round(n) + ' of 100'}">${
      Array.from({ length: 10 }, (_, i) => `<i${i < on ? ' class="on"' : ''}></i>`).join('')}</div></dd><dd class="v${n == null ? ' na' : ''}">${n == null ? 'not measured' : Math.round(n)}</dd>`;
  }).join('')}</dl>`;
  const moveFactors = (parts) => factors(Object.keys(RADAR_W).map((k) => [FACTOR_WORD[k], parts ? parts[k] : null,
    `${Math.round(RADAR_W[k] * 100)}% of the move score`]));
  /* Entry, stop and targets to scale, with the live mark on the same axis. */
  const ladder = (s, px) => {
    const e = num(s.entry), sl = num(s.sl), ts = [s.target1, s.target2, s.target3].map(num).filter((x) => x != null);
    if (e == null || sl == null) return '<div class="lad"><span class="lb" style="left:50%;top:8px">no levels filed</span></div>';
    const pts = [e, sl, ...ts, px].filter((x) => x != null);
    let lo = Math.min(...pts), hi = Math.max(...pts); const pad = (hi - lo) * 0.06 || e * 0.02; lo -= pad; hi += pad;
    const at = (v) => ((v - lo) / (hi - lo) * 100).toFixed(2) + '%';
    const t1 = ts[0];
    return `<div class="lad" role="img" aria-label="Stop ${fmt(sl)}, entry ${fmt(e)}${t1 != null ? ', first target ' + fmt(t1) : ''}${px != null ? ', live ' + fmt(px) : ''}">
      <div class="rail"></div>
      <div class="risk" style="left:${at(Math.min(sl, e))};width:calc(${at(Math.max(sl, e))} - ${at(Math.min(sl, e))})"></div>
      ${t1 != null ? `<div class="rew" style="left:${at(Math.min(e, t1))};width:calc(${at(Math.max(e, t1))} - ${at(Math.min(e, t1))})"></div>` : ''}
      <i class="mk" style="left:${at(sl)}"></i><span class="lb" style="left:${at(sl)}">SL</span>
      <i class="mk e" style="left:${at(e)}"></i><span class="lb" style="left:${at(e)}">E</span>
      ${ts.map((t, i) => `<i class="mk" style="left:${at(t)}"></i><span class="lb" style="left:${at(t)}">T${i + 1}</span>`).join('')}
      ${px != null ? `<i class="px" style="left:${at(px)}" title="Live ${fmt(px)}"></i>` : ''}</div>`;
  };
  const skel = (n = 5, h) => h ? `<div class="sk" style="height:${h}px;margin:16px"></div>`
    : `<div class="pb">${Array.from({ length: n }, (_, i) => `<div class="sk sk-l" style="width:${92 - (i * 13) % 40}%"></div>`).join('')}</div>`;
  const failBox = (what, err, retry) => `<div class="st err"><b>${esc(what)} did not load</b>${esc(err || 'no answer')}
    ${retry ? `<br><button class="btn sm" type="button" data-retry>Retry</button>` : ''}</div>`;
  const empty = (title, body) => `<div class="st"><b>${esc(title)}</b>${body || ''}</div>`;
  const panel = (title, body, opts = {}) => `<section class="pn${opts.cls ? ' ' + opts.cls : ''}"${opts.id ? ` id="${opts.id}"` : ''}>
    <div class="ph"><h2>${esc(title)}</h2>${opts.n != null ? `<span class="n">${esc(opts.n)}</span>` : ''}<div class="ph-r">${opts.right || ''}${opts.fb ? fb(opts.fb) : ''}${opts.more ? `<a class="more" href="${opts.more}">${esc(opts.moreText || 'Open')} →</a>` : ''}</div></div>
    <div class="pb${opts.flush ? ' flush' : ''}"${opts.bodyId ? ` id="${opts.bodyId}"` : ''}>${body}</div>${opts.foot ? `<div class="pf">${opts.foot}</div>` : ''}</section>`;

  /* ── TOAST + LIVE REGION ──────────────────────────────────────────────── */
  let toastT = 0;
  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('aria-hidden', 'true'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on'); clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), 2400);
    announce(msg);
  }
  /* Cleared, then set on the next task: a region whose text is replaced in
     the same task is not announced by every screen reader. */
  let liveT = 0;
  function announce(msg) { const l = $('#live'); if (!l) return; l.textContent = ''; clearTimeout(liveT); liveT = setTimeout(() => { l.textContent = msg; }, 60); }

  /* ── ROUTES ─────────────────────────────────────────────────────────────
     Hash routes. The Worker maps the vision host's "/" to this one shell, so
     every route is a fragment — no route list to keep in step server-side. */
  const NAV = [
    ['overview', 'Overview', '#/'], ['markets', 'Markets', '#/markets'], ['signals', 'Signals', '#/signals'],
    ['screener', 'Screener', '#/screener'], ['heatmap', 'Heatmap', '#/heatmap'], ['news', 'News', '#/news'],
    ['watchlist', 'Watchlist', '#/watchlist'], ['alerts', 'Alerts', '#/alerts'], ['record', 'Record', '#/record'],
  ];
  const ICON = {
    overview: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/>',
    signals: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    heatmap: '<path d="M4 4h9v9H4zM15 4h5v5h-5zM15 11h5v9h-5zM4 15h9v5H4z"/>',
    watchlist: '<path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.3l-5.6 2.9 1.1-6.3L2.9 9.5l6.3-.9z"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  };
  const TABS = ['overview', 'signals', 'heatmap', 'watchlist'];
  const svgI = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  function paintNav(cur) {
    $('#nav').innerHTML = NAV.map(([k, t, h]) => `<a href="${h}"${k === cur ? ' aria-current="page"' : ''}>${t}</a>`).join('');
    $('#tabs').innerHTML = TABS.map((k) => { const n = NAV.find((x) => x[0] === k);
      return `<a href="${n[2]}"${k === cur ? ' aria-current="page"' : ''}>${svgI(k)}${n[1]}</a>`; }).join('')
      + `<button type="button" id="moreBtn"${TABS.includes(cur) ? '' : ' aria-current="page"'}>${svgI('more')}More</button>`;
    $('#moreBtn').onclick = openMore;
  }
  function openMore() {
    drawer('More', `<div class="more">${NAV.filter(([k]) => !TABS.includes(k)).map(([k, t, h]) =>
      `<a href="${h}"><b>${t}</b><span>${esc(BLURB[k] || '')}</span></a>`).join('')}
      <a href="#" data-act="theme"><b>Theme</b><span>Switch dark / light</span></a>
      <a href="#" data-act="search"><b>Search</b><span>Any symbol or page</span></a></div>`);
  }
  const BLURB = {
    markets: 'Indices, FX, commodities, crypto, flows', screener: 'Every name on the NSE screen',
    news: 'The wire, matched to names', alerts: 'Telegram and in-browser price alerts',
    record: 'How the published book has actually done',
  };

  /* ── TICKER ─────────────────────────────────────────────────────────────
     Missing instruments stay on the strip with a dash — a strip that closes
     up around a gap hides that the gap exists. */
  const STRIP = [['Nifty 50', 'NIFTY'], ['Sensex', 'SENSEX'], ['Bank Nifty', 'BANKNIFTY'], ['India VIX', 'VIX'],
    ['S&P 500', 'S&P 500'], ['Nasdaq', 'NASDAQ'], ['Nikkei 225', 'NIKKEI'], ['Gold', 'GOLD'], ['Crude WTI', 'WTI'],
    ['USD/INR', 'USD/INR'], ['BTC', 'BTC'], ['ETH', 'ETH']];
  const tickRows = () => {
    const m = {};
    for (const sg of (S.ticker && S.ticker.segments) || []) for (const it of sg.items || []) if (!m[it.name]) m[it.name] = it;
    return m;
  };
  function paintTicker() {
    const m = tickRows();
    const el = $('#tickIn');
    if (!S.ticker) { el.innerHTML = `<span class="tk tk-na">${FR['Live prices'] && !FR['Live prices'].ok ? 'Live prices unavailable — ' + esc(FR['Live prices'].error) : 'Loading live prices…'}</span>`; return; }
    el.innerHTML = STRIP.map(([n, lab]) => {
      const it = m[n];
      if (!it) return `<a class="tk" href="#/markets" title="${esc(n)}: not in this fetch"><b>${esc(lab)}</b><span class="tk-na">—</span></a>`;
      const prev = S.prevPx[n];
      const moved = prev != null && prev !== it.price_raw;
      S.prevPx[n] = it.price_raw;
      return `<a class="tk${moved ? ' flash' : ''}" href="#/markets" title="${esc(it.full_name || n)}${it.as_of ? ' · as of ' + new Date(it.as_of).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}${it.session ? ' · session ' + it.session : ''}">
        <b>${esc(lab)}</b><span class="num">${esc(it.price)}</span>${chg(it.change_pct)}${spark(it.trend)}</a>`;
    }).join('') + `<span class="tk-meta">${fb('Live prices')}</span>`;
  }

  /* ── DRAWER ─────────────────────────────────────────────────────────────
     A dialog: focus moves in, Tab stays in, Escape and the scrim close it,
     and focus returns to whatever opened it. */
  let drawerRet = null;
  function drawer(title, body, opts = {}) {
    closeLayer();
    drawerRet = document.activeElement;
    const L = $('#layer');
    L.innerHTML = `<div class="scrim" data-close></div><div class="drw" role="dialog" aria-modal="true" aria-labelledby="drwT">
      <div class="drw-h"><div style="min-width:0;flex:1"><h2 id="drwT">${title}</h2>${opts.sub ? `<div class="note">${opts.sub}</div>` : ''}</div>
      <button class="ibtn" type="button" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <div class="drw-b">${body}</div></div>`;
    requestAnimationFrame(() => { $('.scrim', L).classList.add('on'); $('.drw', L).classList.add('on'); $('.drw [data-close]', L).focus(); });
    document.body.style.overflow = 'hidden';
  }
  function closeLayer() {
    const L = $('#layer'); if (!L.innerHTML) return;
    L.innerHTML = ''; document.body.style.overflow = '';
    if (drawerRet && drawerRet.focus) try { drawerRet.focus({ preventScroll: true }); } catch (e) { /* gone */ }
    drawerRet = null;
  }
  const trapTab = (e) => {
    const box = $('#layer .drw, #layer .pal'); if (!box || e.key !== 'Tab') return;
    const f = $$('a[href],button:not([disabled]),input,select,[tabindex]:not([tabindex="-1"])', box).filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };

  /* ── COMMAND PALETTE ────────────────────────────────────────────────────
     Pages, actions and every symbol the book knows about. Symbols from the
     ledger and watchlist answer at once; the screen's ~1,000 names are loaded
     the first time the palette opens and join the results when they arrive. */
  let palSel = 0, palItems = [];
  function palIndex(q) {
    const Q = q.trim().toUpperCase(), out = [];
    const pages = NAV.map(([k, t, h]) => ({ k: 'Page', t, sub: BLURB[k] || '', go: h }));
    const acts = [
      { k: 'Action', t: 'Switch theme', sub: 'Dark / light', run: toggleTheme },
      { k: 'Action', t: 'Open signals only', sub: 'Signal Center', go: '#/signals' },
    ];
    if (!Q) return pages.concat(acts).concat(S.watch.slice(0, 6).map((w) => ({ k: 'Watch', t: w.s, sub: (SCR && SCR[w.s] && SCR[w.s].name) || '', go: '#/asset/' + w.s })));
    const seen = new Set();
    const addSym = (sym, name, k) => { if (seen.has(sym)) return; seen.add(sym);
      const sc = sym === Q ? 0 : sym.startsWith(Q) ? 1 : (name || '').toUpperCase().startsWith(Q) ? 2 : sym.includes(Q) ? 3 : (name || '').toUpperCase().includes(Q) ? 4 : 9;
      if (sc < 9) out.push({ k, t: sym, sub: name || '', go: '#/asset/' + sym, sc }); };
    for (const w of S.watch) addSym(w.s, SCR && SCR[w.s] && SCR[w.s].name, 'Watch');
    for (const r of (S.ledger && S.ledger.rows) || []) if (inBook(r) && isOpen(r)) addSym(bare(r.symbol), engLabel(r.signal_type) + ' · open signal', 'Signal');
    if (SCR) for (const s in SCR) addSym(s, SCR[s].name, 'Stock');
    for (const p of pages.concat(acts)) if (p.t.toUpperCase().includes(Q)) out.push(Object.assign({ sc: 5 }, p));
    for (const n of Object.keys(tickRows())) if (n.toUpperCase().includes(Q)) out.push({ k: 'Market', t: n, sub: 'Markets board', go: '#/markets', sc: 6 });
    return out.sort((a, b) => a.sc - b.sc || a.t.localeCompare(b.t)).slice(0, 40);
  }
  function openPalette() {
    closeLayer();
    drawerRet = document.activeElement;
    $('#layer').innerHTML = `<div class="scrim" data-close></div><div class="pal" role="dialog" aria-modal="true" aria-label="Search">
      <input id="palQ" type="text" role="combobox" aria-expanded="true" aria-controls="palL" aria-autocomplete="list" placeholder="Symbol, company or page…" autocomplete="off" spellcheck="false">
      <ul id="palL" role="listbox"></ul>
      <div class="pf"><span><span class="kbd">↑↓</span> move</span><span><span class="kbd">↵</span> open</span><span><span class="kbd">esc</span> close</span><span class="sp"></span><span id="palN"></span></div></div>`;
    const inp = $('#palQ');
    const paint = () => {
      palItems = palIndex(inp.value); palSel = clamp(palSel, 0, Math.max(0, palItems.length - 1));
      $('#palL').innerHTML = palItems.length ? palItems.map((it, i) => `<li id="po${i}" role="option" aria-selected="${i === palSel}" data-i="${i}">
        <span class="k">${esc(it.k)}</span><b>${esc(it.t)}</b><span>${esc(it.sub)}</span>${it.go && it.go.startsWith('#/asset/') ? `<span class="r">${star(it.t)}</span>` : ''}</li>`).join('')
        : `<li aria-disabled="true"><span>No match${SCR ? '' : ' yet — the full screen is still loading'}</span></li>`;
      inp.setAttribute('aria-activedescendant', palItems.length ? 'po' + palSel : '');
      $('#palN').textContent = SCR ? `${Object.keys(SCR).length.toLocaleString('en-IN')} names searchable` : 'loading the screen…';
      const sel = $('#po' + palSel); if (sel) sel.scrollIntoView({ block: 'nearest' });
    };
    const run = (it) => { if (!it) return; closeLayer(); if (it.run) it.run(); else if (it.go) location.hash = it.go; };
    inp.addEventListener('input', () => { palSel = 0; paint(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(palItems[palSel]); }
    });
    $('#palL').addEventListener('click', (e) => { if (e.target.closest('[data-star]')) return; const li = e.target.closest('[data-i]'); if (li) run(palItems[+li.dataset.i]); });
    paint();
    requestAnimationFrame(() => { $('.scrim').classList.add('on'); $('.pal').classList.add('on'); inp.focus(); });
    if (!SCR) F.screen().then(() => { if ($('#palQ') === inp) paint(); });
  }

  /* ── THEME ──────────────────────────────────────────────────────────────── */
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    store.set('vis:theme', next); try { localStorage.setItem('vis:theme', next); } catch (e) { /* ok */ }
    const tc = $('meta[name="theme-color"]'); if (tc) tc.content = next === 'light' ? '#F4F5F7' : '#07090D';
    toast(`${next === 'light' ? 'Light' : 'Dark'} theme`);
  }

  /* ── ROUTER ─────────────────────────────────────────────────────────────── */
  const V = {};
  let navTok = 0, cur = null;
  const route = () => {
    const raw = location.hash.replace(/^#\/?/, ''), qi = raw.indexOf('?');
    const h = decodeURIComponent(qi < 0 ? raw : raw.slice(0, qi));
    const [name, ...rest] = h.split('/');
    return { name: name || 'overview', arg: rest.join('/'), params: new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1)) };
  };
  async function render() {
    const { name, arg, params } = route();
    const tok = ++navTok;
    closeLayer();
    cur = { name, arg, tok, live: null };
    paintNav(NAV.some((n) => n[0] === name) ? name : (name === 'asset' ? '' : name));
    const main = $('#main');
    main.innerHTML = '';
    const view = document.createElement('div'); view.className = 'view'; main.appendChild(view);
    window.scrollTo(0, 0);
    const fn = V[name] || V.notfound;
    try {
      const live = await fn(view, arg, () => tok === navTok, params);
      if (tok === navTok) cur.live = live || null;
    } catch (e) {
      if (tok === navTok) view.innerHTML = failBox('This view', String(e && e.message || e));
      console.error(e);
    }
    paintStars(); paintBadges();
  }
  const setTitle = (t) => { document.title = t ? `${t} · Vision` : 'Vision — your market cockpit'; };
  const vhead = (eb, title, sub, right) => { setTitle(title);
    return `<div class="vhead"><div><span class="eb">${esc(eb)}</span><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right ? `<div class="vhead-r">${right}</div>` : ''}</div>`; };

  /* ── SHARED VIEW HELPERS ──────────────────────────────────────────────── */
  const tickLedger = () => (S.ticker && S.ticker.ledger) || {};
  /* The live mark for an NSE symbol: a px quote, else the ticker's ledger map.
     Never the screen's close — that is labelled separately where it is used. */
  const liveOf = (sym) => {
    const s = bare(sym), q = S.quotes[s] || tickLedger()[s];
    return q && Number.isFinite(q.price) ? { price: q.price, change_pct: num(q.change_pct) } : null;
  };
  const openBook = () => ((S.ledger && S.ledger.rows) || []).filter((r) => inBook(r) && isOpen(r))
    .sort((a, b) => pubDay(b).localeCompare(pubDay(a)) || (num(b.id) || 0) - (num(a.id) || 0));
  const openBySym = () => { const m = {}; for (const r of openBook()) { const s = bare(r.symbol); (m[s] = m[s] || []).push(r); } return m; };
  const ageDays = (r) => { const d = pubDay(r); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? dayDiff(d, istToday()) : null; };
  const trendWord = (r) => {
    if (!r || !r.price || !r.sma50 || !r.sma200) return null;
    const a50 = r.price > r.sma50, a200 = r.price > r.sma200;
    return a50 && a200 ? { k: 'up', t: 'Above 50 & 200d' } : a200 ? { k: 'warn', t: 'Above 200d only' }
      : a50 ? { k: 'warn', t: 'Above 50d only' } : { k: 'dn', t: 'Below 50 & 200d' };
  };
  const trendChip = (r) => { const t = trendWord(r); return t ? `<span class="chip ${t.k}">${t.t}</span>` : NA; };

  /* ── NEWS → NAMES ───────────────────────────────────────────────────────
     A story "touches" a name when its ticker, or the first distinctive word
     of the company name, appears in the headline or summary. Algorithmic and
     labelled as such: a mention is not a judgement that the story matters. */
  const STOP = new Set(('INDIA INDIAN BANK STATE NATIONAL GLOBAL CAPITAL POWER ENERGY FINANCE FINANCIAL MOTORS STEEL ' +
    'LIMITED LTD INDUSTRIES TECHNOLOGIES INFRA HOUSING GOLD SILVER OIL GAS UNITED NEW FIRST GREAT RELIANCE-FREE ' +
    'MARKET MARKETS SHARES STOCK STOCKS NIFTY SENSEX RBI SEBI THE AND FOR WITH CITY LIFE').split(' '));
  const newsIndex = (stories) => {
    const docs = (stories || []).map((s) => ' ' + String((s.title || '') + ' ' + (s.summary || '')).toUpperCase().replace(/&AMP;/g, '&').replace(/[^A-Z0-9&]+/g, ' ') + ' ');
    const memo = {};
    return (sym) => {
      const S0 = bare(sym); if (memo[S0]) return memo[S0];
      const keys = [];
      if (S0.length >= 3 && !STOP.has(S0)) keys.push(S0);
      const nm = SCR && SCR[S0] && SCR[S0].name;
      if (nm) { const w = nm.toUpperCase().replace(/[^A-Z0-9& ]+/g, ' ').split(/\s+/).find((x) => x.length >= 4 && !STOP.has(x)); if (w) keys.push(w); }
      const hits = [];
      docs.forEach((d, i) => { if (keys.some((k) => d.includes(' ' + k + ' '))) hits.push(stories[i]); });
      return (memo[S0] = hits);
    };
  };

  /* ── TREEMAP ────────────────────────────────────────────────────────────
     Squarified (Bruls, Huijing, van Wijk). Size is importance — turnover by
     default, because 22 of the screen's names including RELIANCE and TCS
     carry no market cap; colour is the move. Everything is positioned in
     pixels of the real container and redrawn when it resizes. */
  const worst = (row, s) => { const sum = row.reduce((a, r) => a + r.a, 0), mx = Math.max(...row.map((r) => r.a)), mn = Math.min(...row.map((r) => r.a));
    return Math.max(s * s * mx / (sum * sum), (sum * sum) / (s * s * mn)); };
  function squarify(items, x, y, w, h) {
    const out = [], total = items.reduce((s, i) => s + i.v, 0);
    if (!(total > 0) || w <= 0 || h <= 0) return out;
    const k = (w * h) / total;
    const rest = items.filter((i) => i.v > 0).sort((a, b) => b.v - a.v).map((i) => Object.assign({}, i, { a: i.v * k }));
    let row = [];
    const lay = () => {
      const sum = row.reduce((a, r) => a + r.a, 0);
      if (w >= h) { const cw = sum / h; let cy = y; for (const r of row) { const rh = r.a / cw; out.push(Object.assign(r, { x, y: cy, w: cw, h: rh })); cy += rh; } x += cw; w -= cw; }
      else { const rh = sum / w; let cx = x; for (const r of row) { const rw = r.a / rh; out.push(Object.assign(r, { x: cx, y, w: rw, h: rh })); cx += rw; } y += rh; h -= rh; }
      row = [];
    };
    while (rest.length) {
      const s = Math.min(w, h), c = rest[0];
      if (!row.length || worst(row.concat(c), s) <= worst(row, s)) { row.push(c); rest.shift(); } else lay();
    }
    if (row.length) lay();
    return out;
  }
  const HEAT_A = [0.16, 0.3, 0.46, 0.62, 0.8];
  const heatBg = (p, scale = 1) => {
    const n = num(p); if (n == null) return 'var(--panel-3)';
    const cut = [0.15, 1, 2, 3, 5].map((c) => c * scale), m = Math.abs(n);
    if (m < cut[0]) return 'rgba(var(--neutral-rgb),.18)';
    let i = 0; while (i < 4 && m >= cut[i + 1]) i++;
    return `rgba(var(${n > 0 ? '--up-rgb' : '--dn-rgb'}),${HEAT_A[i]})`;
  };
  const HEAT_SCALE = { r1d: 1, r1w: 2, r1m: 4 };
  const heatLegend = (key) => { const sc = HEAT_SCALE[key] || 1, cuts = [5, 3, 2, 1].map((c) => c * sc);
    return `<span class="hm-leg" aria-label="Colour scale">${cuts.map((c) => `<i style="background:${heatBg(-c - 0.01, sc)}" title="≤ −${c}%"></i>`).join('')}
      <i style="background:${heatBg(0, sc)}" title="flat"></i>${cuts.slice().reverse().map((c) => `<i style="background:${heatBg(c + 0.01, sc)}" title="≥ +${c}%"></i>`).join('')}
      <span style="margin-left:6px">▼ −${cuts[0]}% … +${cuts[0]}% ▲</span></span>`; };
  /* rows: screen rows. opts: {size:'turnover'|'mcap', color:'r1d'|'r1w'|'r1m', n, height, group} */
  function treemap(host, rows, opts) {
    const W = host.clientWidth || 800, H = opts.height;
    const sizeOf = (r) => opts.size === 'mcap' ? num(r.mcap_cr) : num(r.turnover_cr);
    const pool = rows.filter((r) => (sizeOf(r) || 0) > 0).sort((a, b) => sizeOf(b) - sizeOf(a)).slice(0, opts.n);
    const open = openBySym();
    let tiles = [], groups = [];
    if (opts.group !== false) {
      const by = {};
      for (const r of pool) (by[r.sector || 'Unclassified'] = by[r.sector || 'Unclassified'] || []).push(r);
      groups = squarify(Object.entries(by).map(([k, rs]) => ({ k, rs, v: rs.reduce((s, r) => s + sizeOf(r), 0) })), 0, 0, W, H);
      for (const g of groups) {
        const top = g.h > 40 && g.w > 60 ? 14 : 0;
        tiles = tiles.concat(squarify(g.rs.map((r) => ({ r, v: sizeOf(r) })), g.x, g.y + top, g.w, g.h - top));
      }
    } else tiles = squarify(pool.map((r) => ({ r, v: sizeOf(r) })), 0, 0, W, H);
    const sc = HEAT_SCALE[opts.color] || 1;
    host.style.height = H + 'px';
    host.innerHTML = groups.map((g) => `<div class="hm-g" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px">${g.h > 40 && g.w > 60 ? `<em>${esc(g.k)}</em>` : ''}</div>`).join('')
      + tiles.map((t) => { const r = t.r, v = r[opts.color], area = t.w * t.h;
        const cls = area < 1400 || t.w < 44 ? (area < 500 || t.w < 26 ? 'xs' : 'sm') : '';
        return `<a class="hm-t ${cls}" href="#/asset/${esc(r.sym)}" data-sym="${esc(r.sym)}" style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;background:${heatBg(v, sc)}"
          aria-label="${esc(r.sym)} ${v == null ? 'no move recorded' : signed(v)}${open[r.sym] ? ', open signal' : ''}"><b>${esc(r.sym)}${open[r.sym] ? ' ◆' : ''}</b><span>${v == null ? '—' : signed(v, 1)}</span></a>`; }).join('');
    return pool.length;
  }
  /* One tooltip element, shared. Mouse follows; keyboard focus anchors it to the tile. */
  function wireTips(host) {
    let tip = $('#tip'); if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    const show = (el, x, y) => {
      const r = SCR && SCR[el.dataset.sym]; if (!r) return;
      const mv = moveOf(r), op = openBySym()[r.sym];
      tip.innerHTML = `<b>${esc(r.sym)}</b><span class="mut">${esc(r.name || '')}</span><dl>
        <dt>Close</dt><dd>₹${fmt(r.price, 2) || '—'}</dd><dt>1D</dt><dd>${signed(r.r1d) || '—'}</dd><dt>1W</dt><dd>${signed(r.r1w) || '—'}</dd>
        <dt>1M</dt><dd>${signed(r.r1m) || '—'}</dd><dt>Turnover</dt><dd>${r.turnover_cr != null ? '₹' + fmt(r.turnover_cr, 0) + ' cr' : '—'}</dd>
        <dt>Move score</dt><dd>${mv.score == null ? 'not scored' : mv.score}</dd>${op ? `<dt>Open signal</dt><dd>${esc(engLabel(op[0].signal_type))}</dd>` : ''}</dl>`;
      const bx = Math.min(x + 14, innerWidth - 270), by = Math.min(y + 14, innerHeight - 200);
      tip.style.left = bx + 'px'; tip.style.top = by + 'px'; tip.classList.add('on');
    };
    host.addEventListener('mousemove', (e) => { const t = e.target.closest('.hm-t'); if (t) show(t, e.clientX, e.clientY); else tip.classList.remove('on'); });
    host.addEventListener('mouseleave', () => tip.classList.remove('on'));
    host.addEventListener('focusin', (e) => { const t = e.target.closest('.hm-t'); if (t) { const b = t.getBoundingClientRect(); show(t, b.left, b.bottom); } });
    host.addEventListener('focusout', () => tip.classList.remove('on'));
  }

  /* ── SIGNAL ROW + WHY ─────────────────────────────────────────────────── */
  const sigRow = (r) => {
    const s = bare(r.symbol), lv = liveOf(s), st = planState(r, lv && lv.price), age = ageDays(r);
    return `<div class="sig" role="button" tabindex="0" data-why="${esc(r.id != null ? r.id : s + '|' + pubDay(r))}" aria-label="${esc(s)}, ${esc(engLabel(r.signal_type))}, ${esc(st.t)}. Open the reason.">
      <div class="sig-id"><b>${esc(s)}</b>
        <span>${esc(engLabel(r.signal_type))} · ${esc(r.timeframe || '—')} · ${age == null ? '—' : age === 0 ? 'today' : age + 'd ago'}</span></div>
      <div class="sig-sc">${engScoreCell(r)}</div>
      ${ladder(r, lv && lv.price)}
      <div class="sig-st">${lv ? `<b>${inr(lv.price)}</b>` : ''}<span class="chip ${st.k}">${esc(st.t)}</span></div></div>`;
  };
  const findSig = (key) => ((S.ledger && S.ledger.rows) || []).find((r) => String(r.id) === key || bare(r.symbol) + '|' + pubDay(r) === key);
  async function openWhy(r) {
    const s = bare(r.symbol), md = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    const why = Array.isArray(md.why) ? md.why : (typeof md.why === 'string' ? [md.why] : []);
    const eng = ENGINE_BOOK.get(r.signal_type) || {};
    const lv = liveOf(s), st = planState(r, lv && lv.price), rr = rrOf(r);
    const e = num(r.entry), sl = num(r.sl);
    const riskPct = e && sl ? (e - sl) / e * 100 : null;
    const engRows = ((S.ledger && S.ledger.rows) || []).filter((x) => inBook(x) && x.signal_type === r.signal_type);
    const rec = S.ledger && S.ledger.graded ? recordOf(engRows) : null;
    const body = () => {
      const row = SCR && SCR[s], mv = moveOf(row);
      return `
      <div>${ladder(r, lv && lv.price)}
        <div class="kv">
          <div><em>Entry</em><b>${inr(r.entry)}</b></div><div><em>Stop</em><b>${inr(r.sl)}</b><small>${riskPct != null ? signed(-riskPct, 1) + ' from entry' : ''}</small></div>
          ${[r.target1, r.target2, r.target3].map((t, i) => t != null ? `<div><em>Target ${i + 1}</em><b>${inr(t)}</b><small>${e ? signed((t - e) / e * 100, 1) : ''}</small></div>` : '').join('')}
          <div><em>Reward : risk</em><b class="num">${rr != null ? rr.toFixed(2) : '—'}</b><small>to the first target</small></div>
          <div><em>Live</em><b>${lv ? inr(lv.price) : '<span class="na">no mark</span>'}</b><small>${esc(st.t)}</small></div>
          <div><em>Engine score</em><b class="num">${esc(engScoreText(r))}</b><small>${scaleOf(r.signal_type) === 'none' ? 'this engine does not score' : scaleOf(r.signal_type) === 'own' ? 'its own statistic, not 0–100' : "engine's own 0–100 rating, not a probability"}</small></div>
        </div></div>
      <div><h3>What fired it</h3>${why.length ? `<ul>${why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p class="note">Measured on the bar that fired, written into the ledger at filing.</p>`
        : `<p class="note">${esc(eng.name || engLabel(r.signal_type))} did not record per-trade reasons for this signal. What follows is the engine's standing rule — it describes every trade this engine files, not this one.</p>`}
        ${!why.length && eng.hunts ? `<div class="callout info" style="margin-top:8px"><b>${esc(engLabel(r.signal_type))} · ${esc(eng.role || '')}</b> — ${esc(eng.hunts)}</div>` : ''}
        ${md.invalidate ? `<p class="note" style="margin-top:8px"><b>Invalidated by:</b> ${esc(md.invalidate)}</p>` : ''}</div>
      <div><h3>How the name reads today</h3>${row ? moveFactors(mv.parts) + `<p class="note" style="margin-top:8px">Move score <b>${mv.score == null ? 'not scored' : mv.score}</b> — ${esc(strengthWord(mv.score))}. From the daily screen, not from the engine that filed this signal; missing components are left out of the mean, never scored zero.</p>`
        : SCR ? '<p class="note">This symbol is not on the NSE screen, so there is no move score for it.</p>' : skel(3)}</div>
      <div><h3>${esc(engLabel(r.signal_type))}'s record in this book</h3>${!rec ? '<p class="note">Not computable from the build-time snapshot, which carries no R multiples. The live ledger did not answer.</p>' : rec.trades ? `<div class="kv" style="margin-top:0">
          <div><em>Closed</em><b class="num">${rec.trades}</b><small>${rec.bucket.open} still open</small></div>
          <div><em>Win rate</em><b class="num">${rec.win_rate}%</b></div>
          <div><em>Expectancy</em><b class="num ${rec.expectancy_r > 0 ? 'up' : rec.expectancy_r < 0 ? 'dn' : ''}">${fmtR(rec.expectancy_r)}</b><small>per trade</small></div>
          <div><em>95% interval</em><b class="num" style="font-size:var(--t-md)">${esc(spreadTxt(rec))}</b><small>${rec.t == null ? 'not a measure of certainty' : rec.significant ? 'excludes zero' : 'includes zero'}</small></div></div>
          <p class="note" style="margin-top:8px">${rec.trades < 30 ? `${rec.trades} closed is short of the 30 this book requires before it trusts an engine. ` : ''}Published since ${esc(LAUNCH)}, long only, withdrawn setups excluded.</p>`
        : `<p class="note">No closed trade from this engine since launch (${esc(LAUNCH)}). Nothing to report yet — which is itself the answer.</p>`}</div>
      <div class="row wrap">
        <a class="btn pri" href="#/asset/${esc(s)}">Open ${esc(s)}</a>
        <button class="btn" type="button" data-star-btn="${esc(s)}">${watching(s) ? 'Watching' : 'Add to watchlist'}</button>
        <a class="btn" href="#/alerts?sym=${esc(s)}">Price alert</a>
        <a class="btn" href="https://www.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(s)}" target="_blank" rel="noopener">Chart ↗</a></div>`;
    };
    drawer(`${esc(s)} <span class="chip ${st.k}">${esc(st.t)}</span>`, body(),
      { sub: `${esc(engLabel(r.signal_type))} · ${esc(r.timeframe || '')} · filed ${esc(dshort(pubDay(r)))}${r.lifecycle_status ? ' · ' + esc(r.lifecycle_status) : ''}` });
    if (!SCR || !INSTI) { await Promise.all([SCR ? null : F.screen(), INSTI ? null : F.insti()]); const b = $('#layer .drw-b'); if (b) b.innerHTML = body(); }
  }

  /* ── OVERVIEW ─────────────────────────────────────────────────────────── */
  V.overview = async (el, arg, alive) => {
    setTitle('');
    const hero = store.get('vis:hero', true);
    el.innerHTML = `${hero ? `<div class="hero"><div><h1>Your market cockpit.</h1>
        <p>One screen from the state of the market to a single name and the reason it is on the list. Same ledger and feeds as signal.askakshay.com — nothing here is a forecast, and every number carries its age.</p>
        <div class="flow"><span>MARKET</span>→<span>SIGNAL</span>→<span>ASSET</span>→<span>REASON</span>→<span>CHART</span>→<span>ACTION</span></div></div>
        <button class="btn sm x" type="button" data-hero>Got it</button></div>` : ''}
      <div class="grid g-5-7">
        ${panel('Market pulse', skel(7), { bodyId: 'oPulse', fb: 'Barometer', more: '#/markets', moreText: 'Markets' })}
        ${panel('Signal radar', skel(6), { bodyId: 'oRadar', flush: true, fb: 'Ledger', more: '#/signals', moreText: 'Signal center', id: 'oRadarP' })}
      </div>
      <div style="height:var(--s-4)"></div>
      ${panel('Market heatmap', `<div class="hm" id="oHeat">${skel(0, 340)}</div><div id="oSect" style="margin-top:var(--s-3)"></div>`,
        { fb: 'Screen', more: '#/heatmap', moreText: 'Full heatmap', right: heatLegend('r1d') + ' ', foot: 'Top 150 names by turnover, grouped by sector. Size is turnover; colour is the last session\'s move. ◆ marks an open signal. Click a tile for the name.' })}
      <div style="height:var(--s-4)"></div>
      <div class="grid g-2">
        ${panel('Top movers', skel(8), { bodyId: 'oMov', flush: true, fb: 'Live prices', more: '#/markets', moreText: 'Markets' })}
        ${panel('Market intelligence', skel(8), { bodyId: 'oNews', flush: true, fb: 'Wire', more: '#/news', moreText: 'All news' })}
      </div>
      <div style="height:var(--s-4)"></div>
      ${panel('Watchlist', skel(4), { bodyId: 'oWatch', flush: true, more: '#/watchlist', moreText: 'Manage', fb: 'Quotes' })}`;
    const h = $('[data-hero]', el); if (h) h.onclick = () => { store.set('vis:hero', false); h.closest('.hero').remove(); };

    const paintPulse = async () => {
      const [b, rg, p, fl] = await Promise.all([F.baro(), F.regime(), F.pulse(), F.flows()]);
      if (!alive()) return;
      const box = $('#oPulse'); if (!box) return;
      if (!b.ok) { box.innerHTML = failBox('The market barometer', b.error); return; }
      const t = b.data.today || {}, cov = t.coverage || {}, tr = tickRows();
      const nifty = tr['Nifty 50'], vix = tr['India VIX'];
      const br = p.ok ? p.data.breadth : null;
      const f = fl.ok ? fl.data : null;
      /* Net flow only when BOTH sides answered — the endpoint adds a missing
         side as zero, which would print one side's number as the total. */
      const both = f && f.fii && f.dii && f.fii.net != null && f.dii.net != null;
      box.innerHTML = `<div class="pulse-h"><strong>${esc((t.band && t.band.t) || '—')}</strong>
          <span class="num" style="font-size:var(--t-xl)">${t.score != null ? t.score : '—'}<span class="mut">/100</span></span>
          <span class="sub">market barometer${cov.complete === false ? ` · <span class="warn">${cov.parts} of ${cov.parts_total} components</span>` : ''}</span></div>
        <div class="gauge" role="img" aria-label="Barometer ${t.score} of 100"><i style="left:${clamp(num(t.score) || 0, 0, 100)}%"></i></div>
        <div class="gauge-l"><span>0 · weak</span><span>50</span><span>strong · 100</span></div>
        <div class="kv">
          <div><em>Nifty 50</em><b>${nifty ? esc(nifty.price) : (t.nifty ? fmt(t.nifty, 0) : '—')}</b><small>${nifty ? chg(nifty.change_pct) + ' live' : 'at the barometer\'s build'}</small></div>
          <div><em>India VIX</em><b>${vix ? esc(vix.price) : (t.vix != null ? Number(t.vix).toFixed(2) : '—')}</b><small>${vix ? chg(vix.change_pct) + ' live' : 'at build'}</small></div>
          <div><em>Off the high</em><b>${t.drawdown_pct != null ? '−' + Number(t.drawdown_pct).toFixed(1) + '%' : '—'}</b><small>Nifty from its peak</small></div>
          <div><em>Above 200-day</em><b>${t.above_200dma_pct != null ? Number(t.above_200dma_pct).toFixed(1) + '%' : '—'}</b><small>of ${t.counted ? t.counted.toLocaleString('en-IN') : '—'} names</small></div>
          <div><em>FII + DII net</em><b>${both ? `<span class="${f.fii.net + f.dii.net >= 0 ? 'up' : 'dn'}">${signed(f.fii.net + f.dii.net, 0, '')}</span>` : '—'}</b><small>${both ? `₹ cr · ${esc(f.date || '')}` : f ? 'one side missing — not summed' : 'NSE did not answer'}</small></div>
        </div>
        ${(t.parts || []).length ? `<div style="margin-top:var(--s-4)"><div class="note" style="margin-bottom:var(--s-2)"><b>What the ${t.score} is made of</b> — weight in brackets</div>${factors(t.parts.map((q) => [`${q.label} (${q.weight})`, q.score, q.detail]))}</div>` : ''}
        ${br ? `<div style="margin-top:var(--s-4)"><div class="row"><span class="note"><b>Breadth, past week</b> — ${br.up} up · ${br.down} down of ${br.counted}</span><span class="sp"></span>${fb('Pulse')}</div>
          <div class="brd" role="img" aria-label="${br.up} advancing, ${br.down} declining over the week"><i class="a" style="flex:${br.up}"></i><i class="u" style="flex:${Math.max(0, br.counted - br.up - br.down)}"></i><i class="d" style="flex:${br.down}"></i></div></div>` : ''}
        ${rg.ok && rg.data.today ? `<p class="note" style="margin:var(--s-3) 0 0"><b>Volatility regime:</b> ${esc(rg.data.today.t)}${rg.data.run_days ? ` · ${rg.data.run_days} sessions` : ''}. A separate question from the barometer — how the index is moving, not how many names are.</p>` : ''}`;
    };

    const paintRadar = async () => {
      const L = await F.ledger(); if (!alive()) return;
      S.ledger = L.ok ? L : S.ledger;
      const box = $('#oRadar'); if (!box) return;
      if (!L.ok) { box.innerHTML = failBox('The ledger', L.error); return; }
      const rows = openBook();
      const today = istToday(), filedToday = rows.filter((r) => pubDay(r) === today).length;
      box.innerHTML = rows.length ? rows.slice(0, 7).map(sigRow).join('') : empty('No open signals in the book', 'Every engine is flat. That is a result, not an outage — the ledger answered.');
      const n = $('#oRadarP .ph .n') || document.createElement('span');
      n.className = 'n'; n.textContent = `${rows.length} open`; $('#oRadarP .ph h2').after(n);
      const pf = $('#oRadarP .pf') || document.createElement('div'); pf.className = 'pf';
      pf.innerHTML = `${filedToday} filed today${rows.length > 7 ? ` · showing the newest 7 of ${rows.length}` : ''}. The number is the <b>engine's own score</b> at filing where it keeps one — not a probability; some engines do not score. Tap a row for why it fired.`;
      $('#oRadarP').appendChild(pf);
    };

    const paintMovers = () => {
      const box = $('#oMov'); if (!box) return;
      const seg = (k) => ((S.ticker && S.ticker.segments) || []).find((x) => x.key === k);
      const g = seg('gainers'), l = seg('losers');
      const li = (it) => `<li><div class="l"><a href="#/asset/${esc(bare(it.name))}"><b>${esc(it.name)}</b></a><span>Nifty 50</span></div>${star(it.name)}<span class="num">${esc(it.price)}</span><span style="width:74px;text-align:right">${chg(it.change_pct)}</span></li>`;
      if (g || l) {
        box.innerHTML = `<ul class="lst">${(g ? g.items : []).map(li).join('') || '<li class="mut">No Nifty 50 name is up this session.</li>'}</ul>
          <div class="pf" style="border-top:1px solid var(--line)">Losers</div>
          <ul class="lst">${(l ? l.items : []).map(li).join('') || '<li class="mut">No Nifty 50 name is down this session.</li>'}</ul>`;
        return;
      }
      if (S.pulse) {
        const li2 = (r) => `<li><div class="l"><a href="#/asset/${esc(r.sym)}"><b>${esc(r.sym)}</b></a><span>${esc(r.name)}</span></div>${star(r.sym)}${inr(r.price)}<span style="width:74px;text-align:right">${chg(r.r1w)}</span></li>`;
        box.innerHTML = `<div class="callout" style="margin:var(--s-3) var(--s-4)">Live prices did not load, so these are the <b>week's</b> movers across the whole screen, from the last build.</div>
          <ul class="lst">${(S.pulse.movers_up || []).slice(0, 5).map(li2).join('')}</ul><div class="pf">Down the most</div><ul class="lst">${(S.pulse.movers_dn || []).slice(0, 5).map(li2).join('')}</ul>`;
        return;
      }
      box.innerHTML = failBox('Movers', (FR['Live prices'] || {}).error);
    };

    const paintNews = async () => {
      const W = await F.wire(); if (!alive()) return;
      S.wire = W.ok ? W : S.wire;
      const box = $('#oNews'); if (!box) return;
      if (!W.ok) { box.innerHTML = failBox('The wire', W.error); return; }
      const hit = newsIndex(W.stories), mine = new Set(S.watch.map((w) => w.s)), open = openBySym();
      const tags = (s) => { const t = [];
        for (const sym of new Set([...mine, ...Object.keys(open)])) if (hit(sym).includes(s)) t.push(sym);
        return t.slice(0, 3); };
      box.innerHTML = W.stories.slice(0, 7).map((s) => { const tg = tags(s);
        return `<a class="nw" href="${esc(s.link)}" target="_blank" rel="noopener"><b>${esc(s.title)}</b>
          <div class="meta"><span>${esc(s.source)}</span>${s.at ? `<span>· ${ageOf(Date.now() - Date.parse(s.at))} ago</span>` : ''}${s.scope ? `<span class="chip ghost">${s.scope === 'in' ? 'India' : 'Global'}</span>` : ''}
          ${tg.map((x) => `<span class="tag" title="Name match, algorithmic">◆ ${esc(x)}${open[x] ? ' · open signal' : ' · watchlist'}</span>`).join('')}</div></a>`; }).join('');
    };

    const paintHeat = async () => {
      const [r, p] = await Promise.all([F.screen(), F.pulse()]); if (!alive()) return;
      S.pulse = p.ok ? p.data : S.pulse;
      const host = $('#oHeat'); if (!host) return;
      if (!r.ok) { host.innerHTML = failBox('The screen', r.error); return; }
      const draw = () => treemap(host, Object.values(SCR), { size: 'turnover', color: 'r1d', n: 150, height: innerWidth < 760 ? 300 : 360 });
      draw(); wireTips(host);
      let w = host.clientWidth; new ResizeObserver(() => { if (Math.abs(host.clientWidth - w) > 8 && document.contains(host)) { w = host.clientWidth; draw(); } }).observe(host);
      const sd = p.ok ? (p.data.sectors_day || []) : [];
      const sb = $('#oSect');
      if (sb && sd.length) sb.innerHTML = `<div class="note" style="margin-bottom:6px"><b>Sectors today</b> — median move across the ${p.data.day_universe || ''} largest names, and how many rose</div>
        <div class="row wrap" style="gap:6px">${sd.map((s) => `<span class="chip" title="${s.up} of ${s.n} up">${esc(s.name)} ${chg(s.median)} <span class="mut">${s.up}/${s.n}</span></span>`).join('')}</div>`;
      if (!S.ticker) paintMovers();
    };

    const paintWatch = async () => {
      const box = $('#oWatch'); if (!box) return;
      box.innerHTML = await watchTable({ compact: true });
      if (!alive()) return;
    };

    el.addEventListener('click', (e) => { const w = e.target.closest('[data-why]'); if (w) { const r = findSig(w.dataset.why); if (r) openWhy(r); } });
    el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-why]')) { e.preventDefault(); e.target.click(); } });

    await Promise.all([paintPulse(), paintRadar(), paintNews(), paintHeat(), (async () => { await tickerP; paintMovers(); })()]);
    await refreshQuotes(); if (!alive()) return;
    await Promise.all([paintRadar(), paintWatch()]);
    return async () => { paintMovers(); await paintRadar(); await paintWatch(); };
  };

  /* ── SIGNAL CENTER ──────────────────────────────────────────────────────
     Every signal in the book: open, closed and the rest, in one table. The
     closed rows are the same population the record is computed from, so a
     reader can check the record against the rows that make it. */
  V.signals = async (el, arg, alive) => {
    const f = Object.assign({ view: 'open', eng: '', q: '' }, store.get('vis:sigf', {}));
    el.innerHTML = vhead('Signal center', 'Signals',
      'Every signal this book has published since launch — open ones marked to the live price, closed ones with the R they booked. Tap a row for why it fired.',
      fb('Ledger')) + `<div class="pn"><div class="ph" style="flex-wrap:wrap;gap:var(--s-2)">
        <div class="seg" role="group" aria-label="Show">${[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([k, t]) => `<button type="button" data-v="${k}" aria-pressed="${f.view === k}">${t}</button>`).join('')}</div>
        <select class="inp" id="sEng" aria-label="Engine" style="max-width:220px"><option value="">All engines</option></select>
        <input class="inp" id="sQ" type="search" placeholder="Filter symbol" aria-label="Filter by symbol" value="${esc(f.q)}" style="width:150px">
        <div class="ph-r"><span class="n" id="sN"></span></div></div>
        <div class="pb flush" id="sBody">${skel(8)}</div><div class="pf" id="sFoot"></div></div>`;
    const L = await F.ledger(); if (!alive()) return;
    if (!L.ok) { $('#sBody').innerHTML = failBox('The ledger', L.error); return; }
    S.ledger = L;
    const book = L.rows.filter(inBook);
    const engs = [...new Set(book.map((r) => r.signal_type))].sort((a, b) => engLabel(a).localeCompare(engLabel(b)));
    $('#sEng').innerHTML += engs.map((k) => `<option value="${esc(k)}"${f.eng === k ? ' selected' : ''}>${esc(engLabel(k))}</option>`).join('');
    const sortK = { k: 'date', d: -1 };
    const paint = () => {
      store.set('vis:sigf', f);
      let rows = book.filter((r) => (f.view === 'open' ? isOpen(r) : f.view === 'closed' ? isScored(r) : true)
        && (!f.eng || r.signal_type === f.eng) && (!f.q || bare(r.symbol).includes(f.q.toUpperCase())));
      const val = (r) => { const lv = liveOf(r.symbol);
        switch (sortK.k) {
          case 'sym': return bare(r.symbol); case 'score': return scaleOf(r.signal_type) === 'pct' ? num(r.score) ?? -1 : -1; case 'rr': return rrOf(r) ?? -1;
          case 'move': return lv && num(r.entry) ? (lv.price - r.entry) / r.entry : -1e9; case 'r': return num(r.r_multiple) ?? -1e9;
          default: return pubDay(r) + String(r.id).padStart(8, '0'); } };
      rows = rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * sortK.d; });
      $('#sN').textContent = `${rows.length} of ${book.length} in the book`;
      const th = (k, t, cls = '', tip = '') => `<th class="${cls}"${sortK.k === k ? ` aria-sort="${sortK.d > 0 ? 'ascending' : 'descending'}"` : ''} scope="col"${tip ? ` title="${esc(tip)}"` : ''}>${k ? `<button type="button" data-sort="${k}">${t}</button>` : t}</th>`;
      $('#sBody').innerHTML = rows.length ? `<div class="tw"><table class="tbl"><thead><tr>
          ${th('', '', '')}${th('sym', 'Symbol')}${th('', 'Dir')}${th('', 'Engine')}${th('', 'TF', 'hide-m')}
          ${th('score', 'Engine score', 'r', "The engine's own rating at filing, where it has one. Not a probability and not a forecast. LEDGE, BREACH and KEEL do not score; * marks an engine on its own scale.")}
          ${th('', 'Entry', 'r')}${th('', 'Stop', 'r hide-m')}${th('', 'T1', 'r hide-m')}${th('rr', 'R:R', 'r', 'Reward to the first target over risk to the stop')}
          ${th('move', f.view === 'closed' ? 'Exit' : 'Live', 'r')}${th(f.view === 'closed' ? 'r' : 'move', f.view === 'closed' ? 'R booked' : 'vs entry', 'r')}
          ${th('date', 'Age', 'r')}${th('', 'Status')}</tr></thead><tbody>${rows.map((r) => {
            const s = bare(r.symbol), closed = isScored(r), done = !closed && !isOpen(r), lv = done ? null : liveOf(s);
            const st = closed || done ? null : planState(r, lv && lv.price), age = ageDays(r);
            const vs = !closed && lv && num(r.entry) ? (lv.price - r.entry) / r.entry * 100 : null;
            return `<tr class="go" data-why="${esc(r.id != null ? r.id : s + '|' + pubDay(r))}" tabindex="0">
              <td>${star(s)}</td><td><a class="sym" href="#/asset/${esc(s)}">${esc(s)}</a></td>
              <td><span class="chip up" title="Long">▲ Long</span></td><td>${esc(engLabel(r.signal_type))}</td><td class="hide-m mut">${esc(r.timeframe || '—')}</td>
              <td class="r">${engScoreCell(r)}</td>
              <td class="r">${inr(r.entry)}</td><td class="r hide-m">${inr(r.sl)}</td><td class="r hide-m">${inr(r.target1)}</td>
              <td class="r num">${rrOf(r) != null ? rrOf(r).toFixed(2) : NA}</td>
              <td class="r">${closed || done ? inr(r.exit_price) : lv ? inr(lv.price) : '<span class="na" title="No live quote for this symbol">no mark</span>'}</td>
              <td class="r">${closed ? `<span class="chg ${r.r_multiple > 0 ? 'up' : r.r_multiple < 0 ? 'dn' : 'flat'}">${fmtR(num(r.r_multiple))}</span>` : done ? NA : chg(vs, 1)}</td>
              <td class="r mut">${age == null ? '—' : age + 'd'}</td>
              <td>${done ? `<span class="chip ghost" title="Closed, but this feed carries no graded R">${esc(String(r.badge || r.status || 'closed').toLowerCase())}</span>`
                : closed ? `<span class="chip ${r.r_multiple > 0 ? 'up' : 'dn'}">${esc(String(r.badge || r.status || '').toLowerCase() === 'expired' ? 'Time stop' : r.r_multiple > 0 ? 'Win' : 'Loss')}</span>`
                : `<span class="chip ${st.k}">${esc(st.t)}</span>`}</td></tr>`; }).join('')}</tbody></table></div>`
        : empty(f.view === 'open' ? 'No open signals match' : 'Nothing matches', f.eng || f.q ? 'Clear the filters to see the whole book.'
          : f.view === 'closed' && !L.graded ? 'The live ledger did not answer, and the snapshot standing in for it carries no R multiples — closed trades cannot be graded from it.' : '');
      const bk = bucketsOf(book);
      $('#sFoot').innerHTML = `The book since ${esc(LAUNCH)}: <b>${bk.open}</b> open · ${L.graded ? `<b>${bk.closed}</b> closed` : '<span class="warn">closed trades ungradable from the snapshot</span>'} · <b>${bk.expired}</b> expired · <b>${bk.withdrawn}</b> withdrawn · <b>${bk.other}</b> other.
        Long only; shorts and non-rupee instruments are published on news.askakshay.com, not filed here. <a href="#/record">How the book has done →</a>`;
    };
    paint();
    el.addEventListener('click', (e) => {
      const sb = e.target.closest('[data-sort]'); if (sb) { const k = sb.dataset.sort; sortK.d = sortK.k === k ? -sortK.d : -1; sortK.k = k; paint(); return; }
      const v = e.target.closest('[data-v]'); if (v) { f.view = v.dataset.v; $$('[data-v]', el).forEach((b) => b.setAttribute('aria-pressed', b === v)); paint(); return; }
      if (e.target.closest('a,button')) return;
      const w = e.target.closest('[data-why]'); if (w) { const r = findSig(w.dataset.why); if (r) openWhy(r); }
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-why]')) { const r = findSig(e.target.dataset.why); if (r) openWhy(r); } });
    $('#sEng').onchange = (e) => { f.eng = e.target.value; paint(); };
    $('#sQ').oninput = (e) => { f.q = e.target.value.trim(); paint(); };
    return paint;
  };

  /* ── ASSET ──────────────────────────────────────────────────────────────
     Everything the book knows about one name, in scan order: where it is,
     what the engines have said about it (all of it, losses included), why,
     the shape of its move, and what to do next. */
  V.asset = async (el, arg, alive) => {
    const s = bare(arg);
    if (!s) { location.hash = '#/screener'; return; }
    setTitle(s);
    el.innerHTML = `<div id="aHead">${skel(3)}</div><div style="height:var(--s-4)"></div>
      <div class="grid g-7-5"><div class="stack">
        ${panel('Signal history', skel(4), { bodyId: 'aSig', flush: true, fb: 'Ledger' })}
        ${panel('Why it reads the way it does', skel(5), { bodyId: 'aWhy', fb: 'Screen' })}
        ${panel('Move profile', skel(4), { bodyId: 'aChart', fb: 'Screen' })}
      </div><div class="stack">
        ${panel('Levels', skel(6), { bodyId: 'aLvl', fb: 'Screen' })}
        ${panel('Business', skel(6), { bodyId: 'aFun', fb: 'Screen' })}
        ${panel('Institutional holding', skel(4), { bodyId: 'aIns', fb: 'Institutional' })}
        ${panel('In the news', skel(3), { bodyId: 'aNews', flush: true, fb: 'Wire' })}
      </div></div>`;
    const [sr, , hist, q] = await Promise.all([F.screen(), F.insti(), get('/api/signals?symbol=' + encodeURIComponent(s) + '&limit=200', 600000), F.quotes([s])]);
    if (!alive()) return;
    Object.assign(S.quotes, q);
    const r = SCR && SCR[s], lv = liveOf(s), x = instiOf(s);
    if (!r && !(hist.ok && (hist.data.signals || []).length)) {
      $('#aHead').innerHTML = vhead('Asset', s, sr.ok ? `<b>${esc(s)}</b> is not on the NSE screen and has no signal in the ledger. Check the symbol — the screen covers ${Object.keys(SCR || {}).length.toLocaleString('en-IN')} names.` : 'The screen did not load, so this name cannot be looked up.');
      for (const id of ['aSig', 'aWhy', 'aChart', 'aLvl', 'aFun', 'aIns', 'aNews']) { const b = $('#' + id); if (b) b.closest('.pn').remove(); }
      return;
    }
    const px = lv ? lv.price : (r ? r.price : null);
    const mv = moveOf(r);
    const op = openBySym()[s] || [];
    const vd = r && r.vd;
    $('#aHead').innerHTML = `<div class="pn"><div class="pb"><div class="ah">
      <div style="min-width:0;flex:1"><span class="eb" style="display:block;font-size:var(--t-xs);font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)">${esc((r && r.sector) || 'Not on the screen')}${r && r.ind ? ' · ' + esc(r.ind) : ''}</span>
        <div class="row" style="gap:var(--s-2)"><h1>${esc(s)}</h1>${star(s)}</div><div class="nm">${esc((r && r.name) || '')}</div>
        <div class="row wrap" style="margin-top:var(--s-2)">${op.map((o) => `<button class="chip acc" type="button" data-why="${esc(o.id != null ? o.id : s + '|' + pubDay(o))}">◆ Open ${esc(engLabel(o.signal_type))} signal · why?</button>`).join('')}
          ${vd ? `<span class="chip ${vd.c === 'BUY' ? 'up' : vd.c === 'AVOID' ? 'dn' : ''}" title="The screen's own read at its build, not a recommendation">${esc(vd.c)} · ${esc(vd.o || vd.l || '')}</span>` : ''}
          ${r && r.risk ? `<span class="chip ${r.risk.level === 'HIGH' ? 'dn' : r.risk.level === 'MEDIUM' ? 'warn' : ''}">Risk ${esc(r.risk.level)}</span>` : ''}</div></div>
      <div style="text-align:right"><div class="px">${px != null ? '₹' + fmt(px, 2) : '—'}</div>
        <div class="px-s">${lv ? chg(lv.change_pct) + ' <span class="mut">live</span>' : r ? chg(r.r1d) + ` <span class="mut">close of ${esc(r.last_date || r.price_date || 'the last build')}</span>` : ''}</div>
        <div class="row" style="justify-content:flex-end;margin-top:var(--s-2);gap:6px">
          <a class="btn sm" href="#/alerts?sym=${esc(s)}">Alert</a>
          <a class="btn sm" href="https://www.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(s)}" target="_blank" rel="noopener">Chart ↗</a>
          <a class="btn sm" href="https://www.screener.in/company/${encodeURIComponent(s)}/consolidated/" target="_blank" rel="noopener">Filings ↗</a></div></div></div>
      ${r && r.high52 && r.low52 && r.high52 > r.low52 ? `<div style="margin-top:var(--s-4)"><div class="rng" role="img" aria-label="52-week range ${fmt(r.low52)} to ${fmt(r.high52)}"><i style="left:${clamp((px - r.low52) / (r.high52 - r.low52) * 100, 0, 100)}%"></i></div>
        <div class="rng-l"><span>52w low ₹${fmt(r.low52, 1)}</span><span>${r.from_high != null ? signed(r.from_high, 1) + ' from the high' : ''}</span><span>52w high ₹${fmt(r.high52, 1)}</span></div></div>`
      : r && r.rng_lo != null && r.rng_hi != null ? `<p class="note" style="margin-top:var(--s-3)">No 52-week range yet — ${r.rng_sessions || 'too few'} sessions of history. Its ${r.rng_sessions}-session range is ₹${fmt(r.rng_lo, 1)} – ₹${fmt(r.rng_hi, 1)}.</p>` : ''}
      </div></div>`;

    /* Signal history — every ledger row for the name, in the book or not, so
       nothing is cherry-picked. Rows outside the book say why. */
    const all = (hist.ok ? hist.data.signals : ((S.ledger && S.ledger.rows) || [])).filter((x2) => bare(x2.symbol) === s)
      .sort((a, b) => pubDay(b).localeCompare(pubDay(a)));
    const why = (x2) => withdrawn(x2) ? 'withdrawn' : !ENGINE_BOOK.ok(x2) ? (String(x2.action || '').toUpperCase() === 'SELL' ? 'short — not filed here' : 'engine not in this book') : !ENGINE_BOOK.sinceLaunch(x2) ? 'before launch' : '';
    $('#aSig').innerHTML = all.length ? `<div class="tw"><table class="tbl dense"><thead><tr><th scope="col">Filed</th><th scope="col">Engine</th><th class="r" scope="col">Entry</th><th class="r" scope="col">Stop</th><th class="r" scope="col">Exit</th><th class="r" scope="col">R</th><th scope="col">Outcome</th></tr></thead><tbody>
      ${all.map((x2) => { const w = why(x2); return `<tr${isOpen(x2) && !w ? ` class="go" data-why="${esc(x2.id != null ? x2.id : s + '|' + pubDay(x2))}"` : ''}><td class="num">${esc(pubDay(x2))}</td><td>${esc(engLabel(x2.signal_type))}</td>
        <td class="r">${inr(x2.entry)}</td><td class="r">${inr(x2.sl)}</td><td class="r">${isScored(x2) ? inr(x2.exit_price) : NA}</td>
        <td class="r">${isScored(x2) ? `<span class="chg ${x2.r_multiple > 0 ? 'up' : 'dn'}">${fmtR(num(x2.r_multiple))}</span>` : NA}</td>
        <td>${w ? `<span class="chip ghost" title="Outside the published book">${esc(w)}</span>` : isOpen(x2) ? '<span class="chip acc">open · why?</span>' : `<span class="chip">${esc(String(x2.badge || x2.status || '').toLowerCase())}</span>`}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="pf">${all.length} row${all.length === 1 ? '' : 's'} for ${esc(s)} — every one, including losses and rows outside the book, which are marked.${hist.ok ? '' : ' Read from the loaded ledger; the per-symbol query did not answer.'}</div>`
      : empty('No signal has ever been filed on this name', 'The engines have not flagged it. That is not a view on it either way.');

    $('#aWhy').innerHTML = r ? `${moveFactors(mv.parts)}
      <p class="note" style="margin:var(--s-3) 0 var(--s-4)"><b>Move score ${mv.score == null ? 'not scored' : mv.score}</b> · ${esc(strengthWord(mv.score))}. Trend, momentum and volume from the daily screen; institutional from the latest shareholding. Missing components leave the mean — they are never scored zero.</p>
      ${factors([['Quality', r.q, 'ROCE, ROE, leverage, cash conversion'], ['Growth', r.g, 'Revenue, EBITDA and EPS growth'], ['Valuation', r.v, 'PE and PB against the screen'], ['Technical', r.tech, 'Trend and momentum on the screen']])}
      <p class="note" style="margin-top:var(--s-3)"><b>Composite ${r.comp != null ? Math.round(r.comp) : 'unranked'}</b> — the screen's weighted blend of the four above${r.comp == null ? '; no statements, so no composite' : ''}. A description of the business and the chart as filed, not a forecast.</p>` : empty('Not on the screen', 'No factor data for this name.');

    const bars = [['1D', r && r.r1d], ['1W', r && r.r1w], ['1M', r && r.r1m], ['3M', r && r.r3m], ['6M', r && r.r6m]];
    const mx = Math.max(1, ...bars.map(([, v]) => Math.abs(num(v) || 0)));
    $('#aChart').innerHTML = r ? `<div class="ret" role="img" aria-label="Returns: ${bars.map(([k, v]) => k + ' ' + (signed(v, 1) || 'not measured')).join(', ')}">${bars.map(([k, v]) => { const n = num(v);
        return `<div><b class="${n == null ? 'na' : n >= 0 ? 'up' : 'dn'}">${n == null ? '—' : signed(n, 1)}</b><i class="${n == null ? '' : n >= 0 ? 'up' : 'dn'}" style="height:${n == null ? 0 : Math.max(2, Math.abs(n) / mx * 70)}px"></i>${k}</div>`; }).join('')}</div>
      <p class="note" style="margin-top:var(--s-3)">Return over each window to the screen's last close. There is no per-stock bar history in this backend, so the price chart itself opens on TradingView: <a href="https://www.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(s)}" target="_blank" rel="noopener">chart ${esc(s)} ↗</a>.</p>` : empty('No returns', 'Not on the screen.');

    const lv2 = [];
    if (r) {
      const add = (k, v, what) => { if (num(v) != null) lv2.push([k, num(v), what]); };
      add('52w high', r.high52, 'the year\'s high'); add('52w low', r.low52, 'the year\'s low');
      add('SMA 20', r.sma20, '20-day average'); add('SMA 50', r.sma50, '50-day average'); add('SMA 200', r.sma200, '200-day average');
      if (r.lad) { add('Ladder stop', r.lad.s, 'the screen\'s ladder stop'); }
    }
    lv2.sort((a, b) => b[1] - a[1]);
    $('#aLvl').innerHTML = lv2.length && px != null ? `<div class="lvl">${lv2.filter((l) => l[1] > px).map((l) => `<div><span class="num">${l[0]}</span><em>${esc(l[2])}</em><span class="num">₹${fmt(l[1], 1)} <span class="mut">${signed((l[1] - px) / px * 100, 1)}</span></span></div>`).join('')}
        <div class="now"><span>Now</span><em>${lv ? 'live' : 'at the last close'}</em><span class="num">₹${fmt(px, 1)}</span></div>
        ${lv2.filter((l) => l[1] <= px).map((l) => `<div><span class="num">${l[0]}</span><em>${esc(l[2])}</em><span class="num">₹${fmt(l[1], 1)} <span class="mut">${signed((l[1] - px) / px * 100, 1)}</span></span></div>`).join('')}</div>
      ${r.atr_pct != null ? `<p class="note" style="margin-top:var(--s-2)">A typical day moves it <b>${Number(r.atr_pct).toFixed(1)}%</b>; a level closer than that is noise, not a test.</p>` : ''}` : empty('No levels', 'Not on the screen.');

    const de = num(r && r.de);
    $('#aFun').innerHTML = r ? `<div class="kv" style="margin-top:0">
      <div><em>ROCE</em><b>${r.roce != null ? fmt(r.roce, 1) + '%' : '—'}</b><small>${r.roce_med != null ? 'median ' + fmt(r.roce_med, 1) + '%' : ''}</small></div>
      <div><em>ROE</em><b>${r.roe != null ? fmt(r.roe, 1) + '%' : '—'}</b></div>
      <div><em>Debt / equity</em><b class="${de != null && de < 0 ? 'dn' : ''}">${de == null ? '—' : de < 0 ? 'Negative equity' : fmt(de, 2)}</b><small>${de != null && de < 0 ? 'insolvency, not a clean balance sheet' : ''}</small></div>
      <div><em>PE</em><b>${r.pe != null ? fmt(r.pe, 1) : '—'}</b><small>${r.pe_pctile != null ? `${Math.round(r.pe_pctile)}th pct of its own history` : ''}</small></div>
      <div><em>Revenue CAGR</em><b>${r.rev_cagr != null ? signed(r.rev_cagr, 1) : '—'}</b></div>
      <div><em>EPS CAGR</em><b>${r.eps_cagr != null ? signed(r.eps_cagr, 1) : '—'}</b><small>${r.eps_cagr == null ? 'withheld or not reported' : ''}</small></div>
      <div><em>Piotroski</em><b>${r.piotroski != null ? r.piotroski + '/9' : '—'}</b></div>
      <div><em>Turnover</em><b>${r.turnover_cr != null ? '₹' + fmt(r.turnover_cr, 0) + ' cr' : '—'}</b><small>a day</small></div></div>
      <p class="note" style="margin-top:var(--s-2)">${esc(r.fy || '')} statements, ${r.fy_count || '—'} fiscal years. Scores read the multi-year median, not the latest year.</p>` : empty('No statements', 'Not on the screen.');

    $('#aIns').innerHTML = x && x.quality === 'complete' ? `<div class="kv" style="margin-top:0">
        <div><em>FII</em><b>${fmt(x.fii, 2)}%</b><small>${signed(x.fii_pp, 2, ' pp')} q/q</small></div>
        <div><em>DII</em><b>${fmt(x.dii, 2)}%</b><small>${signed(x.dii_pp, 2, ' pp')} q/q</small></div>
        <div><em>Promoter</em><b>${fmt(x.promoter, 2)}%</b></div></div>
      <p class="note" style="margin-top:var(--s-2)"><b>${esc(x.signal_label || x.band_label || '')}</b> · ${esc(x.period || '')} against ${esc(x.prev_period || '')}. Quarterly filings — this moves four times a year.</p>`
      : empty('No complete shareholding', x ? esc(x.reason || 'partial filing') : 'Not in the institutional feed.');

    const W = await F.wire(); if (!alive()) return;
    const hits = W.ok ? newsIndex(W.stories)(s) : [];
    $('#aNews').innerHTML = !W.ok ? failBox('The wire', W.error) : hits.length ? hits.slice(0, 5).map((n) => `<a class="nw" href="${esc(n.link)}" target="_blank" rel="noopener"><b>${esc(n.title)}</b><div class="meta"><span>${esc(n.source)}</span>${n.at ? `<span>· ${ageOf(Date.now() - Date.parse(n.at))} ago</span>` : ''}</div></a>`).join('')
      + '<div class="pf">Matched by ticker or company name — algorithmic, not a judgement of relevance.</div>'
      : empty('Not in the current wire', `None of the ${W.stories.length} stories names ${esc(s)}.`);

    el.addEventListener('click', (e) => { const w = e.target.closest('[data-why]'); if (w && !e.target.closest('a')) { const rr = findSig(w.dataset.why) || all.find((z) => String(z.id) === w.dataset.why); if (rr) openWhy(rr); } });
  };

  /* ── SCREENER ───────────────────────────────────────────────────────────
     Every name on the screen, dense. Filters and sort persist per browser;
     "Save view" keeps a named copy, "Export" writes exactly the rows shown. */
  const SCOLS = [
    ['sym', 'Symbol', (r) => r.sym, 'l'], ['sector', 'Sector', (r) => r.sector || '', 'l hide-m'],
    ['price', 'Close', (r) => num(r.price)], ['r1d', '1D', (r) => num(r.r1d)], ['r1w', '1W', (r) => num(r.r1w)],
    ['r1m', '1M', (r) => num(r.r1m)], ['r3m', '3M', (r) => num(r.r3m), 'hide-m'],
    ['move', 'Move', (r) => moveOf(r).score, '', 'Move score: trend, momentum, volume, institutional. 0–100; not a forecast.'],
    ['comp', 'Composite', (r) => num(r.comp), '', "The screen's weighted blend of quality, growth, valuation and technical"],
    ['q', 'Q', (r) => num(r.q), 'hide-m', 'Quality'], ['g', 'G', (r) => num(r.g), 'hide-m', 'Growth'],
    ['v', 'V', (r) => num(r.v), 'hide-m', 'Valuation'], ['tech', 'T', (r) => num(r.tech), 'hide-m', 'Technical'],
    ['rsi', 'RSI', (r) => num(r.rsi), 'hide-m'], ['pe', 'PE', (r) => num(r.pe), 'hide-m'], ['roce', 'ROCE', (r) => num(r.roce), 'hide-m'],
    ['turnover_cr', 'Turnover', (r) => num(r.turnover_cr)], ['from_high', 'Off high', (r) => num(r.from_high), 'hide-m'],
  ];
  const SDEF = { q: '', sector: '', minComp: '', minTurn: '5', trend: '', signal: false, sort: 'turnover_cr', dir: -1 };
  V.screener = async (el, arg, alive) => {
    let f = Object.assign({}, SDEF, store.get('vis:scr', {}));
    const saved = store.get('vis:scrSaved', null);
    el.innerHTML = vhead('Screener', 'Every name on the NSE screen',
      'Dense on purpose. Sort any column, filter, save the view, export what you see. Tap a name for its page.', fb('Screen'))
      + `<div class="pn"><div class="ph" style="flex-wrap:wrap;gap:var(--s-2)">
        <input class="inp" id="cQ" type="search" placeholder="Symbol or company" aria-label="Search" style="width:170px">
        <select class="inp" id="cSec" aria-label="Sector"><option value="">All sectors</option></select>
        <select class="inp" id="cTr" aria-label="Trend"><option value="">Any trend</option><option value="up">Above 50 & 200d</option><option value="dn">Below 50 & 200d</option><option value="high">Within 3% of 52w high</option></select>
        <label class="note row" style="gap:4px">Composite ≥ <input class="inp" id="cMin" inputmode="numeric" style="width:52px" aria-label="Minimum composite"></label>
        <label class="note row" style="gap:4px">Turnover ≥ ₹<input class="inp" id="cTurn" inputmode="numeric" style="width:52px" aria-label="Minimum turnover, crore"> cr</label>
        <button class="btn sm" type="button" id="cSig" aria-pressed="false">◆ Open signal</button>
        <div class="ph-r"><button class="btn sm" type="button" id="cSave">Save view</button>${saved ? '<button class="btn sm" type="button" id="cLoad">Load saved</button>' : ''}
          <button class="btn sm" type="button" id="cReset">Reset</button><button class="btn sm" type="button" id="cCsv">Export CSV</button></div></div>
        <div class="pb flush" id="cBody">${skel(10)}</div><div class="pf" id="cFoot"></div></div>`;
    const [r0] = await Promise.all([F.screen(), F.insti(), S.ledger ? null : F.ledger().then((L) => { if (L.ok) S.ledger = L; })]);
    if (!alive()) return;
    if (!r0.ok) { $('#cBody').innerHTML = failBox('The screen', r0.error); return; }
    const all = Object.values(SCR);
    $('#cSec').innerHTML += [...new Set(all.map((r) => r.sector).filter(Boolean))].sort().map((x) => `<option>${esc(x)}</option>`).join('');
    let limit = 100, shown = [];
    const sync = () => { $('#cQ').value = f.q; $('#cSec').value = f.sector; $('#cTr').value = f.trend; $('#cMin').value = f.minComp; $('#cTurn').value = f.minTurn; $('#cSig').setAttribute('aria-pressed', !!f.signal); };
    const paint = () => {
      store.set('vis:scr', f);
      const Q = f.q.toUpperCase(), open = openBySym(), mc = num(f.minComp), mt = num(f.minTurn);
      const col = SCOLS.find((c) => c[0] === f.sort) || SCOLS[16];
      shown = all.filter((r) => (!Q || r.sym.includes(Q) || (r.name || '').toUpperCase().includes(Q))
        && (!f.sector || r.sector === f.sector) && (mc == null || (num(r.comp) != null && r.comp >= mc))
        && (mt == null || (num(r.turnover_cr) || 0) >= mt) && (!f.signal || open[r.sym])
        && (!f.trend || (f.trend === 'high' ? num(r.from_high) != null && r.from_high >= -3 : (trendWord(r) || {}).k === f.trend)))
        .sort((a, b) => { const x = col[2](a), y = col[2](b);
          if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;   // unknown sorts last, never as zero
          return (x > y ? 1 : x < y ? -1 : 0) * f.dir; });
      const cell = (c, r) => { const v = c[2](r);
        if (c[0] === 'sym') return `<td>${star(r.sym)}</td><td><a class="sym" href="#/asset/${esc(r.sym)}">${esc(r.sym)}${open[r.sym] ? ' <span class="chip acc" title="Open signal">◆</span>' : ''}</a><span class="nm">${esc(r.name || '')}</span></td>`;
        if (c[0] === 'sector') return `<td class="hide-m mut">${esc(v || '—')}</td>`;
        const cls = `r${c[3] && c[3].includes('hide-m') ? ' hide-m' : ''}`;
        if (['r1d', 'r1w', 'r1m', 'r3m', 'from_high'].includes(c[0])) return `<td class="${cls}">${chg(v, 1)}</td>`;
        if (c[0] === 'price') return `<td class="${cls}">${inr(v, 2)}</td>`;
        if (c[0] === 'turnover_cr') return `<td class="${cls}">${cr(v)}</td>`;
        if (['move', 'comp'].includes(c[0])) return `<td class="${cls}">${scoreCell(v, c[4])}</td>`;
        return `<td class="${cls}">${v == null ? NA : `<span class="num">${fmt(v, ['q', 'g', 'v', 'tech', 'rsi'].includes(c[0]) ? 0 : 1)}</span>`}</td>`; };
      $('#cBody').innerHTML = shown.length ? `<div class="tw" style="max-height:72vh"><table class="tbl dense"><thead><tr><th scope="col"><span class="vh">Watch</span></th>${SCOLS.map((c) =>
        `<th class="${c[3] && c[3].includes('l') ? '' : 'r'}${c[3] && c[3].includes('hide-m') ? ' hide-m' : ''}" scope="col"${f.sort === c[0] ? ` aria-sort="${f.dir > 0 ? 'ascending' : 'descending'}"` : ''}${c[4] ? ` title="${esc(c[4])}"` : ''}><button type="button" data-sort="${c[0]}">${c[1]}</button></th>`).join('')}</tr></thead>
        <tbody>${shown.slice(0, limit).map((r) => `<tr>${SCOLS.map((c) => cell(c, r)).join('')}</tr>`).join('')}</tbody></table></div>
        ${shown.length > limit ? `<div class="st"><button class="btn" type="button" id="cMore">Show ${Math.min(100, shown.length - limit)} more of ${shown.length - limit}</button></div>` : ''}`
        : empty('No name passes these filters', 'Loosen one, or Reset.');
      $('#cFoot').innerHTML = `${shown.length.toLocaleString('en-IN')} of ${all.length.toLocaleString('en-IN')} names. Blank cells are unmeasured and sort last — never as zero. Scores describe the business and the chart; none is a forecast.`;
      const m = $('#cMore'); if (m) m.onclick = () => { limit += 100; paint(); };
      paintStars();
    };
    sync(); paint();
    const on = (id, ev, fn) => { $(id).addEventListener(ev, fn); };
    on('#cQ', 'input', (e) => { f.q = e.target.value.trim(); limit = 100; paint(); });
    on('#cSec', 'change', (e) => { f.sector = e.target.value; paint(); });
    on('#cTr', 'change', (e) => { f.trend = e.target.value; paint(); });
    on('#cMin', 'input', (e) => { f.minComp = e.target.value.trim(); paint(); });
    on('#cTurn', 'input', (e) => { f.minTurn = e.target.value.trim(); paint(); });
    on('#cSig', 'click', () => { f.signal = !f.signal; sync(); paint(); });
    on('#cReset', 'click', () => { f = Object.assign({}, SDEF); limit = 100; sync(); paint(); toast('Filters reset'); });
    on('#cSave', 'click', () => { store.set('vis:scrSaved', f); toast('View saved in this browser'); });
    const ld = $('#cLoad'); if (ld) ld.onclick = () => { f = Object.assign({}, SDEF, store.get('vis:scrSaved', {})); sync(); paint(); toast('Saved view loaded'); };
    on('#cCsv', 'click', () => {
      const head = ['symbol', 'name', 'sector', 'close', 'r1d', 'r1w', 'r1m', 'r3m', 'move_score', 'composite', 'quality', 'growth', 'valuation', 'technical', 'rsi', 'pe', 'roce', 'turnover_cr', 'from_high', 'screen_built_at'];
      const q = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
      const at = (FR.Screen || {}).at || '';
      const csv = [head.join(',')].concat(shown.map((r) => [r.sym, r.name, r.sector, r.price, r.r1d, r.r1w, r.r1m, r.r3m, moveOf(r).score, r.comp, r.q, r.g, r.v, r.tech, r.rsi, r.pe, r.roce, r.turnover_cr, r.from_high, at].map(q).join(','))).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `vision-screen-${istToday()}.csv`; document.body.appendChild(a); a.click(); a.remove();
      toast(`${shown.length} rows exported`);
    });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-sort]'); if (!b) return;
      const k = b.dataset.sort; f.dir = f.sort === k ? -f.dir : (k === 'sym' || k === 'sector' ? 1 : -1); f.sort = k; paint(); });
  };

  /* ── HEATMAP + BREADTH ──────────────────────────────────────────────────── */
  V.heatmap = async (el, arg, alive) => {
    const o = Object.assign({ size: 'turnover', color: 'r1d', n: 300, group: true }, store.get('vis:hm', {}));
    const segBtns = (key, opts) => `<div class="seg" role="group">${opts.map(([v, t]) => `<button type="button" data-k="${key}" data-val="${v}" aria-pressed="${String(o[key]) === String(v)}">${t}</button>`).join('')}</div>`;
    el.innerHTML = vhead('Heatmap', 'The market, by name',
      'Size is importance, colour is the move. Hover for detail, click for the name. ◆ marks an open signal.', fb('Screen'))
      + `<div class="pn"><div class="ph" style="flex-wrap:wrap;gap:var(--s-2)">
          ${segBtns('color', [['r1d', '1D'], ['r1w', '1W'], ['r1m', '1M']])}
          ${segBtns('size', [['turnover', 'Turnover'], ['mcap', 'Market cap']])}
          ${segBtns('n', [[150, 'Top 150'], [300, 'Top 300'], [600, 'Top 600']])}
          <div class="ph-r" id="hLeg"></div></div>
        <div class="pb"><div class="hm" id="hMap">${skel(0, 560)}</div></div><div class="pf" id="hFoot"></div></div>
      <div style="height:var(--s-4)"></div>
      <div class="grid g-2">${panel('Breadth', skel(6), { bodyId: 'hBr', fb: 'Screen' })}${panel('Sectors today', skel(8), { bodyId: 'hSec', flush: true, fb: 'Pulse' })}</div>`;
    const [r, p] = await Promise.all([F.screen(), F.pulse()]); if (!alive()) return;
    if (!r.ok) { $('#hMap').innerHTML = failBox('The screen', r.error); return; }
    const host = $('#hMap'), rows = Object.values(SCR);
    const draw = () => {
      $('#hLeg').innerHTML = heatLegend(o.color);
      const n = treemap(host, rows, { size: o.size, color: o.color, n: +o.n, height: innerWidth < 760 ? 460 : 620, group: o.group });
      const noCap = rows.filter((x) => !(num(x.mcap_cr) > 0));
      $('#hFoot').innerHTML = `${n} names, grouped by sector, sized by ${o.size === 'mcap' ? 'market cap' : 'daily turnover'}.`
        + (o.size === 'mcap' ? ` <span class="warn">${noCap.length} names carry no market cap in the feed and are left out${noCap.length ? ` — including ${noCap.slice().sort((a, b) => (b.turnover_cr || 0) - (a.turnover_cr || 0)).slice(0, 4).map((x) => esc(x.sym)).join(', ')}` : ''}.</span>` : ' Turnover is the default because market cap is missing for some of the largest names.')
        + ` Colour steps are ${o.color === 'r1d' ? '1' : o.color === 'r1w' ? '2' : '4'}× the daily scale so a month is not all one shade.`;
    };
    draw(); wireTips(host);
    let w = host.clientWidth; new ResizeObserver(() => { if (Math.abs(host.clientWidth - w) > 8 && document.contains(host)) { w = host.clientWidth; draw(); } }).observe(host);
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (!b) return;
      o[b.dataset.k] = b.dataset.k === 'n' ? +b.dataset.val : b.dataset.val; store.set('vis:hm', o);
      $$(`[data-k="${b.dataset.k}"]`, el).forEach((x) => x.setAttribute('aria-pressed', x === b)); draw(); });

    const b = r.data.breadth || {};
    const pc = (v) => v == null ? '—' : Number(v).toFixed(1) + '%';
    const bar = (v, label) => `<div style="margin-bottom:var(--s-3)"><div class="row"><span class="note">${label}</span><span class="sp"></span><b class="num">${pc(v)}</b></div>
      <div class="brd" role="img" aria-label="${label} ${pc(v)}"><i class="a" style="flex:${num(v) || 0}"></i><i class="u" style="flex:${100 - (num(v) || 0)}"></i></div></div>`;
    $('#hBr').innerHTML = `${bar(b.above20, 'Above the 20-day average')}${bar(b.above50, 'Above the 50-day average')}${bar(b.above200, 'Above the 200-day average')}
      <div class="kv"><div><em>Advancing</em><b class="up">${b.advancing ?? '—'}</b></div><div><em>Declining</em><b class="dn">${b.declining ?? '—'}</b></div>
        <div><em>Median 1M</em><b>${b.median_1m != null ? signed(b.median_1m, 1) : '—'}</b></div><div><em>At 52w high</em><b>${b.at_52w_high ?? '—'}</b></div></div>
      <p class="note" style="margin-top:var(--s-3)">Across ${b.counted ? b.counted.toLocaleString('en-IN') : '—'} names on the screen, at its build. The barometer on Overview is the one headline; these are its raw inputs.</p>`;
    const sd = p.ok ? p.data.sectors_day || [] : [];
    $('#hSec').innerHTML = sd.length ? `<div class="tw"><table class="tbl dense"><thead><tr><th scope="col">Sector</th><th class="r" scope="col">Median</th><th scope="col">Rose</th></tr></thead><tbody>${sd.map((s) =>
      `<tr><td>${esc(s.name)}</td><td class="r">${chg(s.median)}</td><td><div class="row"><div class="brd" style="width:90px;margin:0"><i class="a" style="flex:${s.up}"></i><i class="d" style="flex:${s.n - s.up}"></i></div><span class="num mut">${s.up}/${s.n}</span></div></td></tr>`).join('')}</tbody></table></div>
      <div class="pf">The ${p.data.day_universe || ''} largest names, last session. Sectors with too few names are left out rather than shown on two data points.</div>`
      : p.ok ? empty('No sector table in this build', '') : failBox('The pulse', p.error);
  };

  /* ── MARKETS ────────────────────────────────────────────────────────────── */
  V.markets = async (el, arg, alive) => {
    el.innerHTML = vhead('Markets', 'Every board, live',
      'Indices, the world, FX, commodities and crypto from the live feed; flows and the barometer\'s workings underneath.', fb('Live prices'))
      + `<div id="mBoards" class="grid g-2">${skel(8)}</div><div style="height:var(--s-4)"></div>
      <div class="grid g-3">${panel('Barometer, part by part', skel(6), { bodyId: 'mBaro', fb: 'Barometer' })}
        ${panel('FII & DII', skel(4), { bodyId: 'mFlow', fb: 'Flows' })}${panel('Volatility regime', skel(4), { bodyId: 'mReg', fb: 'Regime' })}</div>`;
    const paint = async () => {
      await tickerP;
      const box = $('#mBoards'); if (!box || !alive()) return;
      if (!S.ticker) { box.innerHTML = `<div class="pn">${failBox('Live prices', (FR['Live prices'] || {}).error, true)}</div>`; const rb = $('[data-retry]', box); if (rb) rb.onclick = async () => { await refreshTicker(true); paint(); }; return; }
      const segs = (S.ticker.segments || []).filter((sg) => sg.key !== 'multibagger');
      box.innerHTML = segs.map((sg) => panel(sg.label.replace(/\s*·.*$/, ''), `<div class="tw"><table class="tbl dense"><thead><tr><th scope="col">Name</th><th class="r" scope="col">Last</th><th class="r" scope="col">Chg</th><th class="r hide-m" scope="col">1M</th><th class="hide-m" scope="col">52w range</th></tr></thead><tbody>${sg.items.map((it) => {
        const nse = ['gainers', 'losers'].includes(sg.key);
        return `<tr><td>${nse ? `<a class="sym" href="#/asset/${esc(bare(it.name))}">${esc(it.name)}</a>` : `<span class="sym" title="${esc(it.full_name || '')}">${esc(it.name)}</span>`}${it.session === 'open' ? ' <span class="chip up" title="Session open">●</span>' : ''}</td>
          <td class="r num">${esc(it.price)}</td><td class="r">${chg(it.change_pct)}</td>
          <td class="r hide-m"><span class="row" style="justify-content:flex-end">${spark(it.trend)}${chg(it.trend_pct, 1)}</span></td>
          <td class="hide-m">${it.range_pos != null ? `<div class="rng" style="width:90px;margin:0" title="${esc(it.w52_low_f || '')} – ${esc(it.w52_high_f || '')}${it.range_basis === 'futures' ? ' (futures range)' : ''}"><i style="left:${it.range_pos}%"></i></div>` : NA}</td></tr>`; }).join('')}</tbody></table></div>`, { flush: true, n: sg.items.length })).join('');
    };
    const side = async () => {
      const [b, fl, rg] = await Promise.all([F.baro(), F.flows(), F.regime()]); if (!alive()) return;
      const t = b.ok ? b.data.today || {} : null;
      $('#mBaro').innerHTML = !b.ok ? failBox('The barometer', b.error) : `${factors((t.parts || []).map((p) => [`${p.label}`, p.score, p.detail]))}
        <p class="note" style="margin-top:var(--s-3)">Weights ${(t.parts || []).map((p) => `${esc(p.key)} ${p.weight}`).join(' · ')}. Score <b>${t.score}</b> = the weighted mean over ${t.coverage ? t.coverage.weight_used : '—'} of ${t.coverage ? t.coverage.weight_total : '—'} weight.
        ${b.data.outcomes ? 'Forward outcomes by stage are published only once readings have aged into them; today none has.' : ''}</p>`;
      const f = fl.ok ? fl.data : null;
      const side1 = (k, x) => x ? `<div><em>${k}</em><b class="${x.net >= 0 ? 'up' : 'dn'}">${signed(x.net, 0, '')}</b><small>buy ${fmt(x.buy, 0)} · sell ${fmt(x.sell, 0)}</small></div>` : `<div><em>${k}</em><b class="na">—</b><small>NSE sent no row</small></div>`;
      $('#mFlow').innerHTML = !f ? failBox('FII/DII flows', fl.error) : `<div class="kv" style="margin-top:0">${side1('FII / FPI', f.fii)}${side1('DII', f.dii)}</div>
        <p class="note" style="margin-top:var(--s-2)">₹ crore, cash market, ${esc(f.date || '')}. ${f.fii && f.dii ? '' : 'One side is missing, so no total is printed.'}</p>`;
      const td = rg.ok ? rg.data.today : null;
      $('#mReg').innerHTML = !td ? failBox('The regime', rg.error) : `<div class="pulse-h"><strong style="font-size:var(--t-xl)">${esc(td.t)}</strong></div>
        <p class="note" style="margin-top:var(--s-2)">${esc(td.d || '')}</p>
        <div class="kv"><div><em>Realised vol</em><b>${td.vol_ann_pct != null ? td.vol_ann_pct + '%' : '—'}</b><small>${td.vol_pctile != null ? Math.round(td.vol_pctile) + 'th pct' : ''}</small></div>
          <div><em>In this regime</em><b>${rg.data.run_days ?? '—'}</b><small>sessions</small></div></div>`;
    };
    await Promise.all([paint(), side()]);
    return paint;
  };

  /* ── NEWS ───────────────────────────────────────────────────────────────
     No sentiment score: the backend computes none, and a colour on a headline
     is a claim about its effect that nobody measured. What is added is a
     name match — labelled as algorithmic — against the screen, the open book
     and the watchlist. */
  V.news = async (el, arg, alive) => {
    const f = { scope: '', q: '', touch: '' };
    el.innerHTML = vhead('Market intelligence', 'The wire',
      'Headlines from Indian and global business desks, newest first, matched to the names you follow. No sentiment is inferred.', fb('Wire'))
      + `<div class="pn"><div class="ph" style="flex-wrap:wrap;gap:var(--s-2)">
        <div class="seg" role="group" aria-label="Scope">${[['', 'All'], ['in', 'India'], ['global', 'Global']].map(([k, t]) => `<button type="button" data-sc="${k}" aria-pressed="${f.scope === k}">${t}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Touches">${[['', 'Any'], ['screen', 'Names a stock'], ['mine', 'Watchlist or open signal']].map(([k, t]) => `<button type="button" data-tc="${k}" aria-pressed="${f.touch === k}">${t}</button>`).join('')}</div>
        <input class="inp" id="nQ" type="search" placeholder="Search headlines" aria-label="Search headlines" style="width:180px">
        <div class="ph-r"><span class="n" id="nN"></span></div></div><div class="pb flush" id="nBody">${skel(10)}</div><div class="pf" id="nFoot"></div></div>`;
    const [W] = await Promise.all([F.wire(), F.screen(), S.ledger ? null : F.ledger().then((L) => { if (L.ok) S.ledger = L; })]);
    if (!alive()) return;
    if (!W.ok) { $('#nBody').innerHTML = failBox('The wire', W.error); return; }
    const hit = newsIndex(W.stories), open = openBySym(), mine = new Set([...S.watch.map((w) => w.s), ...Object.keys(open)]);
    /* Screen names are matched on ticker only here: first-word-of-company over
       1,000 names finds "Tata" in every Tata story. */
    const tick = new Set(Object.keys(SCR || {}).filter((s) => s.length >= 4 && !STOP.has(s)));
    const tagsOf = (s) => { const words = new Set(String((s.title || '') + ' ' + (s.summary || '')).toUpperCase().replace(/[^A-Z0-9&]+/g, ' ').split(' '));
      const t = new Set(); for (const w of words) if (tick.has(w)) t.add(w); for (const m of mine) if (hit(m).includes(s)) t.add(m); return [...t].slice(0, 4); };
    const T = new Map(W.stories.map((s) => [s, tagsOf(s)]));
    const paint = () => {
      const Q = f.q.toUpperCase();
      const rows = W.stories.filter((s) => (!f.scope || s.scope === f.scope) && (!Q || String(s.title + ' ' + (s.summary || '')).toUpperCase().includes(Q))
        && (!f.touch || (f.touch === 'screen' ? T.get(s).length : T.get(s).some((x) => mine.has(x)))));
      $('#nN').textContent = `${rows.length} of ${W.stories.length}`;
      $('#nBody').innerHTML = rows.length ? rows.map((s) => `<a class="nw" href="${esc(s.link)}" target="_blank" rel="noopener"><b>${esc(s.title)}</b>${s.summary ? `<p>${esc(s.summary)}</p>` : ''}
        <div class="meta"><span>${esc(s.source)}</span>${s.at ? `<span>· ${ageOf(Date.now() - Date.parse(s.at))} ago</span>` : ''}${s.scope ? `<span class="chip ghost">${s.scope === 'in' ? 'India' : 'Global'}</span>` : ''}
        ${T.get(s).map((x) => `<span class="tag">◆ ${esc(x)}${open[x] ? ' · open signal' : mine.has(x) ? ' · watchlist' : ''}</span>`).join('')}</div></a>`).join('')
        : empty('No story matches', 'Widen the scope or clear the search.');
      $('#nFoot').innerHTML = `${W.live ? `${W.failed.length ? `${W.failed.length} source(s) did not answer: ${esc(W.failed.join(', '))}. ` : 'Every source answered. '}` : 'Live wire unavailable — this is the last build\'s snapshot, undated per story. '}◆ tags are name matches found by text search — algorithmic, and a mention is not a judgement of relevance.`;
    };
    paint();
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-sc]'); if (a) { f.scope = a.dataset.sc; $$('[data-sc]', el).forEach((b) => b.setAttribute('aria-pressed', b === a)); paint(); }
      const t = e.target.closest('[data-tc]'); if (t) { f.touch = t.dataset.tc; $$('[data-tc]', el).forEach((b) => b.setAttribute('aria-pressed', b === t)); paint(); }
    });
    $('#nQ').oninput = (e) => { f.q = e.target.value.trim(); paint(); };
  };

  /* ── WATCHLIST ──────────────────────────────────────────────────────────
     Stored in this browser only. vision.askakshay.com is its own origin, so a
     list starred on signal.askakshay.com does not appear here — said on the
     page rather than discovered. */
  let wSort = { k: 'manual', d: 1 }, wQ = '';
  async function watchTable(opts = {}) {
    if (!S.watch.length) return empty('Your watchlist is empty', `Star any name — ☆ on a table row, a tile, or in search (<span class="kbd">⌘K</span>). ${openBook().length ? `<br><button class="btn sm" type="button" data-addopen style="margin-top:8px">Add the ${new Set(openBook().map((r) => bare(r.symbol))).size} names with open signals</button>` : ''}`);
    if (!SCR) await F.screen();
    const W = S.wire || (await F.wire());
    const hit = W && W.ok ? newsIndex(W.stories) : null, open = openBySym();
    let list = S.watch.filter((w) => !wQ || w.s.includes(wQ.toUpperCase()) || ((SCR && SCR[w.s] && SCR[w.s].name) || '').toUpperCase().includes(wQ.toUpperCase()));
    const val = { sym: (w) => w.s, chg: (w) => { const l = liveOf(w.s); return l ? l.change_pct : null; }, move: (w) => moveOf(SCR && SCR[w.s]).score,
      mom: (w) => num(SCR && SCR[w.s] && SCR[w.s].r1m), news: (w) => hit ? hit(w.s).length : null };
    if (wSort.k !== 'manual') list = list.slice().sort((a, b) => { const x = val[wSort.k](a), y = val[wSort.k](b);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * wSort.d; });
    list = list.filter((w) => w.pin).concat(list.filter((w) => !w.pin));
    const th = (k, t, cls = '') => `<th class="${cls}" scope="col"${wSort.k === k ? ` aria-sort="${wSort.d > 0 ? 'ascending' : 'descending'}"` : ''}>${opts.compact ? t : `<button type="button" data-wsort="${k}">${t}</button>`}</th>`;
    return `<div class="tw"><table class="tbl"><thead><tr>${th('', '<span class="vh">Watch</span>')}${th('sym', 'Symbol')}${th('chg', 'Price', 'r')}${th('', 'Signal')}
      ${th('move', 'Score', 'r')}${th('', 'Trend', 'hide-m')}${th('mom', 'Momentum', 'r')}${th('news', 'News', 'r hide-m')}${opts.compact ? '' : th('', '<span class="vh">Arrange</span>', 'r')}</tr></thead><tbody>
      ${list.map((w, i) => { const r = SCR && SCR[w.s], l = liveOf(w.s), op = open[w.s], mv = moveOf(r), nn = hit ? hit(w.s).length : null;
        return `<tr${w.pin ? ' class="pin"' : ''}><td>${star(w.s)}</td><td><a class="sym" href="#/asset/${esc(w.s)}">${esc(w.s)}</a><span class="nm">${esc((r && r.name) || 'Not on the screen')}</span></td>
          <td class="r">${l ? `${inr(l.price)}<br>${chg(l.change_pct)}` : r ? `${inr(r.price)}<br><span class="note">close</span>` : NA}</td>
          <td>${op ? `<button class="chip acc" type="button" data-why="${esc(op[0].id != null ? op[0].id : w.s + '|' + pubDay(op[0]))}">◆ ${esc(engLabel(op[0].signal_type))}</button>` : '<span class="mut">none open</span>'}</td>
          <td class="r">${scoreCell(mv.score, 'Move score — trend, momentum, volume, institutional; not a forecast')}</td>
          <td class="hide-m">${trendChip(r)}</td><td class="r">${chg(r && r.r1m, 1)}<br><span class="note">1 month</span></td>
          <td class="r hide-m">${nn == null ? NA : nn ? `<a href="#/news" class="num">${nn}</a>` : '<span class="mut">0</span>'}</td>
          ${opts.compact ? '' : `<td class="r"><span class="row" style="justify-content:flex-end;gap:2px">
            <button class="btn sm" type="button" data-pin="${esc(w.s)}" aria-pressed="${!!w.pin}" title="Pin to top">${w.pin ? 'Pinned' : 'Pin'}</button>
            <button class="btn sm" type="button" data-mv="${esc(w.s)}|-1" aria-label="Move ${esc(w.s)} up"${wSort.k !== 'manual' || i === 0 ? ' disabled' : ''}>↑</button>
            <button class="btn sm" type="button" data-mv="${esc(w.s)}|1" aria-label="Move ${esc(w.s)} down"${wSort.k !== 'manual' || i === list.length - 1 ? ' disabled' : ''}>↓</button></span></td>`}</tr>`; }).join('')}</tbody></table></div>`;
  }
  V.watchlist = async (el, arg, alive) => {
    el.innerHTML = vhead('Watchlist', 'Names you follow',
      'Live marks, any open signal, the move score, trend, momentum and how often the wire names them. Stored in this browser.', fb('Quotes'))
      + `<div class="pn"><div class="ph" style="flex-wrap:wrap;gap:var(--s-2)"><input class="inp" id="wQ" type="search" placeholder="Filter" aria-label="Filter watchlist" style="width:150px" value="${esc(wQ)}">
        <button class="btn sm" type="button" id="wAdd">+ Add a name</button><button class="btn sm" type="button" id="wMan" aria-pressed="${wSort.k === 'manual'}">Manual order</button>
        <div class="ph-r"><span class="n">${S.watch.length} names</span></div></div><div class="pb flush" id="wBody">${skel(5)}</div>
        <div class="pf">Kept in this browser (<code>localStorage</code>) — not synced, and not shared with signal.askakshay.com, which is a different origin. Sort a column, or use Manual order to arrange with ↑ ↓. Pinned names stay on top.</div></div>`;
    const paint = async () => { const b = $('#wBody'); if (b) b.innerHTML = await watchTable(); paintStars(); };
    await Promise.all([S.ledger ? null : F.ledger().then((L) => { if (L.ok) S.ledger = L; }), refreshQuotes()]);
    if (!alive()) return;
    await paint();
    el.addEventListener('click', async (e) => {
      const so = e.target.closest('[data-wsort]'); if (so) { const k = so.dataset.wsort; wSort = { k, d: wSort.k === k ? -wSort.d : (k === 'sym' ? 1 : -1) }; $('#wMan').setAttribute('aria-pressed', 'false'); return paint(); }
      const pn = e.target.closest('[data-pin]'); if (pn) { const w = S.watch.find((x) => x.s === pn.dataset.pin); if (w) { w.pin = !w.pin; saveWatch(); toast(`${w.s} ${w.pin ? 'pinned' : 'unpinned'}`); } return paint(); }
      const mv = e.target.closest('[data-mv]'); if (mv) { const [s, d] = mv.dataset.mv.split('|'); const i = S.watch.findIndex((x) => x.s === s), j = i + +d;
        if (i >= 0 && j >= 0 && j < S.watch.length) { [S.watch[i], S.watch[j]] = [S.watch[j], S.watch[i]]; saveWatch(); await paint(); const nb = $(`[data-mv="${s}|${d}"]`); if (nb && !nb.disabled) nb.focus(); } return; }
      if (e.target.closest('#wMan')) { wSort = { k: 'manual', d: 1 }; $('#wMan').setAttribute('aria-pressed', 'true'); return paint(); }
      if (e.target.closest('#wAdd')) return openPalette();
      if (e.target.closest('[data-star]')) setTimeout(paint, 0);
    });
    $('#wQ').oninput = (e) => { wQ = e.target.value.trim(); paint(); };
    return paint;
  };

  /* ── ALERTS ─────────────────────────────────────────────────────────────
     Two kinds, and the page does not blur them. Telegram is the real thing —
     the bot posts the book's signals on a fixed schedule. Price alerts here
     are browser-side: checked each time this page refreshes its quotes, so
     they fire only while a Vision tab is open. There is no server that
     watches a price for you, and the page says so. */
  V.alerts = async (el, arg, alive, params) => {
    const pre = bare((params && params.get('sym')) || '');
    el.innerHTML = vhead('Alerts', 'What reaches you, and how',
      'Signals arrive on Telegram. Price levels can be watched from this browser while a tab is open.', '')
      + `<div class="grid g-2">${panel('Telegram — the book\'s own alerts', `<p style="margin:0 0 var(--s-3);color:var(--ink-2)">Every signal this book files is posted to Telegram, with the engine, the levels, what fired it and — when a position closes — how it closed.</p>
        <div class="kv" style="margin-top:0"><div><em>Morning brief</em><b>08:00</b><small>MYT · 05:30 IST</small></div><div><em>Night brief + entries</em><b>20:00</b><small>MYT · 17:30 IST</small></div><div><em>Midday</em><b>14:00</b><small>MYT · GUST, weekdays</small></div></div>
        <div class="row wrap" style="margin-top:var(--s-4)"><a class="btn pri" href="https://signal.askakshay.com/join" target="_blank" rel="noopener">Join on Telegram ↗</a></div>`, {})}
      ${panel('Price alerts in this browser', `<form id="alF" class="row wrap" style="gap:var(--s-2)" autocomplete="off">
          <input class="inp" id="alS" placeholder="Symbol" aria-label="Symbol" value="${esc(pre)}" style="width:120px;text-transform:uppercase" required>
          <select class="inp" id="alO" aria-label="Condition"><option value=">">rises above</option><option value="<">falls below</option></select>
          <input class="inp" id="alP" inputmode="decimal" placeholder="Price ₹" aria-label="Price" style="width:110px" required>
          <button class="btn pri" type="submit">Add alert</button></form>
        <p class="note" id="alHint" style="margin:var(--s-2) 0 0"></p><div id="alL" style="margin-top:var(--s-3)"></div>`,
        { foot: `<b>Limits, stated:</b> checked every minute while a Vision tab is open and visible, against the live NSE quote. Closed tab, no alert. Stored in this browser only. ${'Notification' in window ? 'Allow notifications to be told even when this tab is in the background.' : 'This browser has no notification support, so alerts show on the page.'}` })}</div>`;
    const list = () => {
      const L = $('#alL'); if (!L) return;
      L.innerHTML = S.alerts.length ? `<div class="tw"><table class="tbl dense"><thead><tr><th scope="col">Symbol</th><th scope="col">When</th><th class="r" scope="col">Level</th><th class="r" scope="col">Last</th><th scope="col">State</th><th scope="col"><span class="vh">Remove</span></th></tr></thead><tbody>
        ${S.alerts.map((a) => { const l = liveOf(a.s); return `<tr><td><a class="sym" href="#/asset/${esc(a.s)}">${esc(a.s)}</a></td><td>${a.op === '>' ? 'rises above' : 'falls below'}</td><td class="r">${inr(a.px)}</td>
          <td class="r">${l ? inr(l.price) : '<span class="na" title="No live quote yet">no mark</span>'}</td><td>${a.fired ? `<span class="chip ${a.op === '>' ? 'up' : 'dn'}">fired ${esc(new Date(a.fired).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : '<span class="chip">watching</span>'}</td>
          <td class="r"><button class="btn sm" type="button" data-rm="${esc(a.id)}" aria-label="Remove alert on ${esc(a.s)}">Remove</button></td></tr>`; }).join('')}</tbody></table></div>`
        : empty('No price alerts', 'Add a level above.');
    };
    await refreshQuotes(); if (!alive()) return;
    list();
    const hint = async () => { const s = bare($('#alS').value); const h = $('#alHint'); if (!s) { h.textContent = ''; return; }
      const q = await F.quotes([s]); Object.assign(S.quotes, q); const l = liveOf(s);
      h.innerHTML = l ? `${esc(s)} is at ${inr(l.price)} now.` : `<span class="warn">No live NSE quote for ${esc(s)} — an alert on it could never fire.</span>`; };
    $('#alS').addEventListener('change', hint); if (pre) hint();
    $('#alF').addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = bare($('#alS').value), px = num($('#alP').value), op = $('#alO').value;
      if (!s || px == null || px <= 0) { toast('Enter a symbol and a price above zero'); return; }
      S.alerts.push({ id: Date.now().toString(36), s, op, px, made: new Date().toISOString(), fired: null });
      store.set('vis:alerts', S.alerts); $('#alP').value = '';
      if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e2) { /* declined */ } }
      toast(`Alert set: ${s} ${op === '>' ? 'above' : 'below'} ₹${fmt(px, 2)}`); await refreshQuotes(); list(); paintAlertDot();
    });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; S.alerts = S.alerts.filter((a) => a.id !== b.dataset.rm); store.set('vis:alerts', S.alerts); list(); paintAlertDot(); });
    return list;
  };
  function checkAlerts() {
    let any = false;
    for (const a of S.alerts) {
      if (a.fired) continue;
      const l = liveOf(a.s); if (!l) continue;
      if ((a.op === '>' && l.price >= a.px) || (a.op === '<' && l.price <= a.px)) {
        a.fired = new Date().toISOString(); a.firedPx = l.price; any = true;
        const msg = `${a.s} ${a.op === '>' ? 'rose above' : 'fell below'} ₹${fmt(a.px, 2)} — now ₹${fmt(l.price, 2)}`;
        toast(msg);
        try { if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification('Vision alert', { body: msg, icon: '/icon.svg' }); } catch (e) { /* page toast already shown */ }
      }
    }
    if (any) { store.set('vis:alerts', S.alerts); paintAlertDot(); }
  }
  const paintAlertDot = () => { const b = $('#aBtn'); if (!b) return; const n = S.alerts.filter((a) => !a.fired).length;
    let d = $('.dot', b); if (n && !d) { d = document.createElement('i'); d.className = 'dot'; b.appendChild(d); } if (!n && d) d.remove();
    b.setAttribute('aria-label', n ? `Alerts, ${n} watching` : 'Alerts'); };

  /* ── RECORD ─────────────────────────────────────────────────────────────
     The differentiator, so it gets its own page: the book's result computed
     from the rows, with the interval, and the same verdict rule the main site
     uses — the sign can be settled while the size is not. */
  /* Every trade at the same R has no spread, so the "interval" collapses to
     a point — which is not a measurement of certainty, it is the absence of
     one. Said in words rather than printed as "−1.00R … −1.00R". */
  const spreadTxt = (r) => !r.trades ? 'none closed' : r.trades === 1 ? 'one trade'
    : r.t == null ? `no spread — all ${r.trades} at ${fmtR(r.expectancy_r)}` : r.ci ? `${fmtR(r.ci[0])} … ${fmtR(r.ci[1])}` : '—';
  V.record = async (el, arg, alive) => {
    el.innerHTML = vhead('Record', 'How the published book has done',
      `Every long signal a live engine has published since ${esc(LAUNCH)}, graded from the ledger. Computed in your browser from the rows below — nothing typed in.`, fb('Ledger'))
      + `<div id="rBody">${skel(8)}</div>`;
    const L = await F.ledger(); if (!alive()) return;
    if (!L.ok) { $('#rBody').innerHTML = `<div class="pn">${failBox('The ledger', L.error)}</div>`; return; }
    S.ledger = L;
    if (!L.graded) { $('#rBody').innerHTML = `<div class="callout bad"><b>The record cannot be computed right now.</b> The live ledger did not answer, and the build-time snapshot that stood in for it carries no R multiples — so every closed trade in it would read as ungraded, and this page would print "0 closed" over a book that has closed trades. It shows nothing rather than that. The same record is on <a href="https://signal.askakshay.com/signals" target="_blank" rel="noopener">signal.askakshay.com</a>.</div>`; return; }
    const book = L.rows.filter(inBook), rec = recordOf(book), bk = bucketsOf(book);
    const closed = book.filter(isScored).sort((a, b) => String(a.closed_at || '').localeCompare(String(b.closed_at || '')));
    let cum = 0; const pts = closed.map((r) => (cum += Number(r.r_multiple)));
    const curve = () => { if (pts.length < 2) return empty('Too few closed trades to draw a curve', `${pts.length} closed so far.`);
      const w = 600, h = 160, lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), rg = (hi - lo) || 1, st = w / (pts.length - 1);
      const y = (v) => (h - 8 - ((v - lo) / rg) * (h - 16)).toFixed(1);
      const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i * st).toFixed(1)},${y(v)}`).join('');
      return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" role="img" aria-label="Cumulative R over ${pts.length} closed trades, ending at ${fmtR(cum)}">
        <line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line-2)" stroke-dasharray="3 4"/>
        <path d="${d}" fill="none" stroke="var(${cum >= 0 ? '--up' : '--dn'})" stroke-width="2" stroke-linejoin="round"/></svg>
        <div class="rng-l"><span>first close</span><span>0R dashed</span><span>${esc(dshort(closed[closed.length - 1].closed_at))} · ${fmtR(cum)}</span></div>`; };
    const verdict = !rec.trades ? 'No trade in the book has closed yet, so there is nothing to conclude.'
      : !rec.ci ? 'One closed trade settles nothing in either direction.'
      : rec.t == null ? `Every closed trade booked the same ${fmtR(rec.expectancy_r)}, so there is no spread to build an interval from — ${rec.trades} identical results, not a measured certainty.`
      : rec.significant ? `<b>Statistically ${rec.ci[1] < 0 ? 'negative' : 'positive'}.</b> The 95% interval on expectancy (${fmtR(rec.ci[0])} to ${fmtR(rec.ci[1])}) excludes zero, so the sign is settled — the size is not${rec.trades < 30 ? `, and ${rec.trades} trades is short of the 30 this book requires before it trusts an engine` : ''}.`
      : `<b>Not settled.</b> At ${rec.trades} closed the 95% interval runs ${fmtR(rec.ci[0])} to ${fmtR(rec.ci[1])} and includes zero — too few to say which way this book leans, and shown anyway.`;
    const engs = [...new Set(book.map((r) => r.signal_type))].map((k) => [k, recordOf(book.filter((r) => r.signal_type === k))])
      .sort((a, b) => b[1].trades - a[1].trades);
    $('#rBody').innerHTML = `<div class="pn"><div class="pb"><div class="grid g-4">
        <div><div class="note">Closed trades</div><div class="big">${rec.trades}</div></div>
        <div><div class="note">Win rate</div><div class="big">${rec.win_rate != null ? rec.win_rate + '%' : '—'}</div></div>
        <div><div class="note">Expectancy per trade</div><div class="big ${rec.expectancy_r > 0 ? 'up' : rec.expectancy_r < 0 ? 'dn' : ''}">${fmtR(rec.expectancy_r)}</div></div>
        <div><div class="note">t · p (two-sided)</div><div class="big" style="font-size:var(--t-2x)">${rec.t ?? '—'} · ${rec.p == null ? '—' : rec.p < 0.001 ? '<0.001' : rec.p.toFixed(3)}</div></div></div>
        <p style="margin:var(--s-4) 0 0;color:var(--ink-2);max-width:80ch">${verdict}</p></div>
        <div class="pf">Every published signal is in exactly one bucket — <b>${bk.closed}</b> closed · <b>${bk.open}</b> open · <b>${bk.expired}</b> expired · <b>${bk.withdrawn}</b> withdrawn · <b>${bk.other}</b> other · ${book.length} in all. Time-stopped trades are graded at the last close.</div></div>
      <div style="height:var(--s-4)"></div>
      <div class="grid g-7-5">${panel('Cumulative R, in order of closing', curve(), {})}
        ${panel('By engine', `<div class="tw"><table class="tbl dense"><thead><tr><th scope="col">Engine</th><th class="r" scope="col">Closed</th><th class="r" scope="col">Win</th><th class="r" scope="col">Exp.</th><th scope="col">95% interval</th></tr></thead><tbody>
          ${engs.map(([k, r]) => `<tr><td>${esc(engLabel(k))}</td><td class="r num">${r.trades}</td><td class="r num">${r.win_rate != null ? r.win_rate + '%' : '—'}</td>
            <td class="r">${r.trades ? `<span class="chg ${r.expectancy_r > 0 ? 'up' : r.expectancy_r < 0 ? 'dn' : 'flat'}">${fmtR(r.expectancy_r)}</span>` : NA}</td>
            <td class="num mut">${spreadTxt(r)}</td></tr>`).join('')}</tbody></table></div>`,
          { flush: true, foot: 'Under 30 closed, an engine\'s interval is wide by construction — read the interval, not the point. Full method on <a href="https://signal.askakshay.com/methodology" target="_blank" rel="noopener">signal.askakshay.com</a>.' })}</div>`;
  };

  V.notfound = async (el) => { setTitle('Not found');
    el.innerHTML = vhead('404', 'No such view', `There is no <code>${esc(location.hash)}</code>. Try search (<span class="kbd">⌘K</span>) or go to the <a href="#/">overview</a>.`); };

  /* ── BOOT ─────────────────────────────────────────────────────────────── */
  async function refreshTicker(force) {
    const r = await F.ticker(force);
    if (r.ok) S.ticker = r.data;
    paintTicker();
    return r;
  }
  /* Live marks for everything a reader is holding an eye on: the watchlist,
     every pending alert and every open signal the ticker's ledger map missed. */
  async function refreshQuotes() {
    const have = tickLedger();
    const want = new Set([...S.watch.map((w) => w.s), ...S.alerts.filter((a) => !a.fired).map((a) => a.s),
      ...openBook().map((r) => bare(r.symbol))].filter((s) => !have[s]));
    if (want.size) Object.assign(S.quotes, await F.quotes([...want]));
    /* Nothing to ask for is a state too: every name is already priced by the
       ticker (or there are none). Left unmarked, the badge would read
       "loading" for ever. */
    else if (S.ticker) mark('Quotes', S.ticker.fetched_at, { note: 'every name priced by the live ticker' });
    else FR.Quotes = { ok: true, na: true, t: Date.now() };
    checkAlerts();
  }
  const tickerP = refreshTicker();

  document.addEventListener('click', (e) => {
    const st = e.target.closest('[data-star]'); if (st) { e.preventDefault(); e.stopPropagation(); toggleWatch(st.dataset.star); return; }
    const sb = e.target.closest('[data-star-btn]'); if (sb) { toggleWatch(sb.dataset.starBtn); sb.textContent = watching(sb.dataset.starBtn) ? 'Watching' : 'Add to watchlist'; return; }
    if (e.target.closest('[data-close]')) { closeLayer(); return; }
    const ac = e.target.closest('[data-act]'); if (ac) { e.preventDefault(); closeLayer(); if (ac.dataset.act === 'theme') toggleTheme(); else openPalette(); return; }
    if (e.target.closest('[data-addopen]')) { for (const s of new Set(openBook().map((r) => bare(r.symbol)))) if (!watching(s)) S.watch.push({ s, pin: false, added: istToday() }); saveWatch(); toast('Open-signal names added'); render(); return; }
    const w = e.target.closest('#layer [data-why], #layer a[href^="#/"]'); if (w && w.matches('a')) closeLayer();
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#layer .pal') ? closeLayer() : openPalette(); return; }
    if (e.key === 'Escape') { closeLayer(); return; }
    if (e.key === '/' && !e.target.closest('input,textarea,select,[contenteditable]') && !$('#layer').innerHTML) { e.preventDefault(); openPalette(); return; }
    trapTab(e);
  });
  $('#kOpen').onclick = openPalette;
  $('#thBtn').onclick = toggleTheme;
  window.addEventListener('hashchange', render);

  /* Live while visible, idle while hidden: a background tab polling Yahoo
     every minute costs the reader battery and the site rate limit for prices
     nobody is looking at. Visibility returning triggers an immediate pass. */
  let beat = 0;
  async function pulse() {
    if (document.visibilityState !== 'visible') return;
    beat++;
    await refreshTicker();
    await refreshQuotes();
    if (beat % 10 === 0) await F.ledger().then((L) => { if (L.ok) S.ledger = L; });
    if (cur && cur.live) { try { await cur.live(); } catch (e) { /* the next beat retries */ } }
    paintBadges();
  }
  setInterval(pulse, 60000);
  setInterval(paintBadges, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pulse(); });

  F.ledger().then((L) => { if (L.ok) { S.ledger = L; } });
  paintTicker();
  paintAlertDot();
  render();
})();
