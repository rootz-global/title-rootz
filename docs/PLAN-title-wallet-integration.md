# Plan: Title Wallet — Integration, Testing, Deployment & Operations

**Date:** April 26, 2026 (v2 — mainnet-only, dashboard-first, custodian wallet)
**Status:** Planning — with the **public-layer bridge now built** (see Build Log)
**Depends on:** DESIGN-title-wallet-v6.md (v2)

---

## Build Log

### 2026-07-30 — Property Passport (KV-PUBLIC public layer) — BUILT & LIVE

**Reconciliation with reality:** since this plan was written, title.rootz.global
shipped as the property-*intelligence* engine (FL/OH/NC/MA parcels, farming,
court records, and a signed origin/provenance record per property). That created
**two identities for the same property** — the engine's origin record
(`FL-MARION-…`, sourced + hashed) and this plan's on-chain Property Secret — that
didn't reference each other. The bridge: **the intelligence engine produces the
KV-PUBLIC content the Property Secret anchors.**

Built `src/query/fl-passport.js` + `GET /api/fl/passport?address=&city=` (also
`?folio=` for Miami-Dade). A passport is the verifiable, anchorable PUBLIC record:
- canonical `propertyId` (county-correct, from CO_NO) + a deterministic
  `contentHash` — the digest a Property Secret pins as its KV-PUBLIC note; same
  public facts → same hash, so an anchored record re-verifies against the county.
- `chainOfTitle` from DOR sale records (all counties; deed OR book/page refs).
- `encumbrances` (Broward recorded instruments) — each flagged
  `verified: confirmed|name_match`. **Only parcel-confirmed encumbrances enter
  the content hash**; name matches surface as advisory but never commit on-chain.
- `completeness` score + `anchorable` flag (min bar: real parcel + owner +
  county) + a `walletBridge` block telling the wallet layer what to pin.

Verified live: Ocala/Marion → clean chain, 0 false Broward encumbrances,
anchorable; Fort Lauderdale/Broward → 4 encumbrances all correctly advisory
(name_match), excluded from the hash; contentHash deterministic across calls.

**Still open from this plan (unchanged):** custodian wallet service + dashboard
API/frontend (steps 3–5, need rootz-v6 + mainnet); resolve the domain collision
(intelligence engine currently owns title.rootz.global). Next enrichment for the
passport: pull grantor/grantee + all-county recorded deeds into chainOfTitle.

---

## Part 1: Development Environment

### What Already Exists

The V6 infrastructure has a complete test stack. We don't need to build a test framework — we need to configure it for the title wallet use case.

| Component | Location | Status |
|---|---|---|
| V6 Packages (27) | `rootz-v6/packages/` | Working, tested |
| Integration gateway | `@rootz/integration` (RootzClient) | Working |
| Secret Orchestrator | `packages/secret-orchestrator/` | Working (31 tests) |
| Notes / KeyVault | `packages/notes/` | Working (NoteManager) |
| Teams / Invites | `packages/teams/` | Working (39 tests) |
| Identity Provider | `packages/identity-provider/` | Working (24 tests) |
| Crypto (AES/ECDH) | `packages/crypto/` | Working (38 tests) |
| Chain Reader | `packages/chain-reader/` | Working (12 tests) |
| Desktop V6 | `apps/desktop-v6/` | Working (port 3020) |
| Dashboard | `dashboard/` | Working (web UI) |
| Test Playbook | `packages/api/tests/TEST_PLAYBOOK.md` | 8 scenarios documented |
| Mainnet contracts | V7 on Polygon (137) | Production addresses in CLAUDE.md |
| Test wallet setup | TEST_PLAYBOOK.md | 5 wallets documented |

### Testing on Polygon Mainnet (Not Testnet)

**We test on production contracts.** Polygon mainnet is cheap enough that testnet adds friction without value:

- Creating a Property Secret: ~$0.05
- Writing 40 notes: ~$0.02
- Adding 5 team members: ~$0.01
- **Total test closing: ~$0.08**

Amoy has faucet issues, contract version mismatches, and behaviors that don't match production. Every minute spent debugging testnet differences is wasted. A full end-to-end test on mainnet costs less than a dime and proves the real system works.

### Dev Environment Setup

#### Step 1: Verify V6 builds and unit tests pass

```bash
cd rootz-v6
npm install
npm run build
npm test --workspaces
```

**Expected result:** All 200+ unit tests pass. If they don't, fix before proceeding.

#### Step 2: Verify mainnet connectivity

```bash
# Chain reader should read from Polygon mainnet
cd packages/chain-reader
npm run test:real
```

