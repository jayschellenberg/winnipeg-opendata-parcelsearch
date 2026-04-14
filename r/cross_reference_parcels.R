# cross_reference_parcels.R
# Builds a cross-reference between Survey Parcels (legal descriptions) and
# Assessment Parcels (tax roll numbers) using a spatial join.
#
# Usage: Source this script after running download_parcels.R.
# It auto-detects the most recent pair of .gpkg files in the output directory.
#
# Output: ParcelCrossRef_YYYYMMDD.csv  (~20-30 MB)
#   Lean lookup table — join to the .gpkg files by Roll_Number or Survey_ID
#   when you need geometry.
#
# Requires: sf package

library(sf)

# --- Configuration ---
data_dir <- "D:/Dropbox/Appraisal/Maps/Winnipeg/OpenData"

# --- Find the most recent pair of .gpkg files ---
survey_files <- sort(
  list.files(data_dir, pattern = "^SurveyParcels_\\d{8}\\.gpkg$", full.names = TRUE),
  decreasing = TRUE
)
assess_files <- sort(
  list.files(data_dir, pattern = "^AssessmentParcels_\\d{8}\\.gpkg$", full.names = TRUE),
  decreasing = TRUE
)

if (length(survey_files) == 0 || length(assess_files) == 0) {
  stop("Missing .gpkg files. Run download_parcels.R first.")
}

# Use the most recent files
survey_file <- survey_files[1]
assess_file <- assess_files[1]

# Extract date stamp from the survey file name
date_stamp <- regmatches(basename(survey_file), regexpr("\\d{8}", basename(survey_file)))

# Skip if cross-reference already exists for this date
csv_file <- file.path(data_dir, paste0("ParcelCrossRef_", date_stamp, ".csv"))
if (file.exists(csv_file)) {
  cat("Cross-reference already exists:", basename(csv_file), "\n")
  cat("Delete it first if you want to rebuild.\n")
  stop("ParcelCrossRef already exists for this date.", call. = FALSE)
}

cat("=== Parcel Cross-Reference Builder ===\n")
cat("Survey Parcels: ", basename(survey_file), "\n")
cat("Assessment Parcels:", basename(assess_file), "\n\n")

# --- Read GeoPackage files ---
cat("Reading Survey Parcels... ")
survey <- st_read(survey_file, quiet = TRUE)
cat(nrow(survey), "features\n")

cat("Reading Assessment Parcels... ")
assess <- st_read(assess_file, quiet = TRUE)
cat(nrow(assess), "features\n\n")

# --- Ensure matching CRS ---
if (st_crs(survey) != st_crs(assess)) {
  cat("Reprojecting to common CRS...\n")
  assess <- st_transform(assess, st_crs(survey))
}

# Use a projected CRS for accurate area calculations
# UTM Zone 14N covers Winnipeg
crs_utm <- 32614
survey_proj <- st_transform(survey, crs_utm)
assess_proj <- st_transform(assess, crs_utm)

# Repair invalid geometries (common in municipal parcel data)
cat("Repairing invalid geometries...\n")
survey_proj <- st_make_valid(survey_proj)
assess_proj <- st_make_valid(assess_proj)

# Conversion factor: 1 m2 = 10.7639 sq ft
m2_to_sqft <- 10.7639

# Pre-compute areas in square feet
survey_proj$survey_area_sqft <- as.numeric(st_area(survey_proj)) * m2_to_sqft
assess_proj$assess_area_sqft <- as.numeric(st_area(assess_proj)) * m2_to_sqft

# --- Spatial join: find all intersections ---
cat("Finding intersections (this may take several minutes)...\n")
t0 <- Sys.time()

# st_intersects returns a sparse index list — much faster than a full join
ix <- st_intersects(survey_proj, assess_proj)

cat("  Intersection index built in", round(difftime(Sys.time(), t0, units = "mins"), 1), "min\n")

# --- Build the cross-reference table ---
cat("Building cross-reference table...\n")

