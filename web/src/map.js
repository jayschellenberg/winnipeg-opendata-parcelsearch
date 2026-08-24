// MapLibre GL JS map setup with a free CartoDB Positron basemap.
// No API key required.
//
// One GeoJSON source (`parcel-results`) is used for both search flows:
//   - Legal-description search pushes Survey Parcels geometry into it
//   - Roll-number search pushes Assessment Parcels geometry into it
// The hover popup figures out which schema the feature is carrying.

import maplibregl from 'maplibre-gl';
// Bundle MapLibre's stylesheet through Vite instead of loading it from the
// unpkg CDN at runtime — removes a third-party request with no Subresource
// Integrity and keeps the Content-Security-Policy free of a CDN style origin.
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import bbox from '@turf/bbox';
import turfArea from '@turf/area';
import turfLength from '@turf/length';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import {
  addShapeLayers,
  initShapeDraw,
  shapeClickHandled,
  isShapeDrawing,
} from './drawShapes.js';
import {
  CITYWIDE_PARCELS_LINE_STYLES,
  applyCitywideParcelsBasemapStyle,
} from './lib/citywideParcelsStyle.js';
import { formatDollars } from './lib/cells.js';

// mapbox-gl-draw was written against the Mapbox GL `mapboxgl-*` DOM
// class names; MapLibre uses `maplibregl-*`. Patch the lookup table
// before construction so the control mounts cleanly into MapLibre's
// control container (and inherits our `.maplibregl-ctrl-group` styling).
MapboxDraw.constants.classes.CANVAS         = 'maplibregl-canvas';
MapboxDraw.constants.classes.CONTROL_BASE   = 'maplibregl-ctrl';
MapboxDraw.constants.classes.CONTROL_PREFIX = 'maplibregl-ctrl-';
MapboxDraw.constants.classes.CONTROL_GROUP  = 'maplibregl-ctrl-group';
MapboxDraw.constants.classes.ATTRIBUTION    = 'maplibregl-ctrl-attrib';

// Register the pmtiles:// protocol so MapLibre can read vector tiles
// from a single .pmtiles archive served as a static asset on Vercel.
// Used by the citywide-parcels overlay (web/public/parcels.pmtiles).
// Idempotent — addProtocol() simply replaces if already registered.
maplibregl.addProtocol('pmtiles', new Protocol().tile);

// Path the JS uses to fetch the citywide-parcels archive. Lives in
// web/public/ and is served as a static asset from the site root.
// Generated offline by r/build_parcel_tiles.R + tippecanoe; see the
// REPLICATION_GUIDE for the build pipeline.
const CITYWIDE_PARCELS_URL = 'pmtiles:///parcels.pmtiles';

const WINNIPEG_CENTER = [-97.14, 49.89];

// Parcel-number badge colour, matched to the Manitoba app so a Winnipeg
// and a Manitoba exhibit sitting side by side in one report read as the
// same convention. Deep red, chosen to stay legible over both the cream
// streets basemap and the dark aerial imagery.
const PARCEL_NUM_COLOR = 'rgb(149, 18, 30)';

/*
 * Assessment-result highlight, matched to the Manitoba app so a Winnipeg
 * and a Manitoba exhibit read identically side by side in one report.
 *
 * Both values are shared by the dashed colour line and its solid black
 * underlay. The two MUST stay in lockstep: the underlay exists to show
 * through the dashes, so any width difference turns it into a casing
 * around the yellow instead of alternating with it.
 *
 * `groupHover` is set on every parcel of a multi-parcel sale when the
 * cursor enters any one of them, so a hovered transaction lifts as a
 * whole rather than one lot at a time.
 */
const ASSESS_LINE_WIDTH = [
  'case',
  ['boolean', ['feature-state', 'groupHover'], false],
  3.0,
  2.0,
];
const ASSESS_FILL_OPACITY = [
  'case',
  ['boolean', ['feature-state', 'groupHover'], false],
  0.5,
  0.3,
];

// Categorical fill colors keyed off the dataset's `map_colour` field. Values
// taken from a $group=map_colour query against dxrp-w6re — 13 categories
// covering ~99% of city zones, with a neutral grey fallback for anything
// that gets added later. Tuned to read clearly under a 0.4 alpha overlay.
// Exported so main.js can render the floating legend with matching swatches.
export const ZONING_PALETTE = [
  'Single Family Residential',  '#fff4a3',
  'Two Family Residential',     '#ffd9a0',
  'Multi-Family Residential',   '#f5b97d',
  'Commercial',                 '#f08d8d',
  'Parks and Recreation',       '#9ccc9c',
  'Industrial',                 '#b5b0cc',
  'Agricultural',               '#e0d596',
  'Rural Residential',          '#d9c8a3',
  'Multi-Use Sector',           '#c8a2c8',
  'Character Sector',           '#d2b5dc',
  'Downtown Living Sector',     '#ffab80',
  'Educational & Institutional','#a3c4e8',
  'Riverbank Sector',           '#99c5c5',
];

const TRAFFIC_VOLUME_VALUE = ['to-number', ['get', 'avg_daily_volume'], 0];
const TRAFFIC_COLOR_EXPR = [
  'interpolate',
  ['linear'],
  TRAFFIC_VOLUME_VALUE,
  0,     '#4f9d69',
  5000,  '#d6c94f',
  15000, '#e59a3d',
  30000, '#d45a43',
  60000, '#7b3f98',
];
const TRAFFIC_LINE_WIDTH_EXPR = [
  'interpolate',
  ['linear'],
  TRAFFIC_VOLUME_VALUE,
  0,     1.5,
  5000,  2.5,
  15000, 4,
  30000, 6,
  60000, 9,
];
const TRAFFIC_LINE_CASING_WIDTH_EXPR = [
  'interpolate',
  ['linear'],
  TRAFFIC_VOLUME_VALUE,
  0,     3.5,
  5000,  4.5,
  15000, 6,
  30000, 8,
  60000, 11,
];
const TRAFFIC_POINT_RADIUS_EXPR = [
  'interpolate',
  ['linear'],
  TRAFFIC_VOLUME_VALUE,
  0,     4,
  5000,  6,
  15000, 8,
  30000, 11,
  60000, 14,
];

const DWELLING_COUNT_EXPR = ['to-number', ['get', 'dwelling_unit_count'], 1];
const DWELLING_COLOR_EXPR = [
  'step', DWELLING_COUNT_EXPR,
  '#2563eb',
  5,  '#7c3aed',
  20, '#dc2626',
  50, '#7f1d1d',
];
const DWELLING_MULTI_RADIUS_EXPR = [
  'step', DWELLING_COUNT_EXPR,
  7,
  5,  9,
  20, 12,
  50, 15,
];
const DWELLING_LAYER_IDS = [
  'dwelling-units-single-label',
  'dwelling-units-multi-circle',
  'dwelling-units-multi-label',
  'dwelling-condo-circle',
  'dwelling-condo-label',
];

// Two basemap sources stacked under one style — only one is visible at a
// time. Lets the user flip between the default light street map and an
// Esri-hosted aerial without re-creating the map. Esri World Imagery is
// free for non-commercial / appraisal-research use and requires no key.
const BASEMAP_STYLE = {
  version: 8,
  // Public glyph server for symbol-layer text (zoning code labels).
  // demotiles.maplibre.org is MapLibre's official demo CDN and is the most
  // reliable free option. Available stacks include "Open Sans Semibold".
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'carto-positron': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    'esri-imagery': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution:
        'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    // Transparent reference overlays for imagery views. Satellite uses both
    // Esri transportation and place/boundary labels. City aerials use only the
    // place/boundary layer; their road overlay comes from Winnipeg's current
    // vector Road Network instead (loaded by main.js on aerial entry).
    'esri-transportation': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Transportation &copy; Esri',
    },
    'esri-reference': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Reference &copy; Esri',
    },
  },
  layers: [
    // Carto streets is the default. Satellite (imagery + the two
    // transparent label overlays) starts hidden; the basemap
    // toggle in the top-right swaps them in lockstep. Explicit
    // `visibility: 'visible' / 'none'` on every layer so
    // getLayoutProperty returns a real string on first click.
    {
      id: 'carto-positron',
      type: 'raster',
      source: 'carto-positron',
      minzoom: 0,
      maxzoom: 20,
      layout: { visibility: 'visible' },
    },
    {
      id: 'esri-imagery',
      type: 'raster',
      source: 'esri-imagery',
      minzoom: 0,
      maxzoom: 20,
      layout: { visibility: 'none' },
    },
    {
      id: 'esri-transportation',
      type: 'raster',
      source: 'esri-transportation',
      minzoom: 0,
      maxzoom: 20,
      layout: { visibility: 'none' },
    },
    {
      id: 'esri-reference',
      type: 'raster',
      source: 'esri-reference',
      minzoom: 0,
      maxzoom: 20,
      layout: { visibility: 'none' },
    },
  ],
};

// City of Winnipeg aerial ORTHO basemaps (7.5 cm, year-stamped) as an optional
// THIRD basemap. Each year is built offline from the City's whole-city ECW
// mosaic (r/build_ortho_tiles.ps1) and hosted as its own raster PMTiles archive
// on Cloudflare R2 (one bucket, wpg-ortho-<year>.pmtiles). When the basemap
// control is on Aerial, a year picker switches between the years below.
//
// ORTHO_YEARS is NEWEST FIRST — the first entry is the default aerial year.
// Add a year: build + upload wpg-ortho-<year>.pmtiles to the bucket, then add
// the year here keeping the list newest-first (prepend a newer year, append an
// older one; same R2 host, so no vercel.json CSP change needed).
// Empty ⇒ the control stays a 2-state streets<->satellite toggle (ships inert).
//
// This list and the bucket are checked against each other quarterly by
// r/refresh_assets.ps1 (see r/lib_ortho.ps1), which emails if a year listed
// here has no archive — that year renders a BLANK basemap, silently — or if an
// archive exists that nobody listed. So forgetting either half of the two-step
// is noticed, but it is still two steps: don't rely on the check as the
// reminder.
const ORTHO_R2_BASE = 'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev';
export const ORTHO_YEARS = [2026, 2024, 2021, 2018, 2016];
export const ORTHO_YEAR = ORTHO_YEARS[0]; // newest; kept for single-year references
if (ORTHO_YEARS.length) {
  // Every ortho layer sits above the Esri imagery (which shows through beyond
  // the City extent / when overzoomed) and below the two transparent label
  // layers, so place + road names stay legible. Only one is ever visible.
  const insertAt = BASEMAP_STYLE.layers.findIndex((l) => l.id === 'esri-transportation');
  ORTHO_YEARS.forEach((year, i) => {
    BASEMAP_STYLE.sources[`ortho-${year}`] = {
      type: 'raster',
      url: `pmtiles://${ORTHO_R2_BASE}/wpg-ortho-${year}.pmtiles`,
      tileSize: 256,
      // The archives span z12–z20 (gdaladdo overview levels). Declare the range
      // so MapLibre overzooms the z20 tiles past 20 rather than requesting tiles
      // the pmtiles protocol answers with null (which blanks the layer), and
      // doesn't fetch below z12 — where the Esri imagery shows through.
      minzoom: 12,
      maxzoom: 20,
      attribution: `Aerial imagery &copy; City of Winnipeg ${year}`,
    };
    BASEMAP_STYLE.layers.splice(insertAt < 0 ? BASEMAP_STYLE.layers.length : insertAt + i, 0, {
      id: `ortho-${year}`, type: 'raster', source: `ortho-${year}`, layout: { visibility: 'none' },
    });
  });
}

// mapbox-gl-draw style spec for the measurement tool. High-contrast
// orange (#ff4d00) reads cleanly on both the cream CARTO Positron
// streets basemap and the dark Esri imagery; white halo around each
// vertex keeps the click-targets visible. A single set of unfiltered
// styles per geometry kind avoids the active/inactive-filter
// rendering gap mapbox-gl-draw's default theme has on MapLibre 4.x.
const MEASURE_DRAW_COLOR = '#ff4d00';
const MEASURE_DRAW_STYLES = [
  {
    id: 'gl-draw-polygon-fill',
    type: 'fill',
    filter: ['all', ['==', '$type', 'Polygon']],
    paint: {
      'fill-color': MEASURE_DRAW_COLOR,
      'fill-outline-color': MEASURE_DRAW_COLOR,
      'fill-opacity': 0.18,
    },
  },
  {
    id: 'gl-draw-polygon-stroke',
    type: 'line',
    filter: ['all', ['==', '$type', 'Polygon']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': MEASURE_DRAW_COLOR, 'line-width': 2 },
  },
  {
    id: 'gl-draw-line',
    type: 'line',
    filter: ['all', ['==', '$type', 'LineString']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': MEASURE_DRAW_COLOR, 'line-width': 2 },
  },
  {
    id: 'gl-draw-vertex-halo',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
    paint: {
      'circle-radius': 6,
      'circle-color': '#fff',
      'circle-stroke-width': 1,
      'circle-stroke-color': MEASURE_DRAW_COLOR,
    },
  },
  {
    id: 'gl-draw-vertex',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
    paint: { 'circle-radius': 3.5, 'circle-color': MEASURE_DRAW_COLOR },
  },
  {
    id: 'gl-draw-midpoint',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'midpoint'], ['==', '$type', 'Point']],
    paint: {
      'circle-radius': 3,
      'circle-color': MEASURE_DRAW_COLOR,
      'circle-opacity': 0.55,
    },
  },
];

