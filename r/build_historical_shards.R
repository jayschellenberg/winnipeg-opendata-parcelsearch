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
# into "UNASSIGNED" (not dropped). KNOWN GAP (audit F8, accepted): the web app
# derives its slug list from the neighbourhood polygons, so the UNASSIGNED
# shard (~531 parcels + 219 survey lots, city-edge) is published but never
# fetched by the UI — the records remain in the archive and in these shards.
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
SLUG_PARITY_FIXTURE <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch/web/test/slug_fixtures.json"

# Shared helpers (slugify, normalize_names, read_layer_repair, neighbourhood
# binning, slug-parity fixture writer). See r/lib_helpers.R.
.SCRIPT_DIR <- local({
  fa <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  if (length(fa)) dirname(normalizePath(sub("^--file=", "", fa[1])))
  else if (!is.null(sys.frames()[[1]]$ofile)) dirname(normalizePath(sys.frames()[[1]]$ofile))
  else "."
})
source(file.path(.SCRIPT_DIR, "lib_helpers.R"))

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
# Zoning is served as ONE whole-city file per snapshot (see process_zoning), so
# it carries only the display fields — no `id` (dropped to avoid the GeoJSON
# feature-id promotion; whole-file needs no per-feature key). `map_colour` is the
# fill-category the webapp already palettes; the descriptions feed the popup.
ZONING_FIELDS <- c("zoning", "short_description", "long_description", "map_colour")

# ---- args ------------------------------------------------------------
args      <- commandArgs(trailingOnly = TRUE)
arg_val   <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NA_character_ else args[i + 1] }
only_year <- arg_val("--year")
only_slug <- arg_val("--neighbourhood")
index_only <- "--index-only" %in% args

# ---- helpers ---------------------------------------------------------
# date_from_name, slugify, normalize_names, read_layer_repair, neighbourhood_ref,
# neighbourhood_bin live in r/lib_helpers.R (single source of truth).

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
  # Drop empty/null geometries — COUNTED, not silent. d4mq-wa44 legitimately
  # carries ~59 geometry-less rows (bus shelters, statutory pipelines, some
  # condo unit rolls); they stay in the archived source-of-record but can't
  # be displayed, so they leave the shards here. Measured 2026-07: gpkg
  # 245,215 -> shards 245,081 (empties + the degenerates counted below).
  n_empty <- sum(sf::st_is_empty(g))
  if (n_empty > 0) {
    cat(sprintf("    note: dropped %d empty/null-geometry feature(s) (in archive, not displayable)\n", n_empty))
    g <- g[!sf::st_is_empty(g), ]
  }
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

