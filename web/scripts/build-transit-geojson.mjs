#!/usr/bin/env node
/*
 * build-transit-geojson.mjs
 * ---------------------------------------------------------------
 * Downloads the Winnipeg Transit static GTFS feed and converts it
 * into two browser-ready GeoJSON files that ship as static assets
 * under web/public/:
 *
 *   - transit-routes.geojson  (one MultiLineString per route, with
 *                              the agency's official route_color)
 *   - transit-stops.geojson   (one Point per stop, with stop_code,
 *                              name, and the list of route short
 *                              names that serve it)
 *
 * Zero npm deps. Uses Node's built-in `fetch` to download the
 * zip and the OS `tar` command (Windows 10+ and every Linux/Mac
 * tar supports zip files) to extract it. CSV parsing is a tiny
 * inline implementation that handles the quoted-field cases GTFS
 * actually uses.
 *
 * ---- REFRESH CADENCE ----
 * Run monthly. Winnipeg Transit publishes ~4 board-period changes
 * per year (roughly late Jan / Apr / Jun / Aug) plus mid-period
 * diversions; a monthly cron never lets the layer drift more than
 * ~4 weeks stale, which is good enough for an appraisal tool that
 * doesn't ride real-time bus positions. The rebuild downloads
 * ~5 MB and finishes in well under a minute.
 *
 * Trigger:
 *   - Manually:  cd web && npm run refresh:transit
 *   - Scheduled: hook into the same Task Scheduler job as the MAO
 *                refresh; the script is idempotent, just
 *                overwrites the two .geojson files in place.
 * --------------------------------------------------------------- */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { writeStable } from './stableWrite.mjs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const GTFS_URL = 'https://gtfs.winnipegtransit.com/google_transit.zip';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_WEB = path.resolve(SCRIPT_DIR, '..');
const PUBLIC_DIR = path.join(REPO_WEB, 'public');
const OUT_ROUTES = path.join(PUBLIC_DIR, 'transit-routes.geojson');
const OUT_STOPS = path.join(PUBLIC_DIR, 'transit-stops.geojson');

// ---------- tiny CSV parser ----------

/**
 * Parse a single CSV line. Handles GTFS's typical patterns:
 *   - unquoted fields
 *   - quoted fields containing commas
 *   - escaped quotes ("")
 * Returns an array of strings.
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') { inQuote = true; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Read an entire small GTFS file (routes.txt, trips.txt, stops.txt)
 * into memory and parse it into an array of row objects keyed by
 * the header row.
 */
async function readCsv(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  // Strip UTF-8 BOM if present — GTFS feeds sometimes ship with one.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = fields[j] ?? '';
    rows.push(row);
  }
  return rows;
}

/**
 * Stream-process stop_times.txt — by far the largest GTFS file
 * (often 50-200 MB). For each line we pull trip_id + stop_id and
 * call onRow(). Avoids loading the whole file into memory.
 */
async function streamCsv(filePath, onRow) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let headers = null;
  for await (const rawLine of rl) {
    // Strip BOM from the very first line if present.
    const line = headers === null && rawLine.charCodeAt(0) === 0xfeff
      ? rawLine.slice(1)
      : rawLine;
    if (!line) continue;
    if (headers === null) {
      headers = parseCsvLine(line).map((h) => h.trim());
      continue;
    }
    const fields = parseCsvLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = fields[j] ?? '';
    onRow(row);
  }
}

// ---------- pipeline ----------

async function download(url, dest) {
  process.stdout.write(`Downloading ${url} ... `);
  const t0 = Date.now();
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  const mb = (buf.length / 1024 / 1024).toFixed(2);
  console.log(`done (${mb} MB in ${Date.now() - t0} ms)`);
}

async function extract(zipPath, destDir) {
  process.stdout.write(`Extracting to ${destDir} ... `);
  // Cross-platform extraction without any npm deps. On Windows we
  // use PowerShell's Expand-Archive because the bash-shipped GNU
  // tar parses "C:..." as a remote-host spec. On other platforms
  // we fall through to `unzip` (universally available) then tar.
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
  } else {
    try {
      await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', destDir]);
    } catch {
      // Fallback: BSD/GNU tar on macOS + most Linux distros also
      // handles zip files via libarchive.
      await execFileAsync('tar', ['-xf', zipPath, '-C', destDir]);
    }
  }
  console.log('done');
}

