#!/usr/bin/env node
/*
 * build-neighbourhoods-geojson.mjs
 * ---------------------------------------------------------------
 * Builds the two Winnipeg neighbourhood overlays into web/public/.
 *
 *   Neighbourhoods: fetched LIVE from the City's Open Data
 *     "Neighbourhoods" dataset (8k6x-xxsy). Until 2026-09-23 this read
 *     a hand-kept copy (base-files/WpgNeighbourhoods.geojson) that was
 *     older than the City's set and left 119 assessed parcels in no
 *     neighbourhood at all (117 gaps over 2,000 m2, the one Jason found
 *     along Selkirk Ave in William Whyte) and 192 in two at once. That
 *     copy was then deleted from appraisal-templates (53f56b2), which
 *     would have broken the quarterly refresh. Checked 2026-09-23 against
 *     all 245,324 assessed parcels: the City set leaves 1 outside (at the
 *     city limit), 0 overlapping, and no gap bigger than 100 m2.
 *
 *   Clusters (23): still the appraisal base file
 *     base-files/WpgNeighbourhoodClusters.geojson, shared with the R
 *     templates. Its polygons are kept as they are (they cover every
 *     assessed parcel); its membership lists are REBUILT here from the
 *     cluster each City neighbourhood actually sits in, so the popup's
 *     list and the sales cluster filter agree with the map.
 *
 * A neighbourhood's cluster is the cluster polygon holding most of its
 * area. Every City neighbourhood sat at least 97% inside one cluster on
 * 2026-09-23, so the choice is never close; the build prints any that
 * fall below that and fails on one outside every cluster.
 *
 * Cadence: run by the quarterly WpgAssetRefreshQuarterly task
 * (r/refresh_assets.ps1), which commits only when the output changes.
 *
 * Trigger:
 *   - Default clusters path: D:\Dropbox\Appraisal\RProjects\appraisal-templates\base-files\
 *   - Override via CLI arg:  node build-neighbourhoods-geojson.mjs <src-dir>
 *   - npm:                   npm run refresh:neighbourhoods
 *
 * Output properties:
 *   Neighbourhoods: id (City id), name (City name), cluster
 *   Clusters:       cluster, neighbourhood_count, neighbourhoods ("; " list)
 * --------------------------------------------------------------- */

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import area from '@turf/area';
import intersect from '@turf/intersect';
import { writeStable } from './stableWrite.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_WEB = path.resolve(SCRIPT_DIR, '..');
const PUBLIC_DIR = path.join(REPO_WEB, 'public');

const DEFAULT_SRC = String.raw`D:\Dropbox\Appraisal\RProjects\appraisal-templates\base-files`;
const srcDir = process.argv[2] || DEFAULT_SRC;

const CITY_DATASET = '8k6x-xxsy';
const CITY_HOODS_URL = `https://data.winnipeg.ca/resource/${CITY_DATASET}.geojson?$limit=5000`;
const SRC_CLUSTERS = path.join(srcDir, 'WpgNeighbourhoodClusters.geojson');
const OUT_HOODS    = path.join(PUBLIC_DIR, 'wpg-neighbourhoods.geojson');
const OUT_CLUSTERS = path.join(PUBLIC_DIR, 'wpg-neighbourhood-clusters.geojson');

// A neighbourhood less than this share inside its best cluster is printed,
// so a City boundary change that straddles two clusters gets looked at.
const CLUSTER_FIT_WARN = 0.97;

async function fetchCityHoods() {
  console.log(`Fetching ${CITY_HOODS_URL}`);
  const res = await fetch(CITY_HOODS_URL);
  if (!res.ok) throw new Error(`City neighbourhoods: HTTP ${res.status}`);
  const raw = await res.json();
  if (raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('City neighbourhoods: expected a FeatureCollection');
  }
  // The City set has ~237. Far fewer means a truncated or broken response,
  // and publishing it would open exactly the gaps this build exists to close.
  if (raw.features.length < 200) {
    throw new Error(`City neighbourhoods: only ${raw.features.length} features, refusing to publish`);
  }
  return raw.features;
}

/** The cluster holding most of `hood`'s area, and that share. */
function bestCluster(hood, clusters) {
  const total = area(hood);
  let best = { name: null, share: 0 };
  for (const c of clusters) {
    let inter = null;
    try { inter = intersect({ type: 'FeatureCollection', features: [hood, c] }); } catch { inter = null; }
    if (!inter) continue;
    const share = area(inter) / total;
    if (share > best.share) best = { name: c.properties.cluster, share };
  }
  return best;
}

