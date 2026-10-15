import crypto from "node:crypto";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
// Minimal pure-JS BOLT11 encoder for tests (no native deps). Fields: p (payment hash), s (secret), d (description), x (expiry).
const HRP = { bitcoin: "lnbc", mutinynet: "lntbs" };
const toWords = (n, len) => { const w = []; for (let i = len - 1; i >= 0; i--) w.push(Math.floor(n / 2 ** (5 * i)) % 32); return w; };
const tag = (code, words) => [code, ...toWords(words.length, 2), ...words];
const intWords = (n) => { const w = []; do { w.unshift(n % 32); n = Math.floor(n / 32); } while (n > 0); return w; };
function encodeInvoice({ network, msat, timestamp, paymentHash, secret, description, expiry }, priv) {
  const amt = msat === undefined ? "" : msat % 100 === 0 ? `${msat / 100}n` : `${msat * 10}p`;
  const hrp = HRP[network] + amt;
  const data = [...toWords(timestamp, 7), ...tag(1, bech32.toWords(paymentHash)), ...tag(16, bech32.toWords(secret)),
    ...tag(13, bech32.toWords(new TextEncoder().encode(description))), ...tag(6, intWords(expiry))];
  const bits = data.flatMap((w) => [4, 3, 2, 1, 0].map((b) => (w >> b) & 1)); while (bits.length % 8) bits.push(0);
  const bytes = new Uint8Array(bits.length / 8).map((_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => a * 2 + b, 0));
  const msg = sha256(new Uint8Array([...new TextEncoder().encode(hrp), ...bytes]));
  const sig = secp256k1.sign(msg, priv, { prehash: false, format: "recovered" }); // [rec, r(32), s(32)]
  const rs = new Uint8Array([...sig.slice(1), sig[0]]);
  return bech32.encode(hrp, [...data, ...bech32.toWords(rs)], 10_000);
}
/** Test-only invoice factory; signing key is ephemeral and never output. */
export function makeInvoice({ sats, network = "bitcoin", ageSec = 0, expiry = 3600, msat }) {
  return encodeInvoice({ network, msat: msat !== undefined ? Number(msat) : sats !== undefined ? sats * 1000 : undefined, timestamp: Math.floor(Date.now() / 1000) - ageSec,
    paymentHash: crypto.randomBytes(32), secret: crypto.randomBytes(32), description: "test", expiry }, crypto.randomBytes(32));
}
