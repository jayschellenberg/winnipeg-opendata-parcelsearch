# build_historical_shards.R
#
# Processes the dated City of Winnipeg snapshots in the WpgSnapshots archive
# into per-neighbourhood GeoJSON shards for the webapp's HISTORICAL
# ("as-of-date") compare view. Each dated source file = one snapshot; its date
# IS the snapshot_id (YYYY-MM-DD). Two layer types are sharded:
#
#   parcels  <- AssessmentParcels_<YYYYMMDD>.gpkg   (assessment roll + polygon)
#   survey   <- SurveyParcels_<YYYYMMDD>.gpkg       (legal lot/block/plan)
#
# A snapshot dir holds whichever layer(s) were captured on that date, plus a
# manifest (schema 2) carrying each layer's source date AND provenance
# (source_file, sha256, retrieved_at, source_url, source_crs, license) lifted
# from the archive .meta.json sidecars.
#
#   source : D:/Dropbox/Appraisal/Web/WpgSnapshots/<year>/*.gpkg
#   output : <OUTPUT_ROOT>/<snapshot_id>/            (snapshot_id = YYYY-MM-DD)
#              manifest.json
#              parcels/<slug>.json    survey/<slug>.json
#            <OUTPUT_ROOT>/index.json                 # discovery: snapshots + per-layer dates
#
# SHARD KEY = the official Winnipeg NEIGHBOURHOOD (web/public/wpg-neighbourhoods
# .geojson), assigned by representative-point-in-polygon. Both layers use the
# same neighbourhood set, so assessment + survey shards share one slug universe
# (a neighbourhood pick fetches both). The assessment's own `neighbourhood_area`
# is kept as a DISPLAY field. Parcels falling outside every neighbourhood bucket
# into "UNASSIGNED" (not dropped).
#
# Display shards are simplified for VISUALIZATION only (area-gated: lots < 1 ha
# are kept EXACT so Douglas-Peucker can't collapse a small rectangle into a
# triangle). They are NOT survey-accurate — resolve acreage/boundary evidence
# back to the archived source-of-record named in each layer's provenance.
#
# The output tree is destined for a SEPARATE public repo (wpg-parcel-history)
# served via the jsDelivr CDN, so it stays out of the app repo + Vercel deploy.
#
# Usage:
#   Rscript r/build_historical_shards.R                       # every snapshot
#   Rscript r/build_historical_shards.R --year 2026           # only 2026 snapshots
#   Rscript r/build_historical_shards.R --neighbourhood RIVER-HEIGHTS  # one slug (fast test)
#   Rscript r/build_historical_shards.R --index-only          # just rewrite the discovery index

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
  library(jsonlite)
})
sf::sf_use_s2(FALSE)   # GEOS — permissive simplify + planar point-on-surface

ARCHIVE_ROOT   <- "D:/Dropbox/Appraisal/Web/WpgSnapshots"
OUTPUT_ROOT    <- "D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history"
NEIGHBOURHOODS <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch/web/public/wpg-neighbourhoods.geojson"

# ~2-3 m. Only applied to parcels >= SIMPLIFY_MIN_AREA_M2; small urban lots are
# kept EXACT (a rectangle is already minimal — DP can only drop a corner and
# collapse it into a triangle). 1 ha is well above any urban lot, so in practice
# nearly all Winnipeg parcels ship unsimplified. (Lesson B.)
SIMPLIFY_TOLERANCE_DEG <- 0.00003
SIMPLIFY_MIN_AREA_M2   <- 10000
# ~0.3 m de-noise applied to ALL lots. An order of magnitude below the ~2-3 m
# that collapses small rectangles, so simple lots (median 6 verts) are untouched
# while grossly over-digitized survey boundaries (seen up to ~19k verts) shed
# redundant near-collinear vertices. The triangle scan validates safety.
SIMPLIFY_NOISE_DEG     <- 0.000003

