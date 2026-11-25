// `mark swap` (BTC -> USDC / USDT0 on Arbitrum via Satora): fee math, markup cap, and the referral ID + extraFees on BOTH getQuote and
// createSwap. The Satora SDK is mocked: no network in these tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { SWAP_REFERRAL_ID, SWAP_MARKUP_BPS, SWAP_MARKUP_CAP_BPS, SWAP_FEE_TOTAL_NOTE, SWAP_TARGETS, SWAP_SOURCES, checkMarkupBps, splitSwapFees, formatSwapQuote, checkEvmAddress, units, pct, ratePct, swapFeeSummaryNote } from "../dist/src/swap/stable.js";
import * as sw from "../dist/src/core/swap.js";
import { checkSwapArgs, parseArgs, helpFor, SWAP_USAGE } from "../dist/src/cliArgs.js";
import { openCtx } from "../dist/src/core/context.js";
import { tmpHome, payoutArk } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const VHTLC = payoutArk(3, "ark"); // a mainnet Ark address (the swap's VHTLC in these mocks)
const ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // a valid EIP-55 address (USDC's contract; only its format matters here)
/** Shape of a real Satora mainnet quote for 100,000 sats Lightning -> USDC with extraFees 50 (23 Nov 2026). */
const Q = { exchange_rate: "61292.781", network_fee: 7, gasless_network_fee: 0, protocol_fee: 1000, protocol_fee_rate: 0.01, min_amount: 356, max_amount: 20000000,
  source_amount: "100000", target_amount: "61292781", net_source_amount: "100000", net_target_amount: "60675562" };

/** Mocked Satora client recording every call. */
function mockClient(o = {}) {
  const calls = { getQuote: [], createSwap: [], claim: [], getSwap: [] };
  let statuses = [...(o.statuses ?? ["pending"])];
  const client = {
    getQuote: async (p) => { calls.getQuote.push(p); return o.quote ?? Q; },
    createSwap: async (p) => { calls.createSwap.push(p); return { response: { id: "sw-1", status: "pending", source_amount: String(p.sourceAmount), target_amount: "60675562", target_evm_address: p.targetAddress,
      source_token: { chain: p.source.chain, token_id: "btc", symbol: "BTC", decimals: 8, name: "Bitcoin" }, target_token: { chain: p.target.chain, token_id: p.target.tokenId, symbol: "X", decimals: 6, name: "X" }, evm_chain_id: Number(p.target.chain),
      ...(p.source.chain === "Lightning" ? { bolt11_invoice: makeInvoice({ sats: p.sourceAmount }) } : { btc_vhtlc_address: VHTLC }), ...(o.tamper ?? {}) } }; },
    getSwap: async (id) => { calls.getSwap.push(id); const s = statuses.length > 1 ? statuses.shift() : statuses[0]; return { id, status: s, direction: o.direction ?? "lightning_to_evm", arkade_server_pk: "5a".repeat(32), source_amount: "100000", target_amount: "60675562",
      target_evm_address: ADDR, target_token: { token_id: SWAP_TARGETS.usdc.tokenId, symbol: "USDC" }, evm_chain_id: 42161, ...(s === "serverredeemed" ? { evm_claim_txid: "0xpayout" } : {}) }; },
    getStoredSwap: async () => ({ swapId: "sw-1" }),
    claim: async (id) => { calls.claim.push(id); return o.claim ?? { success: true, txHash: "0xpayout", message: "ok" }; },
    refundSwap: async (id, opts) => { calls.refund = [...(calls.refund ?? []), { id, ...opts }]; return o.refund ?? { success: true, txId: "arkrefund1" }; },
  };
  return { client, calls };
}
/** The payout tx moved `received` units (default: exactly the expected 60.675562 USDC) to the payout address; no RPC in tests. */
const provider = (client, received = 60675562n) => { const p = new SatoraProvider(client, "https://swap.test", "https://ark.test");
  p.evm = { tokenBalance: async () => 0n, ethBalance: async () => 0n, gasPrice: async () => 1n, transferredTo: async () => received }; return p; };
const ctxWith = (p, network = "bitcoin") => ({ network, cfg: { arkServerUrl: "https://arkade.computer" }, swaps: async () => p });

// ---------- constants and cap ----------
test("markup: one constant, 50 bps (0.5%), within the 100 bps hard cap; referral ID is the public lnds_ id", () => {
  assert.equal(SWAP_MARKUP_BPS, 50); assert.equal(SWAP_MARKUP_CAP_BPS, 100); assert.equal(pct(SWAP_MARKUP_BPS), "0.5%");
  assert.equal(SWAP_REFERRAL_ID, "lnds_29617a89f8a6b5a7");
});
test("markup cap: 0..100 whole bps accepted, anything else refused with BAD_MARKUP", () => {
  for (const ok of [0, 1, 50, 100]) assert.equal(checkMarkupBps(ok), ok);
  for (const bad of [101, 150, 1000, -1, 0.5, 49.9, NaN, Infinity]) assert.throws(() => checkMarkupBps(bad), (e) => e.code === "BAD_MARKUP", String(bad));
  assert.equal(checkMarkupBps(), SWAP_MARKUP_BPS);
});
test("over-cap markup is refused before anything reaches Satora (quote and create)", async () => {
  const { client, calls } = mockClient(); const p = provider(client);
  await assert.rejects(p.quoteStable({ from: "lightning", to: "usdc", sats: 100000, bps: 101 }), (e) => e.code === "BAD_MARKUP");
  await assert.rejects(p.createStable({ from: "lightning", to: "usdc", sats: 100000, bps: 101, address: ADDR }), (e) => e.code === "BAD_MARKUP");
  assert.equal(calls.getQuote.length + calls.createSwap.length, 0);
});

