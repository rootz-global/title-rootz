#!/usr/bin/env node
// Pull Ohio county parcel data — county-by-county ArcGIS
// Ohio uses county auditors (not state-level like FL DOR)
// Each county has its own schema — we normalize to a common format
//
// Usage:
//   node pull-ohio.mjs --county franklin         # pull one county
//   node pull-ohio.mjs --county all              # pull all configured counties
//   node pull-ohio.mjs --list                    # show county recipes

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'ohio');

// Ensure output directory
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════
// OHIO COUNTY RECIPES
// ═══════════════════════════════════════════════════════════════

const COUNTIES = {
  franklin: {
    name: 'Franklin County (Columbus)',
    population: 1323000,
    endpoint: 'https://gis.franklincountyohio.gov/hosting/rest/services/ParcelFeatures/Parcel_Features/MapServer/0',
    maxRecords: 3000,
    fields: '*',  // 116 fields — pull everything
    fieldMap: {
      PARCEL_ID: 'PARCELID', ADDRESS: 'SITEADDRESS', ZIP: 'ZIPCD',
      OWNER1: 'OWNERNME1', OWNER2: 'OWNERNME2',
      MAIL_ADDR: 'MAILADD1', MAIL_CITY: 'MAILCITY', MAIL_STATE: 'MAILSTATE', MAIL_ZIP: 'MAILZIP',
      SALE_PRICE: 'SALEPRICE', SALE_DATE: 'SALEDATE',
      CLASS: 'CLASSDSCRP', USE_CODE: 'USECD',
      YEAR_BUILT: 'RESYRBLT', LIVING_AREA: 'RESFLRAREA',
      BEDROOMS: 'BEDRMS', BATHROOMS: 'BATHS', HALF_BATH: 'HBATHS',
      LAND_VAL: 'LNDVALUEBASE', BLDG_VAL: 'BLDVALUEBASE', TOTAL_VAL: 'TOTVALUEBASE',
      TAXABLE_VAL: 'CNTTXBLVAL', TOTAL_TAX: 'TOTCNTTXOD',
      OWNER_OCCUPIED: 'OWNEROCCUPIED', HOMESTEAD: 'HOMSTD',
      FLOOD: 'FLOOD', SCHOOL: 'SCHLDSCRP'
    },
    status: 'ready'
  },

  cuyahoga: {
    name: 'Cuyahoga County (Cleveland)',
    population: 1250000,
    endpoint: 'https://gis.cuyahogacounty.us/server/rest/services/CCFO/APPRAISAL_PARCELS_CAMA_WGS84/MapServer/2',
    maxRecords: 2000,   // 10000 + all fields => "Error performing query operation"; 2000 works
    fields: '*',
    status: 'ready'
  },

  hamilton: {
    name: 'Hamilton County (Cincinnati)',
    population: 830000,
    endpoint: 'https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/HCE_Parcels_With_Auditor_Data/MapServer/0',
    maxRecords: 1000,
    fields: '*',
    status: 'ready'
  },

  summit: {
    name: 'Summit County (Akron)',
    population: 540000,
    endpoint: 'https://scgis.summitoh.net/hosted/rest/services/parcels_web_GEODATA_Tax_Parcels/FeatureServer/0',
    maxRecords: 3000,
    fields: '*',
    status: 'ready'
  },

  montgomery: {
    name: 'Montgomery County (Dayton)',
    population: 540000,
    endpoint: 'https://gis.mcohio.org/server/rest/services/VantagePoints/AUDGIS_B1/MapServer/7',
    maxRecords: 2000,
    fields: '*',
    // ArcGIS returns fully-qualified field names (SDE.mc_parcel_polygon.OBJECTID)
    // because this is a joined MapServer layer (parcel polygon + WEB_CAMA table)
    oidField: 'SDE.mc_parcel_polygon.OBJECTID',
    // Values like ASSDTOTAL come back as comma-formatted strings ("11,710")
    // City info is in SDE.mc_parcel_polygon.LOC_AREA (not LOC_CITY which is null)
    status: 'ready'
  },

  lucas: {
    name: 'Lucas County (Toledo)',
    population: 430000,
    endpoint: 'https://lcaudgis.co.lucas.oh.us/gisaudserver/rest/services/Tyler/Parcels/MapServer/0',
    maxRecords: 1000,
    fields: '*',
    status: 'draft',
    notes: 'Public endpoint has geometry only — no owner/value data. Rich data requires auth.'
  }
};

// ═══════════════════════════════════════════════════════════════
// ARCGIS SERVICE METADATA — DISCOVER OID FIELD
// ═══════════════════════════════════════════════════════════════

