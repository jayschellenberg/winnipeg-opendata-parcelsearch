// Map "furniture" for captured exhibits: a scale bar and a north arrow,
// drawn onto the 1950 x 1050 Capture Map image (and every map in the
// Exhibit Pack). Report exhibits are expected to carry both, and drawing
// them from the map's own geometry beats pasting a generic arrow on in
// Word: the bar is the real ground distance at the capture's zoom and the
// arrow follows the map's rotation.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app, like locationMapPanel.js. Pure canvas drawing plus pure
// maths — no MapLibre, no DOM lookups — so the numbers can be unit-tested.

const EARTH_RADIUS_M = 6371008.8;
const M_PER_FT = 0.3048;

/** Great-circle distance in metres between two [lng, lat] points. */
export function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The largest "round" length (1, 2 or 5 x 10^n) that is no longer than
 * `maxValue`. 0 when maxValue is not a positive number.
 */
export function niceLength(maxValue) {
  if (!(maxValue > 0) || !Number.isFinite(maxValue)) return 0;
  const pow = 10 ** Math.floor(Math.log10(maxValue));
  for (const step of [5, 2, 1]) {
    if (step * pow <= maxValue) return step * pow;
  }
  return pow;
}

/**
 * The two scale-bar rows for a given ground resolution: metric on top,
 * imperial below. Each row is the roundest length that fits in
 * `maxWidthPx` image pixels, with its label and drawn width.
 *
 * Metric switches to km at 1000 m; imperial to miles at 1 mile (5280 ft).
 * Returns null when metersPerPx is unusable (a pitched map, a NaN from a
 * degenerate unproject) — callers then draw no bar rather than a wrong one.
 */
export function scaleBarRows(metersPerPx, maxWidthPx) {
  if (!(metersPerPx > 0) || !Number.isFinite(metersPerPx) || !(maxWidthPx > 0)) return null;
  const maxM = metersPerPx * maxWidthPx;
  const m = niceLength(maxM);
  const metric = m >= 1000
    ? { label: `${m / 1000} km`, px: m / metersPerPx }
    : { label: `${m} m`, px: m / metersPerPx };
  const maxFt = maxM / M_PER_FT;
  let imperial;
  if (maxFt >= 5280) {
    const mi = niceLength(maxFt / 5280);
    imperial = { label: `${mi} mi`, px: (mi * 5280 * M_PER_FT) / metersPerPx };
  } else {
    const ft = niceLength(maxFt);
    imperial = { label: `${ft.toLocaleString('en-CA')} ft`, px: (ft * M_PER_FT) / metersPerPx };
  }
  if (!(metric.px > 0) || !(imperial.px > 0)) return null;
  return { metric, imperial };
}

/**
 * Draw the scale bar in a white pill, its bottom-left corner at (x, y).
 * `font` is the base font size in image pixels (the credit's size), so the
 * bar keeps its proportion to the rest of the exhibit. Returns the pill's
 * box { x, y, w, h } or null when nothing was drawn.
 */
