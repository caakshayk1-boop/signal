import '../public/retirement.js';

export function retirementResponse(request) {
  const url = new URL(request.url);
  let path;
  try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'; }
  catch { return new Response('Invalid address', { status: 400 }); }
  const quoteOnly = request.method === 'GET' && [...url.searchParams.keys()].some(k => ['px', 'series'].includes(k))
    && [...url.searchParams.keys()].every(k => ['px', 'series', 'range', 'interval'].includes(k));
  const retiredAPI = (path === '/api/signals' && !quoteOnly) || path === '/api/stats'
    || path === '/api/subscribe' || path === '/api/subscribe/confirm';
  if (!retiredAPI && !globalThis.PublicRetirement.page(path) && !globalThis.PublicRetirement.asset(path)) return null;
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, follow' };
  if (path.startsWith('/api/') || /\.(json|xml)$/.test(path)) {
    return Response.json({ ok: false, retired: true, error: 'This publication is no longer available.', research: '/screen' }, { status: 410, headers });
  }
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Publication retired</title><meta name="robots" content="noindex,follow"></head><body><main><h1>This publication has been retired</h1><p>Market data and company research remain available.</p><p><a href="/">Open market research</a></p></main></body></html>', { status: 410, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
}
