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
#   --minimum-zoom=13    : below zoom 13 every parcel is sub-pixel anyway, so
#                          generating those tiles would only inflate the archive
#   --simplification=2   : gentle Douglas-Peucker -- preserves rectangle
#                          corners on small city lots
#   --full-detail=14     : default 12 means a 4096-quantum grid per tile;
#                          14 = 16384 = 4x more precise corners
#   --no-feature-limit   : don't drop any parcel
#   --no-tile-size-limit : don't enforce the default 500 KB tile cap
#   --force              : overwrite any existing output
TIPPECANOE_FLAGS <- c(
  "--maximum-zoom=18", "--minimum-zoom=13",
  "--simplification=2", "--full-detail=14",
  "--no-feature-limit", "--no-tile-size-limit", "--force"
)

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
