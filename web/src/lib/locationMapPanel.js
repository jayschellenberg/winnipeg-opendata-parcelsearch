// The location-map output panel: hint line, controls (callout text, side,
// base map when there is a choice), Copy image / Download PNG, and the
// rendered image. Drawing is lib/locationMap.js; this is only the DOM.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app, like phoneMode.js. Each app passes the base maps it
// offers, in order of preference.
//
// PNG, not the JPEG the map captures use: these are flat colour and fine
// text, where JPEG rings.

import { BASE_MAPS, DIRECTIONS, locateOnMap, renderLocationMap } from './locationMap.js';

const DIRECTION_NAMES = {
  auto: 'Auto', ne: 'Up-right', e: 'Right', se: 'Down-right', s: 'Below',
  sw: 'Down-left', w: 'Left', nw: 'Up-left', n: 'Above',
};

/**
 * Fill `container` with the location-map panel for `subject`
 * ({ lng, lat, note }) and render the first image.
 *
 *   maps      base-map ids this app offers, preferred first
 *   state     { label, direction, base } — the last choices, reused
 *   onState   called with the new state whenever a choice changes
 *   download  (blob, filename) => void — the app's own download helper
 *
 * Returns false (after writing a one-line explanation into `container`)
 * when the subject is on none of the maps.
 */
export async function showLocationMapPanel({ container, subject, maps, state, onState, download }) {
  container.innerHTML = '';
  const offered = maps
    .map((id) => BASE_MAPS[id])
    .filter((m) => m && locateOnMap(m, subject.lng, subject.lat));
  if (offered.length === 0) {
    const p = document.createElement('p');
    p.className = 'static-map-hint';
    p.textContent = 'That property is outside the area the location map covers.';
    container.appendChild(p);
    return false;
  }

  const hint = document.createElement('p');
  hint.className = 'static-map-hint';

  const controls = document.createElement('div');
  controls.className = 'location-map-controls';

  const baseSelect = document.createElement('select');
  baseSelect.setAttribute('aria-label', 'Base map');
  baseSelect.title = 'Which map to mark the property on';
  for (const m of offered) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.label} map`;
    baseSelect.appendChild(opt);
  }
  baseSelect.value = offered.some((m) => m.id === state.base) ? state.base : offered[0].id;
  baseSelect.hidden = offered.length < 2;

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = state.label || 'SUBJECT';
  labelInput.maxLength = 24;
  labelInput.setAttribute('aria-label', 'Callout text');
  labelInput.title = 'Callout text';

  const dirSelect = document.createElement('select');
  dirSelect.setAttribute('aria-label', 'Callout position');
  for (const key of ['auto', ...Object.keys(DIRECTIONS)]) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = DIRECTION_NAMES[key] || key;
    dirSelect.appendChild(opt);
  }
  dirSelect.value = state.direction in DIRECTIONS ? state.direction : 'auto';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'location-map-copy';
  copyBtn.textContent = 'Copy image';
  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.textContent = 'Download PNG';
  controls.append(baseSelect, labelInput, dirSelect, copyBtn, dlBtn);

  const img = document.createElement('img');
  img.className = 'location-map-img';
  container.append(hint, controls, img);

  let blob = null;
  let renderSeq = 0;
  const render = async () => {
    const seq = ++renderSeq;
    const map = BASE_MAPS[baseSelect.value];
    onState({ label: labelInput.value, direction: dirSelect.value, base: map.id });
    // Downtown on the Winnipeg map draws one box between the circles with
    // two arrows; the side choice does not apply there.
    const twin = !!locateOnMap(map, subject.lng, subject.lat)?.inset;
    dirSelect.disabled = twin;
    dirSelect.title = twin
      ? 'Downtown: the box sits between the downtown circle and the inset, with an arrow to each'
      : 'Which side of the property the callout sits on';
    hint.textContent = `${map.label} location map — arrow${twin ? 's point' : ' points'} at ${subject.note}`
      + `${twin ? ' (main map and downtown inset)' : ''}. Copy, or right-click the image:`;
    img.alt = `${map.label} location map with the subject marked`;
    const canvas = await renderLocationMap({
      map,
      lng: subject.lng,
      lat: subject.lat,
      label: labelInput.value,
      direction: dirSelect.value,
    });
    if (!canvas) return;
    const b = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (seq !== renderSeq || !b) return;
    blob = b;
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(b);
  };
  const showError = (err) => {
    console.error('location map render failed', err);
    hint.textContent = 'Location map failed to render — check the browser console.';
  };
  labelInput.addEventListener('input', () => { render().catch(showError); });
  dirSelect.addEventListener('change', () => { render().catch(showError); });
  baseSelect.addEventListener('change', () => { render().catch(showError); });
  copyBtn.addEventListener('click', async () => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copyBtn.textContent = 'Copied!';
    } catch (err) {
      console.warn('location map copy failed', err);
      copyBtn.textContent = 'Copy blocked — right-click the image';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy image'; }, 2000);
  });
  dlBtn.addEventListener('click', () => {
    if (blob) download(blob, `${baseSelect.value}-location-map.png`);
  });

  try {
    await render();
  } catch (err) {
    showError(err);
  }
  return true;
}
