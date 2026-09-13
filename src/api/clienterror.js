// POST /api/client-error — the thing that was missing when the front page broke.
//
// WHY THIS EXISTS
// ---------------
// On 2026-09-05 the Today route threw on every single load — CACHED() is
// synchronous and something called .then on it — and the page rendered its
// error panel instead of itself. The deploy gate did not catch it, because the
// gate's error listener only ever visited /markets and /brief. Nothing else
// was watching. It was found by Akshay opening the site.
//
// Cloudflare observability records what the WORKER does. It cannot see a
// TypeError in a reader's browser, which is where every failure on this site
// actually happens: the whole page is client-rendered over static JSON.
//
// So this is the smallest thing that closes that gap. No vendor, no new
// secret, no third-party script on a page that ships none. It writes to the
// Turso database that already backs the ledger, and it logs to the Worker's
// own stream so a spike is visible in `wrangler tail` without a query.
//
// WHAT IT DELIBERATELY DOES NOT COLLECT
// -------------------------------------
// No IP, no cookie, no identifier of any kind, no full URL query string. An
// error report is a stack trace and a route, and anything past that is
// surveillance dressed as diagnostics. The route is enough to reproduce it.
//
// ABUSE IS THE DESIGN PROBLEM, because this is unauthenticated by necessity —
// a page too broken to run cannot authenticate. Handled by:
//   · hard length caps on every field, enforced before anything is stored
//   · a per-fingerprint hourly cap in SQL, so one broken page cannot fill the
//     table (in-process counters are theatre across isolates)
//   · the client caps itself at 5 per session and dedupes by message
import { db, str, json, fail, readBody } from "./_db.js";

const MAX_MSG = 500;
const MAX_STACK = 2000;
const MAX_ROUTE = 120;
const MAX_UA = 200;
const MAX_PER_FINGERPRINT_PER_HOUR = 20;

let ensured = false;
async function ensure(c) {
  if (ensured) return;
  await c.execute(`CREATE TABLE IF NOT EXISTS client_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    route TEXT,
    message TEXT NOT NULL,
    stack TEXT,
    ua TEXT,
    build TEXT,
    fingerprint TEXT
  )`);
  await c.execute(`CREATE INDEX IF NOT EXISTS client_errors_at ON client_errors(at)`);
  ensured = true;
}

export default async function clientError(req, res) {
  if (req.method !== "POST") return fail(res, 405, "POST only");

  let body;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, "unreadable body");
  }

  const message = str(body.message).slice(0, MAX_MSG).trim();
  if (!message) return fail(res, 400, "no message");

  const route = str(body.route).slice(0, MAX_ROUTE);
  const stack = str(body.stack).slice(0, MAX_STACK);
  const build = str(body.build).slice(0, 64);
  const ua = str(req.headers["user-agent"]).slice(0, MAX_UA);

  // A coarse bucket, not an identity: the same browser reporting the same
  // fault clusters together, and two different readers hitting one bug still
  // count separately enough to show a spike. Nothing here identifies a person.
  const fingerprint = `${route}|${message}`.slice(0, 160);

  try {
    const c = db();
    await ensure(c);

    const seen = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM client_errors
            WHERE fingerprint = ? AND at > datetime('now','-1 hour')`,
      args: [fingerprint],
    });
    if (Number(seen.rows?.[0]?.n || 0) >= MAX_PER_FINGERPRINT_PER_HOUR) {
      // Not an error to the caller: the report WAS received, it is simply
      // already well known. Telling a broken page it failed to report would
      // make it retry.
      return json(res, 200, { ok: true, recorded: false, reason: "already reported this hour" });
    }

    await c.execute({
      sql: `INSERT INTO client_errors (at, route, message, stack, ua, build, fingerprint)
            VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)`,
      args: [route, message, stack, ua, build, fingerprint],
    });

    // Into the Worker's own log stream as well, so `wrangler tail` shows a
    // spike live without anyone writing a query first.
    console.error(`[client] ${route || "?"} :: ${message}`);

    return json(res, 200, { ok: true, recorded: true });
  } catch (e) {
    // A reporting endpoint that 500s teaches the page to retry into a wall.
    console.error(`[client-error] store failed: ${e && e.message}`);
    return json(res, 200, { ok: true, recorded: false, reason: "store unavailable" });
  }
}