// ---------- fee math ----------
test("fee math: Satora's protocol fee splits into Satora's fee + our 50 bps markup; total adds the network fee", () => {
  const f = splitSwapFees(Q, 100000, 50);
  assert.deepEqual(f, { satoraFeeSats: 500, satoraFeeRate: 0.005, satoraFeePercent: "0.5%", agentEscrowMarkup: "0.5%", agentEscrowMarkupBps: 50, totalFeeRate: 0.01, totalFeePercent: "1%", markupSats: 500, markupBps: 50, networkFeeSats: 7, totalFeeSats: 1007 });
  // odd amount: markup rounds to the nearest sat, Satora gets the rest of its single protocol fee
  const g = splitSwapFees({ ...Q, protocol_fee: 123, protocol_fee_rate: 0.0075, network_fee: 5, gasless_network_fee: 2 }, 12345, 50);
  assert.equal(g.markupSats, 62); assert.equal(g.satoraFeeSats, 61); assert.equal(g.networkFeeSats, 7); assert.equal(g.totalFeeSats, 130);
  assert.equal(g.satoraFeeRate, 0.0025); assert.equal(g.totalFeeRate, 0.0075); assert.equal(g.totalFeePercent, "0.75%");
  assert.throws(() => splitSwapFees(Q, 100000, 101), (e) => e.code === "BAD_MARKUP");
});
test("quote output names the Agent Escrow markup openly, in sats, bps and percent", () => {
  const q = formatSwapQuote(Q, { from: "lightning", to: "usdc", sats: 100000, bps: SWAP_MARKUP_BPS });
  assert.equal(q.fees.agentEscrowMarkup, "0.5%"); assert.equal(q.fees.agentEscrowMarkupBps, 50); assert.equal(q.fees.agentEscrowMarkupSats, 500);
  assert.equal(q.fees.satoraFeeSats, 500); assert.equal(q.fees.satoraFeeRate, 0.005); assert.equal(q.fees.satoraFeePercent, "0.5%");
  assert.equal(q.fees.networkFeeSats, 7); assert.equal(q.fees.totalFeeSats, 1007);
  assert.equal(q.fees.totalFeeRate, 0.01); assert.equal(q.fees.totalFeePercent, "1%");
  assert.equal(q.markupNote, "Total fee: 1% (Satora 0.5% + Agent Escrow 0.5%) plus 7 sats network fee. Paid inside the swap; nothing extra to send.");
  assert.equal(q.receive, "60.675562"); assert.equal(q.payAmountSats, 100000); assert.equal(q.token.symbol, "USDC"); assert.equal(q.token.chainId, 42161);
  assert.match(q.rate, /61292\.781 USDC per BTC/); assert.equal(q.referral, SWAP_REFERRAL_ID);
});
test("quote total fee rate comes from the live quote, never a hard-coded 1%", () => {
  const q = formatSwapQuote({ ...Q, protocol_fee: 980, protocol_fee_rate: 0.0098, network_fee: 13 }, { from: "lightning", to: "usdc", sats: 100000, bps: SWAP_MARKUP_BPS });
  assert.equal(q.fees.satoraFeeRate, 0.0048); assert.equal(q.fees.satoraFeePercent, "0.48%");
  assert.equal(q.fees.agentEscrowMarkup, "0.5%"); assert.equal(q.fees.totalFeeRate, 0.0098); assert.equal(q.fees.totalFeePercent, "0.98%");
  assert.equal(q.fees.satoraFeeSats, 480); assert.equal(q.fees.agentEscrowMarkupSats, 500); assert.equal(q.fees.networkFeeSats, 13); assert.equal(q.fees.totalFeeSats, 993);
  assert.equal(q.markupNote, "Total fee: 0.98% (Satora 0.48% + Agent Escrow 0.5%) plus 13 sats network fee. Paid inside the swap; nothing extra to send.");
  assert.equal(ratePct(0.01), "1%"); assert.equal(ratePct(0.005), "0.5%"); assert.equal(SWAP_FEE_TOTAL_NOTE, "about 1% total (Satora ~0.5% + Agent Escrow 0.5%) plus network fee");
  assert.match(swapFeeSummaryNote(), /about 1% total \(Satora ~0\.5% \+ Agent Escrow 0\.5%\) plus network fee/);
  assert.equal(swapFeeSummaryNote({ satoraFeeRate: 0.005, totalFeeRate: 0.01, markupBps: 50 }), "Every swap costs 1% total (Satora 0.5% + Agent Escrow 0.5%) plus network fee, plus Circle's CCTP fee for USDC on Base. Paid inside the swap; nothing extra to send, except a little ETH on Base at the deposit address for a swap from USDC on Base.");
  // a quote whose combined rate is below our markup: do not invent a higher total, and never print NaN
  const low = formatSwapQuote({ ...Q, protocol_fee: 30, protocol_fee_rate: 0.003 }, { from: "lightning", to: "usdc", sats: 100000, bps: SWAP_MARKUP_BPS });
  assert.equal(low.fees.satoraFeeRate, 0); assert.equal(low.fees.totalFeeRate, 0.003); assert.equal(low.fees.totalFeePercent, "0.3%");
  assert.match(low.markupNote, /Total fee: 0\.3% \(Satora 0% \+ Agent Escrow 0\.5%\)/);
  for (const bad of [NaN, Infinity, -0.01]) {
    const q = formatSwapQuote({ ...Q, protocol_fee_rate: bad }, { from: "lightning", to: "usdc", sats: 100000, bps: SWAP_MARKUP_BPS });
    assert.equal(q.fees.totalFeeRate, 0); assert.equal(q.fees.satoraFeeRate, 0); assert.equal(q.fees.totalFeePercent, "0%");
    assert.doesNotMatch(q.markupNote, /NaN|Infinity/);
  }
});
test("units: 6-decimal token amounts", () => {
  assert.equal(units("60675562", 6), "60.675562"); assert.equal(units("1000000", 6), "1"); assert.equal(units("5", 6), "0.000005"); assert.equal(units(undefined, 6), undefined);
});

