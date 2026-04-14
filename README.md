# Winnipeg Open Data Parcel Search

A firm-facing web tool for searching City of Winnipeg parcel data by legal description (plan, lot, block) and viewing results on an interactive map — plus the R scripts used to build a local quarterly archive for historical pre-subdivision lookups.

## Live site

_Pending Vercel deployment — URL will go here._

## What's in this repo

| Path | Purpose | Audience |
|---|---|---|
| `web/` | Vite + vanilla JS static site. Queries the Winnipeg Open Data Socrata API live on every search. Deployed to Vercel. | Firm colleagues |
| `r/download_parcels.R` | Downloads the latest Survey Parcels and Assessment Parcels datasets as GeoPackages. | Local archive |
| `r/cross_reference_parcels.R` | Offline spatial join between Survey and Assessment Parcels — builds `ParcelCrossRef_YYYYMMDD.csv`. | Local archive |
| `r/parcel_search_app.R` | R Shiny app that searches the **local** archive. Used for historical (pre-subdivision) lookups. | Personal use |
| `extras/` | Experimentation files and sample queries. | — |

## Data source

All data comes from City of Winnipeg Open Data:

- [Map of Survey Parcels](https://data.winnipeg.ca/City-Planning/Map-of-Survey-Parcels/tira-k3hi) — dataset ID `sjjm-nj47`
- [Map of Assessment Parcels](https://data.winnipeg.ca/Assessment-Taxation-Corporate/Map-of-Assessment-Parcels/7shc-stst) — dataset ID `d4mq-wa44`

The web app queries both datasets live via the Socrata SODA API — no data files are shipped with the site, and data is always current.

## Web app architecture

The web app is a pure static site. Every search makes exactly two HTTP requests directly from the browser to `data.winnipeg.ca`:

1. **Survey Parcels query** — attribute filter on plan / lot / block / description, returns matching survey parcels with geometry.
2. **Assessment Parcels query** — spatial `within_box` filter using the bounding box of the survey matches, returns assessment parcels (roll number, address, zoning) in that area.

The client then performs an exact polygon-intersection join using turf.js to attach roll number, full address, and zoning to each matched survey parcel. No backend, no database, no precomputed data.

## Running the web app locally

Prerequisites: Node.js 18+ and npm.

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173. No local data needed — the app queries the live Winnipeg Open Data API.

To build for production:

```bash
npm run build
```

## Running the R tools locally

Prerequisites: R 4.5+ and the packages `sf`, `shiny`, `leaflet`, `DT`.

```r
# From the repo root in R or RStudio:
source("r/download_parcels.R")           # downloads current .gpkg snapshots
source("r/cross_reference_parcels.R")    # builds the ParcelCrossRef_*.csv
shiny::runApp("r/parcel_search_app.R")   # interactive search on the local archive
```

The Shiny app reads the most recent `SurveyParcels_YYYYMMDD.gpkg` in the project directory, so it lets you search against whichever snapshot you have locally — including older ones for pre-subdivision lookups that the live web app can't do.

## Known caveats

- The R scripts currently hardcode an absolute path (`D:/Dropbox/Appraisal/Maps/Winnipeg/OpenData`) in their configuration. To run them elsewhere, update the `data_dir` / `output_dir` variable at the top of each script.
- The `.gpkg` and `ParcelCrossRef_*.csv` files are gitignored — they're too large for GitHub (the full Survey Parcels GeoPackage is ~485 MB) and are regenerable via `r/download_parcels.R`.
- The web app requires internet access and shows **current** data only. For offline use or historical snapshots, use the R Shiny app against your local archive.
