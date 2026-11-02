/*
 * A PNG of one chart or map card (2026-11-01): 1950 x 1050, the Manitoba
 * site's exhibit size (6.5 x 3.5 in at 300 dpi), with the card's title, its
 * chart or map, its legend and its note -- so a downloaded exhibit carries
 * the same caveats the screen does.
 *
 * Read from the card's own DOM rather than from a spec, so any card the page
 * builds gets a button without its builder knowing: the first <svg> or the
 * map's WebGL canvas (created with preserveDrawingBuffer, or the copy would
 * be blank), the <h2>, the legend items and the .chart-note lines.
 */

const W = 1950;
const H = 1050;
const PAD = 48;
const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function svgImage(svg) {
  const clone = svg.cloneNode(true);
  const vb = (svg.getAttribute('viewBox') || '0 0 620 320').split(/\s+/).map(Number);
  clone.setAttribute('width', String(vb[2]));
  clone.setAttribute('height', String(vb[3]));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.fontFamily = 'Helvetica, Arial, sans-serif';
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ img, w: vb[2], h: vb[3] }); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/** Words wrapped to `maxW` px in the context's current font. */
function wrap(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const t = line ? `${line} ${word}` : word;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = word; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/** Render the card to a PNG Blob. */
export async function cardPngBlob(card) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#151916';
  ctx.font = `600 44px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillText(card.querySelector('h2')?.textContent || '', PAD, PAD);

  // Footer first, so the body knows how much room it has.
  const legend = [...card.querySelectorAll('.map-legend-list li')].map((li) => ({
    color: li.querySelector('.map-legend-swatch')?.style.background || '#999', label: li.textContent,
  }));
  ctx.font = `26px ${FONT}`;
  const notes = [...card.querySelectorAll('.chart-note')].map((n) => n.textContent).filter(Boolean);
  const noteLines = notes.flatMap((n) => wrap(ctx, n, W - 2 * PAD)).slice(0, 5);
  const legendRows = [];
  let row = [];
  let rowW = 0;
  for (const it of legend) {
    const w = 40 + ctx.measureText(it.label).width + 36;
    if (rowW + w > W - 2 * PAD && row.length) { legendRows.push(row); row = []; rowW = 0; }
    row.push(it);
    rowW += w;
  }
  if (row.length) legendRows.push(row);
  const footH = noteLines.length * 34 + legendRows.length * 38 + 20;
  const top = PAD + 70;
  const bodyH = H - top - footH - PAD / 2;

  const svg = card.querySelector('svg');
  const canvas = card.querySelector('.chart-map canvas');
  let src = null;
  let sw = 0;
  let sh = 0;
  if (typeof card.exportCanvas === 'function') {
    src = await card.exportCanvas(); sw = src.width; sh = src.height;
  } else if (canvas) { src = canvas; sw = canvas.width; sh = canvas.height; } else if (svg) {
    const im = await svgImage(svg);
    src = im.img; sw = im.w; sh = im.h;
  }
  if (src) {
    const k = Math.min((W - 2 * PAD) / sw, bodyH / sh);
    ctx.drawImage(src, PAD + ((W - 2 * PAD) - sw * k) / 2, top, sw * k, sh * k);
  }

  let y = H - footH;
  for (const r of legendRows) {
    let x = PAD;
    for (const it of r) {
      ctx.fillStyle = it.color;
      ctx.fillRect(x, y + 4, 26, 26);
      ctx.strokeStyle = '#555';
      ctx.strokeRect(x, y + 4, 26, 26);
      ctx.fillStyle = '#4d5752';
      ctx.fillText(it.label, x + 36, y + 4);
      x += 40 + ctx.measureText(it.label).width + 36;
    }
    y += 38;
  }
  ctx.fillStyle = '#6d7771';
  for (const l of noteLines) { ctx.fillText(l, PAD, y + 10); y += 34; }
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

/** A filename from the card title and today's date. */
export function pngFileName(title) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const slug = String(title || 'chart').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'chart';
  return `${slug}-${day}.png`;
}

/** Add a PNG button to a card's top-right corner. */
export function addPngButton(card) {
  if (card.querySelector(':scope > .chart-png-btn')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chart-png-btn';
  b.textContent = 'PNG';
  b.title = 'Download this card as a PNG (1950 x 1050, 6.5 x 3.5 in at 300 dpi)';
  b.addEventListener('click', async () => {
    try {
      const blob = await cardPngBlob(card);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = pngFileName(card.querySelector('h2')?.textContent);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) {
      console.warn('PNG export failed', err);
      b.textContent = 'Failed';
      setTimeout(() => { b.textContent = 'PNG'; }, 2000);
    }
  });
  card.appendChild(b);
}
