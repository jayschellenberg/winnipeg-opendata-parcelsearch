// Neighbourhood slug — must match the R builder's slugify(name) EXACTLY
// (r/lib_helpers.R): the slug IS the archive filename for that
// neighbourhood's lineage file (lineage/<SLUG>.json). test/slugParity.test.js
// asserts this against the fixture the R side regenerates on every build.
export function historicalSlugify(x) {
  return String(x).toUpperCase().trim()
    .replace(/[/ ]+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
