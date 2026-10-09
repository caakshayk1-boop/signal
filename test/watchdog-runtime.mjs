import test from 'node:test';
import assert from 'node:assert/strict';
import { runWatchdog } from '../src/watchdog.js';

test('read-only watchdog reaches GitHub with authenticated headers, without dispatch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.match(String(url), /api\.github\.com\/repos\//);
    assert.equal(options.headers.Authorization, 'Bearer test-only-token');
    assert.notEqual(options.method, 'POST');
    return Response.json({ workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: new Date().toISOString() }] });
  };
  try {
    const result = await runWatchdog({ GH_DISPATCH_TOKEN: 'test-only-token' }, { act: false });
    assert.equal(result.ok, true);
    assert.ok(calls > 0);
    assert.ok(result.checked.every(row => !row.error), JSON.stringify(result.checked));
  } finally { globalThis.fetch = original; }
});
