import { Transaction } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { ArkAddress } from "@arkade-os/sdk";

const OPTS = { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true } as any;
export const parsePsbt = (b64: string) => Transaction.fromPSBT(base64.decode(b64), OPTS);

/** Non-anchor outputs of an ark tx: [{script, amount}] */
export function outputs(b64: string) {
  const t = parsePsbt(b64); const r: { script: string; amount: number }[] = [];
  for (let i = 0; i < t.outputsLength; i++) { const o = t.getOutput(i); if (o.script && o.amount !== undefined) r.push({ script: hex.encode(o.script), amount: Number(o.amount) }); }
  return r;
}
export function arkScript(addr: string) { return hex.encode(ArkAddress.decode(addr).pkScript); }
/** True if output paying to `dest` carries >= minSats. */
export function paysTo(b64: string, dest: string, minSats: number) {
  const s = arkScript(dest); return outputs(b64).some((o) => o.script === s && o.amount >= minSats);
}
/** xonly pubkeys that have a tapscript signature on input 0. */
