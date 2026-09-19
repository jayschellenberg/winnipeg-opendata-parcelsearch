// pickHit — which parcel a location fix opens.
//
// The control fires the map's own click at the fix, but only when a
// parcel layer is actually under it; otherwise it says so. The choice of
// WHICH hit counts is the one decision here: a result parcel outranks the
// municipality fabric, and only the caller's layers count at all.
//
// Run: cd web && node test/locateControl.test.js

import assert from 'node:assert/strict';
import { pickHit, LOCATE_ZOOM } from '../src/lib/locateControl.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(1); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(0); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const hit = (layer, id) => ({ layer: { id: layer }, properties: { id } });
const LAYERS = ['parcel-fill', 'parcel-pin', 'muni-parcels-fill'];

test('a result parcel outranks the municipality fabric under the same point', () => {
  const f = pickHit([hit('muni-parcels-fill', 'm'), hit('parcel-fill', 'r')], LAYERS);
  assert.equal(f.properties.id, 'r');
});

test('the municipality parcel is used when no result is there', () => {
  assert.equal(pickHit([hit('muni-parcels-fill', 'm')], LAYERS).properties.id, 'm');
});

test('layers the caller did not name never count', () => {
  assert.equal(pickHit([hit('zoning-fill', 'z'), hit('water', 'w')], LAYERS), null);
  assert.equal(pickHit([], LAYERS), null);
  assert.equal(pickHit(undefined, LAYERS), null);
});

test('the zoom lands on a parcel, not a street or a province', () => {
  assert.ok(LOCATE_ZOOM >= 16 && LOCATE_ZOOM <= 18, `LOCATE_ZOOM ${LOCATE_ZOOM}`);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
