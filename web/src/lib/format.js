/*
 * Centralised number formatters. Phase 1 design-token decision:
 * Canadian English locale (en-CA) for thousands separators and decimal
 * marks, and one canonical shape per data type so the same value is
 * always rendered the same way no matter where it appears (table cell,
 * status bar, summary card, tooltip).
 *
 * Display contract (Phase 1):
 *   formatCurrency(150000)       -> "$150,000"
 *   formatAcres(12.4)            -> "12.4"
 *   formatAcresWithUnit(12.4)    -> "12.4 ac"
 *   formatSqFt(1234)             -> "1,234"
 *   formatSqFtFromAcres(0.5)     -> "21,780"  (0.5 * 43,560)
 *   formatSqFtWithUnit(1234)     -> "1,234 sf"
 *   formatPercent(0.95)          -> "95%"     (fraction input)
 *   formatPercent(95, {fraction:false}) -> "95%"  (whole-number input)
 *
 * Every formatter returns `null` for missing/non-finite/non-positive
 * input so callers can short-circuit with `?? '—'` or skip rendering
 * entirely. The table builder's td() helper already maps null to the
 * em-dash empty cell.
 *
 * Why en-CA: Canadian English convention. Identical thousands and
 * decimal characters to en-US for English, so existing strings keep
 * their familiar shape, with future date/currency edge cases handled
 * correctly without further refactor.
 */

const LOCALE = 'en-CA';

const CURRENCY_FORMATTER = new Intl.NumberFormat(LOCALE, {
  maximumFractionDigits: 0,
});

const SQFT_FORMATTER = new Intl.NumberFormat(LOCALE, {
  maximumFractionDigits: 0,
});

const ACRES_FORMATTER = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function toFiniteNumber(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Currency. `$150,000`, rounded to whole dollars. Returns null for
 *  missing/non-positive input so empty cells stay blank rather than
 *  rendering `$0`. */
export function formatCurrency(v) {
  const n = toFiniteNumber(v);
  if (n == null || n <= 0) return null;
  return '$' + CURRENCY_FORMATTER.format(Math.round(n));
}

/** Acres, one decimal, no unit suffix. Use for table cells under an
 *  "Acres" column header where the unit is implicit. */
export function formatAcres(v) {
  const n = toFiniteNumber(v);
  if (n == null || n <= 0) return null;
  return ACRES_FORMATTER.format(n);
}

/** Acres with explicit unit. Use for standalone display (summary
 *  cards, status messages, tooltips). */
export function formatAcresWithUnit(v) {
  const s = formatAcres(v);
  return s == null ? null : s + ' ac';
}

/** Square feet, integer with thousands separators. No unit suffix. */
export function formatSqFt(v) {
  const n = toFiniteNumber(v);
  if (n == null || n <= 0) return null;
  return SQFT_FORMATTER.format(Math.round(n));
}

/** Square feet derived from acres. Returns the integer SF string,
 *  no unit. */
export function formatSqFtFromAcres(acres) {
  const n = toFiniteNumber(acres);
  if (n == null || n <= 0) return null;
  return SQFT_FORMATTER.format(Math.round(n * 43560));
}

/** Square feet with explicit unit. */
export function formatSqFtWithUnit(v) {
  const s = formatSqFt(v);
  return s == null ? null : s + ' sf';
}

/**
 * Percent. Default input is a fraction (0.95 -> "95%"). Pass
 * `{ fraction: false }` for whole-number input (95 -> "95%").
 * `decimals` controls precision (default 0). Negative percentages
 * pass through; only non-finite / null input returns null.
 */
export function formatPercent(v, { fraction = true, decimals = 0 } = {}) {
  const n = toFiniteNumber(v);
  if (n == null) return null;
  const pct = fraction ? n * 100 : n;
  return pct.toFixed(decimals) + '%';
}
