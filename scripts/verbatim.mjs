/* ── ONE ARITHMETIC, TWO PRODUCTS ─────────────────────────────────────────
 *
 * vision.js carries its own copy of the move score rather than importing
 * signal.js — that bundle is 500 KB and runs a whole
 * router on load. A copy is the right trade only if it cannot drift, so the
 * copy is not hand-kept: `node scripts/verbatim.mjs` writes it out of
 * signal.js, and test/guard.mjs extracts the same definitions from both files
 * and fails if a single token differs.
 *
 * Comments and whitespace are ignored by the comparison; code is not. A fix
 * made in signal.js and not re-copied fails the build instead of quietly
 * giving the two products different scores for the same name.
 */
import { readFileSync, writeFileSync } from "node:fs";

/* The move score only. Vision carried the ledger's record statistics too
   until signals were taken out of it (2026-09-23); they will return with the
   rebuilt signal product, not as a copy. */
export const CORE = [
  /* `band` is declared five times in signal.js, in five scopes; the radar's is
     the one taking a range. A name alone would silently copy the first. */
  "band = (v, lo, hi)", "avg", "radarParts", "RADAR_W", "radarPriority", "radarRisk",
  "radarScore", "strengthWord",
];

/* Strip comments without touching strings or template literals. */
export function stripComments(s) {
  let out = "", i = 0, q = null;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (q) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === "'" || c === '"' || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && n === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === "/" && n === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
    out += c; i++;
  }
  return out;
}

/* The full `const NAME = …;` statement, found by bracket depth. */
/* Located in the RAW source and only then comment-stripped, from the match
   onward: a whole-file strip would have to parse every regex literal in a
   15,000-line bundle, and one /["']/ would flip it into a string for good. */
export function extract(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|\\n)[ \\t]*const ${esc.includes("=") ? esc : esc + " = "}`).exec(src);
  if (!m) return null;
  const code = stripComments(src.slice(m.index + m[1].length));
  const start = code.indexOf("const");
  let i = code.indexOf("=", start) + 1, depth = 0, q = null;
  for (; i < code.length; i++) {
    const c = code[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return code.slice(start, i + 1);
  }
  return null;
}

export const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/* Writes the block between the markers in vision.js. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const sig = readFileSync("public/signal.js", "utf8");
  const parts = CORE.map((n) => {
    const t = extract(sig, n);
    if (!t) throw new Error(`signal.js has no const ${n}`);
    return "  " + t.trim();
  });
  const file = "public/vision.js";
  const v = readFileSync(file, "utf8");
  const A = "/* ══ VERBATIM CORE BEGIN", B = "/* ══ VERBATIM CORE END";
  const a = v.indexOf(A), b = v.indexOf(B);
  if (a < 0 || b < 0) throw new Error("vision.js is missing the VERBATIM CORE markers");
  const head = v.slice(0, v.indexOf("\n", a) + 1);
  writeFileSync(file, head + parts.join("\n") + "\n  " + v.slice(b));
  console.log(`verbatim: ${CORE.length} definitions copied from signal.js`);
}
