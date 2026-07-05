// Florida Property Intelligence Query Engine
// Queries Miami-Dade GIS + FEMA + Census to build complete property packages
// Used by the MCP server for FL property lookups

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Broward Clerk SQLite (farming signals) ──────────────────────
const CLERK_DB_PATH = path.join(__dirname, 'data', 'broward-clerk', 'farming-signals.db');
let _clerkDb = null;
let _clerkStmts = {};

function getClerkDb() {
  if (_clerkDb) return _clerkDb;
  if (!fs.existsSync(CLERK_DB_PATH)) return null;
  try {
    _clerkDb = new Database(CLERK_DB_PATH, { readonly: true });
    _clerkStmts.byName = _clerkDb.prepare(`
      SELECT s.*, GROUP_CONCAT(p2.party_name, '|') as all_parties
      FROM parties p
      JOIN signals s ON p.instrument_num = s.instrument_num
      LEFT JOIN parties p2 ON s.instrument_num = p2.instrument_num
      WHERE p.party_name_norm = ?
      GROUP BY s.instrument_num
      ORDER BY s.record_date DESC
      LIMIT 50
    `);
    _clerkStmts.byNameLike = _clerkDb.prepare(`
      SELECT s.*, GROUP_CONCAT(p2.party_name, '|') as all_parties
      FROM parties p
      JOIN signals s ON p.instrument_num = s.instrument_num
      LEFT JOIN parties p2 ON s.instrument_num = p2.instrument_num
      WHERE p.party_name_norm LIKE ?
      GROUP BY s.instrument_num
      ORDER BY s.record_date DESC
      LIMIT 50
    `);
    return _clerkDb;
  } catch (e) {
    console.error('Clerk DB init error:', e.message);
    return null;
  }
}

export function lookupClerkSignals(ownerName, parcelId = null) {
  const db = getClerkDb();
  if (!db || !ownerName) return [];
  const norm = ownerName.replace(/[,.\s]+/g, ' ').trim().toUpperCase();
  if (norm.length < 3) return [];
  try {
    // EXACT name match only — no partial/fuzzy matching
    // This reduces false positives (wrong person with similar name)
    const results = _clerkStmts.byName.all(norm);

    return results.map(r => {
      // Determine match confidence
      // parcel_id match = confirmed, exact name = probable, partial = possible
      const hasParcelMatch = parcelId && r.parcel_id && r.parcel_id === parcelId;
      const matchType = hasParcelMatch ? 'confirmed' : 'name_match';

      return {
        signal: r.signal,
        category: r.category,
        description: r.description,
        docType: r.doc_type,
        recordDate: r.record_date,
        instrumentNum: r.instrument_num,
        caseNum: r.case_num || null,
        consideration: r.consideration,
        hash: r.hash,
        parties: (r.all_parties || '').split('|').filter(Boolean),
        matchType, // 'confirmed' (parcel match) or 'name_match' (same name in county)
        matchNote: matchType === 'confirmed'
          ? 'Confirmed — parcel ID matches county records'
          : 'Matched by owner name in Broward County records — verify this filing relates to this specific property',
        source: 'Broward County Clerk of Courts (SFTP bulk)',
        sourceUrl: 'BCFTP.Broward.org'
      };
    });
  } catch (e) {
    return [];
  }
}

// ─── Farming Score Calculator ────────────────────────────────────
export function computeFarmingScore(investorSignals, clerkSignals = [], permits = []) {
  let score = 0;
  const reasons = [];

  // DISTRESSED signals from clerk records (highest weight)
  const activeLP = clerkSignals.filter(s => s.signal === 'lis_pendens');
  const activeProbate = clerkSignals.filter(s => s.signal === 'probate');
  const activeLiens = clerkSignals.filter(s => s.signal === 'lien');
  const judgments = clerkSignals.filter(s => s.signal === 'final_judgment');
  const deaths = clerkSignals.filter(s => s.signal === 'death');

  if (activeLP.length) { score += 25; reasons.push(`Litigation pending — pre-foreclosure filing ${activeLP[0].recordDate}`); }
  if (activeProbate.length) { score += 20; reasons.push(`Probate filing — ${activeProbate[0].recordDate}`); }
  if (activeLiens.length) { score += 15; reasons.push(`${activeLiens.length} lien(s) recorded`); }
  if (judgments.length) { score += 10; reasons.push('Final judgment (foreclosure) entered'); }
  if (deaths.length) { score += 12; reasons.push('Death certificate recorded — estate sale likely'); }

  // VOLUNTARY signals from DOR parcel data
  if (investorSignals) {
    if (investorSignals.absenteeOwner && investorSignals.outOfStateOwner) {
      score += 12; reasons.push('Out-of-state absentee owner');
    } else if (investorSignals.absenteeOwner) {
      score += 10; reasons.push('Absentee owner (in-state)');
    }
    if (investorSignals.corporateOwner) { score += 8; reasons.push('Corporate/LLC owner — investment property'); }
    if (investorSignals.trustOwner) { score += 8; reasons.push('Trust/estate owner'); }
    if (investorSignals.longTermOwner) { score += 8; reasons.push(`Long-term owner (${investorSignals.yearsOwned || '15+'}yr)`); }
    if (investorSignals.highEquity) { score += 6; reasons.push(`High equity (${investorSignals.estimatedEquityPct || '>50'}%)`); }
    if (!investorSignals.homesteadExemption) { score += 5; reasons.push('No homestead — not primary residence'); }
    if (investorSignals.seniorOwner) { score += 4; reasons.push('Senior owner exemption'); }
    if (investorSignals.vacantLot) { score += 2; reasons.push('Vacant lot'); }
  }

  // PERMIT signals — renovation activity
  if (permits.length > 0) {
    const recentPermits = permits.filter(p => {
      const d = p.issueDate || p.PermitDate || p.ApplicationDate;
      if (!d) return false;
      const ts = typeof d === 'number' ? d : Date.parse(d);
      return ts > Date.now() - 365 * 24 * 60 * 60 * 1000; // last 12 months
    });

    if (recentPermits.length > 0) {
      const types = recentPermits.map(p =>
        (p.description || p.ApplicationDescription || p.TYPE || '').toUpperCase()
      );
      // Kitchen/bath/addition = just invested, NOT selling (negative signal)
      const investmentPermits = types.filter(t =>
        t.includes('KITCHEN') || t.includes('ADDITION') || t.includes('POOL') ||
        t.includes('REMODEL') || t.includes('RENOVATION') || t.includes('NEW CONSTRUCTION')
      );
      // Roof/AC/paint = maintenance/prep for sale (positive farming signal)
      const prepPermits = types.filter(t =>
        t.includes('ROOF') || t.includes('AC') || t.includes('HVAC') ||
        t.includes('PAINT') || t.includes('FENCE') || t.includes('WINDOW') ||
        t.includes('DEMOLITION') || t.includes('TERMITE')
      );

      if (investmentPermits.length > 0) {
        score -= 5;
        reasons.push(`Recent investment permits (${investmentPermits.length}) — less likely to sell`);
      }
      if (prepPermits.length > 0) {
        score += 3;
        reasons.push(`Maintenance permits (${prepPermits.length}) — possible prep for sale`);
      }
    }
  }

  // Recent purchase penalty
  if (investorSignals?.yearsOwned && investorSignals.yearsOwned < 3) {
    score -= 5;
    reasons.push('Recent purchase (< 3 years) — less likely to sell');
  }

  // Cap 0-100
  score = Math.max(0, Math.min(100, score));

  // Rating
  const rating = score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';

  return { score, rating, reasons, signalCount: reasons.length };
}

// ─── Farming Search — AI-callable area search with signal filters ─
// Called by AI: /api/fl/farm?lat=X&lng=Y&radius=0.5&signals=probate,lis_pendens&city=FORT_LAUDERDALE
export function farmingSearch({ city, lat, lng, radius = 1.0, signals = [], limit = 50, minScore = 0 }) {
  const cityDir = path.join(__dirname, 'data', 'florida', 'cities');
  const cityUp = (city || '').toUpperCase().replace(/ /g, '_').replace(/[^A-Z0-9_]/g, '');
  const cityFile = path.join(cityDir, `${cityUp}.jsonl`);

  if (!cityUp || !fs.existsSync(cityFile)) {
    return { error: `City not found: ${city}`, availableCities: 'Use /api/fl/farm?list=cities for available cities' };
  }

  // Residential DOR codes only
  const RESIDENTIAL = new Set(["000","001","002","003","004","005","006","007","008","009"]);

  // Government/HOA exclusions
  const EXCLUDE = ["DEPT OF TRANSPORTATION","SCHOOL BOARD","HOUSING AUTHORITY","HOMEOWNERS ASSN","CONDOMINIUM ASSN","MASTER ASSN","STATE OF FLORIDA","UNITED STATES","CITY OF","COUNTY OF","WATER MANAGEMENT"];

  // Haversine distance in miles
  function distMiles(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // Load and filter parcels
  const lines = fs.readFileSync(cityFile, 'utf-8').split('\n');
  const db = getClerkDb();
  const prospects = [];
  const signalSet = new Set(signals.map(s => s.toLowerCase().trim()));
  const filterBySignal = signalSet.size > 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let p;
    try { p = JSON.parse(line); } catch { continue; }

    // Residential only
    const dor = String(p.DOR_UC || '').trim();
    if (!RESIDENTIAL.has(dor)) continue;

    // Exclude government/HOA
    const name = (p.OWN_NAME || '').toUpperCase();
    if (EXCLUDE.some(e => name.includes(e))) continue;

    // Basic scoring from DOR fields
    let score = 0;
    const reasons = [];
    const ownAddr = (p.OWN_ADDR1 || '').trim().toUpperCase();
    const phyAddr = (p.PHY_ADDR1 || '').trim().toUpperCase();
    const ownState = (p.OWN_STATE || '').trim().toUpperCase();
    const hmstd = parseInt(p.AV_HMSTD) || 0;
    const jv = parseInt(p.JV) || 0;
    const sp = parseInt(p.SALE_PRC1) || 0;
    const absentee = ownAddr && phyAddr && ownAddr !== phyAddr;
    const oos = ownState && ownState !== 'FLORIDA' && ownState !== 'FL' && ownState !== '';
    const corp = ["LLC","CORP","INC ","INC.","HOLDINGS","TRUST","ESTATE","BANK"].some(kw => name.includes(kw));

    if (absentee && oos) { score += 12; reasons.push('Out-of-state absentee'); }
    else if (absentee) { score += 10; reasons.push('Absentee owner'); }
    if (corp) { score += 8; reasons.push('Corporate/LLC/Trust'); }
    if (hmstd === 0) { score += 5; reasons.push('No homestead'); }
    if (jv > 0 && sp > 1000 && jv > sp * 2) { score += 6; reasons.push('High equity'); }

    // Clerk signals
    let clerkHits = [];
    if (db && name.length >= 3) {
      const norm = name.replace(/[,.\s]+/g, ' ').trim();
      try {
        const rows = _clerkStmts.byName?.all(norm) || [];
        for (const r of rows) {
          if (!clerkHits.some(h => h.signal === r.signal)) {
            clerkHits.push({ signal: r.signal, date: r.record_date, caseNum: r.case_num });
          }
        }
      } catch {}
    }

    const hasLP = clerkHits.some(h => h.signal === 'lis_pendens');
    const hasProbate = clerkHits.some(h => h.signal === 'probate');
    const hasLien = clerkHits.some(h => h.signal === 'lien');
    const hasJudgment = clerkHits.some(h => h.signal === 'final_judgment');
    const hasDeath = clerkHits.some(h => h.signal === 'death');
    const hasMortgage = clerkHits.some(h => h.signal === 'mortgage');
    const hasSatisfaction = clerkHits.some(h => h.signal === 'satisfaction');

    if (hasLP) { score += 25; reasons.push('Litigation pending (pre-foreclosure)'); }
    if (hasProbate) { score += 20; reasons.push('Probate filing'); }
    if (hasLien) { score += 15; reasons.push('Lien on property'); }
    if (hasJudgment) { score += 10; reasons.push('Foreclosure judgment'); }
    if (hasDeath) { score += 12; reasons.push('Death certificate recorded'); }

    score = Math.min(100, score);
    if (score < minScore) continue;

    // Signal filter — if agent asked for specific signals, only show those
    if (filterBySignal) {
      const propSignals = new Set();
      if (hasLP) propSignals.add('lis_pendens');
      if (hasProbate) propSignals.add('probate');
      if (hasLien) propSignals.add('lien');
      if (hasJudgment) propSignals.add('judgment');
      if (hasDeath) propSignals.add('death');
      if (hasMortgage) propSignals.add('mortgage');
      if (hasSatisfaction) propSignals.add('free_clear');
      if (absentee) propSignals.add('absentee');
      if (oos) propSignals.add('out_of_state');
      if (corp) propSignals.add('corporate');
      if (hmstd === 0) propSignals.add('no_homestead');

      // Check if any requested signal matches
      let matched = false;
      for (const s of signalSet) {
        if (propSignals.has(s)) { matched = true; break; }
      }
      if (!matched) continue;
    }

    // DOR use code descriptions
    const DOR_DESC = {"000":"Vacant Residential","001":"Single Family","002":"Mobile Home","003":"Multi-Family (2-9)","004":"Condo","005":"Co-op","006":"Retirement Home","007":"Misc Residential","008":"Multi-Family (10+)","009":"Non-marketable Residential"};

    // Sale history from DOR
    const sale1Price = parseInt(p.SALE_PRC1) || 0;
    const sale1Year = parseInt(p.SALE_YR1) || 0;
    const sale1Month = p.SALE_MO1 || '';
    const sale2Price = parseInt(p.SALE_PRC2) || 0;
    const sale2Year = parseInt(p.SALE_YR2) || 0;
    const sales = [];
    if (sale1Year > 0) sales.push({ price: sale1Price, date: `${sale1Month}/${sale1Year}`, year: sale1Year });
    if (sale2Year > 0) sales.push({ price: sale2Price, date: `${p.SALE_MO2 || ''}/${sale2Year}`, year: sale2Year });

    // Equity estimate
    const equityDollar = (jv > 0 && sale1Price > 100) ? jv - sale1Price : null;
    const equityPct = (jv > 0 && sale1Price > 100) ? Math.round((jv - sale1Price) / jv * 100) : null;

    prospects.push({
      address: phyAddr,
      city: (p.PHY_CITY || cityUp).replace(/_/g, ' '),
      zip: String(p.PHY_ZIPCD || ''),
      owner: name,
      ownerMailingAddress: {
        address: (p.OWN_ADDR1 || '').trim(),
        city: (p.OWN_CITY || '').trim(),
        state: ownState,
        zip: String(p.OWN_ZIPCD || '').trim()
      },
      value: jv,
      equityEstimate: equityDollar,
      equityPct: equityPct,
      score,
      rating: score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW',
      reasons,
      courtRecords: clerkHits.slice(0, 5),
      salesHistory: sales,
      property: {
        type: DOR_DESC[dor] || dor,
        typeCode: dor,
        yearBuilt: parseInt(p.EFF_YR_BLT || p.ACT_YR_BLT) || null,
        livingArea: parseInt(p.TOT_LVG_AR) || null,
        lotSize: parseInt(p.LND_SQFOOT) || null,
        buildings: parseInt(p.NO_BULDNG) || null,
        units: parseInt(p.NO_RES_UNT) || null
      },
      absentee,
      outOfState: oos,
      corporate: corp,
      homestead: hmstd > 0,
      bridgePageUrl: `https://title.rootz.global/p/farm?address=${encodeURIComponent(phyAddr)}&city=${encodeURIComponent((p.PHY_CITY || cityUp).replace(/_/g, ' '))}`
    });
  }

  // Sort by score descending
  prospects.sort((a, b) => b.score - a.score);

  // If lat/lng provided, filter by radius (requires geocoded addresses — use ZIP as rough filter for now)
  // TODO: pre-geocode addresses for true radius search

  const result = prospects.slice(0, limit);

  return {
    query: { city: cityUp, lat, lng, radius, signals: [...signalSet], minScore, limit },
    total: prospects.length,
    returned: result.length,
    summary: {
      high: prospects.filter(p => p.score >= 70).length,
      medium: prospects.filter(p => p.score >= 40 && p.score < 70).length,
      low: prospects.filter(p => p.score < 40).length
    },
    mapUrl: `https://title.rootz.global/farm/${cityUp.toLowerCase()}${signalSet.size ? '?signals=' + [...signalSet].join(',') : ''}`,
    prospects: result,
    source: {
      parcels: 'FL Department of Revenue (statewide)',
      courtRecords: 'Broward County Clerk of Courts (SFTP bulk)',
      coverage: '2024-2025 court filings + current DOR parcel data',
      provenance: 'Government source data with cryptographic hashing'
    }
  };
}

