import { randomBytes, createHmac } from 'node:crypto';
import { db, str, json, fail, readBody } from './_db.js';
import { migrate, consumeAttempt, claim, finish } from '../delivery/store.js';
import { hash, tokenFor, validToken } from '../delivery/tokens.js';
import { missingConfiguration, publicOrigin, resendProvider } from '../delivery/provider.js';

const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const SOURCES = new Set(['world', 'ledger', 'footer', 'longterm', 'unknown']);
const accepted = res => json(res, 200, { ok: true, status: 'pending', message: 'If eligible, check your inbox to confirm your subscription.' });
const tokenFrom = req => new URL(req.url, 'https://signal.invalid').searchParams.get('token') || req.body?.token;

// Inject a local libsql database, fake provider, env and clock for tests.
export function createSubscriptionHandlers({ client = db, env = process.env, send, clock = () => new Date() } = {}) {
  const database = () => typeof client === 'function' ? client() : client;
  async function subscribe(req, res) {
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    if (missingConfiguration(env).length) return fail(res, 503, 'Subscriptions are not configured on this deployment.');
    try {
      const origin = publicOrigin(env), now = clock(), c = database();
      await migrate(c);
      const ip = str(req.headers?.['x-forwarded-for']).split(',')[0].trim() || str(req.headers?.['x-real-ip']) || 'unknown';
      const ipHash = createHmac('sha256', env.DELIVERY_TOKEN_SECRET).update(ip).digest('hex');
      if (!await consumeAttempt(c, ipHash, now)) return fail(res, 429, 'Too many attempts. Try again in an hour.');
      const body = await readBody(req);
      if (str(body.company).trim() || !Number.isFinite(Number(body.elapsed)) || Number(body.elapsed) < 2) return accepted(res);
      const email = str(body.email).trim().toLowerCase();
      if (!email || email.length > 254 || !EMAIL.test(email)) return fail(res, 400, 'Enter a valid email address.');
      if ((body.digest !== undefined && typeof body.digest !== 'boolean') || (body.alerts !== undefined && typeof body.alerts !== 'boolean')) return fail(res, 400, 'Preferences must be boolean.');
      const tx = await c.transaction('write');
      let subscriber;
      try {
        const existing = (await tx.execute({ sql: 'SELECT * FROM subscribers WHERE email=?', args: [email] })).rows[0];
        // Never let an unauthenticated POST edit confirmed preferences or revive
        // an unsubscribed address without a new inbox confirmation.
        if (existing?.confirmed_at && existing.status === 'active') { await tx.commit(); return accepted(res); }
        if (existing?.confirmation_requested_at && +now - Date.parse(existing.confirmation_requested_at) < 3600000) { await tx.commit(); return accepted(res); }
        const nonce = randomBytes(32).toString('hex');
        const confirm = tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', nonce);
        const unsubscribe = tokenFor(env.DELIVERY_TOKEN_SECRET, 'unsubscribe', nonce);
        subscriber = (await tx.execute({ sql: `INSERT INTO subscribers
          (email,source,created_at,ip_hash,status,digest_enabled,alerts_enabled,token_nonce,confirmation_hash,confirmation_expires_at,unsubscribe_hash,confirmation_requested_at)
          VALUES (?,?,?,?,'pending',?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET
          status='pending',confirmed_at=NULL,digest_enabled=excluded.digest_enabled,alerts_enabled=excluded.alerts_enabled,
          token_nonce=excluded.token_nonce,confirmation_hash=excluded.confirmation_hash,confirmation_expires_at=excluded.confirmation_expires_at,
          unsubscribe_hash=excluded.unsubscribe_hash,confirmation_requested_at=excluded.confirmation_requested_at RETURNING *`,
          args: [email, SOURCES.has(body.source) ? body.source : 'unknown', now.toISOString(), ipHash, body.digest === false ? 0 : 1, body.alerts === true ? 1 : 0, nonce, hash(confirm), new Date(+now + 86400000).toISOString(), hash(unsubscribe), now.toISOString()] })).rows[0];
        await tx.commit();
      } finally { tx.close(); }
      const key = `confirm-${subscriber.id}-${hash(subscriber.token_nonce)}`;
      if (await claim(c, key, subscriber.id, 'confirmation', now)) {
        const confirmUrl = `${origin}/api/subscribe/confirm?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', subscriber.token_nonce)}`;
        const unsubUrl = `${origin}/api/unsubscribe?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'unsubscribe', subscriber.token_nonce)}`;
        try {
          // A cancellation between insertion and dispatch suppresses this send.
          const fresh = (await c.execute({ sql: 'SELECT status,token_nonce FROM subscribers WHERE id=?', args: [subscriber.id] })).rows[0];
          if (fresh.status !== 'pending' || fresh.token_nonce !== subscriber.token_nonce) await finish(c, key, 'suppressed', now);
          else {
            const id = await (send || resendProvider(env))({ to: [email], subject: 'Confirm your Signal subscription', text: `Confirm within 24 hours: ${confirmUrl}\n\nSignal covers delayed completed-session simulated paper research, not real-time instructions.\nCancel immediately: ${unsubUrl}` }, key);
            await finish(c, key, 'sent', now, id);
          }
        } catch (e) { await finish(c, key, e.retryable === false ? 'failed' : 'retry', now); }
      }
      return accepted(res);
    } catch { return fail(res, 503, 'Subscriptions are temporarily unavailable.'); }
  }

  async function confirm(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return fail(res, 405, 'GET or POST only');
    if (!env.TURSO_URL || !env.TURSO_TOKEN) return fail(res, 503, 'Subscriptions are not configured.');
    try {
      const c = database(); await migrate(c);
      const token = tokenFrom(req);
      if (validToken(token)) await c.execute({ sql: `UPDATE subscribers SET status='active',confirmed_at=?,confirmation_hash=NULL,confirmation_expires_at=NULL
        WHERE confirmation_hash=? AND confirmation_expires_at>? AND status='pending'`, args: [clock().toISOString(), hash(token), clock().toISOString()] });
      return json(res, 200, { ok: true, message: 'If the link was valid and unexpired, your subscription is confirmed.' });
    } catch { return fail(res, 503, 'Confirmation is temporarily unavailable.'); }
  }

  async function unsubscribe(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return fail(res, 405, 'GET or POST only');
    if (!env.TURSO_URL || !env.TURSO_TOKEN) return fail(res, 503, 'Subscriptions are not configured.');
    try {
      const c = database(); await migrate(c);
      const token = tokenFrom(req);
      if (validToken(token)) await c.execute({ sql: "UPDATE subscribers SET status='unsubscribed',confirmation_hash=NULL,confirmation_expires_at=NULL WHERE unsubscribe_hash=?", args: [hash(token)] });
      return json(res, 200, { ok: true, message: 'This subscription is cancelled if the link was valid.' });
    } catch { return fail(res, 503, 'Unsubscribe is temporarily unavailable.'); }
  }
  async function preferences(req, res) {
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    if (!env.TURSO_URL || !env.TURSO_TOKEN) return fail(res, 503, 'Subscriptions are not configured.');
    try {
      const body = await readBody(req), token = tokenFrom({ ...req, body });
      if (typeof body.digest !== 'boolean' || typeof body.alerts !== 'boolean') return fail(res, 400, 'Preferences must be boolean.');
      const c = database(); await migrate(c);
      if (validToken(token)) await c.execute({ sql: `UPDATE subscribers SET digest_enabled=?,alerts_enabled=?
        WHERE unsubscribe_hash=? AND status='active' AND confirmed_at IS NOT NULL`, args: [body.digest ? 1 : 0, body.alerts ? 1 : 0, hash(token)] });
      return json(res, 200, { ok: true, message: 'Preferences updated if the subscription link was valid.' });
    } catch { return fail(res, 503, 'Preferences are temporarily unavailable.'); }
  }
  return { subscribe, confirm, unsubscribe, preferences };
}

const handlers = createSubscriptionHandlers();
export default handlers.subscribe;
export const confirmationHandler = handlers.confirm;
export const unsubscribeHandler = handlers.unsubscribe;
export const preferencesHandler = handlers.preferences;
