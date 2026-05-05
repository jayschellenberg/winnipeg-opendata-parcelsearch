// SODA (Socrata) API client for Winnipeg Open Data.
//
// Two datasets:
//   Survey Parcels     sjjm-nj47   (id, lot, block, plan, description, location)
//      geometry column name in SoQL: `location`  (multipolygon)
//   Assessment Parcels d4mq-wa44   (roll_number, full_address, zoning, geometry, ...)
//      geometry column name in SoQL: `geometry`  (multipolygon)
//
// Two search flows, both built from paged SODA calls:
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
// User-facing searches intentionally cap at 1,000 rows and return
// truncation metadata; enrichment and overlay queries page until complete.

import bbox from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { intersect } from '@turf/intersect';
import { area } from '@turf/area';

const SURVEY_URL = 'https://data.winnipeg.ca/resource/sjjm-nj47.geojson';
const ASSESS_URL = 'https://data.winnipeg.ca/resource/d4mq-wa44.geojson';
// Civic addresses dataset. One row per officially recognized address with a
// `point` geometry. No roll_number link — addresses join to assessment
// parcels geometrically (point-in-polygon).
const ADDRESSES_URL = 'https://data.winnipeg.ca/resource/cam2-ii3u.json';
// Zoning By-law Parcels dataset (~18K polygons). Geometry column: `location`.
// Used to render a toggleable zoning overlay scoped to the search-result area.
const ZONING_URL = 'https://data.winnipeg.ca/resource/dxrp-w6re.geojson';

// OurWinnipeg policy-area datasets used as toggleable overlays. All
// small, citywide — fetched whole and cached for the session, no
// per-search filtering. Geometry column: `location` for all of them.
//
// "Secondary Plans" is the union of two datasets per the City's metadata:
//   xh28-4smq Precinct: "Precincts define the geographic boundaries of
//     [secondary] plans" — for new-community development.
//   piz6-n3at Major Redevelopment Site: "Secondary plans to guide the
//     area's transformation must be adopted by Council prior to
//     development" — for major infill/intensification sites.
const SECONDARY_PLAN_PRECINCT_URL  = 'https://data.winnipeg.ca/resource/xh28-4smq.geojson';  // OurWPG Precinct (5)
const SECONDARY_PLAN_REDEV_URL     = 'https://data.winnipeg.ca/resource/piz6-n3at.geojson';  // OurWPG Major Redev Site (11)
const INFILL_GUIDELINE_URL         = 'https://data.winnipeg.ca/resource/5guk-f7xw.geojson';  // OurWPG Mature Community
const MALLS_REGIONAL_CENTRE_URL    = 'https://data.winnipeg.ca/resource/wv32-jdtk.geojson';  // OurWPG Regional Mixed Use Centre
const CORRIDORS_URBAN_URL          = 'https://data.winnipeg.ca/resource/t4kh-5gtd.geojson';  // OurWPG Urban Mixed Use Corridor
const CORRIDORS_REGIONAL_URL       = 'https://data.winnipeg.ca/resource/ahzi-uwu2.geojson';  // OurWPG Regional Mixed Use Corridor

// Traffic-volume overlays. Midblock counts are 15-minute portable-count rows
// keyed by study/corridor but have no geometry. Road Network supplies the
// street-centerline geometry we use for a best-effort corridor match. Permanent
// count stations have point geometry and are shown as station circles.
const MIDBLOCK_TRAFFIC_COUNTS_URL = 'https://data.winnipeg.ca/resource/buvf-b9wp.json';
const PERMANENT_TRAFFIC_COUNTS_URL = 'https://data.winnipeg.ca/resource/46sc-6jrs.json';
const ROAD_NETWORK_URL = 'https://data.winnipeg.ca/resource/ngsx-caav.geojson';

// Optional Socrata app token. Raises the anonymous rate limit.
// Set via Vercel env var VITE_SODA_APP_TOKEN; undefined in anonymous mode.
const APP_TOKEN = import.meta.env.VITE_SODA_APP_TOKEN;

const USER_SEARCH_LIMIT = 1000;
const SODA_PAGE_SIZE = 5000;
const SODA_MAX_ROWS = 100000;
const TRAFFIC_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TRAFFIC_CACHE_KEY = 'trafficVolumeLinesV3';

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
    $order: 'id',
  });
  return fetchSodaPaged(SURVEY_URL, params, {
    pageSize: USER_SEARCH_LIMIT,
    maxRows: USER_SEARCH_LIMIT,
    allowTruncated: true,
    label: 'Survey parcel search',
  });
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
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,dwelling_units,total_assessed_value,detail_url,current_assessment_year,geometry',
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
  // In the legal flow, `assessFc` is the result of fetchAssessmentOverlap
  // keyed off `surveyFc` — i.e. it already contains every assessment that
  // touches each survey. So `matches.length > 1` for a survey is a true
  // partial signal, no extra fetch needed.
  const partialSurveyIds = new Set();
  for (const s of surveyFc.features) {
    let matches;
    try {
      matches = assessFc.features.filter((a) => parcelsOverlap(s, a));
    } catch (err) {
      console.warn('join error; falling back to unmatched row', err);
      matches = [];
    }
    if (matches.length > 1) {
      const id = s.properties?.id;
      if (id != null) partialSurveyIds.add(id);
    }
    // One row per survey parcel. When multiple assessment rolls fall on the
    // same survey lot (duplex / condo splits), their fields are merged into
    // a single synthetic feature so the table stays one-row-per-parcel. The
    // survey side is wrapped in mergeSurveyFeatures purely to apply the
    // partial marker to the lot value when applicable.
    const sMerged = mergeSurveyFeatures([s], partialSurveyIds);
    rows.push({ survey: sMerged, assess: mergeAssessFeatures(matches) });
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
export async function searchAssessmentParcels({ roll, address, zoning, duMode, duMin }) {
  const clauses = [];
  const rc = rollClause(roll);
  if (rc)      clauses.push(rc);
  if (address) clauses.push(likeClause('full_address', address));
  if (zoning)  clauses.push(likeClause('zoning', zoning));
  const duClause = buildDuClause(duMode, duMin);
  if (duClause) clauses.push(duClause);
  if (clauses.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,dwelling_units,total_assessed_value,detail_url,current_assessment_year,geometry',
    $order: 'full_address',
  });
  return fetchSodaPaged(ASSESS_URL, params, {
    pageSize: USER_SEARCH_LIMIT,
    maxRows: USER_SEARCH_LIMIT,
    allowTruncated: true,
    label: 'Assessment parcel search',
  });
}

/**
 * Build a SoQL clause for the dwelling-units filter. The `dwelling_units`
 * column on d4mq-wa44 is stored as text, so we cast with ::number to compare
 * numerically (otherwise "9" > "10" lexicographically, which is wrong).
 *
 *   duMode = 'zero' -> "dwelling_units::number = 0"  (vacant lots only)
 *   duMode = 'min'  -> "dwelling_units::number >= N" (≥ N dwelling units)
 *   anything else   -> null (no filter)
 */
