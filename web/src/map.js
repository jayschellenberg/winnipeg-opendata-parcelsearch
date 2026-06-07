// MapLibre GL JS map setup with a free CartoDB Positron basemap.
// No API key required.
//
// One GeoJSON source (`parcel-results`) is used for both search flows:
//   - Legal-description search pushes Survey Parcels geometry into it
//   - Roll-number search pushes Assessment Parcels geometry into it
// The hover popup figures out which schema the feature is carrying.

import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import bbox from '@turf/bbox';
import turfArea from '@turf/area';
import turfLength from '@turf/length';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

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
    // Transparent reference overlays for the hybrid satellite view —
    // place names, road names, boundaries. Stacked on top of the
    // imagery when Satellite is the active basemap (via the
    // BasemapToggleControl); hidden when Streets is active so the
    // CARTO Positron tiles (which carry their own labels) read
    // clean. Same Esri ArcGIS Online raster service Manitoba uses.
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

export function initMap(container, { onFeatureClick } = {}) {
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
  map.addControl(new BasemapToggleControl(), 'top-right');
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

  const ready = new Promise((resolve) => {
    map.on('load', () => {
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
        paint: {
          // Slate-grey (Tailwind gray-500) so the muni-wide parcel
          // fabric reads as pure supporting context — visible
          // enough to trace lot boundaries when looking for it but
          // invisible enough that zoning + sale highlights paint
          // cleanly on top. Matches the Manitoba sister app's
          // muni-parcels-line exactly.
          //
          // Previous Winnipeg styling (kept here for a one-diff
          // revert if needed):
          //   'line-color': '#1d4ed8',   // Tailwind blue-700
          //   'line-width': 1.0,
          //   'line-opacity': 0.7,
          'line-color': '#6b7280',
          'line-width': 1.5,
          'line-opacity': 0.8,
        },
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
      map.addSource('assess-context', {
        type: 'geojson',
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
        paint: {
          'fill-color': '#ffea00',
          'fill-opacity': 0.3,
        },
      });
      map.addLayer({
        id: 'assess-context-line',
        type: 'line',
        source: 'assess-context',
        // Dashed outline so the highlight reads as a "selection"
        // rather than competing with solid parcel-fabric lines.
        // Manitoba uses [3, 2] (3-width dash, 2-width gap) at
        // 2.5 px stroke — match exactly.
        layout: {
          visibility: 'visible',
          'line-cap': 'butt',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#ffea00',
          'line-width': 2.5,
          'line-dasharray': [3, 2],
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
      map.on('mousemove', (e) => {
        if (!map.isStyleLoaded()) return;
        const primaryHits = map.getLayer('parcel-fill')
          ? map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] })
          : [];
        const contextHits = map.getLayer('assess-context-fill')
          ? map.queryRenderedFeatures(e.point, { layers: ['assess-context-fill'] })
          : [];
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
          const key = e.features?.[0]?.properties?._rowKey;
          if (key != null) onFeatureClick(key);
        };
        map.on('click', 'parcel-fill', handle);
        map.on('click', 'assess-context-fill', handle);
      }

      // Click a citywide-parcels polygon → sticky popup with the
      // roll #, address, an Assessment-page link, and a Coordinates
      // copy-to-clipboard action. Search-result clicks (parcel-fill
      // / assess-context-fill) take precedence — the citywide popup
      // is only for parcels NOT in the active search, since for
      // active-result parcels the row click + parcel-summary card
      // already handle the interaction.
      const citywideClickPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'citywide-parcels-fill', (e) => {
        if (map.getLayoutProperty('citywide-parcels-fill', 'visibility') !== 'visible') return;
        // Search-result layer takes precedence.
        const overSearchResult =
             (map.getLayer('parcel-fill')          && map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] }).length > 0)
          || (map.getLayer('assess-context-fill')  && map.queryRenderedFeatures(e.point, { layers: ['assess-context-fill'] }).length > 0);
        if (overSearchResult) return;
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

      // Click a contaminated-site circle → standalone popup with the
      // site name, address, status pill, and a link out to the
      // Manitoba registry page for that site.
      const contamPopup = new maplibregl.Popup({ closeButton: true });
      map.on('click', 'contam-circle', (e) => {
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
        const parcelHit = map.queryRenderedFeatures(e.point, { layers: ['parcel-fill'] });
        if (parcelHit.length > 0) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const short = p.route_short_name ? escapeHtml(p.route_short_name) : '';
        const long = p.route_long_name ? escapeHtml(p.route_long_name) : '';
        const swatch = p.route_color
          ? `<span style="display:inline-block;width:14px;height:14px;background:${escapeHtml(p.route_color)};border:1px solid #1f2937;border-radius:2px;vertical-align:middle;margin-right:6px"></span>`
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

      resolve();
    });
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
export function showResults(map, surveyFc, assessFc = { type: 'FeatureCollection', features: [] }) {
  map.getSource('parcel-results').setData(surveyFc);
  map.getSource('assess-context').setData(assessFc);
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
  if (src) src.setData(fc);
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
 * Replace the zoning layer's source data. Pass an empty FC to clear it.
 * Visibility is controlled separately by setZoningVisible() so callers can
 * preload data while the layer is still hidden.
 */
export function setZoningData(map, fc) {
  const src = map.getSource('zoning');
  if (src) src.setData(fc);
}

/**
 * Toggle the zoning fill+line layers on or off without touching the data.
 * Cheap to call repeatedly — MapLibre rerenders only the layout property.
 */
export function setZoningVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  if (map.getLayer('zoning-fill')) map.setLayoutProperty('zoning-fill', 'visibility', v);
  if (map.getLayer('zoning-line')) map.setLayoutProperty('zoning-line', 'visibility', v);
  if (map.getLayer('zoning-label')) map.setLayoutProperty('zoning-label', 'visibility', v);
}

/** Toggle the citywide-parcels vector overlay on/off. The PMTiles
 *  archive only fetches the tiles for the current viewport, so cost
 *  is bounded; turning the layer on instantly draws what's on screen.
 *  Promise-returning `probeCitywideParcels()` below lets the caller
 *  check whether the archive exists before flipping the toggle. */
export function setCitywideParcelsVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  if (map.getLayer('citywide-parcels-fill')) map.setLayoutProperty('citywide-parcels-fill', 'visibility', v);
  if (map.getLayer('citywide-parcels-line')) map.setLayoutProperty('citywide-parcels-line', 'visibility', v);
  if (map.getLayer('citywide-parcels-label')) map.setLayoutProperty('citywide-parcels-label', 'visibility', v);
}

/**
 * Resolve true/false based on whether the .pmtiles archive can be
 * fetched. Used by the toggle handler to surface a "tiles not built"
 * hint instead of silently doing nothing when the asset is missing.
 * One-time check (the result doesn't change at runtime); cached.
 */
let _citywideTilesAvailable = null;
export async function probeCitywideParcels() {
  if (_citywideTilesAvailable !== null) return _citywideTilesAvailable;
  try {
    const res = await fetch('/parcels.pmtiles', { method: 'HEAD' });
    _citywideTilesAvailable = res.ok;
  } catch {
    _citywideTilesAvailable = false;
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
 * roll, and a Coordinates link that copies the polygon's centroid
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
  const actions = [];
  if (roll) {
    const url = `https://assessment.winnipeg.ca/AsmtPub/english/propertydetails/details.aspx?pgLang=EN&isRealtySearch=true&RollNumber=${encodeURIComponent(roll)}`;
    actions.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Assessment →</a>`);
  }
  actions.push(`<a href="#" class="parcel-coords-copy" role="button" title="Copy parcel centroid (lat, lng) to clipboard">Coordinates</a>`);
  if (actions.length) {
    lines.push(actions.join(' &nbsp;·&nbsp; '));
  }
  return `<div style="max-width:280px;line-height:1.45;font-size:13px">${lines.join('<br>')}</div>`;
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
    // Parcel size: assessed_land_area is in square feet on d4mq-wa44.
    // Show SF (with thousands separator) and acres (SF / 43,560) for
    // appraisal sanity-checking at a glance.
    const sf = Number(p.assessed_land_area);
    if (Number.isFinite(sf) && sf > 0) {
      const sfFmt = Math.round(sf).toLocaleString('en-US');
      const ac = (sf / 43560).toFixed(2);
      lines.push(`<strong>Size</strong> ${sfFmt} sf (${ac} ac)`);
    }
    // Dwelling units: dwelling_units is text-typed; coerce defensively.
    // Show even when 0 because vacant lot is a meaningful state.
    if (p.dwelling_units != null && p.dwelling_units !== '') {
      const du = Number(p.dwelling_units);
      if (Number.isFinite(du)) {
        lines.push(`<strong>DU</strong> ${du}`);
      }
    }
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
    .replace(/"/g, '&quot;');
}

/**
 * Custom MapLibre control: a single button that flips the basemap between
 * CARTO Positron (streets) and Esri World Imagery (satellite). Sits in the
 * top-right gutter just under the zoom buttons. Stateless — reads the
 * current visibility off the layers each click so we don't have to track
 * a separate flag.
 */
class BasemapToggleControl {
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-toggle';
    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.title = 'Toggle basemap (streets ⇄ satellite)';
    this._btn.setAttribute('aria-label', 'Toggle basemap (streets ⇄ satellite)');
    this._btn.textContent = 'Satellite';
    this._btn.addEventListener('click', () => this._toggle());
    this._container.appendChild(this._btn);
    return this._container;
  }
  _toggle() {
    const map = this._map;
    const imageryVisible = map.getLayoutProperty('esri-imagery', 'visibility') === 'visible';
    const next = !imageryVisible;
    const satVis   = next ? 'visible' : 'none';
    const cartoVis = next ? 'none' : 'visible';
    map.setLayoutProperty('esri-imagery',        'visibility', satVis);
    // Hybrid: place names + road names follow the imagery so the
    // satellite view stays labelled (street names visible, place
    // names visible).
    map.setLayoutProperty('esri-transportation', 'visibility', satVis);
    map.setLayoutProperty('esri-reference',      'visibility', satVis);
    map.setLayoutProperty('carto-positron',      'visibility', cartoVis);
    this._btn.textContent = next ? 'Streets' : 'Satellite';
    this._btn.classList.toggle('active', next);
  }
  onRemove() {
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
