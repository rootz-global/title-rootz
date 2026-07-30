/**
 * AI_CONTEXT: Shared constants — API endpoints, SSL provenance, registry config
 *
 * Dependencies: none
 * Exports: MDC_GIS, FEMA_FLOOD, CENSUS_GEOCODER, CENSUS_ACS, SSL_CERTS,
 *          PRIVATE_API, ORIGIN_API, REGISTRIES, MASSGIS_URL, DOR_CODES
 *
 * Central source of truth for all external API URLs and configuration constants.
 */

// ─── Miami-Dade GIS ──────────────────────────────────────────────
export const MDC_GIS = 'https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer';
export const MDC_PROPERTY_LAYER = `${MDC_GIS}/24/query`;
export const MDC_IDENTIFY = `${MDC_GIS}/identify`;

// ─── FEMA Flood ──────────────────────────────────────────────────
export const FEMA_FLOOD = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

// ─── Census ──────────────────────────────────────────────────────
export const CENSUS_GEOCODER = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
export const CENSUS_ACS = 'https://api.census.gov/data/2022/acs/acs5';

// The ACS API now REJECTS keyless requests: it 302s to /data/missing_key.html,
// which parses as neither JSON nor an error, so callers saw an opaque failure
// rather than "you need a key". Set CENSUS_API_KEY in .env (free, instant:
// https://api.census.gov/data/key_signup.html). Without it the live-API
// fallback cannot work and callers must rely on the pre-cached block groups.
export const CENSUS_API_KEY = process.env.CENSUS_API_KEY || '';
export function withCensusKey(url) {
  if (!CENSUS_API_KEY) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(CENSUS_API_KEY);
}
export const CENSUS_KEY_HINT =
  'Census ACS requires an API key; set CENSUS_API_KEY (https://api.census.gov/data/key_signup.html)';

// ─── USGS Elevation ──────────────────────────────────────────────
export const USGS_EPQS = 'https://epqs.nationalmap.gov/v1/json';

// ─── Rootz Cross-Reference Services ─────────────────────────────
export const PRIVATE_API = 'https://private.rootz.global';
export const ORIGIN_API = 'https://origin.rootz.global';

// ─── MassGIS (Massachusetts legacy) ─────────────────────────────
export const MASSGIS_URL = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0/query';

// ─── Massachusetts Registry Configuration ────────────────────────
export const REGISTRIES = {
  'RICHMOND': 'BerkMiddle', 'LENOX': 'BerkMiddle', 'PITTSFIELD': 'BerkMiddle',
  'DALTON': 'BerkMiddle', 'HINSDALE': 'BerkMiddle', 'BECKET': 'BerkMiddle',
  'LEE': 'BerkMiddle', 'STOCKBRIDGE': 'BerkMiddle', 'WASHINGTON': 'BerkMiddle',
  'TYRINGHAM': 'BerkMiddle', 'OTIS': 'BerkMiddle', 'PERU': 'BerkMiddle',
  'GREAT BARRINGTON': 'BerkSouth', 'SHEFFIELD': 'BerkSouth', 'MONTEREY': 'BerkSouth',
  'NEW MARLBOROUGH': 'BerkSouth', 'SANDISFIELD': 'BerkSouth', 'EGREMONT': 'BerkSouth',
  'ALFORD': 'BerkSouth', 'MOUNT WASHINGTON': 'BerkSouth', 'WEST STOCKBRIDGE': 'BerkSouth',
  'NORTH ADAMS': 'BerkNorth', 'WILLIAMSTOWN': 'BerkNorth', 'ADAMS': 'BerkNorth',
  'CLARKSBURG': 'BerkNorth', 'FLORIDA': 'BerkNorth', 'SAVOY': 'BerkNorth',
  'CHESHIRE': 'BerkNorth', 'HANCOCK': 'BerkNorth', 'LANESBOROUGH': 'BerkNorth',
  'NEW ASHFORD': 'BerkNorth', 'WINDSOR': 'BerkNorth', 'BOSTON': 'suffolk'
};

// ─── SSL Certificate Provenance ──────────────────────────────────
export const SSL_CERTS = {
  'gisweb.miamidade.gov': {
    subject: 'CN=gisweb.miamidade.gov, O=Miami-Dade County, ST=Florida, C=US',
    issuer: 'CN=Sectigo Public Server Authentication CA OV R36',
    fingerprint: '78:34:5D:92:96:55:3B:07:44:F2:6D:0C:6B:A0:32:47:3D:4F:2B:FF',
    validTo: '2027-01-30'
  },
  'hazards.fema.gov': {
    subject: 'CN=hazards.fema.gov, O=Federal Emergency Management Agency, C=US',
    issuer: 'CN=DigiCert EV RSA CA G2',
    fingerprint: 'C9:4B:E9:25:7E:4D:62:06:C4:9E:89:F8:99:74:56:38:B4:35:9E:6E',
    validTo: '2026-07-14'
  },
  'api.census.gov': {
    subject: 'CN=api.census.gov, O=U.S. Census Bureau, C=US',
    issuer: 'CN=DigiCert Global G2 TLS RSA SHA256 2020 CA1',
    fingerprint: '5F:01:91:E5:60:77:75:50:87:AF:E6:08:CC:52:FF:A6:60:FF:10:9A',
    validTo: '2027-02-05'
  }
};

