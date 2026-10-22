// Client version check: Mark sends x-mark-version + User-Agent on every request, reads the server's version policy from
// GET /limits (cached per escrow URL for 6 h), prints a soft update notice, and turns 426 UPGRADE_REQUIRED into a clear error.
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import { spawn } from "node:child_process";
import * as uc from "../dist/src/core/usecases.js";
import { openCtx } from "../dist/src/core/context.js";
import { EscrowApi, upgradeRequired, UPGRADE_HINT } from "../dist/src/api/escrowApi.js";
import { MARK_VERSION, MARK_USER_AGENT } from "../dist/src/version.js";
import { compareSemver, parseSemver, semverLt } from "../dist/src/core/semver.js";
import { rememberPolicy, cachedPolicy, noticeFor, updateNotice, VERSION_POLICY_TTL_MS, RETRY_MS } from "../dist/src/core/clientVersion.js";
import { withNotice } from "../dist/src/mcp.js";
import { tmpHome, mockFetch } from "./mockApi.mjs";

const URL_ = "https://escrow.test";
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bump = (v) => { const p = parseSemver(v); return `${p.major}.${p.minor + 1}.0`; }; // a version newer than this Mark
const LIMITS = (client) => ({ network: "mutinynet", minDealSats: { lightning: 1000, ark: 330, enforced: 1000 }, maxDealSats: 1000000, freeBelowSats: 3300, dustSats: 330,
  fees: { enabled: false, source: null, address: null, feeBps: 0, disputeFeeBps: 0, freeBelowSats: 3300, terms: null }, satora: { minSats: 1000, maxSats: 1000000, fetchedAt: "x", stale: false }, ...(client ? { client } : {}) });
async function ctx(routes) { tmpHome(); await uc.init("mutinynet"); const f = mockFetch(routes); return { c: await openCtx("mutinynet", { escrowUrl: URL_, fetchImpl: f }), f }; }

test("semver (shared with the server): ordering incl. prereleases", () => {
  assert.equal(compareSemver("0.1.7", "0.2.0"), -1); assert.equal(compareSemver("0.2.0-rc.1", "0.2.0"), -1); assert.equal(compareSemver("0.10.0", "0.9.9"), 1);
  assert.equal(compareSemver("v0.2.2", "0.2.2+b"), 0); assert.ok(semverLt("0.2.2", "0.2.3")); assert.equal(parseSemver("0.2"), null);
  assert.ok(parseSemver(MARK_VERSION), "package version is semver");
});

test("every request sends x-mark-version and User-Agent mark/<version> (read from package.json at runtime)", async () => {
  assert.equal(MARK_VERSION, pkg.version); assert.equal(MARK_USER_AGENT, `mark/${pkg.version}`);
  const f = mockFetch({ "GET /escrows/e1": () => [404, { error: "nope", code: "NOT_FOUND" }], "POST /escrows/e1/dispute": () => [200, {}] });
  const api = new EscrowApi(URL_, f);
  await api.get("e1").catch(() => {}); await api.dispute("e1", { auth: { party: "buyer", ts: 1, sig: "00" } });
  await api.partyList("p", {}, () => ({ "x-mark-sig": "s" })).catch(() => {});
  assert.equal(f.calls.length, 3);
  for (const c of f.calls) { assert.equal(c.headers["x-mark-version"], pkg.version); assert.equal(c.headers["user-agent"], `mark/${pkg.version}`); }
  assert.equal(f.calls[2].headers["x-mark-sig"], "s", "auth headers still sent");
});

test("426 UPGRADE_REQUIRED: clear error with the update command and MCP hint (also when the body is not JSON)", async () => {
  const body = { error: "Mark 0.1.7 is too old for this escrow server (minimum 0.3.0). Update Mark: npx -y @yuvlero/mark@latest (global install: npm install -g @yuvlero/mark@latest). MCP: set args, then restart the MCP client.", code: "UPGRADE_REQUIRED", details: { minMarkVersion: "0.3.0", latestMarkVersion: "0.3.0", upgrade: { command: "npx -y @yuvlero/mark@latest" } } };
  const f = mockFetch({ "GET /escrows/e1": () => [426, body] });
  const e = await new EscrowApi(URL_, f).get("e1").then(() => null, (x) => x);
  assert.equal(e.code, "UPGRADE_REQUIRED"); assert.ok(e.message.startsWith(body.error)); assert.match(e.message, /never updates itself/);
  assert.equal(e.details.minMarkVersion, "0.3.0"); assert.equal(e.details.markVersion, MARK_VERSION); assert.equal(e.details.upgrade.command, "npx -y @yuvlero/mark@latest");
  const raw = async () => new Response("<html>Upgrade Required</html>", { status: 426 });
  const e2 = await new EscrowApi(URL_, raw).get("e1").then(() => null, (x) => x);
  assert.equal(e2.code, "UPGRADE_REQUIRED"); assert.ok(e2.message.includes(UPGRADE_HINT.command)); assert.match(e2.message, /MCP: .*@yuvlero\/mark@latest/);
  const e3 = upgradeRequired(URL_, { error: "too old", code: "UPGRADE_REQUIRED" }); assert.ok(e3.message.includes("npx -y @yuvlero/mark@latest")); assert.match(e3.message, /MCP/);
  // a replay-retried listing does not retry an UPGRADE_REQUIRED
  const g = mockFetch({ "GET /escrows": () => [426, body] }); await new EscrowApi(URL_, g).partyList("p", {}, () => ({})).catch(() => {}); assert.equal(g.calls.length, 1);
});

