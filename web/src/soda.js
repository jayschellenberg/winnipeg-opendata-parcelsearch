// SODA (Socrata) API client for Winnipeg Open Data.
//
// Two datasets:
//   Survey Parcels     sjjm-nj47   (id, lot, block, plan, description, location)
//      geometry column name in SoQL: `location`  (multipolygon)
//   Assessment Parcels d4mq-wa44   (roll_number, full_address, zoning, geometry, ...)
//      geometry column name in SoQL: `geometry`  (multipolygon)
//
// Two search flows, both exactly two SODA calls per user query:
//
//   A) Legal-description search (plan/lot/block/description):
//      1. searchSurveyParcels({ plan, lot, block, desc })
//      2. fetchAssessmentOverlap(surveyFc)   — within_box(geometry, ...)
//      then joinSurveyWithAssessment() for the results table.
//      The Survey Parcels geometry is what is drawn on the map.
//
//   B) Assessment-first search (Roll #, Address, and/or Zoning fields):
//      1. searchAssessmentParcels({ roll, address, zoning })
//      2. fetchSurveyOverlap(assessFc)       — within_box(location, ...)
//      then joinAssessmentWithSurvey() for the results table.
//      The Assessment Parcels geometry is what is drawn on the map.
//
// In both flows the final polygon-overlap join is done client-side with
// turf.js so matching is exact, not just bbox containment.

import bbox from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';

const SURVEY_URL = 'https://data.winnipeg.ca/resource/sjjm-nj47.geojson';
const ASSESS_URL = 'https://data.winnipeg.ca/resource/d4mq-wa44.geojson';

// Optional Socrata app token. Raises the anonymous rate limit.
// Set via Vercel env var VITE_SODA_APP_TOKEN; undefined in anonymous mode.
const APP_TOKEN = import.meta.env.VITE_SODA_APP_TOKEN;

/**
 * Query Survey Parcels by attribute. Any provided field is partial-matched
 * with SoQL `like '%x%'`. All provided fields are ANDed. Returns a
 * FeatureCollection (possibly empty).
 */
export async function searchSurveyParcels({ plan, lot, block, desc }) {
  const clauses = [];
  if (plan)  clauses.push(likeClause('plan', plan));
  if (lot)   clauses.push(likeClause('lot', lot));
  if (block) clauses.push(likeClause('block', block));
  if (desc)  clauses.push(likeClause('description', desc));
  if (clauses.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $limit: '500',
  });
  return fetchSoda(`${SURVEY_URL}?${params}`);
}

/**
 * Fetch Assessment Parcels that overlap the supplied Survey Parcels. Uses
 * one small within_box clause per survey parcel, OR'd together and batched,
 * so geographically-spread results don't collapse into a single city-wide
 * bbox that hits the row limit before reaching the relevant parcels.
 * Returns only the fields needed for enrichment.
 */
export async function fetchAssessmentOverlap(surveyFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: ASSESS_URL,
    geomColumn: 'geometry',
    select: 'roll_number,full_address,zoning,geometry',
    dedupeKey: 'roll_number',
    fc: surveyFc,
  });
}

/**
 * For each survey parcel, find every assessment parcel whose geometry
 * actually intersects it (not just the bbox). Returns an array of rows:
 *   { survey: <Feature>, assess: <Feature>|null }
 * A survey parcel with no matches produces a single row with assess=null.
 */
export function joinSurveyWithAssessment(surveyFc, assessFc) {
  const rows = [];
  for (const s of surveyFc.features) {
    let matches;
    try {
      matches = assessFc.features.filter((a) => booleanIntersects(s, a));
    } catch (err) {
      // Some parcel geometries in the wild have topology issues that crash
      // boolean-intersects. Fall back to "no match" rather than dropping the
      // whole row.
      console.warn('booleanIntersects error; falling back to unmatched row', err);
      matches = [];
    }
    if (matches.length === 0) {
      rows.push({ survey: s, assess: null });
    } else {
      for (const a of matches) rows.push({ survey: s, assess: a });
    }
  }
  return rows;
}

// ---------- Assessment-first search flow (mirror of the above) ----------

/**
 * Query Assessment Parcels by any combination of attribute filters:
 * roll number, full address, and/or zoning. Each provided field is
 * partial-matched with SoQL `like '%x%'` and all provided fields are
 * ANDed together. Returns a FeatureCollection with assessment-parcel
 * geometry suitable for rendering directly on the map.
 */
export async function searchAssessmentParcels({ roll, address, zoning }) {
  const clauses = [];
  if (roll)    clauses.push(likeClause('roll_number', roll));
  if (address) clauses.push(likeClause('full_address', address));
  if (zoning)  clauses.push(likeClause('zoning', zoning));
  if (clauses.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $select: 'roll_number,full_address,zoning,geometry',
    $limit: '500',
  });
  return fetchSoda(`${ASSESS_URL}?${params}`);
}

