/**
 * Redevelopment permits: new-construction and demolition building permits
 * as map points, plus a summary for the subject's neighbourhood cluster
 * and a 1 km ring (Reference group; Jason, 2026-11-27, for highest and
 * best use: "has there been redevelopment around here?").
 *
 * Data: Building Permits it4w-cpf4, work_type 'Construct New' or
 * 'Demolish', accessory structures out (sheds and garages are not
 * redevelopment). The City supplies a point on 99.9% of rows, so there is
 * no address geocoding. ~25,000 rows over ten years: one request, cached.
 *
 * FIVE KINDS ON THE MAP
 *   rebuild    a demolition and a new building at the same address (the
 *              teardown signal), drawn as ONE point at the new permit
 *   demo       a demolition with no new permit at that address (yet)
 *   new-home   new house, duplex or row house (permit_type Housing)
 *   new-multi  new apartment / multi-family (Multi-Residential)
 *   new-nonres everything else new: commercial, industrial, institutional
 *
 * NEW HOMES IN DEVELOPING NEIGHBOURHOODS. Single-family construction is
 * 90%+ of new permits, and most of it is greenfield subdivision (Prairie
 * Pointe alone: 1,236 homes against 1 demolition over 2021-2026). That is
 * not redevelopment, but in an infill neighbourhood a new house IS the
 * signal. The data separates the two sharply: infill neighbourhoods run
 * 1-5 new homes per demolition, new suburbs 40-1,200. So a neighbourhood
 * is "developing" when it has at least DEVELOPING_MIN_HOMES new homes and
 * more than DEVELOPING_RATIO per demolition, measured over everything
 * loaded (ten years) so the label does not flicker with the period
 * dropdown. New homes there are faded by default; Show all / Hide override.
 *
 * Pure: no DOM, no network. soda.js fetches, main.js wires, map.js draws.
 * Tested in test/redevelopmentPermits.test.js.
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { permitAddressKey } from './permitEvidence.js';

export const REDEV_YEAR_OPTIONS = ['3', '5', '10'];
export const DEFAULT_REDEV_YEARS = '5';

/** New homes in developing neighbourhoods: fade (default), show, hide. */
export const REDEV_HOME_MODES = ['auto', 'all', 'hide'];
export const DEFAULT_REDEV_HOMES = 'auto';

export const DEVELOPING_MIN_HOMES = 25;
export const DEVELOPING_RATIO = 10;

/** Radius of the summary ring, km. */
export const REDEV_RADIUS_KM = 1;

/** A new permit within this long of a demolition at the same address is its rebuild. */
const PAIR_AFTER_DAYS = 3 * 365;
/** ...or this long BEFORE it (the new permit is sometimes issued first). */
const PAIR_BEFORE_DAYS = 365;

export const REDEV_CATEGORIES = [
  { key: 'rebuild', color: '#7c3aed', label: 'Teardown rebuild', short: 'teardown rebuilds' },
  { key: 'demo', color: '#dc2626', label: 'Demolition, no new permit yet', short: 'demolitions not yet rebuilt' },
  { key: 'new-home', color: '#16a34a', label: 'New house / duplex / row', short: 'new homes' },
  { key: 'new-multi', color: '#2563eb', label: 'New multi-family', short: 'multi-family projects' },
  { key: 'new-nonres', color: '#ea580c', label: 'New commercial / other', short: 'non-residential buildings' },
];

const CATEGORY_KEYS = new Set(REDEV_CATEGORIES.map((c) => c.key));

export function cleanRedevYears(v) {
  const s = String(v ?? '').trim();
  return REDEV_YEAR_OPTIONS.includes(s) ? s : DEFAULT_REDEV_YEARS;
}

export function cleanRedevHomes(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return REDEV_HOME_MODES.includes(s) ? s : DEFAULT_REDEV_HOMES;
}

/** 'YYYY-MM-DD' `years` before `today`. */
export function redevCutoff(years, today = new Date()) {
  const y = Number(cleanRedevYears(years));
  const d = new Date(Date.UTC(today.getFullYear() - y, today.getMonth(), today.getDate()));
  return d.toISOString().slice(0, 10);
}

/** The fetch reaches back to 1 January ten years ago (a stable cache key). */
export function redevFetchSince(today = new Date()) {
  const y = Math.max(...REDEV_YEAR_OPTIONS.map(Number));
  return `${today.getFullYear() - y}-01-01T00:00:00.000`;
}

const isoDay = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
  return m ? m[1] : null;
};

const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;

