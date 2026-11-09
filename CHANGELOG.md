# Changelog

All notable changes to Mark (`@yuvlero/mark`), the CLI and MCP server for agent-escrow. Dates are UTC+4 (Dubai). Versions follow semver; 0.x releases may change behaviour between minor versions.

## [0.3.1] - 2026-11-09

**Urgent fix for funding.** With Mark 0.3.0 a buyer's claim of the paid Lightning swap into the escrow could fail with `Failed to execute offchain Arkade claim: INVALID_CHECKPOINT_PSBT (2): malformed checkpoint psbt`, and every retry then said only `All VTXOs have already been spent.` The sats were not lost (they sat in the swap or in an unfinished claim), but the deal stayed unfunded. Update Mark itself (see README, "Upgrading to 0.3.1"): `npm update @satora/swap` does not replace the copy Mark's shrinkwrap pins.

### Fixed
- Dependencies: `@satora/swap` ^1.8.1 (was 1.7.0, pinned by the shrinkwrap). It brings `@lendasat/lendaswap-sdk-pure` 2.8.1, which no longer adds the preimage condition witness to the server-signed checkpoint a second time (the duplicate PSBT key Arkade rejected). `@arkade-os/sdk` moves to ^0.5.4, which 1.8.1 needs. `npm-shrinkwrap.json` (shipped in the package) now pins @satora/swap 1.8.1, lendaswap-sdk-pure 2.8.1 and @arkade-os/sdk 0.5.4. Swap storage is unchanged (record version 2), so swaps created by 0.3.0 still load and can be claimed.
- Workaround for an upstream bug still in @satora/swap 1.8.1 (lendaswap-sdk-pure 2.8.1), pending Satora's fix: finishing a claim that was submitted but not finalized failed locally with `checkScript: witnessScript without P2WSH` (a `witnessScript` set on a taproot checkpoint input) and was reported as `All VTXOs have already been spent.`. Only after that exact error, Mark retries the finish step once with that one field dropped from taproot inputs, then restores the library. The claim result says `workaround` when it was used. The same fix finished a stuck mainnet claim.
- `fund` on a swap that still waits for payment shows the same `invoice` again. Before, only the call that created the swap printed it. The invoice is saved next to the swap id; for swaps created by 0.3.0 it is read back from the swap provider while the swap is unpaid. The invoice appears only while the swap's last seen status is `pending`: a paid swap (also in `--wait`'s final result, after a failed claim, on expiry or timeout), a swap that ended, or a swap whose status cannot be read never shows it (`paymentReceived: true`, or `null` when unknown).
- `fund --wait` claims at swap status `clientredeeming` (a claim was started but not finished), not only at `serverfunded`. Before, it polled until `timeout waiting for payment` even though the invoice was paid.
- `fund --wait` stops at once when the claim fails (`claimFailed: true`). The `note` gives the swap status, the library's error, and the next step. It no longer loops until it times out.
- Timeouts name the last swap status, for example `timeout: swap status clientredeeming, claim not finished`, not always `timeout waiting for payment`.
- Real claim errors: when the library only reports `All VTXOs have already been spent.`, Mark asks its finish step directly and returns that error as `claim.detail`.
- Claims and refunds run one at a time per process (the MCP server can get concurrent calls), so the console redirect and the workaround patch never overlap.
- The swap library's `console.log` progress lines (for example "No pending Arkade claim found; submitting a new claim") go to stderr. Before, they went to stdout, into the CLI's JSON output and the MCP stdio stream.
- Swap states in which the swap ended without funding the escrow (refunded, `serverwontfund`, too late, and so on) end `--wait` with that status, not a timeout.

- `mark escrow approve` (release / refund co-signing) under the new dependency tree. @satora/swap 1.8.1's `signEscrowArkTx` / `signEscrowCheckpoints` (its bundled @arkade-os/sdk 0.5.x Transaction) reject the escrow server's spend PSBTs with `checkScript: witnessScript without P2WSH`: the server's builder (ark-rs) puts the tapscript leaf in `witnessScript` on the taproot inputs. 1.7.0 accepted them. Only after that exact error, Mark signs input 0 itself with @scure/btc-signer (script check off). The PSBT keeps all its fields and its txid, and gains one signature, the same shape 0.3.0 produced. Tested on release, arbiter release and arbiter refund PSBTs built by the server's own core. This also affects any Mark 0.3.0 install whose @satora/swap was upgraded by hand, and the escrow server if it moves to @satora/swap 1.8.x.
### Added
- `mark escrow fund <id> --resume-claim` (MCP: `escrow_fund` with `resumeClaim: true`) finishes a pending claim into the deal's escrow address, or submits it again. It works when the swap is `serverfunded` or `clientredeeming` and never creates an invoice. Without a recorded swap it refuses with `NOT_FOUND`; while the swap is unpaid it says there is nothing to resume.
- Tests (mocked swaps, no network): the invoice shown again, `clientredeeming` claimed, a failed claim stopping with the real error, the status in timeouts, `--resume-claim`, the claim wrapper's error surfacing and workaround, a check that the installed library still has the upstream bug (it fails once Satora fixes it, so the workaround can go), and loading a swap record written by @satora/swap 1.7.0.

