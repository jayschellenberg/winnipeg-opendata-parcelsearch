/*
 * Sales-import parsing for the Sales Analysis tab. One parser behind
 * three entry points — the dropzone (a real CSV file), the "Paste
 * data…" modal (a block copied straight out of SABRE or Excel), and the
 * Recent-uploads replay — so all three behave identically downstream.
 *
 * Modelled on the Manitoba sister app's lib/salesCsvParse.js, but the
 * output shape is this app's: an array of row OBJECTS keyed by the
 * canonical Winnipeg sales-export column names, which is exactly what
 * lib/sales.js's dedupAndGroupSales already consumes. That keeps the
 * whole downstream pipeline untouched.
 *
 * Two things the old comma-only parser couldn't do, both needed for a
 * paste:
 *
 *   1. TAB-delimited input. Copying a block out of a spreadsheet or an
 *      HTML table puts tabs on the clipboard, never commas.
 *   2. Header aliasing. A pasted block's headers won't match the CSV
 *      export's byte for byte (different casing, spacing, punctuation,
 *      or a different label for the same field).
 *
 * Pure — no DOM, no network — so the whole thing is unit tested in
 * test/salesImport.test.js.
 */

import { tokenizeRows, tokenizeRowsFixedWidth } from './delimitedRows.js';

/**
 * The canonical sales schema. Keys are the column names
 * lib/sales.js reads off each row; values are the accepted header
 * aliases, compared after normalizeHeader() (lowercased, punctuation
 * and whitespace stripped) — so "Sale Dates", "sale_dates",
 * "SALE DATES" and "Sale Dates " all collapse onto `saledates`.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE EXTENSION POINT FOR SABRE.                          │
 * │ When a SABRE paste fails to load, the error names the required   │
 * │ fields it couldn't map AND lists the headers it actually saw     │
 * │ (see describeHeaderProblem). Add those headers as aliases below  │
 * │ — nothing else in the pipeline needs to change.                  │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * The first alias in each list is the canonical name itself, so the
 * City's own CSV export continues to parse with zero aliasing.
 */
export const SALES_HEADER_ALIASES = {
  // --- Required. Without these a row can't be resolved to a parcel or
  // grouped into a sale. ---
  'Parcel ID':         ['parcel id', 'parcelid', 'roll', 'roll number', 'roll no', 'roll #'],
  'Instrument Number': ['instrument number', 'instrument no', 'instrument', 'instrument #'],
  'Sale Dates':        ['sale dates', 'sale date', 'date of sale', 'sold date'],
  'Sold Price':        ['sold price', 'sale price', 'consideration', 'price'],

  // --- Optional. Used when present; absent just leaves the column blank. ---
  // Sworn Value is the value declared for land-transfer purposes. It
  // matters because SABRE writes a NOMINAL Sold Price ($1) on
  // non-arms-length transfers while the sworn value carries the real
  // figure — see the Sworn column and the sentinel note in main.js.
  'Sworn Value':        ['sworn value', 'swornvalue', 'sworn'],
  'Zoning':             ['zoning', 'zone'],
  'Land Actual sqft':   ['land actual sqft', 'land actual sq ft', 'land actual area'],
  'Land Assessed sqft': ['land assessed sqft', 'land assessed sq ft', 'land assessed area'],
  'Living Area':        ['living area', 'total living area'],
  'Year Built':         ['year built', 'yearbuilt', 'effective year built'],
  'Par Use Code':       ['par use code', 'parcel use code', 'use code', 'pucs'],
  'Property Type':      ['property type', 'prop type'],
  'Property Sub Type':  ['property sub type', 'property subtype', 'prop sub type'],
  'Street Number':      ['street number', 'street no', 'st number'],
  'Street Direction':   ['street direction', 'street dir', 'st direction'],
  'Street Name':        ['street name', 'st name'],
  'Number of Unit':     ['number of unit', 'number of units', 'no of units', 'units'],
  // Jason's N1 comp-database ID, stamped onto SABRE rows by the offline
  // crosswalk (a backfill archive, non-residential only). Blank or absent
  // means "not matched yet" — the N1 filter reads that as the queue of
  // sales still to be entered into N1.
  'N1 ID':              ['n1 id', 'n1id', 'n1'],
};

