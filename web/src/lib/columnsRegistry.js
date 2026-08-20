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

import { formatSqFt, formatAcres } from './format.js';
import { assessmentUrl, walkscoreUrl, floodToolUrl } from './links.js';
import {
  td, badgeTd, truncatedTd, linkTd, assessmentTd,
  formatDollars, formatPct, formatZone2, formatCoord, formatDist,
  stripZoningCode, propertyTypeBadgeClass, pucsBadgeClass,
} from './cells.js';
import {
  waterOf, waterLoaded, waterColor, waterCellText, waterTooltip, waterCsvCells,
} from './water.js';
import { pucsName } from './pucs.js';

/**
 * New-construction verdict on a vacant-coded sale.
 *
 * "Already built" is the finding — a sale the roll calls land that in
 * fact carried a finished house — so it takes the alarm styling. The
 * land-then-built case agrees with the use code and stays quiet, but is
 * still shown, because knowing a lot WAS verified as bare at sale is
 * worth as much to a land comp set as knowing it wasn't.
 */
function builtTd(a) {
  const verdict = a._buildVerdict;
  if (!verdict) return td(null);
  const cell = verdict === 'already-built'
    ? td('⚠ Already built', 'demo-teardown')
    : td('land → built', 'demo-confirms');
  if (a._buildTitle) cell.title = a._buildTitle;
  return cell;
}

/**
 * Demolition-permit verdict.
 *
 * A teardown is the finding worth interrupting for — an improved-coded
 * sale that was really a land deal — so it gets the emphasis and the
 * "before"/"after" detail. The confirms-vacant case is real evidence
 * too, but it only agrees with what the use code already said, so it
 * stays quiet and does not compete for attention.
 */
function demoTd(a) {
  const verdict = a._demoVerdict;
  if (!verdict) return td(null);
  const side = a._demoSide === 'before' ? 'before' : 'after';
  const cell = verdict === 'teardown'
    ? td(`⚠ Teardown (${side})`, 'demo-teardown')
    : td(`confirms vacant (${side})`, 'demo-confirms');
  if (a._demoTitle) cell.title = a._demoTitle;
  return cell;
}

/**
 * $/Lot SF, with a ⚠ span appended when the sale is far-flung — its own
 * parcels lie farther apart than the threshold, so the blended rate is
 * not a local comparable. The badge only appears while the Far-Flung
 * threshold is set; marking never removes anything on its own.
 */
function farFlungTd(a) {
  const cell = td(formatDollars(a._pricePerSf), 'num');
  if (!a._farFlung) return cell;
  const span = Number(a._saleGroupSpanKm);
  const badge = document.createElement('span');
  badge.className = 'far-flung-badge';
  badge.textContent = Number.isFinite(span) ? ` ⚠ ${Math.round(span)} km` : ' ⚠';
  badge.title = Number.isFinite(span)
    ? `Far-flung sale: this transaction's parcels span ${Math.round(span)} km, so the blended $/Lot SF is not a local comparable.`
    : "Far-flung sale: this transaction's parcels are widely separated.";
  cell.appendChild(badge);
  cell.classList.remove('empty');
  return cell;
}

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

/**
 * The map badge number. Read from whichever side of the row carries it:
 * main.js stamps `_seq` on the assessment feature when there is one and
 * the survey feature otherwise, so a legal-description search (which can
 * return a survey lot with no assessment match) still numbers.
 */
function seqOf(a, s) {
  const v = a?._seq ?? s?._seq;
  return v != null ? String(v) : null;
}

/**
 * Cell classes for the Sale Price / Sworn pair. When the two figures
 * disagree the Sold Price is not what the property changed hands for —
 * SABRE writes a nominal amount on a non-arms-length transfer and puts
 * the real figure in Sworn Value — so both cells are tinted together.
 * Tinting only one would leave it ambiguous which number is the odd one.
 */
