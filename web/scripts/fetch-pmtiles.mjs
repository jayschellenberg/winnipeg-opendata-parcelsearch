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
// warning in the build log says to update the hash.
//
// TO RE-PUBLISH, run the job — it uploads, verifies, swaps, refreshes this
// checksum, and pushes, all in the right order:
//
//   powershell -ExecutionPolicy Bypass -File r\rebuild_tiles.ps1
//
// Do NOT publish by hand with `gh release upload --clobber`. It deletes the
// live asset *before* uploading the replacement, so a failed upload leaves
// the release with no asset at all and every subsequent deploy silently
// disables the overlay — that is exactly the 2026-08-05 outage. r/lib_gh.ps1
// uploads under a staging name and swaps by metadata rename instead.

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

const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

// A real archive is tens of MB; anything tiny is a leftover error page.
//
// The skip path now VERIFIES rather than assuming. On Vercel the file is never
// present (it is gitignored), so this costs nothing there — but on a dev
// machine it turns `npm run fetch:pmtiles` into a genuine health check.
// Previously the one person able to notice a stale or broken local archive was
// the one person the script never checked.
if (existsSync(dest) && statSync(dest).size > 1_000_000) {
  const sizeMb = (statSync(dest).size / 1e6).toFixed(1);
  if (!expectedSha) {
    console.log(`fetch-pmtiles: ${path.basename(dest)} already present (${sizeMb} MB), no pinned checksum — skipping download.`);
    process.exit(0);
  }
  const localSha = sha256Of(readFileSync(dest));
  if (localSha === expectedSha) {
    console.log(`fetch-pmtiles: ${path.basename(dest)} already present (${sizeMb} MB) and matches the pinned checksum — skipping download.`);
    process.exit(0);
  }
  console.warn(
    `fetch-pmtiles: local ${path.basename(dest)} does NOT match the pinned checksum ` +
    `(have ${localSha.slice(0, 12)}…, pinned ${expectedSha.slice(0, 12)}…) — re-downloading.`,
  );
}

// Retry transient failures. A single GitHub CDN blip, or the sub-second window
// while a publish swaps the asset, otherwise costs a whole deploy its overlay.
// Bounded and short: this sits in the deploy-critical path.
async function download(attempt) {
  const res = await fetch(URL_, { redirect: 'follow' });
  if (res.status === 404) throw new Error('HTTP 404 — no asset named parcels.pmtiles on the parcels-pmtiles release');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`suspiciously small download (${buf.length} bytes)`);
  return buf;
}

try {
  console.log(`fetch-pmtiles: downloading ${URL_}`);
  let buf = null;
  const backoffs = [2000, 6000];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      buf = await download(attempt);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`fetch-pmtiles: attempt ${attempt}/3 failed (${err.message}) — retrying in ${backoffs[attempt - 1] / 1000}s`);
      await new Promise((r) => setTimeout(r, backoffs[attempt - 1]));
    }
  }

  // Verify integrity before trusting the bytes. A mismatch means the
  // release asset is not what we pinned — refuse to write it.
  if (expectedSha) {
    const actualSha = sha256Of(buf);
    if (actualSha !== expectedSha) {
      // Name the fault precisely. "Asset missing" and "asset is not what we
      // pinned" have completely different repairs, and the build log is the
      // only place anyone sees this.
      throw new Error(
        `SHA-256 MISMATCH (the asset exists but is not the one pinned) — refusing to write. ` +
        `expected ${expectedSha.slice(0, 12)}… got ${actualSha.slice(0, 12)}…. ` +
        `Either the release was re-published without refreshing web/scripts/parcels.pmtiles.sha256, ` +
        `or that commit was pushed without the matching asset.`,
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