**Expected result:** Can read events from V7 mainnet contracts.

#### Step 3: Verify 5 test wallets are funded on mainnet

| Wallet | Role for Title Wallet | Mainnet Balance |
|---|---|---|
| ALICE | Title Company (owner) | 1 POL (~$0.50) + 1M credits |
| BOB | Buyer | 0.5 POL + 500K credits |
| CHARLIE | Seller | 0.5 POL + 500K credits |
| DEVICE_2 | Attorney | 0.5 POL + 500K credits |
| DEVICE_3 | Lender | 0.5 POL + 500K credits |

**Cost to fund all 5 wallets: ~$1.50 in POL.** This is cheaper than the time cost of configuring a testnet.

#### Step 4: Run the existing TEST_PLAYBOOK scenarios 1-8 on mainnet

These exercise the exact same flows we need for the title wallet. If scenarios 1-8 pass on mainnet, the infrastructure is proven and we've already created real on-chain artifacts we can reference.

---

## Part 2: Title Wallet Test Plan

### Phase A: Unit Tests — Title Wallet Logic

Build `packages/title-wallet/` or `land-records/title-wallet/` as a new package that imports from `@rootz/integration`. Test in isolation with mocks.

| Test | What It Verifies |
|---|---|
| `closing-template.test.ts` | Template generates correct KeyVault list + access matrix |
| `document-classifier.test.ts` | Maps document types to KeyVaults correctly |
| `access-matrix.test.ts` | Each party gets correct KV keys in their encryptedAccessKey |
| `note-metadata.test.ts` | Note metadata schema validates (document type, provenance, registry ref) |
| `confidence-score.test.ts` | Scoring formula: completeness × 0.30 + cross-source × 0.25 + ... |

### Phase B: Integration Tests — Single Property on Polygon Mainnet

**Scenario TW-1: Create Property Secret**

```
ALICE (Title Company) creates Property Secret for "111 Swamp Rd"
  → Factory.createSovereignWalletAsNewborn()
  → Property Secret deployed, owned by ALICE
  → Verify: contract exists, ALICE is owner
```

**Scenario TW-2: Create KeyVaults**

```
ALICE creates 8 KeyVaults on the Property Secret:
  KV-PUBLIC, KV-DISCLOSURE, KV-SETTLEMENT, KV-WIRE,
  KV-MORTGAGE, KV-TITLE, KV-INSPECTION, KV-CONTRACT
  → Each with schemaDefinition JSON specifying document types
  → Verify: 8 KeyVaultCreated events, each with correct schema
```

**Scenario TW-3: Add Team Members**

```
ALICE adds 4 team members:
  BOB (Buyer)     → role: MEMBER, keys for: PUBLIC, DISCLOSURE, SETTLEMENT, MORTGAGE, TITLE, INSPECTION, CONTRACT
  CHARLIE (Seller) → role: MEMBER, keys for: PUBLIC, DISCLOSURE, SETTLEMENT, CONTRACT
  DEVICE_2 (Attorney) → role: ADMIN, keys for: ALL KVs
  DEVICE_3 (Lender)   → role: MEMBER, keys for: PUBLIC, MORTGAGE, SETTLEMENT(buyer), TITLE, INSPECTION
  → Each via addTeamMember(address, role, encryptedAccessKey, publicKey)
  → Verify: 4 TeamMemberAdded events
  → Verify: Each member can decrypt their authorized KV keys
  → Verify: Members CANNOT decrypt unauthorized KV keys
```

**Scenario TW-4: Write Closing Documents**

```
ALICE writes 10 test documents as Notes:
  1. Deed (to KV-PUBLIC) — with PDF attachment via IPFS
  2. Chain of Title (to KV-PUBLIC)
  3. Lead Paint Disclosure (to KV-DISCLOSURE)
  4. Closing Disclosure - Buyer (to KV-SETTLEMENT)
  5. Closing Disclosure - Seller (to KV-SETTLEMENT)
  6. Wire Instructions - Buyer (to KV-WIRE)
  7. Promissory Note (to KV-MORTGAGE)
  8. Title Certification (to KV-TITLE)
  9. Home Inspection (to KV-INSPECTION)
  10. Purchase & Sale Agreement (to KV-CONTRACT)
  → Each Note: content encrypted, PDF to IPFS (VDN encrypted hash), metadata with document type
  → Verify: 10 DataWritten events
  → Verify: Document hashes match originals
```

**Scenario TW-5: Party Views**

