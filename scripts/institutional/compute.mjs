/* ── INSTITUTIONAL MOVEMENT: THE CALCULATOR ──────────────────────────────────
 *
 * Pure functions. No network, no filesystem, no dates-from-now — everything
 * here is a function of the filings handed to it, which is what makes it
 * testable (test/institutional.mjs) and what keeps the browser out of the
 * business of deriving trends from 22 quarters of XBRL.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * A quarter-on-quarter change is only a change if the two quarters are
 * ADJACENT. NSE's shareholding master mixes real quarter-ends with interim
 * filings — the live feed on the day this was written carried 13-AUG-2026 for
 * APARINDS, 29-OCT-2024 and 08-DEC-2021 for RELIANCE. Subtracting across those
 * produces a number that looks exactly like a quarterly move and is not one.
 * So: non-quarter-end filings are DROPPED, and a missing previous quarter
 * yields null, never zero. "No data" and "no change" are different answers and
 * the screener must never conflate them.
 *
 * UNITS. Every holding is a percentage of total shares (17.2 means 17.2%).
 * Every change is in PERCENTAGE POINTS. FII 10% → 12% is +2.00 pp, never +20%.
 * The suffix `_pp` is on every changed field so the unit travels with it.
 */

/** Percentage points below which a move is noise, not news. */
export const MATERIAL_PP = 0.25;

/* Saturation constants for the score. A quarterly move of 2 pp in FII holding
 * is already an outlier — Reliance's entire FII stake moves less than that in
 * most quarters — so 2 pp is full marks and anything beyond it does not earn
 * more. Without a cap, one microcap with a 30 pp swing would own the top of
 * every sort and the score would just be a re-ranking of that one number. */
const SAT_QOQ_PP   = 2.0;
const SAT_ACCEL_PP = 1.0;
const SAT_STREAK_Q = 3;

const MONTH = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6,
                JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };

/** "30-JUN-2026" → { y, m, d }. Returns null for anything unparseable. */
export function parseFilingDate(s) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(String(s || '').trim().toUpperCase());
  if (!m) return null;
  const mm = MONTH[m[2]];
  if (!mm) return null;
  return { d: +m[1], m: mm, y: +m[3] };
}

/* A canonical quarter-end is the LAST day of March, June, September or
 * December. Everything else is an interim disclosure — a bonus issue, an open
 * offer, a preferential allotment — and belongs to no quarter. */
const QEND = { 3: 31, 6: 30, 9: 30, 12: 31 };

export function isQuarterEnd(dt) {
  return !!dt && QEND[dt.m] === dt.d;
}

/* Sequence number, so "adjacent" is `seq - 1` and nothing has to reason about
 * calendars. Mar=0, Jun=1, Sep=2, Dec=3 within a year. */
export function quarterSeq(dt) {
  return dt.y * 4 + (dt.m / 3 - 1);
}

/* Indian fiscal labelling: FY27 runs Apr-2026 → Mar-2027, so the quarter
 * ending Jun-2026 is Q1 FY27 and the quarter ending Mar-2026 is Q4 FY26.
 * Displayed verbatim in the UI, because "the latest quarter" is not a period a
 * reader can check a filing against. */
export function quarterLabel(dt) {
  const fyEndYear = dt.m <= 3 ? dt.y : dt.y + 1;
  const q = dt.m === 6 ? 1 : dt.m === 9 ? 2 : dt.m === 12 ? 3 : 4;
  return `Q${q} FY${String(fyEndYear).slice(2)}`;
}

export function isoDate(dt) {
  return `${dt.y}-${String(dt.m).padStart(2, '0')}-${String(dt.d).padStart(2, '0')}`;
}

/**
 * Normalise raw filings into a clean, newest-first series of quarter-ends.
 * Drops interim filings, drops anything with no institutional split at all,
 * and de-duplicates a revised filing for the same quarter (NSE republishes a
 * corrected pattern under a new recordId — the later broadcast wins).
 */
