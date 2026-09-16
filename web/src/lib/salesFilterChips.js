/**
 * Which "Additional filters" controls on the Sales Analysis tab are set.
 *
 * The disclosure is collapsed by default, so a filter set inside it can
 * drop comps with nothing on screen to say so (the Manitoba app's
 * lib/salesFilterChips.js, 2026-09-05). main.js snapshots the controls
 * into a plain object and this turns it into chips — one per control
 * that is away from its default — for the warning badge in the
 * disclosure's summary and the note on the count line above the table.
 *
 * Pure so it can be tested without a DOM. "Set" means the control is
 * away from its default; every chip here is also narrowing results right
 * now (Winnipeg has no idle-until-selected filters the way Manitoba's
 * Bldg Threshold is), so `active` is always true and kept only so the
 * shape matches the sister module.
 *
 * The snapshot's fields mirror the controls, top to bottom:
 *   priceLow, priceHigh        number inputs (strings from the DOM)
 *   sizeLow, sizeHigh          lot size in square feet
 *   streetName                 text input
 *   farFlungKm, farFlungExclude (boolean)
 *   n1 ('any'|'matched'|'unmatched')
 */

function text(v) {
  return v == null ? '' : String(v).trim();
}

/** A finite number from a DOM value, or null for blank / junk. */
function num(v) {
  const s = text(v);
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const money = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;
const sqft  = (n) => Math.round(n).toLocaleString('en-CA');

/** "10–20 sf", "≥ 10 sf", "≤ 20 sf", or '' when neither bound is set. */
export function rangeLabel(lo, hi, unit = '', fmt = String) {
  const u = unit ? ` ${unit}` : '';
  if (lo != null && hi != null) return `${fmt(lo)}–${fmt(hi)}${u}`;
  if (lo != null) return `≥ ${fmt(lo)}${u}`;
  if (hi != null) return `≤ ${fmt(hi)}${u}`;
  return '';
}

/**
 * One chip per Additional-filters control that is away from its default.
 * @returns {Array<{key: string, label: string, detail: string, active: boolean}>}
 */
export function salesFilterChips(s = {}) {
  const chips = [];
  const push = (key, label, detail) => chips.push({ key, label, detail, active: true });

  const priceLo = num(s.priceLow);
  const priceHi = num(s.priceHigh);
  if (priceLo != null || priceHi != null) {
    const range = rangeLabel(priceLo, priceHi, '', money);
    push('price', `Price ${range}`, `Total sale price ${range}; $0 / $1 nominal transfers are excluded while this is set`);
  }

  const sizeLo = num(s.sizeLow);
  const sizeHi = num(s.sizeHigh);
  if (sizeLo != null || sizeHi != null) {
    const range = rangeLabel(sizeLo, sizeHi, 'sf', sqft);
    push('size', `Lot size ${range}`, `Sale's total land area ${range}; a sale with no Land Actual sqft is excluded`);
  }

  const street = text(s.streetName);
  if (street) push('street', `Street ${street}`, `Property address contains "${street}"`);

  // Far-Flung marking removes nothing on its own — the tally beside the
  // filters already reports marking. Exclude is the state that drops
  // sales, so that is the one this names.
  const km = num(s.farFlungKm);
  if (s.farFlungExclude && km != null && km > 0) {
    push('farFlung', `Far-Flung > ${km} km excluded`,
      `Multi-parcel sales whose parcels lie more than ${km} km apart are removed`);
  }

  const n1 = text(s.n1);
  if (n1 === 'matched') push('n1', 'N1 matched', 'N1 crosswalk: matched sales only');
  else if (n1 === 'unmatched') push('n1', 'N1 unmatched', 'N1 crosswalk: unmatched sales only');

  // Year built and Bldg size are deliberately NOT chipped. This badge
  // exists to warn about filters the collapsed disclosure HIDES; those two
  // sit above it, in plain sight, and the count line already names each by
  // how many sales it removed. A chip for them would be a warning about
  // something visible, under a heading ("Additional filters") they are not
  // part of.

  return chips;
}

/** "Price ≥ $250,000 · Street MAIN" — the chips' labels, for the badge and the count line. */
export function salesFilterChipText(chips) {
  return (chips || []).map((c) => c.label).join(' · ');
}
