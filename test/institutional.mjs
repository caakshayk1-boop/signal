/* Unit tests for the institutional movement calculator.
 * Pure functions, no network — runs in milliseconds and guards the arithmetic
 * that every chip, sort and badge on the Screen is derived from.
 *   node test/institutional.mjs
 */
import assert from 'node:assert/strict';
import {
  parseFilingDate, isQuarterEnd, quarterLabel, quarterSeq, normaliseQuarters,
  classify, streakOf, strengthScore, scoreBand, institutionalFor, MATERIAL_PP,
} from '../scripts/institutional/compute.mjs';
import { parseShp } from '../scripts/institutional/parse.mjs';

let n = 0, bad = 0;
const t = (name, fn) => { n++; try { fn(); } catch (e) { bad++; console.error(`✗ ${name}\n  ${e.message}`); } };

/* ── dates and quarters ─────────────────────────────────────────────────── */
t('parses NSE filing dates', () => {
  assert.deepEqual(parseFilingDate('30-JUN-2026'), { d: 30, m: 6, y: 2026 });
  assert.equal(parseFilingDate('garbage'), null);
});

t('only real quarter-ends count as quarters', () => {
  assert.equal(isQuarterEnd(parseFilingDate('30-JUN-2026')), true);
  assert.equal(isQuarterEnd(parseFilingDate('31-MAR-2026')), true);
  assert.equal(isQuarterEnd(parseFilingDate('31-DEC-2025')), true);
  assert.equal(isQuarterEnd(parseFilingDate('30-SEP-2025')), true);
  // The three interim filings actually present in NSE's live feed.
  assert.equal(isQuarterEnd(parseFilingDate('13-AUG-2026')), false, 'APARINDS interim');
  assert.equal(isQuarterEnd(parseFilingDate('29-OCT-2024')), false, 'RELIANCE interim');
  assert.equal(isQuarterEnd(parseFilingDate('08-DEC-2021')), false, 'RELIANCE interim');
  assert.equal(isQuarterEnd(parseFilingDate('30-JUN-2026')) && !isQuarterEnd(parseFilingDate('29-JUN-2026')), true);
});

t('Indian fiscal quarter labels', () => {
  assert.equal(quarterLabel(parseFilingDate('30-JUN-2026')), 'Q1 FY27');
  assert.equal(quarterLabel(parseFilingDate('30-SEP-2026')), 'Q2 FY27');
  assert.equal(quarterLabel(parseFilingDate('31-DEC-2026')), 'Q3 FY27');
  assert.equal(quarterLabel(parseFilingDate('31-MAR-2026')), 'Q4 FY26');
});

t('adjacent quarters differ by exactly one in sequence', () => {
  const jun26 = quarterSeq(parseFilingDate('30-JUN-2026'));
  const mar26 = quarterSeq(parseFilingDate('31-MAR-2026'));
  const dec25 = quarterSeq(parseFilingDate('31-DEC-2025'));
  assert.equal(jun26 - mar26, 1);
  assert.equal(mar26 - dec25, 1, 'crosses the calendar year');
});

const F = (date, fii, dii, extra = {}) =>
  ({ date, fii, dii, promoter: 50, publicHold: 50, filedAt: date, ...extra });

t('interim filings are dropped from the series', () => {
  const s = normaliseQuarters([F('13-AUG-2026', 20, 20), F('30-JUN-2026', 18, 22), F('31-MAR-2026', 17, 21)]);
  assert.equal(s.length, 2);
  assert.equal(s[0].period, 'Q1 FY27');
});

t('a revised filing supersedes the original for the same quarter', () => {
  const s = normaliseQuarters([
    { ...F('30-JUN-2026', 10, 10), filedAt: '16-JUL-2026' },
    { ...F('30-JUN-2026', 12, 11), filedAt: '20-AUG-2026' },
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].fii, 12, 'later broadcast wins');
});

