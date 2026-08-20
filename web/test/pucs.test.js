// Unit tests for src/lib/pucs.js — the Property Use Code table and the
// sale-category rules built on it. Plain-node runner; run with
// `npm test` or `node test/pucs.test.js`.
//
// Most of what follows is TABLE INTEGRITY rather than logic. That is
// deliberate: the two lookups are hand-maintained from the City's
// publication plus a 2002 MAAP fax, and the failure mode is not a crash
// — it is a code that silently stops appearing in a comp search. The
// integrity block below is what catches that.

import assert from 'node:assert/strict';
import {
  PUCS_CATEGORY_ORDER, PUCS_NAMES, PUCS_CATEGORIES,
  pucsCode, pucsName, pucsCategory, saleCategory,
} from '../src/lib/pucs.js';

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

console.log('pucs');

// --- pucsCode: one extractor for both sides of the join ----------------

test('pucsCode — the bare SABRE code and the live "CODE - NAME" form agree', () => {
  // The whole point of the extractor: a SABRE sale row carries "RESSD"
  // and the d4mq-wa44 record for the same parcel carries
  // "RESSD - DETACHED SINGLE DWELLING". If these two ever disagreed the
  // already-built lookup in saleCategory would silently miss.
  assert.equal(pucsCode('RESSD'), 'RESSD');
  assert.equal(pucsCode('RESSD - DETACHED SINGLE DWELLING'), 'RESSD');
  // PERP is the one 4-letter code in the table — the extractor splits on
  // the separator, not on a fixed width, so it survives.
  assert.equal(pucsCode('PERP - PERSONAL PROPERTY'), 'PERP');
});

test('pucsCode — case and surrounding whitespace do not matter', () => {
  // CSV exports arrive lower-cased and padded often enough that this is
  // not hypothetical.
  assert.equal(pucsCode('ressd'), 'RESSD');
  assert.equal(pucsCode('  RESSD  '), 'RESSD');
  assert.equal(pucsCode('  ressd - detached single dwelling  '), 'RESSD');
  assert.equal(pucsCode('RESSD-DETACHED SINGLE DWELLING'), 'RESSD', 'no space around the dash either');
  // The name half can itself contain a hyphen (CNDRH is "Condo-Rowhouse");
  // only the FIRST separator counts.
  assert.equal(pucsCode('CNDRH - CONDO-ROWHOUSE'), 'CNDRH');
});

test('pucsCode — empty, null and undefined all yield the empty string', () => {
  // Never the string "NULL" or "UNDEFINED", which would then miss every
  // lookup in a way that reads like a real unknown code.
  assert.equal(pucsCode(''), '');
  assert.equal(pucsCode('   '), '');
  assert.equal(pucsCode(null), '');
  assert.equal(pucsCode(undefined), '');
});

// --- pucsName / pucsCategory through both forms -----------------------

test('pucsName — resolves through both forms, and is "" when unseen', () => {
  assert.equal(pucsName('RESSD'), 'Detached Single Dwelling');
  assert.equal(pucsName('RESSD - DETACHED SINGLE DWELLING'), 'Detached Single Dwelling');
  assert.equal(pucsName('resap'), 'Apartments');
  assert.equal(pucsName('ZZZZZ'), '', 'a name we do not have is blank, not the raw code');
  assert.equal(pucsName(''), '');
  assert.equal(pucsName(null), '');
});

test('pucsCategory — resolves through both forms', () => {
  assert.equal(pucsCategory('VRES1'), 'Land');
  assert.equal(pucsCategory('VRES1 - VACANT RESIDENTIAL 1'), 'Land');
  assert.equal(pucsCategory('ressd - detached single dwelling'), 'Residential');
  assert.equal(pucsCategory('RESAP - APARTMENTS'), 'Multi-Family');
});

test('pucsCategory — an UNKNOWN code is null, never a catch-all bucket', () => {
  // Load-bearing. The City adds codes; if an unrecognised one were filed
  // under some default (Infrastructure is the last bucket in the table
  // and the tempting one) it would vanish from every comp search with
  // nobody noticing. Null means "not classified", which is visible.
  assert.equal(pucsCategory('ZZZZZ'), null);
  assert.equal(pucsCategory('ZZZZZ - SOME FUTURE USE'), null);
  assert.equal(pucsCategory(''), null);
  assert.equal(pucsCategory(null), null);
  assert.equal(pucsCategory(undefined), null);
});

// --- table integrity --------------------------------------------------

