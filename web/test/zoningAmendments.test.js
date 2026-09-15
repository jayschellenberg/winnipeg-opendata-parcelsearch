// lib/zoningAmendments.js — merging the DMIS by-law index with live Public
// Notices, and the cell / sort / popup rules. Run: cd web && node test/zoningAmendments.test.js
import assert from 'node:assert/strict';
import {
  buildAmendmentIndex, noticeEntries, amendmentCellText, amendmentLines,
  latestAmendmentYear, entryYear, sortEntries, dmisRecordUrl, ZONING_CHANGE_MODES,
} from '../src/lib/zoningAmendments.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const JSON_FIXTURE = {
  generated: '2026-09-14T19:30:00-0500',
  counts: { bylaws: 3 },
  byRoll: {
    '12030202000': [
      { bylaw: '140/2008', daz: 'DAZ 12/2008', kind: 'rezoning', subject: 'Rezoning: 923 Dorchester Avenue', passed: '2008-07-16', effective: '2008-07-16', amends: '200/2006', confidence: 'address', dmisId: '3136' },
      { bylaw: '9/2003', daz: null, kind: 'rezoning', subject: 'Zoning Change: 923 Dorchester Avenue', passed: '2003-01-29', effective: null, amends: null, confidence: 'corner', dmisId: '77' },
    ],
    '05003895000': [
      { bylaw: '15/2020', kind: 'correction', subject: 'Correction to By-law No. 12/2019', passed: '2020-02-01', confidence: 'correction', dmisId: '9' },
    ],
  },
  nonParcel: [{ bylaw: '3/2012', kind: 'text', subject: 'PDO-1 Academy Road', passed: '2012-01-25', dmisId: '1' }],
  unresolved: [{ bylaw: '1/2001', subject: 'Land bounded by …', reason: 'no address' }],
};
const NOTICES = [
  { notice_type: 'REZONING', notice_id: '26-106557', roll_number: '12030202000', address: '923 Dorchester Avenue', in_date: '2026-01-15T13:30:35.000', meeting_date: '2026-02-03T00:00:00.000', decision: null, dmis_decision: { url: 'https://dmis.winnipeg.ca/x' } },
  { notice_type: 'VARIANCE', notice_id: '26-1', roll_number: '12030202000' },
  { notice_type: 'SUBDIVISION AND REZONING', notice_id: '26-2', roll_number: '99', decision: 'Approved for Posters' },
  { notice_type: 'REZONING', notice_id: '26-2dup', roll_number: '' },
];

console.log('zoningAmendments');

test('modes are off / show / filter, in that order', () => {
  assert.deepEqual(ZONING_CHANGE_MODES, ['off', 'show', 'filter']);
});

test('notices keep only the rezoning types with a roll, one entry per notice', () => {
  const m = noticeEntries(NOTICES);
  assert.deepEqual([...m.keys()].sort(), ['12030202000', '99']);
  const e = m.get('12030202000');
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, 'notice');
  assert.equal(e[0].meetingDate, '2026-02-03');
  assert.equal(e[0].url, 'https://dmis.winnipeg.ca/x');
  assert.equal(m.get('99')[0].decision, 'Approved for Posters');
});

test('the index merges by-laws and notices per roll, newest first, notices ahead', () => {
  const idx = buildAmendmentIndex(JSON_FIXTURE, NOTICES);
  assert.deepEqual(idx.rolls.sort(), ['05003895000', '12030202000', '99']);
  const e = idx.byRoll.get('12030202000');
  assert.deepEqual(e.map((x) => x.kind), ['notice', 'rezoning', 'rezoning']);
  assert.equal(e[1].bylaw, '140/2008');
  assert.equal(idx.nonParcel.length, 1);
  assert.equal(idx.unresolved.length, 1);
  assert.equal(idx.generated, JSON_FIXTURE.generated);
  assert.deepEqual(buildAmendmentIndex(null).rolls, []);
});

test('entry year reads the passing date, then the by-law number', () => {
  assert.equal(entryYear({ passed: '2008-07-16' }), 2008);
  assert.equal(entryYear({ bylaw: '9/2003' }), 2003);
  assert.equal(entryYear({ kind: 'notice', inDate: '2026-01-15' }), 2026);
  assert.equal(entryYear({}), null);
});

test('the grid cell lists every entry, newest first, and sorts by the newest year', () => {
  const idx = buildAmendmentIndex(JSON_FIXTURE, NOTICES);
  const e = idx.byRoll.get('12030202000');
  assert.equal(amendmentCellText(e), 'notice 26-106557 (pending) · 140/2008 (2008) · 9/2003 (2003)');
  assert.equal(latestAmendmentYear(e), 2026);
  assert.equal(amendmentCellText(idx.byRoll.get('05003895000')), '15/2020 (2020) corr.');
  assert.equal(latestAmendmentYear([]), null);
  assert.equal(sortEntries(null).length, 0);
});

test('popup lines carry the label, a detail with the placement caveat, and the DMIS link', () => {
  const idx = buildAmendmentIndex(JSON_FIXTURE, NOTICES);
  const lines = amendmentLines(idx.byRoll.get('12030202000'));
  assert.equal(lines[0].label, 'Rezoning notice 26-106557');
  assert.ok(lines[0].pending);
  assert.match(lines[0].detail, /pending · meeting 2026-02-03/);
  assert.equal(lines[1].label, 'By-law 140/2008 (DAZ 12/2008)');
  assert.equal(lines[1].url, 'https://dmis.winnipeg.ca/ViewByLaw?bylawId=3136');
  assert.match(lines[2].detail, /placed by street corner/);
  assert.equal(dmisRecordUrl({}), null);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
