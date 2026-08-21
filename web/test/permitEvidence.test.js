// Unit tests for src/lib/permitEvidence.js — matching demolition permits to
// sales, and the teardown verdict that is the point of the exercise.
// Plain-node runner; run with `npm test` or `node test/permitEvidence.test.js`.

import assert from 'node:assert/strict';
import {
  DEMO_WINDOW_DAYS, permitAddressKey, buildPermitIndex, findNearestPermit,
  demoVerdict, describeDemoPermit,
  BUILT_BEFORE_DAYS, buildVerdict, describeBuildPermit,
  rollBuildVerdict, describeRollBuilt,
  sabreBuildVerdict, describeSabreBuilt, MIN_PLAUSIBLE_LIVING_SF,
  pricedAsLand, describePricedAsLand, MIN_BUILDING_PRICE_PER_SF,
} from '../src/lib/permitEvidence.js';

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

console.log('permitEvidence');

const permit = (o = {}) => ({
  issue_date: '2019-11-12T00:00:00.000',
  permit_number: '19-191201 HO',
  work_type: 'Demolish',
  sub_type: 'SFD',
  street_number: '514',
  street_name: 'Beverley',
  street_type: 'ST',
  ...o,
});

test('permitAddressKey folds case, spacing and street type', () => {
  assert.equal(permitAddressKey('514', 'Beverley'), permitAddressKey('514', 'BEVERLEY'));
  assert.equal(permitAddressKey(' 514 ', ' beverley '), '514 BEVERLEY');
  // Directionals and full street types fold, which is the drift between
  // the permit table and a SABRE export.
  assert.equal(permitAddressKey('100', 'PORTAGE AVENUE EAST'), permitAddressKey('100', 'PORTAGE AVE E'));
});

test('permitAddressKey — a missing half yields no key, never a partial match', () => {
  assert.equal(permitAddressKey('', 'BEVERLEY'), '');
  assert.equal(permitAddressKey('514', ''), '');
  assert.equal(permitAddressKey(null, null), '');
});

test('findNearestPermit — matches inside the window, either side', () => {
  const idx = buildPermitIndex([permit()]);
  const before = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  assert.equal(before.date, '2019-11-12');
  assert.equal(before.side, 'before');
  assert.ok(before.offsetDays < 0);
  const after = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2019-06-01' }, idx);
  assert.equal(after.side, 'after');
  assert.ok(after.offsetDays > 0);
});

test('findNearestPermit — outside the window is no match', () => {
  const idx = buildPermitIndex([permit()]);
  // Three years after the permit is beyond ±2 years.
  assert.equal(findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2022-11-12' }, idx), null);
  assert.ok(DEMO_WINDOW_DAYS > 700 && DEMO_WINDOW_DAYS < 740, 'window is ~2 years');
});

test('findNearestPermit — picks the NEAREST permit when an address has several', () => {
  const idx = buildPermitIndex([
    permit({ issue_date: '2018-01-05T00:00:00.000', permit_number: 'OLD' }),
    permit({ issue_date: '2019-11-12T00:00:00.000', permit_number: 'NEAR' }),
  ]);
  const hit = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  assert.equal(hit.permitNumber, 'NEAR');
});

test('findNearestPermit — unknown address or unusable date is null, not a throw', () => {
  const idx = buildPermitIndex([permit()]);
  assert.equal(findNearestPermit({ streetNumber: '999', streetName: 'NOWHERE', saleDate: '2020-01-31' }, idx), null);
  assert.equal(findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: 'pending' }, idx), null);
  assert.equal(findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY' }, new Map()), null);
  assert.equal(findNearestPermit(null, idx), null);
});

test('demoVerdict — the finding is a permit on an IMPROVED-coded sale', () => {
  const hit = { date: '2019-11-12', offsetDays: -80, side: 'before' };
  assert.equal(demoVerdict(hit, false), 'teardown', 'improved code + permit = teardown in disguise');
  assert.equal(demoVerdict(hit, true), 'confirms-vacant', 'already vacant = only corroboration');
  assert.equal(demoVerdict(null, false), null);
});

test('describeDemoPermit — spells out the consequence for a teardown', () => {
  const idx = buildPermitIndex([permit()]);
  const hit = findNearestPermit({ streetNumber: '514', streetName: 'BEVERLEY', saleDate: '2020-01-31' }, idx);
  const text = describeDemoPermit(hit, 'teardown');
  assert.match(text, /19-191201 HO/);
  assert.match(text, /3 months before the sale/);
  assert.match(text, /LAND sale/, 'the reader is told what to do with the row');
  assert.match(describeDemoPermit(hit, 'confirms-vacant'), /only confirms/);
  assert.equal(describeDemoPermit(null), '');
});

