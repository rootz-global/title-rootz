#!/usr/bin/env node
// Pull North Carolina parcel data — NC OneMap statewide standardized layer.
// NC publishes ONE aggregated layer for all 100 counties with standardized
// attributes (owner, mailing addr, appraised value, acreage). We pull per county
// into data/nc/onemap/<county>.jsonl. Chatham keeps its richer county-CAMA build
// (data/nc/chatham/); OneMap is the broad statewide layer for everywhere else.
//
// Source: NC OneMap NC1Map_Parcels FeatureServer, layer 1 (open; 5.9M parcels)
//
// Usage:
//   node pull-nc.mjs --county Wake          # one county
//   node pull-nc.mjs --all                  # every NC county (resumable; skips done)
//   node pull-nc.mjs --all --skip Chatham   # all except Chatham (uses county CAMA)
//   node pull-nc.mjs --list                 # list counties + parcel counts

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'data', 'nc', 'onemap');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const LAYER = 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1';
const PAGE = 5000;
const OUT_FIELDS = [
  'parno', 'altparno', 'ownname', 'ownname2',
  'mailadd', 'mcity', 'mstate', 'mzip',
  'siteadd', 'scity', 'szip',
  'landval', 'improvval', 'parval',
  'gisacres', 'saledate', 'saledatetx', 'structyear',
  'cntyname', 'cntyfips'
].join(',');

async function fetchJSON(url, timeout = 90000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return r.json();
}

// NC's 100 counties (OneMap cntyname casing). Hardcoded — the distinct-values
// query times out on the 5.9M-row layer.
const NC_COUNTIES = ['Alamance','Alexander','Alleghany','Anson','Ashe','Avery','Beaufort','Bertie','Bladen','Brunswick','Buncombe','Burke','Cabarrus','Caldwell','Camden','Carteret','Caswell','Catawba','Chatham','Cherokee','Chowan','Clay','Cleveland','Columbus','Craven','Cumberland','Currituck','Dare','Davidson','Davie','Duplin','Durham','Edgecombe','Forsyth','Franklin','Gaston','Gates','Graham','Granville','Greene','Guilford','Halifax','Harnett','Haywood','Henderson','Hertford','Hoke','Hyde','Iredell','Jackson','Johnston','Jones','Lee','Lenoir','Lincoln','Macon','Madison','Martin','McDowell','Mecklenburg','Mitchell','Montgomery','Moore','Nash','New Hanover','Northampton','Onslow','Orange','Pamlico','Pasquotank','Pender','Perquimans','Person','Pitt','Polk','Randolph','Richmond','Robeson','Rockingham','Rowan','Rutherford','Sampson','Scotland','Stanly','Stokes','Surry','Swain','Transylvania','Tyrrell','Union','Vance','Wake','Warren','Washington','Watauga','Wayne','Wilkes','Wilson','Yadkin','Yancey'];
async function listCounties() { return NC_COUNTIES; }

async function pullCounty(county) {
  const outFile = path.join(OUT_DIR, `${county.toLowerCase().replace(/[^a-z0-9]/g, '')}.jsonl`);
  const stream = fs.createWriteStream(outFile);
  let offset = 0, total = 0, retries = 0;
  const start = Date.now();
  while (true) {
    const params = new URLSearchParams({
      where: `cntyname='${county}'`, outFields: OUT_FIELDS, returnGeometry: 'false',
      orderByFields: 'objectid', resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'json'
    });
    try {
      const data = await fetchJSON(`${LAYER}/query?${params}`);
      if (data.error) { if (++retries > 5) break; await new Promise(r => setTimeout(r, 4000)); continue; }
      const feats = data.features || [];
      if (feats.length === 0) break;
      retries = 0;
      for (const f of feats) stream.write(JSON.stringify(f.attributes) + '\n');
      total += feats.length; offset += feats.length;
      if (!data.exceededTransferLimit && feats.length < PAGE) break;
      await new Promise(r => setTimeout(r, 120));
    } catch (e) { if (++retries > 5) break; await new Promise(r => setTimeout(r, 4000)); }
  }
  stream.end();
  const mb = fs.existsSync(outFile) ? (fs.statSync(outFile).size / 1048576).toFixed(1) : '0';
  console.log(`  ${county.padEnd(16)} ${total.toLocaleString().padStart(9)} parcels (${mb}MB, ${((Date.now() - start) / 1000).toFixed(0)}s)`);
  return total;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--county' && args[1]) { await pullCounty(args[1]); return; }

  if (args[0] === '--list') {
    const cs = await listCounties();
    console.log(`${cs.length} NC counties:\n  ${cs.join(', ')}`);
    return;
  }

  if (args[0] === '--all') {
    const skip = new Set((args.includes('--skip') ? [args[args.indexOf('--skip') + 1]] : ['Chatham']).map(s => s.toLowerCase()));
    const counties = await listCounties();
    console.log(`NC statewide pull — ${counties.length} counties (skipping: ${[...skip].join(', ')})`);
    let grand = 0, done = 0;
    for (const c of counties) {
      const fn = path.join(OUT_DIR, `${c.toLowerCase().replace(/[^a-z0-9]/g, '')}.jsonl`);
      if (skip.has(c.toLowerCase())) { console.log(`  ${c.padEnd(16)} SKIP`); continue; }
      // resumable: skip counties already pulled (non-empty file) unless --force
      if (!args.includes('--force') && fs.existsSync(fn) && fs.statSync(fn).size > 100) { console.log(`  ${c.padEnd(16)} already pulled`); done++; continue; }
      grand += await pullCounty(c);
      done++;
    }
    console.log(`\nDONE — ${done} counties, ${grand.toLocaleString()} new parcels -> ${OUT_DIR}`);
    return;
  }

  console.log(`Usage: node pull-nc.mjs [--county <Name> | --all [--skip <Name>] | --list]`);
}
main().catch(console.error);
