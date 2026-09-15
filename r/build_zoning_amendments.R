# build_zoning_amendments.R
#
# Zoning by-law amendments per parcel, scraped from the City's Decision Making
# Information System (DMIS). The City publishes no parcel-keyed amendment
# history: the zoning polygon dataset carries no by-law field, and Public
# Notices only lists rezonings from 2025 on. DMIS does list every amending
# Land Development by-law since 2001 (~850), one HTML page each, with the
# subject ("Rezoning: 3021 Pembina Highway (Riel)"), DAZ file number, date
# passed, effective date and the parent by-law. This script turns that into
# web/public/zoning-amendments.json:
#
#   byRoll[roll]  -> [{ bylaw, daz, kind, subject, passed, effective, amends,
#                       confidence, dmisId }]   site-specific amendments
#   nonParcel     -> the text / PDO / secondary-plan / procedures amendments
#                    that apply citywide or to an area, not a parcel (listed
#                    in the app, not mapped)
#   unresolved    -> site-specific subjects no address rule could place
#                    (also written to review.csv beside the HTML cache)
#
# Address resolution, three tiers, each tagged as `confidence`:
#   "address"  a civic address (or list / range) in the subject, geocoded
#              through Civic Addresses cam2-ii3u and joined point-in-polygon
#              to Assessment Parcels d4mq-wa44 (one SoQL intersects() per point)
#   "corner"   "corner of X and Y": the Road Network ngsx-caav centrelines
#              intersected, the parcels touching that corner (25 m), and the
#              quadrant word (southeast, ...) applied when the subject has one
#   "correction" a "Correction to By-law No. N/YYYY" inherits N/YYYY's parcels
#
# Every DMIS page is cached under D:/Dropbox/Appraisal/Web/WpgSnapshots/dmis so
# re-runs and audits never re-hit the site; --refresh refetches the list and
# any record pages new to it (record pages are immutable once passed).
#
# Usage:
#   Rscript r/build_zoning_amendments.R            # cached pages, live geocoding
#   Rscript r/build_zoning_amendments.R --refresh  # refetch the list first
#   Rscript r/build_zoning_amendments.R --limit 40 # first N by-laws (dev)
#   Rscript r/build_zoning_amendments.R --regeocode # re-place everything (rule change)

suppressPackageStartupMessages({
  library(httr2)
  library(xml2)
  library(jsonlite)
  library(sf)
})
sf::sf_use_s2(FALSE)

.SCRIPT_DIR <- local({
  fa <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  if (length(fa)) dirname(normalizePath(sub("^--file=", "", fa[1])))
  else if (!is.null(sys.frames()[[1]]$ofile)) dirname(normalizePath(sys.frames()[[1]]$ofile))
  else "."
})
REPO      <- normalizePath(file.path(.SCRIPT_DIR, ".."), winslash = "/")
CACHE_DIR <- "D:/Dropbox/Appraisal/Web/WpgSnapshots/dmis"
PAGE_DIR  <- file.path(CACHE_DIR, "bylaw")
GEO_CACHE <- file.path(CACHE_DIR, "geocode-cache.rds")
OUT_PATH  <- file.path(REPO, "web", "public", "zoning-amendments.json")
REVIEW    <- file.path(CACHE_DIR, "review.csv")

DMIS      <- "https://dmis.winnipeg.ca"
LIST_URL  <- paste0(DMIS, "/ByLaws?Status=Amending&Category=Land%20Development&Classification=All&ViewAll=true")
ADDR_URL  <- "https://data.winnipeg.ca/resource/cam2-ii3u.json"
PARCEL_URL<- "https://data.winnipeg.ca/resource/d4mq-wa44.json"
ROAD_URL  <- "https://data.winnipeg.ca/resource/ngsx-caav.geojson"
UA        <- "winnipeg-opendata-parcelsearch/zoning-amendments (github.com/jayschellenberg/winnipeg-opendata-parcelsearch)"

