/**
 * AI_CONTEXT: Saved properties page — CRM-style list with notes, status, export
 *
 * Dependencies: src/templates/nav.js (renderNav)
 * Exports: renderSavedPage(account, saved, farmAreas)
 */

import { renderNav } from './nav.js';

export function renderSavedPage(account, saved, farmAreas) {
  const statusColors = { active: '#0f766e', contacted: '#2563eb', listed: '#7c3aed', closed: '#16a34a', archived: '#94a3b8' };
  const statusOpts = ['active', 'contacted', 'listed', 'closed', 'archived'];

  const propertyRows = saved.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No saved properties yet. <a href="/farm" style="color:#0f766e">Search for properties</a> and save the ones you like.</div>'
    : saved.map(p => {
      const sc = statusColors[p.status] || '#94a3b8';
      const statusSelect = statusOpts.map(s => `<option value="${s}"${s === (p.status || 'active') ? ' selected' : ''}>${s}</option>`).join('');
      const escapedNotes = (p.notes || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      return `
      <div class="prop-card" style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px;background:#fff;border-left:4px solid ${sc}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1">
            <div style="font-weight:600;font-size:15px">${p.address}</div>
            <div style="color:#64748b;font-size:13px">${p.city || ''}${p.state ? ', ' + p.state : ''}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
            ${p.farming_score ? `<span style="background:#f0fdf4;color:#166534;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600">Score: ${p.farming_score}</span>` : ''}
            <select onchange="updateStatus(${p.id},this.value)" style="font-size:11px;padding:2px 4px;border:1px solid #e2e8f0;border-radius:4px;color:${sc}">${statusSelect}</select>
            <button onclick="deleteSaved(${p.id})" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:18px" title="Remove">&times;</button>
          </div>
        </div>
        <div style="margin-top:8px">
          <div style="display:flex;gap:6px;align-items:flex-start">
            <textarea id="notes-${p.id}" rows="2" placeholder="Add notes..." style="flex:1;font-size:13px;padding:8px;border:1px solid #e2e8f0;border-radius:6px;resize:vertical;font-family:inherit;color:#475569">${escapedNotes}</textarea>
            <button onclick="saveNotes(${p.id})" style="padding:6px 12px;background:#0f766e;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">Save</button>
          </div>
        </div>
        <div style="margin-top:8px;display:flex;gap:12px;align-items:center">
          ${p.bridge_url ? `<a href="${p.bridge_url}" style="color:#0f766e;font-size:12px">View details</a>` : ''}
          <a href="/farm?property=${encodeURIComponent(p.address + ', ' + (p.city || ''))}" style="color:#0f766e;font-size:12px">Ask about this property</a>
          <span style="font-size:11px;color:#cbd5e1;margin-left:auto">Saved ${p.created_at?.slice(0, 10) || ''}</span>
        </div>
      </div>`;
    }).join('');

  const areaRows = farmAreas.length === 0 ? '' :
    `<h2 style="font-size:16px;color:#1e3a5f;margin:24px 0 12px">Farm Areas</h2>` +
    farmAreas.map(a => `
      <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:8px;background:#fff;display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-weight:600">${a.city}</span>
          ${a.zip ? `<span style="color:#64748b;font-size:13px;margin-left:8px">${a.zip}</span>` : ''}
          ${a.signals ? `<span style="color:#94a3b8;font-size:12px;margin-left:8px">${JSON.parse(a.signals).join(', ')}</span>` : ''}
        </div>
        <button onclick="deleteArea(${a.id})" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:18px" title="Remove">&times;</button>
      </div>
    `).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saved Properties — Rootz Property Intelligence</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b}</style>
</head><body>
${renderNav(account)}
<div style="max-width:700px;margin:0 auto;padding:24px 20px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <h1 style="font-size:22px;color:#1e3a5f">Saved Properties <span style="font-size:14px;color:#94a3b8;font-weight:400">(${saved.length})</span></h1>
    ${saved.length ? '<a href="/api/saved/export.csv" style="font-size:13px;padding:6px 14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;color:#475569;text-decoration:none">Export CSV</a>' : ''}
  </div>
  ${propertyRows}
  ${areaRows}
</div>
<script>
async function saveNotes(id) {
  const el = document.getElementById('notes-' + id);
  const resp = await fetch('/api/saved/' + id + '/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: el.value }) });
  if (resp.ok) { el.style.borderColor = '#0f766e'; setTimeout(() => el.style.borderColor = '#e2e8f0', 1500); }
}
async function updateStatus(id, status) { await fetch('/api/saved/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); location.reload(); }
async function deleteSaved(id) { if (!confirm('Remove this property?')) return; await fetch('/api/saved/' + id, { method: 'DELETE' }); location.reload(); }
async function deleteArea(id) { if (!confirm('Remove this farm area?')) return; await fetch('/api/farm-areas/' + id, { method: 'DELETE' }); location.reload(); }
</script>
</body></html>`;
}
