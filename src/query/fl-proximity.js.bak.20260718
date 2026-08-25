/**
 * AI_CONTEXT: Florida proximity lookups — nearby schools, hospitals, permits, EV, TRI, roads
 *
 * Dependencies:
 *   - src/lib/geo.js (distanceMiles)
 *   - src/lib/data-loader.js (loadDataFile)
 *
 * Exports:
 *   - findNearestSchools(lat, lng, maxDistance) — public, private, charter schools
 *   - findBuildingPermits(folio, address) — building permits from 5 county sources
 *   - findNearbyRoadWork(lat, lng, maxDistance) — road improvement projects
 *   - findNearestHospitals(lat, lng, maxDistance) — CMS Medicare-rated hospitals
 *   - findNearestEVCharging(lat, lng, maxDistance) — DOE AFDC EV stations
 *   - findNearestTRIFacilities(lat, lng, maxDistance) — EPA toxic release facilities
 *   - findNearestEvacuationRoute(lat, lng) — MDC OEM evacuation routes
 *
 * All functions are synchronous (cached JSON data), except they rely on loadDataFile which reads from disk on first call.
 */

import { distanceMiles } from '../lib/geo.js';
import { loadDataFile } from '../lib/data-loader.js';

function normalizeAddress(addr) {
  if (!addr) return '';
  addr = String(addr).trim().toUpperCase();
  addr = addr.replace(/\s+/g, ' ');
  addr = addr.replace(/(\d+)(ST|ND|RD|TH)\b/g, '$1');
  addr = addr.replace(/\s+(BR|BT|FL|BLDG|APT|STE|UNIT|#)\s*\S*$/, '');
  return addr.trim();
}

// ─── Schools ─────────────────────────────────────────────────────

export function findNearestSchools(lat, lng, maxDistance = 3.0) {
  const results = { public: [], private: [], charter: [] };
  if (!lat || !lng) return results;

  const swPublic = loadDataFile('florida/statewide-schools-public.json');
  if (swPublic && swPublic.length > 0) {
    results.public = swPublic
      .filter(s => (s.LAT || s.LATITUDE) && (s.LON || s.LONGITUDE))
      .map(s => {
        const sLat = s.LAT || s.LATITUDE;
        const sLng = s.LON || s.LONGITUDE;
        return {
          name: (s.NAME || '').trim(), address: (s.STREET || s.ADDRESS || '').trim(),
          city: (s.CITY || '').trim(), county: (s.NMCNTY || s.COUNTY || '').trim(),
          enrollment: s.ENROLLMENT || s.POPULATION || null,
          locale: s.LOCALE || null, ncessch: s.NCESSCH || null,
          distance: Math.round(distanceMiles(lat, lng, sLat, sLng) * 100) / 100
        };
      })
      .filter(s => s.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);
  } else {
    const schools = loadDataFile('florida/schools.json');
    if (schools) {
      const nearby = schools
        .filter(s => s._lat && s._lng)
        .map(s => ({
          name: (s.NAME || '').trim(), address: (s.ADDRESS || '').trim(),
          city: (s.CITY || '').trim(), type: s.TYPE, grades: s.GRADES,
          enrollment: s.ENROLLMNT, capacity: s.CAPACITY, phone: (s.PHONE || '').trim(),
          distance: Math.round(distanceMiles(lat, lng, s._lat, s._lng) * 100) / 100
        }))
        .filter(s => s.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance);
      const elementary = nearby.find(s => s.type === 'E');
      const middle = nearby.find(s => s.type === 'M' || s.type === 'K');
      const high = nearby.find(s => s.type === 'S');
      results.public = [elementary, middle, high].filter(Boolean);
    }
  }

  const swPrivate = loadDataFile('florida/statewide-schools-private.json');
  if (swPrivate && swPrivate.length > 0) {
    results.private = swPrivate
      .filter(s => (s.LAT || s.LATITUDE) && (s.LON || s.LONGITUDE))
      .map(s => ({
        name: (s.NAME || '').trim(), address: (s.STREET || s.ADDRESS || '').trim(),
        city: (s.CITY || '').trim(),
        distance: Math.round(distanceMiles(lat, lng, s.LAT || s.LATITUDE, s.LON || s.LONGITUDE) * 100) / 100
      }))
      .filter(s => s.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
  } else {
    const privSchools = loadDataFile('florida/private-schools.json');
    if (privSchools) {
      results.private = privSchools
        .filter(s => s._lat && s._lng)
        .map(s => ({
          name: (s.NAME || '').trim(), address: (s.ADDRESS || '').trim(),
          city: (s.CITY || '').trim(), grades: s.GRDSPAN,
          distance: Math.round(distanceMiles(lat, lng, s._lat, s._lng) * 100) / 100
        }))
        .filter(s => s.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);
    }
  }

  const charters = loadDataFile('florida/charter-schools.json');
  if (charters) {
    results.charter = charters
      .filter(s => s._lat && s._lng)
      .map(s => ({
        name: (s.NAME || '').trim(), address: (s.ADDRESS || '').trim(),
        distance: Math.round(distanceMiles(lat, lng, s._lat, s._lng) * 100) / 100
      }))
      .filter(s => s.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
  }

  return results;
}

// ─── Building Permits ────────────────────────────────────────────

let _permitAddrIndex = null;
let _permitFolioIndex = null;

function getPermitIndices() {
  if (_permitAddrIndex) return { addr: _permitAddrIndex, folio: _permitFolioIndex };
  _permitAddrIndex = {};
  _permitFolioIndex = {};

  const sources = [
    { file: 'florida/building-permits.json', src: 'county', addrField: 'ADDRESS', folioField: 'FOLIO', geofolioField: 'GEOFOLIO' },
    { file: 'florida/miami-city-permits.json', src: 'city_of_miami', addrField: 'DeliveryAddress', folioField: 'FolioNumber' },
    { file: 'florida/broward-fort-lauderdale-permits.json', src: 'fort_lauderdale', addrField: 'FULLADDR', folioField: 'PARCELID' },
    { file: 'florida/brevard-palm-bay-permits.json', src: 'palm_bay', addrField: 'ADDRESS', folioField: 'Renum' },
    { file: 'florida/accela-hillsborough-permits.json', src: 'hillsborough', addrField: 'Address' }
  ];

  for (const { file, src, addrField, folioField, geofolioField } of sources) {
    const permits = loadDataFile(file) || [];
    for (const p of permits) {
      p._source = src;
      const addr = normalizeAddress(p[addrField] || p.address || p.Address || '');
      if (addr && addr.length > 5) {
        if (!_permitAddrIndex[addr]) _permitAddrIndex[addr] = [];
        _permitAddrIndex[addr].push(p);
      }
      if (folioField) {
        const folio = String(p[folioField] || '').trim();
        if (folio && folio !== 'None') {
          if (!_permitFolioIndex[folio]) _permitFolioIndex[folio] = [];
          _permitFolioIndex[folio].push(p);
          if (src === 'city_of_miami') {
            const padded = folio.padStart(13, '0');
            if (!_permitFolioIndex[padded]) _permitFolioIndex[padded] = [];
            _permitFolioIndex[padded].push(p);
          }
        }
      }
      if (geofolioField) {
        const gf = String(p[geofolioField] || '').trim();
        if (gf && gf !== 'None') {
          if (!_permitFolioIndex[gf]) _permitFolioIndex[gf] = [];
          _permitFolioIndex[gf].push(p);
        }
      }
    }
  }
  return { addr: _permitAddrIndex, folio: _permitFolioIndex };
}

export function findBuildingPermits(folio, address) {
  const { addr: addrIndex, folio: folioIndex } = getPermitIndices();
  let matches = [];
  if (folio) matches = folioIndex[folio] || [];
  if (!matches.length && address) matches = addrIndex[normalizeAddress(address)] || [];

  return matches.map(p => {
    const src = p._source || 'county';
    if (src === 'fort_lauderdale') {
      return {
        processNumber: p.PERMITID || '', address: (p.FULLADDR || '').trim(),
        folio: p.PARCELID || '', type: p.PERMITTYPE || '',
        description: p.PERMITDESC || '', status: p.PERMITSTAT || '',
        estimatedValue: parseInt(p.ESTCOST) || null,
        contractor: (p.CONTRACTOR || '').trim(), owner: (p.OWNERNAME || '').trim(),
        issueDate: p.SUBMITDT ? new Date(parseInt(p.SUBMITDT)).toISOString().split('T')[0] : null,
        source: 'Fort Lauderdale Building Permits'
      };
    }
    if (src === 'palm_bay') {
      return {
        processNumber: (p.ApplicationNumber || '').trim(), address: (p.ADDRESS || '').trim(),
        folio: p.Renum || '', type: p.ApplicationType || p.PermitType || '',
        description: p.ApplicationDescription || '', status: p.PermitStatus || '',
        estimatedValue: parseInt(p.EstimateValuation) || null,
        issueDate: p.issueDate ? new Date(parseInt(p.issueDate)).toISOString().split('T')[0] : null,
        source: 'Palm Bay Building Permits'
      };
    }
    if (src === 'hillsborough') {
      return {
        processNumber: p['Record Number'] || p.recordNumber || '',
        address: p.Address || p.address || '', type: p['Record Type'] || p.recordType || '',
        description: p.Description || p.description || '', status: '',
        issueDate: p.Date || p.date || null, source: 'Hillsborough County (Accela)'
      };
    }
    return {
      processNumber: (p.PROCNUM || '').trim(),
      address: (p.STNDADDR || p.ADDRESS || p.DeliveryAddress || '').trim(),
      folio: p.FOLIO || p.GEOFOLIO || p.FolioNumber || '',
      type: (p.TYPE || '').trim(), description: (p.DESC1 || '').trim(),
      status: (p.BPSTATUS || '').trim(),
      residentialCommercial: p.RESCOMM === 'R' ? 'Residential' : p.RESCOMM === 'C' ? 'Commercial' : p.RESCOMM,
      estimatedValue: parseInt(p.ESTVALUE) || null,
      contractor: (p.CONTRNAME || '').trim(),
      issueDate: p.ISSUDATE ? new Date(parseInt(p.ISSUDATE)).toISOString().split('T')[0] : null,
      source: src === 'city_of_miami' ? 'City of Miami' : 'Miami-Dade County'
    };
  }).sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));
}

// ─── Hospitals ───────────────────────────────────────────────────

export function findNearestHospitals(lat, lng, maxDistance = 15.0) {
  if (!lat || !lng) return [];
  const swHospitals = loadDataFile('florida/statewide-hospitals.json');
  if (swHospitals && swHospitals.length > 0) {
    return swHospitals
      .filter(h => parseFloat(h.latitude || h.lat) && parseFloat(h.longitude || h.lng))
      .map(h => {
        const hLat = parseFloat(h.latitude || h.lat);
        const hLng = parseFloat(h.longitude || h.lng);
        return {
          name: h.facility_name || h.name || h.hospital_name,
          address: h.address || h.street_address, city: h.city || h.city_town,
          cmsRating: parseInt(h.hospital_overall_rating || h.overallRating || h.overall_rating) || null,
          emergencyServices: (h.emergency_services || h.emergencyServices || '').toString().toLowerCase().includes('yes'),
          distanceMiles: Math.round(distanceMiles(lat, lng, hLat, hLng) * 100) / 100,
          lat: hLat, lng: hLng
        };
      })
      .filter(h => h.distanceMiles <= maxDistance)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .slice(0, 10);
  }

  const hospitals = loadDataFile('florida/hospitals.json');
  if (!hospitals) return [];
  return hospitals
    .filter(h => h._lat && h._lng)
    .map(h => ({
      name: h.name, address: h.address, city: h.city,
      cmsRating: parseInt(h.overallRating) || null,
      emergencyServices: h.emergencyServices === 'Yes',
      distanceMiles: Math.round(distanceMiles(lat, lng, h._lat, h._lng) * 100) / 100
    }))
    .filter(h => h.distanceMiles <= maxDistance)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 10);
}

// ─── EV Charging ─────────────────────────────────────────────────

export function findNearestEVCharging(lat, lng, maxDistance = 5.0) {
  const stations = loadDataFile('florida/statewide-ev-charging.json') || loadDataFile('florida/ev-charging.json');
  if (!stations || !lat || !lng) return [];

  return stations
    .filter(s => s.latitude && s.longitude)
    .map(s => ({
      ...s,
      distanceMiles: Math.round(distanceMiles(lat, lng, s.latitude, s.longitude) * 100) / 100
    }))
    .filter(s => s.distanceMiles <= maxDistance)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 10)
    .map(s => ({
      name: s.station_name, address: s.street_address, city: s.city,
      network: s.ev_network, connectorTypes: s.ev_connector_types,
      level2Count: s.ev_level2_evse_num || 0, dcFastCount: s.ev_dc_fast_num || 0,
      pricing: s.ev_pricing || null, distanceMiles: s.distanceMiles,
      lat: s.latitude, lng: s.longitude
    }));
}

