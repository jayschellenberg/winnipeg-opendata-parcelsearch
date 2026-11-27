// lib/redevelopmentPermits.js — Construct New + Demolish permits as points,
// teardown pairing, the developing-subdivision fade, and the area summary.
// Run: cd web && node test/redevelopmentPermits.test.js
import assert from 'node:assert/strict';
import {
  REDEV_CATEGORIES, cleanRedevYears, cleanRedevHomes, redevCutoff, redevFetchSince,
  permitEvents, developingNeighbourhoods, redevFeatures, filterRedev, summariseRedev,
  redevSummaryText, redevPopupParts, redevColorExpression, distanceKm,
} from '../src/lib/redevelopmentPermits.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const TODAY = new Date(2026, 10, 27);   // 2026-11-27 local
const SUBJECT = [-97.15, 49.88];
// ~0.0139 deg lat = 1.55 km; ~0.0045 = 0.5 km
const near = (dLat = 0.0045) => ({ type: 'Point', coordinates: [SUBJECT[0], SUBJECT[1] + dLat] });

const row = (o) => ({
  work_type: 'Construct New', permit_type: 'Housing', sub_type: 'SFD',
  street_number: '10', street_name: 'Maple', street_type: 'St',
  neighbourhood_name: 'OLD TOWN', point: near(), ...o,
});

console.log('redevelopmentPermits');

test('dropdown values clean to the defaults', () => {
  assert.equal(cleanRedevYears('3'), '3');
  assert.equal(cleanRedevYears('7'), '5');
  assert.equal(cleanRedevHomes('HIDE'), 'hide');
  assert.equal(cleanRedevHomes(''), 'auto');
});

test('cutoff and fetch-since dates', () => {
  assert.equal(redevCutoff('5', TODAY), '2021-11-27');
  assert.equal(redevCutoff('10', TODAY), '2016-11-27');
  assert.equal(redevFetchSince(TODAY), '2016-01-01T00:00:00.000');
});

test('permitEvents keeps new + demo, drops accessory, dupes and unplaced rows', () => {
  const { events, unplaced } = permitEvents([
    row({ permit_number: 'A', issue_date: '2024-05-01T00:00:00.000' }),
    row({ permit_number: 'A', issue_date: '2024-05-01T00:00:00.000' }),
    row({ permit_number: 'B', issue_date: '2024-05-01', permit_type: 'Accessory Structures' }),
    row({ permit_number: 'C', issue_date: '2024-05-01', work_type: 'Alter' }),
    row({ permit_number: 'D', issue_date: '2024-05-01', point: null }),
    row({ permit_number: 'E', issue_date: '2023-01-01', work_type: 'Demolish', dwelling_units_lost: '1' }),
    row({ permit_number: 'F', issue_date: '2023-01-01', permit_type: 'Multi-Residential', dwelling_units_created: '24' }),
  ]);
  assert.deepEqual(events.map((e) => e.permitNumber), ['A', 'E', 'F']);
  assert.equal(unplaced, 1);
  assert.equal(events[1].kind, 'demo');
  assert.equal(events[1].unitsLost, 1);
  assert.equal(events[2].group, 'multi');
  assert.equal(events[2].unitsCreated, 24);
  assert.equal(events[0].address, '10 Maple St');
});

test('developing = many new homes and > 10 per demolition', () => {
  const ev = [];
  for (let i = 0; i < 30; i++) ev.push({ kind: 'new', group: 'home', neighbourhood: 'NEW BURB' });
  for (let i = 0; i < 30; i++) ev.push({ kind: 'new', group: 'home', neighbourhood: 'INFILL' });
  for (let i = 0; i < 10; i++) ev.push({ kind: 'demo', group: 'home', neighbourhood: 'INFILL' });
  for (let i = 0; i < 10; i++) ev.push({ kind: 'new', group: 'home', neighbourhood: 'SMALL' });
  const d = developingNeighbourhoods(ev);
  assert.ok(d.has('NEW BURB'));
  assert.ok(!d.has('INFILL'));
  assert.ok(!d.has('SMALL'), 'below the 25-home floor');
});

test('a demolition and a new permit at one address merge into a rebuild', () => {
  const { events } = permitEvents([
    row({ permit_number: 'D1', work_type: 'Demolish', issue_date: '2023-03-01', dwelling_units_lost: '1' }),
    row({ permit_number: 'N1', issue_date: '2023-09-01', street_type: 'Street', dwelling_units_created: '2' }),
    row({ permit_number: 'D2', work_type: 'Demolish', issue_date: '2015-01-01', street_number: '12' }),
    row({ permit_number: 'N2', issue_date: '2024-01-01', street_number: '12' }),   // 9 yrs later: not a pair
    row({ permit_number: 'N3', issue_date: '2024-01-01', street_number: '14' }),
  ]);
  const fs = redevFeatures(events);
  const by = Object.fromEntries(fs.map((f) => [f.properties.permitNumber, f.properties]));
  assert.equal(fs.length, 4);
  assert.equal(by.N1.category, 'rebuild');
  assert.equal(by.N1.demoPermitNumber, 'D1');
  assert.equal(by.N1.unitsLost, 1);
  assert.equal(by.N1.unitsCreated, 2);
  assert.equal(by.N2.category, 'new-home');
  assert.equal(by.D2.category, 'demo');
  assert.equal(by.N3.category, 'new-home');
});

