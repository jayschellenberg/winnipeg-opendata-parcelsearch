/*
 * Driver for the "Paste sales data" modal on the Sales Analysis tab.
 * Ported from the Manitoba sister app (web/src/lib/salesPasteImport.js).
 *
 * Single-screen flow inside a <dialog>: a textarea + file picker, and a
 * Load button. There is no column-mapping step — the sales schema is
 * fixed, so lib/salesImport.js auto-detects the header aliases and the
 * delimiter (tab for spreadsheet / SABRE copy-paste, comma for a real
 * CSV). On Load the driver hands { name, text } to the injected
 * onSubmit callback, which main.js wires straight into
 * handleSalesUpload — the exact same pipeline the dropzone uses, so
 * paste and file uploads stay identical downstream (including the
 * Recent-uploads cache).
 */

/**
 * Wire up the modal. Returns { open, close } so callers can drive it
 * programmatically (the "Paste data…" button on the Sales tab).
 *
 * @param {Object} opts
 * @param {(payload: { name: string, text: string }) => (void|Promise<void>)}
 *   opts.onSubmit - called when the user clicks Load with non-empty
 *   text. The modal closes itself before invoking this. `name` is the
 *   file name (when a file was chosen) or a synthesized paste label so
 *   the entry reads sensibly in the Recent-uploads dropdown.
 */
export function initSalesPasteImport({ onSubmit } = {}) {
  const $modal = document.getElementById('sales-import-modal');
  if (!$modal) return { open: () => {}, close: () => {} };

  const $textarea = document.getElementById('sales-import-text');
  const $file     = document.getElementById('sales-import-file');
  const $cancel   = document.getElementById('sales-import-cancel');
  const $close    = document.getElementById('sales-import-close');
  const $load     = document.getElementById('sales-import-load');
  const $error    = document.getElementById('sales-import-error');

  // Tracks how the current text was obtained (file name, or '' for a
  // raw paste) so Load can label the Recent-uploads entry. Reset on
  // every open() so a previous file pick doesn't leak across sessions.
  let sourceName = '';

  function open() {
    sourceName = '';
    if ($textarea) $textarea.value = '';
    if ($file) $file.value = '';
    if ($error) $error.hidden = true;
    try { $modal.showModal(); } catch { $modal.setAttribute('open', ''); }
    requestAnimationFrame(() => $textarea?.focus());
  }

  function close() {
    try { $modal.close(); } catch { $modal.removeAttribute('open'); }
  }

  function showError(msg) {
    if (!$error) return;
    $error.textContent = msg;
    $error.hidden = false;
  }

  async function handleFile(file) {
    if (!file || !$textarea) return;
    try {
      $textarea.value = await file.text();
      sourceName = file.name || '';
      if ($error) $error.hidden = true;
      $textarea.focus();
    } catch (err) {
      console.warn('Sales file read failed:', err);
      showError('Could not read that file. Try pasting the rows instead.');
    }
  }

  async function load() {
    const text = ($textarea?.value || '').trim();
    if (!text) {
      showError('Paste some rows or choose a file first.');
      return;
    }
    const name = sourceName || synthesizePasteName($textarea?.value);
    close();
    if (typeof onSubmit === 'function') {
      try { await onSubmit({ name, text }); }
      catch (err) { console.error('Sales paste load failed', err); }
    }
  }

  $load?.addEventListener('click', load);
  $cancel?.addEventListener('click', close);
  $close?.addEventListener('click', close);
  $file?.addEventListener('change', () => {
    const f = $file.files?.[0];
    if (f) handleFile(f);
  });
  // <dialog> emits 'cancel' on Esc — close cleanly instead of the
  // default dismiss so focus restoration matches the button paths.
  $modal.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  return { open, close };
}

/** Friendly label for a pasted (no-file) load — the first non-empty
 *  line's leading chars plus a timestamp, so pastes are distinguishable
 *  in the Recent-uploads dropdown. */
function synthesizePasteName(text) {
  if (!text) return 'Pasted sales';
  const firstLine = String(text).split(/\r\n|\r|\n/).find((l) => l.trim()) || '';
  const snippet = firstLine.replace(/\s+/g, ' ').trim().slice(0, 30);
  const dt = new Date();
  const stamp = `${dt.toISOString().slice(5, 10)} ${dt.toTimeString().slice(0, 5)}`;
  return snippet ? `Paste: ${snippet}… (${stamp})` : `Paste (${stamp})`;
}