export function normaliseQuarters(filings) {
  const byQ = new Map();
  for (const f of filings || []) {
    const dt = parseFilingDate(f.date);
    if (!isQuarterEnd(dt)) continue;                 // interim filing — not a quarter
    if (f.fii == null && f.dii == null) continue;    // nothing to measure
    const seq = quarterSeq(dt);
    const prev = byQ.get(seq);
    // A revision supersedes the original. Ordering by the broadcast timestamp
    // rather than by array position, because the master is not always sorted.
    if (!prev || (f.filedAt || '') > (prev.filedAt || '')) {
      byQ.set(seq, { ...f, seq, dt, period: quarterLabel(dt), periodEnd: isoDate(dt) });
    }
  }
  return [...byQ.values()].sort((a, b) => b.seq - a.seq);
}

const pp = (a, b) => (a == null || b == null) ? null : Math.round((a - b) * 100) / 100;

/** Change from the immediately preceding quarter, or null if there isn't one. */
function qoq(series, i, key) {
  const cur = series[i], prev = series[i + 1];
  if (!cur || !prev) return null;
  if (prev.seq !== cur.seq - 1) return null;        // a gap is not a change
  return pp(cur[key], prev[key]);
}

/**
 * How many consecutive quarters this holding has moved materially in one
 * direction, ending at the latest quarter. Positive = rising, negative =
 * falling, 0 = the latest quarter is not a material move either way.
 * A gap in the series ends the streak — an unmeasurable quarter cannot be
 * counted as continuation.
 */
export function streakOf(series, key, threshold = MATERIAL_PP) {
  const first = qoq(series, 0, key);
  if (first == null || Math.abs(first) < threshold) return 0;
  const sign = Math.sign(first);
  let n = 0;
  for (let i = 0; i < series.length - 1; i++) {
    const c = qoq(series, i, key);
    if (c == null || Math.sign(c) !== sign || Math.abs(c) < threshold) break;
    n++;
  }
  return n * sign;
}

/* ── CLASSIFICATION ──────────────────────────────────────────────────────────
 * Six mutually exclusive states, decided only from the two QoQ changes and the
 * threshold. `neutral` is the honest default and covers most of the universe:
 * institutions do not meaningfully move in most names in most quarters, and a
 * screener that says otherwise is manufacturing signal. */
export function classify(fiiPp, diiPp, threshold = MATERIAL_PP) {
  if (fiiPp == null || diiPp == null) return { code: 'unknown', label: 'Not measurable' };
  const fUp = fiiPp >= threshold, fDn = fiiPp <= -threshold;
  const dUp = diiPp >= threshold, dDn = diiPp <= -threshold;
  const fFlat = !fUp && !fDn, dFlat = !dUp && !dDn;

  if (fUp && dUp)   return { code: 'strong_accumulation', label: 'Strong accumulation' };
  if (fDn && dDn)   return { code: 'distribution',        label: 'Institutional distribution' };
  /* ROTATION IS HELD TO A HIGHER BAR THAN A ONE-SIDED MOVE, ON PURPOSE.
   * Foreign and domestic institutional flows in this market are close to
   * mirror images — when one side buys, much of what it buys comes from the
   * other. Small opposite-sign moves are therefore the NULL HYPOTHESIS, not a
   * finding. At the plain materiality gate this label fired on 44% of the
   * measured universe, which is not a signal, it is the weather.
   * Both legs must clear twice the gate before the screen calls it rotation.
   * Offsetting moves below that fall through to "no material change", which is
   * what a small transfer between two institutional pockets amounts to — and
   * the card still prints both raw figures either way, so nothing is hidden by
   * the summary being conservative. */
  if ((fUp && dDn) || (fDn && dUp)) {
    if (Math.abs(fiiPp) >= threshold * 2 && Math.abs(diiPp) >= threshold * 2) return {
      code: 'rotation', label: 'Institutional rotation',
      direction: fDn ? 'FII selling → DII buying' : 'DII selling → FII buying' };
    return { code: 'neutral', label: 'No material change' };
  }
  if (fUp && dFlat) return { code: 'fii_accumulation', label: 'FII accumulation' };
  if (dUp && fFlat) return { code: 'dii_accumulation', label: 'DII accumulation' };
  if (fDn && dFlat) return { code: 'fii_reduction',    label: 'FII reducing' };
  if (dDn && fFlat) return { code: 'dii_reduction',    label: 'DII reducing' };
  return { code: 'neutral', label: 'No material change' };
}

