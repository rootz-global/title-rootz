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
import os from 'os';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const STATUS_FILE = process.env.HEALTH_STATUS_FILE || path.join(DATA, 'health-status.json');
const BASE = process.env.HEALTH_BASE || 'https://title.rootz.global';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'steven@sprague.com';
const now = Date.now();
// `let`, not `const`: the transient-failure retry path below swaps this array
// out. As a const that threw TypeError mid-run, so ANY failing endpoint check
// killed the health run before it could alert or write status — the one case
// the alerting exists for.
let results = [];
// `level` distinguishes a hard FAIL (pages) from a soft WARN (visible on
// /api/health but does NOT page — used when a source we don't control is
// lagging while our own harvester is healthy). Defaults derive from `pass` so
// every existing caller keeps its old behaviour.
// `raw` is the parsed response (or {_err} from getJSON). When the call never
// completed, SAY SO. Previously a timeout on FL farm rendered as "0 found" and on
// NC farm as "undefined matches", because the detail string only ever printed the
// missing field — so a transport failure was indistinguishable from an empty
// dataset. Nineteen days of "8 checks failing" therefore read as a data problem
// when every one of them was a timeout. Cause belongs in the alert, not just the
// symptom; and `transport` is what lets the box-saturation rule below fire only on
// calls that never landed, never on a query that genuinely returned nothing.
const add = (cat, name, pass, detail, level, raw) => {
  const transport = !!(raw && raw._err);
  results.push({
    cat, name, pass,
    detail: transport ? `TRANSPORT: ${raw._err}` : detail,
    level: level || (pass ? 'ok' : 'fail'),
    ...(transport ? { transport: true } : {}),
  });
};

async function getJSON(p) {
  try { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000) }); return await r.json(); }
  catch (e) { return { _err: e.message }; }
}

// ── 1. ENDPOINTS (operational) ────────────────────────────────────
async function checkEndpoints() {
  const wk = await getJSON('/.well-known/ai');
  add('discovery', '.well-known/ai', wk.name === 'Rootz Property Intelligence', wk.tagline || '', undefined, wk);
  const oa = await getJSON('/api/openapi.json');
  add('discovery', 'openapi spec', Object.keys(oa.paths || {}).includes('/api/nc/farm'), `${Object.keys(oa.paths || {}).length} paths`, undefined, oa);

  const flf = await getJSON('/api/fl/farm?city=HOLLYWOOD&limit=3');
  add('endpoint', 'FL farm', (flf.total || flf.count || (flf.results || []).length) > 0, `${flf.total || flf.count || (flf.results || []).length} found`, undefined, flf);
  const fls = await getJSON('/api/fl/search?address=1000+BRICKELL+AVE&city=MIAMI');
  add('endpoint', 'FL search', !!fls.property, fls.property ? '1000 BRICKELL AVE' : (fls.error || 'no property'), undefined, fls);
  const oh = await getJSON('/api/oh/search?address=100+E+BROAD+ST&city=COLUMBUS');
  add('endpoint', 'OH search', !!(oh.property?.owner?.name1), oh.property?.parcelId || oh.error || '', undefined, oh);
  const nc = await getJSON('/api/nc/search?address=1300+RIVER+FOREST+RD&state=NC');
  add('endpoint', 'NC search (Chatham)', !!(nc.property?.owner?.name1), nc.property?.owner?.name1 || nc.error || '', undefined, nc);
  const ncf = await getJSON('/api/nc/farm?signals=vacant,absentee&limit=2');
  add('endpoint', 'NC farm (Chatham)', (ncf.total || 0) > 0, `${ncf.total} matches`, undefined, ncf);
  const ncw = await getJSON('/api/nc/farm?county=Wake&signals=absentee&limit=1');
  add('endpoint', 'NC statewide (Wake)', (ncw.total || 0) > 0, `${ncw.total} Wake matches`, undefined, ncw);
}

