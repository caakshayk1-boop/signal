#!/usr/bin/env node
/**
 * set-domain.mjs — turn the site's SEO on, pointed at a real domain.
 *
 * The page ships `noindex` on purpose. Served from a workers.dev URL it is a
 * byte-for-byte duplicate of a page already indexed at
 * news.askakshay.com/next.html, and letting a crawler find both splits the
 * ranking of a page you already own.
 *
 * Three tags have to change together, and doing it by hand is how one gets
 * missed — a page that says index,follow while its canonical still points at
 * the other domain is worse than either state alone, because it actively hands
 * the ranking away. So it is one command:
 *
 *     npm run set-domain signal.askakshay.com
 *     npm run set-domain --  --unset      # back to noindex
 *
 * Run it only once DNS actually resolves. A canonical pointing at a hostname
 * that does not answer is a dead end a crawler will hold against the site.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");
const arg = process.argv[2];

const NOINDEX = `<meta name="robots" content="noindex,nofollow">`;
const INDEXED = `<meta name="robots" content="index,follow,max-image-preview:large">`;

let html = fs.readFileSync(FILE, "utf8");

// Always strip whatever is there now, so the script is idempotent and can be
// re-run against a different domain without stacking duplicate tags.
// og:image and twitter:image go back to relative too. Leaving them absolute
// on an unset was the first bug in this script: --unset restored noindex but
// left both images pointing at a domain that may not resolve, so the "off"
// state was not actually the state the repo shipped in.
html = html
  // Both patterns require the attribute that only a REAL tag carries. Without
  // it the canonical pattern also matched the words `<link rel="canonical">`
  // inside the comment that explains the noindex, and quietly ate them.
  .replace(/\n?<link rel="canonical" href="[^"]*">/g, "")
  .replace(/\n?<meta property="og:url" content="[^"]*">/g, "")
  .replace(/content="https?:\/\/[a-z0-9.-]+\/og\.png"/gi, 'content="/og.png"')
  .replace(INDEXED, NOINDEX);

if (!arg || arg === "--unset") {
  fs.writeFileSync(FILE, html);
  console.log("noindex restored; canonical and og:url removed.");
  process.exit(0);
}

const host = arg.replace(/^https?:\/\//, "").replace(/\/$/, "");
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
  console.error(`not a hostname: ${arg}`);
  process.exit(1);
}
const origin = `https://${host}`;

if (!html.includes(NOINDEX)) {
  console.error("could not find the robots tag — has index.html been edited by hand?");
  process.exit(1);
}
html = html.replace(NOINDEX, INDEXED);
// Anchored to og:type, which is the first og: tag and has been stable.
html = html.replace(
  `<meta property="og:type" content="website">`,
  `<link rel="canonical" href="${origin}/">\n<meta property="og:type" content="website">\n<meta property="og:url" content="${origin}/">`
);
// og:image and twitter:image are relative so they follow the domain, but some
// crawlers still want them absolute. Make them so, now that there is a domain.
html = html.replace(/content="\/og\.png"/g, `content="${origin}/og.png"`);

fs.writeFileSync(FILE, html);
console.log(`indexed as ${origin}`);
console.log("  canonical, og:url and og:image set; robots is index,follow.");
console.log("  Commit, redeploy, and confirm the domain resolves before submitting a sitemap.");