/* ── the core rule: a gap is not a change ───────────────────────────────── */
t('non-consecutive quarters yield null, NOT zero', () => {
  const r = institutionalFor([F('30-JUN-2026', 18, 22), F('31-DEC-2025', 12, 20)]); // Mar-26 missing
  assert.equal(r.fii_pp, null, 'must not subtract across a missing quarter');
  assert.equal(r.dii_pp, null);
  assert.equal(r.quality, 'partial');
  assert.equal(r.signal, 'unknown');
  assert.equal(r.score, null, 'no score without a comparable quarter');
  assert.match(r.reason, /not the quarter before/);
});

t('a single filing is partial, not neutral', () => {
  const r = institutionalFor([F('30-JUN-2026', 18, 22)]);
  assert.equal(r.quality, 'partial');
  assert.equal(r.fii_pp, null);
  assert.equal(r.signal, 'unknown');
});

t('no quarter-end filing at all is unavailable', () => {
  assert.equal(institutionalFor([F('13-AUG-2026', 20, 20)]).quality, 'unavailable');
  assert.equal(institutionalFor([]).quality, 'unavailable');
});

t('change is percentage POINTS, not relative percent', () => {
  const r = institutionalFor([F('30-JUN-2026', 12, 20), F('31-MAR-2026', 10, 20)]);
  assert.equal(r.fii_pp, 2, '10% → 12% is +2.00 pp, never +20%');
});

/* ── classification ─────────────────────────────────────────────────────── */
t('classifies the six states', () => {
  assert.equal(classify(0.5, 0.5).code, 'strong_accumulation');
  assert.equal(classify(0.5, 0.1).code, 'fii_accumulation');
  assert.equal(classify(0.1, 0.5).code, 'dii_accumulation');
  assert.equal(classify(-0.5, -0.5).code, 'distribution');
  assert.equal(classify(-0.5, 0.5).code, 'rotation');
  assert.equal(classify(0.1, 0.1).code, 'neutral');
  assert.equal(classify(null, 0.5).code, 'unknown');
});

t('rotation needs twice the gate on BOTH legs', () => {
  // Offsetting moves that clear materiality but not the rotation bar are the
  // market's baseline, not an event.
  assert.equal(classify(0.3, -0.3).code, 'neutral', 'small offsetting moves are not rotation');
  assert.equal(classify(-0.4, 0.45).code, 'neutral');
  assert.equal(classify(0.6, -0.55).code, 'rotation', 'both legs clear 0.50 pp');
  assert.equal(classify(1.2, -0.3).code, 'neutral', 'one big leg alone is not rotation');
  // A one-sided move keeps the plain gate — nothing here made accumulation harder.
  assert.equal(classify(0.3, 0.0).code, 'fii_accumulation');
});

t('rotation names its direction', () => {
  assert.equal(classify(-1.2, 0.95).direction, 'FII selling → DII buying');
  assert.equal(classify(1.2, -0.95).direction, 'DII selling → FII buying');
});

t('the threshold is a real gate, and is inclusive at the boundary', () => {
  assert.equal(classify(MATERIAL_PP, MATERIAL_PP).code, 'strong_accumulation');
  assert.equal(classify(0.24, 0.24).code, 'neutral', 'below threshold is not a signal');
});

/* ── streaks ────────────────────────────────────────────────────────────── */
t('counts consecutive material quarters, and a gap ends the streak', () => {
  const rising = normaliseQuarters([
    F('30-JUN-2026', 13, 20), F('31-MAR-2026', 12, 20),
    F('31-DEC-2025', 11, 20), F('30-SEP-2025', 10, 20)]);
  assert.equal(streakOf(rising, 'fii'), 3);

  const gapped = normaliseQuarters([
    F('30-JUN-2026', 13, 20), F('31-MAR-2026', 12, 20), F('30-SEP-2025', 10, 20)]);
  assert.equal(streakOf(gapped, 'fii'), 1, 'Dec-25 missing, so the streak stops at 1');
});

t('a falling streak is negative', () => {
  const s = normaliseQuarters([
    F('30-JUN-2026', 10, 20), F('31-MAR-2026', 11, 20), F('31-DEC-2025', 12, 20)]);
  assert.equal(streakOf(s, 'fii'), -2);
});

