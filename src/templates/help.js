/**
 * AI_CONTEXT: Help/FAQ page template — how to use farming, signals explained, data coverage
 *
 * Dependencies: src/templates/nav.js (renderNav)
 * Exports: renderHelpPage(account)
 */

import { renderNav } from './nav.js';

export function renderHelpPage(account) {
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
  <li><strong>"I want to farm in Fort Lauderdale"</strong> — finds top-scored prospects</li>
  <li><strong>"Show me probate filings in Hollywood"</strong> — filters by specific signals</li>
  <li><strong>"Tell me about 1725 SW 14 ST, Fort Lauderdale"</strong> — full intelligence on an address</li>
  <li><strong>"Find corporate-owned properties with liens"</strong> — combines multiple signals</li>
</ul>

<h2>Farming Signals</h2>
<p>Every property is scored 0-100 based on signals that indicate the owner may sell:</p>
<ul>
  <li><strong>Probate</strong> — estate being settled, heirs often sell</li>
  <li><strong>Lis Pendens</strong> — litigation pending (pre-foreclosure)</li>
  <li><strong>Lien</strong> — unpaid debts attached to property</li>
  <li><strong>Death Certificate</strong> — owner deceased, property in transition</li>
  <li><strong>Absentee Owner</strong> — owner lives at a different address</li>
  <li><strong>Out-of-State Owner</strong> — owner in another state</li>
  <li><strong>Corporate/LLC Owner</strong> — investment property</li>
  <li><strong>Long-Term Owner</strong> — owned 15+ years, likely significant equity</li>
  <li><strong>No Homestead</strong> — not primary residence</li>
</ul>

<h2>Bridge Pages</h2>
<p>Click "Full intelligence" links to see complete property pages with farming score, court records, flood zone, schools, permits, and demographics.</p>

<h2>Saving Properties</h2>
<p>Click "Save to list" on any bridge page. From <a href="/saved">Saved Properties</a> you can add notes, track status, and export to CSV.</p>

<h2>Your Subscription</h2>
<ul>
  <li><strong>Free</strong> — 5 searches/day, basic results</li>
  <li><strong>Starter ($29/mo)</strong> — 50 searches/day, mailing addresses</li>
  <li><strong>Pro ($49/mo)</strong> — 200 searches/day, court records, Sonnet AI</li>
  <li><strong>Unlimited ($99/mo)</strong> — unlimited searches, everything in Pro</li>
</ul>

<h2>Data Coverage</h2>
<ul>
  <li>10.8M FL parcels (all 67 counties)</li>
  <li>908K Broward County court filings</li>
  <li>842K building permits (5 counties)</li>
  <li>FEMA flood zones (nationwide)</li>
  <li>Census demographics (block group)</li>
  <li>Schools, hospitals, EV charging (statewide)</li>
</ul>

<h2>Need Help?</h2>
<p>Email <a href="mailto:steven@rootz.global">steven@rootz.global</a></p>
</div>
</body></html>`;
}
