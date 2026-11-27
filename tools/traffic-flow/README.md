# Traffic Flow Map extractor

Turns the City of Winnipeg's yearly **Traffic Flow Map** PDF (Public Works,
Transportation Division: average weekday daily traffic on major streets) into
`web/public/traffic-flow-<year>.geojson` for the app's Traffic overlay. The
newest year is the default source, earlier years are sources of their own, and
a flow-map popup lists the same street in every year with the change.

Extracted so far: 2024, 2023, 2022, 2019 (the City made no maps for 2020 or
2021; pandemic counts are excluded).

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
3. Add the year to the front of `TRAFFIC_FLOW_YEARS` in
   `web/src/lib/trafficFlowMap.js`; in `web/index.html` make it the first
   Source option (value `flow`) and give the previous newest year its own
   `flow-<year>` option; add that value to `trafficSource` in
   `web/src/lib/urlState.js`.
4. `npm test` in `web` (it sanity-checks the shipped file), then commit the
   GeoJSON with the code change.

The 2019 to 2024 maps all come from the same QGIS project (georeferenced,
labels as outlines) and ran unchanged. The 2008 to 2018 maps are a different kind
of PDF (real text labels, no georeferencing) and would need their own reader.

How the PDF is read (glyph shapes rather than OCR, the drawing-order rule for
the downtown inset, label-to-line assignment) is explained at the top of
`extract_flow_map.py`.
