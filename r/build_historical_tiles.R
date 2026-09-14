# build_historical_tiles.R
#
# One PMTiles archive per historical snapshot, so the Historical (as-of-date)
# overlay streams the whole city instead of fetching neighbourhood GeoJSON
# shards (which capped a view at ~25 neighbourhoods and needed an Area
# picker). Input is the already-published wpg-parcel-history shards — the
# same simplified, neighbourhood-binned geometry the overlay drew before —
# so the tiles show exactly what the shards showed, plus:
#
#   * the size-change band vs TODAY's roll, baked in at build time
#     (`_sizeBand`, `_histArea`, `_curArea`, `_deltaPct`; the same rules as
#     web/src/lib/sizeChange.js: |Δ| > 25% major, > 5% minor, else same;
#     `gone` = roll absent from the current roll). The overlay used to compute
#     this in the browser from a bbox fetch of the current roll; here the
#     whole current roll is in hand, so `gone` is trustworthy everywhere.
#   * `_nbhd`, the neighbourhood slug, so a click can fetch that
#     neighbourhood's lineage file from the archive CDN.
#
# Layers (names are load-bearing — web/src/map.js reads them as
# source-layers): `parcels` (assessment parcels) and `survey` (survey lots),
# each only when the snapshot carries it.
#
# Output: web/public/wpg-hist-<snapshot>.pmtiles (gitignored) and the
# committed sidecar web/public/historical-tiles-meta.json (built date, per-
# snapshot file/bytes/sha256/feature counts/size-change summary). With
# --publish, each archive is copied to R2 (rclone remote `r2`, the same one
# rebuild_tiles.ps1 uses) and verified by size.
#
# Usage:
#   Rscript r/build_historical_tiles.R                     # every snapshot
#   Rscript r/build_historical_tiles.R --snapshot 2026-07-01
#   Rscript r/build_historical_tiles.R --publish           # build + upload
#   Rscript r/build_historical_tiles.R --publish-only      # upload what is built
#
# Runtime: tippecanoe via WSL (see r/lib_tippecanoe.R); ~245k parcels +
# ~263k survey lots per snapshot.

suppressPackageStartupMessages({
  library(sf)
  library(jsonlite)
  library(httr2)
})
sf::sf_use_s2(FALSE)

.SCRIPT_DIR <- local({
  fa <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  if (length(fa)) dirname(normalizePath(sub("^--file=", "", fa[1])))
  else if (!is.null(sys.frames()[[1]]$ofile)) dirname(normalizePath(sys.frames()[[1]]$ofile))
  else "."
})
source(file.path(.SCRIPT_DIR, "lib_tippecanoe.R"))

REPO         <- normalizePath(file.path(.SCRIPT_DIR, ".."), winslash = "/")
ARCHIVE_ROOT <- "D:/Dropbox/ClaudeCode/WpgOpenData/wpg-parcel-history"
PUBLIC_DIR   <- file.path(REPO, "web", "public")
WORK_DIR     <- file.path(PUBLIC_DIR, "hist-build")      # gitignored scratch
META_PATH    <- file.path(PUBLIC_DIR, "historical-tiles-meta.json")
R2_REMOTE    <- "r2:wpg-ortho"
CURRENT_URL  <- "https://data.winnipeg.ca/resource/d4mq-wa44.json"

# The overlay draws from zoom 12 (HISTORICAL_MIN_ZOOM in main.js); a floor one
# zoom below gives the camera slack. Otherwise the citywide flags, for the
# same reasons documented in lib_tippecanoe.R.
HIST_TIPPECANOE_FLAGS <- c(
  "--maximum-zoom=18", "--minimum-zoom=11",
  "--simplification=2", "--full-detail=14",
  "--no-feature-limit", "--drop-densest-as-needed",
  "--maximum-tile-bytes=2000000", "--force",
  "--quiet"   # no per-tile progress spew: a z18 run writes megabytes of it to the log
)

