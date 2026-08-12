# title.rootz.global × PRINTgenie — Integration Design (MVP)

**Purpose:** answer John's "describe the tool and UX in explicit detail so I can work backward
to what PRINTgenie exposes." Written from the Rootz side. Andy's vision is right; this adds the
technical shape + the two things Rootz brings that make it more than a mail merge.

---

## 1. The experience (Andy's flow, affirmed + extended)

Andy's 7 steps are exactly the MVP. Two clarifications and one addition from our side:

- **The recipient is the OWNER, mailed at their mailing address — and our tool already produces
  that.** The farming search returns each prospect with `owner` (name) and `ownerMailingAddress`
  `{address, city, state, zip}`, and it specifically surfaces **absentee / out-of-state owners**
  whose mailing address differs from the property. So the "13 properties" already come out as
  **mailing-ready recipient records** — no extra data step. PRINTgenie receives clean owner+address
  rows, and (optionally) the property address as a merge variable ("Regarding 24 Center St…").

- **What Rootz adds (the differentiator): the order is a _signed action_, not just an account link.**
  When the user approves "mail these 13 a handwritten note saying X," that approval is captured as a
  **signed authorization** — a tamper-evident record binding *who* authorized it, *the exact recipient
  list* (hash), *the exact message/image* (hash), and *when*. That single artifact:
  - gives PRINTgenie **proof of authorization** for the order (not "some API call happened"),
  - gives the user **proof of what they sent to whom** (their own compliance record),
  - carries the **provenance of the list** — these 13 came from FL DOR + Broward court records on a
    given date — so the mailing is auditable back to its public-record basis.

  This is Rootz's core model applied to direct mail: origin (where the list came from, measured) +
  ownership (the user signed the send). It's optional for a bare MVP, but it's the reason this is a
  Rootz integration and not a generic Zapier hop, and it costs PRINTgenie nothing to receive — we
  pass a signature/hash alongside the order and PRINTgenie can ignore or store it.

**Net flow:** find people → LLM offers to mail → user links PRINTgenie account (once) → LLM checks
account can pay → conversation to shape the message → LLM writes a short handwritten note → renders it
to a print-ready image → **user signs the send** → one `place_order` to PRINTgenie (recipients + image
+ template) → PRINTgenie produces, addresses, stamps, mails → LLM reports orderId + status.

---

## 2. Division of responsibility (the clean handoff)

| Rootz / ChatGPT owns | PRINTgenie owns |
|---|---|
| Finding the people (farming search) | The PRINTgenie account + payment/autofund |
| The conversation → the message | The predefined postcard template + Image Merge Block |
| Rendering the handwritten **image** (print-ready) | CASS/address verification, production, postage, mailing |
| The **signed authorization** + list provenance | Order lifecycle + fulfillment status |
| Mapping owner→recipient fields | Returning orderId, cost, mail date, status, errors |

The entire handoff is **one call**: `place_order(auth, templateId, recipients[], mergeImage, options)`.
Everything about layout, fonts, coordinates, postage stays inside PRINTgenie. We never send design —
we send a finished image + data, exactly as Andy proposed with the Image Merge Block.

---

## 3. Point-by-point answers to John's questions

**What does the LLM need access to inside PRINTgenie?** Four functions only for MVP:
account-status (read), place-order (write), order-status (read), and a one-time account-link. No
template/asset browsing, no campaign builder.

**How does the user authenticate their PRINTgenie account?** MVP: user creates the account + adds
payment on PRINTgenie (outside the integration, per Andy), then links it once to their Rootz session.
Simplest link = a **PRINTgenie-issued API key or OAuth authorize** the user pastes/approves once; we
store it against their Rootz session. (Rootz-native direction below in §5 — a signed handshake — but
MVP should reuse whatever PRINTgenie already has.)

**Does registration/account setup happen outside the integration?** Yes — fully outside for MVP.

**How does the integration know the user has a valid account?** `account_status()` returns
`{ accountValid }` after linking; if not linked or invalid, the LLM tells the user to create/link.