args    <- commandArgs(trailingOnly = TRUE)
refresh <- "--refresh" %in% args
regeocode <- "--regeocode" %in% args   # ignore the geocode cache (after a rule change)
lim_i   <- match("--limit", args)
limit   <- if (!is.na(lim_i) && lim_i < length(args)) as.integer(args[lim_i + 1]) else NA_integer_

log <- function(...) cat(format(Sys.time(), "%H:%M:%S"), " ", ..., "\n", sep = "")
dir.create(PAGE_DIR, showWarnings = FALSE, recursive = TRUE)

# ---- polite fetching --------------------------------------------------------
TOKEN <- Sys.getenv("VITE_SODA_APP_TOKEN", unset = Sys.getenv("SODA_APP_TOKEN", ""))
soda_req <- function(url, ...) {
  r <- request(url) |> req_user_agent(UA) |> req_url_query(...) |>
    req_retry(max_tries = 4, is_transient = function(x) resp_status(x) %in% c(429, 500, 502, 503))
  if (nzchar(TOKEN)) r <- req_headers(r, `X-App-Token` = TOKEN)
  r
}
soda_json <- function(url, ...) {
  resp <- req_perform(soda_req(url, ...))
  fromJSON(resp_body_string(resp), simplifyVector = TRUE)
}

fetch_cached <- function(url, path, force = FALSE, pause = 0.5) {
  if (!force && file.exists(path) && file.info(path)$size > 2000) return(readChar(path, file.info(path)$size, useBytes = TRUE))
  resp <- request(url) |> req_user_agent(UA) |>
    req_retry(max_tries = 4, is_transient = function(x) resp_status(x) %in% c(429, 500, 502, 503)) |>
    req_perform()
  body <- resp_body_string(resp)
  writeLines(body, path, useBytes = TRUE)
  Sys.sleep(pause)
  body
}

# ---- 1. the list ---------------------------------------------------------------
list_path <- file.path(CACHE_DIR, "bylaws-list.html")
log("List: ", if (refresh || !file.exists(list_path)) "fetching" else "cached")
list_html <- fetch_cached(LIST_URL, list_path, force = refresh)
doc <- read_html(list_html)
rows <- xml_find_all(doc, "//tr[td]")
bylaws <- do.call(rbind, lapply(rows, function(tr) {
  tds  <- xml_find_all(tr, "./td")
  if (length(tds) < 4) return(NULL)
  href <- xml_attr(xml_find_first(tr, ".//a[contains(@href,'bylawId=')]"), "href")
  id   <- sub(".*bylawId=(\\d+).*", "\\1", href)
  txt  <- trimws(gsub("\\s+", " ", xml_text(tds)))
  data.frame(dmisId = id, subject = txt[1],
             bylaw = trimws(strsplit(txt[2], " ")[[1]][1]),
             status = txt[3], category = txt[4], stringsAsFactors = FALSE)
}))
bylaws <- bylaws[!duplicated(bylaws$dmisId), ]
if (!is.na(limit)) bylaws <- head(bylaws, limit)
log("  ", nrow(bylaws), " amending Land Development by-laws")

# ---- 2. each record page ---------------------------------------------------------
value_after <- function(lines, label) {
  i <- match(label, lines)
  if (is.na(i) || i >= length(lines)) return(NA_character_)
  lines[i + 1]
}
parse_date <- function(s) {
  if (is.na(s)) return(NA_character_)
  d <- suppressWarnings(as.Date(s, format = "%b %d, %Y"))
  if (is.na(d)) NA_character_ else format(d, "%Y-%m-%d")
}
records <- vector("list", nrow(bylaws))
for (i in seq_len(nrow(bylaws))) {
  b <- bylaws[i, ]
  path <- file.path(PAGE_DIR, paste0(b$dmisId, ".html"))
  html <- tryCatch(fetch_cached(paste0(DMIS, "/ViewByLaw?bylawId=", b$dmisId), path),
                   error = function(e) { log("  fetch failed ", b$dmisId, ": ", conditionMessage(e)); NA })
  if (is.na(html)) next
  d <- read_html(html)
  lines <- trimws(xml_text(xml_find_all(d, "//body//text()[normalize-space()]")))
  records[[i]] <- list(
    dmisId = b$dmisId, bylaw = b$bylaw, subject = b$subject,
    daz = value_after(lines, "File number:"),
    passed = parse_date(value_after(lines, "Date passed:")),
    effective = parse_date(value_after(lines, "Effective date:")),
    amends = value_after(lines, "Amends:")
  )
  if (i %% 50 == 0) log("  ", i, "/", nrow(bylaws), " record pages")
}
records <- Filter(Negate(is.null), records)
log("  ", length(records), " record pages parsed")

