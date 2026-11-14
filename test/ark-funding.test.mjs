// 0.4.0: direct Ark funding (fund --ark), "this escrow runs on the Arkade server" checks for every Ark address, and /limits
// arkade info. Escrow API and swaps are mocked: no network, no money, Mark never sends anything.
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs";
import { ArkAddress } from "@arkade-os/sdk";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { checkEscrowArgs, parseArgs } from "../dist/src/cliArgs.js";
import { tmpHome, mockFetch, arkAddr, payoutArk, MOCK_SERVER_PK } from "./mockApi.mjs";

const OTHER = "11".repeat(32), URL_ = "https://escrow.test", ARKD = "https://mutinynet.arkade.sh";
const deal = (c, o = {}) => ({ id: "e1", state: "created", amountSats: 5000, deadline: new Date(Date.now() + 86400e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: OTHER, arbiterPubkey: "22".repeat(32), proposals: [], terms: null, ...o });
const LIM = (o = {}) => ({ network: "mutinynet", minDealSats: { lightning: 335, ark: 330, enforced: 335 }, maxDealSats: 1e6, freeBelowSats: null, dustSats: 330, fees: { enabled: false, terms: null }, satora: { minSats: 335, maxSats: 1e6 },
  arkServer: { url: ARKD, pubkey: MOCK_SERVER_PK, network: "mutinynet", addressPrefix: "tark1" }, ...o });
const swapsWith = (status) => ({ name: "mock", get: async () => ({ id: "sw1", status }), createReceive: async () => ({ id: "sw2", invoice: "lntbs1x", status: "pending" }), claim: async () => ({ success: true }) });
async function ctx({ dealOf = (c) => deal(c), limits = LIM(), routes = {}, swaps = swapsWith("pending") } = {}) {
  tmpHome(); await uc.init("mutinynet"); let c0;
  const f = mockFetch({ "GET /escrows/e1": async () => [200, dealOf(c0)], "GET /limits": async () => limits ? [200, limits] : [404, { error: "x", code: "NOT_FOUND" }], ...routes });
  const c = await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => swaps }); c0 = c; return { c, f };
}
const code = (p) => p.then(() => "OK", (e) => e.code);

test("CLI args: --ark / --switch-rail are fund-only flags without a value; --ark excludes --resume-claim", () => {
  const chk = (argv) => { const { pos, f } = parseArgs(argv); return checkEscrowArgs(pos[0], pos[1], f); };
  assert.equal(chk(["fund", "e1", "--ark"]), null); assert.equal(chk(["fund", "e1", "--ark", "--wait"]), null); assert.equal(chk(["fund", "e1", "--switch-rail"]), null);
  assert.match(chk(["fund", "--ark", "e1"]).message, /escrow id required|takes no value/);
  assert.match(chk(["approve", "e1", "--ark"]).message, /only for escrow fund/);
  assert.match(chk(["fund", "e1", "--ark", "--resume-claim"]).message, /not --ark/);
});

test("fund --ark: escrow address, exact sats, the Arkade server (url from /limits, key = the deal's); one rail per deal", async () => {
  const { c, f } = await ctx();
  const r = await uc.fundArk(c, "e1");
  assert.equal(r.rail, "ark"); assert.match(r.escrowAddress, /^tark1/); assert.equal(r.payTo.address, r.escrowAddress); assert.equal(r.payTo.amountSats, 5000);
  assert.equal(r.payTo.arkServer.url, ARKD); assert.equal(r.payTo.arkServer.pubkey, MOCK_SERVER_PK); assert.equal(r.payTo.arkServer.addressPrefix, "tark1");
  assert.equal(r.dealCheck.addressVerified, true, "address derived locally before it is shown");
  const how = r.howToPay.join(" "); assert.match(how, /exactly 5000 sats/); assert.match(how, /ONE payment/); assert.match(how, /NOT added up/); assert.match(how, /Bark/); assert.match(how, new RegExp(ARKD.replace(/\./g, "\\.")));
  assert.match(r.note, /fund e1 --ark --wait/); assert.equal(c.index.get("e1").fundRail, "ark");
  assert.equal(f.calls.filter((x) => x.key.startsWith("POST")).length, 0, "nothing posted, nothing sent");
  assert.equal(await code(uc.fund(c, "e1")), "FUNDING_IN_PROGRESS", "Lightning after Ark: refused (double funding)");
  const again = await uc.fundArk(c, "e1"); assert.equal(again.payTo.amountSats, 5000, "re-running shows the same instructions");
});

