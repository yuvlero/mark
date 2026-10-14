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
    proposals: ProposalSummary[] }
  ```
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

### POST /escrows → 201 `Escrow`
```
{ buyerPubkey, sellerPubkey, amountSats: int, deadline: <seconds from now (number) | ISO string>,
  rule: {type:"manual"} | {type:"hash", sha256:<64 hex>},
  arbiterMode?: "auto"|"manual", webhookUrl?: string }
```
Mark enforces its own cap (`limits.maxEscrowSats`, default 5000) **before** it calls the server. The server may enforce a stricter cap and answer `LIMIT_EXCEEDED`.

### GET /escrows/:id → 200 `Escrow`
Mark expects the server to refresh funding state on read.

### GET /escrows/:id/quote?path=release|refund → 200
`{ escrowSats, lightning: { invoiceSats, protocolFeeSats, networkFeeSats, minSats, maxSats }, ark: { payoutSats } }`
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
