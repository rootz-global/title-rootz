# Rootz + PRINTgenie: AI-Powered Farming to Automated Outreach

**Partnership Brief — May 2026**
**Steven Sprague, Rootz Corp | Andy Detwiler, PRINTgenie**

---

## The Proposition

Combine Rootz's AI property intelligence (10.8M Florida parcels, courthouse records, distress signals) with PRINTgenie's automated multi-channel marketing (mail, email, SMS) to give real estate agents and title reps a single tool that does two things:

1. **Find the right properties** — AI-powered search across ownership history, courthouse events, property values, and demographics
2. **Reach the right people** — One-click handoff to automated, personalized outreach campaigns

No other tool on the market connects live courthouse signal detection directly to automated mailing execution.

---

## How It Works

### The Agent Experience

An agent opens the Rootz farming app and types a natural-language query:

> "Show me homes in Coral Springs owned more than 10 years, over $500K, with a recent probate or foreclosure filing"

The AI searches 10.8M parcels and returns scored results:

| Address | Owner | Value | Owned Since | Signal | Score |
|---------|-------|-------|-------------|--------|-------|
| 4521 NW 93 Way | MARTINEZ, ELENA T | $625K | 2012 | Probate (Jan 2026) | 87 |
| 1180 N University Dr | JOHNSON FAMILY TRUST | $890K | 2008 | Lis Pendens (Nov 2025) | 82 |
| 7513 NW 47 Dr | WILLIAMS, ROBERT | $540K | 2014 | Death Certificate (Sep 2025) | 79 |

The agent reviews the results, selects the properties they want to target, and clicks **"Send to PRINTgenie"**.

That's it. PRINTgenie takes over — the campaign launches automatically with personalized messaging based on the property situation (probate vs. foreclosure vs. long-term owner).

### Data Flow

```
Rootz Farming App (AI search + scoring)
        |
        v
   Agent selects targets
        |
        v
   "Send to PRINTgenie" (API call)
        |
        v
PRINTgenie Campaign Engine
   - Direct mail (postcard/letter)
   - Email sequence
   - SMS follow-up
        |
        v
   Agent dashboard (Rootz side)
   - Properties sent
   - Campaign status
   - Response tracking
```

---

## What Rootz Brings to the Table

### Data Already Live

- **10.8M Florida parcels** — all 67 counties, FL Department of Revenue
- **1.2M Ohio parcels** — Franklin, Cuyahoga, Hamilton counties
- **Courthouse records** — Broward + Miami-Dade County Clerks:
  - Foreclosure / Lis Pendens
  - Probate filings
  - Liens and satisfactions
  - Death certificates
  - Deed transfers
- **Owner mailing addresses** — from DOR records (where they receive their tax bill)
- **Property details** — assessed value, year built, living area, lot size, homestead status, use code
- **Ownership duration** — last two sale dates and prices
- **FEMA flood zones** — every parcel
- **Building permits** — Broward + Miami-Dade (466K records)
- **Census demographics** — median income, population, home values by block group
- **School ratings** — nearest schools with GreatSchools data
- **Market economics** — FRED median price, inventory, days on market, unemployment

### AI Search Capabilities

The farming AI can answer queries like:

- "Absentee owners in Hollywood with liens over $400K"
- "Corporate-owned properties in Pembroke Pines with foreclosure activity"
- "Homes in 33019 zip code owned 15+ years with no homestead exemption"
- "All probate filings in Fort Lauderdale this quarter, sorted by property value"
- "Properties within 1 mile of 100 Las Olas Blvd that changed hands in the last 6 months"

Each result includes the owner's mailing address — the minimum data PrintGenie needs to send a piece of mail.

### What We Can Add

**Skip Trace** (phone + email): Partner with a data provider to append contact info to the mailing address. Agent pays per lookup. This enables PRINTgenie's email and SMS channels.

**Title Detail**: Agents can pay to pull full title chain for any property. Revenue share opportunity.

---

## What PRINTgenie Brings

- Automated direct mail production and delivery
- Email campaign sequencing
- SMS outreach
- Template library tuned for real estate (probate letters, foreclosure outreach, investor marketing)
- Campaign tracking and response metrics
- Existing billing infrastructure (per-piece pricing)

---

## Revenue Model

### For the Agent