```
BOB (Buyer) reads his authorized KeyVaults:
  → Can read: KV-PUBLIC (deed, chain), KV-DISCLOSURE (lead paint),
    KV-SETTLEMENT (buyer CD only), KV-MORTGAGE (note), KV-TITLE (cert),
    KV-INSPECTION (inspection), KV-CONTRACT (P&S)
  → CANNOT read: KV-WIRE (wire instructions), KV-SETTLEMENT seller side
  → Verify: decryption succeeds on authorized, fails on unauthorized

CHARLIE (Seller) reads his authorized KeyVaults:
  → Can read: KV-PUBLIC, KV-DISCLOSURE, KV-SETTLEMENT (seller CD only), KV-CONTRACT
  → CANNOT read: KV-WIRE (buyer wire), KV-MORTGAGE, KV-INSPECTION
  → Verify: access control matrix holds
```

**Scenario TW-6: Team Member Writes**

```
BOB (Buyer) adds a post-closing document:
  → Writes "Renovation Permit" note to KV-PUBLIC with write authorization
  → Verify: DataWritten event, BOB as writer, valid authorization signature
  → Verify: ALICE (owner) can read the note
  → Verify: Property event count increases
```

**Scenario TW-7: Verify Wallet Integrity**

```
Read all notes across all KeyVaults:
  → Compute document hashes, compare to stored hashes
  → Check template completeness (10 of N required docs present)
  → Calculate confidence score
  → Verify Merkle root covers all notes
```

### Phase C: Identity Contract Tests

**Scenario TW-8: Title Company as Identity**

```
Create Identity Contract for "Berkshire Title Services"
  → IdentityFactory.createIdentity()
  → Add 2 rivets: Jane (paralegal), Mike (title officer)
  → Both register public keys

Create Property Secret owned by the Identity (not ALICE's EOA)
  → Factory.createSovereignWalletAsNewborn(identityContract, ...)
  → Verify: owner = Identity contract

Both Jane and Mike can:
  → Read all KeyVaults (decrypt via Fat Key Package)
  → Write notes (via executeTransaction → writeData with EIP-1271)

Remove Mike (he quits):
  → removeRivet(mike)
  → Mike can no longer decrypt new Fat Key Packages
  → Mike's existing cached keys still work until they expire (known limitation)
```

**Scenario TW-9: Buyer as Identity (Married Couple)**

```
Create Identity for Steven & Judith Sprague
  → 2 rivets (husband's phone, wife's laptop)
  → Both can read buyer KeyVaults
  → Either can write post-closing notes
```

**Scenario TW-10: Cross-Property Intelligence**

```
Create 3 Property Secrets
  → Same Title Company Identity is team member on all 3
  → Same Seller Identity appears on 2 of them
  → Query: "find all properties where this seller Identity is a team member"
  → Verify: cross-property search returns 2 properties
  → This IS fraud detection: same seller selling 2 unrelated properties
```

---

## Part 3: Deployment Model

### Dashboard-First, Not Desktop-First

V1 of the Title Wallet is a **hosted web dashboard**, not a desktop app. Desktop V6 is powerful but requires installation, Windows, TPM, and IT support. A title company receptionist needs a URL, not an installer.

```
Desktop V6 (future)        Dashboard V1 (NOW)
─────────────────          ──────────────────
Install Electron           Open a URL
Configure TPM wallet       Log in with email
Manage local keys          Rootz manages keys (custodian)
Run own API server         Rootz hosts the API
Manage own IPFS keys       Rootz handles IPFS
Full sovereignty           Sovereignty available (opt-in)
```

**The path:** Start with hosted dashboard + custodian wallet. Title company sees zero crypto. When they're ready for full sovereignty, they install Desktop V6 and the Rootz custodian is removed. The data and contracts are the same — only the key management changes.

### Architecture: Dashboard V1

