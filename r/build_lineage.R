# build_lineage.R
#
# Infers parcel LINEAGE (subdivisions / consolidations / replacements) between
# consecutive archived ASSESSMENT snapshots by geometric overlap of the
# UNSIMPLIFIED source-of-record gpkgs (NOT the display shards). Output: per-
# neighbourhood lineage JSON for the wpg-parcel-history CDN, so the app can
# answer "which prior parcel(s) did this one come from / what did it become?"
# from a click.
#
# *** INFERRED, NOT AUTHORITATIVE. *** Overlap can't distinguish a true
# subdivision from a re-survey, and snapshots are months apart, so a link only
# tells you WHICH registered plan / title to pull. Every record carries a
# confidence (overlap coverage) and a verify disclaimer.
#
# Method, per consecutive pair (t1 -> t2):
#   - roll_number is the parcel identity (city-wide unique in Winnipeg). A roll
#     in both snapshots is the same parcel; small drift is re-survey noise.
#   - Lineage comes from rolls that APPEAR (new in t2) or DISAPPEAR (gone from
#     t1). Each new parcel is intersected against the full t1 set to find the
#     prior parcel(s) covering >= EDGE_COVER of it; each removed parcel against
#     the full t2 set to find its successor(s). (Global intersection via the
#     GEOS spatial index — only a few thousand active parcels per pair.)
#   - Overlap edges are clustered (connected components) into events:
#     1->N subdivision, N->1 consolidation, 1->1 replacement, else
#     reconfiguration. Confidence = the weakest coverage in the event.
#
# Events + by_roll lookups are filed per official-neighbourhood slug (same key
# as build_historical_shards.R), so the frontend fetches lineage/<slug>.json
# alongside the parcel shard.
#
# Usage:  Rscript r/build_lineage.R
#
# NOTE: read_layer_repair / normalize_names / slugify / neighbourhood binning
# are duplicated from build_historical_shards.R to keep this script standalone.
# Keep the two in sync if the repair/bin logic changes.

suppressPackageStartupMessages({ library(sf); library(jsonlite) })
sf::sf_use_s2(FALSE)

ARCHIVE_ROOT   <- "D:/Dropbox/Appraisal/Web/WpgSnapshots"
OUTPUT_ROOT    <- "D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history"
LINEAGE_DIR    <- file.path(OUTPUT_ROOT, "lineage")
NEIGHBOURHOODS <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch/web/public/wpg-neighbourhoods.geojson"

LINEAGE_CRS  <- 26914           # UTM-14N — Winnipeg; planar metric for overlap/area
EDGE_COVER   <- 0.50            # overlap must cover >= 50% of the new/removed parcel
SQFT_PER_M2  <- 10.7639104

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

# Read a parcel gpkg, repairing the 2023 generic-GEOMETRY file (segfaults sf's
# normal reader) via GDAL vectortranslate. (Mirror of build_historical_shards.R.)
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
  s <- j$slug[match(seq_len(nrow(g)), j$`._rid`)]
  s[is.na(s)] <- "UNASSIGNED"; s
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

# Read a snapshot into LINEAGE_CRS with roll_number + neighbourhood slug + area.
read_snap <- function(gpkg) {
  g <- read_layer_repair(gpkg)
  names(g)[names(g) != "geometry"] <- normalize_names(names(g)[names(g) != "geometry"])
  if (is.na(sf::st_crs(g))) sf::st_crs(g) <- 4326
  if ((sf::st_crs(g)$epsg %||% 0) != 4326) g <- sf::st_transform(g, 4326)
  g <- g[!is.na(g$roll_number) & nzchar(as.character(g$roll_number)), ]
  g$nbhd_slug <- bin_slug(g)
  g <- g[, c("roll_number", "nbhd_slug", "geometry")]
  g <- sf::st_transform(g, LINEAGE_CRS)
  g <- sf::st_make_valid(g); g <- g[!sf::st_is_empty(g), ]
  g$area_m2 <- as.numeric(sf::st_area(g))
  g
}

