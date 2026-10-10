#!/usr/bin/env node
/*
 * build-legacy-map-geojson.mjs
 * ---------------------------------------------------------------
 * Pulls vector layers off the City's legacy PP&D Property Map
 * (legacy.winnipeg.ca/ppd/Mapping/PropertyMap) and ships each as a
 * static GeoJSON under web/public/. Today:
 *
 *   frequent-transit-walkshed.geojson  (feature set 18787, "WalkShed 800m")
 *     Winnipeg Zoning Schedule AC Map 2: the land within 800 m walking
 *     distance of frequent transit, where Schedule AC (added by By-law
 *     59/2025, the Housing Accelerator Fund as-of-right infill amendment)
 *     grants the more permissive low-density infill rights. One feature.
 *
 *   district-planners.geojson          (feature set 18772, "District Planners")
 *     The six planning districts with the City's district planner for
 *     each (name, email, phone). One feature per district.
 *
 * SOURCE. Neither layer is on Winnipeg Open Data (checked 2026-10-09).
 * The legacy map draws them from the City's internal map API, which is
 * JSONP-only, carries no CORS headers and is not in our
 * Content-Security-Policy, so the browser cannot fetch it live. We pull
 * at build time and commit the result, the same way the transit and
 * neighbourhood overlays are committed. The six Infill Guideline Area
 * layers on the same map are WMS-only (no vector); they are traced from
 * the raster by build-infill-areas.py instead.
 *
 * FORMAT. wfs.ashx returns one feature per set with `items`; each item's
 * `geometry` is a comma-separated list of rings, plus whatever attribute
 * columns the set carries. At scale <= 2000 a ring is plain
 * "lat lng lat lng" pairs at full precision; at larger scales it is a
 * Google encoded polyline (precision 5) of the same vertices. Rings are NOT grouped into polygons by the API; this script
 * sorts them by signed area (counter-clockwise = exterior, clockwise =
 * hole) and assigns each hole to the exterior that contains its first
 * vertex. The pipe character `|` appears inside the encoding (it is a
 * valid polyline byte, value 61) and is NOT a separator; splitting on it
 * corrupts the data.
 *
 * ---- REFRESH CADENCE ----
 * Monthly, as Step 9 of the parcel-tile rebuild (r/rebuild_tiles.ps1,
 * WpgParcelTilesMonthly, the 2nd at 03:00): the District Planners layer
 * carries planner names / emails / phones, which change as staff move.
 * The quarterly r/refresh_assets.ps1 runs it too (a no-op if nothing
 * moved). The boundaries change only when the City re-cuts them. Writes
 * go through stableWrite so an unchanged layer leaves its file and git
 * untouched. A decode that lands outside Winnipeg throws and writes
 * nothing.
 *
 *   Manually:  cd web && npm run refresh:legacy-map
 * --------------------------------------------------------------- */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStable } from './stableWrite.mjs';

const APP_ID = 8; // the legacy Property Map's application id
// Whole-city bounding box, generous on every side. The API clips to it.
const CITY_BBOX = '49.60,-97.60,50.10,-96.80';
const REFERER = 'https://legacy.winnipeg.ca/ppd/Mapping/PropertyMap/default.stm';
// scale=500: the API simplifies geometry at larger scales (the downtown
// zoning set returns 10x fewer vertices at scale 8000 than at 2000).
const wfsUrl = (fsid) => 'https://mapapi.winnipeg.ca/mapapi/wfs.ashx'
  + '?output=json&maptypeid=2&function=getmapdata&scale=500'
  + `&coordinates=${CITY_BBOX}&featurelist=${fsid}&aid=${APP_ID}`;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SCRIPT_DIR, '..', 'public');

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

/**
 * The layers to pull. `merge: true` folds every item's rings into ONE
 * MultiPolygon feature (the walkshed is published as one unnamed shape);
 * otherwise each item becomes its own feature, with `props(item)` picking
 * the attributes to keep.
 */
const LAYERS = [
  {
    file: 'frequent-transit-walkshed.geojson',
    fsid: 18787,
    merge: true,
    meta: {
      source: 'City of Winnipeg map API, feature set 18787 ("WalkShed 800m"), as drawn on the legacy PP&D Property Map',
      legend_title: 'Winnipeg Zoning Schedule AC Map 2 (800m walking distance of frequent transit)',
      bylaw: 'Winnipeg Zoning By-law 200/2006, Schedule AC (added by By-law 59/2025)',
    },
    props: () => ({
      name: 'Schedule AC Map 2',
      description: 'Within 800 m walking distance of frequent transit',
      feature_set_id: 18787,
    }),
  },
  {
    file: 'district-planners.geojson',
    fsid: 18772,
    merge: false,
    meta: {
      source: 'City of Winnipeg map API, feature set 18772 ("District Planners"), as drawn on the legacy PP&D Property Map',
      legend_title: 'District Planners',
      contact_index: 'https://www.winnipeg.ca/building-development/city-planning-design/find-district-planner',
    },
    props: (item) => ({
      division: String(item.DIVISION ?? ''),
      name: String(item.DIV_NAME ?? ''),
      planner: String(item.PLANNER ?? ''),
      email: String(item.EMAIL ?? ''),
      phone: String(item.PHONE ?? ''),
      feature_set_id: 18772,
    }),
  },
];

