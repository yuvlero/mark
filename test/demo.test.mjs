// House-seller demo: `mark demo` / MCP escrow_demo against a stateful mock server (GET /demo, create, seller auto-accept, funding swap, delivery).
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { evidenceHash, messageHash } from "../dist/src/core/terms.js";
import { checkDemoArgs, parseArgs, DEMO_USAGE } from "../dist/src/cliArgs.js";
import { tmpHome, mockFetch, arkAddr, psbtPaying } from "./mockApi.mjs";
import { makeInvoice } from "./helpers.mjs";

const SELLER_SK = schnorr.utils.randomSecretKey(); const SELLER = hex.encode(schnorr.getPublicKey(SELLER_SK));
const SUMMARY = { id: "summary", sellerPubkey: SELLER, titlePrefix: "Automaton summary", sats: 350, deadlineSeconds: 86400, deadlineMinutes: 1440, turnaround: "usually within minutes, at most 1 hour after funding", summary: "page summary", feeFree: true,
  description: { format: "Key: value", fields: [{ key: "URL", type: "url", maxLength: 2000 }, { key: "Text", type: "text", maxLength: 3500 }, { key: "Focus", type: "text", maxLength: 300 }, { key: "Words", type: "int", min: 50, max: 400, default: 200 }], oneOf: [["URL", "Text"]] } };
const RESEARCH = { id: "research", sellerPubkey: SELLER, titlePrefix: "Automaton research", sats: 1500, deadlineSeconds: 86400, turnaround: "within 6 hours", feeFree: true,
  description: { fields: [{ key: "Question", type: "text", required: true, maxLength: 1500 }, { key: "Words", type: "int", min: 300, max: 1200, default: 700 }] } };
const OFFER = (o = {}, items = [SUMMARY, RESEARCH]) => ({ enabled: true, network: "mutinynet", default: "summary", offers: items.map((x) => ({ ...x, ...(x.id === "summary" ? o : {}) })), sellerPubkey: SELLER, sats: 350 });
const URLIN = { fields: { URL: "https://example.com/blog/post" } };
const TERMS = { title: "Automaton summary: example.com/blog/post", description: "URL: https://example.com/blog/post\nWords: 200" };
const FEES = { v: 2, freeBelowSats: 3300, flatSats: 330, flatUntilSats: 33000, feeBps: 100, disputeFeeBps: 500, disputeMinSats: 330, dustSats: 330, address: arkAddr(9) };
const LIMITS = { network: "mutinynet", minDealSats: { lightning: 335, ark: 330, enforced: 335 }, maxDealSats: 1000000, freeBelowSats: 3300, dustSats: 330, fees: { enabled: true, terms: FEES }, satora: { minSats: 1000, maxSats: 1000000 } };
const DEST = arkAddr(7); const sign = (h) => hex.encode(schnorr.sign(hex.decode(h), SELLER_SK));

