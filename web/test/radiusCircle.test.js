// lib/radiusCircle.js — the "within N km of the subject" ring.
// Run with `node test/radiusCircle.test.js` or via `npm test`.
//
// The property that matters is AGREEMENT: every point on the drawn ring
// must be N km from the subject according to the SAME haversine the radius
// filter measures with. If the two drift, the map draws one boundary while
// the grid enforces another, and a sale sitting on the line is unreadable —
// the appraiser cannot tell whether it is in or out without re-checking the
// Dist column, which is exactly what the ring exists to save them.
import assert from 'node:assert/strict';
import {
  destinationPoint, radiusRing, radiusCircleFc, EARTH_RADIUS_KM,
} from '../src/lib/radiusCircle.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// main.js's haversineKm, copied verbatim. Copied rather than imported
// because it lives in main.js, which cannot load under node — and copying
// is the point: if someone changes the app's distance model without
// changing this ring, these assertions fail.
function haversineKm(a, b) {
  if (!a || !b) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 1128 Main Street, the subject used throughout this work.
const WPG = [-97.1384, 49.9169];

console.log('radiusCircle');

test('the app and the ring share one sphere', () => {
  assert.equal(EARTH_RADIUS_KM, 6371, 'must match haversineKm in main.js');
});

test('every vertex is exactly the radius away, by the filter’s own measure', () => {
  for (const km of [0.25, 1, 2.5, 5, 30]) {
    const ring = radiusRing(WPG, km);
    for (const pt of ring) {
      const d = haversineKm(WPG, pt);
      // Sub-metre. A flat-earth offset would be out by tens of metres at
      // 5 km and would fail this by orders of magnitude.
      assert.ok(Math.abs(d - km) < 0.001,
        `${km} km ring: vertex at ${d.toFixed(6)} km`);
    }
  }
});

test('the ring is closed, as GeoJSON requires', () => {
  const ring = radiusRing(WPG, 2);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ring.length, 129, '128 segments + the repeated first point');
});

test('it is a circle, not an ellipse — the flat-offset bug', () => {
  // The shortcut everyone reaches for (add km/111 to lat, divide by
  // cos(lat) for lon) draws something measurably wider than it is tall.
  // North/south and east/west extents must match.
  const ring = radiusRing(WPG, 5);
  const lats = ring.map((p) => p[1]);
  const lons = ring.map((p) => p[0]);
  const north = haversineKm(WPG, [WPG[0], Math.max(...lats)]);
  const east = haversineKm(WPG, [Math.max(...lons), WPG[1]]);
  assert.ok(Math.abs(north - east) < 0.01,
    `north extent ${north.toFixed(4)} vs east ${east.toFixed(4)}`);
});

test('destinationPoint — cardinal bearings go where they should', () => {
  const north = destinationPoint(WPG, 0, 1);
  const south = destinationPoint(WPG, Math.PI, 1);
  const east = destinationPoint(WPG, Math.PI / 2, 1);
  assert.ok(north[1] > WPG[1], 'north increases latitude');
  assert.ok(south[1] < WPG[1], 'south decreases latitude');
  assert.ok(east[0] > WPG[0], 'east increases longitude');
  // Due north/south barely move the longitude.
  assert.ok(Math.abs(north[0] - WPG[0]) < 1e-9);
});

test('longitudes stay inside [-180, 180]', () => {
  // Winnipeg is nowhere near the antimeridian, but an unnormalized ring
  // renders as a polygon smeared across the world rather than as nothing,
  // and that failure is far harder to read than a wrapped coordinate.
  for (const centre of [[179.9, 49.9], [-179.9, 49.9], WPG]) {
    for (const [lon] of radiusRing(centre, 30)) {
      assert.ok(lon >= -180 && lon <= 180, `lon ${lon} out of range`);
    }
  }
});

test('no ring when there is nothing to draw', () => {
  // These are "no ring", not "a ring of size zero" — the filter is off in
  // exactly these states, so the map must assert nothing.
  for (const km of [0, -1, null, undefined, NaN, '']) {
    assert.equal(radiusRing(WPG, km), null, `radius ${JSON.stringify(km)}`);
    assert.equal(radiusCircleFc(WPG, km), null);
  }
  for (const centre of [null, undefined, [], ['x', 'y'], [NaN, 49]]) {
    assert.equal(radiusRing(centre, 2), null);
    assert.equal(radiusCircleFc(centre, 2), null);
  }
});

test('radiusCircleFc — a well-formed FeatureCollection carrying its radius', () => {
  const fc = radiusCircleFc(WPG, 2.5);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);
  const f = fc.features[0];
  assert.equal(f.geometry.type, 'Polygon');
  assert.equal(f.geometry.coordinates.length, 1, 'one outer ring, no holes');
  assert.equal(f.properties.radiusKm, 2.5);
});

test('a decimal radius is honoured, not rounded', () => {
  // "within 1.5 km" has to draw 1.5 km; truncating to 1 would put the
  // line in the wrong place while the grid filtered at 1.5.
  const ring = radiusRing(WPG, 1.5);
  assert.ok(Math.abs(haversineKm(WPG, ring[0]) - 1.5) < 0.001);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
