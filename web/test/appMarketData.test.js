// Unit tests for src/lib/appMarketData.js. Plain-node runner; run with
// `npm test` or `node test/appMarketData.test.js`.
import assert from 'node:assert/strict';
import { resolveAppFolder, filterAppFiles } from '../src/lib/appMarketData.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

// Minimal FileSystemDirectoryHandle stand-in: { name, kind, entries() }.
function dir(name, children = []) {
  return {
    name,
    kind: 'directory',
    async *entries() { for (const c of children) yield [c.name, c]; },
  };
}
const file = (name) => ({ name, kind: 'file' });

const winnipeg = dir('Winnipeg', [file('wpg-sales-with-n1.csv')]);
const manitoba = dir('Manitoba', [file('manifest.json')]);
const sales = dir('SalesData', [manitoba, winnipeg]);
const root = dir('AppMarketData', [dir('CapRates'), sales]);

console.log('appMarketData');

await test('steps down from AppMarketData or SalesData to the city folder', async () => {
  assert.equal(await resolveAppFolder(root, ['SalesData', 'Winnipeg']), winnipeg);
  assert.equal(await resolveAppFolder(sales, ['SalesData', 'Manitoba']), manitoba);
});

await test('keeps the target folder itself, case-insensitively', async () => {
  assert.equal(await resolveAppFolder(winnipeg, ['SalesData', 'Winnipeg']), winnipeg);
  assert.equal(await resolveAppFolder(dir('appmarketdata', [sales]), ['salesdata', 'winnipeg']), winnipeg);
});

await test('leaves an off-path pick alone (a personal export folder)', async () => {
  const mine = dir('My SABRE exports', [file('SoldPropertyListing.csv')]);
  assert.equal(await resolveAppFolder(mine, ['SalesData', 'Winnipeg']), mine);
});

await test('leaves the pick alone when the path breaks part way', async () => {
  const partial = dir('AppMarketData', [dir('SalesData', [manitoba])]);
  assert.equal(await resolveAppFolder(partial, ['SalesData', 'Winnipeg']), partial);
});

await test('filterAppFiles keeps only the target subfolder of a parent selection', () => {
  const f = (p) => ({ name: p.split('/').pop(), webkitRelativePath: p });
  const list = [
    f('AppMarketData/SalesData/Winnipeg/wpg-sales-with-n1.csv'),
    f('AppMarketData/SalesData/Manitoba/muni_101.csv'),
    f('AppMarketData/RentalDashboard/export/listings.csv'),
  ];
  assert.deepEqual(filterAppFiles(list, ['SalesData', 'Winnipeg']).map((x) => x.name), ['wpg-sales-with-n1.csv']);
  const direct = [f('exports/a.csv'), f('exports/b.csv')];
  assert.equal(filterAppFiles(direct, ['SalesData', 'Winnipeg']).length, 2);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
