/*
 * Merging a folder of SABRE "SoldPropertyListing" exports into one CSV.
 *
 * The exports are manual pulls capped near 500 records each, so their
 * date windows overlap and the same sale row appears in more than one
 * file. That matters because lib/sales.js's dedupAndGroupSales SUMS
 * Living Area (and MAX-es units) per (Parcel ID, Instrument Number):
 * the same physical row imported twice would double-count living area,
 * while two DIFFERENT rows sharing that key are genuine building-
 * component rows that must both survive. Only an exact-cell match can
 * tell those apart — hence the full-row signature dedupe here, and no
 * smarter key.
 *
 * Pure and Node-testable: no DOM, no IndexedDB, no fetch. The store
 * (lib/salesStore.js) hands in raw CSV text; the output text goes to
 * the same handleSalesUpload pipeline as a file drop.
 */

import { tokenizeRows } from './delimitedRows.js';
import { mapSalesHeaders, normalizeSaleDate } from './salesImport.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cell separator for the signature keys: a control character no CSV
// cell can contain (the tokenizer never emits one), built via
// fromCharCode so the source stays plain ASCII.
const SEP = String.fromCharCode(1);

/** Header cells → a comparison key that ignores case/whitespace drift
 *  between exports pulled months apart. */
function headerKeyOf(cells) {
  return cells.map((c) => String(c ?? '').trim().toLowerCase()).join(SEP);
}

/**
 * Full-row signature for the cross-file dedupe.
 *
 * Cells are trimmed so trailing-whitespace variance between exports
 * doesn't defeat it, and the SEP separator keeps cell boundaries in the
 * key, so ("ab","c") and ("a","bc") cannot collide.
 *
 * The Sale Dates cell is NORMALIZED before hashing, which is not
 * cosmetic: SABRE exports the same sale as "2022-07-11" in one pull and
 * "07-11-2022" in another, and a raw comparison therefore called 217
 * genuinely duplicate July-2022 rows distinct — inflating that month to
 * 434 sales against a ~220 baseline and doubling living area on every
 * one of them. Pass `dateCol` (from mapSalesHeaders) to enable it.
 *
 * @param {string[]} cells
 * @param {number} [dateCol] index of the Sale Dates column, -1/undefined if absent
 */
export function rowSignature(cells, dateCol = -1) {
  return cells
    .map((c, i) => {
      const v = String(c ?? '').trim();
      return i === dateCol ? normalizeSaleDate(v) : v;
    })
    .join(SEP);
}

/** Quote a CSV cell only when it needs it. */
export function csvCell(s) {
  const v = String(s ?? '');
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** string[][] → CSV text that round-trips through parseSalesText. */
export function rowsToCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

/**
 * Everything the store needs to know about one export file: its header
 * identity, quote-aware row count, and the sale-date span (for the
 * Coverage table — the gap-spotting view over the manual pulls).
 *
 * Dates are normalized to ISO BEFORE comparing (SABRE emits MM-DD-YYYY;
 * ISO strings compare lexically), and anything that doesn't normalize
 * to a real date is left out of the span rather than poisoning it.
 *
 * @param {string} text  raw CSV text of one export
 * @returns {{headerCells: string[], headerKey: string, dataRowCount: number,
 *            minSaleDate: string|null, maxSaleDate: string|null}}
 */
export function analyzeSalesCsv(text) {
  const rows = tokenizeRows(String(text ?? ''), ',');
  const headerCells = (rows[0] || []).map((c) => String(c ?? '').trim());
  const { canonicalByIndex } = mapSalesHeaders(headerCells);
  const dateCol = canonicalByIndex.indexOf('Sale Dates');
  let min = null;
  let max = null;
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;
    count++;
    if (dateCol < 0) continue;
    const iso = normalizeSaleDate(cells[dateCol]);
    if (!ISO_DATE_RE.test(iso)) continue;
    if (min == null || iso < min) min = iso;
    if (max == null || iso > max) max = iso;
  }
  return {
    headerCells,
    headerKey: headerKeyOf(headerCells),
    dataRowCount: count,
    minSaleDate: min,
    maxSaleDate: max,
  };
}

/**
 * Merge export files into one CSV: first file's header, every later
 * file's header dropped, data rows deduped by full-row signature across
 * files (first occurrence wins).
 *
 * Throws when a file's header disagrees with the first one — silently
 * mis-aligning columns would corrupt every downstream number, and the
 * thrown message names the odd file so it can be re-exported or removed.
 *
 * No date-window parameter on purpose: files are ≤500 records, so the
 * whole archive is small enough to merge outright and let the sales
 * tab's existing Sale-date filter narrow what shows.
 *
 * @param {Array<{name: string, csv: string}>} files
 * @returns {{text: string, kept: number, duplicates: number, total: number,
 *            fileCount: number}}
 */
export function mergeSalesFiles(files) {
  const list = (files || []).filter((f) => f && typeof f.csv === 'string');
  if (!list.length) {
    return { text: '', kept: 0, duplicates: 0, total: 0, fileCount: 0 };
  }
  let header = null;
  let headerKey = null;
  let dateCol = -1;
  const out = [];
  const seen = new Set();
  let total = 0;
  let duplicates = 0;
  for (const file of list) {
    const rows = tokenizeRows(file.csv, ',');
    const cells = (rows[0] || []).map((c) => String(c ?? '').trim());
    const key = headerKeyOf(cells);
    if (header == null) {
      header = cells;
      headerKey = key;
      dateCol = mapSalesHeaders(cells).canonicalByIndex.indexOf('Sale Dates');
      out.push(header);
    } else if (key !== headerKey) {
      throw new Error(
        `Sales exports have different columns — ${file.name} doesn't match `
        + 'the other files. Re-export it with the same column set, or move '
        + 'it out of the folder.'
      );
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
      total++;
      const sig = rowSignature(row, dateCol);
      if (seen.has(sig)) { duplicates++; continue; }
      seen.add(sig);
      out.push(row);
    }
  }
  return {
    text: rowsToCsv(out),
    kept: total - duplicates,
    duplicates,
    total,
    fileCount: list.length,
  };
}
