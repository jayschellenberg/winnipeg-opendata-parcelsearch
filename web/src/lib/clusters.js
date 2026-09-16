/*
 * Neighbourhood-cluster lookup for a parcel centroid.
 *
 * The City groups its 235 neighbourhoods into 23 clusters (Fort Garry
 * South, Transcona, Point Douglas North …). public/wpg-neighbourhoods
 * .geojson carries `name` + `cluster` on every polygon; this module
 * turns that into a point → cluster lookup.
 *
 * WHY GEOMETRY RATHER THAN THE NAME FIELD. The assessment records do
 * carry `neighbourhood_area`, and joining it to the geojson by name
 * looks tempting — but the field is truncated to 20 characters, so
 * "Leila-McPhillips Triangle" arrives as "LEILA-MCPHILLIPS TRI" and
 * "Central River Heights" as "CENTRAL RIVER HGTS". Measured against
 * the full assessment roll, a normalized name join matched 222 of 238
 * distinct values — 94.6% of parcels, leaving 13,143 unmatched, plus
 * whatever the City truncates differently next refresh. A centroid
 * point-in-polygon has none of that fragility, needs no per-name
 * corpus to maintain, and still answers for records whose
 * neighbourhood_area is blank or 'N/A'.
 *
 * Pure — no DOM, no network. main.js supplies the already-fetched
 * geojson (soda.js's fetchNeighbourhoods caches it, and the historical
 * overlay loads the same file, so this adds no download).
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

/**
 * Precompute a bbox per polygon. 235 polygons is small, but a full
 * point-in-polygon against every one of them for every row adds up
 * across a few hundred sales; the bbox rejects almost all of them with
 * four comparisons first.
 */
