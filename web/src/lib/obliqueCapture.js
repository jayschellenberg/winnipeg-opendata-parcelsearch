/**
 * The City of Winnipeg's 45-degree air photo viewer (EagleView imagery under
 * the City's licence): the link to it, and a way to get what it shows into
 * an Addenda Pack.
 *
 * The viewer is another site's page, so this app can never read its pixels.
 * The one route the browser allows is the Screen Capture API: the user picks
 * the viewer in the browser's own share prompt and the app takes ONE frame
 * of it. Nothing here runs unattended, and nothing fetches imagery directly.
 *
 * Kept free of main.js / maplibre so the pure parts test under plain Node;
 * grabDisplayFrame takes its browser objects as arguments for the same reason.
 */

const VIEWER = 'https://legacy.winnipeg.ca/pictometry/ipa.aspx';

/**
 * The viewer, opened on a point. The page reads its starting view from these
 * five parameters (read off its own source, 2026-11-27); date and rotation
 * are picked inside the viewer.
 */
export function obliqueViewerUrl(lat, lng) {
  return `${VIEWER}?lat=${Number(lat).toFixed(6)}&lon=${Number(lng).toFixed(6)}`
    + '&ex_level=20&ex_type=Ob&ex_orientation=N';
}

// 13:7, the shape of every other map in the pack (1950 x 1050), so a capture
// of an unresized viewer window drops into a report beside them.
export const VIEWER_WINDOW = { width: 1300, height: 700 };

/**
 * window.open features for the viewer.
 *
 * noopener is load-bearing, not habit: the City page calls
 * window.opener.PictometryReady() when it has an opener, which throws across
 * origins and stops it before it draws the red centre cross. `popup` makes it
 * its own window, which keeps it painting while the app is in front.
 */
export function viewerWindowFeatures({ width, height } = VIEWER_WINDOW) {
  return `popup,noopener,noreferrer,width=${width},height=${height}`;
}

/**
 * getDisplayMedia options: browser tabs only, this app's own tab left out.
 * A tab capture is the page alone; a window or screen capture would carry
 * the browser frame and whatever else is on the desktop into the report.
 */
export function displayMediaOptions(controller) {
  return {
    video: { displaySurface: 'browser', width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 5 } },
    audio: false,
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'exclude',
    surfaceSwitching: 'exclude',
    ...(controller ? { controller } : {}),
  };
}

export class CaptureCancelled extends Error {
  constructor() { super('Capture cancelled'); this.name = 'CaptureCancelled'; }
}

/** Plain words for whatever getDisplayMedia or the frame grab threw. */
export function captureErrorMessage(err) {
  if (err instanceof CaptureCancelled || err?.name === 'NotAllowedError' || err?.name === 'AbortError') return '';
  if (err?.name === 'NotSupportedError' || err?.name === 'TypeError') {
    return 'This browser cannot capture another tab. Use Chrome or Edge on a computer.';
  }
  return err?.message || String(err);
}

/**
 * Ask the user to pick a tab and return one frame of it on a canvas, with
 * the kind of surface they picked ('browser', 'window' or 'monitor').
 * The stream is stopped before this returns, whatever happens.
 */
export async function grabDisplayFrame({
  mediaDevices = globalThis.navigator?.mediaDevices,
  doc = globalThis.document,
  Controller = globalThis.CaptureController,
  timeoutMs = 6000,
} = {}) {
  if (!mediaDevices?.getDisplayMedia) {
    const err = new Error('no getDisplayMedia');
    err.name = 'NotSupportedError';
    throw err;
  }
  const controller = typeof Controller === 'function' ? new Controller() : null;
  const stream = await mediaDevices.getDisplayMedia(displayMediaOptions(controller));
  // Chrome's default is to bring the shared tab forward, which would take the
  // user away from the dialog showing them the result. Must be called in the
  // same task the promise settled in; it throws on a screen capture.
  try { controller?.setFocusBehavior?.('no-focus-change'); } catch { /* not a tab */ }
  const tracks = stream.getVideoTracks();
  try {
    const surface = tracks[0]?.getSettings?.().displaySurface || '';
    const video = doc.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await withTimeout(new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('The capture could not be read.')), { once: true });
      Promise.resolve(video.play()).catch(reject);
    }), timeoutMs);
    // One more painted frame: the first can be the stream's blank opener.
    await withTimeout(new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => resolve());
      else setTimeout(resolve, 250);
    }), 1500).catch(() => {});
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('The capture came back empty.');
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);
    video.srcObject = null;
    // The City page is wider and taller than its window, so the tab comes
    // with scroll bars down the right and along the bottom. Cut them off.
    let inset = { left: 0, top: 0, right: 0, bottom: 0 };
    try {
      if (typeof ctx.getImageData === 'function') {
        inset = flatEdgeInsets(ctx.getImageData(0, 0, width, height).data, width, height);
      }
    } catch { /* unreadable canvas: keep the whole frame */ }
    const w = width - inset.left - inset.right;
    const h = height - inset.top - inset.bottom;
    if (w === width && h === height) return { canvas, surface, width, height, trimmed: false };
    const cut = doc.createElement('canvas');
    cut.width = w;
    cut.height = h;
    cut.getContext('2d').drawImage(canvas, inset.left, inset.top, w, h, 0, 0, w, h);
    return { canvas: cut, surface, width: w, height: h, trimmed: true };
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

