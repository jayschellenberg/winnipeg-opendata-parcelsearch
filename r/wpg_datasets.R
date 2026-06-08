# wpg_datasets.R
#
# Single source of truth for the City of Winnipeg Open Data layers that get
# periodically downloaded + archived. Sourced by both r/download_parcels.R (the
# download list) and r/archive_snapshot.R (source patterns + provenance), so the
# two can't drift. Each entry: a download `name` (used in the dated filename
# "<name>_YYYYMMDD.gpkg"), the SODA `resource` id, the gpkg `layer` name, and a
# human `label` for the provenance sidecar.

WPG_DATASETS <- list(
  # --- Parcel / zoning / address core (sharded or archived for history) ---
  list(name = "Zoning",            resource = "dxrp-w6re", layer = "zoning",
       label = "City of Winnipeg — Zoning"),
  list(name = "AssessmentParcels", resource = "d4mq-wa44", layer = "assessment_parcels",
       label = "City of Winnipeg — Map of Assessment Parcels"),
  list(name = "SurveyParcels",     resource = "sjjm-nj47", layer = "survey_parcels",
       label = "City of Winnipeg — Map of Survey Parcels"),
  list(name = "Addresses",         resource = "cam2-ii3u", layer = "addresses",
       label = "City of Winnipeg — Addresses"),

  # --- OurWinnipeg policy areas (the Winnipeg "dev-plan" analog) ---
  list(name = "SecondaryPlanPrecinct", resource = "xh28-4smq", layer = "secondary_plan_precinct",
       label = "City of Winnipeg — OurWinnipeg Precinct (Secondary Plan)"),
  list(name = "SecondaryPlanRedev",    resource = "piz6-n3at", layer = "secondary_plan_redev",
       label = "City of Winnipeg — OurWinnipeg Major Redevelopment Site"),
  list(name = "InfillGuideline",       resource = "5guk-f7xw", layer = "infill_guideline",
       label = "City of Winnipeg — OurWinnipeg Mature Community (Infill Guideline)"),
  list(name = "MallsRegionalCentre",   resource = "wv32-jdtk", layer = "malls_regional_centre",
       label = "City of Winnipeg — OurWinnipeg Regional Mixed Use Centre"),
  list(name = "CorridorsUrban",        resource = "t4kh-5gtd", layer = "corridors_urban",
       label = "City of Winnipeg — OurWinnipeg Urban Mixed Use Corridor"),
  list(name = "CorridorsRegional",     resource = "ahzi-uwu2", layer = "corridors_regional",
       label = "City of Winnipeg — OurWinnipeg Regional Mixed Use Corridor")
)

wpg_source_url <- function(resource) sprintf("https://data.winnipeg.ca/resource/%s", resource)