function buildDuClause(duMode, duMin) {
  if (duMode === 'zero') return 'dwelling_units::number = 0';
  if (duMode === 'min') {
    const n = parseInt(duMin, 10);
    if (Number.isFinite(n) && n > 0) return `dwelling_units::number >= ${n}`;
  }
  return null;
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
export async function searchAssessmentParcelsExpanded({ roll, address, zoning, duMode, duMin }) {
  const directPromise = searchAssessmentParcels({ roll, address, zoning, duMode, duMin });
  const xrefPromise = address
    ? searchAddressesAndFindParcels(address, { roll, zoning, duMode, duMin })
    : Promise.resolve({ type: 'FeatureCollection', features: [] });
  const [directFc, xrefFc] = await Promise.all([directPromise, xrefPromise]);
  const merged = mergeFcByKey([directFc, xrefFc], 'roll_number');
  // Enrich each parcel's full_address with all civic addresses that fall
  // inside it, so multi-address parcels read e.g. "400 HARGRAVE STREET,
  // 440 HARGRAVE ST" — recognizable from any search direction. Wrapped
  // so any unexpected failure (cam2-ii3u down, malformed geometry, etc.)
  // never blocks the primary search results from rendering.
  let civicAddresses = { type: 'FeatureCollection', features: [] };
  try {
    ({ addresses: civicAddresses } = await enrichAssessmentAddresses(merged));
  } catch (err) {
    console.warn('address enrichment threw, continuing without it', err);
  }
  try {
    await enrichAssessmentZoning(merged);
  } catch (err) {
    console.warn('zoning enrichment threw, continuing without it', err);
  }
  return { parcels: merged, addresses: civicAddresses };
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
  });
  const { rows, meta } = await fetchSodaRowsPaged(ADDRESSES_URL, params, {
    pageSize: USER_SEARCH_LIMIT,
    maxRows: USER_SEARCH_LIMIT,
    allowTruncated: true,
    label: 'Civic address search',
  });
  const features = rows
    .filter((r) => r.point?.coordinates?.length === 2)
    .map((r) => ({
      type: 'Feature',
      geometry: r.point,
      properties: { full_address: r.full_address },
    }));
  return featureCollection(features, meta);
}

/**
 * Enrich every parcel's `full_address` with the complete set of civic
 * addresses from cam2-ii3u that fall inside its polygon. The assessment
 * dataset stores only the primary address per parcel, but a single parcel
 * can have many official civic addresses (corner buildings, large
 * commercial sites — 400 Hargrave is also 440 Hargrave). Without this,
 * searching by Plan / Roll / etc. shows only the primary address and the
 * user can't tell that the parcel is the same one they found earlier
 * via a secondary-address search.
 *
 * Returns the same `assessFc` object with `full_address` mutated in-place
 * to a comma-joined list (primary first, then alphabetical). Distinct only
 * — duplicates between primary and civic-dataset entries collapse.
 */
/**
 * Compute the area-weighted top-2 zoning districts for each assessment
 * parcel by intersecting the parcel polygon with every overlapping
 * zoning polygon. The Zoning column on d4mq-wa44 carries a single
 * primary code (the City's tax-assessment classification); area-weighted
 * computation reveals splits — e.g. a corner lot that's 70% R2 and 30%
 * C1, or where the assessment dataset's primary disagrees with the
 * actual mapped zone.
 *
 * Mutates each parcel's properties in place to add:
 *   zoning_top1, zoning_top1_pct  — the highest-coverage zone code + %
 *   zoning_top2, zoning_top2_pct  — second highest, or null if < 1%
 * The original `zoning` field is left untouched.
 *
 * Non-fatal: failures (turf throwing on bad geometry, zoning fetch
 * timing out) leave the parcel with its original zoning only.
 */
export async function enrichAssessmentZoning(assessFc) {
  if (!assessFc?.features?.length) return assessFc;
  let zoningFc;
  try {
    zoningFc = await fetchZoningOverlap(assessFc);
  } catch (err) {
    console.warn('zoning enrichment fetch failed', err);
    return assessFc;
  }
  if (!zoningFc?.features?.length) return assessFc;

  for (const parcel of assessFc.features) {
    try {
      // Quick bbox prefilter so we only run @turf/intersect against
      // zone polygons whose bbox actually overlaps this parcel.
      const candidates = zoningFc.features.filter((z) =>
        bboxesOverlap(parcel, z)
      );
      if (!candidates.length) continue;

      const totals = new Map();   // zone code -> total intersected area in m²
      let parcelArea = 0;
      try { parcelArea = area(parcel); } catch { /* ignore — fallback below */ }

      for (const zone of candidates) {
        try {
          // @turf/intersect v7 takes a FeatureCollection of two features,
          // not two separate args (v6 signature). Wrapping here so we don't
          // silently fall through to the zone-as-options misinterpretation.
          const inter = intersect({
            type: 'FeatureCollection',
            features: [parcel, zone],
          });
          if (!inter) continue;
          const a = area(inter);
          if (!Number.isFinite(a) || a <= 0) continue;
          const code = zone.properties?.zoning ?? '?';
          totals.set(code, (totals.get(code) || 0) + a);
        } catch { /* one zone polygon failed; keep going */ }
      }
      if (totals.size === 0) continue;

      const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      const denom = parcelArea > 0
        ? parcelArea
        : sorted.reduce((s, [, v]) => s + v, 0);
      const pct = (m2) => denom > 0 ? Math.round((m2 / denom) * 1000) / 10 : null;

      const [top1Code, top1Area] = sorted[0];
      parcel.properties.zoning_top1 = top1Code;
      parcel.properties.zoning_top1_pct = pct(top1Area);
      if (sorted.length > 1) {
        const [top2Code, top2Area] = sorted[1];
        const top2Pct = pct(top2Area);
        // Suppress digitization-sliver entries < 1% — they're noise.
        if (top2Pct != null && top2Pct >= 1) {
          parcel.properties.zoning_top2 = top2Code;
          parcel.properties.zoning_top2_pct = top2Pct;
        }
      }
    } catch (err) {
      console.warn('zoning intersect skipped for', parcel.properties?.roll_number, err);
    }
  }
  return assessFc;
}

/** Quick bbox-overlap check used as a prefilter before @turf/intersect.
 *  Cheap; eliminates the obvious non-overlaps so we don't pay the
 *  intersection cost for every parcel × every zone in the result set. */
function bboxesOverlap(a, b) {
  try {
    const [a1, a2, a3, a4] = bbox(a);
    const [b1, b2, b3, b4] = bbox(b);
    return !(a3 < b1 || b3 < a1 || a4 < b2 || b4 < a2);
  } catch { return true; /* on error, fall through and let intersect decide */ }
}

export async function enrichAssessmentAddresses(assessFc) {
  const emptyAddrs = { type: 'FeatureCollection', features: [] };
  if (!assessFc.features.length) {
    return { parcels: assessFc, addresses: emptyAddrs };
  }
  let addressesFc;
  try {
    addressesFc = await fetchAddressPointsForParcels(assessFc);
  } catch (err) {
    console.warn('civic address enrichment failed', err);
    return { parcels: assessFc, addresses: emptyAddrs };
  }

  // We mutate parcel.full_address in-place AND collect the address
  // points that fall inside any result parcel, deduped by their
  // full_address text. The collected points are returned for the
  // map's civic-address label layer.
  const matchedAddresses = new Map();  // full_address -> Feature

  for (const parcel of assessFc.features) {
    // Guard each parcel individually so one bad/odd geometry doesn't
    // abort the whole pass and leave the rest of the table without
    // address enrichment. (booleanPointInPolygon can throw on edge-
    // case geometries; better to skip the parcel than the batch.)
    try {
      const insideAddrs = addressesFc.features.filter(
        (addr) => booleanPointInPolygon(addr, parcel)
      );
      const matches = insideAddrs
        .map((addr) => addr.properties?.full_address)
        .filter(Boolean);
      if (matches.length === 0) continue;
      const primary = parcel.properties?.full_address || '';
      const distinct = [...new Set(matches.map((a) => a.trim()))];
      distinct.sort((a, b) => {
        // Keep the primary first; everything else alphabetical.
        if (a === primary) return -1;
        if (b === primary) return 1;
        return a.localeCompare(b);
      });
      if (primary && !distinct.includes(primary)) distinct.unshift(primary);
      parcel.properties.full_address = distinct.join(', ');

      // Stash each address point for the map layer, deduped on the
      // full_address string. Stamp a `street_num` (digits before the
      // first space) so the label layer can render just the number.
      for (const addr of insideAddrs) {
        const fa = (addr.properties?.full_address || '').trim();
        if (!fa || matchedAddresses.has(fa)) continue;
        const numMatch = fa.match(/^(\d+(?:[A-Za-z]|\s?1\/2)?)/);
        const street_num = numMatch ? numMatch[1] : '';
        matchedAddresses.set(fa, {
          type: 'Feature',
          geometry: addr.geometry,
          properties: { full_address: fa, street_num },
        });
      }
    } catch (err) {
      console.warn('parcel address enrichment skipped for', parcel.properties?.roll_number, err);
    }
  }
  return {
    parcels: assessFc,
    addresses: { type: 'FeatureCollection', features: [...matchedAddresses.values()] },
  };
}

