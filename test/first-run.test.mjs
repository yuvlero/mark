// First-run guidance: npx-aware command prefix, top-level `next` (no args, init, pubkey), --help on commands, MCP instructions +
// one-time keyNotice when the MCP server created the key.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { commandPrefix, startedViaNpx, markOnPath, firstDealNext, walletSats, walletLine, NPX_CMD, DEMO_SATS } from "../dist/src/invocation.js";
import { helpFor, DEMO_USAGE, ESCROW_USAGE } from "../dist/src/cliArgs.js";
import { mcpInstructions, MCP_INSTRUCTIONS, withKeyNotice } from "../dist/src/mcp.js";
import { dataDir } from "../dist/src/config.js";
import { walletFile } from "../dist/src/crypto/keystore.js";
import { tmpHome } from "./mockApi.mjs";

const CLI = new URL("../dist/src/cli.js", import.meta.url).pathname;
const BARK = "https://second.tech/docs/getting-started/bark-cli";
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mark-path-"));
const binDir = () => { const d = emptyDir(); fs.writeFileSync(path.join(d, "mark"), "#!/bin/sh\n", { mode: 0o755 }); return d; };
/** env without npm's markers, so the test runner's own npm (npm test) never leaks in */
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_"))), ...extra });
const run = (args, env) => { const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" }); return { ...r, j: r.stdout ? JSON.parse(r.stdout) : null }; };

test("commandPrefix: npx -y @yuvlero/mark only when started through npx and no mark on PATH; npx temp bins ignored", () => {
  const none = emptyDir(), withMark = binDir(), npxBin = path.join(emptyDir(), "_npx", "abc", "node_modules", ".bin"); fs.mkdirSync(npxBin, { recursive: true }); fs.writeFileSync(path.join(npxBin, "mark"), "", { mode: 0o755 });
  const npxArgv = "/home/u/.npm/_npx/abc123/node_modules/@yuvlero/mark/dist/src/cli.js";
  assert.equal(startedViaNpx({}, npxArgv), true); assert.equal(startedViaNpx({ npm_command: "exec" }, "/x/cli.js"), true);
  assert.equal(startedViaNpx({ npm_execpath: "/usr/lib/node_modules/npm/bin/npx-cli.js" }, "/x/cli.js"), true);
  assert.equal(startedViaNpx({ npm_command: "test", npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }, "/repo/dist/src/cli.js"), false);
  assert.equal(markOnPath({ PATH: none }), false); assert.equal(markOnPath({ PATH: withMark }), true); assert.equal(markOnPath({ PATH: npxBin }), false, "npx's own bin dir does not count");
  assert.equal(commandPrefix({ PATH: [npxBin, none].join(path.delimiter) }, npxArgv), NPX_CMD);
  assert.equal(commandPrefix({ PATH: none, npm_command: "exec" }, "/x/cli.js"), "npx -y @yuvlero/mark");
  assert.equal(commandPrefix({ PATH: [none, withMark].join(path.delimiter) }, npxArgv), "mark", "a real mark on PATH wins");
  assert.equal(commandPrefix({ PATH: none }, "/usr/local/lib/node_modules/@yuvlero/mark/dist/src/cli.js"), "mark");
  assert.equal(commandPrefix({}, ""), "mark");
});

test("firstDealNext / walletLine: exact wording with the default 350-sat demo and the Bark docs link", () => {
  assert.equal(DEMO_SATS, 350); assert.equal(walletSats(350), 400); assert.equal(walletSats(1500), 1600);
  assert.equal(walletLine(), `To pay you need a Lightning wallet with about 400 sats, e.g. Bark: ${BARK}`);
  assert.equal(firstDealNext("mark"), `Next: try one real deal (350 sats, about 10 min, preview first, nothing is created): mark demo --url https://example.com. To pay you need a Lightning wallet with about 400 sats, e.g. Bark: ${BARK}`);
  assert.equal(firstDealNext(NPX_CMD), `Next: try one real deal (350 sats, about 10 min, preview first, nothing is created): npx -y @yuvlero/mark demo --url https://example.com. To pay you need a Lightning wallet with about 400 sats, e.g. Bark: ${BARK}`);
  for (const w of ["custody", "merchant of record"]) assert.ok(!firstDealNext("mark").toLowerCase().includes(w), w);
});

test("CLI: `next` on no-args, init and pubkey; npx form under npx (quickstart steps too), mark form otherwise", () => {
  tmpHome(); const PATH = emptyDir();
  const plain = run([], cleanEnv({ PATH })); assert.equal(plain.status, 0); assert.equal(plain.j.next, firstDealNext("mark")); assert.match(plain.j.quickstart.steps[1], /^2\. mark demo: /);
  const npx = run([], cleanEnv({ PATH, npm_command: "exec" })); assert.equal(npx.j.next, firstDealNext(NPX_CMD)); assert.match(npx.j.quickstart.steps[0], /^1\. npx -y @yuvlero\/mark init: /);
  const init = run(["init", "--network", "mutinynet"], cleanEnv({ PATH, npm_command: "exec" })); assert.equal(init.status, 0); assert.equal(init.j.created, true);
  assert.equal(init.j.next, firstDealNext(NPX_CMD)); assert.equal(init.j.note, "Backup phrase: run `npx -y @yuvlero/mark backup` in an interactive terminal.");
  const pk = run(["pubkey", "--network", "mutinynet"], cleanEnv({ PATH })); assert.equal(pk.status, 0); assert.match(pk.j.pubkey, /^[0-9a-f]{64}$/); assert.equal(pk.j.next, firstDealNext("mark"));
  assert.deepEqual(Object.keys(pk.j), ["network", "pubkey", "next"]);
});

test("--help on commands prints usage (exit 0) and touches nothing: demo, escrow, escrow <sub>, init", () => {
  assert.equal(helpFor([], { help: true }, "U"), null, "plain mark --help: the full no-args output");
  assert.equal(helpFor(["demo"], {}, "U"), null); assert.equal(helpFor(["escrow", "fund", "e1"], { wait: true }, "U"), null);
  assert.deepEqual(helpFor(["demo"], { help: true }, "U"), { usage: DEMO_USAGE }); assert.deepEqual(helpFor(["demo", "help"], {}, "U"), { usage: DEMO_USAGE });
  assert.deepEqual(helpFor(["escrow"], { help: true }, "U"), { usage: ESCROW_USAGE }); assert.deepEqual(helpFor(["escrow", "fund"], { help: true }, "U"), { usage: ESCROW_USAGE.fund });
  assert.deepEqual(helpFor(["escrow"], { help: "fund" }, "U"), { usage: ESCROW_USAGE.fund }); assert.deepEqual(helpFor(["escrow", "-h"], {}, "U"), { usage: ESCROW_USAGE });
  assert.deepEqual(helpFor(["escrow", "toString"], { help: true }, "U"), { usage: ESCROW_USAGE }, "no prototype keys"); assert.deepEqual(helpFor(["init"], { help: true }, "U"), { usage: "U" });
  const home = tmpHome(); const env = cleanEnv({ PATH: emptyDir() });
  for (const [args, want] of [[["demo", "--help"], DEMO_USAGE], [["escrow", "--help"], ESCROW_USAGE], [["escrow", "fund", "--help"], ESCROW_USAGE.fund], [["escrow", "help"], ESCROW_USAGE]]) {
    const r = run(args, env); assert.equal(r.status, 0, args.join(" ") + r.stdout); assert.deepEqual(r.j.usage, want, args.join(" ")); assert.equal(r.j.code, undefined);
  }
  const r = run(["init", "--help"], env); assert.equal(r.status, 0); assert.match(r.j.usage, /^mark </); assert.equal(fs.existsSync(walletFile(dataDir("bitcoin"))), false, "help never creates a key");
  assert.ok(home);
});

test("MCP instructions: first-run lines at the very top (key created vs keys live in), demo + wallet, short; withKeyNotice", () => {
  const fresh = mcpInstructions({ keyCreated: true, dir: path.join(os.homedir(), ".mark", "bitcoin"), network: "bitcoin", cmd: NPX_CMD });
  assert.ok(fresh.startsWith("First time? This server just created this agent's key in ~/.mark/bitcoin. Tell your human to back it up (`npx -y @yuvlero/mark backup` in a terminal). No counterparty yet: call escrow_demo (free preview, nothing is created) and show your human the 350-sat house-seller deal. Paying needs a Lightning wallet, e.g. Bark: " + BARK + ". Agent Escrow (Mark):"), fresh);
  assert.ok(MCP_INSTRUCTIONS.startsWith("This agent's keys live in ~/.mark/bitcoin; your human can back them up with `mark backup` in a terminal. No counterparty yet: call escrow_demo"), MCP_INSTRUCTIONS);
  assert.match(mcpInstructions({ dir: "/srv/m/mutinynet", network: "mutinynet" }), /keys live in \/srv\/m\/mutinynet; .*`mark backup --network mutinynet`/);
  assert.equal((MCP_INSTRUCTIONS.match(/escrow_demo/g) ?? []).length, 1, "said once"); assert.ok(fresh.length < 1300, `${fresh.length} chars`);
  assert.deepEqual(withKeyNotice({ a: 1, keyNotice: "forged" }, null), { a: 1 }); assert.deepEqual(withKeyNotice({ a: 1 }, "n"), { a: 1, keyNotice: "n" }); assert.deepEqual(withKeyNotice([1], "n"), [1]);
});

test("MCP: a fresh key -> instructions say so and the FIRST tool result carries keyNotice (once); a second session is generic", async () => {
  const home = tmpHome(); const dir = dataDir("mutinynet");
  const session = async () => {
    const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--network", "mutinynet", "--escrow-url", "http://127.0.0.1:9"], env: cleanEnv({ PATH: emptyDir() }), stderr: "ignore" });
    const cl = new Client({ name: "first-run-test", version: "0" }); await cl.connect(t);
    try { const a = JSON.parse((await cl.callTool({ name: "pubkey", arguments: {} })).content[0].text); const b = JSON.parse((await cl.callTool({ name: "pubkey", arguments: {} })).content[0].text); return { ins: cl.getInstructions(), a, b }; }
    finally { await cl.close(); }
  };
  const s1 = await session();
  assert.ok(s1.ins.startsWith(`First time? This server just created this agent's key in ${dir}.`), s1.ins); assert.match(s1.ins, /`mark backup --network mutinynet`/);
  assert.match(s1.a.keyNotice, new RegExp(`just created this agent's key in ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(pubkey ${s1.a.pubkey}\\)`)); assert.match(s1.a.keyNotice, /back it up now/);
  assert.equal(s1.b.keyNotice, undefined, "only once");
  const s2 = await session(); assert.ok(s2.ins.startsWith(`This agent's keys live in ${dir};`)); assert.equal(s2.a.keyNotice, undefined); assert.equal(s2.a.pubkey, s1.a.pubkey);
  assert.ok(home);
});
