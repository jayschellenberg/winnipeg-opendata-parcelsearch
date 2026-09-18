/*
 * Driver for the "Import list" modal — the one shared by Property Search
 * and Sales Analysis.
 *
 * Three screens inside a single <dialog>:
 *   1. paste      textarea + file picker.
 *   2. resolving  a held frame while the lookups run.
 *   3. review     every row with what it matched, each one includable.
 *
 * WHY A REVIEW SCREEN AND NOT A COUNT. An address list is the kind of
 * input that is quietly wrong: a street that resolves to the wrong one,
 * a condo address that is really eight rolls, a typo that silently drops
 * a comp out of the set. Any of those changes an appraisal conclusion
 * and none of them announce themselves. So the resolution is always
 * shown before it is applied, with the row the user pasted beside the
 * address the City actually matched.
 *
 * ONE MODAL, TWO CALLERS. `open({ mode })` rewrites the title, the help
 * text and the confirm button, then hands the confirmed rolls to the
 * caller's onConfirm. The modal knows nothing about searching or about
 * sales; main.js owns both of those.
 *
 * DOM only — parsing lives in lib/parcelListParse.js and resolution in
 * lib/parcelListResolve.js, both of which are pure and unit tested.
 */

import { parseParcelList } from './parcelListParse.js';
import { resolveParcelList, collectRolls } from './parcelListResolve.js';

/**
 * Recent imports, cached in localStorage. Ported from the Manitoba
 * sister app: a comp list gets re-run far more often than it gets
 * written, usually because the user wants the same set back after
 * clearing a search, so the last few are worth keeping.
 *
 * Text is stored, not just the name. A file picked from disk cannot be
 * re-read without the user picking it again — the browser gives no
 * standing handle — so replaying the cached text is the only way a
 * "recent" entry can actually reload anything.
 *
 * Every read and write is wrapped: localStorage throws in private mode
 * and on quota, and a dead cache must degrade to "no recent imports"
 * rather than taking the modal down with it.
 */
const RECENT_STORAGE_KEY = 'wpgps_parcel_list_recent_v1';
const RECENT_CAP = 5;

function loadRecentImports() {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, RECENT_CAP) : [];
  } catch { return []; }
}

function saveRecentImports(list) {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_CAP)));
  } catch { /* quota / private mode — best effort, never fatal */ }
}

function rememberImport(name, text, kind = 'file') {
  if (!name || !text) return;
  // De-dup by name, newest first. Re-importing the same file refreshes
  // its cached text, which is what you want when the spreadsheet was
  // edited between sessions.
  const list = loadRecentImports().filter((e) => e.name !== name);
  list.unshift({ name, text, kind, ts: Date.now() });
  saveRecentImports(list);
}

/** A readable label for a paste with no file behind it: the first
 *  non-empty line, so several pastes stay tellable apart. */
export function synthesizePasteName(text, now = new Date()) {
  const firstLine = String(text || '').split(/\r\n|\r|\n/).find((l) => l.trim()) || '';
  const snippet = firstLine.replace(/\s+/g, ' ').trim().slice(0, 30);
  const stamp = `${now.toISOString().slice(5, 10)} ${now.toTimeString().slice(0, 5)}`;
  return snippet ? `Paste: ${snippet}… (${stamp})` : `Paste (${stamp})`;
}

/** Per-tab wording. The flow is identical; only the framing changes. */
const MODES = {
  property: {
    title: 'Import list',
    confirm: 'Map parcels',
    help: 'Paste one address per line, or drop in a CSV. Roll numbers work '
      + 'too, and the two can be mixed. "Winnipeg, MB" on the end of an '
      + 'address is fine, and extra columns are ignored — the address column '
      + 'is found for you. Every row is shown for review before anything is mapped.',
  },
  sales: {
    title: 'Import list — narrow sales to these properties',
    confirm: 'Filter sales',
    help: 'Paste one address per line, or drop in a CSV, to narrow the loaded '
      + 'sales to those properties. This selects WHICH parcels to show — sale '
      + 'prices and dates still come from the SABRE data you have loaded. Roll '
      + 'numbers work too, and extra columns are ignored.',
  },
};

