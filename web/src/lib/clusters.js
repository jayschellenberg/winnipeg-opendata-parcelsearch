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
