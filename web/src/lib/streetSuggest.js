/*
 * Street-name typeahead for the Property Search tab's Street Name field.
 *
 * Two decisions in here are load-bearing and both were measured against
 * the live datasets rather than assumed:
 *
 * 1. THE LIST COMES FROM THE ASSESSMENT ROLL (d4mq-wa44), not from the
 *    Civic Addresses dataset (cam2-ii3u), even though cam2-ii3u is the
 *    City's address authority and carries MORE names — 4,331 against
 *    4,238. 115 of those extra names (ADMIRAL, BEHNKE, GYPSUM, COMMERCE,
 *    MAHATMA GANDHI …) have civic addresses but no assessment parcel
 *    under them; spot-checked against `within_circle(geometry,…)`, the
 *    nearest parcel to those address points is on a DIFFERENT street, so
 *    the search's cam2 cross-reference path (searchAddressesAndFindParcels
 *    → point-in-polygon) finds nothing either. Suggesting them would offer
 *    115 streets that return an empty grid. The 45 names that go the other
 *    way are almost all apostrophe spellings ("ST MARY'S" vs "ST MARYS")
 *    that streetNameClause already matches from both sides.
 *
 * 2. A SUGGESTION MUST SEARCH AS THE STREET IT NAMES. 56 real street
 *    names END in a word normalizeStreetQuery treats as a street type or
 *    a direction — ELM PARK, GOLDEN GATE, MIDDLE GATE, NORTH POINT,
 *    LINDEN TERRACE, PARK EAST, WILDWOOD E. Untaught, picking "PARK EAST"
 *    (237 parcels) searched "PARK" and returned 2,686 parcels across 47
 *    streets. soda.js's normalizeStreetQuery now keeps the trailing token
 *    when the whole string is a name the roll actually carries, which is
 *    what makes a pick mean what it says. See the note there.
 *
 * The pure half (buildStreetIndex / suggestStreets / suggestKey) is
 * exported separately from the DOM controller so the ranking rules can be
 * unit tested without a browser.
 */
import { streetKey, normalizeStreetQuery } from '../soda.js';

/** Rows shown at once. Eight fills the sidebar without covering the
 *  Roll # field below it. */
export const STREET_SUGGEST_LIMIT = 8;
/** Below this the list stays shut. One character matches hundreds of
 *  streets and the ranking has nothing to work with; two is where the
 *  top of the list starts being the street you meant. */
export const STREET_SUGGEST_MIN_QUERY = 2;

/**
 * Matching key for the SUGGESTION list. `streetKey` (soda.js) is the
 * clause-aligned form — it strips exactly the characters the SoQL side
 * strips off the column, so the two agree on what matches. This one goes
 * one step further and folds a hyphen to a space, which the clause does
 * NOT do: five names carry hyphens (EAU-CLAIRE, JEAN-BAPTISTE LAVOIE,
 * PHIL-CHRIS, TARA-LEE, TU-PELO) and typing them the natural way with a
 * space would otherwise surface nothing. Widening only the SUGGESTION
 * side is safe — accepting one inserts the roll's own spelling, so the
 * query that finally runs is still an exact hit.
 */
export function suggestKey(raw) {
  return streetKey(String(raw ?? '').replace(/-/g, ' '));
}

/**
 * Fold the `street_name,street_type,count(*)` group-by rows into one
 * entry per NAME.
 *
 * Name-only, because that is the granularity the search works at:
 * street_type lives in its own column and streetNameClause never touches
 * it. 127 names carry more than one type (ASSINIBOINE is an AVENUE, a
 * CRESCENT and a GROVE) and searching the name returns all of them, so
 * the types ride along as a LABEL — the user can see that BEAUMONT means
 * both the BAY and the STREET before they run it — rather than as three
 * separate rows that would all do the same thing.
 *
 * Types are ordered by parcel count so the dominant one reads first.
 * Rows with no street_name are dropped: the roll has 3,196 parcels with
 * no address at all and they group into one blank bucket.
 */
export function buildStreetIndex(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const name = String(row?.street_name ?? '').trim();
    if (!name) continue;
    const count = Number(row?.n ?? row?.count ?? 0) || 0;
    const type = String(row?.street_type ?? '').trim();
    let entry = byName.get(name);
    if (!entry) {
      entry = { name, key: suggestKey(name), count: 0, _types: new Map() };
      byName.set(name, entry);
    }
    entry.count += count;
    if (type) entry._types.set(type, (entry._types.get(type) || 0) + count);
  }
  const index = [];
  for (const entry of byName.values()) {
    entry.types = [...entry._types.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t);
    delete entry._types;
    index.push(entry);
  }
  index.sort((a, b) => a.name.localeCompare(b.name));
  return index;
}

