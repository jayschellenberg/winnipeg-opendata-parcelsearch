// Unit tests for src/lib/saleJudgements.js -- Jason's own verdicts on the
// individual sales where no instrument can be right.
//
// The situation these exist for: sabreBuildVerdict fires on a row whose live
// roll shows no building, and that has two opposite causes the data cannot
// tell apart -- the building was demolished after the sale (SABRE right), or
// SABRE's figure is junk (roll right). On 2026-08-22 the top-end review put
// rows of IDENTICAL shape in front of Jason and he split them from knowledge
// of the properties.
//
// Plain-node runner; run with `npm test` or `node test/saleJudgements.test.js`.

import assert from 'node:assert/strict';
import {
  SALE_JUDGEMENTS, saleJudgement, judgedVerdict, judgedAssembly,
} from '../src/lib/saleJudgements.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed += 1; }
}

console.log('saleJudgements');

test('every entry is complete and well formed', () => {
  // A judgement without a reason is an assertion nobody can weigh later,
  // which is the one thing this file must never become.
  for (const j of SALE_JUDGEMENTS) {
    assert.match(j.roll, /^\d{11}$/, `roll ${j.roll} is 11 digits`);
    assert.ok(['no-building', 'priced-as-land', 'upheld'].includes(j.verdict), `verdict ${j.verdict}`);
    assert.ok(j.note && j.note.length > 40, `${j.roll} carries a real reason`);
    assert.match(j.decided, /^\d{4}-\d{2}-\d{2}$/, `${j.roll} is dated`);
  }
});

test('no roll is judged twice', () => {
  const rolls = SALE_JUDGEMENTS.map((j) => j.roll);
  assert.equal(new Set(rolls).size, rolls.length, 'a duplicate would make the winner arbitrary');
});

test('no-building DROPS the verdict', () => {
  // 2730 KING EDWARD: SABRE reports 3,643 sf built 1960, the live roll reads
  // VAGRI with nothing, and the sale prices at $35.62/lot sf. Vacant
  // multi-family land. Returning null lets saleCategory put it back in Land
  // on its own rather than forcing a category here.
  assert.equal(judgedVerdict('14098347100'), null);
  assert.equal(judgedVerdict('07438470500'), null);
});

test('priced-as-land DOWNGRADES rather than dropping', () => {
  // 365 OAKDALE had a real 1937 house -- this is not a no-building case. The
  // house just cannot explain $5,500,000. The row stays in Land carrying the
  // visible mark instead of reading as a clean comp.
  assert.equal(judgedVerdict('01009600025'), 'built-priced-as-land');
  assert.equal(judgedVerdict('06093124800'), 'built-priced-as-land');
});

test('upheld changes NOTHING, and that is the point of recording it', () => {
  // Same data shape as the two that were reversed. Jason says 14098695400
  // does include buildings and 599 WASHINGTON was improved and consolidated.
  // Undefined means "leave the instrument alone"; the entry exists so a later
  // session does not re-open the question and reach the opposite answer.
  assert.equal(judgedVerdict('14098695400'), undefined);
  assert.equal(judgedVerdict('02040550500'), undefined);
  assert.ok(saleJudgement('14098695400'), 'but the record is still there');
});

test('null and undefined are DIFFERENT answers here', () => {
  // null = drop the verdict. undefined = no judgement, leave it alone. A
  // caller testing truthiness would collapse them and silently stop
  // reversing anything.
  assert.strictEqual(judgedVerdict('14098347100'), null);
  assert.strictEqual(judgedVerdict('99999999999'), undefined);
  assert.notStrictEqual(judgedVerdict('14098347100'), judgedVerdict('99999999999'));
});

test('an unknown roll is never judged', () => {
  for (const roll of ['99999999999', '', null, undefined, '   ']) {
    assert.equal(saleJudgement(roll), null, JSON.stringify(roll));
    assert.equal(judgedVerdict(roll), undefined, JSON.stringify(roll));
    assert.equal(judgedAssembly(roll), null, JSON.stringify(roll));
  }
});

test('a corrected assembly REBUILDS the rate rather than blanking it', () => {
  // 165 PROVENCHER assembled five parcels; SABRE linked one and gave it
  // 4,044 sf, which is a DIFFERENT parcel's area -- its own is 12,111. The
  // published $865.48 per lot square foot should read $127.63, high by 6.8x.
  // An appraiser can use $127.63 and cannot use a blank, so the corrected
  // denominator beats withholding -- but only because it is SOURCED, from a
  // dated snapshot two weeks before the sale.
  const a = judgedAssembly('06093124800');
  assert.equal(a.landSf, 27422);
  assert.equal(a.parcels, 5, '$/Lot divides by the COUNT, and SABRE saw one');
  assert.equal(Math.round((3500000 / a.landSf) * 100) / 100, 127.63);
});

test('the corrected area is independent of the verdict', () => {
  // 365 OAKDALE carries the same VERDICT but its land area is sound, so it
  // gets no assembly correction. The two concerns must not be coupled.
  assert.equal(judgedVerdict('01009600025'), judgedVerdict('06093124800'));
  assert.equal(judgedAssembly('01009600025'), null);
});

test('an assembly lists its rolls, and the subject is one of them', () => {
  // The roll list is the evidence for the area. If it ever has to be
  // re-checked, that is what gets re-checked.
  const j = saleJudgement('06093124800');
  assert.equal(j.assemblyRolls.length, 5);
  assert.ok(j.assemblyRolls.includes('06093124800'), 'the subject roll is in its own assembly');
  assert.equal(new Set(j.assemblyRolls).size, 5, 'no duplicates');
  assert.match(j.note, /2023-11-13/, 'the note says where the areas came from');
});

test('the list stays small, and is not a dumping ground', () => {
  // A general rule that is wrong belongs in the rule -- the six parking false
  // positives were fixed by narrowing the SABRE gate, not by listing them
  // here. If this ever grows large, something upstream needs fixing instead.
  assert.ok(SALE_JUDGEMENTS.length <= 25,
    `${SALE_JUDGEMENTS.length} judgements -- if this keeps growing, fix the rule instead`);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
