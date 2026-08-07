/**
 * AI_CONTEXT: Massachusetts registry-of-deeds intelligence — chain of title, lien
 * analysis, document graph, party index, and fraud-pattern detection over MassGIS
 * assessor data + pre-extracted masslandrecords.com registry records.
 *
 * Extracted VERBATIM (byte-for-byte) from the retired mcp-server/server.mjs so no
 * behaviour changes — the second server generation is being deleted, and these are
 * intended capabilities (a demo tier over ~10 MA properties, plus a Phase-2 OCR
 * notary path), carried forward rather than dropped. Wired to the epistery MCP
 * facility by datasource/mcp.mjs.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MASSGIS_URL, REGISTRIES } from '../lib/constants.js';
import { DATA_DIR, CACHE_DIR } from '../lib/config.js';

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

// ── Tool functions — the retired server's handlers, as exported functions ──────

export async function maSearchProperty(address, town, depth = 2) {
  const cacheKey = getCacheKey(address, town);
  const cached = getFromCache(cacheKey);
  if (cached) { cached._source = 'cache'; cached._cacheKey = cacheKey; return cached; }
  const result = {
    origin: {
      version: '0.1',
      propertyId: `MA-${town.toUpperCase().replace(/\s/g, '-')}-${address.toUpperCase().replace(/[^A-Z0-9]/g, '-')}`,
      searchDate: new Date().toISOString(), sources: [], confidence: 0
    },
    property: { address: { primary: address, town } }
  };
  const assessor = await fetchAssessorData(address, town);
  if (assessor) { result.assessor = assessor; result.origin.sources.push('MassGIS'); }
  const propData = loadPropertyData(address, town);
  if (propData) {
    result.registry = propData.registry;
    result.chainOfTitle = propData.chainOfTitle || buildChainOfTitle(propData.registry?.records || []);
    result.liens = propData.liens || analyzeLiens(propData.registry?.records || []);
    result.origin.sources.push('masslandrecords.com');
    if (depth >= 2) result.documentGraph = buildDocumentGraph(propData);
    result.origin.confidence = propData.origin?.confidence || 0.5;
  } else {
    result.registry = {
      status: 'NOT_FETCHED',
      message: `No cached registry data for ${address}, ${town}. In production, this would trigger a live Playwright fetch from masslandrecords.com.`,
      registryCode: REGISTRIES[town.toUpperCase()] || 'unknown',
      fetchUrl: `https://www.masslandrecords.com/${REGISTRIES[town.toUpperCase()] || 'BerkMiddle'}/D/Default.aspx`
    };
  }
  if (result.assessor && result.registry?.records) result.origin.confidence = 0.85;
  else if (result.assessor || result.registry?.records) result.origin.confidence = 0.5;
  saveToCache(cacheKey, result);
  result._source = 'fresh'; result._cacheKey = cacheKey;
  return result;
}

export function maChainOfTitle(address, town) {
  const propData = loadPropertyData(address, town);
  if (!propData?.registry?.records) return { error: `No registry data for ${address}, ${town}`, suggestion: 'Use search_property first' };
  return { property: `${address}, ${town}`, chain: propData.chainOfTitle || buildChainOfTitle(propData.registry.records), currentOwner: propData.chainOfTitle?.currentOwner || 'See latest deed' };
}

export function maCheckLiens(address, town) {
  const propData = loadPropertyData(address, town);
  if (!propData?.registry?.records) return { error: `No registry data for ${address}, ${town}`, suggestion: 'Use search_property first' };
  return { property: `${address}, ${town}`, ...analyzeLiens(propData.registry.records) };
}

export function maGetDocument(bookPage, registry = 'BerkMiddle') {
  const propsDir = path.join(DATA_DIR, 'properties');
  if (!fs.existsSync(propsDir)) return { error: 'No property data available' };
  for (const file of fs.readdirSync(propsDir).filter(f => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
      const match = (data.registry?.records || data.records || []).find(r => r.bookPage === bookPage);
      if (match) return { document: match, property: data.property?.address?.primary || data.property?.address || file, sourceFile: file };
    } catch (e) { /* skip */ }
  }
  return { error: `Document ${bookPage} not in cache`, fetchMethod: `Search masslandrecords.com/${registry} → Book Search → Book ${bookPage.split('/')[0]} Page ${bookPage.split('/')[1]}`, fetchUrl: `https://www.masslandrecords.com/${registry}/D/Default.aspx` };
}

export async function maAssessorData(address, town) {
  const data = await fetchAssessorData(address, town);
  if (data) return { property: `${address}, ${town}`, parcels: data, count: data.length };
  return { error: `No assessor data found for ${address}, ${town}` };
}

export function maListProperties() {
  const propsDir = path.join(DATA_DIR, 'properties');
  if (!fs.existsSync(propsDir)) return { properties: [] };
  const properties = fs.readdirSync(propsDir).filter(f => f.endsWith('.json')).map(file => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
      return { file, address: data.property?.address?.primary || data.property?.address || data.street?.name || 'unknown', town: data.property?.address?.town || data.property?.town || data.street?.town || 'unknown', registryRecords: data.registry?.recordCount || data.extraction?.totalRecords || 0, confidence: data.origin?.confidence || null, hasAssessor: !!data.assessor };
    } catch (e) { return { file, error: 'parse error' }; }
  });
  return { count: properties.length, properties };
}

export function maSearchByParty(name, role = 'both') { return searchPartyIndex(name, role); }

export function maDetectFraud(address, town) {
  const propData = loadPropertyData(address, town);
  if (!propData?.registry?.records) return { error: `No registry data for ${address}, ${town}`, suggestion: 'Use search_property first' };
  const result = detectFraudPatterns(propData);
  result.property = `${address}, ${town}`;
  return result;
}

export function maSearchByNotary(notaryName) {
  const propsDir = path.join(DATA_DIR, 'properties');
  if (!fs.existsSync(propsDir)) return { searchNotary: notaryName, matches: 0, documents: [], note: 'No property data available.' };
  const matches = [];
  for (const file of fs.readdirSync(propsDir).filter(f => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(propsDir, file), 'utf-8'));
      for (const record of (data.registry?.records || data.records || [])) {
        if (JSON.stringify(record).toUpperCase().includes(notaryName.toUpperCase())) {
          matches.push({ property: data.property?.address?.primary || file, town: data.property?.address?.town || '', docType: record.typeDesc || record.type, bookPage: record.bookPage, date: record.fileDate });
        }
      }
    } catch (e) { /* skip */ }
  }
  return { searchNotary: notaryName, matches: matches.length, documents: matches, note: matches.length === 0 ? 'Notary data requires OCR of document images. Currently only searchable if notary name appears in extracted record text. Phase 2 will OCR all documents and index notary names.' : `Found ${matches.length} documents mentioning "${notaryName}"` };
}
