/**
 * AI_CONTEXT: FL Property Passport — the PUBLIC layer (KV-PUBLIC) of a property.
 *
 * This is the read-side bridge between the property-intelligence engine and the
 * blockchain Title Wallet (docs/PLAN-title-wallet-integration.md). A passport is
 * the verifiable, ANCHORABLE public record a Title Wallet Property Secret pins as
 * its KV-PUBLIC note: a canonical property identity + chain of title + public
 * encumbrances + a deterministic content hash. It carries ONLY public-record data
 * — no closing documents, no private party data.
 *
 * The `contentHash` is the digest that would be written on-chain. Same public
 * facts → same hash, so a later reader can verify the anchored record matches
 * what the county sources say today.
 *
 * Dependencies:
 *   - src/query/fl-property.js (lookupByAddress, lookupByFolio)
 *   - src/query/fl-clerk.js (lookupClerkSignals — Broward encumbrances)
 *   - src/lib/constants.js (flCountyName, isBrowardParcel, DOR_CODES)
 *
 * Exports:
 *   - buildPropertyPassport({ address, city, folio }) → { passport } | { error }
 */

import crypto from 'crypto';
import { lookupByAddress, lookupByFolio } from './fl-property.js';
import { lookupClerkSignals } from './fl-clerk.js';
import { flCountyName, isBrowardParcel, DOR_CODES } from '../lib/constants.js';

// Encumbrance signal types that belong on a public property record (excludes
// soft farming signals like death/probate that aren't property encumbrances).
const ENCUMBRANCE_SIGNALS = new Set(['lis_pendens', 'lien', 'final_judgment', 'mortgage', 'satisfaction']);