# Canonical fields kept per layer (what the webapp popup displays). Assessment
# names are normalized to snake_case first (the 2023 snapshot ships Title.Case).
ASMT_FIELDS   <- c("roll_number", "full_address", "neighbourhood_area",
                   "market_region", "zoning", "assessed_land_area",
                   "total_assessed_value", "property_use_code", "detail_url")
# `survey_id` is the City's stable per-lot id (renamed from `id` to avoid the
# GeoJSON feature-id promotion) — the key the survey lineage popup looks up.
SURVEY_FIELDS <- c("survey_id", "plan", "lot", "block", "description")

# ---- args ------------------------------------------------------------
args      <- commandArgs(trailingOnly = TRUE)
arg_val   <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NA_character_ else args[i + 1] }
only_year <- arg_val("--year")
only_slug <- arg_val("--neighbourhood")
index_only <- "--index-only" %in% args

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# ---- helpers ---------------------------------------------------------
date_from_name <- function(path) {
  m <- regmatches(basename(path), regexpr("\\d{8}", basename(path)))
  if (length(m) == 0) return(NA_character_)
  paste0(substr(m, 1, 4), "-", substr(m, 5, 6), "-", substr(m, 7, 8))
}

# Neighbourhood slug: UPPER, spaces/slashes -> '-', strip the rest. Same fn for
# the geojson name (binning key) and the assessment neighbourhood_area display.
slugify <- function(x) {
  s <- toupper(trimws(as.character(x)))
  s <- gsub("[/ ]+", "-", s)
  s <- gsub("[^A-Z0-9-]", "", s)
  s <- gsub("-+", "-", s)
  gsub("^-|-$", "", s)
}

# Normalize attribute names to snake_case: "Roll.Number"/"Roll Number" ->
# "roll_number". Leaves already-snake names unchanged.
normalize_names <- function(nm) {
  s <- tolower(nm)
  s <- gsub("[^a-z0-9]+", "_", s)
  s <- gsub("_+", "_", s)
  gsub("^_|_$", "", s)
}

# Read a parcel/survey gpkg layer, repairing the rare generic-GEOMETRY file
# (the 2023 assessment snapshot crashes sf's normal reader and has no declared
# geom type). Repair = GDAL vectortranslate PROMOTE_TO_MULTI to a temp gpkg,
# then collection-extract polygons + make valid. Clean MULTIPOLYGON files read
# directly.
read_layer_repair <- function(f) {
  ly <- sf::st_layers(f)
  lyr <- ly$name[1]
  gt  <- tryCatch(as.character(ly$geomtype[[1]]), error = function(e) character(0))
  needs_repair <- length(gt) == 0 || !any(nzchar(gt)) ||
                  any(grepl("GEOMETRYCOLLECTION|^GEOMETRY$", toupper(gt)))
  if (!needs_repair) {
    g <- sf::st_read(f, layer = lyr, quiet = TRUE)
  } else {
    cat("    (generic geometry — repairing via vectortranslate)\n")
    tmp <- tempfile(fileext = ".gpkg")
    sf::gdal_utils("vectortranslate", source = f, destination = tmp,
                   options = c("-f", "GPKG", "-nlt", "PROMOTE_TO_MULTI",
                               "-nln", "layer", "-skipfailures"))
    g <- sf::st_read(tmp, layer = "layer", quiet = TRUE)
    file.remove(tmp)
    g <- suppressWarnings(sf::st_collection_extract(g, "POLYGON"))
    g <- sf::st_make_valid(g)
    g <- g[!sf::st_is_empty(g), ]
  }
  names(g)[names(g) == attr(g, "sf_column")] <- "geometry"
  sf::st_geometry(g) <- "geometry"
  g
}

