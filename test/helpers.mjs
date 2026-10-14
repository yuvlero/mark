import { createRequire } from "node:module";
import crypto from "node:crypto";
const require = createRequire(import.meta.url);
const bolt11 = require("bolt11");
const NETS = { bitcoin: { bech32: "bc", pubKeyHash: 0, scriptHash: 5, validWitnessVersions: [0] }, mutinynet: { bech32: "tbs", pubKeyHash: 111, scriptHash: 196, validWitnessVersions: [0] } };
/** Test-only invoice factory; signing key is ephemeral and never output. */
export function makeInvoice({ sats, network = "bitcoin", ageSec = 0, expiry = 3600, msat }) {
  const enc = bolt11.encode({ network: NETS[network], ...(msat !== undefined ? { millisatoshis: String(msat) } : sats !== undefined ? { satoshis: sats } : {}),
    timestamp: Math.floor(Date.now() / 1000) - ageSec,
    tags: [{ tagName: "payment_hash", data: crypto.randomBytes(32).toString("hex") }, { tagName: "payment_secret", data: crypto.randomBytes(32).toString("hex") }, { tagName: "description", data: "test" }, { tagName: "expire_time", data: expiry }] });
  return bolt11.sign(enc, crypto.randomBytes(32).toString("hex")).paymentRequest;
}
