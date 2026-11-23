// `mark swap` from a stablecoin (USDC / USDT0 on Arbitrum -> Lightning or Arkade), gasless. The Satora SDK and the Arbitrum RPC are
// mocked: no network in these tests. Checks: referral ID + extraFees on getQuote AND createSwap, the created swap checked before any
// deposit address is shown, the gasless deposit flow, funding at most once, and recovery.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { SWAP_REFERRAL_ID, SWAP_MARKUP_BPS, SWAP_TARGETS, swapRoute, tokenUnits, formatReverseQuote } from "../dist/src/swap/stable.js";
import * as sw from "../dist/src/core/swap.js";
import { checkSwapArgs, parseArgs } from "../dist/src/cliArgs.js";
import { payoutArk, MOCK_SERVER_PK, tmpHome } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEP = "0x" + "ab".repeat(20); // this Mark home's gasless deposit address (mock)
const ME = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // a valid EIP-55 address to recover to
const ARK = payoutArk(7, "ark"); // the user's Ark address on the (mock) Arkade server
const USDC = SWAP_TARGETS.usdc.tokenId;
/** Shape of a real Satora mainnet quote for 1.5 USDC -> Lightning with extraFees 50 (23 Nov 2026). */
const RQ = { exchange_rate: "61274.5", network_fee: 4, gasless_network_fee: 0, protocol_fee: 24, protocol_fee_rate: 0.0098, min_amount: 356, max_amount: 20000000,
  source_amount: "1500000", target_amount: "2448", net_source_amount: "1500000", net_target_amount: "2420" };

function mockClient(o = {}) {
  const calls = { getQuote: [], createSwap: [], fund: [], getSwap: [], collab: [], sponsored: [], recover: [], claimArkade: [] };
  const stored = {}; let statuses = [...(o.statuses ?? ["pending"])];
  const client = {
    getEvmAddress: () => DEP,
    getQuote: async (p) => { calls.getQuote.push(p); return o.quote ?? RQ; },
    createSwap: async (p) => {
      calls.createSwap.push(p);
      const ln = p.target.chain === "Lightning"; const inv = ln && /^ln/i.test(p.targetAddress) && !p.targetAddress.includes("@");
      // like Satora's live create response: no direction (its swap record has one)
      const r = { id: "rv-1", status: "pending", gasless: p.gasless === true, client_evm_address: DEP,
        source_amount: p.sourceAmount ?? "1500000", source_token: { chain: p.source.chain, token_id: p.source.tokenId, symbol: "USDC", decimals: 6 }, evm_chain_id: 42161,
        target_token: { chain: p.target.chain, token_id: "btc", symbol: "BTC", decimals: 8 }, target_amount: inv ? "2420" : "2420",
        ...(ln ? { client_lightning_invoice: inv ? p.targetAddress : makeInvoice({ sats: 2420 }) } : { target_arkade_address: p.targetAddress, arkade_server_pk: "02" + MOCK_SERVER_PK }), ...(o.tamper ?? {}) };
      stored[r.id] = { swapId: r.id, fresh: true, response: { ...r, direction: ln ? "evm_to_lightning" : "evm_to_arkade", ...(o.tamper ?? {}) } }; return { response: r };
    },
    getSwap: async (id) => { calls.getSwap.push(id); if (stored[id]?.fresh) { stored[id].fresh = false; return stored[id].response; } // the read right after create
      const s = statuses.length > 1 ? statuses.shift() : statuses[0]; const base = stored[id]?.response ?? o.existing ?? {};
      const r = { ...base, id, status: s, ...(s !== "pending" ? { evm_fund_txid: "0xfund" } : {}), ...(s === "serverredeemed" && base.direction === "evm_to_lightning" ? { lightning_payment_settled: true } : {}) };
      if (stored[id]) stored[id].response = r; return r; },
    getStoredSwap: async (id) => stored[id] ?? (o.existing ? { swapId: id } : null),
    swapStorage: { getAll: async () => Object.values(stored).concat(o.others ?? []) },
    fundSwapGasless: async (id) => { calls.fund.push(id); if (o.fundError) throw new Error(o.fundError); return { txHash: "0xfund" }; },
    collabRefundEvmSwap: async (id) => { calls.collab.push(id); if (o.collabError) throw new Error(o.collabError); return { txHash: "0xcollab" }; },
    refundEvmSponsored: async (id) => { calls.sponsored.push(id); return { txHash: "0xsponsored", userOpHash: "0xop" }; },
    getSwapDepositorKey: async () => ({ privateKey: "0x" + "11".repeat(32), address: DEP }),
    recoverGaslessFunds: async (id, signer, to) => { calls.recover.push({ id, signer, to }); return { txHash: "0xrecover", amount: "1500000" }; },
    claimArkade: async (id, opts) => { calls.claimArkade.push({ id, ...opts }); return { success: true, txId: "arkclaim1" }; },
  };
  return { client, calls, stored };
}
/** balances: token units at the deposit address, read in turn (the last one repeats). */
/** one Mark home (swaps dir) per mock client, as in real use: what create records is there for later commands */
const homes = new WeakMap();
const homeOf = (client) => { if (!homes.has(client)) homes.set(client, fs.mkdtempSync(path.join(os.tmpdir(), "mark-rev-"))); return homes.get(client); };
function provider(client, o = {}) {
  const p = new SatoraProvider(client, "https://swap.test", "https://ark.test", o.dir ?? homeOf(client));
  let bals = [...(o.balances ?? [0n])];
  p.evm = { tokenBalance: async () => (bals.length > 1 ? bals.shift() : bals[0]), ethBalance: async () => o.eth ?? 0n, gasPrice: async () => 20_000_000n };
  p.signerFor = async () => ({ address: DEP, fake: true });
  return p;
}
const ctxWith = (p, network = "bitcoin") => ({ network, cfg: { arkServerUrl: "https://arkade.computer" }, swaps: async () => p });
const INV = () => makeInvoice({ sats: 2420 });