/**
 * The four columns a load cannot proceed without: the roll and the
 * instrument are the dedupe/grouping key, and the date and price are
 * the analysis itself. Everything else degrades gracefully.
 */
export const SALES_REQUIRED_COLS = [
  'Parcel ID', 'Instrument Number', 'Sale Dates', 'Sold Price',
];

/**
 * Fold a header cell down to its comparison key: lowercase, strip
 * everything that isn't a letter or digit. Deliberately aggressive so
 * "Sold Price", "sold_price", "Sold-Price" and "SoldPrice" all match a
 * single alias entry rather than needing four.
 */
export function normalizeHeader(h) {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Alias lookup, built once: normalized alias → canonical column name.
const ALIAS_LOOKUP = (() => {
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(SALES_HEADER_ALIASES)) {
    m.set(normalizeHeader(canonical), canonical);
    for (const a of aliases) m.set(normalizeHeader(a), canonical);
  }
  return m;
})();

/**
 * Sniff the delimiter. Tab wins when the first non-empty line carries
 * one (the spreadsheet / assessment-table copy-paste workflow),
 * otherwise comma (a genuine CSV file). Separate from the tokenizer so
 * the paste and file paths share exactly one detection rule.
 */
export function detectSalesDelimiter(text) {
  const firstLine = String(text || '').split(/\r\n|\r|\n/).find((l) => l.trim()) || '';
  return firstLine.includes('\t') ? '\t' : ',';
}

/**
 * Map a header row onto canonical column names.
 *
 * Returns { canonicalByIndex, mapped, unmapped, missingRequired } where
 * canonicalByIndex[i] is the canonical name for column i (or the
 * ORIGINAL header text when no alias matched — unrecognised columns
 * pass straight through rather than being dropped, so nothing is lost
 * and a future alias can be added by simply looking at what came out).
 *
 * A duplicate mapping (two source columns aliasing to the same
 * canonical name) keeps the FIRST — later ones stay under their own
 * header text so they remain inspectable instead of silently
 * overwriting real data.
 */
export function mapSalesHeaders(headerRow) {
  const canonicalByIndex = [];
  const mapped = new Map();     // canonical → source header text
  const unmapped = [];
  const claimed = new Set();
  (headerRow || []).forEach((raw, i) => {
    const text = String(raw ?? '').trim();
    const canonical = ALIAS_LOOKUP.get(normalizeHeader(text));
    if (canonical && !claimed.has(canonical)) {
      claimed.add(canonical);
      mapped.set(canonical, text);
      canonicalByIndex[i] = canonical;
    } else {
      if (text) unmapped.push(text);
      canonicalByIndex[i] = text;
    }
  });
  const missingRequired = SALES_REQUIRED_COLS.filter((c) => !claimed.has(c));
  return { canonicalByIndex, mapped, unmapped, missingRequired };
}

/**
 * Human-readable diagnosis for a header row that can't be loaded.
 * Returns '' when the headers are fine.
 *
 * This message is the feedback loop that finishes the SABRE work: it
 * names what's missing and echoes what was actually seen, so an
 * unrecognised SABRE header can be read straight off the screen and
 * added to SALES_HEADER_ALIASES.
 */
export function describeHeaderProblem({ missingRequired, unmapped }) {
  if (!missingRequired || missingRequired.length === 0) return '';
  let msg = `Missing required column${missingRequired.length === 1 ? '' : 's'}: ${missingRequired.join(', ')}.`;
  if (unmapped && unmapped.length) {
    const shown = unmapped.slice(0, 12).join(', ');
    msg += ` Unrecognised header${unmapped.length === 1 ? '' : 's'}: ${shown}${unmapped.length > 12 ? ', …' : ''}.`;
  }
  return msg;
}

/**
 * Normalize a sale date to ISO `YYYY-MM-DD`.
 *
 * This is not cosmetic. The Sale-date filter compares sale dates as
 * STRINGS against the native <input type="date"> value, which is always
 * ISO — so a SABRE date like `04-14-2026` compares as '0…' < '2…' and
 * every pasted row silently disappears the moment a bound is set. Sale
 * Date sorting has the same problem: raw MM-DD-YYYY sorts by month
 * across years.
 *
 * Handles `-` and `/` separators. Month-first is assumed, because that
 * is what SABRE emits (`03-27-2026`, `04-14-2026` — a 27th and a 14th
 * in the second position settle it), but a first field > 12 with a
 * plausible second field is read day-first so a European-style export
 * degrades gracefully rather than silently mangling.
 *
 * Anything already ISO passes through untouched, and anything not
 * recognised is returned AS-IS — a value we can't parse is left for the
 * user to see rather than destroyed.
 */