# Reproject to 4326 (no-op when already) and area-gate simplify: parcels below
# SIMPLIFY_MIN_AREA_M2 are left EXACT; larger ones get a ~2-3 m Douglas-Peucker.
to_wgs84_simplify <- function(g) {
  if (is.na(sf::st_crs(g))) sf::st_crs(g) <- 4326
  area_m2 <- as.numeric(sf::st_area(sf::st_transform(sf::st_geometry(g), 26914)))
  if ((sf::st_crs(g)$epsg %||% 0) != 4326) g <- sf::st_transform(g, 4326)
  geom <- sf::st_geometry(g)
  small <- is.finite(area_m2) & area_m2 <  SIMPLIFY_MIN_AREA_M2
  big   <- is.finite(area_m2) & area_m2 >= SIMPLIFY_MIN_AREA_M2
  # Tier 1: ~0.3 m de-noise on small lots (triangle-safe — see SIMPLIFY_NOISE_DEG).
  if (any(small)) geom[small] <- suppressWarnings(sf::st_simplify(
    geom[small], dTolerance = SIMPLIFY_NOISE_DEG, preserveTopology = TRUE))
  # Tier 2: ~2-3 m simplify + make-valid on large/complex parcels.
  if (any(big)) geom[big] <- sf::st_make_valid(suppressWarnings(sf::st_simplify(
    geom[big], dTolerance = SIMPLIFY_TOLERANCE_DEG, preserveTopology = TRUE)))
  sf::st_geometry(g) <- geom
  # Extract polygon parts from any GEOMETRYCOLLECTION (st_make_valid can yield
  # polygon + stray line) and drop non-polygonal residue.
  if (!all(sf::st_geometry_type(g) %in% c("POLYGON", "MULTIPOLYGON"))) {
    g <- suppressWarnings(sf::st_collection_extract(g, "POLYGON"))
    g <- g[sf::st_geometry_type(g) %in% c("POLYGON", "MULTIPOLYGON"), ]
  }
  g <- g[!sf::st_is_empty(g), ]
  # Drop degenerate zero-area polygons. A collinear ring is typed POLYGON here
  # but st_write/RFC7946 emits it as a LineString (street right-of-way rolls like
  # "EVANSON STREET"), which MapLibre can't render as a fill. Counted, not silent.
  a2 <- as.numeric(sf::st_area(sf::st_transform(sf::st_geometry(g), 26914)))
  degen <- !is.finite(a2) | a2 < 1
  if (any(degen)) {
    cat(sprintf("    note: dropped %d degenerate zero-area feature(s)\n", sum(degen)))
    g <- g[!degen, ]
  }
  g
}

# Load + cache the official neighbourhood polygons (binning key). Adds `slug`.
.nbhd_ref <- NULL
neighbourhood_ref <- function() {
  if (!is.null(.nbhd_ref)) return(.nbhd_ref)
  if (!file.exists(NEIGHBOURHOODS)) stop("neighbourhoods geojson not found: ", NEIGHBOURHOODS)
  n <- sf::st_read(NEIGHBOURHOODS, quiet = TRUE)
  if (is.na(sf::st_crs(n))) sf::st_crs(n) <- 4326
  if ((sf::st_crs(n)$epsg %||% 0) != 4326) n <- sf::st_transform(n, 4326)
  nmcol <- intersect(c("name", "Name", "NAME"), names(n))[1]
  n$nbhd_name <- as.character(n[[nmcol]])
  n$slug      <- slugify(n$nbhd_name)
  .nbhd_ref <<- n[, c("nbhd_name", "slug")]
  .nbhd_ref
}

# Assign each feature a neighbourhood slug by representative-point-in-polygon.
# Points outside every neighbourhood -> "UNASSIGNED".
bin_to_neighbourhood <- function(g) {
  ref <- neighbourhood_ref()
  pts <- suppressWarnings(sf::st_point_on_surface(sf::st_geometry(g)))
  pts_sf <- sf::st_sf(`._rid` = seq_along(pts), geometry = pts, crs = sf::st_crs(g))
  j <- suppressMessages(sf::st_join(pts_sf, ref, join = sf::st_within))
  j <- j[!duplicated(j$`._rid`), ]                 # 1 row per point (non-overlapping nbhds)
  ord <- match(seq_len(nrow(g)), j$`._rid`)
  g$nbhd_slug <- j$slug[ord]
  g$nbhd_name_official <- j$nbhd_name[ord]
  g$nbhd_slug[is.na(g$nbhd_slug)] <- "UNASSIGNED"
  g
}