test("route: a stablecoin --from is the reverse direction (default --to lightning); forward defaults are unchanged", () => {
  assert.deepEqual(swapRoute("usdc", undefined), { dir: "to_btc", from: "usdc", to: "lightning" });
  assert.deepEqual(swapRoute("usdt", "arkade"), { dir: "to_btc", from: "usdt0", to: "arkade" });
  assert.deepEqual(swapRoute(undefined, undefined), { dir: "to_stable", from: "lightning", to: "usdc" });
  assert.deepEqual(swapRoute("arkade", "usdt0"), { dir: "to_stable", from: "arkade", to: "usdt0" });
  assert.throws(() => swapRoute("lightning", "arkade"), /needs a stablecoin --from/);
  assert.throws(() => swapRoute("usdc", "usdt0"), /--to must be lightning or arkade/);
  assert.equal(tokenUnits("1.5", 6), 1500000n); assert.equal(tokenUnits("2", 6), 2000000n);
  for (const bad of ["0", "0.0000001", "-1", "1,5", "", "abc"]) assert.throws(() => tokenUnits(bad, 6), (e) => e.code === "USAGE", bad);
});

test("quote: referral ID and the 50 bps markup on getQuote; markup shown openly in sats; nothing created", async () => {
  const { client, calls } = mockClient(); const r = await sw.swapQuote(ctxWith(provider(client)), { from: "usdc", to: "lightning", amount: "1.5" });
  assert.equal(calls.getQuote.length, 1); assert.equal(calls.createSwap.length, 0);
  const g = calls.getQuote[0];
  assert.deepEqual({ sc: g.sourceChain, st: g.sourceToken, tc: g.targetChain, tt: g.targetToken, sa: g.sourceAmount, ref: g.referralCode, fee: g.extraFees, dest: g.lightningDestination },
    { sc: "42161", st: USDC, tc: "Lightning", tt: "btc", sa: "1500000", ref: SWAP_REFERRAL_ID, fee: SWAP_MARKUP_BPS, dest: undefined });
  assert.match(r.next, /--invoice <bolt11/); assert.doesNotMatch(r.next, /undefined/);
  // an Arkade quote needs no address either
  const a = await sw.swapQuote(ctxWith(provider(client)), { from: "usdc", to: "arkade", amount: "1.5" }); assert.match(a.next, /--address <ark address> --amount 1\.5/);
  assert.equal(r.quote.send, "1.5"); assert.equal(r.quote.receiveSats, 2420);
  assert.equal(r.quote.fees.agentEscrowMarkup, "0.5%"); assert.equal(r.quote.fees.agentEscrowMarkupSats, 12); assert.equal(r.quote.fees.satoraFeeSats, 12); assert.equal(r.quote.fees.totalFeeSats, 28);
  assert.match(r.quote.markupNote, /0\.5% Agent Escrow fee \(12 sats\)/); assert.equal(r.quote.referral, SWAP_REFERRAL_ID);
  // an invoice quotes the invoice's sats (it pins the payout)
  const inv = INV(); await sw.swapQuote(ctxWith(provider(client)), { from: "usdt0", to: "lightning", invoice: inv });
  const gi = calls.getQuote.at(-1); assert.equal(gi.targetAmount, 2420); assert.equal(gi.lightningDestination, inv); assert.equal(gi.sourceToken, SWAP_TARGETS.usdt0.tokenId);
  assert.equal(formatReverseQuote(RQ, { from: "usdc", to: "arkade", bps: 50 }).token.symbol, "USDC");
});

test("preview (no confirm): nothing is created, the target and the markup are spelled out", async () => {
  const { client, calls } = mockClient();
  const r = await sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "arkade", amount: "1.5", address: ARK });
  assert.equal(r.swap, "preview"); assert.equal(calls.createSwap.length, 0); assert.equal(calls.fund.length, 0);
  assert.match(r.notice, /REAL MONEY/); assert.match(r.notice, /0\.5% Agent Escrow fee/); assert.match(r.next, /--yes --wait/); assert.equal(r.deposit, undefined);
});

test("create: gasless, referral ID and the SAME markup on createSwap; deposit address, exact amount and token shown once checked", async () => {
  const { client, calls } = mockClient(); const inv = INV();
  const r = await sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "lightning", invoice: inv, confirm: true });
  assert.equal(calls.createSwap.length, 1); const c = calls.createSwap[0];
  assert.equal(c.gasless, true); assert.equal(c.userAddress, undefined); assert.equal(c.referralCode, SWAP_REFERRAL_ID); assert.equal(c.extraFees, SWAP_MARKUP_BPS);
  assert.deepEqual(c.source, SWAP_TARGETS.usdc); assert.equal(c.target.chain, "Lightning"); assert.equal(c.targetAddress, inv); assert.equal(c.sourceAmount, undefined);
  assert.equal(calls.getQuote[0].referralCode, SWAP_REFERRAL_ID); assert.equal(calls.getQuote[0].extraFees, c.extraFees);
  assert.equal(r.swap, "created"); assert.equal(r.deposit.address, DEP); assert.equal(r.deposit.amount, "1.5"); assert.equal(r.deposit.token, "USDC"); assert.equal(r.deposit.contract, USDC);
  assert.equal(r.deposit.chainId, 42161); assert.match(r.deposit.howToDeposit, /exactly 1\.5 USDC .* ONE transfer\. No ETH needed/);
  assert.equal(calls.fund.length, 0, "nothing is funded before the deposit");
  // amount mode passes the exact token units
  const m = mockClient(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdt0", to: "arkade", amount: "1.5", address: ARK, confirm: true });
  assert.equal(m.calls.createSwap[0].sourceAmount, "1500000"); assert.equal(m.calls.createSwap[0].targetAddress, ARK); assert.equal(m.calls.createSwap[0].gasless, true);
});

