/*
 * Convert each `<span class="tip">` inside a `.field` into an
 * info-icon affordance: a small "i" button that, on hover OR
 * click, reveals the existing tip text as a popover. The original
 * `.tip` markup is preserved (it becomes the popover body), so the
 * existing per-field micro-copy stays verbatim and no caller needs
 * to rewrite their tip strings.
 *
 * UX:
 *   - Hover on the icon -> popover shows
 *   - Click on the icon -> popover pins (stays open until next
 *     click, escape, or outside click). Click again unpins.
 *   - Touch tap = same as click (mobile-friendly).
 *   - Keyboard focus on the icon -> popover shows; blur hides
 *     unless pinned.
 *
 * Idempotent — re-running on an already-processed field is a
 * no-op. Skips fields whose `.tip` is empty or which already
 * contain an info-icon.
 */

function ensureClickAwayHandler() {
  if (document.body.dataset.infoIconClickAway === '1') return;
  document.body.dataset.infoIconClickAway = '1';
  document.addEventListener('click', (e) => {
    // Unpin any pinned popovers outside the clicked field.
    for (const f of document.querySelectorAll('.field.popover-pinned')) {
      if (!f.contains(e.target)) f.classList.remove('popover-pinned');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const f of document.querySelectorAll('.field.popover-pinned')) {
        f.classList.remove('popover-pinned');
      }
    }
  });
}

function wireField(field) {
  if (!field || field.dataset.infoIconWired === '1') return;
  const tip = field.querySelector(':scope > .tip');
  if (!tip || !tip.textContent.trim()) return;
  // Don't add an icon to chip-input fields' inner text input —
  // those are not standalone form fields. The chip-input wrapper
  // can be wired separately by the caller.
  field.dataset.infoIconWired = '1';

  // Native title attribute on the icon doubles as the OS-level
  // tooltip in case the JS popover is blocked. Keep it short by
  // using the raw text content (no HTML).
  const titleText = tip.textContent.trim();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'info-icon';
  btn.setAttribute('aria-label', `More info: ${titleText.slice(0, 80)}`);
  btn.setAttribute('title', titleText);
  // Skip the icon when tabbing through form fields — appraisers
  // tab from input to input and don't want to land on every
  // helper icon. Click + hover still open the popover.
  btn.tabIndex = -1;
  // Inline SVG "i" — sharper than a Unicode character and styles
  // cleanly with currentColor. 12 × 12 viewport.
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<rect x="7.25" y="6.75" width="1.5" height="5" fill="currentColor"/>' +
    '<circle cx="8" cy="4.5" r="0.95" fill="currentColor"/>' +
    '</svg>';

  // Insert the icon right before the tip element so the popover
  // anchors against the icon's right edge.
  tip.parentNode.insertBefore(btn, tip);

  // Mark the field so CSS can use it as a popover-positioning hook.
  field.classList.add('has-info-icon');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    field.classList.toggle('popover-pinned');
  });
  btn.addEventListener('mouseenter', () => field.classList.add('popover-hover'));
  btn.addEventListener('mouseleave', () => field.classList.remove('popover-hover'));
  btn.addEventListener('focus', () => field.classList.add('popover-hover'));
  btn.addEventListener('blur', () => field.classList.remove('popover-hover'));

  // Prevent the popover from closing when the user mouses over it
  // (e.g. to read a long sentence).
  tip.addEventListener('mouseenter', () => field.classList.add('popover-hover'));
  tip.addEventListener('mouseleave', () => field.classList.remove('popover-hover'));
}

/**
 * Wire every `.field` under `root` (default: document). Idempotent;
 * safe to call multiple times if new fields appear via JS.
 */
export function initInfoIcons(root = document) {
  ensureClickAwayHandler();
  for (const f of root.querySelectorAll('.field')) wireField(f);
}
