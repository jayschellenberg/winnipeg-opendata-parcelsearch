// The Sales Charts tab's fitted maps (lib/locationMaps.js), off the page's
// thread: a location model over a thousand sales takes about a second, and
// the charts page re-renders several times a second while filters move.
// One message in, one out, tagged with the caller's key so a late answer
// for an old filter state is recognised and dropped by the page.

import { isovalueSurface, locationEffect } from '../lib/locationMaps.js';

self.addEventListener('message', (e) => {
  const { key, kind, sales, opts, controls } = e.data || {};
  let result;
  try {
    if (kind === 'iso') result = isovalueSurface(sales, opts);
    else if (kind === 'locfx') result = locationEffect(sales, controls, opts);
    else result = { ok: false, reason: `Unknown map kind ${kind}.` };
  } catch (err) {
    result = { ok: false, reason: `The surface could not be built: ${err?.message || err}` };
  }
  self.postMessage({ key, result });
});