| Service | Who Bills | Approximate Cost |
|---------|-----------|-----------------|
| Rootz AI Search | Rootz | $29-99/month (tiered) |
| Direct mail per piece | PRINTgenie | Per PRINTgenie pricing |
| Email/SMS campaigns | PRINTgenie | Per PRINTgenie pricing |
| Skip trace (phone/email) | Rootz | $0.05-0.15/record |
| Title detail pulls | Rootz | TBD per-pull |

### For the Partners

- **Rootz** earns from subscriptions + skip trace + title detail markup
- **PRINTgenie** earns from mailing volume driven by Rootz-sourced leads
- **Distribution partners** (Stephanie's network) earn referral commissions
- **Volume scales naturally**: More agents using Rootz = more addresses flowing to PRINTgenie

---

## Integration: What We Build

### Phase 1: Pilot (30 days)

**Minimum integration — CSV handoff:**
- Agent uses Rootz /farm AI to find targets
- Agent clicks "Export to PRINTgenie" — downloads CSV with: name, address, city, state, zip, property value, signal type, farming score
- Agent uploads CSV to PRINTgenie and selects a campaign template
- Both systems track which properties were sent

This works with zero API integration. Validates the model immediately.

### Phase 2: API Integration (30-60 days)

**Direct API connection:**
- "Send to PRINTgenie" button in the Rootz UI calls PRINTgenie API
- Properties flow directly — no CSV, no manual upload
- Agent sees campaign status in Rootz dashboard
- PRINTgenie templates are pre-configured per signal type:
  - Probate → sympathy + "we can help with the property" letter
  - Foreclosure → "options before auction" postcard
  - Long-term owner → "your home has appreciated significantly" mailer
  - Absentee → "are you considering selling your investment property?" card

**Authentication:** Simple API key exchange. Rootz authenticates the agent, passes their PrintGenie account ID with each API call.

### Phase 3: Automated Campaigns

- Agent defines a farm area + criteria in Rootz ("Coral Springs, probate + foreclosure, $300K+")
- When new courthouse filings match, Rootz automatically sends to PRINTgenie
- Campaign fires without agent intervention — true event-driven marketing
- Agent gets a weekly digest of what was sent

---

## Pilot Plan

**Target**: 3-5 agents from Stephanie's network
**Timeline**: 60 days
**Phase 1 goal**: Validate that agents will pay for AI-powered farming + mailing in a single workflow

### Week 1-2: Onboarding
- Set up agent accounts on Rootz (Pro tier, $49/mo)
- Walk through the AI farming tool — show them the queries
- Each agent identifies their farming area (city, zip, or neighborhood)

### Week 3-4: First Campaigns
- Agent runs AI search → selects top 50-100 prospects → exports to PRINTgenie
- First mail drops
- Collect feedback on: query quality, data accuracy, ease of use

### Week 5-8: Measure + Iterate
- Track: mail sent, responses received, listings obtained
- Refine: which signals produce the best response rates
- Decision: proceed to Phase 2 API integration

### Success Metrics
- Each agent sends at least 2 campaigns (100+ pieces each)
- At least 1 listing attributable to the tool
- Agent willingness to continue paying after pilot

---

## Why This Wins

**For the agent**: One tool replaces three. Today they use a farming tool (Vulcan7, REDX, PropStream), a mailing service (PRINTgenie, Wise Pelican), and manual courthouse research. Rootz + PRINTgenie is all of that in one conversation.

**For PRINTgenie**: Every Rootz agent becomes a PRINTgenie customer. The AI does the targeting work that agents currently skip because it's too hard — which means more addresses, more campaigns, more revenue.

**For Rootz**: PRINTgenie gives our data a revenue multiplier. We don't just sell searches — we power actions. Every mailing sent is proof the data has value.

**The moat**: Nobody else has courthouse signal detection connected to AI search connected to automated mailing. PropStream has data but no AI. REDX has phone numbers but no mailing. Wise Pelican has mail but no intelligence. This is the first integrated stack.

---

## Next Steps

1. **Andy + Steven**: Confirm API integration approach (CSV first, then API)
2. **Stephanie**: Identify 3-5 pilot agents
3. **Steven**: Add "Export to PRINTgenie" CSV button to /farm interface
4. **Andy**: Prepare campaign templates for each signal type (probate, foreclosure, absentee, long-term owner)
5. **All**: Target pilot launch within 30 days

---

*Rootz Corp — Talking to Data*
*title.rootz.global | discover@rootz.global*