test("fund --ark refuses while a Lightning invoice may still be paid; --switch-rail or a failed swap allows it", async () => {
  let { c } = await ctx({ swaps: swapsWith("pending") }); c.index.set("e1", { fundSwap: "sw1", fundRail: "lightning" });
  await assert.rejects(uc.fundArk(c, "e1"), (e) => e.code === "FUNDING_IN_PROGRESS" && /--switch-rail/.test(e.message) && e.details.swapStatus === "pending");
  assert.equal((await uc.fundArk(c, "e1", { switchRail: true })).rail, "ark");
  ({ c } = await ctx({ swaps: swapsWith("expired") })); c.index.set("e1", { fundSwap: "sw1" });
  assert.equal((await uc.fundArk(c, "e1")).rail, "ark", "expired swap: nothing can be paid there");
  ({ c } = await ctx({ swaps: { get: async () => { throw new Error("down"); } } })); c.index.set("e1", { fundSwap: "sw1" });
  assert.equal(await code(uc.fundArk(c, "e1")), "FUNDING_IN_PROGRESS", "unknown swap status: fail closed");
});

test("fund --ark --wait: funded (overpay reported, rail recorded); underpaid timeout; expired; already funded; deadline too close", async () => {
  let n = 0; let posted = 0;
  let { c } = await ctx({ dealOf: (c) => deal(c, ++n > 2 ? { state: "funded", funding: { outpoint: "ab:0", amount: 5600 } } : {}), routes: { "POST /escrows/e1/funding-ark": async () => { posted++; return [200, { escrowId: "e1", recorded: true, rail: "ark" }]; } } });
  const seen = []; const r = await uc.fundArk(c, "e1", { wait: true, timeoutSec: 5, pollMs: 5, onInstructions: (x) => seen.push(x) });
  assert.equal(seen.length, 1, "instructions printed before waiting"); assert.equal(r.funded, true); assert.equal(r.state, "funded"); assert.equal(r.overpaidSats, 600); assert.equal(posted, 1); assert.equal(r.ledger.rail, "ark");
  ({ c } = await ctx({ dealOf: (c) => deal(c, { underpaid: { vtxos: [{ outpoint: "cd:0", amount: 3000 }], totalSats: 3000, seenAt: "x" } }) }));
  const u = await uc.fundArk(c, "e1", { wait: true, timeoutSec: 0.05, pollMs: 5 }); assert.equal(u.timedOut, true); assert.match(u.note, /3000 sats arrived/); assert.match(u.note, /NOT funded/); assert.equal(u.underpaid.totalSats, 3000);
  ({ c } = await ctx({ dealOf: (c) => deal(c, { state: "funded", funding: { outpoint: "ab:0", amount: 5000 } }), routes: { "POST /escrows/e1/funding-ark": async () => [404, { error: "no route", code: "NOT_FOUND" }] } }));
  assert.equal((await uc.fundArk(c, "e1")).note, "already funded");
  let k = 0; ({ c } = await ctx({ dealOf: (c) => deal(c, ++k > 1 ? { state: "funded", funding: { outpoint: "ab:0", amount: 5000 } } : {}), routes: { "POST /escrows/e1/funding-ark": async () => [404, { error: "no route", code: "NOT_FOUND" }] } }));
  const old = await uc.fundArk(c, "e1", { wait: true, timeoutSec: 5, pollMs: 5 }); assert.equal(old.funded, true); assert.equal(old.ledger.recorded, false); assert.match(old.ledger.error, /older server/);
  ({ c } = await ctx({ dealOf: (c) => deal(c, { state: "expired", expiredAt: "x" }) })); assert.match((await uc.fundArk(c, "e1")).note, /^expired/);
  ({ c } = await ctx({ dealOf: (c) => deal(c, { expiresAt: new Date(Date.now() + 120e3).toISOString() }) })); assert.equal(await code(uc.fundArk(c, "e1")), "DEADLINE_TOO_CLOSE");
});

