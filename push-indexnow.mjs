/**
 * AI_CONTEXT: Push title's URLs to IndexNow (Bing + Yandex + Seznam + Naver) so the
 * search engines behind Copilot / ChatGPT-browsing / DuckDuckGo discover them fast.
 *
 * Reads the generated sitemap URLs (DATA_DIR/sitemaps/sitemap-*.xml), de-dupes, and
 * POSTs up to 10,000 to api.indexnow.org. The key file must already be served at
 * https://title.rootz.global/<key>.txt (server.js handler). Run after build-sitemap.mjs.
 *
 *   cd /var/www/title-rootz-v2 && node push-indexnow.mjs
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './src/lib/config.js';

const HOST = 'title.rootz.global';
const KEY = 'd1fd9dff94f72edb9808ccc1f12b4aba';
const dir = path.join(DATA_DIR, 'sitemaps');

let urls = [];
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter(f => /^sitemap-.*\.xml$/.test(f))) {
    const xml = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of xml.match(/<loc>(.+?)<\/loc>/g) || []) {
      urls.push(m.replace(/<\/?loc>/g, '').replace(/&amp;/g, '&'));
    }
  }
}
urls = [...new Set(urls)].slice(0, 10000);
if (!urls.length) { console.error('No URLs found in sitemaps — run build-sitemap.mjs first.'); process.exit(1); }

const body = JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls });
const resp = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body,
});
console.log(`IndexNow: HTTP ${resp.status} ${resp.statusText} — submitted ${urls.length} URLs (key ${KEY}).`);
console.log('  200/202 = accepted. 403 = key not verifiable (check key file is live). 422 = URL/host mismatch.');
