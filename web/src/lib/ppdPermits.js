/*
 * Permits at an address — the City's PP&D permit portal, cross-referenced
 * with the open-data Detailed Building Permit table.
 *
 * THREE SOURCES, ONE ADDRESS.
 *   1. PPD property permit search  (ppdportal.winnipeg.ca/Permits/
 *      PropertyPermitSearch) — building AND trade permits (electrical,
 *      plumbing, mechanical) since 2000, development permits since
 *      Nov 2022. The only one with a free-text DESCRIPTION.
 *   2. PPD occupancy permit search (…/OccupancyPermitSearch) — occupancy
 *      permits since Dec 1998: use, major group, occupant load, expiry.
 *   3. Open data it4w-cpf4 — building permits since 2010 with the
 *      classification the portal hides: permit group/type/sub type, work
 *      type, applicant business, dwelling units created/lost, received
 *      and final dates, major-project flag.
 *
 * JOIN. it4w-cpf4's permit_number is the portal's Number verbatim
 * ("26-170012 SP"), so building permits join on it exactly. Trade permits
 * and anything before 2010 are portal-only; it4w rows the portal leaves
 * out — the portal drops demolition of a whole primary structure, which
 * it files against the PREVIOUS property record — are kept as open-data-
 * only rows, because a teardown is the permit an appraiser most needs to
 * see. Occupancy permits carry their own numbering ("26 136235 OC") and
 * no shared key, but the City copies the building permit's description
 * onto the occupancy permit, so an exact description match names the
 * building permit it closed out.
 *
 * The portal is server-rendered JSP with no API and no CORS. The browser
 * reaches it through the same-origin /proxy/ppd/ rewrite (vercel.json,
 * vite.config.js); this module parses the HTML it returns. Regex rather
 * than DOMParser so the parser runs under the plain-Node test runner —
 * the markup is a fixed, machine-generated table, and every value is
 * reduced to text (tags stripped, entities decoded) before it leaves
 * here, so nothing from the portal is ever inserted as HTML.
 *
 * Pure — no DOM, no network.
 */

/** Street types the portal's <select> offers (its exact option values). */
export const PPD_STREET_TYPES = new Set([
  'ALLEY', 'AVE', 'BAY', 'BEND', 'BLVD', 'CIR', 'CLOSE', 'CMN', 'COVE', 'CRES',
  'CROSS', 'CRT', 'DR', 'FWY', 'GATE', 'GDN', 'GDNS', 'GRN', 'GROVE', 'HILL',
  'HOLLOW', 'HWY', 'KEY', 'LANE', 'MEWS', 'PASS', 'PATH', 'PK', 'PKY', 'PL',
  'PROM', 'PT', 'RD', 'RIDGE', 'ROW', 'RUN', 'SQ', 'ST', 'TERR', 'TRAIL',
  'VISTA', 'WALK', 'WAY',
]);

/** Assessment-roll spellings → the portal's abbreviation. */
const TYPE_ALIASES = {
  AVENUE: 'AVE', STREET: 'ST', DRIVE: 'DR', ROAD: 'RD', CRESCENT: 'CRES',
  BOULEVARD: 'BLVD', PLACE: 'PL', HIGHWAY: 'HWY', COURT: 'CRT', POINT: 'PT',
  PARK: 'PK', CIRCLE: 'CIR', PARKWAY: 'PKY', TERRACE: 'TERR', PROMENADE: 'PROM',
  CROSSING: 'CROSS', SQUARE: 'SQ', GARDENS: 'GDNS', GARDEN: 'GDN', FREEWAY: 'FWY',
  COMMON: 'CMN', GREEN: 'GRN',
};

const DIRECTIONS = { N: 'N', S: 'S', E: 'E', W: 'W', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };

function canonType(t) {
  const u = String(t ?? '').toUpperCase().replace(/\./g, '').trim();
  if (!u) return '';
  const v = TYPE_ALIASES[u] || u;
  return PPD_STREET_TYPES.has(v) ? v : '';
}

