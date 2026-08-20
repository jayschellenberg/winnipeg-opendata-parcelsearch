// Unit tests for src/lib/salesDbMerge.js — merging a folder of SABRE
// exports into one CSV without double-counting overlapping pulls.
// Plain-node runner; run with `npm test` or `node test/salesDbMerge.test.js`.

import assert from 'node:assert/strict';
import {
  analyzeSalesCsv, mergeSalesFiles, rowSignature, csvCell, rowsToCsv,
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

test('mergeSalesFiles — header drift only in case/space still merges', () => {
  const merged = mergeSalesFiles([
    { name: 'a.csv', csv: 'Parcel ID,Sold Price\n1,100' },
    { name: 'b.csv', csv: 'parcel id ,SOLD PRICE\n2,200' },
  ]);
  assert.equal(merged.kept, 2);
});

test('mergeSalesFiles — a file with different columns throws, naming the file', () => {
  assert.throws(
    () => mergeSalesFiles([
      { name: 'a.csv', csv: `${HEADER}\n1,I,01-01-2024,100,50` },
      { name: 'odd.csv', csv: 'Roll,Price\n1,100' },
    ]),
    /odd\.csv/,
  );
});

test('mergeSalesFiles — empty input is a clean empty result', () => {
  assert.deepEqual(mergeSalesFiles([]), { text: '', kept: 0, duplicates: 0, total: 0, fileCount: 0 });
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
