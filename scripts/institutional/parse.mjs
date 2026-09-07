/* ── SHP XBRL → SEVEN NUMBERS ────────────────────────────────────────────────
 *
 * NSE publishes each shareholding pattern as an XBRL instance of 200 KB–1.3 MB
 * carrying about a hundred facts. Seven of them matter here. This is a targeted
 * extractor rather than a general XBRL reader: no schema resolution, no
 * calculation linkbases, no dependency added to a repo whose whole deploy story
 * is "one Worker, no build step".
 *
 * WHY THE CONTEXT MAP IS NOT OPTIONAL. Every fact points at a contextRef, and
 * the context is the only thing that says WHICH category the number belongs to.
 * The same element — ShareholdingAsAPercentageOfTotalNumberOfShares — appears
 * ~100 times in one file for promoters, for each institution type, for each
 * named shareholder above 1%. Reading the elements without the contexts gives
 * you a hundred plausible percentages and no way to tell FII from a mutual
 * fund. So: contexts first, facts second.
 *
 * Facts whose context carries a `typedMember` are per-shareholder rows (one per
 * named investor). They are skipped — they double-count the category totals.
 *
 * Values arrive as FRACTIONS (0.172) and leave as PERCENTAGES (17.2), because
 * every other holding number on this site is a percentage.
 */

const MEMBERS = {
  InstitutionsForeignMember:           'fii',
  InstitutionsDomesticMember:          'dii',
  ShareholdingOfPromoterAndPromoterGroupMember: 'promoter',
  PublicShareholdingMember:            'publicHold',
  MutualFundsOrUTIMember:              'mf',
  InsuranceCompaniesMember:            'insurance',
  NonInstitutionsMember:               'nonInsti',
};

const PCT_TAG = 'ShareholdingAsAPercentageOfTotalNumberOfShares';

/** Build contextRef → { members[], typed } without a DOM. */
function contexts(xml) {
  const map = new Map();
  const re = /<xbrli:context\s+id="([^"]+)"([\s\S]*?)<\/xbrli:context>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const members = [...body.matchAll(/<xbrldi:explicitMember[^>]*>([^<]+)</g)]
      .map(x => x[1].trim().split(':').pop());
    map.set(m[1], { members, typed: /<xbrldi:typedMember/.test(body) });
  }
  return map;
}

/* ── THE TWO TAXONOMIES, AND WHY THE SCALE IS DETECTED NOT ASSUMED ───────────
 *
 * SEBI's shareholding schema changed how it writes a percentage, and NSE's
 * archive serves both versions side by side in one company's history:
 *
 *   taxonomy 2025-10-31 and later   0.4969   ← a fraction
 *   taxonomy 2022-09-30 and earlier 49.69    ← already a percentage
 *
 * Same company, same quarter's format, same 49.69% promoter stake. A parser
 * that multiplies by 100 unconditionally reads the older file as 4,969% — and
 * the damage is not the absurd number, which is at least visible. It is that
 * every quarter-on-quarter change spanning the boundary becomes a fabricated
 * hundred-point swing, and every streak built on those changes is wrong while
 * looking perfectly well-formed. This was caught by an accessibility label
 * reading "FII 400.0%" on a sparkline; nothing else on the page would have
 * shown it.
 *
 * The scale is therefore DERIVED FROM THE DOCUMENT rather than from a version
 * string. Promoter holding plus public holding is 100% of a company by
 * definition (give or take the small non-promoter-non-public bucket), so the
 * two candidate readings are a clean factor of 100 apart and cannot be
 * confused. The version string is used only to cross-check the answer.
 *
 * A file that satisfies NEITHER reading is not guessed at — it returns nulls,
 * and the company is reported as unmeasurable. */
function detectScale(raw, xml) {
  const haveAnchor = raw.promoter != null && raw.publicHold != null;
  if (haveAnchor) {
    const anchor = raw.promoter + raw.publicHold;
    if (anchor > 0.90 && anchor < 1.10) return 100;      // fractions
    if (anchor > 90   && anchor < 110)  return 1;        // already percentages
    // The invariant is present and satisfies NEITHER reading. That is a
    // malformed or unexpected document, and the taxonomy version must not be
    // allowed to override it: a version string is a property of the wrapper,
    // the invariant is a property of the data. Refuse rather than guess.
    return null;
  }
  // No promoter/public to anchor against — fall back to the declared taxonomy.
  const ns = /xmlns:in-bse-shp="[^"]*\/shp\/(\d{4}-\d{2}-\d{2})\//.exec(xml);
  return ns ? (ns[1] >= '2025-10-31' ? 100 : 1) : null;
}

/**
 * @returns {{fii,dii,promoter,publicHold,mf,insurance,nonInsti}} PERCENTAGES
 *          (17.2 means 17.2%), each null when the filing does not carry that
 *          category or when the file's scale could not be established.
 */
export function parseShp(xml) {
  const ctx = contexts(xml);
  const raw = { fii: null, dii: null, promoter: null, publicHold: null,
                mf: null, insurance: null, nonInsti: null };

  const re = new RegExp(`<in-bse-shp:${PCT_TAG}[^>]*contextRef="([^"]+)"[^>]*>([^<]*)<`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const c = ctx.get(m[1]);
    if (!c || c.typed) continue;                 // per-shareholder row, not a total
    // A category total is tagged with exactly the category. Contexts carrying
    // several members are sub-breakdowns (a category within a category) and
    // would double-count if added.
    if (c.members.length !== 1) continue;
    const key = MEMBERS[c.members[0]];
    if (!key) continue;
    const v = Number(m[2]);
    if (!Number.isFinite(v)) continue;
    if (raw[key] == null) raw[key] = v;           // first (the total) wins
  }

  const scale = detectScale(raw, xml);
  const out = { fii: null, dii: null, promoter: null, publicHold: null,
                mf: null, insurance: null, nonInsti: null };
  if (scale === null) return out;                 // unreadable — never guessed
  for (const k of Object.keys(raw)) {
    if (raw[k] == null) continue;
    const pct = Math.round(raw[k] * scale * 100) / 100;
    // A shareholding percentage outside 0–100 is not a number this file can
    // legitimately carry, whatever the scale said.
    out[k] = (pct >= 0 && pct <= 100.01) ? pct : null;
  }
  return out;
}