/** Stateful mock: one deal (created by POST /escrows). The house seller accepts on the 2nd GET; `step(deal)` mutates it per test. */
async function setup({ offer = OFFER(), network = "mutinynet", swaps = {} } = {}) {
  tmpHome(); await uc.init(network);
  let deal = null; let gets = 0; const msgs = []; const counts = { create: 0, receive: 0, claim: 0 };
  const routes = {
    "GET /demo": async () => (offer === 404 ? [404, { error: "no route", code: "NOT_FOUND" }] : [200, offer]),
    "GET /limits": async () => [200, { ...LIMITS, network }],
    "POST /escrows": async (b) => { counts.create++; deal = { id: "d1", state: "created", address: arkAddr(5), arbiterPubkey: "22".repeat(32), proposals: [], evidence: [], fees: FEES, ...b, terms: b.terms, termsHash: b.termsHash, acceptances: { [b.creatorAcceptance.party]: { sig: b.creatorAcceptance.sig, at: "t0" } } }; delete deal.creatorAcceptance; return [201, deal]; },
    "GET /escrows/d1": async () => { if (++gets >= 2 && deal && !deal.acceptances.seller) deal.acceptances.seller = { sig: sign(deal.termsHash), at: "t1" }; return [200, deal]; },
    "GET /escrows/d1/proposals/p1": async () => [200, { id: "p1", kind: "release", dest: DEST, signers: ["buyer", "seller"], sigs: ["seller"], payout: { type: "ark", address: DEST }, arkTx: psbtPaying(DEST, 350), checkpoints: [] }],
    "GET /escrows/d1/messages": async () => [200, { escrowId: "d1", state: deal.state, arbiterPubkey: deal.arbiterPubkey, buyerPubkey: deal.buyerPubkey, sellerPubkey: deal.sellerPubkey, messages: msgs, cursor: msgs.length }],
    "POST /escrows/d1/funding-swap": async () => [200, { escrowId: "d1", recorded: true }],
  };
  const f = mockFetch(routes);
  const swap = { name: "mock", createReceive: async (sats) => { counts.receive++; return { id: "sw1", invoice: makeInvoice({ sats: sats + 5, network: network === "bitcoin" ? "bitcoin" : "mutinynet" }), amountSats: sats, status: "pending" }; },
    get: swaps.get ?? (async () => ({ id: "sw1", direction: "ln_to_ark", status: "pending" })), claim: async () => { counts.claim++; deal.state = "funded"; deal.funding = { outpoint: "x:0", amount: 350 }; return { success: true, txid: "t" }; } };
  const c = await openCtx(network, { escrowUrl: "https://escrow.test", fetchImpl: f, swapFactory: async () => swap });
  const say = (body) => { const ts = 1700000100 + msgs.length; const id = messageHash("d1", "seller", ts, { body }); msgs.push({ seq: msgs.length + 1, id, escrowId: "d1", author: "seller", pubkey: SELLER, body, ts, createdAt: "t3", sig: sign(id) }); };
  return { c, f, counts, deal: () => deal, say, msgs };
}
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };

