// Assessment rate per dwelling unit — the "$/DU" grid column (Jason,
// 2026-10-07): total assessed value divided by the roll's dwelling-unit
// count, for screening multi-family and checking assessment equity across a
// neighbourhood without a spreadsheet.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app. Pure, so the arithmetic is unit-tested.

/**
 * Assessed value per dwelling unit, in whole dollars, or null when it has
 * no meaning: no assessment, or no dwelling units (vacant land, most
 * commercial — dividing by zero units would be a fabricated rate, and
 * dividing by an absent count a guess).
 *
 * Both inputs may arrive as strings ("$1,234,500", "4") straight from the
 * source rows; anything that is not a clean number reads as absent.
 */
export function assessmentPerDu(totalValue, dwellingUnits) {
  const total = toNumber(totalValue);
  const du = toNumber(dwellingUnits);
  if (total == null || du == null || !(du > 0) || !(total >= 0)) return null;
  return Math.round(total / du);
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
