# Vision — changelog, 30 Sep 2026

## Architecture
- The Worker now writes `/` and `/company/<KEY>` (`src/seo.js`): unique title, description,
  canonical, Open Graph, JSON-LD, `index,follow`, and a readable body — for the company: price and
  levels, **What matters**, **What changed** (with sources), and a link to its Signal record.
- `public/insight.js` — deterministic synthesis shared by Worker and browser. Thresholds live in
  one object (`T`) and are printed on the page.
- `/company/<KEY>` is a real path the app opens as the company view; hash routes still work.
- The server-written block is hidden when JavaScript runs (`html.js .ssr`), so the page is never
  painted twice.

## Surfaces
- **Companies (home)**: search as the hero (typeahead, keyboard, highlighted matches, recent and
  watched names), what changed across the screen (score moves since the last build), unusual
  today (volume 3×, 52-week highs, results in 7 days), the two setups, most-traded directory.
- **Company page**: What matters (8 measures, each with context and source), What changed
  (improved / weakened / worth weighing / events, each with basis and source, and "How these are
  decided"), plus Compare, On Signal ↗, Copy link.
- **Compare**: up to five companies across 19 measured rows, sticky labels, key differences; the URL
  is shareable (`#/compare?s=TCS,INFY`).
- **Definitions**: "i" buttons open a short definition (R, ATR, ROCE, PE percentile, cash
  conversion, relative strength, volume spike…).
- **Navigation**: primary = Companies, Compare, Signals, Screener, Heatmap, Today; More = Cockpit,
  Markets, News, Watchlist, Alerts, ← Signal. Phone tabs = Companies, Signals, Screener, Heatmap, More.
- **Header**: "← Signal" beside the brand. ⌘K: recent companies, Compare, Back to Signal,
  "Compare <SYM> with peers", "<SYM> on Signal".

## Measured
Local, 390 px, throttled: home LCP 1.38 s / CLS 0.012; company page LCP 1.26 s / CLS 0.003.
No sideways scroll at 320, 390 or 1440 px; nav clear of the header controls at 1100–1440 px.

## Not built, and why
Quarterly financials, a filings timeline, price charts with event markers and Ask Vision all need
data or a backend this stack does not have. VISION_AUDIT.md §3 says what each needs, and gives the Ask Vision contract.
