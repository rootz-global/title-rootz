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

// ─── DOR Use Code Descriptions ───────────────────────────────────
export const DOR_CODES = {
  '000': 'Vacant Residential', '001': 'Single Family', '002': 'Mobile Home',
  '003': 'Multi-Family (2-9)', '004': 'Condo', '005': 'Co-op',
  '006': 'Retirement Home', '007': 'Misc Residential', '008': 'Multi-Family (10+)',
  '009': 'Non-marketable Residential'
};

// ─── Residential DOR Code Set ────────────────────────────────────
export const RESIDENTIAL_CODES = new Set(['000', '001', '002', '003', '004', '005', '006', '007', '008', '009']);
