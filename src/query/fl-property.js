/**
 * AI_CONTEXT: Florida property intelligence — lookup, investor signals, full assembly
 *
 * Dependencies:
 *   - src/lib/fetch.js (fetchJSON)
 *   - src/lib/config.js (DATA_DIR, CITIES_DIR)
 *   - src/lib/constants.js (MDC_PROPERTY_LAYER, CENSUS_GEOCODER, SSL_CERTS)
 *   - src/query/fl-clerk.js (lookupClerkSignals)
 *   - src/query/fl-overlays.js (getFloodZone, getCensusData, identifyAllLayers, getElevation, etc.)
 *   - src/query/fl-proximity.js (findNearestSchools, findBuildingPermits, etc.)
 *   - src/scoring/farming-score.js (computeFarmingScore)
 *
 * Exports:
 *   - lookupByAddress(address, city) — find property in statewide JSONL or MDC GIS
 *   - lookupByFolio(folio) — Miami-Dade folio lookup
 *   - getInvestorSignals(prop, lat, lng) — investor signal analysis
 *   - assemblePropertyIntelligence(address, city) — FULL property package (orchestrator)
 *
 * This is the "leaf node" — it imports from all other query modules to assemble the complete picture.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fetchJSON } from '../lib/fetch.js';
import { getParcelDb, normAddr } from '../lib/parcel-db.js';
import { DATA_DIR, CITIES_DIR } from '../lib/config.js';
import { MDC_PROPERTY_LAYER, CENSUS_GEOCODER, SSL_CERTS, flCountyName, isBrowardParcel } from '../lib/constants.js';
import { lookupClerkSignals } from './fl-clerk.js';
import { getFloodZone, getCensusData, identifyAllLayers, getElevation, getIRSIncomeByZip, getNFIPClaimsByZip, getFEMADisastersByCounty, getStatewideEconomics, getMarketEconomics, lookupStatwideCensus, lookupCensusBlockGroup } from './fl-overlays.js';
import { findNearestSchools, findBuildingPermits, findNearbyRoadWork, findNearestHospitals, findNearestEVCharging, findNearestTRIFacilities, findNearestEvacuationRoute } from './fl-proximity.js';
import { computeFarmingScore } from '../scoring/farming-score.js';

// ─── Lat/Lng via Census Geocoder ─────────────────────────────────

async function getLatLng(attrs, address, city) {
  if (address && city) {
    const fullAddr = `${address}, ${city}, FL`;
    const params = new URLSearchParams({
      address: fullAddr, benchmark: 'Public_AR_Current',
      vintage: 'Current_Current', format: 'json'
    });
    try {
      const data = await fetchJSON(`${CENSUS_GEOCODER}?${params}`);
      if (data?.result?.addressMatches?.length) {
        const match = data.result.addressMatches[0];
        return { lat: match.coordinates.y, lng: match.coordinates.x };
      }
    } catch { /* fall through */ }
  }
  return { lat: null, lng: null };
}

// ─── Property Lookup by Folio (MDC GIS) ──────────────────────────

export async function lookupByFolio(folio) {
  const params = new URLSearchParams({
    where: `FOLIO='${folio}'`, outFields: '*', returnGeometry: 'false', f: 'json'
  });
  const data = await fetchJSON(`${MDC_PROPERTY_LAYER}?${params}`);
  if (data?.features?.length > 0) {
    const attrs = data.features[0].attributes;
    const coords = await getLatLng(attrs, attrs.TRUE_SITE_ADDR, attrs.TRUE_SITE_CITY);
    return { ...attrs, ...coords };
  }
  return null;
}

// ─── Statewide Address Search (grep JSONL) ───���───────────────────

