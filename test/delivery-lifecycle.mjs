import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSubscriptionHandlers } from '../src/api/subscribe.js';
import { migrate, consumeAttempt, claim } from '../src/delivery/store.js';
import { tokenFor, hash, ownerAuthorized } from '../src/delivery/tokens.js';
import { createDeliveryHandler } from '../src/delivery/handler.js';
import { buildDigest } from '../src/delivery/digest.js';
import { resendProvider } from '../src/delivery/provider.js';

const env = { TURSO_URL: 'file::memory:', TURSO_TOKEN: 'local-test', RESEND_API_KEY: 'fake', SIGNAL_EMAIL_FROM: 'Signal <test@example.com>', SIGNAL_PUBLIC_URL: 'https://signal.example.com', DELIVERY_TOKEN_SECRET: 'a-test-secret-that-is-at-least-32-characters', EDIT_KEY: 'test-owner-key' };
const start = new Date('2026-10-08T15:00:00Z');
const req = (body = {}, method = 'POST', ip = 'test') => ({ method, url: '/api/subscribe', body, headers: { 'x-forwarded-for': ip } });
function response() { return { code: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, send(text) { this.body = JSON.parse(text); } }; }
async function invoke(handler, request) { const res = response(); await handler(request, res); return res; }
const open = () => {
  // libsql transactions use separate connections; :memory: isn't shared.
  const dir = mkdtempSync(join(process.env.SIGNAL_TEST_TMPDIR || tmpdir(), 'signal-subscriptions-'));
  const c = createClient({ url: `file:${join(dir, 'local.db')}` });
  const close = c.close.bind(c);
  c.close = () => { close(); rmSync(dir, { recursive: true, force: true }); };
  return c;
};
const feeds = (state = 'active', date = '2026-10-08') => ({ canonical: { schema: 'signal-v2-public/1', status: 'research', session_date: date, published_at: `${date}T14:00:00Z`, metrics: { published: 1 }, plans: [{ id: 'plan-1', symbol: 'EXAMPLE', state }] }, trials: { schema: 'signal-trials/1', status: 'paper', session_date: date, published_at: `${date}T14:00:00Z`, plans: [] } });
function deliveryAssets(f) {
  const digest = buildDigest(f.canonical, f.trials, env.SIGNAL_PUBLIC_URL, f.canonical.session_date);
  return path => ({ '/digests/status.json': { schema: 'signal-digest-status/1', status: 'ready', session_date: digest.session_date, input_hash: digest.input_hash }, '/digests/latest.json': { schema: 'signal-digest-pointer/1', session_date: digest.session_date, input_hash: digest.input_hash }, [`/digests/${digest.session_date}/delivery.json`]: digest, '/signal_v2.json': f.canonical, '/signal_trials.json': f.trials })[path];
}

test('additive legacy migration preserves rows but never assumes double consent', async () => {
  const c = open();
  try {
    await c.execute("CREATE TABLE subscribers (id INTEGER PRIMARY KEY,email TEXT UNIQUE,created_at TEXT,status TEXT,source TEXT,ip_hash TEXT,user_agent TEXT)");
    await c.execute("INSERT INTO subscribers VALUES (1,'legacy@example.com','2024-01-01','active','footer',NULL,NULL)");
    await migrate(c); await migrate(c);
    const row = (await c.execute('SELECT * FROM subscribers')).rows[0];
    assert.equal(row.status, 'pending'); assert.equal(row.confirmed_at, null); assert.equal(row.created_at, '2024-01-01'); assert.equal(row.email, 'legacy@example.com');
  } finally { c.close(); }
});

