 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }
import { timingSafeEqual } from "node:crypto";
import { isPersonalCommand, handlePersonal } from "./personal-commands.js";
import {
  cmdToday, cmdSignals, cmdPerf, cmdWorld, cmdBrief,
  cmdMarkets, cmdPositions, cmdSip, cmdNews, cmdFunds,
  cmdIdeas, cmdDesk, cmdEngine, cmdScreen, cmdListings, cmdHealth,
} from "./edition.js";

// Read commands that mirror a section of news.askakshay.com. Every one reads
// the site's own live API, so the bot cannot quote a number the page does not.
const EDITION = {
  "/today": cmdToday,
  "/edition": cmdToday,
  // Same endpoints the 6 AM scheduled brief reads, so the on-demand copy and
  // the one that arrives at breakfast cannot disagree.
  "/brief": cmdBrief,
  "/morning": cmdBrief,
  "/signals": cmdSignals,
  "/active": cmdSignals,
  "/perf": cmdPerf,
  "/edge": cmdPerf,
  "/world": cmdWorld,
  "/markets": cmdMarkets,
  "/positions": cmdPositions,
  "/book": cmdPositions,
  "/sip": cmdSip,
  "/funds": cmdFunds,
  "/mf": cmdFunds,
  "/news": cmdNews,
  // New listings and data health. /book is already the trading book, so the
  // literature section is not routed here.
  "/listings": cmdListings,
  "/ipos": cmdListings,
  "/ipo": cmdListings,
  "/health": cmdHealth,
  "/data": cmdHealth,
  "/ideas": cmdIdeas,
  "/picks": cmdIdeas,
};

// Edition commands that take an argument. Separate map because EDITION's
// handlers take none — one table with an optional parameter would let a
// no-arg command be called with one and quietly ignore it.
const WITH_ARGS = {
  // The stock screen. Takes a symbol, a preset or a ranking mode — bare
  // /screen gives the top 10. Reads the two static payloads the 6 AM build
  // writes, so it cannot quote a number the site does not show.
  "/screen": cmdScreen,
  "/stock": cmdScreen,
  "/screener": cmdScreen,
  "/desk": cmdDesk,
  "/engine": cmdEngine,
  "/rules": cmdEngine,
  "/changelog": cmdEngine,
};


const TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const GH_RAW = "https://raw.githubusercontent.com/caakshayk1-boop/trading-dashboard/main/data";
const WEBHOOK_URL = "https://terminal.askakshay.com/api/telegram/webhook";

// Telegram REJECTS a message over 4096 characters outright — it does not
// truncate it. The reply simply never arrives, the API returns 400, and
// nothing here used to look at the response, so an over-long answer vanished
// without a trace. /stock on a company with a full flag list clears 4096
// comfortably, so this is load-bearing, not defensive.
const TG_LIMIT = 4096;

// Split on line boundaries so Markdown emphasis, which this bot opens and
// closes within a single line, is never cut in half. A single line longer than
// the limit is hard-split: there is nothing better available, and it is rare.
function chunk(text, limit = TG_LIMIT) {
  const out = [];
  let buf = "";
  for (const line of String(text == null ? "" : text).split("\n")) {
    if (line.length > limit) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    if (buf && buf.length + 1 + line.length > limit) { out.push(buf); buf = line; }
    else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

async function tg(chatId, text) {
  for (const part of chunk(text)) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: "Markdown" }),
      });
      // A 400 here is nearly always unbalanced Markdown in a name the escaper
      // missed. Retrying as plain text delivers the answer rather than losing
      // it, and the log line says which command produced it.
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error(`[tg] ${r.status} on ${part.length} chars: ${body.slice(0, 200)}`);
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: part }),
        }).catch(() => {});
      }
    } catch (e) {
      console.error(`[tg] send failed: ${e && e.message}`);
    }
  }
}

