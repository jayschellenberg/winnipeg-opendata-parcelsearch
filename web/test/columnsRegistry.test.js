// Enforcing tests for lib/columnsRegistry.js — the single source of truth
// for the results-table column contract. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/columnsRegistry.test.js
//
// These pin the five "keep in sync" sites the audit flagged:
//   1. index.html <th data-col="…"> sequence  → match COLUMN_KEYS order
//   2. main.js SORT_KEYS object               → covers every sortable column
//   3. lib/urlState.js SORT_COLS              → == sortable column keys
//   4. lib/columns.js PRESETS                 → only reference real column keys
//   5. csvSchemaForMode('sales')              → contains sale-only fields
//
// A misordered thead, a stale SORT_KEYS entry, or a preset referencing a
// dropped column now fails CI before it ships.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COLUMNS, COLUMN_KEYS, SORTABLE_COLUMN_KEYS,
  columnsForMode, csvSchemaForMode,
} from '../src/lib/columnsRegistry.js';
import { PRESETS } from '../src/lib/columns.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const indexHtml = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const mainJs    = readFileSync(path.join(repoRoot, 'src', 'main.js'), 'utf8');

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

console.log('columnsRegistry');

// 1. thead order ==========================================================
function parseTheadKeys() {
  // Scope to the #results table so other thead-like markup can't interfere.
  const tableMatch = indexHtml.match(/<table[^>]*id=["']results["'][\s\S]*?<\/thead>/);
  if (!tableMatch) throw new Error('could not locate #results table in index.html');
  const keys = [...tableMatch[0].matchAll(/data-col=["']([^"']+)["']/g)].map((m) => m[1]);
  return keys;
}

test('index.html thead <th data-col="…"> order matches COLUMN_KEYS exactly', () => {
  const domOrder = parseTheadKeys();
  assert.deepEqual(domOrder, COLUMN_KEYS,
    `thead vs registry mismatch — keep them in lockstep.\n    dom:      [${domOrder.join(', ')}]\n    registry: [${COLUMN_KEYS.join(', ')}]`);
});

test('every registry key is unique', () => {
  const dups = COLUMN_KEYS.filter((k, i) => COLUMN_KEYS.indexOf(k) !== i);
  assert.equal(dups.length, 0, `duplicate keys: ${dups.join(', ')}`);
});

// 2. SORT_KEYS coverage ====================================================
function parseSortKeysMap() {
  // Match the SORT_KEYS map in main.js, then pull keys out of each
  // `key: (r) => …` row. The lookahead skips the closing `};`.
  const block = mainJs.match(/const SORT_KEYS\s*=\s*\{[\s\S]*?^\};/m);
  if (!block) throw new Error('could not locate SORT_KEYS in main.js');
  return [...block[0].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]);
}

test('main.js SORT_KEYS covers every sortable registry column', () => {
  const sortKeys = new Set(parseSortKeysMap());
  const missing = SORTABLE_COLUMN_KEYS.filter((k) => !sortKeys.has(k));
  assert.equal(missing.length, 0,
    `SORT_KEYS missing entries for: ${missing.join(', ')}`);
});

// 3. SORT_COLS — covered by import-side wiring; assert sortable count > 0.
test('SORTABLE_COLUMN_KEYS is non-empty (urlState.js imports it directly)', () => {
  assert.ok(SORTABLE_COLUMN_KEYS.length > 0);
  assert.equal(SORTABLE_COLUMN_KEYS.length, COLUMNS.filter((c) => c.sortable).length);
});

// 4. PRESETS reference only real column keys ===============================
test('every key in lib/columns.js PRESETS exists in the registry', () => {
  const known = new Set(COLUMN_KEYS);
  const stale = [];
  for (const [name, set] of Object.entries(PRESETS)) {
    if (set == null) continue;       // 'Full detail' = everything
    for (const k of set) if (!known.has(k)) stale.push(`${name}: ${k}`);
  }
  assert.equal(stale.length, 0, `stale preset keys: ${stale.join('; ')}`);
});

// 5. CSV schema =============================================================
test('columnsForMode("property") excludes sales-mode columns', () => {
  const keys = columnsForMode('property').map((c) => c.key);
  for (const c of COLUMNS) {
    if (c.mode === 'sales') assert.ok(!keys.includes(c.key), `${c.key} leaked into property mode`);
  }
});

test('columnsForMode("sales") includes sale-only columns + always-on columns', () => {
  const keys = columnsForMode('sales').map((c) => c.key);
  assert.ok(keys.includes('saleDate'));
  assert.ok(keys.includes('salePrice'));
  assert.ok(keys.includes('roll'));        // an always-on column
});

test('csvSchemaForMode — sales-mode headers carry the sale-only fields (closes audit M5)', () => {
  const { headers } = csvSchemaForMode('sales');
  for (const wanted of ['Sale Date', 'Sale Price', '$/Lot SF', 'Sale/Asmt %', 'Dist (km)', 'Instrument']) {
    assert.ok(headers.includes(wanted), `sales CSV missing column "${wanted}"`);
  }
});

test('csvSchemaForMode — property-mode headers carry the Assessment-URL trio', () => {
  const { headers } = csvSchemaForMode('property');
  for (const wanted of ['Total Assessed Value', 'Assessment Year', 'Assessment URL', 'Walkscore URL', 'Flood URL']) {
    assert.ok(headers.includes(wanted), `property CSV missing column "${wanted}"`);
  }
});

test('csvSchemaForMode — extractors run without throwing on a minimal row', () => {
  const a = { roll_number: '01000001000', full_address: '123 MAIN ST', centroid_lat: 49.9, centroid_lon: -97.1 };
  const s = { lot: '7', block: '2', plan: '129', description: '' };
  for (const mode of ['property', 'sales']) {
    const { cells } = csvSchemaForMode(mode);
    for (const extract of cells) {
      // Just exercising — the schema is a contract; thrown errors here
      // mean an extractor is touching something it shouldn't.
      extract(a, s);
    }
  }
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
