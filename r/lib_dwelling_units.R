# Dwelling-unit aggregation helpers for build_parcel_tiles.R.
# Pure list/string logic is kept here so it can be fixture-tested without
# downloading the assessment dataset or loading sf.

DWELLING_CONDO_PUCS <- c("CNAPT", "CNCMP", "CNDRH", "CNRES")
DWELLING_RESIDENTIAL_PUCS <- c(
  "RESAM", "RESAP", "RESDU", "RESMC", "RESMH", "RESMU", "RESPL",
  "RESRH", "RESSD", "RESSS", "RESTR", "RESSU", "RESMA"
)
DWELLING_ALL_PUCS <- c(DWELLING_CONDO_PUCS, DWELLING_RESIDENTIAL_PUCS)

extract_pucs_code <- function(value) {
  value <- toupper(trimws(ifelse(is.null(value) || is.na(value), "", as.character(value))))
  sub("\\s*-.*$", "", value)
}

normalize_civic_address <- function(value) {
  if (is.null(value) || length(value) == 0L || is.na(value)) return(NA_character_)
  address <- toupper(trimws(as.character(value)))
  address <- gsub("\\s+", " ", address)
  # Winnipeg assessment unit addresses normally use UNIT-STREETNUMBER, e.g.
  # 1001-141 WELLINGTON or PH18-635 BALLANTRAE. Also accept common textual
  # suite forms so a future source-format change does not split buildings.
  address <- sub("^(?:UNIT|SUITE|STE)\\s+[^ ,#-]+[, ]+", "", address, perl = TRUE)
  address <- sub("^#\\s*[^ ,#-]+[, ]+", "", address, perl = TRUE)
  address <- sub("^[A-Z0-9]+\\s*-\\s*(?=[0-9]+\\s)", "", address, perl = TRUE)
  address <- gsub("\\s+", " ", trimws(address))
  # Never group missing/placeholder civic addresses across the city.
  if (!nzchar(address) || grepl("^0(?:\\s|$)", address)) return(NA_character_)
  address
}

positive_number <- function(value) {
  number <- suppressWarnings(as.numeric(value))
  if (length(number) == 0L || !is.finite(number) || number <= 0) NA_real_ else number
}

annotate_dwelling_features <- function(features) {
  if (!length(features)) return(list(features = features, condo_groups = list(), audit = list()))

  codes <- vapply(features, function(f) extract_pucs_code(f$properties$property_use_code), character(1))
  eligible <- codes %in% DWELLING_ALL_PUCS
  condo <- codes %in% DWELLING_CONDO_PUCS
  addresses <- vapply(features, function(f) normalize_civic_address(f$properties$full_address), character(1))
  reported <- vapply(features, function(f) positive_number(f$properties$dwelling_units), numeric(1))

  condo_indices <- which(eligible & condo)
  condo_keys <- vapply(condo_indices, function(i) {
    if (!is.na(addresses[i])) return(addresses[i])
    roll <- features[[i]]$properties$roll_number
    paste0("__UNGROUPED__", ifelse(is.null(roll) || is.na(roll), i, as.character(roll)))
  }, character(1))
  grouped_indices <- split(condo_indices, condo_keys, drop = TRUE)
  condo_groups <- list()

  for (key in names(grouped_indices)) {
    indices <- grouped_indices[[key]]
    positive_count <- sum(is.finite(reported[indices]))
    record_fallback <- if (positive_count > 0L) positive_count else length(indices)
    reported_max <- if (positive_count > 0L) max(reported[indices], na.rm = TRUE) else 0
    display_count <- max(reported_max, record_fallback)
    method <- if (reported_max > 1 && reported_max >= record_fallback) {
      "assessment_reported"
    } else {
      "grouped_records"
    }
    group_address <- if (startsWith(key, "__UNGROUPED__")) NA_character_ else key
    group_codes <- paste(sort(unique(codes[indices])), collapse = ",")

    for (i in indices) {
      properties <- features[[i]]$properties
      properties$dwelling_unit_count <- display_count
      properties$dwelling_count_method <- method
      properties$dwelling_group_address <- group_address
      properties$dwelling_record_count <- record_fallback
      properties$dwelling_group_size <- length(indices)
      properties$dwelling_pucs_codes <- group_codes
      properties$dwelling_is_condo <- 1L
      features[[i]]$properties <- properties
    }
    condo_groups[[length(condo_groups) + 1L]] <- list(
      key = key,
      address = group_address,
      indices = indices,
      dwelling_unit_count = display_count,
      dwelling_count_method = method,
      dwelling_record_count = record_fallback,
      dwelling_group_size = length(indices),
      dwelling_pucs_codes = group_codes
    )
  }

  ordinary_indices <- which(eligible & !condo)
  for (i in ordinary_indices) {
    display_count <- if (is.finite(reported[i])) reported[i] else 1
    properties <- features[[i]]$properties
    properties$dwelling_unit_count <- display_count
    properties$dwelling_count_method <- if (is.finite(reported[i])) "assessment_reported" else "default_one"
    properties$dwelling_group_address <- addresses[i]
    properties$dwelling_record_count <- 1L
    properties$dwelling_group_size <- 1L
    properties$dwelling_pucs_codes <- codes[i]
    properties$dwelling_is_condo <- 0L
    features[[i]]$properties <- properties
  }

  residential_looking <- startsWith(codes, "CN") | startsWith(codes, "RES")
  unmatched <- sort(table(codes[residential_looking & !eligible]), decreasing = TRUE)
  included <- sort(table(codes[eligible]), decreasing = TRUE)
  invalid_condo_addresses <- sum(eligible & condo & is.na(addresses))

  list(
    features = features,
    condo_groups = condo_groups,
    audit = list(
      included = included,
      unmatched = unmatched,
      invalid_condo_addresses = invalid_condo_addresses,
      eligible_records = sum(eligible),
      condo_groups = length(condo_groups)
    )
  )
}

