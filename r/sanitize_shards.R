# sanitize_shards.R
#
# Safety-net post-build pass over the wpg-parcel-history output: guarantees every
# shard is pure Polygon/MultiPolygon. In-memory st_make_valid/st_simplify can
# leave a handful of GEOMETRYCOLLECTION features (polygon + stray line spurs from
# a self-intersecting large parcel) that the builder's in-place extract misses;
# read-back extraction is reliable. For each shard that contains a non-polygon
# (or collection) feature, this extracts the polygon part, drops non-polygonal /
# degenerate residue, rewrites the shard, and corrects the manifest count.
#
#   Rscript r/sanitize_shards.R          # scan + fix all snapshots
#   Rscript r/sanitize_shards.R --dry    # report only, don't rewrite

suppressPackageStartupMessages({ library(sf); library(jsonlite) })
sf::sf_use_s2(FALSE)

OUTPUT_ROOT <- "D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history"
dry <- "--dry" %in% commandArgs(trailingOnly = TRUE)

snaps <- sort(list.dirs(OUTPUT_ROOT, recursive = FALSE))
snaps <- snaps[grepl("\\d{4}-\\d{2}-\\d{2}$", snaps)]

fixed_total <- 0L
for (sd in snaps) {
  snap <- basename(sd)
  man_path <- file.path(sd, "manifest.json")
  man <- if (file.exists(man_path)) jsonlite::read_json(man_path) else NULL
  man_changed <- FALSE
  for (ld in list.dirs(sd, recursive = FALSE)) {
    layer <- basename(ld)
    key   <- if (layer == "parcels") "parcels" else "survey"
    for (f in list.files(ld, pattern = "\\.json$", full.names = TRUE)) {
      g <- tryCatch(sf::st_read(f, quiet = TRUE), error = function(e) NULL)
      if (is.null(g)) { cat("  !! unreadable:", f, "\n"); next }
      gt <- as.character(sf::st_geometry_type(g))
      if (all(gt %in% c("POLYGON", "MULTIPOLYGON"))) next   # already clean
      before <- nrow(g)
      g <- suppressWarnings(sf::st_collection_extract(g, "POLYGON"))
      g <- g[as.character(sf::st_geometry_type(g)) %in% c("POLYGON", "MULTIPOLYGON"), ]
      g <- g[!sf::st_is_empty(g), ]
      a2 <- as.numeric(sf::st_area(sf::st_transform(sf::st_geometry(g), 26914)))
      g <- g[is.finite(a2) & a2 >= 1, ]
      dropped <- before - nrow(g)
      slug <- sub("\\.json$", "", basename(f))
      cat(sprintf("  %s/%s/%s: %d -> %d (%d removed)%s\n", snap, layer, slug,
                  before, nrow(g), dropped, if (dry) "  [dry]" else ""))
      fixed_total <- fixed_total + 1L
      if (!dry) {
        # Atomic write: temp file + rename so a crash mid-rewrite can't lose
        # the shard it was supposed to be fixing.
        tmp <- paste0(f, ".tmpwrite")
        if (file.exists(tmp)) file.remove(tmp)
        sf::st_write(g, tmp, driver = "GeoJSON",
                     layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"), quiet = TRUE)
        if (file.exists(f)) file.remove(f)
        if (!file.rename(tmp, f)) stop("rename failed: ", tmp, " -> ", f)
        if (!is.null(man) && !is.null(man$neighbourhoods[[slug]])) {
          man$neighbourhoods[[slug]][[key]] <- nrow(g); man_changed <- TRUE
        }
      }
    }
  }
  # Reconcile layers[].features with the (now-final) neighbourhood-map sum for
  # parcels/survey (audit H-3/H-4). The builder reconciles at build time, but
  # THIS pass is what runs last and may drop a feature above, leaving
  # layers[].features one high — which verify_shards' H-4 assertion then flags.
  # Do it for every snapshot (not just ones fixed here) so the historical
  # pre-H-3-fix snapshots get corrected on the next publish too. Zoning is a
  # whole-city file (not in the map) — left untouched.
  if (!is.null(man)) {
    for (lyr in intersect(c("parcels", "survey"), names(man$layers))) {
      mapsum <- sum(vapply(man$neighbourhoods, function(h) {
        v <- h[[lyr]]; if (is.null(v)) 0L else as.integer(v) }, integer(1)))
      cur <- man$layers[[lyr]]$features
      if (!is.null(cur) && as.integer(cur) != mapsum) {
        man$layers[[lyr]]$features <- mapsum; man_changed <- TRUE
        cat(sprintf("  reconciled %s/%s layers.features %s -> %d (= map sum)\n", snap, lyr, cur, mapsum))
      }
    }
  }
  if (man_changed && !dry) {
    # Same atomic pattern for the manifest — a truncated manifest.json
    # breaks the whole snapshot for the web app.
    man_tmp <- paste0(man_path, ".tmpwrite")
    jsonlite::write_json(man, man_tmp, auto_unbox = TRUE, pretty = TRUE, null = "null", digits = 12)
    if (file.exists(man_path)) file.remove(man_path)
    if (!file.rename(man_tmp, man_path)) stop("rename failed: ", man_tmp, " -> ", man_path)
    cat("  (updated manifest counts for", snap, ")\n")
  }
}
cat(sprintf("\n%s %d shard(s).\n", if (dry) "Would fix" else "Fixed", fixed_total))