PARCEL_FIELDS <- c("roll_number", "full_address", "neighbourhood_area", "zoning",
                   "assessed_land_area", "total_assessed_value", "property_use_code")
SURVEY_FIELDS <- c("survey_id", "plan", "lot", "block", "description")

SIZE_MINOR_PCT <- 5
SIZE_MAJOR_PCT <- 25

# ---- args ------------------------------------------------------------
args         <- commandArgs(trailingOnly = TRUE)
arg_val      <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NA_character_ else args[i + 1] }
only_snap    <- arg_val("--snapshot")
publish      <- "--publish" %in% args || "--publish-only" %in% args
publish_only <- "--publish-only" %in% args

log <- function(...) cat(format(Sys.time(), "%H:%M:%S"), " ", ..., "\n", sep = "")

# ---- current roll: roll_number -> assessed_land_area ------------------------
# Lean columns, no geometry, big pages: the whole roll in a handful of calls.
fetch_current_areas <- function() {
  token <- Sys.getenv("VITE_SODA_APP_TOKEN", unset = Sys.getenv("SODA_APP_TOKEN", ""))
  with_token <- function(req) if (nzchar(token)) req_headers(req, `X-App-Token` = token) else req
  page <- 50000L
  offset <- 0L
  out <- list()
  repeat {
    resp <- request(CURRENT_URL) |> with_token() |>
      req_url_query(`$select` = "roll_number,assessed_land_area",
                    `$order` = "roll_number", `$limit` = page, `$offset` = offset) |>
      req_retry(max_tries = 3, is_transient = function(r) resp_status(r) %in% c(429, 500, 502, 503)) |>
      req_perform()
    rows <- fromJSON(resp_body_string(resp), simplifyVector = TRUE)
    n <- if (is.data.frame(rows)) nrow(rows) else 0L
    log("  current roll offset=", offset, " rows=", n)
    if (n == 0L) break
    out[[length(out) + 1]] <- rows
    if (n < page) break
    offset <- offset + page
  }
  df <- do.call(rbind, out)
  df$roll_number <- as.character(df$roll_number)
  df$assessed_land_area <- suppressWarnings(as.numeric(df$assessed_land_area))
  df <- df[!is.na(df$roll_number) & nzchar(df$roll_number), ]
  # A roll can repeat in the source (rare); keep the first positive area.
  df <- df[order(df$roll_number, -ifelse(is.na(df$assessed_land_area), -1, df$assessed_land_area)), ]
  df <- df[!duplicated(df$roll_number), ]
  log("  current roll: ", nrow(df), " rolls")
  df
}

# Same bands as web/src/lib/sizeChange.js.
size_band <- function(delta_pct) {
  a <- abs(delta_pct)
  ifelse(is.na(delta_pct), "unknown",
         ifelse(a > SIZE_MAJOR_PCT, "major", ifelse(a > SIZE_MINOR_PCT, "minor", "same")))
}

# The 2023 snapshot ships its numerics formatted ("81,501", "391,000.00");
# later ones are bare. Strip the separators before casting, or every 2023
# parcel comes out "unknown" with no land area (which is exactly what the
# first 2023 build did).
num_field <- function(v) suppressWarnings(as.numeric(gsub(",", "", as.character(v), fixed = TRUE)))

stamp_size_changes <- function(g, current) {
  hist_area <- num_field(g$assessed_land_area)
  cur_area  <- current$assessed_land_area[match(as.character(g$roll_number), current$roll_number)]
  present   <- as.character(g$roll_number) %in% current$roll_number
  delta     <- ifelse(present & hist_area > 0 & cur_area > 0, (cur_area - hist_area) / hist_area * 100, NA_real_)
  band      <- size_band(delta)
  band[present & !(hist_area > 0 & cur_area > 0)] <- "unknown"
  band[!present] <- "gone"
  g$assessed_land_area   <- hist_area
  g$total_assessed_value <- num_field(g$total_assessed_value)
  g$`_sizeBand` <- band
  g$`_histArea` <- ifelse(hist_area > 0, hist_area, NA_real_)
  g$`_curArea`  <- ifelse(present & cur_area > 0, cur_area, NA_real_)
  g$`_deltaPct` <- round(delta, 1)
  summary <- as.list(table(factor(band, levels = c("same", "minor", "major", "gone", "unknown"))))
  summary <- lapply(summary, as.integer)
  list(g = g, summary = summary)
}

