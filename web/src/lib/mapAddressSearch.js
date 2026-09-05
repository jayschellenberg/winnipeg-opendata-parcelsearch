/*
 * The map's own address box — a one-field way in.
 *
 * The sidebar asks for an address in three controls (From #, To #, Street
 * Name) because that is what a RANGE search needs. Looking up one property
 * is the common case and does not need three fields, so this box takes the
 * address as a person writes it — "1393 Border St" — resolves it against the
 * City's civic-address dataset (cam2-ii3u), and then fills those three
 * controls and runs the ordinary search. It is an input to the existing
 * search, not a second search path: everything downstream — the cam2
 * cross-reference, the alias enrichment, the map, the CSV — is unchanged.
 *
 * Why cam2-ii3u rather than the assessment roll: this box matches whole
 * addresses, and cam2 is the City's address authority — it carries the side
 * doors and alias numbers the roll does not (1393 Border St is a real
 * address on a parcel the roll calls 1347 Border Street). Picking one
 * inserts its street_number / street_name, so the search that runs is the
 * same search the user could have typed by hand.
 *
 * Note the sibling decision in streetSuggest.js, which suggests street NAMES
 * from the roll instead, for a reason that does not apply here: 115 street
 * names exist in cam2 with no assessment parcel under them, and offering
 * those as a street would promise a grid that comes back empty. This box
 * offers a specific address rather than a street, and an address that
 * resolves to no parcel is a real answer about that address.
 *
 * The pure half is exported separately from the DOM controller so the
 * parsing and field-mapping can be tested without a browser.
 */

/** Below this the list stays shut — two characters match most of the city. */
export const MAP_ADDRESS_MIN_QUERY = 3;
/** Rows shown at once. */
export const MAP_ADDRESS_LIMIT = 8;
/** Typing pause before a query goes out. */
export const MAP_ADDRESS_DEBOUNCE_MS = 180;

/**
 * Split typed text into a leading civic number and the rest.
 *   "1393 Border St" -> { number: '1393', street: 'BORDER ST' }
 *   "Border"         -> { number: null,  street: 'BORDER' }
 *   "1393"           -> { number: '1393', street: '' }
 * Returns null for input with nothing to match on.
 */
export function parseAddressQuery(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*(.*)$/);
  if (m) return { number: m[1], street: m[2].trim() };
  return { number: null, street: s };
}

/**
 * Drop the street-type and direction tokens from the tail of a street
 * fragment, because cam2-ii3u keeps them in their own columns —
 * `street_name` for "1393 BORDER ST" is just "BORDER". Only trailing
 * tokens go, and never the last one standing: "ST" typed alone is
 * someone starting to write ST MARY'S, not a street type.
 */
const TYPE_TOKENS = new Set([
  'ST', 'STREET', 'AVE', 'AV', 'AVENUE', 'RD', 'ROAD', 'DR', 'DRIVE',
  'BLVD', 'BOULEVARD', 'CR', 'CRES', 'CRESCENT', 'PL', 'PLACE', 'BAY',
  'WAY', 'CRT', 'COURT', 'PKY', 'PKWY', 'PARKWAY', 'TERR', 'TERRACE',
  'PROM', 'PROMENADE', 'SQ', 'SQUARE', 'GDNS', 'GARDENS', 'HWY', 'HIGHWAY',
  'LANE', 'COVE', 'GATE', 'ROW', 'CLOSE', 'PT', 'POINT', 'TRAIL', 'CIR',
  'CIRCLE', 'GROVE', 'WALK', 'BEND', 'RIDGE', 'RUN', 'MEWS', 'ALLEY',
]);
const DIR_TOKENS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST']);

