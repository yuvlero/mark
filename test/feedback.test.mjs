// mark feedback / MCP feedback: POST /feedback with the message, the given fields and (default) version metadata; nothing secret.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import http from "node:http";
import { execFile } from "node:child_process"; import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildFeedback, submitFeedback, feedbackServer, feedbackMeta, FEEDBACK_LIMITS } from "../dist/src/core/feedback.js";
import { feedbackArgs, helpFor, FEEDBACK_USAGE } from "../dist/src/cliArgs.js";
import { MARK_VERSION } from "../dist/src/version.js";
import { tmpHome } from "./mockApi.mjs";
const run = promisify(execFile); const CLI = new URL("../dist/src/cli.js", import.meta.url).pathname;

/** A fake escrow server recording every request; `answer(req, body)` returns [status, json]. */
async function fakeServer(answer = () => [201, { id: "fb_0123456789abcdef", receivedAt: "2026-11-26T12:00:00.000Z", type: "bug" }]) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: b ? JSON.parse(b) : null });
    const [st, j] = answer(req, b); res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(j)); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}
const cleanEnv = (home) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_") && !k.startsWith("MARK_"))), MARK_HOME: home });
async function mark(args, env) { try { const r = await run(process.execPath, [CLI, ...args], { env }); return { code: 0, out: JSON.parse(r.stdout) }; } catch (e) { return { code: e.code, out: JSON.parse(e.stdout) }; } }

