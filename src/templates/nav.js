/**
 * Nav Template — Persistent header for all Rootz Property Intelligence pages.
 * Matches the existing teal/dark-blue gradient (#1e3a5f → #0f766e).
 */

export function renderNav(account) {
  const tierBadge = account ? `<span class="rn-badge rn-tier-${account.tier}">${account.tier}</span>` : '';
  const authLink = account
    ? `<a href="/auth/account" class="rn-link">${account.email.split('@')[0]} ${tierBadge}</a>`
    : '<a href="/auth/login" class="rn-link rn-signin">Sign In</a>';

  return `
<style>
.rootz-nav{background:linear-gradient(135deg,#1e3a5f 0%,#0f766e 100%);padding:0 20px;display:flex;align-items:center;height:48px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;flex-shrink:0}
.rootz-nav a.rn-logo{color:#fff;font-weight:700;font-size:16px;text-decoration:none;margin-right:24px}
.rootz-nav .rn-links{display:flex;gap:4px;flex:1}
.rootz-nav a.rn-link{color:rgba(255,255,255,.8);text-decoration:none;font-size:13px;padding:6px 12px;border-radius:6px;transition:all .15s}
.rootz-nav a.rn-link:hover{color:#fff;background:rgba(255,255,255,.12)}
.rootz-nav a.rn-link.active{color:#fff;background:rgba(255,255,255,.15)}
.rootz-nav .rn-right{margin-left:auto}
.rootz-nav a.rn-signin{border:1px solid rgba(255,255,255,.3);border-radius:6px}
.rn-badge{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600;text-transform:uppercase;margin-left:6px;vertical-align:middle}
.rn-tier-free{background:rgba(255,255,255,.15);color:rgba(255,255,255,.7)}
.rn-tier-starter{background:#3b82f6;color:#fff}
.rn-tier-pro{background:#f59e0b;color:#fff}
.rn-tier-unlimited{background:#10b981;color:#fff}
.rn-tier-training{background:#8b5cf6;color:#fff}
@media(max-width:600px){.rootz-nav{padding:0 12px}.rootz-nav a.rn-link{font-size:12px;padding:4px 8px}.rootz-nav a.rn-logo{font-size:14px;margin-right:12px}}
</style>
<nav class="rootz-nav">
  <a href="/farm" class="rn-logo">Rootz Property Intelligence</a>
  <div class="rn-links">
    <a href="/farm" class="rn-link">Farm</a>
    <a href="/saved" class="rn-link">Saved</a>
    <a href="/pricing" class="rn-link">Pricing</a>
    <a href="/help" class="rn-link">Help</a>
  </div>
  <div class="rn-right">
    ${authLink}
  </div>
</nav>`;
}
