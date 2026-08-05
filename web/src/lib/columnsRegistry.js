// Single source of truth for the results-table columns.
//
// Stage B of the column-registry refactor (audit M3.3 follow-up): adds the
// per-column `render(a, s) => Node` so main.js's renderTable can build cells
// declaratively, AND `buildThead()` so index.html ships an empty <thead> that
// main.js populates from the registry at init time. With both, drift between
// thead/renderTable/SORT_KEYS/exportCsv/SORT_COLS is structurally impossible:
// adding a column is now ONE edit here.
//
// Test surface unchanged: test/columnsRegistry.test.js still validates
// SORT_KEYS coverage, PRESETS reference, csvSchemaForMode behaviour, and
// gains a guard that every entry carries a callable render function.
//
// DOM-coupling lives in lib/cells.js — its functions only touch `document`
// inside their bodies, so this file remains importable in plain Node.

import { formatSqFt } from './format.js';
import { assessmentUrl, walkscoreUrl, floodToolUrl } from './links.js';
import {
  td, badgeTd, truncatedTd, linkTd, assessmentTd,
  formatDollars, formatPct, formatZone2, formatCoord, formatDist,
  stripZoningCode, propertyTypeBadgeClass,
} from './cells.js';
import {
  waterOf, waterLoaded, waterColor, waterCellText, waterTooltip, waterCsvCells,
} from './water.js';

/**
 * Water cell: a colour dot plus the water body, with the full verdict
 * in the tooltip.
 *
 * A parcel with no water reads as the ordinary empty dash rather than
 * "No water noted" — 97% of the roll has no water influence, and a
 * default-visible column repeating that on every row is noise. The
 * grid therefore never asserts absence, which is the safe direction:
 * it cannot claim a check it didn't run. The checked-and-none vs
 * never-checked distinction is preserved where it can actually be
 * used — the CSV export, which pivots on it.
 */
function waterTd(a) {
  const w = waterOf(a);
  if (!w) return td(null);
  const cell = document.createElement('td');
  cell.title = waterTooltip(w);
  const dot = document.createElement('span');
  dot.className = 'water-dot';
  dot.style.background = waterColor(w);
  cell.appendChild(dot);
  cell.appendChild(document.createTextNode(waterCellText(w)));
  return cell;
}

/** Floor area: the sales CSV's value when present, else the live record. */
function livingAreaOf(a) {
  const sale = Number(a?._saleLivingArea);
  if (Number.isFinite(sale) && sale > 0) return sale;
  const live = Number(a?.total_living_area);
  return Number.isFinite(live) && live > 0 ? live : null;
}

/** Year built: same dual source. */
function yearBuiltOf(a) {
  return a?._saleYearBuilt || a?.year_built || null;
}

// Per-column entry:
//   key          stable identifier (data-col attribute, sort key, URL param)
//   header       <th> text content
//   mode         'always' | 'sales' (drives the .sales-only thead class)
//   sortable     true → entry contributes to SORTABLE_COLUMN_KEYS
//   theadClass   optional extra class string for the <th>
//                (e.g. 'subj-col' for the sales-mode Dist column)
//   theadTitle   optional hover tooltip on the <th>
//   theadId      optional id attribute (only used by 'value' so renderTable
//                can rewrite the header to "Assess-<year>" dynamically)
//   render       (a, s) => Node — builds the <td> for one row
//                  a = row.assess?.properties || {}
//                  s = row.survey?.properties || {}
//                Must touch `document` only via lib/cells helpers so the
//                Node test can structurally import without a DOM.
//   csv          { header, extract } or [{header,extract},…] — same
//                contract as Stage A, drives exportCsv per mode.

