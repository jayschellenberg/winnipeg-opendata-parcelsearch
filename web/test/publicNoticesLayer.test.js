// lib/publicNoticesLayer.js — rezoning notices + DMIS by-laws as points,
// cut to the last N years. Run: cd web && node test/publicNoticesLayer.test.js
import assert from 'node:assert/strict';
import {
  NOTICE_YEAR_OPTIONS, DEFAULT_NOTICE_YEARS, NOTICE_CATEGORIES, cleanNoticeYears, noticeCutoff,
  noticeFeatures, bylawFeatures, bylawRolls, filterByYears, categoryCounts, noticePopupParts,
  categoryColorExpression, NOTICE_SOURCE_OPTIONS, cleanNoticeSource, filterBySource,
} from '../src/lib/publicNoticesLayer.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const TODAY = new Date(2026, 10, 3);   // 2026-11-03 local

const JSON_FIXTURE = {
  byRoll: {
    '100': [
      { bylaw: '87/2019', daz: 'DASZ 22/2018', kind: 'subdivision-rezoning', subject: 'Plan of Subdivision and Rezoning: 1 A St', passed: '2019-11-21', effective: '2019-11-21', confidence: 'address', dmisId: '7618' },
      { bylaw: '12/2025', kind: 'rezoning', subject: 'Rezoning: 1 A St', passed: '2025-03-01', confidence: 'corner', dmisId: '9001' },
    ],
    '200': [
      { bylaw: '87/2019', kind: 'subdivision-rezoning', subject: 'Plan of Subdivision and Rezoning: 1 A St', passed: '2019-11-21', confidence: 'address', dmisId: '7618' },
    ],
    '300': [{ bylaw: '5/2024', kind: 'correction', passed: '2024-06-01', dmisId: '42' }],
    '400': [{ bylaw: '3/2012', kind: 'text', passed: '2012-01-25', dmisId: '1' }],
  },
};
const CENTROIDS = new Map([['100', [-97.0, 49.0]], ['200', [-97.2, 49.2]]]);

const NOTICES = [
  { notice_type: 'REZONING', notice_id: '26-1', address: '9 B Ave', in_date: '2026-01-15T13:30:35.000', meeting_date: '2026-02-03T00:00:00.000', point: { type: 'Point', coordinates: [-97.1, 49.9] }, dmis_decision: { url: 'https://dmis.winnipeg.ca/x' } },
  { notice_type: 'REZONING', notice_id: '26-1', point: { coordinates: [-97.1, 49.9] } },
  { notice_type: 'ZONING AGREEMENT AMENDMENT', notice_id: '25-2', in_date: '2025-02-01T00:00:00', location: { latitude: '49.8', longitude: '-97.3' }, decision: 'Approved' },
  { notice_type: 'SUBDIVISION AND REZONING', notice_id: '26-3', in_date: '2026-05-01' },
  { notice_type: 'VARIANCE', notice_id: '26-4', point: { coordinates: [-97, 49] } },
];

console.log('publicNoticesLayer');

test('year options and default', () => {
  assert.deepEqual(NOTICE_YEAR_OPTIONS, ['1', '2', '3', '5', '10', 'all']);
  assert.equal(DEFAULT_NOTICE_YEARS, '5');
  assert.equal(cleanNoticeYears('10'), '10');
  assert.equal(cleanNoticeYears('ALL'), 'all');
  assert.equal(cleanNoticeYears('7'), '5');
  assert.equal(cleanNoticeYears(null), '5');
});

test('cutoff counts back whole years from today', () => {
  assert.equal(noticeCutoff('1', TODAY), '2025-11-03');
  assert.equal(noticeCutoff('5', TODAY), '2021-11-03');
  assert.equal(noticeCutoff('all', TODAY), null);
});

test('notices: rezoning types only, deduped, point or location, unplaced counted', () => {
  const { features, unplaced } = noticeFeatures(NOTICES);
  assert.equal(features.length, 2);
  assert.equal(unplaced, 1);
  const [a, b] = features;
  assert.equal(a.properties.category, 'notice-rezoning');
  assert.deepEqual(a.geometry.coordinates, [-97.1, 49.9]);
  assert.equal(a.properties.date, '2026-01-15');
  assert.equal(a.properties.url, 'https://dmis.winnipeg.ca/x');
  assert.equal(b.properties.category, 'notice-zaa');
  assert.deepEqual(b.geometry.coordinates, [-97.3, 49.8]);
});

