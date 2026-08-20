// Ranking + indexing rules behind the Property Search street-name
// typeahead. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/streetSuggest.test.js
//
// The fixture is a slice of the real d4mq-wa44 group-by
// (street_name, street_type, count(*)) with the counts as measured on
// 2026-08-20, so the ordering assertions below are the ordering the live
// list actually produces.
import assert from 'node:assert/strict';
import {
  suggestKey,
  buildStreetIndex,
  streetNameSet,
  suggestStreets,
  suggestHint,
  STREET_SUGGEST_MIN_QUERY,
} from '../src/lib/streetSuggest.js';

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
}

const ROWS = [
  // One name, three types — the shape 127 real names have.
  { street_name: 'ASSINIBOINE', street_type: 'AVENUE', n: 333 },
  { street_name: 'ASSINIBOINE', street_type: 'CRESCENT', n: 94 },
  { street_name: 'ASSINIBOINE', street_type: 'GROVE', n: 22 },
  { street_name: 'EAU-CLAIRE', street_type: 'DRIVE', n: 78 },
  { street_name: 'ELM', street_type: 'STREET', n: 260 },
  { street_name: 'ELM PARK', street_type: 'ROAD', n: 105 },
  { street_name: 'MIDDLE GATE', street_type: '', n: 40 },
  { street_name: 'PARK', street_type: 'BOULEVARD', n: 139 },
  { street_name: 'PARK', street_type: 'PLACE', n: 105 },
  { street_name: 'PARK', street_type: 'CIRCLE', n: 25 },
  { street_name: 'PARK EAST', street_type: 'DRIVE', n: 237 },
  { street_name: 'PARK WEST', street_type: 'DRIVE', n: 149 },
  { street_name: 'PORT', street_type: 'PLACE', n: 8 },
  { street_name: 'PORTAGE', street_type: 'AVENUE', n: 1029 },
  { street_name: 'PORTSMOUTH', street_type: 'BOULEVARD', n: 228 },
  { street_name: 'PORTLAND', street_type: 'AVENUE', n: 123 },
  { street_name: "ST MARY'S", street_type: 'ROAD', n: 1004 },
  { street_name: 'WILDWOOD E', street_type: 'PARK', n: 34 },
  // The roll's 3,196 address-less parcels group into one blank bucket.
  { street_name: '', street_type: '', n: 3196 },
];

const INDEX = buildStreetIndex(ROWS);
const names = (list) => list.map((e) => e.name);

// ---- suggestKey -----------------------------------------------------------
test('suggestKey folds case, punctuation, hyphens and doubled spaces', () => {
  assert.equal(suggestKey("  st. mary's  rd "), 'ST MARYS RD');
  assert.equal(suggestKey('Eau-Claire'), 'EAU CLAIRE');
  assert.equal(suggestKey(null), '');
});

// ---- buildStreetIndex -----------------------------------------------------
test('buildStreetIndex folds the type rows into one entry per NAME', () => {
  // Name-only because that is the granularity the search works at:
  // street_name is its own column and the clause never touches the type.
  const a = INDEX.find((e) => e.name === 'ASSINIBOINE');
  assert.equal(a.count, 333 + 94 + 22);
  // Types ordered by parcel count, so the dominant one reads first.
  assert.deepEqual(a.types, ['AVENUE', 'CRESCENT', 'GROVE']);
});

test('buildStreetIndex drops the blank-name bucket', () => {
  // 3,196 parcels on the real roll carry no address at all. Left in,
  // they would be an unpickable empty row at the top of the list.
  assert.equal(INDEX.some((e) => e.name === ''), false);
  // 19 rows, ASSINIBOINE and PARK each fold 3 types into 1, blank dropped.
  assert.equal(INDEX.length, 14);
});

test('buildStreetIndex tolerates an empty or missing row set', () => {
  assert.deepEqual(buildStreetIndex(), []);
  assert.deepEqual(buildStreetIndex([]), []);
});

test('streetNameSet keys on the CLAUSE form, apostrophes stripped', () => {
  // This set is what teaches normalizeStreetQuery which names are real,
  // so it has to fold exactly the way the SoQL side folds the column.
  const set = streetNameSet(ROWS);
  assert.equal(set.has('ST MARYS'), true);
  assert.equal(set.has('PARK EAST'), true);
  // NOT hyphen-folded: the clause does not strip hyphens off the column.
  assert.equal(set.has('EAU-CLAIRE'), true);
  assert.equal(set.has('EAU CLAIRE'), false);
  assert.equal(set.has(''), false);
});

