/**
 * AI_CONTEXT: Shared read-only accessor for the per-state SQLite parcel indexes
 * built by build-parcels-db.mjs (data/<state>/parcels.db).
 *
 * Returns a cached better-sqlite3 handle per state, and AUTO-REOPENS when the DB
 * file is rebuilt (mtime change) so the monthly rebuild is picked up without a
 * restart. Returns null if the DB doesn't exist yet — callers MUST fall back to
 * their previous path (grep/scan) so the service works before/without the index.
 *
 * Dependencies: better-sqlite3 (in title-rootz-v2/node_modules), ./config.js
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { DATA_DIR } from './config.js';

const require = createRequire(import.meta.url);
let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }

const handles = new Map();   // state -> { db, mtime }

/** @returns {import('better-sqlite3').Database|null} readonly handle, or null if unavailable */
export function getParcelDb(state) {
  if (!Database) return null;
  const dbPath = path.join(DATA_DIR, state, 'parcels.db');
  let stat;
  try { stat = fs.statSync(dbPath); } catch { return null; }   // no DB → caller falls back

  const cached = handles.get(state);
  if (cached && cached.mtime === stat.mtimeMs) return cached.db;

  try { cached?.db.close(); } catch {}                          // DB rebuilt → reopen fresh
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = true');
    handles.set(state, { db, mtime: stat.mtimeMs });
    return db;
  } catch (e) {
    console.error(`parcel-db: failed to open ${dbPath}: ${e.message}`);
    return null;
  }
}

/** Normalize an address the same way the index stored address_norm. */
export function normAddr(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, ' ').trim();
}
