// Row selection — the tick column that hides rows from the map, the CSV
// export and the charts (ported from the Manitoba app, 2026-09-14).
// Asserts each hop BY NAME in main.js / the registry, so re-pointing the
// dedupe at the unfiltered collection, dropping the export warning, or
// letting the column picker govern the tick column each goes red.
// Run: cd web && node test/rowSelection.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COLUMNS, COLUMN_KEYS, csvSchemaForMode } from '../src/lib/columnsRegistry.js';
import { isColumnVisible } from '../src/lib/columns.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainJs = readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Body of a top-level `function name(` in main.js, brace-balanced. */
function fnBody(name) {
  const start = mainJs.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `main.js defines ${name}()`);
  // The body brace follows the parameter list's `)`, not the first `{`
  // (a destructured default such as `{ fit = true } = {}` comes first).
  let i = mainJs.indexOf(') {', start) + 2;
  let depth = 0;
  for (; i < mainJs.length; i++) {
    if (mainJs[i] === '{') depth++;
    else if (mainJs[i] === '}' && --depth === 0) break;
  }
  return mainJs.slice(start, i + 1);
}

console.log('rowSelection');

test('the registry carries a select column, right after # and before Roll Number, on both tabs', () => {
  const col = COLUMNS.find((c) => c.key === 'select');
  assert.ok(col, 'select column registered');
  assert.equal(col.mode, 'always', 'shown on Property Search and Sales Analysis alike');
  assert.equal(col.sortable, false);
  assert.equal(col.theadId, 'select-all-th', 'the header names the <th> main.js injects the tick-all box into');
  assert.equal(COLUMN_KEYS.indexOf('select'), COLUMN_KEYS.indexOf('seq') + 1);
  assert.equal(COLUMN_KEYS.indexOf('roll'), COLUMN_KEYS.indexOf('select') + 1);
});

test('the select column never reaches the CSV', () => {
  for (const mode of ['property', 'sales']) {
    const { headers } = csvSchemaForMode(mode, { numbering: true });
    assert.ok(!headers.includes(''), `${mode}: no blank header`);
  }
});

test('the column picker cannot hide the select column', () => {
  // UNGOVERNED in lib/columns.js — a preset that omits it must not hide it.
  assert.equal(isColumnVisible('select'), true);
});

test('renderTable stamps the row keys before the cells are built and applies the tick state', () => {
  const body = fnBody('renderTable');
  const stamp = body.indexOf('stampRowSelKeys(rows)');
  const cells = body.indexOf('col.render(a, s)');
  assert.ok(stamp >= 0 && cells >= 0 && stamp < cells, 'keys stamped before render');
  assert.ok(body.includes("classList.add('deselected')"), 'unticked rows get the dimmed class');
  assert.ok(body.includes('syncSelectAllBox()'), 'header box re-synced after every render');
});

test('setParcels filters BOTH sides by selection before the per-parcel dedupe', () => {
  const body = fnBody('setParcels');
  const filt = body.indexOf('assessFc = filterFcBySelection(assessFc)');
  const dedupe = body.indexOf('dedupeByGeometryHash(assessFc)');
  assert.ok(filt >= 0, 'assessment side filtered');
  assert.ok(body.includes('surveyFc = filterFcBySelection(surveyFc)'), 'survey side filtered');
  assert.ok(dedupe >= 0 && filt < dedupe, 'filter runs before the dedupe is fed');
});

test('exportCsv warns first, then writes only the ticked rows', () => {
  const body = fnBody('exportCsv');
  const warn = body.indexOf("confirmCulledExport(culled, currentRows.length, 'CSV export')");
  const filt = body.indexOf('currentRows.filter(rowIsSelected)');
  assert.ok(warn >= 0 && filt >= 0 && warn < filt);
  assert.ok(body.includes('for (const row of exportRows)'), 'the writer loops the filtered rows');
});

test('the charts read the ticked rows only, and the Charts button warns', () => {
  assert.ok(fnBody('publishSalesToCharts').includes('.filter(rowIsSelected)'));
  const open = mainJs.slice(mainJs.indexOf("getElementById('charts-open')"));
  assert.ok(open.slice(0, 900).includes("confirmCulledExport(culled, currentRows.length, 'chart')"));
});

test('a new search or a new sales import drops the cull; nothing persists it', () => {
  assert.ok(fnBody('runSearch').includes('deselectedRowKeys = new Set()'));
  const importSite = mainJs.indexOf('salesData = dedupAndGroupSales(parsed.rows)');
  assert.ok(importSite >= 0 && mainJs.slice(importSite - 300, importSite).includes('deselectedRowKeys = new Set()'));
  assert.ok(!/localStorage\.[gs]etItem\([^)]*desel/i.test(mainJs), 'never written to localStorage');
});

test('both count lines state the cull', () => {
  assert.ok(fnBody('renderCount').includes('selectionSuffix()'));
  assert.ok(fnBody('renderSalesCount').includes('selectionSuffix()'));
});

test('a repeat sale of one parcel is two cullable rows', () => {
  // rowSelKey carries the sale instrument, so two rows for one roll differ.
  const body = fnBody('rowSelKey');
  assert.ok(body.includes('_saleInstrument'), 'key includes the instrument');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
