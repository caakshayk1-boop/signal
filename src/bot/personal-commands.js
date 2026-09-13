 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }// personal-commands.ts — the thirteen bot commands that were registered in the
// BotFather menu but had no handler behind them.
//
// Tapping /habits, /journal, /expense, /watchlist, /market, /summary and the
// rest produced nothing at all: the menu advertised them, the webhook fell
// through every branch, and the request ended with a bare {ok:true}. Silence,
// not an error — the same failure shape as the dead Groq model and the renamed
// scan handlers.
//
// Each handler here returns the reply text. Returning null means "not mine".

import {
  read, update, istDate, istStamp, daysBack, streakOf, bestStreakOf,
  parseCurrency, money, totalsLine,

} from "./personal-store.js";

const HABITS_FILE = "habits.json";
const JOURNAL_FILE = "journal.json";
const EXPENSE_FILE = "expenses.json";
const WATCH_FILE = "watchlist.json";
const NOTES_FILE = "notes.json";

const EMPTY_HABITS = { habits: [], log: {} };
const FAILED = "⚠️ Could not save — GitHub rejected the write. Try once more.";

// A habit is matched on a loose form so "/habits Gym" ticks "gym" and
// "morning walk" can be ticked as "morningwalk".
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function findHabit(h, name) {
  const k = key(name);
  return _nullishCoalesce(_nullishCoalesce(_optionalChain([h, 'access', _ => _.habits, 'access', _2 => _2.find, 'call', _3 => _3((x) => key(x.name) === k), 'optionalAccess', _4 => _4.name])
, () => ( _optionalChain([h, 'access', _5 => _5.habits, 'access', _6 => _6.find, 'call', _7 => _7((x) => key(x.name).startsWith(k)), 'optionalAccess', _8 => _8.name])))
, () => ( null));
}

// ── habits ──────────────────────────────────────────────────────────────────

async function cmdHabits(args, pat) {
  const today = istDate();

  // "/habits gym" toggles today rather than listing. Ticking a habit is the
  // thing done daily; listing is the thing done occasionally.
  if (args.trim()) {
    let result = "";
    const ok = await update(HABITS_FILE, EMPTY_HABITS, pat,
      `chore: toggle habit ${args.trim()}`, (h) => {
        const name = findHabit(h, args.trim());
        if (!name) { result = `No habit matching *${args.trim()}*.\nAdd it: \`/addhabit ${args.trim()}\``; return h; }
        const day = _nullishCoalesce(h.log[today], () => ( []));
        if (day.includes(name)) {
          h.log[today] = day.filter((x) => x !== name);
          result = `↩️ Un-ticked *${name}* for today.`;
        } else {
          h.log[today] = [...day, name];
          const s = streakOf({ ...h.log, [today]: [...day, name] }, name);
          result = `✅ *${name}* done. ${s} day${s === 1 ? "" : "s"} running.`;
        }
        return h;
      });
    return ok ? result : FAILED;
  }

  const { data: h } = await read(HABITS_FILE, EMPTY_HABITS, pat);
  if (!h.habits.length) {
    return "No habits yet.\n\nAdd one: `/addhabit Gym`\nThen tick it: `/habits gym`";
  }
  const done = _nullishCoalesce(h.log[today], () => ( []));
  const lines = [`🎯 *Habits* — ${today}\n`];
  for (const x of h.habits) {
    const s = streakOf(h.log, x.name);
    lines.push(`${done.includes(x.name) ? "✅" : "⬜️"} ${x.name}${s ? `  · ${s}d` : ""}`);
  }
  lines.push(`\n${done.length}/${h.habits.length} today · tick with \`/habits <name>\``);
  return lines.join("\n");
}

async function cmdAddHabit(args, pat) {
  const name = args.trim();
  if (!name) return "Name it: `/addhabit Gym`";
  if (name.length > 40) return "Too long — keep a habit name under 40 characters.";
  let result = "";
  const ok = await update(HABITS_FILE, EMPTY_HABITS, pat,
    `chore: add habit ${name}`, (h) => {
      if (findHabit(h, name)) { result = `*${name}* is already on the list.`; return h; }
      h.habits.push({ name, created: istDate() });
      result = `➕ Tracking *${name}*.\nTick it with \`/habits ${key(name)}\``;
      return h;
    });
  return ok ? result : FAILED;
}