export function initMap(container, { onFeatureClick, onBasemapChange } = {}) {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    center: WINNIPEG_CENTER,
    zoom: 11,
    attributionControl: { compact: true },
    // Keep the WebGL framebuffer readable so canvas.toDataURL() works
    // for the "Generate Static Map" feature. Small perf cost on
    // continuous interaction; fine for our scale.
    preserveDrawingBuffer: true,
  });

  // Expose for debugging in any environment. Lets the dev console (or
  // the Chrome MCP) inspect the map source data, layers, and viewport
  // when troubleshooting why a search isn't highlighting expected
  // parcels. Harmless side effect — just a global reference.
  window._map = map;

  map.on('error', (e) => {
    console.error('[map error]', e?.error?.message || e, e);
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new BasemapMenuControl(onBasemapChange), 'top-right');
  // Distance / area measurement tool. mapbox-gl-draw owns the
  // in-progress geometry; MeasureControl wraps it in a small panel
  // with mode switches and a live readout. Explicit unfiltered
  // styles (above) sidestep the active/inactive split that breaks
  // vertex rendering on MapLibre 4.x with mapbox-gl-draw's default
  // theme.
  const measureDraw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: MEASURE_DRAW_STYLES,
  });
  map.addControl(measureDraw);
  map.addControl(new MeasureControl(measureDraw), 'top-right');

  // Area-selection draw tools. Deliberately NOT sharing the MapboxDraw
  // instance above — the measure tool owns its modes/styles/deleteAll
  // lifecycle and has already broken once on a neighbouring control's
  // change. Wired here, before setupLayers registers the layer popup
  // handlers, so drawShapes' general click handler runs first and can
  // mark an event consumed (see shapeClickHandled).
  initShapeDraw(map);

  const ready = new Promise((resolve) => {
    // MapLibre 4.x's 'load' event is unreliable — the Manitoba sister app
    // saw "never fires after 15 s" in dev (REFACTOR_NOTES §6), and a
    // hidden/headless tab can defer it indefinitely. Waiting on 'load'
    // alone left every mapReady.then(...) (overlay toggles, search
    // rendering on the map) queued forever with no error. Race several
    // triggers + a poll + a loud 30 s failsafe; setupLayers runs exactly
    // once, and a thrown "Style is not done loading" re-arms so the next
    // trigger retries.
    let setupDone = false;
    // DO NOT gate this on map.isStyleLoaded(). That predicate is true only when
    // the style spec has parsed AND every source in it reports loaded, and the
    // five ortho pmtiles archives are sources that can fail to load: they are
    // fetched from Cloudflare R2, and a CORS rejection, an offline machine or
    // an outage leaves them permanently un-loaded. isStyleLoaded() then never
    // becomes true, this poll returns early forever, and the app sits on its
    // nine base style layers with all sixty-odd overlays missing — no parcels,
    // no zoning, no search highlight. The 30 s failsafe below could not rescue
    // it either, because it re-armed on a throw and every subsequent poll tick
    // hit this same early return.
    //
    // Reproduced 2026-08-24 by serving dev on a port the R2 bucket's CORS
    // policy does not allow: style._loaded true, isStyleLoaded() false forever,
    // getStyle().layers.length stuck at 9. addSource/addLayer only require
    // style._loaded, so setupLayers() would have succeeded the whole time.
    //
    // So: just attempt it. setupLayers() throws "Style is not done loading"
    // while the style spec is still parsing, runSetup() catches that and
    // re-arms, and the poll retries — which is what the retry was always for.
    // A slow or dead BASEMAP source must not be able to withhold the app.
    const trySetup = () => {
      if (setupDone || !map.style) return;
      runSetup();
    };
    const runSetup = () => {
      if (setupDone) return;
      setupDone = true;
      try {
        setupLayers();
        map.off('load', trySetup);
        map.off('idle', trySetup);
        map.off('styledata', trySetup);
        resolve();
      } catch (err) {
        console.warn('[map] layer setup failed; retrying on next style event', err);
        setupDone = false;
      }
    };
    map.on('load', trySetup);
    map.on('idle', trySetup);
    map.on('styledata', trySetup);
    const poll = setInterval(() => {
      if (setupDone) { clearInterval(poll); return; }
      trySetup();
    }, 250);
    // At 30 s, warn and force one attempt — but KEEP POLLING.
    //
    // This used to clearInterval(poll) here, on the theory that "a later
    // style event can still rescue it". It cannot. The forced runSetup()
    // throws "Style is not done loading" while the style is still
    // resolving, which resets setupDone and leaves the retry entirely to
    // the 'load'/'idle'/'styledata' handlers — and those do not fire
    // again reliably once the map has settled. Killing the poll therefore
    // removed the only dependable retry.
    //
    // Observed on production: a cold load left the map with its 9 base
    // style layers and NOTHING else — no parcel fill, no zoning, no
    // overlays — because the five ortho pmtiles archives each need a
    // header fetch from R2 before the style counts as loaded, which can
    // exceed 30 s. Firing 'styledata' by hand afterwards immediately
    // built all 69 layers, confirming the setup code was fine and only
    // the retry had been switched off.
    setTimeout(() => {
      if (setupDone) return;
      console.warn('[map] style not loaded after 30 s — forcing layer setup; polling continues until it succeeds');
      runSetup();
    }, 30000);
    // Hard stop, so a genuinely broken style can't poll forever.
    setTimeout(() => {
      if (setupDone) return;
      clearInterval(poll);
      console.error('[map] layer setup never succeeded after 5 min — the map will show the basemap only');
    }, 300000);

    function setupLayers() {
      // Zoning layer goes in first so it draws *under* the parcel highlight.
      // OurWinnipeg policy-area overlays — three independent toggleable
      // layers stacked beneath the parcel highlights. Each is a single
      // small dataset (5-24 polygons), fetched whole and cached on first
      // toggle. Drawn in this order: Secondary Plans → Infill →
      // Malls/Corridors so the most-specific (Malls/Corridors PDO) sits
      // on top of the broader policy areas underneath.

      // Secondary Plans — combined Precincts (5) + Major Redevelopment
      // Sites (11). Two `plan_kind` shades so the user can distinguish
      // new-community precincts from major-infill redevelopment areas.
      // Labels use precinct_name when present (Precincts), else
      // feature_name (Major Redev sites).
      map.addSource('secondary-plans', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'secondary-plans-fill', type: 'fill', source: 'secondary-plans',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match', ['get', 'plan_kind'],
            'Precinct',            '#8e6cb3',
            'Major Redevelopment', '#c47bd6',
            '#a07ec5',
          ],
          'fill-opacity': 0.18,
        },
      });
      map.addLayer({
        id: 'secondary-plans-line', type: 'line', source: 'secondary-plans',
        layout: { visibility: 'none' },
        paint: {
          'line-color': [
            'match', ['get', 'plan_kind'],
            'Precinct',            '#5a3d8a',
            'Major Redevelopment', '#7a3a92',
            '#5a3d8a',
          ],
          'line-width': 2.5,
        },
      });
      map.addLayer({
        id: 'secondary-plans-label', type: 'symbol', source: 'secondary-plans',
        layout: {
          visibility: 'none',
          'text-field': [
            'coalesce',
            ['get', 'precinct_name'],
            ['get', 'feature_name'],
            '',
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': 13,
          'symbol-placement': 'point',
          'text-max-width': 9,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#3d255e',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      });

      // Infill Guideline Area (OurWPG Mature Community) — 5 polygons,
      // green outline only (no fill — these are big neighbourhoods and
      // a fill would obscure everything underneath).
      map.addSource('infill-guideline', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'infill-guideline-fill', type: 'fill', source: 'infill-guideline',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#5aa05a', 'fill-opacity': 0.10 },
      });
      map.addLayer({
        id: 'infill-guideline-line', type: 'line', source: 'infill-guideline',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#2e5e2e', 'line-width': 2.5, 'line-dasharray': [2, 2] },
      });

      // Malls and Corridors PDO (combined: Regional Mixed Use Centre +
      // Urban Mixed Use Corridor + Regional Mixed Use Corridor). Each
      // sub-kind gets its own colour via a `pdo_kind` match expression.
      map.addSource('malls-corridors', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'malls-corridors-fill', type: 'fill', source: 'malls-corridors',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match',
            ['get', 'pdo_kind'],
            'Mall',              '#2c8aa8',
            'Urban Corridor',    '#4fb3c7',
            'Regional Corridor', '#1f6680',
            '#5fa8b8',
          ],
          'fill-opacity': 0.22,
        },
      });
      map.addLayer({
        id: 'malls-corridors-line', type: 'line', source: 'malls-corridors',
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#0e3848',
          'line-width': 2,
        },
      });

      // Transit overlays (routes + stops). Both source FCs ship as
      // static GeoJSON under /public, generated from the Winnipeg
      // Transit GTFS feed by web/scripts/build-transit-geojson.mjs.
      // Routes carry an official route_color property; stops carry
      // stop_code / stop_name / routes for the click popup.
      map.addSource('transit-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('transit-stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'transit-routes-line', type: 'line', source: 'transit-routes',
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'route_color'], '#6b7280'],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            10, 1.2,
            13, 2.0,
            16, 3.4,
            18, 4.4,
          ],
          'line-opacity': 0.85,
        },
      });
      map.addLayer({
        id: 'transit-stops-halo', type: 'circle', source: 'transit-stops',
        layout: { visibility: 'none' },
        minzoom: 12,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            12, 2.5,
            15, 4.0,
            18, 6.0,
          ],
          'circle-color': '#ffffff',
          'circle-opacity': 0.95,
          'circle-stroke-color': '#1f2937',
          'circle-stroke-width': 1,
        },
      });
      map.addLayer({
        id: 'transit-stops-circle', type: 'circle', source: 'transit-stops',
        layout: { visibility: 'none' },
        minzoom: 13,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            13, 1.4,
            16, 2.4,
            18, 3.4,
          ],
          'circle-color': '#0064b1',
          'circle-opacity': 1,
        },
      });

      // Neighbourhood overlays — two source FCs ship as static
      // GeoJSON under /public, processed by
      // build-neighbourhoods-geojson.mjs. The user-facing button
      // cycles Off -> Clusters -> Neighbourhoods -> Off.
      map.addSource('wpg-neighbourhoods', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('wpg-neighbourhood-clusters', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('wpg-neighbourhood-cluster-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('wpg-neighbourhood-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'neighbourhood-clusters-fill', type: 'fill', source: 'wpg-neighbourhood-clusters',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'neighbourhood-clusters-line-casing', type: 'line', source: 'wpg-neighbourhood-clusters',
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'neighbourhood-clusters-line', type: 'line', source: 'wpg-neighbourhood-clusters',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: { 'line-color': '#0369a1', 'line-width': 2.5, 'line-opacity': 0.95 },
      });
      map.addLayer({
        id: 'neighbourhood-clusters-label', type: 'symbol', source: 'wpg-neighbourhood-cluster-labels',
        layout: {
          visibility: 'none',
          'text-field': ['get', 'cluster'],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            9, 15,
            12, 20,
            15, 22,
          ],
          'text-anchor': 'center',
          'text-allow-overlap': false,
          'text-padding': 4,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#0c4a6e',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2.5,
        },
      });
      map.addLayer({
        id: 'neighbourhoods-fill', type: 'fill', source: 'wpg-neighbourhoods',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'neighbourhoods-line-casing', type: 'line', source: 'wpg-neighbourhoods',
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 3.5, 'line-opacity': 0.65 },
      });
      map.addLayer({
        id: 'neighbourhoods-line', type: 'line', source: 'wpg-neighbourhoods',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: { 'line-color': '#0369a1', 'line-width': 1.5, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'neighbourhoods-label', type: 'symbol', source: 'wpg-neighbourhood-labels',
        minzoom: 12,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            12, 18,
            14, 22,
            17, 26,
          ],
          'text-anchor': 'center',
          'text-allow-overlap': false,
          'text-padding': 3,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#0c4a6e',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2.5,
        },
      });

      // Source starts empty; main.js populates it when the user toggles
      // zoning on. `visibility: none` keeps it hidden until then.
      map.addSource('zoning', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'zoning-fill',
        type: 'fill',
        source: 'zoning',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': [
            'match',
            ['get', 'map_colour'],
            ...ZONING_PALETTE,
            '#cccccc',
          ],
          'fill-opacity': 0.45,
          // Slightly darker outline so the per-zone fill colour
          // edges read cleanly at every basemap. Matches the
          // Manitoba sister app's zoning-fill outline.
          'fill-outline-color': '#444',
        },
      });
      map.addLayer({
        id: 'zoning-line',
        type: 'line',
        source: 'zoning',
        layout: { visibility: 'none' },
        // Slightly darker + more opaque than the previous #444 @ 0.6,
        // matching the Manitoba sister app for stronger boundary
        // visibility on both basemaps.
        paint: {
          'line-color': '#333',
          'line-width': 0.6,
          'line-opacity': 0.7,
        },
      });
      // Zoning code label, placed at the polygon centroid by default.
      // Filtered to codes ≤5 chars so long edge-cases (e.g. an unusual
      // overlay-district name) don't overflow the polygon. White halo
      // keeps the code legible regardless of the underlying fill colour.
      map.addLayer({
        id: 'zoning-label',
        type: 'symbol',
        source: 'zoning',
        layout: {
          visibility: 'none',
          'text-field': [
            'case',
            ['<=', ['length', ['coalesce', ['get', 'zoning'], '']], 5],
            ['get', 'zoning'],
            '',
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': 22,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2.8,
        },
      });

      // Winnipeg Streets — the City road-network centrelines (Open Data
      // "Road Network", ngsx-caav), as an optional reference overlay that works
      // over ANY basemap (streets / satellite / each aerial year). Source starts
      // empty; main.js populates it on first toggle. A dark casing + white core
      // reads on both the light street map and the dark imagery; street names
      // follow the line (symbol-placement:line) and appear from zoom 13.
      map.addSource('streets', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'streets-line-casing',
        type: 'line',
        source: 'streets',
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': 'rgba(26,42,74,0.5)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.8, 14, 3.4, 18, 9],
        },
      });
      map.addLayer({
        id: 'streets-line',
        type: 'line',
        source: 'streets',
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.7, 14, 1.7, 18, 5.5],
        },
      });
      map.addLayer({
        id: 'streets-label',
        type: 'symbol',
        source: 'streets',
        minzoom: 13,
        layout: {
          visibility: 'none',
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'full_name'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 18, 14],
          'symbol-spacing': 260,
          'text-max-angle': 40,
          'text-padding': 2,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
        },
      });

      // Citywide assessment parcels — every parcel (~245K) served as a
      // single PMTiles archive. Vector source so it's sharp at any zoom
      // and stays interactive (hover/click). Hidden by default; the
      // user toggles via "Show All Parcels". Drawn under the
      // search-result highlight so selected parcels (yellow fill)
      // visibly stand out against the citywide light-grey wash.
      // The archive is built offline by r/build_parcel_tiles.R; if it
      // hasn't been built yet the source request returns 404 and the
      // toggle handler surfaces a "tiles not built" message.
      map.addSource('citywide-parcels', {
        type: 'vector',
        url: CITYWIDE_PARCELS_URL,
        // The .pmtiles archive is built with --maximum-zoom=18 (see
        // r/build_parcel_tiles.R). Tell MapLibre that's the cap so it
        // overzooms level-18 tile data past z18 instead of trying to
        // fetch z19+ tiles that don't exist (protocol returns null →
        // entire layer goes blank when zoomed in past 18).
        maxzoom: 18,
      });
      // Citywide parcels intentionally render as line-only, no fill.
      // The pmtiles archive includes one feature per assessment record,
      // and condo buildings have many units that share a single building
      // polygon — at fill-opacity 0.06, 50 stacked condo units would
      // composite to ~95% opaque, producing the "dark blue chunks" the
      // user reported. Lines stack mathematically the same way but a
      // stacked 1px line just renders as a normal solid line. The
      // long-term fix lives in build_parcel_tiles.R: dedupe by
      // geometry before handing GeoJSON to tippecanoe so each unique
      // polygon ends up as one feature.
      // Invisible fill layer over the citywide-parcels source — captures
      // hover hits anywhere on a polygon body so the tooltip works even
      // when the cursor is well inside a parcel (the line layer alone
      // would only fire when the cursor lands exactly on a 1px line).
      // Standard MapLibre pattern: fill-opacity 0 still counts as
      // rendered for queryRenderedFeatures, just invisible.
      map.addLayer({
        id: 'citywide-parcels-fill',
        type: 'fill',
        source: 'citywide-parcels',
        'source-layer': 'parcels',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#000',
          'fill-opacity': 0,
        },
      });

      map.addLayer({
        id: 'citywide-parcels-line',
        type: 'line',
        source: 'citywide-parcels',
        'source-layer': 'parcels',
        layout: { visibility: 'none' },
        // Initial paint = the Streets preset (Streets is the boot basemap).
        // The basemap menu re-paints on every switch via
        // applyCitywideParcelsBasemapStyle: light grey on Streets, white on
        // the aerials. The parcel fabric is pure supporting context —
        // visible enough to trace lot boundaries when you are looking for
        // it, invisible enough that zoning + sale highlights paint cleanly
        // on top. Colours match the Manitoba sister app's muni-parcels-line
        // exactly; the zoom ramps are Winnipeg-only and load-bearing (a flat
        // line is a citywide blackout below z14) — see
        // lib/citywideParcelsStyle.js for the full rationale.
        //
        // Original Winnipeg styling (kept here for a one-diff revert):
        //   'line-color': '#1d4ed8',   // Tailwind blue-700
        //   'line-width': 1.0,
        //   'line-opacity': 0.7,
        paint: { ...CITYWIDE_PARCELS_LINE_STYLES.light },
      });

      // Citywide-parcels label. Address is the primary identifier and
      // appears at zoom 16+; roll # joins it on a second line at
      // zoom 17+. Single symbol layer (not two) so address + roll are
      // a single collision unit — otherwise the roll's offset position
      // lands on adjacent parcels' address labels and cull-by-default
      // drops every roll. With one layer the pair appears or culls
      // together, which is what the user actually sees.
      //
      // Reads from the 'parcels-labels' source-layer (one Point per
      // parcel) rather than 'parcels' (polygons) so that each parcel
      // gets exactly one label feature regardless of how many vector
      // tiles its polygon spans. Without this split, MapLibre places
      // one label per tile-clipped polygon at different representative
      // points, and visually-non-colliding duplicates accumulate.
      // The 'parcels-labels' layer is built by r/build_parcel_tiles.R
      // via sf::st_point_on_surface() and ingested by tippecanoe as a
      // second named layer in the same .pmtiles archive.
      map.addLayer({
        id: 'citywide-parcels-label',
        type: 'symbol',
        source: 'citywide-parcels',
        'source-layer': 'parcels-labels',
        minzoom: 16,
        layout: {
          visibility: 'none',
          'text-field': [
            'step',
            ['zoom'],
            ['format', ['get', 'full_address'], {}],
            17,
            ['format',
              ['get', 'full_address'], {},
              '\n',
              ['get', 'roll_number'], { 'font-scale': 0.85, 'text-color': '#555' },
            ],
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': 10,
          'symbol-placement': 'point',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-max-width': 8,
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 1.2,
        },
      });

      // Secondary overlay for the legal-flow context: when the user
      // searches by lot/block/plan, the primary highlight is the small
      // survey polygons, but the *containing* assessment parcels (the
      // building footprints) are useful to show too — otherwise a
      // 30m-wide lot inside a 130m-wide downtown building looks
      // disconnected from the building itself. Drawn as a faint orange
      // outline + light fill *under* the parcel-results layer so the
      // primary highlight stays on top.
      // promoteId lifts roll_number to the feature id at the SOURCE
      // level, which is what lets setFeatureState({source, id}) key into
      // a parcel by roll — required by the multi-parcel-sale group
      // highlight. Setting `id` on each GeoJSON Feature instead is not
      // reliably picked up after the source re-renders, so promoteId is
      // the canonical path. Roll is unique per drawn feature because
      // setParcels dedupes the map FC by geometry first.
      map.addSource('assess-context', {
        type: 'geojson',
        promoteId: 'roll_number',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Phase 6: explicit layout.visibility so getLayoutProperty
       // returns a real string. Visibility is data-driven (the source
       // starts empty), but having the property declared keeps the
       // basemap toggle's visibility queries on every layer
       // consistent.
      map.addLayer({
        id: 'assess-context-fill',
        type: 'fill',
        source: 'assess-context',
        layout: { visibility: 'visible' },
        // Yellow highlight (Mat. yellow-A400) lifted from the
        // Manitoba sister app so a selected assessment parcel
        // reads identically across both tools.
        //
        // The fill deliberately does NOT distinguish sale groups. A 30%
        // fill is the worst possible carrier for a subtle colour cue —
        // it dilutes toward whatever is beneath it, so the same hex
        // reads differently over cream basemap, dark tree cover and bare
        // soil, and the shift ends up looking like an artefact of the
        // imagery. The group cue lives entirely on the outline below,
        // which draws at 75% and stays true.
        paint: {
          'fill-color': '#ffea00',
          'fill-opacity': ASSESS_FILL_OPACITY,
        },
      });
      // Solid black under-stroke for the selection outline. Sits directly
      // beneath assess-context-line at exactly the same width, so the
      // dashed yellow on top alternates with black through its gaps —
      // the "caution-tape" border that stays legible on the pale Voyager
      // basemap, where a plain yellow outline washes out. Matching the
      // width exactly is what stops the black peeking out as a casing.
      map.addLayer({
        id: 'assess-context-line-underlay',
        type: 'line',
        source: 'assess-context',
        layout: {
          visibility: 'visible',
          'line-cap': 'butt',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#000000',
          'line-width': ASSESS_LINE_WIDTH,
          // Same 75% as the colour on top, so the black backing eases in
          // step rather than dominating.
          'line-opacity': 0.75,
        },
      });
      map.addLayer({
        id: 'assess-context-line',
        type: 'line',
        source: 'assess-context',
        // Dashed outline so the highlight reads as a "selection" rather
        // than competing with solid parcel-fabric lines. Equal dash/gap
        // ([3,3] in line-widths) so the black underlay shows through as
        // equal-length dashes.
        layout: {
          visibility: 'visible',
          'line-cap': 'butt',
          'line-join': 'round',
        },
        paint: {
          'line-color': [
            'case',
            // Multi-parcel sale (rows sharing an Instrument Number). The
            // ONLY thing that marks a group: the same hue as the single-
            // parcel yellow to within 0.1°, just ~17% less bright. Not a
            // second colour — the same colour, a shade down. Brightness
            // survives on a 2 px stroke where a small hue shift does not,
            // and the alternating black underlay gives the eye a fixed
            // reference to read the yellow against.
            ['>', ['to-number', ['coalesce', ['get', '_saleGroupSize'], 1]], 1],
            '#e6d300',
            '#ffea00',
          ],
          'line-width': ASSESS_LINE_WIDTH,
          'line-dasharray': [3, 3],
          'line-opacity': 0.75,
        },
      });

      // Subject parcel (sales tab) — separate source / layers so the
      // blue highlight stands out against the yellow sale-results
      // highlight. Drawn AFTER assess-context-line so the blue
      // outline reads on top even when the subject is itself one
      // of the loaded sales (an appraiser may legitimately set a
      // recent comp as the subject). Source stays empty until
      // runSalesAnalysis resolves a subject roll via
      // setSubjectData().
      map.addSource('subject', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'subject-fill',
        type: 'fill',
        source: 'subject',
        paint: {
          'fill-color': '#1e6fd9',
          'fill-opacity': 0.32,
        },
      });
      map.addLayer({
        id: 'subject-line',
        type: 'line',
        source: 'subject',
        paint: {
          'line-color': '#0c3a78',
          'line-width': 3.5,
        },
      });

      map.addSource('parcel-results', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'parcel-fill',
        type: 'fill',
        source: 'parcel-results',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#4682b4',
          'fill-opacity': 0.4,
        },
      });
      map.addLayer({
        id: 'parcel-line',
        type: 'line',
        source: 'parcel-results',
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#0b2566',
          'line-width': 2,
        },
      });

      // Traffic volumes. Midblock portable-count studies are joined to
      // road-network line geometry; permanent count stations render as
      // point markers. Hidden until main.js loads data and toggles the
      // group on. Drawn above parcels with a white casing so high-volume
      // streets remain readable on both streets and satellite basemaps.
      map.addSource('traffic-lines', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'traffic-lines-casing',
        type: 'line',
        source: 'traffic-lines',
        layout: {
          visibility: 'none',
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': 'rgba(255,255,255,0.92)',
          'line-width': TRAFFIC_LINE_CASING_WIDTH_EXPR,
          'line-opacity': 0.82,
        },
      });
      map.addLayer({
        id: 'traffic-lines',
        type: 'line',
        source: 'traffic-lines',
        layout: {
          visibility: 'none',
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': TRAFFIC_COLOR_EXPR,
          'line-width': TRAFFIC_LINE_WIDTH_EXPR,
          'line-opacity': 0.86,
        },
      });
      map.addLayer({
        id: 'traffic-lines-label',
        type: 'symbol',
        source: 'traffic-lines',
        minzoom: 12,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'volume_label'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'symbol-placement': 'line-center',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
      map.addSource('traffic-stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'traffic-stations-circle',
        type: 'circle',
        source: 'traffic-stations',
        layout: { visibility: 'none' },
        paint: {
          'circle-color': TRAFFIC_COLOR_EXPR,
          'circle-radius': TRAFFIC_POINT_RADIUS_EXPR,
          'circle-opacity': 0.88,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'traffic-stations-label',
        type: 'symbol',
        source: 'traffic-stations',
        minzoom: 12,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'volume_label'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-offset': [0, 1.4],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });

      // Parcel-edge dimension labels. Source carries one LineString per
      // polygon edge with `length_label` already pre-formatted. The
      // symbol layer uses `symbol-placement: 'line'` so each label
      // auto-rotates along the edge it describes (looks like a survey
      // plat). minzoom 17 keeps the labels suppressed at city-wide
      // views where they'd just clutter the map.
      map.addSource('dimensions', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'dimensions-label',
        type: 'symbol',
        source: 'dimensions',
        minzoom: 17,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'length_label'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 20,
          // line-center: exactly one label at each LineString's midpoint,
          // auto-rotated along the edge. text-allow-overlap forces the
          // label to render even when the edge is shorter than the
          // label width (typical for 40-50 ft residential lot fronts at
          // zoom 18). text-ignore-placement keeps these labels from
          // being suppressed by other symbol layers (civic addresses).
          'symbol-placement': 'line-center',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          // Tailwind blue-700, matching the citywide-parcels line layer
          // so dimensions read as part of the same "survey" visual
          // family. Halo bumped from 1.6 -> 2.8 to keep the white
          // outline proportional to the 2x text.
          'text-color': '#1d4ed8',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2.8,
        },
      });

      // Civic-address labels — every official address point inside a
      // result parcel, rendered as the full street address
      // ("1129 FIFE STREET") at the address's coordinates. Layered on
      // top of every other map layer so labels read clearly. minzoom
      // keeps them out of the city-wide view where they'd be noise;
      // at zoom ≥ 16 they're typically meaningful. Falls back to the
      // bare street number if full_address is missing for some reason.
      map.addSource('civic-addresses', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'civic-addresses-label',
        type: 'symbol',
        source: 'civic-addresses',
        minzoom: 16,
        layout: {
          // Phase 6: explicit visibility so getLayoutProperty returns
          // a real string. Source-driven empty/populated is what
          // actually toggles the labels on screen.
          'visibility': 'visible',
          'text-field': ['coalesce', ['get', 'full_address'], ['get', 'street_num'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-anchor': 'center',
          'text-max-width': 8,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });

      // Dwelling units. Ordinary residential parcels reuse the existing
      // one-point-per-geometry parcels-labels tileset; condominium units use
      // a separate one-point-per-normalized-address source-layer generated by
      // build_parcel_tiles.R. Multi-unit locations appear earlier (z13+) and
      // receive collision priority; ordinary "1" labels wait until parcel
      // scale so the citywide view stays readable.
      const ordinaryFilter = ['==', ['get', 'dwelling_is_condo'], 0];
      const multiFilter = ['all', ordinaryFilter, ['>', DWELLING_COUNT_EXPR, 1]];
      map.addLayer({
        id: 'dwelling-units-multi-circle', type: 'circle', source: 'citywide-parcels',
        'source-layer': 'parcels-labels', minzoom: 13,
        filter: multiFilter,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': DWELLING_MULTI_RADIUS_EXPR,
          'circle-color': DWELLING_COLOR_EXPR,
          'circle-opacity': 0.86,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'dwelling-units-multi-label', type: 'symbol', source: 'citywide-parcels',
        'source-layer': 'parcels-labels', minzoom: 13,
        filter: multiFilter,
        layout: {
          visibility: 'none',
          'text-field': ['to-string', ['get', 'dwelling_unit_count']],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'symbol-sort-key': ['-', 0, DWELLING_COUNT_EXPR],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.25)', 'text-halo-width': 0.5 },
      });
      map.addLayer({
        id: 'dwelling-units-single-label', type: 'symbol', source: 'citywide-parcels',
        'source-layer': 'parcels-labels', minzoom: 16,
        filter: ['all', ordinaryFilter, ['==', DWELLING_COUNT_EXPR, 1]],
        layout: {
          visibility: 'none',
          'text-field': '1',
          'text-font': ['Open Sans Semibold'],
          'text-size': 10,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: { 'text-color': '#1d4ed8', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });
      map.addLayer({
        id: 'dwelling-condo-circle', type: 'circle', source: 'citywide-parcels',
        'source-layer': 'dwelling-condo-labels', minzoom: 13,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': DWELLING_MULTI_RADIUS_EXPR,
          'circle-color': DWELLING_COLOR_EXPR,
          'circle-opacity': 0.9,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'dwelling-condo-label', type: 'symbol', source: 'citywide-parcels',
        'source-layer': 'dwelling-condo-labels', minzoom: 13,
        layout: {
          visibility: 'none',
          'text-field': ['to-string', ['get', 'dwelling_unit_count']],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'symbol-sort-key': ['-', 0, DWELLING_COUNT_EXPR],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.25)', 'text-halo-width': 0.5 },
      });

      // Manitoba Contaminated Sites Registry overlay. Filtered to
      // Winnipeg sites only client-side. Circles colour-coded by
      // CSGroup status — red for Designated Contaminated, orange
      // for Designated Impacted, grey for anything else. Lazy-
      // loaded on first toggle (see fetchContaminatedSites in soda.js
      // and toggleContam in main.js).
      map.addSource('contam', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'contam-circle',
        type: 'circle',
        source: 'contam',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'match',
            ['get', 'CSGroup'],
            'Designated Contaminated Site', '#c0392b',
            'Designated Impacted Site',     '#e67e22',
            /* default */                    '#7f8c8d',
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
      });

      // Combined hover popup. Wherever the cursor is on the map, query
      // both the primary (parcel-fill) and the assessment-context layers
      // and build a single popup that shows whichever one(s) are under
      // the cursor. This way, when a small survey lot sits inside a
      // larger assessment parcel (legal flow), hovering anywhere on the
      // overlap area shows both blocks of info side-by-side — no more
      // guessing which colour is which.
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      // ---- Multi-parcel-sale group highlight -------------------------
      // Hovering any parcel of a sale lights up every parcel in the same
      // transaction (outline 2→3 px, fill 0.3→0.5) so an assembly reads
      // as one deal rather than several neighbouring lots. Driven by
      // `_saleGroupRollIds`, the JSON list of sibling rolls stamped in
      // lib/sales.js; a property search has no such stamp and no-ops.
      let activeGroupRolls = [];
      const clearGroupHover = () => {
        for (const id of activeGroupRolls) {
          map.setFeatureState({ source: 'assess-context', id }, { groupHover: false });
        }
        activeGroupRolls = [];
      };
      const setGroupHover = (rolls) => {
        if (!Array.isArray(rolls) || rolls.length === 0) { clearGroupHover(); return; }
        // No-op when the same group is already lit, so a mousemove across
        // one parcel doesn't churn feature-state on every pixel.
        if (activeGroupRolls.length === rolls.length
            && activeGroupRolls.every((v, i) => v === rolls[i])) return;
        clearGroupHover();
        for (const id of rolls) {
          if (id == null || id === '') continue;
          map.setFeatureState({ source: 'assess-context', id }, { groupHover: true });
          activeGroupRolls.push(id);
        }
      };
      // Leaving the canvas entirely fires no mousemove, so the last
      // hovered group would stay lit until the cursor came back.
      map.getCanvas().addEventListener('mouseout', clearGroupHover);
      // Exposed so the data setters can drop stale state when the result
      // set changes — a roll that reappears in a later search would
      // otherwise come back still lit from the previous one.
      map._clearGroupHover = clearGroupHover;
      /** Parse `_saleGroupRollIds` back to an array. MapLibre hands
       *  properties back as strings, and the value may already be an
       *  array when read straight off the source, so accept both. */
      const readSaleGroupRolls = (props) => {
        const raw = props?._saleGroupRollIds;
        if (raw == null) return null;
        if (Array.isArray(raw)) return raw.map(String);
        try {
          const parsed = JSON.parse(String(raw));
          return Array.isArray(parsed) ? parsed.map(String) : null;
        } catch { return null; }
      };

      map.on('mousemove', (e) => {
        if (!map.isStyleLoaded()) return;
        // Stand down while an area-selection tool is armed: the hover
        // popup would sit on top of the exact point being aimed at.
        if (isShapeDrawing()) {
          popup.remove();
          clearGroupHover();
          return;
        }
        const dwellingHits = DWELLING_LAYER_IDS
          .filter((id) => map.getLayer(id))
          .flatMap((id) => map.queryRenderedFeatures(e.point, { layers: [id] }));
        if (dwellingHits.length) {
          map.getCanvas().style.cursor = 'pointer';
          popup.setLngLat(e.lngLat).setHTML(dwellingUnitHtml(dwellingHits[0].properties)).addTo(map);
          return;
        }
        const primaryHits = map.getLayer('parcel-fill')
          ? map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] })
          : [];
        const contextHits = map.getLayer('assess-context-fill')
          ? map.queryRenderedFeatures(e.point, { layers: ['assess-context-fill'] })
          : [];
        // Light the hovered parcel's whole sale group. Runs before the
        // early returns below so moving off a parcel onto an overlay
        // still clears it.
        setGroupHover(readSaleGroupRolls(contextHits[0]?.properties) || []);
        // Citywide-parcels-fill is consulted only when no search-result
        // layer matches. queryRenderedFeatures honours layer visibility,
        // so this is a no-op when Show All Parcels is off. Search results
        // win over citywide because the live SoDA data on results is
        // richer (e.g. address-enrichment + partial-lot flags).
        let citywideHits = [];
        if (!primaryHits.length && !contextHits.length && map.getLayer('citywide-parcels-fill')) {
          citywideHits = map.queryRenderedFeatures(e.point, { layers: ['citywide-parcels-fill'] });
        }
        if (!primaryHits.length && !contextHits.length && !citywideHits.length) {
          popup.remove();
          map.getCanvas().style.cursor = '';
          return;
        }
        map.getCanvas().style.cursor = 'pointer';
        const primaryProps = primaryHits[0]?.properties
          ?? (contextHits.length ? null : citywideHits[0]?.properties);
        const contextProps = contextHits[0]?.properties;
        popup
          .setLngLat(e.lngLat)
          .setHTML(combinedPopupHtml(primaryProps, contextProps))
          .addTo(map);
      });
      map.on('mouseout', () => {
        popup.remove();
        map.getCanvas().style.cursor = '';
      });

      // Click a parcel → let main.js scroll the results table to the
      // matching row. Both layers participate so a click on either the
      // blue lot or the red building outline lands on the row.
      if (onFeatureClick) {
        const handle = (e) => {
          // A click that placed shape geometry, or flipped a drawn
          // shape's Include/Exclude, is not a parcel click.
          if (shapeClickHandled(map, e)) return;
          const key = e.features?.[0]?.properties?._rowKey;
          if (key != null) onFeatureClick(key);
        };
        map.on('click', 'parcel-fill', handle);
        map.on('click', 'assess-context-fill', handle);
      }

      // Click a citywide-parcels polygon → sticky popup with the
      // roll #, address, an Assessment-page link, and a GPS Coordinates
      // copy-to-clipboard action. Search-result clicks (parcel-fill
      // / assess-context-fill) take precedence — the citywide popup
      // is only for parcels NOT in the active search, since for
      // active-result parcels the row click + parcel-summary card
      // already handle the interaction.
      const citywideClickPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'citywide-parcels-fill', (e) => {
        if (shapeClickHandled(map, e)) return;
        if (map.getLayoutProperty('citywide-parcels-fill', 'visibility') !== 'visible') return;
        // Search-result layer takes precedence.
        const overSearchResult =
             (map.getLayer('parcel-fill')          && map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] }).length > 0)
           || (map.getLayer('assess-context-fill')  && map.queryRenderedFeatures(e.point, { layers: ['assess-context-fill'] }).length > 0);
        const overDwelling = DWELLING_LAYER_IDS.some((id) =>
          map.getLayer(id) && map.queryRenderedFeatures(e.point, { layers: [id] }).length > 0
        );
        if (overSearchResult || overDwelling) return;
        const f = e.features?.[0];
        if (!f) return;
        citywideClickPopup
          .setLngLat(e.lngLat)
          .setHTML(citywideParcelHtml(f.properties))
          .addTo(map);
        // Compute the popup's coordinate-copy target from the actual
        // polygon (bbox midpoint is a stable approximation of centroid
        // that doesn't need turf). Falls back to the click point on
        // the rare case the rendered geometry is empty.
        const rendered = map.queryRenderedFeatures(e.point, { layers: ['citywide-parcels-fill'] })[0];
        const center = polygonBboxMidpoint(rendered?.geometry)
          ?? [e.lngLat.lng, e.lngLat.lat];
        wireCoordsCopy(citywideClickPopup, center);
      });

      const dwellingClickPopup = new maplibregl.Popup({ closeButton: true });
      const handleDwellingClick = (e) => {
        if (shapeClickHandled(map, e)) return;
        const feature = e.features?.[0];
        if (!feature) return;
        dwellingClickPopup
          .setLngLat(e.lngLat)
          .setHTML(dwellingUnitHtml(feature.properties, true))
          .addTo(map);
      };
      map.on('click', 'dwelling-units-multi-circle', handleDwellingClick);
      map.on('click', 'dwelling-units-single-label', handleDwellingClick);
      map.on('click', 'dwelling-condo-circle', handleDwellingClick);

      // Click a contaminated-site circle → standalone popup with the
      // site name, address, status pill, and a link out to the
      // Manitoba registry page for that site.
      const contamPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'contam-circle', (e) => {
        if (shapeClickHandled(map, e)) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        contamPopup
          .setLngLat(e.lngLat)
          .setHTML(contamPopupHtml(p))
          .addTo(map);
      });
      map.on('mouseenter', 'contam-circle', () => {
        if (map.getLayoutProperty('contam-circle', 'visibility') === 'visible') {
          map.getCanvas().style.cursor = 'pointer';
        }
      });
      map.on('mouseleave', 'contam-circle', () => {
        map.getCanvas().style.cursor = '';
      });

