/*
 * Sales-tab range and text filters — the pure predicates behind the
 * "Additional filters" row (Manitoba parity: `size-low` / `size-high` /
 * `sales-street-name`).
 *
 * These run PRE-JOIN, against the parsed SaleRecords rather than the
 * joined features, for the same reason the date and PUCS filters do:
 * every row they remove is a roll that never has to be fetched from
 * d4mq-wa44. main.js owns the wiring; this file owns the meaning.
 *
 * Two rules are shared by both filters and worth stating once:
 *
 *   - EMPTY IS OFF. A blank input is not "0" or "match everything
 *     literally" — it disables that side of the filter. Both blank is a
 *     complete no-op, so a user who has never touched the row cannot be
 *     surprised by sales disappearing.
 *
 *   - MISSING IS EXCLUDED. Once a filter is active, a sale that has no
 *     value to test fails it. Passing unknowns through would quietly
 *     seed a size- or street-constrained comp set with rows that were
 *     never checked, which is the more dangerous direction for an
 *     appraisal. This mirrors the Manitoba app's semantics exactly.
 */

/**
 * Parse a range input into a finite non-negative bound, or null when the
 * input is blank / unparseable / negative. Null means "this side of the
 * range is off", never "zero".
 */
export function parseBound(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number.parseFloat(s.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Total land area for the sale a record belongs to, in square feet.
 *
 * Deliberately the SALE-GROUP sum, not the per-parcel figure. A sale that
 * bundles three lots is meaningfully a transaction of their combined
 * area, and a size range typed by an appraiser expresses interest in the
 * size of the DEAL. It is also the same denominator `$/Lot SF` uses in
 * lib/sales.js, so the filter and the column can never disagree about
 * how big a sale is.
 *
 * `complete` is false when any member of the group is missing its Land
 * Actual sqft. The sum is then an understatement — filtering on it would
 * pull a large assembly into a small-lot search — so callers treat an
 * incomplete group as untestable rather than as its partial total. Single
 * -parcel sales with no land figure come back {landSf: 0, complete: false}
 * for the same reason.
 *
 * @param {object} sale   a SaleRecord (needs .instrument and .landSf)
 * @param {Map<string, object[]>} groups  instrument -> group members
 */
export function saleGroupLandSf(sale, groups) {
  const members = groups?.get?.(sale?.instrument) || [sale];
  let total = 0;
  let complete = true;
  for (const m of members) {
    const sf = Number(m?.landSf);
    if (!Number.isFinite(sf) || sf <= 0) { complete = false; continue; }
    total += sf;
  }
  return { landSf: total, complete };
}

/**
 * Does this sale's group land area fall inside [lo, hi] square feet?
 * Either bound may be null (that side unbounded); both null is a no-op
 * that passes everything. An incomplete or zero group total fails
 * whenever the filter is active.
 */
export function passesSizeFilter(sale, groups, lo, hi) {
  if (lo == null && hi == null) return true;
  const { landSf, complete } = saleGroupLandSf(sale, groups);
  if (!complete || landSf <= 0) return false;
  if (lo != null && landSf < lo) return false;
  if (hi != null && landSf > hi) return false;
  return true;
}

/**
 * The address text a street filter is matched against: the sale's own
 * Street Number / Direction / Name from the CSV, upper-cased and
 * whitespace-collapsed.
 *
 * The CSV's fields rather than the joined record's `full_address` on
 * purpose. These are the same parts buildSaleFeatures composes into
 * full_address for a row with no live match, so the filter behaves
 * identically whether or not d4mq-wa44 knows the roll — and it can run
 * before the fetch. It also sidesteps the condo case, where the grid
 * shows only a unit address.
 */
export function saleAddressText(sale) {
  return [sale?.streetNumber, sale?.streetDirection, sale?.streetName]
    .filter((part) => part != null && String(part).trim() !== '')
    .join(' ')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a user-typed street query. Returns null when the query is
 * blank, i.e. the filter is off.
 */
export function normalizeStreetQuery(value) {
  if (value == null) return null;
  const s = String(value).toUpperCase().replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/**
 * Case-insensitive substring match of `query` against the sale's address
 * text. A blank query passes everything; a sale with no address text at
 * all fails an active query.
 *
 * Substring, not word-match, so "BANNER" finds BANNERMAN and a partial
 * recollection of a street name still lands — the same latitude the
 * Manitoba app gives.
 */
export function passesStreetFilter(sale, query) {
  if (query == null || query === '') return true;
  const text = saleAddressText(sale);
  if (text === '') return false;
  return text.includes(query);
}
