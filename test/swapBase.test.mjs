// `mark swap --to usdc-base`: BTC (Lightning or Arkade) -> USDC on Base. Satora settles on Arbitrum One and bridges over Circle CCTP
// at claim; the bridge fee is in Satora's quote. The Satora SDK is mocked: no network in these tests.
import test from "node:test";
import assert from "node:assert/strict";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { SWAP_REFERRAL_ID, SWAP_MARKUP_BPS, SWAP_TARGETS, SWAP_STABLES, ARB_USDC, BASE_USDC, BASE_TO_BTC_UNSUPPORTED, formatSwapQuote, swapRoute, allSwapRoutes, checkEvmAddress, targetOfSwap, routeFeeNote, SWAP_FEE_ALL_ROUTES_NOTE } from "../dist/src/swap/stable.js";
import * as sw from "../dist/src/core/swap.js";
import { checkSwapArgs, parseArgs, SWAP_USAGE } from "../dist/src/cliArgs.js";
import { payoutArk } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";

const VHTLC = payoutArk(3, "ark");
const ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // a valid EIP-55 address; only its format matters
/** A real-shaped Satora mainnet quote, Lightning -> USDC on Base, extraFees 50 (25 Nov 2026, scaled to 100,000 sats): the CCTP fee
 *  (bridge_fee, USDC units) is already out of net_target_amount. */
const QB = { exchange_rate: "59224.86", network_fee: 7, gasless_network_fee: 0, protocol_fee: 1000, protocol_fee_rate: 0.01, min_amount: 356, max_amount: 20000000,
  source_amount: "100000", target_amount: "59224860", net_source_amount: "100000", net_target_amount: "58568130", bridge_fee: 59468 };
/** What Satora answers for a bridged create: the Arbitrum settlement token and chain, plus the bridge destination. */
const BRIDGED = { target_token: { chain: "42161", token_id: ARB_USDC, symbol: "USDC", decimals: 6 }, evm_chain_id: 42161, bridge_target_chain: "Base", bridge_target_token_address: BASE_USDC };

function mockClient(o = {}) {
  const calls = { getQuote: [], createSwap: [], claim: [], getSwap: [] };
  let statuses = [...(o.statuses ?? ["pending"])];
  const client = {
    getQuote: async (p) => { calls.getQuote.push(p); return o.quote ?? QB; },
    createSwap: async (p) => { calls.createSwap.push(p); return { response: { id: "sw-b", status: "pending", source_amount: String(p.sourceAmount), target_amount: o.createUnits ?? "58627598", target_evm_address: p.targetAddress,
      source_token: { chain: p.source.chain, token_id: "btc" }, ...BRIDGED,
      ...(p.source.chain === "Lightning" ? { bolt11_invoice: makeInvoice({ sats: p.sourceAmount }) } : { btc_vhtlc_address: VHTLC }), ...(o.tamper ?? {}) } }; },
    getSwap: async (id) => { calls.getSwap.push(id); const s = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { id, status: s, direction: "lightning_to_evm", source_amount: "100000", target_amount: "58627598", target_evm_address: ADDR, ...BRIDGED,
        ...(s === "serverredeemed" ? { evm_claim_txid: "0xarbclaim", ...(o.bridgeTx ? { bridge_target_txid: o.bridgeTx } : {}) } : {}) }; },
    getStoredSwap: async () => ({ swapId: "sw-b" }),
    claim: async (id) => { calls.claim.push(id); return { success: true, txHash: "0xarbclaim" }; },
  };
  return { client, calls };
}
/** received: what the receipt read returns (a bigint: mined; null: reverted). For a bridged claim Mark only uses it to see a revert. */
function provider(client, received = 0n) {
  const p = new SatoraProvider(client, "https://swap.test", "https://ark.test"); const reads = [];
  p.evm = { tokenBalance: async () => 0n, ethBalance: async () => 0n, gasPrice: async () => 1n, transferredTo: async (...a) => { reads.push(a); return received === "unreadable" ? undefined : received; } };
  return Object.assign(p, { reads });
}
const ctxWith = (p) => ({ network: "bitcoin", cfg: { arkServerUrl: "https://arkade.computer" }, swaps: async () => p });