t('an immaterial latest quarter means no streak', () => {
  const s = normaliseQuarters([
    F('30-JUN-2026', 12.1, 20), F('31-MAR-2026', 12, 20), F('31-DEC-2025', 11, 20)]);
  assert.equal(streakOf(s, 'fii'), 0);
});

/* ── acceleration ───────────────────────────────────────────────────────── */
t('acceleration is the change in the change, and needs three quarters', () => {
  const r = institutionalFor([F('30-JUN-2026', 14, 20), F('31-MAR-2026', 12, 20), F('31-DEC-2025', 11, 20)]);
  assert.equal(r.fii_pp, 2);
  assert.equal(r.fii_accel_pp, 1, '+2.0 pp this quarter after +1.0 pp last = +1.0 pp acceleration');

  const two = institutionalFor([F('30-JUN-2026', 14, 20), F('31-MAR-2026', 12, 20)]);
  assert.equal(two.fii_accel_pp, null, 'two quarters cannot show acceleration');
});

/* ── the score ──────────────────────────────────────────────────────────── */
t('score is null when nothing can be measured, never 50', () => {
  assert.equal(strengthScore({ fiiPp: null, diiPp: null, instiStreak: 3, fiiAccelPp: null, diiAccelPp: null }), null);
});

t('flat quarter scores neutral; accumulation scores above it', () => {
  const flat = strengthScore({ fiiPp: 0, diiPp: 0, instiStreak: 0, fiiAccelPp: 0, diiAccelPp: 0 });
  assert.equal(flat, 50);
  const up = strengthScore({ fiiPp: 1.0, diiPp: 0.5, instiStreak: 2, fiiAccelPp: 0.3, diiAccelPp: 0.2 });
  assert.ok(up > 50 && up <= 100, `expected >50, got ${up}`);
  const dn = strengthScore({ fiiPp: -1.0, diiPp: -0.5, instiStreak: -2, fiiAccelPp: -0.3, diiAccelPp: -0.2 });
  assert.equal(dn, 100 - up, 'the model is symmetric');
});

t('saturation stops one extreme move owning the score', () => {
  const big  = strengthScore({ fiiPp: 5,  diiPp: 0, instiStreak: 0, fiiAccelPp: null, diiAccelPp: null });
  const huge = strengthScore({ fiiPp: 40, diiPp: 0, instiStreak: 0, fiiAccelPp: null, diiAccelPp: null });
  assert.equal(big, huge, 'beyond 2 pp there is no more credit to earn');
  assert.ok(huge < 100, 'FII alone cannot max the composite');
});

t('acceleration does not move a name whose quarter was immaterial', () => {
  // Both changes inside the band, but a big swing off a negative prior quarter.
  const flat = strengthScore({ fiiPp: 0.19, diiPp: 0.14, instiStreak: 0,
                               fiiAccelPp: 1.2, diiAccelPp: 1.0 });
  assert.ok(Math.abs(flat - 50) <= 4, `a flat quarter must read ~50, got ${flat}`);
  // The same acceleration DOES count once the move itself clears the gate.
  const real = strengthScore({ fiiPp: 0.8, diiPp: 0.6, instiStreak: 1,
                               fiiAccelPp: 1.2, diiAccelPp: 1.0 });
  assert.ok(real > 65, `a material accelerating quarter should score well, got ${real}`);
});

t('score bands', () => {
  assert.equal(scoreBand(85).code, 'strong_accum');
  assert.equal(scoreBand(70).code, 'positive');
  assert.equal(scoreBand(50).code, 'neutral');
  assert.equal(scoreBand(30).code, 'weakening');
  assert.equal(scoreBand(10).code, 'strong_dist');
  assert.equal(scoreBand(null), null);
});

/* ── provenance ─────────────────────────────────────────────────────────── */
t('every reading names both periods it used', () => {
  const r = institutionalFor([F('30-JUN-2026', 12, 21), F('31-MAR-2026', 10, 20)]);
  assert.equal(r.period, 'Q1 FY27');
  assert.equal(r.prev_period, 'Q4 FY26');
  assert.equal(r.period_end, '2026-06-30');
  assert.equal(r.quality, 'complete');
  assert.equal(r.insti_pp, 3, 'total institutional = FII + DII change');
});

