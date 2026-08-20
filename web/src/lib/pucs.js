/*
 * Winnipeg Property Use Codes (PUCS): the code's plain name, and the
 * appraisal CATEGORY it belongs to.
 *
 * Two separate jobs, deliberately in one table:
 *
 *   NAMES     — "RESSD" reads as nothing; "Detached Single Dwelling" is
 *               the thing an appraiser is actually looking at. SABRE
 *               exports carry the bare 5-letter code only, so the grid
 *               has no name to show unless we carry one.
 *
 *   CATEGORY  — the code is too fine-grained to filter on (100 live
 *               codes, 57 of them in the sales archive). The category is
 *               the level a comp search actually happens at: show me the
 *               Land sales, show me Multi-Family.
 *
 * WHERE THE NAMES COME FROM. Every name here was read off the CITY's own
 * live assessment dataset (d4mq-wa44), whose property_use_code field is
 * published as "CODE - NAME" — so these are the City's labels, not a
 * transcription. The 2002 MAAP fax filled in 35 codes the live roll no
 * longer carries; those are marked below. Eight codes in the sales
 * archive appear on no fax at all (CMVSR, CMSTP, CNCOM, CNIND, CNVAC,
 * RESMA, RESGC, RESRM) and are named here from the live data.
 *
 * Pure — no DOM, no fetch — so it unit-tests under plain node.
 */

/**
 * The categories, in the order they should appear in a filter. Land
 * first because that is what most of this app is for.
 */
export const PUCS_CATEGORY_ORDER = Object.freeze([
  'Land',
  'Residential',
  'Multi-Family',
  'Condominium',
  'Retail-Commercial',
  'Office',
  'Hospitality',
  'Industrial',
  'Mixed-Use',
  'Agricultural',
  'Special Purpose',
  'Infrastructure',
]);

/**
 * code → plain name. Title-cased from the City's ALL-CAPS publication so
 * it sits in a table cell without shouting.
 */
