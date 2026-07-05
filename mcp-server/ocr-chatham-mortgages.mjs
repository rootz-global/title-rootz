#!/usr/bin/env node
// Chatham County mortgage OCR pipeline (scheduled job).
//
// For each Deed of Trust in the Register-of-Deeds index, retrieve the scanned
// document, OCR it, and extract the ACTUAL loan amount + lender — then join it to
// the exact parcel by the Exhibit-A prior-deed book/page. Turns "mortgage =
// estimate" into "mortgage = recorded fact" on the NC seller list.
//
// Pipeline per document:
//   1. retrieve  — headless Playwright drives the Logan Imaging Document panel
//                  (type Book/Page -> "View Page(s)" -> download the generated PDF)
//   2. render    — PyMuPDF rasterises page 1 + the last page (Exhibit A) to PNG
//   3. OCR       — Claude vision extracts {loanAmount, lender, borrower, priorDeed}
//   4. join      — match priorDeed book/page (or PIN) to a CAMA parcel
//   5. append    — write to rod-mortgages.jsonl (read by nc-property.js)
//
// Idempotent: skips D-Ts already in rod-mortgages.jsonl. Throttled + capped per
// run (--limit) so it is gentle on the county server. Reuses ONE browser session.
//
// Usage:
//   node ocr-chatham-mortgages.mjs --limit 25
//   node ocr-chatham-mortgages.mjs --book 2513 --page 1006   # one document (test)

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'data', 'nc', 'chatham');
const OUT = path.join(DIR, 'rod-mortgages.jsonl');
const MODEL = 'claude-haiku-4-5-20251001';
const PYTHON = process.env.PYTHON || 'python3';

const args = process.argv.slice(2);
const argv = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const LIMIT = parseInt(argv('--limit', '25'));
const ONE = args.includes('--book') ? { book: argv('--book'), page: argv('--page') } : null;

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from env
const norm = s => String(s || '').toUpperCase().replace(/^0+/, '').trim();

// ── load D-T worklist + parcel join index + already-done set ──────
function readJsonl(f) { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []; }

const parcels = readJsonl(path.join(DIR, 'cama-parcels.jsonl'));
const parcelByBP = new Map();   // book/page -> parcel
const parcelByNum = new Map();  // parcel_number -> parcel
for (const p of parcels) {
  parcelByBP.set(`${norm(p.current_book)}/${norm(p.current_page)}`, p);
  parcelByNum.set(norm(p.parcel_number), p);
}

const done = new Set(readJsonl(OUT).map(m => `${norm(m.book)}/${norm(m.page)}`));

let work;
if (ONE) work = [{ book: ONE.book, page: ONE.page, type: 'D-T' }];
else {
  work = readJsonl(path.join(DIR, 'rod-instruments.jsonl'))
    .filter(r => /^D-T$/i.test((r.type || '').trim()))
    .filter(r => !done.has(`${norm(r.book)}/${norm(r.page)}`))
    .slice(0, LIMIT);
}
console.log(`Chatham mortgage OCR — ${work.length} deed(s) of trust to process (model ${MODEL})`);
if (!work.length) { console.log('nothing to do'); process.exit(0); }

// ── PyMuPDF render: page 1 + last page -> base64 PNG ──────────────
function renderPages(pdfPath) {
  const py = `
import fitz, base64, json, sys
doc = fitz.open(sys.argv[1])
idx = sorted(set([0, doc.page_count-1]))
out = []
for i in idx:
    pix = doc[i].get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
    out.append(base64.b64encode(pix.tobytes("png")).decode())
print(json.dumps(out))
`;
  const res = execFileSync(PYTHON, ['-c', py, pdfPath], { maxBuffer: 64 * 1024 * 1024 }).toString();
  return JSON.parse(res); // array of base64 PNGs
}

// ── Claude vision OCR ─────────────────────────────────────────────
async function ocrDocument(images) {
  const content = [
    { type: 'text', text: `These are pages of a recorded North Carolina Deed of Trust (a mortgage). Extract the key facts as STRICT JSON, no prose. Fields:
{"docType": "deed of trust" | "modification" | "other",
 "loanAmount": number | null,        // the principal / maximum credit-line amount in dollars (e.g. 375000)
 "isLineOfCredit": boolean,
 "lender": string | null,            // beneficiary / lender name
 "borrower": string | null,          // grantor name
 "recordedDate": string | null,      // YYYY-MM-DD if shown
 "priorDeedBook": string | null,     // from "Exhibit A" / legal description: prior conveying deed book
 "priorDeedPage": string | null,
 "pin": string | null}               // parcel PIN if shown
If a value is not present, use null. Return ONLY the JSON object.` }
  ];
  for (const b64 of images) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
  const resp = await anthropic.messages.create({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content }] });
  const txt = resp.content.map(c => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// ── retrieve one document via the Imaging Document panel ──────────
async function fillByLabel(page, label, val) {
  const id = await page.evaluate((label) => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const lab = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim().toLowerCase() === label.toLowerCase() && vis(e));
    if (!lab) return null;
    const ly = lab.getBoundingClientRect().top;
    const best = [...document.querySelectorAll('input')].filter(vis).map(i => ({ i, d: Math.abs(i.getBoundingClientRect().top - ly) })).sort((a, b) => a.d - b.d)[0];
    if (!best || best.d > 40) return null;
    if (!best.i.id) best.i.id = '__tmp_' + label;
    return best.i.id;
  }, label);
  if (!id) throw new Error('input not found: ' + label);
  const inp = page.locator('#' + id);
  await inp.click({ timeout: 6000 }); await inp.fill(''); await page.keyboard.type(val, { delay: 60 }); await page.keyboard.press('Tab'); await page.waitForTimeout(350);
}