// ─── Miami-Dade GIS Endpoint ──────────────────────────────────────
const MDC_GIS = 'https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer';
const MDC_PROPERTY_LAYER = `${MDC_GIS}/24/query`;
const MDC_IDENTIFY = `${MDC_GIS}/identify`;

// ─── FEMA Flood ───────────────────────────────────────────────────
const FEMA_FLOOD = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

// ─── Census ───────────────────────────────────────────────────────
const CENSUS_GEOCODER = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
const CENSUS_ACS = 'https://api.census.gov/data/2022/acs/acs5';

// ─── SSL Provenance ───────────────────────────────────────────────
const SSL_CERTS = {
  'gisweb.miamidade.gov': {
    subject: 'CN=gisweb.miamidade.gov, O=Miami-Dade County, ST=Florida, C=US',
    issuer: 'CN=Sectigo Public Server Authentication CA OV R36',
    fingerprint: '78:34:5D:92:96:55:3B:07:44:F2:6D:0C:6B:A0:32:47:3D:4F:2B:FF',
    validTo: '2027-01-30'
  },
  'hazards.fema.gov': {
    subject: 'CN=hazards.fema.gov, O=Federal Emergency Management Agency, C=US',
    issuer: 'CN=DigiCert EV RSA CA G2',
    fingerprint: 'C9:4B:E9:25:7E:4D:62:06:C4:9E:89:F8:99:74:56:38:B4:35:9E:6E',
    validTo: '2026-07-14'
  },
  'api.census.gov': {
    subject: 'CN=api.census.gov, O=U.S. Census Bureau, C=US',
    issuer: 'CN=DigiCert Global G2 TLS RSA SHA256 2020 CA1',
    fingerprint: '5F:01:91:E5:60:77:75:50:87:AF:E6:08:CC:52:FF:A6:60:FF:10:9A',
    validTo: '2027-02-05'
  }
};

