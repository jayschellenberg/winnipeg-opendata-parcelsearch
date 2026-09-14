// R↔JS slugify parity test. The slug IS the shard filename, so an R↔JS
// disagreement means the browser 404s every shard for the affected
// neighbourhood. r/build_historical_shards.R writes a fresh fixture file
// on every run; this test loads it and asserts historicalSlugify() in
// lib/historicalSlug.js produces the same outputs.
//
// Skips quietly with a TODO if the fixture is missing — typical the first
// time CI runs against a tree that hasn't rebuilt shards yet. The fixture
// IS committed (so the test runs everywhere as long as a rebuild has been
// pushed); a missing fixture is "nothing pinned yet", not a failure.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The app's slugify lives in lib/historicalSlug.js (main.js touches document at
// import time, so it cannot be imported here; the lib can).
import { historicalSlugify } from '../src/lib/historicalSlug.js';

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