async function discoverOidField(endpoint) {
  // Query the service metadata to find the actual objectIdField name.
  // Some ArcGIS services (e.g. Montgomery County) return fully-qualified
  // names like "SDE.mc_parcel_polygon.OBJECTID" instead of "OBJECTID".
  try {
    const resp = await fetch(`${endpoint}?f=json`, { signal: AbortSignal.timeout(15000) });
    const meta = await resp.json();
    if (meta.objectIdField) {
      return meta.objectIdField;
    }
    // Fallback: search the fields array for esriFieldTypeOID
    if (meta.fields) {
      const oidDef = meta.fields.find(f => f.type === 'esriFieldTypeOID');
      if (oidDef) return oidDef.name;
    }
  } catch (e) {
    console.log(`  Warning: could not discover OID field: ${e.message}`);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// GENERIC ARCGIS PULLER (same pattern as FL)
// ═══════════════════════════════════════════════════════════════

async function pullCounty(countyId) {
  const county = COUNTIES[countyId];
  if (!county || !county.endpoint) {
    console.log(`${countyId}: no endpoint configured`);
    return 0;
  }

  console.log(`\nPulling: ${county.name}`);
  console.log(`Endpoint: ${county.endpoint}`);

  // Some counties (Montgomery) return fully-qualified field names like
  // SDE.mc_parcel_polygon.OBJECTID instead of plain OBJECTID.
  // Discover the actual OID field from the service metadata.
  const oidField = county.oidField || await discoverOidField(county.endpoint) || 'OBJECTID';
  console.log(`OID field: ${oidField}`);

  const outFile = path.join(DATA_DIR, `${countyId}-parcels.jsonl`);
  const tmpFile = outFile + '.tmp';            // write to temp; swap in only on success
  const stream = fs.createWriteStream(tmpFile);
  let lastOID = 0;
  let total = 0;
  let retries = 0;
  const startTime = Date.now();

  while (true) {
    const params = new URLSearchParams({
      where: `${oidField}>${lastOID}`,
      outFields: county.fields || '*',
      returnGeometry: 'false',
      resultRecordCount: String(county.maxRecords || 2000),
      orderByFields: oidField,
      f: 'json'
    });

    try {
      const resp = await fetch(`${county.endpoint}/query?${params}`, {
        signal: AbortSignal.timeout(60000)
      });
      const data = await resp.json();

      if (data.error) {
        console.log(`  API error: ${data.error.message}`);
        retries++;
        if (retries > 5) break;
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const features = data.features || [];
      if (features.length === 0) break;

      retries = 0;
      const prevOID = lastOID;
      for (const f of features) {
        stream.write(JSON.stringify(f.attributes) + '\n');
        // Read OID using the actual field name from the attributes
        lastOID = f.attributes[oidField] || f.attributes.OBJECTID || 0;
      }
      total += features.length;

      // Guard: if OID didn't advance, we'd loop forever
      if (lastOID === 0 || lastOID === prevOID) {
        console.log(`  ERROR: OID not advancing (stuck at ${lastOID}). Attribute keys: ${Object.keys(features[0].attributes).slice(0, 5).join(', ')}...`);
        break;
      }

      if (total % 30000 < (county.maxRecords || 2000)) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (total / ((Date.now() - startTime) / 1000)).toFixed(0);
        console.log(`  ${total.toLocaleString()} records | ${elapsed}s | ${rate}/s | OID: ${lastOID}`);
      }

      if (features.length < (county.maxRecords || 2000)) break;
      await new Promise(r => setTimeout(r, 200));

    } catch (e) {
      retries++;
      if (retries > 5) { console.log(`  Max retries. Stopping.`); break; }
      console.log(`  Error: ${e.message}, retry ${retries}/5`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  await new Promise(r => stream.end(r));
  // Only replace the live file if the pull actually returned data — a transient
  // county-GIS error must NOT clobber good data with an empty file.
  if (total > 0) {
    fs.renameSync(tmpFile, outFile);
  } else {
    try { fs.unlinkSync(tmpFile); } catch {}
    console.log(`  WARNING: ${countyId} pulled 0 records (endpoint error?) — keeping previous data, NOT overwriting.`);
  }
  const sizeMB = fs.existsSync(outFile) ? (fs.statSync(outFile).size / 1024 / 1024).toFixed(1) : '0';
  console.log(`  Done: ${total.toLocaleString()} records (${sizeMB}MB) in ${((Date.now() - startTime) / 1000 / 60).toFixed(1)}min`);

  return total;
}

// ═══════════════════════════════════════════════════════════════
// BUILD CITY INDEX (same model as FL)
// ═══════════════════════════════════════════════════════════════

// Rebuild every ready county's slice of the shared city index in one pass.
// Counties share one city namespace (DAYTON appears in both Montgomery and
// Hamilton), so indexing them one at a time with truncating writes lets the
// last county silently erase the previous one's parcels. Clear once, then
// append per county.
async function rebuildAllCityIndexes() {
  const cityDir = path.join(DATA_DIR, 'cities');
  if (fs.existsSync(cityDir)) {
    for (const f of fs.readdirSync(cityDir)) {
      if (f.startsWith('OH_') && f.endsWith('.jsonl')) fs.unlinkSync(path.join(cityDir, f));
    }
  }
  for (const [id, c] of Object.entries(COUNTIES)) {
    if (c.status === 'ready') await buildCityIndex(id, true);
  }
}

async function buildCityIndex(countyId, append = false) {
  const inFile = path.join(DATA_DIR, `${countyId}-parcels.jsonl`);
  const cityDir = path.join(DATA_DIR, 'cities');
  if (!fs.existsSync(inFile)) { console.log(`No parcel file for ${countyId}`); return; }
  if (!fs.existsSync(cityDir)) fs.mkdirSync(cityDir, { recursive: true });

  console.log(`Building city index for ${countyId}...`);
  const county = COUNTIES[countyId];
  const addrField = county?.fieldMap?.ADDRESS || 'SITEADDRESS';

  const { createReadStream } = await import('fs');
  const { createInterface } = await import('readline');

  const rl = createInterface({ input: createReadStream(inFile) });
  const cityStreams = {};
  const cityCounts = {};
  let total = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      // Extract city — different counties use different field names.
      // Some (Montgomery) use fully-qualified names like SDE.mc_parcel_polygon.LOC_AREA
      const getField = (plainName) => {
        // Match case-insensitively on the last dot-segment. Counties differ in
        // both qualification (SDE.mc_parcel_polygon.LOC_AREA) and case (Summit
        // ships lowercase `cvttxdscrp`); an exact-case match silently dropped
        // every Summit parcel into _UNKNOWN.
        const want = plainName.toUpperCase();
        const key = Object.keys(rec).find(k => k.split('.').pop().toUpperCase() === want);
        return key !== undefined && rec[key] !== null ? rec[key] : '';
      };

      let city = '';
      // City field varies by county: tax-district (Summit/Franklin), LOC_AREA
      // (Montgomery), OWNADCITY (Hamilton), parcel_city/mail_city (Cuyahoga).
      // NOTE: Hamilton's CAGIS export carries no situs-city column at all, so
      // OWNADCITY (the OWNER's mailing city) is the only city available. Its
      // parcels are therefore bucketed by where the owner receives mail, not
      // where the property sits — absentee-owned Cincinnati parcels land under
      // the owner's out-of-state city. Fixing that needs a TAXDST code→
      // jurisdiction lookup from CAGIS.
      city = (getField('CVTTXDSCRP') || getField('LOC_AREA') || getField('MAILCITY') || getField('OWNADCITY') || getField('parcel_city') || getField('mail_city') || '').trim().toUpperCase().replace(/ CITY$| VILLAGE$| TOWNSHIP$/i, '');
      if (!city) city = '_UNKNOWN';
      const safeCity = city.replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, '_');

      if (!cityStreams[safeCity]) {
        cityStreams[safeCity] = fs.createWriteStream(
          path.join(cityDir, `OH_${safeCity}.jsonl`), { flags: append ? 'a' : 'w' });
        cityCounts[safeCity] = 0;
      }
      cityStreams[safeCity].write(line + '\n');
      cityCounts[safeCity]++;
      total++;
    } catch {}
  }

  for (const s of Object.values(cityStreams)) s.end();
  const sorted = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]);
  console.log(`  ${total.toLocaleString()} records, ${sorted.length} cities`);
  for (const [c, n] of sorted.slice(0, 10)) {
    console.log(`    ${c}: ${n.toLocaleString()}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN CLI
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    console.log('\nOhio County Recipes:');
    for (const [id, c] of Object.entries(COUNTIES)) {
      const status = c.status === 'ready' ? '✓' : '⟳';
      console.log(`  ${status} ${id.padEnd(15)} ${c.name.padEnd(35)} pop: ${(c.population/1000).toFixed(0)}K`);
    }
    return;
  }

  if (args[0] === '--county') {
    const target = args[1];
    if (target === 'all') {
      for (const [id, c] of Object.entries(COUNTIES)) {
        if (c.status === 'ready') await pullCounty(id);
      }
      // Re-index every county AFTER pulling them all — the index is what the
      // engine reads, and indexing per-county as we go would let each county
      // truncate the shared city files written by the previous one.
      await rebuildAllCityIndexes();
    } else if (COUNTIES[target]) {
      const count = await pullCounty(target);
      if (count > 0 && args.includes('--index')) {
        await buildCityIndex(target);
      }
    } else {
      console.log(`Unknown county: ${target}`);
    }
    return;
  }

  if (args[0] === '--index-all') {
    await rebuildAllCityIndexes();
    return;
  }

  if (args[0] === '--index') {
    await buildCityIndex(args[1] || 'franklin');
    return;
  }

  console.log(`
Ohio Property Data Pull

Usage:
  node pull-ohio.mjs --list                    Show county recipes
  node pull-ohio.mjs --county franklin         Pull one county
  node pull-ohio.mjs --county franklin --index Pull + build city index
  node pull-ohio.mjs --county all              Pull all ready counties
  node pull-ohio.mjs --index franklin          Build city index from existing data
  node pull-ohio.mjs --index-all               Rebuild ALL counties' city index (safe;
                                               counties share the city namespace)
  `);
}

main().catch(console.error);
