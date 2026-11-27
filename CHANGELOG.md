# Changelog

All notable changes to Mark (`@yuvlero/mark`), the CLI and MCP server for agent-escrow. Dates are UTC+4 (Dubai). Versions follow semver; 0.x releases may change behaviour between minor versions.

## [0.7.1] - 2026-11-27

### Fixed
- **`mark escrow quote` without `--dest` recommended an invoice amount that failed at `approve` with `AMOUNT_MISMATCH`.** The no-dest quote used Satora's generic `/quote.net_target_amount`, whose `network_fee` is a padded estimate (live: 30 sats on a 1,000-sat deal), then subtracted another 20 sats / 1% "safety margin". That put the recommended amount — and often the whole estimate range — below the exact range `/quote/lightning-send` uses at approve time. Live: Automaton's 1,000-sat self-test recommended 948 (range 947–967) but the exact range was 971–991 (recommended 989); the same gap showed up on a 1,200-sat deal (1,149 vs 1,168–1,192). The estimate is now priced with Satora's live protocol fee plus typical Lightning routing (0.5%, at least 6 sats), and `recommendedInvoiceSats` is 2 sats below that, the same margin as an exact quote. For those two live cases the new recommended amounts (989 and 1,188) fall inside the exact approve ranges. Prefer `--dest` for the exact route-specific amount; if `approve` still returns `AMOUNT_MISMATCH`, use the exact `recommendedInvoiceSats` it returns. (The fix is in `escrow-server`; this Mark release documents it and must be deployed with that server.)
- **`mark escrow fund --wait` printed `No pending Arkade claim found; submitting a new claim`** before succeeding. That line is `@satora/swap`'s normal first-claim path (it tries to resume, finds nothing, starts a new claim). Mark already sent the library's `console.log` to stderr; it now also swallows this one known line so it no longer looks like an error. Other library progress still goes to stderr, never stdout.
- **`mark escrow approve --wait` and `mark escrow refund --wait` (MCP `escrow_approve` / `escrow_refund`) no longer return a `USAGE` error on Lightning or Ark payouts.** `--wait` now waits until the deal is released/refunded and the payout settles: Lightning invoice paid, Ark complete, or (as before) stablecoins claimed. A co-signer can also pass `--wait`. If the other signer has not signed yet, or the Lightning payout swap has not settled, it times out cleanly with a status and a next command (default 15 minutes, `--timeout` to change it).

### Changed
- Help text, MCP tool descriptions, the agent skill, README and `docs/escrow-api.md` describe the typical-routing estimate and `--wait` on any payout.

## [0.7.0] - 2026-11-26