# ---- 3. classify ---------------------------------------------------------------
classify <- function(subject) {
  s <- tolower(subject)
  if (grepl("^correction to by-law", s)) return("correction")
  if (grepl("^plan of subdivision and (rezoning|zoning change)", s)) return("subdivision-rezoning")
  if (grepl("^(rezoning|zoning change)\\b", s)) return("rezoning")
  "text"
}
for (i in seq_along(records)) records[[i]]$kind <- classify(records[[i]]$subject)
kinds <- table(vapply(records, `[[`, "", "kind"))
log("  kinds: ", paste(names(kinds), kinds, sep = "=", collapse = ", "))

# ---- 4. address rules --------------------------------------------------------------
TYPES <- c("Avenue", "Ave", "Street", "St", "Road", "Rd", "Drive", "Dr", "Boulevard", "Blvd",
           "Highway", "Hwy", "Crescent", "Cres", "Bay", "Way", "Place", "Pl", "Lane", "Trail",
           "Court", "Cove", "Gate", "Circle", "Terrace", "Row", "Walk", "Parkway", "Route",
           "Loop", "Path", "Ridge", "Point", "Grove", "Close", "Line", "Square", "Promenade")
TYPE_RX <- paste0("(?:", paste(TYPES, collapse = "|"), ")")
TYPE_ABBR <- c(AVENUE = "AVE", STREET = "ST", ROAD = "RD", DRIVE = "DR", BOULEVARD = "BLVD",
               HIGHWAY = "HWY", CRESCENT = "CRES", PLACE = "PL", PARKWAY = "PKWY", TERRACE = "TERR")
NAME_RX <- "((?:[A-Z][A-Za-z'.\\-]*\\s+){1,4}?)"
DIR_RX  <- "(?:\\s+(?:North|South|East|West|N\\.?|S\\.?|E\\.?|W\\.?))?"

strip_subject <- function(subject) {
  s <- sub("^(Plan of Subdivision and )?(Rezoning|Zoning Change)\\s*:\\s*", "", subject, perl = TRUE)
  s <- sub("\\s*\\([^()]*\\)\\s*$", "", s, perl = TRUE)   # trailing ward "(Riel)", "(City Centre)"
  s <- gsub("\\bLand located at\\b", "", s, perl = TRUE)
  trimws(s)
}

# "1266, 1300, 1330 and 1350 Dugald Road" / "123-127 Main Street" / "1010 Logan Avenue".
# Returns list of {numbers, street (name words), type (full word or NA)}.
extract_addresses <- function(s) {
  rx <- paste0("(\\d+[A-Za-z]?(?:\\s*(?:,|and|&|-|–|to)\\s*\\d+[A-Za-z]?)*)\\s+", NAME_RX, "(", TYPE_RX, ")\\b", DIR_RX)
  m <- gregexpr(rx, s, perl = TRUE)
  hits <- regmatches(s, m)[[1]]
  out <- list()
  for (h in hits) {
    parts <- regmatches(h, regexec(rx, h, perl = TRUE))[[1]]
    nums_raw <- parts[2]
    # cam2-ii3u stores names without punctuation: "St. Mary's Road" is "ST MARYS" + "RD".
    street <- gsub("[^A-Z0-9 ]", "", toupper(trimws(parts[3])))
    type <- toupper(parts[4])
    numbers <- integer(0)
    if (grepl("(-|–|\\bto\\b)", nums_raw)) {
      ends <- as.integer(gsub("[^0-9]", "", strsplit(nums_raw, "-|–|\\bto\\b")[[1]]))
      ends <- ends[!is.na(ends)]
      if (length(ends) >= 2) numbers <- c(min(ends), max(ends), -1L)   # -1 flags a range
    } else {
      numbers <- as.integer(gsub("[^0-9]", "", strsplit(nums_raw, ",|and|&")[[1]]))
      numbers <- numbers[!is.na(numbers)]
    }
    if (length(numbers)) out[[length(out) + 1]] <- list(numbers = numbers, street = street, type = type)
  }
  out
}