export const PUCS_NAMES = Object.freeze({
  // --- Land ---
  CMPSP: 'Surface Parking',
  CNVAC: 'Condo Vacant',
  VAGRI: 'Vacant Agricultural',
  VAGSP: 'Vacant Agricultural Split',   // not on the current roll
  VAPRK: 'Vacant Park',
  VARPT: 'Vacant Airport',   // not on the current roll
  VBLOK: 'Block Plan Residential',
  VCOMM: 'Vacant Commercial',
  VINDU: 'Vacant Industrial',
  VRES1: 'Vacant Residential 1',
  VRES2: 'Vacant Residential 2',
  // --- Residential ---
  RESDU: 'Duplex',
  RESMH: 'Mobile Home',
  RESOT: 'Residential Outbuilding',
  RESSD: 'Detached Single Dwelling',
  RESSS: 'Side By Side',
  RESSU: 'Residential Secondary Unit',
  // --- Multi-Family ---
  RESAM: 'Apartments Multiple Use',
  RESAP: 'Apartments',
  RESMA: 'Multiple Attached Units',
  RESMB: 'Residential Multiple Buildings',
  RESMC: 'Multifamily Conversion',
  RESRH: 'Row Housing',
  RESRM: 'Rooming House',
  RESTR: 'Triplex',
  // --- Condominium ---
  CNAPT: 'Condo Apartment',
  CNCMP: 'Condo Complex',
  CNCST: 'Condo Cost',
  CNDRH: 'Condo-Rowhouse',   // not on the current roll
  CNRES: 'Condo Residential',
  // --- Retail-Commercial ---
  CMCMI: 'Commercial Misc.',   // not on the current roll
  CMCMU: 'Commercial Multiple Use',
  CMMRH: 'Commercial Row House',
  CMPST: 'Parking Structure',
  CMRCS: 'Concourse Shopping',
  CMRCV: 'Convenience Store',
  CMRDI: 'Discount Store',   // not on the current roll
  CMRDS: 'Department Store',   // not on the current roll
  CMRFS: 'Furniture Store',   // not on the current roll
  CMRNS: 'Neighbourhood Shopping Centre',
  CMRRE: 'Restaurant',
  CMRRS: 'Regional Shopping Centre',
  CMRSM: 'Supermarket',
  CMRST: 'Store',
  CMRWC: 'Retail Warehouse',
  CMSTP: 'Strip Mall',
  CMVCD: 'Complete Auto Dealer',
  CMVCW: 'Car Wash',   // not on the current roll
  CMVSG: 'Service Garage',   // not on the current roll
  CMVSR: 'Vehicle Service Related',
  CMVSS: 'Service Station',   // not on the current roll
  CNCOM: 'Condo Commercial',
  CNSTO: 'Condo-Store',   // not on the current roll
  // --- Office ---
  CMFBK: 'Bank',
  CMFCU: 'Credit Union',   // not on the current roll
  CMOFF: 'Office',
  CMOFM: 'Office/Multi Use',   // not on the current roll
  CMOGV: 'Government Office',
  CMOMC: 'Medical Office Clinic',
  CMOMD: 'Media Service',   // not on the current roll
  CMOPO: 'Post Office',   // not on the current roll
  CNOFF: 'Condo-Office',   // not on the current roll
  // --- Hospitality ---
  CMHBH: 'Beverage Hotel',
  CMHHO: 'Hotel',
  CMHMH: 'Motor Hotel',   // not on the current roll
  CMHMO: 'Motel',
  // --- Industrial ---
  CNIND: 'Condo Industrial',
  INDGR: 'Grain Elevator',
  INDSP: 'Industrial Split',   // not on the current roll
  INMHM: 'Industrial Heavy Manufacturing',
  INMLM: 'Industrial Light Manufacturing',
  INMMI: 'Industrial Miscellaneous',
  INMMU: 'Industrial Multiple Use',
  INWMS: 'Industrial Warehouse Over 2 Storey',   // not on the current roll
  INWMT: 'Warehouse Multi-Tenant',   // not on the current roll
  INWMU: 'Warehouse Multi-Use',   // not on the current roll
  INWSC: 'Storage Compound',
  INWTS: 'Industrial Warehouse 2 Storey',   // not on the current roll
  INWWH: 'Warehouse',
  // --- Mixed-Use ---
  CMCOR: 'Commercial/Residential',   // not on the current roll
  CMMRC: 'Commercial Miscellaneous Residential Conversion',   // not on the current roll
  CMOFR: 'Office/Residential',   // not on the current roll
  RESMU: 'Residential Multiple Use',
  RESPL: 'Residential/Commercial Split',   // not on the current roll
  // --- Agricultural ---
  AGISP: 'Improved Agricultural Split',   // not on the current roll
  AGRFS: 'Farm Use Split',   // not on the current roll
  AGRFU: 'Farm Use',   // not on the current roll
  AGRII: 'Improved Agricultural',
  // --- Special Purpose ---
  PIEBM: 'Banquet/Meeting Hall',
  PIECS: 'Casinos',
  PIEMA: 'Museum/Art Gallery',
  PIETC: 'Theatre/Cinema',
  PIICH: 'Church',
  PIIDC: 'Day Care',
  PIIGC: 'Non-Residential Group Care',
  PIIHO: 'Hospital',
  PIIJA: 'Jail',   // not on the current roll
  PIIMB: 'Military Base',
  PIINH: 'Nursing Home',
  PIIPF: 'Police/Fire',
  PIIRE: 'Remand Facility',
  PIIRF: 'Reformatory',   // not on the current roll
  PIISC: 'School',
  PIIUC: 'University/College',
  PIMCE: 'Cemetery',
  PIMFH: 'Funeral Home',
  PIMLC: 'Law Court',   // not on the current roll
  PIMLI: 'Library',
  PIRAR: 'Arena',
  PIRBA: 'Bowling Alley',
  PIRCC: 'Community Centre',
  PIRCR: 'Curling Rink',
  PIRGC: 'Golf Course',
  PIRMU: 'Recreational Multiple Use',
  PIRPK: 'Park With Building',
  PIRPO: 'Pool',
  PIRRI: 'Skating/Roller Rink',
  PIRRT: 'Race Track',
  PIRST: 'Stadium',
  RESGC: 'Residential Group Care',
  // --- Infrastructure ---
  ARPRT: 'Airport',
  BSSHL: 'Bus Shelters',
  HYDSS: 'Hydro Substations',
  MTSSS: 'MTS Switching Stations',
  PERP: 'Personal Property',
  PSLSS: 'Pump/Sewage/Liftstations',   // not on the current roll
  RAILR: 'Railroad',
  REFRL: 'Reference Roll',
  SKYWK: 'Skywalks',
  STATG: 'Statutory Gas Distribution Systems',
  STATP: 'Statutory Pipeline',
  STATR: 'Statutory Railway Roadway',
  STATU: 'Statutory Assessment',
  TRAPI: 'Transmission Pipe Line',   // not on the current roll
  UNKNW: 'Use Unknown',   // not on the current roll
});

