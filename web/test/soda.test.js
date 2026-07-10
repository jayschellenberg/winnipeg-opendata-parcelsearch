// Unit tests for the pure query-clause + geometry-join helpers in
// src/soda.js. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/soda.test.js
//
// These are characterization tests: they pin the behaviour of the
// functions that define search correctness so a refactor or "simplify"
// pass can't silently change them — the way commit 1348c06 silently
// removed fetchSoda's retry loop.

import assert from 'node:assert/strict';
import {
  parcelsOverlap,
  mergeSurveyFeatures,
  rollClause,
  normalizeRoll,
  buildAddressClauses,
  normalizeStreetQuery,
  zoningClause,
} from '../src/soda.js';

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

console.log('soda');

// ---------- fixtures ----------

// Axis-aligned square polygon Feature: lower-left corner (minLon, minLat),
// side length `size` in degrees.
function square(minLon, minLat, size, properties = {}) {
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [minLon, minLat],
        [minLon + size, minLat],
        [minLon + size, minLat + size],
        [minLon, minLat + size],
        [minLon, minLat],
      ]],
    },
  };
}

function surveyFeat(id, lot, block, plan, description = '') {
  return square(0, 0, 1, { id, lot, block, plan, description });
}

// ---------- parcelsOverlap ----------

test('parcelsOverlap — assessment centroid inside survey (duplex case) → true', () => {
  const survey = square(0, 0, 10);
  const assess = square(2, 2, 2, { centroid_lat: 3, centroid_lon: 3 });
  assert.equal(parcelsOverlap(survey, assess), true);
});

test('parcelsOverlap — survey bbox center inside assessment (downtown case) → true', () => {
  // Small lot inside a big building footprint whose own centroid sits
  // elsewhere in the footprint (NOT inside this lot) — only the
  // survey-center-in-assessment direction can match.
  const survey = square(2, 2, 2);
  const assess = square(0, 0, 10, { centroid_lat: 8, centroid_lon: 8 });
  assert.equal(parcelsOverlap(survey, assess), true);
});

test('parcelsOverlap — adjacent parcels sharing an edge → false (the booleanIntersects bug)', () => {
  const survey = square(0, 0, 2);
  const assess = square(2, 0, 2, { centroid_lat: 1, centroid_lon: 3 });
  assert.equal(parcelsOverlap(survey, assess), false);
});

test('parcelsOverlap — missing centroid props falls back to polygon intersection', () => {
  const survey = square(2, 2, 2);
  const containing = square(0, 0, 10);   // no centroid_lat / centroid_lon
  const disjoint = square(20, 20, 2);    // no centroid_lat / centroid_lon
  assert.equal(parcelsOverlap(survey, containing), true);
  assert.equal(parcelsOverlap(survey, disjoint), false);
});

// ---------- mergeSurveyFeatures ----------

test('mergeSurveyFeatures — empty → null; single non-partial passes through unchanged', () => {
  assert.equal(mergeSurveyFeatures([]), null);
  const f = surveyFeat(1, '7', '2', '129');
  assert.equal(mergeSurveyFeatures([f]), f);
});

test('mergeSurveyFeatures — single partial lot gets "(partial)" suffix without mutating the input', () => {
  const f = surveyFeat(1, '7', '2', '129');
  const merged = mergeSurveyFeatures([f], new Set([1]));
  assert.equal(merged.properties.lot, '7 (partial)');
  assert.equal(f.properties.lot, '7');
});

test('mergeSurveyFeatures — sequential numeric lots collapse into ranges', () => {
  const fs = ['21', '22', '23', '25'].map((lot, i) => surveyFeat(i, lot, '1', '129'));
  const merged = mergeSurveyFeatures(fs);
  assert.equal(merged.properties.lot, '21-23, 25');
  assert.equal(merged.properties.plan, '129');
  assert.equal(merged.properties.block, '1');
});

