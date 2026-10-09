# Signal subscription and completed-session delivery

Implemented in the existing Worker / libsql stack. Resend is called via its
official HTTP API, so no new SDK or mail dependency is required. No live mail
or production database was used in automated tests.

## Main integration

Register these Vercel-shaped `(req, res)` handlers through `runVercelHandler`:

| Route | Method | Export |
|---|---|---|
| `/api/subscribe` | POST JSON | default from `src/api/subscribe.js` |
| `/api/subscribe/confirm?token=…` | GET or POST | `confirmationHandler` from the same module |
| `/api/unsubscribe?token=…` | GET or POST | `unsubscribeHandler` from the same module |
| `/api/subscription/preferences` | POST JSON | `preferencesHandler` from the same module |
| `/api/delivery` | POST, `x-edit-key` header | `createDeliveryHandler({ assets: env.ASSETS })` from `src/delivery/handler.js` |

Use the existing environment mirroring before invocation. The delivery factory
accepts the Worker asset binding so it reads the deployment's own static feeds
and archive rather than an HTTP cache. The default handler also accepts ASSETS
as argument three; a two-argument call falls back to fixed-origin HTTPS reads.
Add **all five routes** to the local-development `NO_PROXY` set: local delivery
must never proxy to production. No production sign-in cookie is needed for CI;
delivery requires the existing owner key and compares fixed-size SHA-256
digests in constant time. A browser-provided body cannot override feeds,
recipients, sessions or templates.

Subscribe JSON: `{ "email": "…", "elapsed": 3, "company": "", "source":
"footer", "digest": true, "alerts": false }`. `elapsed` is required and must
be at least two seconds; the honeypot remains. Preferences are booleans,
digest defaults on and alerts defaults off. Public successful responses are
always generic `status: pending`; update UI copy to “Check your inbox to
confirm” rather than announcing an active subscription. The token-confirmation
and cancellation responses are deliberately generic for invalid/used links.

Preference edits require a confirmed active subscription's unsubscribe token:
POST `{ "token": "…", "digest": true, "alerts": false }`. A bare subscribe
POST cannot edit confirmed preferences or restore an unsubscribed account.
One-click cancellation requires no sign-in and works as GET or RFC 8058 POST
with the token in the URL. Outbound messages include List-Unsubscribe headers.
Do not log request query strings on these token routes; handlers never log
addresses, tokens, keys, provider responses or errors.

## Environment

| Variable | Purpose |
|---|---|
| `TURSO_URL`, `TURSO_TOKEN` | Existing database bindings |
| `EDIT_KEY` | Existing owner key; required for `/api/delivery` |
| `RESEND_API_KEY` | Resend sending credential, Worker secret |
| `SIGNAL_EMAIL_FROM` | Verified Resend sender, e.g. a Signal address on the operator's verified domain |
| `SIGNAL_PUBLIC_URL` | HTTPS public Signal origin; used for confirmation, cancellation and canonicals |
| `DELIVERY_TOKEN_SECRET` | New high-entropy Worker secret, minimum 32 characters; keep stable |
| `SIGNAL_EXPECTED_SESSION` | Build-only expected completed NSE session; alternatively use the CLI flag below |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional existing operator Telegram destination; both present or both absent |

Missing email configuration returns explicit 503; no endpoint reports a
configured subscription while confirmation mail is impossible to send.
Confirmation and unsubscribe only need the database, so mail-provider downtime
does not prevent cancellation. Sender/domain verification and Worker secrets
remain operator configuration. Keep the token secret, public origin and sender
stable while retrying an attempted message. Rotating the token secret prevents
reconstruction of old outbound links; delivery suppresses those rows rather
than emitting an invalid unsubscribe link. Existing already-issued cancellation
links still validate against their stored hashes. Reconfirm affected accounts
after an intentional token-secret rotation.

## Database lifecycle and privacy

`src/delivery/store.js` lazily runs transactional additive migrations. Existing
subscriber ids, addresses, creation dates and source fields are retained.
Legacy `active` rows with no `confirmed_at` become **pending**, never assumed
double opt-in and never bulk-reconfirmed without a reader request. Subscription
confirmation uses a 24-hour opaque HMAC token based on a random nonce. Only
SHA-256 token hashes and the random nonce are persisted, never raw tokens.
`confirmed_at` is written only by consuming a valid, unexpired pending token.
Used confirmation tokens cannot revive cancellations. Cancellation immediately
sets `unsubscribed` and clears confirmation, retaining historical consent time.

`digest_enabled` / `alerts_enabled` gate delivery. A fresh read immediately
before each provider dispatch checks consent, preferences, cancellation and
nonce. A message already handed to a remote provider cannot be recalled.
Subscription attempts—including invalid input, bots and duplicates—are counted
transactionally against an HMAC of the IP, with five accepted attempts per
hour. Raw IPs and user agents are not added by this implementation. Pending
addresses have a one-hour confirmation-request cooldown against mail bombing.

