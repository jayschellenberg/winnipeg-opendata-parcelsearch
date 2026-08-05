// Area-selection shape filter — the pure predicates behind the draw
// radius/rectangle/polygon tools. The include/exclude combinations are
// the point: Matrix semantics say exclude always wins, include shapes
// only constrain when at least one exists, and a row with no placeable
// centroid must not leak into an area-narrowed set.
//
// Ported from mb-parcelsearch web/test/shapeFilter.test.js. Only change:
// haversineKm comes from shapeFilter.js itself (no routeSolver here).
import assert from 'node:assert/strict';
import {
  pointInRing,
  pointInShape,
  passesShapeFilter,
  circleRing,
  rectRing,
  shapesToFc,
  formatKm,
  haversineKm,
  featureCentroid,
  rowCentroid,
} from '../src/lib/shapeFilter.js';

// A ~10 km square over south-east Winnipeg.
const SQUARE = [
  [-97.10, 49.80],
  [-96.96, 49.80],
  [-96.96, 49.90],
  [-97.10, 49.90],
];
const INSIDE  = { lng: -97.03, lat: 49.85 };
const OUTSIDE = { lng: -97.30, lat: 49.85 };

// ---- pointInRing ----------------------------------------------------------
assert.equal(pointInRing(INSIDE, SQUARE), true);
assert.equal(pointInRing(OUTSIDE, SQUARE), false);
// Closed ring (duplicated first vertex) behaves identically.
assert.equal(pointInRing(INSIDE, [...SQUARE, SQUARE[0]]), true);
// Degenerate inputs never throw and never match.
assert.equal(pointInRing(INSIDE, []), false);
assert.equal(pointInRing(INSIDE, SQUARE.slice(0, 2)), false);
assert.equal(pointInRing(null, SQUARE), false);

// A concave (L-shaped) ring: the notch is OUTSIDE even though its
// bounding box contains it — this is what ray casting buys over a
// bbox test.
const L_SHAPE = [
  [0, 0], [4, 0], [4, 4], [3, 4], [3, 1], [0, 1],
];
assert.equal(pointInRing({ lng: 3.5, lat: 2 }, L_SHAPE), true,  'inside the L arm');
assert.equal(pointInRing({ lng: 1, lat: 3 },   L_SHAPE), false, 'in the notch = outside');

// ---- pointInShape ---------------------------------------------------------
const CIRCLE = { kind: 'circle', mode: 'include', center: { lng: -97.0, lat: 49.85 }, radiusKm: 5 };
// ~2.2 km east of centre — inside; ~22 km — outside.
assert.equal(pointInShape({ lng: -96.97, lat: 49.85 }, CIRCLE), true);
assert.equal(pointInShape({ lng: -96.70, lat: 49.85 }, CIRCLE), false);
assert.equal(pointInShape(INSIDE, { kind: 'polygon', mode: 'include', ring: SQUARE }), true);
assert.equal(pointInShape(INSIDE, null), false);
assert.equal(pointInShape(null, CIRCLE), false);

// ---- passesShapeFilter: the include/exclude matrix ------------------------
const inc = (ring) => ({ kind: 'polygon', mode: 'include', ring });
const exc = (ring) => ({ kind: 'polygon', mode: 'exclude', ring });
const FAR_SQUARE = SQUARE.map(([x, y]) => [x - 1, y]); // shifted ~70 km west