function canonDirection(d) {
  return DIRECTIONS[String(d ?? '').toUpperCase().replace(/\./g, '').trim()] || '';
}

/**
 * Split an assessment-roll civic address into the portal's search fields.
 *   "300 PORTAGE AVENUE"        → { number:'300', name:'PORTAGE', type:'AVE' }
 *   "001-817 ST MARY'S ROAD"    → { unit:'001', number:'817', name:"ST MARY'S", type:'RD' }
 *   "1 PORTAGE AVENUE EAST"     → { …, direction:'E' }
 *   "123A MAIN STREET"          → { number:'123', suffix:'A', … }
 * Only the first address of a comma-joined list is used. Null when there
 * is no leading civic number — the portal rejects a nameless search, and
 * a numberless one returns a whole street.
 */
export function parseCivicAddress(raw) {
  const first = String(raw ?? '').split(',')[0].toUpperCase().replace(/\s+/g, ' ').trim();
  if (!first) return null;
  const m = first.match(/^(?:([0-9A-Z]+)\s*-\s*)?(\d+)([A-Z])?\s+(.+)$/);
  if (!m) return null;
  const [, unit = '', number, suffix = '', rest] = m;
  const tokens = rest.split(' ').filter(Boolean);
  let direction = '';
  let type = '';
  if (tokens.length > 1 && canonDirection(tokens[tokens.length - 1])) {
    direction = canonDirection(tokens.pop());
  }
  if (tokens.length > 1 && canonType(tokens[tokens.length - 1])) {
    type = canonType(tokens.pop());
  }
  const name = tokens.join(' ');
  if (name.length < 3) return null;
  return { unit: unit.replace(/^0+(?=.)/, ''), number, suffix, name, type, direction };
}

/** "300 Portage Ave" style label for a parsed address. */
export function addressLabel(addr) {
  if (!addr) return '';
  const civic = `${addr.number}${addr.suffix || ''}`;
  return [addr.unit ? `${addr.unit}-${civic}` : civic, addr.name, addr.type, addr.direction]
    .filter(Boolean).join(' ');
}

/** Form body for either portal's search POST. */
export function ppdSearchBody(addr) {
  return new URLSearchParams({
    lid: 'ReadOnlypermits ',
    command: '',
    propertyRSN: '',
    streetNumber: addr?.number || '',
    streetName: addr?.name || '',
    streetType: addr?.type || '',
  }).toString();
}

// ---------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Strip tags, decode entities, collapse whitespace. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      // Non-breaking hyphen (8209) and similar typographic glyphs read
      // as their plain forms in a table cell.
      if (c === 8209) return '-';
      return Number.isFinite(c) ? String.fromCodePoint(c) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function cellsOf(rowHtml) {
  const cells = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml))) cells.push(m[1]);
  return cells;
}

function dataRows(html) {
  const rows = [];
  const re = /<tr\s+valign\s*=\s*"?top"?[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) rows.push(cellsOf(m[1]));
  return rows;
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "2026-06-11" or "September 17, 2026" → "2026-09-17"; '' if neither. */
export function isoDate(text) {
  const s = String(text ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return '';
}

/** Chooser links: unit list ("Multiple entries") or nearby suggestions. */
function parseChoices(html) {
  const choices = [];
  const re = /<a\s+href="([^"]*propertyRSN=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = htmlToText(m[3]);
    if (!label) continue;
    const unit = (label.match(/^Unit\s+(\S+)/i) || [])[1] || '';
    choices.push({ rsn: m[2], path: m[1].replace(/&amp;/g, '&'), label, unit: unit.replace(/^0+(?=.)/, '') });
  }
  return choices;
}

/**
 * Classify a portal response page. Both portals share the four shapes:
 *   results  — the permit table (rows may be empty: a known address with
 *              no permits on file)
 *   units    — "Multiple entries … Please specify": one choice per unit
 *   nearby   — "Address not found. However, we found several suggestions"
 *   none     — "No property matching your criteria"
 *   unknown  — anything else (an error page, a block page)
 * `kind` picks the row parser: 'building' or 'occupancy'.
 */
