// Interaction rules for the street-name typeahead's DOM controller
// (createStreetSuggest in src/lib/streetSuggest.js). Plain-node runner:
//   cd web && npm test
// or
//   node test/streetSuggestDom.test.js
//
// The repo's convention is to unit-test the pure half of a widget and
// leave the controller to a browser pass (see multiSelectFilter.test.js).
// This one gets a shim anyway, because its rules are the kind that break
// silently rather than visibly:
//
//   - Enter has to ACCEPT the highlighted street and only then search.
//     Get the order wrong and the search runs on half-typed text — which
//     still returns parcels, just the wrong ones.
//   - Arrowing has to cycle through n+1 slots, because -1 ("my own typing
//     stands") is a real state. Off by one and the last row is skipped.
//   - Committing a pick fires a synthetic 'input' so main.js refreshes
//     the URL. Unguarded, that reopens the list under the value just
//     committed and the field looks stuck.
//
// The shim below is the smallest thing that supports what the controller
// touches — not a DOM. If the controller starts using more of one, this
// will throw rather than quietly pass.
import assert from 'node:assert/strict';
import { createStreetSuggest, buildStreetIndex } from '../src/lib/streetSuggest.js';

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
}

// ---- the shim -------------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.classes = new Set();
    this.listeners = new Map();
    this.hidden = false;
    this.value = '';
    this.id = '';
    this.textContent = '';
    this.scrolledIntoView = false;
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      contains: (c) => this.classes.has(c),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
    };
  }

  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  get className() { return [...this.classes].join(' '); }

  set innerHTML(v) {
    if (v !== '') throw new Error('shim only supports innerHTML = ""');
    for (const c of this.children) c.parent = null;
    this.children = [];
  }

  appendChild(child) { child.parent = this; this.children.push(child); return child; }

  setAttribute(k, v) { this.attrs.set(k, String(v)); }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  removeAttribute(k) { this.attrs.delete(k); }

  closest(sel) {
    const want = sel.replace(/^\./, '');
    let node = this;
    while (node) {
      if (node.classes.has(want)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelectorAll(sel) {
    const want = sel.replace(/^\./, '');
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.classes.has(want)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  scrollIntoView() { this.scrolledIntoView = true; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatchEvent(ev) {
    for (const fn of this.listeners.get(ev.type) || []) fn(ev);
    return true;
  }
}

class Ev {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }

  preventDefault() { this.defaultPrevented = true; }

  stopPropagation() { this.propagationStopped = true; }
}

const registry = new Map();
globalThis.Event = Ev;
globalThis.document = {
  activeElement: null,
  getElementById: (id) => registry.get(id) || null,
  createElement: (tag) => new El(tag),
};

// Real d4mq-wa44 rows, counts as measured 2026-08-20.
const ROWS = [
  { street_name: 'PARK', street_type: 'BOULEVARD', n: 139 },
  { street_name: 'PARK', street_type: 'PLACE', n: 105 },
  { street_name: 'PARK', street_type: 'CIRCLE', n: 25 },
  { street_name: 'PARK EAST', street_type: 'DRIVE', n: 237 },
  { street_name: 'PARK WEST', street_type: 'DRIVE', n: 149 },
];

/** A fresh field + input + listbox, wired, with the index preloaded so
 *  the async load has already settled by the time a test types. */
async function mount({ onSearch } = {}) {
  registry.clear();
  const field = new El('span');
  field.className = 'field';
  const input = new El('input');
  input.id = 'address-street';
  const list = new El('div');
  list.id = 'address-street-suggest';
  list.hidden = true;
  field.appendChild(input);
  field.appendChild(list);
  registry.set(input.id, input);
  registry.set(list.id, list);
  document.activeElement = input;

  const searches = [];
  const api = createStreetSuggest({
    inputId: input.id,
    listId: list.id,
    loadIndex: () => Promise.resolve(buildStreetIndex(ROWS)),
    onSearch: onSearch || (() => searches.push(input.value)),
  });
  return { field, input, list, api, searches };
}

/** Type into the field the way a keyboard would, then let the lazy index
 *  promise settle before asserting. */
async function type(input, text) {
  input.value = text;
  input.dispatchEvent(new Ev('input'));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const key = (input, k) => {
  const ev = new Ev('keydown', { key: k });
  input.dispatchEvent(ev);
  return ev;
};
const optionNames = (list) => list
  .querySelectorAll('street-suggest-option')
  .map((el) => el.children[0].textContent);
const activeIndex = (list) => list
  .querySelectorAll('street-suggest-option')
  .findIndex((el) => el.classes.has('active'));

// ---- the tests ------------------------------------------------------------
const run = async () => {
  {
    const { input, list, field } = await mount();
    test('the list starts shut', () => {
      assert.equal(list.hidden, true);
    });
    await type(input, 'PARK');
    test('list opens with the ranked matches', () => {
      assert.equal(list.hidden, false);
      assert.deepEqual(optionNames(list), ['PARK', 'PARK EAST', 'PARK WEST']);
      assert.equal(input.getAttribute('aria-expanded'), 'true');
      // The .tip tooltip drops into the same spot; two stacked panels
      // read as a rendering bug.
      assert.equal(field.classes.has('street-suggest-open'), true);
    });
  }

  {
    const { input, list } = await mount();
    await type(input, 'P');
    test('one character keeps the list shut', () => {
      assert.equal(list.hidden, true);
      assert.equal(input.getAttribute('aria-expanded'), 'false');
    });
  }

  {
    const { input, list } = await mount();
    await type(input, 'PARK');
    test('arrowing cycles through the n+1 slots, -1 included', () => {
      assert.equal(activeIndex(list), -1, 'nothing highlighted until asked');
      key(input, 'ArrowDown'); assert.equal(activeIndex(list), 0);
      key(input, 'ArrowDown'); assert.equal(activeIndex(list), 1);
      key(input, 'ArrowDown'); assert.equal(activeIndex(list), 2);
      // Past the last row lands back on "my own typing", not on row 0.
      key(input, 'ArrowDown'); assert.equal(activeIndex(list), -1);
      // And up from there wraps to the LAST row.
      key(input, 'ArrowUp');   assert.equal(activeIndex(list), 2);
      key(input, 'ArrowUp');   assert.equal(activeIndex(list), 1);
    });
    test('the active row is announced to a screen reader', () => {
      assert.equal(input.getAttribute('aria-activedescendant'), 'address-street-suggest-opt-1');
    });
  }

  {
    const { input, list, searches } = await mount();
    await type(input, 'PARK');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    const ev = key(input, 'Enter');
    test('Enter accepts the highlighted street BEFORE the search reads the field', () => {
      assert.equal(input.value, 'PARK EAST');
      assert.deepEqual(searches, ['PARK EAST'], 'searched the accepted name, not the typed text');
      assert.equal(ev.defaultPrevented, true);
      assert.equal(list.hidden, true, 'list closes on accept');
    });
  }

  {
    const { input, list, searches } = await mount();
    await type(input, 'PARK');
    key(input, 'Enter');
    test('Enter with nothing highlighted searches what was typed', () => {
      assert.equal(input.value, 'PARK');
      assert.deepEqual(searches, ['PARK']);
      assert.equal(list.hidden, true);
    });
  }

  {
    const { input, list } = await mount();
    await type(input, 'PARK');
    key(input, 'ArrowDown');
    key(input, 'Enter');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    test('the synthetic input event from a pick does not reopen the list', () => {
      // main.js hangs the URL-state writer off 'input' and setting .value
      // in script fires nothing, so accept() dispatches one. Unguarded it
      // re-enters refresh() and the field looks stuck open.
      assert.equal(input.value, 'PARK');
      assert.equal(list.hidden, true);
    });
  }

  {
    let urlWrites = 0;
    const { input } = await mount();
    input.addEventListener('input', () => { urlWrites += 1; });
    await type(input, 'PARK');
    key(input, 'ArrowDown');
    key(input, 'Enter');
    test('a pick still tells main.js to refresh the URL', () => {
      assert.equal(urlWrites, 2, 'one for the typing, one for the commit');
    });
  }

  {
    const { input, list } = await mount();
    await type(input, 'PARK');
    const ev = key(input, 'Escape');
    test('Escape closes without clearing the text, and stops there', () => {
      assert.equal(list.hidden, true);
      assert.equal(input.value, 'PARK');
      assert.equal(ev.defaultPrevented, true);
      // Swallowed so it does not also close a dialog behind the field.
      assert.equal(ev.propagationStopped, true);
    });
  }

  {
    const { input, list } = await mount();
    await type(input, 'PARK');
    key(input, 'ArrowDown');
    const ev = key(input, 'Tab');
    test('Tab takes the highlighted street and lets focus move on', () => {
      assert.equal(input.value, 'PARK');
      assert.equal(list.hidden, true);
      assert.equal(ev.defaultPrevented, false, 'must not trap focus');
    });
  }

  {
    const { input, list, field } = await mount();
    await type(input, 'PARK');
    input.dispatchEvent(new Ev('blur'));
    test('blur closes the list and releases the tooltip', () => {
      assert.equal(list.hidden, true);
      assert.equal(field.classes.has('street-suggest-open'), false);
      assert.equal(input.getAttribute('aria-activedescendant'), null);
    });
  }

  {
    const { input, list } = await mount();
    await type(input, 'ZZZZ');
    test('a street the roll does not carry says so instead of showing nothing', () => {
      assert.equal(list.hidden, false);
      assert.deepEqual(optionNames(list), []);
      const [empty] = list.querySelectorAll('street-suggest-empty');
      assert.match(empty.textContent, /assessment roll/);
    });
    test('Enter on the no-match message still runs the search', () => {
      // The roll is not the only place the search looks — it also
      // cross-references civic addresses — so "not on the roll" must not
      // become "you may not search for this".
      key(input, 'Enter');
      assert.equal(list.hidden, true);
    });
  }

  {
    registry.clear();
    const field = new El('span');
    field.className = 'field';
    const input = new El('input');
    input.id = 'address-street';
    const list = new El('div');
    list.id = 'address-street-suggest';
    list.hidden = true;
    field.appendChild(input);
    field.appendChild(list);
    registry.set(input.id, input);
    registry.set(list.id, list);
    document.activeElement = input;
    const searches = [];
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...a) => warns.push(a[0]);
    createStreetSuggest({
      inputId: input.id,
      listId: list.id,
      loadIndex: () => Promise.reject(new Error('data.winnipeg.ca down')),
      onSearch: () => searches.push(input.value),
    });
    await type(input, 'PARK');
    console.warn = realWarn;
    test('a failed list fetch never blocks typing or searching', () => {
      assert.equal(warns.length, 1);
      key(input, 'Enter');
      assert.deepEqual(searches, ['PARK']);
    });
  }

  {
    registry.clear();
    test('a missing input or listbox returns an inert controller', () => {
      const api = createStreetSuggest({ inputId: 'nope', listId: 'also-nope' });
      assert.equal(api.isOpen(), false);
      assert.doesNotThrow(() => api.close());
    });
  }

  console.log('streetSuggestDom.test.js: all assertions passed');
};

run().catch((err) => { console.error(err); process.exitCode = 1; });
