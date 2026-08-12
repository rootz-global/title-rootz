# Rootz × PRINTgenie — an AI Direct-Mail Rail
### (title.rootz.global is the demo; the capability is generic)

**Purpose:** answer John's "describe the tool and UX explicitly so I can work backward to what
PRINTgenie exposes." Written from the Rootz side. Andy's vision is right — this frames it so the
first version ships small **and** the thing we're actually building is general.

---

## 0. The model: a generic "AI → signed direct mail" rail

The real product is **infrastructure, not a real-estate feature**: a rail that lets *any* AI
conversation end in mailed, signed direct mail. Three layers, cleanly separable:

```
  LIST PRODUCER (pluggable)        THE RAIL (Rootz)                 MAIL ENGINE (PRINTgenie)
  ─────────────────────────        ────────────────                ───────────────────────
  where the recipients             AI composes the message,        account, payment, the
  come from — property             renders a handwritten image,    postcard + Image Merge
  farming, a CSV upload,           the user SIGNS the send;         Block, CASS, production,
  a CRM, another AI tool,          one order handed off            postage, mailing, status
  a marketing list
```

- **The rail only needs `(recipient list, message, auth, signature)`** — it does **not** care where
  the list came from. Submit any list and it becomes an AI-operable mail campaign: converse to shape
  the message, sign, mail. "Enable a campaign to speak AI" = pass its list through this rail.
- **title.rootz.global is the demonstration** — and a good one, because it also *produces* the list
  (property farming: distressed / probate / absentee owners), so it shows the **whole** loop end to
  end in one place: find the people → converse → sign → mail. But nothing in the rail is
  title-specific. The next producer is a user CSV, a Rootz vertical (freight, USDA…), or an external
  AI that just hands us a list.
- **Why this matters to PRINTgenie too:** you're not the mail engine for one property tool — you're
  **the mail engine for AI**. Every AI agent that assembles a list becomes a PRINTgenie order. That's
  a much bigger surface than real-estate farming, off one integration.

Everything below is written generically; title is used only as the worked example.

---

## 1. The experience (Andy's flow, affirmed + extended)

Andy's 7 steps are the MVP. Two clarifications and one addition:

- **Recipients are mailing-ready at the source.** In the title demo the search already returns each
  prospect as `{ name, mailingAddress{address,city,state,zip}, propertyAddress }` and surfaces
  **absentee owners at their mailing address** — so PRINTgenie receives clean owner+address rows with
  no data step. Generically, the rail accepts that same recipient shape from *any* producer.