// Click a zoning polygon → show a popup with the zone code and
      // description. Skipped when the zoning layer is hidden (clicks pass
      // through to whatever's underneath, including parcel-fill above it).
      const zoningPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'zoning-fill', (e) => {
        if (shapeClickHandled(map, e)) return;
        // Don't intercept the click if a parcel was also under it — let the
        // parcel handler win since that's the user's primary interest.
        const parcelHit = map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] });
        if (parcelHit.length > 0) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        zoningPopup
          .setLngLat(e.lngLat)
          .setHTML(zoningPopupHtml(p))
          .addTo(map);
      });
      map.on('mouseenter', 'zoning-fill', () => {
        if (map.getLayoutProperty('zoning-fill', 'visibility') === 'visible') {
          map.getCanvas().style.cursor = 'help';
        }
      });
      map.on('mouseleave', 'zoning-fill', () => {
        map.getCanvas().style.cursor = '';
      });

      // Click popups for the OurWinnipeg overlays. Each defers to the
      // parcel-fill click first so a click that lands on both a parcel
      // and an overlay still scrolls the table to the parcel's row.
      const policyPopup = new maplibregl.Popup({ closeButton: true });
      const policyClick = (htmlBuilder) => (e) => {
        if (shapeClickHandled(map, e)) return;
        const parcelHit = map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] });
        if (parcelHit.length > 0) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        policyPopup.setLngLat(e.lngLat).setHTML(htmlBuilder(p)).addTo(map);
      };
      map.on('click', 'secondary-plans-fill', policyClick((p) => {
        const kind = p.plan_kind ?? 'Secondary Plan';
        const name = p.precinct_name ?? p.feature_name ?? '';
        // Open Data only publishes 16 of the City's ~42 adopted secondary
        // plans (5 Precincts + 11 Major Redev Sites). The remaining
        // neighbourhood-area plans (Corydon-Osborne, CentrePlan 2050,
        // Osborne Village, etc.) aren't on Open Data as boundary data.
        // The popup links to the City's Long Range Planning index so
        // the user has a path to look up plans we can't render here.
        return `
          <div style="line-height:1.4;max-width:280px">
            <strong>Secondary Plan</strong> — ${escapeHtml(kind)}
            ${name ? `<br>${escapeHtml(name)}` : ''}
            <hr style="margin:6px 0;border:none;border-top:1px solid #ddd">
            <small>Open Data only publishes 16 of the City's ~42 adopted
            plans. <a href="https://winnipeg.ca/node/44825" target="_blank" rel="noreferrer">See full list →</a></small>
          </div>`;
      }));
      map.on('click', 'infill-guideline-fill', policyClick(() => `
        <div style="line-height:1.4">
          <strong>Mature Community</strong><br>
          <em>Infill Guidelines apply</em>
        </div>`));
      map.on('click', 'malls-corridors-fill', policyClick((p) => `
        <div style="line-height:1.4">
          <strong>${escapeHtml(p.pdo_kind ?? 'Malls and Corridors PDO')}</strong>
          ${p.feature_name ? `<br>${escapeHtml(p.feature_name)}` : ''}
        </div>`));

      const transitPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'transit-stops-circle', (e) => {
        if (shapeClickHandled(map, e)) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const code = p.stop_code ? escapeHtml(p.stop_code) : '';
        const name = p.stop_name ? escapeHtml(p.stop_name) : 'Bus stop';
        const routes = p.routes ? escapeHtml(p.routes) : '';
        const liveUrl = code
          ? `https://winnipegtransit.com/en/stop/${encodeURIComponent(p.stop_code)}/schedule/`
          : null;
        const html = `
          <div style="line-height:1.4;max-width:280px">
            <strong>${name}</strong>
            ${code ? `<br><small>Stop #${code}</small>` : ''}
            ${routes ? `<br><strong>Routes</strong> ${routes}` : ''}
            ${liveUrl ? `<br><a href="${liveUrl}" target="_blank" rel="noreferrer">Live arrivals ↗</a>` : ''}
          </div>`;
        transitPopup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on('click', 'transit-routes-line', (e) => {
        if (shapeClickHandled(map, e)) return;
        const parcelHit = map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] });
        if (parcelHit.length > 0) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const short = p.route_short_name ? escapeHtml(p.route_short_name) : '';
        const long = p.route_long_name ? escapeHtml(p.route_long_name) : '';
        const routeColor = safeCssColor(p.route_color);
        const swatch = routeColor
          ? `<span style="display:inline-block;width:14px;height:14px;background:${routeColor};border:1px solid #1f2937;border-radius:2px;vertical-align:middle;margin-right:6px"></span>`
          : '';
        transitPopup.setLngLat(e.lngLat).setHTML(`
          <div style="line-height:1.4;max-width:280px">
            ${swatch}<strong>${short ? `Route ${short}` : 'Transit route'}</strong>
            ${long ? `<br>${long}` : ''}
          </div>`).addTo(map);
      });
      for (const layerId of ['transit-stops-circle', 'transit-routes-line']) {
        map.on('mouseenter', layerId, () => {
          if (map.getLayoutProperty(layerId, 'visibility') === 'visible') {
            map.getCanvas().style.cursor = 'pointer';
          }
        });
        map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
      }

      const hoodPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'neighbourhood-clusters-fill', policyClick((p) => {
        const list = p.neighbourhoods
          ? String(p.neighbourhoods).split(';').map((s) => escapeHtml(s.trim())).join(', ')
          : '';
        return `
          <div style="line-height:1.4;max-width:300px">
            <strong>Cluster:</strong> ${escapeHtml(p.cluster || '')}
            ${p.neighbourhood_count ? `<br><small>${escapeHtml(String(p.neighbourhood_count))} neighbourhoods</small>` : ''}
            ${list ? `<br><small style="color:#475569">${list}</small>` : ''}
          </div>`;
      }));
      map.on('click', 'neighbourhoods-fill', policyClick((p) => `
        <div style="line-height:1.4;max-width:280px">
          <strong>Neighbourhood:</strong> ${escapeHtml(p.name || '')}
          ${p.cluster ? `<br><small>Cluster: ${escapeHtml(p.cluster)}</small>` : ''}
        </div>`));
      void hoodPopup;

      const hoodHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 8,
        className: 'hood-hover-popup',
      });
      const hoodHoverHandler = (labelKey) => (e) => {
        if (isShapeDrawing()) {
          hoodHoverPopup.remove();
          return;
        }
        const layerId = e.features?.[0]?.layer?.id;
        if (!layerId || map.getLayoutProperty(layerId, 'visibility') !== 'visible') {
          hoodHoverPopup.remove();
          return;
        }
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const label = p[labelKey];
        if (!label) return;
        hoodHoverPopup
          .setLngLat(e.lngLat)
          .setHTML(`<span class="hood-hover-label">${escapeHtml(String(label))}</span>`)
          .addTo(map);
      };
      map.on('mousemove', 'neighbourhood-clusters-fill', hoodHoverHandler('cluster'));
      map.on('mousemove', 'neighbourhoods-fill', hoodHoverHandler('name'));
      for (const layerId of ['neighbourhood-clusters-fill', 'neighbourhoods-fill']) {
        map.on('mouseenter', layerId, () => {
          if (map.getLayoutProperty(layerId, 'visibility') === 'visible') {
            map.getCanvas().style.cursor = 'help';
          }
        });
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
          hoodHoverPopup.remove();
        });
      }

      const trafficPopup = new maplibregl.Popup({ closeButton: true });
      const trafficClick = (e) => {
        if (shapeClickHandled(map, e)) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        trafficPopup.setLngLat(e.lngLat).setHTML(trafficPopupHtml(p)).addTo(map);
      };
      map.on('click', 'traffic-lines', trafficClick);
      map.on('click', 'traffic-stations-circle', trafficClick);
      for (const layerId of ['traffic-lines', 'traffic-stations-circle']) {
        map.on('mouseenter', layerId, () => {
          if (map.getLayoutProperty(layerId, 'visibility') === 'visible') {
            map.getCanvas().style.cursor = 'help';
          }
        });
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
        });
      }

      // ---------- Historical (as-of-date) overlay ----------
      // Two layers drawn over today's parcels from the wpg-parcel-history CDN
      // (pushed via setHistoricalData): assessment parcels (dashed amber, tinted
      // by size-change band) and survey lots (dashed violet). Added here, after
      // the live layers, so they render on top.
      try {
      // Historical zoning (whole-city, as-of the selected snapshot). Added FIRST
      // so it sits UNDER the dashed historical parcel/survey lines. Same
      // map_colour palette + styling as the live Zoning overlay.
      map.addSource('historical-zoning', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'historical-zoning-fill', type: 'fill', source: 'historical-zoning',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['match', ['get', 'map_colour'], ...ZONING_PALETTE, '#cccccc'],
          'fill-opacity': 0.45,
          'fill-outline-color': '#444',
        },
      });
      map.addLayer({
        id: 'historical-zoning-line', type: 'line', source: 'historical-zoning',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#333', 'line-width': 0.6, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'historical-zoning-label', type: 'symbol', source: 'historical-zoning',
        layout: {
          visibility: 'none',
          'text-field': ['case', ['<=', ['length', ['coalesce', ['get', 'zoning'], '']], 5], ['get', 'zoning'], ''],
          'text-font': ['Open Sans Semibold'], 'text-size': 22,
          'text-allow-overlap': false, 'text-ignore-placement': false, 'symbol-placement': 'point',
        },
        paint: { 'text-color': '#1a1a1a', 'text-halo-color': '#ffffff', 'text-halo-width': 2.8 },
      });

      map.addSource('historical-parcels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('historical-survey',  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      // Assessment parcels — fill + dashed line coloured by `_sizeBand` (stamped
      // in main.js by matching each historical roll to today's parcel of the
      // same roll): major (|Δ|>25%) red, minor (>5%) orange, gone grey, else amber.
      map.addLayer({
        id: 'historical-parcels-fill', type: 'fill', source: 'historical-parcels',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': HIST_SIZE_COLOR,
          'fill-opacity': ['match', ['get', '_sizeBand'], 'major', 0.16, 'minor', 0.11, 0.06],
        },
      });
      map.addLayer({
        id: 'historical-parcels-line', type: 'line', source: 'historical-parcels',
        layout: { visibility: 'none' },
        paint: {
          'line-color': HIST_SIZE_COLOR,
          'line-width': ['match', ['get', '_sizeBand'], 'major', 2.6, 'minor', 2.2, 1.8],
          'line-opacity': 0.95,
          'line-dasharray': [3, 2],
        },
      });
      // Survey lots — dashed violet (distinct from amber assessment + live blue).
      map.addLayer({
        id: 'historical-survey-fill', type: 'fill', source: 'historical-survey',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#7c3aed', 'fill-opacity': 0.05 },
      });
      map.addLayer({
        id: 'historical-survey-line', type: 'line', source: 'historical-survey',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#7c3aed', 'line-width': 1.6, 'line-opacity': 0.9, 'line-dasharray': [2, 2] },
      });

      // Click priority: an assessment-parcel click must take precedence over the
      // survey lot beneath it. Each layer defers to higher-priority historical
      // layers rendered under the same point.
      const histClickPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '340px' });
      const wireHist = (layerId, htmlFn, deferTo = []) => {
        map.on('click', layerId, (e) => {
          if (shapeClickHandled(map, e)) return;
          if (map.getLayoutProperty(layerId, 'visibility') !== 'visible') return;
          for (const other of deferTo) {
            if (map.getLayer(other)
                && map.getLayoutProperty(other, 'visibility') === 'visible'
                && map.queryRenderedFeatures(e.point, { layers: [other] }).length > 0) return;
          }
          const p = e.features?.[0]?.properties;
          if (!p) return;
          histClickPopup.setLngLat(e.lngLat).setHTML(htmlFn(p, historicalSnap ?? '')).addTo(map);
        });
        map.on('mouseenter', layerId, () => {
          if (map.getLayoutProperty(layerId, 'visibility') === 'visible') map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
      };
      wireHist('historical-parcels-fill', historicalParcelHtml);
      wireHist('historical-survey-fill',  historicalSurveyHtml, ['historical-parcels-fill']);
      // Zoning fill sits beneath both lot layers — defer so a parcel/survey click wins.
      wireHist('historical-zoning-fill', historicalZoningHtml, ['historical-parcels-fill', 'historical-survey-fill']);
      } catch (e) {
        // The historical overlay is additive — never let a problem setting it
        // up prevent the base map from finishing load.
        console.warn('historical overlay layer setup failed:', e);
      }

      // Hybrid satellite: move the two Esri reference rasters
      // (transportation + place names) to the TOP of the layer
      // stack so they paint above any parcel / zoning / policy
      // overlays. Otherwise a zoning fill or sale highlight on
      // top of the satellite imagery would obscure street labels.
      // Order of moveLayer calls is important — the LAST call
      // wins, so transportation moves first and reference moves
      // last, putting place names on top.
      if (map.getLayer('esri-transportation')) map.moveLayer('esri-transportation');
      if (map.getLayer('esri-reference'))      map.moveLayer('esri-reference');

      const NEIGHBOURHOOD_TOP_LAYERS = [
        'neighbourhood-clusters-line-casing',
        'neighbourhood-clusters-line',
        'neighbourhood-clusters-label',
        'neighbourhoods-line-casing',
        'neighbourhoods-line',
        'neighbourhoods-label',
      ];
      for (const id of NEIGHBOURHOOD_TOP_LAYERS) {
        if (map.getLayer(id)) map.moveLayer(id);
      }

      // Water influence — result parcels repainted on the blue ramp
      // from lib/water.js (dark = frontage, pale = near water without
      // it). Drawn over the parcel layers, off by default.
      map.addLayer({
        id: 'water-influence-fill',
        type: 'fill',
        source: 'assess-context',
        layout: { visibility: 'none' },
        filter: ['has', '_waterColor'],
        paint: {
          'fill-color': ['get', '_waterColor'],
          'fill-opacity': 0.75,
        },
      });
      map.addLayer({
        id: 'water-influence-line',
        type: 'line',
        source: 'assess-context',
        layout: { visibility: 'none' },
        filter: ['has', '_waterColor'],
        paint: {
          'line-color': ['get', '_waterColor'],
          'line-width': 1.2,
        },
      });

      // ---- Parcel numbering ------------------------------------------
      // When the "Number parcels" toggle is on and the result set has
      // more than one subject, main.js stamps a stable 1..N `_seq` on
      // each parcel (lib/parcelNumbering.js) and pushes them here. Each
      // numbered parcel gets a red disc with its number, centred on the
      // parcel's bbox midpoint, at a constant screen size no matter the
      // zoom — a number drawn INSIDE the polygon would shrink below
      // readable size on a typical city lot.
      //
      // This is the reduced first cut of the Manitoba callout system:
      // badges sit ON the parcel rather than offset with leader lines
      // and de-confliction (mb-parcelsearch lib/calloutPlacement.js).
      // Where result parcels crowd together, badges will overlap; the
      // leader-line port is the fix if that turns out to matter.
      //
      // GL layers rather than HTML markers, deliberately: they belong to
      // the WebGL canvas, so anything that reads map.getCanvas() for an
      // image export captures them. DOM markers would not be captured.
      map.addSource('parcel-num-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'parcel-num-badge',
        type: 'circle',
        source: 'parcel-num-labels',
        layout: { visibility: 'none' },
        paint: {
          // Grows a step at a time so 2- and 3-digit numbers still fit
          // inside the disc instead of spilling over the white ring.
          'circle-radius': ['step', ['length', ['to-string', ['get', '_seq']]], 11, 2, 12.65, 3, 14.85],
          'circle-color': PARCEL_NUM_COLOR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.2,
        },
      });
      map.addLayer({
        id: 'parcel-num-text',
        type: 'symbol',
        source: 'parcel-num-labels',
        layout: {
          visibility: 'none',
          'text-field': ['get', '_seqStr'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 14.3,
          // A number must ALWAYS draw. MapLibre's default collision
          // handling would silently cull a badge's digits where two
          // parcels sit close together, leaving a numberless red disc —
          // worse than an overlap, because it reads as a different mark.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': PARCEL_NUM_COLOR,
          'text-halo-width': 0.6,
        },
      });

      // Area-selection shapes go in LAST — after every overlay and
      // after the moveLayer reordering above — so a shape the user
      // just drew can never hide beneath a parcel or basemap-reference
      // layer.
      addShapeLayers(map);
    }
  });

  return { map, ready };
}

/**
 * Replace the map's highlighted parcels with the given FeatureCollection
 * and fit the viewport to them. If the FC is empty, reset to Winnipeg.
 * Accepts either Survey Parcels or Assessment Parcels features — the
 * single `parcel-results` source handles both.
 */
/**
 * Push both layers' data onto the map and fit to the union. Either FC can
 * be empty (e.g. a survey-by-plan search where nothing assessment-side
 * matched), in which case only the populated layer drives the bbox.
 */
export function showResults(
  map,
  surveyFc,
  assessFc = { type: 'FeatureCollection', features: [] },
  { fit = true } = {},
) {
  map.getSource('parcel-results').setData(surveyFc);
  clearAssessGroupState(map);
  map.getSource('assess-context').setData(assessFc);
  // `fit: false` is for re-renders driven by a drawn-shape area filter:
  // the shape was placed in the current viewport, so the narrowed set is
  // already on screen and re-framing (or, at zero results, snapping back
  // to the whole city) would only throw away the user's anchor.
  if (!fit) return;
  const allFeatures = [...surveyFc.features, ...assessFc.features];
  if (allFeatures.length === 0) {
    map.flyTo({ center: WINNIPEG_CENTER, zoom: 11 });
    return;
  }
  const combined = { type: 'FeatureCollection', features: allFeatures };
  const [minLon, minLat, maxLon, maxLat] = bbox(combined);
  map.fitBounds(
    [[minLon, minLat], [maxLon, maxLat]],
    { padding: 60, maxZoom: 18, duration: 800 }
  );
}

/**
 * Zoom + center the map on a single feature's bounds. Used when the user
 * clicks a row in the results table — the map flies to that parcel so
 * they can see exactly which highlight corresponds to the row.
 */
export function flyToFeature(map, feature) {
  if (!feature?.geometry) return;
  try {
    const [minLon, minLat, maxLon, maxLat] = bbox(feature);
    map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { padding: 80, maxZoom: 19, duration: 700 }
    );
  } catch (err) {
    console.warn('flyToFeature: bbox failed', err);
  }
}

/**
 * Push assessment-parcel polygons onto the secondary outline layer.
 * Used by the legal flow to show the building footprints that contain
 * the user's lot matches. Pass an empty FC to clear it.
 */
export function setAssessContext(map, fc) {
  const src = map.getSource('assess-context');
  if (!src) return;
  clearAssessGroupState(map);
  src.setData(fc);
}

/** Drop every feature-state on assess-context. Called before new data
 *  lands so a roll that appears in both the old and new result sets
 *  can't arrive still lit from the previous hover. */
function clearAssessGroupState(map) {
  if (typeof map._clearGroupHover === 'function') map._clearGroupHover();
  try { map.removeFeatureState({ source: 'assess-context' }); } catch { /* source not ready */ }
}

/**
 * Push the sales-tab subject parcel onto its dedicated map layer.
 * Pass an empty / null FC to clear the highlight. Drawn above the
 * yellow assess-context layer so the blue subject stays visible
 * even when the subject roll is itself one of the loaded sales.
 */
export function setSubjectData(map, fc) {
  const src = map.getSource('subject');
  if (src) src.setData(fc || { type: 'FeatureCollection', features: [] });
}

/**
 * Push the numbered-parcel badges onto the map. `features` are the result
 * parcels; those carrying a `_seq` (stamped by main.js via
 * lib/parcelNumbering.js) get a badge at their bounding-box midpoint.
 * Pass an empty / `_seq`-less set to clear.
 *
 * Badges are deduped by rounded position, lowest number winning. Two
 * things make that necessary rather than tidy: a condo building carries
 * one roll per unit over ONE footprint (635 Ballantrae has 52), and
 * setParcels already dedupes the drawn polygons by geometry hash. Without
 * this, 52 discs would stack on one polygon into an unreadable smear.
 * `_seq` grouping in parcelNumbering.js handles the repeat-sale and
 * multi-parcel-sale cases upstream; this catches same-footprint parcels,
 * which are a different relation entirely.
 */
export function setParcelNumberData(map, features) {
  const src = map.getSource('parcel-num-labels');
  if (!src) return;
  const byPosition = new Map();
  for (const f of features || []) {
    const seq = f?.properties?._seq;
    if (seq == null) continue;
    const c = polygonBboxMidpoint(f.geometry);
    if (!c) continue;
    // ~0.1 m at this latitude — fine enough that two genuinely distinct
    // parcels never collapse, coarse enough to catch float drift between
    // copies of one footprint.
    const key = `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
    const existing = byPosition.get(key);
    if (existing && existing.seq <= seq) continue;
    byPosition.set(key, { seq, coords: c });
  }
  const out = [...byPosition.values()]
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq, coords }) => ({
      type: 'Feature',
      properties: { _seq: seq, _seqStr: String(seq) },
      geometry: { type: 'Point', coordinates: coords },
    }));
  src.setData({ type: 'FeatureCollection', features: out });
}