async function gh(name) {
  try {
    const r = await fetch(`${GH_RAW}/${name}.json`, { cache: "no-store" });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : (_nullishCoalesce(_nullishCoalesce(_optionalChain([d, 'optionalAccess', _ => _.all_signals]), () => ( _optionalChain([d, 'optionalAccess', _2 => _2.signals]))), () => ( [])));
  } catch (e2) { return []; }
}

function fmtSignal(s) {
  const act = (s.action || s.signal || "BUY").toUpperCase();
  const em  = act === "BUY" ? "🟢" : act === "SELL" ? "🔴" : "🔵";
  let line  = `${em} *${s.symbol}* — ${act}`;
  const entry = _nullishCoalesce(s.entry, () => ( s.price));
  if (entry) line += `\n   Entry \`${entry}\``;
  if (s.sl)  line += ` | SL \`${s.sl}\``;
  if (_nullishCoalesce(s.target1, () => ( s.t1))) line += ` | T1 \`${_nullishCoalesce(s.target1, () => ( s.t1))}\``;
  if (s.rr)  line += ` | RR ${s.rr}`;
  return line;
}

async function dispatch(command, chatId, args) {
  // Every failure here used to be silent: no PAT, an expired PAT, or a rejected
  // dispatch all returned normally and the user just never got a reply. Tell
  // them instead — a command that says it failed beats one that vanishes.
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    console.error("GITHUB_PAT not set");
    await tg(chatId, "⚠️ Command runner not configured — `GITHUB_PAT` is missing on the server.");
    return;
  }
  try {
    const r = await fetch(
      "https://api.github.com/repos/caakshayk1-boop/trading-dashboard/actions/workflows/on_demand.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: { command, chat_id: chatId, args } }),
      }
    );
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 180);
      console.error(`dispatch ${command} failed: ${r.status} ${detail}`);
      await tg(
        chatId,
        r.status === 401 || r.status === 403
          ? "⚠️ GitHub token rejected (expired or missing `workflow` scope). Rotate `GITHUB_PAT`."
          : `⚠️ Could not start \`${command}\` — GitHub returned ${r.status}.`
      );
    }
  } catch (e) {
    console.error(`dispatch ${command} error:`, e);
    await tg(chatId, `⚠️ Could not reach GitHub to run \`${command}\`. Try again shortly.`);
  }
}

// ── Webhook authentication ──────────────────────────────────────────────────
// This endpoint dispatches GitHub Actions and commits to a PRIVATE repo with a
// repo+workflow PAT. It accepted anonymous POSTs from 2026-08 until 2026-09-04.
// Two independent conditions now guard it, and an unset secret FAILS CLOSED —
// an unset secret must never mean "no auth" (CLAUDE.md, and the same rule
// TradeFlow Pro's apiGuard.ts already enforces).
//
// Setting TELEGRAM_WEBHOOK_SECRET is NOT optional: until it is set in Vercel
// AND the webhook is re-registered with the same value, every update is
// rejected 503 and the bot is silent. Order: set env -> deploy -> re-register.
function eq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  if (x.length !== y.length) return false;   // timingSafeEqual throws on length mismatch
  return timingSafeEqual(x, y);
}



function authenticate(req, chatId) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return { ok: false, status: 503, why: "TELEGRAM_WEBHOOK_SECRET is not set" };

  const got = _nullishCoalesce(req.headers.get("x-telegram-bot-api-secret-token"), () => ( ""));
  if (!eq(got, secret)) return { ok: false, status: 401, why: "bad secret token" };

  // Defence in depth: even a leaked secret can only drive YOUR chat.
  const allowed = process.env.TELEGRAM_CHAT_ID;
  if (!allowed) return { ok: false, status: 503, why: "TELEGRAM_CHAT_ID is not set" };
  if (chatId !== allowed) return { ok: false, status: 401, why: "chat not allow-listed" };

  return { ok: true };
}

// ── POST — receives Telegram updates ────────────────────────────────────────

