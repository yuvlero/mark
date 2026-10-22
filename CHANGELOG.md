# Changelog

All notable changes to Mark (`@yuvlero/mark`), the CLI and MCP server for agent-escrow. Dates are UTC+4 (Dubai). Versions follow semver; 0.x releases may change behaviour between minor versions.

## [Unreleased]

## [0.2.1] - 2026-10-22

### Changed
- README: publishes the production arbiter identity key for `https://agentescrow.to` (`6714b08b384916fa5aed3436f48173c5c5b692d0a3699cae89f52f59e5c7cd2d`), so you can pin it explicitly with `--arbiter-pubkey` / `MARK_ARBITER_PUBKEY` instead of trusting first use. `docs/escrow-api.md` lists the same key.

### Fixed
- Security: `ws` 8.20.1 -> 8.21.3 (CVE-2026-48779 / GHSA-96hv-2xvq-fx4p, memory-exhaustion DoS). It is transitive via `viem` and `ws-electrumx-client`, so it is pinned with an npm `overrides` entry (`ws ~8.21.0`) and locked in `npm-shrinkwrap.json`.

## [0.2.0] - 2026-10-22

### Breaking
- **Needs escrow server 0.2.0 for v2 deals.** New deals use signed terms v2. Against an older server Mark falls back to v1 and prints `termsWarning` (this release only). Mark 0.1.7 and older can't accept the v2 deals that Mark 0.2.0 creates.
- **`http:` escrow URLs are refused** except for localhost (`BAD_ESCROW_URL`). Use `https://`.
- **The arbiter key is pinned.** The first time Mark talks to an escrow server, it saves that server's arbiter identity key. If the key later changes, Mark refuses (`ARBITER_KEY_CHANGED`).
- **The escrow address is checked.** Mark works out the escrow address itself and refuses to accept or fund if the server's address differs (`ADDRESS_MISMATCH`).

### Added
- Signed terms v2 (`mark-escrow-terms/2`). `create` signs the release rule, `arbiterMode`, the deadline, the fees and the webhook URL hash together with the terms. Mark recomputes the hash on create, accept, show and fund, remembers the hash it signed, and refuses to fund if the deal changed (`TERMS_HASH_MISMATCH`, `TERMS_CHANGED`).
- Local escrow-address derivation (`src/core/escrowContract.ts`, byte-identical with the server, parity-tested). `show` reports the result under `dealCheck`.
- Arbiter key pinning. Mark checks each deal's `arbiterAttestation` against the server's arbiter identity key. The key is pinned per escrow URL in `<dataDir>/arbiter-pins.json` on first use, or set explicitly with `--arbiter-pubkey` / `MARK_ARBITER_PUBKEY`. Errors: `ARBITER_KEY_CHANGED`, `ARBITER_KEY_MISMATCH`, `ARBITER_KEY_MISSING`, `ARBITER_ATTESTATION_INVALID`.
- `mark escrow fund` (and MCP `escrow_fund`) refuses with `UNSAFE_RULE` when you are the buyer and the auto-release rule was chosen by someone else: a `hash` lock the seller created, or any `webhook` rule (with `arbiterMode: auto`). Pass `--allow-counterparty-rule` (MCP `allowCounterpartyRule: true`) to go ahead anyway. `show` and `accept` print `ruleWarning` for these deals.

### Changed
- For v2 deals, the seller-chosen rule check (`UNSAFE_RULE`) runs at `accept`, because the buyer's signature binds the rule there: `mark escrow accept <id> --allow-counterparty-rule` (MCP `escrow_accept.allowCounterpartyRule`). v1 deals keep the check at `fund`.
- Docs (API doc, README, skill, quickstart): terms v2, address and arbiter checks, the new error codes, and the escrow server 0.2.0 changes. Those changes are: public deal responses omit `webhookUrl` (new `hasWebhook`); `POST /escrows` can return `429 RATE_LIMITED`; submitted signatures are verified (`BAD_SIGNATURE`); webhook URLs must be public `https://` URLs (`BAD_WEBHOOK_URL`).
- npm package: `docs/distribution` (internal notes) is no longer published.

### Fixed
- `--allow-counterparty-rule` was rejected by the CLI parser ("needs a value"). It now works as a plain flag.

## [0.1.7] - 2026-10-21

### Added
- Support for the server's new final deal state `expired` (escrow server 0.1.6). A deal that is still unfunded one hour after its deadline (the server's grace period) expires. It needs nothing from anyone (`awaiting: none`) and is never revived, even if a payment arrives later.
  - `mark escrow fund` refuses with `DEADLINE_TOO_CLOSE` when less than a funding invoice's lifetime (1 hour) is left before the deal expires. It uses the server's `expiresAt`, or deadline + 1 hour on older servers. Resuming an invoice you already have is still allowed.
  - `fund --wait` checks the deal again before claiming a paid swap. If the deal expired meanwhile it does not claim, so the payment does not land on an expired deal (the unclaimed swap times out and the Lightning payment is not settled).
  - A buyer can refund sats that reached an expired deal (paid too late, or only partly): `mark escrow refund <id> --payout-lnaddr <you@wallet>` (buyer + arbiter). A release on an expired deal is refused.
  - `show` prints what to do with an expired deal in `next`.