export function parsePpdPage(html, kind = 'building') {
  const s = String(html ?? '');
  const heading = htmlToText((s.match(/Permits for([\s\S]*?)(?:<p|<br|\.\s*<|For information)/i) || [])[1] || '')
    .replace(/,?\s*issued after.*$/i, '').trim();
  if (/No property matching your criteria/i.test(s)) return { shape: 'none', rows: [], choices: [], heading };
  if (/Multiple entries for your criteria/i.test(s)) return { shape: 'units', rows: [], choices: parseChoices(s), heading };
  if (/Address not found/i.test(s)) return { shape: 'nearby', rows: [], choices: parseChoices(s), heading };
  if (/Permits for/i.test(s)) {
    const rows = kind === 'occupancy' ? parseOccupancyRows(s) : parseBuildingRows(s);
    return { shape: 'results', rows, choices: [], heading };
  }
  return { shape: 'unknown', rows: [], choices: [], heading };
}

function parseBuildingRows(html) {
  const out = [];
  for (const cells of dataRows(html)) {
    if (cells.length < 5) continue;
    const statusHtml = cells[3];
    const tip = (statusHtml.match(/<span[^>]*tooltiptext[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '';
    const status = htmlToText(statusHtml.replace(/<span[^>]*tooltiptext[^>]*>[\s\S]*?<\/span>/i, ''));
    const number = htmlToText(cells[0]);
    if (!number) continue;
    out.push({
      number,
      address: htmlToText(cells[1]),
      description: htmlToText(cells[2]),
      status,
      statusNote: htmlToText(tip).replace(/^[^:]{1,40}:\s*/, ''),
      issued: isoDate(htmlToText(cells[4])),
    });
  }
  return out;
}

function parseOccupancyRows(html) {
  const out = [];
  for (const cells of dataRows(html)) {
    if (cells.length < 9) continue;
    const number = htmlToText(cells[0]);
    if (!number) continue;
    out.push({
      number,
      occupant: htmlToText(cells[1]),
      unit: htmlToText(cells[2]),
      use: htmlToText(cells[3]),
      majorGroup: htmlToText(cells[4]),
      description: htmlToText(cells[5]),
      issued: isoDate(htmlToText(cells[6])),
      expires: isoDate(htmlToText(cells[7])),
      occupantLoad: htmlToText(cells[8]),
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Cross-reference
// ---------------------------------------------------------------------

/** Permit-number key: case and spacing folded ("26-170012 SP"). */
export function permitKey(n) {
  return String(n ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Keep only open-data rows at the parcel's own street: it4w is queried by
 * number + name, so "1 PORTAGE" also returns 1 Portage Ave E. Street type
 * must agree when both sides carry one; direction must agree outright
 * (absent on both counts as agreeing).
 */
export function sameStreet(addr, row) {
  const rowType = canonType(row?.street_type);
  if (addr?.type && rowType && addr.type !== rowType) return false;
  return (addr?.direction || '') === canonDirection(row?.street_direction);
}

function odDetail(r) {
  return {
    permitGroup: r.permit_group || '',
    permitType: r.permit_type || '',
    subType: r.sub_type || '',
    workType: r.work_type || '',
    structure: r.type_of_structure || '',
    applicant: r.applicant_business_name || '',
    unitsCreated: Number(r.dwelling_units_created) || 0,
    unitsLost: Number(r.dwelling_units_lost) || 0,
    received: isoDate(r.application_received_date),
    finalDate: isoDate(r.final_date),
    odStatus: r.status || '',
    majorProject: String(r.major_project || '').toLowerCase() === 'yes',
    unit: r.unit_number || '',
    parent: r.parent_permit_number || '',
  };
}

/**
 * Merge portal building/trade rows with open-data rows.
 * Returns rows newest first, each { source: 'both'|'ppd'|'opendata',
 * number, issued, description, status, …portal fields, od: detail|null }.
 */
export function mergePermits(ppdRows, odRows) {
  const byKey = new Map();
  for (const r of odRows || []) {
    const k = permitKey(r.permit_number);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }
  const used = new Set();
  const out = [];
  for (const p of ppdRows || []) {
    const k = permitKey(p.number);
    const od = byKey.get(k);
    if (od) used.add(k);
    out.push({ ...p, source: od ? 'both' : 'ppd', od: od ? odDetail(od) : null });
  }
  for (const [k, r] of byKey) {
    if (used.has(k)) continue;
    out.push({
      source: 'opendata',
      number: r.permit_number,
      address: r.address ? r.address.replace(/\s+/g, ' ').trim() : '',
      description: '',
      status: r.status || '',
      statusNote: '',
      issued: isoDate(r.issue_date),
      od: odDetail(r),
    });
  }
  out.sort((a, b) => (b.issued || '').localeCompare(a.issued || '') || permitKey(a.number).localeCompare(permitKey(b.number)));
  return out;
}

/** Description key for the occupancy ↔ building-permit match. */
function descKey(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * Stamp `relatedPermit` on each occupancy permit whose description is
 * the description of exactly one building permit at the address. Short
 * descriptions ("Locate.") are too generic to name one permit and are
 * skipped, as is any description shared by several building permits.
 */
export function linkOccupancyToBuilding(occRows, buildingRows) {
  // Older occupancy permits reuse the building permit's own number with a
  // space for the dash ("06 117112 PI" ↔ "06-117112 PI"); that is the
  // surer link, so it is tried before the description.
  const dashed = (n) => permitKey(n).replace(/^(\d{2})\s+(\d+)/, '$1-$2');
  const byNumber = new Map();
  for (const b of buildingRows || []) byNumber.set(dashed(b.number), b.number);
  const byDesc = new Map();
  for (const b of buildingRows || []) {
    const k = descKey(b.description);
    if (k.length < 25) continue;
    byDesc.set(k, byDesc.has(k) ? null : b.number);
  }
  return (occRows || []).map((o) => {
    const hit = byNumber.get(dashed(o.number)) || byDesc.get(descKey(o.description));
    return hit ? { ...o, relatedPermit: hit } : { ...o };
  });
}

/** One-line classification for a merged row's open-data detail. */
export function describeOd(od) {
  if (!od) return '';
  const kind = [od.permitType, od.subType].filter(Boolean).join(' · ');
  return [kind, od.workType].filter(Boolean).join(' — ');
}

/** Two-letter suffix of a permit number ("ES", "SP", "HO") — the portal's
 *  own class code, the only classification a trade permit carries. */
export function permitClassCode(number) {
  return (String(number ?? '').trim().match(/\s([A-Z]{2,3})$/) || [])[1] || '';
}

/**
 * The portal's permit class codes, from its own Search FAQ. ES is not in
 * the FAQ's table but is what the portal stamps on sign wiring ("Wire
 * New Sign"); MR is listed for symmetry with MC.
 */
export const PERMIT_CLASS_LABELS = Object.freeze({
  AS: 'Accessory Structures', CS: 'Commercial Storage', EC: 'Electrical Commercial',
  EH: 'Health Services / Education', ER: 'Electrical Residential', ES: 'Electrical Sign',
  HO: 'Housing', MC: 'Mechanical Commercial', MR: 'Mechanical Residential',
  MU: 'Multi-Residential', OP: 'Office', PC: 'Plumbing Commercial', PE: 'Personal Services',
  PI: 'General Public / Institutional', PR: 'Plumbing Residential', PU: 'Public Utility',
  RE: 'Recreation / Entertainment', RP: 'Retail', SA: 'Safety / Protection',
  TA: 'Temporary Approval', TB: 'Temporary Building Renewals', SP: 'Sign',
  DP: 'Development Permit', RO: 'Residential Home-based Business Development Permit',
  MS: 'Mobile Sign Development Permit', OC: 'Occupancy',
});

/** Electrical, mechanical and plumbing — the trade permits. */
const TRADE_CODES = new Set(['EC', 'ER', 'ES', 'MC', 'MR', 'PC', 'PR']);

export function isTradePermit(number) {
  return TRADE_CODES.has(permitClassCode(number));
}
