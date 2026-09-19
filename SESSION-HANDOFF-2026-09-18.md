# Session handoff — 2026-09-18

Everything below is **shipped and live** unless a line says otherwise. Read
`README.md` (§ *Importing a list of addresses*) for how the feature works; this
file is only what changed today, why, and what is still open.

Commits: `e7e4f61` … `4ccb987`. All pushed. One session, one feature.

---

## Import list — paste or upload a list of addresses and map it

**Import list…** on both tabs takes a pasted block or a CSV/TSV of civic
addresses, resolves each to an assessment parcel, and maps it. Roll numbers work
in the same list and the two can be mixed.

One `<dialog>` serves both tabs (`#parcel-list-modal`). `open({ mode })` rewrites
the title, help text and confirm button; everything between them is identical.
Only the confirm differs:

- **Property Search** — the resolved rolls go into the hidden `#roll` input a
  typed chip list already writes to, then `runSearch()`. The import is **not a
  mode**: grid, map layers, CSV export and Entry-order numbering all behave as
  they do for a roll list typed by hand. Entry order follows paste order.
- **Sales Analysis** — the list is a comp **selection**, not sale data. It
  narrows the loaded sales pre-join (`salesListFilter`, a roll `Set` matched
  against `s.roll`, which `dedupAndGroupSales` has already zero-padded to 11).
  A pill says how many parcels; its × clears it. **It survives a new CSV load on
  purpose** — the list is the user's comp selection, not a property of the
  source.

### Resolution order, per row

1. **roll** — looked up anyway, so the review shows what that roll IS and a
   typo reads as "not found" rather than silently mapping nothing.
2. **direct** — the roll's own `street_number` / `street_name`. **One query per
   STREET, not per address**, so the usual five-addresses-on-one-street comp
   list costs a single request.
3. **side door** — only for what step 2 missed. `cam2-ii3u` knows addresses the
   assessment roll does not list as a parcel's primary; each leftover becomes a
   point and the containing parcel is the answer. One request per leftover
   address, capped at `SIDE_DOOR_MAX` (60), and the notice says when the cap bit.

**The street match is re-checked client-side.** The SoQL filter is a substring
`LIKE`, deliberately loose so "Selkirk Ave" finds `street_name = SELKIRK`. Loose
means it can also return a street that merely contains the query, so an EXACT
normalized-name match wins outright; substring matches only count when a row has
no exact one, and if those span more than one street name the row is reported
**ambiguous** rather than guessed at.

### Three things that are load-bearing

- **The address column is found, not declared.** No schema to alias onto, so
  every column is scored and the best-parsing one wins. That is also what
  handles the comma inside `330 Selkirk Ave, Winnipeg, MB` — only cell 0 parses,
  so the locality cells drop out as noise. Extra columns are ignored.
- **Nothing is mapped before it is shown.** Resolution always stops at a review
  screen pairing each pasted row with the address the City matched. An address
  list is the kind of input that is quietly wrong, and none of the ways announce
  themselves.
- **`multiple` is normal, not an error.** Condo splits and side doors genuinely
  put several rolls on one civic address; all of them import, and the screen
  says so.

Parsing (`lib/parcelListParse.js`) and resolution (`lib/parcelListResolve.js`)
are pure — the resolver takes its fetchers by injection — so the whole decision
tree is unit tested with no network. 68 tests across the two files.

## Sample CSV

`web/public/sample-parcel-list.csv`, linked from the modal's file picker and
from both sidebars. Nine rows, one per accepted shape: address with the city and
province, one without, one with a postal code, a full 11-digit roll, one with
the leading zero Excel dropped, one with dashes, a side door, and
punctuation-heavy and French street names.

Its `Comp` and `Notes` columns exist **to be ignored** — demonstrating that rule
while letting the file document itself.

Two layers of protection, because they catch different failures:

- `test/parcelListParse.test.js` reads the **real file** (not a copy) and pins
  that every row still PARSES. Offline, runs in `npm test`.