export async function buildPropertyPassport({ address, city = '', folio = '' }) {
  // Resolve the parcel of record. Address is the primary path (statewide DOR);
  // folio routes to Miami-Dade GIS (statewide has no folio index).
  let props;
  if (folio) {
    const p = await lookupByFolio(folio);
    props = p ? (Array.isArray(p) ? p : [p]) : [];
  } else if (address) {
    props = await lookupByAddress(address, city);
  } else {
    return { error: 'address (with city) or folio required' };
  }
  if (!props || !props.length) {
    return { error: 'Property not found', query: { address, city, folio } };
  }
  const prop = props[0];

  const coNo = prop.CO_NO;
  const county = flCountyName(coNo);
  const countyKey = county
    ? county.toUpperCase().replace(/[^A-Z0-9]+/g, '-')
    : (coNo ? `CO${coNo}` : 'UNK');
  const propertyId = `FL-${countyKey}-${prop.FOLIO}`;

  // ── Chain of title — from DOR sale records (statewide, all counties). DOR
  // carries the two most recent conveyances with their OR book/page (the deed
  // reference) but not grantor/grantee names. Broward can be enriched with
  // recorded deed parties later; kept source-consistent statewide for v1.
  const chainOfTitle = [];
  for (const s of [prop._sale1, prop._sale2].filter(Boolean)) {
    const yr = parseInt(s.year) || 0;
    if (yr <= 0) continue;
    const mo = s.month ? String(s.month).padStart(2, '0') : null;
    chainOfTitle.push({
      event: 'conveyance',
      date: mo ? `${mo}/${yr}` : String(yr),
      year: yr,
      price: parseInt(s.price) || null,
      deedReference: (s.book && s.page) ? `OR Book ${s.book}, Page ${s.page}` : null,
      source: 'FL Department of Revenue (statewide sales record)',
    });
  }
  chainOfTitle.sort((a, b) => (b.year || 0) - (a.year || 0)); // newest first

  // ── Public encumbrances — Broward only (that is the only recorded-instrument
  // corpus we hold). Name-only matches are advisory; only parcel-CONFIRMED
  // matches are treated as verified and count toward the anchorable hash.
  let encumbrances = [];
  if (isBrowardParcel(coNo, prop.TRUE_SITE_CITY)) {
    const sig = lookupClerkSignals(prop.TRUE_OWNER1 || '', prop.FOLIO);
    encumbrances = sig
      .filter(s => ENCUMBRANCE_SIGNALS.has(s.signal))
      .map(s => ({
        type: s.signal,
        date: s.recordDate,
        caseNum: s.caseNum,
        instrumentNum: s.instrumentNum,
        docType: s.docType,
        verified: s.matchType === 'confirmed',
        matchType: s.matchType,   // 'confirmed' (parcel match) | 'name_match' (advisory)
        recordHash: s.hash,
        source: s.source,
      }));
  }

  const dorCode = String(prop.DOR_CODE_CUR || '').trim();

  // ── Canonical public facts → content hash. Fixed field order + only the
  // stable, verified facts (verified encumbrances only) so the digest is
  // reproducible and anchor-safe. This is what a Property Secret pins on-chain.
  const facts = {
    propertyId,
    address: (prop.TRUE_SITE_ADDR || '').toUpperCase().trim(),
    city: (prop.TRUE_SITE_CITY || '').toUpperCase().trim(),
    county: county || null,
    state: 'FL',
    zip: String(prop.TRUE_SITE_ZIP_CODE || '').slice(0, 5),
    folio: prop.FOLIO || '',
    owner: [prop.TRUE_OWNER1, prop.TRUE_OWNER2].filter(Boolean).join(' & ').toUpperCase().trim(),
    landUse: dorCode,
    chainOfTitle: chainOfTitle.map(c => [c.year, c.price, c.deedReference]),
    encumbrances: encumbrances.filter(e => e.verified).map(e => [e.type, e.date, e.caseNum]),
  };
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');

  // ── Completeness / anchorability
  const hasParcel = !!(prop.FOLIO && prop.TRUE_SITE_ADDR);
  const hasOwner = !!prop.TRUE_OWNER1;
  const hasCounty = !!county;
  const hasChain = chainOfTitle.length > 0;
  const completenessScore = Math.round(
    ((hasParcel ? 0.35 : 0) + (hasOwner ? 0.25 : 0) + (hasChain ? 0.25 : 0) + (hasCounty ? 0.15 : 0)) * 100
  ) / 100;
  // Minimum bar to mint a KV-PUBLIC note: a real, county-identified parcel with
  // a named owner. Chain/encumbrances enrich but aren't required to anchor.
  const anchorable = hasParcel && hasOwner && hasCounty;

  const sources = ['FL Department of Revenue (statewide parcel + sales export)'];
  if (encumbrances.length) sources.push('Broward County Clerk of Courts (SFTP bulk)');

  return {
    passport: {
      version: '1.0',
      propertyId,
      contentHash,
      assembledDate: new Date().toISOString(),
      property: {
        address: prop.TRUE_SITE_ADDR || null,
        city: prop.TRUE_SITE_CITY || null,
        county: county || null,
        state: 'FL',
        zip: prop.TRUE_SITE_ZIP_CODE || null,
        folio: prop.FOLIO || null,
        landUseCode: dorCode || null,
        landUse: DOR_CODES[dorCode] || null,
        yearBuilt: parseInt(prop.YEAR_BUILT) || null,
        lotSizeSqft: parseInt(prop.LOT_SIZE) || null,
      },
      currentOwner: {
        name1: prop.TRUE_OWNER1 || null,
        name2: prop.TRUE_OWNER2 || null,
        source: 'FL DOR (public ownership record)',
      },
      chainOfTitle,
      encumbrances,
      completeness: {
        score: completenessScore,
        hasParcel, hasOwner, hasCounty, hasChainOfTitle: hasChain,
        verifiedEncumbrances: encumbrances.filter(e => e.verified).length,
        advisoryEncumbrances: encumbrances.filter(e => !e.verified).length,
      },
      anchorable,
      provenance: {
        sources,
        note: 'Public-record data only. contentHash is the anchorable digest — the same public facts always produce the same hash, so an anchored record can be re-verified against the county sources.',
      },
      walletBridge: {
        keyVault: 'KV-PUBLIC',
        anchors: contentHash,
        instruction: 'Pin contentHash as the KV-PUBLIC note on a Property Secret (Factory.createSovereignWalletAsNewborn). This passport is the public layer the Title Wallet builds private KeyVaults on top of — see docs/PLAN-title-wallet-integration.md.',
      },
    },
  };
}
