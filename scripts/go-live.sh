#!/usr/bin/env bash
# go-live.sh — deploy the Worker and wire its secrets, in one pass.
#
# WHY A SCRIPT. The two secrets this site needs must move from Turso into
# Cloudflare without ever being displayed, pasted into a chat, or written to a
# file. Piping one CLI into the other does that; doing it by hand invites a
# copy-paste through a clipboard, which is where secrets leak.
#
#   npm run go-live                # database defaults to trading-db
#   npm run go-live -- my-other-db
#
# Safe to re-run. Deploying twice is harmless and re-putting a secret just
# overwrites it with the same value.
set -euo pipefail

DB="${1:-trading-db}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mstopped:\033[0m %s\n\n' "$*" >&2; exit 1; }

# ── 1. both CLIs must be authenticated, and the fix is named, not implied ──
say "1/5  checking logins"
npx --yes wrangler whoami >/tmp/_wq 2>&1 || true
if grep -qi "not authenticated\|not logged in" /tmp/_wq; then
  die "Cloudflare is not logged in. Run:  npx wrangler login"
fi
printf '  cloudflare  ok\n'

# THE turso CLI EXITS 0 WHILE PRINTING "You are not logged in".
#
# That is not a hypothetical. On 2026-09-08 this guard passed, `turso db show
# --url` printed the sentence "You are not logged in, please login with turso
# auth login before running other commands." to STDOUT, and step 3 piped that
# sentence into `wrangler secret put TURSO_URL`. Both secrets became the error
# message, every /api route began answering
#     500 URL_INVALID: The URL 'You are not logged in...' is not in a valid format
# and the health check below still said "turso configured", because it only
# asks whether the variable is SET. Production was down until the Worker was
# rolled back to the version before the secret change.
#
# So exit status is not evidence here. The OUTPUT has to be checked.
whoami_out="$(turso auth whoami 2>&1 || true)"
if [ -z "$whoami_out" ] || printf '%s' "$whoami_out" | grep -qi 'not logged in\|please login\|unauthor'; then
  die "Turso is not logged in ($whoami_out). Run:  turso auth login"
fi
printf '  logged in as %s\n' "$whoami_out"
printf '  turso       ok\n'

if ! turso db show "$DB" >/dev/null 2>&1; then
  die "No Turso database called '$DB'. List yours with:  turso db list"
fi
printf '  database    %s\n' "$DB"

# ── 2. the Worker must exist before a secret can be attached to it ─────────
#
# The URL is captured HERE, from the deploy's own output. The first version
# went looking for it afterwards with `wrangler deployments list --json`, which
# does not carry a workers.dev URL — so a run that had deployed correctly and
# set both secrets ended on a red "the URL could not be read". Everything had
# worked; only the reporting had failed, which is the kind of false alarm that
# teaches you to ignore the output.
say "2/5  deploying the Worker"
# Written to a file and echoed back, rather than `tee /dev/tty` — that fails
# outright with "Device not configured" anywhere there is no controlling
# terminal, which includes CI and any agent-run shell.
LOG="$(mktemp -t golive)"
npx --yes wrangler deploy >"$LOG" 2>&1 || { cat "$LOG"; rm -f "$LOG"; die "wrangler deploy failed"; }
cat "$LOG"
URL="$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$LOG" | head -1 || true)"
rm -f "$LOG"

# ── 3. secrets, piped — never printed, never stored on disk ────────────────
say "3/5  setting secrets (values are piped, never displayed)"
# READ IT, CHECK ITS SHAPE, THEN PIPE IT. A value that is not a libsql/https
# URL is never a database URL, whatever produced it — and shipping one costs a
# production outage, so it is worth the extra variable.
db_url="$(turso db show "$DB" --url 2>&1 | tr -d '\r' | tail -n 1)"
case "$db_url" in
  libsql://*|https://*) : ;;
  *) die "Turso returned something that is not a database URL: '$db_url'" ;;
esac
printf '%s' "$db_url" | npx --yes wrangler secret put TURSO_URL >/dev/null
printf '  TURSO_URL   set\n'
# A SECOND token, deliberately. It can be revoked without touching the
# newspaper's own access to the same database.
# A Turso token is a JWT: three dot-separated segments, starts with the base64
# of {"alg". Anything with a space in it is prose, not a credential.
db_tok="$(turso db tokens create "$DB" 2>&1 | tr -d '\r' | tail -n 1)"
case "$db_tok" in
  *\ *|"") die "Turso returned something that is not a token: '$db_tok'" ;;
  ey*.*.*) : ;;
  *) die "Turso returned something that is not a JWT token" ;;
esac
printf '%s' "$db_tok" | npx --yes wrangler secret put TURSO_TOKEN >/dev/null
printf '  TURSO_TOKEN set (a new token, revocable on its own)\n'

# ── 4. the URL was captured from the deploy above ──────────────────────────
say "4/5  locating the deployment"
if [ -z "${URL:-}" ]; then
  # A custom-domain-only Worker prints no workers.dev URL, which is not a
  # failure — the secrets are already set and the deploy already succeeded.
  printf '  no workers.dev URL in the deploy output (custom domain only?)\n'
  printf '  secrets are set and the Worker is deployed; skipping the health check.\n'
  say "done"
  exit 0
fi
printf '  %s\n' "$URL"

# ── 5. prove it actually works, rather than assuming a green deploy means up ─
say "5/5  verifying"
sleep 4
HEALTH="$(curl -fsS -m 25 "$URL/api/health" || true)"
[ -n "$HEALTH" ] || die "the Worker did not answer /api/health at $URL"
echo "$HEALTH" | grep -q '"turso_configured":true' \
  || die "the Worker is up but Turso is not configured — check the secrets above"

# "turso_configured" ONLY MEANS THE VARIABLE IS SET, NOT THAT IT WORKS.
#
# It reported true while both secrets held the string "You are not logged in,
# please login with turso auth login before running other commands." — a set
# variable, and a dead site. The only honest verification is to make the
# Worker actually query the database and check that it answers.
STATS="$(curl -fsS -m 25 "$URL/api/stats" || true)"
case "$STATS" in
  *'"ok":true'*) : ;;
  "") die "the Worker did not answer /api/stats — the deploy is live but the ledger is not" ;;
  *) die "the ledger query FAILED, so the secrets above are wrong: $(printf '%s' "$STATS" | head -c 200)" ;;
esac
printf '  health ok, and /api/stats returned a real ledger query\n'

say "done — $URL"
printf 'Run the full check with:\n  node test/ui.mjs %s\n\n' "$URL"
