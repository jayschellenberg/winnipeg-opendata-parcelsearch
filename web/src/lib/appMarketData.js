/*
 * app-market-data.js — let a viewer pick the shared AppMarketData folder
 * instead of an app's own subfolder.
 *
 * The firm's AppMarketData folder holds three permission tiers, each its own
 * Dropbox share (AppMarketData-External, -Internal, -Limited; SalesData is in
 * -Limited) of app folders. Each explorer reads one subfolder. (Copied from housing-economic-data
 * web/src/app-market-data.js; keep the two in step.) A viewer who picks AppMarketData itself (or
 * any folder along the path) is stepped down to the app's subfolder, and that
 * subfolder's handle is what gets saved, so everything downstream sees the
 * same folder it always did. A pick that is not on the path (an export\ or
 * web-data folder, say) is returned untouched.
 */

/** The shared folder's name as colleagues see it in Dropbox. */
export const APP_MARKET_DATA = 'AppMarketData';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function childDirectory(dir, name) {
  for await (const [n, h] of dir.entries()) {
    if (h.kind === 'directory' && same(n, name)) return h;
  }
  return null;
}

/**
 * True for AppMarketData itself and its permission-tier folders
 * (AppMarketData-External, AppMarketData-Internal, AppMarketData-Limited).
 * Each tier is its own Dropbox share, so a viewer holds one to three of them,
 * often gathered into a folder of their own named AppMarketData.
 */
export const isAppMarketData = (name) => /^AppMarketData(-|$)/i.test(String(name));

/** The AppMarketData / tier folders directly inside `dir`. */
export async function appMarketDataChildren(dir) {
  const out = [];
  for await (const [n, h] of dir.entries()) {
    if (h.kind === 'directory' && isAppMarketData(n)) out.push(h);
  }
  return out;
}

async function walk(dir, names) {
  for (const name of names) {
    dir = await childDirectory(dir, name);
    if (!dir) return null;
  }
  return dir;
}

// The path below `dir`, or below an AppMarketData / tier folder inside it
// (up to `depth` such folders deep: AppMarketData > AppMarketData-Internal).
async function findBelow(dir, path, depth) {
  const hit = await walk(dir, path);
  if (hit || depth <= 0) return hit;
  for (const amd of await appMarketDataChildren(dir)) {
    const found = await findBelow(amd, path, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * @param {FileSystemDirectoryHandle} handle  the folder the viewer picked
 * @param {string[]} path  the app's folder below AppMarketData (or below its
 *   tier folder), e.g. ['RentalDashboard'] or ['SalesData', 'Manitoba']
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function resolveAppFolder(handle, path) {
  const at = path.findIndex((p) => same(p, handle.name));
  const dir = at >= 0 ? await walk(handle, path.slice(at + 1)) : await findBelow(handle, path, 2);
  return dir || handle;
}

/**
 * For the no-File-System-Access fallback (a folder <input>): keep only the
 * files under the app's subfolder when the selection was a parent of it, so a
 * whole-AppMarketData selection does not mix every app's manifest.json.
 * Paths come from webkitRelativePath ("AppMarketData/RentalDashboard/...").
 */
export function filterAppFiles(fileList, path) {
  const files = Array.from(fileList || []);
  const leaf = path[path.length - 1];
  const under = files.filter((f) => {
    const parts = String(f.webkitRelativePath || '').split('/');
    return parts.slice(0, -1).some((p) => same(p, leaf));
  });
  return under.length ? under : files;
}