test("noticeFor: below latest -> soft notice; below min -> refused wording; current / no policy -> none", () => {
  assert.equal(noticeFor(null, URL_, "0.2.2"), null); assert.equal(noticeFor({ minMarkVersion: null, latestMarkVersion: null }, URL_, "0.2.2"), null);
  assert.equal(noticeFor({ minMarkVersion: "0.2.0", latestMarkVersion: "0.2.2" }, URL_, "0.2.2"), null); assert.equal(noticeFor({ minMarkVersion: null, latestMarkVersion: "0.2.2" }, URL_, "0.3.0"), null);
  const n = noticeFor({ minMarkVersion: "0.2.0", latestMarkVersion: "0.3.0" }, URL_, "0.2.2");
  assert.match(n, /Mark 0\.3\.0 is available \(this is 0\.2\.2\)/); assert.ok(n.includes("npx -y @yuvlero/mark@latest")); assert.match(n, /MCP: /); assert.match(n, /never updates itself/);
  assert.match(noticeFor({ minMarkVersion: "0.3.0", latestMarkVersion: "0.3.0" }, URL_, "0.2.2"), /below the minimum 0\.3\.0.*UPGRADE_REQUIRED/);
  assert.match(noticeFor({ minMarkVersion: null, latestMarkVersion: "0.3.0", upgrade: { command: "npx -y @yuvlero/mark@0.3.0" } }, URL_, "0.2.2"), /npx -y @yuvlero\/mark@0\.3\.0/, "server's upgrade text wins");
  assert.match(noticeFor({ minMarkVersion: null, latestMarkVersion: "0.3.0" }, URL_, "0.3.0-rc.1"), /available/);
});

test("version policy cache: per escrow URL, 6 h TTL, refreshed by any /limits fetch (no extra request)", async () => {
  const latest = bump(MARK_VERSION);
  const { c, f } = await ctx({ "GET /limits": () => [200, LIMITS({ minMarkVersion: null, latestMarkVersion: latest, refuseUnversioned: false, upgrade: UPGRADE_HINT })] });
  assert.equal(cachedPolicy(c), null);
  const l = await uc.limits(c); assert.equal(l.client.latestMarkVersion, latest, "escrow limits shows the client block");
  assert.equal(f.calls.length, 1); assert.equal(cachedPolicy(c).latestMarkVersion, latest);
  const n = await updateNotice(c); assert.match(n, new RegExp(`Mark ${latest.replace(/\./g, "\\.")} is available`));
  assert.equal(f.calls.length, 1, "notice came from the cache: no second /limits");
  const file = JSON.parse(fs.readFileSync(path.join(c.dir, "version-policy.json"), "utf8")); assert.deepEqual(Object.keys(file), [URL_]);
  assert.equal((fs.statSync(path.join(c.dir, "version-policy.json")).mode & 0o777), 0o600);
  assert.equal(cachedPolicy(c, Date.now() + VERSION_POLICY_TTL_MS + 1), null, "expired after 6 h");
  assert.equal(cachedPolicy({ ...c, cfg: { ...c.cfg, escrowUrl: "https://other.test" } }), null, "keyed by escrow URL");
});

test("updateNotice: stale cache -> one /limits (5 s), retried at most every 15 min; old server (404) cached as no policy; never throws", async () => {
  const latest = bump(MARK_VERSION); let mode = "down";
  const { c, f } = await ctx({ "GET /limits": () => mode === "down" ? [502, { error: "x", code: "ESCROW_ERROR" }] : mode === "old" ? [404, { error: "no route", code: "NOT_FOUND" }] : [200, LIMITS({ minMarkVersion: null, latestMarkVersion: latest })] });
  const t0 = Date.now();
  assert.equal(await updateNotice(c, { now: t0 }), null); assert.equal(f.calls.length, 1);
  assert.equal(await updateNotice(c, { now: t0 + 1000 }), null); assert.equal(f.calls.length, 1, "no retry within 15 min");
  mode = "up"; assert.match(await updateNotice(c, { now: t0 + RETRY_MS }), /is available/); assert.equal(f.calls.length, 2);
  assert.equal(await updateNotice(c, { now: t0 + RETRY_MS, fetch: false }) !== null, true);
  const o = await ctx({ "GET /limits": () => [404, { error: "no route", code: "NOT_FOUND" }] });
  assert.equal(await updateNotice(o.c), null); assert.deepEqual([cachedPolicy(o.c).minMarkVersion, cachedPolicy(o.c).latestMarkVersion], [null, null]);
  const n = await ctx({}); assert.equal(await updateNotice(n.c, { fetch: false }), null); assert.equal(n.f.calls.length, 0, "fetch:false uses the cache only");
  const cur = await ctx({ "GET /limits": () => [200, LIMITS({ minMarkVersion: null, latestMarkVersion: MARK_VERSION })] }); assert.equal(await updateNotice(cur.c), null, "current: no notice");
  const bad = await ctx({ "GET /limits": () => [200, LIMITS({ minMarkVersion: "nope", latestMarkVersion: 5 })] }); assert.equal(await updateNotice(bad.c), null, "garbage policy ignored");
  rememberPolicy({ dir: "/nonexistent/dir", cfg: { escrowUrl: URL_ } }, LIMITS({ latestMarkVersion: latest }), Date.now()); // write failure: silent
});

