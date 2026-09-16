# Session handoff — 2026-09-16

Everything below is **shipped and live** unless a line says otherwise. Read
`README.md` for how a feature works; this file is only what changed today, why,
and what is still open.

Commits: `dc162e9` … `992f88d` in this repo, plus `a76afce` / `bcd997e` in
`../../MBOpenData/mao-scrape`. All pushed.

---

## Sales Analysis — the panel now has two halves

Search and Clear sit on a divider row. **Above** it: sale date, vacant/improved,
nominal transfers — everything that decides what a search FETCHES. **Below**:
neighbourhood, category, PUCS, class, zoning, year built, building size,
Additional filters — all of which re-filter what is already loaded, instantly.

Which side a filter falls on is a real distinction, not a layout choice:

- **Pre-fetch:** sale date, PUCS, sale price, lot size, street, N1, sale type.
- **Post-join:** category, neighbourhood, class, zoning, year built, building
  size, far-flung, subject radius — each reads something that does not exist
  until the live record is in hand.

**Year built and building size are post-join ON PURPOSE** (an earlier pass cut
them pre-fetch and was reverted). They read a dual source — the export's value
when it has one, the live record otherwise — and they are the two an appraiser
TUNES, so a pre-fetch cut would put a `d4mq-wa44` round trip behind every nudge
of a bound.

Search still merges and parses the WHOLE archive out of IndexedDB before any
filter runs. The pre-fetch cuts save the round trip and the row draw, not the
CSV read.

## Sale type: Improved split in two

`All Sales` / `Vacant Land Only` / `Improved – Res/Apt` / `Improved – Non-Res/Mixed`.

Res = any `RES*` code **except** `RESMU`, `RESPL`, `RESGC` (mixed-use and group
care, which merely start with RES), **plus** `CNAPT`, `CNRES`, `CNDRH`.

One non-residential parcel types the whole sale non-residential, mirroring "one
improved parcel makes it improved". Vacant and blank parcels do NOT type a sale.

**A sale with no use code on any parcel now passes EVERY mode.** That inverts
the missing-is-excluded rule the rest of `salesFilters.js` follows, deliberately
and only here.

## Neighbourhood (the 23 clusters)

Labelled "neighbourhood" in the UI; the code, the data and the grid column keep
`cluster`, and the CSV header stays `Cluster`.

Always drawn on the Sales tab. **Everything starts selected and clicking
DESELECTS** — identical to the checkboxes, so the map and the popover are one
control with one state. Nothing selected = no results, and the count line says
so and names the way back.

`(no cluster)` is now filled in by two fallbacks and split into two buckets:

- nearest **boundary** within 1 km (not centroid, not nearest vertex)
- then the sale's street address via `cam2-ii3u`, one request per STREET, capped
  at 40 streets
- what neither can place → `(outside Winnipeg)` if it has a real coordinate too
  far out (typically a bad MLS row), `(no cluster)` if there is nothing to place
  it with

## Map colours

Sales publish as points as well as polygons: circles at city zoom, crossfading
to parcel shapes over z13–15. Coloured by category, assignment follows the
current search, and it is **sticky** — a category keeps its colour while it is
on screen.

**Five colours plus grey is a measured ceiling, not a preference.** A map is an
all-pairs case; run through the dataviz validator at `--pairs all`, thirteen
colours fails at normal-vision ΔE 7.1 and six at 14.4, against a floor of 15.
Green is absent because every failing pair at six involved it.

## Also shipped

- **Save / Load search** as a commented `.yml`. Tri-state multi-selects are
  spelled `all` / `none` / list; roll numbers are quoted so leading zeros
  survive. A selection restored before any sales are loaded is HELD until the
  options exist.
- **Subject roll + radius** on one row (70/30), `≤` as the label, and the radius
  draws a real dashed circle on the map, walking the same sphere the filter
  measures on.
- **Building charts** (Land / Buildings switch): $/Bldg SF over time, by year
  built, by building size.
- **Popup** carries Year Built, Living Area, Sale Date, Sale Price, and $/Bldg SF
  — or $/Lot SF + $/Acre when the category is Land. Hover and click share one
  builder.
- **PUCS options name their codes** and count from what the OTHER filters left;
  every code stays listed even at zero.
- **Export CSV** on the Sales tab (it always wrote all fields; it was just
  unreachable from that tab).
- Citywide parcel lines darkened to gray-500 — a **deliberate MB divergence**.

---

## Open / unverified

1. **Map colours have never been seen rendering.** The Browser pane stopped
   compositing partway through the session. Expressions were validated against
   `@maplibre/maplibre-gl-style-spec` and the wiring asserted statically, but
   the dots, the crossfade and the colours themselves want an eye. Same for the
   darker parcel lines.
2. **The category fill rides at 30% opacity**, and `map.js` carries a standing
   note that a 30% fill is a poor carrier for a colour cue. If the shapes read
   washed out up close, move the colour to the OUTLINE.
3. **Address fallback is capped at 40 streets a run** — a full-archive load with
   thousands of unmatched rolls will place a subset. `CLUSTER_ADDRESS_STREET_CAP`.
4. **Five colours may be too few.** The honest way past it is a second channel
   (filled dot vs ring = 10 classes on the same five hues), not more hues.

## The N1 crosswalk (other repo)

`n1_match_wpg.R` now reads the **synced database** `C:\N1Sync\n1_records.sqlite`,
not the hand-dropped spreadsheets. It had been matching 1,572 Winnipeg records
against the database's 9,698; the switch took the crosswalk 1,033 → 1,845 rows.

**Point ParcelSearch at `mao-scrape\results\sales_search\wpg_stamped` and ONLY
that folder** — the raw `WpgOpenData\SABRE` folder has no `N1 ID` column, and
connecting both imports every sale twice.

Drivers: `n1-wpg-update.bat` (runs and exits), `n1-wpg-review.bat` (serves the
queue). 166 records are awaiting review across 2019–2026.
