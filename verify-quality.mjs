#!/usr/bin/env node
/**
 * AI_CONTEXT: Data QUALITY invariants for title.rootz.global (commercial-readiness B3).
 *
 * Complements verify-data.mjs (which checks the live API). This checks the data
 * FILES for structural defects, SCHEMA-AGNOSTICALLY — because per-county field
 * names vary (Franklin PARCELID vs Montgomery WEB_CAMA vs Hamilton CAGIS vs OGRIP),
 * so any field-name-based invariant false-positives (a naive scan misread Kettering
 * as 100% blank). We only assert things true of EVERY record regardless of schema:
 *   - every line parses to a non-empty JSON object   (parse integrity, no blank rows)
 *   - exact-duplicate-line ratio is below threshold   (caught OH_HARRISON's 195 dupes)
 *   - file is non-empty
 *
 * Runs on the box against the shared data dir. Sampled (curated representative files)
 * so it's fast; extend SAMPLE as coverage grows.
 *
 * Usage:
 *   node verify-quality.mjs                     # curated sample
 *   node verify-quality.mjs path1.jsonl path2   # explicit files
 *   node verify-quality.mjs --self-test         # seed a dup+blank temp file, must flag
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const DATA = process.env.OH_DATA_DIR ? path.dirname(process.env.OH_DATA_DIR)
  : fs.existsSync('/var/www/title-rootz-v2/data') ? '/var/www/title-rootz-v2/data'
  : path.join(process.cwd(), 'data');

const DUP_PCT = 2.0;   // flag if >2% of lines are exact duplicates

// Curated representative files (relative to DATA). Extend as coverage grows.
const SAMPLE = [
  'ohio/cities/OH_CITY_OF_COLUMBUS.jsonl',
  'ohio/cities/OH_HARRISON.jsonl',
  'ohio/cities/OH_KETTERING.jsonl',
  'florida/cities/HOLLYWOOD.jsonl',
  'florida/cities/OCALA.jsonl',
];

async function checkFile(fp) {
  const label = fp.replace(DATA + '/', '');
  if (!fs.existsSync(fp)) return { label, pass: false, detail: 'MISSING' };
  let records = 0, parseFail = 0, emptyObj = 0, dupes = 0;
  const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    records++;
    // exact-dup detection via a cheap hash of the line
    if (seen.has(line)) dupes++; else seen.add(line);
    try {
      const o = JSON.parse(line);
      if (!o || typeof o !== 'object' || Object.keys(o).length === 0) emptyObj++;
    } catch { parseFail++; }
  }
  const dupPct = records ? (dupes / records * 100) : 0;
  const fails = [];
  if (records === 0) fails.push('empty file');
  if (parseFail > 0) fails.push(`${parseFail} parse failures`);
  if (emptyObj > 0) fails.push(`${emptyObj} empty records`);
  if (dupPct > DUP_PCT) fails.push(`${dupPct.toFixed(1)}% dup lines (${dupes})`);
  return { label, pass: fails.length === 0, records, detail: fails.length ? fails.join('; ') : `${records} records, ${dupes} dupes (${dupPct.toFixed(2)}%)` };
}

async function selfTest() {
  const tmp = path.join('/tmp', `vq-selftest-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, ['{"a":1}', '{"a":1}', '{"a":1}', '{}', 'not json'].join('\n') + '\n'); // dups + empty + parse-fail
  const r = await checkFile(tmp);
  fs.unlinkSync(tmp);
  console.log(`SELF-TEST (seeded dup+blank+parsefail): ${r.pass ? 'FAIL — did not flag!' : 'PASS — flagged: ' + r.detail}`);
  process.exit(r.pass ? 1 : 0);  // must NOT pass (must flag)
}

if (process.argv.includes('--self-test')) { await selfTest(); }

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const files = args.length ? args : SAMPLE.map(s => path.join(DATA, s));
const results = [];
for (const f of files) results.push(await checkFile(f));

const failed = results.filter(r => !r.pass);
console.log(`\n=== Data Quality — ${failed.length ? failed.length + ' FAILING' : 'ALL PASS'} (${results.length - failed.length}/${results.length}) ===\n`);
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(40)} ${r.detail}`);
if (failed.length) console.log(`\nFAILING: ${failed.map(f => f.label).join(', ')}`);
process.exit(failed.length ? 1 : 0);
