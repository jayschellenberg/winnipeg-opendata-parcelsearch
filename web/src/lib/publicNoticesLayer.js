/**
 * Public Notices & Rezonings map layer: one point per rezoning item,
 * coloured by type and limited to the last N years.
 *
 * Two sources:
 *   - Adopted by-laws: web/public/zoning-amendments.json (the DMIS scrape,
 *     r/build_zoning_amendments.R). Each by-law is listed under every roll
 *     it was placed on. Here it becomes ONE point at the mean of those
 *     parcels' centroids (Assessment Parcels centroid_lat / centroid_lon),
 *     so a 40-lot subdivision is one dot rather than forty.
 *   - Public Notices gnxp-9hpt, live: REZONING, SUBDIVISION AND REZONING
 *     and ZONING AGREEMENT AMENDMENT rows, at the point the City supplies.
 *
 * Kept separate from the Zoning Changes pill (lib/zoningAmendments.js),
 * which highlights parcels and drives the Rezoned column. Pure, so the
 * feature building and the years cut are unit-tested
 * (test/publicNoticesLayer.test.js).
 */

import { dmisRecordUrl } from './zoningAmendments.js';
import { cleanLotBound } from './newPlans.js';

/** Which sources to draw: both, notices only, or adopted by-laws only. */
export const NOTICE_SOURCE_OPTIONS = ['both', 'notice', 'bylaw'];
export const DEFAULT_NOTICE_SOURCE = 'both';

/** Normalise the source dropdown; anything unknown means both. */
export function cleanNoticeSource(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return NOTICE_SOURCE_OPTIONS.includes(s) ? s : DEFAULT_NOTICE_SOURCE;
}

/** Keep features from the chosen source ('both' keeps everything). */
export function filterBySource(features, source) {
  const s = cleanNoticeSource(source);
  if (s === 'both') return [...(features || [])];
  return (features || []).filter((f) => f?.properties?.source === s);
}

/**
 * Keep by-laws whose parcel count is within [min, max] (a null / blank bound
 * is open; a reversed range is read the other way round). Notices always
 * pass: the City ties each notice to one roll even when it covers a whole
 * subdivision phase, so there is no count to filter on.
 */
export function filterByParcels(features, min, max) {
  let lo = cleanLotBound(min);
  let hi = cleanLotBound(max);
  if (lo == null && hi == null) return [...(features || [])];
  if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];
  return (features || []).filter((f) => {
    const p = f?.properties;
    if (p?.source !== 'bylaw') return true;
    const n = Number(p.parcels) || 0;
    return (lo == null || n >= lo) && (hi == null || n <= hi);
  });
}

/** "2–5 parcels", "10+ parcels", "up to 3 parcels", or null for no range. */
export function parcelRangeLabel(min, max) {
  let lo = cleanLotBound(min);
  let hi = cleanLotBound(max);
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];
  const unit = (n) => `parcel${n === 1 ? '' : 's'}`;
  if (lo != null && hi != null) return lo === hi ? `${lo} ${unit(lo)}` : `${lo}–${hi} parcels`;
  return lo != null ? `${lo}+ parcels` : `up to ${hi} ${unit(hi)}`;
}

/** Years-back choices for the dropdown; 'all' = no cut. */
export const NOTICE_YEAR_OPTIONS = ['1', '2', '3', '5', '10', 'all'];
export const DEFAULT_NOTICE_YEARS = '5';

export const NOTICE_LAYER_TYPES = new Set(['REZONING', 'SUBDIVISION AND REZONING', 'ZONING AGREEMENT AMENDMENT']);

/**
 * Category → colour and legend label. Adopted by-laws are the darker
 * shades; notices (applications, mostly still pending) the lighter.
 */
export const NOTICE_CATEGORIES = [
  { key: 'bylaw-rezoning', color: '#c2410c', label: 'Rezoning by-law' },
  { key: 'bylaw-subdivision', color: '#7c3aed', label: 'Subdivision + rezoning by-law' },
  { key: 'bylaw-correction', color: '#6b7280', label: 'Correcting by-law' },
  { key: 'notice-rezoning', color: '#f59e0b', label: 'Rezoning notice' },
  { key: 'notice-subdivision', color: '#c084fc', label: 'Subdivision + rezoning notice' },
  { key: 'notice-zaa', color: '#14b8a6', label: 'Zoning agreement amendment notice' },
];