async function POST(req) {
  try {
    const body = await req.json();
    const msg  = _nullishCoalesce(_optionalChain([body, 'optionalAccess', _3 => _3.message]), () => ( _optionalChain([body, 'optionalAccess', _4 => _4.edited_message])));
    if (!msg) return Response.json({ ok: true });

    const chatId = String(_nullishCoalesce(_optionalChain([msg, 'access', _5 => _5.chat, 'optionalAccess', _6 => _6.id]), () => ( "")));
    const text   = (_nullishCoalesce(msg.text, () => ( ""))).trim();
    if (!text || !chatId) return Response.json({ ok: true });

    // Authenticate BEFORE dispatching anything. Everything below this line can
    // start CI or write to a private repo.
    const auth = authenticate(req, chatId);
    if (!auth.ok) {
      console.warn(`webhook rejected (${auth.status}): ${auth.why}`);
      return Response.json({ ok: false, error: auth.why }, { status: auth.status });
    }

    const tl    = text.toLowerCase();
    const parts = text.split(/\s+/);
    const cmd   = parts[0].toLowerCase().replace(/@.*$/, "");

    // ── Fast reads ────────────────────────────────────────────────────────

    if (cmd === "/start" || cmd === "/help" || tl === "help" || tl === "?") {
      // This lists every command the BotFather menu advertises. It drifted
      // once — thirteen menu entries had no handler and replied with silence —
      // so anything added to the menu belongs here and in HANDLERS.
      await tg(chatId,
        "🤖 *Dhruvedge Bot* — news.askakshay.com in your pocket\n\n" +
        "*The edition* _(same numbers as the site)_\n" +
        "`/today` — the whole edition in one screen\n" +
        "`/brief` — the morning brief: markets, wire, setups, edge\n" +
        "`/signals` — open setups, gated engine\n" +
        "`/perf` — expectancy, win rate, by month\n" +
        "`/positions` — what you actually hold\n" +
        "`/world` — last 24h · `/news` — market news\n" +
        "`/markets` — live snapshot · `/sip` — buckets\n" +
        "`/funds` — SIP screen, top 3 per category\n" +
        "`/screen` — stock screen, ~750 NSE names\n" +
        "`/screen TCS` — one company in full\n" +
        "`/screen quality|cheap|growth|breakout|rs|oversold|debtfree`\n" +
        "`/screen investor|positional|swing` — ranked for a horizon\n" +
        "`/ideas` — this week's top 5 trade ideas\n" +
        "`/listings` — every NSE IPO in the last 12 months, and what it did\n" +
        "`/health` — which datasets are current, and which are not\n" +
        "`/engine` — rule changes the ledger forced, with the evidence\n" +
        "   _`/engine selection` · `/engine rejected` to filter_\n" +
        "`/desk` — the practice: chess, wisdom, Spanish, fatherhood…\n\n" +
        "*Capture it*\n" +
        "`/note <text>` — a thought on today's edition\n" +
        "`/learn <text>` — something you learned\n" +
        "`/notes` — today · `/notes 7` — last 7 days\n" +
        "`/journal <text>` — the day, not the paper\n\n" +
        "*Run something (30–90s)*\n" +
        "`/scanner` or `Scan` — swing scan\n" +
        "`Trade: NSE:TCS` — trade setup\n" +
        "`Research: NSE:TCS` — full brief\n" +
        "`/cf` · `/magic` · `/intraday`\n\n" +
        "*Habits*\n" +
        "`/habits` — today's board · `/habits gym` ticks it\n" +
        "`/addhabit Gym` · `/removehabit Gym`\n" +
        "`/streak` · `/habitstats`\n\n" +
        "*Money*\n" +
        "`/expense 450 food lunch` — ₹ by default\n" +
        "`/expense 45 myr groceries` — ringgit\n" +
        "`/expenses` — this month · `/expenses 7` — 7 days\n\n" +
        "*Roll-ups*\n" +
        "`/summary` — today · `/weeklysummary` — 7 days\n" +
        "`/watchlist` — list · `add TCS` · `remove TCS`\n" +
        "`/stats` — bot status\n\n" +
        "_An OPEN setup is not a position. /signals is the first, /positions the second._"
      );
      return Response.json({ ok: true });
    }

    // ── Habits, journal, expenses, watchlist, market, summaries ───────────
    // Registered in the BotFather menu for months with nothing behind them.
    // These read and write data/*.json in the trading-dashboard repo through
    // the Contents API — same store this route already reads from, and no
    // credential beyond the GITHUB_PAT it already holds.
    if (isPersonalCommand(cmd)) {
      const pat = process.env.GITHUB_PAT;
      if (!pat) {
        await tg(chatId, "⚠️ `GITHUB_PAT` is missing on the server — nothing can be saved or read.");
        return Response.json({ ok: true });
      }
      const reply = await handlePersonal(cmd, text.slice(parts[0].length).trim(), pat);
      if (reply) await tg(chatId, reply);
      return Response.json({ ok: true });
    }

    if (cmd === "/stats") {
      const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
      await tg(chatId,
        `⚙️ *Bot Status* — ${ist}\n\n` +
        `DB: Turso ☁️ · Webhook: Vercel ✅\n\n` +
        `*Scheduled (GH Actions):*\n` +
        `Brief: 6:00 IST · Paper: 6:00 IST\n` +
        `NSE positions: 10:30 · 16:30 IST\n` +
        `US positions: 08:30 IST (after the US close)\n` +
        `Careers: 16:00 MYT · Market intel: 19:00 IST\n` +
        `Stock screen + listings: Sun 02:30 · 03:30 IST\n\n` +
        `_Railway ❌ shutdown — zero cost_`
      );
      return Response.json({ ok: true });
    }

    // ── the edition ───────────────────────────────────────────────────────
    // These used to read raw JSON out of the trading-dashboard repo and slice
    // the first N rows with no status filter, which is why /signals answered
    // with trades that had been stopped out days earlier — 336 of those 605
    // rows are SL_HIT. They now read the site's own API, filtered server-side.
    if (WITH_ARGS[cmd]) {
      try {
        await tg(chatId, await WITH_ARGS[cmd](text.slice(parts[0].length).trim()));
      } catch (e) {
        console.error(`${cmd} failed:`, e);
        await tg(chatId, `⚠️ \`${cmd}\` could not read today's edition: ${(e ).message.slice(0, 120)}`);
      }
      return Response.json({ ok: true });
    }

    if (EDITION[cmd]) {
      try {
        await tg(chatId, await EDITION[cmd]());
      } catch (e) {
        console.error(`${cmd} failed:`, e);
        await tg(chatId, `⚠️ \`${cmd}\` could not reach the ledger: ${(e ).message.slice(0, 120)}`);
      }
      return Response.json({ ok: true });
    }

    if (cmd === "/trades") {
      // Kept as an alias, but pointed at the same open-setups view so it can
      // never disagree with /signals.
      await tg(chatId, await cmdSignals().catch((e) => `⚠️ ${e.message}`));
      return Response.json({ ok: true });
    }

    if (cmd === "/vercel") {
      const sub = (_nullishCoalesce(parts[1], () => ( "all"))).toLowerCase();
      const data = await gh(sub === "ohl" ? "ohl_signals" : "all_signals");
      const items = data.slice(0, 8);
      if (!items.length) {
        await tg(chatId, "No data from scanner yet.");
      } else {
        const lines = [`🔍 *Scanner Dump*\n`];
        items.forEach((s) => lines.push(fmtSignal(s)));
        await tg(chatId, lines.join("\n"));
      }
      return Response.json({ ok: true });
    }

    // ── Slow commands → GitHub Actions dispatch ───────────────────────────

    const SLOW = {
      "scan":      { cmd: "scan",     ack: "⚡ Running swing scan (~60s)..." },
      "/scan":     { cmd: "scan",     ack: "⚡ Running swing scan (~60s)..." },
      // The menu calls it /scanner; the handler had only ever answered /scan.
      "/scanner":  { cmd: "scan",     ack: "⚡ Running swing scan (~60s)..." },
      "scanner":   { cmd: "scan",     ack: "⚡ Running swing scan (~60s)..." },
      "/cf":       { cmd: "cf",       ack: "🌍 Running Forex & Commodity scan..." },
      "cf scan":   { cmd: "cf",       ack: "🌍 Running Forex & Commodity scan..." },
      "/magic":    { cmd: "magic",    ack: "🔮 Running Magic screener (~3–5 min)..." },
      "/intraday": { cmd: "intraday", ack: "📊 Running intraday scan..." },
      "intraday":  { cmd: "intraday", ack: "📊 Running intraday scan..." },
    };

    if (SLOW[tl]) {
      await tg(chatId, SLOW[tl].ack);
      await dispatch(SLOW[tl].cmd, chatId, "");
      return Response.json({ ok: true });
    }

    // Strip the leading keyword and any separator, then keep everything after
    // it. Splitting on the FIRST colon looked equivalent and was not:
    // "Brief NSE:TCS" split there yields "TCS" and silently drops the
    // exchange prefix. "Research" is the phrasing this actually gets asked in.
    const verb = tl.match(/^(brief|research|trade|carousel)\s*:?\s*/);
    if (verb && (verb[1] === "brief" || verb[1] === "research")) {
      const args = text.slice(verb[0].length).trim();
      await tg(chatId, `📋 Fetching research on *${args}*...`);
      await dispatch("brief", chatId, args);
      return Response.json({ ok: true });
    }

    if (verb && verb[1] === "trade") {
      const args = text.slice(verb[0].length).trim();
      await tg(chatId, `📈 Fetching trade setup for *${args}*...`);
      await dispatch("trade", chatId, args);
      return Response.json({ ok: true });
    }

    if (verb && verb[1] === "carousel") {
      const args = text.slice(verb[0].length).trim();
      await tg(chatId, `🎨 Generating carousel: *${args}*...`);
      await dispatch("carousel", chatId, args);
      return Response.json({ ok: true });
    }

    if (tl.startsWith("/track")) {
      await dispatch("track", chatId, text.slice(7).trim());
      return Response.json({ ok: true });
    }

  } catch (e) {
    console.error("webhook error", e.message);
  }
  return Response.json({ ok: true });
}

