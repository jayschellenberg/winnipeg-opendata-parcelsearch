// Sales-import parsing — the shared path behind the dropzone, the
// "Paste data…" modal, and a Recent-uploads replay.
//
// What matters here is that a block copied out of SABRE or a spreadsheet
// (TAB-delimited, headers that don't match the CSV export byte for byte)
// lands on exactly the same canonical row objects that lib/sales.js's
// dedupAndGroupSales already consumes — and that when it can't, the
// failure names both what was missing and what was actually seen, since
// that message is how a new SABRE header gets added to the alias table.
import assert from 'node:assert/strict';
import {
  parseSalesText,
  detectSalesDelimiter,
  mapSalesHeaders,
  describeHeaderProblem,
  normalizeHeader,
  normalizeSaleDate,
  SALES_REQUIRED_COLS,
} from '../src/lib/salesImport.js';
import { tokenizeRows, tokenizeRowsFixedWidth } from '../src/lib/delimitedRows.js';
import { dedupAndGroupSales, buildSaleFeatures } from '../src/lib/sales.js';

// ---- normalizeHeader ------------------------------------------------------
// Aggressive folding is what lets one alias entry cover four spellings.
assert.equal(normalizeHeader('Sold Price'), 'soldprice');
assert.equal(normalizeHeader('sold_price'), 'soldprice');
assert.equal(normalizeHeader('Sold-Price '), 'soldprice');
assert.equal(normalizeHeader('SOLDPRICE'), 'soldprice');
assert.equal(normalizeHeader(null), '');

// ---- detectSalesDelimiter -------------------------------------------------
assert.equal(detectSalesDelimiter('a\tb\tc\n1\t2\t3'), '\t', 'tab in the header wins');
assert.equal(detectSalesDelimiter('a,b,c\n1,2,3'), ',');
// Leading blank lines must not defeat the sniff.
assert.equal(detectSalesDelimiter('\n\na\tb\n1\t2'), '\t');
assert.equal(detectSalesDelimiter(''), ',', 'empty input falls back to comma');

// ---- mapSalesHeaders ------------------------------------------------------
const CANON = ['Parcel ID', 'Instrument Number', 'Sale Dates', 'Sold Price'];
{
  const m = mapSalesHeaders(CANON);
  assert.deepEqual(m.missingRequired, [], 'the canonical names map to themselves');
  assert.deepEqual(m.canonicalByIndex, CANON);
  assert.deepEqual(m.unmapped, []);
}
{
  // Alias spellings + a column we don't know about.
  const m = mapSalesHeaders(['Roll Number', 'Instrument', 'Sale Date', 'Consideration', 'Ward']);
  assert.deepEqual(m.missingRequired, []);
  assert.deepEqual(m.canonicalByIndex.slice(0, 4), CANON);
  // Unrecognised columns pass through under their own header rather
  // than being dropped — nothing is lost, and the name is inspectable.
  assert.equal(m.canonicalByIndex[4], 'Ward');
  assert.deepEqual(m.unmapped, ['Ward']);
}
{
  // A second column aliasing to an already-claimed canonical keeps the
  // FIRST and leaves the duplicate under its own header, rather than
  // silently overwriting real data.
  const m = mapSalesHeaders(['Parcel ID', 'Roll #', 'Instrument Number', 'Sale Dates', 'Sold Price']);
  assert.equal(m.canonicalByIndex[0], 'Parcel ID');
  assert.equal(m.canonicalByIndex[1], 'Roll #');
  assert.deepEqual(m.missingRequired, []);
}
{
  const m = mapSalesHeaders(['Parcel ID', 'Sale Dates', 'Mystery Column']);
  assert.deepEqual(m.missingRequired, ['Instrument Number', 'Sold Price']);
  const msg = describeHeaderProblem(m);
  assert.match(msg, /Instrument Number/);
  assert.match(msg, /Sold Price/);
  // The echo of unrecognised headers is the whole feedback loop for
  // adding a new SABRE alias — it must survive refactors.
  assert.match(msg, /Mystery Column/);
}
assert.equal(describeHeaderProblem({ missingRequired: [], unmapped: ['x'] }), '',
  'no message when nothing required is missing');