test('integrity — PUCS_NAMES and PUCS_CATEGORIES cover exactly the same codes', () => {
  // A code with a category but no name shows as a blank cell in the
  // grid; a code with a name but no category filters into nothing. Both
  // are silent, so assert the key SETS are identical rather than just
  // the counts.
  const names = Object.keys(PUCS_NAMES).sort();
  const cats = Object.keys(PUCS_CATEGORIES).sort();
  assert.deepEqual(
    cats.filter((k) => !(k in PUCS_NAMES)), [],
    'categorised but unnamed',
  );
  assert.deepEqual(
    names.filter((k) => !(k in PUCS_CATEGORIES)), [],
    'named but uncategorised',
  );
  assert.deepEqual(names, cats);
});

test('integrity — every category used is a member of PUCS_CATEGORY_ORDER', () => {
  // The filter UI is built from PUCS_CATEGORY_ORDER, so a category name
  // that is only in the table (a typo, "Multi Family" for
  // "Multi-Family") produces codes that no filter option can ever reach.
  const used = [...new Set(Object.values(PUCS_CATEGORIES))].sort();
  assert.deepEqual(
    used.filter((c) => !PUCS_CATEGORY_ORDER.includes(c)), [],
    'category used in the table but missing from the order',
  );
  // And the reverse: an order entry nothing maps to is a dead filter
  // option that always returns zero sales.
  assert.deepEqual(
    PUCS_CATEGORY_ORDER.filter((c) => !used.includes(c)), [],
    'category offered in the filter that no code maps to',
  );
});

test('integrity — PUCS_CATEGORY_ORDER has no duplicates', () => {
  // A duplicate renders the filter option twice and double-counts in
  // anything that iterates the order to build buckets.
  assert.equal(new Set(PUCS_CATEGORY_ORDER).size, PUCS_CATEGORY_ORDER.length);
});

test('integrity — 135 codes and 12 categories', () => {
  // 100 codes off the live d4mq-wa44 roll + 35 filled in from the 2002
  // MAAP fax. If this number moves, the header comment in pucs.js moved
  // with it or someone lost a row to a merge.
  assert.equal(Object.keys(PUCS_NAMES).length, 135);
  assert.equal(Object.keys(PUCS_CATEGORIES).length, 135);
  assert.equal(PUCS_CATEGORY_ORDER.length, 12);
});

test('integrity — the per-category counts recorded in the table still hold', () => {
  // The section headers in pucs.js carry these counts. Moving one code
  // from Retail-Commercial to Office changes an appraisal answer, so it
  // should trip here rather than pass review as a whitespace diff.
  const counts = {};
  for (const c of Object.values(PUCS_CATEGORIES)) counts[c] = (counts[c] || 0) + 1;
  assert.deepEqual(counts, {
    Land: 11,
    Residential: 6,
    'Multi-Family': 8,
    Condominium: 5,
    'Retail-Commercial': 23,
    Office: 9,
    Hospitality: 4,
    Industrial: 13,
    'Mixed-Use': 5,
    Agricultural: 4,
    'Special Purpose': 32,
    Infrastructure: 15,
  });
});

test('integrity — every name is a non-empty string', () => {
  // pucsName falls back to '' for a miss, so an empty name in the table
  // would be indistinguishable from an unrecognised code.
  const blank = Object.entries(PUCS_NAMES)
    .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
    .map(([k]) => k);
  assert.deepEqual(blank, []);
});

// --- the recorded judgement calls -------------------------------------
// Each of these is Jason's call, documented in the pucs.js header. They
// look like inconsistencies to a fresh reader, which is exactly why they
// each get their own assertion: a "tidy-up" trips a test instead of
// quietly changing what comes back from a comp search.

test('judgement — CMPSP Surface Parking is Land; CMPST Parking Structure is not', () => {
  // Jason's call: a surface lot is bought for the dirt and its rate
  // belongs in the land analysis. A parking STRUCTURE is a building and
  // prices like one, so it stays commercial.
  assert.equal(pucsCategory('CMPSP'), 'Land');
  assert.notEqual(pucsCategory('CMPST'), 'Land', 'a parking structure is not a land comp');
  assert.equal(pucsCategory('CMPST'), 'Retail-Commercial');
});

test('judgement — VAGRI Vacant Agricultural is Land, not Agricultural', () => {
  // Jason's call: if it is vacant it is a land comp. "Agricultural"
  // holds improved farm property only — AGRII and friends.
  assert.equal(pucsCategory('VAGRI'), 'Land');
  assert.notEqual(pucsCategory('VAGRI'), 'Agricultural');
  assert.equal(pucsCategory('AGRII'), 'Agricultural', 'improved farm property is where Agricultural lives');
});

