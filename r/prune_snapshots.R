# prune_snapshots.R
#
# Retention for the WpgSnapshots archive: keep at most one canonical snapshot per
# dataset per ~KEEP_MIN_MONTHS window (NEWEST wins), deleting near-duplicate
# captures that fall closer than that to a newer kept snapshot. The semi-annual
# scheduled downloads land ~6 months apart and are all kept; this prunes the
# extra manual/ad-hoc captures so the archive stays ~1 per 6 months. Raise the
# spacing toward 12 later to thin to ~yearly.
#
# Two captures are NEVER deleted, whatever their spacing (added 2026-09-24):
#   - the NEWEST of each dataset: the latest capture is always kept.
#   - any file a published wpg-parcel-history snapshot names as its source
#     (manifest.json layers[].source_file). Those are the source-of-record the
#     Historical overlay's disclaimer points users to; the old newest-wins
#     rule would have deleted AssessmentParcels_20260701 (the live 2026-07-01
#     history snapshot) because a later ad-hoc capture sat 36 days after it.
#     If the manifests can't be read, the script refuses to run rather than
#     prune blind.
# Every other capture closer than the spacing to a kept one is deleted, so
# an extra capture gets cleaned up automatically once a newer one lands.
# r/scheduled_download.ps1 runs this with --apply after each semi-annual
# download.
#
# Only CANONICAL files are touched: "<year>/<Name>_YYYYMMDD.gpkg", never anything
# under a "_"-prefixed quarantine dir (e.g. 2026/_partial/, 2026/_superseded/).
# Each delete removes the .gpkg AND its ".meta.json" provenance sidecar.
#
# DRY-RUN by default (prints the plan, changes nothing). Pass --apply to delete.
#   Rscript r/prune_snapshots.R            # show what would be pruned
#   Rscript r/prune_snapshots.R --apply    # actually delete near-duplicates
#
# Tune the spacing (default 5 months => keep ~every 6):
#   WPG_KEEP_MIN_MONTHS=12 Rscript r/prune_snapshots.R --apply

ARCHIVE_ROOT <- "D:/Dropbox/Appraisal/Web/WpgSnapshots"
HISTORY_ROOT <- "D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history"

KEEP_MIN_MONTHS <- suppressWarnings(as.numeric(Sys.getenv("WPG_KEEP_MIN_MONTHS", "5")))
if (is.na(KEEP_MIN_MONTHS) || KEEP_MIN_MONTHS <= 0) KEEP_MIN_MONTHS <- 5
THRESH_DAYS <- round(KEEP_MIN_MONTHS * 30.44)   # ~months -> days

args  <- commandArgs(trailingOnly = TRUE)
apply <- "--apply" %in% args

cat(sprintf("Snapshot retention prune  (keep >= %g months apart; %d-day threshold)\n",
            KEEP_MIN_MONTHS, THRESH_DAYS))
cat("  archive:", ARCHIVE_ROOT, "\n")
cat("  mode   :", if (apply) "APPLY (deleting)" else "DRY-RUN (no changes)", "\n\n")

# Canonical snapshot gpkgs only: <Name>_YYYYMMDD.gpkg, and NOT under any
# "_"-prefixed quarantine directory.
all_gpkg <- list.files(ARCHIVE_ROOT, pattern = "\\.gpkg$", recursive = TRUE, full.names = TRUE)
canon <- Filter(function(f) {
  segs <- strsplit(gsub("\\\\", "/", f), "/")[[1]]
  !any(grepl("^_", segs)) && grepl("^[A-Za-z][A-Za-z0-9]*_\\d{8}\\.gpkg$", basename(f))
}, all_gpkg)

if (!length(canon)) { cat("No canonical snapshots found.\n"); quit(save = "no") }

# Source files the published history snapshots were built from.
manifests <- list.files(HISTORY_ROOT, pattern = "^manifest\\.json$", recursive = TRUE, full.names = TRUE)
if (!length(manifests)) stop("no wpg-parcel-history manifests under ", HISTORY_ROOT,
                             " - refusing to prune without knowing which snapshots are published.")
protected <- unique(unlist(lapply(manifests, function(m) {
  j <- jsonlite::fromJSON(m, simplifyVector = FALSE)
  vapply(j$layers, function(l) if (is.null(l$source_file)) NA_character_ else l$source_file, character(1))
})))
protected <- protected[!is.na(protected)]
cat("  published history sources (never pruned):", length(protected), "\n\n")

meta <- do.call(rbind, lapply(canon, function(f) {
  b    <- basename(f)
  name <- sub("_\\d{8}\\.gpkg$", "", b)
  ymd  <- regmatches(b, regexpr("\\d{8}", b))
  data.frame(path = f, name = name, ymd = ymd,
             date = as.Date(ymd, "%Y%m%d"), stringsAsFactors = FALSE)
}))

deleted <- 0L; kept <- 0L
for (nm in sort(unique(meta$name))) {
  grp <- meta[meta$name == nm, ]
  grp <- grp[order(grp$date, decreasing = TRUE), ]      # newest first
  cat(sprintf("%s  (%d snapshot%s)\n", nm, nrow(grp), if (nrow(grp) == 1) "" else "s"))
  # Keep-set starts with the newest capture and every published source;
  # the rest are then judged newest-first against everything kept so far.
  is_pub <- basename(grp$path) %in% protected
  keep_dates <- grp$date[c(TRUE, rep(FALSE, nrow(grp) - 1L)) | is_pub]
  for (i in seq_len(nrow(grp))) {
    d <- grp$date[i]
    if (i == 1 || is_pub[i]) {
      kept <- kept + 1L
      cat(sprintf("    KEEP    %s  (%s)\n", grp$ymd[i],
                  paste(c(if (i == 1) "newest", if (is_pub[i]) "published history source"), collapse = ", ")))
      next
    }
    gaps <- abs(as.integer(keep_dates - d))
    near <- which.min(gaps)
    gap <- gaps[near]
    if (gap < THRESH_DAYS) {
      cat(sprintf("    DELETE  %s  (%d days from kept %s — within %d)\n",
                  grp$ymd[i], gap, format(keep_dates[near], "%Y%m%d"), THRESH_DAYS))
      if (apply) {
        for (p in c(grp$path[i], paste0(grp$path[i], ".meta.json"))) {
          if (file.exists(p)) file.remove(p)
        }
      }
      deleted <- deleted + 1L
    } else {
      keep_dates <- c(keep_dates, d); kept <- kept + 1L
      cat(sprintf("    KEEP    %s  (%d days from the nearest kept)\n", grp$ymd[i], gap))
    }
  }
}
cat(sprintf("\n%s: %d kept, %d %s.\n",
            if (apply) "Applied" else "Dry-run",
            kept, deleted, if (apply) "deleted" else "would be deleted"))