// ─── EPA TRI Facilities ──────────────────────────────────────────

export function findNearestTRIFacilities(lat, lng, maxDistance = 5.0) {
  const facilities = loadDataFile('florida/statewide-epa-tri.json') || loadDataFile('florida/epa-tri-facilities.json');
  if (!facilities || !lat || !lng) return [];

  return facilities
    .filter(f => f.PREF_LATITUDE && f.PREF_LATITUDE !== 'None' && f.PREF_LONGITUDE && f.PREF_LONGITUDE !== 'None')
    .map(f => {
      const fLat = parseFloat(f.PREF_LATITUDE);
      const fLng = parseFloat(f.PREF_LONGITUDE) * -1;
      return { ...f, calcLat: fLat, calcLng: fLng, distanceMiles: Math.round(distanceMiles(lat, lng, fLat, fLng) * 100) / 100 };
    })
    .filter(f => f.distanceMiles <= maxDistance)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 10)
    .map(f => ({
      name: f.FACILITY_NAME, address: f.STREET_ADDRESS, city: f.CITY_NAME,
      closed: f.FAC_CLOSED_IND === 'Y', triId: f.TRI_FACILITY_ID,
      distanceMiles: f.distanceMiles, lat: f.calcLat, lng: f.calcLng
    }));
}