test('opaque expiring hashed confirmation, replay safety, preferences, immediate unsubscribe', async () => {
  const c = open(), messages = []; let now = start;
  const h = createSubscriptionHandlers({ client: c, env, clock: () => now, send: async (m, k) => { messages.push({ m, k }); return 'fake-id'; } });
  try {
    const signup = req({ email: 'Reader@example.com', elapsed: 5, digest: false, alerts: true });
    assert.equal((await invoke(h.subscribe, signup)).body.status, 'pending');
    let s = (await c.execute('SELECT * FROM subscribers')).rows[0];
    assert.equal(s.status, 'pending'); assert.equal(s.confirmed_at, null); assert.equal(s.digest_enabled, 0); assert.equal(s.alerts_enabled, 1);
    const token = tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce);
    assert.equal(s.confirmation_hash, hash(token)); assert.ok(!JSON.stringify(s).includes(token));
    await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${token}`, headers: {} });
    s = (await c.execute('SELECT * FROM subscribers')).rows[0];
    assert.equal(s.status, 'active'); assert.equal(s.confirmed_at, start.toISOString());
    await invoke(h.subscribe, req({ email: 'reader@example.com', elapsed: 5, digest: true, alerts: false }, 'POST', 'another'));
    assert.equal(messages.length, 1); assert.equal((await c.execute('SELECT digest_enabled FROM subscribers')).rows[0].digest_enabled, 0);
    const unsub = tokenFor(env.DELIVERY_TOKEN_SECRET, 'unsubscribe', s.token_nonce);
    assert.equal((await invoke(h.preferences, req({ token: unsub, digest: true, alerts: false }))).code, 200);
    assert.equal((await c.execute('SELECT digest_enabled FROM subscribers')).rows[0].digest_enabled, 1);
    await invoke(h.unsubscribe, { method: 'POST', url: `/api/unsubscribe?token=${unsub}`, headers: {} });
    await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${token}`, headers: {} });
    assert.equal((await c.execute('SELECT status FROM subscribers')).rows[0].status, 'unsubscribed');
    now = new Date(+start + 3600001);
    await invoke(h.subscribe, req({ email: 'reader@example.com', elapsed: 5 }, 'POST', 'rejoin'));
    s = (await c.execute('SELECT * FROM subscribers')).rows[0]; assert.equal(s.status, 'pending');
    const expired = tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce);
    now = new Date(+now + 86400001);
    await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${expired}`, headers: {} });
    assert.equal((await c.execute('SELECT status FROM subscribers')).rows[0].status, 'pending');
  } finally { c.close(); }
});

test('attempt limit includes bots, invalid addresses and duplicate signups', async () => {
  const c = open(); const h = createSubscriptionHandlers({ client: c, env, clock: () => start, send: async () => 'fake' });
  try {
    for (let i = 0; i < 5; i++) await invoke(h.subscribe, req(i % 2 ? { company: 'bot' } : { email: 'invalid', elapsed: 3 }));
    assert.equal((await invoke(h.subscribe, req({ email: 'good@example.com', elapsed: 3 }))).code, 429);
    assert.equal((await c.execute('SELECT COUNT(*) n FROM subscribers')).rows[0].n, 0);
    assert.equal(await consumeAttempt(c, 'test-other', start), true);
  } finally { c.close(); }
});

test('missing config is explicit 503 and responses do not enumerate accounts', async () => {
  const c = open();
  try {
    const h = createSubscriptionHandlers({ client: c, env: {} });
    assert.equal((await invoke(h.subscribe, req({ email: 'a@example.com', elapsed: 3 }))).code, 503);
    assert.equal(ownerAuthorized({ headers: { 'x-edit-key': '✓different' } }, env), false);
    const delivery = createDeliveryHandler({ env });
    assert.equal((await invoke(delivery, req())).code, 401);
  } finally { c.close(); }
});

test('delivery is idempotent, consent/prefs gated, retries reuse key, suppression is checked after claim', async () => {
  const c = open(); let now = start; let calls = [], failOnce = true;
  const h = createSubscriptionHandlers({ client: c, env, clock: () => now, send: async () => 'confirmation-test' });
  try {
    await invoke(h.subscribe, req({ email: 'reader@example.com', elapsed: 4 }));
    let s = (await c.execute('SELECT * FROM subscribers')).rows[0];
    await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce)}`, headers: {} });
    const provider = async (m, k) => { calls.push({ m, k }); if (failOnce) { failOnce = false; throw new Error('fake transport timeout'); } return 'fake-digest'; };
    const delivery = createDeliveryHandler({ client: c, env, clock: () => now, send: provider, readAsset: deliveryAssets(feeds()) });
    const owner = { method: 'POST', headers: { 'x-edit-key': env.EDIT_KEY }, body: { to: ['attacker@example.com'], text: 'ignored' } };
    assert.equal((await invoke(delivery, owner)).body.retry, 1);
    assert.equal((await invoke(delivery, owner)).body.sent, 0);
    now = new Date(+start + 61000);
    assert.equal((await invoke(delivery, owner)).body.sent, 1); assert.equal(calls[0].k, calls[1].k);
    await invoke(delivery, owner); assert.equal(calls.length, 2);
    assert.ok(calls[0].m.text.includes('simulated paper')); assert.deepEqual(calls[0].m.to, ['reader@example.com']);
    assert.ok(calls[0].m.headers['List-Unsubscribe-Post']);
    assert.ok(calls[0].m.html.includes('<footer>')); assert.ok(calls[0].m.html.includes('Unsubscribe immediately'));
    // Inject a cancellation between recipient selection and the final SELECT.
    const proxy = { transaction: (...args) => c.transaction(...args), execute: async statement => {
      const result = await c.execute(statement);
      if (typeof statement === 'object' && statement.sql.startsWith('SELECT s.* FROM subscribers s WHERE')) await c.execute("UPDATE subscribers SET status='unsubscribed'");
      return result;
    } };
    now = new Date('2026-10-09T15:00:00Z');
    const next = createDeliveryHandler({ client: proxy, env, clock: () => now, send: provider, readAsset: deliveryAssets(feeds('closed', '2026-10-09')) });
    assert.equal((await invoke(next, owner)).body.suppressed, 1); assert.equal(calls.length, 2);
  } finally { c.close(); }
});