# ---- shards -> one sf per layer -------------------------------------------
read_shards <- function(dir, keep) {
  files <- list.files(dir, pattern = "\\.json$", full.names = TRUE)
  if (!length(files)) return(NULL)
  parts <- vector("list", length(files))
  for (i in seq_along(files)) {
    slug <- sub("\\.json$", "", basename(files[i]))
    g <- tryCatch(sf::st_read(files[i], quiet = TRUE), error = function(e) NULL)
    if (is.null(g) || nrow(g) == 0) next
    for (k in keep) if (!k %in% names(g)) g[[k]] <- NA
    g <- g[, keep]
    g$`_nbhd` <- slug
    parts[[i]] <- g
  }
  parts <- parts[!vapply(parts, is.null, logical(1))]
  if (!length(parts)) return(NULL)
  g <- do.call(rbind, parts)
  # Every kept attribute as plain text or number: tippecanoe types per
  # feature, and a list column (the shards' detail_url object) would not
  # survive the GeoJSONSeq writer anyway.
  for (k in keep) if (is.list(g[[k]])) g[[k]] <- vapply(g[[k]], function(v) if (is.null(v)) NA_character_ else as.character(v[[1]]), character(1))
  sf::st_geometry(g) <- "geometry"
  g
}

write_seq <- function(g, path) {
  if (file.exists(path)) file.remove(path)
  sf::st_write(g, path, driver = "GeoJSONSeq",
               layer_options = c("COORDINATE_PRECISION=6", "RS=NO"), quiet = TRUE)
  path
}

sha256_of <- function(path) digest::digest(path, algo = "sha256", file = TRUE)

# ---- build one snapshot ---------------------------------------------------
build_snapshot <- function(snap, current) {
  log("== ", snap)
  snap_dir <- file.path(ARCHIVE_ROOT, snap)
  out_file <- file.path(PUBLIC_DIR, paste0("wpg-hist-", snap, ".pmtiles"))
  # Extension LAST: tippecanoe picks PMTiles vs MBTiles output by it, and a
  # `.pmtiles.tmpbuild` name silently produced a SQLite MBTiles archive.
  tmp_file <- sub("\\.pmtiles$", ".tmpbuild.pmtiles", out_file)
  dir.create(WORK_DIR, showWarnings = FALSE, recursive = TRUE)
  layer_args <- character(0)
  layers <- list()
  size_change <- NULL

  parcels <- read_shards(file.path(snap_dir, "parcels"), PARCEL_FIELDS)
  if (!is.null(parcels)) {
    log("  parcels: ", nrow(parcels), " features from shards")
    stamped <- stamp_size_changes(parcels, current)
    size_change <- stamped$summary
    p_path <- write_seq(stamped$g, file.path(WORK_DIR, paste0(snap, "-parcels.geojsonl")))
    layer_args <- c(layer_args, "-L", paste0("parcels:", to_wsl_path(p_path)))
    layers$parcels <- nrow(parcels)
    log("  size change vs current: ", paste(names(size_change), unlist(size_change), sep = "=", collapse = ", "))
  }
  survey <- read_shards(file.path(snap_dir, "survey"), SURVEY_FIELDS)
  if (!is.null(survey)) {
    log("  survey: ", nrow(survey), " features from shards")
    s_path <- write_seq(survey, file.path(WORK_DIR, paste0(snap, "-survey.geojsonl")))
    layer_args <- c(layer_args, "-L", paste0("survey:", to_wsl_path(s_path)))
    layers$survey <- nrow(survey)
  }
  if (!length(layer_args)) { log("  nothing to tile"); return(NULL) }

  log("  tippecanoe -> ", basename(out_file))
  args <- c("tippecanoe", "-o", to_wsl_path(tmp_file), layer_args, HIST_TIPPECANOE_FLAGS)
  status <- system2("wsl", args, stdout = "", stderr = "")
  if (status != 0 || !file.exists(tmp_file)) stop("tippecanoe failed for ", snap, " (exit ", status, ")")
  if (file.exists(out_file)) file.remove(out_file)
  if (!file.rename(tmp_file, out_file)) stop("rename failed: ", tmp_file)
  bytes <- file.info(out_file)$size
  log("  ", basename(out_file), " = ", round(bytes / 1e6, 1), " MB")
  list(
    file = basename(out_file), bytes = bytes, sha256 = sha256_of(out_file),
    built = format(Sys.Date(), "%Y-%m-%d"),
    layers = layers,
    size_change = size_change
  )
}