async function retrieve(ctx, page, book, pg) {
  await fillByLabel(page, 'Book', book);
  await fillByLabel(page, 'Page', pg);
  await page.getByText(/View Page\(s\)/i).first().click({ timeout: 8000 });
  await page.waitForTimeout(7000);
  const href = await page.evaluate(() => [...document.querySelectorAll('a')].find(a => /open in new tab/i.test(a.textContent || ''))?.href || null);
  if (!href || !/\.pdf/i.test(href)) return null;
  const resp = await ctx.request.get(href);
  return Buffer.from(await resp.body());
}

// ── main loop ─────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36' });
const page = await ctx.newPage();
const stream = fs.createWriteStream(OUT, { flags: 'a' });
let ok = 0, matched = 0, fail = 0;

try {
  await page.goto('https://www.chathamncrod.org/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.getByText(/Acknowledge Disclaimer/i).first().click({ timeout: 20000 });
  await page.waitForTimeout(4000);
  await page.getByText(/^Imaging$/).first().click({ timeout: 12000 });
  await page.waitForTimeout(5000);

  for (const d of work) {
    const tmp = path.join(os.tmpdir(), `rod-${d.book}-${d.page}.pdf`);
    try {
      const pdf = await retrieve(ctx, page, d.book, d.page);
      if (!pdf || pdf.length < 20000) { console.log(`  ${d.book}/${d.page}: no image (${pdf?.length || 0}b)`); fail++; continue; }
      fs.writeFileSync(tmp, pdf);
      const imgs = renderPages(tmp);
      const ocr = await ocrDocument(imgs);
      fs.unlinkSync(tmp);
      if (!ocr) { console.log(`  ${d.book}/${d.page}: OCR returned nothing`); fail++; continue; }

      // join to parcel: prior-deed book/page first, then PIN
      let parcel = ocr.priorDeedBook ? parcelByBP.get(`${norm(ocr.priorDeedBook)}/${norm(ocr.priorDeedPage)}`) : null;
      if (!parcel && ocr.pin) parcel = parcelByNum.get(norm(ocr.pin));
      if (parcel) matched++;

      const rec = {
        book: d.book, page: d.page, instrumentNum: d.instrumentNum || '',
        docType: ocr.docType, loanAmount: ocr.loanAmount, isLineOfCredit: !!ocr.isLineOfCredit,
        lender: ocr.lender, borrower: ocr.borrower, recordedDate: ocr.recordedDate,
        priorDeed: ocr.priorDeedBook ? `${ocr.priorDeedBook}/${ocr.priorDeedPage}` : null, pin: ocr.pin,
        parcelNumber: parcel ? parcel.parcel_number : null,
        parcelOwner: parcel ? (parcel.current_owners || parcel.jan1_owners) : null,
        parcelFMV: parcel ? (parcel.jan1_total_FMV || null) : null,
        equityEstimate: (parcel && ocr.loanAmount && parcel.jan1_total_FMV) ? Math.max(0, parcel.jan1_total_FMV - ocr.loanAmount) : null,
        ocrModel: MODEL, ocrAt: new Date().toISOString()
      };
      stream.write(JSON.stringify(rec) + '\n');
      ok++;
      console.log(`  ${d.book}/${d.page}: $${ocr.loanAmount?.toLocaleString?.() || ocr.loanAmount} ${ocr.lender || ''} ${parcel ? '-> parcel ' + parcel.parcel_number : '(no parcel match)'}`);
      await page.waitForTimeout(1500); // polite
    } catch (e) {
      console.log(`  ${d.book}/${d.page}: ERROR ${e.message.split('\n')[0]}`); fail++;
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
  }
} catch (e) {
  console.error('FATAL', e.message);
} finally {
  stream.end();
  await browser.close();
}
console.log(`\nDONE — OCR'd ${ok}, parcel-matched ${matched}, failed ${fail} -> ${OUT}`);
