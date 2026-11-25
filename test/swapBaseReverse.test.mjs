// `mark swap --from usdc-base`: USDC on Base -> Lightning / Arkade. The Satora SDK, the Base and Arbitrum RPCs are mocked: no network.
// Checks: the create check for a Base-sourced (CCTP-inbound) swap, Circle's fee and the Base gas on the quote, the ETH pre-check
// before anything is signed (SWAP_NEEDS_GAS), funding at most once with a resume from a recorded burn (never a second burn), the
// uncertain cases, and recovery before the burn (a Base transfer) and after it (sponsored, on the settlement chain).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { TOKEN_MESSENGER_V2 } from "@satora/swap";
import { gasNeedWei } from "../dist/src/swap/evm.js";
import { SWAP_TARGETS, SWAP_REFERRAL_ID, SWAP_MARKUP_BPS, SWAP_FEE_BRIDGE_IN_NOTE, SWEEP_TX, BRIDGE_IN_TXS, ethText, formatReverseQuote, routeFeeNote, swapRoute } from "../dist/src/swap/stable.js";
import { validPin } from "../dist/src/swap/reversePin.js";
import * as sw from "../dist/src/core/swap.js";
import { payoutArk, MOCK_SERVER_PK } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";

const DEP = "0x" + "ab".repeat(20);
const ME = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARK = payoutArk(7, "ark");
const B = SWAP_TARGETS["usdc-base"], ARB_USDC = SWAP_TARGETS.usdc.tokenId;
const BURN = "0x" + "be".repeat(32);
/** Shape of the SDK's composed quote for 2 USDC from Base -> Lightning (25 Nov 2026: bridge_fee 312 units). */
const RQ = { exchange_rate: "59170", network_fee: 4, gasless_network_fee: 0, protocol_fee: 33, protocol_fee_rate: 0.0098, min_amount: 356, max_amount: 20000000,
  source_amount: "2000000", target_amount: "3380", net_source_amount: "1999688", net_target_amount: "3341", bridge_fee: 312 };
const NEED_WEI = 280_000n * 6_000_000n * 3n + (140n + 330n) * 4_000_000n * 2n; // gas x price x3 + L1 x2

