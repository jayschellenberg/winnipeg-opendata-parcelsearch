// SODA (Socrata) API client for Winnipeg Open Data.
//
// Two datasets:
//   Survey Parcels     sjjm-nj47   (id, lot, block, plan, description, location)
//   Assessment Parcels d4mq-wa44   (roll_number, full_address, zoning, geometry, ...)
//
// The search flow is two live SODA calls per user query:
//   1. searchSurveyParcels({ plan, lot, block, desc })
//      -> attribute filter on Survey Parcels, returns matching GeoJSON features
//   2. fetchAssessmentOverlap(surveyFc)
//      -> spatial within_box filter on Assessment Parcels using the union
//         bounding box of the matched survey parcels
// Then joinSurveyWithAssessment() does the exact polygon-overlap join
// client-side using turf.js.

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
