# Traffic Flow Map extractor

Turns the City of Winnipeg's yearly **Traffic Flow Map** PDF (Public Works,
Transportation Division: average weekday daily traffic on major streets) into
`web/public/traffic-flow-<year>.geojson`, the default source for the app's
Traffic overlay.

## Run it

```powershell
pip install pymupdf pyproj numpy scipy pillow
cd tools\traffic-flow
python extract_flow_map.py "<path to>\Winnipeg 2024TrafficFlowMap24HR.pdf" ..\..\web\public\traffic-flow-2024.geojson --year 2024 --review review\review-2024.html
```

About two minutes. It prints the georeference residual, the inset fit, and
how many labels were read, had a problem, or were not tied to a line.

## Check it

Open `review\review-<year>.html` (local only, git-ignored: it embeds crops of
the PDF). Every label is listed beside its crop of the PDF; any with a problem
or not tied to a line come first. Then turn on Traffic in the app and compare a
few streets with the PDF.

## A new year

1. Run it on the new PDF with the new `--year`.
2. Check the review page.
3. Set `TRAFFIC_FLOW_YEAR` in `web/src/lib/trafficFlowMap.js` and the Source
   option text in `web/index.html` to the new year.
4. `npm test` in `web` (it sanity-checks the shipped file), then commit the
   GeoJSON with the code change.

The 2019 to 2023 maps come from the same QGIS project (georeferenced, labels as
outlines) and should run unchanged. The 2008 to 2018 maps are a different kind
of PDF (real text labels, no georeferencing) and would need their own reader.

How the PDF is read (glyph shapes rather than OCR, the drawing-order rule for
the downtown inset, label-to-line assignment) is explained at the top of
`extract_flow_map.py`.