# Write one GeoJSON shard per slug. Returns a named list slug -> feature count.
write_shards <- function(g, slug_col, out_dir, keep_fields) {
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  g <- g[!is.na(g[[slug_col]]), ]
  counts <- list()
  for (sl in sort(unique(g[[slug_col]]))) {
    if (!is.na(only_slug) && sl != only_slug) next
    shard <- g[g[[slug_col]] == sl, c(keep_fields, "geometry")]
    fp <- file.path(out_dir, paste0(sl, ".json"))
    if (file.exists(fp)) file.remove(fp)
    sf::st_write(shard, fp, driver = "GeoJSON",
                 layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"),
                 quiet = TRUE)
    counts[[sl]] <- nrow(shard)
  }
  counts
}

# ---- provenance + validation ----------------------------------------
read_meta <- function(src_path) {
  mp <- paste0(src_path, ".meta.json")
  if (!file.exists(mp)) return(NULL)
  tryCatch(jsonlite::read_json(mp), error = function(e) NULL)
}

generator_commit <- function() {
  tryCatch({
    out <- suppressWarnings(system2("git", c("-C", "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch",
                                             "rev-parse", "--short", "HEAD"),
                                    stdout = TRUE, stderr = FALSE))
    if (length(out)) trimws(out[1]) else NA_character_
  }, error = function(e) NA_character_)
}

layer_meta <- function(src_f, neighbourhoods, features) {
  m <- read_meta(src_f)
  list(
    source_file           = basename(src_f),
    source_date           = date_from_name(src_f),
    retrieved_at          = m$retrieved_at %||% NA_character_,
    retrieved_at_inferred = if (is.null(m$retrieved_at_inferred)) NA else m$retrieved_at_inferred,
    source_crs            = m$source_crs %||% NA_character_,
    sha256                = m$sha256 %||% NA_character_,
    bytes                 = m$bytes %||% NA,
    source_url            = m$source_url %||% NA_character_,
    license               = m$license %||% NA_character_,
    neighbourhoods        = neighbourhoods,
    features              = features
  )
}

require_fields <- function(present, critical, label, hard = FALSE) {
  miss <- setdiff(critical, present)
  if (length(miss)) {
    msg <- sprintf("  !! %s %s critical field(s): %s",
                   label, if (hard) "MISSING" else "missing", paste(miss, collapse = ", "))
    if (hard) stop(msg) else cat(msg, "\n")
  }
  invisible(length(miss) == 0)
}

# ---- per-layer processing -------------------------------------------
process_assessment <- function(f, out_dir) {
  cat("  parcels :", basename(f), "\n")
  p <- read_layer_repair(f)
  names(p)[names(p) != "geometry"] <- normalize_names(names(p)[names(p) != "geometry"])
  require_fields(names(p), c("roll_number", "neighbourhood_area"), "parcels", hard = TRUE)
  # Defensive dedupe-by-roll (2023/2025/2026 are already 1 row/roll, but guard).
  if (any(duplicated(p$roll_number))) {
    before <- nrow(p); p <- p[!duplicated(p$roll_number), ]
    cat(sprintf("    deduped roll rows: %d -> %d\n", before, nrow(p)))
  }
  keepP <- intersect(ASMT_FIELDS, names(p))
  p <- p[, c(keepP, "geometry")]
  cat("    binning", nrow(p), "parcels to neighbourhoods + simplifying ...\n")
  p <- bin_to_neighbourhood(p)
  if (!is.na(only_slug)) p <- p[p$nbhd_slug == only_slug, ]
  p <- to_wgs84_simplify(p)
  pc <- write_shards(p, "nbhd_slug", file.path(out_dir, "parcels"), keepP)
  list(meta = layer_meta(f, length(pc), sum(unlist(pc))), counts = pc,
       names = p |> sf::st_drop_geometry() |> dplyr::distinct(nbhd_slug, nbhd_name_official))
}