/**
 * code → category.
 *
 * The judgement calls, all Jason's, recorded so a later reader does not
 * "tidy" them back:
 *
 *  - SURFACE PARKING (CMPSP) is LAND. A surface lot is bought for the
 *    dirt; its rate belongs in the land analysis. The parking STRUCTURE
 *    (CMPST) is a building and stays commercial.
 *  - CONDOS SPLIT BY UNDERLYING USE, not by tenure. A commercial condo
 *    bay (CNCOM) competes with commercial space, so it is
 *    Retail-Commercial; CNIND is Industrial; CNOFF is Office. Only the
 *    residential condos are "Condominium".
 *  - VACANT AGRICULTURAL (VAGRI) is LAND, not Agricultural. If it is
 *    vacant it is a land comp; "Agricultural" holds improved farm
 *    property only.
 *  - RESIDENTIAL GROUP CARE (RESGC) is Special Purpose, not
 *    Multi-Family — it is a care facility, not dwelling units. Same call
 *    the tile pipeline already made in r/lib_dwelling_units.R.
 *  - OFFICE, MIXED-USE and HOSPITALITY each stand alone rather than
 *    folding into Retail-Commercial: they price differently.
 */
export const PUCS_CATEGORIES = Object.freeze({
  // --- Land (11) ---
  CMPSP: 'Land',
  CNVAC: 'Land',
  VAGRI: 'Land',
  VAGSP: 'Land',
  VAPRK: 'Land',
  VARPT: 'Land',
  VBLOK: 'Land',
  VCOMM: 'Land',
  VINDU: 'Land',
  VRES1: 'Land',
  VRES2: 'Land',
  // --- Residential (6) ---
  RESDU: 'Residential',
  RESMH: 'Residential',
  RESOT: 'Residential',
  RESSD: 'Residential',
  RESSS: 'Residential',
  RESSU: 'Residential',
  // --- Multi-Family (8) ---
  RESAM: 'Multi-Family',
  RESAP: 'Multi-Family',
  RESMA: 'Multi-Family',
  RESMB: 'Multi-Family',
  RESMC: 'Multi-Family',
  RESRH: 'Multi-Family',
  RESRM: 'Multi-Family',
  RESTR: 'Multi-Family',
  // --- Condominium (5) ---
  CNAPT: 'Condominium',
  CNCMP: 'Condominium',
  CNCST: 'Condominium',
  CNDRH: 'Condominium',
  CNRES: 'Condominium',
  // --- Retail-Commercial (23) ---
  CMCMI: 'Retail-Commercial',
  CMCMU: 'Retail-Commercial',
  CMMRH: 'Retail-Commercial',
  CMPST: 'Retail-Commercial',
  CMRCS: 'Retail-Commercial',
  CMRCV: 'Retail-Commercial',
  CMRDI: 'Retail-Commercial',
  CMRDS: 'Retail-Commercial',
  CMRFS: 'Retail-Commercial',
  CMRNS: 'Retail-Commercial',
  CMRRE: 'Retail-Commercial',
  CMRRS: 'Retail-Commercial',
  CMRSM: 'Retail-Commercial',
  CMRST: 'Retail-Commercial',
  CMRWC: 'Retail-Commercial',
  CMSTP: 'Retail-Commercial',
  CMVCD: 'Retail-Commercial',
  CMVCW: 'Retail-Commercial',
  CMVSG: 'Retail-Commercial',
  CMVSR: 'Retail-Commercial',
  CMVSS: 'Retail-Commercial',
  CNCOM: 'Retail-Commercial',
  CNSTO: 'Retail-Commercial',
  // --- Office (9) ---
  CMFBK: 'Office',
  CMFCU: 'Office',
  CMOFF: 'Office',
  CMOFM: 'Office',
  CMOGV: 'Office',
  CMOMC: 'Office',
  CMOMD: 'Office',
  CMOPO: 'Office',
  CNOFF: 'Office',
  // --- Hospitality (4) ---
  CMHBH: 'Hospitality',
  CMHHO: 'Hospitality',
  CMHMH: 'Hospitality',
  CMHMO: 'Hospitality',
  // --- Industrial (13) ---
  CNIND: 'Industrial',
  INDGR: 'Industrial',
  INDSP: 'Industrial',
  INMHM: 'Industrial',
  INMLM: 'Industrial',
  INMMI: 'Industrial',
  INMMU: 'Industrial',
  INWMS: 'Industrial',
  INWMT: 'Industrial',
  INWMU: 'Industrial',
  INWSC: 'Industrial',
  INWTS: 'Industrial',
  INWWH: 'Industrial',
  // --- Mixed-Use (5) ---
  CMCOR: 'Mixed-Use',
  CMMRC: 'Mixed-Use',
  CMOFR: 'Mixed-Use',
  RESMU: 'Mixed-Use',
  RESPL: 'Mixed-Use',
  // --- Agricultural (4) ---
  AGISP: 'Agricultural',
  AGRFS: 'Agricultural',
  AGRFU: 'Agricultural',
  AGRII: 'Agricultural',
  // --- Special Purpose (32) ---
  PIEBM: 'Special Purpose',
  PIECS: 'Special Purpose',
  PIEMA: 'Special Purpose',
  PIETC: 'Special Purpose',
  PIICH: 'Special Purpose',
  PIIDC: 'Special Purpose',
  PIIGC: 'Special Purpose',
  PIIHO: 'Special Purpose',
  PIIJA: 'Special Purpose',
  PIIMB: 'Special Purpose',
  PIINH: 'Special Purpose',
  PIIPF: 'Special Purpose',
  PIIRE: 'Special Purpose',
  PIIRF: 'Special Purpose',
  PIISC: 'Special Purpose',
  PIIUC: 'Special Purpose',
  PIMCE: 'Special Purpose',
  PIMFH: 'Special Purpose',
  PIMLC: 'Special Purpose',
  PIMLI: 'Special Purpose',
  PIRAR: 'Special Purpose',
  PIRBA: 'Special Purpose',
  PIRCC: 'Special Purpose',
  PIRCR: 'Special Purpose',
  PIRGC: 'Special Purpose',
  PIRMU: 'Special Purpose',
  PIRPK: 'Special Purpose',
  PIRPO: 'Special Purpose',
  PIRRI: 'Special Purpose',
  PIRRT: 'Special Purpose',
  PIRST: 'Special Purpose',
  RESGC: 'Special Purpose',
  // --- Infrastructure (15) ---
  ARPRT: 'Infrastructure',
  BSSHL: 'Infrastructure',
  HYDSS: 'Infrastructure',
  MTSSS: 'Infrastructure',
  PERP: 'Infrastructure',
  PSLSS: 'Infrastructure',
  RAILR: 'Infrastructure',
  REFRL: 'Infrastructure',
  SKYWK: 'Infrastructure',
  STATG: 'Infrastructure',
  STATP: 'Infrastructure',
  STATR: 'Infrastructure',
  STATU: 'Infrastructure',
  TRAPI: 'Infrastructure',
  UNKNW: 'Infrastructure',
});

