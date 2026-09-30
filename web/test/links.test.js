// Unit tests for src/lib/links.js. Plain-node runner; run with
// `npm test` or `node test/links.test.js`.
import assert from 'node:assert/strict';
import { pucOverrideUrl, PUC_OVERRIDE_TOOL } from '../src/lib/links.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('links');

test('pucOverrideUrl — pads the roll and carries the instrument', () => {
  assert.equal(pucOverrideUrl('6093476235', '5640510'),
    `${PUC_OVERRIDE_TOOL}?roll=06093476235&inst=5640510`);
  assert.equal(pucOverrideUrl('06093476235', ' 5640510 '),
    `${PUC_OVERRIDE_TOOL}?roll=06093476235&inst=5640510`);
});

test('pucOverrideUrl — null when there is no SABRE record to correct', () => {
  assert.equal(pucOverrideUrl('6093476235', 'N1-1234'), null);
  assert.equal(pucOverrideUrl('14010680000', 'MLS-202619655'), null);
  assert.equal(pucOverrideUrl('', '5640510'), null);
  assert.equal(pucOverrideUrl('6093476235', ''), null);
  assert.equal(pucOverrideUrl(null, null), null);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