// ---- new construction: was the house already there? ----------------------
const buildPermit = (o = {}) => ({
  issue_date: '2019-01-16T00:00:00.000',
  permit_number: '19-000001 HO',
  work_type: 'Construct New',
  permit_type: 'Housing',
  sub_type: 'SFD',
  street_number: '345',
  street_name: 'Amherst',
  ...o,
});

test('buildVerdict — a permit 6+ months before a vacant sale means it was ALREADY BUILT', () => {
  const idx = buildPermitIndex([buildPermit()]);
  // 345 AMHERST: permit Jan 2019, sold Feb 2020 for $329k as VRES1.
  const hit = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-02-19' }, idx, 3 * 365);
  assert.equal(hit.side, 'before');
  assert.equal(buildVerdict(hit, true), 'already-built');
  assert.match(describeBuildPermit(hit, 'already-built'), /IMPROVED sale/);
});

test('buildVerdict — a permit at or after the sale confirms bare land', () => {
  const idx = buildPermitIndex([buildPermit({ issue_date: '2020-06-22T00:00:00.000' })]);
  const hit = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-02-27' }, idx, 3 * 365);
  assert.equal(buildVerdict(hit, true), 'land-then-built');
  assert.match(describeBuildPermit(hit, 'land-then-built'), /genuine land comp/);
});

test('buildVerdict — the six-month line, measured not guessed', () => {
  const idx = buildPermitIndex([buildPermit({ issue_date: '2020-01-01T00:00:00.000' })]);
  // Just inside six months before -> still land (house not finished).
  const near = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-05-01' }, idx, 3 * 365);
  assert.equal(buildVerdict(near, true), 'land-then-built');
  // Comfortably past it -> already built.
  const far = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-10-01' }, idx, 3 * 365);
  assert.equal(buildVerdict(far, true), 'already-built');
  assert.ok(BUILT_BEFORE_DAYS > 175 && BUILT_BEFORE_DAYS < 190, 'threshold is ~6 months');
});

test('buildVerdict — improved-coded sales are not judged; every house has a permit', () => {
  const idx = buildPermitIndex([buildPermit()]);
  const hit = findNearestPermit({ streetNumber: '345', streetName: 'AMHERST', saleDate: '2020-02-19' }, idx, 3 * 365);
  assert.equal(buildVerdict(hit, false), null);
  assert.equal(buildVerdict(null, true), null);
});

// ---- rollBuildVerdict: the second instrument -------------------------------
// Permits cannot answer for 37 sales in the archive -- houses built 2014-2024
// and sold years later, and pre-war houses that predate it4w-cpf4's 2016
// start. The roll's own year_built can. These pin the guards that stop it
// answering when it should not.

const ROLL = {
  saleIsVacant: true, hasLiveRecord: true,
  yearBuilt: 2014, livingArea: 2871, saleDate: '2024-06-01',
};

test('rollBuildVerdict — a building older than the sale, still standing', () => {
  // 28 WATERSTONE DRIVE: $1,525,000, 2,871 sf, built 2014, sold 2024.
  // Ten years past any permit window and coded vacant.
  assert.equal(rollBuildVerdict(ROLL), 'already-built');
  // 570 BALMORAL: built 1891, sold 2020. No permit row exists at all.
  assert.equal(rollBuildVerdict({ ...ROLL, yearBuilt: 1891, livingArea: 1636, saleDate: '2020-03-11' }), 'already-built');
});

test('rollBuildVerdict — built AT or AFTER the sale is land-then-built, not this', () => {
  // 55 of the 812 unjudged look like this. The lot sold bare and was built
  // on after; calling them improved would be the error in reverse.
  assert.equal(rollBuildVerdict({ ...ROLL, yearBuilt: 2024, saleDate: '2024-06-01' }), null);
  assert.equal(rollBuildVerdict({ ...ROLL, yearBuilt: 2025, saleDate: '2024-06-01' }), null);
});

test('rollBuildVerdict — a year with NO living area is a demolished building', () => {
  // The roll zeroes living area when a building comes down but keeps the
  // year. 185 BANNERMAN sold six suites in 2022 and reads 0 today. Judging
  // on the year alone would call a genuine bare-lot sale improved.
  assert.equal(rollBuildVerdict({ ...ROLL, livingArea: 0 }), null);
  assert.equal(rollBuildVerdict({ ...ROLL, livingArea: null }), null);
  assert.equal(rollBuildVerdict({ ...ROLL, livingArea: undefined }), null);
});

