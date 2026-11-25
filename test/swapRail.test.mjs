// `mark swap` Lightning ↔ Arkade: route parsing, fee wording, referral + extraFees on both Satora calls,
// create checks, claim/refund. The Satora SDK is mocked: no network in these tests.
import test from "node:test";
import assert from "node:assert/strict";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { SWAP_REFERRAL_ID, SWAP_MARKUP_BPS, SWAP_FEE_LN_ARKADE_NOTE, SWAP_FEE_ARKADE_LN_NOTE, SWAP_FEE_ALL_ROUTES_NOTE, SWAP_FEE_TOTAL_NOTE, formatRailQuote, splitSwapFees, swapRoute, allSwapRoutes, routeFeeNote, swapFeeSummaryNote, pct } from "../dist/src/swap/stable.js";
import * as sw from "../dist/src/core/swap.js";
import { checkSwapArgs, SWAP_USAGE } from "../dist/src/cliArgs.js";
import fs from "node:fs";
import { payoutArk, tmpHome } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ARK = payoutArk(3, "ark");
const Q_LN_ARK = { exchange_rate: "1.0", network_fee: 1, gasless_network_fee: 0, protocol_fee: 7, protocol_fee_rate: 0.0065, min_amount: 335, max_amount: 1000000,
  source_amount: "1000", target_amount: "1000", net_source_amount: "1000", net_target_amount: "992" };
const Q_ARK_LN = { exchange_rate: "1.0", network_fee: 30, gasless_network_fee: 0, protocol_fee: 7, protocol_fee_rate: 0.008, min_amount: 335, max_amount: 1000000,
  source_amount: "900", target_amount: "863", net_source_amount: "900", net_target_amount: "863" };

function mockClient(o = {}) {
  const calls = { getQuote: [], createSwap: [], claimArkade: [], refund: [], getSwap: [] };
  let statuses = [...(o.statuses ?? ["pending"])];
  const quote = o.quote ?? Q_LN_ARK;
  const client = {
    getQuote: async (p) => { calls.getQuote.push(p); return o.quoteFor?.(p) ?? quote; },
    createSwap: async (p) => {
      calls.createSwap.push(p);
      const src = p.source?.chain, tgt = p.target?.chain;
      const pay = p.sourceAmount ?? (quote.source_amount);
      const invoice = src === "Lightning" ? makeInvoice({ sats: Number(pay) }) : (p.targetAddress ?? makeInvoice({ sats: Number(quote.net_target_amount) }));
      const res = { id: "rail-1", status: "pending", direction: src === "Lightning" ? "lightning_to_arkade" : "arkade_to_lightning",
        source_amount: String(src === "Lightning" ? pay : (quote.net_source_amount ?? quote.source_amount)), target_amount: String(quote.net_target_amount),
        source_token: { chain: src, token_id: "btc" }, target_token: { chain: tgt, token_id: "btc" },
        arkade_server_pk: "5a".repeat(32),
        ...(src === "Lightning" ? { bolt11_invoice: invoice, target_arkade_address: p.targetAddress } : { client_lightning_invoice: invoice, arkade_vhtlc_address: ARK }),
        ...(o.tamper ?? {}) };
      return { response: res };
    },
    getSwap: async (id) => { calls.getSwap.push(id); const s = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { id, status: s, direction: o.direction ?? "lightning_to_arkade", arkade_server_pk: "5a".repeat(32),
        source_amount: "1000", target_amount: "992", bolt11_invoice: makeInvoice({ sats: 1000 }), target_arkade_address: ARK,
        source_token: { chain: "Lightning", token_id: "btc" }, target_token: { chain: "Arkade", token_id: "btc" },
        ...(s === "serverredeemed" || s === "clientredeemed" ? { arkade_claim_txid: "arkclaim1" } : {}), ...(o.get ?? {}) }; },
    getStoredSwap: async () => ({ swapId: "rail-1" }),
    claimArkade: async (id, opts) => { calls.claimArkade.push({ id, ...opts }); return o.claim ?? { success: true, txId: "arkclaim1", message: "ok" }; },
    refundSwap: async (id, opts) => { calls.refund.push({ id, ...opts }); return o.refund ?? { success: true, txId: "arkrefund1" }; },
  };
  return { client, calls };
}
const provider = (client) => new SatoraProvider(client, "https://swap.test", "https://arkade.computer");
const ctxWith = (p, network = "bitcoin") => ({ network, cfg: { arkServerUrl: "https://arkade.computer" }, swaps: async () => p });