```
┌─────────────────────────────────────────────────────┐
│  TITLE COMPANY (any browser)                        │
│                                                     │
│  https://title.rootz.global                         │
│  ├── Login (email + password, or SSO)               │
│  ├── Upload closing documents                       │
│  ├── Review AI classifications                      │
│  ├── Add parties (buyer, seller, attorney, lender)  │
│  ├── Create wallet → distributes share links        │
│  ├── Portfolio view (all properties, scores)        │
│  └── AI assistant (MCP-powered chat)                │
│                                                     │
│  Users: Receptionist, Title Officer, Closer, Admin  │
│  Each user = rivet on the company Identity           │
└──────────────┬──────────────────────────────────────┘
               │ HTTPS
               ▼
┌─────────────────────────────────────────────────────┐
│  ROOTZ HOSTED SERVICE                               │
│                                                     │
│  API Server (Node.js)                               │
│  ├── Auth (email/password → session)                │
│  ├── Title Wallet API (create, upload, share)       │
│  ├── MCP Server (AI tools)                          │
│  ├── Document classifier (AI-powered)               │
│  └── Custodian Wallet Service                       │
│                                                     │
│  Custodian Wallet (per title company):              │
│  ├── Company Identity Contract on Polygon           │
│  ├── Company master key (HSM-secured)               │
│  ├── Per-employee rivets (derived from login)       │
│  ├── Credit balance (pre-funded by company)         │
│  └── REMOVABLE — company can take full custody      │
│                                                     │
│  Pinata (IPFS) — encrypted document storage         │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│  POLYGON MAINNET                                    │
│                                                     │
│  Factory Contract → deploys Property Secrets        │
│  Registry Contract → manages credits                │
│  Identity Factory → deploys company Identities      │
│  Property Secrets → one per property, forever       │
│                                                     │
│  Each closing: ~$0.05 in POL                        │
│  Each identity: ~$0.02 in POL (one-time)            │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│  IPFS (PINATA)                                      │
│                                                     │
│  All PDFs/scans stored encrypted                    │
│  VDN pattern hides storage location                 │
│  Content-addressed: can't be modified               │
│  Persists independently of Rootz or any company     │
└─────────────────────────────────────────────────────┘
```

### The Rootz Custodian Wallet Model

Rootz provides a **custodian wallet** for each title company. This is the training wheels that make the system accessible to non-technical offices.

#### What the Custodian Manages

| Function | Custodian Handles | Client Controls |
|---|---|---|
| Identity Contract | Rootz deploys and maintains | Client chooses company name, employees |
| Employee Rivets | Rootz derives from login credentials | Client manages employee list |
| Master Keys | Stored in Rootz HSM (not in browser) | Client can export at any time |
| Transaction Signing | Rootz signs on behalf of Identity | Client approves via dashboard UI |
| Credit Funding | Rootz handles POL ↔ credits | Client pays monthly or per-closing |
| IPFS Upload | Rootz manages Pinata account | Client uploads via dashboard |
| Gas Management | Rootz handles gas estimation + retry | Invisible to client |

#### What the Client Sees

```
"Welcome to Origin Title Wallet, Berkshire Title Services.
 
 Your account is active. Balance: 847 credits ($0.85 remaining).
 
 3 employees registered:
   Jane (paralegal) — last active: today
   Mike (title officer) — last active: yesterday
   Sarah (closer) — last active: 3 days ago
 
 12 property wallets created this month.
 Average confidence score: 0.86
 
 [New Closing]  [Portfolio]  [Add Employee]  [Buy Credits]"
```

No wallet addresses. No gas. No ECDH. No KeyVaults. Just documents, people, properties, and a score.

#### Sovereignty Progression — Removing the Custodian

The custodian is removable. At any point, the title company can graduate to full self-custody:

| Level | What They Run | What Rootz Does | Recovery |
|---|---|---|---|
| **L0: Full Custodian** (default) | Browser dashboard | Everything | Rootz recovers keys |
| **L1: Key Export** | Browser + backed-up keys | Transactions, hosting | Client has backup, Rootz has copy |
| **L2: Desktop Hybrid** | Desktop V6 + dashboard | Hosting, IPFS | Client has primary keys, Rootz has backup |
| **L3: Full Sovereignty** | Desktop V6, own infrastructure | Nothing — Rootz custodian removed | Client is fully self-sovereign |

**The critical design point:** Moving from L0 to L3 changes NOTHING on-chain. The same Identity contract, the same Property Secrets, the same KeyVaults, the same Notes. Only the key management changes. The data is portable because it was always on Polygon and IPFS — never locked to Rootz servers.

#### How Custodian Removal Works

```
Title Company: "We want to manage our own keys."

Step 1: Rootz exports all keys for the company's Identity
  → Company master key (encrypted with company-chosen password)
  → All rivet private keys (or derivation seeds)
  → All Property Secret KV keys the company holds
  → Export is a single encrypted file (or QR code set)

Step 2: Company installs Desktop V6 (or any compatible client)
  → Imports the key file
  → Desktop V6 now holds all keys locally (TPM-secured)

Step 3: Company removes Rootz as custodian
  → On the Identity contract: remove Rootz's custodian rivet
  → Rootz can no longer sign transactions for this Identity
  → Rootz deletes its copy of the company's keys

Step 4: Company operates independently
  → All existing Property Secrets still work
  → All team members still have their keys
  → Company signs their own transactions via Desktop V6
  → IPFS documents are still accessible (content-addressed, no dependency)
  → Rootz has no access to anything — clean separation

The inverse also works: if the company's Desktop crashes,
they can re-enable Rootz as custodian (add Rootz rivet back
to their Identity) to restore hosted operations while they recover.
```