## [0.3.0] - 2026-11-02

**Breaking (pricing):** the escrow server's fee schedule changes for new deals. Deals up to 33,000 sats pay no platform fee. Above 33,000 sats the fee is 1% of the whole deal amount, rounded up to the next sat (33,001 sats pays 331, 100,000 pays 1,000). The old tiers (free under 3,300 sats, 330 sats flat from 3,300 to 33,000) are gone. The ruled-dispute fee does not change: 5%, at least 330 sats, for deals of 3,300 sats and up, also when the platform fee is 0. Limits stay 335 to 1,000,000 sats.

The fee terms format does not change: the new schedule is the same version 2 fee terms with `flatSats` 0, so Mark 0.2.x checks new deals correctly and keeps working; only its fee wording is out of date. A deal keeps the fee terms it was created with, so deals created under the old schedule keep their old fee.

### Added
- Fee examples in `mark escrow limits` (and MCP `escrow_limits`) include 33,001 sats, the first amount with a platform fee.
- Tests for the new schedule: free up to 33,000, 1% of the whole amount above (rounding), single payout output when the fee is 0, the dispute fee on a zero-fee deal, and old deals keeping their 330-sat fee.

### Changed
- The fee schedule text Mark prints for new deals (`feeSummary.schedule`, `feeTerms`) reads "free up to 33000 sats; above 33000: 1% of the whole amount, rounded up". Deals with the old terms still show the old text.
- MCP instructions and the `escrow_limits` tool description state the new schedule.
- README (quick start, fee table, examples, JSON samples), `docs/escrow-api.md` (fee math, samples) and the agent skill (`skills/agent-escrow/SKILL.md`) state the new schedule. The house-seller demo still stays under 3,300 sats, where nothing at all is charged.

## [0.2.4] - 2026-11-02

Clearer first steps: every first-run output says what to try next, commands are printed the way you started Mark (npx or not), and an agent using the MCP server now learns that its key was just created.

### Added
- A top-level `next` sentence in the output of `mark` (no arguments), `mark init` and `mark pubkey`: "Next: try one real deal (350 sats, about 10 min, preview first, nothing is created): mark demo --url https://example.com. To pay you need a Lightning wallet with about 400 sats, e.g. Bark: https://second.tech/docs/getting-started/bark-cli".
- The `mark demo` preview notice on mainnet ends with the same wallet line, sized to the offer (about 400 sats for the 350-sat demo).
- MCP: the server instructions now start with first-run guidance. If the server created the agent's key in this session they say so and where (for example `~/.mark/bitcoin`), and ask the agent to tell its human to back it up (`mark backup` in a terminal); otherwise they say where the keys live. Then: no counterparty yet, call `escrow_demo` (a free preview, nothing is created) and show the human the 350-sat house-seller deal; paying needs a Lightning wallet, e.g. Bark.
- MCP: when the server created the key, the first tool result of the session gets a `keyNotice` field with the key folder, the pubkey and the backup command. Before, this notice only went to stderr, which agents never see.
- README: a "Try a real deal in about 10 minutes" section at the top with the five commands of the house-seller demo, what you need (Node 20.19+, a Lightning wallet with about 400 sats) and what happens if nothing is delivered.