// ─── Fetch Helper ─────────────────────────────────────────────────
async function fetchJSON(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const data = await resp.json();
    return data;
  } catch (e) {
    console.error(`Fetch error for ${url.substring(0, 80)}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Centroid from polygon rings ──────────────────────────────────
function getCentroid(geometry) {
  if (!geometry?.rings?.length) return { lat: null, lng: null };
  const ring = geometry.rings[0];
  let sumX = 0, sumY = 0;
  for (const [x, y] of ring) {
    sumX += x;
    sumY += y;
  }
  return { lng: sumX / ring.length, lat: sumY / ring.length };
}

// ─── Use X_COORD/Y_COORD fields + Census geocoder for lat/lng ────
async function getLatLng(attrs, address, city) {
  // Option 1: If the record has X/Y coords (State Plane), use Census geocoder
  if (address && city) {
    const fullAddr = `${address}, ${city}, FL`;
    const params = new URLSearchParams({
      address: fullAddr,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      format: 'json'
    });
    try {
      const data = await fetchJSON(`${CENSUS_GEOCODER}?${params}`);
      if (data?.result?.addressMatches?.length) {
        const match = data.result.addressMatches[0];
        return { lat: match.coordinates.y, lng: match.coordinates.x };
      }
    } catch (e) { /* fall through */ }
  }
  return { lat: null, lng: null };
}

// ─── Property Lookup by Folio ─────────────────────────────────────
export async function lookupByFolio(folio) {
  const params = new URLSearchParams({
    where: `FOLIO='${folio}'`,
    outFields: '*',
    returnGeometry: 'false',
    f: 'json'
  });
  const data = await fetchJSON(`${MDC_PROPERTY_LAYER}?${params}`);
  if (data?.features?.length > 0) {
    const attrs = data.features[0].attributes;
    const coords = await getLatLng(attrs, attrs.TRUE_SITE_ADDR, attrs.TRUE_SITE_CITY);
    return { ...attrs, ...coords };
  }
  return null;
}

// ─── Property Lookup by Address ───────────────────────────────────
// Tries statewide JSONL first (grep-based), falls back to MDC GIS API

function searchStatewideByAddress(address, city) {
  // Use city-indexed files for fast lookup, fall back to full statewide file
  const cityDir = path.join(__dirname, 'data', 'florida', 'cities');
  const statewideFile = path.join(__dirname, 'data', 'florida', 'statewide-parcels.jsonl');

  try {
    // Normalize search terms
    const addrUp = address.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
    const cityUp = city ? city.toUpperCase().trim() : '';

    // Determine which file to search
    let searchFile;
    if (cityUp && fs.existsSync(cityDir)) {
      const safeCity = cityUp.replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, '_');
      const cityFile = path.join(cityDir, `${safeCity}.jsonl`);
      if (fs.existsSync(cityFile)) {
        searchFile = cityFile;
      }
    }
    if (!searchFile) {
      if (!fs.existsSync(statewideFile)) return [];
      searchFile = statewideFile;
    }

    // Build grep pattern — search PHY_ADDR1 field for address
    // Use tight matching: house number + space + street name (no wildcards between number and street)
    const parts = addrUp.match(/^(\d+)\s+(.+)$/);
    let addrPattern;
    if (parts) {
      const [, num, street] = parts;
      // Match exact house number followed by space then street
      // e.g., "1313 NW 11 PL" → grep for '"1313 NW 11'  (tight prefix match)
      const streetClean = street.replace(/[^A-Z0-9 ]/g, '').trim();
      addrPattern = `${num} ${streetClean}`;
    } else {
      addrPattern = addrUp.substring(0, 30);
    }

    // Escape special grep characters
    const safePattern = addrPattern.replace(/[[\](){}.*+?^$|\\]/g, '\\$&');

    // Grep the city-specific file (small, fast) or full statewide file
    const cmd = `grep -i '"PHY_ADDR1":"${safePattern}' "${searchFile}" | head -10`;
    const result = execSync(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }).toString();

    const matches = result.split('\n')
      .filter(l => l.trim())
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      // Map statewide fields to MDC-compatible field names
      .map(rec => ({
        // Map statewide DOR fields → our internal field names
        TRUE_SITE_ADDR: rec.PHY_ADDR1 || '',
        TRUE_SITE_CITY: rec.PHY_CITY || '',
        TRUE_SITE_ZIP_CODE: rec.PHY_ZIPCD ? String(rec.PHY_ZIPCD) : '',
        TRUE_OWNER1: rec.OWN_NAME || '',
        TRUE_OWNER2: rec.FIDU_NAME || '',
        TRUE_MAILING_ADDR1: rec.OWN_ADDR1 || '',
        TRUE_MAILING_CITY: rec.OWN_CITY || '',
        TRUE_MAILING_STATE: rec.OWN_STATE || '',
        TRUE_MAILING_ZIP_CODE: rec.OWN_ZIPCD ? String(rec.OWN_ZIPCD) : '',
        FOLIO: rec.PARCEL_ID || rec.PARCELNO || '',
        DOR_CODE_CUR: rec.DOR_UC || '',
        DOR_DESC: '', // not in statewide data
        YEAR_BUILT: rec.EFF_YR_BLT || rec.ACT_YR_BLT || 0,
        BUILDING_HEATED_AREA: rec.TOT_LVG_AR || 0,
        BUILDING_COUNT: rec.NO_BULDNG || 0,
        UNIT_COUNT: rec.NO_RES_UNT || 0,
        LOT_SIZE: rec.LND_SQFOOT || 0,
        BUILDING_VAL_CUR: rec.JV ? rec.JV - (rec.LND_VAL || 0) : null,
        LAND_VAL_CUR: rec.LND_VAL || null,
        TOTAL_VAL_CUR: rec.JV || null,
        PRIMARY_ZONE: '',
        SUBDIVISION: '',
        CONDO_FLAG: 'N',
        BEDROOM_COUNT: 0, // not in statewide data
        BATHROOM_COUNT: 0,
        HALF_BATHROOM_COUNT: 0,
        FLOOR_COUNT: 0,
        BUILDING_GROSS_AREA: rec.TOT_LVG_AR || 0,
        CO_NO: rec.CO_NO || null,
        // Keep original statewide fields too
        _statewide: true,
        _sale1: { price: rec.SALE_PRC1, year: rec.SALE_YR1, month: rec.SALE_MO1, book: rec.OR_BOOK1, page: rec.OR_PAGE1 },
        _sale2: { price: rec.SALE_PRC2, year: rec.SALE_YR2, month: rec.SALE_MO2, book: rec.OR_BOOK2, page: rec.OR_PAGE2 },
        _quality: rec.IMP_QUAL,
        _construction: rec.CONST_CLAS,
        _homestead: rec.JV_HMSTD > 0,
        _assessedSD: rec.AV_SD,
        _assessedNSD: rec.AV_NSD,
        _taxableSD: rec.TV_SD,
        _taxableNSD: rec.TV_NSD,
      }));

    return matches;
  } catch (e) {
    // grep returns exit code 1 for no matches — that's fine
    if (e.status === 1) return [];
    console.error(`Statewide search error: ${e.message}`);
    return [];
  }
}

export async function lookupByAddress(address, city = '') {
  // Try statewide data first
  const statewideResults = searchStatewideByAddress(address, city);
  if (statewideResults.length > 0) {
    // Get lat/lng via Census geocoder for the first result
    const first = statewideResults[0];
    const coords = await getLatLng(first, first.TRUE_SITE_ADDR, first.TRUE_SITE_CITY || city);
    return statewideResults.map((rec, i) => ({
      ...rec,
      lat: i === 0 ? coords.lat : null,
      lng: i === 0 ? coords.lng : null
    }));
  }

  // Fall back to MDC GIS API (live query)
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
    where,
    outFields: '*',
    returnGeometry: 'false',
    resultRecordCount: '5',
    f: 'json'
  });

  const data = await fetchJSON(`${MDC_PROPERTY_LAYER}?${params}`);
  if (data?.features?.length > 0) {
    const first = data.features[0].attributes;
    const coords = await getLatLng(first, first.TRUE_SITE_ADDR, first.TRUE_SITE_CITY || city);
    return data.features.map((f, i) => ({
      ...f.attributes,
      lat: i === 0 ? coords.lat : null,
      lng: i === 0 ? coords.lng : null
    }));
  }
  return [];
}

// ─── FEMA Flood Zone Query ────────────────────────────────────────
export async function getFloodZone(lat, lng) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID',
    f: 'json'
  });
  const data = await fetchJSON(`${FEMA_FLOOD}?${params}`);
  if (data?.features?.length > 0) {
    const attrs = data.features[0].attributes;
    return {
      zone: attrs.FLD_ZONE,
      subtype: attrs.ZONE_SUBTY,
      specialFloodHazard: attrs.SFHA_TF === 'T',
      baseFloodElevation: attrs.STATIC_BFE > 0 ? attrs.STATIC_BFE : null,
      dfirmId: attrs.DFIRM_ID,
      insuranceRequired: attrs.SFHA_TF === 'T',
      source: 'FEMA NFHL',
      sslCert: SSL_CERTS['hazards.fema.gov']
    };
  }
  return { zone: 'UNKNOWN', source: 'FEMA query returned no results' };
}

// ─── Census Demographics ──────────────────────────────────────────
export async function getCensusData(address, city, state = 'FL', zip = '') {
  // First geocode to get tract/block group
  const fullAddr = `${address}, ${city}, ${state} ${zip}`.trim();
  const params = new URLSearchParams({
    address: fullAddr,
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    format: 'json'
  });

  const geoData = await fetchJSON(`${CENSUS_GEOCODER}?${params}`);
  if (!geoData?.result?.addressMatches?.length) {
    return { error: 'Geocoding failed', address: fullAddr };
  }

  const match = geoData.result.addressMatches[0];
  // Census geocoder returns different geography key names
  const geos = match.geographies || {};
  const blockData = geos['2020 Census Blocks']?.[0] || geos['Census Blocks']?.[0];
  const tractData = geos['Census Tracts']?.[0];
  const countyData = geos['Counties']?.[0];
  const congressData = geos['119th Congressional Districts']?.[0];
  const senateData = geos['2024 State Legislative Districts - Upper']?.[0];
  const houseData = geos['2024 State Legislative Districts - Lower']?.[0];

  const geo = blockData || tractData || countyData;
  if (!geo) return { error: 'No census geography found', availableKeys: Object.keys(geos) };

  const tract = (tractData || blockData)?.TRACT || geo.TRACT;
  const blockGroup = blockData?.BLKGRP || '1';
  const county = (countyData || geo)?.COUNTY || geo.COUNTY;
  const stateCode = geo.STATE || '12';
  const lat = match.coordinates.y;
  const lng = match.coordinates.x;

  // Pull ACS data for this block group
  const acsUrl = `${CENSUS_ACS}?get=B19013_001E,B01003_001E,B25077_001E,B25064_001E,B25003_001E,B25003_002E,B01002_001E,B19301_001E,B25002_001E,B25002_002E,B25002_003E&for=block%20group:${blockGroup}&in=state:${stateCode}+county:${county}+tract:${tract}`;

  const acsData = await fetchJSON(acsUrl);
  if (!acsData || acsData.length < 2) return { error: 'ACS data not available', tract, blockGroup };

  const values = acsData[1];
  const occupied = parseInt(values[8]) || 0;
  const ownerOcc = parseInt(values[5]) || 0;

  return {
    coordinates: { lat, lng },
    tract,
    blockGroup,
    county,
    state: stateCode,
    congressionalDistrict: congressData?.BASENAME || congressData?.NAME || null,
    stateSenate: senateData?.BASENAME || senateData?.NAME || null,
    stateHouse: houseData?.BASENAME || houseData?.NAME || null,
    population: parseInt(values[1]) || null,
    medianAge: parseFloat(values[6]) || null,
    medianHouseholdIncome: parseInt(values[0]) || null,
    perCapitaIncome: parseInt(values[7]) || null,
    medianHomeValue: parseInt(values[2]) || null,
    medianRent: parseInt(values[3]) || null,
    totalHousingUnits: parseInt(values[8]) || null,
    occupiedHousing: occupied,
    vacantHousing: parseInt(values[10]) || null,
    ownerOccupied: ownerOcc,
    ownerOccupiedRate: occupied > 0 ? Math.round((ownerOcc / occupied) * 100) : null,
    source: 'US Census ACS 2022 (Block Group level)',
    sslCert: SSL_CERTS['api.census.gov']
  };
}

// ─── Miami-Dade Identify (all layers at a point) ──────────────────
export async function identifyAllLayers(lat, lng) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    sr: '4326',
    layers: 'all',
    tolerance: '10',
    mapExtent: `${lng - 0.01},${lat - 0.01},${lng + 0.01},${lat + 0.01}`,
    imageDisplay: '400,300,96',
    returnGeometry: 'false',
    f: 'json'
  });

  const data = await fetchJSON(`${MDC_IDENTIFY}?${params}`, 20000);
  if (!data?.results) return {};

  const result = {};
  for (const r of data.results) {
    const layerName = r.layerName || `Layer_${r.layerId}`;
    if (!result[layerName]) result[layerName] = [];
    result[layerName].push(r.attributes);
  }
  return result;
}

// ─── USGS Elevation Query ─────────────────────────────────────────
export async function getElevation(lat, lng) {
  if (!lat || !lng) return null;
  try {
    const url = `https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&wkid=4326&units=Feet&includeDate=false`;
    const data = await fetchJSON(url);
    const elevation = parseFloat(data?.value);
    if (isNaN(elevation)) return null;
    return {
      elevationFt: Math.round(elevation * 100) / 100,
      source: 'USGS 3DEP Elevation Point Query Service (1-meter LiDAR)',
      note: elevation < 5 ? 'VERY LOW — at risk during king tides and storm surge' :
            elevation < 10 ? 'LOW — typical for coastal Miami-Dade' :
            elevation < 20 ? 'MODERATE — above most flood levels' :
            'HIGH — well above flood risk'
    };
  } catch {
    return null;
  }
}

// ─── Cached Overlay Data Lookups ──────────────────────────────────

// Load data file (JSON or CSV, cached on first load)
const dataCache = {};
function loadDataFile(filename) {
  if (dataCache[filename]) return dataCache[filename];
  const filePath = path.join(__dirname, 'data', 'florida', filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    if (filename.endsWith('.csv')) {
      // Return raw CSV string for CSV files
      const raw = fs.readFileSync(filePath, 'utf-8');
      dataCache[filename] = raw;
      return raw;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    dataCache[filename] = data;
    return data;
  } catch (e) {
    console.error(`Failed to load ${filename}: ${e.message}`);
    return null;
  }
}

// Haversine distance helper (used by all proximity functions)
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Find nearest schools to a lat/lng — tries statewide HIFLD, falls back to MDC
export function findNearestSchools(lat, lng, maxDistance = 3.0) {
  const results = { public: [], private: [], charter: [] };
  if (!lat || !lng) return results;

  // Try statewide public schools (NCES EDGE format: LAT/LON/STREET/NMCNTY)
  const swPublic = loadDataFile('statewide-schools-public.json');
  if (swPublic && swPublic.length > 0) {
    const nearby = swPublic
      .filter(s => (s.LAT || s.LATITUDE) && (s.LON || s.LONGITUDE))
      .map(s => {
        const sLat = s.LAT || s.LATITUDE;
        const sLng = s.LON || s.LONGITUDE;
        return {
          name: (s.NAME || '').trim(),
          address: (s.STREET || s.ADDRESS || '').trim(),
          city: (s.CITY || '').trim(),
          county: (s.NMCNTY || s.COUNTY || '').trim(),
          enrollment: s.ENROLLMENT || s.POPULATION || null,
          locale: s.LOCALE || null,
          ncessch: s.NCESSCH || null,
          distance: Math.round(distanceMiles(lat, lng, sLat, sLng) * 100) / 100
        };
      })
      .filter(s => s.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);
    results.public = nearby;
  } else {
    // Fall back to MDC schools.json
    const schools = loadDataFile('schools.json');
    if (schools) {
      const nearby = schools
        .filter(s => s._lat && s._lng)
        .map(s => ({
          name: (s.NAME || '').trim(),
          address: (s.ADDRESS || '').trim(),
          city: (s.CITY || '').trim(),
          type: s.TYPE,
          grades: s.GRADES,
          enrollment: s.ENROLLMNT,
          capacity: s.CAPACITY,
          phone: (s.PHONE || '').trim(),
          distance: Math.round(distanceMiles(lat, lng, s._lat, s._lng) * 100) / 100
        }))
        .filter(s => s.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance);
      const elementary = nearby.find(s => s.type === 'E');
      const middle = nearby.find(s => s.type === 'M' || s.type === 'K');
      const high = nearby.find(s => s.type === 'S');
      results.public = [elementary, middle, high].filter(Boolean);
    }
  }

  // Try statewide private schools (NCES format)
  const swPrivate = loadDataFile('statewide-schools-private.json');
  if (swPrivate && swPrivate.length > 0) {
    results.private = swPrivate
      .filter(s => (s.LAT || s.LATITUDE) && (s.LON || s.LONGITUDE))
      .map(s => {
        const sLat = s.LAT || s.LATITUDE;
        const sLng = s.LON || s.LONGITUDE;
        return {
          name: (s.NAME || '').trim(),
          address: (s.STREET || s.ADDRESS || '').trim(),
          city: (s.CITY || '').trim(),
          distance: Math.round(distanceMiles(lat, lng, sLat, sLng) * 100) / 100
        };
      })
      .filter(s => s.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
  } else {
    const privSchools = loadDataFile('private-schools.json');
    if (privSchools) {
      results.private = privSchools
        .filter(s => s._lat && s._lng)
        .map(s => ({
          name: (s.NAME || '').trim(),
          address: (s.ADDRESS || '').trim(),
          city: (s.CITY || '').trim(),
          grades: s.GRDSPAN,
          distance: Math.round(distanceMiles(lat, lng, s._lat, s._lng) * 100) / 100
        }))
        .filter(s => s.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);
    }
  }

  // Charter schools (MDC only for now)
  const charters = loadDataFile('charter-schools.json');
  if (charters) {
    results.charter = charters
      .filter(s => s._lat && s._lng)
      .map(s => ({
        name: (s.NAME || '').trim(),
        address: (s.ADDRESS || '').trim(),
        distance: Math.round(distanceMiles(lat, lng, s._lat, s._lng) * 100) / 100
      }))
      .filter(s => s.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
  }

  return results;
}

// Normalize Miami-Dade address for matching across systems
function normalizeAddress(addr) {
  if (!addr) return '';
  addr = String(addr).trim().toUpperCase();
  // Collapse multiple spaces
  addr = addr.replace(/\s+/g, ' ');
  // Remove ordinal suffixes: 185TH -> 185, 2ND -> 2
  addr = addr.replace(/(\d+)(ST|ND|RD|TH)\b/g, '$1');
  // Remove trailing qualifiers (BR, BT, FL, etc)
  addr = addr.replace(/\s+(BR|BT|FL|BLDG|APT|STE|UNIT|#)\s*\S*$/, '');
  return addr.trim();
}

// Build permit address index (lazy, cached) — merges county + city permits
let _permitAddrIndex = null;
let _permitFolioIndex = null;
function getPermitIndices() {
  if (_permitAddrIndex) return { addr: _permitAddrIndex, folio: _permitFolioIndex };

  _permitAddrIndex = {};
  _permitFolioIndex = {};

  // Load COUNTY permits (unincorporated Miami-Dade)
  const countyPermits = loadDataFile('building-permits.json') || [];
  for (const p of countyPermits) {
    p._source = 'county';
    const addr = normalizeAddress(p.ADDRESS);
    if (addr && addr.length > 5) {
      if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
      _permitAddrIndex[addr].push(p);
    }
    const folio = String(p.FOLIO || '').trim();
    if (folio && folio !== 'None') {
      if (!_permitFolioIndex[folio]) _permitFolioIndex[folio] = [];
      _permitFolioIndex[folio].push(p);
    }
    const geofolio = String(p.GEOFOLIO || '').trim();
    if (geofolio && geofolio !== 'None' && geofolio !== folio) {
      if (!_permitFolioIndex[geofolio]) _permitFolioIndex[geofolio] = [];
      _permitFolioIndex[geofolio].push(p);
    }
  }

  // Load CITY OF MIAMI permits
  const cityPermits = loadDataFile('miami-city-permits.json') || [];
  for (const p of cityPermits) {
    p._source = 'city_of_miami';
    // City permits use FolioNumber field and DeliveryAddress
    const addr = normalizeAddress(p.DeliveryAddress);
    if (addr && addr.length > 5) {
      if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
      _permitAddrIndex[addr].push(p);
    }
    // City folio needs zero-padding to 13 chars to match GIS
    const folio = String(p.FolioNumber || '').trim();
    if (folio) {
      const paddedFolio = folio.padStart(13, '0');
      if (!_permitFolioIndex[paddedFolio]) _permitFolioIndex[paddedFolio] = [];
      _permitFolioIndex[paddedFolio].push(p);
      // Also index the raw folio
      if (!_permitFolioIndex[folio]) _permitFolioIndex[folio] = [];
      _permitFolioIndex[folio].push(p);
    }
  }

  // Load FORT LAUDERDALE permits (Broward County)
  const ftlPermits = loadDataFile('broward-fort-lauderdale-permits.json') || [];
  for (const p of ftlPermits) {
    p._source = 'fort_lauderdale';
    const addr = normalizeAddress(p.FULLADDR);
    if (addr && addr.length > 5) {
      if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
      _permitAddrIndex[addr].push(p);
    }
    const parcel = String(p.PARCELID || '').trim();
    if (parcel && parcel !== 'None') {
      if (!_permitFolioIndex[parcel]) _permitFolioIndex[parcel] = [];
      _permitFolioIndex[parcel].push(p);
    }
  }

  // Load PALM BAY permits (Brevard County)
  const pbPermits = loadDataFile('brevard-palm-bay-permits.json') || [];
  for (const p of pbPermits) {
    p._source = 'palm_bay';
    const addr = normalizeAddress(p.ADDRESS);
    if (addr && addr.length > 5) {
      if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
      _permitAddrIndex[addr].push(p);
    }
    const renum = String(p.Renum || '').trim();
    if (renum) {
      if (!_permitFolioIndex[renum]) _permitFolioIndex[renum] = [];
      _permitFolioIndex[renum].push(p);
    }
  }

  // Load HILLSBOROUGH permits (Accela crawl)
  const hcPermits = loadDataFile('accela-hillsborough-permits.json') || [];
  for (const p of hcPermits) {
    p._source = 'hillsborough';
    const addr = normalizeAddress(p.Address || p.address || '');
    if (addr && addr.length > 5) {
      if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
      _permitAddrIndex[addr].push(p);
    }
  }

  // Load CHARLOTTE COUNTY new construction permits
  const charlottePermits = loadPermitFile('permits/charlotte-new-construction.json') || [];
  for (const p of charlottePermits) {
    p._source = 'charlotte';
    const addr = normalizeAddress(p.PermitAddress || '');
    if (addr && addr.length > 5) {
      if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
      _permitAddrIndex[addr].push(p);
    }
    const parcel = String(p.ParcelNumber || '').trim();
    if (parcel) {
      if (!_permitFolioIndex[parcel]) _permitFolioIndex[parcel] = [];
      _permitFolioIndex[parcel].push(p);
    }
  }

  // Load LEON/TALLAHASSEE active permits
  const leonPermits = loadPermitFile('permits/leon-tallahassee-active.json') || [];
  for (const p of leonPermits) {
    p._source = 'leon';
    const addr = normalizeAddress(p.OriginalAddress1 || '');
    if (addr && addr.length > 5) {
      if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
      _permitAddrIndex[addr].push(p);
    }
    const pin = String(p.PIN || '').trim();
    if (pin) {
      if (!_permitFolioIndex[pin]) _permitFolioIndex[pin] = [];
      _permitFolioIndex[pin].push(p);
    }
  }

  const totalPermits = countyPermits.length + cityPermits.length + ftlPermits.length + pbPermits.length + hcPermits.length + charlottePermits.length + leonPermits.length;
  console.log(`Permit index built: ${Object.keys(_permitAddrIndex).length} addresses, ${Object.keys(_permitFolioIndex).length} folios`);
  console.log(`  Sources: MDC ${countyPermits.length}, Miami City ${cityPermits.length}, Ft Lauderdale ${ftlPermits.length}, Palm Bay ${pbPermits.length}, Hillsborough ${hcPermits.length}, Charlotte ${charlottePermits.length}, Leon ${leonPermits.length} = ${totalPermits} total`);
  return { addr: _permitAddrIndex, folio: _permitFolioIndex };
}

// Load permit file from permits/ subdirectory
function loadPermitFile(filename) {
  const filePath = path.join(__dirname, 'data', 'florida', filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`Failed to load ${filename}: ${e.message}`);
    return null;
  }
}

// Find building permits for a property by folio or address
export function findBuildingPermits(folio, address) {
  const { addr: addrIndex, folio: folioIndex } = getPermitIndices();

  let matches = [];

  // Try folio first
  if (folio) {
    matches = folioIndex[folio] || [];
  }

  // Fall back to normalized address
  if (!matches.length && address) {
    const normAddr = normalizeAddress(address);
    matches = addrIndex[normAddr] || [];
  }

  return matches.map(p => {
    const src = p._source || 'county';

    // Normalize output across all county formats
    if (src === 'fort_lauderdale') {
      return {
        processNumber: p.PERMITID || '',
        address: (p.FULLADDR || '').trim(),
        folio: p.PARCELID || '',
        type: p.PERMITTYPE || '',
        description: p.PERMITDESC || '',
        status: p.PERMITSTAT || '',
        estimatedValue: parseInt(p.ESTCOST) || null,
        contractor: (p.CONTRACTOR || '').trim(),
        owner: (p.OWNERNAME || '').trim(),
        issueDate: p.SUBMITDT ? new Date(parseInt(p.SUBMITDT)).toISOString().split('T')[0] : null,
        approvedDate: p.APPROVEDT ? new Date(parseInt(p.APPROVEDT)).toISOString().split('T')[0] : null,
        useClass: p.USECLASS || '',
        coordinates: p._lat && p._lng ? { lat: p._lat, lng: p._lng } : null,
        source: 'Fort Lauderdale Building Permits'
      };
    }

    if (src === 'palm_bay') {
      return {
        processNumber: (p.ApplicationNumber || '').trim(),
        address: (p.ADDRESS || '').trim(),
        folio: p.Renum || '',
        type: p.ApplicationType || p.PermitType || '',
        description: p.ApplicationDescription || '',
        status: p.PermitStatus || '',
        estimatedValue: parseInt(p.EstimateValuation) || null,
        issueDate: p.issueDate ? new Date(parseInt(p.issueDate)).toISOString().split('T')[0] : null,
        permitDate: p.PermitDate ? new Date(parseInt(p.PermitDate)).toISOString().split('T')[0] : null,
        coordinates: p._lat && p._lng ? { lat: p._lat, lng: p._lng } : null,
        source: 'Palm Bay Building Permits'
      };
    }

    if (src === 'hillsborough') {
      return {
        processNumber: p['Record Number'] || p.recordNumber || '',
        address: p.Address || p.address || '',
        type: p['Record Type'] || p.recordType || '',
        description: p.Description || p.description || '',
        status: '',
        issueDate: p.Date || p.date || null,
        coordinates: null,
        source: 'Hillsborough County (Accela)'
      };
    }

    if (src === 'charlotte') {
      return {
        processNumber: p.PermitNumber || p.CAP || '',
        address: (p.PermitAddress || p.Address || '').trim(),
        folio: p.ParcelNumber || '',
        type: p.PermitTypeDesc || p.Type || '',
        description: p.B1_PER_CATEGORY || p.Category || '',
        status: p.CurrentPermitStatus || p.Status_1 || '',
        estimatedValue: parseInt(p.Value) || null,
        contractor: (p.ContractorBusinessName || p.Inspector || '').trim(),
        issueDate: p.IssueDate ? new Date(parseInt(p.IssueDate)).toISOString().split('T')[0] : null,
        coordinates: null,
        source: 'Charlotte County Building Permits'
      };
    }

    if (src === 'leon') {
      return {
        processNumber: p.PermitNum || '',
        address: (p.OriginalAddress1 || '').trim(),
        folio: p.PIN || '',
        type: p.PermitTypeMapped || p.PermitType || '',
        description: p.Description || '',
        status: p.StatusCurrent || '',
        estimatedValue: parseInt(p.EstProjectCost) || null,
        contractor: (p.ContractorCompanyName || '').trim(),
        contractorPhone: p.ContractorPhone || '',
        contractorEmail: p.ContractorEmail || '',
        issueDate: p.IssuedDate ? new Date(parseInt(p.IssuedDate)).toISOString().split('T')[0] : null,
        sqft: parseInt(p.TotalSqFt) || null,
        units: parseInt(p.HousingUnits) || null,
        source: 'Leon County / Tallahassee Building Permits'
      };
    }

    // Default: MDC county + City of Miami format
    return {
      processNumber: (p.PROCNUM || '').trim(),
      address: (p.STNDADDR || p.ADDRESS || p.DeliveryAddress || '').trim(),
      folio: p.FOLIO || p.GEOFOLIO || p.FolioNumber || '',
      type: (p.TYPE || '').trim(),
      description: (p.DESC1 || '').trim(),
      description2: (p.DESC2 || '').trim(),
      status: (p.BPSTATUS || '').trim(),
      residentialCommercial: p.RESCOMM === 'R' ? 'Residential' : p.RESCOMM === 'C' ? 'Commercial' : p.RESCOMM,
      estimatedValue: parseInt(p.ESTVALUE) || null,
      contractor: (p.CONTRNAME || '').trim(),
      contractorNum: (p.CONTRNUM || '').trim(),
      issueDate: p.ISSUDATE ? new Date(parseInt(p.ISSUDATE)).toISOString().split('T')[0] : null,
      completionDate: p.BLDCMPDT && p.BLDCMPDT !== '00000000' ? p.BLDCMPDT : null,
      propertyUse: p.PROPUSE,
      coordinates: p._lat && p._lng ? { lat: p._lat, lng: p._lng } : null,
      source: src === 'city_of_miami' ? 'City of Miami' : 'Miami-Dade County'
    };
  }).sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));
}

// Find nearby road improvements
export function findNearbyRoadWork(lat, lng, maxDistanceMiles = 2.0) {
  const roads = loadDataFile('road-improvements.json');
  if (!roads || !lat || !lng) return [];

  // Road improvements are polygons — check if any have centroid-like coords
  // For now return all projects (they're county-wide reference data)
  return roads.slice(0, 20).map(r => ({
    agency: (r.AGENCY || '').trim(),
    location: (r.LOCATION || '').trim(),
    project: (r.PROJECT || '').trim(),
    status: (r.STATUS || '').trim(),
    consultant: (r.CONSULTANT || '').trim(),
    constructionDate: (r.CONSTDATE || '').trim()
  })).filter(r => r.location || r.project);
}

// Find nearest hospitals (CMS Medicare ratings)
// Hospital coords loaded from CMS raw CSV or geocoded; if missing, geocode from address
const _hospitalCoords = {
  // Pre-cached coordinates for Miami-Dade hospitals
  'BAPTIST HOSPITAL OF MIAMI': { lat: 25.6840, lng: -80.3390 },
  'JACKSON HEALTH SYSTEM': { lat: 25.7900, lng: -80.2105 },
  'MOUNT SINAI MEDICAL CENTER': { lat: 25.8126, lng: -80.1336 },
  'DOCTORS HOSPITAL': { lat: 25.7228, lng: -80.2725 },
  'CORAL GABLES HOSPITAL': { lat: 25.7505, lng: -80.2621 },
  'HIALEAH HOSPITAL': { lat: 25.8578, lng: -80.2917 },
  'PALMETTO GENERAL HOSPITAL': { lat: 25.8936, lng: -80.3219 },
  'AVENTURA HOSPITAL AND MEDICAL CENTER': { lat: 25.9591, lng: -80.1393 },
  'SOUTH MIAMI HOSPITAL': { lat: 25.7065, lng: -80.2933 },
  'HOMESTEAD HOSPITAL': { lat: 25.4731, lng: -80.4726 },
  'WEST KENDALL BAPTIST HOSPITAL': { lat: 25.6810, lng: -80.4415 },
  'NORTH SHORE MEDICAL CENTER': { lat: 25.8537, lng: -80.1932 },
  'KENDALL REGIONAL MEDICAL CENTER': { lat: 25.6876, lng: -80.3987 },
  'JACKSON SOUTH MEDICAL CENTER': { lat: 25.5897, lng: -80.3577 },
  'JACKSON NORTH MEDICAL CENTER': { lat: 25.9427, lng: -80.1640 },
  'LARKIN COMMUNITY HOSPITAL PALM SPRINGS CAMPUS': { lat: 25.8190, lng: -80.3340 },
  'UNIVERSITY OF MIAMI HOSPITAL': { lat: 25.7900, lng: -80.2105 },
  'NICKLAUS CHILDRENS HOSPITAL': { lat: 25.7827, lng: -80.2109 },
  'MIAMI VA MEDICAL CENTER': { lat: 25.7930, lng: -80.2090 },
  'KERALTY HOSPITAL': { lat: 25.7736, lng: -80.1904 }
};

export function findNearestHospitals(lat, lng, maxDistance = 15.0) {
  // Prefer statewide CMS data (has lat/lng + more hospitals)
  const swHospitals = loadDataFile('statewide-hospitals.json');
  if (swHospitals && swHospitals.length > 0 && !lat) return [];
  if (swHospitals && swHospitals.length > 0) {
    return swHospitals
      .filter(h => {
        const hLat = parseFloat(h.latitude || h.lat);
        const hLng = parseFloat(h.longitude || h.lng);
        return hLat && hLng;
      })
      .map(h => {
        const hLat = parseFloat(h.latitude || h.lat);
        const hLng = parseFloat(h.longitude || h.lng);
        return {
          name: h.facility_name || h.name || h.hospital_name,
          address: h.address || h.street_address,
          city: h.city || h.city_town,
          cmsRating: parseInt(h.hospital_overall_rating || h.overallRating || h.overall_rating) || null,
          emergencyServices: (h.emergency_services || h.emergencyServices || '').toString().toLowerCase().includes('yes'),
          distanceMiles: Math.round(distanceMiles(lat, lng, hLat, hLng) * 100) / 100,
          lat: hLat,
          lng: hLng
        };
      })
      .filter(h => h.distanceMiles <= maxDistance)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .slice(0, 10);
  }

  // Fall back to MDC-only hospitals with pre-cached coords
  const hospitals = loadDataFile('hospitals.json');
  if (!hospitals || !lat || !lng) return [];

  return hospitals
    .map(h => {
      const upperName = (h.name || '').toUpperCase();
      const coords = _hospitalCoords[upperName];
      if (!coords) return null;
      const dlat = (coords.lat - lat) * 69.0;
      const dlng = (coords.lng - lng) * 69.0 * Math.cos(lat * Math.PI / 180);
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      return {
        name: h.name,
        address: h.address,
        city: h.city,
        cmsRating: parseInt(h.overallRating) || null,
        emergencyServices: h.emergencyServices === 'Yes',
        distanceMiles: Math.round(dist * 100) / 100,
        lat: coords.lat,
        lng: coords.lng
      };
    })
    .filter(h => h && h.distanceMiles <= maxDistance)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 10);
}

// Find nearest EV charging stations (DOE AFDC data) — prefers statewide
export function findNearestEVCharging(lat, lng, maxDistance = 5.0) {
  const stations = loadDataFile('statewide-ev-charging.json') || loadDataFile('ev-charging.json');
  if (!stations || !lat || !lng) return [];

  return stations
    .filter(s => s.latitude && s.longitude)
    .map(s => {
      const dlat = (s.latitude - lat) * 69.0;
      const dlng = (s.longitude - lng) * 69.0 * Math.cos(lat * Math.PI / 180);
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      return { ...s, distanceMiles: Math.round(dist * 100) / 100 };
    })
    .filter(s => s.distanceMiles <= maxDistance)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 10)
    .map(s => ({
      name: s.station_name,
      address: s.street_address,
      city: s.city,
      network: s.ev_network,
      connectorTypes: s.ev_connector_types,
      level2Count: s.ev_level2_evse_num || 0,
      dcFastCount: s.ev_dc_fast_num || 0,
      pricing: s.ev_pricing || null,
      distanceMiles: s.distanceMiles,
      lat: s.latitude,
      lng: s.longitude
    }));
}

// Find nearest EPA TRI (Toxic Release Inventory) facilities — prefers statewide
export function findNearestTRIFacilities(lat, lng, maxDistance = 5.0) {
  const facilities = loadDataFile('statewide-epa-tri.json') || loadDataFile('epa-tri-facilities.json');
  if (!facilities || !lat || !lng) return [];

  return facilities
    .filter(f => f.PREF_LATITUDE && f.PREF_LATITUDE !== 'None' && f.PREF_LONGITUDE && f.PREF_LONGITUDE !== 'None')
    .map(f => {
      const fLat = parseFloat(f.PREF_LATITUDE);
      const fLng = parseFloat(f.PREF_LONGITUDE) * -1; // TRI stores as positive, needs negative for western hemisphere
      const dlat = (fLat - lat) * 69.0;
      const dlng = (fLng - lng) * 69.0 * Math.cos(lat * Math.PI / 180);
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      return { ...f, calcLat: fLat, calcLng: fLng, distanceMiles: Math.round(dist * 100) / 100 };
    })
    .filter(f => f.distanceMiles <= maxDistance)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 10)
    .map(f => ({
      name: f.FACILITY_NAME,
      address: f.STREET_ADDRESS,
      city: f.CITY_NAME,
      closed: f.FAC_CLOSED_IND === 'Y',
      triId: f.TRI_FACILITY_ID,
      distanceMiles: f.distanceMiles,
      lat: f.calcLat,
      lng: f.calcLng
    }));
}

// Find nearest evacuation route
export function findNearestEvacuationRoute(lat, lng) {
  const routes = loadDataFile('evacuation-routes.json');
  if (!routes || !lat || !lng) return null;

  // Evacuation routes may have geometry — find nearest by name/reference
  const mapped = routes.map(r => {
    const attrs = r.attributes || r;
    return {
      name: attrs.ROADNAME || attrs.NAME || attrs.RTE_NAME || '(unnamed)',
      type: attrs.RTE_TYPE || attrs.TYPE || '',
      direction: attrs.DIRECTION || '',
      zone: attrs.EVAC_ZONE || ''
    };
  }).filter(r => r.name !== '(unnamed)');

  // Return unique routes
  const seen = new Set();
  return mapped.filter(r => {
    const key = r.name + r.direction;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

// ─── Investor Signals — derived from existing public data ─────────
export async function getInvestorSignals(prop, lat, lng) {
  const signals = {};
  const flags = [];

  // 1. Out of State Owner — mailing state ≠ FL
  // DOR statewide data uses full names ("FLORIDA"), MDC data uses abbreviations ("FL")
  const mailState = (prop.TRUE_MAILING_STATE || '').trim().toUpperCase();
  signals.outOfStateOwner = mailState && mailState !== 'FL' && mailState !== 'FLORIDA';
  if (signals.outOfStateOwner) flags.push('Out of State Owner');

  // 2. Absentee Owner — mailing address ≠ site address
  const mailAddr = (prop.TRUE_MAILING_ADDR1 || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const siteAddr = (prop.TRUE_SITE_ADDR || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  signals.absenteeOwner = mailAddr && siteAddr && mailAddr !== siteAddr;
  if (signals.absenteeOwner && !signals.outOfStateOwner) flags.push('Absentee Owner');

  // 3. Corporate/Trust/LLC Owner
  const owner1 = (prop.TRUE_OWNER1 || '').toUpperCase();
  const owner2 = (prop.TRUE_OWNER2 || '').toUpperCase();
  const corpPatterns = ['LLC', 'INC', 'CORP', 'LTD', 'L.L.C', 'HOLDINGS', 'PROPERTIES', 'PARTNERS', 'GROUP', 'VENTURES', 'CAPITAL', 'INVESTMENTS', 'MANAGEMENT'];
  const trustPatterns = ['TRUST', 'TRUSTEE', 'TR ', 'TTEE', 'REVOCABLE', 'IRREVOCABLE', 'LIVING TRUST', 'FAMILY TRUST'];
  signals.corporateOwner = corpPatterns.some(p => owner1.includes(p) || owner2.includes(p));
  signals.trustOwner = trustPatterns.some(p => owner1.includes(p) || owner2.includes(p));
  if (signals.corporateOwner) flags.push('Corporate/LLC Owner');
  if (signals.trustOwner) flags.push('Trust Owner');

  // 4. Long-term Owner — years since last sale
  // Pull from Pictometry layer for sales data
  let salesData = null;
  // Skip Pictometry API for statewide (non-MDC) properties — it only works for Miami-Dade
  if (prop._statewide) {
    salesData = null; // Force statewide fallback below
  } else try {
    const picUrl = `https://gisweb.miamidade.gov/arcgis/rest/services/MD_SQLPictometry_Connect/MapServer/0/query`
      + `?where=FOLIO%3D%27${prop.FOLIO}%27`
      + `&outFields=DOS_1,PRICE_1,GRANTOR_1,GRANTEE_1,OR_BK_1,OR_PG_1,`
      + `DOS_2,PRICE_2,GRANTOR_2,GRANTEE_2,OR_BK_2,OR_PG_2,`
      + `DOS_3,PRICE_3,GRANTOR_3,GRANTEE_3,OR_BK_3,OR_PG_3,`
      + `TOTAL_VAL_CUR,TOTAL_VAL_PRI,ASSESSED_VAL_CUR,ASSESSED_VAL_PRI,`
      + `LAND_VAL_CUR,BUILDING_VAL_CUR,`
      + `HSTEAD_EX_VAL_CUR,CNTY_SR_EX_VAL_CUR,VETERAN_EX_VAL_CUR,`
      + `DISABLED_EX_VAL_CUR,WIDOW_EX_VAL_CUR,BLIND_EX_VAL_CUR`
      + `&f=json`;
    const resp = await fetch(picUrl);
    const picData = await resp.json();
    if (picData.features?.[0]) {
      salesData = picData.features[0].attributes;
    }
  } catch (e) { /* ignore — sales data is bonus */ }

  // Fallback for statewide DOR data (Pictometry API only works for Miami-Dade)
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
    // Assessed values from DOR
    signals.assessedValue = {
      total: prop.TOTAL_VAL_CUR || 0,
      land: prop.LAND_VAL_CUR || 0,
      building: prop.BUILDING_VAL_CUR || 0,
      source: 'FL DOR Statewide'
    };
    // Equity estimate
    if (s1.price > 100 && prop.TOTAL_VAL_CUR > 0) {
      const equity = prop.TOTAL_VAL_CUR - s1.price;
      const pct = Math.round(equity / prop.TOTAL_VAL_CUR * 100);
      signals.estimatedEquityDollar = equity;
      signals.estimatedEquityPct = pct;
      if (pct >= 50) { flags.push(`High Equity (${pct}%)`); signals.highEquity = true; }
    }
    // Homestead from DOR
    if (prop._homestead) { signals.homesteadExemption = true; }
    // Senior/veteran from DOR (not available in statewide — use AV_HMSTD as proxy)
  }

  if (salesData) {
    // Parse last sale date
    const dos1 = salesData.DOS_1;
    if (dos1 && dos1.length === 8) {
      const year = parseInt(dos1.substring(0, 4));
      const yearsOwned = new Date().getFullYear() - year;
      signals.yearsOwned = yearsOwned;
      signals.lastSaleDate = `${dos1.substring(4,6)}/${dos1.substring(6,8)}/${year}`;
      signals.lastSalePrice = salesData.PRICE_1 || null;
      if (yearsOwned >= 15) { flags.push('Long-Term Owner (15+ years)'); signals.longTermOwner = true; }
    }

    // Sales history
    signals.salesHistory = [];
    for (let i = 1; i <= 3; i++) {
      const dos = salesData[`DOS_${i}`];
      if (dos) {
        signals.salesHistory.push({
          date: dos,
          price: salesData[`PRICE_${i}`],
          grantor: salesData[`GRANTOR_${i}`],
          grantee: salesData[`GRANTEE_${i}`],
          book: salesData[`OR_BK_${i}`],
          page: salesData[`OR_PG_${i}`]
        });
      }
    }

    // Assessed values
    signals.assessedValue = {
      totalCurrent: salesData.TOTAL_VAL_CUR,
      totalPrior: salesData.TOTAL_VAL_PRI,
      assessedCurrent: salesData.ASSESSED_VAL_CUR,
      assessedPrior: salesData.ASSESSED_VAL_PRI,
      landValue: salesData.LAND_VAL_CUR,
      buildingValue: salesData.BUILDING_VAL_CUR
    };

    // Equity estimate
    if (salesData.TOTAL_VAL_CUR && salesData.PRICE_1) {
      const estValue = salesData.TOTAL_VAL_CUR;
      const lastPrice = salesData.PRICE_1;
      if (lastPrice > 100) { // Skip $100 nominal transfers
        signals.estimatedEquityPct = Math.round(((estValue - lastPrice) / estValue) * 100);
        if (signals.estimatedEquityPct >= 50) { flags.push('High Equity'); signals.highEquity = true; }
      }
    }

    // Free & Clear — no homestead often correlates, but we'd need mortgage data
    // For now, if price_1 is nominal ($100) it's often a transfer with no mortgage
    if (salesData.PRICE_1 && salesData.PRICE_1 <= 100) {
      flags.push('Nominal Transfer (possible Free & Clear)');
      signals.nominalTransfer = true;
    }

    // Senior owner indicators
    if (salesData.CNTY_SR_EX_VAL_CUR > 0) { flags.push('Senior Owner (exemption)'); signals.seniorOwner = true; }
    if (salesData.VETERAN_EX_VAL_CUR > 0) { flags.push('Veteran Owner'); signals.veteranOwner = true; }
    if (salesData.DISABLED_EX_VAL_CUR > 0) { flags.push('Disabled Owner (exemption)'); signals.disabledOwner = true; }
    if (salesData.WIDOW_EX_VAL_CUR > 0) { flags.push('Widow/Widower (exemption)'); signals.widowOwner = true; }
    if (salesData.HSTEAD_EX_VAL_CUR > 0) { signals.homesteadExemption = true; }
  }

  // 5. Owner-occupied vs investment
  signals.ownerOccupied = !signals.absenteeOwner && !signals.outOfStateOwner;
  if (!signals.ownerOccupied && !signals.outOfStateOwner) flags.push('Possible Investment Property');

  // 6. Vacant lot / no improvements
  if (!prop.YEAR_BUILT || prop.YEAR_BUILT === 0) {
    if (prop.BUILDING_HEATED_AREA === 0 || !prop.BUILDING_HEATED_AREA) {
      flags.push('Vacant Lot / No Improvements');
      signals.vacantLot = true;
    }
  }

  // 7. Multiple owners — possible partnership/family
  if (prop.TRUE_OWNER2 && prop.TRUE_OWNER2.trim()) {
    signals.multipleOwners = true;
  }

  // 8. Owner contact lookup URL
  const ownerName = (prop.TRUE_OWNER1 || '').replace(/[^a-zA-Z ]/g, '').trim();
  const city = (prop.TRUE_SITE_CITY || 'Miami').trim();
  if (ownerName && ownerName.length > 3) {
    signals.ownerLookupUrl = `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(ownerName)}&citystatezip=${encodeURIComponent(city + ' FL')}`;
  }

  signals.flags = flags;
  signals.flagCount = flags.length;

  return signals;
}

