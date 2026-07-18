#!/usr/bin/env node
// Service health audit for title.rootz.global — answers two questions and ALERTS:
//   1. OPERATIONAL: do the live query endpoints actually return real data?
//   2. UPDATING:    is each dataset fresh for its refresh cadence, or has a
//                   refresh silently stopped? (Thresholds are ~2× the cron cadence
//                   so a *failing* weekly/monthly job is caught early, not at 45d.)
//
// On failure it emails an alert (Gmail OAuth via lib/email-service.mjs), deduped
// so it doesn't spam (alerts only when the failure set changes or >12h elapsed).
// Writes data/health-status.json (served at /api/health) and exits non-zero on fail.
//
// THE RULE this enforces: every dataset an engine reads MUST appear in DATASETS
// below with a threshold matching its refresh cron. Adding a state? Add its
// datasets here too — that's how staleness gets caught automatically.
//
// Usage: node service-health.mjs   (cron: every 6h)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const STATUS_FILE = path.join(DATA, 'health-status.json');
const BASE = process.env.HEALTH_BASE || 'https://title.rootz.global';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'steven@sprague.com';
const now = Date.now();
const results = [];
const add = (cat, name, pass, detail) => results.push({ cat, name, pass, detail });

async function getJSON(p) {
  try { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000) }); return await r.json(); }
  catch (e) { return { _err: e.message }; }
}

// ── 1. ENDPOINTS (operational) ────────────────────────────────────
async function checkEndpoints() {
  const wk = await getJSON('/.well-known/ai');
  add('discovery', '.well-known/ai', wk.name === 'Rootz Property Intelligence', wk.tagline || wk._err || '');
  const oa = await getJSON('/api/openapi.json');
  add('discovery', 'openapi spec', Object.keys(oa.paths || {}).includes('/api/nc/farm'), `${Object.keys(oa.paths || {}).length} paths`);

  const flf = await getJSON('/api/fl/farm?city=HOLLYWOOD&limit=3');
  add('endpoint', 'FL farm', (flf.total || flf.count || (flf.results || []).length) > 0, `${flf.total || flf.count || (flf.results || []).length} found`);
  const fls = await getJSON('/api/fl/search?address=1000+BRICKELL+AVE&city=MIAMI');
  add('endpoint', 'FL search', !!fls.property, fls.property ? '1000 BRICKELL AVE' : (fls.error || 'no property'));
  const oh = await getJSON('/api/oh/search?address=100+E+BROAD+ST&city=COLUMBUS');
  add('endpoint', 'OH search', !!(oh.property?.owner?.name1), oh.property?.parcelId || oh.error || '');
  const nc = await getJSON('/api/nc/search?address=1300+RIVER+FOREST+RD&state=NC');
  add('endpoint', 'NC search (Chatham)', !!(nc.property?.owner?.name1), nc.property?.owner?.name1 || nc.error || '');
  const ncf = await getJSON('/api/nc/farm?signals=vacant,absentee&limit=2');
  add('endpoint', 'NC farm (Chatham)', (ncf.total || 0) > 0, `${ncf.total} matches`);
  const ncw = await getJSON('/api/nc/farm?county=Wake&signals=absentee&limit=1');
  add('endpoint', 'NC statewide (Wake)', (ncw.total || 0) > 0, `${ncw.total} Wake matches`);
}