/**
 * Per-parcel within_box query against cam2-ii3u to fetch civic-address
 * points covering the parcel set. The dataset has both `location` and
 * `point` geometry-typed columns; `point` is the GeoJSON Point we want.
 * Uses .json (not .geojson) so the column choice is explicit and the
 * conversion to features happens in code.
 */
async function fetchAddressPointsForParcels(parcelFc) {
  if (!parcelFc.features.length) {
    return { type: 'FeatureCollection', features: [] };
  }
  const round = (n) => n.toFixed(6);
  const PAD = 0.002;
  const clauses = parcelFc.features.map((f) => {
    const [minLon, minLat, maxLon, maxLat] = bbox(f);
    return `within_box(point,${round(maxLat + PAD)},${round(minLon - PAD)},${round(minLat - PAD)},${round(maxLon + PAD)})`;
  });

  const BATCH = 50;
  const batches = [];
  for (let i = 0; i < clauses.length; i += BATCH) {
    batches.push(clauses.slice(i, i + BATCH));
  }

  const responses = await Promise.all(
    batches.map((group) => {
      const params = new URLSearchParams({
        $where: group.join(' OR '),
        $select: 'full_address,point',
        $order: 'full_address',
      });
      return fetchSodaRowsPaged(ADDRESSES_URL, params, {
        label: 'Civic address enrichment',
      });
    })
  );

  const features = [];
  const seen = new Set();
  for (const { rows } of responses) {
    for (const row of rows) {
      if (!row.point?.coordinates || row.point.coordinates.length !== 2) continue;
      const key = `${row.full_address}|${row.point.coordinates.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({
        type: 'Feature',
        geometry: row.point,
        properties: { full_address: row.full_address },
      });
    }
  }
  return featureCollection(features);
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
  return featureCollection(features, mergeMeta([addressFc, candidates]));
}

/**
 * Per-point within_box lookup against the assessment dataset. `extraFilters`
 * (roll, zoning) get ANDed with the OR'd within_box clauses so the user's
 * non-address filters still apply on this path.
 */
async function fetchAssessmentByAddressPoints(addressFc, extraFilters = {}) {
  const extras = [];
  const rc = rollClause(extraFilters.roll);
  if (rc) extras.push(rc);
  if (extraFilters.zoning) extras.push(likeClause('zoning', extraFilters.zoning));
  const duClause = buildDuClause(extraFilters.duMode, extraFilters.duMin);
  if (duClause) extras.push(duClause);
  return fetchPerFeatureBboxUnion({
    baseUrl: ASSESS_URL,
    geomColumn: 'geometry',
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,dwelling_units,total_assessed_value,detail_url,current_assessment_year,geometry',
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
  const meta = mergeMeta(fcs);
  for (const fc of fcs) {
    for (const feat of fc.features) {
      const k = feat.properties?.[key];
      if (k != null && seen.has(k)) continue;
      if (k != null) seen.add(k);
      features.push(feat);
    }
  }
  return featureCollection(features, meta);
}

/**
 * Fetch Zoning By-law Parcels that overlap the supplied search results.
 * Scoped to the result area only (per-feature within_box, same pattern as
 * the survey/assessment overlap helpers) so we never pull all 18K zones
 * citywide. Returns a FeatureCollection of zoning polygons keyed by `id`.
 */
// Session-lived cache keyed by a stable hash of the parcel set's bboxes.
// Lets the user toggle Show Zoning off and on for the same search without
// re-running the same per-parcel within_box batch. In-memory only —
// resets on page reload, which is fine because every page-load runs a
// fresh search anyway. Bounded to the most recent few entries so the
// cache can't grow unbounded if the user runs many different searches in
// one session.
const ZONING_CACHE = new Map();
const ZONING_CACHE_MAX = 8;

// IndexedDB-backed cache for the citywide zoning fetch. ~13.5 MB gzipped
// over the wire, ~42 MB parsed; far too big for localStorage's 5 MB
// quota but trivial for IndexedDB (browser quotas in the hundreds of
// MB). Cached for a week — provincial zoning bylaws don't change
// hour-to-hour and a stale day in mid-cache is irrelevant for
// appraisal-research purposes. The cache is shared opportunistically
// by fetchZoningOverlap (per-search subset filter) so a cache-warm
// session avoids the per-parcel within_box network round trips too.
const CITY_ZONING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CITY_ZONING_CACHE_KEY = 'cityZoning';
let _cityZoningPromise = null;

/**
 * Return the entire dxrp-w6re zoning dataset (~18,400 polygons).
 * Reads from IndexedDB if a fresh entry exists; otherwise hits the
 * network and writes the result back to IndexedDB for next time. The
 * returned promise is memoised module-side so concurrent callers
 * share one in-flight fetch.
 */
export async function fetchCityZoning() {
  if (_cityZoningPromise) return _cityZoningPromise;
  _cityZoningPromise = (async () => {
    try {
      const cached = await idbReadCache(CITY_ZONING_CACHE_KEY, CITY_ZONING_TTL_MS);
      if (cached) return cached;
    } catch (err) {
      console.warn('IndexedDB read failed; falling back to network', err);
    }
    const params = new URLSearchParams({
      $select: 'id,zoning,short_description,long_description,map_colour,location',
      $order: 'id',
    });
    const fc = await fetchSodaPaged(ZONING_URL, params, {
      label: 'Citywide zoning fetch',
    });
    // Fire-and-forget so the caller doesn't wait on the disk write.
    idbWriteCache(CITY_ZONING_CACHE_KEY, fc).catch((err) =>
      console.warn('IndexedDB write failed for cityZoning', err)
    );
    return fc;
  })();
  // Clear the memoisation slot if the fetch fails so a retry can run.
  _cityZoningPromise.catch(() => { _cityZoningPromise = null; });
  return _cityZoningPromise;
}

export async function fetchZoningOverlap(parcelFc) {
  const key = parcelSetCacheKey(parcelFc);
  if (key && ZONING_CACHE.has(key)) {
    // Cache hit — return a shallow clone so callers can freely mutate
    // the FC without poisoning the cache.
    const cached = ZONING_CACHE.get(key);
    return { type: 'FeatureCollection', features: [...cached.features] };
  }

  // Opportunistic citywide cache: if the IndexedDB cache is fresh, we
  // already have every zoning polygon in memory after the first read,
  // so we can filter to the parcel-set bbox in-process and skip the
  // per-parcel within_box round-trips entirely. Falls back to the
  // network fetch when the cache is cold or unreachable.
  let fc = null;
  try {
    const cityCached = await idbReadCache(CITY_ZONING_CACHE_KEY, CITY_ZONING_TTL_MS);
    if (cityCached?.features?.length) {
      fc = filterZonesToParcelBbox(cityCached, parcelFc);
    }
  } catch { /* IDB unavailable; fall through to per-parcel fetch */ }

  if (!fc) {
    fc = await fetchPerFeatureBboxUnion({
      baseUrl: ZONING_URL,
      geomColumn: 'location',
      select: 'id,zoning,short_description,long_description,map_colour,location',
      dedupeKey: 'id',
      fc: parcelFc,
    });
  }

  if (key) {
    ZONING_CACHE.set(key, fc);
    // Trim the oldest entries when over the cap. JS Maps preserve
    // insertion order so .keys().next() is the oldest.
    while (ZONING_CACHE.size > ZONING_CACHE_MAX) {
      ZONING_CACHE.delete(ZONING_CACHE.keys().next().value);
    }
  }
  return fc;
}

/**
 * Filter a citywide zoning FC down to only the polygons whose bbox
 * overlaps the parcel set's bbox (with a 150m pad on each side, same
 * pattern as the SoQL within_box query). Cheap O(N) over ~18K rows.
 */
function filterZonesToParcelBbox(cityFc, parcelFc) {
  if (!parcelFc?.features?.length) {
    return { type: 'FeatureCollection', features: [] };
  }
  let pMinLon, pMinLat, pMaxLon, pMaxLat;
  try { [pMinLon, pMinLat, pMaxLon, pMaxLat] = bbox(parcelFc); }
  catch { return { type: 'FeatureCollection', features: cityFc.features }; }
  const PAD = 0.002;
  pMinLon -= PAD; pMinLat -= PAD;
  pMaxLon += PAD; pMaxLat += PAD;

  const features = [];
  for (const z of cityFc.features) {
    try {
      const [zMinLon, zMinLat, zMaxLon, zMaxLat] = bbox(z);
      if (zMaxLon < pMinLon || zMinLon > pMaxLon) continue;
      if (zMaxLat < pMinLat || zMinLat > pMaxLat) continue;
      features.push(z);
    } catch { /* skip malformed */ }
  }
  return { type: 'FeatureCollection', features };
}

// ---------- IndexedDB helpers (`wpsCache` DB, single `cache` store) ----------

const IDB_DB_NAME = 'wpsCache';
const IDB_STORE = 'cache';
let _idbOpenPromise = null;

function idbOpen() {
  if (_idbOpenPromise) return _idbOpenPromise;
  _idbOpenPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB not available'));
      return;
    }
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
  // Reset the singleton on failure so a later attempt can re-open.
  _idbOpenPromise.catch(() => { _idbOpenPromise = null; });
  return _idbOpenPromise;
}

async function idbReadCache(key, ttlMs) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => {
      const entry = req.result;
      if (!entry || typeof entry !== 'object' || !('t' in entry) || !('v' in entry)) {
        resolve(null);
        return;
      }
      if (Date.now() - entry.t > ttlMs) { resolve(null); return; }
      resolve(entry.v);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbWriteCache(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put({ v: value, t: Date.now() }, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Build a stable cache key for a parcel set: the sorted, rounded bboxes
 * of every feature joined into one string. Two searches that produce the
 * same parcel polygons (in any order) generate the same key.
 *
 * Returns null for empty input — callers skip the cache entirely.
 */
function parcelSetCacheKey(fc) {
  if (!fc?.features?.length) return null;
  const parts = [];
  for (const f of fc.features) {
    try {
      const [a, b, c, d] = bbox(f);
      // 5 decimal places ≈ ~1m at this latitude — far tighter than any
      // realistic difference between two "same-ness" parcel sets.
      parts.push(`${a.toFixed(5)},${b.toFixed(5)},${c.toFixed(5)},${d.toFixed(5)}`);
    } catch { /* skip a single bad feature; remaining set still keys stably */ }
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Fetch traffic-volume overlays:
 *   - midblock traffic counts joined onto road-network line geometry
 *   - permanent count stations as point markers using the latest 24h window
 *
 * Midblock counts are cached longer because the aggregate+join is the expensive
 * part and the underlying portable studies update slowly. Permanent stations
 * are fetched fresh so their 24h totals stay current.
 */
export async function fetchTrafficVolumes() {
  const [linesResult, stationsResult] = await Promise.allSettled([
    fetchTrafficVolumeLines(),
    fetchPermanentTrafficStations(),
  ]);

  if (linesResult.status === 'rejected' && stationsResult.status === 'rejected') {
    throw linesResult.reason || stationsResult.reason;
  }
  if (linesResult.status === 'rejected') {
    console.warn('traffic line overlay failed', linesResult.reason);
  }
  if (stationsResult.status === 'rejected') {
    console.warn('traffic station overlay failed', stationsResult.reason);
  }

  return {
    lines: linesResult.status === 'fulfilled' ? linesResult.value : featureCollection([]),
    stations: stationsResult.status === 'fulfilled' ? stationsResult.value : featureCollection([]),
  };
}

async function fetchTrafficVolumeLines() {
  try {
    const cached = await idbReadCache(TRAFFIC_CACHE_KEY, TRAFFIC_CACHE_TTL_MS);
    if (cached?.features) return cached;
  } catch (err) {
    console.warn('traffic cache read failed; rebuilding', err);
  }

  const [countRows, roadFc] = await Promise.all([
    fetchMidblockTrafficStudyRows(),
    fetchRoadNetwork(),
  ]);
  const latestRows = latestTrafficRowsByCorridor(countRows);
  const roadIndex = buildRoadIndex(roadFc);
  const fc = featureCollection(buildTrafficLineFeatures(latestRows, roadIndex), {
    source: 'Midblock Traffic Counts + Road Network',
    generated_at: new Date().toISOString(),
  });

  idbWriteCache(TRAFFIC_CACHE_KEY, fc).catch((err) =>
    console.warn('traffic cache write failed', err)
  );
  return fc;
}

async function fetchMidblockTrafficStudyRows() {
  const params = new URLSearchParams({
    $select: [
      'study_id',
      'street',
      'street_from',
      'street_to',
      'location_description',
      'count_date',
      'sum(count_15_minutes)',
      'count(*)',
    ].join(','),
    $group: 'study_id,street,street_from,street_to,location_description,count_date',
    $order: 'count_date DESC',
  });
  const { rows } = await fetchSodaRowsPaged(MIDBLOCK_TRAFFIC_COUNTS_URL, params, {
    label: 'Midblock traffic-count daily aggregate',
  });
  return aggregateMidblockStudyRows(rows);
}

function aggregateMidblockStudyRows(rows) {
  const byStudy = new Map();
  for (const row of rows) {
    const key = [
      row.study_id,
      normalizeStreetName(row.street),
      normalizeStreetName(row.street_from),
      normalizeStreetName(row.street_to),
      row.location_description || '',
    ].join('|');
    if (!byStudy.has(key)) {
      byStudy.set(key, {
        study_id: row.study_id,
        street: row.street,
        street_from: row.street_from,
        street_to: row.street_to,
        location_description: row.location_description,
        min_count_date: row.count_date,
        max_count_date: row.count_date,
        sum_count_15_minutes: 0,
        count: 0,
        _dateSet: new Set(),
      });
    }
    const entry = byStudy.get(key);
    const total = Number(row.sum_count_15_minutes);
    if (Number.isFinite(total)) entry.sum_count_15_minutes += total;
    const intervals = Number(row.count);
    if (Number.isFinite(intervals)) entry.count += intervals;
    if (row.count_date) {
      entry._dateSet.add(row.count_date);
      if (!entry.min_count_date || Date.parse(row.count_date) < Date.parse(entry.min_count_date)) {
        entry.min_count_date = row.count_date;
      }
      if (!entry.max_count_date || Date.parse(row.count_date) > Date.parse(entry.max_count_date)) {
        entry.max_count_date = row.count_date;
      }
    }
  }

  return [...byStudy.values()].map((entry) => {
    const sample_day_count = entry._dateSet.size || 1;
    delete entry._dateSet;
    return { ...entry, sample_day_count };
  });
}

async function fetchRoadNetwork() {
  const params = new URLSearchParams({
    $select: 'segment_id,full_name,st_name,st_type,st_dir,from_right,to_right,from_left,to_left,type,the_geom',
    $order: 'segment_id',
  });
  return fetchSodaPaged(ROAD_NETWORK_URL, params, {
    label: 'Road network fetch',
  });
}

function latestTrafficRowsByCorridor(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = trafficCorridorKey(row);
    if (!key || seen.has(key)) continue;
    const avg = averageDailyVolume(row);
    if (!Number.isFinite(avg) || avg <= 0) continue;
    seen.add(key);
    row._avgDailyVolume = Math.round(avg);
    row._sampleDays = trafficStudyDayCount(row);
    out.push(row);
  }
  return out;
}

function buildTrafficLineFeatures(rows, roadIndex) {
  const bySegment = new Map();
  const endpointCache = new Map();

  for (const row of rows) {
    const features = buildTrafficCorridorFeatures(row, roadIndex, endpointCache);
    for (const feature of features) {
      const key = feature.properties.segment_id
        ? `segment:${feature.properties.segment_id}`
        : `study:${feature.properties.study_id}`;
      const existing = bySegment.get(key);
      if (!existing || newerTrafficFeature(feature, existing)) {
        bySegment.set(key, feature);
      }
    }
  }

  return [...bySegment.values()];
}

function buildTrafficCorridorFeatures(row, roadIndex, endpointCache) {
  const mainKey = normalizeStreetName(row.street);
  const mainGroup = roadIndex.get(mainKey);
  if (!mainGroup) return [];

  const fromPoint = findStreetCrossing(mainGroup, row.street_from, roadIndex, endpointCache);
  const toPoint = findStreetCrossing(mainGroup, row.street_to, roadIndex, endpointCache);
  if (!fromPoint || !toPoint || distanceSq(fromPoint, toPoint) < 1e-12) return [];

  const props = trafficLineProperties(row);
  const maxDist = corridorToleranceDeg(fromPoint, toPoint);
  const features = [];
  for (const roadFeature of mainGroup.features) {
    if (!roadFeatureWithinCorridor(roadFeature, fromPoint, toPoint, maxDist)) continue;
    features.push({
      type: 'Feature',
      geometry: roadFeature.geometry,
      properties: {
        ...props,
        segment_id: roadFeature.properties?.segment_id ?? null,
        road_name: roadFeature.properties?.full_name ?? row.street,
        match_type: 'road segment',
      },
    });
  }

  // Fallback: if the endpoints were found but no same-street segment midpoint
  // fell between them, draw a straight reference line. Rare, but better than
  // hiding a valid count because the road-network geometry is oddly split.
  if (!features.length) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [fromPoint, toPoint] },
      properties: { ...props, segment_id: null, road_name: row.street, match_type: 'approximate corridor' },
    });
  }
  return features;
}

function trafficLineProperties(row) {
  const avg = row._avgDailyVolume;
  return {
    traffic_kind: 'midblock',
    study_id: row.study_id,
    street: row.street,
    street_from: row.street_from,
    street_to: row.street_to,
    location_description: row.location_description,
    avg_daily_volume: avg,
    volume_label: shortTrafficVolume(avg),
    volume_text: Number(avg).toLocaleString('en-US'),
    count_start: row.min_count_date,
    count_end: row.max_count_date,
    sample_days: row._sampleDays,
    interval_count: Number(row.count) || null,
    source_name: 'Midblock Traffic Counts',
  };
}

function newerTrafficFeature(a, b) {
  const da = Date.parse(a.properties?.count_end || '');
  const db = Date.parse(b.properties?.count_end || '');
  if (Number.isFinite(da) && Number.isFinite(db) && da !== db) return da > db;
  return Number(a.properties?.avg_daily_volume || 0) > Number(b.properties?.avg_daily_volume || 0);
}

async function fetchPermanentTrafficStations() {
  const latestParams = new URLSearchParams({ $select: 'max(timestamp)' });
  const { rows: latestRows } = await fetchSodaRowsPaged(PERMANENT_TRAFFIC_COUNTS_URL, latestParams, {
    label: 'Permanent traffic station latest timestamp',
  });
  const latest = latestRows[0]?.max_timestamp;
  if (!latest) return featureCollection([]);

  const end = new Date(latest);
  const start = new Date(end.getTime() - (24 * 60 * 60 * 1000) + (15 * 60 * 1000));
  const where = `timestamp >= '${sodaDateTime(start)}' AND timestamp <= '${sodaDateTime(end)}'`;
  const params = new URLSearchParams({
    $select: 'site,location,min(timestamp),max(timestamp),sum(total),count(*)',
    $where: where,
    $group: 'site,location',
    $order: 'site',
  });
  const { rows } = await fetchSodaRowsPaged(PERMANENT_TRAFFIC_COUNTS_URL, params, {
    label: 'Permanent traffic station 24h aggregate',
  });

  const features = rows
    .filter((row) => row.location?.coordinates?.length === 2)
    .map((row) => {
      const avg = Math.round(Number(row.sum_total) / Math.max(trafficSampleDays({
        min_count_date: row.min_timestamp,
        max_count_date: row.max_timestamp,
      }), 1));
      return {
        type: 'Feature',
        geometry: row.location,
        properties: {
          traffic_kind: 'station',
          site: row.site,
          avg_daily_volume: avg,
          volume_label: shortTrafficVolume(avg),
          volume_text: Number(avg).toLocaleString('en-US'),
          count_start: row.min_timestamp,
          count_end: row.max_timestamp,
          interval_count: Number(row.count) || null,
          source_name: 'Permanent Count Station Traffic Counts',
        },
      };
    });
  return featureCollection(features, { source: 'Permanent Count Station Traffic Counts' });
}

function buildRoadIndex(roadFc) {
  const index = new Map();
  for (const feature of roadFc.features || []) {
    if (!feature.geometry) continue;
    const segments = flattenLineSegments(feature);
    if (!segments.length) continue;
    const aliases = roadNameAliases(feature.properties || {});
    for (const key of aliases) {
      if (!key) continue;
      if (!index.has(key)) index.set(key, { key, features: [], segments: [] });
      const group = index.get(key);
      group.features.push(feature);
      for (const seg of segments) group.segments.push({ ...seg, feature });
    }
  }
  return index;
}

function roadNameAliases(p) {
  const aliases = new Set();
  aliases.add(normalizeStreetName(p.full_name));
  aliases.add(normalizeStreetName([p.st_name, p.st_type, p.st_dir].filter(Boolean).join(' ')));
  aliases.add(normalizeStreetName([p.st_name, p.st_type].filter(Boolean).join(' ')));
  aliases.add(normalizeStreetName(p.st_name));
  aliases.delete('');
  return aliases;
}

function findStreetCrossing(mainGroup, crossStreet, roadIndex, cache) {
  const crossKey = normalizeStreetName(crossStreet);
  if (!crossKey) return null;
  const cacheKey = `${mainGroup.key}|${crossKey}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const crossGroup = roadIndex.get(crossKey);
  if (!crossGroup) {
    cache.set(cacheKey, null);
    return null;
  }

  let best = null;
  for (const mainSeg of mainGroup.segments) {
    for (const crossSeg of crossGroup.segments) {
      const intersectPoint = segmentIntersection(mainSeg.a, mainSeg.b, crossSeg.a, crossSeg.b);
      if (intersectPoint) {
        cache.set(cacheKey, intersectPoint);
        return intersectPoint;
      }
      const candidate = closestMainPointToSegment(mainSeg, crossSeg);
      if (!best || candidate.distSq < best.distSq) best = candidate;
    }
  }

  const snapLimit = 0.0012; // roughly 85m at Winnipeg latitude
  const point = best && best.distSq <= snapLimit * snapLimit ? best.point : null;
  cache.set(cacheKey, point);
  return point;
}

function roadFeatureWithinCorridor(feature, a, b, maxDist) {
  const center = featureCenter(feature);
  if (!center) return false;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return false;
  const t = ((center[0] - a[0]) * dx + (center[1] - a[1]) * dy) / lenSq;
  if (t < -0.04 || t > 1.04) return false;
  const proj = [a[0] + dx * t, a[1] + dy * t];
  return Math.sqrt(distanceSq(center, proj)) <= maxDist;
}

function featureCenter(feature) {
  try {
    const [minLon, minLat, maxLon, maxLat] = bbox(feature);
    return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  } catch {
    return null;
  }
}

function corridorToleranceDeg(a, b) {
  const len = Math.sqrt(distanceSq(a, b));
  return Math.min(0.01, Math.max(0.002, len * 0.18));
}

function flattenLineSegments(feature) {
  const geom = feature.geometry;
  const lines = [];
  if (geom.type === 'LineString') {
    lines.push(geom.coordinates);
  } else if (geom.type === 'MultiLineString') {
    lines.push(...geom.coordinates);
  }
  const segments = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (Array.isArray(a) && Array.isArray(b)) segments.push({ a, b });
    }
  }
  return segments;
}

