// Multi-Family overlay — every assessment parcel with at least N dwelling
// units, shaded by unit count (Reference group; Jason, 2026-10-23).
//
// PORTED FROM mb-parcelsearch's Multi-Family overlay (lib/mfInventory.js):
// same 3+ definition of multi-family, same DU ≥ threshold, same blue unit
// ramp, so a 24-unit building reads the same colour in both apps. What
// differs is the data path. Manitoba ships a per-municipality shard because
// that is where its colony exclusion lives; Winnipeg already carries
// dwelling_unit_count on every polygon and label point of the citywide
// parcels archive (r/build_parcel_tiles.R), so this layer is a filter over
// tiles the app already streams — no fetch, no shard, whole city at once.
//
// CONDOMINIUMS ARE IN. A condo unit's polygon carries its whole building's
// count (lib_dwelling_units.R groups units by civic address), so a condo
// building paints at its building total, the same as a rental block. The
// count label for a condo comes from the one-per-building
// dwelling-condo-labels points, so it prints once, not once per unit.

export const MF_SOURCE = 'citywide-parcels';
export const MF_LAYERS = ['mf-fill', 'mf-outline', 'mf-label', 'mf-condo-label'];

/** The floor of "multi-family", matching Manitoba's MIN_DU. The user can
 *  raise the bar but not lower it: 1- and 2-unit parcels are not
 *  multi-family, and the ramp has no band for them. */
export const MF_MIN_DU = 3;

/** Unit bands — byte-for-byte Manitoba's UNITS_RAMP (lib/mfNewbuild.js). */
export const UNITS_RAMP = Object.freeze([
  { max: 5,   color: '#eff3ff', label: '3-5' },
  { max: 11,  color: '#c6dbef', label: '6-11' },
  { max: 23,  color: '#6baed6', label: '12-23' },
  { max: 49,  color: '#3182bd', label: '24-49' },
  { max: 99,  color: '#08519c', label: '50-99' },
  { max: Infinity, color: '#08306b', label: '100+' },
]);

const COUNT = ['to-number', ['get', 'dwelling_unit_count'], 0];

/** Sanitise the threshold input: unparseable or below the floor → the floor. */
export function clampMinDu(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return MF_MIN_DU;
  return Math.max(MF_MIN_DU, Math.min(9999, n));
}

/** MapLibre fill colour: a step over UNITS_RAMP. */
export function mfColorExpr() {
  const expr = ['step', COUNT, UNITS_RAMP[0].color];
  for (let i = 1; i < UNITS_RAMP.length; i++) expr.push(UNITS_RAMP[i - 1].max + 1, UNITS_RAMP[i].color);
  return expr;
}

/** Filter for the polygon layers and the condo label points. */
export function mfFilter(minDu) {
  return ['>=', COUNT, clampMinDu(minDu)];
}

/** Filter for parcels-labels: non-condo only, since condo units each carry a
 *  label point there and would print the building total once per unit. */
export function mfOrdinaryLabelFilter(minDu) {
  return ['all', ['==', ['get', 'dwelling_is_condo'], 0], mfFilter(minDu)];
}

/** Legend rows, dropping bands wholly below the threshold. */
export function mfLegendSteps(minDu) {
  const floor = clampMinDu(minDu);
  return UNITS_RAMP.filter((s) => s.max >= floor).map((s) => ({ color: s.color, label: s.label }));
}

const labelLayout = {
  visibility: 'none',
  'text-field': ['to-string', ['get', 'dwelling_unit_count']],
  'text-font': ['Open Sans Semibold'],
  'text-size': 11,
  'symbol-sort-key': ['-', 0, COUNT],
};
const labelPaint = { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 };

/** Add the four layers (hidden) over the citywide-parcels source. Labels
 *  start at z13, the archive's --base-zoom: below it label points thin. */
export function addMultiFamilyLayers(map, minDu = MF_MIN_DU, beforeId) {
  if (!map.getSource(MF_SOURCE) || map.getLayer('mf-fill')) return;
  map.addLayer({
    id: 'mf-fill', type: 'fill', source: MF_SOURCE, 'source-layer': 'parcels',
    filter: mfFilter(minDu),
    layout: { visibility: 'none' },
    paint: { 'fill-color': mfColorExpr(), 'fill-opacity': 0.75 },
  }, beforeId);
  map.addLayer({
    id: 'mf-outline', type: 'line', source: MF_SOURCE, 'source-layer': 'parcels',
    filter: mfFilter(minDu),
    layout: { visibility: 'none' },
    paint: { 'line-color': '#08306b', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 1.2] },
  }, beforeId);
  map.addLayer({
    id: 'mf-label', type: 'symbol', source: MF_SOURCE, 'source-layer': 'parcels-labels', minzoom: 13,
    filter: mfOrdinaryLabelFilter(minDu),
    layout: labelLayout, paint: labelPaint,
  }, beforeId);
  map.addLayer({
    id: 'mf-condo-label', type: 'symbol', source: MF_SOURCE, 'source-layer': 'dwelling-condo-labels', minzoom: 13,
    filter: mfFilter(minDu),
    layout: labelLayout, paint: labelPaint,
  }, beforeId);
}

export function setMultiFamilyVisible(map, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of MF_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
}

export function setMultiFamilyMinDu(map, minDu) {
  if (map.getLayer('mf-fill')) map.setFilter('mf-fill', mfFilter(minDu));
  if (map.getLayer('mf-outline')) map.setFilter('mf-outline', mfFilter(minDu));
  if (map.getLayer('mf-label')) map.setFilter('mf-label', mfOrdinaryLabelFilter(minDu));
  if (map.getLayer('mf-condo-label')) map.setFilter('mf-condo-label', mfFilter(minDu));
}
