# Phase B Build Plan — autonomous tier-by-tier execution tracker

This is the **stateful schema that drives the build loop**. Each iteration reads this file,
picks the next `todo` source in tier order, builds → tests → registers → deploys → commits,
updates status here, and continues. Tiers are gated: finish a tier before the next.

## Loop protocol (per source)
1. **Pre-flight** — source reachable? disk headroom? blocker (paid / credentials / scrape-ban)?
   If blocked → set `status: blocked`, write reason, **skip** (do not stall the loop).
2. **Build** — write `pull-<key>.mjs` following existing pattern; county-parameterized where the
   vendor platform replicates (one template, host swap).
3. **Test (acceptance gate)** — run against a SAMPLE (1 county / limited fetch). Must pass:
   non-zero records • fields map to the state schema • joins to parcel • `/api/<st>/search`
   returns a real property for a known address. No pass → `status: building`, note the failure.
4. **Register** — add dataset to `service-health.mjs` (source-aware freshness) + wire query engine
   (+ cron if recurring).
5. **Deploy** — scp, restart, verify live endpoint.
6. **Commit + push** to `main`.
7. **Update status here** → `done` (or `blocked`), continue to next.

## Acceptance criteria by layer
- **parcels**: `/api/<st>/search?address=…` returns owner+value for a known address in a sample county; record count sane vs county size.
- **recorded-instruments**: sample county returns instruments with type/date/party; matches stay county-scoped + `verified` flag; passport `encumbrances` populate.
- **permits**: sample address returns permits with type/date/status.

## Skip-and-flag (needs Steven — do NOT auto-build)
Paid subscriptions, credentialed FTP, or scrape-banned. Flagged, not attempted:
Palm Beach FTP (paid), Polk court FTP ($75/mo), Lee FTP (fee), **Cuyahoga (scrape ban)**,
GSCCCA deed/lien (paid-login scrape — UCC bulk is OK), Davidson/Richland RoD (paid),
TaxNetUSA / Regrid / TexasFile / PermitData (commercial). Revisit as a batch with Steven.

---

## Recon banked (test-as-you-go, 2026-08-04)
- Box disk: **720G free / 968G** — no capacity concern for statewide pulls.
- **OH OGRIP** endpoint: `https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0`
  — **6,313,610 parcels**, all 88 counties, maxRecordCount 2000 (paginate `resultOffset`). Fields: County,
  LocalParcelID, StateParcelID, StateLUC (land-use w/ labels e.g. "510: Res-Single Family"), SitusAddressAll
  ("24 CENTER ST SPRINGFIELD 45505"), MailAddressAll + Mail* components, LandArea, CurrentTo, CAMADataSite.
  **NO owner name, NO value** → this is BREADTH (address/parcel/land-use for all 88 counties) not full depth;
  owner/value stays via the county CAMA (existing 5 counties keep their rich data; CAMADataSite is the drill link).
  Some records have null attributes (skip rows without SitusAddressAll).
- **OH engine target schema** (`src/query/oh-property.js`): normalized `TRUE_*` fields; the `f()` getter matches
  by short field name. OGRIP needs a NEW mapper branch keyed on its shape so `_county` is set from the `County`
  field (do NOT let it default to 'Franklin' — same class as the FL CO_NO provenance bug). Emit city-indexed
  `OH_CITY_OF_<CITY>.jsonl` parsed from SitusAddressAll; owner/value null; add `_source:'ohio-ogrip'`, CAMADataSite link.

## TIER 1 — statewide parcels (free bulk/API, whole-state leverage)

| # | key | state | source | access | effort | status | notes |
|---|---|---|---|---|---|---|---|
| 1 | oh-ogrip-parcels | OH | OGRIP Ohio Statewide Parcels (Esri FeatureServer) | api | S | building | 6.3M; breadth not depth (no owner/value); needs OGRIP mapper branch |
| 2 | tx-txgio-parcels | TX | TxGIO StratMap Land Parcels | bulk-download | S | todo | 253/254 CADs, free |
| 3 | tn-comptroller-parcels | TN | TN Comptroller Div. Property Assessments | bulk-download | M | todo | 86/95 counties, free |
| 4 | co-geodata-parcels | CO | geodata.colorado.gov statewide parcels | bulk-download | S | todo | free |
| 5 | ma-massgis-l3 | MA | MassGIS L3 Standardized Assessors' Parcels | bulk-download | M | todo | all 351 munis; deepens MA |
| 6 | ga-parcels | GA | GA DOR tax digest + county ArcGIS Hubs | bulk-download | M | todo | geometry via county hubs |
| 7 | az-parcels | AZ | Maricopa Assessor bulk + AZGeo statewide | bulk-download | S | todo | start Maricopa |

## TIER 2 — recorded instruments (the moat, weight 25)

| # | key | state | source | access | effort | status | notes |
|---|---|---|---|---|---|---|---|
| 8 | ga-gsccca-ucc | GA | GSCCCA UCC Central Index (bulk) | bulk-download | M | todo | only confirmed true-bulk; statewide |
| 9 | fl-acclaim-template | FL | AcclaimWeb/OnCore shared template | api | M | todo | extends Broward baseline by host swap |
| 10 | fl-landmark-template | FL | Landmark Web shared template | scrape | M | todo | 2nd FL county family |
| 11 | nc-esearch-template | NC | Cott/Kofile eSearch RoD template | portal-export | M | todo | big bloc of 100 RoDs |
| 12 | oh-countyfusion-template | OH | Kofile CountyFusion recorder template | scrape | L | todo | exclude Cuyahoga |
| 13 | ga-gsccca-deeds | GA | GSCCCA Deed Index | scrape | L | blocked | paid-login scrape — flag |

## TIER 3 — permits + fill

| # | key | state | source | access | effort | status | notes |
|---|---|---|---|---|---|---|---|
| 14 | fl-accela-cluster | FL | Accela ACA (Pinellas/Polk/Pasco/Osceola) | scrape | M | todo | one ACA scraper |
| 15 | tx-kofile-recorders | TX | Kofile PublicSearch county clerks | portal-export | L | todo | multi-county template |
| 16 | sc-recorders | SC | qPublic assessors + Kofile PublicSearch | mixed | M | todo | adjacency reuse |

---

## Status log
- 2026-08-04: plan created; loop starting at Tier 1 #1 (OH OGRIP).