### Changed
- When Mark runs through npx (npm's `_npx` cache, or `npm exec`) and no `mark` command is on PATH, the commands Mark prints use `npx -y @yuvlero/mark ...` instead of `mark ...`, so they can be copied as they are. This covers the new `next` lines, the quickstart steps, the `init` backup note, the demo steps and hints, and most `next` / note hints of the escrow commands. Usage strings still say `mark`.
- package.json and server.json descriptions: "dispute protection for agent-to-agent payments" (package.json also says "Try: npx -y @yuvlero/mark demo").
- MCP instructions mention `escrow_demo` once, at the top, instead of at the end.

### Fixed
- `mark demo --help`, `mark escrow --help` and `mark escrow <subcommand> --help` (also `-h` or `help`) print the usage and exit 0, instead of failing with "--help needs a value". `--help` on any other command prints the usage and does nothing else, so `mark init --help` no longer creates a key.
- README: the install section no longer says the dependency tree has no native addons. It has one optional native module, `better-sqlite3` (via `@satora/swap`), which Mark never loads; npm may print a `prebuild-install` warning while installing it. `npm install --omit=optional` skips it.

## [0.2.3] - 2026-10-26

Mark now tells the escrow server its version and shows an update notice when the server recommends a newer one, and `show` / `status` show when a seller must open a dispute before the buyer can take an automatic refund.

### Added
- Mark sends its version on every request to the escrow server: the header `x-mark-version: <version>` and `User-Agent: mark/<version>`. The version is read from `package.json` at runtime, so the CLI and the MCP server always send the installed version.
- Update notice. Mark reads the server's version policy from `GET /limits` (`client.minMarkVersion`, `client.latestMarkVersion`) and caches it per escrow URL for 6 hours in `<data dir>/version-policy.json`. Commands that already read `/limits` refresh it; otherwise Mark makes at most one extra `/limits` request every 6 hours, with a 2-second timeout so a command never waits long before exiting. If that request fails, Mark waits 15 minutes before trying again, and remembers this across CLI runs in the same file (mode 600). When this Mark is older than the latest version, the CLI prints one `mark: …` line on stderr (stdout stays JSON) and MCP results get an `updateNotice` field, with the update command (`npx -y @yuvlero/mark@latest`) and how to update an MCP config. The server can suggest its own update text, but Mark shows it only if it is exactly `npx -y @yuvlero/mark[@tag]` or `npm install -g @yuvlero/mark[@tag]` (or, for MCP, a plain sentence about `@yuvlero/mark`); control characters and terminal escape codes are removed, and anything else is replaced by Mark's built-in instructions. An `updateNotice` field inside a server response is dropped, so only Mark can add one. Mark never updates itself.
- New error code `UPGRADE_REQUIRED` (HTTP 426): the server no longer accepts this Mark version. The error shows the server's message, marked as coming from the server, and always ends with Mark's own update instructions (missing or invalid fields in the server's answer never show up as "null"). See the README error table and `docs/escrow-api.md` §7.
- Deadline countdown for both roles. `mark escrow show` and `mark escrow status` (MCP `escrow_show`, `escrow_status`) now print `deadlineCountdown`: the auto-refund deadline, `disputeBy`, `secondsLeft`, whether it has passed, and a note for your role. A seller who delivered to a buyer who went quiet sees that it must open a dispute before `disputeBy`, and is told to dispute now once the deadline has passed. When no refund clock applies (not funded yet, final, disputed, ruled, manual arbiter mode, or above the server's auto cap) `status` is `not_applicable` with a `reason`. A deal state Mark does not know (from a newer server) is `unknown_state`, never `final`, and a deal without a deadline gives `deadline: null` (`bad_deadline`). Only the server knows its auto cap, so "above the auto cap" comes from the server's own field; Mark labels it `aboveAutoCapSource: "server"` and still gives a seller the dispute-by time it would otherwise have, in case the claim is wrong. Mark computes it locally with the same shared logic as the server (`src/core/deadline.ts`), so it also works with servers that do not send it. `mark escrow invites` items show the server's `deadlineCountdown` when the server sends one.
- `deadlineCountdown` now recommends an earlier `disputeBy`, so sellers keep a safety margin: the refund deadline minus 10% of the funded window (funding time to deadline), at least 60 s, at most 24 h, and never more than half the window (for windows under 2 minutes the half-window cap wins, so the margin is under 60 s). New fields: `secondsRemaining` (seconds to `disputeBy`), `disputeByPassed` and `disputeMarginSec`. `deadline`, `autoRefundAt` and `secondsLeft` (seconds to the deadline) are unchanged. The seller note now reads "Dispute by <time> (recommended, leaves a margin); the refund can be paid out from <deadline>." Once the recommended time has passed but the deadline has not, it says to dispute now.
- `docs/escrow-api.md` §7 "Client versions & deprecation policy"; README: how to update, and the `UPGRADE_REQUIRED` row in the error table.

### Changed
- `docs/escrow-api.md`, the agent skill and the README describe `deadlineCountdown`. The skill tells sellers that delivering does not stop the refund clock.
- `TERMS_HASH_MISMATCH` in the README error table now says to update Mark first if it printed an update notice.

### Fixed
- Security: `body-parser` 2.3.0 -> 2.4.0 (CVE-2026-111181 / GHSA-27r3-jxmh-p828, DoS via trailing bytes after a compressed request body) and `fast-uri` 3.1.8 -> 3.1.9 (GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp, GHSA-xhq7-xmqj-769h, URI parsing issues), with `qs` 6.16.0 -> 6.16.1 as required by the new `body-parser`. All three are transitive via `@modelcontextprotocol/sdk` and locked in `npm-shrinkwrap.json`. Mark was not exposed: it runs the MCP server over stdio only, so the SDK's Express/HTTP code (where `body-parser` lives) is never loaded, and `fast-uri` is only used by `ajv` on Mark's own tool schemas.

## [0.2.2] - 2026-10-22

### Changed
- Listing nonces (`mark escrow invites`, MCP `escrow_invites`, the signed `GET /escrows?party=`) now come from Node's `crypto.randomBytes`: 16 random bytes, 32 hex characters, never based on the clock. They were already 16 random bytes from WebCrypto; this makes the source explicit and tests it.
- `docs/escrow-api.md`: the `GET /demo` example shows the server's new URL limit (2,000 characters), and the listing section says how to handle a replay refusal.

### Fixed
- A deal listing could fail with `nonce already used (replay)` and only work again on the next call. This happens when the same signed request reaches the server twice, for example when a proxy re-sends it. Mark now signs the listing again with a new timestamp and nonce and retries it once. Only this read-only listing is retried, and only on a replay refusal; other errors and every write are never retried.

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
