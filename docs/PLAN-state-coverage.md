# Plan: State Coverage — Deepen & Expand

**Date:** 2026-08-03
**Status:** Planning → schema-driven execution
**Owner:** title.rootz.global data engine

The product's value is **depth × breadth of verifiable public-record layers per property**.
Today parcels are broad but the layers that actually drive farming + title value
(recorded instruments, chain of title) are one-county islands. This plan defines a
*schema* for what "deep" means, scores every state against it, and executes the fill
with a schema-driven agent fan-out (not a hand-rolled loop).

---

## 1. The State Depth Schema

Every state is a `StateCoverageRecord`. Each **layer** has a status and a geographic
scope. The depth score is the weighted sum — weights reflect farming/title value.

```json
{
  "state": "FL",
  "layers": {
    "parcels":            { "weight": 20, "status": "statewide|partial|none", "countiesCovered": 67, "countiesTotal": 67, "source": "FL DOR NAL/SDF export" },
    "chainOfTitle":       { "weight": 20, "status": "partial", "note": "recorded DEEDS w/ grantor→grantee + book/page" },
    "recordedInstruments":{ "weight": 25, "status": "partial", "note": "liens, lis pendens, mortgages, judgments, probate — the distress + title signals" },
    "permits":            { "weight": 10, "status": "partial", "countiesCovered": 8 },
    "overlays":           { "weight": 15, "status": "statewide", "note": "flood, census, schools, hospitals, environmental, economics" },
    "crossRef":           { "weight": 10, "status": "statewide", "note": "LLC unmasking, entity/officer network" }
  },
  "depthScore": 0,   // Σ(weight × scopeFactor); scopeFactor = 1.0 statewide, countiesCovered/countiesTotal partial, 0 none
  "tier": "THIN | MEDIUM | DEEP"
}
```

**Why these weights:** recorded instruments (25) + chain of title (20) are the moat —
they're what nobody else assembles at scale and what makes a signed property passport
worth anchoring. Parcels (20) are table stakes. Overlays (15) are commodity APIs.

### Current scores (from the 2026-08-03 audit)

| State | parcels | chain | instruments | permits | overlays | crossRef | **score** | tier |
|---|---|---|---|---|---|---|---|---|
| FL | statewide | DOR-sales | **Broward only** (~1/67) | 8/67 | statewide | statewide | **~63** | DEEP |
| NC | statewide | **Chatham only** | Chatham only | none | partial | none | **~42** | MEDIUM |
| OH | **5/88** | none | none | none | partial | none | **~20** | MEDIUM |
| MA | Berkshire (live) | registry pulls | none | none | flood | none | **~15** | THIN |

The single biggest lever is **recordedInstruments breadth** — it's the highest weight and
the thinnest coverage (FL is 1/67 counties on its highest-value layer).

---

## 2. Deepen the states we have

Ordered by value-per-effort. The recurring unlock is that **recorder systems are
templated** — the same vendor platform serves many counties, so one integration
replicates across dozens.

1. **FL recorded instruments — Broward → statewide.** Broward runs OnCore/Acclaim
   (Harris Recording Solutions). Many FL counties run the *same* platform or the
   related Landmark Web. One puller template, parameterized per county, replicates the
   Broward win across the state. **Highest value on the board** (weight 25, currently 1/67).
   → makes court/distress + chain-of-title real statewide, and lights up the passport's
   `encumbrances`/`chainOfTitle` everywhere.
2. **OH parcels — 5 → all 88 counties.** Parcel bulk exists county-by-county (many on
   the same CAMA vendors). Mechanical fan-out; big breadth gain.
3. **NC chain of title — Chatham → statewide.** NC Register of Deeds is county-run but
   several counties share platforms (and NC has statewide parcels already to join to).
4. **FL permits — 8 → top-20 metro counties.** Accela/eTRAKiT/OnCore templates.
5. **MA — Berkshire → statewide MassGIS + more registries.** Live-API model already works.

## 3. Expand to new states

Prioritized by **data availability × market size × farming demand**. "Availability" is the
gate — states with statewide bulk parcel *and* open recorder bulk are cheapest to reach DEEP.

| Priority | State | Why | Parcel source | Recorder source |
|---|---|---|---|---|
| 1 | **GA** | **statewide recorded deeds/liens via GSCCCA** — rare, huge moat | county appraisers / GA DOR | GSCCCA statewide index |
| 2 | **TX** | massive market, strong investor farming | county appraisal districts (CAD bulk) | county clerks (many on same vendors) |
| 3 | **TN** | open parcels + active recorders | statewide (TN comptroller) | county registers |
| 4 | **SC** | adjacency to NC/GA, shared vendors | county assessors | county RODs |
| 5 | **AZ / CO** | high-growth investor markets | county assessors (bulk) | county recorders |

GA is #1 specifically because GSCCCA gives **statewide** recorded-instrument coverage in
one integration — instantly a DEEP state on the highest-weight layer, which no competitor
offers assembled.

---

## 4. Execution — schema-driven fan-out (the "schema, not a loop")

Two phases, each an agent fan-out with a **structured output contract** (the schema).
Discovery is cheap and parallelizes perfectly; build follows once sources are proven.

### Phase A — DISCOVERY (research the authoritative source for each gap)
One agent per (state, layer) gap. Each returns a validated `DataSourceRecord`:

```json
{
  "state": "GA", "layer": "recordedInstruments",
  "sourceName": "GSCCCA statewide index",
  "accessType": "bulk-ftp | api | scrape | portal-export | purchase",
  "url": "...", "geographicScope": "statewide | [county,...]",
  "format": "pipe-delimited | shp | json | csv",
  "cost": "free | $/yr", "license": "open | attribution | restricted",
  "refreshCadence": "daily | weekly | monthly | annual",
  "vendorPlatform": "OnCore/Acclaim | Landmark | Accela | Tyler | ...",
  "replicatesToCounties": ["..."],   // same platform → same puller
  "effort": "S | M | L", "confidence": 0.0, "notes": "..."
}
```

The output is a **coverage/acquisition matrix** — every gap with a costed, licensed,
effort-rated path to fill it, sorted by value-per-effort. That matrix is the artifact
Steven approves before any building.

### Phase B — BUILD (implement + verify pullers for approved rows)
One agent per approved source (worktree-isolated so parallel pullers don't collide):
writes the puller to the repo's existing patterns (`pull-*.mjs` / recipe), runs it against
a sample county, verifies row counts + field mapping, registers the dataset in
`service-health.mjs` (freshness check) and the query engine. Returns a `BuildResult`
(records, sampleVerified, healthRegistered).

**Cadence:** Phase A is a one-shot fan-out (rerun quarterly as sources change). Phase B
runs per approved batch. A scheduled routine can re-run Phase A monthly to catch new
open-data releases — that's the "loop," but the *unit of work* is the schema record, not
a blind iteration.

---

## 5. Guardrails (carry the provenance discipline forward)

- Every new source records its **origin** exactly like FL: real source URL + license, no
  hardcoded county assumptions (the `CO_NO`/`flCountyName` lesson).
- Recorded-instrument matches stay **county-scoped** (the Broward→Ocala smear bug) and
  carry `verified: confirmed|name_match`; only parcel-confirmed facts enter a passport hash.
- Each dataset added to `service-health.mjs` with a freshness threshold = ~2× its cadence,
  source-aware (harvester-vs-source) like the Broward check.
- Passport (`/api/fl/passport`) generalizes to `/api/{state}/passport` as layers land.
```
