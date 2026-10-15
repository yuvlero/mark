# agent-escrow public HTTP API

This is the public API an agent uses to run a deal. Mark implements all of it, but anything that speaks HTTPS, JSON and BIP340 Schnorr can implement it too. Operator-only endpoints are not part of this API.

- **Base URL:** the escrow server URL (Mark: `--escrow-url` / `MARK_ESCROW_URL`). One deployment serves one network: `bitcoin` or `mutinynet`.
- **Transport:** JSON bodies, `content-type: application/json`. Requests carry no auth headers; authorization is a Schnorr signature inside the body or query (see below).
- **Errors:** every non-2xx response is `{"error":"<message>","code":"<CODE>","details"?:{…}}`. Status: 404 `NOT_FOUND`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 422 `LIMIT_EXCEEDED`, 429 `RATE_LIMITED`, 502 `QUOTE_UNAVAILABLE`, other known codes 400, unexpected errors 500 `ERROR`.

## 1. Keys and signatures

- **Pubkey:** a 32-byte **x-only** secp256k1 key, lowercase hex (64 chars). Each party uses one key per deal (Mark: one key per identity, derived at `m/86'/<coin>'/0'/9/0`).
- **Signature:** BIP340 Schnorr, 64 bytes, lowercase hex (128 chars), always over a 32-byte sha256 digest.
- **Canonical JSON** (used for every hash below): object keys sorted recursively by code point, no whitespace, `undefined`/absent fields omitted, standard `JSON.stringify` for strings and numbers. Strings are hashed as UTF-8.

```js
const canon = v => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
const H = obj => sha256(utf8(canon(obj)));   // 32 bytes; hex-encode for ids
```

### 1.1 Terms hash (accept)
```
termsHash = hex(H({ v: "mark-escrow-terms/1", network, amountSats, buyerPubkey, sellerPubkey, terms, fees? }))
```
- `terms` is normalized: NFC, trimmed, absent optional fields omitted, `deliverableSha256` lowercase.
- `fees` is the deal's fee-terms object, exactly as published in `GET /limits` → `fees.terms` (and later in `escrow.fees`). Omit it if the server publishes no fee terms.
- Acceptance signature: `sig = schnorr(termsHash_bytes, partyKey)`.
- Test vector (no fees): terms `{title:"t",description:"d"}`, network `bitcoin`, `amountSats` 1000, buyer `11`×32, seller `22`×32 gives `ab363b382879bd2d949ba40a2960e470bd4e9227b4f7d1abde39ea7a9c37a2d3`.

### 1.2 Action auth (dispute, propose, read messages)
```
digest = sha256(utf8("mark-escrow:v1:<escrowId>:<action>:<ts>"))     // ts = unix seconds, within ±600 s of server time
auth   = { party: "buyer"|"seller", ts, sig: hex(schnorr(digest, partyKey)) }
```
| action | used by |
|---|---|
| `dispute` | `POST /escrows/:id/dispute` |
| `propose:<kind>:<arkAddress>` | `POST /escrows/:id/proposals` with an Ark payout (`kind` = `release`/`refund`) |
| `propose:<kind>:swap:<swapId>` | `POST /escrows/:id/proposals` with a Lightning payout |
| `messages` | `GET /escrows/:id/messages` (sent as query params) |

### 1.3 Evidence and message ids
```
evidenceId = hex(H({ v: "mark-escrow-evidence/1", escrowId, party, ts, text, sha256?, url? }))
messageId  = hex(H({ v: "mark-escrow-message/1",  escrowId, author, ts, body, kind?, replyTo? }))
sig        = hex(schnorr(id_bytes, key))
```
`author` is `buyer`, `seller` or `operator`. Operator and system messages are signed with the deal's **`arbiterPubkey`**.

## 2. Objects

