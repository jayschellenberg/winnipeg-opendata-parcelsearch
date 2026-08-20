// Unit tests for src/lib/salesDbMerge.js — merging a folder of SABRE
// exports into one CSV without double-counting overlapping pulls.
// Plain-node runner; run with `npm test` or `node test/salesDbMerge.test.js`.

import assert from 'node:assert/strict';
import {
  analyzeSalesCsv, mergeSalesFiles, rowSignature, csvCell, rowsToCsv,
  collapseCrossSource, CROSS_SOURCE_DAYS,
} from '../src/lib/salesDbMerge.js';
import { parseSalesText } from '../src/lib/salesImport.js';
import { dedupAndGroupSales } from '../src/lib/sales.js';

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

console.log('salesDbMerge');

const HEADER = 'Parcel ID,Instrument Number,Sale Dates,Sold Price,Living Area';

test('analyzeSalesCsv — row count is quote-aware; dates normalize before min/max', () => {
  // SABRE dates are MM-DD-YYYY, and one cell embeds a newline inside
  // quotes — a naive line count would report 4 rows, not 3.
  const a = analyzeSalesCsv(
    `${HEADER}\n`
    + '6070731000,INST-1,12-30-2023,350000,1200\n'
    + '6070731001,INST-2,01-05-2024,"410,000",900\n'
    + '6070731002,"INST\n3",03-27-2024,500000,800\n'
  );
  assert.equal(a.dataRowCount, 3);
  assert.equal(a.minSaleDate, '2023-12-30');
  assert.equal(a.maxSaleDate, '2024-03-27');
  assert.equal(a.headerCells[0], 'Parcel ID');
});

test('analyzeSalesCsv — unparseable dates stay out of the span', () => {
  const a = analyzeSalesCsv(
    `${HEADER}\n`
    + '6070731000,INST-1,pending,350000,1200\n'
    + '6070731001,INST-2,02-01-2024,400000,900\n'
  );
  assert.equal(a.dataRowCount, 2);
  assert.equal(a.minSaleDate, '2024-02-01');
  assert.equal(a.maxSaleDate, '2024-02-01');
});

test('rowSignature — cell boundaries survive; whitespace variance does not', () => {
  assert.notEqual(rowSignature(['ab', 'c']), rowSignature(['a', 'bc']));
  assert.equal(rowSignature([' x ', 'y']), rowSignature(['x', ' y']));
});

test('csvCell / rowsToCsv — quoted cells round-trip through the sales parser', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  const text = rowsToCsv([
    ['Parcel ID', 'Instrument Number', 'Sale Dates', 'Sold Price'],
    ['6070731000', 'INST-1', '2024-03-01', '350,000'],
  ]);
  const parsed = parseSalesText(text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]['Sold Price'], '350,000');
});

test('mergeSalesFiles — overlapping pulls dedupe by full row; counts add up', () => {
  const merged = mergeSalesFiles([
    { name: 'a.csv', csv: `${HEADER}\n6070731000,INST-1,12-30-2023,350000,1200\n6070731001,INST-2,01-05-2024,410000,900` },
    { name: 'b.csv', csv: `${HEADER}\n6070731001,INST-2,01-05-2024,410000,900\n6070731002,INST-3,03-27-2024,500000,800` },
  ]);
  assert.equal(merged.fileCount, 2);
  assert.equal(merged.total, 4);
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.kept, 3);
  // One header line + three data rows; the second file's header is gone.
  const lines = merged.text.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((l) => l.startsWith('Parcel ID')).length, 1);
});

test('mergeSalesFiles — the same row twice must NOT double Living Area downstream', () => {
  // The reason full-row dedupe exists: dedupAndGroupSales SUMS living
  // area per (roll, instrument), so a duplicated component row would
  // report 2,400 sf for a 1,200 sf building.
  const merged = mergeSalesFiles([
    { name: 'a.csv', csv: `${HEADER}\n6070731000,INST-1,12-30-2023,350000,1200` },
    { name: 'b.csv', csv: `${HEADER}\n6070731000,INST-1,12-30-2023,350000,1200` },
  ]);
  const { sales } = dedupAndGroupSales(parseSalesText(merged.text).rows);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].livingArea, 1200);
});

