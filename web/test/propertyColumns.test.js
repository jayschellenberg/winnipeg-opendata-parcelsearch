// Property Search grid defaults (Jason, 2026-10-07): Roll, Address, PUCS,
// DU, Water and Assessment by default; the legal Lot / Block / Plan and Lot
// Size are gear-only. The stored visible-set wins over the default, so the
// one-time PROPERTY_ONCE migration is what carries the change to anyone who
// has used the app — these tests pin both halves, plus the PUCS column being
// Property Search only.
//
// Run: cd web && node test/propertyColumns.test.js

import assert from 'node:assert/strict';

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
globalThis.document = {
  querySelectorAll: () => [],
  getElementById: () => null,   // initColumns bails after the migrations
};

const { DEFAULT_VISIBLE, PRESETS, initColumns, isColumnVisible, setColumnVisible, setMode } =
  await import('../src/lib/columns.js');
const { COLUMNS, columnsForMode, columnCellClasses, csvSchemaForMode } =
  await import('../src/lib/columnsRegistry.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('Property Search column defaults');

test('the default is roll, address, PUCS, DU, lot size, water, assessment', () => {
  assert.deepEqual([...DEFAULT_VISIBLE].sort(),
    ['address', 'area', 'dwellingUnits', 'pucs', 'roll', 'value', 'water']);
  assert.deepEqual([...PRESETS['Quick lookup']].sort(), [...DEFAULT_VISIBLE].sort());
  for (const k of ['lot', 'block', 'plan']) assert.ok(!DEFAULT_VISIBLE.has(k), `${k} is gear-only`);
});

test('every default key is a real column', () => {
  const keys = new Set(COLUMNS.map((c) => c.key));
  for (const k of DEFAULT_VISIBLE) assert.ok(keys.has(k), `no column '${k}' in the registry`);
});

test('a stored set from before the change is migrated once', () => {
  stored.clear();
  stored.set('wps_table_columns_v1', JSON.stringify(['lot', 'block', 'plan', 'roll', 'address', 'water', 'area']));
  initColumns();
  setMode('property');
  for (const k of ['pucs', 'dwellingUnits', 'value', 'roll', 'address', 'water', 'area']) {
    assert.equal(isColumnVisible(k), true, `${k} should be visible after the migration`);
  }
  for (const k of ['lot', 'block', 'plan']) {
    assert.equal(isColumnVisible(k), false, `${k} should be hidden after the migration`);
  }
  // Once only: the user's own ticks survive the next load.
  setColumnVisible('lot', true);
  setColumnVisible('value', false);
  initColumns();
  assert.equal(isColumnVisible('lot'), true, 'a re-ticked Lot is not dropped again');
  assert.equal(isColumnVisible('value'), false, 'an unticked Assessment is not re-added');
});

test('a browser that ran the first cut (which dropped Lot Size) gets it back', () => {
  stored.clear();
  // What the first deploy left behind: Lot Size dropped, its tag recorded.
  stored.set('wps_table_columns_v1', JSON.stringify(['roll', 'address', 'water', 'pucs', 'dwellingUnits', 'value']));
  stored.set('wps_table_columns_property_once_v1', JSON.stringify(
    ['add:pucs', 'add:dwellingUnits', 'add:value', 'drop:lot', 'drop:block', 'drop:plan', 'drop:area']));
  initColumns();
  setMode('property');
  assert.equal(isColumnVisible('area'), true, 'Lot Size is restored by the add:area tag');
  assert.equal(isColumnVisible('lot'), false, 'the earlier drops are not re-run');
  setColumnVisible('area', false);
  initColumns();
  assert.equal(isColumnVisible('area'), false, 'and an untick after that sticks');
});

test('Full detail (a null stored set) is left alone', () => {
  stored.clear();
  stored.set('wps_table_columns_v1', 'null');
  initColumns();
  setMode('property');
  assert.equal(isColumnVisible('lot'), true);
  assert.equal(stored.get('wps_table_columns_v1'), 'null');
});

test('PUCS (current roll) is a Property Search-only column', () => {
  const col = COLUMNS.find((c) => c.key === 'pucs');
  assert.ok(col, 'no pucs column');
  assert.equal(col.mode, 'property');
  assert.deepEqual(columnCellClasses(col), ['property-only']);
  assert.ok(columnsForMode('property').includes(col), 'property CSV/export carries it');
  assert.ok(!columnsForMode('sales').includes(col), 'the sales export does not (it has its own sale-time PUCS)');
  assert.ok(csvSchemaForMode('property').headers.includes('PUCS'));
});

test('PUCS reads the City code format and names it', () => {
  const col = COLUMNS.find((c) => c.key === 'pucs');
  const [code, use] = col.csv;
  const a = { property_use_code: 'RESSD - DETACHED SINGLE DWELLING' };
  assert.equal(code.extract(a), 'RESSD');
  assert.ok(use.extract(a), 'plain-language use for a known code');
  assert.equal(code.extract({}), '');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