- `npm run check:sample` resolves every row against the **live roll** and fails
  naming any that no longer land. A parcel the City renumbers would leave its
  row parsing perfectly while matching nothing, which no offline test can see.
  `.github/workflows/sample-list-check.yml` runs it monthly (09:00 UTC on the
  1st, plus `workflow_dispatch`). **Deliberately not in `npm test`** — CI fires
  on every push and must never fail because Socrata had a bad minute. Exit 2
  means the API was unreachable; exit 1 means the sample is wrong.

## Recent imports

Last five in `localStorage` (`wpgps_parcel_list_recent_v1`). The **text** is
cached, not just the name: a browser keeps no standing handle to a file picked
from disk, so replaying stored text is the only way an entry can actually
reload. Picking one goes straight to the review screen. Files are labelled with
a date, pastes with their first line plus a timestamp — which is what tells two
same-day pastes of the same list apart, and why `kind` is stored per entry.

## Sidebar layout

- **Export CSV** moved out of the Search / Clear row to full width under
  Generate Map (the Manitoba pattern). It was an OUTPUT action sitting in the
  row that starts a search.
- **Import list + the numbering pill** share a row. `#numbering-row` is still
  ONE element moved between tabs, but `placeNumberingRow` now targets a
  `[data-numbering-slot]` each panel declares rather than guessing at "after the
  first action row" — so Sales keeps it full width while Property pairs it with
  the control that produces a list to number.
- **Sample CSV** sits on its own right-aligned line in both sidebars, not
  inline. Measured inline first on Sales: it squeezed *Paste data…* and *Import
  list…* until both labels wrapped, taking the row 39px → 60px.

### Two CSS traps this hit, both worth remembering

1. **`.sidebar .action-row` sets `flex-wrap: wrap`** and out-specifies a bare
   `.action-row-import` rule. Left alone, the pill drops to a second line — the
   stacked layout the row exists to replace. Every layout rule for that row is
   scoped `.sidebar …` for this reason.
2. **Stretched flex children ate the label's room.** The pill's segments were
   `flex: 1 1 auto` inside a fixed 50% slot, so they expanded to 57/71/70px for
   text needing about a third of that. Sizing them to content freed ~100px —
   more than the label costs. The slot is now `flex: 0 0 auto` and the button
   takes the remainder. *Fixed percentages were the wrong tool here.*

`data-short` + `::after` shortens three labels for the narrow row only
(`Numbering:` → `Number:`, `By roll #` → `Roll #`, `Entry order` → `Entry`),
leaving the real text nodes for the Sales copy and the accessibility tree.
`No.` was tried for the prefix and rejected — beside an **Off** button it reads
as the word "No".

## One latent bug fixed on the way

`rollClause` capped a roll IN-list at 500 and **silently truncated** past it. No
UI could produce such a list before — hand-typed chips never reach 500 — but an
imported list does, and the tail would have vanished while the search still
reported success. `searchAssessmentParcels` now chunks and merges, carrying
every other filter on each chunk. Three tests in `sodaNetwork.test.js` pin it.

---

## Open / unverified

1. **The Sales Analysis filter has never run against real SABRE data.** Only the
   selection path was exercised (resolve → rolls → pill → `runSalesAnalysis`);
   the archive is subscriber data and was not available. The filter itself is a
   one-line roll-set match on `s.roll`, zero-padded on both sides, so it should
   hold — but give it an eye the next time an export is loaded.
2. **Column scoring can pick the wrong column** on a list where the address
   column is mostly unparseable — addresses split across two columns
   (`330` | `Selkirk Ave`) being the realistic case. The review screen makes it
   loud rather than silent (every row comes back "No match"), but nothing
   auto-recovers. A "which column?" override on the review screen is the obvious
   next move if it ever bites.
3. **`5-330 Selkirk` is genuinely ambiguous** — unit 5 of 330, or a range. The
   parser commits to the leading number and shows its reading in the review
   screen rather than guessing silently. Unresolvable from the text alone.
4. **The side-door cap is 60 addresses per run.** Beyond it the remainder are
   reported unmatched with a notice. Only reachable when a large list misses the
   assessment roll wholesale (e.g. a list of Brandon addresses).