// Map a parcels.db row back to the exact object shape the grep path produced,
// so everything downstream (assemble, signals, bridge page) is unchanged.
function flRowToRecord(row) {
  return {
    TRUE_SITE_ADDR: row.situs_addr || '', TRUE_SITE_CITY: row.city || '',
    TRUE_SITE_ZIP_CODE: row.situs_zip || '',
    TRUE_OWNER1: row.owner1 || '', TRUE_OWNER2: row.owner2 || '',
    TRUE_MAILING_ADDR1: row.mail_addr || '', TRUE_MAILING_CITY: row.mail_city || '',
    TRUE_MAILING_STATE: row.mail_state || '',
    TRUE_MAILING_ZIP_CODE: row.mail_zip || '',
    FOLIO: row.parcel_id || '',
    DOR_CODE_CUR: row.land_use || '', YEAR_BUILT: row.year_built || 0,
    BUILDING_HEATED_AREA: row.living_area || 0, BUILDING_COUNT: row.bldg_count || 0,
    UNIT_COUNT: row.unit_count || 0, LOT_SIZE: row.lot_sqft || 0,
    BUILDING_VAL_CUR: row.total_val ? row.total_val - (row.land_val || 0) : null,
    LAND_VAL_CUR: row.land_val || null, TOTAL_VAL_CUR: row.total_val || null,
    CO_NO: row.co_no || null,
    _statewide: true,
    _sale1: { price: row.sale1_price, year: row.sale1_year, month: row.sale1_mo, book: row.sale1_book, page: row.sale1_page },
    _sale2: { price: row.sale2_price, year: row.sale2_year, month: row.sale2_mo, book: row.sale2_book, page: row.sale2_page },
    _homestead: row.jv_hmstd > 0,
  };
}

// SQLite index lookup (preferred). Returns array of records, or null if the index
// isn't available so the caller falls back to the legacy grep.
function searchSqliteByAddress(address, city) {
  const db = getParcelDb('florida');
  if (!db) return null;
  const addrUp = normAddr(address);
  const cityUp = city ? city.toUpperCase().trim() : '';
  const parts = addrUp.match(/^(\d+)\s+(.+)$/);
  const pattern = (parts ? `${parts[1]} ${normAddr(parts[2])}` : addrUp.substring(0, 30)) + '%';
  const rows = cityUp
    ? db.prepare('SELECT * FROM parcels WHERE city = ? AND address_norm LIKE ? LIMIT 10').all(cityUp, pattern)
    : db.prepare('SELECT * FROM parcels WHERE address_norm LIKE ? LIMIT 10').all(pattern);
  return rows.map(flRowToRecord);
}

function searchStatewideByAddress(address, city) {
  // Prefer the SQLite index. It's built from the same city files, so when present
  // it's authoritative (fast for both hits and not-founds). Fall back to grep only
  // when the index hasn't been built yet (searchSqliteByAddress returns null).
  const sql = searchSqliteByAddress(address, city);
  if (sql !== null) return sql;
  try {
    const addrUp = address.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
    const cityUp = city ? city.toUpperCase().trim() : '';

    let searchFile;
    if (cityUp && fs.existsSync(CITIES_DIR)) {
      const safeCity = cityUp.replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, '_');
      const cityFile = path.join(CITIES_DIR, `${safeCity}.jsonl`);
      if (fs.existsSync(cityFile)) searchFile = cityFile;
    }
    if (!searchFile) {
      const statewideFile = path.join(DATA_DIR, 'florida', 'statewide-parcels.jsonl');
      if (!fs.existsSync(statewideFile)) return [];
      searchFile = statewideFile;
    }

    const parts = addrUp.match(/^(\d+)\s+(.+)$/);
    let addrPattern;
    if (parts) {
      const [, num, street] = parts;
      addrPattern = `${num} ${street.replace(/[^A-Z0-9 ]/g, '').trim()}`;
    } else {
      addrPattern = addrUp.substring(0, 30);
    }

    const safePattern = addrPattern.replace(/[[\](){}.*+?^$|\\]/g, '\\$&');
    const cmd = `grep -i '"PHY_ADDR1":"${safePattern}' "${searchFile}" | head -10`;
    const result = execSync(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }).toString();

    return result.split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .map(rec => ({
        TRUE_SITE_ADDR: rec.PHY_ADDR1 || '', TRUE_SITE_CITY: rec.PHY_CITY || '',
        TRUE_SITE_ZIP_CODE: rec.PHY_ZIPCD ? String(rec.PHY_ZIPCD) : '',
        TRUE_OWNER1: rec.OWN_NAME || '', TRUE_OWNER2: rec.FIDU_NAME || '',
        TRUE_MAILING_ADDR1: rec.OWN_ADDR1 || '', TRUE_MAILING_CITY: rec.OWN_CITY || '',
        TRUE_MAILING_STATE: rec.OWN_STATE || '',
        TRUE_MAILING_ZIP_CODE: rec.OWN_ZIPCD ? String(rec.OWN_ZIPCD) : '',
        FOLIO: rec.PARCEL_ID || rec.PARCELNO || '',
        DOR_CODE_CUR: rec.DOR_UC || '', YEAR_BUILT: rec.EFF_YR_BLT || rec.ACT_YR_BLT || 0,
        BUILDING_HEATED_AREA: rec.TOT_LVG_AR || 0, BUILDING_COUNT: rec.NO_BULDNG || 0,
        UNIT_COUNT: rec.NO_RES_UNT || 0, LOT_SIZE: rec.LND_SQFOOT || 0,
        BUILDING_VAL_CUR: rec.JV ? rec.JV - (rec.LND_VAL || 0) : null,
        LAND_VAL_CUR: rec.LND_VAL || null, TOTAL_VAL_CUR: rec.JV || null,
        CO_NO: rec.CO_NO || null,
        _statewide: true,
        _sale1: { price: rec.SALE_PRC1, year: rec.SALE_YR1, month: rec.SALE_MO1, book: rec.OR_BOOK1, page: rec.OR_PAGE1 },
        _sale2: { price: rec.SALE_PRC2, year: rec.SALE_YR2, month: rec.SALE_MO2, book: rec.OR_BOOK2, page: rec.OR_PAGE2 },
        _homestead: rec.JV_HMSTD > 0,
      }));
  } catch (e) {
    if (e.status === 1) return [];
    console.error(`Statewide search error: ${e.message}`);
    return [];
  }
}