- New error codes in the README table: `EXPIRED` and `DEADLINE_TOO_CLOSE`.

### Changed
- `mark escrow fund` on an expired deal prints `state: "expired"` and a `note` starting with "expired" instead of "already funded", and creates no invoice.
- `mark escrow invites` skips expired deals by default and with any `--needs` (accept, fund, sign, any), even if an older server still lists them. `--all` (without `--needs`) and `--state expired` still show them.
- The shared status logic (`src/core/status.ts`, identical to the server's) treats `expired` as final: `awaiting: none`, `action_required_for: none`.
- The `escrow_fund` MCP tool description says that it refuses close to expiry and reports expired deals.
- Docs: `docs/escrow-api.md` has a new "Expiry of unfunded deals" section (state diagram, `expiresAt`, `expiredAt`, `partialFunding`, `fundedAfterExpiry`, the new webhook events, the refund path, `GET /limits` → `expiry`). README, the agent quickstart and the agent skill explain expiry, funding in time and how to refund a late payment.

### Fixed
- An unfunded deal far past its deadline no longer asks the buyer to fund it (`needs: ["fund"]`) forever. With escrow server 0.1.6 it expires; Mark also drops expired deals from `invites --needs fund` on its own.

## [0.1.6] - 2026-10-20

### Added
- Wallet recommendation for agents without one: `mark` with no arguments now adds `quickstart.noWallet` (one line) and `quickstart.recommendedWallet` with Bark, Second's self-custodial Ark wallet CLI. It gives the name, why it fits (an agent needs a Lightning-capable wallet to pay the escrow's funding invoice and receive payouts), the official binary download command for Linux x86_64 (bark 0.7.1, the latest release), the docs and releases links, the commands to create a mainnet wallet, pay a funding invoice and make a payout invoice, a note that any Lightning wallet works, and a warning not to use `--payout-ark` with a Bark Ark address. The README, AGENTS.md, the agent quickstart and the agent skill mention the same recommendation.
- MCP server `instructions`: a short description that MCP clients show the model. It says what Agent Escrow is, when to use it, that the operator can't move funds alone, which tools to start with, and that mainnet is real money.

### Changed
- Clearer tool descriptions so agents pick the right tool: `escrow_create` is rewritten to say when to use it and what comes next. `escrow_demo`, `escrow_reputation` and `escrow_fund` now open with a when-to-use line. The other tools are unchanged.
- Discovery text: new npm description and keywords, a new MCP registry description in server.json (96 characters; a test keeps it at 100 or fewer), the agent skill description rewritten as "Use when..." triggers, and a new README title.
- The `usage`, `defaultNetwork`, `quickstart.firstRun` and `quickstart.steps` fields and exit code 0 of `mark` with no arguments are unchanged.

### Fixed
- No fixes in this release.

## [0.1.5] - 2026-10-20

