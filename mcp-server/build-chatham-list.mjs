#!/usr/bin/env node
// Chatham County, NC — join CAMA parcels + sales + improvements, score each
// parcel for motivated-seller signals, and emit a farming list.
//
// Answers the prompt: "motivated seller list in Chatham County, NC focused on
// pre-foreclosures, vacant properties, and absentee owners — with owner contact,
// estimated property values, and available mortgage data."
//
// Output:
//   chatham-enriched.jsonl   every parcel + signals (full dataset)
//   chatham-motivated.csv    ranked motivated-seller list (the deliverable)
//   chatham-summary.md       signal counts + methodology + data-source honesty
//
// Usage: node build-chatham-list.mjs [--min-score 3] [--top 500]

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'data', 'nc', 'chatham');

const argv = process.argv.slice(2);
const MIN_SCORE = Number((argv[argv.indexOf('--min-score') + 1]) || 3);
const TOP = Number((argv[argv.indexOf('--top') + 1]) || 1000);
const NOW_YEAR = 2026;

// ─── helpers ──────────────────────────────────────────────────────
const up = s => (s == null ? '' : String(s)).toUpperCase().trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// normalize a street address for comparison (drop punctuation, collapse spaces,
// strip common suffixes so "217 DEE FARRELL RD" == "217 DEE FARRELL ROAD")
const SUF = { ROAD:'RD', STREET:'ST', DRIVE:'DR', LANE:'LN', AVENUE:'AVE', COURT:'CT',
  CIRCLE:'CIR', BOULEVARD:'BLVD', PLACE:'PL', TRAIL:'TRL', HIGHWAY:'HWY', PARKWAY:'PKWY' };
