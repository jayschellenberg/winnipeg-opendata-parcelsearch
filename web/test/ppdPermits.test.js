// Unit tests for src/lib/ppdPermits.js — parsing the City PP&D permit
// portal's pages and joining them to open-data it4w-cpf4 rows.
// Fixtures are trimmed copies of real portal responses (Nov 2026).
// Plain-node runner; run with `npm test` or `node test/ppdPermits.test.js`.

import assert from 'node:assert/strict';
import {
  parseCivicAddress, addressLabel, ppdSearchBody, htmlToText, isoDate,
  parsePpdPage, mergePermits, linkOccupancyToBuilding, sameStreet,
  permitKey, describeOd, permitClassCode, isTradePermit, PERMIT_CLASS_LABELS,
} from '../src/lib/ppdPermits.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed += 1;
  }
}

console.log('ppdPermits');

const BUILDING_PAGE = `<html><body><div class="div_form">
Permits for 1 Portage Avenue E <p />
For information on permit search results and terminology, see <a href="SearchFAQ.jsp">FAQ</a>.
<table id="results">
	<tr>
	  <th><b>Number</b></th><th><b>Address</b></th><th><b>Description</b></th><th><b>Status</b></th><th><b>Issued Date</b></th>
	</tr>
        <tr valign=top bgcolor="#FFFFFF">
          <td>26-174994 ES</td>
          <td>1  Portage AVE E</td>
          <td>Wire New  Sign. Related Sign Permit Number/Year: 26 170012 000 00 SP.</td>
          <td><div class="tooltip">Closed <span class="tooltiptext"><b>Closed:</b> The permit is closed.</span></div></td>
          <td>2026-06-11</td>
        </tr>
        <tr valign=top bgcolor="#E0E0E0">
          <td>26-170012 SP</td>
          <td>1  Portage AVE E</td>
          <td>Face Replace Only. Erect new sign face, &quot;Winnipeg//[logo]//Goldeyes&quot;.</td>
          <td><div class="tooltip">Issued <span class="tooltiptext"><b>Issued:</b> Work may proceed.</span></div></td>
          <td>2026-06-10</td>
        </tr>
</table></div></body></html>`;

const OCC_PAGE = `<div class="div_form">
Permits for 300 Portage Avenue , issued after December 29 <sup>th</sup>, 1998. <p />
<table>
       <tr bgColor = "#E0E0E0"><td>Number</td><td>Occupant / Tenant</td><td>Unit</td><td>Use</td><td>Major Group</td><td>Description</td><td>Issued Date</td><td>Expiry Date</td><td>Occupant Load</td></tr>
        <tr valign=top bgcolor="#FFFFFF">
        	<td>26 136235 OC</td>
        	<td></td>
        	<td></td>
        	<td>Arenas</td>
        	<td>Group A, Division 3 – Assembly occupancies of the arena type.</td>
        	<td>True North Sports + Entertainment (landlord work) - Interior alterations in an existing building.</td>
        	<td>September 17, 2026</td>
        	<td>January 29, 2027</td>
        	<td>1200</td>
        </tr>
</table></div>`;

const UNITS_PAGE = `Your Search: 817 ST MARY'S RD <p />
  Multiple entries for your criteria were found (2). Please specify:<p />
    <a href="Results.jsp?propertyRSN=278070">
			Unit  001
	    817  St Mary's
	    RD
    </a>
    <br />
    <a href="Results.jsp?propertyRSN=278071">
			Unit  002
	    817  St Mary's
	    RD
    </a>`;

const NEARBY_OCC_PAGE = `Your Search: 100 PORTAGE <p />
  Address not found. However, we found several suggetions in the area:<p />
    <a href="WinnipegAddress.jsp?context=PublicQuery&propertyRSN=194906">1 Portage AVE</a><br />
    <a href="WinnipegAddress.jsp?context=PublicQuery&amp;propertyRSN=8649">130 Portage AVE</a><br />
  <a href="Start.jsp?Confirm=1"><img src="NewSearch.png" alt="Start Over" ></a>`;

const NONE_PAGE = 'No property matching your criteria, street name, or similiar street name, was found.';

// --- address parsing ---------------------------------------------------

test('parseCivicAddress: plain roll address folds the type', () => {
  assert.deepEqual(parseCivicAddress('300 PORTAGE AVENUE'),
    { unit: '', number: '300', suffix: '', name: 'PORTAGE', type: 'AVE', direction: '' });
});

