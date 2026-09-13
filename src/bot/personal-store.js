 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } }// personal-store.ts — habits, journal, expenses and the watchlist.
//
// Storage is the trading-dashboard repo's data/ directory, written through the
// GitHub Contents API. That choice is deliberate:
//
//   · The webhook already holds GITHUB_PAT, so this needs no new secret. The
//     Turso credentials live on a different Vercel project and adding them here
//     would mean provisioning two more.
//   · The same repo's data/*.json is what this route already READS from, so
//     writes and reads share one location instead of inventing a second.
//   · A direct Contents API call is ~500ms. Dispatching a GitHub Action, the
//     other option, is 40–90s — unusable for "log this expense".
//   · Every change is versioned. For a ledger of habits and money that is a
//     feature, not overhead.
//
// The cost is optimistic concurrency: a write carries the blob sha it read, and
// GitHub rejects it with 409 if anything changed underneath. That is exactly
// the guarantee wanted here, and read() → mutate → write() retries once.

const REPO = "caakshayk1-boop/trading-dashboard";
const API = `https://api.github.com/repos/${REPO}/contents/data`;

 









function headers(pat) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
}

export async function read(file, fallback, pat) {
  try {
    const r = await fetch(`${API}/${file}?ref=main`, {
      headers: headers(pat),
      cache: "no-store",
    });
    if (r.status === 404) return { data: fallback, sha: null };
    if (!r.ok) throw new Error(`read ${file}: ${r.status}`);
    const j = await r.json();
    // Buffer is available on the nodejs runtime, which this route pins.
    const raw = Buffer.from(_nullishCoalesce(j.content, () => ( "")), "base64").toString("utf8");
    return { data: raw.trim() ? (JSON.parse(raw) ) : fallback, sha: j.sha };
  } catch (e2) {
    // A read failure must not look like "you have no habits". Callers that
    // mutate check for a null sha on a file that should exist and bail.
    return { data: fallback, sha: null };
  }
}

export async function write(
  file, data, sha, pat, message
) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
    branch: "main",
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${API}/${file}`, {
    method: "PUT",
    headers: headers(pat),
    body: JSON.stringify(body),
  });
  return r.ok;
}

/** read → mutate → write, retried once on the 409 that a concurrent write causes. */
export async function update(
  file, fallback, pat, message, mutate
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await read(file, fallback, pat);
    if (await write(file, mutate(data), sha, pat, message)) return true;
  }
  return false;
}

// ── dates ───────────────────────────────────────────────────────────────────
// Everything is stamped in IST. A habit ticked at 1 AM IST belongs to that day,
// not to the previous UTC one — using UTC would silently break streaks for
// anything logged late at night, which is when most of them get logged.

export function istDate(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
}

export function istStamp(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600000).toISOString().replace("T", " ").slice(0, 16);
}

export function daysBack(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(istDate(new Date(Date.now() - i * 86400000)));
  return out;
}

/** Consecutive days ending today (or yesterday, if today is not yet ticked). */
export function streakOf(log, habit) {
  const days = daysBack(400);
  let i = 0;
  // Today not being done yet is not a broken streak — the day is not over.
  if (!(_nullishCoalesce(log[days[0]], () => ( []))).includes(habit)) i = 1;
  let n = 0;
  for (; i < days.length; i++) {
    if (!(_nullishCoalesce(log[days[i]], () => ( []))).includes(habit)) break;
    n++;
  }
  return n;
}

export function bestStreakOf(log, habit) {
  const days = daysBack(400).reverse();
  let best = 0, run = 0;
  for (const d of days) {
    if ((_nullishCoalesce(log[d], () => ( []))).includes(habit)) { run++; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

// ── money ───────────────────────────────────────────────────────────────────
// Two currencies genuinely in play: ₹ for everything India-side and RM for
// household spending in Malaysia. They are never summed into one number — a
// blended "total" across two currencies is a wrong number wearing a right one.

const CUR = {
  inr: "₹", rs: "₹", "₹": "₹",
  myr: "RM", rm: "RM", ringgit: "RM",
  usd: "$", "$": "$", aed: "AED", dh: "AED",
};

export function parseCurrency(token) {
  return _nullishCoalesce(CUR[token.toLowerCase()], () => ( null));
}

export function money(cur, v) {
  return `${cur}${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** Totals per currency, largest first, rendered as one line. */
export function totalsLine(rows) {
  const by = {};
  for (const e of rows) by[e.cur] = (_nullishCoalesce(by[e.cur], () => ( 0))) + e.amount;
  const parts = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => money(c, v));
  return parts.length ? parts.join(" · ") : "nothing yet";
}
