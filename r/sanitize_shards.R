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
        if (file.exists(f)) file.remove(f)
        sf::st_write(g, f, driver = "GeoJSON",
                     layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"), quiet = TRUE)
        if (!is.null(man) && !is.null(man$neighbourhoods[[slug]])) {
          man$neighbourhoods[[slug]][[key]] <- nrow(g); man_changed <- TRUE
        }
      }
    }
  }
  if (man_changed && !dry) {
    jsonlite::write_json(man, man_path, auto_unbox = TRUE, pretty = TRUE, null = "null", digits = 12)
    cat("  (updated manifest counts for", snap, ")\n")
  }
}
cat(sprintf("\n%s %d shard(s).\n", if (dry) "Would fix" else "Fixed", fixed_total))
