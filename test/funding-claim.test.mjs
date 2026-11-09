// 0.3.1 funding fixes: the unpaid invoice is shown again, --wait claims clientredeeming, a failed claim stops with the real
// error, timeouts name the swap status, --resume-claim, the Satora claim wrapper (real error + upstream resume-bug workaround),
// and swap storage written by @satora/swap 1.7.0 still loads. All swaps are mocked: no network, no money.
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import * as btc from "@scure/btc-signer"; import { schnorr } from "@noble/curves/secp256k1.js";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { checkEscrowArgs, parseArgs } from "../dist/src/cliArgs.js";
import { SatoraProvider } from "../dist/src/swap/satora.js";
import { libTransactionBases, withTaprootWitnessScriptFix, WORKAROUND_ID } from "../dist/src/swap/satoraWorkaround.js";
import { encryptWith } from "../dist/src/crypto/keystore.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";

const OTHER = "11".repeat(32); const URL_ = "https://escrow.test"; const INV = "lntbs50090n1testinvoice";
const deal = (c, o = {}) => ({ id: "e1", state: "created", amountSats: 5000, deadline: new Date(Date.now() + 86400e3).toISOString(), address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: OTHER, arbiterPubkey: "22".repeat(32), proposals: [], terms: null, ...o });
/** swaps: mock provider; statuses: sequence returned by get (last one repeats). */
function mockSwaps({ statuses = ["pending"], invoice, claim } = {}) {
  const n = { create: 0, get: 0, claim: 0 }; let i = 0;
  const s = { name: "mock",
    createReceive: async () => { n.create++; return { id: "sw1", invoice: INV, amountSats: 5000, status: "pending" }; },
    get: async () => { n.get++; const st = statuses[Math.min(i++, statuses.length - 1)]; return { id: "sw1", direction: "ln_to_ark", status: st, ...(invoice ? { invoice } : {}) }; },
    claim: async (id, addr) => { n.claim++; s.lastClaim = { id, addr }; return claim ? claim() : { success: true, txid: "t1" }; } };
  return { s, n };
}
async function ctx(swaps, dealOf = (c) => deal(c)) {
  tmpHome(); await uc.init("mutinynet"); let c0;
  const f = mockFetch({ "GET /escrows/e1": async () => [200, dealOf(c0)], "POST /escrows/e1/funding-swap": async () => [200, { recorded: true }] });
  const c = await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f, swapFactory: async () => swaps }); c0 = c; return c;
}

