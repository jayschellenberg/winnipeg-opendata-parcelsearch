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
// Zoning By-law Parcels dataset (~18K polygons). Geometry column: `location`.
// Used to render a toggleable zoning overlay scoped to the search-result area.
const ZONING_URL = 'https://data.winnipeg.ca/resource/dxrp-w6re.geojson';

// Three OurWinnipeg policy-area datasets used as toggleable overlays.
// All small (5-24 polygons each), citywide — fetched whole and cached
// for the session, no per-search filtering. Geometry column: `location`
// for all three.
const SECONDARY_PLANS_URL          = 'https://data.winnipeg.ca/resource/xh28-4smq.geojson';  // OurWPG Precinct
const INFILL_GUIDELINE_URL         = 'https://data.winnipeg.ca/resource/5guk-f7xw.geojson';  // OurWPG Mature Community
const MALLS_REGIONAL_CENTRE_URL    = 'https://data.winnipeg.ca/resource/wv32-jdtk.geojson';  // OurWPG Regional Mixed Use Centre
const CORRIDORS_URBAN_URL          = 'https://data.winnipeg.ca/resource/t4kh-5gtd.geojson';  // OurWPG Urban Mixed Use Corridor
const CORRIDORS_REGIONAL_URL       = 'https://data.winnipeg.ca/resource/ahzi-uwu2.geojson';  // OurWPG Regional Mixed Use Corridor

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
  if (roll)    clauses.push(likeClause('roll_number', roll));
  if (address) clauses.push(likeClause('full_address', address));
  if (zoning)  clauses.push(likeClause('zoning', zoning));
  const duClause = buildDuClause(duMode, duMin);
  if (duClause) clauses.push(duClause);
  if (clauses.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,dwelling_units,geometry',
    $order: 'full_address',
    $limit: '1000',
  });
  return fetchSoda(`${ASSESS_URL}?${params}`);
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
  try {
    await enrichAssessmentAddresses(merged);
  } catch (err) {
    console.warn('address enrichment threw, continuing without it', err);
  }
  return merged;
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
export async function enrichAssessmentAddresses(assessFc) {
  if (!assessFc.features.length) return assessFc;
  let addressesFc;
  try {
    addressesFc = await fetchAddressPointsForParcels(assessFc);
  } catch (err) {
    console.warn('civic address enrichment failed', err);
    return assessFc;
  }
  for (const parcel of assessFc.features) {
    // Guard each parcel individually so one bad/odd geometry doesn't
    // abort the whole pass and leave the rest of the table without
    // address enrichment. (booleanPointInPolygon can throw on edge-
    // case geometries; better to skip the parcel than the batch.)
    try {
      const matches = addressesFc.features
        .filter((addr) => booleanPointInPolygon(addr, parcel))
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
    } catch (err) {
      console.warn('parcel address enrichment skipped for', parcel.properties?.roll_number, err);
    }
  }
  return assessFc;
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

  const headers = APP_TOKEN ? { 'X-App-Token': APP_TOKEN } : {};
  const responses = await Promise.all(
    batches.map(async (group) => {
      const params = new URLSearchParams({
        $where: group.join(' OR '),
        $select: 'full_address,point',
        $limit: '5000',
      });
      const res = await fetch(`${ADDRESSES_URL}?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`SODA ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return res.json();
    })
  );

  const features = [];
  const seen = new Set();
  for (const rows of responses) {
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
  const duClause = buildDuClause(extraFilters.duMode, extraFilters.duMin);
  if (duClause) extras.push(duClause);
  return fetchPerFeatureBboxUnion({
    baseUrl: ASSESS_URL,
    geomColumn: 'geometry',
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,dwelling_units,geometry',
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

export async function fetchZoningOverlap(parcelFc) {
  const key = parcelSetCacheKey(parcelFc);
  if (key && ZONING_CACHE.has(key)) {
    // Cache hit — return a shallow clone so callers can freely mutate
    // the FC without poisoning the cache.
    const cached = ZONING_CACHE.get(key);
    return { type: 'FeatureCollection', features: [...cached.features] };
  }
  const fc = await fetchPerFeatureBboxUnion({
    baseUrl: ZONING_URL,
    geomColumn: 'location',
    select: 'id,zoning,short_description,long_description,map_colour,location',
    dedupeKey: 'id',
    fc: parcelFc,
  });
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
 * Fetch the OurWinnipeg "Precinct" dataset (xh28-4smq). Each precinct is
 * the boundary of a Secondary Plan area. Tiny dataset — only 5 polygons
 * citywide — so we fetch the whole thing and cache it. Result FC carries
 * `precinct_name` ("A", "B", "C", etc.) for popups and labels.
 */
export async function fetchSecondaryPlans() {
  return fetchAllAndCache('secondaryPlans', SECONDARY_PLANS_URL);
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
    const params = new URLSearchParams({ $limit: '5000' });
    return fetchSoda(`${url}?${params}`);
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