/** Show or hide the numbered badges (disc + digits together). */
export function setParcelNumbersVisible(map, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of ['parcel-num-badge', 'parcel-num-text']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
}

/**
 * Replace the zoning layer's source data. Pass an empty FC to clear it.
 * Visibility is controlled separately by setZoningMode() so callers can
 * preload data while the layer is still hidden.
 */
export function setZoningData(map, fc) {
  const src = map.getSource('zoning');
  if (src) src.setData(fc);
}

/**
 * Set the zoning display mode without touching the data (cheap layout-only
 * flips). Three modes:
 *   'off'     — everything hidden.
 *   'shading' — coloured fill + district outlines + zone-code labels.
 *   'labels'  — outlines + zone-code labels only, NO colour fill, so the zones
 *               read without the fill obscuring the basemap / parcels beneath.
 */
export function setZoningMode(map, mode) {
  const fill = mode === 'shading' ? 'visible' : 'none';
  const lineLabel = mode === 'off' ? 'none' : 'visible';
  if (map.getLayer('zoning-fill')) map.setLayoutProperty('zoning-fill', 'visibility', fill);
  if (map.getLayer('zoning-line')) map.setLayoutProperty('zoning-line', 'visibility', lineLabel);
  if (map.getLayer('zoning-label')) map.setLayoutProperty('zoning-label', 'visibility', lineLabel);
}