# Expand the sparse list into row pairs
n_pairs <- sum(lengths(ix))
cat("  Found", n_pairs, "survey-assessment overlap pairs\n")

survey_idx <- rep(seq_along(ix), lengths(ix))
assess_idx <- unlist(ix)

# Compute intersection areas for overlap percentage
cat("Computing overlap areas (this may take several minutes)...\n")
t1 <- Sys.time()

# Process in chunks; compute each pair individually to handle topology errors
chunk_size <- 50000
n_chunks <- ceiling(n_pairs / chunk_size)
overlap_areas <- numeric(n_pairs)
n_errors <- 0L

for (i in seq_len(n_chunks)) {
  start <- (i - 1) * chunk_size + 1
  end <- min(i * chunk_size, n_pairs)

  for (j in start:end) {
    overlap_areas[j] <- tryCatch(
      {
        piece <- st_intersection(
          st_geometry(survey_proj)[survey_idx[j]],
          st_geometry(assess_proj)[assess_idx[j]]
        )
        if (length(piece) == 0) 0 else as.numeric(st_area(piece)) * m2_to_sqft
      },
      error = function(e) {
        n_errors <<- n_errors + 1L
        0  # treat failed intersections as zero overlap
      }
    )
  }

  cat("  Chunk", i, "of", n_chunks, "complete\n")
}

if (n_errors > 0) {
  cat("  Note:", n_errors, "pairs skipped due to geometry errors (recorded as 0 overlap)\n")
}
cat("  Overlap areas computed in", round(difftime(Sys.time(), t1, units = "mins"), 1), "min\n")

# Assemble the cross-reference table (no geometry — keeps CSV lean)
xref <- data.frame(
  Roll_Number        = as.character(assess_proj$roll_number[assess_idx]),
  Full_Address       = as.character(assess_proj$full_address[assess_idx]),
  Zoning             = as.character(assess_proj$zoning[assess_idx]),
  Assess_Lat         = as.numeric(assess_proj$centroid_lat[assess_idx]),
  Assess_Lon         = as.numeric(assess_proj$centroid_lon[assess_idx]),
  Survey_ID          = as.character(survey_proj$id[survey_idx]),
  Lot                = as.character(survey_proj$lot[survey_idx]),
  Block              = as.character(survey_proj$block[survey_idx]),
  Plan               = as.character(survey_proj$plan[survey_idx]),
  Description        = as.character(survey_proj$description[survey_idx]),
  Survey_Area_sqft   = round(survey_proj$survey_area_sqft[survey_idx], 1),
  Assess_Area_sqft   = round(assess_proj$assess_area_sqft[assess_idx], 1),
  Overlap_Area_sqft  = round(overlap_areas, 1),
  Overlap_Pct_Survey = round(overlap_areas / survey_proj$survey_area_sqft[survey_idx] * 100, 1),
  Overlap_Pct_Assess = round(overlap_areas / assess_proj$assess_area_sqft[assess_idx] * 100, 1),
  stringsAsFactors   = FALSE
)

# Filter out trivial overlaps (edge-touching artifacts < 0.1% of either parcel)
xref <- xref[xref$Overlap_Pct_Survey >= 0.1 | xref$Overlap_Pct_Assess >= 0.1, ]

# Sort by Roll_Number then Plan/Block/Lot for easy browsing
xref <- xref[order(xref$Roll_Number, xref$Plan, xref$Block, xref$Lot), ]

# --- Save cross-reference CSV ---
write.csv(xref, csv_file, row.names = FALSE)
csv_mb <- round(file.size(csv_file) / 1024^2, 1)

cat("\nTotal time:", round(difftime(Sys.time(), t0, units = "mins"), 1), "min\n")
cat("\nSaved:", basename(csv_file), "(", csv_mb, "MB,", nrow(xref), "rows )\n")
cat("  Open in Excel and filter by Roll_Number or Lot/Block/Plan.\n")
cat("  For geometry, load the matching .gpkg files in R or QGIS.\n")
cat("\nDone.\n")
