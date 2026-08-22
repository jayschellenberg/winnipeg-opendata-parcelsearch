# Session handoff — 2026-08-22

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
deploys. Replaces `SESSION-HANDOFF-2026-08-21.md`, now archived under
`.claude/`, whose still-live constraints are carried forward below.

Eight commits landed and deployed across 2026-08-21/22, `74ad076` →
`826060c`. Three came out of answering ONE question nobody had asked —
the 79 vacant sales with no live roll record — three more came out of
things that broke while verifying those, and the last two came out of
Jason reading the result and naming two rules the app did not have.

---

## ⏸ THE ACTIVE RESUME POINT

Nothing is in flight and the tree is clean. Everything from this session
is verified against production, not just against tests. One thing waits
on Jason, unchanged for three sessions:

- **The 160-record Winnipeg N1 review queue.** In the SIBLING repo
  `D:\Dropbox\ClaudeCode\MBOpenData\mao-scrape` (`main` @ `119bd4e`).
  Run `n1-refresh-wpg.bat`; it ends by SERVING the review page and
  opening it, then blocks until Ctrl+C. Click "Open review folder…" (or
  "Resume review") and choose `n1_review_wpg/`; decisions autosave.
  Ctrl+C and re-run the bat to fold them in. Verified on disk
  2026-08-22: still 160 items (2020:30, 2021:51, 2022:26, 2023:33,
  2024:20), one decision already ingested, so the loop is proven end to
  end.

  It has to be SERVED: Chrome will not give the folder picker to a
  double-clicked `file://` page, which silently costs you folder mode —
  one year at a time instead of all of them, and a DOWNLOAD per save.

**The zone line on the citywide click popup is LIVE.** The last two
handoffs listed it as inert until the 2026-10-02 tile rebuild; that
rebuild was run by hand on 2026-08-22 and the field is in the published
archive. Nothing is waiting on that date any more. The scheduled task
still stands for 2026-10-02 as routine maintenance.

Beyond that nothing is queued. Candidates, none of them asked for:

- **The 14 top-end rows** — see "Still open" below. Offered and declined
  once, deliberately.
- Taxonomy still arguable: REFRL / PERP / STATU in Infrastructure,
  RESOT, INWSC, CMPST, RESAM vs RESMU.
- Three definitions of "land" are still only PARTLY reconciled.

---

## What shipped

### `74ad076` — a third instrument, for parcels the roll cannot see

79 vacant-coded sales matched no live assessment record. Those rolls are
**RETIRED**, not missing from a stale snapshot: all 72 distinct rolls
were re-checked against the LIVE `d4mq-wa44` and **71 are absent there
too**. They are big parcels — median lot 12,916 sf against the Land
set's 4,475 — and 20 of the 26 queryable addresses have no parcel at
that address today either. The address dies with the roll, which is what
subdivision does.

