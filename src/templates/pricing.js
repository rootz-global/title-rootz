/**
 * AI_CONTEXT: Pricing page template — subscription tier comparison cards
 *
 * Dependencies: src/templates/nav.js (renderNav)
 * Exports: renderPricingPage(account)
 *
 * Tiers: Free ($0), Starter ($29/mo), Pro ($49/mo), Unlimited ($99/mo)
 */

import { renderNav } from './nav.js';

export function renderPricingPage(account) {
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
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b}</style>
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
  const resp = await fetch('/api/stripe/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }) });
  const data = await resp.json();
  if (data.url) window.location = data.url;
  else if (data.error) alert(data.error);
}
</script>
</body></html>`;
}
