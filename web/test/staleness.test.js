// Unit tests for src/lib/staleness.js — the tile-staleness banner policy.
// Plain-node runner; run with `npm test` or `node test/staleness.test.js`.

import assert from 'node:assert/strict';
import {
  STALE_FRESH_MAX_DAYS, STALE_RED_MIN_DAYS, stalenessBannerState,
} from '../src/lib/staleness.js';

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

console.log('staleness');

test('fresh tiles show no banner, up to and including the threshold', () => {
  assert.equal(stalenessBannerState(0).show, false);
  assert.equal(stalenessBannerState(45).show, false);
  assert.equal(stalenessBannerState(STALE_FRESH_MAX_DAYS).show, false);
});

test('past the fresh threshold the banner is amber', () => {
  const s = stalenessBannerState(STALE_FRESH_MAX_DAYS + 1);
  assert.equal(s.show, true);
  assert.equal(s.tone, 'data-staleness-amber');
  assert.match(s.lead, /91 days old/);
  assert.match(s.tail, /WpgParcelTilesBiMonthly/);
});

test('the red line', () => {
  // At exactly the red minimum it is still amber; strictly past it, red.
  assert.equal(stalenessBannerState(STALE_RED_MIN_DAYS).tone, 'data-staleness-amber');
  const s = stalenessBannerState(STALE_RED_MIN_DAYS + 1);
  assert.equal(s.tone, 'data-staleness-red');
  assert.match(s.tail, /over a year/);
});

test('unknown ages stay quiet — a broken sidecar must not cry wolf', () => {
  assert.equal(stalenessBannerState(null).show, false);
  assert.equal(stalenessBannerState(undefined).show, false);
  assert.equal(stalenessBannerState(NaN).show, false);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