function mockClient(o = {}) {
  const calls = { getQuote: [], createSwap: [], fundSwap: [], gasless: [], recoverCctp: [], recoverGasless: [], plan: [], collab: [] };
  const stored = {}; let statuses = [...(o.statuses ?? ["pending"])];
  const client = {
    getEvmAddress: () => DEP,
    gaslessFundingPlan: (chainId) => { calls.plan.push(chainId); return { mode: "sponsored" }; },
    getQuote: async (p) => { calls.getQuote.push(p); return o.quote ?? RQ; },
    createSwap: async (p) => {
      calls.createSwap.push(p);
      const ln = p.target.chain === "Lightning";
      // like the SDK: a Base USDC source is remapped to Arbitrum USDC with the Base bridge source fields
      const base = p.source.chain === "8453";
      const r = { id: "rb-1", status: "pending", gasless: p.gasless === true, client_evm_address: DEP, evm_chain_id: 42161,
        source_amount: p.sourceAmount ?? "2000000", source_token: base ? { chain: "42161", token_id: ARB_USDC, symbol: "USDC", decimals: 6 } : { chain: p.source.chain, token_id: p.source.tokenId, symbol: "USDC", decimals: 6 },
        ...(base ? { bridge_source_chain: "Base", bridge_source_token_address: p.source.tokenId } : {}),
        target_token: { chain: p.target.chain, token_id: "btc", symbol: "BTC", decimals: 8 }, target_amount: "3341",
        ...(ln ? { client_lightning_invoice: p.targetAddress } : { target_arkade_address: p.targetAddress, arkade_server_pk: "02" + MOCK_SERVER_PK }), ...(o.tamper ?? {}) };
      stored[r.id] = { swapId: r.id, fresh: true, response: { ...r, direction: ln ? "evm_to_lightning" : "evm_to_arkade", ...(o.tamper ?? {}) } }; return { response: r };
    },
    getSwap: async (id) => { if (stored[id]?.fresh) { stored[id].fresh = false; return stored[id].response; }
      const s = statuses.length > 1 ? statuses.shift() : statuses[0]; const b = stored[id]?.response ?? {};
      const r = { ...b, id, status: s, ...(s !== "pending" ? { evm_fund_txid: "0xfund" } : {}) }; if (stored[id]) stored[id].response = r; return r; },
    getStoredSwap: async (id) => stored[id] ?? null,
    swapStorage: { getAll: async () => Object.values(stored) },
    fundSwap: async (id, signer) => { calls.fundSwap.push({ id, signer, resume: stored[id]?.cctpBurnTxid });
      if (o.burnThenFail || o.burns !== false) stored[id].cctpBurnTxid ??= BURN; // the SDK records the burn as soon as it is sent
      if (o.burnThenFail) throw new Error("attestation timed out");
      if (o.fundError) { if (o.burns === false) delete stored[id].cctpBurnTxid;
        if (o.sendBeforeFail) await signer.sendTransaction({ to: B.tokenId, data: "0x" });
        if (o.burnUnrecorded) { await signer.sendTransaction({ to: B.tokenId, data: "0x095ea7b3" }); await signer.sendTransaction({ to: TOKEN_MESSENGER_V2, data: "0x8e0250ee" }); }
        throw new Error(o.fundError); }
      stored[id].evmFundTxid = "0xlock"; return { txHash: "0xlock", cctp: { burnTxHash: stored[id].cctpBurnTxid } }; },
    fundSwapGasless: async (id) => { calls.gasless.push(id); return { txHash: "0xgasless" }; },
    getSwapDepositorKey: async () => ({ privateKey: "0x" + "11".repeat(32), address: DEP }),
    recoverCctpInboundSwap: async (id, to, opts) => { calls.recoverCctp.push({ id, to, ...(opts ? { opts } : {}) }); return { sweepTxHash: "0xsweep", recoveredAmount: 1999688n }; },
    recoverGaslessFunds: async (id, signer, to) => { calls.recoverGasless.push({ id, to }); return { txHash: "0xarb" }; },
    collabRefundEvmSwap: async (id) => { calls.collab.push(id); return { txHash: "0xcollab" }; },
    refundEvmSponsored: async () => ({ txHash: "0xsp" }),
  };
  return { client, calls, stored };
}
const homes = new WeakMap();
const homeOf = (c) => { if (!homes.has(c)) homes.set(c, fs.mkdtempSync(path.join(os.tmpdir(), "mark-brev-"))); return homes.get(c); };
/** o.base: Base reader state { usdc, eth, pending }; reads count per method. */
function provider(client, o = {}) {
  const p = new SatoraProvider(client, "https://swap.test", "https://ark.test", homeOf(client));
  const st = { usdc: 0n, eth: 0n, pending: false, ...(o.base ?? {}) }; const reads = { arbToken: 0 }; const sent = [];
  p.evm = { tokenBalance: async () => { reads.arbToken++; return o.arbUsdc ?? 0n; }, ethBalance: async () => 0n, gasPrice: async () => 20_000_000n };
  p.evmBase = { tokenBalance: async (token) => { assert.equal(token, B.tokenId); return st.usdc; }, ethBalance: async () => st.eth, gasPrice: async () => 6_000_000n,
    l1Fee: async (bytes) => BigInt(bytes) * 4_000_000n };
  p.ethUsd = async () => o.usd;
  p.signerFor = async (k, chainId) => ({ address: DEP, chainId, fake: true,
    sendTransaction: async (tx) => { if (p.failSend) throw new Error("rpc timeout after broadcast?"); sent.push({ chainId, ...tx }); return "0x" + (sent.length.toString(16).padStart(2, "0")).repeat(32); }, waitForReceipt: async () => ({ status: "success" }) });
  return Object.assign(p, { st, reads, sent });
}
const ctxWith = (p) => ({ network: "bitcoin", cfg: { arkServerUrl: "https://arkade.computer" }, swaps: async () => p });
const INV = () => makeInvoice({ sats: 3341 });
const create = async (p, extra = {}) => sw.swapRun(ctxWith(p), { from: "usdc-base", to: "lightning", invoice: INV(), confirm: true, ...extra });