test("fund: a later fund on a still-unpaid swap returns the same invoice (persisted at creation); a paid swap never re-offers it", async () => {
  const { s, n } = mockSwaps({ statuses: ["pending"] }); const c = await ctx(s);
  const first = await uc.fund(c, "e1"); assert.equal(first.invoice, INV); assert.equal(first.newSwap, true); assert.equal(c.index.get("e1").fundInvoice, INV);
  const again = await uc.fund(c, "e1"); assert.equal(again.invoice, INV); assert.equal(again.newSwap, false); assert.equal(again.swapStatus, "pending"); assert.equal(n.create, 1);
  assert.match(again.note, /pay the invoice, then run: mark escrow fund e1 --wait/);
  const paid = mockSwaps({ statuses: ["clientredeeming"] }); const c2 = await ctx(paid.s); c2.index.set("e1", { fundSwap: "sw1", fundInvoice: INV });
  const r = await uc.fund(c2, "e1"); assert.equal(r.invoice, undefined); assert.equal(r.paymentReceived, true); assert.match(r.note, /Do NOT pay again/); assert.match(r.note, /--resume-claim/);
});
test("fund: a swap created by Mark 0.3.0 (no saved invoice) gets its unpaid invoice from the swap provider and saves it", async () => {
  const { s } = mockSwaps({ statuses: ["pending"], invoice: INV }); const c = await ctx(s); c.index.set("e1", { fundSwap: "sw1" });
  const r = await uc.fund(c, "e1"); assert.equal(r.invoice, INV); assert.equal(c.index.get("e1").fundInvoice, INV);
});
test("fund --wait: clientredeeming (claim started, not finished) is claimed into the escrow address", async () => {
  const { s, n } = mockSwaps({ statuses: ["pending", "clientredeeming"] }); const c = await ctx(s, (c) => deal(c, n.claim ? { state: "funded" } : {}));
  const r = await uc.fund(c, "e1", { wait: true, timeoutSec: 5, pollMs: 5 });
  assert.equal(n.claim, 1); assert.equal(s.lastClaim.addr, r.escrowAddress); assert.match(r.escrowAddress, /^tark1/); assert.equal(r.claim.success, true); assert.equal(r.escrow.state, "funded");
});
test("fund --wait: a claim with success:false stops at once with the swap status and the library's real error", async () => {
  const { s, n } = mockSwaps({ statuses: ["serverfunded", "clientredeeming"], claim: () => ({ success: false, message: "All VTXOs have already been spent.", detail: "finalizing the pending claim failed: boom" }) });
  const c = await ctx(s); const t = Date.now();
  const r = await uc.fund(c, "e1", { wait: true, timeoutSec: 30, pollMs: 5 });
  assert.ok(Date.now() - t < 5000, "no loop to timeout"); assert.equal(n.claim, 1); assert.equal(r.claimFailed, true); assert.equal(r.swapStatus, "clientredeeming");
  assert.match(r.note, /claim into the escrow failed \(swap status clientredeeming\)/); assert.match(r.note, /boom/); assert.match(r.note, /Do NOT pay the invoice again/); assert.match(r.note, /mark escrow fund e1 --resume-claim/);
  assert.doesNotMatch(r.note, /waiting for payment/);
  const k = mockSwaps({ statuses: ["serverfunded"], claim: () => ({ success: false, message: "Failed to execute offchain Arkade claim: INVALID_CHECKPOINT_PSBT (2): malformed checkpoint psbt" }) });
  const r2 = await uc.fund(await ctx(k.s), "e1", { wait: true, timeoutSec: 5, pollMs: 5 }); assert.match(r2.note, /@satora\/swap < 1\.8\.1/);
});
test("fund --wait: the timeout note names the last swap status", async () => {
  for (const [st, re] of [["pending", /^timeout: swap status pending, payment not received yet/], ["clientfunded", /^timeout: swap status clientfunded, payment seen.*Do NOT pay again/], ["weird", /^timeout: swap status weird/]]) {
    const { s } = mockSwaps({ statuses: [st] }); const r = await uc.fund(await ctx(s), "e1", { wait: true, timeoutSec: 0.05, pollMs: 5 });
    assert.equal(r.timedOut, true); assert.equal(r.swapStatus, st); assert.match(r.note, re); assert.doesNotMatch(r.note, /waiting for payment/);
  }
  assert.match(uc.fundTimeoutNote("e1", "clientredeeming"), /^timeout: swap status clientredeeming, claim not finished/);
});
test("fund --resume-claim: claims the recorded swap into the escrow, never creates a swap; refuses without a swap; nothing to resume while unpaid", async () => {
  const { s, n } = mockSwaps({ statuses: ["clientredeeming"] }); const c = await ctx(s, (c) => deal(c, n.claim ? { state: "funded" } : {}));
  assert.equal((await uc.fund(c, "e1", { resumeClaim: true }).catch((e) => e)).code, "NOT_FOUND"); assert.equal(n.create, 0);
  c.index.set("e1", { fundSwap: "sw1" });
  const r = await uc.fund(c, "e1", { resumeClaim: true }); assert.equal(n.claim, 1); assert.equal(n.create, 0); assert.equal(r.claim.success, true); assert.equal(s.lastClaim.addr, r.escrowAddress);
  const p = mockSwaps({ statuses: ["pending"] }); const c2 = await ctx(p.s); c2.index.set("e1", { fundSwap: "sw1" });
  const r2 = await uc.fund(c2, "e1", { resumeClaim: true }); assert.equal(p.n.claim, 0); assert.match(r2.note, /nothing to resume: swap status pending/);
  const f = mockSwaps({ statuses: ["clientredeeming"], claim: () => ({ success: false, message: "x", detail: "real reason" }) }); const c3 = await ctx(f.s); c3.index.set("e1", { fundSwap: "sw1" });
  const r3 = await uc.fund(c3, "e1", { resumeClaim: true }); assert.equal(r3.claimFailed, true); assert.match(r3.note, /real reason/);
});
test("CLI: --resume-claim is a fund flag without a value and not combined with --wait", () => {
  assert.equal(checkEscrowArgs("fund", "e1", parseArgs(["escrow", "fund", "e1", "--resume-claim"]).f), null);
  assert.match(checkEscrowArgs("fund", "e1", { "resume-claim": true, wait: true }).message, /without --wait/);
  assert.match(checkEscrowArgs("show", "e1", { "resume-claim": true }).message, /only for escrow fund/);
});

