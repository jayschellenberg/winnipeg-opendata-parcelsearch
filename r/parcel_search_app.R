# parcel_search_app.R
# Shiny app to search Winnipeg Survey Parcels by partial legal description
# and display results on an interactive map.
#
# Reads any SurveyParcels_YYYYMMDD.gpkg file in `data_dir` and (when
# available) the matching ParcelCrossRef_YYYYMMDD.csv. A snapshot picker
# in the UI lets the user choose which dated archive to search — the
# point of keeping multiple snapshots is to look up parcels as they
# existed before later subdivisions/consolidations, which the live web
# tool can't do (it only knows the present).
#
# Requires: shiny, sf, leaflet, DT

library(shiny)
library(sf)
library(leaflet)
library(DT)

data_dir <- "D:/Dropbox/ClaudeCode/WpgOpenData/ParcelSearch"

# --- Discover every snapshot in the folder, sorted newest-first ---
gpkg_files <- sort(
  list.files(data_dir, pattern = "^SurveyParcels_\\d{8}\\.gpkg$", full.names = TRUE),
  decreasing = TRUE
)
if (length(gpkg_files) == 0) {
  stop(
    "No SurveyParcels_YYYYMMDD.gpkg found in ", data_dir,
    "\nRun r/download_parcels.R to fetch one."
  )
}

# Build the "date -> full path" lookup that drives the picker.
snapshot_dates <- regmatches(
  basename(gpkg_files),
  regexpr("\\d{8}", basename(gpkg_files))
)
# Format the dropdown labels: most-recent gets "(latest)" appended.
snapshot_labels <- snapshot_dates
snapshot_labels[1] <- paste0(snapshot_labels[1], " (latest)")
snapshot_choices <- setNames(gpkg_files, snapshot_labels)

cat(
  "Found", length(gpkg_files), "snapshot(s):",
  paste(snapshot_dates, collapse = ", "), "\n"
)

# --- UI ---
ui <- fluidPage(
  titlePanel("Winnipeg Survey Parcel Search"),

  fluidRow(
    column(
      4,
      selectInput(
        "snapshot",
        label = "Snapshot date:",
        choices = snapshot_choices,
        selected = gpkg_files[1]
      )
    ),
    column(8, htmlOutput("snapshot_info"))
  ),

  fluidRow(
    column(3, textInput("plan",  "Plan (contains)")),
    column(3, textInput("lot",   "Lot (contains)")),
    column(3, textInput("block", "Block (contains)")),
    column(3, textInput("desc",  "Description (contains)"))
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

  # current_gpkg() switches whenever the user picks a different snapshot.
  # Returns: list(path, date, layer). The layer name comes from the file
  # itself — different snapshots can in principle have different layer
  # names if the source schema ever changes.
  current_gpkg <- reactive({
    req(input$snapshot)
    path <- input$snapshot
    date <- regmatches(basename(path), regexpr("\\d{8}", basename(path)))
    list(
      path  = path,
      date  = date,
      layer = st_layers(path)$name[1]
    )
  })

  # current_xref() loads the ParcelCrossRef_YYYYMMDD.csv that matches the
  # selected snapshot. Falls back to NULL silently when no cross-ref CSV
  # exists for that date — search still works, just without roll numbers.
  current_xref <- reactive({
    date <- current_gpkg()$date
    xref_path <- file.path(data_dir, paste0("ParcelCrossRef_", date, ".csv"))
    if (!file.exists(xref_path)) return(NULL)
    list(
      data = read.csv(xref_path, stringsAsFactors = FALSE),
      path = xref_path
    )
  })

  # Tiny status banner under the picker so the user can see at a glance
  # which snapshot is loaded and whether a cross-ref CSV is available.
  output$snapshot_info <- renderUI({
    g <- current_gpkg()
    xr <- current_xref()
    pieces <- c(
      paste0("<b>Loaded:</b> ", basename(g$path)),
      if (!is.null(xr)) {
        paste0("<b>Cross-ref:</b> ", basename(xr$path),
               " (", nrow(xr$data), " rows)")
      } else {
        "<i>No cross-reference CSV for this date - roll numbers will be blank.</i>"
      }
    )
    HTML(paste(pieces, collapse = "<br>"))
  })

  # Re-running the query is gated on the Search button so changing the
  # snapshot picker alone doesn't fire a search. The user picks a date,
  # types criteria, then clicks Search.
  results <- eventReactive(input$search, {
    clauses <- c()
    if (nzchar(input$plan))  clauses <- c(clauses, paste0("plan LIKE '%",  input$plan,  "%'"))
    if (nzchar(input$lot))   clauses <- c(clauses, paste0("lot LIKE '%",   input$lot,   "%'"))
    if (nzchar(input$block)) clauses <- c(clauses, paste0("block LIKE '%", input$block, "%'"))
    if (nzchar(input$desc))  clauses <- c(clauses, paste0("description LIKE '%", input$desc, "%'"))
    if (length(clauses) == 0) return(NULL)

    where <- paste(clauses, collapse = " AND ")
    g <- current_gpkg()
    sql <- paste0("SELECT * FROM \"", g$layer, "\" WHERE ", where, " LIMIT 500")

    tryCatch(
      st_read(g$path, query = sql, quiet = TRUE),
      error = function(e) {
        showNotification(paste("Query error:", e$message), type = "error")
        NULL
      }
    )
  })

  # Attach roll/address/zoning from the cross-ref CSV when one's loaded
  # for the current snapshot.
  results_with_xref <- reactive({
    r <- results()
    xr <- current_xref()
    if (is.null(r) || nrow(r) == 0 || is.null(xr)) return(r)

    r_df <- st_drop_geometry(r)
    merged <- merge(
      r_df,
      xr$data[, c("Lot", "Block", "Plan", "Roll_Number", "Full_Address", "Zoning")],
      by.x = c("lot", "block", "plan"),
      by.y = c("Lot", "Block", "Plan"),
      all.x = TRUE
    )
    unique(merged)
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
          weight       = 4,
          color        = "red",
          fillOpacity  = 0.6,
          bringToFront = TRUE
        )
      )
  })

  output$table <- renderDT({
    rx <- results_with_xref()
    if (is.null(rx) || nrow(rx) == 0) return(NULL)

    cols <- c("lot", "block", "plan", "description")
    if ("Roll_Number" %in% names(rx)) {
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
