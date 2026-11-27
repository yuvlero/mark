// approve/refund --wait: poll until the deal is released/refunded and the payout settles (Lightning, Ark, or timeout).
import test from "node:test";
import assert from "node:assert/strict";
import { checkEscrowArgs, parseArgs } from "../dist/src/cliArgs.js";
import { waitAfterApprove, init, approve } from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { tmpHome, mockFetch, arkAddr, payoutArk } from "./mockApi.mjs";

const chk = (argv) => { const { pos, f } = parseArgs(argv); return checkEscrowArgs(pos[0], pos[1], f); };

function ctx({ deals, proposal, statuses }) {
  let i = 0, s = 0;
  const list = Array.isArray(deals) ? deals : [deals];
  const st = statuses ?? [];
  return {
    api: {
      get: async () => list[Math.min(i++, list.length - 1)],
      proposal: async () => proposal,
    },
    swaps: async () => ({ get: async (id) => ({ id, status: st[Math.min(s++, st.length - 1)] }) }),
    index: { get: () => ({}) },
  };
}

const released = (payout) => ({ id: "e1", state: "released", proposals: [{ id: "p0", kind: "release", signers: ["buyer", "seller"], sigs: ["buyer", "seller"], submittedTxid: "ab".repeat(32) }] });
const signed = (e) => ({ escrow: e, signedPayout: { type: e.proposals?.[0] ? "ok" : "none" } });

test("CLI: --wait is valid on approve/refund for Lightning, Ark, stablecoin, and a co-sign", () => {
  for (const ok of [
    ["approve", "e1", "--wait"],
    ["approve", "e1", "--payout-lnaddr", "a@b.c", "--wait", "--timeout", "60"],
    ["approve", "e1", "--payout-invoice", "lnbc1x", "--wait"],
    ["approve", "e1", "--payout-ark", "ark1x", "--wait"],
    ["refund", "e1", "--payout-lnaddr", "a@b.c", "--wait"],
  ]) assert.equal(chk(ok), null, ok.join(" "));
});

test("waitAfterApprove: Ark payout is settled once the deal is released", async () => {
  const e = released();
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "ark", address: "ark1x" } } });
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 1, timeoutSec: 2 });
  assert.equal(r.settled, true); assert.equal(r.timedOut, undefined); assert.match(r.next, /complete/);
});

test("waitAfterApprove: polls until a co-signed deal becomes released", async () => {
  const opening = { id: "e1", state: "releasing", proposals: [{ id: "p0", kind: "release", signers: ["buyer", "seller"], sigs: ["seller"], submittedTxid: undefined }] };
  const done = released();
  const c = ctx({ deals: [opening, opening, done], proposal: { id: "p0", payout: { type: "ark", address: "ark1x" } } });
  const r = await waitAfterApprove(c, "e1", { signed: signed(opening), pollMs: 5, timeoutSec: 2 });
  assert.equal(r.settled, true); assert.equal(r.escrow.state, "released");
});

test("waitAfterApprove: Lightning payout waits until the swap settles (invoice paid)", async () => {
  const e = released();
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "invoice", swapId: "sw1", invoice: "lnbc1x" } }, statuses: ["pending", "clientfunded", "clientredeemed"] });
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 5, timeoutSec: 2 });
  assert.equal(r.settled, true); assert.equal(r.payoutSwap.status, "clientredeemed"); assert.match(r.next, /Lightning invoice paid/);
});

test("waitAfterApprove: a failed Lightning payout swap is reported, not hung", async () => {
  const e = released();
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "lnaddr", swapId: "sw1", address: "a@b.c" } }, statuses: ["pending", "expired"] });
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 5, timeoutSec: 2 });
  assert.equal(r.settled, false); assert.equal(r.payoutSwap.ended, true); assert.match(r.next, /ended as expired/);
});

test("waitAfterApprove: times out cleanly while still waiting for the co-signer", async () => {
  const e = { id: "e1", state: "releasing", proposals: [{ id: "p0", kind: "release", signers: ["buyer", "seller"], sigs: ["seller"] }] };
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "ark", address: "ark1x" } } });
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 5, timeoutSec: 0.05 });
  assert.equal(r.timedOut, true); assert.equal(r.escrow.state, "releasing"); assert.match(r.next, /still releasing/);
});

test("waitAfterApprove: times out cleanly if the Lightning payout swap does not settle", async () => {
  const e = released();
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "invoice", swapId: "sw1" } }, statuses: ["pending"] });
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 5, timeoutSec: 0.05 });
  assert.equal(r.timedOut, true); assert.equal(r.payoutSwap.status, "pending"); assert.match(r.next, /still pending/);
});

