#!/usr/bin/env node
/*
 * build-neighbourhoods-geojson.mjs
 * ---------------------------------------------------------------
 * One-off processor for the two Winnipeg neighbourhood overlays.
 * Reads the source GeoJSON from a hand-maintained appraisal base
 * folder, strips redundant properties, and writes the cleaned
 * outputs into web/public/ where the map can fetch them at runtime.
 *
 * Cadence: rarely. Neighbourhood boundaries are on a decade-scale
 * stable; re-run only if Jason updates the BaseFiles or the City
 * publishes a new boundary set.
 *
 * Trigger:
 *   - Default source path:  D:\Dropbox\Appraisal\RProjects\BaseFiles\
 *   - Override via CLI arg: node build-neighbourhoods-geojson.mjs <src-dir>
 *   - npm:                  npm run refresh:neighbourhoods
 *
 * Source columns we keep:
 *   Neighbourhoods (235):
 *     - Name         (string)         neighbourhood name
 *     - Cluster      (string)         parent cluster name
 *     - ID           (number)         City Open Data ID
 *   Clusters (23):
 *     - cluster      (string)         cluster name
 *     - neighbourhood_count (number)  how many hoods inside it
 *     - neighbourhoods (string)       semi-colon list of hood names
 *
 * Source columns we drop:
 *   - Location (WKT string duplicating the geometry — ~50% of file)
 *   - lon / lat (centroid; MapLibre derives one for symbol layers)
 * --------------------------------------------------------------- */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_WEB = path.resolve(SCRIPT_DIR, '..');
const PUBLIC_DIR = path.join(REPO_WEB, 'public');

const DEFAULT_SRC = String.raw`D:\Dropbox\Appraisal\RProjects\BaseFiles`;
const srcDir = process.argv[2] || DEFAULT_SRC;

const SRC_HOODS    = path.join(srcDir, 'WpgNeighbourhoods.geojson');
const SRC_CLUSTERS = path.join(srcDir, 'WpgNeighbourhoodClusters.geojson');
const OUT_HOODS    = path.join(PUBLIC_DIR, 'wpg-neighbourhoods.geojson');
const OUT_CLUSTERS = path.join(PUBLIC_DIR, 'wpg-neighbourhood-clusters.geojson');

async function processHoods() {
  console.log(`Reading ${SRC_HOODS}`);
  const raw = JSON.parse(await readFile(SRC_HOODS, 'utf-8'));
  if (raw.type !== 'FeatureCollection') throw new Error('Expected FeatureCollection');
  const features = raw.features.map((f) => ({
    type: 'Feature',
    geometry: f.geometry,
    // Keep only the props the map actually reads. Drop the giant
    // Location WKT string (duplicates the geometry) and the
    // pre-computed lon/lat centroid (MapLibre picks one for us).
    properties: {
      id: f.properties?.ID ?? null,
      name: f.properties?.Name ?? '',
      cluster: f.properties?.Cluster ?? '',
    },
  }));
  // Sort alphabetically so any diff against a future regen is
  // a clean line-by-line comparison rather than file-order noise.
  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  return {
    type: 'FeatureCollection',
    features,
    _meta: {
      source: SRC_HOODS,
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

async function processClusters() {
  console.log(`Reading ${SRC_CLUSTERS}`);
  const raw = JSON.parse(await readFile(SRC_CLUSTERS, 'utf-8'));
  if (raw.type !== 'FeatureCollection') throw new Error('Expected FeatureCollection');
  const features = raw.features.map((f) => ({
    type: 'Feature',
    geometry: cleanPolygon(f.geometry),
    properties: {
      cluster: f.properties?.cluster ?? '',
      neighbourhood_count: Number(f.properties?.neighbourhood_count ?? 0),
      neighbourhoods: f.properties?.neighbourhoods ?? '',
    },
  }));
  features.sort((a, b) => a.properties.cluster.localeCompare(b.properties.cluster));
  return {
    type: 'FeatureCollection',
    features,
    _meta: {
      source: SRC_CLUSTERS,
      generated_at: new Date().toISOString(),
      cluster_count: features.length,
    },
  };
}

async function main() {
  const [hoods, clusters] = await Promise.all([processHoods(), processClusters()]);
  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(OUT_HOODS,    JSON.stringify(hoods));
  await writeFile(OUT_CLUSTERS, JSON.stringify(clusters));
  const hoodSize = (await readFile(OUT_HOODS)).length;
  const clusterSize = (await readFile(OUT_CLUSTERS)).length;
  console.log('');
  console.log('Wrote:');
  console.log(`  ${OUT_HOODS}    (${(hoodSize / 1024).toFixed(0)} KB, ${hoods.features.length} neighbourhoods)`);
  console.log(`  ${OUT_CLUSTERS} (${(clusterSize / 1024).toFixed(0)} KB, ${clusters.features.length} clusters)`);
}

main().catch((err) => {
  console.error('\nbuild-neighbourhoods-geojson failed:', err);
  process.exit(1);
});
