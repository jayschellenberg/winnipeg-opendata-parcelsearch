// External-link builders used by both the live table-render and the CSV
// export (and the columns registry that ties them together). Pure: take
// an assessment-property object (or address string), return a URL string
// or null. Extracted from main.js so lib/columnsRegistry.js can stay
// importable in plain Node for the registry test.

/**
 * Build the City's assessment-page URL for a parcel. The d4mq-wa44
 * dataset has a `detail_url` field but it points at
 * `http://www.winnipegassessment.com/...` whose HTTPS redirect lands
 * on a host whose cert has a CN mismatch — Chrome shows a "Your
 * connection is not private" warning (ERR_CERT_COMMON_NAME_INVALID).
 * The City's canonical working host is `assessment.winnipeg.ca` —
 * same AsmtPub path, valid cert. We ignore the dataset's URL and
 * build from `roll_number` directly.
 */
export function assessmentUrl(props) {
  if (!props?.roll_number) return null;
  return `https://assessment.winnipeg.ca/AsmtPub/english/propertydetails/details.aspx?pgLang=EN&isRealtySearch=true&RollNumber=${encodeURIComponent(props.roll_number)}`;
}

/**
 * Build a Walk Score URL from a civic address. Walk Score's web page at
 * /score/<address> renders Walk / Transit / Bike scores on arrival, no
 * API key needed. Returns null when the address is missing or only
 * contains the multi-address comma-list — we use just the primary
 * address (text before the first comma) for cleanliness.
 */
export function walkscoreUrl(fullAddress) {
  if (!fullAddress) return null;
  const primary = String(fullAddress).split(',')[0].trim();
  if (!primary) return null;
  return `https://www.walkscore.com/score/${encodeURIComponent(primary + ', Winnipeg, MB')}`;
}

/**
 * Build a deep-link into the sister Manitoba flood-mapping tool with the
 * parcel's centroid and address pre-filled. Falls back to address-only
 * when centroid is unavailable.
 */
export function floodToolUrl(props) {
  if (!props) return null;
  const lat = Number(props.centroid_lat);
  const lon = Number(props.centroid_lon);
  const address = (props.full_address || '').split(',')[0].trim();
  const params = new URLSearchParams();
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', lat.toFixed(6));
    params.set('lon', lon.toFixed(6));
  }
  if (address) params.set('label', address);
  if (![...params.keys()].length) return null;
  return `https://mb-flood-mapping.vercel.app/?${params.toString()}`;
}
