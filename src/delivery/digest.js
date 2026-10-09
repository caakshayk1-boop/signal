import { hash } from './tokens.js';

export const DISCLAIMER = 'Delayed completed-session data. All events and outcomes are simulated paper research, not real-time instructions, recommendations or live fills. Pulse and Compass are separate unpromoted trial cohorts; they never enter the canonical main record.';
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const inputHash = (canonical, trials) => hash(stable({ canonical, trials }));
export const sessionDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const unavailable = value => /^(error|data_unavailable|blocked|stale|unavailable|incomplete|missing|not_ready)$/.test(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const list = value => Array.isArray(value) ? value : [];
const label = value => typeof value === 'string' ? value.slice(0, 160) : '';
const engineEntries = trials => Object.entries(trials.engines || trials.cohorts || trials.strategies || trials.products || {});

export function validateFeeds(canonical, trials, expectedSession) {
  if (!sessionDate(expectedSession)) throw new Error('expected_session_required');
  for (const [name, feed, schema] of [['canonical', canonical, 'signal-v2-public/1'], ['trials', trials, 'signal-trials/1']]) {
    if (!feed || feed.schema !== schema) throw new Error(`${name}_schema_missing`);
    if (typeof feed.status !== 'string' || !feed.status) throw new Error(`${name}_status_missing`);
    if (feed.session_date !== expectedSession) throw new Error(`${name}_session_mismatch`);
    if (unavailable(feed.status) || feed.complete === false || feed.data_complete === false) throw new Error(`${name}_data_unavailable`);
    if (feed.fixture || feed.synthetic || feed.illustrative || ['fixture', 'test', 'synthetic'].includes(feed.mode)) throw new Error(`${name}_not_production`);
    const published = Date.parse(feed.published_at);
    if (!Number.isFinite(published) || published < Date.parse(`${expectedSession}T10:00:00Z`)) throw new Error(`${name}_session_not_completed`);
    if (feed.data_as_of && String(feed.data_as_of).slice(0, 10) !== expectedSession) throw new Error(`${name}_data_session_mismatch`);
  }
  if (!Array.isArray(canonical.plans)) throw new Error('canonical_plans_missing');
  if (!canonical.metrics || typeof canonical.metrics !== 'object' || Array.isArray(canonical.metrics)) throw new Error('canonical_metrics_missing');
  if (canonical.metrics.reconciles === false) throw new Error('canonical_metrics_unreconciled');
  if (canonical.calendar_verified === false) throw new Error('canonical_calendar_unverified');
  if (![trials.engines, trials.plans, trials.setups, trials.cohorts, trials.strategies, trials.products].some(v => v && typeof v === 'object')) throw new Error('trials_setups_missing');
  for (const p of canonical.plans) {
    if (!p || !(p.id || p.plan_id) || !(p.symbol || p.ticker) || !(p.state || p.status)) throw new Error('canonical_plan_incomplete');
    if (['eligible', 'awaiting_entry'].includes(p.state || p.status) && ['entry_low', 'entry_high', 'stop', 't1', 't2', 't3'].some(k => number(p[k]) === null)) throw new Error('canonical_plan_levels_incomplete');
  }
}

// A shared feed session is the correlation key, never the wall-clock date.
// Fresh timestamps cannot revive an old session or an overdue scheduled scan.
export function validateFreshness(sources, session, now = new Date()) {
  const completed = Date.parse(`${session}T10:00:00Z`);
  if (!Number.isFinite(completed) || completed > +now || +now - completed > 72 * 3600000) throw new Error('session_stale_or_future');
  for (const source of sources) {
    const time = Date.parse(source.published_at);
    if (!Number.isFinite(time) || time > +now || +now - time > 72 * 3600000) throw new Error('publication_stale_or_future');
    if (source.next_scan_due && (!Number.isFinite(Date.parse(source.next_scan_due)) || Date.parse(source.next_scan_due) < +now)) throw new Error('next_scan_overdue');
  }
}

// Deliberate field allowlists: never serialize private rules, journal prose,
// provider payloads, or arbitrary nested feed objects into a public edition.
function eventsFor(p) {
  const events = [];
  const add = (event, fallback) => {
    if (!event || typeof event !== 'object') return;
    const date = event.session || event.session_date || event.date || event.event_date;
    if (!sessionDate(date)) return;
    const kind = label(event.kind || event.type || event.event || event.reason || fallback);
    // Only lifecycle codes, not unconstrained journal analysis.
    if (!/^(fill|entry|t[123]|target[ _]?[123]|stop|stop_loss|stopped|time_exit|time_exited|exit|closed|expired|expired_unfilled|cancelled|cancelled_before_entry)$/i.test(kind)) return;
    const normalized = kind.toLowerCase().replace(/^target[ _]?/, 't').replace(/^entry$/, 'fill').replace(/^(stopped|stop_loss)$/, 'stop');
    const value = { date, kind: normalized, price: number(event.price ?? event.fill_price), qty: number(event.qty ?? event.quantity) };
    events.push({ ...value, fingerprint: hash(stable(value)) });
  };
  if (p.fill_session) add({ session: p.fill_session, price: p.fill_price, qty: p.qty }, 'fill');
  add(p.fill, 'fill');
  for (const event of list(p.fills)) add(event, 'fill');
  for (const event of list(p.exits)) add(event, 'exit');
  for (const event of list(p.journal)) add(event, '');
  return [...new Map(events.map(e => [e.fingerprint, e])).values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export function trialStatuses(trials, session) {
  return engineEntries(trials).map(([key, engine]) => ({
    name: label(engine?.name || engine?.id || key),
    status: !engine || (engine.session_date && engine.session_date !== session) ? 'blocked_session_mismatch' : label(engine.status) || 'unavailable',
    // Reasons are machine codes only; no raw diagnostic/provider messages.
    reason: /^[a-z][a-z0-9_]{0,100}$/.test(engine?.blocked_reason || '') ? engine.blocked_reason : null,
  }));
}

export function publicRows(canonical, trials) {
  const main = canonical.plans.map(p => ({ p, cohort: 'Canonical main record' }));
  const trialRows = list(trials.plans || trials.setups).map(p => ({ p, cohort: `Trial: ${label(p.product || p.strategy || p.cohort) || 'Pulse / Compass'}` }));
  for (const [key, engine] of engineEntries(trials)) {
    if (!engine || !engine.status || unavailable(engine.status) || (engine.session_date && engine.session_date !== trials.session_date)) continue;
    for (const p of list(engine.plans || engine.setups || engine.positions)) trialRows.push({ p, cohort: `Trial: ${label(engine.name || engine.id || key)}` });
  }
  return [...main, ...trialRows].map(({ p, cohort }) => ({
    id: label(p.id || p.plan_id || p.setup_id), symbol: label(p.symbol || p.ticker), cohort,
    state: label(p.state || p.status) || 'unavailable',
    event_date: [p.event_date, p.updated_session, p.closed_session, p.ended_session, p.closed_date, p.exit_date, p.fill_session, p.fill?.session, p.entry_date].find(sessionDate) || null,
    extended: (p.state || p.status) === 'awaiting_entry' && number(p.last_close) !== null && number(p.entry_high) !== null && p.last_close > p.entry_high,
    entry_low: number(p.entry_low), entry_high: number(p.entry_high), stop: number(p.stop),
    t1: number(p.t1), t2: number(p.t2), t3: number(p.t3), events: eventsFor(p),
  })).sort((a, b) => stable(a).localeCompare(stable(b)));
}

const metricKeys = ['published', 'awaiting_entry', 'active', 'closed', 'wins', 'losses', 'breakevens', 'expired_unfilled', 'cancelled_before_entry', 'net_pnl_inr', 'charges_inr', 'mean_r_closed', 'win_rate'];
const show = value => value === null ? 'not reported' : String(value);
export function buildDigest(canonical, trials, origin, expectedSession) {
  validateFeeds(canonical, trials, expectedSession);
  const rows = publicRows(canonical, trials), input_hash = inputHash(canonical, trials);
  const path = `/digests/${expectedSession}/`, archive_url = origin + path;
  const metrics = Object.fromEntries(metricKeys.map(k => [k, number(canonical.metrics[k])]));
  const trial_statuses = trialStatuses(trials, expectedSession);
  const main = rows.filter(p => p.cohort === 'Canonical main record'), trial = rows.filter(p => p.cohort !== 'Canonical main record');
  const eligible = main.filter(p => ['eligible', 'awaiting_entry'].includes(p.state) && !p.extended);
  const commentary = `Operational summary: canonical publication status ${canonical.status}; ${eligible.length} published main plans awaiting entry/eligible. ${main.length} main lifecycle rows and ${trial.length} separate trial rows supplied. Missing statistics are not estimated; no market interpretation is inferred.`;
  const metricText = metricKeys.map(k => `${k}: ${show(metrics[k])}`).join(' · ');
  const rowText = p => `${p.cohort} · ${p.symbol}: ${p.state}; entry ${show(p.entry_low)}–${show(p.entry_high)}; stop ${show(p.stop)}; T1/T2/T3 ${show(p.t1)} / ${show(p.t2)} / ${show(p.t3)}`;
  const statusText = trial_statuses.map(s => `${s.name}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`).join(' · ') || 'No per-engine status supplied.';
  const text = [`Signal completed-session digest — ${expectedSession}`, DISCLAIMER, commentary,
    'Main record statistics (as reported)', metricText, 'Eligible main plans (conditional paper levels)', ...eligible.map(rowText),
    'Canonical main record', ...main.map(rowText), 'Separate trial cohorts (unpromoted)', statusText, ...trial.map(rowText),
    `Archive: ${archive_url}`, `Immutable input SHA-256: ${input_hash}`, DISCLAIMER].join('\n\n');
  const section = (title, items) => `<section><h2>${escape(title)}</h2>${items.length ? `<table cellpadding="6" cellspacing="0" border="1"><thead><tr><th>Symbol / cohort</th><th>State</th><th>Entry range</th><th>Stop</th><th>T1 / T2 / T3</th></tr></thead><tbody>${items.map(p => `<tr><td>${escape(p.symbol)} · ${escape(p.cohort)}</td><td>${escape(p.state)}</td><td>${show(p.entry_low)}–${show(p.entry_high)}</td><td>${show(p.stop)}</td><td>${show(p.t1)} / ${show(p.t2)} / ${show(p.t3)}</td></tr>`).join('')}</tbody></table>` : '<p>No published setups in this cohort for this completed session. No outcomes are invented.</p>'}</section>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signal digest — ${expectedSession}</title><link rel="canonical" href="${escape(archive_url)}"><link rel="alternate" type="application/rss+xml" href="${escape(origin)}/digests/feed.xml" title="Signal digests"></head><body><main><h1>Signal digest — ${expectedSession}</h1><p>${escape(DISCLAIMER)}</p><p>Data as of: ${expectedSession}. Published: ${escape(canonical.published_at)}.</p><h2>Operational commentary</h2><p>${escape(commentary)}</p><h2>Main record statistics (as reported)</h2><p>${escape(metricText)}</p>${section('Eligible main plans (conditional paper levels)', eligible)}${section('Canonical main record', main)}<h2>Trial engine publication status</h2><p>${escape(statusText)}</p>${section('Separate unpromoted trials', trial)}<p>Immutable input SHA-256: <code>${input_hash}</code></p><p><a href="${escape(archive_url)}">Permanent archive</a> · <a href="${escape(origin)}/digests/feed.xml">RSS</a></p><footer><p>${escape(DISCLAIMER)}</p></footer></main></body></html>\n`;
  const sources = [canonical, trials].map(f => ({ schema: f.schema, status: f.status, session_date: f.session_date, published_at: f.published_at, next_scan_due: f.next_scan_due || null }));
  const digest = { schema: 'signal-delivery/1', session_date: expectedSession, published_at: canonical.published_at, input_hash, archive_url, sources, metrics, trial_statuses, text, html, rows };
  return { ...digest, manifest_hash: hash(stable(digest)) };
}

export function validateManifest(digest, origin, now) {
  if (!digest || digest.schema !== 'signal-delivery/1' || !sessionDate(digest.session_date) || !/^[a-f0-9]{64}$/.test(digest.input_hash)) throw new Error('manifest_invalid');
  const { manifest_hash, ...content } = digest;
  if (manifest_hash !== hash(stable(content))) throw new Error('manifest_integrity_mismatch');
  if (digest.archive_url !== `${origin}/digests/${digest.session_date}/` || !Array.isArray(digest.rows) || !digest.metrics || !Array.isArray(digest.trial_statuses) || !Array.isArray(digest.sources) || digest.sources.length !== 2 || typeof digest.text !== 'string' || typeof digest.html !== 'string' || !digest.text.includes(DISCLAIMER) || !digest.html.includes(DISCLAIMER)) throw new Error('manifest_incomplete');
  for (const [i, source] of digest.sources.entries()) {
    if (source.schema !== ['signal-v2-public/1', 'signal-trials/1'][i] || !source.status || unavailable(source.status) || source.session_date !== digest.session_date || !Number.isFinite(Date.parse(source.published_at)) || Date.parse(source.published_at) < Date.parse(`${digest.session_date}T10:00:00Z`)) throw new Error('manifest_source_invalid');
  }
  if (digest.published_at !== digest.sources[0].published_at) throw new Error('manifest_publication_mismatch');
  for (const row of digest.rows) {
    if (!row || !['id', 'symbol', 'cohort', 'state'].every(k => typeof row[k] === 'string') || !Array.isArray(row.events) || !['entry_low', 'entry_high', 'stop', 't1', 't2', 't3'].every(k => row[k] === null || number(row[k]) !== null)) throw new Error('manifest_row_incomplete');
    for (const event of row.events) {
      if (!event || !sessionDate(event.date) || typeof event.kind !== 'string' || event.date > digest.session_date) throw new Error('manifest_event_invalid');
      const { fingerprint, ...facts } = event;
      if (fingerprint !== hash(stable(facts))) throw new Error('manifest_event_invalid');
    }
  }
  if (now) validateFreshness(digest.sources, digest.session_date, now);
  return digest;
}