// ─── IRS Income by Zip Code ──────────────────────────────────────
let _irsCache = null;
export function getIRSIncomeByZip(zipCode) {
  if (!zipCode) return null;
  const zip = String(zipCode).substring(0, 5);

  if (!_irsCache) {
    const raw = loadDataFile('federal-irs-soi-income.csv');
    if (!raw) return null;
    _irsCache = {};
    const lines = raw.split('\n');
    const header = lines[0].split(',');
    const zipIdx = header.findIndex(h => h.includes('ZIPCODE') || h.includes('zipcode'));
    const agiIdx = header.findIndex(h => h.includes('A00100') || h.includes('agi'));
    const returnsIdx = header.findIndex(h => h.includes('N1') || h.includes('returns'));
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const z = (cols[zipIdx] || '').replace(/"/g, '').trim();
      if (z.length === 5) {
        const agi = parseFloat(cols[agiIdx]) || 0;
        const returns = parseInt(cols[returnsIdx]) || 0;
        _irsCache[z] = { zip: z, totalAGI: agi * 1000, returns, avgAGI: returns > 0 ? Math.round(agi * 1000 / returns) : 0 };
      }
    }
  }

  return _irsCache[zip] || null;
}

// ─── FEMA Disaster History by County ─────────────────────────────
let _disasterCache = null;
export function getFEMADisastersByCounty(countyName) {
  if (!countyName) return null;
  if (!_disasterCache) {
    _disasterCache = loadDataFile('federal-fema-disasters-by-county.json');
  }
  if (!_disasterCache) return null;

  // Try exact match first, then partial
  const upper = countyName.toUpperCase();
  for (const [key, val] of Object.entries(_disasterCache)) {
    if (key.toUpperCase().includes(upper) || upper.includes(key.toUpperCase().replace(/ \(COUNTY\)/, ''))) {
      return { county: key, ...val };
    }
  }
  return null;
}

