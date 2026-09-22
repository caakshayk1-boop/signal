# signal.askakshay.com — the design DNA

**Written:** 22 September 2026 · **Sheets it governs:** `public/signal.css`,
`public/gems.css`, `public/heat.css` · **Pinned by:** `node test/guard.mjs`

This document exists because 6,204 lines of stylesheet carried about forty
design decisions in prose comments and no statement of the decision *rule*
behind them. A comment explains the change it sits on. It cannot tell the next
change what to do. Everything below is a rule, and every token it names is
asserted to exist by the guard — so this file cannot drift away from the CSS
without failing a build.

It is written to be **checked, not believed**, in the same way `AUDIT.md` is.
Where a rule is stated and the code does not yet obey it, that is recorded as
an open item with its measured size, not quietly omitted.

---

## 0. The one-sentence brief

**An honest desk, not a brokerage.**

The product is a trading book that publishes its losses. Measured at
2026-09-18: 45 published, 13 closed, **1 win and 12 losses**, expectancy
**−0.765R**, t = −2.79, and the 95% interval on expectancy excludes zero.
The front page says so in the largest type on the site.

Every design decision below follows from that one fact, because a page whose
job is to be trusted about a losing record cannot be styled like a page whose
job is to sell a winning one. Those are opposite briefs and they produce
opposite typography, opposite density and opposite colour.

### What was rejected, and why

The obvious alternative was the **terminal** direction — Koyfin, Bloomberg, a
wall of dense panels, authority by volume. It was rejected on three grounds:

1. **It claims what this book cannot.** A terminal's visual argument is
   *coverage* — 71 instruments, everything at once. This site's argument is
   *disclosure*. Density says "we see everything"; the record says "we have
   been wrong twelve times out of thirteen." Wearing the first while saying
   the second is the product arguing with itself.
2. **It is unreachable on the actual hardware.** The audited surface is
   mobile-first — the 2026-08-28 measurement that produced this stylesheet was
   a phone at performance 25 with 14,197 DOM nodes. A panel wall is a 27-inch
   idiom.
3. **It is the look a reader already distrusts.** Every tipping service on the
   Indian retail internet is styled as a terminal. Looking like them is the
   one thing a site with a public negative expectancy cannot afford.

The consumer-brokerage direction (Groww, Tickertape) was *half* adopted and
that is deliberate: its **surfaces** are right — white page, tinted panels,
hairlines, generous radii, no drop shadow on a data card — and its **posture**
is wrong. It is built to make investing feel easy. Nothing here may.

---

## 1. Personality — five characteristics

| | reads as | and is enforced by |
|---|---|---|
| **Plain** | no metaphor, no illustration, no stock photography, no icon that repeats a word already on screen | nothing on the site loads an image asset for decoration |
| **Exact** | figures are monospaced and tabular; a score carries its denominator; a percentage under five closed trades is shown as `1W / 12L` instead | `--mono`, `font-variant-numeric: tabular-nums` |
| **Unflattering** | the losing number is not smaller, greyer or further down than the winning one | the loss colour and the gain colour are the same weight and the same size |
| **Literal about absence** | a thing that did not arrive says so in words; it is never a zero, a dash with no explanation, or a section that silently disappears | the `data_health` vocabulary and the barometer's coverage line |
| **Quiet** | motion acknowledges input and nothing else; no attention-seeking animation, no auto-playing carousel, no number that counts up | three durations, two curves, no more |

The fifth is the one that is easiest to lose. A page that animates to impress
is a page asking to be liked, and this one is asking to be audited.

---

## 2. Theme — light default, dark equal, machine ignored

**Light is `:root`. Dark is `:root[data-theme="dark"]`. There is no separate
light block**, because a second definition of the default can only ever
disagree with it — and it did: it held `--bg` at `#F7F8FA` and overrode the
white the palette is built on.

Both themes are **first class**, not a courtesy. A markets page is opened at
6am and at midnight. The dark theme is the same blue-grey family rotated to the
dark end, never a neutral grey, or the toggle changes the product rather than
the brightness.

`color-scheme` follows the **site**, not the OS. Without it the user agent
paints dialogs, form controls and scrollbars from the machine's setting: a
`<dialog>` in the top layer inherited the UA's `CanvasText` and drew white
text on this site's light panel at **1.07:1** — which is what a reader on a
dark-mode Mac saw every time they pressed ⌘K.

---

## 3. Surfaces — four levels, flat, hairlined

