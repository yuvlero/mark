// The one create-record check every later read of a swap from a stablecoin goes through.
import test from "node:test";
import assert from "node:assert/strict";
import { pinMismatch, validPin } from "../dist/src/swap/reversePin.js";

const DEP = "0x" + "ab".repeat(20), USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const pin = { invoice: "lnbc1abc", depositAddress: DEP, tokenContract: USDC, sourceUnits: "1500000", targetSats: 2420, evmChainId: 42161 };
const x = { id: "rv-1", status: "pending", local: true, gasless: true, depositAddress: DEP.toUpperCase().replace("0X", "0x"), tokenContract: USDC.toLowerCase(), sourceUnits: "1500000",
  targetSats: 2420, evmChainId: 42161, targetChain: "Lightning", direction: "evm_to_lightning", invoice: "LNBC1ABC" };

test("pinMismatch: a matching swap passes (case-insensitive hex and invoice); every changed term is named", () => {
  assert.equal(pinMismatch(pin, x, DEP, true), undefined);
  for (const [k, v, re] of [["depositAddress", "0x" + "cd".repeat(20), /deposit address/], ["tokenContract", "0x" + "11".repeat(20), /token/], ["sourceUnits", "1", /deposit amount/],
    ["gasless", false, /gasless/], ["evmChainId", 1, /chain/], ["targetSats", 1, /payout 1 sats/], ["targetChain", "Arkade", /payout chain/], ["direction", "evm_to_arkade", /direction/], ["invoice", "lnbc1other", /invoice/]])
    assert.match(pinMismatch(pin, { ...x, [k]: v }, DEP, false) ?? "", re, k);
  assert.match(pinMismatch(pin, x, "0x" + "cd".repeat(20), false), /not this Mark home's/);
});
test("pinMismatch strict vs lenient: unknown direction, or a record without chain/payout sats, fails only when strict", () => {
  const { direction: _d, ...noDir } = x; const { targetSats: _t, evmChainId: _c, ...oldPin } = pin;
  assert.equal(pinMismatch(pin, noDir, DEP, false), undefined); assert.match(pinMismatch(pin, noDir, DEP, true), /direction/);
  assert.equal(pinMismatch(oldPin, x, DEP, false), undefined); assert.match(pinMismatch(oldPin, x, DEP, true), /chain|payout/);
  assert.match(pinMismatch({ ...pin, arkAddress: "ark1x" }, x, DEP, false), /single payout target/);
});
test("validPin: needs the deposit terms and exactly one payout target", () => {
  assert.ok(validPin(pin)); assert.ok(!validPin({ depositAddress: DEP })); assert.ok(!validPin({ ...pin, arkAddress: "ark1x" }));
  assert.ok(!validPin({ ...pin, sourceUnits: "1.5" })); assert.ok(!validPin({ ...pin, targetSats: "2420" })); assert.ok(!validPin(null));
});
