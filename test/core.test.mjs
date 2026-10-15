import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { loadConfig, configPath } from "../dist/src/config.js";
import { errorJson, MarkError } from "../dist/src/errors.js";
import { EscrowApi } from "../dist/src/api/escrowApi.js";
import { paysTo } from "../dist/src/crypto/psbt.js";
import { tmpHome, mockFetch, arkAddr, psbtPaying } from "./mockApi.mjs";

const OTHER = "11".repeat(32); const URL_ = "http://escrow.test";
async function ctx(routes, extra = {}) {
  tmpHome(); await uc.init("mutinynet");
  const f = mockFetch(routes);
  const c = await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => { throw new Error("swap must not be used"); }, ...extra });
  return { c, f };
}
const escrow = (c, o = {}) => ({ id: "e1", state: "funded", amountSats: 1200, deadline: new Date(Date.now() + 3600e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: OTHER, arbiterPubkey: "22".repeat(32), funding: { outpoint: "x:0", amount: 1200 }, proposals: [], ...o });
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };

test("init creates keystore + config, no escrow URL default, never prints mnemonic", async () => {
  tmpHome(); const r = await uc.init("mutinynet");
  assert.equal(r.created, true); assert.equal(r.escrowUrl, null); assert.match(r.pubkey, /^[0-9a-f]{64}$/);
  assert.ok(!/(\b[a-z]{3,8}\b ){11}/.test(JSON.stringify(r)));
  assert.equal((await uc.init("mutinynet")).created, false);
});

test("escrow URL precedence: flag > MARK_ESCROW_URL > config; init persists only the flag", async () => {
  tmpHome(); await uc.init("mutinynet", { escrowUrl: "https://file.example/" });
  assert.equal(loadConfig("mutinynet").escrowUrl, "https://file.example");
  process.env.MARK_ESCROW_URL = "https://env.example";
  assert.equal(loadConfig("mutinynet").escrowUrl, "https://env.example");
  assert.equal(loadConfig("mutinynet", { escrowUrl: "http://flag.example:1" }).escrowUrl, "http://flag.example:1");
  await uc.init("mutinynet"); // must not bake env into file
  assert.equal(JSON.parse(fs.readFileSync(configPath("mutinynet"), "utf8")).escrowUrl, "https://file.example");
  delete process.env.MARK_ESCROW_URL;
  assert.throws(() => loadConfig("mutinynet", { escrowUrl: "ftp://x" }), (e) => e.code === "BAD_ESCROW_URL");
});

test("built-in default: bitcoin -> https://agentescrow.to (lowest precedence, never persisted); mutinynet none", async () => {
  tmpHome(); await uc.init("bitcoin"); await uc.init("mutinynet");
  assert.equal(loadConfig("bitcoin").escrowUrl, "https://agentescrow.to");
  assert.equal(loadConfig("mutinynet").escrowUrl, undefined);
  assert.equal(JSON.parse(fs.readFileSync(configPath("bitcoin"), "utf8")).escrowUrl, undefined);
  await uc.init("bitcoin", { escrowUrl: "https://file.example" }); assert.equal(loadConfig("bitcoin").escrowUrl, "https://file.example");
  process.env.MARK_ESCROW_URL = "https://env.example"; assert.equal(loadConfig("bitcoin").escrowUrl, "https://env.example");
  assert.equal(loadConfig("bitcoin", { escrowUrl: "https://flag.example" }).escrowUrl, "https://flag.example"); delete process.env.MARK_ESCROW_URL;
});
test("no URL configured -> ESCROW_URL_MISSING", async () => {
  assert.equal(await code(new EscrowApi(undefined).get("x")), "ESCROW_URL_MISSING");
});

test("create over cap -> LIMIT_EXCEEDED in core, zero HTTP calls", async () => {
  const { c, f } = await ctx({});
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: OTHER, sats: 1000001, deadline: 3600 })), "LIMIT_EXCEEDED");
  assert.equal(f.calls.length, 0);
});

test("create under cap posts contract body and indexes role", async () => {
  const { c, f } = await ctx({ "POST /escrows": async (b) => [201, { ...b, id: "e1", state: "created", address: arkAddr(5), proposals: [] }] });
  const e = await uc.create(c, { role: "seller", counterparty: OTHER, sats: 1200, deadline: "3600", hash: "ab".repeat(32), terms: { title: "t", description: "d" } });
  const b = f.calls.find((x) => x.key === "POST /escrows").body;
  assert.deepEqual([b.buyerPubkey, b.sellerPubkey, b.amountSats, b.deadline], [OTHER, c.pubkey, 1200, 3600]);
  assert.deepEqual(b.rule, { type: "hash", sha256: "ab".repeat(32) });
  assert.equal(e.id, "e1"); assert.equal(c.index.get("e1").role, "seller");
});

