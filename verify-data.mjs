#!/usr/bin/env node
/**
 * AI_CONTEXT: Data VERIFICATION harness for title.rootz.global (commercial-readiness Workstream B).
 *
 * service-health.mjs verifies FRESHNESS (is data updating?). This verifies CONTENT
 * (does the advertised coverage actually resolve, correctly?). It hits the live API
 * with a GOLDEN SET of known real addresses per state that MUST return the right
 * owner/county/address on every run — a regression tripwire. A silent data
 * regression (e.g. the 2026-08-10 rebuild that wiped OGRIP Clark County) fails here
 * loudly instead of shipping broken coverage to customers.
 *
 * Usage:
 *   node verify-data.mjs                 # check golden set, print table, exit nonzero on any fail
 *   BASE=http://localhost:3035 node verify-data.mjs
 *   node verify-data.mjs --json          # machine-readable
 *
 * Extend GOLDEN as coverage grows (Workstream D gate: a new county lands only once
 * its golden query passes here).
 */

const BASE = process.env.BASE || process.env.HEALTH_BASE || 'https://title.rootz.global';

// Each entry: a real address that resolves today, with what MUST be true about it.
// `county` (if set) must match; `ownerContains` (if set) must appear in the owner;
// `ownerPresent` requires a non-empty owner. Add one per advertised county.
const GOLDEN = [
  { state: 'FL', label: 'FL Miami-Dade / 1000 Brickell',   url: '/api/fl/search?address=1000+Brickell+Ave&city=Miami',            county: 'Miami-Dade', ownerPresent: true },
  { state: 'FL', label: 'FL Marion / Ocala',               url: '/api/fl/search?address=12281+NW+35th+St&city=Ocala',            county: 'Marion',     ownerContains: 'SPRAGUE' },
  { state: 'OH', label: 'OH Franklin / Columbus',          url: '/api/oh/search?address=100+E+BROAD+ST&city=Columbus',           ownerPresent: true },
  { state: 'OH', label: 'OH Clark / Springfield [OGRIP]',  url: '/api/oh/search?address=24+CENTER+ST&city=Springfield',          county: 'Clark',      addressContains: 'CENTER' },
  { state: 'NC', label: 'NC Chatham / River Forest',       url: '/api/nc/search?address=1300+RIVER+FOREST+RD&state=NC',          ownerPresent: true },
  { state: 'MA', label: 'MA Georgetown / Lake Shore',      url: '/api/ma/search?address=105+Lake+Shore+Dr&city=Georgetown',       ownerPresent: true },
];

// Coverage tripwire — a query that returns a `total`; flag if it collapses vs the
// baseline (would catch a state/county's data being wiped, cf. OGRIP Clark). FL farm
// `total` caps at 8000 (so Hollywood 7999 is a real count; big cities just floor at
// 8000). NC farm returns true totals. OH has no /api/oh/farm → OH per-county coverage
// is guarded by the golden queries above until a box-side count probe is added.
const DROP_PCT = 0.20;  // flag a >20% drop (or zero)
const COVERAGE = [
  { state: 'FL', label: 'FL Hollywood count',  url: '/api/fl/farm?city=Hollywood&limit=1', baseline: 7999 },
  { state: 'NC', label: 'NC Wake count',        url: '/api/nc/farm?county=Wake&limit=1',    baseline: 82636 },
  { state: 'NC', label: 'NC Chatham signals',   url: '/api/nc/farm?signals=absentee&limit=1', baseline: 11480 },
];
const SIMULATE_DROP = process.argv.includes('--simulate-drop');  // self-test: scale totals to prove flagging

async function checkCoverage(c) {
  let total;
  try {
    const r = await fetch(BASE + c.url, { signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    total = typeof d.total === 'number' ? d.total : null;
  } catch (e) { return { ...c, kind: 'coverage', pass: false, detail: `FETCH ERROR: ${e.message}` }; }
  if (total === null) return { ...c, kind: 'coverage', pass: false, detail: 'no total in response' };
  if (SIMULATE_DROP) total = Math.floor(total * 0.1);
  const floor = Math.floor(c.baseline * (1 - DROP_PCT));
  const pass = total > 0 && total >= floor;
  return { ...c, kind: 'coverage', pass, detail: pass ? `total ${total} (≥ floor ${floor})` : `total ${total} < floor ${floor} (baseline ${c.baseline}) — COVERAGE DROP` };
}

// Pull a field from the many shapes the state engines return.
function extract(d) {
  const p = d.property || d || {};
  const o = d.origin || {};
  const owner = p.owner?.name1 || (typeof p.owner === 'string' ? p.owner : '') || p.TRUE_OWNER1 || '';
  const county = p._county || o.county || p.county || '';
  const address = p.address || p.TRUE_SITE_ADDR || '';
  return { owner: String(owner || '').trim(), county: String(county || '').trim(), address: String(address || '').trim(), hasProperty: !!(d.property || p.owner || p.TRUE_OWNER1 || p.address) };
}

async function check(g) {
  let data;
  try {
    const r = await fetch(BASE + g.url, { signal: AbortSignal.timeout(30000) });
    data = await r.json();
  } catch (e) {
    return { ...g, pass: false, detail: `FETCH ERROR: ${e.message}` };
  }
  if (data.error && !data.property) return { ...g, pass: false, detail: `NOT FOUND: ${data.error}` };
  const f = extract(data);
  if (!f.hasProperty) return { ...g, pass: false, detail: 'no property in response' };

  const fails = [];
  if (g.ownerPresent && !f.owner) fails.push('owner empty');
  if (g.ownerContains && !f.owner.toUpperCase().includes(g.ownerContains.toUpperCase())) fails.push(`owner "${f.owner}" !~ ${g.ownerContains}`);
  if (g.county && f.county.toUpperCase() !== g.county.toUpperCase()) fails.push(`county "${f.county}" != ${g.county}`);
  if (g.addressContains && !f.address.toUpperCase().includes(g.addressContains.toUpperCase())) fails.push(`addr "${f.address}" !~ ${g.addressContains}`);

  return { ...g, pass: fails.length === 0, detail: fails.length ? fails.join('; ') : `ok — ${f.address || f.owner || f.county}` };
}

const results = [];
for (const g of GOLDEN) results.push(await check(g));
for (const c of COVERAGE) results.push(await checkCoverage(c));

const failed = results.filter(r => !r.pass);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), base: BASE, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
} else {
  console.log(`\n=== Data Verification — ${failed.length ? failed.length + ' FAILING' : 'ALL PASS'} (${results.length - failed.length}/${results.length}) — ${BASE} ===\n`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(34)} ${r.detail}`);
  if (failed.length) console.log(`\nFAILING: ${failed.map(f => f.label).join(', ')}`);
}
process.exit(failed.length ? 1 : 0);