export function streetNameFragment(street) {
  const tokens = String(street ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && DIR_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  while (tokens.length > 1 && TYPE_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/**
 * Rank and trim the rows a query came back with. Exact civic-number hits
 * first, then by street name, then numerically by number — so "1393 Bor"
 * puts 1393 BORDER ST above 1393 BORDEN AVE only when the name matches
 * better, and a street-only query reads in address order rather than in
 * whatever order the service returned.
 */
export function rankAddresses(rows, raw, limit = MAP_ADDRESS_LIMIT) {
  const parsed = parseAddressQuery(raw);
  if (!parsed) return [];
  const frag = streetNameFragment(parsed.street);
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const full = String(row?.full_address ?? '').trim();
    if (!full || seen.has(full)) continue;
    seen.add(full);
    const name = String(row?.street_name ?? '').toUpperCase();
    out.push({
      full_address: full,
      street_number: String(row?.street_number ?? ''),
      street_name: String(row?.street_name ?? ''),
      street_type: String(row?.street_type ?? ''),
      _rank: [
        parsed.number && String(row?.street_number) === parsed.number ? 0 : 1,
        frag && name.startsWith(frag) ? 0 : 1,
        name,
        Number(String(row?.street_number ?? '').replace(/\D/g, '')) || 0,
      ],
    });
  }
  out.sort((a, b) => {
    for (let i = 0; i < a._rank.length; i++) {
      if (a._rank[i] < b._rank[i]) return -1;
      if (a._rank[i] > b._rank[i]) return 1;
    }
    return 0;
  });
  return out.slice(0, limit).map(({ _rank, ...rest }) => rest);
}

/**
 * The three sidebar values a chosen address becomes. Taken from cam2's
 * structured columns rather than re-parsed out of the display string, so
 * the street that goes into the search is the one the dataset asserts.
 * From and To are the same number: this box looks up ONE property.
 */
export function addressToFields(entry) {
  if (!entry) return null;
  const number = String(entry.street_number ?? '').trim();
  const street = String(entry.street_name ?? '').trim();
  if (!number || !street) return null;
  return { from: number, to: number, street };
}

/**
 * Wire the box up. `fetchAddresses(query)` resolves to raw cam2 rows;
 * `onPick(fields, entry)` gets the sidebar values to apply and run.
 *
 * Returns { close, isOpen } like createStreetSuggest, so main.js can treat
 * the two typeaheads the same way.
 */
export function createMapAddressSearch({ inputId, listId, fetchAddresses, onPick }) {
  const $input = document.getElementById(inputId);
  const $list = document.getElementById(listId);
  const noop = { close: () => {}, isOpen: () => false };
  if (!$input || !$list) return noop;

  let matches = [];
  let active = -1;
  let timer = null;
  // Responses can land out of order — a slow query for "13" must not
  // overwrite the list for "1393 Bor" that the user has already typed.
  let seq = 0;

  function close() {
    $list.hidden = true;
    $list.innerHTML = '';
    matches = [];
    active = -1;
    $input.setAttribute('aria-expanded', 'false');
    $input.removeAttribute('aria-activedescendant');
  }

  function syncActive() {
    const opts = $list.querySelectorAll('.map-address-option');
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
    const fields = addressToFields(entry);
    if (!fields) return;
    $input.value = entry.full_address;
    close();
    $input.blur();
    onPick?.(fields, entry);
  }

  function render() {
    $list.innerHTML = '';
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'map-address-empty';
      empty.textContent = 'No civic address matches';
      $list.appendChild(empty);
    }
    matches.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'map-address-option';
      row.id = `${listId}-opt-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.textContent = entry.full_address;
      row.addEventListener('click', () => accept(entry));
      $list.appendChild(row);
    });
    $list.hidden = false;
    $input.setAttribute('aria-expanded', 'true');
    syncActive();
  }

  function refresh() {
    const raw = $input.value.trim();
    if (raw.length < MAP_ADDRESS_MIN_QUERY) { close(); return; }
    const mine = ++seq;
    Promise.resolve()
      .then(() => fetchAddresses(raw))
      .then((rows) => {
        if (mine !== seq) return;                    // a newer query won
        if (document.activeElement !== $input) return;
        matches = rankAddresses(rows, raw);
        active = -1;
        render();
      })
      .catch((err) => {
        if (mine !== seq) return;
        console.warn('address suggestions unavailable', err);
        close();
      });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, MAP_ADDRESS_DEBOUNCE_MS);
  }

  $input.addEventListener('input', schedule);
  $input.addEventListener('focus', () => { if ($input.value.trim()) schedule(); });
  $input.addEventListener('blur', () => { clearTimeout(timer); close(); });
  // A blur fires before click and would close the list under the cursor.
  $list.addEventListener('mousedown', (e) => e.preventDefault());

  $input.addEventListener('keydown', (e) => {
    const open = !$list.hidden && matches.length > 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { refresh(); return; }
      e.preventDefault();
      // n+1 slots: -1 is "nothing highlighted, my own typing stands".
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const slots = matches.length + 1;
      active = (((active + 1 + step) % slots) + slots) % slots - 1;
      syncActive();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();       // don't let the map read it as a draw-cancel
      if (!$list.hidden) { e.preventDefault(); close(); } else { $input.blur(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter on a highlighted row picks it; Enter on typed text takes the
      // best match, which is what the list is already showing at the top.
      if (open) accept(matches[active >= 0 ? active : 0]);
    }
  });

  return { close, isOpen: () => !$list.hidden };
}
