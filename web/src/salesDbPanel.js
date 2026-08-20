/*
 * The SABRE Sales Database panel on the Sales Analysis tab.
 *
 * A thin DOM driver over lib/salesStore.js (IndexedDB + directory
 * handle) and lib/salesDbMerge.js (pure merge). The one integration
 * seam with the rest of the app is onLoad({ name, text }) — the same
 * contract handleSalesUpload() already accepts from a file drop, so the
 * database is just another way to hand the existing pipeline a CSV.
 *
 * Ported from the Manitoba site's salesDbPanel minus the municipality
 * machinery (Winnipeg is one municipality; the unit here is the export
 * FILE). One behavioural difference from MB, on purpose: Search always
 * merges the whole archive — the Sale-date range narrows what SHOWS,
 * live, via the existing pre-join date filter, so there is no stale
 * date-window state to nag about. The only nag is "files changed on
 * disk — Reload".
 *
 * SABRE is subscriber data: everything stays in this browser. See the
 * privacy header in lib/salesStore.js.
 */

import {
  salesDbAvailable, requestPersistence, fsAccessSupported,
  pickSalesDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates,
  clearSales, listFiles, buildMergedCsv, describeImport,
} from './lib/salesStore.js';
import { dateLabel } from './lib/dataStatus.js';

const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');

