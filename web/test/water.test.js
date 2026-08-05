// Water influence, parsed from the City's own property_influences field.
//
// The load-bearing assertions: ADJACENT and INFLUENCE stay distinct
// (frontage vs across-the-road are different markets), COMMERCIAL
// ADJACENT never reads as water, and the three states — classified /
// checked-and-none / never-checked — never collapse into each other.
import assert from 'node:assert/strict';
import {
  parseWaterInfluence,
  waterOf,
  waterLoaded,
  waterClass,
  isWaterfront,
  isNearWater,
  waterColor,
  waterCellText,
  waterTooltip,
  waterSortRank,
  waterCsvCells,
  waterTokens,
  WATER_CLASSES,
  WATER_BODIES,
} from '../src/lib/water.js';

// ---- the frontage split ---------------------------------------------------
const adj = parseWaterInfluence('RED RIVER ADJACENT');
const inf = parseWaterInfluence('PARK,RED RIVER INFLUENCE');

assert.equal(adj.classKey, 'Adjacent');
assert.equal(adj.body, 'Red River');
assert.equal(adj.frontage, true);
assert.equal(isWaterfront(adj), true);
assert.equal(isNearWater(adj), false);

// The Lyndale Drive case: same river, no frontage. These must never
// fold together — a lot on the river and a lot across the road from it
// are not comparable.
assert.equal(inf.classKey, 'Influence');
assert.equal(inf.body, 'Red River');
assert.equal(inf.frontage, false);
assert.equal(isWaterfront(inf), false);
assert.equal(isNearWater(inf), true);
assert.notEqual(waterColor(adj), waterColor(inf));

// Frontage takes the dark end of the ramp.
assert.equal(waterClass(adj).frontage, true);
assert.equal(waterClass(inf).frontage, false);

// ---- non-water tokens in the same field ----------------------------------
// property_influences carries BUS ROUTE, PARK, COMMERCIAL ADJACENT,
// COMMERCIAL INFLUENCE … A substring test for 'ADJACENT' would drag
// every commercial parcel into a waterfront search.
assert.equal(parseWaterInfluence('COMMERCIAL ADJACENT'), null);
assert.equal(parseWaterInfluence('COMMERCIAL INFLUENCE'), null);
assert.equal(parseWaterInfluence('BUS ROUTE,EXTERNAL CORNER,HEAVY TRAFFIC'), null);
assert.equal(parseWaterInfluence('PARK'), null);
assert.equal(parseWaterInfluence('FLOOD PLAIN'), null, 'regulatory, not a water-influence verdict');
assert.equal(parseWaterInfluence(''), null);
assert.equal(parseWaterInfluence(null), null);
assert.equal(parseWaterInfluence(undefined), null);

// A water token mixed in with noise is still found.
assert.equal(
  parseWaterInfluence('BUS ROUTE,COMMERCIAL ADJACENT,RETENTION POND ADJACENT,HEAVY TRAFFIC').body,
  'Retention pond',
);

// ---- every body in the vocabulary parses ---------------------------------
for (const b of WATER_BODIES) {
  const a = parseWaterInfluence(`${b.token} ADJACENT`);
  assert.ok(a, `${b.token} ADJACENT parses`);
  assert.equal(a.body, b.label);
  assert.equal(a.frontage, true);
  const i = parseWaterInfluence(`${b.token} INFLUENCE`);
  assert.ok(i, `${b.token} INFLUENCE parses`);
  assert.equal(i.frontage, false);
}

// ---- multiple water tokens: frontage wins, then body order ---------------
{
  // A river lot that also backs a pond is a river lot.
  const w = parseWaterInfluence('RETENTION POND INFLUENCE,RED RIVER ADJACENT');
  assert.equal(w.body, 'Red River');
  assert.equal(w.frontage, true);
}
{
  // Two frontages: the named watercourse outranks the pond.
  const w = parseWaterInfluence('RETENTION POND ADJACENT,SEINE RIVER ADJACENT');
  assert.equal(w.body, 'Seine River');
}
{
  // Two non-frontage: body order decides, and frontage is still false.
  const w = parseWaterInfluence('RETENTION POND INFLUENCE,ASSINIBOINE INFLUENCE');
  assert.equal(w.body, 'Assiniboine River');
  assert.equal(w.frontage, false);
}