// ---- parseSalesText: comma (the existing CSV export path) -----------------
const CSV = [
  'Parcel ID,Instrument Number,Sale Dates,Sold Price,Land Actual sqft,Year Built',
  '6070731000,INST-1,2025-03-14,450000,5200,1954',
  '6070732000,INST-2,2025-04-02,610000,6100,1978',
].join('\n');
{
  const p = parseSalesText(CSV);
  assert.equal(p.delimiter, ',');
  assert.deepEqual(p.missingRequired, []);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0]['Parcel ID'], '6070731000');
  assert.equal(p.rows[0]['Sold Price'], '450000');
  assert.equal(p.rows[1]['Year Built'], '1978');
}

// ---- parseSalesText: TAB paste with aliased headers ----------------------
// The SABRE / spreadsheet clipboard shape. Different header spellings,
// tab-separated, and it must produce byte-identical canonical rows.
const PASTE = [
  'Roll Number\tInstrument\tSale Date\tConsideration\tLand Actual sqft\tYear Built',
  '6070731000\tINST-1\t2025-03-14\t450000\t5200\t1954',
  '6070732000\tINST-2\t2025-04-02\t610000\t6100\t1978',
].join('\r\n');   // Windows line endings, as a real clipboard delivers
{
  const p = parseSalesText(PASTE);
  assert.equal(p.delimiter, '\t');
  assert.deepEqual(p.missingRequired, []);
  assert.equal(p.rows.length, 2);
  // The pasted rows and the CSV rows are the same canonical objects.
  assert.deepEqual(p.rows, parseSalesText(CSV).rows);
}

// ---- parseSalesText: quoting + embedded delimiters -----------------------
{
  const q = [
    'Parcel ID,Instrument Number,Sale Dates,Sold Price,Street Name',
    '6070731000,INST-1,2025-03-14,450000,"SMITH, JOHN WAY"',
    '6070732000,INST-2,2025-04-02,610000,"THE ""OLD"" ROAD"',
  ].join('\n');
  const p = parseSalesText(q);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0]['Street Name'], 'SMITH, JOHN WAY', 'quoted comma stays in the cell');
  assert.equal(p.rows[1]['Street Name'], 'THE "OLD" ROAD', 'doubled quotes unescape');
}

// ---- parseSalesText: rejection paths -------------------------------------
{
  // Headers present but nothing recognised → no rows, and the caller
  // gets a message rather than a bare "no data rows".
  const p = parseSalesText('Foo\tBar\n1\t2');
  assert.equal(p.rows.length, 0);
  assert.deepEqual(p.missingRequired, SALES_REQUIRED_COLS);
  assert.match(describeHeaderProblem(p), /Foo/);
}
{
  // Header row only — the columns ARE all present, there's just no data.
  // Reporting them as "missing" would be a lie, and the caller would
  // show the wrong error; the empty-rows branch owns this case.
  const p = parseSalesText('Parcel ID,Instrument Number,Sale Dates,Sold Price');
  assert.equal(p.rows.length, 0);
  assert.deepEqual(p.missingRequired, []);
  assert.equal(describeHeaderProblem(p), '');
}
{
  // Empty input: no header row to judge, so nothing is "missing".
  for (const input of ['', '   ', null, undefined]) {
    const p = parseSalesText(input);
    assert.equal(p.rows.length, 0);
    assert.deepEqual(p.missingRequired, [], `empty input ${JSON.stringify(input)}`);
    assert.equal(describeHeaderProblem(p), '');
  }
}

