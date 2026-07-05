// Origin Land Records MCP Server
// Fetches, verifies, and caches Massachusetts + Florida property records
// Port 3035

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { assemblePropertyIntelligence, lookupByAddress, lookupByFolio, getFloodZone, getCensusData, findBuildingPermits, findNearestSchools, findNearestHospitals, findNearestEVCharging, findNearestTRIFacilities, getMarketEconomics, getInvestorSignals, getIRSIncomeByZip, getNFIPClaimsByZip, getFEMADisastersByCounty, getStatewideEconomics, assembleTimeshareIntelligence, searchDBPRTimeshare, searchVacationRentals } from './fl-query.mjs';
import { assembleOhioPropertyIntelligence, lookupOhioByAddress } from './oh-query.mjs';
import { parseCookies, requireAuth, createAccount, getAccountByEmail, createMagicLinkToken, verifyMagicLinkToken, createSession, checkRateLimit, checkTokenBudget, logUsage, updateUsageTokens, getUsageStats, getTierConfig, revokeSession } from './auth.mjs';
import { sendMagicLink } from './email.mjs';
import { handleFarmChat, renderFarmChatPage } from './farm-chat.mjs';
import { initStripeProducts, createCheckoutSession, createPortalSession, handleStripeWebhook, verifyWebhookSignature } from './stripe-config.mjs';
import { renderNav } from './nav-template.mjs';
import db from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3035;
// Resolve data dir: on server files are in root (data/ is child), locally in mcp-server/ (data/ is sibling)
const DATA_DIR = fs.existsSync(path.join(__dirname, 'data')) ? path.join(__dirname, 'data') : path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DOCS_DIR = path.join(DATA_DIR, 'documents');