// ---------- Satora wrapper with a mocked library ----------
const provider = (client) => new SatoraProvider(client, "https://swap.test", "https://ark.test");
test("satora claim: the generic 'already spent' is replaced by the finalize step's real error", async () => {
  const p = provider({ claimArkade: async () => ({ success: false, message: "All VTXOs have already been spent." }), continueArkadeClaimSwap: async () => ({ success: false, message: "INVALID_SIGNATURE: bad tapscript sig" }) });
  const r = await p.claim("sw1", "tark1x"); assert.equal(r.success, false); assert.match(r.detail, /INVALID_SIGNATURE: bad tapscript sig/);
  const thrown = provider({ claimArkade: async () => { throw new Error("socket hang up"); } }); assert.match((await thrown.claim("sw1", "a")).message, /socket hang up/);
});
test("satora claim: library console.log goes to stderr, never stdout (CLI JSON / MCP stdio)", async () => {
  const w = process.stdout.write; let out = "";
  process.stdout.write = (x, ...a) => { out += x; return true; };
  try { await provider({ claimArkade: async () => { console.log("No pending Arkade claim found; submitting a new claim"); return { success: true, txId: "t" }; } }).claim("sw1", "a"); }
  finally { process.stdout.write = w; }
  assert.equal(out, "");
});
test("satora claim: upstream resume bug (witnessScript without P2WSH) is retried once with the workaround and succeeds", async () => {
  class FakeTx { getInput() { return { tapLeafScript: [[{}, new Uint8Array([1])]] }; } updateInput(_i, inp) { if (inp.witnessScript) throw new Error("checkScript: witnessScript without P2WSH"); } }
  let calls = 0;
  const p = provider({ claimArkade: async () => ({ success: false, message: "All VTXOs have already been spent." }),
    continueArkadeClaimSwap: async () => { calls++; try { new FakeTx().updateInput(0, { witnessScript: new Uint8Array([1]) }); return { success: true, txId: "arktx1" }; } catch (e) { return { success: false, message: e.message }; } } });
  p.txBases = async () => [FakeTx.prototype];
  const r = await p.claim("sw1", "a"); assert.equal(r.success, true); assert.equal(r.txid, "arktx1"); assert.equal(r.workaround, WORKAROUND_ID); assert.equal(r.workaroundApplied, 1); assert.equal(calls, 2);
  assert.throws(() => new FakeTx().updateInput(0, { witnessScript: 1 }), /without P2WSH/, "original method restored");
  // no workaround possible: the real error is still surfaced
  const q = provider({ claimArkade: async () => ({ success: false, message: "All VTXOs have already been spent." }), continueArkadeClaimSwap: async () => ({ success: false, message: "checkScript: witnessScript without P2WSH" }) });
  q.txBases = async () => []; const r2 = await q.claim("sw1", "a"); assert.equal(r2.success, false); assert.match(r2.detail, /witnessScript without P2WSH/); assert.match(r2.detail, /upstream/);
  // other errors: no workaround
  let used = false; const o = provider({ claimArkade: async () => ({ success: false, message: "No VTXOs found at the VHTLC address x." }) }); o.txBases = async () => { used = true; return []; };
  assert.equal((await o.claim("sw1", "a")).success, false); assert.equal(used, false);
});
test("workaround against the installed library: its bundled Transaction rejects witnessScript on a taproot input; the fix drops only that", async () => {
  const bases = await libTransactionBases(); assert.ok(bases.length >= 1, "found the library's Transaction class");
  const dist = path.dirname(fileURLToPathSafe(import.meta.resolve("@lendasat/lendaswap-sdk-pure")));
  const chunk = fs.readFileSync(path.join(dist, "index.js"), "utf8").match(/Transaction as Transaction\$1[^}]*\}\s*from\s*'(\.\/chunk-[\w-]+\.js)'/)[1];
  const { Transaction } = await import(new URL(chunk, "file://" + dist + "/").href);
  const pk = schnorr.getPublicKey(schnorr.utils.randomSecretKey()); const leaf = btc.Script.encode([pk, "CHECKSIG"]);
  const pay = btc.p2tr(undefined, [{ script: leaf }], undefined, true);
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0, witnessUtxo: { script: pay.script, amount: 1000n }, tapLeafScript: pay.tapLeafScript });
  assert.throws(() => tx.updateInput(0, { witnessScript: leaf }), /witnessScript without P2WSH/, "upstream bug still present (remove the workaround when this fails)");
  const { dropped } = await withTaprootWitnessScriptFix(bases, async () => { tx.updateInput(0, { witnessScript: leaf, sighashType: 1 }); });
  assert.equal(dropped, 1); assert.equal(tx.getInput(0).witnessScript, undefined); assert.equal(tx.getInput(0).sighashType, 1, "other fields of the update still applied");
  assert.throws(() => tx.updateInput(0, { witnessScript: leaf }), /without P2WSH/, "restored after the call");
});
function fileURLToPathSafe(u) { return decodeURIComponent(new URL(u).pathname); }