### First Deployment: Title Company Onboarding (Dashboard V1)

```
Day 0: Setup (15 minutes)
  1. Company signs up at title.rootz.global
  2. Rootz creates Identity Contract (custodian-managed)
  3. Company admin adds employees (email invites)
  4. Each employee creates login → becomes rivet on company Identity
  5. Company funds account ($50 → covers ~1,000 closings)
     (Credit card or POL deposit — Rootz handles conversion)

Day 1: First Closing
  6. Receptionist logs in, clicks "New Closing"
  7. Drops closing documents (PDFs/scans)
  8. AI classifies documents, flags missing items
  9. Receptionist adds parties (buyer email, seller email, attorney, lender)
  10. Clicks "Create Wallet" → system handles everything
  11. Share links emailed to each party automatically
  12. QR code generated for deed (download/print)

Day 2-30: Iterate
  13. Do 10 closings to build confidence
  14. AI learns the company's document patterns
  15. Post-closing: recording confirmations arrive, added as notes
  16. Portfolio view: all properties, confidence scores, completeness
  17. Run fraud check on next seller — cross-property detection works

Nothing to install. Nothing to configure. Nothing to maintain.
```

### Multi-Office / Multi-Company

```
Company A (Pittsfield): Dashboard login → Identity A on Polygon
Company B (Boston):     Dashboard login → Identity B on Polygon
Company C (Worcester):  Dashboard login → Identity C on Polygon

All three share the same:
  → Rootz-hosted dashboard and API
  → Factory contract on Polygon
  → IPFS document storage
  → Co-op network (cross-company search when opted in)

Employees transfer between companies:
  → Remove from Company A employee list
  → Add to Company B employee list
  → Identity rivets updated automatically by custodian
```

### Dashboard vs Desktop: When Each Makes Sense

| | Dashboard (V1) | Desktop (V2+) |
|---|---|---|
| **Best for** | First 100 customers | Power users, high-volume firms |
| **Setup time** | 15 minutes | 2-4 hours |
| **Key management** | Rootz custodian | Self-sovereign (TPM) |
| **IT requirements** | Browser | Windows + admin access |
| **Recovery** | Rootz recovers | Self-managed (with custodian backup option) |
| **Offline** | No | Yes (SQLite archive) |
| **Cost** | $5/wallet + hosting | $5/wallet (self-hosted) |
| **AI assistant** | Cloud MCP | Local MCP + cloud |
| **Compliance** | Rootz SOC2 covers keys | Company manages own compliance |
| **Migration** | → Desktop anytime | ← Dashboard fallback anytime |

---

## Part 4: Recovery Scenarios

### Scenario R1: Employee Leaves

```
Mike (title officer) leaves Berkshire Title.

Action:
  → removeRivet(mike) on company Identity
  → Mike's device can no longer decrypt NEW Fat Key Packages
  → Mike's cached keys for existing properties remain valid until they expire
  
Mitigation:
  → Write authorizations have expiresAt timestamps
  → Set short expiry (30 days) for employee write authorizations
  → After 30 days, Mike cannot write to any property
  → Mike can still read properties he already had keys for (this is intentional —
    he was the closer on those deals, his attestation is on the record)
  
If Mike is terminated for cause:
  → Create new KeyVaults on sensitive properties
  → Rotate KV keys (new KeyVault, re-encrypt, migrate notes)
  → Expensive but possible for high-risk situations
```

### Scenario R2: Company Closes / Attorney Retires

```
Berkshire Title Services closes its doors.

What happens to the property wallets?
  → Nothing. They are on Polygon. They persist independently.
  → The Property Secrets still exist — owned by the company Identity
  → KeyVaults are still readable by all team members with keys
  → Buyer's keys still work. Seller's keys still work. Lender's keys still work.
  → The data is on IPFS. The proof is on Polygon. Neither depends on Berkshire Title.

What about the company Identity?
  → If the principal retains the Identity private key, they can still access everything
  → If the Identity key is lost, the properties are unaffected (team members have their own keys)
  → The Identity becomes orphaned but the data it created is permanent

What about future title searches?
  → The KV-PUBLIC KeyVault on each property is accessible via QR code on the deed
  → A new title company searching the property reads KV-PUBLIC
  → Chain of title, deed, attestation — all there, all verifiable
  → The new title company becomes a new team member (via co-op network or direct request)
```

### Scenario R3: Buyer Loses Keys

