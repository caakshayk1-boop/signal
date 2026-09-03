/**
 * watchdog.js — make the pipeline run even when GitHub's scheduler does not.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * GitHub Actions `schedule:` is best-effort and drops runs. On the morning
 * this was written it was Monday 07:19 UTC and daily_scan.yml — the workflow
 * that generates every signal and sends the Telegram alerts — had last run on
 * Saturday. Its 05:00 slot was skipped, and so were BOTH of its retries at
 * 05:30 and 06:00, because the retries are cron entries on the same scheduler
 * that just failed. Retrying a dropped cron with another cron is not a retry.
 *
 * The signal repo's own sync-data.yml missed its 06:40 slot the same morning,
 * which is why every mirrored feed on the site was 31 hours old.
 *
 * WHY A WORKER
 * ------------
 * Cloudflare's cron triggers are a scheduled invocation of a running service
 * rather than a queued job on a shared build fleet, and this Worker is already
 * deployed and already the thing serving the site the staleness shows up on.
 * It asks GitHub what actually ran, compares that against what should have,
 * and dispatches only the difference.
 *
 * WHY IT CANNOT DOUBLE-FIRE
 * -------------------------
 * A slot is only dispatched when the newest run of that workflow STARTED
 * before the slot did. The dispatch itself creates a run stamped after the
 * slot, so the next tick sees it and stands down. If GitHub's own scheduler
 * works, its run is likewise newer than the slot and nothing is dispatched.
 * The watchdog is therefore idle on a healthy day and invisible in the logs.
 */

import { db } from "./api/_db.js";

const API = "https://api.github.com";

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
const GRACE_MIN = 12;