test('durable leases reject concurrent sends and stale retries stop after provider retention', async () => {
  const c = open();
  try {
    await migrate(c);
    assert.equal(await claim(c, 'same-key', 1, 'digest', start), true);
    assert.equal(await claim(c, 'same-key', 1, 'digest', start), false);
    assert.equal(await claim(c, 'same-key', 1, 'digest', new Date(+start + 24 * 3600000)), false);
    assert.equal((await c.execute("SELECT status FROM delivery_receipts WHERE delivery_key='same-key'")).rows[0].status, 'uncertain');
  } finally { c.close(); }
});

test('alerts baseline historical states, report only new completed-session transitions once', async () => {
  const c = open(), sent = []; let now = start;
  try {
    const h = createSubscriptionHandlers({ client: c, env, clock: () => now, send: async () => 'fake-confirmation' });
    await invoke(h.subscribe, req({ email: 'alerts@example.com', elapsed: 4, digest: false, alerts: true }));
    const s = (await c.execute('SELECT * FROM subscribers')).rows[0];
    await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce)}` });
    const owner = { method: 'POST', headers: { 'x-edit-key': env.EDIT_KEY } };
    const base = createDeliveryHandler({ client: c, env, clock: () => now, send: async m => { sent.push(m); return 'fake'; }, readAsset: deliveryAssets(feeds()) });
    await invoke(base, owner); assert.equal(sent.length, 0);
    now = new Date('2026-10-09T15:00:00Z');
    const next = createDeliveryHandler({ client: c, env, clock: () => now, send: async m => { sent.push(m); return 'fake'; }, readAsset: deliveryAssets(feeds('closed', '2026-10-09')) });
    await invoke(next, owner); await invoke(next, owner);
    assert.equal(sent.length, 1); assert.ok(sent[0].text.includes('active → closed'));
    assert.equal((await c.execute('SELECT COUNT(*) n FROM delivery_events')).rows[0].n, 1);
  } finally { c.close(); }
});

test('confirmation timeout retries the identical message and key through protected delivery', async () => {
  const c = open(), calls = []; let now = start;
  try {
    const h = createSubscriptionHandlers({ client: c, env, clock: () => now, send: async (m, k) => { calls.push({ m, k }); throw new Error('fake timeout'); } });
    assert.equal((await invoke(h.subscribe, req({ email: 'pending@example.com', elapsed: 4 }))).code, 200);
    now = new Date(+start + 61000);
    const delivery = createDeliveryHandler({ client: c, env, clock: () => now, readAsset: deliveryAssets(feeds()), send: async (m, k) => { calls.push({ m, k }); return 'fake'; } });
    await invoke(delivery, { method: 'POST', headers: { 'x-edit-key': env.EDIT_KEY } });
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  } finally { c.close(); }
});

test('bounded post-build passes advance recipients instead of repeating the first batch', async () => {
  const c = open(), sent = [];
  try {
    const h = createSubscriptionHandlers({ client: c, env, clock: () => start, send: async () => 'fake-confirmation' });
    for (let i = 0; i < 3; i++) {
      await invoke(h.subscribe, req({ email: `reader${i}@example.com`, elapsed: 4 }, 'POST', `ip-${i}`));
      const s = (await c.execute({ sql: 'SELECT * FROM subscribers WHERE email=?', args: [`reader${i}@example.com`] })).rows[0];
      await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce)}` });
    }
    const delivery = createDeliveryHandler({ client: c, env, clock: () => start, maxRecipients: 1, readAsset: deliveryAssets(feeds()), send: async m => { sent.push(m.to[0]); return 'fake'; } });
    const owner = { method: 'POST', headers: { 'x-edit-key': env.EDIT_KEY } };
    for (let i = 0; i < 3; i++) assert.equal((await invoke(delivery, owner)).body.sent, 1);
    assert.equal((await invoke(delivery, owner)).body.more, false);
    assert.equal(new Set(sent).size, 3);
  } finally { c.close(); }
});

test('ambiguous Telegram failure is durable and never automatically resent', async () => {
  const c = open(); let calls = 0;
  try {
    const f = feeds(); f.canonical.plans[0].event_date = f.canonical.session_date;
    const telegramEnv = { ...env, TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_CHAT_ID: 'fake-chat' };
    const delivery = createDeliveryHandler({ client: c, env: telegramEnv, clock: () => start, readAsset: deliveryAssets(f), send: async () => { throw new Error('unexpected mail'); }, fetcher: async () => { calls++; throw new Error('fake ambiguous timeout'); } });
    const owner = { method: 'POST', headers: { 'x-edit-key': env.EDIT_KEY } };
    assert.equal((await invoke(delivery, owner)).body.pending_review, 1);
    await invoke(delivery, owner);
    assert.equal(calls, 1); assert.equal((await c.execute("SELECT status FROM delivery_receipts WHERE channel='telegram'")).rows[0].status, 'uncertain');
  } finally { c.close(); }
});