test('mergeSurveyFeatures — multi-plan merge annotates each group with its plan', () => {
  const fs = [
    surveyFeat(1, '21', '1', '129'),
    surveyFeat(2, '22', '1', '129'),
    surveyFeat(3, '39', '1', '24208'),
    surveyFeat(4, '41', '1', '24208'),
  ];
  const merged = mergeSurveyFeatures(fs);
  assert.equal(merged.properties.lot, '21-22 (Pl 129); 39, 41 (Pl 24208)');
  assert.equal(merged.properties.plan, '129, 24208');
});

test('mergeSurveyFeatures — partial lots are broken out of ranges individually', () => {
  const fs = [
    surveyFeat(1, '21', '1', '129'),
    surveyFeat(2, '22', '1', '129'),
    surveyFeat(3, '23', '1', '129'),
  ];
  const merged = mergeSurveyFeatures(fs, new Set([3]));
  assert.equal(merged.properties.lot, '21-22, 23 (partial)');
});

test('mergeSurveyFeatures — non-numeric lots fall back to a natural-sorted list', () => {
  const fs = [
    surveyFeat(1, 'RL10', '', '40'),
    surveyFeat(2, '2', '', '40'),
  ];
  const merged = mergeSurveyFeatures(fs);
  assert.equal(merged.properties.lot, '2, RL10');
});

// ---------- rollClause ----------

test('rollClause — empty input → null', () => {
  assert.equal(rollClause(''), null);
  assert.equal(rollClause(null), null);
});

test('rollClause — single token keeps the historical partial-LIKE behaviour', () => {
  assert.equal(rollClause('300'), "upper(roll_number) like '%300%'");
});

test('rollClause — single token escapes SoQL single quotes', () => {
  assert.equal(rollClause("O'B"), "upper(roll_number) like '%O''B%'");
});

test('rollClause — multi-token list → exact IN with 11-digit zero-padding', () => {
  assert.equal(
    rollClause('1000001000, 3093017710'),
    "roll_number IN ('01000001000','03093017710')"
  );
});

test('rollClause — tolerates tabs / newlines / semicolons as separators', () => {
  assert.equal(
    rollClause('1000001000\t3093017710;13052686500\n2000002000'),
    "roll_number IN ('01000001000','03093017710','13052686500','02000002000')"
  );
});

test('rollClause — ampersand delimiter (with or without spaces) lists both rolls', () => {
  assert.equal(
    rollClause('03031870000 & 3031865000'),
    "roll_number IN ('03031870000','03031865000')"
  );
  assert.equal(
    rollClause('03031870000&3031865000'),
    "roll_number IN ('03031870000','03031865000')"
  );
});

test('rollClause — multi-token input with no digits anywhere → null', () => {
  assert.equal(rollClause('abc, def'), null);
});

test('rollClause — hard cap at 500 rolls', () => {
  const rolls = Array.from({ length: 501 }, (_, i) => String(10000000000 + i));
  const clause = rollClause(rolls.join(','));
  const quoted = (clause.match(/'/g) || []).length / 2;
  assert.equal(quoted, 500);
});

// ---------- normalizeRoll ----------

test('normalizeRoll — pads 10-digit rolls to the 11-digit canonical form', () => {
  assert.equal(normalizeRoll('6070731000'), '06070731000');
});

test('normalizeRoll — strips formatting before padding', () => {
  assert.equal(normalizeRoll('01-000-001-000'), '01000001000');
});

test('normalizeRoll — 11+ digit values pass through unchanged', () => {
  assert.equal(normalizeRoll('13052686500'), '13052686500');
  assert.equal(normalizeRoll('130526865001'), '130526865001');
});

test('normalizeRoll — no digits → null', () => {
  assert.equal(normalizeRoll('abc'), null);
  assert.equal(normalizeRoll(''), null);
});

// ---------- buildAddressClauses ----------

test('buildAddressClauses — equal From and To → exact street_number match', () => {
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '100', addressTo: '100', addressStreet: '' }),
    ['street_number = 100']
  );
});

test('buildAddressClauses — From < To → closed range', () => {
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '100', addressTo: '200', addressStreet: '' }),
    ['street_number BETWEEN 100 AND 200']
  );
});

test('buildAddressClauses — reversed bounds are normalised to min..max', () => {
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '200', addressTo: '100', addressStreet: '' }),
    ['street_number BETWEEN 100 AND 200']
  );
});

