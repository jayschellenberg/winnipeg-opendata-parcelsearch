# Session handoff — 2026-08-21

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
deploys. Replaces `SESSION-HANDOFF-2026-08-20.md`, now archived under
`.claude/`, whose still-live constraints are carried forward below.

Two commits landed and deployed, `74ad076` → `04305a9`. Both are about
one item that handoff listed as a candidate and nobody had asked for:
**the 79 vacant-coded sales with no live roll record**. Answering it
turned up a third evidence instrument, a defect in that instrument, and
a resolution to the teardown question `c79a65c` left open.

---

## ⏸ THE ACTIVE RESUME POINT

Nothing is in flight and the tree is clean. One thing is waiting on
Jason, unchanged from the last handoff:

- **The 160-record Winnipeg N1 review queue.** In the SIBLING repo
  `D:\Dropbox\ClaudeCode\MBOpenData\mao-scrape`. Run
  `n1-refresh-wpg.bat`; it ends by SERVING the review page and opening
  it, then blocks until Ctrl+C. Click "Open review folder…" (or
  "Resume review") and choose `n1_review_wpg/`; decisions autosave, so
  there is nothing to move. Ctrl+C and re-run the bat to fold them in.
  Verified on disk 2026-08-21: 160 items (2020:30, 2021:51, 2022:26,
  2023:33, 2024:20) and one decision already ingested, so the loop is
  proven end to end.

  It has to be SERVED: Chrome will not give the folder picker to a
  double-clicked `file://` page, which silently costs you folder mode —
  one year at a time instead of all of them, and a DOWNLOAD per save.

One dated item, which needs nothing until then:

- **The ZONE line on the citywide click popup is inert until
  2026-10-02**, when `WpgParcelTilesBiMonthly` rebuilds the tiles with
  the field and auto-deploys. Confirm it after that date. Until then its
  absence is expected, not a bug.

Beyond that nothing is queued. Candidates, none of them asked for:

- **The 14 top-end rows** — see "Still open" below. The one piece of
  this session's work deliberately left undone.
- Taxonomy still arguable: REFRL / PERP / STATU in Infrastructure,
  RESOT, INWSC, CMPST, RESAM vs RESMU.
- Three definitions of "land" are still only PARTLY reconciled — see
  Known gaps.

---

## What the numbers do now

Replayed against the 53 SABRE CSVs and the March parquet on 2026-08-21,
permits live from `it4w-cpf4`:

| | before this session | now |
|---|---:|---:|
| already-built, from a PERMIT | 6,238 | **6,238** |
| already-built, from the ROLL's year built | 37 | **34** |
| already-built, from SABRE's own record | — | **27** |
| held back, price says the building was worthless | — | **6** |
| vacant sales marked "not verified" | 0 | **73** |
| Land category | 6,739 | **6,715** |
| median $/Lot SF (Land) | $30.14 | **$30.06** |
| p75 $/Lot SF (Land) | $37.84 | $37.73 |

**Both columns are on the same basis — my replay, which INCLUDES the
demolition pass.** Do not compare either against the last handoff's
6,673 / 6,636. Those figures were computed without the 103 teardown
promotions the demo pass makes; 6,739 = 6,636 + 103. That reconciliation
is exact and was checked. The 812 → 642 / 54 / 37 / 79 audit split
reproduces exactly, one boundary row differing from the handoff's
641 / 55 between two buckets that both mean "correctly Land".

---

## What shipped

### `74ad076` — a third instrument, for parcels the roll cannot see

**The 79 are real and the rolls are RETIRED.** Every one of the 72
distinct rolls was re-checked against the LIVE `d4mq-wa44`, not just the
March parquet: **71 are absent there too**. The one exception,
`09010480715` (351 W VICTORIA, 2 rows), is a roll created after the
parquet was cut; it is live, still VRES1, no building, so it lands in
Land either way. Against live data the count is 77.

They are big parcels — median lot **12,916 sf** against the Land set's
4,475, p75 **54,952** against 5,904 — and **20 of the 26** addresses
that could be queried have no parcel at that address today either. The
address died with the roll. That is what subdivision does, and it is
what happens to land after you buy it.

**`sabreBuildVerdict`** (`lib/permitEvidence.js`) reads SABRE's own
`Total Living Area` and `Year Built` off the sale row, which survives
the roll's retirement. Same guards as `rollBuildVerdict` minus the
live-record gate, since that absence is the reason it exists.

