// lib/reportData.js and report/report.css are SHARED FILES with the Manitoba
// app (mb-parcelsearch). When the sister checkout is present, they must be
// byte-identical; the Manitoba repo carries the unit tests for reportData.js.
// Skips cleanly on a machine without the sister checkout (e.g. Vercel).
//
// Run: cd web && node test/reportShared.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceM, nearby, censusColumns } from '../src/lib/reportData.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SISTER = 'D:/Dropbox/ClaudeCode/MBOpenData/mb-parcelsearch/web';
const pairs = [['src/lib/reportData.js', 'src/lib/reportData.js'], ['src/report/report.css', 'src/report/report.css']];

let failed = 0;
const norm = (s) => s.replace(/\r\n/g, '\n');
if (fs.existsSync(SISTER)) {
  for (const [mine, theirs] of pairs) {
    const a = norm(fs.readFileSync(path.join(here, '..', mine), 'utf8'));
    const b = norm(fs.readFileSync(path.join(SISTER, theirs), 'utf8'));
    if (a === b) console.log(`  ✓ ${mine} matches mb-parcelsearch`);
    else { failed++; console.log(`  ✗ ${mine} differs from mb-parcelsearch/${theirs}`); }
  }
} else {
  console.log('  - sister checkout not found; parity check skipped');
}

// A smoke test that runs everywhere.
try {
  assert.ok(Math.abs(distanceM(49.9, -97.14, 49.9, -97.126) - 1003) < 30);
  assert.equal(nearby([{ geometry: { type: 'Point', coordinates: [-97.14, 49.9] } }], { lat: 49.9, lon: -97.14 }, 10).length, 1);
  assert.deepEqual(censusColumns({ regions: [{ uid: '46' }] }, []).columns.map((c) => c.uid), ['46']);
  console.log('  ✓ shared helpers load and answer');
} catch (err) { failed++; console.log(`  ✗ shared helpers: ${err.message}`); }

process.exit(failed ? 1 : 0);