export const COLUMNS = [
  // Order is authoritative: drives <thead> emission, renderTable cell order,
  // CSV column order, and SORT_COLS list order.

  { key: 'roll',         header: 'Roll Number',   mode: 'always', sortable: true,
    render: (a) => linkTd(assessmentUrl(a), a.roll_number),
    csv: { header: 'Roll Number', extract: (a) => a.roll_number } },

  { key: 'address',      header: 'Full Address',  mode: 'always', sortable: true,
    render: (a) => truncatedTd(a.full_address, 40),
    csv: { header: 'Full Address', extract: (a) => a.full_address } },

  { key: 'saleDate',     header: 'Sale Date',     mode: 'sales',  sortable: true,
    theadTitle: 'Sale date from the uploaded CSV',
    render: (a) => td(a._saleDate || null),
    csv: { header: 'Sale Date', extract: (a) => a._saleDate } },

  { key: 'useCode',      header: 'PUCS',          mode: 'sales',  sortable: true,
    theadTitle: 'Par Use Code — Winnipeg property assessment use code (e.g. RESMC, RESRH, INWWH, CMRRE)',
    render: (a) => badgeTd(a._saleUseCode || null, 'badge-pucs'),
    csv: { header: 'PUCS', extract: (a) => a._saleUseCode } },

  // Living Area and Year Built are dual-source: the sales CSV value when
  // there is one, otherwise the live assessment record. That makes them
  // usable in a plain property search (where no CSV exists) without a
  // second near-identical pair of columns.
  { key: 'livingArea',   header: 'Living Area',   mode: 'always', sortable: true,
    theadTitle: 'Building floor area in square feet — from the sales CSV when loaded, otherwise the assessment record',
    render: (a) => td(formatSqFt(livingAreaOf(a)), 'num'),
    csv: { header: 'Living Area', extract: (a) => livingAreaOf(a) } },

  { key: 'yearBuilt',    header: 'Year Built',    mode: 'always', sortable: true,
    theadTitle: "Year built — from the sales CSV when loaded (oldest across the parcel's building components), otherwise the assessment record",
    render: (a) => td(yearBuiltOf(a)),
    csv: { header: 'Year Built', extract: (a) => yearBuiltOf(a) } },

  { key: 'buildingType', header: 'Building',      mode: 'always', sortable: true,
    theadTitle: 'Building type from the assessment record (ONE STOREY, TWO STOREY, BUNGALOW…)',
    render: (a) => truncatedTd(a.building_type, 18),
    csv: { header: 'Building Type', extract: (a) => a.building_type } },

  { key: 'rooms',        header: 'Rooms',         mode: 'always', sortable: true,
    theadTitle: 'Room count from the assessment record',
    render: (a) => td(a.rooms != null ? String(a.rooms) : null, 'num'),
    csv: { header: 'Rooms', extract: (a) => a.rooms } },

  { key: 'dwellingUnits', header: 'DU',           mode: 'always', sortable: true,
    theadTitle: 'Dwelling units on the parcel (assessment record). 0 = vacant lot.',
    render: (a) => td(a.dwelling_units != null ? String(a.dwelling_units) : null, 'num'),
    csv: { header: 'Dwelling Units', extract: (a) => a.dwelling_units } },

  { key: 'area',         header: 'Lot Size (sf)', mode: 'always', sortable: true,
    render: (a) => td(formatSqFt(a.assessed_land_area), 'num'),
    csv: { header: 'Lot Size (sf)', extract: (a) => a.assessed_land_area } },

  { key: 'propertyType', header: 'Property Type', mode: 'sales',  sortable: true,
    theadTitle: 'High-level property type from the CSV (Residential / Industrial / Commercial)',
    render: (a) => badgeTd(a._salePropertyType || null, propertyTypeBadgeClass(a._salePropertyType)),
    csv: { header: 'Property Type', extract: (a) => a._salePropertyType } },

  { key: 'groupSize',    header: 'Group #',       mode: 'sales',  sortable: true,
    theadTitle: 'Number of parcels in the same sale (1 = single-parcel sale). Multi-parcel sales aggregate $/Lot SF and Sale/Asmt across the group.',
    render: (a) => td(a._saleGroupSize != null ? String(a._saleGroupSize) : null, 'num'),
    csv: { header: 'Group #', extract: (a) => a._saleGroupSize } },

  { key: 'salePrice',    header: 'Sale Price',    mode: 'sales',  sortable: true,
    theadTitle: 'Sold price from the uploaded CSV',
    render: (a) => td(formatDollars(a._salePrice), 'num'),
    csv: { header: 'Sale Price', extract: (a) => a._salePrice } },

  { key: 'swornValue',   header: 'Sworn',         mode: 'sales',  sortable: true,
    theadTitle: 'Sworn (declared land-transfer) value, shown only when it differs from the Sale Price — a $1 sale price with a large sworn value marks a non-arms-length transfer. Never substituted into Sale Price.',
    render: (a) => td(formatDollars(a._saleSwornValue), 'num'),
    csv: { header: 'Sworn Value', extract: (a) => a._saleSwornValue } },

  { key: 'numUnits',     header: 'Units',         mode: 'sales',  sortable: true,
    theadTitle: 'Number of units on the parcel (max of Number of Unit across the sale’s component rows)',
    render: (a) => td(a._saleNumUnits != null ? String(a._saleNumUnits) : null, 'num'),
    csv: { header: 'Units', extract: (a) => a._saleNumUnits } },

  { key: 'cluster',      header: 'Cluster',       mode: 'sales',  sortable: true,
    theadTitle: 'City neighbourhood cluster containing the parcel centroid (23 clusters over 235 neighbourhoods). Derived geometrically, not from the truncated neighbourhood_area field.',
    render: (a) => truncatedTd(a._cluster, 22),
    csv: { header: 'Cluster', extract: (a) => a._cluster } },

  { key: 'saleZoning',   header: 'Zoning (sale)', mode: 'sales',  sortable: true,
    theadTitle: 'Zoning as recorded on the sale record, which can differ from the parcel’s current zoning',
    render: (a) => td(a._saleZoning || null),
    csv: { header: 'Zoning (sale)', extract: (a) => a._saleZoning } },

  { key: 'pricePerSf',   header: '$/Lot SF',      mode: 'sales',  sortable: true,
    theadTitle: 'Sale price ÷ Land Actual sqft. For multi-parcel sales, divides by the group total land.',
    render: (a) => td(formatDollars(a._pricePerSf), 'num'),
    csv: { header: '$/Lot SF', extract: (a) => a._pricePerSf } },

  { key: 'saleToAsmt',   header: 'Sale/Asmt',     mode: 'sales',  sortable: true,
    theadTitle: 'Sale price ÷ total assessed value (latest year)',
    render: (a) => td(formatPct(a._saleToAsmt), 'num'),
    csv: { header: 'Sale/Asmt %', extract: (a) => a._saleToAsmt } },

  { key: 'dist',         header: 'Dist (km)',     mode: 'sales',  sortable: true,
    theadClass: 'subj-col',
    theadTitle: 'Centroid-to-centroid distance from the subject parcel (km). Set a subject roll in the Sales Analysis tab to populate.',
    render: (a) => td(formatDist(a._dist), 'num'),
    csv: { header: 'Dist (km)', extract: (a) => a._dist } },

  { key: 'instrument',   header: 'Instrument',    mode: 'sales',  sortable: true,
    theadTitle: 'Land Titles instrument number for the transaction',
    render: (a) => td(a._saleInstrument || null),
    csv: { header: 'Instrument', extract: (a) => a._saleInstrument } },

  { key: 'lot',          header: 'Lot',           mode: 'always', sortable: true,
    render: (_a, s) => truncatedTd(s.lot, 10),
    csv: { header: 'Lot', extract: (_a, s) => s.lot } },

  { key: 'block',        header: 'Block',         mode: 'always', sortable: true,
    render: (_a, s) => td(s.block),
    csv: { header: 'Block', extract: (_a, s) => s.block } },

  { key: 'plan',         header: 'Plan',          mode: 'always', sortable: true,
    render: (_a, s) => td(s.plan),
    csv: { header: 'Plan', extract: (_a, s) => s.plan } },

  { key: 'desc',         header: 'Description',   mode: 'always', sortable: true,
    render: (_a, s) => td(s.description),
    csv: { header: 'Description', extract: (_a, s) => s.description } },

  { key: 'zoning',       header: 'Zoning',        mode: 'always', sortable: true,
    theadTitle: 'Top zoning code by area-weighted polygon intersection',
    render: (a) => badgeTd(stripZoningCode(a.zoning_top1 ?? a.zoning), 'badge-zoning'),
    csv: { header: 'Zoning', extract: (a) => a.zoning_top1 ?? a.zoning ?? '' } },

  { key: 'zoningPct',    header: '%',             mode: 'always', sortable: true,
    theadTitle: 'Coverage % of the top zoning district',
    render: (a) => td(formatPct(a.zoning_top1_pct), 'num'),
    csv: { header: 'Zoning %', extract: (a) => a.zoning_top1_pct } },

  { key: 'zoning2',      header: 'Zoning 2',      mode: 'always', sortable: true,
    theadTitle: 'Second-most-coverage zoning district (when ≥1%)',
    render: (a) => td(formatZone2(a.zoning_top2, a.zoning_top2_pct)),
    csv: [
      { header: 'Zoning 2',   extract: (a) => a.zoning_top2 },
      { header: 'Zoning 2 %', extract: (a) => a.zoning_top2_pct },
    ] },

  // Water influence, straight off the City's own property_influences
  // field. Three states — a classified verdict, an explicit "no water
  // noted" once we've actually looked, and blank when we haven't — so
  // the cell never claims a check it didn't run. See lib/water.js.
  { key: 'water',        header: 'Water',         mode: 'always', sortable: true,
    theadTitle: 'Water influence from the City assessment record. Dark = adjacent (frontage), pale = near water without frontage. An assessor\'s classification, not a measured distance.',
    render: (a) => waterTd(a),
    csv: [
      { header: 'Water',       extract: (a) => waterCsvCells(waterOf(a), waterLoaded(a))[0] },
      { header: 'Water Class', extract: (a) => waterCsvCells(waterOf(a), waterLoaded(a))[1] },
      { header: 'Water Body',  extract: (a) => waterCsvCells(waterOf(a), waterLoaded(a))[2] },
      { header: 'Water Type',  extract: (a) => waterCsvCells(waterOf(a), waterLoaded(a))[3] },
    ] },

  { key: 'value',        header: 'Assessment',    mode: 'always', sortable: true,
    theadId: 'value-header',
    theadTitle: "Click any value to open the parcel's record on winnipegassessment.com",
    render: (a) => assessmentTd(a),
    csv: [
      { header: 'Total Assessed Value', extract: (a) => a.total_assessed_value },
      { header: 'Assessment Year',      extract: (a) => a.current_assessment_year },
      { header: 'Assessment URL',       extract: (a) => assessmentUrl(a) },
    ] },

  // walk/flood are link-only columns. They keep sortable: true to preserve
  // the existing UI affordance (click-to-sort never errors), even though
  // SORT_KEYS treats them as alphabetical-by-address placeholders.
  { key: 'walk',         header: 'Walkscore',     mode: 'always', sortable: true,
    theadTitle: 'Open this address on walkscore.com',
    render: (a) => linkTd(walkscoreUrl(a.full_address), 'Walk'),
    csv: { header: 'Walkscore URL', extract: (a) => walkscoreUrl(a.full_address) } },

  { key: 'flood',        header: 'Flood',         mode: 'always', sortable: true,
    theadTitle: 'Run this parcel through the Manitoba flood-screening tool',
    render: (a) => linkTd(floodToolUrl(a), 'Flood'),
    csv: { header: 'Flood URL', extract: (a) => floodToolUrl(a) } },
  { key: 'lat',          header: 'Lat',           mode: 'always', sortable: true,
    render: (a) => td(formatCoord(a.centroid_lat), 'num'),
    csv: { header: 'Lat', extract: (a) => a.centroid_lat } },

  { key: 'lon',          header: 'Lon',           mode: 'always', sortable: true,
    render: (a) => td(formatCoord(a.centroid_lon), 'num'),
    csv: { header: 'Lon', extract: (a) => a.centroid_lon } },
];