test("buildFeedback: defaults, trimming, meta on by default, --no-meta, limits, types", () => {
  const b = buildFeedback({ message: "  swap quote failed  " });
  assert.deepEqual(b, { type: "feedback", message: "swap quote failed", ...feedbackMeta() });
  assert.equal(b.markVersion, MARK_VERSION); assert.equal(b.nodeVersion, process.version); assert.equal(b.platform, `${process.platform}/${process.arch}`);
  assert.deepEqual(buildFeedback({ message: "x", type: "bug", command: " escrow fund ", errorCode: "SWAP_EXPIRED", contact: "", includeMeta: false }), { type: "bug", message: "x", command: "escrow fund", errorCode: "SWAP_EXPIRED" });
  for (const i of [{}, { message: "   " }, { message: 5 }, { message: "x", type: "rant" }, { message: "é".repeat(FEEDBACK_LIMITS.message + 1) },
    { message: "x", command: "c".repeat(201) }, { message: "x", errorCode: "E".repeat(101) }, { message: "x", contact: "c".repeat(129) }, { message: "x", contact: 7 }])
    assert.throws(() => buildFeedback(i), (e) => e.code === "BAD_FEEDBACK", JSON.stringify(i).slice(0, 60));
  assert.equal(buildFeedback({ message: "é".repeat(2000) }).message.length, 2000); // limits count characters
});
test("buildFeedback refuses obvious secrets; ordinary prose with seed words is fine", () => {
  const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  for (const m of [`my key nsec1${"q".repeat(58)}`, `xprv9s21ZrQH143K${"a".repeat(95)}`, "-----BEGIN EC PRIVATE KEY-----\nMHc\n-----END EC PRIVATE KEY-----", `wallet words: ${phrase}`])
    assert.throws(() => buildFeedback({ message: m }), (e) => e.code === "SECRET_IN_FEEDBACK" && !e.message.includes("abandon") && !e.message.includes("nsec1q"));
  assert.throws(() => buildFeedback({ message: "x", command: `mark restore ${phrase}` }), (e) => e.code === "SECRET_IN_FEEDBACK");
  assert.ok(buildFeedback({ message: "When I tried to fund the escrow with usdc on base the swap quote expired before the payment arrived and the deal stayed open" }));
});
test("CLI args: positional or --message, boolean flags before the message, unknown flags, help", () => {
  assert.deepEqual(feedbackArgs(["feedback", "it", "broke"], { type: "bug" }), { message: "it broke", type: "bug", command: undefined, errorCode: undefined, contact: undefined, includeMeta: true, server: undefined });
  assert.equal(feedbackArgs(["feedback"], { message: "hi", "no-meta": true }).includeMeta, false);
  const a = feedbackArgs(["feedback"], { "no-meta": "it broke" }); assert.equal(a.message, "it broke"); assert.equal(a.includeMeta, false);
  assert.equal(feedbackArgs(["feedback"], { json: "hello" }).message, "hello");
  for (const [p, f] of [[["feedback", "x"], { message: "y" }], [["feedback", "x"], { wallet: "y" }], [["feedback", "x"], { type: true }], [["feedback", "x"], { "error-code": true }]])
    assert.equal(feedbackArgs(p, f).code, "USAGE", JSON.stringify(f));
  assert.equal(helpFor(["feedback"], { help: true }, "main").usage, FEEDBACK_USAGE); assert.match(FEEDBACK_USAGE, /--no-meta/); assert.match(FEEDBACK_USAGE, /Never keys/);
});
test("feedbackServer: --server > --escrow-url > MARK_ESCROW_URL > config > default; http only for loopback; no key created", () => {
  const home = tmpHome();
  assert.equal(feedbackServer("bitcoin"), "https://agentescrow.to");
  assert.equal(feedbackServer("bitcoin", { server: "http://127.0.0.1:5/", escrowUrl: "https://b.example" }), "http://127.0.0.1:5");
  assert.equal(feedbackServer("bitcoin", { escrowUrl: "https://b.example" }), "https://b.example");
  fs.mkdirSync(`${home}/bitcoin`, { recursive: true }); fs.writeFileSync(`${home}/bitcoin/config.json`, JSON.stringify({ escrowUrl: "https://cfg.example" }));
  assert.equal(feedbackServer("bitcoin"), "https://cfg.example");
  process.env.MARK_ESCROW_URL = "https://env.example"; try { assert.equal(feedbackServer("bitcoin"), "https://env.example"); } finally { delete process.env.MARK_ESCROW_URL; }
  assert.throws(() => feedbackServer("mutinynet"), (e) => e.code === "ESCROW_URL_MISSING");
  assert.throws(() => feedbackServer("bitcoin", { server: "http://evil.example" }));
  assert.deepEqual(fs.readdirSync(`${home}/bitcoin`), ["config.json"]);
});
test("submitFeedback: POST /feedback with JSON + version headers, no house header; HTTP errors map to codes", async () => {
  process.env.MARK_HOUSE_KEY = "should-never-be-sent";
  const houseDir = fs.mkdtempSync("/tmp/mark-fb-house-");
  const houseFile = houseDir + "/key";
  fs.writeFileSync(houseFile, "should-never-be-sent-from-file\n", { mode: 0o600 });
  process.env.MARK_HOUSE_KEY_FILE = houseFile;
  const s = await fakeServer((req) => req.url === "/feedback" ? [201, { id: "fb_aaaaaaaaaaaaaaaa", receivedAt: "2026-11-26T12:00:00.000Z", type: "bug" }] : [404, {}]);
  try {
    const r = await submitFeedback({ serverUrl: s.url, message: "boom", type: "bug", errorCode: "X" });
    assert.equal(r.id, "fb_aaaaaaaaaaaaaaaa"); assert.equal(r.type, "bug"); assert.equal(r.server, s.url); assert.deepEqual(r.sent, ["type", "message", "errorCode", "markVersion", "nodeVersion", "platform"]); assert.match(r.note, /--contact/);
    const q = s.seen[0]; assert.equal(q.method, "POST"); assert.equal(q.url, "/feedback"); assert.equal(q.headers["content-type"], "application/json"); assert.equal(q.headers["x-mark-version"], MARK_VERSION);
    assert.match(q.headers["user-agent"], /mark/i); assert.ok(!JSON.stringify(q.headers).includes("should-never-be-sent")); assert.ok(!Object.keys(q.headers).some((h) => h.includes("house")));
    assert.deepEqual(Object.keys(q.body).sort(), ["errorCode", "markVersion", "message", "nodeVersion", "platform", "type"]);
  } finally { await s.close(); delete process.env.MARK_HOUSE_KEY; delete process.env.MARK_HOUSE_KEY_FILE; fs.rmSync(houseDir, { recursive: true, force: true }); }
  for (const [st, j, code] of [[400, { code: "BAD_FEEDBACK", error: "message is required" }, "BAD_FEEDBACK"], [429, { code: "RATE_LIMITED", error: "slow down" }, "RATE_LIMITED"], [404, { error: "not found" }, "FEEDBACK_UNSUPPORTED"], [500, "oops", "ESCROW_ERROR"], [201, { nope: 1 }, "ESCROW_BAD_RESPONSE"]]) {
    const e = await fakeServer(() => [st, j]);
    try { await assert.rejects(submitFeedback({ serverUrl: e.url, message: "x" }), (x) => x.code === code, code); } finally { await e.close(); }
  }
  await assert.rejects(submitFeedback({ serverUrl: "http://127.0.0.1:9", message: "x", timeoutMs: 2000 }), (x) => x.code === "ESCROW_UNREACHABLE");
  const n = await fakeServer(); try { await assert.rejects(submitFeedback({ serverUrl: n.url, message: "" }), (x) => x.code === "BAD_FEEDBACK"); assert.equal(n.seen.length, 0); } finally { await n.close(); }
});
test("CLI: mark feedback sends; --no-meta sends no metadata; validation fails before any request; no key or Mark home is created", async () => {
  const home = fs.mkdtempSync("/tmp/mark-fb-"); fs.rmSync(home, { recursive: true }); const env = cleanEnv(home);
  const s = await fakeServer();
  try {
    let r = await mark(["feedback", "the swap", "timed out", "--type", "bug", "--command", "escrow fund", "--error-code", "SWAP_EXPIRED", "--contact", "@agent", "--server", s.url], env);
    assert.equal(r.code, 0); assert.equal(r.out.id, "fb_0123456789abcdef"); assert.equal(r.out.server, s.url);
    assert.deepEqual(s.seen[0].body, { type: "bug", message: "the swap timed out", command: "escrow fund", errorCode: "SWAP_EXPIRED", contact: "@agent", markVersion: MARK_VERSION, nodeVersion: process.version, platform: `${process.platform}/${process.arch}` });
    r = await mark(["feedback", "--no-meta", "--message", "love it", "--server", s.url, "--json"], env); assert.equal(r.code, 0);
    assert.deepEqual(s.seen[1].body, { type: "feedback", message: "love it" });
    r = await mark(["feedback", "--no-meta", "positional after a boolean", "--server", s.url], env); assert.equal(r.code, 0); assert.equal(s.seen[2].body.message, "positional after a boolean");
    for (const args of [["feedback"], ["feedback", "x", "--type", "rant"], ["feedback", "x", "--message", "y"], ["feedback", "x", "--sats", "5"], ["feedback", "x".repeat(2001)]]) {
      r = await mark([...args, "--server", s.url], env); assert.equal(r.code, 1, args.join(" ").slice(0, 40)); assert.ok(["USAGE", "BAD_FEEDBACK"].includes(r.out.code));
    }
    assert.equal(s.seen.length, 3); assert.ok(!fs.existsSync(home), "no Mark home / key created");
    const h = await run(process.execPath, [CLI, "feedback", "--help"], { env }); assert.equal(JSON.parse(h.stdout).usage, FEEDBACK_USAGE);
    const m = await run(process.execPath, [CLI, "--help"], { env }); assert.match(m.stdout, /feedback/);
  } finally { await s.close(); }
  const d = await fakeServer(() => [429, { code: "RATE_LIMITED", error: "too many" }]);
  try { const r = await mark(["feedback", "x", "--server", d.url], env); assert.equal(r.code, 1); assert.equal(r.out.code, "RATE_LIMITED"); } finally { await d.close(); }
});
test("MCP feedback tool: listed with message required; sends to the server's escrow URL; includeMeta false; validation errors", async () => {
  const s = await fakeServer(); tmpHome();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
  const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--network", "mutinynet", "--escrow-url", s.url], env, stderr: "ignore" });
  const cl = new Client({ name: "feedback-test", version: "0" }); await cl.connect(t);
  try {
    const fb = () => s.seen.filter((x) => x.url === "/feedback");
    const tool = (await cl.listTools()).tools.find((x) => x.name === "feedback"); assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["message"]); assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["command", "contact", "errorCode", "includeMeta", "message", "server", "type"]);
    assert.match(tool.description, /Report a bug/); assert.match(tool.description, /Never put keys/);
    const r = JSON.parse((await cl.callTool({ name: "feedback", arguments: { message: "tool works", type: "feature", command: "escrow_create" } })).content[0].text);
    assert.equal(r.id, "fb_0123456789abcdef"); assert.deepEqual(fb().at(-1).body, { type: "feature", message: "tool works", command: "escrow_create", ...feedbackMeta() });
    await cl.callTool({ name: "feedback", arguments: { message: "no meta", includeMeta: false } }); assert.deepEqual(fb().at(-1).body, { type: "feedback", message: "no meta" }); assert.ok(fb().every((x) => x.method === "POST"));
    const n = fb().length; const bad = await cl.callTool({ name: "feedback", arguments: { message: "  " } });
    assert.ok(bad.isError); assert.equal(JSON.parse(bad.content[0].text).code, "BAD_FEEDBACK"); assert.equal(fb().length, n);
  } finally { await cl.close(); await s.close(); }
});
