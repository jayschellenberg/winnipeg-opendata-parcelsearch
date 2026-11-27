// A Winnipeg roll's total assessed value across the wpg-parcel-history
// snapshots plus today's value, for the preliminary report. Pure; tested in
// test/snapshotValues.test.js.
//
// The snapshots carry one total per roll and no assessment year, so rows are
// labelled by snapshot date. The 2023 snapshot wrote values as text with
// thousands separators and decimals ("22,422,000.00"); later ones as plain
// integers. Assessed values only: the City publishes no tax amounts here.

/** "22,422,000.00" | "20363000" | 21605000 -> number, else null. */
export function parseValue(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * rows: [{label, date, total}] oldest first, from snapshot properties keyed
 * by snapshot date plus the current record. Consecutive equal values are
 * kept (they show the value held), each later row gets `pct` vs the prior.
 */
export function snapshotRows(bySnapshot, current) {
  const rows = Object.entries(bySnapshot || {})
    .map(([date, props]) => ({ label: `Snapshot ${date}`, date, total: parseValue(props?.total_assessed_value) }))
    .filter((r) => r.total != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (current && parseValue(current.total) != null) {
    rows.push({ label: `Current (${current.year ?? 'today'} roll)`, date: 'current', total: parseValue(current.total) });
  }
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].total;
    rows[i].pct = a > 0 ? (100 * (rows[i].total - a)) / a : null;
  }
  return rows;
}

/** History shard file name for a neighbourhood (mirrors lib/historicalSlug.js). */
export { historicalSlugify as neighbourhoodSlug } from './historicalSlug.js';
