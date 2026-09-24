# build_survey_tiles.R
#
# The vector-tile archive behind the web app's "All Survey Parcels" overlay:
# every current survey lot (Survey Parcels, sjjm-nj47), full detail, each
# stamped with the assessment roll(s) and civic address(es) standing on it.
#
# Before this archive the overlay streamed the `survey` layer of the newest
# historical snapshot (r/build_historical_tiles.R). That worked with no build,
# but it was a snapshot, lots over 1 ha were simplified ~2-3 m, and its z14
# tiles were 400-600 KB because they carried the historical parcels too. Roll
# and address came only from overlapping the citywide assessment tiles at
# runtime, which meant loading a second archive just to label the first.
#
# Pipeline:
#   1. Page through Survey Parcels and Assessment Parcels (roll, address,
#      geometry), each reconciled against the API's own count.
#   2. Match lots to rolls both ways, the same test the app's parcelsOverlap
#      uses (web/src/soda.js): the assessment's interior point inside the lot
#      (several rolls on one lot: duplexes, condos) OR the lot's interior point
#      inside the assessment (one roll over many lots: 400 Hargrave). Interior
#      points, never plain intersection, so a lot doesn't pick up its
#      neighbours across a shared edge.
#   3. tippecanoe -> web/public/wpg-survey-parcels.pmtiles (gitignored), plus
#      the committed sidecar web/public/survey-pmtiles-meta.json.
#   4. --publish: rclone to R2 beside the other archives, verified by size.
#
# Usage:
#   Rscript r/build_survey_tiles.R              # build only
#   Rscript r/build_survey_tiles.R --publish    # build + upload to R2
#   Rscript r/build_survey_tiles.R --publish-only
#
# Runtime ~20-30 min (two ~250K-row geometry fetches + tippecanoe): run it
# detached. r/publish_survey_tiles.ps1 wraps build + publish + sidecar commit,
# and r/rebuild_tiles.ps1 calls that as a non-fatal final step.

suppressPackageStartupMessages({
  library(sf)
  library(jsonlite)
  library(digest)
})
sf::sf_use_s2(FALSE)
options(timeout = 3600)

.SCRIPT_DIR <- local({
  fa <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  if (length(fa)) dirname(normalizePath(sub("^--file=", "", fa[1])))
  else if (!is.null(sys.frames()[[1]]$ofile)) dirname(normalizePath(sys.frames()[[1]]$ofile))
  else "."
})
source(file.path(.SCRIPT_DIR, "lib_tippecanoe.R"))

REPO       <- normalizePath(file.path(.SCRIPT_DIR, ".."), winslash = "/")
PUBLIC_DIR <- file.path(REPO, "web", "public")
WORK_DIR   <- file.path(PUBLIC_DIR, "survey-build")          # gitignored scratch
OUT_FILE   <- file.path(PUBLIC_DIR, "wpg-survey-parcels.pmtiles")
META_PATH  <- file.path(PUBLIC_DIR, "survey-pmtiles-meta.json")
R2_REMOTE  <- "r2:wpg-ortho/wpg-survey-parcels.pmtiles"

SURVEY_RES <- "sjjm-nj47"
ASSESS_RES <- "d4mq-wa44"
PAGE       <- 50000L
TOKEN      <- Sys.getenv("VITE_SODA_APP_TOKEN", unset = Sys.getenv("SODA_APP_TOKEN", ""))

# How many rolls / addresses ride on a lot. A condo lot can carry hundreds of
# unit rolls; the popup names a few and counts the rest, so the tile only
# needs a few plus the count.
MAX_ROLLS     <- 3L
MAX_ADDRESSES <- 2L

# Sanity band for the finished archive, checked before promotion. First build
# (2026-09-24) sets the expectation; see the note at the bottom of the log.
PMTILES_MIN_MB <- 40
PMTILES_MAX_MB <- 250

