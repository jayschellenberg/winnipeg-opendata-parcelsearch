/*
 * Save / load a Sales Analysis search as a small YAML file.
 *
 * WHY A FILE AND NOT THE URL. The tab already round-trips a handful of
 * settings through `?sr=` / `?n1=` / `?rad=` (lib/urlState.js), and that
 * stays the way to SHARE a view. This is the other job: a search an
 * appraiser re-runs — the same date window, the same categories, the same
 * lot-size band — months later on a newer archive. A file can be named,
 * filed beside the job, diffed and edited by hand; a URL cannot.
 *
 * WHY YAML AND NOT JSON. It is read by a person as often as by the app.
 * The file opens in any editor, every line is `key: value`, the comments
 * survive a round trip through a human, and a typo is visible rather than
 * a parse error three hundred characters along one line.
 *
 * ONLY A SUBSET IS PARSED, deliberately: `key: scalar`, `key: [a, b]`,
 * and a block list of `- item` under a key. No anchors, no nesting, no
 * multi-line scalars. Everything this writes, it can read; a file that
 * uses more YAML than that is a file this did not write.
 *
 * THE TRI-STATE IS THE WHOLE DESIGN PROBLEM. Every multi-select here has
 * three meanings — no filter, some values, and a deliberate show-nothing
 * — and an empty YAML list cannot tell the first from the third. So they
 * are spelled out: `all`, `none`, or a list. A missing key also means
 * `all`, so a hand-written file can name only what it cares about.
 *
 * Pure: no DOM, no File API. main.js owns reading the controls and
 * putting the values back.
 */

/** Bumped only when an older file would be MISREAD, not merely incomplete. */
export const CRITERIA_VERSION = 1;

/* The scalar fields, in the order they are written. `key` is the YAML
 * name; `id` is the element main.js reads it off. Kept as data so the
 * writer, the reader and the test all walk one list — a field added to
 * the app and forgotten here is the failure mode this shape prevents. */
export const SCALAR_FIELDS = Object.freeze([
  { key: 'subject_roll',     id: 'subject-roll' },
  { key: 'radius_km',        id: 'sales-radius-km' },
  { key: 'sale_date_from',   id: 'sales-date-from' },
  { key: 'sale_date_to',     id: 'sales-date-to' },
  { key: 'sales',            id: 'vacant-improved' },
  { key: 'year_built_from',  id: 'sales-year-low' },
  { key: 'year_built_to',    id: 'sales-year-high' },
  { key: 'building_sf_min',  id: 'sales-bldg-low' },
  { key: 'building_sf_max',  id: 'sales-bldg-high' },
  { key: 'price_min',        id: 'sales-price-low' },
  { key: 'price_max',        id: 'sales-price-high' },
  { key: 'lot_sf_min',       id: 'sales-size-low' },
  { key: 'lot_sf_max',       id: 'sales-size-high' },
  { key: 'street',           id: 'sales-street-name' },
  { key: 'far_flung_km',     id: 'far-flung-km' },
  { key: 'n1',               id: 'sales-n1-filter' },
]);

/** The multi-selects, in panel order. */
export const LIST_FIELDS = Object.freeze([
  { key: 'neighbourhoods', filter: 'cluster' },
  { key: 'categories',     filter: 'category' },
  { key: 'pucs',           filter: 'pucs' },
  { key: 'classes',        filter: 'class' },
  { key: 'zoning',         filter: 'zoning' },
]);

/** The two checkbox-backed pills, written as words rather than booleans
 *  so the file reads the way the control does. */
export const FLAG_FIELDS = Object.freeze([
  { key: 'nominal_sales', id: 'sales-hide-sentinels', on: 'exclude', off: 'include' },
  { key: 'far_flung',     id: 'far-flung-exclude',    on: 'exclude', off: 'keep' },
]);

/** Quote only when the value could be misread as a number, a bool or a
 *  list. A roll number MUST be quoted — 01003547800 unquoted is octal in
 *  some readers and loses its leading zero in all of them. */
function yamlScalar(v) {
  const s = String(v ?? '');
  if (s === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s)) return s;
  return JSON.stringify(s);
}

