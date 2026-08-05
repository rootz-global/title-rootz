#!/usr/bin/env node
/**
 * One-shot harvest into the substrate store.
 *
 *   node datasource/run-harvest.mjs                 # full corpus
 *   node datasource/run-harvest.mjs --limit 5000    # cap parcels (a test load)
 *   node datasource/run-harvest.mjs --cities HOLLYWOOD,FORT_LAUDERDALE
 *
 * Reads title-rootz's existing FL DOR city JSONL + the Broward clerk sqlite.
 * Prints the run summary and exits non-zero on failure so a cron notices.
 */
import { harvestNow } from './mount.mjs';

const args = process.argv.slice(2);
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = {};
if (val('--limit')) config.limit = parseInt(val('--limit'), 10);
if (val('--cities')) config.cities = val('--cities').split(',').map((c) => c.trim()).filter(Boolean);

console.log('Harvesting realestate source', config.limit ? `(limit ${config.limit})` : '(full)');
const result = await harvestNow(config);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
