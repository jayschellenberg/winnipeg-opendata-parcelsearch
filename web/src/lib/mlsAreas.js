// MLS Areas overlay — the real-estate boards' MLS area boundaries (Reference
// group, both apps; Jason, 2026-10-21).
//
// Data: public/mls-areas.geojson, built by tools/mls-areas/build_mls_areas.py
// (mb-parcelsearch) from Jason's appraisal-templates MLSAreas.geojson: 142
// areas — the Winnipeg Regional Real Estate Board's city (1A … 9A) and rural
// (R02 … R44) areas, Brandon Area REALTORS' A–D areas and Portage's P01–P07.
// The WRREB areas match the board's own digital map (map.keystonerealtors.ca)
// exactly as of 2026-10-21. Brandon and Portage are rebuilt on street
// centrelines (tools/mls-areas/rebuild_brandon_portage.py, 2026-10-23): the
// BAR city map for Brandon, the board's definitions for Portage. Polygons
// come largest first, so anything nested draws and hit-tests on top.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app (like phoneMode.js); each app wires the toggle and the
// click popup itself.

export const MLS_AREAS_URL = '/mls-areas.geojson';
export const MLS_SOURCE = 'mls-areas';
export const MLS_LABEL_SOURCE = 'mls-area-labels';
export const MLS_LAYERS = ['mls-area-fill', 'mls-area-line', 'mls-area-label'];

/** The boards' own red, as on the WRREB digital map. */
const RED = '#b91c1c';

const emptyFc = () => ({ type: 'FeatureCollection', features: [] });

/** One label point per area, at the spot the boards label it (lx/ly);
 *  areas without one are skipped. */
export function mlsLabelPoints(fc) {
  return {
    type: 'FeatureCollection',
    features: (fc?.features || [])
      .filter((f) => Number.isFinite(f?.properties?.lx) && Number.isFinite(f?.properties?.ly))
      .map((f) => ({
        type: 'Feature',
        properties: { area: f.properties.area },
        geometry: { type: 'Point', coordinates: [f.properties.lx, f.properties.ly] },
      })),
  };
}

/** Add the (empty, hidden) sources and layers. `beforeId` places the fill
 *  and outline under an existing layer, e.g. the parcels, so results stay on
 *  top; the labels go last so they are never covered. */
export function addMlsAreaLayers(map, { beforeId } = {}) {
  if (map.getSource(MLS_SOURCE)) return;
  map.addSource(MLS_SOURCE, { type: 'geojson', data: emptyFc() });
  map.addSource(MLS_LABEL_SOURCE, { type: 'geojson', data: emptyFc() });
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({
    id: 'mls-area-fill',
    type: 'fill',
    source: MLS_SOURCE,
    layout: { visibility: 'none' },
    paint: { 'fill-color': RED, 'fill-opacity': 0.06 },
  }, before);
  map.addLayer({
    id: 'mls-area-line',
    type: 'line',
    source: MLS_SOURCE,
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: {
      'line-color': RED,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 1.6, 14, 2.4],
      'line-opacity': 0.85,
    },
  }, before);
  map.addLayer({
    id: 'mls-area-label',
    type: 'symbol',
    source: MLS_LABEL_SOURCE,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'area'],
      'text-font': ['Open Sans Semibold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 10, 13, 14, 17],
      // Labels cull each other where the small city areas crowd at low zoom
      // (ignore-placement would let them overprint — see the roll-number
      // overlap fix), and come back as you zoom in.
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-padding': 2,
    },
    paint: { 'text-color': RED, 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
  });
}

export function setMlsAreasData(map, fc) {
  map.getSource(MLS_SOURCE)?.setData(fc);
  map.getSource(MLS_LABEL_SOURCE)?.setData(mlsLabelPoints(fc));
}

export function setMlsAreasVisible(map, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of MLS_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

let cached = null;
/** Fetch the areas once per page. */
export function fetchMlsAreas(fetchFn = globalThis.fetch, url = MLS_AREAS_URL) {
  if (!cached) {
    cached = fetchFn(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`MLS areas ${r.status}`))))
      .catch((err) => { cached = null; throw err; });
  }
  return cached;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Popup body for a clicked area. */
export function mlsAreaHtml(props) {
  return `<div style="max-width:240px;line-height:1.4"><strong>MLS Area ${esc(props?.area)}</strong>`
    + `<br><em>${esc(props?.board)}</em></div>`;
}
