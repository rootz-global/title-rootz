#!/usr/bin/env node
// Pull statewide overlay data for Florida
// Schools (FL DOE), Hospitals (CMS), EV Charging (DOE), EPA TRI
// All single-pull datasets — no county-by-county needed

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withCensusKey, warnIfNoCensusKey, CENSUS_API_KEY, CENSUS_KEY_HINT } from './lib/census.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'florida');

async function fetchJSON(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return await resp.json();
  } catch (e) {
    clearTimeout(timer);
    console.error(`  Fetch error: ${e.message}`);
    return null;
  }
}

// ─── FL Schools (all public schools statewide) ───────────────────
async function pullSchools() {
  console.log('Pulling FL public schools...');
  const url = 'https://services1.arcgis.com/CY1LXxlDTSVFi5jE/arcgis/rest/services/Florida_Public_Schools/FeatureServer/0/query'
    + '?where=1%3D1&outFields=*&returnGeometry=true&resultRecordCount=5000&f=json';

  const allSchools = [];
  let offset = 0;

  while (true) {
    const pageUrl = url + `&resultOffset=${offset}`;
    const data = await fetchJSON(pageUrl);
    if (!data?.features?.length) break;

    for (const f of data.features) {
      const a = f.attributes;
      const geo = f.geometry;
      allSchools.push({
        ...a,
        lat: geo?.y || null,
        lng: geo?.x || null
      });
    }
    console.log(`  Schools: ${allSchools.length} so far...`);
    offset += data.features.length;
    if (data.features.length < 5000) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (allSchools.length === 0) {
    // Try alternate source — FL DOE
    console.log('  Primary source failed, trying FLDOE...');
    const altUrl = 'https://services1.arcgis.com/CY1LXxlDTSVFi5jE/arcgis/rest/services/FloridaSchools/FeatureServer/0/query'
      + '?where=1%3D1&outFields=*&returnGeometry=true&resultRecordCount=5000&f=json';
    const data = await fetchJSON(altUrl, 60000);
    if (data?.features) {
      for (const f of data.features) {
        allSchools.push({ ...f.attributes, lat: f.geometry?.y, lng: f.geometry?.x });
      }
    }
  }

  const outPath = path.join(DATA_DIR, 'statewide-schools.json');
  fs.writeFileSync(outPath, JSON.stringify(allSchools, null, 2));
  console.log(`  Saved ${allSchools.length} schools (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)}MB)`);
  return allSchools.length;
}

// ─── Hospitals (CMS nationwide, filter to FL) ────────────────────
async function pullHospitals() {
  console.log('Pulling FL hospitals from CMS...');
  // CMS Hospital Compare CSV — filter to FL
  const url = 'https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0'
    + '?conditions[0][property]=state&conditions[0][value]=FL&limit=500&offset=0';

  const data = await fetchJSON(url, 60000);
  if (!data?.results) {
    console.log('  CMS API format changed, trying alternate...');
    // Try direct download approach
    const altUrl = 'https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?limit=500&conditions[0][property]=state&conditions[0][value]=FL';
    const altData = await fetchJSON(altUrl, 60000);
    if (altData?.results) {
      const outPath = path.join(DATA_DIR, 'statewide-hospitals.json');
      fs.writeFileSync(outPath, JSON.stringify(altData.results, null, 2));
      console.log(`  Saved ${altData.results.length} hospitals`);
      return altData.results.length;
    }
    console.log('  CMS pull failed — will use existing hospitals.json');
    return 0;
  }

  const outPath = path.join(DATA_DIR, 'statewide-hospitals.json');
  fs.writeFileSync(outPath, JSON.stringify(data.results, null, 2));
  console.log(`  Saved ${data.results.length} hospitals`);
  return data.results.length;
}

// ─── EV Charging (DOE AFDC, all of FL) ───────────────────────────
async function pullEVCharging() {
  console.log('Pulling FL EV charging stations from DOE...');
  // NREL AFDC — pull all FL stations
  const allStations = [];

  for (let offset = 0; offset < 20000; offset += 200) {
    const url = `https://developer.nrel.gov/api/alt-fuel-stations/v1.json`
      + `?api_key=DEMO_KEY&fuel_type=ELEC&state=FL&limit=200&offset=${offset}`;
    const data = await fetchJSON(url, 30000);
    if (!data?.fuel_stations?.length) break;
    allStations.push(...data.fuel_stations);
    console.log(`  EV stations: ${allStations.length} / ${data.total_results || '?'}`);
    if (allStations.length >= (data.total_results || 0)) break;
    await new Promise(r => setTimeout(r, 1000)); // rate limit demo key
  }

  const outPath = path.join(DATA_DIR, 'statewide-ev-charging.json');
  fs.writeFileSync(outPath, JSON.stringify(allStations, null, 2));
  console.log(`  Saved ${allStations.length} EV stations (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)}MB)`);
  return allStations.length;
}

// ─── EPA TRI (Toxic Release Inventory, all FL) ───────────────────
async function pullEPATRI() {
  console.log('Pulling FL EPA TRI facilities...');
  const allFacilities = [];

  for (let offset = 0; offset < 5000; offset += 500) {
    const url = `https://data.epa.gov/efservice/TRI_FACILITY/STATE_ABBR/FL/ROWS/${offset}:${offset + 499}`;
    const resp = await fetch(url);
    const text = await resp.text();

    // Parse XML
    const facilities = [];
    const regex = /<tri_facility>([\s\S]*?)<\/tri_facility>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const rec = {};
      const fieldRegex = /<(\w+)>(.*?)<\/\1>/g;
      let fieldMatch;
      while ((fieldMatch = fieldRegex.exec(match[1])) !== null) {
        rec[fieldMatch[1]] = fieldMatch[2] === 'None' ? null : fieldMatch[2];
      }
      facilities.push(rec);
    }

    if (facilities.length === 0) break;
    allFacilities.push(...facilities);
    console.log(`  TRI facilities: ${allFacilities.length}`);
    await new Promise(r => setTimeout(r, 500));
  }

  const outPath = path.join(DATA_DIR, 'statewide-epa-tri.json');
  fs.writeFileSync(outPath, JSON.stringify(allFacilities, null, 2));
  console.log(`  Saved ${allFacilities.length} TRI facilities (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)}MB)`);
  return allFacilities.length;
}

