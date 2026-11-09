/**
 * Escrow co-signing (input 0 of the ark tx and of each checkpoint, BIP341 script path).
 *
 * Regression in @satora/swap 1.8.1 / @arkade-os/sdk 0.5.x: their bundled Transaction rejects the escrow server's PSBTs
 * (built by ark-rs, which puts the tapscript leaf in witnessScript on the taproot inputs) with
 * "checkScript: witnessScript without P2WSH", so signEscrowArkTx / signEscrowCheckpoints fail for every approve.
 * 1.7.0 / 0.4.79 signed them. Mark first calls the library; only on exactly that error it signs the same input with
 * @scure/btc-signer with the script check off (the PSBT is kept as it is: same fields, same txid, one tapScriptSig added,
 * byte-for-byte the shape 0.3.0 produced). Mark checks the tx outputs against the deal before it gets here.
 */
import { Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { signEscrowArkTx as libSignArkTx, signEscrowCheckpoints as libSignCheckpoints } from "@satora/swap";
import { WITNESS_SCRIPT_BUG } from "../swap/satoraWorkaround.js";

const OPTS = { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true } as any;
const isBug = (x: unknown) => WITNESS_SCRIPT_BUG.test(x instanceof Error ? x.message : String(x));

function signInput0(psbtB64: string, secret: Uint8Array) {
  const t = Transaction.fromPSBT(base64.decode(psbtB64), OPTS);
  // only the shape the workaround is for: a taproot script-path spend (P2TR prevout + tapLeafScript) on input 0
  const i0: any = t.getInput(0); const spk: Uint8Array | undefined = i0?.witnessUtxo?.script;
  const p2tr = !!spk && spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
  if (!p2tr || !i0.tapLeafScript?.length) throw new Error("checkScript: witnessScript without P2WSH (input 0 is not a taproot script-path spend; refusing to sign it without the script check)");
  t.signIdx(secret, 0);
  return { psbt: base64.encode(t.toPSBT()), txid: t.id };
}
export function signEscrowArkTx(psbtB64: string, secret: Uint8Array): { signedPsbt: string; txid: string } {
  try { return libSignArkTx(psbtB64, secret); }
  catch (x) { if (!isBug(x)) throw x; const r = signInput0(psbtB64, secret); return { signedPsbt: r.psbt, txid: r.txid }; }
}
export function signEscrowCheckpoints(psbtB64s: string[], secret: Uint8Array): string[] {
  try { return libSignCheckpoints(psbtB64s, secret); }
  catch (x) { if (!isBug(x)) throw x; return psbtB64s.map((p) => signInput0(p, secret).psbt); }
}
