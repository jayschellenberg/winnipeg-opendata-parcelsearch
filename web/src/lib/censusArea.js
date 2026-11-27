// Which census area the Winnipeg report shows for a parcel.
//
// The census-summary feed has 211 neighbourhood profiles for the site's 237
// neighbourhoods: the City's tabulation folds small and industrial ones
// (Civic Centre, Exchange District, Portage & Main, Stock Yards ...) into
// others. Every neighbourhood belongs to one of the 23 clusters, and every
// cluster has a profile, so a neighbourhood without one falls back to its
// cluster, labelled as such. Pure; tested in test/censusArea.test.js.

const key = (s) => String(s ?? '').trim().toUpperCase();

/**
 * { uid, level: 'neighbourhood' | 'cluster', name } for the area to show,
 * or null when neither the neighbourhood nor its cluster has a profile.
 */
export function censusArea(regions, neighbourhood, cluster) {
  const find = (level, name) => (name ? (regions || []).find((r) => r.level === level && key(r.name) === key(name)) : null);
  const n = find('WPG_Nbhd', neighbourhood);
  if (n) return { uid: n.uid, level: 'neighbourhood', name: n.name };
  const c = find('WPG_Cluster', cluster);
  if (c) return { uid: c.uid, level: 'cluster', name: c.name };
  return null;
}