async function readClusterPolygons() {
  console.log(`Reading ${SRC_CLUSTERS}`);
  const raw = JSON.parse(await readFile(SRC_CLUSTERS, 'utf-8'));
  if (raw.type !== 'FeatureCollection') throw new Error('Expected FeatureCollection');
  return raw.features.map((f) => ({
    type: 'Feature',
    geometry: cleanPolygon(f.geometry),
    properties: { cluster: f.properties?.cluster ?? '' },
  }));
}

function processHoods(cityFeatures, clusterPolys) {
  const features = [];
  for (const f of cityFeatures) {
    const name = String(f.properties?.name ?? '').trim();
    const best = bestCluster(f, clusterPolys);
    if (!best.name) throw new Error(`Neighbourhood ${name} lies outside every cluster`);
    if (best.share < CLUSTER_FIT_WARN) {
      console.warn(`  ! ${name}: only ${(best.share * 100).toFixed(1)}% inside ${best.name}`);
    }
    features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        id: f.properties?.id != null ? Number(f.properties.id) : null,
        name,
        cluster: best.name,
      },
    });
  }
  // Sorted, so a future regen diffs line by line rather than by file order.
  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  return {
    type: 'FeatureCollection',
    features,
    _meta: {
      source: `City of Winnipeg Open Data, Neighbourhoods (${CITY_DATASET})`,
      generated_at: new Date().toISOString(),
      neighbourhood_count: features.length,
    },
  };
}

// Signed-area shoelace. Negative = clockwise (hole in GeoJSON);
// positive = counter-clockwise (outer ring). Used to clean
// degenerate/zero-area sub-rings out of the cluster polygons.
function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/**
 * Clean a Polygon geometry: drop degenerate rings (<4 unique
 * points or zero area). The R-pipeline that produced the source
 * file collapsed some MultiPolygons into Polygons with tiny
 * degenerate sub-rings that MapLibre treats as holes — which can
 * make a feature render as almost-invisible. This strips them so
 * the visible polygon matches what's actually drawn on the City
 * system map.
 */
function cleanPolygon(geom) {
  if (geom.type !== 'Polygon') return geom;
  const kept = [];
  for (const ring of geom.coordinates) {
    if (ring.length < 4) continue;
    const area = Math.abs(ringSignedArea(ring));
    if (area < 1e-8) continue;
    kept.push(ring);
  }
  if (kept.length === 0) return geom;
  return { type: 'Polygon', coordinates: kept };
}

function processClusters(clusterPolys, hoods) {
  // Membership rebuilt from the neighbourhoods' own cluster assignment, so a
  // neighbourhood is listed under exactly one cluster (the base file listed
  // Airport under both St. James clusters) and new City neighbourhoods show.
  const members = new Map();
  for (const h of hoods.features) {
    const list = members.get(h.properties.cluster) || [];
    list.push(h.properties.name);
    members.set(h.properties.cluster, list);
  }
  const features = clusterPolys.map((f) => {
    const list = (members.get(f.properties.cluster) || []).sort((x, y) => x.localeCompare(y));
    return {
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        cluster: f.properties.cluster,
        neighbourhood_count: list.length,
        neighbourhoods: list.join('; '),
      },
    };
  });
  features.sort((a, b) => a.properties.cluster.localeCompare(b.properties.cluster));
  return {
    type: 'FeatureCollection',
    features,
    _meta: {
      // Filename only: this ships on the public site, so no local paths.
      source: path.basename(SRC_CLUSTERS),
      generated_at: new Date().toISOString(),
      cluster_count: features.length,
    },
  };
}

async function main() {
  const [cityFeatures, clusterPolys] = await Promise.all([fetchCityHoods(), readClusterPolygons()]);
  const hoods = processHoods(cityFeatures, clusterPolys);
  const clusters = processClusters(clusterPolys, hoods);
  await mkdir(PUBLIC_DIR, { recursive: true });
  // writeStable, not writeFile: an unchanged rebuild must not rewrite the file
  // just because generated_at moved. See scripts/stableWrite.mjs.
  const hoodRes = await writeStable(OUT_HOODS, hoods);
  const clusterRes = await writeStable(OUT_CLUSTERS, clusters);
  const hoodSize = (await readFile(OUT_HOODS)).length;
  const clusterSize = (await readFile(OUT_CLUSTERS)).length;
  console.log('');
  console.log(`  ${OUT_HOODS}    (${(hoodSize / 1024).toFixed(0)} KB, ${hoods.features.length} neighbourhoods) ${hoodRes.reason}`);
  console.log(`  ${OUT_CLUSTERS} (${(clusterSize / 1024).toFixed(0)} KB, ${clusters.features.length} clusters) ${clusterRes.reason}`);
}

main().catch((err) => {
  console.error('\nbuild-neighbourhoods-geojson failed:', err);
  process.exit(1);
});