test('by-laws: one point per by-law at the mean centroid; text amendments skipped', () => {
  assert.deepEqual(bylawRolls(JSON_FIXTURE).sort(), ['100', '200', '300', '400']);
  const { features, unplaced } = bylawFeatures(JSON_FIXTURE, CENTROIDS);
  const byBylaw = Object.fromEntries(features.map((f) => [f.properties.bylaw, f]));
  assert.deepEqual(Object.keys(byBylaw).sort(), ['12/2025', '87/2019']);
  assert.equal(unplaced, 1);   // the correction's roll has no centroid
  const sub = byBylaw['87/2019'];
  assert.equal(sub.properties.parcels, 2);
  assert.equal(sub.properties.category, 'bylaw-subdivision');
  assert.ok(Math.abs(sub.geometry.coordinates[0] - -97.1) < 1e-9);
  assert.ok(Math.abs(sub.geometry.coordinates[1] - 49.1) < 1e-9);
  assert.equal(sub.properties.url, 'https://dmis.winnipeg.ca/ViewByLaw?bylawId=7618');
  assert.equal(byBylaw['12/2025'].properties.corner, 1);
});

test('by-laws: plain-object centroids work too', () => {
  const { features } = bylawFeatures(JSON_FIXTURE, { 300: [-97, 49] });
  assert.deepEqual(features.map((f) => f.properties.bylaw), ['5/2024']);
});

test('years filter keeps on/after the cutoff, drops undated unless all', () => {
  const f = (date) => ({ properties: { date } });
  const all = [f('2026-01-01'), f('2021-11-03'), f('2021-11-02'), f(null)];
  assert.equal(filterByYears(all, '5', TODAY).length, 2);
  assert.equal(filterByYears(all, 'all', TODAY).length, 4);
  assert.equal(filterByYears(all, '1', TODAY).length, 1);
});

test('category counts and colour expression cover every category', () => {
  const { features } = noticeFeatures(NOTICES);
  const counts = categoryCounts(features);
  assert.equal(counts['notice-rezoning'], 1);
  assert.equal(counts['notice-zaa'], 1);
  assert.equal(counts['bylaw-rezoning'], 0);
  const expr = categoryColorExpression();
  for (const c of NOTICE_CATEGORIES) assert.ok(expr.includes(c.key) && expr.includes(c.color));
});

test('source filter: both / notices only / by-laws only', () => {
  assert.deepEqual(NOTICE_SOURCE_OPTIONS, ['both', 'notice', 'bylaw']);
  assert.equal(cleanNoticeSource('BYLAW'), 'bylaw');
  assert.equal(cleanNoticeSource('x'), 'both');
  const all = [
    ...bylawFeatures(JSON_FIXTURE, CENTROIDS).features,
    ...noticeFeatures(NOTICES).features,
  ];
  assert.equal(filterBySource(all, 'both').length, 4);
  assert.deepEqual(filterBySource(all, 'notice').map((f) => f.properties.source), ['notice', 'notice']);
  assert.deepEqual(filterBySource(all, 'bylaw').map((f) => f.properties.source), ['bylaw', 'bylaw']);
});

test('popup parts for a by-law and a notice', () => {
  const { features } = bylawFeatures(JSON_FIXTURE, CENTROIDS);
  const sub = features.find((x) => x.properties.bylaw === '87/2019');
  const p1 = noticePopupParts(sub.properties);
  assert.match(p1.heading, /Subdivision \+ rezoning by-law 87\/2019 \(DASZ 22\/2018\)/);
  assert.ok(p1.lines.includes('2 parcels (point at their centre)'));
  assert.equal(p1.links[0].label, 'DMIS by-law record');
  const p2 = noticePopupParts(noticeFeatures(NOTICES).features[0].properties);
  assert.equal(p2.heading, 'Rezoning notice 26-1');
  assert.ok(p2.lines.some((l) => l.startsWith('Pending · filed 2026-01-15')));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
