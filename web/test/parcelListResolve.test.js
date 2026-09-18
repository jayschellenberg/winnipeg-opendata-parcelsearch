/*
 * Unit tests for lib/parcelListResolve.js. Every fetcher is injected, so
 * the whole decision tree runs with no network.
 */
import assert from 'node:assert/strict';
import { parseParcelList } from '../src/lib/parcelListParse.js';
import { resolveParcelList, collectRolls } from '../src/lib/parcelListResolve.js';

let passed = 0;
function test(name, fn) {
  return fn().then(
    () => { passed += 1; },
    (err) => { console.error(`FAIL: ${name}`); throw err; }
  );
}

// ---- stand-ins for the soda.js helpers ---------------------------
// Real behaviour, minus the network: streetKey folds punctuation,
// normalizeStreetQuery drops the trailing street type.
const TYPES = new Set(['AVE', 'AVENUE', 'ST', 'STREET', 'RD', 'ROAD', 'DR', 'DRIVE']);
const streetKey = (v) => String(v ?? '').toUpperCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim();
const normalizeStreetQuery = (v) => {
  const t = streetKey(v).split(' ');
  if (t.length > 1 && TYPES.has(t[t.length - 1])) t.pop();
  return t.join(' ');
};
const normalizeRoll = (t) => {
  const d = String(t ?? '').replace(/[^0-9]/g, '');
  if (!d) return null;
  return d.length >= 11 ? d : d.padStart(11, '0');
};

/** Build a deps object; every fetcher defaults to "finds nothing". */
function deps(over = {}) {
  return {
    normalizeStreetQuery,
    streetKey,
    normalizeRoll,
    fetchAssessmentRowsByStreet: async () => [],
    fetchCivicAddressPointsByStreet: async () => ({ type: 'FeatureCollection', features: [] }),
    fetchAssessmentRowsAtPoints: async () => [],
    fetchAssessmentRowsByRolls: async () => [],
    ...over,
  };
}

const assessRow = (roll, number, name, type = 'AVENUE') => ({
  roll_number: roll,
  full_address: `${number} ${name} ${type}`,
  street_number: String(number),
  street_name: name,
  street_type: type,
});

// The user's own sample, as the City actually answers it.
const SAMPLE = [
  'Address',
  '330 Selkirk Ave, Winnipeg, MB',
  '393 Selkirk Ave, Winnipeg, MB',
  '407 Selkirk Ave, Winnipeg, MB',
  '413 Selkirk Ave, Winnipeg, MB',
  '417 Selkirk Ave, Winnipeg, MB',
].join('\n');

const SELKIRK = [
  assessRow('14010178000', 330, 'SELKIRK'),
  assessRow('14010045000', 393, 'SELKIRK'),
  assessRow('14010042000', 407, 'SELKIRK'),
  assessRow('14010256100', 413, 'SELKIRK'),
  assessRow('14010255000', 417, 'SELKIRK'),
];

const tests = [];

tests.push(test('the sample list resolves every row in one street query', async () => {
  let calls = 0;
  const { rows } = parseParcelList(SAMPLE);
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async (street, numbers) => {
      calls += 1;
      assert.equal(street, 'Selkirk Ave');
      assert.deepEqual(numbers, [330, 393, 407, 413, 417]);
      return SELKIRK;
    },
  }));
  assert.equal(calls, 1, 'five addresses on one street must cost one request');
  assert.equal(out.stats.resolved, 5);
  assert.equal(out.stats.notfound, 0);
  assert.deepEqual(collectRolls(out.rows),
    ['14010178000', '14010045000', '14010042000', '14010256100', '14010255000']);
}));

tests.push(test('rolls come back in paste order, not sorted', async () => {
  const { rows } = parseParcelList('417 Selkirk Ave\n330 Selkirk Ave');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => SELKIRK,
  }));
  assert.deepEqual(collectRolls(out.rows), ['14010255000', '14010178000']);
}));

tests.push(test('addresses on two streets cost one request each', async () => {
  const seen = [];
  const { rows } = parseParcelList('330 Selkirk Ave\n100 Main St');
  await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async (street, numbers) => {
      seen.push([street, numbers]);
      return street.startsWith('Selkirk') ? SELKIRK : [assessRow('13000000099', 100, 'MAIN', 'STREET')];
    },
  }));
  assert.equal(seen.length, 2);
}));

tests.push(test('an address with no parcel is reported not found', async () => {
  const { rows } = parseParcelList('999 Selkirk Ave');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => SELKIRK,
  }));
  assert.equal(out.rows[0].status, 'notfound');
  assert.deepEqual(collectRolls(out.rows), []);
}));

tests.push(test('two parcels at one address come back as multiple, both included', async () => {
  const { rows } = parseParcelList('330 Selkirk Ave');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => [
      assessRow('14010178000', 330, 'SELKIRK'),
      assessRow('14010178001', 330, 'SELKIRK'),
    ],
  }));
  assert.equal(out.rows[0].status, 'multiple');
  assert.equal(out.stats.multiple, 1);
  assert.deepEqual(collectRolls(out.rows), ['14010178000', '14010178001']);
}));

tests.push(test('a loose LIKE hit on the wrong street does not win over the exact one', async () => {
  const { rows } = parseParcelList('100 Main St');
  const out = await resolveParcelList(rows, deps({
    // `like '%MAIN%'` also drags in MAINWARING; the exact name must win.
    fetchAssessmentRowsByStreet: async () => [
      assessRow('13000000111', 100, 'MAINWARING', 'BAY'),
      assessRow('13000000222', 100, 'MAIN', 'STREET'),
    ],
  }));
  assert.equal(out.rows[0].status, 'resolved');
  assert.deepEqual(collectRolls(out.rows), ['13000000222']);
}));

