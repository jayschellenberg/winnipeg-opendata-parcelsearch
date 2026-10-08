// Property Search's PUCS filter (Jason, 2026-10-07): the drop-down's
// options, what each value selects, the SoQL clause it becomes, and the
// wire from the form to BOTH assessment query paths (the direct query and
// the civic-address cross-reference).
//
// Run: cd web && node test/pucsFilter.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pucsFilterOptions, pucsFilterCodes, pucsFilterLabel, PUCS_NAMES, PUCS_CATEGORIES,
} from '../src/lib/pucs.js';
import { pucsClause } from '../src/soda.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('Property Search PUCS filter');

test('every named code is offered exactly once, under its category', () => {
  const groups = pucsFilterOptions();
  const codeOpts = groups.slice(1).flatMap((g) => g.options.map((o) => [g.group, o.value]));
  const codes = codeOpts.map(([, v]) => v.slice(5));
  assert.equal(new Set(codes).size, codes.length, 'a code is offered twice');
  for (const code of Object.keys(PUCS_NAMES)) {
    if (!PUCS_CATEGORIES[code]) continue;
    const hit = codeOpts.find(([, v]) => v === `code:${code}`);
    assert.ok(hit, `${code} is not offered`);
    assert.equal(hit[0], PUCS_CATEGORIES[code], `${code} is under the wrong category`);
  }
});

test('every offered value resolves to at least one code', () => {
  for (const { options } of pucsFilterOptions()) {
    for (const { value } of options) {
      assert.ok(pucsFilterCodes(value).length > 0, `${value} selects nothing`);
    }
  }
});

test('a category selects all of its codes, a code just itself', () => {
  const mf = pucsFilterCodes('cat:Multi-Family');
  assert.ok(mf.includes('RESMC') && mf.length > 1);
  assert.ok(mf.every((c) => PUCS_CATEGORIES[c] === 'Multi-Family'));
  assert.deepEqual(pucsFilterCodes('code:RESSD'), ['RESSD']);
  assert.deepEqual(pucsFilterCodes(''), []);
  assert.deepEqual(pucsFilterCodes('code:NOPE1'), []);
  assert.deepEqual(pucsFilterCodes('cat:Nothing'), []);
});

test('chip labels', () => {
  assert.equal(pucsFilterLabel('cat:Office'), 'All Office');
  assert.equal(pucsFilterLabel('code:resmc'), 'RESMC');
  assert.equal(pucsFilterLabel(''), '');
  assert.equal(pucsFilterLabel('code:NOPE1'), '');
});

test('pucsClause: prefix match on the City column, OR across codes', () => {
  assert.equal(pucsClause(['RESSD']), "upper(property_use_code) like 'RESSD%'");
  assert.equal(pucsClause(['RESMA', 'RESMB']),
    "(upper(property_use_code) like 'RESMA%' OR upper(property_use_code) like 'RESMB%')");
  assert.equal(pucsClause([]), null);
  assert.equal(pucsClause(undefined), null);
});

test('pucsClause never lets anything but a code into the SoQL', () => {
  assert.equal(pucsClause(["RESSD' OR 1=1 --"]), null);
  assert.equal(pucsClause(['%']), null);
  assert.equal(pucsClause(["X'", 'RESSD']), "upper(property_use_code) like 'RESSD%'");
});

// --- the wire, against the source (comments stripped) -----------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const main = strip(fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8'));
const soda = strip(fs.readFileSync(path.join(here, '..', 'src', 'soda.js'), 'utf8'));

test('the form sends the codes and they count as a search field', () => {
  assert.match(main, /pucs:\s*pucsFilterCodes\(\$pucsFilter\?\.value\)/, 'runSearch never reads the drop-down');
  assert.match(main, /const anyAssess = [^;]*anyPucs/, 'a PUCS-only search would be refused as empty');
});

test('both assessment query paths apply the clause', () => {
  const direct = soda.slice(soda.indexOf('export async function searchAssessmentParcels('));
  assert.match(direct.slice(0, 4000), /pucsClause\(pucs\)/, 'the direct query ignores the filter');
  const xref = soda.slice(soda.indexOf('async function fetchAssessmentByAddressPoints('));
  assert.match(xref.slice(0, 2000), /pucsClause\(extraFilters\.pucs\)/,
    'the address cross-reference would leak other uses into the result');
  const expanded = soda.slice(soda.indexOf('export async function searchAssessmentParcelsExpanded('));
  assert.match(expanded.slice(0, 1200), /waterfront, nearWater, pucs \}/,
    'the expanded search does not pass the filter to the cross-reference');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
