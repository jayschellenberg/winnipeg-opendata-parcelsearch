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
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const SURVEY_URL = 'https://data.winnipeg.ca/resource/sjjm-nj47.geojson';
const ASSESS_URL = 'https://data.winnipeg.ca/resource/d4mq-wa44.geojson';
// Civic addresses dataset. One row per officially recognized address with a
// `point` geometry. No roll_number link — addresses join to assessment
// parcels geometrically (point-in-polygon).
const ADDRESSES_URL = 'https://data.winnipeg.ca/resource/cam2-ii3u.json';

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
    $limit: '1000',
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
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    dedupeKey: 'roll_number',
    fc: surveyFc,
  });
}

/**
 * For each survey parcel, find every assessment parcel whose centroid lies
 * inside it. Returns an array of rows:
 *   { survey: <Feature>, assess: <Feature>|null }
 * A survey parcel with no matches produces a single row with assess=null.
 *
 * Why centroid-in-polygon instead of booleanIntersects:
 *   Adjacent parcels share a boundary edge. booleanIntersects returns true
 *   for any shared point — including edge touches — so neighbouring lots
 *   incorrectly appear as matches. Checking the assessment centroid keeps
 *   only the parcel whose interior sits inside the survey polygon.
 *   Falls back to booleanIntersects when centroid coords are missing.
 */
export function joinSurveyWithAssessment(surveyFc, assessFc) {
  const rows = [];
  for (const s of surveyFc.features) {
    let matches;
    try {
      matches = assessFc.features.filter((a) => assessCentroidInSurvey(a, s));
    } catch (err) {
      console.warn('join error; falling back to unmatched row', err);
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
    $select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    $order: 'full_address',
    $limit: '1000',
  });
  return fetchSoda(`${ASSESS_URL}?${params}`);
}

/**
 * Expanded assessment-parcel search. Always runs the direct attribute query
 * (roll/address/zoning ANDed against d4mq-wa44.full_address). When `address`
 * is provided, also cross-references the civic-Addresses dataset
 * (cam2-ii3u): every matching address is a point that may sit on a parcel
 * whose *primary* full_address differs (e.g. "440 Hargrave" is a side door
 * of a parcel listed in assessment as "400 Hargrave"). Those extra parcels
 * are pulled in via per-point within_box and merged into the result, deduped
 * by roll_number.
 *
 * Roll/zoning filters carry through to the cross-reference path so the
 * combined intent — "parcel must match all the filters the user typed" —
 * stays consistent regardless of which path surfaced it.
 */
export async function searchAssessmentParcelsExpanded({ roll, address, zoning }) {
  const directPromise = searchAssessmentParcels({ roll, address, zoning });
  const xrefPromise = address
    ? searchAddressesAndFindParcels(address, { roll, zoning })
    : Promise.resolve({ type: 'FeatureCollection', features: [] });
  const [directFc, xrefFc] = await Promise.all([directPromise, xrefPromise]);
  return mergeFcByKey([directFc, xrefFc], 'roll_number');
}

/**
 * Query the Addresses dataset for every civic address whose full_address
 * matches `like '%X%'`. Returns a FeatureCollection of Point features —
 * one per matching civic address. Schema preserved for debugging only;
 * downstream code only cares about geometry.
 *
 * Uses the .json endpoint (not .geojson) because the dataset has two
 * geometry-typed columns and explicit conversion is more predictable than
 * letting Socrata pick one.
 */