/**
 * Pull the code out of whatever form the field arrives in. Split on the
 * separator rather than a fixed width: almost every code is five
 * letters, but PERP (Personal Property) is four.
 *
 * SABRE exports the bare code ("RESSD"); the live d4mq-wa44 record
 * publishes "RESSD - DETACHED SINGLE DWELLING". One extractor so both
 * sides of the join classify identically — the same rule
 * extract_pucs_code() applies in r/lib_dwelling_units.R.
 */
export function pucsCode(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return '';
  return s.replace(/\s*-.*$/, '').trim();
}

/** Plain name for a code, or '' when we have never seen the code. */
export function pucsName(value) {
  return PUCS_NAMES[pucsCode(value)] || '';
}

/**
 * Category for a code, or null when the code is unknown.
 *
 * Null, never a catch-all bucket. A code the City adds later must read
 * as "we have not classified this" rather than being silently filed
 * under Infrastructure, where it would quietly drop out of every comp
 * search without anyone noticing.
 */
export function pucsCategory(value) {
  return PUCS_CATEGORIES[pucsCode(value)] ?? null;
}

/**
 * The category to actually FILTER a sale on, after the permit record
 * has had its say.
 *
 * The roll's use code describes the parcel as the assessor classified
 * it, which is not always what changed hands on the day:
 *
 *   ALREADY BUILT — a vacant-coded sale with a new-build permit closed
 *     6+ months before it. The house was finished when the lot sold, so
 *     the buyer bought a house. Its category comes from the LIVE roll
 *     (what the parcel is today), because that building is the one that
 *     existed at the sale. Roughly half the vacant-coded sales in the
 *     archive are these, and leaving them in Land is what pulls the
 *     land trend upward — see src/charts/main.js.
 *
 *   TEARDOWN — an improved-coded sale with a demolition permit beside
 *     it. The price bought a lot and a demolition bill, so it belongs
 *     in Land whatever the use code says.
 *
 * The live roll can disagree in a way that is useless (a rebuilt parcel
 * that now reads vacant again, or no live match at all). In that case we
 * fall back to Residential, which is what the overwhelming majority of
 * these are — new-subdivision houses — rather than leaving them in Land,
 * which is the one answer the permit has already ruled out.
 *
 * @param {object} o
 * @param {string} o.saleUseCode   Par Use Code as the sale carried it
 * @param {string} [o.liveUseCode] property_use_code on the parcel today
 * @param {string} [o.buildVerdict] 'already-built' | 'land-then-built' | null
 * @param {string} [o.demoVerdict]  'teardown' | 'confirms-vacant' | null
 * @returns {string|null} category, or null when the code is unknown
 */
export function saleCategory(input) {
  // `= {}` would only cover undefined. null is what a missing row
  // actually looks like coming out of JSON.parse or an IndexedDB
  // record, and one null row throwing here would abort the grid
  // render mid-loop and blank the table.
  const { saleUseCode, liveUseCode, buildVerdict, demoVerdict } = input || {};
  const base = pucsCategory(saleUseCode);
  if (buildVerdict === 'already-built') {
    const live = pucsCategory(liveUseCode);
    if (live && live !== 'Land') return live;
    // No usable live record. Fall back by what the VACANT code itself
    // said was going to be built there: a VRES1/VRES2 lot that got
    // built on is a house (that is the overwhelming majority), but a
    // VCOMM or VINDU lot is not, and filing a new warehouse as
    // Residential would be a worse answer than the one we started
    // with. Land is the one answer the permit has already ruled out,
    // so anything else beats leaving it there.
    const code = pucsCode(saleUseCode);
    if (code === 'VCOMM') return 'Retail-Commercial';
    if (code === 'VINDU') return 'Industrial';
    return 'Residential';
  }
  if (demoVerdict === 'teardown') return 'Land';
  return base;
}
