/**
 * HTTP client for the escrow REST contract (docs/escrow-api.md). The ONLY place Mark talks to the server.
 * `fetchImpl` is injectable so tests can mock the API without a server.
 */
import { MarkError } from "../errors.js";
import type { FeeTerms } from "../core/fees.js";

export type Party = "buyer" | "seller" | "arbiter";
export interface Auth { party: "buyer" | "seller"; ts: number; sig: string }
export type Payout = { type: "invoice"; invoice: string; swapId: string } | { type: "lnaddr"; address: string; swapId: string } | { type: "ark"; address: string };

export interface ProposalSummary { id: string; kind: "release" | "refund"; dest: string; signers: Party[]; sigs: Party[]; submittedTxid?: string }
export interface ProposalFull extends ProposalSummary { arkTx: string; checkpoints: string[]; payout?: { type: string; invoice?: string; address?: string; swapId?: string; sats?: number } }
export interface Escrow {
  id: string; state: string; amountSats: number; deadline: string; address: string;
  buyerPubkey: string; sellerPubkey: string; arbiterPubkey: string;
  funding?: { outpoint: string; amount: number }; proposals: ProposalSummary[];
  /** null on legacy deals */
  terms?: { title: string; description: string; deliverable?: string; acceptance?: string; deliverableSha256?: string } | null; termsHash?: string | null;
  acceptances?: Partial<Record<"buyer" | "seller", { sig: string; at: string }>> | null; termsAgreed?: boolean;
  /** Published fee terms (covered by termsHash); absent on legacy / pre-fee deals = no fees. */
  fees?: FeeTerms | null; dispute?: unknown; ruling?: { outcome: string; at: string } | null;
  evidence?: { id: string; party: "buyer" | "seller"; at: string; ts: number; text: string; sha256?: string; url?: string; sig: string }[];
  [k: string]: unknown;
}
export interface Quote { escrowSats: number; lightning: { invoiceSats: number; recommendedInvoiceSats?: number; minInvoiceSats?: number; maxInvoiceSats?: number; toleranceSats?: number; protocolFeeSats: number; networkFeeSats: number; minSats: number; maxSats: number; exact?: boolean; estimate?: boolean; quoteType?: "exact" | "estimate"; estimateMarginSats?: number; dest?: string }; ark: { payoutSats: number };
  amountlessInvoice?: { supported: boolean; setInvoiceAmountSats: number; note: string }; [k: string]: unknown }

export interface Limits { network: string; minDealSats: { lightning: number; ark: number; enforced: number }; maxDealSats: number; freeBelowSats: number | null; dustSats: number;
  fees: { enabled: boolean; source: string | null; address: string | null; feeBps: number; disputeFeeBps: number; freeBelowSats: number | null; flatSats?: number; flatUntilSats?: number | null; disputeMinSats?: number; dustBumpMaxBps?: number | null; terms: FeeTerms | null; schedule?: { platform: string; dispute: string } | null; warning?: string };
  satora: { minSats: number; maxSats: number; fetchedAt: string; stale: boolean }; feePreview?: FeePreview; [k: string]: unknown }
export type FeePreview = ReturnType<typeof import("../core/fees.js").feePreview>;

export interface Message { seq: number; id: string; escrowId: string; author: "buyer" | "seller" | "operator"; pubkey: string; body: string; kind?: string; replyTo?: string; ts: number; createdAt: string; sig: string }
export interface MessageList { escrowId: string; state: string; arbiterPubkey: string; buyerPubkey: string; sellerPubkey: string; messages: Message[]; cursor: number }

export class EscrowApi {
  constructor(private baseUrl: string | undefined, private fetchImpl: typeof fetch = fetch, private timeoutMs = 180_000) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.baseUrl) throw new MarkError("ESCROW_URL_MISSING", "escrow server URL not set: pass --escrow-url, set MARK_ESCROW_URL, or `mark init --escrow-url <url>`");
    let r: Response;
    try {
      r = await this.fetchImpl(this.baseUrl + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e: any) { throw new MarkError("ESCROW_UNREACHABLE", `escrow service ${this.baseUrl}: ${e.message}`); }
    let j: any;
    try { j = await r.json(); } catch { throw new MarkError("ESCROW_BAD_RESPONSE", `non-JSON response (HTTP ${r.status})`); }
    if (!r.ok) throw new MarkError(j?.code || "ESCROW_ERROR", j?.error || `HTTP ${r.status}`, j?.details); // keep server details (e.g. AMOUNT_MISMATCH range + recommended amount)
    return j as T;
  }

  create(b: { buyerPubkey: string; sellerPubkey: string; amountSats: number; deadline: number | string; rule: unknown; arbiterMode?: string; webhookUrl?: string; terms?: unknown; termsHash?: string; creatorAcceptance?: { party: "buyer" | "seller"; sig: string } }) { return this.call<Escrow>("POST", "/escrows", b); }
  /** GET /limits: minimum deal sizes, fee rates + current fee terms, Satora min/max, Ark dust. */
  limits(sats?: number) { return this.call<Limits>("GET", `/limits${sats ? `?sats=${sats}` : ""}`); }
  get(id: string) { return this.call<Escrow>("GET", `/escrows/${enc(id)}`); }
  quote(id: string, path: "release" | "refund", dest?: string) { return this.call<Quote>("GET", `/escrows/${enc(id)}/quote?path=${path}${dest ? `&dest=${encodeURIComponent(dest)}` : ""}`); }
  proposal(id: string, pid: string) { return this.call<ProposalFull>("GET", `/escrows/${enc(id)}/proposals/${enc(pid)}`); }
  propose(id: string, b: { kind: "release" | "refund"; payout: Payout; signers: Party[]; preimage?: string; auth: Auth }) { return this.call<{ escrow: Escrow; proposal: ProposalSummary }>("POST", `/escrows/${enc(id)}/proposals`, b); }
  sign(id: string, pid: string, b: { party: "buyer" | "seller"; arkTx: string; checkpoints: string[] }) { return this.call<{ escrow: Escrow; proposal: ProposalSummary }>("POST", `/escrows/${enc(id)}/proposals/${enc(pid)}/signatures`, b); }
  /** Report the Satora LN->Arkade funding swap so the server can record funding fees (server verifies it with Satora). */
  reportFundingSwap(id: string, swapId: string) { return this.call<{ escrowId: string; recorded: boolean }>("POST", `/escrows/${enc(id)}/funding-swap`, { swapId }); }
  accept(id: string, b: { party: "buyer" | "seller"; sig: string; termsHash: string }) { return this.call<Escrow>("POST", `/escrows/${enc(id)}/accept`, b); }
  evidence(id: string, b: { party: "buyer" | "seller"; ts: number; sig: string; text: string; sha256?: string; url?: string }) { return this.call<Escrow>("POST", `/escrows/${enc(id)}/evidence`, b); }
  /** GET /escrows/:id/messages (party auth over action "messages"). */
  messages(id: string, a: { party: "buyer" | "seller"; ts: number; sig: string }, since?: number) { return this.call<MessageList>("GET", `/escrows/${enc(id)}/messages?party=${a.party}&ts=${a.ts}&sig=${a.sig}${since ? `&since=${since}` : ""}`); }
  postMessage(id: string, b: { author: "buyer" | "seller"; ts: number; sig: string; body: string; kind?: string; replyTo?: string }) { return this.call<Message>("POST", `/escrows/${enc(id)}/messages`, b); }
  dispute(id: string, b: { reason?: string; auth: Auth }) { return this.call<Escrow>("POST", `/escrows/${enc(id)}/dispute`, b); }
}
const enc = encodeURIComponent;
