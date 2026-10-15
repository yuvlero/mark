// Docs stay in sync with the CLI and MCP surface: every subcommand and tool is documented, and no operator-only routes leak into public docs.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { ESCROW_USAGE } from "../dist/src/cliArgs.js";
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const README = rd("../README.md"), QS = rd("../docs/AGENT_QUICKSTART.md"), API = rd("../docs/escrow-api.md");
const TOOLS = [...rd("../src/mcp.ts").matchAll(/s\.tool\("([a-z_]+)"/g)].map((m) => m[1]);

test("README command table lists every escrow subcommand", () => {
  for (const sub of Object.keys(ESCROW_USAGE)) assert.ok(README.includes("`mark escrow " + sub), `README is missing mark escrow ${sub}`);
});
test("every MCP tool is in the README and the quickstart", () => {
  assert.ok(TOOLS.length >= 18);
  for (const t of TOOLS) { assert.ok(README.includes(t), `README is missing ${t}`); assert.ok(QS.includes("`" + t + "`"), `quickstart is missing ${t}`); }
});
test("each usage flag appears in the README", () => {
  for (const [sub, u] of Object.entries(ESCROW_USAGE)) for (const [flag] of u.matchAll(/--[a-z][a-z-]*/g)) assert.ok(README.includes(flag), `README is missing ${flag} (from ${sub})`);
});
test("public docs: no admin routes, no server internals", () => {
  for (const [n, d] of [["README", README], ["quickstart", QS], ["api", API]]) {
    assert.doesNotMatch(d, /\/admin\b|admin\.token|ESCROW_ADMIN|src\/lib\/|service\.ts|server\.ts/, n);
  }
});
test("status enums are documented with every value", () => {
  for (const v of ["buyer_accept", "seller_accept", "buyer_funding", "delivery", "release_signature", "payout", "ruling", "none"]) assert.ok(API.includes("`" + v + "`") || API.includes(v), v);
  for (const v of ["buyer", "seller", "arbiter", "operator"]) assert.ok(API.includes(v));
});