test('parseCivicAddress: unit prefix, apostrophe, zero-stripped unit', () => {
  const a = parseCivicAddress("001-817 ST MARY'S ROAD");
  assert.equal(a.unit, '1');
  assert.equal(a.number, '817');
  assert.equal(a.name, "ST MARY'S");
  assert.equal(a.type, 'RD');
});

test('parseCivicAddress: direction and letter suffix', () => {
  const a = parseCivicAddress('1 PORTAGE AVENUE EAST');
  assert.equal(a.direction, 'E');
  assert.equal(a.type, 'AVE');
  const b = parseCivicAddress('123A MAIN STREET');
  assert.equal(b.number, '123');
  assert.equal(b.suffix, 'A');
});

test('parseCivicAddress: first of a comma list; null without a number', () => {
  assert.equal(parseCivicAddress('10 MAIN STREET, 12 MAIN STREET').number, '10');
  assert.equal(parseCivicAddress('PORTAGE AVENUE'), null);
  assert.equal(parseCivicAddress(''), null);
});

test('parseCivicAddress: a street named like a direction keeps its name', () => {
  // "NORTH" alone is the name, not a direction with no street.
  const a = parseCivicAddress('5 NORTH DRIVE');
  assert.equal(a.name, 'NORTH');
  assert.equal(a.type, 'DR');
});

test('addressLabel and ppdSearchBody', () => {
  const a = parseCivicAddress('001-817 ST MARY\'S ROAD');
  assert.equal(addressLabel(a), "1-817 ST MARY'S RD");
  const body = new URLSearchParams(ppdSearchBody(a));
  assert.equal(body.get('streetNumber'), '817');
  assert.equal(body.get('streetName'), "ST MARY'S");
  assert.equal(body.get('streetType'), 'RD');
  assert.equal(body.get('lid'), 'ReadOnlypermits ');
});

// --- HTML helpers --------------------------------------------------------

test('htmlToText strips tags and decodes entities', () => {
  assert.equal(htmlToText('<b>A</b> &amp; &quot;B&quot; &#8209; &#39;c&#39;'), 'A & "B" - \'c\'');
});

test('isoDate reads both portal formats', () => {
  assert.equal(isoDate('2026-06-11'), '2026-06-11');
  assert.equal(isoDate('September 7, 2026'), '2026-09-07');
  assert.equal(isoDate('2026-03-04T00:00:00.000'), '2026-03-04');
  assert.equal(isoDate(''), '');
});

// --- page parsing ----------------------------------------------------------

test('building results page', () => {
  const r = parsePpdPage(BUILDING_PAGE, 'building');
  assert.equal(r.shape, 'results');
  assert.equal(r.heading, '1 Portage Avenue E');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], {
    number: '26-174994 ES',
    address: '1 Portage AVE E',
    description: 'Wire New Sign. Related Sign Permit Number/Year: 26 170012 000 00 SP.',
    status: 'Closed',
    statusNote: 'The permit is closed.',
    issued: '2026-06-11',
  });
  assert.match(r.rows[1].description, /"Winnipeg\/\/\[logo\]\/\/Goldeyes"/);
  assert.equal(r.rows[1].status, 'Issued');
});

test('occupancy results page', () => {
  const r = parsePpdPage(OCC_PAGE, 'occupancy');
  assert.equal(r.shape, 'results');
  assert.equal(r.heading, '300 Portage Avenue');
  assert.equal(r.rows.length, 1);
  const o = r.rows[0];
  assert.equal(o.number, '26 136235 OC');
  assert.equal(o.use, 'Arenas');
  assert.equal(o.issued, '2026-09-17');
  assert.equal(o.expires, '2027-01-29');
  assert.equal(o.occupantLoad, '1200');
});

test('unit chooser page', () => {
  const r = parsePpdPage(UNITS_PAGE, 'building');
  assert.equal(r.shape, 'units');
  assert.equal(r.choices.length, 2);
  assert.deepEqual(r.choices[0],
    { rsn: '278070', path: 'Results.jsp?propertyRSN=278070', label: "Unit 001 817 St Mary's RD", unit: '1' });
});

test('nearby-suggestion page (occupancy links, start-over link ignored)', () => {
  const r = parsePpdPage(NEARBY_OCC_PAGE, 'occupancy');
  assert.equal(r.shape, 'nearby');
  assert.equal(r.choices.length, 2);
  assert.equal(r.choices[1].path, 'WinnipegAddress.jsp?context=PublicQuery&propertyRSN=8649');
});

test('no-match and unknown pages', () => {
  assert.equal(parsePpdPage(NONE_PAGE).shape, 'none');
  assert.equal(parsePpdPage('<html>Request blocked</html>').shape, 'unknown');
});

