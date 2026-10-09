#!/usr/bin/env node
/**
 * The pre-hydration body of the front page, written into public/index.html at
 * build time from the SAME canonical plan feed the live page reads
 * (public/signal_v2.json). A crawler, a link preview and a reader on a slow
 * phone see the V2 status the app will paint a second later — never a record
 * the app does not show.
 *
 * Signal V2 (2026-10-01): no V1 ledger is read here. /api/signals and
 * engines.js are not consulted; the old record is excluded from every surface.
 */
import { readFileSync, writeFileSync } from "node:fs";
import "../public/record-analytics.js";
import "../public/signal-ui.js";

const OPEN = "<!--PRERENDER-->";
const CLOSE = "<!--/PRERENDER-->";
const read = (f) => { try { return JSON.parse(readFileSync(`public/${f}.json`, "utf8")); } catch { return null; } };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : "";
};

const v2 = read("signal_v2");
const news = read("news") || [];
const wire = Array.isArray(news) ? news : [];
const ok = v2 && v2.schema === "signal-v2-public/1";

const block = `${OPEN}
<section class="pre">
  <p class="pre-k">Signal${ok ? ` · latest session ${esc(day(v2.session_date))}` : ""}</p>
  <h1 class="pre-h">Indian equities, screened after the close.</h1>
  <p class="pre-s">Conditional paper plans for the next session, and a forward record that counts every one.</p>
  ${globalThis.SignalUI.snapshot(v2)}
  ${wire.length ? `<ul class="pre-l">${wire.slice(0, 4).map((x) =>
    `<li><b>${esc(x.source || "wire")}</b> — ${esc(x.title || "")}</li>`).join("")}</ul>` : ""}
</section>
${CLOSE}`;

const path = "public/index.html";
let html = readFileSync(path, "utf8");
if (html.includes(OPEN) && html.includes(CLOSE)) {
  html = html.replace(new RegExp(`${OPEN}[\\s\\S]*?${CLOSE}`), block);
} else {
  const mm = html.match(/<main id="main"[^>]*>/);
  if (!mm) { console.error("prerender: <main id=\"main\"> not found — nothing written"); process.exit(1); }
  html = html.replace(mm[0], `${mm[0]}\n${block}\n`);
}
writeFileSync(path, html);
console.log(`prerender: ${block.length} bytes into <main>${ok ? ` (plans, session ${v2.session_date})` : " (no plan feed)"}`);
