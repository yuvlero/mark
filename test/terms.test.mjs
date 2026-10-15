// Deal terms (create signs termsHash, accept verifies locally then signs), legacy deals, evidence, funding gate. Mock API, ephemeral keys.
import test from "node:test"; import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { normalizeTerms, termsDocument, termsHash, verifyTermsSig, evidenceHash } from "../dist/src/core/terms.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";

const URL_ = "http://escrow.test";
const other = (() => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; })();
const T = { title: "Buy 1M tokens of inference", description: "1,000,000 output tokens", acceptance: "usable within 24h" };
async function ctx(routes) { tmpHome(); await uc.init("mutinynet"); const f = mockFetch(routes); return { c: await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => ({ createReceive: async () => ({ id: "sw1", invoice: "lnbc" }) }) }), f }; }
const deal = (c, o = {}) => { const d = { id: "e1", state: "created", amountSats: 1200, deadline: new Date(Date.now() + 3600e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: other.p, arbiterPubkey: "22".repeat(32), proposals: [], ...o };
  if (d.terms) d.termsHash ??= termsHash(termsDocument(normalizeTerms(d.terms), { network: "mutinynet", amountSats: d.amountSats, buyerPubkey: d.buyerPubkey, sellerPubkey: d.sellerPubkey })); return d; };
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };

test("termsHash vector matches escrow-server implementation", () => {
  const v = termsHash(termsDocument(normalizeTerms({ title: "t", description: "d" }), { network: "bitcoin", amountSats: 1000, buyerPubkey: "11".repeat(32), sellerPubkey: "22".repeat(32) }));
  assert.equal(v, "ab363b382879bd2d949ba40a2960e470bd4e9227b4f7d1abde39ea7a9c37a2d3");
});

test("create requires terms, validates sizes, signs termsHash with my key, never sends the secret", async () => {
  let posted; const { c, f } = await ctx({ "POST /escrows": async (b) => { posted = b; return [201, { ...b, id: "e1", state: "created", address: arkAddr(5), proposals: [] }]; } });
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: other.p, sats: 1200, deadline: 3600 })), "BAD_TERMS");
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: other.p, sats: 1200, deadline: 3600, terms: { title: "x".repeat(121), description: "d" } })), "BAD_TERMS");
  assert.equal(await code(uc.create(c, { role: "buyer", counterparty: other.p, sats: 1200, deadline: 3600, terms: { title: "t", description: "d".repeat(4001) } })), "BAD_TERMS");
  assert.equal(f.calls.length, 0);
  const e = await uc.create(c, { role: "buyer", counterparty: other.p, sats: 1200, deadline: 3600, terms: T });
  assert.equal(posted.creatorAcceptance.party, "buyer"); assert.ok(verifyTermsSig(c.pubkey, posted.termsHash, posted.creatorAcceptance.sig));
  assert.equal(e.termsHash, deal(c, { terms: T }).termsHash); assert.match(e.next, /mark escrow accept e1/);
  assert.ok(!JSON.stringify(f.calls).includes(hex.encode(c.secret)));
  // server reporting a different hash -> refuse
  const { c: c2 } = await ctx({ "POST /escrows": async (b) => [201, { ...b, termsHash: "00".repeat(32), id: "e2", proposals: [] }] });
  assert.equal(await code(uc.create(c2, { role: "buyer", counterparty: other.p, sats: 1200, deadline: 3600, terms: T })), "TERMS_HASH_MISMATCH");
});

test("accept: verifies hash locally, signs, server receives a valid sig; refuses tampered hash; show verifies sigs", async () => {
  let d, got; const { c } = await ctx({ "GET /escrows/e1": async () => [200, d], "POST /escrows/e1/accept": async (b) => { got = b; d.acceptances.buyer = { sig: b.sig, at: "now" }; return [200, d]; } });
  d = deal(c, { terms: T }); d.acceptances = { seller: { sig: hex.encode(schnorr.sign(hex.decode(d.termsHash), other.s)), at: "t0" } };
  let s = await uc.show(c, "e1"); assert.equal(s.hashVerified, true); assert.equal(s.accepted.seller.signatureValid, true); assert.equal(s.accepted.buyer.accepted, false); assert.match(s.next, /accept/);
  const r = await uc.accept(c, "e1");
  assert.equal(got.party, "buyer"); assert.ok(verifyTermsSig(c.pubkey, d.termsHash, got.sig)); assert.equal(r.agreed, true);
  s = await uc.show(c, "e1"); assert.equal(s.agreed, true); assert.match(s.next, /fund/);
  // forged seller acceptance is flagged
  d.acceptances.seller.sig = "00".repeat(64); assert.equal((await uc.show(c, "e1")).accepted.seller.signatureValid, false);
  // server swaps the terms under the same hash -> refuse to sign
  d = deal(c, { terms: T }); d.acceptances = {}; d.terms = { ...T, description: "something else" }; got = undefined;
  assert.equal(await code(uc.accept(c, "e1")), "TERMS_HASH_MISMATCH"); assert.equal(got, undefined);
});

test("legacy deal (terms null): show works, accept -> NO_TERMS, fund not gated", async () => {
  let d; const { c } = await ctx({ "GET /escrows/e1": async () => [200, d] });
  d = deal(c, { terms: null, termsHash: null, acceptances: null });
  const s = await uc.show(c, "e1"); assert.equal(s.legacy, true); assert.equal(s.terms, null);
  assert.equal(await code(uc.accept(c, "e1")), "NO_TERMS");
  const r = await uc.fund(c, "e1"); assert.equal(r.swapId, "sw1"); // proceeds to swap creation
});

test("fund refuses until both parties accepted", async () => {
  let d; const { c } = await ctx({ "GET /escrows/e1": async () => [200, d] });
  d = deal(c, { terms: T }); d.acceptances = { buyer: { sig: hex.encode(schnorr.sign(hex.decode(d.termsHash), c.secret)), at: "t" } };
  assert.equal(await code(uc.fund(c, "e1")), "TERMS_NOT_ACCEPTED");
  d.acceptances.seller = { sig: hex.encode(schnorr.sign(hex.decode(d.termsHash), other.s)), at: "t" };
  assert.equal((await uc.fund(c, "e1")).swapId, "sw1");
});

test("evidence: signed note posted with ts; validation", async () => {
  let d, got; const { c } = await ctx({ "GET /escrows/e1": async () => [200, d], "POST /escrows/e1/evidence": async (b) => { got = b; return [201, { ...d, evidence: [b] }]; } });
  d = deal(c, { terms: T, state: "disputed" });
  const r = await uc.addEvidence(c, "e1", { text: "only 200k tokens served", sha256: "AB".repeat(32), url: "https://x.example/log" });
  assert.equal(r.evidenceCount, 1); assert.equal(got.sha256, "ab".repeat(32));
  assert.ok(verifyTermsSig(c.pubkey, evidenceHash("e1", "buyer", got.ts, { text: got.text, sha256: got.sha256, url: got.url }), got.sig));
  assert.equal(await code(uc.addEvidence(c, "e1", { text: "" })), "BAD_EVIDENCE");
  assert.equal(await code(uc.addEvidence(c, "e1", { text: "x", sha256: "nothex" })), "BAD_EVIDENCE");
  assert.equal(await code(uc.addEvidence(c, "e1", { text: "x", url: "file:///etc/passwd" })), "BAD_EVIDENCE");
});
