// 0.7.0: escrow with stablecoins at the edges (fund --from, approve/refund --payout-stable, claim-payout, quote --payout-stable).
// The escrow API and the Satora SDK are mocked: no network, no money, nothing is ever sent.
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import * as uc from "../dist/src/core/usecases.js";
import * as es from "../dist/src/core/escrowStable.js";
import { openCtx } from "../dist/src/core/context.js";
import { checkEscrowArgs, parseArgs, ESCROW_USAGE } from "../dist/src/cliArgs.js";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { tmpHome, mockFetch, psbtPaying, payoutArk, MOCK_SERVER_PK } from "./mockApi.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OTHER = "11".repeat(32), URL_ = "https://escrow.test";
const DEP = "0x" + "ab".repeat(20); // this Mark home's gasless deposit address (mock)
const ME = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // a valid EIP-55 payout address
const VHTLC = payoutArk(3, "ark"); // the payout swap's VHTLC, on the deal's (mock) Arkade server
const code = (p) => p.then(() => "OK", (e) => e.code);
/** Satora quote for 5,000 sats from USDC (rate $100k, ~1% fees). */
const FQ = { exchange_rate: "100000", network_fee: 4, gasless_network_fee: 0, protocol_fee: 50, protocol_fee_rate: 0.01, min_amount: 356, max_amount: 20000000,
  source_amount: "5060000", target_amount: "5050", net_source_amount: "5060000", net_target_amount: "5000" };
/** Satora quote for an Arkade -> USDC payout of 5,000 sats. */
const PQ = { exchange_rate: "100000", network_fee: 7, gasless_network_fee: 0, protocol_fee: 50, protocol_fee_rate: 0.01, min_amount: 356, max_amount: 20000000,
  source_amount: "5000", target_amount: "5000000", net_source_amount: "5000", net_target_amount: "4943000" };

function mockClient(o = {}) {
  const calls = { getQuote: [], createSwap: [], getSwap: [], fund: [], claimArkade: [], claim: [], refund: [] };
  const stored = {}; let statuses = [...(o.statuses ?? ["pending"])];
  const client = {
    getEvmAddress: () => DEP,
    gaslessFundingPlan: () => ({ mode: "sponsored" }),
    getQuote: async (p) => { calls.getQuote.push(p); return p.sourceChain === "Arkade" ? (o.payQuote ?? PQ) : (o.quote ?? FQ); },
    createSwap: async (p) => {
      calls.createSwap.push(p);
      if (p.source.chain === "Arkade") {
        const r = { id: "po-1", status: "pending", source_amount: String(p.sourceAmount), target_amount: "4943000", target_evm_address: p.targetAddress,
          source_token: { chain: "Arkade", token_id: "btc", symbol: "BTC", decimals: 8 }, target_token: { chain: p.target.chain, token_id: p.target.tokenId, symbol: "USDC", decimals: 6 },
          evm_chain_id: Number(p.target.chain), btc_vhtlc_address: VHTLC, ...(o.payTamper ?? {}) };
        stored[r.id] = { swapId: r.id, response: { ...r, direction: "arkade_to_evm", arkade_server_pk: "02" + MOCK_SERVER_PK } }; return { response: r };
      }
      const r = { id: `rv-${calls.createSwap.filter((x) => x.source.chain !== "Arkade").length}`, status: "pending", gasless: true, client_evm_address: DEP, source_amount: p.sourceAmount,
        source_token: { chain: p.source.chain, token_id: p.source.tokenId, symbol: "USDC", decimals: 6 }, evm_chain_id: 42161,
        target_token: { chain: p.target.chain, token_id: "btc", symbol: "BTC", decimals: 8 }, target_amount: o.targetSats ?? "5020",
        target_arkade_address: p.targetAddress, arkade_server_pk: o.serverPk ?? "02" + MOCK_SERVER_PK };
      stored[r.id] = { swapId: r.id, fresh: true, response: { ...r, direction: "evm_to_arkade" } }; return { response: r };
    },
    getSwap: async (id) => {
      calls.getSwap.push(id);
      if (id === "po-1") return { ...stored[id].response, status: o.payStatus ?? "pending", ...(o.payRead ?? {}) };
      if (stored[id]?.fresh) { stored[id].fresh = false; return stored[id].response; }
      const s = statuses.length > 1 ? statuses.shift() : statuses[0]; const base = stored[id]?.response ?? {};
      const r = { ...base, id, status: s, ...(s !== "pending" && !o.noFundTx ? { evm_fund_txid: "0xfund" } : {}), ...(s !== "pending" && o.repriceTo ? { target_amount: o.repriceTo } : {}) }; if (stored[id]) stored[id].response = r; return r;
    },
    getStoredSwap: async (id) => stored[id] ?? null,
    swapStorage: { getAll: async () => Object.values(stored) },
    fundSwapGasless: async (id) => { calls.fund.push(id); return { txHash: "0xfund" }; },
    claimArkade: async (id, opts) => { calls.claimArkade.push({ id, ...opts }); return { success: true, txId: "arkclaim1" }; },
    claim: async (id) => { calls.claim.push(id); return { success: true, txHash: "0xpayout", message: "ok" }; },
    refundSwap: async (id, opts) => { calls.refund.push({ id, ...opts }); return { success: true, txId: "arkrefund1" }; },
    getSwapDepositorKey: async () => { throw new Error("not in these tests"); },
  };
  return { client, calls, stored };
}
function provider(client, o = {}) {
  const p = new SatoraProvider(client, "https://swap.test", "https://arkade.computer", fs.mkdtempSync(path.join(os.tmpdir(), "mark-es-")));
  let bals = [...(o.balances ?? [0n])];
  p.evm = { tokenBalance: async () => (bals.length > 1 ? bals.shift() : bals[0]), ethBalance: async () => 0n, gasPrice: async () => 20_000_000n, transferredTo: async () => 4943000n };
  p.signerFor = async () => ({ address: DEP, fake: true });
  return p;
}
const deal = (c, o = {}) => ({ id: "e1", network: "bitcoin", state: "created", amountSats: 5000, deadline: new Date(Date.now() + 86400e3).toISOString(), buyerPubkey: c.pubkey, sellerPubkey: OTHER, proposals: [], terms: null, ...o });
async function ctx({ dealOf = (c) => deal(c), routes = {}, client = mockClient().client, network = "bitcoin", balances } = {}) {
  tmpHome(); await uc.init(network); let c0;
  const f = mockFetch({ "GET /escrows/e1": async () => [200, dealOf(c0)], ...routes });
  const c = await openCtx(network, { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => provider(client, { balances }) }); c0 = c; return { c, f };
}