process_survey <- function(f, out_dir) {
  cat("  survey  :", basename(f), "\n")
  s <- read_layer_repair(f)
  names(s)[names(s) != "geometry"] <- normalize_names(names(s)[names(s) != "geometry"])
  names(s)[names(s) == "id"] <- "survey_id"   # stable per-lot id; avoid GeoJSON feature-id promotion
  require_fields(names(s), c("plan"), "survey")
  keepS <- intersect(SURVEY_FIELDS, names(s))
  s <- s[, c(keepS, "geometry")]
  cat("    binning", nrow(s), "survey lots to neighbourhoods + simplifying ...\n")
  s <- bin_to_neighbourhood(s)
  if (!is.na(only_slug)) s <- s[s$nbhd_slug == only_slug, ]
  s <- to_wgs84_simplify(s)
  sc <- write_shards(s, "nbhd_slug", file.path(out_dir, "survey"), keepS)
  list(meta = layer_meta(f, length(sc), sum(unlist(sc))), counts = sc,
       names = s |> sf::st_drop_geometry() |> dplyr::distinct(nbhd_slug, nbhd_name_official))
}

# ---- discovery index ------------------------------------------------
write_root_index <- function() {
  snaps <- sort(basename(list.dirs(OUTPUT_ROOT, recursive = FALSE)), decreasing = TRUE)
  snaps <- snaps[grepl("^\\d{4}-\\d{2}-\\d{2}$", snaps)]
  out <- list()
  for (s in snaps) {
    mf <- file.path(OUTPUT_ROOT, s, "manifest.json")
    if (!file.exists(mf)) next
    m <- jsonlite::read_json(mf)
    lyrs <- lapply(m$layers, function(l) list(source_date = l$source_date, features = l$features))
    out[[s]] <- list(snapshot_id = s, layers = lyrs,
                     neighbourhood_count = length(m$neighbourhoods))
  }
  idx <- list(
    dataset   = "wpg-parcel-history",
    schema    = 2,
    generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
    cdn       = "https://cdn.jsdelivr.net/gh/jayschellenberg/wpg-parcel-history@main",
    snapshots = out
  )
  dir.create(OUTPUT_ROOT, showWarnings = FALSE, recursive = TRUE)
  jsonlite::write_json(idx, file.path(OUTPUT_ROOT, "index.json"),
                       auto_unbox = TRUE, pretty = TRUE, null = "null")
  cat("Wrote root index.json — snapshots:", paste(names(out), collapse = ", "), "\n")
}

