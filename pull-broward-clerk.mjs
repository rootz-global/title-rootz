#!/usr/bin/env node
// Broward County Official Records — SFTP Bulk Ingestion
// Source: BCFTP.Broward.org (public SFTP, no cost)
// Data: Every deed, mortgage, lis pendens, lien, probate, death cert since 1978
// Schema: pipe-delimited text files (doc, nme, lnk, lgl)
//
// Usage:
//   node pull-broward-clerk.mjs --daily          # Pull latest 10 days of daily files
//   node pull-broward-clerk.mjs --year 2025      # Pull full year export
//   node pull-broward-clerk.mjs --year 2024      # Pull prior year
//   node pull-broward-clerk.mjs --farming         # Extract farming signals from downloaded data
//   node pull-broward-clerk.mjs --stats           # Show current data stats

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'broward-clerk');
const FARMING_DIR = path.join(__dirname, 'data', 'broward-clerk', 'farming');

// SFTP credentials (public, per Broward County website)
const SFTP = {
  host: 'BCFTP.Broward.org',
  port: 22,
  user: 'crpublic',
  pass: 'crpublic'
};

// Document types relevant to farming signals
const FARMING_DOC_TYPES = {
  'LP':         { signal: 'lis_pendens',      category: 'distressed',   desc: 'Litigation Pending (pre-foreclosure)' },
  'FJ':         { signal: 'final_judgment',   category: 'distressed',   desc: 'Final Judgment (foreclosure)' },
  'CFJ':        { signal: 'final_judgment',   category: 'distressed',   desc: 'Certified Final Judgment' },
  'CJF':        { signal: 'judgment_foreign',  category: 'distressed',   desc: 'Certified Judgment - Foreign' },
  'PRO':        { signal: 'probate',          category: 'life_event',   desc: 'Probate' },
  'DC':         { signal: 'death',            category: 'life_event',   desc: 'Death Certificate' },
  'LIE':        { signal: 'lien',             category: 'distressed',   desc: 'Lien' },
  'LIEN CORP':  { signal: 'corp_lien',        category: 'distressed',   desc: 'Corporate Lien Warrant' },
  'RST':        { signal: 'satisfaction',     category: 'positive',     desc: 'Release/Satisfy/Terminate' },
  'D':          { signal: 'deed_transfer',    category: 'transfer',     desc: 'Deed Transfer' },
  'M':          { signal: 'mortgage',         category: 'mortgage',     desc: 'Mortgage/Modification' },
  'M EXEMPT':   { signal: 'mortgage',         category: 'mortgage',     desc: 'Mortgage Tax Exempt' },
  'NOH':        { signal: 'homestead_change', category: 'status',       desc: 'Notice of Homestead' },
  'AGD':        { signal: 'agreement_deed',   category: 'transfer',     desc: 'Agreement for Deed' },
  'EAS':        { signal: 'easement',         category: 'status',       desc: 'Easement' },
};

// ═══════════════════════════════════════════════════════════════════
// SFTP HELPERS
// ═══════════════════════════════════════════════════════════════════

