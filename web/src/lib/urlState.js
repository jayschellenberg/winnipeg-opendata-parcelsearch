/*
 * URL state encoding. Serializes a small, explicit set of form-state
 * keys into the browser's query string so a Winnipeg appraiser can
 * paste a session URL and the recipient lands on the same search,
 * overlay set, and sort order.
 *
 * Every parsed value runs through a validator that rejects
 * out-of-range / malformed input. Unknown query params are ignored.
 * Empty / default values aren't emitted so a fresh page load
 * produces a clean URL.
 *
 * The schema covers 25 keys:
 *   - 11 search inputs (lot, block, plan, desc, roll, addressFrom,
 *     addressTo, addressStreet, zoning, duMode, duMin)
 *   - 10 overlay toggles (survey, assess, allParcels, zoning,
 *     traffic, secondaryPlans, infill, mallsCorridors, contam,
 *     dimensions) — each a boolean
 *   - 2 sort (sortCol, sortDir)
 *   - 1 tab (property | sales) — Phase 7
 *   - 1 subjectRoll (the sales-tab subject parcel) — Phase 7 fu2
 *
 * Map center/zoom/basemap are deliberately NOT encoded (the locked
 * Phase 8 decision was to keep URLs compact).
 */

const STRING_MAX = 200;

function cleanString(v) {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > STRING_MAX) return undefined;
  return trimmed;
}

function cleanInt(min, max) {
  return (v) => {
    if (typeof v !== 'string') return undefined;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return undefined;
    if (n < min || n > max) return undefined;
    return n;
  };
}

function oneOf(allowed) {
  const set = new Set(allowed);
  return (v) => (typeof v === 'string' && set.has(v) ? v : undefined);
}

function cleanBool(v) {
  if (typeof v !== 'string') return undefined;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}

function formatBool(b) {
  if (b === true) return '1';
  if (b === false) return '0';
  return null;
}

// Known data-col keys on the results table. sortCol is restricted to
// this set so a malformed URL can't push junk into the sort handler.
const SORT_COLS = [
  // Base columns.
  'lot', 'block', 'plan', 'desc',
  'roll', 'address',
  'zoning', 'zoningPct', 'zoning2',
  'area', 'lat', 'lon',
  'value', 'walk', 'flood',
  // Phase 7 sales-mode columns.
  'saleDate', 'salePrice', 'pricePerSf', 'saleToAsmt',
  'dist', 'useCode', 'livingArea', 'yearBuilt',
  'instrument', 'propertyType', 'groupSize',
];

export const SCHEMA = {
  // --- Search inputs (11) ---
  lot:           { param: 'l',  validate: cleanString,            format: (v) => v },
  block:         { param: 'b',  validate: cleanString,            format: (v) => v },
  plan:          { param: 'p',  validate: cleanString,            format: (v) => v },
  desc:          { param: 'd',  validate: cleanString,            format: (v) => v },
  roll:          { param: 'r',  validate: cleanString,            format: (v) => v },
  addressFrom:   { param: 'af', validate: cleanString,            format: (v) => v },
  addressTo:     { param: 'at', validate: cleanString,            format: (v) => v },
  addressStreet: { param: 'as', validate: cleanString,            format: (v) => v },
  zoning:        { param: 'z',  validate: cleanString,            format: (v) => v },
  duMode:        { param: 'du', validate: oneOf(['zero', 'min']), format: (v) => v },
  duMin:         { param: 'dn', validate: cleanInt(1, 9999),      format: (v) => String(v) },

  // --- Overlay toggles (10) ---
  // Each is a boolean; the caller-side captureState() only emits a
  // toggle when its current value differs from the page default
  // (assess starts ON; everything else starts OFF). That keeps
  // default-state URLs clean.
  surveyToggle:         { param: 'sv', validate: cleanBool, format: formatBool },
  assessToggle:         { param: 'av', validate: cleanBool, format: formatBool },
  allParcelsToggle:     { param: 'ap', validate: cleanBool, format: formatBool },
  zoningToggle:         { param: 'zo', validate: cleanBool, format: formatBool },
  trafficToggle:        { param: 'tr', validate: cleanBool, format: formatBool },
  secondaryPlansToggle: { param: 'sp', validate: cleanBool, format: formatBool },
  infillToggle:         { param: 'if', validate: cleanBool, format: formatBool },
  mallsCorridorsToggle: { param: 'mc', validate: cleanBool, format: formatBool },
  contamToggle:         { param: 'cn', validate: cleanBool, format: formatBool },
  dimensionsToggle:     { param: 'dm', validate: cleanBool, format: formatBool },

  // --- Sort (2) ---
  sortCol: { param: 'sc', validate: oneOf(SORT_COLS),       format: (v) => v },
  sortDir: { param: 'sd', validate: oneOf(['asc', 'desc']), format: (v) => v },

  // --- Tab (1, Phase 7) ---
  // captureUrlState should only emit `tab` when it differs from the
  // page default ('property') so a fresh load keeps a clean URL.
  tab: { param: 't', validate: oneOf(['property', 'sales']), format: (v) => v },

  // --- Subject roll (1, Phase 7 follow-up 2) ---
  // The subject parcel against which loaded sales are compared
  // (powers the Dist km column + Sale/Asmt grouping). Plain string
  // so 10-digit and 11-digit forms both round-trip; main.js
  // normalizes via normalizeRoll() on read.
  subjectRoll: { param: 'sr', validate: cleanString, format: (v) => v },
};

const PARAM_TO_KEY = Object.fromEntries(
  Object.entries(SCHEMA).map(([key, def]) => [def.param, key])
);

/**
 * Encode a state object into a URL query string (no leading `?`).
 * Only keys present in SCHEMA with non-null format() output are
 * emitted; null/undefined/empty values are silently dropped so a
 * default state produces an empty string.
 */
export function encodeState(state) {
  if (!state || typeof state !== 'object') return '';
  const usp = new URLSearchParams();
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (!(key in state)) continue;
    const v = state[key];
    // Treat null/undefined/'' as "not set" so the caller can use
    // them as the sentinel for "use default" without a separate
    // delete path.
    if (v == null || v === '') continue;
    const formatted = def.format(v);
    if (formatted == null || formatted === '') continue;
    usp.set(def.param, formatted);
  }
  return usp.toString();
}

/**
 * Decode a URL query string into a state object. Accepts either
 * the leading-`?` form or the bare param string. Each parsed value
 * goes through its schema validator; failures are silently dropped
 * so a malformed URL never throws.
 */
export function decodeState(search) {
  const result = {};
  if (search == null) return result;
  const raw = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  if (!raw) return result;
  let usp;
  try { usp = new URLSearchParams(raw); }
  catch { return result; }
  for (const [param, value] of usp.entries()) {
    const key = PARAM_TO_KEY[param];
    if (!key) continue;
    const def = SCHEMA[key];
    const parsed = def.validate(value);
    if (parsed === undefined) continue;
    result[key] = parsed;
  }
  return result;
}
