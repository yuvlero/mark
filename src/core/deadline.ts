/**
 * Auto-refund deadline countdown, the same for buyer and seller. Shared, byte-identical, between the escrow server and Mark
 * (a server test enforces it). Pure; no I/O.
 *
 * After the deadline the auto arbiter co-signs a buyer + arbiter refund. Delivery alone does not stop that clock: a seller
 * who delivered to a silent buyer must open a dispute BEFORE the deadline; `disputeBy` recommends a time with a margin. An open dispute stops automatic signing.
 */
export type CountdownStatus = "running" | "passed" | "not_applicable";
export type CountdownReason = "running" | "passed" | "unfunded" | "final" | "disputed" | "ruled" | "manual_arbiter" | "above_auto_cap" | "bad_deadline" | "unknown_state";
export interface CountdownInput {
  state: string; deadline: string; arbiterMode?: string; disputed?: boolean; ruled?: boolean;
  /** when the deal was funded (ISO, funding.seenAt); start of the funded window. Missing: createdAt, else no margin */
  fundedAt?: string | null; createdAt?: string | null;
  /** true when the deal is above the server's auto-arbiter cap (no automatic refund); unknown = false */
  aboveAutoCap?: boolean; id?: string;
}
export interface DeadlineCountdown {
  status: CountdownStatus; reason: CountdownReason;
  /** the deal deadline (ISO), always shown; null only when the deal has no deadline string at all (reason bad_deadline) */
  deadline: string | null;
  /** seconds until the deadline, 0 once passed (null if the deadline is unreadable) */
  secondsLeft: number | null; passed: boolean;
  /** true while passing the deadline lets the buyer refund with the arbiter's automatic co-signature */
  autoRefund: boolean;
  /** when the automatic refund becomes possible (= deadline), null when it does not apply */
  autoRefundAt: string | null;
  /** RECOMMENDED dispute-by time: the deadline minus a safety margin (see disputeMarginSec), null when it does not apply */
  disputeBy: string | null;
  /** seconds until disputeBy, 0 once it passed (null when it does not apply) */
  secondsRemaining: number | null;
  /** true once the recommended dispute-by time passed (a dispute still works until the refund is paid out) */
  disputeByPassed: boolean;
  /** margin between disputeBy and the deadline in seconds (null when it does not apply) */
  disputeMarginSec: number | null;
  /** what it means for each party (plain words) */
  buyer: string; seller: string;
}
/** Recommended dispute margin = 10% of the funded window (funding time -> deadline), at least 60 s, at most 24 h, and never more
 *  than half the window (so disputeBy stays after the funding time and before the deadline). The half-window cap wins over the 60 s
 *  floor: a window under 120 s gets less than 60 s (60 s window -> 30 s). No usable window: 0. */