/**
 * How many pixels to cut off each side of a captured frame to lose scroll
 * bars and window borders. `data` is RGBA, row by row (ImageData.data).
 *
 * A scroll bar is drawn in two or three flat colours (track, thumb, arrows);
 * a line of air photo never is. So a line of pixels along an edge counts as
 * furniture when 60% of it falls in its three commonest colours (measured
 * on a real capture: bar lines score 0.7 to 1.0, the softened edge of the
 * thumb lowest; photo lines 0.1 to 0.3), and each
 * side is trimmed inward until the first line that does not. A side that is
 * still flat at the cap (4% of the frame) is something else, a blank frame
 * say, and is left alone.
 */
export function flatEdgeInsets(data, width, height) {
  const none = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!data || width < 50 || height < 50 || data.length < width * height * 4) return none;
  const cap = Math.max(24, Math.round(Math.min(width, height) * 0.04));

  // Is the run of `n` pixels starting at (x, y) and stepping (dx, dy) flat?
  const flat = (x, y, dx, dy, n) => {
    const counts = new Map();
    for (let i = 0; i < n; i += 1) {
      const p = ((y + i * dy) * width + (x + i * dx)) * 4;
      const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const top3 = [...counts.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    return top3 >= n * 0.6;
  };
  // Count flat lines inward from an edge; 0 if they run to the cap.
  const depth = (isFlat) => {
    let d = 0;
    while (d <= cap && isFlat(d)) d += 1;
    return d > cap ? 0 : d;
  };

  // Columns first, then rows measured between them, so the square where the
  // two scroll bars meet does not count against the bottom one.
  const right = depth((d) => flat(width - 1 - d, 0, 0, 1, height));
  const left = depth((d) => flat(d, 0, 0, 1, height));
  const span = width - left - right;
  const bottom = depth((d) => flat(left, height - 1 - d, 1, 0, span));
  const top = depth((d) => flat(left, d, 1, 0, span));
  return { left, top, right, bottom };
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      'No picture arrived. Keep the viewer window open and not minimised, then capture again.')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A caution to show beside a capture that was not a single tab. */
export function surfaceWarning(surface) {
  if (!surface || surface === 'browser') return '';
  return surface === 'window'
    ? 'A whole window was captured, so the browser frame is in the picture. Pick the viewer under "Chrome Tab" for the photo alone.'
    : 'A whole screen was captured. Pick the viewer under "Chrome Tab" for the photo alone.';
}

// How far a pack's subject may sit from the point a photo was taken for and
// still claim it. Matches the Addenda Pack's own group span.
export const HELD_MATCH_M = 500;

/**
 * The held photos that belong to a subject at `centre` ([lng, lat]): the
 * ones whose viewer was opened within `maxM` of it. A photo taken for last
 * week's property must not ride into this week's pack.
 */
export function heldForSubject(held, centre, distanceM, maxM = HELD_MATCH_M) {
  if (!Array.isArray(centre) || !centre.every(Number.isFinite)) return [];
  return (held || []).filter((h) => Array.isArray(h?.centre) && distanceM(h.centre, centre) <= maxM);
}

/** File name inside the pack; numbered only when there is more than one. */
export function obliqueFileBase(index, count) {
  return count > 1 ? `eagleview-45-air-photo-${index + 1}.png` : 'eagleview-45-air-photo.png';
}

/** The README line for a held photo. */
export function obliqueListingNote(h) {
  const when = h?.capturedAt ? `, captured ${h.capturedAt}` : '';
  return `Eagleview 45-degree air photo of ${h?.label || 'the subject'}, from the City of Winnipeg viewer${when}`
    + ` (${h?.width} x ${h?.height} px)`;
}

/** README lines, added once when a pack carries a held photo. */
export const OBLIQUE_CREDIT = [
  "45-degree air photos: imagery (c) Eagleview, shown in the City of Winnipeg viewer under the City's licence.",
  "Check the City's terms before reproducing one in a report.",
];
