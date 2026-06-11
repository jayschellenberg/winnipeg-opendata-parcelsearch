# lib_helpers.R
#
# Helpers shared by the historical-shard and lineage builders. Both scripts
# previously carried verbatim duplicates with a "keep in sync" comment — this
# file is the one source of truth. NEIGHBOURHOODS is taken from the caller's
# environment (each builder defines it before `source()`-ing this file) so the
# path stays configurable without an extra config layer.
#
# Slugify in particular is also reimplemented in web/src/main.js
# (historicalSlugify) — they MUST agree byte-for-byte or shard fetches 404 in
# the browser. test/slugParity.test.js loads slug_fixtures.json (regenerated
# on every build_historical_shards.R run) and asserts the JS version matches.

`%||%` <- function(a, b) {
  if (is.null(a) || (length(a) == 1 && is.na(a))) b else a
}

# YYYYMMDD embedded in a basename -> "YYYY-MM-DD".
date_from_name <- function(path) {
  m <- regmatches(basename(path), regexpr("\\d{8}", basename(path)))
  if (length(m) == 0) return(NA_character_)
  paste0(substr(m, 1, 4), "-", substr(m, 5, 6), "-", substr(m, 7, 8))
}

# Neighbourhood slug: UPPER, spaces/slashes -> '-', strip the rest, collapse
# repeated dashes, trim leading/trailing dashes. MUST stay byte-compatible with
# historicalSlugify() in web/src/main.js — the slug IS the shard filename.
slugify <- function(x) {
  s <- toupper(trimws(as.character(x)))
  s <- gsub("[/ ]+", "-", s)
  s <- gsub("[^A-Z0-9-]", "", s)
  s <- gsub("-+", "-", s)
  gsub("^-|-$", "", s)
}

# Attribute names to snake_case: "Roll.Number" / "Roll Number" -> "roll_number".
# Already-snake names are unchanged.
normalize_names <- function(nm) {
  s <- tolower(nm)
  s <- gsub("[^a-z0-9]+", "_", s)
  s <- gsub("_+", "_", s)
  gsub("^_|_$", "", s)
}

# Read a parcel/survey gpkg layer, repairing the rare generic-GEOMETRY file
# (the 2023 assessment snapshot crashes sf's normal reader and has no declared
# geom type). Repair = GDAL vectortranslate PROMOTE_TO_MULTI to a temp gpkg,
# then collection-extract polygons + make valid. Clean MULTIPOLYGON files read
# directly.
read_layer_repair <- function(f) {
  ly  <- sf::st_layers(f)
  lyr <- ly$name[1]
  gt  <- tryCatch(as.character(ly$geomtype[[1]]), error = function(e) character(0))
  needs_repair <- length(gt) == 0 || !any(nzchar(gt)) ||
                  any(grepl("GEOMETRYCOLLECTION|^GEOMETRY$", toupper(gt)))
  if (!needs_repair) {
    g <- sf::st_read(f, layer = lyr, quiet = TRUE)
  } else {
    cat("    (generic geometry — repairing via vectortranslate)\n")
    tmp <- tempfile(fileext = ".gpkg")
    sf::gdal_utils("vectortranslate", source = f, destination = tmp,
                   options = c("-f", "GPKG", "-nlt", "PROMOTE_TO_MULTI",
                               "-nln", "layer", "-skipfailures"))
    g <- sf::st_read(tmp, layer = "layer", quiet = TRUE)
    file.remove(tmp)
    g <- suppressWarnings(sf::st_collection_extract(g, "POLYGON"))
    g <- sf::st_make_valid(g)
    g <- g[!sf::st_is_empty(g), ]
  }
  names(g)[names(g) == attr(g, "sf_column")] <- "geometry"
  sf::st_geometry(g) <- "geometry"
  g
}

# Load + memoise the official neighbourhood polygons. Reads NEIGHBOURHOODS
# from the caller's environment. Returns the sf object with `nbhd_name` and
# `slug` columns; callers subset to what they need.
.lib_nbhd_ref <- NULL
neighbourhood_ref <- function() {
  if (!is.null(.lib_nbhd_ref)) return(.lib_nbhd_ref)
  path <- get("NEIGHBOURHOODS", envir = parent.frame())
  if (!file.exists(path)) stop("neighbourhoods geojson not found: ", path)
  n <- sf::st_read(path, quiet = TRUE)
  if (is.na(sf::st_crs(n))) sf::st_crs(n) <- 4326
  if ((sf::st_crs(n)$epsg %||% 0) != 4326) n <- sf::st_transform(n, 4326)
  nmcol <- intersect(c("name", "Name", "NAME"), names(n))[1]
  n$nbhd_name <- as.character(n[[nmcol]])
  n$slug      <- slugify(n$nbhd_name)
  .lib_nbhd_ref <<- n[, c("nbhd_name", "slug")]
  .lib_nbhd_ref
}

# Representative-point-in-polygon join: each feature's interior point falls
# in at most one neighbourhood (boundaries are non-overlapping). Returns a
# data.frame with `slug` and `nbhd_name` columns aligned to nrow(g); features
# outside every polygon get slug = "UNASSIGNED" (not dropped).
neighbourhood_bin <- function(g) {
  ref <- neighbourhood_ref()
  pts <- suppressWarnings(sf::st_point_on_surface(sf::st_geometry(g)))
  pts_sf <- sf::st_sf(`._rid` = seq_along(pts), geometry = pts, crs = sf::st_crs(g))
  j <- suppressMessages(sf::st_join(pts_sf, ref, join = sf::st_within))
  j <- j[!duplicated(j$`._rid`), ]                 # 1 row per point
  ord <- match(seq_len(nrow(g)), j$`._rid`)
  slug <- j$slug[ord]; slug[is.na(slug)] <- "UNASSIGNED"
  name <- j$nbhd_name[ord]
  data.frame(slug = slug, nbhd_name = name, stringsAsFactors = FALSE)
}

# Emit a fixture file consumed by web/test/slugParity.test.js. Sampling the
# real inputs slugify() is called with — current snapshot's neighbourhood
# names + the `nbhd_slug` UNASSIGNED bucket — beats a hand-written list.
# Returns the destination path. Called at the tail of build_historical_shards.R
# so every shard republish refreshes the fixture in lockstep.
write_slug_parity_fixtures <- function(dest_path, extra_inputs = character(0)) {
  ref <- neighbourhood_ref()
  inputs <- unique(c(
    as.character(ref$nbhd_name),
    "",                 # empty
    "   ",              # whitespace only
    "UNASSIGNED",       # the bucket name
    "river / heights",  # slash + spaces
    "St. Boniface",     # punctuation
    "Île-des-Chênes",   # diacritics: slugify intentionally strips them
    as.character(extra_inputs)
  ))
  pairs <- lapply(inputs, function(s) list(input = s, slug = slugify(s)))
  tmp <- paste0(dest_path, ".tmpwrite")
  jsonlite::write_json(pairs, tmp, auto_unbox = TRUE, pretty = TRUE)
  if (file.exists(dest_path)) file.remove(dest_path)
  if (!file.rename(tmp, dest_path)) stop("rename failed: ", tmp, " -> ", dest_path)
  dest_path
}
