#!/usr/bin/env node
/**
 * Origin Title Records — Data Refresh Automation
 *
 * Refreshes cached overlay data from government sources.
 * Run daily or weekly via cron.
 *
 * Usage:
 *   node refresh.mjs --all           # Refresh everything
 *   node refresh.mjs --permits       # Just permits
 *   node refresh.mjs --schools       # Just schools
 *   node refresh.mjs --census        # Just census block groups
 *   node refresh.mjs --parcels       # Full parcel re-pull (slow, ~30 min)
 *
 * Recommended cron schedule:
 *   Weekly:  permits, parcels
 *   Monthly: schools, roads, traffic
 *   Annual:  census, evacuation routes
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import crypto from 'crypto';
import { withCensusKey, warnIfNoCensusKey, CENSUS_API_KEY, CENSUS_KEY_HINT } from './lib/census.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'florida');
const LOG_FILE = path.join(DATA_DIR, 'refresh-log.json');

// ─── Config ───────────────────────────────────────────────────────
const ARCGIS_MDC = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services';
const ARCGIS_MIAMI = 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services';
const GIS_MDC = 'https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/24/query';

const LAYERS = {
  schools: { url: `${ARCGIS_MDC}/SchoolSite_gdb/FeatureServer/0`, file: 'schools.json', schedule: 'monthly' },
  privateSchools: { url: `${ARCGIS_MDC}/PrivateSchool_gdb/FeatureServer/0`, file: 'private-schools.json', schedule: 'monthly' },
  charterSchools: { url: `${ARCGIS_MDC}/CharterSchool_gdb/FeatureServer/0`, file: 'charter-schools.json', schedule: 'monthly' },
  roadImprovements: { url: `${ARCGIS_MDC}/RoadWayImprovement_gdb/FeatureServer/0`, file: 'road-improvements.json', schedule: 'monthly' },
  trafficCounts: { url: `${ARCGIS_MDC}/MDCTrafficCountStation_gdb/FeatureServer/0`, file: 'traffic-counts.json', schedule: 'annual' },
  evacRoutes: { url: `${ARCGIS_MDC}/PrimaryEvacuationRoute_gdb/FeatureServer/0`, file: 'evacuation-routes.json', schedule: 'annual' },
  countyPermits: { url: `${ARCGIS_MDC}/BuildingPermit_gdb/FeatureServer/0`, file: 'building-permits.json', schedule: 'weekly' },
  cityMiamiPermits: { url: `${ARCGIS_MIAMI}/Building_Permits_Since_2014/FeatureServer/0`, file: 'miami-city-permits.json', schedule: 'weekly' },
};

// ─── Fetch Helper ─────────────────────────────────────────────────
function fetchJSON(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Pull All Records From a Layer ────────────────────────────────
async function pullLayer(name, config) {
  const startTime = Date.now();
  console.log(`\n[${name}] Pulling from ${config.url.split('/').slice(-3).join('/')}`);

  const allRecords = [];
  let offset = 0;
  const batchSize = 2000;

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      resultOffset: offset,
      resultRecordCount: batchSize,
      f: 'json'
    });

    try {
      const data = await fetchJSON(`${config.url}/query?${params}`);
      const features = data?.features || [];
      if (!features.length) break;

      for (const f of features) {
        const record = f.attributes || {};
        // Extract lat/lng from point geometry
        if (f.geometry?.x) {
          record._lng = f.geometry.x;
          record._lat = f.geometry.y;
        }
        allRecords.push(record);
      }

      offset += features.length;
      if (offset % 10000 < batchSize) {
        console.log(`  [${name}] ${offset.toLocaleString()} records...`);
      }

      if (!data.exceededTransferLimit) break;
      await new Promise(r => setTimeout(r, 300)); // rate limit
    } catch (e) {
      console.error(`  [${name}] Error at offset ${offset}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
  }

  // Save
  const outPath = path.join(DATA_DIR, config.file);
  fs.writeFileSync(outPath, JSON.stringify(allRecords, null, 0));

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  const hash = crypto.createHash('sha256').update(JSON.stringify(allRecords)).digest('hex').substring(0, 16);

  console.log(`  [${name}] DONE: ${allRecords.length.toLocaleString()} records, ${size}MB, ${duration}s, hash:${hash}`);

  return {
    layer: name,
    file: config.file,
    records: allRecords.length,
    sizeMB: parseFloat(size),
    durationSec: parseFloat(duration),
    hash,
    timestamp: new Date().toISOString()
  };
}

// ─── Pull Census Block Groups ─────────────────────────────────────
async function pullCensus() {
  console.log('\n[census] Pulling all Miami-Dade block groups from Census ACS');
  const startTime = Date.now();

  const url = 'https://api.census.gov/data/2022/acs/acs5?get=B19013_001E,B01003_001E,B25077_001E,B25064_001E,B25003_001E,B25003_002E,B01002_001E,B19301_001E,B25002_001E,B25002_002E,B25002_003E,NAME&for=block%20group:*&in=state:12+county:086';

  warnIfNoCensusKey();
  const data = await fetchJSON(withCensusKey(url));
  // Keyless requests redirect to an HTML page, so `data` comes back as null or
  // a non-array and `data[0]` threw — killing the whole annual refresh run.
  if (!Array.isArray(data) || data.length < 2) {
    console.error(`  [census] FAILED: no rows returned. ${CENSUS_API_KEY ? '' : CENSUS_KEY_HINT}`);
    return { layer: 'census', records: 0, error: 'no data' };
  }
  const header = data[0];
  const rows = data.slice(1);
  const results = rows.map(row => {
    const d = {};
    header.forEach((field, i) => d[field] = row[i]);
    return d;
  });

  const outPath = path.join(DATA_DIR, 'census-block-groups.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  [census] DONE: ${results.length} block groups, ${duration}s`);

  return {
    layer: 'census',
    file: 'census-block-groups.json',
    records: results.length,
    durationSec: parseFloat(duration),
    timestamp: new Date().toISOString()
  };
}

// ─── Pull Miami-Dade Parcels ──────────────────────────────────────
async function pullParcels() {
  console.log('\n[parcels] Pulling all Miami-Dade parcels (this takes ~30 minutes)');
  const startTime = Date.now();
  const fields = 'FOLIO,TRUE_SITE_ADDR,TRUE_SITE_CITY,TRUE_SITE_ZIP_CODE,TRUE_OWNER1,TRUE_OWNER2,TRUE_MAILING_ADDR1,TRUE_MAILING_CITY,TRUE_MAILING_STATE,TRUE_MAILING_ZIP_CODE,TOTAL_VAL_CUR,LAND_VAL_CUR,BUILDING_VAL_CUR,LOT_SIZE,YEAR_BUILT,BEDROOM_COUNT,BATHROOM_COUNT,HALF_BATHROOM_COUNT,FLOOR_COUNT,UNIT_COUNT,BUILDING_COUNT,BUILDING_HEATED_AREA,BUILDING_GROSS_AREA,DOR_CODE_CUR,DOR_DESC,PRIMARY_ZONE,SUBDIVISION,CONDO_FLAG,PARENT_FOLIO';

  const outPath = path.join(DATA_DIR, 'miami-dade-parcels.jsonl');
  const outStream = fs.createWriteStream(outPath);
  let totalRecords = 0;
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: fields,
      returnGeometry: 'false',
      resultOffset: offset,
      resultRecordCount: 2000,
      f: 'json'
    });

    try {
      const data = await fetchJSON(`${GIS_MDC}?${params}`, 60000);
      const features = data?.features || [];
      if (!features.length) break;

      for (const f of features) {
        outStream.write(JSON.stringify(f.attributes) + '\n');
        totalRecords++;
      }

      offset += features.length;
      if (offset % 20000 < 2000) {
        const pct = (offset / 940000 * 100).toFixed(1);
        console.log(`  [parcels] ${offset.toLocaleString()} (${pct}%)`);
      }

      if (!data.exceededTransferLimit) break;
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  [parcels] Error at ${offset}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  outStream.end();
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  [parcels] DONE: ${totalRecords.toLocaleString()} records, ${duration}s`);

  return {
    layer: 'parcels',
    file: 'miami-dade-parcels.jsonl',
    records: totalRecords,
    durationSec: parseFloat(duration),
    timestamp: new Date().toISOString()
  };
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const doAll = args.includes('--all');
  const startTime = new Date();

  console.log(`Origin Title Records — Data Refresh`);
  console.log(`Started: ${startTime.toISOString()}`);
  console.log(`Args: ${args.join(' ') || '(none — use --all, --permits, --schools, --census, --parcels)'}`);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const results = [];

  // Permits (weekly)
  if (doAll || args.includes('--permits')) {
    results.push(await pullLayer('countyPermits', LAYERS.countyPermits));
    results.push(await pullLayer('cityMiamiPermits', LAYERS.cityMiamiPermits));
  }

  // Schools (monthly)
  if (doAll || args.includes('--schools')) {
    results.push(await pullLayer('schools', LAYERS.schools));
    results.push(await pullLayer('privateSchools', LAYERS.privateSchools));
    results.push(await pullLayer('charterSchools', LAYERS.charterSchools));
  }

  // Roads & Traffic (monthly)
  if (doAll || args.includes('--roads')) {
    results.push(await pullLayer('roadImprovements', LAYERS.roadImprovements));
    results.push(await pullLayer('trafficCounts', LAYERS.trafficCounts));
    results.push(await pullLayer('evacRoutes', LAYERS.evacRoutes));
  }

  // Census (annual)
  if (doAll || args.includes('--census')) {
    results.push(await pullCensus());
  }

  // Parcels (weekly — slow)
  if (doAll || args.includes('--parcels')) {
    results.push(await pullParcels());
  }

  // Leon County permits (weekly)
  if (doAll || args.includes('--permits') || args.includes('--leon')) {
    results.push(await pullLayer('leonPermits', {
      url: 'https://intervector.leoncountyfl.gov/intervector/rest/services/MapServices/TLC_OverlayPermitsActive_D_WM/MapServer/0',
      file: 'permits/leon-tallahassee-active.json',
      schedule: 'weekly'
    }));
  }

  // Charlotte County new construction (weekly)
  if (doAll || args.includes('--permits') || args.includes('--charlotte')) {
    results.push(await pullLayer('charlotteNewConstruction', {
      url: 'https://agis3.charlottecountyfl.gov/arcgis/rest/services/Essentials/CCGISLayers/MapServer/67',
      file: 'permits/charlotte-new-construction.json',
      schedule: 'weekly'
    }));
  }

  // Orlando Code Enforcement (weekly)
  if (doAll || args.includes('--code-enforcement') || args.includes('--ce')) {
    console.log('\n[orlando-ce] Pulling from Socrata...');
    const ceStart = Date.now();
    try {
      const ceRecords = [];
      let ceOffset = 0;
      while (true) {
        const ceUrl = `https://data.cityoforlando.net/resource/k6e8-nw6w.json?$limit=50000&$offset=${ceOffset}`;
        const ceData = await fetchJSON(ceUrl);
        if (!ceData.length) break;
        ceRecords.push(...ceData);
        ceOffset += ceData.length;
        if (ceData.length < 50000) break;
      }
      const cePath = path.join(DATA_DIR, 'code-enforcement', 'orlando-code-enforcement.json');
      if (!fs.existsSync(path.dirname(cePath))) fs.mkdirSync(path.dirname(cePath), { recursive: true });
      fs.writeFileSync(cePath, JSON.stringify(ceRecords));
      const ceDuration = ((Date.now() - ceStart) / 1000).toFixed(1);
      console.log(`  [orlando-ce] DONE: ${ceRecords.length.toLocaleString()} records, ${ceDuration}s`);
      results.push({ layer: 'orlando-ce', file: 'code-enforcement/orlando-code-enforcement.json', records: ceRecords.length, durationSec: parseFloat(ceDuration), timestamp: new Date().toISOString() });
    } catch (e) {
      console.error(`  [orlando-ce] Error: ${e.message}`);
    }
  }

  // DBPR Vacation Rental Licenses (monthly — run pull-dbpr-licenses.mjs)
  if (args.includes('--dbpr')) {
    console.log('\n[dbpr] Running pull-dbpr-licenses.mjs...');
    const { execSync } = await import('child_process');
    try {
      execSync('node pull-dbpr-licenses.mjs', { cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: 'inherit', timeout: 300000 });
      results.push({ layer: 'dbpr-licenses', file: 'dbpr-licenses/vacation-rentals-statewide.jsonl', records: 0, timestamp: new Date().toISOString() });
    } catch (e) {
      console.error(`  [dbpr] Error: ${e.message}`);
    }
  }

  // Save refresh log
  const log = {
    started: startTime.toISOString(),
    completed: new Date().toISOString(),
    durationMinutes: ((Date.now() - startTime.getTime()) / 60000).toFixed(1),
    layers: results
  };

  // Append to log file
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); } catch {}
  }
  logs.push(log);
  // Keep last 30 entries
  if (logs.length > 30) logs = logs.slice(-30);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));

  console.log(`\n========================================`);
  console.log(`REFRESH COMPLETE`);
  console.log(`Duration: ${log.durationMinutes} minutes`);
  console.log(`Layers: ${results.length}`);
  console.log(`Total records: ${results.reduce((s, r) => s + r.records, 0).toLocaleString()}`);
  console.log(`Log: ${LOG_FILE}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
