/*
 * Colours for sale categories on the map.
 *
 * WHY FIVE AND NOT TWELVE. A map is an ALL-PAIRS case: any two categories
 * can end up side by side, so every pair of colours has to be separable,
 * not just neighbours in a legend. Twelve colours is 66 pairs; five is
 * ten. Every colour must also sit inside a lightness band (so it reads
 * against the basemap) and above a chroma floor (so it does not look
 * grey), which bounds the volume of colour space available — and packing
 * points into that volume at minimum separation runs out at five.
 *
 * Measured, not guessed, with the dataviz skill's validator
 * (`validate_palette.js --mode light --pairs all`):
 *
 *   13 colours  normal-vision ΔE 7.1 (red↔orange)     HARD FAIL
 *    6 colours  normal-vision ΔE 14.4 (brown↔orange)  HARD FAIL
 *    5 colours  normal-vision ΔE 18+, contrast pass,
 *               CVD ΔE 7.7 worst pair                 PASS
 *
 * The floor is 15 for normal vision; below it, full-colour readers cannot
 * separate the pair. CVD in the 6–8 band is permitted only WITH secondary
 * encoding, which this has: the hover popup names the category and the
 * exact Par Use Code, and the legend lists every colour in use.
 *
 * GREEN IS ABSENT ON PURPOSE. It reads well for Land, and it was the
 * first hue tried, but it crowds teal, brown and orange: every failing
 * pair at six colours involved green. Dropping it is what bought the
 * fifth slot.
 *
 * Pure — no DOM, no MapLibre.
 */

/** Slot order is fixed and never cycled. A sixth category is not a
 *  generated hue; it takes OTHER_COLOR. */
export const CATEGORY_COLORS = Object.freeze([
  '#2a78d6',  // blue
  '#eb6834',  // orange
  '#4a3aa7',  // violet
  '#0d9488',  // teal
  '#be185d',  // magenta
]);

/** Everything past the fifth slot, and every category on a map that has
 *  no slot. Deliberately chromaless: it should read as "not one of the
 *  ones you picked" rather than as a sixth choice. */
export const OTHER_COLOR = '#8c8c8c';

/** The colour for a slot index, or OTHER_COLOR for null / out of range. */
export function colorForSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= CATEGORY_COLORS.length) return OTHER_COLOR;
  return CATEGORY_COLORS[slot];
}

/**
 * Which colour slot each category gets, given what is on screen now and
 * what it had last time.
 *
 * STICKY, and that is the whole point. "Colour follows the entity, never
 * its rank" — a filter that changes the category count must not repaint
 * the survivors. If ticking a sixth category re-dealt the other five,
 * every colour on the map would mean something different from one moment
 * to the next, and a map you have to re-read after every click is worse
 * than one with no colour at all.
 *
 * So a category keeps its slot for as long as it is present. Slots are
 * freed only by a category leaving, and a freed slot goes to the
 * first-listed category that does not have one — which is the direction
 * that only ever improves things: a category previously sharing the grey
 * can gain a colour, but nothing already coloured loses or swaps one.
 *
 * @param {string[]} present  categories on screen, in a stable order
 *   (PUCS_CATEGORY_ORDER, so the assignment is reproducible run to run)
 * @param {Map<string, number>} previous  the last assignment
 * @returns {Map<string, number|null>}  null = OTHER_COLOR
 */
export function assignCategoryColors(present, previous) {
  const out = new Map();
  const used = new Set();
  // Defaulted here rather than in the signature: a caller passing an
  // explicit null ("no previous assignment yet") would skip a default
  // parameter and reach the loops as null.
  const list = Array.isArray(present) ? present : [];
  const prior = previous instanceof Map ? previous : new Map();

  // Pass 1: everything that already had a slot keeps it.
  for (const cat of list) {
    const slot = prior.get(cat);
    if (!Number.isInteger(slot) || slot < 0 || slot >= CATEGORY_COLORS.length) continue;
    if (used.has(slot)) continue;   // two categories cannot share a slot
    out.set(cat, slot);
    used.add(slot);
  }

  // Pass 2: the rest take the lowest free slot, in the order given.
  let next = 0;
  for (const cat of list) {
    if (out.has(cat)) continue;
    while (next < CATEGORY_COLORS.length && used.has(next)) next += 1;
    if (next >= CATEGORY_COLORS.length) { out.set(cat, null); continue; }
    out.set(cat, next);
    used.add(next);
  }
  return out;
}

/**
 * The legend rows for an assignment: every category on screen, coloured
 * ones first in slot order, then whatever shares the grey.
 *
 * Grey is collapsed to ONE row naming the categories in it rather than a
 * row each, because five identical swatches reading Office / Industrial /
 * Hospitality is a legend that looks like it is distinguishing them.
 *
 * @returns {Array<{label: string, color: string, other: boolean}>}
 */
export function legendRows(assignment) {
  const coloured = [...(assignment || new Map())]
    .filter(([, slot]) => Number.isInteger(slot))
    .sort((a, b) => a[1] - b[1])
    .map(([cat, slot]) => ({ label: cat, color: colorForSlot(slot), other: false }));
  const grey = [...(assignment || new Map())]
    .filter(([, slot]) => !Number.isInteger(slot))
    .map(([cat]) => cat);
  if (grey.length) {
    coloured.push({
      label: grey.length === 1 ? grey[0] : `Other (${grey.join(', ')})`,
      color: OTHER_COLOR,
      other: true,
    });
  }
  return coloured;
}