/** Toggle the citywide-parcels vector overlay on/off. The PMTiles
 *  archive only fetches the tiles for the current viewport, so cost
 *  is bounded; turning the layer on instantly draws what's on screen.
 *  Promise-returning `probeCitywideParcels()` below lets the caller
 *  check whether the archive exists before flipping the toggle. */
/**
 * Show / hide the water-influence overlay.
 *
 * Painted from the `assess-context` source, not `parcel-results`: the
 * water verdict lives on the ASSESSMENT record, and in the
 * legal-description flow parcel-results holds survey lots that carry
 * none of it.
 *
 * While the overlay is on, `assess-context-fill` drops to opacity 0 —
 * NOT visibility 'none'. That fill is the hit-test layer for the hover
 * popup and the click-to-scroll-the-table handler; hiding it kills
 * both. Opacity 0 keeps the events alive while the water colours paint
 * unpolluted (the yellow highlight underneath tinted every ramp
 * colour).
 */
export function setWaterInfluenceVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['water-influence-fill', 'water-influence-line']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
  if (map.getLayer('assess-context-fill')) {
    map.setPaintProperty('assess-context-fill', 'fill-opacity', visible ? 0 : 0.3);
  }
}

export function setCitywideParcelsVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  if (map.getLayer('citywide-parcels-fill')) map.setLayoutProperty('citywide-parcels-fill', 'visibility', v);
  if (map.getLayer('citywide-parcels-line')) map.setLayoutProperty('citywide-parcels-line', 'visibility', v);
  if (map.getLayer('citywide-parcels-label')) map.setLayoutProperty('citywide-parcels-label', 'visibility', v);
}

