// Machine-readable status (awaiting / action_required_for / arbiterPolicy), evidence --file + deliverable match, hash-release flow.
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { dealStatus, arbiterPolicy } from "../dist/src/core/status.js";
import { normalizeTerms, termsDocument, termsHash } from "../dist/src/core/terms.js";
import { tmpHome, mockFetch, arkAddr, psbtPaying } from "./mockApi.mjs";

const URL_ = "http://escrow.test";
const other = (() => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; })();
const T = { title: "t", description: "d" };
async function ctx(routes) { tmpHome(); await uc.init("mutinynet"); return { c: await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: mockFetch(routes), swapFactory: async () => { throw new Error("no swap"); } }) }; }
const deal = (c, o = {}) => { const d = { id: "e1", state: "created", amountSats: 1200, deadline: new Date(Date.now() + 3600e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: other.p, arbiterPubkey: "22".repeat(32), rule: { type: "manual" }, arbiterMode: "auto", proposals: [], ...o };
  if (d.terms) d.termsHash ??= termsHash(termsDocument(normalizeTerms(d.terms), { network: "mutinynet", amountSats: d.amountSats, buyerPubkey: d.buyerPubkey, sellerPubkey: d.sellerPubkey })); return d; };
const sig = (d, s) => ({ sig: hex.encode(schnorr.sign(hex.decode(d.termsHash), s)), at: "t" });
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };

test("dealStatus lifecycle + arbiterPolicy", () => {
  const acc = { buyer: true, seller: true };
  assert.deepEqual(dealStatus({ state: "created", accepted: { buyer: false, seller: true }, proposals: [] }), { awaiting: "buyer_accept", action_required_for: "buyer" });
  assert.equal(dealStatus({ state: "created", accepted: { buyer: true, seller: false }, proposals: [] }).awaiting, "seller_accept");
  assert.deepEqual(dealStatus({ state: "created", accepted: acc, proposals: [] }), { awaiting: "buyer_funding", action_required_for: "buyer" });
  assert.deepEqual(dealStatus({ state: "funded", accepted: acc, proposals: [] }), { awaiting: "delivery", action_required_for: "seller" });
  assert.deepEqual(dealStatus({ state: "released", accepted: acc, proposals: [] }), { awaiting: "none", action_required_for: "none" });
  assert.equal(dealStatus({ state: "disputed", accepted: acc, proposals: [] }).action_required_for, "operator");
  const p = arbiterPolicy({ type: "manual" }, "auto"); assert.equal(p.mode, "auto"); assert.equal(p.releaseRule, "manual"); assert.match(p.autoRelease, /never automatically/); assert.match(p.timeoutRefund, /co-signs/);
  assert.match(arbiterPolicy({ type: "hash", sha256: "aa".repeat(32) }, "auto").autoRelease, /preimage/);
  assert.equal(arbiterPolicy({ type: "manual" }, "manual").timeoutRefund, "only by operator ruling");
});

test("show / status / accept carry awaiting + action_required_for + arbiterPolicy; prose next kept", async () => {
  let d; const { c } = await ctx({ "GET /escrows/e1": async () => [200, d], "POST /escrows/e1/accept": async (b) => { d.acceptances.buyer = { sig: b.sig, at: "now" }; return [200, d]; } });
  d = deal(c, { terms: T }); d.acceptances = { seller: sig(d, other.s) };
  let s = await uc.show(c, "e1"); assert.equal(s.awaiting, "buyer_accept"); assert.equal(s.action_required_for, "buyer"); assert.ok(s.next); assert.equal(s.arbiterPolicy.releaseRule, "manual");
  const a = await uc.accept(c, "e1"); assert.equal(a.awaiting, "buyer_funding"); assert.equal(a.action_required_for, "buyer");
  d.state = "funded"; const st = await uc.status(c, "e1"); assert.equal(st.awaiting, "delivery"); assert.equal(st.action_required_for, "seller");
});

test("evidence --file: hashed locally, signed, matched against terms deliverable-sha256; notice before funding", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-")); const fp = path.join(dir, "out.txt"); fs.writeFileSync(fp, "deliverable bytes");
  const h = crypto.createHash("sha256").update("deliverable bytes").digest("hex");
  let d, got; const { c } = await ctx({ "GET /escrows/e1": async () => [200, d], "POST /escrows/e1/evidence": async (b) => { got = b; return [201, { ...d, evidence: [...(d.evidence ?? []), b] }]; } });
  d = deal(c, { terms: { ...T, deliverableSha256: h }, state: "funded" });
  let r = await uc.addEvidence(c, "e1", { file: fp }); assert.equal(got.sha256, h); assert.match(got.text, /out\.txt/); assert.equal(r.deliverableMatch, true); assert.equal(r.warning, undefined);
  assert.equal(await code(uc.addEvidence(c, "e1", { file: fp, sha256: "00".repeat(32) })), "BAD_EVIDENCE");
  assert.equal(await code(uc.addEvidence(c, "e1", { file: path.join(dir, "missing") })), "BAD_EVIDENCE");
  fs.writeFileSync(fp, "other"); r = await uc.addEvidence(c, "e1", { file: fp, text: "v2" }); assert.equal(r.deliverableMatch, false); assert.match(r.warning, /NOT match/);
  d.evidence = [{ ...got }]; const s = await uc.show(c, "e1"); assert.equal(s.evidence?.[0]?.deliverableMatch ?? s.evidence?.items?.[0]?.deliverableMatch, false);
  d = deal(c, { terms: T, state: "created" }); r = await uc.addEvidence(c, "e1", { text: "hello" }); assert.match(r.notice, /do not deliver before state is funded/);
});

test("hash release: create --hash sets rule; approve --with arbiter --preimage posts preimage with [seller, arbiter]", async () => {
  let created, posted; const pre = "ab".repeat(32); const H = crypto.createHash("sha256").update(Buffer.from(pre, "hex")).digest("hex"); const dest = arkAddr(7);
  let c0; const e = () => deal(c0, { state: "funded", buyerPubkey: other.p, sellerPubkey: c0.pubkey, rule: { type: "hash", sha256: H }, funding: { outpoint: "x:0", amount: 1200 } });
  const { c } = await ctx({
    "POST /escrows": async (b) => { created = b; return [201, { ...deal(c0, { terms: T }), rule: b.rule }]; },
    "GET /escrows/e1": async () => [200, e()],
    "POST /escrows/e1/proposals": async (b) => { posted = b; return [201, { escrow: e(), proposal: { id: "p1" } }]; },
    "GET /escrows/e1/proposals/p1": async () => [200, { id: "p1", kind: "release", dest, signers: ["seller", "arbiter"], sigs: [], arkTx: psbtPaying(arkAddr(8), 1200), checkpoints: [] }],
  }); c0 = c;
  await uc.create(c, { role: "seller", counterparty: other.p, sats: 1200, deadline: 3600, hash: H, terms: T }).catch(() => {}); // mock returns a different termsHash; the POST body is what we check
  assert.deepEqual(created?.rule, { type: "hash", sha256: H });
  await uc.approve(c, "e1", { with: "arbiter", preimage: pre, payoutArk: dest }).catch(() => {}); // bogus tx -> UNSAFE_TX after posting
  assert.equal(posted.preimage, pre); assert.deepEqual(posted.signers, ["seller", "arbiter"]); assert.equal(posted.kind, "release");
});
