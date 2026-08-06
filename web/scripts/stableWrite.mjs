// Write a generated JSON asset ONLY when its data actually changed.
//
// WHY. The transit and neighbourhood builders stamp `_meta.generated_at` with
// the build time. That made every rebuild produce a different file even when
// the upstream data was identical, which defeated the "commit only if the
// assets changed" guard in r/refresh_assets.ps1: the quarterly job committed
// and pushed all four assets — and triggered a production deploy — every run,
// forever. Measured on the 2026-08-06 run: three of the four files differed
// from their previous versions in nothing but that timestamp.
//
// These are single-line JSON files, so git cannot delta them usefully; each
// no-op refresh rewrote ~2.5 MB into history four times a year.
//
// The fix belongs here rather than in the scheduled job. Teaching the job to
// ignore `generated_at` would leave the builders still producing churn for
// anyone who runs them directly, and would put knowledge of the file format
// into a PowerShell script that has no other business knowing it.
//
// CONSEQUENCE, deliberate: `generated_at` now means "when this DATA was last
// generated", not "when the builder last ran". Nothing reads the field (checked
// across web/src, web/test and r/), and the useful question is which of those
// two anyway. The builder logs each file as written or unchanged, so a run is
// still visibly a run.

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

// Blank out the fields that change on every build regardless of the data, so
// two serializations of identical data compare equal. Global: the transit
// builder emits one per collection.
export function normalizeVolatile(text) {
  return String(text).replace(/"generated_at":"[^"]*"/g, '"generated_at":"<normalized>"');
}

/**
 * Serialize `obj` to `filePath`, skipping the write when the only difference
 * from what is already there is a volatile field.
 *
 * Skipping rather than rewriting-with-the-old-timestamp is deliberate: it
 * leaves the file's bytes AND its mtime untouched, so neither git nor any
 * timestamp-based tooling sees an event that did not happen.
 *
 * @returns {Promise<{written: boolean, reason: 'new'|'changed'|'unchanged'}>}
 */
export async function writeStable(filePath, obj) {
  const next = JSON.stringify(obj);
  const existed = existsSync(filePath);
  if (existed) {
    try {
      const prev = readFileSync(filePath, 'utf8');
      if (normalizeVolatile(prev) === normalizeVolatile(next)) {
        return { written: false, reason: 'unchanged' };
      }
    } catch {
      // Unreadable: fall through and write. A file we cannot compare is not a
      // file we should preserve.
    }
  }
  await writeFile(filePath, next);
  return { written: true, reason: existed ? 'changed' : 'new' };
}