function unquote(s) {
  const t = String(s ?? '').trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    if (t[0] === '"') {
      try { return JSON.parse(t); } catch { return t.slice(1, -1); }
    }
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Render a criteria object to YAML.
 *
 * @param {object} c
 *   scalars: plain strings keyed by SCALAR_FIELDS.key ('' = unset)
 *   flags:   booleans keyed by FLAG_FIELDS.key
 *   lists:   per LIST_FIELDS.key, either null (no filter) or an array
 *            (possibly empty, meaning "none selected")
 *   meta:    { savedAt, note } — optional, comments only
 */
export function serializeCriteria(c = {}) {
  const scalars = c.scalars || {};
  const flags = c.flags || {};
  const lists = c.lists || {};
  const out = [];
  out.push('# Winnipeg Parcel Search — saved Sales Analysis search');
  if (c.meta?.savedAt) out.push(`# Saved ${c.meta.savedAt}`);
  out.push('# Load it back with "Load search" on the Sales Analysis tab.');
  out.push('# A key left out is treated as "no filter", so it is safe to');
  out.push('# delete lines you do not care about.');
  out.push(`version: ${CRITERIA_VERSION}`);
  out.push('');
  for (const f of SCALAR_FIELDS) {
    const v = yamlScalar(scalars[f.key]);
    out.push(`${f.key}:${v === '' ? '' : ` ${v}`}`);
  }
  for (const f of FLAG_FIELDS) {
    out.push(`${f.key}: ${flags[f.key] ? f.on : f.off}`);
  }
  out.push('');
  out.push('# Multi-selects: "all" = no filter, "none" = nothing selected,');
  out.push('# or a list of the values to keep.');
  for (const f of LIST_FIELDS) {
    const v = lists[f.key];
    if (v == null) { out.push(`${f.key}: all`); continue; }
    if (!v.length) { out.push(`${f.key}: none`); continue; }
    out.push(`${f.key}:`);
    for (const item of v) out.push(`  - ${yamlScalar(item) || '""'}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Parse a criteria file back into the same shape.
 *
 * Tolerant on purpose — this reads files people have edited. An
 * unrecognised key is collected into `unknown` rather than throwing, so a
 * file from a NEWER version loads what it can and says what it skipped.
 *
 * @returns {{scalars: object, flags: object, lists: object,
 *            version: number|null, unknown: string[]}}
 */
export function parseCriteria(text) {
  const scalarKeys = new Set(SCALAR_FIELDS.map((f) => f.key));
  const flagByKey = new Map(FLAG_FIELDS.map((f) => [f.key, f]));
  const listKeys = new Set(LIST_FIELDS.map((f) => f.key));
  const scalars = {};
  const flags = {};
  const lists = {};
  const unknown = [];
  let version = null;
  let listKey = null;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // A block-list item belongs to the key that opened the block.
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      const v = unquote(item[1]);
      if (v !== '') lists[listKey].push(v);
      continue;
    }

    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    listKey = null;
    const key = m[1];
    const rest = m[2].trim();

    if (key === 'version') { version = Number(rest) || null; continue; }

    if (listKeys.has(key)) {
      const low = rest.toLowerCase();
      if (rest === '' ) { lists[key] = []; listKey = key; continue; }
      if (low === 'all') { lists[key] = null; continue; }
      if (low === 'none' || rest === '[]') { lists[key] = []; continue; }
      // Inline flow list: [A, B]
      const flow = /^\[(.*)\]$/.exec(rest);
      if (flow) {
        lists[key] = flow[1].split(',').map((x) => unquote(x)).filter((x) => x !== '');
        continue;
      }
      // A bare scalar on a list key is the one-value case.
      lists[key] = [unquote(rest)];
      continue;
    }

    if (flagByKey.has(key)) {
      const f = flagByKey.get(key);
      flags[key] = rest.toLowerCase() === f.on;
      continue;
    }

    if (scalarKeys.has(key)) { scalars[key] = unquote(rest); continue; }
    unknown.push(key);
  }
  return { scalars, flags, lists, version, unknown };
}

/**
 * A one-line human summary of what a parsed file will do, for the status
 * bar after a load. Counts rather than lists — a search naming 40 PUCS
 * would otherwise take the whole line.
 */
export function describeCriteria(parsed) {
  const bits = [];
  const s = parsed?.scalars || {};
  if (s.sale_date_from || s.sale_date_to) {
    bits.push(`dates ${s.sale_date_from || '…'} → ${s.sale_date_to || '…'}`);
  }
  if (s.sales && s.sales !== 'all') bits.push(s.sales === 'vacant' ? 'vacant only' : 'improved only');
  if (s.subject_roll) bits.push(`subject ${s.subject_roll}${s.radius_km ? ` ≤ ${s.radius_km} km` : ''}`);
  for (const f of LIST_FIELDS) {
    const v = parsed?.lists?.[f.key];
    if (v == null) continue;
    bits.push(v.length ? `${v.length} ${f.key}` : `no ${f.key}`);
  }
  return bits.length ? bits.join(' · ') : 'no filters set';
}
