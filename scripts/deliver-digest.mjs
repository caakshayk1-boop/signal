#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Owner-only post-deployment trigger. Never accepts recipients or content.
// Redirects are refused so the edit key cannot cross to another host.
export async function deliverDigest({ env = process.env, fetcher = fetch, maxPages = 100 } = {}) {
  if (!env.SIGNAL_URL || !env.EDIT_KEY) throw new Error('delivery_not_configured: SIGNAL_URL and EDIT_KEY are required');
  let url;
  try { url = new URL(env.SIGNAL_URL); } catch { throw new Error('delivery_invalid_origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('delivery_invalid_origin');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('delivery_invalid_page_limit');
  const total = { pages: 0, sent: 0, suppressed: 0, skipped: 0, retry: 0, pending_review: 0 };
  for (let page = 0; page < maxPages; page++) {
    let response;
    try {
      response = await fetcher(`${url.origin}/api/delivery`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { 'x-edit-key': env.EDIT_KEY, 'Content-Type': 'application/json' }, body: '{}' });
    } catch { throw new Error('delivery_transport_uncertain: inspect server receipts before retrying'); }
    if (!response.ok) throw new Error(`delivery_blocked_http_${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error('delivery_invalid_response'); }
    if (body.ok !== true || typeof body.more !== 'boolean' || !['sent', 'suppressed', 'skipped', 'retry', 'pending_review'].every(k => Number.isSafeInteger(body[k]) && body[k] >= 0)) throw new Error('delivery_invalid_response');
    total.pages++;
    for (const key of ['sent', 'suppressed', 'skipped', 'retry']) total[key] += body[key];
    total.pending_review = body.pending_review;
    if (body.retry || body.pending_review) throw new Error('delivery_pending_review: inspect server receipts; no automatic retry');
    if (!body.more) return total;
    if (!body.sent && !body.suppressed) throw new Error('delivery_no_progress');
  }
  throw new Error('delivery_page_limit_reached: further recipients remain');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Delivery completed: ${JSON.stringify(await deliverDigest())}`); }
  catch (error) { console.error(`Delivery blocked: ${error.message}`); process.exitCode = 1; }
}
