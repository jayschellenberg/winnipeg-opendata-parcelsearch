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
const ZONING_PALETTE = [
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

// Inline style using CartoDB Positron raster tiles. No external style.json
// to fetch, no vector glyphs/sprites/hillshade sources to resolve — just a
// single raster layer. This avoids flakiness with hosted vector styles.
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
  },
  layers: [
    {
      id: 'carto-positron',
      type: 'raster',
      source: 'carto-positron',
      minzoom: 0,
      maxzoom: 20,
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

  const ready = new Promise((resolve) => {
    map.on('load', () => {
      // Zoning layer goes in first so it draws *under* the parcel highlight.
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
          'fill-color': '#ff8c42',
          'fill-opacity': 0.12,
        },
      });
      map.addLayer({
        id: 'assess-context-line',
        type: 'line',
        source: 'assess-context',
        paint: {
          'line-color': '#c4581c',
          'line-width': 1.5,
          'line-dasharray': [2, 2],
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
        paint: {
          'fill-color': '#4682b4',
          'fill-opacity': 0.4,
        },
      });
      map.addLayer({
        id: 'parcel-line',
        type: 'line',
        source: 'parcel-results',
        paint: {
          'line-color': '#0b2566',
          'line-width': 2,
        },
      });

      // Hover popup — labels depend on which dataset the feature came from.
      // Survey Parcels carry lot/block/plan/description; Assessment Parcels
      // carry roll_number/full_address/zoning. We detect which by looking
      // at the available properties.
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      map.on('mousemove', 'parcel-fill', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        popup
          .setLngLat(e.lngLat)
          .setHTML(popupHtml(e.features[0].properties))
          .addTo(map);
      });
      map.on('mouseleave', 'parcel-fill', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });

      // Click a parcel → let main.js scroll the results table to the
      // matching row. The clicked feature's `_rowKey` property is stamped
      // on by main.js before the FC is handed to showResults().
      if (onFeatureClick) {
        map.on('click', 'parcel-fill', (e) => {
          const key = e.features?.[0]?.properties?._rowKey;
          if (key != null) onFeatureClick(key);
        });
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
export function showResults(map, fc) {
  map.getSource('parcel-results').setData(fc);
  if (fc.features.length === 0) {
    setAssessContext(map, { type: 'FeatureCollection', features: [] });
    map.flyTo({ center: WINNIPEG_CENTER, zoom: 11 });
    return;
  }
  const [minX, minY, maxX, maxY] = bbox(fc);
  map.fitBounds(
    [[minX, minY], [maxX, maxY]],
    { padding: 60, maxZoom: 18, duration: 800 }
  );
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

// Render a hover-popup HTML block from whichever schema is present.
// Survey Parcels feature: has lot/block/plan/description.
// Assessment Parcels feature: has roll_number/full_address/zoning.
function popupHtml(p) {
  if (p.roll_number != null || p.full_address != null) {
    const lines = [];
    if (p.roll_number) lines.push(`<strong>Roll #</strong> ${escapeHtml(p.roll_number)}`);
    if (p.full_address) lines.push(escapeHtml(p.full_address));
    if (p.zoning) lines.push(`<em>${escapeHtml(p.zoning)}</em>`);
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