async function cmdRemoveHabit(args, pat) {
  const q = args.trim();
  if (!q) return "Which one? `/removehabit Gym`";
  let result = "";
  const ok = await update(HABITS_FILE, EMPTY_HABITS, pat,
    `chore: remove habit ${q}`, (h) => {
      const name = findHabit(h, q);
      if (!name) { result = `No habit matching *${q}*.`; return h; }
      h.habits = h.habits.filter((x) => x.name !== name);
      // History stays. Deleting a habit should not rewrite what was true on the
      // days it was kept — /habitstats over an old window still reads right.
      result = `🗑 Removed *${name}*. Its history is kept.`;
      return h;
    });
  return ok ? result : FAILED;
}

async function cmdStreak(_args, pat) {
  const { data: h } = await read(HABITS_FILE, EMPTY_HABITS, pat);
  if (!h.habits.length) return "No habits yet. `/addhabit Gym`";
  const rows = h.habits
    .map((x) => ({ name: x.name, now: streakOf(h.log, x.name), best: bestStreakOf(h.log, x.name) }))
    .sort((a, b) => b.now - a.now);
  const lines = ["🔥 *Streaks*\n"];
  for (const r of rows) {
    const flag = r.now === 0 ? "💤" : r.now >= r.best && r.now > 1 ? "🏆" : "🔥";
    lines.push(`${flag} *${r.name}* — ${r.now}d${r.best > r.now ? `  (best ${r.best}d)` : ""}`);
  }
  return lines.join("\n");
}

async function cmdHabitStats(_args, pat) {
  const { data: h } = await read(HABITS_FILE, EMPTY_HABITS, pat);
  if (!h.habits.length) return "No habits yet. `/addhabit Gym`";
  const win = daysBack(30);
  const lines = ["📊 *Habits — last 30 days*\n"];
  const scored = h.habits.map((x) => {
    const hits = win.filter((d) => (_nullishCoalesce(h.log[d], () => ( []))).includes(x.name)).length;
    return { name: x.name, hits, pct: Math.round((hits / 30) * 100) };
  }).sort((a, b) => b.pct - a.pct);
  for (const s of scored) {
    // Ten blocks, one per 10%. A bar reads faster than a number at a glance,
    // which is the whole point of asking for stats on a phone.
    // Anything above zero gets at least one block. Rounding 3% to an empty bar
    // makes "did it once" look identical to "never started".
    const filled = s.hits > 0 ? Math.max(1, Math.round(s.pct / 10)) : 0;
    lines.push(`\`${"█".repeat(filled)}${"░".repeat(10 - filled)}\` ${s.pct}%  ${s.name}  _(${s.hits}/30)_`);
  }
  const overall = Math.round(scored.reduce((a, s) => a + s.pct, 0) / (scored.length || 1));
  lines.push(`\nOverall *${overall}%*`);
  return lines.join("\n");
}

// ── notes and learnings, stamped against the edition ────────────────────────
//
// Separate from /journal on purpose. The journal is the day; a note is a
// reaction to something in that morning's edition. Carrying the edition date
// means a note read back in six months still says WHICH paper prompted it,
// which is the only thing that makes an old note worth anything.



async function cmdNote(args, pat, kind) {
  const text = args.trim();
  if (!text) {
    return kind === "learning"
      ? "What did you learn?\n\n`/learn Sequence of returns matters more than the average.`"
      : "What is the note?\n\n`/note The 35% win rate is fine — avg win is 2.4x avg loss.`";
  }
  const day = istDate();
  let n = 0;
  const ok = await update(NOTES_FILE, [], pat, `chore: ${kind} from the edition`,
    (d) => {
      d.push({ ts: istStamp(), day, kind, text });
      n = d.filter((x) => x.day === day).length;
      return d;
    });
  if (!ok) return FAILED;
  const label = kind === "learning" ? "💡 Learning" : "📝 Note";
  return `${label} saved against *${day}*.\n_${n} ${n === 1 ? "entry" : "entries"} on today's edition._`;
}

