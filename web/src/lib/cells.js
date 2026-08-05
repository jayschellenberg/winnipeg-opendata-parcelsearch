// Pure DOM-constructor + value-formatter helpers used by lib/columnsRegistry
// to render results-table cells. Extracted from main.js for Stage B so the
// registry can declare each column's `render(a, s) => Node` directly without
// dragging main.js's DOM-coupled imports into the Node-side test surface.
//
// These are PURE in two senses:
//   - No module-scope DOM access (only inside function bodies). The Node
//     test imports the registry without touching `document` at module init.
//   - No reach into main.js state. Pass in what you need.

import { assessmentUrl } from './links.js';

/** Default empty-cell content — keeps a single source of truth. */
const EMPTY = '—';        // em-dash

/**
 * Basic <td>. Empty / null values render as an em-dash with the `empty`
 * class. Optional className gets added to the td (typically 'num').
 */
export function td(value, className) {
  const el = document.createElement('td');
  if (value == null || value === '') {
    el.textContent = EMPTY;
    el.classList.add('empty');
  } else {
    el.textContent = value;
  }
  addClasses(el, className);
  return el;
}

/**
 * Add one or more space-separated classes. `classList.add` THROWS on a
 * multi-token string ("num sworn-mismatch"), which is easy to hit as
 * soon as a column composes a base class with a conditional modifier —
 * and it throws mid-render, taking the whole table down rather than
 * degrading to an unstyled cell.
 */
function addClasses(el, className) {
  if (!className) return;
  for (const c of String(className).trim().split(/\s+/)) {
    if (c) el.classList.add(c);
  }
}

/**
 * <td> wrapping a pill-style categorical badge.  badgeClass is the
 * modifier (e.g. 'badge-zoning'); a base 'badge' class is added.
 * extraTdClass lets the caller add a num / left-align class to the td.
 */
export function badgeTd(value, badgeClass, extraTdClass) {
  const el = document.createElement('td');
  addClasses(el, extraTdClass);
  if (value == null || value === '') {
    el.textContent = EMPTY;
    el.classList.add('empty');
    return el;
  }
  const span = document.createElement('span');
  span.className = `badge ${badgeClass}`;
  span.textContent = String(value);
  el.appendChild(span);
  return el;
}

/**
 * Map a Property Type string to the matching badge-pt-* CSS modifier.
 * Unknown values fall back to the base pill (no colour family).
 */
/**
 * The colour-family modifier for a Property Type, with no base class.
 * Split out so a second badge can borrow the same colour: the PUCS badge
 * is tinted by its row's property type, so PUCS and Property Type read
 * as one green/amber/blue signal per row rather than a coloured chip
 * beside a permanently grey one.
 */
export function propertyTypeBadgeModifier(value) {
  if (!value) return '';
  const v = String(value).trim().toLowerCase();
  if (v === 'residential') return 'badge-pt-residential';
  if (v === 'industrial')  return 'badge-pt-industrial';
  if (v === 'commercial')  return 'badge-pt-commercial';
  return '';
}

export function propertyTypeBadgeClass(value) {
  const mod = propertyTypeBadgeModifier(value);
  return mod ? `badge-property-type ${mod}` : 'badge-property-type';
}

/** The PUCS badge's classes: its own base plus the row's property-type
 *  colour, so the two chips agree. Falls back to plain slate when the
 *  row has no property type (a property search, or a blank CSV cell). */
export function pucsBadgeClass(propertyType) {
  const mod = propertyTypeBadgeModifier(propertyType);
  return mod ? `badge-pucs ${mod}` : 'badge-pucs';
}

/**
 * <td> that truncates long values to maxChars with an ellipsis and shows
 * the full string on hover. Used for multi-lot merges and multi-address
 * parcels. Cursor changes to `help` so the truncation is discoverable.
 */
export function truncatedTd(value, maxChars, className) {
  const el = document.createElement('td');
  if (value == null || value === '') {
    el.textContent = EMPTY;
    el.classList.add('empty');
    return el;
  }
  const str = String(value);
  if (str.length > maxChars) {
    el.textContent = str.slice(0, maxChars) + '…';
    el.title = str;
    el.style.cursor = 'help';
  } else {
    el.textContent = str;
  }
  addClasses(el, className);
  return el;
}

/**
 * <td> containing an external link. Falls back to an em-dash when no URL
 * can be built. Click is stopPropagation'd so the row's click-to-fly
 * handler doesn't also fire.
 */
export function linkTd(url, label) {
  const el = document.createElement('td');
  if (!url) {
    el.textContent = EMPTY;
    el.classList.add('empty');
    return el;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  a.addEventListener('click', (e) => e.stopPropagation());
  el.appendChild(a);
  return el;
}

/**
 * The Assessment column's <td>: a clickable dollar total linking to the
 * parcel's record on winnipegassessment.com. Plain dollars when no link
 * can be built; em-dash when even the dollar amount is missing.
 */
export function assessmentTd(props) {
  const el = document.createElement('td');
  el.classList.add('num');
  const formatted = formatDollars(props?.total_assessed_value);
  if (!formatted) {
    el.textContent = EMPTY;
    el.classList.add('empty');
    return el;
  }
  const url = assessmentUrl(props);
  if (!url) {
    el.textContent = formatted;
    return el;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = formatted;
  a.title = `Open Roll ${props.roll_number} on winnipegassessment.com`;
  a.addEventListener('click', (e) => e.stopPropagation());
  el.appendChild(a);
  return el;
}

/** "$723,000". null on bad input. */
export function formatDollars(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return '$' + Math.round(n).toLocaleString('en-US');
}

/**
 * Area-weighted-zoning coverage % for the table cell. Whole-percent
 * precision keeps the column narrow; sub-1% values are suppressed
 * (those are digitization slivers, not real coverage).
 */
export function formatPct(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return `${Math.round(n)}%`;
}

/**
 * "Zoning 2" cell text. Combines code + % so the user can see both at a
 * glance without an extra column dedicated to the secondary %. Returns
 * null when there's no top-2.
 */
export function formatZone2(code, pct) {
  if (!code) return null;
  if (pct == null) return code;
  return `${code} (${Math.round(pct)}%)`;
}

/** 6-decimal lat/lon (~10 cm at Winnipeg latitude). null on bad input. */
export function formatCoord(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(6);
}

/** Distance in km, 2 decimals. Used by the sales-mode Dist column. */
export function formatDist(km) {
  if (km == null) return null;
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

/**
 * Strip the verbose suffix off d4mq-wa44 zoning text.  Fallback values
 * like "R1M - RES - S F - MEDIUM" reduce to "R1M"; clean dxrp-w6re top-1
 * codes ("R1-M", "C2", "PR1") pass through unchanged.
 */
export function stripZoningCode(value) {
  if (value == null || value === '') return value;
  return String(value).split(' - ')[0].trim();
}
