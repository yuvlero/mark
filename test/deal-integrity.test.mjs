// Audit 2026-10-22 HIGH 1 + HIGH 2: signed terms v2 (rule, arbiter mode, deadline, webhook hash bound into termsHash), local
// escrow-address derivation, arbiter identity pinning + per-deal attestation, https-only escrow URLs.
// An in-process "escrow server" (honest by default; tests make it lie). Ephemeral keys only.
import test from "node:test"; import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { normalizeUrl } from "../dist/src/config.js";
import { checkEscrowArgs } from "../dist/src/cliArgs.js";
import { termsHash, dealTermsDocument, webhookUrlHash, arbiterAttestationHash, verifyTermsSig } from "../dist/src/core/terms.js";
import { escrowAddress } from "../dist/src/core/escrowContract.js";
import { tmpHome, mockFetch } from "./mockApi.mjs";

const URL_ = "https://escrow.test";
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; };
const sigOf = (k, h) => hex.encode(schnorr.sign(hex.decode(h), k.s));
const T = { title: "Summarize a page", description: "300 words, markdown" };
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };

/** Honest v2 escrow server. o.v1 = old server (no termsVersions, no arbiter identity, no attestation). */
function server({ v1 = false } = {}) {
  const st = { identity: key(), serverPk: key().p, exitDelay: 512, deals: {}, swaps: 0 };
  st.attest = (d) => ({ v: "mark-escrow-arbiter/1", identityPubkey: st.identity.p, sig: sigOf(st.identity, arbiterAttestationHash({ network: "mutinynet", escrowId: d.id, arbiterPubkey: d.arbiterPubkey, serverPubkey: d.serverPubkey, exitDelay: d.exitDelay, address: d.address })) });
  st.seal = (d) => { d.address = escrowAddress({ ...d, network: "mutinynet" }); if (!v1) d.arbiterAttestation = st.attest(d); return d; };
  st.add = (d) => { const x = st.seal({ id: "d1", network: "mutinynet", state: "created", amountSats: 1200, arbiterPubkey: key().p, serverPubkey: st.serverPk, exitDelay: st.exitDelay, proposals: [], events: [], rule: { type: "manual" }, arbiterMode: "auto", fees: null, ...d }); st.deals[x.id] = x; return x; };
  st.routes = {
    "GET /limits": async () => [200, { network: "mutinynet", minDealSats: { lightning: 335, ark: 330, enforced: 335 }, maxDealSats: 1e6, dustSats: 330, freeBelowSats: null, fees: { enabled: false, terms: null },
      ...(v1 ? {} : { termsVersions: [1, 2], arbiter: { identityPubkey: st.identity.p, attestation: "mark-escrow-arbiter/1" } }) }],
    "POST /escrows": async (b) => {
      const d = { id: "d1", network: "mutinynet", state: "created", amountSats: b.amountSats, deadline: typeof b.deadline === "number" ? new Date(Date.now() + b.deadline * 1000).toISOString() : new Date(b.deadline).toISOString(),
        buyerPubkey: b.buyerPubkey, sellerPubkey: b.sellerPubkey, arbiterPubkey: key().p, serverPubkey: st.serverPk, exitDelay: st.exitDelay, rule: b.rule, arbiterMode: b.arbiterMode ?? "auto",
        terms: b.terms, termsHash: b.termsHash, acceptances: { [b.creatorAcceptance.party]: { sig: b.creatorAcceptance.sig, at: "x" } }, fees: null, proposals: [], events: [{ type: "created", data: { acceptedBy: [b.creatorAcceptance.party] } }],
        ...(v1 ? {} : { termsVersion: b.termsVersion === 2 ? 2 : 1, webhookUrlSha256: webhookUrlHash(b.webhookUrl) }) };
      st.lastCreate = b; st.deals.d1 = st.seal(d); return [201, d];
    },
    "GET /escrows/d1": async () => [200, st.deals.d1],
    "POST /escrows/d1/accept": async (b) => { const d = st.deals.d1; if (!verifyTermsSig(b.party === "buyer" ? d.buyerPubkey : d.sellerPubkey, d.termsHash, b.sig)) return [400, { error: "bad sig", code: "BAD_TERMS_SIGNATURE" }]; d.acceptances = { ...d.acceptances, [b.party]: { sig: b.sig, at: "x" } }; return [200, d]; },
  };
  return st;
}
async function ctx(st, o = {}) {
  if (!o.keepHome) tmpHome(); await uc.init("mutinynet");
  const swaps = { createReceive: async () => { st.swaps++; return { id: "sw" + st.swaps, invoice: "lntbs1x" }; } };
  return openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: mockFetch(st.routes), swapFactory: async () => swaps, ...(o.arbiterPubkey ? { arbiterPubkey: o.arbiterPubkey } : {}) });
}
/** A v2 deal both parties signed (this wallet = buyer unless role given). */
function v2Deal(st, c, other, { role = "buyer", rule = { type: "manual" }, signers = ["buyer", "seller"], webhookUrl, arbiterMode = "auto" } = {}) {
  const buyerPubkey = role === "buyer" ? c.pubkey : other.p, sellerPubkey = role === "buyer" ? other.p : c.pubkey;
  const deadline = new Date(Math.floor(Date.now() / 1000 + 86400) * 1000).toISOString();
  const d = { termsVersion: 2, network: "mutinynet", amountSats: 1200, buyerPubkey, sellerPubkey, fees: null, terms: T, rule, arbiterMode, deadline, webhookUrlSha256: webhookUrlHash(webhookUrl) };
  const h = termsHash(dealTermsDocument(d)); const ks = { [role]: { s: c.secret }, [role === "buyer" ? "seller" : "buyer"]: other };
  return st.add({ ...d, termsHash: h, acceptances: Object.fromEntries(signers.map((p) => [p, { sig: sigOf(ks[p], h), at: "x" }])), events: [{ type: "created", data: { acceptedBy: [signers[0] ?? "seller"] } }] });
}