/* ── THE SCORE ───────────────────────────────────────────────────────────────
 * 0–100, and a MODEL rather than a measurement: it is a weighted opinion about
 * four numbers that are themselves all displayed raw beside it. Weights are the
 * brief's — 40 FII / 30 DII / 20 consistency / 10 acceleration.
 *
 * Two deliberate choices:
 *   · Every input is SATURATED before weighting, so one extreme move cannot
 *     dominate the composite (see the constants at the top).
 *   · Missing components RENORMALISE the remaining weights instead of scoring
 *     zero. Scoring a missing acceleration as 0 would push every young listing
 *     toward 50 and quietly call that "neutral" when it is "not known".
 * With no FII and no DII change there is nothing to weigh, and the score is
 * null — not 50. */
const sat = (x, k) => Math.max(-1, Math.min(1, x / k));

export function strengthScore({ fiiPp, diiPp, instiStreak, fiiAccelPp, diiAccelPp },
                              threshold = MATERIAL_PP) {
  const parts = [];
  if (fiiPp != null) parts.push([0.40, sat(fiiPp, SAT_QOQ_PP)]);
  if (diiPp != null) parts.push([0.30, sat(diiPp, SAT_QOQ_PP)]);
  if (instiStreak != null) parts.push([0.20, sat(instiStreak, SAT_STREAK_Q)]);

  /* ACCELERATION IS IGNORED WHERE THE MOVE ITSELF IS NOISE.
   * Acceleration is the second derivative, and it inherits the significance of
   * the first: if this quarter's change is inside the materiality band then the
   * change in that change is inside it too. Without this gate the term went on
   * paying out on flat names — LOTUSDEV filed +0.19 pp FII and +0.14 pp DII,
   * was correctly classified "no material change", and still scored 61 because
   * a swing from a negative prior quarter saturated the acceleration term. A
   * composite that reads 61 beside a badge saying nothing happened is not a
   * ranking, it is a contradiction the reader has to arbitrate. */
  const accel = [
    (fiiPp != null && Math.abs(fiiPp) >= threshold) ? fiiAccelPp : null,
    (diiPp != null && Math.abs(diiPp) >= threshold) ? diiAccelPp : null,
  ].filter(x => x != null);
  if (accel.length) {
    parts.push([0.10, sat(accel.reduce((a, b) => a + b, 0) / accel.length, SAT_ACCEL_PP)]);
  }
  // Nothing to weigh without at least one of the two movements the score is
  // fundamentally about. A composite built only from a streak is not a reading
  // of this quarter, and 50 would read as "neutral" rather than "unknown".
  if (fiiPp == null && diiPp == null) return null;
  const w = parts.reduce((s, [k]) => s + k, 0);
  if (!w) return null;
  const combined = parts.reduce((s, [k, v]) => s + k * v, 0) / w;   // −1 … +1
  return Math.round(50 + 50 * combined);
}

/** The five bands the score is read in. Never shown without the raw numbers. */
export function scoreBand(s) {
  if (s == null) return null;
  if (s >= 80) return { code: 'strong_accum', label: 'Strong accumulation' };
  if (s >= 65) return { code: 'positive',     label: 'Positive interest' };
  if (s >= 40) return { code: 'neutral',      label: 'Neutral' };
  if (s >= 20) return { code: 'weakening',    label: 'Weakening interest' };
  return { code: 'strong_dist', label: 'Strong distribution' };
}

