# Session handoff — 2026-08-20 (second session)

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
deploys. Replaces the earlier 2026-08-20 handoff (`af8c838`), whose
still-live constraints are carried forward below.

Six commits landed and deployed this session, `484ab67` → `f5d48dc`.
Every one of them changes a number an appraiser would put in a report, so
read "What the numbers do now" before trusting any figure you remember
from the previous handoff.

---

## ⏸ THE ACTIVE RESUME POINT

Nothing is in flight and the tree is clean. Jason's remaining queue, in
the order he gave it:

1. **Street-name autocomplete on the Property Search tab**, predictive,
   off the City's street-name open data. Not started.
2. **Zoning on the CLICK popup.** The hover popup already shows it
   (`f5d48dc` era, `src/map.js` `popupHtml`). The click popup is a
   DIFFERENT function — `citywideParcelHtml`, fed from the offline
   `parcels.pmtiles` snapshot, which carries no zoning field and no PUCS
   line for zoning to sit under. Getting it there means rebuilding the
   `r/` tile pipeline to include zoning. That is a data decision, not a
   map.js edit — do not "just add a line".
3. **The N1 cross-reference review.** Still blocked on a real crosswalk:
   no sales CSV in the archive carries an `N1 ID` yet. **Check the
   leading-zero padding first** — Jason reported that N1 tax IDs
   sometimes drop a leading zero (`6070731000` for `06070731000`). The
   app already pads on import (`normalizeRoll`), so the gap is in his
   OFFLINE crosswalk, which is what stamps the column. An unpadded
   compare reads as Unmatched, which looks like "still to be entered"
   rather than "we failed to match" — invisible either way.
4. **The 792 unjudged vacant sales** — see Known gaps.

---

## What the numbers do now

Measured against the City's own parcel file
(`AssessmentParcels/data/assessment-parcels-2026-03-10.parquet`), not
estimated. Reproduce with the method in "Verifying offline".

| | before this session | now |
|---|---:|---:|
| Land category | 12,889 sales (80.0%) | **6,736 (41.8%)** |
| Residential category | 0 | **6,033 (37.5%)** |
| median $/lot SF (Land) | $40.58 | **$30.11** |
| max $/lot SF (any) | $615,000 | **$2,601** |
| land chart trend | +1.43%/yr, R² **0.000** | **+12.30%/yr, R² 0.024** |
| sales with doubled living area | 609 | **0** |
| largest reported "unit count" | 4,201 | **36** |

The land-rate move is not a shaved median — it deletes a second
distribution that was hiding inside the land set. Quantiles before:
p25 $28 / p50 $41 / **p75 $118** / p95 $178 (visibly bimodal). After:
p25 $25 / p50 $30 / **p75 $38** / p95 $128.

---

## What shipped

**PUCS names and categories** (`src/lib/pucs.js`, new). 135 codes → a
plain name and one of 12 appraisal categories. Names are the CITY's own
labels: `d4mq-wa44` publishes `property_use_code` as `"CODE - NAME"`, so
they were read off the live dataset, not transcribed. The 2002 MAAP fax
(`D:\Dropbox\Appraisal\GeneralData\MAAP\MAAP Property use codes.pdf`)
filled in codes the live roll no longer carries. Every one of the 57
codes in the sales archive classifies; none left over.

`saleCategory()` lets the PERMIT RECORD overrule the roll — the part the
use code cannot do on its own. Stamped after the permit pass for exactly
that reason.

**Category column + picker** (sales tab). Applied ahead of Class, full
width, Land first. Plus a `Use` column (the code in words) and the name
on the PUCS badge's tooltip.

**Three import corrections**, each a real defect with a measured size:
living area, unit counts, and the land denominator. See "Decisions that
will silently regress".

**Sales-tab usability**: the one-off CSV import is collapsed by default,
the run reports each phase in the bar above the grid (it looked frozen
because a full-archive run fetches thousands of records before the first
row appears), and the table draws at most 2,000 rows.

**Land charts** exclude already-built sales by default, and their
"land" now means the grid's permit-corrected category rather than a
re-derivation off the raw use code.

---

## Decisions that will silently regress if you don't know them

Carrying forward the 08-06 and earlier 08-20 lists — never
`gh release upload --clobber`; revert the checksum only if the archive is
not live; decide from a re-read not an exit code; "unknown" is a third
outcome; every `CN*`/`RES*` code must be classified; `generated_at` means
when the DATA changed; `.ps1` files stay 7-bit ASCII; the two sources
date the same sale differently; `rowSignature` must normalize the date
cell; the $/Bldg SF live fallback is withheld on vacant-coded sales;
far-flung fails OPEN; **the Sale/Asmt cap is gone and must not come
back**; the `$/Lot SF` RANGE filter stays removed; vacancy is the V
prefix plus `CNVAC`; `mergeSalesFiles` must not throw on a bad header;
subscriber data never leaves the browser. All still true. New:

