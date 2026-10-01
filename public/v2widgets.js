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
@media (prefers-reduced-motion:no-preference){.v2w .v2w-cross,.v2w .v2w-dot,.v2w .v2w-tip{transition:left .06s linear}}`;

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

  /* One set of listeners for every card on either site, bound once. */
  function bind() {
    if (bind.done) return; bind.done = true;
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest && e.target.closest('[data-v2w-chart]');
      if (el) onChartMove(el, e);
    });
    document.addEventListener('pointerleave', (e) => {
      if (e.target && e.target.matches && e.target.matches('[data-v2w-chart]')) onChartLeave(e.target);
    }, true);
    document.addEventListener('click', (e) => {
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

  window.V2W = { perf, calendar, lifecycle };
})();
