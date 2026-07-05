/**
 * AI_CONTEXT: Build a per-state SQLite parcel index from the per-county/city JSONL.
 *
 * WHY (Jun 20 2026): the query engines grep/scan large JSONL files per request
 * (Miami = 72MB). That's slow (~3s farm), cold-start sensitive, and doesn't scale
 * as states are added. This builds ONE lean, indexed SQLite DB per state so both
 * address lookup and farm filtering are sub-second and index-backed.
 *
 * ARCHITECTURE (deliberate, for growth):
 *   - One DB per state: data/<state>/parcels.db  → isolated rebuilds, parallelizable.
 *   - COLUMNAR, no raw JSON: a normalized column set, NOT the raw record. This is
 *     smaller than the JSONL (no repeated keys) so total disk stays bounded as we
 *     add states. The query layer rebuilds the exact object shape each engine expects
 *     from these columns (the same mapping the old grep path did).
 *   - Farm signals are PRECOMPUTED into indexed columns (absentee/out_of_state/
 *     corporate/no_homestead/vacant/residential + base_score) so farm = WHERE + ORDER.
 *   - Atomic: build to parcels.db.tmp, swap on success → never serve a half-built DB.
 *
 * Run from the title-rootz-v2 dir (so better-sqlite3 + ./src/lib/config.js resolve):
 *   cd /var/www/title-rootz-v2 && node build-parcels-db.mjs --state fl [--limit N]
 *
 * Add a state: write an extractor + register it in STATES. See reference_title_data_freshness_discipline.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createRequire } from 'module';
import { DATA_DIR } from './src/lib/config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const COLUMNS = [
  'parcel_id', 'co_no', 'county', 'city', 'situs_addr', 'address_norm', 'situs_zip',
  'owner1', 'owner2', 'mail_addr', 'mail_city', 'mail_state', 'mail_zip',
  'land_use', 'year_built', 'living_area', 'bldg_count', 'unit_count', 'lot_sqft',
  'land_val', 'total_val', 'jv_hmstd', 'av_hmstd',
  'sale1_price', 'sale1_year', 'sale1_mo', 'sale1_book', 'sale1_page',
  'sale2_price', 'sale2_year', 'sale2_mo', 'sale2_book', 'sale2_page',
  'residential', 'absentee', 'out_of_state', 'corporate', 'vacant', 'base_score',
];

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, ' ').trim();
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

// ── Florida extractor (Florida_Statewide_Cadastral fields) ──────────
const FL_RESIDENTIAL = new Set(['000', '001', '002', '003', '004', '005', '006', '007', '008', '009']);
const FL_CORP = ['LLC', 'CORP', 'INC ', 'INC.', 'HOLDINGS', 'TRUST', 'ESTATE', 'BANK'];

function flExtract(p) {
  const phy = norm(p.PHY_ADDR1);
  if (!phy) return null;                       // unaddressable — not lookup/farm useful
  const ownAddr = norm(p.OWN_ADDR1);
  const ownState = String(p.OWN_STATE || '').trim().toUpperCase();
  const name = String(p.OWN_NAME || '').toUpperCase();
  const dor = String(p.DOR_UC || '').trim();
  const jv = int(p.JV), sp = int(p.SALE_PRC1), avh = int(p.AV_HMSTD);

  const residential = FL_RESIDENTIAL.has(dor) ? 1 : 0;
  const absentee = (ownAddr && phy && ownAddr !== phy) ? 1 : 0;
  const out_of_state = (ownState && ownState !== 'FL' && ownState !== 'FLORIDA') ? 1 : 0;
  const corporate = FL_CORP.some(kw => name.includes(kw)) ? 1 : 0;
  const no_homestead = avh === 0 ? 1 : 0;
  const vacant = (dor === '000' || int(p.TOT_LVG_AR) === 0) ? 1 : 0;

  // base_score = the parcel-only portion of the farm score (clerk signals are joined
  // at query time). Mirrors fl-farming.js so ordering matches.
  let base_score = 0;
  if (absentee && out_of_state) base_score += 12;
  else if (absentee) base_score += 10;
  if (corporate) base_score += 8;
  if (no_homestead) base_score += 5;
  if (jv > 0 && sp > 1000 && jv > sp * 2) base_score += 6;

  return {
    parcel_id: p.PARCEL_ID || p.PARCELNO || '', co_no: int(p.CO_NO), county: '',
    city: String(p.PHY_CITY || '').toUpperCase().trim(), situs_addr: p.PHY_ADDR1 || '',
    address_norm: phy, situs_zip: p.PHY_ZIPCD ? String(p.PHY_ZIPCD) : '',
    owner1: p.OWN_NAME || '', owner2: p.FIDU_NAME || '',
    mail_addr: p.OWN_ADDR1 || '', mail_city: p.OWN_CITY || '',
    mail_state: p.OWN_STATE || '', mail_zip: p.OWN_ZIPCD ? String(p.OWN_ZIPCD) : '',
    land_use: dor, year_built: int(p.EFF_YR_BLT) || int(p.ACT_YR_BLT),
    living_area: int(p.TOT_LVG_AR), bldg_count: int(p.NO_BULDNG), unit_count: int(p.NO_RES_UNT),
    lot_sqft: int(p.LND_SQFOOT), land_val: int(p.LND_VAL), total_val: jv,
    jv_hmstd: int(p.JV_HMSTD), av_hmstd: avh,
    sale1_price: sp, sale1_year: int(p.SALE_YR1), sale1_mo: int(p.SALE_MO1),
    sale1_book: p.OR_BOOK1 ? String(p.OR_BOOK1) : '', sale1_page: p.OR_PAGE1 ? String(p.OR_PAGE1) : '',
    sale2_price: int(p.SALE_PRC2), sale2_year: int(p.SALE_YR2), sale2_mo: int(p.SALE_MO2),
    sale2_book: p.OR_BOOK2 ? String(p.OR_BOOK2) : '', sale2_page: p.OR_PAGE2 ? String(p.OR_PAGE2) : '',
    residential, absentee, out_of_state, corporate, vacant, base_score,
  };
}

function listJsonl(rel) {
  const dir = path.join(DATA_DIR, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
}

const STATES = {
  fl: { db: 'florida/parcels.db', sources: () => listJsonl('florida/cities'), extract: flExtract },
};

// ── Build ───────────────────────────────────────────────────────────
async function build(stateKey, limit) {
  const st = STATES[stateKey];
  if (!st) { console.error(`Unknown state: ${stateKey}. Known: ${Object.keys(STATES).join(', ')}`); process.exit(1); }

  const files = st.sources();
  if (!files.length) { console.error(`No source JSONL for ${stateKey}`); process.exit(1); }

  const dbPath = path.join(DATA_DIR, st.db);
  const tmpPath = dbPath + '.tmp';
  try { fs.unlinkSync(tmpPath); } catch {}
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(tmpPath);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`CREATE TABLE parcels (id INTEGER PRIMARY KEY, ${COLUMNS.map(c =>
    (['parcel_id', 'county', 'city', 'situs_addr', 'address_norm', 'situs_zip', 'owner1', 'owner2',
      'mail_addr', 'mail_city', 'mail_state', 'mail_zip', 'land_use',
      'sale1_book', 'sale1_page', 'sale2_book', 'sale2_page'].includes(c)) ? `${c} TEXT` : `${c} INTEGER`
  ).join(', ')})`);

  const insert = db.prepare(`INSERT INTO parcels (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(c => '@' + c).join(', ')})`);
  const insertMany = db.transaction(rows => { for (const r of rows) insert.run(r); });

  let total = 0, skipped = 0, batch = [];
  const t0 = Date.now();
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { skipped++; continue; }
      const row = st.extract(obj);
      if (!row) { skipped++; continue; }
      batch.push(row);
      if (batch.length >= 10000) { insertMany(batch); total += batch.length; batch = []; }
      if (limit && total >= limit) break;
    }
    rl.close();
    if (limit && total >= limit) break;
  }
  if (batch.length) { insertMany(batch); total += batch.length; }

  console.log(`Inserted ${total.toLocaleString()} rows (${skipped.toLocaleString()} skipped) in ${((Date.now() - t0) / 1000).toFixed(1)}s — indexing…`);
  db.exec(`CREATE INDEX idx_city_addr ON parcels(city, address_norm)`);
  db.exec(`CREATE INDEX idx_farm ON parcels(city, residential, base_score DESC)`);
  db.exec(`CREATE INDEX idx_addr ON parcels(address_norm)`);
  db.pragma('optimize');
  db.close();

  fs.renameSync(tmpPath, dbPath);                // atomic swap
  const mb = (fs.statSync(dbPath).size / 1048576).toFixed(0);
  console.log(`Built ${dbPath} — ${total.toLocaleString()} parcels, ${mb}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s total.`);
}

const args = process.argv.slice(2);
const stateKey = (args[args.indexOf('--state') + 1] || '').toLowerCase();
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? parseInt(args[limIdx + 1], 10) : 0;
if (!stateKey || args.indexOf('--state') < 0) { console.error('Usage: node build-parcels-db.mjs --state <fl> [--limit N]'); process.exit(1); }
await build(stateKey, limit);
