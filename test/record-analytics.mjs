import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/record-analytics.js';
import '../public/signal-ui.js';
const A = globalThis.SignalAnalytics, UI = globalThis.SignalUI;
const trade = (id, r, extra = {}) => ({ id: String(id), symbol: 'EXAMPLE', engine: 'test', state: 'closed',
  fill: { price: 100 }, total_r: r, net_pnl_inr: r == null ? null : r * 1000,
  closed_session: '2026-10-' + String(id).padStart(2, '0'), ...extra });
const feed = plans => ({ schema: 'signal-v2-public/1', plans, metrics: { closed: plans.filter(A.closed).length } });

test('main diagnostics never mix in paper, trial, gross or open outcomes', () => {
  const f = feed([trade(1, 2), trade(2, -1), trade(3, 0), trade(4, 99, { state: 'activated' }), trade(5, 99, { fill: null })]);
  f.paper = { plans: [trade(6, 100)] }; f.engines = { pulse: { plans: [trade(7, 100)] } };
  const a = A.main(f);
  assert.equal(a.closed, 3); assert.equal(a.r.cumulative, 1);
  assert.equal(a.r.avgWin, 2); assert.equal(a.r.avgLoss, -1); assert.equal(a.r.payoff, 2);
  assert.ok(Math.abs(a.r.hitRate - 100 / 3) < 1e-10); assert.equal(a.r.expectancy, 1 / 3);
  assert.equal(a.inr.cumulative, 1000); assert.equal(a.r.maxDrawdown, 1);
  assert.equal(A.main({ schema: 'signal-trials/1', plans: f.plans }), null);
});
test('drawdown includes loss from initial zero, sequence is chronological, zero ends a losing streak', () => {
  const a = A.main(feed([trade(4, 0), trade(2, -2), trade(1, -1), trade(3, 1), trade(5, -4)]));
  assert.equal(a.r.maxDrawdown, 6); assert.equal(a.r.longestLosingStreak, 2);
  assert.deepEqual(a.r.points.map(p => p.value), [-1, -3, -2, -2, -6]);
});
test('missing R is not zero, gaps cannot produce an invented cumulative path or drawdown', () => {
  const a = A.main(feed([trade(1, 2), trade(2, null, { gross_r: 5 }), trade(3, -1)]));
  assert.equal(a.r.n, 2); assert.equal(a.r.expectancy, .5);
  assert.deepEqual(a.r.points.map(p => p.value), [2, null, null]);
  assert.equal(a.r.maxDrawdown, null); assert.equal(a.r.longestLosingStreak, null);
  for (const value of [null, undefined, '', ' ', [], {}, true, 'NaN']) assert.equal(A.num(value), null);
});
test('undated closes withhold curves; current regime and calendar days are not guessed', () => {
  const a = A.main(feed([trade(1, 2, { closed_session: null, fill_session: '2026-10-01', regime: 'risk_on' }), trade(2, -1)]));
  assert.equal(a.r.maxDrawdown, null); assert.ok(a.r.points.every(p => p.value === null));
  assert.equal(a.regimes[0].name, 'Not recorded'); assert.equal(a.holding[0].name, 'Not recorded');
});
test('rolling expectancy requires 20 complete consecutive outcomes, preserves gaps', () => {
  const rows = Array.from({ length: 25 }, (_, i) => trade(i + 1, i % 2 ? -1 : 2));
  const a = A.main(feed(rows));
  assert.equal(a.r.points[18].rolling, null); assert.equal(a.r.points[19].rolling, .5);
  rows[10].total_r = null;
  assert.equal(A.main(feed(rows)).r.points[24].rolling, null);
});
test('engine, holding and publication-regime groups have explicit coverage', () => {
  const a = A.main(feed([trade(1, 2, { held_sessions: 3, market_context: { above_50dma: true } }),
    trade(2, -1, { engine: 'other', held_sessions: 22, publication_regime: 'below' })]));
  assert.equal(a.engines.length, 2); assert.equal(a.holding.length, 2); assert.equal(a.regimes.length, 2);
  assert.ok(UI.analytics(a).includes('R sample 2/2'));
});
test('empty record has no measured rate, includes preliminary and chart empty states', () => {
  const a = A.main(feed([]));
  assert.equal(a.r.hitRate, null); assert.equal(a.r.maxDrawdown, null);
  const html = UI.analytics(a);
  assert.match(html, /Insufficient sample/); assert.match(html, /Needs 20 consecutive closed trades/);
  assert.doesNotMatch(html, /NaN|Infinity|0% \(R sample\)/);
});
test('worked example uses closed main rows only, otherwise clearly illustrates without success', () => {
  const f = feed([]); f.paper = { plans: [trade(1, 10)] };
  assert.match(UI.example(f), /Illustration only/); assert.match(UI.example(f), /Outcome and net R: not applicable/);
  assert.doesNotMatch(UI.example(f), /\+10\.00R/);
  assert.match(UI.example(feed([trade(1, -1)])), /Past example from the main forward record/);
});
test('state filtering renders real table and preserves zero/unknown level semantics', () => {
  const html = UI.setups([trade(1, 0), { id: 'wait', symbol: '<unsafe>', state: 'awaiting_entry', last_close: 105, entry_high: 102 }], 'main', 'closed');
  assert.match(html, /<table/); assert.match(html, /data-state="extended" hidden/);
  assert.match(html, /0\.00R/); assert.match(html, /&lt;unsafe&gt;/); assert.doesNotMatch(html, /<unsafe>/);
});
test('trial feed format is gated, cohorts isolated, journal newest first and escaped', () => {
  const f = { schema: 'signal-trials/1', session_date: '2026-10-02', engines: {
    pulse: { plans: [trade(1, -1)], journal: [{ at: '2026-10-01', event: 'OLD' }, { at: '2026-10-02', event: '<NEW>' }], status: 'blocked' },
    compass: { plans: [trade(2, 3)], journal: [] } } };
  assert.equal(A.trial(f, 'pulse').r.cumulative, -1); assert.equal(A.trial(f, 'compass').r.cumulative, 3);
  const html = UI.trials(f, 'pulse');
  assert.match(html, /do not count in the main record/); assert.ok(html.indexOf('&lt;NEW&gt;') < html.indexOf('OLD'));
  assert.match(UI.trials({ ...f, schema: 'invalid' }, 'pulse'), /not a “no qualifying setup”/);
});
test('subscription receipt only claims confirmation when explicitly returned', () => {
  assert.match(UI.subscriptionMessage({ status: 'pending' }), /confirm your address/);
  assert.match(UI.subscriptionMessage({ status: 'subscribed' }), /not yet verified/);
  assert.equal(UI.subscriptionMessage({ status: 'confirmed' }), 'Your subscription is confirmed.');
});
test('reconciliation mismatch withholds full-record charts and drawdown', () => {
  const f = feed([trade(1, -1)]); f.metrics.closed = 10;
  const html = UI.analytics(A.main(f));
  assert.match(html, /full-record curve is withheld/); assert.doesNotMatch(html, /<svg/);
  assert.match(html, /Max drawdown<\/dt><dd>—/);
});
