/*
 * Minimal store-only (no compression) ZIP writer. PNGs are already
 * DEFLATE-compressed internally, so re-compressing them in the ZIP would
 * burn CPU for ~0% gain — a "stored" archive is the right call and lets us
 * avoid pulling in a compression dependency (JSZip/pako).
 *
 * Produces a standard PKZIP archive (local file headers + central
 * directory + end-of-central-directory) that Windows Explorer, macOS
 * Archive Utility, 7-Zip, and `unzip` all open without complaint.
 *
 * Scope intentionally tiny: no ZIP64 (fine — a 150-PNG parcel batch is a
 * few hundred MB at most, well under the 4 GB / 65k-entry classic-ZIP
 * limits), no folders, no per-file timestamps (every entry stamped to the
 * 1980-01-01 DOS epoch so the output is deterministic).
 */

// ---- CRC32 (IEEE 802.3 polynomial, reflected) --------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 of a Uint8Array, returned as an unsigned 32-bit number. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---- little-endian writer ----------------------------------------------

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  _push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  u16(v) {
    this._push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }
  u32(v) {
    this._push(new Uint8Array([
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    ]));
  }
  bytes(b) {
    this._push(b);
  }
  concat() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// DOS date/time for 1980-01-01 00:00:00 (the ZIP epoch). Fixed so the
// archive bytes are reproducible run-to-run.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // year 1980, month 1, day 1

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20; // 2.0 — store/deflate baseline
const FLAG_UTF8 = 0x0800; // bit 11: filename is UTF-8

/**
 * Build a store-only ZIP archive from a list of files.
 *
 * @param {Array<{ name: string, data: Uint8Array }>} files
 * @returns {Blob} a `application/zip` Blob ready for download.
 */
export function buildStoreZip(files) {
  const enc = new TextEncoder();
  const writer = new ByteWriter();
  const central = []; // central-directory records, written after the data

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const offset = writer.length;

    // ---- local file header ----
    writer.u32(LOCAL_SIG);
    writer.u16(VERSION);
    writer.u16(FLAG_UTF8);
    writer.u16(0); // method 0 = store
    writer.u16(DOS_TIME);
    writer.u16(DOS_DATE);
    writer.u32(crc);
    writer.u32(data.length); // compressed size (== uncompressed for store)
    writer.u32(data.length); // uncompressed size
    writer.u16(nameBytes.length);
    writer.u16(0); // extra field length
    writer.bytes(nameBytes);
    writer.bytes(data);

    central.push({ nameBytes, crc, size: data.length, offset });
  }

  // ---- central directory ----
  const cdStart = writer.length;
  for (const rec of central) {
    writer.u32(CENTRAL_SIG);
    writer.u16(VERSION); // version made by
    writer.u16(VERSION); // version needed
    writer.u16(FLAG_UTF8);
    writer.u16(0); // method
    writer.u16(DOS_TIME);
    writer.u16(DOS_DATE);
    writer.u32(rec.crc);
    writer.u32(rec.size);
    writer.u32(rec.size);
    writer.u16(rec.nameBytes.length);
    writer.u16(0); // extra length
    writer.u16(0); // comment length
    writer.u16(0); // disk number start
    writer.u16(0); // internal attrs
    writer.u32(0); // external attrs
    writer.u32(rec.offset);
    writer.bytes(rec.nameBytes);
  }
  const cdSize = writer.length - cdStart;

  // ---- end of central directory ----
  writer.u32(EOCD_SIG);
  writer.u16(0); // this disk
  writer.u16(0); // disk with central dir
  writer.u16(central.length); // entries on this disk
  writer.u16(central.length); // total entries
  writer.u32(cdSize);
  writer.u32(cdStart);
  writer.u16(0); // comment length

  return new Blob([writer.concat()], { type: 'application/zip' });
}
