// Unit tests for src/lib/sizeChange.js. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/sizeChange.test.js

import assert from 'node:assert/strict';
import { sizeBand, computeSizeChanges, SIZE_MINOR_PCT, SIZE_MAJOR_PCT } from '../src/lib/sizeChange.js';

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

console.log('sizeChange');

// ---------- sizeBand ----------

test('sizeBand — null / undefined / NaN → unknown', () => {
  assert.equal(sizeBand(null), 'unknown');
  assert.equal(sizeBand(undefined), 'unknown');
  assert.equal(sizeBand(NaN), 'unknown');
  assert.equal(sizeBand(Infinity), 'unknown');
});

test('sizeBand — 0 → same', () => {
  assert.equal(sizeBand(0), 'same');
});

test('sizeBand — at the minor boundary (5%) is still same; just over is minor', () => {
  assert.equal(sizeBand(SIZE_MINOR_PCT), 'same');   // exactly 5 → same (band is > 5)
  assert.equal(sizeBand(5.01), 'minor');
});

test('sizeBand — at the major boundary (25%) is minor; just over is major', () => {
  assert.equal(sizeBand(SIZE_MAJOR_PCT), 'minor');  // exactly 25 → minor (band is > 25)
  assert.equal(sizeBand(25.01), 'major');
});

test('sizeBand — negative deltas use magnitude', () => {
  assert.equal(sizeBand(-3), 'same');
  assert.equal(sizeBand(-10), 'minor');
  assert.equal(sizeBand(-60), 'major');
});

// ---------- computeSizeChanges ----------

test('computeSizeChanges — same / minor / major bands by delta', () => {
  const hist = new Map([['a', 1000], ['b', 1000], ['c', 1000]]);
  const cur  = new Map([['a', 1020], ['b', 1100], ['c', 2000]]);
  const { byRoll, summary } = computeSizeChanges(hist, cur);
  assert.equal(byRoll.get('a').band, 'same');     // +2%
  assert.equal(byRoll.get('b').band, 'minor');    // +10%
  assert.equal(byRoll.get('c').band, 'major');    // +100%
  assert.equal(byRoll.get('b').deltaPct, 10);
  assert.deepEqual(summary, { same: 1, minor: 1, major: 1, gone: 0, appeared: 0, unknown: 0 });
});

test('computeSizeChanges — gone (roll removed) and appeared (roll new)', () => {
  const hist = new Map([['a', 1000], ['gone', 500]]);
  const cur  = new Map([['a', 1000], ['new', 700]]);
  const { byRoll, summary } = computeSizeChanges(hist, cur);
  assert.equal(byRoll.get('gone').band, 'gone');
  assert.equal(byRoll.get('gone').curArea, null);
  assert.equal(byRoll.has('new'), false);          // appeared rolls aren't in byRoll
  assert.equal(summary.gone, 1);
  assert.equal(summary.appeared, 1);
  assert.equal(summary.same, 1);                   // 'a' unchanged
});

test('computeSizeChanges — zero / missing area → unknown (no divide-by-zero)', () => {
  const hist = new Map([['a', 0], ['b', 1000]]);
  const cur  = new Map([['a', 1000], ['b', 0]]);
  const { byRoll, summary } = computeSizeChanges(hist, cur);
  assert.equal(byRoll.get('a').band, 'unknown');
  assert.equal(byRoll.get('a').deltaPct, null);
  assert.equal(byRoll.get('b').band, 'unknown');
  assert.equal(summary.unknown, 2);
});

test('computeSizeChanges — empty inputs', () => {
  const { byRoll, summary } = computeSizeChanges(new Map(), new Map());
  assert.equal(byRoll.size, 0);
  assert.deepEqual(summary, { same: 0, minor: 0, major: 0, gone: 0, appeared: 0, unknown: 0 });
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
