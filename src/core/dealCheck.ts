/** Before this wallet signs terms or funds a deal it checks, locally, that the escrow is what the server claims:
 *  1. Arbiter identity pinning: the server publishes a long-lived arbiter identity key (GET /limits arbiter.identityPubkey). It is
 *     pinned per escrow URL on first use (or explicitly: --arbiter-pubkey / MARK_ARBITER_PUBKEY). A different key later is refused.
 *  2. Per-deal attestation: the deal's arbiter key, Arkade server key, exit delay and address are signed by that identity key.
 *     (Each deal has its own arbiter key, derived server-side, so the identity key is what can be pinned.)
 *  3. Address: derived locally from buyer, seller, arbiter and server keys + exit delay + network (escrowContract.ts, the same
 *     script construction as the server's escrow-core) and compared with the server's address. */
import fs from "node:fs"; import path from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js"; import { hex } from "@scure/base";
import { MarkError } from "../errors.js";
import { arbiterAttestationHash } from "./terms.js";
import { escrowAddress } from "./escrowContract.js";
import type { Ctx } from "./context.js";
import type { Escrow, Limits } from "../api/escrowApi.js";

type Pins = Record<string, { identityPubkey: string; pinnedAt: string; source: "first-use" | "explicit" }>;
const pinFile = (c: Ctx) => path.join(c.dir, "arbiter-pins.json");
function readPins(c: Ctx): Pins { try { return JSON.parse(fs.readFileSync(pinFile(c), "utf8")); } catch { return {}; } }
function writePins(c: Ctx, p: Pins) { fs.writeFileSync(pinFile(c), JSON.stringify(p, null, 2) + "\n", { mode: 0o600 }); }
const X64 = /^[0-9a-f]{64}$/;

const limitsCache = new WeakMap<Ctx, Promise<Limits | null>>();
/** GET /limits once per context (null on servers without it). */
export function serverLimits(c: Ctx): Promise<Limits | null> {
  let p = limitsCache.get(c);
  if (!p) { p = c.api.limits().catch((x: any) => { if (x?.code === "NOT_FOUND") return null; throw x; }); limitsCache.set(c, p); }
  return p;
}
export const supportsTermsV2 = (l: Limits | null) => Array.isArray((l as any)?.termsVersions) && (l as any).termsVersions.includes(2);

/** The pinned (or explicitly configured) arbiter identity key for this escrow URL. */
export function arbiterPin(c: Ctx) {
  const url = c.cfg.escrowUrl ?? ""; const p = readPins(c)[url];
  return { escrowUrl: url, explicit: c.arbiterPubkey ?? null, pinned: p ?? null };
}

/** Check the server's arbiter identity against the pin; pin on first use. Throws loudly on any change. */
export async function verifyArbiterIdentity(c: Ctx) {
  const url = c.cfg.escrowUrl ?? ""; const lim = await serverLimits(c);
  const id = typeof (lim as any)?.arbiter?.identityPubkey === "string" ? String((lim as any).arbiter.identityPubkey).toLowerCase() : null;
  const pins = readPins(c); const stored = pins[url]?.identityPubkey ?? null; const explicit = c.arbiterPubkey ?? null;
  if (!id || !X64.test(id)) {
    if (explicit || stored) throw new MarkError("ARBITER_KEY_MISSING", `the escrow server ${url} no longer publishes an arbiter identity key, but this wallet pinned ${explicit ?? stored}. Refusing to sign or fund (possible downgrade or impersonation).`, { escrowUrl: url, pinned: explicit ?? stored });
    return { verified: false as const, warning: `the escrow server ${url} does not publish an arbiter identity key (older server): the deal's arbiter key cannot be verified. The address is still checked locally. Upgrade the server; the next Mark release will require it.` };
  }
  if (explicit && explicit !== id) throw new MarkError("ARBITER_KEY_MISMATCH", `ARBITER KEY MISMATCH for ${url}: you pinned ${explicit} (--arbiter-pubkey / MARK_ARBITER_PUBKEY) but the server presents ${id}. Refusing to sign or fund.`, { escrowUrl: url, pinned: explicit, presented: id });
  if (!explicit && stored && stored !== id) throw new MarkError("ARBITER_KEY_CHANGED", `ARBITER KEY CHANGED for ${url}: pinned ${stored} since ${pins[url].pinnedAt}, the server now presents ${id}. Refusing to sign or fund: this is what an impersonated or compromised server looks like. If the operator really rotated the key, confirm the new key out of band, then re-run with --arbiter-pubkey ${id} (or MARK_ARBITER_PUBKEY) to re-pin.`, { escrowUrl: url, pinned: stored, pinnedAt: pins[url].pinnedAt, presented: id });
  const fresh = stored !== id;
  if (fresh) { pins[url] = { identityPubkey: id, pinnedAt: new Date().toISOString(), source: explicit ? "explicit" : "first-use" }; writePins(c, pins); }
  return { verified: true as const, identityPubkey: id, pinned: fresh ? (explicit ? "explicit" : "first-use") : "match" };
}

/** Full local check of a deal (address + arbiter). Throws ADDRESS_MISMATCH / ARBITER_* ; returns what was verified. */
export async function verifyDeal(c: Ctx, e: Escrow) {
  const a = await verifyArbiterIdentity(c);
  const ex = e as any;
  if (ex.network !== undefined && ex.network !== c.network) throw new MarkError("ADDRESS_MISMATCH", `deal network ${ex.network} is not this wallet's network ${c.network}; do not fund`);
  let derived: string;
  try { derived = escrowAddress({ buyerPubkey: e.buyerPubkey, sellerPubkey: e.sellerPubkey, arbiterPubkey: e.arbiterPubkey, serverPubkey: String(ex.serverPubkey ?? ""), exitDelay: Number(ex.exitDelay), network: c.network }); }
  catch (x: any) { throw new MarkError("ADDRESS_MISMATCH", `cannot derive the escrow address from the deal's keys (${x.message}); do not fund escrow ${e.id}`); }
  if (derived !== e.address) throw new MarkError("ADDRESS_MISMATCH", `ADDRESS MISMATCH: the server's escrow address ${e.address} is not the 2-of-3 contract of this deal's keys (derived locally: ${derived}). Do not fund escrow ${e.id}.`, { serverAddress: e.address, derivedAddress: derived });
  if (a.verified) {
    const att = ex.arbiterAttestation;
    const h = arbiterAttestationHash({ network: c.network, escrowId: e.id, arbiterPubkey: e.arbiterPubkey, serverPubkey: String(ex.serverPubkey), exitDelay: Number(ex.exitDelay), address: e.address });
    let ok = false; try { ok = !!att && String(att.identityPubkey).toLowerCase() === a.identityPubkey && schnorr.verify(hex.decode(String(att.sig)), hex.decode(h), hex.decode(a.identityPubkey)); } catch { ok = false; }
    if (!ok) throw new MarkError("ARBITER_ATTESTATION_INVALID", `the deal's arbiter key / address is not attested by the pinned arbiter identity ${a.identityPubkey}; do not sign or fund escrow ${e.id}`, { escrowId: e.id, identityPubkey: a.identityPubkey });
  }
  return { addressVerified: true, address: derived, arbiter: a.verified ? { attested: true, identityPubkey: a.identityPubkey, pin: a.pinned } : { attested: false, warning: a.warning } };
}