// ── GET — register or check webhook ─────────────────────────────────────────

async function GET(req) {
  const url    = new URL(req.url);
  const reg    = url.searchParams.get("register");
  const secret = url.searchParams.get("secret");
  const dry    = url.searchParams.get("preview");

  // Render a read command WITHOUT sending it. Gated on the same secret as
  // registration, because it reads the ledger. The alternative when changing
  // these commands is to fire each one at a real phone and eyeball forty
  // Telegram messages, which is how formatting bugs ship: nobody re-reads the
  // fortieth. Only the edition commands are exposed — nothing here writes.
  if (dry) {
    if (secret !== process.env.WEBHOOK_REGISTER_SECRET) {
      return Response.json({ ok: false, error: "bad secret" }, { status: 401 });
    }
    const key = dry.startsWith("/") ? dry : `/${dry}`;
    // WITH_ARGS commands are read-only too, and they are the ones whose output
    // varies with input — the ones most worth previewing. `?args=` feeds them;
    // it is ignored by the no-arg table so a stray value cannot change a reply.
    const withArgs = WITH_ARGS[key];
    const plain = EDITION[key];
    if (!withArgs && !plain) {
      return Response.json(
        {
          ok: false,
          error: `no such edition command`,
          available: [...Object.keys(EDITION), ...Object.keys(WITH_ARGS)],
        },
        { status: 404 }
      );
    }
    try {
      const text = withArgs
        ? await withArgs(_nullishCoalesce(url.searchParams.get("args"), () => ( "")))
        : await plain();
      return Response.json({ ok: true, command: dry, chars: text.length, text });
    } catch (e) {
      return Response.json({ ok: false, error: (e ).message }, { status: 500 });
    }
  }

  if (reg !== "1" || secret !== process.env.WEBHOOK_REGISTER_SECRET) {
    // Health, not just "ready". A silent bot has exactly one visible symptom —
    // nothing happens — and every cause looks identical from the outside:
    // Telegram reports the webhook healthy (it gets its 200), the function
    // runs, and the reply dies on the way out. This says which link is broken
    // WITHOUT revealing any secret: booleans for presence, and the bot handle
    // getMe reports back, which is public information anyway.
    const tokenPresent = !!TOKEN;
    let bot = null;
    let botError = null;
    if (tokenPresent) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, {
          cache: "no-store",
        });
        const j = await r.json();
        if (_optionalChain([j, 'optionalAccess', _7 => _7.ok])) bot = `@${_optionalChain([j, 'access', _8 => _8.result, 'optionalAccess', _9 => _9.username])}`;
        else botError = `${_nullishCoalesce(_optionalChain([j, 'optionalAccess', _10 => _10.error_code]), () => ( r.status))}: ${_nullishCoalesce(_optionalChain([j, 'optionalAccess', _11 => _11.description]), () => ( "rejected"))}`;
      } catch (e) {
        botError = e instanceof Error ? e.message : "unreachable";
      }
    }
    return Response.json({
      webhook_url: WEBHOOK_URL,
      status: tokenPresent && bot ? "ready" : "degraded",
      // Presence only. Never the values.
      env: {
        TELEGRAM_BOT_TOKEN: tokenPresent,
        TELEGRAM_CHAT_ID: !!process.env.TELEGRAM_CHAT_ID,
        GITHUB_PAT: !!process.env.GITHUB_PAT,
        WEBHOOK_REGISTER_SECRET: !!process.env.WEBHOOK_REGISTER_SECRET,
        TELEGRAM_WEBHOOK_SECRET: !!process.env.TELEGRAM_WEBHOOK_SECRET,
      },
      bot,
      bot_error: botError,
    });
  }

  const r = await fetch(
    `https://api.telegram.org/bot${TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        drop_pending_updates: true,
        // Telegram echoes this back in x-telegram-bot-api-secret-token on
        // every update. Without it the POST handler rejects everything.
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      }),
    }
  );
  const data = await r.json();
  return Response.json({ ...data, registered_url: WEBHOOK_URL });
}


/* ── WORKER ENTRY ────────────────────────────────────────────────────────────
 *
 * This handler moved off Vercel (akk-terminal) because that project was being
 * dissolved, and it was the only thing on it that anything still depended on:
 * Telegram was delivering every bot command to
 * terminal.askakshay.com/api/telegram/webhook, healthy, with zero pending
 * updates. Deleting the project without moving this first would have taken
 * every command down — /confirm, habits, journal, expenses, watchlist.
 *
 * Almost nothing had to change. This Worker already runs with nodejs_compat
 * and nodejs_compat_populate_process_env, so the copied code keeps reading
 * process.env and keeps using node:crypto's timingSafeEqual and Buffer
 * exactly as it did on Vercel. Only Next's request and response wrappers were
 * Next-specific, and both have standard equivalents.
 *
 * Signal's router hands a handler (request, env) and dispatches on path, not
 * method — so the method split that Next expressed as two exported functions
 * is done here instead. */
export default async function telegramWebhook(request, env) {
  if (request.method === "POST") return POST(request);
  if (request.method === "GET")  return GET(request);
  // Telegram only ever POSTs. Anything else is a probe; say so plainly rather
  // than letting it fall through to a handler that would misread it.
  return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
}
