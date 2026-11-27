// SHARED FILE: kept byte-identical with mb-parcelsearch web/src/lib/reportData.js.
// Pure helpers for the preliminary property report (report.html,
// src/report/main.js). Everything that decides WHAT the report says lives
// here so it can be unit-tested (test/reportData.test.js); the page module
// only fetches and lays out.

/** The report page URL for one parcel (relative, same origin). */
export function reportUrl(muniNameWithTyp, rollNoTxt) {
  const q = new URLSearchParams({ muni: muniNameWithTyp, roll: rollNoTxt });
  return `./report.html?${q}`;
}

/** Great-circle distance in metres. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Every [lon, lat] in a Polygon / MultiPolygon geometry. */
function coords(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates.flat();
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  if (geom.type === 'Point') return [geom.coordinates];
  // MHTIS traffic stations arrive as MultiPoint.
  if (geom.type === 'MultiPoint' || geom.type === 'LineString') return geom.coordinates;
  if (geom.type === 'MultiLineString') return geom.coordinates.flat();
  return [];
}

/** ArcGIS layers write empty attributes as the literal text "<Null>". */
export function clean(v) {
  const s = String(v ?? '').trim();
  return s && s.toUpperCase() !== '<NULL>' && s.toUpperCase() !== 'NULL' ? s : '';
}

/** [minLon, minLat, maxLon, maxLat] or null. */
export function bboxOf(geom) {
  const pts = coords(geom);
  if (!pts.length) return null;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}

/** Bounding-box centre as {lat, lon}: good enough for "what is nearby". */
export function centreOf(geom) {
  const bb = bboxOf(geom);
  return bb ? { lon: (bb[0] + bb[2]) / 2, lat: (bb[1] + bb[3]) / 2 } : null;
}

/**
 * Point features within `radiusM` of `at`, nearest first, each with `_m`.
 * Features without a usable point are skipped.
 */
export function nearby(features, at, radiusM, limit = Infinity) {
  if (!at) return [];
  const out = [];
  for (const f of features || []) {
    const c = f?.geometry?.type === 'Point' ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : centreOf(f?.geometry);
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const m = distanceM(at.lat, at.lon, c.lat, c.lon);
    if (m <= radiusM) out.push({ ...f, _m: m });
  }
  return out.sort((x, y) => x._m - y._m).slice(0, limit);
}

export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function fmtMoney(n) {
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-CA')}` : '—';
}

export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-CA') : '—';
}

export function fmtPct(n, { sign = false } = {}) {
  if (!Number.isFinite(n)) return '—';
  const s = `${n.toFixed(1)}%`;
  return sign && n > 0 ? `+${s}` : s;
}

/** "R1 Residential Single Family (82%) · C2 (18%)" from top-N join matches. */
export function zoningText(matches) {
  const parts = (matches || [])
    .filter((m) => m?.feature && (m.ratio == null || m.ratio >= 0.01))
    .map((m) => {
      const p = m.feature.properties || {};
      const code = clean(p.ZONE) || clean(p.DES_NAME);
      const zn = clean(p.ZONE_NAME);
      const name = zn && zn !== code ? ` ${zn}` : '';
      const pct = m.ratio != null && m.ratio < 0.995 ? ` (${Math.round(m.ratio * 100)}%)` : '';
      return `${code}${name}${pct}`.trim();
    })
    .filter(Boolean);
  return parts.join(' · ');
}

/** By-law references for the zones found, deduplicated. */
export function bylawText(matches, fields = ['ZBL', 'ZBL_A']) {
  const seen = new Set();
  for (const m of matches || []) {
    const p = m?.feature?.properties || {};
    for (const k of fields) if (clean(p[k])) seen.add(clean(p[k]));
  }
  return [...seen].join('; ');
}

/**
 * Census rows for the report: the subject geography (one row, or several
 * for a split CSD such as Mountain RM) followed by the comparison rows,
 * each carrying only the fields the report prints.
 */
export const CENSUS_FIELDS = Object.freeze([
  ['population', 'Population', fmtInt],
  ['population_change_pct', 'Change since prior census', (v) => fmtPct(v, { sign: true })],
  ['households', 'Households', fmtInt],
  ['median_age', 'Median age', (v) => (Number.isFinite(v) ? v.toFixed(1) : '—')],
  ['avg_household_size', 'Persons per household', (v) => (Number.isFinite(v) ? v.toFixed(1) : '—')],
  ['renter_pct', 'Renter households', fmtPct],
  ['single_detached_pct', 'Single-detached dwellings', fmtPct],
  ['built_since_2016_pct', 'Dwellings built 2016-2021', fmtPct],
  ['median_household_income', 'Median household income', fmtMoney],
  ['median_dwelling_value', 'Median dwelling value (owner estimate)', fmtMoney],
  ['median_rent', 'Median monthly rent', fmtMoney],
]);

export function censusColumns(summary, subjectUids, comparisonUids = ['46602', '46']) {
  const byUid = new Map((summary?.regions || []).map((r) => [r.uid, r]));
  const subject = subjectUids.map((u) => byUid.get(u)).filter(Boolean);
  const comps = comparisonUids.map((u) => byUid.get(u)).filter(Boolean)
    .filter((r) => !subject.some((s) => s.uid === r.uid));
  return { subject, comps, columns: [...subject, ...comps] };
}

/**
 * Traffic stations near the subject with their latest count and the
 * compound annual change over the series. `history` is traffic-history.json's
 * stations map; `stations` the All_Stations feature collection.
 */
export function nearbyTraffic(stations, history, at, radiusM = 10000, limit = 3) {
  const rows = [];
  for (const f of nearby(stations?.features, at, radiusM)) {
    const num = String(f.properties?.StationNum ?? '');
    const h = history?.stations?.[num];
    const years = Object.keys(h?.y || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!years.length) continue;
    const last = years.at(-1);
    const first = years.find((y) => last - y <= 10) ?? years[0];
    const a = Number(h.y[first]);
    const b = Number(h.y[last]);
    const span = last - first;
    const cagr = span > 0 && a > 0 && b > 0 ? (100 * ((b / a) ** (1 / span) - 1)) : null;
    rows.push({ station: num, highway: h.hwy ?? f.properties?.HighwayNum, location: h.loc ?? f.properties?.LocationDe,
      aadt: b, year: last, fromYear: span > 0 ? first : null, cagr, m: f._m });
    if (rows.length >= limit) break;
  }
  return rows;
}
