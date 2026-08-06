// Unit tests for scripts/stableWrite.mjs — the guard that stops an unchanged
// asset rebuild from rewriting the file (and so committing, pushing and
// deploying) just because its embedded build timestamp moved.
//
// Plain-node runner; run with
//   cd web && npm test
// or
//   node test/stableWrite.test.js

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStable, normalizeVolatile } from '../scripts/stableWrite.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    failed += 1;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'stablewrite-'));
const fc = (feats, generatedAt, extra = {}) => ({
  type: 'FeatureCollection',
  features: feats,
  _meta: { source: 'x', generated_at: generatedAt, ...extra },
});

console.log('');
console.log('stableWrite');

await test('normalizeVolatile blanks generated_at', () => {
  assert.equal(
    normalizeVolatile('{"a":1,"generated_at":"2026-07-01T12:00:00.000Z"}'),
    '{"a":1,"generated_at":"<normalized>"}',
  );
});

await test('normalizeVolatile blanks EVERY occurrence', () => {
  const out = normalizeVolatile('{"generated_at":"a","x":{"generated_at":"b"}}');
  assert.equal(out.match(/<normalized>/g).length, 2);
});

await test('normalizeVolatile leaves other fields alone', () => {
  const s = '{"stop_name":"Westbound Egesz at Benbow"}';
  assert.equal(normalizeVolatile(s), s);
});

await test('a file that does not exist yet is written as new', async () => {
  const p = path.join(dir, 'new.json');
  const res = await writeStable(p, fc([1], '2026-01-01T00:00:00.000Z'));
  assert.equal(res.written, true);
  assert.equal(res.reason, 'new');
  assert.match(readFileSync(p, 'utf8'), /2026-01-01/);
});

await test('THE BUG: only generated_at differs -> not rewritten', async () => {
  const p = path.join(dir, 'ts.json');
  await writeStable(p, fc([1, 2], '2026-07-01T12:52:04.501Z'));
  const before = readFileSync(p, 'utf8');
  const mtimeBefore = statSync(p).mtimeMs;

  const res = await writeStable(p, fc([1, 2], '2026-08-06T12:38:02.839Z'));
  assert.equal(res.written, false, 'should not have written');
  assert.equal(res.reason, 'unchanged');
  assert.equal(readFileSync(p, 'utf8'), before, 'bytes must be untouched');
  assert.equal(statSync(p).mtimeMs, mtimeBefore, 'mtime must be untouched too');
  assert.match(readFileSync(p, 'utf8'), /2026-07-01/, 'keeps the ORIGINAL timestamp');
});

await test('a real data change IS written, new timestamp and all', async () => {
  const p = path.join(dir, 'data.json');
  await writeStable(p, fc([{ stop_name: 'Markwood' }], '2026-07-01T00:00:00.000Z'));
  const res = await writeStable(p, fc([{ stop_name: 'Benbow' }], '2026-08-06T00:00:00.000Z'));
  assert.equal(res.written, true);
  assert.equal(res.reason, 'changed');
  const after = readFileSync(p, 'utf8');
  assert.match(after, /Benbow/);
  assert.match(after, /2026-08-06/);
});

await test('a change in a non-feature meta field is still a change', async () => {
  const p = path.join(dir, 'meta.json');
  await writeStable(p, fc([1], '2026-07-01T00:00:00.000Z', { count: 235 }));
  const res = await writeStable(p, fc([1], '2026-08-06T00:00:00.000Z', { count: 236 }));
  assert.equal(res.written, true, 'a changed count must not be masked by the timestamp rule');
});

await test('identical input twice in a row is a no-op the second time', async () => {
  const p = path.join(dir, 'same.json');
  const obj = fc([1, 2, 3], '2026-08-06T00:00:00.000Z');
  assert.equal((await writeStable(p, obj)).reason, 'new');
  assert.equal((await writeStable(p, obj)).reason, 'unchanged');
});

await test('an unparseable/garbage existing file is overwritten, not preserved', async () => {
  const p = path.join(dir, 'garbage.json');
  writeFileSync(p, 'this is not json at all');
  const res = await writeStable(p, fc([1], '2026-08-06T00:00:00.000Z'));
  assert.equal(res.written, true, 'must not treat garbage as equivalent');
  assert.equal(res.reason, 'changed');
});

rmSync(dir, { recursive: true, force: true });

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
