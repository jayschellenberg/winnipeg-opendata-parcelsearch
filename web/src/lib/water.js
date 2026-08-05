/*
 * Water influence — waterfront / near-water classification for Winnipeg.
 *
 * Unlike the Manitoba sister app, which computes this in an R pipeline
 * and ships pre-baked verdicts as JSON shards, Winnipeg's own
 * assessment records already carry the answer. d4mq-wa44's
 * `property_influences` is a comma-separated multi-value field whose 45
 * tokens include 16 water ones, covering 7,520 of 245,248 parcels:
 *
 *   RED RIVER ADJACENT / INFLUENCE          ASSINIBOINE ADJACENT / INFLUENCE
 *   SEINE RIVER ADJACENT / INFLUENCE        LASALLE RIVER ADJACENT / INFLUENCE
 *   STURGEON CREEK ADJACENT / INFLUENCE     BUNNS CREEK ADJACENT / INFLUENCE
 *   OMANDS CREEK ADJACENT / INFLUENCE       RETENTION POND ADJACENT / INFLUENCE
 *
 * THE ADJACENT/INFLUENCE SPLIT IS THE WHOLE POINT, and it is the City's
 * assessors' own judgement rather than ours. Lyndale Drive is the
 * proof: 24 parcels RED RIVER ADJACENT (the river-side lots) against
 * ~66 RED RIVER INFLUENCE (the lots across the road), and the
 * "PARK,RED RIVER INFLUENCE" combination shows they have already
 * adjudicated the riverbank-parkland case. A lot fronting the Red River
 * and a lot across the road from it are both "near water" and are NOT
 * comparable, so this must never be collapsed into a Yes/No flag.
 *
 * WHAT THIS FIELD CANNOT TELL YOU, and the UI should not pretend
 * otherwise:
 *   - No measured distance. Manitoba ships WaterDistanceFt precisely as
 *     the safety valve for a threshold that may be wrong; here there is
 *     no number, only the verdict.
 *   - ADJACENT does not separate "boundary touches the water" from
 *     "close enough to front it", and INFLUENCE does not say WHY there
 *     is no frontage (a road, another parcel, or parkland).
 *   - Truro Creek is flagged on zero parcels though the City's own
 *     By-law 5888/92 corridors cover it.
 *   - 127,570 parcels (52%) carry no influences at all. Absence is an
 *     assessor's silence, not proof that there is no water nearby —
 *     hence the three states below.
 *
 * THREE STATES, kept distinct (same contract as the Manitoba app):
 *   `_waterLoaded` falsy      -> unknown; render blank, never "No water"
 *   loaded + a water token    -> classified
 *   loaded + no water token   -> "No water noted" (checked, none found)
 * The loaded flag is load-bearing because Socrata OMITS null fields
 * entirely: a parcel with no influences comes back with no
 * property_influences key at all, indistinguishable from a query that
 * never asked for it. soda.js stamps `_waterLoaded` on every record it
 * fetches with the field in its $select, which is what makes "we
 * checked and there is none" sayable at all.
 *
 * Pure — no DOM, no network — and the single source of truth for class
 * order, labels and colours, shared by the grid and the map so the two
 * cannot drift.
 */

// ONE BLUE RAMP, DARK = STRONGEST INFLUENCE. Frontage takes the dark
// end. Two classes rather than Manitoba's six because the source makes
// exactly one distinction; inventing gradations it does not support
// would be fiction.
export const WATER_CLASSES = [
  { key: 'Adjacent',  label: 'Water adjacent',  short: 'Adjacent',  color: '#0a4a94', frontage: true  },
  { key: 'Influence', label: 'Water influence', short: 'Influence', color: '#8fc0ea', frontage: false },
];

const BY_KEY = new Map(WATER_CLASSES.map((c) => [c.key, c]));

/**
 * The water bodies the assessment vocabulary names. Order is the
 * tie-break when a parcel carries more than one water token: named
 * watercourses outrank retention ponds, because a lot on the Red River
 * with a pond behind it is a river lot.
 *
 * `token` is the exact prefix as it appears in property_influences.
 */
export const WATER_BODIES = [
  { token: 'RED RIVER',      label: 'Red River',         type: 'River' },
  { token: 'ASSINIBOINE',    label: 'Assiniboine River', type: 'River' },
  { token: 'SEINE RIVER',    label: 'Seine River',       type: 'River' },
  { token: 'LASALLE RIVER',  label: 'La Salle River',    type: 'River' },
  { token: 'STURGEON CREEK', label: 'Sturgeon Creek',    type: 'Creek' },
  { token: 'BUNNS CREEK',    label: "Bunn's Creek",      type: 'Creek' },
  { token: 'OMANDS CREEK',   label: "Omand's Creek",     type: 'Creek' },
  { token: 'RETENTION POND', label: 'Retention pond',    type: 'Retention pond' },
];

const SUFFIXES = [
  { suffix: ' ADJACENT',  classKey: 'Adjacent'  },
  { suffix: ' INFLUENCE', classKey: 'Influence' },
];

