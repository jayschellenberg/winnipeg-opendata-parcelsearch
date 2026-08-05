/*
 * Area-selection drawing — the map-facing half of the shape filter
 * (pure predicates: lib/shapeFilter.js). Hand-rolled on plain map
 * events rather than mapbox-gl-draw because the Measure control owns
 * the page's MapboxDraw instance (its modes, styles and deleteAll
 * lifecycle); sharing it would couple two unrelated features and the
 * measure tool has already broken once on a neighbouring control's
 * z-index/listener change.
 *
 * Ported from mb-parcelsearch web/src/drawShapes.js — see
 * docs/WINNIPEG-PORT-WATER-AND-SHAPES.md there for the design history
 * behind each gotcha noted below.
 *
 * Three tools, Matrix-MLS conventions, one shared state machine:
 *   Radius    — click the centre, move, click again to set the radius.
 *   Rectangle — click one corner, move, click the opposite corner.
 *   Polygon   — click vertices; double-click or click the first
 *               vertex again to close; needs 3+.
 * Esc cancels an in-progress shape and disarms the tool. A committed
 * shape starts as INCLUDE (green); clicking it toggles to EXCLUDE
 * (red) and back. The eraser clears every shape.
 *
 * The toolbar lives in the TOPBAR (next to Hide map / Expand map —
 * static markup in index.html, wired by initShapeDraw). Shapes narrow
 * whatever the results table currently holds, in both property-search
 * and sales mode, via main.js's refilterByShapes.
 */

import {
  circleRing,
  rectRing,
  shapesToFc,
  formatKm,
  haversineKm,
} from './lib/shapeFilter.js';

let shapes = [];
let nextId = 1;
let mapRef = null;
let armed = null;      // 'circle' | 'rectangle' | 'polygon' | null
let pending = null;    // in-progress tool state (see each handler)
let controlRef = null; // the toolbar, for button active-state sync
const changeCbs = new Set();

/** Current committed shapes — read by main.js's refilter predicate. */
export function getShapes() {
  return shapes;
}

/** True while a draw tool is armed. Map hover/click handlers stand
 *  down off this so a tooltip never sits on the point being aimed at. */
export function isShapeDrawing() {
  return armed != null;
}

/** Register for shape-set changes (commit, mode toggle, clear). */
export function onShapesChanged(cb) {
  changeCbs.add(cb);
}

function emit() {
  for (const cb of changeCbs) {
    try { cb(shapes); } catch (err) { console.warn('shape change listener failed', err); }
  }
}

export function clearShapes() {
  if (shapes.length === 0 && !pending) return;
  shapes = [];
  cancelPending();
  render();
  emit();
}

/**
 * Drop every shape WITHOUT notifying listeners. For a fresh search,
 * which clears the shapes and repopulates the table itself — an emit
 * here would fire refilterByShapes against the outgoing result set.
 */
export function resetShapesSilently() {
  shapes = [];
  cancelPending();
  setArmed(null);
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/**
 * Sources + layers for committed shapes and the in-progress preview.
 * Called from map.js's setupLayers block AFTER every other overlay
 * (and after the moveLayer reordering) so the shapes draw on top of
 * parcels — they are a filter the user just drew and must never hide
 * under a fill.
 */
export function addShapeLayers(map) {
  map.addSource('shape-filter', { type: 'geojson', data: EMPTY_FC });
  map.addSource('shape-preview', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'shape-filter-fill',
    type: 'fill',
    source: 'shape-filter',
    filter: ['==', '$type', 'Polygon'],
    paint: {
      'fill-color': [
        'match', ['get', 'mode'],
        'exclude', '#c62828',
        '#2e7d32',
      ],
      'fill-opacity': 0.12,
    },
  });
  map.addLayer({
    id: 'shape-filter-line',
    type: 'line',
    source: 'shape-filter',
    filter: ['==', '$type', 'Polygon'],
    paint: {
      'line-color': [
        'match', ['get', 'mode'],
        'exclude', '#c62828',
        '#2e7d32',
      ],
      'line-width': 2,
    },
  });
  // Matrix-style centre dot — the obvious click target for flipping
  // Include/Exclude (the whole fill also toggles, but a dot says
  // "click me" the way a translucent wash never will).
  map.addLayer({
    id: 'shape-filter-dot',
    type: 'circle',
    source: 'shape-filter',
    filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': 7,
      'circle-color': '#fff',
      'circle-stroke-width': 2.5,
      'circle-stroke-color': [
        'match', ['get', 'mode'],
        'exclude', '#c62828',
        '#2e7d32',
      ],
    },
  });
  // Mode badge under the dot ("Include · 2.35 km" for circles, the
  // mode word otherwise). Point features, not polygon symbols — see
  // shapesToFc for the per-tile duplicate-label reason.
  map.addLayer({
    id: 'shape-filter-label',
    type: 'symbol',
    source: 'shape-filter',
    filter: ['==', '$type', 'Point'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Semibold'],
      'text-size': 12,
      'text-offset': [0, 1.0],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': [
        'match', ['get', 'mode'],
        'exclude', '#8b1c1c',
        '#1d5a22',
      ],
      'text-halo-color': '#fff',
      'text-halo-width': 1.5,
    },
  });
  map.addLayer({
    id: 'shape-preview-line',
    type: 'line',
    source: 'shape-preview',
    paint: {
      'line-color': '#ff4d00',
      'line-width': 2,
      'line-dasharray': [3, 2],
    },
  });
}

