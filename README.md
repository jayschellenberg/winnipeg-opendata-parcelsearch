# Winnipeg Open Data Parcel Search

A firm-facing web tool for researching City of Winnipeg properties — search by legal description (Lot / Block / Plan / Description), Roll #, civic address, zoning code, or dwelling-unit count, with results enriched live from five Winnipeg Open Data sources and rendered on a MapLibre interactive map. Two parcel layers (legal-survey + tax-assessment) sit alongside four toggleable policy overlays, an area-weighted zoning analysis, dimension labels at lot scale, and one-click links into Manitoba Assessment Online, Walk Score, and the sister Manitoba flood-mapping tool.

## Live site

[winnipeg-opendata-parcelsearch.vercel.app](https://winnipeg-opendata-parcelsearch.vercel.app/)

## What's in this repo

| Path | Purpose | Audience |
|---|---|---|
| `web/` | Vite + vanilla JS static site. Queries Winnipeg Open Data's Socrata API live on every search. Deployed to Vercel. | Firm colleagues |
| `r/download_parcels.R` | Downloads the latest Survey + Assessment Parcels datasets as GeoPackages. | Local archive |
| `r/cross_reference_parcels.R` | Offline spatial join — builds `ParcelCrossRef_YYYYMMDD.csv`. | Local archive |
| `r/parcel_search_app.R` | R Shiny app with a snapshot-picker dropdown for searching dated `.gpkg` archives. Used for historical (pre-subdivision) lookups. | Personal use |
| `extras/` | Experimentation files. | — |
| `REPLICATION_GUIDE.md` | Step-by-step guide for adapting this tool to another jurisdiction. | Anyone replicating |

## Data sources

All data is queried live from `data.winnipeg.ca` — no copies are shipped with the bundle, results are always against current published data. The citywide zoning dataset is cached in IndexedDB for 7 days for performance, but every parcel search is live.

| Dataset | ID | Used for |
|---|---|---|
| [Map of Survey Parcels](https://data.winnipeg.ca/City-Planning/Map-of-Survey-Parcels/tira-k3hi) | `sjjm-nj47` | Lot / Block / Plan / Description (262K legal subdivision lots) |
| [Map of Assessment Parcels](https://data.winnipeg.ca/Assessment-Taxation-Corporate/Map-of-Assessment-Parcels/7shc-stst) | `d4mq-wa44` | Roll number, primary address, zoning text, dwelling units, total assessed value, link to assessment record (245K parcels) |
| [Addresses](https://data.winnipeg.ca/City-Planning/Addresses/cam2-ii3u/about_data) | `cam2-ii3u` | 243K official civic addresses with point geometry — used to find parcels by *any* of their civic addresses, and to display the full address list per parcel |
| [Zoning By-law Parcels](https://data.winnipeg.ca/City-Planning/City-of-Winnipeg-Zoning-By-law-Parcels-and-Zoning-/dxrp-w6re/about_data) | `dxrp-w6re` | Citywide zoning overlay (18K polygons) + area-weighted top-2 zoning analysis per parcel |
| [OurWPG Precinct](https://data.winnipeg.ca/City-Planning/OurWPG-Precinct/xh28-4smq) | `xh28-4smq` | Secondary Plans overlay — new-community precincts |
| [OurWPG Major Redevelopment Site](https://data.winnipeg.ca/City-Planning/OurWPG-Major-Redevelopment-Site/piz6-n3at) | `piz6-n3at` | Secondary Plans overlay — major-infill redev sites |
| [OurWPG Mature Community](https://data.winnipeg.ca/City-Planning/OurWPG-Mature-Community/5guk-f7xw) | `5guk-f7xw` | Infill Guideline Area overlay |
| [OurWPG Regional Mixed Use Centre](https://data.winnipeg.ca/City-Planning/OurWPG-Regional-Mixed-Use-Centre/wv32-jdtk) | `wv32-jdtk` | Malls and Corridors PDO overlay (the "malls" half) |
| [OurWPG Urban Mixed Use Corridor](https://data.winnipeg.ca/City-Planning/OurWPG-Urban-Mixed-Use-Corridor/t4kh-5gtd) | `t4kh-5gtd` | Malls and Corridors PDO overlay (urban corridors) |
| [OurWPG Regional Mixed Use Corridor](https://data.winnipeg.ca/City-Planning/OurWPG-Regional-Mixed-Use-Corridor/ahzi-uwu2) | `ahzi-uwu2` | Malls and Corridors PDO overlay (regional corridors) |

The City has **42 adopted Local Area / Secondary Plans** (per the [Long Range Planning index](https://winnipeg.ca/node/44825)), but Open Data only publishes boundaries for 16 of them (5 Precincts + 11 Major Redev Sites). The Secondary Plans popup links to the City's full plan list so users can look up plans the overlay can't render.

## What the web app does

**Two search directions, both surface the same parcels.**

- **Assessment-first flow** — fill any of *Roll # / Address / Zoning / DU mode*. Queries Assessment Parcels by attribute and cross-references the Addresses dataset, so a search for "440 Hargrave" finds the parcel even when the assessment dataset's primary address is "400 Hargrave Street". Survey Parcels back-fill the Lot / Block / Plan columns.
- **Legal-description flow** — fill any of *Lot / Block / Plan / Description*. Queries Survey Parcels by attribute, then back-fills the Roll #, address, zoning, dwelling units, total assessed value, and Manitoba Assessment Online link.

The map supports **two parcel layers**, which can be shown together or separately:

- **Blue** = Survey parcels (legal lots from Land Titles)
- **Red** = Assessment parcels (tax-assessed properties — building/roll footprints)

Assessment parcels are visible by default; Survey parcels start hidden and can be turned on with **Show Survey** when the blue legal-lot outlines are useful. The two don't always 1:1 align — one assessment roll can cover many survey lots (e.g. 400 Hargrave covers 20+ downtown lots) and one survey lot can be split between multiple rolls (e.g. a duplex). The table merges either side into one row with the lot list grouped by plan and "(partial)" suffixes for split lots.

## Sidebar layout

The page uses a two-pane layout with a **320 px sticky left sidebar** holding every control, grouped into sections:

- **Survey vs Assessment explainer** (collapsible)
- **Search by assessment** — Roll #, Address, Zoning, DU mode + min input
- **Search by legal description** — Lot, Block, Plan, Description
- **Search · Clear · Export CSV** action row + result count chip
- **Map overlays** — compact buttons and links in a 2-column grid:
  - Show Survey / Hide Assessment (Survey off, Assessment on by default)
  - Show Zoning (citywide colour-coded overlay; first toggle ~10–15 s, instant after)
  - Show Secondary Plans (Precincts + Major Redev sites)
  - Show Infill Area (Mature Community boundaries)
  - Show Malls/Corridors (Regional Centres + Urban + Regional Corridors)
  - Show Dimensions (lot edge lengths in feet, zoom ≥ 17)
- **River-Lots / Outer-Two-Mile / Section-Township-Range hint** (collapsible)

The right pane holds the responsive 16:9 map, the results table, the captured Screenshot Map output, and the disclaimer. Below 980 px viewport the layout collapses to a single column for tablets.

## Map features

- **Streets ⇄ Satellite** basemap toggle in the top-right gutter (Esri World Imagery, no API key)
- **Floating zoning legend** — category list appears on the map only when zoning is on
- **Combined hover popup** — when hovering on a survey lot inside an assessment parcel, both parcel info blocks show stacked under colour-coded headers
- **Click any visible parcel layer (blue or red)** → scrolls to the matching row in the results table
- **Click any results table row** → flies the map to that parcel
- **Lot dimensions** (toggleable) — survey-lot edges labelled in feet at zoom ≥ 17, deduplicated across shared edges
- **Screenshot Map** — captures the current view as a PNG with attribution composited, for dropping into reports

## Results table columns

Every column is sortable; default sort is Roll Number ascending.

| Column | Source |
|---|---|
| Lot / Block / Plan / Description | Survey Parcels (merged & range-collapsed for multi-lot parcels) |
| Roll Number / Full Address | Assessment Parcels (Address column shows every civic address per parcel — primary first, others alphabetical) |
| Zoning | Top-1 zoning code by area-weighted polygon intersection |
| % | Coverage of the top-1 zone |
| Zoning 2 | Second zone if its coverage is ≥ 1%, with `(NN%)` suffix |
| Lot Size (sf) | Assessment Parcels `assessed_land_area` |
| Lat / Lon | Assessment Parcels centroid |
| Assess-{year} | Total Assessed Value as a clickable link to `winnipegassessment.com`. Header year is the most-common `current_assessment_year` in the result set |
| Walkscore | External link to `walkscore.com` for the address |
| Flood | Deep-link into the sister [Manitoba flood-mapping tool](https://mb-flood-mapping.vercel.app/) |

CSV export includes every column plus the raw URLs for the link columns, and raw numeric values (so spreadsheet sorts work).

## Web app architecture

The site is pure static — Vercel serves the Vite-built bundle. The browser makes its own SODA queries directly to `data.winnipeg.ca` (CORS open, no proxy needed). A typical search fires several queries in parallel and merges them client-side:

1. **Attribute query** — Survey Parcels by Lot/Block/Plan, or Assessment Parcels by Roll/Address/Zoning/DU.
2. **Address cross-reference** (when Address is filled) — `cam2-ii3u` to find parcels containing every civic-address point matching the search text.
3. **Spatial enrichment** — per-feature `within_box` queries against the *other* parcel dataset (assessment-side for legal flow, survey-side for assessment flow). Batched 50 clauses per request, parallel.
4. **Civic-address enrichment** — per-parcel `within_box` against `cam2-ii3u`, attaching the full address list to each result.
5. **Top-2 zoning enrichment** — for each result, intersects the parcel polygon against zoning polygons (cache-warm: in-memory; cache-cold: per-parcel `within_box`) and computes top-2 area-weighted coverage with `@turf/intersect` + `@turf/area`.
6. **Partial-lot detection** (assessment flow) — second pass to count overlapping assessments per survey lot; lots overlapping >1 are flagged "(partial)".

All spatial filters use `within_box` with a 150 m bbox pad (because Socrata's `within_box` requires *containment*, not intersection — see the bug catalogue in `REPLICATION_GUIDE.md`). Client-side `parcelsOverlap` (bidirectional centroid-in-polygon) re-checks every match to eliminate false positives from neighbouring parcels.

**IndexedDB caching.** The citywide zoning dataset (~13.5 MB gzipped, ~42 MB parsed) is cached under `wpsCache` for 7 days. First Show Zoning toggle: ~10–15 s. Subsequent toggles within 7 days: instant. Per-search top-2 zoning enrichment also reads the cache opportunistically — every search after the first ever zoning toggle becomes faster too.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — the map (no API key, CartoDB Positron + Esri World Imagery raster tiles)
- `@turf/bbox`, `@turf/boolean-intersects`, `@turf/boolean-point-in-polygon` — spatial primitives for the parcel join
- `@turf/intersect`, `@turf/area` — area-weighted zoning analysis

No backend, no database, no precomputed data, no scheduled jobs.

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

The build output goes to `web/dist/` (gitignored). Vercel runs the same command on every push to `main`.

Optional Socrata app token (raises the anonymous rate limit from 1,000 to 100,000 requests/hour):

1. Register at https://data.winnipeg.ca/profile/edit/developer_settings
2. Add `VITE_SODA_APP_TOKEN=<token>` as a Vercel project environment variable
3. Redeploy

`web/src/soda.js` already reads `import.meta.env.VITE_SODA_APP_TOKEN`.

## Running the R tools locally

Prerequisites: R 4.5+ and the packages `sf`, `shiny`, `leaflet`, `DT`.

```r
# From the repo root in R or RStudio:
source("r/download_parcels.R")          # downloads current .gpkg snapshots
source("r/cross_reference_parcels.R")   # builds ParcelCrossRef_*.csv
shiny::runApp("r/parcel_search_app.R")  # interactive search on the local archive
```

The Shiny app discovers every `SurveyParcels_YYYYMMDD.gpkg` in the project directory and exposes a snapshot-picker dropdown — pick any dated snapshot to run searches against it. This is the one thing the live web app *cannot* do: search how parcels looked before later subdivisions or consolidations. To build the archive, re-run `download_parcels.R` periodically (e.g. quarterly); each run produces a fresh dated `.gpkg` pair without overwriting the older ones. Each snapshot adds about 590 MB of disk; older ones can be pruned manually if storage gets tight.

## Known caveats

- The R scripts hardcode an absolute path (`D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch`). To run elsewhere, update the `data_dir` / `output_dir` variable at the top of each script.
- `.gpkg` and `ParcelCrossRef_*.csv` files are gitignored — too large for GitHub (~485 MB Survey + ~108 MB Assessment per snapshot) and trivially regenerable.
- The web app requires internet access and shows current data only. For offline use or historical snapshots, use the R Shiny app against the local archive.
- The `LIKE` operator in SoQL is case-sensitive; the web app wraps every search column and search term in `upper()` so typing "monarch" matches "10 MONARCH MEWS".
- 26 of the City's 42 adopted Local Area Plans don't have boundaries published on Open Data. The Secondary Plans overlay covers what's available (16 polygons); the popup links to the City's full list for the rest.
- Lot dimensions are computed from WGS84 polygon edges via the haversine formula and reported in feet. The City's Open Data stores some attributes in metres but `assessed_land_area` is in square feet, so the tool stays consistent on imperial throughout. Manitoba real-estate / Land Titles / appraisal practice is overwhelmingly in feet.

## Replicating this for another jurisdiction

See [REPLICATION_GUIDE.md](REPLICATION_GUIDE.md) for a step-by-step adaptation guide — what to probe, what to swap, every gotcha already solved, and the architectural patterns that translate to other Socrata or ArcGIS REST portals.
