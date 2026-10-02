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
a.v2w-src:hover{border-color:var(--w-acc);color:var(--w-acc)}
/* paper test + technical read */
.v2w .v2w-tag{display:inline-block;padding:1px 8px;border:1px solid var(--w-line);border-radius:999px;font:600 10px/1.6 var(--ui,var(--f-sans,system-ui,sans-serif));letter-spacing:.06em;text-transform:uppercase;color:var(--w-mut);vertical-align:middle}
.v2w .v2w-tag.pp{border-color:var(--w-warn);color:var(--w-warn)}
.v2w .v2w-eng{display:grid;gap:8px;margin:0 0 14px;padding:0;list-style:none}
.v2w .v2w-eng li{display:block;padding:10px 12px;border:1px solid var(--w-line);border-radius:8px;background:var(--w-bg)}
.v2w .v2w-eng b{font:600 14px/1.3 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink)}
.v2w .v2w-eng .n{font:400 12px/1.4 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink);font-variant-numeric:tabular-nums}
.v2w .v2w-eng .n::before{content:" · ";color:var(--w-dim)}
.v2w .v2w-eng p{margin:4px 0 0;font:400 12px/1.45 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut)}
.v2w h4.v2w-h{font:600 12px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim);margin:16px 0 8px}
.v2w .v2w-pcs{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.v2w .v2w-pc{border:1px solid var(--w-line);border-radius:8px;padding:12px;background:var(--w-surf);display:grid;gap:6px;min-width:0}
.v2w .v2w-pc header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.v2w .v2w-pc header a{font:700 15px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink);text-decoration:none}
.v2w .v2w-pc header a:hover{color:var(--w-acc);text-decoration:underline}
.v2w .v2w-pc header small{font:400 11px/1.3 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-dim);text-align:right}
.v2w .v2w-pc dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;font:400 13px/1.4 var(--ui,var(--f-sans,system-ui,sans-serif))}
.v2w .v2w-pc dt{color:var(--w-mut)}
.v2w .v2w-pc dd{margin:0;color:var(--w-ink);font-variant-numeric:tabular-nums}
.v2w .v2w-pc dd.v2w-sells span{display:block}
.v2w .v2w-pc:target{outline:2px solid var(--w-accent,var(--accent,#2b50d8));outline-offset:2px}
.v2w .v2w-ladw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.v2w .v2w-lad{width:100%;border-collapse:collapse;font:400 13px/1.4 var(--ui,var(--f-sans,system-ui,sans-serif));font-variant-numeric:tabular-nums;margin:4px 0 6px}
.v2w .v2w-lad caption{text-align:left;font-size:12px;color:var(--w-dim,var(--dim,#6b6b6b));padding-bottom:6px}
.v2w .v2w-lad th,.v2w .v2w-lad td{padding:7px 8px;border-top:1px solid var(--w-line,var(--line,#e5e2db));text-align:right;white-space:nowrap}
.v2w .v2w-lad th:first-child{text-align:left}
@media(max-width:600px){.v2w .v2w-lad th,.v2w .v2w-lad td{padding:6px 4px;font-size:12px}}
.v2w .v2w-lad thead th{font:500 10.5px/1 var(--mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim,var(--dim,#6b6b6b));border-top:0}
.v2w .v2w-lad .up{color:var(--w-up,var(--up,#0b7a4b))}
.v2w .v2w-ch{list-style:none;margin:0;padding:0;border:1px solid var(--w-line,var(--line,#e5e2db));border-radius:10px;overflow:hidden}
.v2w .v2w-ch li{display:grid;grid-template-columns:92px 120px minmax(0,1fr);gap:4px 12px;align-items:baseline;padding:9px 14px;border-top:1px solid var(--w-line,var(--line,#e5e2db));font-size:13px}
.v2w .v2w-ch li:first-child{border-top:0}
.v2w .v2w-ch li.r4{grid-template-columns:92px minmax(0,1fr)}
.v2w .v2w-ch .t{font:600 10.5px/1.4 var(--mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim,var(--dim,#6b6b6b))}
.v2w .v2w-ch li.r0 .t{color:var(--w-down,var(--down,#c0392b))} .v2w .v2w-ch li.r2 .t,.v2w .v2w-ch li.r3 .t{color:var(--w-up,var(--up,#0b7a4b))}
.v2w .v2w-ch .w i{font-style:normal;color:var(--w-dim,var(--dim,#6b6b6b));font-size:12px;margin-left:4px}
.v2w .v2w-ch a{color:inherit}
@media(max-width:600px){.v2w .v2w-ch li{grid-template-columns:auto minmax(0,1fr)}.v2w .v2w-ch li .w{grid-column:1/-1}}
.v2w .v2w-st{font:500 12px/1 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-dim,var(--dim,#6b6b6b));margin-left:6px}
.v2w .v2w-ent{margin:10px 0 12px}
.v2w .v2w-ent .v2w-chk{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:10px 12px;border-radius:8px;border:1px solid var(--w-line,var(--line,#e5e2db))}
.v2w .v2w-chk b{font-weight:600}
.v2w .v2w-chk.k-in{border-color:color-mix(in srgb,var(--w-up,var(--up,#0b7a4b)) 45%,transparent)}
.v2w .v2w-chk.k-above,.v2w .v2w-chk.k-below{border-color:color-mix(in srgb,var(--w-warn,var(--warn,#b7791f)) 50%,transparent)}
.v2w .v2w-chk.k-void{border-color:color-mix(in srgb,var(--w-down,var(--down,#c0392b)) 50%,transparent)}
.v2w .v2w-chk.k-gap{border-color:color-mix(in srgb,var(--w-warn,var(--warn,#b7791f)) 50%,transparent);border-style:dashed}
.v2w .v2w-chk span{color:var(--w-dim,var(--dim,#6b6b6b));font-size:13px}
.v2w .v2w-plan{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0;margin:0 0 12px;border:1px solid var(--w-line,var(--line,#e5e2db));border-radius:10px;overflow:hidden}
.v2w .v2w-plan > div{padding:10px 12px;box-shadow:inset -1px -1px 0 var(--w-line,var(--line,#e5e2db))}
.v2w .v2w-plan dt{font:500 10.5px/1 var(--mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim,var(--dim,#6b6b6b));margin-bottom:6px}
.v2w .v2w-plan dd{margin:0;font-variant-numeric:tabular-nums;font-size:14px}
.v2w .v2w-plan dd span{display:block;font-size:12px;color:var(--w-dim,var(--dim,#6b6b6b));margin-top:2px}
.v2w .v2w-why{font-size:13px;margin:0 0 6px}
.v2w .v2w-hist{margin:0 0 8px;padding-left:18px;font-size:13px}
.v2w .v2w-hist time{font-variant-numeric:tabular-nums;color:var(--w-dim,var(--dim,#6b6b6b));margin-right:6px}
.v2w .v2w-rp-out{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:6px 0 2px;font:400 15px/1.3 var(--ui,var(--f-sans,system-ui,sans-serif))}
.v2w .v2w-rp-out .r{font:600 24px/1 var(--mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;color:var(--w-ink)}
.v2w .v2w-rp-out.up .r{color:var(--w-up)} .v2w .v2w-rp-out.dn .r{color:var(--w-dn)}
.v2w .v2w-rp-sub{font-size:13px;color:var(--w-mut);margin:0 0 12px}
.v2w .v2w-rp-map{margin:14px 0 4px}
.v2w .v2w-rp-map .bar{position:relative;height:30px;margin:0 8px;border-bottom:1px solid var(--w-line,var(--line,#e5e2db))}
.v2w .v2w-rp-map .bar span,.v2w .v2w-rp-map .bar i{position:absolute;display:block}
.v2w .v2w-rp-map .seen{bottom:4px;height:8px;border-radius:4px;background:color-mix(in srgb,var(--w-acc) 28%,transparent)}
.v2w .v2w-rp-map .zone{bottom:14px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--w-mut,#6b6b6b) 30%,transparent)}
.v2w .v2w-rp-map .bar i{bottom:0;width:2px;height:26px;margin-left:-1px;border-radius:1px}
.v2w .v2w-rp-map i.st{background:var(--w-dn)} .v2w .v2w-rp-map i.st2{background:var(--w-dn);opacity:.55}
.v2w .v2w-rp-map i.tg{background:var(--w-up)} .v2w .v2w-rp-map i.fl{background:var(--w-ink);height:30px}
.v2w .v2w-rp-map .bar i.xt{width:8px;height:8px;margin-left:-4px;bottom:22px;border-radius:50%;background:var(--w-surf,#fff);box-shadow:0 0 0 2px var(--w-ink)}
.v2w .v2w-rp-map .ax{display:flex;justify-content:space-between;margin:4px 0 0;font:400 11px/1 var(--mono,ui-monospace,monospace);color:var(--w-dim,var(--dim,#6b6b6b));font-variant-numeric:tabular-nums}
.v2w .v2w-rp-map figcaption{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12px;color:var(--w-mut)}
.v2w .v2w-rp-map figcaption .k{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px;position:static}
.v2w .v2w-rp-map figcaption .k.seen{background:color-mix(in srgb,var(--w-acc) 28%,transparent)} .v2w .v2w-rp-map figcaption .k.zone{background:color-mix(in srgb,var(--w-mut,#6b6b6b) 30%,transparent)}
.v2w .v2w-rp-map figcaption .k.st{background:var(--w-dn);width:3px} .v2w .v2w-rp-map figcaption .k.tg{background:var(--w-up);width:3px}
.v2w .v2w-rp-map figcaption .k.fl{background:var(--w-ink);width:3px} .v2w .v2w-rp-map figcaption .k.xt{border-radius:50%;box-shadow:inset 0 0 0 2px var(--w-ink)}
.v2w .v2w-rp-tl li{margin:0 0 6px}
.v2w .v2w-rp-n{margin:0 0 8px;padding-left:18px;font-size:13px}
.v2w .v2w-fl{border:1px solid var(--w-line,var(--line,#e5e2db));border-radius:10px;overflow:hidden}
.v2w .v2w-fr{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,1.6fr) minmax(0,1.2fr) minmax(0,1.5fr) minmax(64px,.8fr);gap:4px 14px;align-items:baseline;
  padding:9px 14px;border-top:1px solid var(--w-line,var(--line,#e5e2db));color:var(--w-ink,inherit);text-decoration:none;font:400 13px/1.35 var(--ui,var(--f-sans,system-ui,sans-serif));font-variant-numeric:tabular-nums}
.v2w .v2w-fr:first-child{border-top:0} .v2w .v2w-fr:hover{background:color-mix(in srgb,var(--w-acc) 6%,transparent)}
.v2w .v2w-fr .s{font-weight:600} .v2w .v2w-fr .e,.v2w .v2w-fr .d{color:var(--w-mut)} .v2w .v2w-fr .r{text-align:right;font-family:var(--mono,ui-monospace,monospace)}
.v2w .v2w-fr .r.up{color:var(--w-up)} .v2w .v2w-fr .r.dn{color:var(--w-dn)}
@media(max-width:600px){.v2w .v2w-fr{grid-template-columns:minmax(0,1fr) auto}.v2w .v2w-fr .e,.v2w .v2w-fr .d{grid-column:1}.v2w .v2w-fr .o{grid-column:1}}
.v2w .v2w-dg{border:1px solid var(--w-line,var(--line,#e5e2db));border-radius:10px;overflow:hidden}
.v2w .v2w-dr{display:grid;grid-template-columns:minmax(96px,1.1fr) minmax(0,1.5fr) minmax(0,1.6fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr);
  gap:4px 14px;align-items:baseline;padding:9px 14px;border-top:1px solid var(--w-line,var(--line,#e5e2db));
  color:var(--w-ink,inherit);text-decoration:none;font:400 13px/1.35 var(--ui,var(--f-sans,system-ui,sans-serif));font-variant-numeric:tabular-nums}
.v2w .v2w-dr:first-child{border-top:0}
.v2w a.v2w-dr:hover{background:var(--w-raised,var(--raised,rgba(0,0,0,.03)))}
.v2w .v2w-dr b{font-weight:600;letter-spacing:.01em}
.v2w .v2w-dr .e,.v2w .v2w-dr .w,.v2w .v2w-dr .s{color:var(--w-dim,var(--dim,#6b6b6b));font-size:12px}
.v2w .v2w-dr i{font-style:normal;color:var(--w-dim,var(--dim,#6b6b6b));font-size:12px}
.v2w .v2w-dh{background:var(--w-raised,var(--raised,rgba(0,0,0,.03)));font:500 10.5px/1 var(--mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim,var(--dim,#6b6b6b))}
.v2w .v2w-dh b,.v2w .v2w-dh span{font:inherit;color:inherit}
@media(max-width:760px){
  .v2w .v2w-dh{display:none}
  .v2w .v2w-dr{grid-template-columns:1fr auto;grid-template-areas:"sym buy" "eng stop" "win st";padding:10px 12px}
  .v2w .v2w-dr b{grid-area:sym} .v2w .v2w-dr .e{grid-area:eng}
  .v2w .v2w-dr .n:nth-of-type(2){grid-area:buy;text-align:right} .v2w .v2w-dr .n:nth-of-type(3){grid-area:stop;text-align:right}
  .v2w .v2w-dr .w{grid-area:win} .v2w .v2w-dr .s{grid-area:st;text-align:right}
  .v2w .v2w-dr .n:nth-of-type(2)::before{content:'Buy ';color:var(--w-dim,var(--dim,#6b6b6b));font-size:11px}
  .v2w .v2w-dr .n:nth-of-type(3)::before{content:'Stop ';color:var(--w-dim,var(--dim,#6b6b6b));font-size:11px}
}
.v2w .v2w-pc p{margin:0;font:400 12px/1.45 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut)}
.v2w .v2w-rl{list-style:none;margin:0;padding:0;display:grid;gap:4px;font:400 13px/1.45 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink)}
.v2w .v2w-rl li{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--w-line);padding:4px 0}
.v2w .v2w-rl .r{font-variant-numeric:tabular-nums;white-space:nowrap}
.v2w .up{color:var(--w-up)}.v2w .dn{color:var(--w-dn)}
.v2w .v2w-vd{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;padding:12px;border:1px solid var(--w-line);border-radius:8px;background:var(--w-bg);margin:0 0 12px}
.v2w .v2w-vd b{font:700 18px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink)}
.v2w .v2w-vd.enter{border-color:var(--w-up)}.v2w .v2w-vd.enter b{color:var(--w-up)}
.v2w .v2w-vd.avoid b{color:var(--w-dn)}
.v2w .v2w-vd span{font:400 13px/1.4 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut)}
.v2w .v2w-sc{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:3px;margin:0 0 4px}
.v2w .v2w-sc i{height:8px;border-radius:2px;background:var(--w-line)}
.v2w .v2w-sc i.on{background:var(--w-acc)}
.v2w .v2w-rdg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0 0}
@media (max-width:599px){.v2w .v2w-rdg{grid-template-columns:minmax(0,1fr)}}
.v2w .v2w-rdg>div{border:1px solid var(--w-line);border-radius:8px;padding:10px 12px;min-width:0}
.v2w .v2w-rdg h4{display:flex;justify-content:space-between;font:600 11px/1.2 var(--ui,var(--f-sans,system-ui,sans-serif));letter-spacing:.06em;text-transform:uppercase;color:var(--w-dim);margin:0 0 6px}
.v2w .v2w-rdg h4 em{font-style:normal;letter-spacing:0;color:var(--w-ink);font-variant-numeric:tabular-nums}
.v2w .v2w-rdg p{margin:0;font:400 13px/1.5 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-ink)}
.v2w .v2w-rdg p small{color:var(--w-mut);font-size:12px}
/* price + plan levels */
.v2w .v2w-pl{position:relative;height:240px;margin:4px 92px 0 44px;touch-action:pan-y}
.v2w .v2w-pl svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.v2w .v2w-pl .px{fill:none;stroke:var(--w-ink);stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round}
.v2w .v2w-pl .band{fill:color-mix(in srgb,var(--w-acc) 14%,transparent)}
.v2w .v2w-pl .lv{stroke-width:1.25;stroke-dasharray:5 4}
.v2w .v2w-pl .lv.stop{stroke:var(--w-dn)}.v2w .v2w-pl .lv.tgt{stroke:var(--w-up)}
.v2w .v2w-pl .lv.ref{stroke:var(--w-dim);stroke-dasharray:2 4}
.v2w .v2w-pl .lab{position:absolute;right:-92px;width:88px;transform:translateY(-50%);font:500 11px/1.15 var(--ui,var(--f-sans,system-ui,sans-serif));color:var(--w-mut);font-variant-numeric:tabular-nums;white-space:nowrap}
.v2w .v2w-pl .lab b{font-weight:600}
.v2w .v2w-pl .lab.stop b{color:var(--w-dn)}.v2w .v2w-pl .lab.tgt b{color:var(--w-up)}.v2w .v2w-pl .lab.buy b{color:var(--w-acc)}
.v2w .v2w-pl .v2w-y{left:-44px}
@media (max-width:599px){.v2w .v2w-pl{height:200px;margin-right:78px}.v2w .v2w-pl .lab{right:-78px;width:74px;font-size:10px}}`;

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
    return `<div class="v2w-leg" aria-hidden="true"><span><i></i>Paper NAV</span><span><i class="bm"></i>${esc(bname)}</span><span>both rebased to 100 at the start</span></div>
      <div class="v2w-chart" data-v2w-chart="${data}" role="img"
        aria-label="Paper NAV against ${esc(bname)}, rebased to 100, ${n} sessions. Latest: NAV ${pts[n - 1].n ?? 'not recorded'}, ${esc(bname)} ${pts[n - 1].b ?? 'not recorded'}.">
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
    tip.innerHTML = `<b>${esc(day(p[0]))}</b>Paper NAV ${p[1] == null ? 'not recorded' : esc(p[1].toFixed(2)) + (p[3] != null ? ` · ${esc(inr(p[3]))}` : '')}<br>${esc(D.bname)} ${p[2] == null ? 'not recorded' : esc(p[2].toFixed(2)) + (p[4] != null ? ` · ${esc(Number(p[4]).toLocaleString('en-IN'))}` : '')}`;
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
    return `<section class="v2w" aria-label="Where this plan is">
      <h3>Where is this plan in its life?</h3>
      <p class="v2w-per">Published ${esc(when(p.published_at || p.session_date))}</p>
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
  const STATUS_WORD = { research: 'research, not publishing', shadow: 'paper test',
                        forward_paper: 'forward paper', validated: 'validated' };
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
        ? `${plans} Signal plan${plans === 1 ? '' : 's'} ${plans === 1 ? 'is' : 'are'} set for the next session.`
        : `There is no Signal plan for the next session: ${(() => { const t = String(F.status_detail || 'none qualified').split('. ')[0].replace(/\.$/, ''); return t.charAt(0).toLowerCase() + t.slice(1); })()}.`,
        ctx.plansRef || null, 'Plans');
      add(`The forward record, which began ${F.forward_record_start ? day(F.forward_record_start) : 'with the first session scanned'}, has ${m.published ?? 0} published plan${m.published === 1 ? '' : 's'} and ${m.closed ?? 0} closed; no win rate is shown until ${m.min_closed_for_rate || 30} have closed.`,
        ctx.recordRef || null, 'Record');
      const st = F.strategies || [];
      if (st.length) {
        const pub = st.filter((e) => e.publishes).length;
        add(`${st.length} engines are registered and ${pub} publish: ${st.map((e) => `${e.name} (${STATUS_WORD[e.status] || e.status})`).join(', ')}.`,
          ctx.enginesRef || null, 'Engines');
      }
    }
    const PP = F && F.paper;
    if (PP && Array.isArray(PP.engines)) {
      const live = PP.engines.reduce((a, e) => a + (e.open || 0), 0);
      const closed = PP.engines.reduce((a, e) => a + (e.closed || 0), 0);
      add(`Separately, ${PP.engines.length} engines run as a paper test (${PP.engines.map((e) => e.name).join(', ')}): ${live} paper setup${live === 1 ? ' is' : 's are'} open or waiting, and ${closed} paper trade${closed === 1 ? ' has' : 's have'} closed. Paper trades are not counted in the record.`,
        ctx.paperRef || null, 'Paper test');
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


  /* ══ PAPER TEST ════════════════════════════════════════════════════════════
   * The four engines kept after the 2 Oct 2026 review, tracked forward on
   * paper. Everything printed is a field of the feed's `paper` block: this
   * renderer computes no signal, ranks nothing and applies no threshold.
   * It is labelled paper everywhere it appears, and it never feeds the record.
   */
  const PAPER_LIVE = new Set(['awaiting_entry', 'activated', 'partially_exited']);
  const PSTATE = { awaiting_entry: 'Waiting for entry', activated: 'Filled', partially_exited: 'Part sold',
                   closed: 'Closed at targets', stopped: 'Stopped', time_exited: 'Time exit',
                   expired_unfilled: 'Never filled', cancelled: 'Cancelled' };
  const rR = (v) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`;
  const px = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function paper(d, opts = {}) {
    injectCss();
    const Q = 'Paper test';
    const P = d && d.paper;
    const stock = opts.stockHref || ((s) => '#/' + encodeURIComponent(s));
    if (!P || !Array.isArray(P.engines)) {
      return `<section class="v2w" id="paper" aria-label="${Q}"><h3>Paper test <span class="v2w-tag pp">paper</span></h3>
        <p class="v2w-empty"><b>The paper test has not published yet.</b>Four engines (Technical Confluence, Failed Breakdown Reclaim,
        Compression Release, Opening Demand) start recording after the next session's close. Nothing here is a plan until then.</p></section>`;
    }
    const names = Object.fromEntries(P.engines.map((e) => [e.id, e.name]));
    const need = P.min_closed_for_avg || 30;
    const eng = `<ul class="v2w-eng">${P.engines.map((e) => `<li><b>${esc(e.name)} <span class="v2w-tag">${e.kind === 'intraday' ? 'intraday' : 'daily'}</span></b>
        <span class="n">${e.filed || 0} filed · ${e.open || 0} open · ${e.closed || 0} closed${e.closed ? ` (${e.wins || 0}W ${e.losses || 0}L)` : ''} · ${e.avg_r == null ? `avg after ${need} closed (${e.closed || 0}/${need})` : 'avg ' + rR(e.avg_r)}</span>
        <p>${esc(e.what)} ${e.since ? `Recording since ${esc(day(e.since))}.` : 'Starts recording after the next session closes.'}</p></li>`).join('')}</ul>`;
    const live = (P.plans || []).filter((p) => PAPER_LIVE.has(p.state));
    const done = (P.plans || []).filter((p) => !PAPER_LIVE.has(p.state));
    const card = (p) => {
      const sp = p.sell_pct || [40, 35, 25];
      return `<article class="v2w-pc" id="pp-${esc(p.symbol)}"><header><a href="${esc(opts.cardHref ? opts.cardHref(p) : stock(p.symbol))}">${esc(p.symbol)}</a>
          <small>${esc(names[p.engine] || p.engine)}<br>${esc(PSTATE[p.state] || p.state)}</small></header>
        <dl><dt>Buy</dt><dd>${px(p.entry_low)} – ${px(p.entry_high)}</dd>
          <dt>Window</dt><dd>${esc(dayShort(p.for_session))} – ${esc(dayShort(p.valid_through))}</dd>
          <dt>Stop</dt><dd>${px(p.stop)}${p.trailing ? ' (raised)' : p.risk_pct != null ? ` · ${Number(p.risk_pct).toFixed(1)}% under the top` : ''}</dd>
          <dt>Sell</dt><dd class="v2w-sells"><span>${sp[0]}% at ${px(p.t1)}</span><span>${sp[1]}% at ${px(p.t2)}</span><span>${sp[2]}% at ${px(p.t3)}</span></dd>
          ${p.fill_price != null ? `<dt>Filled</dt><dd>${px(p.fill_price)}${p.fill_session ? ' on ' + esc(dayShort(p.fill_session)) : ''} · ${rR(p.total_r)} so far</dd>` : ''}</dl>
        ${p.why ? `<p>Why: ${esc(p.symbol)} ${esc(p.why)}</p>` : ''}</article>`;
    };
    /* THE DIGEST: one line a setup, for a page that points at the full cards
       rather than repeating them. The same levels the card leads with — the
       buy range, the stop and its distance, the window, the state — and a
       link to that card, where the three sells and the reason live. */
    const row = (p) => `<a class="v2w-dr" data-sym="${esc(p.symbol)}" href="${esc(opts.cardHref ? opts.cardHref(p) : stock(p.symbol))}">
        <b>${esc(p.symbol)}</b><span class="e">${esc(names[p.engine] || p.engine)}</span>
        <span class="n">${px(p.entry_low)} – ${px(p.entry_high)}</span>
        <span class="n">${px(p.stop)}${p.risk_pct != null ? ` <i>${Number(p.risk_pct).toFixed(1)}%</i>` : ''}</span>
        <span class="w">${esc(dayShort(p.for_session))} – ${esc(dayShort(p.valid_through))}</span>
        <span class="s">${esc(PSTATE[p.state] || p.state)}${p.fill_price != null ? ' · ' + rR(p.total_r) : ''}</span></a>`;
    const digestHtml = `<div class="v2w-dg" role="list"><div class="v2w-dr v2w-dh" aria-hidden="true"><b>Name</b><span class="e">Engine</span>
        <span class="n">Buy between</span><span class="n">Stop · risk</span><span class="w">Window</span><span class="s">State</span></div>
        ${live.map(row).join('')}</div>`;
    const liveHtml = live.length ? (opts.digest ? digestHtml : `<div class="v2w-pcs">${live.map(card).join('')}</div>`)
      : `<p class="v2w-empty"><b>No paper setup is open or waiting.</b>The engines found nothing that met their rules on the ${esc(day(P.as_of))} close. They are not loosened to fill this space.</p>`;
    const doneHtml = done.length ? `<h4 class="v2w-h">Closed recently</h4><ul class="v2w-rl">${done.map((p) =>
      `<li><span><a class="sym" href="${esc(stock(p.symbol))}">${esc(p.symbol)}</a> · ${esc(names[p.engine] || '')} · ${esc(PSTATE[p.state] || p.state)}</span>
       <span class="r ${p.total_r > 0 ? 'up' : p.total_r < 0 ? 'dn' : ''}">${p.fill_price == null ? 'no fill' : rR(p.total_r)}</span></li>`).join('')}</ul>` : '';
    const intra = (P.intraday || []);
    const intraHtml = intra.length ? `<h4 class="v2w-h">Intraday, graded after the close</h4><ul class="v2w-rl">${intra.map((p) =>
      `<li><span><a class="sym" href="${esc(stock(p.symbol))}">${esc(p.symbol)}</a> · ${esc(dayShort(p.session))} · bought ${px(p.entry)}, stop ${px(p.stop)}</span>
       <span class="r ${p.total_r > 0 ? 'up' : p.total_r < 0 ? 'dn' : ''}">${rR(p.total_r)}</span></li>`).join('')}</ul>` : '';
    return `<section class="v2w" id="paper" aria-label="${Q}">
      <h3>${opts.title ? esc(opts.title) : 'Paper test: four engines, tracked forward'} <span class="v2w-tag pp">paper</span></h3>
      <p class="v2w-per">As of the ${esc(day(P.as_of))} close · simulated fills · no order is placed · not the published record</p>
      ${opts.compact ? '' : eng}
      ${opts.compact ? '' : '<h4 class="v2w-h">Paper setups</h4>'}${liveHtml}${opts.compact ? '' : doneHtml + intraHtml}
      ${opts.digest ? '' : `<p class="v2w-note">${esc(P.basis || '')}</p>`}
      ${opts.moreHref ? `<p class="v2w-more"><a href="${esc(opts.moreHref)}">${opts.digest ? 'Every setup with its sells and reason, and every engine →' : 'Every paper engine and result →'}</a></p>` : ''}</section>`;
  }

  /* ══ TECHNICAL READ ════════════════════════════════════════════════════════
   * One stock's five-part chart read, exactly as the engine computed it after
   * the close (technical_read.json). Printed, never re-derived: no threshold
   * lives here, so the browser cannot disagree with the engine.
   */
  const PHASE = { markup: ['Markup', 'uptrend: 50 EMA above the 200, price above the 50'],
                  distribution: ['Distribution', 'uptrend structure, price has lost the 50 EMA'],
                  markdown: ['Markdown', 'downtrend: 50 EMA below the 200, price below the 50'],
                  accumulation: ['Accumulation', 'downtrend structure, price has reclaimed the 50 EMA'] };
  /* "Conditions favour a long", not "favours entry now": the read scores the
     chart, it sets no price. Beside a paper setup whose range sat below the
     close, "entry now" contradicted the setup's own "above the most to pay".
     The price to pay is always the setup's range, never this read's close. */
  const VERDICT = { enter: 'Conditions favour a long', wait: 'Wait', avoid: 'Avoid for now' };
  function read(feed, sym, opts = {}) {
    injectCss();
    const Q = 'Technical read';
    if (!feed) return failCard(Q, 'The technical reads', opts.error || 'technical_read.json did not load');
    const r = feed.reads && feed.reads[sym];
    if (!r) {
      return `<section class="v2w" aria-label="${Q}"><h3>${Q}</h3>
        <p class="v2w-empty"><b>No read for ${esc(sym)}.</b>It needs about a year of completed daily bars and a bar on the ${esc(day(feed.session_date))} close; this name has not got both.</p></section>`;
    }
    const pts = r.pts || [];
    const MAX = [3, 2, 2, 2, 1];
    const ph = PHASE[r.phase] || [r.phase, ''];
    const sc = `<div class="v2w-sc" role="img" aria-label="${r.score} of 10 conditions met">${Array.from({ length: 10 }, (_, i) => `<i${i < r.score ? ' class="on"' : ''}></i>`).join('')}</div>`;
    const v = r.action === 'wait' && r.wait_at != null ? `Wait for ${esc(r.wait_for || 'a better level')} (${px(r.wait_at)})` : VERDICT[r.action] || r.action;
    const box = (t, i, body) => `<div><h4>${t}<em>${pts[i] != null ? pts[i] + '/' + MAX[i] : ''}</em></h4><p>${body}</p></div>`;
    return `<section class="v2w" aria-label="${Q}">
      <h3>${Q} <span class="v2w-tag">rules, not a forecast</span></h3>
      <p class="v2w-per">${esc(sym)} · ${esc(day(feed.session_date))} close · ${px(r.c)}</p>
      <div class="v2w-vd ${esc(r.action)}"><b>${v}</b>
        <span>Conditions met: <strong>${r.score}/10</strong> · Favoured timeframe: ${r.tf ? esc(r.tf) : 'none'}${r.action === 'enter' && r.stop != null ? ` · stop under support ${px(r.stop)}` : ''}</span></div>
      ${sc}
      <div class="v2w-rdg">
        ${box('Trend structure', 0, `<b>${esc(ph[0])}</b> <small>${esc(ph[1])}</small><br>50 EMA ${px(r.e50)} · 200 EMA ${px(r.e200)} ${r.e200_up ? '(rising)' : '(not rising)'}`)}
        ${box('Key levels', 1, `Support ${px(r.sup)}${r.sup_n ? ` <small>(${r.sup_n} touches)</small>` : ''}${r.near_sup ? ' · <b>approaching</b>' : ''}<br>
          Resistance ${r.res == null ? 'none within a year' : px(r.res)}${r.res_52w ? ' <small>(52-week high)</small>' : ''}${r.near_res ? ' · <b>approaching</b>' : ''}
          ${r.rr != null ? `<br><small>${r.rr.toFixed(1)}R of room to resistance</small>` : ''}`)}
        ${box('Momentum', 2, `RSI ${r.rsi == null ? '—' : r.rsi.toFixed(0)} <small>(${esc(r.rsi_state || '—')})</small><br>Divergence: ${r.div ? esc(r.div) : 'none'}`)}
        ${box('Volume', 3, `${esc(r.vol_state || '—')}${r.vol_ratio != null ? ` <small>· up-day volume ${r.vol_ratio.toFixed(2)}× down-day</small>` : ''}`)}
        <div><h4>Outlook <em>by rule</em></h4><p>Next session: ${esc(r.lean)}<br>1 week: ${px(r.wk && r.wk[0])} – ${px(r.wk && r.wk[1])} <small>(typical range)</small><br>
          6 months: ${esc(r.m6 || '—')} · Long term: ${esc(r.lt || '—')}</p></div>
        ${box('Extension', 4, `${r.ext == null ? '—' : Math.abs(r.ext).toFixed(1) + ' ATR ' + (Math.sign(r.ext) === -1 ? 'below' : 'above') + ' the 50 EMA'}`)}
      </div>
      ${(r.why || []).length ? `<p class="v2w-note">Why: ${esc(r.why.join('; '))}.</p>` : ''}
      <p class="v2w-note">${esc(feed.basis || '')} Technicals alone never make a holding thesis. Not advice.</p></section>`;
  }


  /* ══ PRICE WITH THE PLAN'S LEVELS ══════════════════════════════════════════
   * Six months of daily closes on ONE price axis, with the levels a reader
   * acts on drawn across it: the buy range (a band), the stop, three targets,
   * and the read's support and resistance. Every level is an upstream field;
   * the chart places them and computes nothing about them. Labels are nudged
   * apart so two close levels never print on top of each other.
   */
  function levels(series, lv = {}, opts = {}) {
    injectCss();
    const Q = 'Price and levels';
    const pts = cleanPts(series).slice(-130);
    if (pts.length < 10) return failCard(Q, 'The price history', opts.error || 'fewer than ten daily closes');
    const L = [];
    const add = (v, cls, label) => { if (Number.isFinite(Number(v)) && Number(v) > 0) L.push({ v: Number(v), cls, label }); };
    add(lv.stop, 'stop', 'Stop');
    (lv.t || []).forEach((v, i) => add(v, 'tgt', 'T' + (i + 1)));
    add(lv.sup, 'ref', 'Support');
    add(lv.res, 'ref', 'Resistance');
    const band = Array.isArray(lv.entry) && lv.entry.every((v) => Number(v) > 0) ? lv.entry.map(Number) : null;
    const all = pts.map((p) => p.c).concat(L.map((x) => x.v), band || []);
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.06 || hi * 0.02;
    lo -= pad; hi += pad;
    const W = 1000, H = 1000, n = pts.length;
    const x = (i) => (i / (n - 1)) * W, y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
    // Label placement: sorted top to bottom, then pushed apart by a minimum gap.
    const labs = L.map((x2) => ({ ...x2, top: y(x2.v) / H * 100 }));
    if (band) labs.push({ v: band[1], cls: 'buy', label: 'Buy', top: y((band[0] + band[1]) / 2) / H * 100, range: band });
    labs.sort((a, b) => a.top - b.top);
    for (let i = 1; i < labs.length; i++) if (labs[i].top - labs[i - 1].top < 7.5) labs[i].top = labs[i - 1].top + 7.5;
    const money = (v) => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: v < 100 ? 2 : 0 });
    const last = pts[n - 1];
    const data = esc(JSON.stringify({ p: pts.map((p) => [p.t, p.c]), lo, hi }));
    return `<section class="v2w" aria-label="${Q}"><h3>${esc(opts.title || Q)}</h3>
      <p class="v2w-per">${esc(opts.sym || '')} · ${n} daily closes to ${esc(day(last.t))} · last close ${money(last.c)}</p>
      <div class="v2w-pl" data-v2w-lv="${data}" role="img" aria-label="${esc(opts.sym || 'Price')}: ${n} daily closes, last ${money(last.c)}. ${labs.map((l) => l.range ? `buy ${money(l.range[0])} to ${money(l.range[1])}` : `${l.label} ${money(l.v)}`).join(', ')}.">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          ${band ? `<rect class="band" x="0" width="${W}" y="${y(band[1]).toFixed(1)}" height="${Math.max(2, y(band[0]) - y(band[1])).toFixed(1)}"/>` : ''}
          ${L.map((l) => `<line class="lv ${l.cls}" x1="0" x2="${W}" y1="${y(l.v).toFixed(1)}" y2="${y(l.v).toFixed(1)}" vector-effect="non-scaling-stroke"/>`).join('')}
          <path class="px" d="${d}" vector-effect="non-scaling-stroke"/>
        </svg>
        <span class="v2w-y" style="top:0%">${money(hi - pad)}</span><span class="v2w-y" style="top:100%">${money(lo + pad)}</span>
        ${labs.map((l) => `<span class="lab ${l.cls}" style="top:${Math.min(100, l.top).toFixed(2)}%"><b>${esc(l.label)}</b> ${l.range ? `${money(l.range[0])}–${money(l.range[1])}` : money(l.v)}</span>`).join('')}
        <div class="v2w-cross"></div><div class="v2w-dot nav"></div><div class="v2w-tip" role="status"></div>
      </div>
      <div class="v2w-x" aria-hidden="true" style="margin-right:92px"><span>${esc(dayShort(pts[0].t))}</span><span>${esc(dayShort(last.t))}</span></div>
      ${opts.note ? `<p class="v2w-note">${esc(opts.note)}</p>` : ''}</section>`;
  }
  function onLvMove(el, ev) {
    let D;
    try { D = JSON.parse(el.getAttribute('data-v2w-lv')); } catch (e) { return; }
    const r = el.getBoundingClientRect(), n = D.p.length;
    const i = Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * (n - 1)), p = D.p[i];
    const px = (i / (n - 1)) * r.width, py = (1 - (p[1] - D.lo) / (D.hi - D.lo)) * r.height;
    const cross = el.querySelector('.v2w-cross'), dot = el.querySelector('.v2w-dot'), tip = el.querySelector('.v2w-tip');
    cross.style.display = 'block'; cross.style.left = px + 'px';
    dot.style.display = 'block'; dot.style.left = px + 'px'; dot.style.top = py + 'px';
    tip.innerHTML = `<b>${esc(day(p[0]))}</b>Close ₹${esc(Number(p[1]).toLocaleString('en-IN', { maximumFractionDigits: 2 }))}`;
    tip.style.display = 'block';
    tip.style.left = Math.min(Math.max(0, px + 12), r.width - tip.offsetWidth) + 'px';
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
      const lvc = e.target.closest('[data-v2w-lv]');
      if (lvc) onLvMove(lvc, e);
      const hc = e.target.closest('.v2w-hc[data-i]');
      if (hc) onHmOver(hc);
    });
    document.addEventListener('pointerleave', (e) => {
      if (!e.target || !e.target.matches) return;
      if (e.target.matches('[data-v2w-chart]')) onChartLeave(e.target);
      if (e.target.matches('[data-v2w-mk]')) for (const c of e.target.querySelectorAll('.v2w-cross,.v2w-tip')) c.style.display = 'none';
      if (e.target.matches('[data-v2w-lv]')) for (const c of e.target.querySelectorAll('.v2w-cross,.v2w-dot,.v2w-tip')) c.style.display = 'none';
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

  /* ══ TRADE PASSPORT ════════════════════════════════════════════════════════
   * One paper setup, the same on both sites: its plan, whether its entry still
   * holds against a delayed quote, its exit ladder in shares and rupees, and
   * what happened to it. Every level comes from the feed; nothing here selects
   * or scores. The entry check compares a quote with the published range and
   * says which side of it the price is on, with the quote's basis named — a
   * delayed quote in the session, the last close outside it, never "live". */
  const pct1 = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
  function entry(p, q, ctx = {}) {
    const x = q && Number.isFinite(Number(q.price)) ? Number(q.price) : null;
    /* The basis is the quote's own trade time when it carries one. Without it,
       the session clock decides: delayed inside the session, the close outside. */
    const ts = q && Number.isFinite(Number(q.as_of)) ? new Date(Number(q.as_of) * 1000 + 330 * 60000).toISOString() : null;
    const basis = ts ? `last trade ${dayShort(ts.slice(0, 10))} ${ts.slice(11, 16)} IST, delayed`
      : ctx.open ? `delayed quote${ctx.at ? ' at ' + ctx.at + ' IST' : ''}` : 'last close';
    const at = x == null ? '' : `${px(x)} (${basis})`;
    if (!PAPER_LIVE.has(p.state)) return { k: 'done', word: PSTATE[p.state] || p.state, line: '' };
    /* Held by the grader at a missing session: the engine says from when and
       why. Nothing after that day has been graded, so no live comparison is
       offered as though it were current. */
    if (p.grading_gap) return { k: 'gap', word: 'Not graded', line: `Not graded from ${dayShort(p.grading_gap.from)}: ${p.grading_gap.why}. Held there, nothing guessed; it is graded from that day once the data arrives.` };
    if (p.state !== 'awaiting_entry') {
      if (x == null || p.fill_price == null) return { k: 'held', word: PSTATE[p.state] || 'Filled', line: `Filled at ${px(p.fill_price)}. No quote right now.` };
      return { k: 'held', word: PSTATE[p.state] || 'Filled',
        line: `Filled at ${px(p.fill_price)}. Now ${at}, ${pct1((x / p.fill_price - 1) * 100)} from the fill; the stop is ${px(p.stop)}.` };
    }
    if (x == null) return { k: 'na', word: 'Entry check unavailable', line: `No quote for ${p.symbol} right now, so this page cannot say where the price sits against the range.` };
    const opens = ctx.today && p.for_session > ctx.today ? ` The window opens ${dayShort(p.for_session)}.` : '';
    if (x <= p.stop) return { k: 'void', word: 'At or below the stop',
      line: `${at} is at or below the ${px(p.stop)} stop. A setup is cancelled if its stop trades before it fills.${opens}` };
    if (x > p.entry_high) return { k: 'above', word: 'Above the most to pay',
      line: `${at} is ${pct1((x / p.entry_high - 1) * 100)} above ${px(p.entry_high)}. It fills only if price comes back into the range by ${dayShort(p.valid_through)}; it is never chased.${opens}` };
    if (x < p.entry_low) return { k: 'below', word: 'Under the buy range',
      line: `${at} is under ${px(p.entry_low)} and above the stop.${opens}` };
    return { k: 'in', word: 'Inside the buy range', line: `${at} is between ${px(p.entry_low)} and ${px(p.entry_high)}.${opens}` };
  }

  /* The exit plan in shares and rupees, measured from the fill — or, before a
     fill, from the most it pays, and labelled so. Cash back is shown apart from
     profit, because the first includes the money that went in. The downside is
     the initial stop on the whole position, before costs, and says a gap can
     open through it. */
  function ladder(p) {
    const tr = Array.isArray(p.tranches) && p.tranches.length === 3 && p.qty ? p.tranches : null;
    const sp = p.sell_pct || [40, 35, 25];
    if (!tr) {
      return `<p class="v2w-empty"><b>Sells ${sp[0]}%, ${sp[1]}% and ${sp[2]}% at ${px(p.t1)}, ${px(p.t2)} and ${px(p.t3)}.</b>Share counts appear with the next scan.</p>`;
    }
    const ref = p.fill_price != null ? p.fill_price : p.entry_high;
    const refWord = p.fill_price != null ? `the ${px(p.fill_price)} fill` : `${px(p.entry_high)}, the most it pays`;
    const istop = p.initial_stop != null ? p.initial_stop : p.stop;
    let left = p.qty, back = 0, gain = 0;
    const rows = [p.t1, p.t2, p.t3].map((t, k) => {
      left -= tr[k]; back += tr[k] * t; gain += tr[k] * (t - ref);
      return `<tr><th scope="row">T${k + 1}</th><td>${px(t)}</td><td>${tr[k]}</td><td>${left}</td><td>${inr(back)}</td><td class="up">${inr(gain)}</td></tr>`;
    }).join('');
    const loss = (ref - istop) * p.qty;
    return `<div class="v2w-ladw"><table class="v2w-lad"><caption>Paper position: ${p.qty} shares, ${inr(p.qty * ref)} at ${esc(refWord)}</caption>
      <thead><tr><th scope="col">Exit</th><th scope="col">Price</th><th scope="col">Sell</th><th scope="col">Left</th><th scope="col">Cash back</th><th scope="col">Profit</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="v2w-note">If the ${px(istop)} stop trades before T1, the whole position is sold: a loss of about ${inr(loss)} on ${p.qty} shares, before costs. A gap can open through a stop, so a real loss can be larger. Both money columns are running totals. Cash back includes the money paid in; only Profit is gain, before costs.</p>`;
  }

  /* SINCE THE LAST SCAN. Built from dated fields the feed already carries —
     fills, exits and the day a setup ended — so it lists what happened on the
     latest close and nothing older. Problems first: a stop or a cancellation
     outranks a target, a target outranks a fill, a fill outranks a new setup. */
  function changes(d, opts = {}) {
    injectCss();
    const P = d && d.paper;
    if (!P || !Array.isArray(P.plans)) return '';
    const s = P.as_of, href = opts.href || ((p) => '#'), names = Object.fromEntries((P.engines || []).map((e) => [e.id, e.name]));
    const items = [];
    for (const p of P.plans) {
      for (const x of p.exits || []) {
        if (x.session !== s) continue;
        const stop = /stop/.test(x.reason || ''), time = /time/.test(x.reason || '');
        items.push({ r: stop ? 0 : time ? 1 : 2, p, tag: stop ? 'Stopped' : time ? 'Time exit' : 'Target',
          text: `${stop ? 'Stop' : time ? 'Time exit' : esc(x.reason)} at ${px(x.price)}: ${x.qty} shares sold` });
      }
      if (p.ended_session === s && p.state === 'cancelled') items.push({ r: 0, p, tag: 'Cancelled', text: 'Cancelled before it filled: the stop traded first' });
      if (p.ended_session === s && p.state === 'expired_unfilled') items.push({ r: 1, p, tag: 'Lapsed', text: 'Lapsed: the buy range never traded in its window' });
      if (p.fill_session === s) items.push({ r: 3, p, tag: 'Filled', text: `Filled at ${px(p.fill_price)}` });
    }
    const fresh = P.plans.filter((p) => p.filed_session === s && p.state === 'awaiting_entry');
    items.sort((a, b) => a.r - b.r || a.p.symbol.localeCompare(b.p.symbol));
    const li = items.map((x) => `<li class="r${x.r}"><span class="t">${esc(x.tag)}</span><a href="${esc(href(x.p))}"><b>${esc(x.p.symbol)}</b></a>
      <span class="w">${x.text} <i>${esc(names[x.p.engine] || '')}</i></span></li>`);
    if (fresh.length) li.push(`<li class="r4"><span class="t">New</span><span class="w">${fresh.length} new paper setup${fresh.length > 1 ? 's' : ''} for the ${esc(dayShort(fresh[0].for_session))} session: ${fresh.map((p) => `<a href="${esc(href(p))}">${esc(p.symbol)}</a>`).join(', ')}</span></li>`);
    return `<section class="v2w v2w-chs" aria-label="Since the last scan">
      <h3>Since the last scan <span class="v2w-per">${esc(day(s))} close · paper</span></h3>
      ${li.length ? `<ul class="v2w-ch">${li.join('')}</ul>` : `<p class="v2w-empty"><b>Nothing changed on the ${esc(day(s))} close.</b>No setup was filed, filled, sold, stopped or lapsed.</p>`}</section>`;
  }

  /* The whole Passport for one setup. `slot` is where the caller writes the
     entry check once its quote arrives; until then it says it is checking. */
  const entryHtml = (e) => `<div class="v2w-chk k-${esc(e.k)}" role="status"><b>${esc(e.word)}</b><span>${esc(e.line)}</span></div>`;
  function passport(p, d, opts = {}) {
    injectCss();
    const P = (d && d.paper) || {}, names = Object.fromEntries((P.engines || []).map((e) => [e.id, e.name]));
    const sp = p.sell_pct || [40, 35, 25];
    const hist = [`<li><time>${esc(dayShort(p.filed_session))}</time> Recorded after the close by ${esc(names[p.engine] || p.engine)}, for the ${esc(dayShort(p.for_session))}–${esc(dayShort(p.valid_through))} window.</li>`]
      .concat(p.fill_price != null ? [`<li><time>${esc(dayShort(p.fill_session))}</time> Filled at ${px(p.fill_price)} (simulated).</li>`] : [])
      .concat((p.exits || []).map((x) => `<li><time>${esc(dayShort(x.session))}</time> ${esc(x.reason)} at ${px(x.price)}: ${x.qty} shares sold.</li>`))
      .concat(p.ended_session && !(p.exits || []).length ? [`<li><time>${esc(dayShort(p.ended_session))}</time> ${esc(PSTATE[p.state] || p.state)}.</li>`] : []);
    return `<section class="v2w v2w-pp" aria-label="Setup ${esc(p.symbol)}">
      <h3>${opts.noSymbol ? 'The setup' : esc(p.symbol)} <span class="v2w-tag pp">paper</span> <span class="v2w-st">${esc(PSTATE[p.state] || p.state)}</span></h3>
      <p class="v2w-per">${esc(names[p.engine] || p.engine)} · long · NSE cash · recorded after the ${esc(day(p.filed_session))} close · simulated fills, no order is placed${p.rules ? ` · rules ${esc(p.rules)}` : ''}</p>
      <div class="v2w-ent" data-v2w-entry>${opts.entryHtml || '<p class="v2w-note">Checking the price against the range…</p>'}</div>
      <dl class="v2w-plan">
        <div><dt>Buy between</dt><dd>${px(p.entry_low)} – ${px(p.entry_high)}</dd></div>
        <div><dt>Most to pay</dt><dd>${px(p.entry_high)} <span>an open above it does not fill</span></dd></div>
        <div><dt>Window</dt><dd>${esc(dayShort(p.for_session))} – ${esc(dayShort(p.valid_through))}</dd></div>
        <div><dt>Stop</dt><dd>${px(p.stop)}${p.initial_stop != null && p.stop !== p.initial_stop ? ` <span>raised from ${px(p.initial_stop)}</span>` : p.risk_pct != null ? ` <span>${Number(p.risk_pct).toFixed(1)}% under the top of the range</span>` : ''}</dd></div>
        <div><dt>Sell</dt><dd>${sp[0]}% at ${px(p.t1)} · ${sp[1]}% at ${px(p.t2)} · ${sp[2]}% at ${px(p.t3)}</dd></div>
      </dl>
      ${p.why ? `<p class="v2w-why"><b>Why it was recorded:</b> ${esc(p.symbol)} ${esc(p.why)}</p>` : ''}
      <h4 class="v2w-h">Exit ladder</h4>${ladder(p)}
      <h4 class="v2w-h">History</h4><ol class="v2w-hist">${hist.join('')}</ol>
      <p class="v2w-note">A trade at or below the stop before any fill cancels the setup; not filled by ${esc(dayShort(p.valid_through))}, it lapses. After target 2 the stop is raised under each new swing low, never lowered. Paper test, not proven, not advice.</p>
    </section>`;
  }

  /* REPLAY OF A FINISHED PAPER SETUP (paper_record.json, paper-record/1).
   * What happened, in order, from the engine's own record: the levels as
   * recorded, the simulated fill, each stop raise and the session it took
   * effect after, each exit, the end. Every figure is a field; the browser
   * subtracts a fill from an exit price to say what those shares made before
   * costs, and nothing else. The result is the engine's net R and net rupees,
   * after its estimated charges. There is no intraday path: daily bars say
   * where a session traded, not in what order, and the page says so. */
  const FLAG_NOTE = {
    ambiguous: 'On one session a single daily bar reached both a target and the stop. A daily bar does not say which came first, so the stop was booked first: the worse of the two.',
    gap_through_stop: 'It opened below the stop, so it was sold at the open, lower than the stop.',
    same_day_stop_after_limit_fill: 'It filled and traded through the stop in the same session.',
    circuit_blocked: 'A lower circuit stopped any sale on at least one session; it was sold when trading allowed.',
  };
  const ENDED = { closed: 'Sold at its last target', stopped: 'Stopped out', time_exited: 'Sold on the clock (time exit)',
                  expired_unfilled: 'Lapsed: never filled', cancelled: 'Cancelled before a fill' };
  function replay(t, rec, opts = {}) {
    injectCss();
    if (!t) return `<section class="v2w v2w-rp"><h3>Replay</h3><p class="v2w-empty">${esc(opts.error || 'A replay is shown once a setup has finished.')}</p></section>`;
    const names = Object.fromEntries(((rec && rec.engines) || []).map((e) => [e.id, e.name]));
    const filled = t.fill_price != null, fp = t.fill_price;
    const sp = t.sell_pct || [40, 35, 25];
    const stop0 = t.initial_stop != null ? t.initial_stop : t.stop;
    const ex = t.exits || [], stops = t.stops || [];
    /* The outcome first, in words, then the number. */
    const sign = t.total_r == null ? '' : t.total_r > 0.02 ? 'up' : t.total_r < -0.02 ? 'dn' : '';
    const money = t.net_inr == null ? '' : t.net_inr < 0 ? `a net loss of ${inr(-t.net_inr)}` : `a net gain of ${inr(t.net_inr)}`;
    const head = filled
      ? `<p class="v2w-rp-out ${sign}"><b>${esc(ENDED[t.state] || PSTATE[t.state] || t.state)}</b> <span class="r">${rR(t.total_r)}</span></p>
         <p class="v2w-rp-sub">${money ? esc(money) + ' on the paper position' : ''}${t.charges_inr != null ? `, after ${inr(t.charges_inr)} of estimated charges` : ''}${t.held_sessions != null ? ` · held ${t.held_sessions} session${t.held_sessions === 1 ? '' : 's'}` : ''}. R is the net result over the risk at the fill.</p>`
      : `<p class="v2w-rp-out"><b>${esc(ENDED[t.state] || PSTATE[t.state] || t.state)}</b> <span class="r">no result</span></p>
         <p class="v2w-rp-sub">Nothing was bought, so there is no gain or loss to report. It stays in the record as ${t.state === 'cancelled' ? 'cancelled' : 'unfilled'}, counted, and in no win rate.</p>`;
    /* The level map: where the setup's levels sat, and the range it traded
       over while held. Levels only, no time axis, because there is no path. */
    let map = '';
    if (filled && t.high_seen != null && t.low_seen != null) {
      const pts = [stop0, t.stop, t.entry_low, t.entry_high, t.t1, t.t2, t.t3, t.high_seen, t.low_seen, fp, ...ex.map((x) => x.price)].filter((v) => v != null && isFinite(v));
      const lo = Math.min(...pts), hi = Math.max(...pts), w = hi - lo || 1;
      const at = (v) => ((v - lo) / w * 100).toFixed(2) + '%';
      const tick = (v, cls, label) => v == null ? '' : `<i class="${cls}" style="left:${at(v)}" title="${esc(label)} ${px(v)}"></i>`;
      map = `<figure class="v2w-rp-map" aria-label="Levels and the range traded while held">
        <div class="bar"><span class="seen" style="left:${at(t.low_seen)};width:calc(${at(t.high_seen)} - ${at(t.low_seen)})"></span>
          <span class="zone" style="left:${at(t.entry_low)};width:calc(${at(t.entry_high)} - ${at(t.entry_low)})"></span>
          ${tick(stop0, 'st', 'Stop as recorded')}${t.stop !== stop0 ? tick(t.stop, 'st2', 'Stop at the end') : ''}
          ${tick(t.t1, 'tg', 'T1')}${tick(t.t2, 'tg', 'T2')}${tick(t.t3, 'tg', 'T3')}${tick(fp, 'fl', 'Fill')}
          ${ex.map((x) => tick(x.price, 'xt', 'Exit ' + x.reason)).join('')}</div>
        <div class="ax"><span>${px(lo)}</span><span>${px(hi)}</span></div>
        <figcaption><span><i class="k seen"></i>traded while held ${px(t.low_seen)} – ${px(t.high_seen)}</span>
          <span><i class="k zone"></i>entry range</span><span><i class="k st"></i>stop</span><span><i class="k tg"></i>targets</span>
          <span><i class="k fl"></i>fill</span><span><i class="k xt"></i>exits</span></figcaption>
      </figure>
      <p class="v2w-note">${t.high_seen >= t.t1 ? `At best it traded ${px(t.high_seen)}, at or above T1 (${px(t.t1)}).`
        : `At best it traded ${px(t.high_seen)}, ${px(t.t1 - t.high_seen)} short of T1 (${px(t.t1)}).`}
        At worst ${px(t.low_seen)}. These are the highest high and lowest low of the daily bars while it was held, not an order of events.</p>`;
    }
    const steps = [`<li><time>${esc(dayShort(t.filed_session))}</time> <b>Recorded</b> after the close by ${esc(names[t.engine] || t.engine)}: buy ${px(t.entry_low)} – ${px(t.entry_high)} from ${esc(dayShort(t.for_session))} to ${esc(dayShort(t.valid_through))}, stop ${px(stop0)}, sell ${sp[0]}% at ${px(t.t1)}, ${sp[1]}% at ${px(t.t2)}, ${sp[2]}% at ${px(t.t3)}. Fixed from here on.</li>`];
    if (filled) steps.push(`<li><time>${esc(dayShort(t.fill_session))}</time> <b>Filled</b> at ${px(fp)}${t.qty ? `, ${t.qty} shares` : ''} (simulated).</li>`);
    const evs = stops.map((x) => ({ k: x.effective_after, o: 0, h: `<li><time>${esc(dayShort(x.effective_after))}</time> <b>Stop raised</b> from ${px(x.from)} to ${px(x.to)}, under a new swing low; it applies from the next session.</li>` }))
      .concat(ex.map((x, i) => {
        const per = filled ? x.price - fp : null;
        return { k: x.session, o: 1 + i, h: `<li><time>${esc(dayShort(x.session))}</time> <b>Sold ${x.qty} at ${px(x.price)}</b>, ${esc(x.reason)}${per != null ? `: ${per >= 0 ? '+' : '−'}${inr(Math.abs(per * x.qty))} on these shares before costs` : ''}.</li>` };
      }))
      .sort((a, b) => String(a.k).localeCompare(String(b.k)) || a.o - b.o);
    steps.push(...evs.map((x) => x.h));
    if (t.ended_session) steps.push(`<li><time>${esc(dayShort(t.ended_session))}</time> <b>Ended:</b> ${esc((ENDED[t.state] || t.state).toLowerCase())}.</li>`);
    const notes = (t.flags || []).filter((f) => FLAG_NOTE[f]).map((f) => `<li>${FLAG_NOTE[f]}</li>`).join('');
    return `<section class="v2w v2w-rp" aria-label="Replay ${esc(t.symbol)}">
      <h3>${opts.noSymbol ? 'Replay' : esc(t.symbol)} <span class="v2w-tag pp">paper</span> <span class="v2w-st">finished${t.ended_session ? ' ' + esc(day(t.ended_session)) : ''}</span></h3>
      <p class="v2w-per">${esc(names[t.engine] || t.engine)} · long · NSE cash · simulated fills on daily bars, no order was placed${t.rules ? ` · rules ${esc(t.rules)}` : ''}</p>
      ${head}${map}
      <h4 class="v2w-h">What happened</h4><ol class="v2w-hist v2w-rp-tl">${steps.join('')}</ol>
      ${notes ? `<h4 class="v2w-h">How it was booked</h4><ul class="v2w-rp-n">${notes}</ul>` : ''}
      ${t.why ? `<p class="v2w-why"><b>Why it was recorded:</b> ${esc(t.symbol)} ${esc(t.why)}</p>` : ''}
      <p class="v2w-note">Paper test: recorded in public before the session and graded under the same rules. Not proven, not advice, and no reader's own trade is reported here.</p>
    </section>`;
  }

  /* Every finished paper setup, newest first, each linking to its replay.
   * Counts are the record's own; no average or rate is computed here. */
  function finished(rec, opts = {}) {
    injectCss();
    if (!rec) return failCard('Finished paper setups', 'The record of finished setups', opts.error || 'paper_record.json did not load');
    const T = rec.trades || [], c = rec.counts || {};
    const names = Object.fromEntries((rec.engines || []).map((e) => [e.id, e.name]));
    const href = opts.href || ((t) => '#');
    if (!T.length) return `<div class="v2w v2w-fin"><p class="v2w-empty"><b>No paper setup has finished yet.</b> Each one appears here on the day it ends, stopped, sold at its last target, exited on the clock or lapsed, with a replay of what happened. None is removed.</p></div>`;
    const rows = T.map((t) => `<a class="v2w-fr" href="${esc(href(t))}"><span class="s">${esc(t.symbol)}</span>
      <span class="e">${esc(names[t.engine] || t.engine)}</span><span class="d">${esc(dayShort(t.filed_session))} → ${esc(t.ended_session ? dayShort(t.ended_session) : '—')}</span>
      <span class="o">${esc(ENDED[t.state] || PSTATE[t.state] || t.state)}</span>
      <span class="r ${t.total_r == null ? '' : t.total_r > 0.02 ? 'up' : t.total_r < -0.02 ? 'dn' : ''}">${t.total_r == null ? 'no fill' : rR(t.total_r)}</span></a>`).join('');
    return `<div class="v2w v2w-fin">
      <p class="v2w-per">${c.finished ?? T.length} finished · ${c.filled ?? '—'} filled · ${c.unfilled ?? '—'} never filled. Net of estimated charges, in R of the risk at the fill.</p>
      <div class="v2w-fl">${rows}</div></div>`;
  }

  window.V2W = { perf, calendar, lifecycle, market: { nifty, days, sectors, movers }, explain, paper, read, levels, entry, entryHtml, ladder, changes, passport, replay, finished };
})();
