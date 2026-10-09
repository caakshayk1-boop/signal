/* Focused browser integration for main to run against wrangler dev.
 * Synthetic data is intercepted in this browser only; never written to feeds. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.argv[2] || 'http://127.0.0.1:8787';
const browser = await chromium.launch({ headless: true });
const closed = (i, r) => ({ id: 'test:' + i, symbol: 'TEST' + i, state: 'closed', outcome: r > 0 ? 'win' : 'loss', engine: 'test',
  entry_low: 100, entry_high: 102, initial_stop: 96, t1: 108, t2: 114, t3: 120, fill: { price: 100, session: '2026-10-01' },
  total_r: r, net_pnl_inr: r * 1000, session_date: '2026-10-01', closed_session: '2026-10-' + String(i + 1).padStart(2, '0'), published_at: '2026-10-01T18:30:00+05:30' });
const fixture = { schema: 'signal-v2-public/1', session_date: '2026-10-01', next_session: '2026-10-05', published_at: '2026-10-01T18:30:00+05:30', status: 'paused',
  status_detail: 'Publication paused; trial engines are separate.', forward_record_start: '2026-10-01', coverage: { universe: 988, with_session_bar: 988 },
  plans: [], strategies: [], metrics: { published: 0, closed: 0 }, costs: {}, reference_size: {} };
let current = fixture, posted = [];
const trials = { schema: 'signal-trials/1', session_date: '2026-10-01', published_at: '2026-10-01T18:30:00+05:30', engines: {
  pulse: { status: 'blocked', status_detail: 'Earnings data missing', plans: [], journal: [], gate: { open: false }, diagnostics: ['earnings_missing'] },
  compass: { status: 'blocked', status_detail: 'Filings missing', plans: [], journal: [] } } };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/subscribe') {
      posted.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'pending' }) });
    }
    if (path === '/signal_v2.json' || path === '/signal_trials.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(path === '/signal_trials.json' ? trials : current) });
    if (path === '/digests/index.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schema: 'signal-digest-index/1', editions: [{ session_date: '2026-10-01', published_at: fixture.published_at, archive_url: '/digests/2026-10-01/' }] }) });
    if (path.startsWith('/api/') || path.endsWith('.json')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.goto(base + '/');
  await page.waitForSelector('.home .sig2-example');
  assert.match(await page.locator('.sig2-example').innerText(), /Illustration only/);
  assert.equal(await page.locator('.sig2-stats > div').count(), 5);
  await page.locator('#digestEmail').fill('reader@example.com');
  await page.waitForTimeout(2100); // server anti-bot minimum, not a loading wait
  await page.locator('[data-sig2-subscribe] button').click();
  await page.waitForFunction(() => document.querySelector('.sig2-formstatus').textContent.includes('confirm your address'));
  assert.equal(posted.length, 1); assert.ok(posted[0].elapsed >= 2 && posted[0].elapsed < 20);
  assert.equal(posted[0].company, '');
  current = { ...fixture, plans: [closed(1, 2), { id: 'waiting', symbol: 'WAIT', state: 'awaiting_entry', last_close: 101, entry_low: 100, entry_high: 102 }], metrics: { published: 2, closed: 1 } };
  await page.goto(base + '/opportunities');
  await page.waitForSelector('[data-sig2-setups] tbody tr');
  await page.locator('[data-sig2-state="closed"]').click();
  assert.equal(await page.locator('[data-sig2-setups] tbody tr:visible').count(), 1);
  await page.locator('[data-sig2-state="active"]').click();
  assert.equal(await page.locator('[data-sig2-setups] tbody tr:visible').count(), 0);
  assert.ok(await page.locator('.sig2-filterempty').isVisible());
  current = { ...fixture, plans: Array.from({ length: 20 }, (_, i) => closed(i + 1, i % 2 ? -1 : 2)), metrics: { published: 20, closed: 20 } };
  await page.goto(base + '/performance');
  await page.waitForSelector('.sig2-analytics svg');
  assert.match(await page.locator('.sig2-analytics').innerText(), /R sample 20\/20/);
  assert.equal(await page.locator('.sig2-analytics svg').count(), 6);
  assert.equal((await page.goto(base + '/pulse')).status(), 200);
  await page.waitForFunction(() => document.querySelector('main').textContent.includes('Earnings data missing'));
  assert.match(await page.locator('main').innerText(), /do not count in the main record/);
  assert.doesNotMatch(await page.locator('main').innerText(), /TEST1/);
  assert.equal((await page.goto(base + '/digests')).status(), 200);
  await page.waitForSelector('main a[href="/digests/2026-10-01/"]');
  assert.match(await page.locator('main').innerText(), /1 Oct 2026 edition/);
  assert.deepEqual(errors, []);
  console.log('PASS focused homepage, subscription, filters, analytics and isolated trial UI');
} finally { await browser.close(); }