test('mergeSalesFiles — distinct component rows on one sale both survive', () => {
  // Two buildings on one parcel, one transaction: same (roll,
  // instrument), different cells. These are NOT duplicates.
  const merged = mergeSalesFiles([
    { name: 'a.csv', csv: `${HEADER}\n6070731000,INST-1,12-30-2023,350000,1200\n6070731000,INST-1,12-30-2023,350000,800` },
  ]);
  assert.equal(merged.kept, 2);
  const { sales } = dedupAndGroupSales(parseSalesText(merged.text).rows);
  assert.equal(sales[0].livingArea, 2000);
});

test('mergeSalesFiles — the SAME sale in two date formats is one sale', () => {
  // Real folder case: SABRE exported July 2022 twice, once ISO and once
  // MM-DD-YYYY. Raw-cell comparison called all 217 rows distinct, which
  // doubled that month and doubled living area on every sale in it.
  const merged = mergeSalesFiles([
    { name: 'iso.csv', csv: `${HEADER}
6070731000,INST-1,2022-07-11,350000,1200` },
    { name: 'sabre.csv', csv: `${HEADER}
6070731000,INST-1,07-11-2022,350000,1200` },
  ]);
  assert.equal(merged.total, 2);
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.kept, 1);
  const { sales } = dedupAndGroupSales(parseSalesText(merged.text).rows);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].livingArea, 1200, 'living area must not double');
});

test('rowSignature — normalizes only the date column it is told about', () => {
  // Without the index it is a raw comparison, which is what the merge
  // relied on before and why the duplicates slipped through.
  assert.notEqual(rowSignature(['a', '07-11-2022']), rowSignature(['a', '2022-07-11']));
  assert.equal(rowSignature(['a', '07-11-2022'], 1), rowSignature(['a', '2022-07-11'], 1));
  // A non-date cell at that index is left alone rather than mangled.
  assert.equal(rowSignature(['a', 'pending'], 1), rowSignature(['a', 'pending'], 1));
});

test('mergeSalesFiles — header drift only in case/space still merges', () => {
  const merged = mergeSalesFiles([
    { name: 'a.csv', csv: `${HEADER}\n1,I-1,01-01-2024,100,50` },
    { name: 'b.csv', csv: 'parcel id ,INSTRUMENT NUMBER,sale dates,Sold_Price,living area\n2,I-2,01-02-2024,200,60' },
  ]);
  assert.equal(merged.kept, 2);
});

test('mergeSalesFiles — a file that yields nothing is NAMED, not swallowed', () => {
  // Two schemas make the old "throw on a mismatched header" impossible,
  // so the feedback that throw used to carry has to survive some other
  // way: the file is reported by name rather than vanishing.
  const merged = mergeSalesFiles([
    { name: 'a.csv', csv: `${HEADER}\n1,I,01-01-2024,100,50` },
    { name: 'odd.csv', csv: 'Roll,Price\n1,100' },
  ]);
  assert.deepEqual(merged.unreadable, ['odd.csv']);
  assert.equal(merged.kept, 1, 'the readable file still loads');
});

test('mergeSalesFiles — empty input is a clean empty result', () => {
  const empty = mergeSalesFiles([]);
  assert.equal(empty.text, '');
  assert.equal(empty.kept, 0);
  assert.equal(empty.total, 0);
  assert.equal(empty.fileCount, 0);
  assert.equal(empty.collapsed, 0);
  assert.deepEqual(empty.unreadable, []);
});

// ---- SABRE + MLS ----------------------------------------------------------
const MLS_HEADER = 'LINC,Address,Status,DateSold,PriceSold,PriceList,MLS,City,StreetNumber,StreetName';

