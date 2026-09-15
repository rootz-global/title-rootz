#!/usr/bin/env node
// Build the Ohio coverage manifest: which counties we hold, AT WHAT DEPTH, and how
// many parcels — derived from the data, never hand-maintained.
//
// WHY. /.well-known/ai claimed "1.2M Ohio parcels, 3 counties" long after we held
// 2.6M across 88, because that number was typed by a human once. And a miss returned
// only `Property not found`, so a caller could not tell whether the gap was ours or
// the county's. Andy Detwiler hit exactly that in August and had the presence of mind
// to ask which it was; most callers won't. An absence reported without provenance is
// the same defect as a freshness check that can't say whether the harvester or the
// source is broken — see the Broward WARN, which is the model to copy.
//
// DEPTH IS THE POINT. 5 counties come from per-county CAMA (owner + value). The other
// 83 come from the OGRIP statewide layer: situs address, land use, acreage, mailing
// address — but NO owner name and NO market value. Publishing "88 counties" without
// that distinction would be claiming more than we measured.
//
// Usage: node build-coverage.mjs [--out data/coverage-oh.json]
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.TITLE_DATA_DIR || path.join(__dirname, 'data');
const CITIES = path.join(DATA, 'ohio', 'cities');
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(DATA, 'coverage-oh.json');

// Field sets, stated per source so the manifest never implies more than the source has.
const DEPTH = {
  cama: {
    depth: 'full',
    has: ['situs_address', 'owner_name', 'mailing_address', 'land_use', 'assessed_value', 'sale_history'],
    lacks: [],
    note: 'Per-county CAMA extract: owner and assessed value present.',
  },
  ogrip: {
    depth: 'parcel-only',
    has: ['situs_address', 'parcel_id', 'land_use', 'acreage', 'mailing_address'],
    lacks: ['owner_name', 'assessed_value', 'sale_history'],
    note: 'OGRIP statewide parcel layer: breadth, not depth. Owner name and market value are NOT in this source; each record carries a _camaLink to the county record that has them.',
  },
};

// Ohio's 88 counties. Stable public fact, listed so "which counties are we MISSING"
// is derived rather than asserted. The plan and commit 704f7ad both claimed "all 88
// OH counties now covered"; the data says otherwise, and this is how that gets caught.
const OH_88 = ['Adams','Allen','Ashland','Ashtabula','Athens','Auglaize','Belmont','Brown','Butler','Carroll','Champaign','Clark','Clermont','Clinton','Columbiana','Coshocton','Crawford','Cuyahoga','Darke','Defiance','Delaware','Erie','Fairfield','Fayette','Franklin','Fulton','Gallia','Geauga','Greene','Guernsey','Hamilton','Hancock','Hardin','Harrison','Henry','Highland','Hocking','Holmes','Huron','Jackson','Jefferson','Knox','Lake','Lawrence','Licking','Logan','Lorain','Lucas','Madison','Mahoning','Marion','Medina','Meigs','Mercer','Miami','Monroe','Montgomery','Morgan','Morrow','Muskingum','Noble','Ottawa','Paulding','Perry','Pickaway','Pike','Portage','Preble','Putnam','Richland','Ross','Sandusky','Scioto','Seneca','Shelby','Stark','Summit','Trumbull','Tuscarawas','Union','Van Wert','Vinton','Warren','Washington','Wayne','Williams','Wood','Wyandot'];

// The per-county CAMA extracts. Their records carry NO county field — franklin's only
// county-ish key is FLOORCOUNT — so they cannot be attributed from the row itself.
// Count them from their source file instead, which is authoritative anyway.
const CAMA_COUNTIES = { franklin: 'Franklin', cuyahoga: 'Cuyahoga', hamilton: 'Hamilton', summit: 'Summit', montgomery: 'Montgomery' };

const counties = new Map();   // county -> { cama:n, ogrip:n, cities:Set }
const cities = new Map();     // CITYKEY -> { county, src, n }

function bump(county, src, cityKey) {
  if (!county) county = '(unknown)';
  let c = counties.get(county);
  if (!c) { c = { cama: 0, ogrip: 0, cities: new Set() }; counties.set(county, c); }
  c[src]++;
  if (cityKey) c.cities.add(cityKey);
}

