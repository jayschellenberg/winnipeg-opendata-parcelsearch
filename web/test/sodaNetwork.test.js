// Network-behaviour tests for src/soda.js, run against a stubbed
// globalThis.fetch — no real requests. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/sodaNetwork.test.js
//
// Pins three behaviours that exist specifically because of past incidents:
//   1. fetchSoda retries transient 5xx / network errors (added in 559f4f8,
//      silently removed by the 1348c06 "simplify" pass, restored in
//      Milestone 1 — this test is what keeps it from vanishing again).
//   2. fetchCurrentAssessmentInBbox reports `complete: false` when its page
//      loop is cut short, so the historical overlay never marks parcels
//      "gone" off a partial fetch.
//   3. Every spatial join asks an INTERSECTION predicate, never within_box.
//      within_box is a containment test that drops any target geometry
//      larger than the query box — silently, with no error and no empty
//      result, just quietly fewer rows. It had broken four joins at once.

import assert from 'node:assert/strict';
import {
  fetchSoda,
  fetchCurrentAssessmentInBbox,
  searchAssessmentParcelsByRolls,
  fetchSurveyOverlap,
  fetchZoningOverlap,
  fetchAssessmentOverlap,
  searchAssessmentParcelsExpanded,
  isHistoricalPinStale,
} from '../src/soda.js';

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// Install a scripted fetch stub. Each entry is either
//   { status, json?, text? }  → returned as a Response-like object
//   { throw: <error> }        → fetch rejects with that error
// Returns the array of URLs fetch was called with.
const realFetch = globalThis.fetch;
const realWarn = console.warn;
function stubFetch(script) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const step = script.shift();
    if (!step) throw new Error('mock fetch: script exhausted');
    if (step.throw) throw step.throw;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.json,
      text: async () => step.text ?? '',
    };
  };
  return calls;
}

console.log('sodaNetwork');

// ---------- fetchSoda retry ----------

const FAST = { retries: 2, retryDelayMs: 1 };

test('fetchSoda — 500 → 500 → 200 succeeds after retries', async () => {
  const calls = stubFetch([
    { status: 500, text: 'Internal error: please include code abc' },
    { status: 500, text: 'Internal error: please include code def' },
    { status: 200, json: { a: 1 } },
  ]);
  const out = await fetchSoda('https://example.test/x.json', FAST);
  assert.deepEqual(out, { a: 1 });
  assert.equal(calls.length, 3);
});

test('fetchSoda — 4xx fails immediately, no retry', async () => {
  const calls = stubFetch([
    { status: 404, text: 'no such dataset' },
  ]);
  await assert.rejects(
    () => fetchSoda('https://example.test/x.json', FAST),
    /SODA 404/
  );
  assert.equal(calls.length, 1);
});

test('fetchSoda — network TypeError is retried, then succeeds', async () => {
  const calls = stubFetch([
    { throw: new TypeError('fetch failed') },
    { status: 200, json: [] },
  ]);
  const out = await fetchSoda('https://example.test/x.json', FAST);
  assert.deepEqual(out, []);
  assert.equal(calls.length, 2);
});

test('fetchSoda — persistent 5xx exhausts retries and surfaces the SODA error', async () => {
  const calls = stubFetch([
    { status: 503, text: 'down' },
    { status: 503, text: 'down' },
    { status: 503, text: 'still down' },
  ]);
  await assert.rejects(
    () => fetchSoda('https://example.test/x.json', FAST),
    /SODA 503/
  );
  assert.equal(calls.length, 3);
});

test('fetchSoda — clean 200 makes exactly one request', async () => {
  const calls = stubFetch([{ status: 200, json: { ok: true } }]);
  await fetchSoda('https://example.test/x.json', FAST);
  assert.equal(calls.length, 1);
});

// ---------- fetchCurrentAssessmentInBbox completeness ----------

const BBOX = [-97.2, 49.8, -97.1, 49.9];

test('fetchCurrentAssessmentInBbox — short page → rows + complete: true', async () => {
  const rows = [
    { roll_number: '01000001000', assessed_land_area: '5000' },
    { roll_number: '01000002000', assessed_land_area: '6200' },
  ];
  stubFetch([{ status: 200, json: rows }]);
  const out = await fetchCurrentAssessmentInBbox(BBOX);
  assert.deepEqual(out.rows, rows);
  assert.equal(out.complete, true);
});

test('fetchCurrentAssessmentInBbox — non-OK response → complete: false (never fake-complete)', async () => {
  stubFetch([{ status: 500, text: 'blip' }]);
  const out = await fetchCurrentAssessmentInBbox(BBOX);
  assert.deepEqual(out.rows, []);
  assert.equal(out.complete, false);
});

