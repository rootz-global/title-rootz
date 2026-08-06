/**
 * title-rootz as an @epistery/datasource — the signed catalog layer.
 *
 * This declares title-rootz's public property corpus as a data source the
 * epistery substrate can serve as paged, signed JSON-LD that epistery-scan
 * indexes with no adapter code of its own. It adds the one layer title-rootz
 * did not have — a catalog with provenance carried on every object — and takes
 * nothing away: the farming engine, overlays, cross-refs, billing, chat and
 * bridge pages all keep running (see datasource/README.md for the full map).
 *
 * Trust is NOT manufactured here. A Rootz signature over scraped data only says
 * "Rootz served this" — the bottom rung, worth what you trust Rootz for. What is
 * load-bearing is the origin evidence the collector already found and that this
 * adapter carries verbatim: the per-fact `source` (FL DOR, the county Clerk),
 * the deed book/page references, the confirmed-vs-advisory match honesty, and a
 * deterministic `contentHash` whose only job is to let a reader re-verify the
 * record against the county sources. We provide what we found; scan reports the
 * honest rung; the consumer derives trust at the origin, where it is real.
 *
 * Two collections in this first cut:
 *   parcels       — FL statewide parcels of record (FL DOR NAL export)
 *   encumbrances  — Broward recorded instruments that belong on a public
 *                   property record (liens, lis pendens, judgments, mortgages,
 *                   satisfactions). The soft farming signals (death, probate)
 *                   stay OUT of the public catalog, exactly as fl-passport.js
 *                   already draws that line.
 */
import crypto from 'crypto';
import { defineSource } from '@epistery/datasource';
import { flCountyName, DOR_CODES } from '../src/lib/constants.js';
import { harvest } from './harvest.mjs';

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const up = (v) => String(v || '').toUpperCase().trim();

/** A county slug for the @id, stable across harvests. */
function countySlug(coNo) {
  const name = flCountyName(coNo);
  if (name) return name.toUpperCase().replace(/[^A-Z0-9]+/g, '-');
  return coNo ? `CO${coNo}` : 'UNK';
}

/** Two most-recent conveyances from the DOR sale fields, newest first. */
function chainOfTitle(r) {
  const sales = [
    { price: int(r.SALE_PRC1), year: int(r.SALE_YR1), mo: r.SALE_MO1, book: r.OR_BOOK1, page: r.OR_PAGE1 },
    { price: int(r.SALE_PRC2), year: int(r.SALE_YR2), mo: r.SALE_MO2, book: r.OR_BOOK2, page: r.OR_PAGE2 }
  ];
  return sales
    .filter((s) => s.year > 0)
    .map((s) => ({
      event: 'conveyance',
      year: s.year,
      date: s.mo ? `${String(s.mo).padStart(2, '0')}/${s.year}` : String(s.year),
      price: s.price || null,
      deedReference: (s.book && s.page) ? `OR Book ${s.book}, Page ${s.page}` : null,
      source: 'FL Department of Revenue (statewide sales record)'
    }))
    .sort((a, b) => b.year - a.year);
}

