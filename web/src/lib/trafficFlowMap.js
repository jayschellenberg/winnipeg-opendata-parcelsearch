/**
 * City of Winnipeg Traffic Flow Map as a Traffic overlay source (Jason,
 * 2026-11-27). The default source for the Traffic button: one year, every
 * major street, from a static file, so it loads instantly and reads
 * consistently from block to block. The live count studies stay available
 * as the other source (lib/soda.js fetchTrafficVolumes), for a block's
 * count history.
 *
 * Data: public/traffic-flow-<year>.geojson, extracted from the City's
 * yearly flow-map PDF by tools/traffic-flow/extract_flow_map.py. Each
 * feature carries `volume` (average weekday daily traffic, both
 * directions) and `exact` (1 = the value printed on the map for that
 * section, 0 = no label reached that piece of line, so the volume is the
 * typical value for its line width).
 *
 * Pure. toTrafficFeatures maps the file onto the properties the existing
 * traffic layers already style and label (avg_daily_volume, volume_label),
 * so both sources draw identically.
 */

export const TRAFFIC_FLOW_YEAR = 2024;
export const TRAFFIC_FLOW_URL = `/traffic-flow-${TRAFFIC_FLOW_YEAR}.geojson`;

export const TRAFFIC_SOURCES = ['flow', 'counts'];
export const DEFAULT_TRAFFIC_SOURCE = 'flow';

export function cleanTrafficSource(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return TRAFFIC_SOURCES.includes(s) ? s : DEFAULT_TRAFFIC_SOURCE;
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

/** Popup parts (caller escapes): heading + lines. */
export function flowPopupParts(p, year = p?.latest_year ?? TRAFFIC_FLOW_YEAR) {
  const v = Number(p?.avg_daily_volume);
  const lines = [];
  if (Number.isFinite(v)) {
    lines.push(`${Number(p.exact) === 1 ? '' : 'About '}${v.toLocaleString('en-CA')} vehicles per weekday, both directions`);
  }
  if (Number(p?.exact) !== 1) {
    lines.push('No figure printed for this piece on the City map; estimated from its line width.');
  }
  lines.push(`Source: City of Winnipeg ${year} Traffic Flow Map (average weekday daily traffic; provincial roads are Manitoba annual averages).`);
  return { heading: `${year} Traffic Flow Map`, lines };
}

let cached = null;
/** Fetch the flow map once per page. */
export function fetchTrafficFlow(fetchFn = globalThis.fetch, url = TRAFFIC_FLOW_URL) {
  if (!cached) {
    cached = fetchFn(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`traffic flow map ${r.status}`))))
      .then(toTrafficFeatures)
      .catch((err) => { cached = null; throw err; });
  }
  return cached;
}
