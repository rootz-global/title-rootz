/**
 * MCP tools for title-rootz, served through the epistery facility.
 *
 * `/mcp` was advertised but served by nobody (the old mcp-server/server.mjs is
 * not running; the live src/server.js has no /mcp). This restores it on the live
 * server using the substrate's own tool generators for the catalog, plus the
 * value-add tools below wired to the LIVE query modules — the same functions the
 * HTTP routes already call, so there is one implementation, not a second copy.
 *
 * Only tools whose logic is live are declared here. The dead server's cross-ref
 * (title <-> private/origin) and MA fraud/party/notary tools have no live
 * implementation to bind to; they are a deliberate restore (a later PR that
 * ports that logic out of the retired server), not a silent drop.
 */
import { assemblePropertyIntelligence, lookupByAddress, lookupByFolio } from '../src/query/fl-property.js';
import { buildPropertyPassport } from '../src/query/fl-passport.js';
import { farmingSearch } from '../src/query/fl-farming.js';
import { assembleOhioPropertyIntelligence } from '../src/query/oh-property.js';
import { assembleNCPropertyIntelligence, farmNC } from '../src/query/nc-property.js';
import { isEntityOwner, crossRefPrivateEntity, crossRefPublicEntity, crossRefOwnerIntel } from '../src/query/cross-ref.js';

// Resolve the owner to cross-reference: an explicit name, or the owner of a
// property found by address/folio (via the LIVE fl-property lookups). Returns
// { ownerName, propertyData } — the same resolution the retired mcp-server used.
async function resolveOwner({ owner, address, city, folio }) {
  if (owner) return { ownerName: owner, propertyData: null };
  if (!address && !folio) return { ownerName: null, propertyData: null };
  const props = folio ? [await lookupByFolio(folio)].filter(Boolean) : (await lookupByAddress(address, city || '') || []);
  if (!props.length) return { ownerName: null, propertyData: null };
  const p = props[0];
  return {
    ownerName: p.TRUE_OWNER1,
    propertyData: {
      address: p.TRUE_SITE_ADDR, city: p.TRUE_SITE_CITY, zip: p.TRUE_SITE_ZIP_CODE,
      folio: p.FOLIO, owner1: p.TRUE_OWNER1, owner2: p.TRUE_OWNER2,
      value: p.TOTAL_VAL_CUR, year_built: p.YEAR_BUILT
    }
  };
}

const OWNER_INPUT = {
  type: 'object',
  properties: {
    owner: { type: 'string', description: 'Owner name to analyze' },
    address: { type: 'string', description: 'Or a property address whose owner to analyze' },
    city: { type: 'string' },
    folio: { type: 'string', description: 'Or a folio/parcel id' }
  }
};

/** Value-add tool declarations — the product surface, as agent tools. */
export const valueAddTools = [
  {
    name: 'property_search',
    description:
      'Full property intelligence for a Florida address: owner, assessed value, ' +
      'sales history, courthouse signals, flood zone, census, permits, schools. ' +
      'Government-sourced; each fact names its origin.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address only (no city)' },
        city: { type: 'string' }
      },
      required: ['address']
    }
  },
  {
    name: 'property_passport',
    description:
      'The verifiable PUBLIC property record for a Florida parcel: canonical id, ' +
      'chain of title, public encumbrances, and a content hash that re-verifies ' +
      'against the county source. Give address+city, or folio.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        city: { type: 'string' },
        folio: { type: 'string' }
      }
    }
  },
  {
    name: 'farming_search',
    description:
      'Motivated-seller ("farming") prospects for a Florida city or ZIP, scored ' +
      '0-100 from courthouse and ownership signals. Filter with signals like ' +
      'foreclosure, probate, absentee, out-of-state, corporate, vacant.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        zip: { type: 'string' },
        signals: { type: 'array', items: { type: 'string' } },
        minScore: { type: 'number' },
        limit: { type: 'number', default: 50 }
      }
    }
  },
  {
    name: 'oh_property',
    description: 'Property intelligence for an Ohio address (Franklin, Cuyahoga, Hamilton counties).',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string' }, city: { type: 'string' } },
      required: ['address']
    }
  },
  {
    name: 'nc_property',
    description: 'Property intelligence for a North Carolina address (all 100 counties; Chatham adds deeds).',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string' }, county: { type: 'string' } },
      required: ['address']
    }
  },
  {
    name: 'nc_farm',
    description: 'Motivated-seller list for a North Carolina county (Chatham). Filter with signals, town, score, value, acreage.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string' },
        signals: { type: 'string' },
        town: { type: 'string' },
        minScore: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'cross_ref_entity',
    description:
      'Unmask an LLC/entity property owner: cross-reference the owner name against the ' +
      'Florida business registry (private.rootz.global) for officers, filing date, ' +
      'registered agent, and a succession signal. Give an owner name, or an address/folio.',
    inputSchema: OWNER_INPUT
  },
  {
    name: 'cross_ref_public',
    description:
      'Detect an institutional owner: cross-reference the owner name against SEC public ' +
      'companies (origin.rootz.global) to identify a public company or REIT. ' +
      'Give an owner name, or an address/folio.',
    inputSchema: OWNER_INPUT
  },
  {
    name: 'cross_ref_owner_intel',
    description:
      'Combined owner intelligence: runs the private (entity) and public (SEC) joins and ' +
      'classifies the owner as individual / private_entity / owner_operated / public_company / ' +
      'public_reit, with succession risk and officers where known. Owner name, or an address/folio.',
    inputSchema: OWNER_INPUT
  }
];

