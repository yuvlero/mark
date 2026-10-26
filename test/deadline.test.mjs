// Seller-side (and buyer-side) auto-refund deadline countdown: shared core/deadline.ts, and show / status / MCP output for each role.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { deadlineCountdown, countdownFor, disputeMarginSec, DISPUTE_MARGIN_PCT, DISPUTE_MARGIN_MIN_SEC, DISPUTE_MARGIN_MAX_SEC } from "../dist/src/core/deadline.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";

const other = (() => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; })();
const NOW = Date.parse("2026-10-25T12:00:00Z");
const D = "2026-10-25T13:00:00.000Z"; // 1 h after NOW
const cd = (o) => deadlineCountdown({ id: "e1", state: "funded", deadline: D, arbiterMode: "auto", ...o }, NOW);

test("countdown: funded + auto arbiter runs; no funding/creation time known -> margin 0, disputeBy = autoRefundAt = deadline; seconds left; notes per role", () => {
  const r = cd({});
  assert.equal(r.status, "running"); assert.equal(r.reason, "running"); assert.equal(r.autoRefund, true);
  assert.equal(r.deadline, D); assert.equal(r.autoRefundAt, D); assert.equal(r.disputeBy, D); assert.equal(r.secondsLeft, 3600); assert.equal(r.passed, false);
  assert.match(r.seller, /Delivering does not stop this clock/); assert.match(r.seller, /mark escrow dispute e1/);
  assert.match(r.buyer, /refund yourself after it/);
  for (const s of ["releasing", "refunding"]) assert.equal(cd({ state: s }).status, "running", s);
});
test("dispute margin: 10% of the funded window, min 60 s, max 24 h, never more than half the window, 0 without a window", () => {
  assert.deepEqual([DISPUTE_MARGIN_PCT, DISPUTE_MARGIN_MIN_SEC, DISPUTE_MARGIN_MAX_SEC], [10, 60, 86400]);
  const m = (sec) => disputeMarginSec(0, sec * 1000);
  assert.equal(m(3600), 360); assert.equal(m(86400), 8640); assert.equal(m(10 * 86400), 86400); assert.equal(m(30 * 86400), 86400, "24 h cap");
  assert.equal(m(300), 60, "60 s floor"); assert.equal(m(60), 30, "tiny window: half of it"); assert.equal(m(1), 0); assert.equal(m(0), 0); assert.equal(m(-50), 0, "funded after the deadline");
  assert.equal(disputeMarginSec(NaN, 1000), 0);
});
test("countdown: disputeBy = deadline - margin from the funding time (createdAt fallback); refund deadline unchanged; plain-words note", () => {
  const f = new Date(NOW - 9 * 3600e3).toISOString(); // funded 9 h before NOW, deadline 1 h after: window 10 h -> margin 1 h -> disputeBy = NOW
  const r = cd({ fundedAt: f, createdAt: "2020-01-01T00:00:00Z" });
  assert.equal(r.deadline, D); assert.equal(r.autoRefundAt, D); assert.equal(r.disputeMarginSec, 3600); assert.equal(r.disputeBy, new Date(NOW).toISOString());
  assert.equal(r.secondsLeft, 3600, "seconds to the deadline, unchanged"); assert.equal(r.secondsRemaining, 0); assert.equal(r.disputeByPassed, true); assert.equal(r.status, "running");
  assert.match(r.seller, /recommended time has passed: .*open a dispute now/); assert.ok(r.seller.startsWith(`Dispute by ${r.disputeBy} (recommended, leaves a margin); the refund can be paid out from ${D}.`));
  const early = cd({ fundedAt: new Date(NOW - 3600e3).toISOString() }); // window 2 h -> margin 720 s
  assert.equal(early.disputeMarginSec, 720); assert.equal(early.secondsRemaining, 3600 - 720); assert.equal(early.disputeByPassed, false);
  assert.ok(Date.parse(early.disputeBy) < Date.parse(D) && Date.parse(early.disputeBy) > NOW - 3600e3, "between funding and deadline");
  assert.match(early.seller, /^Dispute by .* \(recommended, leaves a margin\); the refund can be paid out from .*Delivering does not stop this clock/);
  assert.equal(cd({ createdAt: new Date(NOW - 3600e3).toISOString() }).disputeMarginSec, 720, "createdAt fallback");
  const none = cd({}); assert.equal(none.disputeMarginSec, 0); assert.equal(none.disputeBy, new Date(Date.parse(D)).toISOString(), "no window known: no margin, never after the deadline");
});
test("countdown: deadline passed -> passed, 0 s left, seller told to dispute now, buyer how to refund", () => {
  const r = deadlineCountdown({ id: "e1", state: "funded", deadline: D, arbiterMode: "auto" }, Date.parse(D) + 5000);
  assert.equal(r.status, "passed"); assert.equal(r.passed, true); assert.equal(r.secondsLeft, 0); assert.equal(r.disputeBy, D); assert.equal(r.autoRefund, true);
  assert.equal(r.secondsRemaining, 0); assert.equal(r.disputeByPassed, true);
  assert.match(r.seller, /open a dispute now: mark escrow dispute e1/); assert.match(r.buyer, /mark escrow refund e1/);
  assert.equal(deadlineCountdown({ state: "funded", deadline: D, arbiterMode: "auto" }, Date.parse(D)).status, "passed", "exactly at the deadline the arbiter already signs");
});
test("countdown: not applicable states carry no autoRefundAt / disputeBy", () => {
  const cases = [[{ state: "created" }, "unfunded"], [{ state: "released" }, "final"], [{ state: "refunded" }, "final"], [{ state: "expired" }, "final"],
    [{ state: "disputed", disputed: true }, "disputed"], [{ state: "disputed", disputed: true, ruled: true }, "ruled"], [{ arbiterMode: "manual" }, "manual_arbiter"],
    [{ aboveAutoCap: true }, "above_auto_cap"], [{ deadline: "not a date" }, "bad_deadline"]];
  for (const [o, reason] of cases) {
    const r = cd(o); assert.equal(r.status, "not_applicable", reason); assert.equal(r.reason, reason); assert.equal(r.autoRefund, false);
    assert.equal(r.autoRefundAt, null); assert.equal(r.disputeBy, null); assert.equal(r.secondsRemaining, null); assert.equal(r.disputeMarginSec, null); assert.equal(r.disputeByPassed, false); assert.ok(r.buyer && r.seller);
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
  const fundedAt = new Date(Date.now() - 18 * 3600e3).toISOString(); // window 20 h -> margin 2 h
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, createdAt: fundedAt, funding: { outpoint: "a:0", amount: 1200, seenAt: fundedAt } });
  for (const r of [await uc.show(c, "e1"), await uc.status(c, "e1")]) {
    assert.equal(r.myRole, "seller"); const x = r.deadlineCountdown;
    assert.equal(x.status, "running"); assert.equal(x.autoRefundAt, future); assert.equal(x.deadline, future); assert.ok(Math.abs(x.disputeMarginSec - 7200) <= 1, String(x.disputeMarginSec));
    assert.equal(Date.parse(x.disputeBy), Date.parse(future) - x.disputeMarginSec * 1000); assert.ok(x.secondsRemaining <= 1 && x.secondsRemaining >= 0 || x.disputeByPassed);
    assert.ok(x.secondsLeft > 7100 && x.secondsLeft <= 7200, String(x.secondsLeft)); assert.match(x.note, /^Dispute by .*\(recommended, leaves a margin\); the refund can be paid out from /); assert.equal(x.buyer, undefined);
  }
  const f2 = new Date(Date.now() - 2 * 3600e3).toISOString(); // window 4 h -> margin 24 min
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, funding: { outpoint: "a:0", amount: 1200, seenAt: f2 } });
  let y = (await uc.show(c, "e1")).deadlineCountdown; assert.ok(Math.abs(y.disputeMarginSec - 1440) <= 1, String(y.disputeMarginSec)); assert.equal(y.disputeByPassed, false);
  assert.ok(y.secondsRemaining > 7200 - 1440 - 100 && y.secondsRemaining <= 7200 - 1440, String(y.secondsRemaining)); assert.match(y.note, /Delivering does not stop this clock/);
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