test("usdc-base: USDC on Base (chain 8453, native USDC), bridged from Arbitrum One USDC over Circle CCTP; a payout only", () => {
  const t = SWAP_TARGETS["usdc-base"];
  assert.deepEqual({ chain: t.chain, tokenId: t.tokenId, symbol: t.symbol, network: t.network }, { chain: "8453", tokenId: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", network: "Base" });
  assert.deepEqual(t.bridge, { name: "Base", via: "Circle CCTP", settleChain: "42161", settleToken: ARB_USDC });
  assert.equal(SWAP_TARGETS.usdc.bridge, undefined); assert.equal(SWAP_TARGETS.usdt0.bridge, undefined);
  assert.deepEqual([...SWAP_STABLES], ["usdc", "usdt0"]);
  const r = allSwapRoutes().map((x) => `${x.dir}:${x.from}->${x.to}`);
  assert.ok(r.includes("to_stable:lightning->usdc-base") && r.includes("to_stable:arkade->usdc-base"));
  assert.ok(!r.some((x) => x.startsWith("to_btc:usdc-base")));
  assert.match(routeFeeNote({ dir: "to_stable", from: "lightning", to: "usdc-base" }), /CCTP bridge fee/);
  assert.doesNotMatch(routeFeeNote({ dir: "to_stable", from: "lightning", to: "usdc" }), /bridge/);
  assert.match(SWAP_FEE_ALL_ROUTES_NOTE, /USDC on Base also pays Circle's CCTP bridge fee/);
});

test("usdc-base: getQuote and createSwap ask for USDC on Base with the SAME referral ID and 50 bps; the SDK adds the bridge", async () => {
  const { client, calls } = mockClient(); const p = provider(client);
  await p.quoteStable({ from: "arkade", to: "usdc-base", sats: 5000, bps: SWAP_MARKUP_BPS });
  assert.deepEqual(calls.getQuote[0], { sourceChain: "Arkade", sourceToken: "btc", targetChain: "8453", targetToken: BASE_USDC, sourceAmount: 5000, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
  const r = await p.createStable({ from: "lightning", to: "usdc-base", sats: 100000, bps: SWAP_MARKUP_BPS, address: ADDR });
  assert.deepEqual(calls.createSwap[0], { source: { chain: "Lightning", tokenId: "btc" }, target: { chain: "8453", tokenId: BASE_USDC }, sourceAmount: 100000, targetAddress: ADDR, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
  assert.equal(r.bridgeTargetChain, "Base"); assert.equal(r.bridgeTargetToken, BASE_USDC); assert.equal(r.tokenContract, ARB_USDC); assert.equal(r.evmChainId, 42161);
  await assert.rejects(p.quoteStable({ from: "lightning", to: "usdc-base", sats: 5000, bps: 101 }), (e) => e.code === "BAD_MARKUP");
});

test("usdc-base quote: the CCTP bridge fee is shown in USDC next to every other fee; network named per route", () => {
  const q = formatSwapQuote(QB, { from: "lightning", to: "usdc-base", sats: 100000, bps: SWAP_MARKUP_BPS });
  assert.deepEqual(q.token, { symbol: "USDC", network: "Base", chainId: 8453, contract: BASE_USDC });
  assert.equal(q.fees.agentEscrowMarkupBps, 50); assert.equal(q.fees.agentEscrowMarkupSats, 500); assert.equal(q.fees.satoraFeeSats, 500); assert.equal(q.fees.networkFeeSats, 7); assert.equal(q.fees.totalFeePercent, "1%");
  assert.equal(q.fees.bridgeFee, "0.059468"); assert.equal(q.fees.bridgeFeeUnits, "59468"); assert.equal(q.fees.bridgeFeeToken, "USDC");
  assert.equal(q.markupNote, "Total fee: 1% (Satora 0.5% + Agent Escrow 0.5%) plus 7 sats network fee plus 0.059468 USDC Circle CCTP bridge fee to Base. Paid inside the swap; nothing extra to send.");
  assert.equal(q.receive, "58.56813"); assert.equal(q.bridge.to, "Base"); assert.equal(q.bridge.via, "Circle CCTP"); assert.match(q.bridge.note, /receive is after the bridge fee/);
  // an Arbitrum route has no bridge fields, even if a quote carried one
  const a = formatSwapQuote({ ...QB, bridge_fee: 5 }, { from: "lightning", to: "usdc", sats: 100000, bps: SWAP_MARKUP_BPS });
  assert.equal(a.bridge, undefined); assert.equal(a.fees.bridgeFee, undefined); assert.equal(a.token.network, "Arbitrum One"); assert.doesNotMatch(a.markupNote, /bridge/);
  // a Base quote without a bridge fee says so rather than hiding it
  const n = formatSwapQuote({ ...QB, bridge_fee: undefined }, { from: "lightning", to: "usdc-base", sats: 100000, bps: SWAP_MARKUP_BPS });
  assert.equal(n.fees.bridgeFee, null); assert.match(n.markupNote, /bridge fee to Base \(not in Satora's quote\)/);
});

test("usdc-base preview: notice names USDC on Base and the bridge; nothing is created; quote's next step says Base", async () => {
  const { client, calls } = mockClient(); const c = ctxWith(provider(client));
  const r = await sw.swapRun(c, { from: "lightning", to: "usdc-base", sats: 100000, address: ADDR });
  assert.equal(r.swap, "preview"); assert.equal(calls.createSwap.length, 0);
  assert.match(r.notice, /into about 58\.56813 USDC on Base, sent to 0x/); assert.match(r.notice, /bridged to Base over Circle CCTP/); assert.match(r.notice, /0\.059468 USDC Circle CCTP bridge fee/);
  assert.doesNotMatch(r.notice, /USDC on Arbitrum/);
  const q = await sw.swapQuote(c, { from: "arkade", to: "usdc-base", sats: 5000 });
  assert.match(q.next, /--to usdc-base .*your 0x address on Base/);
  await assert.rejects(sw.swapRun(c, { from: "lightning", to: "usdc-base", sats: 100000, address: "0x123" }), (e) => e.code === "BAD_DEST" && /EVM address on Base/.test(e.message));
});

test("usdc-base: a quote with no bridge fee is refused before anything is created (full fee disclosure)", async () => {
  const { client, calls } = mockClient({ quote: { ...QB, bridge_fee: undefined } });
  await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "lightning", to: "usdc-base", sats: 100000, address: ADDR, confirm: true }), (e) => e.code === "QUOTE_UNAVAILABLE" && /bridge fee/.test(e.message));
  for (const bad of [-1, 1.5, "x", null]) {
    const m = mockClient({ quote: { ...QB, bridge_fee: bad } });
    await assert.rejects(sw.swapRun(ctxWith(provider(m.client)), { from: "lightning", to: "usdc-base", sats: 100000, address: ADDR, confirm: true }), (e) => e.code === "QUOTE_UNAVAILABLE", String(bad));
    assert.equal(m.calls.createSwap.length, 0);
  }
  assert.equal(calls.createSwap.length, 0);
});

test("usdc-base create: Satora's bridged answer is accepted; expectedReceive is never above the quote (after the bridge fee)", async () => {
  const { client } = mockClient(); const c = ctxWith(provider(client));
  const r = await sw.swapRun(c, { from: "lightning", to: "usdc-base", sats: 100000, address: ADDR, confirm: true });
  assert.equal(r.swap, "created"); assert.equal(r.payoutNetwork, "Base"); assert.match(r.invoice, /^lnbc/);
  assert.equal(r.expectedReceive, "58.56813"); // Satora's create says 58.627598 (before the CCTP fee): the quote's net is shown
  const a = await sw.swapRun(ctxWith(provider(mockClient({ createUnits: "58500000" }).client)), { from: "arkade", to: "usdc-base", sats: 100000, address: ADDR, confirm: true });
  assert.equal(a.swap, "created"); assert.equal(a.expectedReceive, "58.5"); assert.equal(a.arkAddress, VHTLC);
});

test("usdc-base create: anything but exactly Arbitrum USDC bridged to USDC on Base is refused (SWAP_FAILED, do not pay)", async () => {
  const cases = [
    [{ bridge_target_chain: undefined, bridge_target_token_address: undefined }, /bridge none/],
    [{ bridge_target_chain: "Optimism" }, /bridge Optimism/],
    [{ bridge_target_token_address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" }, /is not USDC on Base/],
    [{ target_token: { chain: "42161", token_id: SWAP_TARGETS.usdt0.tokenId } }, /token 0xFd08/],
    [{ evm_chain_id: 8453 }, /chain 8453/],
  ];
  for (const [tamper, why] of cases) {
    const { client } = mockClient({ tamper });
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "lightning", to: "usdc-base", sats: 100000, address: ADDR, confirm: true }),
      (e) => e.code === "SWAP_FAILED" && why.test(e.message) && /Do NOT pay/.test(e.message), JSON.stringify(tamper));
  }
});

test("usdc (Arbitrum One) create: a swap that bridges somewhere is refused", async () => {
  const { client } = mockClient({ quote: { ...QB, bridge_fee: undefined }, tamper: {} });
  await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "lightning", to: "usdc", sats: 100000, address: ADDR, confirm: true }),
    (e) => e.code === "SWAP_FAILED" && /bridges to Base, but you asked for USDC on Arbitrum One/.test(e.message));
});

test("usdc-base status / claim: payoutTx is the Arbitrum claim; no Arbitrum transfer read; Base explorer link and delivery tx", async () => {
  const { client } = mockClient({ statuses: ["serverredeemed"], bridgeTx: "0xbasemint" }); const p = provider(client);
  const st = await sw.swapStatus(ctxWith(p), "sw-b");
  assert.equal(st.token, "USDC"); assert.equal(st.payoutNetwork, "Base"); assert.equal(st.received, undefined); assert.equal(st.expectedReceive, undefined);
  assert.equal(st.explorer, "https://arbiscan.io/tx/0xarbclaim");
  assert.deepEqual({ to: st.bridge.to, via: st.bridge.via, deliveryTx: st.bridge.deliveryTx, deliveryExplorer: st.bridge.deliveryExplorer, addr: st.bridge.payoutAddressExplorer },
    { to: "Base", via: "Circle CCTP", deliveryTx: "0xbasemint", deliveryExplorer: "https://basescan.org/tx/0xbasemint", addr: `https://basescan.org/address/${ADDR}` });
  const cl = await sw.swapClaim(ctxWith(p), "sw-b");
  assert.equal(cl.swap, "done"); assert.equal(cl.payoutTx, "0xarbclaim"); assert.equal(cl.received, undefined); assert.equal(cl.payoutFailed, undefined);
  assert.match(cl.note, /bridging to Base over Circle CCTP/); assert.match(cl.bridge.note, /Do NOT pay again/);
  // the raw amount is what leaves Arbitrum One (before Circle's fee): labelled as bridgedAmount, never as what arrives on Base
  assert.equal(st.bridge.bridgedAmount, "58.627598"); assert.equal(cl.bridge.bridgedAmount, "58.627598");
  assert.match(st.bridge.note, /bridgedAmount \(and targetUnits\) is what leaves Arbitrum One: Circle CCTP's bridge fee comes out of it, so a little less arrives on Base/);
  // the claim receipt is read only for a revert (status, then claim): its transfer goes to the bridge, never reported as received
  assert.deepEqual(p.reads, [["0xarbclaim", ARB_USDC, ADDR], ["0xarbclaim", ARB_USDC, ADDR]]); assert.equal(st.received, undefined); assert.equal(st.reverted, undefined);
});
test("usdc-base: a reverted Arbitrum claim is never reported as sent or bridged", async () => {
  const { client } = mockClient({ statuses: ["serverredeemed"] }); const p = provider(client, null);
  const cl = await sw.swapClaim(ctxWith(p), "sw-b");
  assert.equal(cl.reverted, true); assert.equal(cl.payoutFailed, true); assert.equal(cl.bridge, undefined); assert.doesNotMatch(cl.note, /bridging to Base/); assert.match(cl.note, /reverted on Arbitrum One/);
  const st = await sw.swapStatus(ctxWith(p), "sw-b");
  assert.equal(st.reverted, true); assert.equal(st.payoutFailed, true); assert.equal(st.bridge, undefined); assert.match(st.receivedNote, /reverted on Arbitrum One/);
});

test("usdc-base: an unreadable claim receipt is reported as unknown, never as a confirmed send; a claim with no tx id keeps the Base guidance", async () => {
  const { client } = mockClient({ statuses: ["serverredeemed"] }); const p = provider(client, "unreadable");
  const cl = await sw.swapClaim(ctxWith(p), "sw-b");
  assert.equal(cl.reverted, undefined); assert.match(cl.receivedNote, /could not be read yet/); assert.match(cl.note, /receipt could not be read yet/); assert.equal(cl.bridge.to, "Base");
  const m = mockClient({ statuses: ["serverfunded", "serverfunded"] }); m.client.claim = async () => ({ success: true });
  const r = await sw.swapClaim(ctxWith(provider(m.client)), "sw-b");
  assert.equal(r.payoutTx, undefined); assert.equal(r.bridge.to, "Base"); assert.match(r.note, /payout tx id is not known yet/);
});
test("usdc-base waits for the claim like any stablecoin payout (wait=true claims once funded)", async () => {
  const { client, calls } = mockClient({ statuses: ["serverfunded", "serverfunded", "serverredeemed"] }); const p = provider(client);
  const r = await sw.swapClaim(ctxWith(p), "sw-b", { wait: true, pollMs: 1 });
  assert.equal(calls.claim.length, 1); assert.equal(r.swap, "done"); assert.equal(r.bridge.to, "Base");
});

test("targetOfSwap: a bridged swap maps to its bridge target only when chain, destination token and settlement token all match", () => {
  assert.equal(targetOfSwap({ tokenContract: ARB_USDC, bridgeTargetChain: "Base", bridgeTargetToken: BASE_USDC }), SWAP_TARGETS["usdc-base"]);
  assert.equal(targetOfSwap({ tokenContract: ARB_USDC }), SWAP_TARGETS.usdc);
  assert.equal(targetOfSwap({ tokenContract: BASE_USDC }), undefined);
  assert.equal(targetOfSwap({ tokenContract: SWAP_TARGETS.usdt0.tokenId, bridgeTargetChain: "Base", bridgeTargetToken: BASE_USDC }), undefined);
  assert.equal(targetOfSwap({ tokenContract: ARB_USDC, bridgeTargetChain: "Solana", bridgeTargetToken: BASE_USDC }), undefined);
});

test("USDC on Base -> BTC is refused everywhere (not gasless on Base), with the same message", async () => {
  assert.throws(() => swapRoute("usdc-base", "lightning"), (e) => e.code === "USAGE" && e.message === BASE_TO_BTC_UNSUPPORTED);
  assert.throws(() => swapRoute("usdc-base", undefined), (e) => e.code === "USAGE" && /not supported yet/.test(e.message));
  const chk = (argv) => { const { pos, f } = parseArgs(argv); return checkSwapArgs(pos[1], pos[2], f); };
  assert.match(chk(["swap", "quote", "--from", "usdc-base", "--to", "lightning", "--amount", "2"]).message, /USDC on Base -> BTC is not supported yet/);
  const { client, calls } = mockClient();
  await assert.rejects(sw.swapQuote(ctxWith(provider(client)), { from: "usdc-base", to: "lightning", amount: "2" }), (e) => e.code === "USAGE");
  assert.equal(calls.getQuote.length, 0);
});

test("CLI: --to usdc-base is a valid payout; usage and errors describe each network", () => {
  const chk = (argv) => { const { pos, f } = parseArgs(argv); return checkSwapArgs(pos[1], pos[2], f); };
  assert.equal(chk(["swap", "quote", "--to", "usdc-base", "--sats", "5000"]), null);
  assert.equal(chk(["swap", "--from", "arkade", "--to", "usdc-base", "--sats", "5000", "--address", ADDR, "--yes", "--wait"]), null);
  assert.match(chk(["swap", "--to", "usdc-base", "--sats", "5000"]).message, /--address <your 0x address on Base> is required/);
  assert.match(chk(["swap", "--to", "usdc", "--sats", "5000"]).message, /--address <your 0x address on Arbitrum One> is required/);
  assert.match(SWAP_USAGE.create, /usdc-base pays USDC on Base/); assert.match(SWAP_USAGE.quote, /--to usdc\|usdt0\|usdc-base/);
  assert.throws(() => checkEvmAddress("0x1", "--address", "Base"), (e) => e.code === "BAD_DEST" && /EVM address on Base/.test(e.message));
  assert.throws(() => checkEvmAddress("0x1"), (e) => /EVM address on Arbitrum One/.test(e.message));
});