**Does it need to know payment/autofund is enabled before ordering?** Yes — `account_status()` should
return `{ paymentOnFile, autofundEnabled, availableBalance }` (or an equivalent "can this account pay
for N pieces?" signal). The LLM checks this **before** offering to send, so it never promises a
mailing the account can't fund, and can tell the user exactly what to enable.

**What account info does the LLM read?** Only: account valid?, can it pay?, and a per-piece cost
estimate so the LLM can say "13 pieces ≈ $X." Nothing sensitive; no card data.

**What recipient/data fields will you send us?** Per recipient:
`{ name, mailingAddress1, mailingCity, mailingState, mailingZip, propertyAddress? , mergeVars?{} }`.
(propertyAddress and mergeVars are optional personalization; the core is name + mailing address.)

**What does PRINTgenie need to receive to create/place the order?**
`{ accountAuth, templateId, recipients[], mergeImage, options{ mailClass?, quantity=recipients.length } }`.

**Campaign vs order against a predefined template?** MVP = **place an order against ONE predefined
postcard template** with an Image Merge Block. No campaign creation in the LLM. (Campaigns/multiple
templates = a later phase.)

**How is the handwritten image passed?** As a **print-ready PNG**, either a hosted URL we provide
(PRINTgenie fetches) or base64 inline — your call which you prefer. It drops straight into the Image
Merge Block. We need your Merge Block spec (see §6).

**Does the LLM need templates/assets, or can we abstract that away?** Abstract it away for MVP — one
predefined template id, hardcoded. No asset access needed.

**What does our tool need back after submitting?**
- On submit: `{ orderId, status, pieceCount, totalCost, estimatedMailDate }`.
- Later: `order_status(orderId)` → `{ status: received|in_production|mailed|canceled|error,
  mailedDate?, undeliverableCount? }`. Fulfillment/mailing status is valuable so the LLM can answer
  "did my mail go out?" — but not required for the very first cut if it's hard.

**What errors/exceptions should come back?** Typed codes so the LLM can guide the user:
`account_not_linked`, `payment_not_configured`, `autofund_disabled`, `insufficient_balance`,
`invalid_recipient_address` (+ which rows failed CASS), `image_rejected` (+ reason: dims/DPI/format),
`template_not_found`, `order_failed` (generic + message). Each = `{ code, message, details? }`.

---

## 4. Proposed MCP tool set (the functions → your APIs)

These are the LLM-facing tools; each ultimately invokes a PRINTgenie API. Names illustrative.

```
printgenie.link_account({ apiKey | oauthCode })
    → { linked: bool, accountId }

printgenie.account_status()
    → { accountValid, paymentOnFile, autofundEnabled, availableBalance,
        estimatedCostPerPiece }

printgenie.place_order({
    templateId,                     // predefined postcard (MVP: one, hardcoded)
    recipients: [{ name, mailingAddress1, mailingCity, mailingState, mailingZip,
                   propertyAddress?, mergeVars? }],
    mergeImage: { url | base64, mimeType: "image/png" },
    options?: { mailClass?, sendProof? },
    authorization?: { signature, listHash, messageHash, signedAt, signer }  // Rootz-native, optional
})
    → { orderId, status, pieceCount, totalCost, estimatedMailDate }
       | { error: { code, message, details } }

printgenie.order_status({ orderId })
    → { status, mailedDate?, undeliverableCount?, pieces? }
```

MVP could ship with just `account_status`, `place_order`, `order_status` + a manual API-key link.

---

## 5. Auth: MVP path vs the Rootz-native direction

- **MVP (use what you have):** user pastes a PRINTgenie API key (or OAuth bounce). Stored against
  their Rootz session. Zero new work on your side beyond exposing the key.
- **Rootz-native (where we'd like to land):** the *authorization to mail* is a signature, not a
  session. The user signs the send once; that signature authorizes the order to PRINTgenie and is the
  audit record. Think "the send button IS the authorization" rather than "log in, then send." This is
  additive — it rides alongside the MVP auth and doesn't block v1. Happy to spec the handshake with
  John when we get there.

---

## 6. What we need from John (to build v1)

1. **Image Merge Block spec:** exact pixel dimensions, DPI (assume 300), format (PNG?), color space
   (CMYK vs RGB), bleed/safe area, and whether transparent background is OK. We size the handwritten
   image to this.
2. **The predefined postcard template id** (or how to reference "the default postcard").
3. **Auth mechanism to reuse for MVP:** API key vs OAuth — which do you already have?
4. **Recipient address format + CASS behavior:** do you validate/standardize addresses, and how are
   undeliverables reported back?
5. **The account-can-pay signal:** what does `account_status` actually expose (balance? autofund
   flag? a "sufficient for N pieces" check?).
6. **Image passing preference:** hosted URL we provide, or base64 inline?

---

## 7. MVP scope line

**In:** link account (manual key) → check it can pay → shape message in chat → generate handwritten
image → sign the send → one order against one predefined postcard → return orderId + status.

**Out (later):** campaign creation, multiple/selectable templates, in-chat registration/payment,
A/B, deep per-recipient personalization, proof previews, full fulfillment tracking beyond "mailed."

That's the smallest thing that's genuinely useful: the AI/data conversation ends with **"mailed."**
