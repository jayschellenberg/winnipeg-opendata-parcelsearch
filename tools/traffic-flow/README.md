# Traffic Flow Map extractor

Turns the City of Winnipeg's yearly **Traffic Flow Map** PDF (Public Works,
Transportation Division: average weekday daily traffic on major streets) into
`web/public/traffic-flow-<year>.geojson` for the app's Traffic overlay. The
newest year is the default source, earlier years are sources of their own, and
a flow-map popup lists the same street in every year with the change.

Extracted so far: 2024, 2023, 2022, 2019 (`extract_flow_map.py`) and 2018,
2015, 2012, 2009, 2008 (`extract_flow_map_old.py`). The City made no maps for
2020 or 2021 (pandemic counts are excluded); the 1980, 1983 and 1993 scans are
peak-hour maps and are not comparable.

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
labels as outlines) and ran unchanged.

## 2008 to 2018

These are a different kind of PDF: the volumes are real text, but there is no
georeferencing and the map's scale and position change from year to year.

```powershell
python extract_flow_map_old.py "<path to>\Winnipeg 2015TrafficFlow.pdf" ..\..\web\public\traffic-flow-2015.geojson --year 2015 --reference ..\..\web\public\traffic-flow-2019.geojson --review review\review-2015.html
```

Each year is fitted onto the 2019 extraction by its green volume lines (FFT
correlation for scale and shift, then ICP with rotation). The fit lands about
5 m from the 2019 lines (median); the script stops if it is worse than 15 m.
2012 draws its lines as filled triangles with a black centreline; the script
detects that and uses the centrelines. Labels that happen to touch are split
by the number pattern.

As a check, compare each year with 2019 on the same street: the median ratio
should be near 1 (2022 is about 0.89, the pandemic dip), with only a few
percent of lines far off, mostly at intersections or real changes.

How the PDF is read (glyph shapes rather than OCR, the drawing-order rule for
the downtown inset, label-to-line assignment) is explained at the top of
`extract_flow_map.py`.
