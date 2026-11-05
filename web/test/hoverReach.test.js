// Unit tests for src/lib/hoverReach.js — the zone that keeps the parcel
// hover popup still while the pointer travels to it.
// Plain-node runner; run with `npm test` or `node test/hoverReach.test.js`.

import assert from 'node:assert/strict';
import { rectDistance, growRect, inTriangle, reachZone } from '../src/lib/hoverReach.js';

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

console.log('hoverReach');

// A popup 240 x 200 whose top-left corner sits 40 px right/down of where
// it was placed (a typical offset case), and one placed corner-at-cursor.
const rect = { left: 140, top: 140, right: 380, bottom: 340 };
const origin = { x: 100, y: 100 };

test('rectDistance: inside 0, beside, diagonal', () => {
  assert.equal(rectDistance({ x: 200, y: 200 }, rect), 0);
  assert.equal(rectDistance({ x: 130, y: 200 }, rect), 10);
  assert.equal(rectDistance({ x: 137, y: 136 }, rect), 5);
  assert.equal(rectDistance(null, rect), Infinity);
});

test('growRect', () => {
  assert.deepEqual(growRect(rect, 10), { left: 130, top: 130, right: 390, bottom: 350 });
});

test('inTriangle: inside, edge, outside, either winding', () => {
  const a = { x: 0, y: 0 }; const b = { x: 10, y: 0 }; const c = { x: 0, y: 10 };
  assert.equal(inTriangle({ x: 2, y: 2 }, a, b, c), true);
  assert.equal(inTriangle({ x: 5, y: 0 }, a, b, c), true);
  assert.equal(inTriangle({ x: 8, y: 8 }, a, b, c), false);
  assert.equal(inTriangle({ x: 2, y: 2 }, a, c, b), true);
});

test('near: within the margin on any side', () => {
  assert.equal(reachZone({ x: 120, y: 250 }, rect, origin), 'near');   // 20 px left
  assert.equal(reachZone({ x: 400, y: 200 }, rect, origin), 'near');   // 20 px right
  assert.equal(reachZone({ x: 200, y: 200 }, rect, origin), 'near');   // inside
});

test('funnel: a wobbly diagonal path from the origin is held', () => {
  // Points between origin and the popup, off the straight line.
  assert.equal(reachZone({ x: 104, y: 101 }, rect, origin), 'funnel');
  assert.equal(reachZone({ x: 103, y: 106 }, rect, origin), 'funnel');
  assert.equal(reachZone({ x: 105, y: 102 }, rect, origin, 20), 'funnel');
});

test('out: moving away from the popup', () => {
  assert.equal(reachZone({ x: 60, y: 60 }, rect, origin), 'out');     // behind the origin
  assert.equal(reachZone({ x: 60, y: 300 }, rect, origin), 'out');    // off to the side
  assert.equal(reachZone({ x: 500, y: 100 }, rect, origin), 'out');   // past the far corner
});

test('corner-at-cursor popup: the margin alone decides', () => {
  const r = { left: 100, top: 100, right: 340, bottom: 300 };
  assert.equal(reachZone({ x: 80, y: 90 }, r, { x: 100, y: 100 }), 'near');
  assert.equal(reachZone({ x: 50, y: 50 }, r, { x: 100, y: 100 }), 'out');
});

test('no origin: no funnel, margin still counts', () => {
  assert.equal(reachZone({ x: 103, y: 106 }, rect, null), 'out');
  assert.equal(reachZone({ x: 120, y: 250 }, rect, null), 'near');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