test("create: Satora's swap is checked before any deposit address is shown (chain, token, amount, target, status, depositor)", async () => {
  const inv = INV();
  const cases = [
    [{ status: "clientfunded" }, /status clientfunded/], [{ gasless: false }, /not a gasless swap/], [{ evm_chain_id: 1 }, /chain 1/],
    [{ source_token: { chain: "42161", token_id: SWAP_TARGETS.usdt0.tokenId } }, /token .* is not USDC/], [{ client_evm_address: "0x" + "cd".repeat(20) }, /not this Mark home's own/],
    [{ source_amount: "1600000" }, /more than 1% above the quote/], [{ client_lightning_invoice: makeInvoice({ sats: 2420 }) }, /not the one you gave/],
    [{ target_token: { chain: "Arkade", token_id: "btc" } }, /payout chain Arkade/], [{ target_amount: "0" }, /not a positive amount/], [{ id: undefined }, /no swap id/],
  ];
  for (const [tamper, why] of cases) {
    const { client, calls } = mockClient({ tamper });
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "lightning", invoice: inv, confirm: true }), (e) => e.code === "SWAP_FAILED" && why.test(e.message) && /Do NOT deposit/.test(e.message), JSON.stringify(tamper));
    assert.equal(calls.fund.length, 0);
  }
  // amount mode (Ark payout): exact units, payout not far below the quote
  for (const [tamper, why] of [[{ source_amount: "1500001" }, /deposit amount 1\.500001 USDC is not 1\.5/], [{ target_amount: "2000" }, /more than 1% below the quote/]]) {
    const { client } = mockClient({ tamper });
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "arkade", amount: "1.5", address: ARK, confirm: true }), (e) => e.code === "SWAP_FAILED" && why.test(e.message), JSON.stringify(tamper));
  }
  // an invoice with the same sats but not the one given (e.g. someone else's) is refused
  { const { client } = mockClient({ tamper: { client_lightning_invoice: makeInvoice({ sats: 2420 }) } });
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true }), (e) => e.code === "SWAP_FAILED" && /not the one you gave/.test(e.message)); }
  // Ark payout: the exact address, on the swap's Arkade server
  for (const [tamper, why] of [[{ target_arkade_address: payoutArk(8, "ark") }, /payout address/], [{ arkade_server_pk: "02" + "77".repeat(32) }, /different Ark server/]]) {
    const { client } = mockClient({ tamper });
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "arkade", amount: "1.5", address: ARK, confirm: true }), (e) => e.code === "SWAP_FAILED" && why.test(e.message), JSON.stringify(tamper));
  }
});

test("create: bad targets are refused before Satora is asked (wrong network invoice, amountless, address types, --sats)", async () => {
  const { client, calls } = mockClient(); const c = ctxWith(provider(client));
  const run = (i) => sw.swapRun(c, { from: "usdc", confirm: true, ...i });
  await assert.rejects(run({ to: "lightning", invoice: makeInvoice({ sats: 2420, network: "testnet" }) }), (e) => e.code === "BAD_INVOICE");
  await assert.rejects(run({ to: "lightning", invoice: makeInvoice({}) }), (e) => e.code === "AMOUNTLESS_INVOICE_UNSUPPORTED");
  await assert.rejects(run({ to: "lightning", invoice: makeInvoice({ sats: 2420, expiry: 300 }) }), (e) => e.code === "INVOICE_EXPIRED");
  await assert.rejects(run({ to: "lightning", address: "me@example.com", amount: "1" }), (e) => e.code === "USAGE" && /not supported/.test(e.message));
  await assert.rejects(run({ to: "lightning", amount: "1" }), (e) => e.code === "USAGE" && /--invoice/.test(e.message));
  await assert.rejects(run({ to: "lightning", invoice: INV(), amount: "1" }), (e) => e.code === "USAGE");
  await assert.rejects(run({ to: "arkade", address: "me@example.com", amount: "1" }), (e) => e.code === "BAD_DEST");
  await assert.rejects(run({ to: "arkade", address: payoutArk(7, "tark"), amount: "1" }), (e) => e.code === "BAD_DEST");
  await assert.rejects(run({ to: "lightning", invoice: INV(), sats: 1000 }), (e) => e.code === "USAGE" && /--sats is for swaps from BTC/.test(e.message));
  await assert.rejects(sw.swapRun(c, { from: "lightning", to: "usdc", sats: 1000, address: ME, amount: "1" }), (e) => e.code === "USAGE");
  await assert.rejects(sw.swapRun(ctxWith(provider(client), "mutinynet"), { from: "usdc", to: "lightning", invoice: INV() }), (e) => e.code === "SWAP_UNSUPPORTED_NETWORK");
  assert.equal(calls.getQuote.length + calls.createSwap.length, 0);
});