// ─── Property Lookup by Address ──────────────────────────────────

export async function lookupByAddress(address, city = '') {
  const statewideResults = searchStatewideByAddress(address, city);
  if (statewideResults.length > 0) {
    const first = statewideResults[0];
    const coords = await getLatLng(first, first.TRUE_SITE_ADDR, first.TRUE_SITE_CITY || city);
    return statewideResults.map((rec, i) => ({
      ...rec, lat: i === 0 ? coords.lat : null, lng: i === 0 ? coords.lng : null
    }));
  }

  // Fall back to MDC GIS API
  let where;
  const parts = address.match(/^(\d+)\s+(.+)$/);
  if (parts) {
    const [, num, street] = parts;
    where = `TRUE_SITE_ADDR LIKE '${num} ${street.toUpperCase()}%'`;
    if (city) where += ` AND TRUE_SITE_CITY='${city.toUpperCase()}'`;
  } else {
    where = `TRUE_SITE_ADDR LIKE '%${address.toUpperCase()}%'`;
    if (city) where += ` AND TRUE_SITE_CITY='${city.toUpperCase()}'`;
  }

  const params = new URLSearchParams({
    where, outFields: '*', returnGeometry: 'false', resultRecordCount: '5', f: 'json'
  });
  const data = await fetchJSON(`${MDC_PROPERTY_LAYER}?${params}`);
  if (data?.features?.length > 0) {
    const first = data.features[0].attributes;
    const coords = await getLatLng(first, first.TRUE_SITE_ADDR, first.TRUE_SITE_CITY || city);
    return data.features.map((f, i) => ({
      ...f.attributes, lat: i === 0 ? coords.lat : null, lng: i === 0 ? coords.lng : null
    }));
  }
  return [];
}

// ─── Investor Signals ────────────────────────────────────────────

