#!/usr/bin/env node
// Chatham County, NC — full county harvest (Broward model: parcels + sales +
// improvements + environmental + flood, all from the county's own open ArcGIS).
//
// Chatham publishes a rich, OPEN, unauthenticated ArcGIS stack at
//   https://gisservices.chathamcountync.gov/opendataagol/rest/services
// far deeper than the statewide NC OneMap layer: real sale prices, FMV+assessed
// values, deed book/page, water/septic type, AG deferral, tax-status alerts.
//
// Layers pulled (join key = parcel_number / parcel_Number):
//   Cadastral/Chatham_CamaParcels        49,081  base tax parcel (the spine)
//   Cadastral/Chatham_PropertySales      25,052  real sale prices + flags
//   Cadastral/Chatham_PropertyImprovements 57,340 structures (beds/baths/yr)
//   EnvironmentalHealth/Chatham_AugerBoringSites 42,942 dated septic evals
//
// Flood is intentionally NOT bulk-pulled here: flood zone is resolved per
// property at query time from FEMA's nationwide NFHL API (see the shared
// overlay used by the OH/FL engines), so a bulk Chatham flood polygon pull
// would duplicate that and add a spatial-join dependency we don't need.
//
// Usage:  node pull-chatham.mjs              # pull everything
//         node pull-chatham.mjs --layer cama # one layer

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'nc', 'chatham');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ROOT = 'https://gisservices.chathamcountync.gov/opendataagol/rest/services';

const LAYERS = {
  cama:         { url: `${ROOT}/Cadastral/Chatham_CamaParcels/MapServer/0`,            file: 'cama-parcels.jsonl' },
  sales:        { url: `${ROOT}/Cadastral/Chatham_PropertySales/MapServer/0`,          file: 'property-sales.jsonl' },
  improvements: { url: `${ROOT}/Cadastral/Chatham_PropertyImprovements/MapServer/0`,   file: 'property-improvements.jsonl' },
  septic:       { url: `${ROOT}/EnvironmentalHealth/Chatham_AugerBoringSites/MapServer/0`, file: 'auger-boring.jsonl' },
};
const PAGE = 2000;

async function pullLayer(key) {
  const L = LAYERS[key];
  const outFile = path.join(DATA_DIR, L.file);
  const stream = fs.createWriteStream(outFile);
  let offset = 0, total = 0, retries = 0;
  const start = Date.now();
  console.log(`\nPulling ${key} <- ${L.url}`);

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'false',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: 'json'
    });
    try {
      const resp = await fetch(`${L.url}/query?${params}`, { signal: AbortSignal.timeout(90000) });
      const data = await resp.json();
      if (data.error) {
        if (++retries > 5) { console.log(`  API error, stop: ${data.error.message}`); break; }
        await new Promise(r => setTimeout(r, 4000)); continue;
      }
      const feats = data.features || [];
      if (feats.length === 0) break;
      retries = 0;
      for (const f of feats) stream.write(JSON.stringify(f.attributes) + '\n');
      total += feats.length;
      offset += feats.length;
      process.stdout.write(`\r  ${total.toLocaleString()} records (offset ${offset})   `);
      if (!data.exceededTransferLimit && feats.length < PAGE) break;
      await new Promise(r => setTimeout(r, 120));
    } catch (e) {
      if (++retries > 5) { console.log(`\n  Max retries: ${e.message}`); break; }
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  stream.end();
  const mb = fs.existsSync(outFile) ? (fs.statSync(outFile).size / 1048576).toFixed(1) : '0';
  console.log(`\n  Done ${key}: ${total.toLocaleString()} records (${mb}MB) in ${((Date.now() - start) / 1000).toFixed(0)}s`);
  return total;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args[0] === '--layer' ? args[1] : null;
  const keys = only ? [only] : Object.keys(LAYERS);
  const summary = {};
  for (const k of keys) {
    if (!LAYERS[k]) { console.log(`Unknown layer: ${k}`); continue; }
    summary[k] = await pullLayer(k);
  }
  fs.writeFileSync(path.join(DATA_DIR, '_pull-summary.json'),
    JSON.stringify({ pulledAt: new Date().toISOString(), counts: summary }, null, 2));
  console.log('\nSummary:', JSON.stringify(summary));
}

main().catch(console.error);