export const COLUMN_KEYS = COLUMNS.map((c) => c.key);

/** Keys that are valid sort targets (drives urlState.js SORT_COLS). */
export const SORTABLE_COLUMN_KEYS = COLUMNS.filter((c) => c.sortable).map((c) => c.key);

/** Columns emitted by exportCsv for a given mode ('property' | 'sales'). */
export function columnsForMode(mode) {
  return COLUMNS.filter((c) => c.mode === 'always' || (mode === 'sales' && c.mode === 'sales'));
}

/**
 * Build the CSV header + row extractors for the given mode. Each entry in
 * `cells` is (assess, survey) => raw value. Headers and cells line up 1:1
 * (a column declaring `csv: [...]` contributes N matching entries to both).
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

/**
 * Populate the supplied (empty) <thead><tr> element from the registry.
 * Idempotent — clears existing children first, so a later schema change
 * (re-import / HMR) replaces the row cleanly. Called once at main.js init.
 *
 * Class composition: every column carries `data-col` (column key) plus
 *  - 'sales-only'  when mode === 'sales'  (body.sales-mode CSS rule shows them)
 *  - any extras declared in theadClass     ('subj-col' on Dist)
 * Pass-throughs: theadTitle → title attr; theadId → id attr.
 */
/**
 * The conditional classes a column's cells carry — 'sales-only' for
 * sales-mode columns, plus any `theadClass` extra ('subj-col' on Dist).
 *
 * BOTH the <th> and the <td> must get these, which is the whole reason
 * this is a shared function. The CSS rules behind them
 * (`body:not(.sales-mode) .sales-only`, `body:not(.subject-set)
 * .subj-col`) are `display: none`, so applying them to only one of the
 * two makes that column's header and its cells disagree about how many
 * boxes exist — and every column after it renders one place off from
 * its heading. That shipped: with a sales CSV loaded and no subject
 * roll set, Dist's header was hidden while its cells were not, so the
 * Instrument value appeared under the Lot heading, zoning under %, and
 * so on down the row.
 *
 * Note this is invisible to applyVisibility() in lib/columns.js, which
 * toggles `col-hidden` on the th and td at the same CHILD index and so
 * stays aligned regardless — the bug only bites for a column that
 * applyVisibility considers visible while a CSS class hides its header.
 */
export function columnCellClasses(col) {
  const classes = [];
  if (col.mode === 'sales') classes.push('sales-only');
  if (col.theadClass)       classes.push(col.theadClass);
  return classes;
}

export function buildThead(tr) {
  if (!tr) return;
  while (tr.firstChild) tr.removeChild(tr.firstChild);
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.dataset.col = col.key;
    const classes = columnCellClasses(col);
    if (classes.length)       th.className = classes.join(' ');
    if (col.theadTitle)       th.title = col.theadTitle;
    if (col.theadId)          th.id    = col.theadId;
    th.textContent = col.header;
    tr.appendChild(th);
  }
}
