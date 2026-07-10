# verify_shards.R
#
# Post-build verification of the wpg-parcel-history output tree, per the §11
# checklist. Run BEFORE every publish. Checks, per snapshot/layer and overall:
#   - triangle fraction: features whose outer ring has <= 4 coords. A rectangle
#     ring is 5 coords, so > ~1% means simplification collapsed lots into
#     triangles (the Lesson B failure). Genuine triangular lots are a fraction
#     of a percent.
#   - geometry purity: every feature must be POLYGON/MULTIPOLYGON (MapLibre
#     can't render a GeometryCollection fill).
#   - shard size: jsDelivr serves files up to 50 MB; warn at 40 MB.
#   - feature-count cross-check vs each snapshot manifest's neighbourhoods map.
#
#   Rscript r/verify_shards.R

suppressPackageStartupMessages({ library(sf); library(jsonlite) })

OUTPUT_ROOT  <- "D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history"
TRI_WARN     <- 0.01     # > 1% <=4-coord outer rings = simplification leaked
SIZE_WARN_MB <- 40       # jsDelivr per-file ceiling is 50 MB

`%||%` <- function(a, b) if (is.null(a)) b else a

# Outer-ring coord count of the largest polygon (triangle indicator).
outer_len <- function(geo) {
  if (inherits(geo, "MULTIPOLYGON")) return(max(vapply(geo, function(p) nrow(p[[1]]), integer(1))))
  if (inherits(geo, "POLYGON"))      return(nrow(geo[[1]]))
  NA_integer_
}

snaps <- list.dirs(OUTPUT_ROOT, recursive = FALSE)
snaps <- sort(snaps[grepl("\\d{4}-\\d{2}-\\d{2}$", snaps)])
if (!length(snaps)) stop("no snapshot dirs under ", OUTPUT_ROOT)

tot <- list(feat = 0, bytes = 0, tri = 0, n = 0, nonpoly = 0, maxshard = 0)
warnings <- character(0)

