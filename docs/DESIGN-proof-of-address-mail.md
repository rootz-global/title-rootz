# Proof-of-Address Mail — a byproduct of the PRINTgenie rail

**Status:** concept captured 2026-08-12 (parked with the USPS thread). Companion to
`DESIGN-printgenie-integration.md`.
**Effort estimate (Steven):** ~1–2 days to add the attribute + wire the mail loop (the rail
already exists), then a few weeks of testing.

---

## The idea

Once Rootz has the AI direct-mail rail (PRINTgenie, outbound), the *same rail run
inbound-confirming* mints a **proof-of-address attribute** for any identity in the system that
wants to record origin. Mail a unique code to the claimed address → USPS delivers it (with real
legal/location weight) → the recipient responds → Rootz records a **signed proof-of-address note**
on that person's **data wallet / identity contract**. It's nearly free because we're building the
outbound rail + signed-send record anyway; this reuses both.

It is a **proof of ADDRESS**, not a proof of cryptographic identity — see the boundaries below.

## The flow

1. An identity holder (data wallet / CorpID / DBA — see [[reference_v6_data_wallet_model]],
   [[feedback_identity_created_not_issued]]) asserts an address they want to prove.
2. Rootz sends a mail piece via PRINTgenie to that address carrying a **unique per-piece code**
   (QR / short code) bound to `{identity, address, nonce}`.
3. USPS delivers — the Mobile Delivery Device captures **GPS + timestamp** at the "Delivered" scan
   (retained ~2–10 yrs). Optionally endorse **Adult Signature** for a federally-deterred human act.
4. The recipient **scans the code** → proves a human at that address received *that specific piece*.
5. Rootz writes a **signed `proof_of_address` note** to the identity contract / data wallet:
   the address, the piece id, the captured USPS tracking/delivery record, the response event, and
   the timestamp — signed with the same machinery as the signed-send record.

## What USPS actually contributes (grounded findings — the reason this works)

- **USPS API = OAuth + TLS only, NO message-layer crypto.** No signed responses / JWS / payload
  signatures / non-repudiation. So delivery data is trust-the-endpoint *in the session*; to make it
  portable, **Rootz captures the raw USPS response + timestamp and signs it** (attested capture).
  Our signature proves *we faithfully recorded what USPS returned*, not that USPS attested it.
  (The one USPS PKI product — Electronic Postmark — was retired end of 2010.)
- **Adult Signature = location + time + age-gate + a federal criminal DETERRENT — not identity.**
  The carrier only *visually* verifies a government photo ID (21+); the ID number/details are
  **never recorded or retained** (Federal Register 2011 / DMM 503). What's kept is a signature
  image + a keyed name + the GPS/time delivery record. Non-restricted goes to *any* adult 21+ at the
  address; Restricted Delivery binds to the addressee. **The "teeth" are legal, not cryptographic:**
  lying to / presenting false ID to a postal employee is a federal crime (18 U.S.C. §1001 false
  statements, §1341 mail fraud), enforced by the **armed U.S. Postal Inspection Service**. That
  federally-deterred in-person act is a legitimate basis for a proof at the moment of interaction.
- **If verified identity is needed, USPS already has a rail — but at the counter:** **Login.gov
  in-person proofing** (IAL2, NIST 800-63-3) at Post Offices in all 50 states. That's the place to
  bind a *person*, not mail delivery.
- **The cryptographic identity layer neither USPS rail provides = mDL (ISO/IEC 18013-5)** — mobile
  driver's licenses, issued by 21+ states as of 2026, verifiable, presentable in-person (18013-5)
  and online (18013-7). The standard to ride if/when we want a verifiable credential.

## How it binds to the Rootz models

- New attribute type: a `proof_of_address` note on the **data wallet / identity contract** — signed,
  origin-recorded (piece id, USPS delivery capture, response event, timestamp).
- Fits the **sovereign DBA/CorpID model**: the identity self-asserts an address, then *earns* the
  proof-of-address attribute via the mail loop. Sovereign-by-default; the removable Rootz assistance
  key can help onboard (see [[feedback_sovereign_by_default_training_wheels]]).
- Reuses the **signed-send** signing machinery from the PRINTgenie spec — same origin+ownership model
  ([[feedback_origin_measured_ownership_signed]]).

### Strength tiers (pick per use case)
1. **Delivery + QR response** — someone at the address received the specific piece. (baseline proof of address)
2. **+ Adult Signature** — a federally-deterred human attestation at delivery (age-gated, legal weight).
3. **+ Login.gov proofing or mDL** — actual identity binding (counter / cryptographic credential).

## Honest boundaries (do not blur — cf. origin-measured / ownership-signed)

- **Proves:** a mail piece reached the address, a human responded, (Tier 2) under federal deterrent,
  with USPS GPS+time. = **proof of ADDRESS + delivery.**
- **Does NOT prove:** the cryptographic identity of the person — unless Tier 3 (mDL / Login.gov) is
  layered. And our signature attests *our faithful capture* of an (uncryptographic) USPS assertion,
  not a USPS-signed fact. State it that precisely in any pitch.
