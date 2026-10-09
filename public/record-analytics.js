/* Net closed-trade diagnostics. Shared by browser and HTML publication.
 * Main accepts ONLY signal-v2-public/1.plans, never paper/trial/backtest rows.
 * Unknown is null, not zero. No inferred fills, costs, or publication regime. */
(() => {
  'use strict';
  const num = v => v == null || typeof v === 'object' || typeof v === 'boolean' || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const terminal = new Set(['closed', 'stopped', 'time_exited', 'expired', 'invalidated', 'valuation_exit', 'horizon_review']);
  const date = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && Number.isFinite(Date.parse(v))
    && new Date(v).toISOString().slice(0, 10) === v ? v : null;
  const filled = p => num(p.fill && p.fill.price) > 0 || num(p.fill_price) > 0 || (Array.isArray(p.tranches) && p.tranches.some(t => num(t.fill_price) > 0));
  const closed = p => p && filled(p) && terminal.has(p.state);
  function regime(p) {
    const explicit = p.publication_regime || p.regime_at_publication;
    if (typeof explicit === 'string' && explicit) return explicit;
    const above = p.market_context && p.market_context.above_50dma;
    return above === true ? 'Index above 50-day average' : above === false ? 'Index below 50-day average' : 'Not recorded';
  }
  function row(p) {
    const held = num(p.held_sessions ?? p.duration_sessions ?? p.holding_sessions);
    return { id: p.id, symbol: p.symbol, engine: p.engine || p.strategy_id || 'Not recorded',
      date: date(p.closed_session || p.ended_session || p.exit_session),
      r: num(p.total_r ?? p.net_r), inr: num(p.net_pnl_inr),
      holding: held == null || held < 0 ? 'Not recorded' : held <= 5 ? '0–5 sessions' : held <= 20 ? '6–20 sessions' : '21+ sessions',
      regime: regime(p) };
  }
  function stats(rows, key) {
    const values = rows.map(r => r[key]).filter(v => v != null);
    const wins = values.filter(v => v > 0), losses = values.filter(v => v < 0);
    const sum = vs => vs.reduce((a, b) => a + b, 0);
    const avgWin = wins.length ? sum(wins) / wins.length : null;
    const avgLoss = losses.length ? sum(losses) / losses.length : null;
    return { n: values.length, total: rows.length, wins: wins.length, losses: losses.length,
      hitRate: values.length ? wins.length / values.length * 100 : null,
      avgWin, avgLoss, payoff: avgWin != null && avgLoss != null ? avgWin / Math.abs(avgLoss) : null,
      expectancy: values.length ? sum(values) / values.length : null,
      cumulative: values.length ? sum(values) : null };
  }
  function series(rows, key) {
    const ordered = rows.filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
    const complete = ordered.length === rows.length && rows.length > 0 && rows.every(r => r[key] != null);
    const dated = ordered.length === rows.length;
    let sum = 0, peak = 0, maxDrawdown = 0, streak = 0, longest = 0, known = dated;
    const points = ordered.map((r, i) => {
      if (r[key] == null) known = false;
      if (known) {
        sum += r[key]; peak = Math.max(peak, sum); maxDrawdown = Math.max(maxDrawdown, peak - sum);
      }
      // A missing outcome breaks the observed streak, and the reported maximum
      // is withheld until the complete sequence is known.
      streak = r[key] != null && r[key] < 0 ? streak + 1 : 0;
      longest = Math.max(longest, streak);
      const window = ordered.slice(Math.max(0, i - 19), i + 1);
      const rolling = dated && window.length === 20 && window.every(x => x[key] != null)
        ? window.reduce((a, x) => a + x[key], 0) / 20 : null;
      return { date: r.date, id: r.id, value: known ? sum : null,
        drawdown: known ? sum - peak : null, rolling };
    });
    return { points, complete, maxDrawdown: complete ? maxDrawdown : null,
      longestLosingStreak: complete ? longest : null, undated: rows.length - ordered.length };
  }
  function analyse(plans) {
    const rows = plans.filter(closed).map(row);
    const groups = key => [...new Set(rows.map(r => r[key]))].sort().map(name => {
      const subset = rows.filter(r => r[key] === name);
      return { name, closed: subset.length, r: stats(subset, 'r'), inr: stats(subset, 'inr') };
    });
    return { closed: rows.length, preliminary: rows.length < 30, rows,
      r: { ...stats(rows, 'r'), ...series(rows, 'r') },
      inr: { ...stats(rows, 'inr'), ...series(rows, 'inr') },
      engines: groups('engine'), holding: groups('holding'), regimes: groups('regime') };
  }
  function main(feed) {
    if (!feed || feed.schema !== 'signal-v2-public/1' || !Array.isArray(feed.plans)) return null;
    return { ...analyse(feed.plans), cohort: 'Main forward record', expectedClosed: num(feed.metrics && feed.metrics.closed) };
  }
  function trial(feed, engine) {
    if (!feed || feed.schema !== 'signal-trials/1' || !['pulse', 'compass'].includes(engine)) return null;
    const e = feed.engines && feed.engines[engine];
    if (!e || !Array.isArray(e.plans)) return null;
    return { ...analyse(e.plans), cohort: engine + ' trial only', expectedClosed: null };
  }
  globalThis.SignalAnalytics = { num, closed, main, trial };
})();