# The app draws the lots from zoom 15 (CITYWIDE_SURVEY_MIN_ZOOM in map.js);
# two zooms of slack below that for the camera. Otherwise the citywide flags
# from lib_tippecanoe.R, for the reasons documented there.
SURVEY_TIPPECANOE_FLAGS <- c(
  "--maximum-zoom=18", "--minimum-zoom=13",
  "--simplification=2", "--full-detail=14",
  "--no-feature-limit", "--drop-densest-as-needed",
  "--maximum-tile-bytes=2000000", "--force",
  "--quiet"
)

args         <- commandArgs(trailingOnly = TRUE)
publish      <- "--publish" %in% args || "--publish-only" %in% args
publish_only <- "--publish-only" %in% args

log <- function(...) cat(format(Sys.time(), "%H:%M:%S"), " ", ..., "\n", sep = "")

# ---- fetch -----------------------------------------------------------------
live_count <- function(resource, tries = 3) {
  for (i in seq_len(tries)) {
    out <- tryCatch(fromJSON(sprintf(
      "https://data.winnipeg.ca/resource/%s.json?$select=count(1)", resource)),
      error = function(e) NULL)
    n <- if (is.null(out)) NA_integer_ else suppressWarnings(as.integer(out[[1]][1]))
    if (!is.na(n)) return(n)
    Sys.sleep(2 * i)
  }
  NA_integer_
}

# Paged .geojson fetch ordered by the stable :id, each page retried — the same
# policy as r/download_parcels.R. Reconciled against the live count (0.1%
# slack for rows deleted mid-fetch); a short fetch stops the build rather than
# becoming the overlay until the next monthly rebuild.
fetch_paged <- function(resource, select) {
  live <- live_count(resource)
  if (is.na(live)) stop("live count unavailable for ", resource, " - refusing an unverifiable fetch")
  base <- sprintf("https://data.winnipeg.ca/resource/%s.geojson", resource)
  offset <- 0L; pages <- list()
  repeat {
    url <- sprintf("%s?$select=%s&$limit=%d&$offset=%d&$order=:id", base, select, PAGE, offset)
    pg <- NULL
    for (attempt in 1:3) {
      tmp <- tempfile(fileext = ".geojson")
      ok <- tryCatch({
        utils::download.file(url, tmp, mode = "wb", quiet = TRUE,
          headers = if (nzchar(TOKEN)) c("X-App-Token" = TOKEN) else character(0))
        TRUE
      }, error = function(e) { log("    download error: ", conditionMessage(e)); FALSE })
      if (ok) pg <- tryCatch(sf::st_read(tmp, quiet = TRUE), error = function(e) NULL)
      if (file.exists(tmp)) file.remove(tmp)
      if (!is.null(pg)) break
      Sys.sleep(3 * attempt)
    }
    if (is.null(pg)) stop(sprintf("%s page at offset %d failed 3 attempts", resource, offset))
    n <- nrow(pg)
    log(sprintf("  %s offset %7d -> %6d", resource, offset, n))
    if (n == 0L) break
    pages[[length(pages) + 1L]] <- pg
    offset <- offset + n
    if (n < PAGE) break
  }
  g <- do.call(rbind, pages)
  if (nrow(g) < ceiling(live * 0.999)) {
    stop(sprintf("INCOMPLETE %s: fetched %d < live %d", resource, nrow(g), live))
  }
  log(sprintf("RECONCILE %s: live=%d fetched=%d", resource, live, nrow(g)))
  attr(g, "live_count") <- live
  g
}

# Interior point of every polygon; an invalid ring gets one make_valid pass.
interior_points <- function(g) {
  pts <- suppressWarnings(tryCatch(sf::st_point_on_surface(sf::st_geometry(g)),
                                   error = function(e) NULL))
  if (is.null(pts)) {
    pts <- suppressWarnings(sf::st_point_on_surface(sf::st_make_valid(sf::st_geometry(g))))
  }
  pts
}

# Pairs (lot row, assessment row) from one containment direction.
contain_pairs <- function(points, polys) {
  hits <- sf::st_intersects(points, polys)
  data.frame(pt = rep(seq_along(hits), lengths(hits)), poly = unlist(hits))
}