/** Handlers, wired to the LIVE query modules. Async — several hit live sources. */
export const valueAddHandlers = {
  property_search: (a = {}) => assemblePropertyIntelligence(a.address, a.city || ''),
  property_passport: (a = {}) => buildPropertyPassport({ address: a.address, city: a.city || '', folio: a.folio || '' }),
  farming_search: (a = {}) => farmingSearch({
    city: a.city, zip: a.zip, signals: a.signals || [],
    limit: parseInt(a.limit, 10) || 50, minScore: parseInt(a.minScore, 10) || 0
  }),
  oh_property: (a = {}) => assembleOhioPropertyIntelligence(a.address, a.city || ''),
  nc_property: (a = {}) => assembleNCPropertyIntelligence(a.address, a.city || '', a.county || ''),
  nc_farm: (a = {}) => farmNC({
    county: a.county || '', signals: a.signals || '', town: a.town || a.city || '',
    minScore: a.minScore, minValue: a.minValue, maxValue: a.maxValue,
    minAcres: a.minAcres, limit: a.limit
  }),

  cross_ref_entity: async (a = {}) => {
    const { ownerName, propertyData } = await resolveOwner(a);
    if (!ownerName) return { error: 'Provide owner name, address, or folio' };
    const isEntity = isEntityOwner(ownerName);
    const entityMatch = await crossRefPrivateEntity(ownerName, 'FL');
    let entityMatch2 = null;
    const owner2 = propertyData?.owner2;
    if (owner2 && isEntityOwner(owner2) && owner2 !== ownerName) {
      entityMatch2 = await crossRefPrivateEntity(owner2, 'FL');
    }
    return {
      property: propertyData, owner_analyzed: ownerName, is_entity: isEntity,
      entity_match: entityMatch, owner2_analyzed: owner2 || null, entity_match2: entityMatch2,
      join: 'title.rootz.global ↔ private.rootz.global'
    };
  },
  cross_ref_public: async (a = {}) => {
    const { ownerName, propertyData } = await resolveOwner(a);
    if (!ownerName) return { error: 'Provide owner name, address, or folio' };
    const match = await crossRefPublicEntity(ownerName);
    return {
      property: propertyData, owner_analyzed: ownerName,
      public_company_match: match, is_reit: match?.is_reit || false,
      join: 'title.rootz.global ↔ origin.rootz.global'
    };
  },
  // The live cross-ref module already owns the combined classification, so this
  // uses it directly rather than re-deriving what the retired server did inline.
  cross_ref_owner_intel: async (a = {}) => {
    const { ownerName, propertyData } = await resolveOwner(a);
    if (!ownerName) return { error: 'Provide owner name, address, or folio' };
    return crossRefOwnerIntel(ownerName, propertyData?.owner2 || '');
  }
};