tests.push(test('substring hits spanning two streets are ambiguous, not guessed', async () => {
  const { rows } = parseParcelList('100 Main St');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => [
      assessRow('13000000111', 100, 'MAINWARING', 'BAY'),
      assessRow('13000000333', 100, 'MAIN STREET NORTH', 'ROAD'),
    ],
  }));
  assert.equal(out.rows[0].status, 'ambiguous');
  assert.equal(out.stats.ambiguous, 1);
}));

tests.push(test('a side-door address resolves via the civic-address dataset', async () => {
  const { rows } = parseParcelList('440 Hargrave St');
  let pointCalls = 0;
  const out = await resolveParcelList(rows, deps({
    // The assessment roll lists this parcel only as 400 Hargrave.
    fetchAssessmentRowsByStreet: async () => [],
    fetchCivicAddressPointsByStreet: async () => ({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-97.14, 49.89] },
        properties: { full_address: '440 HARGRAVE ST', street_number: '440', street_name: 'HARGRAVE' },
      }],
    }),
    fetchAssessmentRowsAtPoints: async () => {
      pointCalls += 1;
      return [assessRow('13012345000', 400, 'HARGRAVE', 'STREET')];
    },
  }));
  assert.equal(pointCalls, 1);
  assert.equal(out.rows[0].status, 'resolved');
  assert.equal(out.rows[0].via, 'civic');
  assert.deepEqual(collectRolls(out.rows), ['13012345000']);
}));

tests.push(test('the side door only runs for rows the direct lookup missed', async () => {
  let civicCalls = 0;
  const { rows } = parseParcelList(SAMPLE);
  await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => SELKIRK,
    fetchCivicAddressPointsByStreet: async () => { civicCalls += 1; return { features: [] }; },
  }));
  assert.equal(civicCalls, 0);
}));

tests.push(test('the side door is capped and says so', async () => {
  const many = Array.from({ length: 5 }, (_, i) => `${100 + i} Nowhere St`).join('\n');
  const { rows } = parseParcelList(many);
  const out = await resolveParcelList(rows, deps({ sideDoorMax: 2 }));
  assert.equal(out.stats.notfound, 5);
  assert.equal(out.notices.length, 1);
  assert.match(out.notices[0], /limit 2/);
}));

tests.push(test('pasted roll numbers are verified and get their address back', async () => {
  const { rows } = parseParcelList('14010178000\n99999999999');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByRolls: async () => [assessRow('14010178000', 330, 'SELKIRK')],
  }));
  assert.equal(out.rows[0].status, 'resolved');
  assert.equal(out.rows[0].matches[0].address, '330 SELKIRK AVENUE');
  assert.equal(out.rows[1].status, 'notfound');
}));

tests.push(test('a roll with its leading zero dropped still matches', async () => {
  const { rows } = parseParcelList('1003547800');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByRolls: async () => [assessRow('01003547800', 12, 'SOMEWHERE')],
  }));
  assert.equal(out.rows[0].status, 'resolved');
  assert.deepEqual(collectRolls(out.rows), ['01003547800']);
}));

tests.push(test('a mixed address + roll list resolves both kinds', async () => {
  const { rows } = parseParcelList('330 Selkirk Ave\n01003547800');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => SELKIRK,
    fetchAssessmentRowsByRolls: async () => [assessRow('01003547800', 12, 'SOMEWHERE')],
  }));
  assert.equal(out.stats.resolved, 2);
  assert.deepEqual(collectRolls(out.rows), ['14010178000', '01003547800']);
}));

tests.push(test('unparseable rows survive with their own status', async () => {
  const { rows } = parseParcelList('330 Selkirk Ave\nsomewhere downtown');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => SELKIRK,
  }));
  assert.equal(out.stats.unparseable, 1);
  assert.equal(out.rows[1].status, 'unparseable');
}));

tests.push(test('a failed street lookup degrades to not-found with a notice', async () => {
  const { rows } = parseParcelList('330 Selkirk Ave');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => { throw new Error('Socrata down'); },
  }));
  assert.equal(out.rows[0].status, 'notfound');
  assert.equal(out.notices.length, 1);
}));

tests.push(test('a failed roll lookup accepts the rolls as typed rather than losing them', async () => {
  const { rows } = parseParcelList('14010178000');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByRolls: async () => { throw new Error('Socrata down'); },
  }));
  assert.equal(out.rows[0].status, 'resolved');
  assert.deepEqual(collectRolls(out.rows), ['14010178000']);
  assert.match(out.notices[0], /could not be verified/);
}));

tests.push(test('collectRolls honours the include predicate and dedupes', async () => {
  const { rows } = parseParcelList('330 Selkirk Ave\n330 Selkirk Ave\n393 Selkirk Ave');
  const out = await resolveParcelList(rows, deps({
    fetchAssessmentRowsByStreet: async () => SELKIRK,
  }));
  assert.deepEqual(collectRolls(out.rows), ['14010178000', '14010045000']);
  assert.deepEqual(collectRolls(out.rows, (r) => r.number !== 330), ['14010045000']);
}));

tests.push(test('an empty list resolves to nothing without any request', async () => {
  const out = await resolveParcelList([], deps());
  assert.equal(out.stats.total, 0);
  assert.deepEqual(collectRolls(out.rows), []);
}));

await Promise.all(tests);
console.log(`parcelListResolve.test.js: ${passed} passed`);
