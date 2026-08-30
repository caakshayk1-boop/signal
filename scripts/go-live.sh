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
say "2/5  deploying the Worker"
npx --yes wrangler deploy

# ── 3. secrets, piped — never printed, never stored on disk ────────────────
say "3/5  setting secrets (values are piped, never displayed)"
turso db show "$DB" --url | npx --yes wrangler secret put TURSO_URL >/dev/null
printf '  TURSO_URL   set\n'
# A SECOND token, deliberately. It can be revoked without touching the
# newspaper's own access to the same database.
turso db tokens create "$DB" | npx --yes wrangler secret put TURSO_TOKEN >/dev/null
printf '  TURSO_TOKEN set (a new token, revocable on its own)\n'

# ── 4. find the URL wrangler just published to ─────────────────────────────
say "4/5  locating the deployment"
URL="$(npx --yes wrangler deployments list --json 2>/dev/null \
  | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)"
if [ -z "$URL" ]; then
  SUB="$(npx --yes wrangler whoami 2>/dev/null | grep -oE '[a-z0-9-]+\.workers\.dev' | head -1 || true)"
  URL="${SUB:+https://signal.$SUB}"
fi
[ -n "$URL" ] || die "deployed, but the URL could not be read. Find it with: npx wrangler deployments list"
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
