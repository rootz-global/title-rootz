// Shared box evidence for title's two alerting paths (service-health.mjs in the v1
// tree, verify-data.mjs in v2 — which reaches this file through its `lib` symlink).
//
// An endpoint timeout has two very different causes: title is broken, or the BOX is
// starved and everything on it is timing out. Those need opposite responses — one is
// ours to fix, the other is an infra decision — so MEASURE the difference instead of
// inferring it from a failure count. Same discipline as the Broward source-lagging
// WARN: separate "not our fault" from "we are broken", and say which in the alert.
//
// ONE implementation on purpose. This rule is subtle enough that two copies would
// drift, and drift between the two alerting paths is what let verify-data keep paging
// every morning for three days after service-health had been fixed.
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

// Env-tunable because the right threshold is a property of the box, not the code
// (and because a rule you cannot exercise in a test is a rule you cannot trust).
export const SAT_LOAD_PER_CORE = +(process.env.HEALTH_SAT_LOAD_PER_CORE || 2.5);  // 2-core box => load >= 5
export const SAT_OUR_CPU_MAX = +(process.env.HEALTH_SAT_OUR_CPU_MAX || 40);
export const SAT_CHRONIC_DAYS = +(process.env.HEALTH_SAT_CHRONIC_DAYS || 3);
export const REPEAT_BACKOFF_H = [12, 24, 72, 168];

export async function boxEvidence(procName = 'title-records') {
  const ev = { load1: null, cores: null, loadPerCore: null, proc: null };
  try {
    ev.load1 = parseFloat(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
    ev.cores = os.cpus().length;
    if (ev.load1 >= 0 && ev.cores > 0) ev.loadPerCore = +(ev.load1 / ev.cores).toFixed(2);
  } catch {}
  // Sample CPU several times and take the MEDIAN. A single pm2 reading is far too
  // noisy to decide anything: consecutive samples of this process measured
  // 14.9, 0, 0, 0.4, 0 within ten seconds. Worse, one taken right after the endpoint
  // checks partly measures those checks' OWN load — the first version of this read
  // 56.5%, concluded "that's us", and paged.
  const cpus = [];
  for (let i = 0; i < 5; i++) {
    try {
      const j = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const p = j.find(x => x.name === procName);
      if (!p) break;
      if (typeof p.monit?.cpu === 'number') cpus.push(p.monit.cpu);
      ev.proc = {
        status: p.pm2_env?.status,
        memMB: Math.round((p.monit?.memory || 0) / 1048576),
        restarts: p.pm2_env?.restart_time ?? null,
        cpu: null,
      };
    } catch { break }
    if (i < 4) await new Promise(r => setTimeout(r, 1000));   // sleep, never spin — a busy-wait would add the load it is trying to measure
  }
  if (ev.proc && cpus.length) {
    cpus.sort((a, b) => a - b);
    ev.proc.cpu = cpus[Math.floor(cpus.length / 2)];
    ev.proc.cpuSamples = cpus;
  }
  return ev;
}

// The box is saturated AND we are its victim (not its cause) when the box is heavily
// loaded while OUR process is online and not itself burning CPU. If we ARE the one
// burning CPU, that is a title bug and it pages — hence the ceiling.
export function isBoxSaturated(ev) {
  return ev.loadPerCore !== null && ev.loadPerCore >= SAT_LOAD_PER_CORE
    && !!ev.proc && ev.proc.status === 'online'
    && ev.proc.cpu !== null && ev.proc.cpu < SAT_OUR_CPU_MAX;
}

export const evDesc = (ev) => ev.loadPerCore === null
  ? 'box evidence unavailable'
  : `load ${ev.load1} on ${ev.cores} cores = ${ev.loadPerCore}/core; title-records `
    + (ev.proc ? `${ev.proc.status} at ${ev.proc.cpu}% CPU / ${ev.proc.memMB}MB` : 'unknown');

// Carry the saturation clock across RECOVERY, not just persistence. The real pattern
// is a brownout that recurs each morning and is gone by midday, so a naive
// "continuously true for N days" clock resets at the first clean run and therefore
// never escalates — the condition stays invisible precisely because it keeps
// recovering. Starts at first sighting, counts recurrences, clears only after a full
// quiet period. Returns the fields to merge into the status file.
export function saturationClock(prev, satOnly, now = Date.now()) {
  const prevLastAt = prev.saturatedLastAt ? Date.parse(prev.saturatedLastAt) : 0;
  const goneFor = prevLastAt ? (now - prevLastAt) / 86400000 : Infinity;
  if (satOnly) return {
    saturatedSince: prev.saturatedSince || new Date(now).toISOString(),
    saturatedLastAt: new Date(now).toISOString(),
    saturatedRuns: (prev.saturatedRuns || 0) + 1,
  };
  if (goneFor <= SAT_CHRONIC_DAYS) return {   // a clean run does NOT mean it is over
    saturatedSince: prev.saturatedSince || null,
    saturatedLastAt: prev.saturatedLastAt || null,
    saturatedRuns: prev.saturatedRuns || 0,
  };
  return { saturatedSince: null, saturatedLastAt: null, saturatedRuns: 0 };
}
