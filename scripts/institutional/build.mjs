/* ── BUILD public/institutional.json ─────────────────────────────────────────
 *
 *   NSE shareholding master (per symbol, ~17 KB)
 *        ↓  pick the newest canonical quarter-ends only
 *   SHP XBRL per quarter (200 KB – 1.3 MB)   ← cached by recordId, forever
 *        ↓  parse.mjs
 *   seven percentages per quarter
 *        ↓  compute.mjs
 *   QoQ · acceleration · streaks · classification · score
 *        ↓
 *   public/institutional.json   (the only thing the browser ever sees)
 *
 * WHY THE CACHE IS COMMITTED. A shareholding pattern for a quarter that has
 * closed never changes except by a formal revision, and a revision arrives
 * under a NEW recordId. So a parsed quarter is immutable and re-downloading it
 * is pure waste: the first full run moves about a gigabyte, every run after it
 * moves a few megabytes. The cache holds the seven numbers, not the XML —
 * roughly 120 bytes a quarter against 260 KB — which is why it can live in git
 * instead of in a CI cache that expires and silently triggers a 1 GB refetch.
 *
 * WHAT A FAILURE DOES. Nothing, loudly. A symbol that cannot be fetched is
 * recorded as unavailable and the run continues; the feed carries a coverage
 * count and the UI states it. A run that resolves fewer than half the universe
 * exits non-zero WITHOUT writing, so a bad night leaves yesterday's good feed
 * in place rather than replacing it with a mostly-empty one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { institutionalFor, parseFilingDate, isQuarterEnd, quarterSeq } from './compute.mjs';
import { parseShp } from './parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, 'cache.json');
const OUT   = path.join(ROOT, 'public', 'institutional.json');

/** Quarters kept per symbol. Five is the minimum that supports a 3-quarter
 *  streak AND the acceleration term (which needs three consecutive quarters of
 *  its own); six leaves one spare for a revision landing out of order. */
const QUARTERS = 6;
const CONCURRENCY = 6;
const NSE = 'https://www.nseindia.com';

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${NSE}/`,
};

/* ── BEING A POLITE CLIENT, AND WHY IT IS NOT OPTIONAL ───────────────────────
 *
 * NSE rate-limits by IP and does it in TWO stages, the first of which is a
 * trap. Stage one: the API keeps answering 200 and returns `[]` — a body
 * indistinguishable from a company that has genuinely never filed. Stage two,
 * if you keep going: a flat 403 across the API *and* the nsearchives CDN.
 *
 * The first version of this script ran six-way concurrent with no pacing. It
 * reported 2.8% coverage and ZERO errors, because 713 of 750 symbols came back
 * 200 `[]`, and it then got the IP blocked outright. Both of those are the
 * same bug: treating a throttle as an answer.
 *
 * So this layer is built around three rules.
 *   1. ONE request in flight, with a floor on the gap between them. Throughput
 *      is not the constraint here — a quarterly dataset has no deadline.
 *   2. An empty array is a SUSPECTED throttle, not a result. It escalates the
 *      backoff exactly like a 403 does, and only a second empty answer after a
 *      full re-warm is believed.
 *   3. The run gives up cleanly rather than hammering. Sustained failure ends
 *      the pass, saves the cache, and writes what was already resolved — so
 *      the next run resumes instead of restarting.
 */
let COOKIE = '';
let lastReq = 0;
let penalty = 0;                  // ms added to the floor after a throttle

const MIN_GAP_MS  = Number(process.env.INSTI_GAP_MS || 900);
const MAX_MINUTES = Number(process.env.INSTI_MAX_MIN || 20);
const BACKOFFS    = [2000, 6000, 20000, 60000];
const startedAt   = Date.now();

const sleep = ms => new Promise(s => setTimeout(s, ms));
const outOfTime = () => (Date.now() - startedAt) > MAX_MINUTES * 60_000;

async function pace() {
  const wait = (lastReq + MIN_GAP_MS + penalty) - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
}

/* A re-warm that cannot silently keep a dead cookie.
 *
 * The first version only assigned when the homepage actually replied with
 * Set-Cookie: `if (set.length) COOKIE = ...`. NSE does not always re-issue one
 * on a repeat hit, so once a cookie went stale every subsequent "re-warm"
 * was a no-op that looked like a recovery attempt — the harvest sat at zero
 * for eleven minutes while a hand probe with a fresh cookie succeeded.
 *
 * So: no cookie back means the old one is DISCARDED, not kept. A request with
 * no cookie fails fast and honestly; a request with a cookie that stopped
 * working fails as an empty array, which is the failure this whole module is
 * built to avoid trusting. */
async function warm() {
  await pace();
  const r = await fetch(NSE, {
    headers: { ...HDRS, Accept: 'text/html', 'Cache-Control': 'no-cache' },
  });
  const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  COOKIE = set.map(c => c.split(';')[0]).join('; ');
  return COOKIE;
}

class Throttled extends Error {}

/* Raises Throttled on a 403 so the caller can decide whether to back off or
 * abandon the run — a retry loop buried in here cannot know the difference
 * between "this symbol is unlucky" and "this IP is done for the night". */
async function nseGet(url, { json = true } = {}) {
  await pace();
  let r;
  try {
    r = await fetch(url, { headers: { ...HDRS, Cookie: COOKIE } });
  } catch (e) {
    /* A TRANSPORT FAILURE IS A THROTTLE UNTIL PROVEN OTHERWISE.
     * NSE's third way of saying no is neither an empty array nor a 403: it is
     * refusing the connection, which surfaces from undici as the entirely
     * uninformative `TypeError: fetch failed`. Because that is not an HTTP
     * status it escaped the throttle path, propagated out, and was counted as
     * a dead symbol — 730 of 750 in one run, each failing in milliseconds
     * while the run reported no throttling whatsoever.
     * Classifying it as a throttle is right on the evidence (it appears in
     * bursts, after volume, and clears on backoff) and safe if it is not: the
     * worst case is that a genuinely unreachable host is retried four times
     * with waits before the symbol is given up. */
    throw new Throttled(`transport: ${e && e.message ? e.message : 'fetch failed'}`);
  }
  if (r.status === 403 || r.status === 401 || r.status === 429) throw new Throttled(`HTTP ${r.status}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try {
    return json ? await r.json() : await r.text();
  } catch (e) {
    // The body died mid-read — same class of failure as the connect above.
    throw new Throttled(`body: ${e && e.message ? e.message : 'read failed'}`);
  }
}