// --- cross-reference ------------------------------------------------------

const od = (o = {}) => ({
  permit_number: '26-170012 SP',
  issue_date: '2026-06-10T00:00:00.000',
  permit_group: 'Non-Residential',
  permit_type: 'Sign',
  sub_type: 'Free Standing Sign',
  work_type: 'Face Replace Only',
  applicant_business_name: 'Connelly Signs',
  dwelling_units_created: '0',
  dwelling_units_lost: '0',
  street_type: 'AVE',
  street_direction: 'E',
  status: 'Closed',
  ...o,
});

test('mergePermits joins on permit number and keeps both orphans', () => {
  const portal = parsePpdPage(BUILDING_PAGE, 'building').rows;
  const demo = od({
    permit_number: '25-100001 HO', issue_date: '2025-01-05T00:00:00.000',
    permit_type: 'Single Family Dwelling', sub_type: 'SFD', work_type: 'Demolish',
    dwelling_units_lost: '1', address: '1  Portage AVE E',
  });
  const merged = mergePermits(portal, [od(), demo]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((r) => [r.number, r.source]), [
    ['26-174994 ES', 'ppd'],
    ['26-170012 SP', 'both'],
    ['25-100001 HO', 'opendata'],
  ]);
  assert.equal(merged[1].od.applicant, 'Connelly Signs');
  assert.equal(merged[1].description.startsWith('Face Replace Only'), true);
  assert.equal(merged[2].od.unitsLost, 1);
  assert.equal(merged[2].address, '1 Portage AVE E');
});

test('permitKey folds case and spacing', () => {
  assert.equal(permitKey(' 26-170012  sp '), '26-170012 SP');
});

test('sameStreet: type must agree when both have one; direction outright', () => {
  const a = parseCivicAddress('1 PORTAGE AVENUE EAST');
  assert.equal(sameStreet(a, od()), true);
  assert.equal(sameStreet(a, od({ street_direction: undefined })), false);
  assert.equal(sameStreet(a, od({ street_type: undefined })), true);
  const b = parseCivicAddress('300 PORTAGE AVENUE');
  assert.equal(sameStreet(b, od({ street_direction: undefined })), true);
  assert.equal(sameStreet(b, od({ street_type: 'ST', street_direction: undefined })), false);
});

test('linkOccupancyToBuilding: exact long description names the permit', () => {
  const occ = [
    { number: '26 1 OC', description: 'True North - Interior alterations in an existing building.' },
    { number: '26 2 OC', description: 'Locate.' },
  ];
  const bld = [
    { number: '26-9 RE', description: 'True North — interior alterations in an existing building' },
    { number: '26-8 TA', description: 'Locate.' },
  ];
  const out = linkOccupancyToBuilding(occ, bld);
  assert.equal(out[0].relatedPermit, '26-9 RE');
  assert.equal(out[1].relatedPermit, undefined);
});

test('linkOccupancyToBuilding: shared number (space for dash) wins', () => {
  const out = linkOccupancyToBuilding(
    [{ number: '06 117112 PI', description: 'Exterior alterations, patio deck.' }],
    [{ number: '06-117112 PI', description: 'Alter Exterior. Exterior alterations, patio deck, legion.' }],
  );
  assert.equal(out[0].relatedPermit, '06-117112 PI');
});

test('linkOccupancyToBuilding: a shared description names nothing', () => {
  const d = 'Interior alterations to an existing tenant space, no structural work.';
  const out = linkOccupancyToBuilding(
    [{ number: 'O', description: d }],
    [{ number: 'A', description: d }, { number: 'B', description: d }],
  );
  assert.equal(out[0].relatedPermit, undefined);
});

test('describeOd and permitClassCode', () => {
  assert.equal(describeOd(mergePermits([], [od()])[0].od), 'Sign · Free Standing Sign — Face Replace Only');
  assert.equal(describeOd(null), '');
  assert.equal(permitClassCode('26-174994 ES'), 'ES');
  assert.equal(permitClassCode('26 136235 OC'), 'OC');
  assert.equal(permitClassCode('x'), '');
});

test('isTradePermit: electrical, mechanical, plumbing only', () => {
  assert.equal(isTradePermit('26-261324 EC'), true);
  assert.equal(isTradePermit('26-174994 ES'), true);
  assert.equal(isTradePermit('19-1 PR'), true);
  assert.equal(isTradePermit('26-121645 RE'), false);
  assert.equal(isTradePermit('25-100001 HO'), false);
  assert.equal(PERMIT_CLASS_LABELS.MC, 'Mechanical Commercial');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
