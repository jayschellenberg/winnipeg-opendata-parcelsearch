# Session handoff — 2026-08-05

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
auto-deploys via Vercel.

Working tree is CLEAN and everything below is pushed. HEAD `4d9eccb`
(session started at `e2f6ff4`). The only untracked file is the older
`SESSION-HANDOFF-2026-07-13.md`, which predates this session and was
left alone.

Read this first, then the auto-memory. The 2026-07-13 handoff's "active
resume point" (aerial 2018/2016) is **done** — all five ortho years are
live; nothing there is outstanding.

---

## ⏸ THE ACTIVE RESUME POINT — Manitoba Sales-panel parity

Jason's last request: make the Winnipeg **Sales Analysis** panel match
the Manitoba app's "including the Number Parcels checkbox and all other
features that can be applied."

The "Paste data…" button is **done** (`4d9eccb`). The rest is not
started, and Jason was asked which order he wants — that question is
still open:

> **Start with Number parcels, or sweep the quick filters first?**

MB's sales panel has **29 controls**. Inventory, taken by reading the
live MB deploy's DOM (`manitoba-opendata-parcelsearch.vercel.app`,
Sales tab, `#tab-panel-sales`):

**Directly applicable, absent from Winnipeg**

| MB control | Notes |
|---|---|
| `numbering-toggle` "Number parcels" | The big one — see below |
| date presets (6/12/24/36/48 mo + ×) | Winnipeg has raw from/to date inputs only |
| `sales-price-low` / `-high` | |
| `sales-ppa-low` / `-high` | $/acre in MB; would be **$/sf** in Winnipeg |
| `size-low` / `size-high` | |
| `sales-street-name` | |
| `sale-asmt-max` | Sale/Asmt ratio cap |
| `vacant-improved` + `vacant-threshold` | Vacant vs improved split |
| `sales-clear` | Clear button on the sales tab |
| `legend-toggle` | "Include legend in map image" — pairs with Generate Map |

**Needs a Winnipeg equivalent, not a copy**

- `far-flung-km` + `far-flung-exclude` — Winnipeg already has a subject
  roll and a Dist (km) column, so this is a filter over existing
  machinery rather than new plumbing.
- `zoning-filter` — Winnipeg's zoning vocabulary is its own by-law.

**Does not apply** — `subject-muni`, municipality-ordered numbering, MAO
links.

### Number parcels — what a port involves

MB source: `mb-parcelsearch/web/src/lib/parcelNumbering.js` (148 lines,
pure) + `lib/calloutPlacement.js` (225 lines, pure) + roughly five map
layers in its `map.js` with per-move reprojection and leader-line
de-confliction (search `callout` in that file; the numbering block
starts around line 1888).

Two Winnipeg-specific changes:

1. **Ordering.** MB sorts municipality-code first, then roll as a
   NUMBER. Winnipeg has no municipalities — sort by roll numerically.
2. The number must stay glued to a parcel across re-sorts/filters, so it
   is assigned once per result set, not per render.

A reduced version (stable 1..N + a `#` grid column + plain centred map
labels) is a legitimate first cut; the 225-line leader-line
de-confliction is what makes MB's readable when parcels crowd. Say which
you're building — don't ship the reduced one silently.

---

## Shipped this session (all on `main`, deployed)

Newest first.

| Commit | What |
|---|---|
| `4d9eccb` | Paste-data button matches MB |
| `545a0ba` | Water/Lat/Lon reorder + **Residential** column preset |
| `cfbbfa9` | Condo rows show only the unit address |
| `977fb16` | Full Address stops repeating the same address |
| `e2a529d` | **Map layer setup retries past the 30 s failsafe** |
| `e7a8873` | **Water influence** from the City assessment field |
| `827b028` | Sales filter by **assessment class** |
| `2e086cb` | **Results-grid column alignment fix** + Cluster column |
| `6b041d6` | Historical overlay group collapsed by default |
| `6f302cc` | Test locking the 185 Bannerman land-repetition trap |
| `28f293f` | Report sales rows dropped for a missing Instrument Number |
| `04c0d57` | **Paste SABRE sales data** on the Sales tab |
| `81539f7` | **Area-selection shape tools** (radius/rectangle/polygon) |

### New modules

`web/src/lib/` — `shapeFilter.js`, `delimitedRows.js`, `salesImport.js`,
`salesPasteImport.js`, `clusters.js`, `multiSelectFilter.js`,
`water.js`, `addressFormat.js`; plus `web/src/drawShapes.js`.
Tests for each in `web/test/`, all wired into `npm test`
(now 7 files beyond the original suite). `npm run lint` is clean.

---

## Decisions that will silently regress if you don't know them

1. **Water influence needs NO detection pipeline.** The MB port guide
   (`mb-parcelsearch/docs/WINNIPEG-PORT-WATER-AND-SHAPES.md` Part A) says
   to port a ~500-line R classifier. **Don't.** d4mq-wa44's
   `property_influences` already carries the City assessors' verdicts —
   16 water tokens over 8 bodies, 7,520 of 245,248 parcels.
   ADJACENT = frontage, INFLUENCE = near-water-without-frontage, which
   is exactly MB's split. Lyndale Drive proves it: 26 ADJACENT (river
   side) vs ~70 INFLUENCE (across the road). Full reasoning and the
   source's limits are at the top of `web/src/lib/water.js`.
