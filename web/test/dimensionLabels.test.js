// Unit tests for lib/dimensionLabels.js — per-property merging of survey
// lot edges for the Dimensions overlay.
//
// Run: cd web && node test/dimensionLabels.test.js

import assert from 'node:assert/strict';
import { buildDimensionLabels, haversineFt, formatFeet } from '../src/lib/dimensionLabels.js';

// A local grid in feet near Winnipeg, converted to [lon, lat].
const LAT0 = 49.9;
const FT_LAT = 1 / 364000;
const FT_LON = FT_LAT / Math.cos(LAT0 * Math.PI / 180);
const pt = (x, y) => [-97.15 + x * FT_LON, LAT0 + y * FT_LAT];
const lot = (x0, y0, x1, y1) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1), pt(x0, y0)]] },
});
// The test grid is only approximately feet, so compare whole feet here;
// the one-decimal format is checked on its own below.
const labels = (fc) => fc.features
  .map((f) => `${Math.round(parseFloat(f.properties.length_label.replace(/,/g, '')))} ft`).sort();
const fc = (...features) => ({ type: 'FeatureCollection', features });

// Sanity: the grid is in feet.
assert.ok(Math.abs(haversineFt(pt(0, 0), pt(100, 0)) - 100) < 0.5, 'grid x is feet');
assert.ok(Math.abs(haversineFt(pt(0, 0), pt(0, 100)) - 100) < 0.5, 'grid y is feet');

// 588 Sargent: two 31 x 99 lots, one property -> 62 x 99, no middle line.
const sargent = fc(lot(0, 0, 31, 99), lot(31, 0, 62, 99));
assert.deepEqual(labels(buildDimensionLabels(sargent, () => 'p')), ['62 ft', '62 ft', '99 ft', '99 ft']);

// Same two lots as two properties: each keeps its width, the shared line once.
assert.deepEqual(labels(buildDimensionLabels(sargent, (f, i) => i)),
  ['31 ft', '31 ft', '31 ft', '31 ft', '99 ft', '99 ft', '99 ft']);

// Default grouping (no groupOf) is per lot — the old behaviour.
assert.equal(buildDimensionLabels(sargent).features.length, 7);

// Three lots in a row, one property -> 90 wide.
const three = fc(lot(0, 0, 30, 120), lot(30, 0, 60, 120), lot(60, 0, 90, 120));
assert.deepEqual(labels(buildDimensionLabels(three, () => 'p')), ['120 ft', '120 ft', '90 ft', '90 ft']);

// L-shape (one lot deeper): the step stays, runs that continue straight join.
const ell = fc(lot(0, 0, 30, 100), lot(30, 0, 60, 120));
assert.deepEqual(labels(buildDimensionLabels(ell, () => 'p')),
  ['100 ft', '120 ft', '20 ft', '30 ft', '30 ft', '60 ft']);

// Two-by-two block of lots, one property -> a plain 60 x 200 rectangle.
const block = fc(lot(0, 0, 30, 100), lot(30, 0, 60, 100), lot(0, 100, 30, 200), lot(30, 100, 60, 200));
assert.deepEqual(labels(buildDimensionLabels(block, () => 'p')), ['200 ft', '200 ft', '60 ft', '60 ft']);

// A bend of more than 3 degrees is a corner, not one side.
const bent = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[pt(0, 0), pt(50, 0), pt(100, 8), pt(100, 60), pt(0, 60), pt(0, 0)]] },
};
assert.ok(labels(buildDimensionLabels(fc(bent))).includes('50 ft'), 'bent frontage stays two sides');

// One decimal, dropped when it is .0; thousands separators.
assert.equal(formatFeet(62.8349), '62.8 ft');
assert.equal(formatFeet(99), '99 ft');
assert.equal(formatFeet(98.96), '99 ft');
assert.equal(formatFeet(31.46), '31.5 ft');
assert.equal(formatFeet(1240.5), '1,240.5 ft');
assert.match(buildDimensionLabels(sargent, () => 'p').features[0].properties.length_label, /^\d+(\.\d)? ft$/);

// Malformed and empty input.
assert.equal(buildDimensionLabels(null).features.length, 0);
assert.equal(buildDimensionLabels(fc({ type: 'Feature', geometry: null })).features.length, 0);

console.log('dimensionLabels: all tests passed');