// ── 2. DATA FRESHNESS (updating) ──────────────────────────────────
// [ relative path under data/, max-age days (~2× cron cadence), label ]
// EVERY dataset an engine reads belongs here. Threshold tuned to the cron so a
// FAILING refresh trips this well before the data is dangerously old.
// A 4th element marks datasets whose filenames carry the date of the DATA
// itself (Broward ships MM-DD-YYYYdoc-ver.txt). mtime only proves when we last
// downloaded — a harvester that re-fetches the same stale files, or a source
// that has stopped publishing, still looks perfectly fresh by mtime. Where a
// content date is available, check that instead.
//
// A 5th element (opts) makes a dataset SOURCE-AWARE: it separates "our harvester
// broke" (page me) from "the upstream source stopped publishing" (their problem,
// not a page). See checkFreshness for the three states it produces.
const DATASETS = [
  ['florida/cities', 40, 'FL statewide parcels (monthly)'],
  ['florida/miami-dade-parcels.jsonl', 40, 'FL Miami-Dade parcels (monthly)'],
  ['florida/building-permits.json', 14, 'FL building permits (weekly)'],
  ['ohio/cities', 14, 'OH parcels city-index (weekly)'],
  ['nc/chatham/cama-parcels.jsonl', 40, 'NC Chatham parcels (monthly)'],
  ['nc/chatham/rod-instruments.jsonl', 12, 'NC Register of Deeds (weekly)'],
  ['nc/onemap', 40, 'NC statewide parcels (monthly)'],
  ['broward-clerk', 3, 'Broward court records (daily)', /^(\d{2})-(\d{2})-(\d{4})doc-ver\.txt$/,
    // Broward is a county SFTP that skips weekends/holidays and periodically
    // stalls on its own. A flat 3-day max therefore red-alerts (and re-emails
    // every 12h) on every long weekend and every county-side stall, even though
    // our pull ran perfectly. So: page only if OUR harvester hasn't run+connected
    // in `harvestMaxHours`; if the harvester is healthy but the county is stale,
    // WARN (no page) until the source has been dark for `sourceDarkDays`, which
    // is a real "chase the county" condition worth a page.
    { harvestStamp: '.last-harvest.json', harvestMaxHours: 30, sourceDarkDays: 14 }],
  ['dbpr-licenses', 40, 'FL vacation rentals (monthly)'],
];

