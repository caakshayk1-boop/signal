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
- The primary action stays **Today's brief**; the secondary is **the ledger**. Email is
  not promoted as a conversion until something sends it.
- Five destinations: Today, Brief, Screen, Ledger, Markets. Watchlist, All tools and
  search are utilities.