test('Resend adapter sends deterministic idempotency and sanitizes provider failures', async () => {
  const provider = resendProvider(env, async (_url, options) => {
    assert.equal(options.headers['Idempotency-Key'], 'test-key');
    assert.equal(JSON.parse(options.body).to[0], 'test@example.com');
    return { ok: false, status: 429, text: async () => 'secret-provider-error' };
  });
  await assert.rejects(provider({ to: ['test@example.com'], text: 'test' }, 'test-key'), e => e.retryable && !e.message.includes('secret-provider-error'));
});

test('current target exits alert while active; old fill/journal history is not replayed', async () => {
  const c = open(), sent = []; let now = start;
  try {
    const h = createSubscriptionHandlers({ client: c, env, clock: () => now, send: async () => 'fake-confirmation' });
    await invoke(h.subscribe, req({ email: 'targets@example.com', elapsed: 4, digest: false, alerts: true }));
    const s = (await c.execute('SELECT * FROM subscribers')).rows[0];
    await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce)}` });
    const owner = { method: 'POST', headers: { 'x-edit-key': env.EDIT_KEY } };
    const f = feeds(); f.canonical.plans[0].fill_session = '2026-10-07'; f.canonical.plans[0].fill_price = 100;
    f.canonical.plans[0].journal = [{ type: 'entry', session: '2026-10-07', price: 100, notes: 'PRIVATE_NOTES' }];
    await invoke(createDeliveryHandler({ client: c, env, clock: () => now, readAsset: deliveryAssets(f), send: async m => { sent.push(m); return 'fake'; } }), owner);
    assert.equal(sent.length, 0);
    now = new Date('2026-10-09T15:00:00Z');
    const next = feeds('active', '2026-10-09');
    next.canonical.plans[0].exits = [{ session: '2026-10-09', reason: 't1', price: 108, qty: 40, notes: 'PRIVATE_NOTES' }];
    const delivery = createDeliveryHandler({ client: c, env, clock: () => now, readAsset: deliveryAssets(next), send: async m => { sent.push(m); return 'fake'; } });
    await invoke(delivery, owner); await invoke(delivery, owner);
    assert.equal(sent.length, 1); assert.match(sent[0].text, /simulated t1 at 108/); assert.ok(!sent[0].text.includes('PRIVATE_NOTES'));
    assert.equal((await c.execute('SELECT COUNT(*) n FROM delivery_events')).rows[0].n, 1);
  } finally { c.close(); }
});

test('immutable manifest is authority; blocked, tampered, future and stale publications send nothing', async () => {
  const c = open(); let now = start; let sent = 0;
  try {
    const h = createSubscriptionHandlers({ client: c, env, clock: () => now, send: async () => 'fake-confirmation' });
    await invoke(h.subscribe, req({ email: 'immutable@example.com', elapsed: 4 }));
    const s = (await c.execute('SELECT * FROM subscribers')).rows[0];
    await invoke(h.confirm, { method: 'GET', url: `/api/subscribe/confirm?token=${tokenFor(env.DELIVERY_TOKEN_SECRET, 'confirm', s.token_nonce)}` });
    const owner = { method: 'POST', headers: { 'x-edit-key': env.EDIT_KEY } };
    const original = deliveryAssets(feeds()); let mode = 'blocked';
    const readAsset = path => {
      assert.ok(!path.startsWith('/signal_'), 'must not depend on changing whole feeds');
      const value = original(path);
      if (path === '/digests/status.json' && mode === 'blocked') return { ...value, status: 'blocked' };
      if (path.endsWith('/delivery.json') && mode === 'tampered') return { ...value, rows: [] };
      return value;
    };
    const delivery = createDeliveryHandler({ client: c, env, clock: () => now, readAsset, send: async () => { sent++; return 'fake'; } });
    assert.equal((await invoke(delivery, owner)).code, 503);
    mode = 'tampered'; assert.equal((await invoke(delivery, owner)).code, 503);
    mode = 'ready'; now = new Date('2026-10-08T13:00:00Z'); assert.equal((await invoke(delivery, owner)).code, 503);
    now = new Date('2026-10-12T15:00:00Z'); assert.equal((await invoke(delivery, owner)).code, 503);
    assert.equal(sent, 0);
    now = start; assert.equal((await invoke(delivery, owner)).body.sent, 1); assert.equal(sent, 1);
  } finally { c.close(); }
});