test("create: the deposit address already holds the amount -> send NOTHING; another swap waiting for its deposit blocks a new one", async () => {
  let { client, calls } = mockClient();
  const r = await sw.swapRun(ctxWith(provider(client, { balances: [2_000_000n] })), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  assert.match(r.deposit.howToDeposit, /send NOTHING/); assert.equal(r.deposit.send, undefined); assert.equal(r.deposit.alreadyThere, "2");
  const part = await sw.swapRun(ctxWith(provider(mockClient().client, { balances: [500_000n] })), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  assert.equal(part.deposit.send, "1"); assert.equal(part.deposit.alreadyThere, "0.5");
  // one open deposit at a time (all swaps from a stablecoin in a Mark home share the address)
  ({ client, calls } = mockClient({ others: [{ swapId: "old-1", response: { id: "old-1", status: "pending", gasless: true, client_evm_address: DEP, direction: "evm_to_lightning", source_token: { token_id: USDC } } }] }));
  client.getSwap = async (id) => ({ id, status: "pending", gasless: true, client_evm_address: DEP, direction: "evm_to_lightning", source_token: { token_id: USDC } });
  // old-1 was refused at create (never shown, no record): it does not block; once shown (recorded) it does
  const pv = provider(client); let created = 0; const cr = pv.createReverse.bind(pv); pv.createReverse = async (x) => { created++; throw new Error("stop here"); };
  await assert.rejects(sw.swapRun(ctxWith(pv), { from: "usdc", to: "lightning", invoice: INV(), confirm: true }), /stop here/); assert.equal(created, 1); void cr;
  provider(client).pinReverse("old-1", { invoice: INV(), depositAddress: DEP, tokenContract: USDC, sourceUnits: "1500000" });
  await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true }), (e) => e.code === "SWAP_OPEN_DEPOSIT" && /old-1/.test(e.message));
  assert.equal(calls.createSwap.length, 0);
});

test("gasless flow (--wait): watch the deposit, fund ONCE when it is there, then wait for the Lightning payout", async () => {
  const { client, calls } = mockClient({ statuses: ["pending", "pending", "pending", "pending", "clientfunded", "serverfunded", "serverredeemed"] });
  const progress = [];
  const r = await sw.swapRun(ctxWith(provider(client, { balances: [0n, 0n, 0n, 1_500_000n, 1_500_000n, 0n] })), { from: "usdc", to: "lightning", invoice: INV(), confirm: true, wait: true, pollMs: 1, onProgress: (x) => progress.push(x) });
  assert.equal(progress.length, 1); assert.equal(progress[0].deposit.address, DEP);
  assert.equal(calls.fund.length, 1, "funded exactly once"); assert.equal(r.swap, "done"); assert.equal(r.status, "serverredeemed"); assert.match(r.note, /Lightning/);
});

