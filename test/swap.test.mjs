// `mark swap` (BTC -> USDC / USDT0 on Arbitrum via Satora): fee math, markup cap, and the referral ID + extraFees on BOTH getQuote and
// createSwap. The Satora SDK is mocked: no network in these tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { SWAP_REFERRAL_ID, SWAP_MARKUP_BPS, SWAP_MARKUP_CAP_BPS, SWAP_TARGETS, checkMarkupBps, splitSwapFees, formatSwapQuote, checkEvmAddress, units, pct } from "../dist/src/swap/stable.js";
import * as sw from "../dist/src/core/swap.js";
import { checkSwapArgs, parseArgs, helpFor, SWAP_USAGE } from "../dist/src/cliArgs.js";
import { openCtx } from "../dist/src/core/context.js";
import { tmpHome, payoutArk } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";

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
const provider = (client) => new SatoraProvider(client, "https://swap.test", "https://ark.test");
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
  assert.deepEqual(f, { satoraFeeSats: 500, satoraFeeRate: 0.005, markupSats: 500, markupBps: 50, networkFeeSats: 7, totalFeeSats: 1007 });
  // odd amount: markup rounds to the nearest sat, Satora gets the rest of its single protocol fee
  const g = splitSwapFees({ ...Q, protocol_fee: 123, protocol_fee_rate: 0.0075, network_fee: 5, gasless_network_fee: 2 }, 12345, 50);
  assert.equal(g.markupSats, 62); assert.equal(g.satoraFeeSats, 61); assert.equal(g.networkFeeSats, 7); assert.equal(g.totalFeeSats, 130);
  assert.equal(g.satoraFeeRate, 0.0025);
  assert.throws(() => splitSwapFees(Q, 100000, 101), (e) => e.code === "BAD_MARKUP");
});
test("quote output names the Agent Escrow markup openly, in sats, bps and percent", () => {
  const q = formatSwapQuote(Q, { from: "lightning", to: "usdc", sats: 100000, bps: SWAP_MARKUP_BPS });
  assert.equal(q.fees.agentEscrowMarkup, "0.5%"); assert.equal(q.fees.agentEscrowMarkupBps, 50); assert.equal(q.fees.agentEscrowMarkupSats, 500);
  assert.equal(q.fees.satoraFeeSats, 500); assert.equal(q.fees.networkFeeSats, 7); assert.equal(q.fees.totalFeeSats, 1007);
  assert.match(q.markupNote, /0\.5% Agent Escrow fee \(500 sats\)/);
  assert.equal(q.receive, "60.675562"); assert.equal(q.payAmountSats, 100000); assert.equal(q.token.symbol, "USDC"); assert.equal(q.token.chainId, 42161);
  assert.match(q.rate, /61292\.781 USDC per BTC/); assert.equal(q.referral, SWAP_REFERRAL_ID);
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
  assert.deepEqual(calls.createSwap[0], { source: { chain: "Lightning", tokenId: "btc" }, target: SWAP_TARGETS.usdc, sourceAmount: 100000, targetAddress: ADDR, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
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
  assert.match(r.notice, /REAL MONEY/); assert.match(r.notice, /0\.5% Agent Escrow fee/);
});
test("mark swap quote: referral ID + extraFees sent; out-of-range amounts flagged; create refuses them", async () => {
  const { client, calls } = mockClient(); const c = ctxWith(provider(client));
  const r = await sw.swapQuote(c, { sats: "100000" }); assert.equal(r.quote.fees.agentEscrowMarkupSats, 500); assert.equal(r.note, undefined);
  assert.equal(calls.getQuote[0].referralCode, SWAP_REFERRAL_ID); assert.equal(calls.getQuote[0].extraFees, 50);
  assert.match((await sw.swapQuote(c, { sats: 100 })).note, /out of range/);
  await assert.rejects(sw.swapRun(c, { sats: 100, address: ADDR, confirm: true }), (e) => e.code === "SWAP_AMOUNT"); assert.equal(calls.createSwap.length, 0);
});
test("mark swap --wait: shows the invoice first, claims when serverfunded, returns the payout tx", async () => {
  const { client, calls } = mockClient({ statuses: ["pending", "clientfunded", "serverfunded", "serverredeemed"] }); const seen = [];
  const r = await sw.swapRun(ctxWith(provider(client)), { sats: 100000, address: ADDR, confirm: true, wait: true, pollMs: 1, onProgress: (x) => seen.push(x) });
  assert.match(seen[0].invoice, /^lnbc1000000n/); assert.equal(r.swap, "done"); assert.equal(r.payoutTx, "0xpayout"); assert.equal(r.explorer, "https://arbiscan.io/tx/0xpayout");
  assert.deepEqual(calls.claim, ["sw-1"]);
});
test("claim failure stops at once with the reason and says not to pay again", async () => {
  const { client } = mockClient({ statuses: ["serverfunded"], claim: { success: false, message: "relay down" } });
  const r = await sw.swapClaim(ctxWith(provider(client)), "sw-1");
  assert.equal(r.claimFailed, true); assert.equal(r.claim.message, "relay down"); assert.match(r.note, /Do NOT pay again/);
});
test("swap status: read-only, token amount and explorer link; never claims", async () => {
  const { client, calls } = mockClient({ statuses: ["serverredeemed"] }); const r = await sw.swapStatus(ctxWith(provider(client)), "sw-1");
  assert.equal(r.status, "serverredeemed"); assert.equal(r.receive, "60.675562"); assert.equal(r.token, "USDC"); assert.equal(r.payoutTx, "0xpayout"); assert.equal(r.raw, undefined);
  assert.equal(calls.claim.length, 0);
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
  assert.equal(chk(["swap", "--sats", "1000", "--address", ADDR, "--to", "usdt0", "--from", "arkade", "--yes", "--wait"]), null);
  assert.equal(chk(["swap", "create", "--sats", "1000", "--address", ADDR]), null);
  assert.equal(chk(["swap", "status", "id1"]), null); assert.equal(chk(["swap", "claim", "id1", "--wait"]), null);
  assert.equal(chk(["swap", "refund", "id1", "--to", "ark1xyz"]), null);
  assert.match(chk(["swap", "quote"]).message, /--sats is required/);
  assert.match(chk(["swap", "--sats", "1000"]).message, /--address/);
  assert.match(chk(["swap", "quote", "--sats", "1.5"]).message, /whole number/);
  assert.match(chk(["swap", "quote", "--sats", "1000", "--to", "dai"]).message, /usdc or usdt0/);
  assert.match(chk(["swap", "quote", "--sats", "1000", "--yes"]).message, /--yes is only/);
  assert.match(chk(["swap", "status"]).message, /swap id required/);
  assert.match(chk(["swap", "refund", "id1"]).message, /--to/);
  assert.match(chk(["swap", "frobnicate"]).message, /unknown swap subcommand/);
  assert.deepEqual(helpFor(["swap", "quote"], { help: true }, "x"), { usage: SWAP_USAGE.quote });
  assert.deepEqual(helpFor(["swap"], { help: true }, "x"), { usage: SWAP_USAGE });
});

// ---------- cross-surface consistency ----------
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
test("docs: README, quickstart, skill and help all state the same markup and list every swap command and flag", () => {
  const README = rd("../README.md"), QS = rd("../docs/AGENT_QUICKSTART.md"), SKILL = rd("../skills/agent-escrow/SKILL.md"), AGENTS = rd("../AGENTS.md");
  const p = pct(SWAP_MARKUP_BPS);
  for (const [n, d] of [["README", README], ["quickstart", QS], ["skill", SKILL], ["AGENTS", AGENTS], ["help quote", SWAP_USAGE.quote], ["help create", SWAP_USAGE.create]]) {
    assert.ok(d.includes(`${p} Agent Escrow`), `${n} must say "${p} Agent Escrow"`);
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
    [{ source_token: { chain: "Arkade", token_id: "btc" } }, /source Arkade is not Lightning/], [{ source_token: undefined }, /source undefined/], [{ btc_vhtlc_address: payoutArk(3, "tark") }, /tark1/, "arkade"], [{ btc_vhtlc_address: undefined }, /no Ark address/, "arkade"]]) {
    const { client } = mockClient({ tamper }); const seen = [];
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: from ?? "lightning", sats: 100000, address: ADDR, confirm: true, wait: true, onProgress: (x) => seen.push(x) }),
      (e) => e.code === "SWAP_FAILED" && why.test(e.message) && /Do NOT pay/.test(e.message), JSON.stringify(tamper));
    assert.equal(seen.length, 0);
  }
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