`sabreBuildVerdict` reads SABRE's own living area and year built off the
sale row, which survives the roll's retirement. `MIN_PLAUSIBLE_LIVING_SF
= 100` guards it. The 73 nothing can reach are marked "not verified" and
stay in Land.

### `04305a9` — the teardown question, settled

`pricedAsLand`: below **$50 per building sq ft** (the p5 of ordinary
improved sales; median $174, p95 $398) the market paid nothing for the
building, so the verdict is HELD BACK and the row stays in Land with a
`⚠ Building, priced as land` mark. Only reclassify where it is obvious
or a permit says so.

### `dc16367` — docs

### `549886e` — the citywide parcel tiles, rebuilt six weeks early

Run by hand rather than waiting for 2026-10-02. `zoning` is now in the
`parcels` and `parcels-labels` layers, read out of the published file's
own PMTiles metadata rather than inferred.

### `328fc96` — wait for the archive to be readable before hashing it

Two rebuild runs died at Step 4/6 with the archive already built.
`Get-FileHash` cannot read the freshly written 99 MB file while Dropbox
still holds it. Now polls on whether the file can be OPENED, and logs
the real exception.

### `8c444c0` — a sales run in a background tab deadlocked on the first yield

`yieldToPaint()` awaited a `requestAnimationFrame` that Chrome never
fires in a hidden tab. Pre-existing, and it has been silently costing
anyone who starts a long run and switches tabs. See the decisions list.

### `0a7bec6` — the build instruments can see surface parking

Every build pass gated on `isVacantUseCode`, so it policed the V-codes
and nothing else — but `saleCategory` files a sale under Land by
CATEGORY, and CMPSP reaches Land without being vacant-coded. 17 sales
sat in the Land set that nothing could ever judge. `isLandSetUseCode` is
the union, and the SABRE pass deliberately keeps the NARROW gate.

### `826060c` — a mixed sale is an improved sale in every row

Jason's rule: if any parcel in a multi-parcel sale is not parking or
vacant land, the whole transaction is improved. 23 transactions, 41
rows, and the land-denominated rates are withheld rather than marked.

---

## What the numbers do now

Replayed against the 53 SABRE CSVs and the March parquet, permits live
from `it4w-cpf4`:

| | before 08-21 | now |
|---|---:|---:|
| already-built, from a PERMIT | 6,238 | **6,238** |
| already-built, from the ROLL | 37 | **34** |
| already-built, from SABRE | — | **27** |
| held back, price says the building was worthless | — | **6** |
| marked "not verified" | 0 | **76** |
| re-categorised as a MIXED sale | 0 | **41** |
| Land category | 6,739 | **6,674** |
| median $/Lot SF (Land) | $30.14 | **$30.13** |

The Land median ends up almost where it started, but not because little
happened: 65 rows left, and what left was a tail of artificially LOW
blended rates ($16.63 on a $6.65M warehouse deal) alongside a set of
high ones. Do not read the flat median as a null result.

**Both columns are on the same basis — my replay, which INCLUDES the
demolition pass.** Do not compare against the older 6,673 / 6,636: those
were computed without the 103 teardown promotions, and 6,739 = 6,636 +
103. That reconciliation is exact and was checked.

**These are PARQUET numbers and they drift.** Measured against live
`d4mq-wa44` on 2026-08-22, only **2 of the 6** priced-as-land rows still
qualify (570 BALMORAL, 294 CHARLES); the other four had their buildings
removed from the roll since March, so no verdict exists to hold back.
Same for two of the roll-derived rows. Expect live counts to be lower
than the replay and to move on their own.

---

## Verified against production, 2026-08-22

All five Built states observed in the deployed app, in one window
(2020-07-01 → 2020-08-31, 469 sales):

| state | n |
|---|---:|
| `⚠ Already built` | 178 |
| `land → built` | 183 |
| `⚠ Building, priced as land` | 1 |
| `not verified` | 4 |
| blank | 103 |

570 BALMORAL reads Category **Land**, Built `⚠ Building, priced as
land`, tooltip "…the price works out to $32 per building square foot
against $174 for an ordinary improved sale…". The count line carries
both new clauses. That is the whole feature working end to end on real
data.

The published archive is **99.4 MB (99,395,754 bytes)**, up from 95.87.
**The +3.53 MB exceeds the earlier estimate** of ~0.22 MB scaled / up to
~1.3 MB across six zoom levels by roughly 2.7x. Some is parcel growth
since August 5 (245,255 fetched, 217,081 tiled after geometry dedupe),
but treat the old estimate as understated.

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
`CNVAC`; `mergeSalesFiles` must not throw on a bad header and must NOT
overwrite a Source it was given; subscriber data never leaves the
browser; living area sums the DISTINCT areas; unit counts COUNT the
labels; SABRE's land area leads; group properties are measured over the
WHOLE transaction; a permit-fetch failure must be SAID;
`UNCLASSIFIED_CATEGORY` is never blank; the category judgement calls are
Jason's; the draw cap caps DRAWING only; `normalizeStreetQuery`'s
known-name guard NARROWS while every other rule widens; the suggestion
list comes from the ASSESSMENT roll; `#address-street` is NOT in the
generic Enter loop; `zoning` is in the tile `select_cols` and
`total_assessed_value` stays out; the 100 MB cap does not apply to
`parcels.pmtiles`; `rollBuildVerdict` requires a LIVING AREA and a LIVE
RECORD; a permit ALWAYS wins over the roll; the roll pass sits OUTSIDE
the permit try/catch; the count line and tooltip name the INSTRUMENT;
SABRE's living area is POSITIVE evidence only; `MIN_PLAUSIBLE_LIVING_SF`
exists because SABRE writes 1 sf on surface parking; a PERMIT VERDICT IS
NEVER SECOND-GUESSED BY PRICE; `pricedAsLand` only cuts ONE way and the
mirror was measured and REJECTED; `'built-priced-as-land'` is
deliberately NOT `'already-built'`; `pricedAsLand` is single-parcel
only; the "not verified" mark is an ABSENCE, not a finding; the Built
column has FIVE states and the CSV distinguishes all five;
demolition-permit-after-a-vacant-sale is NOT a usable signal. All still
true. New:

1. **`yieldToPaint` must RACE a frame against a timer, and the timer
   must be armed unconditionally.** Chrome does not fire
   `requestAnimationFrame` in a hidden tab. The original awaited one
   with a fallback only for rAF being ABSENT, so a sales run in a
   backgrounded tab deadlocked on the first yield — permanently, with
   the progress line still showing, no error, and only a reload to
   recover. Do NOT "simplify" this to a bare `setTimeout` (that loses
   the paint on a visible tab and adds latency to every yield) and do
   NOT gate on `document.hidden` up front (a run backgrounded one line
   later would still deadlock). `test/yieldToPaint.test.js` pins all
   three cases; its regression test registers a rAF that never invokes
   its callback, which is the exact shape of a background tab.
2. **The extra macrotask inside the rAF callback is load-bearing.** rAF
   fires BEFORE paint, so `requestAnimationFrame(() => setTimeout(fn,
   0))` is what actually resumes after the frame commits. Resolving
   straight out of the rAF callback would resume before the status line
   was on screen, which is the entire point of the yield.
3. **Never hash a freshly written archive without waiting for it to be
   readable.** Dropbox holds the ~99 MB file open while it indexes and
   uploads. Measured 2026-08-22: `Get-FileHash` still failing 25s after
   the write, hashing in under a second at 85s. Poll on whether the file
   can be OPENED, not on a fixed number of short sleeps.
4. **Log the exception, never a bare "came back empty".** The first
   attempt at (3) swallowed the error and cost a whole extra 17-minute
   run to diagnose. Whatever fails, say what it was.
5. **Tiling is DETERMINISTIC.** Two independent 17-minute builds of the
   same source produced byte-identical archives
   (`8c58588edcaa…`). A failed publish costs only time, never
   correctness, so re-running is always safe.
6. **The tile rebuild's Step 3 refuses to publish an archive it did not
   build in that run** (`LastWriteTime -lt $runStart`). Do not work
   around it to skip a rebuild — re-run the script.
7. **`isLandSetUseCode` is a UNION and must stay one.** The build passes
   ask "is this in the LAND SET", which is wider than "did the assessor
   call it vacant" by exactly one code: CMPSP. Measured — 11 codes have
   category Land and parking is the only non-vacant one. Gating on the
   CATEGORY alone would be a silent narrowing, because `pucsCategory`
   returns null for a code it has never been taught and any future
   V-code would stop being judged. `isVacantUseCode` first means it can
   only ever add. Pinned by a `'VZZZZ'` test.
8. **`isVacantUseCode` is NOT replaced by it.** It still answers "the
   assessor marked this vacant" and still owns the vacant FILTER,
   `groupVacancy`, and `demoVerdict` — where a surface parking lot is
   emphatically not vacant and a demolition permit on one is a real
   teardown finding. Collapsing the two would turn 103 teardown findings
   into confirmations.
9. **The SABRE pass keeps the NARROW gate, on purpose.** Widening it to
   parking reclassified 6 of the 17 straight out of Land on SABRE's own
   living area — and the live roll contradicts every one. 165 FORT
   reports 120,126 sf of building on a 34,305 sf lot, PIONEER 110,140 sf
   on 10,271, while `d4mq-wa44` shows those parcels with NO year built
   and NO living area and three still reading SURFACE PARKING. SABRE's
   building fields are junk on a parking row in BOTH directions: the
   other 11 carry the 1 sf placeholder `MIN_PLAUSIBLE_LIVING_SF` exists
   to reject. Permits and the roll are widened because their evidence is
   sound here; SABRE is not.
10. **A mixed sale is judged on the FINAL category, not the use code.**
    That is what makes `resolveMixedSales` correct without exceptions: a
    teardown assembly has already had its improved parcel pulled to Land
    by `demoVerdict`, so it spans one category and nothing fires, while
    a group whose only improved parcel was found by an INSTRUMENT still
    does. Jason's call that evidence counts, not just the code — the
    largest case is a 24-parcel $1,930,000 subdivision sale with 6 lots
    built, and all 24 rows read Residential.