const BYLAW_CATEGORY = {
  'rezoning': 'bylaw-rezoning',
  'subdivision-rezoning': 'bylaw-subdivision',
  'correction': 'bylaw-correction',
};
const NOTICE_CATEGORY = {
  'REZONING': 'notice-rezoning',
  'SUBDIVISION AND REZONING': 'notice-subdivision',
  'ZONING AGREEMENT AMENDMENT': 'notice-zaa',
};

/** MapLibre 'match' expression colouring by the `category` property. */
export function categoryColorExpression() {
  const expr = ['match', ['get', 'category']];
  for (const c of NOTICE_CATEGORIES) expr.push(c.key, c.color);
  expr.push('#9ca3af');
  return expr;
}

/** Normalise a dropdown value; anything unknown falls back to the default. */
export function cleanNoticeYears(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return NOTICE_YEAR_OPTIONS.includes(s) ? s : DEFAULT_NOTICE_YEARS;
}

/**
 * 'YYYY-MM-DD' that is `years` before `today`, or null for 'all'.
 * Feb 29 rolls to Mar 1 in a non-leap target year, which is harmless here.
 */
export function noticeCutoff(years, today = new Date()) {
  const y = cleanNoticeYears(years);
  if (y === 'all') return null;
  const d = new Date(Date.UTC(today.getFullYear() - Number(y), today.getMonth(), today.getDate()));
  return d.toISOString().slice(0, 10);
}

const isoDay = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
  return m ? m[1] : null;
};

function pointOf(row) {
  const c = row?.point?.coordinates;
  if (Array.isArray(c) && c.length >= 2) {
    const lon = Number(c[0]); const lat = Number(c[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat) && (lon || lat)) return [lon, lat];
  }
  const lat = Number(row?.location?.latitude);
  const lon = Number(row?.location?.longitude);
  if (Number.isFinite(lon) && Number.isFinite(lat) && (lon || lat)) return [lon, lat];
  return null;
}

/** Public Notice rows → point features. Rows without a location are counted, not drawn. */
export function noticeFeatures(rows) {
  const features = [];
  const seen = new Set();
  let unplaced = 0;
  for (const r of rows || []) {
    const type = String(r?.notice_type || '').toUpperCase();
    if (!NOTICE_LAYER_TYPES.has(type)) continue;
    const id = r.notice_id ? String(r.notice_id) : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const pt = pointOf(r);
    if (!pt) { unplaced++; continue; }
    const date = isoDay(r.in_date) || isoDay(r.meeting_date) || isoDay(r.order_date);
    const url = r.dmis_decision?.url || (typeof r.dmis_decision === 'string' ? r.dmis_decision : null);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pt },
      properties: {
        source: 'notice',
        category: NOTICE_CATEGORY[type],
        noticeId: id,
        noticeType: type,
        title: r.address || null,
        description: r.plain_language || r.description || null,
        decision: r.decision || null,
        date,
        meetingDate: isoDay(r.meeting_date),
        url: url || null,
        reportUrl: r.report_plan_url?.url || null,
      },
    });
  }
  return { features, unplaced };
}

/** Every roll the by-law index places anything on. */
export function bylawRolls(json) {
  return Object.keys(json?.byRoll || {});
}

/**
 * By-law index + roll centroids → one point feature per by-law.
 * `centroids` is a Map (or plain object) roll → [lon, lat].
 */