test("create (v2 server): signs rule + mode + absolute deadline + webhook hash; deal re-verified; address and arbiter attested", async () => {
  const st = server(); const c = await ctx(st); const other = key();
  const e = await uc.create(c, { role: "buyer", counterparty: other.p, sats: 1200, deadline: 3600, hash: "ab".repeat(32), webhookUrl: "https://hooks.example/x?t=1", terms: T });
  const b = st.lastCreate;
  assert.equal(b.termsVersion, 2); assert.match(b.deadline, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
  assert.ok(Math.abs(Date.parse(b.deadline) - (Date.now() + 3600e3)) < 5000);
  const h = termsHash(dealTermsDocument({ termsVersion: 2, network: "mutinynet", amountSats: 1200, buyerPubkey: c.pubkey, sellerPubkey: other.p, fees: null, terms: T, rule: { type: "hash", sha256: "ab".repeat(32) }, arbiterMode: "auto", deadline: b.deadline, webhookUrlSha256: webhookUrlHash("https://hooks.example/x?t=1") }));
  assert.equal(b.termsHash, h); assert.ok(verifyTermsSig(c.pubkey, h, b.creatorAcceptance.sig));
  assert.equal(e.dealCheck.addressVerified, true); assert.equal(e.dealCheck.arbiter.attested, true); assert.equal(e.dealCheck.arbiter.pin, "first-use");
  assert.equal(e.termsWarning, undefined); assert.equal(c.index.get("d1").signedTermsHash, h);
});

test("create: a server that stores a different rule / deadline / webhook than signed is caught", async () => {
  for (const lie of [(d) => { d.rule = { type: "manual" }; }, (d) => { d.deadline = new Date(Date.parse(d.deadline) + 3600e3).toISOString(); }, (d) => { d.webhookUrlSha256 = webhookUrlHash("https://evil.example/"); }, (d) => { d.arbiterMode = "manual"; }]) {
    const st = server(); const honest = st.routes["POST /escrows"];
    st.routes["POST /escrows"] = async (b) => { const [s, d] = await honest(b); lie(d); st.seal(d); return [s, d]; };
    const c = await ctx(st);
    assert.equal(await code(uc.create(c, { role: "buyer", counterparty: key().p, sats: 1200, deadline: 3600, hash: "ab".repeat(32), terms: T })), "TERMS_HASH_MISMATCH");
  }
});

test("v1-only server: create still works (v1 terms) with a warning; arbiter unverified but the address is still checked", async () => {
  const st = server({ v1: true }); const c = await ctx(st);
  const e = await uc.create(c, { role: "buyer", counterparty: key().p, sats: 1200, deadline: 3600, terms: T });
  assert.equal(st.lastCreate.termsVersion, undefined); assert.equal(st.lastCreate.deadline, 3600);
  assert.match(e.termsWarning, /only supports signed terms v1/); assert.match(e.arbiterWarning, /does not publish an arbiter identity key/);
  assert.equal(e.dealCheck.addressVerified, true);
  // the same old server with a wrong address is refused
  const st2 = server({ v1: true }); const h = st2.routes["POST /escrows"]; st2.routes["POST /escrows"] = async (b) => { const [s, d] = await h(b); d.address = escrowAddress({ ...d, exitDelay: 513, network: "mutinynet" }); return [s, d]; };
  assert.equal(await code(uc.create(await ctx(st2), { role: "buyer", counterparty: key().p, sats: 1200, deadline: 3600, terms: T })), "ADDRESS_MISMATCH");
});

test("fund: v2 tampering after both signed (rule, deadline, webhook, arbiter mode) -> refused, no swap", async () => {
  for (const [what, lie] of [["rule", (d) => { d.rule = { type: "hash", sha256: "cd".repeat(32) }; }], ["deadline", (d) => { d.deadline = new Date(Date.now() + 60e3).toISOString(); }],
    ["webhook", (d) => { d.webhookUrlSha256 = webhookUrlHash("https://evil.example/"); }], ["arbiterMode", (d) => { d.arbiterMode = "manual"; }]]) {
    for (const rehash of [false, true]) {
      const st = server(); const c = await ctx(st); const other = key(); const d = v2Deal(st, c, other);
      c.index.set("d1", { role: "buyer", signedTermsHash: d.termsHash });
      lie(d); if (rehash) d.termsHash = termsHash(dealTermsDocument(d)); // a server lying consistently: new hash, old signatures
      const r = await code(uc.fund(c, "d1"));
      assert.ok(["TERMS_NOT_ACCEPTED", "TERMS_CHANGED"].includes(r), `${what} rehash=${rehash}: ${r}`); assert.equal(st.swaps, 0);
      // not re-hashed: accept refuses to sign; re-hashed: the seller's old signature no longer verifies (show says so)
      if (!rehash) assert.equal(await code(uc.accept(c, "d1")), "TERMS_HASH_MISMATCH", what);
      else { const v = await uc.show(c, "d1"); assert.equal(v.accepted.seller.signatureValid, false, what); assert.equal(v.agreed, false, what); }
    }
  }
});

test("fund: the server's address is not the contract of the deal's keys -> ADDRESS_MISMATCH, no swap; show flags it", async () => {
  const st = server(); const c = await ctx(st); const other = key(); const d = v2Deal(st, c, other);
  assert.equal((await uc.fund(c, "d1")).swapId, "sw1"); // honest: funds
  const st2 = server(); const c2 = await ctx(st2); const d2 = v2Deal(st2, c2, other);
  d2.address = escrowAddress({ ...d2, arbiterPubkey: key().p, network: "mutinynet" }); d2.arbiterAttestation = st2.attest(d2); // attacker address, even "attested"
  const err = await uc.fund(c2, "d1").catch((x) => x); assert.equal(err.code, "ADDRESS_MISMATCH"); assert.equal(st2.swaps, 0);
  assert.equal(err.details.serverAddress, d2.address);
  const s = await uc.show(c2, "d1"); assert.equal(s.dealCheck.ok, false); assert.equal(s.dealCheck.code, "ADDRESS_MISMATCH"); assert.match(s.next, /DEAL CHECK FAILED/);
  assert.equal(await code(uc.accept(c2, "d1")), "ADDRESS_MISMATCH");
});

test("arbiter identity: pinned on first use; a changed key, a missing key, a bad attestation are refused; explicit pin re-pins", async () => {
  const st = server(); const c = await ctx(st); const other = key(); v2Deal(st, c, other);
  assert.equal((await uc.fund(c, "d1")).dealCheck.arbiter.pin, "first-use");
  // operator key "rotates" (or an impersonator answers): refused loudly, nothing funded
  const old = st.identity; st.identity = key(); st.seal(st.deals.d1);
  const c2 = await ctx(st, { keepHome: true });
  const err = await uc.fund(c2, "d1").catch((x) => x); assert.equal(err.code, "ARBITER_KEY_CHANGED"); assert.match(err.message, /ARBITER KEY CHANGED/); assert.equal(err.details.pinned, old.p); assert.equal(st.swaps, 1);
  assert.equal(await code(uc.accept(c2, "d1")), "ARBITER_KEY_CHANGED");
  // explicit pin to the new key (confirmed out of band) -> accepted and re-pinned
  const c3 = await ctx(st, { keepHome: true, arbiterPubkey: st.identity.p });
  assert.equal((await uc.fund(c3, "d1")).dealCheck.arbiter.pin, "explicit");
  assert.equal((await uc.fund(await ctx(st, { keepHome: true }), "d1")).dealCheck.arbiter.pin, "match");
  // explicit pin that differs from the server -> mismatch
  assert.equal(await code(uc.fund(await ctx(st, { keepHome: true, arbiterPubkey: old.p }), "d1")), "ARBITER_KEY_MISMATCH");
  // server stops publishing the identity (downgrade) after a pin -> refused
  const lim = st.routes["GET /limits"]; st.routes["GET /limits"] = async () => { const [s, j] = await lim(); delete j.arbiter; return [s, j]; };
  assert.equal(await code(uc.fund(await ctx(st, { keepHome: true }), "d1")), "ARBITER_KEY_MISSING");
  st.routes["GET /limits"] = lim;
  // attestation signed by another key / missing -> refused
  st.deals.d1.arbiterAttestation = { ...st.deals.d1.arbiterAttestation, sig: sigOf(key(), "00".repeat(32)) };
  assert.equal(await code(uc.fund(await ctx(st, { keepHome: true }), "d1")), "ARBITER_ATTESTATION_INVALID");
  delete st.deals.d1.arbiterAttestation;
  assert.equal(await code(uc.fund(await ctx(st, { keepHome: true }), "d1")), "ARBITER_ATTESTATION_INVALID");
  // a bad explicit pin value is refused up front
  await assert.rejects(ctx(st, { keepHome: true, arbiterPubkey: "xyz" }), (x) => x.code === "BAD_PUBKEY");
});

test("v2 accept: a buyer must opt in to a seller-chosen rule when signing; fund then needs no second flag", async () => {
  const st = server(); const c = await ctx(st); const other = key();
  v2Deal(st, c, other, { rule: { type: "hash", sha256: "ab".repeat(32) }, signers: ["seller"] });
  const err = await uc.accept(c, "d1").catch((x) => x); assert.equal(err.code, "UNSAFE_RULE"); assert.match(err.message, /--allow-counterparty-rule/);
  assert.equal(st.deals.d1.acceptances.buyer, undefined);
  const r = await uc.accept(c, "d1", { allowCounterpartyRule: true }); assert.equal(r.termsVersion, 2); assert.equal(r.dealCheck.arbiter.attested, true);
  assert.equal(c.index.get("d1").signedTermsHash, st.deals.d1.termsHash);
  assert.equal((await uc.fund(c, "d1")).swapId, "sw1"); // signed rule = consent; no UNSAFE_RULE at fund
  // a v1 deal with the same seller rule still needs the fund-time opt-in (defense in depth for pre-v2 deals)
  const st1 = server({ v1: true }); const c1 = await ctx(st1);
  const d = st1.add({ buyerPubkey: c1.pubkey, sellerPubkey: other.p, deadline: new Date(Date.now() + 86400e3).toISOString(), terms: null, rule: { type: "hash", sha256: "ab".repeat(32) }, events: [{ type: "created", data: {} }] });
  assert.ok(d.address); assert.equal(await code(uc.fund(c1, "d1")), "UNSAFE_RULE");
});

test("escrow URL: http refused except localhost; CLI boolean --allow-counterparty-rule accepted", async () => {
  assert.throws(() => normalizeUrl("http://agentescrow.to"), (x) => x.code === "BAD_ESCROW_URL" && /insecure/.test(x.message));
  assert.throws(() => normalizeUrl("http://10.44.0.1:47831"), (x) => x.code === "BAD_ESCROW_URL");
  assert.equal(normalizeUrl("http://localhost:47831/"), "http://localhost:47831");
  assert.equal(normalizeUrl("http://127.0.0.1:47831"), "http://127.0.0.1:47831");
  assert.equal(normalizeUrl("http://[::1]:47831"), "http://[::1]:47831");
  assert.equal(normalizeUrl("https://agentescrow.to/"), "https://agentescrow.to");
  tmpHome(); await uc.init("mutinynet");
  await assert.rejects(openCtx("mutinynet", { escrowUrl: "http://agentescrow.to" }), (x) => x.code === "BAD_ESCROW_URL");
  assert.ok(!checkEscrowArgs("fund", "d1", { "allow-counterparty-rule": true }));
  assert.ok(!checkEscrowArgs("accept", "d1", { "allow-counterparty-rule": true }));
});
