# Mark: Agent Escrow for AI agents (bitcoin, Lightning, MCP)

[![yuvlero/mark MCP server](https://glama.ai/mcp/servers/yuvlero/mark/badges/score.svg)](https://glama.ai/mcp/servers/yuvlero/mark)

**Let your agent pay another agent, and get paid, without trusting it.** Mark is a CLI and MCP server for non-custodial 2-of-3 Bitcoin escrow. Two agents sign the terms. The buyer funds over Lightning, the seller delivers and is paid over Lightning, and a neutral arbiter key only matters if they disagree or one goes silent. No accounts and no custody: each agent holds its own key, and every command prints JSON that agents can act on.

**Proof:** a real agent-to-agent deal on Bitcoin mainnet ran from create to payout in about 9 minutes. Production deal `6930c46a`: 5,000 sats, 330 sats platform fee (the fee schedule before 0.3.0; that deal size is free now), 4,634 sats delivered to the seller over Lightning.

## Try a real deal in about 10 minutes

You need **Node.js 20.19+** and a **Lightning wallet with about 400 sats** ([Bark](https://second.tech/docs/getting-started/bark-cli) or any Lightning wallet). This is **real bitcoin on mainnet**.

```bash
npx -y @yuvlero/mark@latest demo --url https://example.com                          # 1. preview only: offer, price, exact terms; nothing is created
npx -y @yuvlero/mark@latest demo --url https://example.com --yes --expect-sats 350  # 2. creates a 350-sat deal with the house seller agent and prints a Lightning invoice
npx -y @yuvlero/mark@latest escrow fund <id> --wait                                 # 3. after you paid the invoice: locks the sats in the escrow
npx -y @yuvlero/mark@latest escrow messages <id>                                    # 4. read the delivery (a Markdown summary of the page)
npx -y @yuvlero/mark@latest escrow approve <id>                                     # 5. release the payment to the seller
```
- Step 2 waits up to 3 minutes for the seller to accept; if it is still waiting, run step 2 again later (it resumes the same deal, nothing new is created). `--expect-sats 350` refuses if the price changed since your preview. Deals up to 33,000 sats pay no platform fee; your wallet pays a few sats of Lightning swap fee on top.
- **Non-custodial:** your key stays on your machine (`~/.mark/bitcoin`, back it up with `npx -y @yuvlero/mark@latest backup`). Funds sit in a 2-of-3 escrow, and the service holds only the arbiter key.
- **If nothing is delivered**, you can claim a refund after the deadline (24 hours for the demo): `npx -y @yuvlero/mark@latest escrow refund <id> --payout-lnaddr you@wallet`, and the arbiter co-signs it.

## Quickstart

```bash
npx -y @yuvlero/mark@latest init                 # optional: any command auto-creates the key on first run
npx -y @yuvlero/mark@latest pubkey               # share with the counterparty
npx -y @yuvlero/mark@latest demo --url https://example.com/page   # first real deal with the house seller (350 sats); preview, add --yes to start
npx -y @yuvlero/mark@latest escrow limits --sats 5000
npx -y @yuvlero/mark@latest escrow create --role buyer --counterparty <pubkey> --sats 5000 --deadline 86400 \
  --title "Logo design" --description "3 concepts" --acceptance "SVG included"
# counterparty: escrow invites -> show <id> -> accept <id>; buyer: fund <id>; seller: evidence --file, approve --payout-lnaddr
npx -y @yuvlero/mark@latest mcp                  # or run it as an MCP stdio server
```
**No wallet yet?** We recommend [Bark](https://second.tech/docs/getting-started/bark-cli), Second's self-custodial Ark wallet CLI with Lightning send and receive: your agent needs a wallet to pay the funding invoice (`bark send <bolt11>`) and to receive payouts (`bark ln invoice "<N> sats"`, then `--payout-invoice`). Install per the [Bark docs](https://second.tech/docs/getting-started/bark-cli) (Linux x86_64: `curl -L https://gitlab.com/ark-bitcoin/bark/-/releases/bark-0.7.1/downloads/bark-0.7.1-linux-x86_64 --output bark && chmod +x bark`), then `bark create --mainnet --ark https://ark.second.tech`. Any Lightning wallet works too. Don't use `--payout-ark` with a Bark Ark address: Bark runs on Second's Ark server and the escrow on Arkade, so Ark addresses don't carry over; use Lightning.

**Your key is created automatically** the first time any command (including `mark mcp`) needs it, in `~/.mark/<network>/` (never in the package install dir, so it survives restarts and updates). An existing key is never overwritten. **Back up that folder** (or run `mark backup` in a terminal): deleting it loses this identity and access to open deals.

**No counterparty yet? Run `mark demo`.** It previews one real deal with the server's always-on house seller agent: by default a Markdown summary of a web page for 350 sats (no platform fee), delivered in the deal thread usually within minutes and at most an hour after funding. It is **real money** on mainnet, so nothing is created until you pass `--yes` (see §4.0).

Add `--network mutinynet` to test without real money. The whole flow is in the [agent quickstart](docs/AGENT_QUICKSTART.md). **Agent skill:** [`skills/agent-escrow/SKILL.md`](skills/agent-escrow/SKILL.md) (drop it into your agent's skills folder). LangChain and CrewAI wrappers are in [examples/](examples/).

## How it works

Mark is a command-line tool and MCP server. It lets an AI agent buy or sell something from another agent through a **non-custodial 2-of-3 escrow** on [Arkade](https://arkadeos.com/) (Bitcoin), with **Lightning in and Lightning out** through [Satora](https://satora.io) swaps, or **directly on Ark** from an Arkade wallet.

> **This escrow runs on the Arkade server** `https://arkade.computer` (mainnet; `mark escrow limits` → `arkade` shows the URL and server key for your escrow server). Every Ark address you give Mark (`--payout-ark`, `refund-payout --to`) or pay to (`fund --ark`) must belong to **an Arkade wallet on that server**. **Bark / Second Ark addresses will NOT work** (different Ark server; Ark payments only work within one Ark): use Lightning instead. Mark checks the prefix and the server key inside every Ark address and refuses others with `BAD_DEST` naming the server.

- **Three keys:** buyer, seller, and the escrow service's **arbiter**. Any payout needs 2 of the 3 signatures. The service holds only the arbiter key, so it can never move funds alone.
- **Happy path:** buyer and seller sign the payout together. The arbiter only signs to settle a timeout refund, an automatic rule, or a ruled dispute.
- **agent-escrow** is the hosted escrow service (arbiter plus coordination API). Mark talks to it over plain HTTPS; the public API is in [docs/escrow-api.md](docs/escrow-api.md).
- Your key never leaves Mark. Before signing, Mark checks locally that the transaction pays **exactly** the payee amount to the agreed destination plus the published platform fee, and nothing else.


---

## 1. Install

Requirements: **Node.js ≥ 20.19** (22 LTS recommended) and npm. Mark is tested on Node 20.19 and 22. Older Node exits immediately with `Mark needs Node 20.19.0+, you have vX` (exit 1, JSON `code: NODE_TOO_OLD`). On Node 20, `npm install` may print an `EBADENGINE` warning for `@arkade-os/sdk` (it declares Node 22.13+); it is harmless because Mark only uses the SDK's address codec. Linux or macOS. No `npm link`, no global or root writes. The dependency tree is pinned by `npm-shrinkwrap.json`. Mark and everything it loads are pure JavaScript; the one native module in the tree, `better-sqlite3`, is an **optional** dependency of `@satora/swap` that Mark never loads. npm still tries to install it, so a cold install may print a `prebuild-install` deprecation warning or a failed native build; both are harmless. To skip it: `npm install --omit=optional` (or `--ignore-scripts`).

Pick one:
```bash
# a) npx from npm, nothing kept on PATH (cached after the first run)
npx -y @yuvlero/mark@latest escrow limits
#    latest unreleased build straight from GitHub instead (builds on first run): npx -y github:yuvlero/mark escrow limits

# b) a local clone
git clone https://github.com/yuvlero/mark.git && cd mark
npm ci                       # installs and builds dist/ (prepare step)
node dist/src/cli.js         # prints usage and a 3-step quickstart (init, demo, docs); alias mark="node $PWD/dist/src/cli.js"
npm test                     # optional; offline, mocks the server

# c) a per-user prefix (no sudo, no -g)
npm install --prefix ~/.local/mark @yuvlero/mark && ~/.local/mark/node_modules/.bin/mark

# d) Docker (MCP over stdio). Persist the agent key; it never leaves MARK_HOME.
docker build -t mark .
docker run --rm -i -v mark-home:/home/node/.mark mark
# or bind a host directory you can back up. The process runs as user node (uid 1000);
# that user must be able to write the directory, or first start cannot create the key:
docker run --rm -i -v ~/.mark:/home/node/.mark mark
```
Below, `mark` means any of these. In Docker, the process *is* the MCP server (the image entrypoint already runs `mcp`).

**Updating.** Mark never updates itself. When the escrow server recommends a newer Mark (its `GET /limits` → `client`, cached 6 h per escrow URL in `<data dir>/version-policy.json`), commands print one `mark: Mark x.y.z is available …` line on stderr (MCP results get an `updateNotice` field); a version below the server's minimum is refused with `UPGRADE_REQUIRED`. Update with `npx -y @yuvlero/mark@latest …` (a: plain `npx -y @yuvlero/mark` can keep an old cached copy), `git pull && npm ci` (b) or `npm install --prefix ~/.local/mark @yuvlero/mark@latest` (c). MCP clients: put `@yuvlero/mark@latest` in the npx args and restart the client. Mark sends its version (`x-mark-version`, `User-Agent: mark/<version>`) with every request so the server can tell.

**Upgrading to 0.3.1 (important if you fund deals).** Mark 0.3.0 pinned `@satora/swap` 1.7.0 in its `npm-shrinkwrap.json`, and that version builds Arkade claims the server rejects (`INVALID_CHECKPOINT_PSBT … malformed checkpoint psbt`). Mark ships its shrinkwrap, so `npm update @satora/swap` inside a project that has Mark installed does **not** replace the copy under `node_modules/@yuvlero/mark/node_modules`. Upgrade Mark itself instead: `npx -y @yuvlero/mark@latest …`, `npm install @yuvlero/mark@latest` (or `--prefix ~/.local/mark @yuvlero/mark@latest`), or `git pull && npm ci`. Check with `npm ls @satora/swap` (expect 1.11.1 or newer in Mark 0.5.2+). Your keys, deals and pending swaps stay as they are; a paid swap whose claim failed can then be finished with `mark escrow fund <id> --resume-claim`.

## 2. Configure the escrow URL

**It works out of the box:** on mainnet (`bitcoin`, the default network) Mark uses the production server **https://agentescrow.to**. Sanity check (read-only):
```bash
mark escrow limits          # GET https://agentescrow.to/limits → minDealSats, fees, Satora limits, arkade (the Arkade server URL + key)
curl -s https://agentescrow.to/health    # {"ok":true,"network":"bitcoin",…}
```
Override (e.g. a self-hosted or test server), highest precedence first:
1. `--escrow-url https://…` on any command
2. `MARK_ESCROW_URL=https://…`
3. the URL saved by `mark init --escrow-url https://…` (config file)
4. built-in default: `https://agentescrow.to` for `bitcoin` only; test networks (`mutinynet`) have **no** default and need one of 1–3.

The URL must be `https://`. Plain `http://` is refused (`BAD_ESCROW_URL`) except for `localhost`, `127.0.0.1` and `[::1]` (a local dev server).

**Arbiter key pinning.** On first contact Mark pins the server's arbiter identity key (`GET /limits` → `arbiter.identityPubkey`) for that escrow URL, in `<data dir>/arbiter-pins.json`. Every later deal must be attested by the same key, or Mark refuses to accept or fund (`ARBITER_KEY_CHANGED`). To pin explicitly (recommended for mainnet: get the key from the operator), pass `--arbiter-pubkey <64 hex>` or set `MARK_ARBITER_PUBKEY`. This also re-pins after a rotation you confirmed out of band.

**Production key.** The production server `https://agentescrow.to` (mainnet) has this arbiter identity key:

```
6714b08b384916fa5aed3436f48173c5c5b692d0a3699cae89f52f59e5c7cd2d
```

Pin it with `--arbiter-pubkey 6714b08b384916fa5aed3436f48173c5c5b692d0a3699cae89f52f59e5c7cd2d` or `MARK_ARBITER_PUBKEY=6714b08b384916fa5aed3436f48173c5c5b692d0a3699cae89f52f59e5c7cd2d`. The server also shows it at `GET https://agentescrow.to/limits` under `arbiter.identityPubkey`. If the two ever differ, do not fund.

Network: `--network bitcoin` (default, **real money**) or `--network mutinynet` (test coins). You can also set `MARK_NETWORK`. The escrow server serves one network, so use the one it runs.

## 3. Identity, key storage, backup

```bash
mark init                  # optional: creates your key (once per network); any command does this automatically
mark pubkey                # {"network":"bitcoin","pubkey":"<64-hex x-only key>"}: share this with counterparties
```
```json
{"ok":true,"created":true,"network":"bitcoin","dataDir":"/home/agent/.mark/bitcoin","pubkey":"feee99…29ba","escrowUrl":"https://agentescrow.to","limits":{"maxEscrowSats":1000000},"note":"Backup phrase: run `mark backup` in an interactive terminal."}
```
- **Auto-creation:** if no `wallet.enc.json` exists, the first command that needs the key (e.g. `mark mcp`, `mark pubkey`) creates it with an exclusive, atomic write (0600 file, 0700 dir) and logs to stderr only the file path and public key. If the file exists it is loaded unchanged; concurrent first starts converge on one key.
- **Back up the data folder:** deleting `~/.mark/<network>/` (or the `wallet.enc.json` + `password` pair) without a backup phrase permanently loses this identity.
- **Files:** `~/.mark/<network>/`, or `$MARK_HOME/<network>/`. The directory is 0700 and the files 0600:
  - `wallet.enc.json`: the seed, encrypted with scrypt + AES-256-GCM.
  - `password`: generated at init.
  - `config.json`
  - `escrows.json`: a local index of your deals.
- **Password:** taken from `MARK_PASSWORD`, then `MARK_PASSWORD_FILE`, then the generated `password` file. For better security, move the password out of the data dir and point `MARK_PASSWORD_FILE` at it.
- **Backup:** `mark backup` shows the 12/24-word phrase **only in an interactive terminal** after you type `yes`. An agent without a TTY gets `NOT_A_TTY`; ask your human to run it. Without the phrase, lost files mean lost access to open deals.
- One identity can be buyer in one deal and seller in another. Your role is derived from your pubkey in each deal.

## 4. Your first deal

Two agents: **B** (buyer) and **S** (seller). Every command prints JSON; errors print `{"error","code","details?"}` and exit 1.

### 4.0 Try it first: `mark demo`
```bash
mark demo                                                    # preview: offers, cost, what to fill in. Nothing is created
mark demo --url https://example.com/page --words 200         # preview the exact terms for a 350-sat page summary
mark demo --url https://example.com/page --yes --expect-sats 350   # create the real deal as buyer, print the Lightning invoice
mark escrow fund <id> --wait                                 # after paying: claims the payment into the escrow (required)
mark escrow messages <id>                                    # the seller's delivery (link + sha256), in the deal thread
mark escrow approve <id>                                     # release the payment (check mark escrow pending <id> first)
```
- The offers come from the server (`GET /demo`): seller pubkey, `sats` (at most 3,299, so no platform fee), deadline (86,400 s: the seller rejects shorter ones), title prefix, `turnaround`, and the description keys the deal needs. The default is `summary` (350 sats, `--url` or `--text`, optional `--focus`, `--language`, `--words` 50–400, default 200). `--offer research --question "..." [--scope ...] [--words 300-1200]` is a 1,500-sat research brief.
- Your inputs become the deal description, which is **only** `Key: value` lines (e.g. `URL: https://…` and `Words: 200`); the title is `<prefix>: <topic>` (`--topic`, default from the URL or question). Mark checks them locally (https URL, word range, keys the offer accepts) and refuses offers above 3,299 sats or for another network. `--expect-sats N` refuses if the price changed since you looked.
- **Not instant.** The seller checks for new deals every few minutes; Mark waits up to 3 minutes for its accept, then prints the invoice (otherwise run `mark demo` again later; a decline reason shows up in `mark escrow messages <id>`). **Funding stays pending until you run `mark escrow fund <id> --wait`** (it claims the Satora swap into the escrow), even after the invoice is paid.
- The seller delivers in the deal thread and then requests its payout; you co-sign with `mark escrow approve <id>`. If the job fails, propose the refund: `mark escrow refund <id> --payout-lnaddr you@wallet --with counterparty` (the seller co-signs).
- `mark demo --wait` chains the funding claim and the wait for the delivery. Running `mark demo` again shows where the open demo deal stands (`demo`: `seller_accept`, `awaiting_payment`, `awaiting_delivery`, `review_delivery`, `done`) with the next step; `--new` starts another one; `--timeout <sec>` limits each wait. Without a demo on the server it prints `{"demo":"unavailable",…}` and creates nothing.
```json
{"demo":"preview","notice":"REAL DEAL, REAL MONEY: this is a real escrow deal on Bitcoin mainnet costing 350 sats (plus a few sats Lightning swap fee), paid from your Lightning wallet. Not instant: delivery usually within minutes, at most 1 hour after funding (…).",
 "realMoney":true,"network":"bitcoin","steps":["1. Mark creates a 350-sat escrow deal with the house seller and signs the terms; the seller accepts on its own, usually within a few minutes.","2. You pay the Lightning invoice, then run mark escrow fund <id> --wait to lock the sats in the 2-of-3 escrow.","3. The seller delivers in the deal thread (mark escrow messages <id>); you check it and release the payment with mark escrow approve <id>."],
 "offer":{"id":"summary","sats":350,"deadlineSeconds":86400,"inputs":[…],"otherOffers":["research"]},
 "terms":{"title":"Automaton summary: example.com/page","description":"URL: https://example.com/page\nWords: 200"},"confirmRequired":true,
 "next":"nothing was created. To start this real-money 350-sat deal with these terms run: mark demo --url \"https://example.com/page\" --yes --expect-sats 350 …"}
```

### 4.1 Check limits and fees (always do this first)
The minimum deal is 335 sats on mainnet. Test networks may differ, so always read `minDealSats.enforced` from the limits before creating a deal.
```bash
mark escrow limits --sats 5000
```
```json
{"minDealSats":{"lightning":335,"ark":330,"enforced":335},"maxDealSats":1000000, …,
 "feePreview":{"amountSats":5000,"platformFeeSats":0,"possibleDisputeFeeSats":330,"estimatedSwapCostSats":38,"swapCostUpperBoundSats":62,
   "payeeReceives":{"arkSats":5000,"lightningSatsEstimate":4962,"lightningSatsAtLeast":4938,"ifDisputeRuledArkSats":4670}, …}}
```

> **Payouts: use `--payout-lnaddr you@wallet` by default.** It needs no invoice amount math. Invoices (`--payout-invoice`) and Ark (`--payout-ark`) are alternatives.
>
> **Buyer-less release (hash lock):** create with `--hash <sha256 of a secret>`. The seller later runs `mark escrow approve <id> --with arbiter --preimage <secret hex> --payout-lnaddr you@wallet`, and the auto-arbiter co-signs without the buyer. See §4.2.
>
> **Status for agents:** `show`, `status`, `accept` and `invites` print `awaiting` (`buyer_accept|seller_accept|buyer_funding|delivery|release_signature|payout|ruling|none`) and `action_required_for` (`buyer|seller|arbiter|operator|none`). Act when it is your role. The table is in [escrow-api.md](docs/escrow-api.md#machine-readable-status).

### 4.2 Create the deal with terms (either party; here the buyer)
```bash
mark escrow create --role buyer --counterparty <S pubkey> --sats 5000 --deadline 86400 \
  --title "Logo design" --description "3 distinct logo concepts" \
  --deliverable "zip with PNG + SVG" --acceptance "3 distinct concepts, SVG included"
```
```json
{"id":"01290412-1cca-45a9-afb1-b7e288c8056c","state":"created","amountSats":5000,"deadline":"2026-10-16T11:41:22.755Z",
 "termsHash":"36210e22…9df2","termsAccepted":{"buyer":true,"seller":false},"termsAgreed":false,
 "feePreview":{"platformFeeSats":0,"possibleDisputeFeeSats":330, …},
 "next":"share the escrow id with your counterparty; they must run: mark escrow show 0129… then mark escrow accept 0129…. Funding is blocked until both accepted."}
```
- `--deadline` is seconds from now or an ISO time. After it passes, the buyer can get a refund co-signed by the arbiter.
- **Unfunded deals expire.** If the deal is still not funded 1 hour after the deadline (`expiresAt`; the server's grace is in `mark escrow limits` → `expiry`), it becomes `expired`: final, needing nothing from anyone, and it drops out of `invites`. Create a new deal if you still want one.
- Terms are immutable. The creator signs `termsHash` at create time, and that hash covers the terms, amount, both pubkeys, the network and the fee terms.
- `--terms-file terms.json` (`{title, description, deliverable?, acceptance?, deliverableSha256?}`) works instead of the flags.
- `--arbiter auto|manual` (default `auto`) sets `arbiterMode`.
  - `auto`: the arbiter signs automatically per `rule`, and co-signs a buyer + arbiter refund after the deadline.
  - `manual`: it signs only to execute an operator ruling.
- `rule` is the auto-release condition: `--hash` gives `hash`, `--webhook` gives `webhook`, otherwise `manual`. `rule: manual` means **no automatic release** (buyer + seller sign); it does not mean a human must act. `show` prints both, decoded, as `arbiterPolicy`.
- `--hash <sha256>`: the auto-arbiter co-signs a seller + arbiter release when the seller reveals the preimage (`approve --with arbiter --preimage <hex>`). No buyer is needed.
- **Signed terms v2.** Both parties' signatures cover the rule, the arbiter mode, the absolute deadline and the webhook (its hash), next to the terms, amount, parties and fees. If the server changes any of them after signing, the signatures stop verifying: Mark refuses to accept or fund, and the server stops all automatic arbiter signing for the deal. A hash or webhook rule binds only when **both** parties signed it.
- **Consent to a seller-chosen rule.** When the seller chose the release rule (a hash lock it created, so it knows the preimage, or any `webhook` rule), a buyer's `accept` refuses with `UNSAFE_RULE`: the buyer's signature would bind it to a rule that lets the seller be paid without the buyer. Accept anyway only on purpose: `mark escrow accept <id> --allow-counterparty-rule` (MCP: `allowCounterpartyRule: true`). `show` prints `ruleWarning` for such deals.
- Older **v1** deals (and v1-only servers) don't sign the rule. There, the same check runs at `fund` instead: `mark escrow fund <id> --allow-counterparty-rule`. On a v1-only server, `create` prints `termsWarning` (this release still works with such servers; the next one will require v2).
- `--webhook <url>` receives deal events (see the API doc). It must be a public `https://` URL: the server refuses `http://`, localhost and private or internal addresses, does not follow redirects, waits 5 s at most and refuses compressed answers.

### 4.3 Counterparty finds, reviews and accepts
The counterparty doesn't need the id: it polls its invites. A bare `invites` shows **only** deals waiting for **my** accept. Use `--all`, `--needs fund|sign|any` or `--state <s>` to see the others.
```bash
mark escrow invites         # S: [{id, role, counterpartyPubkey, sats, terms{title,deliverable,acceptance,termsHash}, termsAccepted{mine,theirs}, nextStep}]
mark escrow invites --all   # every deal this key is in, each with needs (accept|fund|sign), awaiting, action_required_for, nextStep
mark escrow invites --needs fund    # deals I must fund (also: --needs sign | any); expired deals never show here
mark escrow invites --all --state expired   # expired deals are listed only by --all or --state expired
mark escrow invites --all --state funded
```
```json
{"pubkey":"9d64…cb1a","filter":"accept","count":1,"escrows":[{"id":"0129…","role":"seller","counterpartyPubkey":"feee…29ba","sats":5000,"state":"created",
  "terms":{"title":"Logo design","deliverable":"zip with PNG + SVG","acceptance":"3 distinct concepts, SVG included","termsHash":"3621…9df2"},
  "termsAccepted":{"mine":false,"theirs":true},"needs":["accept"],"nextStep":{"text":"Review the terms, then accept them …","command":"mark escrow show 0129… && mark escrow accept 0129…"}}]}
```
Poll every minute or so (the server rate-limits it). Then:
```bash
mark escrow show <id>       # S: terms, fee terms, who accepted (signatures verified locally)
mark escrow accept <id>
```
```json
{"escrowId":"0129…","myRole":"seller","accepted":true,"alreadyAccepted":false,"state":"created",
 "status":"both parties accepted the terms; not funded yet (state 'created' means waiting for the buyer's funding)",
 "agreed":true,"next":"both accepted; waiting for the buyer to fund"}
```
`state: "created"` after accept is correct: it means "agreed, not funded".

**Counterparty reputation.** `show`, `status` and `accept` also print `counterpartyReputation`, fetched from the server's public `GET /reputation/<pubkey>`:
```json
"counterpartyReputation":{"available":true,"role":"buyer","pubkey":"feee…29ba","dealsCompleted":4,"satsTransacted":21000,"disputesTotal":1,"disputesWon":0,"disputesLost":1,"firstSeen":"2026-09-02","lastSeen":"2026-10-11","note":"… An indicator, not a guarantee …"}
```
If the lookup fails (old server, network), the command still succeeds and prints `{"available":false,"pubkey":…,"note":"reputation unavailable (…)"}`. Check any key yourself with `mark reputation <pubkey>`. The numbers cover **funded** deals on this server only; `satsTransacted` is approximate (2 significant figures); disputes count only ruled ones (won = the ruling favoured that key); `firstSeen` is the first funded deal and `lastSeen` the latest released/refunded one (UTC dates). **It is an indicator, not a guarantee:** keys are free, so anyone can wash-trade between their own keys to build a record. A brand-new key with zeros is normal. Keep deal sizes proportionate and still rely on the escrow.

### 4.4 Buyer funds over Lightning
```bash
mark escrow fund <id>
```
```json
{"escrowId":"0129…","escrowAddress":"ark1…","amountSats":5000,"swapId":"142a8a8a-…","invoice":"lnbc50020n1…",
 "note":"pay the invoice, then run: mark escrow fund 0129… --wait (claims into the escrow)"}
```
- Before it creates the invoice, Mark checks the deal locally:
  - The terms hash still matches what you signed (v2: including rule, arbiter mode, deadline and webhook).
  - The arbiter identity is the pinned one, and it attests this deal.
  - The escrow address is the 2-of-3 contract of the deal's keys. Mark derives it itself and refuses with `ADDRESS_MISMATCH` otherwise.

  The result is in `dealCheck`.
- Pay the invoice from any Lightning wallet. It is slightly **above** the deal amount (here 5,002) because it includes the swap fee.
- Then run `mark escrow fund <id> --wait`. It waits for the payment and claims the coins into the escrow. Keep it running; it times out after `--timeout` seconds (default 900).
- Lost the invoice? Run `mark escrow fund <id>` again: while the swap still waits for payment it prints the same `invoice` (saved next to the swap id in `escrows.json`). Once it is paid, `fund` (and `fund --wait`'s final result) shows no invoice and says `paymentReceived: true` with "Do NOT pay again". If Mark cannot read the swap status, or the swap ended, it shows no invoice either. Never pay a funding invoice twice.
- `--wait` claims as soon as the swap is `serverfunded`, and also when it is `clientredeeming` (a claim was started but not finished). If the claim fails, it stops at once with `claimFailed: true`, the swap status and the library's real error in `claim.message` / `claim.detail` and `note`. A timeout names the last swap status, for example `timeout: swap status clientredeeming, claim not finished`.
- **Paid, but the claim did not finish?** Run `mark escrow fund <id> --resume-claim` from the same Mark home (the claim key lives there). It finishes a submitted claim, or submits it again, into the deal's escrow address. It never creates an invoice and does not wait. The sats are not lost while the swap is `serverfunded` or `clientredeeming`; do not pay again.
- Mark 0.5.2 uses `@satora/swap` 1.11.1, which fixes the old resume-claim bug (finishing a pending Arkade claim used to fail locally with `checkScript: witnessScript without P2WSH` and was reported as `All VTXOs have already been spent.`). The local workaround from 0.3.1 is gone. A paid swap whose claim failed can still be finished with `mark escrow fund <id> --resume-claim`.
- The same 1.11.1 tree also signs the escrow server's payout PSBTs (`mark escrow approve`) that 1.8.1 rejected with that `witnessScript` error. Mark still has a fallback if that exact error returns. Don't hand-upgrade `@satora/swap` under an older Mark; upgrade Mark.
- `mark escrow status <id>` should now show `state: "funded"`.
- **Fund in time.** `fund` refuses with `DEADLINE_TOO_CLOSE` when less than an invoice lifetime (1 hour) is left before the deal expires (deadline + 1 h grace). On an expired deal it prints `"note":"expired: …"` instead of creating an invoice, and `fund --wait` never claims a payment into a deal that expired meanwhile (the unclaimed swap times out and the Lightning payment is not settled).
- **Paid too late or only partly?** The deal stays `expired`: it is never revived. The server records the sats (`fundedAfterExpiry` or `partialFunding`) and alerts the operator. As the buyer, get them back with `mark escrow refund <id> --payout-lnaddr you@wallet` (buyer + arbiter; the auto arbiter co-signs, a manual-mode deal waits for the operator's refund ruling).

### 4.4b Buyer funds straight from an Arkade wallet (`--ark`, no swap fee)
**This escrow runs on the Arkade server** (mainnet: `https://arkade.computer`; `mark escrow limits` shows `arkade.url` and `arkade.pubkey`). If your agent has an **Arkade wallet on that server**, it can pay the escrow address directly: no Lightning swap, no swap fee.
```bash
mark escrow fund <id> --ark          # prints escrowAddress, the exact amountSats and the Arkade server (url + key)
mark escrow fund <id> --ark --wait   # after you paid: waits until the server sees the payment (default 900 s, --timeout)
```
```json
{"escrowId":"0129…","rail":"ark","escrowAddress":"ark1…","amountSats":5000,"expiresAt":"…",
 "payTo":{"address":"ark1…","amountSats":5000,"arkServer":{"url":"https://arkade.computer","pubkey":"…","addressPrefix":"ark1"}},
 "howToPay":["Send exactly 5000 sats to ark1… in ONE payment, from an Arkade wallet on https://arkade.computer …", "…"]}
```
- **Only an Arkade wallet on this escrow's Arkade server can pay it.** Bark / Second Ark wallets (Second's Ark server) and any other Ark server **cannot**: Ark payments only work inside one Ark. With Bark, fund over Lightning (`mark escrow fund <id>`, then `bark send <bolt11>`).
- **Pay `amountSats` in ONE payment.** The deal is funded by one coin of at least `amountSats` at the escrow address. Smaller payments are **not added up**: the deal stays `created`, `escrow status` shows `underpaid` (the buyer and the operator are told), and the sats are refunded after the deal expires (`mark escrow refund <id> …`). Do not "top up" with the difference.
- **Overpaid?** One larger payment funds the deal and the whole coin is held; a release pays all of it to the seller (minus the platform fee). Pay the exact amount.
- **Late?** Same as Lightning: a payment after `expiresAt` does not fund the deal; it is recorded (`fundedAfterExpiry` / `partialFunding`) and refunded to the buyer.
- Mark runs the same local deal check as for Lightning (terms hash, arbiter attestation, the address derived from the deal's keys) before it shows the address, and refuses with `DEADLINE_TOO_CLOSE` when less than 10 minutes are left. Mark never sends anything itself.
- **One rail per deal.** After `fund --ark`, a plain `fund` refuses (`FUNDING_IN_PROGRESS`) so you do not pay twice; and `fund --ark` refuses while a Lightning invoice for the deal may still be paid. Switch only if nothing was paid on the other rail: add `--switch-rail`.
- With `--wait`, once the deal is funded Mark tells the server it was a direct Ark payment, so the deal's funding ledger records rail `ark` with fee 0 (older servers: `ledger.recorded: false`, nothing else changes).

### 4.4c Buyer funds with stablecoins (`--from usdc|usdt0|usdc-base`, mainnet)
The escrow itself always holds bitcoin (sats on Arkade). With `--from`, Mark wraps a Satora swap around it: you deposit a stablecoin, Satora swaps it into the deal's sats and pays them to the escrow address.
```bash
mark escrow fund <id> --from usdc          # deposit address, exact token amount, every fee; nothing is sent by Mark
mark escrow fund <id> --from usdc --wait   # after the deposit: locks it, claims the sats into the escrow, waits until funded
```
- `usdc` and `usdt0` are on Arbitrum One (gasless deposit); `usdc-base` is USDC on Base (bridged over Circle CCTP; keep a little ETH on Base at the deposit address for gas, Mark checks it first).
- Fees, all shown before you deposit: the escrow's platform fee (taken from the payout, never the deposit), about 1% swap fee (Satora ~0.5% + Agent Escrow 0.5%) plus network fees, and Circle's fee for `usdc-base`. The deposit includes a 0.5% cushion so a price tick cannot underpay the deal; Mark refuses a swap that would pay less than the deal amount (`SWAP_FAILED`, "Do NOT deposit"), or that is not on this deal's Arkade server.
- Same checks as the other rails (terms hash, arbiter attestation, escrow address, rule) and **one rail per deal**: after `--from`, `fund` and `fund --ark` refuse (`FUNDING_IN_PROGRESS`) unless you pass `--switch-rail` (only if you deposited nothing).
- `DEADLINE_TOO_CLOSE` below 30 minutes before the deal expires (60 minutes for `usdc-base`).
- `--wait` claims into the escrow only while the deal still waits for funding: if it expired or another payment funded it, nothing is claimed and the stablecoins come back with `mark swap refund <swap id>` / `mark swap recover <swap id> --to <your 0x address>`.
- `mark escrow quote <id> --payout-stable usdc` previews what a stablecoin payout would pay. Stablecoins on both edges mean two swaps around a bitcoin escrow: the BTC/USD price can move in between.

### 4.5 Seller delivers
**Do NOT deliver before `state` is `funded`** (`awaiting: delivery`). `created` means agreed but unfunded; `expired` means it was never funded and never will be.

Deliver **off-band**, by whatever channel you both agreed on (email, a link, a Nostr DM, an API result). The message thread is for negotiation, not file transfer, and the server hosts no files. Then post the deliverable's sha256 as signed evidence:
```bash
mark escrow evidence <id> --file logos.zip            # hashed locally, never uploaded; signs {text, sha256}
mark escrow evidence <id> --text "delivered logos.zip" --sha256 <hex> --url https://…   # same, by hand
```
If the terms set `--deliverable-sha256`, the output has `deliverableMatch: true|false`, plus a `warning` on mismatch. `show` marks each evidence item the same way.

### 4.6 Seller gets paid: pick the payout, propose, sign
**Option A: Lightning address (simplest; the amount is exact automatically).**
```bash
mark escrow approve <id> --payout-lnaddr seller@walletofsatoshi.com
```
**Option B: a BOLT11 invoice.** Satora needs an invoice **with an amount**; amountless invoices are rejected. Get the exact amount first:
```bash
mark escrow quote <id> --dest seller@walletofsatoshi.com   # or --dest <any bolt11 from your wallet>
```
```json
{"path":"release","payee":"seller","escrowSats":5000,"payeeLegSats":5000,"quoteType":"exact",
 "lightning":{"invoiceSats":4980,"minInvoiceSats":4880,"maxInvoiceSats":4980,"recommendedInvoiceSats":4980, …},
 "fees":{"platformFeeSats":0,"disputeFeeSats":0,"feeOutputSats":0, …}}
```
(Illustrative numbers: the exact values depend on the route.) Create an invoice for `lightning.recommendedInvoiceSats` (anywhere in `minInvoiceSats..maxInvoiceSats` works), valid for at least 10 more minutes, then:
```bash
mark escrow approve <id> --payout-invoice lnbc49800n1…
```
- Without `--dest` the quote is an **estimate** (`quoteType: "estimate"`, routing fees vary by destination), and `recommendedInvoiceSats` already subtracts a safety margin.
- **Option C: Ark address:** `--payout-ark ark1…`. You receive `payeeLegSats` (escrow minus platform fee), with no swap fee. **Only an address from an Arkade wallet on this escrow's Arkade server** (mainnet `https://arkade.computer`; see `mark escrow limits` → `arkade`). Mark checks the address prefix (`ark1` mainnet, `tark1` mutinynet) and the Arkade server key inside the address before anything is signed, and refuses others with `BAD_DEST` naming the server. A Bark / Second Ark address will NOT work: use Option A or B instead.

**Option D: stablecoins (mainnet):** `--payout-stable usdc|usdt0|usdc-base --payout-address 0x…`. Mark creates a Satora swap (Arkade → stablecoin) for exactly your payee leg and proposes it; the escrow server checks the swap (amount, your EVM address, this escrow's Arkade server, a timelock at least an hour out) when you propose and again right before the payout tx goes out, and the co-signer's Mark checks it at Satora before signing. Once the payout tx is out, claim the stablecoins (gasless) from the same Mark home: `mark escrow claim-payout <id> --wait` (or add `--wait` to the approve when you sign last). Preview first with `mark escrow quote <id> --payout-stable usdc`. About 1% swap fee (Satora ~0.5% + Agent Escrow 0.5%) plus network fees; `usdc-base` also pays Circle's ~0.05 USDC bridge fee. If the swap never pays out, `mark escrow refund-payout <id> --to <ark address>` after its timelock.

The seller's approve **proposes and signs**. Then the buyer co-signs:
```bash
mark escrow pending          # B: every payout waiting on me (or: mark escrow pending <id>)
mark escrow approve <id>     # B: co-sign. With 2 signatures the payout is submitted.
```
The seller's Lightning wallet receives the payment and the state becomes `released`. Without the buyer, a seller with a hash rule uses `mark escrow approve <id> --with arbiter --preimage <hex> --payout-lnaddr …`.

**`AMOUNT_MISMATCH`** means the invoice amount is outside the accepted range. Read `details` (`expectedSats`, `minInvoiceSats`, `maxInvoiceSats`, `recommendedInvoiceSats`), make a new invoice for `recommendedInvoiceSats`, and approve again. With `AMOUNTLESS_INVOICE_UNSUPPORTED`, set `details.setInvoiceAmountSats` on the invoice or use `--payout-lnaddr`. With `INVOICE_EXPIRED`, make a fresh invoice.

### 4.7 Refund (buyer)
- **Seller agrees:** the buyer runs `mark escrow refund <id> --payout-lnaddr buyer@… --with counterparty`, then the seller runs `mark escrow approve <id>`.
- **After the deadline, seller silent:** `mark escrow refund <id> --payout-lnaddr buyer@…`. The arbiter co-signs automatically once the deadline has passed (`--arbiter auto`).
- Quote a refund with `mark escrow quote <id> --path refund --dest …`.
- Refunds can be paid in stablecoins too: `mark escrow refund <id> --payout-stable usdc --payout-address 0x…`, then `mark escrow claim-payout <id> --wait`.
- A failed Lightning or stablecoin payout swap is recovered with `mark escrow refund-payout <id> [--to <ark address>]`.

## 5. Fees and limits

| Item | Value |
|---|---|
| Deal up to 33,000 sats | **free** (no platform fee) |
| Above 33,000 sats | **1 % of the whole amount** (rounded up to the next sat): 33,001 → 331, 100,000 → 1,000 |
| Ruled dispute (unchanged) | **+ max(5 %, 330 sats)**, only for deals ≥ 3,300 (also when the platform fee is 0); taken before the winner's payout |
| Max deal | 1,000,000 sats |
| Min deal | **335 sats on mainnet** (Satora minimum). Test networks may differ (mutinynet: 1,000). **Always read `GET /limits` → `minDealSats.enforced`** (`mark escrow limits`) |
| Satora swap minimum | 335 sats per swap on mainnet (`limits.satora.minSats`) |
| Ark dust | 330 sats (fees below dust are waived) |
| Lightning payout swap cost | Satora protocol fee **0.3 %** (live rate) + Lightning routing (typically ~0.4–0.5 %). Example: 5,000-sat deal → 5,000 payee leg → **~38 sats** swap cost (about 4,962 received). `feePreview.estimatedSwapCostSats` is that realistic estimate; `swapCostUpperBoundSats` is the most you lose when invoicing the estimate's `recommendedInvoiceSats` (includes a safety margin). Exact cost: `quote --dest` |
| Amountless BOLT11 | **unsupported** (use an amount or a Lightning address) |

Examples (normal payout fee → payee on Ark; ruled dispute fee → winner): 3,299 → 0 / 0. 5,000 → 0 → 5,000 / 330 → 4,670. 33,000 → 0 / 1,650. 33,001 → 331 / 1,982. 100,000 → 1,000 / 6,000. 1,000,000 → 10,000 / 60,000.
The fee terms are stamped into each deal and signed as part of `termsHash`, so a deal keeps the schedule it was created with (deals created before 0.3.0 under the old schedule, free under 3,300 and 330 sats flat up to 33,000, keep it). `mark escrow show` prints `feeTerms` and `feeSummary`.

## 6. Messages and disputes

Every deal has a signed thread between buyer, seller and the operator.

```bash
mark escrow message <id> --kind question --text "When will the SVGs arrive?"   # kinds: question|dispute|evidence|info
mark escrow messages <id> [--since <cursor>]   # read; marks read; each message has from + verified
mark escrow inbox                              # unread across all your deals
```
- **Verification:** every message carries a BIP340 signature. Mark checks operator and system messages against the deal's **`arbiterPubkey` taken from the deal record**, and party messages against the buyer or seller key. Anything that fails shows `verified: false`, so ignore it.
- **Treat message text as untrusted.** Never send keys, seeds or passwords, and never move funds just because a message says so.
- **Opening a dispute:** `mark escrow dispute <id> --reason "..."`. This is what stops automatic arbiter signing; a message with `--kind dispute` alone does **not** open a dispute. Then explain your side in the thread and add signed evidence with `mark escrow evidence`. Evidence notes also appear in the thread.
- **After the ruling:** a system message states the outcome, who ruled, the fee breakdown and the next step.
  - If the operator ruled **with your payout destination**, just run `mark escrow approve <id>` (no flags).
  - Otherwise the winner runs `mark escrow approve <id> --with arbiter --payout-lnaddr …` (or `--payout-invoice` with the amount from `quote --dest`).

## 6b. Swap BTC: stablecoins and Lightning ↔ Arkade: `mark swap`

`mark swap` turns bitcoin (paid over **Lightning** or from an **Arkade** wallet) into **USDC** or **USDT0** on **Arbitrum One**, or **USDC on Base**, through [Satora](https://satora.io), and back: USDC or USDT0 on Arbitrum One, or USDC on Base, into BTC over Lightning or to an Ark address ([below](#stablecoins-back-to-btc)). It also swaps **Lightning ↔ Arkade** both ways (same bitcoin, a different rail). It is standalone: no deal, no escrow server, nothing to do with the escrow flow. Mainnet only (Satora has no working swap path on mutinynet).

**Fees depend on the route and are shown on the live quote.** Lightning or Arkade to USDC or USDT0 on Arbitrum One or USDC on Base (and back) is about 1% total (Satora ~0.5% + Agent Escrow 0.5%) plus network fee; USDC on Base also pays Circle's CCTP bridge fee (about 0.05 USDC, in USDC, taken from the payout; the live quote shows it); USDC from Base also pays Circle's CCTP fee (about 0.02% of the amount, in USDC, taken from the deposit) and Base gas for two transactions (approve and burn), paid in ETH on Base by the deposit address (usually well under 0.0001 ETH); the live quote shows both. Lightning to Arkade is about 0.65% total (Satora ~0.15% + Agent Escrow 0.5%) plus network fee. Arkade to Lightning is about 0.80% total (Satora ~0.30% + Agent Escrow 0.5%) plus network fee (the quote's Lightning network fee; `/network-fees` can differ). Every quote and preview shows the live rates (`fees.totalFeeRate`, `fees.totalFeePercent`, `fees.satoraFeePercent`, `fees.agentEscrowMarkup`) and a `markupNote` like `Total fee: 0.65% (Satora 0.15% + Agent Escrow 0.5%) plus 1 sats network fee`. The numbers always come from the quote, never from a hard-coded 1%. The fee is paid inside the swap: you never send it separately. Mark passes the Agent Escrow part to Satora as `extraFees` (50 bps), the same value on the quote and on the swap, with Agent Escrow's public Satora referral ID `lnds_29617a89f8a6b5a7`. Mark refuses any markup above 100 bps.

```sh
# 0) which routes, with Satora's live min / max (free, nothing is created)
mark swap routes
# 1) quote (free, nothing is created)
mark swap quote --from lightning --to usdc --sats 100000
# 2) preview with your payout address (still nothing is created)
mark swap --from lightning --to usdc --sats 100000 --address 0xYourArbitrumAddress
# 3) create it, pay the invoice it prints, and let Mark claim the stablecoins
mark swap --from lightning --to usdc --sats 100000 --address 0xYourArbitrumAddress --yes --wait
# USDC on Base instead (your 0x address on Base; settled on Arbitrum One, bridged over Circle CCTP)
mark swap --from lightning --to usdc-base --sats 100000 --address 0xYourBaseAddress
# Lightning ↔ Arkade (same pattern; --address is an Arkade address, not 0x)
mark swap quote --from lightning --to arkade --sats 1000
mark swap --from lightning --to arkade --sats 1000 --address ark1… --yes --wait
mark swap quote --from arkade --to lightning --sats 900
mark swap --from arkade --to lightning --invoice lnbc… --yes --wait
```

Example quote (100,000 sats, Lightning → USDC; numbers move with the market):

```json
{"quote":{"from":"lightning","to":"usdc","payAmountSats":100000,"rate":"61292.781 USDC per BTC","receive":"60.675562",
 "fees":{"satoraFeeSats":500,"satoraFeeRate":0.005,"satoraFeePercent":"0.5%","agentEscrowMarkupSats":500,"agentEscrowMarkupBps":50,"agentEscrowMarkup":"0.5%","networkFeeSats":7,"totalFeeSats":1007,"totalFeeRate":0.01,"totalFeePercent":"1%"},
 "markupNote":"Total fee: 1% (Satora 0.5% + Agent Escrow 0.5%) plus 7 sats network fee. Paid inside the swap; nothing extra to send.",
 "limits":{"minSats":356,"maxSats":20000000},"referral":"lnds_29617a89f8a6b5a7"}}
```

- `mark swap routes` (`swap_routes`) lists the fourteen supported routes: `--from lightning|arkade` × `--to usdc|usdt0|usdc-base` (`direction`: `btc_to_stablecoin`; `usdc` and `usdt0` on Arbitrum One, `usdc-base` USDC on Base with a `bridge` field), then back, `--from usdc|usdt0|usdc-base` × `--to lightning|arkade` (`direction`: `stablecoin_to_btc`; `usdc-base` with a `bridge` field naming the gas it needs: `ETH on Base`), plus `--from lightning --to arkade` and `--from arkade --to lightning` (`direction`: `lightning_to_arkade` or `arkade_to_lightning`). Each stablecoin route shows the token contract; every route shows Satora's live `limits` (`minSats`, `maxSats`), read from a quote per route; nothing is created. When those quotes succeed, each route also shows Satora's live pair rate (`fees.totalFeePercent`, `fees.satoraFeePercent`). Because the rates differ across routes, the summary note is `Fees depend on the route and are shown on the live quote. Lightning or Arkade to USDC or USDT0 on Arbitrum One or USDC on Base (and back) is about 1% total (Satora ~0.5% + Agent Escrow 0.5%) plus network fee; USDC on Base also pays Circle's CCTP bridge fee (about 0.05 USDC, in USDC, taken from the payout; the live quote shows it); USDC from Base also pays Circle's CCTP fee (about 0.02% of the amount, in USDC, taken from the deposit) and Base gas for two transactions (approve and burn), paid in ETH on Base by the deposit address (usually well under 0.0001 ETH); the live quote shows both. Lightning to Arkade is about 0.65% total (Satora ~0.15% + Agent Escrow 0.5%) plus network fee. Arkade to Lightning is about 0.80% total (Satora ~0.30% + Agent Escrow 0.5%) plus network fee`. If Satora cannot be reached (or on mutinynet), unavailable routes have `"limits": "unavailable"` plus a `limitsNote`. Other Satora pairs are not supported yet.
- `--from lightning` (default) prints a Lightning **hold invoice**: pay it once from any wallet. It settles only when the stablecoins are claimed; otherwise it expires and your wallet keeps the sats.
- `--from arkade` prints an Ark address and the exact `amountSats`: pay it in ONE payment from an Arkade wallet on https://arkade.computer (not Bark / Second). If the swap fails, `mark swap refund <id> --to <your ark address>` after its timelock.
- `--to usdc` (default, USDC on Arbitrum One), `--to usdt0` (USDT0 on Arbitrum One, the former USDT contract `0xFd08…Cbb9`) or `--to usdc-base` (native USDC on Base, `0x8335…2913`, chain 8453). Every quote shows the payout `token.network` and `token.chainId`.
- **USDC on Base** (`--to usdc-base`): Satora settles the swap in USDC on Arbitrum One and, at the (gasless) claim, Circle's CCTP carries it to the same `--address` on Base, usually within a few minutes. Circle's bridge fee is in USDC, taken from the payout and shown in the quote (`fees.bridgeFee`, `fees.bridgeFeeUnits`, and the `markupNote`); `receive` is after it. `payoutTx` is the claim on Arbitrum One (Arbiscan link); the `bridge` field links your address on Basescan (and `deliveryTx` once Satora reports it). The other direction (USDC on Base → BTC) is not supported yet: Satora funds it with a CCTP burn signed on Base, which needs ETH on Base (not gasless).
- `--address` is your EVM address on the payout network (Arbitrum One, or Base for `usdc-base`). Mixed-case addresses must have a valid EIP-55 checksum. **A payout to a wrong address cannot be undone.**
- `--wait` waits for the payment (up to `--timeout`, default 900 s), claims as soon as Satora funds its side (gasless: you need no ETH), and prints `payoutTx` with an Arbiscan link. Its `status` is the final one (`serverredeemed`) once Satora reports it within a few seconds of the claim, else the status at claim time (`serverfunded`); `mark swap status <id>` shows the latest. Without `--wait`, run `mark swap claim <id> --wait` after paying.
- Non-custodial: the swap's claim and refund keys and its preimage stay in this Mark home (`~/.mark/bitcoin/swaps/`, encrypted, files 0600), derived from the agent key. Claim from the same Mark home. Mark holds no API secret: only the public referral ID.
- Before showing anything to pay, Mark checks Satora's swap: it is a new unpaid swap from the source you chose to the token and chain you chose (Arbitrum One; for `usdc-base`, Arbitrum USDC bridged to exactly USDC on Base), the payout address is yours, the amount is what you asked for, the stablecoin amount it promises is at most 1% below the quote, and the invoice (this network, that amount) or Ark address is valid. Otherwise it refuses with `SWAP_FAILED`.
- **Expected vs received.** At create Mark shows `expectedReceive`, Satora's estimate: the BTC is locked as a BTC token and swapped into the stablecoin on a DEX when it is claimed, so the amount that arrives can be a little different (a live 5,000-sat swap: 3.03146 USDC expected, 3.022431 arrived). After the payout, `received` (and `receivedUnits`) is read from the payout transaction's token transfer to your address; if the receipt cannot be read yet, `receivedNote` says so and no amount is claimed.
- `mark swap status <id>` (read-only) and `mark swap claim <id>` (safe to repeat) work on any swap this home created. Once a payment is seen (`clientfundingseen`, `clientfunded`) they say so: **do not pay again**.

**First mainnet test (small):** `mark swap quote --sats 5000`, then `mark swap --sats 5000 --address <your 0x address> --yes --wait`, pay the invoice (about 5,000 sats), check `payoutTx` on Arbiscan and the USDC in your wallet (about 3 USDC at today's rate, minus the fees shown).

### Stablecoins back to BTC

`mark swap --from usdc|usdt0|usdc-base --to lightning|arkade` swaps USDC or USDT0 on Arbitrum One, or USDC on Base, into BTC. **From Arbitrum One it is gasless: you need no EVM wallet in Mark and no ETH.** From USDC on Base, the deposit address also needs a little **ETH on Base** for gas ([below](#usdc-on-base-to-btc)). Same total fee (about 1%: Satora ~0.5% + Agent Escrow 0.5%, plus network fee), same referral ID and `extraFees` on the quote and the swap, same 100 bps cap; the quote shows the live rates and the fee in sats.

```sh
# quote (free): send 1.5 USDC, paid out over Lightning
mark swap quote --from usdc --to lightning --amount 1.5
# Lightning payout to an invoice you made (the invoice fixes the sats; no --amount)
mark swap --from usdc --to lightning --invoice lnbc24200n1… --yes --wait
# or to an Ark address from an Arkade wallet on https://arkade.computer
mark swap --from usdc --to arkade --address ark1… --amount 1.5 --yes --wait
# from USDC on Base (the deposit address also needs a little ETH on Base for gas)
mark swap quote --from usdc-base --to lightning --amount 2
mark swap --from usdc-base --to lightning --invoice lnbc…  --yes --wait
```

How it works:

1. Mark creates the swap with `gasless: true`. The depositor is this Mark home's own EVM key, derived from the agent key and kept in the encrypted swap storage (`~/.mark/bitcoin/swaps/`), never printed.
2. Before showing anything, Mark checks Satora's answer: a new gasless swap on Arbitrum One (chain 42161), from the token you chose (its contract), depositing to this Mark home's own address, for exactly the `--amount` (or at most 1% above the quote for an invoice), paying out to exactly your invoice or your Ark address (on the swap's Arkade server), with the sats at most 1% below the quote. Otherwise `SWAP_FAILED`: deposit nothing.
3. It prints `deposit`: `address`, `amount`, `token`, `contract`, `chainId`. **Send that amount of that token on Arbitrum One to that address, in ONE transfer**, from any wallet or exchange that sends ERC-20s on Arbitrum. If the address already holds some of the token, `deposit.send` is only the missing part ("send NOTHING" if it holds enough).
4. Once the deposit is there, Mark locks it (`fundSwapGasless`): on Arbitrum the Satora client submits a paymaster-sponsored transaction from the deposit key (no ETH, no server relay). With `--wait` Mark watches the address and does this itself; else run `mark swap fund <id> [--wait]`. It funds **at most once**: concurrent calls share one funding, and a submitted or uncertain funding is never signed again (only a clear refusal before anything is submitted allows a retry); if Satora never sees it, `mark swap recover` works 30 minutes after the attempt. Mark funds only while the payout invoice has at least 5 minutes left. Once funds are seen, Mark never tells anyone to deposit again. Before creating the swap, Mark checks that this funding path is available, and refuses rather than show a deposit address that could not be moved later.
5. Satora pays the invoice (Lightning) or funds the Ark payout, which Mark claims to your Ark address. `--wait` (default `--timeout` 1800 s) ends with `"swap":"done"`.

All swaps from a stablecoin in one Mark home share that deposit address, so Mark allows one waiting deposit at a time (`SWAP_OPEN_DEPOSIT`). At create Mark records the confirmed payout target, token and amount in the Mark home; every later status, fund, claim, refund or recover checks Satora's answer against that record and this home's own deposit address, and refuses with `SWAP_FAILED` (showing no deposit address) if anything changed. If the record is missing (or the swap is from another Mark home), status shows only the swap's state with no deposit address, amount or token, and fund and claim refuse; refund and recover still work without it, since they only return funds through this home's own key to an address you give. Mark funds only while the payout invoice has at least 5 minutes left (else it points you to `mark swap recover`), and refuses an invoice already used for another swap in the same home.

**Recovery.** If the swap ends without a payout after the deposit was locked, `mark swap refund <id>` (no `--to`) gets it back to the deposit address, gasless: Satora's collaborative refund first, else the sponsored refund after the timelock. Stablecoins sitting at the deposit address (never locked, or refunded) are sent to your own address with `mark swap recover <id> --to <your 0x address>`. That is a normal ERC-20 transfer from the deposit address, so it needs a little Arbitrum ETH there for gas; Mark says how much (about 0.00001 ETH) and moves nothing until it is there. `mark swap status <id>` shows the deposit seen so far and the next step.

#### USDC on Base to BTC

`--from usdc-base` takes native USDC on Base (`0x8335…2913`, chain 8453). Satora swaps it on its hub chain, so Circle's CCTP carries it there first. What happens:

1. Same create and checks as above, plus: the swap must be a Base-sourced swap of exactly USDC on Base (Satora's `bridge_source_chain` `Base` and the Base USDC contract), recorded in the Mark home with the other confirmed terms.
2. `deposit` names `network: "Base"` and adds `gas`: `needEth` (the estimate, with headroom) and `holdsEth` (what the deposit address holds now). **Send the USDC on Base, and once a little ETH on Base (0.0001 ETH covers many swaps), to the deposit address.** The ETH stays there for later swaps.
3. `mark swap fund <id>` (or `--wait`) first checks, before anything is signed, that the deposit address holds the USDC and at least `needEth` ETH on Base. If the ETH is short it fails with `SWAP_NEEDS_GAS`, saying how much is needed, how much is held and how much to send; nothing is signed. Then Mark signs two transactions on Base from the deposit key: a USDC `approve` and Circle's CCTP `depositForBurn` (Base gas, paid in ETH by the deposit address). The Satora client waits for Circle's attestation and mints and locks the USDC with one sponsored transaction (no ETH needed there).
4. The quote shows Circle's fee (`fees.bridgeFee`, about 0.02% of the amount, taken from the deposit) and `gas` (`eth`, `wei`, and `usd` when a price is available) for the approve + burn. Gas comes from Base's live gas price ×3 plus the L1 data fee ×2, for 80,000 + 200,000 gas (a USDC approve is typically under 60,000; a burn measured about 109,000).

Recovery for USDC on Base: before the burn, `mark swap recover <id> --to <0x>` sends the USDC on Base back (one transfer on Base, gas from the deposit address). Once the burn is sent, the USDC has left Base: if the swap is not locked yet, `mark swap fund <id>` resumes from that burn (no new burn, no gas); if it never settles, `mark swap recover` (30 minutes after the attempt) has Circle mint it and sends it as USDC on Arbitrum One to the same `--to` address (sponsored, no ETH). A locked deposit that did not pay out: `mark swap refund <id>`, then `mark swap recover` (also on Arbitrum One).

Not supported: Lightning addresses as the payout (Satora would fetch their invoice itself, and Mark could not tell it from anyone else's invoice for the same amount; make a BOLT11 invoice in your wallet instead), funding from your own EVM wallet with a key file (Mark funds from its own deposit address), and on-chain bitcoin payouts.

## 7. Command reference

Global flags: `--network bitcoin|mutinynet`, `--escrow-url URL` (https; http only for `localhost`, `127.0.0.1` or `[::1]`), `--arbiter-pubkey <hex>` (explicit arbiter identity pin; env `MARK_ARBITER_PUBKEY`). Operator-only env `MARK_HOUSE_KEY`: sent as `x-escrow-house` so the escrow operator's own runs are counted as house traffic (sent only to `https://agentescrow.to`, an https origin in `MARK_HOUSE_ORIGIN`, or loopback; leave it unset).

| Command | What it does |
|---|---|
| `mark init [--escrow-url URL]` | Create the key and config for the network |
| `mark pubkey` | Your x-only pubkey |
| `mark demo [--offer id] [--url U \| --text T] [--words N] [--focus F] [--language L] [--question Q] [--scope S] [--topic T] [--yes] [--expect-sats N] [--wait] [--timeout sec] [--new]` | House-seller demo: one real small deal (default: 350-sat page summary). Preview without `--yes`; resumes the open demo deal (§4.0) |
| `mark reputation <pubkey>` | Public reputation of a key on this server: `dealsCompleted`, `satsTransacted` (≈, 2 significant figures), `disputesTotal/Won/Lost` (ruled), `firstSeen`, `lastSeen` (latest completed deal). Funded deals only; an indicator, not a guarantee (wash trading is possible). Accepts 64-hex x-only or 02/03-prefixed keys |
| `mark backup` | Show the backup phrase (interactive terminal only) |
| `mark mcp` | Run as an MCP stdio server |
| `mark escrow create --role buyer\|seller --counterparty <pubkey> --sats N --deadline <sec\|ISO> --title T --description D [--deliverable] [--acceptance] [--deliverable-sha256 <hex>] [--terms-file f.json] [--hash <sha256>] [--arbiter auto\|manual] [--webhook URL]` | Create and sign terms |
| `mark escrow show <id>` | Terms, fee terms, acceptances (verified), evidence (with `deliverableMatch`), `awaiting`, `action_required_for`, `arbiterPolicy`, `counterpartyReputation`, next step |
| `mark escrow accept <id> [--allow-counterparty-rule]` | Verify `termsHash`, the escrow address and the arbiter attestation locally, then sign (prints `awaiting`, `action_required_for`, `dealCheck`). A buyer needs `--allow-counterparty-rule` for a rule the seller chose (v2) |
| `mark escrow limits [--sats N]` | Limits, fee schedule, fee preview |
| `mark escrow fund <id> [--wait] [--timeout sec] [--allow-counterparty-rule]` | Lightning invoice to fund (shown again while unpaid); `--wait` claims into the escrow. Refuses (`UNSAFE_RULE`) a deal whose auto-release rule the seller chose (its own hash lock, or any webhook rule) unless `--allow-counterparty-rule` |
| `mark escrow fund <id> --ark [--wait] [--timeout sec] [--switch-rail]` | Direct Ark payment, no swap fee: prints `escrowAddress`, the exact `amountSats` and the Arkade server (`payTo.arkServer`). Pay it in ONE payment from an Arkade wallet on that server (not Bark / Second). `--wait` polls until funded and records rail `ark`. `--switch-rail`: only if nothing was paid on the other rail (also on plain `fund`) |
| `mark escrow fund <id> --from usdc\|usdt0\|usdc-base [--wait] [--timeout sec] [--switch-rail] [--allow-counterparty-rule]` | Fund with stablecoins (mainnet): deposit address, exact token amount and every fee; `--wait` locks the deposit and claims the sats into the escrow (only while the deal waits for funding). `usdc-base` needs a little ETH on Base. `DEADLINE_TOO_CLOSE` under 30 min (60 for `usdc-base`) |
| `mark escrow fund <id> --resume-claim` | Paid, but the claim into the escrow failed or did not finish (`claimFailed`, or a timeout at `serverfunded` / `clientredeeming`): finish or retry it. Never creates an invoice |
| `mark escrow status <id>` | Full deal state, proposals, events, local swap status, `awaiting`, `action_required_for`, `arbiterPolicy` |
| `mark escrow quote <id> [--path release\|refund] [--dest <lnaddr\|bolt11> \| --payout-stable usdc\|usdt0\|usdc-base]` | Payout amounts; exact with `--dest`; `--payout-stable` previews a stablecoin payout (fees, what arrives) |
| `mark escrow pending [<id>]` | Pending payout proposals and payout details. **No id:** across all my deals (local + server listing `needs=sign`), with `awaiting`, `needsMySignature` and the co-sign command |
| `mark escrow approve <id> [--payout-invoice B \| --payout-lnaddr A \| --payout-ark X \| --payout-stable usdc\|usdt0\|usdc-base --payout-address 0x…] [--kind release\|refund] [--with counterparty\|arbiter] [--preimage hex] [--wait] [--timeout sec]` | Payee: propose and sign. Co-signer: sign (no payout flags) |
| `mark escrow refund <id> --payout-… [--with arbiter\|counterparty]` | Buyer proposes a refund |
| `mark escrow refund-payout <id> [--to <ark address>]` | Recover a failed Lightning or stablecoin payout swap (after its timelock) |
| `mark escrow claim-payout <id> [--wait] [--timeout sec]` | Stablecoin payout: claim the stablecoins to your `--payout-address` (gasless) once the payout tx is out; from the Mark home that proposed it; safe to repeat |
| `mark escrow dispute <id> [--reason "..."]` | Open a dispute (the operator rules) |
| `mark escrow evidence <id> [--file <path>] [--text "..."] [--sha256 hex] [--url https://…]` | Signed evidence note (`--note` is an alias). `--file` hashes locally and matches `deliverableSha256` |
| `mark escrow messages <id> [--since N]` | Read the thread |
| `mark escrow message <id> --text "..." [--kind question\|dispute\|evidence\|info] [--reply-to <msgId>]` | Post to the thread |
| `mark escrow inbox` | Unread messages across your deals |
| `mark escrow invites [--all] [--needs accept\|fund\|sign\|any] [--state s]` | Deals for my key: waiting for my accept (default), or all / filtered. Each item has `needs`, `awaiting`, `action_required_for`, `nextStep`. Signed request, no id needed |
| `mark swap quote [--from lightning\|arkade] [--to usdc\|usdt0\|usdc-base] --sats N` | Quote BTC → stablecoin (Arbitrum One, or USDC on Base): rate, what you receive, and the fees (about 1% total: Satora ~0.5% + Agent Escrow 0.5%, plus network fee; live rates are in the quote). Nothing is created |
| `mark swap quote --from lightning --to arkade --sats N` | Quote Lightning → Arkade: sats you pay, sats you receive, and the fees (about 0.65% total: Satora ~0.15% + Agent Escrow 0.5%, plus network fee; live rates are in the quote). Nothing is created |
| `mark swap quote --from arkade --to lightning (--sats N \| --invoice <bolt11>)` | Quote Arkade → Lightning: sats to send (or the invoice Satora will pay), and the fees (about 0.80% total: Satora ~0.30% + Agent Escrow 0.5%, plus the quote's Lightning network fee). Nothing is created |
| `mark swap routes` | Every route Mark supports (fourteen routes: Lightning / Arkade ⇄ USDC / USDT0 on Arbitrum One or USDC on Base, plus Lightning ↔ Arkade): token contract and chain on the stablecoin routes, and Satora's live min / max sats on every route. Fees depend on the route and are shown on the live quote (about 1% total for Lightning or Arkade to USDC or USDT0 on Arbitrum One or USDC on Base and back, plus Circle's CCTP fee and, from Base, a little Base gas; about 0.65% total for Lightning to Arkade; about 0.80% total for Arkade to Lightning; plus network fee; live pair rates when Satora can be reached). Read-only |
| `mark swap [--from lightning\|arkade] [--to usdc\|usdt0\|usdc-base] --sats N --address 0x… [--yes] [--wait] [--timeout sec]` | Preview (no `--yes`), or create the swap: prints the invoice / Ark address to pay; `--wait` claims and prints `payoutTx`. About 1% total (Satora ~0.5% + Agent Escrow 0.5%) plus network fee, shown in the quote |
| `mark swap --from lightning --to arkade --sats N --address <ark address> [--yes] [--wait]` | Lightning → Arkade: preview, or create and print a hold invoice; `--wait` claims the sats to your Ark address. About 0.65% total plus network fee, shown in the quote |
| `mark swap --from arkade --to lightning --invoice <bolt11> [--yes] [--wait]` | Arkade → Lightning: preview, or create and print the Arkade address and exact sats to send (not Bark); Satora pays the invoice. About 0.80% total plus the quote's network fee |
| `mark swap status <id>` | Swap status (read-only), amount, `payoutTx` once claimed |
| `mark swap claim <id> [--wait] [--timeout sec]` | Claim a paid swap's stablecoins to its address, or a Lightning-to-Arkade swap's Ark payout (safe to repeat). Arkade-to-Lightning has nothing to claim (Satora pays the invoice) |
| `mark swap --from usdc\|usdt0\|usdc-base --to lightning --invoice <bolt11>` or `--to arkade --address <ark address> --amount <tokens>`, `[--yes] [--wait] [--timeout sec]` | Stablecoin → BTC (gasless from Arbitrum One; `usdc-base` needs a little ETH on Base at the deposit address): preview (no `--yes`), or create the swap and print the deposit address, exact amount and token; `--wait` funds it once the deposit is there and waits for the payout |
| `mark swap fund <id> [--wait] [--timeout sec]` | Swap from a stablecoin: lock the deposit into the swap (at most once; gasless from Arbitrum One; USDC on Base: approve + CCTP burn on Base, `SWAP_NEEDS_GAS` if the deposit address lacks ETH on Base) |
| `mark swap refund <id> --to <ark address>` | Arkade-funded swap that did not pay out: refund after its timelock |
| `mark swap refund <id>` | Swap from a stablecoin whose locked deposit did not pay out: back to the deposit address (gasless) |
| `mark swap recover <id> --to <0x address>` | Swap from a stablecoin: send the stablecoins at the deposit address to your address (needs a little ETH there on the deposit network; USDC on Base after its burn: sent on Arbitrum One, sponsored) |

Usage mistakes return `{"code":"USAGE","error":"…","details":{"usage":…}}` before any network call.

## 8. Agent tools (MCP)

Run `mark mcp [--network …] [--escrow-url …]` as a stdio MCP server. Example client config: `{"mcpServers":{"mark":{"command":"npx","args":["-y","@yuvlero/mark@latest","mcp"]}}}` (or `{"command":"mark","args":["mcp"]}` if installed) (mainnet uses https://agentescrow.to; add `"env":{"MARK_ESCROW_URL":"https://…"}` to override).

| Tool | Equivalent |
|---|---|
| `pubkey` | `mark pubkey` |
| `escrow_demo` (offer?, url?, text?, words?, focus?, language?, question?, scope?, topic?, confirm?, expectSats?, wait?, fresh?) | `demo` (creates the real deal only with `confirm: true`) |
| `escrow_create` (role, counterparty, sats, deadline, terms{…}, hash?, arbiterMode?, webhookUrl?) | `escrow create` |
| `escrow_show`, `escrow_accept` (id, allowCounterpartyRule?), `escrow_status` | same names (each includes `counterpartyReputation`, best effort; show/accept include `dealCheck`; show/status include `deadlineCountdown`: refund `deadline` and a recommended, earlier `disputeBy`) |
| `escrow_reputation` (pubkey) | `reputation <pubkey>` |
| `escrow_pending` (id? — omit for all my deals) | `escrow pending [<id>]` |
| `escrow_limits` (sats?) | `escrow limits` |
| `escrow_fund` (id, rail?, from?, wait?, allowCounterpartyRule?, switchRail?, resumeClaim?) | `escrow fund` (`rail: "ark"` = `--ark`, `from: "usdc"\|"usdt0"\|"usdc-base"` = `--from`, `switchRail` = `--switch-rail`, `resumeClaim` = `--resume-claim`) |
| `escrow_quote` (id, path?, dest?, payoutStable?) | `escrow quote` |
| `escrow_approve` (id, payoutInvoice? / payoutLnaddr? / payoutArk? / payoutStable? + payoutAddress?, kind?, with?, preimage?, wait?) | `escrow approve` |
| `escrow_refund` (id, payout…, with?) | `escrow refund` |
| `escrow_refund_payout` (id, to?) | `escrow refund-payout` |
| `escrow_claim_payout` (id, wait?) | `escrow claim-payout` |
| `escrow_dispute` (id, reason?) | `escrow dispute` |
| `escrow_evidence` (id, text?, note?, sha256?, file?, url?) | `escrow evidence` |
| `escrow_messages` (id, since?), `escrow_message` (id, text, kind?, replyTo?), `escrow_inbox` | messages |
| `escrow_invites` (all?, needs?, state?) | `escrow invites` |
| `swap_quote` (from?, to?, sats) | `swap quote` |
| `swap_routes` | `swap routes` |
| `swap_create` (from?, to?, sats, address, confirm?) | `swap` (creates the real swap only with `confirm: true`; then pay and call `swap_claim` with `wait: true`) |
| `swap_to_btc_quote` (from, to?, amount?, invoice?, address?) | `swap quote --from usdc\|usdt0` |
| `swap_to_btc_create` (from, to?, amount?, invoice?, address?, confirm?) | `swap --from usdc\|usdt0` (creates the real swap only with `confirm: true`; then deposit once and call `swap_fund` with `wait: true`) |
| `swap_fund` (id, wait?), `swap_recover` (id, to) | `swap fund`, `swap recover` |
| `swap_status` (id), `swap_claim` (id, wait?), `swap_refund` (id, to?) | `swap status`, `swap claim`, `swap refund` |

## 9. Error codes

| Code | Meaning / what to do |
|---|---|
| `USAGE` | Wrong command or flags; see `details.usage` |
| `NOT_INITIALIZED` | Rare: the key is auto-created; run `mark init --network <n>` |
| `ESCROW_URL_MISSING` | Only on networks without a default (e.g. mutinynet): set `MARK_ESCROW_URL` or `--escrow-url` |
| `ESCROW_UNREACHABLE` / `ESCROW_BAD_RESPONSE` | Server down or wrong URL; retry later |
| `UPGRADE_REQUIRED` | This Mark is older than the escrow server accepts (HTTP 426). Update: `npx -y @yuvlero/mark@latest` (or `npm install -g @yuvlero/mark@latest`). MCP: set the args to `["-y", "@yuvlero/mark@latest", "mcp"]` and restart the MCP client. Nothing was changed on the server; repeat the command after updating. A softer `mark: Mark x.y.z is available` stderr line (MCP: `updateNotice`) means update soon ([API §7](docs/escrow-api.md#7-client-versions--deprecation-policy)) |
| `NOT_A_PARTY` | Your pubkey is neither buyer nor seller of this deal |
| `NOT_FOUND` | Unknown deal or proposal id |
| `AMOUNT_TOO_SMALL` / `LIMIT_EXCEEDED` | Deal size outside `minDealSats.enforced..1,000,000` |
| `DEMO_UNSAFE_OFFER` / `DEMO_NETWORK_MISMATCH` / `DEMO_OFFER_CHANGED` / `DEMO_UNKNOWN_OFFER` | `mark demo` refused the server's offer (above 3,299 sats, wrong network, not the amount you passed in `--expect-sats`, or no such `--offer`). Nothing was created; run `mark demo` again to review |
| `DEMO_INPUT_REQUIRED` / `DEMO_BAD_INPUT` | The demo needs an input (e.g. `--url`) or one is invalid (not https, `--words` out of range, a key the offer doesn't use). See `details`; nothing was created |
| `BAD_TERMS` / `BAD_PUBKEY` / `BAD_DEADLINE` / `BAD_AMOUNT` | Invalid create input |
| `TERMS_HASH_MISMATCH` / `FEE_TERMS_MISMATCH` | Server terms differ from what Mark computed; **do not accept or fund**. If Mark printed an update notice, update Mark first and retry |
| `TERMS_NOT_ACCEPTED` | Funding is blocked until both parties run `accept` (v2: also when the server's deal no longer matches the signatures) |
| `TERMS_CHANGED` | The server's deal hash is not the one you signed; **do not fund** |
| `ADDRESS_MISMATCH` | The server's escrow address is not the contract of the deal's keys; **do not fund**, report it |
| `ARBITER_KEY_CHANGED` / `ARBITER_KEY_MISMATCH` / `ARBITER_KEY_MISSING` | The server's arbiter identity is not the pinned one (or is gone). Possible impersonation: **do not fund**. Re-pin only after confirming the new key with the operator: `--arbiter-pubkey <key>` |
| `ARBITER_ATTESTATION_INVALID` | The deal's arbiter key / address is not signed by the pinned identity; **do not accept or fund** |
| `UNSAFE_RULE` | The seller chose an automatic release rule; accepting (v2) or funding (v1) needs `--allow-counterparty-rule` |
| `BAD_ESCROW_URL` | Invalid escrow URL, or `http://` to a host other than `localhost`, `127.0.0.1` or `[::1]` |
| `NO_TERMS` | Legacy deal without terms (nothing to accept) |
| `BAD_STATE` | Action not allowed in the current state (e.g. dispute before funding, release on an expired deal) |
| `EXPIRED` | The deal expired unfunded (deadline + grace passed); it cannot be accepted or funded. Create a new deal |
| `DEADLINE_TOO_CLOSE` | `fund` refused: less than an invoice lifetime (1 h) left before the deal expires. Create a new deal with a later deadline |
| `AMOUNT_MISMATCH` | Invoice amount out of range; use `details.recommendedInvoiceSats` |
| `AMOUNTLESS_INVOICE_UNSUPPORTED` | Put `details.setInvoiceAmountSats` on the invoice, or use a Lightning address |
| `INVOICE_EXPIRED` | Invoice expires in under 10 min; make a new one |
| `BAD_INVOICE` / `BAD_DEST` | Undecodable, wrong-network invoice or bad address |
| `QUOTE_UNAVAILABLE` / `SWAP_LOOKUP_FAILED` | Swap provider unreachable or the Lightning address does not resolve; retry |
| `BAD_SIGNERS` / `FORBIDDEN` | Wrong signer set; the payee proposes (seller releases, buyer refunds) |
| `NOTHING_TO_SIGN` | No pending proposal for you |
| `UNSAFE_TX` | The tx does not pay exactly payee + published fee; Mark refused to sign. Report it |
| `FEE_MISMATCH` | A ruling changed the fee; the payee must propose again |
| `UNAUTHORIZED` | Bad signature or clock skew over 10 minutes; check the system clock |
| `RATE_LIMITED` | Too many messages (20 per 10 minutes); wait |
| `BAD_MESSAGE` / `BAD_EVIDENCE` | Empty, too long (4,000) or contains control characters |
| `LOCKED` / `BAD_PASSWORD` | Wrong `MARK_PASSWORD` or password file |
| `NOT_A_TTY` | `backup` needs an interactive terminal |
| `BAD_MARKUP` | `mark swap`: the markup is not a whole number of bps from 0 to 100; nothing was sent |
| `SWAP_AMOUNT` | `mark swap`: amount outside Satora's min/max for the pair (see `details.quote.limits`) |
| `SWAP_UNSUPPORTED_NETWORK` | `mark swap` runs on bitcoin mainnet only |
| `SWAP_BUSY` | `mark swap` from a stablecoin: another Mark process holds this home's deposit lock (create, fund or recover); retry in a minute |
| `SWAP_OPEN_DEPOSIT` | `mark swap` from a stablecoin: another swap of this Mark home still waits for its deposit at the same address; fund it or let it expire |
| `SWAP_DONE` | `mark swap refund`: the swap already paid out; there is nothing to refund |
| `SWAP_FUNDING` | `mark swap recover`: a gasless funding of the swap was just submitted; wait for it (`mark swap status`) before recovering |
| `SWAP_NOT_LOCAL` | `mark swap` from a stablecoin: this Mark home did not create the swap and holds none of its keys; run fund, claim, refund or recover from the home that created it |
| `SWAP_FAILED` | Satora did not create the swap, or what it created does not match what you confirmed (payout address, amount, invoice / Ark address, deposit address). **Do not pay or deposit**; an unpaid swap just expires. Retry |

## 10. Security notes

- Your seed is encrypted at rest. The password file sits next to it by default, so protect the host or move the password out with `MARK_PASSWORD_FILE`.
- Mark refuses to sign unless the outputs are exactly **payee leg to the proposal destination** plus **fee to the fee address in the signed terms**.
- Mark recomputes `termsHash` and verifies every acceptance signature locally. It never trusts the server's word. With terms v2 the signatures also cover the release rule, arbiter mode, deadline and webhook.
- Mark derives the escrow address itself from the deal's keys and refuses to fund a different one. It pins the server's arbiter identity key and checks its signature on every deal.
- Escrow URLs must be `https://` (plain `http://` only to `localhost`, `127.0.0.1` or `[::1]`). The same rule applies to the Arkade server URL an escrow server reports in `/limits`: anything else falls back to Mark's network preset.
- For Lightning payouts, **your** Mark creates the swap and keeps its refund key. For funding, your Mark keeps the claim key. The server never holds them.
- Payout invoices are checked by Mark and the server: amount range, network, and at least 10 minutes of validity left.
- Never paste your backup phrase, password or wallet file into chat, messages or evidence.
- Start on `--network mutinynet` (test coins) if you want a dry run.

## 11. FAQ

- **Why does `accept` say `state: created`?** "Created" means the escrow is not funded yet. Check `agreed: true` and `next`.
- **Why is the funding invoice more than the deal amount?** It includes the Lightning→Ark swap fee.
- **Why is my Lightning payout less than `payeeLegSats`?** The Ark→Lightning swap fee (Satora protocol and routing). Ark payouts have no swap fee.
- **Can I use an amountless invoice?** No. Use `quote --dest` and an invoice for `recommendedInvoiceSats`, or a Lightning address.
- **What if the seller never delivers?** After the deadline, `mark escrow refund <id> --payout-…`; the arbiter co-signs.
- **What if we disagree?** `mark escrow dispute`, then messages and evidence. The operator rules and the winner gets paid (minus the dispute fee).
- **Does the service hold my money?** No. The funds sit in a 2-of-3 Ark contract; the service holds only one key.
- **Can I script it without Mark?** Yes: [docs/escrow-api.md](docs/escrow-api.md) documents the HTTP API and signing.

## Development

```bash
npm ci && npm test          # builds, then runs the unit tests (HTTP mocked)
```
Layout: `src/cli.ts`, `src/mcp.ts` (thin adapters) → `src/core/` (use-cases, terms, fees) → `src/api/escrowApi.ts` (the only HTTP client). Also `src/crypto/` (keystore, PSBT checks), `src/swap/` (Satora) and `src/lightning/` (BOLT11 checks).
