# Acquisition Matrix — State Coverage Sources

**Generated:** 2026-08-04 from `state-coverage-discovery` workflow (13 agents, 88 sources, 0 errors).
Companion to `PLAN-state-coverage.md`. This is the **approval gate**: pick build rows, then Phase B implements pullers.

---

## Headlines

- **Statewide-parcel-in-one-integration is the dominant pattern.** Four states expose their *entire* parcel layer through a single free feed: **OH** (OGRIP, fills 83 missing counties), **TX** (TxGIO StratMap, 253/254 appraisal districts), **TN** (Comptroller, 86/95), **CO** (geodata.colorado.gov). **MA** (MassGIS L3, all 351 munis) is one bulk load. These are the cheapest DEEP-breadth wins on the board.
- **Georgia is the recorded-instrument moat, 3×.** GSCCCA gives statewide-in-one coverage for the Deed index (159 counties), Lien index, and — the only **confirmed true-bulk** product — the **UCC Central Index**. Build UCC bulk first (clean license, M effort), then amortize one portal scraper across deeds + liens.
- **Recorder systems are templated — one build repoints by host swap.** FL AcclaimWeb/OnCore + Landmark Web (two families), NC Cott/Kofile eSearch, OH Kofile CountyFusion, AZ/CO/SC/TX Kofile PublicSearch + Tyler Eagle. MA is a single statewide portal (masslandrecords.com, all 21 districts).
- **Dead ends to avoid:** OH has **no** statewide recorder bulk (88 independent offices — template or buy from ATTOM/CoreLogic); NC SoS "State Deeds" is state-owned property only, **not** private chain of title; **Cuyahoga bans scraping** (license it, don't reuse the template).
- **Bulk vs viewer trap:** qPublic/Beacon (GA, OH, SC) and MyFloridaCounty are *viewers/aggregators*, not feeds — for real geometry go to county ArcGIS Hubs.

---

## Recommended build order (value-per-effort)

**Tier 1 — statewide parcel wins (S/M effort, whole-state leverage):**
1. **OH parcels** — OGRIP statewide feature layer (S) — fills the 83 counties we lack instantly.
2. **TX parcels** — TxGIO StratMap (S) — 253/254 appraisal districts, free. New DEEP-breadth state in one pull.
3. **TN parcels** — TN Comptroller Div. of Property Assessments (M) — 86/95 counties, free.
4. **CO parcels** — geodata.colorado.gov statewide public parcels (S) — free.
5. **MA parcels** — MassGIS L3 (M) — all 351 municipalities incl. Berkshire; "beyond Berkshire" is the same integration.
6. **GA parcels** — GA DOR tax digest (S) + county ArcGIS Hubs (M) for geometry.
7. **AZ parcels** — Maricopa Assessor bulk FTP (S) + AZGeo statewide (M).

**Tier 2 — recorded-instrument moats (weight-25 layer):**
8. **GA UCC/liens** — GSCCCA UCC Central Index **bulk** (M) — only confirmed true-bulk; statewide.
9. **GA deeds** — GSCCCA Real Estate Deed Index (L) — grantor/grantee + book/page, all 159 counties.
10. **FL deeds** — AcclaimWeb/OnCore shared template (M) — extends the working Broward baseline by host swap (Brevard, St. Lucie, Santa Rosa, Duval...).
11. **FL deeds** — Landmark Web template (M) — 2nd FL county family (Escambia, Clay, Okaloosa, St. Johns, Palm Beach...).
12. **NC deeds** — Cott/Kofile eSearch template (M) — big bloc of the 100 RoDs by URL probe.
13. **OH deeds** — Kofile CountyFusion template (L) — dominant OH recorder bloc (exclude Cuyahoga).
14. **GA liens** — GSCCCA Lien Index (L) — marginal once the deed scraper exists.

**Tier 3 — permits + fill:** FL Accela cluster (Pinellas/Polk/Pasco/Osceola, one ACA scraper); TX/SC/AZ Kofile/Tyler recorder templates; MA masslandrecords.com statewide deeds (L, OCR).

---

## Full source matrix

### DEEPEN — existing states (FL / OH / NC / MA)  — 42 sources
| St | Layer | Source | Platform | Access | Cost | Eff | Conf |
|---|---|---|---|---|---|---|---|
| FL | recorded-instruments ( | Broward County Records, Taxes & Treasury — Official  | OnCore recording + Acclaim | bulk-ftp | Free for the rolli | S | 0.97 |
| FL | recorded-instruments ( | AcclaimWeb / OnCore public official-records search ( | OnCore + AcclaimWeb (Harri | api | Free for public we | M | 0.82 |
| FL | recorded-instruments ( | Landmark Web Official Records (Pioneer Technology Gr | Landmark Web recording/sea | scrape | Free public search | M | 0.85 |
| FL | recorded-instruments i | Palm Beach County Clerk & Comptroller — Electronic D | Landmark Web (Pioneer) for | bulk-ftp | Paid subscription  | M | 0.9 |
| FL | recorded-instruments ( | Lee County Clerk of Court — Bulk Data Services (FTP) | unknown (Lee runs its own  | bulk-ftp | Fee-based FTP acco | M | 0.85 |
| FL | court case data incl.  | Polk County Clerk — Bulk Data Subscriber (secure FTP | Clerk-operated FTP (court  | bulk-ftp | $75.00/month per c | M | 0.78 |
| FL | recorded-instruments ( | Orange County Comptroller — Official Records Self-Se | Kofile self-service search | scrape | Free public search | L | 0.6 |
| FL | recorded-instruments ( | Miami-Dade Clerk of Court & Comptroller — Official R | In-house / county-built sy | scrape | Free public search | L | 0.6 |
| FL | recorded-instruments ( | Duval County Clerk — Official Records (OnCore record | OnCore (Harris Recording S | unknown | Free public search | M | 0.55 |
| FL | recorded-instruments ( | MyFloridaCounty.com Official Records (Florida Court  | FACC Services Group / Civi | portal-export | Free to browse; ce | L | 0.85 |
| FL | building-permits | Pinellas County Access Portal (Accela Citizen Access | Accela (Civic Platform / A | scrape | Free (public porta | M | 0.85 |
| FL | building-permits | Polk County Citizen Access (Accela) | Accela (Civic Platform / A | scrape | Free public portal | M | 0.85 |
| FL | building-permits | Pasco County PascoGateway (Accela) | Accela (Civic Platform / A | scrape | Free public portal | M | 0.83 |
| FL | building-permits | Osceola County Permit Center (Accela, self-hosted) | Accela (Civic Platform / A | scrape | Free public portal | M | 0.82 |
| FL | building-permits | Sarasota County Permit Search (building.scgov.net) | Accela (self-hosted ACA —  | scrape | Free public portal | M | 0.55 |
| FL | building-permits | Palm Beach County ePZB / ePermits Portal | In-house custom 'ePZB/iPZB | portal-export | Free | L | 0.6 |
| FL | building-permits | Duval County / Jacksonville — JaxEPICS + BID GIS | In-house custom 'JaxEPICS' | bulk-download | Free | M | 0.65 |
| FL | building-permits | Lake County — OpenGov (ViewPoint Cloud) permitting p | OpenGov (ViewPoint Cloud)  | scrape | Free public portal | M | 0.6 |
| FL | building-permits | PermitData.net (commercial aggregator) | Third-party aggregator (no | purchase | Paid (free FL expl | S | 0.5 |
| FL | building-permits | Accela Civic Platform REST API (Construct API) — cro | Accela (Civic Platform / C | api | No Accela fee for  | L | 0.45 |
| OH | parcels-cama-statewide | OGRIP Ohio Statewide Parcels (Public View) — Feature | Esri ArcGIS Hub / Feature  | api | Free (public gover | S | 0.9 |
| OH | parcels-cama-statewide | OGRIP / Ohio Parcels ArcGIS Hub (portal + CAMA datas | Esri ArcGIS Hub (OGRIP, Oh | bulk-download | Free | S | 0.8 |
| OH | parcels-cama-county-de | Tyler Technologies iasWorld — county CAMA/tax system | Tyler Technologies iasWorl | portal-export | Free via each coun | M | 0.75 |
| OH | parcels-cama-county-de | Schneider Geospatial qPublic.net / Beacon — county a | Schneider Geospatial qPubl | scrape | Free to view; no o | L | 0.65 |
| OH | parcels-cama-county-de | County Auditor GIS open-data portals (Esri ArcGIS Hu | Esri ArcGIS Hub / open-dat | bulk-download | Free | M | 0.7 |
| OH | recorded instruments / | Kofile — CountyFusion & PublicSearch.us (Ohio county | Kofile CountyFusion (count | scrape | Index search free  | L | 0.82 |
| OH | recorded instruments / | Cuyahoga County Fiscal Officer — Recorded Document S | Kofile PublicSearch (cuyah | scrape | Free index/image s | M | 0.85 |
| OH | recorded instruments / | Harris Recording Solutions — Acclaim (AcclaimWeb) | Harris Recording Solutions | scrape | Online search free | M | 0.78 |
| OH | recorded instruments / | Pioneer Technology Group — Landmark Web (Official Re | Pioneer Technology Group L | scrape | Index search free; | M | 0.72 |
| OH | statewide recorded-ins | Ohio statewide recorder bulk/API — DOES NOT EXIST |  | none | N/A | L | 0.85 |
| OH | county-recorder discov | NETROnline Public Records Directory — Ohio | NETROnline (aggregator dir | scrape | Free | S | 0.8 |
| NC | deeds / recorded instr | North Carolina Association of Registers of Deeds (NC | N/A (directory only) | none | Free directory; un | S | 0.95 |
| NC | deeds / recorded instr | Cott Systems / Kofile 'eSearch' hosted RoD portals ( | Cott Systems / Kofile (eSe | portal-export | Free/low-cost name | M | 0.85 |
| NC | deeds / recorded instr | Wake County Register of Deeds — Consolidated Real Pr | In-house (Wake CRPI; SoS-c | bulk-download | Online search free | M | 0.7 |
| NC | deeds / recorded instr | Mecklenburg County Register of Deeds — deeds.mecknc. | In-house / Mecklenburg (la | portal-export | Online search free | M | 0.65 |
| NC | deeds / recorded instr | Hyland OnCore hosted RoD portals (oncoreweb) | Hyland OnCore | portal-export | Online search free | M | 0.55 |
| NC | foreclosure / lis pend | NC eCourts Portal (Tyler Odyssey) — Clerk of Superio | Tyler Technologies Odyssey | portal-export | Free public case s | L | 0.7 |
| NC | deeds — NOT the genera | NC Secretary of State — Land Records / State Deeds s | NC SoS in-house | none | Free | S | 0.9 |
| NC | deeds / property docum | Third-party aggregators (northcarolinaofficialrecord | Various commercial re-host | scrape | Free teasers to pa | M | 0.4 |
| MA | parcels | MassGIS Level 3 Standardized Assessors' Parcels (per | MassGIS (Bureau of Geograp | bulk-download | Free | M | 0.95 |
| MA | parcels | MassGIS Level 3 Parcels - ArcGIS REST Feature Servic | Esri ArcGIS Online, hosted | api | Free | M | 0.8 |
| MA | deeds | masslandrecords.com - Secretary of the Commonwealth  | Single unified portal oper | scrape | Free to search/vie | L | 0.85 |

### EXPAND — new states (GA / TX / TN / SC / AZ / CO)  — 46 sources
| St | Layer | Source | Platform | Access | Cost | Eff | Conf |
|---|---|---|---|---|---|---|---|
| GA | deed-index | GSCCCA Real Estate (Deed) Index | GSCCCA | scrape | Portal subscriptio | L | 0.9 |
| GA | ucc-index | GSCCCA UCC Central Index System — Bulk Data | GSCCCA | bulk-download | Bulk Data subscrip | M | 0.85 |
| GA | lien-index | GSCCCA Lien Index | GSCCCA | scrape | Same portal subscr | L | 0.85 |
| GA | parcels | qPublic / Beacon by Schneider Geospatial (Georgia As | qPublic/Schneider | scrape | Free public parcel | L | 0.72 |
| GA | parcels | County ArcGIS Hub open-data portals (Esri FeatureSer | Esri ArcGIS Hub | api | Free | M | 0.85 |
| GA | parcels | Georgia DOR tax digest data (via GeorgiaData.org / D |  | bulk-download | Free | S | 0.9 |
| GA | parcels | Georgia Geospatial Information Office (GIO) statewid | Esri ArcGIS Hub | unknown | Expected free | M | 0.4 |
| GA | parcels | Direct county GIS/assessor bulk purchase or open-rec |  | purchase | Varies — often fre | L | 0.6 |
| TX | parcels | TxGIO StratMap Land Parcels (statewide aggregation) | TxGIO DataHub (data.geogra | bulk-download | Free | S | 0.92 |
| TX | parcels | Harris Central Appraisal District (HCAD) Public Data | HCAD self-hosted (CAMA ven | bulk-download | Free | M | 0.9 |
| TX | parcels | Dallas Central Appraisal District (DCAD) Data Produc | DCAD self-hosted | bulk-download | Free | M | 0.85 |
| TX | parcels | Tarrant Appraisal District (TAD) Data Downloads + Op | Esri ArcGIS Hub (gis-tad.o | bulk-download | Free | S | 0.88 |
| TX | parcels | Collin Central Appraisal District (CCAD) — Texas Ope | Socrata / Tyler Data & Ins | api | Free | S | 0.85 |
| TX | parcels | Bexar Appraisal District (BCAD) — Reports / data req | BCAD self-hosted | unknown | Unknown (likely fr | M | 0.5 |
| TX | parcels | Travis Central Appraisal District (TCAD) | TCAD self-hosted property  | portal-export | Unknown (property- | M | 0.5 |
| TX | parcels | TaxNetUSA — commercial bulk CAD appraisal + GIS data | TaxNetUSA (aggregates all  | purchase | Paid — custom quot | S | 0.85 |
| TX | recorded-instruments | Harris County Clerk — Real Property Records bulk (FT | Harris County Clerk self-h | bulk-ftp | Paid — monthly sub | M | 0.88 |
| TX | recorded-instruments | Kofile PublicSearch — county clerk Official Public R | Kofile PublicSearch (*.tx. | portal-export | Search free; certi | L | 0.82 |
| TX | recorded-instruments | TexasFile — commercial county clerk land-records agg | TexasFile (multi-county cl | purchase | Paid — subscriptio | S | 0.72 |
| TN | parcels | Tennessee Comptroller of the Treasury — Division of  | State-produced from IMPACT | bulk-download | Free | M | 0.95 |
| TN | parcels | TNMap / geodata.tn.gov — State of Tennessee STS GIS  | Esri ArcGIS Enterprise / A | api | Free | M | 0.75 |
| TN | assessment/CAMA attrib | Tennessee Property Assessment Data (TPAD) — Comptrol | State-hosted (Comptroller  | scrape | Free | M | 0.85 |
| TN | recorder / register of | US Title Search Network Services, Inc. (ustitlesearc | US Title Search Network (T | purchase | Subscription or pe | L | 0.7 |
| TN | recorder / register of | Business Information Systems (BIS) — register-of-dee | Business Information Syste | scrape | Varies by county ( | L | 0.55 |
| TN | recorder / register of | Davidson County (Nashville) Register of Deeds — davi | County-hosted (davidsonpor | purchase | $50/month single u | M | 0.8 |
| TN | recorder + parcels (me | Shelby County (Memphis) Register of Deeds + Shelby/M | County-hosted Esri ArcGIS  | api | Free (search + GIS | M | 0.7 |
| SC | parcels | SC Revenue & Fiscal Affairs Office (RFA) / SC Geogra |  | none | No published price | L | 0.72 |
| SC | parcels | qPublic.net / Beacon (South Carolina Assessors porta | qPublic/Schneider (Schneid | portal-export | Free to search | M | 0.86 |
| SC | parcels | County ArcGIS Hub / Open Data (parcel geometry) — Ch | Esri ArcGIS Hub / ArcGIS O | bulk-download | Free | L | 0.83 |
| SC | recorded-instruments | SC Land Records statewide portal (sclandrecords.com) | unconfirmed (statewide mul | scrape | Free for basic ind | M | 0.62 |
| SC | recorded-instruments | Kofile PublicSearch (recorded land records) — e.g.,  | Kofile (PublicSearch, *.pu | scrape | Free index/image v | M | 0.8 |
| SC | recorded-instruments | Charleston County Register of Mesne Conveyance — Rea | publicaccessnow.com (Charl | scrape | Free to search | S | 0.78 |
| SC | recorded-instruments | Richland County Register of Deeds — Subscription Dat | Richland ROD Subscription  | purchase | Paid subscription  | S | 0.66 |
| AZ | assessor-parcels | Maricopa County Assessor — Data Sales / GIS Parcel D | In-house (Maricopa Assesso | bulk-download | Basic assessment/p | S | 0.9 |
| AZ | assessor-parcels | AZGeo Data Hub (AGIC + Arizona State Land Department | Esri ArcGIS Hub (server.az | bulk-download | Free (registration | M | 0.72 |
| AZ | assessor-parcels | Pima County GIS / Assessor open data | Esri ArcGIS Hub (county GI | bulk-download | Free | M | 0.6 |
| AZ | recorder-instruments | Maricopa County Recorder — Recorded Document Search  | In-house (recorder.maricop | purchase | Free online portal | L | 0.75 |
| AZ | recorder-instruments | Tyler Technologies EagleWeb (tylerhost.net) — shared | Tyler Technologies Eagle / | scrape | Free portal search | L | 0.7 |
| AZ | recorder-instruments | Pima County Recorder — Public Search portal (Tyler-b | Tyler Technologies (Pima r | scrape | Free search/view;  | M | 0.62 |
| CO | assessor-parcels | Colorado Public Parcels — statewide (CO OIT GIS / ge | Esri ArcGIS Hub (geodata.c | bulk-download | Free | S | 0.85 |
| CO | assessor-parcels | Colorado Information Marketplace — Statewide Aggrega | Tyler Technologies Socrata | api | Free | S | 0.7 |
| CO | assessor-parcels | Boulder County Assessor — Property Data Download (an | Esri ArcGIS Hub (opendata- | bulk-download | Free | M | 0.8 |
| CO | recorder-instruments | Kofile PublicSearch (*.publicsearch.us) — shared CO  | Kofile PublicSearch (publi | scrape | Free portal search | L | 0.72 |
| CO | recorder-instruments | Kofile Acclaim / Tyler Eagle — additional CO county  | Kofile Acclaim (acclaim.*) | scrape | Free search/view;  | L | 0.55 |
| CO | recorder-instruments | Denver Clerk & Recorder / El Paso County — large in- | Denver = Kofile PublicSear | portal-export | Free portal search | L | 0.5 |
| AZ | assessor-parcels+recor | Regrid — commercial normalized parcel + ownership ag | Regrid (app.regrid.com Dat | purchase | Paid — subscriptio | S | 0.75 |

---

## Guardrails (carry forward)
- Record real **origin** per source (URL + license), no hardcoded county assumptions (the `CO_NO`/`flCountyName` lesson).
- Recorded-instrument matches stay **county-scoped** with `verified: confirmed|name_match`; only parcel-confirmed facts enter a passport hash (the Broward→Ocala smear fix).
- Register every new dataset in `service-health.mjs` (source-aware freshness, ~2× cadence).
- Respect scraping bans (Cuyahoga) and licenses; prefer bulk/API over scrape; buy (ATTOM/TaxNetUSA/Regrid) where no open feed exists and value warrants.
