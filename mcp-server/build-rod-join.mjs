#!/usr/bin/env node
// Join Chatham ROD recorded instruments to CAMA parcels and summarise the
// farming-relevant legal signals.
//
// DEED-type instruments join to a parcel by Book/Page (= parcel.current_book/
// current_page, the parcel's current deed) — a high-confidence link. This lights
// up parcels whose CURRENT deed was recorded in the pulled window = recent
// ownership change (new owner).
//
// Deeds of Trust (D-T = mortgages), Satisfactions (SATIS = payoff -> free & clear
// / high equity), and Modifications (MODIF = possible distress) do NOT share the
// parcel's deed book/page, so they cannot be parcel-joined from the index grid
// alone — linking them to a specific owner needs the grantor name (Directory
// roll-up) or the recorded image. We report their volumes honestly and flag that
// gap rather than fabricating matches.
//
// Usage: node build-rod-join.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'data', 'nc', 'chatham');

const normBook = b => String(b || '').toUpperCase().replace(/^0+/, '').trim();
const normPage = p => String(p || '').replace(/^0+/, '').trim();
const bpKey = (b, p) => `${normBook(b)}/${normPage(p)}`;

function readJsonl(file) {
  const fp = path.join(DIR, file);
  if (!fs.existsSync(fp)) { console.error(`missing ${file}`); return []; }
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// classify a ROD instrument Type code into a farming signal bucket
function classify(type) {
  const t = (type || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^D-T$|DEED OF TRUST/.test(t)) return 'mortgage (deed of trust)';
  if (/^SATIS|SATISFACTION|^SOT/.test(t)) return 'mortgage payoff (satisfaction)';
  if (/MODIF/.test(t)) return 'loan modification';
  if (/^Q C D|QUIT/.test(t)) return 'quitclaim deed';
  if (/^DEED$|^D$|WARRANTY|^WD/.test(t)) return 'deed (transfer)';
  if (/LIS PEND|^LP/.test(t)) return 'lis pendens (pre-foreclosure)';
  if (/LIEN/.test(t)) return 'lien';
  if (/FORECL|TRUSTEE|SUBSTITUTE/.test(t)) return 'foreclosure';
  if (/POFA|POWER OF ATT/.test(t)) return 'power of attorney';
  if (/CANCEL|RELEASE/.test(t)) return 'cancellation/release';
  return `other (${t})`;
}

const parcels = readJsonl('cama-parcels.jsonl');
const rod = readJsonl('rod-instruments.jsonl');
console.log(`parcels=${parcels.length}  rod instruments=${rod.length}`);
if (!rod.length) { console.error('No ROD data yet — run scrape-chatham-rod.mjs first.'); process.exit(1); }

// index parcels by current deed book/page
const parcelByBP = new Map();
for (const p of parcels) {
  const k = bpKey(p.current_book, p.current_page);
  if (k !== '/') parcelByBP.set(k, p);
}

// classify + attempt deed join
const byBucket = {};
const byRawType = {};
const matchedDeeds = [];
let deedTotal = 0, deedMatched = 0;
for (const r of rod) {
  const bucket = classify(r.type);
  byBucket[bucket] = (byBucket[bucket] || 0) + 1;
  byRawType[r.type] = (byRawType[r.type] || 0) + 1;
  const isDeed = /deed \(transfer\)|quitclaim/.test(bucket);
  if (isDeed) {
    deedTotal++;
    const p = parcelByBP.get(bpKey(r.book, r.page));
    if (p) {
      deedMatched++;
      matchedDeeds.push({
        recDate: r.recDate, book: r.book, page: r.page, type: r.type, description: r.description,
        parcelId: p.parcel_number,
        owner: p.current_owners || p.jan1_owners,
        siteAddress: (p.physical_street_address || '').trim(),
        totalFMV: p.jan1_total_FMV || null
      });
    }
  }
}

// write matched recent-transfer file
fs.writeFileSync(path.join(DIR, 'rod-recent-transfers.jsonl'),
  matchedDeeds.map(d => JSON.stringify(d)).join('\n'));

// summary
const sortDesc = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
console.log('\n=== Instrument types (raw) ===');
for (const [t, n] of sortDesc(byRawType).slice(0, 20)) console.log(`  ${String(n).padStart(5)}  ${t}`);
console.log('\n=== Farming signal buckets ===');
for (const [b, n] of sortDesc(byBucket)) console.log(`  ${String(n).padStart(5)}  ${b}`);
console.log(`\nDeed records: ${deedTotal} | joined to a parcel by book/page: ${deedMatched} (${deedTotal?Math.round(deedMatched/deedTotal*100):0}%)`);
console.log(`  -> recent ownership changes written to rod-recent-transfers.jsonl`);

const mortgages = byBucket['mortgage (deed of trust)'] || 0;
const payoffs = byBucket['mortgage payoff (satisfaction)'] || 0;
console.log(`\nMortgage signals in window: ${mortgages} deeds of trust, ${payoffs} satisfactions (payoffs = high-equity signal).`);
console.log('NOTE: D-T / SATIS / MODIF are not book/page-joinable to a parcel; owner linkage needs the');
console.log('grantor-name roll-up (next enrichment) or the recorded image. Volumes reported, not fabricated.');

const md = `# Chatham ROD — Recorded Instrument Signals

**ROD instruments pulled:** ${rod.length.toLocaleString()}  (window: see rod-instruments.jsonl \`chunk\`)
**Source:** Chatham County Register of Deeds (Logan Systems), Consolidated Real Property Index — browser-driven pull, open/unauthenticated.

## Farming signal buckets
${sortDesc(byBucket).map(([b, n]) => `- **${b}:** ${n.toLocaleString()}`).join('\n')}

## Parcel linkage
- **Deed transfers:** ${deedTotal} records, **${deedMatched} joined to a parcel by Book/Page** (${deedTotal?Math.round(deedMatched/deedTotal*100):0}%) → recent ownership changes (\`rod-recent-transfers.jsonl\`).
- **Deeds of trust / satisfactions / modifications:** counted (${mortgages} / ${payoffs} / ${byBucket['loan modification']||0}) but **not parcel-joinable from the index grid** — owner linkage needs the grantor-name roll-up or recorded image. Reported as volumes; not matched to avoid fabrication (per guardrails).

## What this adds for Andy
- **Mortgage activity** (the data the assessor file lacks) is now visible at the county level.
- **Satisfactions = free-and-clear / high-equity** owners — a strong motivated-seller signal once name-linked.
- For per-owner mortgage balances and certified court foreclosure/probate, the durable path remains the **$495 AOC Remote Public Access license** (sanctioned bulk court data) — a few customers cover it.
`;
fs.writeFileSync(path.join(DIR, 'rod-summary.md'), md);
console.log('\nWrote rod-summary.md + rod-recent-transfers.jsonl');