test('rollBuildVerdict — no live record is not evidence of anything', () => {
  // 79 of the 812. Absence of a roll row says nothing about the parcel, so
  // this instrument declines them rather than reading them as bare OR as
  // built. sabreBuildVerdict picks 6 of them up from the export's own
  // attributes; the rest stay unjudged and main.js marks them.
  assert.equal(rollBuildVerdict({ ...ROLL, hasLiveRecord: false }), null);
});

test('rollBuildVerdict — only asked of vacant-coded sales', () => {
  // Same reason buildVerdict is: every improved sale has an older building,
  // so flagging those would bury the finding in noise.
  assert.equal(rollBuildVerdict({ ...ROLL, saleIsVacant: false }), null);
});

test('rollBuildVerdict — junk years and junk dates decide nothing', () => {
  for (const yearBuilt of [null, undefined, 0, '', 'n/a', 1800, -1]) {
    assert.equal(rollBuildVerdict({ ...ROLL, yearBuilt }), null, `yearBuilt ${yearBuilt}`);
  }
  for (const saleDate of [null, undefined, '', 'not-a-date']) {
    assert.equal(rollBuildVerdict({ ...ROLL, saleDate }), null, `saleDate ${saleDate}`);
  }
});

test('rollBuildVerdict — string inputs from the roll are coerced, not rejected', () => {
  // d4mq-wa44 hands numbers back as strings over SoDA.
  assert.equal(rollBuildVerdict({ ...ROLL, yearBuilt: '2014', livingArea: '2871' }), 'already-built');
});

test('describeRollBuilt — names the instrument and does not claim a permit', () => {
  const text = describeRollBuilt({ yearBuilt: 2014, livingArea: 2871, saleDate: '2024-06-01' });
  assert.match(text, /2014/);
  assert.match(text, /2,871 sf/);
  assert.match(text, /2024/);
  assert.match(text, /NOT a land comp/);
  // The whole point of a separate description: a reader must not come away
  // thinking a permit was found.
  assert.match(text, /not a permit/i);
});

// ---- sabreBuildVerdict: the third instrument --------------------------------
// For the 79 vacant-coded sales matching no live assessment record. Those
// rolls are RETIRED -- 71 of the 72 are absent from the live d4mq-wa44 too --
// so the roll can never answer, but SABRE's own export row survives. These pin
// the asymmetry that makes it safe: positive evidence only.

const SABRE = {
  saleIsVacant: true,
  yearBuilt: 1962, livingArea: 1308, saleDate: '2024-08-18',
};

test('sabreBuildVerdict — SABRE reports a building older than the sale', () => {
  // 3021 ROBLIN, retired roll 01000612300: $500,000, coded VRES1, SABRE says
  // 1,308 sf built 1962. The live successor parcel at that address --
  // 01000612000 -- is RESSD, year built 1962, living area 1,308. Same house,
  // still standing, and the only instrument that could see it was SABRE.
  assert.equal(sabreBuildVerdict(SABRE), 'already-built');
  // 599 WASHINGTON, sold twice as VINDU with a 2,847 sf 1956 building on it.
  assert.equal(sabreBuildVerdict({ ...SABRE, yearBuilt: 1956, livingArea: 2847, saleDate: '2021-08-20' }), 'already-built');
});

test('sabreBuildVerdict — needs NO live record; that absence is why it exists', () => {
  // The one guard rollBuildVerdict has that this must not: 6 of the 79 are
  // settled here precisely because the roll is gone.
  assert.equal(sabreBuildVerdict({ ...SABRE, hasLiveRecord: false }), 'already-built');
});

test('sabreBuildVerdict — a 1 sf living area is a PLACEHOLDER, not a building', () => {
  // The defect this guard exists for, and it is SABRE-specific: 21 sales in
  // the archive read exactly 1 sf and NOTHING falls between 2 and 199. They
  // are mostly CMPSP surface parking, and their prices are large. Ungated,
  // four of the 34 SABRE verdicts were these -- including OAK POINT HIGHWAY
  // at $4,800,000 and 280 YOUNG at $3,500,000, both VACANT-coded land sales
  // reclassified out of the Land set on the strength of "1 sf built 1960".
  // The worst false positive available: it removes exactly the comp the set
  // exists to hold.
  assert.equal(sabreBuildVerdict({ ...SABRE, livingArea: 1 }), null);
  assert.equal(sabreBuildVerdict({ ...SABRE, livingArea: 99 }), null);
  assert.equal(sabreBuildVerdict({ ...SABRE, livingArea: MIN_PLAUSIBLE_LIVING_SF }), 'already-built');
});

