// mark offer create|show|take|cancel and MCP offer_*: unit + CLI + MCP against a real local escrow-server.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseOfferCode, randomOfferCode, OFFER_CODE_LEN, OFFER_CODE_RE } from "../dist/src/core/offerDocs.js";
import { parseDuration, parseOfferRef, offerCreate, offerShow, offerTake, offerCancel, assertOfferUrlHost } from "../dist/src/core/offers.js";
import { checkOfferArgs, helpFor, OFFER_USAGE } from "../dist/src/cliArgs.js";
import { init, pubkey } from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { tmpHome } from "./mockApi.mjs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { offerHash } from "../dist/src/core/offerDocs.js";

const CLI = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL("../../escrow-server/", import.meta.url));
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_"))), ...extra });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });

test("parseOfferCode / parseOfferRef accept a bare code, /o/<code>, /o/<code>.md, and a full URL", () => {
  const c = randomOfferCode();
  assert.equal(c.length, OFFER_CODE_LEN); assert.match(c, OFFER_CODE_RE);
  assert.equal(parseOfferCode(c), c);
  assert.equal(parseOfferRef(c.toUpperCase()), c);
  assert.equal(parseOfferCode(`https://agentescrow.to/o/${c}`), c);
  assert.equal(parseOfferCode(`https://agentescrow.to/o/${c}.md?x=1#y`), c);
  assert.equal(parseOfferCode(`/o/${c}/`), c);
  assert.throws(() => parseOfferCode("short"), (x) => x.code === "BAD_OFFER_CODE");
  assert.throws(() => parseOfferCode("iiiiiiiiii"), (x) => x.code === "BAD_OFFER_CODE");
});

test("parseDuration accepts seconds and 30s/5m/24h/7d shorthands", () => {
  assert.equal(parseDuration(3600, "expires"), 3600);
  assert.equal(parseDuration("30s", "expires"), 30);
  assert.equal(parseDuration("5m", "expires"), 300);
  assert.equal(parseDuration("24h", "expires"), 86400);
  assert.equal(parseDuration("7d", "deadline"), 7 * 86400);
  assert.throws(() => parseDuration("0", "expires"), (x) => x.code === "BAD_DEADLINE");
  assert.throws(() => parseDuration("nope", "expires"), (x) => x.code === "BAD_DEADLINE");
});

test("checkOfferArgs and mark offer --help", () => {
  assert.equal(checkOfferArgs(undefined, undefined, {}).code, "USAGE");
  assert.equal(checkOfferArgs("create", undefined, {}).code, "USAGE");
  assert.equal(checkOfferArgs("create", undefined, { role: "seller", amount: "2000", terms: "hi" }), null);
  assert.equal(checkOfferArgs("create", undefined, { role: "seller", sats: "2000", description: "hi" }), null);
  assert.equal(checkOfferArgs("create", undefined, { role: "seller", amount: "1", sats: "2", terms: "hi" }).code, "USAGE");
  assert.equal(checkOfferArgs("create", undefined, { role: "seller", amount: "2000", terms: "a", description: "b" }).code, "USAGE");
  assert.equal(checkOfferArgs("create", undefined, { role: "seller", amount: "2000", terms: "hi", wait: true }).code, "USAGE");
  assert.equal(checkOfferArgs("show", undefined, {}).code, "USAGE");
  assert.equal(checkOfferArgs("show", "abcdefghjk", {}), null);
  assert.equal(checkOfferArgs("take", "https://agentescrow.to/o/abcdefghjk", {}), null);
  assert.equal(checkOfferArgs("cancel", "abcdefghjk", { json: true }), null);
  assert.deepEqual(helpFor(["offer"], { help: true }, "U"), { usage: OFFER_USAGE });
  assert.deepEqual(helpFor(["offer", "create"], { help: true }, "U"), { usage: OFFER_USAGE.create });
  const r = spawnSync(process.execPath, [CLI, "offer", "--help"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0); const j = JSON.parse(r.stdout); assert.ok(j.usage.create.includes("offer create"));
});

async function startEscrow(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-off-http-"));
  const password = crypto.randomBytes(8).toString("hex");
  const [port, ap] = [await freePort(), await freePort()];
  const p = spawn(process.execPath, ["dist/src/server.js", "--network", "mutinynet", "--port", String(port), "--admin-port", String(ap), "--admin-host", "127.0.0.1"],
    { cwd: SERVER_ROOT, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ESCROW_"))), ESCROW_HOME: home, ESCROW_ARBITER_PASSWORD: password, ESCROW_PUBLIC_URL: `http://127.0.0.1:${port}` }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) { const gone = new Promise((r) => p.once("exit", r)); p.kill(); const t5 = await Promise.race([gone.then(() => false), new Promise((r) => setTimeout(() => r(true), 5000))]);
    if (t5 && p.exitCode === null && p.signalCode === null) { p.kill("SIGKILL"); await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]); } } fs.rmSync(home, { recursive: true, force: true }); });
  let out = "", err = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not ready; stderr: ${err.slice(-800)}`)), 60_000);
    const check = () => { if (out.includes(`"listening":"http://127.0.0.1:${port}"`) && out.includes(`"adminListening":"http://127.0.0.1:${ap}"`)) { clearTimeout(timer); resolve(); } };
    p.stdout.on("data", (d) => { out += d; check(); }); p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (c) => { clearTimeout(timer); reject(new Error(`server exited (${c}) before ready; stderr: ${err.slice(-800)}`)); });
  });
  return { P: `http://127.0.0.1:${port}`, port };
}

