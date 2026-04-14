library(sf)
library(dplyr)
library(leaflet)

plan_search <- "45740"

matched <- st_read(
  "D:/Dropbox/Appraisal/Maps/Winnipeg/OpenData/SurveyParcels_20260406.geojson",
  query = paste0("SELECT * FROM SurveyParcels_20260406 WHERE plan = '", plan_search, "'")
)

leaflet(matched) %>%
  addProviderTiles("CartoDB.Positron") %>%
  addPolygons(
    fillColor = "steelblue",
    fillOpacity = 0.4,
    weight = 2,
    color = "navy",
    label = ~paste("Lot", lot, "Block", block)
  )