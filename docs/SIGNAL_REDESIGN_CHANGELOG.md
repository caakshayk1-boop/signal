# Signal — changelog, 30 Sep 2026

## Architecture
- **Edge-rendered route HTML** — `src/seo.js`. Every page route gets its own `<title>`, description,
  canonical, Open Graph, Twitter card, JSON-LD (WebPage + BreadcrumbList) and a pre-render body
  (H1, what the page is, a few facts from the build, links) before any JavaScript runs.
  `/stock/<SYM>` is written from the company's own file; an unknown symbol is a real 404 with
  `noindex`.
- **One route table** — `scripts/route-meta.mjs` extracts `META` from `signal.js` into
  `src/route-meta.js`; the guard fails the build if they differ.
- **Company files** — `scripts/company-pages.mjs` writes `public/c/<KEY>.json` (984), `_site.json`,
  `sitemap.xml` (from the route table, 25 routes) and `vision-sitemap.xml` at deploy. They are not committed.

## UI
- Bottom tab "Home" → **Today**.
- **Vision** link in the header bar (compact under 820 px, hidden under 360 px; the density toggle
  yields its slot under 820 px).
- **Vision ↗** beside every NSE stock link (`symLinks`), **Open in Vision** on the stock page,
  "Open <SYM> in Vision" and "Vision ↗" in ⌘K.
- Ledger filter **Closed** (won + lost + expired) beside All / Open / Winners / Losers / Expired.
- META rows for `/about`, `/disclaimer`, `/disclosures` — they had been the front page in the head.

## SEO
- robots.txt names Vision's sitemap too; sitemap regenerated each deploy with current `lastmod`.

## Tests
- `test/guard.mjs` 311 → 338: route-meta in step; every page route has its own title; one file-key
  rule in four places; each product names the other in exactly one constant; insight.js
  behaviour (no claims from an empty row, negative equity named, basis + source on every claim,
  no recommendation language); Closed filter.
- `test/ui.mjs`: raw-HTML checks for `/about`, `/markets`, a 404 stock, and Vision's home and
  company page on production.

## Scheduling
- `vision_scan.yml` added to the Cloudflare watchdog; Vision's syncs moved to 08:40 / 10:55 UTC
  and added as watchdog slots. Guard 338 → 345 with a cron/slot parity check.

## Remaining debt (see SIGNAL_AUDIT.md)
The BUY/SELL verdict wording; the home page's ten-feed wait; analytics events.