```
--bg        the page                    #FFFFFF   /  #0C1017
--surface   a card on the page          #FFFFFF   /  #141B25
--raised    a panel inside a card       #F1F4F8   /  #1A2230
--raised2   the quietest fill           #F9FAFC   /  #151C27
--line      a hairline                  #E7EAF0   /  #242E3E
--line2     a hairline that must be seen #D8DEE8  /  #33404F
```

**Separation is a border, not a shadow.** In light, `--surface` and `--bg` are
the same white; what makes a card a card is its 1px `--line`. This is the
single decision that keeps the page from reading as a stack of floating
widgets.

The blue lives in the **surface tint**, not in an accent splashed about. That
is the actual mechanism behind the reference sites' calm, and it is why the
palette reads as blue while almost nothing on the page is blue.

---

## 4. Elevation — four steps, and they work at night

A shadow means *this surface is temporarily above the page and will go away*.
Nothing permanent gets one. There are exactly four:

```
--e-1   a resting card that must lift slightly off the board
--e-2   a floating control (the to-top button)
--e-3   a popover, a menu, a toast
--e-4   a modal (the command palette)
```

**Each theme declares the whole string.** The dark values are not the light
ones with a bigger alpha — they are an inset white rim plus a much heavier
black, because a shadow spread over `#0C1017` separates nothing on its own.

This is a rule with an incident behind it. Before it, five bespoke shadows
were in the sheet at alphas `.07 / .14 / .16 / .24 / .28`, no two agreeing on
a blur, **every one of them `rgba(0,0,0,…)`**. On the dark theme the command
palette, the tab menu, the toast and the to-top button all lost their
separation from the page and nothing reported it. A thing that quietly does
half its job is the exact fault this site is built to avoid.

`box-shadow` is also used for **rings and pulses** — `inset 0 0 0 1px`, and the
keyframes that flash a changed figure. Those are not elevation and do not use
these tokens.

---

## 5. Type — one family, two roles, twelve steps

```
--disp  --ui  --serif   Plus Jakarta Sans (variable, 200–800, one 27 KB file)
--mono                  JetBrains Mono — figures only
```

**One family for everything a person reads; mono for anything that must line
up in a column.** Newsreader's `@font-face` is still declared and nothing calls
it; a serif headline over a blue-grey fintech page was two products arguing.

Body text is set from the **system stack on the first frame** — the webfont is
`font-display: swap` and never blocks paint. Latin subset only; this site
contacts no third party, and loading four faces from a font CDN to look like
someone else would be a strange place to break that.

```
--t-1  10   --t-2  11   --t-3  12   --t-4  13   --t-5  14   --t-6  16
--t-7  18   --t-8  21   --t-9  25   --t-10 30   --t-11 36   --t-12 44
```

Twelve steps: about 1.12× apart at the top, 1px apart at the bottom where the
eye cannot resolve a ratio anyway. **`--t-11` and `--t-12` are editorial** —
the h1 and the one number a page is actually about. Nothing else may reach for
them.

**Ties round up.** One pixel larger costs nothing on a dense page; one pixel
smaller costs legibility.

**No literal px font-size may be written.** This is checked. It was 25 distinct
sizes before the scale, 6 after (`11.5`, `12.5`, `13.5` and friends — half-pixel
steps that are not levels of hierarchy, they are two people guessing on
different days), and is now zero in `signal.css`.

Tracking is six steps, not twenty-eight: `--ls-tight` and `--ls-snug` for
display type, `--ls-0` for prose, `--ls-wide` / `--ls-wider` / `--ls-widest` for
the uppercase mono labels this site leans on.

---

## 6. Colour — three meanings, and nothing decorative

```
--up      #0A9D74  /  #2ECC93     a gain
--down    #E0483D  /  #FF6B60     a loss
--warn    #B07A08  /  #F0B429     caution, and ONLY caution
--accent  #5669FF  /  #8091FF     a link, a live figure, the primary action
--ma      a price level (the 200-day average)
--saved   a thing you saved
```

**Up and down are the same visual weight.** Not the same hue-brightness trick
every brokerage uses, where the green is saturated and the red is muted. On a
page that reports twelve losses against one win, a quieter red is a lie told
in CSS.

Groww's `#04B488` is the hue this green is tuned toward and is **not** the
value used: it measures 2.4:1 on white and this site prints gains at 11px all
day.

`--warn` carried nine meanings and three of them were not warnings — a moving
average is a price level, a starred row is a thing you saved, a trailing stop
is a rule. Those three have their own tokens now. **Amber means caution or it
means nothing.**