// ─── FEMA NFIP Flood Claims by Zip ──────────────────────────────
let _nfipCache = null;
export function getNFIPClaimsByZip(zipCode) {
  if (!zipCode) return null;
  const zip = String(zipCode).substring(0, 5);

  if (!_nfipCache) {
    _nfipCache = loadDataFile('federal-fema-nfip-by-zip.json');
  }
  if (!_nfipCache) return null;
  return _nfipCache[zip] || null;
}

// ─── Statewide Census Block Group Lookup ─────────────────────────
let _censusSWCache = null;
export function lookupStatwideCensus(tract, blockGroup, countyFips) {
  if (!tract || !blockGroup) return null;

  if (!_censusSWCache) {
    const data = loadDataFile('statewide-census-blockgroups.json');
    if (!data) return null;
    _censusSWCache = {};
    for (const rec of data) {
      const key = `${rec.county || rec.COUNTY}-${rec.tract || rec.TRACT}-${rec['block group'] || rec.BLKGRP || rec.blockGroup}`;
      _censusSWCache[key] = rec;
    }
  }

  const key = `${countyFips}-${tract}-${blockGroup}`;
  const match = _censusSWCache[key];
  if (!match) return null;

  const toNum = (v) => { const n = parseInt(v); return (isNaN(n) || n === -666666666) ? null : n; };
  return {
    population: toNum(match.B01003_001E),
    medianHouseholdIncome: toNum(match.B19013_001E),
    medianHomeValue: toNum(match.B25077_001E),
    medianRent: toNum(match.B25064_001E),
    medianAge: parseFloat(match.B01002_001E) || null,
    perCapitaIncome: toNum(match.B19301_001E),
    totalHousingUnits: toNum(match.B25002_001E),
    occupiedHousing: toNum(match.B25002_002E),
    vacantHousing: toNum(match.B25002_003E),
    ownerOccupied: toNum(match.B25003_002E),
    totalOccupied: toNum(match.B25003_001E),
    medianYearBuilt: toNum(match.B25035_001E),
    source: 'US Census ACS 2022 (statewide cached)'
  };
}

