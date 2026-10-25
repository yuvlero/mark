// Seller-side (and buyer-side) auto-refund deadline countdown: shared core/deadline.ts, and show / status / MCP output for each role.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { deadlineCountdown, countdownFor } from "../dist/src/core/deadline.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";

const other = (() => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; })();
const NOW = Date.parse("2026-10-25T12:00:00Z");
const D = "2026-10-25T13:00:00.000Z"; // 1 h after NOW
const cd = (o) => deadlineCountdown({ id: "e1", state: "funded", deadline: D, arbiterMode: "auto", ...o }, NOW);

test("countdown: funded + auto arbiter runs; disputeBy = autoRefundAt = deadline; seconds left; notes per role", () => {
  const r = cd({});
  assert.equal(r.status, "running"); assert.equal(r.reason, "running"); assert.equal(r.autoRefund, true);
  assert.equal(r.deadline, D); assert.equal(r.autoRefundAt, D); assert.equal(r.disputeBy, D); assert.equal(r.secondsLeft, 3600); assert.equal(r.passed, false);
  assert.match(r.seller, /Delivering does not stop this clock/); assert.match(r.seller, /mark escrow dispute e1/);
  assert.match(r.buyer, /refund yourself after it/);
  for (const s of ["releasing", "refunding"]) assert.equal(cd({ state: s }).status, "running", s);
});
test("countdown: deadline passed -> passed, 0 s left, seller told to dispute now, buyer how to refund", () => {
  const r = deadlineCountdown({ id: "e1", state: "funded", deadline: D, arbiterMode: "auto" }, Date.parse(D) + 5000);
  assert.equal(r.status, "passed"); assert.equal(r.passed, true); assert.equal(r.secondsLeft, 0); assert.equal(r.disputeBy, D); assert.equal(r.autoRefund, true);
  assert.match(r.seller, /open a dispute now: mark escrow dispute e1/); assert.match(r.buyer, /mark escrow refund e1/);
  assert.equal(deadlineCountdown({ state: "funded", deadline: D, arbiterMode: "auto" }, Date.parse(D)).status, "passed", "exactly at the deadline the arbiter already signs");
});
test("countdown: not applicable states carry no autoRefundAt / disputeBy", () => {
  const cases = [[{ state: "created" }, "unfunded"], [{ state: "released" }, "final"], [{ state: "refunded" }, "final"], [{ state: "expired" }, "final"],
    [{ state: "disputed", disputed: true }, "disputed"], [{ state: "disputed", disputed: true, ruled: true }, "ruled"], [{ arbiterMode: "manual" }, "manual_arbiter"],
    [{ aboveAutoCap: true }, "above_auto_cap"], [{ deadline: "not a date" }, "bad_deadline"]];
  for (const [o, reason] of cases) {
    const r = cd(o); assert.equal(r.status, "not_applicable", reason); assert.equal(r.reason, reason); assert.equal(r.autoRefund, false);
    assert.equal(r.autoRefundAt, null); assert.equal(r.disputeBy, null); assert.ok(r.buyer && r.seller);
  }
  assert.match(cd({ state: "created" }).seller, /do not deliver before the deal is funded/);
  assert.equal(cd({ deadline: "x" }).secondsLeft, null);
});
test("countdownFor keeps only the caller's note", () => {
  const s = countdownFor(cd({}), "seller"); assert.equal(s.buyer, undefined); assert.equal(s.seller, undefined); assert.match(s.note, /Delivering/);
  assert.match(countdownFor(cd({}), "buyer").note, /refund yourself/);
});

const URL_ = "https://escrow.test";
async function ctx(routes) { tmpHome(); await uc.init("mutinynet"); return openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: mockFetch(routes), swapFactory: async () => { throw new Error("no swap"); } }); }
const deal = (o) => ({ id: "e1", state: "funded", amountSats: 1200, address: arkAddr(5), arbiterPubkey: "22".repeat(32), rule: { type: "manual" }, arbiterMode: "auto", proposals: [], terms: null, termsHash: null, events: [], ...o });

test("show / status as SELLER print the countdown (running, passed, disputed, unfunded); old server without the field still works", async () => {
  let d; const c = await ctx({ "GET /escrows/e1": async () => [200, d], [`GET /reputation/${other.p}`]: async () => [404, { code: "NOT_FOUND", error: "x" }] });
  const future = new Date(Date.now() + 2 * 3600e3).toISOString();
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future });
  for (const r of [await uc.show(c, "e1"), await uc.status(c, "e1")]) {
    assert.equal(r.myRole, "seller"); const x = r.deadlineCountdown;
    assert.equal(x.status, "running"); assert.equal(x.disputeBy, future); assert.equal(x.autoRefundAt, future);
    assert.ok(x.secondsLeft > 7100 && x.secondsLeft <= 7200, String(x.secondsLeft)); assert.match(x.note, /dispute before then/); assert.equal(x.buyer, undefined);
  }
  const past = new Date(Date.now() - 60e3).toISOString(); d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: past });
  let x = (await uc.status(c, "e1")).deadlineCountdown; assert.equal(x.status, "passed"); assert.equal(x.secondsLeft, 0); assert.match(x.note, /open a dispute now/);
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, state: "disputed", dispute: { by: "seller", reason: "r", at: "t" } });
  x = (await uc.show(c, "e1")).deadlineCountdown; assert.equal(x.status, "not_applicable"); assert.equal(x.reason, "disputed"); assert.equal(x.disputeBy, null);
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, state: "created" });
  x = (await uc.show(c, "e1")).deadlineCountdown; assert.equal(x.reason, "unfunded"); assert.match(x.note, /do not deliver/);
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, state: "released" });
  assert.equal((await uc.status(c, "e1")).deadlineCountdown.reason, "final");
});
test("show as BUYER gets the same clock with the buyer note; server's above_auto_cap honoured; a server can't fake a running clock", async () => {
  let d; const c = await ctx({ "GET /escrows/e1": async () => [200, d], [`GET /reputation/${other.p}`]: async () => [404, { code: "NOT_FOUND", error: "x" }] });
  const future = new Date(Date.now() + 3600e3).toISOString();
  d = deal({ buyerPubkey: c.pubkey, sellerPubkey: other.p, deadline: future });
  let x = (await uc.show(c, "e1")).deadlineCountdown; assert.equal(x.status, "running"); assert.match(x.note, /refund yourself/);
  d.deadlineCountdown = { status: "not_applicable", reason: "above_auto_cap" };
  x = (await uc.show(c, "e1")).deadlineCountdown; assert.equal(x.reason, "above_auto_cap"); assert.equal(x.autoRefund, false);
  d = deal({ buyerPubkey: c.pubkey, sellerPubkey: other.p, deadline: future, arbiterMode: "manual", deadlineCountdown: { status: "running", reason: "running", buyer: "fake", seller: "fake" } });
  const st = await uc.status(c, "e1"); assert.equal(st.deadlineCountdown.reason, "manual_arbiter"); assert.equal(st.deadlineCountdown.buyer, undefined);
});
test("MCP: escrow_show / escrow_status descriptions name deadlineCountdown (tool output = the same JSON)", () => {
  const src = fs.readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  for (const t of ["escrow_show", "escrow_status"]) assert.match(src.split(`s.tool("${t}"`)[1].split("\n")[0], /deadlineCountdown/, t);
});
