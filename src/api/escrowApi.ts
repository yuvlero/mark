/**
 * HTTP client for the escrow REST contract (docs/escrow-api.md). The ONLY place Mark talks to the server.
 * `fetchImpl` is injectable so tests can mock the API without a server.
 */
import { MarkError } from "../errors.js";
import type { FeeTerms } from "../core/fees.js";
import { MARK_VERSION, MARK_USER_AGENT } from "../version.js";
import type { DeadlineCountdown } from "../core/deadline.js";

/** What the server says about Mark versions (GET /limits `client`; absent on older servers). */
export interface ClientPolicy { minMarkVersion: string | null; latestMarkVersion: string | null; refuseUnversioned?: boolean; upgrade?: { command?: string; global?: string; mcp?: string } }
/** Built-in upgrade instructions (the server's own `client.upgrade` is shown instead only if it passes safeUpgrade()). Mark never updates itself. */
export const UPGRADE_HINT = { command: "npx -y @yuvlero/mark@latest", global: "npm install -g @yuvlero/mark@latest",
  mcp: 'MCP: in your MCP client config set the mark server\'s args to ["-y", "@yuvlero/mark@latest", "mcp"] (a bare @yuvlero/mark can keep running an old cached copy), then restart the MCP client.' };

/** Terminal-safe text: drops ANSI/OSC escape sequences, C0/C1 control characters and bidi overrides (a server could otherwise
 *  rewrite or hide what the user sees), collapses whitespace. */
