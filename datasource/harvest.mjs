/**
 * harvest() for the realestate source.
 *
 * It reads title-rootz's EXISTING government inputs — the FL DOR city JSONL that
 * already feed the parcel engine, and the Broward clerk sqlite the farming
 * engine already builds — and emits them into the substrate store. Nothing new
 * is scraped; this is the same corpus, re-presented through the signed catalog.
 *
 * The store the substrate builds from this is intended to replace parcels.db as
 * the serving index over time (a later PR), so this is a materialization step on
 * the way to fewer copies, not a new parallel one.
 *
 * Each dataset is guarded independently: a missing Broward db must not stop the
 * parcels from loading, and vice-versa. What was read and what was skipped is
 * logged, so a source that quietly loaded nothing is visible in status rather
 * than looking like a source with no news.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import Database from 'better-sqlite3';
import { DATA_DIR, CITIES_DIR } from '../src/lib/config.js';

// Recorded-instrument types that belong on a PUBLIC property record. Mirrors
// ENCUMBRANCE_SIGNALS in src/query/fl-passport.js so the public/private line —
// which soft signals (death, probate) are farming-only and never published — is
// drawn in one place's worth of judgement, not two.
const PUBLIC_INSTRUMENTS = new Set(['lis_pendens', 'lien', 'final_judgment', 'mortgage', 'satisfaction']);

/** FL parcels of record, from the per-city FL DOR NAL JSONL. */
async function harvestParcels({ emit, log, config }) {
  const dir = config.citiesDir || CITIES_DIR;
  if (!fs.existsSync(dir)) {
    log(`parcels: no cities directory at ${dir} — skipping`);
    return;
  }
  const only = Array.isArray(config.cities) && config.cities.length
    ? new Set(config.cities.map((c) => c.toUpperCase()))
    : null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && !f.startsWith('_'))
    .filter((f) => !only || only.has(f.replace(/\.jsonl$/i, '').toUpperCase()))
    .sort();

  const limit = config.limit ? parseInt(config.limit, 10) : 0;
  let count = 0;
  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, file)),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      emit('parcels', obj);
      count++;
      if (limit && count >= limit) break;
    }
    rl.close();
    if (count && count % 100000 === 0) log(`parcels: ${count.toLocaleString()} so far`);
    if (limit && count >= limit) break;
  }
  log(`parcels: emitted ${count.toLocaleString()} from ${files.length} city file(s)`);
}

/** Broward recorded instruments that belong on a public property record. */
function harvestEncumbrances({ emit, log, config }) {
  const dbPath = config.clerkDb || path.join(DATA_DIR, 'broward-clerk', 'farming-signals.db');
  if (!fs.existsSync(dbPath)) {
    log(`encumbrances: no clerk db at ${dbPath} — skipping`);
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const placeholders = [...PUBLIC_INSTRUMENTS].map(() => '?').join(', ');
    const signals = db
      .prepare(`SELECT * FROM signals WHERE signal IN (${placeholders})`)
      .all(...PUBLIC_INSTRUMENTS);
    const partiesFor = db.prepare(
      'SELECT party_name, party_type FROM parties WHERE instrument_num = ?'
    );
    let count = 0;
    for (const s of signals) {
      const parties = partiesFor.all(s.instrument_num);
      emit('encumbrances', { ...s, parties });
      count++;
    }
    log(`encumbrances: emitted ${count.toLocaleString()} public instruments`);
  } finally {
    db.close();
  }
}

export async function harvest({ emit, log, config = {} }) {
  await harvestParcels({ emit, log, config });
  try {
    harvestEncumbrances({ emit, log, config });
  } catch (err) {
    // A clerk-db failure should not lose the parcels we already emitted.
    log(`encumbrances: failed — ${err.message}`);
  }
}
