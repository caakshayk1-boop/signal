// Deterministic browser replacement for the retired publication UI checks.
// Uses committed market fixtures and fresh browser profiles; never production.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import '../public/retirement.js';

const servers = [], failures = [];
let browser, checks = 0;
const forbidden = /paper (?:setup|book|wallet|plan|position)|Technical Confluence|Opening Demand|Compression Release|Failed Breakdown Reclaim|Magic Formula|Pulse (?:trial|swing)|Compass (?:trial|position)|Signal plan|Plans for the next session|Tomorrow.s desk/i;
async function start(site, port) {
  const child = spawn(process.execPath, ['scripts/vision-dev.mjs', String(port)], { env: { ...process.env, VDEV_SITE: site }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base)).ok) return base; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error(site + ' fixture server did not start');
}
async function clean(page, label) {
  await page.waitForFunction(() => document.querySelector('main')?.innerText.trim().length > 20);
  await page.waitForTimeout(900);
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, forbidden, label);
  const links = await page.locator('a[href]').evaluateAll(es => es.map(e => e.getAttribute('href')));
  for (const href of links) {
    const u = new URL(href, page.url());
    if (u.origin !== new URL(page.url()).origin && !/^(signal|vision)\.askakshay\.com$/.test(u.hostname)) continue;
    const path = u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0] : u.pathname;
    assert.ok(!PublicRetirement.page(path) && !PublicRetirement.asset(path), label + ': forbidden link ' + href);
  }
  assert.equal(await page.locator('form[action="/api/subscribe"], [data-sig2-subscribe]').count(), 0, label);
  checks++;
}
try {
  const signal = await start('signal', 8897), vision = await start('vision', 8898);
  browser = await chromium.launch({ headless: true });
  for (const [site, base, paths] of [
    ['Signal', signal, ['/', '/screen', '/stock/RELIANCE', '/markets', '/news', '/watch', '/alerts', '/discover', '/methodology', '/about', '/sources', '/terms', '/disclaimer', '/disclosures']],
    ['Vision', vision, ['/', '/company/RELIANCE', '/#/screener', '/#/compare?s=TCS,INFY', '/#/today', '/#/cockpit', '/#/markets', '/#/news', '/#/watchlist']]
  ]) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('sig:watch', JSON.stringify(['RELIANCE']));
      // A returning browser must not resurrect historical engine alerts.
      localStorage.setItem('sig:events', JSON.stringify([{ k: 'setup', sym: 'RELIANCE', what: 'Paper setup', href: '/setup/old', at: 1 }]));
    });
    const page = await ctx.newPage(), errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => { const u = new URL(req.url()); if (PublicRetirement.asset(u.pathname)) requests.push(u.pathname); });
    for (const path of paths) {
      await page.goto(base + path, { waitUntil: 'domcontentloaded' });
      await clean(page, site + path);
      assert.deepEqual(errors, [], site + path + ': runtime errors');
      assert.deepEqual(requests, [], site + path + ': retired feeds requested');
      console.log('PASS', site + path);
    }
    // Desktop palette and More sheet cannot rediscover retired products.
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator(site === 'Signal' ? '#cmdkBtn' : '#kOpen').click();
    await clean(page, site + ' command palette');
    await page.keyboard.press('Escape');
    await page.locator(site === 'Signal' ? '#moreBtn' : '#navMore').click();
    await clean(page, site + ' More');
    await page.keyboard.press('Escape');
    for (const route of ['engines', 'pulse', 'compass', 'magic', 'wallet', 'paper', 'performance', 'setups', 'brief/RELIANCE', 'plan/old', 'setup/old']) {
      if (site === 'Vision') {
        await page.goto(base + '/#/' + route, { waitUntil: 'domcontentloaded' });
        assert.match(await page.locator('main').innerText(), /publication has been retired/i);
      } else {
        const res = await page.goto(base + '/' + route);
        assert.equal(res.status(), 410, route);
      }
      await clean(page, site + ' retired ' + route);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await clean(page, site + ' mobile home');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), site + ' mobile overflow');
    await ctx.close();
  }
  const gemsContext = await browser.newContext({ serviceWorkers: 'block' });
  const gems = await gemsContext.newPage(), gemsErrors = [];
  gems.on('pageerror', e => gemsErrors.push(e.message));
  await gems.goto(signal + '/gems', { waitUntil: 'domcontentloaded' });
  await gems.waitForFunction(() => document.querySelectorAll('#app section').length >= 3);
  assert.deepEqual(gemsErrors, []);
  assert.equal(await gems.locator('#setups').count(), 0);
  assert.match(await gems.locator('main').innerText(), /Institutional flow|Market|Sector/i);
  checks++; console.log('PASS Gems market smoke');
  await gemsContext.close();
  console.log(`retirement-ui: ${checks} checks passed`);
} catch (error) { failures.push(error); console.error(error); process.exitCode = 1; }
finally { await browser?.close(); for (const child of servers) child.kill('SIGTERM'); }
