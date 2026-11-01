/*
 * The charts page's map card (2026-11-01): one MapLibre map of the charted
 * sales on the site's own Protomaps streets basemap, with an optional fitted
 * surface under the dots -- the ADF Overview page's price and year maps, and
 * its isovalue / location-effect maps.
 *
 * Kept apart from src/map.js on purpose: that module is the whole app's map
 * (overlays, drawing, history tiles) and would drag all of it into this page.
 * The basemap layers are built the same way, so the two read as one product.
 *
 * ONE map per card for the page's lifetime: the page re-renders on every
 * message from the main window, and a WebGL map rebuilt each time would
 * flash and leak contexts. setData() / setSurface() swap the GeoJSON.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';

maplibregl.addProtocol('pmtiles', new Protocol().tile);

const BASEMAP_PMTILES_URL =
  (() => { try { return import.meta.env.VITE_BASEMAP_PMTILES_URL; } catch { return undefined; } })()
  || 'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev/basemap-manitoba.pmtiles';

// As src/map.js: ids prefixed, and "Noto Sans Medium" mapped to the one
// stack the glyph server has, or every label using it silently vanishes.
const STREETS = protomapsLayers('protomaps', namedFlavor('light'), { lang: 'en' })
  .map((layer) => ({
    ...JSON.parse(JSON.stringify(layer).replaceAll('"Noto Sans Medium"', '"Open Sans Semibold"')),
    id: `pm-${layer.id}`,
  }));

const STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sprite: `${window.location.origin}/basemap-sprites/light`,
  sources: {
    protomaps: {
      type: 'vector',
      url: `pmtiles://${BASEMAP_PMTILES_URL}`,
      attribution: '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: STREETS,
};

const EMPTY = { type: 'FeatureCollection', features: [] };

/** The surface bands' opacity: the land template's PNG value. */
export const SURFACE_OPACITY = 0.55;

/**
 * @returns {{figure, setHeader, setNote, setLegend, setData, setSurface, resize}}
 *   setData({fc, small}) -- points with a `color` property; `small` draws them
 *   as the pale grey dots a surface map wants, so the bands stay readable.
 */
export function createChartMap() {
  const figure = document.createElement('section');
  figure.className = 'chart-card map-card';
  const h = document.createElement('h2');
  const box = document.createElement('div');
  box.className = 'chart-map';
  const legend = document.createElement('ul');
  legend.className = 'map-legend-list';
  const note = document.createElement('p');
  note.className = 'chart-note';
  figure.append(h, box, legend, note);

  const map = new maplibregl.Map({
    container: box,
    style: STYLE,
    center: [-97.14, 49.89],
    zoom: 10,
    attributionControl: { compact: true },
    preserveDrawingBuffer: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let ready = false;
  let pending = null;
  let pendingSurface;
  let lastFit = null;
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, maxWidth: '260px' });

  map.on('load', () => {
    ready = true;
    map.addSource('surface', { type: 'geojson', data: EMPTY });
    map.addSource('surface-edges', { type: 'geojson', data: EMPTY });
    map.addSource('sales', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'surface-fill', type: 'fill', source: 'surface',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': SURFACE_OPACITY, 'fill-antialias': false },
    });
    map.addLayer({
      id: 'surface-line', type: 'line', source: 'surface-edges',
      paint: { 'line-color': '#222222', 'line-width': 0.6, 'line-opacity': 0.55 },
    });
    map.addLayer({
      id: 'sales', type: 'circle', source: 'sales',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['get', 'small'], 1.8, 3.5], 14, ['case', ['get', 'small'], 3.5, 7]],
        'circle-color': ['case', ['get', 'small'], '#7a7a7a', ['coalesce', ['get', 'color'], '#2f6f6a']],
        'circle-opacity': ['case', ['get', 'small'], 0.55, 0.85],
        'circle-stroke-color': '#404040',
        'circle-stroke-width': ['case', ['get', 'small'], 0, 0.6],
      },
    });
    map.on('mousemove', 'sales', (e) => {
      const t = e.features?.[0]?.properties?.tip;
      if (!t) return;
      map.getCanvas().style.cursor = 'pointer';
      popup.setLngLat(e.lngLat).setText(t).addTo(map);
    });
    map.on('mouseleave', 'sales', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
    if (pending) { apply(pending); pending = null; }
    if (pendingSurface !== undefined) { applySurface(pendingSurface); pendingSurface = undefined; }
  });

  function applySurface(sf) {
    map.getSource('surface').setData(sf?.fills || EMPTY);
    map.getSource('surface-edges').setData(sf?.lines || EMPTY);
  }

  let lastData = null;
  function apply({ fc, fitKey }) {
    lastData = { fc, fitKey };
    map.getSource('sales').setData(fc);
    // Refit only when the set of sales changed, never on a recolour: a map
    // that jumps back while you are panning is unusable.
    if (fitKey !== lastFit && fc.features.length) {
      lastFit = fitKey;
      const b = new maplibregl.LngLatBounds();
      for (const f of fc.features) b.extend(f.geometry.coordinates);
      if (box.clientWidth > 0) map.fitBounds(b, { padding: 30, maxZoom: 15, duration: 0 });
      else lastFit = null;
    }
  }

  return {
    figure,
    setHeader(title) { h.textContent = title; },
    setNote(text) { note.textContent = text || ''; },
    setLegend(items) {
      legend.textContent = '';
      for (const it of items || []) {
        const li = document.createElement('li');
        const sw = document.createElement('span');
        sw.className = 'map-legend-swatch';
        sw.style.background = it.color;
        li.append(sw, document.createTextNode(it.label));
        legend.appendChild(li);
      }
    },
    setData(d) { if (ready) apply(d); else pending = d; },
    setSurface(sf) { if (ready) applySurface(sf); else pendingSurface = sf || null; },
    resize() {
      map.resize();
      // A map first filled while its tab was hidden had no size to fit to.
      if (lastFit == null && ready && lastData) apply(lastData);
    },
    map,
  };
}

/** Keep two maps on one view: pan or zoom either and the other follows. */
export function linkMaps(a, b) {
  let lock = false;
  const follow = (src, dst) => src.map.on('move', () => {
    if (lock) return;
    lock = true;
    dst.map.jumpTo({ center: src.map.getCenter(), zoom: src.map.getZoom() });
    lock = false;
  });
  follow(a, b);
  follow(b, a);
}
