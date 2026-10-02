// Parcel-edge dimension labels for the Dimensions overlay.
//
// Labels come from the survey (legal) lots of the result set, merged per
// property: lots that make up one assessment parcel lose the lot lines
// between them, and the straight runs of their outline are added up — 588
// Sargent is two 31 ft lots, labelled 62 ft x 99 ft rather than 31 / 31 /
// 99 / 99 / 99. The line between two DIFFERENT properties stays (labelled
// once), since that is one property's width.
//
// Pure: no map, no DOM. main.js decides which lots belong together and
// passes one group key per lot.

const MIN_FT = 5;            // shorter edges are digitisation waypoints, not sides
const STRAIGHT_DEG = 3;      // pieces this close to straight count as one side
const ON_EDGE_FT = 0.5;      // a corner this close to another lot's side lies on it

/** Canonical key for an undirected edge between two [lon, lat] points.
 *  Rounding to 6 dp (~10 cm) collapses near-identical endpoints from
 *  digitization noise; sorting ensures [a,b] and [b,a] produce the
 *  same key. */
export function canonicalEdgeKey(a, b) {
  const aStr = vertexKey(a);
  const bStr = vertexKey(b);
  return aStr < bStr ? `${aStr}|${bStr}` : `${bStr}|${aStr}`;
}

const vertexKey = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

/** Haversine great-circle distance between two [lon, lat] points,
 *  returned in feet. Cheap inline implementation; avoids a turf dep. */
export function haversineFt(a, b) {
  const R_M = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const x = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R_M * c * 3.28084;
}

