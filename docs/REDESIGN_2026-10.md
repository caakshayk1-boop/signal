# Signal + Vision redesign, October 2026

## Diagnosis (before)

**What Signal is**, read from the repository rather than assumed: a free research desk for
Indian equities, built and signed by one chartered accountant. Before every NSE open it
re-screens ~1,000 names, writes one setup up in full (the brief), and grades every signal
it has ever published on a public ledger, losses included. It has no login, no paywall,
no ads and no product to sell. The email form (`/join`) stores addresses, but nothing
sends the daily email yet. The only real "conversion" is **a reader coming back
tomorrow and trusting the record**. `DESIGN.md`'s one-sentence brief still holds:
*an honest desk, not a brokerage.*

**Who comes, and for what:**
- A first-time visitor needs to know what this is, whether its record is any good, and
  where to start. The answer is today's brief or the ledger.
- A returning reader wants today's read, the screen, the ledger or the board, in one tap.

**What was wrong:**
1. **The header did eleven jobs.** Brand, route label, edition, clock, market state,
   feed-freshness pill, Vision link, search, a CTA with a subtitle, density, theme. It
   wrapped at 1280px and truncated the route label to "Scre…".
2. **Navigation was a phone pattern on a desktop.** Six icon-over-label tabs sat in their
   own 58px row under a two-line beige disclaimer band. On a 900px-tall laptop, 165px of
   chrome came before any content.
3. **No stated hierarchy of destinations.** Today, Markets, Discover, Watch, Ledger and
   Brief were equal tabs. Watch is a personal utility. Discover is an index of eleven
   tools, rendered as cards with right-aligned titles and stray arrows.
4. **The homepage opened on a 64px slogan.** It filled half the first screen, followed by
   a lone "FII & DII — not published" card floating on the right. The market state, the
   actual reason to open the page, sat below the fold.
5. **Identity drift.** Periwinkle accent `#5669FF`, 16–32px radii, soft shadows, tinted
   card grids and uppercase mono labels everywhere read as a generic fintech dashboard.
   Only the brief (`/brief`) had an editorial voice (Newsreader serif), so one page
   looked like a different product.
6. **Vision looked unrelated.** It defaulted to a dark theme, used a different accent,
   uppercase nav, and a different header anatomy. Nothing on screen said the two are one
   family.
7. **A promise the backend does not keep.** `/join` advertises "one email each
   morning", but no job sends it (`scheduled_tasks_runner.run_subscribers` only exports
   the list).

**What must survive:** every route and URL, the ⌘K palette, freshness reporting, the
live refresh, the static disclaimer in first paint, the pre-render, edge SEO, the
watchlist, the email capture, and every honesty rule pinned by `test/guard.mjs` and
`test/ui.mjs`.

**One layout or two?** One. There is no authenticated workspace; returning readers and
first-time visitors see the same destinations. The homepage does the explaining and
every other route is a workspace.

## Assumptions (all reversible)
- Light remains the default, following the system setting, on both sites. Vision loses
  its dark-by-default.
- The header's one filled button is **Today's brief**, the daily product. The masthead's
  first button stays **the record**, an earlier decision that `test/ui.mjs` pins. A
  first-time visitor is asked to check the evidence before anything else. Email is not
  promoted as a conversion until something sends it.
- Five destinations: Today, Brief, Screen, Ledger, Markets. Watchlist, All tools and
  search are utilities.

## Design direction

**An independent research desk, set like a publication and operated like a tool.**
- **Paper neutrals and ink.** The page is `#F8F7F4` paper, panels are white sheets on it,
  and text runs ink → muted → dim. Every text token measures at least 4.5:1 on all three
  grounds, in both themes.
- **One accent: cobalt** (`#2743C8` light, `#8DA2FF` dark). It marks where you are and what
  to press next. It is never a gain, a loss or a warning, so it cannot be misread as a
  price moving.
- **Three voices, one job each.**
  - **Newsreader**, the brief's serif, now sets route titles and the masthead: the lines
    that say what a page is.
  - **Plus Jakarta** sets everything you operate or scan.
  - **JetBrains Mono** sets figures that must line up.
  - Labels are sentence case, not tracked capitals.
- **The tick** is the one motif: a hairline with a short accent stroke at its start, the
  mark a grader makes against a scale. It heads every section and marks the active
  destination, and it is the brand mark: a baseline with one raised tick.
- **Geometry.** 4–16px radii, where there were 14–32px. Shadows only on things that
  float (sheets, dialogs, menus). Data panels are drawn by their hairline.
- **Motion.** A route change cross-fades; a control acknowledges a press. Sections no
  longer fade in on scroll.

## What changed

**Shell (Signal)**
- The header is now one 60px row:
  - family: Signal, plus a quiet Vision sibling pill;
  - five destinations: Today, Brief, Screen, Ledger, Markets;
  - utilities: freshness, search ⌘K, watchlist, More;
  - one filled button: Today's brief.
- Under 1024px the same `<nav>` docks to the bottom as a five-cell tab bar, with 44px+
  targets.
- The edition and the session clock moved into the ticker.
- The disclaimer is one quiet line at every width. It is still static HTML in the first
  paint, and still expands to the full statement without JavaScript.
