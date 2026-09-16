// lib/searchCriteria.js — saving a Sales Analysis search to a YAML file.
// Run with `node test/searchCriteria.test.js` or via `npm test`.
//
// The rule worth locking is the TRI-STATE. Every multi-select means one of
// three things — no filter, these values, or a deliberate show-nothing — and
// an empty YAML list cannot tell the first from the third. Collapse them and
// a saved search reopens showing everything when it should show nothing, or
// the reverse. Round-tripping all three is most of this file.
import assert from 'node:assert/strict';
import {
  serializeCriteria, parseCriteria, describeCriteria,
  SCALAR_FIELDS, LIST_FIELDS, FLAG_FIELDS, CRITERIA_VERSION,
} from '../src/lib/searchCriteria.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

const full = {
  scalars: {
    subject_roll: '01003547800',
    radius_km: '2.5',
    sale_date_from: '2024-01-01',
    sale_date_to: '2025-12-31',
    sales: 'improved',
    year_built_from: '1950',
    year_built_to: '1970',
    building_sf_min: '1200',
    building_sf_max: '5000',
    price_min: '100000',
    price_max: '900000',
    lot_sf_min: '',
    lot_sf_max: '',
    street: 'MAIN',
    far_flung_km: '30',
    n1: 'matched',
  },
  flags: { nominal_sales: true, far_flung: false },
  lists: {
    neighbourhoods: ['Transcona', 'Fort Garry South'],
    categories: ['Land'],
    pucs: null,
    classes: [],
    zoning: ['M2'],
  },
  meta: { savedAt: '2026-09-16' },
};

console.log('searchCriteria');

test('round-trips every scalar, flag and list', () => {
  const p = parseCriteria(serializeCriteria(full));
  for (const f of SCALAR_FIELDS) {
    assert.equal(p.scalars[f.key] ?? '', full.scalars[f.key] ?? '', f.key);
  }
  assert.equal(p.flags.nominal_sales, true);
  assert.equal(p.flags.far_flung, false);
  assert.deepEqual(p.lists.neighbourhoods, ['Transcona', 'Fort Garry South']);
  assert.deepEqual(p.lists.categories, ['Land']);
  assert.equal(p.lists.pucs, null, 'null must survive as null, not []');
  assert.deepEqual(p.lists.classes, []);
  assert.equal(p.version, CRITERIA_VERSION);
});

test('the tri-state survives: all / none / some are three answers', () => {
  const y = serializeCriteria({ lists: { pucs: null, classes: [], zoning: ['C2'] } });
  assert.match(y, /^pucs: all$/m);
  assert.match(y, /^classes: none$/m);
  const p = parseCriteria(y);
  assert.equal(p.lists.pucs, null);
  assert.deepEqual(p.lists.classes, []);
  assert.deepEqual(p.lists.zoning, ['C2']);
});

test('a roll number keeps its leading zero', () => {
  // Unquoted, 01003547800 is octal to some readers and loses the zero in
  // all of them — and a roll with the wrong first digit silently matches
  // nothing.
  const y = serializeCriteria({ scalars: { subject_roll: '01003547800' } });
  assert.match(y, /subject_roll: "01003547800"/);
  assert.equal(parseCriteria(y).scalars.subject_roll, '01003547800');
});

test('a missing key means "no filter", so a hand-trimmed file still loads', () => {
  const p = parseCriteria('version: 1\nsales: vacant\n');
  assert.equal(p.scalars.sales, 'vacant');
  assert.equal(p.scalars.street, undefined, 'absent, not empty string');
  assert.equal(p.lists.categories, undefined);
});

test('comments, blank lines and stray indentation are ignored', () => {
  const p = parseCriteria(`
# a comment
   # an indented comment

sales:   improved
street: "PORTAGE"
`);
  assert.equal(p.scalars.sales, 'improved');
  assert.equal(p.scalars.street, 'PORTAGE');
});

test('an inline flow list parses, for hand-written files', () => {
  const p = parseCriteria('categories: [Land, Office]\n');
  assert.deepEqual(p.lists.categories, ['Land', 'Office']);
  assert.deepEqual(parseCriteria('categories: []\n').lists.categories, []);
});

test('a single bare value on a list key is the one-value case', () => {
  assert.deepEqual(parseCriteria('zoning: M2\n').lists.zoning, ['M2']);
});

test('a block list ends at the next key, not at the next blank line', () => {
  const p = parseCriteria(`categories:
  - Land
  - Office

street: MAIN
zoning:
  - M2
`);
  assert.deepEqual(p.lists.categories, ['Land', 'Office']);
  assert.equal(p.scalars.street, 'MAIN');
  assert.deepEqual(p.lists.zoning, ['M2']);
});

test('unknown keys are collected, never thrown', () => {
  // A file from a newer version must load what it can and say what it did
  // not, rather than refusing the whole search.
  const p = parseCriteria('sales: vacant\nsome_future_filter: 7\n');
  assert.equal(p.scalars.sales, 'vacant');
  assert.deepEqual(p.unknown, ['some_future_filter']);
});

test('flags read as words, and anything that is not the on-word is off', () => {
  const y = serializeCriteria({ flags: { nominal_sales: true, far_flung: true } });
  assert.match(y, /^nominal_sales: exclude$/m);
  assert.match(y, /^far_flung: exclude$/m);
  const p = parseCriteria('nominal_sales: include\nfar_flung: keep\n');
  assert.equal(p.flags.nominal_sales, false);
  assert.equal(p.flags.far_flung, false);
});

test('junk input never throws', () => {
  for (const t of ['', null, undefined, 'not yaml at all', '::::', '- orphan item']) {
    const p = parseCriteria(t);
    assert.ok(p && typeof p === 'object');
  }
});

test('FLAG_FIELDS words are distinct, or a flag could never read false', () => {
  for (const f of FLAG_FIELDS) assert.notEqual(f.on, f.off, f.key);
});

test('every field list is unique — a duplicate key would shadow silently', () => {
  const keys = [...SCALAR_FIELDS, ...LIST_FIELDS, ...FLAG_FIELDS].map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('describeCriteria summarises without listing everything', () => {
  const d = describeCriteria(parseCriteria(serializeCriteria(full)));
  assert.match(d, /improved only/);
  assert.match(d, /subject 01003547800/);
  assert.match(d, /2 neighbourhoods/);
  assert.match(d, /no classes/);
  assert.equal(describeCriteria(parseCriteria('version: 1\n')), 'no filters set');
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