# Wrapper around the shared neighbourhood_bin that ATTACHES the columns to `g`,
# preserving the historical caller contract (downstream code reads $nbhd_slug
# and $nbhd_name_official off the sf object).
bin_to_neighbourhood <- function(g) {
  b <- neighbourhood_bin(g)
  g$nbhd_slug          <- b$slug
  g$nbhd_name_official <- b$nbhd_name
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
    # Atomic write: temp file + rename so a crash mid-write can't leave a
    # truncated shard or destroy the previous one.
    tmp <- paste0(fp, ".tmpwrite")
    if (file.exists(tmp)) file.remove(tmp)
    sf::st_write(shard, tmp, driver = "GeoJSON",
                 layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"),
                 quiet = TRUE)
    if (file.exists(fp)) file.remove(fp)
    if (!file.rename(tmp, fp)) stop("rename failed: ", tmp, " -> ", fp)
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

# Zoning: written as ONE whole-city file <out_dir>/zoning.json, NOT sharded. Only
# ~18k districts (vs 245k parcels), and a zoning district routinely spans several
# neighbourhoods — representative-point binning would leave edge gaps, and
# intersect-all binning would duplicate big districts across many shards. The
# simplified whole file is ~12 MB (~3 MB gzipped), fine to fetch + render once.
# Returns a layer_meta with neighbourhoods = NA (not sharded).
process_zoning <- function(f, out_dir) {
  cat("  zoning  :", basename(f), "\n")
  z <- read_layer_repair(f)
  names(z)[names(z) != "geometry"] <- normalize_names(names(z)[names(z) != "geometry"])
  require_fields(names(z), c("zoning", "map_colour"), "zoning")
  keepZ <- intersect(ZONING_FIELDS, names(z))
  z <- z[, c(keepZ, "geometry")]
  cat("    simplifying", nrow(z), "zoning districts ...\n")
  z <- to_wgs84_simplify(z)                     # reproject + area-gated simplify + degenerate drop
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  fp  <- file.path(out_dir, "zoning.json")
  tmp <- paste0(fp, ".tmpwrite")
  if (file.exists(tmp)) file.remove(tmp)
  sf::st_write(z, tmp, driver = "GeoJSON",
               layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"), quiet = TRUE)
  if (file.exists(fp)) file.remove(fp)
  if (!file.rename(tmp, fp)) stop("rename failed: ", tmp, " -> ", fp)
  cat(sprintf("    -> wrote zoning.json (%d districts, %.1f MB)\n",
              nrow(z), file.info(fp)$size / 1024^2))
  layer_meta(f, NA, nrow(z))
}

# ---- discovery index ------------------------------------------------
# `failed_snaps` (character vector of snapshot ids) keeps the broken builds out
# of index.json's healthy snapshots map: each appears with status "failed" so
# the web app can see the run was attempted without trying to fetch shards
# that don't exist. Was: index.json silently listed every snapshot, including
# the ones whose process_snapshot threw, as healthy.
write_root_index <- function(failed_snaps = character(0)) {
  snaps <- sort(basename(list.dirs(OUTPUT_ROOT, recursive = FALSE)), decreasing = TRUE)
  snaps <- snaps[grepl("^\\d{4}-\\d{2}-\\d{2}$", snaps)]
  out <- list()
  failed_out <- list()
  for (s in snaps) {
    if (s %in% failed_snaps) {
      failed_out[[s]] <- list(snapshot_id = s, status = "failed")
      next
    }
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
  if (length(failed_out)) idx$failed_snapshots <- failed_out
  dir.create(OUTPUT_ROOT, showWarnings = FALSE, recursive = TRUE)
  jsonlite::write_json(idx, file.path(OUTPUT_ROOT, "index.json"),
                       auto_unbox = TRUE, pretty = TRUE, null = "null")
  cat("Wrote root index.json — healthy:", paste(names(out), collapse = ", "), "\n")
  if (length(failed_out)) cat("  failed snapshots (excluded from healthy map):",
                              paste(names(failed_out), collapse = ", "), "\n")
}

# ---- post-build sanity checks ---------------------------------------
# Cheap structural verification on a snapshot dir; flags the failures
# verify_shards.R would surface, without re-paying its full read cost. Returns
# TRUE on PASS, FALSE on any flag.
verify_snapshot_dir <- function(out_dir) {
  ok <- TRUE
  mf <- file.path(out_dir, "manifest.json")
  if (!file.exists(mf)) { cat("    !! verify: manifest missing\n"); return(FALSE) }
  m <- tryCatch(jsonlite::read_json(mf), error = function(e) NULL)
  if (is.null(m)) { cat("    !! verify: manifest unreadable\n"); return(FALSE) }
  # Every neighbourhood with parcels > 0 / survey > 0 must have a matching
  # shard file (the count is what the web app trusts).
  for (sl in names(m$neighbourhoods)) {
    info <- m$neighbourhoods[[sl]]
    for (kind in c("parcels", "survey")) {
      n <- info[[kind]] %||% 0
      if (is.null(n) || n == 0) next
      fp <- file.path(out_dir, kind, paste0(sl, ".json"))
      if (!file.exists(fp)) {
        cat(sprintf("    !! verify: %s/%s claims %d feats but shard file is missing\n",
                    kind, sl, n))
        ok <- FALSE
      } else if (file.info(fp)$size < 50) {
        cat(sprintf("    !! verify: %s/%s shard is suspiciously small (%d bytes)\n",
                    kind, sl, file.info(fp)$size))
        ok <- FALSE
      }
    }
  }
  # Zoning is a whole-city file (not in the neighbourhood map): if the manifest
  # declares it, the file must exist and be non-trivial.
  if (!is.null(m$layers$zoning)) {
    zp <- file.path(out_dir, "zoning.json")
    if (!file.exists(zp)) { cat("    !! verify: manifest declares zoning but zoning.json is missing\n"); ok <- FALSE }
    else if (file.info(zp)$size < 1000) { cat(sprintf("    !! verify: zoning.json suspiciously small (%d bytes)\n", file.info(zp)$size)); ok <- FALSE }
  }
  ok
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

  # Zoning (whole-city single file) — outside the neighbourhood map; just a layer.
  zf <- files$zoning
  if (!is.null(zf)) layers$zoning <- process_zoning(zf, out_dir)

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

  # Reconcile each layer's declared feature total with the shards ACTUALLY
  # written (audit H-3). layer_meta computed `features` from nrow BEFORE
  # st_write, so it counts the ~1 geometry per snapshot that RFC7946 export
  # drops (a collinear ring emitted as a LineString), and index.json then
  # overstates the served total by 1. The per-neighbourhood map matches the
  # written files (verify_shards reports man_mismatch=0), so derive the total
  # from it — declared == served. verify_shards.R now asserts this equality, so
  # any future divergence between layers[].features and the map is caught.
  map_total <- function(key) sum(vapply(neighbourhoods,
    function(h) as.integer(h[[key]] %||% 0L), integer(1)))
  if (!is.null(layers$parcels)) layers$parcels$features <- map_total("parcels")
  if (!is.null(layers$survey))  layers$survey$features  <- map_total("survey")

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
# Refresh the R↔JS slugify parity fixture on every invocation (cheap; depends
# only on the neighbourhoods geojson, not on which snapshots are being built).
tryCatch({
  write_slug_parity_fixtures(SLUG_PARITY_FIXTURE)
  cat("Wrote slug parity fixture:", SLUG_PARITY_FIXTURE, "\n")
}, error = function(e) cat("  !! slug-fixture write failed:", conditionMessage(e), "\n"))

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
  zon  <- list.files(ARCHIVE_ROOT, pattern = "^Zoning_\\d{8}\\.gpkg$",
                     recursive = TRUE, full.names = TRUE)
  no_qtn <- function(v) v[!vapply(v, function(p)
    any(grepl("^_", strsplit(gsub("\\\\", "/", p), "/")[[1]])), logical(1))]
  asmt <- no_qtn(asmt); surv <- no_qtn(surv); zon <- no_qtn(zon)

  by_date <- list()
  for (f in asmt) { d <- date_from_name(f); by_date[[d]]$parcels <- f }
  for (f in surv) { d <- date_from_name(f); by_date[[d]]$survey  <- f }
  for (f in zon)  { d <- date_from_name(f); by_date[[d]]$zoning  <- f }
  snaps <- sort(names(by_date))

  cat("Winnipeg historical shard build\n  archive:", ARCHIVE_ROOT, "\n  output :", OUTPUT_ROOT, "\n")
  cat("  snapshots:", paste(snaps, collapse = ", "),
      if (!is.na(only_year)) paste0("  (year ", only_year, ")") else "",
      if (!is.na(only_slug)) paste0("  (neighbourhood ", only_slug, " only)") else "", "\n")
  failed_snaps <- character(0)
  for (s in snaps) {
    err <- NULL
    tryCatch(process_snapshot(s, by_date[[s]]),
             error = function(e) { err <<- conditionMessage(e); cat(sprintf("  !! snapshot %s FAILED: %s\n", s, err)) })
    if (!is.null(err)) { failed_snaps <- c(failed_snaps, s); next }
    # Inline verify: catch missing/empty shards before they reach index.json.
    if (!is.na(only_year) && substr(s, 1, 4) != only_year) next
    if (!verify_snapshot_dir(file.path(OUTPUT_ROOT, s))) {
      failed_snaps <- c(failed_snaps, s)
      cat(sprintf("  !! snapshot %s flagged by verify; excluding from healthy index\n", s))
    }
  }
  write_root_index(failed_snaps)
  cat("\nDone.\n")
}
