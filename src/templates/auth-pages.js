/**
 * AI_CONTEXT: Authentication page templates — login form, check email confirmation
 *
 * Dependencies: src/templates/nav.js (renderNav)
 * Exports: renderLoginPage(error, account), renderCheckEmailPage(email)
 */

import { renderNav } from './nav.js';

const AUTH_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;max-width:420px;width:100%}
.card h1{font-size:24px;color:#1e3a5f;margin-bottom:6px}
.card .sub{color:#64748b;font-size:14px;margin-bottom:24px}
.card label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px}
.card input[type=email]{width:100%;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}
.card input:focus{border-color:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.1)}
.card button{width:100%;padding:12px;background:linear-gradient(135deg,#1e3a5f 0%,#0f766e 100%);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px}
.card button:hover{opacity:.9}
.error{background:#fef2f2;color:#dc2626;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid #fecaca}
.success{background:#f0fdf4;color:#166534;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid #bbf7d0}
.info{background:#eff6ff;color:#1e40af;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid #bfdbfe}
.ft{text-align:center;margin-top:20px;font-size:12px;color:#94a3b8}
.ft a{color:#0f766e;text-decoration:none}
`;

export { AUTH_STYLES };

export function renderLoginPage(error = null, account = null) {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign In — Rootz Property Intelligence</title>
<style>${AUTH_STYLES}body{display:block}</style>
</head><body>
${renderNav(account)}
<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 48px)">
<div class="card">
  <h1>Rootz Property Intelligence</h1>
  <div class="sub">AI-powered real estate farming</div>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/auth/login">
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" placeholder="agent@example.com" required autofocus>
    <button type="submit">Send Magic Link</button>
  </form>
  <div class="ft">No password needed — we'll email you a sign-in link<br><a href="/">Back to home</a></div>
</div>
</div>
</body></html>`;
}

export function renderCheckEmailPage(email) {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Check Your Email — Rootz Property Intelligence</title>
<style>${AUTH_STYLES}body{display:block}</style>
</head><body>
${renderNav(null)}
<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 48px)">
<div class="card">
  <h1>Check your email</h1>
  <div class="sub">We sent a sign-in link to:</div>
  <div class="info"><strong>${email}</strong></div>
  <p style="color:#64748b;font-size:14px;line-height:1.6">Click the link in the email to sign in. The link expires in 15 minutes.</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:16px">Didn't get it? Check your spam folder or <a href="/auth/login" style="color:#0f766e">try again</a>.</p>
  <div class="ft"><a href="/">Back to home</a></div>
</div>
</div>
</body></html>`;
}
