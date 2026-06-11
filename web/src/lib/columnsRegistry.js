// Single source of truth for the results-table columns.
//
// The five "keep in sync" sites the audit flagged (index.html thead order,
// main.js renderTable cell-append order, main.js SORT_KEYS, main.js
// exportCsv, urlState.js SORT_COLS) all derive from this one list:
//
//   - SORT_COLS is built off it directly in urlState.js.
//   - exportCsv reads it to produce the right CSV columns per mode (this
//     is what closes the Sales Analysis CSV-export gap from the audit).
//   - test/columnsRegistry.test.js asserts the thead order, the SORT_KEYS
//     map, and the lib/columns.js PRESETS only reference keys that live
//     here. A misordered thead or a stale SORT_KEYS entry fails CI.
//
// Stage A scope: this registry drives CSV + sort-key validation + the
// thead order guard. The live cell-append loop in renderTable still owns
// the per-cell DOM construction (it composes domain-specific formatters
// and badges that aren't worth the registry indirection right now).
// Adding/removing a column today still requires editing renderTable, but
// the test will now FAIL CI if the new column doesn't also land here +
// in the thead in the same position.

import { assessmentUrl, walkscoreUrl, floodToolUrl } from './links.js';

// `mode` controls which CSV columns are emitted in each export:
//   'always'  always emitted
//   'sales'   emitted only in sales mode (matches the .sales-only thead class)
//
// `sortable: false` opts a column out of SORT_COLS — for the Walkscore /
// Flood link columns where alphabetical-by-address sorting is meaningless.
//
// Each column may declare `csv` as either:
//   csv: { header, extract: (assess, survey) => raw }
// or, when one column unpacks into multiple CSV fields (the Assessment
// column → total + year + URL):
//   csv: [{ header, extract }, ...]
//
// CSV extractors return raw values (not formatted) so spreadsheets keep
// numeric sorting; null/undefined become empty cells in the writer.