test("route + fee wording: usdc-base is a stablecoin source; the to_btc note carries the bridge-in fee and Base gas, not Arbitrum", () => {
  assert.deepEqual(swapRoute("usdc-base", undefined), { dir: "to_btc", from: "usdc-base", to: "lightning" });
  const n = routeFeeNote({ dir: "to_btc", from: "usdc-base", to: "arkade" });
  assert.ok(n.includes(SWAP_FEE_BRIDGE_IN_NOTE)); assert.match(SWAP_FEE_BRIDGE_IN_NOTE, /approve and burn/); assert.doesNotMatch(SWAP_FEE_BRIDGE_IN_NOTE, /Arbitrum/);
  assert.equal(ethText(NEED_WEI), "0.00000505"); assert.equal(ethText(1n), "0.00000001");
});

test("gas estimate: Base gas price x3 plus the L1 data fee x2, for approve + burn (and one transfer for a sweep)", async () => {
  const r = provider(mockClient().client).evmBase;
  assert.equal(await gasNeedWei(r), NEED_WEI);
  assert.equal(await gasNeedWei(r, [SWEEP_TX]), 120_000n * 6_000_000n * 3n + 140n * 4_000_000n * 2n);
  assert.deepEqual(BRIDGE_IN_TXS.map((t) => t.name), ["approve", "burn"]);
  // a reader without an L1 fee (Arbitrum) counts only L2 gas
  assert.equal(await gasNeedWei({ gasPrice: async () => 10n }), 280_000n * 10n * 3n);
});

test("quote: Base source chain, Circle's bridge fee and the Base gas in ETH and approx USD; nothing created", async () => {
  const m = mockClient(); const p = provider(m.client, { usd: 3000 });
  const r = await sw.swapQuote(ctxWith(p), { from: "usdc-base", to: "lightning", amount: "2" });
  assert.equal(m.calls.createSwap.length, 0); const g = m.calls.getQuote[0];
  assert.deepEqual({ sc: g.sourceChain, st: g.sourceToken, sa: g.sourceAmount, ref: g.referralCode, fee: g.extraFees }, { sc: "8453", st: B.tokenId, sa: "2000000", ref: SWAP_REFERRAL_ID, fee: SWAP_MARKUP_BPS });
  assert.equal(r.quote.fees.bridgeFee, "0.000312"); assert.equal(r.quote.fees.bridgeFeeUnits, "312"); assert.equal(r.quote.fees.bridgeFeeToken, "USDC");
  assert.deepEqual(r.quote.gas, { network: "Base", txs: "approve + burn", eth: "0.00000505", wei: NEED_WEI.toString(), usd: "~$0.02" });
  assert.match(r.quote.markupNote, /Circle CCTP fee/); assert.match(r.quote.markupNote, /about 0\.00000505 ETH \(~\$0\.02\)/); assert.doesNotMatch(r.quote.markupNote, /No ETH needed/);
  // no price: ETH only, never a made-up USD figure
  const q2 = await sw.swapQuote(ctxWith(provider(m.client)), { from: "usdc-base", to: "arkade", amount: "2" }); assert.equal(q2.quote.gas.usd, undefined); assert.equal(q2.quote.gas.eth, "0.00000505");
  // gas unreadable: the quote still works, the gas is shown as unknown
  const p3 = provider(m.client); p3.evmBase.gasPrice = async () => { throw new Error("rpc down"); };
  const q3 = await sw.swapQuote(ctxWith(p3), { from: "usdc-base", to: "lightning", amount: "2" }); assert.equal(q3.quote.fees.bridgeFee, "0.000312");
  // the Arbitrum route is unchanged: gasless, no gas field
  const fa = formatReverseQuote({ ...RQ, bridge_fee: undefined }, { from: "usdc", to: "lightning", bps: 50 }); assert.equal(fa.gas, undefined); assert.match(fa.markupNote, /No ETH needed/);
});

