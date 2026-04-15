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

// Inline style using CartoDB Positron raster tiles. No external style.json
// to fetch, no vector glyphs/sprites/hillshade sources to resolve — just a
// single raster layer. This avoids flakiness with hosted vector styles.
const BASEMAP_STYLE = {
  version: 8,
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

  // Expose for debugging in the dev console.
  if (import.meta.env.DEV) {
    window._map = map;
  }

  map.on('error', (e) => {
    console.error('[map error]', e?.error?.message || e, e);
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  const ready = new Promise((resolve) => {
    map.on('load', () => {
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
    map.flyTo({ center: WINNIPEG_CENTER, zoom: 11 });
    return;
  }
  const [minX, minY, maxX, maxY] = bbox(fc);
  map.fitBounds(
    [[minX, minY], [maxX, maxY]],
    { padding: 60, maxZoom: 18, duration: 800 }
  );
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
