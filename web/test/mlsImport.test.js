// Unit tests for src/lib/mlsImport.js — translating an MLS export into
// the canonical sales schema. Plain-node runner.

import assert from 'node:assert/strict';
import {
  isMlsHeader, lincToRoll, parseMlsText, MLS_ONLY_COLUMNS,
} from '../src/lib/mlsImport.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed += 1; }
}

console.log('mlsImport');

const HEADER = 'LINC,Address,Status,DateSold,PriceSold,PriceList,PriceOrig,MLS,Type,BldgType,City,Style,YrBlt,SqFt,NumUnits,DOM,CDOM,StreetNumber,StreetName,StreetType,LotSF,SiteInfl';
const row = (o = {}) => {
  const d = {
    LINC: '008R000936000', Address: "689 St Mary's Road", Status: 'S',
    DateSold: '08-16-2026', PriceSold: '800000', PriceList: '899900', PriceOrig: '899900',
    MLS: '202615220', Type: 'Office Building for Sale', BldgType: 'Freestanding',
    City: 'Winnipeg', Style: '', YrBlt: '1960', SqFt: '1700', NumUnits: '',
    DOM: '47', CDOM: '47', StreetNumber: '689', StreetName: "St Mary's",
    StreetType: 'Road', LotSF: '5000', SiteInfl: 'Corner', ...o,
  };
  return HEADER.split(',').map((h) => {
    const v = String(d[h] ?? '');
    return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
};
const csv = (...rows) => [HEADER, ...rows].join('\n');

test('isMlsHeader — LINC + DateSold together identify an MLS export', () => {
  assert.equal(isMlsHeader(HEADER.split(',')), true);
  assert.equal(isMlsHeader(['Parcel ID', 'Instrument Number', 'Sale Dates', 'Sold Price']), false);
  // Either alone is not enough to claim a file.
  assert.equal(isMlsHeader(['LINC', 'Something']), false);
  assert.equal(isMlsHeader([]), false);
});

test('lincToRoll — the roll is the last 11 digits', () => {
  // Verified against the assessment table: 689 St Mary's Road.
  assert.equal(lincToRoll('008R000936000'), '08000936000');
  assert.equal(lincToRoll('006R050602000'), '06050602000');
  assert.equal(lincToRoll(''), null);
  assert.equal(lincToRoll('123'), null, 'too short to be a roll');
  assert.equal(lincToRoll(null), null);
});

test('parseMlsText — maps onto the canonical schema the pipeline already reads', () => {
  const { rows } = parseMlsText(csv(row()));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r['Parcel ID'], '08000936000');
  assert.equal(r['Sold Price'], '800000');
  assert.equal(r['Living Area'], '1700');
  assert.equal(r['Land Actual sqft'], '5000');
  assert.equal(r['Street Number'], '689');
  assert.equal(r.Source, 'MLS');
});

test('parseMlsText — dates normalize, and the offer date is kept separately', () => {
  const { rows } = parseMlsText(csv(row()));
  assert.equal(rows[0]['Sale Dates'], '2026-08-16');
  // Kept from the start so a row that later fuses onto a SABRE
  // registration date does not lose the market signal it arrived with.
  assert.equal(rows[0]['MLS Date'], '2026-08-16');
});

test('parseMlsText — the listing number becomes a non-colliding instrument', () => {
  const { rows } = parseMlsText(csv(row()));
  assert.equal(rows[0]['Instrument Number'], 'MLS-202615220');
  assert.equal(rows[0]['MLS #'], '202615220');
});

test('parseMlsText — non-Winnipeg rows are excluded and counted', () => {
  const { rows, skipped } = parseMlsText(csv(
    row(),
    row({ City: 'Headingley', LINC: '999R000111000', MLS: '1' }),
    row({ City: 'West St Paul', LINC: '999R000222000', MLS: '2' }),
  ));
  assert.equal(rows.length, 1);
  assert.equal(skipped.nonWinnipeg, 2, 'reported, not silently dropped');
});

test('parseMlsText — a row with no usable LINC is counted, not guessed at', () => {
  const { rows, skipped } = parseMlsText(csv(row(), row({ LINC: '', MLS: '9' })));
  assert.equal(rows.length, 1);
  assert.equal(skipped.noRoll, 1);
});

test('parseMlsText — anything not sold is left out', () => {
  const { rows, skipped } = parseMlsText(csv(row(), row({ Status: 'A', MLS: '3' })));
  assert.equal(rows.length, 1);
  assert.equal(skipped.unsold, 1);
});

test('parseMlsText — a quoted cell containing commas survives intact', () => {
  const { rows } = parseMlsText(csv(row({ SiteInfl: 'Corner, High Traffic, Street Exposure' })));
  assert.equal(rows[0]['Site Influences'], 'Corner, High Traffic, Street Exposure');
});

test('MLS_ONLY_COLUMNS names every field SABRE has no home for', () => {
  const { rows } = parseMlsText(csv(row()));
  for (const c of ['MLS #', 'MLS Date', 'List Price', 'DOM']) {
    assert.ok(MLS_ONLY_COLUMNS.includes(c), c);
    assert.ok(c in rows[0], `${c} present on the parsed row`);
  }
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