/** Run `fn`, escalating through BACKOFFS on throttle. Returns null if the
 *  whole ladder is exhausted — the caller treats that as "stop the run". */
async function withBackoff(fn, stats) {
  for (let i = 0; i <= BACKOFFS.length; i++) {
    try {
      const v = await fn();
      penalty = Math.max(0, penalty - 100);       // earn the pace back slowly
      return v;
    } catch (e) {
      if (!(e instanceof Throttled)) throw e;
      if (i === BACKOFFS.length) return null;
      stats.throttled++;
      penalty = Math.min(4000, penalty + 300);
      await sleep(BACKOFFS[i]);
      try { await warm(); } catch { /* the next attempt will fail too */ }
    }
  }
  return null;
}

const loadJSON = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};

/** The universe is whatever the screen screens — one source of truth for
 *  "which names does this site cover", so the two can never drift apart. */
function universe() {
  const s = loadJSON(path.join(ROOT, 'public', 'screen.json'), null);
  const rows = (s && s.rows) || [];
  return [...new Set(rows.map(r => r && r.sym).filter(Boolean))];
}

/* THE SILENT THROTTLE.
 * When NSE's session cookie lapses mid-run the API does NOT answer 403. It
 * answers 200 with `[]` — indistinguishable from a company that has genuinely
 * never filed a shareholding pattern. The first full run of this script hit it
 * at symbol ~30 and reported 2.8% coverage with zero errors: every request
 * "succeeded". So an empty master is treated as SUSPECT, not as an answer:
 * re-warm the cookie and ask once more. A genuinely empty symbol (ZOMATO after
 * the rename to ETERNAL, TATAMOTORS after the demerger) costs one extra
 * request and is then believed. */
async function masterFor(sym, stats) {
  const url = `${NSE}/api/corporate-share-holdings-master?index=equities&symbol=${encodeURIComponent(sym)}`;
  let m = await withBackoff(() => nseGet(url), stats);
  if (m === null) return null;                       // throttled out
  if (Array.isArray(m) && m.length) return m;
  // Empty is suspect, not an answer. Re-warm and ask once more before
  // believing that a listed company has never filed a shareholding pattern.
  await warm();
  m = await withBackoff(() => nseGet(url), stats);
  if (m === null) return null;
  return Array.isArray(m) ? m : [];
}

