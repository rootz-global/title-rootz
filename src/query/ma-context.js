// MA context queries — the things a buyer actually asks that a per-parcel lookup cannot answer.
//
// WHY THIS EXISTS. Everything in here was done BY HAND against MassGIS during a real
// diligence run on 135 Hart St, Beverly (2026-09-17), and every one of them was a
// single HTTP call against a service we were already using. The engine was built as a
// per-address lookup returning a fixed shape, so a question one field wider than that
// shape — "what else is on this street", "what else did this buyer take", "is this lot
// even conforming" — fell outside it and had to be done manually. That is the reason
// the service feels stuck: not missing data, missing *surface*.
//
// The Hart St run found, in four queries: the subject is the oldest house on a
// 115-parcel street; a developer LLC had assembled 8 contiguous parcels / 10.5 acres
// on one deed; and the mapped lot is ~1,400 sq ft SMALLER than the assessor's figure,
// straddling the zoning minimum. None of that is visible from a single-parcel lookup.
import { MASSGIS_URL } from '../lib/constants.js';
import { fetchJSON } from '../lib/fetch.js';

const MHC = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/MHC_Inventory_GDB/FeatureServer/1/query';

const q = async (where, outFields = '*', extra = '') => {
  const p = new URLSearchParams({ where, outFields, returnGeometry: 'false', f: 'json' });
  const d = await fetchJSON(`${MASSGIS_URL}?${p}${extra}`, 20000);
  return (d?.features || []).map(f => f.attributes);
};