// ---------- fund --from ----------
test("fund --from: Satora's quote by target is GROSS (live 26 Nov 2026): the deposit is grossed up by source quote until the net covers the deal", async () => {
  // realistic Satora: by target the source buys exactly the target sats gross (net echoes the target); by source the net is
  // the gross minus 1% + 4 sats network fee. The created swap pays the net of its deposit.
  const netOf = (src) => { const g = Math.floor(Number(src) / 1000); return g - Math.ceil(g * 0.01) - 4; };
  const m = mockClient(); const q0 = m.client.getQuote;
  m.client.getQuote = async (p) => { if (p.sourceChain === "Arkade") return q0(p); m.calls.getQuote.push(p);
    if (p.targetAmount !== undefined) return { ...FQ, source_amount: String(p.targetAmount * 1000), target_amount: String(p.targetAmount), net_target_amount: String(p.targetAmount) };
    const n = netOf(p.sourceAmount); return { ...FQ, source_amount: String(p.sourceAmount), target_amount: String(Math.floor(Number(p.sourceAmount) / 1000)), net_target_amount: String(n) }; };
  const c0 = m.client.createSwap; m.client.createSwap = async (p) => { const r = await c0(p); if (p.source.chain !== "Arkade") r.response.target_amount = String(netOf(p.sourceAmount)); return r; };
  const { c } = await ctx({ client: m.client });
  const r = await es.fundStable(c, "e1", { from: "usdc" });
  const src = BigInt(m.calls.createSwap[0].sourceAmount); assert.ok(src > 5060000n, `grossed up above the gross quote (${src})`);
  assert.ok(r.swapPaysSats >= 5000 && r.swapPaysSats <= Math.ceil(5000 * 1.03), `swap pays ${r.swapPaysSats}`); assert.equal(r.newSwap, true);
  assert.ok(m.calls.getQuote.some((x) => x.sourceAmount !== undefined), "re-quoted by source");
});
test("fund --from: a source quote that never reaches the deal is refused before anything is created", async () => {
  const m = mockClient({ quote: { ...FQ, net_target_amount: "10" } }); const { c } = await ctx({ client: m.client });
  assert.equal(await code(es.fundStable(c, "e1", { from: "usdc" })), "QUOTE_UNAVAILABLE"); assert.equal(m.calls.createSwap.length, 0);
});
test("fund --from usdc: swap into the escrow address for at least the deal, with cushion, fee disclosure; one rail per deal", async () => {
  const m = mockClient(); const { c, f } = await ctx({ client: m.client });
  const r = await es.fundStable(c, "e1", { from: "usdc" });
  assert.equal(r.rail, "stable"); assert.equal(r.newSwap, true); assert.equal(r.swapId, "rv-1"); assert.match(r.escrowAddress, /^ark1/);
  assert.equal(m.calls.getQuote[0].targetAmount, 5000, "quoted for the exact deal amount");
  const cr = m.calls.createSwap[0]; assert.equal(cr.targetAddress, r.escrowAddress, "Satora pays the escrow address");
  assert.equal(BigInt(cr.sourceAmount), (5060000n * 10050n + 9999n) / 10000n, "0.5% cushion on the deposit"); assert.equal(cr.extraFees, 50);
  assert.equal(r.swapPaysSats, 5020); assert.equal(r.extraSats, 20); assert.equal(r.deposit.address, DEP); assert.equal(r.amountUsd, "~$5.00");
  const d = r.disclosure.join(" "); assert.match(d, /5020 sats paid to the escrow address/); assert.match(d, /Swap fee/); assert.match(d, /Escrow platform fee/); assert.match(d, /two swaps/); assert.match(d, /holds bitcoin/);
  assert.match(r.next, /escrow fund e1 --from usdc --wait/); assert.match(r.next, /swap recover rv-1/);
  const l = c.index.get("e1"); assert.equal(l.fundStableSwap, "rv-1"); assert.equal(l.fundStableFrom, "usdc"); assert.equal(l.fundRail, "stable");
  assert.equal(f.calls.filter((x) => x.key.startsWith("POST")).length, 0, "nothing posted");
  // again: same swap, no second create
  const again = await es.fundStable(c, "e1", { from: "usdc" }); assert.equal(again.newSwap, false); assert.equal(again.swapId, "rv-1"); assert.equal(m.calls.createSwap.length, 1);
  // other token: refused; other rails: refused without --switch-rail
  assert.equal(await code(es.fundStable(c, "e1", { from: "usdt0" })), "FUNDING_IN_PROGRESS");
  await assert.rejects(uc.fund(c, "e1"), (e) => e.code === "FUNDING_IN_PROGRESS" && /--from usdc --wait/.test(e.message) && /--switch-rail/.test(e.message));
  assert.equal(await code(uc.fundArk(c, "e1")), "FUNDING_IN_PROGRESS");
});