**`MIN_PLAUSIBLE_LIVING_SF = 100`**, the mirror of
`MIN_PLAUSIBLE_LAND_SF` and the same number. Caught during review, not
before: four of what were then 34 verdicts rested on a **1 sf**
"building". See the decisions list.

**"not verified"** — the 73 that no instrument can reach STAY in Land
and carry a mark. A blank Built cell otherwise says the same thing here
as on the 642 sales the roll positively confirms bare, which are
opposite states.

### `04305a9` — the teardown question, settled

`demoVerdict` treats "a building stood here and was worthless" as making
a sale a LAND comp — that is what a teardown IS. The roll and SABRE
treat the same fact as DISQUALIFYING. Where a permit exists the two
never collide; where none does, the same transaction got opposite
answers depending on whether `it4w-cpf4` reached back far enough, which
for a pre-war house it never does — that table starts in 2016.

**`pricedAsLand`**, threshold **$50 per building sq ft** = the p5 of
ordinary improved single-parcel sales (n=3,385, median $174, p95 $398;
4.93% fall below). Six sales fail it, are held back, and stay in Land
with a `⚠ Building, priced as land` mark.

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
`createMultiSelectFilter` takes an optional `order`;
`normalizeStreetQuery`'s known-name guard NARROWS while every other rule
widens; the suggestion list comes from the ASSESSMENT roll; the
suggestion key folds hyphens but the CLAUSE does not; `#address-street`
is NOT in the generic Enter loop; the suggestion listbox is a SIBLING of
the address fields; `zoning` is in the tile `select_cols` and
`total_assessed_value` stays out; the 100 MB cap does not apply to
`parcels.pmtiles`; `rollBuildVerdict` requires a LIVING AREA and a LIVE
RECORD; a permit ALWAYS wins over the roll; the roll pass sits OUTSIDE
the permit try/catch; the count line and tooltip name the INSTRUMENT;
`mergeSalesFiles` must NOT overwrite a Source it was given; a sparse row
is safe in the sale aggregates BY CONSTRUCTION; an N1-sourced sale
carries a BLANK use code. All still true. New:

1. **SABRE's living area is POSITIVE evidence only, and the asymmetry is
   measured.** Across the **12,082** vacant-coded sales a permit has
   already judged, SABRE reports a living area on **3** — 0.02%. It does
   not populate the field for a vacant-coded parcel, so a blank means
   "not filled in", NEVER "no building". Reading bareness out of it
   would be `rollBuildVerdict`'s `hasLiveRecord` trap in new clothes.
   But 6 of the 37 roll-contradicted sales carry one, ~700x the base
   rate, so a value present is a rare and deliberate statement.
2. **`MIN_PLAUSIBLE_LIVING_SF` exists because SABRE writes 1 sf.** Of
   the 3,721 sales carrying a living area above zero, **21 read exactly
   1 and NOTHING falls between 2 and 199.** They are mostly CMPSP
   surface parking and their prices are large. Ungated they were the
   worst false positive available: OAK POINT HIGHWAY at $4,800,000 and
   280 YOUNG at $3,500,000, both VACANT-coded land sales pulled OUT of
   the Land set on the strength of "1 sf built 1960" — removing exactly
   the comp the set exists to hold. Applied to `rollBuildVerdict` too,
   where it is currently INERT: `d4mq-wa44` has 221,534 records above
   zero and none below 200 sf.
3. **A PERMIT VERDICT IS NEVER SECOND-GUESSED BY PRICE.** `pricedAsLand`
   only ever inspects a `roll`- or `sabre`-derived verdict. A dated
   permit at the address is the obvious case; price is a weaker
   instrument than the record it would be overturning. All 6,238 permit
   findings are untouched.
4. **`pricedAsLand` only cuts ONE WAY, and the mirror was built and
   REJECTED.** A flat HIGH cut flags **28 WATERSTONE DRIVE**, 2,871 sf
   built 2014 at $531/bldg sf — a normal price for a new luxury home and
   `c79a65c`'s own example of a CORRECTLY reclassified row. The band is
   age-sensitive at both ends:

   | building age | p5 | median | p95 | p99 |
   |---|---:|---:|---:|---:|
   | pre-1945 | $39 | $136 | $290 | $414 |
   | 1945–1999 | $80 | $210 | $441 | $748 |
   | 2000+ | $180 | $309 | $494 | $968 |

   The floor cannot make that mistake in reverse: the 1st percentile for
   post-2000 stock is **$128**, so no new building can reach $50 at all.
   That asymmetry is the whole reason a flat low cut is safe and a flat
   high one is not. Do not "complete the symmetry".