test('buildAddressClauses — open-ended bounds', () => {
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '100', addressTo: '', addressStreet: '' }),
    ['street_number >= 100']
  );
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '', addressTo: '200', addressStreet: '' }),
    ['street_number <= 200']
  );
});

// The column side strips apostrophes + periods via nested SoQL replace()
// (d4mq-wa44 stores "ST MARY'S", cam2-ii3u "ST MARYS", 143 rows carry
// periods) so punctuation variants match both datasets.
const STREET_COL = "upper(replace(replace(street_name,'''',''),'.',''))";

test('buildAddressClauses — street match is punctuation-insensitive on both sides', () => {
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '', addressTo: '', addressStreet: "O'Brien" }),
    [`${STREET_COL} like '%OBRIEN%'`]
  );
});

test('buildAddressClauses — number + street compose; garbage numbers are ignored', () => {
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '12', addressTo: '', addressStreet: 'Main' }),
    ['street_number >= 12', `${STREET_COL} like '%MAIN%'`]
  );
  assert.deepEqual(
    buildAddressClauses({ addressFrom: 'abc', addressTo: '-5', addressStreet: '' }),
    []
  );
});

test('buildAddressClauses — unit-address form "3-456" searches street number 456, not 3', () => {
  // Winnipeg unit addresses read "3-456 Main St"; street_number is the
  // trailing part (the unit lives in unit_number / full_address). parseInt
  // used to answer 3 and search the wrong block entirely.
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '3-456', addressTo: '', addressStreet: '' }),
    ['street_number >= 456']
  );
  assert.deepEqual(
    buildAddressClauses({ addressFrom: '3-456', addressTo: '3-456', addressStreet: '' }),
    ['street_number = 456']
  );
});

// ---------- normalizeStreetQuery ----------
// Every input in this matrix returned 0 rows against the live API before
// normalization (audit F4) despite matching 185-1,029 real parcels. Each
// rule only widens the substring LIKE, so normalization can never hide a
// match that the raw input would have found.

test('normalizeStreetQuery — the audit zero-result matrix now normalizes to matchable names', () => {
  assert.equal(normalizeStreetQuery("St. Mary's Rd"), 'ST MARYS');
  assert.equal(normalizeStreetQuery("St Mary's"), 'ST MARYS');
  assert.equal(normalizeStreetQuery('St Marys'), 'ST MARYS');
  assert.equal(normalizeStreetQuery('Saint Marys Road'), 'ST MARYS');
  assert.equal(normalizeStreetQuery('Portage Ave'), 'PORTAGE');
  assert.equal(normalizeStreetQuery('Portage Avenue'), 'PORTAGE');
  assert.equal(normalizeStreetQuery('Portage Ave E'), 'PORTAGE');
  assert.equal(normalizeStreetQuery("ST  MARY'S"), 'ST MARYS');   // doubled space
});

test('normalizeStreetQuery — French generics lead the written name but not street_name', () => {
  assert.equal(normalizeStreetQuery('Rue Marion'), 'MARION');
  assert.equal(normalizeStreetQuery('Boulevard Provencher'), 'PROVENCHER');
  assert.equal(normalizeStreetQuery('Avenue de la Cathedrale'), 'DE LA CATHEDRALE');
});

test('normalizeStreetQuery — single-token inputs are never stripped to nothing', () => {
  assert.equal(normalizeStreetQuery('Grove'), 'GROVE');     // type word as a name
  assert.equal(normalizeStreetQuery('Avenue'), 'AVENUE');   // lone generic stays
  assert.equal(normalizeStreetQuery('  '), '');
});

// ---------- zoningClause ----------

test('zoningClause — hyphen-insensitive on both sides of the LIKE', () => {
  assert.equal(zoningClause('R1-M'), "upper(replace(zoning,'-','')) like '%R1M%'");
  assert.equal(zoningClause('r1m'), "upper(replace(zoning,'-','')) like '%R1M%'");
});

test('zoningClause — empty / hyphen-only input → null', () => {
  assert.equal(zoningClause(''), null);
  assert.equal(zoningClause(null), null);
  assert.equal(zoningClause('--'), null);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
