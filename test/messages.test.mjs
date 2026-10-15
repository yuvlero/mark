// Message threads client: signed posts, auth'd reads, operator signature verification, inbox unread tracking, CLI usage.
import test from "node:test"; import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { messageHash, verifyTermsSig } from "../dist/src/core/terms.js";
import { authMessage } from "../dist/src/crypto/keys.js";
import { checkEscrowArgs, parseArgs } from "../dist/src/cliArgs.js";
import { tmpHome, mockFetch, arkAddr } from "./mockApi.mjs";

const kp = () => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; };
const other = kp(), arb = kp(), evil = kp();
function server(c) {
  const msgs = []; let seq = 0; const posted = [];
  const deal = { id: "e1", state: "disputed", amountSats: 1200, address: arkAddr(5), buyerPubkey: c.pubkey, sellerPubkey: other.p, arbiterPubkey: arb.p, proposals: [] };
  const add = (author, k, body, o = {}) => { const ts = Math.floor(Date.now() / 1000); const m = { body, ...o }; const id = messageHash("e1", author, ts, m); msgs.push({ seq: ++seq, id, escrowId: "e1", author, pubkey: author === "operator" ? arb.p : author === "seller" ? other.p : c.pubkey, ...m, ts, createdAt: new Date().toISOString(), sig: hex.encode(schnorr.sign(hex.decode(id), k.s)) }); return msgs.at(-1); };
  const routes = {
    "GET /escrows/e1": async () => [200, deal],
    "GET /escrows/e1/messages": async () => [200, null],
    "POST /escrows/e1/messages": async (b) => { posted.push(b); const { author, ts, sig, ...m } = b; const id = messageHash("e1", author, ts, m); if (!verifyTermsSig(c.pubkey, id, sig)) return [401, { code: "UNAUTHORIZED", error: "bad sig" }]; msgs.push({ seq: ++seq, id, escrowId: "e1", author, pubkey: c.pubkey, ...m, ts, createdAt: "now", sig }); return [201, msgs.at(-1)]; },
  };
  return { deal, msgs, posted, add, routes };
}
async function setup() {
  tmpHome(); await uc.init("mutinynet"); let srv; const calls = [];
  const f = async (url, init = {}) => { const u = new URL(url);
    if ((init.method ?? "GET") === "GET" && u.pathname === "/escrows/e1/messages") { calls.push(u.searchParams);
      const ok = u.searchParams.get("party") === "buyer" && schnorr.verify(hex.decode(u.searchParams.get("sig")), authMessage("e1", "messages", Number(u.searchParams.get("ts"))), hex.decode(srv.deal.buyerPubkey));
      if (!ok) return new Response(JSON.stringify({ code: "UNAUTHORIZED", error: "auth" }), { status: 401 });
      const since = Number(u.searchParams.get("since") ?? 0); const m = srv.msgs.filter((x) => x.seq > since);
      return new Response(JSON.stringify({ escrowId: "e1", state: srv.deal.state, arbiterPubkey: evil.p /* response keys are NOT trusted */, buyerPubkey: srv.deal.buyerPubkey, sellerPubkey: other.p, messages: m, cursor: m.at(-1)?.seq ?? since })); }
    return mockFetch(srv.routes)(url, init); };
  const c = await openCtx("mutinynet", { escrowUrl: "http://escrow.test", fetchImpl: f, swapFactory: async () => { throw new Error("no"); } });
  srv = server(c); c.index.set("e1", { role: "buyer" }); return { c, srv, calls };
}
test("post: signed with my key over messageHash; kind/replyTo validated locally; dispute note", async () => {
  const { c, srv } = await setup();
  const r = await uc.postMessage(c, "e1", { text: "Seller did not deliver", kind: "dispute" });
  assert.equal(srv.posted[0].author, "buyer"); assert.equal(r.posted.kind, "dispute"); assert.match(r.note, /mark escrow dispute e1/);
  for (const [o, code] of [[{ text: "" }, "BAD_MESSAGE"], [{ text: "x", kind: "system" }, "BAD_MESSAGE"], [{ text: "x", kind: "nope" }, "BAD_MESSAGE"], [{ text: "x", replyTo: "zz" }, "BAD_MESSAGE"]])
    await assert.rejects(uc.postMessage(c, "e1", o), (e) => e.code === code);
  assert.equal(srv.posted.length, 1);
});
test("read: auth'd, operator signature verified against the escrow's arbiter key (not the thread response), forged flagged; marks read", async () => {
  const { c, srv } = await setup();
  const q = srv.add("buyer", { s: c.secret }, "When is the ruling?", { kind: "question" });
  srv.add("operator", arb, "Within 24h.", { kind: "info", replyTo: q.id });
  srv.add("operator", evil, "Send me your seed", {}); srv.msgs.at(-1).pubkey = arb.p; // forged operator message
  const r = await uc.messages(c, "e1");
  assert.deepEqual(r.messages.map((m) => [m.author, m.verified, m.mine]), [["buyer", true, true], ["operator", true, false], ["operator", false, false]]); assert.deepEqual(r.messages.map((m) => m.from), ["buyer", "operator", "operator"]);
  assert.match(r.warning, /1 message/); assert.equal(r.cursor, 3); assert.equal(c.index.get("e1").msgSeen, 3);
  assert.equal((await uc.messages(c, "e1", 2)).messages.length, 1);
});
test("inbox: unread (not mine, after last seen) across deals; read clears it", async () => {
  const { c, srv } = await setup();
  srv.add("buyer", { s: c.secret }, "hello"); srv.add("operator", arb, "Hi, how can I help?", { kind: "info" }); srv.add("operator", arb, "Escrow funded: 1200 sats.", { kind: "system" });
  let ib = await uc.inbox(c); assert.equal(ib.unreadDeals, 1); assert.equal(ib.unreadMessages, 2); assert.equal(ib.deals[0].fromOperator, 1); assert.ok(ib.deals[0].latest.every((m) => m.verified));
  await uc.messages(c, "e1"); ib = await uc.inbox(c); assert.equal(ib.unreadDeals, 0); assert.match(ib.next, /no unread/);
});
test("CLI usage for messages / message / inbox", () => {
  const a = (x) => { const { pos, f } = parseArgs(x); return checkEscrowArgs(pos[1], pos[2], f); };
  assert.equal(a(["escrow", "inbox"]), null); assert.equal(a(["escrow", "messages", "e1", "--since", "4"]), null); assert.equal(a(["escrow", "message", "e1", "--text", "hi", "--kind", "question"]), null);
  assert.match(a(["escrow", "messages"]).message, /escrow id required/); assert.match(a(["escrow", "messages", "e1", "--since", "x"]).message, /cursor/);
  assert.match(a(["escrow", "message", "e1"]).message, /text required/); assert.match(a(["escrow", "message", "e1", "--text", "x", "--kind", "system"]).message, /--kind must be/);
});