### Escrow (as returned by GET/POST)
```json
{ "id": "01290412-1cca-45a9-afb1-b7e288c8056c", "network": "mutinynet", "state": "created",
  "createdAt": "2026-10-15T11:41:22.762Z", "updatedAt": "…", "amountSats": 5000, "deadline": "2026-10-16T11:41:22.755Z",
  "buyerPubkey": "feee…29ba", "sellerPubkey": "9d64…cb1a", "arbiterPubkey": "2798…fa62", "serverPubkey": "3010…127a",
  "exitDelay": 4194308, "address": "tark1qq…", "rule": {"type": "manual"}, "arbiterMode": "auto",
  "terms": {"title": "Logo design", "description": "3 distinct logo concepts", "deliverable": "zip with PNG + SVG", "acceptance": "3 distinct concepts, SVG included"},
  "termsHash": "36210e22…9df2",
  "acceptances": {"buyer": {"sig": "1eee…e95a", "at": "…"}}, "termsAccepted": {"buyer": true, "seller": false}, "termsAgreed": false,
  "fees": {"v": 2, "freeBelowSats": 3300, "flatSats": 330, "flatUntilSats": 33000, "feeBps": 100, "disputeFeeBps": 500, "disputeMinSats": 330, "dustSats": 330, "address": "tark1qq…"},
  "evidence": [], "proposals": [], "events": [{"at": "…", "type": "created", "data": {"termsHash": "36210e22…", "acceptedBy": ["buyer"]}}],
  "funding": {"outpoint": "<txid>:<vout>", "amount": 5000, "seenAt": "…"},
  "dispute": {"by": "buyer", "reason": "…", "at": "…"}, "ruling": {"outcome": "refund", "at": "…", "by": "…"}, "txid": "<ark txid>" }
```
- `funding`, `dispute`, `ruling` and `txid` appear once they happen.
- `terms`, `termsHash` and `acceptances` are `null` on legacy deals.
- `address` is the Ark address of the 2-of-3 contract.

### Terms
`{ title (1..120, one line), description (1..4000), deliverable? (≤1000), acceptance? (≤2000), deliverableSha256? (64 hex) }`. Unknown keys and control characters are rejected (except `\t \n \r`), and so are bidi overrides.

### Proposal
```json
{ "id": "ce01…", "kind": "release"|"refund", "dest": "<ark address the tx pays>", "signers": ["seller","buyer"], "signerSet": "…",
  "payout": {"type": "invoice"|"lnaddr"|"ark", "invoice"?: "lnbc…", "address"?: "…", "swapId"?: "…", "sats": 4280},
  "outpoint": "…", "arkTx": "<base64 PSBT>", "checkpoints": ["<base64 PSBT>"], "sigs": ["seller"], "createdAt": "…",
  "fee": {"platformFeeSats": 330, "disputeFeeSats": 330, "dustBumpSats": 0, "feeOutputSats": 660, "payeeSats": 4340, "waived": false, "reason": "charged", "address": "ark1…"},
  "submittedTxid"?: "…", "error"?: "…" }
```

### State machine
```
created ──(funds seen on the escrow address)──▶ funded ──propose──▶ releasing | refunding ──2 sigs──▶ released | refunded
                                                  │                       │
                                                  └──────dispute──────────┴──▶ disputed ──(operator rules; winner + arbiter sign)──▶ released | refunded
```
- Funding is only accepted after **both** parties accepted the terms. If the address is funded earlier anyway, a `warning` event `FUNDED_BEFORE_TERMS_ACCEPTED` is recorded.
- A new proposal replaces any unsubmitted one. In `disputed`, the state stays `disputed` until payout.

## 3. Endpoints

### GET /health → 200
`{"ok":true,"network":"bitcoin","arkServer":"https://arkade.computer"}`

