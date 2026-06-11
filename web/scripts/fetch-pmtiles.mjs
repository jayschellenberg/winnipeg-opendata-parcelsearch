// Fetch the citywide-parcels PMTiles archive from the rolling GitHub
// release into web/public/ — run by the Vercel build (see vercel.json)
// because the 82 MB archive is not tracked in git.
//
// TOLERANT BY DESIGN: any failure logs a warning and exits 0. The app
// handles a missing archive gracefully (the All Assessment Parcels
// toggle shows a "tiles not built" hint), which beats failing the whole
// deploy over an optional overlay. Skips the download when a local copy
// already exists (dev machines keep one in web/public).
//
//   node scripts/fetch-pmtiles.mjs        (or: npm run fetch:pmtiles)

import { existsSync, statSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const URL_ = 'https://github.com/jayschellenberg/winnipeg-opendata-parcelsearch/releases/download/parcels-pmtiles/parcels.pmtiles';
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'parcels.pmtiles');

// A real archive is tens of MB; anything tiny is a leftover error page.
if (existsSync(dest) && statSync(dest).size > 1_000_000) {
  console.log(`fetch-pmtiles: ${path.basename(dest)} already present (${(statSync(dest).size / 1e6).toFixed(1)} MB) — skipping download.`);
  process.exit(0);
}

try {
  console.log(`fetch-pmtiles: downloading ${URL_}`);
  const res = await fetch(URL_, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`suspiciously small download (${buf.length} bytes)`);
  // Write to a temp name + rename so a failed download can't leave a
  // half-written archive that the size check above would then trust.
  const tmp = `${dest}.tmpwrite`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  console.log(`fetch-pmtiles: wrote ${(buf.length / 1e6).toFixed(1)} MB to ${dest}`);
} catch (err) {
  try { rmSync(`${dest}.tmpwrite`, { force: true }); } catch { /* ignore */ }
  console.warn(`fetch-pmtiles: FAILED (${err.message}) — citywide-parcels overlay will be disabled for this deploy.`);
  process.exit(0);
}
