// Expired deals (server final state "expired": unfunded at deadline + grace): fund refuses / reports expired,
// refund of a late or partial payment is allowed, invites skip expired deals, status awaits nothing.
import test from "node:test"; import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js"; import { sha256 } from "@noble/hashes/sha2.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { dealStatus } from "../dist/src/core/status.js";
import { tmpHome, mockFetch, arkAddr, psbtPaying } from "./mockApi.mjs";

const OTHER = "11".repeat(32); const URL_ = "https://escrow.test";
const noSwap = async () => { throw new Error("swap must not be used"); };
async function ctx(routes, extra = {}) { tmpHome(); await uc.init("mutinynet"); const f = mockFetch(routes); return { c: await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: noSwap, ...extra }), f }; }
const deal = (c, o = {}) => ({ id: "e1", state: "created", amountSats: 1200, deadline: new Date(Date.now() + 86400e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: OTHER, arbiterPubkey: "22".repeat(32), proposals: [], terms: null, ...o });
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };

test("status: expired is final (awaiting none) even with terms not accepted", () => {
  assert.deepEqual(dealStatus({ state: "expired", accepted: { buyer: false, seller: false }, proposals: [] }), { awaiting: "none", action_required_for: "none" });
});

test("fund: an expired deal prints 'expired', not 'already funded', and never creates a swap", async () => {
  let c0; const { c } = await ctx({ "GET /escrows/e1": async () => [200, deal(c0, { state: "expired", expiredAt: "2026-10-20T10:00:00Z" })] }); c0 = c;
  const r = await uc.fund(c, "e1"); assert.equal(r.state, "expired"); assert.match(r.note, /^expired/); assert.doesNotMatch(r.note, /already funded/);
  const { c: c2 } = await ctx({ "GET /escrows/e1": async () => [200, deal(c0, { state: "funded", funding: { outpoint: "x:0", amount: 1200 } })] });
  assert.equal((await uc.fund(c2, "e1")).note, "already funded");
});

test("fund: refuses when deadline + grace leaves less than an invoice lifetime (server expiresAt, else deadline + default grace)", async () => {
  let c0; let d;
  const { c } = await ctx({ "GET /escrows/e1": async () => [200, d] }); c0 = c;
  d = deal(c0, { deadline: new Date(Date.now() - 60e3).toISOString(), expiresAt: new Date(Date.now() + 30 * 60e3).toISOString() }); // 30 min left < 1 h
  assert.equal(await code(uc.fund(c, "e1")), "DEADLINE_TOO_CLOSE");
  d = deal(c0, { deadline: new Date(Date.now() - 10 * 60e3).toISOString() }); // no expiresAt: deadline + 1 h default = 50 min left
  assert.equal(await code(uc.fund(c, "e1")), "DEADLINE_TOO_CLOSE");
  assert.equal(uc.FUND_INVOICE_LIFETIME_SEC, 3600); assert.equal(uc.DEFAULT_EXPIRY_GRACE_SEC, 3600);
  // enough time left: passes the check and reaches the swap provider (mocked to throw here)
  d = deal(c0, { deadline: new Date(Date.now() + 10 * 60e3).toISOString() }); // 70 min left
  await assert.rejects(uc.fund(c, "e1"), /swap must not be used/);
});

test("fund --wait: never claims into a deal that expired while the invoice was being paid", async () => {
  let c0, n = 0; let claimed = false;
  const swaps = { createReceive: async () => ({ id: "sw1", invoice: "lntbs1x", amountSats: 1200, status: "pending" }), get: async () => ({ id: "sw1", status: "serverfunded" }), claim: async () => { claimed = true; return { success: true }; } };
  const { c } = await ctx({ "GET /escrows/e1": async () => [200, deal(c0, n++ === 0 ? {} : { state: "expired" })] }, { swapFactory: async () => swaps }); c0 = c;
  const r = await uc.fund(c, "e1", { wait: true, timeoutSec: 5 });
  assert.equal(r.state, "expired"); assert.equal(claimed, false); assert.match(r.note, /NOT claimed/);
});

test("refund: allowed on an expired deal holding a late/partial payment; release and empty expired deals refused", async () => {
  let c0, posted; const dest = arkAddr(7); let d;
  const { c } = await ctx({
    "GET /escrows/e1": async () => [200, d],
    "POST /escrows/e1/proposals": async (b) => { posted = b; return [201, { escrow: d, proposal: { id: "p1" } }]; },
    "GET /escrows/e1/proposals/p1": async () => [200, { id: "p1", kind: "refund", dest, signers: ["buyer", "arbiter"], sigs: [], arkTx: psbtPaying(arkAddr(8), 500), checkpoints: [] }],
  }); c0 = c;
  d = deal(c0, { state: "expired" });
  assert.equal(await code(uc.refund(c, "e1", { payoutArk: dest })), "BAD_STATE");
  d = deal(c0, { state: "expired", funding: { outpoint: "x:0", amount: 500 }, partialFunding: { totalSats: 500, vtxos: [] } });
  assert.equal(await code(uc.refund(c, "e1", { payoutArk: dest })), "UNSAFE_TX"); // reached propose + sign (tx is bogus on purpose)
  assert.deepEqual(posted.signers, ["buyer", "arbiter"]); assert.equal(posted.kind, "refund");
  assert.ok(schnorr.verify(hex.decode(posted.auth.sig), sha256(new TextEncoder().encode(`mark-escrow:v1:e1:propose:refund:${dest}:${posted.auth.ts}`)), hex.decode(c.pubkey)));
  const show = await uc.show(c, "e1"); assert.match(show.next, /mark escrow refund e1/);
});

test("invites: expired deals are skipped by the default, --needs fund and --needs any; shown by --all and --state expired", async () => {
  tmpHome(); await uc.init("mutinynet");
  const it = (id, state, needs = []) => ({ id, role: "buyer", counterpartyPubkey: OTHER, sats: 1200, state, createdAt: "2026-10-15T00:00:00Z", terms: null, termsAccepted: { mine: null, theirs: null }, needs, nextStep: { text: "x", command: "y" } });
  // an old server could still report needs on an expired deal: Mark drops it anyway
  const rows = [it("a", "created", ["fund"]), it("b", "expired", ["fund"]), it("c", "expired", ["accept"])];
  const f = async (url) => { const u = new URL(url); const st = u.searchParams.get("state"); const nd = u.searchParams.get("needs");
    const esc = rows.filter((r) => (!st || r.state === st) && (!nd || (nd === "any" ? r.needs.length : r.needs.includes(nd))));
    return new Response(JSON.stringify({ party: u.searchParams.get("party"), count: esc.length, escrows: esc, nextCursor: null })); };
  const c = await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: noSwap });
  assert.deepEqual((await uc.invites(c, { needs: "fund" })).escrows.map((x) => x.id), ["a"]);
  assert.deepEqual((await uc.invites(c)).escrows.map((x) => x.id), []);
  assert.deepEqual((await uc.invites(c, { needs: "any" })).escrows.map((x) => x.id), ["a"]);
  assert.deepEqual((await uc.invites(c, { all: true })).escrows.map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual((await uc.invites(c, { all: true, state: "expired" })).escrows.map((x) => x.id), ["b", "c"]);
});