11. **A mixed sale's land rates are WITHHELD, group-wide.** $/Lot SF,
    $/Acre and $/Lot all divide the whole consideration by a land-side
    denominator, and part of that consideration bought buildings. 69
    rates go. $/Bldg SF stays — the sale IS improved. Withheld on every
    row of the group including the already-improved ones, because the
    rate is a group aggregate and blanking one sibling but not the other
    would be incoherent. Same principle as `parcelLandSf`: a blank
    claims nothing, $16.63 on a $6.65M warehouse deal is a fiction.
12. **`resolveMixedSales` declines to NAME a category when a group has
    more than one non-Land member, but still marks it mixed and still
    pulls its rates.** Silence about which improved type the deal was is
    not permission to keep a blended rate. None exist in the archive
    today.

---

## Still open — the 14 top-end rows

The other end of the price band. 14 rows carry an inferred already-built
verdict where the building cannot plausibly explain the price: 365
OAKDALE at $2,792 per building sf on a 67,755 sf lot, 165 PROVENCHER at
$1,591, 1204 STURGEON at $1,126, an unaddressed $9.7M row at $1,060.
Those are land deals with a building standing on them and they are
currently reclassified OUT of Land.

An age-relative ceiling at each cohort's p99 would catch about four and
correctly spare the new builds — a flat ceiling does NOT, because it
flags 28 WATERSTONE DRIVE (2,871 sf built 2014 at $531/bldg sf), which
`c79a65c` correctly reclassified. The cohort bands:

| building age | p5 | median | p95 | p99 |
|---|---:|---:|---:|---:|
| pre-1945 | $39 | $136 | $290 | $414 |
| 1945–1999 | $80 | $210 | $441 | $748 |
| 2000+ | $180 | $309 | $494 | $968 |

It needs three thresholds to move four rows and one lands at 1.04x its
boundary, which is not the "obvious" reclassification is reserved for.
Jason was offered it and chose to leave it. Close it deliberately or not
at all.

**One of them has since moved by a different route.** 365 OAKDALE is
half of instrument 5265912, a $5,500,000 two-parcel sale, and its
SIBLING carried an already-built verdict — so `826060c`'s mixed-sale
rule now reads the whole transaction as improved. The row left Land, but
not because the top-end question was answered. Anyone revisiting that
question should re-measure the 14 rather than assume the list still
holds.

---

## The Winnipeg N1 crosswalk

Unchanged. **It lives in the OTHER repo**, `MBOpenData/mao-scrape`
(`main` @ `119bd4e`); nothing is in THIS repo except one line in
`salesDbMerge.js`. Design record: `DESIGN-N1-WPG.md` over there.

**Run it:** `n1-refresh-wpg.bat`, or `Rscript scripts/n1_refresh_wpg.R
[--no-sabre] [--no-open]`. **Then point the app at
`results/sales_search/wpg_stamped/` — THAT FOLDER ONLY.** Connecting it
beside the raw SABRE folder imports every sale twice.

| | |
|---|---:|
| Winnipeg N1 records | 1,572 |
| auto-linked | 874 → 899 crosswalk rows |
| still queued for review | **160** |
| unmatched | 538 |
| sales the app sees (stamped folder) | 18,923 |
| carrying an `N1 ID` | 1,333 |
| N1 sales SABRE never had | 433 |

**Not every N1 record is a sale** — 1,420 Closed Sale, 141 Listing, 8
Pending, 3 Un-Executed. Only a Closed Sale may auto-link, and a binding
RE-OPENS when the record's type or price moves.

**SABRE has been missing sales for five years** — 410 N1 records carry a
roll the archive never held, median price $1,122,500, led by
Multi-Family (60), Commercial (32), Industrial (26), Office (26).

Traps, each paid for once: zero-pad both sides to 11 digits and do it
correctly (`formatC` pads CHARACTER input with SPACES; `nzchar(NA)` is
TRUE); N1 dates are EXCEL SERIALS, epoch 1899-12-30; use `Price` not
`Actual Price`; exclude WINNIPEG BEACH; `I()` around single-element
arrays in the review JSON; ONE stamped file, not 53; N1 sunsets
2027-09-01 with no API. N1-side defects that land here uncorrected: an
import bleed (IDs 19095–19323) and 176 duplicate groups.

---

## Deliberate divergences from the Manitoba sibling app

