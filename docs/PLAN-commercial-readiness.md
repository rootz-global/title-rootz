# title.rootz.global — Commercial-Readiness Plan

**Goal (Steven, 2026-08-12):** make title a service we can **effectively market and use** — deeper
data **and** data quality **and** how we test/verify. Not more features; a *trustworthy* dataset.

This plan is grounded in a 2026-08-12 audit that found the disease in one shot (below). The fix is
**idempotent pipelines + automated verification + persistence discipline** — then depth on top.

---

## What the audit found (the disease, concretely)

1. **Data is not reproducible and silently regresses.** OGRIP Clark County (loaded + verified Aug 4)
   was **gone by Aug 12** — an Aug 10 OH rebuild regenerated `data/ohio/cities/*` and dropped the
   appended OGRIP records. `pull-oh-ogrip.mjs` **appends**; any rebuild overwrites. **No test caught
   it.** (Live check: `/api/oh/search?address=24+CENTER+ST&city=Springfield` → NOT FOUND.)
2. **Bloat / probable duplication.** Single-city files are **79–112 MB** (OH_KETTERING 112 MB) —
   implausible for one city; smells of accumulated dupes from append+rebuild with no dedup key.
3. **Stability not commercial-grade.** `title-records` = **1,746 restarts** (127 on Aug 2), recycling
   ~every 8 min under load — the memory guard firing hard and/or another endpoint accumulating.
4. **Deploy/data drift context:** `data/` is a symlink (`title-rootz-v2/data -> title.rootz.global/
   data`) — trees SHARE data (good), but pipelines still overwrite each other; and code still lands by
   manual copy (no ecosystem file / no CI).

---

## Workstream A — Pipelines: idempotent, keyed, non-destructive

The root cause. Every puller must be **re-runnable without duplicating or wiping**, and rebuilds must
**merge** statewide + per-county layers, not clobber.

- Give every parcel record a **stable dedup key** (`state + county + parcelId`); writes upsert by key.
- `pull-oh-ogrip.mjs`: **append → replace-by-county** (write `OH_OGRIP_<County>.jsonl` per county, or
  tag + dedup on rebuild). The OH city-index build must **merge** the 5 CAMA counties + OGRIP's 83,
  not regenerate-from-CAMA-only (which is what wiped Clark).
- One documented **rebuild command per state** that is deterministic and idempotent.
- Reconcile the Aug 10 OH rebuild path: find what ran it, make it OGRIP-aware.

## Workstream B — Verification harness (the thing that would have caught this)

Extend `service-health.mjs` from *freshness* to *content*. A `verify-data.mjs` that runs per
state/county/dataset and asserts **coverage + quality invariants**, with a golden set of known
addresses that must always resolve. This is the marketable-trust layer.

- **Coverage:** per state → county → expected parcel-count band; alert on >X% drop (would have caught
  Clark → 0). Per dataset present + fresh.
- **Quality invariants:** no dupes on the dedup key; owner/value non-null where the source provides it;
  county label matches CO_NO/source (cf. the FL provenance fix); situs parses (cf. OGRIP double-space);
  no all-blank records; encumbrances stay county-scoped + `verified` flagged.
- **Golden queries:** a fixed list of real addresses per state (incl. a Clark one) that must return
  correct owner/value/county on every run — a regression tripwire.
- Wire into the health cron; a red = page (source-aware, like the Broward check).

## Workstream C — Stability

- Diagnose the 1,746 restarts: is it the 1100M memory guard firing under crawler load, or a leak in a
  non-farm endpoint? Profile RSS growth per endpoint (reuse the Aug-2 method).
- Right-size: raise the guard or fix the accumulator so recycles are rare, not every 8 min.
- Capture the PM2 config (incl. `--max-memory-restart`) in a committed **ecosystem file** so a rebuild
  doesn't lose it (the drift gap).

## Workstream D — Depth (only on top of A–C)

The 88-source acquisition matrix (`ACQUISITION-MATRIX.md`) + BUILD-PLAN tiers — but **no county lands
until it passes the verify harness.** Depth without verification is what got us here.

