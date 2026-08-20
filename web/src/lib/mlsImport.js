/*
 * MLS export → the canonical sales schema.
 *
 * MLS shares nothing with a SABRE export but the subject matter: a
 * different header for every field, a roll number encoded inside a LINC
 * string, and a sale date that means something else. Rather than bend
 * the SABRE alias table around it, this module translates an MLS file
 * into exactly the canonical rows lib/salesImport.js already produces,
 * so everything downstream — the roll join, the grid, the charts, the
 * permit evidence — works on MLS sales without knowing they are MLS.
 *
 * THE DATE IS NOT THE SAME DATE. MLS `DateSold` is the firm/accepted
 * offer; SABRE's `Sale Dates` is registration. Across Jason's archive
 * the two sources never once agree on a date for the same transaction,
 * yet the prices match exactly — MLS runs three to eight weeks earlier.
 * Both are kept: the registration date is the sale, and the offer date
 * is the market signal that a time-adjustment actually wants. See
 * collapseCrossSource in salesDbMerge.js.
 *
 * Pure — no DOM, no network.
 */

import { tokenizeRows } from './delimitedRows.js';
import { normalizeHeader } from './salesImport.js';

/** MLS header → canonical column. Everything not listed is dropped. */
const MLS_TO_CANONICAL = {
  linc: 'Parcel ID',
  datesold: 'Sale Dates',
  pricesold: 'Sold Price',
  streetnumber: 'Street Number',
  streetname: 'Street Name',
  sqft: 'Living Area',
  yrblt: 'Year Built',
  lotsf: 'Land Actual sqft',
  numunits: 'Number of Unit',
  // MLS-only columns, canonical names of their own.
  mls: 'MLS #',
  pricelist: 'List Price',
  priceorig: 'Orig Price',
  dom: 'DOM',
  cdom: 'CDOM',
  bldgtype: 'Bldg Type',
  style: 'Style',
  siteinfl: 'Site Influences',
  type: 'Property Type',
};

/** Columns this module adds that a SABRE export never has. */
export const MLS_ONLY_COLUMNS = [
  'MLS #', 'MLS Date', 'List Price', 'Orig Price', 'DOM', 'CDOM',
  'Bldg Type', 'Style', 'Site Influences',
];

/** Does this header row look like an MLS export rather than SABRE? */
export function isMlsHeader(cells) {
  const seen = new Set((cells || []).map((c) => normalizeHeader(c)));
  // LINC + DateSold together are unique to MLS; either alone is not
  // enough to claim a file.
  return seen.has('linc') && seen.has('datesold');
}

/**
 * The 11-digit roll inside an MLS LINC.
 *
 * LINC is `<muni><R><roll>` — "008R000936000" is roll 08000936000 at
 * 689 St Mary's Road, confirmed against the assessment table. Taking
 * the last 11 digits drops the municipality prefix and the padding in
 * one step. Rows with no LINC (about a fifth of the file) yield null
 * and are reported rather than guessed at.
 */
export function lincToRoll(linc) {
  const digits = String(linc ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 11 ? digits.slice(-11) : null;
}

/** MM-DD-YYYY → ISO. MLS writes dates the same way SABRE does. */
function isoDate(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return String(v ?? '').trim();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p2(m[1])}-${p2(m[2])}`;
}

/**
 * Parse an MLS export into canonical sales rows.
 *
 * Winnipeg only, by decision: the export is pulled on a 20 km radius
 * and picks up West St Paul, Springfield, Headingley and others, none
 * of which exist in the City's assessment table and none of which can
 * therefore join anything here. They are counted, not silently dropped.
 *
 * @param {string} text raw CSV
 * @returns {{rows: object[], skipped: {nonWinnipeg: number, noRoll: number, unsold: number}}}
 */
/** Excel writes a byte-order mark on these exports; left in place it
 *  rides along on the first header cell and LINC is never recognised. */
function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

export function parseMlsText(text) {
  // Excel writes a BOM on these exports; it would otherwise ride along
  // on the first header cell and stop LINC being recognised.
  const rows = tokenizeRows(stripBom(String(text ?? '')), ',');
  const header = (rows[0] || []).map((c) => String(c ?? '').trim());
  const canonicalByIndex = header.map((h) => MLS_TO_CANONICAL[normalizeHeader(h)] || null);
  const idxOf = (name) => header.findIndex((h) => normalizeHeader(h) === name);
  const iCity = idxOf('city');
  const iStatus = idxOf('status');

  const out = [];
  const skipped = { nonWinnipeg: 0, noRoll: 0, unsold: 0 };
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;

    // Sold only. The export is sales-only today, but a status column
    // that ever carries a listing must not become a comp.
    if (iStatus >= 0) {
      const st = String(cells[iStatus] ?? '').trim().toUpperCase();
      if (st && st !== 'S') { skipped.unsold++; continue; }
    }
    if (iCity >= 0) {
      const city = String(cells[iCity] ?? '').trim().toUpperCase();
      if (city && city !== 'WINNIPEG') { skipped.nonWinnipeg++; continue; }
    }

    const row = {};
    for (let j = 0; j < canonicalByIndex.length; j++) {
      const key = canonicalByIndex[j];
      if (!key) continue;
      row[key] = String(cells[j] ?? '').trim();
    }

    const roll = lincToRoll(row['Parcel ID']);
    if (!roll) { skipped.noRoll++; continue; }
    row['Parcel ID'] = roll;

    const sold = isoDate(row['Sale Dates']);
    row['Sale Dates'] = sold;
    // The offer date is kept in its own column from the start, so a row
    // that later collapses onto a SABRE registration date does not lose
    // the market signal it arrived with.
    row['MLS Date'] = sold;
    // An MLS listing number identifies the transaction the way a Land
    // Titles instrument does on the SABRE side; prefixed so the two can
    // never collide in the (roll, instrument) key.
    row['Instrument Number'] = row['MLS #'] ? `MLS-${row['MLS #']}` : '';
    row['Source'] = 'MLS';
    out.push(row);
  }
  return { rows: out, skipped };
}