function pointOf(row) {
  const c = row?.point?.coordinates;
  if (Array.isArray(c) && c.length >= 2) {
    const lon = Number(c[0]); const lat = Number(c[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat) && lon && lat) return [lon, lat];
  }
  const lat = Number(row?.location?.latitude);
  const lon = Number(row?.location?.longitude);
  if (Number.isFinite(lon) && Number.isFinite(lat) && lon && lat) return [lon, lat];
  return null;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function groupOf(permitType) {
  const t = String(permitType || '').trim().toLowerCase();
  if (t === 'housing') return 'home';
  if (t === 'multi-residential') return 'multi';
  return 'nonres';
}

function addressOf(r) {
  if (r?.address) return String(r.address).trim();
  return [r?.street_number, r?.street_name, r?.street_type, r?.street_direction]
    .filter((x) => x != null && String(x).trim()).join(' ');
}

/**
 * Raw permit rows -> events. One per permit number; rows without a point
 * or a date are counted as unplaced, not drawn.
 */
export function permitEvents(rows) {
  const events = [];
  const seen = new Set();
  let unplaced = 0;
  for (const r of rows || []) {
    const wt = String(r?.work_type || '').trim();
    const kind = wt === 'Construct New' ? 'new' : wt === 'Demolish' ? 'demo' : null;
    if (!kind) continue;
    if (String(r.permit_type || '').trim() === 'Accessory Structures') continue;
    const pn = r.permit_number ? String(r.permit_number) : null;
    if (pn && seen.has(pn)) continue;
    if (pn) seen.add(pn);
    const pt = pointOf(r);
    const date = isoDay(r.issue_date);
    if (!pt || !date) { unplaced++; continue; }
    events.push({
      kind,
      group: groupOf(r.permit_type),
      date,
      pt,
      permitNumber: pn,
      permitType: r.permit_type || null,
      subType: r.sub_type || null,
      address: addressOf(r) || null,
      key: permitAddressKey(r.street_number, r.street_name),
      neighbourhood: r.neighbourhood_name ? String(r.neighbourhood_name).trim() : null,
      unitsCreated: num(r.dwelling_units_created),
      unitsLost: num(r.dwelling_units_lost),
    });
  }
  return { events, unplaced };
}

/** Neighbourhood names whose new homes are greenfield, not infill (see header). */
export function developingNeighbourhoods(events, { minHomes = DEVELOPING_MIN_HOMES, ratio = DEVELOPING_RATIO } = {}) {
  const homes = new Map();
  const demos = new Map();
  for (const e of events || []) {
    if (!e.neighbourhood) continue;
    if (e.kind === 'new' && e.group === 'home') homes.set(e.neighbourhood, (homes.get(e.neighbourhood) || 0) + 1);
    else if (e.kind === 'demo') demos.set(e.neighbourhood, (demos.get(e.neighbourhood) || 0) + 1);
  }
  const out = new Set();
  for (const [n, h] of homes) {
    if (h >= minHomes && h > ratio * (demos.get(n) || 0)) out.add(n);
  }
  return out;
}

/**
 * Events -> point features. A demolition and a new permit at the same
 * address key (new issued up to a year before, or three years after) merge
 * into one 'rebuild' feature at the new building. Each demolition pairs
 * with at most one new permit, the closest in time.
 */
export function redevFeatures(events, developing = new Set()) {
  const demosByKey = new Map();
  for (const e of events || []) {
    if (e.kind !== 'demo' || !e.key) continue;
    if (!demosByKey.has(e.key)) demosByKey.set(e.key, []);
    demosByKey.get(e.key).push(e);
  }
  const used = new Set();
  const features = [];
  const news = (events || []).filter((e) => e.kind === 'new').sort((a, b) => a.date.localeCompare(b.date));
  for (const e of news) {
    let demo = null;
    let best = Infinity;
    for (const d of demosByKey.get(e.key) || []) {
      if (used.has(d)) continue;
      const gap = dayNum(e.date) - dayNum(d.date);
      if (gap > PAIR_AFTER_DAYS || gap < -PAIR_BEFORE_DAYS) continue;
      if (Math.abs(gap) < best) { best = Math.abs(gap); demo = d; }
    }
    if (demo) used.add(demo);
    const category = demo ? 'rebuild' : `new-${e.group}`;
    features.push(feature(e.pt, {
      category,
      group: e.group,
      date: e.date,
      permitNumber: e.permitNumber,
      permitType: e.permitType,
      subType: e.subType,
      address: e.address,
      neighbourhood: e.neighbourhood,
      developing: !demo && e.group === 'home' && developing.has(e.neighbourhood) ? 1 : 0,
      unitsCreated: e.unitsCreated,
      unitsLost: demo ? demo.unitsLost : 0,
      demoDate: demo ? demo.date : null,
      demoPermitNumber: demo ? demo.permitNumber : null,
      demoSubType: demo ? demo.subType : null,
    }));
  }
  for (const list of demosByKey.values()) {
    for (const d of list) if (!used.has(d)) features.push(demoFeature(d));
  }
  // Demolitions with no address key could not be paired; still draw them.
  for (const e of events || []) if (e.kind === 'demo' && !e.key) features.push(demoFeature(e));
  return features;
}

function demoFeature(d) {
  return feature(d.pt, {
    category: 'demo',
    group: d.group,
    date: d.date,
    permitNumber: d.permitNumber,
    permitType: d.permitType,
    subType: d.subType,
    address: d.address,
    neighbourhood: d.neighbourhood,
    developing: 0,
    unitsCreated: 0,
    unitsLost: d.unitsLost,
    demoDate: d.date,
    demoPermitNumber: d.permitNumber,
    demoSubType: d.subType,
  });
}

function feature(pt, properties) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties };
}

