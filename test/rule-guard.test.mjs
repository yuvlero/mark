// Buyer-side consent guard (2026-10-22 security audit): the auto-release rule is not covered by the signed terms, so a deal whose
// hash lock or webhook rule the seller chose lets seller + arbiter release without the buyer. fund refuses it unless explicitly allowed.
import test from "node:test"; import assert from "node:assert/strict";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";

const OTHER = "11".repeat(32); const URL_ = "https://escrow.test";
const noSwap = async () => { throw new Error("swap must not be used"); };
async function ctx(routes) { tmpHome(); await uc.init("mutinynet"); return openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: mockFetch(routes), swapFactory: noSwap }); }
const deal = (c, o = {}) => ({ id: "e1", state: "created", amountSats: 1200, deadline: new Date(Date.now() + 86400e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: OTHER, arbiterPubkey: "22".repeat(32), proposals: [], terms: null, rule: { type: "manual" }, arbiterMode: "auto", events: [{ type: "created", data: {} }], ...o });
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };
const HASH = { type: "hash", sha256: "ab".repeat(32) };

test("fund (buyer): seller-created hash lock or any webhook rule -> UNSAFE_RULE; opt-in passes; show warns", async () => {
  let d; const c = await ctx({ "GET /escrows/e1": async () => [200, d], "GET /reputation/1111111111111111111111111111111111111111111111111111111111111111": async () => [404, { error: "x", code: "NOT_FOUND" }] });
  d = deal(c, { rule: HASH, events: [{ type: "created", data: { acceptedBy: ["seller"] } }] });
  const err = await uc.fund(c, "e1").catch((e) => e); assert.equal(err.code, "UNSAFE_RULE"); assert.match(err.message, /WITHOUT your signature/); assert.match(err.message, /--allow-counterparty-rule/);
  const s = await uc.show(c, "e1"); assert.equal(s.ruleWarning.releaseRule, "hash"); assert.match(s.ruleWarning.warning, /seller set this hash lock/);
  // explicit opt-in: passes the guard and reaches the swap provider (mocked to throw)
  await assert.rejects(uc.fund(c, "e1", { allowCounterpartyRule: true }), /swap must not be used/);
  // legacy deal, unknown creator, hash rule -> refused too
  d = deal(c, { rule: HASH }); assert.equal(await code(uc.fund(c, "e1")), "UNSAFE_RULE");
  // webhook rule: refused even if the buyer is recorded as creator (the buyer cannot know who runs the URL)
  d = deal(c, { rule: { type: "webhook", url: "https://seller.example/approve" }, events: [{ type: "created", data: { acceptedBy: ["buyer"] } }] });
  const w = await uc.fund(c, "e1").catch((e) => e); assert.equal(w.code, "UNSAFE_RULE"); assert.equal(w.details.url, "https://seller.example/approve"); assert.equal(w.details.releaseRule, "webhook");
});

test("fund (buyer): own hash lock, manual rule, manual arbiter mode, or an existing funding swap -> no guard", async () => {
  let d; const c = await ctx({ "GET /escrows/e1": async () => [200, d], "GET /reputation/1111111111111111111111111111111111111111111111111111111111111111": async () => [404, { error: "x", code: "NOT_FOUND" }] });
  d = deal(c, { rule: HASH, events: [{ type: "created", data: { acceptedBy: ["buyer"] } }] }); await assert.rejects(uc.fund(c, "e1"), /swap must not be used/);
  assert.equal((await uc.show(c, "e1")).ruleWarning, undefined);
  d = deal(c, { rule: { type: "manual" } }); await assert.rejects(uc.fund(c, "e1"), /swap must not be used/);
  d = deal(c, { rule: HASH, arbiterMode: "manual" }); await assert.rejects(uc.fund(c, "e1"), /swap must not be used/);
  // created by this wallet (local index) -> own hash lock
  d = deal(c, { rule: HASH }); c.index.set("e1", { role: "buyer", created: true }); await assert.rejects(uc.fund(c, "e1"), /swap must not be used/);
});

test("seller side: no rule warning (the guard protects the buyer)", async () => {
  let d; const c = await ctx({ "GET /escrows/e1": async () => [200, d], "GET /reputation/1111111111111111111111111111111111111111111111111111111111111111": async () => [404, { error: "x", code: "NOT_FOUND" }] });
  d = deal(c, { buyerPubkey: OTHER, sellerPubkey: c.pubkey, rule: { type: "webhook", url: "https://x.example/" } });
  assert.equal(uc.counterpartyRule(c, d, "seller"), null); assert.equal((await uc.show(c, "e1")).ruleWarning, undefined);
});
