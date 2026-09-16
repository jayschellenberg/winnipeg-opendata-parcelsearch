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
export function selectionLabel(noun, selected, total, describe = null) {
  if (selected == null) return `Any ${noun}`;
  if (selected.size === 0) return 'None';
  if (selected.size === 1) {
    const only = [...selected][0];
    // With exactly one value ticked the closed button is the only thing
    // saying what the filter is doing, so spell the code out where the
    // caller can: "RESSD" names nothing, "RESSD · Detached Single
    // Dwelling" names the thing. Codes with no description (and every
    // picker that passes none) read exactly as before.
    const desc = describe ? describe(only) : '';
    return desc ? `${only} · ${desc}` : only;
  }
  return `${selected.size} of ${total}`;
}

/** Membership test matching the tri-state above. */
export function passesSelection(selected, value) {
  return selected == null || selected.has(value);
}

/**
 * The selection after toggling one value — the gesture behind clicking a
 * cluster on the map, where there is no checkbox to read the current state
 * off of.
 *
 * EXACTLY the checkbox rule, deliberately. Everything starts selected, and
 * a click DESELECTS: the cluster drops out of the filter, its sales leave
 * the grid, and its boundary fades back (Jason, 2026-09-16). Clicking it
 * again puts it back.
 *
 * This replaced an earlier "a click narrows TO the one clicked" reading,
 * which made the map and the popover two different controls wearing the
 * same state. The rule now is simply: what is selected is what shows, and
 * both gestures move the same selection the same way.
 *
 *   from null (no filter) the implicit "everything" is materialized first,
 *   so the first click yields every option EXCEPT the one clicked — the
 *   same thing unticking one box does.
 *
 *   removing the last value leaves an EMPTY SET: nothing selected, nothing
 *   shown. The caller explains the empty grid (see the no-neighbourhoods-
 *   selected clause on the sales count line) rather than this quietly
 *   widening the search back to everything the user just cleared.
 *
 *   filling the set back to every option collapses to null, matching
 *   reconcileSelection. That collapse is invisible: all-selected and
 *   no-filter show the same rows.
 *
 * Returns the unchanged selection when `value` is not on offer, so a click
 * on a cluster the loaded sales never reach is a no-op rather than a
 * filter that can match nothing.
 */
