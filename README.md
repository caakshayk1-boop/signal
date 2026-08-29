# Signal

India's markets in one screen — a live board with a year of context behind
every instrument, and a trading signal brief built as research rather than as
an alert. Over a public ledger that shows the losses as well as the wins.

Previously served as `news.askakshay.com/next.html` out of the newspaper repo.
This is the same surface, standing on its own.

---

## Why it moved

The site used to share a repository and a deployment with the daily broadsheet.
Three things followed from that, and all three are now gone:

| | before | now |
|---|---|---|
| A broken build over there | took this site down with it | this site keeps serving |
| Serverless functions | shared a hard cap of **12**, at 12 | one Worker, **no cap** |
| Adding an endpoint | risked silently breaking the whole deployment | one line in `src/index.js` |

That cap was not theoretical. A thirteenth route file does not warn, does not
fail the build and does not appear in any log — it silently breaks the entire
deployment. It happened twice, and three separate features (`?px`, `?wallet`,
`?series`) were crammed onto a single route as query parameters purely to avoid
creating a file. On Workers, routing is a `switch`.

**Hosting is Cloudflare Workers, and the reason is licensing as much as
engineering.** Vercel's Hobby tier is free but **non-commercial**; the moment
this is a live product it requires Pro. Cloudflare's free tier permits
commercial use, allows 100,000 requests/day, and costs $5/mo if it is ever
outgrown.

---

## How it is put together

```
public/            everything served as-is
  index.html       the whole app: seven hash routes, no build step
  signal.css       one stylesheet
  signal.js        one renderer
  *.json           nine data feeds, mirrored (see "Data" below)
  fonts/           nine self-hosted faces, latin only, no third party
src/
  index.js         the Worker: env mirror, /api router, asset fallthrough
  adapter.js       runs the Vercel-shaped handlers unchanged
  api/             the five routes, copied verbatim from the Vercel app
test/ui.mjs        42 assertions against a real browser
```

There is **no build step**. `index.html` loads two files and runs.

### The API handlers are deliberately not rewritten

`src/api/*.js` still take `(req, res)`. They carry years of specifics that are
each a bug someone already paid for — the Yahoo spark retry budget, the
badge-in-SQL mirror, "a missing quote renders as a dash, never as zero". A
rewrite re-litigates every one of them. `adapter.js` supplies the `req`/`res`
shape instead, and they run untouched.

**Exactly one line was changed** in anything copied: `_db.js` imports
`@libsql/client/web` rather than `@libsql/client`, because the default
entrypoint opens a TCP socket and a Worker has none.

### Data

The five API routes read Turso and Yahoo live — they do not care what any
build is doing. The nine JSON feeds are build artefacts from `generate.py` in
[`trading-dashboard`](https://github.com/caakshayk1-boop/trading-dashboard),
so `.github/workflows/sync-data.yml` mirrors them here twice a day and commits
them.

That mirror is the decoupling. **If the newspaper build fails, this site keeps
serving its last good copy of every feed instead of failing with it.** A feed
that comes back as invalid JSON or does not come back at all is skipped, never
allowed to overwrite a good copy.

---

## Running it locally

```bash
npm install
cp .dev.vars.example .dev.vars     # then fill in TURSO_URL / TURSO_TOKEN
npm run dev                        # http://127.0.0.1:8787
npm test                           # 42 assertions against the dev server
```

Without Turso credentials the board, the chart and the brief all still render —
only `/api/stats`, `/api/markets` and the ledger half of `/api/signals` return
500, and they say exactly which variable is missing. `/api/health` reports
whether the credentials are configured without touching the database, so
"is the Worker up" and "is Turso up" stay separate questions.

To test against a throwaway database instead of the real one:

```bash
turso dev --port 8080             # no auth when run locally
# TURSO_URL=http://127.0.0.1:8080 and any non-empty TURSO_TOKEN
```

---

## Going live

Four steps. Nothing below has been done yet — the Worker has only ever run
locally.

**1. Authenticate and deploy.**

```bash
npx wrangler login
npx wrangler deploy
```

**2. Set the two secrets.** `wrangler secret put` stores them encrypted; they
must never enter `wrangler.jsonc` or any committed file.

```bash
npx wrangler secret put TURSO_URL
npx wrangler secret put TURSO_TOKEN
```

Both values already exist as GitHub Actions secrets on `trading-dashboard`,
but GitHub secrets are **write-only** — they cannot be read back. Take them
from the Turso dashboard, or mint a fresh token with
`turso db tokens create <db>`. A second token against the same database is
fine and is the safer choice: it can be revoked without touching the
newspaper.

**3. Point a domain at it.** Until then the site is on `*.workers.dev` and is
deliberately `noindex` — `public/index.html` is otherwise a byte-for-byte
duplicate of a page already indexed at `news.askakshay.com/next.html`, and
letting a crawler find both splits the ranking of a page you already own.
When DNS points here, edit `public/index.html`:

- change `<meta name="robots">` back to `index,follow,max-image-preview:large`
- restore `<link rel="canonical" href="https://<domain>/">`
- restore `<meta property="og:url">`

**4. Optional — deploy from CI.** `.github/workflows/deploy.yml` skips itself
until `CLOUDFLARE_API_TOKEN` (scoped "Edit Cloudflare Workers") and
`CLOUDFLARE_ACCOUNT_ID` are set as repository secrets. Set the repository
*variable* `SIGNAL_URL` too and every deploy is checked by `test/ui.mjs`
against the live site.

---

## What this site will not do

- **No fabricated numbers.** A figure that cannot be measured prints
  "Not measured". Four NSE index tickers publish no daily close history at all,
  so those rows say "no history" rather than drawing a flat line that would
  read as "this market did not move".
- **No candles.** No feed here serves open-high-low-close, so the chart is
  drawn from closing prices and says so. Drawing candles would mean inventing
  the intraday range on the one page whose job is to be trusted.
- **No scenario probabilities.** No model publishes one. The ledger's own base
  rate over every closed trade is shown instead, labelled as the engine's
  history and not as a forecast for the trade on screen.
- **No hiding the losses.** The record section publishes win rate and
  expectancy whatever they say.

Not investment advice.
