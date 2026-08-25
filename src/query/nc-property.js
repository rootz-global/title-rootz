/**
 * AI_CONTEXT: North Carolina property intelligence — Chatham County (FIPS 37037)
 *
 * Mirrors oh-property.js but reads the Chatham County CAMA dataset and enriches
 * with the county's own sales/improvements layers and Register-of-Deeds recorded
 * instruments (mortgages, satisfactions, foreclosure recordings).
 *
 * IMPORTANT: paths come from src/lib/config.js (DATA_DIR), NOT a local
 * __dirname/data join — on the server data/ is a symlinked sibling of src/.
 *
 * Data (data/nc/chatham/, produced by pull-chatham.mjs + scrape-chatham-rod.mjs):
 *   cama-parcels.jsonl          49,081  tax parcels (the spine)
 *   property-sales.jsonl        25,052  real sale prices
 *   property-improvements.jsonl 57,340  structures (beds/baths/yr)
 *   rod-instruments.jsonl        ~2.8K  recorded deeds/deeds-of-trust/satisfactions
 *
 * Exports:
 *   lookupNCByAddress(address, city)        — find Chatham parcel(s) by address
 *   assembleNCPropertyIntelligence(addr,city) — full property package (orchestrator)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { DATA_DIR } from '../lib/config.js';

const NC_DIR = path.join(DATA_DIR, 'nc', 'chatham');
const CAMA_FILE = path.join(NC_DIR, 'cama-parcels.jsonl');

// ─── helpers ──────────────────────────────────────────────────────
const up = s => (s == null ? '' : String(s)).toUpperCase().trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Coerce upstream GIS values before string ops — columns are not type-stable.
const str = v => (v === null || v === undefined ? '' : String(v).trim());
const SUF = { ROAD:'RD', STREET:'ST', DRIVE:'DR', LANE:'LN', AVENUE:'AVE', COURT:'CT',
  CIRCLE:'CIR', BOULEVARD:'BLVD', PLACE:'PL', TRAIL:'TRL', HIGHWAY:'HWY', PARKWAY:'PKWY' };
const normStreet = s => up(s).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).map(w => SUF[w] || w).filter(Boolean).join(' ').trim();
const stateFromCsz = csz => { const m = up(csz).match(/,?\s*([A-Z]{2})\s*\d{5}/); return m ? m[1] : ''; };

async function fetchJSON(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try { const r = await fetch(url, { signal: ctrl.signal }); return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}

// ─── statewide NC OneMap (all 99 other counties) ──────────────────
// Chatham has the deep county-CAMA build above; every other NC county is served
// from the standardized NC OneMap layer (data/nc/onemap/<county>.jsonl).
const ONEMAP_DIR = path.join(DATA_DIR, 'nc', 'onemap');
const countyKey = c => up(c).replace(/[^A-Z0-9]/g, '').toLowerCase();
const oneMapFile = c => path.join(ONEMAP_DIR, countyKey(c) + '.jsonl');
export const hasCounty = c => countyKey(c) === 'chatham' || fs.existsSync(oneMapFile(c));

const CORP_RE = /\b(LLC|L L C|INC|CORP|LTD|COMPANY|HOLDINGS|PROPERTIES|PARTNERS|LP|ENTERPRISES|GROUP|INVESTMENTS|CAPITAL|REALTY|DEVELOPMENT|HOMES|BUILDERS)\b/;
const TRUST_RE = /\b(TRUST|TRUSTEE|TTEE|ESTATE|HEIRS|LIFE ESTATE|REVOCABLE|LIVING TRUST)\b/;

// mailadd is a combined string e.g. "217 DEE FARRELL RD  PITTSBORO, NC  27312-9747"
const mailStreetOf = m => normStreet(String(m || '').split(/\s{2,}|,/)[0]);
const mailStateOf = m => { const x = String(m || '').toUpperCase().match(/,?\s*([A-Z]{2})\s+\d{5}/); return x ? x[1] : ''; };

function oneMapSignalsAndScore(r) {
  const owner = up(r.ownname || r.ownname2);
  const situs = normStreet(r.siteadd);
  const mStreet = mailStreetOf(r.mailadd);
  const mState = r.mstate || mailStateOf(r.mailadd);
  const bldg = num(r.improvval), par = num(r.parval), acres = num(r.gisacres);
  const signals = []; let score = 0;
  if (bldg === 0 && par > 0) { signals.push('Vacant Land'); score += 2; }
  if (/^\d/.test(mStreet) && /^\d/.test(situs) && mStreet !== situs) { signals.push('Absentee Owner'); score += 2; }
  if (mState && mState !== 'NC') { signals.push(`Out-of-State Owner (${mState})`); score += 2; }
  if (CORP_RE.test(owner)) { signals.push('Corporate/LLC Owner'); score += 1; }
  if (TRUST_RE.test(owner)) { signals.push('Trust/Estate/Heirs'); score += 2; }
  if (acres >= 10) { signals.push(`Large Acreage (${acres.toFixed(1)} ac)`); score += 1; }
  if (par >= 750000) score += 1;
  return { signals, score };
}

function oneMapToRow(r) {
  const { signals, score } = oneMapSignalsAndScore(r);
  return {
    // str(), not `(x || '').trim()`: these are raw ArcGIS columns whose types
    // are not guaranteed. A numeric value makes .trim() throw and 500s the
    // whole endpoint — that is how FL search went down when an upstream road
    // export started sending CONSTDATE as a number.
    parcelId: r.parno || '', owner: str(r.ownname),
    siteAddress: str(r.siteadd), community: r.scity || r.cntyname || '',
    mailAddress: str(r.mailadd), mailCSZ: [r.mcity, r.mstate, r.mzip].filter(Boolean).join(' ').trim(),
    mailState: r.mstate || mailStateOf(r.mailadd), county: r.cntyname,
    landUse: '', acres: num(r.gisacres) || null,
    totalFMV: num(r.parval) || null, landFMV: num(r.landval) || null, bldgFMV: num(r.improvval),
    assessedTotal: num(r.parval) || null, yearBuilt: num(r.structyear) || null,
    lastSaleDate: r.saledatetx || '', deedBookPage: '',
    vacant: num(r.improvval) === 0 && num(r.parval) > 0,
    absentee: signals.includes('Absentee Owner'), signals, score,
  };
}

// farm a single OneMap county (Wake, Mecklenburg, …)
function farmOneMapCounty(county, opts) {
  const file = oneMapFile(county);
  if (!fs.existsSync(file)) return null;
  const minScore = num(opts.minScore) || 3, minValue = num(opts.minValue), maxValue = num(opts.maxValue), minAcres = num(opts.minAcres);
  const want = (opts.signals || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const row = oneMapToRow(r);
    if (row.score < minScore) continue;
    if (minValue && (row.totalFMV || 0) < minValue) continue;
    if (maxValue && (row.totalFMV || 0) > maxValue) continue;
    if (minAcres && (row.acres || 0) < minAcres) continue;
    if (want.length) { const sl = row.signals.join(' ').toLowerCase(); if (!want.every(w => sl.includes(w))) continue; }
    out.push(row);
  }
  out.sort((a, b) => (b.score - a.score) || ((b.totalFMV || 0) - (a.totalFMV || 0)));
  return out; // full sorted set; caller slices to limit
}

// find a parcel in an OneMap county by address (grep the county file)
function oneMapSearch(county, address) {
  const file = oneMapFile(county);
  if (!fs.existsSync(file)) return [];
  const addrUp = up(address).replace(/[^A-Z0-9 ]/g, '').trim();
  if (!addrUp) return [];
  const parts = addrUp.match(/^(\d+)\s+(.+)$/);
  const pattern = (parts ? `${parts[1]} ${parts[2]}` : addrUp).substring(0, 40);
  const safe = pattern.replace(/[[\](){}.*+?^$|\\]/g, '\\$&').replace(/\s+/g, ' +');
  try {
    const out = execSync(`grep -iE '${safe}' "${file}" | head -10`, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }).toString();
    return out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { if (e.status !== 1) console.error(`OneMap grep error: ${e.message}`); return []; }
}

// ─── property imagery ─────────────────────────────────────────────
// Chatham publishes no property photos, so we frame a free Esri World Imagery
// aerial to the parcel's actual geometry (authoritative location), plus a
// Street View link. Postcard-ready image URL, no API key required.
const CAMA_LAYER = 'https://gisservices.chathamcountync.gov/opendataagol/rest/services/Cadastral/Chatham_CamaParcels/MapServer/0';
async function getParcelImagery(parcelNumber, lat, lng) {
  let bbox = null, centroid = (lat && lng) ? { lat, lng } : null;
  const q = new URLSearchParams({ where: `parcel_number='${parcelNumber}'`, returnGeometry: 'true', outSR: '4326', outFields: 'parcel_number', f: 'json' });
  const data = await fetchJSON(`${CAMA_LAYER}/query?${q}`);
  const rings = data?.features?.[0]?.geometry?.rings;
  if (rings) {
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const ring of rings) for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const padX = (maxX - minX) * 0.20 || 0.0008, padY = (maxY - minY) * 0.20 || 0.0008;
    bbox = `${minX - padX},${minY - padY},${maxX + padX},${maxY + padY}`;
    centroid = { lat: (minY + maxY) / 2, lng: (minX + maxX) / 2 };
  } else if (centroid) {
    const d = 0.0009;
    bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`;
  }
  if (!bbox) return null;
  return {
    aerial: `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=640,480&format=jpg&f=image`,
    aerialSource: 'Esri World Imagery (parcel-framed)',
    streetViewLink: centroid ? `https://www.google.com/maps?q=&layer=c&cbll=${centroid.lat},${centroid.lng}` : null,
    mapLink: centroid ? `https://www.google.com/maps/search/?api=1&query=${centroid.lat},${centroid.lng}` : null,
    note: 'Chatham County publishes no assessor photo; aerial is framed to the parcel boundary.'
  };
}

// ─── lazy in-memory side indexes (sales + improvements + ROD) ──────
let _sales = null, _impr = null, _rod = null;
function loadIndex(file, keyField) {
  const fp = path.join(NC_DIR, file);
  const map = new Map();
  if (!fs.existsSync(fp)) return map;
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); const k = up(r[keyField] || r.parcel_number); if (k) (map.get(k) || map.set(k, []).get(k)).push(r); } catch {}
  }
  return map;
}
function salesFor(pid) {
  if (!_sales) _sales = loadIndex('property-sales.jsonl', 'parcel_Number');
  const arr = _sales.get(up(pid)) || [];
  return arr.sort((a, b) => num(b.date_of_sale) - num(a.date_of_sale))[0] || null;
}
function imprFor(pid) {
  if (!_impr) _impr = loadIndex('property-improvements.jsonl', 'parcel_Number');
  const arr = _impr.get(up(pid)) || [];
  return arr.sort((a, b) => num(b.structure_value) - num(a.structure_value))[0] || null;
}
// OCR'd mortgage data (rod-mortgages.jsonl, produced by ocr-chatham-mortgages.mjs)
// keyed by parcel_number — actual loan amount + lender from the recorded deed of trust.
let _mtg = null;
function mortgageFor(parcelNumber) {
  if (!_mtg) {
    _mtg = new Map();
    const fp = path.join(NC_DIR, 'rod-mortgages.jsonl');
    if (fs.existsSync(fp)) for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.parcelNumber) _mtg.set(up(m.parcelNumber), m); } catch {}
    }
  }
  return _mtg.get(up(parcelNumber)) || null;
}

// ROD recorded instruments joined to a parcel by current deed book/page
const normBook = b => up(b).replace(/^0+/, '');
const normPage = p => String(p || '').replace(/^0+/, '');
function rodForBookPage(book, page) {
  if (!_rod) {
    _rod = new Map();
    const fp = path.join(NC_DIR, 'rod-instruments.jsonl');
    if (fs.existsSync(fp)) for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); _rod.set(`${normBook(r.book)}/${normPage(r.page)}`, r); } catch {}
    }
  }
  return _rod.get(`${normBook(book)}/${normPage(page)}`) || null;
}

// ─── address lookup (grep the single-county CAMA file) ────────────
function searchByAddress(address, city) {
  if (!fs.existsSync(CAMA_FILE)) return [];
  const addrUp = up(address).replace(/[^A-Z0-9 ]/g, '').trim();
  if (!addrUp) return [];
  const parts = addrUp.match(/^(\d+)\s+(.+)$/);
  const pattern = (parts ? `${parts[1]} ${parts[2]}` : addrUp).substring(0, 40);
  // Chatham situs addresses use a double space after the house number
  // ("1300  RIVER FOREST RD"), so match runs of whitespace tolerantly (ERE).
  const safe = pattern.replace(/[[\](){}.*+?^$|\\]/g, '\\$&').replace(/\s+/g, ' +');
  try {
    const out = execSync(`grep -iE '${safe}' "${CAMA_FILE}" | head -10`, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }).toString();
    return out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { if (e.status !== 1) console.error(`NC grep error: ${e.message}`); return []; }
}

export async function lookupNCByAddress(address, city = '') {
  const recs = searchByAddress(address, city);
  if (!recs.length) return [];
  // geocode the first hit
  const p = recs[0];
  const full = `${p.physical_street_address}, ${city || 'Pittsboro'}, NC`;
  let lat = null, lng = null;
  const data = await fetchJSON(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(full)}&benchmark=Public_AR_Current&format=json`);
  const m = data?.result?.addressMatches?.[0];
  if (m) { lat = m.coordinates.y; lng = m.coordinates.x; }
  return recs.map((r, i) => ({ ...r, lat: i === 0 ? lat : null, lng: i === 0 ? lng : null }));
}

// ─── investor / farming signals (mirror of build-chatham-list.mjs) ─
const CORP = /\b(LLC|L L C|INC|CORP|LTD|COMPANY|HOLDINGS|PROPERTIES|PARTNERS|LP|ENTERPRISES|GROUP|INVESTMENTS|CAPITAL|REALTY|DEVELOPMENT|HOMES|BUILDERS)\b/;
const TRUST = /\b(TRUST|TRUSTEE|TTEE|ESTATE|HEIRS|LIFE ESTATE|REVOCABLE|LIVING TRUST)\b/;

function ncSignals(p) {
  const owner = up(p.current_owners || p.jan1_owners);
  const mailStreet = normStreet(p.address1), situs = normStreet(p.physical_street_address);
  const mailState = stateFromCsz(p.csz);
  const bldgFMV = num(p.jan1_bldg_FMV);
  const signals = [];
  if (bldgFMV === 0) signals.push('Vacant Land');
  if (/^\d/.test(mailStreet) && /^\d/.test(situs) && mailStreet !== situs) signals.push('Absentee Owner');
  if (mailState && mailState !== 'NC') signals.push(`Out-of-State Owner (${mailState})`);
  if (CORP.test(owner)) signals.push('Corporate/LLC Owner');
  if (TRUST.test(owner)) signals.push('Trust/Estate/Heirs');
  if (num(p.current_puv_deferred) > 0 || num(p.jan1_puv_deferred) > 0) signals.push('AG/Forestry PUV Deferred');
  if (num(p.gross_current_acres) >= 10) signals.push(`Large Acreage (${num(p.gross_current_acres).toFixed(1)} ac)`);
  return signals;
}

// ─── farming list (motivated sellers) ────────────────────────────
// Reads the pre-scored chatham-enriched.jsonl and filters/sorts. Powers the
// "create a motivated seller list in Chatham focused on X" prompt.
export function farmNC(opts = {}) {
  // Non-Chatham county -> statewide NC OneMap data (scored on the fly).
  if (opts.county && countyKey(opts.county) !== 'chatham') {
    const rows = farmOneMapCounty(opts.county, opts);
    if (rows === null) return { county: opts.county, state: 'NC', total: 0, results: [], note: `${opts.county} County not loaded` };
    const limit = Math.min(num(opts.limit) || 50, 500);
    const want = (opts.signals || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return {
      county: opts.county, state: 'NC',
      criteria: { minScore: num(opts.minScore) || 3, signals: want, minValue: num(opts.minValue) || null, maxValue: num(opts.maxValue) || null, minAcres: num(opts.minAcres) || null },
      total: rows.length, returned: Math.min(rows.length, limit), source: 'NC OneMap statewide layer',
      results: rows.slice(0, limit).map(r => ({
        parcelId: r.parcelId, owner: r.owner, siteAddress: r.siteAddress, community: r.community,
        mailingAddress: r.mailAddress, mailingCSZ: r.mailCSZ, ownerState: r.mailState,
        landUse: r.landUse, acres: r.acres, value: r.totalFMV, assessedValue: r.assessedTotal,
        yearBuilt: r.yearBuilt, lastSaleDate: r.lastSaleDate, deedBookPage: r.deedBookPage,
        vacant: r.vacant, absentee: r.absentee, score: r.score, signals: r.signals
      }))
    };
  }
  const file = path.join(NC_DIR, 'chatham-enriched.jsonl');
  if (!fs.existsSync(file)) return { county: 'Chatham', state: 'NC', total: 0, results: [], note: 'list not built yet' };
  const minScore = num(opts.minScore) || 3;
  const minValue = num(opts.minValue), maxValue = num(opts.maxValue), minAcres = num(opts.minAcres);
  const limit = Math.min(num(opts.limit) || 50, 500);
  const townU = up(opts.town);
  const wantSignals = (opts.signals || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if ((r.score || 0) < minScore) continue;
    if (minValue && (r.totalFMV || 0) < minValue) continue;
    if (maxValue && (r.totalFMV || 0) > maxValue) continue;
    if (minAcres && (r.acres || 0) < minAcres) continue;
    if (townU && !(up(r.community).includes(townU) || up(r.mailCSZ).includes(townU) || up(r.siteAddress).includes(townU))) continue;
    if (wantSignals.length) {
      const sl = (r.signals || []).join(' ').toLowerCase();
      if (!wantSignals.every(w => sl.includes(w))) continue;
    }
    out.push(r);
  }
  out.sort((a, b) => (b.score - a.score) || ((b.totalFMV || 0) - (a.totalFMV || 0)));
  return {
    county: 'Chatham', state: 'NC',
    criteria: { minScore, town: opts.town || null, signals: wantSignals, minValue: minValue || null, maxValue: maxValue || null, minAcres: minAcres || null },
    total: out.length, returned: Math.min(out.length, limit),
    results: out.slice(0, limit).map(r => ({
      parcelId: r.parcelId, owner: r.owner, siteAddress: r.siteAddress, community: r.community,
      mailingAddress: r.mailAddress, mailingCSZ: r.mailCSZ, ownerState: r.mailState,
      landUse: r.landUse, acres: r.acres, value: r.totalFMV, assessedValue: r.assessedTotal,
      yearBuilt: r.yearBuilt, lastSaleDate: r.lastSaleDate, lastSalePrice: r.lastSalePrice,
      deedBookPage: r.deedBookPage, vacant: r.vacant, absentee: r.absentee,
      score: r.score, signals: r.signals, ownerLookup: r.ownerSearchUrl
    }))
  };
}

export function farmNCtoCSV(data) {
  const cols = ['score', 'parcelId', 'owner', 'siteAddress', 'community', 'mailingAddress', 'mailingCSZ', 'ownerState', 'landUse', 'acres', 'value', 'assessedValue', 'yearBuilt', 'lastSaleDate', 'lastSalePrice', 'deedBookPage', 'vacant', 'absentee', 'signals', 'ownerLookup'];
  const esc = v => { if (v == null) return ''; if (Array.isArray(v)) v = v.join(' | '); v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [cols.join(',')].concat((data.results || []).map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
}

// ─── OneMap single-property assembly (non-Chatham counties) ───────
async function assembleOneMapProperty(county, address, timestamp) {
  const recs = oneMapSearch(county, address);
  if (!recs.length) return { error: `Property not found: ${address}, ${county} County, NC`, timestamp };
  const r = recs[0];
  const row = oneMapToRow(r);
  let lat = null, lng = null;
  const g = await fetchJSON(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(`${r.siteadd}, ${r.scity || county}, NC`)}&benchmark=Public_AR_Current&format=json`);
  const m = g?.result?.addressMatches?.[0];
  if (m) { lat = m.coordinates.y; lng = m.coordinates.x; }
  let flood = null;
  if (lat && lng) {
    const fz = await fetchJSON(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,SFHA_TF&f=json`);
    const a = fz?.features?.[0]?.attributes;
    if (a) flood = { zone: a.FLD_ZONE, specialFloodHazard: a.SFHA_TF === 'T' };
  }
  const d = 0.0009;
  const photo = (lat && lng) ? {
    aerial: `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&bboxSR=4326&imageSR=4326&size=640,480&format=jpg&f=image`,
    aerialSource: 'Esri World Imagery', streetViewLink: `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}`, mapLink: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
  } : null;
  const ownerLookup = up(row.owner).replace(/[^A-Z ]/g, '').trim().length > 3
    ? `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(row.owner.replace(/[^a-zA-Z ]/g, '').trim())}&citystatezip=${encodeURIComponent((r.scity || county) + ' NC')}` : null;
  const sources = ['NC OneMap statewide parcel layer'];
  if (flood) sources.push('FEMA NFHL');
  let confidence = 0.55; if (lat && lng) confidence += 0.10; if (row.totalFMV) confidence += 0.05;
  confidence = Math.min(1, Math.round(confidence * 100) / 100);
  return {
    origin: {
      version: '0.5', state: 'NC', county: r.cntyname, propertyId: `NC-${countyKey(county).toUpperCase()}-${row.parcelId}`,
      assembledDate: timestamp, sources, dataLayers: sources.length, confidence,
      documentHash: crypto.createHash('sha256').update(JSON.stringify({ pid: row.parcelId, owner: row.owner, situs: row.siteAddress, fmv: row.totalFMV, signals: row.signals })).digest('hex')
    },
    property: {
      address: row.siteAddress, city: r.scity || r.cntyname, state: 'NC', parcelId: row.parcelId,
      coordinates: lat && lng ? { lat, lng } : null,
      owner: { name1: row.owner, priorJan1: '' },
      mailing: { address: row.mailAddress, csz: row.mailCSZ },
      lot: { acres: row.acres },
      classification: { landUse: '', zoning: '', neighborhood: r.scity || '', water: '', sewer: '', puvDeferred: false },
      building: row.yearBuilt ? { yearBuilt: row.yearBuilt, beds: null, baths: null, sqft: null, condition: '' } : null,
      values: { marketTotal: row.totalFMV, marketLand: row.landFMV, marketBuilding: row.bldgFMV, assessedTotal: row.assessedTotal },
      lastSale: row.lastSaleDate ? { date: row.lastSaleDate, price: null, vacantLand: row.vacant, newConstruction: false } : null,
      deed: { book: '', page: '', recordedInstrument: null }, mortgage: null, photo
    },
    flood: flood || { zone: 'UNKNOWN' }, elevation: null,
    investorSignals: { flags: row.signals, flagCount: row.signals.length, ownerLookupUrl: ownerLookup },
    notes: 'NC OneMap statewide layer (owner, mailing, value, acreage). Sales history + recorded mortgages are available only in deep-build counties (e.g. Chatham).'
  };
}

// ─── full assembly ────────────────────────────────────────────────
export async function assembleNCPropertyIntelligence(address, city = '', county = '') {
  const timestamp = new Date().toISOString();
  if (county && countyKey(county) !== 'chatham') return assembleOneMapProperty(county, address, timestamp);
  const props = await lookupNCByAddress(address, city);
  if (!props.length) return { error: `Property not found: ${address}, ${city}, NC (Chatham County)`, timestamp };
  const p = props[0];
  const lat = p.lat, lng = p.lng;
  const sale = salesFor(p.parcel_number);
  const impr = imprFor(p.parcel_number);
  const deed = rodForBookPage(p.current_book, p.current_page); // recorded instrument for this parcel's deed

  // FEMA flood (nationwide) + USGS elevation
  let flood = null, elevation = null;
  if (lat && lng) {
    const fz = await fetchJSON(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,SFHA_TF,STATIC_BFE&f=json`);
    const a = fz?.features?.[0]?.attributes;
    if (a) flood = { zone: a.FLD_ZONE, specialFloodHazard: a.SFHA_TF === 'T', baseFloodElevation: a.STATIC_BFE > 0 ? a.STATIC_BFE : null };
    const el = await fetchJSON(`https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&wkid=4326&units=Feet`);
    if (el?.value) elevation = { elevationFt: Math.round(el.value * 100) / 100, source: 'USGS 3DEP' };
  }

  const imagery = await getParcelImagery(p.parcel_number, lat, lng);
  const mortgage = mortgageFor(p.parcel_number); // OCR'd deed-of-trust, if processed
  const signals = ncSignals(p);
  if (mortgage?.loanAmount) signals.push(`Mortgage on record ($${Number(mortgage.loanAmount).toLocaleString()} ${mortgage.lender || ''})`.trim());
  const owner = str(p.current_owners || p.jan1_owners);
  const ownerLookup = up(owner).replace(/[^A-Z ]/g, '').trim().length > 3
    ? `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(owner.replace(/[^a-zA-Z ]/g, '').trim())}&citystatezip=${encodeURIComponent(p.csz || 'Pittsboro NC')}`
    : null;

  const sources = ['Chatham County CAMA (ArcGIS)'];
  if (sale) sources.push('Chatham PropertySales');
  if (impr) sources.push('Chatham PropertyImprovements');
  if (deed) sources.push('Chatham Register of Deeds');
  if (flood) sources.push('FEMA NFHL');
  if (elevation) sources.push('USGS 3DEP');

  let confidence = 0.55;
  if (lat && lng) confidence += 0.10;
  if (sale?.gross_selling_price) confidence += 0.05;
  if (impr?.year_built) confidence += 0.05;
  if (num(p.jan1_total_FMV)) confidence += 0.05;
  if (deed) confidence += 0.05;
  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  return {
    origin: {
      version: '0.5', state: 'NC', county: 'Chatham',
      propertyId: `NC-CHAT-${p.parcel_number}`,
      assembledDate: timestamp, sources, dataLayers: sources.length, confidence,
      // content hash over the parcel's core facts — provenance anchor for the bridge page
      documentHash: crypto.createHash('sha256').update(JSON.stringify({
        pid: p.parcel_number, owner, situs: p.physical_street_address,
        fmv: num(p.jan1_total_FMV), deed: `${p.current_book}/${p.current_page}`, signals
      })).digest('hex')
    },
    property: {
      address: str(p.physical_street_address),
      city: city || p.community_name || 'Chatham County', state: 'NC',
      parcelId: p.parcel_number,
      coordinates: lat && lng ? { lat, lng } : null,
      owner: { name1: p.current_owners || p.jan1_owners || '', priorJan1: p.jan1_owners || '' },
      mailing: { address: [p.address1, p.address2].filter(Boolean).join(' ').trim(), csz: p.csz || '' },
      lot: { acres: num(p.gross_current_acres) || null },
      classification: { landUse: p.land_use || '', zoning: p.zoning || '', neighborhood: p.neighborhood_desc || '',
        water: p.WaterUtilityType || '', sewer: p.SanitaryUtilityType || '', puvDeferred: num(p.current_puv_deferred) > 0 },
      building: impr ? { yearBuilt: num(impr.year_built) || null, beds: num(impr.Bedrooms) || null,
        baths: num(impr.Bathrooms) || null, sqft: num(impr.gross_living_area) || null, condition: impr.condition_desc || '' } : null,
      values: {
        marketTotal: num(p.jan1_total_FMV) || null, marketLand: num(p.jan1_land_FMV) || null, marketBuilding: num(p.jan1_bldg_FMV) || null,
        assessedTotal: num(p.jan1_total_ASV) || null
      },
      lastSale: sale ? { date: sale.date_of_sale ? new Date(num(sale.date_of_sale)).toISOString().slice(0, 10) : null,
        price: num(sale.gross_selling_price) || null, vacantLand: up(sale.vacant_land_yn) === 'Y', newConstruction: up(sale.new_const_yn) === 'Y' } : null,
      deed: { book: p.current_book || '', page: p.current_page || '',
        recordedInstrument: deed ? { type: deed.type, recDate: deed.recDate, description: deed.description } : null },
      mortgage: mortgage ? {
        loanAmount: mortgage.loanAmount, lender: mortgage.lender, isLineOfCredit: mortgage.isLineOfCredit,
        recordedDate: mortgage.recordedDate, equityEstimate: mortgage.equityEstimate,
        source: 'Register of Deeds — recorded deed of trust (OCR), actual figure'
      } : null,
      photo: imagery
    },
    flood: flood || { zone: 'UNKNOWN' },
    elevation,
    investorSignals: { flags: signals, flagCount: signals.length, ownerLookupUrl: ownerLookup },
    notes: 'Mortgage balances and certified foreclosure/probate require the Register of Deeds image or the NC AOC Remote Public Access license (not in assessor data).'
  };
}
