# title-rootz on `@epistery/datasource` — PR 1: the signed catalog

This adds the one thing title-rootz did not have: a **signed, paged JSON-LD
catalog** of its public property corpus that **epistery-scan can index**, with
the government origin named on every object. It is **purely additive** — every
existing route, tool, page and billing flow keeps working, untouched.

## What this is (and is not)

We are **not** adding a new trust layer. A Rootz signature over scraped data only
says "Rootz served this" — worth exactly what someone trusts Rootz for, which is
not the point. The point is the **origin evidence the collectors already find** —
the government source of each fact, the deed book/page references, the
confirmed-vs-advisory match honesty, and a content hash that lets anyone
**re-verify the record against the county source**. This PR carries that evidence
onto every catalog object. We provide what we found; scan reports the honest
rung; trust is derived at the origin, where it is real.

## What changed — five new files, two small edits, nothing removed

| File | What |
|---|---|
| `datasource/source.mjs` | The `defineSource` declaration: two collections — **`parcels`** (FL DOR statewide) and **`encumbrances`** (Broward public recorded instruments). Pure `id()/keys()/map()` — no hosting, no server. |
| `datasource/harvest.mjs` | Reads the **existing** inputs — FL DOR city JSONL + the Broward clerk sqlite — and emits them into the substrate store. Nothing new is scraped. |
| `datasource/mount.mjs` | Serves the catalog from inside the current raw-http server (GET-only). |
| `datasource/run-harvest.mjs` | `npm run harvest:datasource [-- --limit N]` |
| `datasource/source.test.mjs` | Unit tests for `id()/keys()/map()` on synthetic records. `npm run test:datasource` |
| `src/server.js` | **+2 lines**: import + one delegation at the top of the router. |
| `package.json` | `@epistery/datasource` dependency + two scripts. |

New routes (all GET, none collide with an existing path):

```
/api/catalog?limit&offset          paged JSON-LD — what scan walks to `total`
/api/record/:collection/:id        one object by id
/api/catalog/search?collection&…   exact/prefix search on indexed fields
/api/datasource/status             what is held + last harvest, counted live
/.well-known/ai/skill.json         manifest declaring the catalog
```

### Why not the substrate's own Express server

The substrate ships a standalone Express mount, but it runs `express.json()` ahead
of everything — which would consume the request body that title-rootz's **Stripe
webhook** and every POST handler read themselves, silently breaking them. So this
PR uses the substrate's **data layer** (`defineSource` + `openStore` +
`createCatalog` + signed `skill.json`) mounted as GET routes inside the existing
server. The raw-http server is otherwise untouched.

## Nothing lost — where every capability lives now

Everything below keeps working exactly as today; this PR touches none of it:

- **Billing / accounts / auth** (Stripe tiers, magic-link, rate limits, token
  budgets, saved-property CRM, conversations) — unchanged.
- **Farming** — the score engine, `/api/fl/farm`, `/api/nc/farm`, the `/farm`
  AI chat — unchanged.
- **Overlays** — flood, census, permits, schools, hospitals, economics,
  timeshare, vacation rentals — unchanged.
- **Cross-refs** (private.rootz / origin.rootz), **MA** chain/liens/fraud/party,
  **bridge pages**, **sitemaps / IndexNow / robots**, the existing
  `/.well-known/ai` — unchanged.
- **Property passport** (`/api/fl/passport`) and **title-wallet** — unchanged;
  the catalog's parcel objects carry the same kind of `contentHash`, so the two
  reinforce each other.

The full capability inventory this PR was built against is preserved in the
review notes; this catalog is strictly an addition on top of it.

## Signing

Until `title.rootz.global` has an epistery domain wallet (a deploy step, not
code), `skill.json` is served **unsigned** — honest bottom-rung provenance, per
the substrate's "no signer → unsigned" rule. The catalog is fully usable
meanwhile; scan records Rootz as the author the moment the wallet lands.

## Running it

```bash
npm install                         # requires @epistery/datasource (see note)
npm run harvest:datasource -- --limit 5000    # a test load; omit --limit for full
npm run test:datasource
# then: GET /api/catalog?limit=3   → typed JSON-LD, full-IRI @type, provenance
```

> **Dependency note:** `@epistery/datasource` is the shared substrate
> (github.com/epistery/datasource). Until it is published, install it with a
> local relative path for development (`npm install ../epistery/datasource`).

## Vocabulary — needs a call on the #rootz board

- `parcels` → `https://epistery.com/schema/Parcel`
- `encumbrances` → `https://epistery.com/schema/RecordedInstrument`

Neither exists in schema.org (it types places and listings, not cadastral
parcels or recorded instruments), so these are epistery-published — a sibling to
farm-intel's already-published `AgParcel`. Confirm the names before scan writes
the category maps.

## Deploy (later, not in this PR)

1. Mint the `title.rootz.global` epistery domain wallet → `skill.json` signs.
2. Run the full `harvest:datasource`.
3. Add `[datasources.title]` to scan's `/scan` config; `POST /api/ingest/title`.
4. Acceptance: search a distinctive Broward address on epistery.com and get a
   card carrying the parcel, its source, and Rootz as author.

## Roadmap (staged so each step is reviewable and lossless)

- **PR 1** — the signed catalog for FL parcels + Broward instruments.
- **PR 2** — restore `/mcp` on the live server through the epistery MCP facility:
  the generic catalog tools plus the live value-add tools (property intelligence,
  passport, farming, OH, NC). `/mcp` was **advertised but served by nobody** — the
  old `mcp-server/server.mjs` is not running (`/mcp` and `/api/party` are 404 in
  production), so the MCP surface was dark. This lights it back up.
- **PR 3** — retire the dead `mcp-server/server.mjs`; port its **dark-only** tools
  (cross-ref to private/origin, MA fraud/party/notary) into live modules and
  declare them through the facility. Then the remaining collections (OH/NC parcels,
  DBPR rentals, overlays), `harvest()` scheduling replacing the `pull-*` crons, and
  retiring `parcels.db` in favour of the substrate store.
- **PR 4 (deploy)** — under the **new rootz OCI tenancy** (see RootzOracleTenancy),
  not the legacy metric-im box: mint the domain wallet, cut over, register
  `[datasources.title]` on scan, ingest. Deploy is git-pull discipline, Michael's.
