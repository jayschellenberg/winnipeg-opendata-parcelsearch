# build_lineage.R
#
# Infers parcel LINEAGE (subdivisions / consolidations / replacements) between
# consecutive archived snapshots by geometric overlap of the UNSIMPLIFIED
# source-of-record gpkgs (NOT the display shards), for BOTH layers:
#   - assessment parcels, keyed by roll_number  -> lineage/
#   - survey parcels,     keyed by id           -> survey-lineage/
# Both identity keys are city-wide unique + stable across snapshots (>98% of
# rolls / 99.9% of survey ids persist), so appear/disappear reflects real
# events, not renumbering.
#
# *** INFERRED, NOT AUTHORITATIVE. *** Overlap can't distinguish a true
# subdivision from a re-survey, and snapshots are months apart, so a link only
# tells you WHICH registered plan / title to pull. Every record carries a
# confidence (min overlap coverage) and a verify disclaimer.
#
# Method, per consecutive pair (t1 -> t2): a key present in both snapshots is the
# same parcel; lineage comes from keys that APPEAR (new in t2) or DISAPPEAR (gone
# from t1). Each new parcel is intersected against the full t1 set to find the
# prior parcel(s) covering >= EDGE_COVER of it; each removed parcel against the
# full t2 set for its successor(s). Overlap edges are clustered (union-find) into
# events, filed per official-neighbourhood slug (same key as the shards).
#
# Usage:  Rscript r/build_lineage.R
#
# NOTE: read_layer_repair / normalize_names / slugify / neighbourhood binning are
# duplicated from build_historical_shards.R to keep this standalone — keep in sync.

suppressPackageStartupMessages({ library(sf); library(jsonlite) })
sf::sf_use_s2(FALSE)

ARCHIVE_ROOT   <- "D:/Dropbox/Appraisal/Web/WpgSnapshots"
OUTPUT_ROOT    <- "D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history"
NEIGHBOURHOODS <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch/web/public/wpg-neighbourhoods.geojson"

LINEAGE_CRS  <- 26914
EDGE_COVER   <- 0.50
SQFT_PER_M2  <- 10.7639104

# Layers to build lineage for. key_col = normalized identity column; key_json =
# field name emitted in the JSON; out = output subdir under OUTPUT_ROOT.
LAYERS <- list(
  list(name = "assessment", pattern = "^AssessmentParcels_\\d{8}\\.gpkg$", key_col = "roll_number", key_json = "roll", out = "lineage"),
  list(name = "survey",     pattern = "^SurveyParcels_\\d{8}\\.gpkg$",     key_col = "id",          key_json = "survey_id", out = "survey-lineage")
)

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

