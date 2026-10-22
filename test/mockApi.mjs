/** In-process mock of the escrow REST API (docs/escrow-api.md). No server, no network. */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Transaction } from "@scure/btc-signer"; import { base64, hex } from "@scure/base";
import { ArkAddress } from "@arkade-os/sdk";
import { escrowAddress } from "../dist/src/core/escrowContract.js";

export const arkAddr = (b) => new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(b), "ark").encode();
/** Unsigned PSBT with one output paying `addr` `sats`. */
export function psbtPaying(addr, sats) {
  const t = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  t.addInput({ txid: new Uint8Array(32).fill(1), index: 0, witnessUtxo: { script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(9)]), amount: BigInt(sats) } });
  t.addOutput({ script: ArkAddress.decode(addr).pkScript, amount: BigInt(sats) });
  return base64.encode(t.toPSBT());
}
export function tmpHome() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "mark-test-")); process.env.MARK_HOME = d; process.env.MARK_PASSWORD = "test-only-" + Math.random(); delete process.env.MARK_ESCROW_URL; return d; }

export const MOCK_SERVER_PK = "5a".repeat(32), MOCK_ARBITER_PK = "6b".repeat(32), MOCK_EXIT_DELAY = 512;
/** Honest-server contract fields: a deal fixture without serverPubkey gets the mock Arkade server key, an exit delay and the
 *  address those keys really derive to (what Mark checks before signing/funding). Fixtures that set serverPubkey are left as-is
 *  (tests of a lying server). */
export function sealDeal(d, network = "mutinynet") {
  if (!d || typeof d !== "object" || !d.id || !d.buyerPubkey || !d.sellerPubkey || "serverPubkey" in d) return d;
  const x = { ...d, arbiterPubkey: d.arbiterPubkey ?? MOCK_ARBITER_PK, serverPubkey: MOCK_SERVER_PK, exitDelay: MOCK_EXIT_DELAY };
  try { x.address = escrowAddress({ ...x, network: d.network ?? network }); } catch { return d; }
  return x;
}
const sealBody = (j) => Array.isArray(j) ? j : j && typeof j === "object" ? (j.escrow ? { ...j, escrow: sealDeal(j.escrow) } : sealDeal(j)) : j;
/** routes: { "GET /escrows/x": (body) => [status, json] }. Records calls. */
export function mockFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url); const key = `${init.method || "GET"} ${u.pathname}${u.search}`;
    const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ key, body, url: String(url) });
    const h = routes[key] ?? routes[`${init.method || "GET"} ${u.pathname}`];
    if (!h) return new Response(JSON.stringify({ error: "no route", code: "NOT_FOUND" }), { status: 404 });
    const [status, json] = await h(body); return new Response(JSON.stringify(sealBody(json)), { status });
  };
  f.calls = calls; return f;
}
