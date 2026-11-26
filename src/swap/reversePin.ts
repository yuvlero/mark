/** What a swap from a stablecoin was confirmed with at create (kept in the Mark home), and the one check every later read of the
 *  swap goes through: status, fund (including the provider's own read under the deposit lock), claim, refund and recover. */
import type { ReversePin, ReverseSwapInfo } from "./provider.js";
import { SWAP_SOURCES, SWAP_TARGETS, SWAP_MAX_SLIPPAGE_BPS, sameHex } from "./stable.js";
import { reverseDir } from "./states.js";

/** A well-formed record (read from disk): one payout target, the deposit terms, optional numeric fields. */
export function validPin(v: unknown): boolean {
  const p = v as any;
  return !!p && typeof p === "object" && typeof p.depositAddress === "string" && typeof p.tokenContract === "string" && /^\d+$/.test(String(p.sourceUnits ?? ""))
    && (typeof p.invoice === "string") !== (typeof p.arkAddress === "string")
    && (p.targetSats === undefined || Number.isSafeInteger(p.targetSats)) && (p.evmChainId === undefined || Number.isSafeInteger(p.evmChainId))
    && (p.bridgeSourceChain === undefined || typeof p.bridgeSourceChain === "string") && (p.bridgeSourceToken === undefined || typeof p.bridgeSourceToken === "string")
    && (p.bridgeSourceChain === undefined) === (p.bridgeSourceToken === undefined);
}

/** Why the swap no longer matches its record and this home's deposit address, or undefined. strict (before signing or claiming):
 *  the direction, chain and payout sats must be known and equal; else a field Satora did not send, or a record from before it
 *  pinned that field, is not held against the swap. */
export function pinMismatch(pin: ReversePin, x: ReverseSwapInfo, myDeposit: string, strict: boolean): string | undefined {
  const ln = typeof pin.invoice === "string", rail = ln ? SWAP_SOURCES.lightning.chain : SWAP_SOURCES.arkade.chain;
  const dir = reverseDir(ln ? "lightning" : "arkade");
  if (!sameHex(x.depositAddress, myDeposit)) return `deposit address ${x.depositAddress} is not this Mark home's ${myDeposit}`;
  if (!sameHex(pin.depositAddress, myDeposit)) return `confirmed deposit address ${pin.depositAddress} is not this Mark home's`;
  if (ln === (typeof pin.arkAddress === "string")) return "the record has no single payout target";
  if (!sameHex(pin.tokenContract, x.tokenContract)) return `token ${x.tokenContract}`;
  if (pin.sourceUnits !== x.sourceUnits) return `deposit amount ${x.sourceUnits} units, confirmed ${pin.sourceUnits}`;
  // a swap confirmed from Arbitrum must stay on Arbitrum, and one from a bridge chain (USDC on Base) on that chain and token
  if ((pin.bridgeSourceChain ?? "") !== (x.bridgeSourceChain ?? "")) return `deposit chain ${x.bridgeSourceChain ?? SWAP_TARGETS.usdc.network}, confirmed ${pin.bridgeSourceChain ?? SWAP_TARGETS.usdc.network}`;
  if (pin.bridgeSourceChain !== undefined && !sameHex(pin.bridgeSourceToken, x.bridgeSourceToken)) return `deposit token ${x.bridgeSourceToken}`;
  if (x.gasless !== true) return "no longer a gasless swap";
  if (pin.evmChainId !== undefined ? x.evmChainId !== pin.evmChainId : strict) return `chain ${x.evmChainId}`;
  // to Lightning the payout is the invoice (fixed). To Arkade Satora re-prices the payout at funding (live, 26 Nov 2026: 2002 sats
  // confirmed, 2001 once the deposit was locked): a payout at most SWAP_MAX_SLIPPAGE_BPS below the confirmed one (or above it) is
  // the same swap; callers with a floor (escrow funding: the deal amount) check it themselves.
  const payoutOk = (t: number | undefined, p: number) => Number.isSafeInteger(t) && (ln ? t === p : t! * 10000 >= p * (10000 - SWAP_MAX_SLIPPAGE_BPS));
  if (pin.targetSats !== undefined ? !payoutOk(x.targetSats, pin.targetSats) : strict) return `payout ${x.targetSats} sats, confirmed ${pin.targetSats ?? "unknown"}`;
  if (x.targetChain !== rail) return `payout chain ${x.targetChain}, confirmed ${rail}`;
  if (x.direction !== undefined || strict ? x.direction !== dir : false) return `direction ${x.direction}`;
  if (ln ? !sameHex(x.invoice, pin.invoice) : x.arkAddress !== pin.arkAddress) return ln ? "the invoice Satora pays is not the confirmed one" : `payout address ${x.arkAddress}, confirmed ${pin.arkAddress}`;
  return undefined;
}
