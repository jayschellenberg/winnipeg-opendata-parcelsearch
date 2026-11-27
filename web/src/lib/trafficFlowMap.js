/**
 * City of Winnipeg Traffic Flow Maps as Traffic overlay sources (Jason,
 * 2026-11-27). The default source for the Traffic button: one year, every
 * major street, from a static file, so it loads instantly and reads
 * consistently from block to block. Earlier years are sources of their
 * own, and a flow-map popup lists the same street in every year. The live
 * count studies stay available too (lib/soda.js fetchTrafficVolumes).
 *
 * Data: public/traffic-flow-<year>.geojson, extracted from the City's
 * yearly flow-map PDF by tools/traffic-flow/extract_flow_map.py. Each
 * feature carries `volume` (average weekday daily traffic, both
 * directions) and `exact` (1 = the value printed on the map for that
 * section, 0 = no label reached that piece of line, so the volume is the
 * typical value for its line width). The City published no maps for 2020
 * or 2021 (pandemic counts are excluded). 2008-2018 come from older,
 * ungeoreferenced PDFs fitted onto the 2019 map (extract_flow_map_old.py,
 * ~5 m median); see tools/traffic-flow/README.md.
 *
 * Pure apart from the memoised fetch. toTrafficFeatures maps a file onto
 * the properties the existing traffic layers style and label
 * (avg_daily_volume, volume_label), so every source draws the same way.
 */

/** Newest first. The first is the default source. */
export const TRAFFIC_FLOW_YEARS = [2024, 2023, 2022, 2019, 2018, 2015, 2012, 2009, 2008];
export const TRAFFIC_FLOW_YEAR = TRAFFIC_FLOW_YEARS[0];
export const trafficFlowUrl = (year) => `/traffic-flow-${year}.geojson`;

/** 'flow' = the newest map; 'flow-<year>' = an earlier one; 'counts' = live studies. */
export const TRAFFIC_SOURCES = ['flow', ...TRAFFIC_FLOW_YEARS.slice(1).map((y) => `flow-${y}`), 'counts'];
export const DEFAULT_TRAFFIC_SOURCE = 'flow';

export function cleanTrafficSource(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return TRAFFIC_SOURCES.includes(s) ? s : DEFAULT_TRAFFIC_SOURCE;
}

/** The flow-map year a source draws, or null for the live counts. */
export function sourceYear(source) {
  const s = cleanTrafficSource(source);
  if (s === 'counts') return null;
  if (s === 'flow') return TRAFFIC_FLOW_YEAR;
  return Number(s.slice(5));
}

/** The extracted file -> features the traffic layers draw. */
export function toTrafficFeatures(fc) {
  const year = fc?.metadata?.year ?? TRAFFIC_FLOW_YEAR;
  const features = [];
  for (const f of fc?.features || []) {
    const v = Number(f?.properties?.volume);
    if (!f?.geometry || !Number.isFinite(v) || v <= 0) continue;
    const exact = Number(f.properties.exact) === 1;
    features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        traffic_kind: 'flow',
        avg_daily_volume: v,
        // The figure as the City printed it (10,300, not "10k": the
        // hundreds are the point of a flow map). Estimated pieces get no
        // label: a number on the map should be one the City printed.
        volume_label: exact ? v.toLocaleString('en-CA') : '',
        exact: exact ? 1 : 0,
        latest_year: year,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ------------------------------------------------------- same street, other years
// The years' lines are drawn separately (a street may be split differently,
// or absent, in another year), so "the same street" is found spatially: the
// nearest line in that year's map within MATCH_METRES of the clicked point,
// running the same way (within MATCH_DEGREES) so a cross street at the
// intersection is not picked up.

const MATCH_METRES = 30;
const MATCH_DEGREES = 30;

function parts(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/** Local metres around `lat` (equirectangular; ample over 30 m). */
function scale(lat) {
  return { x: 111320 * Math.cos((lat * Math.PI) / 180), y: 110574 };
}

function segInfo(p, a, b, k) {
  const ax = (a[0] - p[0]) * k.x; const ay = (a[1] - p[1]) * k.y;
  const bx = (b[0] - p[0]) * k.x; const by = (b[1] - p[1]) * k.y;
  const dx = bx - ax; const dy = by - ay;
  const L = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L));
  const ex = ax + t * dx; const ey = ay + t * dy;
  return { dist: Math.hypot(ex, ey), bearing: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/** Undirected difference between two bearings, 0..90 degrees. */
function bearingDiff(a, b) {
  const d = Math.abs(((a - b) % 180 + 180) % 180);
  return Math.min(d, 180 - d);
}

/** Bearing (degrees) of the line in `geometry` nearest [lon, lat]. */
export function bearingNear(geometry, lngLat) {
  const k = scale(lngLat[1]);
  let best = null;
  for (const line of parts(geometry)) {
    for (let i = 1; i < line.length; i++) {
      const s = segInfo(lngLat, line[i - 1], line[i], k);
      if (!best || s.dist < best.dist) best = s;
    }
  }
  return best ? best.bearing : null;
}

/**
 * The line in `fc` nearest [lon, lat] within `maxM`, running within
 * MATCH_DEGREES of `bearing` (any direction when bearing is null):
 * {volume, exact, distance} or null.
 */
export function flowValueNear(fc, lngLat, bearing = null, maxM = MATCH_METRES) {
  const k = scale(lngLat[1]);
  const pad = maxM / k.y;
  let best = null;
  for (const f of fc?.features || []) {
    for (const line of parts(f.geometry)) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1]; const b = line[i];
        // cheap reject on the segment's box before any arithmetic
        if (Math.max(a[1], b[1]) < lngLat[1] - pad || Math.min(a[1], b[1]) > lngLat[1] + pad) continue;
        if (Math.max(a[0], b[0]) < lngLat[0] - pad * 1.6 || Math.min(a[0], b[0]) > lngLat[0] + pad * 1.6) continue;
        const s = segInfo(lngLat, a, b, k);
        if (s.dist > maxM) continue;
        if (bearing != null && bearingDiff(s.bearing, bearing) > MATCH_DEGREES) continue;
        if (!best || s.dist < best.distance) {
          best = { volume: Number(f.properties.avg_daily_volume ?? f.properties.volume), exact: Number(f.properties.exact) === 1, distance: s.dist };
        }
      }
    }
  }
  return best;
}