### Added
- **Escrow with stablecoins at the edges** (mainnet). The escrow itself stays bitcoin (sats on Arkade, same 2-of-3 contract, same fees); Mark wraps Satora's single-hop swaps around it. Fee for each swap: about 1% (Satora ~0.5% + Agent Escrow 0.5%) plus network fees; USDC on Base also pays Circle's CCTP fee.
- `mark escrow fund <id> --from usdc|usdt0|usdc-base [--wait] [--timeout <sec>] [--switch-rail] [--allow-counterparty-rule]` (MCP `escrow_fund` with `from`): Satora swaps the stablecoin into the deal's sats, paid straight to the escrow address. Mark runs every funding check of the other rails first (terms hash, arbiter attestation, escrow address, rule, expired/already funded), prices the deposit so its net payout covers the exact deal amount, plus a cushion (0.5%; 1.5% for USDC on Base) so a price tick cannot underpay it, and refuses (`SWAP_FAILED`, "Do NOT deposit") a swap that pays less than the deal amount, far more, or is not on this deal's Arkade server. The result discloses the deposit address, exact token amount, swap fee, escrow fee, gas for `usdc-base`, and a round-trip note. `--wait` locks the deposit and claims the sats into the escrow, but only while the deal still waits for funding (an expired or already funded deal is never claimed into; the stablecoins come back with `mark swap refund` / `mark swap recover`). `DEADLINE_TOO_CLOSE` under 30 minutes before the deal expires (60 for `usdc-base`). One rail per deal: `fund` and `fund --ark` refuse after `--from` (and `--from` after them) unless `--switch-rail`. A swap that funds a deal is claimed only through `escrow fund --from --wait` (`mark swap claim` and `mark swap fund --wait` refuse it), and a deal funded by another payment is never reported as this swap's funding (`fundedBySwap`). The disclosed platform fee is computed on what the swap pays into the escrow (the cushion can cross a fee tier). Over MCP (no way to show instructions mid-call) `wait` on a fresh swap returns the deposit instructions instead of waiting.
- `mark escrow approve|refund <id> --payout-stable usdc|usdt0|usdc-base --payout-address 0x… [--wait]` (MCP `payoutStable` + `payoutAddress`): the payee leg pays a Satora Arkade → stablecoin swap created for exactly that amount, to that EVM address, on this escrow's Arkade server (checked before proposing). Proposed as payout `{type: "stable", swapId, address, token}`. A co-signer's Mark checks the swap at Satora before signing (direction, unpaid, exact payee leg, EVM address, VHTLC = tx destination; `UNSAFE_TX` otherwise, fails closed when Satora can't be read). Before signing its own proposal, Mark checks the server returned exactly that proposal (kind, VHTLC destination, swap id, EVM address, token; `UNSAFE_TX` otherwise). Mutually exclusive with the other payout flags; `wait` (CLI and MCP) only goes with a stablecoin payout.
- `mark escrow claim-payout <id> [--wait] [--timeout <sec>]` (MCP `escrow_claim_payout`): claim the stablecoins (gasless) once the payout tx is out. It claims the swap of the proposal that was actually submitted (as does `refund-payout`); the local record is written only after the server accepted the proposal. `refund-payout` also covers a stablecoin payout swap that never paid out.
- `mark escrow quote <id> --payout-stable usdc|usdt0|usdc-base` (MCP `escrow_quote` with `payoutStable`): preview the payee leg, fees and what arrives; nothing is created.
- `mark escrow status` shows the stablecoin funding swap (`fundStableSwap`) and, for a stablecoin payout, how to claim it.
- Needs an escrow server that accepts payout type `stable` (Agent Escrow, with this release).
- **`mark feedback "<message>"`** (MCP `feedback`): report a bug, or send feedback or a feature request, to the Agent Escrow team (`POST /feedback` on the escrow server). Options: `--message`, `--type bug|feedback|feature` (default `feedback`), `--command`, `--error-code`, `--contact`, `--no-meta`, `--server` (default: this network's escrow URL). Sends the message, the fields given and, unless `--no-meta` (MCP `includeMeta: false`), Mark's version, the Node version and the platform. It never reads or sends keys, the backup phrase, wallet files, balances, deal data, tokens or environment variables (to find the server it reads only the config's `escrowUrl` and `MARK_ESCROW_URL`, and sends neither), needs no key (none is created), and refuses obvious secrets in the text (new code `SECRET_IN_FEEDBACK`). Other new codes: `BAD_FEEDBACK` (empty, too long or bad type), `FEEDBACK_UNSUPPORTED` (server has no `/feedback`).

### Notes
- `create` stays in sats (no `--usd` in this release); quotes, funding and payouts show live USD estimates.
- Funding through a swap is recorded by the server like a Lightning funding through a swap.
- Live-tested on mainnet before release (26 Nov 2026), which fixed four funding details:
  - The deposit is priced from Satora's quote for that deposit, because a quote for a sats amount includes the swap fee in that amount. Before the fix, a 2,000-sat deal got a swap paying 1,977 sats, and Mark refused it before any deposit.
  - USDC on Base gets a 1.5% deposit cushion, because Satora's bridged swap paid about 0.6% below its own quote. Arbitrum USDC and USDT0 keep 0.5%.
  - Satora's created swap can still pay a little less than its own quote (live: a USDT0 deposit quoted 1,206 sats, the swap paid 1,197 for a 1,200-sat deal). Mark now drops that swap before showing it (it expires unfunded) and retries once, raising the deposit by exactly the shortfall plus 0.3%, capped at 5% above the priced deposit. Before the retry it re-checks that the deal is still unfunded with enough time left, and re-quotes the new deposit. If the second swap is also short, Mark refuses with `SWAP_FAILED` and nothing is deposited. The result reports the retry as `swapRetry`.
  - Satora can lower an Arkade payout slightly once the deposit is locked (live: 2,002 to 2,001 sats). Mark accepts a drop of up to 1% and claims into the escrow only while the swap still covers the deal.

## [0.6.1] - 2026-11-25

### Added
- `mark swap` from **USDC on Base** back to BTC: `--from usdc-base --to lightning|arkade` (MCP `swap_to_btc_quote` / `swap_to_btc_create` with `from: "usdc-base"`). Satora's client carries the USDC over Circle's CCTP to its settlement chain and locks it there. `mark swap routes` / `swap_routes` now list **fourteen** routes (`usdc-base→lightning`, `usdc-base→arkade`, with a `bridge` field naming the gas they need: `ETH on Base`). Same Satora pair fee, referral ID and 50 bps `extraFees` (cap 100) on the quote and the swap.
- How it is funded: the agent sends the USDC on Base, plus a little ETH on Base once, to this Mark home's own deposit address (the same 0x address as the Arbitrum deposits). `mark swap fund` signs two Base transactions from the deposit key, a USDC `approve` (exactly the amount) and Circle's `depositForBurn` (gas paid in ETH on Base by the deposit address). The swap library then waits for Circle's attestation and mints and locks with one paymaster-sponsored transaction (no ETH needed there).
- **ETH pre-check before anything is signed:** Mark estimates the Base gas with headroom (live gas price ×3 plus the L1 data fee ×2, for 80,000 + 200,000 gas; a USDC approve is typically under 60,000 and a burn measured about 109,000) and reads the deposit address's ETH and USDC on Base. If the ETH is short, `fund` fails with the new code **`SWAP_NEEDS_GAS`** and details `needEth`, `holdsEth`, `sendEth`, `network`; nothing is signed. `--wait` keeps waiting while the ETH is short and ends with `SWAP_NEEDS_GAS` at the timeout.
- Quotes and previews for USDC on Base show Circle's fee (`fees.bridgeFee`, `bridgeFeeUnits`, `bridgeFeeToken`; about 0.02% of the amount, taken from the deposit) and the estimated Base gas (`gas.eth`, `gas.wei`, and `gas.usd` when the swap library's CoinGecko price answers within 5 s). The deposit shows `gas.needEth`, `holdsEth` and `sendEth`.
- Funding at most once: once the burn is sent (recorded by the swap library), a later `fund` only resumes the settlement from that burn (no second burn, no gas), and never again once the lock is recorded. A burn the swap library recorded is resumed even if this home lost its funding time. A failed attempt is retried only when Mark's signer sent nothing at all in it (every Base transaction goes through a counter); anything else stays uncertain and is never signed again (`recover` works 30 minutes later). Mark also keeps its own record of what its signer sent (`bridge-sends.json` in the swaps dir: the burn hash, or a send of unknown outcome, marked before each send goes out so a crash mid-send leaves it, and the USDC and the expected transaction count): a burn the swap library failed to record is never funded again and is recovered on the settlement chain from that burn hash; whenever such a record exists, `recover` sweeps on Base only when the deposit address's transaction count is unchanged since before the attempt (nothing of it was sent; a balance is no proof, the address is shared), and otherwise refuses and points to the burn. A burn only Mark recorded is shown by `status`, refused by `fund` (which restarts the 30-minute recover clock if the funding time was lost), and recovered on the settlement chain. An unreadable local swap record refuses `fund` and `recover` (never read as "no burn").
- Recovery: before the burn, `mark swap recover <id> --to <0x>` sends the USDC back on Base (one ERC-20 transfer; gas-checked the same way). After the burn, `recover` (30 minutes after the attempt) has Circle mint it if needed and sends it as USDC on the settlement chain (Arbitrum One) to the same address, both sponsored, no ETH. A locked deposit that did not pay out: the existing gasless `mark swap refund <id>`, then `recover`.
- Before showing a deposit address, Mark checks that Satora's swap is a Base-sourced swap of exactly USDC on Base (`bridge_source_chain` `Base`, the Base USDC contract), locked as USDC on the settlement chain, gasless, for this home's own address and the confirmed amount and payout; the bridge source is recorded with the other confirmed terms and checked again on every later command.
- Quote and create refuse a Base quote without Circle's fee (`QUOTE_UNAVAILABLE`; nothing is created) and create refuses a swap provider that cannot read Base or track the burn (`BAD_CONFIG`). `recover` of a burn with no funding time in this home refuses (`SWAP_FUNDING`) and says to run `fund` first, which resumes and records the time.
- `mark swap routes` summary: "Paid inside the swap; nothing extra to send, except a little ETH on Base at the deposit address for a swap from USDC on Base" (`SWAP_FEE_PAID_NOTE`, from the token table).
- Fee sentence for all routes (`SWAP_FEE_ALL_ROUTES_NOTE`, docs, skill, MCP): one constant `SWAP_FEE_BRIDGE_IN_NOTE` for the Base-to-BTC costs.
- Agent skill (`skills/agent-escrow/SKILL.md`) and MCP server instructions: a **Jobs found on other boards** section for a job taken or posted on The Colony, AIBTC, Nostr, or any board with weak or no escrow. Create or accept an Agent Escrow deal and paste the escrow id in the bid or thread (there is no public invite URL); paste-ready text is in the skill. Do not create or fund a deal the other side has not agreed to. The short paragraph is one constant, `MCP_JOBS_ON_OTHER_BOARDS` in `src/mcp.ts`, appended to `MCP_BODY` and included verbatim in the skill (buyer/seller steps, paste text and fee recap stay in the skill only). Mark is described as the open-source client for the Agent Escrow service at https://agentescrow.to.

### Fixed
- `mark swap --from usdc-base --to lightning --invoice …`: the preview now prices the swap with Satora's exact Lightning quote on the settlement chain (Arbitrum One), plus Circle's fee from the Base quote. Before, Satora's exact quote refused the Base chain and the swap library fell back to an estimate about 2.5% low, so the create was refused by Mark's 1% check (found in the live test; nothing was deposited or signed).
- Skill frontmatter `description` is quoted. The unquoted colon in "can't trust: holds payment…" made the `yaml` parser used by skills.sh / `npx skills add yuvlero/mark --skill agent-escrow` reject the file, so the listing said the skill "isn't available in this repository" even though `skills/agent-escrow/SKILL.md` was in the repo (name matches the directory; layout was already correct).

## [0.6.0] - 2026-11-25

### Added
- `mark swap` pays out **USDC on Base** too: `--to usdc-base` (MCP `swap_quote` / `swap_create` with `to: "usdc-base"`), from Lightning or Arkade. Satora settles the swap in USDC on Arbitrum One and, at the (gasless) claim, Circle's CCTP carries it to the same 0x address on Base (native USDC `0x8335…2913`, chain 8453). Same Satora pair fee, same referral ID and 50 bps `extraFees` (cap 100) on the quote and the swap. Circle's bridge fee (about 0.05 USDC) is in USDC, taken from the payout, and shown in every quote and preview (`fees.bridgeFee`, `fees.bridgeFeeUnits`, `markupNote`, and a `bridge` block); `receive` is after it. Mark refuses to create the swap if Satora's quote has no bridge fee. `mark swap routes` / `swap_routes` now list twelve routes (`lightning→usdc-base`, `arkade→usdc-base`, with a `bridge` field).
- Before showing anything to pay, Mark checks that Satora's swap settles in USDC on Arbitrum One and bridges to exactly USDC on Base (and that an Arbitrum payout does not bridge anywhere); otherwise `SWAP_FAILED`. For a Base payout, `payoutTx` is the claim on Arbitrum One (Arbiscan); `mark swap status` / `claim` add a Basescan link to the payout address and the Base delivery tx once Satora reports it, and never read the Arbitrum claim as the amount received. `expectedReceive` is never above the quote's amount after the bridge fee.
- docs: Glama score badge

### Changed (review pass, no behaviour change)
- Swap token / network data comes from `SWAP_TARGETS` in one place: Arbitrum One's chain id, name and explorer are one `ARB` entry; a bridged payout names its settlement network (`bridge.settleNetwork`), so bridge notes no longer hard-code "Arbitrum One". New derived texts `SWAP_PAYOUTS_TEXT`, `PAYOUT_NETWORKS_TEXT`, `STABLE_FLAGS` / `STABLE_OR` feed the CLI usage flags, the `--address` error (a lookup, not an `if usdc-base` branch) and the MCP payout lists. Longer explanatory prose in the help and MCP descriptions still names the networks by hand. Output text is unchanged (CLI help and errors compared byte for byte against the previous build).
- `mark swap claim --wait` reuses the read it already made to find the swap's direction as the first wait round (one fewer Satora call before the claim).
- CLI swap checks lower-case `--from` / `--to` once instead of on every line; two unused imports removed.
- Tests: derived wording, the single read before a waited claim, and a docs check that README, the agent quickstart and SKILL.md carry the code's per-route fee sentences verbatim and every payout key.

### Live test (25 Nov 2026, 08:44 Dubai)
- 5,000 sats Lightning → USDC on Base (swap ee534bfe): quote 2.850531 USDC after Circle's 0.054957 USDC fee; 2.851141 USDC arrived on Base about 30 s after paying (Arbitrum claim 0xf209e0df…, Base mint 0xe8cd8553…). `mark swap status` / `claim` now label the raw Arbitrum amount as `bridge.bridgedAmount` and say Circle's fee comes out of it, so it is not read as the amount that arrives on Base.

### Changed
- Swap text names each route's network instead of assuming Arbitrum: quotes, previews, `--to` / `--address` errors, CLI usage, MCP tool descriptions, README, quickstart and skill (e.g. "USDC on Base", "USDT0 on Arbitrum One").

### Not supported
- USDC on Base → BTC. Satora funds a Base-sourced swap with a CCTP burn signed on Base, which needs ETH on Base at the deposit address (not gasless). `--from usdc-base` is refused with a clear message; swaps from a stablecoin stay on Arbitrum One (`--from usdc|usdt0`).

## [0.5.2] - 2026-11-23

### Added
- Dockerfile and `glama.json` so Glama can build and grade the MCP server. The image runs `mark mcp` over stdio as a non-root user, with `MARK_HOME` on a volume so the agent key never leaves that directory. A Cursor plugin manifest (`mcp.json` and `.cursor-plugin/plugin.json`) packages the MCP server with the existing agent-escrow skill. Optional `llms-install.md` for one-click MCP marketplace installs.

### Changed
- `@satora/swap` is now **1.11.1** (was 1.8.1), pinned by `npm-shrinkwrap.json`. The swap implementation now ships inside `@satora/swap`, so `@lendasat/lendaswap-sdk-pure` is no longer a runtime dependency. Official 1.11.1 builds include Satora's default account-abstraction config (bundler and paymaster) used for gasless Arbitrum funding.
- Other non-major dependencies in the same release: `@arkade-os/sdk` ^0.5.13 (was 0.5.4; 1.11.1 needs at least 0.5.5). Mark only uses `ArkAddress`, whose decode/encode/`pkScript` API is unchanged; no public exports were removed between 0.5.4 and 0.5.13. New 0.5.x wallet features (on-chain cosign, Executor delegation, a compiler entry) are unused here. `@modelcontextprotocol/sdk` ^1.32.2 (was 1.32.1): Transport optional properties accept `undefined`, and tools can be registered after `connect()` when the capability was declared. `viem` is **2.58.4** (was 2.52.2, exact pin) for Mark's recovery-sweep signer only. Breaking viem changes in this range are in optional `viem/tempo` APIs Mark does not use. `@satora/swap` still pins `viem` 2.52.2, so that copy stays nested under it; Mark does not override it.
- On Arbitrum, a gasless swap from a stablecoin is funded by Mark's Satora client itself (a paymaster-sponsored transaction from this Mark home's deposit key; no ETH). The old server relay is no longer used on that chain. Before creating such a swap or showing a deposit address, Mark checks Satora's funding plan (`gaslessFundingPlan`) and refuses if the deposit could not be moved later (for example if the paymaster is missing, or the plan would need ETH on the deposit address). User-facing fund text no longer says "Satora's relay".
- `mark escrow approve` uses `@satora/swap` 1.10.1+'s own signers first, which now accept the escrow server's PSBTs (they drop the stray `witnessScript` on taproot inputs). Mark still has a fallback if that exact old error returns.

### Fixed
- The local workaround for resuming a pending Arkade claim (`src/swap/satoraWorkaround.ts`) is gone. Satora 1.11.1 fixed that bug (satoraHQ/satora-sdk#6): `continueArkadeClaim` no longer sets `witnessScript` on taproot checkpoints, and a resume error is no longer hidden as `All VTXOs have already been spent.`
- After a failed gasless funding, Mark only treats the exact 1.11.1 pre-submit refusals (and a previous UserOp that the library already dropped after a revert) as safe to retry. An unknown outcome, or a submitted UserOp with no transaction hash, stays uncertain so Mark does not sign again.

## [0.5.1] - 2026-11-23

### Added
- `mark swap` now also swaps **Lightning ↔ Arkade** both ways, still standalone and non-custodial (keys stay in this Mark home). `mark swap quote --from lightning --to arkade --sats N` / `mark swap --from lightning --to arkade --sats N --address <ark address> [--yes] [--wait]`, and `mark swap quote --from arkade --to lightning --sats N` or `--invoice <bolt11>` / `mark swap --from arkade --to lightning --invoice <bolt11> [--yes] [--wait]`. Same referral ID and 50 bps `extraFees` (cap 100) on every getQuote and createSwap. `mark swap routes` and `swap_routes` list these as the ninth and tenth routes (`lightning_to_arkade`, `arkade_to_lightning`). Lightning to Arkade pays a hold invoice, then `mark swap claim` to the Ark address; Arkade to Lightning prints an Arkade VHTLC address to fund (not Bark / Second) and Satora pays the invoice. Refunds for Arkade-funded rail swaps use `mark swap refund <id> --to <ark address>` after the timelock; a Lightning hold invoice just expires.

### Changed
- Lightning ↔ Arkade live-test fixes: after create, the lock is checked against the quote's `net_source_amount` (falling back to `source_amount`), so an invoice-pinned Arkade→Lightning quote is not refused when those two differ. Preview `next` text no longer includes the raw bolt11. `mark swap` create for Lightning→Arkade echoes `payoutArkAddress`. A finished Arkade→Lightning swap says "Lightning invoice paid," not that sats were sent to an Ark address. The Arkade-source pay instructions warn that change below the Arkade vtxo minimum (330 sats on arkade.computer) may be taken as a fee.
- The update notice (CLI stderr and MCP `updateNotice`) now appends an optional one-line "what's new" from the escrow server (`GET /limits` → `client.latestMarkHighlights`). Example: `Mark 0.5.0 is available (this is 0.4.3): adds mark swap, sats to USDC/USDT. Update: …`. Mark treats the line as display-only: control characters and ANSI are stripped, the text is capped at 140 characters, and it is never interpreted as a command. If the field is missing or invalid, the notice is unchanged. Older Mark versions ignore the extra field.
- Swap quotes now state the **total fee** as a rate, not only the 0.5% Agent Escrow markup. Every quote (stablecoin both ways and Lightning ↔ Arkade, CLI and MCP) includes `fees.totalFeeRate`, `fees.totalFeePercent` and `fees.satoraFeePercent`, computed from Satora's live `protocol_fee_rate` plus the markup, and a `markupNote` like `Total fee: 1% (Satora 0.5% + Agent Escrow 0.5%) plus 7 sats network fee` (or `0.65%` / `0.80%` on the Lightning ↔ Arkade routes). The numbers always come from the quote, never from a hard-coded 1%.
- Fee wording is route-specific. Lightning or Arkade to USDC or USDT0 (and back) is about 1% total (Satora ~0.5% + Agent Escrow 0.5%) plus network fee. Lightning to Arkade is about 0.65% total (Satora ~0.15% + Agent Escrow 0.5%) plus network fee. Arkade to Lightning is about 0.80% total (Satora ~0.30% + Agent Escrow 0.5%) plus network fee (the quote's Lightning network fee; `/network-fees` can differ). `mark swap routes`, CLI help, MCP tool descriptions, the README, the agent quickstart, AGENTS.md and the skill use that combined note when no single live rate is shared by every route. When `mark swap routes` can read Satora's live pair rate from the same probe quotes it already fetches, each route shows that rate and the summary note uses it only when every route agrees.

## [0.5.0] - 2026-11-23

**New: `mark swap`** turns bitcoin (Lightning or Arkade) into USDC or USDT0 on Arbitrum through Satora, and back: USDC or USDT0 on Arbitrum into BTC over Lightning or to an Ark address, gasless. It is standalone: no deal and no escrow server involved. A 0.5% Agent Escrow fee is added, and every quote shows it.

### Added
- `mark swap quote --sats N [--from lightning|arkade] [--to usdc|usdt0]`: rate, what you receive, Satora's fee, the 0.5% Agent Escrow markup, the network fee and the total. Nothing is created.
- `mark swap --sats N --address <0x...> [--yes] [--wait] [--timeout sec]`: without `--yes` it only previews. With `--yes` it creates the swap and prints the Lightning invoice (or the Ark address and exact sats) to pay once. `--wait` claims the stablecoins to your address as soon as Satora funds its side (gasless) and prints the payout tx with an Arbiscan link.
- `mark swap status <id>`, `mark swap claim <id> [--wait]` and `mark swap refund <id> --to <ark address>` (Arkade-funded swaps only, after the timelock).
- MCP tools `swap_quote`, `swap_create` (needs `confirm: true` to create), `swap_status`, `swap_claim` (with `wait`) and `swap_refund`.
- Every swap quote and every swap carries Agent Escrow's public Satora referral ID `lnds_29617a89f8a6b5a7` and the same 50 bps markup (`extraFees`). The markup is one constant. Mark refuses anything above 100 bps, and Satora caps the key at 100 bps too.
- Before showing anything to pay, Mark checks the swap Satora created: new and unpaid, source, token contract and chain, payout address, amount, a promised stablecoin amount at most 1% below the quote, and the invoice (network and amount) or Ark address. A mismatch is refused with `SWAP_FAILED`. Once a payment is seen, status and claim say not to pay again.
- Payout addresses are checked: 0x plus 40 hex, and a valid EIP-55 checksum when the address is mixed case. Mainnet only (Satora has no Arbitrum stablecoin route on mutinynet).
- `mark swap routes` and MCP tool `swap_routes`: all eight supported routes (Lightning or Arkade to USDC or USDT0 on Arbitrum, and back) with token contract, chain and Satora's live minimum and maximum in sats, plus the 0.5% Agent Escrow fee note. Read-only: it asks Satora for a quote per route and never creates a swap. If Satora cannot be reached, or on mutinynet, the routes are still listed and the limits show as unavailable.
- Stablecoin to BTC: `mark swap --from usdc|usdt0 --to lightning --invoice <bolt11>` and `--to arkade --address <ark address> --amount <tokens>`; `mark swap quote` takes the same flags, or just `--amount`. Lightning addresses are not taken as a payout: Mark could not check the invoice Satora would fetch for one. Gasless: the swap is created with `gasless: true` and this Mark home's own EVM key (kept in the encrypted swap storage) as the depositor, so no wallet and no ETH are needed. Mark prints the deposit address, the exact amount and the token; once the deposit is there it signs the permits and Satora's relay locks it (`mark swap fund <id> [--wait]`, or `--wait` on create). Same referral ID and 50 bps `extraFees` on the quote and the swap, the same 100 bps cap, the fee shown in sats.
- Before showing a deposit address, Mark checks the swap: new and unfunded, gasless, Arbitrum One, the token contract, this Mark home's own deposit address, the exact amount (or at most 1% above the quote for an invoice), the payout target (exactly your invoice, or your Ark address on the swap's Arkade server) and sats at most 1% below the quote. Otherwise `SWAP_FAILED`.
- Funding happens at most once: concurrent calls share one, and a submitted or uncertain funding is never signed again (only a clear relay refusal allows a retry); if Satora never sees it, `mark swap recover` works 30 minutes after the attempt. Mark funds only while the payout invoice has at least 5 minutes left. Once funds are seen at the deposit address, Mark never asks for a deposit again; a partial deposit asks only for the missing part. One waiting deposit per Mark home at a time (`SWAP_OPEN_DEPOSIT`), since all such swaps share the deposit address. Create, fund and recover run under a per-home lock file, so two processes cannot both create or both fund (`SWAP_BUSY` if the lock stays held); the funding re-checks the swap, the deposit and the last attempt under that lock.
- Recovery: `mark swap refund <id>` returns a locked deposit that did not pay out to the deposit address (Satora's collaborative refund, else the sponsored refund after the timelock; gasless). `mark swap recover <id> --to <0x address>` sends the stablecoins at the deposit address to your address; it needs a little Arbitrum ETH there and says how much first.
- MCP tools `swap_to_btc_quote`, `swap_to_btc_create` (needs `confirm: true` to create), `swap_fund` and `swap_recover`; `swap_status`, `swap_claim` and `swap_refund` also cover swaps from a stablecoin (`swap_refund` takes no `to` for them).
- New error codes: `BAD_MARKUP`, `SWAP_AMOUNT`, `SWAP_UNSUPPORTED_NETWORK`, `SWAP_FAILED`, `SWAP_OPEN_DEPOSIT`, `SWAP_BUSY`, `SWAP_DONE`, `SWAP_FUNDING`, `SWAP_NOT_LOCAL`.

### Changed
- `viem` (2.52.2, already in the dependency tree through `@satora/swap`) is now a direct dependency: Mark uses it only to sign the recovery sweep from the deposit address.
- Nothing changes for escrow deals. Swap keys and preimages stay in the same encrypted swap storage in your Mark home (files 0600). Mark holds no API secret, only the public referral ID.
- Internal cleanup with no change in behavior: escrow funding and `mark swap` now share one list of swap states and one sleep helper; Lightning and Ark funding share one terms check; repeated CLI flag parsing and the list of local hosts allowed over plain http are defined once. This cleanup itself changes no commands, JSON output, error codes or MCP tools (the new swap features are listed under Added).
- The Arkade server URL an escrow server reports in `/limits` may now be plain `http://` to `[::1]` too, not only `localhost` and `127.0.0.1`. This matches the escrow URL rule, and both use the same list of local hosts. Any other `http://` host is still ignored, and Mark uses its network preset instead.

### Fixed
- `mark swap` no longer overstates what arrived. Satora swaps the locked BTC token into the stablecoin on a DEX at claim, so the payout can differ from the amount it states at create (live: 3.03146 USDC stated, 3.022431 arrived). The created swap and `mark swap status` now call that amount `expectedReceive` (with a note), and after the payout `received` / `receivedUnits` come from the payout transaction's token transfer to your address (`receivedNote` when the receipt cannot be read). The created swap's old `receive` field is gone; quotes keep `receive` as the quoted estimate.
- After a swap is claimed, the result now shows the swap's final status (`serverredeemed`) instead of the status at the moment of the claim (`serverfunded`). Mark checks again for a few seconds; if Satora has not caught up yet or cannot be reached, it shows the claim-time status as before. This applies to `mark swap --wait`, `mark swap claim` and the MCP `swap_create` and `swap_claim` tools.

## [0.4.3] - 2026-11-21

### Changed
- MCP and CLI install commands now use `npx -y @yuvlero/mark@latest` (MCP client args `["-y", "@yuvlero/mark@latest", "mcp"]`) so npx does not keep a stale cached copy. The npm package id (`@yuvlero/mark`) is unchanged. Printed commands when Mark is started through npx (`NPX_CMD`) use the same `@latest` prefix. `package.identifier` in server.json stays the bare name.

## [0.4.2] - 2026-11-20

### Changed
- MCP Registry name moved from `io.github.yuvlero/mark` to `to.agentescrow/mark` (DNS namespace for agentescrow.to). `mcpName` in package.json and `name` in server.json changed together; the old name is deprecated in the registry. The npm package (`@yuvlero/mark`) and the CLI are unchanged.

## [0.4.1] - 2026-11-19

### Added
- `MARK_HOUSE_KEY` (operator-only, unset for everyone else): when set, every request to the escrow server carries it as the `x-escrow-house` header, so the operator's own agents and scripts are counted as house traffic, not external usage. Sent only to the production escrow origin `https://agentescrow.to`, to an https origin listed in `MARK_HOUSE_ORIGIN` (comma-separated, exact match) or to a loopback http URL, only if it is visible ASCII, and with it set Mark refuses redirects (the header never follows a 3xx elsewhere); never logged or shown in errors. Without it Mark sends nothing new.

### Fixed
- Security: updated the bundled `hono` 4.13.13 → 4.13.19 and `@hono/node-server` 2.1.5 → 2.1.9 (GHSA-jpvv-r467-5p4w, GHSA-qv5m-9pm6-hqp3, GHSA-46wx-v44x-9hh2, GHSA-4h7h-rv7c-7m2v, GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq medium; GHSA-3gg2-335m-rxc6 low). They come in through the MCP SDK's HTTP transport, which Mark does not use (Mark runs over stdio), so Mark was not exposed.

## [0.4.0] - 2026-11-14

**New: fund a deal straight from an Arkade wallet** (no Lightning swap, no swap fee), and Mark now says everywhere that the escrow runs on **the Arkade server** (mainnet `https://arkade.computer`): only Ark addresses from an Arkade wallet on that server work. Bark / Second Ark addresses do not: use Lightning.

### Added
- `mark escrow fund <id> --ark [--wait] [--timeout sec]` (MCP: `escrow_fund` with `rail: "ark"`). Runs the same local deal check as Lightning funding (terms hash, arbiter attestation, the address derived from the deal's keys), then prints `escrowAddress`, the exact `amountSats`, `expiresAt` and the Arkade server (`payTo.arkServer`: URL, server key, address prefix) with `howToPay`. Mark sends nothing: the buyer pays from its own Arkade wallet, in ONE payment. `--wait` polls the deal until it is funded, reports `overpaidSats` for a larger coin, and tells the server the rail (`POST /escrows/:id/funding-ark`, so the funding ledger says rail `ark`, fee 0; older servers: `ledger.recorded: false`). A timeout with a smaller payment at the address says so (`underpaid`): smaller payments are not added up. Refuses with `DEADLINE_TOO_CLOSE` under 10 minutes before expiry.
- One rail per deal: after `fund --ark`, a plain `fund` refuses with `FUNDING_IN_PROGRESS`, and `fund --ark` refuses while a Lightning funding invoice for the deal may still be paid (an unknown swap status counts as payable). `--switch-rail` (MCP `switchRail`) switches, only if nothing was paid on the other rail.
- `mark escrow limits` → `arkade`: the Arkade server URL and key (from the server's `GET /limits` → `arkServer` on servers with it, else Mark's network preset; a junk URL from the server is ignored), the address prefix and a note.
- Deal fields from newer servers: `underpaid` (payments smaller than `amountSats` while `created`) and `funding.rail`.

### Changed
- Every Ark address is checked before anything is signed or sent: `--payout-ark` (approve / refund), `refund-payout --to` and config `refundArkAddress` must have this network's prefix (`ark1` mainnet, `tark1` mutinynet) **and** the deal's Arkade server key encoded in the address. Others fail with `BAD_DEST`; the message names the Arkade server, says Bark / Second addresses will not work and to use Lightning (`details.reason`: `not_ark_address`, `wrong_network`, `wrong_ark_server`). Before, only the `ark1` / `tark1` prefix was checked and the server refused the payout later (or, with an address from another Ark server, could not pay it).
- Help, `show` / `accept` next steps, MCP tool and field descriptions, README, the agent skill, the quickstart and AGENTS.md say plainly that the escrow runs on the Arkade server and that Bark / Second addresses will not work.
- The rail chosen in this Mark home is authoritative: after `--switch-rail` to Ark an old Lightning invoice is not shown again by a plain `fund`, switching back to Lightning (reusing the swap) records Lightning, and rail choice and swap creation share one lock. If the server's address key can't be learned (deal and `/limits` unreachable), Ark payout addresses are refused (`BAD_DEST`, `reason: "arkade_key_unknown"`) instead of a prefix-only check. `fund --ark` on a deal that is already funded still reports the Ark rail for the ledger.
- The funding rail is the server's call, not Mark's: after an Ark funding Mark first reports a Lightning swap this home created and claimed into the escrow (an invoice from before `--switch-rail`), then sends the `funding-ark` nudge. The server proves the rail from the funding Ark tx (a VHTLC claim = Lightning, a plain wallet send = Ark, fee 0) or records nothing; `ledger.rail` in the output can be `null` (not proven).
- `src/core/arkAddress.ts` is shared byte-for-byte (apart from the error class) with the escrow server (parity-tested there).

### Compatibility
- Works with older escrow servers: `fund --ark` needs nothing new from the server (it pays the escrow address the server already published); only the ledger rail report and `underpaid` need a newer server. Without `arkServer` in `/limits`, Mark uses its network preset URL and the deal's server key.

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
- Concurrent first `fund` calls for one deal (MCP, or two processes on one Mark home) create one funding swap and show one invoice. Creation is serialized in process and by a lock file in the Mark home.
- `fund --wait` reports a deal as funded only when the deal holds the funds (`funded`, `releasing`, `refunding`, `disputed`). A deal released or refunded meanwhile gets "NOT claimed", not "already funded". `paymentReceived` is `true` (paid), `false` (awaiting payment) or `null` (unknown or the swap ended). Once a claimable status has been seen, a later stale `pending` never brings the invoice back.
- Claims and refunds run one at a time per process (the MCP server can get concurrent calls), so the console redirect and the workaround patch never overlap.
- The swap library's `console.log` progress lines (for example "No pending Arkade claim found; submitting a new claim") go to stderr. Before, they went to stdout, into the CLI's JSON output and the MCP stdio stream.
- Swap states in which the swap ended without funding the escrow (refunded, `serverwontfund`, too late, and so on) end `--wait` with that status, not a timeout.

- `mark escrow approve` (release / refund co-signing) under the new dependency tree. @satora/swap 1.8.1's `signEscrowArkTx` / `signEscrowCheckpoints` (its bundled @arkade-os/sdk 0.5.x Transaction) reject the escrow server's spend PSBTs with `checkScript: witnessScript without P2WSH`: the server's builder (ark-rs) puts the tapscript leaf in `witnessScript` on the taproot inputs. 1.7.0 accepted them. Only after that exact error, and only for a taproot script-path input 0, Mark signs input 0 itself with @scure/btc-signer (script check off). The PSBT keeps all its fields and its txid, and gains one signature, the same shape 0.3.0 produced. Tested on release, arbiter release and arbiter refund PSBTs built by the server's own core. This also affects any Mark 0.3.0 install whose @satora/swap was upgraded by hand, and the escrow server if it moves to @satora/swap 1.8.x.
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
