import test from 'node:test';
import assert from 'node:assert/strict';
import { signalPage } from '../src/seo.js';

// Capture HTMLRewriter output without launching the Worker or a browser.
// Exercises actual feed selection, route semantics, escaping and Article data.
class CaptureRewriter {
  handlers = [];
  on(selector, handler) { this.handlers.push([selector, handler]); return this; }
  transform() {
    let body = '', head = '';
    for (const [selector, handler] of this.handlers) {
      const element = { setInnerContent(v) { if (selector === 'section.pre') body = v; },
        setAttribute() {}, remove() {}, onEndTag(callback) { callback({ before(v) { head += v; } }); } };
      handler.element(element);
    }
    return new Response(head + body);
  }
}
globalThis.HTMLRewriter = CaptureRewriter;
const plan = { id: 'real', symbol: 'REAL', state: 'closed', outcome: 'loss', fill: { price: 100 },
  entry_low: 100, entry_high: 102, initial_stop: 96, t1: 108, t2: 114, t3: 120,
  total_r: -1, net_pnl_inr: -1000, session_date: '2026-10-01', closed_session: '2026-10-02',
  published_at: '2026-10-01T18:30:00+05:30', thesis_note: '<script>bad</script>' };
const publication = { schema: 'signal-v2-public/1', session_date: '2026-10-02', published_at: '2026-10-02T18:30:00+05:30',
  plans: [plan], next_session: '2026-10-05', metrics: { closed: 1, published: 1 },
  paper: { plans: [{ ...plan, id: 'trial', symbol: 'TRIALONLY', total_r: 100 }] } };
const env = { ASSETS: { async fetch(request) {
  const path = new URL(request.url).pathname;
  const data = path === '/signal_v2.json' ? publication : path === '/c/_site.json' ? { built_at: publication.published_at }
    : path === '/paper_record.json' ? { schema: 'paper-record/1', trades: [] }
    : path === '/signal_trials.json' ? { schema: 'signal-trials/1', engines: { pulse: { status: 'blocked', status_detail: 'earnings_missing', plans: [], journal: [] } } }
    : path === '/digests/index.json' ? { schema: 'signal-digest-index/1', editions: [{ session_date: '2026-10-02', published_at: publication.published_at, archive_url: 'javascript:alert(1)' }] } : null;
  return data ? Response.json(data) : new Response('<main><section class="pre"></section></main>', { headers: { 'content-type': 'text/html' } });
} } };
const page = path => signalPage(new Request('https://signal.askakshay.com' + path), env, path);

test('pre-hydration homepage and setups contain actual feed rows with separate trial labels', async () => {
  const home = await (await page('/')).text(), setups = await (await page('/opportunities')).text();
  assert.match(home, /Past example from the main forward record/); assert.match(home, /REAL/);
  assert.match(setups, /TRIALONLY/); assert.match(setups, /excluded from the main record/);
  assert.doesNotMatch(home + setups, /written by the server|replaces it as soon|Snapshot published/);
});
test('server Record selects only main closed results', async () => {
  const html = await (await page('/performance')).text();
  assert.match(html, /-1\.00R/); assert.doesNotMatch(html, /TRIALONLY|\+100\.00R/);
  assert.match(html, /Insufficient sample/);
});
test('real plan HTML has Article publication fields and escapes plan text', async () => {
  const response = await page('/plan/real'), html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /"@type":"Article"/);
  assert.match(html, /2026-10-01T18:30:00\+05:30/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>bad/);
});
test('unknown plan has no Article and returns a true 404', async () => {
  const response = await page('/plan/not-published'), html = await response.text();
  assert.equal(response.status, 404); assert.doesNotMatch(html, /"@type":"Article"/);
  assert.match(html, /No published plan/);
});
test('trial HTML uses the canonical trial filename and stays outside the main record', async () => {
  const html = await (await page('/pulse')).text();
  assert.match(html, /earnings_missing/); assert.match(html, /do not count in the main record/);
  assert.doesNotMatch(html, /TRIALONLY|<b>REAL<\/b>/);
});
test('archive HTML constructs dated local links rather than trusting feed URLs', async () => {
  const html = await (await page('/digests')).text();
  assert.match(html, /href="\/digests\/2026-10-02\/"/); assert.doesNotMatch(html, /javascript:alert/);
  assert.match(globalThis.SignalUI.digests(null), /unavailable or incomplete/);
  assert.match(globalThis.SignalUI.digests({ schema: 'signal-digest-index/1', editions: [{ session_date: '2026-02-30' }] }), /unavailable or incomplete/);
  assert.match(globalThis.SignalUI.digests({ schema: 'signal-digest-index/1', editions: [] }), /No completed-session editions/);
});