// ---- suggestStreets: the tiers --------------------------------------------
test('suggestStreets ranks whole name, then prefix, then word-start, then anywhere', () => {
  assert.deepEqual(names(suggestStreets(INDEX, 'PARK')), ['PARK', 'PARK EAST', 'PARK WEST', 'ELM PARK']);
  // PORT is the whole-name hit and leads on 8 parcels over PORTAGE's
  // 1,029 — tier beats count, by a factor of 128 here.
  assert.deepEqual(
    names(suggestStreets(INDEX, 'PORT')),
    ['PORT', 'PORTAGE', 'PORTSMOUTH', 'PORTLAND'],
  );
});

test('suggestStreets breaks a tier tie by parcel count, not the alphabet', () => {
  // PORTSMOUTH (228) and PORTLAND (123) are both prefix hits, and this is
  // the pair where the two orderings disagree: alphabetical puts PORTLAND
  // first. An appraiser scanning the list wants the bigger street first.
  const p = names(suggestStreets(INDEX, 'PORT'));
  assert.ok(p.indexOf('PORTSMOUTH') < p.indexOf('PORTLAND'));
});

test('suggestStreets honours the limit', () => {
  assert.equal(suggestStreets(INDEX, 'PARK', 2).length, 2);
});

// ---- suggestStreets: the two passes ---------------------------------------
test('a name that ENDS in a type word is matched literally, not truncated', () => {
  // The whole point. "PARK EAST" is a real street with 237 parcels; if
  // the query were normalized first it would become "PARK" and offer
  // every PARK-something street instead.
  assert.deepEqual(names(suggestStreets(INDEX, 'PARK EAST')), ['PARK EAST']);
  assert.deepEqual(names(suggestStreets(INDEX, 'ELM PARK')), ['ELM PARK']);
  assert.deepEqual(names(suggestStreets(INDEX, 'MIDDLE GATE')), ['MIDDLE GATE']);
  assert.deepEqual(names(suggestStreets(INDEX, 'WILDWOOD E')), ['WILDWOOD E']);
});

test('the type-stripping fallback only fires when the literal pass finds nothing', () => {
  // No street is NAMED "PORTAGE AVE", so this falls through to
  // normalizeStreetQuery and offers PORTAGE.
  assert.deepEqual(names(suggestStreets(INDEX, 'Portage Ave')), ['PORTAGE']);
  // The fallback re-runs the FULL ranking on the widened query, so it
  // offers the same set typing "ELM" would.
  assert.deepEqual(names(suggestStreets(INDEX, 'Elm Street')), ['ELM', 'ELM PARK']);
  // Genuinely absent stays absent — the fallback must not invent a hit.
  assert.deepEqual(suggestStreets(INDEX, 'ZZZZ'), []);
});

test('punctuation and hyphens in the typing still reach the roll spelling', () => {
  assert.deepEqual(names(suggestStreets(INDEX, "st. mary's")), ["ST MARY'S"]);
  assert.deepEqual(names(suggestStreets(INDEX, 'st marys')), ["ST MARY'S"]);
  // Five real names carry hyphens; typing the space is the natural way.
  assert.deepEqual(names(suggestStreets(INDEX, 'eau claire')), ['EAU-CLAIRE']);
  assert.deepEqual(names(suggestStreets(INDEX, 'EAU-CLAIRE')), ['EAU-CLAIRE']);
});

test('suggestStreets stays shut below the minimum query length', () => {
  assert.equal(STREET_SUGGEST_MIN_QUERY, 2);
  assert.deepEqual(suggestStreets(INDEX, 'P'), []);
  assert.deepEqual(suggestStreets(INDEX, ' '), []);
  assert.deepEqual(suggestStreets(INDEX, ''), []);
  assert.deepEqual(suggestStreets(INDEX, null), []);
});

test('suggestStreets survives a missing index rather than throwing', () => {
  // The list loads lazily and the fetch can fail; a typeahead that
  // cannot load must not stop anyone typing a street name.
  assert.deepEqual(suggestStreets(null, 'PORTAGE'), []);
  assert.deepEqual(suggestStreets([], 'PORTAGE'), []);
});

// ---- suggestHint ----------------------------------------------------------
test('suggestHint names every type the street has, then the count', () => {
  const a = INDEX.find((e) => e.name === 'ASSINIBOINE');
  assert.equal(suggestHint(a), 'AVENUE · CRESCENT · GROVE · 449 parcels');
  // 29 names carry a BLANK street_type. Still says something useful.
  const m = INDEX.find((e) => e.name === 'MIDDLE GATE');
  assert.equal(suggestHint(m), '40 parcels');
  assert.equal(suggestHint({ types: [], count: 1 }), '1 parcel');
});

console.log('streetSuggest.test.js: all assertions passed');