function bboxOf(geometry) {
  let minX = Infinity; let minY = Infinity;
  let maxX = -Infinity; let maxY = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
      return;
    }
    for (const part of c) walk(part);
  };
  walk(geometry?.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Build the lookup index from the neighbourhoods FeatureCollection.
 * Polygons without a cluster are skipped — they can only produce a
 * blank answer, and skipping them shrinks the scan.
 */
export function buildClusterIndex(geojson) {
  const entries = [];
  for (const f of geojson?.features || []) {
    const cluster = f?.properties?.cluster;
    if (!cluster || !f.geometry) continue;
    const bbox = bboxOf(f.geometry);
    if (!bbox) continue;
    entries.push({ cluster, name: f.properties.name || '', bbox, feature: f });
  }
  return entries;
}

/**
 * Cluster containing [lon, lat], or null when the point falls outside
 * every neighbourhood (city-edge parcels do exist — the historical
 * overlay has a whole UNASSIGNED shard for them) or can't be placed.
 */
export function clusterForPoint(index, lon, lat) {
  if (!Array.isArray(index) || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const pt = { type: 'Point', coordinates: [lon, lat] };
  for (const e of index) {
    const [minX, minY, maxX, maxY] = e.bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    try {
      if (booleanPointInPolygon(pt, e.feature)) return e.cluster;
    } catch { /* a malformed polygon shouldn't sink the whole lookup */ }
  }
  return null;
}

/**
 * Cluster for an assessment feature, read off its centroid_lat /
 * centroid_lon properties (present on every d4mq-wa44 record). Returns
 * null when the feature carries no usable centroid.
 */
export function clusterForFeature(index, feature) {
  const p = feature?.properties || {};
  const lat = Number(p.centroid_lat);
  const lon = Number(p.centroid_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return clusterForPoint(index, lon, lat);
}


/* ---------------------------------------------------------------------
 * NEAREST-cluster fallback, for a point that lands inside no polygon.
 *
 * The 235 neighbourhoods do not tile the city exactly: rail corridors,
 * river lots, road allowances and the city edge all leave gaps, and a
 * parcel centroid in one of them gets no cluster from containment alone.
 * Jason, 2026-09-16: place those by proximity instead, capped so a parcel
 * genuinely out in the sticks is left unplaced rather than dragged into a
 * cluster it is nowhere near.
 *
 * DISTANCE IS TO THE BOUNDARY, not to a centroid and not to the nearest
 * vertex. A centroid test would hand a sliver between two long
 * neighbourhoods to whichever happens to be rounder; a vertex test
 * overestimates along a straight run — the nearest point of a 400 m
 * boundary segment is usually in its middle, where there is no vertex.
 * ------------------------------------------------------------------ */

/** Metres per degree at this latitude, for a local flat approximation.
 *  Good to a fraction of a percent over the ~1 km this is used for, and
 *  it keeps the inner loop to arithmetic. */
function degScale(lat) {
  const rad = (lat * Math.PI) / 180;
  return { x: 111320 * Math.cos(rad), y: 110540 };
}

/** Square of the distance in metres from P to segment AB, all in degrees. */
function segDistSqM(px, py, ax, ay, bx, by, scale) {
  const pxm = px * scale.x, pym = py * scale.y;
  const axm = ax * scale.x, aym = ay * scale.y;
  const bxm = bx * scale.x, bym = by * scale.y;
  const dx = bxm - axm, dy = bym - aym;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? (((pxm - axm) * dx + (pym - aym) * dy) / lenSq) : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = axm + t * dx, cy = aym + t * dy;
  return (pxm - cx) ** 2 + (pym - cy) ** 2;
}

/** Walk every ring of a geometry, calling back with each segment. */
function eachSegment(coords, fn, depth = 0) {
  if (!Array.isArray(coords) || !coords.length) return;
  if (typeof coords[0][0] === 'number') {
    for (let i = 0; i < coords.length - 1; i++) {
      fn(coords[i], coords[i + 1]);
    }
    return;
  }
  for (const part of coords) eachSegment(part, fn, depth + 1);
}

/**
 * The cluster whose boundary is closest to [lon, lat], or null when the
 * closest is further than `maxKm`.
 *
 * Only worth calling when clusterForPoint has already returned null — a
 * point INSIDE a polygon is zero metres from its boundary set, so this
 * would answer the same thing much more slowly.
 *
 * @param {Array} index  from buildClusterIndex
 * @param {number} maxKm cap; 0 or negative disables the fallback entirely
 * @returns {{cluster: string, distanceKm: number}|null}
 */
export function nearestCluster(index, lon, lat, maxKm = 1) {
  if (!Array.isArray(index) || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (!Number.isFinite(maxKm) || maxKm <= 0) return null;
  const scale = degScale(lat);
  const capM = maxKm * 1000;
  const capSq = capM * capM;
  // Degrees of slack to reject a polygon on its bbox before touching its
  // rings — the whole point of the bbox is to skip most of the 235.
  const padX = capM / Math.max(scale.x, 1);
  const padY = capM / scale.y;
  let best = null;
  let bestSq = Infinity;
  for (const e of index) {
    const [minX, minY, maxX, maxY] = e.bbox;
    if (lon < minX - padX || lon > maxX + padX) continue;
    if (lat < minY - padY || lat > maxY + padY) continue;
    let localSq = Infinity;
    eachSegment(e.feature?.geometry?.coordinates, (a, b) => {
      const d = segDistSqM(lon, lat, a[0], a[1], b[0], b[1], scale);
      if (d < localSq) localSq = d;
    });
    if (localSq < bestSq) { bestSq = localSq; best = e.cluster; }
  }
  if (best == null || bestSq > capSq) return null;
  return { cluster: best, distanceKm: Math.sqrt(bestSq) / 1000 };
}

/**
 * Containment first, proximity second — the whole placement rule in one
 * call. Returns null when the point is nowhere near the city.
 */
export function clusterForPointOrNearest(index, lon, lat, maxKm = 1) {
  const inside = clusterForPoint(index, lon, lat);
  if (inside) return inside;
  return nearestCluster(index, lon, lat, maxKm)?.cluster ?? null;
}