New tables: `subscription_attempts`, `delivery_receipts`,
`delivery_plan_states`, `delivery_events`. No ledger/bot tables are changed.

## Archive build contract

The builder consumes `public/signal_v2.json` (`signal-v2-public/1`) and
**separate** `public/signal_trials.json` (`signal-trials/1`). Both must declare
the exact expected `session_date`, nonempty `status`, and `published_at` after
10:00 UTC on that completed session. Error/blocked/stale/unavailable or explicitly
synthetic/fixture inputs fail closed. Missing trials never become an invented
empty cohort. The expected date comes from the existing exchange-calendar
publishing workflow, not the machine clock or a guessed weekday.

The canonical feed supplies `plans`. Trials supply `plans` / `setups`, or
`cohorts` / `strategies` / `products` (array or named object), each containing
`plans`, `setups`, `positions` or `journal` arrays. Public rows use
`id`/`plan_id`/`setup_id`, `symbol`/`ticker`, `state`/`status`; completed event
dates may use `event_date`, `updated_session`, `closed_date`, `exit_date`, or
`entry_date`. Canonical and trial cohorts are labelled separately throughout.
Only public lifecycle fields are rendered, all HTML/XML data is escaped.

Run **after mirroring validated feeds and before static deploy**:

```sh
SIGNAL_PUBLIC_URL=https://signal.askakshay.com node scripts/build-digests.mjs --expected-session YYYY-MM-DD
```

Outputs:
- `public/digests/YYYY-MM-DD/index.html`: immutable archive and canonical URL.
- `public/digests/YYYY-MM-DD/delivery.json`: immutable public manifest with a
  SHA-256 of canonicalized canonical + trial inputs, no subscriber data.
- `public/digests/feed.xml`: deterministic RSS from archived publication dates.
- `public/digests/index.html`: archive index.
- `public/digests/latest.json`: monotonic pointer to the newest archived session.

Same-session identical inputs do not rewrite the published archive; changed
inputs fail `published_archive_input_mismatch` rather than revising history.
Persist/archive these generated files in the existing CI publishing mechanism
so the next clean build retains old editions. Expose `/digests/`, dated paths,
and `/digests/feed.xml` directly through ASSETS, and exempt them from SPA
fallback/redirect routes. Link RSS and archive from the existing site. Archive
build intentionally blocks today with `trials_feed_missing` until the separate
real trial publisher/mirror is connected.

## Post-build workflow and retries

1. Existing nightly publishing job finishes the private engine, validates and
   mirrors both public feeds for the exchange-resolved completed session.
2. Run the digest builder, unit tests (`node --test test/delivery*.mjs`), normal
   static/security guards and build; persist immutable digests and deploy
   through the existing Cloudflare pipeline.
3. After deployment succeeds, POST an **empty body** to `/api/delivery` with
   GitHub's existing secret `EDIT_KEY` as `x-edit-key`. Keep shell tracing off
   and never print the header or a token URL. A 503 blocks delivery rather
   than fabricating or sending from missing/stale inputs.
4. Parse the non-sensitive response counters. `more: true` means another
   bounded pass is needed; `retry > 0` means retry after at least 60 seconds.
   Use a bounded loop in the existing workflow (not a new scheduler).
   `pending_review` counts unresolved/failed/ambiguous receipts across runs;
   investigate these using owner-only DB tools, not public logs.

Each recipient/session/channel/consent generation has a deterministic Resend
idempotency key and durable DB receipt. Concurrent calls acquire a two-minute
lease. Retriable transport/429/5xx failures wait at least one minute, at most
five attempts; attempted sends older than 23 hours become `uncertain` and
require provider reconciliation rather than risk duplicating after Resend's
24-hour key expiry. Pending confirmation retries reconstruct the same token
and exact message from the server secret/nonce. The post-build handler refuses
archives whose immutable hash differs from the current published feeds, whose
publication is future-dated, or is more than 72 hours old.

Alerts are recorded from changes between completed-session plan states. First
run creates a baseline instead of replaying historical states; a new plan can
alert immediately only with an explicit current-session event date. Events
and receipts are durable and replay-safe. Alert email is an opted-in
completed-session summary, never an intraday trigger. Optional Telegram goes
only to the existing operator chat. Telegram lacks provider idempotency:
ambiguous transport/crash outcomes are marked `uncertain`, not automatically
resent; explicit 429 responses may retry. Existing bot modules are untouched.

Official provider contract checked against:
https://resend.com/docs/api-reference/emails/send-email (including the 24-hour
idempotency window).

## Verification status

`test/delivery-lifecycle.mjs` uses isolated temporary local libsql files and
injected providers. `test/delivery-archive.mjs` writes only temporary test
archives. They cover legacy migration, consent expiry/replay, cancellation,
preferences, attempt counting, suppression, idempotency/leases/retries,
confirmation message stability, historical alert baselines, HTML escaping,
cohort separation, deterministic RSS, immutable hashes and named feed failures.
Production sender, Worker routing, GitHub workflow and real-feed delivery need
main integration and operator configuration before a production send is claimed.
