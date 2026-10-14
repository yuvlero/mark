/** Caps are enforced here (core), never in adapters. */
import { MarkError } from "../errors.js";
import type { MarkConfig } from "../config.js";
export function assertEscrowCap(cfg: MarkConfig, sats: number) {
  if (!Number.isInteger(sats) || sats <= 0) throw new MarkError("BAD_AMOUNT", "sats must be a positive integer");
  if (sats > cfg.limits.maxEscrowSats) throw new MarkError("LIMIT_EXCEEDED", `amount ${sats} exceeds Mark cap ${cfg.limits.maxEscrowSats}`, { sats, maxEscrowSats: cfg.limits.maxEscrowSats });
}