export function plainText(v: string): string {
  return v.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ").trim();
}
/** Commands the user is asked to run: exactly these shapes, nothing else (no extra packages, flags, registries, URLs or tarballs). */
const VER = "(@[0-9A-Za-z.~^-]+)?";
const COMMAND_OK = new RegExp(`^npx (-y|--yes) @yuvlero/mark${VER}$`), GLOBAL_OK = new RegExp(`^npm (i|install) (-g|--global) @yuvlero/mark${VER}$`);
/** MCP hint prose: must name @yuvlero/mark, and once that name is removed, carry no other package, command, URL or shell syntax. */
const mcpOk = (t: string) => t.includes("@yuvlero/mark") && !/(npx|npm|pnpm|yarn|bunx|curl|wget|:\/\/|@|[`$|;&<>\\])/i.test(t.replace(new RegExp(`@yuvlero/mark${VER}`, "g"), ""));
/** The server's upgrade instructions (GET /limits client.upgrade, 426 details.upgrade), field by field: a string (<= 500 chars) that,
 *  after plainText(), is exactly `npx -y @yuvlero/mark[@tag]` (command), `npm install -g @yuvlero/mark[@tag]` (global), or a plain MCP
 *  sentence about @yuvlero/mark (mcp). Anything else (missing, null, wrong type, extra packages/flags/registries, URLs, shell syntax)
 *  is replaced by the built-in UPGRADE_HINT text, so a server can't make Mark print an arbitrary command. */
export function safeUpgrade(u: unknown): { command: string; global: string; mcp: string } {
  const o: Record<string, unknown> = u && typeof u === "object" && !Array.isArray(u) ? (u as Record<string, unknown>) : {};
  const pick = (k: "command" | "global" | "mcp", ok: (t: string) => boolean) => {
    const v = o[k]; if (typeof v !== "string" || v.length > 500) return UPGRADE_HINT[k];
    const t = plainText(v); return ok(t) ? t : UPGRADE_HINT[k];
  };
  return { command: pick("command", (t) => COMMAND_OK.test(t)), global: pick("global", (t) => GLOBAL_OK.test(t)), mcp: pick("mcp", mcpOk) };
}

export type Party = "buyer" | "seller" | "arbiter";
export interface Auth { party: "buyer" | "seller"; ts: number; sig: string }
export type Payout = { type: "invoice"; invoice: string; swapId: string } | { type: "lnaddr"; address: string; swapId: string } | { type: "ark"; address: string };

export interface ProposalSummary { id: string; kind: "release" | "refund"; dest: string; signers: Party[]; sigs: Party[]; submittedTxid?: string }
export interface ProposalFull extends ProposalSummary { arkTx: string; checkpoints: string[]; payout?: { type: string; invoice?: string; address?: string; swapId?: string; sats?: number } }
export interface Escrow {
  id: string; state: string; amountSats: number; deadline: string; address: string;
  buyerPubkey: string; sellerPubkey: string; arbiterPubkey: string;
  /** contract inputs (with the three party keys): Arkade server key + unilateral exit delay; the address is derived from them */
  serverPubkey?: string; exitDelay?: number; network?: string;
  rule?: { type: string; sha256?: string; url?: string }; arbiterMode?: "auto" | "manual";
  /** 2 = signed terms v2 (termsHash covers rule, arbiterMode, deadline, webhookUrlSha256 too); 1 / absent = v1; null = legacy */
  termsVersion?: number | null; webhookUrlSha256?: string | null;
  arbiterAttestation?: { v: string; identityPubkey: string; sig: string } | null;
  /** seenAt: when the server saw the funding (newer servers) */
  funding?: { outpoint: string; amount: number; seenAt?: string; rail?: string }; proposals: ProposalSummary[];
  /** newer servers: payment(s) smaller than amountSats seen while created (they never add up to funding) */
  underpaid?: { vtxos: { outpoint: string; amount: number }[]; totalSats: number; seenAt: string };
  /** newer servers: the server's own auto-refund countdown (Mark recomputes it locally, see core/usecases.ts myCountdown) */
  deadlineCountdown?: unknown;
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

export interface Limits { network: string; termsVersions?: number[]; arbiter?: { identityPubkey: string; attestation: string }; minDealSats: { lightning: number; ark: number; enforced: number }; maxDealSats: number; freeBelowSats: number | null; dustSats: number;
  fees: { enabled: boolean; source: string | null; address: string | null; feeBps: number; disputeFeeBps: number; freeBelowSats: number | null; flatSats?: number; flatUntilSats?: number | null; disputeMinSats?: number; dustBumpMaxBps?: number | null; terms: FeeTerms | null; schedule?: { platform: string; dispute: string } | null; warning?: string };
  satora: { minSats: number; maxSats: number; fetchedAt: string; stale: boolean }; feePreview?: FeePreview; client?: ClientPolicy;
  /** newer servers: the Arkade server this escrow runs on (Ark addresses must be from a wallet on it) and the funding rails */
  arkServer?: { url: string; pubkey: string; network: string; addressPrefix: string; note?: string }; funding?: { rails: string[]; lightning?: string; ark?: string }; [k: string]: unknown }
export type FeePreview = ReturnType<typeof import("../core/fees.js").feePreview>;

export interface Message { seq: number; id: string; escrowId: string; author: "buyer" | "seller" | "operator"; pubkey: string; body: string; kind?: string; replyTo?: string; ts: number; createdAt: string; sig: string }
export interface MessageList { escrowId: string; state: string; arbiterPubkey: string; buyerPubkey: string; sellerPubkey: string; messages: Message[]; cursor: number }

export interface PartyItem { id: string; role: "buyer" | "seller"; counterpartyPubkey: string; sats: number; state: string; createdAt: string; deadline?: string;
  terms: { title: string; deliverable: string | null; acceptance: string | null; termsHash: string | null } | null; termsAccepted: { mine: boolean | null; theirs: boolean | null };
  needs: ("accept" | "fund" | "sign")[]; nextStep: { text: string; command: string };
  /** newer servers: auto-refund countdown for this role (see core/deadline.ts); absent on older servers */
  deadlineCountdown?: Partial<Omit<DeadlineCountdown, "buyer" | "seller">> & { note?: string } }
export interface PartyList { party: string; count: number; escrows: PartyItem[]; nextCursor: string | null }

/** GET /reputation/:pubkey: public aggregates over funded deals (an indicator, not a guarantee). */
export interface Reputation { pubkey: string; dealsCompleted: number; satsTransacted: number; disputesTotal: number; disputesWon: number; disputesLost: number; firstSeen: string | null; lastSeen: string | null }

/** GET /demo: the house-seller demo offers (public, no auth). enabled:false (with code) when the server offers none. */
export interface DemoField { key: string; required?: boolean; type?: "url" | "text" | "int"; maxLength?: number; min?: number; max?: number; default?: string | number }
export interface DemoOfferItem { id: string; sellerPubkey: string; titlePrefix: string; sats: number; deadlineSeconds: number; deadlineMinutes?: number; summary?: string; turnaround?: string | null; feeFree?: boolean;
  description: { format?: string; fields: DemoField[]; oneOf?: string[][] }; deliverable?: string; acceptance?: string }
export interface DemoOffer { enabled: boolean; network?: string; code?: string; error?: string; default?: string; offers?: DemoOfferItem[];
  sellerPubkey?: string; title?: string; sats?: number; deadlineSeconds?: number; deadlineMinutes?: number; summary?: string; feeFree?: boolean }

export class EscrowApi {
  constructor(private baseUrl: string | undefined, private fetchImpl: typeof fetch = fetch, private timeoutMs = 180_000) {}

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.baseUrl) throw new MarkError("ESCROW_URL_MISSING", "escrow server URL not set (only bitcoin has a built-in default, https://agentescrow.to): pass --escrow-url, set MARK_ESCROW_URL, or `mark init --escrow-url <url>`");
    let r: Response;
    try {
      // every request says which Mark this is, so the server can refuse a too-old client with a clear UPGRADE_REQUIRED
      r = await this.fetchImpl(this.baseUrl + path, { method, headers: { "content-type": "application/json", "x-mark-version": MARK_VERSION, "user-agent": MARK_USER_AGENT, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) { throw new MarkError("ESCROW_UNREACHABLE", `escrow service ${this.baseUrl}: ${e.message}`); }
    let j: any;
    try { j = await r.json(); } catch { if (r.status === 426) throw upgradeRequired(this.baseUrl, null); throw new MarkError("ESCROW_BAD_RESPONSE", `non-JSON response (HTTP ${r.status})`); }
    if (r.status === 426 || j?.code === "UPGRADE_REQUIRED") throw upgradeRequired(this.baseUrl, j);
    if (!r.ok) throw new MarkError(j?.code || "ESCROW_ERROR", j?.error || `HTTP ${r.status}`, j?.details); // keep server details (e.g. AMOUNT_MISMATCH range + recommended amount)
    return j as T;
  }

  create(b: { termsVersion?: 2; buyerPubkey: string; sellerPubkey: string; amountSats: number; deadline: number | string; rule: unknown; arbiterMode?: string; webhookUrl?: string; terms?: unknown; termsHash?: string; creatorAcceptance?: { party: "buyer" | "seller"; sig: string } }) { return this.call<Escrow>("POST", "/escrows", b); }
  /** GET /limits: minimum deal sizes, fee rates + current fee terms, Satora min/max, Ark dust. */
  limits(sats?: number, timeoutMs?: number) { return this.call<Limits>("GET", `/limits${sats ? `?sats=${sats}` : ""}`, undefined, {}, timeoutMs); }
  /** GET /escrows?party=: signed listing of my deals. `sign(pathAndQuery)` returns the x-mark-* auth headers. */
  partyList(party: string, q: { needs?: string; state?: string; limit?: number; cursor?: string }, sign: (pathAndQuery: string) => Record<string, string>) {
    const p = new URLSearchParams({ party }); if (q.needs) p.set("needs", q.needs); if (q.state) p.set("state", q.state); if (q.limit) p.set("limit", String(q.limit)); if (q.cursor) p.set("cursor", q.cursor);
    // sign() runs per attempt: every attempt gets a fresh ts + random nonce. A read-only listing is safe to repeat, so a
    // replay refusal (the same signed request reached the server twice, e.g. re-sent by a proxy) is retried once, freshly signed.
    const pq = `/escrows?${p.toString()}`;
    return this.call<PartyList>("GET", pq, undefined, sign(pq)).catch((e) => { if (!isReplayError(e)) throw e; return this.call<PartyList>("GET", pq, undefined, sign(pq)); });
  }
  /** GET /reputation/:pubkey (public, unauthenticated). */
  reputation(pubkey: string, timeoutMs?: number) { return this.call<Reputation>("GET", `/reputation/${enc(pubkey)}`, undefined, {}, timeoutMs); }
  /** GET /demo (public, unauthenticated). Old servers answer 404 NOT_FOUND. */
  demo(timeoutMs = 15_000) { return this.call<DemoOffer>("GET", "/demo", undefined, {}, timeoutMs); }
  get(id: string) { return this.call<Escrow>("GET", `/escrows/${enc(id)}`); }
  quote(id: string, path: "release" | "refund", dest?: string) { return this.call<Quote>("GET", `/escrows/${enc(id)}/quote?path=${path}${dest ? `&dest=${encodeURIComponent(dest)}` : ""}`); }
  proposal(id: string, pid: string) { return this.call<ProposalFull>("GET", `/escrows/${enc(id)}/proposals/${enc(pid)}`); }
  propose(id: string, b: { kind: "release" | "refund"; payout: Payout; signers: Party[]; preimage?: string; auth: Auth }) { return this.call<{ escrow: Escrow; proposal: ProposalSummary }>("POST", `/escrows/${enc(id)}/proposals`, b); }
  sign(id: string, pid: string, b: { party: "buyer" | "seller"; arkTx: string; checkpoints: string[] }) { return this.call<{ escrow: Escrow; proposal: ProposalSummary }>("POST", `/escrows/${enc(id)}/proposals/${enc(pid)}/signatures`, b); }
  /** Report the Satora LN->Arkade funding swap so the server can record funding fees (server verifies it with Satora). */
  /** Report a direct Ark funding (no swap) so the server records the funding rail (ark, fee 0). Older servers: 404 NOT_FOUND. */
  reportArkFunding(id: string) { return this.call<{ escrowId: string; recorded: boolean; rail: string; reason?: string }>("POST", `/escrows/${enc(id)}/funding-ark`, {}); }
  reportFundingSwap(id: string, swapId: string) { return this.call<{ escrowId: string; recorded: boolean }>("POST", `/escrows/${enc(id)}/funding-swap`, { swapId }); }
  accept(id: string, b: { party: "buyer" | "seller"; sig: string; termsHash: string }) { return this.call<Escrow>("POST", `/escrows/${enc(id)}/accept`, b); }
  evidence(id: string, b: { party: "buyer" | "seller"; ts: number; sig: string; text: string; sha256?: string; url?: string }) { return this.call<Escrow>("POST", `/escrows/${enc(id)}/evidence`, b); }
  /** GET /escrows/:id/messages (party auth over action "messages"). */
  messages(id: string, a: { party: "buyer" | "seller"; ts: number; sig: string }, since?: number) { return this.call<MessageList>("GET", `/escrows/${enc(id)}/messages?party=${a.party}&ts=${a.ts}&sig=${a.sig}${since ? `&since=${since}` : ""}`); }
  postMessage(id: string, b: { author: "buyer" | "seller"; ts: number; sig: string; body: string; kind?: string; replyTo?: string }) { return this.call<Message>("POST", `/escrows/${enc(id)}/messages`, b); }
  dispute(id: string, b: { reason?: string; auth: Auth }) { return this.call<Escrow>("POST", `/escrows/${enc(id)}/dispute`, b); }
}
const enc = encodeURIComponent;
/** 426 UPGRADE_REQUIRED: this Mark is older than the server's minimum. The message always carries the update command and the MCP hint. */
export function upgradeRequired(url: string, j: any): MarkError {
  const d = j?.details && typeof j.details === "object" ? j.details : {};
  const up = safeUpgrade(d.upgrade);
  const min = typeof d.minMarkVersion === "string" ? plainText(d.minMarkVersion).slice(0, 64) : null;
  // the server's own text (escape-stripped, marked as the server's), then ALWAYS Mark's instructions: server text can't suppress them
  const said = typeof j?.error === "string" ? plainText(j.error).slice(0, 1000) : "";
  const msg = said ? `${said} [message from the escrow server ${url}]` : `Mark ${MARK_VERSION} is too old for the escrow server ${url}${min ? ` (minimum ${min})` : ""}.`;
  return new MarkError("UPGRADE_REQUIRED", `${msg} Update Mark: ${up.command} (global install: ${up.global}). ${up.mcp} Mark never updates itself.`, { ...d, markVersion: MARK_VERSION, escrowUrl: url, upgrade: up });
}
/** The server's signed-listing replay refusal (401 UNAUTHORIZED "nonce already used (replay)"). */
export const isReplayError = (e: unknown) => e instanceof MarkError && e.code === "UNAUTHORIZED" && /nonce already used/i.test(e.message);
