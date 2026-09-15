// Coverage manifest reader — answers "do we hold this, and at what depth?"
//
// Exists because `Property not found` is not an answer. It conflates four different
// facts: the county isn't in our coverage at all; we cover it but missed this address;
// we hold a few stray parcels under that city name which is not real coverage; or we
// cover it and the SOURCE doesn't carry the field you wanted — owner name and assessed
// value are absent for the 68 OGRIP counties by construction, at any price.
//
// A caller cannot act on the difference without being told which it is. Andy Detwiler
// hit this in August, asked which it was, and was right to. Most callers — and every
// AI — will record "no data" and move on, which is how an absence becomes a false fact
// downstream. Same discipline as the Broward freshness WARN: say whether it's us or them.
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

const MANIFEST = path.join(DATA_DIR, 'coverage-oh.json');
let cache = null, cacheMtime = 0;

export function ohCoverage() {
  try {
    const st = fs.statSync(MANIFEST);
    if (!cache || st.mtimeMs !== cacheMtime) {
      cache = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      cacheMtime = st.mtimeMs;
    }
    return cache;
  } catch { return null; }
}

// Must match how the city index keys files (pull-oh-ogrip.mjs safeCity).
const cityKey = (city) => String(city || '').toUpperCase().replace(/ /g, '_').replace(/[^A-Z0-9_]/g, '');

// Resolve a city the SAME way the query engine does, then aggregate. The engine tries
// the exact OH_CITY_OF_<city> file and otherwise every filename CONTAINING the city, so
// a city is a SET of index files, not one. Reporting one file's count as "what we hold"
// understated Springfield by three orders of magnitude in testing.
function resolveCity(city) {
  const m = ohCoverage();
  const key = cityKey(city);
  if (!m || !m.cities || !key) return null;
  const keys = Object.keys(m.cities);
  let hits = keys.filter(k => k === `CITY_OF_${key}`);
  if (!hits.length) hits = keys.filter(k => k.includes(key));
  if (!hits.length) return null;
  let n = 0; const srcs = new Set(), counties = new Set();
  for (const k of hits) {
    const [county, src, cnt] = m.cities[k];
    n += cnt; srcs.add(src); if (county) counties.add(county);
  }
  return {
    files: hits.length, parcels: n,
    src: srcs.size > 1 || srcs.has('mixed') ? 'mixed' : [...srcs][0],
    counties: [...counties],
  };
}

// A few stray parcels under a city name is NOT county coverage. Saying "we cover
// LORAIN — 3 parcels" about a county we do not hold is worse than saying nothing.
const WEAK_INDEX_MAX = 50;

export function ohIndexesCity(city) {
  const m = ohCoverage();
  if (!m || !m.cities) return null;   // no manifest: let the caller search, don't deny
  return resolveCity(city) !== null;
}

// Could this city plausibly hold records from `county`? null when unknown (no
// manifest, or the city resolves to files whose county we cannot attribute — CAMA
// rows carry no county, so "unknown" is common and must NOT be read as "no").
export function ohCityTouchesCounty(city, county) {
  const r = resolveCity(city);
  if (!r) return null;
  if (!r.counties.length) return null;      // unattributed (CAMA) — cannot rule out
  if (r.src !== 'ogrip') return null;       // mixed/CAMA present — cannot rule out
  return r.counties.includes(county);
}

export function ohCoverageSummary() {
  const m = ohCoverage();
  if (!m) return null;
  const counties = Object.values(m.counties || {});
  const full = counties.filter(c => c.depth === 'full');
  const shallow = counties.filter(c => c.depth !== 'full');
  return {
    state: 'OH',
    as_of: m.generatedAt,
    parcels: m.totals?.parcels ?? null,
    counties: counties.length,
    counties_in_state: m.totals?.ohio_counties_total ?? 88,
    counties_not_covered: m.uncovered_counties || [],
    depth: {
      full: {
        counties: full.length,
        parcels: full.reduce((n, c) => n + c.parcels, 0),
        has: ['situs_address', 'owner_name', 'mailing_address', 'land_use', 'assessed_value', 'sale_history'],
      },
      parcel_only: {
        counties: shallow.length,
        parcels: shallow.reduce((n, c) => n + c.parcels, 0),
        has: ['situs_address', 'parcel_id', 'land_use', 'acreage', 'mailing_address'],
        lacks: ['owner_name', 'assessed_value', 'sale_history'],
      },
    },
    caveat: 'Coverage is NOT uniform. Owner name and assessed value exist for the "full" counties only — the parcel_only counties come from the OGRIP statewide layer, which does not carry them at any price; each record links to the county CAMA page that does.',
  };
}