async function cmdNotes(args, pat) {
  const { data } = await read(NOTES_FILE, [], pat);
  if (!data.length) {
    return "No notes yet.\n\n`/note <text>` — a thought on today's edition\n`/learn <text>` — something you learned";
  }
  // `/notes 7` widens the window; bare shows today, and falls back to the most
  // recent so an empty day never looks like an empty store.
  const days = Math.max(1, Math.min(parseInt(args.trim(), 10) || 1, 60));
  const cutoff = daysBack(days);
  let rows = data.filter((e) => cutoff.includes(e.day));
  let header = days === 1 ? "today" : `last ${days} days`;
  if (!rows.length) {
    rows = data.slice(-5);
    header = `nothing recent — last ${rows.length}`;
  }
  const lines = [`🗒 *Notes* — ${header} · ${data.length} total\n`];
  for (const e of rows.slice(-12)) {
    lines.push(`${e.kind === "learning" ? "💡" : "📝"} \`${e.day}\`\n${e.text}\n`);
  }
  return lines.join("\n");
}

// ── journal ─────────────────────────────────────────────────────────────────

async function cmdJournal(args, pat) {
  const text = args.trim();
  if (!text) {
    const { data } = await read(JOURNAL_FILE, [], pat);
    if (!data.length) return "Journal is empty.\n\nWrite one: `/journal Shipped the ticker rebuild.`";
    const lines = [`📓 *Journal* — last ${Math.min(5, data.length)} of ${data.length}\n`];
    for (const e of data.slice(-5).reverse()) {
      lines.push(`\`${e.ts}\`\n${e.text}\n`);
    }
    return lines.join("\n");
  }
  let n = 0;
  const ok = await update(JOURNAL_FILE, [], pat, "chore: journal entry",
    (d) => { d.push({ ts: istStamp(), text }); n = d.length; return d; });
  return ok ? `📓 Saved. Entry #${n}.` : FAILED;
}

// ── expenses ────────────────────────────────────────────────────────────────

async function cmdExpense(args, pat) {
  // "/expense 450 food lunch with A" — amount, then an optional currency token,
  // then a category, then free text.
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "Log it: `/expense 450 food lunch`\nOr in ringgit: `/expense 45 myr groceries`";
  }
  const amount = parseFloat(parts[0].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    return `\`${parts[0]}\` is not an amount.\nTry: \`/expense 450 food lunch\``;
  }
  let i = 1;
  // Default ₹. Household spending is in ringgit and says so explicitly rather
  // than being guessed from the category.
  let cur = "₹";
  const maybeCur = parts[1] ? parseCurrency(parts[1]) : null;
  if (maybeCur) { cur = maybeCur; i = 2; }
  const cat = (_nullishCoalesce(parts[i], () => ( "misc"))).toLowerCase();
  const note = parts.slice(i + 1).join(" ");

  let monthTotal = "";
  const ok = await update(EXPENSE_FILE, [], pat, `chore: expense ${cur}${amount} ${cat}`,
    (d) => {
      d.push({ ts: istStamp(), amount, cur, cat, note });
      const m = istDate().slice(0, 7);
      monthTotal = totalsLine(d.filter((e) => e.ts.startsWith(m)));
      return d;
    });
  if (!ok) return FAILED;
  return `💸 ${money(cur, amount)} · *${cat}*${note ? ` — ${note}` : ""}\n_This month: ${monthTotal}_`;
}

async function cmdExpenses(args, pat) {
  const { data } = await read(EXPENSE_FILE, [], pat);
  if (!data.length) return "No expenses logged.\n\n`/expense 450 food lunch`";

  // "/expenses 7" reads the last 7 days; bare reads the current month.
  const days = parseInt(args.trim(), 10);
  let rows, label;
  if (Number.isFinite(days) && days > 0) {
    const win = new Set(daysBack(Math.min(days, 365)));
    rows = data.filter((e) => win.has(e.ts.slice(0, 10)));
    label = `last ${days} days`;
  } else {
    const m = istDate().slice(0, 7);
    rows = data.filter((e) => e.ts.startsWith(m));
    label = new Date(m + "-01").toLocaleString("en-IN", { month: "long", year: "numeric" });
  }
  if (!rows.length) return `Nothing logged for ${label}.`;

  // Grouped by category, then by currency inside it — the two are never added
  // together, so a category holding both shows both.
  const byCat = {};
  for (const e of rows) (byCat[e.cat] ??= []).push(e);
  const ordered = Object.entries(byCat)
    .sort((a, b) => b[1].reduce((s, e) => s + e.amount, 0) - a[1].reduce((s, e) => s + e.amount, 0));

  const lines = [`💰 *Expenses* — ${label}\n`];
  for (const [cat, es] of ordered) {
    lines.push(`*${cat}* — ${totalsLine(es)}  _(${es.length})_`);
  }
  lines.push(`\n*Total* ${totalsLine(rows)} over ${rows.length} entries`);
  return lines.join("\n");
}