export const DISPUTE_MARGIN_PCT = 10, DISPUTE_MARGIN_MIN_SEC = 60, DISPUTE_MARGIN_MAX_SEC = 86400;
export function disputeMarginSec(startMs: number, deadlineMs: number): number {
  const w = Math.floor((deadlineMs - startMs) / 1000);
  if (!Number.isFinite(w) || w <= 0) return 0;
  return Math.min(DISPUTE_MARGIN_MAX_SEC, Math.max(DISPUTE_MARGIN_MIN_SEC, Math.floor((w * DISPUTE_MARGIN_PCT) / 100)), Math.floor(w / 2));
}
const ACTIVE = ["funded", "releasing", "refunding"];
const FINAL = ["released", "refunded", "expired"];
export function deadlineCountdown(d: CountdownInput, nowMs: number): DeadlineCountdown {
  const t = Date.parse(d.deadline); const ok = Number.isFinite(t);
  const left = ok ? Math.max(0, Math.floor((t - nowMs) / 1000)) : null; const passed = ok && nowMs >= t;
  const id = d.id ?? "<id>";
  const na = (reason: CountdownReason, both: string, seller = both) =>
    ({ status: "not_applicable" as const, reason, deadline: typeof d.deadline === "string" ? d.deadline : null, secondsLeft: left, passed, autoRefund: false, autoRefundAt: null, disputeBy: null,
      secondsRemaining: null, disputeByPassed: false, disputeMarginSec: null, buyer: both, seller });
  if (!ok) return na("bad_deadline", "The deadline is unreadable; ask the operator (mark escrow messages).");
  if (FINAL.includes(d.state)) return na("final", `Final (${d.state}): no deadline applies any more.`);
  if (d.state === "created") return na("unfunded", "Not funded yet: no refund clock runs. An unfunded deal expires shortly after the deadline (see expiresAt).", "Not funded yet: do not deliver before the deal is funded. An unfunded deal expires shortly after the deadline (see expiresAt).");
  if (d.ruled) return na("ruled", "Ruled by the operator: the ruling decides the payout, not the deadline.");
  if (d.disputed || d.state === "disputed") return na("disputed", "Dispute open: the automatic refund is stopped until the operator rules.");
  // a state this code does not know (a newer server): do not claim "no refund clock", say it is unknown
  if (!ACTIVE.includes(d.state)) return na("unknown_state", `Unknown deal state ${JSON.stringify(String(d.state)).slice(0, 40)}: this countdown cannot tell whether a refund clock runs. Check the deal with the operator (mark escrow messages) or update Mark; if you are the seller and delivered, do not wait past the deadline ${d.deadline} to dispute.`);
  if (d.arbiterMode === "manual") return na("manual_arbiter", "Manual arbiter mode: there is no automatic refund at the deadline; only buyer + seller, or an operator ruling, move the funds.");
  if (d.aboveAutoCap) return na("above_auto_cap", "Above the server's auto-arbiter cap: there is no automatic refund at the deadline; only buyer + seller, or an operator ruling, move the funds.");
  const startMs = [d.fundedAt, d.createdAt].map((x) => (typeof x === "string" ? Date.parse(x) : NaN)).find((x) => Number.isFinite(x)) ?? t;
  const margin = disputeMarginSec(startMs, t); const byMs = t - margin * 1000; const by = new Date(byMs).toISOString();
  const byPassed = nowMs >= byMs;
  const base = { deadline: d.deadline, secondsLeft: left, passed, autoRefund: true, autoRefundAt: d.deadline, disputeBy: by,
    secondsRemaining: Math.max(0, Math.floor((byMs - nowMs) / 1000)), disputeByPassed: byPassed, disputeMarginSec: margin };
  const when = `Dispute by ${by} (recommended, leaves a margin); the refund can be paid out from ${d.deadline}.`;
  if (passed) return { status: "passed", reason: "passed", ...base,
    buyer: `Deadline passed: you can refund yourself now (buyer + arbiter): mark escrow refund ${id} --payout-lnaddr <you@wallet>`,
    seller: `Deadline passed: the buyer can refund at any moment with the arbiter's automatic co-signature. If you delivered and were not paid, open a dispute now: mark escrow dispute ${id} --reason "..." (it only helps if the refund has not been paid out yet).` };
  return { status: "running", reason: "running", ...base,
    buyer: `If the seller has not delivered by the deadline, you can refund yourself after it (buyer + arbiter, co-signed automatically).`,
    seller: byPassed
      ? `${when} The recommended time has passed: if you delivered and were not paid, open a dispute now (mark escrow dispute ${id} --reason "..."), before the deadline.`
      : `${when} Delivering does not stop this clock: if the buyer has not released by then, open a dispute (mark escrow dispute ${id} --reason "..."), or the buyer can refund with the arbiter after the deadline.` };
}
/** One party's view: its own note only (`note`), the other party's text dropped. */
export function countdownFor(c: DeadlineCountdown, role: "buyer" | "seller") {
  const { buyer, seller, ...rest } = c; return { ...rest, note: role === "buyer" ? buyer : seller };
}