5. **`'built-priced-as-land'` is deliberately NOT `'already-built'`.**
   `saleCategory` only acts on the latter, so the new value leaves the
   row in Land — which is the entire point. Renaming or folding them
   silently reclassifies six sales.
6. **`pricedAsLand` is single-parcel only.** On a group the price is the
   whole transaction's and the living area is one parcel's, so the ratio
   is meaningless. All six rows it catches are single-parcel.
7. **The "not verified" mark is an ABSENCE, not a finding.** It stays in
   Land, takes the quiet styling, and its tooltip says what could not be
   asked rather than what was found. Do not promote it to a ⚠.
8. **49 of the 79 have no street number AND name**, so
   `permitAddressKey` returns `''` and the permit lookup never RAN.
   "No permit found" on those rows is a question that failed, not an
   answer, and the tooltip says so. This is the same population as the
   296 sale rows named in the last handoff's Known gaps.
9. **The Built column has FIVE states and the CSV distinguishes all
   five**: `ALREADY BUILT`, `BUILDING, PRICED AS LAND`, `land then
   built`, `not verified`, and empty. `not verified` must not export as
   an empty string — a comp set lifted out of the CSV could not
   otherwise tell it from a sale the roll confirmed bare.
10. **Demolition-permit-after-a-vacant-sale is NOT a usable signal.**
    Measured: 58 vacant-coded sales carry one, which looks like proof a
    building stood. **46** have a construction permit saying the building
    went up AFTER the sale, so the demolition is of a later building. The
    12 survivors price at median $27.40 — BELOW the Land median. It
    corroborates individual rows (599 WASHINGTON) but is not a rule.
    Measured and discarded; do not re-propose it.

---

## Still open — the 14 top-end rows

The other end of the same band, and the one thing this session
deliberately did not do. 14 rows carry an inferred already-built verdict
where the building cannot plausibly explain the price:

| | $/bldg sf | $/lot sf |
|---|---:|---:|
| 365 OAKDALE — $5,500,000, 1,970 sf built 1937, 67,755 sf lot | $2,792 | $81.17 |
| 165 PROVENCHER — $3,500,000, 2,200 sf built 1937 | $1,591 | $865.48 |
| 1204 STURGEON ROAD — $3,300,000, 2,930 sf built 1963 | $1,126 | $15.61 |
| unaddressed — $9,700,000, 9,150 sf built 1975 | $1,060 | $90.06 |

Those are land deals with a building standing on them, and they are
currently reclassified OUT of Land. An age-relative ceiling at each
cohort's p99 (table in decision 4) would catch about four of them and
correctly spare the new builds, but it needs three cohort thresholds to
move four rows and one lands at 1.04x its boundary — which is not the
"obvious" reclassification is reserved for. Jason was offered it and
chose to leave it. Close it deliberately or not at all.

---

## The Winnipeg N1 crosswalk

Unchanged this session. **It lives in the OTHER repo**,
`D:\Dropbox\ClaudeCode\MBOpenData\mao-scrape` (`main` @ `119bd4e`),
because that is where the N1 exports, the review page and the MB
crosswalk already are. Nothing about it is in THIS repo except one line
in `salesDbMerge.js`. Its own design record is `DESIGN-N1-WPG.md`.

**Run it:** `n1-refresh-wpg.bat`, or `Rscript scripts/n1_refresh_wpg.R
[--no-sabre] [--no-open]`.

**Then point the app at
`mao-scrape/results/sales_search/wpg_stamped/` — THAT FOLDER ONLY.**
Connecting it beside the raw SABRE folder imports every sale twice.

**The web app never matches.** It consumes an `N1 ID` column and shows
an Any/Matched/Unmatched filter (`?n1=`). Blank = "needs entering".

| | |
|---|---:|
| Winnipeg N1 records | 1,572 |
| auto-linked | 874 → 899 crosswalk rows |
| accepted through the review page | 1 |
| still queued for review | **160** |
| unmatched | 538 |
| sales the app sees (stamped folder) | 18,923 |
| of those, carrying an `N1 ID` | 1,333 |
| of those, N1 sales SABRE never had | 433 |

### The two things a Winnipeg reader must know

**1. Not every N1 record is a sale.** 1,420 Closed Sale, **141
Listing**, 8 Pending Contract, 3 Un-Executed. A Listing is an asking
price; Jason converts it to a sale later, editing the record IN PLACE
under the same `n1_id`. So only a Closed Sale may auto-link, and a
binding RE-OPENS when the record's type or price moves.

