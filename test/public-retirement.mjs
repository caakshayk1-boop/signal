import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker from '../src/index.js';
import { retirementResponse } from '../src/retirement.js';
import { signalPage, visionHome, visionCompany } from '../src/seo.js';

const retiredPaths = ['/engines', '/signals', '/opportunities', '/performance', '/record', '/paper', '/wallet', '/book', '/pulse', '/compass', '/magic', '/magic-formula', '/brief', '/brief/RELIANCE', '/plan/old', '/setup/old', '/setups', '/research', '/buoy', '/ideas', '/trials', '/digests', '/digests/2026-10-01/index.html', '/digests/index.json', '/feed.xml', '/digests/feed.xml', '/signal_v2.json', '/signal_trials.json', '/paper_record.json', '/magic_book.json', '/technical_read.json', '/api/signals', '/api/signals?wallet=1', '/api/signals?px=TCS&wallet=1', '/api/stats'];
test('both hosts retire pages, archives and raw feeds before any asset or database access', async () => {
  const env = { ASSETS: { fetch() { throw new Error('retired request reached assets'); } } };
  for (const host of ['signal.askakshay.com', 'vision.askakshay.com']) for (const path of retiredPaths) {
    const res = await worker.fetch(new Request('https://' + host + path), env, {});
    assert.equal(res.status, 410, host + path);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
    assert.ok(res.headers.has('content-security-policy'));
    assert.doesNotMatch(await res.text(), /signal_v2\.json|paper_record\.json|entry_low|sv2\.|Technical Confluence/);
  }
});
test('encoded and trailing-slash routes cannot bypass retirement', () => {
  for (const p of ['/magic/', '/%6dagic', '/plan%2Fold', '/digests//2026-10-01/', '/paper_record%2ejson']) assert.equal(retirementResponse(new Request('https://signal.askakshay.com' + p)).status, 410, p);
});
test('subscription intake is disabled; unsubscribe, preferences and authenticated jobs remain routed', () => {
  for (const method of ['GET', 'POST']) assert.equal(retirementResponse(new Request('https://signal.askakshay.com/api/subscribe', { method })).status, 410);
  for (const p of ['/api/delivery', '/api/unsubscribe', '/api/subscription/preferences', '/api/telegram/webhook', '/api/pipeline']) assert.equal(retirementResponse(new Request('https://signal.askakshay.com' + p)), null, p);
});
test('prices, charts, screen and news are not retired', () => {
  for (const p of ['/', '/screen', '/stock/TCS', '/company/TCS', '/markets', '/news', '/watch', '/api/signals?px=TCS', '/api/signals?series=%5ENSEI&range=1y', '/pulse.json', '/screen.json', '/institutional.json', '/api/heat']) assert.equal(retirementResponse(new Request('https://signal.askakshay.com' + p)), null, p);
});
test('public regime keeps market history but withholds historical engine performance', async () => {
  const source = JSON.parse(readFileSync('public/regime.json', 'utf8'));
  const res = await worker.fetch(new Request('https://signal.askakshay.com/regime.json'), { ASSETS: { fetch: async () => Response.json(source) } }, {});
  const result = await res.json();
  assert.deepEqual(result.today, source.today); assert.deepEqual(result.history, source.history);
  assert.equal(result.measured, undefined); assert.ok(source.measured);
  assert.doesNotMatch(JSON.stringify(result), /"engines"|"avg_r"|"win_rate"/);
});
test('both service workers retire offline deep links and reload a stale shell once without touching local storage', async () => {
  for (const file of ['sw.js', 'vision-sw.js']) {
    const handlers = {}, removed = [], navigated = [];
    const sandbox = { URL, Response, Promise, PublicRetirement, importScripts() {},
      caches: { keys: async () => [file === 'sw.js' ? 'signal-shell-v5' : 'vision-shell-v1'], delete: async k => removed.push(k) },
      self: { location: { origin: 'https://vision.askakshay.com' }, addEventListener: (k, fn) => { handlers[k] = fn; },
        clients: { claim: async () => {}, matchAll: async () => [{ url: 'https://vision.askakshay.com/#/setups', navigate: async u => navigated.push(u) }] } } };
    runInNewContext(readFileSync('public/' + file, 'utf8'), sandbox);
    let response;
    handlers.fetch({ request: new Request('https://vision.askakshay.com/plan/old'), respondWith: p => { response = p; } });
    assert.equal((await response).status, 410);
    let activation; handlers.activate({ waitUntil: p => { activation = p; } }); await activation;
    assert.equal(removed.length, 1); assert.equal(navigated.length, 1);
  }
});
class CaptureRewriter {
  handlers = [];
  on(selector, handler) { this.handlers.push([selector, handler]); return this; }
  transform() {
    let out = '';
    for (const [selector, h] of this.handlers) h.element({ setInnerContent(v) { if (['section.pre', 'main#main'].includes(selector)) out += v; }, setAttribute() {}, remove() {}, onEndTag(fn) { fn({ before(v) { out += v; } }); } });
    return new Response(out);
  }
}
test('server-rendered home and company research never read publication feeds and escape company names', async () => {
  globalThis.HTMLRewriter = CaptureRewriter;
  const touched = [];
  const env = { ASSETS: { async fetch(request) {
    const path = new URL(request.url).pathname; touched.push(path);
    if (path === '/c/_site.json') return Response.json({ universe: 10, top: [{ sym: 'TCS', name: '<img src=x>' }], veod: { plans: [{ sym: 'FORBIDDEN', entry_low: 1 }] } });
    if (path === '/c/TCS.json') return Response.json({ r: { sym: 'TCS', name: '<img src=x>', price: 100 }, ctx: {} });
    return new Response('<main><section class="pre"></section></main>');
  } } };
  const s = await signalPage(new Request('https://signal.askakshay.com/'), env, '/');
  const v = await visionHome(new Request('https://vision.askakshay.com/'), env);
  const c = await visionCompany(new Request('https://vision.askakshay.com/company/TCS'), env, 'TCS');
  const html = await s.text() + await v.text() + await c.text();
  assert.doesNotMatch(html, /FORBIDDEN|Paper|paper plans|Setups|Magic Formula|<img src=x>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.ok(touched.every(p => !PublicRetirement.asset(p)));
});
test('sitemaps and shell contain no retired links, and caches were invalidated', () => {
  for (const f of ['public/sitemap.xml', 'public/vision-sitemap.xml', 'public/index.html', 'public/vision.html']) {
    const source = readFileSync(f, 'utf8');
    for (const m of source.matchAll(/(?:href="|<loc>)([^"<]+)/g)) {
      const u = new URL(m[1], 'https://signal.askakshay.com');
      if (!/^(signal|vision)\.askakshay\.com$/.test(u.hostname)) continue;
      assert.ok(!PublicRetirement.page(u.pathname) && !PublicRetirement.asset(u.pathname), f + ': ' + m[1]);
    }
  }
  assert.match(readFileSync('public/sw.js', 'utf8'), /signal-shell-v6/);
  assert.match(readFileSync('public/vision-sw.js', 'utf8'), /vision-shell-v2/);
  assert.doesNotMatch(readFileSync('public/c/_site.json', 'utf8'), /"veod"|"plans"/);
  assert.doesNotMatch(readFileSync('public/c/TCS.json', 'utf8'), /"vsig"/);
});
