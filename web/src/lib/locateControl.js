// "Use my location" — a map button for finding an address near you.
//
// The phone use case (Jason, 2026-09-19) is not "which parcel am I on"
// but "show me the parcels around me with their civic addresses, so I
// can find the one I am looking for". So the button does three things
// and opens nothing: it flies to the GPS fix at a zoom where civic
// labels draw, it keeps following you as you walk (MapLibre's tracking
// mode, until you pan the map yourself), and it hands the fix to the
// app once — onLocated(lngLat) — so the app can switch on its parcel
// fabric for that area and get its sheet out of the way. Which layer
// that is, and how it is scoped, is the app's business: Manitoba loads
// parcels per municipality, Winnipeg has one citywide archive.
//
// MapLibre's GeolocateControl already provides the button, the
// permission prompt, the blue dot with its accuracy ring, the fly-to and
// the tracking. This module only adds the one-shot hand-off and plain
// words when a fix cannot be had.
//
// Shared byte-for-byte with the Winnipeg portal.

import maplibregl from 'maplibre-gl';

/** Zoom to land on: civic labels draw from 16 (Winnipeg) / 16.5 (Manitoba). */
export const LOCATE_ZOOM = 17;

/**
 * Pure: the one-shot latch. Tracking mode reports a fix every few
 * seconds; the app should hear only the first after each press of the
 * button, or it would keep re-running its "switch the fabric on" work
 * while the user walks. Returns the next latch state and whether this
 * fix is the one to hand over.
 */
export function takeFix(latch) {
  if (latch.armed) return { latch: { armed: false }, handle: true };
  return { latch, handle: false };
}

/**
 * Add the control.
 *   map          the MapLibre map
 *   onLocated    (lngLat) => void — called once per button press, after
 *                the map has settled on the fix
 *   position     control corner (default top-right, under the zoom buttons)
 */
export function addLocateControl(map, { onLocated, position = 'top-right' } = {}) {
  const control = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    fitBoundsOptions: { maxZoom: LOCATE_ZOOM },
    trackUserLocation: true,
    showUserLocation: true,
    showAccuracyCircle: true,
  });
  map.addControl(control, position);

  const notice = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '260px' });
  let latch = { armed: false };

  // Each press of the button starts (or restarts) tracking; arm the
  // latch so the next fix is handed over exactly once.
  control.on('trackuserlocationstart', () => { latch = { armed: true }; });
  control.on('geolocate', (e) => {
    const next = takeFix(latch);
    latch = next.latch;
    if (!next.handle || typeof onLocated !== 'function') return;
    const lngLat = new maplibregl.LngLat(e.coords.longitude, e.coords.latitude);
    // The control's own fly-to starts right after this event; wait for
    // the map to settle so the app's work lands on the right view.
    map.once('idle', () => onLocated(lngLat));
  });
  control.on('error', (e) => {
    latch = { armed: false };
    const denied = e?.code === 1;
    notice.setLngLat(map.getCenter())
      .setText(denied
        ? 'Location is blocked for this site. Allow it in the browser settings to use this button.'
        : 'Could not get a location fix. Try again outdoors or with Wi-Fi on.')
      .addTo(map);
  });
  return control;
}