// ---------- referral ID + extraFees on BOTH Satora calls ----------
test("satora: getQuote carries referralCode and extraFees (bps) and the right assets", async () => {
  const { client, calls } = mockClient(); await provider(client).quoteStable({ from: "arkade", to: "usdt0", sats: 50000, bps: SWAP_MARKUP_BPS });
  assert.deepEqual(calls.getQuote[0], { sourceChain: "Arkade", sourceToken: "btc", targetChain: "42161", targetToken: SWAP_TARGETS.usdt0.tokenId, sourceAmount: 50000, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
});
test("satora: createSwap carries the SAME referralCode and extraFees as getQuote", async () => {
  const { client, calls } = mockClient(); const p = provider(client);
  const r = await p.createStable({ from: "lightning", to: "usdc", sats: 100000, bps: SWAP_MARKUP_BPS, address: ADDR });
  assert.deepEqual(calls.createSwap[0], { source: { chain: "Lightning", tokenId: "btc" }, target: { chain: SWAP_TARGETS.usdc.chain, tokenId: SWAP_TARGETS.usdc.tokenId }, sourceAmount: 100000, targetAddress: ADDR, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
  assert.equal(r.id, "sw-1"); assert.match(r.invoice, /^lnbc1000000n/);
});
test("mark swap (create): getQuote and createSwap both get referral ID + 50 bps, identical values", async () => {
  const { client, calls } = mockClient(); const c = ctxWith(provider(client));
  const r = await sw.swapRun(c, { from: "lightning", to: "usdc", sats: 100000, address: ADDR, confirm: true });
  assert.equal(r.swap, "created"); assert.match(r.invoice, /^lnbc/); assert.equal(r.quote.fees.agentEscrowMarkup, "0.5%");
  assert.equal(calls.getQuote.length, 1); assert.equal(calls.createSwap.length, 1);
  for (const call of [calls.getQuote[0], calls.createSwap[0]]) { assert.equal(call.referralCode, SWAP_REFERRAL_ID); assert.equal(call.extraFees, SWAP_MARKUP_BPS); }
  assert.match(r.next, /swap claim sw-1 --wait/);
});
test("mark swap without --yes is a preview: quote only, no swap created", async () => {
  const { client, calls } = mockClient(); const r = await sw.swapRun(ctxWith(provider(client)), { sats: 100000, address: ADDR });
  assert.equal(r.swap, "preview"); assert.equal(calls.createSwap.length, 0); assert.equal(calls.getQuote[0].referralCode, SWAP_REFERRAL_ID); assert.equal(calls.getQuote[0].extraFees, 50);
  assert.match(r.notice, /REAL MONEY/); assert.match(r.notice, /Total fee: 1% \(Satora 0\.5% \+ Agent Escrow 0\.5%\) plus 7 sats network fee/);
});
test("mark swap quote: referral ID + extraFees sent; out-of-range amounts flagged; create refuses them", async () => {
  const { client, calls } = mockClient(); const c = ctxWith(provider(client));
  const r = await sw.swapQuote(c, { sats: "100000" }); assert.equal(r.quote.fees.agentEscrowMarkupSats, 500); assert.equal(r.note, undefined);
  assert.equal(calls.getQuote[0].referralCode, SWAP_REFERRAL_ID); assert.equal(calls.getQuote[0].extraFees, 50);
  assert.match((await sw.swapQuote(c, { sats: 100 })).note, /out of range/);
  await assert.rejects(sw.swapRun(c, { sats: 100, address: ADDR, confirm: true }), (e) => e.code === "SWAP_AMOUNT"); assert.equal(calls.createSwap.length, 0);
});
test("a quote without a payout amount stops before anything is created", async () => {
  for (const net_target_amount of [undefined, "", "0", "x"]) {
    const { client, calls } = mockClient({ quote: { ...Q, net_target_amount }, tamper: { target_amount: "1" } });
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { sats: 100000, address: ADDR, confirm: true }), (e) => e.code === "QUOTE_UNAVAILABLE", String(net_target_amount));
    assert.equal(calls.createSwap.length, 0);
  }
});
test("mark swap --wait: shows the invoice first, claims when serverfunded, returns the payout tx", async () => {
  const { client, calls } = mockClient({ statuses: ["pending", "clientfunded", "serverfunded", "serverredeemed"] }); const seen = [];
  const r = await sw.swapRun(ctxWith(provider(client)), { sats: 100000, address: ADDR, confirm: true, wait: true, pollMs: 1, onProgress: (x) => seen.push(x) });
  assert.match(seen[0].invoice, /^lnbc1000000n/); assert.equal(r.swap, "done"); assert.equal(r.payoutTx, "0xpayout"); assert.equal(r.explorer, "https://arbiscan.io/tx/0xpayout");
  assert.deepEqual(calls.claim, ["sw-1"]);
  assert.equal(r.status, "serverredeemed", "final status after the claim, not the claim-time serverfunded");
});

// ---------- after a claim: the final status, not the claim-time one ----------
test("after a claim, the output re-reads the swap: final status (serverredeemed) for create --wait, claim --wait and claim", async () => {
  // claim without wait: claim-time serverfunded, a re-read still in progress, then redeemed
  let m = mockClient({ statuses: ["serverfunded", "serverfunded", "serverredeemed"] });
  let r = await sw.swapClaim(ctxWith(provider(m.client)), "sw-1", { pollMs: 1 });
  assert.deepEqual({ status: r.status, swap: r.swap, payoutTx: r.payoutTx, note: r.note }, { status: "serverredeemed", swap: "done", payoutTx: "0xpayout", note: "Stablecoins sent to your address." });
  assert.deepEqual(m.calls.claim, ["sw-1"], "re-reading never claims again");
  // claim --wait (also MCP swap_claim with wait)
  m = mockClient({ statuses: ["clientfunded", "serverfunded", "serverredeemed"] });
  r = await sw.swapClaim(ctxWith(provider(m.client)), "sw-1", { wait: true, pollMs: 1 });
  assert.equal(r.status, "serverredeemed"); assert.equal(r.payoutTx, "0xpayout"); assert.deepEqual(m.calls.claim, ["sw-1"]);
  // same field names as before
  assert.deepEqual(Object.keys(r), ["id", "status", "swap", "payoutTx", "explorer", "received", "receivedUnits", "note"]);
});
test("after a claim, a re-read that stays in progress or fails falls back to the claim-time status without failing", async () => {
  // still serverfunded on every re-read: claim-time status, payout tx from the claim, a bounded number of re-reads
  let m = mockClient({ statuses: ["serverfunded"] });
  let r = await sw.swapClaim(ctxWith(provider(m.client)), "sw-1", { pollMs: 1 });
  assert.deepEqual({ status: r.status, swap: r.swap, payoutTx: r.payoutTx }, { status: "serverfunded", swap: "done", payoutTx: "0xpayout" });
  assert.ok(m.calls.getSwap.length <= 5, `bounded re-reads (${m.calls.getSwap.length})`); assert.deepEqual(m.calls.claim, ["sw-1"]);
  // every re-read throws after the claim (create --wait, also MCP swap_create with wait): no error, claim-time status
  m = mockClient({ statuses: ["pending", "serverfunded"] }); const get = m.client.getSwap;
  m.client.getSwap = async (id) => { if (m.calls.claim.length) throw new Error("satora down"); return get(id); };
  r = await sw.swapRun(ctxWith(provider(m.client)), { sats: 100000, address: ADDR, confirm: true, wait: true, pollMs: 1, onProgress: () => {} });
  assert.deepEqual({ status: r.status, swap: r.swap, payoutTx: r.payoutTx, payoutAddress: r.payoutAddress }, { status: "serverfunded", swap: "done", payoutTx: "0xpayout", payoutAddress: ADDR });
  assert.deepEqual(m.calls.claim, ["sw-1"]);
});
test("claim failure stops at once with the reason and says not to pay again", async () => {
  const { client } = mockClient({ statuses: ["serverfunded"], claim: { success: false, message: "relay down" } });
  const r = await sw.swapClaim(ctxWith(provider(client)), "sw-1");
  assert.equal(r.claimFailed, true); assert.equal(r.claim.message, "relay down"); assert.match(r.note, /Do NOT pay again/);
});
test("swap status: read-only, token amount and explorer link; never claims", async () => {
  const { client, calls } = mockClient({ statuses: ["serverredeemed"] }); const r = await sw.swapStatus(ctxWith(provider(client)), "sw-1");
  assert.equal(r.status, "serverredeemed"); assert.equal(r.expectedReceive, "60.675562"); assert.equal(r.received, "60.675562"); assert.equal(r.token, "USDC"); assert.equal(r.payoutTx, "0xpayout"); assert.equal(r.raw, undefined);
  assert.equal(r.receive, undefined, "no unlabelled amount");
  assert.equal(calls.claim.length, 0);
});
test("received amount: read from the payout tx, never the create-time estimate (live: 3.03146 expected, 3.022431 arrived)", async () => {
  // Satora swaps the locked BTC token on a DEX at claim: what arrives can be less than target_amount
  let { client } = mockClient({ statuses: ["pending", "serverfunded", "serverredeemed"] }); const seen = [];
  let r = await sw.swapRun(ctxWith(provider(client, 60500000n)), { sats: 100000, address: ADDR, confirm: true, wait: true, pollMs: 1, onProgress: (x) => seen.push(x) });
  assert.equal(seen[0].expectedReceive, "60.675562"); assert.equal(seen[0].receive, undefined); assert.match(seen[0].receiveNote, /estimate/);
  assert.equal(r.received, "60.5"); assert.equal(r.receivedUnits, "60500000");
  ({ client } = mockClient({ statuses: ["serverredeemed"] }));
  r = await sw.swapStatus(ctxWith(provider(client, 60500000n)), "sw-1"); assert.equal(r.received, "60.5"); assert.equal(r.expectedReceive, "60.675562");
  r = await sw.swapClaim(ctxWith(provider(client, 60500000n)), "sw-1"); assert.equal(r.received, "60.5");
  // receipt not readable: no amount is claimed, a note says so
  const p = provider(client); p.evm.transferredTo = async () => undefined;
  r = await sw.swapStatus(ctxWith(p), "sw-1"); assert.equal(r.received, undefined); assert.match(r.receivedNote, /could not be read/);
});
test("mainnet only: mutinynet refuses before any Satora call", async () => {
  const { client, calls } = mockClient();
  await assert.rejects(sw.swapQuote(ctxWith(provider(client), "mutinynet"), { sats: 1000 }), (e) => e.code === "SWAP_UNSUPPORTED_NETWORK");
  assert.equal(calls.getQuote.length, 0);
});
test("standalone: mark swap opens no escrow server connection", async () => {
  tmpHome(); const { client, calls } = mockClient(); let fetched = 0;
  const c = await openCtx("bitcoin", { fetchImpl: async () => { fetched++; throw new Error("no escrow calls"); }, swapFactory: async () => provider(client) });
  await sw.swapQuote(c, { sats: 100000 }); await sw.swapRun(c, { sats: 100000, address: ADDR, confirm: true });
  assert.equal(fetched, 0); assert.equal(calls.createSwap.length, 1);
});

// ---------- input checks ----------
test("EVM address: format and EIP-55 checksum", () => {
  assert.equal(checkEvmAddress(ADDR), ADDR); assert.equal(checkEvmAddress(ADDR.toLowerCase()), ADDR.toLowerCase());
  assert.throws(() => checkEvmAddress(ADDR.replace("cC22", "Cc22")), (e) => e.code === "BAD_DEST" && /checksum/.test(e.message));
  for (const bad of ["", "0x123", "af88d065e77c8cC2239327C5EDb3A432268e5831", "0x" + "0".repeat(40), "bc1qxyz"]) assert.throws(() => checkEvmAddress(bad), (e) => e.code === "BAD_DEST", bad);
});
test("CLI: mark swap usage checks before any key or network access", () => {
  const chk = (argv) => { const { pos, f } = parseArgs(argv); return checkSwapArgs(pos[1], pos[2], f); };
  assert.equal(chk(["swap", "quote", "--sats", "1000"]), null);
  assert.equal(chk(["swap", "quote", "--from", "lightning", "--to", "arkade", "--sats", "1000"]), null);
  assert.equal(chk(["swap", "--from", "lightning", "--to", "arkade", "--sats", "1000", "--address", "ark1xyz"]), null);
  assert.equal(chk(["swap", "quote", "--from", "arkade", "--to", "lightning", "--sats", "900"]), null);
  assert.equal(chk(["swap", "--sats", "1000", "--address", ADDR, "--to", "usdt0", "--from", "arkade", "--yes", "--wait"]), null);
  assert.equal(chk(["swap", "create", "--sats", "1000", "--address", ADDR]), null);
  assert.equal(chk(["swap", "status", "id1"]), null); assert.equal(chk(["swap", "claim", "id1", "--wait"]), null);
  assert.equal(chk(["swap", "refund", "id1", "--to", "ark1xyz"]), null);
  assert.match(chk(["swap", "quote"]).message, /--sats is required/);
  assert.match(chk(["swap", "--sats", "1000"]).message, /--address/);
  assert.match(chk(["swap", "quote", "--sats", "1.5"]).message, /whole number/);
  assert.match(chk(["swap", "quote", "--sats", "1000", "--to", "dai"]).message, /usdc, usdt0, usdc-base/);
  assert.match(chk(["swap", "quote", "--sats", "1000", "--yes"]).message, /--yes is only/);
  assert.match(chk(["swap", "status"]).message, /swap id required/);
  assert.equal(chk(["swap", "refund", "id1"]), null); // a swap from a stablecoin refunds with no --to (an Arkade one is checked after the lookup)
  assert.match(chk(["swap", "frobnicate"]).message, /unknown swap subcommand/);
  assert.deepEqual(helpFor(["swap", "quote"], { help: true }, "x"), { usage: SWAP_USAGE.quote });
  assert.deepEqual(helpFor(["swap"], { help: true }, "x"), { usage: SWAP_USAGE });
});

// ---------- cross-surface consistency ----------
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
test("docs: README, quickstart, skill and help all state the same total fee and markup and list every swap command and flag", () => {
  const README = rd("../README.md"), QS = rd("../docs/AGENT_QUICKSTART.md"), SKILL = rd("../skills/agent-escrow/SKILL.md"), AGENTS = rd("../AGENTS.md");
  const p = pct(SWAP_MARKUP_BPS);
  for (const [n, d] of [["README", README], ["quickstart", QS], ["skill", SKILL], ["AGENTS", AGENTS], ["help quote", SWAP_USAGE.quote], ["help create", SWAP_USAGE.create], ["help routes", SWAP_USAGE.routes]]) {
    assert.ok(d.toLowerCase().includes(SWAP_FEE_TOTAL_NOTE.toLowerCase()), `${n} must state the total fee (${SWAP_FEE_TOTAL_NOTE})`);
    assert.ok(d.includes(`${p} Agent Escrow`) || d.includes(`Agent Escrow ${p}`), `${n} must name the ${p} Agent Escrow markup`);
    for (const other of ["0.25% Agent Escrow", "1% Agent Escrow", "0.75% Agent Escrow"]) assert.ok(!d.includes(other), `${n} has a stale markup: ${other}`);
  }
  for (const sub of ["quote", "status", "claim", "refund"]) assert.ok(README.includes("`mark swap " + sub), `README is missing mark swap ${sub}`);
  for (const u of Object.values(SWAP_USAGE)) for (const [flag] of u.matchAll(/--[a-z][a-z-]*/g)) assert.ok(README.includes(flag), `README is missing ${flag}`);
  assert.ok(README.includes(SWAP_REFERRAL_ID), "README names the public referral ID");
});
test("no API secret: swap code carries only the public referral ID, no keys or auth headers", () => {
  for (const f of ["../src/swap/stable.ts", "../src/core/swap.ts", "../src/swap/satora.ts"]) {
    const src = rd(f);
    assert.doesNotMatch(src, /api[_-]?key|apiSecret|x-api-key|authorization|bearer|withDefaultHeaders/i, f);
  }
});

// ---------- review fixes: never tell a payer to pay twice; check what Satora created before showing it ----------
test("payment seen (clientfundingseen / clientfunded): claim and status say do NOT pay again, and never claim", async () => {
  for (const st of ["clientfundingseen", "clientfunded"]) {
    const { client, calls } = mockClient({ statuses: [st], direction: "arkade_to_evm" }); const c = ctxWith(provider(client));
    const r = await sw.swapClaim(c, "sw-1"); assert.match(r.note, /Do NOT pay again/); assert.doesNotMatch(r.note, /Pay first|Not paid/);
    assert.match((await sw.swapStatus(c, "sw-1")).next, /Do NOT pay again/); assert.equal(calls.claim.length, 0);
  }
});
test("expired: no 'unpaid' claim; Arkade swaps point to the refund, Lightning to the auto-return", async () => {
  const ark = await sw.swapStatus(ctxWith(provider(mockClient({ statuses: ["expired"], direction: "arkade_to_evm" }).client)), "sw-1");
  assert.match(ark.next, /swap refund sw-1 --to/); assert.doesNotMatch(ark.next, /without a payment/);
  const ln = await sw.swapStatus(ctxWith(provider(mockClient({ statuses: ["expired"] }).client)), "sw-1");
  assert.match(ln.next, /returns to your wallet by itself/);
});
test("create: a swap that does not match what was confirmed is refused before anything payable is shown", async () => {
  const other = "0x" + "1".repeat(40);
  for (const [tamper, why, from] of [[{ target_evm_address: other }, /payout address/], [{ source_amount: "100001" }, /amount 100001/], [{ bolt11_invoice: undefined }, /no Lightning invoice/],
    [{ bolt11_invoice: makeInvoice({ sats: 200000 }) }, /invoice asks for 200000/], [{ bolt11_invoice: makeInvoice({ sats: 100000, network: "mutinynet" }) }, /no Lightning invoice for this network/],
    [{ id: undefined }, /no swap id/], [{ source_amount: undefined }, /amount NaN/], [{ target_evm_address: undefined }, /payout address undefined/],
    [{ status: "serverfunded" }, /status serverfunded/], [{ target_token: { chain: "42161", token_id: SWAP_TARGETS.usdt0.tokenId } }, /not USDC/],
    [{ evm_chain_id: 137 }, /chain 137/], [{ target_token: { chain: "137", token_id: SWAP_TARGETS.usdc.tokenId }, evm_chain_id: 42161 }, /token chain 137/],
    [{ source_token: { chain: "Arkade", token_id: "btc" } }, /source Arkade is not Lightning/],
    [{ target_amount: "0" }, /not a positive token amount/], [{ target_amount: "abc" }, /not a positive token amount/], [{ target_amount: undefined }, /not a positive token amount/],
    [{ target_amount: "60000000" }, /more than 1% below the quote \(60\.675562\)/], [{ source_token: undefined }, /source undefined/], [{ btc_vhtlc_address: payoutArk(3, "tark") }, /tark1/, "arkade"], [{ btc_vhtlc_address: undefined }, /no Ark address/, "arkade"]]) {
    const { client } = mockClient({ tamper }); const seen = [];
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: from ?? "lightning", sats: 100000, address: ADDR, confirm: true, wait: true, onProgress: (x) => seen.push(x) }),
      (e) => e.code === "SWAP_FAILED" && why.test(e.message) && /Do NOT pay/.test(e.message), JSON.stringify(tamper));
    assert.equal(seen.length, 0);
  }
  // a payout within 1% of the quote is fine and shown as the actual promised amount
  const near = await sw.swapRun(ctxWith(provider(mockClient({ tamper: { target_amount: "60100000" } }).client)), { sats: 100000, address: ADDR, confirm: true });
  assert.equal(near.expectedReceive, "60.1");
  // address case differences are fine; an Arkade swap shows the Ark address and exact sats
  const ok = await sw.swapRun(ctxWith(provider(mockClient({ tamper: { target_evm_address: ADDR.toLowerCase() } }).client)), { from: "arkade", sats: 100000, address: ADDR, confirm: true });
  assert.equal(ok.arkAddress, VHTLC); assert.equal(ok.amountSats, 100000); assert.match(ok.howToPay, /swap refund sw-1/);
});
test("swap refund: Arkade swaps only, address checked against the swap's Arkade server, result passed through", async () => {
  const mk = (o) => { const m = mockClient({ direction: "arkade_to_evm", statuses: ["expired"], ...o }); return { ...m, c: ctxWith(provider(m.client)) }; };
  const a = mk(); const r = await sw.swapRefund(a.c, "sw-1", payoutArk(4, "ark"));
  assert.deepEqual(r, { id: "sw-1", refunded: true, txid: "arkrefund1" }); assert.equal(a.calls.refund[0].destinationAddress, payoutArk(4, "ark"));
  await assert.rejects(sw.swapRefund(mk({ direction: "lightning_to_evm" }).c, "sw-1", payoutArk(4, "ark")), (e) => e.code === "USAGE" && /expires/.test(e.message));
  await assert.rejects(sw.swapRefund(mk().c, "sw-1", payoutArk(4, "tark")), (e) => e.code === "BAD_DEST");
  const otherServer = mk({}); otherServer.client.getSwap = async (id) => ({ id, status: "expired", direction: "arkade_to_evm", arkade_server_pk: "7c".repeat(32) });
  await assert.rejects(sw.swapRefund(otherServer.c, "sw-1", payoutArk(4, "ark")), (e) => e.code === "BAD_DEST" && /different Ark server/.test(e.message));
  const fail = await sw.swapRefund(mk({ refund: { success: false, message: "timelock not reached" } }).c, "sw-1", payoutArk(4, "ark"));
  assert.equal(fail.refunded, false); assert.equal(fail.message, "timelock not reached");
  await assert.rejects(sw.swapRefund(mk().c, "sw-1", undefined), (e) => e.code === "USAGE");
});
test("concurrent claims of one swap share a single SDK claim", async () => {
  let release; const gate = new Promise((r) => (release = r)); let n = 0;
  const { client } = mockClient({ statuses: ["serverfunded"] }); client.claim = async () => { n++; await gate; return { success: true, txHash: "0xone" }; };
  const p = provider(client); const a = p.claimStable("sw-1"), b = p.claimStable("sw-1"); release();
  const [x, y] = await Promise.all([a, b]); assert.equal(n, 1); assert.equal(x.txHash, "0xone"); assert.equal(y.txHash, "0xone");
  await p.claimStable("sw-1"); assert.equal(n, 2); // a later, separate call claims again (safe to repeat)
});
test("stable claims of different swaps run one at a time (same per-process serialization as the escrow claims)", async () => {
  const order = []; let release; const gate = new Promise((r) => (release = r));
  const { client } = mockClient(); client.claim = async (id) => { order.push("start " + id); if (id === "a") await gate; order.push("end " + id); return { success: true, txHash: "0x" + id }; };
  const p = provider(client); const a = p.claimStable("a"), b = p.claimStable("b");
  await new Promise((r) => setTimeout(r, 20)); assert.deepEqual(order, ["start a"]); release(); await Promise.all([a, b]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});

// ---------- mark swap routes (read-only) ----------
test("swap routes: every route both ways (SWAP_SOURCES x SWAP_TARGETS, then back, then Lightning ↔ Arkade) with Satora's live min/max; quotes only, never creates", async () => {
  const { client, calls } = mockClient(); const q = client.getQuote;
  client.getQuote = async (p) => {
    const x = await q(p);
    if (p.sourceChain === "Lightning" && p.targetChain === "Arkade") return { ...x, protocol_fee_rate: 0.0065, protocol_fee: 646, network_fee: 1, min_amount: 335, max_amount: 1000000, net_target_amount: "99353" };
    if (p.sourceChain === "Arkade" && p.targetChain === "Lightning") return { ...x, protocol_fee_rate: 0.008, protocol_fee: 790, network_fee: 500, min_amount: 335, max_amount: 1000000, net_target_amount: "98710" };
    return { ...x, min_amount: p.sourceChain === "Arkade" || p.targetChain === "Arkade" ? 335 : 356 };
  };
  const r = await sw.swapRoutes(ctxWith(provider(client)));
  const fwd = Object.keys(SWAP_SOURCES).flatMap((f) => Object.keys(SWAP_TARGETS).map((t) => `${f}->${t}`)), back = ["usdc", "usdt0", "usdc-base"].flatMap((f) => Object.keys(SWAP_SOURCES).map((t) => `${f}->${t}`));
  assert.deepEqual(r.routes.map((x) => `${x.from}->${x.to}`), [...fwd, ...back, "lightning->arkade", "arkade->lightning"]);
  assert.equal(r.routes.length, 14);
  for (const x of r.routes.slice(0, 12)) {
    const fw = x.direction === "btc_to_stablecoin"; const t = SWAP_TARGETS[fw ? x.to : x.from]; const rail = fw ? x.from : x.to;
    assert.deepEqual({ rail: fw ? x.source : x.target, token: x.token, chain: x.chain, chainId: x.chainId, contract: x.contract }, { rail: SWAP_SOURCES[rail].chain, token: t.symbol, chain: t.network, chainId: Number(t.chain), contract: t.tokenId });
    assert.deepEqual(x.limits, { minSats: rail === "arkade" ? 335 : 356, maxSats: 20000000 }); assert.equal(x.limitsNote, undefined);
    assert.equal(!!x.bridge, x.to === "usdc-base" || x.from === "usdc-base"); if (x.bridge) { assert.equal(x.chain, "Base"); assert.equal(x.chainId, 8453); assert.equal(x.bridge.via, "Circle CCTP"); }
    if (x.from === "usdc-base") { assert.equal(x.bridge.gas, "ETH on Base"); assert.doesNotMatch(x.bridge.note, /Arbitrum/); }
  }
  const lnArk = r.routes[12], arkLn = r.routes[13];
  assert.deepEqual({ from: lnArk.from, to: lnArk.to, direction: lnArk.direction, source: lnArk.source, target: lnArk.target, limits: lnArk.limits, token: lnArk.token },
    { from: "lightning", to: "arkade", direction: "lightning_to_arkade", source: "Lightning", target: "Arkade", limits: { minSats: 335, maxSats: 1000000 }, token: undefined });
  assert.deepEqual({ from: arkLn.from, to: arkLn.to, direction: arkLn.direction, source: arkLn.source, target: arkLn.target, limits: arkLn.limits },
    { from: "arkade", to: "lightning", direction: "arkade_to_lightning", source: "Arkade", target: "Lightning", limits: { minSats: 335, maxSats: 1000000 } });
  assert.deepEqual(r.routes.map((x) => x.direction), [...Array(6).fill("btc_to_stablecoin"), ...Array(6).fill("stablecoin_to_btc"), "lightning_to_arkade", "arkade_to_lightning"]);
  assert.equal(calls.getQuote.length, 14); assert.equal(calls.createSwap.length, 0); assert.equal(calls.claim.length, 0);
  for (const g of calls.getQuote) { assert.equal(g.referralCode, SWAP_REFERRAL_ID); assert.equal(g.extraFees, SWAP_MARKUP_BPS); }
  // the reverse probes quote a stablecoin source amount on its own chain (Arbitrum One, or Base for usdc-base)
  for (const [k, g] of calls.getQuote.slice(6, 12).entries()) { assert.equal(g.sourceChain, k < 4 ? "42161" : "8453"); assert.equal(g.targetToken, "btc"); assert.equal(String(g.sourceAmount), "10000000"); }
  for (const g of calls.getQuote.slice(12)) { assert.equal(g.sourceToken, "btc"); assert.equal(g.targetToken, "btc"); assert.equal(g.sourceAmount, 100000); }
  const liveFees = { satoraFeeRate: 0.005, satoraFeePercent: "0.5%", agentEscrowMarkup: "0.5%", agentEscrowMarkupBps: 50, totalFeeRate: 0.01, totalFeePercent: "1%" };
  for (const x of r.routes.slice(0, 12)) assert.deepEqual(x.fees, liveFees);
  assert.equal(lnArk.fees.totalFeePercent, "0.65%"); assert.equal(lnArk.fees.satoraFeePercent, "0.15%");
  assert.equal(arkLn.fees.totalFeePercent, "0.8%"); assert.equal(arkLn.fees.satoraFeePercent, "0.3%");
  // rates differ across routes: the summary uses the all-routes note, not a single 1%
  assert.match(r.markup.note, /Fees depend on the route/);
  assert.match(r.markup.note, /about 1% total \(Satora ~0\.5% \+ Agent Escrow 0\.5%\) plus network fee/);
  assert.match(r.markup.note, /about 0\.65% total \(Satora ~0\.15% \+ Agent Escrow 0\.5%\) plus network fee/);
  assert.match(r.markup.note, /about 0\.80% total \(Satora ~0\.30% \+ Agent Escrow 0\.5%\) plus network fee/);
  assert.equal(r.referral, SWAP_REFERRAL_ID);
});
test("swap routes: a failed or incomplete limits lookup still lists every route, limits unavailable, no error", async () => {
  // one route's quote fails, one has no min/max: only those are unavailable
  let { client, calls } = mockClient(); const q = client.getQuote;
  client.getQuote = async (p) => { if (p.targetToken === SWAP_TARGETS.usdt0.tokenId && p.sourceChain === "Arkade") throw new Error("satora down"); const x = await q(p); return p.sourceChain === "Lightning" && p.targetToken === SWAP_TARGETS.usdt0.tokenId ? { ...x, min_amount: undefined } : x; };
  let r = await sw.swapRoutes(ctxWith(provider(client)));
  const by = Object.fromEntries(r.routes.map((x) => [`${x.from}->${x.to}`, x]));
  assert.deepEqual(by["lightning->usdc"].limits, { minSats: 356, maxSats: 20000000 });
  assert.equal(by["arkade->usdt0"].limits, "unavailable"); assert.match(by["arkade->usdt0"].limitsNote, /satora down/);
  assert.equal(by["lightning->usdt0"].limits, "unavailable"); assert.match(by["lightning->usdt0"].limitsNote, /no valid min\/max/);
  // zero, negative or inverted limits are not shown as live
  for (const bad of [{ min_amount: 0 }, { min_amount: -5 }, { min_amount: 500, max_amount: 400 }]) {
    const m = mockClient(); const g = m.client.getQuote; m.client.getQuote = async (p) => ({ ...(await g(p)), ...bad });
    const x = await sw.swapRoutes(ctxWith(provider(m.client))); assert.ok(x.routes.every((y) => y.limits === "unavailable"), JSON.stringify(bad));
  }
  assert.equal(calls.createSwap.length, 0);
  // the provider cannot even be opened: all fourteen listed, all unavailable
  r = await sw.swapRoutes({ network: "bitcoin", cfg: {}, swaps: async () => { throw new Error("no provider"); } });
  assert.equal(r.routes.length, 14); assert.ok(r.routes.every((x) => x.limits === "unavailable" && /no provider/.test(x.limitsNote)));
  // mutinynet: no Satora stablecoin routes, so no lookup at all
  ({ client, calls } = mockClient());
  r = await sw.swapRoutes(ctxWith(provider(client), "mutinynet"));
  assert.equal(r.routes.length, 14); assert.ok(r.routes.every((x) => x.limits === "unavailable" && /mainnet only/.test(x.limitsNote) && x.fees === undefined)); assert.equal(calls.getQuote.length, 0);
  assert.match(r.markup.note, /about 1% total \(Satora ~0\.5% \+ Agent Escrow 0\.5%\) plus network fee/);
});
test("swap routes: mixed live pair rates fall back to the approximate total-fee note; each route still shows its own rate", async () => {
  const { client } = mockClient(); const q = client.getQuote;
  client.getQuote = async (p) => ({ ...(await q(p)), protocol_fee_rate: p.sourceChain === "Arkade" || p.targetChain === "Arkade" ? 0.012 : 0.01 });
  const r = await sw.swapRoutes(ctxWith(provider(client)));
  const by = Object.fromEntries(r.routes.map((x) => [`${x.from}->${x.to}`, x]));
  assert.equal(by["lightning->usdc"].fees.totalFeePercent, "1%"); assert.equal(by["lightning->usdc"].fees.satoraFeePercent, "0.5%");
  assert.equal(by["arkade->usdc"].fees.totalFeePercent, "1.2%"); assert.equal(by["arkade->usdc"].fees.satoraFeePercent, "0.7%");
  assert.match(r.markup.note, /Fees depend on the route/);
  assert.match(r.markup.note, /about 1% total \(Satora ~0\.5% \+ Agent Escrow 0\.5%\) plus network fee/);
  assert.doesNotMatch(r.markup.note, /Every swap costs/);
});
test("swap routes: a partial probe success never claims one route's rate for every swap", async () => {
  const { client } = mockClient(); const q = client.getQuote;
  client.getQuote = async (p) => {
    if (!(p.sourceChain === "Lightning" && p.targetChain === "Arkade")) throw new Error("satora down");
    return { ...(await q(p)), protocol_fee_rate: 0.0065, protocol_fee: 646, network_fee: 1, min_amount: 335, max_amount: 1000000, net_target_amount: "99353" };
  };
  const r = await sw.swapRoutes(ctxWith(provider(client)));
  const by = Object.fromEntries(r.routes.map((x) => [`${x.from}->${x.to}`, x]));
  assert.equal(by["lightning->arkade"].fees.totalFeePercent, "0.65%");
  assert.equal(by["lightning->usdc"].fees, undefined);
  assert.match(r.markup.note, /Fees depend on the route/);
  assert.doesNotMatch(r.markup.note, /Every swap costs 0\.65%/);
  assert.doesNotMatch(r.markup.note, /Every swap costs/);
});
test("swap routes CLI: takes no amount / address / wait flags; --json is fine; help shows its usage", () => {
  assert.equal(checkSwapArgs("routes", undefined, {}), null); assert.equal(checkSwapArgs("routes", undefined, { json: true }), null);
  for (const f of [{ sats: "5" }, { address: ADDR }, { from: "lightning" }, { to: "usdc" }, { wait: true }, { yes: true }, { timeout: "5" }]) assert.equal(checkSwapArgs("routes", undefined, f)?.code, "USAGE", JSON.stringify(f));
  assert.match(helpFor(["swap", "routes"], { help: true }, "x").usage, /^mark swap routes/); assert.ok("routes" in SWAP_USAGE);
});
test("MCP swap_routes: listed with no required arguments; a call returns all fourteen routes (mutinynet: no Satora lookup, limits unavailable)", async () => {
  tmpHome(); const CLI = new URL("../dist/src/cli.js", import.meta.url).pathname;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
  const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--network", "mutinynet", "--escrow-url", "http://127.0.0.1:9"], env, stderr: "ignore" });
  const cl = new Client({ name: "swap-routes-test", version: "0" }); await cl.connect(t);
  try {
    const tool = (await cl.listTools()).tools.find((x) => x.name === "swap_routes");
    assert.ok(tool, "swap_routes is registered"); assert.deepEqual(tool.inputSchema.required ?? [], []); assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), []);
    assert.match(tool.description, /Read-only: nothing is created/); assert.match(tool.description, /Fees depend on the route/); assert.match(tool.description, /about 1% total \(Satora ~0\.5% \+ Agent Escrow 0\.5%\) plus network fee/); assert.match(tool.description, /0\.65% total/); assert.match(tool.description, /0\.80% total/);
    const r = JSON.parse((await cl.callTool({ name: "swap_routes", arguments: {} })).content[0].text);
    assert.deepEqual(r.routes.map((x) => `${x.from}->${x.to}`), ["lightning->usdc", "lightning->usdt0", "lightning->usdc-base", "arkade->usdc", "arkade->usdt0", "arkade->usdc-base", "usdc->lightning", "usdc->arkade", "usdt0->lightning", "usdt0->arkade", "usdc-base->lightning", "usdc-base->arkade", "lightning->arkade", "arkade->lightning"]);
    assert.ok(r.routes.every((x) => x.limits === "unavailable" && x.fees === undefined)); assert.equal(r.markup.percent, "0.5%"); assert.match(r.markup.note, /about 1% total/); assert.equal(r.referral, SWAP_REFERRAL_ID);
  } finally { await cl.close(); }
});
test("a reverted payout tx is never reported as received or sent", async () => {
  const { client } = mockClient({ statuses: ["serverredeemed"] });
  const st = await sw.swapStatus(ctxWith(provider(client, null)), "sw-1"); assert.equal(st.received, undefined); assert.match(st.receivedNote, /failed on-chain/);
  const r = await sw.swapClaim(ctxWith(provider(client, null)), "sw-1"); assert.equal(r.received, undefined); assert.equal(r.reverted, true); assert.equal(r.payoutFailed, true); assert.doesNotMatch(r.note, /sent to your address/);
});
