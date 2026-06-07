# archive_snapshot.R
#
# Append-only archive of the City of Winnipeg Open Data source layers, so a
# parcel's size/shape (and roll / assessment / legal description) at a point in
# time can be recovered after subdivisions and reconfigurations — with a
# PROVENANCE sidecar beside each archived file for appraisal defensibility.
#
# What it does: copies the CURRENT dated source file(s) out of the repo download
# dir (where r/download_parcels.R writes them) into a dated Dropbox archive,
# NEVER overwriting a prior capture, and writes <archived-file>.meta.json next to
# each one. Idempotent — re-running adds only new files and backfills/refreshes
# sidecars for everything already archived.
#
#   source : D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch   (download dir)
#   archive: D:/Dropbox/Appraisal/Web/WpgSnapshots/<year>/
#
# Naming: Winnipeg downloads already carry the date — AssessmentParcels_YYYYMMDD
# .gpkg / SurveyParcels_YYYYMMDD.gpkg. The YYYYMMDD in the FILENAME is the
# authoritative source_date (operator-set at download time, not mtime, which
# Dropbox sync can rewrite). Files are filed into <year>/ by that date.
#
# Provenance sidecar (<file>.meta.json) — the defensible record. `source_date`
# is read from the filename date; `retrieved_at` is RECORDED at archive time
# (authoritative for files copied now; for pre-existing/back-filled files it
# falls back to the file mtime and is flagged retrieved_at_inferred:true).
# `source_crs` is the CRS as shipped (Winnipeg ships EPSG:4326 today, but record
# it regardless — a future download could differ, and areas must always be
# computed geodesically / in a metric CRS, never planar on lon/lat).
#
#   Rscript r/archive_snapshot.R          # parcels (assessment + survey)
#   Rscript r/archive_snapshot.R --all    # also capture zoning if present
#
# Storage: archives live in Dropbox, OUTSIDE git and web/public. The
# unsimplified originals here are the source-of-record; the CDN display shards
# (build_historical_shards.R) are simplified for visualization only.

suppressPackageStartupMessages({
  library(sf)
  library(jsonlite)
})

ARCHIVE_ROOT <- "D:/Dropbox/Appraisal/Web/WpgSnapshots"
SRC_DIR      <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch"

# Provenance constants.
SOURCE_AGENCY  <- "City of Winnipeg Open Data"
SOURCE_LICENSE <- "City of Winnipeg Open Data — verify current terms"

# Source layer types. Each is discovered in SRC_DIR by a dated regex `pattern`.
# Patterns tolerate the space/underscore naming variants seen in real downloads
# ("Assessment Parcels_…", "Survey_Parcels_…"); norm_name() canonicalizes the
# archived filename. `active` gates a plain run; layer/dataset/source_url feed
# the provenance sidecar.
source_types <- list(
  list(active = TRUE,  pattern = "^Assessment[ _]?Parcels_\\d{8}\\.gpkg$", layer = "assessment_parcels",
       dataset    = "City of Winnipeg — Map of Assessment Parcels (d4mq-wa44)",
       source_url = "https://data.winnipeg.ca/resource/d4mq-wa44"),
  list(active = TRUE,  pattern = "^Survey[ _]?Parcels_\\d{8}\\.gpkg$", layer = "survey_parcels",
       dataset    = "City of Winnipeg — Map of Survey Parcels (sjjm-nj47)",
       source_url = "https://data.winnipeg.ca/resource/sjjm-nj47"),
  list(active = FALSE, pattern = "^Zoning_\\d{8}\\.geojson$", layer = "zoning",
       dataset    = "City of Winnipeg — Zoning (dxrp-w6re)",
       source_url = "https://data.winnipeg.ca/resource/dxrp-w6re")
)

args        <- commandArgs(trailingOnly = TRUE)
capture_all <- "--all" %in% args

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# ---- provenance helpers ----------------------------------------------
file_sha256 <- function(path) {
  if (requireNamespace("digest", quietly = TRUE)) {
    return(tryCatch(digest::digest(file = path, algo = "sha256"), error = function(e) NA_character_))
  }
  # Windows fallback — certutil ships with the OS.
  out <- tryCatch(suppressWarnings(system2("certutil", c("-hashfile", path, "SHA256"),
                                           stdout = TRUE, stderr = TRUE)),
                  error = function(e) NULL)
  if (length(out) >= 2) {
    h <- gsub("[^0-9a-fA-F]", "", paste(out[-c(1, length(out))], collapse = ""))
    if (nchar(h) == 64) return(tolower(h))
  }
  NA_character_
}

read_schema_fields <- function(path) {
  tryCatch({
    lyr <- sf::st_layers(path)$name[1]
    d <- sf::st_read(path, quiet = TRUE,
                     query = sprintf('SELECT * FROM "%s" LIMIT 0', lyr))
    setdiff(names(d), attr(d, "sf_column"))
  }, error = function(e) character(0))
}

