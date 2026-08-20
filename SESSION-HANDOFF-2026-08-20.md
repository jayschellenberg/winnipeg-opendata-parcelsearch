# Session handoff — 2026-08-20 (third session)

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
deploys. Replaces the earlier 2026-08-20 handoff (`3d03510`), whose
still-live constraints are carried forward below.

Four commits landed and deployed this session, `ee34869` → `c79a65c`,
clearing three of the four items that handoff left queued.

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
3. **The N1 cross-reference** — NOT blocked after all, and the previous
   handoff was wrong to call it that. Scoped at the end of this session
   and ready to build; see "The Winnipeg N1 crosswalk" below. Still true
   that no sales CSV carries an `N1 ID` yet — 0 of 18,490 — because the
   offline crosswalk that would stamp it does not exist for Winnipeg.
   What was missing was not data but the knowledge that the MB
   implementation deliberately skips Winnipeg.
4. **The 792 unjudged vacant sales** — done (`c79a65c`), and mostly
   dissolved rather than fixed. See below.

Nothing new is queued. Candidates, none of them asked for:

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

---

## The Winnipeg N1 crosswalk (scoped 2026-08-20, not built)

**The model is unchanged: the web app never matches.** It consumes an
`N1 ID` column pre-stamped into the sales CSVs by an OFFLINE crosswalk,
and shows an Any/Matched/Unmatched filter (`?n1=`). Blank = "needs
entering into N1".

**The Manitoba one lives in `D:\Dropbox\ClaudeCode\MBOpenData\mao-scrape`**
and is initiated by double-clicking `n1-refresh.bat` (or `Rscript
scripts/n1_refresh.R [--no-export] [--no-open]`). One run ingests any
review decisions, matches every chunk-year in the newest `n1/` export,
refreshes the web export, and opens the review page if a human is still
needed. `DESIGN-N1-CROSSWALK.md` is its 756-line design record.

**It skips Winnipeg on purpose.** `config/n1_muni_aliases.csv` maps
`Winnipeg (City)` to `unresolved`, and `scripts/n1_county_fix.R:169`
gives the reason: MAO does not assess the City, so a Winnipeg N1 record
has no MAO sale to bind to. The design doc counts them among the
"correctly out of scope" 1,482. They pass through the export untouched,
which is exactly what makes them available here.

**Measured against the current export**
(`mao-scrape/n1/2020-202608-20260818.xlsx`, first sheet, 1,842 columns)
and the SABRE archive, 2026-08-20:

| | |
|---|---:|
| Winnipeg-flagged N1 records | **1,592** |
| carrying a `Tax ID` | 1,518 |
| carrying a price / a date | 1,585 / 1,592 |
| packed multi-roll `Tax ID`s | 69 |
| **bind to a SABRE roll (zero-padded)** | **1,089 (68.4%)** |
| of those: same roll + exact price + date within 90d | **916 (84%)** |
| bind ONLY because of zero-padding | **24** |

Median date gap on same-price pairs is **0 days**; 770 of 978 are within
a week. That auto-link rate is in the same band as the MB crosswalk's
85.8%.

**Winnipeg is the EASY case, not the hard one.** MB needed fuzzy
address/legal matching, county aliasing and price/date windows because
MAO rolls did not line up. Here it is a roll join: N1 `Tax ID` → SABRE
`Parcel ID` → d4mq-wa44 `roll_number`. The MB matcher's hard half is not
needed; what IS worth lifting from `scripts/n1_lib.R` is the field
mapping (`ID`, `Address`, `City`, `County`, `Legal Description`, `Tax
ID`, `Price`, `Date`, `Recording Date` — note **`Price`, not `Actual
Price`**, which is populated on only 17 of the 1,592), the Tax ID
splitter (N1 packs with `& ; , /`), and `n1_as_date`.

Traps, each already paid for once:

- **Dates come out of the xlsx as EXCEL SERIALS** (`43847`), not ISO.
  Epoch 1899-12-30. A naive `fromisoformat` silently corroborates
  nothing and reads as "no sale matches on date".
- **Zero-pad both sides to 11 digits.** 24 records bind only because of
  it, and an unpadded compare reports them Unmatched — which reads as
  "still to be entered into N1" rather than "we failed to match". The
  failure is invisible either way; the queue just looks longer.
- **The 503 that do not bind are mostly not errors.** The SABRE archive
  is non-residential/land only (single-family and residential condos are
  deliberately excluded) and starts Jan 2020, so an N1 comp outside that
  scope has nothing to bind to. 74 have no Tax ID at all.
- **N1 sunsets 2027-09-01** and has no API. Exports cap near 1,500
  records per pull, so the archive under `mao-scrape/n1/` is the only
  thing making any of this date-independent.
- The MB side also found an **import bleed** (N1 IDs 19095–19323, each
  record's Tax ID carrying the NEXT record's rolls) and **176 duplicate
  groups**. Both are N1-side data defects, both would land here too.

---

## Deliberate divergences from the Manitoba sibling app

Unchanged: no `vacant-threshold`; the Sale/Asmt cap is gone entirely;
far-flung ships with **no default threshold**; the charts are
Winnipeg-specific LAND charts; the appraisal-category layer
(`lib/pucs.js`) has no MB counterpart. New: the street-name typeahead
and the `rollBuildVerdict` fallback are Winnipeg-only.

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

- **The preview harness caches its launch config at session start.** It
  never re-read `.claude/launch.json` no matter what was written there,
  and kept insisting on port 5173. **There was no local dev server this
  whole session.** Port 5173 is the Manitoba sibling; 5174 is a third
  project. Everything visual was verified against the DEPLOYED site
  instead, which works but only after a push — and it is how the 120px
  dropdown bug was found, so it is not a bad fallback.
- **Polling a Vercel deploy: grep the BUNDLE HASH, not a code string.**
  Grepping for `property_use_code` reported "deployed" against the OLD
  bundle, because the hover popup had always contained it. `ls
  web/dist/assets/main-*.js` after a local build gives the hash to wait
  for; it can only appear once Vercel builds that commit. Deploys took
  15-30s all session.
- **The Dropbox lock hits `npm run build`**, not just git. It fails in
  `prepareOutDir` and succeeds on an immediate retry. Same class as the
  fetch/push flakiness.
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