/**
 * Cut to the period and apply the new-homes mode. Returns copies with a
 * `faded` flag (1 = draw muted) so the source features stay untouched.
 */
export function filterRedev(features, years, homes, today = new Date()) {
  const cut = redevCutoff(years, today);
  const mode = cleanRedevHomes(homes);
  const out = [];
  for (const f of features || []) {
    const p = f?.properties;
    if (!p?.date || p.date < cut) continue;
    if (p.developing && mode === 'hide') continue;
    out.push({ ...f, properties: { ...p, faded: p.developing && mode === 'auto' ? 1 : 0 } });
  }
  return out;
}

/** MapLibre 'match' colouring by category. */
export function redevColorExpression() {
  const expr = ['match', ['get', 'category']];
  for (const c of REDEV_CATEGORIES) expr.push(c.key, c.color);
  expr.push('#9ca3af');
  return expr;
}

const R_KM = 6371;
/** Great-circle distance between [lon, lat] pairs, km. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function emptyCounts() {
  return {
    total: 0,
    rebuild: 0,
    demo: 0,
    newHome: 0,
    newHomeDeveloping: 0,
    newMulti: 0,
    multiUnits: 0,
    newNonres: 0,
    unitsCreated: 0,
    unitsLost: 0,
    net: 0,
    byYear: {},
  };
}

function addTo(c, p) {
  c.total++;
  if (p.category === 'rebuild') c.rebuild++;
  else if (p.category === 'demo') c.demo++;
  else if (p.category === 'new-home') {
    c.newHome++;
    if (p.developing) c.newHomeDeveloping++;
  } else if (p.category === 'new-multi') {
    c.newMulti++;
    c.multiUnits += Number(p.unitsCreated) || 0;
  } else if (p.category === 'new-nonres') c.newNonres++;
  c.unitsCreated += Number(p.unitsCreated) || 0;
  c.unitsLost += Number(p.unitsLost) || 0;
  c.net = c.unitsCreated - c.unitsLost;
  // A teardown is dated by its demolition here: the line answers "when
  // were buildings coming down", and the rebuild permit can lag by years.
  const y = (p.category === 'rebuild' && p.demoDate ? p.demoDate : p.date).slice(0, 4);
  const row = c.byYear[y] || (c.byYear[y] = { demo: 0, rebuild: 0, new: 0 });
  if (p.category === 'demo') row.demo++;
  else if (p.category === 'rebuild') row.rebuild++;
  else row.new++;
}

function bboxOf(geometry) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
      return;
    }
    for (const part of c) walk(part);
  };
  walk(geometry?.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Counts for the subject's cluster and its ring.
 *
 * @param {Array} features  already cut by filterRedev (hidden homes are gone,
 *                          faded ones count; the card says how many are faded)
 * @param {object} opts
 * @param {[number, number]} [opts.subject]  [lon, lat]; no ring counts without it
 * @param {Array} [opts.clusterPolygons]     the cluster's neighbourhood polygons
 * @param {number} [opts.radiusKm]
 */
