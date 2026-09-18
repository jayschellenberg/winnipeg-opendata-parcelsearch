#!/usr/bin/env node
/*
 * Liveness check for public/sample-parcel-list.csv.
 *
 * WHY THIS IS NOT A UNIT TEST. test/parcelListParse.test.js pins that
 * every row of the sample still PARSES, and that runs offline in `npm
 * test` where it belongs. What it cannot check is that every row still
 * RESOLVES: that needs the City's live assessment roll. A parcel the
 * City renumbers, consolidates or re-addresses would leave the sample
 * parsing perfectly and matching nothing — and the sample is the file
 * people copy their own list from, so a stale row teaches a shape that
 * does not work.
 *
 * So this lives outside the test suite, which stays offline and
 * deterministic, and runs on its own schedule instead:
 *
 *   npm run check:sample
 *
 * Exits non-zero when any row fails to resolve, naming the rows, so the
 * scheduled workflow (.github/workflows/sample-list-check.yml) turns a
 * stale sample into a notification rather than something you find out
 * about from a user.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseParcelList } from '../src/lib/parcelListParse.js';
import { resolveParcelList } from '../src/lib/parcelListResolve.js';

const SAMPLE = fileURLToPath(new URL('../public/sample-parcel-list.csv', import.meta.url));

/** Statuses that mean the row did its job. 'multiple' counts: a sample
 *  row may legitimately sit on a parcel the roll splits, and the modal
 *  imports every one of them. Only "nothing" and "unreadable" fail. */
const OK = new Set(['resolved', 'multiple']);

async function main() {
  const text = readFileSync(SAMPLE, 'utf8');
  const parsed = parseParcelList(text);

  console.log(`sample-parcel-list.csv — ${parsed.counts.total} rows, `
    + `${parsed.counts.address} addresses, ${parsed.counts.roll} rolls`);
  if (!parsed.headerDropped) {
    console.error('FAIL: the header row was not recognized as a header.');
    process.exitCode = 1;
    return;
  }
  if (parsed.counts.unparseable > 0) {
    console.error(`FAIL: ${parsed.counts.unparseable} row(s) did not parse.`);
    process.exitCode = 1;
    return;
  }

  const out = await resolveParcelList(parsed.rows);
  for (const n of out.notices) console.warn(`note: ${n}`);

  const bad = [];
  for (const r of out.rows) {
    const ok = OK.has(r.status);
    const rolls = (r.matches || []).map((m) => `${m.roll} ${m.address}`).join(' | ');
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} line ${String(r.lineNo).padStart(2)}  `
      + `${(r.cell || r.raw).padEnd(40)}${r.status.padEnd(11)}${rolls}`
    );
    if (!ok) bad.push(r);
  }

  if (bad.length) {
    console.error(
      `\n${bad.length} of ${out.rows.length} sample rows no longer resolve. `
      + 'The City may have renumbered or re-addressed a parcel — pick a live '
      + 'replacement for each failing row in public/sample-parcel-list.csv.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${out.rows.length} sample rows resolve.`);
}

main().catch((err) => {
  // A Socrata outage is not a stale sample. Say so plainly rather than
  // reporting rows as broken when we never got an answer about them.
  console.error('Could not complete the check (the City API may be down):');
  console.error(err?.message || err);
  process.exitCode = 2;
});
