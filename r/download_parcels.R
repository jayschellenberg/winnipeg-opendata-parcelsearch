# download_parcels.R
#
# Robustly download the City of Winnipeg Open Data layers used by the parcel-
# search app + historical archive, via PAGINATED SODA. Each dataset is fetched
# in pages of `PAGE` rows ordered by the stable system `:id`, so nothing is
# silently truncated (the older geospatial-export method truncated the
# assessment download to ~108k of 245k). Each is written as a dated GeoPackage
# in this folder; r/archive_snapshot.R then files them into WpgSnapshots with
# provenance. Designed to run unattended (see the scheduled task in
# r/scheduled_download.ps1 / r/setup_schedule.ps1).
#
#   Zoning              dxrp-w6re
#   Assessment Parcels  d4mq-wa44
#   Survey Parcels      sjjm-nj47
#   Addresses           cam2-ii3u
#
#   Rscript r/download_parcels.R

suppressPackageStartupMessages({
  library(sf)
  library(jsonlite)
})
options(timeout = 3600)

OUT_DIR    <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch"
DATE_STAMP <- format(Sys.Date(), "%Y%m%d")
TOKEN      <- Sys.getenv("VITE_SODA_APP_TOKEN", unset = Sys.getenv("SODA_APP_TOKEN", ""))
PAGE       <- 50000L

# Shared dataset registry (4 parcel/zoning/address core + 6 OurWinnipeg policy).
source("D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch/r/wpg_datasets.R")
datasets <- WPG_DATASETS

# Optional targeted download: set WPG_ONLY to a comma-separated list of dataset
# `name`s (e.g. "Zoning,AssessmentParcels,SurveyParcels") to fetch just those.
# Unset/empty = all registry datasets (the semi-annual default).
only <- trimws(Sys.getenv("WPG_ONLY", ""))
if (nzchar(only)) {
  keep <- trimws(strsplit(only, ",")[[1]])
  datasets <- Filter(function(d) d$name %in% keep, datasets)
  if (!length(datasets)) stop("WPG_ONLY matched no datasets in the registry: ", only)
  cat("  WPG_ONLY set — downloading only:", paste(vapply(datasets, function(d) d$name, ""), collapse = ", "), "\n")
}

ARCHIVE_ROOT <- "D:/Dropbox/Appraisal/Web/WpgSnapshots"
# Skip a dataset if today's dated gpkg is already in the repo dir OR already
# archived — so a re-run doesn't re-fetch the big parcels the archive has.
already_have <- function(name, stamp) {
  if (file.exists(file.path(OUT_DIR, sprintf("%s_%s.gpkg", name, stamp)))) return(TRUE)
  length(list.files(ARCHIVE_ROOT, pattern = sprintf("^%s_%s\\.gpkg$", name, stamp),
                    recursive = TRUE)) > 0
}

# The API's own row count — the reconciliation anchor for every fetch. Retried
# because NA here used to silently BYPASS the completeness check below, letting
# an arbitrarily partial fetch be written and archived as authoritative.
live_count <- function(resource, tries = 3) {
  for (i in seq_len(tries)) {
    out <- tryCatch(jsonlite::fromJSON(sprintf(
      "https://data.winnipeg.ca/resource/%s.json?$select=count(1)", resource)),
      error = function(e) NULL)
    n <- if (is.null(out)) NA_integer_ else suppressWarnings(as.integer(out[[1]][1]))
    if (!is.na(n)) return(n)
    if (i < tries) { cat(sprintf("    live-count attempt %d failed; retrying...\n", i)); Sys.sleep(2 * i) }
  }
  NA_integer_
}

# Page through a dataset's .geojson endpoint, ordered by the stable :id system
# field. Each page is retried up to PAGE_TRIES times with backoff (the web
# app's fetchSoda has the same policy — Socrata throws transient 5xxs, and one
# blip on page 4 of 5 used to abandon the tail of a 245k-row fetch). Stops on
# an empty/short page, or after a page fails every retry — the caller's
# live-count reconciliation then decides whether what arrived is complete.
# Returns an sf object (or NULL).
PAGE_TRIES <- 3
fetch_paged <- function(resource) {
  base <- sprintf("https://data.winnipeg.ca/resource/%s.geojson", resource)
  offset <- 0L; pages <- list()
  repeat {
    url <- sprintf("%s?$limit=%d&$offset=%d&$order=:id", base, PAGE, offset)
    pg <- NULL
    for (attempt in seq_len(PAGE_TRIES)) {
      tmp <- tempfile(fileext = ".geojson")
      ok <- tryCatch({
        utils::download.file(url, tmp, mode = "wb", quiet = TRUE,
          headers = if (nzchar(TOKEN)) c("X-App-Token" = TOKEN) else character(0))
        TRUE
      }, error = function(e) { cat("    download error:", conditionMessage(e), "\n"); FALSE })
      if (ok) pg <- tryCatch(sf::st_read(tmp, quiet = TRUE), error = function(e) NULL)
      if (file.exists(tmp)) file.remove(tmp)
      if (!is.null(pg)) break
      if (attempt < PAGE_TRIES) {
        cat(sprintf("    page at offset %d failed (attempt %d/%d) — retrying...\n",
                    offset, attempt, PAGE_TRIES))
        Sys.sleep(3 * attempt)
      }
    }
    if (is.null(pg)) {
      cat(sprintf("    page at offset %d failed %d attempts — stopping (completeness check will judge).\n",
                  offset, PAGE_TRIES))
      break
    }
    n <- nrow(pg)
    cat(sprintf("    offset %8d -> %7d\n", offset, n))
    if (n == 0L) break
    pages[[length(pages) + 1L]] <- pg
    offset <- offset + n
    if (n < PAGE) break
  }
  if (!length(pages)) return(NULL)
  do.call(rbind, pages)
}