function newHome() {
  const dir = tmpHome();
  const password = process.env.MARK_PASSWORD;
  return { dir, password };
}

async function agent(escrowUrl) {
  const home = newHome();
  await init("mutinynet", { escrowUrl });
  const c = await openCtx("mutinynet", { escrowUrl });
  return { home, c, pubkey: pubkey(c).pubkey };
}

function runCli(home, args, escrowUrl) {
  const r = spawnSync(process.execPath, [CLI, "--network", "mutinynet", "--escrow-url", escrowUrl, ...args], {
    encoding: "utf8", env: cleanEnv({ MARK_HOME: home.dir, MARK_PASSWORD: home.password, MARK_ESCROW_URL: escrowUrl }),
  });
  let j = null; try { j = r.stdout ? JSON.parse(r.stdout) : null; } catch { j = { parseError: r.stdout }; }
  return { ...r, j };
}

async function mcpTool(home, escrowUrl, name, args) {
  const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--network", "mutinynet", "--escrow-url", escrowUrl],
    env: cleanEnv({ MARK_HOME: home.dir, MARK_PASSWORD: home.password, MARK_ESCROW_URL: escrowUrl }), stderr: "ignore" });
  const cl = new Client({ name: "offers-test", version: "0" }); await cl.connect(t);
  try {
    const r = await cl.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text; const j = JSON.parse(text);
    if (r.isError) throw Object.assign(new Error(j.error || j.message || "mcp error"), j);
    return j;
  } finally { await cl.close(); }
}


const kp = () => { const s = schnorr.utils.randomSecretKey(); return { s, p: hex.encode(schnorr.getPublicKey(s)) }; };
function signedOffer(creator, over = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const n = crypto.randomBytes(16).toString("hex");
  const expiresAtSec = ts + 86_400;
  const binding = { network: "mutinynet", creatorPubkey: creator.p, creatorRole: "seller", amountSats: 1200,
    terms: { title: "T", description: "Write a summary." }, deadlineSeconds: 86_400, expiresAt: expiresAtSec,
    fees: null, rule: { type: "manual" }, arbiterMode: "auto", ts, nonce: n, ...over };
  const h = offerHash(binding);
  return {
    code: "abcdefghjk", url: "http://127.0.0.1/o/abcdefghjk", status: "open", network: binding.network,
    creatorPubkey: binding.creatorPubkey, creatorRole: binding.creatorRole, takerRole: "buyer",
    amountSats: binding.amountSats, terms: binding.terms, deadlineSeconds: binding.deadlineSeconds,
    expiresAt: new Date(expiresAtSec * 1000).toISOString(), createdAt: new Date().toISOString(),
    fees: binding.fees, rule: binding.rule, arbiterMode: binding.arbiterMode, offerHash: h,
    sig: hex.encode(schnorr.sign(hex.decode(h), creator.s)), ts: binding.ts, nonce: binding.nonce,
  };
}
function takeCtx(taker, offer, takeImpl) {
  const calls = { take: 0 };
  return {
    ctx: {
      network: "mutinynet", pubkey: taker.p, secret: taker.s, cfg: {}, dir: "/tmp",
      index: { set() {}, get() { return {}; } },
      api: {
        getOffer: async () => offer,
        takeOffer: async (...a) => { calls.take++; if (takeImpl) return takeImpl(...a); throw new Error("takeOffer should not be called"); },
      },
      swaps: async () => { throw new Error("no"); },
    },
    calls,
  };
}