test("create: a Base-sourced swap is accepted only as exactly USDC on Base, locked as USDC on the settlement chain; deposit shows ETH on Base", async () => {
  const m = mockClient(); const p = provider(m.client, { base: { eth: 0n } });
  const r = await create(p);
  const c = m.calls.createSwap[0]; assert.deepEqual(c.source, B); assert.equal(c.gasless, true); assert.equal(c.referralCode, SWAP_REFERRAL_ID); assert.equal(c.extraFees, SWAP_MARKUP_BPS);
  assert.deepEqual(m.calls.plan, [42161]); // the sponsored mint + lock happens on the settlement chain
  assert.equal(r.swap, "created"); assert.equal(r.deposit.network, "Base"); assert.equal(r.deposit.chainId, 8453); assert.equal(r.deposit.contract, B.tokenId); assert.equal(r.deposit.address, DEP);
  assert.deepEqual(r.deposit.gas, { network: "Base", needEth: "0.00000505", holdsEth: "0", sendEth: "0.00000505" });
  assert.match(r.deposit.howToDeposit, /on Base, not another chain/); assert.match(r.deposit.howToDeposit, /ETH on Base/);
  assert.match(r.next, /approve \+ burn on Base/);
  const pin = p.reversePin("rb-1"); assert.equal(pin.bridgeSourceChain, "Base"); assert.equal(pin.bridgeSourceToken.toLowerCase(), B.tokenId.toLowerCase()); assert.equal(pin.tokenContract, ARB_USDC);
});

test("create: refused (no deposit address) when Satora's answer is not a Base USDC swap", async () => {
  for (const tamper of [{ bridge_source_chain: undefined, bridge_source_token_address: undefined }, { bridge_source_chain: "Solana" }, { bridge_source_token_address: "0x" + "cd".repeat(20) },
    { evm_chain_id: 8453 }, { source_token: { chain: "42161", token_id: SWAP_TARGETS.usdt0.tokenId } }, { gasless: false }]) {
    const m = mockClient({ tamper }); const p = provider(m.client);
    await assert.rejects(create(p), (e) => e.code === "SWAP_FAILED" && /Do NOT deposit/.test(e.message) && !/0xabab/.test(e.message), JSON.stringify(tamper));
    assert.equal(p.reversePin("rb-1"), undefined);
  }
});

test("pin: bridge fields are both present or both absent; a changed bridge source is a mismatch", async () => {
  const base = { invoice: "lnbc1", depositAddress: DEP, tokenContract: ARB_USDC, sourceUnits: "1", targetSats: 1, evmChainId: 42161 };
  assert.equal(validPin(base), true); assert.equal(validPin({ ...base, bridgeSourceChain: "Base", bridgeSourceToken: B.tokenId }), true);
  assert.equal(validPin({ ...base, bridgeSourceChain: "Base" }), false); assert.equal(validPin({ ...base, bridgeSourceToken: B.tokenId }), false);
  // Satora later reporting a different bridge source: fund stops
  const m = mockClient(); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  m.stored["rb-1"].response.bridge_source_token_address = "0x" + "cd".repeat(20);
  await assert.rejects(sw.swapFund(ctxWith(p), "rb-1"), (e) => e.code === "SWAP_FAILED"); assert.equal(m.calls.fundSwap.length, 0);
});