test("demo unavailable: enabled:false or an old server (404) -> clear message, nothing created", async () => {
  for (const [offer, want] of [[{ enabled: false, network: "mutinynet", code: "DEMO_NOT_CONFIGURED", error: "none" }, "DEMO_NOT_CONFIGURED"], [404, "DEMO_NOT_SUPPORTED"]]) {
    const { c, f, counts } = await setup({ offer });
    const r = await uc.demo(c, { confirm: true, ...URLIN });
    assert.equal(r.demo, "unavailable"); assert.equal(r.enabled, false); assert.equal(r.code, want); assert.match(r.message, /Nothing was created/); assert.ok(r.next);
    assert.equal(counts.create, 0); assert.ok(!f.calls.some((x) => x.key.startsWith("POST")));
  }
});
test("demo preview without inputs: real-money + not-instant notice up front, 3 steps, the inputs the offer needs; nothing created", async () => {
  const { c, f, counts } = await setup({ network: "bitcoin", offer: { ...OFFER(), network: "bitcoin" } });
  const r = await uc.demo(c);
  assert.equal(r.demo, "preview"); assert.equal(Object.keys(r)[1], "notice"); assert.equal(r.realMoney, true);
  assert.match(r.notice, /REAL DEAL, REAL MONEY/); assert.match(r.notice, /costing 350 sats/); assert.match(r.notice, /Not instant: delivery usually within minutes, at most 1 hour after funding/);
  assert.equal(r.steps.length, 3); assert.match(r.steps[1], /mark escrow fund <id> --wait/); assert.match(r.steps[2], /mark escrow messages <id>/); assert.match(r.steps[2], /mark escrow approve <id>/);
  assert.deepEqual(r.missing, ["--url or --text"]); assert.equal(r.offer.id, "summary"); assert.equal(r.offer.sats, 350); assert.deepEqual(r.offer.otherOffers, ["research"]);
  assert.deepEqual(r.offer.inputs.find((x) => x.key === "Words"), { flag: "--words", key: "Words", required: false, type: "int", default: 200, min: 50, max: 400 });
  assert.match(r.next, /nothing was created/); assert.match(r.next, /mark demo --url https:\/\/example\.com\/page/);
  assert.equal(counts.create, 0); assert.deepEqual(f.calls.map((x) => x.key), ["GET /demo"]);
  const t = await setup(); assert.match((await uc.demo(t.c)).notice, /no real money/);
});
test("demo preview with --url: exact terms (title prefix + topic, description only Key: value lines, Words default), consent command", async () => {
  const { c, counts } = await setup();
  const r = await uc.demo(c, URLIN);
  assert.deepEqual(r.terms, TERMS); assert.equal(r.terms.description.split("\n").every((l) => /^[A-Z][A-Za-z]*: \S/.test(l)), true);
  assert.match(r.next, /mark demo --url "https:\/\/example\.com\/blog\/post" --yes --expect-sats 350/); assert.equal(counts.create, 0);
  const w = await uc.demo(c, { fields: { URL: "https://example.com/x", Words: "120", Focus: "pricing" }, topic: "Pricing page" });
  assert.deepEqual(w.terms, { title: "Automaton summary: Pricing page", description: "URL: https://example.com/x\nFocus: pricing\nWords: 120" });
  const q = await uc.demo(c, { offer: "research", fields: { Question: "Which Lightning wallets support BOLT12?" } });
  assert.deepEqual(q.terms, { title: "Automaton research: Which Lightning wallets support BOLT12?", description: "Question: Which Lightning wallets support BOLT12?\nWords: 700" }); assert.equal(q.offer.sats, 1500);
});
test("demo inputs are validated locally before anything is created", async () => {
  const bad = [[{ fields: { URL: "http://example.com" } }, "DEMO_BAD_INPUT", /https/], [{ fields: { URL: "not a url" } }, "DEMO_BAD_INPUT", /https/], [{ fields: { URL: "https://e.com", Words: "20" } }, "DEMO_BAD_INPUT", /50 to 400/],
    [{ fields: { URL: "https://e.com", Words: "2x0" } }, "DEMO_BAD_INPUT", /whole number/], [{ fields: { URL: "https://e.com", Question: "q" } }, "DEMO_BAD_INPUT", /--question is not used by the summary offer/],
    [{ fields: { URL: "https://e.com", Text: "t" } }, "DEMO_BAD_INPUT", /only one of --url or --text/], [{ fields: { URL: "https://e.com", Focus: "a\nb" } }, "DEMO_BAD_INPUT", /one line/],
    [{ fields: {} }, "DEMO_INPUT_REQUIRED", /needs --url or --text/], [{ offer: "research", fields: {} }, "DEMO_INPUT_REQUIRED", /needs --question/], [{ offer: "nope", ...URLIN }, "DEMO_UNKNOWN_OFFER", /no demo offer 'nope'/]];
  for (const [inp, want, re] of bad) {
    const { c, counts } = await setup();
    await assert.rejects(uc.demo(c, { confirm: true, ...inp }), (e) => e.code === want && re.test(e.message), JSON.stringify(inp)); assert.equal(counts.create, 0);
  }
});
test("demo refuses unsafe or changed offers before creating anything", async () => {
  for (const [o, want] of [[{ sats: 3300 }, "DEMO_UNSAFE_OFFER"], [{ sats: 0 }, "DEMO_UNSAFE_OFFER"], [{ deadlineSeconds: 10 }, "DEMO_UNSAFE_OFFER"], [{ sellerPubkey: "zz" }, "BAD_PUBKEY"], [{ description: { fields: [] } }, "DEMO_UNSAFE_OFFER"]]) {
    const { c, counts } = await setup({ offer: OFFER(o) }); assert.equal(await code(uc.demo(c, { confirm: true, ...URLIN })), want, JSON.stringify(o)); assert.equal(counts.create, 0);
  }
  const m = await setup({ offer: { ...OFFER(), network: "bitcoin" } }); assert.equal(await code(uc.demo(m.c, { confirm: true, ...URLIN })), "DEMO_NETWORK_MISMATCH");
  const { c, counts } = await setup(); assert.equal(await code(uc.demo(c, { confirm: true, expectSats: 3000, ...URLIN })), "DEMO_OFFER_CHANGED"); assert.equal(counts.create, 0);
});
test("demo --yes: creates as buyer with the built terms (create use case), 86400 s deadline, waits for the seller's accept, returns the invoice + accurate next", async () => {
  const { c, f, counts, deal } = await setup(); const progress = [];
  const r = await uc.demo(c, { confirm: true, expectSats: 350, pollMs: 5, onProgress: (x) => progress.push(x), ...URLIN });
  const post = f.calls.find((x) => x.key === "POST /escrows").body;
  assert.equal(post.buyerPubkey, c.pubkey); assert.equal(post.sellerPubkey, SELLER); assert.equal(post.amountSats, 350); assert.equal(post.deadline, 86400);
  assert.deepEqual(post.terms, TERMS); assert.equal(post.creatorAcceptance.party, "buyer"); assert.ok(post.termsHash);
  assert.equal(progress[0].demo, "created"); assert.match(progress[0].next, /waiting up to \d+ s for the seller to accept/);
  assert.equal(r.demo, "awaiting_payment"); assert.equal(r.escrowId, "d1"); assert.equal(r.created, true); assert.equal(r.state, "created");
  assert.match(r.invoice, /^lntbs/); assert.equal(r.invoiceSats, 355); assert.equal(r.swapId, "sw1"); assert.equal(counts.receive, 1);
  assert.match(r.next, /pay the Lightning invoice \(355 sats\)/); assert.match(r.next, /mark escrow fund d1 --wait/); assert.match(r.next, /funding stays pending until you run it/);
  assert.match(r.steps[2], /mark escrow messages d1/); assert.equal(r.feeSummary.normalPayout.feeOutputSats, 0, "under 3,300 sats: no platform fee");
  assert.equal(c.index.get("d1").demo, true); assert.equal(c.index.get("d1").role, "buyer"); assert.ok(deal().acceptances.seller);
  // running it again resumes the same deal: no second deal, no second swap, same invoice
  const again = await uc.demo(c, { confirm: true, ...URLIN });
  assert.equal(again.resumed, true); assert.match(again.note, /nothing new was created/); assert.equal(again.escrowId, "d1"); assert.equal(again.invoice, r.invoice); assert.equal(counts.create, 1); assert.equal(counts.receive, 1);
  assert.match(again.notice, /at most 1 hour after funding/, "turnaround remembered on resume");
});
test("demo: seller has not accepted yet -> seller_accept phase, nothing to pay, decline reason pointer", async () => {
  const { c, counts } = await setup();
  const r = await uc.demo(c, { confirm: true, acceptTimeoutSec: 0, ...URLIN });
  assert.equal(r.demo, "seller_accept"); assert.match(r.next, /Nothing to pay yet/); assert.match(r.next, /mark escrow messages d1/); assert.equal(counts.receive, 0); assert.equal(r.invoice, undefined);
});
test("demo --wait: prints the invoice, claims the payment (fund --wait), waits for the delivery in the thread, offers mark escrow approve", async () => {
  const s = await setup({ swaps: { get: async () => ({ id: "sw1", direction: "ln_to_ark", status: "serverfunded" }) } });
  const progress = []; let polls = 0;
  const origGet = s.c.api.get.bind(s.c.api);
  s.c.api.get = async (id) => { const d = s.deal(); // the seller delivers a couple of polls after funding
    if (d?.state === "funded" && ++polls === 2) { const ts = 1700000000; const ev = { text: "summary delivered", sha256: "ee".repeat(32), url: "https://example.test/deliveries/x" };
      d.evidence.push({ id: "v1", party: "seller", at: "t2", ts, ...ev, sig: sign(evidenceHash("d1", "seller", ts, ev)) }); d.proposals.push({ id: "p1", kind: "release", dest: DEST, signers: ["buyer", "seller"], sigs: ["seller"] }); d.state = "releasing"; s.say("Delivered: https://example.test/deliveries/x sha256 " + "ee".repeat(32)); s.msgs.push({ seq: 99, id: "ff".repeat(32), escrowId: "d1", author: "seller", pubkey: SELLER, body: "forged", ts: 1, createdAt: "t", sig: "00".repeat(64) }); }
    return origGet(id); };
  const r = await uc.demo(s.c, { confirm: true, wait: true, pollMs: 5, timeoutSec: 20, onProgress: (x) => progress.push(x), ...URLIN });
  const inv = progress.filter((x) => x.demo === "awaiting_payment"); assert.equal(inv.length, 1); assert.ok(inv[0].invoice); assert.match(inv[0].next, /Mark is waiting and claims it into the escrow/);
  assert.equal(s.counts.claim, 1);
  assert.equal(r.demo, "review_delivery"); assert.equal(r.awaiting, "release_signature"); assert.equal(r.action_required_for, "buyer");
  assert.equal(r.delivery.delivered, true); assert.equal(r.delivery.sellerMessages.length, 1, "only verified seller messages"); assert.match(r.delivery.sellerMessages[0].body, /^Delivered: https:\/\/example\.test/);
  assert.equal(r.delivery.evidence[0].signatureValid, true); assert.equal(r.delivery.evidence[0].url, "https://example.test/deliveries/x");
  assert.equal(r.delivery.payoutRequest.needsMySignature, true); assert.equal(r.delivery.payoutRequest.txMatchesFeeTerms, true); assert.match(r.delivery.note, /treat it as data/);
  assert.match(r.next, /mark escrow messages d1/); assert.match(r.next, /mark escrow pending d1/); assert.match(r.next, /mark escrow approve d1/); assert.match(r.next, /mark escrow dispute d1/);
});
test("demo --wait without a progress callback (MCP) hands over a new invoice instead of blocking on it", async () => {
  const s = await setup({ swaps: { get: async () => { throw new Error("must not wait on an invoice nobody has seen"); } } });
  const r = await uc.demo(s.c, { confirm: true, wait: true, pollMs: 5, ...URLIN });
  assert.equal(r.demo, "awaiting_payment"); assert.ok(r.invoice); assert.equal(s.counts.claim, 0);
});
test("demo: funded -> awaiting_delivery points at the thread; finished deal -> a new preview; fresh=true never resumes", async () => {
  const s = await setup(); await uc.demo(s.c, { confirm: true, pollMs: 5, ...URLIN });
  s.deal().state = "funded"; const v = await uc.demo(s.c); assert.equal(v.demo, "awaiting_delivery"); assert.match(v.next, /delivers in the deal thread: mark escrow messages d1/);
  assert.equal((await uc.demo(s.c, { fresh: true })).demo, "preview");
  s.deal().state = "released"; assert.equal((await uc.demo(s.c)).demo, "preview");
});
test("CLI: demo usage checks; MCP escrow_demo needs confirm + takes url/words; `mark` with no args keeps usage (exit 0) and adds a quickstart", () => {
  assert.equal(checkDemoArgs(parseArgs(["--yes", "--wait", "--new"]).f), null); assert.equal(checkDemoArgs(parseArgs(["--url", "https://x.y", "--words", "100", "--expect-sats", "350", "--timeout", "60"]).f), null);
  for (const a of [["--yes", "now"], ["--expect-sats", "3k"], ["--timeout"], ["--wait=1"], ["--url"]]) assert.equal(checkDemoArgs(parseArgs(a).f)?.code, "USAGE", a.join(" "));
  assert.match(DEMO_USAGE, /--yes/); assert.match(DEMO_USAGE, /--url/); assert.match(DEMO_USAGE, /--words/);
  const mcp = fs.readFileSync(new URL("../dist/src/mcp.js", import.meta.url), "utf8"); assert.match(mcp, /"escrow_demo"/); assert.match(mcp, /confirm: confirm === true/); assert.match(mcp, /url: z\.string\(\)/); assert.match(mcp, /words: z\.number\(\)/);
  tmpHome(); const cli = new URL("../dist/src/cli.js", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli], { env: process.env, encoding: "utf8" }); assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout); assert.match(j.usage, /^mark <init\|pubkey\|demo\|/); assert.equal(j.defaultNetwork, "bitcoin"); assert.equal(j.quickstart.firstRun, true);
  assert.equal(j.quickstart.steps.length, 3); for (const [i, w] of [[0, "mark init"], [1, "mark demo"], [2, "docs"]]) assert.ok(j.quickstart.steps[i].includes(w), w);
  const u = spawnSync(process.execPath, [cli, "demo", "--timeout", "x"], { env: process.env, encoding: "utf8" }); assert.equal(u.status, 1); assert.equal(JSON.parse(u.stdout).code, "USAGE");
});
