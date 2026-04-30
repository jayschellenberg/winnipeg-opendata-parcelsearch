# Winnipeg Open Data Parcel Search

A firm-facing web tool for searching City of Winnipeg parcel data — by legal description (Lot / Block / Plan), by Roll #, by civic address, or by zoning code — with results drawn on an interactive MapLibre map. Plus the R scripts used to build a local quarterly archive for historical pre-subdivision lookups.

## Live site

[winnipeg-opendata-parcelsearch.vercel.app](https://winnipeg-opendata-parcelsearch.vercel.app/)

## What's in this repo

| Path | Purpose | Audience |
|---|---|---|
| `web/` | Vite + vanilla JS static site. Queries Winnipeg Open Data's Socrata API live on every search. Deployed to Vercel. | Firm colleagues |
| `r/download_parcels.R` | Downloads the latest Survey Parcels and Assessment Parcels datasets as GeoPackages. | Local archive |
| `r/cross_reference_parcels.R` | Offline spatial join between Survey and Assessment Parcels — builds `ParcelCrossRef_YYYYMMDD.csv`. | Local archive |
| `r/parcel_search_app.R` | R Shiny app that searches the **local** archive. Used for historical (pre-subdivision) lookups. | Personal use |
| `extras/` | Experimentation files and sample queries. | — |
| `REPLICATION_GUIDE.md` | Step-by-step guide for adapting this tool to another jurisdiction (Manitoba Open Data, another municipality, etc.). | Anyone replicating |

## Data sources

All data is queried live from the City of Winnipeg Open Data portal (`data.winnipeg.ca`) — no copies are shipped with the site, so search results are always current.

| Dataset | ID | Used for |
|---|---|---|
| [Map of Survey Parcels](https://data.winnipeg.ca/City-Planning/Map-of-Survey-Parcels/tira-k3hi) | `sjjm-nj47` | Lot / Block / Plan / Description (legal subdivision lots) |
| [Map of Assessment Parcels](https://data.winnipeg.ca/Assessment-Taxation-Corporate/Map-of-Assessment-Parcels/7shc-stst) | `d4mq-wa44` | Roll number, primary address, zoning, assessed area, centroid |
| [Addresses](https://data.winnipeg.ca/City-Planning/Addresses/cam2-ii3u/about_data) | `cam2-ii3u` | Every official civic address with a point geometry — used to find parcels by *any* of their civic addresses, and to display the full set of addresses per parcel |
| [Zoning By-law Parcels](https://data.winnipeg.ca/City-Planning/City-of-Winnipeg-Zoning-By-law-Parcels-and-Zoning-/dxrp-w6re/about_data) | `dxrp-w6re` | Optional toggleable colour overlay showing zoning districts and codes |

## What the web app does

**Two search directions, both surface the same parcels.**

- **Legal-description flow** — fill any of *Lot / Block / Plan / Description*. Queries Survey Parcels by attribute, then back-fills the matching Assessment Parcels (and their civic addresses) so you see roll number, address, and zoning beside each lot.
- **Assessment-first flow** — fill any of *Roll # / Address / Zoning*. Queries Assessment Parcels by attribute *and* cross-references the Addresses dataset so a search for "440 Hargrave" finds the parcel even though its primary assessment address is "400 Hargrave Street". Survey Parcels are then back-filled to populate the Lot / Block / Plan columns.

In both flows, the map shows **two layers simultaneously**:

- **Blue** = Survey parcels (legal lots from Land Titles)
- **Red** = Assessment parcels (tax-assessed properties — building/parcel footprints from City taxation)

The two layers don't always 1:1 align — one assessment roll can cover many survey lots (e.g. a downtown building spanning 20 original lots), and one survey lot can be split between multiple rolls (e.g. a duplex). The table merges either side into one row with the lot list grouped by plan and "(partial)" suffixes for lots that span more than one assessment.

## UX features

- **Sortable columns** — click any header to sort. Default sort is by Roll # ascending.
- **CSV export** of the current results.
- **Map ↔ Table linkage** — click any polygon (blue or red) to scroll to its row; click any row to fly the map to that parcel.
- **Combined hover popup** — hovering on a survey lot inside an assessment parcel shows both blocks of info (legal + roll/address/zoning) in a single popup.
- **Layer toggles** — Hide Survey / Hide Assessment / Show Zoning buttons in the controls bar.
- **Floating legend** in the bottom-right of the map.
- **Top-of-page explainer** — one-click open describing what survey vs assessment parcels are.
- **Multi-address parcels** — parcels with multiple civic addresses display all of them in the Address column (e.g. "400 HARGRAVE STREET, 440 HARGRAVE ST"), making them findable from any direction.
- **Zoning overlay** — toggle on to see zoning districts (R1-M, C2, etc.) coloured by category, with click-popups showing the full description from the by-law.
- **Clear button = full page reload** — bulletproof reset of every piece of state.

## Web app architecture

The site is pure static — Vercel just serves the Vite-built bundle. The browser makes its own SODA queries directly to `data.winnipeg.ca` (the API sets `Access-Control-Allow-Origin: *` so no proxy is needed).

A typical search fires several SODA calls in parallel and merges them client-side:

1. **Attribute query** — Survey Parcels by Lot/Block/Plan or Assessment Parcels by Roll/Address/Zoning, depending on the filled fields.
2. **Address cross-reference** (when the address field is filled) — `cam2-ii3u` to find parcels containing every official civic address matching the search text.
3. **Spatial enrichment** — per-feature `within_box` queries against the *other* parcel dataset to get the cross-side data (legal descriptions for an assessment search, roll/address for a legal search). Batched 50 clauses per request, parallel.
4. **Civic-address enrichment** — `cam2-ii3u` per-parcel `within_box` to gather every civic address falling inside each result parcel.
5. **Partial-lot detection** (assessment flow only) — second pass against `d4mq-wa44` to count how many assessment parcels each survey lot overlaps; lots that span >1 are flagged "(partial)".
6. **Zoning overlay** (when toggled on) — `dxrp-w6re` per-parcel `within_box` to fetch zoning polygons covering the result area.

All spatial joins are then re-checked client-side with turf.js (`booleanPointInPolygon`) to filter false positives that come from the bbox-padded SODA filter. The bidirectional `parcelsOverlap` check (assessment-centroid-in-survey OR survey-bbox-center-in-assessment) handles both 1-to-many and many-to-1 cases correctly.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — the map (no API key required, uses CartoDB Positron raster tiles)
- `@turf/bbox` — bounding boxes
- `@turf/boolean-intersects` — defensive fallback when centroids are missing
- `@turf/boolean-point-in-polygon` — the primary client-side join check

No backend, no database, no precomputed data, no quarterly rebuild.

## Running the web app locally

Prerequisites: Node.js 18+ and npm.

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173. No local data needed — the dev server queries live Winnipeg Open Data on every search.

To build for production:

```bash
npm run build
```

The build output goes to `web/dist/` (`.gitignored`). Vercel runs the same command on every push to `main`.

Optional Socrata app token (raises the anonymous rate limit from 1,000 to 100,000 requests/hour, useful if firm usage ever ramps up):

1. Register at https://data.winnipeg.ca/profile/edit/developer_settings
2. Add `VITE_SODA_APP_TOKEN=<token>` as a Vercel project environment variable
3. Redeploy

`web/src/soda.js` already reads `import.meta.env.VITE_SODA_APP_TOKEN` — no code change needed.

## Running the R tools locally

Prerequisites: R 4.5+ and the packages `sf`, `shiny`, `leaflet`, `DT`.

```r
# From the repo root in R or RStudio:
source("r/download_parcels.R")          # downloads current .gpkg snapshots
source("r/cross_reference_parcels.R")   # builds ParcelCrossRef_*.csv
shiny::runApp("r/parcel_search_app.R")  # interactive search on the local archive
```

The Shiny app discovers every `SurveyParcels_YYYYMMDD.gpkg` in the project directory and exposes a snapshot picker dropdown — pick any dated snapshot to run searches against it. This is the one thing the live web app *cannot* do: search how parcels looked before later subdivisions or consolidations. To build the archive, re-run `download_parcels.R` periodically (e.g. quarterly); each run produces a fresh dated `.gpkg` pair without overwriting the older ones. Each snapshot adds about 590 MB of disk; older ones can be pruned manually if storage gets tight.

## Known caveats

- The R scripts hardcode an absolute path (`D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch`). To run elsewhere, update the `data_dir` / `output_dir` variable at the top of each script.
- `.gpkg` and `ParcelCrossRef_*.csv` files are gitignored — too large for GitHub (the full Survey Parcels GeoPackage is ~485 MB) and trivially regenerable.
- The web app requires internet access and shows current data only. For offline use or historical snapshots, use the R Shiny app against the local archive.
- The `LIKE` operator in SoQL is case-sensitive; the web app wraps every search column and search term in `upper()` so typing "monarch" matches "10 MONARCH MEWS". Document this if you ever swap to a different SoQL dialect.

## Replicating this for another jurisdiction

See [REPLICATION_GUIDE.md](REPLICATION_GUIDE.md) for a step-by-step adaptation guide — what to probe, what to swap, every gotcha already solved.
