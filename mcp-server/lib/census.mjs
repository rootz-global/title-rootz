// Census ACS API key handling.
//
// The ACS API now REJECTS keyless requests: it responds 302 to
// /data/missing_key.html, an HTML page that parses as neither JSON nor a
// recognisable error. Callers therefore saw an opaque "no data" failure
// instead of "you need a key", and the source-health monitor has been
// reporting Census as ERROR for that reason.
//
// Get a key (free, instant): https://api.census.gov/data/key_signup.html
// Then set CENSUS_API_KEY in /var/www/title.rootz.global/.env AND make sure
// the cron entry invokes node with --env-file=.env, or the variable will not
// reach the script.

export const CENSUS_API_KEY = process.env.CENSUS_API_KEY || '';

export const CENSUS_KEY_HINT =
  'Census ACS requires an API key; set CENSUS_API_KEY in .env ' +
  '(free: https://api.census.gov/data/key_signup.html) and run node with --env-file=.env';

/** Append the API key to a Census URL when one is configured. */
export function withCensusKey(url) {
  if (!CENSUS_API_KEY) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(CENSUS_API_KEY);
}

/** Log the missing-key hint once per process, so cron logs say WHY it failed. */
let warned = false;
export function warnIfNoCensusKey() {
  if (CENSUS_API_KEY || warned) return;
  warned = true;
  console.warn(`  WARNING: ${CENSUS_KEY_HINT}`);
}