test("offerCreate refuses conflicting terms and description aliases", async () => {
  await assert.rejects(offerCreate(null, { role: "buyer", amount: 1200, terms: "A", description: "B" }), (e) => e.code === "USAGE" && /not both/.test(e.message));
});

test("offerTake refuses a tampered or badly signed offer before creating an escrow", async () => {
  const creator = kp(), taker = kp();
  const fresh = signedOffer(creator);
  const shown = await offerShow(takeCtx(taker, fresh).ctx, fresh.code);
  assert.equal(shown.signatureValid, true);

  for (const [label, offer] of [
    ["terms", { ...fresh, terms: { title: "T", description: "tampered" } }],
    ["amount", { ...fresh, amountSats: 9999 }],
    ["deadline", { ...fresh, deadlineSeconds: 10_000 }],
    ["network", { ...fresh, network: "bitcoin" }],
    ["sig", { ...fresh, sig: "11".repeat(64) }],
  ]) {
    const { ctx, calls } = takeCtx(taker, offer);
    await assert.rejects(offerTake(ctx, offer.code), (e) => e.code === "BAD_OFFER_SIGNATURE", label);
    assert.equal(calls.take, 0, `${label}: must not call takeOffer`);
    const shownBad = await offerShow(ctx, offer.code);
    assert.equal(shownBad.signatureValid, false, label);
  }
});

test("offerTake refuses a take reply whose termsHash does not match what Mark signed", async () => {
  const creator = kp(), taker = kp();
  const offer = signedOffer(creator);
  const { ctx, calls } = takeCtx(taker, offer, async () => ({
    code: offer.code, escrowId: "e1", offer: { ...offer, status: "taken", escrowId: "e1" },
    escrow: { id: "e1", termsHash: "ff".repeat(32), amountSats: offer.amountSats, terms: offer.terms },
  }));
  await assert.rejects(offerTake(ctx, offer.code), (e) => e.code === "TERMS_HASH_MISMATCH" && /do not fund escrow e1/.test(e.message));
  assert.equal(calls.take, 1);
});