test('one demolition pairs with only the nearest new permit', () => {
  const { events } = permitEvents([
    row({ permit_number: 'D', work_type: 'Demolish', issue_date: '2023-03-01' }),
    row({ permit_number: 'N1', issue_date: '2023-05-01' }),
    row({ permit_number: 'N2', issue_date: '2025-05-01' }),
  ]);
  const cats = Object.fromEntries(redevFeatures(events).map((f) => [f.properties.permitNumber, f.properties.category]));
  assert.deepEqual(cats, { N1: 'rebuild', N2: 'new-home' });
});

test('filterRedev: period cut, fade and hide only touch developing homes', () => {
  const { events } = permitEvents([
    row({ permit_number: 'OLD', issue_date: '2019-01-01' }),
    row({ permit_number: 'G', issue_date: '2024-01-01', neighbourhood_name: 'NEW BURB' }),
    row({ permit_number: 'M', issue_date: '2024-01-01', neighbourhood_name: 'NEW BURB', permit_type: 'Multi-Residential' }),
    row({ permit_number: 'I', issue_date: '2024-01-01', street_number: '99' }),
  ]);
  const fs = redevFeatures(events, new Set(['NEW BURB']));
  const ids = (list) => list.map((f) => f.properties.permitNumber).sort();
  const auto = filterRedev(fs, '5', 'auto', TODAY);
  assert.deepEqual(ids(auto), ['G', 'I', 'M']);
  assert.equal(auto.find((f) => f.properties.permitNumber === 'G').properties.faded, 1);
  assert.equal(auto.find((f) => f.properties.permitNumber === 'M').properties.faded, 0, 'multi-family never fades');
  assert.deepEqual(ids(filterRedev(fs, '5', 'hide', TODAY)), ['I', 'M']);
  assert.ok(filterRedev(fs, '5', 'all', TODAY).every((f) => f.properties.faded === 0));
  assert.deepEqual(ids(filterRedev(fs, '10', 'all', TODAY)), ['G', 'I', 'M', 'OLD']);
  assert.equal(fs.find((f) => f.properties.permitNumber === 'G').properties.faded, undefined, 'source untouched');
});

test('summariseRedev counts the ring and the cluster polygons separately', () => {
  const pt = (lon, lat, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { date: '2024-06-01', ...p } });
  const square = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-97.2, 49.85], [-97.1, 49.85], [-97.1, 49.95], [-97.2, 49.95], [-97.2, 49.85]]] } };
  const features = [
    pt(-97.15, 49.884, { category: 'rebuild', unitsCreated: 2, unitsLost: 1 }),   // ring + cluster
    pt(-97.15, 49.884, { category: 'demo', unitsLost: 1 }),
    pt(-97.12, 49.93, { category: 'new-multi', unitsCreated: 40 }),               // cluster only
    pt(-97.12, 49.93, { category: 'new-home', developing: 1, faded: 1, unitsCreated: 1 }),
    pt(-97.3, 49.88, { category: 'new-nonres' }),                                  // neither
  ];
  const { cluster, ring } = summariseRedev(features, { subject: SUBJECT, clusterPolygons: [square] });
  assert.equal(ring.total, 2);
  assert.equal(ring.rebuild, 1);
  assert.equal(ring.demo, 1);
  assert.equal(ring.net, 0);
  assert.equal(cluster.total, 4);
  assert.equal(cluster.newMulti, 1);
  assert.equal(cluster.multiUnits, 40);
  assert.equal(cluster.newHomeDeveloping, 1);
  assert.equal(cluster.net, 41);
  assert.deepEqual(cluster.byYear['2024'], { demo: 1, rebuild: 1, new: 2 });
  const none = summariseRedev(features, {});
  assert.equal(none.cluster, null);
  assert.equal(none.ring, null);
});

test('summary text reads as a report sentence', () => {
  const s = summariseRedev([
    { type: 'Feature', geometry: { type: 'Point', coordinates: SUBJECT }, properties: { category: 'rebuild', date: '2024-01-01' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: SUBJECT }, properties: { category: 'demo', date: '2024-01-01' } },
  ], { subject: SUBJECT });
  const text = redevSummaryText(s, { years: '5', today: TODAY });
  assert.match(text, /^Within 1 km of the subject there were 2 demolitions \(1 rebuilt\)\./);
  assert.match(text, /Source: City of Winnipeg Open Data/);
  const empty = redevSummaryText(summariseRedev([], { subject: SUBJECT, clusterPolygons: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] }),
    { clusterName: 'Fort Rouge', years: '3', today: TODAY });
  assert.match(empty, /^Since November 2023, no new-construction or demolition permits were issued in the Fort Rouge neighbourhood cluster\./);
});

test('popup parts and colour expression', () => {
  const pp = redevPopupParts({ category: 'rebuild', address: '10 Maple St', demoDate: '2023-03-01', date: '2023-09-01', permitNumber: 'N1', demoPermitNumber: 'D1', unitsCreated: 2, unitsLost: 1, neighbourhood: 'RIVER-OSBORNE' });
  assert.equal(pp.heading, 'Teardown rebuild');
  assert.ok(pp.lines.includes('2 units created · 1 lost'));
  assert.ok(pp.lines.includes('River-Osborne'));
  const expr = redevColorExpression();
  for (const c of REDEV_CATEGORIES) assert.ok(expr.includes(c.key) && expr.includes(c.color));
});

test('distanceKm is a haversine', () => {
  const d = distanceKm([-97.15, 49.88], [-97.15, 49.88 + 1 / 111.2]);
  assert.ok(Math.abs(d - 1) < 0.01, String(d));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
