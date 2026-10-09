import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createScanWatch } from "../src/scan_watch.js";

const due = "2026-10-08T12:00:00Z";
const overdue = Date.parse(due) + 6 * 3600000 + 1;
const payload = { status: "research", next_scan_due: due, published_at: "2026-10-07T20:00:00Z" };
const broken = { ok: true, checked: [{ repo: "owner/repo", workflow: "daily_scan.yml", broken: true, failures_since_slot: 3, error: "must not be forwarded" }] };

// In-memory fake models SQLite's atomic uniqueness constraint, including a
// yield before the claim so overlapping ticks really do race for one key.
function database() {
  const rows = new Map();
  return { rows, async execute(statement) {
    await Promise.resolve();
    if (typeof statement === "string") {
      assert.match(statement, /CREATE TABLE IF NOT EXISTS ops_alerts/);
      assert.match(statement, /PRIMARY KEY \(kind, day\)/);
      return { rows: [] };
    }
    assert.match(statement.sql, /ON CONFLICT\(kind, day\) DO NOTHING RETURNING kind/);
    const [kind, day, claimed_at] = statement.args;
    const key = `${kind}/${day}`;
    if (rows.has(key)) return { rows: [] };
    rows.set(key, { kind, day, claimed_at });
    return { rows: [{ kind }] };
  } };
}

function fixture({ client = database(), body = payload, clock = overdue, send, asset } = {}) {
  const messages = [], paths = [];
  const state = { body, clock };
  const env = {
    TELEGRAM_BOT_TOKEN: "fake-telegram-token",
    TELEGRAM_CHAT_ID: "fake-chat",
    TURSO_TOKEN: "fake-database-token",
    ASSETS: { async fetch(request) {
      paths.push(new URL(request.url).pathname);
      if (asset) return asset();
      return Response.json(state.body);
    } },
  };
  const dependencies = {
    database: () => client,
    now: () => state.clock,
    fallback: new Set(), local: new Map(),
    fetch: async (url, options) => {
      assert.equal(url, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
      assert.equal(options.method, "POST");
      const message = JSON.parse(options.body);
      assert.equal(message.chat_id, env.TELEGRAM_CHAT_ID);
      assert.equal(message.parse_mode, undefined);
      assert.ok(message.text.length < 4096);
      messages.push(message);
      return send ? send(message) : Response.json({ ok: true });
    },
  };
  return { ...createScanWatch(dependencies), env, messages, paths, client, state, dependencies };
}

test("deployed asset only, plain overdue alert, claim before send and duplicate ticks", async () => {
  const client = database();
  const f = fixture({ client, send: () => {
    assert.equal(client.rows.size, 1, "claim must exist before Telegram");
    return Response.json({ ok: true });
  } });
  assert.equal((await f.checkScanFreshness(f.env)).sent, true);
  assert.equal((await f.checkScanFreshness(f.env)).sent, false);
  assert.deepEqual(f.paths, ["/signal_v2.json", "/signal_v2.json"]);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /Due: 2026-10-08T12:00:00.000Z/);
  assert.match(f.messages[0].text, /Published: 2026-10-07T20:00:00.000Z/);
  assert.match(f.messages[0].text, /Status: research/);
  assert.match(f.messages[0].text, /eod.*sync/s);
});

test("concurrent independent isolates use one atomic daily claim", async () => {
  const client = database();
  const workers = Array.from({ length: 25 }, () => fixture({ client }));
  const results = await Promise.all(workers.map(f => f.checkScanFreshness(f.env)));
  assert.equal(results.filter(r => r.sent).length, 1);
  assert.equal(workers.reduce((sum, f) => sum + f.messages.length, 0), 1);
  assert.equal(client.rows.size, 1);
});

test("actual local SQLite enforces the Turso claim SQL and preserves prior claims", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    const workers = Array.from({ length: 8 }, () => fixture({ client }));
    const results = await Promise.all(workers.map(f => f.checkScanFreshness(f.env)));
    assert.equal(results.filter(r => r.sent).length, 1);
    assert.equal(results.find(r => r.sent).dedupe, "database");
    const rows = (await client.execute("SELECT kind, day, claimed_at FROM ops_alerts")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "scan_overdue");
    assert.equal(rows[0].day, "2026-10-08");
    const fresh = fixture({ client });
    assert.equal((await fresh.checkScanFreshness(fresh.env)).sent, false);
  } finally { client.close(); }
});

test("pause, missing/unparseable dates and six-hour boundary are silent", async () => {
  for (const body of [null, {}, { ...payload, status: "paused" },
    ...[undefined, null, "", "not-a-date", 0, {}, true].map(next_scan_due => ({ ...payload, next_scan_due }))]) {
    const f = fixture({ body });
    assert.equal((await f.checkScanFreshness(f.env)).sent, false);
    assert.equal(f.messages.length, 0);
    assert.equal(f.client.rows.size, 0);
  }
  for (const delta of [-1, 0, 1]) {
    const f = fixture({ clock: overdue - 1 + delta });
    assert.equal((await f.checkScanFreshness(f.env)).sent, delta > 0);
  }
});

