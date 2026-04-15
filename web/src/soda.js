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
//   B) Roll-number search (Roll # field):
//      1. searchAssessmentByRoll({ roll })
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
  if (plan)  clauses.push(`plan like '%${escapeSoql(plan)}%'`);
  if (lot)   clauses.push(`lot like '%${escapeSoql(lot)}%'`);
  if (block) clauses.push(`block like '%${escapeSoql(block)}%'`);
  if (desc)  clauses.push(`description like '%${escapeSoql(desc)}%'`);
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
 * Fetch Assessment Parcels that lie within the bounding box of the supplied
 * Survey Parcels FeatureCollection. Single SODA call regardless of result
 * count. Returns only the fields needed for enrichment.
 */
export async function fetchAssessmentOverlap(surveyFc) {
  if (!surveyFc.features.length) {
    return { type: 'FeatureCollection', features: [] };
  }

  // turf bbox returns [minX, minY, maxX, maxY] = [minLon, minLat, maxLon, maxLat]
  const [minLon, minLat, maxLon, maxLat] = bbox(surveyFc);

  // SoQL within_box(geom, nwLat, nwLon, seLat, seLon):
  //   NW corner = (maxLat, minLon),  SE corner = (minLat, maxLon)
  const whereClause =
    `within_box(geometry, ${maxLat}, ${minLon}, ${minLat}, ${maxLon})`;

  const params = new URLSearchParams({
    $where: whereClause,
    $select: 'roll_number,full_address,zoning,geometry',
    $limit: '2000',
  });
  return fetchSoda(`${ASSESS_URL}?${params}`);
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

// ---------- Roll-number search flow (mirror of the above) ----------

/**
 * Query Assessment Parcels by roll number (partial `like` match). Returns
 * a FeatureCollection with assessment-parcel geometry suitable for
 * rendering directly on the map.
 */
export async function searchAssessmentByRoll({ roll }) {
  if (!roll) return { type: 'FeatureCollection', features: [] };

  const params = new URLSearchParams({
    $where: `roll_number like '%${escapeSoql(roll)}%'`,
    $select: 'roll_number,full_address,zoning,geometry',
    $limit: '500',
  });
  return fetchSoda(`${ASSESS_URL}?${params}`);
}

/**
 * Fetch Survey Parcels that lie within the bounding box of the supplied
 * Assessment Parcels FeatureCollection. Used to back-fill legal-description
 * columns (lot/block/plan/description) for a roll-number search. The
 * Survey Parcels geometry column is `location`, not `geometry`.
 */
export async function fetchSurveyOverlap(assessFc) {
  if (!assessFc.features.length) {
    return { type: 'FeatureCollection', features: [] };
  }

  const [minLon, minLat, maxLon, maxLat] = bbox(assessFc);
  const whereClause =
    `within_box(location, ${maxLat}, ${minLon}, ${minLat}, ${maxLon})`;

  const params = new URLSearchParams({
    $where: whereClause,
    $limit: '2000',
  });
  return fetchSoda(`${SURVEY_URL}?${params}`);
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
