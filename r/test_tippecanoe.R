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
  "--minimum-zoom=13" %in% args,
  "--no-feature-limit" %in% args,
  "--no-tile-size-limit" %in% args,
  "--force" %in% args
)

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
  cat(sprintf("live tippecanoe smoke test passed (%d bytes, PMTiles v3)\n", file.size(out_path)))
  unlink(tmp, recursive = TRUE)
}
