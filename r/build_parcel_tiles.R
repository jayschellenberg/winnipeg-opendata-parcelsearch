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
# Two ways to run this:
#
#   Rscript r/build_parcel_tiles.R
#       MANUAL (default, unchanged): writes the GeoJSON intermediates and
#       PRINTS the tippecanoe command for you to run yourself.
#
#   Rscript r/build_parcel_tiles.R --run-tippecanoe
#       UNATTENDED: also runs tippecanoe (via WSL), promotes the archive
#       only after it succeeds and passes a size check, writes the meta
#       sidecar, and deletes the ~600 MB of GeoJSON intermediates. This is
#       what the bi-monthly scheduled job (r/rebuild_tiles.ps1) invokes.
#
# Tippecanoe is a Linux/Mac C++ tool. On Windows, options are:
#
#   (a) WSL (Windows Subsystem for Linux) — what --run-tippecanoe uses, and
#       what the printed command assumes. Ubuntu here has v2.80.0 at
#       /usr/local/bin/tippecanoe. To install on a new machine:
#         wsl --install
#         sudo apt install tippecanoe
#       WSL is preferred over Docker for the unattended job because Docker
#       Desktop's daemon is not guaranteed to be running at 03:00 (it
#       frequently is not), which would strand the build.
#
#   (b) Docker (any platform) — the previous manual route, kept as a
#       fallback. Build the image once from Dockerfile.tippecanoe:
#         docker build -f Dockerfile.tippecanoe -t felt-tippecanoe:latest .
#       then swap `wsl tippecanoe` for
#         docker run --rm -v "${PWD}:/data" felt-tippecanoe
#       and use /data/... paths instead of /mnt/d/... ones.
#
#   (c) Run on a Linux/macOS machine, copy the .pmtiles file back.
#
# Requires: sf, httr2, jsonlite

library(sf)
library(httr2)
library(jsonlite)
library(digest)
source(file.path("r", "lib_dwelling_units.R"))
source(file.path("r", "lib_tippecanoe.R"))

data_dir          <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch"
public_dir        <- file.path(data_dir, "web", "public")
output_geojson    <- file.path(public_dir, "parcels.geojson")
output_centroids  <- file.path(public_dir, "parcels-centroids.geojson")
output_condo_centroids <- file.path(public_dir, "dwelling-condo-labels.geojson")
output_pmtiles    <- file.path(public_dir, "parcels.pmtiles")

if (!dir.exists(public_dir)) dir.create(public_dir, recursive = TRUE)

# --- Mode ------------------------------------------------------------
# See the header. --run-tippecanoe is the unattended path; without it this
# script behaves exactly as it always has.
cli_args  <- commandArgs(trailingOnly = TRUE)
run_tippe <- "--run-tippecanoe" %in% cli_args

# Sanity band for the finished archive, checked before it is promoted over
# the live one. The Jul-2026 build was 95.8 MB; the floor catches a
# truncated/empty tile run and the ceiling catches runaway growth heading
# for GitHub's 100 MB *release-asset* comfort zone (releases allow 2 GB, but
# a sudden doubling means something is wrong, not that the city grew).
PMTILES_MIN_MB <- 60
PMTILES_MAX_MB <- 150

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

# Optional Socrata app token — raises the anonymous rate limit for the ~50
# paged calls this build fires. Same env vars as r/download_parcels.R
# (VITE_ first so the one token set for the web app / scheduled download is
# reused). Applied as an X-App-Token header on every request via with_token().
# Empty = anonymous, which still works, just against the shared rate pool.
TOKEN <- Sys.getenv("VITE_SODA_APP_TOKEN", unset = Sys.getenv("SODA_APP_TOKEN", ""))
with_token <- function(req) if (nzchar(TOKEN)) req_headers(req, `X-App-Token` = TOKEN) else req

cat("Fetching Assessment Parcels in pages of ", page_size,
    " (token: ", if (nzchar(TOKEN)) "set" else "anonymous", ")...\n", sep = "")

# The API's own row count, fetched up front so the paged total can be
# reconciled below — a fetch that quietly lost a page must not become the
# citywide overlay for the next several months.
live_count <- tryCatch({
  resp <- request(sub("\\.geojson$", ".json", url)) |>
    with_token() |>
    req_url_query(`$select` = "count(1)") |>
    req_retry(max_tries = 3,
              is_transient = function(r) resp_status(r) %in% c(429, 500, 502, 503)) |>
    req_perform()
  as.integer(fromJSON(resp_body_string(resp))[[1]][1])
}, error = function(e) NA_integer_)
cat("Live API count: ", live_count, "\n", sep = "")

