# Origin Title Wallet — Data Room Section Plan

## Overview

11 sections (SECRET-0 through SECRET-10), organized in 3 tiers for progressive disclosure. Two audiences: title companies (customers) and investors (evaluating the vertical).

Uses the same infrastructure as the Rootz Corp investor data room: signed secrets on Polygon, IPFS storage, YAML frontmatter, AI Presentation Guides, bridge notes, and the same `data-room.html` viewer.

---

## Section Plan

### SECRET-0: Root — Data Room Navigation
- **Tier:** — (root)
- **Audience:** Both
- **Description:** Navigation hub with table of contents, tier groupings, cross-links
- **Content:** Company intro, section table, how the data room works, contact info
- **AI Guide:** Navigation strategy per audience type (title co vs investor path)
- **Status:** WRITTEN

### SECRET-1: Executive Summary
- **Tier:** 1
- **Audience:** Both
- **Description:** The opportunity in 2 minutes — problem, product, economics, traction, vision
- **Content:** Problem statement, product overview, cost comparison table, competitive matrix, what's built, vision phases
- **AI Guide:** 90-second pitch, then audience detection question. Objection handling for "too high savings", "just another PropTech", "CoreLogic already does this", "is this legal?"
- **Status:** WRITTEN

### SECRET-2: How Title Works Today
- **Tier:** 1
- **Audience:** Title Companies
- **Description:** The broken system — what a title search actually involves
- **Content:** Step-by-step walkthrough of a manual title search, time breakdown, pain points, cost structure, what masslandrecords.com actually looks like (ASP.NET WebForms, zero API), the filing cabinet problem
- **AI Guide:** Validate the prospect's daily experience. Don't lecture — they know their workflow. Show that you understand it. Then pivot to "what if this were different?"
- **Status:** TO WRITE

### SECRET-3: The Origin Title Wallet — Product Overview
- **Tier:** 1
- **Audience:** Both
- **Description:** How the wallet works — closing workflow, encryption, QR code, trust levels
- **Content:** 5-step closing workflow, access control matrix, trust levels 1-5, confidence scoring with real test data, automatic title plant, key recovery, software integration, MCP tools
- **AI Guide:** Walk through the workflow concretely. Objection handling for key loss, blockchain complexity, company risk, document management overlap
- **Status:** WRITTEN

### SECRET-4: ROI Calculator
- **Tier:** 2
- **Audience:** Title Companies
- **Description:** Cost savings with real numbers — by company size, by year, compound effect
- **Content:** Current cost breakdown, year-over-year savings projection, pricing tiers, what you share vs keep, scaling by company size, revenue replacement table, compound effect, 111 Swamp Rd case study
- **AI Guide:** Lead with numbers immediately. Adjust for prospect's volume. Objection handling for "too high", "salaried searchers", "no Warren Group", "transition period"
- **Status:** WRITTEN

### SECRET-5: Fraud Detection
- **Tier:** 2
- **Audience:** Both
- **Description:** Cross-property intelligence from insider knowledge — 5 fraud vectors
- **Content:** Verification gap, broken notary system ($12 Amazon stamps), cross-property patterns, wire fraud ($1.4B), title chain anomalies (291 North Plain), institutional collapse (99 Bedford/SVB), confidence scoring breakdown, MCP fraud tools
- **AI Guide:** Lead with the verification gap — registries don't verify. Let the title professional react. Objection handling for "we catch fraud manually", "creates liability", "wire fraud is the bank's problem"
- **Status:** WRITTEN

### SECRET-6: Co-Op Network Model
- **Tier:** 2
- **Audience:** Title Companies
- **Description:** How title companies join, what they share, what they keep, governance
- **Content:** Network tiers (Solo/Member/Contributor), what's shared vs private, governance model, how the verification layer works, network growth projections, incentive alignment
- **AI Guide:** Address the trust question head-on. Title companies are competitors — why would they share? Answer: they share only public records + attestations. They keep everything confidential. The more you share, the less you pay. Designed by a title attorney.
- **Status:** TO WRITE

### SECRET-7: Market & Competition
- **Tier:** 2
- **Audience:** Investors
- **Description:** $20B industry analysis, competitive matrix, defensibility
- **Content:** Market sizing (MA → national), title insurance economics, Warren Group/CoreLogic/CertifID/Qualia comparison, competitive moat analysis, network effects, AI accessibility as differentiator
- **AI Guide:** Frame as "here's why nobody has done this" — the data was trapped in inaccessible interfaces. We made it AI-readable. Then show the competitive matrix. Nobody else has all five: integrity + encryption + permanent record + AI access + co-op network.
- **Status:** TO WRITE

### SECRET-8: Traction & Proof
- **Tier:** 2
- **Audience:** Investors
- **Description:** What's already built and working — 8 properties, 9 MCP tools, live integrations
- **Content:** Component status table, test property results with actual data, MCP tool list, MassGIS integration, assessor data, document pipeline, Florida feasibility, AI cost analysis ($0.026/property)
- **AI Guide:** This is the "it's real" section. Don't say "we plan to build" — say "it's running on port 3035 right now." Walk through the test properties with actual record counts. Show the confidence scoring on real data.
- **Status:** TO WRITE

### SECRET-9: Legal & Licensing Foundation
- **Tier:** 3
- **Audience:** Both
- **Description:** MA public records law, Feist v. Rural, data tier analysis
- **Content:** MGL c. 66 §10 analysis, Feist v. Rural (SCOTUS), 3-tier data classification (free/request/restricted), strategy for each tier, precedent from Warren Group/CoreLogic/ATTOM/LexisNexis
- **AI Guide:** Lead with the bottom line: "Massachusetts law is strongly in our favor." Then walk through the tiers. Objection handling for "what about Tyler Technologies' website?", "what about court records?", "has anyone challenged this?"
- **Status:** TO WRITE

