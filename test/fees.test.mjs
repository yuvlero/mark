// Mark-side fee safety: exact output verification against the deal's PUBLISHED fee terms, fee terms in termsHash, limits, AMOUNT_TOO_SMALL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { Transaction } from "@scure/btc-signer"; import { base64 } from "@scure/base"; import { ArkAddress } from "@arkade-os/sdk";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { computeFees } from "../dist/src/core/fees.js";
import { termsHash, termsDocument } from "../dist/src/core/terms.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";

const OTHER = "11".repeat(32), URL_ = "http://escrow.test", FEE = arkAddr(9), DEST = arkAddr(7);
const TERMS = { v: 1, feeBps: 100, disputeFeeBps: 500, freeBelowSats: 1000, dustSats: 330, dustBumpMaxBps: 200, address: FEE };
/** PSBT with the given outputs plus a zero-value P2A anchor (like a real Ark tx). */
function psbt(outs) {
  const t = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  t.addInput({ txid: new Uint8Array(32).fill(1), index: 0, witnessUtxo: { script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(9)]), amount: BigInt(outs.reduce((a, o) => a + o[1], 0)) } });
  for (const [addr, sats] of outs) t.addOutput({ script: ArkAddress.decode(addr).pkScript, amount: BigInt(sats) });
  t.addOutput({ script: new Uint8Array([0x51, 0x02, 0x4e, 0x73]), amount: 0n });
  return base64.encode(t.toPSBT());
}
async function setup(arkTx, o = {}) {
  tmpHome(); await uc.init("mutinynet"); let c0; let signed = false;
  const amount = o.amount ?? 50000;
  const e = () => ({ id: "e1", state: "funded", amountSats: amount, deadline: new Date(Date.now() + 3600e3).toISOString(), address: arkAddr(5), buyerPubkey: c0.pubkey, sellerPubkey: OTHER, arbiterPubkey: "22".repeat(32),
    funding: { outpoint: "x:0", amount }, fees: o.fees === undefined ? TERMS : o.fees, ...(o.ruled ? { dispute: { by: "seller" }, ruling: { outcome: "release" } } : {}), proposals: [{ id: "p1", kind: "release", dest: DEST, signers: ["buyer", "seller"], sigs: ["seller"] }] });
  const f = mockFetch({ "GET /escrows/e1": async () => [200, e()], "GET /escrows/e1/proposals/p1": async () => [200, { id: "p1", kind: "release", dest: DEST, signers: ["buyer", "seller"], sigs: ["seller"], payout: { type: "ark", address: DEST, sats: 0 }, arkTx, checkpoints: [] }],
    "POST /escrows/e1/proposals/p1/signatures": async () => { signed = true; return [200, { escrow: { ...e(), state: "released" }, proposal: { id: "p1" } }]; } });
  const c = await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => { throw new Error("no swaps"); } }); c0 = c;
  return { c, f, signedFlag: () => signed };
}
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };
/** Mock PSBTs carry no real escrow tapscript: passing every Mark check ends in the signer's own error (no code), never UNSAFE_TX. */
const passesChecks = async (p) => { try { await p; return true; } catch (e) { if (/No taproot scripts signed/.test(e.message) && !e.code) return true; throw e; } };

test("co-sign: exact payee + fee per published terms is signed", async () => {
  const { c, signedFlag } = await setup(psbt([[DEST, 49500], [FEE, 500]]));
  assert.ok(await passesChecks(uc.approve(c, "e1"))); assert.equal(signedFlag(), false);
  const p = (await uc.pending(c, "e1")).proposals[0]; assert.equal(p.txMatchesFeeTerms, true); assert.equal(p.platformFee.feeOutputSats, 500); assert.equal(p.payeeLegSats, 49500);
});
for (const [name, outs, extra] of [
  ["wrong fee amount", [[DEST, 49600], [FEE, 400]]],
  ["fee to another address", [[DEST, 49500], [arkAddr(8), 500]]],
  ["extra output", [[DEST, 49000], [FEE, 500], [arkAddr(8), 500]]],
  ["no fee output (server skipped it, payee overpaid)", [[DEST, 50000]]],
  ["dispute fee missing after a ruling", [[DEST, 49500], [FEE, 500]], { ruled: true }],
]) test(`co-sign refuses: ${name} -> UNSAFE_TX, nothing posted`, async () => {
  const { c, signedFlag } = await setup(psbt(outs), extra);
  assert.equal(await code(uc.approve(c, "e1")), "UNSAFE_TX"); assert.equal(signedFlag(), false);
});
test("ruled dispute: 1% + 5% accepted", async () => {
  const { c, signedFlag } = await setup(psbt([[DEST, 47000], [FEE, 3000]]), { ruled: true });
  assert.ok(await passesChecks(uc.approve(c, "e1")));
});
test("legacy / pre-fee deal: full amount to dest, no fee output", async () => {
  const { c, signedFlag } = await setup(psbt([[DEST, 50000]]), { fees: null }); assert.ok(await passesChecks(uc.approve(c, "e1")));
  const r = await setup(psbt([[DEST, 49500], [FEE, 500]]), { fees: null }); assert.equal(await code(uc.approve(r.c, "e1")), "UNSAFE_TX");
});
test("waived (below dust) fee: single output", async () => {
  const { c, signedFlag } = await setup(psbt([[DEST, 5000]]), { amount: 5000 }); assert.ok(await passesChecks(uc.approve(c, "e1")));
});

