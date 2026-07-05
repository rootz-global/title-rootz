// Ohio Property Intelligence Query Engine
// Queries Ohio county parcel data (city-indexed JSONL)
// Mirrors fl-query.mjs architecture for multi-state support

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { DATA_DIR as ROOT_DATA } from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use the shared project data dir (symlinked on the server), NOT __dirname/data
// (which resolves to src/query/data and does not exist on the server).
const DATA_DIR = path.join(ROOT_DATA, 'ohio');
const CITIES_DIR = path.join(DATA_DIR, 'cities');

// ─── Fetch Helper ─────────────────────────────────────────────
async function fetchJSON(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return await resp.json();
  } catch (e) {
    console.error(`OH fetch error: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Search Ohio parcels by address (grep city-indexed files) ──
function searchOhioByAddress(address, city) {
  if (!fs.existsSync(CITIES_DIR)) return [];

  const addrUp = address.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  const cityUp = city ? city.toUpperCase().trim() : '';
  if (!cityUp) return [];

  // Find city files — Ohio uses tax district names, one city may span multiple files
  const safeCity = cityUp.replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, '_');
  const allFiles = fs.readdirSync(CITIES_DIR).filter(f => f.startsWith('OH_') && f.endsWith('.jsonl'));

  // Priority 1: exact CITY_OF_ match, then any file containing city name
  let searchFiles = allFiles.filter(f => f === `OH_CITY_OF_${safeCity}.jsonl`);
  if (!searchFiles.length) searchFiles = allFiles.filter(f => f.includes(safeCity));
  if (!searchFiles.length) return [];

  // Build grep pattern
  const parts = addrUp.match(/^(\d+)\s+(.+)$/);
  let addrPattern;
  if (parts) {
    addrPattern = `${parts[1]} ${parts[2].replace(/[^A-Z0-9 ]/g, '').trim()}`;
  } else {
    addrPattern = addrUp.substring(0, 30);
  }
  const safePattern = addrPattern.replace(/[[\](){}.*+?^$|\\]/g, '\\$&');

  // Also add the raw county parcel file as fallback
  const rawFile = path.join(DATA_DIR, 'franklin-parcels.jsonl');
  if (fs.existsSync(rawFile) && !searchFiles.includes('_RAW_')) {
    searchFiles.push('_RAW_');
  }

  // Search each matching city file until we find results
  for (const file of searchFiles) {
    const filePath = file === '_RAW_' ? rawFile : path.join(CITIES_DIR, file);
    try {
      // Search SITEADDRESS (Franklin) or raw line (Hamilton — address split across fields)
      const cmd = `grep -i '${safePattern}' "${filePath}" | head -10`;
      const result = execSync(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 }).toString();
      const lines = result.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        return lines.map(l => {
          try {
            const rec = JSON.parse(l);
            // Detect format: Hamilton uses CAGIS.AUDREAL_VW. prefix
            const isHamilton = 'CAGIS.AUDREAL_VW.OWNNM1' in rec;
            const g = (key) => rec[key]; // shorthand getter
            const h = (key) => rec['CAGIS.AUDREAL_VW.' + key]; // Hamilton getter

            if (isHamilton) {
              // Hamilton County (Cincinnati) format
              const addrNum = h('ADDRNO') || '';
              const addrDir = h('ADDRSD') || '';
              const addrSt = h('ADDRST') || '';
              const addrSf = h('ADDRSF') || '';
              const fullAddr = [addrNum, addrDir, addrSt, addrSf].filter(Boolean).join(' ').trim();
              return {
                TRUE_SITE_ADDR: fullAddr || h('LGLDS1') || '',
                TRUE_SITE_CITY: cityUp || h('OWNADCITY') || '',
                TRUE_SITE_ZIP_CODE: h('OWNADZIP') || '',
                TRUE_OWNER1: h('OWNNM1') || h('OWNER48') || '',
                TRUE_OWNER2: h('OWNNM2') || '',
                TRUE_MAILING_ADDR1: h('MLADR1') || h('OWNAD1') || '',
                TRUE_MAILING_CITY: h('OWNADCITY') || '',
                TRUE_MAILING_STATE: h('OWNADSTATE') || 'OH',
                TRUE_MAILING_ZIP_CODE: h('OWNADZIP') || '',
                FOLIO: h('AUDPCLID') || rec['HCE.ParcelFabric_Parcels.NAME'] || '',
                DOR_CODE_CUR: String(h('CLASS') || ''),
                DOR_DESC: h('LANDUSE') || '',
                YEAR_BUILT: 0,
                BUILDING_HEATED_AREA: 0,
                LOT_SIZE: (h('ACREDEED') || 0) * 43560,
                BUILDING_VAL_CUR: h('MKTIMPR') || null,
                LAND_VAL_CUR: h('MKTLND') || null,
                TOTAL_VAL_CUR: h('MKT_TOTAL_VAL') || null,
                BEDROOM_COUNT: 0, BATHROOM_COUNT: 0, HALF_BATHROOM_COUNT: 0,
                SALE_PRICE: h('SALEAM') || null,
                SALE_DATE: h('SALDAT') ? new Date(parseInt(h('SALDAT'))).toISOString().split('T')[0] : null,
                TAXABLE_VAL: null,
                TOTAL_TAX: h('ANNUAL_TAXES') || null,
                OWNER_OCCUPIED: false,
                HOMESTEAD: false,
                RENTAL: false,
                FLOOD_ZONE: '',
                SCHOOL_DISTRICT: '',
                TAX_DISTRICT: String(h('TAXDST') || ''),
                FORECLOSURE: h('FORECL_FLAG') === 'Y',
                DELINQUENT_TAXES: h('DELQ_TAXES') || 0,
                _state: 'OH', _county: 'Hamilton', _source: 'ohio-hamilton'
              };
            }

            // Franklin County (Columbus) format — default
            return {
              TRUE_SITE_ADDR: rec.SITEADDRESS || rec.PRPRTYDSCRP || '',
              TRUE_SITE_CITY: cityUp,
              TRUE_SITE_ZIP_CODE: rec.ZIPCD || '',
              TRUE_OWNER1: rec.OWNERNME1 || '',
              TRUE_OWNER2: rec.OWNERNME2 || '',
              TRUE_MAILING_ADDR1: rec.MAILADD1 || rec.MAILNME1 || '',
              TRUE_MAILING_CITY: rec.MAILCITY || '',
              TRUE_MAILING_STATE: rec.MAILSTATE || 'OH',
              TRUE_MAILING_ZIP_CODE: rec.MAILZIP || '',
              FOLIO: rec.PARCELID || '',
              DOR_CODE_CUR: rec.CLASSCD || rec.USECD || '',
              DOR_DESC: rec.CLASSDSCRP || '',
              YEAR_BUILT: rec.RESYRBLT || 0,
              BUILDING_HEATED_AREA: rec.RESFLRAREA || 0,
              LOT_SIZE: rec.STATEDAREA ? rec.STATEDAREA * 43560 : 0,
              BUILDING_VAL_CUR: rec.BLDVALUEBASE || null,
              LAND_VAL_CUR: rec.LNDVALUEBASE || null,
              TOTAL_VAL_CUR: rec.TOTVALUEBASE || null,
              BEDROOM_COUNT: rec.BEDRMS || 0,
              BATHROOM_COUNT: rec.BATHS || 0,
              HALF_BATHROOM_COUNT: rec.HBATHS || 0,
              SALE_PRICE: rec.SALEPRICE || null,
              SALE_DATE: rec.SALEDATE ? new Date(parseInt(rec.SALEDATE)).toISOString().split('T')[0] : null,
              TAXABLE_VAL: rec.CNTTXBLVAL || null,
              TOTAL_TAX: rec.TOTCNTTXOD || null,
              OWNER_OCCUPIED: rec.OWNEROCCUPIED === 'Y',
              HOMESTEAD: rec.HOMSTD === 'Y',
              RENTAL: rec.RENTAL === 'Y',
              FLOOD_ZONE: rec.FLOOD || '',
              SCHOOL_DISTRICT: rec.SCHLDSCRP || '',
              TAX_DISTRICT: rec.CVTTXDSCRP || '',
              CONDITION: rec.COND || '',
              GRADE: rec.GRADE || '',
              BASEMENT: rec.BASEMENT || '',
              AC: rec.AIRCOND || '',
              WALL_TYPE: rec.WALL || '',
              ROOMS: rec.ROOMS || 0,
              FIREPLACE: rec.FIREPLC || 0,
              _state: 'OH', _county: 'Franklin', _source: 'ohio-franklin'
            };
          } catch { return null; }
        }).filter(Boolean);
      }
    } catch (e) {
      if (e.status !== 1) console.error(`OH grep error ${file}: ${e.message}`);
    }
  }
  return [];
}

// ─── Ohio Property Lookup ────────────────────────────────────────
export async function lookupOhioByAddress(address, city = '') {
  const results = searchOhioByAddress(address, city);
  if (results.length === 0) return [];

  // Geocode first result for lat/lng
  const first = results[0];
  const fullAddr = `${first.TRUE_SITE_ADDR}, ${city || first.TRUE_SITE_CITY}, OH ${first.TRUE_SITE_ZIP_CODE}`;
  try {
    const params = new URLSearchParams({
      address: fullAddr,
      benchmark: 'Public_AR_Current',
      format: 'json'
    });
    const data = await fetchJSON(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`);
    const match = data?.result?.addressMatches?.[0];
    if (match) {
      first.lat = match.coordinates.y;
      first.lng = match.coordinates.x;
    }
  } catch {}

  return results.map((r, i) => ({
    ...r,
    lat: i === 0 ? first.lat : null,
    lng: i === 0 ? first.lng : null
  }));
}

