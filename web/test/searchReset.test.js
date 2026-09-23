// The reset contract: what a new Search must not inherit from the last one.
//
// Ported from the Manitoba app (2026-09-13), where two pieces of per-result
// state — the Parcel Summary panel's selected row and a stashed count line —
// survived a second search and described the previous result set. Neither
// was a logic error; both were state nobody remembered to reset, in a module
// with dozens of top-level `let`s, which is precisely what a human review
// does not reliably catch and a list does.
//
// HOW IT CHECKS. runSearch clears most state indirectly, through helpers it
// calls (clearTable, setParcels, setCount) and helpers THEY call
// (renderTable, via runAssessmentSearch / runLegalSearch). So the reset
// SURFACE is runSearch plus every function it calls, two levels deep, and a
// variable counts as reset if it is assigned anywhere in that surface.
//
// This is a source-text check. It cannot prove the reset happens on every
// code path, and it is not a substitute for running two searches. What it
// does is make "new per-result state was added and nothing resets it" a
// build failure instead of something a user notices months later.
//
// Run: cd web && node test/searchReset.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawSrc = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

/**
 * Source with comments removed. Load-bearing: a comment that mentions a
 * reset call would otherwise satisfy the test after the call is deleted.
 * Line comments are cut only when the `//` is not part of a `://` URL and
 * not inside a string literal on that line.
 */
function stripComments(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlocks.split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

const src = stripComments(rawSrc);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** A top-level function's source, or null. They close with `}` at column 0. */
function fnBody(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) return null;
  const end = src.indexOf('\n}', m.index);
  return end < 0 ? null : src.slice(m.index, end + 2);
}

const calledBy = (body) => [...new Set(
  [...body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
)];

const searchBody = fnBody('runSearch');

/** runSearch plus every function it calls, and theirs — the code a search runs. */
const resetSurface = (() => {
  const seen = new Map();
  const visit = (name, depth) => {
    if (seen.has(name) || depth > 2) return;
    const body = name === 'runSearch' ? searchBody : fnBody(name);
    if (!body) return;
    seen.set(name, body);
    for (const callee of calledBy(body)) visit(callee, depth + 1);
  };
  visit('runSearch', 0);
  return [...seen.values()].join('\n');
})();

const isAssignedIn = (v, text) => new RegExp(`(^|[^.\\w])${v}\\s*=[^=]`).test(text);

// ---------------------------------------------------------------------------
// State that DESCRIBES THE CURRENT RESULT SET. Every one of these must be
// reset when a new search starts, or it describes the previous one.
// ---------------------------------------------------------------------------
const PER_RESULT = [
  'currentRows', 'fullRows', 'shapeShown', 'shapeTotal',
  'numberable', 'pinPoint', 'propertyRollOrder',
  'lastFullSurveyFc', 'lastFullAssessFc', 'lastSurveyFc', 'lastCountBase',
  'drawCapped',
  'deselectedRowKeys',   // row culling belongs to the result set it was done on
  // The map's sale-category colour assignment describes the sale set it
  // was built for; a property search clears it so the previous comp
  // search's colours cannot sit over unrelated parcels.
  'categoryColorSlots',
];

// State that SURVIVES a search on purpose. Listed with the reason, so the
// decision is recorded rather than rediscovered.
const PERSISTENT = {
  numberingOn: 'a display preference that should carry across searches',
  numberingEntryOrder: 'travels with numberingOn',
  pinOn: 'the one-parcel Locator choice (Shape or Pin), a display preference like numberingOn',
  currentSort: "the user's sort preference, not a property of the results",
  salesRollOrder: 'belongs to the sales import, which outlives a property search',
  lastChartRows: 'the charts tab mirrors the sales set; a property search does not publish to it',
  riseLookup: 'session memo for the storey-band lookup; refetching it per search would be waste',
  _clusterIndex: 'session memo for the neighbourhood-cluster index, built once',
  allClusterNames: 'the 23 cluster names off the static geojson, built once; a property search neither changes nor consumes them',
  zoningMode: 'an overlay preference (shaded / labels / off), not a property of the results',
  captureInFlight: 'transient guard around a Generate Map capture',
  urlWritePending: 'transient rAF throttle for the URL writer',
  chartsChannel: 'the BroadcastChannel to the charts tab, opened once',
  zoningAmendmentsIndex: 'session memo for the DMIS + Public Notices amendment index; keyed by roll, not by search',
  zoningAmendmentsLoad: 'the in-flight load of that index, shared by concurrent pill clicks',
};

console.log('main.js — what a new Search must not inherit');

test('runSearch exists and calls its reset helpers', () => {
  assert.ok(searchBody, 'runSearch not found in main.js');
  for (const helper of ['clearTable', 'resetShapesSilently']) {
    assert.match(searchBody, new RegExp(`\\b${helper}\\s*\\(`), `runSearch must call ${helper}`);
  }
});

test('every per-result variable is reset by a search', () => {
  const missing = PER_RESULT.filter((v) => !isAssignedIn(v, resetSurface));
  assert.deepEqual(missing, [],
    `state describing the last result set, never reset by a new search: ${missing.join(', ')}`);
});

test('every per-result variable actually exists', () => {
  const gone = PER_RESULT.filter((v) => !new RegExp(`^let ${v}\\b`, 'm').test(src));
  assert.deepEqual(gone, [], `listed but no longer declared in main.js: ${gone.join(', ')}`);
});

test('the row cull is dropped by a search, not merely defined', () => {
  assert.ok(isAssignedIn('deselectedRowKeys', searchBody),
    'runSearch must reset deselectedRowKeys itself');
});

test('persistent state is documented, not accidental', () => {
  for (const [v, reason] of Object.entries(PERSISTENT)) {
    assert.ok(reason && reason.length > 20, `${v} needs a real reason, not a placeholder`);
    assert.ok(!PER_RESULT.includes(v), `${v} cannot be both per-result and persistent`);
  }
});

test('new module state forces a decision', () => {
  // The point of the whole file. Any top-level `let` that is neither
  // classified above nor matched by a category rule is reported, so adding
  // per-result state without resetting it fails the build instead of
  // surfacing as a stale panel months later.
  const declared = [...src.matchAll(/^let ([a-zA-Z_$][\w$]*)\s*[=;]/gm)].map((m) => m[1]);
  const CATEGORY_RULES = [
    // overlay-scoped: toggled by their own buttons, not by a search
    /Enabled$/, /Loaded$/, /Mode$/, /^streets/, /^historical/,
    // sales-tab scoped: reset by a new sales import, not by a property search
    /^sales/, /^lastSales/,
  ];
  const unclassified = declared.filter((v) =>
    !PER_RESULT.includes(v)
    && !(v in PERSISTENT)
    && !CATEGORY_RULES.some((re) => re.test(v)));
  assert.deepEqual(unclassified, [],
    `new top-level state in main.js — decide whether a new Search must reset it, `
    + `then add it to PER_RESULT or PERSISTENT in this file: ${unclassified.join(', ')}`);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