export function normalizeSaleDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return s;
  // Already ISO (optionally with a time component we don't need).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) return s;
  let month = Number(m[1]);
  let day   = Number(m[2]);
  const year = Number(m[3]);
  if (month > 12 && day <= 12) {
    // Unambiguously day-first (e.g. 27-03-2026).
    [month, day] = [day, month];
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return s;
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Columns that get a value transform on the way in. Keyed by canonical
// name so both the CSV and the paste path go through the same rule.
const VALUE_NORMALIZERS = {
  'Sale Dates': normalizeSaleDate,
};

/** Turn tokenized rows into canonical-keyed objects. Shared by the
 *  naive and reassembled tokenizations so parseSalesText can score one
 *  against the other. */
function objectsFromRows(rows, canonicalByIndex) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells || cells.length === 0) continue;
    // A single blank cell is a trailing newline, not a row.
    if (cells.length === 1 && !String(cells[0] ?? '').trim()) continue;
    const row = {};
    for (let j = 0; j < canonicalByIndex.length; j++) {
      const key = canonicalByIndex[j];
      if (!key) continue;
      const raw = String(cells[j] ?? '').trim();
      const normalize = VALUE_NORMALIZERS[key];
      row[key] = normalize ? normalize(raw) : raw;
    }
    out.push(row);
  }
  return out;
}

/**
 * Parse a sales CSV or pasted block into canonical-keyed row objects.
 *
 * @returns {{
 *   rows: Object[],            // one per data row, keyed by canonical column name
 *   delimiter: string,         // '\t' or ','
 *   headers: string[],         // the raw header cells, as seen
 *   mapped: Map<string,string>,// canonical → source header text
 *   unmapped: string[],        // headers no alias matched
 *   missingRequired: string[], // required canonicals not found
 * }}
 *
 * Never throws on malformed input — an unparseable block comes back
 * with `rows: []` and the diagnostics filled in, which is what the
 * caller reports to the user.
 */
export function parseSalesText(text) {
  const delimiter = detectSalesDelimiter(text);
  const naiveRows = tokenizeRows(text, delimiter);
  const headers = (naiveRows[0] || []).map((h) => String(h ?? '').trim());
  // Nothing to inspect: no rows at all, or a "header" row that is
  // entirely blank (whitespace-only input tokenizes to one empty cell).
  // Report NO missing columns rather than "all of them missing" —
  // there was no header to judge, and the caller's empty-rows branch
  // ("No data rows found") is the honest message for this case.
  if (headers.every((h) => h === '')) {
    return {
      rows: [], delimiter, headers: [], mapped: new Map(),
      unmapped: [], missingRequired: [],
    };
  }
  const { canonicalByIndex, mapped, unmapped, missingRequired } = mapSalesHeaders(headers);
  const base = { delimiter, headers, mapped, unmapped, missingRequired };
  if (missingRequired.length) return { ...base, rows: [] };

  let rows = objectsFromRows(naiveRows, canonicalByIndex);

  // Ragged output — some row narrower than the header — has two possible
  // causes, and they want opposite fixes:
  //
  //   a) unquoted multi-line cells, where the fixed-width reassembly is
  //      the whole point (it recovers rows the naive parse threw away);
  //   b) a real CSV that simply omits trailing empty columns, where the
  //      reassembly is actively wrong — it would splice consecutive
  //      records into one.
  //
  // Rather than guess from the text, parse it both ways and keep the one
  // that recovers MORE rows. Case (a) gains rows; case (b) can only lose
  // them (rows merge), so the naive parse wins and short CSV rows keep
  // behaving exactly as they always did.
  const width = headers.length;
  if (width >= 2 && naiveRows.some((r) => r.length < width)) {
    const wideRows = tokenizeRowsFixedWidth(text, delimiter, width);
    if (wideRows.length >= 2) {
      const reassembled = objectsFromRows(wideRows, canonicalByIndex);
      if (reassembled.length > rows.length) rows = reassembled;
    }
  }

  return { ...base, rows };
}