export function drawScaleBar(ctx, { x, y, metersPerPx, maxWidthPx, font }) {
  const rows = scaleBarRows(metersPerPx, maxWidthPx);
  if (!rows) return null;
  const family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const fs = Math.max(11, Math.round(font));
  const pad = Math.round(fs * 0.6);
  const tick = Math.round(fs * 0.45);
  const lw = Math.max(1.5, fs / 9);
  ctx.save();
  ctx.font = `600 ${fs}px ${family}`;
  const barW = Math.max(rows.metric.px, rows.imperial.px);
  const labelW = Math.max(ctx.measureText(rows.metric.label).width, ctx.measureText(rows.imperial.label).width);
  const w = Math.ceil(pad + barW + pad * 0.8 + labelW + pad);
  const h = Math.ceil(pad + fs + tick * 2 + fs + pad);
  const x0 = Math.round(x);
  const y0 = Math.round(y - h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);

  const bx = x0 + pad;
  const midY = y0 + pad + fs + tick;   // the shared baseline both bars hang off
  ctx.strokeStyle = '#1a1a1a';
  ctx.fillStyle = '#1a1a1a';
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  // Baseline spans the longer of the two rows.
  ctx.beginPath();
  ctx.moveTo(bx, midY);
  ctx.lineTo(bx + barW, midY);
  ctx.stroke();
  // Metric: ticks UP from the baseline, label above-right.
  ctx.beginPath();
  ctx.moveTo(bx, midY); ctx.lineTo(bx, midY - tick);
  ctx.moveTo(bx + rows.metric.px, midY); ctx.lineTo(bx + rows.metric.px, midY - tick);
  ctx.stroke();
  // Imperial: ticks DOWN from the baseline.
  ctx.beginPath();
  ctx.moveTo(bx, midY); ctx.lineTo(bx, midY + tick);
  ctx.moveTo(bx + rows.imperial.px, midY); ctx.lineTo(bx + rows.imperial.px, midY + tick);
  ctx.stroke();
  ctx.textBaseline = 'middle';
  const lx = bx + barW + pad * 0.8;
  ctx.fillText(rows.metric.label, lx, midY - tick - fs * 0.15);
  ctx.fillText(rows.imperial.label, lx, midY + tick + fs * 0.15);
  ctx.restore();
  return { x: x0, y: y0, w, h };
}

/**
 * Draw a north arrow centred at (cx, cy), `size` image pixels tall, on a
 * white disc. `bearing` is the map's bearing in degrees (MapLibre's
 * getBearing(): the compass direction the top of the map faces), so the
 * arrow is rotated by -bearing and always points at true north.
 */
export function drawNorthArrow(ctx, { cx, cy, size, bearing = 0 }) {
  const r = size / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.translate(cx, cy);
  ctx.rotate((-bearing * Math.PI) / 180);
  // Layout inside the disc (y grows downward): the "N" in the top third,
  // the arrow below it from just under the letter to near the bottom, so
  // the two never touch.
  const nY = -r * 0.5;
  const tipY = -r * 0.22;
  const baseY = r * 0.72;
  const notchY = r * 0.46;
  const half = r * 0.3;
  ctx.font = `700 ${Math.round(size * 0.26)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a1a1a';
  ctx.fillText('N', 0, nY);
  // Two-tone arrow: the right half solid, the left half outlined.
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, size / 40);
  ctx.strokeStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(half, baseY);
  ctx.lineTo(0, notchY);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(-half, baseY);
  ctx.lineTo(0, notchY);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * Today as YYYY-MM-DD in the viewer's LOCAL time zone. Not toISOString(),
 * which is UTC: in Manitoba that names an evening's exhibits after
 * tomorrow.
 */
export function localDateStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * [[west, south], [east, north]] around a bbox ([minX, minY, maxX, maxY]),
 * grown so it is at least `minWidthM` metres across and padded by `padFrac`
 * of its size on every side. Used to frame the Exhibit Pack views: a lone
 * small lot still gets enough context, a big result set keeps a margin.
 */
export function framedBounds([minX, minY, maxX, maxY], { padFrac = 0.15, minWidthM = 0 } = {}) {
  const midLat = (minY + maxY) / 2;
  const midLng = (minX + maxX) / 2;
  const mPerDegLng = haversineMeters([0, midLat], [1, midLat]);
  const mPerDegLat = haversineMeters([0, midLat - 0.5], [0, midLat + 0.5]);
  let halfW = Math.max((maxX - minX) / 2, (minWidthM / 2) / mPerDegLng);
  let halfH = Math.max((maxY - minY) / 2, ((minWidthM * 1050) / 1950 / 2) / mPerDegLat);
  halfW *= 1 + padFrac;
  halfH *= 1 + padFrac;
  return [[midLng - halfW, midLat - halfH], [midLng + halfW, midLat + halfH]];
}
