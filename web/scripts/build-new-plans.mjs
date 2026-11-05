#!/usr/bin/env node
/*
 * build-new-plans.mjs
 * ---------------------------------------------------------------
 * Builds web/public/new-plans.geojson: survey plans registered since the
 * oldest archived survey snapshot, with the window each one first appeared
 * in. The "New Plans" overlay (lib/newPlans.js) draws it.
 *
 * WHY. Nothing the City publishes dates a plain subdivision. DMIS lists a
 * subdivision only when it comes with a rezoning by-law, Public Notices only
 * has SUBDIVISION AND REZONING, and Survey Parcels (sjjm-nj47) carries lot /
 * block / plan with no date. But a new registered plan shows up in Survey
 * Parcels as a plan number that was not there before, so diffing the plan
 * numbers against archived snapshots dates each one to a window.
 *
 * Sources:
 *   - Archived survey snapshots in jayschellenberg/wpg-parcel-history
 *     (<snap>/survey/<NEIGHBOURHOOD>.json, every shard carries `plan`).
 *     The oldest survey snapshot is the baseline; later ones split the
 *     time since into windows.
 *   - Live Survey Parcels sjjm-nj47: today's plan list, and the lots of
 *     each new plan.
 *   - The previous new-plans.geojson: a plan already in it keeps its
 *     window, and the previous build date starts the newest window. Each
 *     quarterly run therefore dates new plans to about a quarter.
 *
 * A plan counts as new only if its number is absent from the baseline.
 * Plans that vanished (consolidated / retired) are not tracked. A new plan
 * can be a subdivision, a consolidation or a re-survey: Survey Parcels does
 * not say which, so the popup shows the lot count and the plan number.
 *
 * Cadence: quarterly, by r/refresh_assets.ps1 (non-fatal there).
 * npm:     npm run refresh:new-plans
 * --------------------------------------------------------------- */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStable } from './stableWrite.mjs';
import { planWindows, newPlanFeature, planHighWater, isLatePlan } from '../src/lib/newPlans.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, '..', 'public', 'new-plans.geojson');

// Same commit as HISTORICAL_CDN in src/soda.js; read from there so a shard
// republish needs one bump, not two. Fetched from raw.githubusercontent.com,
// not jsDelivr: jsDelivr answers 403 "Package size exceeded the configured
// limit of 50 MB" for any shard it has not already cached, because the
// history repo is larger than that. The app only escapes this because each
// browser asks for a handful of shards; a build reads all of them.
const SODA_SRC = readFileSync(path.join(SCRIPT_DIR, '..', 'src', 'soda.js'), 'utf8');
const CDN = /const HISTORICAL_CDN =\s*'([^']+)'/.exec(SODA_SRC)?.[1] || '';
const m = /cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^@]+)@([0-9a-f]{7,40})$/.exec(CDN);
if (!m) throw new Error(`could not read the history repo pin from HISTORICAL_CDN (${CDN || 'missing'})`);
const PIN = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;

const SURVEY = 'https://data.winnipeg.ca/resource/sjjm-nj47';
const PLAN_BATCH = 40;
const CONCURRENCY = 4;

const log = (...a) => console.log('[new-plans]', ...a);

async function getJson(url, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`, { cause: err });
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Every plan number in one archived survey snapshot. */
async function snapshotPlans(snap) {
  const man = await getJson(`${PIN}/${snap}/manifest.json`);
  const slugs = Object.entries(man?.neighbourhoods || {}).filter(([, v]) => v.survey > 0).map(([k]) => k);
  const plans = new Set();
  let features = 0;
  await pool(slugs, CONCURRENCY, async (slug) => {
    const fc = await getJson(`${PIN}/${snap}/survey/${slug}.json`);
    for (const f of fc?.features || []) {
      features++;
      const p = String(f.properties?.plan ?? '').trim();
      if (p) plans.add(p);
    }
  });
  const want = man?.layers?.survey?.features;
  if (want && features < want * 0.99) throw new Error(`${snap}: read ${features} of ${want} survey features`);
  log(`${snap}: ${slugs.length} shards, ${features} lots, ${plans.size} plans`);
  return plans;
}

/** Today's plan numbers from Survey Parcels. */
async function currentPlans() {
  const rows = await getJson(`${SURVEY}.json?$select=plan&$group=plan&$limit=200000`);
  const plans = new Set(rows.map((r) => String(r.plan ?? '').trim()).filter(Boolean));
  if (plans.size < 5000) throw new Error(`only ${plans.size} current plans — refusing to build`);
  log(`today: ${plans.size} plans`);
  return plans;
}

/** Lots (GeoJSON features) of the given plans, live. */
async function lotsOf(plans) {
  const byPlan = new Map();
  const batches = [];
  for (let i = 0; i < plans.length; i += PLAN_BATCH) batches.push(plans.slice(i, i + PLAN_BATCH));
  await pool(batches, 4, async (batch) => {
    const where = `plan in (${batch.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')})`;
    const url = `${SURVEY}.geojson?$select=plan,lot,block,location&$where=${encodeURIComponent(where)}&$limit=50000`;
    const fc = await getJson(url);
    for (const f of fc?.features || []) {
      const p = String(f.properties?.plan ?? '').trim();
      if (!byPlan.has(p)) byPlan.set(p, []);
      byPlan.get(p).push(f);
    }
  });
  return byPlan;
}

function previousBuild() {
  if (!existsSync(OUT)) return null;
  try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch { return null; }
}

async function main() {
  const index = await getJson(`${PIN}/index.json`);
  const snaps = Object.entries(index?.snapshots || {})
    .filter(([, v]) => v?.layers?.survey)
    .map(([k]) => k)
    .sort();
  if (!snaps.length) throw new Error('no survey snapshots in the history index');
  log(`survey snapshots: ${snaps.join(', ')}`);

  const snapPlans = [];
  for (const s of snaps) snapPlans.push({ date: s, plans: await snapshotPlans(s) });
  const today = new Date().toISOString().slice(0, 10);
  const prev = previousBuild();
  const current = await currentPlans();

  const windows = planWindows({ snapshots: snapPlans, current, today, previous: prev });
  const newPlans = [...windows.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  log(`${newPlans.length} plans not in the ${snaps[0]} baseline`);

  const highWater = planHighWater(snapPlans[0].plans);
  const lots = await lotsOf(newPlans);
  const features = [];
  let missing = 0; let late = 0;
  for (const p of newPlans) {
    const isLate = isLatePlan(p, highWater);
    const f = newPlanFeature(p, lots.get(p) || [], windows.get(p), { late: isLate });
    if (f) { features.push(f); if (isLate) late++; } else missing++;
  }
  if (missing) log(`${missing} new plans had no lot geometry — skipped`);
  log(`baseline high-water plan ${highWater}; ${late} new plans numbered below it (added late)`);

  const out = {
    type: 'FeatureCollection',
    _meta: {
      generated_at: today,
      baseline: snaps[0],
      baseline_high_water: highWater,
      snapshots: snaps,
      source: `${SURVEY} + ${PIN}`,
      note: 'Plans whose number was not in the baseline survey snapshot. Dated to the window they first appeared in.',
    },
    features,
  };
  await writeStable(OUT, out);
  log(`wrote ${features.length} plans → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => { console.error('[new-plans] FAILED:', err.message); process.exit(1); });