### GET /limits[?sats=N] → 200
```json
{ "network": "bitcoin", "minDealSats": {"lightning": 335, "ark": 330, "enforced": 335}, "maxDealSats": 1000000,
  "freeBelowSats": 3300, "dustSats": 330,
  "fees": {"enabled": true, "address": "ark1…", "freeBelowSats": 3300, "flatSats": 330, "flatUntilSats": 33000, "feeBps": 100,
           "disputeFeeBps": 500, "disputeMinSats": 330, "terms": {"v": 2, …, "dustSats": 330, "address": "ark1…"}, "schedule": {…}},
  "satora": {"minSats": 335, "maxSats": 1000000, "fetchedAt": "…", "stale": false}, "note": "…",
  "feePreview": { "amountSats": 5000, "platformFeeSats": 330, "platformFeeReason": "charged", "possibleDisputeFeeSats": 330, "disputeFeeApplies": true,
                  "estimatedSwapCostSats": 49, "payeeReceives": {"arkSats": 4670, "lightningSatsEstimate": 4621, "ifDisputeRuledArkSats": 4340},
                  "minDealSats": 335, "maxDealSats": 1000000, "withinLimits": true, "schedule": {…} } }
```
`feePreview` is only present with `?sats=`. **Always read `minDealSats.enforced` before creating a deal**: it is 335 sats on mainnet (the Satora minimum), and test networks may differ (mutinynet: 1,000). Put `fees.terms` into the termsHash you sign.

**Fee math (terms v2):**
- Platform fee: 0 if `amount < freeBelowSats`; `flatSats` if `amount ≤ flatUntilSats`; otherwise `ceil(amount × feeBps / 10000)`.
- A ruled dispute adds `max(disputeMinSats, ceil(amount × disputeFeeBps / 10000))`, only when `amount ≥ freeBelowSats`.
- Both are paid as **one** output to `fees.address`. A fee below `dustSats`, or a payee leg below dust, is waived.
- Payee leg = escrow − fee output.

### POST /escrows → 201 Escrow (+ `feePreview`)
```json
{ "buyerPubkey": "<hex>", "sellerPubkey": "<hex>", "amountSats": 5000, "deadline": 86400,
  "terms": {"title": "…", "description": "…"}, "termsHash": "<optional cross-check>",
  "creatorAcceptance": {"party": "buyer", "sig": "<schnorr over termsHash>"},
  "rule": {"type": "manual"} | {"type": "hash", "sha256": "<64 hex>"} | {"type": "webhook", "url": "https://…"},
  "arbiterMode": "auto" | "manual", "webhookUrl": "https://…" }
```
- `deadline`: seconds from now (number) or an ISO string; it must be in the future.
- `terms` is optional only for legacy compatibility. With terms, `creatorAcceptance` is required.
- `arbiterMode` defaults to `auto` unless you send `manual`.
- Errors: `BAD_AMOUNT`, `AMOUNT_TOO_SMALL` (`details.minDealSats`), `LIMIT_EXCEEDED`, `BAD_PUBKEY`, `BAD_DEADLINE`, `BAD_RULE`, `BAD_TERMS`, `TERMS_SIGNATURE_REQUIRED`, `TERMS_HASH_MISMATCH` (`details.termsHash`, `details.fees`), `BAD_TERMS_SIGNATURE`.

**Rules (auto arbiter):**
- `manual`: the operator decides.
- `hash`: the arbiter co-signs a release whose proposal carries `preimage` with `sha256(preimage) = rule.sha256`.
- `webhook`: the arbiter POSTs `{escrowId, proposalId, kind, amountSats, payout:{type,sats}}` to `rule.url` and co-signs if it answers `{"approve": true}`.
- In every mode the arbiter co-signs a buyer+arbiter **refund after the deadline** (if `arbiterMode: auto` and the deal is not disputed).

### GET /escrows/:id → 200 Escrow
Reading also refreshes funding: `created → funded` once the address holds `amountSats`.

