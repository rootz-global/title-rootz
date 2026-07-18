/**
 * Origin Title Records — Scraper Health Monitor
 *
 * Tracks the health of every data source. When something breaks,
 * we know immediately — which source, what changed, when it failed.
 *
 * This is the moat. Anyone can scrape once.
 * Nobody maintains 15+ scrapers across government sites that change without notice.
 *
 * Health checks:
 *   1. Can we reach the endpoint? (connectivity)
 *   2. Does it return expected data format? (schema)
 *   3. Did the record count change dramatically? (anomaly)
 *   4. Is the SSL cert still valid? (provenance)
 *   5. Did they block us? (rate limit / captcha detection)
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { withCensusKey } from './lib/census.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The repo nests these scripts under mcp-server/ (data lives at ../data) but the
// server deploys them flat into /var/www/title.rootz.global/ (data lives at
// ./data). Resolve whichever exists so the same file works in both layouts —
// hardcoding one silently wrote status to a path nobody reads.
const DATA_ROOT = fs.existsSync(path.join(__dirname, 'data'))
  ? path.join(__dirname, 'data')
  : path.join(__dirname, '..', 'data');
const MONITOR_FILE = path.join(DATA_ROOT, 'florida', 'monitor-status.json');

// ─── Data Sources to Monitor ──────────────────────────────────────
const SOURCES = {
  'mdc-gis-property': {
    name: 'Miami-Dade County GIS (Property Layer)',
    url: 'https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/24/query?where=1%3D1&returnCountOnly=true&f=json',
    type: 'arcgis',
    expectedMinCount: 900000,
    sslHost: 'gisweb.miamidade.gov',
    refreshSchedule: 'monthly',
    criticality: 'HIGH'
  },
  'mdc-permits-county': {
    name: 'Miami-Dade County Building Permits',
    url: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/BuildingPermit_gdb/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json',
    type: 'arcgis',
    expectedMinCount: 250000,
    sslHost: 'services.arcgis.com',
    refreshSchedule: 'weekly',
    criticality: 'HIGH'
  },
  'miami-city-permits': {
    name: 'City of Miami Building Permits',
    url: 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Building_Permits_Since_2014/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json',
    type: 'arcgis',
    expectedMinCount: 200000,
    sslHost: 'services1.arcgis.com',
    refreshSchedule: 'weekly',
    criticality: 'HIGH'
  },
  'mdc-schools': {
    name: 'Miami-Dade School Sites',
    url: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/SchoolSite_gdb/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json',
    type: 'arcgis',
    expectedMinCount: 400,
    sslHost: 'services.arcgis.com',
    refreshSchedule: 'monthly',
    criticality: 'MEDIUM'
  },
  'fema-flood': {
    name: 'FEMA National Flood Hazard Layer',
    url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28?f=json',
    type: 'arcgis-info',
    sslHost: 'hazards.fema.gov',
    refreshSchedule: 'annual',
    criticality: 'HIGH'
  },
  'census-acs': {
    name: 'US Census ACS API',
    // Keyless ACS requests 302 to missing_key.html, so this check reports ERROR
    // until CENSUS_API_KEY is set (and the cron passes --env-file=.env).
    url: withCensusKey('https://api.census.gov/data/2022/acs/acs5?get=B01003_001E&for=county:086&in=state:12'),
    type: 'census',
    sslHost: 'api.census.gov',
    refreshSchedule: 'annual',
    criticality: 'MEDIUM'
  },
  'census-geocoder': {
    name: 'Census Geocoder',
    url: 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=179+Harbor+Dr+Key+Biscayne+FL&benchmark=Public_AR_Current&vintage=Current_Current&format=json',
    type: 'census-geo',
    sslHost: 'geocoding.geo.census.gov',
    refreshSchedule: 'always',
    criticality: 'HIGH'
  },
  'accela-keybiscayne': {
    name: 'Key Biscayne Accela Portal',
    url: 'https://aca-prod.accela.com/keybiscayne/Default.aspx',
    type: 'html',
    expectedContent: 'Village of Key Biscayne',
    sslHost: 'aca-prod.accela.com',
    refreshSchedule: 'weekly',
    criticality: 'MEDIUM',
    needsPuppeteer: true
  }
};

// ─── Fetch with timeout ───────────────────────────────────────────
function fetchURL(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'Origin-Land-Records-Monitor/0.1' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          latencyMs: Date.now() - start
        });
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Check SSL Certificate ────────────────────────────────────────
function checkSSL(host) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port: 443, method: 'HEAD' }, (res) => {
      const cert = res.socket.getPeerCertificate();
      resolve({
        subject: cert.subject?.CN || 'unknown',
        issuer: cert.issuer?.O || 'unknown',
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        fingerprint: cert.fingerprint256?.substring(0, 32) || 'unknown',
        daysUntilExpiry: Math.floor((new Date(cert.valid_to) - new Date()) / (1000 * 60 * 60 * 24))
      });
      req.destroy();
    });
    req.on('error', e => reject(e));
    req.end();
  });
}

// ─── Check a Single Source ────────────────────────────────────────
async function checkSource(id, config) {
  const result = {
    id,
    name: config.name,
    timestamp: new Date().toISOString(),
    status: 'UNKNOWN',
    details: {}
  };

  try {
    // 1. Connectivity check
    const resp = await fetchURL(config.url);
    result.details.httpStatus = resp.status;
    result.details.latencyMs = resp.latencyMs;

    if (resp.status !== 200) {
      result.status = 'ERROR';
      result.details.error = `HTTP ${resp.status}`;
      return result;
    }

    // 2. Schema check — does it return expected format?
    if (config.type === 'arcgis') {
      try {
        const data = JSON.parse(resp.body);
        const count = data.count;
        result.details.recordCount = count;

        if (config.expectedMinCount && count < config.expectedMinCount * 0.5) {
          result.status = 'WARNING';
          result.details.warning = `Count ${count} is <50% of expected ${config.expectedMinCount}`;
        } else {
          result.status = 'OK';
        }
      } catch {
        result.status = 'ERROR';
        result.details.error = 'Invalid JSON response';
      }
    } else if (config.type === 'arcgis-info') {
      try {
        const data = JSON.parse(resp.body);
        result.details.layerName = data.name || 'unknown';
        result.status = data.name ? 'OK' : 'WARNING';
      } catch {
        result.status = 'ERROR';
        result.details.error = 'Invalid JSON';
      }
    } else if (config.type === 'census') {
      try {
        const data = JSON.parse(resp.body);
        result.details.rows = data.length;
        result.status = data.length > 1 ? 'OK' : 'WARNING';
      } catch {
        result.status = 'ERROR';
        result.details.error = 'Census API returned invalid data';
      }
    } else if (config.type === 'census-geo') {
      try {
        const data = JSON.parse(resp.body);
        const matches = data.result?.addressMatches?.length || 0;
        result.details.matchCount = matches;
        result.status = matches > 0 ? 'OK' : 'WARNING';
      } catch {
        result.status = 'ERROR';
      }
    } else if (config.type === 'html') {
      if (config.expectedContent && resp.body.includes(config.expectedContent)) {
        result.status = 'OK';
      } else if (resp.body.includes('captcha') || resp.body.includes('CAPTCHA') || resp.body.includes('blocked')) {
        result.status = 'BLOCKED';
        result.details.error = 'Possible CAPTCHA or block detected';
      } else {
        result.status = 'WARNING';
        result.details.warning = 'Expected content not found — page may have changed';
      }
    }

    // 3. SSL certificate check
    if (config.sslHost) {
      try {
        const ssl = await checkSSL(config.sslHost);
        result.details.ssl = ssl;
        if (ssl.daysUntilExpiry < 30) {
          result.details.sslWarning = `SSL cert expires in ${ssl.daysUntilExpiry} days!`;
        }
      } catch (e) {
        result.details.sslError = e.message;
      }
    }

  } catch (e) {
    result.status = 'DOWN';
    result.details.error = e.message;
  }

  return result;
}

// ─── Run All Checks ───────────────────────────────────────────────
async function runAllChecks() {
  const startTime = new Date();
  console.log(`Origin Title Records — Source Health Monitor`);
  console.log(`Started: ${startTime.toISOString()}`);
  console.log();

  const results = {};
  let okCount = 0, warnCount = 0, errCount = 0, downCount = 0;

  for (const [id, config] of Object.entries(SOURCES)) {
    const check = await checkSource(id, config);
    results[id] = check;

    const icon = { OK: '✓', WARNING: '⚠', ERROR: '✗', DOWN: '☠', BLOCKED: '🚫', UNKNOWN: '?' }[check.status] || '?';
    const extra = check.details.recordCount ? ` (${check.details.recordCount.toLocaleString()} records)` :
                  check.details.latencyMs ? ` (${check.details.latencyMs}ms)` : '';
    console.log(`  ${icon} [${check.status.padEnd(7)}] ${config.name}${extra}`);

    if (check.status === 'OK') okCount++;
    else if (check.status === 'WARNING') warnCount++;
    else if (check.status === 'ERROR') errCount++;
    else downCount++;
  }

  // Save results
  const report = {
    timestamp: startTime.toISOString(),
    duration: `${((Date.now() - startTime.getTime()) / 1000).toFixed(1)}s`,
    summary: { ok: okCount, warnings: warnCount, errors: errCount, down: downCount },
    sources: results
  };

  // Append to history (keep last 100 checks)
  let history = [];
  if (fs.existsSync(MONITOR_FILE)) {
    try { history = JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf-8')); } catch {}
  }
  history.push(report);
  if (history.length > 100) history = history.slice(-100);
  fs.writeFileSync(MONITOR_FILE, JSON.stringify(history, null, 2));

  console.log();
  console.log(`SUMMARY: ${okCount} OK, ${warnCount} warnings, ${errCount} errors, ${downCount} down`);
  console.log(`Report saved to ${MONITOR_FILE}`);

  // Return non-zero exit code if any critical source is down
  const criticalDown = Object.entries(results).some(([id, r]) =>
    SOURCES[id].criticality === 'HIGH' && (r.status === 'DOWN' || r.status === 'ERROR' || r.status === 'BLOCKED')
  );
  if (criticalDown) {
    console.log('\n⚠️  CRITICAL SOURCE DOWN — requires attention!');
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────
runAllChecks().catch(e => {
  console.error('Monitor failed:', e);
  process.exit(1);
});
