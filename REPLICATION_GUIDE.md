# Parcel Search Tool — Replication Guide

This document explains how to build the same parcel-search tool for a different jurisdiction (e.g. Manitoba Open Data, another municipality). It covers the full architecture, every non-obvious decision, every bug we hit, and the exact checklist of things to change.

---

## Table of Contents

1. [What the tool does](#1-what-the-tool-does)
2. [Architecture overview](#2-architecture-overview)
3. [Repository structure](#3-repository-structure)
4. [Step 0 — Before you start: probe the new data source](#4-step-0--before-you-start-probe-the-new-data-source)
5. [Step 1 — Adapt `soda.js` (the data layer)](#5-step-1--adapt-sodajs-the-data-layer)
6. [Step 2 — Adapt `index.html` (search inputs + table columns)](#6-step-2--adapt-indexhtml-search-inputs--table-columns)
7. [Step 3 — Adapt `main.js` (UI wiring + table render)](#7-step-3--adapt-mainjs-ui-wiring--table-render)
8. [Step 4 — Adapt `map.js` (popup labels)](#8-step-4--adapt-mapjs-popup-labels)
9. [Step 5 — Deploy to Vercel](#9-step-5--deploy-to-vercel)
10. [Bugs and gotchas already solved](#10-bugs-and-gotchas-already-solved)
11. [SoQL quick reference](#11-soql-quick-reference)
12. [Non-Socrata portals](#12-non-socrata-portals)

---

## 1. What the tool does

- **Legal-description search** (Lot / Block / Plan / Description): queries a **Survey Parcels** dataset, draws matching polygons on a map, then back-fills Roll Number / Address / Zoning by spatially joining an **Assessment Parcels** dataset.
- **Assessment-first search** (Roll # / Address / Zoning): queries the Assessment Parcels dataset, draws those polygons, then back-fills Lot / Block / Plan / Description by spatially joining Survey Parcels.
- **Both directions** use exactly two API calls per search (one attribute query + one spatial proximity query), plus a client-side polygon-intersection join via turf.js for accuracy.
- Results table includes: Lot, Block, Plan, Description, Roll Number, Full Address, Zoning, Size (sf), Lat, Lon.
- **Export CSV**, **click a parcel on the map → scroll to its row**, **focus a search box → tooltip with full hint**.

---

## 2. Architecture overview

```
Browser
  │
  ├─ index.html          Static shell: inputs, map div, results table
  ├─ src/main.js         UI wiring — reads inputs, calls soda.js, renders table/map
  ├─ src/soda.js         API client — all SODA/SoQL queries live here
  ├─ src/map.js          MapLibre GL setup, parcel layer, hover/click popups
  └─ src/style.css       All CSS
        │
        │   fetch (GeoJSON, CORS open)
        ▼
  data.winnipeg.ca  ←── swap this for the new jurisdiction's endpoint
  Socrata SODA API
  sjjm-nj47  (Survey Parcels)
  d4mq-wa44  (Assessment Parcels)
```

**No server, no database, no auth.** The Vercel deployment is a plain static site. All data comes from the open-data portal on every search.

**Dependencies** (declared in `web/package.json`):
- `maplibre-gl` — the map (no API key required)
- `@turf/bbox` — compute bounding box of a GeoJSON FeatureCollection or Feature
- `@turf/boolean-intersects` — client-side polygon intersection test

---

## 3. Repository structure

```
repo-root/
├── vercel.json            Build config: points Vercel at web/
├── r/                     R scripts for local historical archive (not part of the web tool)
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

## 4. Step 0 — Before you start: probe the new data source

### 4.1 Does the portal use Socrata?

Look for a **Socrata** logo or the path `/resource/` in dataset URLs. Socrata powers most Canadian municipal open data portals (Winnipeg, Calgary, Edmonton, etc.). If you see URLs like:

```
https://data.example.ca/resource/xxxx-xxxx.geojson
```

you have Socrata and everything in this guide applies directly.

**Manitoba Open Data** (`opendata.gov.mb.ca`) — check whether it uses Socrata or a different platform (ArcGIS Open Data / CKAN / custom). See [Section 12](#12-non-socrata-portals) if it is not Socrata.

### 4.2 Find the two datasets

You need two datasets that together describe a parcel:

| Winnipeg name | What it contains | What you need from it |
|---|---|---|
| **Survey Parcels** (`sjjm-nj47`) | Legal description (Lot/Block/Plan/Description) + polygon geometry | Attribute search + geometry for map |
| **Assessment Parcels** (`d4mq-wa44`) | Roll number, civic address, zoning, assessed area, centroid + polygon geometry | Attribute search + geometry for map + area/centroid |

The new jurisdiction may combine these into one dataset, or split them differently. If there is only one dataset, the two-flow architecture collapses to one flow and you can remove the enrichment step entirely.

### 4.3 Confirm the field names

Fetch one row with all columns to discover field names:

```
https://data.example.ca/resource/DATASET-ID.json?$limit=1
```

For the Winnipeg Assessment Parcels, the full column list is:
`assessed_land_area, assessed_value_1, assessment_date, centroid_lat, centroid_lon, current_assessment_year, detail_url, dwelling_units, full_address, geometry, gisid, market_region, neighbourhood_area, property_class_1, roll_number, sewer_frontage_measurement, status_1, street_name, street_number, street_type, total_assessed_value, water_frontage_measurement, zoning, ...`

### 4.4 Confirm geometry column name

Socrata GeoJSON endpoints embed geometry, but the **column name used in SoQL spatial queries** can vary. Winnipeg uses:
- `location` for Survey Parcels
- `geometry` for Assessment Parcels

To find it, check the dataset metadata:
```
https://data.example.ca/api/views/DATASET-ID.json
```
Look for fields with `renderTypeName: "multipolygon"` or `"point"`. The `fieldName` property is what goes into `within_box(fieldName, ...)`.

### 4.5 Test a SoQL query in your browser

```
https://data.example.ca/resource/DATASET-ID.geojson
  ?$where=upper(lot) like '%50%' AND upper(block) like '%RL%'
  &$limit=5
```

Confirm you get a GeoJSON FeatureCollection with polygon geometry. If you get a 200 with `{"error":true}`, the column names are wrong.

### 4.6 Check CORS

Open the browser DevTools network tab and look for `Access-Control-Allow-Origin: *` on a response from the API. Socrata always sets this. Non-Socrata portals sometimes don't — if CORS is missing, you'll need a serverless proxy (a Vercel Edge Function, ~10 lines of code).

---

## 5. Step 1 — Adapt `soda.js` (the data layer)

This is the only file that knows about the data source. Everything else is generic.

### 5.1 Swap the base URLs and dataset IDs

```js
// ── CHANGE THESE ──────────────────────────────────────────────────────────
const SURVEY_URL = 'https://data.example.ca/resource/AAAA-AAAA.geojson';
const ASSESS_URL = 'https://data.example.ca/resource/BBBB-BBBB.geojson';
```

### 5.2 Update `searchSurveyParcels` field names

```js
export async function searchSurveyParcels({ plan, lot, block, desc }) {
  const clauses = [];
  if (plan)  clauses.push(likeClause('plan', plan));    // ← change 'plan' to actual column name
  if (lot)   clauses.push(likeClause('lot', lot));
  if (block) clauses.push(likeClause('block', block));
  if (desc)  clauses.push(likeClause('description', desc));
  // ...
}
```

If the new dataset uses different column names (e.g. `lot_number` instead of `lot`), just change the string in `likeClause('lot_number', lot)`.

### 5.3 Update `fetchAssessmentOverlap` geometry column + $select

```js
export async function fetchAssessmentOverlap(surveyFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: ASSESS_URL,
    geomColumn: 'geometry',   // ← the SoQL column name for the polygon
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    //        ↑ only fetch columns you actually display; reduces payload
    dedupeKey: 'roll_number', // ← the unique identifier for assessment parcels
    fc: surveyFc,
  });
}
```

### 5.4 Update `fetchSurveyOverlap` geometry column

```js
export async function fetchSurveyOverlap(assessFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: SURVEY_URL,
    geomColumn: 'location',   // ← Winnipeg calls it 'location', not 'geometry'
    select: null,             // ← null means fetch all columns
    dedupeKey: 'id',          // ← the unique identifier for survey parcels
    fc: assessFc,
  });
}
```

### 5.5 Update `searchAssessmentParcels` field names + $select

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
    $limit: '500',
  });
}
```

### 5.6 Keep `fetchPerFeatureBboxUnion` unchanged

This function is generic — it takes `{ baseUrl, geomColumn, select, dedupeKey, fc }` and handles batching, parallelism, deduplication, and the 150m bbox padding. Do not modify it unless the new portal has a different spatial query syntax (see [Section 12](#12-non-socrata-portals)).

### 5.7 Keep `likeClause` unchanged

```js
function likeClause(column, value) {
  return `upper(${column}) like '%${escapeSoql(String(value).toUpperCase())}%'`;
}
```

The `upper()` wrap is critical — Socrata `LIKE` is case-sensitive and data is often stored in uppercase. Without this, searching `monarch` finds nothing even though `10 MONARCH MEWS` exists.

---

## 6. Step 2 — Adapt `index.html` (search inputs + table columns)

### 6.1 Search inputs

Each input has:
- An `id` that `main.js` reads
- A `size` attribute controlling the visual width (in characters)
- A `placeholder` that shows when the box is empty
- A `<span class="tip">` sibling that shows on focus as a tooltip

```html
<span class="field">
  <input id="lot" type="text" size="12" placeholder="Lot" />
  <span class="tip">Lot (or River Lot or Section)</span>
</span>
```

Change the `id`, `placeholder`, and `.tip` text to match the new jurisdiction's terminology.

### 6.2 Table columns

```html
<thead>
  <tr>
    <th>Lot</th>
    <th>Block</th>
    <th>Plan</th>
    <th>Description</th>
    <th>Roll Number</th>
    <th>Full Address</th>
    <th>Zoning</th>
    <th>Size (sf)</th>
    <th>Lat</th>
    <th>Lon</th>
  </tr>
</thead>
```

The column order must match the order `renderTable` appends cells in `main.js`. If you add or remove columns, update both files together.

### 6.3 Column alignment

In `style.css`, centre-alignment is the default. Columns 4 (Description), 6 (Full Address), 7 (Zoning) are overridden to left-align via `nth-child`:

```css
#results th:nth-child(4), #results td:nth-child(4),
#results th:nth-child(6), #results td:nth-child(6),
#results th:nth-child(7), #results td:nth-child(7) {
  text-align: left;
}
```

If you add/remove columns, update these indices.

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

If the new dataset has only one dataset (no separate survey/assessment split), delete one flow and always call the remaining one.

### 7.3 `renderTable` — cell order

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

`s` = survey feature properties, `a` = assessment feature properties. Change the property names to match the new dataset's column names.

### 7.4 `exportCsv` — column list

```js
const header = [
  'Lot', 'Block', 'Plan', 'Description',
  'Roll Number', 'Full Address', 'Zoning',
  'Size (sf)', 'Lat', 'Lon',
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

Update both lists in lockstep.

### 7.5 `tagFeatures` — row-key scheme

```js
function tagFeatures(fc, side) {
  for (const f of fc.features) {
    const p = f.properties || (f.properties = {});
    if (side === 'survey') {
      p._rowKey = p.id != null ? `s:${p.id}` : null;      // ← 'id' is the Winnipeg survey unique key
    } else {
      p._rowKey = p.roll_number != null ? `a:${p.roll_number}` : null;  // ← assessment unique key
    }
  }
}
```

Change `p.id` and `p.roll_number` to the unique identifier columns of the new datasets. These must be stable string or numeric values — they are used to correlate map clicks with table rows.

### 7.6 `formatArea`

```js
function formatArea(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n).toLocaleString('en-US');
}
```

Winnipeg's `assessed_land_area` is in **square feet** as a plain integer string. If the new jurisdiction stores area in square metres, either convert (`n * 10.764`) or change the column header to `Size (m²)`.

---

## 8. Step 4 — Adapt `map.js` (popup labels)

The hover popup detects which dataset a feature came from by looking at its properties:

```js
function popupHtml(p) {
  if (p.roll_number != null || p.full_address != null) {
    // Assessment Parcels schema
    const lines = [];
    if (p.roll_number) lines.push(`<strong>Roll #</strong> ${escapeHtml(p.roll_number)}`);
    if (p.full_address) lines.push(escapeHtml(p.full_address));
    if (p.zoning) lines.push(`<em>${escapeHtml(p.zoning)}</em>`);
    return lines.join('<br>');
  }
  // Survey Parcels schema
  const head = `<strong>Lot</strong> ${escapeHtml(p.lot ?? '')}`
    + `&nbsp;<strong>Block</strong> ${escapeHtml(p.block ?? '')}`
    + `&nbsp;<strong>Plan</strong> ${escapeHtml(p.plan ?? '')}`;
  return p.description ? `${head}<br>${escapeHtml(p.description)}` : head;
}
```

Update the property names and labels to match the new datasets.

---

## 9. Step 5 — Deploy to Vercel

1. Push the repo to GitHub (public or private — both work on the free Hobby tier).
2. Go to `vercel.com/new`, import the repo.
3. Vercel reads `vercel.json` at the root and auto-configures the build.
4. Every `git push` to `main` triggers an automatic redeploy.

**Optional app token** (raises the anonymous Socrata rate limit from 1 000 to 100 000 requests/hour):
1. Register free at `https://data.example.ca/profile/edit/developer_settings`
2. Add env var `VITE_SODA_APP_TOKEN=<token>` in Vercel Project Settings → Environment Variables
3. Redeploy

The `soda.js` client already reads `import.meta.env.VITE_SODA_APP_TOKEN` — no code change needed.

---

## 10. Bugs and gotchas already solved

These are real bugs found during development. They will likely recur with any Socrata-based dataset.

### 10.1 `LIKE` is case-sensitive

**Symptom:** Searching `monarch` returns no results even though `10 MONARCH MEWS` exists.

**Root cause:** SoQL `LIKE` is case-sensitive. Data is often stored in uppercase.

**Fix (already in `likeClause`):**
```js
function likeClause(column, value) {
  return `upper(${column}) like '%${escapeSoql(String(value).toUpperCase())}%'`;
}
```

### 10.2 `within_box` uses containment, not intersection

**Symptom:** A legal-description search for a River Lot finds the survey parcel but no assessment parcel, even though a house clearly sits on the lot.

**Root cause:** Socrata's `within_box(geom, ...)` returns only rows whose geometry is **fully contained** in the query box. Survey and assessment parcel boundaries are digitised independently and rarely align perfectly. An assessment parcel that extends even a few metres past the survey parcel's bounding box is excluded.

**Fix (already in `fetchPerFeatureBboxUnion`):**
```js
const PAD_DEG = 0.002;  // ≈ 150 m — adjust if your parcels have larger edge mismatches
// ...
return `within_box(${geomColumn},${round(maxLat + PAD_DEG)},${round(minLon - PAD_DEG)},${round(minLat - PAD_DEG)},${round(maxLon + PAD_DEG)})`;
```

The `booleanIntersects` client-side pass then eliminates false positives, so the padding adds only a bit of extra network payload, not incorrect results.

### 10.3 Spatially-spread searches hit the `$limit` before reaching the target parcels

**Symptom:** Searching for an address that matches two distant neighbourhoods (e.g. "Woodstock" and "Stockdale") returns results from both, but legal descriptions are blank for both.

**Root cause:** Naïve implementation uses one union bounding box across all results. When those results are far apart, the union bbox covers a huge area. The `within_box` query fills `$limit` with unrelated parcels in between, and the ones near Woodstock or Stockdale never come back.

**Fix (already in `fetchPerFeatureBboxUnion`):** One small `within_box` clause per feature, OR'd together, batched in groups of 50, run in parallel. Each clause's bbox is tiny (just that one parcel ± 150m padding).

### 10.4 Topology errors in `booleanIntersects`

**Symptom:** Console shows `booleanIntersects error; falling back to unmatched row`. Some parcels have no enrichment.

**Root cause:** Some parcel geometries in the wild have self-intersections or other topology problems that crash turf.js.

**Fix (already in the join functions):**
```js
try {
  matches = assessFc.features.filter((a) => booleanIntersects(s, a));
} catch (err) {
  console.warn('booleanIntersects error; falling back to unmatched row', err);
  matches = [];
}
```

The row still appears in the table with the survey columns filled; it just shows `—` for the enrichment columns.

---

## 11. SoQL quick reference

| Operation | SoQL syntax |
|---|---|
| Partial text match (case-sensitive) | `column like '%value%'` |
| Partial text match (case-insensitive) | `upper(column) like '%VALUE%'` |
| Exact match | `column = 'value'` |
| Multiple conditions (AND) | `clause1 AND clause2` |
| Multiple conditions (OR) | `clause1 OR clause2` |
| Spatial containment | `within_box(geom_col, nwLat, nwLon, seLat, seLon)` |
| Select specific columns | `$select=col1,col2,col3` |
| Row limit | `$limit=500` |
| GeoJSON output | Replace `.json` with `.geojson` in the resource URL |
| Escape a single quote | Double it: `O''Brien` |

`within_box` argument order: **NW corner first** (max lat, min lon), then **SE corner** (min lat, max lon).

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
- `esriSpatialRelIntersects` tests intersection, not containment — **no padding needed**.
- Attribute queries use SQL syntax: `where=UPPER(LOT) LIKE '%50%'`
- CORS varies; some ArcGIS services need a proxy.

### CKAN

CKAN is a data catalogue, not a query engine. Datasets are usually downloadable files (GeoJSON, CSV, Shapefile). If the data is only available as a file download, the live-query approach doesn't work — you'd need to pre-process and host the data yourself (or use a serverless function to run spatial queries against a PostGIS database).

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