# "southeast corner of Templeton Avenue and McGregor Street"
extract_corner <- function(s) {
  rx <- paste0("(?:(north|south)\\s*-?\\s*(east|west)?|(north|south|east|west))?\\s*(?:corner|intersection)\\s+of\\s+",
               NAME_RX, "(", TYPE_RX, ")?\\s+and\\s+", NAME_RX, "(", TYPE_RX, ")?")
  m <- regmatches(s, regexec(rx, s, perl = TRUE, ignore.case = TRUE))[[1]]
  if (!length(m)) return(NULL)
  quad <- tolower(paste0(m[2], m[3], m[4]))
  list(quadrant = if (nzchar(quad)) quad else NA_character_,
       a = gsub("[^A-Z0-9 ]", "", toupper(trimws(m[5]))), b = gsub("[^A-Z0-9 ]", "", toupper(trimws(m[7]))))
}

# ---- 5. geocoding --------------------------------------------------------------------
geo <- if (file.exists(GEO_CACHE) && !regeocode) readRDS(GEO_CACHE) else list()
save_geo <- function() saveRDS(geo, GEO_CACHE)

# Civic-address points for a street name + civic numbers (or a range).
address_points <- function(street, numbers, type) {
  key <- paste("addr", street, paste(numbers, collapse = ","), sep = "|")
  if (!is.null(geo[[key]])) return(geo[[key]])
  where <- if (length(numbers) == 3 && numbers[3] == -1L) {
    sprintf("upper(street_name)='%s' AND street_number between '%d' and '%d'", gsub("'", "''", street), numbers[1], numbers[2])
  } else {
    sprintf("upper(street_name)='%s' AND street_number in (%s)", gsub("'", "''", street), paste(sprintf("'%d'", numbers), collapse = ","))
  }
  rows <- tryCatch(soda_json(ADDR_URL, `$select` = "street_number,street_name,street_type,full_address,point", `$where` = where, `$limit` = 200),
                   error = function(e) NULL)
  if (is.data.frame(rows) && nrow(rows) && !is.na(type) && nzchar(type)) {
    abbr <- if (type %in% names(TYPE_ABBR)) TYPE_ABBR[[type]] else type
    typed <- rows[toupper(rows$street_type) == abbr, ]
    if (nrow(typed)) rows <- typed
  }
  pts <- if (is.data.frame(rows) && nrow(rows)) {
    do.call(rbind, lapply(seq_len(nrow(rows)), function(k) {
      c <- rows$point$coordinates[[k]]
      data.frame(full_address = rows$full_address[k], lon = c[1], lat = c[2])
    }))
  } else data.frame(full_address = character(0), lon = numeric(0), lat = numeric(0))
  geo[[key]] <<- pts
  Sys.sleep(0.15)
  pts
}

# The assessment parcel(s) under a point, or touching a small polygon (WKT).
parcels_at <- function(wkt) {
  key <- paste("parcel", wkt, sep = "|")
  if (!is.null(geo[[key]])) return(geo[[key]])
  rows <- tryCatch(soda_json(PARCEL_URL, `$select` = "roll_number,full_address,centroid_lat,centroid_lon",
                             `$where` = sprintf("intersects(geometry,'%s')", wkt), `$limit` = 2000),
                   error = function(e) NULL)
  out <- if (is.data.frame(rows) && nrow(rows)) rows else data.frame(roll_number = character(0), full_address = character(0), centroid_lat = character(0), centroid_lon = character(0))
  geo[[key]] <<- out
  Sys.sleep(0.15)
  out
}