function checkSane(rings) {
  for (const r of rings) for (const [lon, lat] of r) {
    if (lon < SANE.minLon || lon > SANE.maxLon || lat < SANE.minLat || lat > SANE.maxLat) {
      throw new Error(`vertex ${lon},${lat} outside Winnipeg - decode is wrong, refusing to write`);
    }
  }
}

/**
 * One ring from the API. At scale <= 2000 the API sends plain
 * "lat lng lat lng ..." pairs at full precision; at larger scales it sends
 * a Google encoded polyline (1e-5 deg) of the same vertices. We ask for
 * scale 500 and accept either, rounding to 1e-6 deg (~7 cm).
 */
export function parseRing(text) {
  const t = text.trim();
  if (t.includes(' ')) {
    const nums = t.split(/\s+/).map(Number);
    if (nums.length % 2 !== 0 || nums.some((n) => !Number.isFinite(n))) {
      throw new Error('malformed plain-coordinate ring');
    }
    const pts = [];
    for (let i = 0; i < nums.length; i += 2) {
      pts.push([Math.round(nums[i + 1] * 1e6) / 1e6, Math.round(nums[i] * 1e6) / 1e6]);
    }
    return pts;
  }
  return decodePolyline(t);
}

function itemRings(item) {
  const rings = [];
  for (const enc of String(item.geometry).split(',')) if (enc.trim()) rings.push(parseRing(enc));
  checkSane(rings);
  return rings;
}

async function fetchFeatureSet(fsid) {
  const res = await fetch(wfsUrl(fsid), { headers: { Referer: REFERER } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from mapapi for ${fsid}`);
  const data = await res.json();
  const feature = (data.features || []).find((f) => String(f.id) === String(fsid));
  if (!feature) throw new Error(`feature set ${fsid} not in response`);
  if (!feature.items || feature.items.length === 0) throw new Error(`feature set ${fsid} returned no items`);
  return feature;
}

async function buildLayer(layer) {
  console.log(`Fetching feature set ${layer.fsid} from mapapi.winnipeg.ca ...`);
  const feature = await fetchFeatureSet(layer.fsid);
  const items = feature.items;
  console.log(`  "${feature.DESCRIPTION}" (${feature.category}); ${items.length} item(s)`);

  let features;
  if (layer.merge) {
    const rings = items.flatMap(itemRings);
    const polygons = assemblePolygons(rings);
    const nHoles = polygons.reduce((n, p) => n + p.length - 1, 0);
    console.log(`  ${rings.length} rings -> ${polygons.length} polygons, ${nHoles} holes`);
    if (polygons.length === 0) throw new Error('no polygons assembled');
    features = [{
      type: 'Feature',
      properties: layer.props(null),
      geometry: { type: 'MultiPolygon', coordinates: polygons },
    }];
  } else {
    features = items.map((item) => {
      const polygons = assemblePolygons(itemRings(item));
      if (polygons.length === 0) throw new Error(`item ${item.ID} of ${layer.fsid}: no polygons assembled`);
      return {
        type: 'Feature',
        properties: layer.props(item),
        geometry: polygons.length === 1
          ? { type: 'Polygon', coordinates: polygons[0] }
          : { type: 'MultiPolygon', coordinates: polygons },
      };
    });
    console.log(`  ${features.length} feature(s)`);
  }

  const fc = {
    type: 'FeatureCollection',
    _meta: {
      ...layer.meta,
      source_url: 'https://legacy.winnipeg.ca/ppd/Mapping/PropertyMap/default.stm',
      generated_at: new Date().toISOString(),
    },
    features,
  };
  const out = path.join(PUBLIC_DIR, layer.file);
  const result = await writeStable(out, fc);
  console.log(`  ${layer.file}: ${result.reason}`);
}

async function main() {
  let failed = 0;
  for (const layer of LAYERS) {
    try { await buildLayer(layer); }
    catch (err) { failed++; console.error(`  ! ${layer.file}: ${err.message || err}`); }
  }
  if (failed) throw new Error(`${failed} layer(s) failed; the others were written`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
