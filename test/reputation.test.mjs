// Reputation: `mark reputation <pubkey>`, MCP escrow_reputation, and best-effort counterparty reputation on show/status/accept.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { tmpHome, mockFetch } from "./mockApi.mjs";

const CP = "ab".repeat(32);
const REP = (pk) => ({ pubkey: pk, dealsCompleted: 4, satsTransacted: 21000, disputesTotal: 1, disputesWon: 0, disputesLost: 1, firstSeen: "2026-09-02", lastSeen: "2026-10-11" });
async function ctx(routes) { tmpHome(); await uc.init("mutinynet"); const f = mockFetch(routes); const c = await openCtx("mutinynet", { escrowUrl: "http://escrow.test", fetchImpl: f, swapFactory: async () => { throw new Error("no"); } }); return { c, f }; }
const deal = (me) => ({ id: "e1", state: "created", amountSats: 5000, deadline: "2026-12-01T00:00:00Z", address: "x", buyerPubkey: me, sellerPubkey: CP, arbiterPubkey: "cd".repeat(32), proposals: [], terms: null, termsHash: null, events: [] });

test("reputation: normalizes key (upper case, 02/03 prefix), GETs /reputation/<lowercase>, returns only aggregates + caveat", async () => {
  const { c, f } = await ctx({ [`GET /reputation/${CP}`]: () => [200, { ...REP(CP), extra: "drop me" }] });
  const r = await uc.reputation(c, "02" + CP.toUpperCase());
  assert.equal(f.calls[0].key, `GET /reputation/${CP}`);
  assert.deepEqual(Object.keys(r), ["pubkey", "dealsCompleted", "satsTransacted", "disputesTotal", "disputesWon", "disputesLost", "firstSeen", "lastSeen", "isMe", "note"]);
  assert.equal(r.lastSeen, "2026-10-11");
  assert.equal(r.dealsCompleted, 4); assert.equal(r.isMe, false); assert.match(r.note, /not a guarantee/); assert.match(r.note, /wash-trade/);
});
test("reputation: bad pubkey rejected locally (no request); server errors propagate for the explicit command", async () => {
  const { c, f } = await ctx({ [`GET /reputation/${CP}`]: () => [429, { code: "RATE_LIMITED", error: "slow down" }] });
  for (const bad of ["", "zz", CP.slice(1), CP + "0", "04" + CP]) await assert.rejects(uc.reputation(c, bad), (e) => e.code === "BAD_PUBKEY", bad);
  assert.equal(f.calls.length, 0);
  await assert.rejects(uc.reputation(c, CP), (e) => e.code === "RATE_LIMITED");
});
test("show / status / accept include the counterparty's reputation", async () => {
  tmpHome(); await uc.init("mutinynet"); const pre = await openCtx("mutinynet", { escrowUrl: "http://escrow.test" }); const me = pre.pubkey;
  const f = mockFetch({ "GET /escrows/e1": () => [200, deal(me)], [`GET /reputation/${CP}`]: () => [200, REP(CP)] });
  const c = await openCtx("mutinynet", { escrowUrl: "http://escrow.test", fetchImpl: f, swapFactory: async () => { throw new Error("no"); } });
  for (const r of [await uc.show(c, "e1"), await uc.status(c, "e1")]) {
    assert.equal(r.counterpartyReputation.available, true); assert.equal(r.counterpartyReputation.role, "seller"); assert.equal(r.counterpartyReputation.pubkey, CP); assert.equal(r.counterpartyReputation.dealsCompleted, 4); assert.equal(r.counterpartyReputation.lastSeen, "2026-10-11");
  }
  assert.ok(!f.calls.some((x) => x.key.includes(`/reputation/${me}`)), "looks up the counterparty, not me");
});
test("reputation failure never fails show / status / accept: notes unavailable", async () => {
  tmpHome(); await uc.init("mutinynet"); const pre = await openCtx("mutinynet", { escrowUrl: "http://escrow.test" }); const me = pre.pubkey;
  for (const failing of [() => [500, { code: "ERROR", error: "boom" }], () => { throw new Error("network down"); }, null /* 404: old server */]) {
    const routes = { "GET /escrows/e1": () => [200, deal(me)] }; if (failing) routes[`GET /reputation/${CP}`] = failing;
    const f = mockFetch(routes); const c = await openCtx("mutinynet", { escrowUrl: "http://escrow.test", fetchImpl: f, swapFactory: async () => { throw new Error("no"); } });
    const s = await uc.show(c, "e1"); assert.equal(s.state, "created");
    assert.equal(s.counterpartyReputation.available, false); assert.equal(s.counterpartyReputation.pubkey, CP); assert.match(s.counterpartyReputation.note, /reputation unavailable/);
    assert.equal((await uc.status(c, "e1")).counterpartyReputation.available, false);
    await assert.rejects(uc.accept(c, "e1"), (e) => e.code === "NO_TERMS"); // accept's own errors are unchanged
  }
});
test("CLI: `mark reputation` without a key prints usage; MCP registers escrow_reputation", () => {
  tmpHome();
  const r = spawnSync(process.execPath, [new URL("../dist/src/cli.js", import.meta.url).pathname, "reputation", "--network", "mutinynet"], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).code, "USAGE"); assert.match(r.stdout, /mark reputation <pubkey>/);
  assert.match(fs.readFileSync(new URL("../dist/src/mcp.js", import.meta.url), "utf8"), /"escrow_reputation"/);
});