// PASS 1 — CAMA counts, straight from the per-county source files. Authoritative,
// and the only way to attribute them since the rows carry no county.
console.log('counting per-county CAMA files…');
for (const [slug, name] of Object.entries(CAMA_COUNTIES)) {
  const fp = path.join(DATA, 'ohio', `${slug}-parcels.jsonl`);
  if (!fs.existsSync(fp)) { console.log(`  ${name}: no file — NOT counted as covered`); continue; }
  let rows = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows++;
  bump(name, 'cama', null);
  counties.get(name).cama = rows;
  console.log(`  ${name}: ${rows.toLocaleString()} (as of ${new Date(fs.statSync(fp).mtimeMs).toISOString().slice(0, 10)})`);
  counties.get(name).asOf = new Date(fs.statSync(fp).mtimeMs).toISOString().slice(0, 10);
}

// PASS 2 — OGRIP, from the city index. Prefilter on the substring so CAMA rows cost
// a string scan rather than a JSON.parse.
const files = fs.existsSync(CITIES)
  ? fs.readdirSync(CITIES).filter(f => f.startsWith('OH_') && f.endsWith('.jsonl'))
  : [];
console.log(`scanning ${files.length.toLocaleString()} city files…`);

let n = 0, t0 = Date.now(), seen = 0;
for (const f of files) {
  // Key by the FULL basename, not a stripped one. OH_SPRINGFIELD.jsonl and
  // OH_CITY_OF_SPRINGFIELD.jsonl are DIFFERENT files; stripping CITY_OF_ collapsed
  // them and the last one written silently won — which reported Clark County's
  // ~47,000 Springfield parcels as 40. The reader mirrors the query engine's own
  // resolution (exact CITY_OF_ match, else substring) and aggregates.
  const cityKey = f.replace(/^OH_/, '').replace(/\.jsonl$/, '');
  let cityOgrip = 0, cityCama = 0, cityCounty = '';
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(CITIES, f)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    n++;
    if (!line.includes('ohio-ogrip')) { cityCama++; continue; }
    let rec; try { rec = JSON.parse(line); } catch { continue }
    if (rec._src !== 'ohio-ogrip') { cityCama++; continue; }
    cityOgrip++;
    const county = rec.County || '';
    if (county) { bump(county, 'ogrip', cityKey); if (!cityCounty) cityCounty = county; }
  }
  if (cityOgrip || cityCama) {
    cities.set(cityKey, {
      county: cityCounty,
      src: cityOgrip && cityCama ? 'mixed' : (cityOgrip ? 'ogrip' : 'cama'),
      n: cityOgrip + cityCama,
    });
  }
  if (++seen % 20000 === 0) console.log(`  …${seen.toLocaleString()} files, ${n.toLocaleString()} rows`);
}

const out = {
  state: 'OH',
  generatedAt: new Date().toISOString(),
  totals: { parcels: n, counties: 0, cities: cities.size, ohio_counties_total: OH_88.length },
  depth_legend: DEPTH,
  counties: {},
  cities: {},
};

for (const [name, c] of [...counties.entries()].sort((a, b) => (b[1].cama + b[1].ogrip) - (a[1].cama + a[1].ogrip))) {
  if (!name || name === '(unknown)') continue;
  const src = c.cama && c.ogrip ? 'mixed' : (c.cama ? 'cama' : 'ogrip');
  const d = DEPTH[src === 'mixed' ? 'cama' : src];
  out.counties[name] = {
    source: src, depth: d.depth, parcels: c.cama + c.ogrip,
    // Per-county as-of. The directory-level freshness check cannot see this: it
    // watches data/ohio/cities, which is rebuilt weekly whether or not a given
    // county actually refreshed. Cuyahoga's county GIS has been 500-ing since
    // 2026-08-10 and nothing surfaced it.
    as_of: c.asOf || null,
    cama_parcels: c.cama, ogrip_parcels: c.ogrip,
    has: d.has, lacks: d.lacks, note: d.note,
  };
}
out.totals.counties = Object.keys(out.counties).length;
// Derived, not asserted. This is the line that would have caught "all 88 covered".
const coveredSet = new Set(Object.keys(out.counties));
out.uncovered_counties = OH_88.filter(c => !coveredSet.has(c));
out.totals.uncovered = out.uncovered_counties.length;
for (const [k, v] of cities) out.cities[k] = [v.county, v.src, v.n];

fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`\n${n.toLocaleString()} parcels | ${out.totals.counties} counties | ${cities.size.toLocaleString()} city keys`);
const full = Object.values(out.counties).filter(c => c.depth === 'full').length;
console.log(`depth: ${full} counties full (owner+value), ${out.totals.counties - full} parcel-only`);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)}MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
