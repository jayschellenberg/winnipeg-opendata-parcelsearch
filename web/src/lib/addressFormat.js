/*
 * Civic-address normalization for the Full Address column.
 *
 * A parcel's address list is built from two sources that spell the same
 * street differently:
 *
 *   d4mq-wa44 (assessment)  writes the street type in FULL:  "407 LYNDALE DRIVE"
 *   cam2-ii3u (addresses)   writes it ABBREVIATED:           "407 LYNDALE DR"
 *
 * enrichAssessmentAddresses used to dedupe on the exact string, so both
 * survived and the cell read "407 LYNDALE DRIVE, 407 LYNDALE DR" — the
 * same address twice.
 *
 * The civic dataset also appends unit designators ("1000 ALDGATE RD
 * Unit 101" … "Unit 501"). Because every unit's address point falls
 * inside the shared condo footprint, a single roll could otherwise
 * accumulate hundreds of entries that all say the same street address.
 *
 * The street-type table below is not guesswork: both datasets publish a
 * `street_type` column, and grouping each gives 38 non-null values that
 * correspond one-to-one (AVENUE/AVE 71254/73452, CRESCENT/CRES
 * 18576/18461, POINT/PT 442/355, GARDEN/GDN 18/17, FREEWAY/FWY 3/3 …).
 *
 * Pure — no DOM, no network.
 */

/** full spelling → the abbreviation both forms fold onto. */
const STREET_TYPES = {
  AVENUE: 'AVE',        STREET: 'ST',       DRIVE: 'DR',        ROAD: 'RD',
  CRESCENT: 'CRES',     BOULEVARD: 'BLVD',  PLACE: 'PL',        HIGHWAY: 'HWY',
  COURT: 'CRT',         POINT: 'PT',        PARK: 'PK',         CIRCLE: 'CIR',
  PARKWAY: 'PKY',       TERRACE: 'TERR',    PROMENADE: 'PROM',  CROSSING: 'CROSS',
  SQUARE: 'SQ',         GARDENS: 'GDNS',    GARDEN: 'GDN',      FREEWAY: 'FWY',
  // Types both datasets already spell identically (BAY, WAY, COVE,
  // LANE, TRAIL, GATE, ROW, CLOSE, PATH, GROVE, WALK, BEND, KEY,
  // RIDGE, COMMON, RUN, ALLEY, MEWS) need no entry — they fold onto
  // themselves.
};

/** Directional words, so "PORTAGE AVE EAST" and "PORTAGE AVE E" match. */
const DIRECTIONS = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };

const TOKEN_CANON = { ...STREET_TYPES, ...DIRECTIONS };

/**
 * Comparison key for an address. Uppercased, punctuation dropped,
 * whitespace collapsed, and every street-type / directional token
 * folded to one spelling. Display strings are never derived from this
 * — it exists only to decide whether two entries are the same address.
 */
export function normalizeAddressKey(raw) {
  const s = String(raw ?? '')
    .toUpperCase()
    .replace(/['’]/g, '')        // ST MARY'S == ST MARYS
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.split(' ').map((t) => TOKEN_CANON[t] || t).join(' ');
}

/** The key with any trailing unit designator removed. */
export function addressBaseKey(key) {
  return String(key ?? '').replace(/\s+(?:UNIT|APT|SUITE|STE)\s+\S+$/, '').trim();
}

/**
 * Collapse a parcel's address list to the distinct real addresses,
 * preserving input order — callers put the parcel's own (assessment)
 * address first, so its spelling is the one that survives.
 *
 * Two entries collapse when their normalized keys match. A
 * unit-suffixed entry is additionally dropped when the same address
 * WITHOUT the unit is present in the list: "1000 ALDGATE RD Unit 101"
 * adds nothing once "1000 ALDGATE RD" is there.
 *
 * A unit-suffixed entry whose base is NOT in the list is KEPT. Folding
 * it to the base would invent an address the sources never asserted,
 * and for a parcel that only ever appears as unit addresses that guess
 * would be the only thing shown.
 */
export function dedupeAddresses(list) {
  const entries = (list || [])
    .map((a) => String(a ?? '').trim())
    .filter(Boolean)
    .map((display) => ({ display, key: normalizeAddressKey(display) }))
    .filter((e) => e.key);

  // Addresses present in their own right (no unit designator). Built
  // over the WHOLE list first, so a base address appearing after its
  // units still suppresses them.
  const baseKeys = new Set(
    entries.filter((e) => addressBaseKey(e.key) === e.key).map((e) => e.key)
  );

  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.key)) continue;
    const base = addressBaseKey(e.key);
    if (base !== e.key && baseKeys.has(base)) continue;   // redundant unit
    seen.add(e.key);
    out.push(e.display);
  }
  return out;
}
