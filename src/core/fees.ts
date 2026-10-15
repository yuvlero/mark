/** Platform + dispute fee math. Pure, dependency-free.
 *  MUST stay byte-identical with Mark's src/core/fees.ts (both sides compute the same expected fee output). */

/** v1 fee terms (pure bps + dust bump/waive). Still honoured for deals stamped with them. */
export interface FeeTermsV1 {
  v: 1;
  /** platform fee in basis points of the escrow amount, charged on every payout (release or refund) */
  feeBps: number;
  /** extra dispute fee in basis points, charged only when the admin rules a dispute */
  disputeFeeBps: number;
  /** amounts strictly below this pay no fees at all (test tier) */
  freeBelowSats: number;
  /** Ark dust (minimum output) at create time */
  dustSats: number;
  /** a sub-dust fee is bumped to dust only if the bump adds at most this many bps of the amount; otherwise waived */
  dustBumpMaxBps: number;
  /** platform Ark address receiving the fee output */
  address: string;
}

/** v2 fee terms (current schedule). Platform fee per payout: free below freeBelowSats; flatSats up to flatUntilSats
 *  (inclusive); above that max(flatSats, ceil(amount * feeBps / 10000)). Ruled dispute: + max(disputeMinSats,
 *  ceil(amount * disputeFeeBps / 10000)) (also free below freeBelowSats). Both go in ONE fee output. */
export interface FeeTermsV2 {
  v: 2;
  freeBelowSats: number;
  flatSats: number;
  flatUntilSats: number;
  feeBps: number;
  disputeFeeBps: number;
  disputeMinSats: number;
  /** Ark dust at create time. Safety: a fee output below dust (or a payee leg below dust) is waived, never built. */
  dustSats: number;
  address: string;
}
export type FeeTerms = FeeTermsV1 | FeeTermsV2;

export interface FeeCalc {
  /** platform fee as computed (before dust handling) */
  platformFeeSats: number;
  /** dispute fee as computed (before dust handling); 0 unless disputed + ruled */
  disputeFeeSats: number;
  /** computed total */
  computedSats: number;
  /** sats added to reach dust (0 unless bumped; v1 only) */
  dustBumpSats: number;
  /** the fee output actually in the payout tx (0 = no fee output) */
  feeOutputSats: number;
  /** escrowSats - feeOutputSats: what the payee leg gets */
  payeeSats: number;
  waived: boolean;
  reason: "no_fee_terms" | "free_tier" | "zero_rate" | "below_dust_waived" | "below_dust_bumped" | "payee_below_dust_waived" | "charged";
}

const ceilBps = (amount: number, bps: number) => (bps > 0 ? Math.ceil((amount * bps) / 10_000) : 0);

/** Fee for a payout of `escrowSats` under `terms`. `disputeRuled` = a dispute exists AND the admin ruled it. */
export function computeFees(terms: FeeTerms | null | undefined, amountSats: number, escrowSats: number, disputeRuled: boolean): FeeCalc {
  const none = (reason: FeeCalc["reason"], p = 0, d = 0): FeeCalc => ({ platformFeeSats: p, disputeFeeSats: d, computedSats: p + d, dustBumpSats: 0, feeOutputSats: 0, payeeSats: escrowSats, waived: p + d > 0, reason });
  if (!terms) return none("no_fee_terms");
  if (terms.v !== 1 && terms.v !== 2) throw new Error(`unsupported fee terms version ${(terms as any).v}`);
  if (amountSats < terms.freeBelowSats) return none("free_tier");
  if (terms.v === 2) {
    const p = amountSats <= terms.flatUntilSats ? terms.flatSats : Math.max(terms.flatSats, ceilBps(amountSats, terms.feeBps));
    const d = disputeRuled ? Math.max(terms.disputeMinSats, ceilBps(amountSats, terms.disputeFeeBps)) : 0, total = p + d;
    if (total === 0) return none("zero_rate");
    if (total < terms.dustSats) return none("below_dust_waived", p, d); // safety: schedule keeps fees >= dust; only if dust rose
    if (escrowSats - total < terms.dustSats) return none("payee_below_dust_waived", p, d);
    return { platformFeeSats: p, disputeFeeSats: d, computedSats: total, dustBumpSats: 0, feeOutputSats: total, payeeSats: escrowSats - total, waived: false, reason: "charged" };
  }
  const p = ceilBps(amountSats, terms.feeBps), d = disputeRuled ? ceilBps(amountSats, terms.disputeFeeBps) : 0, total = p + d;
  if (total === 0) return none("zero_rate");
  if (total >= terms.dustSats) return { platformFeeSats: p, disputeFeeSats: d, computedSats: total, dustBumpSats: 0, feeOutputSats: total, payeeSats: escrowSats - total, waived: false, reason: "charged" };
  const bump = terms.dustSats - total;
  if (bump <= ceilBps(amountSats, terms.dustBumpMaxBps) && escrowSats - terms.dustSats >= terms.dustSats)
    return { platformFeeSats: p, disputeFeeSats: d, computedSats: total, dustBumpSats: bump, feeOutputSats: terms.dustSats, payeeSats: escrowSats - terms.dustSats, waived: false, reason: "below_dust_bumped" };
  return none("below_dust_waived", p, d);
}