test("fund: SWAP_NEEDS_GAS before anything is signed (ETH needed vs held); then funds once on Base with the deposit key", async () => {
  const m = mockClient(); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: 1_000_000_000_000n } }); await create(p);
  await assert.rejects(sw.swapFund(ctxWith(p), "rb-1"), (e) => e.code === "SWAP_NEEDS_GAS" && e.details.needEth === "0.00000505" && e.details.holdsEth === "0.000001"
    && e.details.sendEth === "0.00000405" && e.details.network === "Base" && /Nothing was signed/.test(e.message) && /ETH on Base/.test(e.message));
  assert.equal(m.calls.fundSwap.length, 0); assert.equal(p.fundAttemptedAt("rb-1"), undefined);
  // the provider's own check (another caller) also refuses without signing
  const f0 = await p.fundReverse("rb-1"); assert.equal(f0.success, false); assert.deepEqual(f0.needEth, { network: "Base", needWei: NEED_WEI.toString(), holdsWei: "1000000000000" });
  p.st.eth = NEED_WEI;
  const r = await sw.swapFund(ctxWith(p), "rb-1");
  assert.equal(r.funded, true); assert.equal(r.burnTx, BURN); assert.equal(r.burnExplorer, B.explorerTx + BURN); assert.match(r.note, /burned on Base/);
  assert.equal(m.calls.fundSwap.length, 1); assert.equal(m.calls.fundSwap[0].signer.chainId, 8453); assert.equal(m.calls.gasless.length, 0);
  // never twice: a second fund refuses, no new burn
  const again = await p.fundReverse("rb-1"); assert.equal(again.success, false); assert.match(again.skipped, /already funded \(tx 0xlock\)/); assert.equal(m.calls.fundSwap.length, 1);
});

test("fund: USDC short on Base is not signed either; arkade payouts use the same path", async () => {
  const m = mockClient(); const p = provider(m.client, { base: { usdc: 1_000_000n, eth: NEED_WEI } });
  await sw.swapRun(ctxWith(p), { from: "usdc-base", to: "arkade", address: ARK, amount: "2", confirm: true });
  const r = await sw.swapFund(ctxWith(p), "rb-1"); assert.equal(r.funded, false); assert.match(r.note, /only the missing 1 completes it/); assert.equal(m.calls.fundSwap.length, 0);
});

test("fund: a burn sent then a failure is uncertain; fund again RESUMES from the recorded burn (no second burn, no ETH check)", async () => {
  const m = mockClient({ burnThenFail: true }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  const r = await sw.swapFund(ctxWith(p), "rb-1");
  assert.equal(r.funded, false); assert.equal(r.burnTx, BURN); assert.match(JSON.stringify(r), /swap fund rb-1/);
  assert.notEqual(p.fundAttemptedAt("rb-1"), undefined);
  // the USDC left Base and the ETH was spent: the resume needs neither
  p.st.usdc = 0n; p.st.eth = 0n;
  const st = await sw.swapStatus(ctxWith(p), "rb-1"); assert.equal(st.burnTx, BURN); assert.doesNotMatch(JSON.stringify(st), /send .* USDC/i);
  m.client.fundSwap = async (id, signer) => { m.calls.fundSwap.push({ id, signer, resume: m.stored[id].cctpBurnTxid }); return { txHash: "0xlock", cctp: { burnTxHash: m.stored[id].cctpBurnTxid } }; };
  const r2 = await sw.swapFund(ctxWith(p), "rb-1");
  assert.equal(r2.funded, true); assert.equal(m.calls.fundSwap.length, 2); assert.equal(m.calls.fundSwap[1].resume, BURN);
});

test("fund: a failure before anything was sent clears the attempt; once a transaction was sent it stays uncertain, even with the USDC still there", async () => {
  const m = mockClient({ fundError: "gas estimation failed", burns: false }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  const r = await p.fundReverse("rb-1"); assert.equal(r.success, false); assert.equal(r.uncertain, undefined); assert.equal(p.fundAttemptedAt("rb-1"), undefined);
  assert.equal(p.sent.length, 0);
  // regression (review): a burn sent and mined but not recorded, the deposit address overfunded so it still holds >= the amount,
  // nothing pending: never cleared, never signed again
  const m2 = mockClient({ fundError: "burn receipt timeout", burns: false, sendBeforeFail: true }); const p2 = provider(m2.client, { base: { usdc: 4_000_000n, eth: NEED_WEI } }); await create(p2);
  const r2 = await p2.fundReverse("rb-1"); assert.equal(r2.uncertain, true); assert.notEqual(p2.fundAttemptedAt("rb-1"), undefined); assert.equal(p2.sent.length, 1);
  const r3 = await p2.fundReverse("rb-1"); assert.match(r3.skipped, /never signs it again/); assert.equal(m2.calls.fundSwap.length, 1);
  const r4 = await sw.swapFund(ctxWith(p2), "rb-1"); assert.equal(r4.funded, false); assert.equal(m2.calls.fundSwap.length, 1);
});

test("recover before the burn: one USDC transfer on Base from the deposit address, after a Base gas check", async () => {
  const m = mockClient({ statuses: ["expired"] }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: 0n } }); await create(p);
  const r0 = await sw.swapRecover(ctxWith(p), "rb-1", ME);
  assert.equal(r0.recovered, false); assert.match(r0.note, /ETH on Base/); assert.equal(r0.needEth, ethText(120_000n * 6_000_000n * 3n + 140n * 4_000_000n * 2n)); assert.equal(p.sent.length, 0);
  p.st.eth = NEED_WEI;
  const r = await sw.swapRecover(ctxWith(p), "rb-1", ME);
  assert.equal(r.recovered, true); assert.equal(r.network, "Base"); assert.equal(r.amount, "2"); assert.match(r.explorer, /basescan/);
  assert.equal(p.sent.length, 1); assert.equal(p.sent[0].chainId, 8453); assert.equal(p.sent[0].to, B.tokenId);
  assert.ok(p.sent[0].data.startsWith("0xa9059cbb") && p.sent[0].data.toLowerCase().includes(ME.slice(2).toLowerCase()));
  assert.equal(m.calls.recoverCctp.length, 0); assert.equal(m.calls.recoverGasless.length, 0);
});