### SECRET-10: Technical Architecture
- **Tier:** 3
- **Audience:** Both
- **Description:** Wallet schema, encryption model, MCP server, confidence algorithm, SSL provenance
- **Content:** Wallet JSON schema, encryption architecture (per-party AES-GCM + Polygon key management), MCP server architecture, confidence scoring algorithm, SSL provenance capture, Merkle tree per property, on-chain anchoring model
- **AI Guide:** For title companies: skip the crypto details, focus on "your data is safe and permanent." For investors/technologists: go deep on the encryption model, the confidence algorithm, and the Polygon/IPFS architecture.
- **Status:** TO WRITE

---

## Viewer MANIFEST

For `data-room.html`, the sections array:

```javascript
const MANIFEST = [
  // Tier 1 — Introduction
  { id: 'exec-summary',    label: 'Summary',     tier: 1, file: 'SECRET-1-executive-summary.md' },
  { id: 'title-today',     label: 'Today',       tier: 1, file: 'SECRET-2-how-title-works-today.md' },
  { id: 'product',         label: 'Product',      tier: 1, file: 'SECRET-3-product-overview.md' },

  // Tier 2 — Engagement
  { id: 'roi',             label: 'ROI',          tier: 2, file: 'SECRET-4-roi-calculator.md' },
  { id: 'fraud',           label: 'Fraud',        tier: 2, file: 'SECRET-5-fraud-detection.md' },
  { id: 'network',         label: 'Network',      tier: 2, file: 'SECRET-6-coop-network.md' },
  { id: 'market',          label: 'Market',       tier: 2, file: 'SECRET-7-market-competition.md' },
  { id: 'traction',        label: 'Traction',     tier: 2, file: 'SECRET-8-traction-proof.md' },

  // Tier 3 — Due Diligence
  { id: 'legal',           label: 'Legal',        tier: 3, file: 'SECRET-9-legal-licensing.md' },
  { id: 'architecture',    label: 'Architecture', tier: 3, file: 'SECRET-10-technical-architecture.md' },
];
```

### Tab labels (short, for navigation):
Summary | Today | Product | ROI | Fraud | Network | Market | Traction | Legal | Architecture

### Tier grouping in viewer:
- **Introduction** (Tier 1): Summary, Today, Product
- **Engagement** (Tier 2): ROI, Fraud, Network, Market, Traction
- **Due Diligence** (Tier 3): Legal, Architecture

---

## Cross-Linking Strategy

### Title Wallet → Rootz Investor Data Room

1. **Bridge note on SECRET-0 (title wallet root):**
   ```
   NOTE: Parent — Rootz Corp Investor Data Room
   Address: [rootz-investor-data-room-root-address]
   "This title wallet is a deployed vertical of the Rootz platform.
   Full company, platform, and investment terms in the parent data room."
   ```

2. **Footer on SECRET-1 and SECRET-7:**
   Include a "Platform" section noting that Origin Title Wallet runs on Rootz infrastructure, with a reference to the investor data room for full company details.

3. **SECRET-8 (Traction):**
   List other Rootz verticals (Origin SEC Registry, ReefRootz, Cook's Garage, Archive) to show the platform is proven across multiple use cases.

### Rootz Investor Data Room → Title Wallet

1. **Bridge note on investor SECRET-0:**
   ```
   NOTE: Vertical — Origin Title Wallet
   Address: [title-wallet-data-room-root-address]
   Tier: 2
   "Deployed vertical: $20B title insurance industry. Working MCP
   server, 8 properties, 500+ records. Full product data room."
   ```

2. **Update investor SECRET-4 (Product Lines):**
   Add the title wallet as a product line with status, metrics, and link to the title wallet data room.

3. **Update investor SECRET-5 (Traction):**
   Add title wallet traction metrics (properties indexed, MCP tools, Florida feasibility).

### Navigation Flow

**Title company prospect path:**
```
Title Wallet Root → Summary → Product → ROI → (convinced?)
    → Fraud → Network → (wants deeper?) → Legal → Architecture
    → (wants company context?) → Bridge to Rootz Investor Data Room
```

**Investor path:**
```
Rootz Investor Root → Product Lines → (sees title wallet)
    → Bridge to Title Wallet Data Room → Summary → Market → Traction
    → ROI → (wants technical?) → Architecture
    → (back to company?) → Bridge to Rootz Investor Data Room
```

Both paths are navigable by AI agents following bridge notes. A single question — "tell me about the title wallet" — traverses from either starting point to the relevant content.

---

## File Inventory

| File | Status | Size Target |
|------|--------|------------|
| SECRET-0-root.md | WRITTEN | ~3KB |
| SECRET-1-executive-summary.md | WRITTEN | ~8KB |
| SECRET-2-how-title-works-today.md | TO WRITE | ~5KB |
| SECRET-3-product-overview.md | WRITTEN | ~9KB |
| SECRET-4-roi-calculator.md | WRITTEN | ~8KB |
| SECRET-5-fraud-detection.md | WRITTEN | ~10KB |
| SECRET-6-coop-network.md | TO WRITE | ~6KB |
| SECRET-7-market-competition.md | TO WRITE | ~7KB |
| SECRET-8-traction-proof.md | TO WRITE | ~6KB |
| SECRET-9-legal-licensing.md | TO WRITE | ~5KB |
| SECRET-10-technical-architecture.md | TO WRITE | ~8KB |
| DATA-ROOM-PLAN.md | THIS FILE | — |