cat("=== Winnipeg Open Data download (paginated SODA) ===\n")
cat("  date   :", DATE_STAMP, "\n  out dir:", OUT_DIR, "\n  token  :", if (nzchar(TOKEN)) "set" else "anonymous", "\n\n")

# Per-dataset outcome tracking: a dataset that yields nothing (retired /
# renamed resource id, dead endpoint, incomplete fetch) used to log one line
# and fall through to a CLEAN exit — scheduled_download.ps1 saw exit 0, so no
# FAILED marker, no email, and the dataset silently stopped being archived.
# Any failed dataset now fails the run (exit 1), which the scheduler turns
# into the marker + email. Skips-because-already-archived stay non-failures.
failed_datasets <- character(0)
for (ds in datasets) {
  out_gpkg <- file.path(OUT_DIR, sprintf("%s_%s.gpkg", ds$name, DATE_STAMP))
  if (already_have(ds$name, DATE_STAMP)) { cat(sprintf("%-18s already have today's snapshot — skipping.\n", ds$name)); next }
  cat(sprintf("%-18s (%s)\n", ds$name, ds$resource))
  live <- live_count(ds$resource)
  cat("  live count:", live, "\n")
  if (is.na(live)) {
    cat("  !! live count unavailable after retries — cannot verify completeness; NOT downloading.\n\n")
    failed_datasets <- c(failed_datasets, ds$name)
    next
  }
  fc <- tryCatch(fetch_paged(ds$resource), error = function(e) { cat("  FAILED:", conditionMessage(e), "\n"); NULL })
  if (is.null(fc) || !nrow(fc)) {
    cat("  no data returned — FAILED (retired resource id? endpoint down?).\n\n")
    failed_datasets <- c(failed_datasets, ds$name)
    next
  }
  # Completeness: fetched must reach the API's own count, less a 0.1% margin
  # for rows deleted between the count query and the paged fetch (the dataset
  # updates daily; a mid-fetch delete legitimately shortens the result by a
  # handful of rows, never by thousands). The old 95% window could bless a
  # snapshot missing ~12k parcels.
  if (nrow(fc) < ceiling(live * 0.999)) {
    cat(sprintf("  !! INCOMPLETE: fetched %d < live %d (99.9%% floor %d) — NOT writing %s.\n\n",
                nrow(fc), live, ceiling(live * 0.999), basename(out_gpkg)))
    failed_datasets <- c(failed_datasets, ds$name)
    next
  }
  # Atomic write: st_write to a temp .gpkg in the same dir, then swap into
  # place. The old delete-then-write left a crash window the length of the
  # whole multi-minute write in which the previous snapshot was already gone.
  tmp_gpkg <- file.path(OUT_DIR, sprintf("_tmpwrite_%s_%s.gpkg", ds$name, DATE_STAMP))
  if (file.exists(tmp_gpkg)) file.remove(tmp_gpkg)
  sf::st_write(fc, tmp_gpkg, layer = ds$layer, quiet = TRUE)
  if (file.exists(out_gpkg)) file.remove(out_gpkg)
  if (!file.rename(tmp_gpkg, out_gpkg)) stop("rename failed: ", tmp_gpkg, " -> ", out_gpkg)
  cat(sprintf("  RECONCILE %s: live=%d fetched=%d written=%d\n", ds$name, live, nrow(fc), nrow(fc)))
  cat(sprintf("  -> wrote %s  (%d features, %.1f MB)\n\n",
              basename(out_gpkg), nrow(fc), file.info(out_gpkg)$size / 1024^2))
}
if (length(failed_datasets)) {
  cat(sprintf("Download run FAILED for %d dataset(s): %s\n",
              length(failed_datasets), paste(failed_datasets, collapse = ", ")))
  cat("Successful downloads (if any) are left in place; re-run after the cause is fixed —\n")
  cat("already-downloaded datasets skip, so only the failed ones re-fetch.\n")
  quit(save = "no", status = 1)
}
cat("Download run complete.\n")
