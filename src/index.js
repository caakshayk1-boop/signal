/**
 * Signal — one Worker, five API routes, one static site.
 *
 * WHY THIS IS ONE WORKER AND NOT TWELVE FUNCTIONS
 * -----------------------------------------------
 * The previous home of this site sat exactly on a 12-serverless-function cap.
 * A thirteenth route file did not warn, did not fail the build and did not
 * appear in any log — it silently broke the entire deployment, twice. Three
 * separate features (?px, ?wallet, ?series) were consequently crammed onto one
 * route as query parameters, purely to avoid creating a file.
 *
 * A Worker has no such cap. Routing is a switch below; adding a sixth endpoint
 * costs a line. The query-parameter contortions in api/signals.js are left
 * exactly as they are — they work, they are tested, and rewriting them here
 * would mean re-testing them for no user-visible gain — but nothing new needs
 * to be built that way.
 *
 * ROUTING ORDER matters: /api/* is claimed first, everything else falls
 * through to the static assets binding, which serves index.html for a bare "/"
 * and 404s anything it does not have.
 */
import { runVercelHandler } from "./adapter.js";
import { providerInfo } from "./api/_providers.js";
import ticker from "./api/ticker.js";
import signals from "./api/signals.js";
import stats from "./api/stats.js";
import markets from "./api/markets.js";
import flows from "./api/flows.js";
import calendar from "./api/calendar.js";
import { runWatchdog } from "./watchdog.js";
import subscribe from "./api/subscribe.js";

const ROUTES = {
  "/api/ticker": ticker,
  "/api/signals": signals,
  "/api/stats": stats,
  "/api/markets": markets,
  "/api/flows": flows,
  "/api/calendar": calendar,
  "/api/subscribe": subscribe,
};

/* The handlers read credentials from process.env, the way they did on Vercel.
 * Workers hand them to fetch() as `env` instead. Rather than thread an extra
 * argument through five files, the bindings are mirrored onto process.env on
 * the first request — nodejs_compat provides the object, and a Worker isolate
 * serves one account, so there is nothing to leak between tenants.
 *
 * Done once, not per request: process.env survives for the life of the
 * isolate, and reassigning it on every request would be work for nothing. */
let envMirrored = false;
function mirrorEnv(env) {
  if (envMirrored) return;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") process.env[k] = v;
  }
  envMirrored = true;
}

/* A health endpoint that does NOT touch the database. Its job is to answer
 * "is the Worker up" separately from "is Turso up", because when the site is
 * broken those are the two different answers you need to tell apart. */
function health(env) {
  return Response.json({
    ok: true,
    service: "signal",
    turso_configured: Boolean(env.TURSO_URL && env.TURSO_TOKEN),
    // The Data Sources page reads this rather than hardcoding a provider name,
    // so the page cannot claim a feed the Worker is not actually using.
    provider: providerInfo(),
    routes: Object.keys(ROUTES),
    at: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}

export default {
  /* CRON ENTRY POINT.
   *
   * Cloudflare invokes this on the schedule in wrangler.jsonc. It exists
   * because GitHub Actions' scheduler drops runs and its retries are more
   * cron entries on the same scheduler — so a bad morning skips the scan and
   * both of its retries, and nothing sends the day's signals.
   *
   * waitUntil, not await-and-return: the platform is entitled to end the
   * invocation as soon as this resolves, and the dispatch calls must be
   * allowed to finish.
   */
  async scheduled(event, env, ctx) {
    mirrorEnv(env);
    ctx.waitUntil(runWatchdog(env).then((r) => {
      // One line per tick in the observability log, and only when it acted —
      // a watchdog that logs "nothing to do" every twenty minutes buries the
      // one line that matters.
      const acted = (r.checked || []).filter((c) => c.dispatched || c.error);
      if (acted.length) console.log("watchdog", JSON.stringify(acted));
    }).catch((e) => console.log("watchdog failed", String(e))));
  },

  async fetch(request, env, ctx) {
    mirrorEnv(env);
    const url = new URL(request.url);

    if (url.pathname === "/api/health") return health(env);
    // Read-only on purpose: a status endpoint that starts builds because
    // someone looked at it is a trap. The cron below is what acts.
    if (url.pathname === "/api/pipeline") {
      const r = await runWatchdog(env, { act: false });
      return new Response(JSON.stringify(r, null, 2), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const handler = ROUTES[url.pathname];
    if (handler) {
      // A route the site never calls with a body still must not accept one
      // silently; the handlers do their own method checks and answer 405.
      return runVercelHandler(handler, request, ctx);
    }

    // Anything under /api that is not a route is a 404 in JSON, not an HTML
    // page — a fetch() that gets index.html back reports "Unexpected token <"
    // and sends you looking in the wrong file.
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: `no route ${url.pathname}` }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
