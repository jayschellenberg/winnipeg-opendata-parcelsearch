# Parcel Search Tool — Replication Guide

This document explains how to build the same parcel-search tool for a different jurisdiction (e.g. Manitoba Open Data, another Canadian municipality). It covers the full architecture, every non-obvious decision, every bug already solved, and the exact checklist of files and lines to change.

---

## Table of Contents

1. [What the tool does](#1-what-the-tool-does)
2. [Architecture overview](#2-architecture-overview)
3. [Repository structure](#3-repository-structure)
4. [Step 0 — Probe the new data source](#4-step-0--probe-the-new-data-source)
5. [Step 1 — Adapt `soda.js` (the data layer)](#5-step-1--adapt-sodajs-the-data-layer)
6. [Step 2 — Adapt `index.html` (search inputs + table columns)](#6-step-2--adapt-indexhtml-search-inputs--table-columns)
7. [Step 3 — Adapt `main.js` (UI wiring + table render)](#7-step-3--adapt-mainjs-ui-wiring--table-render)
8. [Step 4 — Adapt `map.js` (popup labels + colour palette)](#8-step-4--adapt-mapjs-popup-labels--colour-palette)
9. [Step 5 — Deploy to Vercel](#9-step-5--deploy-to-vercel)
10. [Bugs and gotchas already solved](#10-bugs-and-gotchas-already-solved)
11. [SoQL quick reference](#11-soql-quick-reference)
12. [Non-Socrata portals](#12-non-socrata-portals)
13. [Local dev workflow](#13-local-dev-workflow)

---

## 1. What the tool does

- **Legal-description search** (Lot / Block / Plan / Description): queries a **Survey Parcels** dataset, then back-fills Roll # / Address / Zoning / DU / Total Assessed Value by spatially joining an **Assessment Parcels** dataset.
- **Assessment-first search** (Roll # / Address / Zoning / DU mode): queries the Assessment Parcels dataset *and* (optionally) cross-references a **Civic Addresses** dataset so that searching by any of a parcel's official addresses surfaces the parcel even if it's not the primary assessment address. Survey Parcels are then back-filled to populate the legal-description columns.
- A **DU (dwelling-units) filter** ANDs into the assessment query to find vacant lots (`= 0`) or multi-unit buildings (`>= N`). The text-typed `dwelling_units` column is cast with SoQL `::number` to compare numerically.
- Every search renders **two map layers simultaneously**: blue = survey lots, red = assessment parcels. The two often differ — one assessment can span many survey lots, and one survey lot can be split between rolls.
- The Address column on each row is enriched with **every civic address** falling inside the parcel polygon (so a parcel with primary "400 Hargrave" but an additional civic address "440 Hargrave" displays both, and is searchable from either direction).
- The Zoning column shows the **top-1 area-weighted** zoning code (via `@turf/intersect` + `@turf/area`), with separate columns for coverage % and the second-largest zone (when ≥ 1%). Reveals zoning splits that the Assessment dataset's single primary `zoning` text hides.
- The Assess-{year} column shows total assessed value as a clickable link into the City's assessment portal (`winnipegassessment.com`). The header year is dynamically stamped from the most-common `current_assessment_year` in the result set.
- Five **toggleable map overlays**: citywide Zoning (cached in IndexedDB for 7 days), Secondary Plans (combined Precincts + Major Redev Sites), Infill Guideline Area (Mature Communities), Malls and Corridors PDO (combined Regional Centres + Urban + Regional Corridors), and Lot Dimensions (survey-edge feet labels at zoom ≥ 17).
- A **Streets ⇄ Satellite basemap toggle** in the map's top-right gutter (Esri World Imagery, no API key).
- A **Generate Static Map** button captures the current view as a PNG with attribution composited, for dropping into reports.
- **Two floating legends** — survey/assessment swatches (bottom-right) and zoning categories (bottom-left, when zoning is on).
- Results table is fully sortable; supports **CSV export**, **map-click → row scroll**, **row click → map fly-to-parcel**, **combined hover popup** for overlapping layers, and **Walkscore + Flood** external-link columns.
- The page uses a **fixed-width left sidebar** (320 px sticky) holding all controls grouped into Search and Map-overlay sections; below 980 px it collapses to a single column.

---

## 2. Architecture overview

```
Browser
  │
  ├─ index.html          Static shell: inputs, map div, results table, explainer
  ├─ src/main.js         UI wiring — reads inputs, calls soda.js, renders table+map
  ├─ src/soda.js         API client — every SODA/SoQL query lives here
  ├─ src/map.js          MapLibre GL setup, two parcel layers, zoning overlay,
  │                      hover/click popups, fly-to-feature
  └─ src/style.css       All CSS
        │
        │   fetch (GeoJSON, CORS open)
        ▼
  data.winnipeg.ca  ←── swap this for the new jurisdiction's endpoint
  Socrata SODA API
  sjjm-nj47   Survey Parcels      (legal lots — Lot/Block/Plan)
  d4mq-wa44   Assessment Parcels  (rolls — civic address, zoning, area, value)
  cam2-ii3u   Addresses           (every civic-address point — multi-address xref)
  dxrp-w6re   Zoning By-law       (citywide overlay + area-weighted top-2 analysis)
  xh28-4smq   OurWPG Precinct     (Secondary Plans overlay — new-community precincts)
  piz6-n3at   OurWPG Major Redev  (Secondary Plans overlay — major-infill sites)
  5guk-f7xw   OurWPG Mature Comm  (Infill Guideline Area overlay)
  wv32-jdtk   OurWPG Reg Mix Use Centre   ┐
  t4kh-5gtd   OurWPG Urban Mix Use Corr   ├ Malls and Corridors PDO overlay
  ahzi-uwu2   OurWPG Reg Mix Use Corr     ┘
                              │
                              ▼
              ┌───────────────────────────┐
              │  IndexedDB (`wpsCache`)   │
              │  citywide zoning, 7-day   │
              │  TTL — instant re-toggles │
              └───────────────────────────┘
```

**No server, no database, no auth.** Vercel just serves the Vite bundle. All data is queried by the browser on every search; the citywide zoning is the only dataset cached across sessions.

A typical search fires multiple SODA calls in parallel and merges them client-side:

1. **Attribute query** — Survey Parcels by Lot/Block/Plan, or Assessment Parcels by Roll/Address/Zoning + DU mode (`dwelling_units::number = 0` or `>= N`).
2. **Address cross-reference** (when the address field is filled) — Civic Addresses dataset, find parcels containing each matching address point.
3. **Spatial enrichment** — per-feature `within_box` queries against the *other* parcel dataset (assessment-side for legal flow, survey-side for assessment flow). Batched 50 clauses per request, run in parallel.
4. **Civic-address enrichment** — per-parcel `within_box` against the Addresses dataset, attaching the full civic-address list to each result.
5. **Top-2 zoning enrichment** — for each parcel, intersects its polygon against zoning polygons (cache-warm: from IndexedDB; cache-cold: per-parcel `within_box`) and computes top-2 area-weighted coverage with `@turf/intersect` + `@turf/area`.
6. **Partial-lot detection** (assessment flow) — counts how many assessments overlap each survey lot; lots overlapping >1 are flagged "(partial)".
7. **Citywide zoning overlay** (toggled on demand) — fetches all 18K zoning polygons in one call, caches in IndexedDB for 7 days. Subsequent toggles read from disk.
8. **Policy-area overlays** (Secondary Plans / Infill / Malls and Corridors) — small whole-citywide datasets (5–24 polygons each) fetched whole on first toggle and memoised in-memory for the session.

All parcel-side spatial filters use `within_box` with a 150 m bbox pad (because Socrata's `within_box` requires *containment*, not intersection — see [Bug 10.2](#102-within_box-uses-containment-not-intersection)). Client-side `booleanPointInPolygon` then re-checks every match to eliminate false positives. The bidirectional `parcelsOverlap` check (assessment-centroid-in-survey OR survey-bbox-center-in-assessment) handles both 1:N and N:1 alignment cases.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — the map (CartoDB Positron + Esri World Imagery raster basemaps, no API keys)
- `@turf/bbox` — bounding boxes
- `@turf/boolean-intersects` — defensive fallback when centroid coords are missing
- `@turf/boolean-point-in-polygon` — primary client-side join primitive
- `@turf/intersect`, `@turf/area` — area-weighted top-2 zoning analysis (note: turf v7 changed the `intersect` API — see [Bug 10.11](#1011-turfintersect-v7-changed-its-api))

---

## 3. Repository structure

```
repo-root/
├── vercel.json            Build config: points Vercel at web/
├── README.md              User-facing summary + live URL
├── REPLICATION_GUIDE.md   This document
├── r/                     R scripts for local historical archive (not part of web tool)
└── web/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.js
        ├── map.js
        ├── soda.js
        └── style.css
```

`vercel.json`:
```json
{
  "buildCommand": "cd web && npm install && npm run build",
  "outputDirectory": "web/dist",
  "framework": "vite"
}
```

---

## 4. Step 0 — Probe the new data source

### 4.1 Does the portal use Socrata?

Look for a Socrata logo or `/resource/` in dataset URLs. Socrata powers most Canadian municipal open-data portals (Winnipeg, Calgary, Edmonton, etc.). If you see URLs like:

```
https://data.example.ca/resource/xxxx-xxxx.geojson
```

you have Socrata and everything in this guide applies directly. Manitoba Open Data (`opendata.gov.mb.ca`) is **not** Socrata — see [Section 12](#12-non-socrata-portals).

### 4.2 Find the four datasets (or whatever subset exists)

| Winnipeg dataset | Required? | What it provides |
|---|---|---|
| Survey Parcels (`sjjm-nj47`) | yes | Lot / Block / Plan / Description + polygon geometry |
| Assessment Parcels (`d4mq-wa44`) | yes | Roll #, civic address, zoning, area, centroid + polygon geometry |
| Addresses (`cam2-ii3u`) | optional | Every official civic address with point geometry. Without it, multi-address parcels are only findable by their primary address. |
| Zoning By-law Parcels (`dxrp-w6re`) | optional | Coloured zoning overlay. The tool still works without it; just delete the toggle button and the related code. |

If the new jurisdiction collapses Survey + Assessment into one dataset, the two-flow architecture simplifies to one flow and you can delete the cross-side enrichment.

### 4.3 Confirm the field names

Fetch one row with all columns:

```
https://data.example.ca/resource/DATASET-ID.json?$limit=1
```

For Winnipeg's Assessment Parcels the relevant columns are:
`roll_number, full_address, zoning, centroid_lat, centroid_lon, assessed_land_area, geometry, ...`

### 4.4 Confirm geometry column names (they vary across datasets!)

Socrata GeoJSON endpoints embed geometry, but the **column name used in `within_box(...)`** can differ per dataset. In Winnipeg:

- `location` — Survey Parcels (multipolygon), Civic Addresses (point)
- `geometry` — Assessment Parcels (multipolygon), Zoning By-law (polygon)
- `point` — Civic Addresses also has a Point-typed `point` column (we use this one for the address xref because it's unambiguous)

To find the right name, hit the dataset metadata:

```
https://data.example.ca/api/views/DATASET-ID.json
```

and look for fields with `renderTypeName: "multipolygon"` / `"point"`. The `fieldName` is what goes in `within_box(fieldName, ...)`.

### 4.5 Test a SoQL query in your browser

```
https://data.example.ca/resource/DATASET-ID.geojson
  ?$where=upper(lot) like '%50%' AND upper(block) like '%RL%'
  &$limit=5
```

Confirm you get a GeoJSON FeatureCollection with polygon geometry. If you get a 200 with `{"error":true}`, the column names are wrong.

### 4.6 Check CORS

Open DevTools → Network and look for `Access-Control-Allow-Origin: *` on a response. Socrata always sets this. Non-Socrata portals sometimes don't — if missing, you'll need a Vercel Edge Function as a proxy (~10 lines).

---

## 5. Step 1 — Adapt `soda.js` (the data layer)

This is the only file that knows about the data source. Everything downstream is generic.

### 5.1 Swap the base URLs and dataset IDs

```js
const SURVEY_URL    = 'https://data.example.ca/resource/AAAA-AAAA.geojson';
const ASSESS_URL    = 'https://data.example.ca/resource/BBBB-BBBB.geojson';
const ADDRESSES_URL = 'https://data.example.ca/resource/CCCC-CCCC.json';   // optional
const ZONING_URL    = 'https://data.example.ca/resource/DDDD-DDDD.geojson'; // optional
```

The Addresses URL uses `.json` (not `.geojson`) because the dataset typically has multiple geometry columns and we want to be explicit about which one to interpret as the point. `searchAddresses` builds GeoJSON features manually from the `point` column.

### 5.2 Update `searchSurveyParcels` field names

```js
export async function searchSurveyParcels({ plan, lot, block, desc }) {
  const clauses = [];
  if (plan)  clauses.push(likeClause('plan', plan));    // ← the column name in the new dataset
  if (lot)   clauses.push(likeClause('lot', lot));
  if (block) clauses.push(likeClause('block', block));
  if (desc)  clauses.push(likeClause('description', desc));
  // ...
}
```

If the new dataset uses different column names (e.g. `lot_number` instead of `lot`), just change the string in `likeClause('lot_number', lot)`.

### 5.3 Update `searchAssessmentParcels` field names + `$select`

```js
export async function searchAssessmentParcels({ roll, address, zoning }) {
  const clauses = [];
  if (roll)    clauses.push(likeClause('roll_number', roll));
  if (address) clauses.push(likeClause('full_address', address));
  if (zoning)  clauses.push(likeClause('zoning', zoning));
  // ...
  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    $order: 'full_address',
    $limit: '1000',
  });
}
```

### 5.4 Update `fetchAssessmentOverlap` and `fetchSurveyOverlap`

```js
export async function fetchAssessmentOverlap(surveyFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: ASSESS_URL,
    geomColumn: 'geometry',   // ← the SoQL column name for the assessment polygon
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    dedupeKey: 'roll_number',
    fc: surveyFc,
  });
}

export async function fetchSurveyOverlap(assessFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: SURVEY_URL,
    geomColumn: 'location',   // ← Winnipeg calls survey geometry 'location'
    select: null,             // null = all columns
    dedupeKey: 'id',
    fc: assessFc,
  });
}
```

### 5.5 Update the address cross-reference (if the new portal has an addresses dataset)

```js
export async function searchAddresses({ address }) {
  if (!address) return { type: 'FeatureCollection', features: [] };
  const params = new URLSearchParams({
    $where: likeClause('full_address', address),  // ← address column
    $select: 'full_address,point',                // ← geometry column = 'point'
    $order: 'full_address',
    $limit: '1000',
  });
  // ... fetches .json, builds GeoJSON Point features manually
}
```

`searchAddressesAndFindParcels` and `fetchAssessmentByAddressPoints` then chain the points through a per-point `within_box` to find the containing assessment. **Skip this entirely if no addresses dataset is available** — `searchAssessmentParcelsExpanded` falls back to the direct query alone when `address` is empty, so the assessment-first flow still works without the xref.

### 5.6 Update the civic-address enrichment

`enrichAssessmentAddresses` mutates each parcel's `full_address` to a comma-joined list of every civic address inside its polygon (primary first, others alphabetical). Wrapping every external call in try/catch is critical — civic enrichment is non-essential and must never block the primary search results from rendering. Failures degrade gracefully to "primary address only".

### 5.7 Update `fetchZoningOverlap` (if zoning is wanted)

```js
export async function fetchZoningOverlap(parcelFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: ZONING_URL,
    geomColumn: 'location',   // ← Winnipeg's zoning geometry column
    select: 'id,zoning,short_description,long_description,map_colour,location',
    dedupeKey: 'id',
    fc: parcelFc,
  });
}
```

The categorical fill colour in `map.js` is driven by the `map_colour` field — if your dataset has different category names, update the `ZONING_PALETTE` array there to match.

### 5.8 Keep these unchanged

- `fetchPerFeatureBboxUnion` — generic batching/parallel/dedupe helper, takes `{ baseUrl, geomColumn, select, dedupeKey, fc, extraWhere }`. **Don't modify** unless the new portal has a different spatial-query syntax (see [Section 12](#12-non-socrata-portals)).
- `parcelsOverlap`, `assessCentroidInSurvey`, `surveyCenterInAssess` — bidirectional client-side overlap check. The bidirectional logic correctly handles both 1-survey-many-assessments (duplexes) and 1-assessment-many-surveys (downtown buildings) cases.
- `mergeSurveyFeatures`, `mergeAssessFeatures` — collapse multiple matching features per row into a single synthetic feature with grouped lots, range-collapsed numbers (`21-25, 68-75`), plan-grouped breakdowns when more than one plan is involved (`21-25 (Pl 129); 39-46 (Pl 24208)`), and `(partial)` suffixes for split lots.
- `computePartialSurveyIds`, `filterMatchedSurveys`, `filterMatchedAssessments` — used by main.js to drive the dual-layer map render and partial detection.
- `likeClause` — the case-insensitive wrap (`upper(col) LIKE '%VAL%'`). Critical (see [Bug 10.1](#101-like-is-case-sensitive)).
- `escapeSoql` — doubles single quotes per SoQL spec.

---

## 6. Step 2 — Adapt `index.html` (search inputs + table columns)

### 6.1 Search inputs

Each input has:

- An `id` that `main.js` reads
- A `size` attribute controlling visual width (in characters)
- A `placeholder` shown when empty
- A `<span class="tip">` sibling shown on focus as a tooltip

```html
<span class="field">
  <input id="lot" type="text" size="12" placeholder="Lot" />
  <span class="tip">Lot (or River Lot or Section)</span>
</span>
```

Change the `id`, `placeholder`, and `.tip` text to match the new jurisdiction's terminology (e.g. "Concession" / "Range" for Ontario surveys).

### 6.2 Table columns

```html
<thead>
  <tr>
    <th data-col="lot">Lot</th>
    <th data-col="block">Block</th>
    <th data-col="plan">Plan</th>
    <th data-col="desc">Description</th>
    <th data-col="roll">Roll Number</th>
    <th data-col="address">Full Address</th>
    <th data-col="zoning">Zoning</th>
    <th data-col="area">Lot Size (sf)</th>
    <th data-col="lat">Lat</th>
    <th data-col="lon">Lon</th>
  </tr>
</thead>
```

Each `data-col` attribute drives the click-to-sort behaviour in `main.js`. The column order must match `renderTable`'s cell-append order; if you add or remove columns, update both files plus the `SORT_KEYS` map and the `exportCsv` header list.

### 6.3 Top-of-page explainer

```html
<details class="explainer" open>
  <summary>What's the difference between Survey and Assessment parcels?</summary>
  <div class="explainer-body">...</div>
</details>
```

Tailor the wording to the new jurisdiction's parcel types. The legend pills inside use `.legend-pill.survey` / `.legend-pill.assess` colour classes from `style.css`.

### 6.4 Layer-toggle and zoning buttons

```html
<button id="survey-toggle" type="button" class="secondary active" aria-pressed="true">Hide Survey</button>
<button id="assess-toggle" type="button" class="secondary active" aria-pressed="true">Hide Assessment</button>
<button id="zoning-toggle" type="button" class="secondary" aria-pressed="false">Show Zoning</button>
```

Drop the zoning button if the new jurisdiction doesn't have a zoning dataset.

### 6.5 Map legend

```html
<div id="map">
  <div id="map-legend" class="map-legend" hidden>
    <strong>Legend</strong>
    <ul>
      <li><span class="swatch survey"></span>Survey parcel (legal lot)</li>
      <li><span class="swatch assess"></span>Assessment parcel (roll/building)</li>
    </ul>
  </div>
</div>
```

Positioned in the bottom-right of the map by `style.css`. Toggled hidden/visible by `main.js` based on whether there are any results.

---

## 7. Step 3 — Adapt `main.js` (UI wiring + table render)

### 7.1 Input element bindings

```js
const $lot     = document.getElementById('lot');
const $block   = document.getElementById('block');
const $plan    = document.getElementById('plan');
const $desc    = document.getElementById('desc');
const $roll    = document.getElementById('roll');
const $address = document.getElementById('address');
const $zoning  = document.getElementById('zoning');
```

Add/remove variables here if the new form has different fields.

### 7.2 Which flow runs

```js
const anyLegal  = inputs.lot || inputs.block || inputs.plan || inputs.desc;
const anyAssess = inputs.roll || inputs.address || inputs.zoning;

if (anyAssess) {
  await runAssessmentSearch(inputs);
} else {
  await runLegalSearch(inputs);
}
```

If the new jurisdiction has only one combined dataset, delete one flow and always call the other.

### 7.3 `setParcels(surveyFc, assessFc)` — both layers always

```js
function setParcels(surveyFc, assessFc = EMPTY_FC) {
  // Pushes both FeatureCollections into the map (blue + red layers),
  // fits to the union of both, and toggles the floating legend.
}
```

Both flows now call `setParcels` with both FCs:

- Legal flow: `setParcels(surveyFc, filterMatchedAssessments(assessFc, surveyFc))`
- Assessment flow: `setParcels(filterMatchedSurveys(surveyFc, assessFc), assessFc)`

The `filterMatched*` helpers also stamp `_rowKey` on the secondary layer so a click on either colour scrolls to the matching table row.

### 7.4 `renderTable` — cell order

```js
tr.appendChild(td(s.lot));
tr.appendChild(td(s.block));
tr.appendChild(td(s.plan));
tr.appendChild(td(s.description));
tr.appendChild(td(a.roll_number));
tr.appendChild(td(a.full_address));
tr.appendChild(td(a.zoning));
tr.appendChild(td(formatArea(a.assessed_land_area), 'num'));
tr.appendChild(td(formatCoord(a.centroid_lat), 'num'));
tr.appendChild(td(formatCoord(a.centroid_lon), 'num'));
```

`s` = survey-side properties (possibly merged via `mergeSurveyFeatures`), `a` = assessment-side. Change the property names to match the new dataset's column names.

### 7.5 `SORT_KEYS` — sortable columns

```js
const SORT_KEYS = {
  lot:     (r) => numOrStr(r.survey?.properties?.lot),
  block:   (r) => strKey(r.survey?.properties?.block),
  plan:    (r) => numOrStr(r.survey?.properties?.plan),
  desc:    (r) => strKey(r.survey?.properties?.description),
  roll:    (r) => strKey(r.assess?.properties?.roll_number),
  address: (r) => strKey(r.assess?.properties?.full_address),
  zoning:  (r) => strKey(r.assess?.properties?.zoning),
  area:    (r) => finiteOrNeg(r.assess?.properties?.assessed_land_area),
  lat:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lat),
  lon:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lon),
};
```

Each key matches a `data-col` attribute in `index.html`. Update both files together when you change columns.

### 7.6 `exportCsv` — column list

```js
const header = [
  'Lot', 'Block', 'Plan', 'Description',
  'Roll Number', 'Full Address', 'Zoning',
  'Lot Size (sf)', 'Lat', 'Lon',
];
// ...
lines.push([
  s.lot, s.block, s.plan, s.description,
  a.roll_number, a.full_address, a.zoning,
  a.assessed_land_area ?? '',
  a.centroid_lat ?? '',
  a.centroid_lon ?? '',
].map(csvCell).join(','));
```

Update both lists in lockstep with `renderTable` and `SORT_KEYS`.

### 7.7 `tagFeatures` — row-key scheme

```js
function tagFeatures(fc, side) {
  for (const f of fc.features) {
    const p = f.properties || (f.properties = {});
    if (side === 'survey') {
      p._rowKey = p.id != null ? `s:${p.id}` : null;
    } else {
      p._rowKey = p.roll_number != null ? `a:${p.roll_number}` : null;
    }
  }
}
```

Change `p.id` and `p.roll_number` to the unique-identifier columns of the new datasets. These must be stable string or numeric values — they correlate map clicks with table rows. The `filterMatched*` helpers in `soda.js` then propagate these keys to the cross-side layer so clicks on either colour land on the same row.

### 7.8 `formatArea`

```js
function formatArea(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n).toLocaleString('en-US');
}
```

Winnipeg's `assessed_land_area` is in **square feet** as a plain integer string. If the new jurisdiction stores area in square metres, either convert (`n * 10.764`) or change the column header to `Lot Size (m²)`.

### 7.9 `clearAll = window.location.reload()`

The Clear button does a full page reload. Earlier versions tried soft resets (clearing inputs, table, map, sort state, in-flight requests one by one) and accumulated subtle drift bugs. A reload is the bulletproof reset.

---

## 8. Step 4 — Adapt `map.js` (popup labels + colour palette)

### 8.1 Layer order (bottom to top)

```
zoning-fill, zoning-line, zoning-label   (optional zoning overlay)
assess-context-fill, assess-context-line  (red — assessment parcels)
parcel-fill, parcel-line                  (blue — survey parcels)
```

Smaller polygons (surveys) on top so they don't get obscured by the bigger assessment fills below.

### 8.2 Combined hover popup

A single `mousemove` handler queries both `parcel-fill` and `assess-context-fill` at the cursor point. If both are under the cursor (the common case in the legal flow), the popup shows both blocks of info side-by-side under coloured headers. `combinedPopupHtml` detects which schema the primary feature carries by looking for `roll_number` or `full_address`.

Update the property names in `popupHtml` to match your new datasets' columns.

### 8.3 Click handlers

Both `parcel-fill` and `assess-context-fill` have a click handler that scrolls the table to `feature.properties._rowKey`. Both layers carry `_rowKey` after `filterMatched*` stamps them.

### 8.4 Zoning overlay

If the new portal has a zoning dataset, update `ZONING_PALETTE` to match the dataset's `map_colour` (or equivalent) categories:

```js
const ZONING_PALETTE = [
  'Single Family Residential',  '#fff4a3',
  'Two Family Residential',     '#ffd9a0',
  // ...
];
```

The MapLibre `match` expression in `zoning-fill`'s paint uses these. Adjust the labels list (`zoning-label` symbol layer) by changing the `text-field` filter — currently codes ≤5 chars are shown; tweak per how long zoning codes typically are in the new jurisdiction.

If the dataset uses a different "category" attribute name (not `map_colour`), update the `['get', 'map_colour']` reference in the layer paint and the `popupHtml` for zoning popups.

### 8.5 Colour theme

```
survey  fill: #4682b4  (steel blue)   line: #0b2566 (deep navy)   2px solid
assess  fill: #b22222  (firebrick)    line: #690000 (very dark red) 3px solid
```

Pick high-contrast complementary colours. Keep one cool and one warm so they read as obviously different. Update the `.swatch.survey`, `.swatch.assess`, `.legend-pill.survey`, `.legend-pill.assess` rules in `style.css` to match.

---

## 9. Step 5 — Deploy to Vercel

1. Push the repo to GitHub (public or private — both work on the free Hobby tier).
2. Go to `vercel.com/new`, import the repo.
3. Vercel reads `vercel.json` at the root and auto-configures the build.
4. Every `git push` to `main` triggers an automatic redeploy.

**Optional Socrata app token** (raises the anonymous rate limit from 1,000 to 100,000 requests/hour):

1. Register free at `https://data.example.ca/profile/edit/developer_settings`
2. Add `VITE_SODA_APP_TOKEN=<token>` in Vercel Project Settings → Environment Variables
3. Redeploy

`soda.js` already reads `import.meta.env.VITE_SODA_APP_TOKEN` — no code change.

---

## 10. Bugs and gotchas already solved

These are real bugs hit during development. They will likely recur with any Socrata-based parcel dataset.

### 10.1 `LIKE` is case-sensitive

**Symptom:** Searching `monarch` returns no results even though `10 MONARCH MEWS` exists.

**Root cause:** SoQL `LIKE` is case-sensitive. Data is often stored uppercase.

**Fix (`likeClause`):**
```js
function likeClause(column, value) {
  return `upper(${column}) like '%${escapeSoql(String(value).toUpperCase())}%'`;
}
```

### 10.2 `within_box` uses containment, not intersection

**Symptom:** A search for a small lot inside a much larger assessment parcel finds the lot but not the assessment, even though the lot clearly sits inside it.

**Root cause:** Socrata's `within_box(geom, ...)` returns only rows whose geometry is **fully contained** in the query box. A 100m-wide assessment parcel containing a 30m lot will *not* fit inside a tight bounding box around the lot.

**Fix:** Pad each per-feature bbox by 0.002° (~150m) on every side before the `within_box` call. The client-side `parcelsOverlap` then re-checks every match to eliminate false positives.

```js
const PAD_DEG = 0.002;
return `within_box(${geomColumn},${round(maxLat + PAD_DEG)},${round(minLon - PAD_DEG)},${round(minLat - PAD_DEG)},${round(maxLon + PAD_DEG)})`;
```

If the new jurisdiction has bigger parcels (e.g. industrial or rural), bump the pad. Wider pad = more candidates fetched but no false matches because of the client-side filter.

### 10.3 Spatially-spread searches hit the `$limit` before reaching the targets

**Symptom:** Searching for an address that matches two distant neighbourhoods (e.g. "Woodstock" *and* "Stockdale") returns results from both, but legal descriptions are blank for both.

**Root cause:** A single union bbox across spread results covers a huge area; `within_box` returns parcels in between and `$limit` runs out before the relevant ones.

**Fix:** One small `within_box` per feature, OR'd together, batched 50 per request, run in parallel via `Promise.all`. Each clause's bbox is tiny (just that one parcel ± 150m).

### 10.4 `booleanIntersects` triggers on shared edges

**Symptom:** A search for a single lot returns 5+ neighbouring addresses because adjacent parcels share boundary edges.

**Root cause:** `@turf/boolean-intersects` returns true for any shared point — including edge touches. Two parcels sharing a property line both register as "intersecting".

**Fix:** Check **centroid-in-polygon** instead. Specifically, `parcelsOverlap` is bidirectional:

```js
function parcelsOverlap(s, a) {
  return assessCentroidInSurvey(a, s)         // assessment centroid inside survey
      || surveyCenterInAssess(s, a);          // survey bbox center inside assessment
}
```

Both directions covered because:
- "Many surveys per assessment" (a downtown building over 20 lots): each survey's center is inside the assessment polygon → all 20 match.
- "Many assessments per survey" (a duplex split into 2 rolls): each assessment centroid is inside the same survey → both match.
- Adjacent parcels (no real overlap) fail both checks because neither centroid sits inside the *other* polygon.

### 10.5 Topology errors in turf.js

**Symptom:** Console shows `parcelsOverlap error; falling back to unmatched row`. Some rows have no enrichment.

**Root cause:** Some parcel geometries in the wild have self-intersections or other topology problems that crash turf.js.

**Fix:** Wrap the join in try/catch. The row still appears in the table; it just shows `—` in the unmatched columns.

### 10.6 Multi-address parcels look like missing data when reverse-searched

**Symptom:** Searching by Plan number that the user knows is part of "440 Hargrave" — the result row shows "400 HARGRAVE STREET" only, and the user can't tell it's the same parcel they previously found via "440 Hargrave".

**Root cause:** Assessment dataset stores only one primary address per parcel. The Addresses dataset (cam2-ii3u in Winnipeg) has every official address. Without enrichment, secondary addresses are invisible to the user.

**Fix:** `enrichAssessmentAddresses` does a per-parcel `within_box` against the Addresses dataset and rewrites `parcel.full_address` to a comma-joined list (primary first, others alphabetical). So the row now reads "400 HARGRAVE STREET, 440 HARGRAVE ST" — recognizable from any search direction.

### 10.7 Address enrichment failure must not block table render

**Symptom:** A search appears to succeed (correct count, table briefly shows survey-only rows) but the assess columns stay empty forever.

**Root cause:** An exception inside the address-enrichment helper unwound the async chain before `renderTable(joinSurveyWithAssessment(...))` could run.

**Fix:** Wrap the enrichment call site in try/catch *and* wrap each per-parcel iteration inside the helper. The user always gets at least the primary address; enrichment failures degrade gracefully.

### 10.8 Multi-lot parcels need plan-grouped lot lists

**Symptom:** A roll covering 20 lots across two plans displays one row per lot, repeating the same roll/address 20 times.

**Fix:** Both join functions collapse to one row per parcel with `mergeSurveyFeatures` / `mergeAssessFeatures`. The Lot column groups lots by plan and range-collapses sequential numbers:

```
"21-25, 68-75, 120-121 (Pl 129); 39, 41, 44-46 (Pl 24208)"
```

Single-plan merges drop the plan annotation. Non-numeric lots (RL10, fractional, etc.) fall back to a sorted comma-list since ranges aren't meaningful.

### 10.9 Partial-lot detection needs an extra fetch in the assessment flow

**Symptom:** A survey lot split between two assessment rolls (a duplex with two rolls) doesn't get flagged "(partial)" when searched by Roll #.

**Root cause:** In the assessment-first flow, `surveyFc` is the back-fill set — only surveys near the result parcels. To know whether a survey *also* extends into another assessment outside the search results, we need a separate query against the *full* assessment dataset.

**Fix:** After the join renders, fire an extra `fetchAssessmentOverlap(surveyFc)` and run `computePartialSurveyIds` on the result. Re-render the table with the partial flags applied. Non-fatal — failure leaves the table unmarked but otherwise fine.

### 10.10 Document visibility blocks MapLibre tile loading

**Symptom:** Map appears empty when loaded in headless / hidden-tab contexts.

**Root cause:** MapLibre defers tile loading when `document.visibilityState === 'hidden'`. The `map.on('load')` event never fires, so any code waiting on `mapReady` queues forever.

**Fix:** This is a benign quirk of how the map behaves in non-visible tabs. Real users don't hit it. For Chrome MCP / automated testing, override `document.visibilityState` before search.

### 10.11 `@turf/intersect` v7 changed its API

**Symptom:** Top-2 area-weighted zoning columns silently stay empty even though the zoning fetch is succeeding and parcels are being passed in correctly.

**Root cause:** `@turf/intersect` v6 took two Feature args: `intersect(poly1, poly2)`. v7 changed the signature to take a single FeatureCollection of two features: `intersect({ type: 'FeatureCollection', features: [poly1, poly2] })`. Calling the v6 form on v7 means the second arg gets read as `options` instead of as the second polygon, so the function returns null on every call.

**Fix:** wrap both features into a FeatureCollection per the v7 contract:
```js
const inter = intersect({ type: 'FeatureCollection', features: [parcel, zone] });
```

### 10.12 localStorage quota too small for citywide overlays — use IndexedDB

**Symptom:** localStorage write throws `QuotaExceededError` when caching the citywide zoning dataset (~13.5 MB gzipped, ~42 MB parsed).

**Root cause:** localStorage's hard limit is typically 5 MB per origin. Large GeoJSON FeatureCollections won't fit.

**Fix:** Use IndexedDB. Browser quotas are typically several hundred MB, and the structured-clone storage handles GeoJSON FeatureCollections directly — no JSON-stringify round-trip:

```js
const req = indexedDB.open('wpsCache', 1);
req.onupgradeneeded = () => req.result.createObjectStore('cache');
// ...
store.put({ v: featureCollection, t: Date.now() }, 'cityZoning');
```

Wrap the read in a TTL check (`Date.now() - entry.t > ttlMs ? null : entry.v`) so stale data refreshes after the cache window expires.

### 10.13 Concurrent toggle clicks fire duplicate citywide fetches

**Symptom:** User mashes the Show Zoning toggle button before the first 10–15 s fetch completes; multiple identical requests fly off in parallel.

**Fix:** Memoise the in-flight fetch as a module-scoped Promise. Concurrent callers all `await` the same Promise; only one network round-trip happens. Clear the memoised slot on rejection so a later attempt can retry:

```js
let _cityZoningPromise = null;
export async function fetchCityZoning() {
  if (_cityZoningPromise) return _cityZoningPromise;
  _cityZoningPromise = (async () => { /* fetch + cache */ })();
  _cityZoningPromise.catch(() => { _cityZoningPromise = null; });
  return _cityZoningPromise;
}
```

### 10.14 Dimension labels missing on shared/short edges

**Symptom:** Toggling Show Dimensions in dense residential blocks: some lots show their 120 ft depth but skip their 40-50 ft frontage, even though the polygon clearly has labellable front edges.

**Root causes:** two compounding issues —

1. Adjacent survey lots share their side edges, so each shared edge gets emitted twice (once per lot iterating its outer ring). MapLibre's collision detection then drops one of the duplicate stacked labels arbitrarily.
2. With `symbol-placement: 'line-center'`, MapLibre skips placing a label when it judges the line shorter than the rendered text. A 40 ft edge at zoom 18 measures ~25 px on screen; "40 ft" in 10 px Open Sans Semibold is ~30 px wide. So the label gets dropped silently.

**Fix:** dedupe edges with a canonical key + force-show:

```js
const seenEdges = new Set();
// ...
const key = canonicalEdgeKey(a, b);  // sort+round endpoints
if (seenEdges.has(key)) continue;
seenEdges.add(key);
// emit LineString feature
```

```js
// in the symbol layer paint config:
'text-allow-overlap': true,
'text-ignore-placement': true,
```

### 10.15 Static map PNG capture returns blank canvas

**Symptom:** `canvas.toDataURL()` returns `data:image/png;base64,iVBORw0...AAAA` — header valid but pixel data is all-transparent.

**Root cause:** WebGL clears the framebuffer between frames by default. By the time `toDataURL()` runs, the rendered pixels are gone.

**Fix:** opt in to a preserved framebuffer at map construction time:

```js
const map = new maplibregl.Map({
  // ...
  preserveDrawingBuffer: true,
});
```

Small perf cost on continuous interaction; fine at the scale of an appraisal-research tool. Also wait for `map.on('idle', ...)` before reading pixels to ensure no half-loaded tiles are caught mid-frame.

---

## 11. SoQL quick reference

| Operation | SoQL syntax |
|---|---|
| Partial text match (case-sensitive) | `column like '%value%'` |
| Partial text match (case-insensitive) | `upper(column) like '%VALUE%'` |
| Exact match | `column = 'value'` |
| Multiple AND conditions | `clause1 AND clause2` |
| Multiple OR conditions | `clause1 OR clause2` |
| Spatial containment | `within_box(geom_col, nwLat, nwLon, seLat, seLon)` |
| Spatial intersection (where supported) | `intersects(geom_col, 'POINT(lon lat)')` |
| Select specific columns | `$select=col1,col2,col3` |
| Order by column | `$order=col_name` (use this to make `$limit`-truncated results deterministic) |
| Row limit | `$limit=1000` (Socrata's anonymous max is 1,000 unless using `$offset`/paging) |
| GeoJSON output | Replace `.json` with `.geojson` in the resource URL |
| Escape a single quote | Double it: `O''Brien` |

`within_box` argument order: **NW corner first** (max lat, min lon), then **SE corner** (min lat, max lon).

Socrata also supports `intersects(geom, wkt)` for true geometry intersection — useful as a fallback when the bbox-pad approach doesn't fit a particular query. The Winnipeg datasets accept it; not all Socrata instances do, so test before relying on it.

---

## 12. Non-Socrata portals

If the new jurisdiction does not use Socrata, the architecture stays the same but `soda.js` needs to be rewritten for the new API.

### ArcGIS Open Data / ArcGIS REST

Many provincial and federal portals use Esri's ArcGIS REST API. The equivalent of `within_box` is a spatial query:

```
/query?geometry={"xmin":-97.19,"ymin":49.88,"xmax":-97.18,"ymax":49.89,"spatialReference":{"wkid":4326}}
      &geometryType=esriGeometryEnvelope
      &spatialRel=esriSpatialRelIntersects
      &outFields=*
      &f=geojson
```

Key differences from Socrata:

- `esriSpatialRelIntersects` tests intersection, not containment — **no padding needed** ([Bug 10.2](#102-within_box-uses-containment-not-intersection) doesn't apply).
- Attribute queries use SQL-ish syntax: `where=UPPER(LOT) LIKE '%50%'`
- CORS varies; some ArcGIS services need a proxy.
- Pagination uses `resultOffset` + `resultRecordCount` instead of `$offset` + `$limit`.

### CKAN (e.g. Manitoba Open Data)

CKAN is a data catalogue, not a query engine. Datasets are usually downloadable files (GeoJSON, CSV, Shapefile). If the data is only available as a file download, the live-query approach doesn't work — you'd need to:

- Pre-process and host the data yourself (PMTiles is a good static-hostable option for vector tiles), **or**
- Run spatial queries against your own PostGIS instance via a serverless function.

For Manitoba specifically, check whether each dataset offers a Datastore API endpoint (gives SQL-ish querying via CKAN's Datastore extension) — if so, the architecture can stay live-query.

---

## 13. Local dev workflow

```bash
cd web
npm install
npm run dev    # http://localhost:5173 — queries live data on every search
```

Vite's hot-module reload means CSS and JS changes appear instantly. The map requires internet to load basemap tiles.

To inspect SODA responses directly in the browser:

```
https://data.example.ca/resource/DATASET-ID.geojson
  ?$where=upper(lot) like '%50%' AND upper(block) like '%RL%'
  &$limit=5
```

To see all fields on a dataset:

```
https://data.example.ca/resource/DATASET-ID.json?$limit=1
```

To read dataset metadata (find geometry column names, data types):

```
https://data.example.ca/api/views/DATASET-ID.json
```

To test a `within_box` query:

```
https://data.example.ca/resource/DATASET-ID.json
  ?$where=within_box(geometry,49.900,-97.150,49.895,-97.145)
  &$limit=10
```

The deployed app exposes `window._map` for runtime inspection — handy for confirming layer state, source contents, and zoom level when troubleshooting on the live site.
