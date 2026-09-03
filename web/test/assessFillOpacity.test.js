// Enforcing tests for lib/assessFillOpacity.js — the yellow result
// highlight's fill-opacity under the Water Influence and Zoning: Shaded
// overlays. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/assessFillOpacity.test.js
//
// What's locked here:
//   1. The normal highlight is the Manitoba-matched 30% / 50%-on-hover
//      feature-state expression (the numbers a Winnipeg and a Manitoba
//      exhibit share).
//   2. Zoning: Shaded drops it to a faint wash that is still non-zero —
//      the subject parcels stay tinted, the district colours read through.
//   3. Water Influence takes the fill to exactly 0 (it repaints the same
//      polygons) and wins over the zoning dim.
//   4. Every value is a legal MapLibre paint value: a finite number in
//      [0, 1], or a `case` expression whose branches are.

import assert from 'node:assert/strict';
import {
  assessFillOpacity,
  ASSESS_FILL_BASE, ASSESS_FILL_HOVER,
  ASSESS_FILL_DIMMED, ASSESS_FILL_DIMMED_HOVER,
} from '../src/lib/assessFillOpacity.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('assessFillOpacity');

/** Pull [hover, base] out of the groupHover `case` expression. */
function levels(expr) {
  assert.ok(Array.isArray(expr), 'expected a case expression');
  assert.equal(expr[0], 'case');
  assert.deepEqual(expr[1], ['boolean', ['feature-state', 'groupHover'], false]);
  assert.equal(expr.length, 4);
  return [expr[2], expr[3]];
}

test('default state is the 30% / 50%-hover highlight', () => {
  const [hover, base] = levels(assessFillOpacity());
  assert.equal(base, ASSESS_FILL_BASE);
  assert.equal(hover, ASSESS_FILL_HOVER);
  assert.equal(base, 0.3, 'the Manitoba-matched base opacity');
  assert.equal(hover, 0.5);
});

test('no argument and an empty object read the same', () => {
  assert.deepEqual(assessFillOpacity(), assessFillOpacity({}));
});

test('Zoning: Shaded dims the highlight to a faint but non-zero wash', () => {
  const [hover, base] = levels(assessFillOpacity({ zoningShaded: true }));
  assert.equal(base, ASSESS_FILL_DIMMED);
  assert.equal(hover, ASSESS_FILL_DIMMED_HOVER);
  assert.ok(base > 0, 'the subject parcels must stay tinted');
  assert.ok(base < ASSESS_FILL_BASE / 2, 'must be a real drop, not a nudge');
  assert.ok(hover > base, 'hover still lifts so a multi-parcel sale reads');
  assert.ok(hover < ASSESS_FILL_BASE, 'even hovered, stays below the normal base');
});

test('Zoning off / labels-only restores the full highlight', () => {
  assert.deepEqual(assessFillOpacity({ zoningShaded: false }), assessFillOpacity());
});

test('Water Influence takes the fill to exactly 0', () => {
  assert.equal(assessFillOpacity({ waterOn: true }), 0);
});

test('Water wins over the zoning dim', () => {
  assert.equal(assessFillOpacity({ waterOn: true, zoningShaded: true }), 0);
});

test('every value is a legal fill-opacity', () => {
  const inRange = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  for (const state of [
    {}, { zoningShaded: true }, { waterOn: true }, { waterOn: true, zoningShaded: true },
  ]) {
    const v = assessFillOpacity(state);
    if (Array.isArray(v)) {
      for (const n of levels(v)) assert.ok(inRange(n), `${JSON.stringify(state)}: ${n}`);
    } else {
      assert.ok(inRange(v), `${JSON.stringify(state)}: ${v}`);
    }
  }
});

test('returns a fresh expression each call (map.js may mutate paint values)', () => {
  const a = assessFillOpacity();
  const b = assessFillOpacity();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
