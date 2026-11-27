// Machine-readable index of the data this site reads, for scripts and AI
// agents (Claude skills and the property-intake agent) that want a Winnipeg
// parcel's facts without driving the UI. Winnipeg counterpart of the
// Manitoba app's src/lib/agentsIndex.js; same top-level shape so one client
// can read both.
//
// Built at BUILD time by the agents-index Vite plugin (vite.config.js), which
// reads the wpg-parcel-history pin out of src/soda.js. Pure module, tested in
// test/agentsIndex.test.js. Nothing here publishes new data: every URL is one
// the app already fetches.

export const SITE = 'https://winnipeg-opendata-parcelsearch.vercel.app';
export const SODA = 'https://data.winnipeg.ca/resource';
export const R2_BASE = 'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev';

export function readPins(sodaSource) {
  const history = /wpg-parcel-history@([0-9a-f]{40})/.exec(sodaSource)?.[1] ?? null;
  return { history };
}

const OGL_WPG = 'Open Government Licence - Winnipeg (https://data.winnipeg.ca/stories/s/Open-Data-Licence/). Credit the City of Winnipeg.';

export function buildAgentsIndex({ history }, builtAt = new Date().toISOString()) {
  if (!history) throw new Error('agentsIndex: missing wpg-parcel-history pin');
  const hist = `https://cdn.jsdelivr.net/gh/jayschellenberg/wpg-parcel-history@${history}`;
  const soda = (id, title, key, fields, notes, extra = {}) => ({
    id, title,
    url_template: `${SODA}/${id}.json?$where={SoQL}&$select={fields}&$limit={n}`,
    key, format: 'json (SODA); .geojson for geometry', fields, notes,
    vintage: `https://data.winnipeg.ca/api/views/${id}.json (rowsUpdatedAt, epoch seconds)`,
    licence: OGL_WPG,
    ...extra,
  });

  return {
    schema: 1,
    name: 'Winnipeg Parcel Search: data index for agents',
    site: SITE,
    built_at: builtAt,
    openapi: `${SITE}/openapi.json`,
    human_page: `${SITE}/agents.html`,
    coverage: 'City of Winnipeg (about 245,000 assessment parcels). Rest of Manitoba: see https://manitoba-opendata-parcelsearch.vercel.app/agents.json',
    usage: [
      'Screening and research only. Not an appraisal, survey, legal or planning opinion; confirm zoning with the City and assessment with the Assessment and Taxation Department before relying on either.',
      'Most data is the City of Winnipeg Open Data portal (Socrata). Query it directly with SoQL; send an X-App-Token header if you have one, otherwise expect rate limits. Page with $limit and $offset (5,000 a page).',
      'Key a parcel on roll_number (11 digits as text, leading zeros kept).',
      'Cite the source and vintage of each figure (the vintage pointer on every dataset).',
    ],
    pins: { 'wpg-parcel-history': history },
    keys: {
      roll_number: 'Assessment roll number, 11-character text with leading zeros, e.g. "03052795100". Primary key of d4mq-wa44.',
      street_number: 'Integer civic number on d4mq-wa44 and cam2-ii3u; street_name excludes the street type (PORTAGE, not PORTAGE AVENUE), which is in street_type.',
      neighbourhood_slug: 'History shards are named by neighbourhood_area upper-cased, spaces and slashes to hyphens, other punctuation dropped (CIVIC CENTRE -> CIVIC-CENTRE; lib/historicalSlug.js).',
    },
    recipes: [
      {
        task: 'Address to parcel (roll, value, zoning code, geometry)',
        steps: [
          `GET ${SODA}/d4mq-wa44.json?$where=street_number=<n> AND upper(street_name) like '%<NAME>%'&$select=roll_number,full_address,zoning,property_use_code,assessed_land_area,total_assessed_value,current_assessment_year,neighbourhood_area,centroid_lat,centroid_lon`,
          'If nothing matches (side-door addresses), look the address up in cam2-ii3u for its point, then query d4mq-wa44 with $where=intersects(geometry, \'POINT (<lon> <lat>)\').',
          `Use ${SODA}/d4mq-wa44.geojson with the same query for the polygon.`,
        ],
      },
      {
        task: 'Roll to current and proposed (next roll) assessment',
        steps: [`GET ${SODA}/d4mq-wa44.json?roll_number=<roll>; read total_assessed_value, assessed_value_1..5, property_class_1..5, current_assessment_year and the proposed_* fields (total_proposed_assessment_value, proposed_assessment_year), which the City fills only while a new roll is proposed (empty as of 2026-11). No tax dollar amounts are published here.`],
      },
      {
        task: 'Zoning for a parcel',
        steps: [
          `GET ${SODA}/dxrp-w6re.json?$where=intersects(location, 'POINT (<lon> <lat>)')&$select=zoning,short_description,long_description for the zone at the centroid.`,
          'For parcels split by a zone line, intersect the parcel polygon with the returned zones and rank by area. Amending by-laws by roll: /zoning-amendments.json byRoll[roll].',
        ],
      },
      {
        task: 'Building permits at an address',
        steps: [`GET ${SODA}/it4w-cpf4.json?$where=street_number='<n>' AND upper(street_name)='<NAME>'&$order=issue_date DESC&$limit=2000`],
      },
      {
        task: 'Rezoning and subdivision notices for a roll',
        steps: [`GET ${SODA}/gnxp-9hpt.json?$where=roll_number='<roll>' AND notice_type in('REZONING','SUBDIVISION AND REZONING','ZONING AGREEMENT AMENDMENT')`],
      },
      {
        task: 'Neighbourhood and cluster for a point',
        steps: [`GET ${SITE}/wpg-neighbourhoods.geojson and test the parcel centroid against each polygon (properties id, name, cluster); clusters in /wpg-neighbourhood-clusters.geojson.`],
      },
      {
        task: 'Assessed value and outline at earlier snapshots',
        steps: [
          `GET ${hist}/index.json for snapshot dates.`,
          `GET ${hist}/{date}/parcels/{NEIGHBOURHOOD_SLUG}.json and match roll_number (fields total_assessed_value, assessed_land_area, zoning). Values in the 2023 snapshot are text with commas.`,
          `Lineage: GET ${hist}/lineage/{NEIGHBOURHOOD_SLUG}.json -> by_roll[roll].`,
        ],
      },
    ],
    datasets: [
      soda('d4mq-wa44', 'Assessment parcels', 'roll_number',
        ['roll_number', 'full_address', 'street_number', 'street_name', 'street_type', 'unit_number', 'neighbourhood_area', 'market_region', 'zoning', 'property_use_code', 'building_type', 'year_built', 'total_living_area', 'rooms', 'dwelling_units', 'assessed_land_area', 'total_assessed_value', 'assessed_value_1..5', 'property_class_1..5', 'status_1..5', 'current_assessment_year', 'assessment_date', 'total_proposed_assessment_value', 'proposed_assessment_value_1..5', 'proposed_assessment_year', 'detail_url', 'centroid_lat', 'centroid_lon', 'geometry'],
        'About 245,000 rows. detail_url is the City assessment page for the roll.'),
      soda('cam2-ii3u', 'Civic addresses', 'street_number + street_name (no roll field)',
        ['full_address', 'street_number', 'street_name', 'street_type', 'point'], 'Resolve to a roll by point-in-polygon against d4mq-wa44.'),
      soda('sjjm-nj47', 'Survey parcels (lot, block, plan)', 'spatial, or like on plan/lot/block/description',
        ['plan', 'lot', 'block', 'description', 'location'], 'About 263,000 lots.'),
      soda('dxrp-w6re', 'Zoning by-law parcels (By-law 200/2006)', 'spatial intersects(location, ...)',
        ['zoning', 'short_description', 'long_description', 'map_colour', 'location'], 'About 18,400 polygons.'),
      soda('it4w-cpf4', 'Building permits', 'street_number + street_name; permit_number',
        ['issue_date', 'permit_number', 'permit_group', 'permit_type', 'sub_type', 'work_type', 'status', 'dwelling_units_created', 'dwelling_units_lost', 'type_of_structure', 'applicant_business_name', 'final_date', 'address'], 'The site also reads the PP&D permit portal (since 2000) through a proxy; that portal is not open data.'),
      soda('gnxp-9hpt', 'Public notices (rezoning, subdivision)', 'roll_number',
        ['notice_id', 'notice_type', 'roll_number', 'address', 'description', 'plain_language', 'in_date', 'meeting_date', 'decision', 'report_plan_url', 'point'], ''),
      soda('buvf-b9wp', 'Traffic counts (midblock)', 'spatial / street', ['various per count'], 'Permanent stations: 46sc-6jrs. Road network: ngsx-caav.'),
      {
        id: 'history-snapshots', title: 'Assessment parcel snapshots by date',
        index_url: `${hist}/index.json`,
        url_template: `${hist}/{date}/parcels/{NEIGHBOURHOOD_SLUG}.json`,
        key: 'snapshot date + neighbourhood slug; then roll_number', format: 'json',
        fields: ['roll_number', 'full_address', 'neighbourhood_area', 'market_region', 'zoning', 'assessed_land_area', 'total_assessed_value', 'property_use_code', 'detail_url'],
        notes: 'Snapshots 2023-11-13, 2025-02-26, 2026-07-01 at this pin. One total value per snapshot; no class split.',
        vintage: `${hist}/{date}/manifest.json`,
        licence: OGL_WPG,
      },
      {
        id: 'lineage', title: 'Parcel lineage (splits and consolidations)',
        url_template: `${hist}/lineage/{NEIGHBOURHOOD_SLUG}.json`,
        key: 'by_roll[roll_number]', format: 'json',
        fields: ['snapshot', 'type', 'confidence', 'predecessors[{snapshot, roll}]', 'successors[{snapshot, roll}]'],
        notes: 'Survey-lot lineage: survey-lineage/{slug}.json.', vintage: `${hist}/index.json generated`, licence: OGL_WPG,
      },
      {
        id: 'neighbourhoods', title: 'Neighbourhood boundaries and clusters',
        url_template: `${SITE}/wpg-neighbourhoods.geojson`, key: 'point-in-polygon', format: 'geojson',
        fields: ['id', 'name', 'cluster'], notes: '237 neighbourhoods; clusters file /wpg-neighbourhood-clusters.geojson.',
        vintage: '_meta.generated in the file', licence: OGL_WPG,
      },
      {
        id: 'zoning-amendments', title: 'Zoning amending by-laws by roll (DMIS)',
        url_template: `${SITE}/zoning-amendments.json`, key: 'byRoll[roll_number]', format: 'json',
        fields: ['by-law number', 'date', 'description'], notes: 'Scraped from the City DMIS by-law index.',
        vintage: 'generated', licence: 'City of Winnipeg DMIS; terms not confirmed.',
      },
      {
        id: 'transit', title: 'Transit stops, routes and frequent-transit walkshed',
        url_template: `${SITE}/transit-stops.geojson`, key: 'spatial', format: 'geojson',
        fields: ['stop_id', 'stop_code', 'stop_name', 'routes'], notes: 'Routes: /transit-routes.geojson. Walkshed: /frequent-transit-walkshed.geojson (Zoning Schedule AC Map 2).',
        vintage: '_meta.generated_at', licence: 'Winnipeg Transit GTFS; terms not confirmed.',
      },
      {
        id: 'rise-lookup', title: 'Building storeys by roll (estimated)',
        url_template: `${SITE}/rise-lookup.json`, key: 'roll_number', format: 'json',
        fields: ['storeys'], notes: 'Derived estimate (Overture building heights); not an assessor field.',
        vintage: 'file date', licence: 'Overture Maps (mixed ODbL/CDLA); terms not confirmed.',
      },
    ],
    live_services: [
      { id: 'contaminated-sites', url: 'https://manitoba.ca/sd/waste_management/contaminated_sites/registry/cs-data.csv', licence: 'Province of Manitoba; terms not confirmed' },
      { id: 'parcels-pmtiles', url: `${R2_BASE}/wpg-assessment-parcels.pmtiles`, licence: OGL_WPG },
    ],
    not_served: [
      'Sales: never published; the app reads sales only from a file or folder the user picks.',
      'Property tax dollars and mill rates: not held anywhere in this site.',
      'Census: not in this site. Census profiles are at https://housing-economic-data.vercel.app.',
      'Flood: link only, to https://mb-flood-mapping.vercel.app.',
    ],
  };
}

export function buildOpenApi({ history }) {
  const json = { description: 'JSON', content: { 'application/json': {} } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Winnipeg Parcel Search: data endpoints',
      version: '1',
      description: 'Static same-origin files. Most parcel data is the City of Winnipeg Socrata API (https://data.winnipeg.ca), documented in /agents.json rather than here. '
        + `History pin: wpg-parcel-history ${history}.`,
    },
    servers: [{ url: SITE }],
    paths: {
      '/agents.json': { get: { summary: 'This index: datasets, keys, recipes, licences', responses: { 200: json } } },
      '/wpg-neighbourhoods.geojson': { get: { summary: 'Neighbourhood boundaries', responses: { 200: json } } },
      '/wpg-neighbourhood-clusters.geojson': { get: { summary: 'Neighbourhood clusters', responses: { 200: json } } },
      '/zoning-amendments.json': { get: { summary: 'Zoning amending by-laws keyed by roll', responses: { 200: json } } },
      '/transit-stops.geojson': { get: { summary: 'Transit stops', responses: { 200: json } } },
      '/rise-lookup.json': { get: { summary: 'Estimated storeys by roll', responses: { 200: json } } },
    },
  };
}
