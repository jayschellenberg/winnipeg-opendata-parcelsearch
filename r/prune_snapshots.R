# prune_snapshots.R
#
# Retention for the WpgSnapshots archive: keep at most one canonical snapshot per
# dataset per ~KEEP_MIN_MONTHS window (NEWEST wins), deleting near-duplicate
# captures that fall closer than that to a newer kept snapshot. The semi-annual
# scheduled downloads land ~6 months apart and are all kept; this prunes the
# extra manual/ad-hoc captures so the archive stays ~1 per 6 months. Raise the
# spacing toward 12 later to thin to ~yearly.
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
  anchor <- NA
  for (i in seq_len(nrow(grp))) {
    d <- grp$date[i]
    if (i == 1) {
      anchor <- d; kept <- kept + 1L
      cat(sprintf("    KEEP    %s  (newest)\n", grp$ymd[i])); next
    }
    gap <- as.integer(anchor - d)
    if (gap < THRESH_DAYS) {
      cat(sprintf("    DELETE  %s  (%d days before %s — within %d)\n",
                  grp$ymd[i], gap, format(anchor, "%Y%m%d"), THRESH_DAYS))
      if (apply) {
        for (p in c(grp$path[i], paste0(grp$path[i], ".meta.json"))) {
          if (file.exists(p)) file.remove(p)
        }
      }
      deleted <- deleted + 1L
    } else {
      anchor <- d; kept <- kept + 1L
      cat(sprintf("    KEEP    %s  (%d days before previous kept)\n", grp$ymd[i], gap))
    }
  }
}
cat(sprintf("\n%s: %d kept, %d %s.\n",
            if (apply) "Applied" else "Dry-run",
            kept, deleted, if (apply) "deleted" else "would be deleted"))