```
Steven Sprague loses his phone, forgets his wallet, can't access property wallet.

Path 1 — Rootz Custodian (Dashboard V1 — most common):
  → Steven logs into title.rootz.global with email + password
  → Rootz custodian still holds his key material
  → He resets password, creates new session, access restored
  → Zero crypto knowledge required. Works like any web account.

Path 2 — Multi-device (Identity contract):
  → If Steven had an Identity with 2 rivets (phone + laptop)
  → Laptop rivet still has access
  → Add new phone as replacement rivet
  → Bootstrap sync transfers all keys to new device

Path 3 — Single device, no custodian (self-sovereign, EOA wallet):
  → Steven's keys are gone
  → BUT: Title Company still has ADMIN access
  → Title Company can re-share KV keys with Steven's new wallet
  → Steven creates new wallet, Title Co adds him as team member again
  → He gets access to his authorized KeyVaults on his new wallet

Path 4 — Everything lost (no custodian, no Title Company):
  → Steven lost keys AND Title Company closed AND no custodian
  → KV-PUBLIC still readable via QR code (deed, chain of title, attestation)
  → Private documents require reputation-based recovery (see R5)

Lesson: The Rootz custodian makes recovery trivial for 99% of users.
Power users who remove the custodian accept responsibility for their own
key management — but even they have the Title Company as a backup path.
```

### Scenario R4: Lender Assigns Mortgage

```
Lenox National Bank sells the mortgage to Flagstar Bank.

Action:
  → Lenox sends Fat Key Package to Flagstar's Identity contract
  → Flagstar becomes team member on the Property Secret
  → Flagstar's rivets (loan officers) can read KV-MORTGAGE, KV-TITLE, etc.
  → Lenox retains VIEWER access (record of their origination)
  → Assignment document added as Note to KV-MORTGAGE

The SVB scenario (99 Bedford St):
  → SVB collapses → FDIC takes receivership
  → FDIC Identity receives Fat Key Packages for all SVB-originated mortgages
  → FDIC → First-Citizens assignment: Fat Key Package transfer
  → Each step is recorded as a Note on each property
  → The chain of custody is verifiable, not reconstructed after the fact
```

### Scenario R5: Catastrophic Key Loss — Recovery Ladder

```
Recovery has 4 levels, from easiest to hardest:

Level 1 — Rootz Custodian (Dashboard users):
  → User resets password via email
  → Custodian re-derives rivet keys from new credentials
  → Access restored in minutes
  → This covers 99% of recovery scenarios for Dashboard V1 users

Level 2 — Rootz Custodian for the Title Company:
  → Even if the individual lost access, the Title Company's custodian
    wallet still has ADMIN access to all their Property Secrets
  → Title Company re-adds the individual as a team member
  → Rootz custodian executes the addTeamMember transaction

Level 3 — Title Company Re-Shares (no custodian):
  → Self-sovereign company, but they still have their keys
  → They re-share KV keys with the individual's new wallet
  → Standard team management flow

Level 4 — Reputation-Based Recovery (total loss):
  → All keys lost. No custodian. No Title Company access.
  → Three qualified parties must attest:
    1. Licensed attorney (3+ years, Bar number verified)
    2. Licensed title company (2+ years, state license verified)
    3. Deed-verified property owner (current owner via recorded deed)
  → 7-day waiting period (all existing team members notified)
  → If no objection, new KeyVault keys generated
  → New owner gets fresh access to KV-PUBLIC + new owner KV
  → Private historical documents (prior wire instructions) remain sealed

Design principle: The custodian exists so that Level 4 almost never happens.
For Dashboard V1 users, Level 1 handles everything. Level 4 is the safety
net for fully self-sovereign users who lose everything.

The client can always add Rootz back as custodian (add rivet to Identity)
if they want the safety net after previously removing it.
```

### Scenario R6: Property Sells Again (Second Transaction)

```
111 Swamp Rd sells from Sprague to new buyer Johnson in 2030.

The wallet grows — it doesn't restart:

  1. New Title Company (if different) becomes team member
     → Gets ADMIN role via co-op network or direct introduction
     
  2. New closing adds new KeyVaults:
     → KV-SETTLEMENT-2030 (new closing disclosure)
     → KV-MORTGAGE-2030 (new loan)
     → KV-WIRE-2030 (new wire instructions)
     
  3. New team members added:
     → Johnson (buyer) Identity → new MEMBER
     → Sprague (now seller) → role stays MEMBER, gets KV-SETTLEMENT-2030(seller) access
     → New lender Identity → new MEMBER
     
  4. Sprague's original access:
     → Retains read access to KV-PUBLIC, KV-DISCLOSURE, KV-SETTLEMENT-2000(buyer)
     → Loses write authorization (expired)
     → Their attestation from 2000 closing is permanent
     
  5. Johnson inherits:
     → Complete chain of title (KV-PUBLIC from both 2000 and 2030)
     → All public documents from prior closings
     → Their own private documents for the 2030 closing

  6. The next title search:
     → Reads 2 transaction layers in KV-PUBLIC
     → Chain of title: Harrington → Foster → Sprague → Johnson
     → 25 years of accumulated Notes from multiple independent signers
     → Confidence score: 0.95+ (deep provenance)
```

