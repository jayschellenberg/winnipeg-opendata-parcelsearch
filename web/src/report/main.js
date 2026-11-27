// report.html: one-page preliminary property report for a Winnipeg parcel.
//
//   report.html?roll=<roll_number>
//
// Winnipeg counterpart of the Manitoba app's report. Opened from the parcel
// summary card. Fetches through soda.js so figures match the grid; City of
// Winnipeg open data plus the census-summary feed from Housing & Economic
// Data. Shares lib/reportData.js and report.css with the Manitoba app.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import {
  searchAssessmentParcelsByRolls, enrichAssessmentZoning, fetchZoningOverlap, fetchSoda,
  fetchPermitsAtAddress, fetchRezoningNotices, fetchRezoningNoticePoints, fetchZoningAmendments,
  fetchContaminatedSites, fetchNeighbourhoods, fetchTransitStops, fetchFrequentTransitWalkshed,
  normalizeRoll,
} from '../soda.js';
import { floodToolUrl, assessmentUrl } from '../lib/links.js';
import {
  centreOf, nearby, clean, fmtDistance, fmtMoney, fmtInt, CENSUS_FIELDS, censusColumns,
} from '../lib/reportData.js';
import { renderAssessmentHistory } from './assessmentHistory.js';

const CENSUS_SUMMARY_URL = import.meta.env?.VITE_CENSUS_SUMMARY_URL
  || 'https://housing-economic-data.vercel.app/data/housing/census-summary.json';
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ASSESS_ROWS_URL = 'https://data.winnipeg.ca/resource/d4mq-wa44.json';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sources = [];
const cite = (what, detail) => sources.push({ what, detail });
const section = (id, title, html) => { const el = $(id); if (!el) return; el.innerHTML = `<h2>${esc(title)}</h2>${html}`; el.hidden = false; };
const dl = (pairs) => `<dl class="rp-dl">${pairs.filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const settle = async (p) => { try { return await p; } catch (err) { console.warn(err); return undefined; } };
const table = (head, rows) => `<table class="rp-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

