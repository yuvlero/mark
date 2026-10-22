/** Escrow contract address: a TypeScript port of the ark-escrow crate's EscrowContract (escrow/src/contract.rs @ a710acf,
 *  the rev pinned in escrow-server core/Cargo.toml). Six tapscript leaves: three collaborative 3-of-3 (two parties + the Arkade
 *  server) and three unilateral CSV 2-of-2, in a weight-balanced tree under the BIP341 NUMS internal key; Arkade address =
 *  (server key, taproot output key). Shared byte-identical by the escrow server (src/lib) and Mark (src/core): the server test
 *  suite enforces parity AND compares this port with escrow-core (the Rust crate) on random keys.
 *  NOTE the role mapping: the crate's "seller" is the deal's BUYER and the crate's "buyer" is the deal's SELLER (the crate's
 *  seller funds the escrow). Deal-level names are used below; the swap happens in leafScripts(). */
import { p2tr, Script, TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { ArkAddress } from "@arkade-os/sdk";

export interface EscrowContractParams { buyerPubkey: string; sellerPubkey: string; arbiterPubkey: string; serverPubkey: string; exitDelay: number; network: string }

const xonly = (k: string, what: string) => {
  const h = String(k ?? "").toLowerCase(); const x = h.length === 66 && /^0[23]/.test(h) ? h.slice(2) : h;
  if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(`escrow contract: bad ${what} pubkey`);
  return hex.decode(x);
};
const collaborative = (a: Uint8Array, b: Uint8Array, server: Uint8Array) => Script.encode([a, "CHECKSIGVERIFY", b, "CHECKSIGVERIFY", server, "CHECKSIG"]);
const unilateral = (delay: number, a: Uint8Array, b: Uint8Array) => Script.encode([delay, "CHECKSEQUENCEVERIFY", "DROP", a, "CHECKSIGVERIFY", b, "CHECKSIG"]);

/** The six leaf scripts in the crate's tree order (collaborative then unilateral). */
export function leafScripts(p: EscrowContractParams): Uint8Array[] {
  const cSeller = xonly(p.buyerPubkey, "buyer"), cBuyer = xonly(p.sellerPubkey, "seller"); // crate roles (see NOTE)
  const arb = xonly(p.arbiterPubkey, "arbiter"), srv = xonly(p.serverPubkey, "server");
  const keys = [cSeller, cBuyer, arb, srv].map((k) => hex.encode(k));
  if (new Set(keys).size !== 4) throw new Error("escrow contract: all public keys must be distinct");
  const d = p.exitDelay;
  // BIP68 relative lock-time: non-zero, disable flag (bit 31) clear
  if (!Number.isInteger(d) || d <= 0 || d > 0xffffffff || d >= 0x80000000) throw new Error("escrow contract: exitDelay must be a non-zero BIP68 relative lock-time");
  return [collaborative(cSeller, arb, srv), collaborative(cBuyer, arb, srv), collaborative(cSeller, cBuyer, srv),
    unilateral(d, cSeller, arb), unilateral(d, cBuyer, arb), unilateral(d, cSeller, cBuyer)];
}

type Node = { w: number; s?: Uint8Array; l?: Node; r?: Node };
/** Same tree as the crate: repeatedly combine the two lightest nodes (stable sort by descending weight, pop two). */
function tree(scripts: Uint8Array[]): any {
  const nodes: Node[] = scripts.map((s) => ({ w: 1, s }));
  while (nodes.length >= 2) { nodes.sort((a, b) => b.w - a.w); const r = nodes.pop()!, l = nodes.pop()!; nodes.push({ w: l.w + r.w, l, r }); }
  const out = (n: Node): any => (n.s ? { script: n.s, leafVersion: 0xc0 } : [out(n.l!), out(n.r!)]);
  return out(nodes[0]);
}

/** Taproot output key (x-only hex) of the escrow contract. */
export function escrowOutputKey(p: EscrowContractParams): string {
  return hex.encode(p2tr(TAPROOT_UNSPENDABLE_KEY, tree(leafScripts(p)), undefined, true).tweakedPubkey);
}
/** Arkade address of the escrow contract ("ark" on bitcoin, "tark" on test networks). */
export function escrowAddress(p: EscrowContractParams): string {
  const hrp = p.network === "bitcoin" ? "ark" : "tark";
  return new ArkAddress(xonly(p.serverPubkey, "server"), hex.decode(escrowOutputKey(p)), hrp).encode();
}
