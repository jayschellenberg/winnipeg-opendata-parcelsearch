/*
 * Parser for the "Import list" modal — a pasted or uploaded block of
 * civic addresses and/or roll numbers, turned into rows the resolver
 * can look up.
 *
 * WHAT MAKES THIS DIFFERENT from lib/salesImport.js: that parser knows
 * its schema and aliases headers onto it. Here there IS no schema. The
 * user pastes whatever a column of a spreadsheet gave them — one
 * address per line, or a CSV with six columns of which one happens to
 * hold the address. So instead of naming columns we SCORE them: every
 * column index is parsed, and the one that yields the most recognizable
 * addresses/rolls wins. Extra columns are ignored outright.
 *
 * THE COMMA PROBLEM. "330 Selkirk Ave, Winnipeg, MB" is one address,
 * but comma-tokenizing it gives three cells. Column scoring solves this
 * without a special case: cell 0 ("330 Selkirk Ave") parses, cells 1-2
 * ("Winnipeg", "MB") do not, so column 0 wins and the locality cells
 * are dropped as the noise they are. A real CSV with the address in
 * column 3 lands on column 3 for exactly the same reason.
 *
 * WHAT COUNTS AS A ROLL rather than an address: a cell that is nothing
 * but digits (and separators) with 9-11 digits left after stripping.
 * Winnipeg rolls are 11 digits; 9 and 10 are the same roll with leading
 * zeros dropped by Excel, which is why normalizeRoll pads. No Winnipeg
 * civic address is a bare 9+ digit number, so the test cannot collide.
 *
 * AMBIGUOUS INPUT IS NOT RESOLVED HERE. "5-330 Selkirk" might be unit 5
 * of 330, or the range 5 to 330. This module commits to the leading
 * number and records what it understood in `interpreted`; the review
 * screen shows that string back to the user before anything is looked
 * up. Guessing quietly is the failure mode worth avoiding, not guessing.
 *
 * Pure — no DOM, no network — so the whole thing is unit tested in
 * test/parcelListParse.test.js.
 */

import { tokenizeRows } from './delimitedRows.js';

/** Header-ish cell values that mean "this row is a header, not data". */
const HEADER_WORDS = new Set([
  'address', 'addresses', 'civic address', 'property address', 'site address',
  'location', 'street address', 'full address',
  'roll', 'roll number', 'roll no', 'roll #', 'rollnumber', 'parcel id',
  'parcelid', 'property', 'properties',
]);

/**
 * Words that mark a cell as a column heading when it is not an exact
 * match for one of the above — "Address or Roll #", "Subject Property
 * Address", "Roll Number (11 digit)". Matching on CONTAINS would be far
 * too loose on its own; it is only ever applied to a row in which NOT
 * ONE cell parsed as data, and a real address or roll always parses. So
 * "123 Roll Street" can never reach this test.
 */
const HEADER_TOKENS = ['address', 'roll', 'parcel', 'civic'];

/**
 * Locality tokens stripped from the TAIL of an address cell. The City's
 * datasets store neither city nor province, so "330 Selkirk Ave,
 * Winnipeg, MB" has to lose its last two components before street_name
 * can match. Stripping only ever widens the match.
 */
const LOCALITY_TAIL = /(?:,\s*)?\b(?:CITY\s+OF\s+)?(?:WINNIPEG|MANITOBA|CANADA|MB|CA)\b\.?\s*$/i;

/** Canadian postal code, with or without the internal space. */
const POSTAL_CODE = /\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/i;

/** Unit/suite prefixes that lead a Winnipeg address. Stripped before
 *  the civic number is read, so "Unit 5 - 330 Selkirk" reads as 330. */