function normStreet(s) {
  return up(s).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
    .map(w => SUF[w] || w).filter(Boolean).join(' ').trim();
}
function stateFromCsz(csz) {            // "PITTSBORO, NC 27312" -> "NC"
  const m = up(csz).match(/,?\s*([A-Z]{2})\s*\d{5}/);
  return m ? m[1] : '';
}
function readJsonl(file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ─── load layers ──────────────────────────────────────────────────
console.log('Loading layers…');
const parcels = readJsonl('cama-parcels.jsonl');
const sales = readJsonl('property-sales.jsonl');
const improvements = readJsonl('property-improvements.jsonl');
console.log(`  parcels=${parcels.length}  sales=${sales.length}  improvements=${improvements.length}`);

// index: latest valid sale per parcel
const saleByParcel = new Map();
for (const s of sales) {
  const k = up(s.parcel_Number || s.parcel_number);
  if (!k) continue;
  const d = num(s.date_of_sale);   // epoch ms
  const cur = saleByParcel.get(k);
  if (!cur || d > cur._d) {
    saleByParcel.set(k, {
      _d: d,
      date: d ? new Date(d).toISOString().slice(0, 10) : '',
      price: num(s.gross_selling_price) || num(s.net_selling_price),
      vacant: up(s.vacant_land_yn) === 'Y',
      newConst: up(s.new_const_yn) === 'Y',
      instrument: s.document_type || s.sale_type_desc || '',
      book: s.book, page: s.page,
    });
  }
}
// index: primary improvement per parcel
const imprByParcel = new Map();
for (const im of improvements) {
  const k = up(im.parcel_Number || im.parcel_number);
  if (!k) continue;
  const cur = imprByParcel.get(k);
  // prefer primary residential / highest structure_value
  if (!cur || num(im.structure_value) > cur._v) {
    imprByParcel.set(k, {
      _v: num(im.structure_value),
      yearBuilt: num(im.year_built) || null,
      beds: num(im.Bedrooms) || null,
      baths: num(im.Bathrooms) || null,
      halfBaths: num(im.Half_bathrooms) || null,
      sqft: num(im.gross_living_area) || null,
      stories: num(im.Stories) || null,
      condition: im.condition_desc || '',
      quality: im.quality_desc || '',
      completion: num(im.completion_percentage),
      use: im.property_use || '',
    });
  }
}

// ─── score each parcel ────────────────────────────────────────────
const CORP = /\b(LLC|L L C|INC|CORP|LTD|CO$|COMPANY|HOLDINGS|PROPERTIES|PARTNERS|LP$|L P|ENTERPRISES|GROUP|INVESTMENTS|CAPITAL|REALTY|DEVELOPMENT|HOMES|BUILDERS)\b/;
const TRUST = /\b(TRUST|TRUSTEE|TTEE|TR$|ESTATE|HEIRS|LIFE ESTATE|REVOCABLE|LIVING TRUST)\b/;

const out = fs.createWriteStream(path.join(DIR, 'chatham-enriched.jsonl'));
const rows = [];
const signalCounts = {};
const bump = s => { signalCounts[s] = (signalCounts[s] || 0) + 1; };

for (const p of parcels) {
  const pid = up(p.parcel_number);
  const owner = (p.current_owners || p.jan1_owners || '').trim();
  const ownerUp = up(owner);
  const mailStreet = normStreet(p.address1);
  const situs = normStreet(p.physical_street_address);
  const mailState = stateFromCsz(p.csz);

  const landFMV = num(p.jan1_land_FMV);
  const bldgFMV = num(p.jan1_bldg_FMV);
  const totalFMV = num(p.jan1_total_FMV) || landFMV + bldgFMV;
  const acres = num(p.gross_current_acres);

  const sale = saleByParcel.get(pid);
  const impr = imprByParcel.get(pid);
  const lastSaleYear = sale?.date ? Number(sale.date.slice(0, 4)) : null;

  const signals = [];
  let score = 0;

  // VACANT — no building value (and/or sale-flagged vacant land)
  const vacant = bldgFMV === 0 || (sale?.vacant && !impr);
  if (vacant) { signals.push('Vacant Land'); score += 2; }

  // ABSENTEE — mailing street ≠ situs street. Require BOTH to be real numbered
  // street addresses: thousands of vacant/rural parcels have a situs with no
  // house number (just a road name), which would otherwise false-positive.
  let absentee = false;
  const mailHasNum = /^\d/.test(mailStreet);
  const situsHasNum = /^\d/.test(situs);
  if (mailHasNum && situsHasNum && mailStreet !== situs) { absentee = true; signals.push('Absentee Owner'); score += 2; }

  // PO BOX mailing — owner takes mail at a box, classic investor/absentee proxy
  if (/^P\s*O\s*BOX\b|^PO BOX\b|^POBOX\b/.test(up(p.address1))) { signals.push('PO Box Owner'); score += 1; }

  // OUT OF STATE owner
  if (mailState && mailState !== 'NC') { signals.push(`Out-of-State Owner (${mailState})`); score += 2; }

  // CORPORATE / LLC
  if (CORP.test(ownerUp)) { signals.push('Corporate/LLC Owner'); score += 1; }

  // TRUST / ESTATE / HEIRS (probate-adjacent)
  if (TRUST.test(ownerUp)) { signals.push('Trust/Estate/Heirs'); score += 2; }

  // COUNTY ALERT flag, if populated (rare in this layer, but free distress signal)
  const alert = (p.alert_description || p.alert_code || '').toString().trim();
  if (alert) { signals.push(`Alert: ${alert}`.slice(0, 60)); score += 3; }
  // tax_status here is only T(axable)/E(xempt) — exempt = govt/church, NOT a seller
  // signal — so it is recorded as info only, never scored.

  // AG / Present-Use-Value deferral (rollback risk on sale = motivated)
  if (num(p.current_puv_deferred) > 0 || num(p.jan1_puv_deferred) > 0) { signals.push('AG/Forestry PUV Deferred'); score += 1; }

  // LONG-HELD (likely high equity — no recent sale)
  if (lastSaleYear && (NOW_YEAR - lastSaleYear) >= 20) { signals.push(`Long-Held (${NOW_YEAR - lastSaleYear}y)`); score += 1; }
  if (!lastSaleYear && bldgFMV > 0) { signals.push('No Recorded Sale (legacy owner)'); score += 1; }

  // RURAL (well/septic) — small-acreage farm / land lead context
  const rural = /WELL/i.test(p.WaterUtilityType || '') || /(SEPTIC|OSS|ONSITE)/i.test(p.SanitaryUtilityType || '');

  // LARGE ACREAGE
  if (acres >= 10) { signals.push(`Large Acreage (${acres.toFixed(1)} ac)`); score += 1; }

  // HIGH VALUE
  if (totalFMV >= 750000) { score += 1; }

  // record everything; keep if it clears the bar
  const rec = {
    parcelId: pid,
    owner,
    owner2: (p.jan1_owners && p.jan1_owners !== p.current_owners) ? p.jan1_owners : '',
    siteAddress: (p.physical_street_address || '').trim(),
    community: p.community_name || p.neighborhood_desc || '',
    mailAddress: [p.address1, p.address2].filter(Boolean).join(' ').trim(),
    mailCSZ: (p.csz || '').trim(),
    mailState,
    landUse: p.land_use || '',
    zoning: p.zoning || '',
    acres: acres || null,
    landFMV: landFMV || null,
    bldgFMV: bldgFMV || null,
    totalFMV: totalFMV || null,
    assessedTotal: num(p.jan1_total_ASV) || null,
    yearBuilt: impr?.yearBuilt || null,
    beds: impr?.beds || null,
    baths: impr?.baths || null,
    sqft: impr?.sqft || null,
    lastSaleDate: sale?.date || '',
    lastSalePrice: sale?.price || null,
    deedBookPage: (p.current_book && p.current_page) ? `${p.current_book}/${p.current_page}` : '',
    water: p.WaterUtilityType || '',
    sewer: p.SanitaryUtilityType || '',
    rural,
    vacant,
    absentee,
    taxStatus: p.tax_status || '',
    signals,
    score,
    // owner-contact assist (phone/email = skip-trace gap; mailing addr is the durable contact)
    ownerSearchUrl: ownerUp.replace(/[^A-Z ]/g, '').trim().length > 3
      ? `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(owner.replace(/[^a-zA-Z ]/g, '').trim())}&citystatezip=${encodeURIComponent((p.csz || 'Pittsboro NC'))}`
      : '',
  };
  out.write(JSON.stringify(rec) + '\n');
  for (const s of signals) {
    const base = s.split(' (')[0].split(':')[0];
    bump(base);
  }
  if (score >= MIN_SCORE) rows.push(rec);
}
out.end();

// ─── rank + write CSV ─────────────────────────────────────────────
rows.sort((a, b) => b.score - a.score || (b.totalFMV || 0) - (a.totalFMV || 0));
const top = rows.slice(0, TOP);

const csvCols = ['score','parcelId','owner','siteAddress','community','mailAddress','mailCSZ',
  'landUse','zoning','acres','totalFMV','assessedTotal','landFMV','bldgFMV','yearBuilt','beds','baths','sqft',
  'lastSaleDate','lastSalePrice','deedBookPage','water','sewer','vacant','absentee','taxStatus','signals','ownerSearchUrl'];
const esc = v => {
  if (v == null) return '';
  if (Array.isArray(v)) v = v.join(' | ');
  v = String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
const csv = [csvCols.join(',')].concat(top.map(r => csvCols.map(c => esc(r[c])).join(','))).join('\n');
fs.writeFileSync(path.join(DIR, 'chatham-motivated.csv'), csv);

// ─── summary ──────────────────────────────────────────────────────
const sortedSignals = Object.entries(signalCounts).sort((a, b) => b[1] - a[1]);
const vacantN = parcels.filter(p => num(p.jan1_bldg_FMV) === 0).length;
const md = `# Chatham County, NC — Motivated Seller Intelligence

**Generated:** ${new Date().toISOString().slice(0, 10)}
**Source:** Chatham County GIS (open ArcGIS) — CamaParcels + PropertySales + PropertyImprovements
**Parcels analyzed:** ${parcels.length.toLocaleString()}
**Motivated-seller list (score ≥ ${MIN_SCORE}):** ${rows.length.toLocaleString()} parcels (top ${top.length} exported to CSV)

## Signal counts (full county)
${sortedSignals.map(([s, n]) => `- **${s}:** ${n.toLocaleString()}`).join('\n')}
- **Vacant (no building value):** ${vacantN.toLocaleString()}

## What this dataset answers (Andy's prompt)
| Ask | Status | Source |
|---|---|---|
| Vacant properties | ✅ Full | \`jan1_bldg_FMV = 0\` + sales \`vacant_land_yn\` |
| Absentee owners | ✅ Full | mailing street ≠ situs street |
| Out-of-state owners | ✅ Full | parsed from mailing city/state/zip |
| Estimated property values | ✅ Full | county FMV (land/bldg/total) + assessed value |
| Owner contact (name + mailing addr) | ✅ Full | CamaParcels owner + mailing address |
| Owner phone / email | ⚠️ Gap | skip-trace partner needed (same as FL) — TruePeopleSearch link provided per row |
| Pre-foreclosures | ⚠️ Partial | county \`alert_code\`/\`tax_status\` flags here; full Notice-of-Sale feed = ncnotices.com (separate pull) |
| Mortgage data (balance/lender) | ⚠️ Partial | deed book/page provided (links to recorded Deed of Trust); balances live in Register of Deeds portal (Logan Systems, portal-only) |

## Notes
- "Pre-foreclosure" and "mortgage balance" are NOT in assessor data anywhere — in NC they live at the Clerk of Superior Court (foreclosure Special Proceedings) and Register of Deeds (Deeds of Trust). This build surfaces the county's own tax-distress alerts and the deed reference; the live foreclosure Notice-of-Sale feed (ncnotices.com) and ROD mortgage lookup are follow-on pulls.
- Scoring is additive across signals; tune with \`--min-score\` and \`--top\`.
`;
fs.writeFileSync(path.join(DIR, 'chatham-summary.md'), md);

console.log(`\nDONE`);
console.log(`  enriched: ${parcels.length.toLocaleString()} parcels -> chatham-enriched.jsonl`);
console.log(`  motivated list (score>=${MIN_SCORE}): ${rows.length.toLocaleString()} -> chatham-motivated.csv (top ${top.length})`);
console.log(`  summary -> chatham-summary.md`);
console.log('\nTop signals:');
for (const [s, n] of sortedSignals.slice(0, 12)) console.log(`  ${s.padEnd(34)} ${n.toLocaleString()}`);