# Source CRS as shipped — matters for defensibility. Winnipeg ships EPSG:4326
# today; always treat a reprojected metric CRS (UTM-14N / EPSG:26914) as the
# area-of-record, never the native lon/lat.
file_crs <- function(path) {
  tryCatch({
    s <- sf::st_crs(sf::st_layers(path)$crs[[1]])
    if (!is.null(s$epsg) && !is.na(s$epsg))
      sprintf("EPSG:%d (%s)", s$epsg, s$Name %||% s$input %||% "")
    else (s$input %||% NA_character_)
  }, error = function(e) NA_character_)
}

# Authoritative source date = the YYYYMMDD embedded in the filename.
date_from_name <- function(fname) {
  m <- regmatches(fname, regexpr("\\d{8}", fname))
  if (!length(m)) return(NA_character_)
  m
}

# Canonicalize a source filename to the spaceless, no-split form so downstream
# tooling sees one name per dataset: "Assessment Parcels_20250226.gpkg" and
# "Survey_Parcels_20250314.gpkg" both normalize to "AssessmentParcels_…" /
# "SurveyParcels_…".
norm_name <- function(fname) {
  s <- gsub("\\s+", "", fname)
  s <- gsub("Survey_Parcels", "SurveyParcels", s, fixed = TRUE)
  s <- gsub("Assessment_Parcels", "AssessmentParcels", s, fixed = TRUE)
  s
}

# Match an archived filename to a logical layer label (for the backfill path).
layer_for <- function(fname) {
  if (grepl("^Assessment[ _]?Parcels", fname)) {
    list(layer = "assessment_parcels",
         dataset = "City of Winnipeg — Map of Assessment Parcels (d4mq-wa44)",
         source_url = "https://data.winnipeg.ca/resource/d4mq-wa44")
  } else if (grepl("^Survey[ _]?Parcels", fname)) {
    list(layer = "survey_parcels",
         dataset = "City of Winnipeg — Map of Survey Parcels (sjjm-nj47)",
         source_url = "https://data.winnipeg.ca/resource/sjjm-nj47")
  } else if (grepl("^Zoning", fname)) {
    list(layer = "zoning",
         dataset = "City of Winnipeg — Zoning (dxrp-w6re)",
         source_url = "https://data.winnipeg.ca/resource/dxrp-w6re")
  } else {
    list(layer = "unknown", dataset = NA_character_, source_url = NA_character_)
  }
}

write_meta <- function(dest, layer, dataset, source_url, retrieved_at, inferred) {
  meta_path <- paste0(dest, ".meta.json")
  prior <- if (file.exists(meta_path)) tryCatch(jsonlite::read_json(meta_path), error = function(e) NULL) else NULL
  ymd   <- date_from_name(basename(dest))
  source_date <- if (!is.na(ymd)) paste0(substr(ymd, 1, 4), "-", substr(ymd, 5, 6), "-", substr(ymd, 7, 8)) else NA_character_
  info  <- file.info(dest)
  bytes <- as.numeric(info$size)
  # When the file is unchanged (same byte size), reuse the prior hash + schema +
  # CRS (skip re-reading/re-hashing) and KEEP the prior retrieved_at so a
  # config-only refresh never downgrades an authoritative timestamp to inferred.
  unchanged <- !is.null(prior) && isTRUE(prior$bytes == bytes) && !is.null(prior$sha256)
  sha    <- if (unchanged) prior$sha256 else file_sha256(dest)
  fields <- if (unchanged && length(prior$schema_fields)) unlist(prior$schema_fields) else read_schema_fields(dest)
  src_crs <- if (unchanged && !is.null(prior$source_crs)) prior$source_crs else file_crs(dest)
  if (unchanged && !is.null(prior$retrieved_at)) {
    ra_str   <- prior$retrieved_at
    inferred <- if (is.null(prior$retrieved_at_inferred)) inferred else prior$retrieved_at_inferred
  } else {
    ra_str <- format(retrieved_at, "%Y-%m-%dT%H:%M:%S%z")
  }
  meta <- list(
    schema                = 1,
    archived_file         = basename(dest),
    layer                 = layer,
    source                = SOURCE_AGENCY,
    source_dataset        = dataset,
    source_url            = source_url,
    license               = SOURCE_LICENSE,
    source_date           = source_date,                 # explicit (filename), not mtime
    retrieved_at          = ra_str,
    retrieved_at_inferred = inferred,
    source_crs            = src_crs,                      # CRS as shipped (area-of-record note below)
    bytes                 = bytes,
    sha256                = sha,
    schema_fields         = fields,
    note                  = paste("Authoritative source-of-record for as-of-date measurements.",
                                  "Display shards derived from this are simplified for visualization",
                                  "only — resolve acreage/boundary evidence back to this file. Compute",
                                  "areas geodesically / in a metric CRS (EPSG:26914), never planar on lon/lat.")
  )
  jsonlite::write_json(meta, meta_path, auto_unbox = TRUE, pretty = TRUE, null = "null")
  invisible(meta)
}

