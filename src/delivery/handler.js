import { db, json, fail } from '../api/_db.js';
import { migrate, claim, finish } from './store.js';
import { hash, tokenFor, ownerAuthorized } from './tokens.js';
import { missingConfiguration, publicOrigin, resendProvider } from './provider.js';
import { validateManifest, DISCLAIMER, sessionDate, escape } from './digest.js';

async function recordTransitions(client, digest) {
  const tx = await client.transaction('write');
  try {
    for (const row of digest.rows) {
      if (!row.id || !row.symbol || row.state === 'unavailable') continue;
      const planKey = hash(`${row.cohort}:${row.id}`);
      const previous = (await tx.execute({ sql: 'SELECT * FROM delivery_plan_states WHERE plan_key=?', args: [planKey] })).rows[0];
      if (previous && previous.session_date > digest.session_date) continue;
      const currentEvents = (row.events || []).filter(e => e.date === digest.session_date);
      for (const event of currentEvents) {
        // Partial target exits need alerts even while the plan stays active.
        // Fingerprints are derived from public structured facts, not prose or
        // array position. Prior-session history is baseline only, never replayed.
        const eventKey = hash(`${planKey}:${event.fingerprint}`);
        const detail = `${row.cohort} · ${row.symbol}: simulated ${event.kind}${event.price === null ? '' : ` at ${event.price}`}${event.qty === null ? '' : ` (${event.qty} units)`}`;
        await tx.execute({ sql: 'INSERT OR IGNORE INTO delivery_events VALUES (?,?,?)', args: [eventKey, digest.session_date, detail] });
      }
      // First-run baselines don't alert historical states; explicit current
      // session events can alert newly published plans without backfilling.
      if (!currentEvents.length && ((previous && previous.state !== row.state) || (!previous && row.event_date === digest.session_date))) {
        if (!row.event_date || row.event_date === digest.session_date) {
          const eventKey = hash(`${planKey}:${digest.session_date}:${row.state}`);
          await tx.execute({ sql: 'INSERT OR IGNORE INTO delivery_events VALUES (?,?,?)', args: [eventKey, digest.session_date, `${row.cohort} · ${row.symbol}: ${previous ? previous.state + ' → ' : ''}${row.state}`] });
        }
      }
      await tx.execute({ sql: `INSERT INTO delivery_plan_states VALUES (?,?,?) ON CONFLICT(plan_key)
        DO UPDATE SET state=excluded.state,session_date=excluded.session_date`, args: [planKey, row.state, digest.session_date] });
    }
    await tx.commit();
  } finally { tx.close(); }
  return (await client.execute({ sql: 'SELECT * FROM delivery_events WHERE session_date=? ORDER BY event_key', args: [digest.session_date] })).rows;
}

