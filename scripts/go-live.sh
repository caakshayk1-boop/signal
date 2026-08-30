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

if ! turso auth whoami >/dev/null 2>&1; then
  die "Turso is not logged in. Run:  turso auth login"
fi
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
turso db show "$DB" --url | npx --yes wrangler secret put TURSO_URL >/dev/null
printf '  TURSO_URL   set\n'
# A SECOND token, deliberately. It can be revoked without touching the
# newspaper's own access to the same database.
turso db tokens create "$DB" | npx --yes wrangler secret put TURSO_TOKEN >/dev/null
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
printf '  health ok, turso configured\n'

say "done — $URL"
printf 'Run the full check with:\n  node test/ui.mjs %s\n\n' "$URL"