Unchanged: no `vacant-threshold`; the Sale/Asmt cap is gone entirely;
far-flung ships with no default threshold; the charts are
Winnipeg-specific LAND charts; `lib/pucs.js` has no MB counterpart; the
street-name typeahead; the N1 crosswalk binds to SABRE rather than MAO.
Winnipeg-only from this session: `sabreBuildVerdict`, `pricedAsLand`,
the "not verified" mark (all three depend on SABRE's export schema),
`lib/yieldToPaint.js` (MB has no such helper), and `isLandSetUseCode` /
`resolveMixedSales` (both hang off `lib/pucs.js`, which has no MB
counterpart).

---

## Known gaps

- **The 14 top-end rows.** See "Still open".
- **Parking sales carry no STALL count, so there is no $/stall.**
  `_saleNumUnits` and `_saleUnitLabel` are empty on all 17 CMPSP sales;
  neither SABRE nor the roll records stalls. Jason's plan is to enter
  those sales into N1 and let the crosswalk supply the count — the
  importer already recognises a units column (`Units`, `No of Units`,
  `Number of Units`) and the grid already has a **Units** column, so a
  count arriving that way flows through with no code change. What does
  NOT exist is a `$/Unit` rate; that is the piece to build once counts
  are real. Deriving stalls from lot area was considered and rejected:
  at ~325 sf/stall, PIONEER AVENUE would read ~$490,000 per stall, which
  says only that it is a redevelopment site, not a parking sale.
- **Parking sales are surfaced but not analysed.** They stay in Land, as
  Jason wants, and the existing PUCS filter isolates them (`Any PUCS` →
  CMPSP). Only ONE of the 17 carries any verdict — 835 NOTRE DAME,
  land-then-built from a permit. The rest are unjudgeable in practice
  because the roll records no building on any of them and SABRE's
  figures are not trusted here.
- **73 vacant-coded sales are marked "not verified"** — the roll is
  retired and nothing can judge them. They stay in Land and price like
  land (median $24.71/lot sf against $30.06), but nothing has checked
  them. 49 of the 79 carry no street number AND name, so the permit
  lookup never RAN for them: "no permit found" there is a question that
  failed, not an answer.
- **The replay numbers drift against live data.** See "What the numbers
  do now".
- **The stamped sales file is DERIVED and nothing keeps it fresh.** Only
  `n1-refresh-wpg.bat` updates it. Bites in six months, not today.
- **An N1-sourced sale will not FUSE with a SABRE row for the same
  sale** — `collapseCrossSource` picks buckets by name. Exposure is one
  run, between a SABRE download and the next refresh.
- **160 Winnipeg N1 records await review**; 538 unmatched.
- **1,562 already-built rows took the code's FALLBACK**, not a live-roll
  lookup.
- **Three definitions of "land" are only PARTLY reconciled.**
  `buildVerdict` gates on `isVacantUseCode`, so a CMPSP surface-parking
  sale can never receive an already-built verdict even though the
  category calls it Land. 17 sales.
- Carried forward: 142 Winnipeg commercial MLS sales with no usable
  LINC; ~135 same-roll near-date MLS/SABRE pairs unfused by design;
  August 2026 is partial (SABRE recording lag); historical shards still
  pin `eca2c00`; the Generate-Map-PNG legend still needs Jason's eye.

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
  MARK    _buildUnjudged              (land set + _noLiveMatch + no verdict)
  saleCategory                          pucs.js
  PASS 5  resolveMixedSales           (group pass, reads the CATEGORIES)
```

Passes 1-4 and the mark gate on `isLandSetUseCode` EXCEPT the SABRE one,
which keeps `isVacantUseCode` — see decision 9. Pass 5 runs last because
it reads the finished categories, which is what makes a teardown
assembly resolve correctly without an exception.

`liveByRoll` is a `Map<roll11, Feature>` built from
`../AssessmentParcels/data/assessment-parcels-2026-03-10.parquet`
(245,136 rolls) with python + pyarrow, keyed on the roll ZERO-PADDED TO
11 DIGITS.

Expected shape: 20,342 rows kept → 18,490 sales → 16,635 after the
sentinel filter → 12,894 vacant-coded → 812 with no permit verdict,
splitting 642 / 54 / 37 / 79.

**Checking a roll against the LIVE record:** `d4mq-wa44` with
`$where=roll_number in('…')`, 40 per request. Its `roll_number` is
already 11 digits zero-padded.

**Reading a pmtiles archive's own field list** (PMTiles v3,
little-endian): metadata offset at byte 24, length at 32, internal
compression at 97, min/max zoom at 100/101. Gunzip and read
`vector_layers[].fields`. That is how "the tiles now carry zoning" was
established rather than assumed.

**Rendering a table cell in node** needs a ~6-line `document` shim —
`createElement` returning an object with `textContent`, `title` and a
`classList.add` that THROWS on a multi-token string (real `classList`
behaviour, worth keeping). `columnsRegistry.js` is importable in plain
node because its DOM coupling lives in `cells.js`.

---

## Environment gotchas that cost real time

Carried forward and still true: the in-app Browser pane cannot render
this map (use Claude in Chrome); Bash here is Git Bash, so PowerShell
here-strings fail — use a heredoc and `git commit -F -`; run `.ps1` by
ABSOLUTE path; a large heredoc silently breaks, so use the Write tool
for anything substantial; `index.html` is LF throughout but the `.ps1`
files are CRLF and must stay 7-bit ASCII; the launch config lives at the
PROJECT ROOT (`WpgOpenData\.claude\launch.json`), NOT beside the app;
poll a Vercel deploy by grepping the BUNDLE HASH, not a code string
(deploys run 15–30s); a local HTML tool needs a SERVER, not `file://`;
the Bash tool's working directory resets between calls. New:

- **`requestAnimationFrame` DOES NOT FIRE IN A HIDDEN TAB, and every
  Claude-in-Chrome tab is hidden.** This is the single biggest trap for
  anyone testing this app from an agent. It produces a perfect phantom
  bug: the run stalls with a progress line showing, no console error,
  the button re-enabled, and it "recovers" for exactly one step every
  time you take a screenshot — because the screenshot composites the
  tab and releases one frame. `8c444c0` fixes the app, but the same
  trap applies to any OTHER rAF-gated code you test this way. Check
  `document.visibilityState` before believing a hang.
- **Instrument `window.fetch` before blaming the network.** Patching it
  to record `{state, ms}` per request is what proved the stall was
  upstream of any request — zero were issued. `performance.getEntries
  ByType('resource')` did NOT show the SODA calls and is not a
  substitute.
- **The Dropbox lock also hits `git commit`**, not just fetch/push and
  `npm run build`: `fatal: unable to write new index file`. Retry; the
  staged index survives.
- **The Built column CAN be verified end to end here** — the previous
  handoff said it could not. The sales database persists in IndexedDB
  per origin, so if Jason's Chrome has already imported the folder
  there is nothing to upload: open the deployed site, set
  `sales-date-from` / `sales-date-to` by dispatching `input` and
  `change`, click `#sales-db-load`, and read the grid. There is also a
  hidden `<input webkitdirectory>` at `index.html:367` wired to the same
  import path if a fresh import is ever needed.
- **A python heredoc is the reliable way to patch source here**, with an
  `assert s.count(old) == 1` before every write. Read `.ps1` files as
  BYTES and match on `\r\n` — a `\n`-based anchor silently matches
  nothing. Beware `\$` and `\\n` inside those python strings.

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

**His standing rules for the Land set.** Three now, and they compose:

1. *2026-08-21:* "flag but do not reclassify if there is any question
   about it. Only reclassify if obvious/permit."
2. *2026-08-22:* parking lot sales BELONG in the land analysis, and he
   also wants to analyse them as parking — per unit or per STALL, which
   is the rate that matters for a parking lot, not $/lot sf.
3. *2026-08-22:* "if there are multiple parcels, and at least one of
   them is not a parking lot or vacant land then the entire sale should
   be considered as an improved property and not a parking lot." A
   transaction is one deal.

Rule 1 is the tie-breaker when the others are ambiguous, and it is what
decided against trusting SABRE's building figures on parking rows. It
REFINES rather than reverses the `c79a65c` call where he took the
conservative reclassify-all option — that decision was made without the
$/building-sf measurement. Before shipping any rule
that changes a sale's category, measure what it does to individual ROWS,
not just the aggregate, and show him. Prefer holding a verdict back over
asserting it. Never overrule a permit with an inference. When a proposed
test misfires on a population it should not touch — as the $/bldg-sf
ceiling did on new luxury homes — say so and ship only the half that
holds.

**And a note to my successor about my own worst habit this session.** I
twice announced a root cause as "confirmed" on one lucky sample: the
checksum failure (hashed a hardcoded path by hand at a moment it
happened to be free, shipped a 25s retry, watched it fail identically)
and the sales-run hang (called it a "repeat-search wedge", blamed CPU
contention, both wrong). Each cost a full cycle. The fix that worked
both times was the same: instrument the thing, measure the actual
window, and only then write code. Jason values that far more than speed.