// ── watchlist ───────────────────────────────────────────────────────────────

async function cmdWatchlist(args, pat) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const verb = (_nullishCoalesce(parts[0], () => ( ""))).toLowerCase();

  if (verb === "add" || verb === "remove" || verb === "rm" || verb === "del") {
    const syms = parts.slice(1).map((s) => s.toUpperCase().replace(/^NSE:/, ""));
    if (!syms.length) return `Which symbol? \`/watchlist ${verb} TCS\``;
    let result = "";
    const ok = await update(WATCH_FILE, [], pat, `chore: watchlist ${verb} ${syms.join(",")}`,
      (d) => {
        if (verb === "add") {
          const added = syms.filter((s) => !d.includes(s));
          result = added.length
            ? `👁 Watching *${added.join(", ")}*  _(${d.length + added.length} total)_`
            : "Already on the list.";
          return [...d, ...added];
        }
        const gone = syms.filter((s) => d.includes(s));
        result = gone.length ? `🗑 Removed *${gone.join(", ")}*` : "Not on the list.";
        return d.filter((s) => !syms.includes(s));
      });
    return ok ? result : FAILED;
  }

  const { data } = await read(WATCH_FILE, [], pat);
  if (!data.length) return "Watchlist is empty.\n\n`/watchlist add TCS INFY`";
  return `👁 *Watchlist* (${data.length})\n\n${data.map((s) => `• ${s}`).join("\n")}\n\n` +
         "`/watchlist add TCS` · `/watchlist remove TCS`";
}

// ── market ──────────────────────────────────────────────────────────────────