5. **CI actions are on deprecated Node 20.** `actions/checkout@v4` /
   `setup-node@v4` are being forced onto Node 24 by the runner, and
   `ubuntu-latest` migrates to Ubuntu 26 on 2026-10-19. Both workflows warn;
   neither fails. Bumping to `@v5` clears it — left alone deliberately, since
   changing action versions on the workflow that gates deploys is its own change.

## Files touched

| Path | What |
|---|---|
| `web/src/lib/parcelListParse.js` | pure parser — column scoring, address/roll classification, header detection |
| `web/src/lib/parcelListResolve.js` | pure resolver — roll / direct / side-door, injected fetchers |
| `web/src/lib/parcelListImport.js` | modal driver — paste → resolving → review, recent imports |
| `web/src/soda.js` | batch street/roll/point fetchers; roll-list chunking in `searchAssessmentParcels` |
| `web/src/main.js` | wiring both tabs, `applyImportedRollList`, sales pre-join filter, `placeNumberingRow` |
| `web/public/sample-parcel-list.csv` | the shipped template |
| `web/scripts/check-sample-list.mjs` | live liveness check |
| `.github/workflows/sample-list-check.yml` | monthly run of the above |


---

# Later the same evening — two follow-ups

## Open item 1 closed: the Sales Analysis list filter against real SABRE data

Run offline through the app's own modules (`parseSalesText` →
`dedupAndGroupSales`) over every `SoldPropertyListing*.csv` in
`WpgOpenData/SABRE`:

| | |
|---|---|
| exports | 53 |
| raw rows | 20,032 |
| sales after dedup | 18,153 |
| raw rows with a 10-digit Parcel ID | 15,078 |
| sales whose `roll` is not 11 digits | 0 |

On the triplex export, a filter set built the way the resolver builds it
(`normalizeRoll` on Socrata's 11-digit `roll_number`) from three parcels whose
CSV ids were 10-digit matched 4 sales; the same three ids left unpadded
matched 0; a set of every roll returned all 38. The one-line `s.roll` match
holds. Nothing changed in code.

## Phone layout, ported from Manitoba (`feat/phone-shell`, not on main)

README § *Phone layout* describes the feature. What matters for the next
session:

- **Source of truth is the MB branches, not MB main.** `feat/phone-shell`
  (f1a0799, 5bc3bc6) and `feat/phone-sheet-drag` (7eeff0c) in
  `MBOpenData/mb-parcelsearch`; MB `main` had no phone files when this was
  written. `phoneMode.js` and `sheetDrag.js` were taken from 7eeff0c and are
  byte-identical here; `test/phoneShell.test.js` diffs them against the MB
  working tree when it is present (skips when it is not, so CI is unaffected).
- **Two Winnipeg-only rules** at the end of `style.css`: From # / To # share
  the row (their 80px slots clipped the placeholder at 16px), and the results
  header + pinned first column drop to z-index 1 so they stack under the tab
  strip (2) as the table scrolls beneath it. Inside the sheet the header is
  not pinned at all — its scroll container is `.table-scroll`, which no longer
  scrolls vertically — so an offset was pointless; the first attempt tried one.
  Scoped with `#results` because the desktop rules are id-scoped.
- **`ensureSheetVisible` keys on `rows !== fullRows`** because Winnipeg's
  `renderTable(rows)` has no `resetPage` option: every re-render passes
  `fullRows` back in, so a fresh array is the only reliable "new result set"
  signal. The zoning-enrichment re-render at the end of a search passes a new
  array too, which lifts a sheet that is already up — harmless.
- **Draw tools and Hide / Expand map are hidden on the phone**, as in MB.
  Sales Analysis on a phone was only looked at, not exercised (the tab
  renders; its charts and the paste modal were not tried at 375px).
- **Verified at 375×812** in the desktop-app browser pane: bar fits, menu
  opens and closes on a pick, handle cycles peek → half → full, a
  300–400 Selkirk search lands 32 parcels in the sheet with the map fitted,
  and at 1024px the results return under the map (673×379, 16:9) with the
  menu button and handle hidden. No console errors either way.
- **Dev server:** port 5173 was held by another chat's server (which was
  actually serving the MB app). `.claude/launch.json` in the WpgOpenData root
  gained `parcelsearch-web-5180`.
- Committed on `feat/phone-shell`, **not pushed** — pushing to main deploys.