export async function getInvestorSignals(prop, lat, lng) {
  const signals = {};
  const flags = [];

  const mailState = (prop.TRUE_MAILING_STATE || '').trim().toUpperCase();
  signals.outOfStateOwner = mailState && mailState !== 'FL' && mailState !== 'FLORIDA';
  if (signals.outOfStateOwner) flags.push('Out of State Owner');

  const mailAddr = (prop.TRUE_MAILING_ADDR1 || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const siteAddr = (prop.TRUE_SITE_ADDR || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  signals.absenteeOwner = mailAddr && siteAddr && mailAddr !== siteAddr;
  if (signals.absenteeOwner && !signals.outOfStateOwner) flags.push('Absentee Owner');

  const owner1 = (prop.TRUE_OWNER1 || '').toUpperCase();
  const owner2 = (prop.TRUE_OWNER2 || '').toUpperCase();
  const corpPatterns = ['LLC', 'INC', 'CORP', 'LTD', 'L.L.C', 'HOLDINGS', 'PROPERTIES', 'PARTNERS', 'GROUP', 'VENTURES', 'CAPITAL', 'INVESTMENTS', 'MANAGEMENT'];
  const trustPatterns = ['TRUST', 'TRUSTEE', 'TR ', 'TTEE', 'REVOCABLE', 'IRREVOCABLE', 'LIVING TRUST', 'FAMILY TRUST'];
  signals.corporateOwner = corpPatterns.some(p => owner1.includes(p) || owner2.includes(p));
  signals.trustOwner = trustPatterns.some(p => owner1.includes(p) || owner2.includes(p));
  if (signals.corporateOwner) flags.push('Corporate/LLC Owner');
  if (signals.trustOwner) flags.push('Trust Owner');

  // Sales data from Pictometry (MDC only) or DOR statewide
  let salesData = null;
  if (prop._statewide) {
    salesData = null;
  } else try {
    const picUrl = `https://gisweb.miamidade.gov/arcgis/rest/services/MD_SQLPictometry_Connect/MapServer/0/query`
      + `?where=FOLIO%3D%27${prop.FOLIO}%27`
      + `&outFields=DOS_1,PRICE_1,GRANTOR_1,GRANTEE_1,OR_BK_1,OR_PG_1,DOS_2,PRICE_2,GRANTOR_2,GRANTEE_2,OR_BK_2,OR_PG_2,DOS_3,PRICE_3,GRANTOR_3,GRANTEE_3,OR_BK_3,OR_PG_3,TOTAL_VAL_CUR,TOTAL_VAL_PRI,ASSESSED_VAL_CUR,ASSESSED_VAL_PRI,LAND_VAL_CUR,BUILDING_VAL_CUR,HSTEAD_EX_VAL_CUR,CNTY_SR_EX_VAL_CUR,VETERAN_EX_VAL_CUR,DISABLED_EX_VAL_CUR,WIDOW_EX_VAL_CUR,BLIND_EX_VAL_CUR`
      + `&f=json`;
    const resp = await fetch(picUrl);
    const picData = await resp.json();
    if (picData.features?.[0]) salesData = picData.features[0].attributes;
  } catch { /* sales data is bonus */ }

  // Statewide fallback
  if ((!salesData || !salesData.DOS_1) && prop._statewide) {
    const s1 = prop._sale1 || {};
    const s2 = prop._sale2 || {};
    signals.salesHistory = [];
    if (s1.year && s1.year > 0) {
      signals.salesHistory.push({ date: `${s1.month || '??'}/${s1.year}`, price: s1.price || 0 });
      signals.yearsOwned = new Date().getFullYear() - s1.year;
      signals.lastSaleDate = `${s1.month || '??'}/${s1.year}`;
      signals.lastSalePrice = s1.price || 0;
      if (signals.yearsOwned >= 15) { flags.push('Long-Term Owner (15+ years)'); signals.longTermOwner = true; }
    }
    if (s2.year && s2.year > 0) {
      signals.salesHistory.push({ date: `${s2.month || '??'}/${s2.year}`, price: s2.price || 0 });
    }
    signals.assessedValue = { total: prop.TOTAL_VAL_CUR || 0, land: prop.LAND_VAL_CUR || 0, building: prop.BUILDING_VAL_CUR || 0, source: 'FL DOR Statewide' };
    if (s1.price > 100 && prop.TOTAL_VAL_CUR > 0) {
      const equity = prop.TOTAL_VAL_CUR - s1.price;
      const pct = Math.round(equity / prop.TOTAL_VAL_CUR * 100);
      signals.estimatedEquityDollar = equity;
      signals.estimatedEquityPct = pct;
      if (pct >= 50) { flags.push(`High Equity (${pct}%)`); signals.highEquity = true; }
    }
    if (prop._homestead) signals.homesteadExemption = true;
  }

  if (salesData) {
    const dos1 = salesData.DOS_1;
    if (dos1 && dos1.length === 8) {
      const year = parseInt(dos1.substring(0, 4));
      signals.yearsOwned = new Date().getFullYear() - year;
      signals.lastSaleDate = `${dos1.substring(4,6)}/${dos1.substring(6,8)}/${year}`;
      signals.lastSalePrice = salesData.PRICE_1 || null;
      if (signals.yearsOwned >= 15) { flags.push('Long-Term Owner (15+ years)'); signals.longTermOwner = true; }
    }
    signals.salesHistory = [];
    for (let i = 1; i <= 3; i++) {
      const dos = salesData[`DOS_${i}`];
      if (dos) signals.salesHistory.push({ date: dos, price: salesData[`PRICE_${i}`], grantor: salesData[`GRANTOR_${i}`], grantee: salesData[`GRANTEE_${i}`] });
    }
    signals.assessedValue = { totalCurrent: salesData.TOTAL_VAL_CUR, totalPrior: salesData.TOTAL_VAL_PRI, landValue: salesData.LAND_VAL_CUR, buildingValue: salesData.BUILDING_VAL_CUR };
    if (salesData.TOTAL_VAL_CUR && salesData.PRICE_1 && salesData.PRICE_1 > 100) {
      signals.estimatedEquityPct = Math.round(((salesData.TOTAL_VAL_CUR - salesData.PRICE_1) / salesData.TOTAL_VAL_CUR) * 100);
      if (signals.estimatedEquityPct >= 50) { flags.push('High Equity'); signals.highEquity = true; }
    }
    if (salesData.PRICE_1 && salesData.PRICE_1 <= 100) { flags.push('Nominal Transfer (possible Free & Clear)'); signals.nominalTransfer = true; }
    if (salesData.CNTY_SR_EX_VAL_CUR > 0) { flags.push('Senior Owner (exemption)'); signals.seniorOwner = true; }
    if (salesData.VETERAN_EX_VAL_CUR > 0) { flags.push('Veteran Owner'); signals.veteranOwner = true; }
    if (salesData.DISABLED_EX_VAL_CUR > 0) { flags.push('Disabled Owner (exemption)'); signals.disabledOwner = true; }
    if (salesData.WIDOW_EX_VAL_CUR > 0) { flags.push('Widow/Widower (exemption)'); signals.widowOwner = true; }
    if (salesData.HSTEAD_EX_VAL_CUR > 0) signals.homesteadExemption = true;
  }

  signals.ownerOccupied = !signals.absenteeOwner && !signals.outOfStateOwner;
  if (!signals.ownerOccupied && !signals.outOfStateOwner) flags.push('Possible Investment Property');
  if (!prop.YEAR_BUILT || prop.YEAR_BUILT === 0) {
    if (prop.BUILDING_HEATED_AREA === 0 || !prop.BUILDING_HEATED_AREA) { flags.push('Vacant Lot / No Improvements'); signals.vacantLot = true; }
  }
  if (prop.TRUE_OWNER2 && prop.TRUE_OWNER2.trim()) signals.multipleOwners = true;

  const ownerName = (prop.TRUE_OWNER1 || '').replace(/[^a-zA-Z ]/g, '').trim();
  const ownerCity = (prop.TRUE_SITE_CITY || 'Miami').trim();
  if (ownerName && ownerName.length > 3) {
    signals.ownerLookupUrl = `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(ownerName)}&citystatezip=${encodeURIComponent(ownerCity + ' FL')}`;
  }

  signals.flags = flags;
  signals.flagCount = flags.length;
  return signals;
}

// ─── Assemble Complete Property Intelligence ─────────────────────

export async function assemblePropertyIntelligence(address, city = 'Miami Beach') {
  const timestamp = new Date().toISOString();
  const properties = await lookupByAddress(address, city);
  if (!properties.length) return { error: `Property not found: ${address}, ${city}`, timestamp };

  const prop = properties[0];
  const lat = prop.lat;
  const lng = prop.lng;

  // Run ALL external enrichment calls in parallel. elevation + investor-signals used
  // to run sequentially after this block, stacking their latency onto the cold path;
  // they're independent of flood/census/zoning, so fold them in. (Jun 20 2026)
  // identifyAllLayers hits Miami-Dade GIS and returns a large layer/geometry blob;
  // for the ~majority of FL (statewide, non-MDC) parcels it yields nothing useful
  // yet costs a fetch + a big object held per request (a memory driver under load —
  // commercial-readiness E2). Gate it to Miami-Dade, same as the evac-routes gate.
  const isMDC = String(prop.CO_NO) === '23';
  const [flood, census, layers, elevation, investorSignals] = await Promise.all([
    lat && lng ? getFloodZone(lat, lng) : { zone: 'COORDINATES_UNAVAILABLE' },
    getCensusData(address, city, 'FL'),
    isMDC && lat && lng ? identifyAllLayers(lat, lng) : {},
    getElevation(lat, lng),
    getInvestorSignals(prop, lat, lng)
  ]);

  const zoning = layers['Municipal Zoning']?.[0] || layers['County Zoning']?.[0] || {};
  const schools = findNearestSchools(lat, lng, 3.0);
  const permits = findBuildingPermits(prop.FOLIO, prop.TRUE_SITE_ADDR);
  const hospitals = findNearestHospitals(lat, lng, 15.0);
  const evCharging = findNearestEVCharging(lat, lng, 5.0);
  const triFacilities = findNearestTRIFacilities(lat, lng, 5.0);
  // Evacuation routes are Miami-Dade OEM data (and the matcher isn't distance-
  // bounded), so they may ONLY be attached to Miami-Dade parcels — otherwise
  // every property statewide got MDC routes with an "MDC OEM" source stamp.
  const isMiamiDade = String(prop.CO_NO) === '23';
  const evacuationRoutes = isMiamiDade ? findNearestEvacuationRoute(lat, lng) : null;
  const roadWork = findNearbyRoadWork(lat, lng, 2.0);
  const economics = getMarketEconomics();
  const statewideEcon = getStatewideEconomics(prop.TRUE_SITE_CITY);

  const zip = prop.TRUE_SITE_ZIP_CODE ? String(prop.TRUE_SITE_ZIP_CODE).substring(0, 5) : null;
  const irsIncome = getIRSIncomeByZip(zip);
  const nfipClaims = getNFIPClaimsByZip(zip);
  const femaDisasters = getFEMADisastersByCounty(prop.TRUE_SITE_CITY);

  const ownerName = prop.TRUE_OWNER1 || '';
  // Broward = FL DOR code 16 (the old check used 6, which never matched real
  // data — it only ever worked via the city-name fallback). The Broward Clerk
  // corpus is Broward-only, so court signals attach to Broward parcels only.
  const isBroward = isBrowardParcel(prop.CO_NO, prop.TRUE_SITE_CITY);
  const clerkSignals = isBroward ? lookupClerkSignals(ownerName, prop.FOLIO) : [];
  const farmingScore = computeFarmingScore(investorSignals, clerkSignals, permits);

  let demographics = census;
  if (!census.population && census.tract && census.blockGroup) {
    const swCensus = lookupStatwideCensus(census.tract, census.blockGroup, census.county);
    const cached = swCensus || lookupCensusBlockGroup(census.tract, census.blockGroup);
    if (cached) demographics = { ...census, ...cached, source: cached.source || 'US Census ACS 2022 (cached)' };
  }

  // The parcel of record came from EITHER the DOR statewide export OR live MDC
  // GIS — name the one actually used. Claiming gisweb.miamidade.gov for a DOR
  // parcel in another county is a false origin record (the whole point of this
  // product), so it must be conditional on _statewide.
  const parcelSource = prop._statewide
    ? 'FL Department of Revenue (statewide NAL/SDF parcel export)'
    : 'gisweb.miamidade.gov (Miami-Dade Property Appraiser GIS)';
  const sourceList = [parcelSource, 'hazards.fema.gov', 'api.census.gov', 'geocoding.geo.census.gov'];
  if (elevation) sourceList.push('epqs.nationalmap.gov (USGS elevation)');
  if (schools.public.length) sourceList.push('cached:schools.json (FL DOE)');
  if (permits.length) sourceList.push(`Building permits (${[...new Set(permits.map(p => p.source).filter(Boolean))].join(', ') || 'cached'})`);
  if (hospitals.length) sourceList.push('cached:hospitals.json (CMS Medicare)');
  if (evCharging.length) sourceList.push('cached:ev-charging.json (DOE AFDC)');
  if (triFacilities.length) sourceList.push('cached:epa-tri-facilities.json (EPA TRI)');
  if (evacuationRoutes?.length) sourceList.push('cached:evacuation-routes.json (MDC OEM)');
  if (Object.keys(economics).length || statewideEcon) sourceList.push('FRED/BLS economic data');
  // Pictometry is a Miami-Dade-only sales source; statewide parcels get their
  // sales from the DOR export (already credited above), so don't claim it.
  if (!prop._statewide && investorSignals.salesHistory?.length) sourceList.push('MDC Pictometry (sales/assessed values)');
  if (irsIncome) sourceList.push('IRS SOI (income by zip code)');
  if (nfipClaims) sourceList.push('FEMA NFIP (flood insurance claims)');
  if (femaDisasters) sourceList.push('FEMA (disaster declarations)');
  if (clerkSignals.length) sourceList.push('Broward County Clerk of Courts (SFTP bulk)');

  // Hash a COMPACT set of stable identifying facts, not the whole multi-layer object
  // (E2): stringifying prop+layers+every enrichment allocated a big transient string
  // per request. The digest still uniquely binds the record's core facts.
  const rawData = JSON.stringify({
    id: prop.FOLIO, co: prop.CO_NO, owner: prop.TRUE_OWNER1, addr: prop.TRUE_SITE_ADDR,
    val: prop.TOTAL_VAL_CUR || prop.JV, floodZone: flood?.zone,
    pop: demographics?.population, elev: elevation?.elevationFt, permits: permits.length,
  });
  const docHash = crypto.createHash('sha256').update(rawData).digest('hex');

  let confidence = 0.40;
  if (lat && lng) confidence += 0.10;
  if (flood.zone && flood.zone !== 'UNKNOWN') confidence += 0.10;
  if (demographics.population) confidence += 0.08;
  if (schools.public.length) confidence += 0.05;
  if (permits.length) confidence += 0.05;
  if (elevation) confidence += 0.05;
  if (Object.keys(layers).length > 5) confidence += 0.05;
  if (hospitals.length) confidence += 0.03;
  if (evCharging.length) confidence += 0.02;
  if (triFacilities.length >= 0) confidence += 0.02;
  if (Object.keys(economics).length) confidence += 0.03;
  if (evacuationRoutes) confidence += 0.02;
  if (investorSignals.salesHistory?.length) confidence += 0.03;
  confidence = Math.min(1.0, Math.round(confidence * 100) / 100);

  // Stamp the ACTUAL county (from CO_NO), not a hardcoded Miami-Dade identity.
  const countyName = flCountyName(prop.CO_NO);
  const countyKey = countyName ? countyName.toUpperCase().replace(/[^A-Z0-9]+/g, '-') : (prop.CO_NO ? `CO${prop.CO_NO}` : 'UNK');
  // TLS provenance must list ONLY the endpoints actually used for THIS record —
  // include a cert only when its host appears in the final sourceList (so the
  // Miami-Dade cert no longer signs a Marion County parcel).
  const provenance = {};
  for (const [host, cert] of Object.entries(SSL_CERTS)) {
    if (sourceList.some(s => s.includes(host))) provenance[host] = cert;
  }

  return {
    origin: {
      version: '0.5', state: 'FL', county: countyName || null,
      propertyId: `FL-${countyKey}-${prop.FOLIO}`, folio: prop.FOLIO,
      assembledDate: timestamp, sources: sourceList, dataLayers: sourceList.length,
      documentHash: docHash, provenance, confidence
    },
    property: {
      address: prop.TRUE_SITE_ADDR, city: prop.TRUE_SITE_CITY, state: 'FL',
      zip: prop.TRUE_SITE_ZIP_CODE, folio: prop.FOLIO, coordinates: { lat, lng },
      owner: { name1: prop.TRUE_OWNER1, name2: prop.TRUE_OWNER2 },
      ownerOccupied: prop.TRUE_MAILING_ADDR1 === prop.TRUE_SITE_ADDR,
      building: {
        yearBuilt: prop.YEAR_BUILT, stories: prop.FLOOR_COUNT,
        bedrooms: prop.BEDROOM_COUNT, bathrooms: prop.BATHROOM_COUNT,
        halfBathrooms: prop.HALF_BATHROOM_COUNT, heatedArea: prop.BUILDING_HEATED_AREA,
        grossArea: prop.BUILDING_GROSS_AREA, buildings: prop.BUILDING_COUNT, units: prop.UNIT_COUNT
      },
      lot: { size: prop.LOT_SIZE, unit: 'sqft' },
      classification: {
        dorCode: prop.DOR_CODE_CUR, description: prop.DOR_DESC,
        zoning: zoning.ZONE || prop.PRIMARY_ZONE, zoningDesc: zoning.ZONETEXT || null,
        subdivision: prop.SUBDIVISION, condo: prop.CONDO_FLAG === 'Y'
      }
    },
    flood, elevation: elevation || { elevationFt: null, source: 'USGS query failed' },
    floodRiskAnalysis: elevation && flood.baseFloodElevation ? {
      propertyElevation: elevation.elevationFt, baseFloodElevation: flood.baseFloodElevation,
      marginFt: Math.round((elevation.elevationFt - flood.baseFloodElevation) * 100) / 100,
      risk: elevation.elevationFt >= flood.baseFloodElevation + 3 ? 'LOW — well above BFE' :
            elevation.elevationFt >= flood.baseFloodElevation ? 'MODERATE — at or near BFE' :
            'HIGH — below BFE, significant flood risk'
    } : null,
    demographics,
    schools: { nearestPublic: schools.public, nearbyPrivate: schools.private, nearbyCharter: schools.charter, totalNearby: schools.public.length + schools.private.length + schools.charter.length },
    buildingPermits: { count: permits.length, recentPermits: permits.slice(0, 10), summary: permits.length > 0 ? { types: [...new Set(permits.map(p => p.description).filter(Boolean))], contractors: [...new Set(permits.map(p => p.contractor).filter(Boolean))].slice(0, 5), latestDate: permits[0]?.issueDate || null } : null },
    hospitals: { nearest: hospitals.slice(0, 5), bestRated: [...hospitals].sort((a, b) => (b.cmsRating || 0) - (a.cmsRating || 0)).slice(0, 3), totalNearby: hospitals.length },
    evCharging: { stations: evCharging, totalNearby: evCharging.length },
    environmental: { triFacilities: { nearbyCount: triFacilities.length, facilities: triFacilities, note: triFacilities.length === 0 ? 'No EPA TRI facilities within 5 miles' : `${triFacilities.length} TRI facility(ies) within 5 miles` } },
    safety: { evacuationRoutes, hurricaneEvacZone: prop.EVAC_ZONE || null },
    infrastructure: { nearbyRoadWork: roadWork.slice(0, 5) },
    marketEconomics: statewideEcon || economics,
    federalData: {
      irsIncome: irsIncome ? { zip: irsIncome.zip, totalReturns: irsIncome.returns, averageAGI: irsIncome.avgAGI, source: 'IRS Statistics of Income' } : null,
      floodClaimHistory: nfipClaims ? { totalClaims: nfipClaims.count, totalPaid: nfipClaims.totalPaid, source: 'FEMA NFIP Claims Database' } : null,
      disasterHistory: femaDisasters ? { county: femaDisasters.county, totalDeclarations: femaDisasters.total, source: 'FEMA Disaster Declarations' } : null
    },
    investorSignals: {
      flags: investorSignals.flags, flagCount: investorSignals.flagCount,
      ownerOccupied: investorSignals.ownerOccupied, outOfStateOwner: investorSignals.outOfStateOwner,
      absenteeOwner: investorSignals.absenteeOwner, corporateOwner: investorSignals.corporateOwner,
      trustOwner: investorSignals.trustOwner, longTermOwner: investorSignals.longTermOwner || false,
      yearsOwned: investorSignals.yearsOwned || null, seniorOwner: investorSignals.seniorOwner || false,
      homesteadExemption: investorSignals.homesteadExemption || false,
      highEquity: investorSignals.highEquity || false, estimatedEquityPct: investorSignals.estimatedEquityPct || null,
      vacantLot: investorSignals.vacantLot || false, assessedValue: investorSignals.assessedValue || null,
      salesHistory: investorSignals.salesHistory || [], ownerLookupUrl: investorSignals.ownerLookupUrl || null
    },
    gisLayers: { zoning, layerCount: Object.keys(layers).length, allLayers: Object.keys(layers) },
    courtRecords: clerkSignals.length > 0 ? {
      county: 'Broward', totalFilings: clerkSignals.length,
      signals: clerkSignals.map(s => ({ signal: s.signal, description: s.description, docType: s.docType, recordDate: s.recordDate, instrumentNum: s.instrumentNum, caseNum: s.caseNum, parties: s.parties?.slice(0, 6), hash: s.hash, source: s.source })),
      summary: { lispendens: clerkSignals.filter(s => s.signal === 'lis_pendens').length, probate: clerkSignals.filter(s => s.signal === 'probate').length, liens: clerkSignals.filter(s => s.signal === 'lien').length },
      provenance: { source: 'Broward County Clerk of Courts', method: 'SFTP bulk download', coverage: '1978-present', updateFrequency: 'daily' }
    } : isBroward
      ? { county: 'Broward', note: 'No court filings found for this owner name (2024-2025)' }
      : { county: (prop.TRUE_SITE_CITY || 'Unknown') + ' (not Broward)', note: 'Court records available for Broward County only. Expanding soon.' },
    farmingScore: {
      score: farmingScore.score, rating: farmingScore.rating, reasons: farmingScore.reasons,
      signalCount: farmingScore.signalCount,
      bridgePageUrl: `https://title.rootz.global/p/farm?address=${encodeURIComponent(prop.TRUE_SITE_ADDR || '')}&city=${encodeURIComponent(prop.TRUE_SITE_CITY || '')}`,
      methodology: 'Combines DOR parcel signals + courthouse records + permit activity. Scale 0-100.'
    },
    _rawValue: prop.TOTAL_VAL_CUR || prop.JV || 0
  };
}
