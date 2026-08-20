/*
 * salesStore.js — the SABRE sales database, held locally in the browser.
 *
 * WHAT THIS IS. The Sales Analysis tab can use an accumulated archive of
 * SABRE "SoldPropertyListing" CSV exports as its source instead of
 * dropping one file at a time. SABRE is subscriber data, so it is NEVER
 * hosted: the site ships none of it, the server never sees it, nothing
 * is uploaded. The user nominates a folder on their own disk once; we
 * read it locally and keep it in IndexedDB. A visitor without that
 * folder simply has no sales database — the gate is absence, not a
 * password. (Ported from the Manitoba site's MAO salesStore; same
 * privacy stance, different export shape.)
 *
 * WHY A SEPARATE DATABASE from the soda.js cache. 'wpsCache' caches
 * regenerable fetches, with TTLs and sweeps. An imported archive is
 * USER DATA — losing it means re-pulling exports from SABRE 500 records
 * at a time — so it lives in its own database, no TTL, never swept.
 *
 * WHY PER-FILE RECORDS. The Manitoba archive is one shard per
 * municipality; Winnipeg is one municipality and the natural unit is
 * the export file (a manual pull capped near 500 records). Per-file
 * records keep the mtime-skip cheap and make the Coverage table — which
 * file covers which sale-date span — fall straight out of the store.
 *
 * WHY RAW TEXT, PARSED ON DEMAND. buildMergedCsv() hands one merged CSV
 * to the exact pipeline a file drop uses (handleSalesUpload), so there
 * is one parser, not two. The whole archive is small (files are ≤500
 * records), so merging outright costs nothing.
 *
 * WHY A DIRECTORY HANDLE. With the File System Access API the browser
 * keeps a handle to the nominated folder: drop a new export in Dropbox
 * and the next visit notices and re-imports it without re-picking
 * anything. Chrome/Edge only; Firefox/Safari fall back to a manual
 * <input webkitdirectory> pick, which works minus the auto-refresh.
 */

import { analyzeSalesCsv, mergeSalesFiles } from './salesDbMerge.js';
import { SALES_REQUIRED_COLS } from './salesImport.js';
import { isMlsHeader } from './mlsImport.js';

const DB_NAME = 'wpg-parcel-sales';
const DB_VERSION = 1;
const FILES = 'files';   // key: file name -> { name, csv, meta }
const META  = 'meta';    // key: 'dirHandle' | 'importState' | 'summary'

let dbPromise = null;

export function salesDbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  if (!salesDbAvailable()) return Promise.reject(new Error('IndexedDB not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (!db.objectStoreNames.contains(META))  db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error('sales DB open failed'));
    req.onblocked = () => reject(new Error('sales DB open blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(storeName, mode, op) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let out;
    Promise.resolve(op(store)).then((r) => { out = r; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror    = () => reject(t.error || new Error('sales tx error'));
    t.onabort    = () => reject(t.error || new Error('sales tx aborted'));
  }));
}

const req2promise = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror   = () => rej(r.error);
});

// ---------------------------------------------------------------------------
// Primitive accessors
// ---------------------------------------------------------------------------
export const getMeta = (k)    => tx(META, 'readonly',  (s) => req2promise(s.get(k)));
export const putMeta = (k, v) => tx(META, 'readwrite', (s) => req2promise(s.put(v, k)));

const getFileRec    = (name) => tx(FILES, 'readonly',  (s) => req2promise(s.get(String(name))));
const putFileRec    = (rec)  => tx(FILES, 'readwrite', (s) => req2promise(s.put(rec, String(rec.name))));
const deleteFileRec = (name) => tx(FILES, 'readwrite', (s) => req2promise(s.delete(String(name))));
const listFileKeys  = ()     => tx(FILES, 'readonly',  (s) => req2promise(s.getAllKeys()));
const listFileRecs  = ()     => tx(FILES, 'readonly',  (s) => req2promise(s.getAll()));

