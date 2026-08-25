/**
 * AI_CONTEXT: Massachusetts property intelligence — assessor + flood for ANY MA address.
 *
 * Revived Jun 21 2026. The MA tool went offline when the service migrated to the
 * title-rootz-v2 stack and the MA engine wasn't ported — the DATA SOURCE (live
 * MassGIS Standardized Assessors' Parcels feature service) was fine the whole time.
 *
 * Source: MassGIS "Massachusetts_Property_Tax_Parcels" ArcGIS FeatureServer (statewide,
 * ~2.4M parcels: owner, assessed values, lot, year built, style, rooms, LAST SALE).
 * Overlays: US Census geocoder (lat/lng) + FEMA National Flood Hazard Layer.
 *
 * Deep deed-chain + title-fraud analysis (the old "title records" tool) is a separate,
 * per-property crawl (data/properties/*.json) — Phase 2; this is the assessor layer.
 *
 * Exports: searchMAProperty(address, town)
 */

import fs from 'fs';
import path from 'path';
import { fetchJSON } from '../lib/fetch.js';
import { MASSGIS_URL } from '../lib/constants.js';
import { DATA_DIR } from '../lib/config.js';

// Load a pre-crawled Registry-of-Deeds title file (data/properties/*.json) for this
// address, if one exists — the deep deed-chain + title analysis layer.
function loadDeedHistory(address, town, siteAddr) {
  try {
    const dir = path.join(DATA_DIR, 'properties');
    if (!fs.existsSync(dir)) return null;
    const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const aSlug = slug(siteAddr || address);
    const tSlug = slug(town);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const hit = files.find(f => f.toLowerCase().includes(aSlug) && (!tSlug || f.toLowerCase().includes(tSlug)))
      || files.find(f => f.toLowerCase().includes(aSlug));
    return hit ? JSON.parse(fs.readFileSync(path.join(dir, hit), 'utf8')) : null;
  } catch { return null; }
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
// Normalize a street for matching: drop suffix + all non-alphanumerics so
// "Lakeshore Dr", "Lake Shore Drive", "LAKE SHORE DR" all compare equal.
const SUFFIX = /\b(RD|ROAD|ST|STREET|AVE|AVENUE|DR|DRIVE|LN|LANE|CT|COURT|WAY|BLVD|PL|PLACE|PKWY|CIR|CIRCLE|TER|TERRACE|HWY|SQ)\b/gi;
const normStreet = s => String(s || '').toUpperCase().replace(SUFFIX, '').replace(/[^A-Z0-9]/g, '');

// MA Dept. of Revenue use codes (common residential).
const USE_CODES = {
  '101': 'Single Family', '1010': 'Single Family', '1040': 'Two-Family', '104': 'Two-Family',
  '1050': 'Three-Family', '105': 'Three-Family', '102': 'Condominium', '1020': 'Condominium',
  '109': 'Multiple Houses', '130': 'Vacant Land (residential)', '1300': 'Vacant Land (residential)',
  '132': 'Vacant Land (residential, undevelopable)', '031': 'Vacant Land',
};

async function massgisQuery(where, count) {
  const params = new URLSearchParams({ where, outFields: '*', returnGeometry: 'false', f: 'json' });
  if (count) params.set('resultRecordCount', String(count));
  const d = await fetchJSON(`${MASSGIS_URL}?${params}`, 12000);
  return d?.features?.map(f => f.attributes) || [];
}

async function lookupParcel(address, town) {
  const TOWN = town.toUpperCase().trim().replace(/'/g, "''");
  const parts = String(address).trim().match(/^(\d+)\s+(.+)$/);
  if (parts) {
    const [, n, street] = parts;
    // Pull all parcels at this number in the town, then match the street client-side
    // (robust to "Lakeshore" vs "Lake Shore" and suffix variants).
    const cands = await massgisQuery(`ADDR_NUM='${n}' AND CITY='${TOWN}'`);
    if (cands.length) {
      const want = normStreet(street);
      return cands.find(a => normStreet(a.FULL_STR || a.SITE_ADDR) === want)
        || cands.find(a => { const f = normStreet(a.FULL_STR || a.SITE_ADDR); return f.includes(want) || want.includes(f); })
        || cands[0];
    }
  }
  // Fallback: SITE_ADDR contains the raw address
  const safe = String(address).toUpperCase().replace(/'/g, "''");
  const cands = await massgisQuery(`SITE_ADDR LIKE '%${safe}%' AND CITY='${TOWN}'`, 5);
  return cands[0] || null;
}

async function geocode(address, town) {
  const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(`${address}, ${town}, MA`)}&benchmark=Public_AR_Current&format=json`;
  const d = await fetchJSON(u, 8000);
  const m = d?.result?.addressMatches?.[0];
  return m ? { lat: m.coordinates.y, lng: m.coordinates.x, matched: m.matchedAddress } : {};
}

async function floodZone(lat, lng) {
  if (!lat || !lng) return { zone: 'UNKNOWN', note: 'No coordinates to query FEMA.' };
  const u = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE&returnGeometry=false&f=json`;
  const d = await fetchJSON(u, 10000);
  const a = d?.features?.[0]?.attributes;
  if (!a) return { zone: 'X', inSFHA: false, note: 'No mapped flood polygon at the point — typically Zone X / minimal hazard. Verify with an Elevation Certificate for waterfront.' };
  return {
    zone: a.FLD_ZONE,
    subtype: a.ZONE_SUBTY || null,
    inSFHA: a.SFHA_TF === 'T',
    baseFloodElevation: a.STATIC_BFE > 0 ? a.STATIC_BFE : null,
    mandatoryFloodInsurance: a.SFHA_TF === 'T',
  };
}

export async function searchMAProperty(address, town) {
  const timestamp = new Date().toISOString();
  if (!town) return { error: 'A town/city is required for MA (e.g. city=Georgetown).', timestamp };
  const a = await lookupParcel(address, town);
  if (!a) return { error: `Property not found in MassGIS: ${address}, ${town}, MA`, timestamp };

  const geo = await geocode(a.SITE_ADDR || address, town);
  const flood = await floodZone(geo.lat, geo.lng);

  const ls = a.LS_DATE ? String(a.LS_DATE) : '';
  const lastSale = ls.length === 8
    ? { date: `${ls.slice(0, 4)}-${ls.slice(4, 6)}-${ls.slice(6, 8)}`, price: num(a.LS_PRICE) }
    : (num(a.LS_PRICE) ? { date: null, price: num(a.LS_PRICE) } : null);

  const ownerNorm = normStreet(a.OWN_ADDR);
  const siteNorm = normStreet(a.SITE_ADDR);

  return {
    address: a.SITE_ADDR, town: a.CITY || town.toUpperCase(), state: 'MA', zip: a.ZIP || '',
    owner: {
      name: a.OWNER1 || '',
      mailingAddress: [a.OWN_ADDR, a.OWN_CITY, [a.OWN_STATE, a.OWN_ZIP].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ownerOccupied: !!(ownerNorm && siteNorm && ownerNorm === siteNorm),
      absentee: !!(ownerNorm && siteNorm && ownerNorm !== siteNorm),
      outOfState: !!(a.OWN_STATE && a.OWN_STATE.toUpperCase() !== 'MA'),
    },
    assessment: {
      fiscalYear: num(a.FY) || null,
      total: num(a.TOTAL_VAL), building: num(a.BLDG_VAL), land: num(a.LAND_VAL), other: num(a.OTHER_VAL),
      landSharePct: num(a.TOTAL_VAL) ? Math.round((num(a.LAND_VAL) / num(a.TOTAL_VAL)) * 100) : null,
    },
    parcel: {
      useCode: a.USE_CODE, useDescription: USE_CODES[String(a.USE_CODE)] || a.USE_CODE,
      style: a.STYLE || null, yearBuilt: num(a.YEAR_BUILT) || null,
      rooms: num(a.NUM_ROOMS) || null, units: num(a.UNITS) || null, stories: num(a.STORIES) || null,
      livingAreaSqFt: num(a.RES_AREA) || null, buildingAreaSqFt: num(a.BLD_AREA) || null,
      lotSize: num(a.LOT_SIZE) || null, lotUnits: a.LOT_UNITS || null, zoning: a.ZONING || null,
    },
    lastSale,
    flood,
    location: geo.lat ? { lat: geo.lat, lng: geo.lng } : null,
    ids: { mapParId: a.MAP_PAR_ID, locId: a.LOC_ID },
    sources: [
      'MassGIS Standardized Assessors’ Parcels (live ArcGIS FeatureServer)',
      'FEMA National Flood Hazard Layer',
      'US Census Geocoder',
    ],
    provenance: 'Government source data, fetched live. Assessor values are as of the listed fiscal year.',
    deedHistory: (() => {
      const deed = loadDeedHistory(address, town, a.SITE_ADDR);
      if (!deed) return {
        available: false,
        note: 'Full recorded deed chain + title-fraud analysis is a per-property Registry-of-Deeds crawl; not yet run for this parcel. The assessor record above reflects the most recent recorded sale only.',
      };
      return {
        available: true,
        confidence: deed.origin?.confidence,
        currentOwner: deed.chainOfTitle?.currentOwner,
        recordCount: deed.registry?.recordCount,
        records: deed.registry?.records,
        encumbrances: deed.encumbrances,
        chainOfTitle: deed.chainOfTitle,
        titleAnalysis: deed.titleAnalysis,
        source: deed.registry?.searchUrl,
      };
    })(),
    timestamp,
  };
}