test("fund: never twice. No deposit -> no signing; concurrent calls share one; a submitted funding is not signed again; a clear refusal may retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-rev-"));
  const { client, calls } = mockClient(); homes.set(client, dir);
  await sw.swapRun(ctxWith(provider(client, { balances: [0n], dir })), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  // no deposit yet
  let p = provider(client, { balances: [0n], dir });
  let r = await sw.swapFund(ctxWith(p), "rv-1"); assert.equal(r.funded, false); assert.match(r.note, /No deposit seen/); assert.equal(calls.fund.length, 0);
  // partial: only the missing part, never "send it again"
  r = await sw.swapFund(ctxWith(provider(client, { balances: [400_000n], dir })), "rv-1"); assert.match(r.note, /only the missing 1\.1 completes it \(do NOT resend the full amount\)/);
  // deposit there: two concurrent calls -> one relay call
  p = provider(client, { balances: [1_500_000n], dir });
  const [a, b] = await Promise.all([sw.swapFund(ctxWith(p), "rv-1"), sw.swapFund(ctxWith(p), "rv-1")]);
  assert.equal(calls.fund.length, 1); assert.ok(a.funded && b.funded); assert.match(a.note, /Do NOT send the stablecoins again/);
  // a second process (same Mark home), the relay's lock not yet visible and the deposit still showing: skipped, not signed again
  r = await sw.swapFund(ctxWith(provider(client, { balances: [1_500_000n], dir })), "rv-1"); assert.equal(r.funded, false); assert.match(r.note, /already submitted/); assert.equal(calls.fund.length, 1);
  // status after funds are seen never asks for a deposit
  const st = await sw.swapStatus(ctxWith(provider(client, { balances: [0n], dir })), "rv-1"); assert.match(st.next, /A funding was submitted/); assert.doesNotMatch(st.next, /Waiting for the deposit/);
  // an uncertain failure (network) keeps the record; a clear relay refusal clears it so a retry is allowed
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "mark-rev-")); const u = mockClient({ fundError: "fetch failed" }); homes.set(u.client, d2); await sw.swapRun(ctxWith(provider(u.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  r = await sw.swapFund(ctxWith(provider(u.client, { balances: [1_500_000n], dir: d2 })), "rv-1"); assert.equal(r.fundFailed, true); assert.match(r.note, /may still have submitted/);
  r = await sw.swapFund(ctxWith(provider(u.client, { balances: [1_500_000n], dir: d2 })), "rv-1"); assert.match(r.note, /already submitted/); assert.equal(u.calls.fund.length, 1);
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "mark-rev-")); const k = mockClient({ fundError: "Gasless fund relay failed: 400 insufficient balance" }); homes.set(k.client, d3); await sw.swapRun(ctxWith(provider(k.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  r = await sw.swapFund(ctxWith(provider(k.client, { balances: [1_500_000n], dir: d3 })), "rv-1"); assert.match(r.note, /refused the funding; nothing was locked/);
  await sw.swapFund(ctxWith(provider(k.client, { balances: [1_500_000n], dir: d3 })), "rv-1"); assert.equal(k.calls.fund.length, 2);
  assert.ok(!fs.readFileSync(path.join(dir, "evm-funding.json"), "utf8").includes("0x11"), "no key material in the funding record");
});

test("fund: already past funding or done -> no signing", async () => {
  const { client, calls } = mockClient({ statuses: ["clientfunded"] });
  await sw.swapRun(ctxWith(provider(client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const r = await sw.swapFund(ctxWith(provider(client, { balances: [1_500_000n] })), "rv-1");
  assert.equal(r.funded, false); assert.match(r.note, /Already past funding \(clientfunded\)/); assert.match(r.note, /Do NOT send the stablecoins again/); assert.equal(calls.fund.length, 0);
  const d = mockClient({ statuses: ["serverredeemed"] }); await sw.swapRun(ctxWith(provider(d.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const x = await sw.swapFund(ctxWith(provider(d.client, { balances: [1_500_000n] })), "rv-1"); assert.equal(x.swap, "done"); assert.equal(d.calls.fund.length, 0);
});

test("Ark payout: claimed to the user's Ark address once Satora funds it", async () => {
  const { client, calls } = mockClient({ statuses: ["pending", "pending", "clientfunded", "serverfunded", "clientredeemed"] });
  const r = await sw.swapRun(ctxWith(provider(client, { balances: [1_500_000n] })), { from: "usdc", to: "arkade", amount: "1.5", address: ARK, confirm: true, wait: true, pollMs: 1, onProgress: () => {} });
  assert.equal(calls.fund.length, 1); assert.equal(calls.claimArkade.length, 1); assert.equal(calls.claimArkade[0].destinationAddress, ARK); assert.equal(r.swap, "done");
});

test("recovery: refund (collaborative, else sponsored timelock) back to the deposit address; recover sends it on, needing a little ETH", async () => {
  let m = mockClient({ statuses: ["pending", "clientfundedserverrefunded"] });
  await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const st = await sw.swapStatus(ctxWith(provider(m.client)), "rv-1"); assert.match(st.next, /swap refund rv-1 .*swap recover rv-1/);
  let r = await sw.swapRefund(ctxWith(provider(m.client)), "rv-1"); assert.equal(r.refunded, true); assert.equal(r.how, "collaborative (gasless)"); assert.equal(m.calls.sponsored.length, 0);
  await assert.rejects(sw.swapRefund(ctxWith(provider(m.client)), "rv-1", "0xabc"), (e) => e.code === "USAGE" && /no --to/.test(e.message));
  m = mockClient({ statuses: ["pending", "clientfunded"], collabError: "server may still fund" });
  await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  r = await sw.swapRefund(ctxWith(provider(m.client)), "rv-1"); assert.equal(r.how, "timelock (sponsored, gasless)"); assert.equal(m.calls.collab.length, 1); assert.equal(m.calls.sponsored.length, 1);
  // recover: no ETH for gas -> says how much, moves nothing; with ETH -> sweeps to the given address
  m = mockClient({ statuses: ["pending", "expired"] });
  await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  r = await sw.swapRecover(ctxWith(provider(m.client, { balances: [1_500_000n], eth: 0n })), "rv-1", ME);
  assert.equal(r.recovered, false); assert.match(r.note, /send about 0\.0000048 ETH \(Arbitrum One\) to 0xabab/); assert.equal(m.calls.recover.length, 0);
  r = await sw.swapRecover(ctxWith(provider(m.client, { balances: [1_500_000n], eth: 10n ** 15n })), "rv-1", ME);
  assert.equal(r.recovered, true); assert.equal(r.amount, "1.5"); assert.equal(m.calls.recover.length, 1); assert.equal(m.calls.recover[0].to, ME); assert.equal(m.calls.recover[0].signer.fake, true);
  assert.equal(JSON.stringify(r).includes("11".repeat(32)), false, "the depositor key is never in the output");
  r = await sw.swapRecover(ctxWith(provider(m.client, { balances: [0n], eth: 10n ** 15n })), "rv-1", ME); assert.equal(r.recovered, false); assert.match(r.note, /holds no USDC/);
  await assert.rejects(sw.swapRecover(ctxWith(provider(m.client)), "rv-1", "0x123"), (e) => e.code === "BAD_DEST" && /--to/.test(e.message));
});

test("CLI: mark swap from a stablecoin, usage checks before any key or network access", () => {
  const chk = (argv) => { const { pos, f } = parseArgs(argv); return checkSwapArgs(pos[1], pos[2], f); };
  assert.equal(chk(["swap", "--from", "usdc", "--to", "lightning", "--invoice", "lnbc1x", "--yes", "--wait"]), null);
  assert.equal(chk(["swap", "--from", "usdt0", "--to", "arkade", "--address", "ark1x", "--amount", "1.5", "--yes"]), null);
  assert.equal(chk(["swap", "quote", "--from", "usdc", "--amount", "2"]), null);
  assert.equal(chk(["swap", "fund", "rv-1", "--wait", "--timeout", "60"]), null); assert.equal(chk(["swap", "recover", "rv-1", "--to", ME]), null);
  assert.match(chk(["swap", "--from", "usdc", "--to", "usdt0", "--amount", "1"]).message, /--to must be lightning or arkade/);
  assert.match(chk(["swap", "--from", "usdc", "--sats", "1000"]).message, /--sats is for swaps from BTC/);
  assert.match(chk(["swap", "--from", "usdc", "--invoice", "lnbc1x", "--amount", "1"]).message, /--invoice fixes the payout/);
  assert.match(chk(["swap", "--from", "usdc", "--to", "arkade", "--invoice", "lnbc1x"]).message, /--invoice is only for --to lightning/);
  assert.match(chk(["swap", "--from", "usdc", "--amount", "1"]).message, /--invoice/);
  assert.match(chk(["swap", "--from", "usdc", "--to", "arkade", "--amount", "1"]).message, /--address/);
  assert.match(chk(["swap", "--from", "usdc", "--to", "lightning", "--address", "a@b.co", "--amount", "1"]).message, /not supported/);
  assert.match(chk(["swap", "--from", "usdc", "--to", "arkade", "--amount", "1,5", "--address", "ark1x"]).message, /token amount/);
  assert.match(chk(["swap", "--sats", "1000", "--address", ME, "--amount", "1"]).message, /--amount is only for swaps from a stablecoin/);
  assert.match(chk(["swap", "--sats", "1000", "--address", ME, "--to", "lightning"]).message, /needs --from usdc or usdt0/);
  assert.match(chk(["swap", "recover", "rv-1"]).message, /--to/); assert.match(chk(["swap", "fund"]).message, /swap id required/);
  assert.match(chk(["swap", "fund", "rv-1", "--amount", "1"]).message, /only for mark swap and mark swap quote/);
});

test("MCP: the reverse tools are listed; create needs confirm, fund / recover / refund cover swaps from a stablecoin", async () => {
  tmpHome(); const CLI = new URL("../dist/src/cli.js", import.meta.url).pathname;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
  const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--network", "mutinynet", "--escrow-url", "http://127.0.0.1:9"], env, stderr: "ignore" });
  const cl = new Client({ name: "swap-rev-test", version: "0" }); await cl.connect(t);
  try {
    const tools = Object.fromEntries((await cl.listTools()).tools.map((x) => [x.name, x]));
    for (const n of ["swap_to_btc_quote", "swap_to_btc_create", "swap_fund", "swap_recover"]) assert.ok(tools[n], n);
    assert.deepEqual(Object.keys(tools.swap_to_btc_create.inputSchema.properties).sort(), ["address", "amount", "confirm", "from", "invoice", "to"]);
    assert.match(tools.swap_to_btc_create.inputSchema.properties.confirm.description, /must be true to create/); assert.match(tools.swap_to_btc_create.description, /Gasless/);
    assert.deepEqual(tools.swap_to_btc_create.inputSchema.properties.from.enum, Object.keys(SWAP_TARGETS));
    assert.deepEqual(tools.swap_recover.inputSchema.required.sort(), ["id", "to"]); assert.deepEqual(tools.swap_refund.inputSchema.required, ["id"]);
    // without confirm nothing is created; mutinynet has no stablecoin routes, so it stops before Satora
    const r = JSON.parse((await cl.callTool({ name: "swap_to_btc_create", arguments: { from: "usdc", to: "lightning", invoice: "lnbc1x" } })).content[0].text);
    assert.equal(r.error?.code ?? r.code, "SWAP_UNSUPPORTED_NETWORK");
  } finally { await cl.close(); }
});

test("deposit lock: two providers (two processes) on one Mark home: one create, one funding; recover waits for the lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-lock-"));
  // shared storage: the second create must see the first swap as open
  const m = mockClient(); const slow = m.client.createSwap; m.client.createSwap = async (p) => { await new Promise((r) => setTimeout(r, 30)); return slow(p); };
  const A = provider(m.client, { dir }), B = provider(m.client, { dir });
  const res = await Promise.allSettled([sw.swapRun(ctxWith(A), { from: "usdc", to: "lightning", invoice: INV(), confirm: true }), sw.swapRun(ctxWith(B), { from: "usdc", to: "lightning", invoice: INV(), confirm: true })]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1); assert.equal(res.find((r) => r.status === "rejected").reason.code, "SWAP_OPEN_DEPOSIT");
  assert.equal(m.calls.createSwap.length, 1); assert.ok(!fs.existsSync(path.join(dir, "evm-deposit.lock")), "lock released");
  // two independent funders: exactly one relay call
  const slowFund = m.client.fundSwapGasless; m.client.fundSwapGasless = async (id) => { await new Promise((r) => setTimeout(r, 30)); return slowFund(id); };
  const F1 = provider(m.client, { dir, balances: [1_500_000n] }), F2 = provider(m.client, { dir, balances: [1_500_000n] });
  const [a, b] = await Promise.all([F1.fundReverse("rv-1"), F2.fundReverse("rv-1")]);
  assert.equal(m.calls.fund.length, 1); assert.ok([a, b].some((x) => x.success) && [a, b].some((x) => x.skipped));
  // the provider re-checks under the lock: no deposit -> no signing even if called directly
  const n = mockClient(); await sw.swapRun(ctxWith(provider(n.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const r = await provider(n.client, { balances: [1_000_000n] }).fundReverse("rv-1"); assert.match(r.skipped, /holds 1000000 of the 1500000/); assert.equal(n.calls.fund.length, 0);
  // a stale lock (dead process) is taken over
  fs.writeFileSync(path.join(dir, "evm-deposit.lock"), "999999"); const old = (Date.now() - 6 * 60 * 1000) / 1000; fs.utimesSync(path.join(dir, "evm-deposit.lock"), old, old);
  assert.equal(await A.exclusive(async () => 7), 7);
});

test("refund only while the locked deposit is stuck or the swap ended; claim --wait on a swap from a stablecoin uses the reverse path", async () => {
  for (const st of ["serverfunded", "clientredeeming", "clientredeemed"]) {
    const m = mockClient({ statuses: [st] }); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "arkade", amount: "1.5", address: ARK, confirm: true });
    const r = await sw.swapRefund(ctxWith(provider(m.client)), "rv-1").catch((e) => e);
    assert.ok(r.refunded === false || r.code === "SWAP_DONE", st); assert.equal(m.calls.collab.length + m.calls.sponsored.length, 0, st);
  }
  const m = mockClient({ statuses: ["serverfunded", "serverfunded", "clientredeemed"] }); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "arkade", amount: "1.5", address: ARK, confirm: true });
  let fails = 1; const get = m.client.getSwap; m.client.getSwap = async (id) => { if (fails-- > 0) throw new Error("satora down"); return get(id); };
  const r = await sw.swapClaim(ctxWith(provider(m.client)), "rv-1", { wait: true, pollMs: 1 });
  assert.equal(r.swap, "done"); assert.equal(m.calls.claimArkade.length, 1); assert.equal(m.calls.claimArkade[0].destinationAddress, ARK);
});

test("later reads are checked against what create confirmed: a changed Ark payout, a foreign deposit address, a non-local swap, a funding racing recover", async () => {
  // Ark payout address swapped by the server after create -> claim refused, nothing claimed, the pinned address is the only one used
  let m = mockClient({ statuses: ["serverfunded"] }); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "arkade", amount: "1.5", address: ARK, confirm: true });
  m.client.getSwap = async (id) => ({ ...m.stored[id].response, status: "serverfunded", target_arkade_address: payoutArk(8, "ark") });
  let e = await sw.swapClaim(ctxWith(provider(m.client)), "rv-1", {}).catch((x) => x); assert.equal(e.code, "SWAP_FAILED"); assert.match(e.message, /Do NOT deposit/);
  assert.equal(m.calls.claimArkade.length, 0);
  // deposit address no longer this home's -> status and fund refuse, never show it, never fund
  m = mockClient(); const inv = INV(); const c = await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: inv, confirm: true });
  const evil = "0x" + "cd".repeat(20); m.stored["rv-1"].response.client_evm_address = evil;
  e = await sw.swapStatus(ctxWith(provider(m.client)), "rv-1").catch((x) => x); assert.equal(e.code, "SWAP_FAILED"); assert.ok(!JSON.stringify(e).includes("pay " + evil));
  e = await sw.swapFund(ctxWith(provider(m.client, { balances: [1500000n] })), "rv-1", {}).catch((x) => x); assert.equal(e.code, "SWAP_FAILED"); assert.equal(m.calls.fund.length, 0);
  // deposit amount changed after create -> refused
  m.stored["rv-1"].response.client_evm_address = DEP; m.stored["rv-1"].response.source_amount = "2500000";
  e = await sw.swapFund(ctxWith(provider(m.client, { balances: [2500000n] })), "rv-1", {}).catch((x) => x); assert.equal(e.code, "SWAP_FAILED"); assert.equal(m.calls.fund.length, 0);
  // a swap this home did not create: status shows no deposit instructions; fund refuses
  m = mockClient({ existing: { direction: "evm_to_lightning", gasless: true, client_evm_address: DEP, source_amount: "1500000", source_token: { chain: "Arbitrum", token_id: USDC }, evm_chain_id: 42161, client_lightning_invoice: inv, target_amount: "2420" } });
  m.client.getStoredSwap = async () => null;
  const st = await sw.swapStatus(ctxWith(provider(m.client)), "rv-9"); assert.match(st.next, /did not create this swap/); assert.ok(!/send|deposit exactly/i.test(st.next.replace("no deposit instructions", "")));
  e = await sw.swapFund(ctxWith(provider(m.client, { balances: [1500000n] })), "rv-9", {}).catch((x) => x); assert.equal(e.code, "SWAP_NOT_LOCAL"); assert.equal(m.calls.fund.length, 0);
  // recover re-reads under the lock: a funding submitted just before the sweep takes the lock wins, nothing is swept
  m = mockClient(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const p = provider(m.client, { balances: [1500000n], eth: 10n ** 15n }); const ex = p.exclusive.bind(p);
  p.exclusive = (f) => ex(async () => { p.fundAttemptedAt = () => Date.now(); return f(); });
  e = await sw.swapRecover(ctxWith(p), "rv-1", ME).catch((x) => x); assert.equal(e.code, "SWAP_FUNDING"); assert.equal(m.calls.recover.length, 0);
  void c;
});

test("fund refuses without signing: invoice near expiry, no create record; a used invoice and a wrong direction are refused at create", async () => {
  // invoice valid at create (11 min left), 7 minutes later only 4 left: fund and fund --wait sign nothing and point to recover
  let m = mockClient(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: makeInvoice({ sats: 2420, expiry: 660 }), confirm: true });
  const now = Date.now; Date.now = () => now() + 7 * 60 * 1000;
  try {
    let r = await sw.swapFund(ctxWith(provider(m.client, { balances: [1_500_000n] })), "rv-1");
    assert.equal(r.funded, false); assert.match(r.message, /expires in \d+ s/); assert.match(r.note, /Nothing was signed .*swap recover rv-1/); assert.equal(m.calls.fund.length, 0);
    r = await sw.swapFund(ctxWith(provider(m.client, { balances: [1_500_000n] })), "rv-1", { wait: true, pollMs: 1, timeoutSec: 5 });
    assert.equal(r.funded, false); assert.equal(m.calls.fund.length, 0);
  } finally { Date.now = now; }
  // the create record is missing (another home's files, or lost): no deposit instructions, no funding, recover still possible
  m = mockClient(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "mark-rev-"));
  const st = await sw.swapStatus(ctxWith(provider(m.client, { dir: fresh })), "rv-1"); assert.match(st.next, /no record .* shows no deposit instructions/); assert.ok(!("deposit" in st));
  let e = await sw.swapFund(ctxWith(provider(m.client, { balances: [1_500_000n], dir: fresh })), "rv-1").catch((x) => x); assert.equal(e.code, "SWAP_FAILED"); assert.equal(m.calls.fund.length, 0);
  const rc = await sw.swapRecover(ctxWith(provider(m.client, { balances: [1_500_000n], eth: 10n ** 15n, dir: fresh })), "rv-1", ME); assert.equal(rc.recovered, true);
  // a paid invoice cannot be paid again: reusing one in this home is refused before anything is created
  m = mockClient({ statuses: ["serverredeemed"] }); const inv = INV(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: inv, confirm: true });
  e = await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: inv, confirm: true }).catch((x) => x);
  assert.equal(e.code, "BAD_INVOICE"); assert.match(e.message, /already used for swap rv-1/); assert.equal(m.calls.createSwap.length, 1);
  // wrong direction in Satora's answer -> no deposit address shown
  m = mockClient({ tamper: { direction: "lightning_to_evm" } });
  e = await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true }).catch((x) => x);
  assert.equal(e.code, "SWAP_FAILED"); assert.match(e.message, /direction/); assert.ok(!JSON.stringify(e).includes(DEP));
});