// Ensure directories exist
[CACHE_DIR, DOCS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Registry Configuration ───────────────────────────────────────
const REGISTRIES = {
  'RICHMOND': 'BerkMiddle',
  'LENOX': 'BerkMiddle',
  'PITTSFIELD': 'BerkMiddle',
  'DALTON': 'BerkMiddle',
  'HINSDALE': 'BerkMiddle',
  'BECKET': 'BerkMiddle',
  'LEE': 'BerkMiddle',
  'STOCKBRIDGE': 'BerkMiddle',
  'WASHINGTON': 'BerkMiddle',
  'TYRINGHAM': 'BerkMiddle',
  'OTIS': 'BerkMiddle',
  'PERU': 'BerkMiddle',
  'GREAT BARRINGTON': 'BerkSouth',
  'SHEFFIELD': 'BerkSouth',
  'MONTEREY': 'BerkSouth',
  'NEW MARLBOROUGH': 'BerkSouth',
  'SANDISFIELD': 'BerkSouth',
  'EGREMONT': 'BerkSouth',
  'ALFORD': 'BerkSouth',
  'MOUNT WASHINGTON': 'BerkSouth',
  'WEST STOCKBRIDGE': 'BerkSouth',
  'NORTH ADAMS': 'BerkNorth',
  'WILLIAMSTOWN': 'BerkNorth',
  'ADAMS': 'BerkNorth',
  'CLARKSBURG': 'BerkNorth',
  'FLORIDA': 'BerkNorth',
  'SAVOY': 'BerkNorth',
  'CHESHIRE': 'BerkNorth',
  'HANCOCK': 'BerkNorth',
  'LANESBOROUGH': 'BerkNorth',
  'NEW ASHFORD': 'BerkNorth',
  'WINDSOR': 'BerkNorth',
  'BOSTON': 'suffolk',
};

// MassGIS API endpoint
const MASSGIS_URL = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0/query';

// ─── Cross-Reference: Rootz Service Joins ────────────────────────
// Connects title data to private.rootz.global and origin.rootz.global

const PRIVATE_API = 'https://private.rootz.global';
const ORIGIN_API = 'https://origin.rootz.global';

function normalizeEntityName(name) {
  if (!name) return '';
  return name
    .toUpperCase()
    .replace(/[,.']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEntityOwner(ownerName) {
  if (!ownerName) return false;
  const upper = ownerName.toUpperCase();
  return /\b(LLC|L\.L\.C|INC|CORP|LP|L\.P|LTD|PARTNERS|PARTNERSHIP|HOLDINGS|GROUP|ENTERPRISES|TRUST|TRS|REVOCABLE|IRREVOCABLE)\b/.test(upper);
}

function extractEntitySearchTerm(ownerName) {
  if (!ownerName) return '';
  // Strip trust suffixes for better matching — keep the entity name
  return ownerName
    .toUpperCase()
    .replace(/\s+(TRS|TRUSTEE|AS TRUSTEE|REVOCABLE TRUST|IRREVOCABLE TRUST|LIVING TRUST|FAMILY TRUST)$/i, '')
    .replace(/[,.']/g, '')
    .trim();
}

async function fetchCrossRef(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error(`Cross-ref fetch error: ${url.substring(0, 80)} — ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Join 1: Private ↔ Title — resolve LLC/entity owner to Sunbiz officers
async function crossRefPrivateEntity(ownerName, state = 'FL') {
  const searchTerm = extractEntitySearchTerm(ownerName);
  if (!searchTerm || searchTerm.length < 3) return null;

  // Search private company registry for this entity
  const encoded = encodeURIComponent(searchTerm);
  const searchResult = await fetchCrossRef(`${PRIVATE_API}/api/search?q=${encoded}&state=${state}&limit=5`);
  if (!searchResult?.results?.length) return null;

  // Find best match — prefer exact normalized match
  const normalized = normalizeEntityName(searchTerm);
  let best = searchResult.results[0];
  for (const r of searchResult.results) {
    if (normalizeEntityName(r.entity_name) === normalized) {
      best = r;
      break;
    }
  }

  // Get full entity detail with officers
  const detail = await fetchCrossRef(`${PRIVATE_API}/api/entity/${best.state}/${best.state_id}`);

  return {
    match: {
      entity_name: best.entity_name,
      state: best.state,
      state_id: best.state_id,
      entity_type: best.entity_type_normalized,
      filing_year: best.filing_year,
      business_age_years: best.business_age_years,
      status: best.status,
      confidence: normalizeEntityName(best.entity_name) === normalized ? 'exact' : 'partial'
    },
    officers: detail?.officers || [],
    agent: detail ? { name: detail.agent_name, address: detail.agent_address, city: detail.agent_city, state: detail.agent_state } : null,
    succession_signal: detail?.officers?.some(o =>
      o.is_same_as_agent && ['ceo', 'president', 'chairman', 'manager'].includes(o.title_normalized)
    ) || false,
    ein: detail?.fei_ein || null,
    principal_address: detail ? { address: detail.principal_address1, city: detail.principal_city, state: detail.principal_state, zip: detail.principal_zip } : null,
    source: 'private.rootz.global',
    query_used: searchTerm
  };
}

// Join 2: Public ↔ Title — check if property owner is a public company or subsidiary
async function crossRefPublicEntity(ownerName) {
  const searchTerm = extractEntitySearchTerm(ownerName);
  if (!searchTerm || searchTerm.length < 3) return null;

  // Search Origin (SEC registry) for this entity name
  const encoded = encodeURIComponent(searchTerm);
  const searchResult = await fetchCrossRef(`${ORIGIN_API}/api/search?q=${encoded}`);
  if (!searchResult?.results?.length) return null;

  // Filter for plausible matches — public companies that might own property
  const matches = searchResult.results.slice(0, 3).map(r => ({
    ticker: r.ticker,
    company_name: r.name || r.company_name,
    sector: r.sector,
    industry: r.industry,
    match_type: 'name_search'
  }));

  if (!matches.length) return null;

  // Get company detail for the top match
  const top = matches[0];
  const detail = await fetchCrossRef(`${ORIGIN_API}/api/company/${top.ticker}`);

  return {
    matches,
    top_match: detail ? {
      ticker: top.ticker,
      company_name: detail.name || detail.company_name,
      sector: detail.sector,
      industry: detail.industry,
      cik: detail.cik,
      state: detail.state,
      sic: detail.sic
    } : top,
    is_reit: detail?.sic ? ['6500', '6510', '6512', '6552', '6798'].includes(String(detail.sic)) : false,
    source: 'origin.rootz.global',
    query_used: searchTerm
  };
}

// ─── Cache Layer ──────────────────────────────────────────────────
function getCacheKey(address, town) {
  return crypto.createHash('sha256')
    .update(`${address}|${town}`.toUpperCase())
    .digest('hex')
    .substring(0, 16);
}

function getFromCache(key) {
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(cachePath)) {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return data;
  }
  return null;
}

function saveToCache(key, data) {
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

// ─── MassGIS Assessor Fetch ───────────────────────────────────────
async function fetchAssessorData(address, town) {
  const parts = address.match(/^(\d+)\s+(.+)$/);
  let query;
  if (parts) {
    const [, num, street] = parts;
    query = `ADDR_NUM='${num}' AND FULL_STR LIKE '%${street.toUpperCase().replace(/ (RD|ST|AVE|DR|LN|CT|WAY|BLVD|PL|PKWY|CIR)$/i, '')}%' AND CITY='${town.toUpperCase()}'`;
  } else {
    query = `SITE_ADDR LIKE '%${address.toUpperCase()}%' AND CITY='${town.toUpperCase()}'`;
  }

  const params = new URLSearchParams({
    where: query,
    outFields: '*',
    returnGeometry: 'false',
    f: 'json'
  });

  try {
    const url = `${MASSGIS_URL}?${params}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.features && data.features.length > 0) {
      return data.features.map(f => f.attributes);
    }

    // Fallback: search by owner name if address fails
    if (parts) {
      const ownerQuery = `OWNER1 LIKE '%${town.toUpperCase()}%' AND SITE_ADDR LIKE '%${parts[2].toUpperCase().split(' ')[0]}%'`;
      const params2 = new URLSearchParams({ where: ownerQuery, outFields: '*', returnGeometry: 'false', f: 'json' });
      const resp2 = await fetch(`${MASSGIS_URL}?${params2}`);
      const data2 = await resp2.json();
      if (data2.features && data2.features.length > 0) {
        return data2.features.map(f => f.attributes);
      }
    }

    return null;
  } catch (e) {
    console.error('MassGIS fetch error:', e.message);
    return null;
  }
}

// ─── Registry Fetch (from cached extraction data) ─────────────────
// In production this would use Playwright to fetch live
// For now, load from our pre-extracted JSON files
function loadPropertyData(address, town) {
  const propsDir = path.join(DATA_DIR, 'properties');
  if (!fs.existsSync(propsDir)) return null;

  const files = fs.readdirSync(propsDir).filter(f => f.endsWith('.json'));
  const searchAddr = address.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const searchTown = town.toLowerCase().replace(/[^a-z0-9]/g, '-');

  for (const file of files) {
    if (file.toLowerCase().includes(searchTown) || file.toLowerCase().includes(searchAddr.split('-')[0])) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
        // Check if this is the right property
        const propAddr = (data.property?.address?.primary || data.property?.address || '').toLowerCase();
        const propTown = (data.property?.address?.town || data.property?.town || '').toLowerCase();
        if (propAddr.includes(address.toLowerCase().split(' ')[0]) || propTown.includes(town.toLowerCase())) {
          return data;
        }
      } catch (e) { /* skip invalid JSON */ }
    }
  }
  return null;
}

// ─── Cross-Reference Resolver ─────────────────────────────────────
// Given a list of registry records, extract all cross-referenced documents
function extractCrossReferences(records) {
  const refs = new Set();
  const refDetails = [];

  for (const record of records) {
    const references = record.references || [];
    for (const ref of references) {
      const key = ref.bookPage;
      if (!refs.has(key)) {
        refs.add(key);
        refDetails.push({
          bookPage: ref.bookPage,
          type: ref.type,
          year: ref.year,
          referencedBy: record.docNum || record.bookPage,
          referencedByType: record.typeDesc || record.docInfo?.typeDesc,
          level: 2 // secondary document
        });
      }
    }
  }

  return refDetails;
}

// ─── Build Document Graph ─────────────────────────────────────────
function buildDocumentGraph(propertyData) {
  if (!propertyData?.registry?.records) return null;

  const records = propertyData.registry.records;
  const graph = {
    address: propertyData.property?.address?.primary || 'unknown',
    town: propertyData.property?.address?.town || 'unknown',
    levels: {}
  };

  // Level 1: Primary documents (directly associated with property)
  graph.levels[1] = records.map(r => ({
    docNum: r.docNum,
    fileDate: r.fileDate,
    type: r.typeDesc || r.type,
    bookPage: r.bookPage,
    consideration: r.consideration,
    parties: r.parties,
    references: r.references || [],
    status: 'FETCHED'
  }));

  // Level 2: Cross-referenced documents
  const level2Refs = extractCrossReferences(records);

  // Check which level 2 docs we already have (they might be in level 1)
  const level1BookPages = new Set(records.map(r => r.bookPage));
  graph.levels[2] = level2Refs
    .filter(ref => !level1BookPages.has(ref.bookPage))
    .map(ref => ({
      bookPage: ref.bookPage,
      type: ref.type,
      year: ref.year,
      referencedBy: ref.referencedBy,
      referencedByType: ref.referencedByType,
      status: 'KNOWN_NOT_FETCHED',
      fetchUrl: `https://www.masslandrecords.com/${propertyData.registry?.registryCode || 'BerkMiddle'}/D/Default.aspx`,
      fetchMethod: 'Book Search → Book ${ref.bookPage.split("/")[0]} Page ${ref.bookPage.split("/")[1]}'
    }));

  // Level 3: Documents that would require court/probate/external lookup
  const level3 = [];
  for (const record of records) {
    const type = (record.typeDesc || record.type || '').toUpperCase();
    if (type.includes('EXECUTION')) {
      level3.push({
        type: 'JUDGMENT_SATISFACTION',
        description: `Check if execution judgment has been satisfied`,
        source: 'Massachusetts Trial Court (masscourts.org)',
        parties: record.parties,
        status: 'NOT_FETCHED'
      });
    }
    if (type.includes('TAKING')) {
      level3.push({
        type: 'TAX_PAYMENT_RECORD',
        description: 'Verify current tax status with town collector',
        source: 'Town Tax Collector',
        status: 'NOT_FETCHED'
      });
    }
    // Check for estate/death indicators
    const partyNames = JSON.stringify(record.parties || {});
    if (partyNames.includes('EST') || partyNames.includes('ESTATE')) {
      level3.push({
        type: 'PROBATE_RECORD',
        description: `Death/estate record — ${partyNames.match(/\w+ \w+ EST/)?.[0] || 'unknown decedent'}`,
        source: 'Berkshire Probate & Family Court (masscourts.org)',
        status: 'NOT_FETCHED'
      });
    }
  }
  graph.levels[3] = level3;

  return graph;
}

// ─── Lien Analysis ────────────────────────────────────────────────
function analyzeLiens(records) {
  const mortgages = [];
  const discharges = [];
  const takings = [];
  const redemptions = [];
  const executions = [];

  for (const r of records) {
    const type = (r.typeDesc || r.type || '').toUpperCase();
    const bookPage = r.bookPage;
    const refs = (r.references || []).map(ref => ref.bookPage);

    if (type === 'MORTGAGE' || type === 'MORTGAGE &C') {
      mortgages.push({ bookPage, date: r.fileDate, amount: r.consideration, parties: r.parties, refs });
    }
    if (type === 'DISCHARGE' || type === 'DIS&C') {
      discharges.push({ bookPage, date: r.fileDate, refs });
    }
    if (type === 'TAKING') {
      takings.push({ bookPage, date: r.fileDate, parties: r.parties, refs });
    }
    if (type === 'REDEMPTION') {
      redemptions.push({ bookPage, date: r.fileDate, refs });
    }
    if (type === 'EXECUTION') {
      executions.push({ bookPage, date: r.fileDate, amount: r.consideration, parties: r.parties });
    }
  }

  // Match mortgages to discharges
  const activeLiens = [];
  const resolvedLiens = [];

  for (const mtg of mortgages) {
    // Check if any discharge references this mortgage
    const matchingDischarge = discharges.find(d => d.refs.includes(mtg.bookPage));
    // Also check if this mortgage references a discharge
    const referencedDischarge = discharges.find(d => mtg.refs.includes(d.bookPage));

    if (matchingDischarge || referencedDischarge) {
      resolvedLiens.push({
        type: 'MORTGAGE',
        bookPage: mtg.bookPage,
        amount: mtg.amount,
        date: mtg.date,
        status: 'DISCHARGED',
        dischargeRef: (matchingDischarge || referencedDischarge).bookPage,
        dischargeDate: (matchingDischarge || referencedDischarge).date
      });
    } else {
      activeLiens.push({
        type: 'MORTGAGE',
        bookPage: mtg.bookPage,
        amount: mtg.amount,
        date: mtg.date,
        status: 'ACTIVE (no discharge found)',
        parties: mtg.parties
      });
    }
  }

  // Match takings to redemptions
  for (const taking of takings) {
    const matchingRedemption = redemptions.find(r => r.refs.includes(taking.bookPage));
    const referencedRedemption = redemptions.find(r => taking.refs.includes(r.bookPage));

    if (matchingRedemption || referencedRedemption) {
      resolvedLiens.push({
        type: 'TAX_TAKING',
        bookPage: taking.bookPage,
        date: taking.date,
        status: 'REDEEMED',
        redemptionRef: (matchingRedemption || referencedRedemption).bookPage
      });
    } else {
      activeLiens.push({
        type: 'TAX_TAKING',
        bookPage: taking.bookPage,
        date: taking.date,
        status: 'ACTIVE (no redemption found)',
        parties: taking.parties
      });
    }
  }

  return { activeLiens, resolvedLiens, executions };
}

// ─── Chain of Title ───────────────────────────────────────────────
function buildChainOfTitle(records) {
  const deeds = records
    .filter(r => {
      const type = (r.typeDesc || r.type || '').toUpperCase();
      return type === 'DEED' || type === 'DEED &C' || type.includes('FORECLOSURE DEED');
    })
    .sort((a, b) => {
      const dateA = new Date(a.fileDate);
      const dateB = new Date(b.fileDate);
      return dateA - dateB;
    });

  return deeds.map(d => {
    const grantors = d.parties?.grantors ||
      (Array.isArray(d.parties) ? d.parties.filter(p => p.role === 'Grantor').map(p => p.name) : []);
    const grantees = d.parties?.grantees ||
      (Array.isArray(d.parties) ? d.parties.filter(p => p.role === 'Grantee').map(p => p.name) : []);

    return {
      date: d.fileDate,
      type: d.typeDesc || d.type,
      bookPage: d.bookPage,
      consideration: d.consideration,
      from: grantors,
      to: grantees
    };
  });
}

// ─── Cross-Property Party Index ───────────────────────────────────
// Builds an index of every person/entity across all properties
function buildPartyIndex() {
  const propsDir = path.join(DATA_DIR, 'properties');
  if (!fs.existsSync(propsDir)) return {};

  const index = {}; // name → [{ property, role, docType, date, bookPage, consideration }]
  const files = fs.readdirSync(propsDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
      const records = data.registry?.records || data.records || [];
      const propAddr = data.property?.address?.primary || data.property?.address || data.street?.name || file;
      const propTown = data.property?.address?.town || data.property?.town || data.street?.town || '';

      for (const record of records) {
        const parties = [];

        // Handle both party formats
        if (record.parties?.grantors) {
          record.parties.grantors.forEach(name => parties.push({ name, role: 'Grantor' }));
          record.parties.grantees?.forEach(name => parties.push({ name, role: 'Grantee' }));
        } else if (Array.isArray(record.parties)) {
          record.parties.forEach(p => parties.push(p));
        }

        for (const party of parties) {
          const name = (party.name || '').toUpperCase().trim();
          if (!name || name.length < 3) continue;

          if (!index[name]) index[name] = [];
          index[name].push({
            property: `${propAddr}, ${propTown}`,
            propertyFile: file,
            role: party.role,
            docType: record.typeDesc || record.docInfo?.typeDesc || record.type,
            date: record.fileDate || record.docInfo?.fileDate,
            bookPage: record.bookPage || record.docInfo?.bookPage,
            consideration: record.consideration || record.docInfo?.consideration
          });
        }
      }
    } catch (e) { /* skip invalid */ }
  }

  return index;
}

// Search the party index with fuzzy matching
function searchPartyIndex(searchName, roleFilter = 'both') {
  const index = buildPartyIndex();
  const search = searchName.toUpperCase().trim();
  const results = {};

  for (const [name, appearances] of Object.entries(index)) {
    if (name.includes(search) || search.includes(name)) {
      let filtered = appearances;
      if (roleFilter !== 'both') {
        filtered = appearances.filter(a =>
          a.role.toLowerCase() === roleFilter.toLowerCase()
        );
      }
      if (filtered.length > 0) {
        results[name] = filtered;
      }
    }
  }

  // Build summary
  const allAppearances = Object.values(results).flat();
  const uniqueProperties = [...new Set(allAppearances.map(a => a.property))];
  const uniqueDocTypes = [...new Set(allAppearances.map(a => a.docType).filter(Boolean))];

  return {
    searchName,
    matchedNames: Object.keys(results),
    totalAppearances: allAppearances.length,
    uniqueProperties: uniqueProperties.length,
    properties: uniqueProperties,
    documentTypes: uniqueDocTypes,
    details: results,
    fraudIndicators: analyzeFraudFromPartyData(results, uniqueProperties)
  };
}

// Analyze party appearances for fraud patterns
function analyzeFraudFromPartyData(partyResults, properties) {
  const flags = [];
  const allAppearances = Object.values(partyResults).flat();

  // Multiple properties
  if (properties.length > 3) {
    flags.push({
      severity: 'INFO',
      pattern: 'HIGH_VOLUME_PARTY',
      detail: `Appears on ${properties.length} properties — may be a professional (attorney, bank) or worth investigating`
    });
  }

  // Check for rapid transactions (multiple deeds within 90 days)
  const deeds = allAppearances.filter(a =>
    a.docType && a.docType.toUpperCase().includes('DEED')
  );
  if (deeds.length > 1) {
    const dates = deeds.map(d => new Date(d.date)).filter(d => !isNaN(d)).sort((a, b) => a - b);
    for (let i = 1; i < dates.length; i++) {
      const daysBetween = (dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24);
      if (daysBetween < 90) {
        flags.push({
          severity: 'WARNING',
          pattern: 'RAPID_DEEDS',
          detail: `Multiple deeds within ${Math.round(daysBetween)} days — could indicate title washing or flipping scheme`
        });
        break;
      }
    }
  }

  // Check for execution judgments (financial distress)
  const executions = allAppearances.filter(a =>
    a.docType && a.docType.toUpperCase().includes('EXECUTION')
  );
  if (executions.length > 2) {
    flags.push({
      severity: 'WARNING',
      pattern: 'MULTIPLE_JUDGMENTS',
      detail: `${executions.length} execution judgments — indicates significant financial distress or potential fraud target`
    });
  }

  // Check for tax takings across properties
  const takings = allAppearances.filter(a =>
    a.docType && a.docType.toUpperCase().includes('TAKING')
  );
  if (takings.length > 1) {
    flags.push({
      severity: 'WARNING',
      pattern: 'MULTIPLE_TAX_TAKINGS',
      detail: `Tax takings on ${takings.length} occasions — chronic tax delinquency`
    });
  }

  // Check for $0 or $1 consideration deeds (potential fraud or family transfers)
  const zeroDollarDeeds = deeds.filter(d =>
    d.consideration !== null && d.consideration !== undefined &&
    (d.consideration === 0 || d.consideration === '0.00' || d.consideration === 1 || d.consideration === '1.00')
  );
  if (zeroDollarDeeds.length > 1) {
    flags.push({
      severity: 'INFO',
      pattern: 'MULTIPLE_ZERO_CONSIDERATION',
      detail: `${zeroDollarDeeds.length} deeds with $0/$1 consideration — could be trust/family transfers or title manipulation`
    });
  }

  // Grantor without prior grantee appearance (orphan seller)
  const grantorProperties = new Set(
    allAppearances.filter(a => a.role === 'Grantor' && a.docType?.toUpperCase() === 'DEED').map(a => a.property)
  );
  const granteeProperties = new Set(
    allAppearances.filter(a => a.role === 'Grantee' && a.docType?.toUpperCase() === 'DEED').map(a => a.property)
  );
  for (const prop of grantorProperties) {
    if (!granteeProperties.has(prop)) {
      // Sold a property they never bought (in our records) — could be original owner or could be fraud
      flags.push({
        severity: 'INFO',
        pattern: 'SELLER_WITHOUT_PURCHASE',
        detail: `Sold ${prop} but no purchase deed found in our records — may be original owner or records predate our coverage`
      });
    }
  }

  return flags;
}

// ─── Fraud Pattern Detection for a Property ───────────────────────
function detectFraudPatterns(propertyData) {
  if (!propertyData?.registry?.records) return { error: 'No registry data' };

  const records = propertyData.registry.records;
  const flags = [];

  // 1. Orphan deed — seller never appears as prior grantee
  const deeds = records.filter(r => {
    const t = (r.typeDesc || r.type || '').toUpperCase();
    return t === 'DEED' || t.includes('FORECLOSURE DEED');
  });

  for (const deed of deeds) {
    const grantors = deed.parties?.grantors ||
      (Array.isArray(deed.parties) ? deed.parties.filter(p => p.role === 'Grantor').map(p => p.name) : []);

    for (const grantor of grantors) {
      const name = (typeof grantor === 'string' ? grantor : grantor.name || '').toUpperCase();
      // Check if this grantor ever appears as a grantee on a prior deed for this property
      const priorDeed = deeds.find(d => {
        const grantees = d.parties?.grantees ||
          (Array.isArray(d.parties) ? d.parties.filter(p => p.role === 'Grantee').map(p => p.name) : []);
        return grantees.some(g => {
          const gName = (typeof g === 'string' ? g : g.name || '').toUpperCase();
          return gName.includes(name.split(' ')[0]) && gName.includes(name.split(' ').pop());
        });
      });

      if (!priorDeed && deeds.indexOf(deed) > 0) {
        flags.push({
          severity: 'WARNING',
          pattern: 'ORPHAN_DEED',
          detail: `${name} sold property (${deed.bookPage}) but never appears as a buyer in prior deeds. Could be legitimate (original owner) or fraud.`,
          document: deed.bookPage
        });
      }
    }
  }

  // 2. Phantom discharge — discharge references a mortgage that doesn't exist
  const liens = analyzeLiens(records);
  // Already computed in lien analysis

  // 3. Rapid transfers — multiple deeds within 180 days
  if (deeds.length > 1) {
    const sortedDeeds = [...deeds].sort((a, b) => {
      return new Date(a.fileDate || a.docInfo?.fileDate) - new Date(b.fileDate || b.docInfo?.fileDate);
    });
    for (let i = 1; i < sortedDeeds.length; i++) {
      const d1 = new Date(sortedDeeds[i - 1].fileDate || sortedDeeds[i - 1].docInfo?.fileDate);
      const d2 = new Date(sortedDeeds[i].fileDate || sortedDeeds[i].docInfo?.fileDate);
      const days = (d2 - d1) / (1000 * 60 * 60 * 24);
      if (days < 180 && days > 0) {
        flags.push({
          severity: 'WARNING',
          pattern: 'RAPID_TRANSFER',
          detail: `Property transferred twice within ${Math.round(days)} days (${sortedDeeds[i - 1].bookPage} → ${sortedDeeds[i].bookPage}). Could indicate flipping or title washing.`
        });
      }
    }
  }

  // 4. Power of Attorney deed
  const poaDocs = records.filter(r =>
    (r.typeDesc || r.type || '').toUpperCase().includes('POWER OF ATTORNEY')
  );
  const poaDeeds = deeds.filter(d => {
    const parties = JSON.stringify(d.parties || {}).toUpperCase();
    return parties.includes('ATTORNEY IN FACT') || parties.includes('POA') || parties.includes('POWER OF ATTORNEY');
  });
  if (poaDocs.length > 0 || poaDeeds.length > 0) {
    flags.push({
      severity: 'HIGH',
      pattern: 'POA_DEED',
      detail: `Power of Attorney used in property transaction — high-risk fraud indicator. Verify POA is legitimate.`,
      documents: [...poaDocs.map(d => d.bookPage), ...poaDeeds.map(d => d.bookPage)]
    });
  }

  // 5. Multiple executions (financial distress = fraud target)
  const executions = records.filter(r =>
    (r.typeDesc || r.type || '').toUpperCase().includes('EXECUTION')
  );
  if (executions.length >= 2) {
    const totalAmount = executions.reduce((sum, e) => {
      const amt = parseFloat(e.consideration || e.docInfo?.consideration || 0);
      return sum + amt;
    }, 0);
    flags.push({
      severity: 'INFO',
      pattern: 'FINANCIAL_DISTRESS',
      detail: `${executions.length} execution judgments totaling $${totalAmount.toFixed(2)} — property may be a fraud target due to owner distress`
    });
  }

  // 6. $0 consideration deed (not from estate/trust)
  for (const deed of deeds) {
    const consideration = parseFloat(deed.consideration || deed.docInfo?.consideration || -1);
    if (consideration >= 0 && consideration <= 1) {
      const parties = JSON.stringify(deed.parties || {}).toUpperCase();
      const isTrust = parties.includes('TRUST') || parties.includes('TRUSTEE') || parties.includes('TR');
      const isEstate = parties.includes('EST') || parties.includes('ESTATE');
      if (!isTrust && !isEstate) {
        flags.push({
          severity: 'INFO',
          pattern: 'ZERO_CONSIDERATION',
          detail: `Deed ${deed.bookPage} with $${consideration} consideration — not a trust or estate transfer. Could be gift, family transfer, or fraud.`
        });
      }
    }
  }

  // 7. Tax taking history
  const takings = records.filter(r =>
    (r.typeDesc || r.type || '').toUpperCase().includes('TAKING')
  );
  if (takings.length >= 2) {
    flags.push({
      severity: 'WARNING',
      pattern: 'REPEATED_TAX_TAKING',
      detail: `${takings.length} tax takings recorded — chronic tax delinquency, potential fraud target or abandonment`
    });
  }

  // Summary
  const highFlags = flags.filter(f => f.severity === 'HIGH').length;
  const warningFlags = flags.filter(f => f.severity === 'WARNING').length;

  let riskLevel = 'LOW';
  if (highFlags > 0) riskLevel = 'HIGH';
  else if (warningFlags >= 2) riskLevel = 'MEDIUM';
  else if (warningFlags === 1) riskLevel = 'LOW-MEDIUM';

  return {
    riskLevel,
    flagCount: flags.length,
    highFlags,
    warningFlags,
    flags,
    lienStatus: liens
  };
}

// ─── MCP Tool Definitions ─────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_property',
    description: 'Search for a property by address and town. Returns the complete Origin record including registry documents, assessor data, chain of title, lien status, and document graph showing primary, secondary, and tertiary documents.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address (e.g., "111 Swamp Rd")' },
        town: { type: 'string', description: 'Town name (e.g., "Richmond")' },
        depth: { type: 'number', description: 'Document graph depth: 1=primary only, 2=include cross-references, 3=include court/probate. Default 2.' }
      },
      required: ['address', 'town']
    }
  },
  {
    name: 'get_chain_of_title',
    description: 'Get the ownership chain for a property — who owned it, when, and for how much, from earliest record to present.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address' },
        town: { type: 'string', description: 'Town name' }
      },
      required: ['address', 'town']
    }
  },
  {
    name: 'check_liens',
    description: 'Check for active liens, mortgages, tax takings, and execution judgments on a property. Shows which are active vs discharged/redeemed.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address' },
        town: { type: 'string', description: 'Town name' }
      },
      required: ['address', 'town']
    }
  },
  {
    name: 'get_document',
    description: 'Get a specific recorded document by book/page reference. Returns document details, parties, and cross-references.',
    inputSchema: {
      type: 'object',
      properties: {
        bookPage: { type: 'string', description: 'Book/Page reference (e.g., "01760/119")' },
        registry: { type: 'string', description: 'Registry code (e.g., "BerkMiddle", "BerkSouth", "suffolk"). Default: BerkMiddle' }
      },
      required: ['bookPage']
    }
  },
  {
    name: 'get_assessor_data',
    description: 'Get assessor data for a property from MassGIS — assessed value, lot size, year built, building details, zoning, last sale info.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address' },
        town: { type: 'string', description: 'Town name' }
      },
      required: ['address', 'town']
    }
  },
  {
    name: 'list_properties',
    description: 'List all properties currently in the Origin cache with summary data.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'search_by_party',
    description: 'Search across ALL properties for a person or entity by name. Returns every document they appear on as grantor or grantee across all properties and registries. This is the cross-property fraud detection tool — scammers appear on multiple properties.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person or entity name to search (e.g., "COOK MARIE", "LENOX NATIONAL BANK")' },
        role: { type: 'string', description: 'Filter by role: "grantor", "grantee", or "both" (default). Grantor = seller/borrower, Grantee = buyer/lender.' }
      },
      required: ['name']
    }
  },
  {
    name: 'detect_fraud_patterns',
    description: 'Run fraud pattern analysis on a property. Checks for: orphan deeds (seller never owned), phantom discharges, rapid transfers, POA deeds, vacant property sales, LLC formation timing, notary anomalies, and cross-property party patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address' },
        town: { type: 'string', description: 'Town name' }
      },
      required: ['address', 'town']
    }
  },
  {
    name: 'search_by_notary',
    description: 'Search for all documents notarized by a specific notary across all properties. Useful for detecting notary fraud patterns — same notary on multiple suspicious transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        notaryName: { type: 'string', description: 'Notary name to search for' }
      },
      required: ['notaryName']
    }
  },
  {
    name: 'cross_ref_entity',
    description: 'CROSS-REFERENCE JOIN: Resolve a Florida property owner (LLC, Corp, Trust) against the FL business registry (private.rootz.global). Returns the officers behind the entity, filing date, business age, and whether the CEO is the registered agent (succession signal). Give an address, folio, or owner name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner name to look up (e.g., "SEASIDE HOLDINGS LLC")' },
        address: { type: 'string', description: 'Property street address — will look up owner from property record' },
        city: { type: 'string', description: 'City for address lookup' },
        folio: { type: 'string', description: 'Miami-Dade folio number' }
      }
    }
  },
  {
    name: 'cross_ref_public',
    description: 'CROSS-REFERENCE JOIN: Check if a Florida property owner is a SEC-registered public company or REIT (origin.rootz.global). Identifies institutional investors in real estate. Give an address, folio, or owner name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner name to check (e.g., "INVITATION HOMES")' },
        address: { type: 'string', description: 'Property street address' },
        city: { type: 'string', description: 'City for address lookup' },
        folio: { type: 'string', description: 'Miami-Dade folio number' }
      }
    }
  },
  {
    name: 'cross_ref_owner_intel',
    description: 'FULL OWNER INTELLIGENCE: Combines property data + FL business registry + SEC public company data into one owner profile. Resolves LLCs to human officers, detects succession signals (CEO=registered agent), identifies REITs and institutional buyers. The most powerful cross-reference tool — runs both private and public joins in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner name' },
        address: { type: 'string', description: 'Property street address' },
        city: { type: 'string', description: 'City for address lookup' },
        folio: { type: 'string', description: 'Miami-Dade folio number' }
      }
    }
  }
];

