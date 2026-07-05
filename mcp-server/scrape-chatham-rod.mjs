#!/usr/bin/env node
// Chatham County Register of Deeds — recorded-instrument puller (Playwright).
//
// The ROD remote-access site is a Logan Systems "Full System" Blazor app. It is
// open (acknowledge a disclaimer) and NOT CAPTCHA-gated. We drive the live UI:
//   Acknowledge Disclaimer -> Full System -> Instrument Date tab
//   -> set recorded-date range -> Search -> read the Index Detail grid -> paginate.
//
// This is the legitimate source for the data the county assessor file lacks:
//   DEED OF TRUST  = mortgages (loan amount carried in the Description / REV)
//   DEED           = ownership transfers (REV stamp encodes sale price)
//   plus liens, lis pendens, satisfactions, etc. by instrument Type.
//
// Records join to our CAMA parcels by Book/Page (parcel.current_book/current_page),
// a high-confidence link that avoids fragile name matching.
//
// Field element IDs are session-generated GUIDs, so every control is located by
// its stable LABEL text, never a hardcoded id.
//
// Usage:
//   node scrape-chatham-rod.mjs --from 03/01/2026 --to 05/21/2026
//   node scrape-chatham-rod.mjs --months 3                 # last N months
//   node scrape-chatham-rod.mjs --months 3 --types "DEED OF TRUST"
//   node scrape-chatham-rod.mjs --months 1 --visible       # watch the browser

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'nc', 'chatham');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const args = process.argv.slice(2);
const argVal = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const VISIBLE = args.includes('--visible');
const TYPES = argVal('--types', '');            // e.g. "D-T" (deed of trust) or "" for all
const BASE = 'https://www.chathamncrod.org/';

// ── date range, chunked monthly (keeps each result set well under any cap) ──
function fmt(d) { return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; }
function buildChunks() {
  let from, to;
  if (args.includes('--from')) {
    from = new Date(argVal('--from')); to = new Date(argVal('--to', fmt(new Date())));
  } else {
    const months = parseInt(argVal('--months', '3'));
    to = new Date(); from = new Date(); from.setMonth(from.getMonth() - months);
  }
  const chunks = [];
  let s = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (s <= to) {
    const e = new Date(s.getFullYear(), s.getMonth() + 1, 0); // end of that month
    chunks.push({ start: fmt(s), end: fmt(e > to ? to : e) });
    s = new Date(s.getFullYear(), s.getMonth() + 1, 1);
  }
  return chunks;
}

async function typeInto(page, labelText, value) {
  // The form is made ready by gotoSearchForm()'s readiness waits; type once.
  // (DevExpress masked editors don't reliably echo their value via inputValue(),
  // so we don't read it back — an empty search is caught by the detailCount check.)
  const inp = page.locator(`text=${labelText}`).first().locator('xpath=following::input[1]');
  await inp.click();
  await inp.fill('');
  await page.keyboard.type(value, { delay: 40 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(450);
}

const gridRowCount = (page) => page.evaluate(() =>
  Math.max(0, ...[...document.querySelectorAll('table')].map(t => t.querySelectorAll('tbody tr').length)));

// Open the DevExpress "Page Size:" combobox and select "All" so the grid renders
// every matching record on one page. The page-size combo is identified by its
// dropdown options being page sizes (10/20/.../All) — not by position. Returns
// true once the grid has grown past the default page.
async function setPageSizeAll(page) {
  const combos = page.locator('input[role="combobox"]');
  const n = await combos.count();
  for (let i = 0; i < n; i++) {
    const c = combos.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    await c.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    const opts = await page.locator('[role="option"], .dxbl-listbox-item').allInnerTexts().catch(() => []);
    const looksLikePageSize = opts.some(o => /^All$/i.test(o.trim())) && opts.some(o => /^\d+$/.test(o.trim()));
    if (looksLikePageSize) {
      await page.locator('[role="option"], .dxbl-listbox-item', { hasText: /^\s*All\s*$/i }).first().click().catch(() => {});
      // wait for the grid to grow beyond the default 20/page
      for (let w = 0; w < 30; w++) { await page.waitForTimeout(700); if (await gridRowCount(page) > 25) return true; }
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});  // wrong combo — close and continue
  }
  return false;
}

async function readGrid(page) {
  return await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')].map(t => ({ t, n: t.querySelectorAll('tr').length }));
    tables.sort((a, b) => b.n - a.n);
    const tbl = tables[0]?.t;
    if (!tbl) return [];
    const heads = [...tbl.querySelectorAll('th')].map(h => h.textContent.trim());
    const idx = name => heads.findIndex(h => h.toLowerCase().includes(name));
    const ci = { date: idx('rec date'), instr: idx('instrument'), book: idx('book'), page: idx('page'), type: idx('type'), desc: idx('description') };
    return [...tbl.querySelectorAll('tbody tr')].map(r => {
      const c = [...r.querySelectorAll('td')].map(td => td.textContent.trim());
      const g = i => (i >= 0 && c[i] != null) ? c[i] : '';
      return { recDate: g(ci.date), instrumentNum: g(ci.instr), book: g(ci.book), page: g(ci.page), type: g(ci.type), description: g(ci.desc) };
    }).filter(r => r.book || r.instrumentNum);
  });
}