// ─── Statewide FRED Economics Lookup ─────────────────────────────
export function getStatewideEconomics(city) {
  const fredData = loadDataFile('statewide-fred-economics.json');
  if (!fredData) return null;

  // Map city to metro area
  const cityUp = (city || '').toUpperCase();
  const metroMap = {
    'MIAMI': 'Miami', 'MIAMI BEACH': 'Miami', 'CORAL GABLES': 'Miami', 'HIALEAH': 'Miami',
    'KEY BISCAYNE': 'Miami', 'HOMESTEAD': 'Miami', 'DORAL': 'Miami', 'AVENTURA': 'Miami',
    'FORT LAUDERDALE': 'Miami', 'HOLLYWOOD': 'Miami', 'POMPANO BEACH': 'Miami', 'BOCA RATON': 'Miami',
    'WEST PALM BEACH': 'Miami', 'PALM BEACH': 'Miami', 'BOYNTON BEACH': 'Miami', 'DELRAY BEACH': 'Miami',
    'TAMPA': 'Tampa', 'ST PETERSBURG': 'Tampa', 'CLEARWATER': 'Tampa', 'BRANDON': 'Tampa',
    'LAKELAND': 'Lakeland', 'WINTER HAVEN': 'Lakeland',
    'ORLANDO': 'Orlando', 'KISSIMMEE': 'Orlando', 'SANFORD': 'Orlando', 'WINTER PARK': 'Orlando',
    'JACKSONVILLE': 'Jacksonville', 'JACKSONVILLE BEACH': 'Jacksonville',
    'FORT MYERS': 'Fort_Myers', 'CAPE CORAL': 'Fort_Myers', 'LEHIGH ACRES': 'Fort_Myers',
    'SARASOTA': 'Sarasota', 'BRADENTON': 'Sarasota', 'NORTH PORT': 'Sarasota', 'PORT CHARLOTTE': 'Sarasota',
    'PENSACOLA': 'Pensacola',
    'TALLAHASSEE': 'Tallahassee',
    'NAPLES': 'Naples', 'MARCO ISLAND': 'Naples',
    'OCALA': 'Ocala',
    'GAINESVILLE': 'Gainesville',
    'PALM BAY': 'Palm_Bay', 'MELBOURNE': 'Palm_Bay', 'TITUSVILLE': 'Palm_Bay',
  };

  const metroKey = metroMap[cityUp];
  if (!metroKey || !fredData[metroKey]) return null;

  return fredData[metroKey];
}

// ─── Timeshare Property Intelligence ─────────────────────────────
// Cross-references property records with FL DBPR timeshare project registry

let _dbprTimeshareIndex = null;
function getDBPRTimeshareIndex() {
  if (_dbprTimeshareIndex) return _dbprTimeshareIndex;

  const raw = loadDataFile('dbpr-timeshare-projects.csv');
  if (!raw || typeof raw !== 'string') return null;

  _dbprTimeshareIndex = { byAddress: {}, byName: {}, all: [] };
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    // Parse CSV — fields are quoted
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    fields.push(current.trim());

    if (fields.length < 10) continue;

    const project = {
      dbprNumber: fields[0],
      projectId: fields[1],
      projectName: fields[2],
      county: fields[3],
      address: fields[4],
      city: fields[5],
      state: fields[6],
      zip: fields[7],
      units: parseFloat((fields[8] || '0').replace(/,/g, '')) || 0,
      status: fields[11] || '',
      mailingId: fields[13] || '',
      associationName: fields[14] || '',
      mailingAddress: fields[16] || '',
      mailingCity: fields[17] || '',
      mailingState: fields[18] || '',
      mailingZip: fields[19] || ''
    };

    _dbprTimeshareIndex.all.push(project);

    // Index by normalized address
    const addrKey = (project.address + ' ' + project.city).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
    if (addrKey.length > 5) {
      if (!_dbprTimeshareIndex.byAddress[addrKey]) _dbprTimeshareIndex.byAddress[addrKey] = [];
      _dbprTimeshareIndex.byAddress[addrKey].push(project);
    }

    // Index by name words for fuzzy search
    const nameKey = project.projectName.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
    if (nameKey.length > 3) {
      _dbprTimeshareIndex.byName[nameKey] = project;
    }
  }

  console.log(`DBPR Timeshare index: ${_dbprTimeshareIndex.all.length} projects, ${Object.keys(_dbprTimeshareIndex.byAddress).length} addresses`);
  return _dbprTimeshareIndex;
}

// Search DBPR timeshare registry by name or address
export function searchDBPRTimeshare(query) {
  const idx = getDBPRTimeshareIndex();
  if (!idx) return [];

  const q = query.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();

  // Try exact address match first
  for (const [key, projects] of Object.entries(idx.byAddress)) {
    if (key.includes(q) || q.includes(key)) return projects;
  }

  // Try name search
  const nameMatches = idx.all.filter(p => {
    const name = p.projectName.toUpperCase();
    return name.includes(q) || q.split(' ').every(word => name.includes(word));
  });
  if (nameMatches.length > 0) return nameMatches;

  // Fuzzy: match any word
  return idx.all.filter(p => {
    const combined = (p.projectName + ' ' + p.address + ' ' + p.city).toUpperCase();
    return q.split(' ').some(word => word.length > 3 && combined.includes(word));
  }).slice(0, 10);
}