// No shapes → filter off, everything passes.
assert.equal(passesShapeFilter(INSIDE, []), true);
assert.equal(passesShapeFilter(null, []), true);
// One include: in passes, out fails.
assert.equal(passesShapeFilter(INSIDE,  [inc(SQUARE)]), true);
assert.equal(passesShapeFilter(OUTSIDE, [inc(SQUARE)]), false);
// Two includes: inside EITHER passes.
assert.equal(passesShapeFilter(INSIDE, [inc(FAR_SQUARE), inc(SQUARE)]), true);
// Only excludes: outside them passes, inside fails.
assert.equal(passesShapeFilter(INSIDE,  [exc(SQUARE)]), false);
assert.equal(passesShapeFilter(OUTSIDE, [exc(SQUARE)]), true);
// Exclude wins over include — an exclude hole cut into an include area.
const HOLE = [
  [-97.05, 49.83], [-97.01, 49.83], [-97.01, 49.87], [-97.05, 49.87],
];
assert.equal(passesShapeFilter({ lng: -97.03, lat: 49.85 }, [inc(SQUARE), exc(HOLE)]), false);
assert.equal(passesShapeFilter({ lng: -96.98, lat: 49.81 }, [inc(SQUARE), exc(HOLE)]), true);
// Unplaceable point fails once any shape exists.
assert.equal(passesShapeFilter(null, [inc(SQUARE)]), false);
assert.equal(passesShapeFilter(null, [exc(SQUARE)]), false);

// ---- ring builders --------------------------------------------------------
const RING = circleRing({ lng: -97, lat: 49.85 }, 2);
assert.equal(RING.length, 65, '64 segments close back to the start');
assert.deepEqual(RING[0], RING[RING.length - 1]);
// Every ring vertex sits ~2 km from the centre (local-tangent approx:
// allow a loose ±5% band).
for (const [lng, lat] of RING) {
  const d = haversineKm({ lng: -97, lat: 49.85 }, { lng, lat });
  assert.ok(d > 1.9 && d < 2.1, `ring vertex ${d.toFixed(3)} km from centre`);
}
const RECT = rectRing({ lng: 0, lat: 0 }, { lng: 2, lat: 1 });
assert.equal(RECT.length, 5);
assert.deepEqual(RECT[0], RECT[4]);
assert.equal(pointInRing({ lng: 1, lat: 0.5 }, RECT), true);

// ---- haversineKm ----------------------------------------------------------
// Degenerate inputs return NaN rather than throwing (pointInShape leans
// on Number.isFinite guards upstream, but a NaN comparison is false
// either way — the circle simply never matches).
assert.ok(Number.isNaN(haversineKm(null, { lng: 0, lat: 0 })));
assert.equal(haversineKm({ lng: -97, lat: 49.85 }, { lng: -97, lat: 49.85 }), 0);

// ---- featureCentroid / rowCentroid ---------------------------------------
// The Winnipeg app's rows are { survey, assess }, either side nullable
// depending on which search flow ran. Placement must survive all of it.
const poly = (coords) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } });
// Midpoint arithmetic on floats lands a few ULPs off the round number.
const nearCentroid = (got, lng, lat, msg) => {
  assert.ok(got && Math.abs(got.lng - lng) < 1e-9 && Math.abs(got.lat - lat) < 1e-9,
    `${msg}: got ${JSON.stringify(got)}, wanted ~${lng},${lat}`);
};
const SQUARE_FEATURE = poly([...SQUARE, SQUARE[0]]);
nearCentroid(featureCentroid(SQUARE_FEATURE), -97.03, 49.85, 'polygon bbox midpoint');

// MultiPolygon: the walker has to recurse one level deeper than a
// Polygon and still span BOTH parts.
const MULTI = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [[[-97.10, 49.80], [-97.06, 49.80], [-97.06, 49.84], [-97.10, 49.84], [-97.10, 49.80]]],
      [[[-97.00, 49.86], [-96.96, 49.86], [-96.96, 49.90], [-97.00, 49.90], [-97.00, 49.86]]],
    ],
  },
};
nearCentroid(featureCentroid(MULTI), -97.03, 49.85, 'multipolygon spans both parts');

