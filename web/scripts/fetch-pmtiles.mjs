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
// INTEGRITY: the downloaded archive is verified against the SHA-256 in
// scripts/parcels.pmtiles.sha256 before it is written, so a tampered or
// swapped release asset can't be shipped to users. A mismatch is treated
// like any other failure (warn + disable the overlay + exit 0) rather
// than a hard error, so a *legitimate* re-publish that forgot to refresh
// the checksum degrades gracefully instead of breaking the deploy — the
// warning in the build log says to update the hash. When you re-publish:
//
//   gh release upload parcels-pmtiles web/public/parcels.pmtiles --clobber
//   # then refresh the pinned checksum and commit it:
//   #   bash:       sha256sum web/public/parcels.pmtiles | cut -d' ' -f1 > web/scripts/parcels.pmtiles.sha256
//   #   PowerShell: (Get-FileHash web/public/parcels.pmtiles -Algorithm SHA256).Hash.ToLower() > web/scripts/parcels.pmtiles.sha256
//
//   node scripts/fetch-pmtiles.mjs        (or: npm run fetch:pmtiles)

import { existsSync, statSync, renameSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const URL_ = 'https://github.com/jayschellenberg/winnipeg-opendata-parcelsearch/releases/download/parcels-pmtiles/parcels.pmtiles';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(scriptDir, '..', 'public', 'parcels.pmtiles');
const sha256Path = path.join(scriptDir, 'parcels.pmtiles.sha256');

// The expected SHA-256 of the published archive, pinned in a committed
// sidecar file. Missing/blank → integrity is unpinned (download is still
// fetched, just unverified) so the build never hard-fails on a setup gap.
const expectedSha = existsSync(sha256Path)
  ? readFileSync(sha256Path, 'utf8').trim().toLowerCase().split(/\s+/)[0]
  : '';

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

  // Verify integrity before trusting the bytes. A mismatch means the
  // release asset is not what we pinned — refuse to write it.
  if (expectedSha) {
    const actualSha = createHash('sha256').update(buf).digest('hex');
    if (actualSha !== expectedSha) {
      throw new Error(
        `SHA-256 mismatch — refusing to write. expected ${expectedSha.slice(0, 12)}… got ${actualSha.slice(0, 12)}…. ` +
        `If you just re-published the archive, refresh web/scripts/parcels.pmtiles.sha256.`,
      );
    }
    console.log(`fetch-pmtiles: integrity OK (sha256 ${actualSha.slice(0, 12)}…).`);
  } else {
    console.warn('fetch-pmtiles: no pinned checksum (scripts/parcels.pmtiles.sha256) — download is UNVERIFIED.');
  }

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