test("create validation: bad pubkey, self, bad deadline", async () => {
  const { c } = await ctx({});
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: "zz", sats: 100, deadline: 60 })), "BAD_PUBKEY");
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: c.pubkey, sats: 100, deadline: 60 })), "BAD_PUBKEY");
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: OTHER, sats: 100, deadline: "2001-01-01T00:00:00Z" })), "BAD_DEADLINE");
});

test("HTTP errors map to server code; network failure -> ESCROW_UNREACHABLE", async () => {
  const { c } = await ctx({ "GET /escrows/e1": async () => [404, { error: "escrow not found", code: "NOT_FOUND" }] });
  assert.equal(await code(uc.status(c, "e1")), "NOT_FOUND");
  const api = new EscrowApi(URL_, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(await code(api.get("e1")), "ESCROW_UNREACHABLE");
});

test("quote passes path through", async () => {
  const { c, f } = await ctx({ "GET /escrows/e1/quote": async () => [200, { escrowSats: 1200, lightning: { invoiceSats: 1195 }, ark: { payoutSats: 1200 } }] });
  assert.equal((await uc.quote(c, "e1", "refund")).lightning.invoiceSats, 1195);
  assert.match(f.calls[0].url, /path=refund$/);
});

test("approve refuses a proposal tx that does not pay its dest -> UNSAFE_TX, no signature posted", async () => {
  let c0; const dest = arkAddr(7);
  const { c, f } = await ctx({
    "GET /escrows/e1": async () => [200, escrow(c0, { proposals: [{ id: "p1", kind: "release", dest, signers: ["buyer", "seller"], sigs: ["seller"] }] })],
    "GET /escrows/e1/proposals/p1": async () => [200, { id: "p1", kind: "release", dest, signers: ["buyer", "seller"], sigs: ["seller"], arkTx: psbtPaying(arkAddr(8), 1200), checkpoints: [] }],
  }); c0 = c;
  assert.equal(await code(uc.approve(c, "e1")), "UNSAFE_TX");
  assert.ok(!f.calls.some((x) => x.key.includes("/signatures")));
});

test("paysTo: exact dest+amount ok, short amount or other script rejected", () => {
  const d = arkAddr(7);
  assert.equal(paysTo(psbtPaying(d, 1200), d, 1200), true);
  assert.equal(paysTo(psbtPaying(d, 1199), d, 1200), false);
  assert.equal(paysTo(psbtPaying(arkAddr(8), 1200), d, 1200), false);
});

test("approve with no payout and nothing pending -> NOTHING_TO_SIGN (never asks a co-signer for a payout)", async () => {
  let c0; const { c } = await ctx({ "GET /escrows/e1": async () => [200, escrow(c0)] }); c0 = c;
  assert.equal(await code(uc.approve(c, "e1", { kind: "release" })), "NOTHING_TO_SIGN");
  assert.equal(await code(uc.approve(c, "e1")), "NOTHING_TO_SIGN"); // buyer with no payout: co-sign only, never falls into refund-propose
  assert.equal(await code(uc.approve(c, "e1", { payoutArk: "notanaddr" })), "BAD_DEST");
});

test("approve with payout-invoice validates against quote before any swap (AMOUNT_MISMATCH)", async () => {
  let c0; const { makeInvoice } = await import("./helpers.mjs");
  const { c } = await ctx({ "GET /escrows/e1": async () => [200, escrow(c0)], "GET /escrows/e1/quote": async () => [200, { lightning: { invoiceSats: 1195 } }] }); c0 = c;
  assert.equal(await code(uc.approve(c, "e1", { payoutInvoice: makeInvoice({ sats: 1200, network: "mutinynet" }) })), "AMOUNT_MISMATCH");
});

test("propose with ark payout sends BIP340 auth over the contract message", async () => {
  let c0; const dest = arkAddr(7); let posted;
  const { c } = await ctx({
    "GET /escrows/e1": async () => [200, escrow(c0)],
    "POST /escrows/e1/proposals": async (b) => { posted = b; return [201, { escrow: escrow(c0), proposal: { id: "p1" } }]; },
    "GET /escrows/e1/proposals/p1": async () => [200, { id: "p1", kind: "refund", dest, signers: ["buyer", "arbiter"], sigs: [], arkTx: psbtPaying(arkAddr(8), 1200), checkpoints: [] }],
  }); c0 = c;
  assert.equal(await code(uc.refund(c, "e1", { payoutArk: dest })), "UNSAFE_TX"); // tx is bogus, but proposal body is checked below
  assert.deepEqual(posted.signers, ["buyer", "arbiter"]); assert.deepEqual(posted.payout, { type: "ark", address: dest });
  const msg = sha256(new TextEncoder().encode(`mark-escrow:v1:e1:propose:refund:${dest}:${posted.auth.ts}`));
  assert.ok(schnorr.verify(hex.decode(posted.auth.sig), msg, hex.decode(c.pubkey)));
});

test("dispute auth verifies; non-party -> NOT_A_PARTY", async () => {
  let c0, body;
  const { c } = await ctx({ "GET /escrows/e1": async () => [200, escrow(c0)], "POST /escrows/e1/dispute": async (b) => { body = b; return [200, escrow(c0, { state: "disputed" })]; } }); c0 = c;
  assert.equal((await uc.dispute(c, "e1", "late")).state, "disputed");
  assert.ok(schnorr.verify(hex.decode(body.auth.sig), sha256(new TextEncoder().encode(`mark-escrow:v1:e1:dispute:${body.auth.ts}`)), hex.decode(c.pubkey)));
  const { c: c2 } = await ctx({ "GET /escrows/e1": async () => [200, escrow({ pubkey: OTHER }, { sellerPubkey: "33".repeat(32) })] });
  assert.equal(await code(uc.dispute(c2, "e1")), "NOT_A_PARTY");
});

test("backup phrase is refused for non-interactive callers", async () => {
  tmpHome(); await uc.init("mutinynet");
  assert.throws(() => uc.revealBackupPhrase("mutinynet", false), (e) => e.code === "NOT_A_TTY");
});

test("errorJson shape", () => {
  assert.deepEqual(errorJson(new MarkError("X", "m", { a: 1 })), { error: "m", code: "X", details: { a: 1 } });
  assert.deepEqual(errorJson(new Error("boom")), { error: "boom", code: "ERROR" });
});

test("buyer co-sign: no payout arg, signs pending seller proposal and returns its payout details", async () => {
  let c0; const dest = arkAddr(7); const { makeInvoice } = await import("./helpers.mjs");
  const inv = makeInvoice({ sats: 1190, network: "mutinynet" }); let signed;
  const prop = { id: "p1", kind: "release", dest, signers: ["buyer", "seller"], sigs: ["seller"], payout: { type: "invoice", invoice: inv, swapId: "sw1", sats: 1190 }, arkTx: psbtPaying(dest, 1200), checkpoints: [] };
  const { c, f } = await ctx({
    "GET /escrows/e1": async () => [200, escrow(c0, { proposals: [{ id: "p1", kind: "release", dest, signers: ["buyer", "seller"], sigs: ["seller"] }] })],
    "GET /escrows/e1/proposals/p1": async () => [200, prop],
    "POST /escrows/e1/proposals/p1/signatures": async (b) => { signed = b; return [200, { escrow: escrow(c0, { state: "released" }), proposal: { id: "p1" } }]; },
  }); c0 = c;
  const pend = await uc.pending(c, "e1");
  assert.equal(pend.proposals[0].needsMySignature, true); assert.equal(pend.proposals[0].txMatchesFeeTerms, true); assert.equal(pend.proposals[0].invoiceSats, 1190);
  assert.ok(!f.calls.some((x) => x.key.includes("/signatures")));
  assert.equal(pend.proposals[0].feesAndOverpaySats, 10); assert.equal(pend.proposals[0].swapId, "sw1");
  // mock PSBT has no real escrow tapscript, so the signer itself throws, but only after passing every Mark check
  // (no BAD_REQUEST "payout required", no NOTHING_TO_SIGN, no UNSAFE_TX)
  await assert.rejects(uc.approve(c, "e1"), (e) => /No taproot scripts signed/.test(e.message) && !e.code);
  assert.equal(signed, undefined);
});

test("seller propose with invoice a few sats under exact: swap under-sourced within cap is accepted, beyond cap rejected", async () => {
  const { makeInvoice } = await import("./helpers.mjs"); const dest = arkAddr(7);
  for (const [src, want] of [[1197, "UNSAFE_TX"], [1170, "AMOUNT_MISMATCH"], [1201, "AMOUNT_MISMATCH"]]) {
    let c0, posted = false;
    const swap = { createPay: async () => ({ id: "sw1", fundAddress: dest, fundAmountSats: src, status: "pending" }) };
    const { c } = await ctx({
      "GET /escrows/e1": async () => [200, escrow(c0, { buyerPubkey: OTHER, sellerPubkey: c0.pubkey })],
      "GET /escrows/e1/quote": async () => [200, { lightning: { invoiceSats: 1196 } }],
      "POST /escrows/e1/proposals": async () => { posted = true; return [201, { escrow: escrow(c0, { buyerPubkey: OTHER, sellerPubkey: c0.pubkey }), proposal: { id: "p1" } }]; },
      "GET /escrows/e1/proposals/p1": async () => [200, { id: "p1", kind: "release", dest, signers: ["buyer", "seller"], sigs: [], arkTx: psbtPaying(arkAddr(8), 1200), checkpoints: [] }],
    }, { swapFactory: async () => swap }); c0 = c;
    // 1194 is 2 under the exact 1196 -> accepted by validation; tx is bogus so the final sign step refuses (UNSAFE_TX) after propose
    assert.equal(await code(uc.approve(c, "e1", { payoutInvoice: makeInvoice({ sats: 1194, network: "mutinynet" }) })), want, `src ${src}`);
    assert.equal(posted, want === "UNSAFE_TX");
  }
});