test('judgement — condos split by UNDERLYING USE, not by tenure', () => {
  // Jason's call: a commercial condo bay competes with commercial
  // space, not with apartments, so tenure is not the thing to bucket on.
  // Only the residential condos are "Condominium".
  assert.equal(pucsCategory('CNCOM'), 'Retail-Commercial');
  assert.equal(pucsCategory('CNIND'), 'Industrial');
  assert.equal(pucsCategory('CNOFF'), 'Office');
  assert.equal(pucsCategory('CNAPT'), 'Condominium');
  assert.equal(pucsCategory('CNRES'), 'Condominium');
});

test('judgement — RESGC Residential Group Care is Special Purpose, not Multi-Family', () => {
  // Jason's call: it is a care facility, not dwelling units, so it must
  // not land in a multi-family comp set priced per suite. Same call the
  // tile pipeline already made in r/lib_dwelling_units.R.
  assert.equal(pucsCategory('RESGC'), 'Special Purpose');
  assert.notEqual(pucsCategory('RESGC'), 'Multi-Family');
});

// --- saleCategory: the roll's code after the permit record has its say -

test('saleCategory — a plain vacant sale stays Land', () => {
  // No permit evidence means nothing contradicts the assessor.
  assert.equal(saleCategory({ saleUseCode: 'VRES1' }), 'Land');
  assert.equal(saleCategory({ saleUseCode: 'VCOMM', buildVerdict: null, demoVerdict: null }), 'Land');
});

test('saleCategory — an already-built sale takes the LIVE roll\'s category', () => {
  // A vacant-coded sale with a new-build permit closed well before it:
  // the house existed on the day, so the buyer bought a house. What
  // house comes from what the parcel is today.
  assert.equal(saleCategory({
    saleUseCode: 'VRES1',
    liveUseCode: 'RESSD - DETACHED SINGLE DWELLING',
    buildVerdict: 'already-built',
  }), 'Residential');
  assert.equal(saleCategory({
    saleUseCode: 'VRES1',
    liveUseCode: 'RESAP - APARTMENTS',
    buildVerdict: 'already-built',
  }), 'Multi-Family');
});

test('saleCategory — already-built falls back to Residential and NEVER to Land', () => {
  // The live roll can disagree uselessly: a rebuilt parcel that reads
  // vacant again, or no live match at all. Land is the one answer the
  // permit has already ruled out — leaving these in Land is what pulls
  // the land trendline upward, so assert the negative explicitly.
  const liveVacant = saleCategory({
    saleUseCode: 'VRES1',
    liveUseCode: 'VRES1 - VACANT RESIDENTIAL 1',
    buildVerdict: 'already-built',
  });
  assert.equal(liveVacant, 'Residential');
  assert.notEqual(liveVacant, 'Land');

  const noLive = saleCategory({ saleUseCode: 'VRES1', buildVerdict: 'already-built' });
  assert.equal(noLive, 'Residential');
  assert.notEqual(noLive, 'Land');

  // An unrecognised live code is the same situation: unusable, not Land.
  const liveUnknown = saleCategory({
    saleUseCode: 'VRES1',
    liveUseCode: 'ZZZZZ - SOME FUTURE USE',
    buildVerdict: 'already-built',
  });
  assert.equal(liveUnknown, 'Residential');
  assert.notEqual(liveUnknown, 'Land');
});

test('saleCategory — a teardown on an improved-coded sale is Land', () => {
  // The price bought a lot and a demolition bill, whatever the use code
  // says the building was.
  assert.equal(saleCategory({ saleUseCode: 'RESSD', demoVerdict: 'teardown' }), 'Land');
  assert.equal(saleCategory({ saleUseCode: 'CMRST - STORE', demoVerdict: 'teardown' }), 'Land');
  // The other demo verdict is not a re-categorisation — it only confirms
  // what the vacant code already said.
  assert.equal(saleCategory({ saleUseCode: 'RESSD', demoVerdict: 'confirms-vacant' }), 'Residential');
});

test('saleCategory — land-then-built does NOT re-categorise', () => {
  // Construction that started at or after the sale means the sale itself
  // bought bare land. It is a genuine land comp and must stay one.
  assert.equal(saleCategory({
    saleUseCode: 'VRES1',
    liveUseCode: 'RESSD - DETACHED SINGLE DWELLING',
    buildVerdict: 'land-then-built',
  }), 'Land');
});

test('saleCategory — an unknown sale code is still null, and no args does not throw', () => {
  // saleCategory is called per row while rendering; a row missing the
  // whole object must degrade, not take the grid down with it.
  assert.equal(saleCategory({ saleUseCode: 'ZZZZZ' }), null);
  assert.doesNotThrow(() => saleCategory());
  assert.equal(saleCategory(), null);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