/** Wipe the whole database. The folder on disk is untouched. */
export function clearSales() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([FILES, META], 'readwrite');
    t.objectStore(FILES).clear();
    t.objectStore(META).clear();
    t.oncomplete = () => resolve(true);
    t.onerror    = () => reject(t.error);
  }));
}

// ---------------------------------------------------------------------------
// Durable storage
// ---------------------------------------------------------------------------
// Without this the browser may evict the archive under disk pressure and the
// user silently loses their source. Chrome usually grants persistence quietly
// for a site the user has engaged with; refusal is not fatal.
export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return { supported: false };
    const already = await navigator.storage.persisted();
    if (already) return { supported: true, persisted: true };
    const granted = await navigator.storage.persist();
    return { supported: true, persisted: granted };
  } catch { return { supported: false }; }
}

// ---------------------------------------------------------------------------
// File System Access — the auto-refresh path
// ---------------------------------------------------------------------------
export function fsAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Ask the user to nominate the export folder. Requires a user gesture. */
export async function pickSalesDirectory() {
  if (!fsAccessSupported()) throw new Error('File System Access not supported in this browser');
  const handle = await window.showDirectoryPicker({ id: 'wpg-sabre-sales', mode: 'read' });
  await putMeta('dirHandle', handle);   // handles are structured-cloneable
  return handle;
}

export const getSavedDirectory = () => getMeta('dirHandle');

/**
 * Permission state for a saved handle: 'granted' | 'prompt' | 'denied' |
 * 'none'. Chrome deliberately drops a handle back to 'prompt' between
 * sessions, so the caller re-grants with one click — the user never
 * re-picks the folder.
 */
export async function directoryPermission(handle, { request = false } = {}) {
  if (!handle) return 'none';
  try {
    const opts = { mode: 'read' };
    let state = await handle.queryPermission(opts);
    if (state === 'prompt' && request) state = await handle.requestPermission(opts);
    return state;
  } catch { return 'denied'; }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
// Any *.csv is a candidate; whether it actually IS a SABRE export is
// decided by its header (all four required sales columns present), not
// its name — Jason renames pulls, and a name-gate would silently ignore
// them. Non-sales CSVs that stray into the folder are skipped and
// counted, never imported.
const CSV_FILE_RE = /\.csv$/i;

// Bump when analyzeSalesCsv's meaning changes (row-count rule, date
// normalization…), so already-imported files get re-analyzed on the next
// import instead of carrying a stale meta until their mtime changes.
const ANALYZE_VERSION = 1;

/**
 * Is this CSV a sales export we can read — SABRE or MLS?
 *
 * Decided by the HEADER, not the filename: Jason renames pulls, and a
 * name-gate would silently ignore them. A stray CSV that is neither is
 * counted and skipped rather than imported as junk.
 */
function isSalesHeader(analysis) {
  if (isMlsHeader(analysis.headerCells)) return true;
  const have = new Set(analysis.headerCells.map((h) => h.toLowerCase()));
  return SALES_REQUIRED_COLS.every((c) => have.has(c.toLowerCase()));
}

function metaFor(analysis, file) {
  return {
    rows: analysis.dataRowCount,
    minSaleDate: analysis.minSaleDate,
    maxSaleDate: analysis.maxSaleDate,
    bytes: file.size,
    source_mtime: file.lastModified,
    imported_at: Date.now(),
  };
}

async function finishImport({ files, imported, skipped, ignored, rows, mtimes, hasHandle }) {
  const summary = {
    files, imported, skipped, ignored, rows,
    imported_at: new Date().toISOString(),
    no_handle: !hasHandle || undefined,
  };
  await putMeta('summary', summary);
  await putMeta('importState', { mtimes, analyzeVersion: ANALYZE_VERSION });
  return summary;
}

/**
 * Read the export folder into IndexedDB.
 *
 * Skips files whose mtime hasn't changed since last import (a new pull
 * dropped into the folder re-reads one file, not forty) and prunes
 * records whose source file is gone — the folder is the truth, so a
 * pull Jason deletes as bad must not linger in the merge.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {{onProgress?: (p:{done:number,total:number,label:string})=>void,
 *          force?: boolean}} [opts]
 */
export async function importFromDirectory(dirHandle, { onProgress, force = false } = {}) {
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    if (CSV_FILE_RE.test(name)) entries.push({ name, handle });
  }
  if (!entries.length) {
    throw new Error('No .csv files found in that folder. Pick the folder holding the SoldPropertyListing exports.');
  }

  const prev = (await getMeta('importState')) || { mtimes: {} };
  const reanalyze = prev.analyzeVersion !== ANALYZE_VERSION;
  const mtimes = {};
  let imported = 0, skipped = 0, ignored = 0, rows = 0;

  for (let i = 0; i < entries.length; i++) {
    const { name, handle } = entries[i];
    onProgress?.({ done: i, total: entries.length, label: name });
    const file = await handle.getFile();

    if (!force && !reanalyze && prev.mtimes[name] === file.lastModified) {
      const existing = await getFileRec(name);
      if (existing) {
        skipped++;
        rows += existing.meta?.rows || 0;
        mtimes[name] = file.lastModified;
        continue;
      }
    }

    const csv = await file.text();
    const analysis = analyzeSalesCsv(csv);
    if (!isSalesHeader(analysis)) { ignored++; continue; }
    await putFileRec({ name, csv, meta: metaFor(analysis, file) });
    mtimes[name] = file.lastModified;
    imported++;
    rows += analysis.dataRowCount;
  }

  // Prune records whose source file no longer exists in the folder.
  const present = new Set(Object.keys(mtimes));
  for (const key of await listFileKeys()) {
    if (!present.has(String(key))) await deleteFileRec(key);
  }

  onProgress?.({ done: entries.length, total: entries.length, label: 'done' });
  return finishImport({
    files: present.size, imported, skipped, ignored, rows, mtimes, hasHandle: true,
  });
}

