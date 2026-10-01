/*
 * app-market-data.js — let a viewer pick the shared AppMarketData folder
 * instead of an app's own subfolder.
 *
 * The firm shares one Dropbox folder, AppMarketData, holding CapRates,
 * CommercialAvailability, JohnsonReport, RentalDashboard and SalesData. Each
 * explorer reads one subfolder. (Copied from housing-economic-data
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
 * @param {FileSystemDirectoryHandle} handle  the folder the viewer picked
 * @param {string[]} path  the app's folder below AppMarketData, e.g.
 *   ['RentalDashboard'] or ['SalesData', 'Manitoba']
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function resolveAppFolder(handle, path) {
  const at = path.findIndex((p) => same(p, handle.name));
  let dir = handle;
  for (const name of at >= 0 ? path.slice(at + 1) : path) {
    const next = await childDirectory(dir, name);
    if (!next) return handle;
    dir = next;
  }
  return dir;
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