test("fund --from: a swap paying less than the deal (or too much, or on another Ark server) is refused before any deposit address", async () => {
  for (const [o, re] of [[{ targetSats: "4999" }, /pays 4999 sats, the deal needs 5000/], [{ targetSats: "5200" }, /far more/], [{ serverPk: "02" + "7c".repeat(32) }, /not this deal's Arkade server|Ark/]]) {
    const m = mockClient(o); const { c } = await ctx({ client: m.client });
    await assert.rejects(es.fundStable(c, "e1", { from: "usdc" }), (e) => e.code === "SWAP_FAILED" && re.test(e.message) && /Do NOT deposit/.test(e.message), JSON.stringify(o));
    assert.equal(c.index.get("e1").fundStableSwap, undefined, "a refused swap is never recorded or shown");
  }
});

test("fund --from: DEADLINE_TOO_CLOSE (30 min; 60 min for usdc-base), expired / funded deals, rail locks the other way, bad token", async () => {
  const soon = (min) => (c) => deal(c, { deadline: new Date(Date.now() - 3600e3 + min * 60e3).toISOString() }); // expiresAt = deadline + 1 h grace
  let { c } = await ctx({ dealOf: soon(20) }); await assert.rejects(es.fundStable(c, "e1", { from: "usdc" }), (e) => e.code === "DEADLINE_TOO_CLOSE" && e.details.minSeconds === 1800);
  ({ c } = await ctx({ dealOf: soon(45) })); await assert.rejects(es.fundStable(c, "e1", { from: "usdc-base" }), (e) => e.code === "DEADLINE_TOO_CLOSE" && e.details.minSeconds === 3600);
  assert.equal((await es.fundStable(c, "e1", { from: "usdc" })).newSwap, true, "45 min is enough for Arbitrum");
  ({ c } = await ctx({ dealOf: (c) => deal(c, { state: "expired" }) })); assert.equal((await es.fundStable(c, "e1", { from: "usdc" })).state, "expired");
  ({ c } = await ctx({ dealOf: (c) => deal(c, { state: "funded" }) })); assert.equal((await es.fundStable(c, "e1", { from: "usdc" })).note, "already funded");
  ({ c } = await ctx()); c.index.set("e1", { fundRail: "ark", fundArkAt: "x" });
  await assert.rejects(es.fundStable(c, "e1", { from: "usdc" }), (e) => e.code === "FUNDING_IN_PROGRESS" && /--switch-rail/.test(e.message));
  assert.equal((await es.fundStable(c, "e1", { from: "usdc", switchRail: true })).newSwap, true);
  assert.equal(await code(es.fundStable(c, "e1", { from: "dai" })), "USAGE");
  ({ c } = await ctx({ network: "mutinynet" })); assert.equal(await code(es.fundStable(c, "e1", { from: "usdc" })), "SWAP_UNSUPPORTED_NETWORK");
});

test("fund --from --wait: deposit locked, sats claimed into the escrow, deal funded; never claims into an expired or funded deal", async () => {
  let m = mockClient({ statuses: ["pending", "pending", "pending", "clientfunded", "serverfunded", "serverfunded", "clientredeemed"] }); let funded = false;
  let { c } = await ctx({ client: m.client, dealOf: (c) => deal(c, funded ? { state: "funded", funding: { outpoint: "ab:0", amount: 5020 } } : {}),
    routes: { "POST /escrows/e1/funding-ark": async () => [200, { escrowId: "e1", recorded: true, rail: "lightning" }] }, balances: [5085300n] });
  const orig = m.client.claimArkade; m.client.claimArkade = async (...a) => { funded = true; return orig(...a); };
  const shown = []; const r = await es.fundStable(c, "e1", { from: "usdc", wait: true, pollMs: 1, timeoutSec: 5, onInstructions: (x) => shown.push(x) });
  assert.equal(shown.length, 1, "deposit instructions before waiting"); assert.equal(m.calls.fund.length, 1); assert.equal(m.calls.claimArkade.length, 1);
  assert.equal(m.calls.claimArkade[0].destinationAddress, r.escrowAddress); assert.equal(r.funded, true); assert.equal(r.state, "funded"); assert.equal(r.ledger.recorded, true);
  // the deal expired while the swap ran: nothing is claimed into it
  m = mockClient({ statuses: ["serverfunded"] }); const made = (mm) => mm.calls.createSwap.length > 0;
  ({ c } = await ctx({ client: m.client, dealOf: (c) => deal(c, made(m) ? { state: "expired" } : {}) }));
  const x = await es.fundStable(c, "e1", { from: "usdc", wait: true, pollMs: 1, timeoutSec: 5, onInstructions: () => {} });
  assert.equal(m.calls.claimArkade.length, 0); assert.equal(x.funded, false); assert.match(x.note, /expired before the swap paid out: NOT claimed/); assert.match(x.note, /swap recover rv-1/);
  m = mockClient({ statuses: ["serverfunded"] });
  ({ c } = await ctx({ client: m.client, dealOf: (c) => deal(c, made(m) ? { state: "funded" } : {}) }));
  const y = await es.fundStable(c, "e1", { from: "usdc", wait: true, pollMs: 1, timeoutSec: 5, onInstructions: () => {} });
  assert.equal(m.calls.claimArkade.length, 0); assert.match(y.note, /already funded \(another payment\): NOT claimed/); assert.equal(y.claimedIntoEscrow, false); assert.equal(y.ledger, undefined);
});

// ---------- approve / refund --payout-stable ----------
const funded = (c, o = {}) => deal(c, { state: "funded", funding: { outpoint: "x:0", amount: 5000 }, buyerPubkey: OTHER, sellerPubkey: c.pubkey, ...o });
function payoutRoutes(state, propose) {
  return {
    "POST /escrows/e1/proposals": async (b) => { state.posted = b; return [200, { escrow: state.escrow(), proposal: { id: "p1" } }]; },
    "GET /escrows/e1/proposals/p1": async () => [200, { id: "p1", kind: state.posted?.kind ?? "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: [], payout: state.posted?.payout ?? propose, arkTx: psbtPaying(VHTLC, 5000), checkpoints: [] }],
    "POST /escrows/e1/proposals/p1/signatures": async (b) => { state.signed = b; return [200, { escrow: state.escrow() }]; },
  };
}
test("approve --payout-stable: exact payee leg to a Satora swap paying my 0x address; proposed as type stable; co-sign check passes", async () => {
  const m = mockClient(); const st = {}; let c0;
  const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c), routes: payoutRoutes(st) }); c0 = c; st.escrow = () => funded(c0);
  // the mock PSBT carries no escrow tapscript: the signer throws only AFTER every Mark check (incl. the Satora check) passed
  await assert.rejects(uc.approve(c, "e1", { payoutStable: "usdc", payoutAddress: ME }), (e) => /No taproot scripts signed/.test(e.message) && !e.code);
  const cr = m.calls.createSwap[0]; assert.equal(cr.source.chain, "Arkade"); assert.equal(cr.sourceAmount, 5000); assert.equal(cr.targetAddress, ME); assert.equal(cr.extraFees, 50);
  assert.deepEqual(st.posted.payout, { type: "stable", address: ME, swapId: "po-1", token: "usdc" }); assert.equal(st.posted.kind, "release");
  const l = c.index.get("e1"); assert.equal(l.payoutSwap, "po-1"); assert.equal(l.payoutStable, "usdc"); assert.equal(l.payoutAddress, ME);
  assert.equal(st.signed, undefined);
});
test("approve --payout-stable: refusals (exclusive flags, bad address, swap not on this Ark server, out of range); co-signer refuses a mismatching swap", async () => {
  const st = {}; let { c } = await ctx({ dealOf: (c) => funded(c), routes: payoutRoutes(st) }); st.escrow = () => funded(c);
  assert.equal(await code(uc.approve(c, "e1", { payoutStable: "usdc", payoutAddress: ME, payoutLnaddr: "a@b.c" })), "BAD_REQUEST");
  assert.equal(await code(uc.approve(c, "e1", { payoutAddress: ME })), "BAD_REQUEST");
  assert.equal(await code(uc.approve(c, "e1", { payoutStable: "usdc" })), "BAD_REQUEST");
  assert.notEqual(await code(uc.approve(c, "e1", { payoutStable: "usdc", payoutAddress: "0x1234" })), "OK");
  assert.equal(await code(uc.approve(c, "e1", { payoutStable: "dai", payoutAddress: ME })), "USAGE");
  let m;
  ({ c } = await ctx({ client: mockClient({ payTamper: { btc_vhtlc_address: undefined } }).client, dealOf: (c) => funded(c), routes: payoutRoutes(st) }));
  assert.notEqual(await code(uc.approve(c, "e1", { payoutStable: "usdc", payoutAddress: ME })), "OK"); assert.equal(st.posted, undefined, "nothing proposed");
  m = mockClient({ payQuote: { ...PQ, min_amount: 6000 } }); ({ c } = await ctx({ client: m.client, dealOf: (c) => funded(c), routes: payoutRoutes(st) }));
  assert.equal(await code(uc.approve(c, "e1", { payoutStable: "usdc", payoutAddress: ME })), "SWAP_AMOUNT"); assert.equal(m.calls.createSwap.length, 0);
  // co-signer (buyer): the server's proposal is checked against Satora before signing
  for (const [o, re] of [[{ payRead: { source_amount: "4999" } }, /asks for 4999 sats/], [{ payRead: { target_evm_address: "0x" + "cd".repeat(20) } }, /it pays 0x/], [{ payStatus: "clientfunded" }, /status clientfunded/], [{ payRead: { direction: "evm_to_arkade" } }, /direction/]]) {
    m = mockClient(o); const s2 = {}; let c2;
    ({ c: c2 } = await ctx({ client: m.client, dealOf: (c) => funded(c, { buyerPubkey: c.pubkey, sellerPubkey: OTHER, proposals: [{ id: "p1", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: ["seller"] }] }), routes: payoutRoutes(s2, { type: "stable", address: ME, swapId: "po-1", token: "usdc" }) }));
    await m.client.createSwap({ source: { chain: "Arkade", tokenId: "btc" }, target: { chain: "42161", tokenId: "x" }, sourceAmount: 5000, targetAddress: ME });
    await assert.rejects(uc.approve(c2, "e1"), (e) => e.code === "UNSAFE_TX" && re.test(e.message), JSON.stringify(o)); assert.equal(s2.signed, undefined);
  }
  m = mockClient(); const s3 = {}; let c3;
  ({ c: c3 } = await ctx({ client: m.client, dealOf: (c) => funded(c, { buyerPubkey: c.pubkey, sellerPubkey: OTHER, proposals: [{ id: "p1", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: ["seller"] }] }), routes: payoutRoutes(s3, { type: "stable", address: ME.toLowerCase(), swapId: "po-1", token: "usdc" }) }));
  await m.client.createSwap({ source: { chain: "Arkade", tokenId: "btc" }, target: { chain: "42161", tokenId: "x" }, sourceAmount: 5000, targetAddress: ME });
  await assert.rejects(uc.approve(c3, "e1"), (e) => /No taproot scripts signed/.test(e.message) && !e.code, "a matching swap passes every check (signer fails on the mock PSBT only)");
  m = mockClient(); m.client.getSwap = async () => { throw new Error("satora down"); }; const s4 = {}; let c4;
  ({ c: c4 } = await ctx({ client: m.client, dealOf: (c) => funded(c, { buyerPubkey: c.pubkey, sellerPubkey: OTHER, proposals: [{ id: "p1", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: ["seller"] }] }), routes: payoutRoutes(s4, { type: "stable", address: ME, swapId: "po-1", token: "usdc" }) }));
  assert.equal(await code(uc.approve(c4, "e1")), "SWAP_UNREACHABLE", "fails closed when Satora can't be read");
});
test("refund --payout-stable: the buyer's refund leg, same swap checks", async () => {
  const m = mockClient(); const st = {}; let c0;
  const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c, { buyerPubkey: c.pubkey, sellerPubkey: OTHER, deadline: new Date(Date.now() - 1000).toISOString() }), routes: payoutRoutes(st) }); c0 = c;
  st.escrow = () => funded(c0, { buyerPubkey: c0.pubkey, sellerPubkey: OTHER });
  await assert.rejects(uc.refund(c, "e1", { payoutStable: "usdt0", payoutAddress: ME }), (e) => /No taproot scripts signed/.test(e.message));
  assert.equal(st.posted.kind, "refund"); assert.deepEqual(st.posted.payout, { type: "stable", address: ME, swapId: "po-1", token: "usdt0" }); assert.deepEqual(st.posted.signers, ["buyer", "arbiter"]);
});