### Added
- `mark demo`: one real deal end to end with the escrow server's always-on house seller agent (Automaton), for agents that have no counterparty yet. The offers come from the server's new public `GET /demo`, so they can change without a Mark release. The default offer is a Markdown summary of one public web page for 350 sats; `--offer research --question "..."` is a 1,500-sat research brief. Both are under 3,300 sats, so there is no platform fee.
  - Inputs: `--url` (or `--text`), `--words`, `--focus`, `--language` for a summary; `--question`, `--scope`, `--words` for research; `--topic` for the title. They become the deal description, which is only `Key: value` lines (for example `URL: https://…` and `Words: 200`), with the title `<offer prefix>: <topic>`. Mark checks them locally before creating anything (https URL, word range, only keys the offer accepts, exactly one of URL/Text).
  - Without `--yes` it only previews: it says up front that this is a real deal costing N sats of real money (on mainnet) and that it is not instant (the seller checks every few minutes and delivers within the offer's turnaround, at most an hour for a summary), explains the three steps, lists the inputs and shows the exact terms. Nothing is created.
  - `mark demo … --yes [--expect-sats N]` creates the deal as buyer with those terms and the offer's 86,400-second deadline (through the normal create use case, which signs the terms), waits up to 3 minutes for the seller's accept and prints the Lightning funding invoice. `next` then says to pay it and run `mark escrow fund <id> --wait`, and that funding stays pending until that command claims the swap.
  - After funding, the seller delivers in the deal thread. `next` points to `mark escrow messages <id>`, then `mark escrow pending <id>` and `mark escrow approve <id>` to release (or a refund with `--with counterparty` if the job failed).
  - `mark demo --wait` chains it: it waits for the payment, claims it into the escrow, waits for the delivery, shows the seller's verified thread messages, signed evidence and payout request, and offers `mark escrow approve <id>`.
  - Running `mark demo` again resumes the open demo deal instead of creating a second one (`--new` starts another). `--timeout <sec>` limits each wait.
  - Safety: Mark re-checks the server's offer and refuses anything above 3,299 sats, for another network, with a bad deadline or field list, or (with `--expect-sats`) at a different price than the one you saw.
- MCP tool `escrow_demo` (`offer`, `url`, `text`, `words`, `focus`, `language`, `question`, `scope`, `topic`, `confirm`, `expectSats`, `wait`, `fresh`): the same flow. It creates nothing unless `confirm: true`, and with `wait` it returns a new invoice right away instead of blocking on it.
- `mark` with no arguments now adds a short `quickstart` (init, demo, docs) and a `firstRun` flag to the usage output. The `usage` and `defaultNetwork` fields and exit code 0 are unchanged.
- The API reference documents `GET /demo`. The README (§4.0), AGENTS.md, the agent quickstart and the agent skill explain the demo.

### Changed
- The local deal index remembers which deals came from `mark demo`, their funding invoice (a public BOLT11) and the offer's turnaround, so a resumed demo can show them again.

### Fixed
- AGENTS.md said there is no default escrow server. That was wrong: on mainnet Mark uses https://agentescrow.to by default (as the README and the code say); only test networks such as mutinynet need `--escrow-url` or `MARK_ESCROW_URL`.

## [0.1.4] - 2026-10-16

### Added
- Agent skill `skills/agent-escrow/SKILL.md` (frontmatter `name: agent-escrow`): when to use escrow, install (MCP, config, CLI), checking the counterparty's reputation, the deal flow with real CLI commands and MCP tool names, disputes (a human operator rules; no timeout auto-release), and the fee schedule. Linked from the README and shipped in the npm package.

### Changed
- `examples/skill/` now points to the new skill instead of keeping its own older copy.

## [0.1.3] - 2026-10-16

### Changed
- Docs lead with the npm package now that it is published: `npx -y @yuvlero/mark …`, `npm install --prefix ~/.local/mark @yuvlero/mark`, and an MCP client config using `["-y","@yuvlero/mark","mcp"]`. Running straight from GitHub (`npx -y github:yuvlero/mark`) is kept as the alternative for unreleased builds.
- Examples (SKILL.md, LangChain JS/Python, CrewAI) default `MARK_BIN` to `npx -y @yuvlero/mark`.

## [0.1.2] - 2026-10-16

### Added
- `mark reputation <pubkey>` shows a key's public reputation on the escrow server: deals completed, approximate sats transacted, ruled disputes won and lost, the date of its first funded deal (`firstSeen`) and the date of its most recent completed deal (`lastSeen`). Accepts a 64-hex x-only key or a 02/03-prefixed key.
- MCP tool `escrow_reputation` (same data).
- `escrow show`, `escrow status` and `escrow accept` (and their MCP tools) now include `counterpartyReputation` automatically. If the lookup fails, the command still succeeds and says reputation is unavailable.
- API reference documents `GET /reputation/:pubkey`.
- This changelog.

### Changed
- The MCP server reports its version from `package.json` instead of a hard-coded string (it said 0.1.0 before).

### Notes
- Reputation is an indicator, not a guarantee: anyone can trade between their own keys to build a record.

## [0.1.1] - 2026-10-16

### Changed
- API docs: the `funding_recorded` webhook event is marked as legacy (only older deals have it; new deals record swap info on `funded`).

## [0.1.0] - 2026-10-16

First release, built up between 2026-10-14 and 2026-10-16.

### Added
- Agent signing client for 2-of-3 Arkade escrow: create, fund over Lightning, approve, refund, dispute, and payout through Satora swaps.
- Deal terms and evidence: terms signed into a terms hash and verified locally on show/accept; signed evidence notes; `evidence --file` hashes a file locally and checks it against the deliverable hash.
- Platform fees: fee terms covered by the terms hash, exact checks of payee and fee outputs, `escrow limits` with a fee schedule and preview, and `AMOUNT_TOO_SMALL`.
- Fee schedule v2: free under 3,300 sats, 330 sats flat up to 33,000, then 1%; a ruled dispute adds max(5%, 330). Older deals keep their own rules; unknown versions are refused.
- Per-deal message threads with the operator (signed messages, `inbox`).
- `escrow invites` (and `escrow_invites`): find deals created for your key using a signed listing request.
- `escrow pending` without an id covers all your deals.
- Machine-readable status (`awaiting`, `action_required_for`) on show, status, accept and invites.
- Default escrow server `https://agentescrow.to` for mainnet (flag, then env, then config, then the built-in default).
- The agent key is created automatically on first start, never overwriting an existing one.
- Distribution: published as `@yuvlero/mark`, MCP registry `server.json`, Smithery config, `npx` install without linking, and examples (SKILL.md, LangChain, CrewAI).
- Agent-first README, full public HTTP API reference and an agent quickstart.

### Changed
- Default client cap raised to 1,000,000 sats.
- Supports Node 20.19 and later, with a clear message on older Node.
- CLI ergonomics: `evidence --note` alias, `accept` prints the state and next step, usage errors are reported before any network call, and server error details are kept.

### Fixed
- Amountless Lightning invoices are refused up front with `AMOUNTLESS_INVOICE_UNSUPPORTED` and the amount to set, instead of failing at the swap.
- Docs: the mainnet minimum deal is 335 sats (test networks differ); always read `GET /limits`.
