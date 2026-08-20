// Unit tests for src/lib/salesCharts.js — the maths behind the
// land-sales charts. Plain-node runner; run with `npm test` or
// `node test/salesCharts.test.js`.

import assert from 'node:assert/strict';
import {
  isLandUseCode, saleRecordsFromRows, fitLinear, niceScale,
  dotRadius, median, annualTrendPct,
} from '../src/lib/salesCharts.js';

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

console.log('salesCharts');

test('isLandUseCode — the V prefix, plus CNVAC', () => {
  for (const c of ['VRES1', 'VCOMM', 'VINDU', 'VAGRI', 'VAPRK', 'VRES2', 'CNVAC', 'vcomm']) {
    assert.equal(isLandUseCode(c), true, c);
  }
  assert.equal(isLandUseCode('VNEW9'), true, 'a future V-code counts without a code change');
  assert.equal(isLandUseCode('RESMC'), false);
  assert.equal(isLandUseCode('CNRES'), false);
  assert.equal(isLandUseCode(''), false);
  assert.equal(isLandUseCode(null), false);
});

function row(p) {
  return { assess: { properties: { _saleInstrument: 'I1', _salePrice: 100000, _saleDate: '2026-01-15', ...p } } };
}

test('saleRecordsFromRows — one point per SALE, not per parcel', () => {
  // A three-parcel assembly is one transaction; charting it three times
  // would triple its weight in every trendline.
  const recs = saleRecordsFromRows([
    row({ _saleInstrument: 'A', roll_number: '1' }),
    row({ _saleInstrument: 'A', roll_number: '2' }),
    row({ _saleInstrument: 'A', roll_number: '3' }),
    row({ _saleInstrument: 'B', roll_number: '4' }),
  ]);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.instrument).sort(), ['A', 'B']);
});

test('saleRecordsFromRows — sales with no usable price are dropped', () => {
  const recs = saleRecordsFromRows([
    row({ _saleInstrument: 'A', _salePrice: null }),
    row({ _saleInstrument: 'B', _salePrice: 0 }),
    row({ _saleInstrument: 'C', _salePrice: 250000 }),
  ]);
  assert.deepEqual(recs.map((r) => r.instrument), ['C']);
});

test('saleRecordsFromRows — carries the land metrics and the land verdict', () => {
  const [r] = saleRecordsFromRows([row({
    _salePrice: 200000, _saleAcres: 0.5, _pricePerSf: 10,
    _pricePerAcre: 400000, _pricePerLot: 100000,
    _saleUseCode: 'VCOMM', _saleGroupSize: 2, _farFlung: true,
  })]);
  assert.equal(r.acres, 0.5);
  assert.equal(r.pricePerAcre, 400000);
  assert.equal(r.pricePerLot, 100000);
  assert.equal(r.lots, 2);
  assert.equal(r.isLand, true);
  assert.equal(r.farFlung, true);
  // landSf is recovered from price ÷ $/sf, so the size axis works
  // without the raw figure being re-sent.
  assert.equal(r.landSf, 20000);
});

test('saleRecordsFromRows — an unparseable date leaves date null, not NaN', () => {
  const [r] = saleRecordsFromRows([row({ _saleDate: 'pending' })]);
  assert.equal(r.date, null);
});

test('fitLinear — recovers a known line exactly', () => {
  const fit = fitLinear([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 1);
  assert.equal(fit.r2, 1);
  assert.equal(fit.predict(3), 7);
});

test('fitLinear — refuses a fit it cannot make', () => {
  assert.equal(fitLinear([]), null);
  assert.equal(fitLinear([{ x: 1, y: 1 }]), null, 'one point is not a trend');
  assert.equal(fitLinear([{ x: 5, y: 1 }, { x: 5, y: 9 }]), null, 'no x-variance is one date, not a trend');
  assert.equal(fitLinear([{ x: 1, y: NaN }, { x: 2, y: 3 }]), null, 'non-finite points are dropped first');
});

test('fitLinear — r2 reports a poor fit as poor', () => {
  const fit = fitLinear([{ x: 0, y: 5 }, { x: 1, y: 1 }, { x: 2, y: 6 }, { x: 3, y: 2 }]);
  assert.ok(fit.r2 < 0.3, `expected a weak fit, got r2=${fit.r2}`);
});

test('niceScale — round bounds that contain the data', () => {
  const s = niceScale(3, 87);
  assert.ok(s.min <= 3 && s.max >= 87);
  assert.ok(s.ticks.length >= 2);
  assert.equal(s.ticks[0], s.min);
  assert.equal(s.ticks.at(-1), s.max);
});

test('niceScale — a flat series still gets a usable range', () => {
  const s = niceScale(50, 50);
  assert.ok(s.max > s.min, 'zero span would divide by zero when plotting');
});

test('niceScale — non-finite input degrades instead of throwing', () => {
  const s = niceScale(NaN, 10);
  assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max));
});

test('dotRadius shrinks as the set grows', () => {
  assert.ok(dotRadius(10) > dotRadius(100));
  assert.ok(dotRadius(100) > dotRadius(500));
});

test('median — odd, even, and empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([1, NaN, 3]), 2, 'non-finite values are ignored');
});

test('annualTrendPct — slope per ms becomes a readable %/yr', () => {
  const YEAR = 365.25 * 24 * 60 * 60 * 1000;
  // +$10/sf per year against a $100 median = +10%/yr.
  const pct = annualTrendPct({ slope: 10 / YEAR }, 100);
  assert.ok(Math.abs(pct - 10) < 1e-6, `got ${pct}`);
  assert.equal(annualTrendPct(null, 100), null);
  assert.equal(annualTrendPct({ slope: 1 }, 0), null, 'no median means no percentage');
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
