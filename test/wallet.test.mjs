// First-run wallet recommendation (Bark): structured field in `mark` (no args) quickstart, mirrored in the docs.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { RECOMMENDED_WALLET, BARK_VERSION } from "../dist/src/wallet.js";
import { tmpHome } from "./mockApi.mjs";
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const DOCS = "https://second.tech/docs/getting-started/bark-cli";

test("recommendedWallet: Bark, why, official download command (no curl|sh), docs + releases links, usage, any-wallet note, --payout-ark warning", () => {
  const w = RECOMMENDED_WALLET;
  assert.match(w.name, /^Bark/); assert.match(w.why, /funding invoice/); assert.match(w.why, /payouts/);
  assert.equal(w.install.split("   ")[0], `curl -L https://gitlab.com/ark-bitcoin/bark/-/releases/bark-${BARK_VERSION}/downloads/bark-${BARK_VERSION}-linux-x86_64 --output bark && chmod +x bark`);
  assert.doesNotMatch(w.install, /\|\s*(ba)?sh/); assert.equal(w.docs, DOCS); assert.equal(w.releases, "https://gitlab.com/ark-bitcoin/bark/-/releases");
  assert.equal(w.use.create, "bark create --mainnet --ark https://ark.second.tech"); assert.match(w.use.payFunding, /^bark send /); assert.match(w.use.receivePayout, /bark ln invoice .*--payout-invoice/);
  assert.match(w.anyLightningWallet, /any Lightning wallet/); assert.match(w.warning, /--payout-ark/);
});
test("`mark` with no args: usage/defaultNetwork/firstRun/steps unchanged, exit 0, plus noWallet + recommendedWallet", () => {
  tmpHome();
  const r = spawnSync(process.execPath, [new URL("../dist/src/cli.js", import.meta.url).pathname], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0); const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j), ["usage", "defaultNetwork", "quickstart"]); assert.match(j.usage, /^mark </); assert.equal(j.defaultNetwork, "bitcoin");
  assert.deepEqual(Object.keys(j.quickstart), ["firstRun", "steps", "noWallet", "recommendedWallet"]); assert.equal(j.quickstart.steps.length, 3);
  assert.match(j.quickstart.noWallet, /^No wallet yet\? We recommend Bark/); assert.ok(j.quickstart.noWallet.includes(DOCS));
  assert.deepEqual(j.quickstart.recommendedWallet, JSON.parse(JSON.stringify(RECOMMENDED_WALLET)));
});
test("docs mirror the recommendation (README, AGENTS.md, agent quickstart, skill)", () => {
  for (const p of ["../README.md", "../AGENTS.md", "../docs/AGENT_QUICKSTART.md", "../skills/agent-escrow/SKILL.md"]) {
    const d = rd(p); assert.match(d, /Bark/, p); assert.ok(d.includes(DOCS), p); assert.match(d, /--payout-ark/, p);
  }
});