# ---- per-snapshot orchestration -------------------------------------
process_snapshot <- function(snap, files) {
  if (!is.na(only_year) && substr(snap, 1, 4) != only_year) return(invisible())
  cat("\n=== Snapshot", snap, "===\n")
  out_dir <- file.path(OUTPUT_ROOT, snap)
  layers <- list()
  nbhd_names <- list()

  af <- files$parcels
  if (!is.null(af)) {
    r <- process_assessment(af, out_dir)
    layers$parcels <- r$meta
    nbhd_names[[length(nbhd_names) + 1]] <- r$names
    asmt_counts <- r$counts
  } else asmt_counts <- list()

  sf_ <- files$survey
  if (!is.null(sf_)) {
    r <- process_survey(sf_, out_dir)
    layers$survey <- r$meta
    nbhd_names[[length(nbhd_names) + 1]] <- r$names
    survey_counts <- r$counts
  } else survey_counts <- list()

  # neighbourhoods map: slug -> { name, parcels, survey }
  nm <- if (length(nbhd_names)) dplyr::distinct(dplyr::bind_rows(nbhd_names)) else
    data.frame(nbhd_slug = character(0), nbhd_name_official = character(0))
  nm <- nm[!duplicated(nm$nbhd_slug), ]
  neighbourhoods <- setNames(
    lapply(nm$nbhd_slug, function(sl) list(
      name    = nm$nbhd_name_official[match(sl, nm$nbhd_slug)] %||% sl,
      parcels = asmt_counts[[sl]]   %||% 0L,
      survey  = survey_counts[[sl]] %||% 0L
    )), nm$nbhd_slug)

  manifest <- list(
    schema      = 2,
    snapshot_id = snap,
    generated   = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
    generator   = list(
      script = "build_historical_shards.R",
      commit = generator_commit(),
      crs    = "EPSG:4326",
      shard_key = "official Winnipeg neighbourhood (representative-point-in-polygon)",
      simplify_tolerance_deg = SIMPLIFY_TOLERANCE_DEG,
      simplify_min_area_m2   = SIMPLIFY_MIN_AREA_M2,
      geometry_note = paste("Display geometry: lots < 1 ha kept exact; larger parcels",
                            "simplified ~2-3 m. NOT survey-accurate — resolve boundary/area",
                            "evidence to the archived source-of-record (layers[].source_file / sha256).")
    ),
    disclaimer  = paste("Historical assessment + survey overlays are an investigative aid as of the",
                        "source date; verify against the registered plan / title / by-law and the",
                        "current winnipegassessment.com record. Not a legal survey or determination."),
    layers         = layers,
    neighbourhoods = neighbourhoods
  )
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  jsonlite::write_json(manifest, file.path(out_dir, "manifest.json"),
                       auto_unbox = TRUE, pretty = TRUE, null = "null", digits = 12)
  sz <- sum(file.info(list.files(out_dir, recursive = TRUE, full.names = TRUE))$size, na.rm = TRUE)
  cat(sprintf("  -> wrote %s  (%.1f MB)\n", out_dir, sz / 1024 / 1024))
}

# ---- main ------------------------------------------------------------
if (index_only) {
  cat("Winnipeg historical shard build — index-only\n")
  write_root_index()
  cat("\nDone.\n")
} else {
  # Discover canonical dated source files; skip quarantine (_dirs) and
  # non-canonical in-progress names. Group by date into snapshots.
  asmt <- list.files(ARCHIVE_ROOT, pattern = "^AssessmentParcels_\\d{8}\\.gpkg$",
                     recursive = TRUE, full.names = TRUE)
  surv <- list.files(ARCHIVE_ROOT, pattern = "^SurveyParcels_\\d{8}\\.gpkg$",
                     recursive = TRUE, full.names = TRUE)
  no_qtn <- function(v) v[!vapply(v, function(p)
    any(grepl("^_", strsplit(gsub("\\\\", "/", p), "/")[[1]])), logical(1))]
  asmt <- no_qtn(asmt); surv <- no_qtn(surv)

  by_date <- list()
  for (f in asmt) { d <- date_from_name(f); by_date[[d]]$parcels <- f }
  for (f in surv) { d <- date_from_name(f); by_date[[d]]$survey  <- f }
  snaps <- sort(names(by_date))

  cat("Winnipeg historical shard build\n  archive:", ARCHIVE_ROOT, "\n  output :", OUTPUT_ROOT, "\n")
  cat("  snapshots:", paste(snaps, collapse = ", "),
      if (!is.na(only_year)) paste0("  (year ", only_year, ")") else "",
      if (!is.na(only_slug)) paste0("  (neighbourhood ", only_slug, " only)") else "", "\n")
  for (s in snaps) {
    tryCatch(process_snapshot(s, by_date[[s]]),
             error = function(e) cat(sprintf("  !! snapshot %s FAILED: %s\n", s, conditionMessage(e))))
  }
  write_root_index()
  cat("\nDone.\n")
}