// ─── Road Work ───────────────────────────────────────────────────

export function findNearbyRoadWork(lat, lng, maxDistanceMiles = 2.0) {
  const roads = loadDataFile('florida/road-improvements.json');
  if (!roads || !lat || !lng) return [];
  return roads.slice(0, 20).map(r => ({
    agency: (r.AGENCY || '').trim(), location: (r.LOCATION || '').trim(),
    project: (r.PROJECT || '').trim(), status: (r.STATUS || '').trim(),
    consultant: (r.CONSULTANT || '').trim(), constructionDate: (r.CONSTDATE || '').trim()
  })).filter(r => r.location || r.project);
}

// ─── Evacuation Routes ───────────────────────────────────────────

export function findNearestEvacuationRoute(lat, lng) {
  const routes = loadDataFile('florida/evacuation-routes.json');
  if (!routes || !lat || !lng) return null;

  const mapped = routes.map(r => {
    const attrs = r.attributes || r;
    return {
      name: attrs.ROADNAME || attrs.NAME || attrs.RTE_NAME || '(unnamed)',
      type: attrs.RTE_TYPE || attrs.TYPE || '',
      direction: attrs.DIRECTION || '', zone: attrs.EVAC_ZONE || ''
    };
  }).filter(r => r.name !== '(unnamed)');

  const seen = new Set();
  return mapped.filter(r => {
    const key = r.name + r.direction;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}