date_from_name <- function(p) {
  m <- regmatches(basename(p), regexpr("\\d{8}", basename(p)))
  if (length(m) == 0) return(NA_character_)
  paste0(substr(m, 1, 4), "-", substr(m, 5, 6), "-", substr(m, 7, 8))
}
slugify <- function(x) {
  s <- toupper(trimws(as.character(x))); s <- gsub("[/ ]+", "-", s)
  s <- gsub("[^A-Z0-9-]", "", s); s <- gsub("-+", "-", s); gsub("^-|-$", "", s)
}
normalize_names <- function(nm) {
  s <- tolower(nm); s <- gsub("[^a-z0-9]+", "_", s); s <- gsub("_+", "_", s); gsub("^_|_$", "", s)
}
read_layer_repair <- function(f) {
  ly <- sf::st_layers(f); lyr <- ly$name[1]
  gt <- tryCatch(as.character(ly$geomtype[[1]]), error = function(e) character(0))
  needs_repair <- length(gt) == 0 || !any(nzchar(gt)) ||
                  any(grepl("GEOMETRYCOLLECTION|^GEOMETRY$", toupper(gt)))
  if (!needs_repair) {
    g <- sf::st_read(f, layer = lyr, quiet = TRUE)
  } else {
    cat("    (generic geometry — repairing via vectortranslate)\n")
    tmp <- tempfile(fileext = ".gpkg")
    sf::gdal_utils("vectortranslate", source = f, destination = tmp,
                   options = c("-f", "GPKG", "-nlt", "PROMOTE_TO_MULTI", "-nln", "layer", "-skipfailures"))
    g <- sf::st_read(tmp, layer = "layer", quiet = TRUE); file.remove(tmp)
    g <- suppressWarnings(sf::st_collection_extract(g, "POLYGON"))
    g <- sf::st_make_valid(g); g <- g[!sf::st_is_empty(g), ]
  }
  names(g)[names(g) == attr(g, "sf_column")] <- "geometry"; sf::st_geometry(g) <- "geometry"
  g
}
.nbhd_ref <- NULL
neighbourhood_ref <- function() {
  if (!is.null(.nbhd_ref)) return(.nbhd_ref)
  n <- sf::st_read(NEIGHBOURHOODS, quiet = TRUE)
  if (is.na(sf::st_crs(n))) sf::st_crs(n) <- 4326
  if ((sf::st_crs(n)$epsg %||% 0) != 4326) n <- sf::st_transform(n, 4326)
  nmcol <- intersect(c("name", "Name", "NAME"), names(n))[1]
  n$slug <- slugify(n[[nmcol]])
  .nbhd_ref <<- n[, "slug"]; .nbhd_ref
}
bin_slug <- function(g) {
  ref <- neighbourhood_ref()
  pts <- suppressWarnings(sf::st_point_on_surface(sf::st_geometry(g)))
  pts_sf <- sf::st_sf(`._rid` = seq_along(pts), geometry = pts, crs = sf::st_crs(g))
  j <- suppressMessages(sf::st_join(pts_sf, ref, join = sf::st_within))
  j <- j[!duplicated(j$`._rid`), ]
  s <- j$slug[match(seq_len(nrow(g)), j$`._rid`)]; s[is.na(s)] <- "UNASSIGNED"; s
}
make_dsu <- function(n) {
  p <- seq_len(n)
  find <- function(i) { r <- i; while (p[r] != r) r <- p[r]; while (p[i] != r) { nx <- p[i]; p[i] <<- r; i <- nx }; r }
  list(find = find, union = function(a, b) { ra <- find(a); rb <- find(b); if (ra != rb) p[ra] <<- rb })
}
classify <- function(fr, to) {
  if (length(fr) == 1 && length(to) >= 2) return("subdivision")
  if (length(fr) >= 2 && length(to) == 1) return("consolidation")
  if (length(fr) == 1 && length(to) == 1) return("replacement")
  "reconfiguration"
}
sqft <- function(m2) round(m2 * SQFT_PER_M2)

# Read a snapshot into LINEAGE_CRS with identity key (-> pkey) + nbhd slug + area.
read_snap <- function(gpkg, key_col) {
  g <- read_layer_repair(gpkg)
  names(g)[names(g) != "geometry"] <- normalize_names(names(g)[names(g) != "geometry"])
  if (!key_col %in% names(g)) stop(basename(gpkg), " missing key column '", key_col, "'")
  g$pkey <- as.character(g[[key_col]])
  if (is.na(sf::st_crs(g))) sf::st_crs(g) <- 4326
  if ((sf::st_crs(g)$epsg %||% 0) != 4326) g <- sf::st_transform(g, 4326)
  g <- g[!is.na(g$pkey) & nzchar(g$pkey), ]
  g$nbhd_slug <- bin_slug(g)
  g <- g[, c("pkey", "nbhd_slug", "geometry")]
  g <- sf::st_transform(g, LINEAGE_CRS)
  g <- sf::st_make_valid(g); g <- g[!sf::st_is_empty(g), ]
  g$area_m2 <- as.numeric(sf::st_area(g)); g
}

