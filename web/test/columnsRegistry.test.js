// Enforcing tests for lib/columnsRegistry.js — the single source of truth
// for the results-table column contract. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/columnsRegistry.test.js
//
// After Stage B the registry drives:
//   1. index.html <thead> ............ populated at init by buildThead()
//                                      (drift is now structurally impossible)
//   2. main.js renderTable cells ..... loop over COLUMNS, call col.render(a,s)
//                                      (drift is now structurally impossible)
//   3. main.js SORT_KEYS ............. covered every sortable column key
//   4. lib/urlState.js SORT_COLS ..... imports SORTABLE_COLUMN_KEYS directly
//   5. lib/columns.js PRESETS ........ keys must exist in the registry
//   6. csvSchemaForMode('sales') ..... must include the sale-only fields
//
// A stale SORT_KEYS entry, a preset referencing a dropped column, a CSV
// extractor throwing, or a missing render function now fails CI before
// it ships.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COLUMNS, COLUMN_KEYS, SORTABLE_COLUMN_KEYS,
  columnsForMode, csvSchemaForMode,
} from '../src/lib/columnsRegistry.js';
import { PRESETS, isColumnVisible } from '../src/lib/columns.js';

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

// 1. thead is registry-driven =============================================
test('index.html ships an EMPTY #results <thead><tr>, populated by buildThead at init', () => {
  // Stage B: drift is structurally impossible because the row is emitted
  // from the registry. Pin the absence of inline <th data-col=…> markup
  // so a future "helpful" edit to index.html can't reintroduce the dual-
  // source contract.
  const tableMatch = indexHtml.match(/<table[^>]*id=["']results["'][\s\S]*?<\/thead>/);
  if (!tableMatch) throw new Error('could not locate #results table in index.html');
  const inlineKeys = [...tableMatch[0].matchAll(/<th[^>]*data-col=["']([^"']+)["']/g)];
  assert.equal(inlineKeys.length, 0,
    `index.html re-introduced static <th data-col="…"> rows; the registry owns the thead now.`);
});

test('every registry key is unique', () => {
  const dups = COLUMN_KEYS.filter((k, i) => COLUMN_KEYS.indexOf(k) !== i);
  assert.equal(dups.length, 0, `duplicate keys: ${dups.join(', ')}`);
});

test('every column declares a callable render(a, s) function', () => {
  const broken = COLUMNS.filter((c) => typeof c.render !== 'function');
  assert.equal(broken.length, 0,
    `columns missing render(): ${broken.map((c) => c.key).join(', ')}`);
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
test('every PRESETS entry is offered in the index.html preset dropdown', () => {
  // PRESETS keys were already checked against the registry, but nothing
  // checked that a preset actually REACHES the user: the dropdown's
  // <option>s are hand-written markup. Adding "Residential" to PRESETS
  // without adding the option left it unselectable, which is exactly
  // the drift this guards.
  const select = indexHtml.match(/<select id="columns-preset"[\s\S]*?<\/select>/);
  assert.ok(select, 'preset <select> present in index.html');
  const offered = [...select[0].matchAll(/<option value="([^"]*)"/g)]
    .map((m) => m[1])
    .filter(Boolean);
  for (const name of Object.keys(PRESETS)) {
    assert.ok(offered.includes(name), `preset "${name}" has an <option>`);
  }
  for (const name of offered) {
    assert.ok(name in PRESETS, `dropdown option "${name}" is a real preset`);
  }
});

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

test('csvSchemaForMode — the "#" column joins ONLY when numbering is on', () => {
  // The map badge number is the join between the exported spreadsheet and
  // the map exhibit, so it belongs in the CSV — but only once the set is
  // actually numbered. Emitting an always-blank "#" would silently change
  // the export schema for every existing workflow.
  for (const mode of ['property', 'sales']) {
    assert.ok(!csvSchemaForMode(mode).headers.includes('#'),
      `${mode} CSV emitted "#" with numbering off`);
    assert.ok(csvSchemaForMode(mode, { numbering: true }).headers.includes('#'),
      `${mode} CSV dropped "#" with numbering on`);
  }
});

test('csvSchemaForMode — headers and extractors stay 1:1 in both numbering states', () => {
  for (const mode of ['property', 'sales']) {
    for (const numbering of [false, true]) {
      const { headers, cells } = csvSchemaForMode(mode, { numbering });
      assert.equal(headers.length, cells.length,
        `${mode}/numbering=${numbering}: ${headers.length} headers vs ${cells.length} extractors`);
    }
  }
});

test('seq is never marked col-hidden — the "Number parcels" toggle owns it', () => {
  // The "#" column is gated by a body.numbering-on CSS rule. If
  // lib/columns.js ALSO governed it, every existing user's persisted
  // visible-set (which predates the column) would mark it col-hidden and
  // turning numbering on would number the map but not the grid. The
  // exemption in columns.js is what closes that; presets are irrelevant
  // to it by design, which is why this asserts behaviour, not membership.
  // Default state is the Quick lookup set, which does not list seq — so
  // a `true` here can only come from the exemption.
  assert.ok(!PRESETS['Quick lookup'].has('seq'));
  assert.equal(isColumnVisible('seq'), true, 'seq must always report visible');
  // A governed column still behaves normally, so the exemption is not a
  // blanket "everything is visible".
  assert.equal(isColumnVisible('saleDate'), false,
    'Quick lookup should still hide sale-only columns');
});

test('seq is not offered in the column-visibility presets', () => {
  // Listing it would imply the presets control it. They don't.
  for (const [name, set] of Object.entries(PRESETS)) {
    if (set == null) continue;      // 'Full detail' = everything
    assert.ok(!set.has('seq'), `preset "${name}" lists seq, which it does not govern`);
  }
});

test('seq is the first column, so the "#" reads as a row label', () => {
  assert.equal(COLUMN_KEYS[0], 'seq');
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

test('Built CSV — the three verdicts and the unjudged mark are all distinct', () => {
  // A blank Built cell used to mean two opposite things: the roll positively
  // confirmed the lot bare (642 sales), or the roll is retired and nothing
  // could be asked at all (73). The second must not export as an empty
  // string, or a comp set lifted out of the CSV cannot tell them apart.
  const { extract } = COLUMNS.find((c) => c.key === 'built').csv;
  assert.equal(extract({ _buildVerdict: 'already-built' }), 'ALREADY BUILT');
  assert.equal(extract({ _buildVerdict: 'land-then-built' }), 'land then built');
  assert.equal(extract({ _buildUnjudged: true }), 'not verified');
  assert.equal(extract({}), '');
  // A verdict always wins over the mark — main.js only sets _buildUnjudged
  // where nothing judged, but the extractor must not depend on that.
  assert.equal(extract({ _buildVerdict: 'already-built', _buildUnjudged: true }), 'ALREADY BUILT');
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
