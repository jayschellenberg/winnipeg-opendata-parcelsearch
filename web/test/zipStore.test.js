// Unit tests for the hand-rolled store-only ZIP writer. This is the
// riskiest code in the parcel-snapshots feature (raw binary layout +
// CRC32), so it gets direct coverage. zipStore.js is pure (no browser
// globals beyond Blob, which Node 18+ provides), so it imports cleanly here
// — unlike snapshotExport.js, which pulls in maplibre-gl.

import assert from 'node:assert';
import { crc32, buildStoreZip } from '../src/lib/zipStore.js';

const enc = new TextEncoder();
let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn())
    .then(() => { passed++; })
    .catch((err) => {
      console.error(`✗ ${name}`);
      throw err;
    });
}

function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function u32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

// Parse a store-only ZIP via its central directory; return [{name, data, crc}].
function parseZip(buf) {
  // Locate EOCD (no trailing comment, so it's the last 22 bytes).
  const eocd = buf.length - 22;
  assert.strictEqual(u32(buf, eocd), 0x06054b50, 'EOCD signature');
  const total = u16(buf, eocd + 10);
  const cdOffset = u32(buf, eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    assert.strictEqual(u32(buf, p), 0x02014b50, 'central dir signature');
    const crc = u32(buf, p + 16);
    const compSize = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOff = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLen));

    // Walk into the local header to extract the stored bytes.
    assert.strictEqual(u32(buf, localOff), 0x04034b50, 'local header signature');
    const lNameLen = u16(buf, localOff + 26);
    const lExtraLen = u16(buf, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + compSize);

    entries.push({ name, data, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

await test('crc32 matches the standard check value', () => {
  // "123456789" → 0xCBF43926 is the canonical CRC-32 check value.
  assert.strictEqual(crc32(enc.encode('123456789')), 0xcbf43926);
  // Empty input → 0.
  assert.strictEqual(crc32(new Uint8Array(0)), 0);
});

await test('buildStoreZip round-trips file names, bytes, and CRCs', async () => {
  const files = [
    { name: '187-12345.png', data: enc.encode('hello world') },
    { name: '301-987.png', data: new Uint8Array([0, 1, 2, 254, 255, 0, 128]) },
  ];
  const blob = buildStoreZip(files);
  assert.strictEqual(blob.type, 'application/zip');
  const buf = new Uint8Array(await blob.arrayBuffer());

  // First bytes are a local file header.
  assert.strictEqual(u32(buf, 0), 0x04034b50, 'starts with local header');

  const parsed = parseZip(buf);
  assert.strictEqual(parsed.length, 2, 'two entries');
  for (let i = 0; i < files.length; i++) {
    assert.strictEqual(parsed[i].name, files[i].name, `name ${i}`);
    assert.deepStrictEqual(parsed[i].data, files[i].data, `data ${i}`);
    assert.strictEqual(parsed[i].crc, crc32(files[i].data), `crc ${i}`);
  }
});

await test('buildStoreZip handles an empty file list', async () => {
  const blob = buildStoreZip([]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert.strictEqual(buf.length, 22, 'just an EOCD record');
  assert.strictEqual(u32(buf, 0), 0x06054b50, 'EOCD signature');
  assert.strictEqual(u16(buf, 10), 0, 'zero entries');
});

console.log(`zipStore.test.js: ${passed} passed`);
