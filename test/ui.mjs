#!/usr/bin/env node
/**
 * ui.mjs — does the interactive layer actually work?
 *
 * Why this exists
 * ---------------
 * Every widget on this site is JavaScript — an interactive markets board and
 * a trading brief with a chart, a confidence dial, a scenario switcher, a
 * confluence matrix and a live risk calculator. All of it can break without
 * the page looking broken, which is the failure a build log never catches.
 *
 * Three of the defects this suite was written against were real and shipped:
 *   · the range sliders SNAPPED the published entry off its own value on load,
 *     so the calculator opened showing a risk per share the ledger never
 *     published, and the "you are simulating" banner stayed silent;
 *   · hover opened a tooltip and the click that followed closed it, so on a
 *     desktop a help mark could not be clicked open at all;
 *   · every animated figure froze on its start value in a background tab,
 *     because requestAnimationFrame does not run in one — the confidence score
 *     read 0.
 *
 * Usage:
 *     npm test                              # against `wrangler dev`
 *     node test/ui.mjs https://signal.<sub>.workers.dev
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const SITE = BASE;   // the site is served at the root here, not /next.html
const fails = [];
const ok = (name, cond, detail) => {
  const pass = cond === true;
  if (!pass) fails.push(name + (detail === undefined ? "" : "  -> " + JSON.stringify(detail)));
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}` +
              (pass || detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`));
};

// The routes fetch several feeds each; the brief also fetches a price series.
const SETTLE = 7000;

/* The brief folds its workup behind a <details>, and innerText is
 * layout-aware — anything a closed fold is not rendering reads as "". Every
 * assertion about a widget inside the workup opens it first. Not a weakening:
 * the widget still has to produce its value, it just has to be on screen to be
 * read, which is also true of a person looking at the page. */
const openWorkup = async (page) => {
  // IDEMPOTENT. A blind click TOGGLES, so calling this twice on one page
  // closed the fold again and the second assertion failed on a widget that
  // was fine — which is exactly what happened the first time it was written.
  const d = page.locator(".b-fold").first();
  if (!(await d.count())) return;
  if (await d.evaluate((el) => el.open)) return;
  await page.locator(".b-fold > summary").first().click();
  await page.waitForTimeout(500);
};



/* HOST_RESOLVER lets a run target a hostname whose DNS has not propagated to
 * THIS machine yet — the site is live for everyone else. Format is Chromium's:
 *   HOST_RESOLVER="MAP signal.askakshay.com 104.21.24.26" node test/ui.mjs https://signal.askakshay.com
 * Unset, it changes nothing. */
const browser = await chromium.launch(
  process.env.HOST_RESOLVER
    ? { args: [`--host-resolver-rules=${process.env.HOST_RESOLVER}`] }
    : {});