**2. SABRE has been missing sales for five years.** 410 N1 records carry
a roll the SABRE archive has never held: median price **$1,122,500**,
spread over 2020–2024, led by Multi-Family (60), Commercial (32),
Industrial (26), Office (26), Warehouse (17). 433 are EMITTED as sales
with a synthetic `N1-<id>` instrument, `Source=N1`, and a blank use code.

### Traps, each paid for once

- **Zero-pad both sides to 11 digits, correctly.** `formatC(width = 11,
  flag = "0")` pads CHARACTER input with SPACES; 23 records bind only
  because of the padding and they failed silently. `nzchar(NA)` is TRUE,
  so an NA roll padded to `"000000000NA"`.
- **N1 dates come out of the xlsx as EXCEL SERIALS** (`43847`), epoch
  1899-12-30.
- **Use `Price`, not `Actual Price`** — the latter is on 17 of 1,592.
- **Exclude WINNIPEG BEACH** — a different municipality MAO does assess.
  20 records; a bare substring test claims all of them.
- **`I()` around single-element arrays in the review JSON**, or
  `auto_unbox` collapses them and the record throws on render.
- **One stamped file, not 53 stamped exports.** `mergeSalesFiles` dedupes
  on the parsed row's KEY SET, so a folder mixing stamped and unstamped
  files stops deduping overlapping pulls entirely.
