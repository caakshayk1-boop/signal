/**
 * adapter.js — run a Vercel-style handler inside a Cloudflare Worker.
 *
 * Why this exists rather than a rewrite
 * -------------------------------------
 * The five API routes in src/api/ are byte-for-byte the ones that ran on
 * Vercel. That is deliberate and it is the whole point of this file: they
 * carry years of hard-won specifics — the Yahoo spark retry budget, the
 * badge-in-SQL mirror, the never-render-a-missing-quote-as-zero rule — and
 * every one of those is a bug someone already paid for. Re-typing them into a
 * different signature is how you pay again.
 *
 * So the handlers keep the `(req, res)` shape and this file supplies it:
 * `req` is a plain object with `method`, `query`, `headers` and a pre-parsed
 * `body`; `res` collects a status, headers and a body, and resolves a real
 * `Response`. The only edit made to any handler was `@libsql/client` →
 * `@libsql/client/web` in _db.js, because the node client opens a TCP socket
 * and a Worker has none.
 *
 * A consequence worth knowing: `res` is write-once. A handler that calls
 * `json()` twice would have thrown "headers already sent" on Node; here the
 * second call is ignored and the first response stands.
 */
export async function runVercelHandler(handler, request, ctx) {
  const url = new URL(request.url);

  // Vercel gives `query` as a plain object with repeated keys collapsed to the
  // last value. URLSearchParams.entries() has the same effect here.
  const query = Object.fromEntries(url.searchParams.entries());

  // Header names lowercase, matching Node. _db.js reads `req.headers.cookie`
  // and `req.headers["x-edit-key"]` directly.
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;

  // readBody() in _db.js returns req.body unchanged when it is already an
  // object, so parsing here means no handler ever touches a stream.
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
    else body = {};
  }

  const req = { method: request.method, url: request.url, query, headers, body, cookies: {} };

  let resolve;
  const done = new Promise((r) => { resolve = r; });
  let status = 200, sent = false;
  const out = new Headers();

  const res = {
    setHeader(k, v) {
      // Set-Cookie is the one header that may legitimately repeat.
      if (String(k).toLowerCase() === "set-cookie") out.append(k, v);
      else out.set(k, v);
      return res;
    },
    getHeader(k) { return out.get(k); },
    status(code) { status = code; return res; },
    send(payload) {
      if (sent) return res;                 // write-once; see the note above
      sent = true;
      resolve(new Response(payload ?? null, { status, headers: out }));
      return res;
    },
    json(obj) { 
      if (!out.has("Content-Type")) out.set("Content-Type", "application/json; charset=utf-8");
      return res.send(JSON.stringify(obj));
    },
    end(payload) { return res.send(payload ?? ""); },
  };

  // A handler that throws must not take the whole Worker down with it: the
  // static site and the other four routes are unaffected by one bad query.
  ctx.waitUntil?.(Promise.resolve());
  Promise.resolve()
    .then(() => handler(req, res))
    .catch((e) => {
      if (sent) return;
      sent = true;
      resolve(new Response(
        JSON.stringify({ ok: false, error: `unhandled: ${e && e.message ? e.message : e}` }),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }));
    });

  return done;
}
