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

/* The schedule, the grace and the due-slot arithmetic live in their own file
 * so a test can import them without dragging in the database this one opens
 * with. Re-exported, so every existing importer of this module is unaffected.
 * See src/watchdog_schedule.js for why that mattered. */
export { GRACE_MIN, WATCH, dueSlot } from "./watchdog_schedule.js";
import { GRACE_MIN, WATCH, dueSlot } from "./watchdog_schedule.js";

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
/** ALSO: how many of the newest runs failed in a row.
 *
 *  Discounting a failed run is right for "was this slot covered?" and it is
 *  exactly what turns a broken build into an unbounded loop. On 11-13 Sep
 *  newspaper.yml failed on one stale assertion; every tick discounted all ten
 *  failures, concluded the 22:00 slot was still uncovered, and dispatched
 *  again — 90 times in 30 hours. Each of those runs commits and publishes
 *  docs/index.html BEFORE the check that fails, so the loop also republished
 *  the site 90 times and sent 90 failure emails.
 *
 *  A dropped cron and a broken build look identical from here — no run
 *  covering the slot — but they need opposite responses. Dispatching repairs
 *  the first and merely repeats the second. The count is what separates them:
 *  a slot nothing ran has no failures behind it, a build that is broken has
 *  nothing but. */
async function recentRuns(repo, file, token) {
  const r = await fetch(`${API}/repos/${repo}/actions/workflows/${file}/runs?per_page=10`,
    { headers: hdrs(token), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`runs ${r.status}`);
  const j = await r.json();
  let at = 0;
  const failedAt = [];
  for (const run of j.workflow_runs || []) {          // newest first
    const finished = run.status === "completed";
    // A run still in flight counts as cover: dispatching a second copy of a
    // job running right now is the double-fire this file exists to avoid.
    if (finished && run.conclusion !== "success") { failedAt.push(Date.parse(run.created_at)); continue; }
    at = Date.parse(run.created_at);
    break;
  }
  return { at, failedAt };
}

/* Consecutive failures after which this stops dispatching. One dispatch to
 * repair a genuinely dropped slot, two more in case the failure was transient
 * — a runner dying, a third party down — and then it stands down and says so
 * on /api/pipeline. Retrying past that is not repair, it is a broken build
 * re-run on a timer, and for newspaper.yml each re-run is another publish and
 * another email. The stand-down clears itself: one green run resets the count
 * to zero and the watchdog resumes with no intervention. */
const BROKEN_AFTER = 3;

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
      const { at: last, failedAt } = await recentRuns(w.repo, w.file, token);
      row.last_run = last ? new Date(last).toISOString() : null;
      row.hours_since = last ? +((now - last) / 36e5).toFixed(1) : null;
      row.consecutive_failures = failedAt.length;
      /* ONLY THE FAILURES BEHIND THIS SLOT COUNT, and the distinction is not
       * academic. A workflow can carry a long tail of old failures and still
       * deserve its next slot dispatched — that is a build that was broken and
       * is now merely untried. Counting the whole tail would suppress the
       * first attempt at every future slot until something else happened to go
       * green, which is the watchdog declining to do the one job it has.
       * Failures after the slot are this slot's own retries; those are the
       * ones that say retrying is pointless. */
      const failsHere = due ? failedAt.filter(t => t >= due.at).length : 0;
      row.failures_since_slot = failsHere;

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
      /* A BROKEN BUILD IS NOT A MISSED ONE, AND DISPATCHING IT AGAIN ONLY
       * REPEATS THE FAILURE. Reported either way, because a workflow that has
       * stopped being retried is precisely the thing worth seeing. */
      row.broken = failsHere >= BROKEN_AFTER;
      if (row.broken) {
        row.note = `${failsHere} failures since this slot — standing down rather than `
                 + "re-running a build that is broken rather than dropped; one "
                 + "green run resumes this automatically";
      }
      if (row.missed && act && !row.broken) {
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