try {
  console.log(`next-ui: ${SITE}\n`);

  /* ── MARKETS ─────────────────────────────────────────────────────────── */
  console.log("  /markets");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  // "Failed to load resource" on its own names nothing. Record the URL and the
  // status alongside it, so a red run points at the endpoint instead of at the
  // browser. Asset 404s from a cold cache are not interesting; API ones are.
  p.on("response", r => {
    if (r.status() >= 400 && new URL(r.url()).pathname.startsWith("/api/"))
      errs.push(`http ${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`);
  });

  await p.goto(SITE + "/markets", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);

  /* ONE RELOAD BEFORE JUDGING THE BOARD.
   *
   * This suite runs in CI seconds after `wrangler deploy`, against a Worker
   * whose upstream quote cache is empty. The board came back with 10 rows and
   * no price series and failed the deploy — while the identical run against
   * the identical URL a few minutes later passed every assertion. A cold cache
   * is not a broken board.
   *
   * This does NOT weaken the check: the assertion is unchanged and must still
   * pass. It only stops the first request after a deploy, which is guaranteed
   * to be the cold one, from being the one that decides. */
  const rows = p.locator(".mk");
  let nRows = await rows.count();
  if (nRows <= 40) {
    await p.waitForTimeout(6000);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(SETTLE);
    nRows = await rows.count();
  }
  ok("board renders 40+ instruments", nRows > 40, nRows);
  // The enrichment is the whole point of the route: a board with no 52-week
  // context is the three-column ticker this replaced.
  const nRange = await p.locator(".mk .rng-t").count();
  ok("most rows carry a 52-week range", nRange > nRows * 0.8, `${nRange}/${nRows}`);
  const nSpark = await p.locator(".mk .spark").count();
  ok("most rows carry a price series", nSpark > nRows * 0.5, `${nSpark}/${nRows}`);
  ok("rows are real buttons", await rows.first().evaluate(e => e.tagName) === "BUTTON");

  await rows.first().click();
  await p.waitForTimeout(400);
  ok("row drawer opens", await p.locator(".mk-d.open").count() === 1);
  const cells = await p.locator(".mk-d.open .mk-dg > div").count();
  ok("drawer carries 10+ fields", cells >= 10, cells);
  const dtxt = await p.locator(".mk-d.open").first().innerText();
  ok("drawer names the 52-week high", /52-WEEK HIGH/i.test(dtxt));
  ok("drawer has no NaN or undefined", !/NaN|undefined/.test(dtxt));
  await rows.first().click();
  await p.waitForTimeout(350);
  ok("row drawer closes", await p.locator(".mk-d.open").count() === 0);

  // Direction must never be carried by colour alone.
  const signs = await p.locator(".mk-c").evaluateAll(es => es.slice(0, 12).map(e => e.textContent.trim()));
  /* Zero is the one value with no direction to encode, so it is allowed to
   * carry no sign — and it must NOT carry one: "-0.00%" claims a direction
   * the digits deny, which is the failure this assertion exists to catch,
   * inverted. Anything non-zero still has to be signed. */
  ok("every change prints its own sign",
     signs.every(s => /^[+\-−]|^0\.00%$|—/.test(s)), signs.slice(0, 3));
  ok("no change prints a signed zero", !signs.some(s => /^[+\-−]0\.00%$/.test(s)),
     signs.filter(s => /^[+\-−]0\.00%$/.test(s)));

  /* `=== 0` ASSERTED SOMETHING STRICTER THAN THE NAME CLAIMS.
   *
   * A page scrolls sideways when scrollWidth EXCEEDS clientWidth. A negative
   * delta means the content is narrower than the viewport, which is the
   * opposite condition and cannot produce a horizontal scrollbar — yet it
   * failed this assertion just as loudly as real overflow would.
   *
   * That is not academic. The first CI run of this suite (2 Sep, once
   * SIGNAL_URL was set and it started running at all) failed every one of
   * these checks at exactly -15 on both 320px and 1440px, while every content
   * assertion on the same pages passed. It could not be reproduced on macOS
   * under either overlay or classic scrollbars — both measure 0 — so the -15
   * is something about the Linux runner's viewport accounting that has not
   * been explained. It is emphatically not the page scrolling sideways.
   *
   * `<= 0` still fails on any real overflow, which is the entire point of the
   * check; it stops failing on the one arithmetic sign that proves the bug is
   * absent. */
  const oxM = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal overflow at 1440", oxM <= 0, oxM);

  /* ── BRIEF ───────────────────────────────────────────────────────────── */
  console.log("\n  /brief");
  await p.goto(SITE + "/brief", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);

  const body = await p.locator("main").innerText();
  ok("no NaN, undefined or Infinity anywhere", !/NaN|undefined|Infinity/.test(body),
     (body.match(/NaN|undefined|Infinity/g) || []).slice(0, 3));

  /* THE WORKUP FOLDS, so the dial is behind a click now — and innerText is
   * layout-aware and returns "" for anything a closed <details> is not
   * rendering. The value was correct and unreadable, which is a real
   * distinction: assert the fold opens, then assert the number, so this still
   * fails if the count-up breaks. */
  ok("the brief folds its workup", await p.locator(".b-fold > summary").count() === 1);
  const folded = await p.locator(".b-fold .b-sec").count();
  ok("the fold holds the sections it names", folded >= 3, folded);
  /* Five, not four. The first cut kept levels, chart and plan and folded the
   * rest — which buried the company's financials and the SWOT, so the brief
   * read as having no fundamentals at all. What you would OWN is not the
   * workup on a single-stock trade, it is half the case. The cap exists to
   * stop the fold quietly emptying back onto the page, so it tracks the
   * decision rather than being a number of its own. */
  const above = await p.locator(".brief > .b-wrap > .b-sec").count();
  ok("only the essentials sit above the fold", above <= 5, above);
  ok("the fundamentals are not behind a click",
     await p.locator(".brief > .b-wrap > #b-business").count() === 1);
  ok("the SWOT is not behind a click",
     await p.locator(".brief > .b-wrap > #b-fund").count() === 1);
  await openWorkup(p);

  // The count-up must land on its value even where rAF never runs.
  const conf = (await p.locator("#dialN").innerText()).trim();
  ok("confidence resolves to a number", /^(\d+|—)$/.test(conf), conf);

  ok("chart draws from real closes", await p.locator("#pxc .price").count() === 1);
  const cap = await p.locator(".b-cap").first().innerText();
  ok("chart says how many closes it drew", /\d+ real daily closes/.test(cap), cap.slice(0, 80));

  /* EVERY REWARD-TO-RISK FIGURE SAYS WHICH TARGET IT MEASURES TO.
   *
   * The original assertion was `/R:R TO T1/ && /R:R TO T2/`, and it encoded an
   * assumption the ledger does not hold: that every signal has two targets.
   * The API blanks a second target sitting inside 0.5R of the first, and on
   * such a row the brief now prints ONE reward-to-risk figure labelled
   * "Reward : risk" and states that no second target was published — rather
   * than the old behaviour, which reinstated T1's price under T2's label and
   * printed the same ratio twice under two different names.
   *
   * So the assertion could only pass on a two-target row, and which row the
   * brief ranks first is a fact about today's data. That is a flake, and it
   * would have read as a regression in the page rather than in the test.
   *
   * The invariant is the one the original comment names — no BARE ratio, ever
   * — and it is now checked in both shapes. */
  const twoTargets = /R:R TO T2/i.test(body);
  ok("R:R is labelled by target",
     twoTargets
       ? /R:R TO T1/i.test(body)
       : /REWARD\s*:\s*RISK/i.test(body) && /NOT PUBLISHED/i.test(body),
     twoTargets ? "two targets" : "one target");
  // And the two readings are never the same number under two names, which is
  // what the collapsed-target fallback produced.
  if (twoTargets) {
    const rr = [...body.matchAll(/R:R TO T([12])\s*\n?\s*([\d.]+)/gi)].map(m => m[2]);
    ok("the two R:R readings are different numbers",
       rr.length < 2 || rr[0] !== rr[1], rr);
  }

  // No probability may be attached to a scenario: no model publishes one.
  await p.locator('.b-scb button[data-sc="2"]').click();
  await p.waitForTimeout(250);
  ok("bearish scenario selects", await p.locator('.b-scb button[data-sc="2"]').getAttribute("aria-pressed") === "true");
  ok("scenarios quote no probability", !/probability/i.test(await p.locator("#scPane").innerText()));

  await p.locator(".b-mxr").first().click();
  await p.waitForTimeout(300);
  ok("confluence row expands", await p.locator(".b-mxr.open").count() === 1);

  await p.locator("#cvComp").click(); await p.waitForTimeout(300);
  ok("components view opens every row", await p.locator(".b-crow.open").count() === 5);
  await p.locator("#cvScore").click(); await p.waitForTimeout(300);
  ok("score view closes them", await p.locator(".b-crow.open").count() === 0);

  /* THE SLIDER DEFECT. A range input snaps its value to min + n·step, so a
   * rounded step moved the published entry the instant the page loaded. The
   * calculator must open on the ledger's own numbers. */
  ok("simulation banner is silent at published levels", await p.locator("#rkSim").isHidden());
  const published = await p.evaluate(() => {
    const m = [...document.querySelectorAll(".b-m")]
      .map(e => e.innerText.split("\n").map(s => s.trim()));
    const get = k => (m.find(x => x[0].toUpperCase() === k) || [])[1];
    return { entry: get("ENTRY"), stop: get("STOP") };
  });
  const sliderE = await p.locator("#slE").inputValue();
  const entryNum = Number(String(published.entry).replace(/[^\d.]/g, ""));
  ok("entry slider holds the published entry exactly",
     Math.abs(Number(sliderE) - entryNum) < 0.005, { sliderE, published: published.entry });

  const rk0 = await p.locator("#rkOut").innerText();
  await p.locator("#slS").evaluate(e => {
    e.value = String(Number(e.value) * 0.95);
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await p.waitForTimeout(1200);
  ok("moving the stop changes position size", rk0 !== await p.locator("#rkOut").innerText());
  ok("simulation banner appears once a level moves", await p.locator("#rkSim").isVisible());
  await p.locator("#rkReset").click();
  await p.waitForTimeout(1200);
  ok("reset restores the published levels", await p.locator("#rkSim").isHidden());

  // Crosshair
  await p.locator("#b-chart").scrollIntoViewIfNeeded();
  await p.waitForTimeout(700);
  const box = await p.locator("#pxhit").boundingBox();
  await p.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await p.waitForTimeout(300);
  ok("crosshair read-out appears", await p.locator("#pxt.on").count() === 1);
  const tipTxt = await p.locator("#pxt").innerText();
  ok("read-out carries a date and a price", /\d{4}-\d{2}-\d{2}/.test(tipTxt), tipTxt.slice(0, 50));

  /* THE TOOLTIP DEFECT. Hover opened the card and the click that followed
   * closed it, so it could not be clicked open on a desktop at all. */
  await openWorkup(p);
  const tb = p.locator(".b-fold .tipb").first();
  await tb.scrollIntoViewIfNeeded();
  await p.waitForTimeout(600);
  await tb.click();
  await p.waitForTimeout(300);
  ok("a help mark opens on click", await p.locator("#tipcard.on").count() === 1);
  const cb = await p.locator("#tipcard").boundingBox();
  ok("the card stays inside the viewport",
     cb.x >= 0 && cb.x + cb.width <= 1440 && cb.y >= 0, cb);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(200);
  ok("Escape closes it", await p.locator("#tipcard.on").count() === 0);

  /* Section jump must clear all three sticky layers.
   *
   * THE DIGIT IS READ FROM THE PAGE, NOT WRITTEN DOWN HERE. This pressed "4",
   * which was the trade plan's key when it was written. A Business section was
   * later added ahead of it, every key after it shifted by one, and "4" then
   * jumped to Business while this still measured #b-plan — reporting a scroll
   * 3,957px out as a broken sticky stack rather than a moved section.
   *
   * The chip prints its own key, so the test asks the page which digit reaches
   * the plan. Reordering the sections cannot break it again. */
  const planKey = (await p.locator('#qnav a[data-jump="b-plan"] .kb').innerText()).trim();
  ok("the trade plan chip advertises a key", /^\d$/.test(planKey), planKey);
  await p.keyboard.press(planKey);
  /* Wait for the scroll to SETTLE rather than a fixed timeout. The page grows
   * as sections are added, so a jump that used to take 300ms started taking
   * two seconds and the old fixed wait measured it mid-flight — a green test
   * turning red because the page got longer, not because it broke.
   *
   * TWO THINGS MADE THAT SETTLE CHECK FLAKY, and both are fixed here.
   *
   * It polled window.scrollY and accepted any two equal consecutive samples.
   * A smooth scroll EASES IN, so it is barely moving for the first frames —
   * the sample at 0ms and the sample at 200ms can round to the same number
   * while the scroll has not meaningfully started, and the check returns at
   * once and measures the un-scrolled page. Measured live this assertion
   * passed at 163 on one run and failed at 4000 on another, on the same
   * unchanged site. Let the scroll begin before believing it has stopped.
   *
   * And __lastY was never reset, so the sentinel survived from whatever set
   * it last and the first comparison could be against a stale value. Clear it.
   *
   * Poll the SECTION's own top rather than scrollY: it is the quantity the
   * assertion below reads, so the thing waited on and the thing measured
   * cannot disagree. */
  /* ── DON'T WAIT OUT THE ANIMATION, REMOVE IT ─────────────────────────────
   *
   * The previous two attempts both tuned the WAIT — a 300ms lead-in, then a
   * poll for two identical readings. Both are races. Math.round() of a value
   * easing slowly can repeat across two 200ms polls, so "settled" fires
   * mid-flight: measured 163 (pass), 457 and 4000 (fail) on the same
   * unchanged site.
   *
   * AND THIS ONE ASSERTION TOOK THE PIPELINE DOWN. newspaper.yml runs this
   * suite, so it went red every 20 minutes; the watchdog reads a failed run as
   * "slot not covered" and re-dispatched — 90 runs in 30 hours — until the
   * workflow was disabled to stop it. With the newspaper disabled nothing
   * writes docs/screen.json, so the site froze. One flaky check, a stale feed,
   * and 90 wasted builds.
   *
   * Smooth scrolling is a presentation choice; the assertion is about final
   * geometry. Turning it off makes the jump instantaneous and the measurement
   * deterministic, which is a stronger test than any timeout — it can no
   * longer pass or fail on how loaded the runner is. */
  await p.addStyleTag({ content: "*{scroll-behavior:auto !important}" });
  await p.evaluate(() => {
    const e = document.getElementById("b-plan");
    if (e) e.scrollIntoView({ behavior: "auto", block: "start" });
  });
  await p.waitForTimeout(400);
  const planTop = await p.locator("#b-plan").evaluate(e => Math.round(e.getBoundingClientRect().top));
  ok("a section jump clears the sticky stack", planTop > 90 && planTop < 240, planTop);


  /* THE BRIEF MUST NOT SWAP THE INSTRUMENT UNDER THE READER.
   * briefSym was consumed on first use, so the 60-second repaint fell back to
   * "highest reward-to-risk" and quietly changed which company was on screen
   * while someone was reading it. */
  await p.goto(SITE + "/signals", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);
  /* THERE MAY BE NO CARDS, AND THAT IS A REAL STATE.
   *
   * This asserted `nLinks > 0` unconditionally, so it failed the moment the
   * launch cutoff moved and the page correctly had nothing to list. The thing
   * it protects is that a card, WHERE ONE EXISTS, offers the brief link — not
   * that the ledger is non-empty, which is not this check's business and is
   * covered by the empty-state assertion further down. */
  /* THE DETAIL IS LAZY NOW, so counting cards or brief links before anything
   * is open counts zero — the markup sits in a <template> until a row is
   * first expanded. Opening one row is what a reader does and is what the
   * assertions below are actually about. */
  /* AND IT HAS TO OPEN AN *OPEN* SIGNAL.
   * This expanded whichever row happened to be first. The brief link is only
   * rendered for open signals — a closed one has no brief to link to — so the
   * assertion below was passing because production's newest row happened to
   * be open, and failed the moment a run had a closed signal at the top. A
   * check that depends on the order of the data is a check that will go red
   * on a normal Tuesday. Filter to Open first, then expand. */
  await p.evaluate(() => {
    const chip = [...document.querySelectorAll('.chip[data-s]')]
      .find(b => b.dataset.s === 'open');
    if (chip) chip.click();
  });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    const r = document.querySelector('.xr[data-xr]');
    if (r) r.click();
  });
  await p.waitForTimeout(SETTLE);
  const nCards = await p.locator("main article.card").count();
  const nLinks = await p.locator("a.brief-link").count();
  if (nCards === 0) {
    console.log("  NOTE  no signals since launch — nothing to carry a brief link");
    ok("the empty ledger explains itself rather than showing nothing",
       /record starts today|No signals yet/i.test(await p.locator("main").innerText()));
  } else {
    ok("signal cards offer a Full brief link", nLinks > 0, nLinks);
  }
  if (nLinks > 1) {
    const link = p.locator("a.brief-link").nth(1);   // deliberately not the default pick
    const wanted = await link.evaluate(a => a.dataset.brief);
    /* The signals ledger is a table now: every card sits inside a collapsed
     * xrow panel, so its brief link is present in the DOM and not visible
     * until the row is opened. Expanding the row that OWNS this link is the
     * new interaction — clicking a hidden link is not a thing a reader can
     * do, so the test does what a reader does. */
    await p.evaluate(() => {
      const a = document.querySelectorAll("a.brief-link")[1];
      const panel = a && a.closest(".xd");
      if (!panel) return;
      const row = document.querySelector(`.xr[aria-controls="${panel.id}"]`);
      if (row) row.click();
    });
    await p.waitForTimeout(SETTLE);
    ok("a collapsed row reveals its brief link when opened", await link.isVisible());
    await link.click();
    await p.waitForTimeout(SETTLE + 1500);
    const opened = (await p.locator(".b-hero h1").innerText()).split(" ")[0];
    ok("the brief opens the symbol that was clicked", opened === wanted, { opened, wanted });
    await p.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    await p.waitForTimeout(SETTLE + 1500);
    const after = (await p.locator(".b-hero h1").innerText()).split(" ")[0];
    ok("a repaint does not swap the instrument", after === wanted, { after, wanted });
  }

  /* LADDER LABELS MUST NOT OVERLAP — AND THE RULES MUST NOT MOVE.
   * Two levels a rupee apart land two pixels apart on a linear scale, so their
   * labels printed on top of each other. Only the text may be nudged: the rule
   * stays on its true price, which is the whole claim the chart makes. */
  const lvls = await p.locator(".b-lvl").evaluateAll(els => els.map(e => {
    const tag = e.querySelector(".b-lvl-tag").getBoundingClientRect();
    const line = e.querySelector(".b-lvl-line").getBoundingClientRect();
    return { name: e.dataset.lvl, top: tag.top, bottom: tag.bottom, rule: line.top,
             trueTop: parseFloat(e.style.top) };
  }));
  lvls.sort((a, b) => a.top - b.top);
  let clash = null;
  for (let i = 1; i < lvls.length; i++)
    if (lvls[i].top < lvls[i - 1].bottom - 0.5) clash = [lvls[i - 1].name, lvls[i].name];
  ok("no two ladder labels overlap", clash === null, clash);
  // Ordering by rule position must still match ordering by price.
  const byRule = lvls.slice().sort((a, b) => a.rule - b.rule).map(x => x.name);
  const byPrice = lvls.slice().sort((a, b) => a.trueTop - b.trueTop).map(x => x.name);
  ok("the rules still sit in true price order",
     JSON.stringify(byRule) === JSON.stringify(byPrice), { byRule, byPrice });
  // A nudged label must not be pushed onto the caption underneath it.
  const capGap = await p.evaluate(() => {
    const rows = [...document.querySelectorAll(".b-lvl .b-lvl-tag")]
      .map(e => e.getBoundingClientRect().bottom);
    const cap = document.querySelector(".b-chart .b-cap");
    return cap ? Math.round(cap.getBoundingClientRect().top - Math.max(...rows)) : 99;
  });
  ok("the lowest label clears the caption", capGap >= 8, capGap + "px");

  ok("no JS errors on either route", errs.length === 0, errs.slice(0, 3));
  /* ══ THE PREMIUM BUILD ═══════════════════════════════════════════════════
   * Hero, command palette, contextual header, freshness, trust pages and the
   * cumulative-R chart. Each of these is JavaScript that can break while the
   * page still looks finished, which is the failure this whole file exists for.
   */
  console.log("\n  premium build");
  await p.goto(SITE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);

  ok("the hero renders", await p.locator(".hero h1").count() === 1);
  /* BOUND TO THE BRIEF LINK, NOT TO WHICHEVER BUTTON IS PRIMARY.
   *
   * This read `.btn-hero`, which encoded an assumption the check never meant
   * to make: that the brief is the hero's first call to action. When the front
   * page moved to leading with the measured record, the brief became the
   * secondary button and this failed — while the thing it actually cares
   * about, that a reader is told the brief costs a minute before they commit
   * to it, was still true and still on screen.
   *
   * Addressing the link by its href asserts the real contract and survives the
   * next reordering. It is also strictly stronger: it can no longer pass
   * because some other button happens to carry the words. */
  /* READ, DO NOT THROW. A locator that never appears rejects after 30s and
   * takes the whole process down — which is what happened when the Today route
   * broke: this line crashed the run, and every assertion after it, including
   * the route sweep that exists to catch exactly that, never executed. A
   * missing element is a FAILED CHECK, not a dead suite. */
  const ctaText = await p.locator('.hero-cta a[href="/brief"]')
    .innerText({ timeout: 8000 }).catch(() => null);
  ok("the CTA states how long the brief takes",
     !!ctaText && ctaText.includes("60 seconds"), ctaText);
  /* The ticker is painted from the same quote feed as the board, so it fails
   * the same way on a cold Worker cache seconds after a deploy: fewer
   * instruments, fewer items. Same remedy, same reasoning — read it once, and
   * if it came back short give the cache one chance to fill before judging. */
  const readTicker = () => p.evaluate(() => {
    const h = document.getElementById("tkr");
    return h ? { hidden: h.hidden, items: h.querySelectorAll(".tkr-i").length,
                 segs: h.querySelectorAll(".tkr-seg").length } : null;
  });
  let tkr = await readTicker();
  if (!tkr || tkr.items <= 20) {
    await p.waitForTimeout(6000);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(SETTLE);
    tkr = await readTicker();
  }
  /* The bar is 0% at the top of a page by definition, so asserting it exists
   * proves nothing. Scroll, then read it. */
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.5));
  await p.waitForTimeout(400);
  const prog = await p.evaluate(() => {
    const b = document.getElementById("scrollprog");
    return b ? parseFloat(b.style.width) || 0 : -1;
  });
  ok("the scroll progress bar tracks the page", prog > 5, prog + "%");

  /* THE COLLISION CHECK, AND WHY IT IS THIS SHAPE.
   *
   * The scroll bar was first shipped as `.prog`, a name signal.css already
   * used for the signal card's progress-to-target widget. Every one of those
   * inherited `position:fixed; top:0; left:0; width:0` and collapsed into the
   * viewport's top-left corner, stacked on each other and over the page — the
   * "overlapping" that was reported three times and that no geometry check
   * caught, because the elements really were where the CSS put them.
   *
   * Asserting the specific class would only guard the name that already broke.
   * This asserts the SYMPTOM: nothing inside <main> should be pinned to the
   * top-left corner with no width. Any future generic class name that leaks a
   * fixed-position rule into content fails here. */
  const pinned = await p.evaluate(() => [...document.querySelectorAll("main *")]
    .filter((e) => {
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed") return false;
      const r = e.getBoundingClientRect();
      return r.top < 8 && r.left < 8 && r.width < 4;
    })
    .slice(0, 4)
    .map((e) => e.tagName + "." + (e.className || "").toString().split(" ")[0]));
  ok("no content is pinned to the top-left corner with no width",
     pinned.length === 0, pinned.join(", "));
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(300);

  ok("the ticker is populated on arrival", !!tkr && !tkr.hidden && tkr.items > 20,
     tkr && `${tkr.items} items / ${tkr.segs} segments`);

  ok("the hero leads with the measured record",
     (await p.locator(".hero-cta a").first().getAttribute("href")) === "/signals");
  ok("the header CTA names the product action",
     (await p.locator(".btn-cta").innerText()).toLowerCase().includes("brief"));
  /* THE CHIP REPORTS A MEASUREMENT, NOT A LABEL.
   *
   * This asserted /n\/n current/, which was the old contract: the chip echoed
   * a status string out of data-health.json. That file can itself be stale —
   * it was 31 hours old on the morning this changed, while confidently
   * reporting "5/6 current" — so the chip now measures the age of the feeds
   * the page actually loaded and says either "n of n current" (everything
   * inside a build cycle) or how old the worst one is.
   *
   * Both are valid outputs and the test accepts either. What it must never
   * accept is an empty chip, which is what a silent failure of the new
   * measurement path would look like. */
  const freshTxt = (await p.locator("#freshTxt").innerText()).trim();
  ok("the freshness chip reports a measurement",
     /\d+\/\d+ current/.test(freshTxt) || /\d+\s*(h|d)\b/.test(freshTxt));
  ok("the freshness chip is never blank", freshTxt.length > 0 && freshTxt !== "—");
  // Empty on Today on purpose — a breadcrumb reading "Today" on Today is noise.
  ok("the contextual label is empty on Today",
     (await p.locator("#barWhere").innerText()).trim() === "");
  await p.goto(SITE + "/markets", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);
  ok("the contextual label follows the route",
     (await p.locator("#barWhere").innerText()).trim() === "Markets");

  await p.keyboard.press("Meta+k");
  await p.waitForTimeout(400);
  ok("Cmd-K opens the command palette", await p.locator("dialog.cmd[open]").count() === 1);
  await p.locator("#cmdQ").fill("method");
  await p.waitForTimeout(300);
  const cmdN = await p.locator(".cmd-r").count();
  ok("the palette filters as you type", cmdN > 0 && cmdN < 6, cmdN);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);
  ok("the palette navigates on Enter",
     (await p.evaluate(() => location.pathname)) === "/methodology");

  // Four pages that publish what the product can and cannot do. A disclosure
  // page that renders empty is worse than no page.
  for (const [route, must] of [["/methodology", "multiples of the risk"],
                               ["/sources", "Yahoo"],
                               ["/terms", "not investment advice"],
                               ["/privacy", "No accounts"]]) {
    await p.goto(SITE + route, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3500);
    const t = await p.locator("main").innerText();
    ok(`${route} renders its disclosure`,
       t.length > 600 && t.toLowerCase().includes(must.toLowerCase()), t.length);
  }

  await p.goto(SITE + "/signals", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);
  /* THE CURVE IS SCOPED TO LAUNCH, so it is legitimately empty until a signal
   * published on or after that date closes. The assertion is therefore not
   * "a chart exists" but "the section is honest": either it draws the curve
   * with a working crosshair, or it explains why there is none AND discloses
   * the pre-launch history rather than quietly dropping it. Gating on Turso
   * alone was wrong — a configured ledger with nothing closed yet is the
   * normal state of a record that has just started. */
  const drewCurve = await p.locator(".rc-line").count() === 1;
  if (drewCurve) {
    ok("the curve prints its end value",
       /[+-]?\d+\.\d+R/.test(await p.locator(".rc-end").innerText()));
    const rcBox = await p.locator("#rcHit").boundingBox();
    await p.mouse.move(rcBox.x + rcBox.width * 0.55, rcBox.y + rcBox.height / 2);
    await p.waitForTimeout(300);
    ok("the curve has a working crosshair", await p.locator("#rcT.on").count() === 1);
  } else {
    const t = await p.locator("main").innerText();
    console.log("  NOTE  no closed trades since launch — checking the explanation instead");
    ok("the empty curve says the record starts here",
       /The record starts here|record starts today|No signals yet/i.test(t));
    /* The pre-launch summary was REMOVED on request. It was extra context, not
     * a disclosure the site depended on: this site never counted those trades
     * as its own, the launch record is empty and says so, and Methodology
     * still explains that the ledger has been re-graded twice. Asserting its
     * absence so it does not creep back in unnoticed. */
    ok("the pre-launch record is not shown", !/Before this site existed/.test(t));
  }

  ok("the manifest is linked", await p.locator('link[rel="manifest"]').count() === 1);
  ok("the service worker is served",
     await p.evaluate(async () => (await fetch("/sw.js")).ok) === true);


  /* ══ WATCHLIST, ALERTS AND THE PRICE LINE ════════════════════════════════
   * All three are localStorage-only by design — no account, no server. The
   * assertions that matter are that starring persists, that it does NOT open
   * the card behind it (two delegated handlers plus one direct one all wanted
   * that click), and that an alert actually fires rather than merely saving.
   */
  console.log("\n  watchlist and alerts");
  await p.goto(SITE + "/screen", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 6000);
  ok("the price line is drawn for the screen rows", await p.locator(".scr-r .pl").count() > 20);
  ok("its 200-day and 50-day markers are placed",
     await p.locator(".pl-m.is-200").count() > 0 && await p.locator(".pl-m.is-50").count() > 0);
  ok("the line has a legend", await p.locator(".pl-key").count() === 1);

  const firstRow = p.locator(".scr-r:not(.rank-head)").first();
  const wSym = (await firstRow.locator(".s b").innerText()).trim();
  await firstRow.locator(".wstar").click();
  await p.waitForTimeout(500);
  ok("starring persists to localStorage",
     (await p.evaluate(() => JSON.parse(localStorage.getItem("sig:watch") || "[]"))).includes(wSym));
  ok("starring does not open the card behind it",
     await p.locator("dialog#sheet[open]").count() === 0);

  // Row numbers must continue across pages, not restart.
  const pg1 = (await p.locator(".scr-r:not(.rank-head) .i").first().innerText()).trim();
  await p.locator('[data-pg="next"]').click();
  await p.waitForTimeout(1500);
  const pg2 = (await p.locator(".scr-r:not(.rank-head) .i").first().innerText()).trim();
  ok("row numbering continues onto page two", pg1 === "1" && pg2 === "41", { pg1, pg2 });

  /* ── INSTITUTIONAL MOVEMENT ─────────────────────────────────────────────
   * These run against whatever coverage the instiFeed currently carries, so they
   * assert BEHAVIOUR rather than a row count: the filters must agree with the
   * badges, the badges must not appear without a comparable quarter, and the
   * whole group must degrade to one sentence when the instiFeed is thin. A test
   * that demanded N accumulating names would fail on a quiet quarter, which is
   * a real market state and not a defect. */
  console.log("\n  institutional movement");
  await p.goto(SITE + "/screen", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 6000);

  const instiFeed = await p.evaluate(async () => {
    try { return await fetch("/institutional.json").then(r => r.ok ? r.json() : null); }
    catch { return null; }
  });
  ok("the institutional feed is served", !!instiFeed, instiFeed ? `${instiFeed.measured}/${instiFeed.universe}` : "missing");

  if (instiFeed) {
    // Nothing anywhere may claim a holding outside 0-100, and no change may be
    // reported without both periods that produced it. This is the assertion
    // that catches a taxonomy scale regression — the bug that read a 3.36%
    // stake as 336%.
    const bad = Object.entries(instiFeed.rows).filter(([, x]) =>
      [x.fii, x.dii, x.promoter, x.publicHold].some(v => v != null && (v < 0 || v > 100)));
    ok("no holding is outside 0-100%", bad.length === 0, bad.slice(0, 3).map(b => b[0]));

    const orphan = Object.entries(instiFeed.rows).filter(([, x]) =>
      x.fii_pp != null && !x.prev_period);
    ok("no change is reported without a comparison quarter", orphan.length === 0,
       orphan.slice(0, 3).map(o => o[0]));

    const notComplete = Object.entries(instiFeed.rows).filter(([, x]) =>
      x.quality !== "complete" && (x.fii_pp != null || x.score != null));
    ok("a partial reading carries neither a change nor a score",
       notComplete.length === 0, notComplete.slice(0, 3).map(o => o[0]));
  }

  const grp = p.locator(".insti-g");
  ok("the institutional filter group renders", await grp.count() === 1);

  if (instiFeed && instiFeed.measured > 0) {
    /* THE PANEL IS A DISCLOSURE, CLOSED BY DEFAULT.
     * It is roughly two phone screens of secondary filters and it sits above
     * the rows the reader came for, so it opens on a tap instead of on every
     * visit. Two things have to stay true and both are asserted here: it is
     * shut when nothing is filtered, and it opens BY ITSELF the moment one of
     * its filters is on — a closed panel that is silently narrowing the table
     * would be the worst version of this. */
    ok("the panel is closed until it is wanted",
       await grp.evaluate(e => !e.open));
    await grp.locator("> summary.insti-h").click();
    await p.waitForTimeout(200);
    ok("the panel opens on its summary", await grp.evaluate(e => e.open));

    ok("the five quick filters are offered",
       await p.locator('.insti-g .chip[data-ic]').count() === 6);   // 5 + "Any"

    // Filtering to accumulation must return ONLY names the instiFeed classifies
    // that way — the filter and the badge read the same precomputed field, and
    // this is what proves they cannot drift apart.
    await p.locator('.insti-g .chip[data-ic="both_acc"]').click();
    await p.waitForTimeout(900);
    const shown = await p.evaluate(() => [...document.querySelectorAll(".scr-r:not(.rank-head)")]
      .map(r => r.dataset.sym));
    const wrong = shown.filter(s => instiFeed.rows[s]?.signal !== "strong_accumulation");
    ok("the accumulation filter returns only accumulating names", wrong.length === 0, wrong.slice(0, 3));
    // A filter that is narrowing the table may never hide behind a shut panel.
    ok("an active filter re-opens the panel",
       await p.locator(".insti-g").evaluate(e => e.open));
    ok("every filtered row carries its badge",
       shown.length === 0 || await p.locator(".scr-r:not(.rank-head) .scr-ins").count() === shown.length);

    // The badge must be readable without colour.
    if (shown.length) {
      const glyph = await p.locator(".scr-r:not(.rank-head) .scr-ins .ins-g").first().innerText();
      ok("the badge carries a glyph, not colour alone", /[▲▼⇄]/.test(glyph), glyph);
    }

    // Compare the RESULT COUNTS, not the rows on screen: the table paginates at
    // 40, so a filter matching 59 names and no filter at all both render 40
    // rows and the original assertion was comparing two page sizes.
    const matched = async () => (await p.locator(".sec-n").first().innerText()).trim();
    const filteredCount = await matched();
    await p.locator('.insti-g .chip[data-ic=""]').click();
    await p.waitForTimeout(900);
    const allCount = await matched();
    ok("clearing the filter restores the universe", filteredCount !== allCount,
       { filteredCount, allCount });

    // The card is where the full reading lives.
    const sym = Object.keys(instiFeed.rows).find(s => instiFeed.rows[s].quality === "complete");
    // Routing is pushState now; assigning location.hash navigates nowhere.
    await p.goto(SITE + "/screen", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(SETTLE + 5000);
    await p.evaluate(s => { window.__t = s; }, sym);
    await p.waitForTimeout(400);
    const opened = await p.evaluate(async (s) => {
      const row = document.querySelector(`.scr-r[data-sym="${s}"]`);
      if (row) { row.click(); return true; }
      return false;
    }, sym);
    if (opened) {
      await p.waitForTimeout(1200);
      ok("the card names both periods it compared",
         /compared with/.test(await p.locator("dialog#sheet").innerText()));
      ok("the score prints its own weights",
         await p.locator(".isc .isc-w").count() >= 3);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(300);
    }
  } else {
    ok("a thin instiFeed says so instead of rendering empty controls",
       await p.locator(".insti-none").count() === 1);
  }

  /* ── ONE POPULATION, EVERY SURFACE ──────────────────────────────────────
   * The brief announced "the highest-scoring of the 148 signals open right
   * now" while the front page, the ledger and the floor all said 35: it
   * filtered ledger()'s rows by status and never by the launch date. That is
   * the SECOND time this exact fault has shipped here — the note on the front
   * page's own record block was written after the first. A number a reader can
   * compare between two pages is worth a test. */
  console.log("\n  one population across surfaces");
  await p.goto(SITE + "/brief", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 5000);
  const briefTxt = await p.locator("main").innerText();
  const briefN = Number((briefTxt.match(/highest-scoring of the\s+([\d,]+)\s+signals/) || [])[1]?.replace(/,/g, ""));
  ok("the brief names the population it ranked within", /signals open since \d{4}-\d{2}-\d{2}/.test(briefTxt.replace(/\s+/g, " ")));
  if (Number.isFinite(briefN)) {
    // Whatever it is, it cannot be the all-time open count — that population
    // reaches back before launch and is several times larger.
    ok("the brief counts since launch, not all time", briefN < 120, briefN);
    await p.goto(SITE + "/", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(SETTLE + 4000);
    const homeTxt = await p.locator("main").innerText();
    const homeN = Number((homeTxt.match(/([\d,]+)\s+published since/) || [])[1]?.replace(/,/g, ""));
    if (Number.isFinite(homeN)) {
      ok("the brief's open set is a subset of what the front page published",
         briefN <= homeN, { briefN, homeN });
    }
  }

  /* THE FLOOR IS THE THIRD SURFACE TO GET THIS WRONG. It counted every OPEN
   * row ever and reported 182 open positions while the brief said 33. Any
   * surface that shows an open count must draw from the same population. */
  await p.goto(SITE + "/engines", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 5000);
  const floorTxt = await p.locator("main").innerText();
  const floorOpen = Number((floorTxt.match(/Open positions\s+([\d,]+)/i) || [])[1]?.replace(/,/g, ""));
  if (Number.isFinite(floorOpen)) {
    ok("the floor's open count is a since-launch population", floorOpen < 120, floorOpen);
  }

  /* ── THE EXPANDING ROW ──────────────────────────────────────────────────
   * 61 IPO rows of eight columns each and no way to open one. */
  console.log("\n  expanding rows");
  await p.goto(SITE + "/ipo", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 5000);
  /* The listings table moved behind a disclosure when /ipo was decluttered —
     it was 1,823px of a 6.7-screen page. The rows still expand; they are one
     tap further in. Opening every fold on the route rather than naming this
     one, so the next section that folds does not break this test too. */
  await p.evaluate(() => {
    document.querySelectorAll("details.foldb").forEach((d) => { d.open = true; });
  });
  await p.waitForTimeout(400);
  const xrN = await p.locator("#ipotbl .xr").count();
  ok("the listing rows expand", xrN > 10, xrN);

  if (xrN) {
    const row = p.locator("#ipotbl .xr").first();
    ok("collapsed rows report it", await row.getAttribute("aria-expanded") === "false");
    await row.click();
    await p.waitForTimeout(300);
    ok("clicking expands it", await row.getAttribute("aria-expanded") === "true");
    const panelId = await row.getAttribute("aria-controls");
    ok("the panel it names is now visible",
       await p.locator(`#${panelId}`).isVisible());
    // The panel must add something the row does not already say.
    const detail = await p.locator(`#${panelId}`).innerText();
    ok("the panel shows the issue price the table cannot",
       /Issue price/.test(detail) && !/could not be read|No price band/.test(detail), detail.slice(0, 80));
    ok("the panel does not repeat 'since listing' twice",
       (detail.match(/Since listing/g) || []).length === 1);
    // Filtering must take the open panel with it.
    await p.locator('#ipoflt .chip[data-f="dn"]').click();
    await p.waitForTimeout(400);
    const orphans = await p.evaluate(() =>
      [...document.querySelectorAll("#ipotbl .xd")]
        .filter(x => !x.hidden && x.previousElementSibling && x.previousElementSibling.hidden).length);
    ok("filtering leaves no orphaned detail panels", orphans === 0, orphans);
  }

  /* ── ROUTING: REAL PATHS, AND OLD LINKS STILL LAND ──────────────────────
   * The migration off hash routing rewrites every URL ever shared. The shim
   * that keeps /#/markets working is the single most breakable thing in it,
   * and its failure mode is silent: the old link renders the front page and
   * looks like a slow load. */
  console.log("\n  routing");
  for (const [route, wantIn] of [["/markets", "Markets"], ["/screen", "Screen"],
                                 ["/signals", "ledger"], ["/engines", "floor"]]) {
    await p.goto(SITE + route, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(SETTLE + 2500);
    const title = await p.title();
    ok(`${route} serves its own <title>`, title.toLowerCase().includes(wantIn.toLowerCase()), title);
    const canon = await p.evaluate(() => document.querySelector('link[rel="canonical"]')?.getAttribute("href"));
    ok(`${route} canonical names itself`, String(canon).endsWith(route), canon);
    const og = await p.evaluate(() => document.querySelector('meta[property="og:title"]')?.getAttribute("content"));
    ok(`${route} has its own og:title`, String(og).toLowerCase().includes(wantIn.toLowerCase()), og);
  }
  // The shim: an old shared link must land on the page it named.
  await p.goto(SITE + "/#/engines", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 2500);
  ok("an old #/ link is rewritten to the real path",
     (await p.evaluate(() => location.pathname)) === "/engines",
     await p.evaluate(() => location.pathname));
  ok("...and renders that route, not the front page",
     (await p.title()).toLowerCase().includes("floor"), await p.title());

  // The company page: a card with a URL.
  await p.goto(SITE + "/stock/RELIANCE", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 6000);
  ok("/stock/:sym renders the company", (await p.title()).startsWith("RELIANCE"), await p.title());
  ok("the company page sets its own og:title",
     (await p.evaluate(() => document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "")).startsWith("RELIANCE"));
  ok("an unknown symbol says so rather than erroring", await (async () => {
    await p.goto(SITE + "/stock/NOTAREALTICKER", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(SETTLE + 5000);
    const txt = await p.locator("main").innerText();
    // NOT "750-name": the copy correctly stopped naming a size when the
    // universe was widened, and this regex kept the old number — so the
    // assertion failed on a page that was behaving exactly as intended. An
    // assertion should not encode a figure the sentence no longer carries.
    return /is not in the .*screen/i.test(txt);
  })());

  /* THE .NS SUFFIX. Symbols reach the card from feeds that carry the exchange
   * suffix; SCREEN stores bare ones. The mismatch reported itself as "not in
   * the screen", a sentence about the universe used for a string format
   * problem. */
  await p.goto(SITE + "/stock/PAYTM.NS", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 6000);
  ok("a .NS symbol resolves to the bare one",
     !/not in the 750-name screen/i.test(await p.locator("main").innerText()),
     await p.title());


  /* ── SIGNAL RADAR ───────────────────────────────────────────────────────
   * The score is a model, so the thing worth testing is that it always shows
   * its working and never contradicts its own components. */
  console.log("\n  signal radar");
  await p.goto(SITE + "/radar", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 7000);
  const rdRows = await p.locator(".rd-row").count();
  ok("the radar ranks names", rdRows > 2, rdRows);
  ok("the market core states a score", /\d+\/100/.test(await p.locator(".rd-core-n").innerText()));
  // The core must print every term, not just a number.
  await p.locator("#rdCore").click();
  await p.waitForTimeout(400);
  const terms = await p.locator(".rd-cr").count();
  ok("the market score prints its own decomposition", terms >= 4, terms);
  const weights = await p.evaluate(() =>
    [...document.querySelectorAll(".rd-cw")].map(x => parseInt(x.textContent, 10)));
  ok("its weights sum to 100", weights.reduce((a, b) => a + b, 0) === 100, weights);

  // A row's total must agree with the components printed beside it.
  const agree = await p.evaluate(() => {
    const W = { Momentum: 30, Trend: 30, Volume: 20, Institutional: 20 };
    const r = document.querySelector(".rd-row");
    const total = Number(r.querySelector(".rd-sc b").textContent);
    let num = 0, den = 0;
    for (const p of r.querySelectorAll(".rd-p")) {
      const k = p.querySelector("em").textContent.trim();
      const v = p.querySelector("u").textContent.trim();
      if (v === "—") continue;
      num += Number(v) * W[k]; den += W[k];
    }
    return den ? { total, computed: Math.round(num / den) } : null;
  });
  if (agree) ok("a row's score equals its own components",
                Math.abs(agree.total - agree.computed) <= 1, agree);

  // The radar must not invent a second signal vocabulary.
  //
  // VOID IS THE ONE ADDITION, AND IT IS NAMED RATHER THAN LISTED.
  //
  // A breached stop is not a rating — it is the absence of one. The overlay
  // re-reads price, off-high and stop live, and used to leave the verdict
  // stamped at the build: IFCI read "Buy · 89 Strong" over its own live
  // "-13.1% off its high" and a breached stop, with the stated reason being
  // "Broke its 52-week high". So the chip has to be able to say the setup is
  // gone, and none of the five rating words can.
  //
  // Kept OUT of `allowed` deliberately. A check whose fix is always "add the
  // new word" is not a check; a SECOND new verdict still fails this.
  const VOID = "Setup void · stop breached";
  /* `.vtag` AS WELL AS `.rd-v`.
   *
   * This sampled the radar only, and that is exactly how the screen kept a
   * second vocabulary — Act / Ignore against the radar's Buy / Avoid — for as
   * long as it did. A taxonomy check that watches one of the two surfaces
   * rendering the field is a check that cannot find a disagreement between
   * them. */
  const verdicts = await p.evaluate(() =>
    [...document.querySelectorAll(".rd-v, .vtag")].map(x => x.textContent.trim()));
  const allowed = new Set(["Buy", "Wait for entry", "Watch", "Avoid", "Not rated"]);
  ok("it uses the site's own verdict words, not a new taxonomy",
     verdicts.every(v => allowed.has(v) || v === VOID), [...new Set(verdicts)]);

  // The string is asserted against the source, so a reword in signal.js that
  // forgets this file fails here rather than quietly widening the taxonomy.
  ok("the void chip's wording is the one signal.js emits",
     readFileSync("public/signal.js", "utf8").includes(`'${VOID}'`));

  /* The ring is desktop-only; the phone gets the list. This block runs in the
   * 1440px context, so the viewport has to be narrowed for the check — the
   * first version asserted phone behaviour while sitting at desktop width and
   * reported the layout as broken when it was correct. */
  const ringByWidth = await (async () => {
    const wide = await p.evaluate(() => getComputedStyle(document.querySelector(".rd-stage")).display);
    await p.setViewportSize({ width: 375, height: 812 });
    await p.waitForTimeout(500);
    const narrow = await p.evaluate(() => getComputedStyle(document.querySelector(".rd-stage")).display);
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.waitForTimeout(400);
    return { wide, narrow };
  })();
  ok("the ring renders on desktop", ringByWidth.wide === "block", ringByWidth);
  ok("the ring is not rendered at phone width", ringByWidth.narrow === "none", ringByWidth);

  /* The ring is cards, not dots — and cards on a circle collide unless the
   * minimum radius respects 2*r*sin(pi/n) > cardWidth. Two of eight overlapped
   * at r=168 before the band was widened. */
  const ringGeom = await p.evaluate(() => {
    const c = [...document.querySelectorAll(".rd-card")];
    const b = c.map(x => x.getBoundingClientRect());
    let ov = 0;
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++)
      if (b[i].left < b[j].right && b[j].left < b[i].right &&
          b[i].top < b[j].bottom && b[j].top < b[i].bottom) ov++;
    return { cards: c.length, overlaps: ov };
  });
  ok("the ring renders a card per node", ringGeom.cards >= 6, ringGeom);
  ok("no two ring cards overlap", ringGeom.overlaps === 0, ringGeom);

  /* The universe strip scrolls sideways ON ITS OWN. Without contain:paint its
   * 3,300px of content propagated into the document's scrollWidth while
   * body{overflow-x:hidden} hid the effect — the page looked fine and every
   * sideways-scroll check read it as broken. */
  const stripBehaviour = await p.evaluate(() => {
    const s = document.querySelector(".rd-strip");
    const de = document.documentElement;
    return { cards: document.querySelectorAll(".rd-u").length,
             scrollsItself: s.scrollWidth > s.clientWidth,
             docOverflow: de.scrollWidth - de.clientWidth };
  });
  ok("the signal universe strip is populated", stripBehaviour.cards > 8, stripBehaviour);

  /* THE TICKER MUST BE VISIBLE. It was not: the card reused `rc-*`, which is
   * already the return chart's namespace, so `.rc-t` inherited that chart's
   * tooltip padding, the row inflated, its siblings overlapped it, and the
   * stock NAME was pushed out of the card. Everything rendered; the names were
   * simply gone. Checked by geometry, because "the element exists" was true
   * the whole time it was invisible. */
  const cardShape = await p.evaluate(() => {
    const u = document.querySelector(".rd-u");
    if (!u) return null;
    const ub = u.getBoundingClientRect();
    const b = u.querySelector(".rdc-t b");
    const kids = [...u.children].map(c => c.getBoundingClientRect());
    let overlap = 0;
    for (let i = 0; i < kids.length - 1; i++)
      if (kids[i].bottom > kids[i + 1].top + 0.5) overlap++;
    return { ticker: b ? b.textContent.trim() : null,
             inside: b ? (b.getBoundingClientRect().top >= ub.top - 0.5 &&
                          b.getBoundingClientRect().bottom <= ub.bottom + 0.5) : false,
             overlappingChildren: overlap };
  });
  if (cardShape) {
    ok("the strip card shows a ticker", !!cardShape.ticker, cardShape);
    ok("the ticker sits inside its card", cardShape.inside === true, cardShape);
    ok("the card's rows do not overlap", cardShape.overlappingChildren === 0, cardShape);
  }

  /* Sparklines are filled after paint; a card that still says "no series"
   * after the fetches means the fill selector missed. */
  await p.waitForTimeout(6000);
  const spark = await p.evaluate(() => ({
    drawn: document.querySelectorAll(".rdc-sp").length,
    pending: document.querySelectorAll(".rdc-nosp").length }));
  ok("sparklines are drawn, not left pending", spark.drawn > 8 && spark.pending === 0, spark);
  ok("it scrolls inside itself", stripBehaviour.scrollsItself === true, stripBehaviour);
  ok("and does not push the document sideways", stripBehaviour.docOverflow <= 0, stripBehaviour);

  // Selecting a name has to dim the rest, across all three views of the set.
  await p.locator(".rd-u").first().click();
  await p.waitForTimeout(500);
  const sel = await p.evaluate(() => ({
    dimming: document.querySelector("main").classList.contains("rd-picked"),
    selected: document.querySelectorAll(".is-sel").length }));
  ok("selecting a name dims the rest", sel.dimming === true, sel);
  ok("the selection lands on every view of that name", sel.selected >= 2, sel);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);

  // Clicking a row opens the radar's panel, not the company card.
  await p.locator(".rd-row").first().click();
  await p.waitForTimeout(700);
  const panel = await p.locator("dialog#sheet").innerText();
  ok("a row opens the radar panel with its weights", /RADAR SCORE/i.test(panel));
  ok("the panel states risk flags either way", /Risk flags/i.test(panel));
  ok("the panel links on to the full company card", /full company card/i.test(panel));
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);


  /* ── ONE IDEA PER NAME ──────────────────────────────────────────────────
   * ai_longterm re-files weekly and nothing supersedes the old row, so every
   * filing stayed OPEN and Ideas rendered all of them: SHRIRAMFIN appeared
   * four times at four entries, which reads as four ideas about one company. */
  console.log("\n  ideas");
  await p.goto(SITE + "/ideas", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 6000);
  const ideaSyms = await p.evaluate(() =>
    [...document.querySelectorAll(".aic .aic-s")].map(x => x.textContent.trim()));
  if (ideaSyms.length) {
    ok("no company appears twice in the ideas list",
       new Set(ideaSyms).size === ideaSyms.length,
       ideaSyms.filter((s, i) => ideaSyms.indexOf(s) !== i));
    const txt = await p.locator("main").innerText();
    ok("if rows were folded away, the page says how many",
       !/folded away/.test(txt) || /\d+ earlier open row/.test(txt));
  }


  /* ── THE APP SHELL ──────────────────────────────────────────────────────
   * The bar was four items, two of which opened <details> menus, so the ledger
   * cost two taps and a guess. Flat destinations, and nothing that lived in
   * those menus may become unreachable.
   *
   * SIX NOW, NOT FIVE. /brief was the longest page on the site and reachable
   * from a phone only through the header CTA — which signal.css hides under
   * 560px — or a "Full brief" link inside an expanded ledger card. Both are
   * links from somewhere else, and a destination with no entry of its own is
   * not navigable.
   *
   * The count is asserted EXACTLY, not as a floor: a bar that can grow
   * silently is how a seventh tab once pushed a 390px phone to 454px and
   * scrolled the page sideways. Adding one means editing these numbers and
   * saying why. The width is checked separately, at 320px, further down. */
  console.log("\n  app shell");
  await p.goto(SITE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 3000);
  const shell = await p.evaluate(() => {
    const tabs = [...document.querySelectorAll(".tabs a, .tabs button")];
    return { count: tabs.length,
             labels: tabs.map(t => t.querySelector("span")?.textContent),
             icons: tabs.filter(t => t.querySelector("svg")).length,
             dropdowns: document.querySelectorAll(".tabs details").length,
             minTap: Math.min(...tabs.map(t => Math.round(t.getBoundingClientRect().height))) };
  });
  ok("the bar has six destinations", shell.count === 6, shell);
  ok("none of them is a dropdown", shell.dropdowns === 0, shell);
  ok("every destination has an icon", shell.icons === shell.count, shell);
  ok("the brief has an entry of its own", shell.labels.includes("Brief"), shell.labels);
  ok("tap targets clear 44px", shell.minTap >= 44, shell.minTap);

  /* Every route must still be reachable from the bar, Discover or the Ledger.
   * A flattened nav that strands a page is worse than the menu it replaced.
   *
   * THE PATH CHANGED, THE INVARIANT DID NOT. This used to click #moreBtn and
   * read the sheet it opened. That button is gone: "More" was a slot in a
   * five-slot bar that named nothing, and what it held that nothing else did —
   * methodology, sources, the floor, legal — is provenance, which now sits at
   * the foot of the Ledger where the record it qualifies is. Same links, same
   * .more-i markup, reached by visiting a page rather than opening a drawer.
   *
   * Navigating rather than clicking a button is also the more honest test: it
   * proves a reader can GET there, not merely that a handler fires. */
  const hop = async (href, waitMs) => {
    await p.evaluate(async (h) => {
      const a = document.createElement("a"); a.href = h;
      document.body.appendChild(a); a.click(); a.remove();
    }, href);
    await p.waitForTimeout(waitMs);
  };
  const seen = new Set(["/", "/markets", "/discover", "/watch", "/signals"]);
  await hop("/discover", 2500);
  for (const h of await p.$$eval(".disc-c", (n) => n.map((x) => x.getAttribute("href"))))
    seen.add(h);
  /* COUNT THE CARDS WHILE STILL ON /discover. The assertion below used to run
   * after the hop to /signals, where .disc-c does not exist — so it counted 0
   * and failed every deploy on a page that was never broken. Measured live:
   * /discover carries 8 cards, /signals carries none. */
  const discCards = await p.locator(".disc-c").count();
  await hop("/signals", 4000);
  for (const h of await p.$$eval(".more-i[href]", (n) => n.map((x) => x.getAttribute("href"))))
    seen.add(h);
  const reachable = [...seen];
  ok("the Ledger carries the provenance links",
     (await p.locator(".more-i[href]").count()) >= 4);
  const mustReach = ["/markets", "/screen", "/ideas", "/ipo", "/news", "/funds",
                     "/radar", "/engines", "/brief", "/methodology", "/sources"];
  const stranded = mustReach.filter(r => !reachable.includes(r));
  ok("no page is stranded by the flattened nav", stranded.length === 0, stranded);
  ok("Discover lists the discovery pages", discCards >= 6, discCards);

  await p.goto(SITE + "/watch", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE + 4000);
  ok("the watchlist shows the starred name",
     (await p.locator("main").innerText()).includes(wSym));
  // Reworded in plain language: "lives in this browser" read as jargon.
  const wtxt = await p.locator("main").innerText();
  ok("the device-only limitation is stated plainly",
     /Saved on this device only/i.test(wtxt) && /will not appear on your phone/i.test(wtxt));

  // An alert below any real price must actually fire, not merely save.
  await p.locator("#alSym").fill(wSym);
  await p.locator("#alPx").fill("1");
  await p.locator("#alform button[type=submit]").click();
  await p.waitForTimeout(6000);
  ok("the alert is stored",
     (await p.evaluate(() => JSON.parse(localStorage.getItem("sig:alerts") || "[]"))).length === 1);
  ok("a triggered alert actually announces", await p.locator(".toast").count() > 0);
  await p.locator(".alx").click();
  await p.waitForTimeout(1200);
  ok("the alert can be deleted",
     (await p.evaluate(() => JSON.parse(localStorage.getItem("sig:alerts") || "[]"))).length === 0);

  await ctx.close();


  /* ── REDUCED MOTION ──────────────────────────────────────────────────── */
  console.log("\n  prefers-reduced-motion: reduce");
  const rmCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const rp = await rmCtx.newPage();
  await rp.goto(SITE + "/brief", { waitUntil: "domcontentloaded" });
  await rp.waitForTimeout(SETTLE);
  ok("every section is visible", await rp.locator(".b-reveal:not(.in)").count() === 0);
  ok("every chart overlay is visible", await rp.locator(".b-ov:not(.on)").count() === 0);
  await openWorkup(rp);
  ok("the confidence figure is written", /^\d+$/.test((await rp.locator("#dialN").innerText()).trim()));
  // The assertion is that the FILL STEP RAN, not that every score is positive:
  // a component genuinely scoring 0 renders a 0% bar, and treating that as
  // "never filled" is the test inventing a defect. Every bar must carry a
  // width, and at least one must be non-zero.
  const widths = await rp.locator(".b-crow .tr i").evaluateAll(es => es.map(e => e.style.width));
  ok("every score bar was given a width", widths.length > 0 && widths.every(w => !!w), widths);
  ok("at least one score bar is non-zero", widths.some(w => w && w !== "0%"), widths);
  await rmCtx.close();

  /* ── FUNDS ───────────────────────────────────────────────────────────
   * This route had NO assertions at all, and it is the one that has now cost
   * three round trips to guessed field names — r5y/cagr5 in the summary strip
   * (which therefore rendered blank every single day and nobody saw it),
   * age_years, and a whole `portfolio` block computed weekly and dropped by
   * the emitter. Every one of those is invisible in a build log and invisible
   * on the page: a missing figure just looks like a fund that has no figure.
   * So the assertions below check that a value the FEED CARRIES actually
   * reaches the DOM, which is the only failure mode this route has. */
  console.log("\n  /funds — the screen, and one fund's sheet");
  const fCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await fCtx.newPage();
  await page.goto(SITE + "/funds", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE);

  const feed = await page.evaluate(async () => {
    const r = await fetch("/funds.json"); return r.ok ? r.json() : null;
  });
  ok("the fund feed loads", !!(feed && feed.ok));

  const rowN = await page.locator(".rank-r.fnd[data-fund]").count();
  ok("the screen renders fund rows", rowN > 0, rowN);

  // The summary strip read f.r5y ?? f.cagr5. Neither name exists on this feed
  // — the field is r5 — so "Best 5-year" was a dash on every load.
  const best = (await page.locator(".snap").innerText()).match(/Best 5-year\s*\n?\s*([^\n]+)/i);
  ok("the Best 5-year figure is a number, not a dash",
     !!(best && /\d/.test(best[1])), best && best[1]);

  /* THE LEADERS' BOARD IS THE VISIBLE PATH NOW.
   * Each category's own table sits inside a closed disclosure — twenty open
   * tables was 11,844px on a phone — so the row this used to click is in the
   * document but not on the page. The board above carries one row per
   * category and opens the same sheet, so the primary path is asserted
   * there; the folded table is opened and asserted straight after, because
   * "the rows are still reachable" is the thing folding could break. */
  const leadN = await page.locator(".rank-r.fld[data-fund]").count();
  ok("the leaders' board carries one row per category",
     leadN === (feed ? feed.categories.filter(c => (c.funds || []).length).length : 0), leadN);

  await page.locator(".rank-r.fld[data-fund]").first().click();
  await page.waitForTimeout(900);
  const sheetTxt = await page.locator("#sheet .sheet-b").innerText();
  ok("clicking a fund opens its sheet", sheetTxt.length > 200, sheetTxt.length);

  // Age comes from history_years. It was read as age_years and rendered "—".
  ok("the sheet gives the fund an age", /Age\s*\n?\s*[\d.]+\s*yrs/i.test(sheetTxt),
     sheetTxt.slice(0, 160));

  // Data-conditional from here: assert what THIS feed carries, so the suite
  // fails on a rendering bug and not on a screen that has not rerun yet.
  const clicked = await page.locator(".rank-r.fld[data-fund]").first()
    .getAttribute("data-fund");
  const first = feed && feed.categories.flatMap(c => c.funds)
    .find(f => String(f.code) === clicked);
  ok("the sheet is the fund that was clicked", !!first, first && first.name);

  if (first && Array.isArray(first.calendar) && first.calendar.length) {
    ok("year-by-year returns render", (await page.locator(".fd-cy").count()) > 0);
  } else {
    console.log("  SKIP  year-by-year — this fund carries no calendar");
  }

  if (first && first.portfolio && (first.portfolio.top_stocks || []).length) {
    const stocks = await page.locator(".fd-own > div:last-child .fd-or").count();
    ok("the holdings the feed carries all render", stocks === first.portfolio.top_stocks.length,
       [stocks, first.portfolio.top_stocks.length]);
    ok("the sector weights render", (await page.locator(".fd-own > div:first-child .fd-or").count())
       === first.portfolio.top_sectors.length);
    // The gap list must not claim a gap the sheet just filled two sections up.
    ok("holdings are not also listed as unavailable",
       !/Top holdings and sectors/i.test(sheetTxt));
  } else {
    ok("a fund with no portfolio says so plainly",
       /Top holdings and sectors/i.test(sheetTxt));
  }
  await page.evaluate(() => document.getElementById("sheet")?.close());
  await page.waitForTimeout(250);

  /* AND THE FOLDED CATEGORIES STILL HAND OVER THEIR ROWS.
   * Sixty of the sixty-three fund rows now live inside a disclosure. That
   * they open, and that their rows are genuinely on the page when they do,
   * is the thing folding could break — a row present in the DOM and never
   * visible is exactly the failure this suite exists to catch. */
  const cat = page.locator("details.fcat").first();
  ok("each category is a disclosure, closed on arrival", await cat.evaluate(e => !e.open));
  await cat.locator("summary").click();
  await page.waitForTimeout(350);
  ok("opening one shows its ranked funds",
     await cat.locator(".rank-r.fnd[data-fund]").first().isVisible());

  /* A ROW THAT SAYS role="button" HAS TO ANSWER A KEYBOARD.
   * Every fund row carries role="button" and tabindex="0" and only the mouse
   * path was wired, so Enter did nothing on any of them. A row that announces
   * itself as operable and is not is worse than one that never claimed to be. */
  await page.evaluate(() => document.getElementById("sheet")?.close());
  await page.waitForTimeout(250);
  await page.locator(".rank-r.fld[data-fund]").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  ok("Enter on a fund row opens it, not just a click",
     await page.locator("#sheet[open]").count() === 1);
  await fCtx.close();

  /* ── EVERY ROUTE, EVERY ERROR ────────────────────────────────────────
   *
   * THE HOME PAGE SHIPPED BROKEN AND THIS SUITE SAID ALL CHECKS PASSED.
   *
   * `CACHED('/screen.json').then(noteLadder)` — CACHED is synchronous and
   * returns the wrapper, not a promise, so .then was undefined and the Today
   * route threw on every single load and rendered its error panel instead of
   * the page. Eighty assertions were green while the front page was a red box.
   *
   * Two holes made that possible. The pageerror listener was attached to a
   * context that only ever visited /markets and /brief, so `#/` was checked
   * for horizontal overflow and nothing else. And an error the app CATCHES
   * and renders as `.note.err` produces no console error at all — the page
   * reports the failure politely and a listener sees a clean run.
   *
   * So this sweeps every route and asserts both: no thrown error, and no
   * rendered failure panel. The second is the one that would have caught it. */
  console.log("\n  every route — thrown errors and rendered failures");
  const ROUTES = ["/", "/markets", "/signals", "/brief", "/screen", "/ideas",
                  "/news", "/ipo", "/funds", "/watch", "/engines", "/radar", "/reads", "/join",
                  "/methodology", "/sources", "/terms", "/privacy"];
  const swCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sw = await swCtx.newPage();

  /* REGISTERED BEFORE THE FIRST NAVIGATION, and that is not a style choice.
   * A page.route handler added after the page has already been navigated does
   * not intercept for the loaded document — reproduced twice: identical sweep,
   * identical canary, interceptor registered late catches nothing and
   * registered early catches it every time. Two CI runs were spent blaming a
   * deploy race that was not happening. */
  let reported = null;
  await sw.route("**/api/client-error", async route => {
    try { reported = JSON.parse(route.request().postData() || "{}"); } catch { reported = {}; }
    await route.fulfill({ status: 200, contentType: "application/json",
                          body: JSON.stringify({ ok: true, recorded: true }) });
  });

  const thrown = [];
  let routeNow = "";
  sw.on("pageerror", e => thrown.push(`${routeNow} :: ${e.message.slice(0, 120)}`));
  for (const route of ROUTES) {
    routeNow = route;
    await sw.goto(SITE + route, { waitUntil: "domcontentloaded" });
    await sw.waitForTimeout(SETTLE);
    // The panel names what failed, so report its text rather than a boolean —
    // a red run should say which section and why without opening the browser.
    // The class alone is too broad: #/terms styles its legal disclaimer with
    // .note.err deliberately, and flagging that would be the test inventing a
    // defect. The failure panel is the one that says something did not load —
    // fail() writes "<what> did not load." and nothing else uses that phrasing.
    const panels = (await sw.locator("main .note.err").allInnerTexts())
      .filter(t => /did not load/i.test(t));
    ok(`${route} renders no failure panel`, panels.length === 0,
       panels.map(t => t.replace(/\s+/g, " ").slice(0, 150)));
  }
  ok("no route threw", thrown.length === 0, thrown.slice(0, 3));

  /* A WITHDRAWN SIGNAL MUST NOT READ "OPEN". The ledger row's outcome pill
   * chose its label from the wrong branch of a ternary, so any row that was
   * not open and had no price mark printed the literal word "open" —
   * TATAINVEST was cancelled in the database, reported cancelled by the API,
   * and still read open on the page. Cross-checks the rendered label against
   * what the API says, so the two cannot drift again. */
  await sw.goto(SITE + "#/signals", { waitUntil: "domcontentloaded" });
  await sw.waitForTimeout(SETTLE + 4000);
  const mislabelled = await sw.evaluate(async () => {
    const res = await fetch("/api/signals?limit=400");
    const rows = (await res.json()).signals || [];
    const notOpen = new Set(rows.filter(r => (r.badge || "") !== "open")
                                .map(r => String(r.symbol || "").replace(".NS", "")));
    const bad = [];
    document.querySelectorAll(".sg-r").forEach(el => {
      const sym = (el.getAttribute("data-sgsym") || "").replace(".NS", "");
      const pill = el.querySelector(".sg-r-out .pill");
      if (sym && pill && notOpen.has(sym) && /^open$/i.test(pill.textContent.trim())) bad.push(sym);
    });
    return bad;
  });
  ok("a withdrawn signal is not labelled open", mislabelled.length === 0,
     mislabelled.slice(0, 4));

  /* THE REPORTER ITSELF HAS TO WORK, and it is the one piece of code that
   * cannot announce its own failure. A deliberate throw is injected and the
   * POST it should produce is intercepted — asserting the wiring end to end
   * rather than that a listener was merely attached. */
  await sw.goto(SITE + "/methodology", { waitUntil: "domcontentloaded" });
  await sw.waitForTimeout(3000);
  await sw.evaluate(() => { setTimeout(() => { throw new Error("ui-suite canary"); }, 0); });
  await sw.waitForTimeout(3000);
  ok("a client error is reported", !!reported && /canary/.test(reported.message || ""),
     reported && reported.message);
  ok("the report names the route it happened on",
     !!reported && String(reported.route || "").includes("methodology"), reported && reported.route);
  await sw.unroute("**/api/client-error");
  await swCtx.close();

  /* ── NARROW ──────────────────────────────────────────────────────────── */
  /* ── EVERY TABLE'S COLUMNS MAP TO ITS HEADERS ───────────────────────────
   *
   * Two tables shipped with more cells than declared grid tracks, and CSS
   * does not complain: the surplus cells wrap onto a second grid line and
   * take the widths of the FIRST columns. On /screen "52w low" rendered
   * clipped in a 24px box under the rank number while its heading sat 1,100px
   * away; on /ipo "Since listing" — the entire point of the listings table —
   * did the same in the header and in every row.
   *
   * Neither threw, neither failed a snapshot, and both were invisible to
   * every existing assertion. The invariant is simple and worth holding: a
   * header row and the row under it have the same number of in-flow cells,
   * that number equals the declared track count, and each header sits at the
   * same x as the cell beneath it. Cells that opt out of the columns on
   * purpose (grid-column: 1 / -1, or absolutely positioned) are excluded. */
  console.log("\n  table columns map to their headers");
  /* AT BOTH WIDTHS, and the second one is not decoration.
   *
   * This check ran at 1440 only, and a table shipped broken at 390 while it
   * stayed green: the engine roster's grid rules were written but never ran,
   * because at 700px and below the generic `.rank-r{display:flex}` rule
   * catches `.rank-r.eng` too. On a real phone the header read
   * "ENGINE  PUBLISHED" with "CLOSED" wrapped to a second line and the fourth
   * heading hidden, over a row reading "VECTOR 6 2 50%" — four figures under
   * two-and-a-bit headings, nothing lining up. Reported from a device, not
   * caught here.
   *
   * A table is a claim that a column means something, and that claim is made
   * at every width the site is read at. Most of this site is read at the
   * narrow one. */
  const colCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const colP = await colCtx.newPage();
  const colMobCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const colMobP = await colMobCtx.newPage();
  for (const [label, pg] of [["desktop", colP], ["phone", colMobP]])
  for (const route of ["/", "/signals", "/screen", "/ideas", "/markets", "/ipo",
                       "/brief", "/watch", "/engines", "/radar", "/news", "/funds", "/reads",
                       "/research"]) {
    await pg.goto(SITE + route, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(SETTLE + 3000);
    const faults = await pg.evaluate(() => {
      const inflow = el => [...el.children].filter(c => {
        const k = getComputedStyle(c);
        return k.display !== "none" && k.position !== "absolute"
            && !/^1 ?\/ ?-1$/.test(k.gridColumn.trim());
      });
      const out = [];
      for (const head of document.querySelectorAll("#main .rank-head")) {
        /* Skip anything not actually rendered. offsetParent alone is not the
           test — an element inside a `hidden` container has a grid display of
           its own — so ask whether it occupies any space at all. A panel the
           reader has not switched to has no laid-out columns to check. */
        if (!head.getClientRects().length) continue;
        let row = head.nextElementSibling;
        while (row && !row.classList.contains("rank-r")) row = row.nextElementSibling;
        if (!row) continue;
        const hc = inflow(head), rc = inflow(row);
        if (!hc.length) continue;                 // a header hidden by design
        const grid = getComputedStyle(head).display.includes("grid");
        /* COUNTING TRACKS BY SPLITTING ON SPACES IS WRONG FOR A GRID THAT
           HAS NOT BEEN LAID OUT. A rendered grid resolves every track to a
           concrete px value, so "24px 714px 70px..." splits cleanly. A grid
           inside a hidden panel keeps its authored value — and
           "minmax(0px, 1fr)" CONTAINS A SPACE, so the naive split counted it
           as two tracks and reported nine where the CSS declares eight.
           Latent until the markets board grew a hidden Risers/Fallers panel,
           at which point it failed a layout that was correct.
           Split on top-level spaces only: depth tracks parentheses so any
           function — minmax(), repeat(), clamp() — counts as one track. */
        const tracks = (() => {
          const v = getComputedStyle(head).gridTemplateColumns;
          let depth = 0, n = 0, seen = false;
          for (const ch of v) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            else if (ch === " " && depth === 0) { if (seen) { n++; seen = false; } }
            else seen = true;
          }
          return n + (seen ? 1 : 0);
        })();
        /* A HEADER THAT WRAPS IS A HEADER WHOSE COLUMNS ARE NOT COLUMNS.
         * Cells are baseline-aligned, so a few pixels apart is one line; a
         * whole line apart is a wrap, and that is what the phone fault was. */
        const line = els => { const ys = els.map(c => c.getBoundingClientRect().y);
          return els.length > 1 && (Math.max(...ys) - Math.min(...ys)) > 14; };
        const off = hc.length === rc.length && hc.findIndex((c, i) =>
          Math.abs(c.getBoundingClientRect().x - rc[i].getBoundingClientRect().x) > 1);
        const bad = hc.length !== rc.length
          || (grid && hc.length !== tracks)
          || (off !== false && off > -1)
          || line(hc);
        if (bad)
          out.push({ cls: String(row.className).slice(0, 40), grid, tracks,
                     head: hc.length, row: rc.length, firstOffColumn: off, headerWraps: line(hc) });
      }
      return out;
    });
    ok(`${label} · ${route} — every column sits under its own header`, faults.length === 0, faults);
  }
  await colCtx.close();
  await colMobCtx.close();

  /* ── THE SAME FACT, TWICE ON ONE PAGE ───────────────────────────────────
   *
   * The complaint that started this pass was duplication, and it was found by
   * reading pages one at a time. That does not survive the next feature, so
   * it is measured here instead. Two hunts, both over the RENDERED text:
   *
   *   A. A clause of eight or more words appearing more than once. That is
   *      boilerplate printed per card instead of once per page — the shape
   *      that put the same 45-word trailing note on thirty signal rows, the
   *      same chart caption on five idea cards, and the same sentence about
   *      an empty record on nine engine cards.
   *
   *   B. The same formatted FIGURE three or more times inside one card or
   *      section. Twice can be honest — a value and the axis it sits on.
   *      Three times is a fact being restated: target 1 in the plan grid, in
   *      the stop path and again as the first scale-out rung.
   *
   * Only figures carrying a unit are counted — a currency mark, a per cent,
   * an ×, an R or an :1. A bare integer is usually a label ("200-day") or a
   * share quantity that two ladder rungs may legitimately share, and counting
   * those produces noise that trains people to ignore the check.
   *
   * Visible text only: anything inside a closed <details> is not on the page,
   * so folding a block is not a way to pass this. */
  console.log("\n  the same fact is not printed twice");
  const dupCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dupP = await dupCtx.newPage();
  for (const route of ["/", "/signals", "/screen", "/ideas", "/markets", "/ipo",
                       "/brief", "/engines", "/radar", "/news", "/funds", "/reads", "/watch",
                       "/research"]) {
    await dupP.goto(SITE + route, { waitUntil: "domcontentloaded" });
    await dupP.waitForTimeout(SETTLE + 3000);
    const found = await dupP.evaluate(() => {
      /* ── A REPEATED DATA FIELD IS NOT REPEATED PROSE ──────────────────────
       * This check earns its place — it caught the management-rule caveat
       * printing once per signal card, twenty times down /signals. But it
       * scans every word in #main, so it also flags a per-row FIELD whose
       * value happens to coincide across rows, and that is a different thing.
       *
       * On /ipo four upcoming books all read "Book has not opened — no demand
       * evidence exists yet." They are all unopened. On / two live books both
       * read "0.9x so far, with time left"; both are at 0.9x. The rows are in
       * the same state, so the field says the same thing, and there is nothing
       * to fix: a verdict that changed per row when the facts did not would be
       * the defect.
       *
       * These two slots are excluded BY CLASS rather than the threshold being
       * loosened, so the check keeps full strength everywhere it matters —
       * .hint, .sec-note and section copy, which is exactly where the real
       * duplication was found. */
      const main = document.getElementById("main");
      const scan = main.cloneNode(true);
      scan.querySelectorAll(".ipo-why, .ipo-caveat").forEach(e => e.remove());
      document.body.appendChild(scan);
      scan.style.position = "absolute"; scan.style.left = "-99999px";
      const txt = scan.innerText;
      scan.remove();
      const seen = new Map();
      for (const raw of txt.split(/(?<=[.!?])\s+|\n+/)) {
        const t = raw.trim().replace(/\s+/g, " ");
        if (t.split(" ").length < 8) continue;
        seen.set(t, (seen.get(t) || 0) + 1);
      }
      const sentences = [...seen].filter(([, n]) => n > 1)
        .map(([t, n]) => `x${n}: "${t.slice(0, 70)}"`);

      // A figure only counts when it carries a unit.
      const UNIT = /(?:₹|\$)[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s?(?:%|×|R\b|:\s?1)/g;
      const figs = [];
      for (const el of document.querySelectorAll("#main .card, #main .ipo, #main .b-sec, #main .aic, #main .ef-c")) {
        const c = new Map();
        for (const m of (el.innerText || "").match(UNIT) || []) {
          const k = m.replace(/\s+/g, "");
          c.set(k, (c.get(k) || 0) + 1);
        }
        const bad = [...c].filter(([, n]) => n >= 3).map(([v, n]) => `${v} x${n}`);
        if (bad.length) figs.push(`${(el.innerText || "").split("\n")[0].slice(0, 14)}: ${bad.join(", ")}`);
      }
      return { sentences, figs };
    });
    ok(`${route} — no sentence is printed twice`, found.sentences.length === 0, found.sentences.slice(0, 3));
    ok(`${route} — no figure is printed three times in one block`, found.figs.length === 0, found.figs.slice(0, 3));
  }
  await dupCtx.close();

  console.log("\n  320 x 568 — the narrowest phone in use");
  const mCtx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const mp = await mCtx.newPage();
  // EVERY route, not five of them. The narrow-phone check covered #/, markets,
  // brief, signals and methodology — so screen, ideas, news, ipo, funds and
  // watch, which carry the widest content on the site (a 750-row table and
  // three others), were the six that were never measured. A sideways scroll is
  // the defect this whole block exists to catch, and it was unmeasured exactly
  // where it was most likely.
  for (const route of ["/", "/markets", "/screen", "/ideas", "/news", "/ipo",
                       "/funds", "/watch", "/engines", "/radar", "/reads", "/signals", "/brief", "/methodology"]) {
    await mp.goto(SITE + route, { waitUntil: "domcontentloaded" });
    // The screen fetches 1.4 MB before it lays out; the shorter settle used by
    // the other routes measured it mid-skeleton and would have passed anything.
    await mp.waitForTimeout(route === "/screen" ? SETTLE + 6000 : SETTLE);
    const ox = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // <= 0, not === 0 — see the note on the 1440 check above.
    ok(`${route} does not scroll sideways`, ox <= 0, ox);
  }
  // Seven tabs in a six-column grid pushed the bar 64px past a 390px phone.
  const tabFit = await mp.evaluate(() => {
    const t = document.querySelector(".tabs");
    return Math.round(t.getBoundingClientRect().width) <= document.documentElement.clientWidth;
  });
  ok("the tab bar fits the viewport", tabFit === true);
  await mCtx.close();
} finally {
  await browser.close();
}

console.log("");
if (fails.length) {
  console.log("FAILED");
  for (const f of fails) console.log("  · " + f);
  process.exit(1);
}
console.log("next-ui: ALL CHECKS PASSED");