2. **Water filters must match the FULL token.** `property_influences`
   also contains `COMMERCIAL ADJACENT` / `COMMERCIAL INFLUENCE`; a
   `like '%ADJACENT%'` sweeps every commercial parcel into a waterfront
   search. The filter and the column parse from one token list so they
   can't disagree.
3. **`_waterLoaded` is load-bearing.** Socrata OMITS null fields, so a
   parcel with no influences is indistinguishable from a query that
   never asked. The stamp is what makes "checked, none" sayable.
4. **`columnCellClasses()` must feed BOTH `<th>` and `<td>`.** The
   `.sales-only` / `.subj-col` rules are `display:none`; applying them to
   one side only makes every later column render one place off its
   heading. That shipped — with a sales CSV loaded and no subject roll,
   Instrument appeared under Lot.
5. **One `ASSESS_SELECT` constant.** It was duplicated between the
   attribute search and the address cross-reference fetch and had
   already drifted (`property_class_1` in one only). Any new field must
   go in the shared constant or it will be missing on an arbitrary
   subset of rows.
6. **Instrument Number defines a sale.** Two parcels share one sale iff
   they share an instrument — NOT date+price (the sample has two
   parcels sold the same day for the same price under different
   instruments). Same roll + same instrument = component rows of ONE
   parcel; their repeated `Land Actual sqft` must be counted once or
   $/sf is out by the component count (185 Bannerman: $224/sf vs $37).
7. **Sworn Value is never substituted into Sale Price.** SABRE writes a
   nominal $1 on non-arms-length transfers with the real figure in
   Sworn Value. Folding them would launder a non-market transfer into a
   comp set.
8. **Cluster is geometric, not name-matched.** `neighbourhood_area` is
   truncated to 20 chars (`LEILA-MCPHILLIPS TRI`); a name join reached
   only 94.6%. Point-in-polygon against the committed
   `wpg-neighbourhoods.geojson` has none of that fragility.
9. **Shape filters narrow, they never re-query.** `renderTable` is the
   single funnel so a late enrichment re-render stays narrowed. Shape
   changes deliberately do NOT re-fit the map.
10. **Sales dates are normalized to ISO on import.** SABRE emits
    `MM-DD-YYYY`; the date filter compares strings against an ISO
    `<input type="date">`, so unconverted dates made every pasted row
    vanish once a bound was set.

---

## Environment gotchas that cost real time

- **The in-app Browser pane cannot render this map.** MapLibre's style
  never finishes there (the `pmtiles://` ortho sources on R2 don't
  resolve), so `isStyleLoaded()` stays false, `setupLayers` never runs,
  and no map layer exists. The pane is still fine for the DOM, the
  table, and live SODA queries. **For anything visual, use Claude in
  Chrome** (`mcp__claude-in-chrome__*`) against the deploy — that's how
  the water overlay was verified and how the startup bug below was
  caught.
- `getBoundingClientRect()` still reports a box for
  `content-visibility`-skipped content, and `requestAnimationFrame`
  never fires while the pane is hidden — both produced misleading
  readings when checking the collapsed Historical group. Measure the
  `<details>` element's own height instead.
- Vercel occasionally returns a transient 500 on push; a second `git
  push` succeeded.
- Bash here is Git Bash — PowerShell here-strings (`@'…'@`) fail. Use a
  heredoc, and `git commit -F -` for multi-line messages.

---

## Bugs found and fixed that were NOT part of the ask

Worth knowing because they were pre-existing and intermittent:

- **Map layer setup could fail permanently on a cold load** (`e2a529d`).
  The 30 s failsafe cleared its poll and then forced a `runSetup()` that
  throws while the style is still resolving — leaving the map with its 9
  base layers and nothing else: no parcel fill, no zoning, no overlays.
  The results table still populated, so it looked like "the map just
  doesn't highlight anything". Five ortho pmtiles archives each need an
  R2 header fetch, which can exceed 30 s. The poll now runs until setup
  succeeds, with a 5-minute hard stop.
- **Results-grid columns rendered one place off their headings**
  (`2e086cb`) — see decision 4.
- **`property_class_1` was missing on address-cross-referenced parcels**
  (`e7a8873`) — see decision 5.
- **`repeatSales` subtracted a pre-filter count** and could go negative
  once the class filter narrowed the set (`827b028`).

---

## Open / parked

- **Sales-panel parity** — the active resume point above.
- **Truro Creek** is flagged on zero parcels in `property_influences`
  though the City's own By-law 5888/92 corridors cover it. No measured
  distance exists behind any water verdict either — MB ships
  `WaterDistanceFt` precisely as the safety valve for a wrong threshold.
  If either matters, geometric detection becomes worth adding *on top
  of* the field, not instead of it.
- **Sales-mode zoning is deferred** — Zoning % and Zoning 2 stay blank
  until the Zoning overlay is switched on, so a multi-parcel CSV doesn't
  block on enrichment. Jason was offered eager enrichment and hasn't
  said.
- **Condo unit rows** show only the unit address now; the building
  address is suppressed when a unit address is present.
- Older parked items remain in auto-memory `wpg-open-todos`.

## Working style (Jason)

Direct/technical, no preamble. Commit + push when he says (main =
deploy). Concrete numbers over hand-waving; verify by execution against
real data, not fixtures. He will interrupt mid-task to redirect —
finish the in-flight piece, then take the new one.