// ---- A real CSV that omits trailing empty columns ------------------------
// Ragged for the WRONG reason: the fixed-width reassembly would splice
// these two rows into one, so the naive parse has to win.
{
  const ragged = [
    'Parcel ID,Instrument Number,Sale Dates,Sold Price,Year Built',
    '6070731000,INST-1,2025-03-14,450000',
    '6070732000,INST-2,2025-04-02,610000',
  ].join('\n');
  const p = parseSalesText(ragged);
  assert.equal(p.rows.length, 2, 'short rows stay separate records');
  assert.equal(p.rows[0]['Year Built'], '', 'the omitted trailing column reads blank');
}

// ---- End to end: pasted text → dedupAndGroupSales ------------------------
// The point of the canonical keying: the downstream pipeline is untouched.
{
  const p = parseSalesText(PASTE);
  const { sales, rolls, groups } = dedupAndGroupSales(p.rows);
  assert.equal(sales.length, 2);
  assert.equal(sales[0].salePrice, 450000);
  assert.equal(sales[0].landSf, 5200);
  assert.equal(sales[0].yearBuilt, '1954');
  // normalizeRoll zero-pads the 10-digit export roll to 11 digits so it
  // joins to the live d4mq-wa44 record.
  assert.equal(sales[0].roll, '06070731000');
  assert.equal(rolls.size, 2);
  assert.equal(groups.size, 2);
}
{
  // Two rows, same roll AND same instrument = building components of one
  // sale: they merge, summing living area and keeping the oldest year.
  const multi = [
    'Parcel ID\tInstrument Number\tSale Dates\tSold Price\tLiving Area\tYear Built',
    '6070731000\tINST-9\t2025-03-14\t900000\t1200\t2012',
    '6070731000\tINST-9\t2025-03-14\t900000\t800\t2008',
  ].join('\n');
  const { sales } = dedupAndGroupSales(parseSalesText(multi).rows);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].livingArea, 2000);
  assert.equal(sales[0].yearBuilt, '2008');
}

// ---- normalizeSaleDate ---------------------------------------------------
// SABRE emits MM-DD-YYYY. The sale-date filter compares dates as STRINGS
// against an ISO <input type="date"> value, so an unconverted date makes
// every pasted row vanish the moment a bound is set.
assert.equal(normalizeSaleDate('04-14-2026'), '2026-04-14');
assert.equal(normalizeSaleDate('03-27-2026'), '2026-03-27');
assert.equal(normalizeSaleDate('02-03-2026'), '2026-02-03', 'month-first, per SABRE');
assert.equal(normalizeSaleDate('4/1/2026'), '2026-04-01', 'slashes and single digits');
// Already ISO passes through untouched (the City CSV export path).
assert.equal(normalizeSaleDate('2026-04-14'), '2026-04-14');
assert.equal(normalizeSaleDate('2026-04-14T00:00:00'), '2026-04-14');
// First field > 12 can only be a day — read it day-first rather than
// silently emitting a nonsense month.
assert.equal(normalizeSaleDate('27-03-2026'), '2026-03-27');
// Unparseable input is returned AS-IS rather than destroyed.
assert.equal(normalizeSaleDate('not a date'), 'not a date');
assert.equal(normalizeSaleDate('13-45-2026'), '13-45-2026', 'impossible day is left alone');
assert.equal(normalizeSaleDate(''), '');
assert.equal(normalizeSaleDate(null), '');
// The ordering property the filter actually depends on.
{
  const raw = ['02-03-2026', '03-27-2026', '04-01-2026', '04-14-2026', '05-05-2026', '06-04-2026'];
  const iso = raw.map(normalizeSaleDate);
  assert.deepEqual(iso, [...iso].sort(), 'ISO output sorts chronologically as strings');
  assert.ok(iso.every((d) => d >= '2026-01-01' && d <= '2026-12-31'),
    'ISO output compares correctly against an <input type="date"> bound');
}