async function main() {
  const roll = normalizeRoll(new URLSearchParams(location.search).get('roll') || '');
  if (!roll) {
    $('rp-status').textContent = 'Open this report from a parcel in the search (it needs a roll number).';
    return;
  }
  $('rp-status').textContent = 'Loading parcel…';
  const fc = await searchAssessmentParcelsByRolls([roll]);
  const subject = fc?.features?.find((f) => f.properties?.roll_number === roll) || fc?.features?.[0];
  if (!subject) { $('rp-status').textContent = `Roll ${roll} was not found in the City's Assessment Parcels.`; return; }
  const p = subject.properties;
  const subjectFc = { type: 'FeatureCollection', features: [subject] };
  const at = Number.isFinite(Number(p.centroid_lat)) ? { lat: Number(p.centroid_lat), lon: Number(p.centroid_lon) } : centreOf(subject.geometry);
  cite('Parcel and assessment', 'City of Winnipeg Assessment Parcels (d4mq-wa44). Open Government Licence - Winnipeg.');

  document.title = `${p.full_address || `Roll ${roll}`} · Preliminary Report`;
  $('rp-title').textContent = p.full_address || `Roll ${roll}`;
  $('rp-date').textContent = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
  renderMap(subject);

  const [extra, , zoningFc, notices, noticePts, amendments, contam, nbhds, stops, walkshed, census] = await Promise.all([
    settle(fetchSoda(`${ASSESS_ROWS_URL}?${new URLSearchParams({ roll_number: roll, $select: 'street_number,street_name,neighbourhood_area,market_region,assessed_value_1,property_class_1,assessed_value_2,property_class_2,assessment_date' })}`)),
    settle(enrichAssessmentZoning(subjectFc)),
    settle(fetchZoningOverlap(subjectFc)),
    settle(fetchRezoningNotices()),
    settle(fetchRezoningNoticePoints()),
    settle(fetchZoningAmendments()),
    settle(fetchContaminatedSites()),
    settle(fetchNeighbourhoods()),
    settle(fetchTransitStops()),
    settle(fetchFrequentTransitWalkshed()),
    settle(fetch(CENSUS_SUMMARY_URL).then((r) => (r.ok ? r.json() : null))),
  ]);
  const row = Array.isArray(extra) ? extra[0] || {} : (extra?.rows?.[0] || {});
  const nbhd = at && nbhds?.features?.find((f) => booleanPointInPolygon([at.lon, at.lat], f));
  const nbhdName = nbhd?.properties?.name || clean(row.neighbourhood_area);
  $('rp-sub').textContent = `${nbhdName ? `${nbhdName} · ` : ''}Roll ${roll}`;

  section('rp-parcel', 'Parcel', dl([
    ['Civic address', esc(p.full_address || '—')],
    ['Roll number', esc(roll)],
    ['Neighbourhood', esc(nbhdName)],
    ['Market region', esc(clean(row.market_region))],
    ['Property use', esc(p.property_use_code || '')],
    ['Building type', esc(clean(p.building_type))],
    ['Year built', esc(clean(p.year_built))],
    ['Living area (sq ft)', Number(p.total_living_area) ? fmtInt(Number(p.total_living_area)) : null],
    ['Land area (sq ft)', Number(p.assessed_land_area) ? fmtInt(Number(p.assessed_land_area)) : null],
    ['Dwelling units', esc(p.dwelling_units ?? '')],
    ['Centre', at ? `${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}` : null],
    ['City assessment page', assessmentUrl(p) ? `<a href="${esc(assessmentUrl(p))}" target="_blank" rel="noreferrer">Open</a>` : null],
  ]));

  const classes = [[row.property_class_1, row.assessed_value_1], [row.property_class_2, row.assessed_value_2]]
    .filter(([c, v]) => clean(c) && Number(v));
  section('rp-assessment', 'Assessment', dl([
    ['Assessment year', esc(p.current_assessment_year || '')],
    ['Total assessed value', `<strong>${fmtMoney(Number(p.total_assessed_value))}</strong>`],
    ...classes.map(([c, v]) => [`  ${clean(c)}`, fmtMoney(Number(v))]),
    ['Status', esc(clean(p.status_1))],
  ]) + '<p class="rp-note">The City publishes assessed values, not tax amounts. Confirm on the City assessment page.</p><div id="rp-asmt-history"></div>');
  await settle(renderAssessmentHistory($('rp-asmt-history'), { roll, neighbourhood: clean(row.neighbourhood_area), current: Number(p.total_assessed_value), currentYear: p.current_assessment_year, cite }));

  // Zoning
  const descBy = new Map((zoningFc?.features || []).map((f) => [f.properties?.zoning, f.properties?.short_description || f.properties?.long_description]));
  const z = (code, pct) => (code ? `${esc(code)}${descBy.get(code) ? ` ${esc(descBy.get(code))}` : ''}${pct != null && pct < 99.5 ? ` (${Math.round(pct)}%)` : ''}` : '');
  const zText = [z(p.zoning_top1, p.zoning_top1_pct), p.zoning_top2 && (p.zoning_top2_pct ?? 0) >= 1 ? z(p.zoning_top2, p.zoning_top2_pct) : ''].filter(Boolean).join(' · ') || esc(p.zoning || '—');
  const myNotices = (notices || []).filter((n) => n.roll_number === roll);
  const myAmend = amendments?.byRoll?.[roll] || [];
  section('rp-zoning', 'Zoning', dl([
    ['Zoning (By-law 200/2006)', zText],
    ['Amending by-laws on this roll', myAmend.length ? myAmend.map((a) => esc([`By-law ${a.bylaw}`, a.passed, a.subject].filter(Boolean).join(' · '))).join('<br>') : 'None indexed'],
    ['Rezoning notices on this roll', myNotices.length ? myNotices.map((n) => esc(`${n.notice_type} · ${day(n.in_date)}${n.decision ? ` · ${n.decision}` : ''}`)).join('<br>') : 'None'],
  ]) + '<p class="rp-note">Confirm zoning, overlays and any conditional approvals with Planning, Property and Development.</p>');
  cite('Zoning', 'City of Winnipeg Zoning By-law Parcels (dxrp-w6re), Public Notices (gnxp-9hpt) and the DMIS by-law index.');

  // Flood (link only: the City's flood layers are not loaded here)
  const flood = floodToolUrl(p);
  section('rp-flood', 'Flood', `<p>Flood screening is not loaded in this report.${flood ? ` <a href="${esc(flood)}" target="_blank" rel="noreferrer">Check this location in MB Flood Mapping</a>.` : ''} Waterway permits and setbacks are administered by the City under the Waterway By-law.</p>`);

  // Nearby: permits at the address, rezonings, contaminated sites, transit
  const near = [];
  const permits = row.street_number && row.street_name ? await settle(fetchPermitsAtAddress({ number: row.street_number, name: row.street_name })) : [];
  near.push(`<h3>Building permits at this address</h3>${permits?.length
    ? table(['Issued', 'Permit', 'Type', 'Work', 'Status'], permits.slice(0, 10).map((x) => [esc(day(x.issue_date)), esc(x.permit_number), esc([x.permit_group, x.permit_type].filter(Boolean).join(' · ')), esc(x.work_type), esc(x.status)]))
      + (permits.length > 10 ? `<p class="rp-note">${permits.length - 10} older permits not shown.</p>` : '')
    : '<p>None in the open-data permit list.</p>'}`);
  cite('Building permits', 'City of Winnipeg Building Permits (it4w-cpf4).');
  const npts = (noticePts || []).map((n) => {
    const c = n.location?.coordinates || n.point?.coordinates;
    return c ? { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: n } : null;
  }).filter(Boolean);
  const nHits = nearby(npts, at, 1000, 8);
  near.push(`<h3>Open rezoning and subdivision notices within 1 km</h3>${nHits.length
    ? table(['Address', 'Type', 'Date', 'Decision', 'Distance'], nHits.map((h) => [esc(h.properties.address), esc(h.properties.notice_type), esc(day(h.properties.in_date)), esc(h.properties.decision || h.properties.dmis_decision || ''), fmtDistance(h._m)]))
    : '<p>None.</p>'}<p class="rp-note">The City's Public Notices list carries current notices only (${(noticePts || []).length} citywide today). Past amendments are under Zoning above.</p>`);
  if (contam?.features) {
    const hits = nearby(contam.features, at, 1000, 8);
    near.push(`<h3>Contaminated and impacted sites within 1 km</h3>${hits.length
      ? table(['Site', 'Address', 'Group', 'Distance'], hits.map((h) => [esc(h.properties['OPERATION NAME']), esc(h.properties.ADDRESS), esc(h.properties.CSGroup), fmtDistance(h._m)]))
      : '<p>None listed in the provincial registry.</p>'}`);
    cite('Contaminated sites', 'Manitoba Contaminated Sites Registry (live CSV).');
  }
  if (stops?.features) {
    const sHits = nearby(stops.features, at, 400, 5);
    const inWalkshed = at && walkshed?.features?.some((f) => booleanPointInPolygon([at.lon, at.lat], f));
    near.push(`<h3>Transit</h3>${dl([
      ['Frequent-transit walkshed', walkshed ? (inWalkshed ? 'Inside (Zoning By-law Schedule AC Map 2)' : 'Outside') : null],
      ['Stops within 400 m', sHits.length ? sHits.map((s) => esc(`${s.properties.stop_name} (${fmtDistance(s._m)}; routes ${s.properties.routes || '—'})`)).join('<br>') : 'None'],
    ])}`);
    cite('Transit', 'Winnipeg Transit GTFS stops; frequent-transit walkshed from Zoning By-law Schedule AC Map 2.');
  }
  section('rp-nearby', 'Nearby', near.join(''));

  // Census: neighbourhood, its cluster isn't in the feed by name, so compare
  // with the City (CMA) and Manitoba.
  if (!census) {
    section('rp-census', 'Community (census)', '<p class="rp-muted">Census figures could not be loaded.</p>');
  } else {
    const byName = new Map(census.regions.filter((r) => r.level === 'WPG_Nbhd').map((r) => [r.name.toUpperCase(), r.uid]));
    const uid = nbhdName ? byName.get(String(nbhdName).toUpperCase()) : null;
    const { columns } = censusColumns(census, uid ? [uid] : []);
    section('rp-census', 'Community (census)', `${uid ? '' : `<p>No census profile matched the neighbourhood ${esc(nbhdName || '')}; Winnipeg and Manitoba figures follow.</p>`}<table class="rp-table rp-census"><thead><tr><th></th>${columns.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${CENSUS_FIELDS.map(([k, label, fmt]) => `<tr><th>${esc(label)}</th>${columns.map((c) => `<td>${esc(fmt(c[k]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    cite('Census', `${census.source}. Statistics Canada Open Licence.`);
  }

  section('rp-sources', 'Sources and vintage', `<ul>${sources.map((s) => `<li><strong>${esc(s.what)}:</strong> ${esc(s.detail)}</li>`).join('')}</ul>`);
  $('rp-status').hidden = true;
  $('rp-print').disabled = false;
}

function renderMap(subject) {
  const el = $('rp-map');
  if (!el || !subject.geometry) return;
  const map = new maplibregl.Map({
    container: el,
    style: {
      version: 8,
      sources: {
        imagery: { type: 'raster', tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 20, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' },
        parcel: { type: 'geojson', data: subject },
      },
      layers: [
        { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } },
        { id: 'parcel-line', type: 'line', source: 'parcel', paint: { 'line-color': '#ffd400', 'line-width': 3 } },
      ],
    },
    interactive: false,
    attributionControl: { compact: false },
    preserveDrawingBuffer: true,
  });
  const pts = subject.geometry.type === 'Polygon' ? subject.geometry.coordinates.flat() : subject.geometry.coordinates.flat(2);
  const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, maxZoom: 19, duration: 0 });
  let frozen = false;
  const freeze = () => {
    if (frozen) return;
    frozen = true;
    try {
      const img = new Image();
      img.alt = 'Aerial view of the parcel with its boundary outlined';
      img.className = 'rp-map-img';
      img.src = map.getCanvas().toDataURL('image/png');
      const cap = document.createElement('figcaption');
      cap.className = 'rp-note';
      cap.textContent = 'Parcel outline from City of Winnipeg Assessment Parcels (not a survey). Imagery: Esri, Maxar, Earthstar Geographics.';
      el.replaceWith(img);
      img.after(cap);
      map.remove();
    } catch (err) { console.warn('map snapshot failed', err); }
  };
  map.once('idle', freeze);
  window.addEventListener('beforeprint', () => { map.triggerRepaint(); freeze(); }, { once: true });
  cite('Imagery', 'Esri World Imagery (display only).');
}

$('rp-print')?.addEventListener('click', () => window.print());
main().catch((err) => {
  console.error(err);
  $('rp-status').textContent = `The report could not be built: ${err.message}`;
});