pair_edges <- function(g1, g2) {
  r1 <- g1$pkey; r2 <- g2$pkey
  new_idx <- which(!r2 %in% r1); rem_idx <- which(!r1 %in% r2)
  edges <- list()
  add_edges <- function(active, full, active_is_t1) {
    if (!nrow(active) || !nrow(full)) return(invisible())
    active$.aarea <- active$area_m2
    inter <- tryCatch(suppressWarnings(sf::st_intersection(active[, c(".aarea", "pkey")], full[, "pkey"])),
                      error = function(e) NULL)
    if (is.null(inter) || nrow(inter) == 0) return(invisible())
    ov <- as.numeric(sf::st_area(inter)); inter <- sf::st_drop_geometry(inter)
    cover <- ov / inter$.aarea
    keep <- is.finite(cover) & cover >= EDGE_COVER & inter$pkey != inter$pkey.1
    for (k in which(keep)) {
      a <- inter$pkey[k]; f <- inter$pkey.1[k]
      edges[[length(edges) + 1L]] <<- if (active_is_t1) list(from = a, to = f, cover = cover[k]) else list(from = f, to = a, cover = cover[k])
    }
  }
  if (length(rem_idx)) add_edges(g1[rem_idx, ], g2, TRUE)
  if (length(new_idx)) add_edges(g2[new_idx, ], g1, FALSE)
  if (length(edges)) edges[!duplicated(vapply(edges, function(e) paste(e$from, e$to), ""))] else list()
}

pair_events <- function(edges, g1, g2, s1, s2, kj) {
  if (!length(edges)) return(list())
  nodes <- unique(c(vapply(edges, function(e) paste0("1|", e$from), ""), vapply(edges, function(e) paste0("2|", e$to), "")))
  id <- setNames(seq_along(nodes), nodes); dsu <- make_dsu(length(nodes))
  for (e in edges) dsu$union(id[[paste0("1|", e$from)]], id[[paste0("2|", e$to)]])
  comp <- vapply(seq_along(nodes), dsu$find, integer(1))
  a1 <- setNames(g1$area_m2, g1$pkey); a2 <- setNames(g2$area_m2, g2$pkey)
  mk <- function(r, ar) { e <- list(area_sqft = sqft(ar %||% NA)); e[[kj]] <- r; e }
  events <- list()
  for (cid in unique(comp)) {
    members <- nodes[comp == cid]
    fr <- sub("^1\\|", "", members[startsWith(members, "1|")]); to <- sub("^2\\|", "", members[startsWith(members, "2|")])
    if (!length(fr) || !length(to)) next
    covers <- vapply(edges[vapply(edges, function(e) paste0("1|", e$from) %in% members, TRUE)], function(e) e$cover, 0)
    events[[length(events) + 1L]] <- list(type = classify(fr, to), from_snapshot = s1, to_snapshot = s2,
      from = lapply(fr, function(r) mk(r, a1[[r]])), to = lapply(to, function(r) mk(r, a2[[r]])),
      confidence = round(min(covers), 2))
  }
  events
}

# ---- globals shared across layers -----------------------------------
NOW <- format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z")
DISCLAIMER <- paste("Inferred from geometry overlap of public parcel snapshots —",
                    "NOT authoritative lineage. Verify against registered plans of",
                    "subdivision / consolidation and certificates of title.")
ref_names <- { n <- sf::st_read(NEIGHBOURHOODS, quiet = TRUE)
  nmcol <- intersect(c("name", "Name", "NAME"), names(n))[1]
  setNames(as.character(n[[nmcol]]), slugify(n[[nmcol]])) }

