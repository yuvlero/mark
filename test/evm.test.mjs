// The Arbitrum JSON-RPC reader used for balances and for what a payout tx actually transferred (no network: a fake fetch).
import test from "node:test";
import assert from "node:assert/strict";
import { arbitrumReader } from "../dist/src/swap/evm.js";

const TOKEN = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", TO = "0x" + "ab".repeat(20), OTHER = "0x" + "cd".repeat(20);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const log = (token, to, units) => ({ address: token, topics: [TRANSFER, topic(OTHER), topic(to)], data: "0x" + units.toString(16).padStart(64, "0") });
function fake(answers) { // answers per URL: a function (method) -> result, or "down"
  return async (url, init) => { const { method, id } = JSON.parse(init.body); const a = answers[url];
    if (a === "down") throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id, result: a(method) }) }; };
}

test("transferredTo: sums only the token's Transfer logs to the address; reverted -> null; no receipt yet -> undefined; falls over to the next endpoint", async () => {
  const receipt = { status: "0x1", logs: [log(TOKEN, TO, 1_000_000n), log(TOKEN, TO, 22_431n), log(TOKEN, OTHER, 5n), log("0x" + "11".repeat(20), TO, 9n)] };
  let r = arbitrumReader(["https://a", "https://b"], fake({ "https://a": "down", "https://b": () => receipt }));
  assert.equal(await r.transferredTo("0xtx", TOKEN, TO), 1_022_431n);
  r = arbitrumReader(["https://a"], fake({ "https://a": () => ({ status: "0x0", logs: [log(TOKEN, TO, 7n)] }) }));
  assert.equal(await r.transferredTo("0xtx", TOKEN, TO), null);
  r = arbitrumReader(["https://a"], fake({ "https://a": () => null }));
  assert.equal(await r.transferredTo("0xtx", TOKEN, TO), undefined);
  r = arbitrumReader(["https://a"], fake({ "https://a": () => ({ status: "0x1", logs: [] }) }));
  assert.equal(await r.transferredTo("0xtx", TOKEN, TO), 0n);
  r = arbitrumReader(["https://a", "https://b"], fake({ "https://a": "down", "https://b": "down" }));
  await assert.rejects(r.transferredTo("0xtx", TOKEN, TO));
});
