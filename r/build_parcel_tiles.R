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

data_dir          <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch"
public_dir        <- file.path(data_dir, "web", "public")
output_geojson    <- file.path(public_dir, "parcels.geojson")
output_centroids  <- file.path(public_dir, "parcels-centroids.geojson")
output_pmtiles    <- file.path(public_dir, "parcels.pmtiles")

if (!dir.exists(public_dir)) dir.create(public_dir, recursive = TRUE)

# jsonlite::toJSON() defaults to 4 significant digits, which snaps
# Winnipeg parcel coordinates to an ~11 m grid and makes small rectangles
# turn into blocky chevrons in PMTiles. Keep enough coordinate precision
# for Tippecanoe to receive the actual parcel geometry.
geojson_digits <- 10

# --- Step 1: Page through d4mq-wa44 ---------------------------------
# Socrata caps individual responses around 1k-50k rows depending on
# format; pagining at 5,000 keeps each request small and parallel-
# friendly. Total parcel count is ~245,000 so expect ~50 page calls.

page_size <- 5000
url       <- "https://data.winnipeg.ca/resource/d4mq-wa44.geojson"
# Fields we want surfaced as feature properties in the .pmtiles —
# enough for the Show All Parcels hover tooltip and the centroid-
# label text. Everything else is fetched live from SoDA when the
# user actually searches a parcel, so anything not used by the
# citywide overlay would just bloat the archive.
#
# Dropped on purpose:
#   - zoning: the popup uses property_use_code instead; the table's
#     Zoning column comes from the live search-result query, not
#     from this tile.
#   - total_assessed_value: the citywide tooltip doesn't show
#     assessed value; the table's Assessment column comes from the
#     live search-result query.
# Both drops save ~9-11 MB in the .pmtiles, keeping us under
# GitHub's 100 MB hard cap with breathing room.
select_cols <- "roll_number,full_address,property_use_code,dwelling_units,assessed_land_area,geometry"

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
  function(f) digest::digest(toJSON(f$geometry, auto_unbox = TRUE, digits = geojson_digits)),
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
    digits = geojson_digits,
    na = "null"
  ),
  output_geojson
)
cat("GeoJSON size: ", round(file.size(output_geojson) / 1e6, 1), " MB\n", sep = "")

# --- Step 2.5: Write a parallel one-Point-per-parcel centroids file -
# When a polygon spans multiple vector tiles (common at zoom >= 17 for
# residential parcels), MapLibre places one symbol-layer label per
# tile-clipped polygon, at different representative-point positions.
# Cull-by-default doesn't catch them because they're not visually
# colliding — they're at different positions. Result: the same parcel
# shows its address+roll twice or three times.
#
# The fix is a separate label tileset: one Point feature per parcel,
# carrying the same identifying properties. tippecanoe ingests it as
# a second named layer in the same .pmtiles archive (-L parcels-labels)
# and the symbol layer in map.js reads from that source-layer instead
# of the polygon layer. Each parcel then has exactly one label feature
# regardless of how many tiles its polygon spans.
#
# st_point_on_surface() is preferred over st_centroid() because it
# guarantees the point is INSIDE the polygon — important for L-shaped
# or elongated lots where the geometric centroid can fall outside.

cat("Computing label centroids (one Point per parcel)...\n")
sf_polygons  <- sf::st_read(output_geojson, quiet = TRUE)
sf_centroids <- suppressWarnings(sf::st_point_on_surface(sf_polygons))
sf::st_write(sf_centroids, output_centroids,
             delete_dsn = TRUE, quiet = TRUE,
             layer_options = "COORDINATE_PRECISION=7")
cat("Centroids: ", nrow(sf_centroids), " features, ",
    round(file.size(output_centroids) / 1e6, 1), " MB\n", sep = "")

# --- Step 3: Print the tippecanoe command --------------------------
# Uses the locally-built `felt-tippecanoe` image (Dockerfile.tippecanoe
# at the repo root) — Felt's actively-maintained tippecanoe fork.
# Modern tippecanoe writes .pmtiles directly, so this is a single
# step (no .mbtiles intermediate, no go-pmtiles convert).
#
# Flag choices (locked in after a Karpathy round on the live overlay):
#   --maximum-zoom=18           : enough detail at parcel scale
#   --minimum-zoom=13           : at zoom < 13 every parcel is sub-pixel
#                                 anyway, so generating those tiles
#                                 just inflates the .pmtiles
#   --simplification=2          : gentle Douglas-Peucker — preserves
#                                 rectangle corners on small city lots
#   --full-detail=14            : default 12 means a 4096-quantum grid
#                                 per tile; 14 = 16384 = 4× more precise
#                                 corners
#   --no-feature-limit          : don't drop any parcel
#   --no-tile-size-limit        : don't enforce default 500 KB tile cap
#   --force                     : overwrite any existing output
#
# If you don't have the felt-tippecanoe image yet, build it once:
#   docker build -f Dockerfile.tippecanoe -t felt-tippecanoe:latest .

tippecanoe_cmd <- paste(
  'docker run --rm -v "${PWD}:/data" felt-tippecanoe',
  '-o /data/web/public/parcels.pmtiles',
  '-L parcels:/data/web/public/parcels.geojson',
  '-L parcels-labels:/data/web/public/parcels-centroids.geojson',
  '--maximum-zoom=18 --minimum-zoom=13',
  '--simplification=2 --full-detail=14',
  '--no-feature-limit --no-tile-size-limit --force'
)

cat("\nNext step (run from the project root in PowerShell):\n  ",
    tippecanoe_cmd, "\n\n", sep = "")
cat("If the felt-tippecanoe image doesn't exist yet, build it first (one-time, ~3 min):\n",
    "  docker build -f Dockerfile.tippecanoe -t felt-tippecanoe:latest .\n\n", sep = "")
cat("After tippecanoe finishes you can delete the GeoJSON intermediates:\n  ",
    shQuote(output_geojson), "\n  ", shQuote(output_centroids), "\n", sep = "")