test('rollBuildVerdict — the same placeholder guard, currently inert', () => {
  // d4mq-wa44 carries no placeholder of this kind: 221,534 records above
  // zero and none below 200 sf, so this changes nothing on the roll today.
  // Symmetry against the day it starts doing what SABRE does.
  assert.equal(rollBuildVerdict({ ...ROLL, livingArea: 1 }), null);
  assert.equal(rollBuildVerdict({ ...ROLL, livingArea: 99 }), null);
  assert.equal(rollBuildVerdict({ ...ROLL, livingArea: MIN_PLAUSIBLE_LIVING_SF }), 'already-built');
});

test('sabreBuildVerdict — a blank living area decides NOTHING', () => {
  // The measured asymmetry, and the trap this instrument could have become.
  // Across the 12,082 vacant-coded sales a permit has already judged, SABRE
  // reports a living area on THREE. It does not populate the field for a
  // vacant-coded parcel, so blank means "not filled in", never "no building".
  // Reading bareness out of it would be the hasLiveRecord trap in new clothes.
  assert.equal(sabreBuildVerdict({ ...SABRE, livingArea: 0 }), null);
  assert.equal(sabreBuildVerdict({ ...SABRE, livingArea: null }), null);
  assert.equal(sabreBuildVerdict({ ...SABRE, livingArea: undefined }), null);
  assert.equal(sabreBuildVerdict({ ...SABRE, livingArea: '' }), null);
});

test('sabreBuildVerdict — built AT or AFTER the sale is not this finding', () => {
  assert.equal(sabreBuildVerdict({ ...SABRE, yearBuilt: 2024 }), null);
  assert.equal(sabreBuildVerdict({ ...SABRE, yearBuilt: 2025 }), null);
});

test('sabreBuildVerdict — only asked of vacant-coded sales', () => {
  assert.equal(sabreBuildVerdict({ ...SABRE, saleIsVacant: false }), null);
});

test('sabreBuildVerdict — junk years and junk dates decide nothing', () => {
  for (const yearBuilt of [null, undefined, 0, '', 'n/a', 1800, -1]) {
    assert.equal(sabreBuildVerdict({ ...SABRE, yearBuilt }), null, `yearBuilt ${yearBuilt}`);
  }
  for (const saleDate of [null, undefined, '', 'not-a-date']) {
    assert.equal(sabreBuildVerdict({ ...SABRE, saleDate }), null, `saleDate ${saleDate}`);
  }
});

test('sabreBuildVerdict — the numeric year is the OLDEST section, and that is right', () => {
  // 165 PROVENCHER carries "1937, 1951". buildSaleFeatures stamps the oldest
  // as _saleYearBuiltNumeric, which is the correct one for "was anything
  // standing when this sold" -- the later section only adds to it.
  assert.equal(sabreBuildVerdict({ ...SABRE, yearBuilt: 1937, livingArea: 2200, saleDate: '2023-11-28' }), 'already-built');
});

test('sabreBuildVerdict — string inputs from the CSV are coerced, not rejected', () => {
  assert.equal(sabreBuildVerdict({ ...SABRE, yearBuilt: '1962', livingArea: '1308' }), 'already-built');
});

test('describeSabreBuilt — names the instrument and does not claim a permit', () => {
  const text = describeSabreBuilt({ yearBuilt: 1962, livingArea: 1308, saleDate: '2024-08-18', hasLiveRecord: false });
  assert.match(text, /1962/);
  assert.match(text, /1,308 sf/);
  assert.match(text, /2024/);
  assert.match(text, /NOT a land comp/);
  assert.match(text, /not a permit/i);
  // The extra thing this description owes a reader over the roll's: there may
  // be no parcel left to go and look at.
  assert.match(text, /no longer on the assessment roll/i);
});

test('describeSabreBuilt — drops the retired-roll clause when the roll IS live', () => {
  // 28 of the 34 have a live record; the roll simply cannot contradict,
  // because the building stood at the sale and has come down since.
  const text = describeSabreBuilt({ yearBuilt: 1977, livingArea: 1300, saleDate: '2022-08-30', hasLiveRecord: true });
  assert.doesNotMatch(text, /no longer on the assessment roll/i);
  assert.match(text, /nothing on the assessment roll to contradict it/i);
  assert.match(text, /not a permit/i);
});

