# download_parcels.R
# Downloads City of Winnipeg Open Data parcel datasets and saves as GeoPackage (.gpkg).
# Run quarterly to build a historical archive of parcel boundaries and assessment data.
#
# Survey Parcels:    https://data.winnipeg.ca/City-Planning/Map-of-Survey-Parcels/tira-k3hi
# Assessment Parcels: https://data.winnipeg.ca/Assessment-Taxation-Corporate/Map-of-Assessment-Parcels/7shc-stst
#
# Requires: sf package

library(sf)

# Allow up to 30 minutes per download (Survey Parcels is ~1 GB)
options(timeout = 1800)

# Save files in the same folder as this script
output_dir <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch"

# Date stamp for filenames
date_stamp <- format(Sys.Date(), "%Y%m%d")

# Dataset definitions
datasets <- list(
  list(
    name  = "SurveyParcels",
    layer = "survey_parcels",
    url   = "https://data.winnipeg.ca/api/geospatial/sjjm-nj47?method=export&format=GeoJSON"
  ),
  list(
    name  = "AssessmentParcels",
    layer = "assessment_parcels",
    url   = "https://data.winnipeg.ca/api/geospatial/d4mq-wa44?method=export&format=GeoJSON"
  )
)

cat("=== Winnipeg Open Data Parcel Download ===\n")
cat("Date:", format(Sys.Date(), "%Y-%m-%d"), "\n")
cat("Output directory:", output_dir, "\n\n")

for (ds in datasets) {
  gpkg_name <- paste0(ds$name, "_", date_stamp, ".gpkg")
  gpkg_path <- file.path(output_dir, gpkg_name)

  # Skip if already downloaded today
  if (file.exists(gpkg_path)) {
    cat(ds$name, "- already downloaded today:", gpkg_name, "\n")
    next
  }

  # Download GeoJSON to a temp file, then convert to GeoPackage
  tmp_geojson <- tempfile(fileext = ".geojson")

  cat("Downloading", ds$name, "... ")
  tryCatch(
    {
      download.file(ds$url, destfile = tmp_geojson, mode = "wb", quiet = TRUE)
      dl_mb <- round(file.size(tmp_geojson) / 1024^2, 1)
      cat("OK (", dl_mb, "MB download )\n")

      cat("  Converting to GeoPackage... ")
      layer_data <- st_read(tmp_geojson, quiet = TRUE)
      st_write(layer_data, gpkg_path, layer = ds$layer, quiet = TRUE)
      gpkg_mb <- round(file.size(gpkg_path) / 1024^2, 1)
      cat("OK -", gpkg_mb, "MB ->", gpkg_name, "\n")
    },
    error = function(e) {
      cat("FAILED -", conditionMessage(e), "\n")
      if (file.exists(gpkg_path)) file.remove(gpkg_path)
    },
    finally = {
      if (file.exists(tmp_geojson)) file.remove(tmp_geojson)
    }
  )
}

cat("\nDone.\n")