---

## Part 5: AI-Assisted Operations

### The User: A Non-Technical Title Office

The system must work for a receptionist with zero blockchain or crypto knowledge. The AI handles everything — the user handles documents and decisions.

### Workflow: AI-Assisted Closing

```
┌─────────────────────────────────────────────────────┐
│  RECEPTIONIST'S SCREEN                              │
│                                                     │
│  "New Closing: 111 Swamp Rd, Richmond"              │
│                                                     │
│  [ Drop closing documents here ]                    │
│                                                     │
│  AI: "I found 32 documents in this package.         │
│       Here's what I identified:                     │
│                                                     │
│       ✓ Deed (Quitclaim) .......... deed-549232.pdf │
│       ✓ Closing Disclosure ........ cd-buyer.pdf    │
│       ✓ Closing Disclosure ........ cd-seller.pdf   │
│       ✓ Lead Paint Notification ... lead-paint.pdf  │
│       ✓ Smoke Detector Cert ...... smoke-cert.pdf   │
│       ✓ Title Certification ...... title-cert.pdf   │
│       ⚠ Unclassified ............. misc-page-7.pdf  │
│       ✗ Missing: CO Detector Certificate            │
│       ✗ Missing: Municipal Lien Certificate         │
│                                                     │
│       2 documents are missing. The closing cannot    │
│       be completed without them.                    │
│                                                     │
│       [Classify Unidentified] [Continue Anyway]     │
│       [Request Missing Docs]                        │
│                                                     │
│  Parties:                                           │
│   Buyer: Steven Sprague  [Invite]                   │
│   Seller: John Foster    [Invite]                   │
│   Attorney: Bob Anderson [Invite]                   │
│   Lender: Lenox National [Invite]                   │
│                                                     │
│  [Create Wallet]                                    │
└─────────────────────────────────────────────────────┘
```

### What the AI Does Behind the Scenes

| User Action | What AI Does | What's on Blockchain |
|---|---|---|
| Drops 32 PDFs | Classifies each by type (deed, CD, lead paint...) using document analysis | Nothing yet |
| Clicks "Create Wallet" | Deploys Property Secret, creates KeyVaults, uploads PDFs to IPFS, writes 32 Notes | Factory deploy, 8 createKeyVault, 32 writeData |
| Clicks "Invite" on Buyer | Creates team member, generates share link, sends email/SMS with QR code | addTeamMember event |
| Types "Who owns 111 Swamp Rd?" | Reads KV-PUBLIC, returns chain of title | ChainReader query |
| Types "Is this property clean?" | Runs confidence score + fraud pattern detection | Read-only analysis |
| Types "Add the CO certificate" | Classifies PDF, writes Note to KV-PUBLIC | 1 writeData |

### MCP Tools for the AI

The AI assistant (Claude, GPT, any MCP-compatible model) uses the existing MCP server to operate the system:

```
Title Wallet MCP Tools:

create_property_wallet     — Deploy Secret + KeyVaults + upload all docs
  Input: closing package JSON + PDFs
  Output: property ID, share links, confidence score

classify_document          — AI identifies document type from PDF content
  Input: PDF file
  Output: { type: "deed", confidence: 0.95, details: "Quitclaim, 3 pages" }

add_party                  — Add team member to property
  Input: property ID, party name, role, contact (email/phone)
  Output: share link, invitation sent

get_property_status        — Full wallet summary
  Input: property ID or address
  Output: docs present/missing, confidence, parties, events

add_document               — Write a single document to the wallet
  Input: property ID, document type, PDF
  Output: note written, confidence updated

check_closing_completeness — Compare against template
  Input: property ID, template (residential/commercial/refinance)
  Output: checklist with ✓/✗ for each required document

get_party_view             — What a specific party can see
  Input: property ID, party share key
  Output: list of their authorized documents

search_properties          — Find wallets by address, party, or document
  Input: search query
  Output: matching properties with summaries
```

### AI-Assisted Fraud Detection

