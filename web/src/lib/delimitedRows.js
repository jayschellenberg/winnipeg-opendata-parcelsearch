/*
 * Delimited-text row tokenizers, shared by the sales upload and paste
 * paths. Ported from the Manitoba sister app (mb-parcelsearch
 * web/src/lib/delimitedRows.js).
 *
 * Two tokenizers, because pasted table data comes in two shapes:
 *
 *   tokenizeRows           — the ordinary quote-aware CSV/TSV parse. A
 *                            newline always ends the row unless it sits
 *                            inside a quoted cell.
 *   tokenizeRowsFixedWidth — the same, but told how many columns a row
 *                            has, so an UNQUOTED newline inside a cell
 *                            (what a browser table copy produces when a
 *                            cell stacks several values) stays part of
 *                            that cell instead of fracturing the row.
 *
 * The second one exists because a paste out of an HTML assessment table
 * quotes nothing: a naive tokenizer fractures each stacked sale into
 * ragged rows that then fail every downstream guard, and the sale
 * silently vanishes. See parseSalesText, which runs both and keeps
 * whichever recovers more rows.
 */

/**
 * Quote-aware row tokenizer parameterized on delimiter. Handles quoted
 * fields with embedded delimiters, escaped double-quotes (""), and
 * \r\n / \n / \r line endings.
 *
 * `delimiter` is either a literal character ('\t' or ',') or a RegExp
 * (whitespace splitting, used when no delimiter is found). Whitespace
 * mode bypasses the quote handling — pasted single-line input never
 * embeds delimiters in quoted cells.
 *
 * Returns an array of arrays. Completely empty rows are dropped.
 */
export function tokenizeRows(text, delimiter = ',') {
  const src = String(text || '');
  // Whitespace-only delimiter: simple split per line.
  if (delimiter instanceof RegExp) {
    return src
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.split(delimiter).map((c) => c.trim()).filter((c) => c !== ''));
  }
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => {
    // Drop completely empty rows. A row with one empty cell still
    // counts as a row of one cell — callers filter further.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === delimiter) {
      pushField(); i++;
    } else if (c === '\r' || c === '\n') {
      pushField(); pushRow();
      if (c === '\r' && src[i + 1] === '\n') i += 2; else i++;
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
}

/**
 * Column-count-aware tokenizer for the unquoted-multi-line-cell case.
 *
 * Some spreadsheet/table copies stack several values into a single
 * logical row where one or more cells carry newline-separated values —
 * but the source doesn't quote those cells, so a naive tokenization
 * breaks every embedded newline into its own (ragged) physical row.
 * Knowing the expected column count `N` (from the header), we can
 * reconstruct the logical rows: a newline is treated as *intra-cell*
 * until `N-1` delimiters have been seen, then it terminates the row.
 * Embedded newlines are preserved in the field.
 *
 * Quote handling matches tokenizeRows, so a properly-quoted CSV export
 * (Excel wraps multi-line cells in quotes) flows through unchanged.
 * Clean rows (already N fields) come out identical to the naive parse.
 *
 * Callers must guard this: on input that is ragged for the OTHER reason
 * — trailing empty columns omitted from a real CSV — it merges rows that
 * should have stayed apart. See parseSalesText, which runs both parses
 * and keeps whichever recovers more rows.
 */
export function tokenizeRowsFixedWidth(text, delimiter, N) {
  const src = String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => {
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === delimiter) {
      pushField(); i++;
    } else if (c === '\r' || c === '\n') {
      const nl = (c === '\r' && src[i + 1] === '\n') ? 2 : 1;
      if (row.length === 0 && field === '') {
        i += nl;                         // blank line — skip
      } else if (row.length >= N - 1) {
        pushField(); pushRow(); i += nl; // last field done → end row
      } else {
        field += '\n'; i += nl;          // non-last cell spans physical lines
      }
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
}
