/** Escrow party key derivation + auth signatures. Secret bytes never leave this module except to in-process signers. */
import { mnemonicToSeedSync } from "@scure/bip39";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

/** m/86'/coin'/0'/9/0 — dedicated escrow branch (BIP86 account 0, change index 9 = Mark escrow). */
export async function escrowKey(mnemonic: string, isMainnet: boolean) {
  // dynamic import: avoids a CJS/ESM require cycle with @arkade-os/sdk deps on Node 20
  const { HDKey } = await import("@scure/bip32");
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const k = root.derive(`m/86'/${isMainnet ? 0 : 1}'/0'/9/0`);
  const secret = k.privateKey!;
  return { secret, xonly: hex.encode(schnorr.getPublicKey(secret)) };
}

export function authMessage(escrowId: string, action: string, ts: number) {
  return sha256(new TextEncoder().encode(`mark-escrow:v1:${escrowId}:${action}:${ts}`));
}
export function signAuth(secret: Uint8Array, escrowId: string, action: string) {
  const ts = Math.floor(Date.now() / 1000);
  return { ts, sig: hex.encode(schnorr.sign(authMessage(escrowId, action, ts), secret)) };
}
/** BIP340 Schnorr over a 32-byte hash (termsHash / evidence hash). */
/** Signed listing request (GET /escrows?party=): BIP340 over sha256("mark-escrow-list:v1\nGET\n<path?query>\n<ts>\n<nonce>"). */
export const listSigningString = (method: string, pathAndQuery: string, ts: number, nonce: string) => ["mark-escrow-list:v1", method.toUpperCase(), pathAndQuery, String(ts), nonce].join("\n");
export function signListRequest(secret: Uint8Array, method: string, pathAndQuery: string) {
  const ts = Math.floor(Date.now() / 1000); const nonce = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
  const sig = hex.encode(schnorr.sign(sha256(new TextEncoder().encode(listSigningString(method, pathAndQuery, ts, nonce))), secret));
  return { "x-mark-ts": String(ts), "x-mark-nonce": nonce, "x-mark-sig": sig };
}
export function signHash(secret: Uint8Array, hashHex: string) { return hex.encode(schnorr.sign(hex.decode(hashHex), secret)); }