publish_snapshot <- function(entry) {
  local <- file.path(PUBLIC_DIR, entry$file)
  remote <- paste0(R2_REMOTE, "/", entry$file)
  log("  rclone copyto ", remote)
  status <- system2("rclone", c("copyto", local, remote, "--s3-no-check-bucket", "--stats-one-line", "--stats", "60s"),
                    stdout = "", stderr = "")
  if (status != 0) stop("rclone upload failed for ", entry$file, " (exit ", status, ")")
  ls <- tryCatch(fromJSON(paste(system2("rclone", c("lsjson", remote), stdout = TRUE), collapse = "")),
                 error = function(e) NULL)
  remote_bytes <- if (is.data.frame(ls) && nrow(ls)) ls$Size[1] else NA
  if (!identical(as.numeric(remote_bytes), as.numeric(entry$bytes))) {
    stop("R2 object size ", remote_bytes, " != local ", entry$bytes, " for ", entry$file)
  }
  log("  R2 verified: ", entry$file, " at ", entry$bytes, " bytes")
}

# ---- main -------------------------------------------------------------------
index <- fromJSON(file.path(ARCHIVE_ROOT, "index.json"), simplifyVector = FALSE)
snaps <- sort(names(index$snapshots))
if (!is.na(only_snap)) snaps <- intersect(snaps, only_snap)
if (!length(snaps)) stop("no snapshots to build")

meta <- if (file.exists(META_PATH)) fromJSON(META_PATH, simplifyVector = FALSE) else list(snapshots = list())
if (is.null(meta$snapshots)) meta$snapshots <- list()

if (!publish_only) {
  log("Fetching the current roll for size-change bands...")
  current <- fetch_current_areas()
  for (snap in snaps) {
    entry <- build_snapshot(snap, current)
    if (is.null(entry)) next
    entry$size_change_vs <- format(Sys.Date(), "%Y-%m-%d")
    entry$size_change_vs_rolls <- nrow(current)
    meta$snapshots[[snap]] <- entry
  }
  meta$built <- format(Sys.Date(), "%Y-%m-%d")
  meta$archive_generated <- index$generated
  meta$tippecanoe_flags <- HIST_TIPPECANOE_FLAGS
  tmp <- paste0(META_PATH, ".tmpwrite")
  writeLines(toJSON(meta, auto_unbox = TRUE, pretty = TRUE, null = "null", digits = NA), tmp)
  # The repo lives under Dropbox, whose sync client briefly locks a file it
  # has just seen change; the atomic rename lost that race once. Retry it.
  renamed <- FALSE
  for (attempt in 1:8) {
    if (file.exists(META_PATH)) file.remove(META_PATH)
    renamed <- suppressWarnings(file.rename(tmp, META_PATH))
    if (renamed) break
    Sys.sleep(1.5)
  }
  if (!renamed) stop("rename failed after retries: ", tmp)
  log("Wrote ", META_PATH)
}

if (publish) {
  for (snap in snaps) {
    entry <- meta$snapshots[[snap]]
    if (is.null(entry)) { log("  no build recorded for ", snap, "; skipping publish"); next }
    publish_snapshot(entry)
  }
}
log("Done.")