function render() {
  const src = mapRef?.getSource('shape-filter');
  if (src) src.setData(shapesToFc(shapes));
}

function renderPreview(ring) {
  const src = mapRef?.getSource('shape-preview');
  if (!src) return;
  src.setData(ring && ring.length >= 2
    ? {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: ring },
        }],
      }
    : EMPTY_FC);
}

// ---------------------------------------------------------------------------
// Click routing for committed shapes
// ---------------------------------------------------------------------------

// The DOM event of the last click a shape toggle consumed. The
// module's own general map click handler does the toggling (it fires
// for clicks anywhere, including shapes drawn over empty map — the
// original Manitoba wiring only toggled via the parcel click handlers,
// so a shape not covering a parcel could never be flipped). The layer
// popup handlers still ask shapeClickHandled() before opening a popup
// and recognise an already-consumed event by identity, so one click
// never both toggles and pops.
let consumedClickEvent = null;

function tryToggleAt(map, point) {
  const layers = ['shape-filter-dot', 'shape-filter-fill']
    .filter((id) => map.getLayer(id));
  if (layers.length === 0) return false;
  const feats = map.queryRenderedFeatures(point, { layers });
  if (feats.length === 0) return false;
  const id = feats[0].properties?.id;
  const s = shapes.find((x) => x.id === id);
  if (!s) return false;
  s.mode = s.mode === 'include' ? 'exclude' : 'include';
  render();
  emit();
  return true;
}

/**
 * Called by map.js's layer click handlers BEFORE opening a popup.
 * True when the click belongs to this feature: a tool is armed (every
 * click is placing geometry), the module's map handler already
 * consumed this exact event as a toggle, or — defensively, in case
 * handler registration order ever changes — a shape sits under the
 * click and gets toggled here.
 */
