// Unit tests for lib/multiFamily.js — the Multi-Family overlay.
//
// Run: cd web && node test/multiFamily.test.js

import assert from 'node:assert/strict';
import {
  MF_MIN_DU, UNITS_RAMP, clampMinDu, mfColorExpr, mfFilter, mfOrdinaryLabelFilter, mfLegendSteps,
} from '../src/lib/multiFamily.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Evaluate the step expression the way MapLibre does, for one count. */
function colorFor(du) {
  const [, , base, ...stops] = mfColorExpr();
  let color = base;
  for (let i = 0; i < stops.length; i += 2) if (du >= stops[i]) color = stops[i + 1];
  return color;
}

console.log('multiFamily');

test('threshold clamps to the 3+ floor and rejects junk', () => {
  assert.equal(clampMinDu(''), MF_MIN_DU);
  assert.equal(clampMinDu('abc'), MF_MIN_DU);
  assert.equal(clampMinDu(1), 3);
  assert.equal(clampMinDu('20'), 20);
  assert.equal(clampMinDu(7.9), 7);
  assert.equal(clampMinDu(1e6), 9999);
});

test('fill colour matches the ramp at every band edge', () => {
  let lo = 3;
  for (const band of UNITS_RAMP) {
    assert.equal(colorFor(lo), band.color, `${lo} DU`);
    if (Number.isFinite(band.max)) assert.equal(colorFor(band.max), band.color, `${band.max} DU`);
    lo = band.max + 1;
  }
  assert.equal(colorFor(4), '#eff3ff');   // 266 Beliveau
  assert.equal(colorFor(150), '#08306b');
});

test('filters carry the clamped threshold', () => {
  assert.deepEqual(mfFilter(20), ['>=', ['to-number', ['get', 'dwelling_unit_count'], 0], 20]);
  assert.equal(mfFilter(1)[2], 3);
  const ord = mfOrdinaryLabelFilter(5);
  assert.deepEqual(ord[1], ['==', ['get', 'dwelling_is_condo'], 0]);
  assert.equal(ord[2][2], 5);
});

test('legend drops bands wholly below the threshold', () => {
  assert.equal(mfLegendSteps(3).length, 6);
  assert.deepEqual(mfLegendSteps(20).map((s) => s.label), ['12-23', '24-49', '50-99', '100+']);
  assert.deepEqual(mfLegendSteps(500).map((s) => s.label), ['100+']);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
