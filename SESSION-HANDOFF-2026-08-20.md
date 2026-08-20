# Session handoff — 2026-08-20 (third session)

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
deploys. Replaces the earlier 2026-08-20 handoff (`3d03510`), whose
still-live constraints are carried forward below.

Seven commits landed and deployed here, `ee34869` → `f05769a`, clearing
**all four** items that handoff left queued. The last of them, the N1
cross-reference, was cleared mostly in the SIBLING repo
`MBOpenData/mao-scrape` (four commits there, `3734c3e` → `b4fec87`) —
only one line of that work is in this repo.

---

## ⏸ THE ACTIVE RESUME POINT

Nothing is in flight and the tree is clean. Of the four queued items:

1. **Street-name autocomplete** — done (`ee34869`, `cb0653b`).
2. **Zoning on the CLICK popup** — done (`25aa926`), with a delayed
   half. The use-code line is live now. The ZONE line is written but
   silently absent until the tiles carry the field, which happens by
   itself at the next scheduled rebuild — `WpgParcelTilesBiMonthly`,
   **2026-10-02**, which auto-deploys. **Confirm it after that date**;
   until then its absence is expected, not a bug.
3. **The N1 cross-reference** — **BUILT AND RUNNING**, and the two
   previous handoffs were wrong to call it blocked. It lives in the
   OTHER repo, `D:\Dropbox\ClaudeCode\MBOpenData\mao-scrape`, because
   that is where the N1 exports and the review page already are. Run
   `n1-refresh-wpg.bat`. See "The Winnipeg N1 crosswalk" below and
   `DESIGN-N1-WPG.md` over there.
4. **The 792 unjudged vacant sales** — done (`c79a65c`), and mostly
   dissolved rather than fixed. See below.

One thing is genuinely waiting on Jason:

- **The 160-record Winnipeg N1 review queue.** Run
  `n1-refresh-wpg.bat`, then point `tools/n1_review.html` at
  `mao-scrape/results/sales_search/n1_review_wpg/`. The loop is proven
  end to end on one record.

Beyond that nothing is queued. Candidates, none of them asked for:

- The **79** vacant sales with no live roll record — the residue of item
  4, and the only part still genuinely unjudged.