// ---- The real SABRE sample ------------------------------------------------
// Verbatim head of a SABRE clipboard block: tab-separated, MM-DD-YYYY
// dates, six component rows for one multi-unit parcel, a Sworn Value
// column, and a $1 nominal sale.
const SABRE = [
  'Parcel ID\tPar Use Code\tNumber of Unit\tYear Built\tLiving Area\tLand Assessed sqft\tLand Actual sqft\tProperty Type\tProperty Sub Type\tStreet Number\tStreet Direction\tStreet Name\tSale Dates\tSold Price\tInstrument Number\tSworn Value\tZoning',
  '14060118000\tVRES2\t1\t\t\t5825\t5757\tVacant Land\tResidential\t185\t\tBANNERMAN\t02-03-2026\t1290000\t5835797\t1290000\tR2',
  '14060118000\tVRES2\t2\t\t\t5825\t5757\tVacant Land\tResidential\t185\t\tBANNERMAN\t02-03-2026\t1290000\t5835797\t1290000\tR2',
  '14060118000\tVRES2\t3\t\t\t5825\t5757\tVacant Land\tResidential\t185\t\tBANNERMAN\t02-03-2026\t1290000\t5835797\t1290000\tR2',
  '14060118000\tVRES2\t4\t\t\t5825\t5757\tVacant Land\tResidential\t185\t\tBANNERMAN\t02-03-2026\t1290000\t5835797\t1290000\tR2',
  '14060118000\tVRES2\t5\t\t\t5825\t5757\tVacant Land\tResidential\t185\t\tBANNERMAN\t02-03-2026\t1290000\t5835797\t1290000\tR2',
  '14060118000\tVRES2\t6\t\t\t5825\t5757\tVacant Land\tResidential\t185\t\tBANNERMAN\t02-03-2026\t1290000\t5835797\t1290000\tR2',
  '13061192000\tVRES2\t\t\t\t3267\t3311\tVacant Land\tResidential\t432\t\tBANNATYNE\t03-27-2026\t80000\t5850710\t80000\tRMU',
  '3092994310\tVRES2\t\t\t\t\t132852\tVacant Land\tResidential\t3280\t\tPEMBINA\t04-01-2026\t2950000\t5852257\t2950000\tRMFM',
  '6093463485\tVRES2\t\t\t\t\t148173\tVacant Land\tResidential\t\t\t\t05-05-2026\t1\t5862559\t4080000\tRMFM',
  '13071994000\tVRES2\t\t\t\t3214\t3211\tVacant Land\tResidential\t572\t\tROSS\t06-04-2026\t330000\t5872458\t330000\tRMFS',
].join('\r\n');

{
  const p = parseSalesText(SABRE);
  assert.equal(p.delimiter, '\t');
  assert.deepEqual(p.missingRequired, [], 'every required column is recognised');
  assert.deepEqual(p.unmapped, [], 'every SABRE header maps to a canonical name');
  assert.equal(p.rows.length, 10);
  // Dates converted on the way in.
  assert.equal(p.rows[0]['Sale Dates'], '2026-02-03');
  assert.equal(p.rows[6]['Sale Dates'], '2026-03-27');
  // The two columns the sample added.
  assert.equal(p.rows[8]['Sworn Value'], '4080000');
  assert.equal(p.rows[8]['Sold Price'], '1');
  assert.equal(p.rows[0]['Zoning'], 'R2');
  // Blank cells stay blank rather than shifting neighbouring columns.
  assert.equal(p.rows[7]['Land Assessed sqft'], '');
  assert.equal(p.rows[7]['Land Actual sqft'], '132852');
  assert.equal(p.rows[8]['Street Name'], '');

  const { sales, groups } = dedupAndGroupSales(p.rows);
  // Six component rows for 185 BANNERMAN collapse to ONE sale.
  assert.equal(sales.length, 5, '10 rows → 5 distinct (roll, instrument) sales');
  const bannerman = sales.find((s) => s.instrument === '5835797');
  assert.equal(bannerman.roll, '14060118000');
  assert.equal(bannerman.numUnits, 6,
    'Number of Unit runs 1..6 across the component rows — the count is the MAX, not the first');
  assert.equal(bannerman.salePrice, 1290000);
  assert.equal(bannerman.landSf, 5757);
  assert.equal(bannerman.zoning, 'R2');
  assert.equal(bannerman.saleDate, '2026-02-03');
  // 10-digit rolls zero-pad to 11 so they join to d4mq-wa44.
  assert.equal(sales.find((s) => s.instrument === '5852257').roll, '03092994310');
  // Each sale is its own group here (no shared instruments).
  assert.equal(groups.size, 5);

  // The $1 nominal transfer: sale price stays $1, sworn value is
  // carried alongside and NEVER folded into the price.
  const nominal = sales.find((s) => s.instrument === '5862559');
  assert.equal(nominal.salePrice, 1);
  assert.equal(nominal.swornValue, 4080000);
}