test("swap storage written by @satora/swap 1.7.0 (version 2 record) loads with 1.8.1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-swaps-")); const key = crypto.randomBytes(32);
  const rec = { version: 2, swapId: "36a7c6f9-0000-4000-8000-000000000000", keyIndex: 3, publicKey: "02" + "ab".repeat(32), preimage: "cd".repeat(32), preimageHash: "ef".repeat(32), secretKey: "12".repeat(32),
    storedAt: 1, updatedAt: 1, targetAddress: "tark1x", response: { id: "36a7c6f9-0000-4000-8000-000000000000", direction: "lightning_to_arkade", status: "pending", sender_pk: "34".repeat(32), arkade_server_pk: "56".repeat(32),
      arkade_vhtlc_address: "tark1v", vhtlc_refund_locktime: 1, unilateral_claim_delay: 512, unilateral_refund_delay: 512, unilateral_refund_without_receiver_delay: 1024, network: "signet", bolt11_invoice: "lntbs1x" } };
  fs.mkdirSync(path.join(dir, "swaps")); fs.writeFileSync(path.join(dir, "swaps", "swaps.enc.json"), JSON.stringify(encryptWith(key, JSON.stringify({ [rec.swapId]: rec }))));
  const p = await SatoraProvider.create({ baseUrl: "http://127.0.0.1:9", arkServerUrl: "http://127.0.0.1:9", esploraUrl: "http://127.0.0.1:9", bitcoinNetwork: "signet", mnemonic: "abandon ".repeat(11) + "about", key, dir });
  const got = await p.c.getStoredSwap(rec.swapId); assert.deepEqual(got, rec);
  const k = await p.c.continueArkadeClaimSwap(rec.swapId); assert.equal(k.success, false); assert.doesNotMatch(k.message, /not found in local storage|Expected an Arkade/, "record parsed; it fails later on the (unreachable) server");
});