// ---------- claim-payout / refund-payout / quote ----------
test("claim-payout: waits for the payout tx, claims the stablecoins (gasless); refuses without a stablecoin payout; refund-payout covers it", async () => {
  let m = mockClient({ payStatus: "serverfunded" }); let state = "funded";
  let { c } = await ctx({ client: m.client, dealOf: (c) => funded(c, { state }) });
  assert.equal(await code(es.claimPayout(c, "e1")), "NOT_FOUND");
  c.index.set("e1", { payoutSwap: "po-1" }); assert.equal(await code(es.claimPayout(c, "e1")), "USAGE", "Lightning payout: nothing to claim");
  await m.client.createSwap({ source: { chain: "Arkade", tokenId: "btc" }, target: { chain: "42161", tokenId: "x" }, sourceAmount: 5000, targetAddress: ME });
  c.index.set("e1", { payoutSwap: "po-1", payoutStable: "usdc", payoutAddress: ME });
  const early = await es.claimPayout(c, "e1"); assert.equal(early.claimed, false); assert.match(early.note, /not submitted yet/); assert.equal(m.calls.claim.length, 0);
  state = "released";
  const r = await es.claimPayout(c, "e1", { pollMs: 1 }); assert.equal(m.calls.claim.length, 1); assert.equal(m.calls.claim[0], "po-1"); assert.equal(r.payoutAddress, ME); assert.equal(r.state, "released");
  m = mockClient({ payStatus: "expired" }); ({ c } = await ctx({ client: m.client, dealOf: (c) => funded(c, { state: "released" }) }));
  await m.client.createSwap({ source: { chain: "Arkade", tokenId: "btc" }, target: { chain: "42161", tokenId: "x" }, sourceAmount: 5000, targetAddress: ME });
  c.index.set("e1", { payoutSwap: "po-1", payoutStable: "usdc", payoutAddress: ME });
  const x = await es.claimPayout(c, "e1", { pollMs: 1 }); assert.equal(m.calls.claim.length, 0); assert.match(x.recover ?? x.note, /refund-payout|refund/);
  const back = await uc.refundPayout(c, "e1", payoutArk(9, "ark")); assert.equal(back.success, true); assert.equal(m.calls.refund[0].id, "po-1"); assert.equal(m.calls.refund[0].destinationAddress, payoutArk(9, "ark"));
});
test("quote --payout-stable: payee leg, escrow fee, swap fee and what arrives; nothing created", async () => {
  const m = mockClient(); const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c), routes: { "GET /escrows/e1/quote": async () => [200, { path: "release", escrowSats: 5000, ark: { payoutSats: 4950 } }] } });
  const q = await es.quoteStablePayout(c, "e1", "release", "usdc");
  assert.equal(q.payeeLegSats, 4950); assert.equal(q.escrowFeeSats, 50); assert.equal(m.calls.getQuote[0].sourceAmount, 4950); assert.equal(m.calls.getQuote[0].extraFees, 50);
  assert.equal(m.calls.createSwap.length, 0); assert.ok(q.totalFees.swapFeeSats > 0); assert.match(q.note, /two swaps/); assert.match(q.next, /--payout-stable usdc --payout-address/);
});

