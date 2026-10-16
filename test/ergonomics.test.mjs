// CLI ergonomics (evidence --note alias, accept prints state, usage errors), fee preview, amountless invoices, server error details.
import test from "node:test"; import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { checkEscrowArgs } from "../dist/src/cliArgs.js";
import { feePreview } from "../dist/src/core/fees.js";
import { normalizeTerms, termsDocument, termsHash } from "../dist/src/core/terms.js";
import { parseArgs } from "../dist/src/cliArgs.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";

const URL_ = "http://escrow.test"; const FEE = arkAddr(9);
const other = (() => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; })();
const T2 = { v: 2, freeBelowSats: 3300, flatSats: 330, flatUntilSats: 33000, feeBps: 100, disputeFeeBps: 500, disputeMinSats: 330, dustSats: 330, address: FEE };
const LIMITS = { network: "mutinynet", minDealSats: { lightning: 1000, ark: 330, enforced: 1000 }, maxDealSats: 1000000, freeBelowSats: 3300, dustSats: 330, fees: { enabled: true, source: "server-wallet", address: FEE, feeBps: 100, disputeFeeBps: 500, freeBelowSats: 3300, terms: T2 }, satora: { minSats: 1000, maxSats: 1e6, fetchedAt: "x", stale: false } };
async function ctx(routes) { tmpHome(); await uc.init("mutinynet"); const f = mockFetch(routes); return { c: await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => { throw new Error("swap must not be used"); } }), f }; }
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };
const args = (a) => { const { pos, f } = parseArgs(a); return checkEscrowArgs(pos[1], pos[2], f); };