test('mergeSalesFiles — reads both schemas into one canonical export', () => {
  const merged = mergeSalesFiles([
    { name: 'SoldPropertyListing.csv', csv: `${HEADER}
6070731000,INST-1,12-30-2023,350000,1200` },
    { name: 'MLS.csv', csv: `${MLS_HEADER}
008R000936000,689 St Marys,S,08-16-2026,800000,899900,202615220,Winnipeg,689,St Marys` },
  ]);
  assert.equal(merged.kept, 2, 'a file of each schema, neither rejected');
  const { rows } = parseSalesText(merged.text);
  assert.equal(rows.length, 2);
  const sources = rows.map((r) => r.Source).sort();
  assert.deepEqual(sources, ['MLS', 'SABRE']);
});

test('collapseCrossSource — one transaction, both dates', () => {
  // Same roll, same price, five weeks apart: MLS dates the offer,
  // SABRE the registration.
  const { rows, collapsed } = collapseCrossSource([
    { 'Parcel ID': '06070731000', 'Instrument Number': '5155159', 'Sale Dates': '2020-02-21',
      'Sold Price': '185000', Source: 'SABRE' },
    { 'Parcel ID': '06070731000', 'Instrument Number': 'MLS-1', 'Sale Dates': '2020-01-16',
      'MLS Date': '2020-01-16', 'Sold Price': '185000', 'List Price': '199444', DOM: '96', Source: 'MLS' },
  ]);
  assert.equal(collapsed, 1);
  assert.equal(rows.length, 1, 'the comp appears once, not twice');
  const r = rows[0];
  assert.equal(r['Sale Dates'], '2020-02-21', 'registration is the sale date');
  assert.equal(r['Instrument Number'], '5155159', 'SABRE keeps the identity');
  assert.equal(r['MLS Date'], '2020-01-16', 'the offer date survives');
  assert.equal(r['List Price'], '199444', 'MLS donates what SABRE lacks');
  assert.equal(r.Source, 'SABRE+MLS');
});

test('collapseCrossSource — a different price is a different sale', () => {
  const { rows, collapsed } = collapseCrossSource([
    { 'Parcel ID': '1', 'Sale Dates': '2020-02-21', 'Sold Price': '185000', Source: 'SABRE' },
    { 'Parcel ID': '1', 'Sale Dates': '2020-01-16', 'Sold Price': '190000', Source: 'MLS' },
  ]);
  assert.equal(collapsed, 0);
  assert.equal(rows.length, 2, 'fusing on a guess would invent a transaction');
});

test('collapseCrossSource — beyond the window they stay apart', () => {
  const { collapsed } = collapseCrossSource([
    { 'Parcel ID': '1', 'Sale Dates': '2020-02-21', 'Sold Price': '185000', Source: 'SABRE' },
    { 'Parcel ID': '1', 'Sale Dates': '2019-01-16', 'Sold Price': '185000', Source: 'MLS' },
  ]);
  assert.equal(collapsed, 0, 'a repeat sale of the same parcel must survive');
  assert.ok(CROSS_SOURCE_DAYS >= 90 && CROSS_SOURCE_DAYS <= 180);
});

test('collapseCrossSource — one SABRE row cannot absorb two MLS rows', () => {
  const { rows, collapsed } = collapseCrossSource([
    { 'Parcel ID': '1', 'Sale Dates': '2020-02-21', 'Sold Price': '185000', Source: 'SABRE' },
    { 'Parcel ID': '1', 'Sale Dates': '2020-01-16', 'Sold Price': '185000', Source: 'MLS', 'MLS #': 'A' },
    { 'Parcel ID': '1', 'Sale Dates': '2020-01-20', 'Sold Price': '185000', Source: 'MLS', 'MLS #': 'B' },
  ]);
  assert.equal(collapsed, 1);
  assert.equal(rows.length, 2, 'the second MLS row stays as its own record');
});

test('collapseCrossSource — a single-source set is returned untouched', () => {
  const only = [{ 'Parcel ID': '1', 'Sale Dates': '2020-02-21', 'Sold Price': '1', Source: 'SABRE' }];
  const { rows, collapsed } = collapseCrossSource(only);
  assert.equal(collapsed, 0);
  assert.equal(rows.length, 1);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