// ---------- CLI and MCP ----------
test("CLI: --from / --payout-stable / --payout-address / claim-payout validation", () => {
  const chk = (argv) => { const { pos, f } = parseArgs(argv); return checkEscrowArgs(pos[0], pos[1], f); };
  for (const ok of [["fund", "e1", "--from", "usdc"], ["fund", "e1", "--from", "usdc-base", "--wait", "--timeout", "1800"], ["fund", "e1", "--from", "usdt0", "--switch-rail"],
    ["approve", "e1", "--payout-stable", "usdc", "--payout-address", ME], ["approve", "e1", "--payout-stable", "usdt0", "--payout-address", ME, "--wait"],
    ["refund", "e1", "--payout-stable", "usdc-base", "--payout-address", ME], ["quote", "e1", "--payout-stable", "usdc"], ["claim-payout", "e1", "--wait", "--timeout", "600"]]) assert.equal(chk(ok), null, ok.join(" "));
  const bad = [[["fund", "e1", "--from", "dai"], /--from must be/], [["fund", "e1", "--from", "usdc", "--ark"], /pick one/], [["fund", "e1", "--from", "usdc", "--resume-claim"], /resume-claim/],
    [["show", "e1", "--from", "usdc"], /only for escrow fund/], [["approve", "e1", "--payout-stable", "usdc"], /needs --payout-address/],
    [["approve", "e1", "--payout-stable", "usdc", "--payout-address", "0x12"], /EVM address/], [["approve", "e1", "--payout-address", ME], /goes with --payout-stable/],
    [["approve", "e1", "--payout-stable", "usdc", "--payout-address", ME, "--payout-lnaddr", "a@b.c"], /pick one/], [["quote", "e1", "--payout-stable", "usdc", "--dest", "a@b.c"], /pick one/],
    [["approve", "e1", "--payout-lnaddr", "a@b.c", "--wait"], /only for a stablecoin payout/], [["claim-payout", "e1", "--to", "x"], /not an option/], [["claim-payout"], /escrow id required|claim-payout/]];
  for (const [argv, re] of bad) { const r = chk(argv); assert.ok(r, argv.join(" ")); assert.match(r.message, re, argv.join(" ")); }
  assert.match(ESCROW_USAGE["claim-payout"], /claim-payout <id>/); assert.match(ESCROW_USAGE.fund, /--from usdc\|usdt0\|usdc-base/);
});
test("MCP: escrow_fund from, escrow_approve/refund payoutStable+payoutAddress, escrow_quote payoutStable, escrow_claim_payout", async () => {
  const home = tmpHome();
  const t = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/src/cli.js", import.meta.url).pathname, "mcp"], env: { ...process.env, MARK_HOME: home }, stderr: "ignore" });
  const cl = new Client({ name: "t", version: "1" }); await cl.connect(t);
  try {
    const tools = Object.fromEntries((await cl.listTools()).tools.map((x) => [x.name, x]));
    assert.deepEqual(tools.escrow_fund.inputSchema.properties.from.enum, ["usdc", "usdt0", "usdc-base"]);
    for (const n of ["escrow_approve", "escrow_refund"]) { const p = tools[n].inputSchema.properties; assert.deepEqual(p.payoutStable.enum, ["usdc", "usdt0", "usdc-base"]); assert.equal(p.payoutAddress.type, "string"); assert.equal(p.wait.type, "boolean"); }
    assert.deepEqual(tools.escrow_quote.inputSchema.properties.payoutStable.enum, ["usdc", "usdt0", "usdc-base"]);
    assert.ok(tools.escrow_claim_payout); assert.deepEqual(tools.escrow_claim_payout.inputSchema.required, ["id"]);
    assert.match(tools.escrow_refund_payout.description, /stablecoin/);
    const r = await cl.callTool({ name: "escrow_fund", arguments: { id: "e1", from: "usdc", rail: "ark" } }); assert.match(JSON.stringify(r), /USAGE|own funding rail/);
  } finally { await cl.close(); }
});