The primary action is the accent, not black. A black button on a blue-grey
page was the last element still wearing the old look.

---

## 7. Radius, spacing, density

```
--r-1  6    --r-2 10   --r-3 14   --r-4 18   --r-5 24   --r-6 32
--r-pill 999   --r-hair 1        --r  16  (the default every card reaches for)
--s-1  4  --s-2  8  --s-3 12  --s-4 16  --s-5 24  --s-6 32  --s-7 48  --s-8 64  --s-9 96
```

Roundness is most of what reads as *modern*: the reference cards are 22px and
32px against this site's old 12px. `--r` at 16 is the largest single change in
how the page reads, because almost every panel resolves its corners through it.

**Density is high by default and the escape is folding, not deletion.** The
reader is an operator; a section that has fifteen rows shows its lead and its
count and opens the rest on request (`foldBody`). Nine engine rows sat open
under every visit and made one section 610px on a phone. The *record itself*
never folds — folding it would change what the page claims rather than how
much it shows.

**Open item, measured:** the spacing scale is adopted at **35 sites** against
683 for the type scale. Margins and gaps are still set to 8, 9, 10, 11, 12, 13,
14, 16, 18, 20, 22 and 26 in most of the sheet. This is the same drift the type
scale was written to end, left running in the dimension that actually produces
the "tight boxes, no air" reading — and it is the largest open design defect in
the repo.

---

## 8. Motion — three durations, two curves, one job

```
--t-press 160ms   a finger landing (shorter than fast: the press must land
                  before the release)
--t-fast  140ms   a hover, a colour, a border
--t-mid   220ms   an element entering
--t-slow  380ms   a route, a panel unfolding
--ease            cubic-bezier(.22,.61,.36,1)
--ease-out        cubic-bezier(.16,1,.3,1)
```

Nothing on the page may animate at a speed nothing else uses — that is what
makes motion read as noise rather than response.

**Hover is not a state on a touch device.** All 83 hover rules are inside
`@media (hover:hover) and (pointer:fine)`. Without that gate a tap leaves a
card stuck in its hover paint until the next tap elsewhere.

**Every hoverable primitive has a press.** `scale(.97)` at `--t-press`. A
control that responds to a mouse and not to a finger is a control that feels
broken on the device most readers use.

`prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast`
are all honoured. **Motion is never a reason to fail a route** — the route
transition is wrapped in its own try/catch and the View Transition promises are
explicitly ignored, because the spec's response to a slow update is to skip the
animation, and that is not an error.

---

## 9. Charts and data visualisation

- **A chart is a reading, not a picture.** Every one carries its own units and
  its denominator. The heatmap colours by a name's move **in its own average
  range**, not in percent, because a 2% day is a different event in two names.
- **Two hues only**, `--up-rgb` and `--down-rgb` as bare channels so a tile can
  be laid at five alphas without `color-mix`. No rainbow, no sequential ramp
  that requires a legend to decode.
- **No chart junk**: no gridline that is not read off, no axis that is not
  labelled, no gradient fill under a line.
- **Nothing is recomputed in the browser.** A live overlay may re-read facts —
  price, off-high, stop — and must **not** invent a fresh score. A stamped score
  says *at build*. Inventing a number client-side is the fault this site avoids
  everywhere else.
- **A breached stop voids the setup and the call says so.** IFCI once read
  "Buy · 89 Strong" over its own live "−13.1% off its high".

---

## 10. Absence, freshness and the honesty layer

This is the part of the design system that is not about looking like anything.

- **Missing renders as the word for its absence, never as a zero.** A zero is a
  measured result; an absence is not.
- **No denominator, no ratio.** A made-up universe size is worse than none.
- **A partial reading states its coverage and names what did not answer.** The
  barometer renormalised over whatever components had arrived and printed the
  result as a score out of 100 — in two independently written copies of the
  same bug, one Python and one JavaScript.
- **A section that did not arrive says so.** A block that vanishes silently is
  indistinguishable from one that was never meant to be there.
- **No section phrases its own freshness.** One badge vocabulary, one snapshot
  per build, or two parts of a page will describe the same number as "0.5d old"
  and "12h old".