// ─── FL DOR County Codes (CO_NO) ─────────────────────────────────
// The statewide DOR parcel export tags every parcel with CO_NO, the standard
// Florida DOR county number (11=Alachua … 77=Washington, alphabetical, with
// Miami-Dade as 23/"Dade"). This is the AUTHORITATIVE county for a parcel — the
// city-indexed files are keyed by PHY_CITY string and a single city name can
// span counties, so never infer county from the file name. Used to stamp the
// correct county into the signed origin record instead of assuming Miami-Dade.
export const FL_COUNTIES = {
  11: 'Alachua', 12: 'Baker', 13: 'Bay', 14: 'Bradford', 15: 'Brevard',
  16: 'Broward', 17: 'Calhoun', 18: 'Charlotte', 19: 'Citrus', 20: 'Clay',
  21: 'Collier', 22: 'Columbia', 23: 'Miami-Dade', 24: 'DeSoto', 25: 'Dixie',
  26: 'Duval', 27: 'Escambia', 28: 'Flagler', 29: 'Franklin', 30: 'Gadsden',
  31: 'Gilchrist', 32: 'Glades', 33: 'Gulf', 34: 'Hamilton', 35: 'Hardee',
  36: 'Hendry', 37: 'Hernando', 38: 'Highlands', 39: 'Hillsborough', 40: 'Holmes',
  41: 'Indian River', 42: 'Jackson', 43: 'Jefferson', 44: 'Lafayette', 45: 'Lake',
  46: 'Lee', 47: 'Leon', 48: 'Levy', 49: 'Liberty', 50: 'Madison',
  51: 'Manatee', 52: 'Marion', 53: 'Martin', 54: 'Monroe', 55: 'Nassau',
  56: 'Okaloosa', 57: 'Okeechobee', 58: 'Orange', 59: 'Osceola', 60: 'Palm Beach',
  61: 'Pasco', 62: 'Pinellas', 63: 'Polk', 64: 'Putnam', 65: 'St. Johns',
  66: 'St. Lucie', 67: 'Santa Rosa', 68: 'Sarasota', 69: 'Seminole', 70: 'Sumter',
  71: 'Suwannee', 72: 'Taylor', 73: 'Union', 74: 'Volusia', 75: 'Wakulla',
  76: 'Walton', 77: 'Washington',
};
// County name for a CO_NO (accepts number or string); null if unknown.
export function flCountyName(coNo) {
  if (coNo === null || coNo === undefined || coNo === '') return null;
  return FL_COUNTIES[parseInt(coNo, 10)] || null;
}

// Broward city fallback — only consulted when a parcel has no CO_NO (e.g. a
// record fetched from MDC GIS rather than the DOR export).
export const BROWARD_CITIES = /^(FORT LAUDERDALE|HOLLYWOOD|PEMBROKE PINES|CORAL SPRINGS|MIRAMAR|POMPANO BEACH|DAVIE|PLANTATION|SUNRISE|DEERFIELD BEACH|LAUDERHILL|TAMARAC|WESTON|COCONUT CREEK|MARGATE|LAUDERDALE LAKES|OAKLAND PARK|WILTON MANORS|HALLANDALE|DANIA|COOPER CITY|PARKLAND|SOUTHWEST RANCHES|LIGHTHOUSE POINT|LAZY LAKE|SEA RANCH LAKES|WEST PARK|HILLSBORO BEACH|PEMBROKE PARK)\b/;
// The Broward Clerk corpus is Broward-only. A court/distress signal may ONLY be
// attached to a parcel that is physically in Broward County (CO_NO 16) —
// matching by owner name alone smears Broward filings onto same-named owners
// statewide, which is how Broward foreclosure cases ended up on Ocala homes.
export function isBrowardParcel(coNo, city = '') {
  if (coNo !== null && coNo !== undefined && coNo !== '') {
    return parseInt(coNo, 10) === 16;          // authoritative when present
  }
  return BROWARD_CITIES.test(String(city).toUpperCase());  // fallback only
}

// ─── DOR Use Code Descriptions ───────────────────────────────────
export const DOR_CODES = {
  '000': 'Vacant Residential', '001': 'Single Family', '002': 'Mobile Home',
  '003': 'Multi-Family (2-9)', '004': 'Condo', '005': 'Co-op',
  '006': 'Retirement Home', '007': 'Misc Residential', '008': 'Multi-Family (10+)',
  '009': 'Non-marketable Residential'
};

// ─── Residential DOR Code Set ────────────────────────────────────
export const RESIDENTIAL_CODES = new Set(['000', '001', '002', '003', '004', '005', '006', '007', '008', '009']);