test("allSwapRoutes ends with Lightning ↔ Arkade; swapRoute accepts both directions", () => {
  const r = allSwapRoutes();
  assert.equal(r.length, 14);
  assert.deepEqual(r.slice(12), [{ dir: "rail", from: "lightning", to: "arkade" }, { dir: "rail", from: "arkade", to: "lightning" }]);
  assert.deepEqual(swapRoute("lightning", "arkade"), { dir: "rail", from: "lightning", to: "arkade" });
  assert.deepEqual(swapRoute("arkade", "lightning"), { dir: "rail", from: "arkade", to: "lightning" });
});

test("rail fee notes are route-specific and are not ~1%", () => {
  assert.equal(SWAP_FEE_LN_ARKADE_NOTE, "about 0.65% total (Satora ~0.15% + Agent Escrow 0.5%) plus network fee");
  assert.equal(SWAP_FEE_ARKADE_LN_NOTE, "about 0.80% total (Satora ~0.30% + Agent Escrow 0.5%) plus network fee");
  assert.equal(routeFeeNote({ dir: "rail", from: "lightning", to: "arkade" }), SWAP_FEE_LN_ARKADE_NOTE);
  assert.equal(routeFeeNote({ dir: "rail", from: "arkade", to: "lightning" }), SWAP_FEE_ARKADE_LN_NOTE);
  assert.equal(routeFeeNote({ dir: "to_stable", from: "lightning", to: "usdc" }), SWAP_FEE_TOTAL_NOTE);
  assert.match(SWAP_FEE_ALL_ROUTES_NOTE, /Fees depend on the route/);
  assert.ok(SWAP_FEE_ALL_ROUTES_NOTE.includes(SWAP_FEE_TOTAL_NOTE));
  assert.ok(SWAP_FEE_ALL_ROUTES_NOTE.includes(SWAP_FEE_LN_ARKADE_NOTE));
  assert.ok(SWAP_FEE_ALL_ROUTES_NOTE.includes(SWAP_FEE_ARKADE_LN_NOTE));
  assert.match(swapFeeSummaryNote(), /Fees depend on the route/);
  // live quote numbers, never a hard-coded 1%
  const q = formatRailQuote(Q_LN_ARK, { from: "lightning", to: "arkade", bps: SWAP_MARKUP_BPS, sats: 1000 });
  assert.equal(q.fees.totalFeePercent, "0.65%"); assert.equal(q.fees.satoraFeePercent, "0.15%");
  assert.equal(q.fees.agentEscrowMarkup, "0.5%"); assert.equal(q.fees.agentEscrowMarkupBps, 50);
  assert.equal(q.fees.agentEscrowMarkupSats, 5); assert.equal(q.fees.satoraFeeSats, 2);
  assert.equal(q.fees.networkFeeSats, 1); assert.equal(q.fees.totalFeeSats, 8);
  assert.equal(q.payAmountSats, 1000); assert.equal(q.receiveSats, 992);
  assert.equal(q.markupNote, "Total fee: 0.65% (Satora 0.15% + Agent Escrow 0.5%) plus 1 sats network fee. Paid inside the swap; nothing extra to send.");
  const back = formatRailQuote(Q_ARK_LN, { from: "arkade", to: "lightning", bps: SWAP_MARKUP_BPS, sats: 900 });
  assert.equal(back.fees.totalFeePercent, "0.8%"); assert.equal(back.fees.satoraFeePercent, "0.3%");
  assert.equal(back.fees.networkFeeSats, 30); assert.equal(back.receiveSats, 863);
  assert.match(back.markupNote, /Total fee: 0\.8% \(Satora 0\.3% \+ Agent Escrow 0\.5%\) plus 30 sats network fee/);
});

