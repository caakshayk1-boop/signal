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

  await p.goto(SITE + "#/markets", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);

  const rows = p.locator(".mk");
  const nRows = await rows.count();
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
  await p.goto(SITE + "#/brief", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);

  const body = await p.locator("main").innerText();
  ok("no NaN, undefined or Infinity anywhere", !/NaN|undefined|Infinity/.test(body),
     (body.match(/NaN|undefined|Infinity/g) || []).slice(0, 3));

  // The count-up must land on its value even where rAF never runs.
  const conf = (await p.locator("#dialN").innerText()).trim();
  ok("confidence resolves to a number", /^(\d+|—)$/.test(conf), conf);

  ok("chart draws from real closes", await p.locator("#pxc .price").count() === 1);
  const cap = await p.locator(".b-cap").first().innerText();
  ok("chart says how many closes it drew", /\d+ real daily closes/.test(cap), cap.slice(0, 80));

  // R:R is stated against BOTH targets — one unlabelled figure meant the
  // header and the calculator printed different numbers for the same trade.
  ok("R:R is labelled by target", /R:R TO T1/i.test(body) && /R:R TO T2/i.test(body));

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
  const tb = p.locator(".tipb").first();
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

  // Section jump must clear all three sticky layers.
  await p.keyboard.press("4");
  /* Wait for the scroll to SETTLE rather than a fixed timeout. The page grows
   * as sections are added, so a jump that used to take 300ms started taking
   * two seconds and the old fixed wait measured it mid-flight — a green test
   * turning red because the page got longer, not because it broke. */
  await p.waitForFunction(() => {
    const y = Math.round(window.scrollY);
    if (window.__lastY === y) return true;
    window.__lastY = y; return false;
  }, null, { timeout: 8000, polling: 200 });
  const planTop = await p.locator("#b-plan").evaluate(e => Math.round(e.getBoundingClientRect().top));
  ok("a section jump clears the sticky stack", planTop > 90 && planTop < 240, planTop);


  /* THE BRIEF MUST NOT SWAP THE INSTRUMENT UNDER THE READER.
   * briefSym was consumed on first use, so the 60-second repaint fell back to
   * "highest reward-to-risk" and quietly changed which company was on screen
   * while someone was reading it. */
  await p.goto(SITE + "#/signals", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);
  const nLinks = await p.locator("a.brief-link").count();
  ok("signal cards offer a Full brief link", nLinks > 0, nLinks);
  if (nLinks > 1) {
    const link = p.locator("a.brief-link").nth(1);   // deliberately not the default pick
    const wanted = await link.evaluate(a => a.dataset.brief);
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
  await p.goto(SITE + "#/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(SETTLE);

  ok("the hero renders", await p.locator(".hero h1").count() === 1);
  ok("the CTA states how long the brief takes",
     (await p.locator(".btn-hero").innerText()).includes("60 seconds"));
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
  await p.goto(SITE + "#/markets", { waitUntil: "domcontentloaded" });
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
     (await p.evaluate(() => location.hash)) === "#/methodology");

  // Four pages that publish what the product can and cannot do. A disclosure
  // page that renders empty is worse than no page.
  for (const [route, must] of [["#/methodology", "multiples of the risk"],
                               ["#/sources", "Yahoo"],
                               ["#/terms", "not investment advice"],
                               ["#/privacy", "No accounts"]]) {
    await p.goto(SITE + route, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3500);
    const t = await p.locator("main").innerText();
    ok(`${route} renders its disclosure`,
       t.length > 600 && t.toLowerCase().includes(must.toLowerCase()), t.length);
  }

  await p.goto(SITE + "#/signals", { waitUntil: "domcontentloaded" });
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
    ok("the empty curve says the record starts here", /The record starts here/.test(t));
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
  await p.goto(SITE + "#/screen", { waitUntil: "domcontentloaded" });
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

  await p.goto(SITE + "#/watch", { waitUntil: "domcontentloaded" });
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
  await rp.goto(SITE + "#/brief", { waitUntil: "domcontentloaded" });
  await rp.waitForTimeout(SETTLE);
  ok("every section is visible", await rp.locator(".b-reveal:not(.in)").count() === 0);
  ok("every chart overlay is visible", await rp.locator(".b-ov:not(.on)").count() === 0);
  ok("the confidence figure is written", /^\d+$/.test((await rp.locator("#dialN").innerText()).trim()));
  // The assertion is that the FILL STEP RAN, not that every score is positive:
  // a component genuinely scoring 0 renders a 0% bar, and treating that as
  // "never filled" is the test inventing a defect. Every bar must carry a
  // width, and at least one must be non-zero.
  const widths = await rp.locator(".b-crow .tr i").evaluateAll(es => es.map(e => e.style.width));
  ok("every score bar was given a width", widths.length > 0 && widths.every(w => !!w), widths);
  ok("at least one score bar is non-zero", widths.some(w => w && w !== "0%"), widths);
  await rmCtx.close();

  /* ── NARROW ──────────────────────────────────────────────────────────── */
  console.log("\n  320 x 568 — the narrowest phone in use");
  const mCtx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const mp = await mCtx.newPage();
  for (const route of ["#/", "#/markets", "#/brief", "#/signals", "#/methodology"]) {
    await mp.goto(SITE + route, { waitUntil: "domcontentloaded" });
    await mp.waitForTimeout(SETTLE);
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
