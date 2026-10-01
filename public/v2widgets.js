/* v2widgets.js — the Signal V2 record as cards, shared by Signal and Vision.
 *
 * ONE renderer for both sites, the same way brief_fundamentals.js is one
 * renderer for both briefs: a widget that exists twice drifts twice.
 *
 * Every card reads the canonical feed (/signal_v2.json) and prints only what
 * the engine computed — counts, NAV, index levels, drawdown. Nothing here
 * adds, divides or rebases a figure from the record. A card that has nothing
 * to show says why, in words, and never draws a zero that reads as measured.
 *
 * Each card answers one question: question → main figure → chart → a short
 * note on how it is counted → where the records behind it are.
 *
 * It carries its own <style> for the same reason the Business section does:
 * one file cannot arrive half-delivered. The two sites name their tokens
 * differently (--text/--surface here, --ink/--panel on Vision), so every
 * custom property resolves through both names and ends in a literal.
 */
(() => {
  'use strict';
  if (window.V2W) return;

  const CSS = `
.v2w{--w-ink:var(--text,var(--ink,#1b1b1f));--w-mut:var(--muted,var(--ink-3,#5f6068));--w-dim:var(--dim,var(--ink-4,#8a8b93));
  --w-line:var(--line,#e3e2de);--w-surf:var(--surface,var(--panel,#fff));--w-bg:var(--bg,#f8f7f4);
  --w-acc:var(--accent,#2f5bd3);--w-up:var(--up,#0b7a55);--w-dn:var(--down,var(--dn,#c4372c));--w-warn:var(--warn,#8f5e00);
  border:1px solid var(--w-line);border-radius:10px;background:var(--w-surf);padding:16px;margin:0 0 16px;color:var(--w-ink);min-width:0}
.v2w h3{font:600 15px/1.3 var(--ui,var(--f-sans,system-ui,sans-serif));margin:0 0 4px;color:var(--w-ink)}
.v2w .v2w-per{font:400 12px/1.4 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut);margin:0 0 12px}
.v2w .v2w-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:0 0 14px}
.v2w .v2w-k{display:flex;flex-direction:column;gap:2px;min-width:0}
.v2w .v2w-k span{font:600 10px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));letter-spacing:.08em;text-transform:uppercase;color:var(--w-dim)}
.v2w .v2w-k b{font:600 22px/1.15 var(--ui,var(--f-sans,system-ui,sans-serif));font-variant-numeric:tabular-nums;color:var(--w-ink)}
.v2w .v2w-k em{font:400 12px/1.35 var(--ui,var(--f-sans,system-ui,sans-serif));font-style:normal;color:var(--w-mut)}
.v2w .v2w-note{font:400 12px/1.5 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut);margin:10px 0 0}
.v2w .v2w-note a,.v2w .v2w-more a{color:var(--w-acc)}
.v2w .v2w-more{font:500 13px/1.4 var(--ui,var(--f-sans,system-ui,sans-serif));margin:10px 0 0}
.v2w .v2w-empty{font:400 14px/1.5 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink);margin:0;padding:12px;border:1px dashed var(--w-line);border-radius:8px}
.v2w .v2w-empty b{display:block;margin:0 0 4px}
/* chart: lines in SVG, every label in HTML so text never scales with the box */
.v2w .v2w-chart{position:relative;height:180px;margin:4px 0 0 40px;touch-action:pan-y}
.v2w .v2w-chart svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.v2w .v2w-grid{stroke:var(--w-line);stroke-width:1}
.v2w .v2w-base{stroke:var(--w-dim);stroke-width:1;stroke-dasharray:2 3}
.v2w .v2w-l-nav{fill:none;stroke:var(--w-acc);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.v2w .v2w-l-bm{fill:none;stroke:var(--w-dim);stroke-width:2;stroke-dasharray:5 4;stroke-linejoin:round;stroke-linecap:round}
.v2w .v2w-y{position:absolute;left:-40px;width:34px;text-align:right;transform:translateY(-50%);font:400 11px/1 var(--mono,var(--f-mono,ui-monospace,monospace));color:var(--w-dim);font-variant-numeric:tabular-nums}
.v2w .v2w-x{display:flex;justify-content:space-between;margin:6px 0 0 40px;font:400 11px/1 var(--mono,var(--f-mono,ui-monospace,monospace));color:var(--w-dim)}
.v2w .v2w-leg{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 8px;font:400 12px/1.3 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut)}
.v2w .v2w-leg i{display:inline-block;width:18px;height:0;border-top:2px solid var(--w-acc);vertical-align:middle;margin-right:6px}
.v2w .v2w-leg i.bm{border-top:2px dashed var(--w-dim)}
.v2w .v2w-cross{position:absolute;top:0;bottom:0;width:0;border-left:1px solid var(--w-mut);pointer-events:none;display:none}
.v2w .v2w-dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;border:2px solid var(--w-surf);pointer-events:none;display:none}
.v2w .v2w-dot.nav{background:var(--w-acc)}.v2w .v2w-dot.bm{background:var(--w-dim)}
.v2w .v2w-tip{position:absolute;top:0;z-index:2;min-width:150px;padding:8px 10px;border:1px solid var(--w-line);border-radius:8px;background:var(--w-surf);
  box-shadow:0 4px 16px rgba(0,0,0,.12);font:400 12px/1.45 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink);pointer-events:none;display:none;font-variant-numeric:tabular-nums}
.v2w .v2w-tip b{display:block;margin:0 0 2px}
/* calendar: Mon–Fri, one cell per weekday; status is a word, never colour alone */
.v2w .v2w-mon{margin:0 0 12px}
.v2w .v2w-mon h4{font:600 12px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim);margin:0 0 6px}
.v2w .v2w-cal{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
.v2w .v2w-dow{font:600 10px/1 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-dim);text-align:center;padding:0 0 2px}
.v2w .v2w-c{min-height:54px;border:1px solid var(--w-line);border-radius:6px;padding:4px 5px;background:var(--w-bg);display:flex;flex-direction:column;gap:2px;
  font:400 10px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut);text-align:left;cursor:default;min-width:0}
.v2w button.v2w-c{cursor:pointer;font:inherit;font-size:10px;color:var(--w-mut)}
.v2w button.v2w-c:hover,.v2w button.v2w-c:focus-visible{border-color:var(--w-acc);outline:none}
.v2w .v2w-c[aria-pressed="true"]{border-color:var(--w-acc);box-shadow:inset 0 0 0 1px var(--w-acc)}
.v2w .v2w-c .d{font:600 12px/1 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink)}
.v2w .v2w-c .s{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v2w .v2w-c .n{font-variant-numeric:tabular-nums;color:var(--w-ink)}
.v2w .v2w-c.blank{background:transparent;border-style:dashed;opacity:.55}
.v2w .v2w-c.late .s{color:var(--w-warn)}
.v2w .v2w-c .w{color:var(--w-up)}.v2w .v2w-c .l{color:var(--w-dn)}
.v2w .v2w-day{font:400 13px/1.5 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink);margin:6px 0 0;min-height:1.5em}
/* lifecycle: a row of steps; the current one is named, not merely coloured */
.v2w .v2w-steps{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0;padding:0}
.v2w .v2w-steps li{display:flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid var(--w-line);border-radius:999px;
  font:500 12px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-dim);background:var(--w-bg)}
.v2w .v2w-steps li.done{color:var(--w-ink)}
.v2w .v2w-steps li.now{color:var(--w-ink);border-color:var(--w-acc);box-shadow:inset 0 0 0 1px var(--w-acc);background:var(--w-surf)}
.v2w .v2w-steps li.end-dn{color:var(--w-dn)}.v2w .v2w-steps li.end-up{color:var(--w-up)}
.v2w .v2w-steps li i{font-style:normal}
@media (max-width:599px){.v2w{padding:14px}.v2w .v2w-k b{font-size:19px}.v2w .v2w-c{min-height:48px}.v2w .v2w-c .s{font-size:9px}}
@media (prefers-reduced-motion:no-preference){.v2w .v2w-cross,.v2w .v2w-dot,.v2w .v2w-tip{transition:left .06s linear}}
/* market cards: same shell, charts from market data (not the record) */
.v2w-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:0 0 16px}
.v2w-grid2>.v2w{margin:0}
@media (max-width:899px){.v2w-grid2{grid-template-columns:minmax(0,1fr)}}
.v2w .v2w-k b.v2w-big{font-size:26px;letter-spacing:-.01em}
.v2w-grid2 .v2w .v2w-kpis{grid-template-columns:repeat(auto-fit,minmax(112px,1fr))}
.v2w-grid2 .v2w .v2w-k b{font-size:21px}.v2w-grid2 .v2w .v2w-k b.v2w-big{font-size:23px}
.v2w .v2w-mv .v2w-bars{grid-template-columns:minmax(0,1.5fr) minmax(36px,1fr) 52px}
.v2w .v2w-bars .nm small{white-space:normal}
.v2w .v2w-mk{position:relative}
.v2w .v2w-mk .v2w-chart{height:150px}
.v2w .v2w-mk .v2w-chart.dd{height:64px;margin-top:6px}
.v2w .v2w-sub{font:600 10px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));letter-spacing:.08em;text-transform:uppercase;color:var(--w-dim);margin:10px 0 0 40px}
.v2w .v2w-area{fill:color-mix(in srgb,var(--w-acc) 12%,transparent);stroke:none}
.v2w .v2w-uw{fill:color-mix(in srgb,var(--w-dn) 22%,transparent);stroke:var(--w-dn);stroke-width:1.5;stroke-linejoin:round}
.v2w .v2w-mk .v2w-cross{top:0;bottom:0}
/* daily-move heatmap: weeks are columns, Mon-Fri rows; down days carry a hatch so the sign never rests on hue alone */
.v2w .v2w-hm{display:grid;grid-template-columns:22px minmax(0,1fr);gap:4px 6px;align-items:start}
.v2w .v2w-hm-dow{display:grid;grid-template-rows:repeat(5,1fr);gap:3px;font:400 10px/1 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-dim);height:100%}
.v2w .v2w-hm-dow span{display:flex;align-items:center}
.v2w .v2w-hm-g{display:grid;grid-auto-flow:column;grid-template-rows:repeat(5,auto);gap:3px}
.v2w .v2w-hm-m{display:grid;grid-auto-flow:column;gap:3px;font:400 10px/1 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-dim);margin:0 0 4px 28px;min-height:12px}
.v2w .v2w-hc{display:block;aspect-ratio:1;border-radius:3px;background:var(--w-bg);border:1px solid transparent;min-width:0}
.v2w .v2w-hc.na{background:transparent;border:1px dashed var(--w-line)}
.v2w .v2w-hc.u1{background:color-mix(in oklab,var(--w-up) 30%,var(--w-surf))}
.v2w .v2w-hc.u2{background:color-mix(in oklab,var(--w-up) 60%,var(--w-surf))}
.v2w .v2w-hc.u3{background:var(--w-up)}
.v2w .v2w-hc.d1{background:color-mix(in oklab,var(--w-dn) 30%,var(--w-surf))}
.v2w .v2w-hc.d2{background:color-mix(in oklab,var(--w-dn) 60%,var(--w-surf))}
.v2w .v2w-hc.d3{background:var(--w-dn)}
.v2w .v2w-hc.z{background:color-mix(in oklab,var(--w-dim) 22%,var(--w-surf))}
.v2w .v2w-hc[class*=" d"]{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.35) 0 1px,transparent 1px 4px)}
.v2w .v2w-hc[data-i]:hover,.v2w .v2w-hc.on{border-color:var(--w-ink)}
.v2w .v2w-leg2{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:10px 0 0;font:400 11px/1 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-dim)}
.v2w .v2w-leg2 .v2w-hc{width:12px;height:12px;aspect-ratio:auto}
/* diverging bars: zero in the middle, value text in ink */
.v2w .v2w-bars{display:grid;grid-template-columns:minmax(96px,1.1fr) minmax(0,2fr) 58px;gap:6px 10px;align-items:center;font:400 13px/1.3 var(--ui,var(--f-sans,system-ui,sans-serif))}
.v2w .v2w-bars .nm{color:var(--w-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2w .v2w-bars .nm small{display:block;font-size:11px;color:var(--w-dim)}
.v2w .v2w-bars .val{text-align:right;font-variant-numeric:tabular-nums;color:var(--w-ink)}
.v2w .v2w-trk{position:relative;height:14px}
.v2w .v2w-trk::before{content:"";position:absolute;left:50%;top:-3px;bottom:-3px;border-left:1px dashed var(--w-dim)}
.v2w .v2w-trk i{position:absolute;top:2px;height:10px;border-radius:2px}
.v2w .v2w-trk i.up{left:50%;background:var(--w-up);border-radius:0 4px 4px 0}
.v2w .v2w-trk i.dn{right:50%;background:var(--w-dn);border-radius:4px 0 0 4px}
.v2w .v2w-trk.one::before{left:0}
.v2w .v2w-trk.one i.up,.v2w .v2w-trk.one i.dn{left:0;right:auto;border-radius:0 4px 4px 0}
.v2w .v2w-mv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:599px){.v2w .v2w-mv{grid-template-columns:minmax(0,1fr)}.v2w .v2w-bars{grid-template-columns:minmax(84px,1fr) minmax(0,1.4fr) 54px}}
.v2w .v2w-mv h4{font:600 12px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim);margin:0 0 8px}
.v2w a.sym{color:var(--w-ink);font-weight:600;text-decoration:none}
.v2w a.sym:hover{color:var(--w-acc);text-decoration:underline}
.v2w-ai{border-color:color-mix(in srgb,var(--w-acc) 35%,var(--w-line))}
.v2w .v2w-ex{margin:0;padding:0 0 0 20px;display:grid;gap:10px;font:400 14px/1.55 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink)}
.v2w .v2w-ex li::marker{color:var(--w-dim);font-variant-numeric:tabular-nums}
.v2w .v2w-src{display:inline-block;margin-left:4px;padding:1px 7px;border:1px solid var(--w-line);border-radius:999px;font:500 11px/1.5 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut);text-decoration:none;white-space:nowrap}
a.v2w-src:hover{border-color:var(--w-acc);color:var(--w-acc)}`;

  function injectCss() {
    if (document.getElementById('v2w-css')) return;
    const s = document.createElement('style');
    s.id = 'v2w-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (k) => { const [y, m, d] = String(k).split('-').map(Number); return `${d} ${MON[m - 1]}${y ? ' ' + y : ''}`; };
  const dayShort = (k) => { const [, m, d] = String(k).split('-').map(Number); return `${d} ${MON[m - 1]}`; };
  const when = (iso) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(iso || ''));
    return !m ? '' : day(m[1]) + (m[2] ? `, ${m[2]} IST` : '');
  };
  const pct = (v) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
  const inr = (v) => v == null ? '—' : '₹' + Math.round(v).toLocaleString('en-IN');

  /* What each run status means to a reader, in words. */
  const STATUS = {
    ok: ['Plans', 'Plans published'],
    no_setups: ['No setup', 'Scanned; no stock qualified'],
    market_filter: ['Filter off', 'Scanned; market filter off, so no new plans'],
    paused: ['Paused', 'New plans paused'],
    data_unavailable: ['Not scanned', 'Prices arrived incomplete'],
    error: ['Run failed', 'The run failed'],
    not_run: ['No run', 'No run recorded for this session'],
  };
  const LATE = new Set(['data_unavailable', 'error', 'not_run']);

  const H = (d) => d && d.history && Array.isArray(d.history.sessions) ? d.history : null;
  const since = (d) => d && d.forward_record_start ? day(d.forward_record_start) : 'the start of the record';
  const asOf = (d) => d && d.session_date ? `as of the ${day(d.session_date)} close` : '';
  const noHistory = (d) => `<p class="v2w-empty"><b>No session history in this feed yet.</b>
    The record's day-by-day history is written by the evening run. It appears after the first session it records; until then
    the record's totals are all there is.</p>`;

  /* ── 1. HOW HAS THE PAPER BOOK DONE AGAINST THE MARKET? ───────────────── */
  function perf(d, opts = {}) {
    injectCss();
    const h = H(d), more = opts.recordHref || '/performance';
    const head = `<h3>How has the paper book done against the market?</h3>
      <p class="v2w-per">Since ${esc(since(d))}${h && h.sessions.length ? ` · ${h.sessions.length} session${h.sessions.length === 1 ? '' : 's'}` : ''} · ${esc(asOf(d))}</p>`;
    if (!h) return `<section class="v2w" aria-label="Performance against the market">${head}${noHistory(d)}</section>`;
    const bname = h.benchmark || 'the benchmark';
    if (!h.exposed) {
      return `<section class="v2w" aria-label="Performance against the market">${head}
        <div class="v2w-kpis">
          <div class="v2w-k"><span>Paper book</span><b>Not invested</b><em>no plan has filled</em></div>
          <div class="v2w-k"><span>${esc(bname)}</span><b>${pct(h.benchmark_change_pct)}</b><em>${h.benchmark_change_pct == null ? 'needs two recorded closes' : 'price index, same sessions'}</em></div>
          <div class="v2w-k"><span>Drawdown</span><b>—</b><em>nothing at risk yet</em></div>
        </div>
        <p class="v2w-note">No position has filled since ${esc(since(d))}, so there is no return to compare and no drawdown to report.
          The line appears with the first filled plan. A flat line against a moving index would only show cash.</p>
        <p class="v2w-more"><a href="${esc(more)}">The full record →</a></p></section>`;
    }
    const dd = h.drawdown || {};
    return `<section class="v2w" aria-label="Performance against the market">${head}
      <div class="v2w-kpis">
        <div class="v2w-k"><span>Paper NAV</span><b>${pct(h.nav_change_pct)}</b><em>${esc(inr(d.metrics && d.metrics.nav_inr))} from ${esc(inr(d.reference_size && d.reference_size.capital_inr))}</em></div>
        <div class="v2w-k"><span>vs ${esc(bname)}</span><b>${pct(h.benchmark_change_pct)}</b><em>${h.benchmark_change_pct == null ? 'needs two recorded closes' : 'price index, same sessions'}</em></div>
        <div class="v2w-k"><span>Worst drawdown</span><b>${pct(dd.max_pct)}</b><em>${dd.max_session ? 'on ' + esc(dayShort(dd.max_session)) : 'none yet'}</em></div>
        <div class="v2w-k"><span>From the high</span><b>${pct(dd.current_pct)}</b><em>${dd.sessions_since_peak ? esc(dd.sessions_since_peak) + ' session' + (dd.sessions_since_peak === 1 ? '' : 's') + ' since the peak' : 'at the high'}</em></div>
      </div>
      ${chart(h, bname)}
      <p class="v2w-note">${esc(h.basis || '')} Paper results from simulated fills; no order is placed. Not a forecast.</p>
      <p class="v2w-more"><a href="${esc(more)}">Every trade behind these figures →</a></p></section>`;
  }

  /* Two series on ONE axis, both already indexed to 100 by the engine. */
  function chart(h, bname) {
    const rows = h.sessions;
    const pts = rows.map((r, i) => ({ i, k: r.session, n: r.nav_index, b: r.benchmark_index, nav: r.nav_inr, bc: r.benchmark_close }));
    const vals = pts.flatMap((p) => [p.n, p.b]).filter((v) => v != null);
    if (pts.length < 2 || !vals.length) {
      return `<p class="v2w-empty"><b>Not enough sessions to draw.</b> The line needs two recorded closes.</p>`;
    }
    let lo = Math.min(100, ...vals), hi = Math.max(100, ...vals);
    const pad = Math.max((hi - lo) * 0.12, 0.25);
    lo -= pad; hi += pad;
    const W = 1000, Hh = 1000, n = pts.length;
    const x = (i) => (n === 1 ? 0 : (i / (n - 1)) * W);
    const y = (v) => Hh - ((v - lo) / (hi - lo)) * Hh;
    // A missing point breaks the line rather than being bridged.
    const path = (key) => {
      let d = '', pen = false;
      for (const p of pts) {
        if (p[key] == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p[key]).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    const ticks = [hi - pad, 100, lo + pad].filter((v, i, a) => a.findIndex((u) => Math.abs(u - v) < (hi - lo) * 0.08) === i);
    const data = esc(JSON.stringify({ bname, p: pts.map((p) => [p.k, p.n, p.b, p.nav, p.bc]), lo, hi }));
    return `<div class="v2w-leg" aria-hidden="true"><span><i></i>V2 paper NAV</span><span><i class="bm"></i>${esc(bname)}</span><span>both rebased to 100 at the start</span></div>
      <div class="v2w-chart" data-v2w-chart="${data}" role="img"
        aria-label="V2 paper NAV against ${esc(bname)}, rebased to 100, ${n} sessions. Latest: NAV ${pts[n - 1].n ?? 'not recorded'}, ${esc(bname)} ${pts[n - 1].b ?? 'not recorded'}.">
        <svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-hidden="true">
          ${ticks.map((t) => `<line class="${Math.abs(t - 100) < 1e-9 ? 'v2w-base' : 'v2w-grid'}" x1="0" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" vector-effect="non-scaling-stroke"/>`).join('')}
          <path class="v2w-l-bm" d="${path('b')}" vector-effect="non-scaling-stroke"/>
          <path class="v2w-l-nav" d="${path('n')}" vector-effect="non-scaling-stroke"/>
        </svg>
        ${ticks.map((t) => `<span class="v2w-y" style="top:${(y(t) / Hh * 100).toFixed(2)}%">${t.toFixed(1)}</span>`).join('')}
        <div class="v2w-cross"></div><div class="v2w-dot nav"></div><div class="v2w-dot bm"></div><div class="v2w-tip" role="status"></div>
      </div>
      <div class="v2w-x" aria-hidden="true"><span>${esc(dayShort(pts[0].k))}</span><span>${esc(dayShort(pts[n - 1].k))}</span></div>`;
  }

  function onChartMove(el, ev) {
    let D;
    try { D = JSON.parse(el.getAttribute('data-v2w-chart')); } catch (e) { return; }
    const r = el.getBoundingClientRect(), n = D.p.length;
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const i = Math.round(f * (n - 1)), p = D.p[i];
    const px = (n === 1 ? 0 : i / (n - 1)) * r.width;
    const py = (v) => (1 - (v - D.lo) / (D.hi - D.lo)) * r.height;
    const cross = el.querySelector('.v2w-cross'), tip = el.querySelector('.v2w-tip');
    const dn = el.querySelector('.v2w-dot.nav'), db = el.querySelector('.v2w-dot.bm');
    cross.style.display = 'block'; cross.style.left = px + 'px';
    dn.style.display = p[1] == null ? 'none' : 'block'; if (p[1] != null) { dn.style.left = px + 'px'; dn.style.top = py(p[1]) + 'px'; }
    db.style.display = p[2] == null ? 'none' : 'block'; if (p[2] != null) { db.style.left = px + 'px'; db.style.top = py(p[2]) + 'px'; }
    tip.innerHTML = `<b>${esc(day(p[0]))}</b>V2 paper NAV ${p[1] == null ? 'not recorded' : esc(p[1].toFixed(2)) + (p[3] != null ? ` · ${esc(inr(p[3]))}` : '')}<br>${esc(D.bname)} ${p[2] == null ? 'not recorded' : esc(p[2].toFixed(2)) + (p[4] != null ? ` · ${esc(Number(p[4]).toLocaleString('en-IN'))}` : '')}`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(0, px + 12), r.width - tw) + 'px';
  }
  function onChartLeave(el) {
    for (const c of el.querySelectorAll('.v2w-cross,.v2w-dot,.v2w-tip')) c.style.display = 'none';
  }

  /* ── 2. WHAT HAPPENED EACH SESSION? ───────────────────────────────────── */
  function calendar(d, opts = {}) {
    injectCss();
    const h = H(d), more = opts.recordHref || '/performance';
    const head = `<h3>What happened each session?</h3>
      <p class="v2w-per">Every NSE session since ${esc(since(d))} · ${esc(asOf(d))}</p>`;
    // Its own sentence, not noHistory(): both cards sit on one page, and a
    // page that says the same thing twice reads as a rendering fault.
    if (!h) return `<section class="v2w" aria-label="Session calendar">${head}<p class="v2w-empty"><b>No sessions recorded yet.</b>
      Each NSE session is added to this calendar the evening it closes, with what was published, filled and closed that day.</p></section>`;
    const rows = h.sessions;
    if (!rows.length) return `<section class="v2w" aria-label="Session calendar">${head}<p class="v2w-empty"><b>No session has closed since the record began.</b></p></section>`;
    const by = Object.fromEntries(rows.map((r) => [r.session, r]));
    const scanned = rows.filter((r) => ['ok', 'no_setups', 'market_filter', 'paused'].includes(r.status)).length;
    const late = rows.filter((r) => LATE.has(r.status)).length;
    // Totals are the feed's own metrics, not a sum of the rows below: the
    // record is counted once, by the engine, and every view prints that count.
    const m = d.metrics || {};
    // Weekdays from the first to the last session; a weekday with no row is not
    // an NSE session (a holiday) and is drawn as one, not as a missed run.
    const first = new Date(rows[0].session + 'T00:00:00Z'), last = new Date(rows[rows.length - 1].session + 'T00:00:00Z');
    const months = [];
    for (let t = new Date(first); t <= last; t.setUTCDate(t.getUTCDate() + 1)) {
      const w = t.getUTCDay(); if (w === 0 || w === 6) continue;
      const k = t.toISOString().slice(0, 10), mk = k.slice(0, 7);
      if (!months.length || months[months.length - 1].mk !== mk) months.push({ mk, cells: [] });
      months[months.length - 1].cells.push({ k, w, r: by[k] || null });
    }
    const cell = ({ k, r }) => {
      const dn = Number(k.slice(8));
      if (!r) return `<div class="v2w-c blank" title="${esc(day(k))}: not an NSE session"><span class="d">${dn}</span><span class="s">Holiday</span></div>`;
      const [w] = STATUS[r.status] || [r.status];
      const cnt = [r.published ? `${r.published} new` : '', r.filled ? `${r.filled} filled` : ''].filter(Boolean).join(' · ');
      const res = r.closed ? `<span class="n">${r.wins ? `<span class="w">${r.wins}W</span> ` : ''}${r.losses ? `<span class="l">${r.losses}L</span> ` : ''}${r.breakevens ? `${r.breakevens}BE` : ''}</span>` : '';
      return `<button type="button" class="v2w-c${LATE.has(r.status) ? ' late' : ''}" data-v2w-day="${esc(k)}" aria-pressed="false"
        aria-label="${esc(dayDesc(r))}"><span class="d">${dn}</span><span class="s">${esc(w)}</span>${cnt ? `<span class="n">${esc(cnt)}</span>` : ''}${res}</button>`;
    };
    const grid = months.map((m) => {
      const [y, mo] = m.mk.split('-').map(Number);
      const lead = m.cells[0].w - 1;
      return `<div class="v2w-mon"><h4>${MON[mo - 1]} ${y}</h4><div class="v2w-cal">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((x) => `<span class="v2w-dow" aria-hidden="true">${x}</span>`).join('')}
        ${'<span aria-hidden="true"></span>'.repeat(lead)}${m.cells.map(cell).join('')}</div></div>`;
    }).join('');
    const descs = esc(JSON.stringify(Object.fromEntries(rows.map((r) => [r.session, dayDesc(r)]))));
    const lastRow = rows[rows.length - 1];
    return `<section class="v2w" aria-label="Session calendar" data-v2w-days="${descs}">${head}
      <div class="v2w-kpis">
        <div class="v2w-k"><span>Sessions</span><b>${rows.length}</b><em>${scanned} scanned${late ? ` · ${late} not scanned` : ''}</em></div>
        <div class="v2w-k"><span>Plans published</span><b>${m.published ?? '—'}</b><em>${m.active != null ? `${m.active} open · ${m.awaiting_entry} awaiting entry` : ''}</em></div>
        <div class="v2w-k"><span>Closed</span><b>${m.closed ?? '—'}</b><em>${m.closed ? `${m.wins} won · ${m.losses} lost · ${m.breakevens} even` : 'none yet'}</em></div>
      </div>
      ${grid}
      <p class="v2w-day" aria-live="polite">${esc(dayDesc(lastRow))}</p>
      <p class="v2w-note">Tap a session for what happened. A day marked “Holiday” was not an NSE session. “No run” means no evening run was recorded for that session, which is a gap in operations, not a quiet day.</p>
      <p class="v2w-more"><a href="${esc(more)}">The trades behind each session →</a></p></section>`;
  }

  function dayDesc(r) {
    const [, why] = STATUS[r.status] || ['', r.status];
    const parts = [`${day(r.session)}: ${why}.`];
    parts.push(`${r.published} published, ${r.filled} filled, ${r.closed} closed${r.closed ? ` (${r.wins} won, ${r.losses} lost, ${r.breakevens} even)` : ''}.`);
    if (r.nav_inr != null) parts.push(`Paper NAV ${inr(r.nav_inr)} at the close.`);
    return parts.join(' ');
  }

  /* ── 3. WHERE IS THIS PLAN IN ITS LIFE? ───────────────────────────────── */
  function lifecycle(p, d) {
    injectCss();
    if (!p) return '';
    const ex = p.exits || [];
    const hit = (t) => ex.some((x) => String(x.reason || '').toUpperCase().startsWith(t));
    const st = p.state;
    const steps = [];
    const add = (label, cls, at) => steps.push({ label, cls,
      when: at ? String(at).replace(/\d{4}-\d{2}-\d{2}/, (k) => dayShort(k)) : '' });
    add('Published', 'done', p.session_date);
    if (st === 'awaiting_entry') add('Entry window open', 'now', p.valid_through ? 'through ' + p.valid_through : '');
    else if (st === 'expired_unfilled') add('Expired unfilled', 'now', p.closed_session || p.valid_through);
    else if (st === 'cancelled') add('Cancelled before entry', 'now end-dn', p.closed_session);
    if (p.fill) add(`Filled at ${Number(p.fill.price).toFixed(2)} (simulated)`, 'done', p.fill.session);
    for (const t of ['T1', 'T2', 'T3']) if (hit(t)) add(`${t} taken`, 'done end-up', (ex.find((x) => String(x.reason).toUpperCase().startsWith(t)) || {}).session);
    if (hit('STOP')) add('Stopped', 'done end-dn', (ex.find((x) => String(x.reason).toLowerCase().startsWith('stop')) || {}).session);
    if (hit('TIME')) add('Time exit', 'done', (ex.find((x) => String(x.reason).toLowerCase().startsWith('time')) || {}).session);
    if (st === 'activated' || st === 'partially_exited') add(`Open · ${p.remaining_pct != null ? p.remaining_pct + '% left' : 'position held'}`, 'now', p.last_session ? 'marked ' + p.last_session : '');
    if (['closed', 'stopped', 'time_exited'].includes(st)) {
      const o = p.outcome;
      steps[steps.length - 1].cls += ' now';
      add(`Closed${o ? ': ' + o : ''}${p.total_r != null ? ` (${p.total_r > 0 ? '+' : ''}${p.total_r}R net)` : ''}`, `now ${o === 'win' ? 'end-up' : o === 'loss' ? 'end-dn' : ''}`, p.closed_session);
    }
    // Only the last "now" is current.
    let seen = false;
    for (let i = steps.length - 1; i >= 0; i--) { if (/\bnow\b/.test(steps[i].cls)) { if (seen) steps[i].cls = steps[i].cls.replace(/\bnow\b/, 'done'); seen = true; } }
    const ver = d && d.model_version ? `Model ${esc(d.model_version)}` : '';
    return `<section class="v2w" aria-label="Where this plan is">
      <h3>Where is this plan in its life?</h3>
      <p class="v2w-per">${ver}${ver ? ' · ' : ''}published ${esc(when(p.published_at || p.session_date))}</p>
      <ol class="v2w-steps">${steps.map((s) => `<li class="${esc(s.cls)}"${/\bnow\b/.test(s.cls) ? ' aria-current="step"' : ''}>
        <i aria-hidden="true">${/\bnow\b/.test(s.cls) ? '●' : '✓'}</i>${esc(s.label)}${s.when ? ` <span>· ${esc(s.when)}</span>` : ''}</li>`).join('')}</ol>
      <p class="v2w-note">Steps come from the plan's own fills and exits. Nothing here estimates what happens next.</p></section>`;
  }


  /* ══ MARKET CARDS ═════════════════════════════════════════════════════════
   * The same card shell, fed by MARKET data rather than the record: the index's
   * own daily closes (/api/signals?series=^NSEI, prices that happened) and the
   * screen's weekly pulse. They describe what the market did. None of them is
   * a call, a score of a stock, or a statement about what comes next.
   */
  const sgn = (v, dp = 1) => v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}%`;
  const num0 = (v) => v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const num2 = (v) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const failCard = (q, what, why) => `<section class="v2w" aria-label="${esc(q)}"><h3>${esc(q)}</h3>
    <p class="v2w-empty"><b>${esc(what)} did not load.</b> ${esc(why || 'No answer from the source.')} Nothing is drawn in its place.</p></section>`;
  const cleanPts = (series) => ((series && series.points) || []).filter((p) => p && p.t && Number.isFinite(p.c) && p.c > 0);

  /* ONE place computes the market figures; the cards and the explanation both
     call it, so a sentence can never quote a number its card does not show. */
  function niftyStats(series) {
    const pts = cleanPts(series);
    if (pts.length < 20) return null;
    const n = pts.length, first = pts[0], last = pts[n - 1];
    let hi = pts[0], lo = pts[0], peak = pts[0].c, worst = 0, worstAt = pts[0].t;
    const dd = [];
    for (const p of pts) {
      if (p.c > hi.c) hi = p;
      if (p.c < lo.c) lo = p;
      if (p.c > peak) peak = p.c;
      const x = 100 * (p.c / peak - 1);
      dd.push(x);
      if (x < worst) { worst = x; worstAt = p.t; }
    }
    return { pts, n, first, last, hi, lo, dd, worst, worstAt,
             chg: 100 * (last.c / first.c - 1), fromHi: 100 * (last.c / hi.c - 1) };
  }
  function dayStats(series, months = 6) {
    const all = cleanPts(series);
    if (all.length < 30) return null;
    const lastT = new Date(all[all.length - 1].t + 'T00:00:00Z');
    const start = new Date(lastT); start.setUTCMonth(start.getUTCMonth() - months);
    const rows = [];
    for (let i = 1; i < all.length; i++) {
      if (new Date(all[i].t + 'T00:00:00Z') < start) continue;
      rows.push({ t: all[i].t, c: all[i].c, r: 100 * (all[i].c / all[i - 1].c - 1) });
    }
    if (!rows.length) return null;
    let up = 0, dn = 0, best = rows[0], worst = rows[0];
    for (const x of rows) { if (x.r > 0) up++; else if (x.r < 0) dn++; if (x.r > best.r) best = x; if (x.r < worst.r) worst = x; }
    return { rows, lastT, start, up, dn, best, worst, latest: rows[rows.length - 1] };
  }

  /* 1 ── HOW HAS THE MARKET DONE THIS YEAR? (the video's value curve + drawdown) */
  function nifty(series, opts = {}) {
    injectCss();
    const Q = 'How has the market done this year?';
    const S0 = niftyStats(series);
    if (!S0) return failCard(Q, 'The Nifty 50 history', opts.error);
    const { pts, n, first, last, hi, lo, dd, worst, worstAt, chg, fromHi } = S0;
    const W = 1000, H = 1000, X = (i) => (i / (n - 1)) * W;
    const pad = (hi.c - lo.c) * 0.08 || 1, yl = lo.c - pad, yh = hi.c + pad;
    const Y = (c) => H - ((c - yl) / (yh - yl)) * H;
    let line = '';
    pts.forEach((p, i) => { line += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.c).toFixed(1)}`; });
    const area = `${line}L${W},${H}L0,${H}Z`;
    const dmin = Math.min(-1, worst * 1.12), YD = (v) => (v / dmin) * H;
    let uw = `M0,0`;
    dd.forEach((v, i) => { uw += `L${X(i).toFixed(1)},${YD(v).toFixed(1)}`; });
    uw += `L${W},0Z`;
    const pctOf = (y) => (y / H * 100).toFixed(2) + '%';
    const data = esc(JSON.stringify({ p: pts.map((p, i) => [p.t, p.c, Math.round(dd[i] * 100) / 100]), yl, yh, dmin }));
    const mid = pts[Math.floor(n / 2)];
    return `<section class="v2w" id="w-nifty" aria-label="${esc(Q)}">
      <h3>${esc(Q)}</h3>
      <p class="v2w-per">Nifty 50 · daily closes ${esc(day(first.t))} – ${esc(day(last.t))} · price index</p>
      <div class="v2w-kpis">
        <div class="v2w-k"><span>Nifty 50</span><b class="v2w-big">${num2(last.c)}</b><em>close on ${esc(dayShort(last.t))}</em></div>
        <div class="v2w-k"><span>Over the year</span><b class="v2w-big">${sgn(chg)}</b><em>from ${num0(first.c)}</em></div>
        <div class="v2w-k"><span>Below its high</span><b class="v2w-big">${sgn(fromHi)}</b><em>high ${num0(hi.c)} on ${esc(dayShort(hi.t))}</em></div>
        <div class="v2w-k"><span>Worst fall in the year</span><b class="v2w-big">${sgn(worst)}</b><em>from a high, on ${esc(dayShort(worstAt))}</em></div>
      </div>
      <div class="v2w-mk" data-v2w-mk="${data}" role="img"
        aria-label="Nifty 50 over the year: ${esc(sgn(chg))}, now ${esc(sgn(fromHi))} below its high of ${esc(num0(hi.c))}. Worst fall from a high ${esc(sgn(worst))}.">
        <div class="v2w-chart">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            <line class="v2w-grid" x1="0" x2="${W}" y1="${Y(hi.c).toFixed(1)}" y2="${Y(hi.c).toFixed(1)}" vector-effect="non-scaling-stroke"/>
            <line class="v2w-grid" x1="0" x2="${W}" y1="${Y(lo.c).toFixed(1)}" y2="${Y(lo.c).toFixed(1)}" vector-effect="non-scaling-stroke"/>
            <path class="v2w-area" d="${area}"/>
            <path class="v2w-l-nav" d="${line}" vector-effect="non-scaling-stroke"/>
          </svg>
          <span class="v2w-y" style="top:${pctOf(Y(hi.c))}">${num0(hi.c)}</span>
          <span class="v2w-y" style="top:${pctOf(Y(lo.c))}">${num0(lo.c)}</span>
        </div>
        <p class="v2w-sub">Below its running high</p>
        <div class="v2w-chart dd">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            <line class="v2w-base" x1="0" x2="${W}" y1="0" y2="0" vector-effect="non-scaling-stroke"/>
            <path class="v2w-uw" d="${uw}" vector-effect="non-scaling-stroke"/>
          </svg>
          <span class="v2w-y" style="top:0%">0%</span>
          <span class="v2w-y" style="top:${pctOf(YD(worst))}">${sgn(worst, 0)}</span>
        </div>
        <div class="v2w-cross" style="left:40px"></div><div class="v2w-tip" role="status"></div>
      </div>
      <div class="v2w-x" aria-hidden="true"><span>${esc(dayShort(first.t))}</span><span>${esc(dayShort(mid.t))}</span><span>${esc(dayShort(last.t))}</span></div>
      <p class="v2w-note">Closing levels from the exchange's index, delayed. The lower chart is how far the index stood below its highest close so far. A price index: dividends are not included. A description of the past, not a forecast.</p>
      ${opts.more ? `<p class="v2w-more"><a href="${esc(opts.more)}">The full market board →</a></p>` : ''}</section>`;
  }

  function onMkMove(el, ev) {
    let D; try { D = JSON.parse(el.getAttribute('data-v2w-mk')); } catch (e) { return; }
    const box = el.querySelector('.v2w-chart'), r = box.getBoundingClientRect(), wr = el.getBoundingClientRect(), n = D.p.length;
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const i = Math.round(f * (n - 1)), p = D.p[i], prev = i ? D.p[i - 1] : null;
    const x = (r.left - wr.left) + (i / (n - 1)) * r.width;
    const cross = el.querySelector('.v2w-cross'), tip = el.querySelector('.v2w-tip');
    cross.style.display = 'block'; cross.style.left = x + 'px';
    const dchg = prev ? 100 * (p[1] / prev[1] - 1) : null;
    tip.innerHTML = `<b>${esc(day(p[0]))}</b>Close ${esc(num2(p[1]))}${dchg != null ? ` · ${esc(sgn(dchg, 2))} on the day` : ''}<br>${p[2] < 0 ? esc(sgn(p[2])) + ' below its high so far' : 'At a new high'}`;
    tip.style.display = 'block';
    tip.style.left = Math.min(Math.max(0, x + 12), wr.width - tip.offsetWidth) + 'px';
  }

  /* 2 ── HOW DID EACH TRADING DAY GO? (the video's trading-day heatmap) */
  const BIN = (v) => v == null ? 'na' : v >= 1.5 ? 'u3' : v >= 0.75 ? 'u2' : v >= 0.25 ? 'u1' : v > -0.25 ? 'z' : v > -0.75 ? 'd1' : v > -1.5 ? 'd2' : 'd3';
  function days(series, opts = {}) {
    injectCss();
    const Q = 'How did each trading day go?';
    const DS = dayStats(series, opts.months || 6);
    if (!DS) return failCard(Q, 'The Nifty 50 daily history', opts.error);
    const { rows, lastT, start } = DS;
    const by = Object.fromEntries(rows.map((x) => [x.t, x]));
    // Weeks from the Monday on or before the first row, through the last row.
    const d0 = new Date(rows[0].t + 'T00:00:00Z'); d0.setUTCDate(d0.getUTCDate() - ((d0.getUTCDay() + 6) % 7));
    const cells = [], mlab = [];
    let wk = 0;
    const { up, dn, best } = DS, worstD = DS.worst;
    let lastMonth = '';
    for (let t = new Date(d0); t <= lastT; t.setUTCDate(t.getUTCDate() + 7), wk++) {
      const mk = t.toISOString().slice(0, 7);
      for (let w = 0; w < 5; w++) {
        const dt = new Date(t); dt.setUTCDate(dt.getUTCDate() + w);
        const k = dt.toISOString().slice(0, 10), x = by[k];
        if (dt > lastT || dt < start) { cells.push(`<span class="v2w-hc" style="visibility:hidden" aria-hidden="true"></span>`); continue; }
        cells.push(x ? `<span class="v2w-hc ${BIN(x.r)}" data-i="${esc(k)}" title="${esc(day(k))}: ${esc(sgn(x.r, 2))}"></span>`
                     : `<span class="v2w-hc na" title="${esc(day(k))}: no session"></span>`);
      }
      const m = (new Date(t.getTime() + 4 * 864e5)).toISOString().slice(0, 7);
      mlab.push(m !== lastMonth ? `<span>${MON[Number(m.slice(5)) - 1]}</span>` : '<span></span>');
      if (m !== lastMonth) lastMonth = m;
    }
    const info = esc(JSON.stringify(Object.fromEntries(rows.map((x) => [x.t, `${day(x.t)}: ${sgn(x.r, 2)} · Nifty closed at ${num2(x.c)}`]))));
    const L = [['d3', '≤ −1.5%'], ['d2', ''], ['d1', ''], ['z', '±0.25%'], ['u1', ''], ['u2', ''], ['u3', '≥ +1.5%']];
    return `<section class="v2w" id="w-days" aria-label="${esc(Q)}" data-v2w-hm="${info}">
      <h3>${esc(Q)}</h3>
      <p class="v2w-per">Nifty 50 close-to-close change · ${esc(day(rows[0].t))} – ${esc(day(rows[rows.length - 1].t))}</p>
      <div class="v2w-kpis">
        <div class="v2w-k"><span>Up days</span><b>${up}</b><em>of ${rows.length} sessions</em></div>
        <div class="v2w-k"><span>Down days</span><b>${dn}</b><em>${rows.length - up - dn ? `${rows.length - up - dn} unchanged` : 'none unchanged'}</em></div>
        <div class="v2w-k"><span>Best day</span><b>${sgn(best.r, 2)}</b><em>${esc(dayShort(best.t))}</em></div>
        <div class="v2w-k"><span>Worst day</span><b>${sgn(worstD.r, 2)}</b><em>${esc(dayShort(worstD.t))}</em></div>
      </div>
      <div class="v2w-hm-m" style="grid-template-columns:repeat(${wk},minmax(0,1fr))" aria-hidden="true">${mlab.join('')}</div>
      <div class="v2w-hm">
        <div class="v2w-hm-dow" aria-hidden="true"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span></div>
        <div class="v2w-hm-g" style="grid-template-columns:repeat(${wk},minmax(0,1fr))" role="img"
          aria-label="${rows.length} sessions: ${up} up, ${dn} down. Best ${esc(sgn(best.r, 2))} on ${esc(day(best.t))}; worst ${esc(sgn(worstD.r, 2))} on ${esc(day(worstD.t))}.">${cells.join('')}</div>
      </div>
      <div class="v2w-leg2" aria-hidden="true"><span>Fell</span>${L.map(([c, t]) => `<span class="v2w-hc ${c}"></span>${t ? `<span>${t}</span>` : ''}`).join('')}<span>Rose</span><span class="v2w-hc na"></span><span>no session</span></div>
      <p class="v2w-day" aria-live="polite">${esc(`${day(rows[rows.length - 1].t)}: ${sgn(rows[rows.length - 1].r, 2)} · Nifty closed at ${num2(rows[rows.length - 1].c)}`)}</p>
      <p class="v2w-note">Each square is one session, read down Monday to Friday and across week by week. Falls are hatched as well as red, so the sign does not rest on colour. Hover or tap a square for the day.</p></section>`;
  }

  /* 3 ── WHICH SECTORS ARE MOVING? (the video's allocation ring, as the honest form: diverging bars) */
  function sectors(pulse, opts = {}) {
    injectCss();
    const Q = 'Which sectors are moving this week?';
    const S = (pulse && pulse.sectors) || [];
    if (!S.length) return failCard(Q, 'The sector breadth', opts.error);
    const b = pulse.breadth || {};
    let mx = 0, upSec = 0;
    for (const x of S) { mx = Math.max(mx, Math.abs(x.median || 0)); if (x.median > 0) upSec++; }
    mx = mx || 1;
    const rows = S.map((x) => {
      const w = Math.min(50, (Math.abs(x.median) / mx) * 50);
      return `<span class="nm" title="${esc(x.name)}">${esc(x.name)}<small>${esc(x.up)} of ${esc(x.n)} rose</small></span>
        <span class="v2w-trk" aria-hidden="true"><i class="${x.median >= 0 ? 'up' : 'dn'}" style="width:${w.toFixed(1)}%"></i></span>
        <span class="val">${sgn(x.median, 2)}</span>`;
    }).join('');
    return `<section class="v2w" id="w-sectors" aria-label="${esc(Q)}">
      <h3>${esc(Q)}</h3>
      <p class="v2w-per">Median 1-week move of the screened names in each sector · built ${esc(pulse.built_on ? day(pulse.built_on) : '—')}</p>
      <div class="v2w-kpis">
        <div class="v2w-k"><span>Names that rose</span><b class="v2w-big">${b.up != null ? num0(b.up) : '—'}</b><em>of ${b.counted != null ? num0(b.counted) : '—'} screened, this week</em></div>
        <div class="v2w-k"><span>Typical stock</span><b class="v2w-big">${sgn(b.median, 1)}</b><em>median 1-week move</em></div>
        <div class="v2w-k"><span>Sectors up</span><b class="v2w-big">${upSec}</b><em>of ${S.length}</em></div>
      </div>
      <div class="v2w-bars" role="list" aria-label="Sectors by median 1-week move">${rows}</div>
      <p class="v2w-note">Each bar is the middle stock of its sector, not a cap-weighted index, so one large name cannot carry it. The count under each sector says how wide the move was.</p>
      ${opts.more ? `<p class="v2w-more"><a href="${esc(opts.more)}">Every sector and name on the map →</a></p>` : ''}</section>`;
  }

  /* 4 ── WHAT MOVED MOST THIS WEEK? (the video's winners and losers) */
  function movers(pulse, opts = {}) {
    injectCss();
    const Q = 'What moved most this week?';
    const U = ((pulse && pulse.movers_up) || []).slice(0, 5), D = ((pulse && pulse.movers_dn) || []).slice(0, 5);
    if (!U.length && !D.length) return failCard(Q, 'The weekly movers', opts.error);
    let mx = 0; for (const x of U.concat(D)) mx = Math.max(mx, Math.abs(x.r1w || 0)); mx = mx || 1;
    const href = opts.stockHref || ((s) => `/stock/${encodeURIComponent(s)}`);
    const list = (L) => `<div class="v2w-bars">${L.map((x) => `<span class="nm"><a class="sym" href="${esc(href(x.sym))}">${esc(x.sym)}</a><small>${esc(x.sector || '')}${x.turnover_cr != null ? ` · ₹${esc(num0(x.turnover_cr))} cr a day` : ''}</small></span>
      <span class="v2w-trk one" aria-hidden="true"><i class="${x.r1w >= 0 ? 'up' : 'dn'}" style="width:${Math.min(100, Math.abs(x.r1w) / mx * 100).toFixed(1)}%"></i></span>
      <span class="val">${sgn(x.r1w, 1)}</span>`).join('')}</div>`;
    return `<section class="v2w" id="w-movers" aria-label="${esc(Q)}">
      <h3>${esc(Q)}</h3>
      <p class="v2w-per">Largest 1-week price changes on the screen · built ${esc(pulse.built_on ? day(pulse.built_on) : '—')}</p>
      <div class="v2w-mv"><div><h4>Rose most</h4>${list(U)}</div><div><h4>Fell most</h4>${list(D)}</div></div>
      <p class="v2w-note">Bars share one scale, so a fall and a rise of the same size are the same length. Turnover is the average traded value a day; a big move on thin trading is a different thing from one on heavy trading. A description, not a recommendation.</p></section>`;
  }

  function onHmOver(cell) {
    const sec = cell.closest('[data-v2w-hm]'); if (!sec) return;
    let D = {}; try { D = JSON.parse(sec.getAttribute('data-v2w-hm')); } catch (e) { return; }
    for (const o of sec.querySelectorAll('.v2w-hc.on')) o.classList.remove('on');
    cell.classList.add('on');
    const out = sec.querySelector('.v2w-day'); if (out) out.textContent = D[cell.getAttribute('data-i')] || '';
  }


  /* ══ EXPLAIN THIS DASHBOARD ═══════════════════════════════════════════════
   * The video's "AI analyst", built so it cannot invent a figure: every
   * sentence is assembled from the same computed values the cards draw
   * (niftyStats, dayStats, the pulse, the V2 feed's own metrics and registry),
   * and every sentence names the card it came from. There is no model and no
   * free text, so nothing here can quote a number that is not on the page, and
   * nothing is said about what happens next.
   */
  const STATUS_WORD = { research: 'research, not publishing', shadow: 'tracked privately',
                        forward_paper: 'forward paper', validated: 'validated', retired: 'retired' };
  function explain(ctx = {}) {
    injectCss();
    const Q = 'Explain this dashboard';
    const S = [];
    const add = (text, ref, label) => S.push({ text, ref, label });
    const N = niftyStats(ctx.series), D = dayStats(ctx.series), P = ctx.pulse, F = ctx.feed;
    if (N) {
      add(`The Nifty 50 closed at ${num2(N.last.c)} on ${day(N.last.t)}: ${sgn(N.chg)} over the year and ${sgn(N.fromHi)} below its high of ${num0(N.hi.c)} (${dayShort(N.hi.t)}). Its worst fall from a high in the year was ${sgn(N.worst)}, on ${dayShort(N.worstAt)}.`,
          'w-nifty', 'The year');
    }
    if (D) {
      add(`Over the last six months it rose on ${D.up} sessions and fell on ${D.dn}. The latest session moved ${sgn(D.latest.r, 2)}; the best day was ${sgn(D.best.r, 2)} (${dayShort(D.best.t)}) and the worst ${sgn(D.worst.r, 2)} (${dayShort(D.worst.t)}).`,
          'w-days', 'Each day');
    }
    if (P && P.sectors && P.sectors.length) {
      const b = P.breadth || {}, sec = P.sectors;
      let up = 0; for (const x of sec) if (x.median > 0) up++;
      const top = sec[0], bot = sec[sec.length - 1];
      add(`This week ${b.up != null ? num0(b.up) : '—'} of ${b.counted != null ? num0(b.counted) : '—'} screened stocks rose and the typical stock moved ${sgn(b.median)}. ${up} of ${sec.length} sectors were up; the best was ${top.name} (${sgn(top.median, 2)}) and the worst ${bot.name} (${sgn(bot.median, 2)}).`,
          'w-sectors', 'Sectors');
      const U = (P.movers_up || [])[0], Dn = (P.movers_dn || [])[0];
      if (U && Dn) add(`The largest weekly rise was ${U.sym} (${sgn(U.r1w)}) and the largest fall ${Dn.sym} (${sgn(Dn.r1w)}).`, 'w-movers', 'Movers');
    }
    if (F) {
      const m = F.metrics || {};
      const plans = m.awaiting_entry || 0;
      add(plans
        ? `${plans} Signal V2 plan${plans === 1 ? '' : 's'} ${plans === 1 ? 'is' : 'are'} set for the next session.`
        : `There is no Signal V2 plan for the next session: ${(() => { const t = String(F.status_detail || 'none qualified').split('. ')[0].replace(/\.$/, ''); return t.charAt(0).toLowerCase() + t.slice(1); })()}.`,
        ctx.plansRef || null, 'Plans');
      add(`The V2 forward record, which began ${F.forward_record_start ? day(F.forward_record_start) : 'at the cutover'}, has ${m.published ?? 0} published plan${m.published === 1 ? '' : 's'} and ${m.closed ?? 0} closed; no win rate is shown until ${m.min_closed_for_rate || 30} have closed.`,
        ctx.recordRef || null, 'Record');
      const st = F.strategies || [];
      if (st.length) {
        const pub = st.filter((e) => e.publishes).length;
        add(`${st.length} engines are registered and ${pub} publish: ${st.map((e) => `${e.name} (${STATUS_WORD[e.status] || e.status})`).join(', ')}.`,
          ctx.enginesRef || null, 'Engines');
      }
    }
    if (!S.length) return failCard(Q, 'The figures this explanation is written from', ctx.error);
    return `<section class="v2w v2w-ai" aria-label="${esc(Q)}">
      <h3>${esc(Q)}</h3>
      <p class="v2w-per">Written from the figures on this page · every sentence names its source · no model, no forecast</p>
      <ol class="v2w-ex">${S.map((x) => `<li><span>${esc(x.text)}</span>${x.ref
        ? ` <a class="v2w-src" href="${esc(x.ref.startsWith('/') || x.ref.startsWith('#/') || /^https?:/.test(x.ref) ? x.ref : '#' + x.ref)}"${x.ref.startsWith('/') || x.ref.startsWith('#/') || /^https?:/.test(x.ref) ? '' : ` data-v2w-jump="${esc(x.ref)}"`}>${esc(x.label)} ↗</a>`
        : ` <span class="v2w-src">${esc(x.label)}</span>`}</li>`).join('')}</ol>
      <p class="v2w-note">This describes what has already happened and what the record holds. It does not predict, rank or recommend anything.</p></section>`;
  }

  /* One set of listeners for every card on either site, bound once. */
  function bind() {
    if (bind.done) return; bind.done = true;
    document.addEventListener('pointermove', (e) => {
      if (!e.target.closest) return;
      const el = e.target.closest('[data-v2w-chart]');
      if (el) onChartMove(el, e);
      const mk = e.target.closest('[data-v2w-mk]');
      if (mk) onMkMove(mk, e);
      const hc = e.target.closest('.v2w-hc[data-i]');
      if (hc) onHmOver(hc);
    });
    document.addEventListener('pointerleave', (e) => {
      if (!e.target || !e.target.matches) return;
      if (e.target.matches('[data-v2w-chart]')) onChartLeave(e.target);
      if (e.target.matches('[data-v2w-mk]')) for (const c of e.target.querySelectorAll('.v2w-cross,.v2w-tip')) c.style.display = 'none';
    }, true);
    document.addEventListener('click', (e) => {
      const j = e.target.closest && e.target.closest('[data-v2w-jump]');
      if (j) { const t = document.getElementById(j.getAttribute('data-v2w-jump')); if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } return; }
      const hc = e.target.closest && e.target.closest('.v2w-hc[data-i]');
      if (hc) { onHmOver(hc); return; }
      const b = e.target.closest && e.target.closest('[data-v2w-day]');
      if (!b) return;
      const sec = b.closest('[data-v2w-days]');
      let D = {}; try { D = JSON.parse(sec.getAttribute('data-v2w-days')); } catch (x) { /* no detail */ }
      for (const o of sec.querySelectorAll('[data-v2w-day]')) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
      const out = sec.querySelector('.v2w-day');
      if (out) out.textContent = D[b.getAttribute('data-v2w-day')] || '';
    });
  }
  bind();

  window.V2W = { perf, calendar, lifecycle, market: { nifty, days, sectors, movers }, explain };
})();
