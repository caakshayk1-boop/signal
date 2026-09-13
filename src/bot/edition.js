 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }// edition.ts — the Telegram side of news.askakshay.com.
//
// Every read command here goes to the SAME live API the website renders from,
// so the bot and the page can never disagree. Before this, the bot read raw
// JSON blobs out of the trading-dashboard repo while the site read Turso
// through /api/*, and the two drifted: `/signals` was slicing the first ten
// rows of a 605-row file with no status filter, so it answered with trades
// that had been stopped out days earlier — 336 of those 605 rows are SL_HIT.
//
// One source of truth. If a number is wrong here it is wrong on the site too,
// which is the only way to keep them honest.

const NEWS = "https://news.askakshay.com/api";



async function get(path, timeoutMs = 12000) {
  // Telegram retries a webhook that takes too long, which would double-send
  // every reply. Bounding each upstream call keeps the handler inside that
  // window and turns a slow API into a readable message instead.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${NEWS}${path}`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    const j = (await r.json()) ;
    if (!r.ok || j.ok === false) {
      throw new Error(String(_nullishCoalesce(j.error, () => ( `${r.status}`))));
    }
    return j;
  } finally {
    clearTimeout(t);
  }
}

// ── formatting helpers ──────────────────────────────────────────────────────

function num(v) {
  // Number(null) is 0 and Number("") is 0, and both pass Number.isFinite — so
  // the obvious one-liner turns every UNPUBLISHED figure into a real zero.
  // That is not cosmetic here: 57 of 748 screened companies publish no ROCE
  // and 6 publish no D/E, and "D/E 0" reads as debt-free while "PE 0" reads as
  // absurdly cheap. A missing number must render as "—", never as 0.
  // Booleans are excluded for the same reason: Number(true) is 1.
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Money with the right symbol. The ledger mixes NSE equities in rupees with
 *  commodities and FX in dollars; one hardcoded ₹ is how Brent ended up
 *  quoted at "₹83.59" on the site once. */
function price(v, currency) {
  const n = num(v);
  if (n === null) return "—";
  const c = typeof currency === "string" ? currency : "";
  const s = n >= 1000 ? n.toLocaleString("en-IN") : String(n);
  return c ? `${c}${s}` : s;
}

/** A CHANGE, so it carries a sign: +1.30%, -0.27%. */
function pct(v, digits = 1) {
  const n = num(v);
  return n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** A LEVEL, so it does not: a 34.8% win rate is not "up 34.8%". Using the
 *  signed formatter for both read as "+34.8%" next to a losing month, which
 *  is the kind of small wrongness that makes a number stop being trusted. */
function rate(v, digits = 1) {
  const n = num(v);
  return n === null ? "—" : `${n.toFixed(digits)}%`;
}

function esc(s) {
  // Telegram Markdown breaks on unbalanced _ * ` [ — a headline containing an
  // underscore silently drops the whole message with a 400.
  return String(_nullishCoalesce(s, () => ( ""))).replace(/([_*`[\]])/g, "\\$1");
}

function istNow() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function arr(j, key) {
  const v = j[key];
  return Array.isArray(v) ? (v ) : [];
}

function obj(j, key) {
  const v = j[key];
  return v && typeof v === "object" ? (v ) : {};
}

// ── commands ────────────────────────────────────────────────────────────────

/** The whole edition in one screen. */
export async function cmdToday() {
  const [health, stats] = await Promise.all([
    get("/health").catch(() => ({}) ),
    get("/stats").catch(() => ({}) ),
  ]);

  const head = obj(stats, "headline");
  const openBy = obj(health, "open_by_version");
  const gated = num(openBy.v2);

  const lines = [`📰 *The Daily Signal* — ${istNow()} IST\n`];

  lines.push("*Ledger*");
  lines.push(`  ${_nullishCoalesce(health.signals, () => ( "—"))} signals logged`);
  if (gated !== null) lines.push(`  ${gated} open setups (gated)`);
  lines.push(`  latest ${_nullishCoalesce(health.latest_signal_date, () => ( "—"))}`);

  if (Object.keys(head).length) {
    lines.push("\n*Edge* _(closed trades only)_");
    lines.push(`  win rate ${rate(head.win_rate, 1)} over ${_nullishCoalesce(head.trades, () => ( "—"))} closed`);
    lines.push(`  expectancy ${_nullishCoalesce(_optionalChain([num, 'call', _ => _(head.expectancy_r), 'optionalAccess', _2 => _2.toFixed, 'call', _3 => _3(3)]), () => ( "—"))}R`);
    lines.push(`  avg win ${_nullishCoalesce(_optionalChain([num, 'call', _4 => _4(head.avg_win_r), 'optionalAccess', _5 => _5.toFixed, 'call', _6 => _6(2)]), () => ( "—"))}R · avg loss ${_nullishCoalesce(_optionalChain([num, 'call', _7 => _7(head.avg_loss_r), 'optionalAccess', _8 => _8.toFixed, 'call', _9 => _9(2)]), () => ( "—"))}R`);
  }

  lines.push("\n_/signals /perf /world /markets /sip_");
  lines.push("_/note to save a thought against today_");
  return lines.join("\n");
}

/**
 * The morning brief, on demand.
 *
 * Deliberately the same material the 6 AM scheduled brief sends, off the same
 * endpoints, so asking for it at noon cannot produce a different market or a
 * different edge number than the one that arrived at breakfast. The scheduled
 * job in trading-dashboard/daily_brief.py owns the personal sections — habits,
 * chess, the quote. This owns the market-facing half.
 *
 * Each block degrades on its own. A brief missing its news line is still a
 * brief; one that refuses to render because a single upstream was slow is not.
 */
export async function cmdBrief() {
  const [markets, news, stats, signals] = await Promise.all([
    get("/markets").catch(() => null),
    get("/news").catch(() => null),
    get("/stats").catch(() => null),
    get("/signals?status=open&limit=100").catch(() => null),
  ]);

  const lines = [`🌅 *Brief* — ${istNow()} IST\n`];

  if (markets) {
    const m = arr(markets, "markets");
    if (m.length) {
      lines.push(`*Markets* — ${_nullishCoalesce(markets.advancing, () => ( 0))}/${_nullishCoalesce(markets.total, () => ( 0))} advancing`);
      for (const x of m) {
        lines.push(`  ${x.up ? "🟢" : "🔴"} ${esc(x.name)}  ${esc(x.price)}  ${pct(x.change_pct, 2)}`);
      }
    }
  } else {
    lines.push("*Markets* — unavailable");
  }

  if (news) {
    const n = arr(news, "news").slice(0, 3);
    if (n.length) {
      lines.push("\n*Wire*");
      for (const x of n) lines.push(`  • ${esc(x.title)} — ${esc(x.source)}`);
    }
  }

  if (signals) {
    const open = arr(signals, "signals");
    lines.push(`\n*Setups* — ${open.length} open`);
    for (const x of open.slice(0, 5)) {
      lines.push(
        `  ${esc(x.symbol)} ${esc(x.action)} @ ${price(x.entry, x.currency)} · SL ${price(x.sl, x.currency)}`
      );
    }
    if (open.length > 5) lines.push(`  _…and ${open.length - 5} more — /signals_`);
  }

  if (stats) {
    const head = obj(stats, "headline");
    if (Object.keys(head).length) {
      lines.push("\n*Edge* _(closed trades only)_");
      lines.push(
        `  ${_nullishCoalesce(_optionalChain([num, 'call', _10 => _10(head.expectancy_r), 'optionalAccess', _11 => _11.toFixed, 'call', _12 => _12(3)]), () => ( "—"))}R over ${_nullishCoalesce(head.trades, () => ( "—"))} closed · ` +
        `win rate ${rate(head.win_rate, 1)}`
      );
    }
  }

  lines.push("\n_/markets /signals /perf /world_");
  return lines.join("\n");
}

/** OPEN setups only, from the gated engine — the same population the site's
 *  table shows by default. */
export async function cmdSignals() {
  const j = await get("/signals?status=open&limit=25");
  const rows = arr(j, "signals");
  if (!rows.length) {
    return "No open setups on the gated engine right now.\nSend `Scan` to run a fresh scan.";
  }

  // The ledger has re-fired the same symbol on different days. Showing both
  // reads as two positions; keep the newest.
  const seen = new Set();
  const uniq = rows.filter((r) => {
    const k = String(_nullishCoalesce(r.symbol, () => ( "")));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const out = [`📋 *Open setups — ${uniq.length}* _(v2 gated)_\n`];
  for (const r of uniq.slice(0, 12)) {
    const act = String(_nullishCoalesce(r.action, () => ( "BUY"))).toUpperCase();
    const em = act === "BUY" ? "🟢" : "🔴";
    const cur = r.currency;
    out.push(
      `${em} *${esc(r.symbol)}* ${act}` +
        (r.grade ? ` · ${esc(r.grade)}` : "") +
        `\n   ${price(r.entry, cur)} → ${price(r.target1, cur)} · SL ${price(r.sl, cur)}` +
        (num(r.rr) !== null ? ` · RR ${num(r.rr).toFixed(2)}` : "") +
        (r.date ? `\n   _logged ${esc(r.date)}_` : "")
    );
  }
  if (uniq.length > 12) out.push(`\n_…and ${uniq.length - 12} more._`);
  out.push("\n_Open ≠ held. /positions is what you actually own._");
  out.push("_Not SEBI advice · @askakshayfinance_");
  return out.join("\n");
}

/** The honest number: expectancy over closed trades. */
export async function cmdPerf() {
  const j = await get("/stats");
  const h = obj(j, "headline");
  const t = obj(j, "totals");
  const months = arr(j, "by_month").slice(-3);

  const lines = [`📊 *The edge*\n`];
  lines.push(`Expectancy *${_nullishCoalesce(_optionalChain([num, 'call', _13 => _13(h.expectancy_r), 'optionalAccess', _14 => _14.toFixed, 'call', _15 => _15(3)]), () => ( "—"))}R* per trade`);
  lines.push(`Win rate ${rate(h.win_rate, 1)} — ${_nullishCoalesce(h.wins, () => ( "—"))}W / ${_nullishCoalesce(h.losses, () => ( "—"))}L`);
  lines.push(`Avg win ${_nullishCoalesce(_optionalChain([num, 'call', _16 => _16(h.avg_win_r), 'optionalAccess', _17 => _17.toFixed, 'call', _18 => _18(2)]), () => ( "—"))}R · avg loss ${_nullishCoalesce(_optionalChain([num, 'call', _19 => _19(h.avg_loss_r), 'optionalAccess', _20 => _20.toFixed, 'call', _21 => _21(2)]), () => ( "—"))}R`);
  lines.push(`\nClosed ${_nullishCoalesce(t.closed, () => ( "—"))} · open ${_nullishCoalesce(t.open, () => ( "—"))} · cancelled ${_nullishCoalesce(t.cancelled, () => ( "—"))}`);

  if (months.length) {
    lines.push("\n*By month*");
    for (const m of months) {
      lines.push(
        `  ${esc(m.key)} — ${_nullishCoalesce(m.trades, () => ( 0))} trades · ${rate(m.win_rate, 0)} won · ${_nullishCoalesce(_optionalChain([num, 'call', _22 => _22(m.total_r), 'optionalAccess', _23 => _23.toFixed, 'call', _24 => _24(1)]), () => ( "—"))}R`
      );
    }
  }
  lines.push(`\n_${esc(j.basis)}_`);
  return lines.join("\n");
}

export async function cmdWorld() {
  const j = await get("/world");
  const top = arr(j, "top").slice(0, 8);
  if (!top.length) return "No world stories in the last 24h.";
  const lines = [
    `🌍 *The world* — last ${_nullishCoalesce(j.window_hours, () => ( 24))}h · ${_nullishCoalesce(j.count, () => ( 0))} stories from ${_nullishCoalesce(j.sources_ok, () => ( "?"))}/${_nullishCoalesce(j.sources_total, () => ( "?"))} sources\n`,
  ];
  for (const s of top) {
    lines.push(`• *${esc(s.title)}*\n  _${esc(s.source)}_`);
  }
  return lines.join("\n");
}

export async function cmdMarkets() {
  const j = await get("/markets");
  const m = arr(j, "markets");
  if (!m.length) return "No market data right now.";
  const lines = [`📈 *Markets* — ${_nullishCoalesce(j.advancing, () => ( 0))}/${_nullishCoalesce(j.total, () => ( 0))} advancing\n`];
  for (const x of m) {
    lines.push(`${x.up ? "🟢" : "🔴"} ${esc(x.name)}  ${esc(x.price)}  ${pct(x.change_pct, 2)}`);
  }
  return lines.join("\n");
}

/** What is actually held — deliberately a different question from /signals. */
export async function cmdPositions() {
  const j = await get("/tracker");
  const p = arr(j, "positions");
  if (!p.length) {
    return "📁 *No tracked positions.*\n\nAn OPEN signal is a setup that has not resolved.\nA position is something you hold. Right now: none.";
  }
  const lines = [`📁 *Positions — ${p.length}*\n`];
  for (const x of p) {
    lines.push(
      `*${esc(x.symbol)}*  ${price(x.entry_price, x.currency)} → ${price(x.current_price, x.currency)}  ${pct(x.pnl_pct, 2)}`
    );
  }
  return lines.join("\n");
}

export async function cmdSip() {
  const j = await get("/sip");
  if (!j.ready) return "SIP buckets are not built yet for this month.";
  const t = obj(j, "totals");
  const plan = obj(j, "plan");
  const lines = [`🪣 *SIP buckets*\n`];
  lines.push(`This month ₹${_nullishCoalesce(plan.monthly_amount, () => ( "—"))} · SIP year ${_nullishCoalesce(plan.sip_year, () => ( "—"))} · step-up ${_nullishCoalesce(plan.step_up_pct, () => ( "—"))}%`);
  lines.push(`\nBuckets ${_nullishCoalesce(t.buckets, () => ( 0))}`);
  lines.push(`Invested ₹${_nullishCoalesce(_optionalChain([num, 'call', _25 => _25(t.invested), 'optionalAccess', _26 => _26.toLocaleString, 'call', _27 => _27("en-IN")]), () => ( "—"))}`);
  lines.push(`Value ₹${_nullishCoalesce(_optionalChain([num, 'call', _28 => _28(t.value), 'optionalAccess', _29 => _29.toLocaleString, 'call', _30 => _30("en-IN")]), () => ( "—"))}`);
  lines.push(`Unrealised ${pct(t.pnl_pct, 2)}`);
  const proj = arr(j, "projections");
  if (proj.length) {
    lines.push("\n*Where the step-up takes it*");
    for (const p of proj) {
      lines.push(`  ${p.years}y — invested ₹${_optionalChain([num, 'call', _31 => _31(p.invested), 'optionalAccess', _32 => _32.toLocaleString, 'call', _33 => _33("en-IN")])} → @12% ₹${_optionalChain([num, 'call', _34 => _34(p.r12), 'optionalAccess', _35 => _35.toLocaleString, 'call', _36 => _36("en-IN")])}`);
    }
  }
  return lines.join("\n");
}

/** This week's SIP screen — a ranking of public data, not a recommendation. */
export async function cmdFunds() {
  // Served inside /api/sip, not its own route: the Hobby plan caps a
  // deployment at 12 serverless functions and a dedicated /api/funds was the
  // 13th. Buckets and the screen are one section on the page anyway.
  const j = await get("/sip", 15000);
  const screen = obj(j, "fund_screen");
  const cats = arr(screen, "categories");
  if (!screen.ready || !cats.length) {
    return "The fund screen has not been built yet this week.\nIt rebuilds with the 6 AM job.";
  }
  const lines = [`🪙 *SIP screen* — top 3 by 3-year return\n`];
  for (const c of cats) {
    const funds = arr(c, "funds");
    if (!funds.length) continue;
    lines.push(`*${esc(c.label)}*`);
    for (const f of funds) {
      const r5 = num(f.r5);
      lines.push(
        `  ${rate(f.r3, 1)} 3y` +
          (r5 !== null ? ` · ${rate(r5, 1)} 5y` : "") +
          (num(f.dd3) !== null ? ` · worst ${rate(f.dd3, 1)}` : "") +
          `\n  ${esc(f.name)}`
      );
    }
    lines.push("");
  }
  lines.push("_Direct + Growth only — no distributor commission._");
  lines.push("_Expense ratio is not in the free AMFI feed; Direct is the cost lever that is._");
  lines.push("_A screen, not advice. Not a SEBI-registered adviser._");
  return lines.join("\n");
}

/* ── the static edition file ────────────────────────────────────────────────
   Trade ideas and the desk banks are not in Turso — picks are a weekly cache
   and the desk content is chosen per day in Python — so there is nothing for
   an API route to read. A /api/picks and /api/desk would also have been the
   13th and 14th serverless functions, and the Hobby plan stops at 12.

   The 6 AM build writes docs/today.json from the same objects it renders the
   page from, so this cannot disagree with what a reader sees. */
const SITE = "https://news.askakshay.com";

async function today() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${SITE}/today.json`, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(`edition file ${r.status}`);
    return (await r.json()) ;
  } finally {
    clearTimeout(t);
  }
}

/** The weekly top 5, as ranked for the Trade Ideas section. */
export async function cmdIdeas() {
  const j = await today();
  const picks = arr(j, "picks");
  if (!picks.length) return "No ranking published yet — the scan runs with the 6 AM build.";

  const lines = [`💡 *Trade ideas* — ${esc(j.date_str)}\n`];
  if (j.picks_week) {
    lines.push(`_This week's scan did not complete; showing ${esc(j.picks_week)}. Prices have moved._\n`);
  }
  picks.forEach((p, i) => {
    const cur = p.currency;
    lines.push(
      `*${i + 1}. ${esc(p.name)}* — ${p.score}/100\n` +
        `   ${price(p.price, cur)} → ${price(p.target, cur)} · SL ${price(p.stop_loss, cur)}\n` +
        `   1M ${pct(p.mom_1m)} · 3M ${pct(p.mom_3m)} · ${esc(p.timeframe)}` +
        (p.thesis ? `\n   _${esc(p.thesis)}_` : "")
    );
  });
  lines.push("\n_A ranking, not advice. Every idea carries a stop._");
  return lines.join("\n");
}

/** The engine log: every rule change the ledger forced, with its evidence.
 *
 *  Read from today.json rather than restated here. The whole point of the log
 *  is that the rule, the number behind it and what the site says are one
 *  thing; a hand-copied version in the bot would be the first to go stale, and
 *  it would go stale invisibly. A dedicated /api/engine was not an option
 *  either — vercel-news is at the Hobby cap of 12 serverless functions.
 *
 *  `args` takes an optional filter: /engine selection, /engine rejected.
 */
export async function cmdEngine(args) {
  const j = await today();
  const all = arr(j, "engine");
  if (!all.length) {
    return "No engine log published yet — it ships with the 6 AM build.";
  }

  const want = args.trim().toLowerCase();
  const rows = want
    ? all.filter((c) =>
        [c.tag, c.verdict, c.title].some((f) =>
          String(_nullishCoalesce(f, () => ( ""))).toLowerCase().includes(want)))
    : all;
  if (!rows.length) {
    // Deduped without a Set spread: this project's tsconfig target predates
    // downlevelIteration, so iterating a Set is a compile error here.
    const tags = all
      .map((c) => String(_nullishCoalesce(c.tag, () => ( ""))).toLowerCase())
      .filter((t, i, a) => t && a.indexOf(t) === i);
    return `Nothing in the engine log matches "${esc(want)}".\nTry: ${tags.join(", ")}, adopted, rejected.`;
  }

  const lines = [`⚙️ *Engine log* — what the ledger changed\n`];
  for (const c of rows) {
    // Adopted and rejected must not look alike at a glance. A rejected test is
    // not a failure — it is the half of the record that makes the adopted half
    // worth believing — so it is marked, not hidden and not dressed as a win.
    const mark = c.verdict === "rejected" ? "✕" : "✓";
    lines.push(
      `${mark} *${esc(c.title)}*\n` +
        `   _${esc(c.date)} · ${esc(c.tag)} · ${esc(c.verdict)}_`
    );
    if (c.body) lines.push(`   ${esc(c.body)}`);

    for (const e of arr(c, "evidence")) {
      // evidence rows are [label, value, n, significance] as published.
      const [label, val, n, sig] = Array.isArray(e) ? e : [];
      if (!label) continue;
      const tail = [n, sig].filter(Boolean).map((x) => esc(x)).join(" · ");
      lines.push(`   \`${esc(val)}\`  ${esc(label)}${tail ? ` (${tail})` : ""}`);
    }
    if (c.note) lines.push(`   _${esc(c.note)}_`);
    lines.push("");
  }
  lines.push("_Full log with the tables: news.askakshay.com/#rules_");
  return lines.join("\n");
}

/** One desk section, or the menu when no section is named. */
export async function cmdDesk(args) {
  const j = await today();
  const desk = obj(j, "desk");
  const want = args.trim().toLowerCase();

  // key -> [label, renderer]. Kept beside the data it reads so a new bank
  // cannot be added to today.json and quietly have no way to reach it.
  const one = (o, ...fields) => {
    const d = (o && typeof o === "object" ? o : {}) ;
    return fields.map((f) => d[f]).filter(Boolean).map((v) => esc(v)).join("\n\n");
  };
  const first = (v) => (Array.isArray(v) && v.length ? (v[0] ) : {});

  const SECTIONS = {
    chess:   ["♟ Chess", () => one(desk.chess, "title", "body")],
    wisdom:  ["🪔 Wisdom", () => one(desk.wisdom, "title", "body")],
    book:    ["📖 Reading", () => one(desk.book, "title", "body")],
    way:     ["🧭 The Way", () => one(desk.way, "title", "body")],
    quote:   ["💬 Quote", () => one(desk.quote, "text", "author")],
    money:   ["💰 Money hack", () => one(desk.money_hack, "title", "body")],
    dubai:   ["🇦🇪 Dubai", () => one(desk.dubai, "title", "body")],
    father:  ["👶 Fatherhood", () => one(first(desk.father), "title", "do", "why")],
    spanish: ["🇪🇸 Spanish", () => one(first(desk.spanish), "phrase", "meaning", "usage")],
    vocab:   ["🔤 Vocabulary", () => one(first(desk.vocab), "word", "meaning", "usage")],
    life:    ["🧘 Life wisdom", () => one(first(desk.life_wisdom), "tradition", "term", "translation", "meaning")],
    interview: ["🎯 Interview", () =>
      one(first(desk.interview_tech), "q", "a") + "\n\n" + one(first(desk.interview_soft), "q", "a")],
  };

  // "all" first: it is deliberately not a key in SECTIONS, so checking the
  // menu before this would swallow it and print the menu instead.
  if (want === "all") {
    const out = [`🗓 *The Desk* — ${esc(j.date_str)}\n`];
    for (const [label, render] of Object.values(SECTIONS)) {
      const body = render();
      if (body) out.push(`*${label}*\n${body}\n`);
    }
    return out.join("\n");
  }

  if (!want || !SECTIONS[want]) {
    const keys = Object.keys(SECTIONS).map((k) => `\`/desk ${k}\``).join(" · ");
    return `🗓 *The Desk* — ${esc(j.date_str)}\n\n${keys}\n\n_Or \`/desk all\` for the lot._`;
  }

  const [label, render] = SECTIONS[want];
  const body = render();
  return body ? `*${label}* — ${esc(j.date_str)}\n\n${body}` : `Nothing in ${label} today.`;
}

export async function cmdNews() {
  const j = await get("/news");
  const n = arr(j, "news").slice(0, 8);
  if (!n.length) return "No market news right now.";
  const lines = [`📰 *Market news* — ${_nullishCoalesce(j.count, () => ( 0))} items\n`];
  for (const s of n) lines.push(`• *${esc(s.title)}*\n  _${esc(s.source)}_`);
  return lines.join("\n");
}

/* ── the stock screen ───────────────────────────────────────────────────────
   #stocks on the site: the NSE Total Market (~750 names) ranked on published
   annual statements. Read from the two static payloads the 6 AM build writes,
   for the same reason cmdIdeas reads today.json — there is no API route to add
   (Hobby caps a deployment at 12 functions and this one is at 12), and the
   files are the exact objects the page renders from, so the bot cannot quote a
   number the page does not.

   screen.json is the table; screen-detail.json carries the year tables, SWOT
   and the rest. A one-company reply needs both; a list needs only the first. */

async function screenTable() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${SITE}/screen.json`, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(`screen ${r.status}`);
    return (await r.json()) ;
  } finally {
    clearTimeout(t);
  }
}

async function screenDetail() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${SITE}/screen-detail.json`, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(`screen detail ${r.status}`);
    return (await r.json()) ;
  } finally {
    clearTimeout(t);
  }
}

// Preset name -> predicate. Mirrors the browser presets in static/app.js and the
// Python bot's table, so the same word selects the same companies everywhere.
const SCREEN_PRESETS = {
  quality:   (r) => (_nullishCoalesce(num(r.q), () => ( 0))) >= 65 && (_nullishCoalesce(num(r.rev_cagr), () => ( 0))) >= 10,
  cheap:     (r) => (_nullishCoalesce(num(r.q), () => ( 0))) >= 60 && (_nullishCoalesce(num(r.pe_pctile), () => ( 0))) >= 60,
  growth:    (r) => (_nullishCoalesce(num(r.rev_cagr), () => ( 0))) >= 20,
  breakout:  (r) => r.brk20 === true || r.brk50 === true || r.brk52w === true,
  rs:        (r) => (_nullishCoalesce(num(r.rs1y), () => ( 0))) >= 15,
  oversold:  (r) => num(r.rsi) !== null && (num(r.rsi) ) < 35,
  debtfree:  (r) => num(r.de) !== null && (num(r.de) ) >= 0 &&
                    (num(r.de) ) <= 0.1,
  micro:     (r) => r.tier === "micro",
  small:     (r) => r.tier === "small",
  mid:       (r) => r.tier === "mid",
  large:     (r) => r.tier === "large",
};

// Ranking modes. Same weight sets as the site — investor and swing answer
// different questions over identical components.
const SCREEN_MODES = {
  investor: "m_inv", positional: "m_pos", swing: "m_swing",
};

function n(v, suf = "") {
  const x = num(v);
  return x === null ? "—" : `${x}${suf}`;
}

/** One company, in full — the mobile version of the site's detail sheet. */
// The four calls the screen publishes, in the order a reader cares about.
// The icon carries the call for someone scanning a phone; the word carries it
// for everyone else. Never icon alone.
const VD_ICON = { BUY: "\u{1F7E2}", WAIT: "\u{1F7E1}", WATCH: "⚪", AVOID: "\u{1F534}" };

// The ladder as the screen computed it. Only the fields whose meaning is
// documented are rendered: `e`/`s`/`rk`/`rr` and the [price, R] head of each
// target. `lad.t` entries carry two further integers and `lad.w` three, and
// nothing in the repo states what they mean — so they are left out rather
// than captioned with a guess a reader would trade on.
function ladderBlock(lad) {
  const e = num(lad.e), s = num(lad.s);
  if (e === null || s === null) return [];
  const rk = num(lad.rk), rr = num(lad.rr);
  const L = ["", "*Trade ladder*",
             `Entry ₹${e} · Stop ₹${s}${rk !== null ? ` · risk ${rk}%` : ""}`];
  const ts = arr(lad, "t")
    .map((t, i) => {
      const p = num(Array.isArray(t) ? t[0] : null), r = num(Array.isArray(t) ? t[1] : null);
      return p === null ? null : `T${i + 1} ₹${p}${r !== null ? ` (${r}R)` : ""}`;
    })
    .filter(Boolean);
  if (ts.length) L.push(ts.join(" · "));
  if (rr !== null) L.push(`Reward:risk ${rr} to T1`);
  return L;
}

// Structure and levels. Kept together because they answer one question —
// where is this price sitting relative to everything that matters — and a
// reader checking a 200-DMA is checking the 52-week range in the same breath.
// rsi_m is a 14-period RSI on every 21st BAR, which is a trading-month
// approximation, not a calendar month. It is absent on 47 of 748 names that
// lack the ~315 bars it needs, and those render "—" rather than a guess.
function techBlock(r) {
  const L = [];
  const rsiM = num(r.rsi_m);
  L.push(`RSI ${n(r.rsi)} daily · ${rsiM === null ? "—" : rsiM} monthly`);
  const lo = num(r.low52), hi = num(r.high52), fh = num(r.from_high);
  if (lo !== null && hi !== null) {
    L.push(`52W ₹${lo} – ₹${hi}${fh !== null ? ` · ${fh}% from high` : ""}`);
  }
  const s200 = num(r.sma200), price = num(r.price), am = num(r.above_mas);
  if (s200 !== null) {
    const rel = price === null ? "" : ` — price ${price >= s200 ? "above" : "below"}`;
    L.push(`200-DMA ₹${s200}${rel}` +
           (am !== null ? ` · above ${am} of 3 MAs` : "") +
           (r.stack === true ? " · 20>50>200 stacked" : ""));
  }
  return L;
}

// SWOT as the screen wrote it, three per quadrant. Each item is a claim and
// the figure behind it, so the reader can check the claim rather than take it.
function swotBlock(sw) {
  const QUAD = [["s", "Strengths"], ["w", "Weaknesses"], ["o", "Opportunities"], ["t", "Threats"]];
  if (!QUAD.some(([k]) => arr(sw, k).length)) return [];
  const L = ["", "*SWOT*"];
  for (const [k, label] of QUAD) {
    const items = arr(sw, k).slice(0, 3);
    if (!items.length) continue;
    L.push(`_${label}_`);
    for (const it of items) L.push(`  • ${esc(it.t)}\n    _${esc(it.k)}_`);
  }
  return L;
}

function oneCompany(r, extra) {
  const g = (k) => (extra[k] !== undefined ? extra[k] : r[k]);
  const L = [
    `*${esc(r.sym)}* — ${esc(r.name == null ? "" : r.name)}`,
    `_${esc(r.ind == null ? "" : r.ind)}_${r.tier ? ` · ${esc(r.tier)}cap` : ""}`,
  ];

  // THE CALL FIRST. This is the one line the question "what do I do about
  // this stock" is actually asking, and it sat in the payload unrendered
  // while the reply opened with an industry label.
  const vd = obj(r, "vd");
  const call = String(vd.c || "").toUpperCase();
  if (call) {
    const icon = VD_ICON[call] || "";
    L.push("", `${icon} *${esc(call)}*${vd.l ? ` — ${esc(vd.l)}` : ""}`);
    if (vd.o) L.push(esc(vd.o));
    const bits = [];
    if (vd.k) bits.push(`conviction ${esc(vd.k)}`);
    if (vd.h) bits.push(`horizon ${esc(vd.h)}`);
    const alt = arr(vd, "a").map(esc).filter(Boolean);
    if (alt.length) bits.push(`also rated ${alt.join(", ")}`);
    if (bits.length) L.push(`_${bits.join(" · ")}_`);
    // A WAIT is only actionable if it says what it is waiting FOR.
    if (vd.t) L.push(`Waiting for: ${esc(vd.t)}`);
  }

  // The ladder belongs to the call, so it sits directly under it — but only
  // when there is a call to act on. A ladder under an AVOID is an invitation.
  if (call === "BUY" || call === "WAIT") L.push(...ladderBlock(obj(r, "lad")));

  const tags = arr(obj(r, "setup"), "tags").map(esc).filter(Boolean);
  if (tags.length) L.push(`Setup: ${tags.join(" · ")}`);

  L.push(
    "",
    `₹${n(r.price)}   1Y ${n(r.r1y, "%")}`,
    ...techBlock(r),
    "",
    `*Rank ${n(r.comp)}*  ·  Q ${n(r.q)} G ${n(r.g)} V ${n(r.v)} T ${n(r.tech)}`,
    `Investor ${n(r.m_inv)} · Positional ${n(r.m_pos)} · Swing ${n(r.m_swing)}`,
    "",
    `ROCE ${n(r.roce, "%")} (3Y med ${n(r.roce_med, "%")})   ROE ${n(r.roe, "%")}`,
    `Revenue CAGR ${n(r.rev_cagr, "%")}   EBITDA CAGR ${n(r.ebitda_cagr, "%")}`,
    `D/E ${n(r.de)}   PE ${n(r.pe)}   Cash CFO/PAT ${n(r.cfo_pat)}`,
  );
  if (num(r.piotroski) !== null) L.push(`Piotroski ${n(r.piotroski)}/${n(r.piotroski_of)}`);
  if (r.em_label) L.push(`Earnings momentum: *${esc(String(r.em_label).toUpperCase())}*`);

  // The verdict's own flags are the reasons it was held back, so they belong
  // with it rather than in a generic risk block.
  const vf = arr(vd, "f");
  if (vf.length) {
    L.push("", "⚠ *Flags*");
    for (const f of vf.slice(0, 5)) L.push(`  ! ${esc(f.w)}\n    _${esc(f.e)}_`);
  }

  const risk = obj(r, "risk");
  if (risk.level) {
    L.push("", `*Risk ${esc(risk.level)}*`);
    for (const f of arr(risk, "flags").slice(0, 4)) L.push(`  ! ${esc(f.t)}\n    _${esc(f.k)}_`);
  }

  const why = arr({ why_now: g("why_now") }, "why_now");
  if (why.length) {
    L.push("", "*Why now*");
    for (const w of why.slice(0, 5)) L.push(`  + ${esc(w.t)}\n    _${esc(w.k)}_`);
  }
  L.push(...swotBlock(obj({ v: g("swot") }, "v")));
  const ca = num(g("capalloc"));
  if (ca !== null) L.push("", `*Capital allocation* ${ca}/10`);
  const vh = obj({ v: g("val_hist") }, "v");
  if (num(vh.median) !== null) {
    L.push(`*Vs its own history* — PE ${n(r.pe)} against a median of ${n(vh.median)}` +
           (num(vh.vs_own_median) !== null ? ` (${n(vh.vs_own_median, "%")})` : ""));
  }
  const ai = g("ai_view");
  if (typeof ai === "string" && ai) L.push("", "*Analyst view* _(AI, from the figures above)_", `_${esc(ai)}_`);
  if (r.has_stmts === false) {
    L.push("", "⚠ No annual statements published for this symbol — price-only, no rank.");
  }
  L.push("", "_A ranking of public data, not advice._");
  return L.join("\n");
}

/**
 * `/screen` — top 10 · `/screen TCS` — one company · `/screen quality` — a preset
 * · `/screen investor` — ranked for a horizon.
 */
export async function cmdScreen(args) {
  let j;
  try {
    j = await screenTable();
  } catch (e2) {
    return "The stock screen has not been published yet.\nIt rebuilds Sunday 02:30 IST.";
  }
  const rows = arr(j, "rows");
  if (!rows.length) return "The stock screen is empty this week.";
  const built = esc(_nullishCoalesce(j.built_on, () => ( "?")));
  const uni = esc(_nullishCoalesce(j.universe, () => ( "NSE")));
  const a = (args || "").trim().toLowerCase();

  if (!a) {
    const top = rows.filter((r) => num(r.comp) !== null).slice(0, 10);
    const L = [`🔎 *Top 10 by rank* — ${uni}`, `_${rows.length} companies · built ${built}_`, ""];
    top.forEach((r, i) =>
      L.push(`${i + 1}. *${esc(r.sym)}* ${n(r.comp)} · ROCE ${n(r.roce, "%")} · ` +
             `rev ${n(r.rev_cagr, "%")} · PE ${n(r.pe)}`));
    L.push("", "`/screen SYMBOL` · `/screen quality` · `/screen investor`",
           "_Presets: quality cheap growth breakout rs oversold debtfree micro small mid large_");
    return L.join("\n");
  }

  if (SCREEN_MODES[a]) {
    const key = SCREEN_MODES[a];
    const sel = rows.filter((r) => num(r[key]) !== null)
                    .sort((x, y) => (num(y[key]) ) - (num(x[key]) ));
    const L = [`🔎 *Top 10 ranked for ${esc(a)}*`, `_${uni} · built ${built}_`, ""];
    sel.slice(0, 10).forEach((r, i) =>
      L.push(`${i + 1}. *${esc(r.sym)}* ${n(r[key])} _(balanced ${n(r.comp)})_ · ` +
             `ROCE ${n(r.roce, "%")} · RSI ${n(r.rsi)}`));
    L.push("", "_Same components, different weights. A name can rank high here and low elsewhere — that is the point._");
    return L.join("\n");
  }

  if (SCREEN_PRESETS[a]) {
    const sel = rows.filter(SCREEN_PRESETS[a])
                    .sort((x, y) => (_nullishCoalesce(num(y.comp), () => ( -1))) - (_nullishCoalesce(num(x.comp), () => ( -1))));
    if (!sel.length) return `Nothing in the screen matches *${esc(a)}* this week.`;
    const L = [`🔎 *${esc(a)}* — ${sel.length} of ${rows.length}`, `_built ${built}_`, ""];
    sel.slice(0, 12).forEach((r, i) =>
      L.push(`${i + 1}. *${esc(r.sym)}* ${n(r.comp)} · ROCE ${n(r.roce, "%")} · rev ${n(r.rev_cagr, "%")}`));
    if (sel.length > 12) L.push(`_…and ${sel.length - 12} more_`);
    return L.join("\n");
  }

  const want = a.toUpperCase();
  const hit = rows.find((r) => String(r.sym).toUpperCase() === want);
  if (!hit) {
    // Match on the SQUEEZED forms too — no spaces, no punctuation — so
    // "TATAMOTORS" finds "Tata Motors Passenger Vehicles" and "MnM" finds
    // "M&M". Index constituents get renamed and demerged constantly (Tata
    // Motors became TMPV mid-2026), and a bare "not in the screen" for a
    // company that plainly IS in it reads as the bot being broken.
    const squeeze = (x) => String(x == null ? "" : x).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const wantSq = squeeze(want);
    const near = rows
      .filter((r) => {
        const sym = squeeze(r.sym), nm = squeeze(r.name);
        return sym.includes(wantSq) || wantSq.includes(sym) || nm.includes(wantSq);
      })
      .slice(0, 6)
      .map((r) => `${esc(r.sym)} (${esc(r.name)})`);
    return `*${esc(want)}* is not in the screen.` +
           (near.length ? `\nDid you mean: ${near.join(", ")}?` : `\nIt covers ${uni} — try \`/screen\`.`);
  }
  // Detail is a second file and only a one-company reply needs it. A failure
  // degrades to the table row rather than to an error.
  let extra = {};
  try {
    const d = await screenDetail();
    extra = _nullishCoalesce(obj(obj(d, "detail"), String(hit.sym)), () => ( {}));
  } catch (e3) { /* table-only reply */ }
  return oneCompany(hit, extra);
}

/** New listings — every NSE IPO inside the window and what it has done.
 *
 * Reads the summary generate.py writes into today.json rather than a second
 * artefact: a docs/ file needs allow-listing in four separate places to reach
 * the web, and the bot only needs the headline numbers plus the movers.
 *
 * Measured from the FIRST TRADED CLOSE, never an issue price — NSE's issue
 * data is not reliably reachable, and a listing gain computed off a guessed
 * issue price would be a fabricated number. The reply says so, because the
 * difference matters to anyone who was actually allotted.
 */
export async function cmdListings() {
  const j = await today();
  const ipos = (j.ipos || {}) ;
  const rows = Array.isArray(ipos.rows) ? (ipos.rows ) : [];
  if (!rows.length) {
    return "No listings published yet — the tracker runs weekly, Sunday 03:30 IST.";
  }
  const s = (ipos.summary || {}) ;
  const worst = Array.isArray(ipos.worst) ? (ipos.worst ) : [];

  const line = (r) =>
    `  ${esc(String(r.sym))} — ${pct(r.since_listing_pct )} ` +
    `since ${esc(String(r.listed_on))} · from high ${pct(r.from_high_pct )}`;

  const out = [
    `🆕 *New listings* — ${ipos.count} in ${ipos.months} months\n`,
    `${s.up} above their first close · ${s.down} below`,
    s.median_pct != null ? `Median ${pct(s.median_pct )}\n` : "\n",
    `*Best*`,
    ...rows.map(line),
  ];
  if (worst.length) {
    out.push(`\n*Worst*`, ...worst.map(line));
  }
  out.push(
    `\n_Measured from the first traded close, not an issue price — so this is` +
      ` not the return an allottee saw. Built ${esc(String(ipos.built_on || "—"))}._`
  );
  return out.join("\n");
}

/** Data health — which datasets are current and which are not.
 *
 * The one command that should be boring to read. If it says everything is
 * current, every other command's numbers can be taken at face value; if it
 * does not, this names what to distrust before you act on it.
 */
export async function cmdHealth() {
  const j = await today();
  const h = (j.data_health || {}) ;
  if (!h.total) return "No health snapshot in this edition yet.";

  const bad = Array.isArray(h.degraded) ? (h.degraded ) : [];
  const head =
    `🩺 *Data health* — ${h.current}/${h.total} current` +
    (h.worst ? ` · worst ${esc(String(h.worst))}` : "");
  if (!bad.length) {
    return `${head}\n\nEvery dataset is inside its refresh window.`;
  }
  return [
    head,
    "",
    ...bad.map(
      (d) =>
        `*${esc(String(d.status))}* — ${esc(String(d.dataset))} · ${esc(String(d.age))}` +
        (d.note ? `\n   _${esc(String(d.note))}_` : "")
    ),
    "",
    "_A dataset outside its window is not wrong, it is old. The page labels it the same way._",
  ].join("\n");
}
