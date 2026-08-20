// Unit tests for src/lib/datePresets.js — the sale-date preset pills.
// Plain-node runner; run with `npm test` or `node test/datePresets.test.js`.

import assert from 'node:assert/strict';
import { isoDate, presetRange } from '../src/lib/datePresets.js';

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

console.log('datePresets');

test('isoDate — local calendar date, zero-padded', () => {
  assert.equal(isoDate(new Date(2026, 7, 19)), '2026-08-19');
  assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05');
});

test('short presets are exact rolling windows', () => {
  const today = new Date(2026, 7, 19);   // Aug 19, 2026
  assert.deepEqual(presetRange(3, today),  { from: '2026-05-19', to: '2026-08-19' });
  assert.deepEqual(presetRange(6, today),  { from: '2026-02-19', to: '2026-08-19' });
  assert.deepEqual(presetRange(12, today), { from: '2025-08-19', to: '2026-08-19' });
});

test('24 months and up snap From to Jan 1 of the landing year', () => {
  const today = new Date(2026, 7, 19);
  // 24 mo back lands in Aug 2024 → snapped to 2024-01-01, not 2024-08-19.
  assert.deepEqual(presetRange(24, today), { from: '2024-01-01', to: '2026-08-19' });
  assert.deepEqual(presetRange(36, today), { from: '2023-01-01', to: '2026-08-19' });
  assert.deepEqual(presetRange(72, today), { from: '2020-01-01', to: '2026-08-19' });
});

test('month-end clamp — the offset never overflows into the next month', () => {
  // Mar 31 − 1 mo: naive setMonth gives Mar 3; the clamp gives Feb 28.
  assert.equal(presetRange(1, new Date(2026, 2, 31)).from, '2026-02-28');
  // Leap year: Feb has a 29th to clamp to.
  assert.equal(presetRange(1, new Date(2024, 2, 31)).from, '2024-02-29');
  // May 31 − 3 mo → Feb 28 (short target month further back).
  assert.equal(presetRange(3, new Date(2026, 4, 31)).from, '2026-02-28');
});

test('year boundaries — offsets crossing Jan 1 land in the right year', () => {
  assert.deepEqual(presetRange(3, new Date(2026, 0, 15)), { from: '2025-10-15', to: '2026-01-15' });
  // 12 mo from Jan stays a rolling window (no snap below 24).
  assert.deepEqual(presetRange(12, new Date(2026, 0, 15)), { from: '2025-01-15', to: '2026-01-15' });
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
