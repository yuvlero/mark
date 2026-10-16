// Packaging + registry metadata stay consistent (npm package, MCP registry server.json, Smithery, examples).
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const pkg = JSON.parse(rd("../package.json")), srv = JSON.parse(rd("../server.json"));

test("package.json: publishable scoped package with bin, files, engines, mcpName", () => {
  assert.equal(pkg.name, "@yuvlero/mark"); assert.equal(pkg.private, undefined); assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.bin.mark, "dist/src/cli.js"); assert.equal(pkg.engines.node, ">=20.19");
  for (const f of ["dist/src", "README.md", "docs", "LICENSE", "npm-shrinkwrap.json"]) assert.ok(pkg.files.includes(f), f);
  for (const k of ["escrow", "ai-agents", "lightning", "bitcoin", "ark", "arkade", "mcp", "mcp-server", "agent-payments"]) assert.ok(pkg.keywords.includes(k), k);
  assert.equal(pkg.mcpName, srv.name);
});
test("server.json matches package.json (name, version, identifier, stdio + mcp arg)", () => {
  assert.match(srv.name, /^io\.github\.yuvlero\//); assert.equal(srv.version, pkg.version);
  const p = srv.packages[0]; assert.equal(p.registryType, "npm"); assert.equal(p.identifier, pkg.name); assert.equal(p.version, pkg.version);
  assert.equal(p.transport.type, "stdio"); assert.deepEqual(p.packageArguments.map((a) => a.value), ["mcp"]);
  assert.ok(srv.description.length <= 100, "registry description max 100 chars");
});
test("smithery.yaml runs the published package's mcp subcommand", () => {
  const y = rd("../smithery.yaml"); assert.match(y, /type: stdio/); assert.ok(y.includes(`'${pkg.name}', 'mcp'`));
});
test("examples exist with a README each and no secrets", () => {
  for (const d of ["skill", "langchain-js", "langchain-python", "crewai"]) assert.ok(fs.existsSync(new URL(`../examples/${d}/README.md`, import.meta.url)), d);
  assert.match(rd("../examples/skill/SKILL.md"), /^---\nname: mark-escrow\ndescription: /);
});
import { nodeTooOld, nodeVersionMessage, MIN_NODE } from "../dist/src/nodeVersion.js";
test("Node version gate: 20.19+ runs, older exits with a clear message", () => {
  assert.equal(MIN_NODE, "20.19.0"); assert.equal(pkg.engines.node, ">=20.19");
  for (const v of ["20.19.0", "v20.19.2", "22.12.0", "24.1.0"]) assert.equal(nodeTooOld(v), false, v);
  for (const v of ["18.20.4", "v20.18.3", "20.0.0"]) assert.equal(nodeTooOld(v), true, v);
  assert.equal(nodeVersionMessage("v18.20.4"), "Mark needs Node 20.19.0+, you have v18.20.4. Install a newer Node (e.g. nvm install 22) and retry.");
});
