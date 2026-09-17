/* ── heatcore.js — the heatmap's arithmetic and its tile, in one place ────────
 *
 * TWO PRODUCTS DRAW THIS GRID: signal.askakshay.com/heat (and the strip under
 * its hero) and gems.askakshay.com. They are separate bundles that share no
 * runtime, so without this file the ramp would exist twice — and this repo has
 * now recorded the cost of that four times: four engines with four target
 * ladders, a null guard fixed in one of three places, two feed lists that
 * drifted in both directions, a barometer computed in the browser and again in
 * Python. A colour ramp is worse than any of those to duplicate, because the
 * divergence is invisible: the same stock is simply a different green on two
 * pages and nobody can tell which one is wrong.
 *
 * SELF-CONTAINED ON PURPOSE. It defines its own escape and format helpers
 * rather than taking them from a host, because the two hosts spell theirs
 * differently and a shared module that depends on its caller's vocabulary is
 * not shared, it is copied with extra steps.
 *
 * WHAT THE RAMP MEANS. Brightness is the move divided by that name's own
 * average true range, so 1.0 is a stock that has travelled its ENTIRE typical
 * daily range in one direction. The cuts are absolute rather than fitted to a
 * day's percentiles: a percentile ramp re-scales every morning, so the same
 * tile means something different on a quiet day and the page stops being
 * comparable with itself.
 *
 * Calibrated against the live book rather than guessed — the first cuts
 * (0.35/0.75/1.25/2.0) measured median 0.38, p90 1.02, max 1.97, which left
 * 46 of 97 tiles in the bottom step and made the top step unreachable.
 */
(function (root) {
  'use strict';

  var CUTS = [0.25, 0.5, 1.0, 1.5];
  var WORDS = ['barely moved', 'an ordinary drift for this name',
               'a real move for this name',
               'its whole typical daily range, in one direction',
               'an outsized day'];
  var TIER_SPAN = { mega: 3, large: 2, mid: 2, small: 1, micro: 1 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* SIGNED. A change of -7.4% is data, not absence — the trap this estate has
     already paid for once, where a "number or null" helper turned every
     missing field into a real zero. */
  function sn(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  /* A LEVEL, OR NOTHING. No traded instrument has an average range of zero, so
     zero is absence here and a tile with it is drawn flat rather than scaled
     by a division that would explode. */
  function lvl(v) {
    var n = sn(v);
    return n !== null && n > 0 ? n : null;
  }
  function pct(v) {
    var n = sn(v);
    return n === null ? '—' : (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function step(chg, atr) {
    var c = sn(chg), a = lvl(atr);
    if (c === null) return null;
    if (a === null) return { k: 0, sig: null };        // cannot be scaled
    var sig = Math.abs(c) / a;
    var k = sig >= CUTS[3] ? 4 : sig >= CUTS[2] ? 3
          : sig >= CUTS[1] ? 2 : sig >= CUTS[0] ? 1 : 0;
    return { k: k, sig: sig };
  }

  /* Which names today's wire actually mentions. Matched on the ticker and on
     the first word of the registered name when that word is long enough to be
     distinctive — "SBI" would match half a wire, "GRANULES" would not. */
  function newsIndex(wire) {
    var blob = (wire || []).map(function (n) {
      return (n && n.title || '') + ' ' + (n && n.summary || '');
    }).join(' ').toUpperCase();
    return function (sym, name) {
      if (!blob) return false;
      if (blob.indexOf(String(sym).toUpperCase()) >= 0) return true;
      var w = String(name || '').split(/\s+/)[0].toUpperCase();
      return w.length >= 6 && blob.indexOf(w) >= 0;
    };
  }

  /* ledger: the live board's flat map of symbol -> {price, change_pct, ccy}.
     idx: symbol -> that name's screen row, for the range, sector and call. */
  function rows(ledger, idx, wire) {
    var inNews = newsIndex(wire);
    var out = [];
    Object.keys(ledger || {}).forEach(function (sym) {
      var v = ledger[sym];
      if (!v || sn(v.change_pct) === null) return;
      var r = (idx && idx[sym]) || {};
      out.push({
        sym: sym, price: v.price, ccy: v.ccy, change_pct: sn(v.change_pct),
        r: r, h: step(v.change_pct, r.atr_pct),
        sector: r.sector || 'Unclassified',
        span: TIER_SPAN[r.tier] || 1,
        news: inNews(sym, r.name)
      });
    });
    return out;
  }

  function tile(x) {
    var k = x.h ? x.h.k : 0;
    var d = x.change_pct > 0 ? 'u' : x.change_pct < 0 ? 'd' : 'f';
    var vd = String((x.r && x.r.vd && x.r.vd.c) || '').toUpperCase();
    var scaled = x.h && x.h.sig !== null && x.h.sig !== undefined;
    var why = scaled
      ? x.h.sig.toFixed(2) + '× its average range — ' + WORDS[x.h.k]
      : 'no average range on file, so this move could not be scaled';
    return '<button type="button" class="ht ht-' + d + k + ' ht-s' + x.span
      + (scaled ? '' : ' ht-na') + (vd ? ' ht-v' + esc(vd.toLowerCase()) : '') + '"'
      + ' data-hsym="' + esc(x.sym) + '"'
      + ' title="' + esc(x.sym) + ' ' + pct(x.change_pct) + ' · ' + esc(why)
      + (vd ? ' · the screen says ' + esc(vd) : '')
      + (x.news ? ' · in today’s wire' : '') + '">'
      + '<span class="ht-s">' + esc(x.sym) + '</span>'
      + '<span class="ht-c">' + pct(x.change_pct) + '</span>'
      + '<span class="ht-x">' + (scaled ? x.h.sig.toFixed(1) + '×' : '—') + '</span>'
      + (x.news ? '<i class="ht-n" aria-hidden="true"></i>' : '')
      + '</button>';
  }

  /* Is the session actually open? Both products state this rather than letting
     a number from 14 hours ago wear a live badge. */
  function isOpen(item) {
    var st = Number(item && item.session_start), en = Number(item && item.session_end);
    var now = Date.now() / 1000;
    return String((item && item.session) || '').toLowerCase() === 'open'
      && isFinite(st) && isFinite(en) && now >= st && now < en;
  }

  root.HEAT = { CUTS: CUTS, WORDS: WORDS, TIER_SPAN: TIER_SPAN,
                step: step, rows: rows, tile: tile, isOpen: isOpen,
                esc: esc, pct: pct, sn: sn, lvl: lvl };
})(window);
