/**
 * watchdog_schedule.js — WHAT should have run, WHEN, and whether it is overdue.
 *
 * Split out of watchdog.js so it can be IMPORTED BY A TEST. That file opens
 * with `import { db } from "./api/_db.js"`, which reaches @libsql/client, and
 * test/guard.mjs runs in deploy.yml BEFORE `npm ci` — deliberately, because a
 * static guard that needs an install is not a fast fail. Importing the
 * watchdog from the guard therefore took main's deploy down with
 * ERR_MODULE_NOT_FOUND, at the first step, in under a second.
 *
 * The split is not a workaround for that. The schedule is a table of times and
 * dueSlot() is arithmetic over a clock; neither has any business reaching a
 * database, and the only reason they did was living in the same file as the
 * code that dispatches. What is here has ZERO imports, and a guard check keeps
 * it that way — the moment it grows one, the test that exercises it stops
 * being runnable before an install and the same deploy breaks again.
 *
 * watchdog.js re-exports all three, so nothing that imported them from there
 * has to change.
 */

/* Slots are UTC, because that is the clock both GitHub Actions and Cloudflare
 * cron run on. `dow` is JS getUTCDay(): 0 Sunday … 6 Saturday.
 *
 * GRACE is deliberately generous. Scheduled runs on these repos land 1.5–3h
 * late when they land at all, and dispatching a duplicate of a run that was
 * merely slow is worse than waiting: the scan writes to a ledger and sends
 * Telegram messages, so a double-run is a double alert. */
/* WHY THIS IS NOW 12 MINUTES AND NOT 75.
 *
 * 75 was the right number while a dispatch could duplicate real work: the scan
 * writes to a ledger and both jobs send Telegram messages, so firing a second
 * copy of a run that was merely slow is worse than waiting for it.
 *
 * That is no longer the trade. Every slot below now dispatches a form of the
 * job that STANDS DOWN when the work is already done for the day —
 * `brief_*_catchup` consults job_runs for a delivery stamped today in MYT, and
 * daily_scan keeps its `--once` guard on a dispatched slot (it did not; see
 * the `force` input added to that workflow). A duplicate dispatch is therefore
 * a no-op that costs one database read.
 *
 * Once duplicates are free, waiting is pure cost, and the cost is the entire
 * complaint: the brief is supposed to land at 08:00 MYT and has been arriving
 * at 14:14. Twelve minutes is one Cloudflare tick past the slot — close enough
 * that GitHub's own scheduler still wins on a healthy morning, late enough
 * that it is not racing it for no reason. */
export const GRACE_MIN = 12;

/* EXPORTED FOR THE GUARD, NOT FOR THE WORKER. Nothing else imports these;
 * src/index.js takes runWatchdog() alone. Until this repo's guard started
 * reading them, the file that REPAIRS every dropped scheduled job in both
 * repos had no test of any kind — not of its inventory, not of its grace, not
 * of dueSlot, which is the one function whose arithmetic decides whether a
 * missed 20:00 scan is noticed at all. */
