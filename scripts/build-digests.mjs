#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDigest, escape, sessionDate, validateManifest } from '../src/delivery/digest.js';
import { publicOrigin } from '../src/delivery/provider.js';

export function publishDigest({ publicDir, origin, expectedSession, now = new Date() }) {
  const root = join(publicDir, 'digests');
  mkdirSync(root, { recursive: true });
  const readFeed = (file, name) => {
    if (!existsSync(join(publicDir, file))) throw new Error(`${name}_feed_missing`);
    try { return JSON.parse(readFileSync(join(publicDir, file), 'utf8')); }
    catch { throw new Error(`${name}_feed_invalid`); }
  };
  let result = { schema: 'signal-digest-status/1', status: 'blocked', reason: null, created: false, session_date: expectedSession || null, input_hash: null };
  try {
    const canonical = readFeed('signal_v2.json', 'canonical'), trials = readFeed('signal_trials.json', 'trials');
    // Infer only from matching source sessions; never substitute today's date.
    expectedSession ||= canonical.session_date;
    result.session_date = sessionDate(expectedSession) ? expectedSession : null;
    const digest = buildDigest(canonical, trials, origin, expectedSession);
    validateManifest(digest, origin, now);
    const dir = join(root, expectedSession), manifest = join(dir, 'delivery.json');
    if (existsSync(manifest)) {
      const existing = JSON.parse(readFileSync(manifest, 'utf8'));
      if (existing.input_hash !== digest.input_hash) throw new Error('published_archive_input_conflict');
      validateManifest(existing, origin);
      if (!existsSync(join(dir, 'index.html')) || readFileSync(join(dir, 'index.html'), 'utf8') !== existing.html) throw new Error('published_archive_incomplete');
    } else {
      if (existsSync(join(dir, 'index.html'))) throw new Error('published_archive_manifest_missing');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), digest.html, { flag: 'wx' });
      writeFileSync(manifest, JSON.stringify(digest, null, 2) + '\n', { flag: 'wx' });
      result.created = true;
    }
    result = { ...result, status: 'ready', input_hash: digest.input_hash };
  } catch (e) {
    // Expected missing/stale input must not break deployment or erase archives.
    // Expose a bounded machine reason, never raw feed/provider error content.
    result.reason = /^[a-z][a-z0-9_]+$/.test(e.message) ? e.message : 'publication_inputs_invalid';
  }
  const archiveIssues = [];
  const editions = readdirSync(root).filter(sessionDate).sort().reverse().flatMap(date => {
    try {
      const d = JSON.parse(readFileSync(join(root, date, 'delivery.json'), 'utf8'));
      // Older genuine editions remain visible even before manifest integrity
      // fields were added; only the new validated format can be delivered.
      if (d.schema !== 'signal-delivery/1' || d.session_date !== date || d.archive_url !== `${origin}/digests/${date}/` || !Number.isFinite(Date.parse(d.published_at)) || typeof d.text !== 'string' || typeof d.html !== 'string' || readFileSync(join(root, date, 'index.html'), 'utf8') !== d.html) throw new Error('invalid_archive');
      if (d.manifest_hash) validateManifest(d, origin);
      return [d];
    } catch { archiveIssues.push(date); return []; }
  });
  const latest = editions[0];
  const writeChanged = (path, value) => { if (!existsSync(path) || readFileSync(path, 'utf8') !== value) writeFileSync(path, value); };
  writeChanged(join(root, 'latest.json'), JSON.stringify({ schema: 'signal-digest-pointer/1', session_date: latest?.session_date || null, input_hash: latest?.input_hash || null }) + '\n');
  writeChanged(join(root, 'status.json'), JSON.stringify({ ...result, archive_issues: archiveIssues }) + '\n');
  writeChanged(join(root, 'index.json'), JSON.stringify({ schema: 'signal-digest-index/1', editions: editions.map(({ session_date, published_at, archive_url }) => ({ session_date, published_at, archive_url })) }) + '\n');
  const items = editions.map(d => `<item><title>Signal digest — ${d.session_date}</title><link>${escape(d.archive_url)}</link><guid isPermaLink="true">${escape(d.archive_url)}</guid><pubDate>${new Date(d.published_at).toUTCString()}</pubDate><description>${escape(d.text)}</description></item>`).join('\n');
  writeChanged(join(root, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Signal completed-session paper digests</title><link>${escape(origin)}/digests/</link><description>Delayed simulated paper research. Separate unpromoted trials. Not real-time instructions.</description>${items}</channel></rss>\n`);
  writeChanged(join(publicDir, 'feed.xml'), readFileSync(join(root, 'feed.xml'), 'utf8'));
  writeChanged(join(root, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signal digest archive</title><link rel="canonical" href="${escape(origin)}/digests/"></head><body><h1>Completed-session paper digests</h1><p>Delayed simulated paper research; unpromoted trials are separate. Not real-time instructions.</p><a href="feed.xml">RSS</a><ul>${editions.map(d => `<li><a href="${escape(d.archive_url)}">${d.session_date}</a></li>`).join('')}</ul></body></html>\n`);
  // Preserve unrelated URLs. Add only missing digest entries to a valid map.
  const sitemap = join(publicDir, 'sitemap.xml');
  if (existsSync(sitemap)) {
    const xml = readFileSync(sitemap, 'utf8');
    if (xml.includes('</urlset>')) {
      const additions = [`${origin}/digests/`, ...editions.map(d => d.archive_url)].filter(url => !xml.includes(`<loc>${escape(url)}</loc>`)).map(url => `<url><loc>${escape(url)}</loc></url>`).join('\n');
      if (additions) writeChanged(sitemap, xml.replace('</urlset>', `${additions}\n</urlset>`));
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = process.argv.indexOf('--expected-session');
    const expectedSession = flag < 0 ? process.env.SIGNAL_EXPECTED_SESSION : process.argv[flag + 1];
    const result = publishDigest({ publicDir: resolve('public'), origin: publicOrigin({ SIGNAL_PUBLIC_URL: process.env.SIGNAL_PUBLIC_URL || process.env.SIGNAL_URL || 'https://signal.askakshay.com' }), expectedSession });
    console.log(result.status === 'blocked' ? `Digest publication skipped: ${result.reason}; existing archive index and RSS retained.` : `digest ${result.session_date}: ${result.created ? 'created' : 'unchanged'} (${result.input_hash})`);
  } catch (e) { console.error(`Digest build blocked: ${e.message}`); process.exitCode = 1; }
}
