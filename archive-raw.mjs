#!/usr/bin/env node
// Retain the RAW source pull, dated, so a property's record can be read as it stood
// on a past date — not just as it stands now.
//
// WHY THIS EXISTS. Every parcel pipeline here was destroy-and-replace: the FL
// statewide cron literally `rm -f`s the roll before AND after rebuilding, the OH
// weekly rebuild deletes every city file, OGRIP replaces by county. `parcels.db` is
// one row per parcel with no as_of, no valid_from, no version, no history table — so
// if an owner changed or a homestead exemption dropped between two cycles, nothing
// here could tell you, or even tell you that it happened. Counties do not publish
// back-issues, so each overwrite was permanent: the July 2026 Florida roll is gone.
//
// That runs against the stated thesis — DESIGN-origin-land-records: a property
// "accumulates records over time"; VISION: "accumulates so much verified data over
// time that its record becomes impossible to fake." Origin is copyable; years of
// accrued history are not.
//
// THE PATTERN IS BROWARD'S, because it already works in this estate: keep the dated
// raw the county actually published, and treat every derived artifact (city index,
// parcels.db) as disposable and rebuildable. We keep the source of record, not our
// interpretation of it.
//
// Two departures from Broward, both to make it affordable and more useful:
//   - zstd, measured at 15.7x on real parcel JSONL, so a year of OH weeklies is
//     ~17GB rather than ~270GB.
//   - a manifest carrying the sha256 of every capture. That hash IS the change
//     record: "did Franklin change between Aug 24 and Aug 31?" is a manifest lookup,
//     no diff engine and no decompression. Identical content is recorded as an
//     observation but stored only once.
//
// Usage:
//   node archive-raw.mjs --source oh-franklin --file data/ohio/franklin-parcels.jsonl
//   node archive-raw.mjs --list [--source oh-franklin]
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.TITLE_DATA_DIR || path.join(__dirname, 'data');
const ARCHIVE = path.join(DATA, 'archive');
const MANIFEST = path.join(ARCHIVE, 'MANIFEST.jsonl');

const readManifest = () => {
  try {
    return fs.readFileSync(MANIFEST, 'utf8').split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

function sha256(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', c => h.update(c));
    s.on('error', rej);
    s.on('end', () => res(h.digest('hex')));
  });
}