/** [{year, volume, exact}] oldest first; volume null where that year has no line here. */
export function flowHistory(byYear, lngLat, bearing) {
  return Object.keys(byYear).map(Number).sort((a, b) => a - b).map((year) => {
    const hit = flowValueNear(byYear[year], lngLat, bearing);
    return { year, volume: hit ? hit.volume : null, exact: hit ? hit.exact : false };
  });
}

/**
 * Change between the earliest and latest years with a PRINTED figure:
 * {from, to, pct, pctPerYear} or null. Width-estimated years are skipped:
 * a trend should rest on the City's own numbers.
 */
export function flowGrowth(rows) {
  const ok = (rows || []).filter((r) => r.exact && r.volume > 0);
  if (ok.length < 2) return null;
  const a = ok[0]; const b = ok[ok.length - 1];
  if (b.year <= a.year) return null;
  const ratio = b.volume / a.volume;
  return {
    from: a.year,
    to: b.year,
    pct: (ratio - 1) * 100,
    pctPerYear: (ratio ** (1 / (b.year - a.year)) - 1) * 100,
  };
}

const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

/** Popup parts (caller escapes): heading, lines, history rows, growth line. */
export function flowPopupParts(p, history = null) {
  const year = p?.latest_year ?? TRAFFIC_FLOW_YEAR;
  const v = Number(p?.avg_daily_volume);
  const lines = [];
  if (Number.isFinite(v)) {
    lines.push(`${Number(p.exact) === 1 ? '' : 'About '}${v.toLocaleString('en-CA')} vehicles per weekday, both directions`);
  }
  if (Number(p?.exact) !== 1) {
    lines.push('No figure printed for this piece on the City map; estimated from its line width.');
  }
  const rows = (history || []).map((r) => ({
    year: r.year,
    text: r.volume == null ? 'not on the map' : `${r.exact ? '' : '~'}${r.volume.toLocaleString('en-CA')}`,
    current: r.year === year,
  }));
  const g = flowGrowth(history);
  const growth = g ? `${g.from} to ${g.to}: ${fmtPct(g.pct)} (${fmtPct(g.pctPerYear)} a year)` : null;
  const source = `Source: City of Winnipeg Traffic Flow Maps (average weekday daily traffic; provincial roads are Manitoba annual averages).${
    rows.some((r) => r.text.startsWith('~')) ? ' ~ = estimated from line width.' : ''}`;
  return { heading: `${year} Traffic Flow Map`, lines, rows, growth, source };
}

const cache = new Map();
/** Fetch one year's flow map once per page. */
export function fetchTrafficFlow(year = TRAFFIC_FLOW_YEAR, fetchFn = globalThis.fetch, url = trafficFlowUrl(year)) {
  if (!cache.has(url)) {
    const p = fetchFn(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`traffic flow map ${year}: ${r.status}`))))
      .then(toTrafficFeatures);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

/** Every year's map (for popup history); a year that fails to load is left out. */
export async function fetchAllTrafficFlow(fetchFn = globalThis.fetch) {
  const out = {};
  await Promise.all(TRAFFIC_FLOW_YEARS.map(async (y) => {
    try { out[y] = await fetchTrafficFlow(y, fetchFn); } catch { /* history just lacks that year */ }
  }));
  return out;
}
