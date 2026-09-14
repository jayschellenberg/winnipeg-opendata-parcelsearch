// lib/historicalTiles.js — naming of the per-snapshot tile archives and the
// size-change summary line. Run: cd web && node test/historicalTiles.test.js
import assert from 'node:assert/strict';
import {
  DEFAULT_HISTORICAL_TILES_BASE, historicalTileFile, historicalTilesUrl, sizeChangeSummaryText,
} from '../src/lib/historicalTiles.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('historicalTiles');

test('the archive file is named by snapshot date, and only by a real date', () => {
  assert.equal(historicalTileFile('2026-07-01'), 'wpg-hist-2026-07-01.pmtiles');
  assert.equal(historicalTileFile('latest'), null);
  assert.equal(historicalTileFile(''), null);
  assert.equal(historicalTileFile(undefined), null);
});

test('the URL joins base and file, tolerating a trailing slash and defaulting to R2', () => {
  assert.equal(historicalTilesUrl('https://x.example/', '2025-02-26'), 'https://x.example/wpg-hist-2025-02-26.pmtiles');
  assert.equal(historicalTilesUrl('', '2025-02-26'), `${DEFAULT_HISTORICAL_TILES_BASE}/wpg-hist-2025-02-26.pmtiles`);
  assert.equal(historicalTilesUrl('https://x.example', 'nope'), null);
  assert.match(DEFAULT_HISTORICAL_TILES_BASE, /^https:\/\/pub-.*\.r2\.dev$/);
});

test('the size-change summary names the bands that are present, with the roll date', () => {
  const t = sizeChangeSummaryText({ size_change: { same: 200000, minor: 3310, major: 1204, gone: 812, unknown: 5 }, size_change_vs: '2026-09-14' });
  assert.equal(t, 'Size changes vs the 2026-09-14 roll: 1,204 major, 3,310 minor, 812 gone (red >25%, orange >5%, grey = roll gone).');
  assert.equal(sizeChangeSummaryText({ size_change: { same: 10 } }), '');
  assert.equal(sizeChangeSummaryText(null), '');
  assert.match(sizeChangeSummaryText({ size_change: { gone: 1 } }), /^Size changes: 1 gone/);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