export async function searchAddresses({ address }) {
  if (!address) return { type: 'FeatureCollection', features: [] };
  const params = new URLSearchParams({
    $where: likeClause('full_address', address),
    $select: 'full_address,point',
    $order: 'full_address',
    $limit: '1000',
  });
  const url = `${ADDRESSES_URL}?${params}`;
  const headers = APP_TOKEN ? { 'X-App-Token': APP_TOKEN } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SODA ${res.status}: ${body.slice(0, 200)}`);
  }
  const rows = await res.json();
  const features = rows
    .filter((r) => r.point?.coordinates?.length === 2)
    .map((r) => ({
      type: 'Feature',
      geometry: r.point,
      properties: { full_address: r.full_address },
    }));
  return { type: 'FeatureCollection', features };
}

/**
 * Cross-reference path for the assessment-first flow: take every civic
 * address matching the user's text, find the assessment parcel that
 * contains each point, and return those parcels.
 *
 * `extraFilters` re-applies the user's roll / zoning constraints so the
 * cross-reference path can't surface parcels that wouldn't have matched
 * the direct query for unrelated reasons.
 */
async function searchAddressesAndFindParcels(address, extraFilters) {
  const addressFc = await searchAddresses({ address });
  if (!addressFc.features.length) {
    return { type: 'FeatureCollection', features: [] };
  }
  const candidates = await fetchAssessmentByAddressPoints(addressFc, extraFilters);
  // The within_box query is bbox-based and returns neighbouring parcels too
  // (the same 150m pad we use everywhere). Filter to only parcels that
  // actually contain at least one matched address point.
  const features = candidates.features.filter((parcel) =>
    addressFc.features.some((addr) => booleanPointInPolygon(addr, parcel))
  );
  return { type: 'FeatureCollection', features };
}

/**
 * Per-point within_box lookup against the assessment dataset. `extraFilters`
 * (roll, zoning) get ANDed with the OR'd within_box clauses so the user's
 * non-address filters still apply on this path.
 */
async function fetchAssessmentByAddressPoints(addressFc, extraFilters = {}) {
  const extras = [];
  if (extraFilters.roll)   extras.push(likeClause('roll_number', extraFilters.roll));
  if (extraFilters.zoning) extras.push(likeClause('zoning', extraFilters.zoning));
  return fetchPerFeatureBboxUnion({
    baseUrl: ASSESS_URL,
    geomColumn: 'geometry',
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    dedupeKey: 'roll_number',
    fc: addressFc,
    extraWhere: extras.length ? extras.join(' AND ') : null,
  });
}

/**
 * Merge several FeatureCollections, dropping duplicates by a property key.
 * First-seen wins, so callers can order inputs by preference (e.g. direct
 * matches before cross-reference matches).
 */
function mergeFcByKey(fcs, key) {
  const seen = new Set();
  const features = [];
  for (const fc of fcs) {
    for (const feat of fc.features) {
      const k = feat.properties?.[key];
      if (k != null && seen.has(k)) continue;
      if (k != null) seen.add(k);
      features.push(feat);
    }
  }
  return { type: 'FeatureCollection', features };
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
      matches = surveyFc.features.filter((s) => assessCentroidInSurvey(a, s));
    } catch (err) {
      console.warn('join error; falling back to unmatched row', err);
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
/**
 * Returns true if the assessment parcel's centroid (from its
 * centroid_lat / centroid_lon properties) lies inside the survey polygon.
 * Falls back to booleanIntersects when centroid coords are unavailable
 * so no row is silently dropped.
 */
function assessCentroidInSurvey(assessFeature, surveyFeature) {
  const lat = parseFloat(assessFeature.properties?.centroid_lat);
  const lon = parseFloat(assessFeature.properties?.centroid_lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return booleanPointInPolygon([lon, lat], surveyFeature);
  }
  // No centroid — fall back to full polygon intersection.
  return booleanIntersects(assessFeature, surveyFeature);
}

async function fetchPerFeatureBboxUnion({ baseUrl, geomColumn, select, dedupeKey, fc, extraWhere = null }) {
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
      const groupClause = group.join(' OR ');
      // When a caller supplies extra filters (e.g. roll/zoning constraints
      // riding along on an address-points lookup), AND them with the OR'd
      // within_box clauses so the spatial result is still narrowed by the
      // user's other filters. Parens around the OR group keep precedence
      // explicit.
      const where = extraWhere
        ? `(${groupClause}) AND ${extraWhere}`
        : groupClause;
      const params = new URLSearchParams({
        $where: where,
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