# Road Network centrelines for a street (all types), as one sf lines object.
road_lines <- function(street) {
  key <- paste("road", street, sep = "|")
  if (!is.null(geo[[key]])) return(geo[[key]])
  resp <- tryCatch(req_perform(soda_req(ROAD_URL, `$select` = "full_name,st_name,the_geom",
                                        `$where` = sprintf("upper(st_name)='%s'", gsub("'", "''", street)), `$limit` = 5000)),
                   error = function(e) NULL)
  g <- if (!is.null(resp)) tryCatch(sf::st_read(resp_body_string(resp), quiet = TRUE), error = function(e) NULL) else NULL
  if (is.null(g) || nrow(g) == 0) g <- NULL
  geo[[key]] <<- g
  Sys.sleep(0.15)
  g
}

corner_points <- function(a, b) {
  ga <- road_lines(a); gb <- road_lines(b)
  if (is.null(ga) || is.null(gb)) return(NULL)
  pts <- tryCatch(suppressWarnings(sf::st_intersection(sf::st_union(sf::st_geometry(ga)), sf::st_union(sf::st_geometry(gb)))),
                  error = function(e) NULL)
  if (is.null(pts) || length(pts) == 0 || all(sf::st_is_empty(pts))) return(NULL)
  pts <- sf::st_cast(sf::st_collection_extract(sf::st_sfc(pts, crs = 4326), "POINT"), "POINT")
  sf::st_coordinates(pts)
}

square_wkt <- function(lon, lat, m = 25) {
  dlat <- m / 111320; dlon <- m / (111320 * cos(lat * pi / 180))
  sprintf("POLYGON((%f %f,%f %f,%f %f,%f %f,%f %f))",
          lon - dlon, lat - dlat, lon + dlon, lat - dlat, lon + dlon, lat + dlat, lon - dlon, lat + dlat, lon - dlon, lat - dlat)
}

in_quadrant <- function(parcels, lon, lat, quad) {
  if (is.na(quad) || !nrow(parcels)) return(parcels)
  cl <- as.numeric(parcels$centroid_lon); ct <- as.numeric(parcels$centroid_lat)
  keep <- rep(TRUE, nrow(parcels))
  if (grepl("north", quad)) keep <- keep & ct > lat
  if (grepl("south", quad)) keep <- keep & ct < lat
  if (grepl("east",  quad)) keep <- keep & cl > lon
  if (grepl("west",  quad)) keep <- keep & cl < lon
  if (any(keep, na.rm = TRUE)) parcels[which(keep), ] else parcels
}

# ---- 6. resolve every site-specific by-law -----------------------------------------
by_roll <- list()
add_roll <- function(roll, entry) {
  roll <- as.character(roll)
  if (is.na(roll) || !nzchar(roll)) return(invisible())
  cur <- by_roll[[roll]]
  if (is.null(cur)) cur <- list()
  if (!any(vapply(cur, function(e) identical(e$bylaw, entry$bylaw), logical(1)))) by_roll[[roll]] <<- c(cur, list(entry))
  invisible()
}
resolved_rolls <- list()   # bylaw -> rolls (for corrections to inherit)
unresolved <- list()
non_parcel <- list()
entry_of <- function(r, confidence) {
  list(bylaw = r$bylaw, daz = r$daz, kind = r$kind, subject = r$subject, passed = r$passed,
       effective = r$effective, amends = r$amends, confidence = confidence, dmisId = r$dmisId)
}

