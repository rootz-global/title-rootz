#!/usr/bin/env node
/**
 * AI_CONTEXT: OH OGRIP statewide parcels puller (Tier-1 state-coverage build).
 *
 * Source: OGRIP Ohio Statewide Parcels (Public View), an Esri FeatureServer with
 * ~6.3M parcels across ALL 88 counties. This is BREADTH not full depth — it
 * carries situs address, land use, land area and (often blank) owner MAILING
 * address, but NO owner name and NO market value. The 5 existing OH counties
 * (Franklin/Hamilton/Cuyahoga/Montgomery/Summit) keep their richer per-county
 * CAMA; OGRIP fills the other 83 counties with address/parcel/land-use coverage
 * and a CAMADataSite drill-down link for owner/value.
 *
 * Output: city-indexed JSONL (data/ohio/cities/OH_CITY_OF_<CITY>.jsonl) that
 * src/query/oh-property.js reads via its `_src:'ohio-ogrip'` mapper branch. The
 * `County` field is carried through so records are NEVER mislabeled 'Franklin'
 * (same class of bug as the FL CO_NO provenance fix).
 *
 * Usage:
 *   node pull-oh-ogrip.mjs --county Clark            # one county
 *   node pull-oh-ogrip.mjs --all                     # every county not already deep
 *   node pull-oh-ogrip.mjs --county Clark --limit 200 --dry   # sample, no write
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OH_DATA_DIR || path.join(__dirname, 'data', 'ohio');
const CITIES_DIR = path.join(DATA_DIR, 'cities');

const LAYER = 'https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0';
const PAGE = 2000;
// Counties we already carry at full CAMA depth — OGRIP would be a downgrade, skip.
const DEEP_COUNTIES = new Set(['Franklin', 'Hamilton', 'Cuyahoga', 'Montgomery', 'Summit']);
const OUT_FIELDS = ['County', 'LocalParcelID', 'StateParcelID', 'StateLUC', 'SitusAddressAll',
  'MailAddressAll', 'MailCity', 'MailState', 'MailZip', 'LandArea', 'CurrentTo', 'CAMADataSite'].join(',');

async function fetchJSON(url, timeout = 30000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try { const r = await fetch(url, { signal: c.signal }); return await r.json(); }
  catch (e) { console.error(`  fetch error: ${e.message}`); return null; }
  finally { clearTimeout(t); }
}

async function listCounties() {
  const url = `${LAYER}/query?where=1%3D1&returnDistinctValues=true&outFields=County&returnGeometry=false&f=json`;
  const d = await fetchJSON(url);
  return (d?.features || []).map(f => f.attributes.County).filter(Boolean).sort();
}

// OGRIP SitusAddressAll delimits components with DOUBLE spaces:
//   "24  CENTER ST  SPRINGFIELD 45505" -> ["24","CENTER ST","SPRINGFIELD 45505"]
// The last chunk is "CITY ZIP"; everything before it is the street.
function parseSitus(s) {
  const raw = String(s || '').trim();
  if (!raw) return { street: '', city: '', zip: '' };
  const parts = raw.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : '';
  const m = last.match(/^(.*?)\s+(\d{5})(?:-\d{4})?$/);
  const city = (m ? m[1] : last).trim().toUpperCase();
  const zip = m ? m[2] : '';
  const street = parts.slice(0, -1).join(' ').replace(/\s+/g, ' ').trim();
  return { street, city, zip };
}

function safeCity(city) {
  return city.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, '_');
}

// Map an OGRIP feature to the JSONL record the OH engine's OGRIP branch reads.
function toRecord(a) {
  const { street, city, zip } = parseSitus(a.SitusAddressAll);
  if (!street || !city) return null;                 // skip attribute-less rows
  const luc = String(a.StateLUC || '');
  return {
    _src: 'ohio-ogrip',
    County: a.County || '',
    SITEADDRESS: street,
    CITY: city,
    ZIPCD: zip || (a.MailZip ? String(a.MailZip).slice(0, 5) : ''),
    PARCELID: a.LocalParcelID || a.StateParcelID || '',
    STATEPARCELID: a.StateParcelID || '',
    LUCCODE: luc.split(':')[0].trim(),
    LUCDESC: luc.includes(':') ? luc.split(':').slice(1).join(':').trim() : luc,
    LANDAREA_ACRES: Number(a.LandArea) || 0,
    MAILADD1: (a.MailAddressAll || '').trim(),
    MAILCITY: (a.MailCity || '').trim(),
    MAILSTATE: (a.MailState || '').trim(),
    MAILZIP: a.MailZip ? String(a.MailZip) : '',
    CAMADataSite: a.CAMADataSite || '',
    CurrentTo: a.CurrentTo || '',
  };
}

async function pullCounty(county, { limit = 0, dry = false } = {}) {
  console.log(`\n=== OGRIP: ${county} County ===`);
  const where = encodeURIComponent(`County='${county.replace(/'/g, "''")}'`);
  const cntUrl = `${LAYER}/query?where=${where}&returnCountOnly=true&f=json`;
  const total = (await fetchJSON(cntUrl))?.count || 0;
  console.log(`  ${total.toLocaleString()} parcels in OGRIP`);
  if (!total) return { county, records: 0, written: 0 };

  const byCity = new Map();   // CITY -> [records]
  let fetched = 0, kept = 0, offset = 0;
  const cap = limit > 0 ? limit : total;
  while (offset < cap) {
    const url = `${LAYER}/query?where=${where}&outFields=${OUT_FIELDS}&returnGeometry=false&resultOffset=${offset}&resultRecordCount=${PAGE}&f=json`;
    const d = await fetchJSON(url);
    const feats = d?.features || [];
    if (!feats.length) break;
    for (const f of feats) {
      fetched++;
      const rec = toRecord(f.attributes);
      if (!rec) continue;
      kept++;
      const key = rec.CITY || 'UNKNOWN';
      if (!byCity.has(key)) byCity.set(key, []);
      byCity.get(key).push(rec);
    }
    offset += feats.length;
    if (feats.length < PAGE) break;
    if (offset % 20000 === 0) console.log(`    …${offset.toLocaleString()} scanned, ${kept.toLocaleString()} kept`);
  }
  console.log(`  scanned ${fetched.toLocaleString()}, kept ${kept.toLocaleString()} (with situs), ${byCity.size} cities`);

  if (dry) {
    const sample = [...byCity.values()][0]?.[0];
    console.log('  DRY — sample record:', JSON.stringify(sample));
    return { county, records: kept, written: 0, cities: byCity.size };
  }

  if (!fs.existsSync(CITIES_DIR)) fs.mkdirSync(CITIES_DIR, { recursive: true });
  let written = 0;
  for (const [city, recs] of byCity) {
    const fp = path.join(CITIES_DIR, `OH_CITY_OF_${safeCity(city)}.jsonl`);
    // Append (a city can span counties); de-dupe not needed for distinct parcels.
    fs.appendFileSync(fp, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
    written += recs.length;
  }
  console.log(`  wrote ${written.toLocaleString()} records across ${byCity.size} city files`);
  return { county, records: kept, written, cities: byCity.size };
}

// ─── CLI ───
const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes('--dry');
const limit = parseInt(getArg('--limit') || '0') || 0;

if (args.includes('--all')) {
  const counties = (await listCounties()).filter(c => !DEEP_COUNTIES.has(c));
  console.log(`OGRIP --all: ${counties.length} counties (excluding ${[...DEEP_COUNTIES].join(', ')})`);
  const summary = [];
  for (const c of counties) summary.push(await pullCounty(c, { limit, dry }));
  const totW = summary.reduce((s, r) => s + r.written, 0);
  console.log(`\nDONE. ${summary.length} counties, ${totW.toLocaleString()} records written.`);
} else {
  const county = getArg('--county');
  if (!county) { console.log('Usage: --county <Name> [--limit N] [--dry]  |  --all'); process.exit(1); }
  await pullCounty(county, { limit, dry });
}
