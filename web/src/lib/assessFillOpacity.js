/*
 * Fill opacity for the yellow assessment-result highlight
 * (map.js `assess-context-fill`), resolved from the overlays that need
 * the yellow out of their way.
 *
 * Two overlays paint OVER or UNDER the same result parcels and are
 * unreadable through a 30% yellow:
 *
 *   - Water Influence repaints the result polygons themselves in blues,
 *     so the yellow goes to 0 — but the layer stays VISIBLE, because it is
 *     the hit-test surface for the hover popup and the click-to-row
 *     handler, and visibility 'none' would kill both.
 *   - Zoning: Shaded sits UNDER the results. The district colours are
 *     pale (0.4 alpha over the basemap) and a 30% yellow on top swamps
 *     them into one mustard tone, so the highlight drops to a faint wash
 *     that still marks the subject parcels — the dashed yellow-and-black
 *     outline carries the selection on its own — while the zoning reads
 *     through. "Zoning: Labels" has no fill and gets the full highlight.
 *
 * Water wins when both are on: zero is zero.
 *
 * Pure — no map handle — so node tests can lock the numbers and the
 * precedence, and map.js only has to call it with its current state.
 */

/** Normal highlight: the Manitoba sister app's 30%, lifted to 50% while a
 *  multi-parcel sale is hovered (feature-state `groupHover`). */
export const ASSESS_FILL_BASE = 0.3;
export const ASSESS_FILL_HOVER = 0.5;

/** Under Zoning: Shaded. Tuned by eye against the palette in map.js —
 *  8% keeps a just-visible tint on the subject parcels without shifting
 *  the district colour beneath; hover still lifts so a group reads. */
export const ASSESS_FILL_DIMMED = 0.08;
export const ASSESS_FILL_DIMMED_HOVER = 0.2;

/**
 * The `fill-opacity` paint value for the current overlay state.
 *
 * @param {{ waterOn?: boolean, zoningShaded?: boolean }} [state]
 * @returns {number | Array} 0 while Water Influence is on; otherwise a
 *   `groupHover` feature-state expression at the normal or dimmed level.
 */
export function assessFillOpacity({ waterOn = false, zoningShaded = false } = {}) {
  if (waterOn) return 0;
  const [base, hover] = zoningShaded
    ? [ASSESS_FILL_DIMMED, ASSESS_FILL_DIMMED_HOVER]
    : [ASSESS_FILL_BASE, ASSESS_FILL_HOVER];
  return [
    'case',
    ['boolean', ['feature-state', 'groupHover'], false],
    hover,
    base,
  ];
}
