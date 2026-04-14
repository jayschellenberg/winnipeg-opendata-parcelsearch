library(dplyr)
# Read just first 10 features
library(sf)
sample <- st_read("SurveyParcels_20260406.geojson", query = "SELECT * FROM SurveyParcels_20260406 LIMIT 10")
glimpse(sample)
