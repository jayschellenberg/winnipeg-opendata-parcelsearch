// Segmented pills backed by hidden checkboxes — the Manitoba sister app's
// lib/pillBinding.js, carried over with Winnipeg's own control set.
//
// The sidebar's on/off filters (Waterfront / Near water), the parcel-numbering
// pair, the far-flung Exclude and the Sales tab's nominal-transfer toggle were
// plain checkboxes. They are now segmented pills, but every handler behind
// them — the water SoQL filter, the numbering sort and callouts, the sales
// re-run, the URL-state writer — still reads the original
// <input type="checkbox"> elements. So the inputs stay in the DOM, hidden,
// and each pill is a VIEW of them: clicking a segment sets the backing inputs
// and fires `change` on the ones that flipped; any `change` on an input (user
// or programmatic) repaints the pill. One mode maps to one combination of
// checked states, and the tables below are the whole contract.
//
// Pure: no DOM here, so the mapping is unit-tested (test/pillBinding.test.js)
// and main.js only owns the wiring (bindBackedPill).

export const PILL_SPECS = {
  // Waterfront and Near water are OR'd with each other (both = any water
  // influence), so the pill has an explicit Both segment rather than
  // pretending the two are exclusive.
  water: {
    inputs: ['water-front', 'water-near'],
    modes: { off: [false, false], waterfront: [true, false], near: [false, true], any: [true, true] },
  },
  // Entry order only means anything while numbering is on, so it is the
  // third segment of one pill rather than a dependent checkbox. Winnipeg
  // numbers by roll number (Manitoba by municipality, then roll).
  numbering: {
    inputs: ['numbering-toggle', 'numbering-order-toggle'],
    modes: { off: [false, false], roll: [true, false], entry: [true, true] },
  },
  // Sales tab. The first mode is always the state the HTML ships with (its
  // default); its name follows the question the control asks rather than
  // "off". Nominal transfers are HIDDEN by default in Winnipeg (the box ships
  // checked), so Exclude is the default segment there.
  farflung: { inputs: ['far-flung-exclude'],   modes: { keep: [false], exclude: [true] } },
  nominal:  { inputs: ['sales-hide-sentinels'], modes: { exclude: [true], include: [false] } },
};

const same = (a, b) => a.length === b.length && a.every((v, i) => !!v === !!b[i]);

/** The mode whose checked pattern matches `checked` exactly; the first mode
 *  (the default) when nothing matches — e.g. numbering [false, true], an
 *  "entry order without numbering" state the UI never offers. */
export function modeFromChecked(spec, checked) {
  const names = Object.keys(spec.modes);
  return names.find((m) => same(spec.modes[m], checked)) || names[0];
}

/** Checked pattern for `mode`; an unknown mode reads as the first (default). */
export function checkedFromMode(spec, mode) {
  return spec.modes[mode] || spec.modes[Object.keys(spec.modes)[0]];
}
