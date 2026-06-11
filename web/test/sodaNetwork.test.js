// Network-behaviour tests for src/soda.js, run against a stubbed
// globalThis.fetch — no real requests. Plain-node runner; run with
//   cd web && npm test
// or
//   node test/sodaNetwork.test.js
//
// Pins two behaviours that exist specifically because of past incidents:
//   1. fetchSoda retries transient 5xx / network errors (added in 559f4f8,
//      silently removed by the 1348c06 "simplify" pass, restored in
//      Milestone 1 — this test is what keeps it from vanishing again).
//   2. fetchCurrentAssessmentInBbox reports `complete: false` when its page
//      loop is cut short, so the historical overlay never marks parcels
//      "gone" off a partial fetch.

import assert from 'node:assert/strict';
import { fetchSoda, fetchCurrentAssessmentInBbox } from '../src/soda.js';

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