test("Ark payouts: refused early unless the address is on this deal's Arkade server (message names the server, says Bark will not work)", async () => {
  const { c, f } = await ctx({ dealOf: (c) => deal(c, { state: "funded", funding: { outpoint: "x:0", amount: 5000 } }) });
  const other = new ArkAddress(new Uint8Array(32).fill(7), new Uint8Array(32).fill(1), "tark").encode();
  await assert.rejects(uc.refund(c, "e1", { payoutArk: other }), (e) => e.code === "BAD_DEST" && e.details.reason === "wrong_ark_server" && e.message.includes(ARKD) && /Bark/.test(e.message) && /Lightning/.test(e.message));
  await assert.rejects(uc.refund(c, "e1", { payoutArk: payoutArk(3, "ark") }), (e) => e.code === "BAD_DEST" && e.details.reason === "wrong_network");
  await assert.rejects(uc.refund(c, "e1", { payoutArk: "tark1nope" }), (e) => e.code === "BAD_DEST" && e.details.reason === "not_ark_address");
  assert.equal(f.calls.filter((x) => x.key.startsWith("POST")).length, 0, "nothing proposed");
  c.index.set("e1", { payoutSwap: "sw9" });
  await assert.rejects(uc.refundPayout(c, "e1", other), (e) => e.code === "BAD_DEST" && e.message.startsWith("--to"));
});

test("limits: arkade = the server's Arkade URL + key; Mark preset when the server says nothing or sends a junk URL", async () => {
  let { c } = await ctx(); let l = await uc.limits(c);
  assert.deepEqual({ url: l.arkade.url, pubkey: l.arkade.pubkey, prefix: l.arkade.addressPrefix }, { url: ARKD, pubkey: MOCK_SERVER_PK, prefix: "tark1" }); assert.match(l.arkade.note, /Bark/); assert.equal(l.arkade.warnings, undefined);
  ({ c } = await ctx({ limits: LIM({ arkServer: undefined }) })); l = await uc.limits(c); assert.equal(l.arkade.url, ARKD); assert.equal(l.arkade.source, "Mark network preset"); assert.equal(l.arkade.pubkey, null);
  ({ c } = await ctx({ limits: LIM({ arkServer: { url: "javascript:alert(1)\u001b[2J", pubkey: "zz" } }) })); l = await uc.limits(c); assert.equal(l.arkade.url, ARKD); assert.equal(l.arkade.pubkey, null);
  ({ c } = await ctx({ limits: LIM({ arkServer: { url: "https://other.example", pubkey: MOCK_SERVER_PK } }) })); l = await uc.limits(c); assert.equal(l.arkade.url, "https://other.example"); assert.match(l.arkade.warnings[0], /preset/);
});

test("MCP + help: every Ark field and the fund tool say Arkade server / not Bark", () => {
  const src = fs.readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  assert.match(src, /rail: z\.enum\(\["lightning", "ark"\]\)/); assert.match(src, /Bark \/ Second Ark addresses will NOT work/); assert.match(src, /payoutArk: z\.string\(\)\.optional\(\)\.describe\(ARK_ONLY\)/);
});

test("review: rail transitions are authoritative; already-funded entry reports the Ark rail; refund-payout fails closed without a key", async () => {
  // Lightning -> Ark (switch) -> plain fund refused; fund --ark --wait needs no second switch
  let { c } = await ctx({ swaps: swapsWith("pending") }); c.index.set("e1", { fundSwap: "sw1", fundRail: "lightning" });
  await uc.fundArk(c, "e1", { switchRail: true }); assert.equal(c.index.get("e1").fundRail, "ark");
  assert.equal(await code(uc.fund(c, "e1")), "FUNDING_IN_PROGRESS", "old invoice not reopened after switching to Ark");
  assert.equal((await uc.fundArk(c, "e1")).rail, "ark", "Ark again without --switch-rail");
  // Ark -> Lightning (switch, reusing the swap) -> Ark refused without a switch
  await uc.fund(c, "e1", { switchRail: true }).catch(() => {}); assert.equal(c.index.get("e1").fundRail, "lightning");
  assert.equal(await code(uc.fundArk(c, "e1")), "FUNDING_IN_PROGRESS");
  // paid, then `fund --ark` again: already funded -> rail reported once
  let posted = 0;
  ({ c } = await ctx({ dealOf: (c) => deal(c, { state: "funded", funding: { outpoint: "ab:0", amount: 5000 } }), routes: { "POST /escrows/e1/funding-ark": async () => { posted++; return [200, { escrowId: "e1", recorded: true, rail: "ark" }]; } } }));
  c.index.set("e1", { fundRail: "ark" }); const r = await uc.fundArk(c, "e1", { wait: true, timeoutSec: 1, pollMs: 5 });
  assert.equal(r.note, "already funded"); assert.equal(posted, 1); assert.equal(r.ledger.rail, "ark");
  c.index.set("e1", { fundRail: "lightning" }); await uc.fundArk(c, "e1"); assert.equal(posted, 1, "not reported for a Lightning-funded deal");
  // refund-payout with deal and /limits unreachable: no key -> refused, swaps.refund never called
  let refunded = 0;
  ({ c } = await ctx({ limits: null, routes: { "GET /escrows/e1": async () => [500, { error: "down", code: "ERROR" }] }, swaps: { ...swapsWith("pending"), refund: async () => { refunded++; return {}; } } }));
  c.index.set("e1", { payoutSwap: "sw9" });
  await assert.rejects(uc.refundPayout(c, "e1", payoutArk(4)), (e) => e.code === "BAD_DEST" && e.details.reason === "arkade_key_unknown" && e.message.includes(ARKD));
  assert.equal(refunded, 0);
});

