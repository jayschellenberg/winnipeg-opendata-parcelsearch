// Enforcing tests for lib/riseLookup.js — the offline storey-band lookup
// stamped onto apartment and office sales. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/riseLookup.test.js
//
// The rules worth locking:
//   1. ROLLS ARE ZERO-PADDED on both sides, or a 10-digit SABRE roll
//      reads as unclassified when the pipeline did classify it.
//   2. MISSING IS EXCLUDED once the filter is set.
//   3. A malformed lookup row is skipped, never fatal.
//   4. Labels come from the JSON when present, so the pipeline owns them.

import assert from 'node:assert/strict';
import {
  RISE_GROUP_CODES, RISE_CLASSES,
  normalizeRiseRoll, riseGroupOfUseCode, parseRiseLookup, riseFor,
  riseLabel, riseTitle, riseSortKey, stampRise, passesRiseFilter,
  loadRiseLookup, resetRiseLookupCache,
} from '../src/lib/riseLookup.js';

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
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('riseLookup');

const DOC = {
  generated: '2026-09-03',
  groups: {
    apartment: { codes: ['RESAP', 'RESAM'], labels: { low: 'Low-rise / garden (≤3)', mid: 'Mid/high-rise (4+)' } },
    office: { codes: ['CMOFF', 'CMOMC', 'CMOGV', 'CMFBK'], labels: { low: 'Low-rise (1–4)', mid: 'Mid-rise (5–9)', high: 'High-rise (10+)' } },
  },
  rolls: {
    '06070731000': ['apartment', 'low', 3, 'osm_levels'],
    '13050530100': ['apartment', 'mid', null, 'model+overture_height'],
    '12090402000': ['office', 'high', 17, 'osm_levels'],
    '00000000001': ['office', 'bogus', 1, 'osm_levels'],   // unknown class: skipped
    '00000000002': 'not an array',                          // malformed: skipped
  },
};

test('normalizeRiseRoll — pads to 11 digits and strips non-digits', () => {
  assert.equal(normalizeRiseRoll('6070731000'), '06070731000');
  assert.equal(normalizeRiseRoll('06070731000'), '06070731000');
  assert.equal(normalizeRiseRoll(' 06-070-731-000 '), '06070731000');
  assert.equal(normalizeRiseRoll(''), '');
  assert.equal(normalizeRiseRoll(null), '');
});

test('riseGroupOfUseCode — both SABRE and live "CODE - NAME" forms resolve', () => {
  assert.equal(riseGroupOfUseCode('RESAP'), 'apartment');
  assert.equal(riseGroupOfUseCode('RESAM - APARTMENTS MULTIPLE USE'), 'apartment');
  assert.equal(riseGroupOfUseCode('cmoff'), 'office');
  assert.equal(riseGroupOfUseCode('CMFBK'), 'office');
  assert.equal(riseGroupOfUseCode('INWWH'), null);
  assert.equal(riseGroupOfUseCode(null), null);
  // Every code the constant lists resolves to its own group.
  for (const [g, codes] of Object.entries(RISE_GROUP_CODES)) {
    for (const c of codes) assert.equal(riseGroupOfUseCode(c), g);
  }
});

test('parseRiseLookup — keeps the good rows, drops the bad ones', () => {
  const lk = parseRiseLookup(DOC);
  assert.equal(lk.rolls.size, 3);
  assert.equal(lk.generated, '2026-09-03');
  assert.deepEqual(lk.rolls.get('06070731000'), { group: 'apartment', cls: 'low', storeys: 3, source: 'osm_levels' });
  assert.deepEqual(lk.rolls.get('13050530100'), { group: 'apartment', cls: 'mid', storeys: null, source: 'model+overture_height' });
  assert.equal(lk.rolls.has('00000000001'), false);
  assert.equal(lk.rolls.has('00000000002'), false);
});

test('parseRiseLookup — an empty or absent document yields an empty lookup, not a throw', () => {
  assert.equal(parseRiseLookup(null).rolls.size, 0);
  assert.equal(parseRiseLookup({}).rolls.size, 0);
});

test('riseFor — a 10-digit SABRE roll finds its 11-digit entry', () => {
  const lk = parseRiseLookup(DOC);
  assert.equal(riseFor(lk, '6070731000')?.cls, 'low');
  assert.equal(riseFor(lk, '99999999999'), null);
  assert.equal(riseFor(null, '6070731000'), null);
});