async function cmdMarket() {
  // news.askakshay.com/api/ticker is public and already aggregates indices,
  // commodities, FX and crypto with the correct per-symbol units. Rebuilding
  // that here would be a second source of truth for the same numbers.
  try {
    const r = await fetch("https://news.askakshay.com/api/ticker", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    // Field names must match what /api/ticker actually returns: `name` and
    // `change_pct`. This read `label` and `change`, which do not exist on an
    // item, so every row rendered as literal "undefined" under two headings —
    // the headings worked because those ARE on the segment.
    const segs


 = _nullishCoalesce(j.segments, () => ( []));

    // Real segment labels are INDIA, ASIA, EUROPE, US, COMMODITIES, FX,
    // CRYPTO... The old list guessed at "indian indices" / "forex" and matched
    // nothing but the two it happened to spell correctly.
    const want = ["india", "commodities", "fx", "crypto"];
    const picked = want
      .map((w) => segs.find((s) => (_nullishCoalesce(s.label, () => ( ""))).toLowerCase() === w))
      .filter((s) => !!s);
    if (!picked.length) return "Market feed returned nothing usable.";

    const lines = [`📈 *Markets* — ${istStamp()} IST\n`];
    for (const s of picked) {
      lines.push(`*${s.label}*`);
      for (const it of (_nullishCoalesce(s.items, () => ( []))).slice(0, 6)) {
        const c = it.change_pct;
        const arrow =
          c == null ? "" : c > 0 ? `🟢 +${c.toFixed(2)}%` : c < 0 ? `🔴 ${c.toFixed(2)}%` : "⚪️ 0.00%";
        lines.push(`  ${it.name}  ${_nullishCoalesce(it.price, () => ( ""))}  ${arrow}`.trimEnd());
      }
      lines.push("");
    }
    lines.push("_news.askakshay.com_");
    return lines.join("\n");
  } catch (e) {
    return `⚠️ Market feed unreachable (${(e ).message}). The site's /api/ticker may be down.`;
  }
}

// ── summaries ───────────────────────────────────────────────────────────────

async function summarise(days, pat) {
  const winDays = daysBack(days);
  const win = new Set(winDays);
  const [h, j, x] = await Promise.all([
    read(HABITS_FILE, EMPTY_HABITS, pat),
    read(JOURNAL_FILE, [], pat),
    read(EXPENSE_FILE, [], pat),
  ]);

  const label = days === 1 ? `Today — ${istDate()}` : `Last ${days} days`;
  const lines = [`🗓 *${label}*\n`];

  const total = h.data.habits.length;
  if (total) {
    // Only ticks belonging to habits that still exist. Removing a habit keeps
    // its history on purpose, so counting raw log entries against the current
    // habit count produced totals like "2/1 (200%)".
    const live = new Set(h.data.habits.map((a) => a.name));
    const hits = winDays.reduce(
      (a, d) => a + (_nullishCoalesce(h.data.log[d], () => ( []))).filter((n) => live.has(n)).length, 0);
    const possible = total * days;
    lines.push(`*Habits* — ${hits}/${possible} (${Math.round((hits / possible) * 100)}%)`);
    if (days === 1) {
      const done = _nullishCoalesce(h.data.log[istDate()], () => ( []));
      const missing = h.data.habits.map((a) => a.name).filter((n) => !done.includes(n));
      if (missing.length) lines.push(`  ⬜️ open: ${missing.join(", ")}`);
      else lines.push("  ✅ all done");
    } else {
      const top = h.data.habits
        .map((a) => ({ n: a.name, c: winDays.filter((d) => (_nullishCoalesce(h.data.log[d], () => ( []))).includes(a.name)).length }))
        .sort((a, b) => b.c - a.c);
      if (top[0]) lines.push(`  best: ${top[0].n} ${top[0].c}/${days}`);
      if (top.length > 1) lines.push(`  worst: ${top[top.length - 1].n} ${top[top.length - 1].c}/${days}`);
    }
    lines.push("");
  }

  const spend = x.data.filter((e) => win.has(e.ts.slice(0, 10)));
  lines.push(`*Spend* — ${totalsLine(spend)}  _(${spend.length} entries)_`);
  if (spend.length) {
    const byCat = {};
    for (const e of spend) (byCat[e.cat] ??= []).push(e);
    const top = Object.entries(byCat)
      .sort((a, b) => b[1].reduce((s, e) => s + e.amount, 0) - a[1].reduce((s, e) => s + e.amount, 0))[0];
    if (top) lines.push(`  biggest: ${top[0]} ${totalsLine(top[1])}`);
  }
  lines.push("");

  const notes = j.data.filter((e) => win.has(e.ts.slice(0, 10)));
  lines.push(`*Journal* — ${notes.length} entr${notes.length === 1 ? "y" : "ies"}`);
  if (notes.length) lines.push(`  _"${notes[notes.length - 1].text.slice(0, 90)}"_`);

  return lines.join("\n");
}

// ── dispatch table ──────────────────────────────────────────────────────────



const HANDLERS = {
  "/habits": cmdHabits,
  "/habit": cmdHabits,
  "/addhabit": cmdAddHabit,
  "/removehabit": cmdRemoveHabit,
  "/streak": cmdStreak,
  "/streaks": cmdStreak,
  "/habitstats": cmdHabitStats,
  "/journal": cmdJournal,
  "/note": (a, pat) => cmdNote(a, pat, "note"),
  "/learn": (a, pat) => cmdNote(a, pat, "learning"),
  "/notes": (a, pat) => cmdNotes(a, pat),
  "/expense": cmdExpense,
  "/expenses": cmdExpenses,
  "/watchlist": cmdWatchlist,
  "/market": () => cmdMarket(),
  "/summary": (_a, pat) => summarise(1, pat),
  "/weeklysummary": (_a, pat) => summarise(7, pat),
};

export function isPersonalCommand(cmd) {
  return cmd in HANDLERS;
}

export async function handlePersonal(cmd, args, pat) {
  const fn = HANDLERS[cmd];
  if (!fn) return null;
  try {
    return await fn(args, pat);
  } catch (e) {
    // Never fall through to silence. Silence is what these commands did for
    // months, and it is indistinguishable from the bot being down.
    console.error(`${cmd} failed:`, e);
    return `⚠️ \`${cmd}\` failed: ${(e ).message.slice(0, 120)}`;
  }
}
