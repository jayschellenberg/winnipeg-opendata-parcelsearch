/*
 * Citywide Assessment Parcels styling per basemap family. Ported from the
 * Manitoba sister app's lib/muniParcelsStyle.js so the parcel fabric reads
 * the same in both tools (Jason, 2026-08-24).
 *
 * The fabric is supporting context, so it calibrates to what it sits on:
 * against the pale CARTO Positron streets a very light grey traces lot
 * lines without shouting; against aerial imagery (Esri satellite or a City
 * ortho year) the lines go WHITE — the classic cadastre-on-imagery
 * treatment, where any grey washes into the fields.
 *
 * The COLOURS are Manitoba's exactly. The width / opacity ZOOM RAMPS are
 * Winnipeg-only and deliberately not ported: Manitoba scopes its fabric to
 * one municipality and can afford flat values, whereas this archive serves
 * all ~245K parcels at once and a flat line is a citywide blackout below
 * z14 (see the note at the citywide-parcels-line layer in map.js). White
 * needs no extra width — it carries more visual weight than the grey it
 * replaces — so imagery reuses the same width ramp and only lifts opacity.
 *
 * Pure logic — kept out of map.js so node tests can exercise the
 * basemap→preset decision with a stub map (maplibre-gl itself can't load
 * outside a browser).
 */

// Shared by both presets: the low end is what keeps the archive usable at
// all. Tuned by eye in a browser at z11 / z14 / z16 against the real
// archive, not derived. Re-check visually if you change it.
const LINE_WIDTH_RAMP = [
  'interpolate', ['linear'], ['zoom'],
  8, 0.15,
  12, 0.3,
  14, 0.8,
  16, 1.5,
];

export const CITYWIDE_PARCELS_LINE_STYLES = {
  light: {
    // Tailwind gray-300. Lighter than the gray-500 (#6b7280) this layer
    // shipped with, matching Manitoba; the higher top-end opacity below
    // keeps the apparent weight about where it was on Positron.
    'line-color': '#d1d5db',
    'line-width': LINE_WIDTH_RAMP,
    'line-opacity': [
      'interpolate', ['linear'], ['zoom'],
      8, 0.12,
      11, 0.18,
      13, 0.45,
      15, 0.8,
    ],
  },
  imagery: {
    'line-color': '#ffffff',
    'line-width': LINE_WIDTH_RAMP,
    // Same ramp shape as light, lifted to Manitoba's 0.95 at the top —
    // imagery is busy ground and the lines need to survive it.
    'line-opacity': [
      'interpolate', ['linear'], ['zoom'],
      8, 0.15,
      11, 0.25,
      13, 0.6,
      15, 0.95,
    ],
  },
};

/**
 * Re-paint the citywide parcel fabric for whatever basemap is currently
 * visible. Reads layer visibility rather than taking a mode argument so
 * every basemap-switching path can call it without agreeing on state
 * names. Imagery = Esri satellite or any City ortho year showing.
 *
 * @param {object} map           MapLibre map (or a stub in tests).
 * @param {string[]} orthoLayerIds  Aerial-year layer ids (`ortho-<year>`);
 *   pass ORTHO_YEARS.map(...) from map.js. Empty is fine — the build ships
 *   inert when no ortho archives are configured.
 */
export function applyCitywideParcelsBasemapStyle(map, orthoLayerIds = []) {
  const showing = (id) =>
    map.getLayer(id) && map.getLayoutProperty(id, 'visibility') === 'visible';
  const imagery = showing('esri-imagery') || orthoLayerIds.some(showing);
  const style = CITYWIDE_PARCELS_LINE_STYLES[imagery ? 'imagery' : 'light'];
  if (!map.getLayer('citywide-parcels-line')) return;
  for (const [prop, value] of Object.entries(style)) {
    map.setPaintProperty('citywide-parcels-line', prop, value);
  }
}