// ─── Ohio Property Intelligence Assembly ─────────────────────────
export async function assembleOhioPropertyIntelligence(address, city = '') {
  const timestamp = new Date().toISOString();

  // Step 1: Find the property
  const properties = await lookupOhioByAddress(address, city);
  if (!properties.length) {
    return { error: `Property not found: ${address}, ${city}, OH`, timestamp };
  }
  const prop = properties[0];
  const lat = prop.lat;
  const lng = prop.lng;

  // Step 2: FEMA Flood (works nationwide)
  let flood = null;
  if (lat && lng) {
    try {
      const params = new URLSearchParams({
        geometry: `${lng},${lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID',
        f: 'json'
      });
      const data = await fetchJSON(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?${params}`);
      if (data?.features?.[0]) {
        const a = data.features[0].attributes;
        flood = {
          zone: a.FLD_ZONE,
          subtype: a.ZONE_SUBTY,
          specialFloodHazard: a.SFHA_TF === 'T',
          baseFloodElevation: a.STATIC_BFE > 0 ? a.STATIC_BFE : null,
          insuranceRequired: a.SFHA_TF === 'T'
        };
      }
    } catch {}
  }

  // Step 3: Elevation (works nationwide)
  let elevation = null;
  if (lat && lng) {
    try {
      const data = await fetchJSON(`https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&wkid=4326&units=Feet`);
      if (data?.value) elevation = { elevationFt: Math.round(data.value * 100) / 100, source: 'USGS 3DEP' };
    } catch {}
  }

  // Step 4: Investor signals
  const signals = [];
  if (prop.TRUE_MAILING_STATE && prop.TRUE_MAILING_STATE !== 'OH') signals.push('Out of State Owner');
  const mailNorm = (prop.TRUE_MAILING_ADDR1 || '').replace(/[^A-Z0-9]/gi, '');
  const siteNorm = (prop.TRUE_SITE_ADDR || '').replace(/[^A-Z0-9]/gi, '');
  if (mailNorm && siteNorm && mailNorm !== siteNorm) signals.push('Absentee Owner');
  const owner = (prop.TRUE_OWNER1 || '').toUpperCase();
  if (/LLC|INC|CORP|LTD|HOLDINGS|PROPERTIES|PARTNERS/.test(owner)) signals.push('Corporate/LLC Owner');
  if (/TRUST|TRUSTEE|TR |TTEE/.test(owner)) signals.push('Trust Owner');
  if (prop.RENTAL) signals.push('Rental Property');
  if (prop.HOMESTEAD) signals.push('Homestead Exemption');
  if (!prop.OWNER_OCCUPIED && !signals.includes('Absentee Owner')) signals.push('Possible Investment Property');

  // Owner lookup
  const ownerName = (prop.TRUE_OWNER1 || '').replace(/[^a-zA-Z ]/g, '').trim();
  const ownerLookupUrl = ownerName.length > 3
    ? `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(ownerName)}&citystatezip=${encodeURIComponent((city || 'Columbus') + ' OH')}`
    : null;

  // Build source list
  const sourceList = ['Franklin County Auditor (ArcGIS)'];
  if (flood) sourceList.push('FEMA NFHL');
  if (elevation) sourceList.push('USGS 3DEP Elevation');

  // Confidence
  let confidence = 0.50;
  if (lat && lng) confidence += 0.10;
  if (flood) confidence += 0.10;
  if (elevation) confidence += 0.05;
  if (prop.SALE_PRICE) confidence += 0.05;
  if (prop.YEAR_BUILT) confidence += 0.05;
  if (prop.TOTAL_VAL_CUR) confidence += 0.05;
  if (prop.SCHOOL_DISTRICT) confidence += 0.03;
  confidence = Math.min(1.0, Math.round(confidence * 100) / 100);

  return {
    origin: {
      version: '0.5',
      state: 'OH',
      county: 'Franklin',
      propertyId: `OH-FRANK-${prop.FOLIO}`,
      assembledDate: timestamp,
      sources: sourceList,
      dataLayers: sourceList.length,
      confidence
    },
    property: {
      address: prop.TRUE_SITE_ADDR,
      city: city || prop.TRUE_SITE_CITY,
      state: 'OH',
      zip: prop.TRUE_SITE_ZIP_CODE,
      parcelId: prop.FOLIO,
      coordinates: lat && lng ? { lat, lng } : null,
      owner: { name1: prop.TRUE_OWNER1, name2: prop.TRUE_OWNER2 },
      ownerOccupied: prop.OWNER_OCCUPIED,
      building: {
        yearBuilt: prop.YEAR_BUILT,
        livingArea: prop.BUILDING_HEATED_AREA,
        bedrooms: prop.BEDROOM_COUNT,
        bathrooms: prop.BATHROOM_COUNT,
        halfBathrooms: prop.HALF_BATHROOM_COUNT,
        rooms: prop.ROOMS,
        fireplace: prop.FIREPLACE,
        basement: prop.BASEMENT,
        ac: prop.AC,
        wallType: prop.WALL_TYPE,
        condition: prop.CONDITION,
        grade: prop.GRADE
      },
      lot: { acres: prop.LOT_SIZE / 43560, sqft: prop.LOT_SIZE },
      classification: {
        classCode: prop.DOR_CODE_CUR,
        description: prop.DOR_DESC,
        rental: prop.RENTAL,
        homestead: prop.HOMESTEAD
      },
      values: {
        totalValue: prop.TOTAL_VAL_CUR,
        landValue: prop.LAND_VAL_CUR,
        buildingValue: prop.BUILDING_VAL_CUR,
        taxableValue: prop.TAXABLE_VAL,
        annualTax: prop.TOTAL_TAX
      },
      lastSale: {
        price: prop.SALE_PRICE,
        date: prop.SALE_DATE
      },
      schoolDistrict: prop.SCHOOL_DISTRICT,
      taxDistrict: prop.TAX_DISTRICT,
      floodZone: prop.FLOOD_ZONE
    },
    flood: flood || { zone: prop.FLOOD_ZONE || 'UNKNOWN' },
    elevation,
    investorSignals: {
      flags: signals,
      flagCount: signals.length,
      ownerOccupied: prop.OWNER_OCCUPIED,
      rental: prop.RENTAL,
      homestead: prop.HOMESTEAD,
      ownerLookupUrl
    }
  };
}
