/* Public product retirement, 2026-10-10. Shared by both routers and the Worker.
 * Historical inputs and authenticated delivery jobs remain intact. */
(function (root) {
  const routes = new Set(['signals', 'engines', 'opportunities', 'performance', 'record', 'trials', 'trial', 'paper', 'wallet', 'book', 'pulse', 'compass', 'magic', 'magic-formula', 'buoy', 'ideas', 'research', 'setups', 'setup', 'plan', 'plans', 'brief', 'digests', 'join']);
  const files = new Set(['signal_v2.json', 'signal_trials.json', 'paper_record.json', 'magic_book.json', 'technical_read.json', 'feed.xml']);
  const pathOf = (path) => {
    try { return decodeURIComponent(path).replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase(); } catch { return path.toLowerCase(); }
  };
  const page = (path) => routes.has(pathOf(path).replace(/^#?\/?/, '').split('/')[0]);
  const asset = (path) => files.has(pathOf(path).replace(/^\//, '')) || /^\/digests(?:\/|$)/.test(pathOf(path));
  root.PublicRetirement = { page, asset };
})(globalThis);
