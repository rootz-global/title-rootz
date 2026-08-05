/**
 * Mount the @epistery/datasource catalog inside title-rootz's existing server.
 *
 * title-rootz serves on raw Node http (no Express) and reads request bodies
 * itself — including the Stripe webhook's raw body. The substrate's standalone
 * mount is an Express app that runs express.json() ahead of everything, which
 * would consume those bodies and silently break every POST. So rather than wrap
 * the existing server in Express, we use the substrate's DATA layer directly
 * (defineSource + openStore + createCatalog + signed skill.json) and expose it
 * as a few GET routes. The existing routes are untouched.
 *
 * Routes added (all GET, none collide with an existing path):
 *   /api/catalog?limit&offset          paged JSON-LD — what epistery-scan walks
 *   /api/record/:collection/:id        one object by id
 *   /api/catalog/search?collection&... exact/prefix search on indexed fields
 *   /api/datasource/status             what is held + last harvest, counted live
 *   /.well-known/ai/skill.json         signed manifest declaring the catalog
 *
 * Signing: until title.rootz.global has an epistery domain wallet (a deploy
 * step), the manifest is served UNSIGNED — honest bottom-rung provenance, per
 * the substrate's "no signer -> unsigned" rule. The catalog is fully usable
 * meanwhile; scan records the author once the wallet lands.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  openStore, createCatalog, buildManifests, buildTools, buildHandlers, runHarvest
} from '@epistery/datasource';
import source from './source.mjs';
import { valueAddTools, valueAddHandlers } from './mcp.mjs';
import { DATA_DIR } from '../src/lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// The substrate store lives beside the other title data, outside any package
// checkout. Opened once, lazily, so importing this module is cheap.
const STORE_DIR = process.env.DATASOURCE_DIR || path.join(DATA_DIR, 'datasource');

let _ctx = null;
function ctx() {
  if (_ctx) return _ctx;
  const store = openStore(source, { dataDir: STORE_DIR });
  const catalog = createCatalog(source, store);
  _ctx = { store, catalog };
  return _ctx;
}

const manifestCache = new Map();
async function skillManifest(domain) {
  if (manifestCache.has(domain)) return manifestCache.get(domain);
  const { skill } = await buildManifests({
    source,
    domain,
    version: VERSION,
    tools: buildTools(source),
    signer: null,          // unsigned until the domain wallet exists (deploy)
    catalogPath: '/api/catalog'
  });
  manifestCache.set(domain, skill);
  return skill;
}

function send(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Link': '</.well-known/ai/skill.json>; rel="ai-catalog"'
  });
  res.end(JSON.stringify(data));
}

function statusReport() {
  const { store } = ctx();
  return {
    source: source.id,
    title: source.title,
    upstream: source.upstream,
    role: source.role,
    records: store.count(),
    collections: store.counts(),
    harvests: store.harvests(5)
  };
}

/**
 * Handle a datasource route. Returns true if it owned the request, false if the
 * caller should keep matching its own routes.
 */
export async function handleDatasource(req, res, urlParsed) {
  if (req.method !== 'GET') return false;
  const p = urlParsed.pathname;
  const q = urlParsed.searchParams;

  if (p === '/api/catalog') {
    const limit = Math.min(parseInt(q.get('limit'), 10) || 500, 1000);
    const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
    send(res, ctx().catalog.page(offset, limit));
    return true;
  }

  const rec = p.match(/^\/api\/record\/([^/]+)\/(.+)$/);
  if (rec) {
    const item = ctx().catalog.get(decodeURIComponent(rec[1]), decodeURIComponent(rec[2]));
    if (!item) return send(res, { found: false }, 404), true;
    send(res, item);
    return true;
  }

  if (p === '/api/catalog/search') {
    const collection = q.get('collection');
    if (!collection) return send(res, { error: 'collection is required' }, 400), true;
    const filters = {};
    for (const [k, v] of q) {
      if (k === 'collection' || k === 'limit') continue;
      filters[k] = v;
    }
    try {
      const items = ctx().catalog.search({
        collection, filters, limit: Math.min(parseInt(q.get('limit'), 10) || 25, 100)
      });
      send(res, { count: items.length, items });
    } catch (err) {
      send(res, { error: err.message }, 400);
    }
    return true;
  }

  if (p === '/api/datasource/status') {
    send(res, statusReport());
    return true;
  }

  if (p === '/.well-known/ai/skill.json') {
    const domain = (req.headers.host || 'title.rootz.global').split(':')[0];
    send(res, await skillManifest(domain));
    return true;
  }

  return false;
}

// ── MCP over the epistery facility ──────────────────────────────────────────
// Generic catalog tools (search/get/status) come from the substrate's own
// generators; the value-add tools are declared alongside and wired to the LIVE
// query modules. One /mcp for title-rootz, built from the facility — not a
// second hand-rolled transport.

function mcpTools() {
  return [...buildTools(source), ...valueAddTools];
}
function mcpHandlers() {
  const { catalog } = ctx();
  return { ...buildHandlers(source, { catalog, status: statusReport }), ...valueAddHandlers };
}

function rpc(res, id, result) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }));
}
function rpcError(res, id, code, message) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }));
}

/** Serve one MCP JSON-RPC request. `body` is the already-parsed request. */
export async function handleMcp(req, res, body = {}) {
  const { method, params, id } = body;
  if (method === 'initialize') {
    return rpc(res, id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'title-rootz', version: VERSION },
      capabilities: { tools: {} }
    });
  }
  if (method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
  if (method === 'tools/list') return rpc(res, id, { tools: mcpTools() });
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    const handler = mcpHandlers()[name];
    if (!handler) return rpcError(res, id, -32601, `Unknown tool: ${name}`);
    try {
      const result = await handler(args || {});
      return rpc(res, id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return rpcError(res, id, -32603, err.message);
    }
  }
  return rpcError(res, id, -32601, `Unknown method: ${method}`);
}

/** CLI/one-shot harvest — reads the government inputs into the substrate store. */
export async function harvestNow(config = {}) {
  return runHarvest(source, ctx().store, { trigger: 'manual', config });
}

export { source, statusReport };
