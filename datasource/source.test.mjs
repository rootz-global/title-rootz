/**
 * Unit tests for the realestate source declaration — id(), keys(), map().
 *
 * These run on synthetic records (the real corpus is gitignored and lives on
 * the server), and they exercise exactly the pure functions the catalog calls
 * on read. They assert the two things that must never regress: a stable id, and
 * a map() that carries origin provenance without ever claiming a false upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import source from './source.mjs';

const parcels = source.collection('parcels');
const encumbrances = source.collection('encumbrances');

// A synthetic FL DOR NAL record (Broward = county 16), owner mailing out of state.
const NAL = {
  PARCEL_ID: '514212070260', CO_NO: 16,
  PHY_ADDR1: '1801 SE 17TH ST', PHY_CITY: 'FORT LAUDERDALE', PHY_ZIPCD: '33316',
  OWN_NAME: 'SEASIDE HOLDINGS LLC', FIDU_NAME: '',
  OWN_ADDR1: '500 5TH AVE', OWN_CITY: 'NEW YORK', OWN_STATE: 'NY', OWN_ZIPCD: '10110',
  DOR_UC: '001', JV: 850000, LND_VAL: 300000, JV_HMSTD: 0,
  EFF_YR_BLT: 1998, TOT_LVG_AR: 2400, LND_SQFOOT: 7500, NO_BULDNG: 1, NO_RES_UNT: 1,
  SALE_PRC1: 420000, SALE_YR1: 2012, SALE_MO1: 6, OR_BOOK1: '48000', OR_PAGE1: '123',
  SALE_PRC2: 0, SALE_YR2: 0
};

test('parcels.id is stable, county-scoped, and namespaced', () => {
  assert.equal(parcels.id(NAL), 'parcel:FL:BROWARD:514212070260');
});

test('parcels.id rejects a record with no parcel id', () => {
  assert.equal(parcels.id({ CO_NO: 16 }), null);
});

test('parcels.keys lifts the searchable scalars', () => {
  const k = parcels.keys(NAL);
  assert.equal(k.folio, '514212070260');
  assert.equal(k.city, 'FORT LAUDERDALE');
  assert.equal(k.owner, 'SEASIDE HOLDINGS LLC');
  assert.equal(k.zip, '33316');
  assert.equal(k.county, 'Broward');
});

test('parcels.map projects the canonical Parcel shape with provenance and hash', () => {
  const o = parcels.map(NAL, parcels.keys(NAL));
  // Canonical fields (must match https://epistery.com/schema/Parcel)
  assert.equal(o.parcelId, '514212070260');
  assert.equal(o.name, '1801 SE 17TH ST, FORT LAUDERDALE');
  assert.equal(o.owner, 'SEASIDE HOLDINGS LLC');          // a string, not an object
  assert.equal(o.address.streetAddress, '1801 SE 17TH ST');
  assert.equal(o.address.addressLocality, 'FORT LAUDERDALE');
  assert.equal(o.address.postalCode, '33316');
  assert.equal(o.county, 'Broward');
  assert.equal(o.state, 'FL');
  assert.equal(o.marketValue, 850000);
  assert.equal(o.landValue, 300000);
  assert.equal(o.useDescription, DOR_LABEL(o.useCode));   // label resolved from code
  // Extensions carried alongside the canonical fields
  assert.equal(o.absentee, true);      // mailing addr != site addr
  assert.equal(o.outOfState, true);    // OWN_STATE = NY
  assert.equal(o.buildingValue, 550000);
  assert.equal(o.homestead, false);
  assert.equal(o.chainOfTitle[0].deedReference, 'OR Book 48000, Page 123');
  assert.match(o.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(o.provenance.note.length > 0);
  // map() does NOT stamp `source`; the substrate stamps this collection's origin
  // (FL DOR) and refuses any object claiming an origin the source didn't declare.
  assert.equal(o.source, undefined);
});

test('parcels.map contentHash is deterministic for the same facts', () => {
  const a = parcels.map(NAL, parcels.keys(NAL)).contentHash;
  const b = parcels.map({ ...NAL }, parcels.keys(NAL)).contentHash;
  assert.equal(a, b);
});

// Helper: the label the map resolves from the DOR code, to keep the assertion
// above from hard-coding the vocabulary table.
function DOR_LABEL(code) {
  return parcels.map({ ...NAL, DOR_UC: code }, parcels.keys(NAL)).useDescription;
}

const SIGNAL = {
  instrument_num: '116543210', signal: 'lis_pendens', category: 'foreclosure',
  doc_type: 'LIS PENDENS', record_date: '03/14/2024', case_num: 'CACE24001234',
  consideration: 0, hash: 'abc123', parcel_id: '514212070260', legal_desc: 'LOT 5 BLK 2',
  parties: [
    { party_name: 'DEUTSCHE BANK NA', party_type: 'D' },
    { party_name: 'SEASIDE HOLDINGS LLC', party_type: 'R' }
  ]
};

test('encumbrances.id and map carry the recorded instrument with party roles', () => {
  assert.equal(encumbrances.id(SIGNAL), 'instrument:broward:116543210');
  const o = encumbrances.map(SIGNAL);
  assert.equal(o.instrumentNumber, '116543210');
  assert.equal(o.docType, 'LIS PENDENS');
  assert.equal(o.parcelId, '514212070260');
  assert.equal(o.parties[0].role, 'grantor');
  assert.equal(o.parties[1].role, 'grantee');
  assert.ok(o.provenance.note.length > 0);
  assert.equal(o.source, undefined);
});