test("UTC midnight renews durable kind/day claim even when local date differs", async () => {
  const f = fixture({ clock: new Date("2026-10-09T05:29:59+05:30") });
  assert.equal((await f.checkScanFreshness(f.env)).sent, true);
  f.state.clock = new Date("2026-10-09T05:30:00+05:30");
  assert.equal((await f.checkScanFreshness(f.env)).sent, true);
  assert.deepEqual([...f.client.rows.values()].map(r => r.day), ["2026-10-08", "2026-10-09"]);
});

test("watchdog !ok inert; only checked.broken alerts; independent kind claims", async () => {
  const f = fixture();
  for (const result of [undefined, { ...broken, ok: false }, { ok: true },
    { ok: true, checked: [{ error: "failed", stalled: true, missed: true, broken: false }] }]) {
    assert.equal((await f.checkWatchdogHealth(f.env, result)).sent, false);
  }
  assert.equal((await f.checkWatchdogHealth(f.env, broken)).sent, true);
  assert.equal((await f.checkWatchdogHealth(f.env, broken)).sent, false);
  assert.equal((await f.checkScanFreshness(f.env)).sent, true);
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[0].text, /owner\/repo\/daily_scan.yml/);
  assert.doesNotMatch(f.messages[0].text, /must not be forwarded/);
  assert.equal(f.client.rows.size, 2);
});

test("DB outage fallback is once per kind per isolate lifetime, even concurrently and across days", async () => {
  const f = fixture({ client: { execute: async () => { throw new Error("fake-database-token"); } } });
  const results = await Promise.all(Array.from({ length: 20 }, () => f.checkScanFreshness(f.env)));
  assert.equal(results.filter(r => r.sent).length, 1);
  assert.equal(results.find(r => r.sent).dedupe, "isolate");
  f.state.clock += 86400000;
  assert.equal((await f.checkScanFreshness(f.env)).sent, false);
  assert.equal((await f.checkWatchdogHealth(f.env, broken)).sent, true);
  assert.equal((await f.checkWatchdogHealth(f.env, broken)).sent, false);
  assert.equal(f.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(results), /fake-database-token/);
});

test("ambiguous/rejected sends retain durable claims and never retry automatically", async () => {
  for (const send of [
    async () => { throw new Error("https://api.telegram.org/botfake-telegram-token/sendMessage"); },
    async () => new Response("fake-telegram-token", { status: 500 }),
    async () => Response.json({ ok: false, description: "fake-telegram-token" }),
    async () => new Response("invalid JSON fake-telegram-token"),
  ]) {
    const f = fixture({ send });
    const first = await f.checkScanFreshness(f.env);
    assert.equal(first.ok, false);
    assert.doesNotMatch(JSON.stringify(first), /fake-telegram-token/);
    // Simulate a new isolate, proving suppression comes from durable state.
    const second = fixture({ client: f.client });
    assert.equal((await second.checkScanFreshness(second.env)).sent, false);
    assert.equal(f.messages.length + second.messages.length, 1);
  }
});

test("ambiguous fallback sends stay consumed after midnight and DB recovery", async () => {
  const healthy = database();
  let online = false;
  const f = fixture({
    client: { execute: statement => {
      if (!online) throw new Error("DB unreachable fake-database-token");
      return healthy.execute(statement);
    } },
    send: () => { throw new Error("timeout fake-telegram-token"); },
  });
  assert.equal((await f.checkScanFreshness(f.env)).error, "telegram_delivery_unconfirmed");
  assert.equal((await f.checkScanFreshness(f.env)).sent, false);
  online = true;
  assert.equal((await f.checkScanFreshness(f.env)).sent, false);
  online = false;
  f.state.clock += 86400000;
  assert.equal((await f.checkScanFreshness(f.env)).sent, false);
  assert.equal(f.messages.length, 1);
});

test("asset failure isolates watchdog; Telegram failure isolates alert kinds; secrets are redacted", async () => {
  for (const asset of [
    () => { throw new Error("fake-telegram-token"); },
    () => new Response("fake-telegram-token", { status: 404 }),
    () => new Response("invalid json fake-database-token"),
  ]) {
    const f = fixture({ asset });
    const result = await f.checkScanFreshness(f.env);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /fake-/);
    assert.equal((await f.checkWatchdogHealth(f.env, broken)).sent, true);
  }
  const f = fixture({ send: message => {
    if (message.text.startsWith("Signal scan")) throw new Error("fake-telegram-token");
    return Response.json({ ok: true });
  } });
  assert.equal((await f.checkScanFreshness(f.env)).ok, false);
  const hostile = { ok: true, checked: [{ ...broken.checked[0], workflow: "fake-telegram-token", repo: "fake-database-token" }] };
  assert.equal((await f.checkWatchdogHealth(f.env, hostile)).sent, true);
  assert.doesNotMatch(f.messages[1].text, /fake-/);
});

test("missing Telegram config does not consume a daily claim", async () => {
  const f = fixture();
  assert.equal((await f.checkScanFreshness({ ...f.env, TELEGRAM_BOT_TOKEN: "" })).reason, "telegram_not_configured");
  assert.equal(f.client.rows.size, 0);
  assert.equal(f.messages.length, 0);
  assert.equal((await f.checkScanFreshness(f.env)).sent, true);
});