/** Status → the word shown in the Matched column, and the row's class. */
const STATUS_LABEL = {
  resolved:    { text: 'Matched',     cls: 'ok' },
  multiple:    { text: 'Several',     cls: 'warn' },
  ambiguous:   { text: 'Ambiguous',   cls: 'warn' },
  notfound:    { text: 'No match',    cls: 'bad' },
  unparseable: { text: 'Not read',    cls: 'bad' },
};

/**
 * Wire up the modal.
 *
 * @param {Object} opts
 * @param {(payload: {
 *     mode: string, rolls: string[], rows: Array, stats: Object,
 *   }) => (void|Promise<void>)} opts.onConfirm - called with the distinct
 *   rolls of the rows the user left checked, in paste order. The modal
 *   closes itself first.
 * @param {Function} [opts.resolve] - injection seam for tests.
 * @returns {{ open: (o?: {mode?: string}) => void, close: () => void }}
 */
export function initParcelListImport({ onConfirm, resolve = resolveParcelList } = {}) {
  const $modal = document.getElementById('parcel-list-modal');
  if (!$modal) return { open: () => {}, close: () => {} };

  const $title    = document.getElementById('parcel-list-title');
  const $help     = document.getElementById('parcel-list-help');
  const $text     = document.getElementById('parcel-list-text');
  const $file     = document.getElementById('parcel-list-file');
  const $error    = document.getElementById('parcel-list-error');
  const $next     = document.getElementById('parcel-list-next');
  const $cancel   = document.getElementById('parcel-list-cancel');
  const $close    = document.getElementById('parcel-list-close');
  const $back     = document.getElementById('parcel-list-back');
  const $confirm  = document.getElementById('parcel-list-confirm');
  const $summary  = document.getElementById('parcel-list-summary');
  const $notices  = document.getElementById('parcel-list-notices');
  const $body     = document.getElementById('parcel-list-review-body');
  const $checkAll = document.getElementById('parcel-list-check-all');
  const $progress = document.getElementById('parcel-list-progress');
  const $reviewErr = document.getElementById('parcel-list-review-error');
  const $recentRow    = document.getElementById('parcel-list-recent-row');
  const $recentSelect = document.getElementById('parcel-list-recent-select');
  const $recentClear  = document.getElementById('parcel-list-recent-clear');
  const steps = {
    paste:     $modal.querySelector('[data-step="paste"]'),
    resolving: $modal.querySelector('[data-step="resolving"]'),
    review:    $modal.querySelector('[data-step="review"]'),
  };

  // Per-session state, reset on every open() so a previous run cannot
  // leak into the next one.
  let mode = 'property';
  let resolved = [];            // rows, post-resolution
  let included = new Set();     // indices of rows the user left checked
  // How the current text arrived — a file name, a recent entry's label,
  // or '' for a raw paste (which gets a synthesized label on success).
  let sourceName = '';
  // 'file' or 'paste' — which label form the entry gets in the recent
  // dropdown. Carried through a replay so re-confirming a recent PASTE
  // does not start labelling it as a file.
  let sourceKind = 'paste';
  // Guards a resolution against a modal the user has already closed and
  // reopened — the late result must not repaint the new session.
  let runToken = 0;

  function setStep(step) {
    for (const [name, el] of Object.entries(steps)) {
      if (el) el.hidden = name !== step;
    }
  }

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  }

  function open({ mode: nextMode = 'property' } = {}) {
    mode = MODES[nextMode] ? nextMode : 'property';
    const copy = MODES[mode];
    if ($title) $title.textContent = copy.title;
    if ($help) $help.textContent = copy.help;
    if ($confirm) $confirm.textContent = copy.confirm;
    resolved = [];
    included = new Set();
    lastStats = null;
    sourceName = '';
    sourceKind = 'paste';
    runToken += 1;
    if ($text) $text.value = '';
    if ($file) $file.value = '';
    if ($body) $body.textContent = '';
    showError($error, '');
    showError($reviewErr, '');
    populateRecentDropdown();
    setStep('paste');
    try { $modal.showModal(); } catch { $modal.setAttribute('open', ''); }
    requestAnimationFrame(() => $text?.focus());
  }

  function close() {
    // Invalidate any in-flight resolution: its result belongs to a
    // session that no longer exists.
    runToken += 1;
    try { $modal.close(); } catch { $modal.removeAttribute('open'); }
  }

  // ---- step 1 → 2 → 3 ---------------------------------------------

  async function lookUp() {
    showError($error, '');
    const text = String($text?.value || '');
    if (!text.trim()) {
      showError($error, 'Paste a list or choose a file first.');
      return;
    }
    const parsed = parseParcelList(text);
    if (!parsed.rows.length) {
      showError($error, 'Nothing in that text looked like an address or a roll number.');
      return;
    }
    if (!parsed.counts.address && !parsed.counts.roll) {
      showError($error,
        `Read ${parsed.counts.total} row${parsed.counts.total === 1 ? '' : 's'}, but none of `
        + 'them looked like a Winnipeg address or roll number. An address needs a civic '
        + 'number and a street name, e.g. "330 Selkirk Ave".');
      return;
    }
    const token = ++runToken;
    setStep('resolving');
    if ($progress) {
      const n = parsed.counts.total;
      $progress.textContent = `Looking up ${n} row${n === 1 ? '' : 's'}…`;
    }
    let out;
    try {
      out = await resolve(parsed.rows);
    } catch (err) {
      if (token !== runToken) return;
      console.error('parcel list resolution failed', err);
      setStep('paste');
      showError($error, `Lookup failed: ${err?.message || err}`);
      return;
    }
    if (token !== runToken) return;
    resolved = out.rows;
    // Everything that matched something starts checked; rows with no
    // match have nothing to contribute and start unchecked.
    included = new Set(
      resolved.map((r, i) => (r.matches?.length ? i : -1)).filter((i) => i >= 0)
    );
    renderReview(out);
    setStep('review');
  }

  // ---- review screen ----------------------------------------------

  function renderReview(out) {
    const { stats, notices } = out;
    if ($notices) {
      $notices.textContent = '';
      for (const n of notices || []) {
        const p = document.createElement('p');
        p.textContent = n;
        $notices.appendChild(p);
      }
      $notices.hidden = !(notices || []).length;
    }
    if ($body) {
      $body.textContent = '';
      resolved.forEach((row, i) => $body.appendChild(reviewRow(row, i)));
    }
    syncCheckAll();
    refreshSummary(stats);
  }

  function reviewRow(row, index) {
    const tr = document.createElement('tr');
    const meta = STATUS_LABEL[row.status] || STATUS_LABEL.notfound;
    tr.className = `parcel-list-row is-${meta.cls}`;

    const tdCheck = document.createElement('td');
    tdCheck.className = 'parcel-list-col-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = included.has(index);
    box.disabled = !row.matches?.length;
    box.setAttribute('aria-label', `Include ${row.raw}`);
    box.addEventListener('change', () => {
      if (box.checked) included.add(index); else included.delete(index);
      syncCheckAll();
      refreshSummary();
    });
    tdCheck.appendChild(box);
    tr.appendChild(tdCheck);

    const tdLine = document.createElement('td');
    tdLine.className = 'parcel-list-col-line';
    tdLine.textContent = String(row.lineNo);
    tr.appendChild(tdLine);

    // The CELL the importer actually read, not the whole line. Showing
    // the whole line here made a spreadsheet's leading index column
    // ("Comp") sit against the address and read as though the two had
    // been merged — the one thing this screen exists to rule out. The
    // full row stays on the tooltip for context. textContent throughout:
    // every string on this screen came off a clipboard.
    const tdRaw = document.createElement('td');
    tdRaw.className = 'parcel-list-col-raw';
    tdRaw.textContent = row.cell || row.raw;
    tdRaw.title = row.raw;
    tr.appendChild(tdRaw);

    // What it matched. For an address that resolved, this is the City's
    // own address text — which is how a wrong-street match becomes
    // visible rather than silent.
    const tdMatch = document.createElement('td');
    tdMatch.className = 'parcel-list-col-match';
    const badge = document.createElement('span');
    badge.className = `parcel-list-badge is-${meta.cls}`;
    badge.textContent = meta.text;
    tdMatch.appendChild(badge);
    const detail = document.createElement('span');
    detail.className = 'parcel-list-detail';
    if (row.matches?.length) {
      const addrs = row.matches.map((m) => m.address).filter(Boolean);
      detail.textContent = addrs.length ? addrs.join(', ') : '';
      if (row.status === 'multiple') {
        detail.textContent = `${row.matches.length} parcels — ${detail.textContent}`;
      }
      if (row.via === 'civic') {
        detail.textContent += ' (matched via civic-address dataset)';
      }
    } else if (row.status === 'unparseable') {
      detail.textContent = 'No civic number and street name found in this row.';
    } else {
      detail.textContent = row.interpreted
        ? `Looked for ${row.interpreted} — nothing on the assessment roll.`
        : 'Nothing on the assessment roll.';
    }
    detail.title = detail.textContent;
    tdMatch.appendChild(detail);
    tr.appendChild(tdMatch);

    const tdRoll = document.createElement('td');
    tdRoll.className = 'parcel-list-col-roll';
    tdRoll.textContent = (row.matches || []).map((m) => m.roll).join(', ');
    tdRoll.title = tdRoll.textContent;
    tr.appendChild(tdRoll);

    return tr;
  }

  /** The header checkbox reflects the rows it can actually control. */
  function syncCheckAll() {
    if (!$checkAll) return;
    const selectable = resolved
      .map((r, i) => (r.matches?.length ? i : -1))
      .filter((i) => i >= 0);
    const on = selectable.filter((i) => included.has(i)).length;
    $checkAll.checked = selectable.length > 0 && on === selectable.length;
    $checkAll.indeterminate = on > 0 && on < selectable.length;
    $checkAll.disabled = selectable.length === 0;
  }

  /** `stats` is passed only on the first paint; later calls are checkbox
   *  changes, which move the parcel count but not the resolution tallies,
   *  so the last stats line is remembered rather than recomputed. */
  let lastStats = null;

  function refreshSummary(stats = null) {
    if (stats) lastStats = stats;
    const rolls = currentRolls();
    const n = resolved.length;
    if ($summary) {
      const parts = [`${n} row${n === 1 ? '' : 's'} read.`];
      if (lastStats) {
        const bad = lastStats.notfound + lastStats.unparseable;
        if (bad) parts.push(`${bad} could not be matched.`);
        if (lastStats.ambiguous) parts.push(`${lastStats.ambiguous} matched more than one street.`);
        if (lastStats.multiple) parts.push(`${lastStats.multiple} matched several parcels.`);
      }
      if (!rolls.length) {
        parts.push('Nothing is selected.');
      } else {
        const label = `${rolls.length} parcel${rolls.length === 1 ? '' : 's'}`;
        parts.push(mode === 'sales'
          ? `Sales will be narrowed to ${label}.`
          : `${label} will be mapped.`);
      }
      $summary.textContent = parts.join(' ');
    }
    if ($confirm) {
      $confirm.disabled = rolls.length === 0;
      const copy = MODES[mode] || MODES.property;
      $confirm.textContent = rolls.length ? `${copy.confirm} (${rolls.length})` : copy.confirm;
    }
  }

  /** Distinct rolls of the checked rows, in paste order. Indices are
   *  resolved up front so this stays linear as the list grows. */
  function currentRolls() {
    const picked = resolved.filter((_, i) => included.has(i));
    return collectRolls(picked);
  }

  // ---- recent imports ----------------------------------------------

  function populateRecentDropdown() {
    if (!$recentSelect || !$recentRow) return;
    const list = loadRecentImports();
    $recentSelect.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = list.length ? 'Pick a recent import…' : '—';
    $recentSelect.appendChild(blank);
    for (const e of list) {
      const opt = document.createElement('option');
      opt.value = e.name;
      // textContent, not innerHTML: the label is built from the first
      // line of something the user pasted off a clipboard.
      // A file name says nothing about when it was imported, so it gets
      // the date. A synthesized paste label already carries its own
      // timestamp — that stamp is what tells two same-day pastes of the
      // same list apart — so appending the date again just reads as
      // "(09-18 12:40) (2026-09-18)".
      const dt = new Date(e.ts || 0);
      const ts = Number.isFinite(dt.valueOf()) ? dt.toISOString().slice(0, 10) : '';
      opt.textContent = (ts && e.kind !== 'paste') ? `${e.name} (${ts})` : e.name;
      $recentSelect.appendChild(opt);
    }
    $recentRow.hidden = list.length === 0;
  }

  // ---- events ------------------------------------------------------

  $recentSelect?.addEventListener('change', () => {
    const name = $recentSelect.value;
    $recentSelect.value = '';
    if (!name) return;
    const entry = loadRecentImports().find((e) => e.name === name);
    if (!entry || !$text) return;
    $text.value = entry.text;
    sourceName = entry.name;
    sourceKind = entry.kind === 'paste' ? 'paste' : 'file';
    // Straight to the lookup: the user picked a list that already
    // resolved once, so making them press the button again buys nothing.
    // The review screen still stands between this and the map.
    lookUp();
  });

  $recentClear?.addEventListener('click', () => {
    try { localStorage.removeItem(RECENT_STORAGE_KEY); } catch { /* ignore */ }
    populateRecentDropdown();
  });

  $next?.addEventListener('click', lookUp);
  $cancel?.addEventListener('click', close);
  $close?.addEventListener('click', close);
  $back?.addEventListener('click', () => { showError($reviewErr, ''); setStep('paste'); });

  $checkAll?.addEventListener('change', () => {
    const on = $checkAll.checked;
    included = new Set();
    if (on) {
      resolved.forEach((r, i) => { if (r.matches?.length) included.add(i); });
    }
    if ($body) {
      $body.querySelectorAll('input[type="checkbox"]').forEach((box, i) => {
        if (!box.disabled) box.checked = included.has(i);
      });
    }
    syncCheckAll();
    refreshSummary();
  });

  $file?.addEventListener('change', async () => {
    const file = $file.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      if ($text) $text.value = text;
      sourceName = file.name || '';
      sourceKind = 'file';
      showError($error, '');
    } catch (err) {
      showError($error, `Could not read that file: ${err?.message || err}`);
    }
  });

  // Ctrl/Cmd+Enter from the textarea runs the lookup, so a paste-and-go
  // never needs the mouse.
  $text?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); lookUp(); }
  });

  $confirm?.addEventListener('click', async () => {
    const rolls = currentRolls();
    if (!rolls.length) return;
    showError($reviewErr, '');
    // Remember on CONFIRM, not on lookup: reaching this point is the
    // user saying the list was the one they wanted.
    rememberImport(
      sourceName || synthesizePasteName($text?.value),
      $text?.value,
      sourceKind,
    );
    // Close BEFORE handing off: the caller repaints the map and grid, and
    // doing that behind a modal the user has to dismiss reads as a hang.
    const payload = {
      mode,
      rolls,
      rows: resolved.filter((r, i) => included.has(i)),
      stats: {
        rows: resolved.length,
        selected: included.size,
        parcels: rolls.length,
      },
    };
    close();
    try {
      await onConfirm?.(payload);
    } catch (err) {
      console.error('import list handler failed', err);
    }
  });

  return { open, close };
}