/** Toggle the derived dwelling-unit labels independently of parcel outlines. */
export function setDwellingUnitsVisible(map, visible) {
  const value = visible ? 'visible' : 'none';
  for (const id of DWELLING_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value);
  }
}

/**
 * Resolve true/false based on whether the .pmtiles archive can be
 * fetched. Used by the toggle handler to surface a "tiles not built"
 * hint instead of silently doing nothing when the asset is missing.
 * One-time check (the result doesn't change at runtime); cached.
 */
let _citywideTilesAvailable = null;
// Build date of the deployed .pmtiles, from the committed sidecar written by
// r/build_parcel_tiles.R. The tiles are a months-old snapshot (the deployed
// set predates the live table by ~2 months at audit time) and their tooltip
// attributes can disagree with live data — the popup says so. Null when the
// sidecar is missing (pre-sidecar tile builds): the popup just omits the line.
let _citywideBuiltDate = null;

// Console-only staleness backstop for the citywide tiles, in the same spirit
// as the historical-pin check in soda.js (audit H-1). The archive rebuilds on
// the 2nd of every even month (WpgParcelTilesBiMonthly -> r/rebuild_tiles.ps1),
// so a healthy one is at most ~62 days old.
//
// This catches the one failure the server-side heartbeat in r/refresh_assets.ps1
// cannot: the scheduler machine being off, or every task disabled — no job runs
// to notice that no job ran. Here the signal comes from the deployed app, which
// only needs a visitor. Console-only, so normal users never see it.
//
// 90 days = two consecutive missed rebuilds. Anything tighter would cry wolf on
// a single run that merely started late (StartWhenAvailable defers to logon).
const TILE_STALE_DAYS = 90;
function warnIfTilesStale(builtDate) {
  const built = Date.parse(`${builtDate}T00:00:00Z`);
  if (!Number.isFinite(built)) return;
  const ageDays = Math.floor((Date.now() - built) / 86_400_000);
  if (ageDays > TILE_STALE_DAYS) {
    console.warn(
      `[citywide-parcels] tile archive is ${ageDays} days old (built ${builtDate}) — the `
      + `bi-monthly rebuild has not published since. Check the WpgParcelTilesBiMonthly `
      + `scheduled task and r/rebuild_tiles.ps1; parcels created since then are missing `
      + `from Show All Parcels and Dwelling Units.`
    );
  }
}

export async function probeCitywideParcels() {
  if (_citywideTilesAvailable !== null) return _citywideTilesAvailable;
  try {
    const res = await fetch('/parcels.pmtiles', { method: 'HEAD' });
    _citywideTilesAvailable = res.ok;
  } catch {
    _citywideTilesAvailable = false;
  }
  if (_citywideTilesAvailable) {
    // Fire-and-forget: the popup can only open after the toggle (and this
    // probe) has run, so the date is in place by first click in practice.
    fetch('/parcels-pmtiles-meta.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => {
        const d = meta?.built;
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
          _citywideBuiltDate = d;
          warnIfTilesStale(d);
        }
      })
      .catch(() => { /* sidecar optional */ });
  }
  return _citywideTilesAvailable;
}

/** Push data into the named OurWinnipeg overlay source. */
export function setOverlayData(map, sourceId, fc) {
  const src = map.getSource(sourceId);
  if (src) src.setData(fc);
}

/** Set line + station traffic-volume overlay data. */
export function setTrafficData(map, lineFc, stationFc) {
  const lineSrc = map.getSource('traffic-lines');
  const stationSrc = map.getSource('traffic-stations');
  if (lineSrc) lineSrc.setData(lineFc);
  if (stationSrc) stationSrc.setData(stationFc);
}

/** Toggle traffic line/station layers together. */
export function setTrafficVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of [
    'traffic-lines-casing',
    'traffic-lines',
    'traffic-lines-label',
    'traffic-stations-circle',
    'traffic-stations-label',
  ]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

/** Set / clear the civic-address Point feature collection. Each feature
 *  carries a `street_num` for the symbol-layer label. */
export function setCivicAddresses(map, fc) {
  const src = map.getSource('civic-addresses');
  if (src) src.setData(fc);
}

/** Set / clear the dimension-label LineString feature collection. */
export function setDimensions(map, fc) {
  const src = map.getSource('dimensions');
  if (src) src.setData(fc);
}

