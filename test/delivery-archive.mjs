import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishDigest } from '../scripts/build-digests.mjs';
import { buildDigest, inputHash, validateManifest } from '../src/delivery/digest.js';
import { deliverDigest } from '../scripts/deliver-digest.mjs';

const origin = 'https://signal.example.com';
const canonical = { schema: 'signal-v2-public/1', session_date: '2026-10-08', published_at: '2026-10-08T14:00:00Z', status: 'paused', metrics: { published: 1, closed: 1, wins: 0, losses: 1 }, plans: [{ id: 'p1', symbol: '<script>fake</script>', status: 'closed' }] };
const trials = { schema: 'signal-trials/1', session_date: '2026-10-08', published_at: '2026-10-08T14:00:00Z', status: 'paper', plans: [{ id: 't1', symbol: 'TRIAL', product: 'Pulse', status: 'active' }] };

test('archive is immutable, deterministic, escapes data and separates trial cohorts', () => {
  const dir = mkdtempSync(join(process.env.SIGNAL_TEST_TMPDIR || tmpdir(), 'signal-delivery-'));
  try {
    writeFileSync(join(dir, 'signal_v2.json'), JSON.stringify(canonical)); writeFileSync(join(dir, 'signal_trials.json'), JSON.stringify(trials));
    const options = { publicDir: dir, origin, expectedSession: '2026-10-08', now: new Date('2026-10-08T15:00:00Z') };
    assert.equal(publishDigest(options).created, true);
    const page = join(dir, 'digests/2026-10-08/index.html'), before = statSync(page).mtimeMs;
    const html = readFileSync(page, 'utf8');
    assert.ok(html.includes('simulated paper')); assert.ok(html.includes('Separate unpromoted trials')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>fake'));
    assert.equal(publishDigest(options).created, false); assert.equal(statSync(page).mtimeMs, before);
    const rss = readFileSync(join(dir, 'digests/feed.xml'), 'utf8'); assert.ok(rss.includes('Thu, 08 Oct 2026 14:00:00 GMT'));
    writeFileSync(join(dir, 'signal_v2.json'), JSON.stringify({ ...canonical, status: 'paper' }));
    assert.equal(publishDigest(options).reason, 'published_archive_input_conflict'); assert.equal(readFileSync(page, 'utf8'), html);
    assert.equal(JSON.parse(readFileSync(join(dir, 'digests/status.json'))).status, 'blocked');
    assert.equal(JSON.parse(readFileSync(join(dir, 'digests/index.json'))).editions.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy-safe missing and mismatched inputs produce empty archive and RSS, never a made-up edition', () => {
  const dir = mkdtempSync(join(process.env.SIGNAL_TEST_TMPDIR || tmpdir(), 'signal-delivery-'));
  const options = { publicDir: dir, origin, now: new Date('2026-10-08T15:00:00Z') };
  try {
    assert.equal(publishDigest(options).reason, 'canonical_feed_missing');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'digests/index.json'))).editions, []);
    assert.equal(JSON.parse(readFileSync(join(dir, 'digests/latest.json'))).session_date, null);
    assert.match(readFileSync(join(dir, 'feed.xml'), 'utf8'), /<rss version="2.0">/);
    writeFileSync(join(dir, 'signal_v2.json'), JSON.stringify(canonical));
    assert.equal(publishDigest(options).reason, 'trials_feed_missing');
    writeFileSync(join(dir, 'signal_trials.json'), JSON.stringify({ ...trials, session_date: '2026-10-07' }));
    assert.equal(publishDigest(options).reason, 'trials_session_mismatch');
    writeFileSync(join(dir, 'signal_trials.json'), JSON.stringify(trials));
    assert.equal(publishDigest({ ...options, now: new Date('2026-10-12T15:00:00Z') }).reason, 'session_stale_or_future');
    writeFileSync(join(dir, 'sitemap.xml'), '<urlset><url><loc>https://signal.example.com/untouched</loc></url></urlset>');
    assert.equal(publishDigest(options).status, 'ready');
    assert.match(readFileSync(join(dir, 'sitemap.xml'), 'utf8'), /\/untouched<\/loc>/);
    // Public digest discovery retired; archive immutability is still required.
    assert.doesNotMatch(readFileSync(join(dir, 'sitemap.xml'), 'utf8'), /\/digests\//);
    assert.equal(publishDigest({ ...options, now: new Date('2026-10-09T09:00:00Z') }).session_date, '2026-10-08');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('digest has real levels, supplied metrics, operational commentary and separate blocked trial statuses only', () => {
  const c = { ...canonical, private_rules: 'SECRET_PRIVATE', plans: [{ id: 'p2', symbol: 'PUBLIC', state: 'eligible', entry_low: 100, entry_high: 102, stop: 96, t1: 108, t2: 114, t3: 120, private_rules: 'SECRET_PRIVATE' }] };
  const t = { ...trials, plans: undefined, engines: { pulse: { status: 'blocked', blocked_reason: 'bars_missing', diagnostic: 'SECRET_PRIVATE', plans: [{ symbol: 'HIDDEN' }] }, compass: { status: 'paper', session_date: trials.session_date, plans: [] } } };
  const digest = buildDigest(c, t, origin, c.session_date);
  assert.ok(digest.html.includes('100–102')); assert.ok(digest.html.includes('108 / 114 / 120'));
  assert.ok(digest.html.includes('Operational commentary')); assert.ok(digest.html.includes('bars_missing'));
  assert.equal(digest.metrics.losses, 1); assert.equal(digest.metrics.win_rate, null);
  assert.ok(!JSON.stringify(digest).includes('SECRET_PRIVATE')); assert.ok(!JSON.stringify(digest).includes('HIDDEN'));
  assert.ok(digest.html.includes('<footer>'));
  validateManifest(digest, origin, new Date('2026-10-08T15:00:00Z'));
  assert.throws(() => validateManifest({ ...digest, html: digest.html + 'tampered' }, origin), /integrity_mismatch/);
  assert.throws(() => buildDigest({ ...c, plans: [{ ...c.plans[0], stop: null }] }, t, origin, c.session_date), /levels_incomplete/);
  assert.throws(() => validateManifest(digest, origin, new Date('2026-10-08T13:59:59Z')), /publication_stale_or_future/);
  assert.throws(() => validateManifest(digest, origin, new Date('2026-10-12T15:00:00Z')), /session_stale_or_future/);
});

test('delivery CLI trusts only configured HTTPS origin, bounds pages and never leaks provider responses', async () => {
  await assert.rejects(deliverDigest({ env: {} }), /delivery_not_configured/);
  await assert.rejects(deliverDigest({ env: { SIGNAL_URL: 'https://host.test/path', EDIT_KEY: 'secret' } }), /invalid_origin/);
  const env = { SIGNAL_URL: origin, EDIT_KEY: 'test-only' }; let calls = 0;
  const fetcher = async (url, options) => {
    assert.equal(url, `${origin}/api/delivery`); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-edit-key'], env.EDIT_KEY); assert.equal(options.body, '{}');
    calls++;
    return { ok: true, json: async () => ({ ok: true, more: calls < 2, sent: 1, suppressed: 0, skipped: 0, retry: 0, pending_review: 0 }) };
  };
  assert.equal((await deliverDigest({ env, fetcher })).sent, 2);
  calls = 0; await assert.rejects(deliverDigest({ env, fetcher, maxPages: 1 }), /page_limit_reached/);
  await assert.rejects(deliverDigest({ env, fetcher: async () => ({ ok: false, status: 503, text: async () => 'SECRET' }) }), error => error.message === 'delivery_blocked_http_503');
});

test('missing, stale, uncompleted and synthetic feeds fail closed with named reasons', () => {
  assert.throws(() => buildDigest(canonical, null, origin, '2026-10-08'), /trials_schema_missing/);
  assert.throws(() => buildDigest(canonical, trials, origin, '2026-10-09'), /canonical_session_mismatch/);
  assert.throws(() => buildDigest({ ...canonical, published_at: '2026-10-08T09:00:00Z' }, trials, origin, '2026-10-08'), /session_not_completed/);
  assert.throws(() => buildDigest({ ...canonical, synthetic: true }, trials, origin, '2026-10-08'), /not_production/);
  assert.equal(inputHash(canonical, trials), inputHash(Object.fromEntries(Object.entries(canonical).reverse()), trials));
});
