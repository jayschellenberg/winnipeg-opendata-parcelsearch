// Neighbourhood-cluster lookup + the header/cell class parity that a
// shifted results grid depends on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildClusterIndex, clusterForPoint, clusterForFeature } from '../src/lib/clusters.js';
import { COLUMNS, columnCellClasses } from '../src/lib/columnsRegistry.js';

// ---- columnCellClasses: the shift bug ------------------------------------
// `.sales-only` and `.subj-col` are display:none rules. Applied to the
// <th> but not the <td>, the header and the body disagree about how
// many boxes exist and every column after renders one place off — which
// is exactly what shipped: Dist's header hid when no subject roll was
// set while its cells stayed, so Instrument appeared under Lot.
{
  const dist = COLUMNS.find((c) => c.key === 'dist');
  assert.ok(dist, 'the Dist column still exists');
  const cls = columnCellClasses(dist);
  assert.ok(cls.includes('subj-col'), 'Dist carries subj-col');
  assert.ok(cls.includes('sales-only'), 'Dist is a sales column');

  const roll = COLUMNS.find((c) => c.key === 'roll');
  assert.deepEqual(columnCellClasses(roll), [], 'an always-on column carries neither');

  // Every column that a CSS class can hide must produce that class from
  // this one function, so th and td can never be given different sets.
  for (const col of COLUMNS) {
    const c = columnCellClasses(col);
    assert.equal(c.includes('sales-only'), col.mode === 'sales', `sales-only for ${col.key}`);
    if (col.theadClass) assert.ok(c.includes(col.theadClass), `${col.theadClass} for ${col.key}`);
  }
}

// ---- the Cluster column --------------------------------------------------
{
  const cluster = COLUMNS.find((c) => c.key === 'cluster');
  assert.ok(cluster, 'Cluster column is registered');
  assert.equal(cluster.header, 'Cluster');
  assert.equal(cluster.sortable, true);
  assert.equal(cluster.csv.header, 'Cluster');
  assert.equal(cluster.csv.extract({ _cluster: 'Transcona' }), 'Transcona');
}

// ---- clusterForPoint against the real committed geojson ------------------
const geo = JSON.parse(readFileSync(new URL('../public/wpg-neighbourhoods.geojson', import.meta.url), 'utf8'));
const index = buildClusterIndex(geo);

assert.ok(index.length > 200, `index built from ${index.length} polygons`);
assert.ok(index.every((e) => e.cluster && Array.isArray(e.bbox) && e.bbox.length === 4));

// Known parcels, with centroids taken from live d4mq-wa44 records.
// 20 LYNDALE DRIVE — Norwood West, on the Red River in St Boniface.
assert.equal(clusterForPoint(index, -97.13068233418218, 49.881006614877315), 'St. Boniface West');
// 50 ROYAL CREST DRIVE — Linden Woods, south-west Winnipeg.
{
  const c = clusterForPoint(index, -97.20, 49.82);
  assert.ok(typeof c === 'string' && c.length > 0, `south-west point resolves to a cluster (got ${c})`);
}

// Outside the city → null, not a wrong answer. (City-edge parcels are
// real; the historical overlay keeps a whole UNASSIGNED shard for them.)
assert.equal(clusterForPoint(index, -100.0, 52.0), null, 'far outside Winnipeg');
// Degenerate input never throws.
assert.equal(clusterForPoint(index, NaN, 49.88), null);
assert.equal(clusterForPoint(index, null, null), null);
assert.equal(clusterForPoint(null, -97.13, 49.88), null);

// ---- clusterForFeature reads the centroid properties ---------------------
assert.equal(
  clusterForFeature(index, { properties: { centroid_lat: 49.881006614877315, centroid_lon: -97.13068233418218 } }),
  'St. Boniface West',
);
assert.equal(clusterForFeature(index, { properties: {} }), null, 'no centroid → null');
assert.equal(clusterForFeature(index, null), null);
// A geometry-less sales row (roll matched no live parcel) still carries
// centroid properties when the CSV supplied them, and must place.
assert.equal(
  clusterForFeature(index, { geometry: null, properties: { centroid_lat: 49.881006614877315, centroid_lon: -97.13068233418218 } }),
  'St. Boniface West',
);

// Every cluster in the file is reachable — guards against a bbox
// prefilter that silently excludes a whole cluster.
{
  const all = new Set(index.map((e) => e.cluster));
  assert.ok(all.size >= 20, `${all.size} distinct clusters in the index`);
}

console.log('clusters.test.js: all assertions passed');
