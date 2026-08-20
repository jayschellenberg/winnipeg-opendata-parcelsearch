/*
 * Data Status — the topbar 📅 dialog + the staleness banner.
 *
 * Everything here is presentation; the date arithmetic and row assembly
 * live in lib/dataStatus.js (pure, tested) and lib/staleness.js. The
 * dialog is a native <dialog>, opened lazily: nothing is fetched until
 * the first click on #data-status-open, and the live-services block
 * fills in per-service as each metadata endpoint answers, so one dead
 * service reads "unavailable" instead of blocking the rest.
 *
 * PRIVACY: this dialog shows PUBLIC data vintages only. The SABRE sales
 * database is subscriber data — its coverage renders exclusively in the
 * sales panel's own Coverage dialog (salesDbPanel.js), never here, and
 * nothing about it reaches any hosted file.
 */

import {
  dateLabel, datePart, socrataUpdatedDate, extractTailMeta,
  publishedRows, tileAgeDays,
} from './lib/dataStatus.js';
import { stalenessBannerState } from './lib/staleness.js';
import { fetchHistoricalIndex, SOCRATA_SOURCES, HISTORICAL_PIN } from './soda.js';
import { ORTHO_YEARS } from './map.js';

const PMTILES_META_URL = '/parcels-pmtiles-meta.json';

function fetchJson(url) {
  return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

/** Tail of a static file. The Range request keeps it to a couple of KB
 *  on Vercel; the dev server ignores Range and sends the whole file, so
 *  the slice does the same job there. */
function fetchTailMeta(url) {
  return fetch(url, { headers: { Range: 'bytes=-4096' } })
    .then((r) => (r.ok ? r.text() : null))
    .then((t) => (t ? extractTailMeta(t.slice(-4096)) : null))
    .catch(() => null);
}

function cellTd(value, { unknown = '—' } = {}) {
  const td = document.createElement('td');
  if (value == null || value === '') {
    td.textContent = unknown;
    td.classList.add('is-unknown');
  } else {
    td.textContent = String(value);
  }
  return td;
}

function rowOf(cells) {
  const tr = document.createElement('tr');
  for (const c of cells) tr.appendChild(cellTd(c));
  return tr;
}

function renderPublished($tbody, rows) {
  $tbody.textContent = '';
  for (const r of rows) {
    $tbody.appendChild(rowOf([r.label, r.vintage, r.detail, r.next]));
  }
}

function renderHistorical($tbody, histIndex) {
  $tbody.textContent = '';

  const generated = datePart(histIndex?.generated) || null;
  const snaps = Object.keys(histIndex?.snapshots || {}).sort();
  const newest = snaps.at(-1) || null;
  const layers = newest ? Object.keys(histIndex.snapshots[newest]?.layers || {}) : [];
  $tbody.appendChild(rowOf([
    'Historical parcel archive',
    generated ? dateLabel(generated) : null,
    newest
      ? `${snaps.length} snapshot${snaps.length === 1 ? '' : 's'}, newest ${dateLabel(newest)} (${layers.join(', ')})`
      : '',
  ]));

  // The shard pin: an immutable commit SHA in soda.js, bumped by hand on
  // each republish (the console warns when it lags the repo head).
  const sha = String(HISTORICAL_PIN || '').split('@').pop() || '';
  $tbody.appendChild(rowOf([
    'Archive CDN pin',
    sha ? sha.slice(0, 7) : null,
    'commit pinned in soda.js; bumped on each archive republish',
  ]));

  $tbody.appendChild(rowOf([
    'City aerial imagery',
    ORTHO_YEARS?.length ? String(ORTHO_YEARS[0]) : null,
    ORTHO_YEARS?.length ? `orthophoto years: ${[...ORTHO_YEARS].join(', ')}` : '',
  ]));
}

function renderServices($tbody) {
  $tbody.textContent = '';
  for (const src of SOCRATA_SOURCES) {
    const tr = document.createElement('tr');
    tr.appendChild(cellTd(`${src.label} (${src.id})`));
    const when = cellTd('…');
    tr.appendChild(when);
    $tbody.appendChild(tr);
    // Fill in as each service answers — no barrier, no ordering promise.
    fetchJson(`https://data.winnipeg.ca/api/views/${src.id}.json`).then((json) => {
      const date = socrataUpdatedDate(json);
      when.textContent = date ? dateLabel(date) : 'unavailable';
      when.classList.toggle('is-unknown', !date);
    });
  }
}

export function initDataStatusDialog() {
  const $open = document.getElementById('data-status-open');
  const $modal = document.getElementById('data-status-modal');
  if (!$open || !$modal) return;
  const $close = document.getElementById('data-status-close');
  const $published = document.getElementById('data-status-published');
  const $historical = document.getElementById('data-status-historical');
  const $services = document.getElementById('data-status-services');

  let loaded = false;
  async function load() {
    loaded = true;
    renderServices($services);   // rows appear immediately, fill per-service
    const [pmtilesMeta, histIndex, neighbourhoodsMeta, transitMeta] = await Promise.all([
      fetchJson(PMTILES_META_URL),
      fetchHistoricalIndex().catch(() => null),
      fetchTailMeta('/wpg-neighbourhoods.geojson'),
      fetchTailMeta('/transit-routes.geojson'),
    ]);
    renderPublished($published, publishedRows({ pmtilesMeta, neighbourhoodsMeta, transitMeta }));
    renderHistorical($historical, histIndex);
  }

  $open.addEventListener('click', () => {
    if (!loaded) load();   // fire-and-forget; rows fill as fetches land
    $modal.showModal();
  });
  $close?.addEventListener('click', () => $modal.close());
}

/**
 * The staleness banner under the topbar. One tiny same-origin fetch at
 * init (the ~500-byte tile sidecar); the banner stays hidden while the
 * tiles are fresh, which is every day the pipeline is healthy.
 */
export function initStalenessBanner() {
  const $banner = document.getElementById('data-staleness-banner');
  if (!$banner) return;
  fetchJson(PMTILES_META_URL).then((meta) => {
    const age = tileAgeDays(meta?.built);
    const state = stalenessBannerState(age);
    if (!state.show) return;
    $banner.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = state.lead;
    $banner.appendChild(strong);
    $banner.appendChild(document.createTextNode(` ${state.tail}`));
    $banner.classList.add(state.tone);
    $banner.hidden = false;
  });
}