test("fund --wait: once the swap is paid the result never carries the (paid) invoice, also on failure, expiry and timeout", async () => {
  const ok = mockSwaps({ statuses: ["pending", "serverfunded"] }); const shown = [];
  const c = await ctx(ok.s, (c) => deal(c, ok.n.claim ? { state: "funded" } : {}));
  const r = await uc.fund(c, "e1", { wait: true, timeoutSec: 5, pollMs: 5, onInvoice: (x) => shown.push(x) });
  assert.equal(shown.length, 1); assert.equal(shown[0].invoice, INV, "the invoice is shown while unpaid");
  assert.equal(r.claim.success, true); assert.equal(r.invoice, undefined); assert.equal(r.paymentReceived, true);
  const bad = mockSwaps({ statuses: ["pending", "serverfunded", "clientredeeming"], claim: () => ({ success: false, message: "x" }) });
  const r2 = await uc.fund(await ctx(bad.s), "e1", { wait: true, timeoutSec: 5, pollMs: 5 }); assert.equal(r2.claimFailed, true); assert.equal(r2.invoice, undefined); assert.equal(r2.paymentReceived, true);
  const slow = mockSwaps({ statuses: ["pending", "clientfunded"] });
  const r3 = await uc.fund(await ctx(slow.s), "e1", { wait: true, timeoutSec: 0.1, pollMs: 5 }); assert.equal(r3.swapStatus, "clientfunded"); assert.equal(r3.invoice, undefined); assert.equal(r3.paymentReceived, true);
  let n = 0; const exp = mockSwaps({ statuses: ["pending", "serverfunded"] });
  const r4 = await uc.fund(await ctx(exp.s, (c) => deal(c, n++ >= 1 ? { state: "expired" } : {})), "e1", { wait: true, timeoutSec: 5, pollMs: 5 });
  assert.equal(r4.state, "expired"); assert.equal(r4.invoice, undefined); assert.equal(exp.n.claim, 0);
  const still = mockSwaps({ statuses: ["pending"] });
  const r5 = await uc.fund(await ctx(still.s), "e1", { wait: true, timeoutSec: 0.05, pollMs: 5 }); assert.equal(r5.invoice, INV, "still unpaid: the invoice stays");
});
test("fund: swap status unreadable -> fail closed, no saved invoice shown; failed swap -> no invoice (also in demo)", async () => {
  const s = { name: "mock", get: async () => { throw new Error("swap provider down"); }, createReceive: async () => { throw new Error("no"); } };
  const c = await ctx(s); c.index.set("e1", { fundSwap: "sw1", fundInvoice: INV });
  const r = await uc.fund(c, "e1"); assert.equal(r.invoice, undefined); assert.equal(r.swapStatus, "unknown"); assert.equal(r.paymentReceived, null); assert.match(r.note, /no invoice is shown/);
  const f = mockSwaps({ statuses: ["clientfundedserverrefunded"] }); const c2 = await ctx(f.s); c2.index.set("e1", { fundSwap: "sw1", fundInvoice: INV });
  const r2 = await uc.fund(c2, "e1"); assert.equal(r2.invoice, undefined); assert.match(r2.note, /swap ended as clientfundedserverrefunded/);
});
test("fund: resumeClaim with wait is refused for every caller (CLI, MCP, API)", async () => {
  const { s } = mockSwaps(); const c = await ctx(s); c.index.set("e1", { fundSwap: "sw1" });
  assert.equal((await uc.fund(c, "e1", { resumeClaim: true, wait: true }).catch((e) => e)).code, "USAGE");
});
test("satora claim: concurrent claims run one at a time (global console / workaround patches never overlap)", async () => {
  let active = 0, maxActive = 0;
  const slow = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; return { success: true, txId: "t" }; };
  const p = provider({ claimArkade: slow }); const q = provider({ claimArkade: slow });
  const rs = await Promise.all([p.claim("a", "x"), q.claim("b", "y"), p.claim("c", "z")]);
  assert.ok(rs.every((r) => r.success)); assert.equal(maxActive, 1);
  const failing = provider({ claimArkade: async () => { throw new Error("boom"); } }); await failing.claim("d", "w");
  assert.equal((await p.claim("e", "v")).success, true, "a failed claim does not block the queue"); assert.equal(typeof console.log, "function");
});

