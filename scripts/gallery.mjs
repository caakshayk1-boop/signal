#!/usr/bin/env node
/**
 * gallery.mjs — render the real components against the real stylesheet.
 *
 * WHY THIS EXISTS. Every route on this site is client-rendered from an API,
 * so none of them can be opened without one — which means a CSS change was
 * being made blind and judged by reading the sheet. Two defects that had
 * shipped were found within minutes of rendering three real rows instead:
 *
 *   · .rd-f was TWO components. The /reads study figures and the radar's
 *     facts cell shared a class name, and being later in the sheet at equal
 *     specificity the study won. The radar's cells were computing
 *     margin:12px 0 4px, gap:6px 8px and flex-wrap:wrap from a rule written
 *     for another page. 301px of a 514px card.
 *   · the hierarchy was inverted. Measured: RSI 16px, symbol 14px, price
 *     13px — a supporting statistic set larger than the company it was about.
 *
 * Neither is visible in the source. Both are obvious in a screenshot.
 *
 * It extracts the SHIPPED render functions out of signal.js rather than
 * copying them, so the gallery cannot drift into showing markup the site does
 * not emit. The fixtures are real rows from a real screenshot.
 *
 *     node scripts/gallery.mjs      # then open the URL it prints
 *
 * Output goes to public/.gallery/, which is gitignored: this is a workbench,
 * not an asset, and it must never be deployed.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";

const OUT = "public/.gallery";
const JS = readFileSync("public/signal.js", "utf8");

const grab = (re, name) => {
  const m = JS.match(re);
  if (!m) {
    console.error(`gallery: could not find ${name} in signal.js — it was renamed or reshaped.`);
    process.exit(1);
  }
  return m[0];
};

const parts = [
  grab(/  const factsStrip = \(r, opts\) => \{[\s\S]*?\n  \};/, "factsStrip"),
  grab(/  const bandLine = \(r\) => \{[\s\S]*?\n  \};/, "bandLine"),
  grab(/  const radarRow = \(nd, i\) => \{[\s\S]*?\n  \};/, "radarRow"),
  grab(/  const offHigh = v => \{[\s\S]*?\n  \};/, "offHigh"),
];

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/parts.js`, parts.join("\n\n"));
copyFileSync("test/gallery/gallery.html", `${OUT}/gallery.html`);

console.log(`gallery: ${parts.length} renderers extracted from the shipped source`);
console.log(`  npx http-server public -p 8901   (or any static server rooted at public/)`);
console.log(`  http://127.0.0.1:8901/.gallery/gallery.html`);