export function bylawFeatures(json, centroids) {
  const get = (roll) => (centroids instanceof Map ? centroids.get(roll) : centroids?.[roll]);
  const groups = new Map();
  for (const [roll, entries] of Object.entries(json?.byRoll || {})) {
    for (const e of entries || []) {
      if (!e || !BYLAW_CATEGORY[e.kind]) continue;
      const key = e.dmisId ? `d${e.dmisId}` : `b${e.bylaw}`;
      if (!groups.has(key)) groups.set(key, { entry: e, rolls: new Set(), confidence: new Set() });
      const g = groups.get(key);
      g.rolls.add(roll);
      if (e.confidence) g.confidence.add(e.confidence);
    }
  }
  const features = [];
  let unplaced = 0;
  for (const { entry: e, rolls, confidence } of groups.values()) {
    let sx = 0; let sy = 0; let n = 0;
    for (const roll of rolls) {
      const c = get(roll);
      if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) { sx += c[0]; sy += c[1]; n++; }
    }
    if (!n) { unplaced++; continue; }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [sx / n, sy / n] },
      properties: {
        source: 'bylaw',
        category: BYLAW_CATEGORY[e.kind],
        bylaw: e.bylaw || null,
        daz: e.daz || null,
        title: e.subject || null,
        date: isoDay(e.passed) || isoDay(e.effective) || bylawYearDate(e.bylaw),
        passed: isoDay(e.passed),
        effective: isoDay(e.effective),
        parcels: rolls.size,
        corner: confidence.has('corner') ? 1 : 0,
        url: dmisRecordUrl(e),
      },
    });
  }
  return { features, unplaced };
}

// "140/2008" with no dates → 2008-01-01, so it still sorts into a year.
function bylawYearDate(bylaw) {
  const m = /\/(\d{4})$/.exec(String(bylaw || ''));
  return m ? `${m[1]}-01-01` : null;
}

/**
 * Keep features dated on or after the cutoff. Undated features are kept
 * only under 'all' — an unknown date cannot be shown to be recent.
 */
export function filterByYears(features, years, today = new Date()) {
  const cut = noticeCutoff(years, today);
  if (!cut) return [...(features || [])];
  return (features || []).filter((f) => f?.properties?.date && f.properties.date >= cut);
}

/** Per-category counts for the legend, in NOTICE_CATEGORIES order. */
export function categoryCounts(features) {
  const counts = Object.fromEntries(NOTICE_CATEGORIES.map((c) => [c.key, 0]));
  for (const f of features || []) {
    const k = f?.properties?.category;
    if (k in counts) counts[k]++;
  }
  return counts;
}

/**
 * Plain-text popup lines (caller escapes): heading, sub-lines, links.
 * @returns {{ heading: string, lines: string[], links: {label: string, url: string}[] }}
 */
export function noticePopupParts(p) {
  const cat = NOTICE_CATEGORIES.find((c) => c.key === p?.category);
  const links = [];
  if (p?.source === 'bylaw') {
    const lines = [];
    if (p.title) lines.push(p.title);
    const when = [p.passed ? `passed ${p.passed}` : null, p.effective && p.effective !== p.passed ? `effective ${p.effective}` : null]
      .filter(Boolean).join(' · ');
    if (when) lines.push(when);
    const n = Number(p.parcels) || 0;
    lines.push(`${n} parcel${n === 1 ? '' : 's'}${n > 1 ? ' (point at their centre)' : ''}`);
    if (Number(p.corner)) lines.push('Placed by street corner — verify the parcels');
    if (p.url) links.push({ label: 'DMIS by-law record', url: p.url });
    return { heading: `${cat?.label || 'By-law'} ${p.bylaw || ''}${p.daz ? ` (${p.daz})` : ''}`.trim(), lines, links };
  }
  const lines = [];
  if (p?.title) lines.push(p.title);
  const status = [p?.decision || 'Pending', p?.date ? `filed ${p.date}` : null,
    p?.meetingDate ? `meeting ${p.meetingDate}` : null].filter(Boolean).join(' · ');
  lines.push(status);
  if (p?.description) lines.push(p.description);
  if (p?.url) links.push({ label: 'DMIS decision', url: p.url });
  if (p?.reportUrl) links.push({ label: 'Planning report', url: p.reportUrl });
  return { heading: `${cat?.label || 'Notice'} ${p?.noticeId || ''}`.trim(), lines, links };
}