export const WATCH = [
  {
    /* THE TOP OF THE CHAIN, AND IT WAS THE ONE THING UNWATCHED.
     *
     * Every feed the other three entries move around is produced here. If this
     * build drops, the sync faithfully mirrors yesterday, the site goes stale,
     * and nothing repairs it — the original outage with a different cause.
     *
     * ITS GRACE IS THREE HOURS, NOT TWELVE MINUTES, AND THAT IS DELIBERATE.
     * The rule that makes a short grace safe elsewhere is that a duplicate
     * dispatch is a no-op: the briefs consult job_runs, the scan keeps
     * --once. This build has no such guard. It runs for nine minutes, commits
     * docs/index.html and publishes, so two overlapping copies race on the
     * commit. Twelve minutes here would fire a second build almost every day,
     * because this cron genuinely does land late — 23:44Z on 1 Sep, 00:57Z on
     * 31 Aug, against a 22:00Z slot.
     *
     * Three hours is past the worst observed drift and still finishes before
     * the 01:30 sync collects it, so a dropped build is repaired inside the
     * same morning rather than waiting a day. */
    repo: "caakshayk1-boop/trading-dashboard",
    file: "newspaper.yml",
    why: "the daily build every feed comes from",
    graceMin: 180,
    slots: [{ dow: [0, 1, 2, 3, 4, 5, 6], h: 22, m: 0 }],
  },
  {
    repo: "caakshayk1-boop/trading-dashboard",
    file: "daily_scan.yml",
    why: "signals and Telegram alerts",
    slots: [
      /* 20:00 MYT — the day's only weekday scan, on the operator's
       * instruction: "needed only 2 times a day - morning 8am MYT & night
       * 8pm MYT". 12:00 UTC is 17:30 IST, two hours after the bell, so every
       * close is final and the ledger settles.
       *
       * THE 13:00 MYT "SIGNALS OPENING" SLOT IS GONE FROM HERE TOO, AND HAD
       * TO BE. This watchdog does not read the crons — it holds its own copy
       * of the schedule. Removing the cron and leaving the slot would not have
       * stopped the midday scan; it would have MOVED it here, dispatched every
       * weekday at 05:12 UTC by the very mechanism built to repair drops,
       * with no cron anywhere to explain why. */
      { dow: [1, 2, 3, 4, 5], h: 12, m: 0, inputs: { slot: "eod" }, job: "scan_eod" },
      { dow: [6], h: 4, m: 0, inputs: { slot: "weekend" }, job: "scan_weekend" },
      /* 06:00 UTC — 11:30 IST, two hours into the NSE session. The `midday`
       * slot, added to daily_scan.yml with the intraday engine, which until
       * then had a cron nowhere and therefore had never run.
       *
       * THE PARAGRAPH ABOVE IS WHY THIS LINE HAS TO EXIST. Removing a cron
       * there and leaving a slot here dispatches work no cron explains. The
       * mirror image is this: ADDING a cron there and not adding a slot here
       * leaves the one scan of the day that runs while the market is open
       * with no watchdog at all — and this is the repo whose scheduler was
       * measured dropping runs and both their retries.
       *
       * 11:30 was chosen over 11:45 because a dispatch that drifts three
       * hours must still land inside the session: 14:30 IST worst case
       * against a 15:30 close. standalone_scan refuses the slot outright
       * after 14:30 IST rather than reporting a stale session as a live one,
       * so a badly drifted dispatch files nothing instead of filing a lie.
       *
       * `scan_midday` is _scan_job("midday") in standalone_scan.py. Per slot,
       * not per day, so a completed midday can never satisfy a missing eod. */
      { dow: [1, 2, 3, 4, 5], h: 6, m: 0, inputs: { slot: "midday" }, job: "scan_midday" },
    ],
  },
  {
    /* THE BRIEF WAS THE ONE JOB NOTHING WATCHED.
     *
     * It is also the one the operator sees every morning, and on 1 Sep its
     * 22:43 UTC cron produced no run at all — the brief went out at 14:14 MYT
     * off a catch-up, six hours past its 08:00 slot. The watchdog knew nothing
     * about it because this entry did not exist.
     *
     * The dispatched task is the CATCH-UP variant on purpose. Its only
     * difference from the primary is that it asks job_runs whether this slot
     * already went out today in MYT and stands down if it did — which is
     * exactly the behaviour a second trigger must have. */
    repo: "caakshayk1-boop/trading-dashboard",
    file: "scheduled_tasks.yml",
    why: "the morning and night Telegram briefs",
    slots: [
      // 08:00 MYT.
      { dow: [1, 2, 3, 4, 5], h: 0, m: 0, inputs: { task: "brief_morning_catchup" }, job: "brief_morning" },
      // 20:00 MYT — moved from 21:00 with the cron it watches.
      { dow: [1, 2, 3, 4, 5], h: 12, m: 0, inputs: { task: "brief_evening_catchup" }, job: "brief_evening" },
    ],
  },
  {
    repo: "caakshayk1-boop/signal",
    file: "sync-data.yml",
    why: "the mirrored feeds this site renders",
    slots: [
      // 09:30 MYT — the first collection after the newspaper finishes. This is
      // the slot that matters: without it the site served yesterday's edition
      // through the entire Malaysian morning.
      { dow: [0, 1, 2, 3, 4, 5, 6], h: 1, m: 30 },
      { dow: [0, 1, 2, 3, 4, 5, 6], h: 6, m: 40 },
      { dow: [0, 1, 2, 3, 4, 5, 6], h: 12, m: 40 },
    ],
  },
];

const hdrs = (token) => ({
  "Authorization": `Bearer ${token}`,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  // GitHub rejects requests with no User-Agent.
  "User-Agent": "signal-watchdog",
});

/** The most recent slot that has already passed its grace period, WITH the
 *  dispatch inputs that slot needs.
 *
 *  It used to return a bare timestamp. That was enough while every dispatch
 *  was "run this workflow" with no arguments — and that was the bug: a
 *  workflow_dispatch carries no `github.event.schedule`, so scheduled_tasks.yml
 *  matched no arm of its own cron table and resolved to TASK=none. The
 *  watchdog would have fired it, GitHub would have reported success, and
 *  nothing whatsoever would have been sent. The slot has to say what to run. */
export function dueSlot(now, slots, graceMin = GRACE_MIN) {
  let best = null;
  // Look back two days: a Friday-evening slot can still be the newest one on
  // a Sunday, and reporting "nothing due" then would hide a real outage.
  for (let back = 0; back <= 2; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    for (const s of slots) {
      if (!s.dow.includes(d.getUTCDay())) continue;
      const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.h, s.m, 0);
      if (at + graceMin * 60000 > now.getTime()) continue;   // not due yet
      if (!best || at > best.at) best = { at, inputs: s.inputs || null, job: s.job || null };
    }
  }
  return best;
}