/** Toggle the dimension-label layer's visibility. */
export function setDimensionsVisible(map, visible) {
  if (map.getLayer('dimensions-label')) {
    map.setLayoutProperty('dimensions-label', 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * Toggle visibility on every layer that draws from the named overlay
 * source. Generic enough to handle the secondary-plans (3 layers:
 * fill/line/label), infill-guideline (2 layers), and malls-corridors
 * (2 layers) groups. Pass the source id; this finds every layer using
 * it and flips them in lockstep.
 */
export function setOverlayVisible(map, sourceId, visible) {
  const v = visible ? 'visible' : 'none';
  const layers = map.getStyle()?.layers || [];
  for (const layer of layers) {
    if (layer.source === sourceId) {
      map.setLayoutProperty(layer.id, 'visibility', v);
    }
  }
}

/** Push the parsed Manitoba Contaminated Sites Registry FC onto the
 *  map. Called by main.js after the lazy fetch resolves. */
export function setContamData(map, fc) {
  map.getSource('contam')?.setData(fc);
}

/** Toggle the contam-circle layer visibility. */
export function setContamVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  if (map.getLayer('contam-circle')) map.setLayoutProperty('contam-circle', 'visibility', v);
}

// Click-popup body for zoning polygons. Shows the zone code, the short
// category, and the long description (which is sometimes a useful sentence
// or two about what the district allows).
function zoningPopupHtml(p) {
  const lines = [];
  if (p.zoning) lines.push(`<strong>${escapeHtml(p.zoning)}</strong>`);
  if (p.short_description) lines.push(`<em>${escapeHtml(p.short_description)}</em>`);
  if (p.long_description) lines.push(escapeHtml(p.long_description));
  return `<div style="max-width:300px;line-height:1.35">${lines.join('<br>')}</div>`;
}

// Click-popup body for a HISTORICAL zoning polygon — the zoning detail plus an
// as-of-date header and the verify disclaimer shared by the other historical
// popups. `snap` is our own controlled YYYY-MM-DD string (no user input).
function historicalZoningHtml(p, snap) {
  const lines = [];
  if (snap) lines.push(`<strong>Zoning as of ${escapeHtml(snap)}</strong>`);
  if (p.zoning) lines.push(`Zone <strong>${escapeHtml(p.zoning)}</strong>`);
  if (p.short_description) lines.push(`<em>${escapeHtml(p.short_description)}</em>`);
  if (p.long_description) lines.push(escapeHtml(p.long_description));
  lines.push('<span style="color:#b45309">Verify against the current zoning by-law / map.</span>');
  return `<div style="max-width:320px;line-height:1.35">${lines.join('<br>')}</div>`;
}

// Click-popup body for a contaminated-site circle. Shows the operation
// name, address line, status pill colour-keyed to the circle, and a
// link out to the official Manitoba registry page for that site.
function contamPopupHtml(p) {
  const name = p['OPERATION NAME'] || p.OPRID || 'Contaminated site';
  const lines = [`<strong>${escapeHtml(name)}</strong>`];
  const addr = [p.ADDRESS, p.MUNICIPALITY].filter(Boolean).map(escapeHtml).join(', ');
  if (addr) lines.push(addr);
  const group = p.CSGroup || '';
  if (group) {
    const colour = group === 'Designated Contaminated Site' ? '#c0392b'
                : group === 'Designated Impacted Site'     ? '#e67e22'
                :                                            '#7f8c8d';
    lines.push(
      `<span style="display:inline-block;padding:1px 6px;border-radius:3px;`
      + `background:${colour};color:#fff;font-size:11px">${escapeHtml(group)}</span>`
    );
  }
  const url = safeExternalUrl(p.Link);
  if (url) {
    lines.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Registry record</a>`);
  }
  if (p.OPRID) lines.push(`<small>Site ID: ${escapeHtml(p.OPRID)}</small>`);
  return `<div style="max-width:300px;line-height:1.4">${lines.join('<br>')}</div>`;
}

// Allow only http(s) URLs through to popup links — never javascript:,
// data:, vbscript:, etc. Returns null if the URL is malformed or uses
// any other scheme.
function safeExternalUrl(raw) {
  if (raw == null || raw === '') return null;
  try {
    const u = new URL(String(raw));
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
  } catch {
    return null;
  }
}

function trafficPopupHtml(p) {
  const isStation = p.traffic_kind === 'station';
  const title = isStation
    ? (p.site || 'Permanent count station')
    : (p.location_description || p.road_name || p.street || 'Traffic count');
  const lines = [`<strong>${escapeHtml(title)}</strong>`];
  if (p.avg_daily_volume) {
    lines.push(`24h avg volume: <strong>${Number(p.avg_daily_volume).toLocaleString('en-US')}</strong> vehicles/day`);
  }
  if (!isStation && p.street_from && p.street_to) {
    lines.push(`${escapeHtml(p.street_from)} to ${escapeHtml(p.street_to)}`);
  }
  if (p.count_start || p.count_end) {
    lines.push(`<small>Count window: ${escapeHtml(formatDate(p.count_start))} to ${escapeHtml(formatDate(p.count_end))}</small>`);
  }
  if (p.match_type) lines.push(`<small>Match: ${escapeHtml(p.match_type)}</small>`);
  if (p.source_name) lines.push(`<small>Source: ${escapeHtml(p.source_name)}</small>`);
  return `<div style="max-width:320px;line-height:1.4">${lines.join('<br>')}</div>`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-CA');
}

/**
 * Combined hover popup. Either or both of the property objects can be
 * undefined; whatever's present gets rendered with a "Survey" or
 * "Assessment" header so the user can always tell which colour they're
 * looking at — addresses the "I got mixed up which is which" feedback.
 *
 * `primary` is the feature on the parcel-fill layer (blue) — could be
 * either a survey or assessment depending on flow. We detect by looking
 * for a roll_number on the props.
 * `context` is the assess-context layer (red) — always assessment data.
 */
/**
 * Sticky click popup for a citywide-parcels feature (i.e. a parcel
 * NOT in the active search). Shows the roll # + full address, a
 * link out to the Winnipeg Assessment & Taxation page for that
 * roll, and a GPS Coordinates link that copies the polygon's centroid
 * (bbox midpoint) to the clipboard. Mirrors the Manitoba sister
 * app's muniParcelHtml — same action-row layout so users moving
 * between the two tools see the same UX.
 */
function citywideParcelHtml(p) {
  if (!p) return '';
  const roll = p.roll_number ? String(p.roll_number) : null;
  const address = p.full_address || null;
  const lines = [];
  if (roll) lines.push(`<strong>Roll #</strong> ${escapeHtml(roll)}`);
  if (address) lines.push(escapeHtml(address));
  // Property Use Code, then zoning directly beneath it — the same pair,
  // in the same order, as the hover popup above. Actual use on top,
  // legally permitted use under it, so a non-conforming parcel (RESSD on
  // a C2 lot) reads as a mismatch between adjacent lines. The full
  // published string, not stripZoningCode: that exists to fit a badge in
  // a table cell and the popup has the room.
  //
  // Both come from the tile, so both can be absent and both drop their
  // line rather than render an empty one. property_use_code has been in
  // the archive all along and simply was not shown here. zoning was added
  // to r/build_parcel_tiles.R on 2026-08-20 and reaches users at the next
  // scheduled rebuild (WpgParcelTilesBiMonthly, 2026-10-02) — until then
  // this line is silently absent, which is why it is written to degrade
  // rather than to assume.
  if (p.property_use_code) lines.push(`<em>${escapeHtml(p.property_use_code)}</em>`);
  if (p.zoning) lines.push(`<em>${escapeHtml(p.zoning)}</em>`);
  // Size sits between the use codes and the unit count, the same slot it
  // occupies in the hover popup, so the two popups read in one order:
  // what it is, how big, how many units, what it is worth.
  const size = parcelSizeLine(p);
  if (size) lines.push(size);
  if (p.dwelling_unit_count != null && p.dwelling_unit_count !== '') {
    lines.push(`<strong>Total dwelling units</strong> ${escapeHtml(formatDwellingCount(p.dwelling_unit_count))}`);
  }
  // Assessed value + year, then class + status: the same two lines, in the
  // same order, as the hover popup. All four fields (total_assessed_value,
  // current_assessment_year, property_class_1, status_1) were absent from
  // the tile build; they were added to select_cols in r/build_parcel_tiles.R
  // on 2026-08-24 and reach users at the next rebuild
  // (WpgParcelTilesBiMonthly, 2026-10-02). Until then both helpers return
  // null and the lines are silently absent — written to degrade rather than
  // to assume, same as the zoning line above.
  const asmt = assessmentLine(p);
  if (asmt) lines.push(asmt);
  const asmtClass = assessmentClassLine(p);
  if (asmtClass) lines.push(asmtClass);
  const actions = [];
  if (roll) {
    const url = `https://assessment.winnipeg.ca/AsmtPub/english/propertydetails/details.aspx?pgLang=EN&isRealtySearch=true&RollNumber=${encodeURIComponent(roll)}`;
    actions.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Assessment →</a>`);
  }
  actions.push(`<a href="#" class="parcel-coords-copy" role="button" title="Copy parcel centroid (lat, lng) to clipboard">GPS Coordinates</a>`);
  if (actions.length) {
    lines.push(actions.join(' &nbsp;·&nbsp; '));
  }
  // Tiles are an offline-built snapshot, not live SODA data — date it so a
  // stale address/PUCS here isn't mistaken for the current record.
  if (_citywideBuiltDate) {
    lines.push(`<small style="color:#888">Tile snapshot as of ${escapeHtml(_citywideBuiltDate)} — search for live data</small>`);
  }
  return `<div style="max-width:280px;line-height:1.45;font-size:13px">${lines.join('<br>')}</div>`;
}

function formatDwellingCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.round(count).toLocaleString('en-CA') : String(value ?? '');
}

function dwellingUnitHtml(p, includeSnapshot = false) {
  if (!p) return '';
  const lines = [
    `<strong>Total dwelling units</strong> ${escapeHtml(formatDwellingCount(p.dwelling_unit_count))}`,
  ];
  if (p.dwelling_group_address) lines.push(escapeHtml(p.dwelling_group_address));
  if (p.dwelling_pucs_codes) lines.push(`<em>${escapeHtml(p.dwelling_pucs_codes)}</em>`);
  const method = p.dwelling_count_method;
  const records = Number(p.dwelling_record_count);
  if (method === 'assessment_reported') {
    lines.push('<small>Assessment-reported count</small>');
  } else if (method === 'grouped_records' && Number.isFinite(records)) {
    lines.push(`<small>Grouped from ${records.toLocaleString('en-CA')} qualifying condominium assessment record${records === 1 ? '' : 's'}</small>`);
  } else if (method === 'default_one') {
    lines.push('<small>Defaulted to one qualifying residential parcel</small>');
  }
  if (includeSnapshot && _citywideBuiltDate) {
    lines.push(`<small style="color:#888">Tile snapshot as of ${escapeHtml(_citywideBuiltDate)} — search for live data</small>`);
  }
  return `<div style="max-width:300px;line-height:1.45;font-size:13px">${lines.join('<br>')}</div>`;
}

/**
 * Compute the midpoint of a (Multi)Polygon geometry's bounding box.
 * Stable, fast, no turf dependency. Returns [lng, lat] or null when
 * the geometry is missing / malformed.
 */
function polygonBboxMidpoint(geometry) {
  if (!geometry) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  function visit(coords) {
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      return;
    }
    for (const c of coords) visit(c);
  }
  if (geometry.coordinates) visit(geometry.coordinates);
  if (!Number.isFinite(minLng)) return null;
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

/**
 * After a popup with a `.parcel-coords-copy` anchor is mounted,
 * wire its click to copy "lat, lng" to the clipboard with brief
 * "Copied!" feedback. Falls back to the legacy execCommand path on
 * non-secure contexts (http:// dev hosts) where navigator.clipboard
 * isn't available.
 */
function wireCoordsCopy(popup, lngLat) {
  if (!popup || !Array.isArray(lngLat)) return;
  const el = popup.getElement?.();
  const anchor = el?.querySelector('.parcel-coords-copy');
  if (!anchor) return;
  const [lng, lat] = lngLat;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  const text = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  anchor.addEventListener('click', (ev) => {
    ev.preventDefault();
    const onSuccess = () => {
      const original = anchor.textContent;
      anchor.textContent = 'Copied!';
      setTimeout(() => { anchor.textContent = original; }, 1500);
    };
    const onFailure = () => { anchor.textContent = 'Copy failed'; };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess, onFailure);
    } else {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        onSuccess();
      } catch { onFailure(); }
    }
  });
}

/**
 * "Size 5,400 sf (0.12 ac)" — assessed_land_area is in square feet on
 * d4mq-wa44. Both units on one line for appraisal sanity-checking at a
 * glance: square feet is how an urban lot is transacted, acres is how it
 * is compared to anything rural.
 *
 * Shared by the hover popup and the citywide click popup. It was inline
 * in the hover popup only, which is why the click popup silently had no
 * size line at all despite assessed_land_area having been in the tile
 * archive from the first build — the Manitoba sister app leads its popup
 * with Land Size, and this was the gap.
 */
function parcelSizeLine(p) {
  const sf = Number(p?.assessed_land_area);
  if (!Number.isFinite(sf) || sf <= 0) return null;
  const sfFmt = Math.round(sf).toLocaleString('en-US');
  const ac = (sf / 43560).toFixed(2);
  return `<strong>Size</strong> ${escapeHtml(sfFmt)} sf (${escapeHtml(ac)} ac)`;
}

/**
 * "Assessment (2026) $723,000" — the parcel's total assessed value with
 * the assessment year it belongs to, as one line. Shared by the hover
 * popup and the citywide click popup so the two can never disagree.
 *
 * The year is in parentheses on the value rather than on its own line
 * because the two are a single fact: a dollar figure with no year is
 * not usable for a comparison, and the pair reads the same way it does
 * in the Manitoba sister app's popup ("Assessment (2026)").
 *
 * Both halves degrade independently. total_assessed_value missing ⇒ no
 * line at all (an assessment line with no amount says nothing);
 * current_assessment_year missing ⇒ the amount still shows, unlabelled
 * by year. formatDollars already returns null for 0 / blank / negative,
 * which is the right call here — a $0 total is a data gap, not a
 * valuation.
 *
 * On citywide (Show All Parcels) features BOTH fields are absent until
 * the archive is next rebuilt with them — see the select_cols note in
 * r/build_parcel_tiles.R — so this returns null there for now and the
 * popup simply omits the line, exactly as it did for `zoning` between
 * that field being added to the build and the rebuild landing.
 */
function assessmentLine(p) {
  const value = formatDollars(p?.total_assessed_value);
  if (!value) return null;
  const year = Number(p?.current_assessment_year);
  const yearLabel = Number.isFinite(year) && year > 0 ? ` (${year})` : '';
  return `<strong>Assessment${escapeHtml(yearLabel)}</strong> ${escapeHtml(value)}`;
}

/**
 * "RESIDENTIAL 1 · TAXABLE" — the parcel's assessment class and its
 * taxable status, as one line under the assessed value. Same pairing,
 * and the same middot separator, as the Manitoba sister app's popup.
 *
 * Deliberately independent of assessmentLine rather than folded into it:
 * a parcel can carry a class with no published value, and the class is
 * still worth stating on its own. Status is the half that earns the line
 * — ~5,500 of 245K parcels are EXEMPT / GRANT / SCHOOL EXEMPT rather
 * than TAXABLE, and an exempt comp is one you need to notice before you
 * lean on it. It is dropped when absent rather than shown as a bare
 * separator, so a parcel with a class and no status reads as just the
 * class.
 *
 * property_class_N / status_N are portioned: a roll can carry up to five
 * class/value/status triples. Only the first is shown, matching the
 * sales-tab class filter, which reads property_class_1 for the same
 * reason — the dominant portion is the one that describes the parcel.
 */
function assessmentClassLine(p) {
  const cls = p?.property_class_1 ? String(p.property_class_1).trim() : '';
  const status = p?.status_1 ? String(p.status_1).trim() : '';
  if (!cls && !status) return null;
  const text = [cls, status].filter(Boolean).join(' · ');
  return `<em>${escapeHtml(text)}</em>`;
}

function combinedPopupHtml(primary, context) {
  const blocks = [];
  // Determine which schema `primary` is carrying.
  const primaryIsAssess = primary && (primary.roll_number != null || primary.full_address != null);
  const primaryIsSurvey = primary && !primaryIsAssess;

  if (primaryIsSurvey) {
    blocks.push(`<div><strong style="color:#0b2566">Survey Parcel</strong><br>${popupHtml(primary)}</div>`);
  }
  if (primaryIsAssess) {
    blocks.push(`<div><strong style="color:#8a6500">Assessment Parcel</strong><br>${popupHtml(primary)}</div>`);
  }
  // The context layer is always assessment-side. Only show separately
  // from primary to avoid duplicating the same parcel.
  if (context && (!primaryIsAssess || context.roll_number !== primary?.roll_number)) {
    blocks.push(`<div><strong style="color:#8a6500">Assessment Parcel</strong><br>${popupHtml(context)}</div>`);
  }
  return blocks.join('<hr style="margin:6px 0;border:none;border-top:1px solid #ddd">');
}

// Render a hover-popup HTML block from whichever schema is present.
// Survey Parcels feature: has lot/block/plan/description.
// Assessment Parcels feature: has roll_number/full_address/zoning.
function popupHtml(p) {
  if (p.roll_number != null || p.full_address != null) {
    const lines = [];
    if (p.roll_number) lines.push(`<strong>Roll #</strong> ${escapeHtml(p.roll_number)}`);
    if (p.full_address) lines.push(escapeHtml(p.full_address));
    // Property Use Code (PUC) - the City's classification of how the
    // parcel is actually being used, e.g. "RESSD - DETACHED SINGLE
    // DWELLING". More informative for appraisal context than zoning
    // (which is the legally permitted use, often less specific).
    if (p.property_use_code) lines.push(`<em>${escapeHtml(p.property_use_code)}</em>`);
    // Zoning goes directly under the PUC because those two lines are read
    // as a pair: actual use on top, legally permitted use beneath it, so a
    // non-conforming parcel (RESSD sitting on a C2 lot) reads as a mismatch
    // between adjacent lines instead of a separate lookup.
    // Same source order as the grid's Zoning column (lib/columnsRegistry.js
    // renders `zoning_top1 ?? zoning`), so the popup and the table can never
    // name different zones for one parcel: zoning_top1 is the area-weighted
    // intersection soda.js stamps once the Zoning overlay has run, `zoning`
    // the d4mq-wa44 primary code otherwise. Unlike the grid we do NOT run
    // stripZoningCode — that exists to fit a badge inside a cell, while the
    // popup has room for the full published string ("R1M - RES - S F -
    // MEDIUM"), which sits consistently beside the PUC line above.
    // 27,769 parcels publish no zoning at all; those drop the line entirely
    // rather than render an empty one, same as every other field here.
    const zoning = p.zoning_top1 ?? p.zoning;
    if (zoning) lines.push(`<em>${escapeHtml(zoning)}</em>`);
    const size = parcelSizeLine(p);
    if (size) lines.push(size);
    // Dwelling units: dwelling_units is text-typed; coerce defensively.
    // Show even when 0 because vacant lot is a meaningful state.
    if (p.dwelling_units != null && p.dwelling_units !== '') {
      const du = Number(p.dwelling_units);
      if (Number.isFinite(du)) {
        lines.push(`<strong>Reported DU</strong> ${du}`);
      }
    }
    // Assessed value + its assessment year, in the same slot the Manitoba
    // sister app puts them: after zoning / size / DU, so the popup reads
    // description first, valuation last. Search-result features carry both
    // fields from the live SoDA query (ASSESS_SELECT in soda.js); citywide
    // features do not carry them yet, and assessmentLine drops the line
    // rather than render a half-empty one.
    const asmt = assessmentLine(p);
    if (asmt) lines.push(asmt);
    const asmtClass = assessmentClassLine(p);
    if (asmtClass) lines.push(asmtClass);
    // For multi-unit buildings (condos, strip malls) the same polygon
    // covers many roll numbers. dedupeByGeometryHash in main.js stamps
    // _unitCount on the representative feature so the popup can flag
    // the other units. Click scrolls to the representative's row;
    // other units are visible in the table for sort/scroll.
    const n = Number(p._unitCount);
    if (Number.isFinite(n) && n > 1) {
      lines.push(`<small>+ ${n - 1} more unit${n - 1 === 1 ? '' : 's'} at this location — see table for the full list</small>`);
    }
    return lines.join('<br>');
  }
  // Survey Parcels schema.
  const head = `<strong>Lot</strong> ${escapeHtml(p.lot ?? '')}`
    + `&nbsp;<strong>Block</strong> ${escapeHtml(p.block ?? '')}`
    + `&nbsp;<strong>Plan</strong> ${escapeHtml(p.plan ?? '')}`;
  return p.description
    ? `${head}<br>${escapeHtml(p.description)}`
    : head;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Validate a colour value before it goes into an inline `style` attribute.
// escapeHtml guards the HTML context but not the CSS context, so an
// API-supplied value like `red;background:url(http://x)` could otherwise be
// injected into the CSS. Accept only a hex colour (GTFS route_color is six
// hex digits, with or without a leading #) and normalise it; anything else
// returns '' so the caller drops the swatch.
function safeCssColor(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value ?? '').trim());
  return m ? `#${m[1]}` : '';
}

/**
 * Custom MapLibre control: a basemap menu in the top-right gutter under the zoom
 * buttons. A trigger button shows the current basemap; hovering it (or tapping /
 * focusing it, for touch + keyboard) opens a dropdown listing every basemap —
 * Streets, each Aerial <year> newest-first, then Satellite — so any view is one
 * click away instead of cycling. Stateless about the basemap: it reads layer
 * visibility to know the current view and to highlight the active row.
 */
const BASEMAP_LABELS = { streets: 'Streets', satellite: 'Satellite', aerial: 'Aerial' };
class BasemapMenuControl {
  constructor(onChange) {
    this._onChange = onChange;
  }

  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    // Keeps .basemap-toggle for the shared top-right control look; .basemap-menu
    // layers the dropdown behaviour on top.
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-toggle basemap-menu';

    // Flat list of selectable views: Streets, then Aerial years (newest first,
    // from ORTHO_YEARS), then Satellite. Each row's key matches what _currentKey
    // reports (the ortho layer id for aerials) and carries how to apply it.
    this._views = [
      { key: 'streets', label: BASEMAP_LABELS.streets, apply: () => this._set('streets') },
      ...ORTHO_YEARS.map((y) => ({ key: `ortho-${y}`, label: `Aerial ${y}`, apply: () => this._set('aerial', y) })),
      { key: 'satellite', label: BASEMAP_LABELS.satellite, apply: () => this._set('satellite') },
    ];

    // Trigger — shows the current view label (+ a CSS chevron).
    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.className = 'basemap-menu-trigger';
    this._btn.setAttribute('aria-haspopup', 'true');
    this._btn.setAttribute('aria-expanded', 'false');
    this._labelEl = document.createElement('span');
    this._labelEl.className = 'basemap-menu-label';
    this._btn.appendChild(this._labelEl);
    this._btn.addEventListener('click', (e) => { e.stopPropagation(); this._toggle(); });
    this._container.appendChild(this._btn);

    // Dropdown — one row per view.
    this._list = document.createElement('div');
    this._list.className = 'basemap-menu-list';
    this._list.setAttribute('role', 'menu');
    for (const v of this._views) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'basemap-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = v.label;
      item.dataset.key = v.key;
      item.addEventListener('click', (e) => { e.stopPropagation(); v.apply(); this._close(); });
      this._list.appendChild(item);
    }
    this._container.appendChild(this._list);

    // Open on hover / keyboard focus; close on leave (slightly delayed so the
    // pointer can cross the small gap into the list without it flickering shut),
    // on blur out of the control, on Escape, and on a tap/click elsewhere.
    this._container.addEventListener('mouseenter', () => this._open());
    this._container.addEventListener('mouseleave', () => this._scheduleClose());
    this._container.addEventListener('focusin', () => this._open());
    this._container.addEventListener('focusout', (e) => { if (!this._container.contains(e.relatedTarget)) this._close(); });
    this._container.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this._close(); this._btn.focus(); } });
    this._onDocClick = (e) => { if (!this._container.contains(e.target)) this._close(); };
    document.addEventListener('click', this._onDocClick);

    this._render();
    return this._container;
  }
  _open() { clearTimeout(this._closeTimer); this._container.classList.add('open'); this._btn.setAttribute('aria-expanded', 'true'); }
  _close() { clearTimeout(this._closeTimer); this._container.classList.remove('open'); this._btn.setAttribute('aria-expanded', 'false'); }
  _scheduleClose() { clearTimeout(this._closeTimer); this._closeTimer = setTimeout(() => this._close(), 140); }
  _toggle() { this._container.classList.contains('open') ? this._close() : this._open(); }
  // Current view read from layer visibility, so it's right no matter how the
  // basemap was last changed. Each getLayoutProperty is guarded by getLayer so
  // this stays silent before the style loads — asking a non-existent layer for
  // its paint props fires a map 'error' event (it doesn't throw, so a try/catch
  // wouldn't help). Missing layers ⇒ nothing visible yet ⇒ the streets default.
  _currentKey() {
    const m = this._map;
    for (const y of ORTHO_YEARS) {
      const id = `ortho-${y}`;
      if (m.getLayer(id) && m.getLayoutProperty(id, 'visibility') === 'visible') return id;
    }
    if (m.getLayer('esri-imagery') && m.getLayoutProperty('esri-imagery', 'visibility') === 'visible') return 'satellite';
    return 'streets';
  }
  _set(state, year) {
    const m = this._map;
    const previousKey = this._currentKey();
    const previousState = previousKey.startsWith('ortho-') ? 'aerial' : previousKey;
    // Esri imagery backs both satellite and aerial (showing through beyond the
    // City ortho extent). Esri transportation belongs to Satellite only;
    // aerials instead use the sharper City road network. Esri place/boundary
    // labels remain useful on both imagery modes.
    const imagery = state === 'satellite' || state === 'aerial';
    m.setLayoutProperty('carto-positron',      'visibility', state === 'streets' ? 'visible' : 'none');
    m.setLayoutProperty('esri-imagery',        'visibility', imagery ? 'visible' : 'none');
    m.setLayoutProperty('esri-transportation', 'visibility', state === 'satellite' ? 'visible' : 'none');
    m.setLayoutProperty('esri-reference',      'visibility', imagery ? 'visible' : 'none');
    // Exactly one ortho layer visible — the picked year, and only in aerial.
    for (const y of ORTHO_YEARS) {
      const id = `ortho-${y}`;
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', (state === 'aerial' && y === year) ? 'visible' : 'none');
    }
    // The citywide Assessment Parcels fabric re-calibrates to the new
    // ground: light grey over the Positron streets, white over imagery.
    applyCitywideParcelsBasemapStyle(m, ORTHO_YEARS.map((y) => `ortho-${y}`));
    this._render();
    if (this._onChange) {
      Promise.resolve(this._onChange({ state, year, previousState }))
        .catch((err) => console.warn('basemap change handler failed', err));
    }
  }
  _render() {
    const cur = this._currentKey();
    const curView = this._views.find((v) => v.key === cur) ?? this._views[0];
    this._labelEl.textContent = curView.label;
    this._btn.classList.toggle('active', cur !== 'streets');
    this._btn.title = `Basemap: ${curView.label}`;
    this._btn.setAttribute('aria-label', `Basemap: ${curView.label}. Open to choose another.`);
    for (const item of this._list.querySelectorAll('.basemap-menu-item')) {
      const on = item.dataset.key === cur;
      item.classList.toggle('active', on);
      item.setAttribute('aria-current', on ? 'true' : 'false');
    }
  }
  onRemove() {
    clearTimeout(this._closeTimer);
    if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}

