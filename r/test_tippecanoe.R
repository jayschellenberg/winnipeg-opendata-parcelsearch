script_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
script_dir <- if (length(script_arg)) dirname(normalizePath(sub("^--file=", "", script_arg[1]))) else getwd()
source(file.path(script_dir, "lib_tippecanoe.R"))

# --- Path translation ------------------------------------------------
stopifnot(
  identical(to_wsl_path("D:/Dropbox/x/y.geojson"), "/mnt/d/Dropbox/x/y.geojson"),
  identical(to_wsl_path("D:\\Dropbox\\x\\y.geojson"), "/mnt/d/Dropbox/x/y.geojson"),
  identical(to_wsl_path("C:/Users/Jason/t.pmtiles"), "/mnt/c/Users/Jason/t.pmtiles"),
  # Lower-cased drive letter: /mnt/D does not exist.
  identical(to_wsl_path("D:/x"), "/mnt/d/x"),
  # An already-POSIX path must pass through untouched.
  identical(to_wsl_path("/mnt/d/already/posix"), "/mnt/d/already/posix")
)

# --- Argument construction -------------------------------------------
args <- tippecanoe_args("D:/out/parcels.pmtiles", "D:/in/p.geojson",
                        "D:/in/c.geojson", "D:/in/d.geojson")
stopifnot(
  identical(args[1], "tippecanoe"),
  identical(args[which(args == "-o") + 1L], "/mnt/d/out/parcels.pmtiles"),
  # The three layer NAMES are load-bearing: map.js addresses each as a
  # source-layer, so a rename here silently empties an overlay.
  "parcels:/mnt/d/in/p.geojson" %in% args,
  "parcels-labels:/mnt/d/in/c.geojson" %in% args,
  "dwelling-condo-labels:/mnt/d/in/d.geojson" %in% args,
  sum(args == "-L") == 3L,
  "--maximum-zoom=18" %in% args,
  "--no-feature-limit" %in% args,
  "--force" %in% args,
  # --no-tile-size-limit would make --drop-densest-as-needed a no-op, so the
  # low zooms would each carry all ~217k parcels. See lib_tippecanoe.R.
  !("--no-tile-size-limit" %in% args),
  "--drop-densest-as-needed" %in% args,
  "--maximum-tile-bytes=2000000" %in% args
)

# --- The zoom floor must reach the camera ----------------------------
# The overlay is citywide and the app opens at APP_OPENING_ZOOM; a floor above
# it renders nothing at the extent every session starts in, with the toggle
# reading "Hide All Assessment Parcels" the whole time. That is the bug this
# assertion exists to prevent coming back -- it shipped once, at floor 13
# against an opening zoom of 11.
min_zoom_flag <- grep("^--minimum-zoom=", args, value = TRUE)
stopifnot(length(min_zoom_flag) == 1L)
tile_floor <- as.integer(sub("^--minimum-zoom=", "", min_zoom_flag))
stopifnot(
  !is.na(tile_floor),
  tile_floor <= APP_OPENING_ZOOM
)
cat(sprintf("zoom floor z%d covers the app's opening zoom z%d
",
            tile_floor, APP_OPENING_ZOOM))