test("later reads fail closed: a dropped invoice or a switch to Ark is refused; status for an unvouched swap carries no deposit fields", async () => {
  for (const mutate of [(r) => { delete r.client_lightning_invoice; }, (r) => { r.direction = "evm_to_arkade"; r.target_token = { chain: "Arkade", token_id: "btc" }; r.target_arkade_address = payoutArk(8, "ark"); delete r.client_lightning_invoice; }]) {
    const m = mockClient(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
    mutate(m.stored["rv-1"].response);
    const e = await sw.swapFund(ctxWith(provider(m.client, { balances: [1_500_000n] })), "rv-1", { wait: true, pollMs: 1, timeoutSec: 2 }).catch((x) => x);
    assert.equal(e.code, "SWAP_FAILED"); assert.equal(m.calls.fund.length, 0);
  }
  const m = mockClient(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const st = await sw.swapStatus(ctxWith(provider(m.client, { dir: fs.mkdtempSync(path.join(os.tmpdir(), "mark-rev-")) })), "rv-1");
  for (const k of ["depositAddress", "sourceUnits", "tokenContract", "deposit", "invoice"]) assert.ok(!(k in st), k);
  assert.ok(!JSON.stringify(st).includes(DEP));
});

test("create needs the exact direction and a payout covering the invoice; invoice reuse ignores case", async () => {
  for (const tamper of [{ direction: undefined }, { target_amount: "2000" }]) {
    const m = mockClient({ tamper }); const e = await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true }).catch((x) => x);
    assert.equal(e.code, "SWAP_FAILED", JSON.stringify(tamper)); assert.ok(!JSON.stringify(e).includes(DEP));
  }
  const m = mockClient({ statuses: ["serverredeemed"] }); const inv = INV(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: inv, confirm: true });
  const e = await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: "lightning:" + inv.toUpperCase(), confirm: true }).catch((x) => x);
  assert.equal(e.code, "BAD_INVOICE"); assert.equal(m.calls.createSwap.length, 1);
});