for (sd in snaps) {
  snap <- basename(sd)
  man  <- tryCatch(jsonlite::read_json(file.path(sd, "manifest.json")), error = function(e) NULL)
  # Manifest self-consistency (audit H-4): the declared layer total
  # (layers[].features, which becomes index.json's feature count) must equal the
  # sum of the per-neighbourhood map — i.e. the shards actually written. The old
  # builder computed the total pre-st_write and overstated it by ~1/snapshot
  # (H-3). This assertion catches any such drift; the per-shard file-vs-map
  # check below (man_mismatch) does NOT, since it never sums to the declared total.
  if (!is.null(man)) {
    for (lyr in names(man$layers)) {
      if (!lyr %in% c("parcels", "survey")) next   # zoning is whole-file (checked below), not in the neighbourhood map
      key <- if (lyr == "parcels") "parcels" else "survey"
      declared <- suppressWarnings(as.integer(man$layers[[lyr]]$features %||% NA))
      mapsum <- sum(vapply(man$neighbourhoods,
                           function(h) as.integer(h[[key]] %||% 0L), integer(1)))
      if (!is.na(declared) && declared != mapsum)
        warnings <- c(warnings, sprintf("%s/%s manifest features=%d != neighbourhood-map sum=%d (H-3 overcount)",
                                        snap, lyr, declared, mapsum))
    }
  }
  for (ld in list.dirs(sd, recursive = FALSE)) {
    layer <- basename(ld)
    files <- list.files(ld, pattern = "\\.json$", full.names = TRUE)
    lf <- list(feat = 0, bytes = 0, tri = 0, n = 0, nonpoly = 0, maxshard = 0, mancnt = 0, mismatch = 0)
    for (f in files) {
      g <- tryCatch(sf::st_read(f, quiet = TRUE), error = function(e) NULL)
      if (is.null(g)) { warnings <- c(warnings, sprintf("unreadable: %s/%s/%s", snap, layer, basename(f))); next }
      sz <- file.info(f)$size
      gt <- as.character(sf::st_geometry_type(g))
      ol <- vapply(sf::st_geometry(g), outer_len, integer(1))
      lf$feat <- lf$feat + nrow(g); lf$bytes <- lf$bytes + sz
      lf$tri  <- lf$tri + sum(ol <= 4, na.rm = TRUE); lf$n <- lf$n + length(ol)
      lf$nonpoly <- lf$nonpoly + sum(!gt %in% c("POLYGON", "MULTIPOLYGON"))
      lf$maxshard <- max(lf$maxshard, sz)
      if (sz / 1024^2 > SIZE_WARN_MB)
        warnings <- c(warnings, sprintf("%s/%s/%s = %.1fMB (jsDelivr 50MB ceiling)", snap, layer, basename(f), sz / 1024^2))
      # manifest cross-check: shard filename (slug) -> neighbourhoods[slug][layer]
      if (!is.null(man)) {
        slug <- sub("\\.json$", "", basename(f))
        key  <- if (layer == "parcels") "parcels" else "survey"
        mc   <- tryCatch(man$neighbourhoods[[slug]][[key]], error = function(e) NULL)
        if (!is.null(mc)) { lf$mancnt <- lf$mancnt + as.integer(mc); if (as.integer(mc) != nrow(g)) lf$mismatch <- lf$mismatch + 1L }
      }
    }
    tri_pct <- 100 * lf$tri / max(lf$n, 1)
    cat(sprintf("  %s/%-8s shards=%3d features=%7d %6.1fMB tri=%.2f%% maxshard=%5.1fMB nonpoly=%d man_mismatch=%d\n",
                snap, layer, length(files), lf$feat, lf$bytes / 1024^2, tri_pct, lf$maxshard / 1024^2, lf$nonpoly, lf$mismatch))
    if (tri_pct > TRI_WARN * 100) warnings <- c(warnings, sprintf("%s/%s triangle=%.2f%% > 1%%", snap, layer, tri_pct))
    if (lf$nonpoly > 0)          warnings <- c(warnings, sprintf("%s/%s has %d non-polygon feature(s)", snap, layer, lf$nonpoly))
    if (lf$mismatch > 0)         warnings <- c(warnings, sprintf("%s/%s %d shard(s) disagree with manifest counts", snap, layer, lf$mismatch))
    tot$feat <- tot$feat + lf$feat; tot$bytes <- tot$bytes + lf$bytes
    tot$tri <- tot$tri + lf$tri; tot$n <- tot$n + lf$n
    tot$nonpoly <- tot$nonpoly + lf$nonpoly; tot$maxshard <- max(tot$maxshard, lf$maxshard)
  }
  # Whole-city zoning file — a single zoning.json, not a shard dir, so the
  # list.dirs loop above misses it. Same purity/size/count checks.
  if (!is.null(man$layers$zoning)) {
    zp <- file.path(sd, "zoning.json")
    if (!file.exists(zp)) {
      warnings <- c(warnings, sprintf("%s/zoning: manifest declares zoning but zoning.json is missing", snap))
    } else {
      zg  <- tryCatch(sf::st_read(zp, quiet = TRUE), error = function(e) NULL)
      zsz <- file.info(zp)$size
      if (is.null(zg)) { warnings <- c(warnings, sprintf("%s/zoning: unreadable", snap)) } else {
        znon     <- sum(!as.character(sf::st_geometry_type(zg)) %in% c("POLYGON", "MULTIPOLYGON"))
        declared <- suppressWarnings(as.integer(man$layers$zoning$features %||% NA))
        cat(sprintf("  %s/%-8s file    features=%7d %6.1fMB nonpoly=%d man_declared=%s\n",
                    snap, "zoning", nrow(zg), zsz / 1024^2, znon, if (is.na(declared)) "?" else declared))
        if (zsz / 1024^2 > SIZE_WARN_MB) warnings <- c(warnings, sprintf("%s/zoning = %.1fMB (jsDelivr 50MB ceiling)", snap, zsz / 1024^2))
        if (znon > 0)                    warnings <- c(warnings, sprintf("%s/zoning has %d non-polygon feature(s)", snap, znon))
        if (!is.na(declared) && declared != nrow(zg))
          warnings <- c(warnings, sprintf("%s/zoning manifest features=%d != file=%d", snap, declared, nrow(zg)))
        tot$feat <- tot$feat + nrow(zg); tot$bytes <- tot$bytes + zsz
        tot$nonpoly <- tot$nonpoly + znon; tot$maxshard <- max(tot$maxshard, zsz)
      }
    }
  }
}

# Lineage (if built): non-zero events proves the cross-snapshot CRS reprojection
# + intersection worked (0 events usually means a CRS/intersection failure).
for (ld in c("lineage", "survey-lineage")) {
  lin_idx <- file.path(OUTPUT_ROOT, ld, "_index.json")
  if (!file.exists(lin_idx)) next
  li  <- jsonlite::read_json(lin_idx)
  nev <- sum(vapply(li$neighbourhoods, function(x) x$events, 0L))
  cat(sprintf("\n  %-14s %d neighbourhoods, %d events  (snapshots %s)\n",
              paste0(ld, ":"), length(li$neighbourhoods), nev, paste(unlist(li$snapshots), collapse = " -> ")))
  if (nev == 0) warnings <- c(warnings, sprintf("%s/_index.json has 0 events (CRS/intersection failure?)", ld))
}

cat(sprintf("\nTOTAL features=%d  size=%.1fMB  triangle=%.2f%%  nonpoly=%d  maxshard=%.1fMB\n",
            tot$feat, tot$bytes / 1024^2, 100 * tot$tri / max(tot$n, 1), tot$nonpoly, tot$maxshard / 1024^2))
if (length(warnings)) { cat("\nWARNINGS (", length(warnings), "):\n", sep = ""); for (w in warnings) cat("  !!", w, "\n") } else
  cat("\nAll checks passed (triangle < 1%, pure polygons, shards < 40MB, counts match manifests).\n")