const esc = s => String(s || '').toUpperCase().replace(/'/g, "''").trim();

// Geodesic ring area (spherical excess). Web-mercator Shape__Area is inflated ~1.84x
// at this latitude — using it raw would have reported this 13,605 sq ft lot as 25,000.
export function ringAreaSqFt(ring) {
  const R = 6378137.0, rad = d => d * Math.PI / 180;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    s += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs(s * R * R / 2) * 10.7639104;
}

export async function parcelGeometry(locId) {
  const p = new URLSearchParams({ where: `LOC_ID='${esc(locId)}'`, outFields: 'LOC_ID', returnGeometry: 'true', outSR: '4326', f: 'json' });
  const d = await fetchJSON(`${MASSGIS_URL}?${p}`, 20000);
  const ring = d?.features?.[0]?.geometry?.rings?.[0];
  return ring ? { ring, areaSqFt: Math.round(ringAreaSqFt(ring)) } : null;
}

// District codes in most MA towns encode the minimum lot size (R15 -> 15,000 sq ft).
// INFERRED, not authoritative — the bylaw governs and towns do deviate. Say so.
export function zoningMinLotSqFt(zoning) {
  const m = String(zoning || '').match(/^R-?(\d{1,3})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 200 ? n * 1000 : null;
}

// Lot conformance: the assessor's LOT_SIZE, the mapped polygon and the deed can all
// disagree, and the zoning test runs on the deed/survey. Report all three rather than
// picking one — on 135 Hart they differ by 1,641 sq ft across the 15,000 sq ft line.
export function lotConformance({ assessorAcres, mappedSqFt, zoning }) {
  const assessorSqFt = assessorAcres ? Math.round(assessorAcres * 43560) : null;
  const min = zoningMinLotSqFt(zoning);
  if (!min || !mappedSqFt) return null;
  const disagree = assessorSqFt && Math.abs(assessorSqFt - mappedSqFt) > 500;
  return {
    zoningDistrict: zoning,
    minLotSqFt: min,
    minLotBasis: `INFERRED from the district code "${zoning}" (R<n> = n,000 sq ft). Verify against the town bylaw — this is a convention, not a lookup.`,
    assessorSqFt, mappedSqFt,
    conformingByAssessor: assessorSqFt ? assessorSqFt >= min : null,
    conformingByMappedPolygon: mappedSqFt >= min,
    sourcesDisagree: !!disagree,
    ...(disagree ? {
      warning: `The assessor's lot size (${assessorSqFt.toLocaleString()} sq ft) and the mapped parcel polygon (${mappedSqFt.toLocaleString()} sq ft) differ by ${Math.abs(assessorSqFt - mappedSqFt).toLocaleString()} sq ft, and the ${min.toLocaleString()} sq ft minimum falls BETWEEN them. Whether this lot is conforming cannot be settled from public data — it turns on the deed/survey. Ask the Building Department before relying on any addition, rebuild or setback assumption.`,
    } : {}),
  };
}

// Every parcel on a street: age, value, lot, last sale. The cheapest context there is.
export async function maStreet(town, street, { limit = 300 } = {}) {
  const rows = await q(`CITY='${esc(town)}' AND FULL_STR='${esc(street)}'`,
    'ADDR_NUM,SITE_ADDR,OWNER1,YEAR_BUILT,TOTAL_VAL,BLDG_VAL,LAND_VAL,LOT_SIZE,RES_AREA,LS_DATE,LS_PRICE,LS_BOOK,LS_PAGE,ZONING,USE_CODE,LOC_ID');
  rows.sort((a, b) => (parseInt(a.ADDR_NUM) || 0) - (parseInt(b.ADDR_NUM) || 0));
  const built = rows.map(r => r.YEAR_BUILT).filter(y => y > 0);
  return {
    town: String(town).toUpperCase(), street: String(street).toUpperCase(),
    parcels: rows.length,
    oldestYearBuilt: built.length ? Math.min(...built) : null,
    newestYearBuilt: built.length ? Math.max(...built) : null,
    rows: rows.slice(0, limit),
  };
}

// ASSEMBLAGE DETECTION. Parcels conveyed on the same date under the same book/page are
// one transaction. This is how a developer quietly takes a street, and it is invisible
// to every consumer site — on Hart St it surfaced CS HART LLC taking 8 contiguous
// parcels / 10.5 acres on one deed, later permitted as a 7-unit OSRD subdivision.
export async function maAssemblage(town, { book, page, lsDate } = {}) {
  const parts = [`CITY='${esc(town)}'`];
  if (book) parts.push(`LS_BOOK='${esc(book)}'`);
  if (page) parts.push(`LS_PAGE='${esc(page)}'`);
  if (lsDate) parts.push(`LS_DATE=${parseInt(lsDate, 10)}`);
  if (parts.length === 1) return { error: 'Provide book (and optionally page) or lsDate.' };
  const rows = await q(parts.join(' AND '),
    'SITE_ADDR,OWNER1,OWN_ADDR,OWN_CITY,OWN_STATE,LOT_SIZE,TOTAL_VAL,USE_CODE,ZONING,LS_BOOK,LS_PAGE,LS_DATE,LS_PRICE,LOC_ID');
  const byOwner = {};
  for (const r of rows) (byOwner[r.OWNER1 || '?'] ||= []).push(r);
  return {
    town: String(town).toUpperCase(),
    parcels: rows.length,
    totalAcres: +rows.reduce((n, r) => n + (r.LOT_SIZE || 0), 0).toFixed(2),
    owners: Object.entries(byOwner).map(([owner, rs]) => ({
      owner, parcels: rs.length,
      acres: +rs.reduce((n, r) => n + (r.LOT_SIZE || 0), 0).toFixed(2),
      mailingAddress: [rs[0].OWN_ADDR, rs[0].OWN_CITY, rs[0].OWN_STATE].filter(Boolean).join(', '),
      addresses: rs.map(r => r.SITE_ADDR),
    })).sort((a, b) => b.parcels - a.parcels),
    rows,
  };
}

// Everything a named owner holds in a town — the other half of assemblage.
export async function maOwnerPortfolio(town, owner) {
  const rows = await q(`CITY='${esc(town)}' AND UPPER(OWNER1) LIKE '%${esc(owner)}%'`,
    'SITE_ADDR,OWNER1,LOT_SIZE,TOTAL_VAL,USE_CODE,ZONING,LS_DATE,LS_PRICE,LS_BOOK,LS_PAGE');
  return {
    town: String(town).toUpperCase(), owner: String(owner).toUpperCase(),
    parcels: rows.length,
    totalAcres: +rows.reduce((n, r) => n + (r.LOT_SIZE || 0), 0).toFixed(2),
    totalAssessed: rows.reduce((n, r) => n + (r.TOTAL_VAL || 0), 0),
    rows,
  };
}

// MHC historic areas near a point. NOTE the honest limit: this hosted layer carries
// AREA records for many towns and NO individual building points for some (Beverly has
// ~955 survey forms and zero points here). Absence is therefore NOT evidence the
// building is uninventoried — MACRIS itself must be checked. Saying otherwise would be
// the same "empty result read as a clean record" error this estate keeps making.
export async function maHistoricNearby(lat, lng, meters = 500) {
  const p = new URLSearchParams({
    geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    distance: String(meters), units: 'esriSRUnit_Meter', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'MHCN,TYPE,LEGEND,HISTORIC_N,USE_TYPE,SIGNIFICAN,TOWN_NAME', returnGeometry: 'false', f: 'json',
  });
  const d = await fetchJSON(`${MHC}?${p}`, 20000);
  const rows = (d?.features || []).map(f => f.attributes);
  return {
    searchRadiusMeters: meters,
    areas: rows.filter(r => r.TYPE === 'Area').map(r => ({
      mhcId: r.MHCN, name: r.HISTORIC_N, legend: r.LEGEND, useType: r.USE_TYPE, significance: r.SIGNIFICAN,
    })),
    buildingPoints: rows.filter(r => r.TYPE !== 'Area').length,
    caveat: 'This layer carries MHC AREA records; individual building inventory points are absent for some towns (Beverly included). An absence here is NOT evidence the building is uninventoried — check MACRIS (mhc-macris.net) directly.',
  };
}

const BUILDINGS = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Building_Structures/FeatureServer/0/query';
const WETLANDS = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/DEP_Wetlands/FeatureServer/0/query';
const NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

const postJSON = async (url, params, timeout = 25000) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
};

// Building footprints on the parcel (MassGIS Building_Structures, roofprint-derived).
export async function buildingFootprints(ring) {
  const d = await postJSON(BUILDINGS, {
    geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'STRUCT_ID,AREA_SQ_FT,SOURCEDATE,SOURCETYPE', returnGeometry: 'true', outSR: '4326', f: 'json',
  });
  return (d?.features || []).map(f => ({ ...f.attributes, ring: f.geometry?.rings?.[0] }));
}

// FLOOD AT THE FOOTPRINT, not a geocoded point. The point method is what lenders'
// automated determinations use and it produced a false positive on 358 Main St,
// Groveland: the street point landed in a thin AE sliver at the front of the lot while
// both structures were entirely in Zone X. "Mandatory flood insurance" vs not is real
// money, so this reports the zones touching the BUILDINGS and the zones touching the
// PARCEL separately, and says which method answered.
export async function floodAtFootprint(ring, footprints) {
  const ask = async (r) => {
    const d = await postJSON(NFHL, {
      geometry: JSON.stringify({ rings: [r], spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE', returnGeometry: 'false', f: 'json',
    });
    if (!d || d.error) return null;
    return (d.features || []).map(f => f.attributes);
  };
  const parcelZones = await ask(ring);
  const structureZones = [];
  for (const fp of (footprints || [])) {
    if (!fp.ring) continue;
    const z = await ask(fp.ring);
    if (z) structureZones.push({ structId: fp.STRUCT_ID, areaSqFt: Math.round(fp.AREA_SQ_FT || 0), zones: z });
  }
  const uniq = a => [...new Set((a || []).map(z => z.FLD_ZONE).filter(Boolean))];
  if (parcelZones === null && !structureZones.length) {
    return { method: 'unavailable', note: 'FEMA NFHL did not respond. No footprint determination was made — do NOT read this as "no flood risk".' };
  }
  const structZoneList = uniq(structureZones.flatMap(s => s.zones));
  return {
    method: 'footprint',
    parcelZones: uniq(parcelZones),
    structureZones: structZoneList,
    structures: structureZones,
    structuresInSFHA: structureZones.some(s => s.zones.some(z => z.SFHA_TF === 'T')),
    note: structZoneList.length || parcelZones?.length
      ? 'Zones touching the parcel and the buildings are reported separately. A parcel can touch an SFHA while every structure sits outside it — that distinction is the difference between mandatory flood insurance and not.'
      : 'Neither the parcel nor the buildings intersect a mapped NFHL polygon.',
  };
}

// MA Wetlands Protection Act: work within 100 ft of a bordering vegetated wetland needs
// a Conservation Commission filing. Report the buffer as a measured distance ring from
// the PARCEL boundary, not from a point — the constraint runs to where you dig.
export async function wetlandsNearby(ring) {
  const rings = [0, 15, 30, 46, 61];       // metres; 30m ~= the 100 ft WPA buffer
  const out = [];
  for (const m of rings) {
    const d = await postJSON(WETLANDS, {
      geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPolygon', inSR: '4326',
      ...(m ? { distance: String(m), units: 'esriSRUnit_Meter' } : {}),
      spatialRel: 'esriSpatialRelIntersects', outFields: 'ARC_CODE_DESC', returnGeometry: 'false', f: 'json',
    });
    if (!d || d.error) return { available: false, note: 'MassDEP wetlands layer did not respond.' };
    const fs = d.features || [];
    out.push({ bufferMeters: m, bufferFeet: Math.round(m * 3.28084), arcs: fs.length, types: [...new Set(fs.map(f => f.attributes.ARC_CODE_DESC))] });
    if (fs.length) break;
  }
  const first = out.find(o => o.arcs > 0);
  const within100ft = out.find(o => o.bufferMeters === 30)?.arcs > 0 || out.find(o => o.bufferMeters < 30 && o.arcs > 0);
  return {
    available: true,
    nearestMappedWetlandWithinFeet: first ? first.bufferFeet : `> ${out[out.length - 1].bufferFeet}`,
    withinWpa100ftBuffer: !!within100ft,
    rings: out,
    note: within100ft
      ? 'Mapped wetland resource area lies within ~100 ft of the parcel. Work in the buffer zone requires a filing with the Conservation Commission (RDA or Notice of Intent) under the Wetlands Protection Act.'
      : 'No mapped wetland resource area within ~100 ft of the parcel boundary, so the WPA buffer is unlikely to apply. MassDEP mapping is APPROXIMATE — a delineation by a wetland scientist governs, and small or unmapped resources exist.',
  };
}

// The registry pointer. We cannot scrape MassLandRecords reliably (viewstate app, no
// API), but the book/page in the assessor record IS the lookup key and we were dropping
// it. Give the exact reference and the door. The Essex North/South split is a known trap
// — a wrong district means "no record found" on a perfectly good deed.
export function registryPointer(town, book, page) {
  const t = String(town || '').toUpperCase();
  const ESSEX_SOUTH = new Set(['BEVERLY', 'SALEM', 'DANVERS', 'PEABODY', 'MARBLEHEAD', 'SWAMPSCOTT', 'LYNN', 'SAUGUS', 'NAHANT', 'MIDDLETON', 'TOPSFIELD', 'WENHAM', 'HAMILTON', 'MANCHESTER', 'ESSEX', 'GLOUCESTER', 'ROCKPORT', 'IPSWICH', 'LYNNFIELD']);
  const district = ESSEX_SOUTH.has(t) ? 'Essex South (Salem)' : null;
  return {
    book: book || null, page: page || null,
    district,
    districtBasis: district
      ? 'Town is in the Essex South district.'
      : 'District NOT determined for this town. Massachusetts splits several counties (Essex North/South, Middlesex North/South, Worcester/Worcester North, Bristol Fall River/New Bedford/Taunton, Berkshire North/Middle/South). Searching the wrong district returns "no record found" for a perfectly good deed — confirm before concluding anything.',
    url: 'https://www.masslandrecords.com/',
    coverage: 'MassLandRecords indexes run 1951-present; document images go back to 1640 for Essex South. A pre-1951 chain needs the book/page, which the index will not find by name.',
    note: 'No public API exists. This is a pointer, not a retrieval — the chain of title still requires opening the record.',
  };
}