// ---- case / whitespace tolerance -----------------------------------------
assert.equal(parseWaterInfluence('  red river adjacent  ').body, 'Red River');
assert.equal(parseWaterInfluence('PARK, RED RIVER INFLUENCE').body, 'Red River');

// ---- waterOf / waterLoaded ------------------------------------------------
assert.equal(waterOf({ property_influences: 'SEINE RIVER ADJACENT' }).body, 'Seine River');
assert.equal(waterOf({}), null);
assert.equal(waterOf(null), null);
assert.equal(waterLoaded({ _waterLoaded: true }), true);
assert.equal(waterLoaded({}), false, 'absent flag is NOT "no water"');
assert.equal(waterLoaded(null), false);

// ---- cell text ------------------------------------------------------------
// Leads with the body; "· near" is what distinguishes the second row
// without relying on the colour dot.
assert.equal(waterCellText(adj), 'Red River');
assert.equal(waterCellText(inf), 'Red River · near');
assert.equal(waterCellText(parseWaterInfluence('RETENTION POND ADJACENT')), 'Retention pond');
assert.equal(waterCellText(null), '');

// ---- tooltip --------------------------------------------------------------
{
  const t = waterTooltip(inf);
  assert.match(t, /Red River/);
  assert.match(t, /WITHOUT frontage/);
  assert.match(t, /screening aid/i, 'the caveat survives');
  assert.match(t, /RED RIVER INFLUENCE/, 'quotes the source token');
  assert.equal(waterTooltip(null), '');
}

// ---- sort rank: frontage above near-water, unknown last -----------------
assert.ok(waterSortRank(adj, true) < waterSortRank(inf, true), 'frontage sorts first');
assert.ok(waterSortRank(inf, true) < waterSortRank(null, true), 'water above no-water');
assert.ok(waterSortRank(null, true) < waterSortRank(null, false),
  '"checked, none" sorts above "never checked" — the two must not mix');

// ---- CSV cells: the three states -----------------------------------------
assert.deepEqual(waterCsvCells(adj, true), ['Yes', 'Water adjacent', 'Red River', 'River']);
assert.deepEqual(waterCsvCells(inf, true), ['No', 'Water influence', 'Red River', 'River']);
assert.deepEqual(waterCsvCells(null, true), ['No water noted', '', '', '']);
// Never checked → blank throughout. "No water" here would be a
// confident lie about a check that never ran.
assert.deepEqual(waterCsvCells(null, false), ['', '', '', '']);

// ---- waterTokens: the server-side filter vocabulary ---------------------
{
  const all = waterTokens();
  assert.equal(all.length, WATER_BODIES.length * 2, '16 water tokens');
  assert.ok(all.includes('RED RIVER ADJACENT'));
  assert.ok(all.includes('OMANDS CREEK INFLUENCE'));
  // Must never emit a bare suffix that would match COMMERCIAL ADJACENT.
  assert.ok(all.every((t) => t.length > ' ADJACENT'.length));

  const front = waterTokens(true);
  assert.equal(front.length, WATER_BODIES.length);
  assert.ok(front.every((t) => t.endsWith(' ADJACENT')));

  const near = waterTokens(false);
  assert.equal(near.length, WATER_BODIES.length);
  assert.ok(near.every((t) => t.endsWith(' INFLUENCE')));

  // Every emitted token must round-trip back through the parser with
  // the class it was generated for — the filter and the column can
  // never disagree about what counts as waterfront.
  for (const t of front) assert.equal(parseWaterInfluence(t).frontage, true, t);
  for (const t of near)  assert.equal(parseWaterInfluence(t).frontage, false, t);
}

// ---- class table ----------------------------------------------------------
assert.equal(WATER_CLASSES.length, 2);
assert.equal(WATER_CLASSES.filter((c) => c.frontage).length, 1);
assert.ok(WATER_CLASSES.every((c) => /^#[0-9a-f]{6}$/i.test(c.color)));

console.log('water.test.js: all assertions passed');
