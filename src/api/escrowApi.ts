/**
 * HTTP client for the escrow REST contract (docs/escrow-api.md). The ONLY place Mark talks to the server.
 * `fetchImpl` is injectable so tests can mock the API without a server.
 */
import { MarkError } from "../errors.js";

export type Party = "buyer" | "seller" | "arbiter";
export interface Auth { party: "buyer" | "seller"; ts: number; sig: string }
export type Payout = { type: "invoice"; invoice: string; swapId: string } | { type: "lnaddr"; address: string; swapId: string } | { type: "ark"; address: string };

export interface ProposalSummary { id: string; kind: "release" | "refund"; dest: string; signers: Party[]; sigs: Party[]; submittedTxid?: string }
export interface ProposalFull extends ProposalSummary { arkTx: string; checkpoints: string[] }
export interface Escrow {
  id: string; state: string; amountSats: number; deadline: string; address: string;
  buyerPubkey: string; sellerPubkey: string; arbiterPubkey: string;
  funding?: { outpoint: string; amount: number }; proposals: ProposalSummary[]; [k: string]: unknown;
}
export interface Quote { escrowSats: number; lightning: { invoiceSats: number; protocolFeeSats: number; networkFeeSats: number; minSats: number; maxSats: number }; ark: { payoutSats: number }; [k: string]: unknown }

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
    if (!r.ok) throw new MarkError(j?.code || "ESCROW_ERROR", j?.error || `HTTP ${r.status}`);
    return j as T;
  }

  create(b: { buyerPubkey: string; sellerPubkey: string; amountSats: number; deadline: number | string; rule: unknown; arbiterMode?: string; webhookUrl?: string }) { return this.call<Escrow>("POST", "/escrows", b); }
  get(id: string) { return this.call<Escrow>("GET", `/escrows/${enc(id)}`); }
  quote(id: string, path: "release" | "refund") { return this.call<Quote>("GET", `/escrows/${enc(id)}/quote?path=${path}`); }
  proposal(id: string, pid: string) { return this.call<ProposalFull>("GET", `/escrows/${enc(id)}/proposals/${enc(pid)}`); }
  propose(id: string, b: { kind: "release" | "refund"; payout: Payout; signers: Party[]; preimage?: string; auth: Auth }) { return this.call<{ escrow: Escrow; proposal: ProposalSummary }>("POST", `/escrows/${enc(id)}/proposals`, b); }
  sign(id: string, pid: string, b: { party: "buyer" | "seller"; arkTx: string; checkpoints: string[] }) { return this.call<{ escrow: Escrow; proposal: ProposalSummary }>("POST", `/escrows/${enc(id)}/proposals/${enc(pid)}/signatures`, b); }
  dispute(id: string, b: { reason?: string; auth: Auth }) { return this.call<Escrow>("POST", `/escrows/${enc(id)}/dispute`, b); }
}
const enc = encodeURIComponent;