export default defineSource({
  id: 'realestate',
  title: 'Rootz Real Estate — US Parcels & Recorded Instruments',
  description:
    'Parcels of record from government cadastral data, with the public recorded ' +
    'instruments (liens, lis pendens, judgments, mortgages, satisfactions) that ' +
    'sit on a property. Each object names the government source it came from and ' +
    'carries a content hash so it can be re-verified against that source.',
  // One honest umbrella upstream; each object names its specific origin in the
  // body (provenance.sources). The substrate stamps this on every object as
  // `source`, and refuses any object that tries to claim a different one.
  upstream:
    'US county public property records — Florida Dept. of Revenue (parcels & sales) ' +
    'and county Clerks of Court (recorded instruments)',
  role: 'harvest',
  notes: {
    vintage: 'Parcels track the annual FL DOR NAL export; Broward instruments are pulled from the county Clerk SFTP.',
    limits: 'This cut covers Florida parcels statewide and recorded instruments for Broward County only.'
  },

  collections: [
    {
      name: 'parcels',
      type: 'https://epistery.com/schema/Parcel',
      // Period/roll identity is the parcel id within its county. Stable across
      // harvests; a parcel that loses its id is rejected, never stored under a
      // made-up one.
      id: (r) => {
        const pid = r.PARCEL_ID || r.PARCELNO;
        return pid ? `parcel:FL:${countySlug(r.CO_NO)}:${pid}` : null;
      },
      keys: (r) => ({
        folio: r.PARCEL_ID || r.PARCELNO || '',
        city: up(r.PHY_CITY),
        owner: up(r.OWN_NAME),
        zip: String(r.PHY_ZIPCD || '').slice(0, 5),
        county: flCountyName(r.CO_NO) || ''
      }),
      indexed: ['folio', 'city', 'owner', 'zip', 'county'],
      map: (r, keys) => {
        const dor = String(r.DOR_UC || '').trim();
        const jv = int(r.JV);
        const landVal = int(r.LND_VAL);
        const chain = chainOfTitle(r);
        const ownMailAddr = up(r.OWN_ADDR1);
        const phyAddr = up(r.PHY_ADDR1);
        const ownState = up(r.OWN_STATE);

        // Canonical facts → content hash. Fixed field order and only the stable
        // public facts, so the same parcel always hashes the same and a reader
        // can re-verify against the county source. This is the parcel-only
        // digest; the full property passport (parcel + verified encumbrances)
        // is assembled by the value-add route, not here.
        const facts = {
          propertyId: keys.folio ? `FL-${countySlug(r.CO_NO)}-${keys.folio}` : null,
          address: phyAddr,
          city: keys.city,
          county: keys.county || null,
          state: 'FL',
          zip: keys.zip,
          folio: keys.folio,
          owner: [up(r.OWN_NAME), up(r.FIDU_NAME)].filter(Boolean).join(' & '),
          landUse: dor,
          chainOfTitle: chain.map((c) => [c.year, c.price, c.deedReference])
        };
        const contentHash =
          'sha256:' + crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');

        return {
          // Canonical Parcel fields — https://epistery.com/schema/Parcel. The @id
          // (parcel:FL:<county>:<parcelId>) is stamped by the substrate.
          parcelId: keys.folio || null,
          name: phyAddr ? `${r.PHY_ADDR1}${keys.city ? ', ' + keys.city : ''}` : null,
          owner: [r.OWN_NAME, r.FIDU_NAME].filter(Boolean).join(' & ') || null,
          address: {
            streetAddress: r.PHY_ADDR1 || null,
            addressLocality: keys.city || null,
            addressRegion: 'FL',
            postalCode: keys.zip || null
          },
          county: keys.county || null,
          state: 'FL',
          useCode: dor || null,
          useDescription: DOR_CODES[dor] || null,
          marketValue: jv || null,
          landValue: landVal || null,
          yearBuilt: int(r.EFF_YR_BLT) || int(r.ACT_YR_BLT) || null,
          livingArea: int(r.TOT_LVG_AR) || null,
          contentHash,

          // Extensions beyond the base Parcel type — title-rootz's own signals,
          // carried alongside the canonical fields (the type permits extras):
          buildingValue: jv ? jv - landVal : null,
          homestead: int(r.JV_HMSTD) > 0,
          lotSqft: int(r.LND_SQFOOT) || null,
          buildingCount: int(r.NO_BULDNG) || null,
          unitCount: int(r.NO_RES_UNT) || null,
          ownerMailing: {
            streetAddress: ownMailAddr || null,
            addressLocality: r.OWN_CITY || null,
            addressRegion: r.OWN_STATE || null,
            postalCode: r.OWN_ZIPCD ? String(r.OWN_ZIPCD) : null
          },
          absentee: Boolean(ownMailAddr && phyAddr && ownMailAddr !== phyAddr),
          outOfState: Boolean(ownState && ownState !== 'FL' && ownState !== 'FLORIDA'),
          chainOfTitle: chain,

          // The origin evidence we FOUND — not a trust claim we make. Naming the
          // upstream and (where known) how the record was authenticated is the
          // honest part; a consumer verifies at the origin, where trust is real.
          provenance: {
            sources: ['FL Department of Revenue (statewide parcel + sales export)'],
            note:
              'Harvested public-record data, stored as the county source gave it. ' +
              'contentHash is the re-verification digest, not an assertion of correctness.'
          }
        };
      }
    },

    {
      name: 'encumbrances',
      type: 'https://epistery.com/schema/RecordedInstrument',
      id: (r) => (r.instrument_num ? `instrument:broward:${r.instrument_num}` : null),
      keys: (r) => ({
        parcelId: r.parcel_id || '',
        docType: String(r.doc_type || '').toUpperCase(),
        signal: r.signal || ''
      }),
      indexed: ['parcelId', 'docType', 'signal'],
      map: (r) => ({
        instrumentNumber: r.instrument_num,
        recordDate: r.record_date || null,
        docType: r.doc_type || null,
        instrumentType: r.signal || null,
        category: r.category || null,
        caseNumber: r.case_num || null,
        consideration: r.consideration || null,
        parcelId: r.parcel_id || null,
        legalDescription: r.legal_desc || null,
        parties: Array.isArray(r.parties)
          ? r.parties.map((p) => ({
              name: p.party_name,
              // D = direct/grantor (from), R = reverse/grantee (to)
              role: p.party_type === 'D' ? 'grantor' : p.party_type === 'R' ? 'grantee' : p.party_type
            }))
          : [],
        recordHash: r.hash || null,
        provenance: {
          sources: ['Broward County Clerk of Courts (SFTP bulk)'],
          note: 'A publicly recorded instrument, carried as recorded. Party matching to a parcel is reported, not asserted.'
        }
      })
    }
  ],

  // harvest() reads title-rootz's existing government inputs (FL DOR city JSONL
  // + the Broward clerk sqlite) and emits records into the substrate store. It
  // lives in ./harvest.mjs to keep this file pure data-about-the-data.
  harvest
});