// ── 2. DATA FRESHNESS (updating) ──────────────────────────────────
// [ relative path under data/, max-age days (~2× cron cadence), label ]
// EVERY dataset an engine reads belongs here. Threshold tuned to the cron so a
// FAILING refresh trips this well before the data is dangerously old.
const DATASETS = [
  ['florida/cities', 40, 'FL statewide parcels (monthly)'],
  ['florida/miami-dade-parcels.jsonl', 40, 'FL Miami-Dade parcels (monthly)'],
  ['florida/building-permits.json', 14, 'FL building permits (weekly)'],
  ['ohio/cities', 14, 'OH parcels city-index (weekly)'],
  ['nc/chatham/cama-parcels.jsonl', 40, 'NC Chatham parcels (monthly)'],
  ['nc/chatham/rod-instruments.jsonl', 12, 'NC Register of Deeds (weekly)'],
  ['nc/onemap', 40, 'NC statewide parcels (monthly)'],
  ['broward-clerk', 3, 'Broward court records (daily)'],
  ['dbpr-licenses', 40, 'FL vacation rentals (monthly)'],
];
// A directory's mtime only moves when entries are added or removed — rewriting
// files in place leaves it untouched. Statting the directory therefore reports
// a rebuilt index as ancient (and, worse, a half-finished rebuild as merely
// "stale"). For directories, use the NEWEST contained file instead.
function newestMtime(fp) {
  const st = fs.statSync(fp);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of fs.readdirSync(fp)) {
    try {
      const s = fs.statSync(path.join(fp, name));
      if (!s.isDirectory() && s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {}
  }
  return newest;  // 0 when the directory is empty → reads as maximally stale
}
function checkFreshness() {
  for (const [rel, maxDays, label] of DATASETS) {
    const fp = path.join(DATA, rel);
    if (!fs.existsSync(fp)) { add('freshness', label, false, 'MISSING'); continue; }
    const mtime = newestMtime(fp);
    if (!mtime) { add('freshness', label, false, 'EMPTY'); continue; }
    const ageDays = (now - mtime) / 86400000;
    add('freshness', label, ageDays <= maxDays, `${ageDays.toFixed(1)}d old (max ${maxDays})`);
  }
}

// ── 3. ALERT (email on failure, deduped) ──────────────────────────
async function maybeAlert(status, failed) {
  if (process.env.HEALTH_NO_ALERT) return; // manual/test runs: don't email
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
  const sig = failed.map(f => f.name).sort().join('|');
  const lastAt = prev.alertAt ? Date.parse(prev.alertAt) : 0;
  const changed = sig !== (prev.alertSig || '');
  const stale = (now - lastAt) > 12 * 3600 * 1000;
  // carry forward by default
  status.alertSig = prev.alertSig || '';
  status.alertAt = prev.alertAt || null;
  if (!failed.length) { status.alertSig = ''; return; }  // recovered — clear
  if (!(changed || stale)) return;                        // already alerted recently, same issues
  try {
    const { sendEmail } = await import('./lib/email-service.mjs');
    const rows = failed.map(f => `<li><b>${f.name}</b> — ${f.detail}</li>`).join('');
    await sendEmail({
      to: ALERT_EMAIL,
      subject: `[Rootz Health] ${failed.length} check(s) FAILING on title.rootz.global`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px">
        <h2 style="color:#b23b3b">Service health: ${failed.length} failing</h2>
        <p>title.rootz.global self-check at ${new Date().toISOString()}:</p>
        <ul>${rows}</ul>
        <p style="color:#64748b;font-size:13px">Live status: <a href="${BASE}/api/health">${BASE}/api/health</a>.
        A failing <i>freshness</i> check usually means a refresh cron stopped updating that dataset.</p>
      </div>`,
    });
    status.alertSig = sig; status.alertAt = new Date().toISOString(); status.alertSent = true;
    console.log(`  ALERT emailed to ${ALERT_EMAIL} (${failed.length} failing)`);
  } catch (e) { console.error('  alert email failed:', e.message); }
}

// ── run ───────────────────────────────────────────────────────────
await checkEndpoints();
// Retry transient endpoint/discovery failures before counting them: a single
// momentary load spike or external-API hiccup must NOT page. A check only counts
// as failed if it fails AGAIN ~10s later. (Freshness can't flap, so no retry.)
const flappy = results.filter(r => (r.cat === 'endpoint' || r.cat === 'discovery') && !r.pass).map(r => r.name);
if (flappy.length) {
  console.log(`  ${flappy.length} endpoint check(s) failed first pass — retrying before alerting…`);
  await new Promise(r => setTimeout(r, 10000));
  const prior = results;
  results = [];
  await checkEndpoints();                 // re-run endpoint/discovery checks
  const retry = Object.fromEntries(results.map(r => [r.name, r]));
  results = prior.map(r => (r.cat === 'endpoint' || r.cat === 'discovery') ? (retry[r.name] || r) : r);
}
checkFreshness();
const failed = results.filter(r => !r.pass);
const status = { checkedAt: new Date().toISOString(), ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
await maybeAlert(status, failed);
try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2)); } catch {}

console.log(`\n=== Service Health — ${status.ok ? 'ALL OK' : failed.length + ' FAILING'} (${status.passed}/${results.length}) ===`);
let cat = '';
for (const r of results) { if (r.cat !== cat) { cat = r.cat; console.log(`\n[${cat}]`); } console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.detail}`); }
if (failed.length) { console.log(`\nFAILING: ${failed.map(f => f.name).join(', ')}`); process.exit(1); }
console.log('\nService is operational and all datasets are fresh.');