export async function archiveRaw(source, file, dateArg) {
  if (!fs.existsSync(file)) { console.log(`  archive: no such file, skipping — ${file}`); return null; }
  const stat = fs.statSync(file);
  // Date the capture by the file's OWN mtime, not by "now". The pull may have
  // finished hours before this runs, and the date must describe the data.
  const date = dateArg || new Date(stat.mtimeMs).toISOString().slice(0, 10);
  const hash = await sha256(file);
  const man = readManifest();

  const sameContent = man.find(m => m.source === source && m.sha256 === hash);
  const already = man.find(m => m.source === source && m.date === date);
  if (already && already.sha256 === hash) { console.log(`  archive: ${source} ${date} already captured (unchanged)`); return already; }

  const entry = { source, date, capturedAt: new Date().toISOString(), bytes: stat.size, sha256: hash, srcPath: path.relative(DATA, file) };

  if (sameContent) {
    // Byte-identical to a capture we already hold. Record that we OBSERVED it on this
    // date — that is a real fact about the source — but do not store a second copy.
    entry.unchangedSince = sameContent.date;
    entry.storedAs = sameContent.storedAs;
    console.log(`  archive: ${source} ${date} — IDENTICAL to ${sameContent.date}, observation recorded, no new copy`);
  } else {
    const outDir = path.join(ARCHIVE, source);
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(file);
    const out = path.join(outDir, `${base}.${date}.zst`);
    const t0 = Date.now();
    // -6/-T2: the box has 2 cores and this runs inside a cron window; -10 buys ~1x
    // more ratio for a lot more CPU. nice/ionice so a capture never costs a request.
    const r = spawnSync('nice', ['-n', '19', 'ionice', '-c3', 'zstd', '-6', '-T2', '-q', '-f', '-o', out, file], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`  archive: zstd FAILED for ${file} (status ${r.status}) — raw NOT deleted`); return null; }
    entry.storedAs = path.relative(DATA, out);
    entry.storedBytes = fs.statSync(out).size;
    entry.ratio = +(stat.size / entry.storedBytes).toFixed(1);
    console.log(`  archive: ${source} ${date} — ${(stat.size / 1073741824).toFixed(2)}GB -> ${(entry.storedBytes / 1048576).toFixed(0)}MB (${entry.ratio}x) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  fs.mkdirSync(ARCHIVE, { recursive: true });
  fs.appendFileSync(MANIFEST, JSON.stringify(entry) + '\n');
  return entry;
}

// Sweep: archive every raw source we hold, deriving the source name from its path.
// Self-maintaining on purpose — a new state's puller gets accrual without anyone
// remembering to wire it up, which is exactly the step that never happens.
// Excludes DERIVED artifacts (the city indexes are rebuilt from these, and there are
// ~95k of them), the archive itself, and anything small enough not to be a source roll.
const SWEEP_MIN_BYTES = 50 * 1024 * 1024;
const SWEEP_SKIP_DIRS = new Set(['archive', 'cities', 'logs', 'node_modules']);
function sweepTargets(dir = DATA, rel = []) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SWEEP_SKIP_DIRS.has(e.name)) continue;
      out.push(...sweepTargets(path.join(dir, e.name), [...rel, e.name]));
    } else if (e.name.endsWith('.jsonl')) {
      const fp = path.join(dir, e.name);
      let st; try { st = fs.statSync(fp); } catch { continue }
      if (st.size < SWEEP_MIN_BYTES) continue;
      const source = [...rel, e.name.replace(/\.jsonl$/, '')].join('-');
      out.push({ source, file: fp, bytes: st.size });
    }
  }
  return out;
}

// Importable as a library (pull-ohio.mjs calls archiveRaw after a successful pull)
// AND runnable as a CLI. Without this guard, importing it would run the CLI.
const RUN_AS_CLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
if (RUN_AS_CLI && args.includes('--sweep')) {
  const targets = sweepTargets();
  console.log(`sweep: ${targets.length} raw source(s), ${(targets.reduce((n, t) => n + t.bytes, 0) / 1073741824).toFixed(1)}GB raw`);
  for (const t of targets) await archiveRaw(t.source, t.file);
  process.exit(0);
}

if (RUN_AS_CLI && args.includes('--list')) {
  const src = args[args.indexOf('--source') + 1];
  const man = readManifest().filter(m => !args.includes('--source') || m.source === src);
  const bySrc = {};
  for (const m of man) (bySrc[m.source] ||= []).push(m);
  for (const [s, rows] of Object.entries(bySrc)) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const stored = rows.filter(r => !r.unchangedSince).reduce((n, r) => n + (r.storedBytes || 0), 0);
    console.log(`\n${s} — ${rows.length} capture(s), ${rows[0].date}..${rows.at(-1).date}, ${(stored / 1048576).toFixed(0)}MB stored`);
    let prev = null;
    for (const r of rows) {
      const mark = prev === null ? 'FIRST' : (r.sha256 === prev ? 'same ' : 'CHANGED');
      console.log(`  ${r.date}  ${mark}  ${r.sha256.slice(0, 12)}  ${(r.bytes / 1073741824).toFixed(2)}GB raw`);
      prev = r.sha256;
    }
  }
  process.exit(0);
}

// Consume option VALUES explicitly — otherwise `--date 2026-08-31` leaves the date
// looking like a positional filename, and the run reports a phantom missing file.
const consumed = new Set();
for (const opt of ['--source', '--date']) {
  const i = args.indexOf(opt);
  if (i >= 0) { consumed.add(i); consumed.add(i + 1); }
}
if (RUN_AS_CLI) {
const source = args.indexOf('--source') >= 0 ? args[args.indexOf('--source') + 1] : null;
const dateArg = args.indexOf('--date') >= 0 ? args[args.indexOf('--date') + 1] : null;
const files = args.filter((a, i) => !consumed.has(i) && !a.startsWith('--'));
if (!source || !files.length) {
  console.log('Usage: node archive-raw.mjs --source <name> <file...> [--date YYYY-MM-DD]\n       node archive-raw.mjs --list [--source <name>]');
  process.exit(1);
}
for (const f of files) await archiveRaw(source, path.isAbsolute(f) ? f : path.join(__dirname, f), dateArg);
}