// ─── Census Block Groups (all FL) ────────────────────────────────
async function pullCensus() {
  console.log('Pulling FL Census ACS block group data...');
  const variables = 'B01003_001E,B19013_001E,B25077_001E,B25064_001E,B01002_001E,B19301_001E,B25002_001E,B25002_002E,B25002_003E,B25003_001E,B25003_002E';
  const url = `https://api.census.gov/data/2022/acs/acs5?get=${variables}&for=block%20group:*&in=state:12&in=county:*`;

  warnIfNoCensusKey();
  const data = await fetchJSON(withCensusKey(url), 120000);
  if (!data || !Array.isArray(data)) {
    console.log(`  Census pull failed. ${CENSUS_API_KEY ? '' : CENSUS_KEY_HINT}`);
    return 0;
  }

  const headers = data[0];
  const records = data.slice(1).map(row => {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = row[i]; });
    return rec;
  });

  const outPath = path.join(DATA_DIR, 'statewide-census-blockgroups.json');
  fs.writeFileSync(outPath, JSON.stringify(records, null, 2));
  console.log(`  Saved ${records.length} block groups (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)}MB)`);
  return records.length;
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('Florida Statewide Overlay Data Pull');
  console.log(`Output: ${DATA_DIR}`);
  console.log();

  const results = {};
  results.schools = await pullSchools();
  results.hospitals = await pullHospitals();
  results.evCharging = await pullEVCharging();
  results.tri = await pullEPATRI();
  results.census = await pullCensus();

  console.log('\n=== Summary ===');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k}: ${v.toLocaleString()} records`);
  }

  // List all statewide files
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('statewide'));
  console.log('\nStatewide files:');
  for (const f of files) {
    const size = fs.statSync(path.join(DATA_DIR, f)).size;
    console.log(`  ${f}: ${(size / 1024 / 1024).toFixed(1)}MB`);
  }
}

main().catch(console.error);
