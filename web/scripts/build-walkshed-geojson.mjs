#!/usr/bin/env node
/*
 * build-walkshed-geojson.mjs
 * ---------------------------------------------------------------
 * Builds web/public/frequent-transit-walkshed.geojson — the City's
 * "Winnipeg Zoning Schedule AC Map 2" layer: the land within 800 m
 * walking distance of frequent transit, where Schedule AC of the
 * Winnipeg Zoning By-law (200/2006, added by By-law 59/2025, the
 * Housing Accelerator Fund as-of-right infill amendment) grants the
 * more permissive low-density infill rights.
 *
 * SOURCE. This layer is NOT on Winnipeg Open Data (checked 2026-10-09:
 * no dataset matches "walkshed", "frequent transit" or "Schedule AC").
 * The only public copy is the legacy PP&D Property Map
 * (legacy.winnipeg.ca/ppd/Mapping/PropertyMap), which draws it from the
 * City's internal map API as feature set 18787 ("WalkShed 800m",
 * category "PPD Boundaries"). That API is JSONP-only, carries no CORS
 * headers and is not in our Content-Security-Policy, so the browser
 * cannot fetch it live. We pull it here at build time and ship the
 * result as a static asset, the same way the transit and neighbourhood
 * overlays are committed.
 *
 * FORMAT. wfs.ashx returns one feature with one item whose `geometry`
 * is a comma-separated list of Google encoded polylines (precision 5),
 * one per ring. Rings are NOT grouped into polygons by the API; this
 * script sorts them by signed area — counter-clockwise rings are
 * exteriors, clockwise rings are holes — and assigns each hole to the
 * exterior that contains its first vertex. The pipe character `|`
 * appears inside the encoding (it is a valid polyline byte, value 61)
 * and is NOT a separator; splitting on it corrupts the data.
 *
 * ---- REFRESH CADENCE ----
 * Quarterly, with the other static assets (r/refresh_assets.ps1 runs
 * `npm run refresh:walkshed`). The boundary only changes when the City
 * re-cuts the frequent-transit network or amends Schedule AC. The write
 * goes through stableWrite so an unchanged boundary leaves the file and
 * git untouched.
 *
 *   Manually:  cd web && npm run refresh:walkshed
 * --------------------------------------------------------------- */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStable } from './stableWrite.mjs';

const FEATURE_SET_ID = 18787;
const APP_ID = 8; // the legacy Property Map's application id
// Whole-city bounding box, generous on every side. The API clips to it.
const CITY_BBOX = '49.60,-97.60,50.10,-96.80';
const WFS_URL = 'https://mapapi.winnipeg.ca/mapapi/wfs.ashx'
  + `?output=json&maptypeid=2&function=getmapdata&scale=50000`
  + `&coordinates=${CITY_BBOX}&featurelist=${FEATURE_SET_ID}&aid=${APP_ID}`;
const REFERER = 'https://legacy.winnipeg.ca/ppd/Mapping/PropertyMap/default.stm';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, '..', 'public', 'frequent-transit-walkshed.geojson');

// Sanity envelope: every vertex must land inside greater Winnipeg, or
// the decode has gone wrong (a wrong separator put points near 0,0).
const SANE = { minLon: -97.6, maxLon: -96.8, minLat: 49.6, maxLat: 50.1 };

/** Decode one Google encoded polyline into [lon, lat] pairs. */
export function decodePolyline(enc) {
  const pts = [];
  let i = 0; let lat = 0; let lng = 0;
  while (i < enc.length) {
    for (const which of [0, 1]) {
      let shift = 0; let result = 0; let b;
      do {
        if (i >= enc.length) throw new Error('truncated polyline');
        b = enc.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += d; else lng += d;
    }
    pts.push([Math.round(lng) / 1e5, Math.round(lat) / 1e5]);
  }
  return pts;
}

/** Signed shoelace area in degree²; positive = counter-clockwise. */
function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Group a flat list of rings into GeoJSON polygons: each exterior
 * (CCW) with the holes (CW) whose first vertex it contains. A hole no
 * exterior contains is dropped with a warning rather than promoted to
 * a polygon of its own.
 */
export function assemblePolygons(rings) {
  const closed = rings.map((r) => {
    const [fx, fy] = r[0]; const [lx, ly] = r[r.length - 1];
    return fx === lx && fy === ly ? r : [...r, r[0]];
  }).filter((r) => r.length >= 4);
  const exteriors = []; const holes = [];
  for (const r of closed) (signedArea(r) > 0 ? exteriors : holes).push(r);
  // Largest first so a hole inside a small island inside a big ring
  // attaches to the island, not the big ring.
  exteriors.sort((a, b) => Math.abs(signedArea(a)) - Math.abs(signedArea(b)));
  const polys = exteriors.map((ext) => [ext]);
  let dropped = 0;
  for (const h of holes) {
    const owner = polys.find(([ext]) => pointInRing(h[0], ext));
    if (owner) owner.push(h); else dropped++;
  }
  if (dropped) console.warn(`  ! ${dropped} hole ring(s) matched no exterior and were dropped`);
  return polys;
}

async function main() {
  console.log(`Fetching feature set ${FEATURE_SET_ID} from mapapi.winnipeg.ca ...`);
  const res = await fetch(WFS_URL, { headers: { Referer: REFERER } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from mapapi`);
  const data = await res.json();
  const feature = (data.features || []).find((f) => String(f.id) === String(FEATURE_SET_ID));
  if (!feature) throw new Error('feature set not in response');
  const items = feature.items || [];
  if (items.length === 0) throw new Error('feature set returned no items');
  console.log(`  "${feature.DESCRIPTION}" (${feature.category}); ${items.length} item(s)`);

  const rings = [];
  for (const item of items) {
    for (const enc of String(item.geometry).split(',')) if (enc) rings.push(decodePolyline(enc));
  }
  for (const r of rings) for (const [lon, lat] of r) {
    if (lon < SANE.minLon || lon > SANE.maxLon || lat < SANE.minLat || lat > SANE.maxLat) {
      throw new Error(`vertex ${lon},${lat} outside Winnipeg - decode is wrong, refusing to write`);
    }
  }
  const polygons = assemblePolygons(rings);
  const nHoles = polygons.reduce((n, p) => n + p.length - 1, 0);
  console.log(`  ${rings.length} rings -> ${polygons.length} polygons, ${nHoles} holes`);
  if (polygons.length === 0) throw new Error('no polygons assembled');

  const fc = {
    type: 'FeatureCollection',
    _meta: {
      source: 'City of Winnipeg map API, feature set 18787 ("WalkShed 800m"), as drawn on the legacy PP&D Property Map',
      source_url: 'https://legacy.winnipeg.ca/ppd/Mapping/PropertyMap/default.stm',
      legend_title: 'Winnipeg Zoning Schedule AC Map 2 (800m walking distance of frequent transit)',
      bylaw: 'Winnipeg Zoning By-law 200/2006, Schedule AC (added by By-law 59/2025)',
      generated_at: new Date().toISOString(),
    },
    features: [{
      type: 'Feature',
      properties: {
        name: 'Schedule AC Map 2',
        description: 'Within 800 m walking distance of frequent transit',
        feature_set_id: FEATURE_SET_ID,
      },
      geometry: { type: 'MultiPolygon', coordinates: polygons },
    }],
  };
  const result = await writeStable(OUT, fc);
  console.log(`  ${path.basename(OUT)}: ${result.reason}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