// ---- pricedAsLand: the teardown tiebreak ------------------------------------
// demoVerdict calls "a building stood here and was worthless" a LAND sale --
// that is what a teardown IS -- while the roll and SABRE call the same fact
// disqualifying. Where a permit exists they never collide; where none does,
// the same transaction gets opposite answers. This decides it on price, and
// only ever in the direction of NOT reclassifying.

test('pricedAsLand — the market paid nothing for the building', () => {
  // 570 BALMORAL: $52,500, 1,636 sf built 1891 = $32/bldg sf, against $174
  // for an ordinary improved sale. You cannot buy a 1,636 sf house for
  // $52,500; that is a lot with a liability standing on it.
  assert.equal(pricedAsLand({ salePrice: 52500, livingArea: 1636 }), true);
  // 294 CHARLES ($35), 511 WILLIAM ($38), 431 LANGSIDE ($42).
  assert.equal(pricedAsLand({ salePrice: 43500, livingArea: 1244 }), true);
  assert.equal(pricedAsLand({ salePrice: 60000, livingArea: 1583 }), true);
});

test('pricedAsLand — a price that DOES support the building is left alone', () => {
  // 219 GORDON: $286,900 over 1,308 sf = $219/bldg sf, near the improved
  // median. The buyer paid for a house and the verdict stands.
  assert.equal(pricedAsLand({ salePrice: 286900, livingArea: 1308 }), false);
});

test('pricedAsLand — it CANNOT misfire on new construction, by construction', () => {
  // The failure that killed the mirror test. A flat HIGH cut flags 28
  // WATERSTONE DRIVE -- 2,871 sf built 2014 at $531/bldg sf, a normal price
  // for a new luxury home and a row c79a65c correctly reclassified. The low
  // cut has no such exposure: the 1st percentile for post-2000 stock is
  // $128, so no new building can reach $50 at all.
  assert.equal(pricedAsLand({ salePrice: 1525000, livingArea: 2871 }), false);
  assert.equal(pricedAsLand({ salePrice: 5500000, livingArea: 1970 }), false);
  assert.equal(pricedAsLand({ salePrice: 3500000, livingArea: 2200 }), false);
});

test('pricedAsLand — group sales are never judged on a per-parcel ratio', () => {
  // The price is the whole transaction's, the living area is one parcel's,
  // so the ratio means nothing. All six rows this catches are single-parcel.
  assert.equal(pricedAsLand({ salePrice: 52500, livingArea: 1636, groupSize: 2 }), false);
  assert.equal(pricedAsLand({ salePrice: 52500, livingArea: 1636, groupSize: 1 }), true);
});

test('pricedAsLand — a placeholder area cannot trigger it either', () => {
  // 1 sf would make every price look enormous, not small, so it fails the
  // test anyway -- but the guard is explicit so it cannot invert later.
  assert.equal(pricedAsLand({ salePrice: 4800000, livingArea: 1 }), false);
  assert.equal(pricedAsLand({ salePrice: 100, livingArea: 1 }), false);
  assert.equal(pricedAsLand({ salePrice: 1000, livingArea: 99 }), false);
});

test('pricedAsLand — junk inputs decide nothing, and never THROW', () => {
  for (const salePrice of [null, undefined, 0, -1, '', 'n/a'])
    assert.equal(pricedAsLand({ salePrice, livingArea: 1636 }), false, `price ${salePrice}`);
  for (const livingArea of [null, undefined, 0, -1, '', 'n/a'])
    assert.equal(pricedAsLand({ salePrice: 52500, livingArea }), false, `area ${livingArea}`);
  assert.equal(pricedAsLand({}), false);
});

test('pricedAsLand — the threshold is the improved p5, not a guess', () => {
  assert.equal(MIN_BUILDING_PRICE_PER_SF, 50);
  const area = 1000;
  assert.equal(pricedAsLand({ salePrice: 49 * area, livingArea: area }), true);
  assert.equal(pricedAsLand({ salePrice: 50 * area, livingArea: area }), false);
});

test('describePricedAsLand — says it was NOT acted on, and why', () => {
  const text = describePricedAsLand({ yearBuilt: 1891, livingArea: 1636, saleDate: '2020-07-28', salePrice: 52500 });
  assert.match(text, /1891/);
  assert.match(text, /1,636 sf/);
  assert.match(text, /\$32 per building square foot/);
  assert.match(text, /TEARDOWN/);
  // The two things a reader must not miss: the row stayed in Land, and
  // nothing external confirms it.
  assert.match(text, /left in the LAND set/i);
  assert.match(text, /No permit confirms it/i);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
