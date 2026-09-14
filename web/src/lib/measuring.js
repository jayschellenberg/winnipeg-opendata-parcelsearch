/*
 * "A measurement is in progress" as one shared predicate (the Manitoba
 * app's lib/measuring.js).
 *
 * MeasureControl (map.js) stamps `measuring` on <body> while its panel is
 * open. For as long as it is set the measurement owns the pointer: every
 * click is placing a vertex, not asking a question of the map, so each
 * interaction handler — the hover popups and every click popup — has to
 * stand down or it answers a click that was never meant for it. MapLibre
 * dispatches a click to EVERY layer handler under the point independently,
 * with no propagation to stop, so the gate has to be in the handlers.
 *
 * Lives in lib/ rather than map.js so it can be unit-tested under node
 * without pulling in maplibre.
 */

/** The <body> class MeasureControl toggles. */
export const MEASURING_CLASS = 'measuring';

/** Open/close the flag. Call from both ends of the panel's lifecycle —
 *  a stuck `true` leaves the whole map inert to clicks. */
export function setMeasuring(on) {
  if (typeof document === 'undefined') return;
  document.body?.classList.toggle(MEASURING_CLASS, Boolean(on));
}

/** True while the measurement panel is open. */
export function isMeasuring() {
  if (typeof document === 'undefined') return false;
  return Boolean(document.body?.classList.contains(MEASURING_CLASS));
}