function segmentIntersection(a, b, c, d) {
  const x1 = a[0], y1 = a[1];
  const x2 = b[0], y2 = b[1];
  const x3 = c[0], y3 = c[1];
  const x4 = d[0], y4 = d[1];
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-14) return null;
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denom;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denom;
  const eps = 1e-10;
  if (px < Math.min(x1, x2) - eps || px > Math.max(x1, x2) + eps) return null;
  if (py < Math.min(y1, y2) - eps || py > Math.max(y1, y2) + eps) return null;
  if (px < Math.min(x3, x4) - eps || px > Math.max(x3, x4) + eps) return null;
  if (py < Math.min(y3, y4) - eps || py > Math.max(y3, y4) + eps) return null;
  return [px, py];
}

function closestMainPointToSegment(mainSeg, crossSeg) {
  const candidates = [
    closestPointOnSegment(crossSeg.a, mainSeg.a, mainSeg.b),
    closestPointOnSegment(crossSeg.b, mainSeg.a, mainSeg.b),
    { point: mainSeg.a, distSq: distanceSq(mainSeg.a, closestPointOnSegment(mainSeg.a, crossSeg.a, crossSeg.b).point) },
    { point: mainSeg.b, distSq: distanceSq(mainSeg.b, closestPointOnSegment(mainSeg.b, crossSeg.a, crossSeg.b).point) },
  ];
  candidates[0].distSq = distanceSq(candidates[0].point, crossSeg.a);
  candidates[1].distSq = distanceSq(candidates[1].point, crossSeg.b);
  return candidates.sort((a, b) => a.distSq - b.distSq)[0];
}

function closestPointOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { point: a, distSq: distanceSq(p, a) };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const point = [a[0] + dx * t, a[1] + dy * t];
  return { point, distSq: distanceSq(p, point) };
}

function distanceSq(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function averageDailyVolume(row) {
  const total = Number(row.sum_count_15_minutes);
  const days = trafficStudyDayCount(row);
  return Number.isFinite(total) && days > 0 ? total / days : null;
}

function trafficStudyDayCount(row) {
  const days = Number(row.sample_day_count ?? row.count_distinct_count_date);
  if (Number.isFinite(days) && days > 0) return days;
  return trafficSampleDays(row);
}

function trafficSampleDays(row) {
  const start = Date.parse(row.min_count_date || row.min_timestamp || '');
  const end = Date.parse(row.max_count_date || row.max_timestamp || '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  const ms = Math.max(15 * 60 * 1000, end - start + 15 * 60 * 1000);
  return Math.round((ms / (24 * 60 * 60 * 1000)) * 100) / 100;
}

function trafficCorridorKey(row) {
  const street = normalizeStreetName(row.street);
  const a = normalizeStreetName(row.street_from);
  const b = normalizeStreetName(row.street_to);
  if (!street || !a || !b) return null;
  return `${street}|${[a, b].sort().join('|')}`;
}

const STREET_TYPE_ALIASES = {
  AVENUE: 'AVE',
  AV: 'AVE',
  BOULEVARD: 'BLVD',
  BVD: 'BLVD',
  CIRCLE: 'CIR',
  CRESCENT: 'CRES',
  CRESC: 'CRES',
  COURT: 'CRT',
  DRIVE: 'DR',
  HIGHWAY: 'HWY',
  LANE: 'LN',
  PARKWAY: 'PKWY',
  PLACE: 'PL',
  ROAD: 'RD',
  SAINT: 'ST',
  STREET: 'ST',
  TERRACE: 'TER',
  TRAIL: 'TRL',
};

function normalizeStreetName(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => STREET_TYPE_ALIASES[token] || token)
    .join(' ');
}

function shortTrafficVolume(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '';
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

function sodaDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Fetch the combined "Secondary Plans" overlay — the union of two
 * OurWinnipeg datasets per the City's own metadata definitions:
 *
 *   - OurWPG Precinct (xh28-4smq, 5 polygons) — "Precincts define the
 *     geographic boundaries of these plans" for new-community development.
 *     Each carries `precinct_name` ("B", "D", "S", "U", "V").
 *   - OurWPG Major Redevelopment Site (piz6-n3at, 11 polygons) —
 *     "Secondary plans to guide the area's transformation must be
 *     adopted by Council prior to development." Each carries
 *     `feature_name` (e.g. "Ravelston and Plessis", "Public Markets").
 *
 * Each feature is tagged with a `plan_kind` discriminator so popups +
 * labels can distinguish Precinct vs Major Redevelopment.
 */
export async function fetchSecondaryPlans() {
  const [precincts, redev] = await Promise.all([
    fetchAllAndCache('secondaryPlanPrecincts', SECONDARY_PLAN_PRECINCT_URL),
    fetchAllAndCache('secondaryPlanRedev',     SECONDARY_PLAN_REDEV_URL),
  ]);
  const features = [];
  for (const f of precincts.features) features.push(tagPlanKind(f, 'Precinct'));
  for (const f of redev.features)     features.push(tagPlanKind(f, 'Major Redevelopment'));
  return { type: 'FeatureCollection', features };
}

/** Stamp a `plan_kind` on each Secondary Plans feature so the layer
 *  paint expression can pick a colour and the popup can label it. */
function tagPlanKind(feature, kind) {
  feature.properties = feature.properties || {};
  feature.properties.plan_kind = kind;
  return feature;
}

/**
 * Fetch the OurWinnipeg "Mature Community" dataset (5guk-f7xw). These
 * are the pre-1950 neighbourhoods where the City's Mature Community
 * Infill Guidelines apply. Boundary-only — no useful per-polygon name.
 */
export async function fetchInfillGuidelineArea() {
  return fetchAllAndCache('infillGuideline', INFILL_GUIDELINE_URL);
}

/**
 * Fetch the combined "Malls and Corridors" PDO overlay — the union of
 * three OurWinnipeg datasets:
 *
 *   - Regional Mixed Use Centre (wv32-jdtk) — the "Malls" half (e.g.
 *     Kenaston and McGillivray, Polo Park, etc.)
 *   - Urban Mixed Use Corridor (t4kh-5gtd) — neighbourhood-scale corridors
 *   - Regional Mixed Use Corridor (ahzi-uwu2) — citywide corridors
 *
 * Each feature is tagged with a `pdo_kind` property so popups + labels
 * can distinguish "Mall" / "Urban Corridor" / "Regional Corridor".
 */
export async function fetchMallsAndCorridors() {
  const [malls, urbanCorr, regionalCorr] = await Promise.all([
    fetchAllAndCache('mallsRegionalCentre',  MALLS_REGIONAL_CENTRE_URL),
    fetchAllAndCache('corridorsUrban',       CORRIDORS_URBAN_URL),
    fetchAllAndCache('corridorsRegional',    CORRIDORS_REGIONAL_URL),
  ]);
  const features = [];
  for (const f of malls.features)        features.push(tagPdoKind(f, 'Mall'));
  for (const f of urbanCorr.features)    features.push(tagPdoKind(f, 'Urban Corridor'));
  for (const f of regionalCorr.features) features.push(tagPdoKind(f, 'Regional Corridor'));
  return { type: 'FeatureCollection', features };
}

/**
 * Stamp a `pdo_kind` discriminator on a feature so the combined Malls
 * and Corridors layer can render different colours / popup labels per
 * sub-dataset. Mutates the properties in place.
 */
function tagPdoKind(feature, kind) {
  feature.properties = feature.properties || {};
  feature.properties.pdo_kind = kind;
  return feature;
}

// Session cache for the small whole-dataset overlay fetches above.
// Keyed by a short logical name so each helper above hits the same
// cache slot every call. Promises (not resolved FCs) are stored so
// concurrent callers share one in-flight request — important when a
// user mashes a toggle button before the first fetch completes.
const OVERLAY_CACHE = new Map();

async function fetchAllAndCache(key, url) {
  if (OVERLAY_CACHE.has(key)) return OVERLAY_CACHE.get(key);
  const promise = (async () => {
    return fetchSodaPaged(url, new URLSearchParams(), {
      label: `Overlay fetch (${key})`,
    });
  })();
  OVERLAY_CACHE.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    // Don't poison the cache with a rejected promise — let the next
    // toggle attempt re-fire the request.
    OVERLAY_CACHE.delete(key);
    throw err;
  }
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
export function joinAssessmentWithSurvey(assessFc, surveyFc, partialSurveyIds = null) {
  const rows = [];
  for (const a of assessFc.features) {
    let matches;
    try {
      matches = surveyFc.features.filter((s) => parcelsOverlap(s, a));
    } catch (err) {
      console.warn('join error; falling back to unmatched row', err);
      matches = [];
    }
    // One row per assessment parcel. When the assessment covers multiple
    // survey lots (400 Hargrave, schools, big commercial buildings) the
    // lot column collapses into ranges grouped by plan, with any partial
    // lots — those that span into another roll — broken out individually
    // and suffixed "(partial)".
    rows.push({
      survey: mergeSurveyFeatures(matches, partialSurveyIds),
      assess: a,
    });
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

/**
 * Bbox-center fallback for survey polygons. The survey dataset has no
 * pre-computed centroid, but for the urban grid lots that fill most of the
 * city, the bbox center sits inside the polygon and is good enough for an
 * interior-overlap check. Used in the bidirectional join below.
 */
function surveyCenterInAssess(surveyFeature, assessFeature) {
  const [minX, minY, maxX, maxY] = bbox(surveyFeature);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return booleanPointInPolygon([cx, cy], assessFeature);
}

/**
 * Bidirectional containment check used by both joins. A pair matches if
 * either side's interior point sits inside the other polygon:
 *
 *   - Assessment centroid inside survey: handles the "many assessments per
 *     survey lot" case (e.g. duplex with two roll numbers on one lot).
 *   - Survey bbox center inside assessment: handles the "one assessment
 *     over many survey lots" case (e.g. 400 Hargrave is a single roll
 *     covering ~20 downtown lots — only one survey contains the assessment
 *     centroid, so the directional check used to lose the other 19).
 *
 * Symmetric check still rejects neighbouring-lot false matches because
 * neither centroid sits inside the *adjacent* parcel — the original bug
 * `booleanIntersects` triggered on shared edges, which both centroid checks
 * correctly avoid.
 */
function parcelsOverlap(surveyFeature, assessFeature) {
  return assessCentroidInSurvey(assessFeature, surveyFeature)
      || surveyCenterInAssess(surveyFeature, assessFeature);
}

/**
 * Collapse N survey features into a single synthetic feature. The Lot
 * column is the interesting one: surveys are grouped by (plan, block),
 * lots within a group are collapsed into numeric ranges where possible,
 * and when the merge spans multiple plans each group is annotated with
 * its plan code so the user can tell which lots belong where.
 *
 * Example output for 400 Hargrave (20 lots across two plans):
 *   "21-25, 68-75, 120-121 (Pl 129); 39, 41, 44-46 (Pl 24208)"
 *
 * `partialSurveyIds` is an optional Set of survey ids whose polygons span
 * multiple assessment parcels. Lots whose ids are in that Set are pulled
 * out of the range-collapsing step and listed individually with a
 * "(partial)" suffix so the appraiser can see at a glance that the lot is
 * split between rolls.
 *
 * Preserves the first feature's geometry and `_rowKey` so map-click →
 * row-scroll plumbing keeps working unchanged.
 */
function mergeSurveyFeatures(features, partialSurveyIds = null) {
  if (features.length === 0) return null;
  const isPartial = (f) =>
    partialSurveyIds && partialSurveyIds.has(f.properties?.id);

  if (features.length === 1) {
    const f = features[0];
    if (!isPartial(f)) return f;
    // Single survey, but still partial (lot extends into another roll
    // outside this assessment). Suffix the lot value so it's marked.
    const p = f.properties || {};
    return {
      ...f,
      properties: {
        ...p,
        lot: p.lot != null && p.lot !== '' ? `${p.lot} (partial)` : p.lot,
      },
    };
  }

  // Group by (plan, block). Most multi-lot parcels are within one plan
  // (downtown buildings on Plan 129); cross-plan is rare but real
  // (400 Hargrave: Plan 129 + 24208).
  const groups = new Map();
  for (const f of features) {
    const p = f.properties || {};
    const key = `${p.plan || ''}|${p.block || ''}`;
    if (!groups.has(key)) {
      groups.set(key, { plan: p.plan || '', block: p.block || '', items: [] });
    }
    groups.get(key).items.push({ lot: p.lot, partial: isPartial(f) });
  }

  // Format each group, sort groups by plan for stable output.
  const sortedGroups = [...groups.values()].sort((a, b) =>
    String(a.plan).localeCompare(String(b.plan)));
  const groupStrings = [];
  for (const g of sortedGroups) {
    const fullLots    = g.items.filter((i) => !i.partial).map((i) => i.lot);
    const partialLots = g.items.filter((i) =>  i.partial).map((i) => i.lot);

    const parts = [];
    if (fullLots.length > 0) parts.push(formatLotList(fullLots));
    if (partialLots.length > 0) {
      const partialFmt = [...new Set(
        partialLots.filter((l) => l != null && l !== '').map(String)
      )]
        .sort(naturalLotCompare)
        .map((l) => `${l} (partial)`)
        .join(', ');
      parts.push(partialFmt);
    }
    let groupStr = parts.filter(Boolean).join(', ');
    // Annotate with plan code when the merge spans multiple plans.
    if (groups.size > 1 && g.plan) {
      groupStr = `${groupStr} (Pl ${g.plan})`;
    }
    if (groupStr) groupStrings.push(groupStr);
  }

  const ps = features.map((f) => f.properties || {});
  return {
    type: 'Feature',
    geometry: features[0].geometry,
    properties: {
      id: ps[0].id,
      lot:         groupStrings.join('; '),
      block:       joinSortedDistinct(ps.map((p) => p.block)),
      plan:        joinSortedDistinct(ps.map((p) => p.plan)),
      description: joinSortedDistinct(ps.map((p) => p.description)),
      _rowKey:     ps[0]._rowKey,
    },
  };
}

/**
 * Numeric range collapse for an array of lot values. "21,22,23,24,25" →
 * "21-25". "21,22,25,26" → "21-22, 25-26". Falls back to a sorted comma-
 * list if any lot is non-numeric (e.g. "RL10", "1/2"), since ranges
 * wouldn't be meaningful for those.
 */
function formatLotList(lots) {
  const cleaned = lots
    .filter((l) => l != null && l !== '')
    .map((l) => String(l));
  if (cleaned.length === 0) return '';
  const distinct = [...new Set(cleaned)];
  const allNumeric = distinct.every((l) => /^\d+$/.test(l));
  if (!allNumeric) {
    return distinct.sort(naturalLotCompare).join(', ');
  }
  const sorted = distinct.map(Number).sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      parts.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return parts.join(', ');
}

/** Numeric-aware comparator: "9" < "10" < "9A". */
function naturalLotCompare(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * For each survey in `surveyFc`, count how many assessments in `assessFc`
 * its polygon overlaps. Returns the Set of survey ids whose count is >1
 * — those are surveys split across multiple assessment rolls.
 *
 * Caller is responsible for handing in an `assessFc` that's a complete
 * superset of overlapping assessments (e.g. via `fetchAssessmentOverlap`
 * keyed off `surveyFc`). If `assessFc` is just the search-result set, the
 * counts will under-report partials whose other half lives outside the
 * search.
 */
/**
 * Keep only the surveys whose polygon overlaps at least one assessment in
 * `assessFc`, AND stamp each kept survey's `_rowKey` to match the first
 * matching assessment's _rowKey. The row-key copy lets a map click on a
 * blue lot in the assessment-first flow scroll to the right (assessment-
 * keyed) row in the table. Mutates each kept feature's properties.
 */
export function filterMatchedSurveys(surveyFc, assessFc) {
  const features = [];
  for (const s of surveyFc.features) {
    const match = assessFc.features.find((a) => parcelsOverlap(s, a));
    if (!match) continue;
    s.properties = s.properties || {};
    if (match.properties?._rowKey != null) {
      s.properties._rowKey = match.properties._rowKey;
    }
    features.push(s);
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Mirror of filterMatchedSurveys for the legal flow. Each kept assessment
 * gets the first matching survey's `_rowKey` so clicking a red building
 * outline in legal flow scrolls to the (survey-keyed) row.
 */
export function filterMatchedAssessments(assessFc, surveyFc) {
  const features = [];
  for (const a of assessFc.features) {
    const match = surveyFc.features.find((s) => parcelsOverlap(s, a));
    if (!match) continue;
    a.properties = a.properties || {};
    if (match.properties?._rowKey != null) {
      a.properties._rowKey = match.properties._rowKey;
    }
    features.push(a);
  }
  return { type: 'FeatureCollection', features };
}

export function computePartialSurveyIds(surveyFc, assessFc) {
  const partials = new Set();
  for (const s of surveyFc.features) {
    let count = 0;
    for (const a of assessFc.features) {
      if (parcelsOverlap(s, a)) {
        count++;
        if (count > 1) break;
      }
    }
    if (count > 1) {
      const id = s.properties?.id;
      if (id != null) partials.add(id);
    }
  }
  return partials;
}

/**
 * Mirror of mergeSurveyFeatures for the assessment side, used by the
 * legal-description flow when one survey lot has multiple assessment
 * rolls on it (duplexes, condo splits). String fields are concatenated;
 * `assessed_land_area` is summed; centroid coords use the first parcel's
 * since an averaged centroid wouldn't be meaningful.
 */
function mergeAssessFeatures(features) {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];
  const ps = features.map((f) => f.properties || {});
  const totalArea = ps
    .map((p) => Number(p.assessed_land_area))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => a + b, 0);
  return {
    type: 'Feature',
    geometry: features[0].geometry,
    properties: {
      roll_number:  joinDistinct(ps.map((p) => p.roll_number)),
      full_address: joinDistinct(ps.map((p) => p.full_address)),
      zoning:       joinSortedDistinct(ps.map((p) => p.zoning)),
      assessed_land_area: totalArea > 0 ? String(totalArea) : null,
      centroid_lat: ps[0].centroid_lat,
      centroid_lon: ps[0].centroid_lon,
      _rowKey: ps[0]._rowKey,
    },
  };
}

/** Distinct, sorted (numeric where possible), comma-joined. */
function joinSortedDistinct(values) {
  const cleaned = values
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v !== '');
  const distinct = [...new Set(cleaned)];
  const allNumeric = distinct.length > 0 && distinct.every((v) => /^-?\d+(\.\d+)?$/.test(v));
  distinct.sort(allNumeric
    ? (a, b) => Number(a) - Number(b)
    : (a, b) => a.localeCompare(b));
  return distinct.join(', ');
}

/** Distinct, original-order, comma-joined. Used when sort order has no
 *  natural meaning (e.g. roll numbers from different rolls of one lot). */
function joinDistinct(values) {
  const cleaned = values
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v !== '');
  return [...new Set(cleaned)].join(', ');
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
      });
      if (select) params.set('$select', select);
      if (dedupeKey) params.set('$order', dedupeKey);
      return fetchSodaPaged(baseUrl, params, {
        label: 'Spatial enrichment query',
      });
    })
  );

  // Dedupe: the same feature can appear in multiple batches if its bbox
  // happens to straddle two input parcels near a batch boundary.
  const seen = new Set();
  const merged = [];
  const meta = mergeMeta(responses);
  for (const r of responses) {
    for (const feat of r.features) {
      const key = feat.properties?.[dedupeKey];
      if (key != null && seen.has(key)) continue;
      if (key != null) seen.add(key);
      merged.push(feat);
    }
  }
  return featureCollection(merged, meta);
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

