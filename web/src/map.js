// MapLibre GL JS map setup with a free CartoDB Positron basemap.
// No API key required.
//
// One GeoJSON source (`parcel-results`) is used for both search flows:
//   - Legal-description search pushes Survey Parcels geometry into it
//   - Roll-number search pushes Assessment Parcels geometry into it
// The hover popup figures out which schema the feature is carrying.

import maplibregl from 'maplibre-gl';
import bbox from '@turf/bbox';

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
  },
  layers: [
    {
      id: 'carto-positron',
      type: 'raster',
      source: 'carto-positron',
      minzoom: 0,
      maxzoom: 20,
    },
    {
      id: 'esri-imagery',
      type: 'raster',
      source: 'esri-imagery',
      minzoom: 0,
      maxzoom: 20,
      layout: { visibility: 'none' },
    },
  ],
};

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
          'fill-outline-color': '#666',
        },
      });
      map.addLayer({
        id: 'zoning-line',
        type: 'line',
        source: 'zoning',
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#444',
          'line-width': 0.6,
          'line-opacity': 0.6,
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
          'text-size': 11,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
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
      map.addLayer({
        id: 'assess-context-fill',
        type: 'fill',
        source: 'assess-context',
        paint: {
          'fill-color': '#b22222',
          'fill-opacity': 0.22,
        },
      });
      map.addLayer({
        id: 'assess-context-line',
        type: 'line',
        source: 'assess-context',
        paint: {
          'line-color': '#690000',
          'line-width': 3,
          'line-opacity': 0.95,
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
          'text-size': 10,
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
          'text-color': '#003322',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.6,
        },
      });

      // Civic-address labels — every official address point inside a
      // result parcel, rendered as just the street number ("440",
      // "400 1/2") at the address's coordinates. Layered on top of
      // every other map layer so labels read clearly. minzoom keeps
      // them out of the city-wide view where they'd be noise; at
      // zoom ≥ 16 they're typically meaningful.
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
          'text-field': ['coalesce', ['get', 'street_num'], ['get', 'full_address'], ''],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-anchor': 'center',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
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
        if (!primaryHits.length && !contextHits.length) {
          popup.remove();
          map.getCanvas().style.cursor = '';
          return;
        }
        map.getCanvas().style.cursor = 'pointer';
        popup
          .setLngLat(e.lngLat)
          .setHTML(combinedPopupHtml(primaryHits[0]?.properties, contextHits[0]?.properties))
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

/** Push data into the named OurWinnipeg overlay source. */
export function setOverlayData(map, sourceId, fc) {
  const src = map.getSource(sourceId);
  if (src) src.setData(fc);
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
function combinedPopupHtml(primary, context) {
  const blocks = [];
  // Determine which schema `primary` is carrying.
  const primaryIsAssess = primary && (primary.roll_number != null || primary.full_address != null);
  const primaryIsSurvey = primary && !primaryIsAssess;

  if (primaryIsSurvey) {
    blocks.push(`<div><strong style="color:#0b2566">Survey Parcel</strong><br>${popupHtml(primary)}</div>`);
  }
  if (primaryIsAssess) {
    blocks.push(`<div><strong style="color:#690000">Assessment Parcel</strong><br>${popupHtml(primary)}</div>`);
  }
  // The context layer is always assessment-side. Only show separately
  // from primary to avoid duplicating the same parcel.
  if (context && (!primaryIsAssess || context.roll_number !== primary?.roll_number)) {
    blocks.push(`<div><strong style="color:#690000">Assessment Parcel</strong><br>${popupHtml(context)}</div>`);
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
    if (p.zoning) lines.push(`<em>${escapeHtml(p.zoning)}</em>`);
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
    this._btn.title = 'Toggle satellite basemap';
    this._btn.setAttribute('aria-label', 'Toggle satellite basemap');
    this._btn.textContent = 'Satellite';
    this._btn.addEventListener('click', () => this._toggle());
    this._container.appendChild(this._btn);
    return this._container;
  }
  _toggle() {
    const map = this._map;
    const imageryVisible = map.getLayoutProperty('esri-imagery', 'visibility') === 'visible';
    const next = !imageryVisible;
    map.setLayoutProperty('esri-imagery',   'visibility', next ? 'visible' : 'none');
    map.setLayoutProperty('carto-positron', 'visibility', next ? 'none' : 'visible');
    this._btn.textContent = next ? 'Streets' : 'Satellite';
    this._btn.classList.toggle('active', next);
  }
  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}
