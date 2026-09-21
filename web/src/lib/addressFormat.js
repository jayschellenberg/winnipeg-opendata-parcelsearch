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
 * For a Winnipeg unit address written as "610-1000 ALDGATE ROAD",
 * the building address it sits in ("1000 ALDGATE ROAD"). Null when the
 * key is not in that form.
 *
 * Safe to key off the dash because this dataset has no address RANGES:
 * of 4,000 sampled assessment addresses containing a dash, 3,998 are
 * exactly this unit form and the other 2 are the same form with a
 * space in the unit ("116 A-45 GILLSON STREET", "3RD FL-45 GILLSON
 * STREET") — hence the non-greedy left side, which lets the unit
 * contain spaces while the base must still start with a street number.
 */
export function unitPrefixBaseKey(key) {
  const m = String(key ?? '').match(/^(.+?)-(\d+\s+.+)$/);
  return m ? m[2].trim() : null;
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
 *
 * The reverse also collapses: on a condo unit's row the bare building
 * address is dropped, so "610-1000 ALDGATE ROAD, 1000 ALDGATE RD"
 * becomes just "610-1000 ALDGATE ROAD". The unit address already names
 * the building; repeating it adds nothing.
 *
 * The FIRST entry is never dropped. Callers put the parcel's own
 * address there, and no amount of cross-referenced civic data should be
 * able to remove a parcel's own address from its row.
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
  // Building addresses that some unit address already covers.
  const coveredByUnit = new Set(
    entries.map((e) => unitPrefixBaseKey(e.key)).filter(Boolean)
  );

  const seen = new Set();
  const out = [];
  for (const [i, e] of entries.entries()) {
    if (seen.has(e.key)) continue;
    if (i > 0) {
      const base = addressBaseKey(e.key);
      if (base !== e.key && baseKeys.has(base)) continue;  // redundant unit
      if (coveredByUnit.has(e.key)) continue;              // bare building address
    }
    seen.add(e.key);
    out.push(e.display);
  }
  return out;
}

/*
 * Collapsing a parcel's address points into one map label.
 *
 * A parcel that holds several civic addresses on the same street gets one
 * label point per address, and at lot scale they stack on top of each
 * other: 511 and 513 Selkirk sit a few metres apart and render as two
 * lines of text over one narrow lot. On an exhibit that reads as clutter,
 * and it is also not how the addresses are written down -- an appraiser
 * writes "511 & 513 Selkirk Ave".
 *
 * Grouping is by STREET, within one parcel. Two different streets on a
 * corner lot stay two labels, because they are two frontages and
 * collapsing them would assert something false.
 *
 * Pure -- no DOM, no network.
 */

/** Trailing unit designator on a street remainder ("ALDGATE RD UNIT 101"),
 *  matched on the display string rather than a normalized key. */
const RE_TRAILING_UNIT = /\s+(?:UNIT|APT|SUITE|STE)\s+\S+$/i;

/** Split "511 SELKIRK AVE" into its civic token and street remainder.
 *  Returns null when the string does not start with a civic number, which
 *  is how a legal-description-style entry ("DESC NE22-21-3E") opts out of
 *  grouping and stays exactly as written.
 *
 *  The civic token allows the shapes the address sources publish: a bare
 *  number, a letter suffix ("100A"), a half ("100 1/2") and the unit-
 *  prefix form ("610-1000"). The street remainder has any trailing unit
 *  designator removed, so every unit of a condo lands in one group
 *  instead of one group per unit. */
function splitCivic(display) {
  const m = String(display ?? '').trim()
    .match(/^((?:[^\s-]+-)?\d+(?:[A-Za-z]|\s?1\/2)?)\s+(.*\S)$/);
  if (!m) return null;
  const street = m[2].replace(RE_TRAILING_UNIT, '').trim();
  return street ? { civic: m[1], street } : null;
}

/** Sort key for a civic token: the number first, then what follows it, so
 *  100 < 100 1/2 < 100A < 100B < 101. A unit-prefix form ("610-1000")
 *  sorts on the BUILDING number, which is the part that names the street
 *  -- hence dropping the prefix before reading the LEADING digits, rather
 *  than reading digits off the end, which "100 1/2" would answer with 2.
 *
 *  The tiebreak is not cosmetic. "100" and "100 1/2" share a number, and
 *  without a deterministic order between them the label reads back in
 *  whatever order the address points happened to arrive. A half sorts at
 *  0.5 so it lands between the bare number (0) and an "A" suffix (1). */
function civicSortKey(civic) {
  const bare = String(civic ?? '').replace(/^[^\s-]+-/, '');
  const m = bare.match(/^(\d+)\s?(1\/2|[A-Za-z])?/);
  if (!m) return [Number.MAX_SAFE_INTEGER, 0];
  let rank = 0;
  if (m[2] === '1/2') rank = 0.5;
  else if (m[2]) rank = m[2].toUpperCase().charCodeAt(0) - 64;
  return [Number(m[1]), rank];
}

/** How many civic numbers are listed before the label switches to a
 *  low-high range. Three fits a lot's worth of addresses on one line;
 *  past that a strip mall's eight entries would be longer than the
 *  parcel they sit on. */
export const MAX_LISTED_CIVICS = 3;

/** Join civic tokens the way an appraiser writes them: "511 & 513",
 *  "511, 513 & 515", and past MAX_LISTED_CIVICS a "1100-1140" range.
 *
 *  The range is a summary of a set, NOT a claim that every number between
 *  the endpoints sits on the parcel -- the same reading a street-frontage
 *  description gets. Below the cap the numbers are listed individually
 *  precisely so the common cases never depend on that reading. */
function joinCivics(civics) {
  if (civics.length === 1) return civics[0];
  if (civics.length > MAX_LISTED_CIVICS) {
    return `${civics[0]}\u2013${civics[civics.length - 1]}`;
  }
  return `${civics.slice(0, -1).join(', ')} & ${civics[civics.length - 1]}`;
}

/**
 * Group one parcel's address strings by street, in first-appearance
 * order. `entries` is [{ display, ...anything }] and each returned group
 * keeps its members' original objects, so a caller can carry extra
 * fields (coordinates, for the map) through the grouping untouched.
 *
 * First-appearance order matters: callers put the parcel's OWN
 * assessment address first, and that street should stay the one a
 * reader sees first.
 *
 * An entry with no civic number to factor out is keyed on itself, so it
 * can never merge and comes back as a group of one.
 */
function buildStreetGroups(entries) {
  const groups = new Map();
  for (const e of entries || []) {
    const display = String(e?.display ?? '').trim();
    if (!display) continue;
    const parts = splitCivic(display);
    const key = parts
      ? `S:${normalizeAddressKey(parts.street)}`
      : `W:${normalizeAddressKey(display)}`;
    if (!groups.has(key)) groups.set(key, { street: parts?.street ?? null, items: [] });
    const g = groups.get(key);
    if (!g.street && parts?.street) g.street = parts.street;
    g.items.push({ ...e, display, civic: parts?.civic ?? null });
  }
  return [...groups.values()];
}

/** One group's display string. A group of one is returned UNCHANGED —
 *  unit designator, legal description and all — so this can never reword
 *  a lone address. Only a group that actually merges something gets a
 *  rewritten label. */
function groupLabel({ street, items }) {
  if (items.length === 1 || !street) return null;
  // Distinct civic numbers, ascending. Duplicates collapse here, which is
  // what folds a condo's per-unit entries (all one civic number, their
  // "Unit N" already stripped by splitCivic) to one building address.
  const seen = new Set();
  const civics = [];
  for (const i of [...items].sort((a, b) => {
    const [an, asfx] = civicSortKey(a.civic);
    const [bn, bsfx] = civicSortKey(b.civic);
    return an - bn || asfx - bsfx;
  })) {
    if (seen.has(i.civic)) continue;
    seen.add(i.civic);
    civics.push(i.civic);
  }
  return `${joinCivics(civics)} ${street}`;
}

/**
 * Collapse one parcel's address points into map labels, one per street.
 *
 * `points` is [{ display, lng, lat }]. Returns [{ label, lng, lat,
 * addresses }], where `addresses` is every display string folded into
 * that label so a caller can still show the full list on hover.
 *
 * The merged label sits at the MEAN of its group's points. For addresses
 * along one frontage that puts the text where the eye already expects a
 * single label -- between the two it replaces.
 *
 * Street identity runs through normalizeAddressKey, so "511 SELKIRK AVE"
 * and "513 SELKIRK AVENUE" group despite the two datasets' different
 * street-type spellings. The DISPLAY street comes from a point in the
 * group, never from the key: the key is uppercased and folded and is not
 * fit to show anyone.
 */
export function groupAddressesByStreet(points) {
  const usable = (points || []).filter(
    (pt) => Number.isFinite(pt?.lng) && Number.isFinite(pt?.lat)
  );
  const out = [];
  for (const group of buildStreetGroups(usable)) {
    const label = groupLabel(group);
    if (!label) {
      // A group of one, or an entry with no civic number: one label each,
      // at its own point, text untouched.
      for (const i of group.items) {
        out.push({ label: i.display, lng: i.lng, lat: i.lat, addresses: [i.display] });
      }
      continue;
    }
    out.push({
      label,
      lng: group.items.reduce((a, i) => a + i.lng, 0) / group.items.length,
      lat: group.items.reduce((a, i) => a + i.lat, 0) / group.items.length,
      addresses: group.items.map((i) => i.display),
    });
  }
  return out;
}

/**
 * Hover text for the Full Address cell, splitting the joined list into the
 * one address that can be searched and the ones that cannot.
 *
 * The cell reads "1347 BORDER STREET, 1361 BORDER ST, 1393 BORDER ST, …"
 * and every entry looks equally usable — but only the FIRST is the
 * assessment record's own address, and winnipegassessment.com indexes that
 * one alone. Typing any of the others into the City's search returns
 * nothing, which reads as "no such property" rather than "wrong spelling of
 * the right property".
 *
 * enrichAssessmentAddresses guarantees the parcel's own address is first;
 * this only labels what that ordering already means. Returns null when the
 * parcel has a single address and there is nothing to disambiguate.
 */
export function addressListTooltip(joined) {
  const parts = String(joined ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const [primary, ...others] = parts;
  return [
    `Assessment record: ${primary}`,
    '(the only one winnipegassessment.com will find)',
    '',
    `Also on this parcel (${others.length}):`,
    ...others,
  ].join('\n');
}

/*
 * Proper Case for display (Jason, 2026-09-16).
 *
 * Both address sources publish in CAPITALS — "1636 MCCREARY ROAD" — which
 * is how they are stored, matched and deduped above, and none of that
 * changes: normalizeAddressKey still uppercases, so casing can never
 * affect whether two entries are judged the same address. This is a
 * DISPLAY transform, applied at the point a cell, a popup or a tooltip is
 * built, and nothing downstream reads its output.
 *
 * Word by word rather than a blanket lower-then-capitalize, because four
 * kinds of token do not survive that treatment:
 *
 *   - directionals    "PORTAGE AVE E" must not become "Portage Ave e"
 *   - ordinals        "3RD ST" is "3rd St", not "3Rd St"
 *   - anything with a digit  civic numbers, unit numbers, "1000B" — left
 *                     exactly as written, because a unit label is an
 *                     identifier and not a word
 *   - Mc names        Winnipeg has McPhillips, McDermot, McGregor and
 *                     McCreary; "Mcphillips" is a misspelling of a street
 *                     name, not a casing choice
 *
 * A word that already carries a lowercase letter is left alone: it came
 * from a source that had already cased it, and second-guessing that would
 * turn a correct "McPhillips" back into "Mcphillips".
 */

/** Tokens that are abbreviations, not words, and stay in capitals. */
const KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'PTH', 'PR']);

function properCaseWord(word) {
  if (/[a-z]/.test(word)) return word;          // already cased by its source
  if (/^\d+(ST|ND|RD|TH)$/.test(word)) return word.toLowerCase();  // 3RD → 3rd
  if (/\d/.test(word)) return word;             // civic / unit / highway number
  if (KEEP_UPPER.has(word)) return word;
  if (/^MC[A-Z]{3,}$/.test(word)) return `Mc${word[2]}${word.slice(3).toLowerCase()}`;
  return word[0] + word.slice(1).toLowerCase();
}

/**
 * A civic address (or a comma-joined list of them) cased for reading.
 * Punctuation, separators and spacing are preserved exactly — only the
 * letters inside each word change.
 */
export function properCaseAddress(raw) {
  const s = String(raw ?? '');
  if (!s) return s;
  return s.replace(/[A-Za-z0-9'’]+/g, properCaseWord);
}