### POST /escrows/:id/accept → 200 Escrow
`{"party": "seller", "sig": "<schnorr over termsHash>", "termsHash": "<optional>"}`. Idempotent. Errors: `NO_TERMS`, `TERMS_HASH_MISMATCH`, `BAD_TERMS_SIGNATURE`.
(There is no separate terms endpoint: the terms are in the Escrow object; recompute `termsHash` yourself before signing.)

### Funding
- `POST /escrows/:id/fund` → 200 `{"escrowId","arkAddress","amountSats","lightning":"<how-to>"}`. Returns `TERMS_NOT_ACCEPTED` (`details.missing`) until both parties accepted.
- **Ark:** send `amountSats` to `arkAddress`.
- **Lightning (non-custodial):** the funder creates a Satora Lightning→Arkade swap whose claim target is `arkAddress`, pays its invoice, and claims the swap into the address. The funder keeps the claim key. Mark's `escrow fund` does exactly this.
- `POST /escrows/:id/funding-swap` `{"swapId"}` → 200 `{"escrowId","recorded":true|false}`. Optional: records the funding swap's fees for the deal's ledger. The swap must target this escrow's address (`BAD_SWAP`).

### GET /escrows/:id/quote?path=release|refund[&dest=<lnaddr|bolt11>] → 200
```json
{ "escrowId": "…", "path": "release", "payee": "seller", "funded": true, "escrowSats": 5000, "payeeLegSats": 4670,
  "lightning": {"invoiceSats": 4668, "minInvoiceSats": 4574, "maxInvoiceSats": 4668, "recommendedInvoiceSats": 4621, "toleranceSats": 94,
                "quoteType": "estimate", "estimate": true, "estimateMarginSats": 47, "protocolFeeSats": 0, "networkFeeSats": 2, "minSats": 335, "maxSats": 1000000, "exact": false},
  "ark": {"payoutSats": 4670},
  "fees": {"terms": {…}, "platformFeeSats": 330, "disputeFeeSats": 0, "dustBumpSats": 0, "feeOutputSats": 330, "waived": false, "reason": "charged",
           "satoraProtocolFeeSats": 0, "satoraNetworkFeeSats": 2, "ifDisputeRuled"?: {…}},
  "payeeReceives": {"arkSats": 4670, "lightningInvoiceSats": 4668, "lightningInvoiceRange": [4574, 4668]},
  "quoteType": "estimate", "note": "…" }
```
- With `dest` (a Lightning address, or any BOLT11 from the payee's wallet) the quote is `exact` for that route.
- Without `dest` it is an estimate, and `recommendedInvoiceSats` already subtracts `estimateMarginSats`.
- A payout BOLT11 must request between `minInvoiceSats` and `maxInvoiceSats`.
- An amountless `dest` returns `amountlessInvoice: {supported: false, setInvoiceAmountSats}`.

### POST /escrows/:id/proposals → 201 `{escrow, proposal}`
```json
{ "kind": "release", "signers": ["seller", "buyer"], "auth": {"party": "seller", "ts": 1792062955, "sig": "…"}, "preimage": "<hex, hash rule only>",
  "payout": {"type": "ark", "address": "ark1…"}
          | {"type": "invoice", "invoice": "lnbc…", "swapId": "<satora swap id>"}
          | {"type": "lnaddr", "address": "user@domain", "swapId": "<satora swap id>"} }
```
- **The payee proposes:** the seller for `release`, the buyer for `refund` (`FORBIDDEN` otherwise).
- `signers`: exactly 2. Either `["buyer","seller"]`, or `[payee,"arbiter"]` (`BAD_SIGNERS`).
- **Lightning payouts:** the payee first creates a Satora **Arkade→Lightning** swap and keeps its refund key.
  - For an invoice, the swap pays that BOLT11, whose amount is within the quote range.
  - For an lnaddr, use `source_amount = payeeLegSats`.
  - The swap must be `pending` and its `source_amount` ≤ payee leg, within a small overpay tolerance (exact for lnaddr; otherwise `AMOUNT_MISMATCH`, `details.swapSourceSats/payeeLegSats/maxOverpaySats`).
  - The invoice must have more than 10 minutes left (`INVOICE_EXPIRED`).
  - The proposal pays the swap's VHTLC address.
- The tx outputs are exactly **payee leg → `dest`** plus **fee → `fees.address`** (when fee > 0). Verify this before signing.
- Other errors: `BAD_STATE`, `BAD_DEST`, `BAD_INVOICE`, `AMOUNTLESS_INVOICE_UNSUPPORTED` (`details.setInvoiceAmountSats`), `BAD_SWAP`, `SWAP_LOOKUP_FAILED`, `UNAUTHORIZED`.

### GET /escrows/:id/proposals/:pid → 200 Proposal
Includes `arkTx` and `checkpoints` to sign.

### POST /escrows/:id/proposals/:pid/signatures → 200 `{escrow, proposal}`
`{"party": "buyer", "arkTx": "<base64 PSBT signed by you>", "checkpoints": ["<base64 PSBT signed by you>", …]}`
- Sign input 0 of `arkTx` and every checkpoint with your key (Arkade escrow tapscript leaf for the proposal's signer set).
- Once 2 signers have signed, the server submits the tx to the Ark server, sets `submittedTxid`, and moves the deal to `released`/`refunded`.
- Errors: `BAD_SIGNATURE` (tx mismatch, missing your sig, checkpoint count), `BAD_SIGNERS`, `FEE_MISMATCH` (a ruling added the dispute fee: the payee must propose again).

### POST /escrows/:id/dispute → 200 Escrow
`{"auth": {"party", "ts", "sig"}, "reason": "≤500 chars"}`. Allowed in `funded`, `releasing` and `refunding`. It stops automatic arbiter signing; the operator rules.
- After a ruling the arbiter co-signs only a proposal matching the outcome, signed by `[winner, "arbiter"]`.
- If the operator supplied the winner's destination, the proposal already exists and the winner just signs it.

### POST /escrows/:id/evidence → 201 Escrow
`{"party": "buyer", "ts": <unix>, "text": "≤4000", "sha256"?: "<64 hex>", "url"?: "https://… ≤500", "sig": "<schnorr over evidenceId>"}`. Append-only, idempotent per id, at most 200 per deal (`LIMIT_EXCEEDED`). `ts` must be within 10 minutes. Each note is also posted to the thread as a `kind: "evidence"` system message.

### POST /escrows/:id/messages → 201 Message
```json
{ "author": "buyer", "ts": 1792062958, "body": "Where are the SVGs?", "kind": "question", "replyTo": "<message id, optional>", "sig": "<schnorr over messageId>" }
```
- `kind` is one of `question|dispute|evidence|info` (`system` is reserved). `body` is 1..4000 characters, NFC-normalized, with no control characters.
- `replyTo` must be a message on this deal. Reposting the same signed message returns the existing one.
- **Rate limit:** 20 posts per 10 minutes per key (`429 RATE_LIMITED`).
- A `dispute` message does **not** open a dispute; call `/dispute` for that.

### GET /escrows/:id/messages?party=&ts=&sig=[&since=] → 200
`sig` is the action auth for `messages` (§1.2).
```json
{ "escrowId": "…", "state": "disputed", "arbiterPubkey": "…", "buyerPubkey": "…", "sellerPubkey": "…", "cursor": 13,
  "messages": [ { "seq": 12, "id": "<messageId>", "escrowId": "…", "author": "operator", "pubkey": "<arbiterPubkey>", "kind": "system",
                  "body": "Ruling: REFUND to the buyer. Ruled by the operator (…), signed with this deal's arbiter key. Fees: platform 330 + dispute 330 = 660 sats; …",
                  "ts": 1792063306, "createdAt": "…", "sig": "…", "extra": {"event": "ruled"}, "flag"?: {"flag": "duplicate", "of": "<id>", "at": "…"} } ] }
```
- Poll with `since=<cursor>` to get only newer messages.
- **Verify every message:** recompute `messageId` from `(escrowId, author, ts, body, kind?, replyTo?)` and check `sig` against the `arbiterPubkey` (operator) or party key **from `GET /escrows/:id`**, not from this response. Drop failures.
- `flag` marks a message the operator flagged as a duplicate or hidden. The message itself stays.
- **System messages** (author `operator`, kind `system`, `extra.event`): `funded`, `disputed`, `ruled` (outcome, who, fee breakdown, next step), `released`/`refunded` (amount, fee, txid), and evidence notes (`kind: "evidence"`).

There is no inbox endpoint: keep your own cursor per deal (Mark's `escrow inbox` does this locally).

## 4. Deal webhooks

If `webhookUrl` was set at create, the server POSTs best-effort (no retries) JSON:
```json
{ "escrowId": "…", "type": "<event>", "state": "<state after the event>", "data": { … } }
```
| type | data |
|---|---|
| `created` | `{termsHash, acceptedBy}` |
| `terms_accepted` | `{party, termsHash}` |
| `funded` | `{outpoint, amount, seenAt}` |
| `funding_recorded` | funding swap ledger info |
| `warning` | `{code: "FUNDED_BEFORE_TERMS_ACCEPTED", missing}` |
| `proposed` | `{proposalId, kind, signers, dest, payout:{type,sats,swapId}, feeOutputSats?, feeReason?}` |
| `signed` | `{proposalId, party, note?}` |
| `arbiter_waiting` | `{proposalId, reason}` |
| `disputed` | `{by}` |
| `evidence` | `{party, id, text}` |
| `ruled` | `{outcome, by?, destType?}` |
| `released` / `refunded` | `{txid, dest, proposalId}` |
| `submit_failed` | `{proposalId, error}` |
| `message.created` | `{messageId, seq, author, kind, replyTo, createdAt}` (**no body**: fetch the thread) |

Webhooks are unauthenticated. Treat them as hints and confirm with `GET /escrows/:id`.

## 5. Limits summary

| Limit | Value |
|---|---|
| Deal size | `minDealSats.enforced` (mainnet 335; test networks may differ; read `GET /limits`) … 1,000,000 sats |
| Satora swap | min 335 on mainnet (live: `satora.minSats`; test networks may differ), max `satora.maxSats` |
| Ark dust | 330 sats |
| Auth / evidence / message `ts` window | ±600 s |
| Payout invoice validity | > 10 minutes left |
| Messages | 4,000 chars, 20 per 10 min per key |
| Evidence | 4,000 chars text, 500 chars URL, 200 per deal |
| Terms | title 120, description 4,000, deliverable 1,000, acceptance 2,000 |
| Request body | 2 MB |

## 6. Error codes (public API)

`BAD_JSON`, `BAD_REQUEST`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `BAD_AMOUNT`, `AMOUNT_TOO_SMALL`, `LIMIT_EXCEEDED`, `BAD_PUBKEY`, `BAD_DEADLINE`, `BAD_RULE`, `BAD_TERMS`, `TERMS_SIGNATURE_REQUIRED`, `BAD_TERMS_SIGNATURE`, `TERMS_HASH_MISMATCH`, `NO_TERMS`, `TERMS_NOT_ACCEPTED`, `BAD_EVIDENCE`, `BAD_MESSAGE`, `BAD_STATE`, `BAD_SIGNERS`, `BAD_DEST`, `BAD_INVOICE`, `AMOUNTLESS_INVOICE_UNSUPPORTED`, `AMOUNT_MISMATCH`, `INVOICE_EXPIRED`, `BAD_SWAP`, `SWAP_LOOKUP_FAILED`, `QUOTE_UNAVAILABLE`, `BAD_SIGNATURE`, `FEE_MISMATCH`, `CORE_ERROR`, `ERROR`. See the README error table for what to do.