export function toggleSelection(selected, value, options) {
  if (!options.includes(value)) return selected;
  const next = selected == null ? new Set(options) : new Set(selected);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  if (next.size === options.length) return null;
  return next;
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

/**
 * @param {(value: string) => string} [describe] Plain-language name for an
 *   option value, shown beside it in the popover and on the button when
 *   exactly one is ticked. The Par Use Codes are the case this exists for:
 *   a list of 57 five-letter codes is unreadable, and the appraiser is
 *   choosing "Detached Single Dwelling", not "RESSD". Return '' for a
 *   value with no name and the option renders bare.
 */
export function createMultiSelectFilter({ btnId, popoverId, label, onChange, order, describe }) {
  const $btn = document.getElementById(btnId);
  const $popover = document.getElementById(popoverId);
  let selected = null;      // tri-state, see the header
  let options = [];
  // Held so toggleValue can repaint the checkboxes after a change that did
  // not come from a checkbox. Without it a map click would move the filter
  // and leave every box in the popover showing the previous state.
  let lastCounts = new Map();
  // A selection restored from a saved search BEFORE any options exist.
  // Held rather than applied, because reconcileSelection against an empty
  // option list keeps nothing and lands on the empty Set — "show nothing"
  // — which is how loading a saved search before pressing Search used to
  // guarantee an empty grid. `hasPending` is separate from the value
  // because null is itself a meaningful selection (no filter).
  let pending = null;
  let hasPending = false;

  const noop = {
    setOptions: () => {}, getSelected: () => null,
    reset: () => {}, isEmptySelection: () => false,
    hasOption: () => false, toggleValue: () => false,
  };
  if (!$btn || !$popover) return noop;

  const $label = () => $btn.querySelector('.sales-pucs-btn-label');
  const syncLabel = () => {
    const el = $label();
    if (el) el.textContent = selectionLabel(label, selected, options.length, describe);
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
  // Every click that STARTS inside the popover stops here, so the
  // document-level dismiss handler below never sees it. This is
  // load-bearing, not tidiness: All, None and (once the options are
  // re-tallied on each run) the checkboxes all lead to render(), which
  // wipes and rebuilds the popover's children. By the time the click
  // reached the document the element it started on had been REMOVED from
  // the DOM, so `$popover.contains(e.target)` answered false and the
  // popover shut the list the user was working in. Guarding the container
  // once immunises every control in it, including ones added later.
  $popover.addEventListener('click', (e) => e.stopPropagation());
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
      text.className = 'sales-pucs-popover-value';
      text.textContent = value;
      // The name sits in its own span rather than inside the value's, so
      // CSS can dim it and let it truncate while the code itself — the
      // part that has to stay readable — never does.
      const desc = describe ? String(describe(value) ?? '') : '';
      const $desc = desc ? document.createElement('span') : null;
      if ($desc) {
        $desc.className = 'sales-pucs-popover-desc';
        $desc.textContent = desc;
        // The sidebar is narrow enough that a long name can still clip,
        // so the hover text carries the whole thing.
        item.title = `${value} — ${desc}`;
      }
      const count = document.createElement('span');
      count.className = 'sales-pucs-popover-count';
      const n = counts.get(value) ?? 0;
      count.textContent = String(n);
      // Zero means "nothing left under the OTHER filters", not "not a real
      // option" — the row stays and stays tickable, but it should not read
      // as an equal choice.
      item.classList.toggle('is-empty', n === 0);
      item.appendChild(cb);
      item.appendChild(text);
      if ($desc) item.appendChild($desc);
      item.appendChild(count);
      $popover.appendChild(item);
    }
  }

  return {
    setOptions(counts) {
      lastCounts = counts;
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
      // A selection restored from a saved search wins over whatever was
      // showing: it was chosen for THIS search, and it has been waiting
      // for the options to exist.
      if (hasPending) {
        selected = pending == null ? null : reconcileSelection(new Set(pending), options);
        pending = null;
        hasPending = false;
      } else {
        selected = reconcileSelection(selected, options);
      }
      $btn.disabled = false;
      syncLabel();
      render(counts);
    },
    getSelected: () => selected,
    // Clears the ACTIVE selection but deliberately NOT a pending restore.
    // handleSalesUpload calls this on every load to drop the previous
    // CSV's picks — and that load is exactly the event that finally gives
    // a saved search its options. Clearing pending here made loading a
    // search and then loading sales silently discard the search.
    reset() { selected = null; },
    isEmptySelection: () => selected != null && selected.size === 0,

    /**
     * Put a selection back from outside — the saved-search loader.
     * Reconciled against the options on offer, so a saved code the current
     * CSV does not carry is dropped rather than filtering to nothing. Does
     * NOT fire onChange: the loader restores a dozen controls and then runs
     * the analysis once, instead of once per control.
     */
    setSelected(next) {
      if (options.length === 0) {
        // Nothing to reconcile against yet — hold it for the first
        // setOptions rather than reconciling it away to nothing.
        pending = next == null ? null : [...next];
        hasPending = true;
        selected = null;
        syncLabel();
        return;
      }
      hasPending = false;
      selected = next == null ? null : reconcileSelection(new Set(next), options);
      syncLabel();
      render(lastCounts);
    },

    /** Is this value on offer right now? Lets a caller ask before acting —
     *  the map picker uses it to decide whether a click is a selection or
     *  should fall through to the layer's ordinary info popup. */
    hasOption: (value) => options.includes(value),

    /**
     * Toggle one value from outside the popover (a click on the map).
     * Repaints the checkboxes and the button, then fires onChange exactly
     * as a checkbox would. Returns false — changing nothing — when the
     * value is not on offer.
     */
    toggleValue(value) {
      if (!options.includes(value)) return false;
      selected = toggleSelection(selected, value, options);
      syncLabel();
      render(lastCounts);
      onChange?.();
      return true;
    },
  };
}