site <- Filter(function(r) r$kind %in% c("rezoning", "subdivision-rezoning"), records)
log("Resolving ", length(site), " site-specific by-laws...")
for (i in seq_along(site)) {
  r <- site[[i]]
  s <- strip_subject(r$subject)
  rolls <- character(0)
  conf <- NA_character_
  addrs <- extract_addresses(s)
  if (length(addrs)) {
    for (a in addrs) {
      pts <- address_points(a$street, a$numbers, a$type)
      for (k in seq_len(nrow(pts))) {
        p <- parcels_at(sprintf("POINT(%f %f)", pts$lon[k], pts$lat[k]))
        rolls <- c(rolls, p$roll_number)
      }
    }
    if (length(rolls)) conf <- "address"
  }
  if (!length(rolls)) {
    cn <- extract_corner(s)
    if (!is.null(cn)) {
      xy <- corner_points(cn$a, cn$b)
      if (!is.null(xy)) {
        for (k in seq_len(nrow(xy))) {
          p <- parcels_at(square_wkt(xy[k, 1], xy[k, 2]))
          p <- in_quadrant(p, xy[k, 1], xy[k, 2], cn$quadrant)
          rolls <- c(rolls, p$roll_number)
        }
        if (length(rolls)) conf <- "corner"
      }
    }
  }
  rolls <- unique(rolls[!is.na(rolls) & nzchar(rolls)])
  if (length(rolls)) {
    resolved_rolls[[r$bylaw]] <- rolls
    for (roll in rolls) add_roll(roll, entry_of(r, conf))
  } else {
    unresolved[[length(unresolved) + 1]] <- list(bylaw = r$bylaw, dmisId = r$dmisId, subject = r$subject,
      reason = if (length(addrs)) "address not found in cam2-ii3u / no parcel under it"
               else if (!is.null(extract_corner(s))) "corner streets not found in the road network"
               else "no address or corner in the subject")
  }
  if (i %% 25 == 0) { log("  ", i, "/", length(site), " (", length(by_roll), " rolls so far)"); save_geo() }
}
save_geo()

# Corrections inherit the corrected by-law's parcels; text amendments are listed.
for (r in records) {
  if (r$kind == "correction") {
    target <- regmatches(r$subject, regexpr("\\d+/\\d{4}", r$subject))
    rolls <- if (length(target)) resolved_rolls[[target]] else NULL
    if (length(rolls)) {
      for (roll in rolls) add_roll(roll, entry_of(r, "correction"))
    } else {
      non_parcel[[length(non_parcel) + 1]] <- entry_of(r, NA_character_)
    }
  } else if (r$kind == "text") {
    non_parcel[[length(non_parcel) + 1]] <- entry_of(r, NA_character_)
  }
}

# ---- 7. write ----------------------------------------------------------------------
counts <- list(
  bylaws = length(records),
  siteSpecific = length(site),
  resolvedBylaws = length(resolved_rolls),
  rolls = length(by_roll),
  unresolved = length(unresolved),
  nonParcel = length(non_parcel),
  byConfidence = as.list(table(unlist(lapply(by_roll, function(es) vapply(es, `[[`, "", "confidence")))))
)
out <- list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  source = list(list = LIST_URL, record = paste0(DMIS, "/ViewByLaw?bylawId=<dmisId>")),
  counts = counts,
  byRoll = by_roll,
  nonParcel = non_parcel,
  unresolved = unresolved
)
tmp <- paste0(OUT_PATH, ".tmpwrite")
writeLines(toJSON(out, auto_unbox = TRUE, null = "null", na = "null", pretty = FALSE, digits = NA), tmp)
renamed <- FALSE
for (attempt in 1:8) {
  if (file.exists(OUT_PATH)) file.remove(OUT_PATH)
  renamed <- suppressWarnings(file.rename(tmp, OUT_PATH))
  if (renamed) break
  Sys.sleep(1.5)
}
if (!renamed) stop("rename failed: ", tmp)
if (length(unresolved)) {
  write.csv(do.call(rbind, lapply(unresolved, as.data.frame, stringsAsFactors = FALSE)), REVIEW, row.names = FALSE)
}
log("Wrote ", OUT_PATH, " — ", counts$rolls, " rolls from ", counts$resolvedBylaws, "/", counts$siteSpecific,
    " site-specific by-laws (", paste(names(counts$byConfidence), unlist(counts$byConfidence), sep = "=", collapse = ", "),
    "); ", counts$unresolved, " unresolved -> ", REVIEW, "; ", counts$nonParcel, " non-parcel amendments listed.")
