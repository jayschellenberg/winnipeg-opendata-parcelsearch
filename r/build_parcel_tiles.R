# build_parcel_tiles.R
# Build a citywide-parcels vector-tile archive for the web tool's
# "Show All Parcels" overlay.
#
# Pipeline:
#   1. Page through every Assessment Parcel from data.winnipeg.ca
#      (d4mq-wa44) and write the result to a flat GeoJSON file.
#   2. Hand that GeoJSON to `tippecanoe` to produce a single
#      web/public/parcels.pmtiles archive that MapLibre reads
#      tile-by-tile via the pmtiles:// protocol.
#
# Tippecanoe is a Linux/Mac C++ tool. On Windows, options are:
#
#   (a) WSL (Windows Subsystem for Linux) — recommended, native:
#         wsl --install
#         sudo apt install tippecanoe
#       Then this script's system() call will dispatch via wsl.
#
#   (b) Docker (any platform):
#         docker run --rm -v "$(pwd):/data" klokantech/tippecanoe \
#           tippecanoe -o /data/web/public/parcels.pmtiles --layer=parcels \
#           --maximum-zoom=18 --minimum-zoom=10 --drop-densest-as-needed \
#           --force /data/web/public/parcels.geojson
#
#   (c) Run on a Linux/macOS machine, copy the .pmtiles file back.
#
# Requires: sf, httr2, jsonlite

library(sf)
library(httr2)
library(jsonlite)
library(digest)

data_dir       <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch"
public_dir     <- file.path(data_dir, "web", "public")
output_geojson <- file.path(public_dir, "parcels.geojson")
output_pmtiles <- file.path(public_dir, "parcels.pmtiles")

if (!dir.exists(public_dir)) dir.create(public_dir, recursive = TRUE)

# --- Step 1: Page through d4mq-wa44 ---------------------------------
# Socrata caps individual responses around 1k-50k rows depending on
# format; pagining at 5,000 keeps each request small and parallel-
# friendly. Total parcel count is ~245,000 so expect ~50 page calls.

page_size <- 5000
url       <- "https://data.winnipeg.ca/resource/d4mq-wa44.geojson"
# Fields we want surfaced as feature properties in the .pmtiles —
# enough for the click popup; extra columns just bloat the archive.
select_cols <- "roll_number,full_address,zoning,total_assessed_value,geometry"

cat("Fetching Assessment Parcels in pages of ", page_size, "...\n", sep = "")

all_features <- list()
offset       <- 0L
repeat {
  cat(sprintf("  offset=%6d ... ", offset))
  resp <- request(url) |>
    req_url_query(
      `$select` = select_cols,
      `$order`  = "roll_number",
      `$limit`  = page_size,
      `$offset` = offset
    ) |>
    req_perform()
  fc <- resp |> resp_body_string() |> fromJSON(simplifyVector = FALSE)
  n  <- length(fc$features)
  cat(n, " features\n", sep = "")
  if (n == 0L) break
  all_features <- c(all_features, fc$features)
  if (n < page_size) break
  offset <- offset + page_size
}

cat("Total features: ", length(all_features), "\n", sep = "")

# --- Step 1.5: Deduplicate by geometry ------------------------------
# Multi-unit buildings (condos especially) often have one assessment
# record per unit, all sharing the SAME building polygon. Without
# dedup, every unit emits an identical polygon to the .pmtiles, and
# the citywide overlay renders those stacked features as dark
# opaque blobs (50 units × 0.06 opacity ≈ 95% opaque). For the
# overlay's purpose ("show every parcel boundary") one polygon per
# unique geometry is all we need; per-unit roll numbers are still
# served live from SODA when the user actually queries that parcel.
#
# We hash the geometry's coordinate JSON to a key, group by key, and
# keep only the first feature in each group. Properties of subsequent
# duplicates are discarded — they're per-unit, not per-polygon, and
# would only matter if we tried to surface them in the overlay popup
# (which we don't; the overlay is line-only).

cat("Deduplicating by geometry...\n")
geom_keys <- vapply(
  all_features,
  function(f) digest::digest(toJSON(f$geometry, auto_unbox = TRUE)),
  character(1)
)
keep_mask <- !duplicated(geom_keys)
n_before  <- length(all_features)
all_features <- all_features[keep_mask]
n_after   <- length(all_features)
cat("  ", n_before - n_after, "duplicates removed; ",
    n_after, "unique polygons retained.\n", sep = " ")

# --- Step 2: Write the combined FeatureCollection -------------------
# We deliberately bypass sf here so we don't lose precision through
# the WKT round-trip. Just dump the FC envelope back to disk.

cat("Writing GeoJSON to ", output_geojson, " ...\n", sep = "")
writeLines(
  toJSON(
    list(type = "FeatureCollection", features = all_features),
    auto_unbox = TRUE,
    na = "null"
  ),
  output_geojson
)
cat("GeoJSON size: ", round(file.size(output_geojson) / 1e6, 1), " MB\n", sep = "")

# --- Step 3: Run tippecanoe -----------------------------------------
# Common flags:
#   --layer=parcels             : the source-layer name MapLibre uses
#   --maximum-zoom=18           : enough detail at parcel scale
#   --minimum-zoom=10           : nothing useful below this; saves space
#   --drop-densest-as-needed    : auto-prune at low zoom to keep tiles small
#   --coalesce-densest-as-needed: merge adjacent polygons at low zoom
#   --no-tile-size-limit        : don't enforce default 500 KB tile cap
#   --force                     : overwrite any existing .pmtiles file

tippecanoe_cmd <- paste(
  "tippecanoe",
  "-o", shQuote(output_pmtiles),
  "--layer=parcels",
  "--maximum-zoom=18",
  "--minimum-zoom=10",
  "--drop-densest-as-needed",
  "--coalesce-densest-as-needed",
  "--no-tile-size-limit",
  "--force",
  shQuote(output_geojson)
)

cat("\nNext step (run yourself, since tippecanoe is Linux/Mac):\n  ",
    tippecanoe_cmd, "\n\n", sep = "")
cat("On Windows, prepend 'wsl ' (with WSL installed and tippecanoe in it):\n  wsl ",
    tippecanoe_cmd, "\n\n", sep = "")
cat("After tippecanoe finishes you can delete the GeoJSON intermediate:\n  ",
    shQuote(output_geojson), "\n", sep = "")
