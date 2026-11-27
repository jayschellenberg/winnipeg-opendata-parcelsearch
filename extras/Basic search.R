library(sf)
library(dplyr)
library(leaflet)

plan_search <- "45740"

matched <- st_read(
  "D:/Dropbox/Appraisal/Maps/Winnipeg/OpenData/SurveyParcels_20260406.geojson",
  query = paste0("SELECT * FROM SurveyParcels_20260406 WHERE plan = '", plan_search, "'")
)

leaflet(matched) %>%
  addTiles(urlTemplate = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2r5c_1_12c531426d9aa092a601b7da", attribution = "&copy; OpenStreetMap contributors &copy; CARTO", options = tileOptions(subdomains = "abcd", maxZoom = 20)) %>%
  addPolygons(
    fillColor = "steelblue",
    fillOpacity = 0.4,
    weight = 2,
    color = "navy",
    label = ~paste("Lot", lot, "Block", block)
  )