export function createDeliveryHandler({ client = db, env = process.env, send, readAsset, assets, fetcher = fetch, clock = () => new Date(), maxRecipients = 10 } = {}) {
  async function load(path) {
    if (readAsset) return readAsset(path);
    const url = publicOrigin(env) + path;
    const r = assets ? await assets.fetch(new Request(url)) : await fetcher(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!r.ok) throw new Error('delivery_asset_missing');
    return r.json();
  }
  return async function delivery(req, res) {
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    if (!env.EDIT_KEY) return fail(res, 503, 'Owner delivery authorization is not configured.');
    if (!ownerAuthorized(req, env)) return fail(res, 401, 'Owner authorization required.');
    if (missingConfiguration(env, { owner: true }).length) return fail(res, 503, 'Email delivery is not configured on this deployment.');
    if (!!env.TELEGRAM_BOT_TOKEN !== !!env.TELEGRAM_CHAT_ID) return fail(res, 503, 'Telegram delivery is incompletely configured.');
    try {
      const origin = publicOrigin(env), c = typeof client === 'function' ? client() : client;
      // Request bodies cannot supply recipients, feeds, templates or sessions.
      const pointer = await load('/digests/latest.json');
      if (pointer.schema !== 'signal-digest-pointer/1' || !sessionDate(pointer.session_date)) return fail(res, 503, 'Digest pointer unavailable.');
      const status = await load('/digests/status.json');
      if (status?.schema !== 'signal-digest-status/1' || status.status !== 'ready' || status.session_date !== pointer.session_date || status.input_hash !== pointer.input_hash) return fail(res, 503, 'Current digest publication is blocked.');
      const manifest = await load(`/digests/${pointer.session_date}/delivery.json`);
      const now = clock();
      // The immutable publication is authoritative. Whole feeds can change
      // intra-session without invalidating an already-published edition.
      const digest = validateManifest(manifest, origin, now);
      if (digest.session_date !== pointer.session_date || digest.input_hash !== pointer.input_hash) return fail(res, 503, 'Published digest pointer mismatch.');
      await migrate(c);
      const events = await recordTransitions(c, digest);
      const provider = send || resendProvider(env, fetcher);
      const summary = { sent: 0, suppressed: 0, skipped: 0, retry: 0 };
      async function dispatch(subscriber, kind, identifier, text, subject, html) {
        const key = hash(`${kind}:${identifier}:${subscriber.id}:${subscriber.token_nonce}`);
        if (!await claim(c, key, subscriber.id, kind, now, identifier, subscriber.token_nonce)) { summary.skipped++; return; }
        try {
          const fresh = (await c.execute({ sql: 'SELECT * FROM subscribers WHERE id=?', args: [subscriber.id] })).rows[0];
          const eligible = fresh && fresh.status === 'active' && fresh.confirmed_at && fresh.token_nonce === subscriber.token_nonce && Number(fresh[kind === 'digest' ? 'digest_enabled' : 'alerts_enabled']) === 1 &&
            hash(tokenFor(env.DELIVERY_TOKEN_SECRET, 'unsubscribe', fresh.token_nonce)) === fresh.unsubscribe_hash;
          if (!eligible) { await finish(c, key, 'suppressed', now); summary.suppressed++; return; }
          const unsubscribe = `${origin}/api/unsubscribe?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'unsubscribe', fresh.token_nonce)}`;
          const emailHtml = html ? html.replace('</body>', `<p><a href="${escape(unsubscribe)}">Unsubscribe immediately</a></p></body>`) : undefined;
          const providerId = await provider({ to: [fresh.email], subject, text: `${text}\n\nUnsubscribe immediately: ${unsubscribe}`, ...(emailHtml ? { html: emailHtml } : {}), headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }, key);
          await finish(c, key, 'sent', now, providerId); summary.sent++;
        } catch (e) { await finish(c, key, e.retryable === false ? 'failed' : 'retry', now); summary.retry++; }
      }
      const eligibleKind = kind => `(s.${kind === 'digest' ? 'digest' : 'alerts'}_enabled=1 ${kind === 'alerts' && !events.length ? 'AND 0' : ''} AND NOT EXISTS (
        SELECT 1 FROM delivery_receipts r WHERE r.subscriber_id=s.id AND r.channel='${kind}'
        AND r.content_id=? AND r.consent_nonce=s.token_nonce AND
        (r.status IN ('sent','suppressed','failed','uncertain') OR r.lease_until>? OR r.next_attempt_at>?)))`;
      const subscribers = (await c.execute({ sql: `SELECT s.* FROM subscribers s WHERE s.status='active' AND s.confirmed_at IS NOT NULL
        AND (${eligibleKind('digest')} OR ${eligibleKind('alerts')}) ORDER BY s.id LIMIT ?`,
        args: [digest.session_date, now.toISOString(), now.toISOString(), digest.session_date, now.toISOString(), now.toISOString(), maxRecipients + 1] })).rows;
      // Bound work per invocation. Skip already-completed recipients without
      // consuming the budget so repeated workflow calls advance the list.
      let attempted = 0;
      for (const subscriber of subscribers) {
        if (attempted >= maxRecipients) break;
        const before = summary.sent + summary.suppressed + summary.retry;
        if (Number(subscriber.digest_enabled)) await dispatch(subscriber, 'digest', digest.session_date, digest.text, `Signal paper digest — ${digest.session_date}`, digest.html);
        if (Number(subscriber.alerts_enabled) && events.length) await dispatch(subscriber, 'alerts', digest.session_date, `${DISCLAIMER}\n\nCompleted session ${digest.session_date}:\n${events.map(e => e.content).join('\n')}\n\n${digest.archive_url}`, `Signal completed-session paper transitions — ${digest.session_date}`);
        if (summary.sent + summary.suppressed + summary.retry > before) attempted++;
      }
      // Confirmation provider retries reconstruct opaque tokens from a server
      // secret + nonce; raw tokens and message payloads are never persisted.
      const confirmations = (await c.execute({ sql: `SELECT s.*,r.delivery_key FROM subscribers s JOIN delivery_receipts r ON r.subscriber_id=s.id
        WHERE r.channel='confirmation' AND r.status IN ('retry','sending') AND s.status='pending' AND s.confirmation_expires_at>? LIMIT 100`, args: [now.toISOString()] })).rows;
      for (const s of confirmations) {
        if (attempted >= maxRecipients) break;
        if (!await claim(c, s.delivery_key, s.id, 'confirmation', now)) continue;
        attempted++;
        const token = tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce);
        // Old confirmation receipts may survive a renewed nonce: suppress them.
        const expectedKey = `confirm-${s.id}-${hash(s.token_nonce)}`;
        if (s.delivery_key !== expectedKey || hash(token) !== s.confirmation_hash) { await finish(c, s.delivery_key, 'suppressed', now); continue; }
        try {
          const fresh = (await c.execute({ sql: 'SELECT status,confirmation_hash FROM subscribers WHERE id=?', args: [s.id] })).rows[0];
          if (fresh.status !== 'pending' || fresh.confirmation_hash !== hash(token)) { await finish(c, s.delivery_key, 'suppressed', now); continue; }
          const id = await provider({ to: [s.email], subject: 'Confirm your Signal subscription', text: `Confirm within 24 hours: ${origin}/api/subscribe/confirm?token=${token}\n\nSignal covers delayed completed-session simulated paper research, not real-time instructions.\nCancel immediately: ${origin}/api/unsubscribe?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'unsubscribe', s.token_nonce)}` }, s.delivery_key);
          await finish(c, s.delivery_key, 'sent', now, id); summary.sent++;
        } catch (e) { await finish(c, s.delivery_key, e.retryable === false ? 'failed' : 'retry', now); summary.retry++; }
      }
      if (env.TELEGRAM_BOT_TOKEN && events.length) {
        const key = hash(`telegram:${digest.session_date}:${env.TELEGRAM_CHAT_ID}`);
        const previous = (await c.execute({ sql: 'SELECT status,lease_until FROM delivery_receipts WHERE delivery_key=?', args: [key] })).rows[0];
        // Telegram has no idempotency key. A crashed/expired dispatch lease is
        // ambiguous, so never automatically resend it through another request.
        if (previous?.status === 'sending' && previous.lease_until <= now.toISOString()) await finish(c, key, 'uncertain', now);
        if (await claim(c, key, null, 'telegram', now)) {
          try {
            const r = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${DISCLAIMER}\n\nCompleted session ${digest.session_date}\n${events.map(e => e.content).join('\n').slice(0, 2800)}\n${digest.archive_url}` }) });
            if (!r.ok) { await finish(c, key, r.status === 429 ? 'retry' : 'uncertain', now); summary.retry++; }
            else { const body = await r.json(); await finish(c, key, body.ok ? 'sent' : 'uncertain', now, body.ok ? String(body.result?.message_id || '') : null); if (body.ok) summary.sent++; else summary.retry++; }
          } catch { await finish(c, key, 'uncertain', now); summary.retry++; }
        }
      }
      const pending = Number((await c.execute("SELECT COUNT(*) AS n FROM delivery_receipts WHERE status IN ('retry','sending','uncertain','failed')")).rows[0].n);
      return json(res, 200, { ok: true, session_date: digest.session_date, ...summary, pending_review: pending, more: attempted >= maxRecipients });
    } catch { return fail(res, 503, 'Delivery inputs or storage are unavailable.'); }
  };
}

// Main can pass env.ASSETS as argument 3 after adapting the Worker request.
export default function deliveryHandler(req, res, assets) { return createDeliveryHandler({ assets })(req, res); }