// ---------- review fixes (Kimi, 2026-11-26) ----------
test("fund --from: the disclosed platform fee is on what the escrow will hold (cushion can cross the free tier)", async () => {
  const fees = { v: 2, freeBelowSats: 3300, flatSats: 0, flatUntilSats: 33000, feeBps: 100, disputeFeeBps: 500, disputeMinSats: 330, dustSats: 330, address: payoutArk(8, "ark") };
  const m = mockClient({ targetSats: "33165", quote: { ...FQ, source_amount: "33400000", target_amount: "33330", net_target_amount: "33000" } }); const { c } = await ctx({ client: m.client, dealOf: (c) => deal(c, { amountSats: 33000, fees }) });
  const r = await es.fundStable(c, "e1", { from: "usdc" });
  assert.equal(r.swapPaysSats, 33165); assert.equal(r.fees.escrow.platformFeeSats, 332, "1% of 33,165 (not 0 for exactly 33,000)");
});
test("fund --from wait without a way to show instructions (MCP): returns the deposit instructions instead of waiting blind", async () => {
  const m = mockClient(); const { c } = await ctx({ client: m.client });
  const t = Date.now(); const r = await es.fundStable(c, "e1", { from: "usdc", wait: true, timeoutSec: 30, pollMs: 5 });
  assert.ok(Date.now() - t < 5000); assert.equal(r.newSwap, true); assert.equal(r.deposit.address, DEP); assert.match(r.next, /--from usdc --wait/); assert.doesNotMatch(r.next, /^Waiting/);
});
test("fund --from --wait: a deal funded by another payment while the swap is still pending is not reported as this swap's funding", async () => {
  const m = mockClient({ statuses: ["pending"] }); const made = () => m.calls.createSwap.length > 0; let posted = 0;
  const { c } = await ctx({ client: m.client, dealOf: (c) => deal(c, made() ? { state: "funded", funding: { outpoint: "cd:0", amount: 5000 } } : {}),
    routes: { "POST /escrows/e1/funding-ark": async () => { posted++; return [200, { recorded: true }]; } } });
  const r = await es.fundStable(c, "e1", { from: "usdc", wait: true, timeoutSec: 0.05, pollMs: 5, onInstructions: () => {} });
  assert.equal(r.funded, true); assert.equal(r.fundedBySwap, false); assert.equal(posted, 0, "no funding report"); assert.equal(r.ledger, undefined);
  assert.match(r.note, /not \(yet\) by this swap/); assert.match(r.note, /swap recover rv-1/); assert.equal(m.calls.claimArkade.length, 0);
});
test("fund --from --wait: a failed claim points to escrow fund --wait (guarded), and the generic swap claim / fund --wait refuse an escrow funding swap", async () => {
  const sw = await import("../dist/src/core/swap.js");
  const m = mockClient({ statuses: ["serverfunded"] }); m.client.claimArkade = async () => ({ success: false, message: "boom" });
  const { c } = await ctx({ client: m.client });
  const r = await es.fundStable(c, "e1", { from: "usdc", wait: true, timeoutSec: 5, pollMs: 1, onInstructions: () => {} });
  assert.equal(r.swap.claimFailed, true); assert.match(r.swap.note, /escrow fund e1 --from usdc --wait/); assert.doesNotMatch(r.swap.note, /swap claim rv-1/);
  await assert.rejects(sw.swapClaim(c, "rv-1"), (e) => e.code === "USAGE" && /funds escrow e1/.test(e.message));
  await assert.rejects(sw.swapFund(c, "rv-1", { wait: true }), (e) => e.code === "USAGE" && /escrow fund e1 --from usdc --wait/.test(e.message));
});
test("fund --from: an expired unfunded swap in another token does not block a new token", async () => {
  const m = mockClient({ statuses: ["expired"], noFundTx: true }); const { c } = await ctx({ client: m.client });
  await es.fundStable(c, "e1", { from: "usdc" }); assert.equal(m.calls.createSwap.length, 1);
  const r = await es.fundStable(c, "e1", { from: "usdt0" }); assert.equal(r.newSwap, true); assert.equal(r.swapId, "rv-2"); assert.equal(c.index.get("e1").fundStableFrom, "usdt0");
});
test("approve --payout-stable: a refused propose leaves the recorded payout swap alone; claim-payout / refund-payout use the SUBMITTED proposal's swap", async () => {
  const m = mockClient({ payStatus: "serverfunded" }); let c0;
  const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c), routes: { "POST /escrows/e1/proposals": async () => [409, { error: "nope", code: "AMOUNT_MISMATCH" }] } }); c0 = c;
  c.index.set("e1", { payoutSwap: "po-1", payoutStable: "usdc", payoutAddress: ME, payoutProposal: "p0" });
  assert.equal(await code(uc.approve(c, "e1", { payoutStable: "usdt0", payoutAddress: ME })), "AMOUNT_MISMATCH");
  assert.equal(c.index.get("e1").payoutSwap, "po-1", "the unused new swap is not recorded"); assert.equal(c.index.get("e1").payoutStable, "usdc");
  // index points at a later swap; the submitted proposal p0 carries po-1: that is the one claimed / refunded
  const m2 = mockClient({ payStatus: "serverfunded" }); await m2.client.createSwap({ source: { chain: "Arkade", tokenId: "btc" }, target: { chain: "42161", tokenId: "x" }, sourceAmount: 5000, targetAddress: ME });
  const { c: c2 } = await ctx({ client: m2.client, dealOf: (c) => funded(c, { state: "released", proposals: [{ id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: ["buyer", "seller"], submittedTxid: "ab".repeat(32) }] }),
    routes: { "GET /escrows/e1/proposals/p0": async () => [200, { id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: [], payout: { type: "stable", swapId: "po-1", address: ME, token: "usdc" }, arkTx: psbtPaying(VHTLC, 5000), checkpoints: [] }] } });
  c2.index.set("e1", { payoutSwap: "po-9", payoutStable: "usdt0", payoutAddress: ME });
  const r = await es.claimPayout(c2, "e1", { pollMs: 1 }); assert.equal(r.payoutSwap, "po-1"); assert.equal(m2.calls.claim[0], "po-1"); assert.equal(r.payoutStable, "usdc");
  const back = await uc.refundPayout(c2, "e1", payoutArk(9, "ark")); assert.equal(back.swapId, "po-1"); assert.equal(m2.calls.refund[0].id, "po-1");
});
test("fund --from: under the lock, a swap another process just created is reused only for the same token and rail", async () => {
  const m = mockClient(); const { c } = await ctx({ client: m.client });
  // another process created a USDC swap after this one read the index: a USDT0 request must not continue it
  const realGet = c.index.get.bind(c.index); let first = true;
  c.index.get = (id) => { const v = realGet(id); if (first) { first = false; return v; } return { ...v, fundStableSwap: "rv-x", fundStableFrom: "usdc", fundRail: "stable" }; };
  await assert.rejects(es.fundStable(c, "e1", { from: "usdt0" }), (e) => e.code === "FUNDING_IN_PROGRESS" && /--from usdc/.test(e.message));
  // ... and a switch to Ark in the meantime refuses instead of reusing
  first = true; c.index.get = (id) => { const v = realGet(id); if (first) { first = false; return v; } return { ...v, fundStableSwap: "rv-x", fundStableFrom: "usdc", fundRail: "ark", fundArkAt: "now" }; };
  await assert.rejects(es.fundStable(c, "e1", { from: "usdc" }), (e) => e.code === "FUNDING_IN_PROGRESS" && /direct Ark/.test(e.message));
  assert.equal(m.calls.createSwap.length, 0);
});
test("refund-payout without a local payout record: refunds the submitted proposal's swap", async () => {
  const m = mockClient({ payStatus: "expired" }); await m.client.createSwap({ source: { chain: "Arkade", tokenId: "btc" }, target: { chain: "42161", tokenId: "x" }, sourceAmount: 5000, targetAddress: ME });
  const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c, { state: "released", proposals: [{ id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: ["buyer", "seller"], submittedTxid: "ab".repeat(32) }] }),
    routes: { "GET /escrows/e1/proposals/p0": async () => [200, { id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: [], payout: { type: "stable", swapId: "po-1", address: ME, token: "usdc" }, arkTx: psbtPaying(VHTLC, 5000), checkpoints: [] }] } });
  const r = await uc.refundPayout(c, "e1", payoutArk(9, "ark")); assert.equal(r.swapId, "po-1"); assert.equal(m.calls.refund[0].id, "po-1");
  const { c: c2 } = await ctx({ dealOf: (c) => funded(c) }); assert.equal(await code(uc.refundPayout(c2, "e1", payoutArk(9, "ark"))), "NOT_FOUND");
});