- **More** is a native modal `<dialog>`, filled from `DISCOVER`: every research tool, the
  watchlist, how the record is made, the sibling products, theme and density. Focus moves
  in and returns to the button; Escape and a backdrop click close it. On a phone it is a
  bottom sheet.
- The footer is a map: the five destinations, tools, how it is made, the family, and the
  author.

**Homepage**
- The headline is now permanent and says what Signal is: *Every NSE name, screened before
  the open. Every call, graded in public.* It used to change with the record.
- The record is the line under it (published, closed, lost, R per trade). It is still
  above the fold, and "See the record" is still the first button.
- "Before the open" is one ruled table: Nifty, Sensex, India VIX with its band in words,
  FII/DII net, and screen breadth. It used to be four floating cards.
- A new three-part strip under the masthead (Screen, Brief, Ledger) says what Signal does
  and is also the fastest way in.
- A Vision band sits after the day's content, linking today's three most-traded names to
  their company pages.

**Every route**
- Serif route titles, and section heads with the tick.
- Tiles and summary strips are white sheets with a hairline, not grey tint.
- Chips toggle to ink.
- Discover ("All tools") is a ruled list, not a grid of cards.

**Vision**
- Same tokens, same display face, same header anatomy. The family line reads
  **Signal / Vision**.
- Light by default, following the system, as on Signal. It was dark by default.
- Five destinations plus More. "Signals" is renamed **Setups**, so it cannot be confused
  with the parent product.
- Sentence-case labels. The empty trailing cell in ruled grids no longer shows as a grey
  block.

**Copy**
- Page titles match the navigation. The Ledger tab opened a page titled "Signals"; it is
  now titled "Ledger".
- `/join` no longer promises "one email each morning". Nothing sends that email yet: the
  list is stored and exported, not mailed. The page, its success receipt and its search
  metadata now say so.

**Bugs fixed along the way**
- Every `/stock/*` page scrolled 576px sideways at 1280px. `.baro` was both the
  barometer's flex row and the stock card's list of bar rows.
- The stock page's "Open in Vision" line pushed a 375px phone 2px sideways.
- The pre-rendered snapshot was shorter than the live page, so the footer jumped into and
  out of the first screen. This was most of the front page's CLS.

## Checks
- `node test/guard.mjs`: **359/359**. Six assertions were changed on purpose, each with
  its reason written beside it:
  - five slots, not six;
  - `#moreBtn` is now a header utility, never a slot;
  - Newsreader is reached through `--disp` and `--b-serif`, never `--ui` or `--serif`;
  - the serif is still not preloaded (measured, below);
  - Vision's default theme is light;
  - `test/ui.mjs` now expects five destinations.
- A local browser suite of 103 checks, all passing:
  - navigation, active states, the More dialog (focus in and out, Escape, link-and-close,
    theme), ⌘K;
  - hero contracts pinned by `test/ui.mjs`;
  - visible keyboard focus, and reduced motion;
  - no horizontal overflow on 10 Signal and 5 Vision routes at 375, 768, 1280 and 1440px;
  - tab-bar placement and 44px targets on phones;
  - Vision's family link, search-as-you-type and system theme;
  - no page errors.
- **Not run: the full `test/ui.mjs`.** It needs the live `/api/*` endpoints, which this
  sandbox's network refuses (HTTP 403). It stops at `/markets` before any redesigned
  surface on both `main` and this branch. The markets, flows and ticker APIs were mocked
  to check the masthead with live-shaped data.

### Measured, local, median of three, identical data (main → this branch)

| Route | Setting | LCP | CLS |
|---|---|---|---|
| Signal `/` | 1280px | 700 → 636 ms | 0.114 → **0.005** |
| Signal `/` | 390px, 4× CPU, 1.6 Mbps | 1404 → 1480 ms | 0.001 → 0.001 |
| Vision `/` | 1280px | 344 → 152 ms | 0.009 → 0 |
| Vision `/` | 390px, 4× CPU, 1.6 Mbps | 1376 → 1432 ms | 0.012 → 0 |
| Vision `/company/TCS` | 390px, 4× CPU, 1.6 Mbps | 1268 → 844 ms | 0.003 → 0.004 |

- Signal's throttled phone LCP is **76ms slower**. The front page carries 156 more nodes
  (footer, More sheet, capability strip, Vision band) and more CSS.
- Preloading the serif was tried and removed: +92ms LCP, no CLS benefit.

## Not done, and why
- **The daily email.** The form works and stores addresses, but nothing sends mail. That
  needs a sending job and a mail provider. The copy now says so instead of promising it.
- **The full UI suite against production.** It runs in `deploy.yml` after a deploy, and
  this branch has not been deployed.
- **Signal's brief page** keeps its own sub-theme (`--b-*`, already serif and editorial).
  Only its dark neutrals were aligned. Its uppercase mono labels were left as they are.
- **Every one of the 26 routes was not individually re-laid-out.** They inherit the new
  tokens, route heads, section heads, tiles, chips and panels. Bespoke components deep in
  `/brief`, `/ipo`, `/funds` and `/map` keep their existing layouts.