test('fetchCurrentAssessmentInBbox — thrown fetch → complete: false', async () => {
  stubFetch([{ throw: new TypeError('fetch failed') }]);
  const out = await fetchCurrentAssessmentInBbox(BBOX);
  assert.deepEqual(out.rows, []);
  assert.equal(out.complete, false);
});

test('fetchCurrentAssessmentInBbox — invalid bbox → empty + incomplete, no request', async () => {
  const calls = stubFetch([]);
  const out = await fetchCurrentAssessmentInBbox([1, 2, NaN, 4]);
  assert.deepEqual(out, { rows: [], complete: false });
  assert.equal(calls.length, 0);
});

test('fetchCurrentAssessmentInBbox — every page is ordered by roll_number (audit F1)', async () => {
  // Without $order, Socrata's page order is replica-dependent: measured on a
  // real cluster bbox, two unordered runs each dropped ~3.8k rolls the other
  // run returned — every dropped roll rendered as a false grey "gone" parcel.
  // This pins the $order param on EVERY page of the loop so a future
  // "simplify" pass can't reintroduce it (the 1348c06 failure mode).
  const fullPage = Array.from({ length: 5000 }, (_, i) => ({
    roll_number: String(10000000000 + i),
    assessed_land_area: '5000',
  }));
  const shortPage = [{ roll_number: '99999999999', assessed_land_area: '100' }];
  const calls = stubFetch([
    { status: 200, json: fullPage },
    { status: 200, json: shortPage },
  ]);
  const out = await fetchCurrentAssessmentInBbox(BBOX);
  assert.equal(calls.length, 2);
  for (const url of calls) {
    assert.ok(url.includes('$order=roll_number'), `page not ordered: ${url}`);
  }
  assert.equal(out.rows.length, 5001);
  assert.equal(out.complete, true);
});

// ---------- paddedBoxes null-geometry guard (audit F3) ----------
// d4mq-wa44 carries ~59 geometry:null rows (bus shelters, pipelines, some
// condo unit rolls). turf bbox() yields ±Infinity for them, and one clause
// built from an Infinity used to 400 the whole 50-feature batch
// — killing legal-description/zoning/address enrichment for every row of the
// search. Exercised through fetchSurveyOverlap, the assessment-flow caller.

const VALID_SQUARE = {
  type: 'Feature',
  properties: { roll_number: '01000001000' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[-97.14, 49.89], [-97.13, 49.89], [-97.13, 49.90], [-97.14, 49.90], [-97.14, 49.89]]],
  },
};
const NULL_GEOM = { type: 'Feature', properties: { roll_number: '12097805410' }, geometry: null };
const EMPTY_FC_PAGE = { status: 200, json: { type: 'FeatureCollection', features: [] } };

test('fetchSurveyOverlap — null-geometry features are skipped, not turned into Infinity clauses', async () => {
  const calls = stubFetch([EMPTY_FC_PAGE]);
  await fetchSurveyOverlap({ type: 'FeatureCollection', features: [VALID_SQUARE, NULL_GEOM] });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('Infinity'), `Infinity leaked into the query: ${calls[0]}`);
  assert.ok(decodeURIComponent(calls[0]).includes('intersects(location,'), 'valid feature still queried');
});

test('fetchSurveyOverlap — all features geometry-less → no request, empty result', async () => {
  const calls = stubFetch([]);
  const fc = await fetchSurveyOverlap({ type: 'FeatureCollection', features: [NULL_GEOM] });
  assert.equal(calls.length, 0);
  assert.equal(fc.features.length, 0);
});

// ---------- historical pin staleness comparator (audit H-1) ----------
// The historical CDN pin is bumped by hand; this comparator drives the console
// backstop that warns when branch-HEAD is newer than the pin. Only fires on a
// strictly-newer HEAD, so it can never false-alarm during jsDelivr's @main lag.

test('isHistoricalPinStale — HEAD strictly newer than pin → true', () => {
  assert.equal(
    isHistoricalPinStale('2026-06-01T12:00:00-0500', '2026-07-01T12:56:44-0500'),
    true,
  );
});

test('isHistoricalPinStale — HEAD older or equal to pin → false (no false alarm)', () => {
  // equal = correctly-bumped pin
  assert.equal(isHistoricalPinStale('2026-07-01T12:56:44-0500', '2026-07-01T12:56:44-0500'), false);
  // older = jsDelivr @main still lagging behind a fresh pin
  assert.equal(isHistoricalPinStale('2026-07-01T12:56:44-0500', '2026-06-01T12:00:00-0500'), false);
});