/** The set of clause-aligned names, for soda.js's known-name check.
 *  Built here so the caller has one place to go from raw rows to both
 *  the index and the set. */
export function streetNameSet(rows) {
  const out = new Set();
  for (const row of rows || []) {
    const name = String(row?.street_name ?? '').trim();
    if (name) out.add(streetKey(name));
  }
  return out;
}

/**
 * Rank the index against one already-keyed query.
 *
 * Tiers, best first: the whole name, a prefix of it, the start of any
 * word inside it, then anywhere inside it. Within a tier the street with
 * more parcels wins, so typing MAIN offers MAIN (2,282 parcels) above
 * MAINLAND — the ordering an appraiser expects and the one a plain
 * alphabetical list gets wrong.
 */
function rank(index, q, limit) {
  const hits = [];
  for (const entry of index) {
    const k = entry.key;
    let tier = -1;
    if (k === q) tier = 0;
    else if (k.startsWith(q)) tier = 1;
    else if (k.includes(` ${q}`)) tier = 2;
    else if (k.includes(q)) tier = 3;
    if (tier < 0) continue;
    hits.push({ tier, entry });
  }
  hits.sort((a, b) => (
    a.tier - b.tier
    || b.entry.count - a.entry.count
    || a.entry.name.localeCompare(b.entry.name)
  ));
  return hits.slice(0, limit).map((h) => h.entry);
}

/**
 * Suggestions for what the user has typed so far.
 *
 * Two passes. The first is literal — what you typed, punctuation and
 * case folded — so "PARK EAST" finds PARK EAST and stops there. Only if
 * that finds NOTHING does it fall back to normalizeStreetQuery, which
 * drops a trailing street type: "PORTAGE AVE" matches no street name as
 * written, so the fallback turns it into PORTAGE and offers that. Doing
 * the fallback second rather than first is the whole reason a name that
 * ends in a type word still reaches its own street.
 */
export function suggestStreets(index, query, limit = STREET_SUGGEST_LIMIT) {
  const q = suggestKey(query);
  if (q.length < STREET_SUGGEST_MIN_QUERY) return [];
  const direct = rank(index || [], q, limit);
  if (direct.length) return direct;
  const relaxed = suggestKey(normalizeStreetQuery(query));
  if (!relaxed || relaxed === q || relaxed.length < STREET_SUGGEST_MIN_QUERY) return [];
  return rank(index || [], relaxed, limit);
}

/** The grey half of a row: "AVENUE · CRESCENT · 449 parcels". Types
 *  first because that is what disambiguates two streets sharing a name;
 *  the count is the tiebreaker the eye uses after that. */
