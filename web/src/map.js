// MapLibre GL JS map setup with a free OpenFreeMap Positron basemap.
// No API key required.

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

export function initMap(container) {
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
      map.addSource('survey-results', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'survey-fill',
        type: 'fill',
        source: 'survey-results',
        paint: {
          'fill-color': '#4682b4',
          'fill-opacity': 0.4,
        },
      });
      map.addLayer({
        id: 'survey-line',
        type: 'line',
        source: 'survey-results',
        paint: {
          'line-color': '#0b2566',
          'line-width': 2,
        },
      });

      // Hover popup — mirrors the Shiny app's label with lot/block/plan.
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      map.on('mousemove', 'survey-fill', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        const html = `<strong>Lot</strong> ${p.lot ?? ''}
          &nbsp;<strong>Block</strong> ${p.block ?? ''}
          &nbsp;<strong>Plan</strong> ${p.plan ?? ''}
          ${p.description ? `<br>${p.description}` : ''}`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on('mouseleave', 'survey-fill', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });

      resolve();
    });
  });

  return { map, ready };
}

/**
 * Replace the map's highlighted parcels with the given FeatureCollection
 * and fit the viewport to them. If the FC is empty, reset to Winnipeg.
 */
export function showResults(map, fc) {
  map.getSource('survey-results').setData(fc);
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