/** Human-readable schedule (for /limits and Mark). */
export function feeSchedule(t: FeeTerms) {
  if (t.v === 2) return { platform: `free below ${t.freeBelowSats} sats; ${t.flatSats} sats flat from ${t.freeBelowSats} to ${t.flatUntilSats}; above ${t.flatUntilSats}: ${t.feeBps / 100}% rounded up`,
    dispute: `ruled dispute: + ${t.disputeFeeBps / 100}% (min ${t.disputeMinSats} sats), only from ${t.freeBelowSats} sats; same single fee output` };
  return { platform: `${t.feeBps / 100}% (free below ${t.freeBelowSats} sats; sub-dust fees bumped or waived)`, dispute: `ruled dispute: + ${t.disputeFeeBps / 100}%` };
}

/** Worst-case fee output for an amount (dispute ruled). Used for minimum deal sizes. */
export const maxFeeOutput = (terms: FeeTerms | null | undefined, amountSats: number) => Math.max(computeFees(terms, amountSats, amountSats, true).feeOutputSats, computeFees(terms, amountSats, amountSats, false).feeOutputSats);

/** Smallest amount whose payee leg is >= minPayeeSats under the worst-case fee. Searches upward from minPayeeSats.
 *  The fee jumps at freeBelowSats (free -> flat), so a free-tier candidate only counts if the first charged amount also works. */
export function minDealFor(terms: FeeTerms | null | undefined, minPayeeSats: number, limit = 100_000_000): number {
  const ok = (a: number) => a - maxFeeOutput(terms, a) >= minPayeeSats;
  for (let a = Math.max(1, minPayeeSats); a <= limit; a++) if (ok(a)) { if (terms && a < terms.freeBelowSats && !ok(terms.freeBelowSats)) { a = terms.freeBelowSats - 1; continue; } return a; }
  return limit;
}

/** Expected non-anchor outputs of a payout tx: payee leg, plus the fee output when > 0. */
export function expectedOutputs(fc: FeeCalc, payeeScript: string, feeScript: string | null) {
  const o = [{ script: payeeScript, amount: fc.payeeSats }];
  if (fc.feeOutputSats > 0) o.push({ script: feeScript!, amount: fc.feeOutputSats });
  return o;
}

/** Exact match: same multiset of (script, amount), nothing else. `outs` must already exclude the P2A anchor. */
export function outputsMatch(outs: { script: string; amount: number }[], expected: { script: string; amount: number }[]) {
  if (outs.length !== expected.length) return false;
  const key = (o: { script: string; amount: number }) => `${o.script}:${o.amount}`;
  const a = outs.map(key).sort(), b = expected.map(key).sort();
  return a.every((x, i) => x === b[i]);
}

/** Upfront fee preview for a deal of `amountSats` (shown at create / limits). Swap cost is passed in (estimate). */
export function feePreview(terms: FeeTerms | null | undefined, amountSats: number, o: { minDealSats: number; maxDealSats: number; swapEstimateSats?: number | null; swapUpperBoundSats?: number | null }) {
  const n = computeFees(terms, amountSats, amountSats, false), d = computeFees(terms, amountSats, amountSats, true);
  const swap = o.swapEstimateSats ?? null;
  return { amountSats, platformFeeSats: n.feeOutputSats, platformFeeReason: n.reason,
    possibleDisputeFeeSats: d.feeOutputSats - n.feeOutputSats, disputeFeeApplies: d.feeOutputSats > n.feeOutputSats,
    estimatedSwapCostSats: swap, swapCostUpperBoundSats: o.swapUpperBoundSats ?? null,
    swapCostNote: "Lightning payout only (Ark payouts have no swap cost). estimatedSwapCostSats = Satora protocol fee (live rate, ~0.3%) + typical routing (~0.5%); the exact cost depends on the destination (quote --dest). swapCostUpperBoundSats = cost if you invoice the estimate's recommendedInvoiceSats (includes the safety margin).",
    payeeReceives: { arkSats: n.payeeSats, lightningSatsEstimate: swap === null ? null : n.payeeSats - swap, lightningSatsAtLeast: o.swapUpperBoundSats == null ? null : n.payeeSats - o.swapUpperBoundSats, ifDisputeRuledArkSats: d.payeeSats },
    minDealSats: o.minDealSats, maxDealSats: o.maxDealSats, withinLimits: amountSats >= o.minDealSats && amountSats <= o.maxDealSats,
    schedule: terms ? feeSchedule(terms) : null };
}