test("fund: concurrent first calls create ONE funding swap and return the same invoice", async () => {
  let creates = 0;
  const s = { name: "mock", createReceive: async () => { creates++; await new Promise((r) => setTimeout(r, 30)); return { id: "sw" + creates, invoice: INV + creates, amountSats: 5000, status: "pending" }; },
    get: async (id) => ({ id, direction: "ln_to_ark", status: "pending", invoice: "lntbs-from-provider" }) };
  const c = await ctx(s);
  const rs = await Promise.all([uc.fund(c, "e1"), uc.fund(c, "e1"), uc.fund(c, "e1")]);
  assert.equal(creates, 1); assert.deepEqual(new Set(rs.map((r) => r.swapId)), new Set(["sw1"])); assert.ok(rs.every((r) => r.invoice === INV + "1"));
  assert.equal(rs.filter((r) => r.newSwap).length, 1); assert.equal(c.index.get("e1").fundSwap, "sw1");
  assert.deepEqual(fs.readdirSync(c.dir).filter((f) => f.endsWith(".lock")), [], "lock file removed");
});
test("fund: a stale lock file left by a crashed process is taken over; a fresh one from another process makes fund wait", async () => {
  const { s, n } = mockSwaps({ statuses: ["pending"] }); const c = await ctx(s);
  const lock = path.join(c.dir, `fund-${crypto.createHash("sha256").update("e1").digest("hex").slice(0, 16)}.lock`);
  fs.writeFileSync(lock, "999999"); const old = new Date(Date.now() - 300e3); fs.utimesSync(lock, old, old);
  const r = await uc.fund(c, "e1"); assert.equal(r.invoice, INV); assert.equal(n.create, 1); assert.equal(fs.existsSync(lock), false);
  const { s: s2, n: n2 } = mockSwaps({ statuses: ["pending"] }); const c2 = await ctx(s2); const lock2 = path.join(c2.dir, path.basename(lock)); fs.writeFileSync(lock2, "1");
  let done = false; const p = uc.fund(c2, "e1").then((x) => { done = true; return x; });
  await new Promise((r) => setTimeout(r, 200)); assert.equal(done, false, "waits for the other process"); assert.equal(n2.create, 0);
  fs.rmSync(lock2); const r2 = await p; assert.equal(r2.invoice, INV); assert.equal(n2.create, 1);
});
test("fund --wait: a deal that is released/refunded meanwhile is not reported as funded by this claim", async () => {
  for (const [st, funded] of [["refunded", false], ["released", false], ["funded", true], ["disputed", true]]) {
    let n = 0; const m = mockSwaps({ statuses: ["pending", "serverfunded"] });
    const r = await uc.fund(await ctx(m.s, (c) => deal(c, n++ >= 1 ? { state: st } : {})), "e1", { wait: true, timeoutSec: 5, pollMs: 5 });
    assert.equal(m.n.claim, 0); assert.equal(!!r.escrow, funded, st); assert.equal(r.invoice, undefined);
    if (!funded) assert.match(r.note, new RegExp(`deal is ${st}: NOT claimed`));
  }
});
test("fund --wait: a stale 'pending' read after a failed claim never brings the paid invoice back", async () => {
  const m = mockSwaps({ statuses: ["pending", "serverfunded", "pending"], claim: () => ({ success: false, message: "x" }) });
  const r = await uc.fund(await ctx(m.s), "e1", { wait: true, timeoutSec: 5, pollMs: 5 });
  assert.equal(r.claimFailed, true); assert.equal(r.invoice, undefined); assert.equal(r.paymentReceived, true);
});
test("fund: an ended swap reports paymentReceived null (unknown), never false, and no invoice", async () => {
  const m = mockSwaps({ statuses: ["clientfundedtoolate"] }); const c = await ctx(m.s); c.index.set("e1", { fundSwap: "sw1", fundInvoice: INV });
  const r = await uc.fund(c, "e1"); assert.equal(r.paymentReceived, null); assert.equal(r.invoice, undefined);
});