/**
 * Distance / area measurement control. Sits in the top-right gutter
 * next to BasemapToggle. Opens a small panel with two mode buttons
 * (Distance / Area), a live readout, and Clear / Done actions.
 * Drawing is delegated to mapbox-gl-draw (compatible with MapLibre
 * after the class-name patch at the top of this file); we listen
 * for draw events and recompute length (@turf/length) or area
 * (@turf/area) on every render.
 */
class MeasureControl {
  constructor(draw) {
    this._draw = draw;
    this._mode = null;
  }
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group measure-control';

    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.title = 'Measure distance or area';
    this._btn.setAttribute('aria-label', 'Measure distance or area');
    this._btn.textContent = 'Measure';
    this._btn.addEventListener('click', () => this._togglePanel());
    this._container.appendChild(this._btn);

    this._panel = document.createElement('div');
    this._panel.className = 'measure-panel';
    this._panel.style.display = 'none';
    this._panel.innerHTML = `
      <div class="measure-modes">
        <button type="button" data-mode="distance">Distance</button>
        <button type="button" data-mode="area">Area</button>
      </div>
      <div class="measure-readout" aria-live="polite">Pick a mode to start.</div>
      <div class="measure-actions">
        <button type="button" class="measure-clear">Clear</button>
        <button type="button" class="measure-done">Done</button>
      </div>
    `;
    this._container.appendChild(this._panel);

    this._panel.querySelectorAll('.measure-modes button').forEach((btn) => {
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
    });
    this._panel.querySelector('.measure-clear').addEventListener('click', () => {
      // Re-running _setMode with the same mode is the cleanest reset:
      // deletes everything, re-enters the draw mode, and refreshes
      // the readout instructions.
      if (this._mode) {
        this._setMode(this._mode);
      } else {
        this._draw.deleteAll();
        this._setReadout('Pick a mode to start.');
      }
    });
    this._panel.querySelector('.measure-done').addEventListener('click', () => this._close());

    const onChange = () => this._update();
    map.on('draw.create', onChange);
    map.on('draw.update', onChange);
    map.on('draw.render', onChange);
    map.on('draw.delete', onChange);

    return this._container;
  }
  _togglePanel() {
    const open = this._panel.style.display === 'none';
    if (open) {
      this._panel.style.display = 'block';
      this._btn.classList.add('active');
    } else {
      this._close();
    }
  }
  _close() {
    this._draw.deleteAll();
    try { this._draw.changeMode('simple_select'); } catch { /* already simple_select */ }
    this._panel.style.display = 'none';
    this._btn.classList.remove('active');
    this._setMode(null, { skipModeChange: true });
    this._setReadout('Pick a mode to start.');
  }
  _setMode(mode, { skipModeChange = false } = {}) {
    this._mode = mode;
    this._panel.querySelectorAll('.measure-modes button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    if (skipModeChange) return;
    this._draw.deleteAll();
    if (mode === 'distance') {
      this._draw.changeMode('draw_line_string');
      this._setReadout('Click to add points. Double-click to finish.');
    } else if (mode === 'area') {
      this._draw.changeMode('draw_polygon');
      this._setReadout('Click to add points. Double-click to close polygon.');
    }
  }
  _setReadout(html) {
    this._panel.querySelector('.measure-readout').innerHTML = html;
  }
  _update() {
    if (!this._mode) return;
    const data = this._draw.getAll();
    const f = data.features[0];
    if (!f) return;
    const g = f.geometry;
    if (this._mode === 'distance' && (g.type === 'LineString' || g.type === 'MultiLineString')) {
      const coords = g.type === 'LineString' ? g.coordinates : (g.coordinates[0] || []);
      if (!coords || coords.length < 2) return;
      const km = turfLength(f, { units: 'kilometers' });
      const m  = km * 1000;
      const mi = km / 1.609344;
      const ft = m * 3.28084;
      this._setReadout(
        `<strong>Distance</strong>` +
        `${fmtNum(m, m < 10 ? 2 : 1)} m &nbsp;(${fmtNum(km, 3)} km)<br>` +
        `${fmtNum(ft, 0)} ft &nbsp;(${fmtNum(mi, 3)} mi)`
      );
    } else if (this._mode === 'area' && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
      const ring = g.type === 'Polygon' ? g.coordinates[0] : (g.coordinates[0]?.[0] || []);
      if (!ring || ring.length < 4) return;
      const sqm   = turfArea(f);
      const ha    = sqm / 10000;
      const sqft  = sqm * 10.7639104167;
      const acres = sqm / 4046.8564224;
      this._setReadout(
        `<strong>Area</strong>` +
        `${fmtNum(sqm, 0)} m² &nbsp;(${fmtNum(ha, 4)} ha)<br>` +
        `${fmtNum(sqft, 0)} sf &nbsp;(${fmtNum(acres, 3)} acres)`
      );
    }
  }
  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}

function fmtNum(n, decimals) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-CA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ---------- Historical (as-of-date) overlay — state, popups, exports ----------

// Snapshot date the historical layers currently show (YYYY-MM-DD) — read by the
// popups so each tooltip can state its as-of date.
let historicalSnap = null;
// Lineage by-key lookups for the loaded neighbourhood: assessment keyed by
// roll_number, survey keyed by id. Each entry = { type, confidence,
// predecessors[], successors[] }.
let historicalLineage = null;
let historicalSurveyLineage = null;

// Size-change colour ramp (shared by the parcel fill + line): major red, minor
// orange, gone grey, else historical amber. `_sizeBand` is stamped in main.js.
const HIST_SIZE_COLOR = ['match', ['get', '_sizeBand'],
  'major', '#dc2626', 'minor', '#ea580c', 'gone', '#6b7280', '#b45309'];

/**
 * Push historical layer data + lineage context onto the map.
 * data = { parcels, survey, snap, lineage, surveyLineage }.
 * Any field omitted is left unchanged; FCs default to empty.
 */
export function setHistoricalData(map, data = {}) {
  if ('snap' in data)          historicalSnap = data.snap;
  if ('lineage' in data)       historicalLineage = data.lineage;
  if ('surveyLineage' in data) historicalSurveyLineage = data.surveyLineage;
  const set = (srcId, fc) => {
    const s = map.getSource(srcId);
    if (s) s.setData(fc || { type: 'FeatureCollection', features: [] });
  };
  set('historical-parcels', data.parcels);
  set('historical-survey',  data.survey);
}

export function setHistoricalVisible(map, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of ['historical-parcels-fill', 'historical-parcels-line',
                    'historical-survey-fill', 'historical-survey-line']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
}

/** Push the whole-city historical zoning FC (or null to clear). Records `snap`
 *  so the zoning popup can state its as-of date. */
export function setHistoricalZoningData(map, fc, snap) {
  if (snap !== undefined) historicalSnap = snap;
  const s = map.getSource('historical-zoning');
  if (s) s.setData(fc || { type: 'FeatureCollection', features: [] });
}

export function setHistoricalZoningVisible(map, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of ['historical-zoning-fill', 'historical-zoning-line', 'historical-zoning-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
}

// Assessment page for a roll, rebuilt from the roll against the City's canonical
// cert-valid host. The dataset's own detail_url points at winnipegassessment.com,
// whose HTTPS cert is mismatched (ERR_CERT_COMMON_NAME_INVALID) — so, like the
// rest of the app (assessmentUrl in main.js), we rebuild from roll_number.
// Resolves for any roll that still exists today; a since-removed roll just won't
// be found on the site.
function rollAssessmentUrl(roll) {
  if (roll == null || roll === '') return null;
  return 'https://assessment.winnipeg.ca/AsmtPub/english/propertydetails/details.aspx'
    + `?pgLang=EN&isRealtySearch=true&RollNumber=${encodeURIComponent(roll)}`;
}
function rollDetailLink(roll, title) {
  const url = rollAssessmentUrl(roll);
  const txt = escapeHtml(String(roll));
  return url
    ? `<a href="${url}" target="_blank" rel="noreferrer" title="${escapeHtml(title)}">${txt}</a>`
    : txt;
}

const fmtSqftHist = (v) => (Number.isFinite(Number(v))
  ? Math.round(Number(v)).toLocaleString('en-US') + ' sq ft' : '—');

function sizeChangeHtml(p) {
  const band = p._sizeBand;
  if (!band || band === 'same' || band === 'unknown') return '';
  const color = band === 'major' ? '#dc2626' : band === 'minor' ? '#ea580c' : '#6b7280';
  let body;
  if (band === 'gone') {
    body = 'roll not present in current data (removed / merged away)';
  } else {
    const d = Number(p._deltaPct);
    const sign = d > 0 ? '+' : '';
    body = `${fmtSqftHist(p._histArea)} → ${fmtSqftHist(p._curArea)} `
      + `(<strong>${sign}${Number.isFinite(d) ? d.toFixed(0) : '?'}%</strong>)`;
  }
  return `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px">`
    + `<strong style="color:${color}">Size change</strong> ${body}`
    + `<br><small style="color:#888">Could be subdivision/consolidation, re-survey, or a simplification artifact — verify against the registered plan / title.</small></div>`;
}

// Lineage block. recMap is historicalLineage (by roll) or historicalSurveyLineage
// (by id); keyField is the JSON field on predecessor/successor entries ('roll'
// or 'id'); linkSucc links successors to the current assessment page (only
// meaningful for assessment rolls).
function lineageHtml(recMap, key, keyField, linkSucc) {
  const rec = (recMap && key) ? recMap[key] : null;
  if (!rec) return '';
  const list = (arr, max = 6, linked = false) => {
    if (!arr?.length) return '';
    const items = arr.slice(0, max).map((x) => {
      const v = String(x[keyField] ?? '');
      return linked ? rollDetailLink(v, `Open ${v} on winnipegassessment.com`) : escapeHtml(v);
    }).join(', ');
    return items + (arr.length > max ? ` <span style="color:#888">+${arr.length - max} more</span>` : '');
  };
  const conf = rec.confidence != null ? ` · conf ${escapeHtml(String(rec.confidence))}` : '';
  const rows = [];
  if (rec.predecessors?.length) rows.push(`<strong style="color:#888">← from</strong> ${list(rec.predecessors)}`);
  if (rec.successors?.length)   rows.push(`<strong style="color:#0d9488">→ became</strong> ${list(rec.successors, 6, linkSucc)}`);
  if (!rows.length) return '';
  return `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px">`
    + `<strong style="color:#b45309">Lineage</strong> <span style="color:#888">(${escapeHtml(rec.type || '')}${conf})</span><br>`
    + rows.join('<br>')
    + `<br><small style="color:#888">Inferred from geometry overlap — verify against the registered plan / title.</small></div>`;
}

function historicalParcelHtml(p, snap) {
  const lines = [`<strong style="color:#b45309">Historical parcel${snap ? ` (${escapeHtml(snap)})` : ''}</strong>`];
  const roll = p.roll_number;
  if (roll != null && roll !== '') {
    const url = rollAssessmentUrl(roll);
    lines.push(`<strong>Roll #</strong> ` + (url
      ? `<a href="${url}" target="_blank" rel="noreferrer" title="Open Roll ${escapeHtml(String(roll))} on the City assessment site">${escapeHtml(String(roll))}</a>`
      : escapeHtml(String(roll))));
  }
  if (p.full_address)         lines.push(escapeHtml(p.full_address));
  if (p.neighbourhood_area)   lines.push(`<em>${escapeHtml(p.neighbourhood_area)}</em>`);
  if (p.zoning)               lines.push(`<strong>Zoning</strong> ${escapeHtml(p.zoning)}`);
  if (p.assessed_land_area)   lines.push(`<strong>Land area</strong> ${fmtSqftHist(p.assessed_land_area)}`);
  if (p.total_assessed_value) lines.push(`<strong>Assessed</strong> $${escapeHtml(Number(p.total_assessed_value).toLocaleString('en-US'))}`);
  lines.push('<small style="color:#888">Display geometry simplified — verify boundary/area against the registered plan / title.</small>');
  return `<div class="parcel-popup">${lines.join('<br>')}${sizeChangeHtml(p)}${lineageHtml(historicalLineage, roll || '', 'roll', true)}</div>`;
}

function historicalSurveyHtml(p, snap) {
  const lines = [`<strong style="color:#7c3aed">Historical survey lot${snap ? ` (${escapeHtml(snap)})` : ''}</strong>`];
  const legal = [
    p.lot   ? `Lot ${escapeHtml(p.lot)}`     : '',
    p.block ? `Block ${escapeHtml(p.block)}` : '',
    p.plan  ? `Plan ${escapeHtml(p.plan)}`   : '',
  ].filter(Boolean).join(', ');
  if (legal)         lines.push(`<strong>${legal}</strong>`);
  if (p.description) lines.push(escapeHtml(p.description));
  lines.push('<small style="color:#888">Display geometry simplified — verify against the registered plan of survey / title.</small>');
  return `<div class="parcel-popup">${lines.join('<br>')}${lineageHtml(historicalSurveyLineage, String(p.survey_id ?? ''), 'survey_id', false)}</div>`;
}