```
Receptionist: "Run a check on this seller before we close."

AI: "Checking John Foster across the network...

     Properties found: 2
     
     1. 111 Swamp Rd, Richmond (this closing)
        Role: Seller
        Status: Normal
     
     2. 45 Main St, Lenox
        Role: Seller
        Filed: 3 weeks ago
        Status: ⚠ FLAGGED — Selling 2 properties within 30 days
        
     The 30-day dual-sale pattern is a known fraud indicator.
     Recommend: Verify seller identity independently before proceeding.
     
     Notary on 45 Main St deed: Maria Sorrento (MA commission #12345)
     Commission status: ACTIVE (verified against Secretary of State)
     
     Notary on this deed: Same notary. No anomaly."
```

### Training Plan for Title Office Staff

| Week | What They Learn | What They Do |
|---|---|---|
| 1 | Upload closing docs, read AI classifications | 5 practice closings (test properties) |
| 2 | Review AI completeness checks, request missing docs | 5 real closings with supervision |
| 3 | Distribute share links to parties, handle party questions | Handle buyer/seller questions about accessing their docs |
| 4 | Run fraud checks, read confidence scores | Independent operation with AI assistant |

**The key insight:** The user never sees blockchain, wallets, encryption, IPFS, or KeyVaults. They see: documents, parties, a completeness checklist, and a confidence score. The AI translates between human workflow and cryptographic infrastructure.

---

## Part 6: Test Environment Maintenance

### Keep the Dev Environment Running

```
rootz-v6/
├── config/
│   └── mainnet.json       ← Production contracts (DON'T CHANGE)
├── .env.test              ← Test wallet mnemonics (KEEP FUNDED on mainnet)
├── packages/              ← V6 packages (npm test --workspaces)
├── apps/desktop-v6/       ← Desktop app (npm run dev) — V2+ path
└── land-records/
    └── title-wallet/      ← Title wallet integration code
```

### Monthly Maintenance

| Task | Why | How |
|---|---|---|
| Check test wallet balances | Mainnet POL for test closings | Top up if below 0.5 POL (~$0.25) |
| Run `npm test --workspaces` | Catch regressions | CI or manual monthly |
| Check Etherscan API key | Keys expire | Regenerate if tests fail with 403 |
| Verify Pinata API keys | Keys rotate | Check IPFS upload still works |
| Check dashboard hosting | Uptime | Monitor title.rootz.global |

### Session Recovery Prompt

When starting a new dev session, use this bootstrap:

```
Project: Origin Title Wallet — V6 Integration (Dashboard V1)
Working directory: rootz-v6/

Read first:
  land-records/docs/DESIGN-title-wallet-v6.md (v2) — Architecture
  land-records/docs/PLAN-title-wallet-integration.md (v2) — This plan
  packages/api/tests/TEST_PLAYBOOK.md — 8 test scenarios
  packages/integration/src/client.ts — RootzClient API
  land-records/docs/PRODUCT-TITLE-WALLET.md — Product spec

What's built:
  - 27 V6 packages, all tested
  - Desktop V6 app on port 3020 (V2 path, not V1)
  - MCP server on port 3035 (land records, 9 tools)
  - Prototype title wallet on port 3036 (standalone, NOT V6-integrated)

V1 model: Dashboard-first (hosted by Rootz) + custodian wallet
  - Title companies use a browser, not a desktop app
  - Rootz manages keys (custodian model)
  - Client can remove Rootz custodian when ready for sovereignty
  - All testing on Polygon mainnet (not testnet)

Next: Build the hosted dashboard API that wraps @rootz/integration
      with the custodian wallet model.
```

---

## Summary: What to Do Next

1. **Verify V6 dev environment** — build, test, confirm mainnet connectivity
2. **Run TEST_PLAYBOOK scenarios 1-8 on mainnet** — prove the infrastructure works (~$0.50 total cost)
3. **Build custodian wallet service** — server-side key management wrapping @rootz/integration
4. **Build dashboard API** — auth, closing upload, wallet creation, party management, portfolio
5. **Build dashboard frontend** — web UI for title office staff (upload, classify, share, portfolio)
6. **Test scenarios TW-1 through TW-10 on mainnet** — full title wallet flow with real contracts
7. **Build AI-assisted document classifier** — MCP tools for closing document identification
8. **Deploy title.rootz.global** — first hosted customer
9. **Onboard first title company** — Tracie's recommendation, 10 closings
10. **Iterate** — Tracie finds the gaps, we fix them

---

*The test infrastructure exists. The contracts are deployed. The packages are tested. We don't need a testnet — mainnet is cheaper than the time cost of debugging testnet differences. We don't need a desktop app — a dashboard with a custodian wallet gets title companies running in 15 minutes. Sovereignty is always available when they're ready for it.*