test("unknown future state -> unknown_state (not 'final'); no deadline -> deadline null; window < 120 s: half-window cap beats the 60 s floor", () => {
  const u = cd({ state: "settling_v9" }); assert.equal(u.status, "not_applicable"); assert.equal(u.reason, "unknown_state"); assert.match(u.seller, /Unknown deal state/); assert.match(u.seller, /update Mark/);
  const n = cd({ deadline: undefined }); assert.equal(n.reason, "bad_deadline"); assert.equal(n.deadline, null);
  assert.equal(disputeMarginSec(0, 60_000), 30); assert.equal(disputeMarginSec(0, 119_000), 59); assert.equal(disputeMarginSec(0, 120_000), 60);
});
test("server's above_auto_cap claim: honoured but labelled as the server's, and the seller still gets the local dispute-by time", async () => {
  let d; const c = await ctx({ "GET /escrows/e1": async () => [200, d], [`GET /reputation/${other.p}`]: async () => [404, { code: "NOT_FOUND", error: "x" }] });
  const future = new Date(Date.now() + 10 * 3600e3).toISOString(), fundedAt = new Date(Date.now() - 10 * 3600e3).toISOString(); // window 20 h -> margin 2 h
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, funding: { outpoint: "a:0", amount: 1200, seenAt: fundedAt }, deadlineCountdown: { status: "not_applicable", reason: "above_auto_cap" } });
  const x = (await uc.show(c, "e1")).deadlineCountdown;
  assert.equal(x.reason, "above_auto_cap"); assert.equal(x.aboveAutoCapSource, "server"); assert.match(x.note, /escrow server's statement; Mark cannot check its cap/);
  const by = new Date(Date.parse(future) - 7200e3).toISOString(); assert.ok(x.note.includes(`dispute by ${by} to be safe`), x.note); assert.match(x.note, /mark escrow dispute e1/);
  d = { ...d, buyerPubkey: c.pubkey, sellerPubkey: other.p }; const b = (await uc.show(c, "e1")).deadlineCountdown;
  assert.equal(b.aboveAutoCapSource, "server"); assert.ok(!/dispute by/.test(b.note), "buyer: no dispute advice");
  // a server-supplied id that is not a plain id is not embedded in the suggested command
  d = deal({ id: "e1; rm -rf ~", buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, funding: { outpoint: "a:0", amount: 1200, seenAt: fundedAt }, deadlineCountdown: { reason: "above_auto_cap" } });
  const z = (await uc.show(c, "e1")).deadlineCountdown; assert.ok(!z.note.includes("rm -rf"), z.note); assert.match(z.note, /mark escrow dispute <id>/);
  // where the clock would not run anyway (manual mode), nothing is added
  d = deal({ buyerPubkey: other.p, sellerPubkey: c.pubkey, deadline: future, arbiterMode: "manual", deadlineCountdown: { reason: "above_auto_cap" } });
  assert.equal((await uc.show(c, "e1")).deadlineCountdown.reason, "manual_arbiter");
  // no `as any` left in myCountdown
  const src = fs.readFileSync(new URL("../src/core/usecases.ts", import.meta.url), "utf8"); const fn = src.slice(src.indexOf("export function myCountdown"), src.indexOf("// ---------- expiry"));
  assert.ok(fn.length > 100 && !/as any/.test(fn));
});