test("satora: Lightning → Arkade getQuote and createSwap carry referral + extraFees and the rail assets", async () => {
  const { client, calls } = mockClient({ quote: Q_LN_ARK }); const p = provider(client);
  const q = await p.quoteRail({ from: "lightning", to: "arkade", sats: 1000, bps: SWAP_MARKUP_BPS });
  assert.equal(q.net_target_amount, "992");
  assert.deepEqual(calls.getQuote[0], { sourceChain: "Lightning", sourceToken: "btc", targetChain: "Arkade", targetToken: "btc", sourceAmount: 1000, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
  const r = await p.createRail({ from: "lightning", to: "arkade", sats: 1000, bps: SWAP_MARKUP_BPS, address: ARK });
  assert.equal(r.id, "rail-1"); assert.equal(r.payoutArkAddress, ARK); assert.match(r.invoice, /^lnbc/);
  assert.deepEqual(calls.createSwap[0], { source: { chain: "Lightning", tokenId: "btc" }, target: { chain: "Arkade", tokenId: "btc" }, sourceAmount: 1000, targetAddress: ARK, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
});

test("satora: Arkade → Lightning quote with an invoice uses lightningDestination and no sourceAmount; create does not send sourceAmount", async () => {
  const inv = makeInvoice({ sats: 863 });
  const { client, calls } = mockClient({ quote: Q_ARK_LN }); const p = provider(client);
  await p.quoteRail({ from: "arkade", to: "lightning", invoice: inv, bps: SWAP_MARKUP_BPS });
  assert.deepEqual(calls.getQuote[0], { sourceChain: "Arkade", sourceToken: "btc", targetChain: "Lightning", targetToken: "btc", lightningDestination: inv, referralCode: SWAP_REFERRAL_ID, extraFees: 50 });
  assert.equal(calls.getQuote[0].sourceAmount, undefined);
  const r = await p.createRail({ from: "arkade", to: "lightning", invoice: inv, bps: SWAP_MARKUP_BPS });
  assert.equal(r.fundArkAddress, ARK); assert.equal(r.invoice, inv);
  assert.equal(calls.createSwap[0].sourceAmount, undefined);
  assert.equal(calls.createSwap[0].targetAddress, inv);
  assert.equal(calls.createSwap[0].referralCode, SWAP_REFERRAL_ID);
  assert.equal(calls.createSwap[0].extraFees, 50);
});

test("mark swap quote: Lightning → Arkade uses live quote fees, not a hard-coded 1%", async () => {
  const { client } = mockClient({ quote: Q_LN_ARK });
  const r = await sw.swapQuote(ctxWith(provider(client)), { from: "lightning", to: "arkade", sats: 1000 });
  assert.equal(r.quote.from, "lightning"); assert.equal(r.quote.to, "arkade");
  assert.equal(r.quote.receiveSats, 992); assert.equal(r.quote.fees.totalFeePercent, "0.65%");
  assert.match(r.quote.markupNote, /Total fee: 0\.65%/);
  assert.match(r.next, /--from lightning --to arkade --sats 1000/);
});

test("mark swap: Lightning → Arkade preview and create (confirm) pay a hold invoice and check the swap before showing it", async () => {
  const { client, calls } = mockClient({ quote: Q_LN_ARK });
  const c = ctxWith(provider(client));
  const prev = await sw.swapRun(c, { from: "lightning", to: "arkade", sats: 1000, address: ARK });
  assert.equal(prev.swap, "preview"); assert.equal(calls.createSwap.length, 0);
  assert.match(prev.notice, /REAL MONEY/); assert.equal(prev.quote.receiveSats, 992);
  const r = await sw.swapRun(c, { from: "lightning", to: "arkade", sats: 1000, address: ARK, confirm: true });
  assert.equal(r.swap, "created"); assert.equal(r.id, "rail-1"); assert.match(r.invoice, /^lnbc10000n|^lnbc10u|^lnbc1000/);
  assert.equal(r.payoutArkAddress, ARK);
  assert.equal(r.expectedReceiveSats, 992); assert.match(r.howToPay, /hold invoice/i);
  assert.equal(calls.getQuote.length, 2); assert.equal(calls.createSwap.length, 1);
  assert.equal(calls.createSwap[0].referralCode, SWAP_REFERRAL_ID); assert.equal(calls.createSwap[0].extraFees, 50);
});

test("mark swap: Lightning → Arkade create is refused if Satora's swap does not match (do not pay)", async () => {
  const { client } = mockClient({ quote: Q_LN_ARK, tamper: { source_amount: "999" } });
  await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "lightning", to: "arkade", sats: 1000, address: ARK, confirm: true }), (e) => e.code === "SWAP_FAILED" && /Do NOT pay/.test(e.message));
});

test("mark swap: Arkade → Lightning preview and create print the VHTLC address to fund, not a second invoice to pay", async () => {
  const inv = makeInvoice({ sats: 863 });
  const { client, calls } = mockClient({ quote: Q_ARK_LN });
  const r = await sw.swapRun(ctxWith(provider(client)), { from: "arkade", to: "lightning", invoice: inv, confirm: true });
  assert.equal(r.swap, "created"); assert.equal(r.arkAddress, ARK); assert.equal(r.amountSats, 900);
  assert.match(r.howToPay, /not Bark/); assert.match(r.howToPay, /ONE payment/);
  assert.match(r.howToPay, /vtxo minimum \(330 sats/);
  assert.equal(calls.createSwap[0].targetAddress, inv); assert.equal(calls.createSwap[0].sourceAmount, undefined);
  assert.equal(calls.createSwap[0].referralCode, SWAP_REFERRAL_ID); assert.equal(calls.createSwap[0].extraFees, 50);
});

test("claim: Lightning → Arkade claims to the payout Ark address; Arkade → Lightning has nothing to claim", async () => {
  const { client, calls } = mockClient({ statuses: ["serverfunded"], direction: "lightning_to_arkade" });
  const r = await sw.swapClaim(ctxWith(provider(client)), "rail-1");
  assert.equal(r.swap, "done"); assert.equal(r.payoutTx, "arkclaim1");
  assert.equal(r.note, "Sats sent to your Ark address.");
  assert.equal(calls.claimArkade[0].id, "rail-1");
  assert.equal(calls.claimArkade[0].destinationAddress, ARK);
  const back = mockClient({ statuses: ["clientfunded"], direction: "arkade_to_lightning", get: { direction: "arkade_to_lightning", arkade_vhtlc_address: ARK, client_lightning_invoice: makeInvoice({ sats: 863 }) } });
  // getRail uses getSwap; force direction on the status read
  back.client.getSwap = async (id) => ({ id, status: "clientfunded", direction: "arkade_to_lightning", arkade_vhtlc_address: ARK, source_amount: "900", target_amount: "863",
    client_lightning_invoice: makeInvoice({ sats: 863 }), source_token: { chain: "Arkade" }, target_token: { chain: "Lightning" } });
  const c = await sw.swapClaim(ctxWith(provider(back.client)), "rail-1");
  assert.equal(c.claimed, false); assert.match(c.note, /nothing to claim/i);
});

test("refund: Lightning → Arkade is refused (hold invoice expires); Arkade → Lightning refunds to --to", async () => {
  const ln = mockClient({ statuses: ["expired"], direction: "lightning_to_arkade" });
  ln.client.getSwap = async (id) => ({ id, status: "expired", direction: "lightning_to_arkade", source_token: { chain: "Lightning" }, target_token: { chain: "Arkade" } });
  await assert.rejects(sw.swapRefund(ctxWith(provider(ln.client)), "rail-1", ARK), (e) => e.code === "USAGE" && /hold invoice simply expires/.test(e.message));
  const ark = mockClient({ direction: "arkade_to_lightning" });
  ark.client.getSwap = async (id) => ({ id, status: "expired", direction: "arkade_to_lightning", arkade_server_pk: "5a".repeat(32), source_token: { chain: "Arkade" }, target_token: { chain: "Lightning" } });
  const r = await sw.swapRefund(ctxWith(provider(ark.client)), "rail-1", ARK);
  assert.equal(r.refunded, true); assert.equal(r.txid, "arkrefund1");
});

test("CLI: rail flags are accepted; invoice + sats together is refused", () => {
  assert.equal(checkSwapArgs("quote", undefined, { from: "lightning", to: "arkade", sats: "1000" }), null);
  assert.equal(checkSwapArgs("create", undefined, { from: "lightning", to: "arkade", sats: "1000", address: ARK }), null);
  assert.equal(checkSwapArgs("quote", undefined, { from: "arkade", to: "lightning", sats: "900" }), null);
  assert.equal(checkSwapArgs("create", undefined, { from: "arkade", to: "lightning", invoice: "lnbc1" }), null);
  assert.match(checkSwapArgs("create", undefined, { from: "arkade", to: "lightning", invoice: "lnbc1", sats: "900" }).message, /do not add --sats/);
  assert.match(checkSwapArgs("create", undefined, { from: "lightning", to: "arkade", sats: "1000" }).message, /--address/);
  assert.match(SWAP_USAGE.quote, /--from lightning --to arkade/);
  assert.match(SWAP_USAGE.create, /--from arkade --to lightning --invoice/);
  assert.match(SWAP_USAGE.routes, /Fees depend on the route/);
});

test("docs/help mention the route-specific totals, not a single 1% for every route", () => {
  assert.ok(SWAP_USAGE.quote.includes(SWAP_FEE_ALL_ROUTES_NOTE) || SWAP_USAGE.routes.includes(SWAP_FEE_ALL_ROUTES_NOTE));
  for (const u of [SWAP_USAGE.quote, SWAP_USAGE.create, SWAP_USAGE.routes]) {
    assert.ok(u.includes(SWAP_FEE_TOTAL_NOTE), "stablecoin 1% wording still present");
    assert.match(u, /0\.65% total/); assert.match(u, /0\.80% total/);
  }
});

test("mark swap: Arkade → Lightning create is refused if the invoice, lock amount or fund address does not match", async () => {
  const inv = makeInvoice({ sats: 863 });
  const other = makeInvoice({ sats: 863 });
  // a different valid Ark address is assigned by Satora (not pinned in advance), so it is accepted if it is on this server;
  // a wrong invoice, a wrong lock amount, or a junk fund address must be refused.
  for (const tamper of [
    { client_lightning_invoice: other },
    { source_amount: "899" },
    { arkade_vhtlc_address: "not-an-ark-address" },
  ]) {
    const { client } = mockClient({ quote: Q_ARK_LN, tamper });
    await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "arkade", to: "lightning", invoice: inv, confirm: true }), (e) => e.code === "SWAP_FAILED" && /Do NOT pay/.test(e.message));
  }
});

