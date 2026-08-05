script_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
script_dir <- if (length(script_arg)) dirname(normalizePath(sub("^--file=", "", script_arg[1]))) else getwd()
source(file.path(script_dir, "lib_dwelling_units.R"))

stopifnot(
  identical(normalize_civic_address("1001-141 Wellington Crescent"), "141 WELLINGTON CRESCENT"),
  identical(normalize_civic_address("PH18-635 Ballantrae Drive"), "635 BALLANTRAE DRIVE"),
  identical(normalize_civic_address("Unit 12, 100 Main Street"), "100 MAIN STREET"),
  identical(normalize_civic_address("Suite A 55 Smith Street"), "55 SMITH STREET"),
  identical(normalize_civic_address("#7, 25 River Avenue"), "25 RIVER AVENUE"),
  is.na(normalize_civic_address("0 KINGS DRIVE")),
  identical(extract_pucs_code("CNRES - CONDO RESIDENTIAL"), "CNRES")
)

feature <- function(roll, address, pucs, du = NULL) {
  properties <- list(roll_number = roll, full_address = address, property_use_code = pucs)
  if (!is.null(du)) properties$dwelling_units <- du
  list(type = "Feature", properties = properties, geometry = list(type = "Point", coordinates = c(-97, 49)))
}

fixtures <- c(
  lapply(1:20, function(i) feature(i, sprintf("%d-141 WELLINGTON CRESCENT", i), "CNAPT - CONDO APARTMENT", 1)),
  lapply(1:20, function(i) feature(100 + i, sprintf("%d-200 MAIN STREET", i), "CNAPT - CONDO APARTMENT", 20)),
  list(feature(201, "1-300 RIVER AVENUE", "CNAPT - CONDO APARTMENT", 1)),
  list(feature(202, "300 RIVER AVENUE", "CNCMP - CONDO COMPLEX")),
  lapply(1:12, function(i) feature(300 + i, sprintf("%d-400 BROADWAY", i), "CNCMP - CONDO COMPLEX")),
  list(feature(401, "10 ELM STREET", "RESSD - DETACHED SINGLE DWELLING", 0)),
  list(feature(402, "12 ELM STREET", "RESDU - DUPLEX", 2)),
  list(feature(403, "14 ELM STREET", "COMMERCIAL", 50))
)

out <- annotate_dwelling_features(fixtures)
props <- lapply(out$features, `[[`, "properties")

stopifnot(
  props[[1]]$dwelling_unit_count == 20,
  props[[21]]$dwelling_unit_count == 20,
  props[[41]]$dwelling_unit_count == 1,
  props[[42]]$dwelling_unit_count == 1,
  props[[43]]$dwelling_unit_count == 12,
  props[[55]]$dwelling_unit_count == 1,
  props[[56]]$dwelling_unit_count == 2,
  is.null(props[[57]]$dwelling_unit_count),
  length(out$condo_groups) == 4,
  out$audit$eligible_records == 56
)

cat("dwelling-unit aggregation fixtures passed\n")

# --- PUCS classification drift ---------------------------------------
# Every residential-looking (CN*/RES*) code must be either counted or on the
# reviewed-exclusion list. Anything else is drift and must surface, because a
# silently-uncounted code makes the Dwelling Units overlay undercount with no
# visible symptom.
drift <- annotate_dwelling_features(list(
  feature(900, "1 A ST",  "RESSD - DETACHED SINGLE DWELLING", 1),  # counted
  feature(901, "2 A ST",  "RESOT - RESIDENTIAL OUTBUILDING"),      # reviewed exclusion
  feature(902, "3 A ST",  "CNVAC - CONDO VACANT"),                 # reviewed exclusion
  feature(903, "4 A ST",  "RESZZ - SOMETHING NEW"),                # unreviewed -> must flag
  feature(904, "5 A ST",  "CNZZZ - NEW CONDO KIND"),               # unreviewed -> must flag
  feature(905, "6 A ST",  "CMOFF - OFFICE")                        # not residential-looking
))$audit

stopifnot(
  # Both never-classified codes surface...
  setequal(names(drift$unreviewed), c("RESZZ", "CNZZZ")),
  # ...while knowingly-skipped ones stay quiet even though they are uncounted.
  all(c("RESOT", "CNVAC") %in% names(drift$unmatched)),
  !any(c("RESOT", "CNVAC") %in% names(drift$unreviewed)),
  # A commercial code is not residential-looking and must not appear at all.
  !("CMOFF" %in% names(drift$unmatched)),
  drift$eligible_records == 1
)

# The real dataset's four open questions as of 2026-08-05: none of them may be
# silently counted, and none may be silently dropped either.
stopifnot(
  !any(c("RESGC", "RESMB", "RESRM", "CNCST") %in% DWELLING_ALL_PUCS),
  !any(c("RESGC", "RESMB", "RESRM", "CNCST") %in% DWELLING_REVIEWED_EXCLUSIONS)
)

cat("PUCS classification drift fixtures passed\n")

square <- function(x0, y0, x1, y1) list(
  type = "Polygon",
  coordinates = list(list(c(x0, y0), c(x1, y0), c(x1, y1), c(x0, y1), c(x0, y0)))
)
geo_features <- list(
  feature(501, "1-500 TEST STREET", "CNAPT - CONDO APARTMENT", 1),
  feature(502, "2-500 TEST STREET", "CNAPT - CONDO APARTMENT", 1)
)
geo_features[[1]]$geometry <- square(-97.101, 49.899, -97.100, 49.900)
geo_features[[2]]$geometry <- square(-97.100, 49.899, -97.099, 49.900)
geo_annotated <- annotate_dwelling_features(geo_features)
geo_points <- build_condo_group_points(geo_annotated$features, geo_annotated$condo_groups)
stopifnot(nrow(geo_points$sf) == 1, geo_points$sf$dwelling_unit_count[1] == 2)

cat("dwelling-unit centroid fixtures passed\n")