geojson_geometry_to_sfg <- function(geometry) {
  if (is.null(geometry$type) || is.null(geometry$coordinates)) return(NULL)
  ring_matrix <- function(ring) do.call(rbind, lapply(ring, function(x) as.numeric(unlist(x))))
  if (identical(geometry$type, "Polygon")) {
    return(sf::st_polygon(lapply(geometry$coordinates, ring_matrix)))
  }
  if (identical(geometry$type, "MultiPolygon")) {
    polygons <- lapply(geometry$coordinates, function(polygon) lapply(polygon, ring_matrix))
    return(sf::st_multipolygon(polygons))
  }
  NULL
}

build_condo_group_points <- function(features, condo_groups, projected_crs = 26914) {
  polygon_geometries <- list()
  polygon_group_ids <- integer()
  valid_groups <- list()
  skipped <- 0L

  for (group in condo_groups) {
    geometries <- Filter(Negate(is.null), lapply(group$indices, function(i) {
      geojson_geometry_to_sfg(features[[i]]$geometry)
    }))
    if (!length(geometries)) {
      skipped <- skipped + 1L
      next
    }
    group_id <- length(valid_groups) + 1L
    polygon_geometries <- c(polygon_geometries, geometries)
    polygon_group_ids <- c(polygon_group_ids, rep(group_id, length(geometries)))
    valid_groups[[group_id]] <- group
  }

  if (!length(valid_groups)) {
    empty <- data.frame(
      dwelling_group_address = character(), dwelling_unit_count = numeric(),
      dwelling_count_method = character(), dwelling_record_count = integer(),
      dwelling_group_size = integer(), dwelling_pucs_codes = character(),
      dwelling_is_condo = integer(), stringsAsFactors = FALSE
    )
    return(list(sf = sf::st_sf(empty, geometry = sf::st_sfc(crs = 4326)), skipped = skipped))
  }

  # Project once for the entire condo subset. Reprojecting inside the group
  # loop made the full 245k-record build needlessly expensive.
  polygons <- sf::st_sfc(polygon_geometries, crs = 4326)
  polygons <- suppressWarnings(sf::st_make_valid(polygons))
  projected <- sf::st_transform(polygons, projected_crs)
  member_centroids <- suppressWarnings(sf::st_centroid(projected))
  member_coordinates <- sf::st_coordinates(member_centroids)
  member_areas <- as.numeric(sf::st_area(projected))
  positions_by_group <- split(seq_along(projected), polygon_group_ids)
  projected_centroids <- lapply(seq_along(valid_groups), function(group_id) {
    positions <- positions_by_group[[as.character(group_id)]]
    weights <- member_areas[positions]
    if (!all(is.finite(weights)) || sum(weights) <= 0) weights <- rep(1, length(positions))
    # The centroid of a combined geometry collection is the area-weighted
    # average of its member centroids. Computing it numerically avoids tens of
    # thousands of per-group GEOS calls while preserving identical-footprint
    # condos and distinct small unit parcels alike.
    sf::st_point(c(
      weighted.mean(member_coordinates[positions, "X"], weights),
      weighted.mean(member_coordinates[positions, "Y"], weights)
    ))
  })
  point_geometries <- sf::st_transform(sf::st_sfc(projected_centroids, crs = projected_crs), 4326)

  rows <- lapply(valid_groups, function(group) {
    data.frame(
      dwelling_group_address = ifelse(is.na(group$address), "", group$address),
      dwelling_unit_count = group$dwelling_unit_count,
      dwelling_count_method = group$dwelling_count_method,
      dwelling_record_count = group$dwelling_record_count,
      dwelling_group_size = group$dwelling_group_size,
      dwelling_pucs_codes = group$dwelling_pucs_codes,
      dwelling_is_condo = 1L,
      stringsAsFactors = FALSE
    )
  })
  list(
    sf = sf::st_sf(do.call(rbind, rows), geometry = point_geometries),
    skipped = skipped
  )
}