/**
 * The whole layer for one symbol. `filings` is the raw list; everything the
 * frontend consumes comes out of here already computed.
 */
export function institutionalFor(filings, threshold = MATERIAL_PP) {
  const s = normaliseQuarters(filings);
  if (!s.length) return { quality: 'unavailable', reason: 'No quarter-end shareholding filing found' };

  const cur = s[0], prev = s[1];
  const adjacent = !!prev && prev.seq === cur.seq - 1;

  const fii_pp = qoq(s, 0, 'fii');
  const dii_pp = qoq(s, 0, 'dii');
  const instiCur  = (cur.fii == null || cur.dii == null) ? null : cur.fii + cur.dii;
  const instiPrev = (!adjacent || prev.fii == null || prev.dii == null) ? null : prev.fii + prev.dii;
  const insti_pp = pp(instiCur, instiPrev);

  // Acceleration needs THREE consecutive quarters. Change-of-the-change is the
  // second derivative and inherits every gap in the series below it.
  const fiiPrevPp = qoq(s, 1, 'fii');
  const diiPrevPp = qoq(s, 1, 'dii');
  const fii_accel_pp = pp(fii_pp, fiiPrevPp);
  const dii_accel_pp = pp(dii_pp, diiPrevPp);
  // Last quarter's combined move, kept because "turnaround" is a statement
  // about two quarters (was selling, now buying) and deriving it in the
  // browser from insti_pp and an acceleration would reintroduce exactly the
  // gap-handling this module exists to centralise.
  const insti_prev_pp = (fiiPrevPp == null || diiPrevPp == null)
    ? null : Math.round((fiiPrevPp + diiPrevPp) * 100) / 100;

  const sig = classify(fii_pp, dii_pp, threshold);

  // Series with fii+dii for a streak; the streak helper walks it itself.
  const instiSeries = s.map(q => ({ ...q, insti: (q.fii == null || q.dii == null) ? null : q.fii + q.dii }));

  const fii_streak   = streakOf(s, 'fii', threshold);
  const dii_streak   = streakOf(s, 'dii', threshold);
  const insti_streak = streakOf(instiSeries, 'insti', threshold);

  const score = strengthScore({ fiiPp: fii_pp, diiPp: dii_pp,
                                instiStreak: insti_streak,
                                fiiAccelPp: fii_accel_pp, diiAccelPp: dii_accel_pp }, threshold);

  const quality = !adjacent ? 'partial'
                : (fii_pp == null || dii_pp == null) ? 'partial' : 'complete';

  return {
    quality,
    reason: quality === 'partial'
      ? (!prev ? 'Only one quarter-end filing available — no comparison possible'
               : !adjacent ? `Previous filing is ${prev.period}, not the quarter before ${cur.period} — not comparable`
               : 'The latest filing does not split institutional holding')
      : null,
    // Levels, current quarter
    fii: cur.fii, dii: cur.dii,
    insti: instiCur == null ? null : Math.round(instiCur * 100) / 100,
    promoter: cur.promoter, publicHold: cur.publicHold,
    mf: cur.mf, insurance: cur.insurance,
    // Movement, in percentage points
    fii_pp, dii_pp, insti_pp, insti_prev_pp, fii_accel_pp, dii_accel_pp,
    // Trend
    fii_streak, dii_streak, insti_streak,
    // Verdict
    signal: sig.code, signal_label: sig.label, signal_direction: sig.direction || null,
    score, band: scoreBand(score)?.code || null, band_label: scoreBand(score)?.label || null,
    // Provenance — every calculation names the two periods it used
    period: cur.period, period_end: cur.periodEnd,
    prev_period: adjacent ? prev.period : null,
    prev_period_end: adjacent ? prev.periodEnd : null,
    quarters: s.length,
    // A compact series for the sparkline on the card: newest last.
    series: s.slice(0, 8).reverse().map(q => ({ p: q.period, f: q.fii, d: q.dii })),
  };
}