/* ── the parser ─────────────────────────────────────────────────────────── */
t('parser ignores per-shareholder rows and sub-categories', () => {
  const xml = `
   <xbrli:xbrl xmlns:in-bse-shp="http://www.bseindia.com/xbrl/shp/2025-10-31/in-bse-shp">
   <xbrli:context id="A"><xbrli:scenario><xbrldi:explicitMember dimension="d">in-bse-shp:InstitutionsForeignMember</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
   <xbrli:context id="B"><xbrli:scenario><xbrldi:explicitMember dimension="d">in-bse-shp:InstitutionsForeignMember</xbrldi:explicitMember><xbrldi:typedMember dimension="t"><x>FUND A</x></xbrldi:typedMember></xbrli:scenario></xbrli:context>
   <xbrli:context id="C"><xbrli:scenario><xbrldi:explicitMember dimension="d">in-bse-shp:InstitutionsDomesticMember</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
   <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="A" unitRef="u" decimals="4">0.1720</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>
   <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="B" unitRef="u" decimals="4">0.0900</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>
   <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="C" unitRef="u" decimals="4">0.2119</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>`;
  const r = parseShp(xml);
  assert.equal(r.fii, 17.2, 'the named-fund row must not overwrite the category total');
  assert.equal(r.dii, 21.19);
});

/* ── the two taxonomies ─────────────────────────────────────────────────── */
const shpDoc = (nsDate, promoter, pub, fii, dii) => `
 <xbrli:xbrl xmlns:in-bse-shp="http://www.bseindia.com/xbrl/shp/${nsDate}/in-bse-shp">
 <xbrli:context id="P"><xbrli:scenario><xbrldi:explicitMember dimension="d">in-bse-shp:ShareholdingOfPromoterAndPromoterGroupMember</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
 <xbrli:context id="U"><xbrli:scenario><xbrldi:explicitMember dimension="d">in-bse-shp:PublicShareholdingMember</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
 <xbrli:context id="F"><xbrli:scenario><xbrldi:explicitMember dimension="d">in-bse-shp:InstitutionsForeignMember</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
 <xbrli:context id="D"><xbrli:scenario><xbrldi:explicitMember dimension="d">in-bse-shp:InstitutionsDomesticMember</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
 <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="P">${promoter}</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>
 <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="U">${pub}</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>
 <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="F">${fii}</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>
 <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="D">${dii}</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>
 </xbrli:xbrl>`;

t('both SEBI taxonomies yield the SAME percentage', () => {
  // NSE's archive serves both for one company. 2025-10-31 writes fractions;
  // 2022-09-30 writes percentages. QPOWER's real 73.91% promoter stake.
  const modern = parseShp(shpDoc('2025-10-31', 0.7391, 0.2609, 0.0336, 0.0645));
  const legacy = parseShp(shpDoc('2022-09-30', 73.91,  26.09,  3.36,   6.45));
  assert.equal(modern.promoter, 73.91);
  assert.equal(legacy.promoter, 73.91, 'the old taxonomy must not be scaled again');
  assert.equal(modern.fii, 3.36);
  assert.equal(legacy.fii, 3.36);
  assert.deepEqual(modern, legacy, 'the two formats must be indistinguishable downstream');
});

t('a holding can never exceed 100%', () => {
  for (const r of [parseShp(shpDoc('2022-09-30', 73.91, 26.09, 3.36, 6.45)),
                   parseShp(shpDoc('2025-10-31', 0.7391, 0.2609, 0.0336, 0.0645))]) {
    for (const [k, v] of Object.entries(r)) {
      if (v != null) assert.ok(v >= 0 && v <= 100, `${k} = ${v} is not a percentage`);
    }
  }
});

t('an unreadable scale returns nulls rather than a guess', () => {
  // promoter + public = 5.0: neither a fraction nor a percentage reading.
  const r = parseShp(shpDoc('1999-01-01', 3, 2, 1, 1));
  assert.equal(r.promoter, null);
  assert.equal(r.fii, null);
});

console.log(bad ? `\n${bad} of ${n} FAILED` : `\n${n}/${n} institutional assertions pass`);
process.exit(bad ? 1 : 0);
