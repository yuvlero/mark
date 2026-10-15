/**
 * Machine-readable deal status. Shared, byte-identical, between the escrow server and Mark (a server test enforces it).
 * awaiting: what the deal waits for next; action_required_for: who must act. Pure; no I/O.
 */
export type Awaiting = "buyer_accept" | "seller_accept" | "buyer_funding" | "delivery" | "release_signature" | "payout" | "ruling" | "none";
export type Actor = "buyer" | "seller" | "arbiter" | "operator" | "none";
export interface StatusInput {
  state: string;
  /** null/undefined = legacy deal without terms (treated as agreed) */
  accepted?: { buyer: boolean; seller: boolean } | null;
  ruling?: { outcome: string } | null;
  arbiterMode?: string;
  /** open = not yet submitted */
  proposals: { kind: string; signers: string[]; signed: string[]; submitted: boolean }[];
}
export function dealStatus(d: StatusInput): { awaiting: Awaiting; action_required_for: Actor } {
  const s = (awaiting: Awaiting, action_required_for: Actor) => ({ awaiting, action_required_for });
  if (d.state === "released" || d.state === "refunded") return s("none", "none");
  if (d.accepted && !d.accepted.buyer) return s("buyer_accept", "buyer");
  if (d.accepted && !d.accepted.seller) return s("seller_accept", "seller");
  if (d.state === "created") return s("buyer_funding", "buyer");
  const open = d.proposals.filter((p) => !p.submitted);
  const winner = d.ruling ? (d.ruling.outcome === "release" ? "seller" : "buyer") : null;
  const p = open.at(-1);
  if (d.state === "disputed" && !d.ruling) return s("ruling", "operator");
  if (p) {
    const missing = p.signers.filter((x) => !p.signed.includes(x));
    if (!missing.length) return s("payout", "none"); // fully signed, submission pending
    // payee signs first (proposes); then the co-signer
    const who = missing.find((x) => x !== "arbiter") ?? "arbiter";
    return s("release_signature", (who === "arbiter" && d.arbiterMode === "manual" && !d.ruling ? "operator" : who) as Actor);
  }
  if (winner) return s("payout", winner); // ruled: the winner proposes (or the operator already built it)
  if (d.state === "funded") return s("delivery", "seller");
  return s("payout", "none");
}

/** What `rule` and `arbiterMode` mean together (they are easy to misread). */
export function arbiterPolicy(rule: { type: string } | undefined, arbiterMode: string | undefined) {
  const auto = arbiterMode !== "manual"; const t = rule?.type ?? "manual";
  const release = !auto ? "never (manual arbiter mode: the arbiter only signs to execute an operator ruling)"
    : t === "hash" ? "when the seller reveals the preimage of rule.sha256 (seller + arbiter, no buyer needed)"
    : t === "webhook" ? "when rule.url approves the proposal"
    : "never automatically: a release needs buyer + seller (rule 'manual' = no automatic release condition, NOT 'a human must act')";
  return { mode: auto ? "auto" : "manual", releaseRule: t, autoRelease: release,
    timeoutRefund: auto ? "after the deadline the arbiter co-signs a buyer + arbiter refund automatically" : "only by operator ruling",
    disputes: "an open dispute stops automatic signing; the operator rules" };
}