test("usage errors: unknown subcommand, missing id, missing flags, flag without value, --text/--note conflict", () => {
  assert.match(args(["escrow", "nope"]).message, /unknown escrow subcommand 'nope'.*one of: create/);
  assert.equal(args(["escrow"]).code, "USAGE");
  const m = args(["escrow", "accept"]); assert.equal(m.code, "USAGE"); assert.match(m.message, /escrow id required. usage: mark escrow accept <id>/);
  assert.match(args(["escrow", "create", "--role", "buyer", "--sats", "1200"]).message, /missing --counterparty, --deadline/);
  assert.match(args(["escrow", "create", "--role", "buyer", "--counterparty", "x", "--deadline", "60", "--sats", "12k"]).message, /whole number/);
  assert.match(args(["escrow", "evidence", "e1", "--text"]).message, /--text needs a value/);
  assert.match(args(["escrow", "evidence", "e1"]).message, /--text or --note/);
  assert.match(args(["escrow", "evidence", "e1", "--text", "a", "--note", "b"]).message, /not both/);
  assert.match(args(["escrow", "quote", "e1", "--path", "x"]).message, /release or refund/);
  assert.equal(args(["escrow", "evidence", "e1", "--note", "delivered"]), null);
  assert.equal(args(["escrow", "fund", "e1", "--wait"]), null);
  assert.equal(args(["escrow", "limits", "--sats", "5000"]), null);
});
test("CLI binary: usage error is JSON with code USAGE and exit 1, before any network/keystore", () => {
  tmpHome(); const r = spawnSync(process.execPath, ["dist/src/cli.js", "escrow", "evidence", "e1"], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 1); const j = JSON.parse(r.stdout); assert.equal(j.code, "USAGE"); assert.match(j.details.usage, /--note/);
});
test("evidence: --note works as --text (CLI maps it); empty text refused before HTTP", async () => {
  let got; const d = () => ({ id: "e1", state: "funded", amountSats: 1200, buyerPubkey: c.pubkey, sellerPubkey: other.p, arbiterPubkey: "22".repeat(32), proposals: [], evidence: [] });
  const { c, f } = await ctx({ "GET /escrows/e1": async () => [200, d()], "POST /escrows/e1/evidence": async (b) => { got = b; return [201, { ...d(), evidence: [b] }]; } });
  assert.equal(await code(uc.addEvidence(c, "e1", { text: "  " })), "BAD_EVIDENCE"); assert.equal(f.calls.length, 0);
  const { f: fl } = parseArgs(["--note", "delivered ok"]);
  const r = await uc.addEvidence(c, "e1", { text: fl.text ?? fl.note }); assert.equal(got.text, "delivered ok"); assert.equal(r.state, "funded"); assert.equal(r.evidenceCount, 1);
});
test("accept prints the resulting state + next step", async () => {
  const T = { title: "t", description: "d" }; let d;
  const { c } = await ctx({ "GET /escrows/e1": async () => [200, d], "POST /escrows/e1/accept": async (b) => { d.acceptances.buyer = { sig: b.sig, at: "now" }; return [200, d]; },
    [`GET /reputation/${other.p}`]: async () => [200, { pubkey: other.p, dealsCompleted: 2, satsTransacted: 7000, disputesTotal: 0, disputesWon: 0, disputesLost: 0, firstSeen: "2026-10-01" }] });
  d = { id: "e1", state: "created", amountSats: 1200, buyerPubkey: c.pubkey, sellerPubkey: other.p, arbiterPubkey: "22".repeat(32), proposals: [], terms: T,
    termsHash: termsHash(termsDocument(normalizeTerms(T), { network: "mutinynet", amountSats: 1200, buyerPubkey: c.pubkey, sellerPubkey: other.p })) };
  d.acceptances = { seller: { sig: hex.encode(schnorr.sign(hex.decode(d.termsHash), other.s)), at: "t0" } };
  const r = await uc.accept(c, "e1"); assert.equal(r.state, "created"); assert.equal(r.agreed, true); assert.equal(r.alreadyAccepted, false); assert.match(r.next, /mark escrow fund e1/); assert.match(r.status, /both parties accepted.*not funded yet/);
  assert.equal(r.counterpartyReputation.available, true); assert.equal(r.counterpartyReputation.role, "seller"); assert.equal(r.counterpartyReputation.dealsCompleted, 2); // accepting an invite shows who I deal with
  const again = await uc.accept(c, "e1"); assert.equal(again.alreadyAccepted, true); assert.equal(again.state, "created");
});
test("limits --sats: fee preview (platform, possible dispute, swap estimate, min/max) + schedule examples", async () => {
  const { c, f } = await ctx({ "GET /limits": async () => [200, LIMITS] });
  const l = await uc.limits(c, 50000); assert.equal(f.calls[0].key, "GET /limits?sats=50000");
  assert.deepEqual([l.feePreview.platformFeeSats, l.feePreview.possibleDisputeFeeSats, l.feePreview.minDealSats, l.feePreview.maxDealSats, l.feePreview.estimatedSwapCostSats], [500, 2500, 1000, 1000000, null]);
  assert.deepEqual(l.feeSummary.examples.map((x) => [x.amountSats, x.platformFeeSats, x.possibleDisputeFeeSats]), [[3299, 0, 0], [3300, 330, 330], [33000, 330, 1650], [100000, 1000, 5000], [1000000, 10000, 50000]]);
  assert.equal(await code(uc.limits(c, 2000000)), "LIMIT_EXCEEDED");
  const plain = await uc.limits(c); assert.equal(plain.feePreview, undefined);
});
test("create output includes the server fee preview (or a local one)", async () => {
  const sp = feePreview(T2, 10000, { minDealSats: 1000, maxDealSats: 1000000, swapEstimateSats: 30 });
  for (const withServer of [true, false]) {
    const { c } = await ctx({ "GET /limits": async () => [200, LIMITS], "POST /escrows": async (b) => [201, { ...b, id: "e1", state: "created", address: arkAddr(5), proposals: [], fees: T2, ...(withServer ? { feePreview: sp } : {}) }] });
    const e = await uc.create(c, { role: "buyer", counterparty: other.p, sats: 10000, deadline: 3600, terms: { title: "t", description: "d" } });
    assert.equal(e.feePreview.platformFeeSats, 330); assert.equal(e.feePreview.possibleDisputeFeeSats, 500); assert.equal(e.feePreview.estimatedSwapCostSats, withServer ? 30 : null);
  }
});
test("amountless payout invoice: AMOUNTLESS_INVOICE_UNSUPPORTED with the amount to set, no swap created", async () => {
  let c0; const { c } = await ctx({ "GET /escrows/e1": async () => [200, { id: "e1", state: "funded", amountSats: 1200, funding: { outpoint: "x:0", amount: 1200 }, buyerPubkey: other.p, sellerPubkey: c0.pubkey, arbiterPubkey: "22".repeat(32), proposals: [] }],
    "GET /escrows/e1/quote": async () => [200, { quoteType: "estimate", lightning: { invoiceSats: 1198, recommendedInvoiceSats: 1178 }, amountlessInvoice: { supported: false, setInvoiceAmountSats: 1178 } }] }); c0 = c;
  await assert.rejects(uc.approve(c, "e1", { payoutInvoice: makeInvoice({ network: "mutinynet" }) }), (e) => e.code === "AMOUNTLESS_INVOICE_UNSUPPORTED" && e.details.setInvoiceAmountSats === 1178 && /1178/.test(e.message));
});
test("server error details are kept (AMOUNT_MISMATCH range + recommended)", async () => {
  const det = { minInvoiceSats: 4220, maxInvoiceSats: 4307, recommendedInvoiceSats: 4305 };
  const { c } = await ctx({ "GET /escrows/e1/quote": async () => [400, { error: "invoice requests 4326 sats", code: "AMOUNT_MISMATCH", details: det }] });
  await assert.rejects(uc.quote(c, "e1", "release", "x@y.z"), (e) => e.code === "AMOUNT_MISMATCH" && e.details.recommendedInvoiceSats === 4305);
});
