// "Use my location" — a map button that flies to the phone's GPS fix and
// opens the parcel under it.
//
// MapLibre's GeolocateControl already does the hard part: the button, the
// permission prompt, the blue dot with its accuracy ring, and the fly-to.
// What it does not know is what a parcel is. So once the map has settled
// on the fix, this fires the map's OWN click at that point — the same
// event a finger would raise — and every existing click handler takes it
// from there: a result parcel opens its card on the phone (or its popup
// on desktop), a municipality parcel opens its popup. Nothing about
// parcels is duplicated here.
//
// A fix that lands on no parcel layer (outside the province, zoomed to a
// bare basemap, the parcel layer for that municipality not switched on)
// gets a short popup saying so instead of silence.
//
// Shared byte-for-byte with the Winnipeg portal: which layers count as a
// parcel, and what the miss text says, come from the caller.

import maplibregl from 'maplibre-gl';

export const LOCATE_ZOOM = 17;

/** Pure: which of the rendered hits to open — the first on the earliest
 *  listed layer, so a result parcel beats the municipality fabric. */
export function pickHit(features, hitLayers) {
  for (const layer of hitLayers) {
    const f = (features || []).find((x) => x.layer?.id === layer);
    if (f) return f;
  }
  return null;
}

/**
 * Add the control.
 *   map        the MapLibre map
 *   hitLayers  layer ids that mean "a parcel is here", in priority order
 *   missText   what to say when the fix lands on none of them
 *   position   control corner (default top-right, under the zoom buttons)
 */
export function addLocateControl(map, { hitLayers, missText, position = 'top-right' }) {
  const control = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    fitBoundsOptions: { maxZoom: LOCATE_ZOOM },
    trackUserLocation: false,
    showUserLocation: true,
    showAccuracyCircle: true,
  });
  map.addControl(control, position);

  const missPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '260px' });

  const openParcelAt = (lngLat) => {
    const point = map.project(lngLat);
    const layers = hitLayers.filter((id) => map.getLayer(id));
    const hits = layers.length ? map.queryRenderedFeatures(point, { layers }) : [];
    if (pickHit(hits, hitLayers)) {
      // A real MapMouseEvent, built from a MouseEvent at the fix's screen
      // position, so every click handler sees what a tap gives it: point,
      // lngLat, originalEvent and preventDefault() (the draw tools call
      // it). A plain object would throw in any handler that touches those.
      const rect = map.getContainer().getBoundingClientRect();
      const mouse = new MouseEvent('click', {
        bubbles: true, cancelable: true,
        clientX: rect.left + point.x, clientY: rect.top + point.y,
      });
      const MapMouseEvent = maplibregl.MapMouseEvent;
      map.fire(MapMouseEvent
        ? new MapMouseEvent('click', map, mouse)
        : { type: 'click', lngLat, point, originalEvent: mouse, preventDefault() {} });
      return true;
    }
    if (missText) {
      missPopup.setLngLat(lngLat).setText(missText).addTo(map);
    }
    return false;
  };

  control.on('geolocate', (e) => {
    const lngLat = new maplibregl.LngLat(e.coords.longitude, e.coords.latitude);
    // The control's own fly-to starts right after this event; wait for the
    // map to settle (tiles loaded) so the parcel under the fix is rendered
    // and can be hit-tested. `idle` fires once nothing is in flight.
    map.once('idle', () => openParcelAt(lngLat));
  });
  control.on('error', (e) => {
    const denied = e?.code === 1;
    if (missText) {
      missPopup.setLngLat(map.getCenter())
        .setText(denied
          ? 'Location is blocked for this site. Allow it in the browser settings to use this button.'
          : 'Could not get a location fix. Try again outdoors or with Wi-Fi on.')
        .addTo(map);
    }
  });
  return control;
}