// ---------- review fixes (Kimi round 3) ----------
test("approve --payout-stable: a server that returns a different proposal (other swap / EVM address / dest) gets no signature", async () => {
  for (const sub of [{ payout: { type: "stable", swapId: "po-evil", address: ME, token: "usdc" } }, { payout: { type: "stable", swapId: "po-1", address: "0x" + "ee".repeat(20), token: "usdc" } }, { dest: payoutArk(4, "ark") }, { kind: "refund" }]) {
    const m = mockClient(); const st = {}; let c0;
    const routes = payoutRoutes(st); const get = routes["GET /escrows/e1/proposals/p1"];
    routes["GET /escrows/e1/proposals/p1"] = async () => { const [code_, body] = await get(); return [code_, { ...body, ...sub }]; };
    const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c), routes }); c0 = c; st.escrow = () => funded(c0);
    await assert.rejects(uc.approve(c, "e1", { payoutStable: "usdc", payoutAddress: ME }), (e) => e.code === "UNSAFE_TX" && /not the stablecoin payout just proposed/.test(e.message), JSON.stringify(sub));
    assert.equal(st.signed, undefined, "nothing signed");
  }
});
test("fund --from: resuming a stable swap after another rail records the stable rail, so fund --ark / fund then refuse", async () => {
  const m = mockClient(); const { c } = await ctx({ client: m.client });
  await es.fundStable(c, "e1", { from: "usdc" });
  c.index.set("e1", { fundRail: "lightning", fundSwap: "ln-1" }); // switched to Lightning; that swap then failed
  c.swaps = async () => { const p = provider(m.client); const g = p.get?.bind(p); p.get = async (id) => id === "ln-1" ? { id, status: "expired" } : g(id); return p; };
  const r = await es.fundStable(c, "e1", { from: "usdc" }); assert.equal(r.swapId, "rv-1");
  assert.equal(c.index.get("e1").fundRail, "stable");
  assert.equal(await code(uc.fundArk(c, "e1")), "FUNDING_IN_PROGRESS"); assert.equal(await code(uc.fund(c, "e1")), "FUNDING_IN_PROGRESS");
});
test("claim-payout / refund-payout: an unreadable submitted proposal is an error, never a guess from the local record", async () => {
  const m = mockClient({ payStatus: "serverfunded" });
  const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c, { state: "released", proposals: [{ id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: ["buyer", "seller"], submittedTxid: "ab".repeat(32) }] }),
    routes: { "GET /escrows/e1/proposals/p0": async () => [500, { error: "down", code: "INTERNAL" }] } });
  c.index.set("e1", { payoutSwap: "po-9", payoutStable: "usdc", payoutAddress: ME });
  assert.equal(await code(es.claimPayout(c, "e1")), "ESCROW_UNREACHABLE"); assert.equal(await code(uc.refundPayout(c, "e1", payoutArk(9, "ark"))), "ESCROW_UNREACHABLE");
  assert.equal(m.calls.claim.length + m.calls.refund.length, 0);
});
test("MCP: wait on approve/refund without payoutStable is a usage error (like the CLI)", async () => {
  const home = tmpHome();
  const t = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/src/cli.js", import.meta.url).pathname, "mcp"], env: { ...process.env, MARK_HOME: home }, stderr: "ignore" });
  const cl = new Client({ name: "t", version: "1" }); await cl.connect(t);
  try {
    for (const [name, args] of [["escrow_approve", { id: "e1", payoutLnaddr: "a@b.c", wait: true }], ["escrow_refund", { id: "e1", payoutArk: "ark1x", wait: true }]]) {
      const r = await cl.callTool({ name, arguments: args }); assert.match(JSON.stringify(r), /only for a stablecoin payout/, name);
    }
  } finally { await cl.close(); }
});
test("claim-payout / refund-payout: a submitted proposal without a payout swap id is an error, not a fallback", async () => {
  for (const payout of [undefined, { type: "stable", address: ME }]) {
    const m = mockClient();
    const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c, { state: "released", proposals: [{ id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: [], submittedTxid: "ab".repeat(32) }] }),
      routes: { "GET /escrows/e1/proposals/p0": async () => [200, { id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: [], ...(payout ? { payout } : {}), arkTx: psbtPaying(VHTLC, 5000), checkpoints: [] }] } });
    c.index.set("e1", { payoutSwap: "po-9", payoutStable: "usdc", payoutAddress: ME });
    assert.equal(await code(es.claimPayout(c, "e1")), "ESCROW_BAD_RESPONSE"); assert.equal(await code(uc.refundPayout(c, "e1", payoutArk(9, "ark"))), "ESCROW_BAD_RESPONSE");
    assert.equal(m.calls.claim.length + m.calls.refund.length, 0);
  }
});
test("refund-payout: a submitted invoice/lnaddr/ark proposal without a swap id never falls back to the local (later) swap", async () => {
  for (const [payout, want] of [[{ type: "invoice", invoice: "lnbc1x" }, "ESCROW_BAD_RESPONSE"], [{ type: "lnaddr", address: "a@b.c" }, "ESCROW_BAD_RESPONSE"], [{ type: "ark", address: "ark1x" }, "NOT_FOUND"]]) {
    const m = mockClient();
    const { c } = await ctx({ client: m.client, dealOf: (c) => funded(c, { state: "released", proposals: [{ id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: [], submittedTxid: "ab".repeat(32) }] }),
      routes: { "GET /escrows/e1/proposals/p0": async () => [200, { id: "p0", kind: "release", dest: VHTLC, signers: ["buyer", "seller"], sigs: [], payout, arkTx: psbtPaying(VHTLC, 5000), checkpoints: [] }] } });
    c.index.set("e1", { payoutSwap: "po-later" });
    assert.equal(await code(uc.refundPayout(c, "e1", payoutArk(9, "ark"))), want, payout.type);
    assert.equal(m.calls.claim.length + m.calls.refund.length, 0, payout.type);
  }
});
test("fund --from --wait: Satora re-prices the payout at funding: a small drop still above the deal is claimed; below the deal it is NOT claimed", async () => {
  for (const [to, claimed] of [["5010", true], ["4990", false]]) {
    const m = mockClient({ statuses: ["pending", "clientfunded", "serverfunded"], repriceTo: to }); let funded = false;
    const { c } = await ctx({ client: m.client, dealOf: (c) => deal(c, funded ? { state: "funded", funding: { outpoint: "ab:0", amount: Number(to) } } : {}),
      routes: { "POST /escrows/e1/funding-ark": async () => [200, { escrowId: "e1", recorded: true, rail: "lightning" }] }, balances: [5085300n] });
    const orig = m.client.claimArkade; m.client.claimArkade = async (...a) => { funded = true; return orig(...a); };
    const r = await es.fundStable(c, "e1", { from: "usdc", wait: true, pollMs: 1, timeoutSec: 5, onInstructions: () => {} });
    assert.equal(m.calls.claimArkade.length, claimed ? 1 : 0, to); assert.equal(r.funded, claimed, to);
    if (!claimed) assert.match(r.note, /less than the deal's 5000: NOT claimed/);
  }
});
test("fund --from --wait: a deal that expired before the deposit is locked: the deposit is NOT locked into the swap", async () => {
  const m = mockClient({ statuses: ["pending"] }); const made = () => m.calls.createSwap.length > 0;
  const { c } = await ctx({ client: m.client, dealOf: (c) => deal(c, made() ? { state: "expired" } : {}), balances: [5085300n] });
  const r = await es.fundStable(c, "e1", { from: "usdc", wait: true, timeoutSec: 5, pollMs: 1, onInstructions: () => {} });
  assert.equal(m.calls.fund.length, 0, "nothing locked"); assert.match(r.note, /expired before the swap paid out/); assert.match(r.swap.note, /NOT locked/);
});

test("priceStableDeposit: grosses the deposit up until its net covers the deal, then adds the cushion (1.5% bridged, 0.5% otherwise)", async () => {
  // fake Satora: 1,000 token units per sat gross, 1.2% swap fee taken from the payout; by-target quotes are GROSS (the live quirk)
  const calls = [];
  const s = { quoteReverse: async (q) => { calls.push(q);
    const units = q.sourceUnits !== undefined ? BigInt(q.sourceUnits) : BigInt(q.targetSats) * 1000n;
    const gross = Number(units / 1000n), net = Math.floor(gross * 0.988);
    return { source_amount: String(units), target_amount: String(gross), net_target_amount: String(net), min_amount: 100, max_amount: 1_000_000, bridge_fee: "20000" }; } };
  const r = await es.priceStableDeposit(s, "usdc", 2000, 50);
  assert.equal(calls[0].targetSats, 2000); assert.ok(calls.length >= 2 && calls.length <= 4);
  assert.ok(Number(r.qs.net_target_amount) >= 2000, "the last quote's net covers the deal");
  const src = BigInt(r.qs.source_amount);
  assert.equal(r.sourceUnits, (src * BigInt(10000 + es.FUND_STABLE_CUSHION_BPS) + 9999n) / 10000n);
  const b = await es.priceStableDeposit(s, "usdc-base", 2000, 50);
  assert.equal(b.sourceUnits, (BigInt(b.qs.source_amount) * BigInt(10000 + es.FUND_STABLE_BRIDGED_CUSHION_BPS) + 9999n) / 10000n);
  assert.ok(b.sourceUnits > r.sourceUnits, "bridged cushion is larger");
  // a bridged quote without Circle's fee, or a deal outside Satora's range: refused, nothing created
  const noFee = { quoteReverse: async (q) => ({ ...(await s.quoteReverse(q)), bridge_fee: undefined }) };
  await assert.rejects(es.priceStableDeposit(noFee, "usdc-base", 2000, 50), (e) => e.code === "QUOTE_UNAVAILABLE" && /bridge fee/.test(e.message));
  await assert.rejects(es.priceStableDeposit(s, "usdc", 50, 50), (e) => e.code === "SWAP_AMOUNT");
  // a quote that never reaches the deal stops after three rounds
  const stuck = { quoteReverse: async (q) => ({ source_amount: "5000", target_amount: "5", net_target_amount: "4", min_amount: 1, max_amount: 1_000_000 }) };
  await assert.rejects(es.priceStableDeposit(stuck, "usdc", 2000, 50), (e) => e.code === "QUOTE_UNAVAILABLE" && e.details?.dealSats === 2000);
});