test("deal checks that read /limits anyway also refresh the version cache", async () => {
  const latest = bump(MARK_VERSION);
  const { c, f } = await ctx({ "GET /limits": () => [200, LIMITS({ minMarkVersion: null, latestMarkVersion: latest })] });
  const { serverLimits } = await import("../dist/src/core/dealCheck.js");
  await serverLimits(c); await new Promise((r) => setImmediate(r));
  assert.equal(cachedPolicy(c).latestMarkVersion, latest); assert.ok(await updateNotice(c)); assert.equal(f.calls.length, 1);
});

test("MCP: updateNotice field on object results (notice is taken), second text item otherwise", () => {
  assert.deepEqual(withNotice({ a: 1 }, null), { content: [{ type: "text", text: '{"a":1}' }] });
  assert.deepEqual(JSON.parse(withNotice({ a: 1, notice: "demo" }, "update!").content[0].text), { a: 1, notice: "demo", updateNotice: "update!" });
  const arr = withNotice([1], "update!"); assert.equal(arr.content.length, 2); assert.deepEqual(JSON.parse(arr.content[1].text), { updateNotice: "update!" });
  const src = fs.readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8"); assert.match(src, /withNotice\(o, await notice\(\)\)/); assert.match(src, /withNotice\(errorJson\(e\), await notice\(e\)\)/);
});

// ---- CLI end to end against a local HTTP server (stderr notice; UPGRADE_REQUIRED) ----
function runCli(args) {
  return new Promise((res) => { const p = spawn(process.execPath, ["dist/src/cli.js", ...args], { env: process.env }); let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("exit", (code) => res({ code, out, err })); });
}
async function server(t, handler) {
  const seen = []; const s = http.createServer((req, res) => { seen.push({ url: req.url, v: req.headers["x-mark-version"], ua: req.headers["user-agent"] }); const [st, j] = handler(req); res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(j)); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); t.after(() => s.close());
  return { url: `http://127.0.0.1:${s.address().port}`, seen };
}
test("CLI: soft update notice on stderr (stdout stays JSON); UPGRADE_REQUIRED exits 1 with the command on stdout and stderr", async (t) => {
  tmpHome(); const latest = bump(MARK_VERSION);
  const { url, seen } = await server(t, (req) => req.url.startsWith("/limits") ? [200, LIMITS({ minMarkVersion: null, latestMarkVersion: latest, upgrade: UPGRADE_HINT })]
    : [426, { error: `Mark ${MARK_VERSION} is too old for this escrow server (minimum ${latest}). Update Mark: npx -y @yuvlero/mark@latest. MCP: pin it, then restart the MCP client.`, code: "UPGRADE_REQUIRED", details: { minMarkVersion: latest } }]);
  let r = await runCli(["escrow", "limits", "--network", "mutinynet", "--escrow-url", url]);
  assert.equal(r.code, 0, r.out + r.err); assert.equal(JSON.parse(r.out).client.latestMarkVersion, latest);
  assert.match(r.err, new RegExp(`^mark: Mark ${latest.replace(/\./g, "\\.")} is available`, "m")); assert.ok(r.err.includes("npx -y @yuvlero/mark@latest"));
  assert.equal(seen.filter((x) => x.url.startsWith("/limits")).length, 1, "the notice reused the limits response");
  assert.ok(seen.every((x) => x.v === MARK_VERSION && x.ua === `mark/${MARK_VERSION}`));
  r = await runCli(["escrow", "show", "e1", "--network", "mutinynet", "--escrow-url", url]);
  assert.equal(r.code, 1); const j = JSON.parse(r.out); assert.equal(j.code, "UPGRADE_REQUIRED"); assert.ok(j.error.includes("npx -y @yuvlero/mark@latest"));
  assert.match(r.err, /^mark: Mark .* too old/m); assert.ok(!/is available/.test(r.err), "no second, softer notice");
});