// No geometry → fall back to the centroid_lat/centroid_lon a sales row
// carries when its roll matched no live parcel polygon.
assert.deepEqual(
  featureCentroid({ type: 'Feature', properties: { centroid_lat: 49.85, centroid_lon: -97.03 }, geometry: null }),
  { lng: -97.03, lat: 49.85 },
);
// Neither geometry nor coordinates → unplaceable.
assert.equal(featureCentroid({ type: 'Feature', properties: {}, geometry: null }), null);
assert.equal(featureCentroid(null), null);
// Non-finite coordinates are ignored rather than poisoning the bbox.
assert.equal(featureCentroid(poly([[NaN, NaN], [NaN, NaN], [NaN, NaN]])), null);

// rowCentroid prefers the assessment side (matching the row-click fly
// target), falls back to survey, and returns null when neither places.
const FAR_FEATURE = poly([[-96.00, 49.80], [-95.96, 49.80], [-95.96, 49.84], [-96.00, 49.80]]);
nearCentroid(rowCentroid({ assess: SQUARE_FEATURE, survey: FAR_FEATURE }), -97.03, 49.85, 'assess side wins');
nearCentroid(rowCentroid({ assess: null, survey: SQUARE_FEATURE }), -97.03, 49.85, 'falls back to survey');
assert.equal(rowCentroid({ assess: null, survey: null }), null);
assert.equal(rowCentroid(null), null);

// End to end: the row predicate main.js runs per table row.
const ROWS = [
  { assess: SQUARE_FEATURE, survey: null },                      // inside
  { assess: FAR_FEATURE, survey: null },                         // outside
  { assess: null, survey: null },                                // unplaceable
];
const keep = (shapes) => ROWS.filter((r) => passesShapeFilter(rowCentroid(r), shapes));
assert.equal(keep([]).length, 3, 'no shapes → every row passes, unplaceable included');
assert.equal(keep([inc(SQUARE)]).length, 1, 'include → only the inside row; the unplaceable row is dropped');
assert.equal(keep([exc(SQUARE)]).length, 1, 'exclude-only → the outside row survives, the unplaceable one does not');

// ---- formatKm -------------------------------------------------------------
assert.equal(formatKm(0.65), '650 m');
assert.equal(formatKm(2.345), '2.35 km');
assert.equal(formatKm(12), '12.00 km');
assert.equal(formatKm(NaN), '');
assert.equal(formatKm(-1), '');

// ---- shapesToFc -----------------------------------------------------------
// Every shape renders as a Polygon (the fill/outline) PLUS a Point
// (the clickable centre dot + mode badge).
const fc = shapesToFc([
  { id: 1, ...CIRCLE },
  { id: 2, kind: 'polygon', mode: 'exclude', ring: SQUARE },
]);
assert.equal(fc.features.length, 4);
const polys  = fc.features.filter((f) => f.geometry.type === 'Polygon');
const points = fc.features.filter((f) => f.geometry.type === 'Point');
assert.equal(polys.length, 2);
assert.equal(points.length, 2);
assert.equal(polys[0].properties.mode, 'include');
assert.equal(polys[1].properties.mode, 'exclude');
// The circle's badge carries its radius; the polygon's is the mode word.
assert.equal(points[0].properties.label, 'Include · 5.00 km');
assert.equal(points[1].properties.label, 'Exclude');
// The circle's dot sits at its true centre.
assert.deepEqual(points[0].geometry.coordinates, [CIRCLE.center.lng, CIRCLE.center.lat]);
// The polygon's dot sits at the ring's bbox midpoint (float tolerance).
assert.ok(Math.abs(points[1].geometry.coordinates[0] - (-97.03)) < 1e-9);
assert.ok(Math.abs(points[1].geometry.coordinates[1] - 49.85) < 1e-9);
// Polygon coordinates are closed for rendering even when the source
// ring was open.
const polyCoords = polys[1].geometry.coordinates[0];
assert.deepEqual(polyCoords[0], polyCoords[polyCoords.length - 1]);

console.log('shapeFilter.test.js: all assertions passed');
