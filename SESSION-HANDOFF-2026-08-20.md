# Session handoff — 2026-08-20

Resume point for a fresh thread on the **Winnipeg Parcel Search** repo
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Live at
https://winnipeg-opendata-parcelsearch.vercel.app/ ; every push to `main`
deploys. Supersedes SESSION-HANDOFF-2026-08-06.md, whose still-live
constraints are carried forward below.

---

## ⏸ THE ACTIVE RESUME POINT

1. **Jason wants to review the N1 cross-reference** (his words, end of the
   2026-08-20 session). Nothing is broken — the column, the
   Matched/Unmatched filter and the `?n1=` param all ship and are tested.
   What has never happened is a run against a REAL crosswalk: no sales CSV
   in the archive carries an `N1 ID` column yet, so every row currently
   reads Unmatched. He is building the SABRE→N1 backfill himself (manual
   pulls, ≤500 records, **non-residential only**). The review is
   presumably: does the column behave against real stamped data, and is
   Unmatched-as-data-entry-queue the right framing.
2. **Land charts still plot already-built sales.** See "The biggest open
   analytical issue" — the one outstanding item that would change a
   number in a report.

---

## What the sales side now is (2026-08-19 → 08-20)

The Sales Analysis tab went from "drop a CSV" to a small evidence engine.
In order of how much they matter:

**Two sources, one pipeline.** `lib/salesImport.js` reads SABRE
(`SoldPropertyListing*.csv`); `lib/mlsImport.js` translates MLS exports
into the same canonical rows. `lib/salesDbMerge.js` merges PARSED ROWS
(not raw text — two schemas share no raw form), dedupes, and fuses the
sales both sources report. `lib/salesStore.js` holds the folder in
IndexedDB (`wpg-parcel-sales`) behind a File System Access handle.
`salesDbPanel.js` is the UI. The whole thing hands `handleSalesUpload`
one `{name, text}` — the same contract a file drop uses.

**Permit evidence** (`lib/permitEvidence.js`) corrects the assessment use
code in both directions, joined by ADDRESS because the permit table
carries no roll number:

- improved code + demolition permit within ±2y → **teardown** (the price
  bought a lot and a demolition bill);
- vacant code + Construct New permit **6+ months before** the sale →
  **already built** (the house was finished when the lot changed hands).

**Land metrics**: Acres (derived, sf ÷ 43,560), $/Acre, $/Lot, $/Bldg SF.
Every rate divides by the GROUP total, so an assembly is priced as one
deal.

**Charts** (`charts.html`, opened from the sales tab): $/Lot SF over time,
$/Acre vs lot size, $/Lot vs lot size. Live over a BroadcastChannel so
they track the sidebar filters; hand-rolled SVG because the CSP is
`script-src 'self'`.

**Data Status** dialog + tile-staleness banner, and a per-source freshness
read-out in the sales panel ("SABRE: latest sale Aug 5, 2026 (15d ago)").

---

## The archive (`D:\Dropbox\ClaudeCode\WpgOpenData\SABRE`)

53 files, Jan 2020 → Aug 2026. **All 81 months covered** — verified by
parsing the sale dates, not by reading filenames. 20,587 rows in →
**18,490 transactions**.

| Source | Transactions |
|---|---|
| SABRE only | 17,712 |
| SABRE + MLS (fused) | 245 |
| MLS only | 533 |

**Jason deliberately excluded single-family homes and residential condos
from the SABRE pulls, for volume.** The archive is therefore a
non-residential / land comp set, NOT a market-wide sample — do not read
citywide conclusions off it. VRES1 is 77% of the SABRE side because of
that exclusion.

MLS is **commercial only** (all `PropType = Industrial/Comm/Investmnt`),
pulled on a 20 km radius. The 112 non-Winnipeg rows are excluded on
import by Jason's decision, along with 142 rows whose LINC yields no roll.

---

## The biggest open analytical issue

**53% of vacant-coded sales are really improved sales**, and the land
charts still include them.

Splitting the 14,018 vacant-coded sales by construction-permit timing:

| Permit vs sale | n | median price | median $/lot-sf |
|---|---|---|---|
| 6+ months before | 7,451 | $427,000 | ~$105 |
| 1–5 mo before / at / after / none | 6,567 | $133k–$175k | $26–$30 |

A 3x step, not a gradient. Those 7,451 are new-subdivision houses sold
while the roll still said vacant. The `built` column flags them, but
`charts.html` does not yet exclude them, so the land trend is pulled
upward by houses. **The fix Jason has not yet approved:** default the
charts to exclude `_buildVerdict === 'already-built'`, leaving ~6,500
genuine land sales.

---

## Decisions that will silently regress if you don't know them

Carrying forward the 08-06 list (never `gh release upload --clobber`;
revert the checksum only if the archive is not live; decide from a re-read
not an exit code; "unknown" is a third outcome; every `CN*`/`RES*` code
must be classified; `generated_at` means when the DATA changed; `.ps1`
files stay 7-bit ASCII) — all still true. New across 08-19/08-20:

1. **The two sources do not date the same sale the same way.** MLS is the
   firm/accepted offer; SABRE is registration. Across 1,032 MLS rows they
   agree on a date exactly ZERO times, while prices match exactly — MLS
   runs 3–8 weeks earlier. `collapseCrossSource` fuses on roll + identical
   price within 120 days; SABRE keeps the sale date and the instrument,
   MLS donates what SABRE lacks. **A differing price is left as two rows**
   — fusing on a guess would invent a transaction.
2. **`rowSignature` must normalize the date cell.** SABRE exported July
   2022 twice, once ISO and once MM-DD-YYYY. Raw-cell comparison called
   217 identical rows distinct, doubling that month AND doubling living
   area on every sale in it, silently. Regression-tested.
3. **The $/Bldg SF live fallback is withheld on vacant-coded sales.** The
   live record describes the parcel TODAY; a lot that sold bare and was
   later built on would otherwise be handed the new building's area and
   report a confident, fictional rate. Found in QA, regression-tested.
4. **Far-flung fails OPEN on an unmeasurable span** — the one deliberate
   inversion of `salesFilters.js`'s "missing is excluded" rule, because
   that filter REMOVES comps rather than narrowing to them.
5. **The Sale/Asmt cap was removed on Jason's instruction** — a sale at
   115% of assessment is an ordinary market sale, so a cap offering ≤ 0.5
   stripped good comps. The Sale/Asmt COLUMN stays. **Do not re-add the
   filter** from MB's inventory.
6. **The `$/Lot SF` RANGE filter stays removed** (long-standing). The
   far-flung ⚠ rides on that COLUMN, which is not the same thing.
7. **Vacancy is the V PREFIX plus `CNVAC`**, not a fixed list, so a code
   the City adds later needs no code change.
8. **`mergeSalesFiles` can no longer throw on a bad header** (two schemas
   make that impossible); a file that parses to nothing is named in
   `unreadable` instead. Don't "restore" the throw.
9. **Subscriber data never leaves the browser.** SABRE/MLS live in
   IndexedDB and a local folder; their coverage renders only in the sales
   panel, never in the public Data Status dialog, never in a hosted file.

---

## Deliberate divergences from the Manitoba sibling app

Do not "fix" these back during a parity sweep: no `vacant-threshold`
(Winnipeg classifies vacancy directly in the use code); the Sale/Asmt cap
is gone entirely; far-flung ships with **no default threshold** (MB's
calibrated 30 km came off rural portfolio sales and would never fire
inside a city roughly that wide); the charts are Winnipeg-specific LAND
charts, not MB's Land-rates / Total-price tabs.

---

## Known gaps

- **142 Winnipeg commercial MLS sales have no usable LINC** and are
  skipped. They carry an address and lat/long, so an address→roll lookup
  against `d4mq-wa44` would likely recover most. Not built; not asked for.
- **~135 same-roll, near-date MLS/SABRE pairs with DIFFERENT prices** stay
  unfused by design. Worth an eyeball to confirm they are genuinely
  separate transactions rather than a price-basis difference.
- **August 2026 is partial** (20 sales, latest 2026-08-05) — SABRE
  recording lag, not a gap.
- Two things **still need Jason's real browser** (the in-app pane cannot
  composite MapLibre): the Generate Map PNG with the legend drawn in, and
  the Chrome `showDirectoryPicker` folder-connect path. The layout maths,
  the legend scraping and the `webkitdirectory` fallback are all verified.
- Historical shards still pin `eca2c00` (2026-07-01 data).

---

## Environment gotchas that cost real time

Carried forward and still true: the in-app Browser pane cannot render this
map (use Claude in Chrome); Bash here is Git Bash, so PowerShell
here-strings fail — use a heredoc and `git commit -F -`; run `.ps1` by
ABSOLUTE path; `r2.dev` does not answer HEAD usefully. New:

- **Writing JS through a heredoc mangles escapes.** `\n` inside a
  generated string becomes a real newline and `\uFEFF` becomes a literal
  BOM, producing unparseable files. Build such characters with
  `String.fromCharCode`, or use a placeholder you substitute afterwards.
- **`index.html` and several `.js` / `.md` files are CRLF.** A patch
  script must normalize to LF, edit, then restore CRLF, or every anchor
  misses.
- The map gives up after 5 minutes in the in-app pane ("layer setup never
  succeeded"), which kills that page session — a sales run that then
  returns 0 rows is the environment, not a regression. Reload and re-test
  before believing it.

---

## Working style (Jason)

Direct/technical, no preamble. Commit + push when he says (main = deploy).
Concrete numbers over hand-waving; verify by execution against real data,
not fixtures. He will interrupt mid-task to redirect — finish the
in-flight piece, then take the new one. He is an appraiser: when a result
is ambiguous, the question he wants answered is "what should I do with
this row", not "what does this field contain".