test("two creates racing in one Mark home (two processes): the first is checked and recorded under the lock, so the second never creates", async () => {
  const m = mockClient(); const inv = INV();
  const [a, b] = await Promise.allSettled([provider(m.client), provider(m.client)].map((p) => sw.swapRun(ctxWith(p), { from: "usdc", to: "lightning", invoice: inv, confirm: true })));
  const ok = [a, b].filter((r) => r.status === "fulfilled"); const bad = [a, b].filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1); assert.equal(bad.length, 1); assert.ok(["SWAP_OPEN_DEPOSIT", "BAD_INVOICE"].includes(bad[0].reason.code), bad[0].reason.code);
  assert.equal(m.calls.createSwap.length, 1);
});

test("claim --wait never funds: a pending swap is handed back with how to fund it", async () => {
  const m = mockClient(); await sw.swapRun(ctxWith(provider(m.client)), { from: "usdc", to: "lightning", invoice: INV(), confirm: true });
  const r = await sw.swapClaim(ctxWith(provider(m.client, { balances: [1_500_000n] })), "rv-1", { wait: true, pollMs: 1 });
  assert.equal(r.funded, false); assert.match(r.note, /claim never funds .*swap fund rv-1 --wait/); assert.equal(m.calls.fund.length, 0);
});
