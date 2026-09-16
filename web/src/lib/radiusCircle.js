/*
 * The "within N km of the subject" ring, as a GeoJSON polygon.
 *
 * WHY A POLYGON AND NOT A CIRCLE LAYER. MapLibre's `circle` layer sizes
 * its radius in SCREEN PIXELS, so a circle drawn that way is a fixed dot
 * that means a different distance at every zoom — the one thing this must
 * never be. A sampled polygon is in real coordinates and scales with the
 * map, so the ring keeps meaning 2 km whatever the view.
 *
 * WHY THE SPHERICAL FORMULA AND NOT A FLAT OFFSET. The obvious shortcut —
 * add `km / 111` to the latitude and divide by cos(lat) for longitude —
 * draws an ellipse that is wrong by a few percent and, worse, wrong by a
 * DIFFERENT amount on each axis. The filter measures with haversine on a
 * 6371 km sphere (see haversineKm in main.js), so this walks the same
 * sphere with the standard destination-point formula. The ring is then
 * exactly the set of points the filter calls the boundary: a sale sitting
 * on the line is a sale the filter keeps, and an appraiser can trust the
 * picture rather than having to re-check the Dist column.
 *
 * Pure — no DOM, no MapLibre — so it unit-tests under plain node against
 * the same distance function the app filters with.
 */

/** Same sphere the distance filter uses. Changing one without the other
 *  would let the drawing and the filtering disagree at the boundary. */
export const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * The point `km` away from [lon, lat] along `bearingRad`, on a sphere.
 *
 * @param {[number, number]} origin [lon, lat] in degrees
 * @param {number} bearingRad clockwise from north, radians
 * @param {number} km great-circle distance
 * @returns {[number, number]} [lon, lat] in degrees
 */
export function destinationPoint(origin, bearingRad, km) {
  const [lon, lat] = origin;
  const ang = km / EARTH_RADIUS_KM;
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const sinLat2 = Math.sin(lat1) * Math.cos(ang)
    + Math.cos(lat1) * Math.sin(ang) * Math.cos(bearingRad);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
  const y = Math.sin(bearingRad) * Math.sin(ang) * Math.cos(lat1);
  const x = Math.cos(ang) - Math.sin(lat1) * sinLat2;
  const lon2 = lon1 + Math.atan2(y, x);
  // Normalize into [-180, 180]. Winnipeg is nowhere near the
  // antimeridian, but a ring that silently produced lon 190 would render
  // as a polygon smeared across the whole world rather than as nothing,
  // and that failure is much harder to read than a wrapped coordinate.
  return [((toDeg(lon2) + 540) % 360) - 180, toDeg(lat2)];
}

/**
 * A closed ring approximating the circle of radius `km` about `centre`.
 *
 * 128 segments is about 2.8 degrees of arc per side. At a 1 km radius
 * that is a ~24 m chord, well under a pixel at any zoom where the whole
 * ring is on screen, so it reads as a circle and not a polygon. Cheap
 * enough that it is rebuilt from scratch on every change rather than
 * cached and invalidated.
 *
 * Returns null for a missing centre or a non-positive radius — the two
 * states that mean "no ring to draw" rather than "a ring of size zero".
 */
export function radiusRing(centre, km, steps = 128) {
  const lon = Number(centre?.[0]);
  const lat = Number(centre?.[1]);
  const r = Number(km);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (!Number.isFinite(r) || r <= 0) return null;
  const n = Math.max(12, Math.trunc(steps));
  const ring = [];
  for (let i = 0; i < n; i++) {
    ring.push(destinationPoint([lon, lat], (2 * Math.PI * i) / n, r));
  }
  // GeoJSON requires the first position repeated as the last.
  ring.push(ring[0]);
  return ring;
}

/**
 * The ring as a FeatureCollection ready for a geojson source, or null.
 *
 * `radiusKm` rides along on the feature so anything reading the source
 * back — a debug session, a future legend — knows what it is looking at
 * without re-deriving it from the geometry.
 */
export function radiusCircleFc(centre, km) {
  const ring = radiusRing(centre, km);
  if (!ring) return null;
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { radiusKm: Number(km) },
      geometry: { type: 'Polygon', coordinates: [ring] },
    }],
  };
}
