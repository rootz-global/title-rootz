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
- [ ] **B4** Wire `verify-data.mjs` into the health cron, source-aware paging (like the Broward check). Acceptance: a failing golden query pages; a passing run is quiet.

### Workstream A — Idempotent pipelines
- [ ] **A1** Stable dedup key (`state+county+parcelId`) on OH records; `pull-oh-ogrip.mjs` append→replace-by-county. Acceptance: re-running a county does NOT duplicate (line count stable).
- [ ] **A2** OH city-index build MERGES the 5 CAMA counties + OGRIP's 83 (stop regenerate-from-CAMA-only). Acceptance: a rebuild keeps OGRIP records (Clark still resolves after rebuild).
- [ ] **A3** Reload OGRIP correctly: Clark, then `--all` 82 counties. Acceptance: B1 golden queries pass for a sample of new counties; B2 coverage bands set.
- [ ] **A4** Find what ran the Aug-10 OH rebuild; make it OGRIP-aware (or replace it). Acceptance: documented + no longer clobbers.

### Workstream C — Stability
- [ ] **C1** Diagnose the 1,746 restarts — RSS growth per endpoint (reuse Aug-2 method); identify the accumulator or confirm it's the guard under crawler load. Acceptance: root cause written.
- [ ] **C2** Tame it — fix the accumulator or right-size the guard so recycles are rare (target <1/hr). Acceptance: measured recycle rate down.
- [ ] **C3** Commit a PM2 **ecosystem file** capturing script/cwd/interpreter/`--max-memory-restart` so rebuilds don't lose config. Acceptance: file in repo, `pm2 start ecosystem` reproduces the process.

### Workstream D — Depth (gated on B)
- [ ] **D1+** Resume `ACQUISITION-MATRIX.md` build order (OH OGRIP already coded → TX TxGIO → TN → CO → MA L3 → GA GSCCCA…), each county/dataset gated: lands only after passing B1–B3. (One tracker row per source as reached.)

### Status log
- 2026-08-12: tracker created; loop starting at B1.

