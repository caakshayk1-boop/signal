/* Pure publication components: one HTML renderer for browser, build and edge.
 * All feed strings are escaped. No browser APIs are needed to render. */
(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => globalThis.SignalAnalytics.num(v);
  const number = v => num(v) == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const inr = v => num(v) == null ? '—' : (v < 0 ? '−' : '') + '₹' + number(Math.abs(v));
  const rfmt = v => num(v) == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + 'R';
  const day = v => {
    const d = Date.parse(v || '');
    return Number.isFinite(d) ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : 'Not recorded';
  };
  const timestamp = v => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return day(v);
    const d = Date.parse(v || '');
    return Number.isFinite(d) ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST' : 'Not recorded';
  };
  const publicCopy = v => String(v || '').replace(/Four engines run as a labelled paper test below; an engine joins this record only after it passes its promotion criteria on forward data\./g,
    'Four engines are on trial. Each must earn its place on the record with real forward results before its plans count. See Methodology.');
  const state = p => p.grading_gap ? 'not_graded' : p.state === 'awaiting_entry' ? (num(p.last_close) != null && num(p.entry_high) != null && num(p.last_close) > num(p.entry_high) ? 'extended' : 'eligible')
    : ['activated', 'partially_exited', 'active', 'tranche_1_filled', 'tranche_2_filled', 'tranche_3_filled', 'fully_valued'].includes(p.state) ? 'active'
    : ['expired_unfilled', 'cancelled', 'expired'].includes(p.state) && !globalThis.SignalAnalytics.closed(p) ? 'expired'
    : globalThis.SignalAnalytics.closed(p) ? 'closed' : p.state || 'Not recorded';
  const url = (p, cohort) => '/' + (cohort === 'main' ? 'plan' : 'setup') + '/' + encodeURIComponent(p.id || '');
  function example(d) {
    const p = d && d.schema === 'signal-v2-public/1' && (d.plans || []).find(globalThis.SignalAnalytics.closed);
    const levels = x => `<dl class="sig2-levels"><div><dt>Entry range</dt><dd>${inr(x.entry_low)}–${inr(x.entry_high)}</dd></div><div><dt>Initial stop</dt><dd>${inr(x.initial_stop ?? x.stop)}</dd></div><div><dt>T1 / T2 / T3</dt><dd>${[x.t1, x.t2, x.t3].map(inr).join(' / ')}</dd></div></dl>`;
    return `<section class="sig2-example" aria-labelledby="workedExample"><h2 id="workedExample">What a qualified setup looks like</h2>${p
      ? `<p class="sig2-label">Past example from the main forward record</p><h3><a href="${url(p, 'main')}">${esc(p.symbol)}</a> · published ${esc(day(p.published_at || p.session_date))}</h3>${levels(p)}<p>Closed ${esc(day(p.closed_session))}: ${esc(p.outcome || p.state)} · <b>${rfmt(p.total_r)}</b> net · ${inr(p.net_pnl_inr)} after modelled costs.</p>`
      : `<p class="sig2-label">Illustration only · not a published trade or a result</p><p>An example stock has an entry window, a defined stop and three conditional exits. Prices below only explain the layout.</p>${levels({ entry_low: 100, entry_high: 102, initial_stop: 96, t1: 108, t2: 114, t3: 120 })}<p><b>Outcome and net R: not applicable.</b> No completed main-record trade is available for this example. Nothing here is added to the record.</p>`}</section>`;
  }
  function statsStrip(d) {
    const m = d.metrics || {}, c = d.coverage || {};
    const engines = Array.isArray(d.strategies) ? d.strategies.filter(e => ['shadow', 'forward_paper', 'validated'].includes(e.status)).length : null;
    return `<dl class="sig2-stats" aria-label="Desk at a glance">${[['Engines running (including trials)', engines], ['Names screened', c.with_session_bar], ['Record start', day(d.forward_record_start)], ['Published', m.published], ['Closed', m.closed]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${typeof v === 'number' ? number(v) : esc(v ?? 'Not reported')}</dd></div>`).join('')}</dl>`;
  }
  function subscribe(source = 'world') {
    return `<section class="sig2-subscribe" aria-labelledby="subscribeTitle"><h2 id="subscribeTitle">Tomorrow’s desk, by email</h2><p>One email each evening: tomorrow's plans, the desk's reasoning, and the record's numbers.</p>
      <form action="/api/subscribe" method="post" data-sig2-subscribe data-source="${esc(source)}"><label for="digestEmail">Email address</label><div class="sig2-formrow"><input id="digestEmail" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"><button type="submit">Subscribe</button></div>
      <div class="sig2-honey" aria-hidden="true"><label>Company <input name="company" tabindex="-1" autocomplete="off"></label></div><p class="sig2-formstatus" role="status" aria-live="polite"></p></form><p class="hint">Confirm your address before emails begin. Unsubscribe in one click. <a href="/privacy">Privacy</a> · <a href="/digests">Past editions</a> · <a href="/feed.xml" rel="external">RSS</a></p></section>`;
  }
  const STATES = ['all', 'eligible', 'extended', 'active', 'closed', 'expired'];
  function setups(plans, cohort = 'main', selected = 'all') {
    const rows = Array.isArray(plans) ? plans : [];
    const counts = k => k === 'all' ? rows.length : rows.filter(p => state(p) === k).length;
    return `<div class="sig2-setups" data-sig2-setups><div class="chips" role="group" aria-label="Filter ${cohort === 'main' ? 'main plans' : 'trial setups'} by state">${STATES.map(k => `<button type="button" class="chip" data-sig2-state="${k}" aria-pressed="${selected === k}">${k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)} <b>${counts(k)}</b></button>`).join('')}</div>
      <div class="sig2-scroll" tabindex="0" role="region" aria-label="${cohort === 'main' ? 'Main plan' : 'Trial setup'} levels; scroll for all columns"><table class="sig2-table"><caption>${cohort === 'main' ? 'Main forward record · published plans only' : 'Paper trial · excluded from the main record'}</caption><thead><tr>${[cohort === 'main' ? 'Main symbol' : 'Trial symbol', 'State', 'Entry range', 'Stop', 'T1', 'T2', 'T3', 'Net R (closed)', 'Published'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(p => {
        const s = state(p), done = globalThis.SignalAnalytics.closed(p);
        return `<tr data-state="${esc(s)}"${selected !== 'all' && selected !== s ? ' hidden' : ''}><th scope="row"><a href="${url(p, cohort)}">${esc(p.symbol)}</a></th><td><span class="sig2-state is-${esc(s)}">${esc(s.replace(/_/g, ' '))}</span></td><td>${inr(p.entry_low)}–${inr(p.entry_high)}</td><td>${inr(p.initial_stop ?? p.stop)}</td>${[p.t1, p.t2, p.t3].map(v => `<td>${inr(v)}</td>`).join('')}<td>${done ? rfmt(p.total_r ?? p.net_r) : '—'}</td><td>${esc(day(p.published_at || p.session_date || p.filed_session))}</td></tr>`;
      }).join('')}</tbody></table></div><p class="sig2-filterempty" role="status"${counts(selected) ? ' hidden' : ''}>${rows.length ? 'No plans in this state.' : 'No plans in this cohort. The publication status above explains why.'}</p></div>`;
  }
  function chart(points, key, title, unit) {
    const vals = points.map(p => p[key]).filter(v => v != null);
    if (!vals.length) return `<section class="sig2-chart"><h3>${esc(title)}</h3><p class="empty">${esc(title)}: ${key === 'rolling' ? 'Needs 20 consecutive closed trades with net results.' : 'No complete dated net results to draw yet.'}</p></section>`;
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), pad = Math.max((hi - lo) * .1, .1), min = lo - pad, max = hi + pad;
    const x = i => 48 + i / Math.max(1, points.length - 1) * 600, y = v => 180 - (v - min) / (max - min) * 152;
    let path = '', pen = false;
    points.forEach((p, i) => { if (p[key] == null) { pen = false; return; } path += `${pen ? 'L' : 'M'}${x(i).toFixed(2)},${y(p[key]).toFixed(2)} `; pen = true; });
    const fmt = v => unit === 'R' ? rfmt(v) : inr(v);
    return `<figure class="sig2-chart"><h3>${esc(title)}</h3><svg viewBox="0 0 672 216" role="img" aria-label="${esc(title)} in ${unit}; ${vals.length} recorded points; latest ${esc(fmt(vals.at(-1)))}"><line class="sig2-baseline" x1="48" x2="648" y1="${y(0)}" y2="${y(0)}"/><path class="sig2-line" d="${path}"/>${points.map((p, i) => p[key] == null ? '' : `<circle cx="${x(i)}" cy="${y(p[key])}" r="3"><title>${esc(p.date)} · ${esc(fmt(p[key]))}</title></circle>`).join('')}<text x="0" y="28">${esc(fmt(hi))}</text><text x="0" y="180">${esc(fmt(lo))}</text><text x="48" y="208">${esc(points[0].date)}</text><text x="648" y="208" text-anchor="end">${esc(points.at(-1).date)}</text></svg><figcaption>Closed-trade order; same-day closes ordered by plan ID. Missing results break the line.</figcaption></figure>`;
  }
  function analytics(a) {
    if (!a) return '<p class="empty">Record analytics unavailable: the feed format is not recognised.</p>';
    const metric = (label, r, rupees) => `<div><dt>${label}</dt><dd>${r}</dd><dd class="muted">${rupees}</dd></div>`;
    const s = a.r, m = a.inr;
    const reconciled = a.expectedClosed == null || a.expectedClosed === a.closed;
    const ddR = reconciled ? s.maxDrawdown : null, ddInr = reconciled ? m.maxDrawdown : null;
    const band = a.preliminary || s.n < 30 || m.n < 30 ? `<p class="sig2-warning"><b>Insufficient sample · preliminary.</b> At least 30 complete closed trades are needed before assessing an edge. ${a.closed} closed; ${s.n} with net R; ${m.n} with net ₹.</p>` : '';
    const group = (title, rows) => `<h3>${title}</h3>${rows.length ? `<div class="sig2-scroll"><table class="sig2-table"><thead><tr><th scope="col">Group</th><th scope="col">Closed</th><th scope="col">R sample</th><th scope="col">Expectancy R</th><th scope="col">₹ sample</th><th scope="col">Expectancy ₹</th></tr></thead><tbody>${rows.map(g => `<tr><th scope="row">${esc(g.name)}</th><td>${g.closed}${g.closed < 30 ? ' · preliminary' : ''}</td><td>${g.r.n}/${g.closed}</td><td>${rfmt(g.r.expectancy)}</td><td>${g.inr.n}/${g.closed}</td><td>${inr(g.inr.expectancy)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No closed trades to group yet.</p>'}`;
    return `<section class="sig2-analytics" aria-label="${esc(a.cohort)} net analytics"><h2>${esc(a.cohort)} · net results</h2>${band}
      <p>R sample ${s.n}/${a.closed} · ₹ sample ${m.n}/${a.closed}. Positive net P&amp;L counts as a hit; zero results count in the denominator. Average loss is signed. Unfilled and open plans are excluded.</p>
      ${a.expectedClosed != null && a.expectedClosed !== a.closed ? `<p class="sig2-warning">The feed reports ${a.expectedClosed} closed trades, but carries ${a.closed} filled closed rows. These diagnostics cover the available rows only; the full-record curve is withheld.</p>` : ''}
      <dl class="sig2-metrics">${metric('Hit rate', s.hitRate == null ? '—' : number(s.hitRate) + '% (R sample)', m.hitRate == null ? '—' : number(m.hitRate) + '% (₹ sample)')}${metric('Average win', rfmt(s.avgWin), inr(m.avgWin))}${metric('Average loss', rfmt(s.avgLoss), inr(m.avgLoss))}${metric('Payoff ratio', number(s.payoff), number(m.payoff) + (m.payoff == null ? '' : ' (₹ basis)'))}${metric('Expectancy / trade', rfmt(s.expectancy), inr(m.expectancy))}${metric('Net cumulative result (available rows)', rfmt(s.cumulative), inr(m.cumulative))}${metric('Max drawdown', rfmt(ddR), inr(ddInr))}${metric('Longest losing streak', reconciled ? s.longestLosingStreak ?? '—' : '—', !reconciled || m.longestLosingStreak == null ? '₹ sequence unavailable' : m.longestLosingStreak + ' (₹ basis)')}</dl>
      ${!s.complete || !m.complete ? '<p class="hint">Drawdown and streak require every closed trade’s net result and closing date. Missing data is not treated as zero.</p>' : ''}
      <div class="sig2-charts">${a.expectedClosed != null && a.expectedClosed !== a.closed ? '<p class="empty">Full-record charts await the missing closed rows.</p>' : chart(s.points, 'value', 'Cumulative net R', 'R') + chart(s.points, 'rolling', 'Rolling 20-trade expectancy · R', 'R') + chart(s.points, 'drawdown', 'Drawdown from peak · R', 'R') + chart(m.points, 'value', 'Cumulative net ₹', 'INR') + chart(m.points, 'rolling', 'Rolling 20-trade expectancy · ₹', 'INR') + chart(m.points, 'drawdown', 'Drawdown from peak · ₹', 'INR')}</div>
      ${group('By engine', a.engines)}${group('By holding period', a.holding)}${group('By regime at publication', a.regimes)}<p class="hint">Holding periods use recorded session counts. Regime uses the index’s 50-day state recorded at publication, never today’s market state. “Not recorded” remains a separate group.</p></section>`;
  }
  function trials(feed, engine) {
    const e = feed && feed.schema === 'signal-trials/1' && feed.engines && feed.engines[engine];
    if (!e || !Array.isArray(e.plans) || !Array.isArray(e.journal)) return '<p class="empty">Trial data unavailable or incomplete. This is not a “no qualifying setup” result.</p>';
    const text = v => typeof v === 'string' ? v : v == null ? 'Not reported' : JSON.stringify(v);
    const fields = (title, value) => `<details><summary>${title}</summary><pre class="sig2-detail">${esc(text(value))}</pre></details>`;
    const list = (title, values) => Array.isArray(values) && values.length ? `<h4>${title}</h4><ul>${values.map(v => `<li>${esc(text(v))}</li>`).join('')}</ul>` : '';
    const thesis = p => {
      const t = p.thesis;
      return t && typeof t === 'object' ? `<p><b>Thesis:</b> ${esc(t.one_line || t.summary || t.thesis || 'Not recorded')}</p>${list('Three pillars', t.pillars)}${list('Invalidation checklist', t.invalidation_checklist || t.invalidation)}${list('Catalyst calendar', t.catalysts || t.catalyst_calendar)}${fields('Sizing and tranche rules', p.tranche_rules || t.sizing || p.management)}`
        : fields('Published thesis and tranche rules', t || p.tranche_rules || p.management);
    };
    const cards = e.plans.map(p => `<article class="sig2-example"><h3>${esc(p.symbol)} · ${esc(p.state)}</h3><p>${esc(p.thesis_note || p.why || '')}</p><dl class="sig2-levels"><div><dt>Entry</dt><dd>${inr(p.entry_low)}–${inr(p.entry_high)}</dd></div><div><dt>Stop</dt><dd>${inr(p.initial_stop ?? p.stop)}</dd></div><div><dt>T1 / T2 / T3</dt><dd>${[p.t1, p.t2, p.t3].map(inr).join(' / ')}</dd></div></dl>${thesis(p)}${p.flags && p.flags.length ? `<p>${esc(p.flags.join('; '))}</p>` : ''}</article>`).join('');
    const journalTime = j => j.timestamp || j.at || j.session || j.session_date;
    const newestFirst = (a, b) => (Date.parse(journalTime(b)) || 0) - (Date.parse(journalTime(a)) || 0);
    return `<p class="sig2-warning"><b>${engine === 'pulse' ? 'Pulse' : 'Compass'} · forward paper trial.</b> These plans and results do not count in the main record. Promotion requires a separate review.</p><p>Session ${esc(day(feed.session_date))} · published ${esc(timestamp(feed.published_at))} · <b>${esc(e.status || 'Not reported')}</b></p><p>${esc(publicCopy(e.status_detail))}</p>
      ${fields('Market / publication gate', e.gate)}${fields('Data and run diagnostics', e.diagnostics)}
      <h2>${engine === 'compass' ? 'Theses and positions' : 'Conditional swing plans'}</h2>${cards || '<p class="empty">No plans published in this trial. Read the status and gate above for the reason.</p>'}
      <h2>Append-only journal</h2><ol class="sig2-journal">${[...e.journal].sort(newestFirst).map(j => `<li><time>${esc(timestamp(journalTime(j)))}</time> <b>${esc(j.symbol || j.plan_id || '')}</b> ${esc(j.event || j.what || j.state || '')} — ${esc(text(j.reason || j.trigger || j.detail || ''))}</li>`).join('') || '<li>No journal events published yet.</li>'}</ol>
      ${analytics(globalThis.SignalAnalytics.trial(feed, engine))}`;
  }
  function snapshot(d) {
    if (!d || d.schema !== 'signal-v2-public/1') return '<p class="pre-m">The plan publication is unavailable. No current scan or plan count can be confirmed.</p>';
    const paper = d.paper && Array.isArray(d.paper.plans) ? `<h2>Existing engine trials · separate from the main record</h2>${setups(d.paper.plans, 'trial')}` : '';
    const due = Date.parse(d.next_scan_due || '');
    const freshness = Number.isFinite(due) && Date.now() > due ? `<p class="sig2-warning"><b>Publication overdue.</b> The next scan was due ${esc(timestamp(d.next_scan_due))}. This page carries the last published session, not a new scan.</p>` : '';
    return `${example(d)}${statsStrip(d)}<h2>Latest publication · ${esc(day(d.session_date))}</h2>${freshness}<p class="pre-m">${esc(publicCopy(d.status_detail))}</p><p class="pre-n">Updated daily after market close. Last publication: ${esc(timestamp(d.published_at))}.</p>${setups(d.plans, 'main')}${paper}${subscribe()}`;
  }
  function digests(feed) {
    const unavailable = '<p class="empty">The digest archive index is unavailable or incomplete. Past editions cannot be confirmed.</p>';
    if (!feed || feed.schema !== 'signal-digest-index/1' || !Array.isArray(feed.editions)) return unavailable;
    // Build local URLs from validated session dates, never from feed-supplied hrefs.
    const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
    if (feed.editions.some(e => !e || !validDate(e.session_date))) return unavailable;
    const editions = [...feed.editions].sort((a, b) => b.session_date.localeCompare(a.session_date));
    return `<p>Delayed simulated paper research. Main forward plans and unpromoted trials remain separate in each edition.</p><p><a href="/feed.xml" rel="external">Subscribe via RSS</a></p>${editions.length ? `<ol class="sig2-journal">${editions.map(e => `<li><a href="/digests/${e.session_date}/" rel="external">${esc(day(e.session_date))} edition</a> · published ${esc(timestamp(e.published_at))}</li>`).join('')}</ol>` : '<p class="empty">No completed-session editions have been published yet.</p>'}`;
  }
  const subscriptionMessage = data => data.status === 'pending' || data.status === 'confirmation_sent' ? 'Check your inbox and confirm your address. Emails begin only after confirmation.'
    : data.status === 'confirmed' || data.status === 'active' ? 'Your subscription is confirmed.'
    : 'Your request was received. Confirmation and email delivery are not yet verified.';
  globalThis.SignalUI = { esc, day, timestamp, publicCopy, state, STATES, example, statsStrip, subscribe, setups, analytics, trials, snapshot, digests, subscriptionMessage };
})();
