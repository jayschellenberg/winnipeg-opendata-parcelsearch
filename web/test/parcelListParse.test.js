/*
 * Unit tests for lib/parcelListParse.js — the pasted-list parser behind
 * the Import list modal.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseParcelList, parseAddressCell, parseRollCell, classifyCell,
  cleanAddressCell, looksLikeHeaderRow,
} from '../src/lib/parcelListParse.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

// ---- cleanAddressCell --------------------------------------------

test('strips the Winnipeg, MB locality tail', () => {
  assert.equal(cleanAddressCell('330 Selkirk Ave, Winnipeg, MB'), '330 Selkirk Ave');
});

test('strips Manitoba and Canada too', () => {
  assert.equal(cleanAddressCell('12 Main St, Winnipeg, Manitoba, Canada'), '12 Main St');
});

test('strips a postal code', () => {
  assert.equal(cleanAddressCell('330 Selkirk Ave, Winnipeg, MB R2W 2M1'), '330 Selkirk Ave');
});

test('leaves an address with no locality alone', () => {
  assert.equal(cleanAddressCell('  330   Selkirk Ave '), '330 Selkirk Ave');
});

// ---- parseAddressCell --------------------------------------------

test('parses number and street', () => {
  assert.deepEqual(parseAddressCell('330 Selkirk Ave'), { number: 330, street: 'Selkirk Ave' });
});

test('parses through the locality tail', () => {
  assert.deepEqual(parseAddressCell('417 Selkirk Ave, Winnipeg, MB'),
    { number: 417, street: 'Selkirk Ave' });
});

test('drops a letter suffix on the civic number', () => {
  assert.deepEqual(parseAddressCell('330A Selkirk Ave'), { number: 330, street: 'Selkirk Ave' });
});

test('takes the leading number of a range', () => {
  assert.deepEqual(parseAddressCell('330-340 Selkirk Ave'), { number: 330, street: 'Selkirk Ave' });
});

test('strips a unit prefix', () => {
  assert.deepEqual(parseAddressCell('Unit 5 - 330 Selkirk Ave'),
    { number: 330, street: 'Selkirk Ave' });
});

test('handles a French street name', () => {
  assert.deepEqual(parseAddressCell('101 Rue Marion'), { number: 101, street: 'Rue Marion' });
});

test('handles an apostrophe street', () => {
  assert.deepEqual(parseAddressCell("1250 St. Mary's Rd"), { number: 1250, street: "St. Mary's Rd" });
});

test('rejects a street-only cell', () => {
  assert.equal(parseAddressCell('Selkirk Ave'), null);
});

test('rejects two bare numbers', () => {
  assert.equal(parseAddressCell('330 340'), null);
});

test('rejects an empty cell', () => {
  assert.equal(parseAddressCell('   '), null);
});

// ---- parseRollCell -----------------------------------------------

test('accepts an 11-digit roll', () => {
  assert.equal(parseRollCell('01003547800'), '01003547800');
});

test('accepts a 10-digit roll with the leading zero dropped', () => {
  assert.equal(parseRollCell('1003547800'), '1003547800');
});

test('accepts a roll with separators', () => {
  assert.equal(parseRollCell('010-035-478-00'), '01003547800');
});

test('rejects a civic number', () => {
  assert.equal(parseRollCell('330'), null);
});

test('rejects a 12-digit number', () => {
  assert.equal(parseRollCell('010035478001'), null);
});

test('rejects anything with letters', () => {
  assert.equal(parseRollCell('330 Selkirk'), null);
});

// ---- classifyCell ------------------------------------------------

test('a roll beats the address reading', () => {
  assert.equal(classifyCell('01003547800').kind, 'roll');
});

test('an address classifies as address with an interpreted string', () => {
  const c = classifyCell('330 Selkirk Ave, Winnipeg, MB');
  assert.equal(c.kind, 'address');
  assert.equal(c.number, 330);
  assert.equal(c.interpreted, '330 SELKIRK AVE');
});

test('junk classifies as unparseable', () => {
  assert.equal(classifyCell('Winnipeg').kind, 'unparseable');
});

// ---- looksLikeHeaderRow ------------------------------------------

test('a lone Address header is a header', () => {
  assert.equal(looksLikeHeaderRow(['Address']), true);
});

test('a data row is not a header', () => {
  assert.equal(looksLikeHeaderRow(['330 Selkirk Ave']), false);
});

test('a header word beside real data is not a header row', () => {
  assert.equal(looksLikeHeaderRow(['Location', '330 Selkirk Ave']), false);
});

test('a compound heading is recognized without an exact match', () => {
  assert.equal(looksLikeHeaderRow(['Comp', 'Address or Roll #', 'Notes']), true);
  assert.equal(looksLikeHeaderRow(['Subject Property Address']), true);
  assert.equal(looksLikeHeaderRow(['Roll Number (11 digit)']), true);
});

test('a street literally named Roll is data, not a heading', () => {
  // The loose token match is only reachable when NOTHING in the row
  // parses, and an address always parses — so this stays data.
  assert.equal(looksLikeHeaderRow(['123 Roll Street']), false);
});

test('an all-junk first row with no header word stays data', () => {
  // Reported as unreadable rather than silently swallowed as a header.
  assert.equal(looksLikeHeaderRow(['somewhere downtown']), false);
});

// ---- parseParcelList: the user's own sample ----------------------

const SAMPLE = [
  'Address',
  '330 Selkirk Ave, Winnipeg, MB',
  '393 Selkirk Ave, Winnipeg, MB',
  '407 Selkirk Ave, Winnipeg, MB',
  '413 Selkirk Ave, Winnipeg, MB',
  '417 Selkirk Ave, Winnipeg, MB',
].join('\n');

test('the sample list parses to five addresses on column 0', () => {
  const out = parseParcelList(SAMPLE);
  assert.equal(out.headerDropped, true);
  assert.equal(out.column, 0);
  assert.equal(out.counts.total, 5);
  assert.equal(out.counts.address, 5);
  assert.equal(out.counts.unparseable, 0);
  assert.deepEqual(out.rows.map((r) => r.number), [330, 393, 407, 413, 417]);
  assert.equal(out.rows[0].street, 'Selkirk Ave');
  // Line numbers account for the dropped header, so an error message
  // points at the line the user can actually see in their paste.
  assert.equal(out.rows[0].lineNo, 2);
});

test('the sample parses identically without its header', () => {
  const out = parseParcelList(SAMPLE.split('\n').slice(1).join('\n'));
  assert.equal(out.headerDropped, false);
  assert.equal(out.counts.address, 5);
  assert.equal(out.rows[0].lineNo, 1);
});

test('a multi-column CSV lands on the address column', () => {
  const csv = [
    'Owner,Notes,Address',
    'Smith,check zoning,330 Selkirk Ave',
    'Jones,corner lot,393 Selkirk Ave',
  ].join('\n');
  const out = parseParcelList(csv);
  assert.equal(out.column, 2);
  assert.equal(out.counts.address, 2);
});

// A spreadsheet comp list with a leading index column. The index must not
// reach the lookup, and — the part that actually went wrong — it must not
// end up rendered against the address either. Joining the cells with
// whitespace made "1" + tab + "330 Selkirk Ave" read as "1 330 Selkirk
// Ave", which looks exactly like the parser merged two columns it had in
// fact kept apart.
const COMP_LIST = [
  'Comp\tAddress\tNotes',
  '1\t330 Selkirk Ave, Winnipeg, MB\t',
  '2\t393 Selkirk Ave, Winnipeg, MB\t',
  '10\t563 Selkirk Ave, Winnipeg, MB\tcorner lot',
].join('\n');

test('a leading Comp # column is ignored, not read as part of the address', () => {
  const out = parseParcelList(COMP_LIST);
  assert.equal(out.headerDropped, true);
  assert.equal(out.column, 1, 'the address column must win the scoring');
  assert.equal(out.counts.address, 3);
  assert.deepEqual(out.rows.map((r) => r.number), [330, 393, 563]);
  assert.equal(out.rows[0].street, 'Selkirk Ave');
});

test('the cell shown on the review screen excludes the index column', () => {
  const out = parseParcelList(COMP_LIST);
  assert.equal(out.rows[0].cell, '330 Selkirk Ave, Winnipeg, MB');
  assert.equal(out.rows[2].cell, '563 Selkirk Ave, Winnipeg, MB');
  // Nothing in the displayed cell may lead with the comp number.
  for (const r of out.rows) assert.doesNotMatch(r.cell, /^\d+\s+\d+\s/);
});

test('the full row keeps a visible separator between columns', () => {
  const out = parseParcelList(COMP_LIST);
  // Not "1 330 Selkirk Ave…" — the columns stay legibly apart, and an
  // empty trailing Notes cell adds no dangling separator.
  assert.equal(out.rows[0].raw, '1 · 330 Selkirk Ave, Winnipeg, MB');
  assert.equal(out.rows[2].raw, '10 · 563 Selkirk Ave, Winnipeg, MB · corner lot');
});

test('a tab-delimited spreadsheet paste works', () => {
  const tsv = 'Address\tOwner\n330 Selkirk Ave\tSmith\n393 Selkirk Ave\tJones';
  const out = parseParcelList(tsv);
  assert.equal(out.delimiter, '\t');
  assert.equal(out.column, 0);
  assert.equal(out.counts.address, 2);
});

test('a mixed roll and address list classifies each row', () => {
  const out = parseParcelList('330 Selkirk Ave\n01003547800\n393 Selkirk Ave');
  assert.equal(out.counts.address, 2);
  assert.equal(out.counts.roll, 1);
});

test('a roll-only list parses as rolls', () => {
  const out = parseParcelList('01003547800\n01003546600');
  assert.equal(out.counts.roll, 2);
  assert.equal(out.counts.address, 0);
});

test('blank lines are dropped, not counted as rows', () => {
  const out = parseParcelList('330 Selkirk Ave\n\n\n393 Selkirk Ave\n');
  assert.equal(out.counts.total, 2);
});

test('unparseable rows survive to the review screen', () => {
  const out = parseParcelList('330 Selkirk Ave\nsomewhere downtown\n393 Selkirk Ave');
  assert.equal(out.counts.total, 3);
  assert.equal(out.counts.unparseable, 1);
  assert.equal(out.rows[1].kind, 'unparseable');
  assert.equal(out.rows[1].raw, 'somewhere downtown');
});

test('empty input yields no rows', () => {
  const out = parseParcelList('   \n  \n');
  assert.equal(out.counts.total, 0);
});

// ---- the shipped sample CSV --------------------------------------
// public/sample-parcel-list.csv is offered as a download from the Import
// list modal and is the file people will copy their own list from, so a
// row that stopped parsing would teach the wrong shape. Read the REAL
// file rather than a copy: a sample that drifts out of step with the
// parser is exactly what this guards against.
//
// Resolution needs the network and is not tested here; what is pinned is
// that every row still PARSES, and as the kind it is meant to show.

const SAMPLE_CSV = readFileSync(
  new URL('../public/sample-parcel-list.csv', import.meta.url), 'utf8'
);

test('the sample CSV parses with no unreadable rows', () => {
  const out = parseParcelList(SAMPLE_CSV);
  assert.equal(out.headerDropped, true, 'its header row must be recognized');
  assert.equal(out.column, 1, 'the identifier column must win the scoring');
  assert.equal(out.counts.unparseable, 0, 'no sample row may fail to parse');
  assert.equal(out.counts.total, 9);
});

test('the sample CSV demonstrates both addresses and roll numbers', () => {
  const out = parseParcelList(SAMPLE_CSV);
  assert.equal(out.counts.address, 6);
  assert.equal(out.counts.roll, 3);
});

test('the sample CSV keeps its Comp and Notes columns out of the lookup', () => {
  const out = parseParcelList(SAMPLE_CSV);
  // Nothing from column 0 (Comp) or column 2 (Notes) may reach the cell
  // that gets looked up.
  for (const r of out.rows) {
    assert.doesNotMatch(r.cell, /^\d+,/);
    assert.doesNotMatch(r.cell, /ignored|fine|matches|folded/i);
  }
});

test('the sample CSV covers the roll-number variants it claims to', () => {
  const out = parseParcelList(SAMPLE_CSV);
  const rolls = out.rows.filter((r) => r.kind === 'roll').map((r) => r.roll);
  assert.ok(rolls.some((r) => r.length === 11), 'a full 11-digit roll');
  assert.ok(rolls.some((r) => r.length === 10), 'one with the leading zero dropped');
  // The dashed row must survive as digits only.
  assert.ok(rolls.every((r) => /^\d+$/.test(r)));
});

console.log(`parcelListParse.test.js: ${passed} passed`);