# The opening zoom is read out of the app source rather than restated here,
# so changing `zoom: 11` in map.js without rebuilding the tiles fails this
# test instead of silently blanking the overlay again.
map_js <- file.path(dirname(script_dir), "web", "src", "map.js")
if (file.exists(map_js)) {
  src <- readLines(map_js, warn = FALSE)
  init_line <- grep("^[[:space:]]*zoom:[[:space:]]*[0-9]", src, value = TRUE)
  zooms <- unique(as.numeric(sub("^[[:space:]]*zoom:[[:space:]]*([0-9.]+).*$", "\\1", init_line)))
  zooms <- zooms[!is.na(zooms)]
  stopifnot(length(zooms) >= 1L)
  if (!all(zooms == APP_OPENING_ZOOM)) {
    stop("map.js sets the camera to zoom ", paste(zooms, collapse = "/"),
         " but APP_OPENING_ZOOM in lib_tippecanoe.R says ", APP_OPENING_ZOOM,
         ". Re-measure the zoom floor before changing either.")
  }
  cat(sprintf("map.js opening zoom (%s) agrees with APP_OPENING_ZOOM
",
              paste(zooms, collapse = "/")))
} else {
  cat("SKIP map.js opening-zoom cross-check: ", map_js, " not found
", sep = "")
}

cat("tippecanoe argument fixtures passed\n")

# --- Live WSL smoke test ---------------------------------------------
# Everything above is string logic. This exercises the part that actually
# breaks in an unattended run: that system2("wsl", ...) reaches tippecanoe,
# that the /mnt paths resolve from inside WSL, and that a real PMTiles
# archive comes back out. Two features, so it costs about a second.
#
# Skips (does not fail) where WSL/tippecanoe is absent, so this file stays
# runnable on a machine that only ever does manual Docker builds.
probe <- suppressWarnings(tryCatch(
  system2("wsl", c("tippecanoe", "--version"), stdout = TRUE, stderr = TRUE),
  error = function(e) NULL
))
if (is.null(probe) || !any(grepl("tippecanoe", probe, ignore.case = TRUE))) {
  cat("SKIP live tippecanoe smoke test: WSL tippecanoe not available here\n")
} else {
  cat("live tippecanoe: ", paste(probe, collapse = " "), "\n", sep = "")
  tmp <- file.path(tempdir(), "tippe-smoke")
  dir.create(tmp, showWarnings = FALSE, recursive = TRUE)
  poly_path  <- file.path(tmp, "p.geojson")
  cent_path  <- file.path(tmp, "c.geojson")
  condo_path <- file.path(tmp, "d.geojson")
  out_path   <- file.path(tmp, "smoke.pmtiles")

  writeLines(paste0(
    '{"type":"FeatureCollection","features":[{"type":"Feature",',
    '"properties":{"roll_number":"1","full_address":"1 TEST ST"},',
    '"geometry":{"type":"Polygon","coordinates":[[[-97.101,49.899],',
    '[-97.100,49.899],[-97.100,49.900],[-97.101,49.900],[-97.101,49.899]]]}}]}'
  ), poly_path)
  point_fc <- paste0(
    '{"type":"FeatureCollection","features":[{"type":"Feature",',
    '"properties":{"roll_number":"1","dwelling_unit_count":2},',
    '"geometry":{"type":"Point","coordinates":[-97.1005,49.8995]}}]}'
  )
  writeLines(point_fc, cent_path)
  writeLines(point_fc, condo_path)

  if (file.exists(out_path)) file.remove(out_path)
  smoke_args <- tippecanoe_args(out_path, poly_path, cent_path, condo_path)
  res <- suppressWarnings(system2("wsl", smoke_args, stdout = TRUE, stderr = TRUE))
  status <- attr(res, "status")
  if (!is.null(status) && status != 0) {
    stop("tippecanoe smoke run exited ", status, ":\n", paste(res, collapse = "\n"))
  }
  if (!file.exists(out_path) || file.size(out_path) == 0) {
    stop("tippecanoe smoke run produced no archive at ", out_path)
  }
  # PMTiles v3: 7-byte ASCII magic "PMTiles" then the version byte. Proves we
  # got a real archive and not, say, a directory of tiles from a mis-read
  # output extension -- the exact trap the .tmpbuild.pmtiles naming avoids.
  magic <- readBin(out_path, "raw", n = 8)
  stopifnot(
    identical(rawToChar(magic[1:7]), "PMTiles"),
    as.integer(magic[8]) == 3L
  )
  # The PMTiles v3 header carries min/max zoom at byte offsets 100 and 101.
  # Assert what tippecanoe actually WROTE, not just what we asked for: the
  # flag and the archive disagreeing is precisely how a blank overlay ships.
  # MapLibre reads these same two bytes to decide which tiles to request.
  hdr <- readBin(out_path, "raw", n = 127)
  archive_min <- as.integer(hdr[101])   # 1-based R index for byte offset 100
  archive_max <- as.integer(hdr[102])
  stopifnot(
    archive_min == tile_floor,
    archive_min <= APP_OPENING_ZOOM,
    archive_max == 18L
  )
  cat(sprintf("archive header zoom range z%d-z%d (floor covers z%d)
",
              archive_min, archive_max, APP_OPENING_ZOOM))
  cat(sprintf("live tippecanoe smoke test passed (%d bytes, PMTiles v3)\n", file.size(out_path)))
  unlink(tmp, recursive = TRUE)
}