function swornCellClass(a) {
  return a?._saleSwornMismatch ? 'num sworn-mismatch' : 'num';
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

  // The map badge number. First column so it reads as a row label rather
  // than a data field. Unlike every other column its visibility is NOT
  // governed by the column presets — `seq-col` is a display:none CSS rule
  // keyed off body.numbering-on, so the "Number parcels" toggle is the
  // single switch for both the badges and this column. `seq` is still
  // listed in every preset (lib/columns.js) so a preset can't fight the
  // toggle by marking it col-hidden underneath.
  { key: 'seq',          header: '#',             mode: 'always', sortable: true,
    theadClass: 'seq-col',
    theadTitle: 'Map number. Parcels are numbered 1..N by roll number; a multi-parcel sale and a repeat sale of the same parcel each carry ONE number. Turn on with "Number parcels" above the table.',
    render: (a, s) => td(seqOf(a, s), 'num'),
    csv: { header: '#', extract: (a, s) => seqOf(a, s) } },

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

  // PUCS. The code is what SABRE gives us and what fits a badge, but
  // "RESMC" reads as nothing on its own, so the plain name rides on the
  // tooltip and goes out in its own CSV column. Names come from the
  // City's own published labels — see lib/pucs.js.
  { key: 'useCode',      header: 'PUCS',          mode: 'sales',  sortable: true,
    theadTitle: 'Par Use Code — Winnipeg property assessment use code (e.g. RESMC, RESRH, INWWH, CMRRE). '
      + 'Hover a cell for the code’s plain name; see Category for the grouping it rolls up into.',
    render: (a) => {
      const cell = badgeTd(a._saleUseCode || null, pucsBadgeClass(a._salePropertyType));
      const name = pucsName(a._saleUseCode);
      if (name) cell.title = `${String(a._saleUseCode).toUpperCase()} — ${name}`;
      return cell;
    },
    csv: { header: 'PUCS', extract: (a) => a._saleUseCode } },

  { key: 'useCodeName',  header: 'Use',           mode: 'sales',  sortable: true,
    theadTitle: 'What the Par Use Code means, in words — “Detached Single Dwelling”, “Multifamily Conversion”, '
      + '“Vehicle Service Related”. Taken from the City’s own published label for the code.',
    render: (a) => td(pucsName(a._saleUseCode) || null),
    csv: { header: 'Use', extract: (a) => pucsName(a._saleUseCode) } },

  // Category. The grouping a comp search runs on, and the one column here
  // the roll alone cannot produce: a vacant-coded sale that already had a
  // finished house on it reads Residential, not Land, because the permit
  // record says so. See saleCategory in lib/pucs.js.
  { key: 'category',     header: 'Category',      mode: 'sales',  sortable: true,
    theadTitle: 'Appraisal category, derived from the Par Use Code and then corrected by the permit record: '
      + 'a vacant-coded sale whose building was finished 6+ months before it sold takes the category of what actually stood there, '
      + 'and an improved sale with a demolition permit beside it becomes Land. '
      + 'Surface parking counts as Land; condos group by underlying use rather than by tenure. '
      + '“(unclassified)” means a use code this app has not been taught — not that the sale is unusable.',
    render: (a) => badgeTd(a._saleCategory || null, 'badge-category'),
    csv: { header: 'Category', extract: (a) => a._saleCategory } },

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
    render: (a) => td(formatDollars(a._salePrice), swornCellClass(a)),
    csv: { header: 'Sale Price', extract: (a) => a._salePrice } },

  { key: 'swornValue',   header: 'Sworn',         mode: 'sales',  sortable: true,
    theadTitle: 'Sworn (declared land-transfer) value from the CSV. Normally equals the Sale Price; where it does not — a $1 sale price against a large sworn value — the transfer is non-arms-length. Never substituted into Sale Price.',
    render: (a) => td(formatDollars(a._saleSwornValue), swornCellClass(a)),
    csv: { header: 'Sworn Value', extract: (a) => a._saleSwornValue } },

  // Units. HOW MANY suite labels the sale carries, not the largest one.
  // Reading the largest as a total reported unit 103 of 255 PEGUIS as a
  // 103-unit property and topped out at 4,201; counting them is right on
  // 80% against the City's own dwelling_units, and right again on most of
  // the rest, where the roll has since been demolished to 0 and SABRE
  // holds the historical answer. See unitLabelsOf in lib/sales.js.
  { key: 'numUnits',     header: 'Units',         mode: 'sales',  sortable: true,
    theadTitle: 'How many units the sale covers — counted from the distinct "Number of Unit" labels on its component rows, '
      + 'so six rows labelled 1..6 is a six-unit sale and a single row labelled 103 is one unit. '
      + 'From the SALE, not the roll, so it still reads correctly on a building since demolished. '
      + 'Blank where SABRE labelled no unit; see DU for what the assessment record says the parcel holds today.',
    render: (a) => {
      const cell = td(a._saleNumUnits != null ? String(a._saleNumUnits) : null, 'num');
      if (a._saleUnitLabel) cell.title = `SABRE labels the unit(s) sold: ${a._saleUnitLabel}`;
      return cell;
    },
    csv: { header: 'Units', extract: (a) => a._saleNumUnits } },

  { key: 'unitLabel',    header: 'Unit #',        mode: 'sales',  sortable: true,
    theadTitle: 'The unit that sold, as SABRE labels it — "504B", "G-H", "103". A suite identifier, not a count; '
      + 'see Units for how many dwelling units are on the parcel. Blank on a sale SABRE did not label.',
    render: (a) => td(a._saleUnitLabel || null),
    csv: { header: 'Unit #', extract: (a) => a._saleUnitLabel } },

  { key: 'demo',         header: 'Demo',          mode: 'sales',  sortable: true,
    theadTitle: 'Demolition permit within two years either side of the sale (City Building Permits, matched by address). '
      + 'TEARDOWN means the use code says there was a building — the price bought the lot and a demolition bill, so treat it as a LAND sale, not an improved comp. '
      + 'Confirms on an already-vacant sale is only corroboration. Blank means no permit found, which is not proof there was none.',
    render: (a) => demoTd(a),
    csv: { header: 'Demo', extract: (a) => (a._demoVerdict === 'teardown' ? 'TEARDOWN' : a._demoVerdict === 'confirms-vacant' ? 'confirms vacant' : '') } },

  { key: 'demoDate',     header: 'Demo Date',     mode: 'sales',  sortable: true,
    theadTitle: 'Issue date of the demolition permit nearest this sale, within two years either side.',
    render: (a) => td(a._demoDate || null, 'num'),
    csv: { header: 'Demo Date', extract: (a) => a._demoDate } },

  { key: 'source',       header: 'Source',        mode: 'sales',  sortable: true,
    theadTitle: 'Which export this sale came from. SABRE+MLS means both reported it and the merge fused them into one row — SABRE’s registration date, plus everything MLS knows that SABRE has no column for.',
    render: (a) => td(a._source || null),
    csv: { header: 'Source', extract: (a) => a._source } },

  { key: 'mlsDate',      header: 'MLS Date',      mode: 'sales',  sortable: true,
    theadTitle: 'MLS DateSold — the firm/accepted-offer date. Deliberately kept beside the Sale Date rather than replacing it: SABRE records REGISTRATION, and across this archive the offer runs three to eight weeks earlier. The offer date is the market signal; the registration date is the transaction.',
    render: (a) => td(a._mlsDate || null, 'num'),
    csv: { header: 'MLS Date', extract: (a) => a._mlsDate } },

  { key: 'mlsNumber',    header: 'MLS #',         mode: 'sales',  sortable: true,
    theadTitle: 'MLS listing number',
    render: (a) => td(a._mlsNumber || null, 'num'),
    csv: { header: 'MLS #', extract: (a) => a._mlsNumber } },

  { key: 'listPrice',    header: 'List Price',    mode: 'sales',  sortable: true,
    theadTitle: 'Asking price at the time of sale (MLS PriceList). Against the sold price this is the negotiation room.',
    render: (a) => td(formatDollars(a._listPrice), 'num'),
    csv: { header: 'List Price', extract: (a) => a._listPrice } },

  { key: 'origPrice',    header: 'Orig Price',    mode: 'sales',  sortable: true,
    theadTitle: 'Original asking price when first listed (MLS PriceOrig). Where it exceeds List Price the property was reduced before it sold.',
    render: (a) => td(formatDollars(a._origPrice), 'num'),
    csv: { header: 'Orig Price', extract: (a) => a._origPrice } },

  { key: 'dom',          header: 'DOM',           mode: 'sales',  sortable: true,
    theadTitle: 'Days on market (MLS). Direct evidence of exposure period, which an appraisal report normally has to state.',
    render: (a) => td(a._dom != null ? String(a._dom) : null, 'num'),
    csv: { header: 'DOM', extract: (a) => a._dom } },

  { key: 'bldgType',     header: 'Bldg Type',     mode: 'sales',  sortable: true,
    theadTitle: 'Building type as described on the listing (MLS BldgType)',
    render: (a) => truncatedTd(a._bldgType, 20),
    csv: { header: 'Bldg Type', extract: (a) => a._bldgType } },

  { key: 'style',        header: 'Style',         mode: 'sales',  sortable: true,
    theadTitle: 'Building style as described on the listing (MLS Style)',
    render: (a) => truncatedTd(a._style, 16),
    csv: { header: 'Style', extract: (a) => a._style } },

  { key: 'siteInfl',     header: 'Site Infl.',    mode: 'sales',  sortable: true,
    theadTitle: 'Site influences from the listing — corner, high traffic, street exposure and so on. Qualitative comparability factors SABRE does not record.',
    render: (a) => truncatedTd(a._siteInfl, 24),
    csv: { header: 'Site Influences', extract: (a) => a._siteInfl } },

  { key: 'built',        header: 'Built',         mode: 'sales',  sortable: true,
    theadTitle: 'New-construction permit against a VACANT-coded sale (City Building Permits, matched by address). '
      + 'ALREADY BUILT means the permit predates the sale by six months or more, so the house was finished when the lot changed hands — the sale is an IMPROVED sale the roll had not caught up with, and its rate is not a land rate. '
      + 'Land → built means construction started at or after the sale, which confirms the sale itself bought bare land. Improved-coded sales are not judged here: every house has a build permit.',
    render: (a) => builtTd(a),
    csv: { header: 'Built', extract: (a) => (a._buildVerdict === 'already-built' ? 'ALREADY BUILT' : a._buildVerdict === 'land-then-built' ? 'land then built' : '') } },

  { key: 'builtDate',    header: 'Built Date',    mode: 'sales',  sortable: true,
    theadTitle: 'Issue date of the new-construction permit nearest this sale.',
    render: (a) => td(a._buildDate || null, 'num'),
    csv: { header: 'Built Date', extract: (a) => a._buildDate } },

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
    // The far-flung warning rides on THIS cell rather than a group-size
    // column, because the blended rate is the figure a scattered
    // portfolio sale invalidates — and it is the number an appraiser
    // would otherwise lift straight into a comp set.
    render: (a) => farFlungTd(a),
    csv: { header: '$/Lot SF', extract: (a) => a._pricePerSf } },

  { key: 'pricePerBldgSf', header: '$/Bldg SF',   mode: 'sales',  sortable: true,
    theadTitle: 'Sale price ÷ building area (Living Area from the export, else the live record). For multi-parcel sales, divides by the group total. Blank on vacant land, which has no building to rate.',
    render: (a) => td(formatDollars(a._pricePerBldgSf), 'num'),
    csv: { header: '$/Bldg SF', extract: (a) => a._pricePerBldgSf } },

  { key: 'saleAcres',    header: 'Acres',         mode: 'sales',  sortable: true,
    theadTitle: 'Land area in acres, derived from Land Actual sqft (÷ 43,560). For multi-parcel sales, the group total.',
    render: (a) => td(formatAcres(a._saleAcres), 'num'),
    csv: { header: 'Acres', extract: (a) => a._saleAcres } },

  { key: 'pricePerAcre', header: '$/Acre',        mode: 'sales',  sortable: true,
    theadTitle: 'Sale price ÷ acres. For multi-parcel sales, divides by the group total land.',
    render: (a) => td(formatDollars(a._pricePerAcre), 'num'),
    csv: { header: '$/Acre', extract: (a) => a._pricePerAcre } },

  { key: 'pricePerLot',  header: '$/Lot',         mode: 'sales',  sortable: true,
    theadTitle: 'Sale price ÷ number of parcels in the transaction — what one lot fetched in a multi-lot deal. Equals the sale price on a single-parcel sale.',
    render: (a) => td(formatDollars(a._pricePerLot), 'num'),
    csv: { header: '$/Lot', extract: (a) => a._pricePerLot } },

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

  { key: 'n1Id',         header: 'N1 ID',         mode: 'sales',  sortable: true,
    theadTitle: 'Narrative1 comp-database ID from the offline SABRE crosswalk. '
      + 'Blank = not matched to an N1 record yet (or the CSV carries no N1 ID '
      + 'column) — filter to Unmatched under Additional filters to work the '
      + 'data-entry queue.',
    render: (a) => td(a._n1Id != null ? String(a._n1Id) : null, 'num'),
    csv: { header: 'N1 ID', extract: (a) => a._n1Id } },

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
 *
 * `numbering` mirrors the "Number parcels" toggle. It defaults to false so
 * the export keeps the schema it has always had; the `#` column joins only
 * when the user has actually numbered the set, where it is the join key
 * between the spreadsheet and the map exhibit.
 */
export function csvSchemaForMode(mode, { numbering = false } = {}) {
  const headers = [];
  const cells = [];
  for (const col of columnsForMode(mode)) {
    if (col.key === 'seq' && !numbering) continue;
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
