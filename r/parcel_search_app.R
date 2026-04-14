# parcel_search_app.R
# Shiny app to search Winnipeg Survey Parcels by partial legal description
# and display results on an interactive map.
#
# Reads the most recent SurveyParcels .gpkg file and (if available) the
# matching ParcelCrossRef .csv to show assessment roll numbers.
#
# Requires: shiny, sf, leaflet, DT

library(shiny)
library(sf)
library(leaflet)
library(DT)

data_dir <- "D:/Dropbox/Appraisal/Maps/Winnipeg/OpenData"

# --- Find the most recent Survey Parcels .gpkg ---
gpkg_files <- sort(
  list.files(data_dir, pattern = "^SurveyParcels_\\d{8}\\.gpkg$", full.names = TRUE),
  decreasing = TRUE
)
if (length(gpkg_files) == 0) stop("No SurveyParcels .gpkg found in ", data_dir)
gpkg_path <- gpkg_files[1]
gpkg_date <- regmatches(basename(gpkg_path), regexpr("\\d{8}", basename(gpkg_path)))
layer_name <- st_layers(gpkg_path)$name[1]

# --- Load cross-reference CSV if available ---
xref_file <- file.path(data_dir, paste0("ParcelCrossRef_", gpkg_date, ".csv"))
if (!file.exists(xref_file)) {
  # Try any cross-reference file
  xref_files <- sort(
    list.files(data_dir, pattern = "^ParcelCrossRef_\\d{8}\\.csv$", full.names = TRUE),
    decreasing = TRUE
  )
  if (length(xref_files) > 0) xref_file <- xref_files[1]
}
has_xref <- file.exists(xref_file)
if (has_xref) {
  xref <- read.csv(xref_file, stringsAsFactors = FALSE)
  cat("Loaded cross-reference:", basename(xref_file), "-", nrow(xref), "rows\n")
}

cat("Using:", basename(gpkg_path), "- layer:", layer_name, "\n")

# --- UI ---
ui <- fluidPage(
  titlePanel(paste("Winnipeg Survey Parcel Search -", gpkg_date)),

  fluidRow(
    column(3, textInput("plan", "Plan (contains)")),
    column(3, textInput("lot", "Lot (contains)")),
    column(3, textInput("block", "Block (contains)")),
    column(3, textInput("desc", "Description (contains)"))
  ),

  fluidRow(
    column(6, actionButton("search", "Search", class = "btn-primary")),
    column(6, textOutput("count"))
  ),

  br(),
  leafletOutput("map", height = "500px"),
  br(),
  DTOutput("table")
)

# --- Server ---
server <- function(input, output, session) {

  results <- eventReactive(input$search, {
    clauses <- c()
    if (nzchar(input$plan))  clauses <- c(clauses, paste0("plan LIKE '%", input$plan, "%'"))
    if (nzchar(input$lot))   clauses <- c(clauses, paste0("lot LIKE '%", input$lot, "%'"))
    if (nzchar(input$block)) clauses <- c(clauses, paste0("block LIKE '%", input$block, "%'"))
    if (nzchar(input$desc))  clauses <- c(clauses, paste0("description LIKE '%", input$desc, "%'"))

    if (length(clauses) == 0) return(NULL)

    where <- paste(clauses, collapse = " AND ")
    sql <- paste0("SELECT * FROM \"", layer_name, "\" WHERE ", where, " LIMIT 500")

    tryCatch(
      st_read(gpkg_path, query = sql, quiet = TRUE),
      error = function(e) {
        showNotification(paste("Query error:", e$message), type = "error")
        NULL
      }
    )
  })

  # Join cross-reference data to results
  results_with_xref <- reactive({
    r <- results()
    if (is.null(r) || nrow(r) == 0 || !has_xref) return(r)

    # Match on lot/block/plan
    r_df <- st_drop_geometry(r)
    merged <- merge(
      r_df, xref[, c("Lot", "Block", "Plan", "Roll_Number", "Full_Address", "Zoning")],
      by.x = c("lot", "block", "plan"),
      by.y = c("Lot", "Block", "Plan"),
      all.x = TRUE
    )
    # Remove duplicate rows
    merged <- unique(merged)
    merged
  })

  output$count <- renderText({
    r <- results()
    if (is.null(r)) return("Enter at least one search field.")
    n <- nrow(r)
    msg <- paste(n, "parcels found")
    if (n == 500) msg <- paste(msg, "(limit reached - refine your search)")
    msg
  })

  output$map <- renderLeaflet({
    r <- results()
    if (is.null(r) || nrow(r) == 0) {
      return(
        leaflet() %>%
          addProviderTiles("CartoDB.Positron") %>%
          setView(lng = -97.14, lat = 49.89, zoom = 11)
      )
    }

    # Build labels
    labels <- paste0(
      "<b>Lot </b>", r$lot,
      " <b>Block </b>", r$block,
      " <b>Plan </b>", r$plan,
      ifelse(is.na(r$description) | r$description == "", "",
             paste0("<br>", r$description))
    )

    leaflet(r) %>%
      addProviderTiles("CartoDB.Positron") %>%
      addPolygons(
        fillColor   = "steelblue",
        fillOpacity = 0.4,
        weight      = 2,
        color       = "navy",
        label       = lapply(labels, htmltools::HTML),
        highlightOptions = highlightOptions(
          weight      = 4,
          color       = "red",
          fillOpacity = 0.6,
          bringToFront = TRUE
        )
      )
  })

  output$table <- renderDT({
    rx <- results_with_xref()
    if (is.null(rx) || nrow(rx) == 0) return(NULL)

    # Select display columns
    cols <- c("lot", "block", "plan", "description")
    if (has_xref && "Roll_Number" %in% names(rx)) {
      cols <- c(cols, "Roll_Number", "Full_Address", "Zoning")
    }
    display <- rx[, intersect(cols, names(rx)), drop = FALSE]
    names(display) <- gsub("_", " ", names(display))
    names(display) <- tools::toTitleCase(names(display))

    datatable(display, options = list(pageLength = 25, scrollX = TRUE),
              rownames = FALSE)
  })
}

shinyApp(ui, server)