async function filingsFor(sym, cache, stats) {
  const master = await masterFor(sym, stats);
  if (master === null) return null;                  // caller stops the run
  if (!master.length) { stats.emptyMaster++; return []; }

  const wanted = [];
  const seen = new Set();
  for (const rec of master) {
    const dt = parseFilingDate(rec.date);
    if (!isQuarterEnd(dt)) { stats.interim++; continue; }
    const seq = quarterSeq(dt);
    if (seen.has(seq)) continue;
    seen.add(seq);
    wanted.push(rec);
    if (wanted.length >= QUARTERS) break;
  }

  const out = [];
  for (const rec of wanted) {
    const id = String(rec.recordId || `${sym}:${rec.date}`);
    let vals = cache[id];
    if (!vals) {
      if (!rec.xbrl) { stats.noXbrl++; continue; }
      /* ONE BAD QUARTER MUST NOT COST THE WHOLE COMPANY.
       * NSE's archive carries malformed links for some older filings — BSE's
       * own 31-MAR-2025 entry points at a URL ending in "/-" and 404s. The
       * first version let that 404 propagate out of filingsFor, where main's
       * catch skipped the SYMBOL: 715 of 750 companies were dropped for the
       * sake of one unreadable historical quarter each, silently, with the run
       * reporting no errors at all.
       * A missing quarter is a GAP, which compute.mjs already handles by
       * refusing to measure across it. Only a throttle — which means the next
       * request will fail too — is allowed to stop the symbol. */
      let xml;
      try {
        xml = await withBackoff(() => nseGet(rec.xbrl, { json: false }), stats);
      } catch (e) {
        stats.xbrlFail++;                 // 404, malformed URL, socket reset
        continue;
      }
      if (xml === null) return out.length ? out : null;   // throttled: keep what we got
      try { vals = parseShp(xml); } catch { stats.xbrlFail++; continue; }
      // The entry carries its OWN symbol and period. Without them the cache is
      // only a lookup table keyed by a record id, and rebuilding the feed
      // needs the network again just to learn which rows belong to which
      // company. With them the cache is the dataset, and the feed is a pure
      // function of it — which is what lets a fully rate-limited run still
      // publish everything previous runs collected.
      vals = { ...vals, sym, date: rec.date, filedAt: rec.systemDate || rec.broadcastDate || '' };
      cache[id] = vals;
      stats.fetched++;
    } else stats.cached++;
    out.push({ ...vals, date: rec.date, filedAt: rec.systemDate || rec.broadcastDate || '' });
  }
  return out;
}

/* Symbols with nothing cached go first, so a short run always ADDS coverage
 * rather than re-confirming the names it already knows. Within that, the
 * screen's own order, which is its ranking — the names most likely to be
 * looked at get data first. */
/* THE FEED IS WRITTEN AT EVERY CHECKPOINT, NOT ONLY AT THE END.
 * A 55-minute backfill that publishes nothing until minute 55 has a 55-minute
 * window in which being killed — a timeout, a cancelled workflow, a laptop
 * closing — throws away everything it collected. Writing at each checkpoint
 * costs a few hundred milliseconds and means the run is never worth less than
 * the last checkpoint. The cache is written in the same breath, so the two can
 * never describe different states. */
function writeFeed(rows, universeSize) {
  const latest = Object.values(rows).map(r => r.period_end).filter(Boolean).sort();
  fs.writeFileSync(OUT, JSON.stringify({
    ok: true,
    generated_at: new Date().toISOString(),
    source: 'NSE corporate shareholding pattern (SEBI SHP XBRL)',
    threshold_pp: 0.25,
    universe: universeSize,
    measured: Object.values(rows).filter(r => r.quality === 'complete').length,
    partial: Object.values(rows).filter(r => r.quality === 'partial').length,
    unavailable: universeSize - Object.keys(rows).length,
    latest_period_end: latest[latest.length - 1] || null,
    rows,
  }));
}

function order(syms, prev) {
  const known = new Set(Object.keys((prev && prev.rows) || {}));
  return [...syms.filter(s => !known.has(s)), ...syms.filter(s => known.has(s))];
}

