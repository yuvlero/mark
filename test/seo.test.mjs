// Discovery text (agent SEO): MCP instructions, entry-tool descriptions, registry/npm/skill metadata.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_INSTRUCTIONS } from "../dist/src/mcp.js";
import { tmpHome } from "./mockApi.mjs";
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("server.json description fits the registry's 100-char limit", () => {
  const sj = JSON.parse(rd("../server.json")); assert.ok(sj.description.length <= 100, `${sj.description.length} chars`);
  assert.match(sj.description, /^Bitcoin escrow for AI agents/);
});
test("package.json description + keywords (no generic/unsupported keywords)", () => {
  const pkg = JSON.parse(rd("../package.json")); assert.match(pkg.description, /^Agent Escrow: pay another AI agent safely/);
  for (const k of ["escrow", "bitcoin-escrow", "ai-agents", "lightning", "mcp-server", "agent-to-agent", "non-custodial"]) assert.ok(pkg.keywords.includes(k), k);
  for (const k of ["x402", "usdc", "a2a", "crypto", "wallet", "payments"]) assert.ok(!pkg.keywords.includes(k), k);
  assert.equal(new Set(pkg.keywords).size, pkg.keywords.length);
});
test("SKILL.md description is a 'Use when' trigger; README H1", () => {
  assert.match(rd("../skills/agent-escrow/SKILL.md"), /^---\nname: agent-escrow\ndescription: Use when you pay another AI agent/);
  assert.match(rd("../README.md"), /^# Mark: Agent Escrow for AI agents \(bitcoin, Lightning, MCP\)\n/);
});
test("MCP: initialize returns the server instructions; entry tools lead with when-to-use", async () => {
  tmpHome();
  const t = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/src/cli.js", import.meta.url).pathname, "mcp", "--network", "mutinynet", "--escrow-url", "http://127.0.0.1:9"], env: { ...process.env }, stderr: "ignore" });
  const cl = new Client({ name: "seo-test", version: "0" }); await cl.connect(t);
  try {
    const ins = cl.getInstructions(); assert.equal(ins, MCP_INSTRUCTIONS);
    for (const w of ["2-of-3", "Lightning", "escrow_limits", "escrow_reputation", "escrow_create", "escrow_demo", "awaiting", "cannot move funds alone"]) assert.ok(ins.includes(w), w);
    assert.doesNotMatch(ins, /nextStep/); // only escrow_invites items carry nextStep
    const tools = Object.fromEntries((await cl.listTools()).tools.map((x) => [x.name, x.description]));
    assert.match(tools.escrow_create, /^Start an escrowed deal with another agent/);
    assert.match(tools.escrow_demo, /^No counterparty yet\? /);
    assert.match(tools.escrow_reputation, /^Check a counterparty before you pay or accept a deal\. /);
    assert.match(tools.escrow_fund, /^Buyer: get the Lightning invoice/);
    for (const [n, d] of Object.entries(tools)) if (n !== "escrow_create") assert.ok((d.match(/AI agent/g) ?? []).length <= 1, n); // no keyword stuffing
  } finally { await cl.close(); }
});
