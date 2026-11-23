/**
 * Escrow co-signing (input 0 of the ark tx and of each checkpoint, BIP341 script path).
 *
 * @satora/swap 1.10.1+ accepts the escrow server's PSBTs (ark-rs puts the tapscript leaf in
 * witnessScript on the taproot inputs). Mark first calls the library; only on exactly
 * "checkScript: witnessScript without P2WSH" it signs the same input with @scure/btc-signer
 * with the script check off (the PSBT is kept as it is: same fields, same txid, one tapScriptSig
 * added). Mark checks the tx outputs against the deal before it gets here.
 */
import { Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { signEscrowArkTx as libSignArkTx, signEscrowCheckpoints as libSignCheckpoints } from "@satora/swap";

const WITNESS_SCRIPT_BUG = /witnessScript without P2WSH/;
const OPTS = { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true } as any;
const isBug = (x: unknown) => WITNESS_SCRIPT_BUG.test(x instanceof Error ? x.message : String(x));

function signInput0(psbtB64: string, secret: Uint8Array) {
  const t = Transaction.fromPSBT(base64.decode(psbtB64), OPTS);
  // only the shape the fallback is for: a taproot script-path spend (P2TR prevout + tapLeafScript) on input 0
  const i0: any = t.getInput(0); const spk: Uint8Array | undefined = i0?.witnessUtxo?.script;
  const p2tr = !!spk && spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
  if (!p2tr || !i0.tapLeafScript?.length) throw new Error("refusing to sign: input 0 is not a taproot script-path spend (the library rejected it with a witnessScript error; Mark only signs taproot escrow spends without the script check)");
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