- **N1 sunsets 2027-09-01** and has no API; exports cap near 1,500 rows.
- N1-side data defects that land here uncorrected: an **import bleed**
  (IDs 19095–19323, each Tax ID carrying the NEXT record's rolls) and
  **176 duplicate groups**.

---

## Deliberate divergences from the Manitoba sibling app

Unchanged: no `vacant-threshold`; the Sale/Asmt cap is gone entirely;
far-flung ships with **no default threshold**; the charts are
Winnipeg-specific LAND charts; the appraisal-category layer
(`lib/pucs.js`) has no MB counterpart; the street-name typeahead and the
`rollBuildVerdict` fallback are Winnipeg-only; the N1 crosswalk binds to
SABRE rather than MAO. New: `sabreBuildVerdict`, `pricedAsLand` and the
"not verified" mark are Winnipeg-only — all three depend on SABRE's
export schema, which MB has no equivalent of.

---

## Known gaps

- **The 14 top-end rows.** See "Still open" above.
- **73 vacant-coded sales are marked "not verified"** — the roll is
  retired and nothing can judge them. They stay in Land and price like
  land (median $24.71/lot sf against the Land set's $30.06, p75 $43.60
  against $37.73, 3 of 70 above the Land p95), but nothing has checked
  them. Down from 79: `sabreBuildVerdict` settles 6.
- **The zone line on the click popup is inert until 2026-10-02.**
- **The stamped sales file is DERIVED and nothing keeps it fresh.** A new
  SABRE download does not update `wpg_stamped/wpg-sales-with-n1.csv`;
  only `n1-refresh-wpg.bat` does. This is the failure that bites in six
  months rather than today.
- **An N1-sourced sale will not FUSE with a SABRE row for the same
  sale.** `collapseCrossSource` picks its buckets by name, so an `N1` row
  falls in with SABRE and is never fused. By construction it cannot
  collide at emit time; the exposure is one run, between a SABRE download
  and the next refresh.
- **160 Winnipeg N1 records await review**, and 538 are unmatched: 410
  whose roll the SABRE archive never held, 73 with no Tax ID, 55 whose
  roll matched with no sale within 400 days.
- **1,562 of the already-built rows took the code's FALLBACK**, not a
  live-roll lookup.
- **296 sale rows have no usable street number + name**, which is the
  same population as decision 8's 49.
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

```
SABRE CSVs  ->  D:\Dropbox\ClaudeCode\WpgOpenData\SABRE\*.csv  (53 files)
  mergeSalesFiles([{name, csv}])        salesDbMerge.js  -> { text }
  parseSalesText(text)                  salesImport.js   -> { rows }
  dedupAndGroupSales(rows)              sales.js         -> { sales, groups }
  sales.filter(s => s.salePrice > 1)    the app's DEFAULT (hide-sentinels)
  buildSaleFeatures(visible, liveByRoll, groups)
  PASS 1  buildPermitIndex / findNearestPermit / demoVerdict / buildVerdict
  PASS 2  rollBuildVerdict            (only where PASS 1 said nothing)
  PASS 3  sabreBuildVerdict           (only where 1 and 2 said nothing)
  PASS 4  pricedAsLand                (only on a roll/sabre verdict)
  MARK    _buildUnjudged              (vacant + _noLiveMatch + no verdict)
  saleCategory                          pucs.js
```

`liveByRoll` is a `Map<roll11, Feature>`. Build it from the local parquet
(`../AssessmentParcels/data/assessment-parcels-2026-03-10.parquet`,
245,136 rolls) with python + pyarrow, keyed on the roll ZERO-PADDED TO
11 DIGITS, each value `{type:'Feature', geometry:null, properties:{...}}`.

Expected shape today: 20,342 rows kept → 18,490 sales → 16,635 after the
sentinel filter → 12,894 vacant-coded → 812 with no permit verdict,
splitting 642 / 54 / 37 / 79.

Permits come from `it4w-cpf4` — copy the exact `$select`/`$where` out of
`src/soda.js`, including the 3-year window for construction against the
2-year default for demolition.

**Checking a roll against the LIVE assessment record** (this is how the
79 were proven retired rather than merely missing from the parquet):
`d4mq-wa44` with `$where=roll_number in('…')`, 40 rolls per request. Its
`roll_number` is already 11 digits zero-padded, so no normalisation is
needed on that side.

**Rendering a table cell in node** needs only a ~6-line `document`
shim — `createElement` returning an object with `textContent`, `title`
and a `classList.add` that THROWS on a multi-token string (which is the
real `classList` behaviour and worth keeping). `columnsRegistry.js` is
importable in plain node because its DOM coupling lives in `cells.js`
and only inside function bodies.

**Reading the pmtiles' own field list** (PMTiles v3, little-endian):
metadata offset at byte 24, length at 32, internal compression at 97,
min/max zoom at 100/101. Gunzip and read `vector_layers[].fields`.

---

## Environment gotchas that cost real time

Carried forward and still true: the in-app Browser pane cannot render
this map (use Claude in Chrome); Bash here is Git Bash, so PowerShell
here-strings fail — use a heredoc and `git commit -F -`; run `.ps1` by
ABSOLUTE path; `r2.dev` does not answer HEAD usefully; a large heredoc
silently breaks, so use the Write tool for anything substantial;
`index.html` is LF throughout; the MAAP PUCS PDF is a scanned fax with
no text layer; the launch config lives at the PROJECT ROOT
(`WpgOpenData\.claude\launch.json`), NOT beside the app — the one under
`ParcelSearch/.claude/` is not read; port 5173 is the MB sibling's and
5174 a third project's; **poll a Vercel deploy by grepping the BUNDLE
HASH**, not a code string (`ls web/dist/assets/main-*.js` after a local
build gives the hash to wait for; deploys run 15–30s); the Dropbox lock
hits `npm run build` as well as git and succeeds on an immediate retry;
a local HTML tool needs a SERVER, not `file://`; the Bash tool's working
directory resets between calls, so `cd` at the start of every command.
New:

- **A python heredoc is the reliable way to patch source here.** Building
  JS through a bash heredoc mangles escapes, and `sed` on these files is
  fragile. `python - <<'PYEOF'` with an `assert s.count(old) == 1` before
  every write catches a non-matching anchor instead of silently writing
  nothing — which happened twice this session. Beware `\$` and `\\n`
  inside those strings: python will interpret them before JS ever sees
  them, and a `\\n` became a literal newline that broke a script.
- **The Built column cannot be verified end to end here.** Reaching it
  needs a sales set loaded through the folder picker, which needs
  Jason's real browser. Verify the render path with the node DOM shim
  above and the data path with the offline replay instead, and SAY that
  is what was done.

---

## Working style (Jason)

Direct/technical, no preamble. **Commit when he says; push is a separate
instruction** and push = deploy. He gives one instruction at a time —
"commit this", then "push it" — so do not batch them or assume the next.
Concrete numbers over hand-waving; verify by execution against real
data, not fixtures. He is an appraiser: when a result is ambiguous the
question he wants answered is "what should I do with this row", not
"what does this field contain".

**He will tell you to do something the data says is wrong.** Measure it,
show him the table, recommend — then do what he says.

**His standing rule for the Land set, stated 2026-08-21:** *"flag but do
not reclassify if there is any question about it. Only reclassify if
obvious/permit."* This REFINES rather than reverses the `c79a65c` call
where he took the conservative reclassify-all option over a flag — that
decision was made without the $/building-sf measurement. Before shipping
any rule that changes a sale's category, measure what it does to
individual ROWS, not just the aggregate, and show him. Prefer holding a
verdict back over asserting it. Never overrule a permit with an
inference. And when a proposed test misfires on a population it should
not touch — as the $/bldg-sf ceiling did on new luxury homes — say so
and ship only the half that holds.