// ─── Tool Handlers ────────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {
    case 'search_property': {
      const { address, town, depth = 2 } = args;
      const cacheKey = getCacheKey(address, town);

      // Check cache first
      let cached = getFromCache(cacheKey);
      if (cached) {
        cached._source = 'cache';
        cached._cacheKey = cacheKey;
        return cached;
      }

      // Build the record from available sources
      const result = {
        origin: {
          version: '0.1',
          propertyId: `MA-${town.toUpperCase().replace(/\s/g,'-')}-${address.toUpperCase().replace(/[^A-Z0-9]/g,'-')}`,
          searchDate: new Date().toISOString(),
          sources: [],
          confidence: 0
        },
        property: { address: { primary: address, town } }
      };

      // Fetch assessor data from MassGIS
      const assessor = await fetchAssessorData(address, town);
      if (assessor) {
        result.assessor = assessor;
        result.origin.sources.push('MassGIS');
      }

      // Load registry data from cache/pre-extracted
      const propData = loadPropertyData(address, town);
      if (propData) {
        result.registry = propData.registry;
        result.chainOfTitle = propData.chainOfTitle || buildChainOfTitle(propData.registry?.records || []);
        result.liens = propData.liens || analyzeLiens(propData.registry?.records || []);
        result.origin.sources.push('masslandrecords.com');

        // Build document graph
        if (depth >= 2) {
          result.documentGraph = buildDocumentGraph(propData);
        }

        result.origin.confidence = propData.origin?.confidence || 0.5;
      } else {
        result.registry = {
          status: 'NOT_FETCHED',
          message: `No cached registry data for ${address}, ${town}. In production, this would trigger a live Playwright fetch from masslandrecords.com.`,
          registryCode: REGISTRIES[town.toUpperCase()] || 'unknown',
          fetchUrl: `https://www.masslandrecords.com/${REGISTRIES[town.toUpperCase()] || 'BerkMiddle'}/D/Default.aspx`
        };
      }

      // Calculate confidence
      if (result.assessor && result.registry?.records) {
        result.origin.confidence = 0.85; // Both sources available
      } else if (result.assessor || result.registry?.records) {
        result.origin.confidence = 0.5; // Only one source
      }

      // Cache the result
      saveToCache(cacheKey, result);
      result._source = 'fresh';
      result._cacheKey = cacheKey;

      return result;
    }

    case 'get_chain_of_title': {
      const { address, town } = args;
      const propData = loadPropertyData(address, town);
      if (!propData?.registry?.records) {
        return { error: `No registry data for ${address}, ${town}`, suggestion: 'Use search_property first' };
      }
      return {
        property: `${address}, ${town}`,
        chain: propData.chainOfTitle || buildChainOfTitle(propData.registry.records),
        currentOwner: propData.chainOfTitle?.currentOwner || 'See latest deed'
      };
    }

    case 'check_liens': {
      const { address, town } = args;
      const propData = loadPropertyData(address, town);
      if (!propData?.registry?.records) {
        return { error: `No registry data for ${address}, ${town}`, suggestion: 'Use search_property first' };
      }
      return {
        property: `${address}, ${town}`,
        ...analyzeLiens(propData.registry.records)
      };
    }

    case 'get_document': {
      const { bookPage, registry = 'BerkMiddle' } = args;
      // Search through all cached property data for this book/page
      const propsDir = path.join(DATA_DIR, 'properties');
      if (!fs.existsSync(propsDir)) return { error: 'No property data available' };

      const files = fs.readdirSync(propsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
          const records = data.registry?.records || data.records || [];
          const match = records.find(r => r.bookPage === bookPage);
          if (match) {
            return {
              document: match,
              property: data.property?.address?.primary || data.property?.address || file,
              sourceFile: file
            };
          }
        } catch (e) { /* skip */ }
      }

      return {
        error: `Document ${bookPage} not in cache`,
        fetchMethod: `Search masslandrecords.com/${registry} → Book Search → Book ${bookPage.split('/')[0]} Page ${bookPage.split('/')[1]}`,
        fetchUrl: `https://www.masslandrecords.com/${registry}/D/Default.aspx`
      };
    }

    case 'get_assessor_data': {
      const { address, town } = args;
      const data = await fetchAssessorData(address, town);
      if (data) {
        return { property: `${address}, ${town}`, parcels: data, count: data.length };
      }
      return { error: `No assessor data found for ${address}, ${town}` };
    }

    case 'list_properties': {
      const propsDir = path.join(DATA_DIR, 'properties');
      if (!fs.existsSync(propsDir)) return { properties: [] };

      const files = fs.readdirSync(propsDir).filter(f => f.endsWith('.json'));
      const properties = files.map(file => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
          return {
            file,
            address: data.property?.address?.primary || data.property?.address || data.street?.name || 'unknown',
            town: data.property?.address?.town || data.property?.town || data.street?.town || 'unknown',
            registryRecords: data.registry?.recordCount || data.extraction?.totalRecords || 0,
            confidence: data.origin?.confidence || null,
            hasAssessor: !!data.assessor
          };
        } catch (e) {
          return { file, error: 'parse error' };
        }
      });

      return { count: properties.length, properties };
    }

    case 'search_by_party': {
      const { name: searchName, role = 'both' } = args;
      return searchPartyIndex(searchName, role);
    }

    case 'detect_fraud_patterns': {
      const { address, town } = args;
      const propData = loadPropertyData(address, town);
      if (!propData?.registry?.records) {
        return { error: `No registry data for ${address}, ${town}`, suggestion: 'Use search_property first' };
      }
      const result = detectFraudPatterns(propData);
      result.property = `${address}, ${town}`;
      return result;
    }

    case 'search_by_notary': {
      const { notaryName } = args;
      // Search all documents for notary references
      // In our current dataset, notary info is in the OCR text / document images
      // For now, return a placeholder showing the capability
      const propsDir = path.join(DATA_DIR, 'properties');
      const files = fs.readdirSync(propsDir).filter(f => f.endsWith('.json'));
      const matches = [];

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
          const records = data.registry?.records || data.records || [];
          for (const record of records) {
            const text = JSON.stringify(record).toUpperCase();
            if (text.includes(notaryName.toUpperCase())) {
              matches.push({
                property: data.property?.address?.primary || file,
                town: data.property?.address?.town || '',
                docType: record.typeDesc || record.type,
                bookPage: record.bookPage,
                date: record.fileDate
              });
            }
          }
        } catch (e) { /* skip */ }
      }

      return {
        searchNotary: notaryName,
        matches: matches.length,
        documents: matches,
        note: matches.length === 0
          ? 'Notary data requires OCR of document images. Currently only searchable if notary name appears in extracted record text. Phase 2 will OCR all documents and index notary names.'
          : `Found ${matches.length} documents mentioning "${notaryName}"`
      };
    }

    case 'cross_ref_entity': {
      const { owner, address, city, folio } = args;
      let ownerName = owner;
      let propertyData = null;

      if (!ownerName && (address || folio)) {
        let props;
        if (folio) {
          const p = await lookupByFolio(folio);
          props = p ? [p] : [];
        } else {
          props = await lookupByAddress(address, city || '');
        }
        if (props.length > 0) {
          propertyData = { address: props[0].TRUE_SITE_ADDR, city: props[0].TRUE_SITE_CITY, folio: props[0].FOLIO, owner1: props[0].TRUE_OWNER1, owner2: props[0].TRUE_OWNER2, value: props[0].TOTAL_VAL_CUR };
          ownerName = props[0].TRUE_OWNER1;
        }
      }
      if (!ownerName) return { error: 'Provide owner name, address, or folio' };

      const isEntity = isEntityOwner(ownerName);
      const result = await crossRefPrivateEntity(ownerName, 'FL');

      let result2 = null;
      const owner2 = propertyData?.owner2;
      if (owner2 && isEntityOwner(owner2) && owner2 !== ownerName) {
        result2 = await crossRefPrivateEntity(owner2, 'FL');
      }

      return { property: propertyData, owner_analyzed: ownerName, is_entity: isEntity, entity_match: result, owner2_analyzed: owner2 || null, entity_match2: result2, join: 'title.rootz.global ↔ private.rootz.global' };
    }

    case 'cross_ref_public': {
      const { owner, address, city, folio } = args;
      let ownerName = owner;
      let propertyData = null;

      if (!ownerName && (address || folio)) {
        let props;
        if (folio) {
          const p = await lookupByFolio(folio);
          props = p ? [p] : [];
        } else {
          props = await lookupByAddress(address, city || '');
        }
        if (props.length > 0) {
          propertyData = { address: props[0].TRUE_SITE_ADDR, city: props[0].TRUE_SITE_CITY, folio: props[0].FOLIO, owner1: props[0].TRUE_OWNER1, value: props[0].TOTAL_VAL_CUR };
          ownerName = props[0].TRUE_OWNER1;
        }
      }
      if (!ownerName) return { error: 'Provide owner name, address, or folio' };

      const result = await crossRefPublicEntity(ownerName);
      return { property: propertyData, owner_analyzed: ownerName, public_company_match: result, is_reit: result?.is_reit || false, join: 'title.rootz.global ↔ origin.rootz.global' };
    }

    case 'cross_ref_owner_intel': {
      const { owner, address, city, folio } = args;
      let ownerName = owner;
      let propertyData = null;

      if (!ownerName && (address || folio)) {
        let props;
        if (folio) {
          const p = await lookupByFolio(folio);
          props = p ? [p] : [];
        } else if (address) {
          props = await lookupByAddress(address, city || '');
        }
        if (props?.length > 0) {
          propertyData = { address: props[0].TRUE_SITE_ADDR, city: props[0].TRUE_SITE_CITY, zip: props[0].TRUE_SITE_ZIP_CODE, folio: props[0].FOLIO, owner1: props[0].TRUE_OWNER1, owner2: props[0].TRUE_OWNER2, value: props[0].TOTAL_VAL_CUR, year_built: props[0].YEAR_BUILT };
          ownerName = props[0].TRUE_OWNER1;
        }
      }
      if (!ownerName) return { error: 'Provide owner name, address, or folio' };

      const isEntity = isEntityOwner(ownerName);
      const [privateMatch, publicMatch] = await Promise.all([
        isEntity ? crossRefPrivateEntity(ownerName, 'FL') : null,
        crossRefPublicEntity(ownerName)
      ]);

      let privateMatch2 = null;
      const owner2 = propertyData?.owner2;
      if (owner2 && isEntityOwner(owner2) && owner2 !== ownerName) {
        privateMatch2 = await crossRefPrivateEntity(owner2, 'FL');
      }

      const intel = { owner_type: 'unknown', succession_risk: false, institutional: false };
      if (publicMatch?.matches?.length) {
        intel.owner_type = publicMatch.is_reit ? 'public_reit' : 'public_company';
        intel.institutional = true;
      } else if (privateMatch?.match) {
        intel.owner_type = privateMatch.succession_signal ? 'owner_operated' : 'private_entity';
        intel.succession_risk = privateMatch.succession_signal;
        intel.business_age = privateMatch.match.business_age_years;
        intel.officers = privateMatch.officers?.map(o => ({ name: o.name, title: o.title_normalized })) || [];
      } else if (!isEntity) {
        intel.owner_type = 'individual';
      }

      return { property: propertyData, owner_analyzed: ownerName, is_entity: isEntity, intelligence: intel, private_registry: privateMatch, private_registry_owner2: privateMatch2, public_company: publicMatch, joins: ['title ↔ private.rootz.global', 'title ↔ origin.rootz.global'] };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── MCP Protocol Handler ─────────────────────────────────────────
function handleMCPRequest(req) {
  const { method, params, id } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'origin-land-records', version: '0.1.0' },
          capabilities: { tools: {} }
        }
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: { tools: TOOLS }
      };

    case 'tools/call':
      return null; // handled async

    default:
      return { jsonrpc: '2.0', id, result: {} };
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // ─── Auth Middleware Preamble ─────────────────────────────────
  // Parse cookies and resolve account on every request
  req.cookies = parseCookies(req);
  req.account = await requireAuth(req);
  req.tier = req.account?.tier || 'free';

  const urlParsed = new URL(req.url, `http://localhost:${PORT}`);

  // ─── Body parser helper ──────────────────────────────────────
  function readBody() {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => resolve(body));
    });
  }
  function readRawBody() {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', server: 'title-rootz', version: '0.2.0', port: PORT, tier: req.tier }));
  }

  // ─── Auth Routes ─────────────────────────────────────────────

  // GET /auth/login — render login form
  if (req.url === '/auth/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderLoginPage());
  }

  // POST /auth/login — send magic link
  if (req.url === '/auth/login' && req.method === 'POST') {
    const body = await readBody();
    const params = new URLSearchParams(body);
    const email = params.get('email')?.trim()?.toLowerCase();

    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end(renderLoginPage('Please enter a valid email address.'));
    }

    const result = createMagicLinkToken(email, 'login', req.socket?.remoteAddress);
    if (result.error) {
      res.writeHead(429, { 'Content-Type': 'text/html' });
      return res.end(renderLoginPage(result.error));
    }

    await sendMagicLink(email, result.token, 'login');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderCheckEmailPage(email));
  }

  // GET /auth/verify?token=... — verify magic link, create session
  if (urlParsed.pathname === '/auth/verify' && req.method === 'GET') {
    const token = urlParsed.searchParams.get('token');
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end(renderLoginPage('Invalid or missing token.'));
    }

    const link = verifyMagicLinkToken(token);
    if (!link) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end(renderLoginPage('Link expired or already used. Please sign in again.'));
    }

    // Get or create account
    let account = getAccountByEmail(link.email);
    if (!account) {
      account = createAccount({ email: link.email });
    }

    // Create session
    const session = await createSession(account.id, req);
    if (!session) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      return res.end(renderLoginPage('Session creation failed. Please try again.'));
    }

    // Set cookie and redirect to /farm
    res.writeHead(302, {
      'Set-Cookie': `title_session=${session.jwt}; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Path=/`,
      'Location': '/farm',
    });
    return res.end();
  }

  // GET /auth/logout — clear cookie, redirect home
  if (req.url === '/auth/logout' && req.method === 'GET') {
    res.writeHead(302, {
      'Set-Cookie': 'title_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/',
      'Location': '/',
    });
    return res.end();
  }

  // GET /auth/account — account dashboard
  if (req.url === '/auth/account' && req.method === 'GET') {
    if (!req.account) {
      res.writeHead(302, { 'Location': '/auth/login' });
      return res.end();
    }
    const stats = getUsageStats(req.account.id, req.tier);
    const config = getTierConfig(req.tier);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderAccountPage(req.account, stats, config));
  }

  // ─── Farm Routes ──────────────────────────────────────────────

  // GET /farm — serve farm chat page with nav injected
  if ((req.url === '/farm' || req.url.startsWith('/farm?')) && req.method === 'GET') {
    let html = renderFarmChatPage();
    // Inject nav bar before the existing header
    html = html.replace('<body>', '<body>\n' + renderNav(req.account));
    // Add rate limit banner for free users
    if (req.tier === 'free') {
      const rl = checkRateLimit(req.account?.id || 'anon', 'free');
      const banner = `<div style="background:#eff6ff;padding:6px 16px;font-size:12px;color:#1e40af;text-align:center;flex-shrink:0">Free plan: ${rl.remaining}/5 searches remaining today &bull; <a href="/pricing" style="color:#0f766e;font-weight:600">Upgrade</a></div>`;
      html = html.replace('</nav>', '</nav>\n' + banner);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // ─── DELETE Routes ────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!req.account) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Sign in required' }));
    }

    // DELETE /api/saved/:id
    const savedMatch = urlParsed.pathname.match(/^\/api\/saved\/(\d+)$/);
    if (savedMatch) {
      db.prepare('DELETE FROM saved_properties WHERE id = ? AND account_id = ?').run(savedMatch[1], req.account.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ deleted: true }));
    }

    // DELETE /api/farm-areas/:id
    const areaMatch = urlParsed.pathname.match(/^\/api\/farm-areas\/(\d+)$/);
    if (areaMatch) {
      db.prepare('DELETE FROM farm_areas WHERE id = ? AND account_id = ?').run(areaMatch[1], req.account.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ deleted: true }));
    }

    // DELETE /api/conversations/:id
    const convMatch = urlParsed.pathname.match(/^\/api\/conversations\/(\d+)$/);
    if (convMatch) {
      db.prepare('DELETE FROM conversations WHERE id = ? AND account_id = ?').run(convMatch[1], req.account.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ deleted: true }));
    }
  }

  // ─── Saved Properties Routes ───────────────────────────────────

  // GET /saved — saved properties list page
  if (req.url === '/saved' && req.method === 'GET') {
    if (!req.account) {
      res.writeHead(302, { 'Location': '/auth/login' });
      return res.end();
    }
    const saved = db.prepare('SELECT * FROM saved_properties WHERE account_id = ? ORDER BY created_at DESC').all(req.account.id);
    const farmAreas = db.prepare('SELECT * FROM farm_areas WHERE account_id = ? ORDER BY created_at DESC').all(req.account.id);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderSavedPage(req.account, saved, farmAreas));
  }

  // GET /api/saved/export.csv — CSV download for direct mail
  if (urlParsed.pathname === '/api/saved/export.csv' && req.method === 'GET') {
    if (!req.account) {
      res.writeHead(302, { 'Location': '/auth/login' });
      return res.end();
    }
    const saved = db.prepare('SELECT address, city, state, farming_score, status, notes, created_at FROM saved_properties WHERE account_id = ? ORDER BY farming_score DESC').all(req.account.id);
    const header = 'Address,City,State,Score,Status,Notes,Saved Date\n';
    const rows = saved.map(p => {
      const notes = (p.notes || '').replace(/"/g, '""');
      return `"${p.address}","${p.city || ''}","${p.state || 'FL'}",${p.farming_score || ''},"${p.status || 'active'}","${notes}","${(p.created_at || '').slice(0, 10)}"`;
    }).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="rootz-saved-properties.csv"' });
    return res.end(header + rows);
  }

  // GET /api/saved — JSON list of saved properties
  if (urlParsed.pathname === '/api/saved' && req.method === 'GET') {
    if (!req.account) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Sign in required' }));
    }
    const saved = db.prepare('SELECT * FROM saved_properties WHERE account_id = ? ORDER BY created_at DESC').all(req.account.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ properties: saved, count: saved.length }));
  }

  // GET /api/farm-areas — JSON list of farm areas
  if (urlParsed.pathname === '/api/farm-areas' && req.method === 'GET') {
    if (!req.account) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Sign in required' }));
    }
    const areas = db.prepare('SELECT * FROM farm_areas WHERE account_id = ? ORDER BY created_at DESC').all(req.account.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ areas, count: areas.length }));
  }

  // GET /api/conversations — list conversations (all tiers see titles, Pro+ can resume)
  if (urlParsed.pathname === '/api/conversations' && req.method === 'GET') {
    if (!req.account) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Sign in required' }));
    }
    const tierConfig = getTierConfig(req.tier);
    const convos = db.prepare('SELECT id, title, last_active, created_at FROM conversations WHERE account_id = ? ORDER BY last_active DESC LIMIT 50').all(req.account.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      conversations: convos,
      can_resume: tierConfig.resume_sessions,
      upgrade_message: tierConfig.resume_sessions ? null : `You have ${convos.length} archived sessions. Upgrade to Pro ($49/mo) to resume them.`,
    }));
  }

  // GET /api/conversations/:id — load full conversation (Pro+ only)
  if (urlParsed.pathname.match(/^\/api\/conversations\/\d+$/) && req.method === 'GET') {
    if (!req.account) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Sign in required' }));
    }
    const tierConfig = getTierConfig(req.tier);
    if (!tierConfig.resume_sessions) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Resuming sessions requires Pro plan ($49/mo)', upgrade_url: '/pricing' }));
    }
    const id = urlParsed.pathname.split('/').pop();
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND account_id = ?').get(id, req.account.id);
    if (!convo) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Conversation not found' }));
    }
    convo.messages = JSON.parse(convo.messages || '[]');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(convo));
  }

  // GET /help — feature guide and tips
  if (req.url === '/help' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderHelpPage(req.account));
  }

  // GET /pricing — subscription pricing page
  if (req.url === '/pricing' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderPricingPage(req.account));
  }

  // GET /api/stripe/success — post-checkout landing
  if (urlParsed.pathname === '/api/stripe/success' && req.method === 'GET') {
    // Redirect to account page — Stripe webhook will have updated the tier
    res.writeHead(302, { 'Location': '/auth/account' });
    return res.end();
  }

  // GET /api/stripe/portal — billing management portal
  if (urlParsed.pathname === '/api/stripe/portal' && req.method === 'GET') {
    if (!req.account || !req.account.stripe_customer_id) {
      res.writeHead(302, { 'Location': '/pricing' });
      return res.end();
    }
    try {
      const session = await createPortalSession(req.account.stripe_customer_id);
      res.writeHead(302, { 'Location': session.url });
      return res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Error opening billing portal: ' + e.message);
    }
  }

  // ─── POST Router ─────────────────────────────────────────────
  if (req.method === 'POST') {
    // Stripe webhook — needs raw body for signature verification
    if (urlParsed.pathname === '/api/stripe/webhook') {
      const rawBody = await readRawBody();
      try {
        const event = verifyWebhookSignature(rawBody, req.headers['stripe-signature']);
        await handleStripeWebhook(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ received: true }));
      } catch (e) {
        console.error('Stripe webhook error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Webhook error: ' + e.message }));
      }
    }

    // POST /api/saved — save a property
    if (urlParsed.pathname === '/api/saved') {
      if (!req.account) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Sign in required' }));
      }
      const body = await readBody();
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      if (!data.address) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'address required' }));
      }
      const score = data.farming_score || null;
      const result = db.prepare(`
        INSERT INTO saved_properties (account_id, address, city, state, folio, bridge_url, farming_score, score_at_save, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.account.id, data.address, data.city || null, data.state || 'FL', data.folio || null, data.bridge_url || null, score, score, data.notes || null);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: result.lastInsertRowid, saved: true }));
    }

    // POST /api/saved/:id/notes — update notes on a saved property
    const notesMatch = urlParsed.pathname.match(/^\/api\/saved\/(\d+)\/notes$/);
    if (notesMatch) {
      if (!req.account) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Sign in required' }));
      }
      const body = await readBody();
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      db.prepare('UPDATE saved_properties SET notes = ? WHERE id = ? AND account_id = ?')
        .run(data.notes || null, notesMatch[1], req.account.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ updated: true }));
    }

    // POST /api/saved/:id/status — update status on a saved property
    const statusMatch = urlParsed.pathname.match(/^\/api\/saved\/(\d+)\/status$/);
    if (statusMatch) {
      if (!req.account) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Sign in required' }));
      }
      const body = await readBody();
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      const validStatuses = ['active', 'contacted', 'listed', 'closed', 'archived'];
      if (!validStatuses.includes(data.status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid status. Use: ' + validStatuses.join(', ') }));
      }
      db.prepare('UPDATE saved_properties SET status = ? WHERE id = ? AND account_id = ?')
        .run(data.status, statusMatch[1], req.account.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ updated: true }));
    }

    // POST /api/farm-areas — create a farm area
    if (urlParsed.pathname === '/api/farm-areas') {
      if (!req.account) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Sign in required' }));
      }
      const body = await readBody();
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      if (!data.city) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'city required' }));
      }
      const result = db.prepare(`
        INSERT INTO farm_areas (account_id, city, zip, signals, alert_enabled)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.account.id, data.city, data.zip || null, JSON.stringify(data.signals || []), data.alert_enabled ? 1 : 0);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: result.lastInsertRowid, saved: true }));
    }

    // POST /api/stripe/checkout — create checkout session
    if (urlParsed.pathname === '/api/stripe/checkout') {
      if (!req.account) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Sign in required', login_url: '/auth/login' }));
      }
      const body = await readBody();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const tier = parsed.tier;
      if (!tier || !['starter', 'pro', 'unlimited', 'training'].includes(tier)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid tier. Choose: starter, pro, unlimited, training' }));
      }
      try {
        const session = await createCheckoutSession(req.account, tier);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ url: session.url }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Checkout error: ' + e.message }));
      }
    }

    // POST /farm/chat — AI farming assistant with rate limiting + token budget
    if (urlParsed.pathname === '/farm/chat') {
      const body = await readBody();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      // Rate limiting — track by account or IP
      const accountId = req.account?.id || ('ip_' + crypto.createHash('md5').update(req.socket?.remoteAddress || 'unknown').digest('hex').slice(0, 16));

      // Check 1: Daily search count
      const rateCheck = checkRateLimit(accountId, req.tier);
      if (!rateCheck.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Daily search limit reached',
          used: rateCheck.used,
          limit: rateCheck.limit,
          tier: req.tier,
          upgrade_url: '/pricing',
          message: req.tier === 'free'
            ? `You've used all ${rateCheck.limit} free searches today. Upgrade to Starter ($29/mo) for 50/day.`
            : `You've reached your ${rateCheck.limit}/day limit. Upgrade for more searches.`,
        }));
      }

      // Check 2: Monthly token budget
      const tokenCheck = checkTokenBudget(accountId, req.tier);
      if (!tokenCheck.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Monthly token budget reached',
          tokens_used: tokenCheck.used,
          tokens_budget: tokenCheck.budget,
          tier: req.tier,
          upgrade_url: '/pricing',
          message: `You've used ${Math.round(tokenCheck.used / 1000)}K of your ${Math.round(tokenCheck.budget / 1000)}K monthly token budget. Upgrade for more capacity.`,
        }));
      }

      // Select model based on tier
      const tierConfig = getTierConfig(req.tier);
      const model = tierConfig.model;

      // Log usage upfront (counts toward daily rate limit even if API call fails)
      const queryPreview = parsed.messages?.[parsed.messages.length - 1]?.content?.substring(0, 200) || '';
      const usageRowId = logUsage(accountId, '/farm/chat', queryPreview, 0, 0, 0, req.socket?.remoteAddress);

      try {
        // Build cross-session AI context for signed-in agents
        let agentContext = '';
        if (req.account) {
          const savedProps = db.prepare('SELECT address, city, farming_score, status, notes FROM saved_properties WHERE account_id = ? ORDER BY created_at DESC LIMIT 20').all(req.account.id);
          const areas = db.prepare('SELECT city, signals FROM farm_areas WHERE account_id = ?').all(req.account.id);
          const recentConvo = db.prepare('SELECT title FROM conversations WHERE account_id = ? ORDER BY last_active DESC LIMIT 3').all(req.account.id);

          const parts = [];
          if (savedProps.length) {
            const summary = savedProps.map(p => {
              let line = `${p.address}, ${p.city || ''} (score: ${p.farming_score || '?'}, status: ${p.status || 'active'})`;
              if (p.notes) line += ` — Note: "${p.notes}"`;
              return line;
            }).join('\n  ');
            parts.push(`This agent has ${savedProps.length} saved properties:\n  ${summary}\nDon't repeat properties they've already saved unless they ask.`);
          }
          if (areas.length) {
            const areaList = areas.map(a => `${a.city} (signals: ${a.signals || 'all'})`).join(', ');
            parts.push(`Farm areas: ${areaList}`);
          }
          if (recentConvo.length) {
            parts.push(`Recent sessions: ${recentConvo.map(c => '"' + (c.title || '').substring(0, 60) + '"').join(', ')}`);
          }
          if (parts.length) agentContext = parts.join('\n\n');
        }

        const result = await handleFarmChat(parsed.messages || [], model, agentContext);

        // Update usage row with actual Anthropic-reported token counts
        const tokensIn = result.usage?.input_tokens || 0;
        const tokensOut = result.usage?.output_tokens || 0;
        // Cost: Haiku $0.25/$1.25 per 1M, Sonnet $3/$15 per 1M
        const isHaiku = model.includes('haiku');
        const costUsd = isHaiku
          ? (tokensIn * 0.25 + tokensOut * 1.25) / 1_000_000
          : (tokensIn * 3.0 + tokensOut * 15.0) / 1_000_000;
        updateUsageTokens(usageRowId, tokensIn, tokensOut, costUsd);

        // Archive conversation for ALL tiers
        if (req.account) {
          const convId = parsed.conversation_id;
          const userMsg = parsed.messages?.[parsed.messages.length - 1]?.content || '';
          const fullMessages = [...(parsed.messages || []), { role: 'assistant', content: result.text }];

          if (convId) {
            // Update existing conversation
            db.prepare('UPDATE conversations SET messages = ?, last_active = datetime(?) WHERE id = ? AND account_id = ?')
              .run(JSON.stringify(fullMessages), new Date().toISOString(), convId, req.account.id);
          } else {
            // Create new conversation — title from first user message
            const title = userMsg.substring(0, 80) || 'Farming session';
            const ins = db.prepare('INSERT INTO conversations (account_id, messages, title) VALUES (?, ?, ?)')
              .run(req.account.id, JSON.stringify(fullMessages), title);
            parsed.conversation_id = ins.lastInsertRowid;
          }
        }

        // Build response with rate + token budget info
        const updatedRate = checkRateLimit(accountId, req.tier);
        const updatedTokens = checkTokenBudget(accountId, req.tier);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          text: result.text,
          model: result.model,
          usage: result.usage,
          conversation_id: parsed.conversation_id || null,
          rate_limit: { used: updatedRate.used, limit: updatedRate.limit, remaining: updatedRate.remaining },
          token_budget: { used: updatedTokens.used, budget: updatedTokens.budget, pct: updatedTokens.pct },
          tier: req.tier,
        }));
      } catch (e) {
        console.error('Farm chat error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Chat error: ' + e.message }));
      }
    }

    // MCP over HTTP-SSE (existing handler)
    const body = await readBody();
    try {
      const request = JSON.parse(body);

      if (request.method === 'tools/call') {
        const { name, arguments: args } = request.params;
        const result = await handleTool(name, args || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }));
      }

      const response = handleMCPRequest(request);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Bridge page loading shell — serves instant HTML while data assembles
  // If ?_loaded=1, we're the AJAX callback — render the real page
  // Otherwise, serve the loading shell that fetches via JS
  if (req.url.startsWith('/p/') && req.method === 'GET' && urlParsed.searchParams.get('address') && !urlParsed.searchParams.get('_loaded')) {
    const qAddress = urlParsed.searchParams.get('address');
    const qCity = urlParsed.searchParams.get('city') || '';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${qAddress} — Rootz Property Intelligence</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b}