test("mark swap: Arkade → Lightning create accepts a lock that matches net_source_amount when it differs from source_amount", async () => {
  const inv = makeInvoice({ sats: 863 });
  // invoice-pinned quotes: source_amount is the invoice, net_source_amount is what the user must send
  const quote = { ...Q_ARK_LN, source_amount: "863", net_source_amount: "876", target_amount: "863", net_target_amount: "863", network_fee: 6 };
  const { client, calls } = mockClient({ quote });
  const prev = await sw.swapRun(ctxWith(provider(client)), { from: "arkade", to: "lightning", invoice: inv });
  assert.equal(prev.swap, "preview");
  assert.equal(prev.quote.payAmountSats, 876);
  assert.equal(prev.quote.receiveSats, 863);
  assert.doesNotMatch(prev.next, /lnbc/i);
  assert.ok(!String(prev.next).includes(inv), "preview next must not leak the bolt11");
  assert.match(prev.next, /--invoice <the same bolt11>/);
  const quoted = await sw.swapQuote(ctxWith(provider(client)), { from: "arkade", to: "lightning", sats: 900 });
  assert.match(quoted.next, /--invoice <bolt11 for the sats you want>/);
  assert.doesNotMatch(quoted.next, /the same bolt11/);
  assert.doesNotMatch(quoted.next, /lnbc/i);
  const r = await sw.swapRun(ctxWith(provider(client)), { from: "arkade", to: "lightning", invoice: inv, confirm: true });
  assert.equal(r.swap, "created");
  assert.equal(r.amountSats, 876);
  assert.equal(calls.createSwap.length, 1);
});