/**
 * Every water token, exact strings, for building a server-side filter.
 * Matching has to be on the FULL token: 'COMMERCIAL ADJACENT' and
 * 'COMMERCIAL INFLUENCE' are real values in the same field, so a
 * substring test for 'ADJACENT' would drag commercial parcels into a
 * waterfront search.
 */
export function waterTokens(frontageOnly = null) {
  const out = [];
  for (const { suffix, classKey } of SUFFIXES) {
    const wantsFrontage = classKey === 'Adjacent';
    if (frontageOnly === true && !wantsFrontage) continue;
    if (frontageOnly === false && wantsFrontage) continue;
    for (const b of WATER_BODIES) out.push(`${b.token}${suffix}`);
  }
  return out;
}

/**
 * Parse a raw `property_influences` string into a water descriptor, or
 * null when it names no water.
 *
 * Returns { classKey, label, body, type, token, frontage }. When a
 * parcel carries several water tokens — a riverfront lot that also
 * backs a pond — frontage wins, then WATER_BODIES order. Non-water
 * tokens (BUS ROUTE, COMMERCIAL ADJACENT, PARK …) are ignored.
 */
export function parseWaterInfluence(raw) {
  const text = String(raw ?? '').toUpperCase();
  if (!text) return null;
  let best = null;
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;
    for (const { suffix, classKey } of SUFFIXES) {
      if (!token.endsWith(suffix)) continue;
      const prefix = token.slice(0, -suffix.length).trim();
      const bodyIdx = WATER_BODIES.findIndex((b) => b.token === prefix);
      if (bodyIdx < 0) continue;      // e.g. COMMERCIAL ADJACENT
      const body = WATER_BODIES[bodyIdx];
      const cls = BY_KEY.get(classKey);
      const cand = {
        classKey,
        label: cls.label,
        body: body.label,
        type: body.type,
        token,
        frontage: cls.frontage,
        _rank: (cls.frontage ? 0 : 1) * 100 + bodyIdx,
      };
      if (!best || cand._rank < best._rank) best = cand;
    }
  }
  if (!best) return null;
  delete best._rank;
  return best;
}

/** Descriptor straight off an assessment properties object. */
export function waterOf(props) {
  return parseWaterInfluence(props?.property_influences);
}

/** True once the record came from a query that asked for the field —
 *  see the three-state note in the header. */
export function waterLoaded(props) {
  return !!props?._waterLoaded;
}

/** Class descriptor for a parsed water object, or null. */
export function waterClass(w) {
  return w ? BY_KEY.get(w.classKey) || null : null;
}

/** Has actual frontage on the water (the assessors' ADJACENT). */
export function isWaterfront(w) {
  return !!waterClass(w)?.frontage;
}

/** Near water but WITHOUT frontage — the second-row cohort. */
export function isNearWater(w) {
  const c = waterClass(w);
  return !!(c && !c.frontage);
}

/** Map/grid colour, or null. */
export function waterColor(w) {
  return waterClass(w)?.color || null;
}

/**
 * Grid cell text. Leads with the water body — that is what an appraiser
 * reads — and appends "· near" for the no-frontage cohort so the cell
 * alone distinguishes a river lot from one across the road, without
 * relying on the colour dot.
 */
export function waterCellText(w) {
  if (!w) return '';
  return w.frontage ? w.body : `${w.body} · near`;
}

/** Hover detail. Ends on the caveat, because the verdict is an
 *  assessor's judgement with no distance behind it. */
export function waterTooltip(w) {
  if (!w) return '';
  const out = [waterClass(w).label];
  out.push(`Water body: ${w.body}`);
  if (w.type && w.type !== w.body) out.push(`Type: ${w.type}`);
  out.push(w.frontage
    ? 'Assessed as adjacent to the water — frontage.'
    : 'Near water but assessed WITHOUT frontage — a road, parkland or another parcel lies between.');
  out.push(`Source: City assessment "${w.token}". A screening aid — an assessor's classification, with no measured distance behind it.`);
  return out.join('\n');
}

/**
 * Sort key: frontage first, then water body, then unclassified. Rows we
 * simply have no data for sort last so a Water sort never mixes
 * "checked, none" with "never checked".
 */
export function waterSortRank(w, loaded) {
  if (w) {
    const bodyIdx = WATER_BODIES.findIndex((b) => b.label === w.body);
    return (w.frontage ? 0 : 1) * 100 + (bodyIdx < 0 ? 99 : bodyIdx);
  }
  return loaded ? 900 : 999;
}

/**
 * CSV cells: Water / Water Class / Water Body / Water Type — bare
 * values, one fact per column, so a spreadsheet can pivot on them.
 *
 * The three states again, and the difference still matters: not loaded
 * is blank throughout, because "No water" there would be a confident
 * lie about a check we never ran.
 */
export function waterCsvCells(w, loaded) {
  if (!w) return loaded ? ['No water noted', '', '', ''] : ['', '', '', ''];
  return [w.frontage ? 'Yes' : 'No', waterClass(w).label, w.body, w.type];
}