async function fetchSodaPaged(baseUrl, params, options = {}) {
  const { items: features, meta } = await fetchSodaItemsPaged({
    baseUrl,
    params,
    getItems: (page) => page?.features || [],
    ...options,
  });
  return featureCollection(features, meta);
}

async function fetchSodaRowsPaged(baseUrl, params, options = {}) {
  return fetchSodaItemsPaged({
    baseUrl,
    params,
    getItems: (page) => Array.isArray(page) ? page : [],
    ...options,
  });
}

async function fetchSodaItemsPaged({
  baseUrl,
  params,
  getItems,
  pageSize = SODA_PAGE_SIZE,
  maxRows = SODA_MAX_ROWS,
  allowTruncated = false,
  label = 'SODA query',
}) {
  const items = [];
  let offset = 0;
  let truncated = false;

  while (items.length < maxRows) {
    const pageLimit = Math.min(pageSize, maxRows - items.length);
    const pageParams = new URLSearchParams(params);
    pageParams.set('$limit', String(pageLimit));
    pageParams.set('$offset', String(offset));

    const page = await fetchSoda(`${baseUrl}?${pageParams}`);
    const pageItems = getItems(page);
    items.push(...pageItems);
    offset += pageItems.length;

    if (pageItems.length < pageLimit || pageItems.length === 0) {
      break;
    }
  }

  if (items.length >= maxRows) {
    const probeParams = new URLSearchParams(params);
    probeParams.set('$limit', '1');
    probeParams.set('$offset', String(offset));
    const probe = await fetchSoda(`${baseUrl}?${probeParams}`);
    truncated = getItems(probe).length > 0;
  }

  if (truncated && !allowTruncated) {
    throw new Error(`${label} exceeded ${maxRows.toLocaleString('en-US')} rows; refine your search.`);
  }

  return {
    items,
    rows: items,
    meta: truncated ? { truncated: true, limit: maxRows, label } : null,
  };
}