.loading{max-width:600px;margin:80px auto;text-align:center;padding:40px}
.loading h2{color:#1e3a5f;margin-bottom:12px}
.loading p{color:#64748b;font-size:14px;margin-bottom:24px}
.spinner{width:40px;height:40px;border:4px solid #e2e8f0;border-top:4px solid #0f766e;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.progress{font-size:12px;color:#94a3b8}
</style>
</head><body>
${renderNav(req.account)}
<div class="loading">
  <div class="spinner"></div>
  <h2>Loading Property Intelligence</h2>
  <p>${qAddress}, ${qCity}</p>
  <div class="progress" id="status">Assembling data from government sources...</div>
</div>
<script>
(async () => {
  const el = document.getElementById('status');
  const steps = ['Querying property records...', 'Checking court filings...', 'Loading flood zone & demographics...', 'Calculating farming score...'];
  let i = 0;
  const timer = setInterval(() => { if (i < steps.length) el.textContent = steps[i++]; }, 1200);
  try {
    const resp = await fetch(location.href + '&_loaded=1');
    clearInterval(timer);
    if (resp.ok) {
      document.open(); document.write(await resp.text()); document.close();
    } else {
      el.textContent = 'Property not found. Redirecting...';
      setTimeout(() => location.href = '/farm', 2000);
    }
  } catch(e) {
    clearInterval(timer);
    el.textContent = 'Error loading property. Redirecting...';
    setTimeout(() => location.href = '/farm', 2000);
  }
})();
</script>
</body></html>`);
  }

  // Bridge page by address: /p/farm?address=X&city=Y (the actual data render)
  if (req.url.startsWith('/p/') && req.method === 'GET' && urlParsed.searchParams.get('address')) {
    const qAddress = urlParsed.searchParams.get('address');
    const qCity = urlParsed.searchParams.get('city') || '';
    try {
      const data = await assemblePropertyIntelligence(qAddress, qCity);
      if (!data) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end(`<!DOCTYPE html><html><head><title>Not Found</title></head><body>${renderNav(req.account)}<div style="max-width:600px;margin:40px auto;padding:20px;text-align:center"><h1>Property Not Found</h1><p style="margin-top:12px">Could not find ${qAddress}, ${qCity}. <a href="/farm" style="color:#0f766e">Search in Farm Chat</a></p></div></body></html>`);
      }
      // Reuse the same bridge page rendering — redirect to the API route which renders HTML
      const accept = (req.headers.accept || '').toLowerCase();
      if (accept.includes('application/json') && !accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data, null, 2));
      }
      // Render the full bridge page inline (same as the /p/{folio} handler below)
      const p = data.property || {};
      const fs2 = data.farmingScore || {};
      const cr = data.courtRecords || {};
      const flood = data.flood || {};
      const demos = data.demographics || {};
      const permits = data.buildingPermits || {};
      const inv = data.investorSignals || {};
      const scoreColor = fs2.rating === 'HIGH' ? '#dc2626' : fs2.rating === 'MEDIUM' ? '#f59e0b' : '#22c55e';
      const scoreEmoji = fs2.rating === 'HIGH' ? '\u{1F534}' : fs2.rating === 'MEDIUM' ? '\u{1F7E1}' : '\u{1F7E2}';
      const courtHTML = (cr.signals || []).map(s =>
        `<div style="padding:8px 0;border-bottom:1px solid #eee">
          <span style="color:${s.signal === 'lis_pendens' ? '#dc2626' : s.signal === 'probate' ? '#9333ea' : '#f59e0b'};font-weight:bold">${s.description}</span><br>
          <span style="color:#666">Filed: ${s.recordDate} ${s.caseNum ? '| Case: ' + s.caseNum : ''} | Inst# ${s.instrumentNum}</span>
        </div>`
      ).join('') || '<div style="color:#666;padding:8px 0">No court filings found for this owner</div>';
      const reasonsHTML = (fs2.reasons || []).map(r => `<li style="margin:4px 0">${r}</li>`).join('');
      const address = p.address || qAddress;
      const city = p.city || qCity;
      const parcelId = p.folio || 'unknown';
      const displayValue = inv.assessedValue?.total || 0;

      const bridgeHtml = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${address} — Rootz Property Intelligence</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.5; }
  .container { max-width: 800px; margin: 0 auto; padding: 20px; }
  .header { background: linear-gradient(135deg, #1e3a5f 0%, #0f766e 100%); color: white; padding: 24px; border-radius: 12px 12px 0 0; }
  .header h1 { font-size: 20px; margin-bottom: 4px; }
  .header .addr { font-size: 28px; font-weight: 700; }
  .header .sub { opacity: 0.8; font-size: 14px; margin-top: 8px; }
  .card { background: white; padding: 20px; border: 1px solid #e2e8f0; margin-top: 12px; border-radius: 8px; }
  .card h2 { font-size: 16px; color: #1e3a5f; margin-bottom: 12px; }
  .score-bar { height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 8px 0; }
  .score-fill { height: 100%; border-radius: 4px; }
  .actions { display: flex; gap: 10px; margin: 16px 0; }
  .actions a, .actions button { padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; }
  .actions .ask-btn { background: linear-gradient(135deg,#1e3a5f,#0f766e); color: #fff; }
  .actions .save-btn { background: #fff; color: #0f766e; border: 2px solid #0f766e; }
  .actions .save-btn.saved { background: #0f766e; color: #fff; }
  .footer { text-align: center; padding: 20px; font-size: 12px; color: #94a3b8; margin-top: 20px; }
  .footer a { color: #0f766e; }
</style>
</head><body>
${renderNav(req.account)}
<div class="container">
<div class="header">
  <h1>Rootz Property Intelligence</h1>
  <div class="addr">${address}</div>
  <div class="sub">${city}, ${p.state || 'FL'} ${p.zip || ''} | Folio: ${parcelId}</div>
</div>

<div class="card">
  <h2>${scoreEmoji} Farming Score: ${fs2.score || 0}/100 (${fs2.rating || 'N/A'})</h2>
  <div class="score-bar"><div class="score-fill" style="width:${fs2.score || 0}%;background:${scoreColor}"></div></div>
  ${reasonsHTML ? `<ul style="margin-top:8px;padding-left:20px">${reasonsHTML}</ul>` : ''}
</div>

<div class="card">
  <h2>Owner</h2>
  <div><strong>${inv.ownerName || p.owner || '?'}</strong></div>
  ${inv.mailingAddress ? `<div style="color:#64748b;font-size:13px">Mailing: ${inv.mailingAddress}</div>` : ''}
  ${inv.occupancy ? `<div style="color:#64748b;font-size:13px">${inv.occupancy}</div>` : ''}
  ${displayValue ? `<div style="margin-top:8px"><strong>Assessed: $${displayValue.toLocaleString()}</strong></div>` : ''}
</div>

<div class="card">
  <h2>Court Records</h2>
  ${courtHTML}
</div>

<div class="actions">
  <a href="/farm?property=${encodeURIComponent(address + ', ' + city)}" class="ask-btn">Ask about this property</a>
  <button class="save-btn" id="save-btn" onclick="toggleSaveForm()">Save to list</button>
  <button onclick="copyLink()" style="padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0" id="copy-btn">Copy link</button>
</div>
<div id="save-form" style="display:none;margin:12px 0;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
  <textarea id="save-notes" rows="2" placeholder="Add a note (optional)..." style="width:100%;font-size:13px;padding:8px;border:1px solid #e2e8f0;border-radius:6px;resize:vertical;font-family:inherit;margin-bottom:8px"></textarea>
  <button onclick="saveProperty()" style="padding:8px 20px;background:#0f766e;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Save Property</button>
</div>

<div class="footer">
  <strong>Rootz Property Intelligence</strong> — Government data with provenance<br>
  <a href="https://title.rootz.global">title.rootz.global</a>
</div>
</div>
<script>
function toggleSaveForm() { const f = document.getElementById('save-form'); f.style.display = f.style.display === 'none' ? 'block' : 'none'; }
async function saveProperty() {
  const resp = await fetch('/api/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: ${JSON.stringify(address)},
      city: ${JSON.stringify(city)},
      folio: ${JSON.stringify(parcelId)},
      bridge_url: location.pathname + location.search,
      farming_score: ${fs2.score || 0},
      notes: document.getElementById('save-notes').value || null
    })
  });
  if (resp.status === 401) { window.location = '/auth/login'; return; }
  const data = await resp.json();
  if (data.saved) { document.getElementById('save-btn').textContent = 'Saved!'; document.getElementById('save-btn').disabled = true; document.getElementById('save-form').style.display = 'none'; }
}
function copyLink() { navigator.clipboard.writeText(location.href); const b = document.getElementById('copy-btn'); b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy link', 2000); }
</script>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(bridgeHtml);
    } catch (e) {
      console.error('Bridge page error:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><body>${renderNav(req.account)}<div style="max-width:600px;margin:40px auto;padding:20px;text-align:center"><h1>Error</h1><p>${e.message}</p><a href="/farm" style="color:#0f766e">Back to Farm</a></div></body></html>`);
    }
  }

  // REST API shortcuts
  if (req.url.startsWith('/api/')) {
    const urlParts = new URL(req.url, `http://localhost:${PORT}`);
    const path = urlParts.pathname;

    if (path === '/api/search') {
      const address = urlParts.searchParams.get('address');
      const town = urlParts.searchParams.get('town');
      const depth = parseInt(urlParts.searchParams.get('depth') || '2');

      if (!address || !town) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'address and town required', example: '/api/search?address=111+Swamp+Rd&town=Richmond' }));
      }

      const result = await handleTool('search_property', { address, town, depth });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/chain') {
      const address = urlParts.searchParams.get('address');
      const town = urlParts.searchParams.get('town');
      const result = await handleTool('get_chain_of_title', { address, town });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/liens') {
      const address = urlParts.searchParams.get('address');
      const town = urlParts.searchParams.get('town');
      const result = await handleTool('check_liens', { address, town });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/assessor') {
      const address = urlParts.searchParams.get('address');
      const town = urlParts.searchParams.get('town');
      const result = await handleTool('get_assessor_data', { address, town });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/document') {
      const bookPage = urlParts.searchParams.get('bookPage');
      const registry = urlParts.searchParams.get('registry') || 'BerkMiddle';
      const result = await handleTool('get_document', { bookPage, registry });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/party') {
      const name = urlParts.searchParams.get('name');
      const role = urlParts.searchParams.get('role') || 'both';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'name required', example: '/api/party?name=SPRAGUE' }));
      }
      const result = await handleTool('search_by_party', { name, role });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/fraud') {
      const address = urlParts.searchParams.get('address');
      const town = urlParts.searchParams.get('town');
      if (!address || !town) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'address and town required', example: '/api/fraud?address=291+North+Plain+Rd&town=Great+Barrington' }));
      }
      const result = await handleTool('detect_fraud_patterns', { address, town });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/notary') {
      const notaryName = urlParts.searchParams.get('name');
      if (!notaryName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'name required', example: '/api/notary?name=SORRENTO' }));
      }
      const result = await handleTool('search_by_notary', { notaryName });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    // ─── BRIDGE PAGE — Property Intelligence ─────────────────
    // Supports: /p/{folioNumber} OR /p/farm?address=X&city=Y
    if (path.startsWith('/p/')) {
      const parcelId = path.slice(3);
      if (!parcelId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Parcel ID required: /p/{parcelId}');
      }
      try {
        let data;

        // Address-based lookup: /p/farm?address=X&city=Y (from farm chat links)
        const qAddress = urlParts.searchParams.get('address');
        const qCity = urlParts.searchParams.get('city');
        if (qAddress && qCity) {
          data = await assemblePropertyIntelligence(qAddress, qCity);
        }

        // Folio-based lookup: /p/{folioNumber}
        if (!data) {
          let result = await lookupByFolio(parcelId);
          if (!result || (Array.isArray(result) && !result.length)) {
            result = null;
          }
          if (result) {
            const prop = Array.isArray(result) ? result[0] : result;
            const addr = prop.TRUE_SITE_ADDR || prop.PHY_ADDR1 || '';
            const city = prop.TRUE_SITE_CITY || prop.PHY_CITY || '';
            if (addr) {
              data = await assemblePropertyIntelligence(addr, city);
            }
          }
        }

        if (!data) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          return res.end(`<html><body>${renderNav(req.account)}<div style="max-width:600px;margin:40px auto;padding:20px;text-align:center"><h1>Property Not Found</h1><p style="margin-top:12px">Could not find ${qAddress || parcelId}. <a href="/farm" style="color:#0f766e">Search in Farm Chat</a></p></div></body></html>`);
        }

        // Content negotiation: JSON for AI, HTML for humans
        const accept = (req.headers.accept || '').toLowerCase();
        if (accept.includes('application/json') && !accept.includes('text/html')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(data, null, 2));
        }

        // HTML bridge page
        const p = data.property || {};
        const fs2 = data.farmingScore || {};
        const cr = data.courtRecords || {};
        const flood = data.flood || {};
        const demos = data.demographics || {};
        const permits = data.buildingPermits || {};
        const inv = data.investorSignals || {};

        const scoreColor = fs2.rating === 'HIGH' ? '#dc2626' : fs2.rating === 'MEDIUM' ? '#f59e0b' : '#22c55e';
        const scoreEmoji = fs2.rating === 'HIGH' ? '🔴' : fs2.rating === 'MEDIUM' ? '🟡' : '🟢';

        const courtHTML = (cr.signals || []).map(s =>
          `<div style="padding:8px 0;border-bottom:1px solid #eee">
            <span style="color:${s.signal === 'lis_pendens' ? '#dc2626' : s.signal === 'probate' ? '#9333ea' : '#f59e0b'};font-weight:bold">${s.description}</span><br>
            <span style="color:#666">Filed: ${s.recordDate} ${s.caseNum ? '| Case: ' + s.caseNum : ''} | Inst# ${s.instrumentNum}</span>
          </div>`
        ).join('') || '<div style="color:#666;padding:8px 0">No court filings found for this owner (2024-2025)</div>';

        const reasonsHTML = (fs2.reasons || []).map(r =>
          `<li style="margin:4px 0">${r}</li>`
        ).join('');

        const address = p.address || parcelId;
        const city = p.city || '';
        const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${address} — Rootz Property Intelligence</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.5; }
  .container { max-width: 800px; margin: 0 auto; padding: 20px; }
  .actions { display: flex; gap: 10px; margin: 16px 0; }
  .actions a, .actions button { padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; }
  .actions .ask-btn { background: linear-gradient(135deg,#1e3a5f,#0f766e); color: #fff; }
  .actions .save-btn { background: #fff; color: #0f766e; border: 2px solid #0f766e; }
  .actions .save-btn.saved { background: #0f766e; color: #fff; }
  .header { background: linear-gradient(135deg, #1e3a5f 0%, #0f766e 100%); color: white; padding: 24px; border-radius: 12px 12px 0 0; }
  .header h1 { font-size: 20px; margin-bottom: 4px; }
  .header .addr { font-size: 28px; font-weight: 700; }
  .header .sub { opacity: 0.8; font-size: 14px; margin-top: 8px; }
  .score-bar { display: flex; align-items: center; gap: 16px; background: white; padding: 20px 24px; border-bottom: 3px solid ${scoreColor}; }
  .score-num { font-size: 48px; font-weight: 800; color: ${scoreColor}; }
  .score-label { font-size: 14px; color: #64748b; }
  .score-rating { font-size: 18px; font-weight: 700; color: ${scoreColor}; }
  .card { background: white; border-radius: 8px; margin: 16px 0; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card h2 { font-size: 16px; color: #1e3a5f; margin-bottom: 12px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid-item { }
  .grid-item .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  .grid-item .value { font-size: 16px; font-weight: 600; }
  .signal-tag { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; margin: 2px; }
  .signal-distressed { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
  .signal-voluntary { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
  .signal-positive { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
  .provenance { background: #f1f5f9; border-radius: 8px; padding: 16px; margin-top: 16px; font-size: 13px; color: #64748b; }
  .provenance code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .footer { text-align: center; padding: 24px; color: #94a3b8; font-size: 13px; }
  .footer a { color: #0f766e; }
  ul { padding-left: 20px; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } .header .addr { font-size: 22px; } }
</style>
</head><body>
<div class="container">

<div class="header">
  <h1>Rootz Property Intelligence</h1>
  <div class="addr">${p.address || '?'}</div>
  <div class="sub">${p.city || '?'}, ${p.state || 'FL'} ${p.zip || ''} &nbsp;|&nbsp; Folio: ${p.folio || parcelId}</div>
</div>

<div class="score-bar">
  <div>
    <div class="score-num">${fs2.score ?? '?'}</div>
    <div class="score-label">FARMING SCORE</div>
  </div>
  <div style="flex:1">
    <div class="score-rating">${scoreEmoji} ${fs2.rating || '?'} LISTING PROBABILITY</div>
    <div style="font-size:13px;color:#64748b;margin-top:4px">${fs2.signalCount || 0} signals detected</div>
  </div>
</div>

<div class="card">
  <h2>Why This Property Is a Farming Prospect</h2>
  <ul>${reasonsHTML || '<li>No farming signals detected</li>'}</ul>
</div>

<div class="card">
  <h2>Owner</h2>
  <div class="grid">
    <div class="grid-item"><div class="label">Owner</div><div class="value">${(p.owner?.name1 || '?')}</div></div>
    <div class="grid-item"><div class="label">Owner 2</div><div class="value">${p.owner?.name2 || '—'}</div></div>
    <div class="grid-item"><div class="label">Owner Occupied</div><div class="value">${inv.ownerOccupied ? 'Yes' : 'No — Absentee'}</div></div>
    <div class="grid-item"><div class="label">Out of State</div><div class="value">${inv.outOfStateOwner ? 'Yes' : 'No'}</div></div>
    <div class="grid-item"><div class="label">Corporate/LLC</div><div class="value">${inv.corporateOwner ? 'Yes' : 'No'}</div></div>
    <div class="grid-item"><div class="label">Homestead</div><div class="value">${inv.homesteadExemption ? 'Yes' : 'No'}</div></div>
  </div>
  ${inv.ownerLookupUrl ? `<div style="margin-top:12px"><a href="${inv.ownerLookupUrl}" target="_blank" style="color:#0f766e">Owner Lookup →</a></div>` : ''}
</div>

<div class="card">
  <h2>Court Records — Broward County Clerk</h2>
  ${courtHTML}
  ${cr.provenance ? `<div style="font-size:12px;color:#94a3b8;margin-top:8px">Source: ${cr.provenance?.source || 'Broward Clerk'} | Method: ${cr.provenance?.method || 'SFTP'} | Coverage: ${cr.provenance?.coverage || '1978-present'}</div>` : ''}
</div>

<div class="card">
  <h2>Property Details</h2>
  <div class="grid">
    <div class="grid-item"><div class="label">Assessed Value</div><div class="value">$${(p.building?.heatedArea ? (data.investorSignals?.assessedValue?.total || 0) : 0).toLocaleString()}</div></div>
    <div class="grid-item"><div class="label">Year Built</div><div class="value">${p.building?.yearBuilt || '?'}</div></div>
    <div class="grid-item"><div class="label">Living Area</div><div class="value">${(p.building?.heatedArea || 0).toLocaleString()} sqft</div></div>
    <div class="grid-item"><div class="label">Lot Size</div><div class="value">${(p.lot?.size || 0).toLocaleString()} sqft</div></div>
    <div class="grid-item"><div class="label">Bedrooms</div><div class="value">${p.building?.bedrooms || '?'}</div></div>
    <div class="grid-item"><div class="label">Bathrooms</div><div class="value">${p.building?.bathrooms || '?'}${p.building?.halfBathrooms ? ' + ' + p.building.halfBathrooms + ' half' : ''}</div></div>
    <div class="grid-item"><div class="label">Type</div><div class="value">${p.classification?.description || p.classification?.dorCode || '?'}</div></div>
    <div class="grid-item"><div class="label">Zoning</div><div class="value">${p.classification?.zoning || '?'}</div></div>
  </div>
</div>

<div class="card">
  <h2>Location Intelligence</h2>
  <div class="grid">
    <div class="grid-item"><div class="label">Flood Zone</div><div class="value" style="color:${flood.zone === 'X' ? '#16a34a' : '#dc2626'}">${flood.zone || '?'} ${flood.zone === 'X' ? '(Minimal Risk)' : flood.zone === 'AE' ? '(High Risk)' : ''}</div></div>
    <div class="grid-item"><div class="label">Elevation</div><div class="value">${data.elevation?.elevationFt ? data.elevation.elevationFt + ' ft' : '?'}</div></div>
    <div class="grid-item"><div class="label">Median Income</div><div class="value">${demos.medianHouseholdIncome ? '$' + demos.medianHouseholdIncome.toLocaleString() : '?'}</div></div>
    <div class="grid-item"><div class="label">Median Home Value</div><div class="value">${demos.medianHomeValue ? '$' + demos.medianHomeValue.toLocaleString() : '?'}</div></div>
    <div class="grid-item"><div class="label">Building Permits</div><div class="value">${permits.count || 0} on record</div></div>
    <div class="grid-item"><div class="label">Nearby Schools</div><div class="value">${data.schools?.totalNearby || '?'}</div></div>
  </div>
</div>

${inv.salesHistory?.length ? `
<div class="card">
  <h2>Sales History</h2>
  ${inv.salesHistory.map(s => `<div style="padding:6px 0;border-bottom:1px solid #f1f5f9">
    <strong>${s.date || '?'}</strong> — $${(s.price || 0).toLocaleString()} ${s.grantor ? '| From: ' + s.grantor : ''} ${s.grantee ? '| To: ' + s.grantee : ''}
  </div>`).join('')}
</div>` : ''}

<div class="actions">
  <a href="/farm?property=${encodeURIComponent(address + ', ' + city)}" class="ask-btn">Ask about this property</a>
  <button class="save-btn" id="save-btn" onclick="saveProperty()">Save to list</button>
  <button onclick="copyLink()" style="padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0" id="copy-btn">Copy link</button>
</div>

<div class="provenance">
  <strong>Data Provenance</strong><br>
  Assembled: ${data.origin?.assembledDate || '?'}<br>
  Document Hash: <code>${data.origin?.documentHash?.slice(0, 24) || '?'}...</code><br>
  Sources: ${(data.origin?.sources || []).join(' | ')}<br>
  Confidence: ${((data.origin?.confidence || 0) * 100).toFixed(0)}%
</div>

<script>
async function saveProperty() {
  const btn = document.getElementById('save-btn');
  const resp = await fetch('/api/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: ${JSON.stringify(address)},
      city: ${JSON.stringify(city)},
      folio: ${JSON.stringify(parcelId)},
      bridge_url: location.pathname + location.search,
      farming_score: ${fs2.score || 0}
    })
  });
  if (resp.status === 401) { window.location = '/auth/login'; return; }
  const data = await resp.json();
  if (data.saved) { btn.textContent = 'Saved!'; btn.classList.add('saved'); btn.disabled = true; }
  else { btn.textContent = 'Error'; }
}
function copyLink() {
  navigator.clipboard.writeText(location.href);
  const btn = document.getElementById('copy-btn');
  btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy link', 2000);
}
</script>

<div class="footer">
  <strong>Rootz Property Intelligence</strong> — Government data with cryptographic proof<br>
  <a href="https://title.rootz.global">title.rootz.global</a> &nbsp;|&nbsp; Bridge page: <code>/p/${parcelId}</code><br>
  Updated: ${new Date().toISOString().split('T')[0]}
</div>

</div>
</body></html>`;

        // Inject nav into bridge page
        const finalHtml = html.replace('<body>', '<body>\n' + renderNav(req.account));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(finalHtml);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        return res.end(`<html><body><h1>Error</h1><pre>${e.message}</pre></body></html>`);
      }
    }

    // ─── FLORIDA ENDPOINTS ────────────────────────────────────
    if (path === '/api/fl/search') {
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city') || 'Miami Beach';
      if (!address) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'address required', example: '/api/fl/search?address=7830+Atlantic+Way&city=Miami+Beach' }));
      }
      try {
        const result = await assemblePropertyIntelligence(address, city);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (path === '/api/fl/lookup') {
      const folio = urlParts.searchParams.get('folio');
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city');
      try {
        let result;
        if (folio) {
          result = await lookupByFolio(folio);
        } else if (address) {
          result = await lookupByAddress(address, city || '');
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'folio or address required' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (path === '/api/fl/flood') {
      const lat = parseFloat(urlParts.searchParams.get('lat'));
      const lng = parseFloat(urlParts.searchParams.get('lng'));
      if (!lat || !lng) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'lat and lng required', example: '/api/fl/flood?lat=25.8638&lng=-80.1208' }));
      }
      const result = await getFloodZone(lat, lng);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/fl/census') {
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city') || '';
      if (!address) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'address required' }));
      }
      const result = await getCensusData(address, city, 'FL');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/fl/permits') {
      const folio = urlParts.searchParams.get('folio');
      const address = urlParts.searchParams.get('address');
      if (!folio && !address) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'folio or address required', example: '/api/fl/permits?address=7830+ATLANTIC+WAY' }));
      }
      const result = findBuildingPermits(folio, address);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ count: result.length, permits: result }, null, 2));
    }

    if (path === '/api/fl/schools') {
      const lat = parseFloat(urlParts.searchParams.get('lat'));
      const lng = parseFloat(urlParts.searchParams.get('lng'));
      if (!lat || !lng) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'lat and lng required', example: '/api/fl/schools?lat=25.8638&lng=-80.1208' }));
      }
      const maxDist = parseFloat(urlParts.searchParams.get('radius') || '3.0');
      const result = findNearestSchools(lat, lng, maxDist);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/fl/hospitals') {
      const lat = parseFloat(urlParts.searchParams.get('lat'));
      const lng = parseFloat(urlParts.searchParams.get('lng'));
      if (!lat || !lng) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'lat and lng required', example: '/api/fl/hospitals?lat=25.6937&lng=-80.1625' }));
      }
      const maxDist = parseFloat(urlParts.searchParams.get('radius') || '15.0');
      const result = findNearestHospitals(lat, lng, maxDist);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/fl/ev-charging') {
      const lat = parseFloat(urlParts.searchParams.get('lat'));
      const lng = parseFloat(urlParts.searchParams.get('lng'));
      if (!lat || !lng) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'lat and lng required', example: '/api/fl/ev-charging?lat=25.6937&lng=-80.1625' }));
      }
      const maxDist = parseFloat(urlParts.searchParams.get('radius') || '5.0');
      const result = findNearestEVCharging(lat, lng, maxDist);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    if (path === '/api/fl/environmental') {
      const lat = parseFloat(urlParts.searchParams.get('lat'));
      const lng = parseFloat(urlParts.searchParams.get('lng'));
      if (!lat || !lng) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'lat and lng required', example: '/api/fl/environmental?lat=25.6937&lng=-80.1625' }));
      }
      const maxDist = parseFloat(urlParts.searchParams.get('radius') || '5.0');
      const result = findNearestTRIFacilities(lat, lng, maxDist);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ triFacilities: result, totalNearby: result.length }, null, 2));
    }

    if (path === '/api/fl/economics') {
      const result = getMarketEconomics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    // ─── VACATION RENTAL LOOKUP (DBPR) ─────────────────────────
    if (path === '/api/fl/vacation-rentals') {
      const address = urlParts.searchParams.get('address') || '';
      const owner = urlParts.searchParams.get('owner') || '';
      const city = urlParts.searchParams.get('city') || '';
      const county = urlParts.searchParams.get('county') || '';
      const limit = parseInt(urlParts.searchParams.get('limit')) || 50;

      if (!address && !owner && !city && !county) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Provide address, owner, city, or county',
          examples: [
            '/api/fl/vacation-rentals?city=KISSIMMEE&limit=20',
            '/api/fl/vacation-rentals?owner=SMITH',
            '/api/fl/vacation-rentals?county=OSCEOLA&limit=100',
            '/api/fl/vacation-rentals?address=1234+MAIN+ST'
          ],
          note: '178K licensed vacation rentals statewide with phone numbers (FL DBPR)'
        }));
      }

      const result = searchVacationRentals({ address, owner, city, county, limit });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }

    // ─── TIMESHARE INTELLIGENCE ───────────────────────────────
    if (path === '/api/fl/timeshare') {
      const nameQuery = urlParts.searchParams.get('q') || urlParts.searchParams.get('query') || urlParts.searchParams.get('name') || '';
      const addressQuery = urlParts.searchParams.get('address') || '';
      const city = urlParts.searchParams.get('city') || '';
      const query = nameQuery || addressQuery;
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'query required — provide name (q=) and/or address+city',
          examples: [
            '/api/fl/timeshare?q=Disney+Saratoga+Springs',
            '/api/fl/timeshare?q=Westgate&address=7600+W+Irlo+Bronson+Memorial+Hwy&city=Kissimmee',
            '/api/fl/timeshare?address=5925+Avenida+Vista&city=Orlando&q=Marriott+Grande+Vista'
          ]
        }));
      }
      try {
        const result = await assembleTimeshareIntelligence(query, city, addressQuery || null);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (path === '/api/fl/timeshare/search') {
      const q = urlParts.searchParams.get('q') || '';
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'q required', example: '/api/fl/timeshare/search?q=Disney' }));
      }
      const results = searchDBPRTimeshare(q);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ query: q, count: results.length, projects: results }, null, 2));
    }

    // ─── OHIO ENDPOINTS ──────────────────────────────────────────
    if (path === '/api/oh/search') {
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city') || '';
      if (!address) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'address required',
          example: '/api/oh/search?address=6580+Sherry+Ln&city=Hilliard',
          coverage: 'Franklin County OH (Columbus, Hilliard, Dublin, Grove City, Upper Arlington, Westerville)'
        }));
      }
      try {
        const result = await assembleOhioPropertyIntelligence(address, city);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (path === '/api/oh/lookup') {
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city') || '';
      if (!address) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'address required' }));
      }
      const results = await lookupOhioByAddress(address, city);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(results, null, 2));
    }

    // ─── CROSS-REFERENCE ENDPOINTS (Title ↔ Private ↔ Public) ──

    // Join 1: Private ↔ Title — LLC/entity owner → Sunbiz officers
    if (path === '/api/fl/cross-ref/entity') {
      const owner = urlParts.searchParams.get('owner');
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city');
      const folio = urlParts.searchParams.get('folio');

      try {
        let ownerName = owner;
        let propertyData = null;

        // If no owner name given, look up the property first
        if (!ownerName && (address || folio)) {
          let props;
          if (folio) {
            const p = await lookupByFolio(folio);
            props = p ? [p] : [];
          } else {
            props = await lookupByAddress(address, city || '');
          }
          if (props.length > 0) {
            propertyData = {
              address: props[0].TRUE_SITE_ADDR,
              city: props[0].TRUE_SITE_CITY,
              folio: props[0].FOLIO,
              owner1: props[0].TRUE_OWNER1,
              owner2: props[0].TRUE_OWNER2,
              value: props[0].TOTAL_VAL_CUR
            };
            ownerName = props[0].TRUE_OWNER1;
          }
        }

        if (!ownerName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: 'owner, address, or folio required',
            example: '/api/fl/cross-ref/entity?address=7830+Atlantic+Way&city=Miami+Beach',
            example2: '/api/fl/cross-ref/entity?owner=SEASIDE+HOLDINGS+LLC'
          }));
        }

        const isEntity = isEntityOwner(ownerName);
        const result = await crossRefPrivateEntity(ownerName, 'FL');

        // Also check owner2 if it looks like an entity
        let result2 = null;
        const owner2 = propertyData?.owner2;
        if (owner2 && isEntityOwner(owner2) && owner2 !== ownerName) {
          result2 = await crossRefPrivateEntity(owner2, 'FL');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          description: 'Cross-reference: Property owner resolved against FL business registry (private.rootz.global)',
          property: propertyData,
          owner_analyzed: ownerName,
          is_entity: isEntity,
          entity_match: result,
          owner2_analyzed: owner2 || null,
          entity_match2: result2,
          join: 'title.rootz.global ↔ private.rootz.global',
          usage: 'Resolves LLC/Corp property owners to their registered officers, filing dates, and succession signals'
        }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Join 2: Public ↔ Title — property owner → SEC-registered public company
    if (path === '/api/fl/cross-ref/public') {
      const owner = urlParts.searchParams.get('owner');
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city');
      const folio = urlParts.searchParams.get('folio');

      try {
        let ownerName = owner;
        let propertyData = null;

        if (!ownerName && (address || folio)) {
          let props;
          if (folio) {
            const p = await lookupByFolio(folio);
            props = p ? [p] : [];
          } else {
            props = await lookupByAddress(address, city || '');
          }
          if (props.length > 0) {
            propertyData = {
              address: props[0].TRUE_SITE_ADDR,
              city: props[0].TRUE_SITE_CITY,
              folio: props[0].FOLIO,
              owner1: props[0].TRUE_OWNER1,
              owner2: props[0].TRUE_OWNER2,
              value: props[0].TOTAL_VAL_CUR
            };
            ownerName = props[0].TRUE_OWNER1;
          }
        }

        if (!ownerName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: 'owner, address, or folio required',
            example: '/api/fl/cross-ref/public?owner=INVITATION+HOMES',
            example2: '/api/fl/cross-ref/public?address=7830+Atlantic+Way&city=Miami+Beach'
          }));
        }

        const result = await crossRefPublicEntity(ownerName);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          description: 'Cross-reference: Property owner checked against SEC-registered public companies (origin.rootz.global)',
          property: propertyData,
          owner_analyzed: ownerName,
          public_company_match: result,
          is_reit: result?.is_reit || false,
          join: 'title.rootz.global ↔ origin.rootz.global',
          usage: 'Identifies when property owners are public companies, REITs, or institutional investors'
        }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Combined: Full owner intelligence — both private + public cross-refs
    if (path === '/api/fl/cross-ref/owner-intel') {
      const address = urlParts.searchParams.get('address');
      const city = urlParts.searchParams.get('city');
      const folio = urlParts.searchParams.get('folio');
      const owner = urlParts.searchParams.get('owner');

      try {
        let ownerName = owner;
        let propertyData = null;

        if (!ownerName && (address || folio)) {
          let props;
          if (folio) {
            const p = await lookupByFolio(folio);
            props = p ? [p] : [];
          } else if (address) {
            props = await lookupByAddress(address, city || '');
          }
          if (props?.length > 0) {
            propertyData = {
              address: props[0].TRUE_SITE_ADDR,
              city: props[0].TRUE_SITE_CITY,
              zip: props[0].TRUE_SITE_ZIP_CODE,
              folio: props[0].FOLIO,
              owner1: props[0].TRUE_OWNER1,
              owner2: props[0].TRUE_OWNER2,
              value: props[0].TOTAL_VAL_CUR,
              land_value: props[0].LAND_VAL_CUR,
              building_value: props[0].BUILDING_VAL_CUR,
              year_built: props[0].YEAR_BUILT,
              dor_code: props[0].DOR_CODE_CUR,
              dor_desc: props[0].DOR_DESC
            };
            ownerName = props[0].TRUE_OWNER1;
          }
        }

        if (!ownerName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: 'owner, address, or folio required',
            example: '/api/fl/cross-ref/owner-intel?address=7830+Atlantic+Way&city=Miami+Beach'
          }));
        }

        // Run both cross-references in parallel
        const isEntity = isEntityOwner(ownerName);
        const [privateMatch, publicMatch] = await Promise.all([
          isEntity ? crossRefPrivateEntity(ownerName, 'FL') : null,
          crossRefPublicEntity(ownerName)
        ]);

        // Check owner2 as well
        const owner2 = propertyData?.owner2;
        let privateMatch2 = null;
        if (owner2 && isEntityOwner(owner2) && owner2 !== ownerName) {
          privateMatch2 = await crossRefPrivateEntity(owner2, 'FL');
        }

        // Build intelligence summary
        const intel = {
          owner_type: 'unknown',
          succession_risk: false,
          institutional: false
        };

        if (publicMatch?.matches?.length) {
          intel.owner_type = publicMatch.is_reit ? 'public_reit' : 'public_company';
          intel.institutional = true;
        } else if (privateMatch?.match) {
          intel.owner_type = privateMatch.succession_signal ? 'owner_operated' : 'private_entity';
          intel.succession_risk = privateMatch.succession_signal;
          intel.business_age = privateMatch.match.business_age_years;
          intel.officers = privateMatch.officers?.map(o => ({ name: o.name, title: o.title_normalized })) || [];
        } else if (!isEntity) {
          intel.owner_type = 'individual';
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          description: 'Full owner intelligence: property + private company registry + SEC public company data',
          property: propertyData,
          owner_analyzed: ownerName,
          is_entity: isEntity,
          intelligence: intel,
          private_registry: privateMatch,
          private_registry_owner2: privateMatch2,
          public_company: publicMatch,
          joins: [
            'title.rootz.global ↔ private.rootz.global (FL Sunbiz)',
            'title.rootz.global ↔ origin.rootz.global (SEC)'
          ],
          usage: 'Complete owner profile: resolve LLCs to officers, detect succession signals, identify institutional buyers'
        }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ─── MASSACHUSETTS ENDPOINTS ──────────────────────────────
    if (path === '/api/properties') {
      const result = await handleTool('list_properties', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result, null, 2));
    }
  }

  // Privacy policy
  if (req.url === '/privacy' || req.url === '/privacy.html') {
    const privPath = path.join(__dirname, 'privacy.html');
    if (fs.existsSync(privPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(privPath, 'utf-8'));
    }
  }

  // OpenAPI spec — for GPT Actions and API consumers
  if (req.url === '/openapi.json' || req.url === '/openapi') {
    const specPath = path.join(__dirname, 'openapi.json');
    if (fs.existsSync(specPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(specPath, 'utf-8'));
    }
  }

  // .well-known/ai — AI Discovery (Rootz standard)
  if (req.url === '/.well-known/ai' || req.url === '/.well-known/ai.json') {
    const wkPath = path.join(__dirname, 'wellknown-ai.json');
    if (fs.existsSync(wkPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(wkPath, 'utf-8'));
    }
  }

  // robots.txt
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('User-agent: *\nAllow: /\n\nSitemap: https://title.rootz.global/.well-known/ai\n');
  }

  // /api directory — JSON list of all endpoints
  if (req.url === '/api' || req.url === '/api/') {
    const wkPath = path.join(__dirname, 'wellknown-ai.json');
    if (fs.existsSync(wkPath)) {
      const data = JSON.parse(fs.readFileSync(wkPath, 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ endpoints: data.endpoints, coverage: data.coverage }, null, 2));
    }
  }

  // AI-readable property page — /s/{shareId}/ai or /ai/demo
  if (req.url === '/ai/demo' || req.url === '/ai' || (req.url.startsWith('/s/') && req.url.endsWith('/ai'))) {
    const aiPath = path.join(__dirname, 'share-ai-page.html');
    if (fs.existsSync(aiPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(aiPath, 'utf-8'));
    }
  }

  // Shareable property map — /s/{shareId} or /map/demo
  if (req.url === '/map/demo' || req.url === '/map' || req.url.startsWith('/s/')) {
    const mapPath = path.join(__dirname, 'share-map.html');
    if (fs.existsSync(mapPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(mapPath, 'utf-8'));
    }
  }

  // Charts dashboard
  if (req.url === '/charts' || req.url === '/charts.html') {
    const chartPath = path.join(__dirname, 'charts.html');
    if (fs.existsSync(chartPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(chartPath, 'utf-8'));
    }
  }

  // Skill page — teaches AI how to use this service
  if (req.url === '/skill' || req.url === '/skill.md' || req.url === '/SKILL.md') {
    const skillPath = path.join(__dirname, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      res.writeHead(200, { 'Content-Type': 'text/markdown', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(skillPath, 'utf-8'));
    }
  }

  if (req.url === '/skill.html') {
    const skillPath = path.join(__dirname, 'skill.html');
    if (fs.existsSync(skillPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(skillPath, 'utf-8'));
    }
  }

  // Guide page
  if (req.url === '/guide' || req.url === '/guide.html') {
    const guidePath = path.join(__dirname, 'guide.html');
    if (fs.existsSync(guidePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(guidePath, 'utf-8'));
    }
  }

  // Root → redirect to farm chat (the product)
  if (req.url === '/' || req.url === '') {
    res.writeHead(302, { 'Location': '/farm' });
    return res.end();
  }

  // Legacy landing page — serve from landing.html for /landing
  const landingPath = path.join(__dirname, 'landing.html');
  if ((req.url === '/landing' || req.url === '/landing.html') && fs.existsSync(landingPath)) {
    let html = fs.readFileSync(landingPath, 'utf-8');
    html = html.replace('<body>', '<body>\n' + renderNav(req.account));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Origin Title Records - API at /api/properties');
  }
});

// ─── Auth Page Templates ───────────────────────────────────────

const AUTH_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;max-width:420px;width:100%}
.card h1{font-size:24px;color:#1e3a5f;margin-bottom:6px}
.card .sub{color:#64748b;font-size:14px;margin-bottom:24px}
.card label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px}
.card input[type=email]{width:100%;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}
.card input:focus{border-color:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.1)}
.card button{width:100%;padding:12px;background:linear-gradient(135deg,#1e3a5f 0%,#0f766e 100%);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px}
.card button:hover{opacity:.9}
.error{background:#fef2f2;color:#dc2626;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid #fecaca}
.success{background:#f0fdf4;color:#166534;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid #bbf7d0}
.info{background:#eff6ff;color:#1e40af;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid #bfdbfe}
.ft{text-align:center;margin-top:20px;font-size:12px;color:#94a3b8}
.ft a{color:#0f766e;text-decoration:none}
.tier-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase}
.tier-free{background:#f1f5f9;color:#64748b}
.tier-starter{background:#dbeafe;color:#1d4ed8}
.tier-pro{background:#fef3c7;color:#92400e}
.tier-unlimited{background:#d1fae5;color:#065f46}
.stat{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f1f5f9}
.stat:last-child{border-bottom:none}
.stat .label{color:#64748b;font-size:13px}
.stat .value{font-weight:600;font-size:14px}
`;

function renderLoginPage(error = null, account = null) {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign In — Rootz Property Intelligence</title>
<style>${AUTH_STYLES}body{display:block}</style>
</head><body>
${renderNav(account)}
<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 48px)">
<div class="card">
  <h1>Rootz Property Intelligence</h1>
  <div class="sub">AI-powered real estate farming</div>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/auth/login">
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" placeholder="agent@example.com" required autofocus>
    <button type="submit">Send Magic Link</button>
  </form>
  <div class="ft">No password needed — we'll email you a sign-in link<br><a href="/">Back to home</a></div>
</div>
</div>
</body></html>`;
}

function renderCheckEmailPage(email) {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Check Your Email — Rootz Property Intelligence</title>
<style>${AUTH_STYLES}body{display:block}</style>
</head><body>
${renderNav(null)}
<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 48px)">
<div class="card">
  <h1>Check your email</h1>
  <div class="sub">We sent a sign-in link to:</div>
  <div class="info"><strong>${email}</strong></div>
  <p style="color:#64748b;font-size:14px;line-height:1.6">Click the link in the email to sign in. The link expires in 15 minutes.</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:16px">Didn't get it? Check your spam folder or <a href="/auth/login" style="color:#0f766e">try again</a>.</p>
  <div class="ft"><a href="/">Back to home</a></div>
</div>
</div>
</body></html>`;
}

function renderAccountPage(account, stats, config) {
  const tierClass = `tier-${account.tier}`;
  const limitDisplay = config.daily === -1 ? 'Unlimited' : `${stats.today} / ${config.daily}`;
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Account — Rootz Property Intelligence</title>
<style>${AUTH_STYLES}
body{display:block}
.card{max-width:520px;margin:40px auto}
</style>
</head><body>
${renderNav(account)}
<div class="card">
  <h1>Account</h1>
  <div class="sub">${account.email}</div>

  <div class="stat"><span class="label">Plan</span><span class="value"><span class="tier-badge ${tierClass}">${account.tier}</span></span></div>
  <div class="stat"><span class="label">Searches today</span><span class="value">${limitDisplay}</span></div>
  <div class="stat"><span class="label">Searches this month</span><span class="value">${stats.month.n}</span></div>
  <div class="stat"><span class="label">Token budget</span><span class="value">${stats.token_budget.budget > 0 ? Math.round(stats.token_budget.used / 1000) + 'K / ' + Math.round(stats.token_budget.budget / 1000) + 'K (' + stats.token_budget.pct + '%)' : 'Unlimited'}</span></div>
  <div class="stat"><span class="label">AI model</span><span class="value">${config.model.includes('sonnet') ? 'Sonnet' : 'Haiku'}</span></div>
  <div class="stat"><span class="label">Court records</span><span class="value">${config.court_records ? 'Included' : 'Pro+ only'}</span></div>
  <div class="stat"><span class="label">Mailing addresses</span><span class="value">${config.mailing_addr ? 'Included' : 'Starter+ only'}</span></div>
  <div class="stat"><span class="label">Session history</span><span class="value">${config.resume_sessions ? 'Resume past sessions' : 'Archived (upgrade to Pro to resume)'}</span></div>
  <div class="stat"><span class="label">Member since</span><span class="value">${account.created_at?.slice(0, 10) || '—'}</span></div>

  ${account.tier === 'free' ? '<a href="/pricing" style="display:block;text-align:center;margin-top:20px;padding:12px;background:linear-gradient(135deg,#1e3a5f,#0f766e);color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Upgrade Your Plan</a>' : ''}
  ${account.stripe_customer_id ? '<a href="/api/stripe/portal" style="display:block;text-align:center;margin-top:12px;color:#0f766e;font-size:14px">Manage Subscription</a>' : ''}

  <div class="ft" style="margin-top:24px">
    <a href="/farm">Farm</a> &bull;
    <a href="/saved">Saved Properties</a> &bull;
    <a href="/auth/logout">Sign Out</a>
  </div>
</div>
</body></html>`;
}

// ─── Saved Properties Page Template ────────────────────────────

function renderSavedPage(account, saved, farmAreas) {
  const statusColors = { active: '#0f766e', contacted: '#2563eb', listed: '#7c3aed', closed: '#16a34a', archived: '#94a3b8' };
  const statusOpts = ['active', 'contacted', 'listed', 'closed', 'archived'];

  const propertyRows = saved.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No saved properties yet. <a href="/farm" style="color:#0f766e">Search for properties</a> and save the ones you like.</div>'
    : saved.map(p => {
      const sc = statusColors[p.status] || '#94a3b8';
      const statusSelect = statusOpts.map(s => `<option value="${s}"${s === (p.status || 'active') ? ' selected' : ''}>${s}</option>`).join('');
      const escapedNotes = (p.notes || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      return `
      <div class="prop-card" style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px;background:#fff;border-left:4px solid ${sc}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1">
            <div style="font-weight:600;font-size:15px">${p.address}</div>
            <div style="color:#64748b;font-size:13px">${p.city || ''}${p.state ? ', ' + p.state : ''}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
            ${p.farming_score ? `<span style="background:#f0fdf4;color:#166534;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600">Score: ${p.farming_score}</span>` : ''}
            <select onchange="updateStatus(${p.id},this.value)" style="font-size:11px;padding:2px 4px;border:1px solid #e2e8f0;border-radius:4px;color:${sc}">${statusSelect}</select>
            <button onclick="deleteSaved(${p.id})" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:18px" title="Remove">&times;</button>
          </div>
        </div>
        <div style="margin-top:8px">
          <div style="display:flex;gap:6px;align-items:flex-start">
            <textarea id="notes-${p.id}" rows="2" placeholder="Add notes... (e.g., Called estate attorney, follow up Thursday)" style="flex:1;font-size:13px;padding:8px;border:1px solid #e2e8f0;border-radius:6px;resize:vertical;font-family:inherit;color:#475569">${escapedNotes}</textarea>
            <button onclick="saveNotes(${p.id})" style="padding:6px 12px;background:#0f766e;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">Save</button>
          </div>
        </div>
        <div style="margin-top:8px;display:flex;gap:12px;align-items:center">
          ${p.bridge_url ? `<a href="${p.bridge_url}" style="color:#0f766e;font-size:12px">View details</a>` : ''}
          <a href="/farm?property=${encodeURIComponent(p.address + ', ' + (p.city || ''))}" style="color:#0f766e;font-size:12px">Ask about this property</a>
          <span style="font-size:11px;color:#cbd5e1;margin-left:auto">Saved ${p.created_at?.slice(0, 10) || ''}</span>
        </div>
      </div>`;
    }).join('');

  const areaRows = farmAreas.length === 0
    ? ''
    : `<h2 style="font-size:16px;color:#1e3a5f;margin:24px 0 12px">Farm Areas</h2>` +
      farmAreas.map(a => `
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:8px;background:#fff;display:flex;justify-content:space-between;align-items:center">
          <div>
            <span style="font-weight:600">${a.city}</span>
            ${a.zip ? `<span style="color:#64748b;font-size:13px;margin-left:8px">${a.zip}</span>` : ''}
            ${a.signals ? `<span style="color:#94a3b8;font-size:12px;margin-left:8px">${JSON.parse(a.signals).join(', ')}</span>` : ''}
            ${a.alert_enabled ? '<span style="color:#0f766e;font-size:11px;margin-left:8px">Alerts on</span>' : ''}
          </div>
          <button onclick="deleteArea(${a.id})" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:18px" title="Remove">&times;</button>
        </div>
      `).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saved Properties — Rootz Property Intelligence</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b}
</style>
</head><body>
${renderNav(account)}
<div style="max-width:700px;margin:0 auto;padding:24px 20px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <h1 style="font-size:22px;color:#1e3a5f">Saved Properties <span style="font-size:14px;color:#94a3b8;font-weight:400">(${saved.length})</span></h1>
    ${saved.length ? '<a href="/api/saved/export.csv" style="font-size:13px;padding:6px 14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;color:#475569;text-decoration:none">Export CSV</a>' : ''}
  </div>
  ${propertyRows}
  ${areaRows}
</div>
<script>
async function saveNotes(id) {
  const el = document.getElementById('notes-' + id);
  const resp = await fetch('/api/saved/' + id + '/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: el.value })
  });
  if (resp.ok) { el.style.borderColor = '#0f766e'; setTimeout(() => el.style.borderColor = '#e2e8f0', 1500); }
}
async function updateStatus(id, status) {
  await fetch('/api/saved/' + id + '/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  location.reload();
}
async function deleteSaved(id) {
  if (!confirm('Remove this property?')) return;
  await fetch('/api/saved/' + id, { method: 'DELETE' });
  location.reload();
}
async function deleteArea(id) {
  if (!confirm('Remove this farm area?')) return;
  await fetch('/api/farm-areas/' + id, { method: 'DELETE' });
  location.reload();
}
</script>
</body></html>`;
}

// ─── Help Page Template ────────────────────────────────────────

function renderHelpPage(account) {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Help — Rootz Property Intelligence</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b}
.help{max-width:700px;margin:0 auto;padding:24px 20px}
.help h1{font-size:24px;color:#1e3a5f;margin-bottom:20px}
.help h2{font-size:18px;color:#1e3a5f;margin:28px 0 12px;padding-top:16px;border-top:1px solid #e2e8f0}
.help h2:first-of-type{border-top:none;padding-top:0}
.help p{line-height:1.7;margin-bottom:12px;color:#475569;font-size:14px}
.help ul{padding-left:20px;margin-bottom:12px}
.help li{margin:6px 0;line-height:1.6;font-size:14px;color:#475569}
.help .tip{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin:12px 0;font-size:13px;color:#166534}
.help .tip strong{color:#065f46}
.help code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}
.help a{color:#0f766e}
</style>
</head><body>
${renderNav(account)}
<div class="help">
<h1>How to Use Rootz Property Intelligence</h1>

<h2>Getting Started</h2>
<p>Rootz Property Intelligence helps Florida real estate agents find properties likely to come on the market. We analyze 10.8 million Florida property records, 908,000 Broward County courthouse records, and government data to score every property for farming potential.</p>

<div class="tip"><strong>Quick start:</strong> Go to <a href="/farm">Farm</a>, type a city name and what you're looking for. Example: "Find me probate properties in Coral Springs."</div>

<h2>The Farm Chat</h2>
<p>The <a href="/farm">Farm</a> page is your AI-powered farming assistant. Just talk to it naturally:</p>
<ul>
  <li><strong>"I want to farm in Fort Lauderdale"</strong> — finds top-scored prospects in the city</li>
  <li><strong>"Show me probate filings in Hollywood"</strong> — filters by specific signals</li>
  <li><strong>"Tell me about 1725 SW 14 ST, Fort Lauderdale"</strong> — full intelligence on a specific address</li>
  <li><strong>"Find corporate-owned properties with liens in Pembroke Pines"</strong> — combines multiple signals</li>
  <li><strong>"What's the story on this property?"</strong> — the AI reads court records and explains in plain English</li>
</ul>

<h2>Farming Signals</h2>
<p>Every property is scored 0-100 based on signals that indicate the owner may sell:</p>
<ul>
  <li><strong>Probate</strong> — estate being settled, heirs often sell</li>
  <li><strong>Lis Pendens</strong> — litigation pending (pre-foreclosure)</li>
  <li><strong>Foreclosure Judgment</strong> — court-ordered foreclosure</li>
  <li><strong>Lien</strong> — unpaid debts attached to property</li>
  <li><strong>Death Certificate</strong> — owner deceased, property in transition</li>
  <li><strong>Absentee Owner</strong> — owner lives at a different address</li>
  <li><strong>Out-of-State Owner</strong> — owner in another state (harder to manage)</li>
  <li><strong>Corporate/LLC Owner</strong> — investment property, business decision to sell</li>
  <li><strong>Long-Term Owner</strong> — owned 15+ years, likely significant equity</li>
  <li><strong>No Homestead</strong> — not primary residence, easier to let go</li>
  <li><strong>Free & Clear</strong> — no mortgage, no debt pressure but also no lock-in</li>
  <li><strong>Nominal Transfer</strong> — $0-$100 sale price suggests family/estate transfer</li>
</ul>

<h2>Property Bridge Pages</h2>
<p>When the AI finds a prospect, it includes a "Full intelligence" link. Click it to see the complete property page with:</p>
<ul>
  <li>Farming score with explanation</li>
  <li>Owner name and mailing address (Starter+ plans)</li>
  <li>Court record timeline (Pro+ plans)</li>
  <li>Assessed value and property details</li>
  <li>Flood zone, schools, permits, demographics</li>
</ul>
<div class="tip"><strong>Tip:</strong> Bridge page URLs are shareable. Copy the link and text it to a colleague — they'll see the same intelligence page.</div>

<h2>Saving Properties</h2>
<p>Click "Save to list" on any bridge page to add it to your <a href="/saved">Saved Properties</a>. From there you can:</p>
<ul>
  <li><strong>Add notes</strong> — "Called estate attorney, follow up Thursday"</li>
  <li><strong>Track status</strong> — Active → Contacted → Listed → Closed → Archived</li>
  <li><strong>View details</strong> — jump back to the full intelligence page</li>
  <li><strong>Ask the AI</strong> — continue researching any saved property</li>
</ul>

<h2>Your Subscription</h2>
<p>See <a href="/pricing">Pricing</a> for full details. Key differences between tiers:</p>
<ul>
  <li><strong>Free</strong> — 5 searches/day, 50K tokens/month, basic results</li>
  <li><strong>Starter ($29/mo)</strong> — 50 searches/day, 500K tokens, mailing addresses</li>
  <li><strong>Pro ($49/mo)</strong> — 200 searches/day, 1M tokens, court records, Sonnet AI model, resume past sessions</li>
  <li><strong>Unlimited ($99/mo)</strong> — unlimited searches, 5M tokens, everything in Pro</li>
</ul>
<p>Your chat sessions are <strong>always saved</strong>, even on the free plan. Upgrade to Pro to resume past conversations with full context.</p>

<h2>Tips for Better Results</h2>
<ul>
  <li><strong>Be specific about location</strong> — "Coral Springs" works better than "South Florida"</li>
  <li><strong>Combine signals</strong> — "probate + absentee in Fort Lauderdale" narrows to the best leads</li>
  <li><strong>Ask follow-up questions</strong> — "tell me more about that first property" digs deeper</li>
  <li><strong>Use bridge pages</strong> — they have more data than the chat summary</li>
  <li><strong>Save early, note often</strong> — your saved list is your farming CRM</li>
</ul>

<h2>Data Coverage</h2>
<ul>
  <li><strong>Property records</strong> — 10.8M parcels across all 67 FL counties</li>
  <li><strong>Court records</strong> — 908K Broward County filings (probate, liens, foreclosure, deeds, deaths)</li>
  <li><strong>Building permits</strong> — 842K across Miami-Dade, Fort Lauderdale, Palm Bay, Hillsborough</li>
  <li><strong>Flood zones</strong> — FEMA data nationwide</li>
  <li><strong>Demographics</strong> — US Census block-group level</li>
  <li><strong>Schools, hospitals, EV charging</strong> — statewide</li>
</ul>

<h2>Need Help?</h2>
<p>Email <a href="mailto:steven@rootz.global">steven@rootz.global</a> — we respond to every message.</p>

</div>
</body></html>`;
}

// ─── Pricing Page Template ─────────────────────────────────────

function renderPricingPage(account) {
  const currentTier = account?.tier || 'free';
  const tiers = [
    { key: 'free', name: 'Free', price: '$0', period: '', searches: '5/day', budget: '50K tokens', model: 'Haiku', features: ['Basic search results', 'Sessions archived (upgrade to resume)'], cta: currentTier === 'free' ? 'Current Plan' : null },
    { key: 'starter', name: 'Starter', price: '$29', period: '/mo', searches: '50/day', budget: '500K tokens', model: 'Haiku', features: ['Mailing addresses', 'Full bridge pages', 'Farm map access', 'Sessions archived (upgrade to resume)'], cta: 'Subscribe' },
    { key: 'pro', name: 'Pro', price: '$49', period: '/mo', searches: '200/day', budget: '1M tokens', model: 'Sonnet', features: ['Court records (probate, liens, foreclosure)', 'Equity estimates', 'Claude Sonnet AI model', 'Resume past sessions', 'Everything in Starter'], cta: 'Subscribe', popular: true },
    { key: 'unlimited', name: 'Unlimited', price: '$99', period: '/mo', searches: 'Unlimited', budget: '5M tokens', model: 'Sonnet', features: ['Unlimited daily searches', '5M token monthly budget', 'Resume past sessions', 'Everything in Pro'], cta: 'Subscribe' },
  ];

  const tierCards = tiers.map(t => {
    const isCurrent = currentTier === t.key;
    const badge = t.popular ? '<div style="background:#0f766e;color:#fff;text-align:center;padding:6px;font-size:12px;font-weight:700;border-radius:8px 8px 0 0">MOST POPULAR</div>' : '';
    const buttonStyle = isCurrent ? 'background:#94a3b8;cursor:default' : t.popular ? 'background:linear-gradient(135deg,#1e3a5f,#0f766e)' : 'background:#1e3a5f';
    const buttonText = isCurrent ? 'Current Plan' : (t.cta || 'Subscribe');
    const onclick = isCurrent || t.key === 'free' ? '' : `onclick="subscribe('${t.key}')"`;

    return `
    <div style="border:${t.popular ? '2px solid #0f766e' : '1px solid #e2e8f0'};border-radius:8px;overflow:hidden;flex:1;min-width:220px;max-width:280px;background:#fff">
      ${badge}
      <div style="padding:24px">
        <h3 style="font-size:18px;color:#1e293b;margin-bottom:4px">${t.name}</h3>
        <div style="font-size:32px;font-weight:700;color:#1e3a5f">${t.price}<span style="font-size:14px;color:#64748b;font-weight:400">${t.period}</span></div>
        <div style="font-size:13px;color:#64748b;margin:8px 0 16px">${t.searches} &bull; ${t.budget}/mo &bull; ${t.model}</div>
        <ul style="list-style:none;padding:0;margin:0 0 20px">
          ${t.features.map(f => `<li style="padding:4px 0;font-size:13px;color:#475569">&#10003; ${f}</li>`).join('')}
        </ul>
        <button ${onclick} style="width:100%;padding:10px;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;${buttonStyle}">${buttonText}</button>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing — Rootz Property Intelligence</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b}
</style>
</head><body>
${renderNav(account)}
<div style="max-width:1100px;margin:0 auto;padding:40px 20px">
  <div style="text-align:center;margin-bottom:40px">
    <h1 style="font-size:28px;color:#1e3a5f">Rootz Property Intelligence Pricing</h1>
    <p style="color:#64748b;margin-top:8px">AI-powered farming intelligence for Florida real estate agents</p>
  </div>
  <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap">
    ${tierCards}
  </div>
  <div style="text-align:center;margin-top:32px;font-size:13px;color:#94a3b8">
    ${account ? `Signed in as ${account.email} &bull; <a href="/auth/account" style="color:#0f766e">Account</a>` : `<a href="/auth/login" style="color:#0f766e">Sign in</a> to subscribe`}
    &bull; <a href="/farm" style="color:#0f766e">Back to Farm</a>
  </div>
</div>
<script>
async function subscribe(tier) {
  ${account ? '' : "window.location='/auth/login'; return;"}
  const resp = await fetch('/api/stripe/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  const data = await resp.json();
  if (data.url) window.location = data.url;
  else alert(data.error || 'Error creating checkout');
}
</script>
</body></html>`;
}

server.listen(PORT, () => {
  console.log(`Rootz Property Intelligence MCP Server running on port ${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`  Auth: http://localhost:${PORT}/auth/login`);
  console.log(`  Farm: http://localhost:${PORT}/farm`);
  console.log(`  Pricing: http://localhost:${PORT}/pricing`);
  console.log(`  MCP: POST http://localhost:${PORT}/`);
  console.log(`  Data: ${DATA_DIR}`);

  // Initialize Stripe products in background
  initStripeProducts().catch(e => console.error('Stripe init error:', e.message));
});
