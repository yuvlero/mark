# Escrow REST API: the contract Mark depends on

This file lists **only** what the Mark client (`src/api/escrowApi.ts`) calls and reads. Any server that implements it (for example the Replit build) works with Mark. Fields not listed here are passed through but never relied on.

- **Base URL.** Mark has no default. It resolves the URL in this order: `--escrow-url` > `MARK_ESCROW_URL` > `escrowUrl` in `<MARK_HOME>/<network>/config.json`, which `mark init --escrow-url` sets. A trailing `/` is stripped.
- **Transport.** JSON bodies with `content-type: application/json`. Mark gives up on a request after 180 s.
- **Network.** One server deployment serves one network (bitcoin or mutinynet). Mark does not send the network.

## Errors
Any non-2xx response must have the body `{"error": "<message>", "code": "<CODE>"}`. Mark passes `code` back to its caller unchanged.
Codes Mark handles itself: `NOT_FOUND`, `LIMIT_EXCEEDED`, `BAD_STATE`, `BAD_SIGNERS`, `FORBIDDEN`, `UNAUTHORIZED`, `INVOICE_EXPIRED`, `AMOUNT_MISMATCH`, `BAD_INVOICE`.
Errors that come from Mark, not the server: `ESCROW_URL_MISSING`, `ESCROW_UNREACHABLE` (network error or timeout), `ESCROW_BAD_RESPONSE` (the body is not JSON), and `ESCROW_ERROR` (the error body has no `code`).

## Types
- `Party = "buyer" | "seller" | "arbiter"`
- `Pubkey`: 32-byte x-only hex (BIP340), lowercase.
- `Escrow`:
  ```
  { id, state, amountSats, deadline (ISO), address (Ark address that holds the funds),
    buyerPubkey, sellerPubkey, arbiterPubkey,
    funding?: { outpoint, amount },        // set once funded; Mark checks payouts against `amount`
    proposals: ProposalSummary[],
    terms: Terms | null, termsHash: hex | null,          // null = legacy deal (no terms; works as before)
    acceptances: { buyer?: {sig, at}, seller?: {sig, at} } | null, termsAgreed: boolean,
    evidence: Evidence[] }
  ```
- `Terms`: `{ title (1..120, one line), description (1..4000), deliverable? (<=1000), acceptance? (<=2000), deliverableSha256? (32-byte hex) }`. Strings are NFC-normalized and trimmed; control chars (except \t \n \r) and bidi overrides are rejected; unknown keys are rejected. Immutable once created.
- `termsHash` = `sha256(canonicalJson({ v: "mark-escrow-terms/1", network, amountSats, buyerPubkey, sellerPubkey, terms }))`. Canonical JSON: keys sorted recursively, no whitespace, absent fields omitted. Binding network/amount/parties stops an acceptance being replayed onto another deal. Mark recomputes it locally and refuses to sign or fund on mismatch. Test vector: terms `{title:"t",description:"d"}`, network `bitcoin`, 1000 sats, buyer `11`×32, seller `22`×32 → `ab363b382879bd2d949ba40a2960e470bd4e9227b4f7d1abde39ea7a9c37a2d3`.
- Acceptance `sig` = BIP340 Schnorr over the 32 raw bytes of `termsHash` with the party's escrow key.
- `Evidence`: `{ id, party, at (server time), ts, text (<=4000), sha256?, url? (http(s), <=500), sig }`; `sig` = BIP340 over `sha256(canonicalJson({ v: "mark-escrow-evidence/1", escrowId, party, ts, text, sha256?, url? }))`, `id` = that hash. Append-only, max 200 per deal.
- `state`: `created → funded → (disputed) → releasing | refunding → released | refunded`
- `ProposalSummary`: `{ id, kind: "release"|"refund", dest: <Ark address the tx pays>, signers: [Party, Party], sigs: Party[], submittedTxid? }`
- `ProposalFull`: `ProposalSummary` plus `{ arkTx: <base64 PSBT>, checkpoints: <base64 PSBT>[] }`

## Auth
State-changing calls made by a party (propose, dispute) carry:
`auth = { party: "buyer"|"seller", ts: <unix seconds>, sig: <hex BIP340 signature> }`.
The signature is over `sha256("mark-escrow:v1:<escrowId>:<action>:<ts>")`, made with the party's escrow key (Mark derives it at `m/86'/<0|1>'/0'/9/0`). The server checks it against `buyerPubkey` or `sellerPubkey`.

| action | when |
|---|---|
| `dispute` | POST /dispute |
| `propose:<kind>:<dest>` | Ark payout: `<dest>` is the Ark address |
| `propose:<kind>:swap:<swapId>` | Lightning payout (invoice or lnaddr) |

## Endpoints
- `POST /escrows` additionally takes `terms`, `termsHash` (optional cross-check), `creatorAcceptance: { party, sig }`. With `terms`, the creator signature is required (`TERMS_SIGNATURE_REQUIRED`, `BAD_TERMS_SIGNATURE`, `TERMS_HASH_MISMATCH`, `BAD_TERMS`). Without `terms` the deal is a legacy deal.
- `POST /escrows/:id/accept` `{ party, sig, termsHash? }` → `Escrow`. Idempotent. `NO_TERMS` on legacy deals.
- `POST /escrows/:id/evidence` `{ party, ts, sig, text, sha256?, url? }` → 201 `Escrow`. `ts` must be within 10 minutes.
- Funding gate: `POST /escrows/:id/fund` returns `TERMS_NOT_ACCEPTED` until both parties accepted; Mark's `fund` refuses too. If an escrow address is funded anyway, the server records a `warning` event `FUNDED_BEFORE_TERMS_ACCEPTED`.

### POST /escrows → 201 `Escrow`
```
{ buyerPubkey, sellerPubkey, amountSats: int, deadline: <seconds from now (number) | ISO string>,
  rule: {type:"manual"} | {type:"hash", sha256:<64 hex>},
  arbiterMode?: "auto"|"manual", webhookUrl?: string }