function outerRings(geom) {
  if (geom?.type === 'Polygon') return [geom.coordinates[0]];
  if (geom?.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  return [];
}

/** Unit direction of p -> q in a local flat frame (longitude scaled by
 *  cos(latitude)), so angles compare correctly at Winnipeg's latitude. */
function direction(p, q) {
  const k = Math.cos(((p[1] + q[1]) / 2) * Math.PI / 180);
  const dx = (q[0] - p[0]) * k;
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * The outline of one property: its lots' edges, minus every edge two of
 * its lots share, with straight runs joined. Returns
 * [{ coords: [[lon, lat], ...], ft }] — one per side.
 */
function propertySides(lots) {
  const raw = [];
  for (const f of lots) {
    for (const ring of outerRings(f.geometry)) {
      for (let i = 0; i < ring.length - 1; i++) {
        if (vertexKey(ring[i]) !== vertexKey(ring[i + 1])) raw.push([ring[i], ring[i + 1]]);
      }
    }
  }
  // Split each edge at any other lot's corner lying on it. Where a lot's
  // side is only part of its neighbour's (one lot deeper than the next),
  // the shared stretch then becomes an identical edge on both lots.
  const corners = new Map();
  for (const [a, b] of raw) { corners.set(vertexKey(a), a); corners.set(vertexKey(b), b); }
  const cornerList = [...corners.values()];
  const kx = Math.cos((cornerList[0]?.[1] ?? 50) * Math.PI / 180) * 364000;   // ft per degree lon
  const ky = 364000;                                                          // ft per degree lat
  const edges = new Map();   // canonical key -> { a, b, count }
  for (const [a, b] of raw) {
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    const len2 = dx * dx + dy * dy;
    const cuts = [];
    for (const c of cornerList) {
      const cx = (c[0] - a[0]) * kx;
      const cy = (c[1] - a[1]) * ky;
      const t = (cx * dx + cy * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      if (Math.abs(cx * dy - cy * dx) / Math.sqrt(len2) > ON_EDGE_FT) continue;
      const k = vertexKey(c);
      if (k === vertexKey(a) || k === vertexKey(b)) continue;
      cuts.push([t, c]);
    }
    cuts.sort((u, v) => u[0] - v[0]);
    const pts = [a, ...cuts.map((u) => u[1]), b];
    for (let i = 0; i < pts.length - 1; i++) {
      const key = canonicalEdgeKey(pts[i], pts[i + 1]);
      const e = edges.get(key);
      if (e) e.count++;
      else edges.set(key, { a: pts[i], b: pts[i + 1], count: 1 });
    }
  }
  // Outline = edges only one lot of this property has.
  const outline = [...edges.values()].filter((e) => e.count === 1);

  // Join two outline edges through a vertex only when exactly those two
  // meet there and they continue in a straight line.
  const atVertex = new Map();
  for (const e of outline) {
    for (const p of [e.a, e.b]) {
      const k = vertexKey(p);
      if (!atVertex.has(k)) atVertex.set(k, []);
      atVertex.get(k).push(e);
    }
  }
  const joinsThrough = (k) => {
    const meet = atVertex.get(k);
    if (meet.length !== 2) return null;
    const [e1, e2] = meet;
    const far1 = vertexKey(e1.a) === k ? e1.b : e1.a;
    const far2 = vertexKey(e2.a) === k ? e2.b : e2.a;
    const here = vertexKey(e1.a) === k ? e1.a : e1.b;
    const d1 = direction(here, far1);
    const d2 = direction(here, far2);
    // Straight through = the two directions away from the vertex point
    // opposite ways (dot product near -1).
    return d1[0] * d2[0] + d1[1] * d2[1] < -Math.cos(STRAIGHT_DEG * Math.PI / 180) ? meet : null;
  };

  const used = new Set();
  const sides = [];
  for (const start of outline) {
    if (used.has(start)) continue;
    used.add(start);
    // Grow the run both ways from `start`.
    let coords = [start.a, start.b];
    let ft = haversineFt(start.a, start.b);
    for (const end of ['tail', 'head']) {
      for (;;) {
        const tip = end === 'tail' ? coords[coords.length - 1] : coords[0];
        const meet = joinsThrough(vertexKey(tip));
        const next = meet && meet.find((e) => !used.has(e));
        if (!next) break;
        used.add(next);
        const far = vertexKey(next.a) === vertexKey(tip) ? next.b : next.a;
        ft += haversineFt(tip, far);
        if (end === 'tail') coords.push(far);
        else coords = [far, ...coords];
      }
    }
    sides.push({ coords, ft });
  }
  return sides;
}

/** "62.8 ft", "99 ft", "120 ft", "1,240 ft" — one decimal under 100 ft
 *  (dropped when it is .0), whole feet from 100 ft up. */
export function formatFeet(ft) {
  return `${ft.toLocaleString('en-US', { maximumFractionDigits: ft >= 100 ? 0 : 1 })} ft`;
}

/**
 * Where a side's label goes: the point halfway along it (by length) and the
 * rotation, in degrees clockwise, that lays the text along the side there,
 * kept within [-90, 90] so it never reads upside down.
 */
export function sideLabelAnchor(coords) {
  const k = Math.cos((coords[0][1] * Math.PI) / 180);
  const xy = coords.map((c) => [c[0] * k, c[1]]);
  const seg = (i) => Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  let half = 0;
  for (let i = 1; i < xy.length; i++) half += seg(i);
  half /= 2;
  for (let i = 1; i < xy.length; i++) {
    const len = seg(i);
    if (len >= half || i === xy.length - 1) {
      const t = len > 0 ? Math.min(1, half / len) : 0;
      const a = coords[i - 1], b = coords[i];
      // Bearing clockwise from north; horizontal text runs east (90 deg).
      const bearing = (Math.atan2(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]) * 180) / Math.PI;
      let rot = bearing - 90;
      while (rot > 90) rot -= 180;
      while (rot < -90) rot += 180;
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rot: Math.round(rot * 10) / 10 };
    }
    half -= len;
  }
  return null;
}

/**
 * One Point per property side in `surveyFc`, at the middle of the side,
 * with `length_label` pre-formatted ("62.8 ft", "1,240 ft") and `rot`, the
 * text rotation that lays the label along the side.
 *
 * Points, not the sides' LineStrings: a GeoJSON source cuts lines at tile
 * boundaries, and `line-center` placement then labels EACH piece, so a side
 * crossing a tile edge showed its length twice. A point is never cut. `groupOf(feature, index)` returns
 * the property a lot belongs to; lots with the same key merge. Sides
 * shorter than 5 ft are skipped, and a side two properties share (same
 * end points) is labelled once.
 */
export function buildDimensionLabels(surveyFc, groupOf = (f, i) => i) {
  const features = [];
  if (!surveyFc?.features?.length) return { type: 'FeatureCollection', features };
  const groups = new Map();
  surveyFc.features.forEach((f, i) => {
    if (!f?.geometry) return;
    const k = groupOf(f, i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  });
  const seen = new Set();
  for (const lots of groups.values()) {
    let sides;
    try {
      sides = propertySides(lots);
    } catch {
      continue;   // a malformed lot; the other properties still label
    }
    for (const { coords, ft } of sides) {
      if (ft < MIN_FT) continue;
      const key = canonicalEdgeKey(coords[0], coords[coords.length - 1]);
      if (seen.has(key)) continue;
      seen.add(key);
      const anchor = sideLabelAnchor(coords);
      if (!anchor) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: anchor.point },
        properties: { length_label: formatFeet(ft), rot: anchor.rot },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
