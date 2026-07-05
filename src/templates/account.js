/**
 * AI_CONTEXT: Account page template — shows user tier, usage stats, subscription management
 *
 * Dependencies: src/templates/nav.js (renderNav), AUTH_STYLES from auth-pages.js
 * Exports: renderAccountPage(account, stats, config)
 */

import { renderNav } from './nav.js';
import { AUTH_STYLES } from './auth-pages.js';

export function renderAccountPage(account, stats, config) {
  const tierClass = `tier-${account.tier}`;
  const limitDisplay = config.daily === -1 ? 'Unlimited' : `${stats.today} / ${config.daily}`;
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Account — Rootz Property Intelligence</title>
<style>${AUTH_STYLES}
body{display:block}
.card{max-width:520px;margin:40px auto}
.tier-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase}
.tier-free{background:#f1f5f9;color:#64748b}
.tier-starter{background:#dbeafe;color:#1d4ed8}
.tier-pro{background:#fef3c7;color:#92400e}
.tier-unlimited{background:#d1fae5;color:#065f46}
.stat{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f1f5f9}
.stat:last-child{border-bottom:none}
.stat .label{color:#64748b;font-size:13px}
.stat .value{font-weight:600;font-size:14px}
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