```
Mark enforces its own cap (`limits.maxEscrowSats`, default 5000) **before** it calls the server. The server may enforce a stricter cap and answer `LIMIT_EXCEEDED`.

### GET /limits → 200 (public)
`{ minDealSats: {lightning, ark, enforced}, maxDealSats, freeBelowSats, dustSats, fees: {enabled, source, address, feeBps, disputeFeeBps, freeBelowSats, dustBumpMaxBps, terms}, satora: {minSats, maxSats, fetchedAt, stale} }`
Mark calls it before create: it refuses amounts below `minDealSats.enforced` (`AMOUNT_TOO_SMALL`, no POST) and puts `fees.terms` into the termsHash it signs. A server without `/limits` (404) is treated as fee-free.
The server answers `400 AMOUNT_TOO_SMALL` with `details.minDealSats` too.

### Platform fees (published per deal)
`Escrow.fees` (absent = legacy / pre-fee deal, no fees) = `{v:1, feeBps, disputeFeeBps, freeBelowSats, dustSats, dustBumpMaxBps, address}`, stamped at create and included in `termsDocument` as `fees`, so it is covered by `termsHash`.
Fee math lives in `src/core/fees.ts`, **byte-identical** with the server's `src/lib/fees.ts`: 1% of `amountSats` on every payout (release or refund), +5% when a dispute exists **and** was ruled, nothing below 1000 sats, rounded up; a fee below Ark dust is bumped to dust only if that adds ≤ `dustBumpMaxBps` of the amount, else waived.
Before signing, Mark requires the tx's value outputs (P2A anchor excluded) to be **exactly** `{proposal.dest: escrow − fee}` plus `{fees.address: fee}` when fee > 0. Anything else → `UNSAFE_TX`. If the server stamps fee terms different from what `/limits` published, create fails with `FEE_TERMS_MISMATCH`.

### GET /escrows/:id → 200 `Escrow`
Mark expects the server to refresh funding state on read.

### GET /escrows/:id/quote?path=release|refund → 200
`{ escrowSats, lightning: { invoiceSats, protocolFeeSats, networkFeeSats, minSats, maxSats }, ark: { payoutSats } }`
With fees the quote also has `escrowSats`, `payeeLegSats` (escrow − fee output), `fees: {terms, platformFeeSats, disputeFeeSats, dustBumpSats, feeOutputSats, waived, reason, satoraProtocolFeeSats, satoraNetworkFeeSats, ifDisputeRuled?}` and `payeeReceives: {arkSats, lightningInvoiceSats, lightningInvoiceRange}`; `lightning.*` is priced for the payee leg.
Mark uses `lightning.invoiceSats` as the exact amount a payout BOLT11 must request. It checks the invoice locally before creating any swap: it must be for that amount, on the right network, and valid for at least 10 more minutes.

### POST /escrows/:id/proposals → 201 `{ escrow: Escrow, proposal: ProposalSummary }`
```
{ kind, signers: [Party, Party], preimage?: hex, auth,
  payout: {type:"ark", address}
        | {type:"invoice", invoice:<bolt11>, swapId}
        | {type:"lnaddr", address:<user@domain>, swapId} }
```
- The proposal comes from the payee: the seller for `release`, the buyer for `refund`.
- For a Lightning payout, Mark itself has already created a Satora Arkade→Lightning swap whose source amount equals the escrowed amount. Mark holds that swap's refund key. The proposal's `dest` must be the swap's VHTLC address.
- Signers: Mark sends `["buyer","seller"]` by default, or `[payee,"arbiter"]` with `--with arbiter`.

### GET /escrows/:id/proposals/:pid → 200 `ProposalFull`

### POST /escrows/:id/proposals/:pid/signatures → 200 `{ escrow, proposal }`
`{ party, arkTx: <signed base64 PSBT>, checkpoints: <signed base64 PSBT>[] }`
Before signing, Mark refuses (`UNSAFE_TX`) if `arkTx` has no output paying `dest` at least the escrowed amount (`funding.amount`, or `amountSats` if absent). Once two parties have signed, the server submits the tx and sets `submittedTxid`.

### POST /escrows/:id/dispute → 200 `Escrow`
`{ reason?: string, auth }`

## Not used by Mark
Mark calls none of these: `/health`, `POST /escrows/:id/fund`, `/admin/*`, or webhooks. Lightning funding is done client-side: Mark creates a Satora Lightning→Arkade swap whose claim targets `Escrow.address`.