# ---- build -------------------------------------------------------------------
build <- function() {
  dir.create(WORK_DIR, showWarnings = FALSE, recursive = TRUE)

  log("Fetching Survey Parcels (", SURVEY_RES, ")...")
  survey <- fetch_paged(SURVEY_RES, "id,plan,lot,block,description,location")
  survey_live <- attr(survey, "live_count")
  log("Fetching Assessment Parcels (", ASSESS_RES, ") roll + address + geometry...")
  assess <- fetch_paged(ASSESS_RES, "roll_number,full_address,geometry")
  assess_live <- attr(assess, "live_count")

  # Drop empty geometries up front: they can't be tiled or matched.
  survey <- survey[!sf::st_is_empty(survey), ]
  assess <- assess[!sf::st_is_empty(assess), ]

  log("Matching lots to rolls (interior points, both directions)...")
  s_poly <- sf::st_geometry(survey)
  a_poly <- sf::st_geometry(assess)
  if (any(!sf::st_is_valid(s_poly), na.rm = TRUE)) s_poly <- sf::st_make_valid(s_poly)
  if (any(!sf::st_is_valid(a_poly), na.rm = TRUE)) a_poly <- sf::st_make_valid(a_poly)
  # Many rolls on one lot: the assessment's interior point is in the lot.
  p1 <- contain_pairs(interior_points(assess), s_poly)
  names(p1) <- c("a", "s")
  # One roll over many lots: the lot's interior point is in the assessment.
  p2 <- contain_pairs(interior_points(survey), a_poly)
  names(p2) <- c("s", "a")
  pairs <- unique(rbind(p1[, c("s", "a")], p2[, c("s", "a")]))
  log("  ", nrow(p1), " + ", nrow(p2), " containment hits -> ", nrow(pairs), " lot/roll pairs")

  rolls <- as.character(assess$roll_number)
  addrs <- as.character(assess$full_address)
  by_lot <- split(pairs$a, pairs$s)
  n <- nrow(survey)
  asmt_rolls <- rep(NA_character_, n); asmt_roll_count <- rep(0L, n)
  asmt_addresses <- rep(NA_character_, n); asmt_address_count <- rep(0L, n)
  idx <- as.integer(names(by_lot))
  for (k in seq_along(by_lot)) {
    i <- idx[k]; a <- by_lot[[k]]
    r <- sort(unique(rolls[a][!is.na(rolls[a]) & nzchar(rolls[a])]))
    d <- sort(unique(addrs[a][!is.na(addrs[a]) & nzchar(addrs[a])]))
    asmt_roll_count[i] <- length(r)
    if (length(r)) asmt_rolls[i] <- paste(head(r, MAX_ROLLS), collapse = ";")
    asmt_address_count[i] <- length(d)
    if (length(d)) asmt_addresses[i] <- paste(head(d, MAX_ADDRESSES), collapse = ";")
  }
  stamped <- sum(asmt_roll_count > 0)
  log(sprintf("  %d of %d lots (%.1f%%) carry at least one roll", stamped, n, 100 * stamped / n))

  # Field names are load-bearing: map.js reads plan/lot/block/description as
  # the Survey Parcels schema, and the asmt_* prefix keeps the popup from
  # mistaking a lot for an assessment feature (popupHtml keys on roll_number).
  out <- sf::st_sf(
    survey_id = as.character(survey$id),
    plan = as.character(survey$plan), lot = as.character(survey$lot),
    block = as.character(survey$block), description = as.character(survey$description),
    asmt_rolls = asmt_rolls, asmt_roll_count = asmt_roll_count,
    asmt_addresses = asmt_addresses, asmt_address_count = asmt_address_count,
    geometry = sf::st_geometry(survey)
  )
  seq_path <- file.path(WORK_DIR, "survey.geojsonl")
  if (file.exists(seq_path)) file.remove(seq_path)
  sf::st_write(out, seq_path, driver = "GeoJSONSeq",
               layer_options = c("COORDINATE_PRECISION=7", "RS=NO"), quiet = TRUE)
  log("  GeoJSONSeq: ", round(file.size(seq_path) / 1e6, 1), " MB")

  # Extension LAST: tippecanoe picks PMTiles vs MBTiles by it.
  tmp_file <- sub("\\.pmtiles$", ".tmpbuild.pmtiles", OUT_FILE)
  if (file.exists(tmp_file)) file.remove(tmp_file)
  targs <- c("tippecanoe", "-o", to_wsl_path(tmp_file),
             "-L", paste0("survey:", to_wsl_path(seq_path)), SURVEY_TIPPECANOE_FLAGS)
  log("tippecanoe: wsl ", paste(targs, collapse = " "))
  status <- system2("wsl", targs, stdout = "", stderr = "")
  if (status != 0 || !file.exists(tmp_file)) stop("tippecanoe failed (exit ", status, ")")
  size_mb <- file.size(tmp_file) / 1e6
  if (size_mb < PMTILES_MIN_MB || size_mb > PMTILES_MAX_MB) {
    file.remove(tmp_file)
    stop(sprintf("archive is %.1f MB, outside the %d-%d MB sanity band - refusing to promote it.",
                 size_mb, PMTILES_MIN_MB, PMTILES_MAX_MB))
  }
  if (file.exists(OUT_FILE)) file.remove(OUT_FILE)
  if (!file.rename(tmp_file, OUT_FILE)) stop("rename failed: ", tmp_file)
  log(sprintf("Promoted %s (%.1f MB)", basename(OUT_FILE), size_mb))
  unlink(WORK_DIR, recursive = TRUE)

  meta <- list(
    built = format(Sys.Date(), "%Y-%m-%d"),
    file = basename(OUT_FILE),
    bytes = file.size(OUT_FILE),
    sha256 = digest::digest(OUT_FILE, algo = "sha256", file = TRUE),
    source_resource = SURVEY_RES,
    source_live_count = survey_live,
    features = n,
    features_with_roll = stamped,
    assessment_resource = ASSESS_RES,
    assessment_live_count = assess_live,
    tippecanoe_flags = SURVEY_TIPPECANOE_FLAGS
  )
  tmp <- paste0(META_PATH, ".tmpwrite")
  writeLines(toJSON(meta, auto_unbox = TRUE, pretty = TRUE, digits = NA), tmp)
  # Dropbox briefly locks a file it has just seen change; retry the rename.
  renamed <- FALSE
  for (attempt in 1:8) {
    if (file.exists(META_PATH)) file.remove(META_PATH)
    renamed <- suppressWarnings(file.rename(tmp, META_PATH))
    if (renamed) break
    Sys.sleep(1.5)
  }
  if (!renamed) stop("rename failed after retries: ", tmp)
  log("Wrote ", META_PATH)
}

publish_archive <- function() {
  if (!file.exists(OUT_FILE)) stop("nothing to publish: ", OUT_FILE, " not built")
  bytes <- file.size(OUT_FILE)
  log("rclone copyto ", R2_REMOTE)
  status <- system2("rclone", c("copyto", OUT_FILE, R2_REMOTE, "--s3-no-check-bucket",
                                "--stats-one-line", "--stats", "60s"), stdout = "", stderr = "")
  if (status != 0) stop("rclone upload failed (exit ", status, ")")
  ls <- tryCatch(fromJSON(paste(system2("rclone", c("lsjson", R2_REMOTE), stdout = TRUE), collapse = "")),
                 error = function(e) NULL)
  remote_bytes <- if (is.data.frame(ls) && nrow(ls)) ls$Size[1] else NA
  if (!identical(as.numeric(remote_bytes), as.numeric(bytes))) {
    stop("R2 object size ", remote_bytes, " != local ", bytes)
  }
  log("R2 verified at ", bytes, " bytes")
}

if (!publish_only) build()
if (publish) publish_archive()
log("Done.")