// Explain a miss. Returns null when there is no manifest to reason from — better to
// say nothing than to guess at whose gap it is.
export function explainOhMiss(address, city) {
  const m = ohCoverage();
  if (!m) return null;
  const state = {
    counties_covered: m.totals?.counties ?? null,
    counties_in_state: m.totals?.ohio_counties_total ?? 88,
    counties_not_covered: m.uncovered_counties || [],
    parcels: m.totals?.parcels ?? null,
  };

  if (!city) {
    return {
      gap: 'unknown', reason: 'no_city_given',
      explanation: 'Ohio parcels are indexed by city. Without a city we cannot tell whether this address is outside our coverage or simply unmatched. Re-query with city= for a definite answer.',
      state_coverage: state,
    };
  }

  const CITY = String(city).toUpperCase();
  const r = resolveCity(city);

  if (!r) {
    return {
      gap: 'ours', reason: 'city_not_indexed', city: CITY,
      explanation: `We hold no Ohio parcels indexed under "${CITY}". That is a gap in OUR coverage, not a county withholding data — we index ${state.counties_covered} of Ohio's ${state.counties_in_state} counties. Check state_coverage.counties_not_covered below; if this city's county is listed there, we have not loaded it.`,
      state_coverage: state,
    };
  }

  if (r.parcels <= WEAK_INDEX_MAX) {
    return {
      gap: 'ours', reason: 'weak_index', city: CITY,
      parcels_held_for_city: r.parcels, counties_seen: r.counties,
      explanation: `We hold only ${r.parcels} parcel(s) indexed under "${CITY}" — strays from neighbouring county data, not real coverage of that city. Treat this as NOT covered. We index ${state.counties_covered} of Ohio's ${state.counties_in_state} counties; see state_coverage.counties_not_covered.`,
      state_coverage: state,
    };
  }

  const legend = m.depth_legend || {};
  const d = legend[r.src === 'mixed' ? 'cama' : r.src] || {};
  const lacks = r.src === 'ogrip' ? (legend.ogrip?.lacks || []) : [];
  return {
    gap: 'ours', reason: 'address_not_matched', city: CITY,
    counties_seen: r.counties, depth: r.src === 'mixed' ? 'mixed' : (d.depth || null),
    parcels_held_for_city: r.parcels, index_files: r.files,
    has: d.has || null, lacks,
    // Do NOT assert a county. City -> county is many-to-many in this index: the
    // SPRINGFIELD key holds both Champaign and Clark records, and the LORAIN key
    // holds Erie records for a county we do not cover at all. Report the counties
    // OBSERVED and let state_coverage answer "is my county covered", rather than
    // naming one and being confidently wrong — which is the exact failure this
    // whole endpoint exists to stop.
    explanation: `We hold ${r.parcels.toLocaleString()} parcel(s) indexed under the city key "${CITY}" (${r.files} index file(s)`
      + (r.counties.length ? `, containing records from: ${r.counties.join(', ')}` : ', county not attributable — CAMA rows carry no county field')
      + `) and this address was not matched among them. So this is our index or the address form, not a county withholding data. NOTE: a city key is not a county — check state_coverage.counties_not_covered for whether YOUR county is held at all.`
      + (lacks.length ? ` Where these records come from the OGRIP statewide layer, the source does not carry ${lacks.join(' or ')} at all, so even a match would not return them.` : ''),
    state_coverage: state,
  };
}
