// Tri-state selection rules behind the sales-tab PUCS and
// assessment-class filters. The states are not interchangeable:
// null = no filter, a Set = those only, an EMPTY Set = show nothing.
// Collapsing the last two together is the bug this pins.
import assert from 'node:assert/strict';
import {
  reconcileSelection,
  selectionLabel,
  passesSelection,
} from '../src/lib/multiSelectFilter.js';

// ---- passesSelection ------------------------------------------------------
assert.equal(passesSelection(null, 'RESIDENTIAL 1'), true, 'null = no filter');
assert.equal(passesSelection(new Set(['OTHER']), 'OTHER'), true);
assert.equal(passesSelection(new Set(['OTHER']), 'RESIDENTIAL 1'), false);
// An empty Set is a deliberate "show nothing", NOT "no filter".
assert.equal(passesSelection(new Set(), 'OTHER'), false);

// ---- reconcileSelection ---------------------------------------------------
const OPTIONS = ['OTHER', 'RESIDENTIAL 1', 'RESIDENTIAL 2'];

// No filter stays no filter.
assert.equal(reconcileSelection(null, OPTIONS), null);

// A subset survives intact.
assert.deepEqual(
  [...reconcileSelection(new Set(['OTHER']), OPTIONS)],
  ['OTHER'],
);

// Every option ticked collapses to null, so "all selected" and "no
// filter" have exactly one representation and can't disagree.
assert.equal(reconcileSelection(new Set(OPTIONS), OPTIONS), null);

// Values that no longer exist are dropped. A fresh CSV brings a
// different set of codes; keeping a stale one would filter against
// something nothing can match.
assert.deepEqual(
  [...reconcileSelection(new Set(['OTHER', 'GONE']), OPTIONS)],
  ['OTHER'],
);

// Dropping stale values can itself complete the set — and that must
// still collapse to null rather than leaving a Set that happens to
// contain everything.
assert.equal(reconcileSelection(new Set([...OPTIONS, 'GONE']), OPTIONS), null);

// An empty selection is preserved, not helpfully "fixed" into null.
// The user clicked None and the caller reports that state explicitly.
{
  const r = reconcileSelection(new Set(), OPTIONS);
  assert.ok(r instanceof Set);
  assert.equal(r.size, 0);
}

// Every value going stale leaves an empty Set, not null — the filter is
// still on, it just matches nothing, which is the honest reading.
{
  const r = reconcileSelection(new Set(['GONE']), OPTIONS);
  assert.equal(r.size, 0);
}

// No options at all (empty CSV): a selection can't collapse to "all
// selected" off an empty list, so it stays a Set.
assert.equal(reconcileSelection(null, []), null);
assert.equal(reconcileSelection(new Set(['OTHER']), []).size, 0);

// ---- selectionLabel -------------------------------------------------------
assert.equal(selectionLabel('Filter by class', null, 3), 'Filter by class · all 3');
assert.equal(selectionLabel('Filter by class', new Set(['OTHER']), 3), 'Filter by class · 1 of 3');
assert.equal(selectionLabel('Filter by PUCS', new Set(), 7), 'Filter by PUCS · 0 of 7');

console.log('multiSelectFilter.test.js: all assertions passed');