write_lineage <- function(layer, acc, slug_of, snaps) {
  out_dir <- file.path(OUTPUT_ROOT, layer$out); dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  byfield <- paste0("by_", layer$key_json); kj <- layer$key_json
  keys <- sort(ls(acc)); idx <- list(); total <- 0L
  for (key in keys) {
    events <- acc[[key]]; total <- total + length(events)
    by_parcel <- list()
    for (e in events) {
      fr <- vapply(e$from, function(x) x[[kj]], ""); tr <- vapply(e$to, function(x) x[[kj]], "")
      for (r in tr) if ((slug_of[[r]] %||% "UNASSIGNED") == key)
        by_parcel[[r]] <- list(snapshot = e$to_snapshot, type = e$type, confidence = e$confidence,
          predecessors = lapply(fr, function(x) { p <- list(snapshot = e$from_snapshot); p[[kj]] <- x; p }))
      for (r in fr) if ((slug_of[[r]] %||% "UNASSIGNED") == key) {
        prev <- by_parcel[[r]]
        by_parcel[[r]] <- list(snapshot = e$from_snapshot, type = e$type, confidence = e$confidence,
          predecessors = if (!is.null(prev)) prev$predecessors else NULL,
          successors = lapply(tr, function(x) { p <- list(snapshot = e$to_snapshot); p[[kj]] <- x; p }))
      }
    }
    out <- list(schema = 1, layer = layer$name, key_field = layer$key_col,
                neighbourhood = ref_names[[key]] %||% key, slug = key, snapshots = snaps,
                generated = NOW, disclaimer = DISCLAIMER, events = events)
    out[[byfield]] <- by_parcel
    jsonlite::write_json(out, file.path(out_dir, paste0(key, ".json")), auto_unbox = TRUE, pretty = TRUE, null = "null", digits = 4)
    idx[[key]] <- list(events = length(events))
  }
  jsonlite::write_json(list(schema = 1, layer = layer$name, key_field = layer$key_col, generated = NOW,
                            disclaimer = DISCLAIMER, snapshots = snaps, neighbourhoods = idx),
                       file.path(out_dir, "_index.json"), auto_unbox = TRUE, pretty = TRUE, null = "null")
  cat(sprintf("  [%s] wrote lineage for %d neighbourhoods; %d events.\n", layer$name, length(keys), total))
}

build_layer <- function(layer) {
  files <- list.files(ARCHIVE_ROOT, pattern = layer$pattern, recursive = TRUE, full.names = TRUE)
  files <- files[!vapply(files, function(p) any(grepl("^_", strsplit(gsub("\\\\", "/", p), "/")[[1]])), logical(1))]
  files <- files[order(vapply(files, date_from_name, ""))]
  if (length(files) < 2) { cat(sprintf("\n==== %s: only %d snapshot(s) — skipping ====\n", layer$name, length(files))); return(invisible()) }
  snaps <- vapply(files, date_from_name, "")
  cat(sprintf("\n==== %s lineage — snapshots: %s ====\n", layer$name, paste(snaps, collapse = " -> ")))
  slug_of <- new.env(); acc <- new.env()
  add_ev <- function(sl, ev) acc[[sl]] <- c(acc[[sl]] %||% list(), list(ev))
  for (i in seq_len(length(files) - 1)) {
    s1 <- snaps[i]; s2 <- snaps[i + 1]
    cat(sprintf("  %s -> %s  reading ...\n", s1, s2))
    g1 <- read_snap(files[i], layer$key_col); g2 <- read_snap(files[i + 1], layer$key_col)
    for (k in seq_len(nrow(g1))) slug_of[[g1$pkey[k]]] <- g1$nbhd_slug[k]
    for (k in seq_len(nrow(g2))) slug_of[[g2$pkey[k]]] <- g2$nbhd_slug[k]
    evs <- pair_events(pair_edges(g1, g2), g1, g2, s1, s2, layer$key_json)
    cat("    events:", length(evs), "\n")
    for (ev in evs) {
      ks <- c(vapply(ev$from, function(x) x[[layer$key_json]], ""), vapply(ev$to, function(x) x[[layer$key_json]], ""))
      for (sl in unique(vapply(ks, function(r) slug_of[[r]] %||% "UNASSIGNED", ""))) add_ev(sl, ev)
    }
  }
  write_lineage(layer, acc, slug_of, snaps)
}

for (layer in LAYERS) tryCatch(build_layer(layer),
  error = function(e) cat(sprintf("  !! %s lineage FAILED: %s\n", layer$name, conditionMessage(e))))
cat("\nDone.\n")
