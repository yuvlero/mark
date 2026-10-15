# Mark v0.1

Mark is an agent's signing-key client for a non-custodial 2-of-3 Arkade escrow service. The service is a separate project. Mark talks to it over HTTP only, using the contract in [docs/escrow-api.md](docs/escrow-api.md).
The key never leaves Mark. PSBTs are signed in-process, and only after Mark has checked locally that the tx outputs are exactly the payee leg to the proposal's destination plus the platform fee output required by the deal's **published, hash-signed fee terms** (nothing else).

## Build / test
```bash
npm install && npm test     # tests mock the HTTP API; no server needed
```

## Configure the escrow server URL (no default)
In order of precedence, highest first:
1. `--escrow-url https://...` on any command
2. the `MARK_ESCROW_URL` env var
3. `mark init --escrow-url https://...`, which saves it to config

Networks: `--network bitcoin` (default) or `mutinynet`. Cap: `limits.maxEscrowSats` (default 5000) is enforced in the core before any HTTP call.

## Layout
```
src/cli.ts, src/mcp.ts      thin adapters (argv / MCP tools -> core)
src/core/                   use-cases, context wiring, limits, local escrow index
src/api/escrowApi.ts        the only HTTP client for the escrow REST API
src/crypto/                 keystore (scrypt+AES-GCM), keys/auth, PSBT checks
src/lightning/invoice.ts    BOLT11 payout validation
src/swap/                   swap provider interface + Satora implementation
src/config.ts, errors.ts    network presets/config, JSON errors
```

## Mark quickstart
```bash
mark init [--network mutinynet]
mark pubkey
mark escrow create --role buyer --counterparty <seller xonly> --sats 1200 --deadline 86400 \
  --title "Buy 1M tokens of inference" --description "..." [--deliverable "..."] [--acceptance "..."] \
  [--deliverable-sha256 <hex>] [--terms-file terms.json] [--hash <sha256>]   # creator signs termsHash
mark escrow show <id>              # what the deal is for, who accepted (sigs verified locally), evidence
mark escrow accept <id>            # counterparty: verify termsHash locally, sign it. Funding needs both.
mark escrow evidence <id> --text "..." [--sha256 <hex>] [--url <https://...>]   # signed, timestamped note
mark escrow limits                 # min deal size (Lightning / Ark payout), fee rates, free tier, Satora min/max, Ark dust
mark escrow fund <id>              # Lightning invoice (Satora LN->Arkade into the escrow address)
mark escrow fund <id> --wait       # after payment: claims into the escrow
mark escrow quote <id> [--path release|refund] [--dest <bolt11|lnaddr>]   # exact sats (route-specific; without --dest it is an estimate)
mark escrow approve <id> --payout-invoice <bolt11>      # seller proposes + signs (or --payout-lnaddr / --payout-ark)
mark escrow approve <id>                                # buyer co-signs the pending proposal
mark escrow approve <id> --payout-invoice <bolt11> --with arbiter --preimage <hex>   # auto-arbiter release
mark escrow dispute <id> --reason "..."
mark escrow refund <id> --payout-invoice <bolt11>       # buyer, after deadline (arbiter co-signs)
# MCP tools: escrow_create (terms param), escrow_show, escrow_accept, escrow_evidence, ...
npm test                                                # unit tests
```
Payout invoices are checked by both Mark and the service. An invoice that expires within 10 minutes gives `INVOICE_EXPIRED`. An amount different from `quote.lightning.invoiceSats`, or a Satora swap whose source amount differs from the escrowed amount, gives `AMOUNT_MISMATCH`. Wrong-network and amountless invoices give `BAD_INVOICE`.

## Design notes and limits
- The crate's timelocked paths are **CSV + 2 parties**. There is no buyer-only timeout leaf, and the CSV is the Ark server's unilateral exit delay, not the escrow deadline. Spending through those paths also means an on-chain unilateral exit. So the v0.1 "timeout refund" is the collaborative arbiter + buyer path, which the arbiter auto-signs after the deadline. The CSV paths remain a server-free fallback, but they still need 2 parties.
- The service never stores buyer or seller secrets, and it can never sign more than one of the two required signatures.
- Lightning funding is non-custodial: the funder's own Mark holds the swap claim key and claims straight into the escrow address.

## Platform fees
Current schedule (fee terms `v: 2`), charged on every payout (release, refund, timeout refund) as ONE fee output:

| Amount | Normal payout: fee → payee | Ruled dispute: fee (platform + dispute) → winner |
|---|---|---|
| 3 299 | 0 → 3 299 (free below 3 300) | 0 → 3 299 |
| 3 300 | 330 → 2 970 (flat) | 660 (330 + 330 min) → 2 640 |
| 10 000 | 330 → 9 670 | 830 (330 + 500) → 9 170 |
| 33 000 | 330 → 32 670 (last flat) | 1 980 (330 + 1 650) → 31 020 |
| 33 001 | 331 → 32 670 (1 %, rounded up) | 1 982 (331 + 1 651) → 31 019 |
| 100 000 | 1 000 → 99 000 | 6 000 → 94 000 |
| 1 000 000 | 10 000 → 990 000 | 60 000 → 940 000 |

The dispute fee (5 %, min 330, only from 3 300 sats) is taken from the escrow before the winner's payout, so the loser pays it economically. Every charged fee is ≥ Ark dust; if live dust ever rises above a fee, the server waives it and Mark expects no fee output. Mark computes the expected fee from the deal's **signed** terms: deals stamped with the older `v: 1` terms (1 %, +5 %, free < 1000, sub-dust bump/waive) keep those rules, and an unknown terms version is refused.
The fee terms are stamped into each deal and covered by `termsHash`, so `mark escrow create/accept` sign them; `mark escrow show` prints `feeTerms` + `feeSummary`; `mark escrow quote` shows platform/dispute/Satora fees and the payee amount + invoice range. Legacy deals pay nothing. See [docs/escrow-api.md](docs/escrow-api.md#platform-fees-published-per-deal).