test("recover after the burn: sponsored mint + sweep as USDC on the settlement chain, no ETH; refused while the funding may still land", async () => {
  const m = mockClient({ burnThenFail: true, statuses: ["pending"] }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  await sw.swapFund(ctxWith(p), "rb-1"); p.st.usdc = 0n; p.st.eth = 0n;
  await assert.rejects(sw.swapRecover(ctxWith(p), "rb-1", ME), (e) => e.code === "SWAP_FUNDING");
  p.markAttempt("rb-1", Date.now() - 31 * 60 * 1000);
  const r = await sw.swapRecover(ctxWith(p), "rb-1", ME);
  assert.equal(r.recovered, true); assert.equal(r.network, "Arbitrum One"); assert.equal(r.burnTx, BURN); assert.match(r.explorer, /arbiscan/); assert.equal(r.amount, "1.999688");
  assert.deepEqual(m.calls.recoverCctp, [{ id: "rb-1", to: ME }]); assert.equal(p.sent.length, 0);
});

test("refund of a locked Base swap uses the existing gasless refund; recover after it needs --to and is sponsored", async () => {
  const m = mockClient({ statuses: ["expired"] }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  m.stored["rb-1"].cctpBurnTxid = BURN; m.stored["rb-1"].response.evm_fund_txid = "0xlock";
  const rf = await sw.swapRefund(ctxWith(p), "rb-1"); assert.ok(rf); assert.deepEqual(m.calls.collab, ["rb-1"]);
  await assert.rejects(sw.swapRecover(ctxWith(p), "rb-1", undefined), (e) => e.code === "USAGE");
  const r = await sw.swapRecover(ctxWith(p), "rb-1", ME); assert.equal(r.recovered, true); assert.equal(m.calls.recoverCctp.length, 1);
});

test("hardening: a burn with no funding time refuses recover (resume first); a provider without a Base reader refuses before create", async () => {
  const m = mockClient({ statuses: ["pending"] }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  m.stored["rb-1"].cctpBurnTxid = BURN; // burn known to the swap library, no attempt record in this home
  await assert.rejects(sw.swapRecover(ctxWith(p), "rb-1", ME), (e) => e.code === "SWAP_FUNDING" && /swap fund rb-1/.test(e.message)); assert.equal(m.calls.recoverCctp.length, 0);
  const m2 = mockClient(); const p2 = provider(m2.client); p2.evmOn = undefined;
  await assert.rejects(create(p2), (e) => e.code === "BAD_CONFIG"); assert.equal(m2.calls.createSwap.length, 0);
});

test("lost funding time: a recorded burn still resumes (fund and fund --wait), never a second burn", async () => {
  for (const wait of [false, true]) {
    const m = mockClient({ statuses: ["pending"] }); const p = provider(m.client, { base: { usdc: 0n, eth: 0n } }); await create(p);
    m.stored["rb-1"].cctpBurnTxid = BURN; assert.equal(p.fundAttemptedAt("rb-1"), undefined);
    const r = await sw.swapFund(ctxWith(p), "rb-1", wait ? { wait: true, timeoutSec: 1, pollMs: 1 } : {});
    assert.equal(m.calls.fundSwap.length, 1, `wait=${wait}`); assert.equal(m.calls.fundSwap[0].resume, BURN); assert.notEqual(p.fundAttemptedAt("rb-1"), undefined);
    if (!wait) assert.equal(r.funded, true);
  }
});

test("create refuses a provider that cannot track the burn, and a Base quote without Circle's fee", async () => {
  const m = mockClient(); const p = provider(m.client); p.cctpBurn = undefined;
  await assert.rejects(create(p), (e) => e.code === "BAD_CONFIG" && /burn/.test(e.message)); assert.equal(m.calls.createSwap.length, 0);
  const m2 = mockClient({ quote: { ...RQ, bridge_fee: undefined } }); const p2 = provider(m2.client);
  await assert.rejects(create(p2), (e) => e.code === "QUOTE_UNAVAILABLE"); assert.equal(m2.calls.createSwap.length, 0);
  await assert.rejects(sw.swapQuote(ctxWith(p2), { from: "usdc-base", to: "lightning", amount: "2" }), (e) => e.code === "QUOTE_UNAVAILABLE");
});

test("an unreadable local swap record is not 'no burn': fund and recover move nothing", async () => {
  const m = mockClient({ statuses: ["pending"] }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  m.stored["rb-1"].cctpBurnTxid = BURN; const real = m.client.getStoredSwap;
  m.client.getStoredSwap = async () => { throw new Error("storage locked"); };
  const f = await p.fundReverse("rb-1"); assert.equal(f.success, false); assert.match(f.message, /not funding it/); assert.equal(m.calls.fundSwap.length, 0);
  const r = await p.recoverReverse("rb-1", ME); assert.equal(r.success, false); assert.match(r.message, /nothing was moved/);
  assert.equal(m.calls.recoverCctp.length, 0); assert.equal(m.calls.recoverGasless.length, 0); assert.equal(p.sent.length, 0);
  // no local copy at all: Satora's record (its bridge source) picks the path, never the Arbitrum default
  m.client.getStoredSwap = async (id) => (id === "rb-1" ? null : real(id));
  const r2 = await p.recoverReverse("rb-1", ME); assert.equal(r2.network, "Base"); assert.equal(m.calls.recoverGasless.length, 0);
});

test("concurrent fund calls (same home, two providers) make one burn", async () => {
  const m = mockClient(); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  const q = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); // a second process on the same Mark home (same dir, same lock file)
  const [a, b, c] = await Promise.all([p.fundReverse("rb-1"), p.fundReverse("rb-1"), q.fundReverse("rb-1")]);
  assert.equal(m.calls.fundSwap.length, 1); assert.strictEqual(a, b); // p's two calls share one run
  assert.equal([a, c].filter((x) => x.success).length, 1); assert.ok((a.success ? c : a).skipped); // the other process is told it was funded
});

test("a burn Mark's signer sent but the swap library did not record: never funded again, recovered on the settlement chain from that burn", async () => {
  const m = mockClient({ fundError: "storage write failed", burns: false, burnUnrecorded: true, statuses: ["pending"] });
  const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  const r = await p.fundReverse("rb-1"); assert.equal(r.uncertain, true); assert.equal(m.stored["rb-1"].cctpBurnTxid, undefined);
  const burn = p.sent[1] && "0x" + "02".repeat(32); assert.equal(p.sentBurn("rb-1"), burn);
  // even with the funding time lost, no second burn
  p.markAttempt("rb-1", undefined); const again = await p.fundReverse("rb-1"); assert.match(again.skipped, /already sent \(burn 0x0202/); assert.equal(m.calls.fundSwap.length, 1);
  p.markAttempt("rb-1", Date.now() - 31 * 60 * 1000); p.st.usdc = 0n; p.st.eth = 0n;
  const rec = await sw.swapRecover(ctxWith(p), "rb-1", ME);
  assert.equal(rec.recovered, true); assert.equal(rec.network, "Arbitrum One"); assert.deepEqual(m.calls.recoverCctp, [{ id: "rb-1", to: ME, opts: { burnTxHash: burn } }]);
});

test("a Base send with an unknown outcome: recover sweeps only while all the USDC is still there", async () => {
  const m = mockClient({ statuses: ["pending"] }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  m.client.fundSwap = async (id, signer) => { m.calls.fundSwap.push({ id }); await signer.sendTransaction({ to: TOKEN_MESSENGER_V2, data: "0x" }); };
  p.failSend = true; const r = await p.fundReverse("rb-1"); assert.equal(r.uncertain, true); p.failSend = false;
  assert.match((await p.fundReverse("rb-1")).skipped ?? "", /never signs it again/);
  p.markAttempt("rb-1", Date.now() - 31 * 60 * 1000);
  p.st.usdc = 1_000_000n; const r1 = await sw.swapRecover(ctxWith(p), "rb-1", ME); assert.equal(r1.recovered, false); assert.match(r1.message, /a burn may have gone through/); assert.equal(p.sent.length, 0);
  p.st.usdc = 2_000_000n; const r2 = await sw.swapRecover(ctxWith(p), "rb-1", ME); assert.equal(r2.recovered, true); assert.equal(r2.network, "Base"); assert.equal(p.sent.length, 1);
});

test("a pinned Base swap with no swap-library record is not funded", async () => {
  const m = mockClient(); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: NEED_WEI } }); await create(p);
  const real = m.client.getStoredSwap; m.client.getStoredSwap = async () => null;
  const r = await p.fundReverse("rb-1"); assert.equal(r.success, false); assert.match(r.message, /no swap-library record/); assert.equal(m.calls.fundSwap.length, 0);
  m.client.getStoredSwap = real;
});

test("fund --wait: USDC there but no ETH on Base signs nothing and ends with SWAP_NEEDS_GAS; once ETH arrives it funds once", async () => {
  const m = mockClient({ statuses: ["pending"] }); const p = provider(m.client, { base: { usdc: 2_000_000n, eth: 0n } }); await create(p);
  await assert.rejects(sw.swapFund(ctxWith(p), "rb-1", { wait: true, timeoutSec: 0.05, pollMs: 5 }), (e) => e.code === "SWAP_NEEDS_GAS" && e.details.holdsEth === "0");
  assert.equal(m.calls.fundSwap.length, 0); assert.equal(p.fundAttemptedAt("rb-1"), undefined);
  // unreadable ETH: nothing signed either
  p.evmBase.ethBalance = async () => { throw new Error("rpc down"); };
  const t = await sw.swapFund(ctxWith(p), "rb-1", { wait: true, timeoutSec: 0.05, pollMs: 5 }); assert.equal(t.timeout, true); assert.equal(m.calls.fundSwap.length, 0);
  p.evmBase.ethBalance = async () => p.st.eth; p.st.eth = NEED_WEI;
  m.statuses = undefined; const r = await sw.swapFund(ctxWith(p), "rb-1", { wait: true, timeoutSec: 0.05, pollMs: 5 });
  assert.equal(m.calls.fundSwap.length, 1); assert.ok(r);
});