export function summariseRedev(features, { subject = null, clusterPolygons = [], radiusKm = REDEV_RADIUS_KM } = {}) {
  const polys = (clusterPolygons || [])
    .map((f) => ({ f, bbox: bboxOf(f?.geometry) }))
    .filter((x) => x.bbox);
  const cluster = polys.length ? emptyCounts() : null;
  const ring = subject ? emptyCounts() : null;
  for (const f of features || []) {
    const p = f?.properties;
    const pt = f?.geometry?.coordinates;
    if (!p || !CATEGORY_KEYS.has(p.category) || !Array.isArray(pt)) continue;
    if (ring && distanceKm(subject, pt) <= radiusKm) addTo(ring, p);
    if (cluster) {
      for (const { f: poly, bbox } of polys) {
        if (pt[0] < bbox[0] || pt[0] > bbox[2] || pt[1] < bbox[1] || pt[1] > bbox[3]) continue;
        if (booleanPointInPolygon(pt, poly)) { addTo(cluster, p); break; }
      }
    }
  }
  return { cluster, ring };
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

function areaPhrase(c) {
  const bits = [];
  if (c.demo + c.rebuild) {
    bits.push(`${plural(c.demo + c.rebuild, 'demolition')} (${c.rebuild.toLocaleString('en-CA')} rebuilt)`);
  }
  const homesInfill = c.newHome - c.newHomeDeveloping;
  if (c.newHome) {
    bits.push(c.newHomeDeveloping
      ? `${plural(c.newHome, 'other new home')} (${c.newHomeDeveloping.toLocaleString('en-CA')} in developing subdivisions, ${homesInfill.toLocaleString('en-CA')} elsewhere)`
      : plural(c.newHome, 'other new home'));
  }
  if (c.newMulti) {
    bits.push(`${plural(c.newMulti, 'multi-family project')}${c.multiUnits ? ` (${plural(c.multiUnits, 'unit')})` : ''}`);
  }
  if (c.newNonres) bits.push(plural(c.newNonres, 'new non-residential building'));
  if (!bits.length) return null;
  const last = bits.pop();
  return bits.length ? `${bits.join(', ')} and ${last}` : last;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Report-ready paragraph. `clusterName` and the counts come from
 * summariseRedev; `years` is the period dropdown.
 */
export function redevSummaryText({ cluster, ring }, { clusterName, years, radiusKm = REDEV_RADIUS_KM, today = new Date() } = {}) {
  const since = redevCutoff(years, today);
  const when = `Since ${MONTHS[Number(since.slice(5, 7)) - 1]} ${since.slice(0, 4)}`;
  const out = [];
  if (cluster) {
    const phrase = areaPhrase(cluster);
    out.push(phrase
      ? `${when}, the City of Winnipeg issued building permits in the ${clusterName || 'subject'} neighbourhood cluster for ${phrase}.`
      : `${when}, no new-construction or demolition permits were issued in the ${clusterName || 'subject'} neighbourhood cluster.`);
  }
  if (ring) {
    const phrase = areaPhrase(ring);
    const r = `${radiusKm} km`;
    out.push(phrase
      ? `Within ${r} of the subject there were ${phrase}.`
      : `Within ${r} of the subject there were no new-construction or demolition permits.`);
  }
  if (out.length) out.push('Source: City of Winnipeg Open Data, Building Permits (accessory structures excluded).');
  return out.join(' ');
}

/** Popup parts (caller escapes): heading, lines. */
export function redevPopupParts(p) {
  const cat = REDEV_CATEGORIES.find((c) => c.key === p?.category);
  const lines = [];
  if (p?.address) lines.push(p.address);
  if (p?.category === 'rebuild') {
    lines.push(`Demolition ${p.demoDate || ''}${p.demoSubType ? ` · ${p.demoSubType}` : ''}${p.demoPermitNumber ? ` · #${p.demoPermitNumber}` : ''}`.trim());
    lines.push(`New ${p.date || ''}${p.subType ? ` · ${p.subType}` : ''}${p.permitNumber ? ` · #${p.permitNumber}` : ''}`.trim());
  } else {
    const what = [p?.date, p?.permitType, p?.subType].filter(Boolean).join(' · ');
    if (what) lines.push(what);
    if (p?.permitNumber) lines.push(`Permit #${p.permitNumber}`);
  }
  const units = [];
  if (Number(p?.unitsCreated)) units.push(`${p.unitsCreated} unit${Number(p.unitsCreated) === 1 ? '' : 's'} created`);
  if (Number(p?.unitsLost)) units.push(`${p.unitsLost} lost`);
  if (units.length) lines.push(units.join(' · '));
  if (p?.neighbourhood) lines.push(`${titleCase(p.neighbourhood)}${p.developing ? ' (developing subdivision)' : ''}`);
  return { heading: cat?.label || 'Permit', lines };
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bMc([a-z])/g, (m, c) => `Mc${c.toUpperCase()}`);
}
