// Tri-state selection rules behind the sales-tab PUCS and
// assessment-class filters. The states are not interchangeable:
// null = no filter, a Set = those only, an EMPTY Set = show nothing.
// Collapsing the last two together is the bug this pins.
import assert from 'node:assert/strict';
import {
  reconcileSelection,
  selectionLabel,
  passesSelection, sortOptions, toggleSelection,
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
// Short labels: the PUCS and class pickers share one row at half width,
// so anything longer ellipsises to nothing useful.
assert.equal(selectionLabel('class', null, 3), 'Any class');
assert.equal(selectionLabel('PUCS', null, 7), 'Any PUCS');
// Exactly one ticked shows the value itself — more informative than a
// count, and it fits.
assert.equal(selectionLabel('class', new Set(['OTHER']), 3), 'OTHER');
// Beyond one, the count.
assert.equal(selectionLabel('class', new Set(['OTHER', 'FARM']), 3), '2 of 3');
// The deliberate show-nothing state must not read as "Any".
assert.equal(selectionLabel('PUCS', new Set(), 7), 'None');

// ---- sortOptions ----------------------------------------------------------
// The appraisal categories have a natural reading order with Land first.
// Alphabetising them buries Land between Infrastructure and Mixed-Use,
// which is the wrong first thing to see in an app that is mostly about
// land — hence the optional explicit order.
const CATS = ['Land', 'Residential', 'Multi-Family', 'Condominium'];
assert.deepEqual(
  sortOptions(['Condominium', 'Multi-Family', 'Land', 'Residential'], CATS),
  ['Land', 'Residential', 'Multi-Family', 'Condominium'],
);
// A value the order has never heard of must still APPEAR — dropping it
// would silently hide every sale carrying it.
assert.deepEqual(
  sortOptions(['Zebra', 'Land', '(unclassified)'], CATS),
  ['Land', '(unclassified)', 'Zebra'],
);
// No order at all keeps the old alphabetical behaviour, so the PUCS and
// zoning pickers are untouched by this.
assert.deepEqual(sortOptions(['b', 'a', 'c']), ['a', 'b', 'c']);
assert.deepEqual(sortOptions(['b', 'a', 'c'], []), ['a', 'b', 'c']);


// ---- selectionLabel with a describe() ------------------------------------
// The PUCS picker names each code. With exactly one ticked the closed
// button is the only thing on screen saying what the filter is doing, so
// it spells the code out; every other count is unchanged, and a picker
// that passes no describe must behave exactly as before.
const PUCS_DESC = { RESSD: 'Detached Single Dwelling', ZZZZZ: '' };
const describe = (code) => PUCS_DESC[code] ?? '';

assert.equal(
  selectionLabel('PUCS', new Set(['RESSD']), 7, describe),
  'RESSD \u00b7 Detached Single Dwelling',
);
// A code the table has never seen renders bare rather than with a
// trailing separator and nothing after it.
assert.equal(selectionLabel('PUCS', new Set(['ZZZZZ']), 7, describe), 'ZZZZZ');
// describe is only consulted for the one-selected case.
assert.equal(selectionLabel('PUCS', new Set(['RESSD', 'RESMC']), 7, describe), '2 of 7');
assert.equal(selectionLabel('PUCS', null, 7, describe), 'Any PUCS');
assert.equal(selectionLabel('PUCS', new Set(), 7, describe), 'None');
// No describe = the old behaviour, unchanged.
assert.equal(selectionLabel('class', new Set(['OTHER']), 3), 'OTHER');


// ---- toggleSelection (click a cluster on the map) -------------------------
// EXACTLY the checkbox rule: everything starts selected and a click
// DESELECTS. The map and the popover are one control with one state, so
// neither can show a picture the other would read differently.
const CL = ['Fort Garry South', 'Transcona', 'Point Douglas North'];

// From no filter, the implicit "everything" is materialized and the clicked
// one comes OUT -- the same thing unticking one box does. It does not
// narrow to the one clicked.
assert.deepEqual(
  toggleSelection(null, 'Transcona', CL),
  new Set(['Fort Garry South', 'Point Douglas North']),
);

// Clicking another takes that one out too.
assert.deepEqual(
  toggleSelection(new Set(['Fort Garry South', 'Point Douglas North']), 'Fort Garry South', CL),
  new Set(['Point Douglas North']),
);

// Clicking a deselected one puts it back.
assert.deepEqual(
  toggleSelection(new Set(['Point Douglas North']), 'Transcona', CL),
  new Set(['Point Douglas North', 'Transcona']),
);

// Taking the LAST one out leaves the EMPTY Set: nothing selected, nothing
// shown. It must NOT collapse to null -- unticking every box already lands
// on the empty Set, and collapsing only the map path would make the same
// picture mean "show everything" by click and "show nothing" by checkbox.
const emptied = toggleSelection(new Set(['Transcona']), 'Transcona', CL);
assert.ok(emptied instanceof Set, 'empties to a Set, not null');
assert.equal(emptied.size, 0);
// And it is recoverable: clicking any cluster from the empty state selects it.
assert.deepEqual(toggleSelection(emptied, 'Transcona', CL), new Set(['Transcona']));

// Putting the last missing one back collapses to null -- "all selected"
// keeps one representation, and it is invisible because all-selected and
// no-filter show the same rows.
assert.equal(
  toggleSelection(new Set(['Transcona', 'Fort Garry South']), 'Point Douglas North', CL),
  null,
);

// A cluster the loaded sales never reach is a no-op: the selection comes
// back untouched (identity), not an empty or widened one.
const held = new Set(['Transcona']);
assert.equal(toggleSelection(held, 'Seven Oaks West', CL), held);
assert.equal(toggleSelection(null, 'Seven Oaks West', CL), null);

console.log('multiSelectFilter.test.js: all assertions passed');
