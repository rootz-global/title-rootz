/**
 * AI_CONTEXT: HTTP fetch helper with timeout, in-memory TTL cache, and graceful failure.
 *
 * Dependencies: none (uses global fetch)
 * Exports: fetchJSON, fetchCacheStats
 *
 * Used by all modules that call external APIs (FEMA, Census, MDC GIS, etc.).
 *
 * Why the cache (added Jun 20 2026 after two box-overload outages): the external
 * datasets these calls hit — FEMA flood zones, Census tracts, zoning layers — are
 * STABLE (don't change between requests), yet every property lookup re-fetched them
 * live, making each request ~5s and fragile. Worse, when an upstream API was slow or
 * down (the Census geocoder "fetch failed" that paged us), EVERY request waited the
 * full timeout. Now:
 *   - Successful responses are cached for hours → repeat/popular/health-probe queries
 *     are instant and don't depend on the upstream being up.
 *   - Failures are NEGATIVE-cached briefly → a down upstream fails fast instead of
 *     hanging every request behind a full timeout.
 *   - A shorter default timeout caps how long any single call can stall a request.
 * Contract is unchanged: returns parsed JSON, or null on error/timeout.
 */

const cache = new Map();                 // url -> { value, expires }
const MAX_ENTRIES = 5000;                // bound memory
const TTL_OK = 6 * 60 * 60 * 1000;       // 6h — these upstream datasets are stable
const TTL_FAIL = 60 * 1000;              // 60s negative cache — fail fast when an API is down

function store(url, value, ttl) {
  if (cache.size >= MAX_ENTRIES && !cache.has(url)) {
    // evict the oldest ~10% (Map preserves insertion order)
    const drop = Math.ceil(MAX_ENTRIES * 0.1);
    let i = 0;
    for (const k of cache.keys()) { cache.delete(k); if (++i >= drop) break; }
  }
  cache.set(url, { value, expires: Date.now() + ttl });
}

/**
 * Fetch JSON from URL with timeout, caching, and error handling.
 * @param {string} url - URL to fetch
 * @param {number} timeout - Timeout in ms (default 6000)
 * @returns {any|null} Parsed JSON or null on error/timeout
 */
export async function fetchJSON(url, timeout = 6000) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const data = await resp.json();
    // Negative-cache empty/failed payloads briefly; cache real data for hours.
    store(url, data, (data === null || data === undefined) ? TTL_FAIL : TTL_OK);
    return data;
  } catch (e) {
    console.error(`Fetch error for ${url.substring(0, 80)}: ${e.message}`);
    store(url, null, TTL_FAIL);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cache stats for diagnostics. */
export function fetchCacheStats() {
  const now = Date.now();
  let live = 0;
  for (const v of cache.values()) if (v.expires > now) live++;
  return { entries: cache.size, live, maxEntries: MAX_ENTRIES };
}