/**
 * Fetch Survey Parcels that overlap the supplied Assessment Parcels. Used
 * to back-fill legal-description columns (lot/block/plan/description) for
 * an assessment-first search. Per-parcel within_box clauses keep each
 * query tight even when the assessment results are spread across the city
 * (e.g. an address search for "stock" matching both Woodstock and Stockdale).
 * The Survey Parcels geometry column is `location`, not `geometry`.
 */
export async function fetchSurveyOverlap(assessFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: SURVEY_URL,
    geomColumn: 'location',
    select: null,
    dedupeKey: 'id',
    fc: assessFc,
  });
}

/**
 * For each assessment parcel, find every survey parcel whose geometry
 * actually intersects it. Returns rows shaped the same as
 * joinSurveyWithAssessment, so the table renderer can stay schema-agnostic:
 *   { survey: <Feature>|null, assess: <Feature> }
 * An assessment parcel with no legal-description match still produces one
 * row (with survey=null) so it isn't dropped from the table.
 */
export function joinAssessmentWithSurvey(assessFc, surveyFc) {
  const rows = [];
  for (const a of assessFc.features) {
    let matches;
    try {
      matches = surveyFc.features.filter((s) => booleanIntersects(a, s));
    } catch (err) {
      console.warn('booleanIntersects error; falling back to unmatched row', err);
      matches = [];
    }
    if (matches.length === 0) {
      rows.push({ survey: null, assess: a });
    } else {
      for (const s of matches) rows.push({ survey: s, assess: a });
    }
  }
  return rows;
}

/**
 * Build one small within_box clause per feature in `fc`, OR them together,
 * batch the clauses so URLs stay well under typical length limits, fire the
 * batches in parallel, and merge+dedupe the responses. Returns a single
 * FeatureCollection.
 *
 * Why per-feature instead of one union bbox:
 *   A union bbox across geographically spread inputs (e.g. two neighbourhoods
 *   on opposite sides of the city) expands into a huge rectangle covering
 *   most of Winnipeg. The SODA $limit then gets consumed by intervening
 *   parcels and the ones we actually care about never come back. Per-feature
 *   clauses keep each polygon's search window tight.
 */
async function fetchPerFeatureBboxUnion({ baseUrl, geomColumn, select, dedupeKey, fc }) {
  if (!fc.features.length) {
    return { type: 'FeatureCollection', features: [] };
  }

  const round = (n) => n.toFixed(6);
  // SoQL within_box requires the target geometry to be *fully contained*
  // in the query box — not just to intersect it. Survey and assessment
  // parcels rarely share edges to the millimeter (river lots are the worst
  // offenders), so we pad each per-feature bbox by about 150 m in every
  // direction. The client-side booleanIntersects join still makes the
  // final call on actual overlap, so the extra rows fetched are harmless.
  const PAD_DEG = 0.002;
  const clauses = fc.features.map((f) => {
    const [minLon, minLat, maxLon, maxLat] = bbox(f);
    // within_box(geom, nwLat, nwLon, seLat, seLon)
    return `within_box(${geomColumn},${round(maxLat + PAD_DEG)},${round(minLon - PAD_DEG)},${round(minLat - PAD_DEG)},${round(maxLon + PAD_DEG)})`;
  });

  // 50 clauses per request keeps the URL comfortably under 8 KB even with
  // the longest coordinate strings. Batches run in parallel so wall-clock
  // time is bounded by the slowest single call, not the sum.
  const BATCH = 50;
  const batches = [];
  for (let i = 0; i < clauses.length; i += BATCH) {
    batches.push(clauses.slice(i, i + BATCH));
  }

  const responses = await Promise.all(
    batches.map((group) => {
      const params = new URLSearchParams({
        $where: group.join(' OR '),
        $limit: '5000',
      });
      if (select) params.set('$select', select);
      return fetchSoda(`${baseUrl}?${params}`);
    })
  );

  // Dedupe: the same feature can appear in multiple batches if its bbox
  // happens to straddle two input parcels near a batch boundary.
  const seen = new Set();
  const merged = [];
  for (const r of responses) {
    for (const feat of r.features) {
      const key = feat.properties?.[dedupeKey];
      if (key != null && seen.has(key)) continue;
      if (key != null) seen.add(key);
      merged.push(feat);
    }
  }
  return { type: 'FeatureCollection', features: merged };
}

async function fetchSoda(url) {
  const headers = APP_TOKEN ? { 'X-App-Token': APP_TOKEN } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SODA ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// SoQL string literal escape: double any single quotes.
function escapeSoql(s) {
  return String(s).replace(/'/g, "''");
}

// SoQL `LIKE` is case-sensitive and Winnipeg's data is stored in mixed
// case (e.g. `10 MONARCH MEWS`, `R1M - RES - S F - MEDIUM`). Wrap both
// the column and the search term in upper() so searches are
// case-insensitive — typing "monarch" matches "10 MONARCH MEWS".
function likeClause(column, value) {
  return `upper(${column}) like '%${escapeSoql(String(value).toUpperCase())}%'`;
}
