// Esri satellite zoom limits (2026-11-25, the Manitoba app's fix). The layer
// must stay on to the map's max zoom (at 20 it switched off and Satellite went
// blank), and the source must not fetch past z19, where Esri has only grey
// "Map data not yet available" tiles beyond the built-up city.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapSrc = readFileSync(path.join(here, '..', 'src', 'map.js'), 'utf8');

const srcAt = mapSrc.indexOf("'esri-imagery': {");
assert.ok(srcAt >= 0, 'esri-imagery source not found');
const srcMax = Number(mapSrc.slice(srcAt, srcAt + 1200).match(/maxzoom: (\d+)/)?.[1]);
assert.ok(Number.isFinite(srcMax) && srcMax <= 19, `esri-imagery source maxzoom must be set and at most 19 (got ${srcMax})`);

const layerAt = mapSrc.indexOf("id: 'esri-imagery',");
assert.ok(layerAt >= 0, 'esri-imagery layer not found');
const layerMax = Number(mapSrc.slice(layerAt, layerAt + 600).match(/maxzoom: (\d+)/)?.[1]);
assert.ok(Number.isFinite(layerMax) && layerMax >= 22, `esri-imagery layer maxzoom must reach the map's max zoom 22 (got ${layerMax})`);

console.log('satelliteZoom.test.js: 2 passed');