# Overlap edges for one pair (global). active = new/removed (small); full = the
# other complete snapshot. Returns list(from=<t1 roll>, to=<t2 roll>, cover=).
pair_edges <- function(g1, g2) {
  r1 <- g1$roll_number; r2 <- g2$roll_number
  new_idx <- which(!r2 %in% r1); rem_idx <- which(!r1 %in% r2)
  edges <- list()
  add_edges <- function(active, full, active_is_t1) {
    if (!nrow(active) || !nrow(full)) return(invisible())
    active$.aarea <- active$area_m2
    inter <- tryCatch(suppressWarnings(sf::st_intersection(
      active[, c(".aarea", "roll_number")], full[, "roll_number"])),
      error = function(e) NULL)
    if (is.null(inter) || nrow(inter) == 0) return(invisible())
    ov <- as.numeric(sf::st_area(inter)); inter <- sf::st_drop_geometry(inter)
    cover <- ov / inter$.aarea
    keep <- is.finite(cover) & cover >= EDGE_COVER & inter$roll_number != inter$roll_number.1
    for (k in which(keep)) {
      a_roll <- inter$roll_number[k]; f_roll <- inter$roll_number.1[k]
      edges[[length(edges) + 1L]] <<- if (active_is_t1)
        list(from = a_roll, to = f_roll, cover = cover[k]) else list(from = f_roll, to = a_roll, cover = cover[k])
    }
  }
  if (length(rem_idx)) add_edges(g1[rem_idx, ], g2, TRUE)
  if (length(new_idx)) add_edges(g2[new_idx, ], g1, FALSE)
  if (length(edges)) edges[!duplicated(vapply(edges, function(e) paste(e$from, e$to), ""))] else list()
}

# Cluster edges into events; attach areas + per-roll slugs.
pair_events <- function(edges, g1, g2, s1, s2) {
  if (!length(edges)) return(list())
  nodes <- unique(c(vapply(edges, function(e) paste0("1|", e$from), ""),
                    vapply(edges, function(e) paste0("2|", e$to), "")))
  id <- setNames(seq_along(nodes), nodes); dsu <- make_dsu(length(nodes))
  for (e in edges) dsu$union(id[[paste0("1|", e$from)]], id[[paste0("2|", e$to)]])
  comp <- vapply(seq_along(nodes), dsu$find, integer(1))
  a1 <- setNames(g1$area_m2, g1$roll_number); a2 <- setNames(g2$area_m2, g2$roll_number)
  events <- list()
  for (cid in unique(comp)) {
    members <- nodes[comp == cid]
    fr <- sub("^1\\|", "", members[startsWith(members, "1|")])
    to <- sub("^2\\|", "", members[startsWith(members, "2|")])
    if (!length(fr) || !length(to)) next
    covers <- vapply(edges[vapply(edges, function(e) paste0("1|", e$from) %in% members, TRUE)],
                     function(e) e$cover, 0)
    events[[length(events) + 1L]] <- list(
      type = classify(fr, to), from_snapshot = s1, to_snapshot = s2,
      from = lapply(fr, function(r) list(roll = r, area_sqft = sqft(a1[[r]] %||% NA))),
      to   = lapply(to, function(r) list(roll = r, area_sqft = sqft(a2[[r]] %||% NA))),
      confidence = round(min(covers), 2))
  }
  events
}

# ---- main ------------------------------------------------------------
asmt <- list.files(ARCHIVE_ROOT, pattern = "^AssessmentParcels_\\d{8}\\.gpkg$", recursive = TRUE, full.names = TRUE)
asmt <- asmt[!vapply(asmt, function(p) any(grepl("^_", strsplit(gsub("\\\\", "/", p), "/")[[1]])), logical(1))]
asmt <- asmt[order(vapply(asmt, date_from_name, ""))]
if (length(asmt) < 2) stop("Need >= 2 assessment snapshots for lineage; found ", length(asmt))
snaps <- vapply(asmt, date_from_name, "")
cat("Lineage build — snapshots:", paste(snaps, collapse = " -> "), "\n")

