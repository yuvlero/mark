// Invite check: signed GET /escrows?party= (x-mark-ts/nonce/sig over the exact path+query), pagination, CLI usage, MCP tool registration.
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js"; import { sha256 } from "@noble/hashes/sha2.js"; import { hex } from "@scure/base";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { listSigningString } from "../dist/src/crypto/keys.js";
import { checkEscrowArgs, parseArgs, ESCROW_USAGE } from "../dist/src/cliArgs.js";
import { tmpHome } from "./mockApi.mjs";

const item = (id, needs, role = "seller") => ({ id, role, counterpartyPubkey: "11".repeat(32), sats: 5000, state: "created", createdAt: "2026-10-15T00:00:00Z",
  terms: { title: "Logo", deliverable: null, acceptance: null, termsHash: "aa".repeat(32) }, termsAccepted: { mine: !needs.includes("accept"), theirs: true }, needs, nextStep: { text: "x", command: `mark escrow accept ${id}` } });
async function setup(pages) {
  tmpHome(); await uc.init("mutinynet"); const seen = []; const nonces = new Set(); let pk;
  const f = async (url, init = {}) => {
    const u = new URL(url); const pq = u.pathname + u.search; const h = init.headers || {};
    seen.push({ pq, h });
    const ts = Number(h["x-mark-ts"]); const ok = Math.abs(Date.now() / 1000 - ts) <= 120 && !nonces.has(h["x-mark-nonce"]) &&
      schnorr.verify(hex.decode(h["x-mark-sig"]), sha256(new TextEncoder().encode(listSigningString("GET", pq, ts, h["x-mark-nonce"]))), hex.decode(u.searchParams.get("party")));
    nonces.add(h["x-mark-nonce"]);
    if (!ok) return new Response(JSON.stringify({ code: "UNAUTHORIZED", error: "bad sig" }), { status: 401 });
    const cur = u.searchParams.get("cursor"); const i = cur ? Number(cur) : 0; const pg = pages[i];
    return new Response(JSON.stringify({ party: u.searchParams.get("party"), count: pg.length, escrows: pg, nextCursor: i + 1 < pages.length ? String(i + 1) : null }));
  };
  const c = await openCtx("mutinynet", { escrowUrl: "https://escrow.test", fetchImpl: f, swapFactory: async () => { throw new Error("no"); } });
  return { c, seen };
}

test("invites: default needs=accept, signed over the exact path+query, fresh nonce per page, all pages, remembered locally", async () => {
  const { c, seen } = await setup([[item("e1", ["accept"])], [item("e2", ["accept"], "buyer")]]);
  const r = await uc.invites(c);
  assert.equal(r.count, 2); assert.deepEqual(r.escrows.map((x) => x.id), ["e1", "e2"]); assert.equal(r.filter, "accept");
  assert.equal(seen.length, 2); assert.match(seen[0].pq, new RegExp(`^/escrows\\?party=${c.pubkey}&needs=accept&limit=100$`)); assert.match(seen[1].pq, /cursor=1$/);
  assert.notEqual(seen[0].h["x-mark-nonce"], seen[1].h["x-mark-nonce"]); assert.match(seen[0].h["x-mark-nonce"], /^[0-9a-f]{32}$/);
  assert.equal(c.index.get("e2").role, "buyer"); // inbox now covers it
  assert.equal(JSON.stringify(r).includes(c.secret ? hex.encode(c.secret) : "zz"), false);
});
test("invites --all: no needs filter; --needs/--state pass through", async () => {
  const { c, seen } = await setup([[item("e1", []), item("e3", ["sign"])]]);
  const r = await uc.invites(c, { all: true }); assert.equal(r.count, 2); assert.equal(seen[0].pq.includes("needs="), false); assert.equal(r.filter, "all");
  await uc.invites(c, { all: true, needs: "sign", state: "funded" }); assert.match(seen[1].pq, /needs=sign&state=funded/);
  await assert.rejects(uc.invites(c, { needs: "bogus" }), (e) => e.code === "USAGE");
});
test("invites: listing for another key is rejected", async () => {
  const { c } = await setup([[item("e1", ["accept"])]]);
  const bad = { ...c, api: { partyList: async () => ({ party: "22".repeat(32), count: 0, escrows: [], nextCursor: null }) } };
  await assert.rejects(uc.invites(bad), (e) => e.code === "ESCROW_BAD_RESPONSE");
});
test("CLI: invites usage + flags; MCP tool registered", () => {
  assert.equal(checkEscrowArgs("invites", undefined, parseArgs(["--all"]).f), null);
  assert.equal(checkEscrowArgs("invites", undefined, parseArgs(["--needs", "x"]).f).code, "USAGE");
  assert.match(ESCROW_USAGE.invites, /mark escrow invites \[--all\]/);
  const src = fs.readFileSync(new URL("../dist/src/mcp.js", import.meta.url), "utf8"); assert.match(src, /"escrow_invites"/);
  assert.match(fs.readFileSync(new URL("../dist/src/main.js", import.meta.url), "utf8"), /case "invites"/);
});