all_features <- list()
offset       <- 0L
repeat {
  cat(sprintf("  offset=%6d ... ", offset))
  # req_retry: one transient Socrata 5xx used to abort the whole ~50-page
  # fetch at whatever page it struck (httr2 throws on HTTP errors).
  resp <- request(url) |>
    with_token() |>
    req_url_query(
      `$select` = select_cols,
      `$order`  = "roll_number",
      `$limit`  = page_size,
      `$offset` = offset
    ) |>
    req_retry(max_tries = 3,
              is_transient = function(r) resp_status(r) %in% c(429, 500, 502, 503)) |>
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

# Reconcile against the API's count (0.1% slack for rows deleted mid-fetch —
# the dataset updates daily). $order=roll_number is a stable unique key
# (verified: 245,212 rows = 245,212 distinct rolls), so pages can't drop or
# duplicate rows between offsets; a shortfall here means pages were lost.
if (!is.na(live_count) && length(all_features) < ceiling(live_count * 0.999)) {
  stop(sprintf("INCOMPLETE fetch: %d features < live count %d — refusing to build tiles from a partial set.",
               length(all_features), live_count))
}
if (is.na(live_count)) {
  # Unattended there is no one to eyeball the total, and the reconcile guard
  # above is a no-op without a live count — so an unverifiable fetch must not
  # become the citywide overlay for the next two months.
  if (run_tippe) {
    stop("live count unavailable and --run-tippecanoe is set: refusing to publish an UNVERIFIED fetch unattended.")
  }
  cat("!! live count unavailable — proceeding UNVERIFIED (manual build; check the total above looks right).\n")
}
cat(sprintf("RECONCILE d4mq-wa44: live=%s fetched=%d\n",
            ifelse(is.na(live_count), "?", live_count), length(all_features)))

# --- Step 1.25: derive dwelling-unit counts -------------------------
# This must run before geometry deduplication: condo unit records often share
# one polygon, and their address-group count cannot be recovered afterwards.
cat("Deriving dwelling-unit counts and condominium address groups...\n")
dwelling_result <- annotate_dwelling_features(all_features)
all_features <- dwelling_result$features
dwelling_points <- build_condo_group_points(all_features, dwelling_result$condo_groups)
dwelling_audit <- dwelling_result$audit
cat(sprintf("  %d eligible residential records; %d condo address groups; %d invalid condo addresses\n",
            dwelling_audit$eligible_records, dwelling_audit$condo_groups,
            dwelling_audit$invalid_condo_addresses))
if (length(dwelling_audit$included)) {
  cat("  included PUCS:", paste(names(dwelling_audit$included), dwelling_audit$included, sep = "=", collapse = ", "), "\n")
}
if (length(dwelling_audit$unmatched)) {
  cat("  residential-looking PUCS not counted:",
      paste(names(dwelling_audit$unmatched), dwelling_audit$unmatched, sep = "=", collapse = ", "), "\n")
}
# The drift signal. Loud on purpose: this line previously read "excluded for
# review" for BOTH knowingly-skipped and never-classified codes, so the ones
# that actually needed a decision were indistinguishable from the ones that
# did not -- and the whole line sat unread in a log file. It now names only
# codes nobody has classified, and r/rebuild_tiles.ps1 emails on it.
if (length(dwelling_audit$unreviewed)) {
  cat("  !! UNREVIEWED PUCS - not counted as dwellings and never classified:",
      paste(names(dwelling_audit$unreviewed), dwelling_audit$unreviewed, sep = "=", collapse = ", "), "\n")
  cat("     Decide each one: add to DWELLING_RESIDENTIAL_PUCS/DWELLING_CONDO_PUCS to count it,\n",
      "    or to DWELLING_REVIEWED_EXCLUSIONS (with a reason) to keep skipping it.\n", sep = "")
}
if (dwelling_points$skipped > 0L) {
  cat("  WARNING:", dwelling_points$skipped, "condo groups had no usable polygon geometry and were skipped\n")
}

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
# Atomic write: temp file + rename so a crash mid-dump can't leave a
# truncated parcels.geojson (the previous build's file survives).
tmp_geojson <- paste0(output_geojson, ".tmpwrite")
writeLines(
  toJSON(
    list(type = "FeatureCollection", features = all_features),
    auto_unbox = TRUE,
    digits = geojson_digits,
    na = "null"
  ),
  tmp_geojson
)
if (file.exists(output_geojson)) file.remove(output_geojson)
if (!file.rename(tmp_geojson, output_geojson)) stop("rename failed: ", tmp_geojson, " -> ", output_geojson)
cat("GeoJSON size: ", round(file.size(output_geojson) / 1e6, 1), " MB\n", sep = "")

# --- Step 2.1: build-date sidecar for the deployed overlay -----------
# The .pmtiles is a months-old snapshot by the time users hover it, and its
# tooltip attributes (address / PUCS) can disagree with the live table. This
# tiny COMMITTED sidecar tells the web app when the tiles were built so the
# overlay popup can say "as of YYYY-MM-DD" instead of implying live data.
# (parcels.pmtiles itself is a release asset, so the date can't ride in git
# with it — the sidecar is the in-repo source of truth. Commit it alongside
# the release re-upload + sha256 refresh.)
#
# DEFINED here, CALLED at the very end. Under --run-tippecanoe it must not be
# written until the archive it describes actually exists and has been
# promoted: a sidecar stamped "built today" next to a failed tile run would
# claim freshness the tiles don't have, and the scheduled job commits this
# file. The heartbeat in r/refresh_assets.ps1 reads the same date, so a
# premature stamp would also silence the staleness alarm.
write_meta <- function() {
  meta_path <- file.path(public_dir, "parcels-pmtiles-meta.json")
  meta_tmp  <- paste0(meta_path, ".tmpwrite")
  writeLines(toJSON(list(
    built            = format(Sys.Date(), "%Y-%m-%d"),
    source_resource  = "d4mq-wa44",
    source_live_count = if (is.na(live_count)) NULL else live_count,
    features_fetched = n_before,
    features_tiled   = n_after,
    dwelling_eligible_records = dwelling_audit$eligible_records,
    dwelling_condo_groups = dwelling_audit$condo_groups,
    dwelling_condo_points = nrow(dwelling_points$sf),
    dwelling_pucs_codes = DWELLING_ALL_PUCS,
    # Carried into the committed sidecar so PUCS drift shows up in git history
    # and r/rebuild_tiles.ps1 can alert on it without re-parsing the build log.
    # Empty array = every residential-looking code the City publishes is
    # explicitly classified.
    # I() keeps this a JSON ARRAY: auto_unbox would collapse a single
    # unreviewed code to a bare string, and the consumer counts elements.
    dwelling_unreviewed_pucs = I(if (length(dwelling_audit$unreviewed)) {
      names(dwelling_audit$unreviewed)
    } else {
      character(0)
    })
  ), auto_unbox = TRUE, pretty = TRUE, null = "null"), meta_tmp)
  if (file.exists(meta_path)) file.remove(meta_path)
  if (!file.rename(meta_tmp, meta_path)) stop("rename failed: ", meta_tmp, " -> ", meta_path)
  cat("Wrote ", meta_path, "\n", sep = "")
}

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
# Atomic write (same temp + rename pattern as the polygons file above).
tmp_centroids <- paste0(output_centroids, ".tmpwrite")
if (file.exists(tmp_centroids)) file.remove(tmp_centroids)
sf::st_write(sf_centroids, tmp_centroids, driver = "GeoJSON", quiet = TRUE,
             layer_options = "COORDINATE_PRECISION=7")
if (file.exists(output_centroids)) file.remove(output_centroids)
if (!file.rename(tmp_centroids, output_centroids)) stop("rename failed: ", tmp_centroids, " -> ", output_centroids)
cat("Centroids: ", nrow(sf_centroids), " features, ",
    round(file.size(output_centroids) / 1e6, 1), " MB\n", sep = "")

# One centroid per normalized condominium civic address. Ordinary residential
# labels reuse parcels-labels; this small third layer prevents thousands of
# duplicate condo-unit points while keeping archive growth bounded.
cat("Writing grouped condominium dwelling-unit centroids...\n")
tmp_condo_centroids <- paste0(output_condo_centroids, ".tmpwrite")
if (file.exists(tmp_condo_centroids)) file.remove(tmp_condo_centroids)
sf::st_write(dwelling_points$sf, tmp_condo_centroids, driver = "GeoJSON", quiet = TRUE,
             layer_options = "COORDINATE_PRECISION=7")
if (file.exists(output_condo_centroids)) file.remove(output_condo_centroids)
if (!file.rename(tmp_condo_centroids, output_condo_centroids)) {
  stop("rename failed: ", tmp_condo_centroids, " -> ", output_condo_centroids)
}
cat("Condo group centroids: ", nrow(dwelling_points$sf), " features, ",
    round(file.size(output_condo_centroids) / 1e6, 1), " MB\n", sep = "")

# --- Step 3: tippecanoe ---------------------------------------------
# Modern tippecanoe writes .pmtiles directly, so this is a single
# step (no .mbtiles intermediate, no go-pmtiles convert).
#
# The flags, the layer names, and the Windows->WSL path translation all live
# in r/lib_tippecanoe.R (with the reasoning for each flag), so the command
# printed for a manual build and the one the scheduled job actually runs are
# constructed once and cannot drift apart. r/test_tippecanoe.R covers them.
tippe_args <- function(out_file) {
  tippecanoe_args(out_file, output_geojson, output_centroids, output_condo_centroids)
}

if (!run_tippe) {
  # MANUAL — hand the command over and stop, as this script always has.
  write_meta()
  cat("\nNext step (run from the project root):\n  ",
      paste(c("wsl", tippe_args(output_pmtiles)), collapse = " "), "\n\n", sep = "")
  cat("After tippecanoe finishes you can delete the GeoJSON intermediates:\n  ",
      shQuote(output_geojson), "\n  ", shQuote(output_centroids), "\n  ",
      shQuote(output_condo_centroids), "\n", sep = "")
} else {
  # UNATTENDED — build to a temp archive, verify it, then promote.
  #
  # The temp name keeps the .pmtiles EXTENSION (parcels.tmpbuild.pmtiles,
  # NOT parcels.pmtiles.tmpbuild): tippecanoe selects its output format
  # from the extension, and an unrecognised one does not yield a PMTiles
  # archive. Because promotion is a rename, a failed, empty, or
  # out-of-band run leaves the currently-published archive untouched.
  tmp_pmtiles <- file.path(public_dir, "parcels.tmpbuild.pmtiles")
  if (file.exists(tmp_pmtiles)) file.remove(tmp_pmtiles)

  args <- tippe_args(tmp_pmtiles)
  cat("\nRunning tippecanoe via WSL:\n  wsl ", paste(args, collapse = " "), "\n", sep = "")
  status <- system2("wsl", args = args)
  if (!identical(as.integer(status), 0L)) {
    stop(sprintf("tippecanoe exited %s - previous parcels.pmtiles left in place.", status))
  }
  if (!file.exists(tmp_pmtiles)) {
    stop("tippecanoe reported success but produced no archive at ", tmp_pmtiles)
  }
  size_mb <- file.size(tmp_pmtiles) / 1e6
  if (size_mb < PMTILES_MIN_MB || size_mb > PMTILES_MAX_MB) {
    file.remove(tmp_pmtiles)
    stop(sprintf("archive is %.1f MB, outside the %d-%d MB sanity band - refusing to promote it.",
                 size_mb, PMTILES_MIN_MB, PMTILES_MAX_MB))
  }
  if (file.exists(output_pmtiles)) file.remove(output_pmtiles)
  if (!file.rename(tmp_pmtiles, output_pmtiles)) {
    stop("rename failed: ", tmp_pmtiles, " -> ", output_pmtiles)
  }
  cat(sprintf("Promoted %s (%.1f MB)\n", output_pmtiles, size_mb))

  # Only now does the sidecar describe an archive that actually exists.
  write_meta()

  # ~600 MB of intermediates; the archive is the deliverable.
  for (f in c(output_geojson, output_centroids, output_condo_centroids)) {
    if (file.exists(f)) { file.remove(f); cat("Removed intermediate ", f, "\n", sep = "") }
  }
  cat("\nBuild complete. r/rebuild_tiles.ps1 handles the sha256 refresh, release upload, and deploy.\n")
}