test('isHistoricalPinStale — unparseable timestamps → false (never a false alarm)', () => {
  assert.equal(isHistoricalPinStale(undefined, '2026-07-01T00:00:00-0500'), false);
  assert.equal(isHistoricalPinStale('2026-07-01T00:00:00-0500', 'garbage'), false);
  assert.equal(isHistoricalPinStale(null, null), false);
});

// ---------- searchAssessmentParcelsByRolls (chunking) ----------
// Sales CSVs can ship thousands of rolls; the old single-call path was
// silently truncated past 500 by rollClause's IN-list cap and then
// reported the dropped rolls as "not in d4mq-wa44". These pin the new
// chunked-and-merged behaviour.

// Stub helper that returns a GeoJSON FeatureCollection of as many
// features as IN-list entries it saw in the query (so the test can
// observe which rolls each chunk requested). URLSearchParams encodes
// spaces as `+`, so decode the query string before pattern-matching.
function stubChunkedFetch() {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const query = u.includes('?') ? u.slice(u.indexOf('?') + 1) : '';
    const decoded = decodeURIComponent(query.replace(/\+/g, ' '));
    const m = decoded.match(/IN \(([^)]+)\)/);
    const rolls = m ? m[1].split(',').map((s) => s.replace(/'/g, '').trim()) : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        type: 'FeatureCollection',
        features: rolls.map((r) => ({
          type: 'Feature',
          properties: { roll_number: r },
          geometry: null,
        })),
      }),
      text: async () => '',
    };
  };
  return calls;
}

test('searchAssessmentParcelsByRolls — empty input → no request, empty FC', async () => {
  const calls = stubChunkedFetch();
  const fc = await searchAssessmentParcelsByRolls([]);
  assert.equal(fc.features.length, 0);
  assert.equal(calls.length, 0);
});

test('searchAssessmentParcelsByRolls — small list fires one chunk, no meta marker', async () => {
  const calls = stubChunkedFetch();
  const rolls = Array.from({ length: 50 }, (_, i) => String(10000000000 + i));
  const fc = await searchAssessmentParcelsByRolls(rolls);
  assert.equal(fc.features.length, 50);
  assert.equal(calls.length, 1);
  assert.equal(fc.meta?.chunkCount, undefined);   // single chunk = no marker
});

test('searchAssessmentParcelsByRolls — 600 rolls split into two parallel chunks, merged', async () => {
  const calls = stubChunkedFetch();
  const rolls = Array.from({ length: 600 }, (_, i) => String(20000000000 + i));
  const fc = await searchAssessmentParcelsByRolls(rolls);
  assert.equal(calls.length, 2);
  assert.equal(fc.features.length, 600);
  assert.equal(fc.meta.chunkCount, 2);
  assert.equal(fc.meta.rollCount, 600);
});

test('searchAssessmentParcelsByRolls — distinct dedup happens before chunking', async () => {
  const calls = stubChunkedFetch();
  const rolls = [...Array(300).fill('30000000001'), '30000000002'];   // 301 entries, 2 distinct
  const fc = await searchAssessmentParcelsByRolls(rolls);
  assert.equal(calls.length, 1);
  assert.equal(fc.features.length, 2);
});

test('searchAssessmentParcelsByRolls — 2000 rolls split into four parallel chunks', async () => {
  // Real production-scale scenario: a large appraisal sales CSV with
  // ~2000 distinct rolls. Old single-call path would silently truncate
  // to the first 500 and report the rest as "not in d4mq-wa44" — the
  // exact bug audit M3.1 was opened to fix.
  const calls = stubChunkedFetch();
  const rolls = Array.from({ length: 2000 }, (_, i) => String(50000000000 + i));
  const fc = await searchAssessmentParcelsByRolls(rolls);
  assert.equal(calls.length, 4);
  assert.equal(fc.features.length, 2000);
  assert.equal(fc.meta.chunkCount, 4);
  assert.equal(fc.meta.rollCount, 2000);
});

// ---------- which spatial predicate each join asks for ----------
//
// SoQL within_box is a CONTAINMENT test, not an intersection test: it drops
// any target geometry larger than the query box, silently and in proportion
// to that size. Two joins were built on it and both were wrong — the address
// cross-reference could not see a parcel bigger than the pad (1393 BORDER ST
// found nothing), and the zoning overlap dropped the district covering the
// parcel on 26 of 26 Border St lots. Both now ask `intersects`. These pin the
// predicate, because a regression here reports no error and no empty result
// — just quietly fewer rows.

