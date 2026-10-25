/**
 * Auto-refund deadline countdown, the same for buyer and seller. Shared, byte-identical, between the escrow server and Mark
 * (a server test enforces it). Pure; no I/O.
 *
 * After the deadline the auto arbiter co-signs a buyer + arbiter refund. Delivery alone does not stop that clock: a seller
 * who delivered to a silent buyer must open a dispute BEFORE the deadline (`disputeBy`). An open dispute stops automatic signing.
 */
export type CountdownStatus = "running" | "passed" | "not_applicable";
export type CountdownReason = "running" | "passed" | "unfunded" | "final" | "disputed" | "ruled" | "manual_arbiter" | "above_auto_cap" | "bad_deadline";
export interface CountdownInput {
  state: string; deadline: string; arbiterMode?: string; disputed?: boolean; ruled?: boolean;
  /** true when the deal is above the server's auto-arbiter cap (no automatic refund); unknown = false */
  aboveAutoCap?: boolean; id?: string;
}
export interface DeadlineCountdown {
  status: CountdownStatus; reason: CountdownReason;
  /** the deal deadline (ISO), always shown */
  deadline: string;
  /** seconds until the deadline, 0 once passed (null if the deadline is unreadable) */
  secondsLeft: number | null; passed: boolean;
  /** true while passing the deadline lets the buyer refund with the arbiter's automatic co-signature */
  autoRefund: boolean;
  /** when the automatic refund becomes possible (= deadline), null when it does not apply */
  autoRefundAt: string | null;
  /** last moment a dispute reliably stops the automatic refund (= deadline), null when it does not apply */
  disputeBy: string | null;
  /** what it means for each party (plain words) */
  buyer: string; seller: string;
}
const ACTIVE = ["funded", "releasing", "refunding"];
const FINAL = ["released", "refunded", "expired"];
export function deadlineCountdown(d: CountdownInput, nowMs: number): DeadlineCountdown {
  const t = Date.parse(d.deadline); const ok = Number.isFinite(t);
  const left = ok ? Math.max(0, Math.floor((t - nowMs) / 1000)) : null; const passed = ok && nowMs >= t;
  const id = d.id ?? "<id>";
  const na = (reason: CountdownReason, both: string, seller = both) =>
    ({ status: "not_applicable" as const, reason, deadline: d.deadline, secondsLeft: left, passed, autoRefund: false, autoRefundAt: null, disputeBy: null, buyer: both, seller });
  if (!ok) return na("bad_deadline", "The deadline is unreadable; ask the operator (mark escrow messages).");
  if (FINAL.includes(d.state)) return na("final", `Final (${d.state}): no deadline applies any more.`);
  if (d.state === "created") return na("unfunded", "Not funded yet: no refund clock runs. An unfunded deal expires shortly after the deadline (see expiresAt).", "Not funded yet: do not deliver before the deal is funded. An unfunded deal expires shortly after the deadline (see expiresAt).");
  if (d.ruled) return na("ruled", "Ruled by the operator: the ruling decides the payout, not the deadline.");
  if (d.disputed || d.state === "disputed") return na("disputed", "Dispute open: the automatic refund is stopped until the operator rules.");
  if (!ACTIVE.includes(d.state)) return na("final", `State ${d.state}: no refund clock.`);
  if (d.arbiterMode === "manual") return na("manual_arbiter", "Manual arbiter mode: there is no automatic refund at the deadline; only buyer + seller, or an operator ruling, move the funds.");
  if (d.aboveAutoCap) return na("above_auto_cap", "Above the server's auto-arbiter cap: there is no automatic refund at the deadline; only buyer + seller, or an operator ruling, move the funds.");
  const base = { deadline: d.deadline, secondsLeft: left, passed, autoRefund: true, autoRefundAt: d.deadline, disputeBy: d.deadline };
  if (passed) return { status: "passed", reason: "passed", ...base,
    buyer: `Deadline passed: you can refund yourself now (buyer + arbiter): mark escrow refund ${id} --payout-lnaddr <you@wallet>`,
    seller: `Deadline passed: the buyer can refund at any moment with the arbiter's automatic co-signature. If you delivered and were not paid, open a dispute now: mark escrow dispute ${id} --reason "..." (it only helps if the refund has not been paid out yet).` };
  return { status: "running", reason: "running", ...base,
    buyer: `If the seller has not delivered by the deadline, you can refund yourself after it (buyer + arbiter, co-signed automatically).`,
    seller: `Delivering does not stop this clock. If the buyer has not released by disputeBy, open a dispute before then (mark escrow dispute ${id} --reason "..."), or the buyer can refund with the arbiter after the deadline. Set a reminder with some margin.` };
}
/** One party's view: its own note only (`note`), the other party's text dropped. */
export function countdownFor(c: DeadlineCountdown, role: "buyer" | "seller") {
  const { buyer, seller, ...rest } = c; return { ...rest, note: role === "buyer" ? buyer : seller };
}
