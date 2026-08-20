// Unit tests for src/lib/dataStatus.js — the pure helpers behind the
// Data Status dialog. Plain-node runner; run with `npm test` or
// `node test/dataStatus.test.js`.

import assert from 'node:assert/strict';
import {
  monthLabel, datePart, dateLabel, socrataUpdatedDate,
  nextTileRebuildLabel, extractTailMeta, tileAgeDays, publishedRows,
} from '../src/lib/dataStatus.js';

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

console.log('dataStatus');

test('monthLabel — YYYY-MM renders; anything else passes through', () => {
  assert.equal(monthLabel('2026-07'), 'July 2026');
  assert.equal(monthLabel('2026-13'), '2026-13');
  assert.equal(monthLabel('garbage'), 'garbage');
  assert.equal(monthLabel(null), '');
});

test('datePart — the date slice of an ISO timestamp; empty for garbage', () => {
  assert.equal(datePart('2026-08-01T12:00:00Z'), '2026-08-01');
  assert.equal(datePart('2026-08-01'), '2026-08-01');
  assert.equal(datePart('Aug 1'), '');
  assert.equal(datePart(null), '');
});

test('dateLabel — hand-parsed, so the UTC-midnight trap cannot slip a day', () => {
  // new Date('2026-08-01') parses UTC and toLocaleDateString would say
  // Jul 31 in Winnipeg; the whole point of this renderer is Aug 1.
  assert.equal(dateLabel('2026-08-01'), 'Aug 1, 2026');
  assert.equal(dateLabel('2026-01-31T06:00:00Z'), 'Jan 31, 2026');
  assert.equal(dateLabel('unknown'), 'unknown');
});

test('socrataUpdatedDate — rowsUpdatedAt is epoch SECONDS', () => {
  assert.equal(socrataUpdatedDate({ rowsUpdatedAt: 86400 }), '1970-01-02');
  assert.equal(socrataUpdatedDate({ rowsUpdatedAt: 0 }), null);
  assert.equal(socrataUpdatedDate({ rowsUpdatedAt: 'soon' }), null);
  assert.equal(socrataUpdatedDate({}), null);
  assert.equal(socrataUpdatedDate(null), null);
});

test('nextTileRebuildLabel — the 2nd of every even month', () => {
  // Mid-August (even month, past the 2nd) → October.
  assert.equal(nextTileRebuildLabel(new Date(2026, 7, 19)), 'October 2026');
  // Aug 1 — this month's rebuild hasn't run yet.
  assert.equal(nextTileRebuildLabel(new Date(2026, 7, 1)), 'August 2026');
  // Odd month → next month.
  assert.equal(nextTileRebuildLabel(new Date(2026, 8, 15)), 'October 2026');
  // Year wrap: mid-December → February.
  assert.equal(nextTileRebuildLabel(new Date(2026, 11, 15)), 'February 2027');
  assert.equal(nextTileRebuildLabel(new Date(2026, 11, 1)), 'December 2026');
});

test('extractTailMeta — parses the _meta object off a geojson tail', () => {
  const tail = ']]},"properties":{"route_id":"FX4"}}],'
    + '"_meta":{"source":"gtfs","generated_at":"2026-08-06T12:38:02.369Z","route_count":72}}';
  const meta = extractTailMeta(tail);
  assert.equal(meta.generated_at, '2026-08-06T12:38:02.369Z');
  assert.equal(meta.route_count, 72);
});

test('extractTailMeta — truncated or absent _meta returns null, never throws', () => {
  assert.equal(extractTailMeta('"_meta":{"generated_at":"2026-08-06'), null);
  assert.equal(extractTailMeta('{"type":"FeatureCollection"}'), null);
  assert.equal(extractTailMeta(''), null);
  assert.equal(extractTailMeta(null), null);
});

test('tileAgeDays — whole days from the build date; null for garbage', () => {
  assert.equal(tileAgeDays('2026-08-05', new Date(Date.UTC(2026, 7, 19))), 14);
  assert.equal(tileAgeDays('2026-08-05', new Date(Date.UTC(2026, 7, 5, 12))), 0);
  assert.equal(tileAgeDays('not-a-date'), null);
  assert.equal(tileAgeDays(undefined), null);
});

test('publishedRows — a failed fetch yields a row with a null vintage, not a crash', () => {
  const rows = publishedRows({ pmtilesMeta: null, neighbourhoodsMeta: null, transitMeta: null });
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.vintage, null);
    assert.equal(typeof r.label, 'string');
  }
});

test('publishedRows — the tile row carries build date, counts, and next rebuild', () => {
  const rows = publishedRows({
    pmtilesMeta: { built: '2026-08-05', features_tiled: 217071, source_live_count: 245248 },
    neighbourhoodsMeta: { generated_at: '2026-08-06T12:38:02.839Z', neighbourhood_count: 235 },
    transitMeta: { generated_at: '2026-08-06T12:38:02.369Z', route_count: 72 },
    now: new Date(2026, 7, 19),
  });
  const [tiles, hoods, transit] = rows;
  assert.equal(tiles.vintage, 'Aug 5, 2026');
  assert.match(tiles.detail, /217,071/);
  assert.match(tiles.detail, /245,248/);
  assert.equal(tiles.next, 'October 2026');
  assert.equal(hoods.vintage, 'Aug 6, 2026');
  assert.match(hoods.detail, /235 neighbourhoods/);
  assert.match(transit.detail, /72 routes/);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