const PARCEL_FC = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { roll_number: '07560170500' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-97.20129, 49.91235], [-97.19992, 49.91235],
        [-97.19992, 49.91632], [-97.20129, 49.91632], [-97.20129, 49.91235],
      ]],
    },
  }],
};
const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };

// URLSearchParams writes spaces as '+', which decodeURIComponent leaves alone.
const readWhere = (url) => decodeURIComponent(String(url)).replace(/\+/g, ' ');

test('fetchZoningOverlap asks intersects, never within_box', async () => {
  const calls = stubFetch([{ status: 200, json: EMPTY_GEOJSON }]);
  await fetchZoningOverlap(PARCEL_FC);
  assert.equal(calls.length, 1);
  const where = readWhere(calls[0]);
  // A zoning district dwarfs the lot it governs, so containment can only lose it.
  assert.ok(!where.includes('within_box'), `still asking within_box: ${where}`);
  assert.match(where, /intersects\(location,'POLYGON\(\(/);
  // Five corners, closed ring — a rectangle, not the parcel's own outline,
  // which would run to hundreds of vertices and blow the URL budget.
  const ring = where.match(/POLYGON\(\((.*?)\)\)/)[1].split(',');
  assert.equal(ring.length, 5);
  assert.equal(ring[0].trim(), ring[4].trim());
});

test('the address cross-reference asks intersects on the POINT', async () => {
  // Direct attribute query, then the address-point query, then the
  // cross-reference; enrichment calls follow and get the same empty answer.
  const calls = stubFetch(Array.from({ length: 12 }, () => ({
    status: 200,
    json: [{ full_address: '1393 BORDER ST', point: { type: 'Point', coordinates: [-97.200279, 49.915458] } }],
  })));
  await searchAssessmentParcelsExpanded({ addressFrom: '1393', addressTo: '1393', addressStreet: 'BORDER' });
  const xref = calls.map(readWhere).find((u) => u.includes('intersects(geometry'));
  assert.ok(xref, `no intersects query was issued:\n${calls.map(decodeURIComponent).join('\n')}`);
  assert.match(xref, /intersects\(geometry,'POINT\(-97\.200279\d* 49\.915458\d*\)'\)/);
});

test('fetchAssessmentOverlap asks intersects — an assessment parcel is bigger than a survey lot', async () => {
  const calls = stubFetch([{ status: 200, json: EMPTY_GEOJSON }]);
  await fetchAssessmentOverlap(PARCEL_FC);
  const where = readWhere(calls[0]);
  assert.ok(!where.includes('within_box'), `still asking within_box: ${where}`);
  assert.match(where, /intersects\(geometry,'POLYGON\(\(/);
});

test('fetchSurveyOverlap asks intersects — River Lot / Outer Two Mile parcels are enormous', async () => {
  const calls = stubFetch([{ status: 200, json: EMPTY_GEOJSON }]);
  await fetchSurveyOverlap(PARCEL_FC);
  const where = readWhere(calls[0]);
  assert.ok(!where.includes('within_box'), `still asking within_box: ${where}`);
  assert.match(where, /intersects\(location,'POLYGON\(\(/);
});

test('fetchCurrentAssessmentInBbox asks intersects — a missing roll here paints a false "gone"', async () => {
  const calls = stubFetch([{ status: 200, json: [] }]);
  const { rows, complete } = await fetchCurrentAssessmentInBbox([-97.20129, 49.91235, -97.19992, 49.91632]);
  assert.deepEqual(rows, []);
  assert.equal(complete, true);
  const where = readWhere(calls[0]);
  assert.ok(!where.includes('within_box'), `still asking within_box: ${where}`);
  assert.match(where, /intersects\(geometry,'POLYGON\(\(/);
  assert.match(String(calls[0]), /d4mq-wa44\.json/);
});

test('the padded-bbox rectangle is a rectangle, not the parcel outline', async () => {
  // A parcel runs to hundreds of vertices; sending it as WKT would blow the
  // URL budget. Five corners is the whole point of the bbox form.
  const calls = stubFetch([{ status: 200, json: EMPTY_GEOJSON }]);
  await fetchSurveyOverlap(PARCEL_FC);
  const ring = readWhere(calls[0]).match(/POLYGON\(\((.*?)\)\)/)[1].split(',');
  assert.equal(ring.length, 5);
  assert.equal(ring[0].trim(), ring[4].trim());
});

// ---------- async runner ----------

let passed = 0;
let failed = 0;
console.warn = () => {};   // silence the expected retry warnings
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`  ✗ ${name}\n    ${err.message}`);
      failed += 1;
    }
  }
} finally {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
}

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