const LIMITS = { network: "mutinynet", minDealSats: { lightning: 335, ark: 330, enforced: 335 }, maxDealSats: 5000, freeBelowSats: 1000, dustSats: 330, fees: { enabled: true, source: "server-wallet", address: FEE, feeBps: 100, disputeFeeBps: 500, freeBelowSats: 1000, dustBumpMaxBps: 200, terms: TERMS }, satora: { minSats: 335, maxSats: 1e6, fetchedAt: "x", stale: false } };
async function createCtx(stamp = (b) => TERMS) {
  tmpHome(); await uc.init("mutinynet");
  const f = mockFetch({ "GET /limits": async () => [200, LIMITS], "POST /escrows": async (b) => [201, { ...b, id: "e1", state: "created", address: arkAddr(5), proposals: [], fees: stamp(b) }] });
  return { c: await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => { throw new Error("x"); } }), f };
}
test("create: signs termsHash INCLUDING the published fee terms; shows fee summary", async () => {
  const { c, f } = await createCtx();
  const e = await uc.create(c, { role: "buyer", counterparty: OTHER, sats: 2000, deadline: 3600, terms: { title: "t", description: "d" } });
  const b = f.calls.find((x) => x.key === "POST /escrows").body;
  assert.equal(b.termsHash, termsHash(termsDocument({ title: "t", description: "d" }, { network: "mutinynet", amountSats: 2000, buyerPubkey: c.pubkey, sellerPubkey: OTHER, fees: TERMS })));
  assert.notEqual(b.termsHash, termsHash(termsDocument({ title: "t", description: "d" }, { network: "mutinynet", amountSats: 2000, buyerPubkey: c.pubkey, sellerPubkey: OTHER })));
  assert.equal(e.feeSummary.platformFeePct, 1); assert.equal(e.feeSummary.ifDisputeRuled.reason, "below_dust_waived");
});
test("create: server stamping different fee terms -> FEE_TERMS_MISMATCH", async () => {
  const { c } = await createCtx(() => ({ ...TERMS, feeBps: 300 }));
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: OTHER, sats: 2000, deadline: 3600, terms: { title: "t", description: "d" } })), "FEE_TERMS_MISMATCH");
});
test("create below minimum -> AMOUNT_TOO_SMALL, no POST", async () => {
  const { c, f } = await createCtx();
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: OTHER, sats: 334, deadline: 3600, terms: { title: "t", description: "d" } })), "AMOUNT_TOO_SMALL");
  assert.ok(!f.calls.some((x) => x.key === "POST /escrows"));
});
test("limits passthrough", async () => { const { c } = await createCtx(); const l = await uc.limits(c); assert.equal(l.minDealSats.lightning, 335); assert.equal(l.fees.feeBps, 100); });
test("fee math matches the server table", () => {
  const r = (a, d) => computeFees(TERMS, a, a, d).feeOutputSats;
  assert.deepEqual([r(999, true), r(1000, false), r(1001, true), r(10000, false), r(10000, true), r(100000, false), r(100000, true)], [0, 0, 0, 0, 600, 1000, 6000]);
});
test("fees.ts is byte-identical with the server copy (when checked out side by side)", (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url)); const srv = path.resolve(here, "../../escrow-server/src/lib/fees.ts");
  if (!fs.existsSync(srv)) return t.skip("escrow-server not checked out next to mark");
  assert.equal(fs.readFileSync(path.resolve(here, "../src/core/fees.ts"), "utf8"), fs.readFileSync(srv, "utf8"));
});
