/*
 * Sales-tab multi-select filter — the button + checkbox popover shared
 * by "Filter by PUCS" and "Filter by class".
 *
 * Selection is tri-state, and the distinction matters:
 *
 *   null       no filter — every value passes. Also what an all-ticked
 *              list collapses back to, so "everything selected" and
 *              "no filter" are the same state rather than two states
 *              that can disagree.
 *   Set(n>0)   only those values pass.
 *   Set()      nothing passes. A deliberate "show nothing" the user
 *              reached by clicking None; the caller is expected to say
 *              so rather than render an unexplained empty grid.
 *
 * The pure half (reconcileSelection / selectionLabel / passesSelection)
 * is exported separately from the DOM controller so the state rules can
 * be unit tested without a browser.
 */

/**
 * Fold a selection against the option list currently on offer.
 *
 * Drops values that no longer exist — a fresh CSV brings a different
 * set of codes, and a stale selection would otherwise filter against
 * values nothing can match. Collapses an all-ticked selection back to
 * null so the "no filter" state has one representation.
 */
export function reconcileSelection(selected, options) {
  if (selected == null) return null;
  const valid = new Set(options);
  const next = new Set([...selected].filter((v) => valid.has(v)));
  if (options.length > 0 && next.size === options.length) return null;
  return next;
}

/**
 * The closed control's one-line summary, matching the Manitoba app:
 * "Any PUCS" when nothing is filtering, the value itself when exactly
 * one is ticked, "3 of 7" beyond that, and "None" for the deliberate
 * show-nothing state.
 *
 * Short on purpose. The PUCS and class pickers share one row at half
 * width each, so the old "Filter by PUCS · all 7" form ellipsised to
 * "Filter by PU…" and the control stopped saying anything. `noun` is
 * the bare word ("PUCS", "class"), not a sentence.
 */
export function selectionLabel(noun, selected, total) {
  if (selected == null) return `Any ${noun}`;
  if (selected.size === 0) return 'None';
  if (selected.size === 1) return [...selected][0];
  return `${selected.size} of ${total}`;
}

/** Membership test matching the tri-state above. */
export function passesSelection(selected, value) {
  return selected == null || selected.has(value);
}

/**
 * Wire a button + popover pair into a working multi-select.
 *
 * @param {Object} opts
 * @param {string} opts.btnId      id of the trigger button
 * @param {string} opts.popoverId  id of the popover container
 * @param {string} opts.label      button text prefix, e.g. 'Filter by PUCS'
 * @param {() => void} opts.onChange  called after any selection change
 *
 * @returns {{
 *   setOptions: (counts: Map<string, number>) => void,
 *   getSelected: () => (Set<string>|null),
 *   reset: () => void,
 *   isEmptySelection: () => boolean,
 * }}
 * setOptions rebuilds the list from a value → count map (pass an empty
 * map to disable the control). getSelected returns the tri-state.
 */
/**
 * @param {string[]} [order] Explicit option order. Without it options sort
 *   alphabetically, which is right for codes nobody has a mental order for
 *   (PUCS, zoning) but wrong for a fixed vocabulary: the appraisal
 *   categories have a natural order with Land first, and alphabetising
 *   them buries Land between Infrastructure and Mixed-Use. Values missing
 *   from `order` fall to the end, alphabetically, so an unforeseen option
 *   still appears rather than vanishing.
 */
/**
 * Order option values: by the caller's explicit list where it has one,
 * then everything else alphabetically after it. Exported for the unit
 * test — a filter whose options quietly reorder is a filter whose
 * checkboxes move under the cursor.
 */
export function sortOptions(values, order) {
  const rank = new Map((order || []).map((v, i) => [v, i]));
  return [...values].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    if (ra !== rb) return ra - rb;
    return String(a).localeCompare(String(b));
  });
}

export function createMultiSelectFilter({ btnId, popoverId, label, onChange, order }) {
  const $btn = document.getElementById(btnId);
  const $popover = document.getElementById(popoverId);
  let selected = null;      // tri-state, see the header
  let options = [];

  const noop = {
    setOptions: () => {}, getSelected: () => null,
    reset: () => {}, isEmptySelection: () => false,
  };
  if (!$btn || !$popover) return noop;

  const $label = () => $btn.querySelector('.sales-pucs-btn-label');
  const syncLabel = () => {
    const el = $label();
    if (el) el.textContent = selectionLabel(label, selected, options.length);
    // `has-selection` drives the filled-in look (dark ink, semibold,
    // stronger border) so a glance down the panel shows which pickers
    // are actually narrowing the set, rather than reading every label.
    $btn.classList.toggle('has-selection', selected != null);
  };

  // Popover open/close: click the button to toggle, click away or press
  // Esc to dismiss.
  $btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($btn.disabled) return;
    const open = $popover.classList.toggle('open');
    $btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!$popover.classList.contains('open')) return;
    if ($popover.contains(e.target) || $btn.contains(e.target)) return;
    $popover.classList.remove('open');
    $btn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$popover.classList.contains('open')) return;
    $popover.classList.remove('open');
    $btn.setAttribute('aria-expanded', 'false');
  });

  function render(counts) {
    $popover.innerHTML = '';

    const actions = document.createElement('div');
    actions.className = 'sales-pucs-popover-actions';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => {
      selected = null;
      render(counts);
      syncLabel();
      onChange?.();
    });
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.textContent = 'None';
    noneBtn.addEventListener('click', () => {
      selected = new Set();
      render(counts);
      syncLabel();
      onChange?.();
    });
    actions.appendChild(allBtn);
    actions.appendChild(noneBtn);
    $popover.appendChild(actions);

    for (const value of options) {
      const item = document.createElement('label');
      item.className = 'sales-pucs-popover-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = passesSelection(selected, value);
      cb.addEventListener('change', () => {
        // The first user-driven tick materializes the Set from the
        // implicit "everything" so unticking one leaves the rest on.
        if (selected == null) selected = new Set(options);
        if (cb.checked) selected.add(value);
        else selected.delete(value);
        if (selected.size === options.length) selected = null;
        syncLabel();
        onChange?.();
      });
      const text = document.createElement('span');
      text.textContent = value;
      const count = document.createElement('span');
      count.className = 'sales-pucs-popover-count';
      count.textContent = String(counts.get(value) ?? 0);
      item.appendChild(cb);
      item.appendChild(text);
      item.appendChild(count);
      $popover.appendChild(item);
    }
  }

  return {
    setOptions(counts) {
      options = sortOptions([...counts.keys()], order);
      if (options.length === 0) {
        $btn.disabled = true;
        const el = $label();
        if (el) el.textContent = `Any ${label}`;
        $btn.classList.remove('has-selection');
        $popover.innerHTML = '';
        $popover.classList.remove('open');
        $btn.setAttribute('aria-expanded', 'false');
        return;
      }
      selected = reconcileSelection(selected, options);
      $btn.disabled = false;
      syncLabel();
      render(counts);
    },
    getSelected: () => selected,
    reset() { selected = null; },
    isEmptySelection: () => selected != null && selected.size === 0,
  };
}
