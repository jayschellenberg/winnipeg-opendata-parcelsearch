// Unit tests for lib/mlsAreaLookup.js — the MLS area line in parcel popups.
//
// Run: cd web && node test/mlsAreaLookup.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mlsAreaAt, setMlsAreaLookupData, loadMlsAreaLookup } from '../src/lib/mlsAreaLookup.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FC = JSON.parse(readFileSync(path.join(dir, '..', 'public', 'mls-areas.geojson'), 'utf8'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

await test('nothing loaded: null, not a throw', () => {
  setMlsAreaLookupData(null);
  assert.equal(mlsAreaAt([-97.14, 49.89]), null);
  assert.equal(mlsAreaAt(null), null);
  assert.equal(mlsAreaAt([NaN, 49.89]), null);
});

await test('every area finds itself at its own label point', () => {
  setMlsAreaLookupData(FC);
  // Label points sit inside their own area; a nested area drawn on top
  // would win, so only check the ones nothing smaller covers.
  let checked = 0;
  for (const f of FC.features) {
    const got = mlsAreaAt([f.properties.lx, f.properties.ly]);
    assert.ok(got, f.properties.area);
    if (got.area === f.properties.area) checked++;
  }
  assert.ok(checked > 120, `only ${checked} areas matched their own label point`);
});

await test('known Brandon spots, last (top-drawn) area wins', () => {
  setMlsAreaLookupData(FC);
  assert.equal(mlsAreaAt([-99.9790, 49.8380])?.area, 'B07');
  assert.equal(mlsAreaAt([-99.9300, 49.8180])?.area, 'C15A');
  assert.equal(mlsAreaAt([-99.9550, 49.9080])?.area, 'DNE');
});

await test('a point outside every area is null', () => {
  setMlsAreaLookupData(FC);
  assert.equal(mlsAreaAt([-80, 45]), null);
});

await test('loadMlsAreaLookup swallows a failed fetch', async () => {
  const ok = await loadMlsAreaLookup(async () => ({ ok: false, status: 500 }));
  assert.equal(ok, false);
});

console.log(`\n${passed} passed`);