- The **pre-war teardown question** (`c79a65c`'s KNOWN TRADEOFF). A
  $52,500 sale with an 1891 house may be a genuine land sale. Jason
  chose the conservative Land set over my recommendation to flag rather
  than reclassify. Worth revisiting with his eye, deliberately.
- Taxonomy still arguable: REFRL / PERP / STATU in Infrastructure,
  RESOT, INWSC, CMPST, RESAM vs RESMU.

---

## What the numbers do now

| | before this session | now |
|---|---:|---:|
| searching "PARK EAST" | 2,686 parcels, 47 streets | **237, one street** |
| searching "ELM PARK" | 1,260 across 17 | **105, one street** |
| vacant sales with no permit verdict | 812, all suspect | **79 unanswerable** |
| Land category | 6,673 | **6,636** |
| median $/Lot SF (Land) | $29.98 | **$29.94** |
| sales carrying an `N1 ID` | 0 of 18,490 | **1,333 of 18,923** |
| Winnipeg comps SABRE never had | invisible | **433 in the grid** |

**Do not compare the Land row against the previous handoff's 6,736.**
That figure came off the live roll and a smaller archive; 6,673 is the
same code replayed today against the March parquet with the Aug 20 CSVs
included. The 37-row delta is the comparable number, not the totals.

---

## What shipped

**Street-name typeahead** (`src/lib/streetSuggest.js`, new). Two
characters open a ranked list of up to 8 streets with their type(s) and
parcel count; Enter takes the highlighted one and searches in one
keystroke. Vocabulary is one grouped query against d4mq-wa44 — 4,374
rows for 4,238 distinct names, 258 KB in 380 ms — fetched on first focus
and cached in localStorage for a month.

**A truncation defect it exposed.** 50 street names END in a word
`normalizeStreetQuery` read as a type or direction, and it was cutting
them. See the decisions list.

**Use code + zone on the citywide click popup** (`map.js`
`citywideParcelHtml`). Same pair, same order as the hover popup.

**The roll as a second instrument** (`permitEvidence.js`
`rollBuildVerdict`). Where no permit can answer, the roll's own
`year_built` can.

**A Source that survives import** (`salesDbMerge.js`, `f05769a`). The
merge blanket-assigned `Source: 'SABRE'` to every row of every non-MLS
file. Right for the City's exports, which carry no Source column; wrong
for the 433 N1-sourced sales that arrive in the same schema marked
`Source=N1`. Now `r.Source || 'SABRE'`. **This is the only change in
THIS repo that the N1 work required** — everything else lives in
mao-scrape.

---

## Decisions that will silently regress if you don't know them

Carrying forward every earlier list — never `gh release upload
--clobber`; revert the checksum only if the archive is not live; decide
from a re-read not an exit code; "unknown" is a third outcome; every
`CN*`/`RES*` code must be classified; `generated_at` means when the DATA
changed; `.ps1` files stay 7-bit ASCII; the two sources date the same
sale differently; `rowSignature` must normalize the date cell; the
$/Bldg SF live fallback is withheld on vacant-coded sales; far-flung
fails OPEN; **the Sale/Asmt cap is gone and must not come back**; the
`$/Lot SF` RANGE filter stays removed; vacancy is the V prefix plus
`CNVAC`; `mergeSalesFiles` must not throw on a bad header; subscriber
data never leaves the browser; living area sums the DISTINCT areas; unit
counts COUNT the labels; SABRE's land area leads and the assessment
record is the fallback, and NOT SABRE's `Land Assessed sqft`; group
properties are measured over the WHOLE transaction; a permit-fetch
failure must be SAID; `UNCLASSIFIED_CATEGORY` is never blank; the
category judgement calls are Jason's; the draw cap caps DRAWING only;
`createMultiSelectFilter` takes an optional `order`. All still true. New:

1. **`normalizeStreetQuery`'s known-name guard NARROWS, and every other
   rule in that function widens.** 50 street names end in a type or
   direction word — ELM PARK, GOLDEN GATE, MIDDLE GATE, NORTH POINT,
   LINDEN TERRACE, PARK EAST, WILDWOOD E. The guard keeps the trailing
   token when the whole string is a name the roll carries. Measured over
   all 4,238 names, exactly 50 queries change and **ZERO single-word
   queries do** — typing "Elm" still means `like '%ELM%'`, still returns
   1,260 parcels across 17 streets, ELM PARK's 105 among them. Only
   typing both words narrows it. The guard defaults to whatever
   `fetchStreetNames` has loaded, so before the list arrives — and in
   node — behaviour is the old, wider one. Fails open.
2. **The suggestion list comes from the ASSESSMENT roll, not Civic
   Addresses.** cam2-ii3u carries MORE names, 4,331 against 4,238, but
   115 of the extras (ADMIRAL, BEHNKE, GYPSUM, COMMERCE, MAHATMA
   GANDHI) have civic addresses with no assessment parcel under them.
   Spot-checked with `within_circle(geometry,...)`: the nearest parcel
   to those points is on a DIFFERENT street, so the cam2 cross-reference
   path finds nothing either. Sourcing there offers 115 dead streets.
3. **The suggestion key folds hyphens; the CLAUSE does not.** Five names
   carry hyphens (EAU-CLAIRE, JEAN-BAPTISTE LAVOIE, PHIL-CHRIS,
   TARA-LEE, TU-PELO). Widening only the suggestion side is safe —
   accepting one inserts the roll's own spelling.
4. **`#address-street` is NOT in main.js's generic Enter-runs-the-search
   loop.** The typeahead owns Enter, because accepting has to finish
   before the search reads the field. Two listeners on one element fire
   in registration order and would search the half-typed text.
5. **The suggestion listbox is a SIBLING of the three address fields,
   not a child of the Street Name one.** That field is 120px of a 292px
   row and the list inherited it: "ELM" got 17px of the 27 it needs, so
   the street NAMES ellipsised. The hint carries `flex-shrink: 100`
   against the name's `1` so a squeezed row eats the parcel count first.
6. **`zoning` is back in the tile `select_cols`; `total_assessed_value`
   stays out.** They are not comparable costs: 53 distinct values against
   6,202. Zoning adds ~0.22 MB scaled (up to ~1.3 MB across six zoom
   levels) on a 95.87 MB archive.
7. **The 100 MB cap does not apply to `parcels.pmtiles`.** That is
   GitHub's limit for files committed to a REPOSITORY. This archive is
   deliberately not in git — `fetch-pmtiles.mjs` says so and pulls it
   from a rolling RELEASE asset, and those cap at 2 GB. The old comment
   in `build_parcel_tiles.R` was wrong and is corrected in place.
8. **`rollBuildVerdict` requires a LIVING AREA, not just a year.** The
   roll zeroes living area when a building comes down but keeps the year
   — 185 BANNERMAN sold six suites in 2022 and reads 0 today. Judging on
   the year alone calls a genuine bare-lot sale improved.
9. **It also requires a LIVE RECORD.** Absence of a roll row is not
   evidence of bareness. Those 79 stay unjudged.
10. **A permit ALWAYS wins over the roll**, including `land-then-built`
    — that is a permit positively stating the lot was bare. A permit is
    dated evidence about the transaction; the roll is a later snapshot
    read backwards.
11. **The roll pass sits OUTSIDE the permit try/catch.** It needs no
    network, so a Socrata outage that costs the permits must not also
    cost this. The PERMIT CHECK FAILED warning is reworded, not dropped:
    the roll accounts for 37 of 6,275 already-built findings.
12. **The count line and the tooltip name the INSTRUMENT.** "37 from the
    roll's year built, not a permit — confirm before using". A reader
    must not come away thinking a permit was found.
13. **`mergeSalesFiles` must NOT overwrite a Source it was given.**
    `r.Source || 'SABRE'`, never a blanket assignment. A file can arrive
    in the SABRE schema and not be from SABRE — 433 of them do, the
    Winnipeg comps the City's export missed. Overwriting the marker made
    a record the City never published read as one it did, which is the
    single thing that column exists to prevent.
14. **A sparse row is safe in the sale aggregates, and it is safe BY
    CONSTRUCTION.** `distinctLivingArea` only counts areas `> 0` and
    `unitLabelsOf` only counts non-empty labels. That is what lets an
    N1-sourced sale carry nothing but roll, instrument, date and price
    without polluting a group's living area or unit count. Do not
    "tidy" either function into counting blanks.
15. **An N1-sourced sale carries a BLANK use code, deliberately.** N1's
    Property Type is not the City's use code. Mapping one to the other
    would put a fabricated code into the field that drives the Land set;
    blank lands the sale in "(unclassified)", which is visible and
    filterable. Same principle as `UNCLASSIFIED_CATEGORY` never being
    blank: say "we were not told", never guess.

---

## The Winnipeg N1 crosswalk — BUILT 2026-08-20

**It lives in the OTHER repo**, `D:\Dropbox\ClaudeCode\MBOpenData\mao-scrape`,
because that is where the N1 exports, the review page and the MB crosswalk
already are. Nothing about it is in THIS repo except one line in
`salesDbMerge.js`. Its own design record is `DESIGN-N1-WPG.md` over there;
this section is the pointer plus what a Winnipeg reader needs.

**Run it:** `n1-refresh-wpg.bat` (double-click), or
`Rscript scripts/n1_refresh_wpg.R [--no-sabre] [--no-open]`. One run
re-exports SABRE, ingests any review decisions, re-matches, writes the
stamped sales file, and says what is left.

**Then point the app at
`mao-scrape/results/sales_search/wpg_stamped/` — THAT FOLDER ONLY.**
Connecting it beside the raw SABRE folder imports every sale twice,
because the stamped file already contains all of them.

**The model is unchanged: the web app never matches.** It consumes an
`N1 ID` column and shows an Any/Matched/Unmatched filter (`?n1=`).
Blank = "needs entering into N1".

### Where it stands

| | |
|---|---:|
| Winnipeg N1 records | 1,572 |
| auto-linked | **874** → 899 crosswalk rows |
| accepted through the review page | 1 |
| still queued for review | **160** (2020–2024) |
| unmatched | 538 |
| **sales the app now sees** | **18,923** |
| of those, carrying an `N1 ID` | **1,333** |
| of those, N1 sales SABRE never had | **433** |

84.5% of the records with any candidate auto-link — the same band as the
MB crosswalk's 85.8%, by a much simpler route.

### Winnipeg is the EASY case

MB needs fuzzy address/legal matching and county aliasing because MAO's
rolls do not line up with N1's. Here both sides speak the same
identifier: N1 `Tax ID` → SABRE `Parcel ID` → d4mq-wa44 `roll_number`.
The matcher is a roll join with corroboration; none of MB's fuzzy half
was ported.

MB skips Winnipeg deliberately — `config/n1_muni_aliases.csv` maps
`Winnipeg (City)` to `unresolved` because MAO does not assess the City —
which is exactly what leaves those records available here.

### The two things a Winnipeg reader must know

**1. Not every N1 record is a sale.** 1,420 Closed Sale, **141 Listing**,
8 Pending Contract, 3 Un-Executed. A Listing is an asking price; Jason
converts it to a sale later by adding closing details from MLS/SABRE,
editing the record IN PLACE under the same `n1_id`. So only a Closed Sale
may auto-link, and a binding RE-OPENS when the record's type or price
moves. Without that, a binding made from an asking price would stand
forever.

**2. SABRE has been missing sales for five years.** 410 N1 records carry
a roll the SABRE archive has never held, and they are not noise: median
price **$1,122,500**, spread evenly over 2020–2024, led by Multi-Family
(60), Commercial (32), Industrial (26), Office (26), Warehouse (17).
Only ~60 look like the residential SABRE deliberately excludes. They
cannot be stamped — there is no row to stamp — so 433 of them are
EMITTED as sales, with a synthetic `N1-<id>` instrument, `Source=N1`,
and a **blank use code** (guessing one would put a fabricated value into
the field that drives the Land set; blank lands them in
"(unclassified)", which is visible).

### Traps, each paid for once

- **Zero-pad both sides to 11 digits, and do it correctly.** 23 records
  bind ONLY because of the padding. The first implementation used
  `formatC(width = 11, flag = "0")`, which pads CHARACTER input with
  **spaces** — both sides padded identically so most of the join still
  worked, and only the records the padding existed for quietly failed
  and reported as Unmatched, which reads as "still to be entered into
  N1". `nzchar(NA)` is also TRUE, so an NA roll padded its way to the
  literal string `"000000000NA"`.
- **N1 dates come out of the xlsx as EXCEL SERIALS** (`43847`), not ISO.
  Epoch 1899-12-30. A naive `fromisoformat` corroborates nothing and
  reads as a clean "no date match".
- **Use `Price`, not `Actual Price`** — the latter is populated on 17 of
  1,592.
- **Exclude WINNIPEG BEACH**: a different municipality MAO *does*
  assess. 20 records; a bare substring test claims all of them.
- **`I()` around single-element arrays in the review JSON.**
  `tools/n1_review.html` calls `.join()` on `n1.rolls` and reads
  `.length` for its badge; `auto_unbox` collapses a length-1 vector to a
  bare string and the record throws on render instead of appearing.
- **One stamped file, not 53 stamped exports.** `mergeSalesFiles` dedupes
  on the parsed row's KEY SET, and `objectsFromRows` only creates a key
  for a column present in that file's header — so a folder mixing
  stamped and unstamped files stops deduping overlapping pulls entirely.
- **N1 sunsets 2027-09-01** and has no API. Exports cap near 1,500
  records per pull, so the archive under `mao-scrape/n1/` is the only
  thing making any of this date-independent.
- The MB side also found an **import bleed** (N1 IDs 19095–19323, each
  record's Tax ID carrying the NEXT record's rolls) and **176 duplicate
  groups**. Both are N1-side data defects; both land here too and
  neither is corrected on this side.

---

## Deliberate divergences from the Manitoba sibling app

Unchanged: no `vacant-threshold`; the Sale/Asmt cap is gone entirely;
far-flung ships with **no default threshold**; the charts are
Winnipeg-specific LAND charts; the appraisal-category layer
(`lib/pucs.js`) has no MB counterpart. New: the street-name typeahead
and the `rollBuildVerdict` fallback are Winnipeg-only, and the N1
crosswalk binds to SABRE rather than MAO — a roll join instead of MB's
fuzzy address/legal match, because City rolls line up on both sides and
MAO's do not.

---

## Known gaps

- **79 vacant-coded sales have no live roll record**, so neither a
  permit nor the roll can judge them. The only genuinely unjudged
  residue, down from the 792 the last handoff named. The other 733
  resolved: 641 confirmed bare, 55 land-then-built, 37 reclassified.
- **The 37 reclassified rows are two populations wearing one label.**
  Recent builds sold at full price (28 WATERSTONE DR, $1,525,000, 2,871
  sf, built 2014) and pre-war houses sold cheap (570 BALMORAL, $52,500,
  built 1891). The second group may be genuine teardown land sales. See
  the resume point.
- **The zone line on the click popup is inert until 2026-10-02.**
- **The stamped sales file is DERIVED and nothing keeps it fresh.** A
  new SABRE download does not update
  `mao-scrape/results/sales_search/wpg_stamped/wpg-sales-with-n1.csv`;
  only `n1-refresh-wpg.bat` does. If the app is pointed at that folder
  and the refresh is not re-run, the comp set silently ages. This is the
  failure that bites in six months rather than today.
- **An N1-sourced sale will not FUSE with a SABRE row for the same
  sale.** `collapseCrossSource` picks its two buckets by name
  (`r.Source === 'MLS' ? mls : sabre`), so an `N1` row falls in with
  SABRE and is never fused. By construction it cannot collide at emit
  time — only records with no SABRE roll match are written — and the
  next crosswalk run drops them once SABRE has them. The exposure is one
  run, between a SABRE download and the next refresh. Generalising
  `collapseCrossSource` to any non-SABRE source would close it.
- **160 Winnipeg N1 records await review**, and 538 are unmatched: 410
  whose roll the SABRE archive never held, 73 with no Tax ID, 55 whose
  roll matched but with no sale within 400 days. The 410 are mostly NOT
  errors, but ~350 of them are real comps now carried as N1-sourced
  sales.
- **1,562 of the already-built rows took the code's FALLBACK**, not a
  live-roll lookup, because the roll was missing or still reads vacant.
- **296 sale rows have no usable street number + name.** Less damaging
  than feared: of the 292 that are vacant-coded, 228 read bare on the
  roll, 15 are land-then-built, 49 have no record, and **zero** are
  contradicted.
- **Three definitions of "land" are only PARTLY reconciled.**
  `buildVerdict` still gates on `isVacantUseCode`, so a CMPSP
  surface-parking sale can never receive an already-built verdict even
  though the category calls it Land. 17 sales.
- Carried forward: 142 Winnipeg commercial MLS sales with no usable
  LINC; ~135 same-roll near-date MLS/SABRE pairs left unfused by design;
  August 2026 is partial (SABRE recording lag); historical shards still
  pin `eca2c00`; the Generate-Map-PNG legend and the
  `showDirectoryPicker` folder-connect path still need Jason's real
  browser.

---

## Verifying offline (this is how every number above was produced)

The `lib/` modules are pure and import straight into plain node. On
Windows node an absolute path needs a `file:///` URL.

**The full sales replay**, which the last handoff described but did not
spell out. The missing piece was `liveByRoll`:

```
SABRE CSVs  ->  D:\Dropbox\ClaudeCode\WpgOpenData\SABRE\*.csv  (53 files)
  mergeSalesFiles([{name, csv}])        salesDbMerge.js  -> { text }
  parseSalesText(text)                  salesImport.js   -> { rows }
  dedupAndGroupSales(rows)              sales.js         -> { sales, groups }
  sales.filter(s => s.salePrice > 1)    the app's DEFAULT (hide-sentinels)
  buildSaleFeatures(visible, liveByRoll, groups)
  buildPermitIndex / findNearestPermit / buildVerdict / rollBuildVerdict
  saleCategory                          pucs.js
```

`liveByRoll` is a `Map<roll11, Feature>`. Build it from the local parquet
(`../AssessmentParcels/data/assessment-parcels-2026-03-10.parquet`,
245,136 rolls) with python + pyarrow, keyed on the roll ZERO-PADDED TO
11 DIGITS, each value `{type:'Feature', geometry:null, properties:{...}}`.
`year_built` and `total_living_area` on the sale feature are the LIVE
roll's, untouched by the SABRE living-area correction — that goes into a
local `bldgSf` and out as `_pricePerBldgSf`.

Expected shape today: 20,342 rows kept → 18,490 sales → 16,635 after the
sentinel filter → 12,894 vacant-coded.

Permits come from `it4w-cpf4` — copy the exact `$select`/`$where` out of
`src/soda.js`, including the 3-year window for construction against the
2-year default for demolition.

**Reading the pmtiles' own field list** (PMTiles v3, little-endian):
metadata offset at byte 24, length at 32, internal compression at 97,
min/max zoom at 100/101. Gunzip and read `vector_layers[].fields`. That
is how "the tiles already carry `property_use_code`" was established
rather than inferred from the build script.

---

## Environment gotchas that cost real time

Carried forward and still true: the in-app Browser pane cannot render
this map (use Claude in Chrome); Bash here is Git Bash, so PowerShell
here-strings fail — use a heredoc and `git commit -F -`; run `.ps1` by
ABSOLUTE path; `r2.dev` does not answer HEAD usefully; building JS
through a heredoc mangles escapes; a large heredoc silently breaks, so
use the Write tool for anything substantial; the MAAP PUCS PDF is a
scanned fax with no text layer.

**Corrected:** `index.html` is **LF throughout** now, not CRLF. The old
"normalize, edit and restore or every multi-line anchor misses" warning
no longer applies — the Edit tool matches it directly. New:

- **The launch config lives at the PROJECT ROOT, not beside the app.**
  `D:\Dropbox\ClaudeCode\WpgOpenData\.claude\launch.json` — one level
  above this repo, alongside the other WpgOpenData projects. Its
  `parcelsearch-web` entry already runs the dev server with
  `--prefix ParcelSearch/web` on 5173.

  Most of this session was spent believing the harness cached a stale
  config, because edits to `ParcelSearch/.claude/launch.json` had no
  effect and it kept insisting on 5173. That file is not read. **There
  was no local dev server for almost the whole session** as a result,
  and everything visual was verified against the DEPLOYED site instead —
  which works, but only after a push, and it is how the 120px dropdown
  bug was found, so it is not a bad fallback. Port 5173 is also the
  Manitoba sibling's and 5174 a third project's, so a second entry on a
  free port is the way to preview anything else; that is verified —
  `n1-review` on 5199 served the mao-scrape review page fine.
- **Polling a Vercel deploy: grep the BUNDLE HASH, not a code string.**
  Grepping for `property_use_code` reported "deployed" against the OLD
  bundle, because the hover popup had always contained it. `ls
  web/dist/assets/main-*.js` after a local build gives the hash to wait
  for; it can only appear once Vercel builds that commit. Deploys took
  15-30s all session.
- **The Dropbox lock hits `npm run build`**, not just git. It fails in
  `prepareOutDir` and succeeds on an immediate retry. Same class as the
  fetch/push flakiness.
- **A local HTML tool needs a SERVER, not `file://`.** Chrome will not
  grant `showDirectoryPicker` outside a secure context, the in-app
  Browser pane renders a `file://` page as a static snapshot with scripts
  off, and `navigate` mangles a `file:///D:/...` URL into
  `https://file///D:/...`. The way that worked: add an entry to the
  project-root `launch.json` running a ~20-line static server, start it
  with `preview_start`, and load `http://localhost:<port>/...` in Claude
  in Chrome. `isSecureContext` true, folder picker available, the page's
  own file input drivable with `file_upload`. That is how the mao-scrape
  N1 review page was proven.
- **The Bash tool's working directory resets between calls.** `cd` into
  the repo at the start of every command or `git` reports "not a git
  repository" and relative paths miss.

---

## Working style (Jason)

Direct/technical, no preamble. **Commit when he says; push is a separate
instruction** and push = deploy. He gives one instruction at a time —
"commit this", then "push it" — so do not batch them or assume the next.
Concrete numbers over hand-waving; verify by execution against real
data, not fixtures. He is an appraiser: when a result is ambiguous the
question he wants answered is "what should I do with this row", not
"what does this field contain".

**He will tell you to do something the data says is wrong.** The right
move is to measure it, show him the table, and recommend — then do what
he says. This session he was offered four treatments for the 37
roll-contradicted sales and took the one I argued against, reclassifying
all of them rather than flagging. That is a legitimate methodology
choice (a land comp set should hold only sales you are confident bought
bare dirt) and it is recorded as a deliberate tradeoff in `c79a65c`, not
as a bug. Measure, say so plainly once, then build what he asked for.