1. **Living area: sum the DISTINCT areas, never every row.** SABRE
   repeats the whole building's area per row far more often than it
   splits it — 397 HORACE writes 1,950 sf three times, once per suite,
   and the City says the building is 1,950 sf. Against
   `total_living_area` on the 168 checkable multi-row sales, summing
   every row matched **0**; summing the distinct areas matched **156**.
   But 355 of 889 multi-row sales DO carry genuinely different areas and
   those are real sections that must still add up, so neither "always
   sum" nor "always take one" is right.
2. **Units: COUNT the labels, do not max them.** `Number of Unit` is a
   SUITE IDENTIFIER. 583 of 889 values exceed 12 and 34 are not numbers
   at all (`504B`, `G-H`, `F`). Maxing them was right on 0.3% of sales;
   counting the distinct labels is right on 80%, and most of the
   remainder are rolls the City now reports as 0 because the building was
   demolished — 185 BANNERMAN sold six suites in 2022 and reads 0 today.
   **That is why the count comes from the SALE, not the roll.**
3. **Land area: SABRE's actual leads, the ASSESSMENT RECORD is the
   fallback.** SABRE is the sale-time fact; the roll describes the parcel
   today, and a parcel subdivided since would be priced on geometry that
   did not exist at the sale. Fallback only where SABRE's is missing or
   under 100 sf. Where neither is usable the rate is **withheld**, never
   computed on a placeholder.
4. **NOT SABRE's own `Land Assessed sqft` column.** It is present on
   3,599 of 16,103 sales against actual's 15,455, is NEVER present when
   actual is missing, and is 0 on all 40 tiny-lot sales. Switching to it
   loses 77% of the land rates and fixes none of the outliers. This was
   asked for explicitly and measured down; do not "restore" it.
5. **Group properties are measured over the WHOLE transaction.**
   `groupVacancy` and `groupSpreadKm` take `saleFc.features`, not the
   post-filter survivors. The Category filter can remove the one improved
   parcel of a land assembly; reading vacancy off what is left flips that
   sale from improved to vacant while its rows still carry a $/Lot SF
   computed over all three parcels and the whole price.
6. **A permit-fetch failure must be SAID.** `permitsOk` gates a loud
   count-line clause. With no verdicts, `saleCategory` falls back to the
   roll's raw opinion and Category asserts "Land" for finished houses —
   the difference between 6,736 and 12,889 Land rows. Blank Demo/Built
   columns are honest; a confident wrong Category is not.
7. **`UNCLASSIFIED_CATEGORY` is never blank**, and lives in
   `lib/pucs.js` so the filter, the column and the CSV spell it
   identically. A blank reads as "no data" rather than "a code we have
   not been taught", and those sales would fail every category filter
   silently.
8. **The category judgement calls are Jason's**, recorded beside the
   table: surface parking (CMPSP) is **Land** and the parking STRUCTURE
   is not; condos group by underlying USE, not tenure (CNCOM →
   Retail-Commercial, CNIND → Industrial, CNOFF → Office); VAGRI is
   **Land**, not Agricultural; RESGC is Special Purpose.
9. **The draw cap caps DRAWING only.** `currentRows`, the CSV export, the
   charts broadcast and every count still cover the whole set, and the
   count line says so. A capped table that stayed quiet would read as a
   smaller market.
10. **`createMultiSelectFilter` takes an optional `order`.**
    Alphabetical is right for codes nobody has a mental order for; the
    categories are a fixed vocabulary and sorting them buries Land
    between Infrastructure and Mixed-Use.

---

## Deliberate divergences from the Manitoba sibling app

Unchanged: no `vacant-threshold`; the Sale/Asmt cap is gone entirely;
far-flung ships with **no default threshold**; the charts are
Winnipeg-specific LAND charts. New: the appraisal-category layer
(`lib/pucs.js`) has no MB counterpart — MB classifies differently and
this table is Winnipeg PUCS only.

---

## Known gaps

- **792 vacant-coded sales carry no construct-new permit within three
  years either way.** Judged neither built nor bare, so they stay in
  Land. If any were in fact built on — permit outside the window, address
  spelled differently, permit never pulled — the corrected Land set still
  contains them. This is the biggest remaining blind spot.
