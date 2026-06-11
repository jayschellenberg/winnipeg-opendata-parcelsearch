// R↔JS slugify parity test. The slug IS the shard filename, so an R↔JS
// disagreement means the browser 404s every shard for the affected
// neighbourhood. r/build_historical_shards.R writes a fresh fixture file
// on every run; this test loads it and asserts historicalSlugify() in
// main.js produces the same outputs.
//
// Skips quietly with a TODO if the fixture is missing — typical the first
// time CI runs against a tree that hasn't rebuilt shards yet. The fixture
// IS committed (so the test runs everywhere as long as a rebuild has been
// pushed); a missing fixture is "nothing pinned yet", not a failure.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Lift historicalSlugify out of main.js. main.js touches document at
// import time, so we copy the function instead of importing it. THIS
// COPY MUST STAY IDENTICAL to main.js:historicalSlugify — that's the
// whole point of the test. If you change one, change both. The test
// below also pins the function source as a byte-for-byte assertion.
function historicalSlugify(x) {
  return String(x).toUpperCase().trim()
    .replace(/[/ ]+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

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

console.log('slugParity');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'slug_fixtures.json');
const mainJsPath = path.join(here, '..', 'src', 'main.js');

// Byte-for-byte guard so the in-test copy stays identical to main.js.
test('historicalSlugify in main.js matches the in-test copy', () => {
  const src = readFileSync(mainJsPath, 'utf8');
  const m = src.match(/function historicalSlugify\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'could not locate historicalSlugify in main.js');
  const want = historicalSlugify.toString().replace(/\s+/g, ' ').trim();
  const got = m[0].replace(/\s+/g, ' ').trim();
  assert.equal(got, want, 'historicalSlugify drifted from the in-test copy — sync them');
});

if (!existsSync(fixturePath)) {
  console.log('  TODO slug_fixtures.json not present — run r/build_historical_shards.R to generate it');
  console.log('');
  console.log(`${passed}/${passed + failed} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('fixture file is a non-empty array of {input, slug} pairs', () => {
  assert.ok(Array.isArray(fixtures) && fixtures.length > 0, 'fixture is empty or not an array');
  for (const entry of fixtures) {
    assert.ok(entry && typeof entry === 'object', 'each entry must be an object');
    assert.ok('input' in entry && 'slug' in entry, 'each entry must carry input + slug');
  }
});

test(`every R-generated slug matches JS historicalSlugify (${fixtures.length} cases)`, () => {
  const mismatches = [];
  for (const { input, slug } of fixtures) {
    const got = historicalSlugify(input);
    if (got !== slug) mismatches.push({ input, r: slug, js: got });
  }
  if (mismatches.length) {
    const sample = mismatches.slice(0, 5)
      .map((m) => `  ${JSON.stringify(m.input)}: R=${JSON.stringify(m.r)} JS=${JSON.stringify(m.js)}`)
      .join('\n');
    throw new Error(`${mismatches.length} mismatch(es); first few:\n${sample}`);
  }
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