test('riseLabel — labels come from the JSON, with a built-in fallback', () => {
  const lk = parseRiseLookup(DOC);
  assert.equal(riseLabel(lk, riseFor(lk, '12090402000')), 'High-rise (10+)');
  assert.equal(riseLabel(lk, riseFor(lk, '13050530100')), 'Mid/high-rise (4+)');
  // A lookup written without labels still renders something readable.
  const bare = parseRiseLookup({ rolls: { '06070731000': ['apartment', 'low', 2, 'osm_levels'] } });
  assert.equal(riseLabel(bare, riseFor(bare, '06070731000')), 'Low-rise / garden (≤3)');
  assert.equal(riseLabel(lk, null), null);
});

test('riseTitle — names the storey count and the instrument', () => {
  const lk = parseRiseLookup(DOC);
  assert.match(riseTitle(riseFor(lk, '12090402000')), /^17 storeys\. Source: OpenStreetMap/);
  assert.match(riseTitle(riseFor(lk, '13050530100')), /model estimate.*Overture height/);
  assert.equal(riseTitle(null), null);
});

test('riseSortKey — low, mid, high, then unclassified', () => {
  const lk = parseRiseLookup(DOC);
  assert.equal(riseSortKey(riseFor(lk, '06070731000')), '0');
  assert.equal(riseSortKey(riseFor(lk, '13050530100')), '1');
  assert.equal(riseSortKey(riseFor(lk, '12090402000')), '2');
  assert.equal(riseSortKey(null), '9');
  assert.deepEqual(RISE_CLASSES, ['low', 'mid', 'high']);
});

test('stampRise — classified features get every _rise field; others get only the sort key', () => {
  const lk = parseRiseLookup(DOC);
  const features = [
    { properties: { roll_number: '6070731000', _saleUseCode: 'RESAP' } },
    { properties: { roll_number: '77777777777', _saleUseCode: 'RESAP' } },   // eligible, unclassified
    { properties: { roll_number: '88888888888', _saleUseCode: 'INWWH' } },   // not eligible
    { properties: null },
  ];
  assert.equal(stampRise(features, lk), 1);
  const a = features[0].properties;
  assert.equal(a._rise, 'Low-rise / garden (≤3)');
  assert.equal(a._riseClass, 'low');
  assert.equal(a._riseGroup, 'apartment');
  assert.equal(a._riseStoreys, 3);
  assert.equal(a._riseSource, 'osm_levels');
  assert.equal(a._riseSortKey, '0');
  const b = features[1].properties;
  assert.equal(b._rise, undefined);
  assert.match(b._riseTitle, /Not in the rise lookup/);
  assert.equal(b._riseSortKey, '9');
  const c = features[2].properties;
  assert.equal(c._rise, undefined);
  assert.equal(c._riseTitle, undefined);
  assert.equal(c._riseSortKey, '9');
});

test('passesRiseFilter — any passes all; a class passes its members only; missing is excluded', () => {
  const lk = parseRiseLookup(DOC);
  const low = { roll: '06070731000' };
  const high = { roll: '12090402000' };
  const none = { roll: '77777777777' };
  for (const s of [low, high, none]) assert.equal(passesRiseFilter(s, lk, 'any'), true);
  for (const s of [low, high, none]) assert.equal(passesRiseFilter(s, lk, ''), true);
  assert.equal(passesRiseFilter(low, lk, 'low'), true);
  assert.equal(passesRiseFilter(high, lk, 'low'), false);
  assert.equal(passesRiseFilter(high, lk, 'high'), true);
  assert.equal(passesRiseFilter(none, lk, 'low'), false, 'unclassified must not pass an active filter');
  assert.equal(passesRiseFilter(low, null, 'low'), false, 'no lookup loaded = nothing passes an active filter');
});

await testAsync('loadRiseLookup — parses once, caches, and degrades to null on failure', async () => {
  resetRiseLookupCache();
  let calls = 0;
  const okFetch = async () => { calls += 1; return { ok: true, json: async () => DOC }; };
  const lk1 = await loadRiseLookup(okFetch, '/x.json');
  const lk2 = await loadRiseLookup(okFetch, '/x.json');
  assert.equal(calls, 1, 'second call served from cache');
  assert.equal(lk1, lk2);
  assert.equal(lk1.rolls.size, 3);

  resetRiseLookupCache();
  const badFetch = async () => ({ ok: false });
  assert.equal(await loadRiseLookup(badFetch, '/x.json'), null);

  resetRiseLookupCache();
  const throwingFetch = async () => { throw new Error('offline'); };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await loadRiseLookup(throwingFetch, '/x.json'), null);
  } finally {
    console.warn = origWarn;
    resetRiseLookupCache();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