async function main() {
  const chunks = buildChunks();
  console.log(`Chatham ROD pull — ${chunks.length} monthly chunk(s)${TYPES ? `, types="${TYPES}"` : ' (all types)'} — mode: ${VISIBLE ? 'visible' : 'headless'}`);

  const browser = await chromium.launch({ headless: !VISIBLE, slowMo: VISIBLE ? 40 : 0 });
  const page = await (await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  })).newPage();

  const outFile = path.join(DATA_DIR, 'rod-instruments.jsonl');
  const stream = fs.createWriteStream(outFile);
  let grand = 0;

  // Navigate from a clean slate to the Instrument-Date search form. Doing this
  // per chunk (rather than reusing the post-results state) avoids flaky Blazor
  // state carryover between searches.
  async function gotoSearchForm() {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
    await page.click('text=Acknowledge Disclaimer', { timeout: 20000 });
    // Blazor renders the menu over SignalR — wait for the actual control, not a timer
    await page.locator('text=Full System (Indexing and Imaging Combined Retrieval)').first().waitFor({ timeout: 25000 });
    await page.click('text=Full System (Indexing and Imaging Combined Retrieval)', { timeout: 15000 });
    await page.locator('text=Instrument Date').first().waitFor({ timeout: 25000 });
    await page.click('text=Instrument Date', { timeout: 10000 });
    // wait for the search form to be interactive before typing
    await page.locator('text=Start Date').first().waitFor({ timeout: 20000 });
    await page.locator('button:has-text("Search")').first().waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(1200);
  }

  const failed = [];
  for (const ch of chunks) {
    console.log(`\n[${ch.start} – ${ch.end}]`);
    try {
      await gotoSearchForm();
      await typeInto(page, 'Start Date', ch.start);
      await typeInto(page, 'End Date', ch.end);
      if (TYPES) await typeInto(page, 'Instrument Types', TYPES);
      await page.click('button:has-text("Search")', { timeout: 8000 });
      await page.waitForTimeout(7000);

      // open the Index Detail tab (the actual records) + read its total
      const detailCount = await page.evaluate(() => {
        const el = [...document.querySelectorAll('a,li,button')].find(t => /Index Detail\s*\(\d+\)/.test(t.textContent||''));
        if (el) el.click();
        const m = (el?.textContent||'').match(/\((\d+)\)/);
        return m ? parseInt(m[1]) : 0;
      });
      await page.waitForTimeout(3000);
      console.log(`  Index Detail records: ${detailCount}`);
      if (!detailCount) continue;

      // The grid is a DevExpress paged grid defaulting to 20/page. Open the
      // page-size combobox and choose "All" so every record renders at once.
      await setPageSizeAll(page);
      let prev = -1;                              // poll until rendered rows stabilise
      for (let w = 0; w < 40; w++) {
        const cur = await gridRowCount(page);
        if (cur >= detailCount || (cur === prev && cur > 25)) break;
        prev = cur; await page.waitForTimeout(800);
      }

      const rows = await readGrid(page);
      let chunkTotal = 0;
      for (const r of rows) {
        stream.write(JSON.stringify({ ...r, chunk: `${ch.start}-${ch.end}`, scraped: new Date().toISOString() }) + '\n');
        chunkTotal++; grand++;
      }
      const flag = chunkTotal < detailCount ? `  ⚠ captured ${chunkTotal}/${detailCount} — INCOMPLETE` : '';
      console.log(`  captured ${chunkTotal}/${detailCount} rows${flag}`);
      if (chunkTotal < detailCount) failed.push(`${ch.start}-${ch.end} (${chunkTotal}/${detailCount})`);
      await page.waitForTimeout(1000); // polite between chunks
    } catch (e) {
      console.error(`  CHUNK FAILED [${ch.start}-${ch.end}]: ${e.message}`);
      failed.push(`${ch.start}-${ch.end} (error)`);
    }
  }
  if (failed.length) console.log(`\n⚠ Incomplete/failed chunks: ${failed.join(', ')}`);

  stream.end();
  await browser.close();
  console.log(`\nDONE — ${grand.toLocaleString()} instruments -> ${outFile}`);
}

main().catch(console.error);
