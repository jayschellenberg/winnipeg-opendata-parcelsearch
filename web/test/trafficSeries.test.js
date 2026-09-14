// lib/trafficSeries.js — per-year traffic series and annualized growth.
// Run: cd web && node test/trafficSeries.test.js
import assert from 'node:assert/strict';
import {
  yearSeriesFromEntries, annualizedGrowth, formatGrowth, latestFullYear, parseSeries,
  FULL_YEAR_MIN_DAYS,
} from '../src/lib/trafficSeries.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('trafficSeries');

test('entries collapse to one row per year, summed, averaged per day, ascending', () => {
  const s = yearSeriesFromEntries([
    { year: '2024', total: '300000', days: '6', studies: 1 },
    { year: 2019, total: 200000, days: 4 },
    { year: 2024, total: 212307, days: 3, studies: 1 },
  ]);
  assert.deepEqual(s.map((r) => r.year), [2019, 2024]);
  assert.equal(s[1].total, 512307);
  assert.equal(s[1].days, 9);
  assert.equal(s[1].studies, 2);
  assert.equal(s[1].avg, Math.round(512307 / 9));
  assert.equal(s[0].avg, 50000);
});

test('junk years, zero days and empty totals are dropped', () => {
  const s = yearSeriesFromEntries([
    { year: 'x', total: 1, days: 1 }, { year: 2020, total: 100, days: 0 },
    { year: 2021, total: 0, days: 3 }, { year: 2022, total: 50, days: 1 },
  ]);
  assert.deepEqual(s.map((r) => r.year), [2022]);
  assert.deepEqual(yearSeriesFromEntries(null), []);
});

test('growth is the compound rate between the first and last qualifying years', () => {
  // Disraeli Bridge: 33,286 in 2021 → 40,511 in 2025 is about 5.0 %/yr.
  const s = yearSeriesFromEntries([
    { year: 2021, total: 12149597, days: 365 },
    { year: 2023, total: 13500000, days: 360 },
    { year: 2025, total: 14786534, days: 365 },
  ]);
  const g = annualizedGrowth(s, { minDays: 300 });
  assert.equal(g.fromYear, 2021);
  assert.equal(g.toYear, 2025);
  assert.ok(Math.abs(g.pct - 5.0) < 0.15, `got ${g.pct}`);
  assert.equal(formatGrowth(g), `+${g.pct.toFixed(1)}%/yr (2021→2025)`);
});

test('thin endpoints are skipped, and a span under two years says nothing', () => {
  const s = yearSeriesFromEntries([
    { year: 2019, total: 1000, days: 1 },
    { year: 2020, total: 400000, days: 10 },
    { year: 2024, total: 500000, days: 10 },
  ]);
  const g = annualizedGrowth(s, { minDays: 2 });
  assert.equal(g.fromYear, 2020, 'the one-day 2019 study is not an endpoint');
  assert.equal(annualizedGrowth(s.slice(1, 2)), null, 'one year is no trend');
  const adjacent = yearSeriesFromEntries([
    { year: 2023, total: 100, days: 1 }, { year: 2024, total: 110, days: 1 },
  ]);
  assert.equal(annualizedGrowth(adjacent), null);
  assert.equal(formatGrowth(null), '');
});

test('a negative rate formats with its sign', () => {
  const s = yearSeriesFromEntries([
    { year: 2004, total: 1313555, days: 27 }, { year: 2024, total: 360000, days: 9 },
  ]);
  const g = annualizedGrowth(s);
  assert.ok(g.pct < 0);
  assert.match(formatGrowth(g), /^-\d+\.\d%\/yr \(2004→2024\)$/);
});

test('latestFullYear needs near-complete coverage', () => {
  const s = yearSeriesFromEntries([
    { year: 2024, total: 100, days: 356 }, { year: 2025, total: 100, days: 200 },
  ]);
  assert.equal(latestFullYear(s).year, 2024);
  assert.equal(FULL_YEAR_MIN_DAYS, 300);
  assert.equal(latestFullYear([]), null);
});

test('parseSeries accepts an array, a JSON string, or garbage', () => {
  assert.deepEqual(parseSeries([{ year: 1 }]), [{ year: 1 }]);
  assert.deepEqual(parseSeries('[{"year":2}]'), [{ year: 2 }]);
  assert.deepEqual(parseSeries('{"a":1}'), []);
  assert.deepEqual(parseSeries('not json'), []);
  assert.deepEqual(parseSeries(undefined), []);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
