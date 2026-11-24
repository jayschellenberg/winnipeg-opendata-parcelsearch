// MLS area lookup for the parcel popups (Jason, 2026-11-24): every parcel
// hover and click popup names the MLS area the parcel sits in, whether or
// not the MLS Areas overlay is switched on.
//
// Winnipeg-only. lib/mlsAreas.js is kept byte-identical with mb-parcelsearch,
// so the lookup lives here rather than there; it reuses that module's
// once-per-page fetch, so switching the overlay on later costs nothing more.
//
// The areas come largest first (nested ones after the area they sit in), so
// the LAST polygon containing the point is the one that draws on top, and
// the one the overlay's own click popup reports.

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { fetchMlsAreas } from './mlsAreas.js';

let index = null; // [{ box: [minX, minY, maxX, maxY], feature }] in file order

/** Index a FeatureCollection for lookups. Exported for the tests. */
export function setMlsAreaLookupData(fc) {
  index = (fc?.features || [])
    .filter((f) => f?.geometry && f.properties?.area)
    .map((f) => ({ box: bbox(f), feature: f }));
}

/** Start the background load. Never rejects: a failed load just leaves the
 *  popups without the line (fetchMlsAreas retries on the next call). */
export function loadMlsAreaLookup(fetchFn) {
  return fetchMlsAreas(fetchFn)
    .then((fc) => { setMlsAreaLookupData(fc); return true; })
    .catch(() => false);
}

/** Properties ({ area, board, ... }) of the MLS area at [lng, lat], or null
 *  when the areas are not loaded yet or the point is in none of them. */
export function mlsAreaAt(point) {
  if (!index || !Array.isArray(point)) return null;
  const [x, y] = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (let i = index.length - 1; i >= 0; i--) {
    const { box, feature } = index[i];
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    if (booleanPointInPolygon([x, y], feature)) return feature.properties;
  }
  return null;
}