test("mark swap: Arkade → Lightning create is refused if the lock matches source_amount but not net_source_amount", async () => {
  const inv = makeInvoice({ sats: 863 });
  const quote = { ...Q_ARK_LN, source_amount: "863", net_source_amount: "876", target_amount: "863", net_target_amount: "863", network_fee: 6 };
  const { client } = mockClient({ quote, tamper: { source_amount: "863" } });
  await assert.rejects(sw.swapRun(ctxWith(provider(client)), { from: "arkade", to: "lightning", invoice: inv, confirm: true }), (e) => e.code === "SWAP_FAILED" && /Do NOT pay/.test(e.message) && /876/.test(e.message));
});

test("claim --wait: Arkade → Lightning done note says the Lightning invoice was paid, not that sats went to an Ark address", async () => {
  const inv = makeInvoice({ sats: 863 });
  const { client, calls } = mockClient({ statuses: ["serverredeemed"], direction: "arkade_to_lightning" });
  client.getSwap = async (id) => ({ id, status: "serverredeemed", direction: "arkade_to_lightning", arkade_vhtlc_address: ARK,
    source_amount: "876", target_amount: "863", client_lightning_invoice: inv, arkade_claim_txid: "lnpay1",
    source_token: { chain: "Arkade", token_id: "btc" }, target_token: { chain: "Lightning", token_id: "btc" } });
  const r = await sw.swapClaim(ctxWith(provider(client)), "rail-1", { wait: true, pollMs: 1, timeoutSec: 2 });
  assert.equal(r.swap, "done");
  assert.equal(r.payoutTx, "lnpay1");
  assert.equal(r.note, "Lightning invoice paid.");
  assert.equal(calls.claimArkade.length, 0);
});