slug_of <- new.env()                         # roll -> its neighbourhood slug (global)
acc_events <- new.env()                      # slug -> list(events)
add_event_to_slug <- function(slug, ev) acc_events[[slug]] <- c(acc_events[[slug]] %||% list(), list(ev))

for (i in seq_len(length(asmt) - 1)) {
  s1 <- snaps[i]; s2 <- snaps[i + 1]
  cat(sprintf("\n=== %s -> %s ===\n  reading ...\n", s1, s2))
  g1 <- read_snap(asmt[i]); g2 <- read_snap(asmt[i + 1])
  for (k in seq_len(nrow(g1))) slug_of[[g1$roll_number[k]]] <- g1$nbhd_slug[k]
  for (k in seq_len(nrow(g2))) slug_of[[g2$roll_number[k]]] <- g2$nbhd_slug[k]
  edges <- pair_edges(g1, g2)
  evs <- pair_events(edges, g1, g2, s1, s2)
  cat("  events:", length(evs), "\n")
  for (ev in evs) {
    rolls <- c(vapply(ev$from, function(x) x$roll, ""), vapply(ev$to, function(x) x$roll, ""))
    for (sl in unique(vapply(rolls, function(r) slug_of[[r]] %||% "UNASSIGNED", ""))) add_event_to_slug(sl, ev)
  }
}

# ---- write per-neighbourhood lineage + index ------------------------
dir.create(LINEAGE_DIR, showWarnings = FALSE, recursive = TRUE)
DISCLAIMER <- paste("Inferred from geometry overlap of public parcel snapshots —",
                    "NOT authoritative lineage. Verify against registered plans of",
                    "subdivision / consolidation and certificates of title.")
ref_names <- { n <- sf::st_read(NEIGHBOURHOODS, quiet = TRUE)
  nmcol <- intersect(c("name", "Name", "NAME"), names(n))[1]
  setNames(as.character(n[[nmcol]]), slugify(n[[nmcol]])) }

keys <- sort(ls(acc_events)); idx <- list()
cat("\nWriting lineage for", length(keys), "neighbourhoods with events ...\n")
total_ev <- 0L
for (key in keys) {
  events <- acc_events[[key]]; total_ev <- total_ev + length(events)
  by_roll <- list()
  for (e in events) {
    fr <- vapply(e$from, function(x) x$roll, ""); tr <- vapply(e$to, function(x) x$roll, "")
    for (r in tr) if ((slug_of[[r]] %||% "UNASSIGNED") == key)
      by_roll[[r]] <- list(snapshot = e$to_snapshot, type = e$type, confidence = e$confidence,
        predecessors = lapply(fr, function(x) list(snapshot = e$from_snapshot, roll = x)))
    for (r in fr) if ((slug_of[[r]] %||% "UNASSIGNED") == key) {
      prev <- by_roll[[r]]
      by_roll[[r]] <- list(snapshot = e$from_snapshot, type = e$type, confidence = e$confidence,
        predecessors = if (!is.null(prev)) prev$predecessors else NULL,
        successors = lapply(tr, function(x) list(snapshot = e$to_snapshot, roll = x)))
    }
  }
  out <- list(schema = 1, neighbourhood = ref_names[[key]] %||% key, slug = key,
              snapshots = snaps, generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
              disclaimer = DISCLAIMER, events = events, by_roll = by_roll)
  jsonlite::write_json(out, file.path(LINEAGE_DIR, paste0(key, ".json")),
                       auto_unbox = TRUE, pretty = TRUE, null = "null", digits = 4)
  idx[[key]] <- list(events = length(events))
}
jsonlite::write_json(list(schema = 1, generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
                          disclaimer = DISCLAIMER, snapshots = snaps, neighbourhoods = idx),
                     file.path(LINEAGE_DIR, "_index.json"), auto_unbox = TRUE, pretty = TRUE, null = "null")
cat("Done — lineage for", length(keys), "neighbourhoods;", total_ev, "events total.\n")