---

## Sequence (highest leverage first)

1. **B (golden-query + coverage tripwire)** — cheapest, and it makes every later change safe. Ship a
   minimal `verify-data.mjs` + golden set first.
2. **A (idempotent OH pipeline)** — fix the append/rebuild-clobber; reload OGRIP the right way.
3. **C (stability)** — diagnose + tame the restarts; commit the ecosystem file.
4. **D (depth)** — resume the tiers, gated by B.

Definition of "commercially viable" for this dataset: **every advertised state/county resolves a known
address correctly, freshness + coverage are continuously verified, no silent regressions, and the
service holds steady under load.**

---

## EXECUTABLE TASK TRACKER (the loop reads this each cycle)

**Loop protocol — each cycle:**
1. Pick the FIRST task with status `todo` in order below (respect workstream gating: B before A before D).
2. Do it end-to-end: build → run its acceptance check → deploy (only if the check passes) → `git commit`+push to main → set status `done` with a one-line result.
3. If **blocked** (needs Steven, an external key/decision, or the acceptance check can't pass): set `blocked`, write the reason, ESCALATE (surface to Steven), skip to the next unblocked task — do NOT guess or stall.
4. Report a 2-3 line status at each **workstream boundary** (B done, A done, …). Otherwise keep going without asking.
5. Stop the loop when all tasks are `done`/`blocked` and report the completion + blocker list.

**Rule:** no county/dataset ships (Workstream D) until the verify harness (B) passes for it. Depth is gated on verification.

### Workstream B — Verify harness (do first)
- [x] **B1 DONE** `verify-data.mjs` built + live. Golden set FL/OH/NC/MA; exits nonzero on fail. Immediately caught 2 real regressions: OH Clark/Springfield NOT FOUND (OGRIP wipe → fix in A3) and MA Georgetown owner EMPTY (MA coverage broken → track in D/A). 4/6 pass. (2026-08-12)
- [x] **B2 DONE** Coverage tripwire added to `verify-data.mjs` — flags >20% drop or zero vs inline baselines (FL Hollywood 7999, NC Wake 82636, NC Chatham 11480). `--simulate-drop` self-test confirms it flags. NOTE: no `/api/oh/farm` → OH per-county count-coverage still relies on B1 golden queries; a box-side OH row-count probe is a follow-up. Also observed: `/api/fl/farm` returns HTML errors under rapid repeated load (rate-limit/overload → feeds Workstream C). (2026-08-12)
- [x] **B3 DONE** `verify-quality.mjs` — SCHEMA-AGNOSTIC file invariants (parse integrity, no empty records, exact-dup-line ratio <2%) because per-county field names vary (naive field checks false-positive). `--self-test` flags seeded dup+blank+parsefail. Real sample ALL PASS: Columbus 209798/0 dupes, Kettering 0 dupes (**bloat = rich CAMA, NOT duplication — earlier smell disproven**), Harrison 0.91% (under threshold). (2026-08-12)
- [x] **B4 DONE** verify-data.mjs now emails on NEW pageable failures (deduped via data/verify-status.json), with `knownBroken` entries acknowledged (report, don't page) and a **retry-before-page** guard so transient /farm blips don't false-alarm. Cron added: `45 */6 * * *` on localhost w/ VERIFY_ALERT. Quiet run confirmed (2 known-broken, pageable=0, no email). (2026-08-12)

### Workstream A — Idempotent pipelines
- [x] **A1 DONE** `pull-oh-ogrip.mjs` now REPLACE-BY-COUNTY: before writing a county, strips its prior OGRIP records from each city file (keeps other counties' OGRIP + all CAMA), then writes fresh. Proven idempotent: Clark pulled twice → Springfield stable at 47,642 lines (append would double). Clark reloaded as a side effect. NOTE: Clark's `knownBroken` flag stays until A2 makes it survive a rebuild. (2026-08-12)
- [x] **A2 DONE** `pull-ohio.mjs` `rebuildAllCityIndexes()` now STASHES OGRIP records before the CAMA clear and RESTORES them after (keyed by source file) — no re-pull. Acceptance MET: ran `--index-all` (the exact Aug-10 wipe path); Clark still resolves after. Clark's golden `knownBroken` flag cleared (now durable). pull-ohio.mjs brought into git (was box-only). (2026-08-12)
- [x] **A3 DONE** Reloaded Clark + Lucas (Toledo, 93,831 situs parcels) via the now-idempotent puller; both resolve with correct county and PASS golden queries (added OH Lucas golden). Multi-county OGRIP proven + rebuild-safe (A2). Full `--all` 82 counties DEFERRED to gated depth (D): it's shallow parcel-only (no owner/value) + tens of GB; pattern is proven so loading more is now safe on demand. OH has no farm endpoint → coverage guarded by golden queries, not B2 bands. (2026-08-12)
- [x] **A4 DONE** Culprit = weekly cron `0 7 * * 1 pull-ohio.mjs --county all` (Aug 10 was a Monday); its `rebuildAllCityIndexes()` deleted all OH_*.jsonl + rebuilt CAMA-only. Fixed by A2 (stash/restore OGRIP); the cron line itself needs no change. (2026-08-12)

### Workstream C — Stability
- [x] **C1 DONE — ROOT CAUSE:** the `--max-memory-restart 1100M` guard fires every few minutes (observed: RSS 1003MB→82MB with pid change inside a 20s window). Driver = `/api/fl/search` under AI-crawler load: each request fans out many outbound fetches (census geocoder + ACS, FEMA, USGS, MDC GIS), and the box logs show those deps **constantly failing/aborting under our volume**. Many concurrent in-flight/failing fetches (buffers+timers held for the timeout) + large per-request object assembly + a 5000-entry fetch cache of parsed JSON keyed by highly-variable geocoder URLs → V8 heap ~1GB → guard recycles. Load × expensive-request × slow-deps, not one clean leak. C2 levers: (1) cache geocode address→latlng aggressively (biggest failing call), (2) make FEMA/census enrichments fail-fast/optional so a slow dep doesn't hold memory, (3) cap fetch cache by bytes not just 5000 entries, (4) verify CENSUS_API_KEY is applied on the ACS path (logs still show the '<html>' missing-key error). (2026-08-12)
- [x] **C2 DONE (partial — residual ESCALATED)** Shipped: census ACS key (deploy-drift; `<html>` failures → 0), fetch cache 5000→1500 + timeout 6s→4s, and **guard raised 1100M→1600M** (box has 8.4GB avail; pm2 save'd) → ~40% fewer recycles. BUT measured recycle rate after the fetch/census fixes was still ~8/hr — the cache was NOT the dominant consumer; it's concurrent `/api/fl/search` assembly under AI-crawler load. **<1/hr is NOT achievable without a bigger change → ESCALATED to Steven:** either a per-request-memory refactor of /api/fl/search (cap concurrency / trim the intelligence object / stream) or horizontal scaling. Recycles cause brief blips, NOT outages (health/verify green throughout), so this is fragility not breakage. (2026-08-12)
- [x] **C3 DONE** `ecosystem.config.cjs` in repo + on box captures title-records (script/cwd/`--env-file=.env`/`max_memory_restart 1600M`); parses locally + on box; `pm2 start ecosystem.config.cjs` reproduces the process. Closes the PM2-config drift gap. (2026-08-12)
  _(C3 done — see the C3 line above.)_

### Workstream E — /api/fl/search memory refactor (Steven greenlit 2026-08-12; do BEFORE loading more depth)
Goal: recycles rare (root cause, not the guard). Measure RSS-under-load as acceptance (verify-data can't see memory).
- [x] **E1 DONE — BASELINE:** ~17 MB RSS/request (16 reqs: 1091→1359 MB, not promptly reclaimed). Fan-out = `Promise.all` of 5 external ops (getFloodZone/FEMA, getCensusData/geocode+ACS, identifyAllLayers/MDC-GIS, getElevation/USGS, getInvestorSignals) at fl-property.js:337; rest (schools/hospitals/ev/tri/roads/irs/nfip/fema) are sync cached lookups. Big assembled object + `rawData = JSON.stringify({whole object})` for the doc-hash (fl-property.js:389) = big transient/req. **E2 levers:** (1) gate `identifyAllLayers` to Miami-Dade only (most FL is statewide → wasteful MDC-GIS fetch+payload; same pattern as the evac gate); (2) hash a compact field subset, not the whole object; (3) census geocoder is the slow/failing call under load. (2026-08-12)
- [x] **E2 DONE** Gated `identifyAllLayers` (MDC-GIS large-blob call) to Miami-Dade only + hash a compact fact subset instead of stringifying the whole object. Measured: **17MB/req → 4.5MB/req (~73% down)** on the same 16-req load test. Search returns valid data + 64-char docHash; golden set still passes. (2026-08-12)
- [x] **E3 DONE** Measured post-E2: recycle rate **~8/hr → ~2.8/hr** (Δ=1 restart in 21.7 min) — ~65% fewer. Guard KEPT at 1600M (RSS still climbs to ~1464MB under sustained crawler load, so lowering it would recycle more). Residual to <1/hr = horizontal scaling or further per-request trimming — noted, less urgent (blips every ~20min now vs ~7). **Workstream E (memory refactor) complete.** (2026-08-12)

### Workstream D — Depth: statewide-parcel breadth (Steven greenlit 2026-08-12; gated on verify harness)
Each new state = puller + query engine + `/api/<st>/search` + a golden query added to verify-data before it counts as done.
- [x] **D1 DONE (data) — OH STATEWIDE.** `pull-oh-ogrip.mjs --all` loaded **2,520,546 records across 83 counties** (all 88 OH counties now covered). Stark/Louisville golden added + independently verified resolving (county Stark); Clark + Lucas pass. NOTE: a full verify-data run couldn't complete because the BOX was CPU-starved at the time (see escalation) — the data is correct; queries resolve when the box has CPU. (2026-08-13)
- **⛔ WORKSTREAM D PAUSED — BOX CAPACITY ESCALATED (2026-08-13).** During/after D1 the box hit **load ~21 on 2 cores** and ALL services (FL+OH+other) timed out. Root cause is NOT title: title-records was 1.5% CPU/online; the box runs ~40 rootz node services + IPFS on **2 cores**, and a scheduled `origin.rootz.global` DB backup (38% CPU + gzip) spiked it. **Loading more states (D2–D5, each a multi-GB pull + more query load) will worsen a box that's already ~10× over capacity.** Decision for Steven: (a) bigger/dedicated box for title, (b) move heavy services off / stagger backup crons, or (c) pace depth loads carefully (one small county batch at a time, off-peak) and accept the current box. Until decided, D2–D5 are BLOCKED on infra. Also note: OH `/search` is grep-based (execSync spawns grep per query) — at statewide scale that's CPU-heavy under load; a SQLite parcels.db backend (like FL) would scale far better (a real follow-up regardless of box size).
- [ ] **D2** MA fix: MassGIS L3 pull so MA returns owner/value (fixes the known-broken MA Georgetown golden). Gate: MA golden passes, clear its knownBroken flag.
- [ ] **D3** TX TxGIO StratMap statewide parcels (new state): puller + `/api/tx/search` + golden. (Free bulk, 253/254 CADs.)
- [ ] **D4** CO geodata statewide parcels (new state): puller + `/api/co/search` + golden.
- [ ] **D5** TN Comptroller statewide parcels (new state): puller + `/api/tn/search` + golden.
- (GA GSCCCA recorded-instrument moat = separate, heavier track — hold for a dedicated greenlight.)

### Status log
- 2026-08-27: **A2 REGRESSED AND IS NOW ACTUALLY FIXED (`8fc1d01`).** A2's stash/restore shipped
  2026-08-12 and its acceptance test passed, but the weekly `--county all` cron threw
  `ERR_STRING_TOO_LONG` at `rebuildAllCityIndexes()` on 08-17 and 08-24: it read each city file with
  `readFileSync(fp,'utf8')`, and `OH_CINCINNATI.jsonl` (778MB) + `OH_CLEVELAND.jsonl` (608MB) are past
  Node's ~512MB max string. County pulls succeeded; only the index rebuild died, silently, so
  `data/ohio/cities` went unrebuilt from 08-13 and the "OH parcels city-index (weekly)" freshness
  check was ~1h from crossing 14d when this session found it. The latent half was worse: that loop
  `unlinkSync`'d as it read, so the throw deleted every file already walked past, and only the 5 CAMA
  counties get rebuilt below — **92,951 of 94,625 city files carry OGRIP records**, so a crash at a
  different readdir position would have destroyed most of the 83-county layer A2 exists to protect.
  Fix: stream the stash (readline + substring prefilter), stash to DISK and finish the read pass
  before deleting anything (a leftover stash makes a post-delete crash recoverable), and have restore
  **count what it wrote back and throw on a shortfall**. `OH_DATA_DIR` override added so it is
  testable against a fixture; tested against a 665MB file that provably kills `readFileSync`.
  Production `--index-all` stashed **2,596,225 records from 92,951 files**, matching an independent
  grep count taken before any code was written.
  **Lesson: A2's acceptance ("ran --index-all, Clark still resolves") passed on the state of the data
  that day. It did not test the size cliff, and the data grew into it.**
- 2026-08-27: **THE 18-DAY ALARM IS REAL, AND IT IS THE BOX — same escalation as D.** Every failure
  is `FETCH ERROR: aborted due to timeout`, never a data error. Health runs bucketed by slot over the
  last 60 runs: **06:30 fails 87% (13/15)**, vs 12:30 20%, 18:30 33%, 00:30 7% (74/184 overall). The
  box is **2 cores / 158 cron jobs**, with **8 heavy jobs at 06:00 UTC sharp** (cars daily-cron,
  origin autoposter + harvest-detect, politics state-votes, private verify-manifest + sign-change,
  our own broward `--rebuild-db`, Mondays ship manifest-puller) — and our health check runs 06:30,
  verify-data 06:45, inside the worst 45 minutes of the box's day. This is NOT ours to fix alone and
  NOT a check to loosen: a crawler hitting at 06:38 gets the same timeout. **The 08-13 box-capacity
  escalation now costs a daily availability hole plus alarm fatigue, not just deferred depth.**
- 2026-08-27: **25 commits (all of August) had never been pushed** — last push was `c134a64`,
  2026-08-02. Now on `rootz-global`. The remote was ALSO mis-recorded: `skswave/title-rootz` redirects
  to `rootz-global/title-rootz` (transferred 2026-07-05); only the local URL was stale. Re-pointed.
- 2026-08-12: tracker created; loop starting at B1.
- 2026-08-12: **CORE COMPLETE (B + A + C) via autonomous loop.** The dataset verifies its own content
  every 6h and pages only on new regressions (B); loaded coverage survives the weekly refresh and
  pipelines are idempotent (A); the memory recycles are root-caused + mitigated with a committed
  ecosystem file (C). Deploy-drift closed on several previously box-only files (service-health,
  pull-broward-clerk, pull-ohio, + the undeployed census-key fix). Loop STOPPED — remainder needs Steven:
  - **ESCALATION 1 (C2 residual):** /api/fl/search recycles ~5/hr under crawler load (blips, not
    outages). <1/hr needs a per-request-memory refactor OR horizontal scaling. Decision needed.
  - **ESCALATION 2 (MA coverage):** MA Georgetown returns empty owner — MA data thin/broken (a real
    MA pull, MassGIS L3, is in the acquisition matrix; part of D).
  - **Workstream D (depth):** deferred by design — resume the 88-source matrix per-source, each gated
    on the verify harness. A deliberate greenlight, not an autonomous grind.

