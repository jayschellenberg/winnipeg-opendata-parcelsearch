# Tippecanoe invocation helpers for build_parcel_tiles.R.
# Pure path/argument logic lives here so it can be tested without fetching
# 245,000 parcels first -- see r/test_tippecanoe.R, which also does a real
# two-feature tippecanoe run to prove the WSL dispatch itself works.
#
# WSL is the runtime (Ubuntu here has tippecanoe v2.80.0 at
# /usr/local/bin/tippecanoe). Docker is deliberately NOT used by the
# unattended bi-monthly job: Docker Desktop's daemon is frequently not
# running at 03:00, which would strand the build.

# WSL sees the Windows drives under /mnt/<drive letter>. None of the paths
# involved contains a space, so system2() needs no extra quoting.
to_wsl_path <- function(p) {
  p <- gsub("\\\\", "/", p)
  if (grepl("^[A-Za-z]:", p)) p <- paste0("/mnt/", tolower(substr(p, 1, 1)), substring(p, 3))
  p
}

# Flag choices (locked in after a Karpathy round on the live overlay):
#   --maximum-zoom=18    : enough detail at parcel scale
#   --minimum-zoom=8     : THE FLOOR IS MEASURED, NOT ASSUMED -- see below
#   --simplification=2   : gentle Douglas-Peucker -- preserves rectangle
#                          corners on small city lots
#   --full-detail=14     : default 12 means a 4096-quantum grid per tile;
#                          14 = 16384 = 4x more precise corners
#   --no-feature-limit   : never cap the feature COUNT in a tile
#   --drop-densest-as-needed
#                        : but do thin the densest tiles when one would blow
#                          past --maximum-tile-bytes. This is what makes the
#                          low zooms affordable: z8 is a single tile covering
#                          the whole city, and without thinning it would carry
#                          all ~217k parcels. Dropping only ever kicks in on an
#                          oversized tile, which at these zooms means parcels
#                          that are sub-pixel and unclickable anyway.
#   --maximum-tile-bytes=2000000
#                        : 2 MB, 4x tippecanoe's 500 KB default. The previous
#                          flag set used --no-tile-size-limit, i.e. no cap at
#                          all, and the dense downtown z13-z18 tiles were built
#                          under that rule -- they must not start losing
#                          parcels now. A cap this generous binds only on the
#                          newly added z8-z12 tiles. Do NOT re-add
#                          --no-tile-size-limit: with no cap,
#                          --drop-densest-as-needed can never fire and every
#                          one of z8-z12 would carry the entire city.
#   --force              : overwrite any existing output
#
# THE ZOOM FLOOR IS MEASURED, NOT ASSUMED
#
# This was --minimum-zoom=13, on the reasoning that "below zoom 13 every parcel
# is sub-pixel anyway, so generating those tiles would only inflate the
# archive". The parcels are indeed sub-pixel down there; that was never the
# question. The question is what zoom the CAMERA sits at, and the camera is
# routinely below 13:
#
#   * The app opens at zoom 11 (initMap in web/src/map.js) and "reset view"
#     flies back to zoom 11. So at the default citywide view -- the extent
#     every session starts in -- the archive had no tiles at all. Toggling
#     "All Assessment Parcels" flipped the layers to visible and relabelled the
#     button "Hide All Assessment Parcels" while rendering NOTHING. Measured in
#     a browser 2026-08-24: 0 tiles requested, 0 features rendered, no warning.
#   * Search results call fitBounds(padding = 60, maxZoom = 18). Measured over
#     all 4,239 street_name groups in d4mq-wa44: on a 900x520 map pane, 133 of
#     them fit below z13; on a 545x319 pane, 318 do. Not obscure streets --
#     MAIN fits at z10.28, PEMBINA z10.42, ST MARY'S z10.34, PORTAGE z11.36,
#     HENDERSON z11.78, GRANT z11.20, KENASTON z11.62, MCPHILLIPS z11.16.
#   * The whole-city extent fits at z8.33 (545x319 pane) to z10.10 (1400x800).
#
# z8 is the lowest of those, so that is the floor. The sister Manitoba project
# hit the identical bug from the identical assumption and also landed on z8
# (MBOpenData/mb-parcelsearch, DOCUMENTATION.md 3.6). Re-measure before raising
# it -- r/test_tippecanoe.R asserts the floor still covers APP_OPENING_ZOOM.
TIPPECANOE_FLAGS <- c(
  "--maximum-zoom=18", "--minimum-zoom=8",
  "--simplification=2", "--full-detail=14",
  "--no-feature-limit", "--drop-densest-as-needed",
  "--maximum-tile-bytes=2000000", "--force"
)

# The zoom the app's map opens at, and flies back to on "reset view"
# (web/src/map.js: `zoom: 11` in initMap, and the matching flyTo). The floor
# above MUST be <= this, or the overlay is blank at the extent every session
# starts in. Asserted in r/test_tippecanoe.R.
APP_OPENING_ZOOM <- 11

# The three named layers the web app reads: parcel polygons, one label point
# per parcel, and one label point per condominium address group. The layer
# NAMES are load-bearing -- map.js addresses them as source-layers.
tippecanoe_args <- function(out_file, polygons, centroids, condo_centroids,
                            flags = TIPPECANOE_FLAGS) {
  c(
    "tippecanoe",
    "-o", to_wsl_path(out_file),
    "-L", paste0("parcels:", to_wsl_path(polygons)),
    "-L", paste0("parcels-labels:", to_wsl_path(centroids)),
    "-L", paste0("dwelling-condo-labels:", to_wsl_path(condo_centroids)),
    flags
  )
}