function featureCollection(features, meta = null) {
  const fc = { type: 'FeatureCollection', features };
  if (meta) fc.meta = meta;
  return fc;
}

function mergeMeta(fcs) {
  return fcs.some((fc) => fc?.meta?.truncated)
    ? { truncated: true }
    : null;
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

/**
 * Build the roll-number SoQL clause based on the user input. Two modes,
 * automatically detected from the input:
 *
 *  - Single value (no commas/whitespace separators)
 *      "300"            → `upper(roll_number) like '%300%'`
 *    Partial-match LIKE — historical behaviour, lets the user type a
 *    fragment like a street block.
 *
 *  - Comma-separated list (>= 2 tokens after splitting on
 *    comma/whitespace/semicolon/newline/tab)
 *      "1000001000, 03093017710, 13052686500"
 *      → `roll_number IN ('01000001000','03093017710','13052686500')`
 *    Exact multi-roll lookup. Each token is normalised via
 *    `normalizeRoll` — strips non-digits and pads to 11 chars — so
 *    pasted lists tolerate missing leading zeros and stray formatting
 *    (commas vs newlines from Excel, tabs from a CSV cell, etc.).
 *
 * Returns the SoQL clause string, or null when input is empty.
 */
function rollClause(roll) {
  if (!roll) return null;
  const tokens = String(roll).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (tokens.length <= 1) {
    return likeClause('roll_number', roll);
  }
  const normalised = tokens.map(normalizeRoll).filter(Boolean);
  if (normalised.length === 0) return null;
  // Hard cap protects against accidentally pasting tens of thousands
  // of rolls and blowing past Socrata's URL/clause-length limits.
  // Typical use is < 10 rolls; 500 is a comfortable ceiling that
  // still fits in one query.
  const capped = normalised.slice(0, 500);
  const inList = capped.map((r) => `'${escapeSoql(r)}'`).join(',');
  return `roll_number IN (${inList})`;
}

/**
 * Normalise a single roll-number token to its canonical 11-digit form.
 * Strips any non-digit characters (commas, dashes, spaces) then pads
 * with leading zeros so that "1000001000" and "01000001000" key the
 * same. Returns null when nothing's left after stripping.
 */
function normalizeRoll(token) {
  const digits = String(token).replace(/[^0-9]/g, '');
  if (!digits) return null;
  return digits.length >= 11 ? digits : digits.padStart(11, '0');
}