# ---- archive ---------------------------------------------------------
# Copy one discovered SRC file into ARCHIVE_ROOT/<year>/ (by its filename date),
# never overwriting a prior capture, and (re)write its sidecar.
archive_one <- function(src, st) {
  fname <- basename(src)
  ymd   <- date_from_name(fname)
  if (is.na(ymd)) {
    cat(sprintf("  SKIP  %-45s (no YYYYMMDD in filename)\n", fname))
    return(invisible(FALSE))
  }
  year <- substr(ymd, 1, 4)
  age_days <- tryCatch(as.integer(Sys.Date() - as.Date(ymd, "%Y%m%d")), error = function(e) NA_integer_)
  if (!is.na(age_days) && age_days > 365) {
    cat(sprintf("  !! note: %s is %d days old (> 12 months) — consider a fresh download for the current snapshot.\n",
                fname, age_days))
  }
  dest_name <- norm_name(fname)
  ddir <- file.path(ARCHIVE_ROOT, year)
  dest <- file.path(ddir, dest_name)

  if (file.exists(dest)) {
    cat(sprintf("  HAVE  %-45s -> %s/%s\n", fname, year, basename(dest)))
    write_meta(dest, st$layer, st$dataset, st$source_url,
               retrieved_at = file.info(dest)$mtime, inferred = TRUE)
    return(invisible(FALSE))
  }
  dir.create(ddir, showWarnings = FALSE, recursive = TRUE)
  info <- file.info(src)
  cat(sprintf("  COPY  %-45s -> %s/%s  (%.1f MB) ...\n",
              fname, year, basename(dest), info$size / 1024^2))
  ok <- file.copy(src, dest, overwrite = FALSE, copy.date = TRUE)
  if (!ok || !file.exists(dest)) stop("copy failed: ", src, " -> ", dest)
  if (file.info(dest)$size != info$size) {
    file.remove(dest)
    stop("size mismatch after copy (removed partial): ", dest)
  }
  # Retrieved-at is authoritative here: archiving runs right after the operator
  # downloads, so "now" is the genuine retrieval time.
  write_meta(dest, st$layer, st$dataset, st$source_url,
             retrieved_at = Sys.time(), inferred = FALSE)
  cat("        done (+ provenance sidecar).\n")
  invisible(TRUE)
}

archive_type <- function(st) {
  srcs <- list.files(SRC_DIR, pattern = st$pattern, full.names = TRUE)
  if (!length(srcs)) {
    cat(sprintf("  none  %-45s (no matching downloads in src dir)\n", st$pattern))
    return(invisible(FALSE))
  }
  for (s in srcs) archive_one(s, st)
  invisible(TRUE)
}

# Ensure/refresh a provenance sidecar for every archived .gpkg source file
# (back-fills missing ones, refreshes config on existing ones). write_meta
# reuses the prior hash + keeps an authoritative retrieved_at when the file is
# unchanged, so this is cheap and never downgrades provenance. Only .gpkg files
# are source-of-record; redundant .geojson/.csv exports are deliberately ignored.
backfill_meta <- function() {
  files <- list.files(ARCHIVE_ROOT, pattern = "\\.gpkg$",
                      recursive = TRUE, full.names = TRUE)
  done <- 0L; skipped <- 0L
  for (f in files) {
    segs <- strsplit(gsub("\\\\", "/", f), "/")[[1]]
    # Quarantine: never register anything under a "_"-prefixed dir (e.g.
    # 2026/_partial/ holding a truncated download).
    if (any(grepl("^_", segs))) {
      cat("  skip (quarantine):", basename(f), "\n"); skipped <- skipped + 1L; next
    }
    # In-progress: a non-canonical name (still has a space/underscore split,
    # e.g. "Survey_Parcels_…") is a file mid-conversion. Don't register it until
    # it's renamed to canonical — registering = adding to the historical record.
    if (basename(f) != norm_name(basename(f))) {
      cat("  skip (non-canonical / in-progress):", basename(f), "\n"); skipped <- skipped + 1L; next
    }
    lf <- layer_for(basename(f))
    write_meta(f, lf$layer, lf$dataset, lf$source_url,
               retrieved_at = file.info(f)$mtime, inferred = TRUE)
    done <- done + 1L
  }
  cat(sprintf("  ensured %d provenance sidecar(s); skipped %d\n", done, skipped))
}

cat("Winnipeg snapshot archive\n")
cat("  source :", SRC_DIR, "\n")
cat("  archive:", ARCHIVE_ROOT, "\n\n")
for (st in source_types) {
  if (st$active || capture_all) archive_type(st)
  else cat(sprintf("  OFF   %-45s (inactive — run with --all to capture)\n", st$glob))
}
cat("\nBackfilling provenance for every archived .gpkg ...\n")
backfill_meta()
cat("\nArchive run complete.\n")
