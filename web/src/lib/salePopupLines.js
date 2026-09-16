/*
 * The building / sale lines of the parcel popup — the block that turns
 * "Assessment Parcel" into something an appraiser can read a comp off.
 *
 * Split out of map.js on purpose. map.js pulls in maplibre, turf and
 * mapbox-gl-draw and cannot be loaded under plain node, so anything
 * living there is untestable; these are string rules over a properties
 * bag, which is exactly the kind of thing that rots silently. Pure — no
 * DOM, no escaping, no HTML. The caller owns escaping and the <br> join.
 *
 * WHERE THE NUMBERS COME FROM. Every figure here is already computed
 * elsewhere and merely read:
 *
 *   year_built / total_living_area   the live assessment record
 *                                    (soda.js ASSESS_SELECT)
 *   _saleDate / _salePrice           the loaded sales CSV
 *   _pricePerBldgSf / _pricePerSf    lib/sales.js, the same fields the
 *   _pricePerAcre                    $/Bldg SF, $/Lot SF and $/Acre
 *                                    columns render
 *
 * Reading rather than recomputing is the point: a popup that divided the
 * price itself would be a second implementation of the group-sum rules
 * in lib/sales.js — the multi-parcel land totals, the vacant-group
 * guard, the assembly corrections — and the two would drift. If a figure
 * is withheld in the grid (a mixed sale's land rates, say), it is
 * withheld here for free.
 */

/**
 * Which price-per line belongs on a sale, keyed off the appraisal
 * CATEGORY rather than the use code.
 *
 * Land sells by the square foot and the acre; anything improved sells by
 * the building. Showing $/Bldg SF on a vacant lot is worse than showing
 * nothing — lib/sales.js declines to compute it there precisely so the
 * popup cannot report a confident, entirely fictional rate — and showing
 * $/Lot SF on a downtown office invites a comparison nobody makes.
 *
 * Category, not `isVacantUseCode`, because category is what the grid's
 * own Category column shows after the permit record has corrected it. A
 * vacant-coded lot that already had a finished house on it when it sold
 * reads Residential there, and it must read Residential here too.
 */
export function isLandCategory(category) {
  return String(category ?? '').trim() === 'Land';
}

/** "2,140 sf", or null when there is no usable figure. */
export function areaText(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n).toLocaleString('en-US')} sf`;
}

/**
 * A four-digit year, or null. Guards the sentinels the roll carries for
 * "unknown": 0 and blank both mean nobody recorded one, and a popup
 * reading "Year Built 0" is worse than a popup with no such line.
 */
export function yearText(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1700 || n > 2200) return null;
  return String(Math.trunc(n));
}

/**
 * The description-side lines: what is standing on the parcel. These come
 * off the assessment record, so they show on BOTH tabs — a parcel with
 * no loaded sale still has a year built and a living area, and they are
 * the two things most often wanted next to the size (Jason, 2026-09-16).
 *
 * @returns {Array<{label: string, value: string}>}
 */
export function buildingLines(p = {}) {
  const out = [];
  const year = yearText(p.year_built);
  if (year) out.push({ label: 'Year Built', value: year });
  const area = areaText(p.total_living_area);
  if (area) out.push({ label: 'Living Area', value: area });
  return out;
}

/**
 * The sale lines: what it changed hands for, and the rate that follows.
 * Empty when the parcel carries no loaded sale, which is every parcel on
 * the Property tab — the block simply does not appear rather than
 * appearing blank.
 *
 * `money` is injected (lib/cells.js owns formatDollars) to keep this file
 * free of anything that could pull in the DOM, and because formatDollars
 * already encodes the rule that 0 and negatives are not prices.
 *
 * @param {object} p        feature properties
 * @param {(v: any) => string|null} money
 * @returns {Array<{label: string, value: string}>}
 */
export function saleLines(p = {}, money = (v) => (v == null ? null : String(v))) {
  const out = [];
  const date = String(p._saleDate ?? '').trim();
  const price = money(p._salePrice);
  // The date is worth showing even with no price: a $0/$1 nominal
  // transfer is still a recorded conveyance, and its DATE is the thing
  // that tells you the roll changed hands at all.
  if (date) out.push({ label: 'Sale Date', value: date });
  if (price) out.push({ label: 'Sale Price', value: price });
  if (!date && !price) return out;

  if (isLandCategory(p._saleCategory)) {
    const perSf = money(p._pricePerSf);
    const perAc = money(p._pricePerAcre);
    if (perSf) out.push({ label: '$/Lot SF', value: perSf });
    if (perAc) out.push({ label: '$/Acre', value: perAc });
  } else {
    const perBldg = money(p._pricePerBldgSf);
    if (perBldg) out.push({ label: '$/Bldg SF', value: perBldg });
  }
  return out;
}