{
  // buildSaleFeatures stamps the new fields, and Sworn only renders
  // when it actually differs from the sale price.
  const p = parseSalesText(SABRE);
  const { sales, groups } = dedupAndGroupSales(p.rows);
  const feats = buildSaleFeatures(sales, new Map(), groups);
  const byInst = new Map(feats.map((f) => [f.properties._saleInstrument, f.properties]));
  const nominal = byInst.get('5862559');
  // The $1 is stamped as-is — it's the "Hide $0/$1" filter, not the
  // stamping, that keeps a nominal transfer out of the comp set. What
  // matters here is that the sworn value rides alongside it and the
  // price was NOT quietly replaced by 4,080,000.
  assert.equal(nominal._salePrice, 1);
  assert.equal(nominal._saleSwornValue, 4080000, 'the real figure is surfaced separately');
  // An ordinary sale (sworn === sold) now SHOWS its sworn value. Blanking
  // it made the column empty exactly when the data was fine, so a blank
  // could mean either "not in the export" or "present and matching" —
  // indistinguishable, and the second is worth confirming.
  assert.equal(byInst.get('5835797')._saleSwornValue, 1290000);
  assert.equal(byInst.get('5835797')._saleNumUnits, 6);
  assert.equal(byInst.get('5835797')._saleZoning, 'R2');
}