// Relative luminance per WCAG. Used to detect routes whose
// route_color is too light to render against the white-ish
// Carto Positron basemap — Winnipeg Transit encodes service
// type via colour and uses white (#ffffff) for locals and a
// cream (#fff0d8) for express, both of which disappear on the
// map. We swap those for a visible fallback below.
function relLuminance(r, g, b) {
  const toLin = (c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

// Fallback colour used when GTFS gives us white/near-white or a
// missing value. Mid-grey reads well on Carto Positron and on
// Esri Imagery and matches Winnipeg Transit's own system-map
// convention of drawing locals in grey.
const FALLBACK_ROUTE_COLOR = '#6b7280';

function ensureHexColor(hex) {
  // GTFS route_color is a 6-char hex string without the leading
  // '#'. Missing/invalid → fallback grey. Too-light → fallback
  // grey so the line is actually visible on the map.
  if (!hex || typeof hex !== 'string') return FALLBACK_ROUTE_COLOR;
  const clean = hex.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return FALLBACK_ROUTE_COLOR;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (relLuminance(r, g, b) > 0.8) return FALLBACK_ROUTE_COLOR;
  return `#${clean.toLowerCase()}`;
}

function ensureTextColor(hex) {
  if (!hex || typeof hex !== 'string') return '#ffffff';
  const clean = hex.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '#ffffff';
  return `#${clean.toLowerCase()}`;
}

async function buildRoutesAndStops(gtfsDir) {
  console.log('Parsing GTFS tables...');
  const [routes, trips, stops] = await Promise.all([
    readCsv(path.join(gtfsDir, 'routes.txt')),
    readCsv(path.join(gtfsDir, 'trips.txt')),
    readCsv(path.join(gtfsDir, 'stops.txt')),
  ]);
  console.log(`  routes.txt : ${routes.length} rows`);
  console.log(`  trips.txt  : ${trips.length} rows`);
  console.log(`  stops.txt  : ${stops.length} rows`);

  // ---- shapes.txt: shape_id -> ordered array of [lon, lat] ----
  console.log('Parsing shapes.txt (streaming)...');
  const shapePts = new Map(); // shape_id -> [{seq, lon, lat}, ...]
  await streamCsv(path.join(gtfsDir, 'shapes.txt'), (row) => {
    const id = row.shape_id;
    if (!id) return;
    const lat = Number(row.shape_pt_lat);
    const lon = Number(row.shape_pt_lon);
    const seq = Number(row.shape_pt_sequence);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    let arr = shapePts.get(id);
    if (!arr) { arr = []; shapePts.set(id, arr); }
    arr.push({ seq, lon, lat });
  });
  // Sort each shape by its sequence column. GTFS doesn't guarantee
  // file order, even though most agencies write it sorted.
  for (const arr of shapePts.values()) arr.sort((a, b) => a.seq - b.seq);
  console.log(`  shapes     : ${shapePts.size} distinct shape_ids`);

  // ---- trip_id -> route_id, route_id -> Set<shape_id> ----
  const tripToRoute = new Map();
  const routeToShapes = new Map(); // route_id -> Set<shape_id>
  for (const t of trips) {
    if (!t.trip_id || !t.route_id) continue;
    tripToRoute.set(t.trip_id, t.route_id);
    if (t.shape_id) {
      let s = routeToShapes.get(t.route_id);
      if (!s) { s = new Set(); routeToShapes.set(t.route_id, s); }
      s.add(t.shape_id);
    }
  }

  // ---- stop_times.txt: derive route_id -> Set<stop_id> ----
  console.log('Streaming stop_times.txt (this is the big one)...');
  const t0 = Date.now();
  let stRows = 0;
  const routeToStops = new Map(); // route_id -> Set<stop_id>
  await streamCsv(path.join(gtfsDir, 'stop_times.txt'), (row) => {
    stRows++;
    const routeId = tripToRoute.get(row.trip_id);
    if (!routeId || !row.stop_id) return;
    let s = routeToStops.get(routeId);
    if (!s) { s = new Set(); routeToStops.set(routeId, s); }
    s.add(row.stop_id);
  });
  console.log(`  stop_times : ${stRows.toLocaleString()} rows in ${Date.now() - t0} ms`);

  // ---- Invert: stop_id -> Set<route_short_name> ----
  const routeShort = new Map(); // route_id -> short_name
  for (const r of routes) routeShort.set(r.route_id, r.route_short_name || r.route_id);
  const stopToRoutes = new Map(); // stop_id -> Set<short_name>
  for (const [routeId, stopSet] of routeToStops) {
    const short = routeShort.get(routeId) ?? routeId;
    for (const stopId of stopSet) {
      let s = stopToRoutes.get(stopId);
      if (!s) { s = new Set(); stopToRoutes.set(stopId, s); }
      s.add(short);
    }
  }

  // ---- Build routes FeatureCollection ----
  // Each route gets one MultiLineString combining every distinct
  // shape used by any of its trips. Empty-geometry routes (rare —
  // happens when no trip references a shape) are dropped.
  const routeFeatures = [];
  for (const r of routes) {
    const shapes = routeToShapes.get(r.route_id);
    if (!shapes || shapes.size === 0) continue;
    const lines = [];
    for (const shapeId of shapes) {
      const pts = shapePts.get(shapeId);
      if (!pts || pts.length < 2) continue;
      lines.push(pts.map((p) => [p.lon, p.lat]));
    }
    if (lines.length === 0) continue;
    routeFeatures.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: lines },
      properties: {
        route_id: r.route_id,
        route_short_name: r.route_short_name || '',
        route_long_name: r.route_long_name || '',
        route_color: ensureHexColor(r.route_color),
        route_text_color: ensureTextColor(r.route_text_color),
      },
    });
  }
  routeFeatures.sort((a, b) => {
    // Sort by numeric short_name when possible so rendering order
    // matches the schedule book; alphabetical fallback for letter
    // routes like BLUE / W14.
    const an = Number(a.properties.route_short_name);
    const bn = Number(b.properties.route_short_name);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return String(a.properties.route_short_name).localeCompare(String(b.properties.route_short_name));
  });

  // ---- Build stops FeatureCollection ----
  // Skip station parents (location_type === '1') — those are
  // grouping nodes for terminals and don't represent boardable
  // stops. Sort the routes-serving list numerically so the popup
  // reads "1, 11, 36" not "1, 11, 14".
  const stopFeatures = [];
  for (const s of stops) {
    if (s.location_type && String(s.location_type) === '1') continue;
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const servingRoutes = Array.from(stopToRoutes.get(s.stop_id) ?? [])
      .sort((a, b) => {
        const an = Number(a);
        const bn = Number(b);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
        return String(a).localeCompare(String(b));
      });
    stopFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        stop_id: s.stop_id,
        stop_code: s.stop_code || '',
        stop_name: s.stop_name || '',
        routes: servingRoutes.join(', '),
      },
    });
  }

  return {
    routes: {
      type: 'FeatureCollection',
      features: routeFeatures,
      // Embed the source timestamp + provenance so a downstream
      // consumer (or curious developer) can tell when the file
      // was last regenerated without digging through git history.
      _meta: {
        source: GTFS_URL,
        generated_at: new Date().toISOString(),
        route_count: routeFeatures.length,
      },
    },
    stops: {
      type: 'FeatureCollection',
      features: stopFeatures,
      _meta: {
        source: GTFS_URL,
        generated_at: new Date().toISOString(),
        stop_count: stopFeatures.length,
      },
    },
  };
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wpg-gtfs-'));
  const zipPath = path.join(tmp, 'google_transit.zip');
  try {
    await download(GTFS_URL, zipPath);
    await extract(zipPath, tmp);
    const { routes, stops } = await buildRoutesAndStops(tmp);
    await mkdir(PUBLIC_DIR, { recursive: true });
    // writeStable, not writeFile: an unchanged rebuild must not rewrite the
    // file just because generated_at moved. See scripts/stableWrite.mjs.
    const routesRes = await writeStable(OUT_ROUTES, routes);
    const stopsRes = await writeStable(OUT_STOPS, stops);
    const routesBytes = (await readFile(OUT_ROUTES)).length;
    const stopsBytes = (await readFile(OUT_STOPS)).length;
    console.log('');
    console.log(`  ${OUT_ROUTES}  (${(routesBytes / 1024).toFixed(0)} KB, ${routes.features.length} routes) ${routesRes.reason}`);
    console.log(`  ${OUT_STOPS}   (${(stopsBytes / 1024).toFixed(0)} KB, ${stops.features.length} stops) ${stopsRes.reason}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nbuild-transit-geojson failed:', err);
  process.exit(1);
});
