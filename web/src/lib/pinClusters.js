// Locator pins for a result of one or more parcels: one pin per cluster of
// parcels that sit together, so a two-lot subject at city zoom shows one red
// pin rather than two specks of yellow. Ported from the Manitoba app's
// lib/pinClusters.js (2026-11-25). Parcels whose bounding boxes come within
// `gapM` metres of each other share a pin; the pin stands at the middle of
// the cluster's combined box.

/** Default join distance. Wide enough to bridge a street between two lots
 *  of one property, narrow enough that comps across town keep their own
 *  pins. (Manitoba uses 250 m for road allowances; city blocks are tighter.) */
export const PIN_CLUSTER_GAP_M = 100;

const M_PER_DEG_LAT = 111320;

/** [minX, minY, maxX, maxY] of a GeoJSON geometry, or null. */
export function geometryBbox(geometry) {
  if (!geometry) return null;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c?.[0] === 'number') {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]);
        box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]);
      }
    } else if (Array.isArray(c)) {
      for (const x of c) walk(x);
    }
  };
  if (geometry.type === 'GeometryCollection') for (const g of geometry.geometries || []) walk(g?.coordinates);
  else walk(geometry.coordinates);
  return box.every(Number.isFinite) ? box : null;
}

/** Gap in metres between two [minX, minY, maxX, maxY] boxes (0 if they touch). */
function boxGapM(a, b) {
  const lat = ((a[1] + a[3] + b[1] + b[3]) / 4) * (Math.PI / 180);
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]) * M_PER_DEG_LAT * Math.cos(lat);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * Cluster `features` (GeoJSON) into pin points: [{ lng, lat, count }], one
 * per group. Features without usable geometry are skipped; an empty input
 * gives [].
 */
export function clusterPinPoints(features, { gapM = PIN_CLUSTER_GAP_M } = {}) {
  const boxes = (features || []).map((f) => geometryBbox(f?.geometry)).filter(Boolean);
  const n = boxes.length;
  const parent = boxes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (boxGapM(boxes[i], boxes[j]) <= gapM) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    const b = boxes[i];
    if (!g) groups.set(r, { box: [...b], count: 1 });
    else {
      g.box = [Math.min(g.box[0], b[0]), Math.min(g.box[1], b[1]), Math.max(g.box[2], b[2]), Math.max(g.box[3], b[3])];
      g.count += 1;
    }
  }
  return [...groups.values()].map(({ box, count }) => ({
    lng: (box[0] + box[2]) / 2, lat: (box[1] + box[3]) / 2, count,
  }));
}
