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
    repo: "caakshayk1-boop/trading-dashboard",
    file: "daily_scan.yml",
    why: "signals and Telegram alerts",
    slots: [
      // 13:00 MYT — the operator's "signals opening" slot. 05:00 UTC is
      // 10:30 IST, an hour and a quarter into the NSE session, so the day has
      // a real range to score and there are still four hours to act in.
      { dow: [1, 2, 3, 4, 5], h: 5, m: 0, inputs: { slot: "midday" } },
      // 21:00 MYT — "closing, with all updates". 13:00 UTC is 18:30 IST, three
      // hours after the bell: every close is final and the ledger settles.
      { dow: [1, 2, 3, 4, 5], h: 13, m: 0, inputs: { slot: "eod" } },
      { dow: [6], h: 4, m: 0, inputs: { slot: "weekend" } },
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
      { dow: [1, 2, 3, 4, 5], h: 0, m: 0, inputs: { task: "brief_morning_catchup" } },
      // 21:00 MYT.
      { dow: [1, 2, 3, 4, 5], h: 13, m: 0, inputs: { task: "brief_evening_catchup" } },
    ],
  },
  {
    repo: "caakshayk1-boop/signal",
    file: "sync-data.yml",
    why: "the mirrored feeds this site renders",
    slots: [
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
function dueSlot(now, slots) {
  let best = null;
  // Look back two days: a Friday-evening slot can still be the newest one on
  // a Sunday, and reporting "nothing due" then would hide a real outage.
  for (let back = 0; back <= 2; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    for (const s of slots) {
      if (!s.dow.includes(d.getUTCDay())) continue;
      const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.h, s.m, 0);
      if (at + GRACE_MIN * 60000 > now.getTime()) continue;   // not due yet
      if (!best || at > best.at) best = { at, inputs: s.inputs || null };
    }
  }
  return best;
}

async function lastRunAt(repo, file, token) {
  const r = await fetch(`${API}/repos/${repo}/actions/workflows/${file}/runs?per_page=1`,
    { headers: hdrs(token), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`runs ${r.status}`);
  const j = await r.json();
  const run = (j.workflow_runs || [])[0];
  return run ? Date.parse(run.created_at) : 0;
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
    const due = dueSlot(now, w.slots);
    const row = { repo: w.repo, workflow: w.file, why: w.why,
                  due_slot: due ? new Date(due.at).toISOString() : null,
                  dispatch_inputs: due && due.inputs ? due.inputs : null };
    try {
      const last = await lastRunAt(w.repo, w.file, token);
      row.last_run = last ? new Date(last).toISOString() : null;
      row.hours_since = last ? +((now - last) / 36e5).toFixed(1) : null;
      row.missed = !!(due && last < due.at);
      if (row.missed && act) {
        await dispatch(w.repo, w.file, token, due.inputs);
        row.dispatched = true;
      }
    } catch (e) {
      row.error = String((e && e.message) || e);
    }
    checked.push(row);
  }
  return { ok: true, at: now.toISOString(), grace_minutes: GRACE_MIN, checked };
}
