#!/usr/bin/env node
// Answer "how did this county's record change between two dates?" from two archived
// captures. The manifest's sha256 says THAT something changed; this says WHAT.
//
// Reads the two .zst captures as streams — never materialises either file as one
// string (these are 1GB+ and Node's max string is ~512MB; that exact mistake took
// the OH weekly rebuild down for two weeks).
//
// Usage: node diff-captures.mjs <old.zst> <new.zst> --key PARCELID --fields A,B,C
import fs from 'fs';
import readline from 'readline';
import { spawn } from 'child_process';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const KEY = opt('--key', 'PARCELID');
const FIELDS = opt('--fields', '').split(',').filter(Boolean);
const [OLD, NEW] = files;
if (!OLD || !NEW) { console.log('Usage: node diff-captures.mjs <old.zst> <new.zst> --key PARCELID --fields A,B,C'); process.exit(1); }

async function load(file) {
  const map = new Map();
  const src = file.endsWith('.zst')
    ? spawn('nice', ['-n', '19', 'zstd', '-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout
    : fs.createReadStream(file);
  const rl = readline.createInterface({ input: src, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue }
    const k = d[KEY];
    if (k === undefined || k === null || k === '') continue;
    const picked = {};
    for (const f of FIELDS) picked[f] = d[f] ?? null;
    map.set(String(k), picked);
  }
  return map;
}

const t0 = Date.now();
const [a, b] = [await load(OLD), await load(NEW)];
console.log(`loaded ${a.size.toLocaleString()} (old) / ${b.size.toLocaleString()} (new) in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

let same = 0, changed = 0;
const byField = Object.fromEntries(FIELDS.map(f => [f, 0]));
const examples = {};
for (const [k, ov] of a) {
  const nv = b.get(k);
  if (!nv) continue;
  let diff = false;
  for (const f of FIELDS) {
    if (String(ov[f]) !== String(nv[f])) {
      byField[f]++; diff = true;
      if (!examples[f]) examples[f] = `${k}: ${JSON.stringify(ov[f])} -> ${JSON.stringify(nv[f])}`;
    }
  }
  diff ? changed++ : same++;
}
const added = [...b.keys()].filter(k => !a.has(k)).length;
const removed = [...a.keys()].filter(k => !b.has(k)).length;
const common = same + changed;

console.log(`parcels in both : ${common.toLocaleString()}`);
console.log(`  unchanged     : ${same.toLocaleString()}  (${(same / common * 100).toFixed(2)}%)`);
console.log(`  CHANGED       : ${changed.toLocaleString()}  (${(changed / common * 100).toFixed(2)}%)`);
console.log(`added (new)     : ${added.toLocaleString()}`);
console.log(`removed (gone)  : ${removed.toLocaleString()}\n`);
console.log('by field:');
for (const f of FIELDS.sort((x, y) => byField[y] - byField[x])) {
  const pct = (byField[f] / common * 100).toFixed(3);
  console.log(`  ${f.padEnd(16)} ${String(byField[f]).padStart(8)}  ${pct.padStart(7)}%   ${examples[f] ? 'e.g. ' + examples[f].slice(0, 70) : ''}`);
}