- **1,562 of the 6,238 already-built rows (a quarter) took the code's
  FALLBACK**, not a live-roll lookup, because the roll was missing or
  still reads vacant. They defaulted to Residential (or
  Retail-Commercial / Industrial for VCOMM / VINDU).
- **296 sale rows have no usable street number + name**, so they can
  never join a permit — 292 of them vacant-coded and sitting in Land
  unjudged. The permit join is by ADDRESS because the permit table has no
  roll number.
- **Three definitions of "land" are only PARTLY reconciled.** The charts
  now key `isLand` off `_saleCategory`, but `buildVerdict` still gates on
  `isVacantUseCode` (a V-prefix rule), so a CMPSP surface-parking sale
  can never receive an already-built verdict even though the category
  calls it Land. 17 sales.
- **Taxonomy still arguable** and worth Jason's eye: REFRL / PERP /
  STATU sitting in Infrastructure (the module's own docstring warns
  against parking unclassified things there), RESOT, INWSC, CMPST,
  RESAM vs RESMU.
- Carried forward: 142 Winnipeg commercial MLS sales with no usable LINC;
  ~135 same-roll near-date MLS/SABRE pairs with different prices left
  unfused by design; August 2026 is partial (SABRE recording lag);
  historical shards still pin `eca2c00`; the Generate-Map-PNG legend and
  the `showDirectoryPicker` folder-connect path still need Jason's real
  browser.

---

## Verifying offline (this is how every number above was produced)

The app's `lib/` modules are pure and import straight into plain node, so
the whole pipeline can be replayed against the real archive without a
browser. On Windows node an absolute path needs a `file:///` URL.

```
parseSalesText (salesImport.js)
  → dedupAndGroupSales (sales.js)
  → buildSaleFeatures (sales.js, needs a liveByRoll Map)
  → buildPermitIndex / findNearestPermit / buildVerdict (permitEvidence.js)
  → saleCategory (pucs.js)
  → median / fitLinear / annualTrendPct (salesCharts.js)
```

Ground truth for living area, land area, dwelling units, year built and
the live use code is the local parquet at
`AssessmentParcels/data/assessment-parcels-2026-03-10.parquet`
(245,136 rolls; read it with python + pyarrow). Permits come from
`it4w-cpf4` — copy the exact `$select`/`$where` out of `src/soda.js`, or
the numbers are not comparable. Remember the app's default filters when
comparing: `sales-hide-sentinels` is CHECKED, which drops 1,854 records
before anything else.

---

## Environment gotchas that cost real time

Carried forward and still true: the in-app Browser pane cannot render
this map (use Claude in Chrome); Bash here is Git Bash, so PowerShell
here-strings fail — use a heredoc and `git commit -F -`; run `.ps1` by
ABSOLUTE path; `r2.dev` does not answer HEAD usefully; `index.html` is
**CRLF** while `src/**` is LF, so a patch script must normalize, edit and
restore or every multi-line anchor misses; building JS through a heredoc
mangles escapes. New:

- **A large heredoc silently breaks.** Writing a ~160-line patch script
  through `<<'EOF'` failed with a shell quoting error. Use the Write tool
  for anything substantial.
- **Port 5173 collides with the Manitoba sibling app**, which runs from
  an adjacent repo under another session and answers with a page titled
  "Manitoba Parcel Search". `vite.config.js` now honours `PORT`, and
  `.claude/launch.json` declares 5174 — but `.claude/` is GITIGNORED, so
  that half does not travel. The preview harness also caches the launch
  config, so changing it mid-session may not take effect.
- **The MAAP PUCS PDF is a scanned fax with no text layer.** `pdftotext`
  returns nothing. Extract the page images with `pypdf`, convert with
  PIL, and read the PNGs directly. Page 4 is a bonus: MUNICIPAL CODES,
  which decode the roll number's first two digits into a district
  (`01` Charleswood … `06` St Boniface … `12`–`14` Winnipeg Wards 1–3).
  Not used by the app yet.

---

## Working style (Jason)

Direct/technical, no preamble. Commit when he says; **push is a separate
instruction** and push = deploy. Concrete numbers over hand-waving;
verify by execution against real data, not fixtures. He will interrupt
mid-task to redirect and queue several items at once — finish the
in-flight piece, then take them in the order he gave. He is an appraiser:
when a result is ambiguous the question he wants answered is "what should
I do with this row", not "what does this field contain".

**He will tell you to do something the data says is wrong.** Twice this
session — "add the total living area" and "rely on assessed land sf" —
the literal instruction would have produced worse numbers, and both times
the right move was to measure it, show him the table, and recommend. He
took the recommendation both times. Measure first, then say so plainly.