- **A count in copy is read from its registry, never typed.** A number written
  beside a list is a claim that the list will never grow, and three of them had
  already been overtaken: `/discover` led with "Seven ways" over eleven doors,
  `/engines` told search results "Nine engines" over a registry of eight, and
  the front page's own tile read "0 of 7 engines" after GUST was promoted out
  of research tier and the denominator beside it was not. Four other figures in
  the same copy were checked against their sources and are correct, so they
  stand — the rule is not "no numbers in prose", it is that a figure about a
  list must be counted from that list.
- **Nothing predicts.** No probability, no price target, no forecast, no
  confidence score. This is a design rule as much as an editorial one: there is
  no component for a prediction, so one cannot be added by accident.

---

## 11. Accessibility floor

- Focus is visible on everything focusable: `2px solid var(--accent)`, offset 2.
- **Touch targets: 44px where the control stands alone, never below WCAG's 24.**
  The blanket "44px minimum" this document first claimed was false in four
  places — `.icon-btn` at 32 (the theme toggle, the menu and the search, on
  every page and the most-tapped controls on the site), `.wstar` at 28,
  `.totop` at 42, and a range input at 24.

  The fix is a **hit area, not a bigger button**: growing `.icon-btn` to 44
  puts three 44px boxes in a 64px bar and changes the header's density, and
  density is the point of this design. A centred `::after` gives the finger 44
  and the eye 32. Verified at 390px with `elementFromPoint`: the button answers
  at 21px from its own centre in all four directions.

  **Hit areas must not overlap.** At an 8px gap, two 44px areas around 32px
  buttons cross by 4px, and in an overlap the later element in the DOM wins —
  a mis-tap, not a bigger target. The header gap is 12, so the centres sit
  exactly 44 apart and the areas meet without crossing.

  **`.wstar` widens on one axis only.** A square 44px area around a star in a
  40px row bleeds 8px into the rows above and below, and a tap meant to open
  one of those would save a name in this one. 44 wide, 36 tall.
- Colour is never the only channel: a direction is a colour **and** a sign.
- `[hidden]` must actually hide — `display:none !important`, the one rule in the
  sheet allowed to be important, because every row primitive sets `display` and
  therefore beat the UA rule. 37 rows on `/ipo` carried `hidden`, computed
  `display:flex`, and took 224px each.
- **Nothing that arrives late may move what someone is reading.** Every async
  block reserves its height first.

- **A live page is live out loud.** The 60-second refresh marks the cells that
  moved by flashing them; that feedback used to be entirely visual. One polite
  `role="status"` region, outside `<main>` because `<main>` is replaced
  wholesale on every repaint, now says what changed in words.

  Three rules govern it, and each was wrong in a draft:
  **an announcement is not an animation** — it is *not* gated on
  `prefers-reduced-motion`, because a reader who asked for less movement asked
  about movement, not about being kept informed;
  **it is a summary, not a firehose** — a refresh can move sixty cells and
  reading sixty aloud takes longer than the interval before the next one, so
  it names three and counts the rest;
  **the clear lands in a later task** — the accessibility tree is computed when
  the task ends, so clearing and setting a region in one task is only ever seen
  as the set, and two identical updates would be announced once.

---

## 12. What is deliberately not done

- **`.bar` is opaque and keeps its `backdrop-filter` anyway.** WebKit does not
  apply `backdrop-filter` on a sticky element while *reporting support* for it
  and returning `blur(12px)` from `getComputedStyle`, so `@supports` cannot
  detect it. Reproduced in Playwright's webkit: card levels legible straight
  through the header. A general design rule does not outrank a reproduction.
- **`gems.css` keeps its own colour vocabulary** (`--ink`, `--mut`, `--acc`,
  `--surf`) rather than being renamed onto signal's. Same values, different
  names; renaming is churn with no visual payoff and a real chance of dropping
  a declaration. It now shares the **type scale, the elevation steps and the
  motion vocabulary**, which is where new rules actually reach.
- **`gems.css` type literals are not retrofitted.** 21 distinct literal sizes,
  three of them (`8.5`, `9`, `9.5`) *smaller* than `--t-1`. Snapping those up is
  a real change to a dense sheet that cannot be verified from here. The count is
  a guard ratchet: it may fall, never rise.

---

## 13. How this file is kept true

`test/guard.mjs` asserts, on every deploy:

1. Every custom property this file names is really declared in `signal.css`
   or `gems.css`.
2. Both themes declare all four elevation steps, in both sheets.
3. No literal px font-size exists in `signal.css`.
4. The `gems.css` literal-size count has not grown.
5. No elevation is written by hand — every drop shadow goes through `--e-1..4`.

A design document that is not executable is a document that was true once.