const UNIT_PREFIX = /^\s*(?:#|UNIT|APT|APARTMENT|SUITE|STE|BAY)\s*[:#-]?\s*[A-Z0-9]+\s*(?:[-,]|\s)\s*/i;

/** A cell that is only digits and separators — the roll-number shape. */
const DIGITS_ONLY = /^[\d\s,;.-]+$/;

export function normalizeHeaderCell(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

/**
 * Strip the locality tail, any postal code, and surrounding punctuation
 * from one address cell. Returns '' when nothing usable is left.
 */
export function cleanAddressCell(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(POSTAL_CODE, ' ');
  // Locality may repeat (", Winnipeg, MB") so strip until it stops
  // matching. Bounded by the string shrinking every pass.
  for (let guard = 0; guard < 4; guard += 1) {
    const next = s.replace(LOCALITY_TAIL, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/[\s,;]+$/, '').replace(/^[\s,;]+/, '').replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse one cleaned cell into { number, street }. Returns null when the
 * cell does not lead with a civic number followed by a street name.
 *
 * The trailing letter on "330A Selkirk" is dropped: street_number is a
 * NUMBER column in both datasets, so 330A is looked up as 330 and the
 * review screen shows that.
 */
export function parseAddressCell(raw) {
  let s = cleanAddressCell(raw);
  if (!s) return null;
  s = s.replace(UNIT_PREFIX, '').trim();
  const m = s.match(/^(\d{1,6})\s*[A-Za-z]?\s*(?:-\s*\d{1,6}\s*[A-Za-z]?\s*)?[\s,]\s*(.+)$/);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  const street = m[2].replace(/\s+/g, ' ').trim();
  if (!Number.isFinite(number) || number <= 0) return null;
  // A street has to contain a letter — "330 340" is two numbers, not an
  // address, and would otherwise match with street "340".
  if (!/[A-Za-z]/.test(street)) return null;
  return { number, street };
}

/**
 * Parse one cell into a roll number. Returns the digit string (NOT
 * zero-padded — soda.js normalizeRoll owns that) or null.
 */
export function parseRollCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s || !DIGITS_ONLY.test(s)) return null;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length < 9 || digits.length > 11) return null;
  return digits;
}

/**
 * Classify one cell. Roll is tested first: a bare 9-11 digit number can
 * never be a civic address, while parseAddressCell would happily read
 * "01003547800" as a number on a street named nothing.
 */
export function classifyCell(raw) {
  const roll = parseRollCell(raw);
  if (roll) return { kind: 'roll', roll, interpreted: roll };
  const addr = parseAddressCell(raw);
  if (addr) {
    return {
      kind: 'address',
      number: addr.number,
      street: addr.street,
      interpreted: `${addr.number} ${addr.street.toUpperCase()}`,
    };
  }
  return { kind: 'unparseable', interpreted: '' };
}

/** Pick the delimiter the same way lib/salesImport.js does: a tab if
 *  one is present anywhere (spreadsheet copy), else a comma. */
function pickDelimiter(text) {
  return String(text || '').includes('\t') ? '\t' : ',';
}

/**
 * Does this row read like a header? True when ANY cell is a known
 * header word and NO cell classifies as data. The second half matters:
 * a list whose first address is on a street called "Location" should
 * not lose its first row.
 */
export function looksLikeHeaderRow(cells) {
  const list = cells || [];
  if (!list.length) return false;
  // The guard comes FIRST and is what makes the loose token match safe:
  // a row containing any real address or roll is data, whatever its
  // other cells say.
  if (list.some((c) => classifyCell(c).kind !== 'unparseable')) return false;
  return list.some((c) => {
    const n = normalizeHeaderCell(c);
    if (!n) return false;
    if (HEADER_WORDS.has(n)) return true;
    return HEADER_TOKENS.some((t) => n.split(' ').includes(t));
  });
}

/**
 * Parse a pasted/uploaded block into rows ready for resolution.
 *
 * @param {string} text
 * @returns {{
 *   rows: Array<{ lineNo, raw, cell, kind, roll?, number?, street?, interpreted }>,
 *   delimiter: string,
 *   column: number,
 *   headerDropped: boolean,
 *   counts: { total, address, roll, unparseable },
 * }}
 */
export function parseParcelList(text) {
  const delimiter = pickDelimiter(text);
  const all = tokenizeRows(text, delimiter)
    .filter((r) => r.some((c) => String(c).trim() !== ''));
  const headerDropped = all.length > 1 && looksLikeHeaderRow(all[0]);
  const body = headerDropped ? all.slice(1) : all;
  if (!body.length) {
    return {
      rows: [], delimiter, column: 0, headerDropped,
      counts: { total: 0, address: 0, roll: 0, unparseable: 0 },
    };
  }

  // Score every column index. A column's score is how many rows it
  // classifies as real data; ties go to the leftmost column, which is
  // what makes "330 Selkirk Ave, Winnipeg, MB" resolve on column 0.
  const width = body.reduce((w, r) => Math.max(w, r.length), 0);
  const classified = [];   // [colIndex][rowIndex] -> classification
  let best = 0;
  let bestScore = -1;
  for (let col = 0; col < width; col += 1) {
    const colResults = body.map((r) => classifyCell(r[col]));
    classified.push(colResults);
    const score = colResults.filter((c) => c.kind !== 'unparseable').length;
    if (score > bestScore) { bestScore = score; best = col; }
  }

  const chosen = classified[best] || [];
  const rows = body.map((r, i) => {
    const c = chosen[i] || { kind: 'unparseable', interpreted: '' };
    // `raw` is the whole original line, kept for the review screen's
    // tooltip. Cells are joined with a visible separator rather than
    // whitespace: collapsing a tab into a space made a leading index
    // column read as part of the address ("1  330 Selkirk Ave" became
    // "1 330 Selkirk Ave"), which looks exactly like the parser merged
    // two columns it had in fact kept apart. Empty trailing cells are
    // dropped so a spreadsheet's blank Notes column adds no dangling
    // separator.
    const raw = r
      .map((cell) => String(cell ?? '').replace(/\s+/g, ' ').trim())
      .filter((cell) => cell !== '')
      .join(' · ');
    return {
      lineNo: i + 1 + (headerDropped ? 1 : 0),
      raw,
      cell: String(r[best] ?? '').replace(/\s+/g, ' ').trim(),
      ...c,
    };
  });

  return {
    rows,
    delimiter,
    column: best,
    headerDropped,
    counts: {
      total: rows.length,
      address: rows.filter((r) => r.kind === 'address').length,
      roll: rows.filter((r) => r.kind === 'roll').length,
      unparseable: rows.filter((r) => r.kind === 'unparseable').length,
    },
  };
}
