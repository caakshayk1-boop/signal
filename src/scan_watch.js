// Observability only: called by the existing Worker tick, never a scheduler.
import { db } from "./api/_db.js";

const SIX_HOURS = 6 * 60 * 60 * 1000;
// A database outage cannot turn each tick (or UTC midnight) into another page.
// These claims deliberately survive failed/ambiguous Telegram delivery.
const fallbackClaims = new Set();
const localClaims = new Map();

const skip = (reason) => ({ ok: true, sent: false, reason });
const failed = (error) => ({ ok: false, sent: false, error });
const date = (value) => typeof value === "string" && value.trim()
  ? Date.parse(value) : NaN;

/** Injectable I/O and isolated claim state for offline tests. Production uses
 * the shared Turso client (mirrored env), ASSETS binding and Telegram env names.
 * Only INSERT ... RETURNING grants a durable claim; no read-then-write race.
 */
export function createScanWatch({
  database = db,
  fetch: sendFetch = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  fallback = fallbackClaims,
  local = localClaims,
} = {}) {
  function safe(value, env, limit = 150) {
    let text = typeof value === "string" ? value : "unknown";
    for (const [key, secret] of Object.entries(env)) {
      if (/(TOKEN|SECRET|KEY|CHAT_ID|TURSO_URL)$/.test(key) && typeof secret === "string" && secret) {
        text = text.split(secret).join("[redacted]");
      }
    }
    return text.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, limit);
  }

  async function alert(env, kind, text, at) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return skip("telegram_not_configured");
    const day = new Date(at).toISOString().slice(0, 10);
    if (local.get(kind) === day) return skip("already_claimed");
    let dedupe = "database";
    try {
      const client = database();
      await client.execute(`CREATE TABLE IF NOT EXISTS ops_alerts (
        kind TEXT NOT NULL,
        day TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (kind, day)
      )`);
      const result = await client.execute({
        sql: "INSERT INTO ops_alerts (kind, day, claimed_at) VALUES (?, ?, ?) ON CONFLICT(kind, day) DO NOTHING RETURNING kind",
        args: [kind, day, new Date(at).toISOString()],
      });
      if (!result.rows?.length) return skip("already_claimed");
    } catch {
      // Never include driver errors: they can contain credentials/URLs. This
      // fallback is per isolate, not a cross-isolate guarantee during outage.
      if (fallback.has(kind)) return skip("fallback_already_claimed");
      fallback.add(kind); // synchronous before any network send
      dedupe = "isolate";
    }
    // A concurrent successful DB claim and failed DB request in this isolate
    // must still result in only one send. Remember normal sends for fallback.
    if (local.get(kind) === day) return skip("already_claimed");
    local.set(kind, day);
    fallback.add(kind);
    try {
      const response = await sendFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
        signal: AbortSignal.timeout(10000),
      });
      // Plain text; no Markdown retry, and no replay on timeouts or a lost
      // response. The persisted row means 'attempt claimed', not 'delivered'.
      if (!response.ok) return { ...failed("telegram_rejected"), kind, dedupe };
      if ((await response.json()).ok !== true) return { ...failed("telegram_rejected"), kind, dedupe };
      return { ok: true, sent: true, kind, dedupe };
    } catch {
      return { ...failed("telegram_delivery_unconfirmed"), kind, dedupe };
    }
  }

  async function checkScanFreshness(env) {
    try {
      // A dummy origin is required by Request; ASSETS resolves the deployed
      // path directly. No public HTTP or raw-GitHub fallback may mask staleness.
      const response = await env.ASSETS.fetch(new Request("https://signal.internal/signal_v2.json"));
      if (!response.ok) return failed("scan_asset_unavailable");
      const payload = await response.json();
      if (payload?.status === "paused") return skip("paused");
      const due = date(payload?.next_scan_due);
      if (!Number.isFinite(due)) return skip("no_valid_due_date");
      const at = +now();
      if (!Number.isFinite(at)) return failed("invalid_clock");
      if (at - due <= SIX_HOURS) return skip("within_grace");
      const published = date(payload?.published_at);
      return await alert(env, "scan_overdue", [
        "Signal scan overdue (more than 6 hours).",
        `Due: ${new Date(due).toISOString()}`,
        `Published: ${Number.isFinite(published) ? new Date(published).toISOString() : "unknown"}`,
        `Status: ${safe(payload?.status, env, 80)}`,
        "Check the eod scan and sync-data workflows: run the eod scan if missing, then sync the deployed signal_v2.json. Inspect failures before retrying.",
      ].join("\n"), at);
    } catch {
      return failed("scan_check_failed");
    }
  }

  async function checkWatchdogHealth(env, result) {
    try {
      if (!result?.ok) return skip("watchdog_inactive");
      const broken = (Array.isArray(result.checked) ? result.checked : []).filter(row => row?.broken === true);
      if (!broken.length) return skip("watchdog_healthy");
      const at = +now();
      if (!Number.isFinite(at)) return failed("invalid_clock");
      return await alert(env, "watchdog_broken", [
        `Signal watchdog: ${broken.length} broken workflow(s); automatic retries have stopped.`,
        ...broken.slice(0, 8).map(row => `${safe(row.repo, env)}/${safe(row.workflow, env)} — failures since slot: ${Number.isSafeInteger(row.failures_since_slot) ? row.failures_since_slot : "unknown"}`),
        ...(broken.length > 8 ? [`Plus ${broken.length - 8} more; inspect /api/pipeline.`] : []),
        "Inspect the failing workflow logs and fix the cause. One green run resumes watchdog retries. For missing signals, check eod and sync-data.",
      ].join("\n"), at);
    } catch {
      return failed("watchdog_check_failed");
    }
  }

  return { checkScanFreshness, checkWatchdogHealth };
}

export const { checkScanFreshness, checkWatchdogHealth } = createScanWatch();