export const COLUMNS = [
  // Order MUST match index.html's <th data-col="..."> sequence inside #results.
  { key: 'roll',         header: 'Roll Number',   mode: 'always', sortable: true,
    csv: { header: 'Roll Number',   extract: (a) => a.roll_number } },
  { key: 'address',      header: 'Full Address',  mode: 'always', sortable: true,
    csv: { header: 'Full Address',  extract: (a) => a.full_address } },
  { key: 'saleDate',     header: 'Sale Date',     mode: 'sales',  sortable: true,
    csv: { header: 'Sale Date',     extract: (a) => a._saleDate } },
  { key: 'useCode',      header: 'PUCS',          mode: 'sales',  sortable: true,
    csv: { header: 'PUCS',          extract: (a) => a._saleUseCode } },
  { key: 'livingArea',   header: 'Living Area',   mode: 'sales',  sortable: true,
    csv: { header: 'Living Area',   extract: (a) => a._saleLivingArea } },
  { key: 'yearBuilt',    header: 'Year Built',    mode: 'sales',  sortable: true,
    csv: { header: 'Year Built',    extract: (a) => a._saleYearBuilt } },
  { key: 'area',         header: 'Lot Size (sf)', mode: 'always', sortable: true,
    csv: { header: 'Lot Size (sf)', extract: (a) => a.assessed_land_area } },
  { key: 'propertyType', header: 'Property Type', mode: 'sales',  sortable: true,
    csv: { header: 'Property Type', extract: (a) => a._salePropertyType } },
  { key: 'groupSize',    header: 'Group #',       mode: 'sales',  sortable: true,
    csv: { header: 'Group #',       extract: (a) => a._saleGroupSize } },
  { key: 'salePrice',    header: 'Sale Price',    mode: 'sales',  sortable: true,
    csv: { header: 'Sale Price',    extract: (a) => a._salePrice } },
  { key: 'pricePerSf',   header: '$/Lot SF',      mode: 'sales',  sortable: true,
    csv: { header: '$/Lot SF',      extract: (a) => a._pricePerSf } },
  { key: 'saleToAsmt',   header: 'Sale/Asmt',     mode: 'sales',  sortable: true,
    csv: { header: 'Sale/Asmt %',   extract: (a) => a._saleToAsmt } },
  { key: 'dist',         header: 'Dist (km)',     mode: 'sales',  sortable: true,
    csv: { header: 'Dist (km)',     extract: (a) => a._dist } },
  { key: 'instrument',   header: 'Instrument',    mode: 'sales',  sortable: true,
    csv: { header: 'Instrument',    extract: (a) => a._saleInstrument } },
  { key: 'lot',          header: 'Lot',           mode: 'always', sortable: true,
    csv: { header: 'Lot',           extract: (a, s) => s.lot } },
  { key: 'block',        header: 'Block',         mode: 'always', sortable: true,
    csv: { header: 'Block',         extract: (a, s) => s.block } },
  { key: 'plan',         header: 'Plan',          mode: 'always', sortable: true,
    csv: { header: 'Plan',          extract: (a, s) => s.plan } },
  { key: 'desc',         header: 'Description',   mode: 'always', sortable: true,
    csv: { header: 'Description',   extract: (a, s) => s.description } },
  { key: 'zoning',       header: 'Zoning',        mode: 'always', sortable: true,
    csv: { header: 'Zoning',        extract: (a) => a.zoning_top1 ?? a.zoning ?? '' } },
  { key: 'zoningPct',    header: '%',             mode: 'always', sortable: true,
    csv: { header: 'Zoning %',      extract: (a) => a.zoning_top1_pct } },
  { key: 'zoning2',      header: 'Zoning 2',      mode: 'always', sortable: true,
    csv: [
      { header: 'Zoning 2',   extract: (a) => a.zoning_top2 },
      { header: 'Zoning 2 %', extract: (a) => a.zoning_top2_pct },
    ] },
  { key: 'lat',          header: 'Lat',           mode: 'always', sortable: true,
    csv: { header: 'Lat',           extract: (a) => a.centroid_lat } },
  { key: 'lon',          header: 'Lon',           mode: 'always', sortable: true,
    csv: { header: 'Lon',           extract: (a) => a.centroid_lon } },
  { key: 'value',        header: 'Assessment',    mode: 'always', sortable: true,
    csv: [
      { header: 'Total Assessed Value', extract: (a) => a.total_assessed_value },
      { header: 'Assessment Year',      extract: (a) => a.current_assessment_year },
      { header: 'Assessment URL',       extract: (a) => assessmentUrl(a) },
    ] },
  // walk/flood are link-only columns. They keep sortable: true to preserve
  // the existing UI affordance (click-to-sort never errors), even though
  // SORT_KEYS treats them as alphabetical-by-address placeholders.
  { key: 'walk',         header: 'Walkscore',     mode: 'always', sortable: true,
    csv: { header: 'Walkscore URL', extract: (a) => walkscoreUrl(a.full_address) } },
  { key: 'flood',        header: 'Flood',         mode: 'always', sortable: true,
    csv: { header: 'Flood URL',     extract: (a) => floodToolUrl(a) } },
];

export const COLUMN_KEYS = COLUMNS.map((c) => c.key);

/** Keys that are valid sort targets (drives urlState.js SORT_COLS). */
export const SORTABLE_COLUMN_KEYS = COLUMNS.filter((c) => c.sortable).map((c) => c.key);

/** Columns emitted by exportCsv for a given mode ('property' | 'sales'). */
export function columnsForMode(mode) {
  return COLUMNS.filter((c) => c.mode === 'always' || (mode === 'sales' && c.mode === 'sales'));
}

/**
 * Build the CSV header + row extractors for the given mode. Each entry
 * in `cells` is a function (assess, survey) => raw value. Headers and
 * cells line up 1:1 (a column declaring `csv: [...]` contributes N
 * matching entries to both arrays).
 */
export function csvSchemaForMode(mode) {
  const headers = [];
  const cells = [];
  for (const col of columnsForMode(mode)) {
    const entries = Array.isArray(col.csv) ? col.csv : [col.csv];
    for (const { header, extract } of entries) {
      headers.push(header);
      cells.push(extract);
    }
  }
  return { headers, cells };
}