// Newest data date encoded in a directory's filenames, or 0 if none parse.
function newestContentDate(dir, pattern) {
  let newest = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(pattern);
    if (!m) continue;
    const t = Date.parse(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`);
    if (t && t > newest) newest = t;
  }
  return newest;
}
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
// Three-state check for a dataset fed by an upstream source we don't control.
// Returns true once it has recorded a result (so the caller skips the plain
// path), false to fall through to the generic content-date check.
//   1. Harvester stalled  → FAIL (page): our cron didn't run or couldn't reach
//      the source within harvestMaxHours. Also the case if the stamp predates
//      this feature (no stamp yet) AND the data is already stale.
//   2. Source dark        → FAIL (page): harvester healthy, but the source has
//      published nothing for sourceDarkDays — worth a human chasing the county.
//   3. Source lagging      → WARN (no page): harvester healthy, source merely
//      behind its normal cadence (weekend/holiday/short stall). Visible, quiet.
//   otherwise             → PASS.
function checkSourceAware(fp, maxDays, label, datePattern, opts) {
  const stampPath = path.join(fp, opts.harvestStamp);
  let harvestAgeH = Infinity;
  if (fs.existsSync(stampPath)) {
    try {
      const at = Date.parse(JSON.parse(fs.readFileSync(stampPath, 'utf8')).at);
      if (at) harvestAgeH = (now - at) / 3600000;
    } catch { /* unreadable stamp → treat as no stamp */ }
  }

  const contentDate = newestContentDate(fp, datePattern);
  if (!contentDate) return false; // nothing dated on disk — let generic path report it
  const ageDays = (now - contentDate) / 86400000;
  const asOf = new Date(contentDate).toISOString().slice(0, 10);

  // 1. Our side: did the harvester run and reach the source recently?
  if (harvestAgeH > opts.harvestMaxHours) {
    // No fresh heartbeat. Only a real problem if the data is also stale — a
    // brand-new stamp file simply hasn't been written yet on a fresh deploy.
    if (ageDays > maxDays) {
      const how = harvestAgeH === Infinity
        ? 'no harvest heartbeat on disk'
        : `last successful pull ${harvestAgeH.toFixed(0)}h ago`;
      add('freshness', label, false,
          `HARVESTER STALLED — ${how}; newest data ${asOf} (${ageDays.toFixed(1)}d). Check the cron / SFTP.`);
      return true;
    }
    return false; // harvester quiet but data still fresh — let generic path pass it
  }

  // 2 & 3. Harvester is healthy from here on.
  if (ageDays <= maxDays) {
    add('freshness', label, true, `data as of ${asOf}, ${ageDays.toFixed(1)}d old (max ${maxDays})`);
  } else if (ageDays <= opts.sourceDarkDays) {
    add('freshness', label, true,
        `source lagging — county last published ${asOf} (${ageDays.toFixed(1)}d); our harvester is healthy, nothing newer available`,
        'warn');
  } else {
    add('freshness', label, false,
        `SOURCE DARK — county has published nothing for ${ageDays.toFixed(1)}d (last ${asOf}); harvester healthy — chase Broward`);
  }
  return true;
}

function checkFreshness() {
  for (const [rel, maxDays, label, datePattern, opts] of DATASETS) {
    const fp = path.join(DATA, rel);
    if (!fs.existsSync(fp)) { add('freshness', label, false, 'MISSING'); continue; }

    // Source-aware path: split "our harvester broke" from "the source is stale".
    if (opts && opts.harvestStamp && datePattern && fs.statSync(fp).isDirectory()) {
      if (checkSourceAware(fp, maxDays, label, datePattern, opts)) continue;
    }

    if (datePattern && fs.statSync(fp).isDirectory()) {
      const contentDate = newestContentDate(fp, datePattern);
      if (contentDate) {
        const ageDays = (now - contentDate) / 86400000;
        const asOf = new Date(contentDate).toISOString().slice(0, 10);
        add('freshness', label, ageDays <= maxDays,
            `data as of ${asOf}, ${ageDays.toFixed(1)}d old (max ${maxDays})`);
        continue;
      }
    }

    const mtime = newestMtime(fp);
    if (!mtime) { add('freshness', label, false, 'EMPTY'); continue; }
    const ageDays = (now - mtime) / 86400000;
    add('freshness', label, ageDays <= maxDays, `${ageDays.toFixed(1)}d old (max ${maxDays})`);
  }
}

// ── BOX EVIDENCE ──────────────────────────────────────────────────
// An endpoint timeout has two very different causes: title is broken, or the BOX
// is starved and everything on it is timing out. Those need opposite responses —
// one is ours to fix, the other is an infra decision — so MEASURE the difference
// instead of inferring it from a failure count. Same discipline as the Broward
// WARN: separate "not our fault" from "we are broken", and say which in the alert.
async function boxEvidence() {
  const ev = { load1: null, cores: null, loadPerCore: null, proc: null };
  try {
    ev.load1 = parseFloat(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
    ev.cores = os.cpus().length;
    if (ev.load1 >= 0 && ev.cores > 0) ev.loadPerCore = +(ev.load1 / ev.cores).toFixed(2);
  } catch {}
  // Sample CPU several times and take the MEDIAN. A single pm2 reading is far too
  // noisy to decide anything: consecutive samples of this process measured
  // 14.9, 0, 0, 0.4, 0 within ten seconds. Worse, one sample taken right after the
  // endpoint checks partly measures the checks' OWN load — the first version of
  // this read 56.5% and concluded "that's us", when the median was 0.
  const cpus = [];
  for (let i = 0; i < 5; i++) {
    try {
      const j = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const p = j.find(x => x.name === 'title-records');
      if (!p) break;
      if (typeof p.monit?.cpu === 'number') cpus.push(p.monit.cpu);
      ev.proc = {
        status: p.pm2_env?.status,
        memMB: Math.round((p.monit?.memory || 0) / 1048576),
        restarts: p.pm2_env?.restart_time ?? null,
        cpu: null,
      };
    } catch { break }
    if (i < 4) await new Promise(r => setTimeout(r, 1000));   // sleep, never spin — a busy-wait would add the load it is trying to measure
  }
  if (ev.proc && cpus.length) {
    cpus.sort((a, b) => a - b);
    ev.proc.cpu = cpus[Math.floor(cpus.length / 2)];
    ev.proc.cpuSamples = cpus;
  }
  return ev;
}

// The box is saturated AND we are its victim (not its cause) when the box is
// heavily loaded while OUR process is online and not itself burning CPU. If we
// ARE the one burning CPU, that is a title bug and it pages — hence the ceiling.
// Env-tunable because the right threshold is a property of the box, not the code
// (and because a rule you cannot exercise in a test is a rule you cannot trust).
const SAT_LOAD_PER_CORE = +(process.env.HEALTH_SAT_LOAD_PER_CORE || 2.5);  // 2-core box => load >= 5
const SAT_OUR_CPU_MAX = +(process.env.HEALTH_SAT_OUR_CPU_MAX || 40);
const SAT_CHRONIC_DAYS = +(process.env.HEALTH_SAT_CHRONIC_DAYS || 3);
function isBoxSaturated(ev) {
  return ev.loadPerCore !== null && ev.loadPerCore >= SAT_LOAD_PER_CORE
    && !!ev.proc && ev.proc.status === 'online'
    && ev.proc.cpu !== null && ev.proc.cpu < SAT_OUR_CPU_MAX;
}
const evDesc = (ev) => ev.loadPerCore === null
  ? 'box evidence unavailable'
  : `load ${ev.load1} on ${ev.cores} cores = ${ev.loadPerCore}/core; title-records `
    + (ev.proc ? `${ev.proc.status} at ${ev.proc.cpu}% CPU / ${ev.proc.memMB}MB` : 'unknown');

// ── 3. ALERT (email on failure, deduped) ──────────────────────────
// Repeat-alert backoff. An UNCHANGED failure signature is one ongoing condition,
// not a fresh event every 12h. Re-alerting it twice a day for 19 days is how a
// service teaches its owner to ignore its mailbox — at which point the next REAL
// failure lands in an inbox nobody reads. So a persistent condition backs off:
// 12h, then 24h, then 72h, then weekly. A CHANGED signature always alerts at once.
const REPEAT_BACKOFF_H = [12, 24, 72, 168];

async function maybeAlert(status, failed, box) {
  if (process.env.HEALTH_NO_ALERT) return; // manual/test runs: don't email
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
  const sig = failed.map(f => f.name).sort().join('|');
  const lastAt = prev.alertAt ? Date.parse(prev.alertAt) : 0;
  const changed = sig !== (prev.alertSig || '');
  const repeats = changed ? 0 : (prev.alertRepeats || 0);
  const waitH = REPEAT_BACKOFF_H[Math.min(repeats, REPEAT_BACKOFF_H.length - 1)];
  const stale = (now - lastAt) > waitH * 3600 * 1000;
  // carry forward by default
  status.alertSig = prev.alertSig || '';
  status.alertAt = prev.alertAt || null;
  status.alertRepeats = prev.alertRepeats || 0;
  if (!failed.length) { status.alertSig = ''; status.alertRepeats = 0; return; }  // recovered — clear
  if (!(changed || stale)) {
    if (process.env.HEALTH_ALERT_DRYRUN) console.log(`  DRYRUN suppressed — unchanged signature, next reminder due in ${Math.max(0, Math.round((lastAt + waitH * 3600 * 1000 - now) / 3600000))}h (repeat #${repeats}, window ${waitH}h)`);
    return;                                               // already alerted recently, same issues
  }
  // Dry run: exercise the whole alert DECISION without sending mail. An alerting
  // rule you cannot run in a test is a rule nobody can trust.
  if (process.env.HEALTH_ALERT_DRYRUN) {
    console.log(`  DRYRUN would email — ${failed.length} failing, changed=${changed}, repeat #${repeats}, window ${waitH}h, sig="${sig}"`);
    status.alertSig = sig; status.alertAt = new Date().toISOString();
    status.alertRepeats = changed ? 0 : repeats + 1;
    return;
  }
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
        Each line above states the cause. "HARVESTER STALLED" means our cron/SFTP failed (fix our side);
        "SOURCE DARK" means the upstream county stopped publishing (chase them). A source merely lagging
        its normal cadence shows as a non-paging WARN on the status page, not here. Endpoint timeouts
        measured while the BOX is saturated and title-records is healthy are recorded on the status
        page as BOX SATURATED and do NOT appear here — that is an infra decision, not a title bug.</p>
        <p style="color:#64748b;font-size:13px">Box at check time: ${box ? evDesc(box) : 'unavailable'}.<br>
        ${changed ? 'New failure signature.' : `Unchanged signature — next reminder in ${REPEAT_BACKOFF_H[Math.min(repeats + 1, REPEAT_BACKOFF_H.length - 1)]}h (backing off).`}</p>
      </div>`,
    });
    status.alertSig = sig; status.alertAt = new Date().toISOString(); status.alertSent = true;
    status.alertRepeats = changed ? 0 : repeats + 1;
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

// Attribute endpoint/discovery failures to the BOX where the evidence supports it.
// These stay visible on /api/health as failures — nothing is hidden, and the detail
// carries the numbers — but they do not page, because "8 checks failing" is not the
// actionable sentence. "The box is oversubscribed at 06:00" is, and that only needs
// saying once, which is what the chronic escalation below does.
const box = await boxEvidence();
const saturated = isBoxSaturated(box);
let satCount = 0;
if (saturated) {
  for (const r of results) {
    // Only calls that NEVER LANDED can be blamed on the box. A check that got a
    // real response and disliked it (empty result, wrong owner) is a data problem
    // and must still page, however busy the box happens to be.
    if ((r.cat === 'endpoint' || r.cat === 'discovery') && !r.pass && r.transport) {
      r.level = 'saturated';
      r.detail = `${r.detail} — BOX SATURATED (${evDesc(box)}); not a title fault`;
      satCount++;
    }
  }
}

const failed = results.filter(r => !r.pass);
const warned = results.filter(r => r.level === 'warn');
const status = { checkedAt: new Date().toISOString(), ok: failed.length === 0, passed: results.length - failed.length - warned.length, warned: warned.length, failed: failed.length, box, results };

// The saturation clock. This must survive RECOVERY, not just persistence: the real
// pattern here is a brownout that recurs every morning and is gone by midday. A
// naive "continuously true for N days" clock resets at the first clean run and
// therefore never escalates — the condition would stay invisible precisely because
// it keeps recovering. So the clock starts at the first sighting, counts how often
// it recurs, and is only cleared once the box has been clean for a full quiet period.
let prevStatus = {};
try { prevStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
const satOnly = satCount > 0 && failed.length === satCount;
const prevLastAt = prevStatus.saturatedLastAt ? Date.parse(prevStatus.saturatedLastAt) : 0;
const goneFor = prevLastAt ? (now - prevLastAt) / 86400000 : Infinity;
if (satOnly) {
  status.saturatedSince = prevStatus.saturatedSince || new Date().toISOString();
  status.saturatedLastAt = new Date().toISOString();
  status.saturatedRuns = (prevStatus.saturatedRuns || 0) + 1;
} else if (goneFor <= SAT_CHRONIC_DAYS) {
  // A clean run does NOT mean it is over — carry the clock through the recovery.
  status.saturatedSince = prevStatus.saturatedSince || null;
  status.saturatedLastAt = prevStatus.saturatedLastAt || null;
  status.saturatedRuns = prevStatus.saturatedRuns || 0;
} else {
  status.saturatedSince = null; status.saturatedLastAt = null; status.saturatedRuns = 0;
}

const pageable = failed.filter(r => r.level !== 'saturated');
// A chronic brownout DOES deserve one page — it is an infra decision that has been
// true for days, and the right email says that in one line rather than as N failing
// checks. Backoff (above) then keeps it from becoming daily noise all over again.
if (satOnly && status.saturatedSince) {
  const satDays = (now - Date.parse(status.saturatedSince)) / 86400000;
  if (satDays >= SAT_CHRONIC_DAYS) {
    pageable.push({ cat: 'box', name: 'BOX SATURATED (chronic)', pass: false, level: 'fail',
      detail: `${satCount} endpoint check(s) timed out under box load — and this has now recurred on `
            + `${status.saturatedRuns} run(s) across ${satDays.toFixed(1)}d. ${evDesc(box)}. `
            + `Every service on this box is affected, not just title. This is an infra decision `
            + `(stagger the cron herd, or move title to its own box), not a title bug.` });
  }
}

await maybeAlert(status, pageable, box);
try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2)); } catch {}

const warnNote = warned.length ? `, ${warned.length} WARN` : '';
const satNote = satCount ? ` [${satCount} BOX-SATURATED, not paging]` : '';
console.log(`\n=== Service Health — ${status.ok ? 'ALL OK' : failed.length + ' FAILING'}${warnNote}${satNote} (${status.passed}/${results.length}) ===`);
if (box.loadPerCore !== null) console.log(`box: ${evDesc(box)}`);
let cat = '';
for (const r of results) { if (r.cat !== cat) { cat = r.cat; console.log(`\n[${cat}]`); } const tag = r.level === 'warn' ? 'WARN' : r.level === 'saturated' ? 'BOX ' : (r.pass ? 'PASS' : 'FAIL'); console.log(`  ${tag}  ${r.name.padEnd(34)} ${r.detail}`); }
if (warned.length) console.log(`\nWARN (not paging): ${warned.map(w => w.name).join(', ')}`);
if (satCount) console.log(`\nBOX SATURATED (not paging${satOnly ? '' : '; other real failures present'}): ${results.filter(r => r.level === 'saturated').map(r => r.name).join(', ')}`);
if (pageable.length) console.log(`\nPAGING: ${pageable.map(f => f.name).join(', ')}`);
if (failed.length) { console.log(`\nFAILING: ${failed.map(f => f.name).join(', ')}`); process.exit(1); }
console.log('\nService is operational and all datasets are fresh.');