export function initSalesDbPanel({ onLoad, setStatus, getDateWindow } = {}) {
  const $panel = document.getElementById('sales-db');
  if (!$panel || !salesDbAvailable()) return { refresh: () => {} };

  const $status = document.getElementById('sales-db-status');
  const $empty = document.getElementById('sales-db-empty');
  const $ready = document.getElementById('sales-db-ready');
  const $import = document.getElementById('sales-db-import');
  const $folderInput = document.getElementById('sales-db-folder-input');
  const $load = document.getElementById('sales-db-load');
  const $refresh = document.getElementById('sales-db-refresh');
  const $forget = document.getElementById('sales-db-forget');
  const $coverage = document.getElementById('sales-db-coverage');
  const $update = document.getElementById('sales-db-update');
  const $daterangeHint = document.getElementById('sales-db-daterange-hint');
  const $coverageModal = document.getElementById('sales-db-coverage-modal');
  const $coverageClose = document.getElementById('sales-db-coverage-close');
  const $coverageSummary = document.getElementById('sales-db-coverage-summary');
  const $coverageRows = document.getElementById('sales-db-coverage-rows');

  const say = (msg) => { try { setStatus?.(msg); } catch { /* status line is best-effort */ } };

  // Open/collapse steering is a DEFAULT, not a lockout: once the user
  // works the disclosure themselves, stop driving it. `steering` marks
  // our own programmatic toggles so they don't count as the user's.
  let manualTouched = false;
  let steering = false;
  $panel.addEventListener('toggle', () => { if (!steering) manualTouched = true; });
  function steerOpen(open) {
    if (manualTouched) return;
    steering = true;
    $panel.open = open;
    steering = false;
  }

  function setUpdateNote(msg, { stale = false } = {}) {
    if (!$update) return;
    $update.textContent = msg || '';
    $update.classList.toggle('is-stale', !!stale);
    $update.hidden = !msg;
  }

  async function render() {
    const info = await describeImport().catch(() => ({ present: false }));
    const connected = info.present;
    if ($empty) $empty.hidden = connected;
    if ($ready) $ready.hidden = !connected;
    if ($status) {
      $status.textContent = connected
        ? `${fmtN(info.files)} file${info.files === 1 ? '' : 's'} · ${fmtN(info.rows)} rows`
        : 'Not connected';
    }
    if (connected && $daterangeHint) {
      const win = getDateWindow?.() || {};
      $daterangeHint.hidden = !!(win.from || win.to);
    }
    steerOpen(connected);
    return info;
  }

  async function runImport(work, busyLabel) {
    setUpdateNote('');
    say(busyLabel);
    try {
      const summary = await work();
      await requestPersistence();   // after a successful import, when browsers actually grant it
      await render();
      const bits = [`${fmtN(summary.imported)} imported`];
      if (summary.skipped) bits.push(`${fmtN(summary.skipped)} unchanged`);
      if (summary.ignored) bits.push(`${fmtN(summary.ignored)} non-SABRE file${summary.ignored === 1 ? '' : 's'} ignored`);
      say(`SABRE database: ${bits.join(', ')} — ${fmtN(summary.rows)} rows on hand.`);
      return summary;
    } catch (err) {
      if (err?.name === 'AbortError') { say('Folder pick cancelled.'); return null; }
      say(`SABRE import failed: ${err?.message || err}`);
      return null;
    }
  }

  // --- Connect -------------------------------------------------------------
  $import?.addEventListener('click', () => {
    if (fsAccessSupported()) {
      runImport(async () => {
        const handle = await pickSalesDirectory();
        return importFromDirectory(handle);
      }, 'Reading the export folder…');
    } else {
      $folderInput?.click();
    }
  });
  $folderInput?.addEventListener('change', () => {
    if (!$folderInput.files?.length) return;
    runImport(() => importFromFileList($folderInput.files), 'Reading the selected files…');
    $folderInput.value = '';
  });

  // --- Search --------------------------------------------------------------
  $load?.addEventListener('click', async () => {
    const win = getDateWindow?.() || {};
    if (!win.from && !win.to) {
      // The whole archive means a live-parcel fetch for every roll in it.
      // A date range set below trims that BEFORE the network (the sales
      // pre-join filters), so nudge once rather than silently grind.
      const go = window.confirm(
        'No Sale date range is set, so the whole archive will load and '
        + 'every sale’s parcel will be fetched. Load it all?'
      );
      if (!go) return;
    }
    say('Merging the SABRE exports…');
    let payload;
    try {
      payload = await buildMergedCsv();
    } catch (err) {
      say(`SABRE merge failed: ${err?.message || err}`);
      return;
    }
    if (!payload) { say('Nothing imported yet — connect the export folder first.'); return; }
    setUpdateNote(
      payload.duplicatesDropped
        ? `Merged ${fmtN(payload.salesAvailable)} rows; ${fmtN(payload.duplicatesDropped)} duplicate row${payload.duplicatesDropped === 1 ? '' : 's'} from overlapping exports dropped.`
        : `Merged ${fmtN(payload.sales)} rows from the archive.`
    );
    await onLoad?.({ name: payload.name, text: payload.text });
  });

  // --- Reload --------------------------------------------------------------
  $refresh?.addEventListener('click', async () => {
    const handle = await getSavedDirectory().catch(() => null);
    if (!handle) {
      // Fallback-imported archive has no handle to re-read — re-pick.
      if (fsAccessSupported()) $import?.click();
      else $folderInput?.click();
      return;
    }
    const perm = await directoryPermission(handle, { request: true });
    if (perm !== 'granted') { say('Folder access not granted — Reload needs permission to re-read the exports.'); return; }
    // force: a manual Reload should be certain, not clever — re-read
    // everything rather than trust mtimes (files are small).
    runImport(() => importFromDirectory(handle, { force: true }), 'Re-reading the export folder…');
  });

  // --- Disconnect ------------------------------------------------------------
  $forget?.addEventListener('click', async () => {
    const go = window.confirm(
      'Disconnect the SABRE sales database from this browser? The export '
      + 'folder on disk is untouched — reconnecting re-imports it.'
    );
    if (!go) return;
    await clearSales().catch(() => {});
    manualTouched = false;   // fresh start may steer again
    setUpdateNote('');
    await render();
    say('SABRE database disconnected.');
  });

  // --- Coverage ----------------------------------------------------------
  $coverage?.addEventListener('click', async () => {
    if (!$coverageModal) return;
    const [files, info] = await Promise.all([listFiles(), describeImport()]);
    if ($coverageSummary) {
      $coverageSummary.textContent = info.present
        ? `${fmtN(info.files)} file${info.files === 1 ? '' : 's'} · ${fmtN(info.rows)} rows · sales ${info.minSaleDate ? dateLabel(info.minSaleDate) : '—'} → ${info.maxSaleDate ? dateLabel(info.maxSaleDate) : '—'}`
        : 'Nothing imported yet.';
    }
    if ($coverageRows) {
      $coverageRows.textContent = '';
      for (const f of files) {
        const tr = document.createElement('tr');
        const cells = [
          f.name,
          fmtN(f.meta.rows),
          f.meta.minSaleDate || f.meta.maxSaleDate
            ? `${f.meta.minSaleDate ? dateLabel(f.meta.minSaleDate) : '—'} → ${f.meta.maxSaleDate ? dateLabel(f.meta.maxSaleDate) : '—'}`
            : '—',
          f.meta.source_mtime ? new Date(f.meta.source_mtime).toLocaleDateString('en-CA') : '—',
          f.meta.imported_at ? new Date(f.meta.imported_at).toLocaleDateString('en-CA') : '—',
        ];
        for (const c of cells) {
          const td = document.createElement('td');
          td.textContent = String(c);
          tr.appendChild(td);
        }
        $coverageRows.appendChild(tr);
      }
    }
    $coverageModal.showModal();
  });
  $coverageClose?.addEventListener('click', () => $coverageModal?.close());

  // --- The date-range hint tracks the pickers ------------------------------
  for (const id of ['sales-date-from', 'sales-date-to']) {
    document.getElementById(id)?.addEventListener('change', () => {
      if ($daterangeHint && !$ready?.hidden) {
        const win = getDateWindow?.() || {};
        $daterangeHint.hidden = !!(win.from || win.to);
      }
    });
  }

  // --- Init: render, then quietly check the folder for newer files ---------
  (async () => {
    const info = await render();
    if (!info.present) return;
    const handle = await getSavedDirectory().catch(() => null);
    if (!handle) return;
    // No permission REQUEST here — that needs a user gesture. 'granted'
    // survives within a session; 'prompt' just means the check stays quiet.
    const updates = await checkForUpdates(handle);
    if (updates?.count) {
      setUpdateNote(
        `${fmtN(updates.count)} file${updates.count === 1 ? '' : 's'} changed on disk — hit 🔄 Reload to pick up the new data.`,
        { stale: true },
      );
    }
  })();

  return { refresh: render };
}
