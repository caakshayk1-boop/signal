// Real local Worker/Static Assets integration. Proves run_worker_first cannot
// be bypassed by a raw JSON/XML archive request. No upstream APIs are invoked.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
const base = 'http://127.0.0.1:8899';
// Node's fetch implementation may normalize Host. Use a raw local request to
// exercise the production hostname dispatch rather than accidentally Signal.
const hostFetch = (path, host) => new Promise((resolve, reject) => {
  const origin = host.startsWith('vision.') ? 'http://127.0.0.1:8900' : base;
  const req = http.get(origin + path, { headers: { host } }, res => {
    const chunks = []; res.on('data', b => chunks.push(b));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  }); req.on('error', reject);
});
const start = (port, host) => spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--port', port, '--local-upstream', host], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' } });
const server = start('8899', 'signal.askakshay.com');
const visionServer = start('8900', 'vision.askakshay.com');
let output = '';
server.stdout.on('data', b => { output += b; });
server.stderr.on('data', b => { output += b; });
visionServer.stdout.on('data', b => { output += b; });
visionServer.stderr.on('data', b => { output += b; });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode != null) throw new Error('Wrangler exited before startup: ' + output);
    try { ready = (await fetch(base + '/api/health')).ok && (await fetch('http://127.0.0.1:8900/api/health')).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, 'Local Worker startup');
  let checks = 0;
  for (const host of ['signal.askakshay.com', 'vision.askakshay.com']) {
    for (const path of ['/engines', '/pulse', '/compass', '/magic', '/wallet', '/paper', '/performance', '/opportunities', '/brief', '/plan/old', '/setup/old', '/signal_v2.json', '/paper_record.json', '/signal_trials.json', '/magic_book.json', '/technical_read.json', '/feed.xml', '/digests/feed.xml', '/digests/index.html', '/digests/index.json', '/api/signals?wallet=1', '/api/stats', '/api/subscribe']) {
      const res = await hostFetch(path, host);
      assert.equal(res.status, 410, host + path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
      checks++;
    }
    const home = await hostFetch('/', host);
    assert.equal(home.status, 200);
    assert.doesNotMatch(await home.text(), /paper plans|Paper setups|Technical Confluence|Magic Formula|href="\/performance"/);
    checks++;
    const company = await hostFetch(host.startsWith('vision.') ? '/company/TCS' : '/stock/TCS', host);
    assert.equal(company.status, 200, host + ': company research, ' + company.url);
    assert.match(await company.text(), /TCS/);
    checks++;
  }
  for (const path of ['/pulse.json', '/screen-lite.json', '/institutional.json', '/regime.json']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /json/); checks++;
  }
  console.log(`retirement-edge: ${checks} checks passed against real local Worker/Static Assets`);
} finally { server.kill('SIGTERM'); visionServer.kill('SIGTERM'); }