test("waitAfterApprove: missing payout metadata is not reported as settled", async () => {
  const e = released();
  const c = ctx({ deals: e, proposal: { id: "p0" } });
  c.index = { get: () => ({ payoutSwap: "stale-sw" }) };
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 1, timeoutSec: 1 });
  assert.equal(r.settled, false); assert.doesNotMatch(r.next, /complete|paid/); assert.match(r.next, /Could not tell which payout/);
});

test("waitAfterApprove: a Lightning payout without swapId is not settled (and a stale local swap is ignored)", async () => {
  const e = released();
  let got = 0;
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "invoice", invoice: "lnbc1x" } }, statuses: ["clientredeemed"] });
  const g = c.swaps;
  c.swaps = async () => { const s = await g(); return { get: async (id) => { got++; return s.get(id); } }; };
  c.index = { get: () => ({ payoutSwap: "stale-sw" }) };
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 1, timeoutSec: 1 });
  assert.equal(r.settled, false); assert.equal(got, 0, "must not poll a local/stale swap id"); assert.match(r.next, /names no swap id/);
});

test("waitAfterApprove: a stale local stable payout is not claimed if a different proposal was submitted", async () => {
  const e = released();
  let claimed = 0;
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "stable", swapId: "po-B", address: "0x" + "ab".repeat(20), token: "usdc" } } });
  c.index = { get: () => ({ payoutSwap: "po-A", payoutStable: "usdc", payoutAddress: "0x" + "ab".repeat(20) }) };
  c.swaps = async () => ({ get: async () => ({ id: "po-B", status: "serverfunded" }), claim: async () => { claimed++; return { success: true }; } });
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), stable: { token: "usdc", swapId: "po-A" }, pollMs: 1, timeoutSec: 1 });
  assert.equal(claimed, 0); assert.equal(r.claim, undefined); assert.equal(r.settled, false); assert.match(r.next, /claim-payout/);
});

test("waitAfterApprove: a co-signer does not try to claim a stablecoin payout", async () => {
  const e = released();
  let claimed = 0;
  const c = ctx({ deals: e, proposal: { id: "p0", payout: { type: "stable", swapId: "po-1", address: "0x" + "ab".repeat(20), token: "usdc" } } });
  c.swaps = async () => ({ get: async () => ({ id: "po-1", status: "serverfunded" }), claim: async () => { claimed++; return { success: true }; } });
  c.index = { get: () => ({}) };
  const r = await waitAfterApprove(c, "e1", { signed: signed(e), pollMs: 1, timeoutSec: 1 });
  assert.equal(claimed, 0); assert.equal(r.settled, false); assert.equal(r.claim, undefined); assert.match(r.next, /claim-payout/);
});

test("approve --wait resumes when this home already signed (does not throw NOTHING_TO_SIGN)", async () => {
  tmpHome(); await init("mutinynet");
  let n = 0, c0;
  const opening = (c) => ({ id: "e1", state: "releasing", amountSats: 1200, deadline: new Date(Date.now() + 3600e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: "11".repeat(32), arbiterPubkey: "22".repeat(32), funding: { outpoint: "x:0", amount: 1200 }, proposals: [{ id: "p0", kind: "release", dest: payoutArk(7), signers: ["buyer", "seller"], sigs: ["buyer", "seller"] }] });
  const done = (c) => ({ ...opening(c), state: "released", proposals: [{ id: "p0", kind: "release", dest: payoutArk(7), signers: ["buyer", "seller"], sigs: ["buyer", "seller"], submittedTxid: "ab".repeat(32) }] });
  const f = mockFetch({
    "GET /escrows/e1": async () => [200, (n++ === 0 ? opening : done)(c0)],
    "GET /escrows/e1/proposals/p0": async () => [200, { id: "p0", kind: "release", dest: payoutArk(7), signers: ["buyer", "seller"], sigs: ["buyer", "seller"], submittedTxid: "ab".repeat(32), payout: { type: "ark", address: payoutArk(7) }, arkTx: "", checkpoints: [] }],
  });
  const c = await openCtx("mutinynet", { escrowUrl: "https://escrow.test", fetchImpl: f, swapFactory: async () => { throw new Error("swap must not be used"); } });
  c0 = c;
  const r = await approve(c, "e1", { wait: true, timeoutSec: 2, pollMs: 5 });
  assert.equal(r.settled, true); assert.equal(r.escrow.state, "released"); assert.match(r.next, /Ark payout is complete/);
});