export function suggestHint(entry) {
  const parts = [];
  if (entry?.types?.length) parts.push(entry.types.join(' · '));
  const n = Number(entry?.count) || 0;
  parts.push(`${n.toLocaleString()} parcel${n === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Wire the Street Name input to a listbox of suggestions.
 *
 * @param {Object} opts
 * @param {string} opts.inputId    id of the text input
 * @param {string} opts.listId     id of the (empty, hidden) listbox element
 * @param {() => Promise<Object[]>} opts.loadIndex  resolves to the index;
 *   called once, on the first focus or keystroke, and its promise reused.
 *   Rejection is swallowed — a typeahead that cannot load must not stop
 *   anyone typing a street name and searching.
 * @param {() => void} [opts.onSearch]  run the search. Owned here because
 *   Enter has to mean "take the highlighted street AND search" in one
 *   keystroke, which needs the accept to happen before the search reads
 *   the field — see the note at the keydown handler.
 *
 * @returns {{ close: () => void, isOpen: () => boolean }}
 */
export function createStreetSuggest({ inputId, listId, loadIndex, onSearch }) {
  const $input = document.getElementById(inputId);
  const $list = document.getElementById(listId);
  const noop = { close: () => {}, isOpen: () => false };
  if (!$input || !$list) return noop;
  const $field = $input.closest('.field');

  let index = null;
  let loading = null;
  let matches = [];
  let active = -1;
  // Set while accept() writes the field, so the synthetic 'input' event
  // that tells main.js to refresh the URL does not immediately reopen
  // the list under the value we just committed.
  let accepting = false;

  function ensureIndex() {
    if (index || loading) return loading;
    loading = Promise.resolve()
      .then(loadIndex)
      .then((rows) => { index = rows; return rows; })
      .catch((err) => {
        console.warn('street-name suggestions unavailable', err);
        index = [];
        return [];
      });
    return loading;
  }

  function close() {
    $list.hidden = true;
    $list.innerHTML = '';
    matches = [];
    active = -1;
    $input.setAttribute('aria-expanded', 'false');
    $input.removeAttribute('aria-activedescendant');
    $field?.classList.remove('street-suggest-open');
  }

  function syncActive() {
    const opts = $list.querySelectorAll('.street-suggest-option');
    opts.forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
    if (active >= 0 && opts[active]) $input.setAttribute('aria-activedescendant', opts[active].id);
    else $input.removeAttribute('aria-activedescendant');
  }

  function accept(entry) {
    if (!entry) return;
    accepting = true;
    $input.value = entry.name;
    // main.js hangs the URL-state writer off 'input', and setting .value
    // in script fires nothing.
    $input.dispatchEvent(new Event('input', { bubbles: true }));
    accepting = false;
    close();
  }

  function render() {
    $list.innerHTML = '';
    if (!matches.length) {
      // Said out loud rather than left as an empty box. The list is the
      // assessment roll, so "nothing here" is a real answer about where
      // the search is about to look — not a sign the typeahead broke.
      const empty = document.createElement('div');
      empty.className = 'street-suggest-empty';
      empty.textContent = 'No street by that name on the assessment roll';
      $list.appendChild(empty);
    }
    matches.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'street-suggest-option';
      row.id = `${listId}-opt-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.className = 'street-suggest-name';
      name.textContent = entry.name;
      const hint = document.createElement('span');
      hint.className = 'street-suggest-hint';
      hint.textContent = suggestHint(entry);
      row.appendChild(name);
      row.appendChild(hint);
      row.addEventListener('click', () => accept(entry));
      $list.appendChild(row);
    });
    $list.hidden = false;
    $input.setAttribute('aria-expanded', 'true');
    // The field's own .tip tooltip drops into the same spot on hover.
    // Two panels stacked on one another read as a rendering bug.
    $field?.classList.add('street-suggest-open');
    syncActive();
  }

  function refresh() {
    const raw = $input.value;
    if (suggestKey(raw).length < STREET_SUGGEST_MIN_QUERY) { close(); return; }
    ensureIndex().then(() => {
      // The field can have moved on while the first fetch was in flight.
      if (document.activeElement !== $input) return;
      if (suggestKey($input.value).length < STREET_SUGGEST_MIN_QUERY) { close(); return; }
      matches = suggestStreets(index, $input.value);
      active = -1;
      render();
    });
  }

  $input.addEventListener('input', () => { if (!accepting) refresh(); });
  $input.addEventListener('focus', () => refresh());
  $input.addEventListener('blur', () => close());

  // Keep the pointer from stealing focus: a blur fires before click and
  // would close the list out from under the cursor.
  $list.addEventListener('mousedown', (e) => e.preventDefault());

  $input.addEventListener('keydown', (e) => {
    const open = !$list.hidden && matches.length > 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { refresh(); return; }
      e.preventDefault();
      // Cycle through n+1 positions, not n: -1 is "nothing highlighted,
      // my own typing stands", and arrowing past either end has to land
      // back on it rather than skipping from the last row to the first.
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const slots = matches.length + 1;
      active = (((active + 1 + step) % slots) + slots) % slots - 1;
      syncActive();
      return;
    }
    if (e.key === 'Escape') {
      if (!$list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      return;
    }
    if (e.key === 'Tab') {
      if (open && active >= 0) accept(matches[active]);
      else close();
      return;
    }
    if (e.key === 'Enter') {
      // Enter is BOTH keys the user would otherwise press. Accepting has
      // to finish before the search reads the field, which is why this
      // field is not in main.js's generic Enter-runs-the-search loop —
      // two listeners on one element would have run in registration
      // order and searched the half-typed text.
      e.preventDefault();
      if (open && active >= 0) accept(matches[active]);
      else close();
      onSearch?.();
    }
  });

  return { close, isOpen: () => !$list.hidden };
}