test("live local escrow-server: create, show (code + URL), take (code + URL), cancel, self-take, CLI and MCP", { timeout: 180_000 }, async (t) => {
  if (!fs.existsSync(path.join(SERVER_ROOT, "dist/src/server.js"))) throw new Error("escrow-server dist/src/server.js missing; build it first");
  const { P } = await startEscrow(t);
  const seller = await agent(P);
  const buyer = await agent(P);

  const created = await offerCreate(seller.c, { role: "seller", amount: 1200, terms: { description: "Write a 200-word summary of the page." } });
  assert.equal(created.offer.status, "open"); assert.match(created.code, OFFER_CODE_RE);
  assert.equal(created.url, `${P}/o/${created.code}`);
  assert.ok(created.offer.signatureValid === undefined); // server object has no this field
  const shown = await offerShow(buyer.c, created.code);
  assert.equal(shown.status, "open"); assert.equal(shown.signatureValid, true); assert.equal(shown.mine, false);
  const shownUrl = await offerShow(buyer.c, created.url);
  assert.equal(shownUrl.code, created.code); assert.equal(shownUrl.signatureValid, true);

  const taken = await offerTake(buyer.c, created.code);
  assert.ok(taken.escrowId); assert.equal(taken.offer.status, "taken"); assert.equal(taken.myRole, "buyer");
  assert.equal(taken.escrow.termsAgreed, true);
  assert.equal(taken.escrow.acceptances.seller.via, "offer");
  assert.ok(taken.escrow.acceptances.buyer.sig);
  assert.equal(taken.dealCheck.ok, true);
  const after = await offerShow(seller.c, `${P}/o/${created.code}.md`);
  assert.equal(after.status, "taken"); assert.equal(after.escrowId, taken.escrowId);
  await assert.rejects(offerShow(seller.c, `https://example.test/o/${created.code}.md`), (e) => e.code === "BAD_OFFER_CODE");

  await assert.rejects(offerTake(seller.c, created.code), (e) => e.code === "OFFER_ALREADY_TAKEN");

  const second = await offerCreate(seller.c, { role: "buyer", amount: 1200, description: "Pay for a short review." , expires: "24h", deadline: "2d" });
  await assert.rejects(offerTake(seller.c, second.url), (e) => e.code === "SELF_TAKE");
  const taken2 = await offerTake(buyer.c, second.url);
  assert.equal(taken2.myRole, "seller"); assert.equal(taken2.escrow.termsAgreed, true);
  assert.equal(taken2.escrow.acceptances.buyer.via, "offer");

  const cancelable = await offerCreate(seller.c, { role: "seller", amount: 1200, terms: { description: "Will cancel this one." } });
  await assert.rejects(offerCancel(buyer.c, cancelable.code), (e) => e.code === "FORBIDDEN");
  const canceled = await offerCancel(seller.c, cancelable.code);
  assert.equal(canceled.offer.status, "canceled");
  await assert.rejects(offerTake(buyer.c, cancelable.code), (e) => e.code === "OFFER_CANCELED");

  // CLI: create + show + cancel
  const cliCreate = runCli(seller.home, ["offer", "create", "--role", "seller", "--amount", "1200", "--terms", "CLI offer terms"], P);
  assert.equal(cliCreate.status, 0, cliCreate.stdout + cliCreate.stderr); assert.equal(cliCreate.j.offer.status, "open");
  const cliShow = runCli(buyer.home, ["offer", "show", cliCreate.j.url], P);
  assert.equal(cliShow.status, 0, cliShow.stdout); assert.equal(cliShow.j.signatureValid, true); assert.equal(cliShow.j.code, cliCreate.j.code);
  const cliCancel = runCli(seller.home, ["offer", "cancel", cliCreate.j.code], P);
  assert.equal(cliCancel.status, 0, cliCancel.stdout); assert.equal(cliCancel.j.offer.status, "canceled");
  const cliTakeGone = runCli(buyer.home, ["offer", "take", cliCreate.j.code], P);
  assert.equal(cliTakeGone.status, 1); assert.equal(cliTakeGone.j.code, "OFFER_CANCELED");

  const cliTakeSrc = runCli(seller.home, ["offer", "create", "--role", "seller", "--sats", "1200", "--description", "CLI take me"], P);
  assert.equal(cliTakeSrc.status, 0, cliTakeSrc.stdout);
  const cliTake = runCli(buyer.home, ["offer", "take", cliTakeSrc.j.code], P);
  assert.equal(cliTake.status, 0, cliTake.stdout + cliTake.stderr); assert.ok(cliTake.j.escrowId); assert.equal(cliTake.j.escrow.termsAgreed, true);

  // MCP parity
  const mcpCreated = await mcpTool(seller.home, P, "offer_create", { role: "seller", amount: 1200, terms: "MCP offer terms" });
  assert.equal(mcpCreated.offer.status, "open");
  const mcpShown = await mcpTool(buyer.home, P, "offer_show", { code: mcpCreated.url });
  assert.equal(mcpShown.signatureValid, true);
  const mcpTaken = await mcpTool(buyer.home, P, "offer_take", { code: mcpCreated.code });
  assert.ok(mcpTaken.escrowId); assert.equal(mcpTaken.escrow.termsAgreed, true);
  const mcpToCancel = await mcpTool(seller.home, P, "offer_create", { role: "buyer", amount: 1200, terms: "MCP cancel" });
  const mcpCanceled = await mcpTool(seller.home, P, "offer_cancel", { code: mcpToCancel.code });
  assert.equal(mcpCanceled.offer.status, "canceled");
});


test("assertOfferUrlHost allows a bare code or a URL on the configured escrow origin, and refuses a foreign host or embedded credentials", () => {
  const api = "http://127.0.0.1:18790";
  const code = "abcdefghjk";
  assert.equal(assertOfferUrlHost(code, api), undefined);
  assert.equal(assertOfferUrlHost(`/o/${code}`, api), undefined);
  assert.equal(assertOfferUrlHost(`${api}/o/${code}`, api), undefined);
  assert.equal(assertOfferUrlHost(`${api}/o/${code}.md?x=1#y`, api), undefined);
  assert.throws(() => assertOfferUrlHost(`https://evil.example/o/${code}`, api), (x) => x.code === "BAD_OFFER_CODE" && /evil\.example/.test(x.message));
  assert.throws(() => assertOfferUrlHost(`https://agentescrow.to/o/${code}`, api), (x) => x.code === "BAD_OFFER_CODE");
  assert.throws(() => assertOfferUrlHost(`http://user:pass@127.0.0.1:18790/o/${code}`, api), (x) => x.code === "BAD_OFFER_CODE");
  assert.throws(() => assertOfferUrlHost(`javascript:alert(1)/o/${code}`, api), (x) => x.code === "BAD_OFFER_CODE");
  assert.throws(() => assertOfferUrlHost(`https://agentescrow.to/o/${code}`), (x) => x.code === "ESCROW_URL_MISSING");
});