// Full timeshare property intelligence — combines parcel + DBPR + overlays
export async function assembleTimeshareIntelligence(query, city, explicitAddress = null) {
  const timestamp = new Date().toISOString();

  // Step 1: Search DBPR registry for the project
  const dbprMatches = searchDBPRTimeshare(query);

  // Step 2: Try to find the property in parcel data
  // IMPORTANT: DBPR stores developer/mailing addresses, NOT resort physical addresses.
  // If caller provides an explicit address+city, always use that for parcel lookup.
  let address, searchCity;

  if (explicitAddress && city) {
    // Caller gave us a physical address — this is the resort location
    address = explicitAddress;
    searchCity = city;
  } else if (/^\d+\s+\w/.test(query) && city) {
    // Query looks like an address
    address = query;
    searchCity = city;
  } else {
    // Name-only query — no parcel address to search (DBPR address is developer office)
    address = null;
    searchCity = city || '';
  }

  // Search statewide parcels
  let properties = [];
  if (address) {
    properties = await lookupByAddress(address, searchCity);
  }

  // If address didn't match, try the original query as address (if it looks like one)
  if (!properties.length && address !== query && /^\d+\s+\w/.test(query)) {
    properties = await lookupByAddress(query, city || '');
  }

  const prop = properties.length > 0 ? properties[0] : null;
  const lat = prop?.lat;
  const lng = prop?.lng;

  // Step 3: Overlays (flood, schools, hospitals, etc.)
  let flood = null, elevation = null, schools = null, hospitals = null;
  if (lat && lng) {
    [flood, elevation] = await Promise.all([
      getFloodZone(lat, lng),
      getElevation(lat, lng)
    ]);
    schools = findNearestSchools(lat, lng, 5.0);
    hospitals = findNearestHospitals(lat, lng, 15.0);
  }

  // Step 4: Permits
  const permits = prop ? findBuildingPermits(prop.FOLIO, prop.TRUE_SITE_ADDR) : [];

  // Step 5: Investor signals
  let investorSignals = null;
  if (prop) {
    investorSignals = await getInvestorSignals(prop, lat, lng);
  }

  // Step 6: Timeshare-specific analysis
  const isTimeshare = prop ? ['043', '044', '0443', '0442'].includes(prop.DOR_CODE_CUR) ||
    (prop.TRUE_OWNER1 || '').toUpperCase().match(/VACATION|TIMESHARE|RESORT|INTERVAL|HILTON GRAND|MARRIOTT OWNERSHIP|WESTGATE|DISNEY VACATION|WYNDHAM|BLUEGREEN/) : false;

  const ownerType = prop ? (
    (prop.TRUE_OWNER1 || '').toUpperCase().includes('DISNEY') ? 'Disney Vacation Club' :
    (prop.TRUE_OWNER1 || '').toUpperCase().includes('MARRIOTT') ? 'Marriott Vacations Worldwide' :
    (prop.TRUE_OWNER1 || '').toUpperCase().includes('HILTON GRAND') ? 'Hilton Grand Vacations' :
    (prop.TRUE_OWNER1 || '').toUpperCase().includes('WESTGATE') ? 'Westgate Resorts' :
    (prop.TRUE_OWNER1 || '').toUpperCase().includes('WYNDHAM') ? 'Wyndham Destinations' :
    (prop.TRUE_OWNER1 || '').toUpperCase().includes('BLUEGREEN') ? 'Bluegreen Vacations' :
    'Independent/Other'
  ) : null;

  // Build response
  return {
    origin: {
      version: '0.5-timeshare',
      type: 'timeshare-intelligence',
      assembledDate: timestamp,
      query,
      sources: [
        prop ? 'FL DOR Statewide Parcels' : null,
        dbprMatches.length ? 'FL DBPR Timeshare Registry' : null,
        flood ? 'FEMA NFHL' : null,
        elevation ? 'USGS 3DEP' : null,
        permits.length ? 'County Building Permits' : null,
        schools?.public?.length ? 'NCES Schools' : null,
        hospitals?.length ? 'CMS Hospitals' : null
      ].filter(Boolean)
    },
    dbprProject: dbprMatches.length > 0 ? {
      projectName: dbprMatches[0].projectName,
      dbprNumber: dbprMatches[0].dbprNumber,
      county: dbprMatches[0].county,
      registeredAddress: `${dbprMatches[0].address}, ${dbprMatches[0].city}, ${dbprMatches[0].state} ${dbprMatches[0].zip}`,
      units: dbprMatches[0].units,
      status: dbprMatches[0].status,
      association: dbprMatches[0].associationName,
      totalMatches: dbprMatches.length,
      allProjects: dbprMatches.length > 1 ? dbprMatches.map(p => ({
        name: p.projectName, dbprNumber: p.dbprNumber, units: p.units
      })) : undefined
    } : { note: 'No matching DBPR project found for this query' },
    countyRecord: prop ? {
      address: prop.TRUE_SITE_ADDR,
      city: prop.TRUE_SITE_CITY,
      state: 'FL',
      zip: prop.TRUE_SITE_ZIP_CODE,
      folio: prop.FOLIO,
      owner: prop.TRUE_OWNER1,
      owner2: prop.TRUE_OWNER2 || null,
      dorCode: prop.DOR_CODE_CUR,
      assessedValue: prop.TOTAL_VAL_CUR,
      landValue: prop.LAND_VAL_CUR,
      buildingValue: prop.BUILDING_VAL_CUR,
      yearBuilt: prop.YEAR_BUILT,
      livingArea: prop.BUILDING_HEATED_AREA,
      lotSize: prop.LOT_SIZE,
      coordinates: lat && lng ? { lat, lng } : null,
      isTimeshareCode: isTimeshare,
      ownerBrand: ownerType
    } : { note: `Property not found: ${address}, ${searchCity}` },
    flood: flood || null,
    elevation: elevation || null,
    buildingPermits: {
      count: permits.length,
      recentPermits: permits.slice(0, 10),
      renovationSignal: permits.length > 5 ? 'ACTIVE — multiple recent permits suggest ongoing renovation' :
                         permits.length > 0 ? 'SOME — limited permit activity' :
                         'NONE — no building permits on record'
    },
    investorSignals: investorSignals ? {
      flags: investorSignals.flags,
      ownerOccupied: investorSignals.ownerOccupied,
      corporateOwner: investorSignals.corporateOwner,
      outOfState: investorSignals.outOfStateOwner,
      salesHistory: investorSignals.salesHistory,
      assessedValue: investorSignals.assessedValue,
      ownerLookupUrl: investorSignals.ownerLookupUrl
    } : null,
    verificationSummary: {
      ownerVerified: prop && dbprMatches.length > 0,
      ownerMatch: prop && dbprMatches.length > 0 ?
        (prop.TRUE_OWNER1 || '').toUpperCase().includes(
          (dbprMatches[0].associationName || '').split(',')[0].toUpperCase().substring(0, 10)
        ) ? 'MATCH — county owner aligns with DBPR association' :
        'CHECK — county owner and DBPR association may differ (common for developer-owned)' :
        'UNVERIFIED — could not cross-reference',
      floodRisk: flood?.zone === 'X' ? 'LOW' : flood?.zone ? `ZONE ${flood.zone}` : 'UNKNOWN',
      permitActivity: permits.length > 0 ? `${permits.length} permits on record` : 'No permits found',
      isRegistered: dbprMatches.length > 0 && dbprMatches[0].status === 'Approved'
    }
  };
}

// ─── DBPR Vacation Rental Lookup ──────────────────────────────────
// 178K licensed vacation rentals statewide with phone numbers
let _vrIndex = null;
function getVRIndex() {
  if (_vrIndex) return _vrIndex;
  const filePath = path.join(__dirname, 'data', 'dbpr-licenses', 'vacation-rentals-statewide.jsonl');
  if (!fs.existsSync(filePath)) return null;

  _vrIndex = { byAddress: {}, byOwner: {}, byCounty: {}, byCity: {}, total: 0 };
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      _vrIndex.total++;

      // Index by location address (normalized)
      const addr = (r['Location Street Address'] || '').trim().toUpperCase();
      if (addr.length > 5) {
        const normAddr = addr.replace(/\./g, '').replace(/\s+/g, ' ');
        if (!_vrIndex.byAddress[normAddr]) _vrIndex.byAddress[normAddr] = [];
        _vrIndex.byAddress[normAddr].push(r);
      }

      // Index by owner name
      const owner = (r['Licensee Name'] || '').trim().toUpperCase();
      if (owner.length > 2) {
        if (!_vrIndex.byOwner[owner]) _vrIndex.byOwner[owner] = [];
        _vrIndex.byOwner[owner].push(r);
      }

      // Index by county
      const county = (r['Location County'] || '').trim().toUpperCase();
      if (county) {
        if (!_vrIndex.byCounty[county]) _vrIndex.byCounty[county] = [];
        _vrIndex.byCounty[county].push(r);
      }

      // Index by city
      const city = (r['Location City'] || '').trim().toUpperCase();
      if (city) {
        if (!_vrIndex.byCity[city]) _vrIndex.byCity[city] = [];
        _vrIndex.byCity[city].push(r);
      }
    } catch {}
  }

  console.log(`DBPR VR index built: ${_vrIndex.total.toLocaleString()} rentals, ${Object.keys(_vrIndex.byCity).length} cities, ${Object.keys(_vrIndex.byCounty).length} counties`);
  return _vrIndex;
}

export function searchVacationRentals({ address, owner, city, county, limit = 50 }) {
  const idx = getVRIndex();
  if (!idx) return { results: [], total: 0, note: 'DBPR vacation rental data not loaded' };

  let matches = [];

  if (address) {
    const normAddr = address.trim().toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ');
    matches = idx.byAddress[normAddr] || [];
  } else if (owner) {
    const normOwner = owner.trim().toUpperCase();
    // Exact match first, then startsWith
    matches = idx.byOwner[normOwner] || [];
    if (!matches.length) {
      for (const [key, val] of Object.entries(idx.byOwner)) {
        if (key.startsWith(normOwner)) { matches.push(...val); if (matches.length >= limit) break; }
      }
    }
  } else if (city) {
    matches = idx.byCity[city.trim().toUpperCase()] || [];
  } else if (county) {
    matches = idx.byCounty[county.trim().toUpperCase()] || [];
  }

  return {
    results: matches.slice(0, limit).map(r => ({
      licensee: r['Licensee Name'],
      businessName: r['Business Name'],
      address: r['Location Street Address'],
      city: r['Location City'],
      county: r['Location County'],
      zip: r['Location Zip Code'],
      phone: r['Primary Phone Number'] || r['Secondary Phone Number'] || null,
      phone2: r['Secondary Phone Number'] || null,
      licenseNumber: r['License Number'],
      licenseType: r['License Type Code'] === '2006' ? 'Vacation Rental Condo' : 'Vacation Rental Dwelling',
      status: r['Primary Status Code'],
      expiryDate: r['License Expiry Date'],
      units: parseInt(r['Number of Seats or Rental Units']) || null,
      mailingAddress: [r['Mailing Street Address'], r['Mailing City'], r['Mailing State Code'], r['Mailing Zip Code']].filter(Boolean).join(', ')
    })),
    total: matches.length,
    source: 'FL DBPR Division of Hotels & Restaurants',
    coverage: 'Statewide (all 67 FL counties)',
    totalInDatabase: idx.total
  };
}

// Get market/economic data (FRED + BLS cached data)
export function getMarketEconomics() {
  const result = {};

  // Load FRED CSVs
  const fredFiles = {
    medianPrice: 'fred-median-price.csv',
    activeListings: 'fred-active-listings.csv',
    daysOnMarket: 'fred-days-on-market.csv',
    newListings: 'fred-new-listings.csv',
    unemployment: 'fred-unemployment.csv'
  };

  for (const [key, file] of Object.entries(fredFiles)) {
    const raw = loadDataFile(file);
    if (raw && typeof raw === 'string') {
      // Parse CSV
      const lines = raw.trim().split('\n');
      const header = lines[0];
      const data = lines.slice(1).map(line => {
        const [date, value] = line.split(',');
        return { date: date.trim(), value: parseFloat(value) };
      }).filter(d => !isNaN(d.value));
      if (data.length) {
        result[key] = {
          latest: data[data.length - 1],
          trend: data.slice(-6), // last 6 data points
          source: `FRED (${file})`
        };
      }
    }
  }

  // Load BLS CPI
  const cpi = loadDataFile('bls-cpi-miami.json');
  if (cpi) {
    result.costOfLiving = {
      data: cpi,
      source: 'BLS CPI-U Miami-Fort Lauderdale'
    };
  }

  return result;
}

// Census block group lookup from cached data
export function lookupCensusBlockGroup(tract, blockGroup) {
  const bgData = loadDataFile('census-block-groups.json');
  if (!bgData) return null;

  const match = bgData.find(bg =>
    bg.tract === tract && bg['block group'] === blockGroup
  );

  if (!match) return null;

  const toNum = (v) => {
    const n = parseInt(v);
    return (isNaN(n) || n === -666666666) ? null : n;
  };

  return {
    tract,
    blockGroup,
    population: toNum(match.B01003_001E),
    medianHouseholdIncome: toNum(match.B19013_001E),
    medianHomeValue: toNum(match.B25077_001E),
    medianRent: toNum(match.B25064_001E),
    medianAge: parseFloat(match.B01002_001E) || null,
    perCapitaIncome: toNum(match.B19301_001E),
    totalHousingUnits: toNum(match.B25002_001E),
    occupiedHousing: toNum(match.B25002_002E),
    vacantHousing: toNum(match.B25002_003E),
    ownerOccupied: toNum(match.B25003_002E),
    totalOccupied: toNum(match.B25003_001E),
    ownerOccupiedRate: (() => {
      const occ = toNum(match.B25003_001E);
      const own = toNum(match.B25003_002E);
      return occ && own ? Math.round((own / occ) * 100) : null;
    })(),
    source: 'US Census ACS 2022 (cached block group)'
  };
}