/**
 * Has the folder changed since the last import? Cheap — stats files,
 * reads none. Returns null when we cannot tell (no handle, permission
 * not granted) so the caller stays quiet rather than nagging.
 */
export async function checkForUpdates(dirHandle) {
  if (!dirHandle) return null;
  if ((await directoryPermission(dirHandle)) !== 'granted') return null;
  const prev = (await getMeta('importState')) || { mtimes: {} };
  const changed = [];
  const present = new Set();
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file' || !CSV_FILE_RE.test(name)) continue;
      present.add(name);
      const file = await handle.getFile();
      if (prev.mtimes[name] !== file.lastModified) changed.push(name);
    }
  } catch { return null; }
  for (const name of Object.keys(prev.mtimes)) {
    if (!present.has(name)) changed.push(name);   // deleted counts as a change
  }
  return { changed, count: changed.length };
}

/**
 * Fallback for browsers without File System Access: import from the
 * File objects of an <input webkitdirectory> pick. No handle is kept,
 * so no auto-refresh — the user re-imports for fresher data. The pick
 * replaces the whole archive (same folder-is-truth rule as above).
 */
export async function importFromFileList(fileList, { onProgress } = {}) {
  const files = Array.from(fileList || []).filter((f) => CSV_FILE_RE.test(f.name));
  if (!files.length) throw new Error('No .csv files in that selection.');

  const kept = new Set();
  const mtimes = {};
  let imported = 0, ignored = 0, rows = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = f.name.split('/').pop();
    onProgress?.({ done: i, total: files.length, label: name });
    const csv = await f.text();
    const analysis = analyzeSalesCsv(csv);
    if (!isSalesHeader(analysis)) { ignored++; continue; }
    await putFileRec({ name, csv, meta: metaFor(analysis, f) });
    kept.add(name);
    mtimes[name] = f.lastModified;
    imported++;
    rows += analysis.dataRowCount;
  }
  for (const key of await listFileKeys()) {
    if (!kept.has(String(key))) await deleteFileRec(key);
  }
  onProgress?.({ done: files.length, total: files.length, label: 'done' });
  return finishImport({
    files: kept.size, imported, skipped: 0, ignored, rows, mtimes, hasHandle: false,
  });
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/** Every imported file's name + meta, ordered oldest sale first (files
 *  without a parseable date sort last) — the Coverage table's row order. */
