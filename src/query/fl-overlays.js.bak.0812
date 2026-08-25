/**
 * AI_CONTEXT: Florida overlay data — flood, census, elevation, federal, economics
 *
 * Dependencies:
 *   - src/lib/fetch.js (fetchJSON)
 *   - src/lib/data-loader.js (loadDataFile)
 *   - src/lib/constants.js (FEMA_FLOOD, CENSUS_GEOCODER, CENSUS_ACS, SSL_CERTS)
 *
 * Exports:
 *   - getFloodZone(lat, lng) — FEMA NFHL flood zone lookup
 *   - getCensusData(address, city, state, zip) — Census demographics via live geocoding
 *   - identifyAllLayers(lat, lng) — Miami-Dade GIS all-layer identify
 *   - getElevation(lat, lng) — USGS 3DEP elevation query
 *   - getIRSIncomeByZip(zip) — IRS SOI income by ZIP code
 *   - getFEMADisastersByCounty(county) — FEMA disaster declarations
 *   - getNFIPClaimsByZip(zip) — FEMA NFIP flood claims
 *   - lookupStatwideCensus(tract, blockGroup, county) — Cached statewide census
 *   - getStatewideEconomics(city) — FRED/BLS economic data by metro area
 *   - getMarketEconomics() — Market economics (FRED CSVs)
 *   - lookupCensusBlockGroup(tract, blockGroup) — Cached MDC census
 */

import { fetchJSON } from '../lib/fetch.js';
import { loadDataFile } from '../lib/data-loader.js';
import { FEMA_FLOOD, CENSUS_GEOCODER, CENSUS_ACS, MDC_IDENTIFY, SSL_CERTS } from '../lib/constants.js';

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

export async function getCensusData(address, city, state = 'FL', zip = '') {
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

  // Try cached statewide Census data first ($0, instant)
  const cached = lookupStatwideCensus(tract, blockGroup, county);
  if (cached && cached.medianHouseholdIncome) {
    return {
      coordinates: { lat, lng },
      tract, blockGroup, county, state: stateCode,
      congressionalDistrict: congressData?.BASENAME || congressData?.NAME || null,
      stateSenate: senateData?.BASENAME || senateData?.NAME || null,
      stateHouse: houseData?.BASENAME || houseData?.NAME || null,
      ...cached,
      ownerOccupiedRate: cached.occupiedHousing > 0 ? Math.round((cached.ownerOccupied / cached.occupiedHousing) * 100) : null,
      source: 'US Census ACS 2022 (statewide cached — instant)'
    };
  }

  // Fallback: hit live ACS API
  const acsUrl = `${CENSUS_ACS}?get=B19013_001E,B01003_001E,B25077_001E,B25064_001E,B25003_001E,B25003_002E,B01002_001E,B19301_001E,B25002_001E,B25002_002E,B25002_003E&for=block%20group:${blockGroup}&in=state:${stateCode}+county:${county}+tract:${tract}`;

  const acsData = await fetchJSON(acsUrl);
  if (!acsData || acsData.length < 2) return { error: 'ACS data not available', tract, blockGroup };

  const values = acsData[1];
  const occupied = parseInt(values[8]) || 0;
  const ownerOcc = parseInt(values[5]) || 0;

  return {
    coordinates: { lat, lng },
    tract, blockGroup, county, state: stateCode,
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
    source: 'US Census ACS 2022 (live API fallback)',
    sslCert: SSL_CERTS['api.census.gov']
  };
}

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

// ─── Federal Data Lookups (cached) ──────────────────────────────

let _irsCache = null;
export function getIRSIncomeByZip(zipCode) {
  if (!zipCode) return null;
  const zip = String(zipCode).substring(0, 5);

  if (!_irsCache) {
    const raw = loadDataFile('florida/federal-irs-soi-income.csv') || loadDataFile('federal-irs-soi-income.csv');
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

let _disasterCache = null;
export function getFEMADisastersByCounty(countyName) {
  if (!countyName) return null;
  if (!_disasterCache) {
    _disasterCache = loadDataFile('florida/federal-fema-disasters-by-county.json') || loadDataFile('federal-fema-disasters-by-county.json');
  }
  if (!_disasterCache) return null;
  const upper = countyName.toUpperCase();
  for (const [key, val] of Object.entries(_disasterCache)) {
    if (key.toUpperCase().includes(upper) || upper.includes(key.toUpperCase().replace(/ \(COUNTY\)/, ''))) {
      return { county: key, ...val };
    }
  }
  return null;
}

let _nfipCache = null;
export function getNFIPClaimsByZip(zipCode) {
  if (!zipCode) return null;
  const zip = String(zipCode).substring(0, 5);
  if (!_nfipCache) {
    _nfipCache = loadDataFile('florida/federal-fema-nfip-by-zip.json') || loadDataFile('federal-fema-nfip-by-zip.json');
  }
  if (!_nfipCache) return null;
  return _nfipCache[zip] || null;
}

let _censusSWCache = null;
export function lookupStatwideCensus(tract, blockGroup, countyFips) {
  if (!tract || !blockGroup) return null;
  if (!_censusSWCache) {
    const data = loadDataFile('florida/statewide-census-blockgroups.json') || loadDataFile('statewide-census-blockgroups.json');
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

export function getStatewideEconomics(city) {
  const fredData = loadDataFile('florida/statewide-fred-economics.json') || loadDataFile('statewide-fred-economics.json');
  if (!fredData) return null;

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
    'PENSACOLA': 'Pensacola', 'TALLAHASSEE': 'Tallahassee',
    'NAPLES': 'Naples', 'MARCO ISLAND': 'Naples', 'OCALA': 'Ocala', 'GAINESVILLE': 'Gainesville',
    'PALM BAY': 'Palm_Bay', 'MELBOURNE': 'Palm_Bay', 'TITUSVILLE': 'Palm_Bay',
  };

  const metroKey = metroMap[cityUp];
  if (!metroKey || !fredData[metroKey]) return null;
  return fredData[metroKey];
}

export function getMarketEconomics() {
  const result = {};
  const fredFiles = {
    medianPrice: 'fred-median-price.csv', activeListings: 'fred-active-listings.csv',
    daysOnMarket: 'fred-days-on-market.csv', newListings: 'fred-new-listings.csv',
    unemployment: 'fred-unemployment.csv'
  };

  for (const [key, file] of Object.entries(fredFiles)) {
    const raw = loadDataFile(`florida/${file}`) || loadDataFile(file);
    if (raw && typeof raw === 'string') {
      const lines = raw.trim().split('\n');
      const data = lines.slice(1).map(line => {
        const [date, value] = line.split(',');
        return { date: date.trim(), value: parseFloat(value) };
      }).filter(d => !isNaN(d.value));
      if (data.length) {
        result[key] = { latest: data[data.length - 1], trend: data.slice(-6), source: `FRED (${file})` };
      }
    }
  }

  const cpi = loadDataFile('florida/bls-cpi-miami.json') || loadDataFile('bls-cpi-miami.json');
  if (cpi) result.costOfLiving = { data: cpi, source: 'BLS CPI-U Miami-Fort Lauderdale' };
  return result;
}

export function lookupCensusBlockGroup(tract, blockGroup) {
  const bgData = loadDataFile('florida/census-block-groups.json') || loadDataFile('census-block-groups.json');
  if (!bgData) return null;
  const match = bgData.find(bg => bg.tract === tract && bg['block group'] === blockGroup);
  if (!match) return null;

  const toNum = (v) => { const n = parseInt(v); return (isNaN(n) || n === -666666666) ? null : n; };
  return {
    tract, blockGroup,
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