function sftpCommand(commands) {
  const cmdStr = commands.join('\n');
  try {
    const result = execSync(
      `sshpass -p '${SFTP.pass}' sftp -o StrictHostKeyChecking=no ${SFTP.user}@${SFTP.host}`,
      { input: cmdStr, timeout: 300000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    return result;
  } catch (e) {
    console.error(`SFTP error: ${e.message}`);
    return '';
  }
}

function sftpDownload(remotePath, localPath) {
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    execSync(
      `sshpass -p '${SFTP.pass}' sftp -o StrictHostKeyChecking=no ${SFTP.user}@${SFTP.host}:${remotePath} ${localPath}`,
      { timeout: 600000, encoding: 'utf-8' }
    );
    return true;
  } catch (e) {
    // sftp get syntax differs — use batch mode
    const batchCmd = `get ${remotePath} ${localPath}`;
    try {
      execSync(
        `sshpass -p '${SFTP.pass}' sftp -o StrictHostKeyChecking=no -b - ${SFTP.user}@${SFTP.host}`,
        { input: batchCmd + '\nquit\n', timeout: 600000, encoding: 'utf-8' }
      );
      return true;
    } catch (e2) {
      console.error(`Download failed: ${remotePath} — ${e2.message}`);
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// PARSE BROWARD CLERK DATA
// ═══════════════════════════════════════════════════════════════════

function parseDocFile(filePath) {
  // DOC file: InstrumentNum|DateYMD|DateFormatted|Time|DocType|Consideration|BookNum|PageNum|BookType|Legal|ParcelID|DocTax|IntangTax|NumNames|Confidential|Status|RerecordFlag|Source|CaseNum
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(line => {
    const f = line.split('|');
    return {
      instrumentNum: f[0],
      recordDate: f[1],       // YYYYMMDD
      recordDateFmt: f[2],    // MM/DD/YYYY
      recordTime: f[3],       // HHMMSS
      docType: f[4],
      consideration: parseFloat(f[5]) || 0,
      bookNum: f[6],
      pageNum: f[7],
      bookType: f[8],
      legalDesc: f[9] || '',
      parcelId: f[10] || '',
      docTax: parseFloat(f[11]) || 0,
      intangTax: parseFloat(f[12]) || 0,
      numNames: parseInt(f[13]) || 0,
      confidential: parseInt(f[14]) || 0,
      status: f[15] || '',
      rerecordFlag: f[16] || '',
      source: f[17] || '',
      caseNum: f[18] || ''
    };
  }).filter(r => r.confidential === 0); // Skip sealed/expunged
}

function parseNameFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(line => {
    const f = line.split('|');
    return {
      instrumentNum: f[0],
      partyName: f[1],
      partyType: f[2],    // D = direct (from/grantor), R = reverse (to/grantee)
      nameSeq: parseInt(f[3]) || 1
    };
  });
}

function parseLegalFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(line => {
    const f = line.split('|');
    return {
      instrumentNum: f[0],
      legalDesc: f[1] || '',
      parcelId: f[2] || ''
    };
  });
}

function parseLinkFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(line => {
    const f = line.split('|');
    return {
      instrumentNum: f[0],
      bookNum: f[1],
      pageNum: f[2],
      bookType: f[3],
      docType: f[4],
      priorInstrumentNum: f[5] || '',
      priorBookNum: f[6] || '',
      priorPageNum: f[7] || '',
      priorBookType: f[8] || '',
      priorDocType: f[9] || '',
      keypunch: f[10] || ''
    };
  });
}

// ═══════════════════════════════════════════════════════════════════
// EXTRACT FARMING SIGNALS
// ═══════════════════════════════════════════════════════════════════

function extractFarmingSignals(docRecords, nameRecords) {
  // Index names by instrument number
  const nameIndex = {};
  for (const n of nameRecords) {
    if (!nameIndex[n.instrumentNum]) nameIndex[n.instrumentNum] = [];
    nameIndex[n.instrumentNum].push(n);
  }

  const farmingRecords = [];

  for (const doc of docRecords) {
    const typeInfo = FARMING_DOC_TYPES[doc.docType];
    if (!typeInfo) continue;

    const names = nameIndex[doc.instrumentNum] || [];
    const grantors = names.filter(n => n.partyType === 'D').map(n => n.partyName);
    const grantees = names.filter(n => n.partyType === 'R').map(n => n.partyName);

    // Compute document hash for provenance
    const hashInput = `${doc.instrumentNum}|${doc.recordDate}|${doc.docType}|${doc.consideration}|${grantors.join(',')}|${grantees.join(',')}`;
    const docHash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

    farmingRecords.push({
      instrumentNum: doc.instrumentNum,
      recordDate: doc.recordDateFmt,
      docType: doc.docType,
      signal: typeInfo.signal,
      category: typeInfo.category,
      description: typeInfo.desc,
      consideration: doc.consideration,
      parcelId: doc.parcelId,
      legalDesc: doc.legalDesc.slice(0, 100),
      grantors,
      grantees,
      caseNum: doc.caseNum,
      hash: docHash,
      source: 'broward-clerk-sftp',
      sourceUrl: 'BCFTP.Broward.org',
      retrievedAt: new Date().toISOString()
    });
  }

  return farmingRecords;
}

// ═══════════════════════════════════════════════════════════════════
// CLI COMMANDS
// ═══════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);

if (args.includes('--daily')) {
  // Download latest 10 days of daily files (index only, skip images)
  console.log('\n=== Pulling Broward County Daily Official Records ===\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // List available daily files
  const listing = sftpCommand(['ls Official_Records_Download/', 'quit']);
  const dateFiles = listing.match(/\d{2}-\d{2}-\d{4}doc-ver\.txt/g) || [];
  const dates = [...new Set(dateFiles.map(f => f.replace('doc-ver.txt', '')))];

  console.log(`  Found ${dates.length} days available`);

  let totalDocs = 0;
  let totalNames = 0;
  let totalFarming = 0;

  for (const date of dates.sort()) {
    const docFile = `${date}doc-ver.txt`;
    const nmeFile = `${date}nme-ver.txt`;
    const lglFile = `${date}lgl-ver.txt`;
    const lnkFile = `${date}lnk-ver.txt`;

    const localDoc = path.join(DATA_DIR, docFile);

    // Skip if already downloaded
    if (fs.existsSync(localDoc)) {
      console.log(`  ${date} — already downloaded, skipping`);
      continue;
    }

    console.log(`  Downloading ${date}...`);
    const batch = [
      `lcd ${DATA_DIR}`,
      `get Official_Records_Download/${docFile}`,
      `get Official_Records_Download/${nmeFile}`,
      `get Official_Records_Download/${lglFile}`,
      `get Official_Records_Download/${lnkFile}`,
      'quit'
    ];
    sftpCommand(batch);

    // Parse and extract farming signals
    if (fs.existsSync(localDoc)) {
      const docs = parseDocFile(localDoc);
      const names = parseNameFile(path.join(DATA_DIR, nmeFile));
      const farming = extractFarmingSignals(docs, names);

      totalDocs += docs.length;
      totalNames += names.length;
      totalFarming += farming.length;

      console.log(`    ${docs.length} documents, ${names.length} names, ${farming.length} farming signals`);

      // Append farming records to JSONL
      if (farming.length > 0) {
        if (!fs.existsSync(FARMING_DIR)) fs.mkdirSync(FARMING_DIR, { recursive: true });
        const farmingFile = path.join(FARMING_DIR, `broward-farming-${date.replace(/-/g, '')}.jsonl`);
        const jsonl = farming.map(r => JSON.stringify(r)).join('\n') + '\n';
        fs.writeFileSync(farmingFile, jsonl);
      }
    }
  }

  console.log(`\n  Total: ${totalDocs} documents, ${totalNames} names, ${totalFarming} farming signals`);
  console.log(`  Data saved to: ${DATA_DIR}`);
  console.log(`  Farming signals: ${FARMING_DIR}`);

  // Harvester heartbeat — proves OUR pull ran AND reached the source, even on a
  // no-op day. service-health.mjs reads this to tell "our cron/SFTP is broken"
  // (page me) apart from "the county just hasn't published" (their problem, not
  // ours). Only written when the listing came back non-empty — an empty listing
  // means we failed to connect, so we deliberately leave the stamp stale.
  if (dateFiles.length > 0) {
    const newestAvailable = dates
      .map(d => { const [mm, dd, yyyy] = d.split('-'); return { d, t: Date.parse(`${yyyy}-${mm}-${dd}`) }; })
      .sort((a, b) => b.t - a.t)[0]?.d || null;
    const stamp = {
      at: new Date().toISOString(),
      connected: true,
      daysAvailable: dates.length,
      newestAvailable,           // newest date the COUNTY offers (MM-DD-YYYY)
      downloadedThisRun: totalDocs,
    };
    try {
      fs.writeFileSync(path.join(DATA_DIR, '.last-harvest.json'), JSON.stringify(stamp, null, 2));
      console.log(`  Heartbeat written (source newest: ${newestAvailable})`);
    } catch (e) {
      console.error(`  heartbeat write failed: ${e.message}`);
    }
  }

  // Auto-rebuild SQLite if --rebuild-db flag is present (used by cron)
  if (args.includes('--rebuild-db') && totalFarming > 0) {
    console.log('\n  Rebuilding farming-signals.db...');
    try {
      execSync('node build-clerk-sqlite.mjs', { cwd: __dirname, stdio: 'inherit', timeout: 300000 });
    } catch (e) {
      console.error(`  SQLite rebuild failed: ${e.message}`);
    }
  }

} else if (args.includes('--year')) {
  const year = args[args.indexOf('--year') + 1];
  if (!year) { console.log('Usage: --year 2025'); process.exit(1); }

  console.log(`\n=== Pulling Broward County Yearly Export: ${year} ===\n`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const files = [`CY${year}doc-rec.txt`, `CY${year}nme-rec.txt`, `CY${year}lnk-rec.txt`];
  if (parseInt(year) >= 2016) files.push(`CY${year}lgl-rec.txt`);

  for (const file of files) {
    const localPath = path.join(DATA_DIR, file);
    if (fs.existsSync(localPath)) {
      console.log(`  ${file} — already downloaded`);
      continue;
    }
    console.log(`  Downloading ${file}...`);
    sftpCommand([`lcd ${DATA_DIR}`, `get OR_Yearly_Exports/${file}`, 'quit']);

    if (fs.existsSync(localPath)) {
      const size = fs.statSync(localPath).size;
      const lines = execSync(`wc -l < "${localPath}"`, { encoding: 'utf-8' }).trim();
      console.log(`    ${lines} records (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }

  // Parse and extract farming signals for the year
  const docFile = path.join(DATA_DIR, `CY${year}doc-rec.txt`);
  const nmeFile = path.join(DATA_DIR, `CY${year}nme-rec.txt`);

  if (fs.existsSync(docFile) && fs.existsSync(nmeFile)) {
    console.log(`\n  Extracting farming signals for ${year}...`);
    const docs = parseDocFile(docFile);
    const names = parseNameFile(nmeFile);
    const farming = extractFarmingSignals(docs, names);

    // Count by signal type
    const signalCounts = {};
    for (const r of farming) {
      signalCounts[r.signal] = (signalCounts[r.signal] || 0) + 1;
    }

    console.log(`\n  ${year} Farming Signal Summary:`);
    console.log(`  Total documents: ${docs.length.toLocaleString()}`);
    console.log(`  Farming-relevant: ${farming.length.toLocaleString()}`);
    for (const [signal, count] of Object.entries(signalCounts).sort((a, b) => b[1] - a[1])) {
      const info = Object.values(FARMING_DOC_TYPES).find(t => t.signal === signal);
      console.log(`    ${signal.padEnd(20)} ${count.toLocaleString().padStart(8)}  (${info?.desc || ''})`);
    }

    // Save farming JSONL
    if (!fs.existsSync(FARMING_DIR)) fs.mkdirSync(FARMING_DIR, { recursive: true });
    const farmingFile = path.join(FARMING_DIR, `broward-farming-${year}.jsonl`);
    const jsonl = farming.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(farmingFile, jsonl);
    console.log(`\n  Saved to: ${farmingFile}`);
  }

} else if (args.includes('--farming')) {
  // Show farming signal stats from already-downloaded data
  console.log('\n=== Broward County Farming Signal Summary ===\n');

  if (!fs.existsSync(FARMING_DIR)) {
    console.log('  No farming data yet. Run --daily or --year first.');
    process.exit(0);
  }

  const files = fs.readdirSync(FARMING_DIR).filter(f => f.endsWith('.jsonl'));
  let total = 0;
  const signalCounts = {};
  const recentLP = []; // Recent lis pendens

  for (const file of files) {
    const lines = fs.readFileSync(path.join(FARMING_DIR, file), 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        total++;
        signalCounts[r.signal] = (signalCounts[r.signal] || 0) + 1;
        if (r.signal === 'lis_pendens' && recentLP.length < 10) {
          recentLP.push(r);
        }
      } catch {}
    }
  }

  console.log(`  Total farming signals: ${total.toLocaleString()}`);
  console.log(`  Files: ${files.length}`);
  console.log('');
  for (const [signal, count] of Object.entries(signalCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${signal.padEnd(22)} ${count.toLocaleString().padStart(8)}`);
  }

  if (recentLP.length > 0) {
    console.log('\n  Recent Lis Pendens (pre-foreclosures):');
    for (const lp of recentLP) {
      console.log(`    ${lp.recordDate} | ${lp.parcelId || 'no parcel'} | ${lp.grantees[0] || '?'} vs ${lp.grantors[0] || '?'}`);
    }
  }

} else if (args.includes('--stats')) {
  console.log('\n=== Broward Clerk Data Stats ===\n');

  if (!fs.existsSync(DATA_DIR)) {
    console.log('  No data yet. Run --daily or --year first.');
    process.exit(0);
  }

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
  let totalSize = 0;
  for (const file of files) {
    const size = fs.statSync(path.join(DATA_DIR, file)).size;
    totalSize += size;
  }
  console.log(`  Files: ${files.length}`);
  console.log(`  Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

} else {
  console.log(`
Broward County Official Records — SFTP Bulk Ingestion
Source: BCFTP.Broward.org (public, no cost)

Usage:
  node pull-broward-clerk.mjs --daily          Pull latest 10 days
  node pull-broward-clerk.mjs --year 2025      Pull full year export
  node pull-broward-clerk.mjs --farming        Show farming signal stats
  node pull-broward-clerk.mjs --stats          Show data stats

Farming Document Types:
  LP   — Lis Pendens (pre-foreclosure)
  FJ   — Final Judgment (foreclosure)
  PRO  — Probate
  DC   — Death Certificate
  LIE  — Lien
  RST  — Release/Satisfy (mortgage paid off)
  D    — Deed Transfer
  M    — Mortgage
  NOH  — Notice of Homestead
  `);
}