export async function listFiles() {
  const recs = (await listFileRecs()) || [];
  return recs
    .map((r) => ({ name: r.name, meta: r.meta || {} }))
    .sort((a, b) => {
      const am = a.meta.minSaleDate || '9999-99-99';
      const bm = b.meta.minSaleDate || '9999-99-99';
      return am < bm ? -1 : am > bm ? 1 : a.name.localeCompare(b.name);
    });
}

/*
 * Which source a file came from, inferred from its name.
 *
 * SABRE exports are "SoldPropertyListing*". MLS exports are coming as a
 * periodic dump and will land in the same folder, so the store keeps the
 * two apart from the start: freshness is per SOURCE, and a stale SABRE
 * pull sitting beside a current MLS one must not read as "everything is
 * current". Anything unrecognised is reported under its own label
 * rather than being silently folded into SABRE.
 */
export function sourceOf(fileName) {
  const n = String(fileName || '').toLowerCase();
  if (n.includes('soldpropertylisting')) return 'SABRE';
  if (n.includes('mls')) return 'MLS';
  return 'Other';
}

/**
 * Newest sale date per source, for the staleness read-out.
 * @returns {Array<{source: string, files: number, rows: number, newest: string|null, oldest: string|null}>}
 */
export async function freshnessBySource() {
  const files = await listFiles();
  const bySource = new Map();
  for (const f of files) {
    const src = sourceOf(f.name);
    if (!bySource.has(src)) {
      bySource.set(src, { source: src, files: 0, rows: 0, newest: null, oldest: null });
    }
    const e = bySource.get(src);
    e.files += 1;
    e.rows += f.meta.rows || 0;
    if (f.meta.maxSaleDate && (e.newest == null || f.meta.maxSaleDate > e.newest)) e.newest = f.meta.maxSaleDate;
    if (f.meta.minSaleDate && (e.oldest == null || f.meta.minSaleDate < e.oldest)) e.oldest = f.meta.minSaleDate;
  }
  return [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source));
}

/** One-line description of what's imported, without reading any CSV. */
export async function describeImport() {
  const keys = await listFileKeys().catch(() => []);
  if (!keys || !keys.length) return { present: false };
  const files = await listFiles();
  let min = null;
  let max = null;
  let rows = 0;
  for (const f of files) {
    rows += f.meta.rows || 0;
    if (f.meta.minSaleDate && (min == null || f.meta.minSaleDate < min)) min = f.meta.minSaleDate;
    if (f.meta.maxSaleDate && (max == null || f.meta.maxSaleDate > max)) max = f.meta.maxSaleDate;
  }
  const summary = await getMeta('summary').catch(() => null);
  return {
    present: true,
    files: files.length,
    rows,
    minSaleDate: min,
    maxSaleDate: max,
    imported_at: summary?.imported_at || null,
    auto_refresh: !summary?.no_handle,
  };
}

/**
 * Merge every imported export into one CSV, in the exact `{ name, text }`
 * shape handleSalesUpload() already accepts from a file drop — the
 * database is just another way to hand the existing pipeline a CSV.
 * Returns null when nothing is imported. Throws (from mergeSalesFiles)
 * when the exports disagree on columns, naming the odd file.
 */
export async function buildMergedCsv() {
  const recs = (await listFileRecs()) || [];
  if (!recs.length) return null;
  const merged = mergeSalesFiles(recs.map((r) => ({ name: r.name, csv: r.csv })));
  return {
    name: `SABRE database — ${merged.fileCount} file${merged.fileCount === 1 ? '' : 's'}`,
    text: merged.text,
    sales: merged.kept,
    salesAvailable: merged.total,
    duplicatesDropped: merged.duplicates,
  };
}
