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
import { mapSalesHeaders, normalizeSaleDate, parseSalesText } from './salesImport.js';
import { isMlsHeader, parseMlsText, MLS_ONLY_COLUMNS } from './mlsImport.js';

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
  // MLS names its date column DateSold, so the SABRE alias table cannot
  // find it — locate it directly for those files or the whole export
  // reports as having no sale dates at all.
  const mls = isMlsHeader(headerCells);
  const { canonicalByIndex } = mapSalesHeaders(headerCells);
  const dateCol = mls
    ? headerCells.findIndex((h) => h.trim().toLowerCase() === 'datesold')
    : canonicalByIndex.indexOf('Sale Dates');
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
 * How close two records must be, in days, to be the same transaction
 * seen from both sources.
 *
 * MLS dates the firm offer and SABRE dates registration, and in Jason's
 * archive the gap runs three to eight weeks — never zero, not once
 * across 1,032 MLS rows. 120 days is comfortably past the long tail
 * without being loose enough to fuse two genuine sales of the same
 * parcel, which in this data are years apart.
 */
export const CROSS_SOURCE_DAYS = 120;

/** Numeric value of a price cell, ignoring currency formatting. */
function priceOf(row) {
  const n = Number(String(row?.['Sold Price'] ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fuse the same transaction reported by both sources into one row.
 *
 * Matched on roll + identical price within CROSS_SOURCE_DAYS. The SABRE
 * row wins the identity — registration is the recorded transaction, and
 * its instrument number is what the rest of the app groups by — while
 * the MLS row donates what SABRE has no column for: the offer date,
 * list and original price, days on market, and the qualitative fields.
 *
 * Without this, 380 of Jason's commercial comps would appear twice,
 * three to eight weeks apart, at the same price: the worst kind of
 * duplicate, because both rows look individually plausible.
 *
 * @returns {{rows: object[], collapsed: number}}
 */
export function collapseCrossSource(rows) {
  const sabre = [];
  const mls = [];
  for (const r of rows) (r.Source === 'MLS' ? mls : sabre).push(r);
  if (!sabre.length || !mls.length) return { rows, collapsed: 0 };

  const byRoll = new Map();
  for (const s of sabre) {
    const k = String(s['Parcel ID'] ?? '').trim();
    if (!k) continue;
    if (!byRoll.has(k)) byRoll.set(k, []);
    byRoll.get(k).push(s);
  }

  const out = [...sabre];
  let collapsed = 0;
  const taken = new Set();
  for (const m of mls) {
    const roll = String(m['Parcel ID'] ?? '').trim();
    const price = priceOf(m);
    const ms = Date.parse(m['Sale Dates']);
    const candidates = byRoll.get(roll) || [];
    let hit = null;
    if (price != null && Number.isFinite(ms)) {
      for (const s of candidates) {
        if (taken.has(s)) continue;
        if (priceOf(s) !== price) continue;
        const sms = Date.parse(s['Sale Dates']);
        if (!Number.isFinite(sms)) continue;
        if (Math.abs(sms - ms) <= CROSS_SOURCE_DAYS * 86_400_000) { hit = s; break; }
      }
    }
    if (!hit) { out.push(m); continue; }
    taken.add(hit);
    collapsed++;
    // SABRE keeps the sale date and the instrument; MLS fills the gaps.
    for (const col of MLS_ONLY_COLUMNS) {
      if (m[col] != null && m[col] !== '' && !hit[col]) hit[col] = m[col];
    }
    for (const col of ['Living Area', 'Year Built', 'Land Actual sqft', 'Number of Unit']) {
      if (!hit[col] && m[col]) hit[col] = m[col];
    }
    hit.Source = 'SABRE+MLS';
  }
  return { rows: out, collapsed };
}

/**
 * Merge every export in the folder into one canonical CSV.
 *
 * Works on parsed ROWS rather than raw text, unlike the first version of
 * this file: SABRE and MLS share no header, so there is no raw form
 * both can be appended to. Each file is translated to the canonical
 * schema by its own parser, and the merge happens in that one language.
 *
 * Three separate reductions, in order:
 *   1. exact duplicate rows within a source (the same pull exported
 *      twice, including the ISO/MM-DD-YYYY date-format variants that
 *      once doubled July 2022);
 *   2. the same transaction seen by both sources (collapseCrossSource);
 *   3. nothing else — component rows of a multi-building sale are
 *      genuine and must survive, which is why the first pass compares
 *      whole rows and not (roll, instrument).
 *
 * @param {Array<{name: string, csv: string}>} files
 * @returns {{text, kept, duplicates, total, fileCount, collapsed, skipped}}
 */
export function mergeSalesFiles(files) {
  const list = (files || []).filter((f) => f && typeof f.csv === 'string');
  if (!list.length) {
    return { text: '', kept: 0, duplicates: 0, total: 0, fileCount: 0, collapsed: 0,
      skipped: { nonWinnipeg: 0, noRoll: 0, unsold: 0 }, unreadable: [] };
  }

  const all = [];
  const seen = new Set();
  let total = 0;
  let duplicates = 0;
  const skipped = { nonWinnipeg: 0, noRoll: 0, unsold: 0 };
  // Files that parsed to nothing. The first version of this function
  // THREW on a header it didn't recognise, which named the offending
  // file; two schemas make throwing impossible, so the name is reported
  // instead rather than the file vanishing without trace.
  const unreadable = [];

  for (const file of list) {
    const firstRow = tokenizeRows(file.csv, ',')[0] || [];
    let rows;
    if (isMlsHeader(firstRow)) {
      const parsed = parseMlsText(file.csv);
      rows = parsed.rows;
      for (const k of Object.keys(skipped)) skipped[k] += parsed.skipped[k] || 0;
    } else {
      // `|| 'SABRE'`, not a blanket assignment: a file in the SABRE schema
      // can legitimately carry its own Source. The Winnipeg N1 crosswalk
      // emits the sales SABRE never had in exactly this shape, marked
      // Source=N1, and overwriting that made them indistinguishable from
      // records the City actually published.
      rows = parseSalesText(file.csv).rows.map((r) => ({ ...r, Source: r.Source || 'SABRE' }));
    }
    if (!rows.length) unreadable.push(file.name);
    for (const row of rows) {
      total++;
      // Canonical signature: the date is already normalized by both
      // parsers, so the format drift between exports can no longer
      // masquerade as a distinct sale.
      const sig = Object.keys(row).sort().map((k) => `${k}=${row[k]}`).join(SEP);
      if (seen.has(sig)) { duplicates++; continue; }
      seen.add(sig);
      all.push(row);
    }
  }

  const { rows: fused, collapsed } = collapseCrossSource(all);

  // Emit the union of columns so neither source loses a field, with the
  // canonical SABRE columns first so a human reading the export sees
  // the familiar shape.
  const columns = [];
  const pushCol = (c) => { if (!columns.includes(c)) columns.push(c); };
  for (const c of ['Parcel ID', 'Instrument Number', 'Sale Dates', 'Sold Price']) pushCol(c);
  for (const row of fused) for (const c of Object.keys(row)) pushCol(c);

  const out = [columns];
  for (const row of fused) out.push(columns.map((c) => row[c] ?? ''));
  return {
    text: rowsToCsv(out),
    kept: fused.length,
    duplicates,
    total,
    fileCount: list.length,
    collapsed,
    skipped,
    unreadable,
  };
}