async function main() {
  const syms = universe();
  if (!syms.length) { console.error('No universe — public/screen.json missing or empty.'); process.exit(1); }
  const cache = loadJSON(CACHE, {});
  const prev  = loadJSON(OUT, null);
  const before = Object.keys(cache).length;
  const stats = { fetched: 0, cached: 0, interim: 0, noXbrl: 0, xbrlFail: 0,
                  emptyMaster: 0, throttled: 0, symFail: 0, errors: {}, stoppedEarly: false };

  // Carry forward everything already measured. A shareholding pattern for a
  // closed quarter does not change, so a name resolved by a previous run stays
  // resolved — this is what makes a 20-minute nightly run accumulate into full
  // coverage instead of racing the rate limiter for all 750 every time.
  const rows = { ...((prev && prev.rows) || {}) };

  /* Everything the cache knows, grouped by company. Entries written before the
   * cache carried its own symbol are skipped here — they still serve the
   * online path, where the master supplies the identity. */
  const fromCache = () => {
    const by = new Map();
    for (const v of Object.values(cache)) {
      if (!v || !v.sym || !v.date) continue;
      if (!by.has(v.sym)) by.set(v.sym, []);
      by.get(v.sym).push(v);
    }
    return by;
  };

  await warm().catch(() => {});
  let done = 0;
  for (const sym of order(syms, prev)) {
    if (outOfTime()) { stats.stoppedEarly = 'time budget'; break; }
    let f;
    try { f = await filingsFor(sym, cache, stats); }
    catch (e) {
      // Counted and named. A bare `continue` here is what let 715 symbols
      // vanish without the run knowing: a skip that nothing counts is
      // indistinguishable from a company that has no data.
      stats.symFail++;
      (stats.errors[e && e.message ? e.message.slice(0, 40) : 'unknown'] ??= 0);
      stats.errors[e && e.message ? e.message.slice(0, 40) : 'unknown']++;
      continue;
    }
    if (f === null) { stats.stoppedEarly = 'throttled out'; break; }
    if (f.length) {
      const r = institutionalFor(f);
      if (r.quality !== 'unavailable') rows[sym] = r;
    }
    if (++done % 25 === 0) {
      process.stderr.write(`  ${done} scanned · ${Object.keys(rows).length} held · ` +
                           `${stats.fetched} fetched · ${stats.throttled} throttled\n`);
      fs.writeFileSync(CACHE, JSON.stringify(cache));   // checkpoint
      const snap = { ...rows };
      for (const [s, filings] of fromCache()) {
        const c = institutionalFor(filings);
        if (c.quality !== 'unavailable') snap[s] = c;
      }
      writeFeed(snap, syms.length);
    }
  }

  fs.writeFileSync(CACHE, JSON.stringify(cache));

  // Recompute from the cache LAST, so a run that was throttled before it
  // reached the network still publishes every quarter previous runs banked,
  // and so a change to compute.mjs takes effect without refetching anything.
  for (const [sym, filings] of fromCache()) {
    const r = institutionalFor(filings);
    if (r.quality !== 'unavailable') rows[sym] = r;
  }

  const measured = Object.values(rows).filter(r => r.quality === 'complete').length;
  const prevMeasured = Object.values((prev && prev.rows) || {})
    .filter(r => r.quality === 'complete').length;

  console.error(`cache ${before} → ${Object.keys(cache).length} entries`);
  console.error(`stats ${JSON.stringify(stats)}`);
  console.error(`measured ${prevMeasured} → ${measured} of ${syms.length}`);

  /* THE GUARD PROTECTS AGAINST REGRESSION, NOT AGAINST BEING SMALL.
   * An absolute coverage floor was the wrong rule: it refused to write on the
   * very first run, when there was nothing to protect, and it would have kept
   * refusing while coverage built up. What actually must never happen is a
   * throttled night REPLACING a good feed with a thinner one. */
  // Nothing resolved and nothing to fall back on is a failed run, not an empty
  // market. Writing it would publish a feed that says "no institutional data
  // exists for any Indian company", which the UI would faithfully render.
  if (!measured && !Object.keys(rows).length) {
    console.error('REFUSING TO WRITE: nothing resolved this run and no previous feed to keep.');
    process.exit(1);
  }
  if (prev && measured < prevMeasured * 0.9) {
    console.error(`REFUSING TO WRITE: ${measured} measured is a regression on ${prevMeasured}. Feed left in place.`);
    process.exit(1);
  }

  writeFeed(rows, syms.length);
  console.error(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)` +
                (stats.stoppedEarly ? ` — stopped early: ${stats.stoppedEarly}` : ''));
}

main().catch(e => { console.error(e); process.exit(1); });
