/**
 * AI_CONTEXT: Generate sitemaps so search engines (and the AIs that depend on them —
 * Perplexity/Gemini/Copilot/ChatGPT) can discover and index title's property pages.
 *
 * WHY (Jun 20 2026): title's sitemap listed only ~6 nav pages, so crawlers had no
 * path into the 10M+ property bridge pages (which ARE indexable HTML with JSON-LD).
 * This emits a sitemap INDEX + child sitemaps of real property URLs, drawn from the
 * SQLite index, into DATA_DIR/sitemaps/ (served by server.js). Regenerated monthly
 * by the FL cron (the sitemap is "served data" — same freshness discipline as the DB).
 *
 * Strategy: the highest-signal + highest-value properties per city give crawlers broad
 * geographic + meaningful coverage without listing all 10M (sitemap cap = 50k URLs/file).
 *
 * Run from title-rootz-v2 (for better-sqlite3 + config):
 *   cd /var/www/title-rootz-v2 && node build-sitemap.mjs
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { DATA_DIR } from './src/lib/config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const BASE = 'https://title.rootz.global';
const PER_CITY = 200;                // top properties per city (signal + value). NOTE:
                                     // bridge pages are dynamically rendered (~20s cold)
                                     // on a 2-core box, so we list the highest-value +
                                     // highest-signal subset rather than all 10.3M —
                                     // listing every dynamic page would let crawlers
                                     // saturate the box. Full coverage needs STATIC/
                                     // cached bridge pages first (see report/memory).
const MAX_PER_FILE = 45000;          // under the 50k sitemap limit
const today = new Date().toISOString().slice(0, 10);
const outDir = path.join(DATA_DIR, 'sitemaps');
fs.mkdirSync(outDir, { recursive: true });

const xmlEsc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const propUrl = (addr, city, state) =>
  `${BASE}/p/?address=${encodeURIComponent(addr)}&amp;city=${encodeURIComponent(city)}${state && state !== 'FL' ? '&amp;state=' + state : ''}`;

function writeUrlset(file, urls) {
  const body = urls.map(u =>
    `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}${u.priority ? `<priority>${u.priority}</priority>` : ''}</url>`
  ).join('\n');
  fs.writeFileSync(path.join(outDir, file), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`);
}

// ── Nav / hub pages ──────────────────────────────────────────────────
const pages = [
  { loc: `${BASE}/`, changefreq: 'weekly', priority: '1.0' },
  { loc: `${BASE}/farm`, changefreq: 'daily', priority: '0.9' },
  { loc: `${BASE}/pricing`, changefreq: 'monthly', priority: '0.7' },
  { loc: `${BASE}/.well-known/ai`, changefreq: 'weekly', priority: '0.8' },
  { loc: `${BASE}/api`, changefreq: 'weekly', priority: '0.7' },
  { loc: `${BASE}/api/fl/economics`, changefreq: 'daily', priority: '0.6' },
];
writeUrlset('sitemap-pages.xml', pages);

// ── FL property pages from the SQLite index ──────────────────────────
const childFiles = ['sitemap-pages.xml'];
const dbPath = path.join(DATA_DIR, 'florida', 'parcels.db');
if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true });
  const cities = db.prepare(`SELECT city, COUNT(*) n FROM parcels WHERE city != '' GROUP BY city HAVING n >= 5 ORDER BY n DESC`).all();
  const top = db.prepare(`SELECT situs_addr FROM parcels WHERE city = ? AND situs_addr != '' ORDER BY base_score DESC, total_val DESC LIMIT ${PER_CITY}`);

  let urls = [], fileNo = 0;
  const flush = () => {
    if (!urls.length) return;
    fileNo++;
    const name = `sitemap-fl-${fileNo}.xml`;
    writeUrlset(name, urls);
    childFiles.push(name);
    urls = [];
  };
  for (const { city } of cities) {
    for (const r of top.all(city)) {
      urls.push({ loc: propUrl(r.situs_addr, city, 'FL'), lastmod: today, changefreq: 'monthly', priority: '0.5' });
      if (urls.length >= MAX_PER_FILE) flush();
    }
  }
  flush();
  db.close();
  console.log(`FL: ${cities.length} cities, ${fileNo} property sitemap file(s).`);
} else {
  console.log('FL parcels.db not found — property sitemap skipped (nav only).');
}

// ── Sitemap index ────────────────────────────────────────────────────
const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${childFiles.map(f => `  <sitemap><loc>${BASE}/${f}</loc><lastmod>${today}</lastmod></sitemap>`).join('\n')}
</sitemapindex>`;
fs.writeFileSync(path.join(outDir, 'sitemap.xml'), index);

const total = childFiles.reduce((n, f) => n + (fs.readFileSync(path.join(outDir, f), 'utf8').match(/<url>/g) || []).length, 0);
console.log(`Wrote ${childFiles.length} child sitemaps + index → ${outDir} (${total.toLocaleString()} URLs).`);