// ─── Assemble Complete Property Intelligence ──────────────────────
export async function assemblePropertyIntelligence(address, city = 'Miami Beach') {
  const timestamp = new Date().toISOString();

  // Step 1: Find the property
  const properties = await lookupByAddress(address, city);
  if (!properties.length) {
    return { error: `Property not found: ${address}, ${city}`, timestamp };
  }
  const prop = properties[0];
  const lat = prop.lat;
  const lng = prop.lng;

  // Step 2-4: Parallel queries for overlays
  const [flood, census, layers] = await Promise.all([
    lat && lng ? getFloodZone(lat, lng) : { zone: 'COORDINATES_UNAVAILABLE' },
    getCensusData(address, city, 'FL'),
    lat && lng ? identifyAllLayers(lat, lng) : {}
  ]);

  // Step 5: Extract zoning from identify results
  const zoning = layers['Municipal Zoning']?.[0] || layers['County Zoning']?.[0] || {};

  // Step 6: Elevation query (USGS — critical for Miami flood risk)
  const elevation = await getElevation(lat, lng);

  // Step 7: Cached overlay lookups (instant — no API calls)
  const schools = findNearestSchools(lat, lng, 3.0);
  const permits = findBuildingPermits(prop.FOLIO, prop.TRUE_SITE_ADDR);
  const hospitals = findNearestHospitals(lat, lng, 15.0);
  const evCharging = findNearestEVCharging(lat, lng, 5.0);
  const triFacilities = findNearestTRIFacilities(lat, lng, 5.0);
  const evacuationRoutes = findNearestEvacuationRoute(lat, lng);
  const roadWork = findNearbyRoadWork(lat, lng, 2.0);
  const economics = getMarketEconomics();
  const statewideEcon = getStatewideEconomics(prop.TRUE_SITE_CITY);
  const investorSignals = await getInvestorSignals(prop, lat, lng);

  // Federal data lookups
  const zip = prop.TRUE_SITE_ZIP_CODE ? String(prop.TRUE_SITE_ZIP_CODE).substring(0, 5) : null;
  const irsIncome = getIRSIncomeByZip(zip);
  const nfipClaims = getNFIPClaimsByZip(zip);
  const femaDisasters = getFEMADisastersByCounty(prop.TRUE_SITE_CITY);

  // Clerk signals (Broward County courthouse records — lis pendens, probate, liens)
  // IMPORTANT: Only match court records for Broward County properties (CO_NO = 6)
  // Matching by name across counties produces false positives
  const ownerName = prop.TRUE_OWNER1 || '';
  const isBroward = prop.CO_NO === 6 || prop.CO_NO === '6' ||
    (prop.TRUE_SITE_CITY || '').toUpperCase().match(/FORT LAUDERDALE|HOLLYWOOD|PEMBROKE PINES|CORAL SPRINGS|MIRAMAR|POMPANO BEACH|DAVIE|PLANTATION|SUNRISE|DEERFIELD BEACH|LAUDERHILL|TAMARAC|WESTON|COCONUT CREEK|MARGATE|LAUDERDALE LAKES|OAKLAND PARK|WILTON MANORS|HALLANDALE|DANIA|COOPER CITY/);
  const clerkSignals = isBroward ? lookupClerkSignals(ownerName, prop.FOLIO) : [];
  const farmingScore = computeFarmingScore(investorSignals, clerkSignals, permits);

  // Try to get census from cached block groups if live API failed
  let demographics = census;
  if (!census.population && census.tract && census.blockGroup) {
    // Try statewide census first, then MDC-specific
    const swCensus = lookupStatwideCensus(census.tract, census.blockGroup, census.county);
    const cached = swCensus || lookupCensusBlockGroup(census.tract, census.blockGroup);
    if (cached) {
      demographics = { ...census, ...cached, source: cached.source || 'US Census ACS 2022 (cached)' };
    }
  }

  // Step 8: Build provenance
  const sourceList = [
    'gisweb.miamidade.gov',
    'hazards.fema.gov',
    'api.census.gov',
    'geocoding.geo.census.gov'
  ];
  if (elevation) sourceList.push('epqs.nationalmap.gov (USGS elevation)');
  if (schools.public.length) sourceList.push('cached:schools.json (FL DOE)');
  if (permits.length) {
    const permitSources = [...new Set(permits.map(p => p.source).filter(Boolean))];
    sourceList.push(`Building permits (${permitSources.join(', ') || 'cached'})`);
  }
  if (hospitals.length) sourceList.push('cached:hospitals.json (CMS Medicare)');
  if (evCharging.length) sourceList.push('cached:ev-charging.json (DOE AFDC)');
  if (triFacilities.length) sourceList.push('cached:epa-tri-facilities.json (EPA TRI)');
  if (evacuationRoutes) sourceList.push('cached:evacuation-routes.json (MDC OEM)');
  if (Object.keys(economics).length || statewideEcon) sourceList.push('FRED/BLS economic data');
  if (investorSignals.salesHistory?.length) sourceList.push('MDC Pictometry (sales/assessed values)');
  if (irsIncome) sourceList.push('IRS SOI (income by zip code)');
  if (nfipClaims) sourceList.push('FEMA NFIP (flood insurance claims)');
  if (femaDisasters) sourceList.push('FEMA (disaster declarations)');
  if (clerkSignals.length) sourceList.push('Broward County Clerk of Courts (SFTP bulk)');

  const rawData = JSON.stringify({ prop, flood, demographics, layers, schools, permits, hospitals, evCharging, triFacilities, investorSignals, irsIncome, nfipClaims });
  const docHash = crypto.createHash('sha256').update(rawData).digest('hex');

  // Calculate confidence based on data completeness
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
  if (triFacilities.length >= 0) confidence += 0.02; // even 0 is data
  if (Object.keys(economics).length) confidence += 0.03;
  if (evacuationRoutes) confidence += 0.02;
  if (investorSignals.salesHistory?.length) confidence += 0.03;
  confidence = Math.min(1.0, Math.round(confidence * 100) / 100);

  return {
    origin: {
      version: '0.5',
      propertyId: `FL-MDC-${prop.FOLIO}`,
      folio: prop.FOLIO,
      assembledDate: timestamp,
      sources: sourceList,
      dataLayers: sourceList.length,
      documentHash: docHash,
      provenance: SSL_CERTS,
      confidence
    },
    property: {
      address: prop.TRUE_SITE_ADDR,
      city: prop.TRUE_SITE_CITY,
      state: 'FL',
      zip: prop.TRUE_SITE_ZIP_CODE,
      folio: prop.FOLIO,
      coordinates: { lat, lng },
      owner: { name1: prop.TRUE_OWNER1, name2: prop.TRUE_OWNER2 },
      ownerOccupied: prop.TRUE_MAILING_ADDR1 === prop.TRUE_SITE_ADDR,
      building: {
        yearBuilt: prop.YEAR_BUILT,
        stories: prop.FLOOR_COUNT,
        bedrooms: prop.BEDROOM_COUNT,
        bathrooms: prop.BATHROOM_COUNT,
        halfBathrooms: prop.HALF_BATHROOM_COUNT,
        heatedArea: prop.BUILDING_HEATED_AREA,
        grossArea: prop.BUILDING_GROSS_AREA,
        buildings: prop.BUILDING_COUNT,
        units: prop.UNIT_COUNT
      },
      lot: { size: prop.LOT_SIZE, unit: 'sqft' },
      classification: {
        dorCode: prop.DOR_CODE_CUR,
        description: prop.DOR_DESC,
        zoning: zoning.ZONE || prop.PRIMARY_ZONE,
        zoningDesc: zoning.ZONETEXT || null,
        subdivision: prop.SUBDIVISION,
        condo: prop.CONDO_FLAG === 'Y'
      }
    },
    flood,
    elevation: elevation || { elevationFt: null, source: 'USGS query failed' },
    floodRiskAnalysis: elevation && flood.baseFloodElevation ? {
      propertyElevation: elevation.elevationFt,
      baseFloodElevation: flood.baseFloodElevation,
      marginFt: Math.round((elevation.elevationFt - flood.baseFloodElevation) * 100) / 100,
      risk: elevation.elevationFt >= flood.baseFloodElevation + 3 ? 'LOW — well above BFE' :
            elevation.elevationFt >= flood.baseFloodElevation ? 'MODERATE — at or near BFE' :
            'HIGH — below BFE, significant flood risk',
      note: `Property sits at ${elevation.elevationFt}ft. FEMA requires ${flood.baseFloodElevation}ft (BFE). ${elevation.elevationFt >= flood.baseFloodElevation ? 'Meets' : 'DOES NOT MEET'} minimum elevation. Margin: ${(elevation.elevationFt - flood.baseFloodElevation).toFixed(1)}ft.`
    } : null,
    demographics,
    schools: {
      nearestPublic: schools.public,
      nearbyPrivate: schools.private,
      nearbyCharter: schools.charter,
      totalNearby: schools.public.length + schools.private.length + schools.charter.length
    },
    buildingPermits: {
      count: permits.length,
      recentPermits: permits.slice(0, 10),
      summary: permits.length > 0 ? {
        types: [...new Set(permits.map(p => p.description).filter(Boolean))],
        contractors: [...new Set(permits.map(p => p.contractor).filter(Boolean))].slice(0, 5),
        latestDate: permits[0]?.issueDate || null
      } : null
    },
    hospitals: {
      nearest: hospitals.slice(0, 5),
      bestRated: [...hospitals].sort((a, b) => (b.cmsRating || 0) - (a.cmsRating || 0)).slice(0, 3),
      totalNearby: hospitals.length
    },
    evCharging: {
      stations: evCharging,
      totalNearby: evCharging.length
    },
    environmental: {
      triFacilities: {
        nearbyCount: triFacilities.length,
        facilities: triFacilities,
        note: triFacilities.length === 0 ? 'No EPA Toxic Release Inventory facilities within 5 miles' :
              `${triFacilities.length} TRI-reporting facility(ies) within 5 miles — review for potential environmental concerns`
      }
    },
    safety: {
      evacuationRoutes: evacuationRoutes,
      hurricaneEvacZone: prop.EVAC_ZONE || null
    },
    infrastructure: {
      nearbyRoadWork: roadWork.slice(0, 5)
    },
    marketEconomics: statewideEcon || economics,
    federalData: {
      irsIncome: irsIncome ? {
        zip: irsIncome.zip,
        totalReturns: irsIncome.returns,
        averageAGI: irsIncome.avgAGI,
        source: 'IRS Statistics of Income'
      } : null,
      floodClaimHistory: nfipClaims ? {
        totalClaims: nfipClaims.count,
        totalPaid: nfipClaims.totalPaid,
        yearsWithClaims: nfipClaims.years?.sort() || [],
        source: 'FEMA NFIP Claims Database'
      } : null,
      disasterHistory: femaDisasters ? {
        county: femaDisasters.county,
        totalDeclarations: femaDisasters.total,
        byType: femaDisasters.types,
        latestDeclaration: femaDisasters.latest,
        source: 'FEMA Disaster Declarations'
      } : null
    },
    investorSignals: {
      flags: investorSignals.flags,
      flagCount: investorSignals.flagCount,
      ownerOccupied: investorSignals.ownerOccupied,
      outOfStateOwner: investorSignals.outOfStateOwner,
      absenteeOwner: investorSignals.absenteeOwner,
      corporateOwner: investorSignals.corporateOwner,
      trustOwner: investorSignals.trustOwner,
      longTermOwner: investorSignals.longTermOwner || false,
      yearsOwned: investorSignals.yearsOwned || null,
      seniorOwner: investorSignals.seniorOwner || false,
      veteranOwner: investorSignals.veteranOwner || false,
      homesteadExemption: investorSignals.homesteadExemption || false,
      highEquity: investorSignals.highEquity || false,
      estimatedEquityPct: investorSignals.estimatedEquityPct || null,
      vacantLot: investorSignals.vacantLot || false,
      multipleOwners: investorSignals.multipleOwners || false,
      assessedValue: investorSignals.assessedValue || null,
      salesHistory: investorSignals.salesHistory || [],
      ownerLookupUrl: investorSignals.ownerLookupUrl || null
    },
    gisLayers: {
      zoning: zoning,
      layerCount: Object.keys(layers).length,
      allLayers: Object.keys(layers)
    },
    courtRecords: clerkSignals.length > 0 ? {
      county: 'Broward',
      totalFilings: clerkSignals.length,
      signals: clerkSignals.map(s => ({
        signal: s.signal,
        description: s.description,
        docType: s.docType,
        recordDate: s.recordDate,
        instrumentNum: s.instrumentNum,
        caseNum: s.caseNum,
        parties: s.parties?.slice(0, 6),
        hash: s.hash,
        source: s.source
      })),
      summary: {
        lispendens: clerkSignals.filter(s => s.signal === 'lis_pendens').length,
        probate: clerkSignals.filter(s => s.signal === 'probate').length,
        liens: clerkSignals.filter(s => s.signal === 'lien').length,
        mortgages: clerkSignals.filter(s => s.signal === 'mortgage').length,
        satisfactions: clerkSignals.filter(s => s.signal === 'satisfaction').length,
        deeds: clerkSignals.filter(s => s.signal === 'deed_transfer').length,
        deaths: clerkSignals.filter(s => s.signal === 'death').length
      },
      provenance: {
        source: 'Broward County Clerk of Courts',
        method: 'SFTP bulk download (BCFTP.Broward.org)',
        coverage: '1978-present',
        updateFrequency: 'daily'
      }
    } : isBroward
      ? { county: 'Broward', note: 'No court filings found for this owner name (2024-2025)' }
      : { county: (prop.TRUE_SITE_CITY || 'Unknown') + ' (not Broward)', note: 'Court records currently available for Broward County only. Expanding to Miami-Dade and Palm Beach soon.' },
    farmingScore: {
      score: farmingScore.score,
      rating: farmingScore.rating,
      reasons: farmingScore.reasons,
      signalCount: farmingScore.signalCount,
      bridgePageUrl: `https://title.rootz.global/p/farm?address=${encodeURIComponent(prop.TRUE_SITE_ADDR || '')}&city=${encodeURIComponent(prop.TRUE_SITE_CITY || '')}`,
      methodology: 'Combines DOR parcel signals (ownership, equity, exemptions) + courthouse records (lis pendens, probate, liens) + permit activity. Scale 0-100.'
    },
    _rawValue: prop.TOTAL_VAL_CUR || prop.JV || 0
  };
}