- **What Rootz adds (the differentiator): the order is a _signed send_, not just an account link.**
  When the user approves "mail these 13 a note saying X," we capture a **signed authorization**
  binding *who* approved it, *the exact recipient list* (hash), *the exact note/image* (hash), and
  *when* — plus the **provenance of the list** (e.g. "13 from FL DOR + Broward court records on
  2026-08-12", or "uploaded CSV, 240 rows"). That one artifact:
  - gives PRINTgenie **proof of authorization** for the order,
  - gives the user their **own record** of exactly what they sent to whom,
  - makes the campaign **auditable back to its origin** (measured list → signed send = origin +
    ownership).

  This is Rootz's core model applied to mail, and it rides *alongside* PRINTgenie's own auth — it
  costs you nothing to receive; store it or ignore it.

**Net flow:** produce/attach a list → LLM offers to mail → user links PRINTgenie account (once) → LLM
checks the account can pay → conversation to shape the message → LLM writes a short handwritten note →
renders a print-ready image → **user signs the send** → one `place_order` → PRINTgenie produces,
addresses, stamps, mails → LLM reports orderId + status.

---

## 2. Division of responsibility (the clean handoff)

| List Producer (pluggable) | Rootz Rail | PRINTgenie (mail engine) |
|---|---|---|
| Supplies recipients (title farming / CSV / CRM / other AI) | AI conversation → the message | The account + payment/autofund |
| — | Renders the handwritten **image** (print-ready) | The predefined postcard + Image Merge Block |
| — | The **signed authorization** + list provenance | CASS/address verification, production, postage, mailing |
| Maps its data → recipient shape | One `place_order` handoff | Returns orderId, cost, mail date, status, errors |

The handoff is **one call**: `mail.place_order(auth, templateId, recipients[], mergeImage, options,
signature)`. All layout/postage stays in PRINTgenie via the Image Merge Block — we send a finished PNG
+ data, never fonts/coordinates.

---

## 3. Point-by-point answers to John's questions

**What does the LLM need access to inside PRINTgenie?** Four functions for MVP: account-status (read),
place-order (write), order-status (read), one-time account-link. No template browsing, no campaign
builder.

**How does the user authenticate their PRINTgenie account?** Reuse what you already have — **API key
or OAuth**, user links once (outside/at the start of the integration). Rootz then layers a
**signed-transaction record on top** so the audit trail is complete (see §5). We are NOT asking you to
build new auth.

**Registration/account setup outside the integration?** Yes — fully outside for MVP.

**How does the integration know the account is valid?** `account_status()` → `{ accountValid }` after
linking; if not, the LLM tells the user to create/link.

**Payment/autofund known before ordering?** Yes — `account_status()` → `{ paymentOnFile,
autofundEnabled, availableBalance, estimatedCostPerPiece }`. The LLM checks this **before** offering to
send, so it never promises a mailing the account can't fund.

**What account info does the LLM read?** Only: valid?, can it pay?, per-piece cost estimate. No card
data.

**Recipient/data fields we send:** `{ name, mailingAddress1, mailingCity, mailingState, mailingZip,
propertyAddress?, mergeVars?{} }` — a generic recipient shape (propertyAddress/mergeVars optional
personalization). Same shape whether the list is property farming or a CSV.

**What PRINTgenie needs to place the order:** `{ accountAuth, templateId, recipients[], mergeImage,
options{ mailClass?, quantity } }` (+ our optional `signature`).

**Campaign vs order against a predefined template?** MVP = **order against ONE predefined postcard**
with an Image Merge Block. No campaign creation in the LLM. (Campaigns later.)

**How is the handwritten image passed?** Print-ready **PNG**, hosted URL we provide or base64 inline —
your preference. Drops into the Image Merge Block.

**Templates/assets for the LLM, or abstract away?** Abstract away for MVP — one hardcoded template id.

**What we need back on submit:** `{ orderId, status, pieceCount, totalCost, estimatedMailDate }`; later
`order_status(orderId)` → `{ status: received|in_production|mailed|canceled|error, mailedDate?,
undeliverableCount? }`.

**Errors/exceptions (typed, so the LLM can guide the user):** `account_not_linked`,
`payment_not_configured`, `autofund_disabled`, `insufficient_balance`, `invalid_recipient_address`
(+ which rows failed CASS), `image_rejected` (+ dims/DPI/format reason), `template_not_found`,
`order_failed`. Each = `{ code, message, details? }`.

---

## 4. Proposed MCP tool set (generic — list-source-agnostic)

LLM-facing tools; each invokes a PRINTgenie API underneath. Names illustrative.

```
mail.link_account({ apiKey | oauthCode })
    → { linked, accountId }

mail.account_status()
    → { accountValid, paymentOnFile, autofundEnabled, availableBalance, estimatedCostPerPiece }

mail.place_order({
    templateId,                         // predefined postcard (MVP: one, hardcoded)
    recipients: [{ name, mailingAddress1, mailingCity, mailingState, mailingZip,
                   propertyAddress?, mergeVars? }],   // from ANY producer
    mergeImage: { url | base64, mimeType: "image/png" },
    options?: { mailClass?, sendProof? },
    signature: { sig, listHash, messageHash, signedAt, signer, listOrigin }   // Rootz layer
})
    → { orderId, status, pieceCount, totalCost, estimatedMailDate }
       | { error: { code, message, details } }

mail.order_status({ orderId })
    → { status, mailedDate?, undeliverableCount?, pieces? }
```

The tools live in a **generic `mail` namespace**, not a title namespace — the title demo just wires
its farming results into `recipients[]`. Any other producer wires in the same way.

---

## 5. Auth: reuse PRINTgenie's, complete the record with a signature (DECIDED)

- **Reuse existing:** user links via PRINTgenie's **API key or OAuth**, once. Zero new auth work for
  PRINTgenie. This satisfies "does the account exist / can it pay."
- **Signed transaction on top:** the *authorization to mail* is additionally captured as a **user
  signature** over `{ listHash, messageHash, signedAt, signer, listOrigin }`, passed as `signature`
  on the order. PRINTgenie's key/OAuth answers "is this a real, paying account"; the signature
  answers "did this person actually authorize *this list* + *this message*, and where did the list
  come from." Together the record is complete: real account **and** signed intent **and** origin.
- PRINTgenie can treat `signature` as opaque metadata (store it with the order, or ignore it). No
  crypto work required on your side for MVP; we can co-design storing/verifying it later.

---

## 5a. Proof of delivery → proof of address (the response loop)

Direct mail closes a powerful loop when each piece carries a **unique ID**: you can prove the piece
reached the address, and — if the recipient acts — that a human at that address responded. That turns
a mailing into a lightweight **proof-of-address** mechanism, which composes with the signed-send record.

Three tiers, from buildable-now to regulated:

1. **Delivery attestation (build now, standard).** Every mailpiece already carries a USPS **Intelligent
   Mail barcode (IMb)** — a 20-digit unique code (Mailer ID + serial). USPS scans it through the
   network and exposes the scan events via USPS tracking APIs; **Informed Delivery** even reports who
   *viewed* the digital preview. So we get a USPS-attested "delivered to this address" signal per piece,
   keyed to our order. (PRINTgenie presumably already sets the IMb + Mailer ID — we'd want the
   per-piece serial ↔ recipient mapping and access to the scan/tracking feed.)
2. **Recipient response (build now, ours).** Print a **unique QR / short code** on the postcard bound
   to that specific piece→address. When the consumer scans it, we know *that address* produced a human
   response. Combine 1 + 2 and you have: origin (measured list) → owner-signed send → USPS-attested
   delivery → recipient response — a complete, four-point proof loop, and a simple proof-of-address
   primitive. **This is the highest-value near-term add and needs nothing exotic.**
3. **Identity-verified delivery (regulated, optional).** For high-assurance sends, USPS **Adult
   Signature Required / Restricted Delivery** has the carrier check a government photo ID at the door
   and capture a digital signature + name + timestamp — the same class of control DEA requires for
   shipping controlled substances (trackable service + electronic proof of delivery + signature). This
   yields a carrier-verified recipient-ID check, not a recipient-presented cryptographic credential.

**Honest note on "USPS PKI-signs the receipt":** USPS *did* run a PKI service — the **Electronic
Postmark (EPM)** — that produced trusted-timestamp + digital-signature + non-repudiation records. But
the USPS EPM provider contract **expired at the end of 2010** and it is not, as far as current sources
show, an active USPS product. So today we can't rely on a live USPS-PKI-signed delivery receipt we can
independently verify against a USPS cert; the authoritative postal artifacts available now are the
**tracking scan record** and (for signature services) the **captured signature image + delivery
record**. Those are strong, but they're USPS system-of-record data, not a portable PKI-signed token.
Worth a direct check of the current DMM / USPS dev APIs before we claim postal PKI in a pitch.

**How it fits the Rootz record:** our layer already signs {list, message, timestamp, origin}. Tiers 1–2
add the *back half* — delivery + response — so the signed campaign record becomes end-to-end: who
authorized what to whom, that it arrived, and that someone answered. If USPS ever re-exposes a
PKI-signed delivery/identity artifact, it drops straight into the same record as an extra attestation.

## 6. What we need from John (to build v1)

1. **Image Merge Block spec:** pixel dimensions, DPI (assume 300), format (PNG?), color space
   (CMYK/RGB), bleed/safe area, transparent background OK?
2. **The predefined postcard template id** (or how to reference "the default postcard").
3. **Which existing auth to reuse for MVP** — API key or OAuth?
4. **Address handling:** do you CASS/standardize, and how are undeliverables returned?
5. **The can-it-pay signal** `account_status` exposes (balance? autofund flag? "sufficient for N"?).
6. **Image passing preference:** hosted URL we provide, or base64 inline?

---

## 7. MVP scope line

**In:** attach a list (title demo produces one; generically any list) → link account (existing
key/OAuth) → check it can pay → shape message in chat → generate handwritten image → **sign the
send** → one order against one predefined postcard → return orderId + status.

**Out (later):** campaign creation, multiple templates, in-chat registration/payment, A/B,
deep personalization, proof previews, full fulfillment tracking beyond "mailed", signature
verification/storage on PRINTgenie's side.

The smallest genuinely-useful thing: **any AI/data conversation ends with "mailed" — with a complete,
signed record of who sent what to whom, and where the list came from.** Title is how we show it;
the rail is the product.