const WATCH = [
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
      // 13:00 MYT — the operator's "signals opening" slot. 05:00 UTC is
      // 10:30 IST, an hour and a quarter into the NSE session, so the day has
      // a real range to score and there are still four hours to act in.
      { dow: [1, 2, 3, 4, 5], h: 5, m: 0, inputs: { slot: "midday" }, job: "scan_midday" },
      // 21:00 MYT — "closing, with all updates". 13:00 UTC is 18:30 IST, three
      // hours after the bell: every close is final and the ledger settles.
      { dow: [1, 2, 3, 4, 5], h: 13, m: 0, inputs: { slot: "eod" }, job: "scan_eod" },
      { dow: [6], h: 4, m: 0, inputs: { slot: "weekend" }, job: "scan_weekend" },
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
    why: "the morning and evening Telegram briefs",
    slots: [
      // 08:00 MYT.
      { dow: [1, 2, 3, 4, 5], h: 0, m: 0, inputs: { task: "brief_morning_catchup" }, job: "brief_morning" },
      // 21:00 MYT.
      { dow: [1, 2, 3, 4, 5], h: 13, m: 0, inputs: { task: "brief_evening_catchup" }, job: "brief_evening" },
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
function dueSlot(now, slots, graceMin = GRACE_MIN) {
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

/** When did a run that could plausibly have done the work last START?
 *
 *  A FAILED RUN USED TO SATISFY A SLOT. This asked for per_page=1 and took
 *  that run's created_at whatever became of it, so a run that errored in
 *  `Install dependencies` counted as the slot being covered and the watchdog
 *  stood down on a workflow that had done nothing at all.
 *
 *  A run still in flight DOES count — dispatching a second copy of a job that
 *  is running right now is the double-fire this whole file is built to avoid.
 *  Only a run that finished badly is discounted. */
async function lastRunAt(repo, file, token) {
  const r = await fetch(`${API}/repos/${repo}/actions/workflows/${file}/runs?per_page=10`,
    { headers: hdrs(token), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`runs ${r.status}`);
  const j = await r.json();
  for (const run of j.workflow_runs || []) {          // newest first
    const finished = run.status === "completed";
    if (!finished || run.conclusion === "success") return Date.parse(run.created_at);
  }
  return 0;
}

/** Did the WORK for this slot actually land in the ledger?
 *
 *  THE GAP THIS CLOSES. Everything above reasons about GitHub runs, and a run
 *  is not a scan. On 31 Aug all three midday crons for daily_scan.yml arrived
 *  hours late, were each told the clock had moved to `eod`, kept `midday`
 *  anyway, found midday already done and stood down under --once. Three runs
 *  started, all three went green, no scan happened, no alerts went out — and
 *  the watchdog saw three runs newer than the slot and reported health.
 *
 *  job_runs is the durable record of work COMPLETED: standalone_scan stamps
 *  `scan_<slot>` only after the engines have run, and daily_brief stamps
 *  `brief_<slot>` only after Telegram has accepted the message. `run_at` is
 *  UTC ISO, so comparing it against the slot needs no timezone reasoning —
 *  and it is strictly stronger than the date-string matching the Python
 *  readers do, because a scan stamped this morning cannot satisfy tonight's
 *  EOD slot.
 *
 *  Throws rather than returning false when the database will not answer. The
 *  caller falls back to the run-based check, so a Turso outage degrades this
 *  to the old behaviour instead of dispatching every job on every tick. */
async function workDoneSince(job, sinceMs) {
  const rs = await db().execute({
    sql: "SELECT run_at, status FROM job_runs WHERE job = ?",
    args: [job],
  });
  const row = (rs.rows || [])[0];
  if (!row) return { done: false, run_at: null, status: null };
  const status = row.status === null || row.status === undefined ? "" : String(row.status);
  const raw = row.run_at === null || row.run_at === undefined ? "" : String(row.run_at);
  const at = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  return {
    done: status === "ok" && Number.isFinite(at) && at >= sinceMs,
    run_at: raw || null,
    status,
  };
}

async function dispatch(repo, file, token, inputs) {
  const r = await fetch(`${API}/repos/${repo}/actions/workflows/${file}/dispatches`, {
    method: "POST",
    headers: { ...hdrs(token), "Content-Type": "application/json" },
    // `inputs` must be omitted entirely rather than sent as null — GitHub
    // rejects a null body field with a 422 rather than treating it as absent.
    body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
    signal: AbortSignal.timeout(10000),
  });
  // 204 is the documented success for this endpoint.
  if (r.status !== 204) throw new Error(`dispatch ${r.status} ${(await r.text()).slice(0, 120)}`);
}

/**
 * Inspect every watched workflow. `act` false reports without dispatching,
 * which is what the status route uses — a status endpoint that fires builds
 * as a side effect of being looked at is a trap.
 */
export async function runWatchdog(env, { act = true } = {}) {
  const token = env.GH_DISPATCH_TOKEN;
  const now = new Date();
  if (!token) {
    return { ok: false, at: now.toISOString(),
             error: "GH_DISPATCH_TOKEN is not set on this Worker, so nothing can be dispatched.",
             checked: [] };
  }

  const checked = [];
  for (const w of WATCH) {
    const grace = w.graceMin || GRACE_MIN;
    const due = dueSlot(now, w.slots, grace);
    const row = { repo: w.repo, workflow: w.file, why: w.why, grace_minutes: grace,
                  due_slot: due ? new Date(due.at).toISOString() : null,
                  dispatch_inputs: due && due.inputs ? due.inputs : null };
    try {
      const last = await lastRunAt(w.repo, w.file, token);
      row.last_run = last ? new Date(last).toISOString() : null;
      row.hours_since = last ? +((now - last) / 36e5).toFixed(1) : null;

      // A run newer than the slot is the WEAKEST evidence available, so it is
      // only the answer when nothing better exists.
      let missed = !!(due && last < due.at);
      row.checked_by = "run_started";

      if (due && due.job) {
        try {
          const work = await workDoneSince(due.job, due.at);
          row.job = due.job;
          row.job_run_at = work.run_at;
          row.job_status = work.status;
          missed = !work.done;
          row.checked_by = "job_runs";
        } catch (e) {
          // Degrade to the run-based answer rather than dispatching blind on
          // every tick for as long as the database is unreachable.
          row.verify_error = String((e && e.message) || e);
        }
      }

      row.missed = missed;

      /* ── THE RUNNER DECIDES WHETHER TO ACT, NOT THIS FILE ─────────────────
       *
       * There was a suppression here. It inferred from "a run completed after
       * the slot and the work is still unrecorded" that the runner had
       * considered the slot and refused, so dispatching again would repeat the
       * refusal. The inference is sound and the guard was still wrong.
       *
       * It cannot tell one run from another. A hand-dispatched momentum scan,
       * a drifted cron that ran a different slot, any run at all after the slot
       * — each looked like a refusal. Measured live on 3 Sep it was suppressing
       * BOTH daily_scan's end-of-day slot and scheduled_tasks' evening brief at
       * the same time: two pieces of real work, neither dispatched, on the day
       * the operator reported no signals firing.
       *
       * The thing it was protecting against — a dispatch every twenty minutes
       * into a job that keeps declining — is noise. The thing it caused is
       * missing work. Those are not the same size of mistake.
       *
       * AND THE PROTECTION WAS ALREADY THERE, one layer down. standalone_scan
       * keeps --once, which allows one completed scan per slot per IST day;
       * daily_brief's catch-up consults job_runs for a delivery stamped today
       * in MYT. Both are idempotent and both are authoritative. A dispatch into
       * either is a no-op when the work is done. Idempotence belongs in the
       * thing that does the work, not in a guess made from outside it.
       *
       * `stalled` is still computed and still reported, because a slot the
       * runner genuinely keeps refusing is worth seeing on /api/pipeline. It
       * no longer decides anything. */
      const STALL_WINDOW_MIN = 120;
      row.stalled = !!(row.missed && due && last && last >= due.at
                       && last <= due.at + STALL_WINDOW_MIN * 60000);
      if (row.stalled) {
        row.note = "a run completed shortly after this slot without recording the "
                 + "work — dispatching anyway, because --once and the brief's own "
                 + "guard make a duplicate a no-op";
      }
      if (row.missed && act) {
        await dispatch(w.repo, w.file, token, due.inputs);
        row.dispatched = true;
      }
    } catch (e) {
      row.error = String((e && e.message) || e);
    }
    checked.push(row);
  }
  // Per-workflow now — reporting one number here would misdescribe every row
  // that overrides it.
  return { ok: true, at: now.toISOString(), default_grace_minutes: GRACE_MIN, checked };
}