test("claim --wait from a Mark home without the claim key does not claim; it says to run it from the creating home", async () => {
  const { client, calls } = mockClient({ statuses: ["serverfunded"], direction: "lightning_to_arkade" });
  client.getStoredSwap = async () => null;
  const r = await sw.swapClaim(ctxWith(provider(client)), "rail-1", { wait: true, pollMs: 1, timeoutSec: 1 });
  assert.equal(r.claimed, false);
  assert.equal(calls.claimArkade.length, 0);
  assert.match(r.note, /does not hold the swap's claim key/);
  assert.match(r.note, /Do NOT pay again/);
});

test("docs: README command table lists Lightning ↔ Arkade and the all-routes fee note, not a single 1% for every route", () => {
  const md = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const row = md.split("\n").find((l) => l.includes("`mark swap routes`") && l.includes("| Every route"));
  assert.ok(row, "README has a mark swap routes command-table row");
  assert.match(row, /Lightning ↔ Arkade/);
  assert.match(row, /Fees depend on the route/);
  assert.match(row, /0\.65% total/);
  assert.match(row, /0\.80% total/);
  assert.match(row, /about 1% total/);
  assert.doesNotMatch(row, /plus the total-fee note \(about 1%/);
});

test("MCP: swap_quote and swap_create cover Lightning ↔ Arkade; omitted confirm is a preview (mutinynet has no live Satora path)", async () => {
  tmpHome(); const CLI = new URL("../dist/src/cli.js", import.meta.url).pathname;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
  const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--network", "mutinynet", "--escrow-url", "http://127.0.0.1:9"], env, stderr: "ignore" });
  const cl = new Client({ name: "swap-rail-mcp", version: "0" }); await cl.connect(t);
  try {
    const tools = Object.fromEntries((await cl.listTools()).tools.map((x) => [x.name, x]));
    for (const n of ["swap_quote", "swap_create", "swap_routes"]) assert.ok(tools[n], n);
    assert.match(tools.swap_routes.description, /Fees depend on the route/);
    assert.match(tools.swap_routes.description, /0\.65% total/);
    assert.match(tools.swap_create.description, /Without confirm: preview only/); assert.match(tools.swap_create.description, /With confirm: creates/);
    assert.ok(tools.swap_quote.inputSchema.properties.to.enum.includes("arkade"));
    assert.ok(tools.swap_create.inputSchema.properties.to.enum.includes("arkade"));
    const r = JSON.parse((await cl.callTool({ name: "swap_create", arguments: { from: "lightning", to: "arkade", sats: 1000, address: "ark1x" } })).content[0].text);
    assert.ok(r.error?.code ?? r.code, "omitted confirm must not create a swap");
    assert.notEqual(r.swap, "created");
  } finally { await cl.close(); }
});
