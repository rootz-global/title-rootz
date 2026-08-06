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
import { assemblePropertyIntelligence } from '../src/query/fl-property.js';
import { buildPropertyPassport } from '../src/query/fl-passport.js';
import { farmingSearch } from '../src/query/fl-farming.js';
import { assembleOhioPropertyIntelligence } from '../src/query/oh-property.js';
import { assembleNCPropertyIntelligence, farmNC } from '../src/query/nc-property.js';

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
  })
};
