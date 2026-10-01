/* engines.js — shared contract between signal.askakshay.com and
 * gems.askakshay.com.
 *
 * SIGNAL V2 (2026-10-01). The V1 engine roster that lived here (BREACH,
 * VECTOR, TIDAL, LEDGE, KEEL, PIVOT, ASCENT, GUST and the retired keys) is
 * retired and removed from the public site; a frozen copy is kept privately and
 * in trading-dashboard's legacy/engines_v1.js for its own regression check.
 *
 * ENGINE_BOOK keeps its API so any reader that still calls it gets an EMPTY
 * roster rather than an exception: no key is live, no V1 row is "in the book",
 * and nothing V1 can be counted into a V2 figure. V2 strategies are not listed
 * here — they come from the canonical plan feed (/signal_v2.json), with their
 * status, so the two can never disagree.
 */
(function (root) {
  'use strict';
  var none = function () { return []; };
  root.ENGINE_BOOK = {
    LAUNCH: '2026-10-01', REGISTRY: {},
    entries: none, live: none, keys: none, names: none,
    get: function () { return undefined; },
    name: function (k) { return String(k || ''); },
    label: function (k) { return String(k || ''); },
    ok: function () { return false; },
    sinceLaunch: function () { return false; },
    inBook: function () { return false; },
  };
})(window);

/* ── THE OTHER FACTS THE TWO SITES MUST AGREE ABOUT ──────────────────────────
 *
 * Akshay: "gems not getting refreshed eg. ipo section still shows 5 open —
 * ensure everything is live, correct and the same across the site; gems should
 * follow signal for the data as designed."
 *
 * He was right, and it was not a refresh problem. ipo.json's `open` array
 * carried FIVE entries. signal.askakshay.com ran them through ipoOpenNow()
 * first, which drops a book whose close date has passed, and showed TWO.
 * gems.askakshay.com read `ipo.open` raw and showed five — three of them books
 * that had stopped taking bids, under a heading that said "open".
 *
 * Neither figure came from stale data. They came from one site applying a rule
 * and the other not knowing there was one — the identical shape as the engine
 * roster, where signal filtered retired engines and gems kept its own hand-
 * typed list. A rule that lives in one bundle is a rule the other bundle will
 * contradict.
 *
 * So it moves here, beside the engine roster, and both sites call it. This
 * file is the contract between the two products, not only the engine registry;
 * anything both must agree about belongs in it rather than in whichever one
 * happened to implement it first.
 */
(function (root) {
  'use strict';

  /* Today in IST, as YYYY-MM-DD. en-CA renders that format, and it compares
     correctly as a plain string. An IPO book closes on an Indian calendar day
     regardless of where the reader is — a browser in MYT is eight and a half
     hours ahead and would otherwise close a book early. */
  var istToday = function () {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  };

  /* Days until the book closes. Falls back to the build's own `days_left` when
     the feed carries no usable close date — keep what the build said rather
     than invent a number. */
  var daysLeft = function (r) {
    if (!r) return null;
    var cd = String(r.close_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cd)) {
      return r.days_left != null ? r.days_left : null;
    }
    return Math.round(
      (Date.parse(cd + 'T00:00:00Z') - Date.parse(istToday() + 'T00:00:00Z')) / 86400000);
  };

  /* Books the calendar still says are taking bids. A negative days_left is a
     closed book and must not appear under a heading that says "open". A null
     is unknown, and unknown is kept rather than dropped — removing a row
     because its date is missing hides it from both counts. */
  var ipoOpenNow = function (list) {
    return (list || []).filter(function (r) {
      var dl = daysLeft(r);
      return dl == null || dl >= 0;
    });
  };

  root.SIGNAL_RULES = {
    istToday: istToday,
    daysLeft: daysLeft,
    ipoOpenNow: ipoOpenNow,
  };
})(window);
