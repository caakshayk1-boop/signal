# Signal V2 — operations, health checks and rollback

Public document. It names schedules and files; it contains no selection logic.
Rules, thresholds and research live in the private engine repository.

## The chain, after every NSE session

| Step | Where | When (UTC, Mon–Fri) | What it does |
|---|---|---|---|
| 1. EOD run | private engine, `eod.yml` | 13:35 · retry 15:35 · final 17:35 | Tests first. Builds the session's plans from completed bars, steps open plans, writes the canonical feed. Idempotent per session. |
| 2. Publish | same job, `publish_public.py` | end of step 1 | Writes `feeds/signal_v2.json` (schema `signal-v2-public/1`) to trading-dashboard through an allow-list. |
| 3. Mirror | this repo, `sync-data.yml` | 14:10 · 18:15 (plus 01:30, 06:40, 12:40 daily) | Pulls the feed, **refuses one whose `schema` is not `signal-v2-public/1`**, commits `public/signal_v2.json`, deploys. |
| 4. Serve | Cloudflare Worker | on deploy | Every V2 view reads that one file. |

Holidays are resolved in the engine from its exchange calendar: a run on a
holiday resolves to the previous session, which is already done, and exits 0.

## Health states a reader can see

Every V2 page draws the status strip, which reads only the feed:

- **Latest session**: `session_date`, or *not scanned — data incomplete* when
  the final attempt found the bars incomplete (`status: data_unavailable`).
- **Coverage**: `coverage.with_session_bar` of `coverage.universe`. No number
  in the feed, no number on the page.
- **Next scan**: `next_session` and `next_scan_due`. **Once `next_scan_due`
  has passed and the feed has not moved, the cell reads _Overdue_** and says
  which session everything on the page is from. A late feed must never keep
  reading as the current one. Pinned by `test/guard.mjs`.
- **Market**: the NSE clock, holiday-aware. The holiday table loads with the
  feed in `v2Load`, so every V2 view has it, not only the front page.
- A run that fails publishes `status: error` and **keeps the last good plans**,
  labelled as such, rather than an empty page.

## Health checks an operator runs

| Check | How |
|---|---|
| Did tonight's run complete? | Engine repo → Actions → `eod`. Exit 75 means "bars not final yet", which is normal before the final slot. |
| Is the public feed current? | `feeds/signal_v2.json` in trading-dashboard: `session_date` equals the last NSE session; `published_at` is after 10:00 UTC that day. |
| Is the site serving it? | `https://signal.askakshay.com/signal_v2.json` has the same `published_at`. If not, run `sync-data.yml` by hand. |
| Did a V1 writer run? | It cannot write: `v1_cutover.v1_frozen()` stands every V1 entry point down after 2026-09-30 18:30 UTC. `test_v1_cutover.py` in trading-dashboard drives each one. |
| Static guarantees | `node test/guard.mjs` (runs before every deploy) and `node test/ui.mjs $SIGNAL_URL` (runs after). |

**Known gap.** The Cloudflare watchdog cannot yet re-dispatch a missed engine
run: its token has no Actions permission on the private repo. The entry is
written and commented out in `src/watchdog_schedule.js`; uncomment it once
the token is widened. Until then the Overdue state is the only automatic
signal for a run that never started.

## Rollback

Each layer rolls back on its own. Nothing below deletes data.

1. **Site only (V2 UI regression).** Revert the merge commit on `main`;
   `deploy.yml` redeploys. The V1 views come back but have **no V1 feeds to
   read**, which were removed from `public/` and from the mirror list, so they
   render their fetch-failure states. A full V1 site restore needs step 3 as well.
2. **Engine output.** In the private engine, set the module's registry status
   back to `research` or `shadow`. Only `forward_paper` and `validated` may
   publish, so the feed keeps its status and record and files no new plans.
   `configs/ACTIVE` pins the config version; reverting it reverts the rules.
3. **V1 restore (deliberate only).** In trading-dashboard:
   - set `V1_UNFREEZE=1` on the jobs to be restored;
   - put the schedules back in `daily_scan.yml`, `research.yml`,
     `vision_scan.yml` and `scheduled_tasks.yml`, and in this repo's watchdog;
   - run `v1_archive.yml` in `restore-open` mode to reopen the rows that were
     archived as `ARCHIVED_V1`;
   - re-add the V1 feeds to `sync-data.yml` and `scripts/pull-feeds.mjs`.

   The archive tables (`v1_archive_*`) and the checksummed manifest are the
   source of truth. Run `verify` before trusting a restore.
4. **Cutover record.** `registry/cutover.json` is write-once. A restore does
   not rewrite it. The V2 forward record begins 2026-10-01 regardless, and V1
   results are never merged into it.
