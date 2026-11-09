/**
 * Narrow workaround for an upstream bug in @lendasat/lendaswap-sdk-pure (shipped by @satora/swap, seen in 2.8.1 / 1.8.1):
 * resuming a pending Arkade claim (continueArkadeClaimSwap) calls checkpointTx.updateInput(0, { witnessScript }) on a TAPROOT
 * checkpoint input. btc-signer rejects that locally with "checkScript: witnessScript without P2WSH", so a claim that was
 * submitted but not finalized can never be finished; claimArkade then only reports "All VTXOs have already been spent.".
 *
 * Mark applies the fix only after the library failed with exactly that error, only for the one retry of the resume call, and
 * only drops `witnessScript` from an updateInput that does not also set tapLeafScript, on a taproot input (it carries a tapLeafScript
 * or its witnessUtxo is P2TR) - exactly the updates btc-signer would reject. Same logic as the fix used live on swap 36a7c6f9. Everything else is untouched, and the original method is restored afterwards. Remove once fixed upstream.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const WITNESS_SCRIPT_BUG = /witnessScript without P2WSH/;
export const WORKAROUND_ID = "lendaswap-continue-claim-taproot-witnessScript";

/** Directory of the lendaswap-sdk-pure dist that @satora/swap actually loads (hoisted or nested). */
function lendaswapDist(): string | null {
  try {
    const fromMark = createRequire(import.meta.url);
    const satora = fromMark.resolve("@satora/swap");
    return path.dirname(createRequire(satora).resolve("@lendasat/lendaswap-sdk-pure"));
  } catch { return null; }
}

/** Base classes (owners of updateInput) of every `Transaction` the library's ESM entry imports from its bundled chunks. */
export async function libTransactionBases(dist = lendaswapDist()): Promise<any[]> {
  if (!dist) return [];
  let src: string; try { src = fs.readFileSync(path.join(dist, "index.js"), "utf8"); } catch { return []; }
  const owners = new Set<any>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.\/chunk-[\w-]+\.js)['"]/g)) {
    if (!/(^|[\s,])Transaction(\s+as\s+[\w$]+)?\s*(,|$)/m.test(m[1])) continue;
    try {
      const mod: any = await import(pathToFileURL(path.join(dist, m[2])).href);
      let p = mod.Transaction?.prototype;
      while (p && !Object.prototype.hasOwnProperty.call(p, "updateInput")) p = Object.getPrototypeOf(p);
      if (p) owners.add(p);
    } catch { /* chunk layout changed: no workaround */ }
  }
  return [...owners];
}

/** Run f with updateInput ignoring a witnessScript aimed at a taproot input (see above); restores the original afterwards. */
export async function withTaprootWitnessScriptFix<T>(protos: any[], f: () => Promise<T>): Promise<{ result: T; dropped: number }> {
  let dropped = 0; const saved = protos.map((p) => [p, p.updateInput] as const);
  for (const [p, orig] of saved) {
    p.updateInput = function (this: any, idx: number, input: any, ...rest: unknown[]) {
      if (input && input.witnessScript !== undefined && !("tapLeafScript" in input)) {
        let taproot = false;
        try {
          const cur = this.getInput(idx); const spk: Uint8Array | undefined = cur?.witnessUtxo?.script;
          taproot = (Array.isArray(cur?.tapLeafScript) && cur.tapLeafScript.length > 0) || (!!spk && spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20);
        } catch { taproot = false; }
        if (taproot) { const { witnessScript: _drop, ...keep } = input; dropped++; return orig.call(this, idx, keep, ...rest); }
      }
      return orig.call(this, idx, input, ...rest);
    };
  }
  try { return { result: await f(), dropped }; } finally { for (const [p, orig] of saved) p.updateInput = orig; }
}