test("review 2: near the deadline a chosen Ark rail never gets instructions again; --wait only watches", async () => {
  const near = (c) => deal(c, { expiresAt: new Date(Date.now() + 120e3).toISOString() });
  let { c } = await ctx({ dealOf: near }); c.index.set("e1", { fundRail: "ark" });
  assert.equal(await code(uc.fundArk(c, "e1")), "DEADLINE_TOO_CLOSE", "no instructions, even on the chosen rail");
  const seen = []; const w = await uc.fundArk(c, "e1", { wait: true, timeoutSec: 0.05, pollMs: 5, onInstructions: (x) => seen.push(x) });
  assert.equal(w.payTo, null); assert.equal(w.escrowAddress, null); assert.match(w.howToPay[0], /do not pay now/); assert.equal(seen[0].payTo, null);
  ({ c } = await ctx({ dealOf: (c) => deal(c, { expiresAt: new Date(Date.now() + 120e3).toISOString(), underpaid: { vtxos: [{ outpoint: "cd:0", amount: 3000 }], totalSats: 3000, seenAt: "x" } }) })); c.index.set("e1", { fundRail: "ark" });
  const u = await uc.fundArk(c, "e1", { wait: true, timeoutSec: 0.05, pollMs: 5 }); assert.equal(u.timedOut, true);
  assert.match(u.note, /do not send anything/); assert.doesNotMatch(u.note, /Pay \d+ sats/); assert.match(u.note, /NOT funded/);
  ({ c } = await ctx({ limits: LIM({ arkServer: { url: "http://evil.example", pubkey: MOCK_SERVER_PK } }) })); assert.equal((await uc.limits(c)).arkade.url, ARKD, "http only for localhost");
  ({ c } = await ctx({ dealOf: (c) => deal(c, { expiresAt: new Date(Date.now() - 5e3).toISOString() }) })); c.index.set("e1", { fundRail: "ark" });
  assert.equal(await code(uc.fundArk(c, "e1")), "DEADLINE_TOO_CLOSE", "past expiresAt while still created");
  ({ c } = await ctx()); const r = await uc.fundArk(c, "e1"); assert.match(r.howToPay.at(-1), /--switch-rail/, "Lightning fallback names the switch on the first call");
});

test("server classifies the rail: an old Lightning swap in this home is reported first, then the funding-ark nudge", async () => {
  const order = [];
  const { c } = await ctx({ dealOf: (c) => deal(c, { state: "funded", funding: { outpoint: "ab:0", amount: 5000 } }), routes: {
    "POST /escrows/e1/funding-swap": async () => { order.push("swap"); return [200, { escrowId: "e1" }]; },
    "POST /escrows/e1/funding-ark": async () => { order.push("ark"); return [200, { escrowId: "e1", recorded: true, rail: "ark" }]; } } });
  c.index.set("e1", { fundRail: "ark", fundSwap: "11111111-2222-3333-4444-555555555555" });
  const r = await uc.fundArk(c, "e1"); assert.deepEqual(order, ["ark"], "pending (unclaimed) old swap: not reported"); assert.equal(r.ledger.rail, "ark");
  const { c: c2 } = await ctx({ swaps: swapsWith("clientredeemed"), dealOf: (c) => deal(c, { state: "funded", funding: { outpoint: "ab:0", amount: 5000 } }), routes: {
    "POST /escrows/e1/funding-swap": async () => { order.push("swap"); return [200, { escrowId: "e1" }]; },
    "POST /escrows/e1/funding-ark": async () => { order.push("ark"); return [200, { escrowId: "e1", recorded: false, rail: "lightning" }]; } } });
  order.length = 0; c2.index.set("e1", { fundRail: "ark", fundSwap: "11111111-2222-3333-4444-555555555555" });
  await uc.fundArk(c2, "e1"); assert.deepEqual(order, ["swap", "ark"], "claimed old swap: reported first, the server decides");
});
