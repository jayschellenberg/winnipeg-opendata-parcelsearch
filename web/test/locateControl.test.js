// takeFix — the one-shot latch behind "use my location".
//
// Tracking mode reports a fix every few seconds while the user walks.
// The app must hear exactly one per press of the button: the first
// switches the parcel fabric on and tucks the sheet away; a second would
// redo that while the user is reading the map.
//
// Run: cd web && node test/locateControl.test.js

import assert from 'node:assert/strict';
import { takeFix, LOCATE_ZOOM } from '../src/lib/locateControl.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('an armed latch hands over the first fix and disarms', () => {
  const r = takeFix({ armed: true });
  assert.equal(r.handle, true);
  assert.deepEqual(r.latch, { armed: false });
});

test('a disarmed latch ignores every later fix', () => {
  let latch = { armed: false };
  for (let i = 0; i < 3; i++) {
    const r = takeFix(latch);
    assert.equal(r.handle, false);
    latch = r.latch;
  }
  assert.deepEqual(latch, { armed: false });
});

test('a fresh press arms it again: one hand-over per press', () => {
  let latch = { armed: true };
  let handed = 0;
  for (let i = 0; i < 4; i++) { const r = takeFix(latch); latch = r.latch; if (r.handle) handed++; }
  latch = { armed: true };   // trackuserlocationstart
  for (let i = 0; i < 4; i++) { const r = takeFix(latch); latch = r.latch; if (r.handle) handed++; }
  assert.equal(handed, 2);
});

test('the zoom draws civic labels (from 16.5 in Manitoba) but stays street-scale', () => {
  assert.ok(LOCATE_ZOOM >= 16.5 && LOCATE_ZOOM <= 18, `LOCATE_ZOOM ${LOCATE_ZOOM}`);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
