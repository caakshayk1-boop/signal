#!/usr/bin/env node
/**
 * minify.mjs — ship the browser the code, not the documentation.
 *
 * WHY THIS EXISTS
 * ---------------
 * public/ is the wrangler assets directory: every file in it is served to a
 * phone exactly as committed. There has never been a build step, so every
 * visitor downloads this repo's documentation along with its program.
 *
 * Measured on the 2026-09-19 build:
 *
 *   signal.js    318 KB gzipped  ->  143 KB   (26% of the file is comments)
 *   signal.css    99 KB gzipped  ->   37 KB
 *   ───────────────────────────────────────
 *   417 KB  ->  180 KB, on every cold load
 *
 * The comments are not waste — they are the reason this codebase is
 * maintainable, and several of them are the only record of why a rule exists.
 * They belong in the repository. They do not belong on somebody's 4G
 * connection.
 *
 * WHY esbuild AND NOT A REGEX
 * ---------------------------
 * The first attempt was a hand-rolled comment scanner. It produced a file that
 * PARSED and was still wrong: a scanner that does not understand regex
 * literals reads `/https?:\/\//` as the start of a line comment, and one that
 * does not understand `${}` nesting mangles template literals. This file is
 * mostly multi-line HTML templates. "It parses" is not "it behaves the same",
 * and there was no way to tell the difference by looking.
 *
 * esbuild has a real JS parser. Identifier minification is safe here because
 * signal.js is one IIFE — every name inside is local — and esbuild never
 * renames object PROPERTIES, which is what every `.name` in this file is
 * (err.name, r.name, LANES[k].name). There is no eval and no new Function.
 *
 * IN PLACE, AND ALWAYS RESTORED
 * -----------------------------
 * wrangler serves ./public, so the minified bytes have to be there when it
 * runs. CI checks out fresh, so writing in place costs nothing there. On a
 * laptop it would leave the working tree full of minified files, so the
 * originals are restored in a finally — including when wrangler fails, which
 * is the case a `&&` chain gets wrong.
 *
 * Run as `node scripts/minify.mjs -- <command...>`: it minifies, runs the
 * command, and restores whatever happens.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";

// Every asset the browser parses. index.html is NOT here: scripts/csp-hashes
// computes hashes over its inline scripts, and changing a byte of it after
// that runs would invalidate every one of them.
const TARGETS = [
  ["public/signal.js", "js"],
  ["public/signal.css", "css"],
  ["public/heat.css", "css"],
  ["public/engines.js", "js"],
  ["public/heatcore.js", "js"],
  ["public/gems.js", "js"],
  ["public/brief_fundamentals.js", "js"],
];

const kb = (n) => (n / 1024).toFixed(0).padStart(4);
const saved = [];
const originals = new Map();

for (const [file, loader] of TARGETS) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  originals.set(file, src);
  const out = esbuild.transformSync(src, {
    loader,
    minify: true,
    legalComments: "none",
    // A syntax target old enough that nothing is transpiled UP into polyfills
    // and nothing is lowered into something larger than it started.
    target: "es2020",
  });
  writeFileSync(file, out.code);
  saved.push([file, src.length, out.code.length]);
}

for (const [f, a, b] of saved) {
  console.log(`  ${f.padEnd(32)} ${kb(a)} KB -> ${kb(b)} KB`);
}
const tot = saved.reduce((s, [, a, b]) => s + (a - b), 0);
console.log(`  ${"".padEnd(32)} ${kb(tot)} KB removed before transfer`);

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
let code = 0;
if (dash >= 0 && argv.length > dash + 1) {
  const [cmd, ...rest] = argv.slice(dash + 1);
  try {
    code = spawnSync(cmd, rest, { stdio: "inherit", shell: false }).status ?? 1;
  } finally {
    // ALWAYS. A failed deploy that leaves minified files behind is how a
    // stripped signal.js gets committed by the next `git add -A`.
    for (const [f, src] of originals) writeFileSync(f, src);
    console.log("  sources restored");
  }
}
process.exit(code);
