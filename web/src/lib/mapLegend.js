/*
 * Drawing the map's on-screen legends into the Generate Map PNG.
 *
 * Split three ways so the arithmetic is testable without a canvas or a
 * DOM: readMapLegends (DOM -> data), layoutMapLegends (pure boxes and
 * numbers), paintMapLegends (pixels). main.js calls all three; the
 * tests call only the middle one.
 *
 * Legends stack UPWARD from just above the credit pill, in the same
 * bottom-right corner they occupy on screen, and the image keeps its
 * normal dimensions — so a legend sits over the map rather than
 * widening the export and changing the aspect ratio a report expects.
 */

/** Fraction of image height all legend boxes together may occupy. */
export const LEGEND_MAX_HEIGHT_RATIO = 0.62;
/** Fraction of image width one legend box may occupy. */
export const LEGEND_MAX_WIDTH_RATIO = 0.42;

/**
 * Scrape the visible legends out of the map pane.
 *
 * Reads only <li> rows carrying a swatch, which skips the non-legend
 * furniture some panels carry (an opacity slider, an italic footnote)
 * for free. Colours come from getComputedStyle so a swatch styled by
 * class resolves the same as one styled inline.
 *
 * @param {Element} root map pane element
 * @param {(el: Element) => CSSStyleDeclaration} computed
 * @returns {Array<{title: string, items: Array<{color: string|null, label: string}>}>}
 */
export function readMapLegends(root, computed) {
  if (!root) return [];
  return [...root.querySelectorAll('.map-legend')]
    .filter((el) => !el.hidden && el.offsetParent !== null)
    .map((el) => ({
      title: el.querySelector('strong')?.textContent.trim() || '',
      items: [...el.querySelectorAll('li')]
        .map((li) => {
          const sw = li.querySelector('.swatch, .line-swatch');
          return {
            color: sw && computed ? computed(sw).backgroundColor : null,
            label: li.textContent.replace(/\s+/g, ' ').trim(),
          };
        })
        .filter((item) => item.label),
    }))
    .filter((legend) => legend.items.length > 0);
}

/**
 * Place the legend boxes, bottom-up, inside the height budget.
 *
 * A box that would overflow keeps as many rows as fit and collapses the
 * rest into a "+N more" line, because a silently truncated legend
 * misrepresents the map. A box with room for fewer than two rows is
 * dropped outright rather than emitting a title with nothing under it.
 *
 * @param {Array} legends from readMapLegends
 * @param {object} opts
 * @param {number} opts.width    image width in px
 * @param {number} opts.height   image height in px
 * @param {number} opts.bottomY  y to stack upward from
 * @param {number} opts.fontSize base font size in px
 * @param {(text: string, bold: boolean) => number} opts.measureText
 * @returns {Array<{x, y, w, h, title, rows, more}>} boxes, painting order
 */
export function layoutMapLegends(legends, {
  width, height, bottomY, fontSize, measureText,
}) {
  const pad = Math.round(fontSize * 0.6);
  const lineH = Math.round(fontSize * 1.35);
  const swatch = Math.round(fontSize * 0.9);
  const gap = Math.round(fontSize * 0.5);
  const maxBoxW = Math.floor(width * LEGEND_MAX_WIDTH_RATIO);
  const budgetTop = Math.max(0, bottomY - Math.floor(height * LEGEND_MAX_HEIGHT_RATIO));

  const boxes = [];
  let cursor = bottomY;
  for (const legend of legends) {
    const available = cursor - budgetTop;
    // title line + at least two rows + padding, or it isn't worth drawing
    const minH = pad * 2 + lineH * 3;
    if (available < minH) break;

    const maxRows = Math.floor((available - pad * 2 - lineH) / lineH);
    const fits = Math.min(legend.items.length, maxRows);
    const hidden = legend.items.length - fits;
    // The "+N more" line costs a row of its own, so it displaces one
    // item — otherwise the box would overflow its own budget.
    const rows = hidden > 0 ? legend.items.slice(0, Math.max(0, fits - 1)) : legend.items;
    const more = hidden > 0 ? legend.items.length - rows.length : 0;
    if (rows.length < 2) break;

    let textW = measureText(legend.title, true);
    for (const r of rows) textW = Math.max(textW, measureText(r.label, false) + swatch + gap);
    if (more > 0) textW = Math.max(textW, measureText(`+${more} more`, false));
    const w = Math.min(maxBoxW, Math.ceil(textW + pad * 2));
    const h = pad * 2 + lineH * (rows.length + 1 + (more > 0 ? 1 : 0));
    const y = cursor - h;
    boxes.push({
      x: width - w - 6, y, w, h,
      title: legend.title, rows, more,
      pad, lineH, swatch, gap,
    });
    cursor = y - 6;
  }
  return boxes;
}

/**
 * Paint laid-out boxes onto a 2D context, matching the credit pill's
 * white-panel styling so the two read as one annotation layer.
 */
export function paintMapLegends(ctx, boxes, fontSize) {
  for (const box of boxes) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);

    let y = box.y + box.pad + Math.round(box.lineH / 2);
    ctx.fillStyle = '#1a1a1a';
    ctx.textBaseline = 'middle';
    if (box.title) {
      ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
      ctx.fillText(box.title, box.x + box.pad, y);
    }
    y += box.lineH;

    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    for (const row of box.rows) {
      if (row.color) {
        ctx.fillStyle = row.color;
        ctx.fillRect(box.x + box.pad, y - Math.round(box.swatch / 2), box.swatch, box.swatch);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.strokeRect(box.x + box.pad + 0.5, y - Math.round(box.swatch / 2) + 0.5, box.swatch - 1, box.swatch - 1);
      }
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(row.label, box.x + box.pad + box.swatch + box.gap, y);
      y += box.lineH;
    }
    if (box.more > 0) {
      ctx.fillStyle = '#6d7771';
      ctx.fillText(`+${box.more} more`, box.x + box.pad, y);
    }
  }
}
