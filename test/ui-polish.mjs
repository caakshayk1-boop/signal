#!/usr/bin/env node
/* A1/A3 browser regression tests. Every feed/provider is synthetic and every
 * asset is local; this test cannot call Telegram, send mail, or read production. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  const file = resolve(root, '.' + (extname(path) ? path : '/index.html'));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const stamp = '2026-10-08T18:30:00+05:30';
const row = { sym: 'TEST', name: 'Test Industries', sector: 'Industrials', price: 102, r1d: 2, r1w: 3, r1m: 4, r3m: 5,
  r6m: 6, sma50: 95, sma200: 90, high52: 115, low52: 80, turnover_cr: 200, vol_spike: 1.2, vd: { c: 'WATCH' } };
const series = { ok: true, points: Array.from({ length: 20 }, (_, i) => ({ t: `2026-09-${String(i + 1).padStart(2, '0')}`, c: 90 + i })) };
const paper = { id: 'mock:TEST', symbol: 'TEST', engine: 'technical', state: 'awaiting_entry', entry_low: 100, entry_high: 103, stop: 95,
  t1: 108, t2: 112, t3: 116, filed_session: '2026-10-08', for_session: '2026-10-09', valid_through: '2026-10-15', why: 'test fixture' };
const feed = { schema: 'signal-v2-public/1', session_date: '2026-10-08', next_session: '2026-10-09', published_at: stamp,
  status: 'paused', plans: [], strategies: [], metrics: {}, costs: {}, reference_size: {},
  paper: { as_of: '2026-10-08', plans: [paper], engines: [{ id: 'technical', name: 'Technical Confluence' }] } };
let regime = 'calm_trend', ownership = { quality: 'complete', fii: null, dii: null, promoter: null, fii_pp: null, dii_pp: null, series: [] };
let releaseNews = null, waitNews = null;
const browser = await chromium.launch({ headless: true });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
try {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'no-preference' });
  const page = await context.newPage(), errors = [], external = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()), p = u.pathname;
    if (u.origin !== base) { external.push(u.origin); return route.abort(); }
    let data;
    if (p === '/regime.json' && regime === 'network_failure') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"mock unavailable"}' });
    if (p === '/regime.json') data = regime === null ? {} : { today: { regime }, generated_at: stamp };
    else if (p === '/signal_v2.json') data = feed;
    else if (p === '/screen.json' || p === '/screen-lite.json') data = { rows: [row], generated_at: stamp, built_at: stamp, built_on: '2026-10-08' };
    else if (p === '/institutional.json') data = { rows: { TEST: ownership }, generated_at: stamp };
    else if (p.startsWith('/c/')) data = { r: row, x: ownership, ctx: {} };
    else if (p === '/api/signals') data = u.searchParams.has('series') ? series : { ok: true, quotes: { TEST: { price: 102, change_pct: 2 } }, at: stamp };
    else if (p === '/api/ticker') data = { ok: true, fetched_at: stamp, segments: [{ key: 'india', label: 'India', items: [
      { name: 'Nifty 50', symbol: '^NSEI', price: '25,000', price_raw: 25000, change_pct: 1, trend: [24500, 24900, 24800, 25000] } ] }], constituents: [], ledger: {} };
    else if (p === '/news.json' || p === '/api/wire') {
      if (waitNews) await waitNews;
      const stories = [{ title: 'TEST opens a new factory', source: 'Fixture Wire', summary: 'Synthetic news for a browser test.', link: '#story' }];
      data = p === '/news.json' ? stories : { ok: true, stories, at: stamp };
    } else if (p === '/edition.json') data = { built_at: stamp };
    else if (p === '/technical_read.json') data = { schema: 'technical-read/1', session_date: '2026-10-08', reads: {} };
    else if (p.endsWith('.json') || p.startsWith('/api/')) data = {};
    if (data !== undefined) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    return route.continue();
  });

  await page.goto(base + '/vision.html#/asset/TEST');
  await page.waitForSelector('#aIns .kv').catch(async e => { console.error((await page.locator('body').innerText()).slice(0, 2500)); throw e; });
  check(await page.locator('#aIns .na').count() === 3, 'all three unknown holdings show NA');
  check(!/null|undefined|q\/q/.test(await page.locator('#aIns').innerText()), 'unknown ownership never leaks null or a q/q label');
  check((await page.locator('#aHead [data-star]').count()) === 1, 'the company watch star remains');
  await page.locator('#kOpen').click();
  await page.locator('#palQ').fill('TEST');
  await page.waitForSelector('#palL [role="option"]');
  check(await page.locator('#palL [data-star]').count() === 0, 'palette has no nested star');
  check((await page.locator('#palL').innerText()).includes('Test Industries'), 'palette retains the company subtitle');
  await page.keyboard.press('Escape');
  ownership = { ...ownership, fii: 0, dii: 12.34, promoter: 55, fii_pp: 0, dii_pp: -1.25 };
  await page.reload();
  await page.waitForSelector('#aIns .kv');
  const holding = await page.locator('#aIns').innerText();
  check(holding.includes('0.00%') && holding.includes('12.34%') && holding.includes('55.00%'), 'zero and real holdings are preserved');
  check(holding.includes('0.00 pp q/q') && holding.includes('−1.25 pp q/q'), 'zero and negative quarterly changes are preserved');
  ownership = { quality: 'complete', series: [] };
  await page.reload();
  await page.waitForSelector('#aIns .kv');
  check(await page.locator('#aIns .na').count() === 3 && !/q\/q|undefined/.test(await page.locator('#aIns').innerText()), 'omitted ownership fields also show NA without q/q');

  waitNews = new Promise(r => { releaseNews = r; });
  await page.goto(base + '/screen');
  await page.waitForSelector('.wstar[data-watch="TEST"]');
  await page.locator('a[href="/news"]:visible').first().click();
  await page.waitForSelector('main .sk-row');
  check(await page.locator('main .sk-row').count() === 6, 'news paints its skeleton while feeds are held');
  check(await page.locator('main h1').innerText() === 'The wire', 'news loading state has its page heading');
  releaseNews(); waitNews = null;
  await page.waitForSelector('.nwc');
  check(await page.locator('main .sk-row').count() === 0, 'news replaces the skeleton when feeds arrive');

  for (const [name, color] of Object.entries({ calm_trend: '#2fa08c', calm_range: '#9a8f7a', highvol_trend: '#c99a2e', highvol_mr: '#c97a2e', crisis: '#c0392b' })) {
    regime = name;
    await page.goto(base + '/news');
    await page.waitForFunction(value => document.documentElement.dataset.regime === value, name);
    check(await page.locator('.amb').count() === 1, `${name} has one ambient layer`);
    const style = await page.locator('.amb').evaluate(el => { const s = getComputedStyle(el); return { c: s.getPropertyValue('--amb-c'), pe: s.pointerEvents, z: s.zIndex, hidden: el.getAttribute('aria-hidden'), bg: s.backgroundImage }; });
    check(style.c === color && style.pe === 'none' && style.z === '0' && style.hidden === 'true' && style.bg.includes('0.1') && style.bg.includes('0.07'), `${name} is faint and inert`);
  }
  for (const invalid of [null, 'unknown_regime', 'crisis" onclick="bad', '__proto__', 'network_failure']) {
    regime = invalid;
    await page.goto(base + '/news');
    await page.waitForSelector('.nwc');
    check(await page.locator('html').getAttribute('data-regime') === null, 'unknown/malformed regime leaves tint off');
    check(await page.locator('.amb').evaluate(el => getComputedStyle(el).opacity) === '0', 'no regime means no visible tint');
  }

  regime = 'calm_trend';
  await page.goto(base + '/markets');
  await page.waitForSelector('.spark .ln');
  const spark = page.locator('.spark .ln').first();
  check(await spark.getAttribute('pathLength') === '100', 'spark stroke is normalized');
  check(await spark.evaluate(el => getComputedStyle(el).animationName) === 'linedraw', 'spark uses draw-in');
  check(await page.locator('.spark .fill').first().evaluate(el => getComputedStyle(el).animationName) === 'none', 'spark fill is not animated');
  await spark.evaluate(el => el.getAnimations().forEach(a => a.finish()));
  check(await spark.evaluate(el => getComputedStyle(el).strokeDashoffset) === '0px', 'draw-in finishes with a complete stroke');

  await page.goto(base + '/brief');
  await page.waitForSelector('path.px');
  check(await page.locator('path.px').getAttribute('pathLength') === '100', 'price stroke is normalized');
  check(await page.locator('path.px').evaluate(el => getComputedStyle(el).animationDuration) === '1.1s', 'price stroke uses the specified draw duration');
  await page.locator('.v2w-pl').hover();
  check(/\d{4} Close/.test(await page.locator('.v2w-pl .v2w-tip').textContent()), 'price tooltip separates its date and Close');

  await page.goto(base + '/screen');
  await page.waitForSelector('.wstar[data-watch="TEST"]');
  const star = page.locator('.wstar[data-watch="TEST"]').first();
  await star.click();
  check(await star.getAttribute('aria-pressed') === 'true', 'watch star toggles on');
  const pop = await star.evaluate(el => { const a = el.getAnimations().find(a => a.animationName === 'starpop'); if (a) a.finish(); return !!a; });
  check(pop, 'watch star plays its pop');
  await star.click();
  check(await star.getAttribute('aria-pressed') === 'false', 'watch star toggles off');
  check(await star.evaluate(el => el.getAnimations().some(a => a.animationName === 'starpop' && a.playState === 'running')), 'a subsequent toggle replays the pop');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await star.click();
  check(await star.evaluate(el => getComputedStyle(el).animationName) === 'none', 'reduced motion keeps only the star state change');
  check(await page.locator('.amb').evaluate(el => getComputedStyle(el).transitionProperty) === 'none', 'reduced motion disables ambient fade');
  await page.goto(base + '/brief');
  await page.waitForSelector('path.px');
  check(await page.locator('path.px').evaluate(el => getComputedStyle(el).animationName === 'none' && getComputedStyle(el).strokeDasharray === 'none'), 'reduced motion shows the complete price stroke immediately');
  await page.goto(base + '/markets');
  await page.waitForSelector('.spark .ln');
  check(await page.locator('.spark .ln').first().evaluate(el => getComputedStyle(el).animationName === 'none' && getComputedStyle(el).strokeDasharray === 'none'), 'reduced motion shows the complete spark immediately');
  // Playwright has no reducedTransparency option. Emulate the preference in
  // this test's own launched Chromium; no external browser is connected.
  const media = await context.newCDPSession(page);
  await media.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ] });
  check(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches), 'Chromium applies reduced transparency');
  check(await page.locator('.amb').evaluate(el => getComputedStyle(el).display) === 'none', 'reduced transparency hides the ambient layer');
  check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
  check(external.length === 0, `no external requests: ${external.join(', ')}`);
  console.log(`PASS ${checks} A1/A3 browser checks (synthetic feeds; local assets only)`);
} finally {
  releaseNews?.();
  await browser.close();
  await new Promise(r => server.close(r));
}
