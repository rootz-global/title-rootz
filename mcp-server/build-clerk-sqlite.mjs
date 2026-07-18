#!/usr/bin/env node
// Build/update the Broward Clerk farming-signals.db from JSONL files
// This is the missing bridge between pull-broward-clerk.mjs (downloads JSONL)
// and fl-query.mjs (reads SQLite via lookupClerkSignals)
//
// Usage:
//   node build-clerk-sqlite.mjs                  # Incremental — add new JSONL files
//   node build-clerk-sqlite.mjs --rebuild        # Drop and rebuild from all JSONL files
//   node build-clerk-sqlite.mjs --stats          # Show DB stats
//
// Schema matches what fl-query.mjs expects:
//   signals table:  instrument_num, signal, category, description, doc_type,
//                   record_date, case_num, consideration, hash, parcel_id
//   parties table:  instrument_num, party_name, party_name_norm, party_type

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FARMING_DIR = path.join(__dirname, 'data', 'broward-clerk', 'farming');
const DB_PATH = path.join(__dirname, 'data', 'broward-clerk', 'farming-signals.db');
const TRACKER_PATH = path.join(__dirname, 'data', 'broward-clerk', 'loaded-files.json');

function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      instrument_num TEXT PRIMARY KEY,
      signal TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      doc_type TEXT NOT NULL,
      record_date TEXT,
      case_num TEXT,
      consideration REAL DEFAULT 0,
      hash TEXT,
      parcel_id TEXT,
      legal_desc TEXT,
      source TEXT DEFAULT 'broward-clerk-sftp',
      retrieved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument_num TEXT NOT NULL,
      party_name TEXT NOT NULL,
      party_name_norm TEXT NOT NULL,
      party_type TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_signals_signal ON signals(signal);
    CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(record_date);
    CREATE INDEX IF NOT EXISTS idx_signals_parcel ON signals(parcel_id);
    CREATE INDEX IF NOT EXISTS idx_parties_instrument ON parties(instrument_num);
    CREATE INDEX IF NOT EXISTS idx_parties_name_norm ON parties(party_name_norm);
    CREATE INDEX IF NOT EXISTS idx_parties_name_like ON parties(party_name_norm COLLATE NOCASE);
  `);

  return db;
}

function normalizeName(name) {
  return (name || '').replace(/[,.\s]+/g, ' ').trim().toUpperCase();
}

function loadJsonlFile(db, filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());

  const insertSignal = db.prepare(`
    INSERT OR IGNORE INTO signals
      (instrument_num, signal, category, description, doc_type, record_date,
       case_num, consideration, hash, parcel_id, legal_desc, source, retrieved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertParty = db.prepare(`
    INSERT INTO parties (instrument_num, party_name, party_name_norm, party_type)
    VALUES (?, ?, ?, ?)
  `);

  // Check which instrument_nums already exist to avoid duplicate parties
  const checkExists = db.prepare('SELECT 1 FROM signals WHERE instrument_num = ?');

  let signalsAdded = 0;
  let partiesAdded = 0;
  let skipped = 0;

  const insertAll = db.transaction(() => {
    for (const line of lines) {
      try {
        const r = JSON.parse(line);

        // Skip if already loaded
        if (checkExists.get(r.instrumentNum)) {
          skipped++;
          continue;
        }

        insertSignal.run(
          r.instrumentNum, r.signal, r.category, r.description, r.docType,
          r.recordDate, r.caseNum || null, r.consideration || 0,
          r.hash, r.parcelId || null, r.legalDesc || null,
          r.source || 'broward-clerk-sftp', r.retrievedAt || new Date().toISOString()
        );
        signalsAdded++;

        // Insert grantors (party_type = 'D' = direct/from)
        for (const name of (r.grantors || [])) {
          if (!name.trim()) continue;
          insertParty.run(r.instrumentNum, name.trim(), normalizeName(name), 'D');
          partiesAdded++;
        }

        // Insert grantees (party_type = 'R' = reverse/to)
        for (const name of (r.grantees || [])) {
          if (!name.trim()) continue;
          insertParty.run(r.instrumentNum, name.trim(), normalizeName(name), 'R');
          partiesAdded++;
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
  });

  insertAll();
  return { signalsAdded, partiesAdded, skipped, totalLines: lines.length };
}

function getLoadedFiles() {
  if (!fs.existsSync(TRACKER_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf-8')); } catch { return {}; }
}

function saveLoadedFiles(tracker) {
  fs.writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2));
}

function showStats(db) {
  const signalCount = db.prepare('SELECT COUNT(*) as c FROM signals').get().c;
  const partyCount = db.prepare('SELECT COUNT(*) as c FROM parties').get().c;
  const uniqueNames = db.prepare('SELECT COUNT(DISTINCT party_name_norm) as c FROM parties').get().c;

  console.log(`\n=== Farming Signals DB Stats ===`);
  console.log(`  Signals:      ${signalCount.toLocaleString()}`);
  console.log(`  Party records: ${partyCount.toLocaleString()}`);
  console.log(`  Unique names:  ${uniqueNames.toLocaleString()}`);
  console.log(`  DB path:       ${DB_PATH}`);

  const bySignal = db.prepare('SELECT signal, COUNT(*) as c FROM signals GROUP BY signal ORDER BY c DESC').all();
  console.log('\n  By signal type:');
  for (const row of bySignal) {
    // Docs whose type isn't in FARMING_DOC_TYPES land here with a null signal;
    // don't let a display line abort the build (cron reads the exit code).
    console.log(`    ${String(row.signal ?? '(unclassified)').padEnd(22)} ${row.c.toLocaleString().padStart(8)}`);
  }

  const byYear = db.prepare(`
    SELECT SUBSTR(record_date, -4) as year, COUNT(*) as c
    FROM signals WHERE record_date IS NOT NULL
    GROUP BY year ORDER BY year DESC LIMIT 10
  `).all();
  console.log('\n  By year (recent):');
  for (const row of byYear) {
    console.log(`    ${row.year}  ${row.c.toLocaleString().padStart(8)}`);
  }

  const withParcel = db.prepare("SELECT COUNT(*) as c FROM signals WHERE parcel_id IS NOT NULL AND parcel_id != ''").get().c;
  console.log(`\n  With parcel ID: ${withParcel.toLocaleString()} (${(withParcel/signalCount*100).toFixed(1)}%)`);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const statsOnly = args.includes('--stats');

if (!fs.existsSync(FARMING_DIR)) {
  console.log(`No farming JSONL data at ${FARMING_DIR}`);
  console.log('Run: node pull-broward-clerk.mjs --daily   or   --year 2025');
  process.exit(1);
}

// Stats only
if (statsOnly) {
  if (!fs.existsSync(DB_PATH)) {
    console.log('No DB yet. Run without --stats first.');
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true });
  showStats(db);
  db.close();
  process.exit(0);
}

console.log(`\n=== Building Farming Signals SQLite DB ===\n`);

if (rebuild && fs.existsSync(DB_PATH)) {
  console.log('  Removing old DB for rebuild...');
  fs.unlinkSync(DB_PATH);
  if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
  if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');
  if (fs.existsSync(TRACKER_PATH)) fs.unlinkSync(TRACKER_PATH);
}

const db = initDb(DB_PATH);
const tracker = rebuild ? {} : getLoadedFiles();
const jsonlFiles = fs.readdirSync(FARMING_DIR).filter(f => f.endsWith('.jsonl')).sort();

console.log(`  JSONL files found: ${jsonlFiles.length}`);
console.log(`  Already loaded:    ${Object.keys(tracker).length}`);

let totalSignals = 0;
let totalParties = 0;
let filesProcessed = 0;

for (const file of jsonlFiles) {
  const filePath = path.join(FARMING_DIR, file);
  const stat = fs.statSync(filePath);
  const fileKey = `${file}:${stat.size}:${stat.mtimeMs}`;

  // Skip if already loaded (same file, same size, same mtime)
  if (tracker[file] === fileKey) {
    continue;
  }

  const result = loadJsonlFile(db, filePath);
  console.log(`  ${file}: +${result.signalsAdded} signals, +${result.partiesAdded} parties (${result.skipped} dups)`);

  tracker[file] = fileKey;
  totalSignals += result.signalsAdded;
  totalParties += result.partiesAdded;
  filesProcessed++;
}

saveLoadedFiles(tracker);

if (filesProcessed === 0) {
  console.log('\n  No new files to load.');
} else {
  console.log(`\n  Loaded ${filesProcessed} files: +${totalSignals.toLocaleString()} signals, +${totalParties.toLocaleString()} parties`);
}

showStats(db);
db.close();

console.log('\n  Done. fl-query.mjs will auto-detect this DB on next request.');
