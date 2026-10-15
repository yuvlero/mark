/** Platform + dispute fee math. Pure, dependency-free.
 *  MUST stay byte-identical with Mark's src/core/fees.ts (both sides compute the same expected fee output). */

/** Fee terms stamped into a deal at create and covered by termsHash. Absent on legacy deals = no fees. */
export interface FeeTerms {
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

export interface FeeCalc {
  /** platform fee as computed (before dust handling) */
  platformFeeSats: number;
  /** dispute fee as computed (before dust handling); 0 unless disputed + ruled */
  disputeFeeSats: number;
  /** computed total */
  computedSats: number;
  /** sats added to reach dust (0 unless bumped) */
  dustBumpSats: number;
  /** the fee output actually in the payout tx (0 = no fee output) */
  feeOutputSats: number;
  /** escrowSats - feeOutputSats: what the payee leg gets */
  payeeSats: number;
  waived: boolean;
  reason: "no_fee_terms" | "free_tier" | "zero_rate" | "below_dust_waived" | "below_dust_bumped" | "charged";
}

const ceilBps = (amount: number, bps: number) => (bps > 0 ? Math.ceil((amount * bps) / 10_000) : 0);

/** Fee for a payout of `escrowSats` under `terms`. `disputeRuled` = a dispute exists AND the admin ruled it. */
export function computeFees(terms: FeeTerms | null | undefined, amountSats: number, escrowSats: number, disputeRuled: boolean): FeeCalc {
  const none = (reason: FeeCalc["reason"], p = 0, d = 0): FeeCalc => ({ platformFeeSats: p, disputeFeeSats: d, computedSats: p + d, dustBumpSats: 0, feeOutputSats: 0, payeeSats: escrowSats, waived: p + d > 0, reason });
  if (!terms) return none("no_fee_terms");
  if (amountSats < terms.freeBelowSats) return none("free_tier");
  const p = ceilBps(amountSats, terms.feeBps), d = disputeRuled ? ceilBps(amountSats, terms.disputeFeeBps) : 0, total = p + d;
  if (total === 0) return none("zero_rate");
  if (total >= terms.dustSats) return { platformFeeSats: p, disputeFeeSats: d, computedSats: total, dustBumpSats: 0, feeOutputSats: total, payeeSats: escrowSats - total, waived: false, reason: "charged" };
  const bump = terms.dustSats - total;
  if (bump <= ceilBps(amountSats, terms.dustBumpMaxBps) && escrowSats - terms.dustSats >= terms.dustSats)
    return { platformFeeSats: p, disputeFeeSats: d, computedSats: total, dustBumpSats: bump, feeOutputSats: terms.dustSats, payeeSats: escrowSats - terms.dustSats, waived: false, reason: "below_dust_bumped" };
  return none("below_dust_waived", p, d);
}

/** Worst-case fee output for an amount (dispute ruled). Used for minimum deal sizes. */
export const maxFeeOutput = (terms: FeeTerms | null | undefined, amountSats: number) => Math.max(computeFees(terms, amountSats, amountSats, true).feeOutputSats, computeFees(terms, amountSats, amountSats, false).feeOutputSats);

/** Smallest amount whose payee leg is >= minPayeeSats under the worst-case fee. Searches upward from minPayeeSats. */
export function minDealFor(terms: FeeTerms | null | undefined, minPayeeSats: number, limit = 100_000_000): number {
  for (let a = Math.max(1, minPayeeSats); a <= limit; a++) if (a - maxFeeOutput(terms, a) >= minPayeeSats) return a;
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