export function shapeClickHandled(map, e) {
  if (armed) return true;
  if (e?.originalEvent && e.originalEvent === consumedClickEvent) return true;
  if (tryToggleAt(map, e.point)) {
    consumedClickEvent = e?.originalEvent ?? null;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Draw state machine
// ---------------------------------------------------------------------------

function setArmed(tool) {
  cancelPending();
  armed = armed === tool ? null : tool;
  document.body.classList.toggle('shape-drawing', armed != null);
  if (mapRef) {
    mapRef.getCanvas().style.cursor = armed ? 'crosshair' : '';
    // Double-click closes a polygon; without this it also zooms.
    if (armed === 'polygon') mapRef.doubleClickZoom.disable();
    else mapRef.doubleClickZoom.enable();
  }
  controlRef?.syncActive();
}

// Live radius readout — a small DOM pill that rides beside the cursor
// while a circle is being sized, showing the current radius ("650 m" /
// "2.35 km"). DOM rather than a map symbol so it can hug the pointer
// without symbol-placement latency.
let radiusReadoutEl = null;

function showRadiusReadout(point, km) {
  if (!radiusReadoutEl) return;
  radiusReadoutEl.textContent = formatKm(km);
  radiusReadoutEl.style.transform = `translate(${point.x + 14}px, ${point.y + 14}px)`;
  radiusReadoutEl.hidden = false;
}

function hideRadiusReadout() {
  if (radiusReadoutEl) radiusReadoutEl.hidden = true;
}

function cancelPending() {
  pending = null;
  renderPreview(null);
  hideRadiusReadout();
}

function commit(shape) {
  shapes.push({ id: nextId++, mode: 'include', ...shape });
  cancelPending();
  setArmed(null);
  render();
  emit();
}

function onMapClick(e) {
  if (!armed) {
    // Not drawing: a click on a committed shape (dot or fill) flips
    // its Include/Exclude. Consume the event so the layer click
    // handlers — which fire after this one — skip their popups.
    if (tryToggleAt(mapRef, e.point)) consumedClickEvent = e.originalEvent ?? null;
    return;
  }
  const pt = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  if (armed === 'circle') {
    if (!pending) {
      pending = { center: pt };
    } else {
      const radiusKm = haversineKm(pending.center, pt);
      if (radiusKm > 0) commit({ kind: 'circle', center: pending.center, radiusKm });
    }
  } else if (armed === 'rectangle') {
    if (!pending) {
      pending = { corner: pt };
    } else if (pt.lng !== pending.corner.lng || pt.lat !== pending.corner.lat) {
      commit({ kind: 'rectangle', ring: rectRing(pending.corner, pt) });
    }
  } else if (armed === 'polygon') {
    if (!pending) pending = { verts: [] };
    // Clicking the first vertex again closes the ring (12 px snap).
    if (pending.verts.length >= 3) {
      const firstPx = mapRef.project([pending.verts[0][0], pending.verts[0][1]]);
      const dx = firstPx.x - e.point.x;
      const dy = firstPx.y - e.point.y;
      if ((dx * dx + dy * dy) <= 144) {
        commit({ kind: 'polygon', ring: [...pending.verts] });
        return;
      }
    }
    pending.verts.push([pt.lng, pt.lat]);
  }
}

function onMapDblClick(e) {
  if (armed !== 'polygon' || !pending) return;
  e.preventDefault();
  // The dblclick was preceded by two click events that each pushed the
  // same end vertex — drop the duplicate before closing.
  const verts = pending.verts.slice(0, -1);
  if (verts.length >= 3) commit({ kind: 'polygon', ring: verts });
  else cancelPending();
}

function onMapMove(e) {
  if (!armed || !pending) return;
  const pt = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  if (armed === 'circle' && pending.center) {
    const km = Math.max(haversineKm(pending.center, pt), 0.005);
    renderPreview(circleRing(pending.center, km));
    showRadiusReadout(e.point, km);
  } else if (armed === 'rectangle' && pending.corner) {
    renderPreview(rectRing(pending.corner, pt));
  } else if (armed === 'polygon' && pending.verts.length > 0) {
    renderPreview([...pending.verts, [pt.lng, pt.lat]]);
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape' && armed) setArmed(null);
}

// ---------------------------------------------------------------------------
// Toolbar wiring — the buttons live in the TOPBAR (next to Hide map /
// Expand map), not on the map: static markup in index.html, wired here.
// ---------------------------------------------------------------------------

const TOOL_BUTTONS = [
  ['circle',    'shape-tool-circle'],
  ['rectangle', 'shape-tool-rectangle'],
  ['polygon',   'shape-tool-polygon'],
];

const toolBtns = new Map();

function syncToolbar() {
  for (const [tool, b] of toolBtns) {
    b.classList.toggle('active', armed === tool);
    b.setAttribute('aria-pressed', String(armed === tool));
  }
}

/**
 * Bind the map events and the topbar buttons. Called once from map.js
 * right after the map is constructed — BEFORE setupLayers registers
 * the layer popup handlers, so this module's general click handler
 * runs first and can mark an event consumed (see shapeClickHandled).
 * The topbar markup is static, so the buttons exist by the time module
 * scripts run.
 */
export function initShapeDraw(map) {
  mapRef = map;
  controlRef = { syncActive: syncToolbar };
  for (const [tool, id] of TOOL_BUTTONS) {
    const b = document.getElementById(id);
    if (!b) continue;
    toolBtns.set(tool, b);
    b.addEventListener('click', () => setArmed(tool));
  }
  document.getElementById('shape-tool-clear')
    ?.addEventListener('click', () => clearShapes());
  radiusReadoutEl = document.createElement('div');
  radiusReadoutEl.className = 'shape-radius-readout';
  radiusReadoutEl.hidden = true;
  map.getContainer().appendChild(radiusReadoutEl);
  map.on('click', onMapClick);
  map.on('dblclick', onMapDblClick);
  map.on('mousemove', onMapMove);
  document.addEventListener('keydown', onKeyDown);
}
