// chooseSnap — where a released drag lands.
//
// The gesture code is DOM-bound, but the one decision that matters — which
// snap a release at a given height and velocity goes to — is pure, so it
// is tested directly. A wrong answer here is a sheet that flicks back to
// where it started after every fling.
//
// Run: cd web && node test/sheetDrag.test.js

import assert from 'node:assert/strict';
import { chooseSnap, PROJECT_MS, TAP_SLOP_PX } from '../src/lib/sheetDrag.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// A 375x812 phone with a 48px bar: peek 64, half 46dvh, full the rest.
const H = { peek: 64, half: 373, full: 764 };

test('a still release lands on the nearest snap', () => {
  assert.equal(chooseSnap(64, 0, H), 'peek');
  assert.equal(chooseSnap(200, 0, H), 'peek');
  assert.equal(chooseSnap(230, 0, H), 'half');
  assert.equal(chooseSnap(373, 0, H), 'half');
  assert.equal(chooseSnap(560, 0, H), 'half');
  assert.equal(chooseSnap(580, 0, H), 'full');
  assert.equal(chooseSnap(764, 0, H), 'full');
});

test('a fling upward carries past the nearest snap', () => {
  // Just above peek but moving fast: the projection reaches half.
  assert.equal(chooseSnap(120, 2.5, H), 'half');
  // From half, a hard fling reaches full.
  assert.equal(chooseSnap(400, 3.5, H), 'full');
});

test('a fling downward drops the sheet a state', () => {
  assert.equal(chooseSnap(700, -3, H), 'half');
  assert.equal(chooseSnap(330, -2.5, H), 'peek');
});

test('a slow drift does not count as a fling', () => {
  // 0.3 px/ms over PROJECT_MS is well under the half-way point.
  assert.equal(chooseSnap(373, 0.3, H), 'half');
  assert.equal(chooseSnap(373, -0.3, H), 'half');
});

test('a bad velocity is treated as none', () => {
  assert.equal(chooseSnap(373, NaN, H), 'half');
  assert.equal(chooseSnap(373, undefined, H), 'half');
});

test('the constants are sane for a thumb', () => {
  assert.ok(PROJECT_MS >= 80 && PROJECT_MS <= 250, `PROJECT_MS ${PROJECT_MS}`);
  assert.ok(TAP_SLOP_PX >= 4 && TAP_SLOP_PX <= 12, `TAP_SLOP_PX ${TAP_SLOP_PX}`);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
