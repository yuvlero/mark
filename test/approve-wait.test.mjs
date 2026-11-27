// approve/refund --wait: poll until the deal is released/refunded and the payout settles (Lightning, Ark, or timeout).
import test from "node:test";
import assert from "node:assert/strict";
import { checkEscrowArgs, parseArgs } from "../dist/src/cliArgs.js";
import { waitAfterApprove } from "../dist/src/core/usecases.js";

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
