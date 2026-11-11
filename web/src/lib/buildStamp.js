// The build stamp printed small after the page title ("1dc7566 ·
// 2026-11-11 10:42"), so a glance says which commit Vercel is serving and
// when it was built (Jason, 2026-11-11). The commit and time are baked in
// at build time by vite.config.js (__APP_COMMIT__, __APP_BUILD_TIME__); on
// Vercel the commit is VERCEL_GIT_COMMIT_SHA, the exact one deployed.
//
// SHARED FILE: kept byte-identical between mb-parcelsearch and the Winnipeg
// ParcelSearch app.

const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-11 10:42" in the viewer's local time, or '' for a bad date. */
export function localStamp(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The stamp's text and hover title from the baked-in commit and build
 * time. A dev server or test run has neither, and says "dev".
 */
export function buildStampText(commit, builtIso) {
  const sha = commit && commit !== 'unknown' && commit !== 'dev' ? String(commit).slice(0, 7) : '';
  const when = localStamp(builtIso);
  if (!sha && !when) return { text: 'dev', title: 'Development build (no commit stamped)' };
  return {
    text: [sha, when].filter(Boolean).join(' · '),
    title: `Build ${commit || 'unknown'}${when ? `, built ${when}` : ''}`,
  };
}

/** Fill the element with id `app-build`, if the page has one. */
export function showBuildStamp(doc = document) {
  const el = doc.getElementById('app-build');
  if (!el) return;
  const s = buildStampText(
    typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : null,
    typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : null,
  );
  el.textContent = s.text;
  el.title = s.title;
}
