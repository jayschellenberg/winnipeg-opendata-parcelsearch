# Retired R files

## `parcel_search_app.R` and `cross_reference_parcels.R`

Retired 2026-06-11. Both ran together as a local-only fallback for
attribute-searching dated `.gpkg` snapshots before the web app gained
its Historical (as-of-date) overlay. They are kept here for archive
value only — they no longer run because `scheduled_download.ps1`
cleans the repo-dir `.gpkg` files after archiving them into
WpgSnapshots.

### What they did

- `cross_reference_parcels.R` built `ParcelCrossRef_YYYYMMDD.csv` from
  the most recent pair of `.gpkg` snapshots — a lean Survey × Assessment
  spatial-join lookup keyed by Roll # / Survey ID.
- `parcel_search_app.R` (Shiny) let you pick a dated snapshot and
  search by partial legal description (Plan / Lot / Block / Description),
  joining roll/address/zoning from the cross-ref CSV.

### What replaced them

The web app's **Historical** overlay covers the *browse-by-location*
use case: pick a snapshot date in the sidebar, pan the map, and see
parcels + survey lots as they were on that date with size-change
highlighting and lineage. See `web/src/main.js` (search "Historical
(as-of-date) overlay") and `r/build_historical_shards.R`.

### The remaining gap, and how to plug it

The web overlay browses by *location*; the Shiny app could search by
*legal description text* (e.g. "find Plan 1234 in the 2023 snapshot
without knowing where it is"). If that comes up, query the archived
`.gpkg` directly:

```r
sf::st_read(
  "D:/Dropbox/Appraisal/Web/WpgSnapshots/2023/SurveyParcels_20231113.gpkg",
  query = "SELECT * FROM survey_parcels WHERE plan LIKE '%1234%'"
)
```

The provenance sidecar (`.meta.json` next to the gpkg) names the
source-of-record for citing in an appraisal.