// ---- The Instrument Number is what defines a sale -------------------------
// It is the unique identifier for a transaction, so it alone decides
// whether two parcels belong to one multi-parcel sale. Two things this
// has to get right, and the SABRE sample contains both traps.
{
  // Trap 1: 3092986065 and 3092986060 sold the SAME DAY for the SAME
  // PRICE — but under instruments 5852912 and 5852911. Different
  // instruments = two separate single-parcel sales. Anything keying on
  // date+price would wrongly fuse them into one two-parcel sale.
  const sameDayDifferentInstruments = [
    'Parcel ID\tInstrument Number\tSale Dates\tSold Price\tLand Actual sqft',
    '3092986065\t5852912\t04-02-2026\t3150000\t88493',
    '3092986060\t5852911\t04-02-2026\t3150000\t85102',
  ].join('\n');
  const { sales, groups } = dedupAndGroupSales(parseSalesText(sameDayDifferentInstruments).rows);
  assert.equal(sales.length, 2);
  assert.equal(groups.size, 2, 'same day + same price + different instruments = TWO sales');
  assert.equal(groups.get('5852912').length, 1);
  assert.equal(groups.get('5852911').length, 1);
}
{
  // Trap 2: the converse — two DIFFERENT parcels on ONE instrument is a
  // single sale spanning both, and the group aggregates must span it too.
  const twoParcelsOneInstrument = [
    'Parcel ID\tInstrument Number\tSale Dates\tSold Price\tLand Actual sqft',
    '3092986065\t5852912\t04-02-2026\t3150000\t88493',
    '3092986060\t5852912\t04-02-2026\t3150000\t85102',
  ].join('\n');
  const { sales, groups } = dedupAndGroupSales(parseSalesText(twoParcelsOneInstrument).rows);
  assert.equal(sales.length, 2, 'still one record per parcel');
  assert.equal(groups.size, 1, 'one instrument = ONE sale');
  assert.equal(groups.get('5852912').length, 2, 'covering two parcels');

  const feats = buildSaleFeatures(sales, new Map(), groups);
  assert.equal(feats[0].properties._saleGroupSize, 2, 'Group # reports the parcel count');
  // Sold Price is the whole-sale total on every member row, so $/Lot SF
  // divides by the group's SUMMED land, not one parcel's.
  assert.equal(feats[0].properties._pricePerSf, 3150000 / (88493 + 85102));
}
{
  // 185 BANNERMAN, verbatim from the SABRE sample: six rows on one
  // instrument that all carry the SAME Parcel ID. That is one sale of
  // ONE parcel containing six units — confirmed with Jason 2026-08-05 —
  // not a six-parcel sale.
  //
  // The land figure is the reason this matters. Land Actual sqft is
  // 5757 REPEATED on each of the six rows, not 5757 apiece. Collapsing
  // to one record counts it once and yields $224/sf; treating the rows
  // as six group members would sum it to 34,542 sf and report $37/sf —
  // a 6x understatement of the land rate.
  const bannermanRow = (unit) =>
    `14060118000\t5835797\t02-03-2026\t1290000\t${unit}\t5757`;
  const componentRows = [
    'Parcel ID\tInstrument Number\tSale Dates\tSold Price\tNumber of Unit\tLand Actual sqft',
    ...[1, 2, 3, 4, 5, 6].map(bannermanRow),
  ].join('\n');
  const { sales, groups } = dedupAndGroupSales(parseSalesText(componentRows).rows);
  assert.equal(sales.length, 1, 'six component rows collapse to one sale');
  assert.equal(groups.get('5835797').length, 1, 'one PARCEL, six units — not six parcels');
  assert.equal(sales[0].numUnits, 6);
  assert.equal(sales[0].landSf, 5757, 'repeated land is counted ONCE, not summed to 34,542');

  const p = buildSaleFeatures(sales, new Map(), groups)[0].properties;
  assert.equal(p._saleGroupSize, 1);
  assert.equal(Math.round(p._pricePerSf), 224, '$1,290,000 ÷ 5,757 sf — not ÷ 34,542');
}
{
  // A blank Instrument Number can't be grouped, so the row is dropped —
  // but the count comes back so the UI can say a sale went missing
  // instead of it vanishing unremarked.
  const missingInstrument = [
    'Parcel ID\tInstrument Number\tSale Dates\tSold Price',
    '3092986065\t5852912\t04-02-2026\t3150000',
    '3092986060\t\t04-02-2026\t3150000',
    '\t5852999\t04-02-2026\t3150000',
  ].join('\n');
  const out = dedupAndGroupSales(parseSalesText(missingInstrument).rows);
  assert.equal(out.sales.length, 1);
  assert.equal(out.dropped, 2, 'both unplaceable rows are counted, not silently lost');
}
assert.equal(dedupAndGroupSales([]).dropped, 0);

// ---- delimitedRows tokenizers --------------------------------------------
assert.deepEqual(tokenizeRows('a,b\n1,2', ','), [['a', 'b'], ['1', '2']]);
assert.deepEqual(tokenizeRows('a\tb\r\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
assert.deepEqual(tokenizeRows('', ','), []);
// Fixed-width reassembly: an UNQUOTED newline inside a non-final cell
// belongs to that cell, not to a new row.
assert.deepEqual(
  tokenizeRowsFixedWidth('a,b,c\n1\n2,x,y', ',', 3),
  [['a', 'b', 'c'], ['1\n2', 'x', 'y']],
);

console.log('salesImport.test.js: all assertions passed');
