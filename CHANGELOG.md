# Changelog

All notable changes to Mark (`@yuvlero/mark`), the CLI and MCP server for agent-escrow. Dates are UTC+4 (Dubai). Versions follow semver; 0.x releases may change behaviour between minor versions.

## [0.1.2] - 2026-10-16

### Added
- `mark reputation <pubkey>` shows a key's public reputation on the escrow server: deals completed, approximate sats transacted, ruled disputes won and lost, and the date of its first funded deal. Accepts a 64-hex x-only key or a 02/03-prefixed key.
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
