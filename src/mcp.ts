/** MCP adapter: same core use-cases as the CLI, exposed as stdio tools. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorJson, toJson } from "./errors.js";
import type { NetworkName } from "./config.js";
import { openCtx, type CtxOptions } from "./core/context.js";
import * as uc from "./core/usecases.js";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: toJson(o, 0) }] });
const wrap = (fn: () => Promise<unknown>) => fn().then(text).catch((e) => ({ ...text(errorJson(e)), isError: true }));
const payout = { payoutInvoice: z.string().optional(), payoutLnaddr: z.string().optional(), payoutArk: z.string().optional() };

export async function runMcp(network: NetworkName, o: CtxOptions = {}) {
  const c = await openCtx(network, o);
  const s = new McpServer({ name: "mark", version: "0.1.0" });
  s.tool("pubkey", "This agent's escrow public key (x-only hex)", {}, () => wrap(async () => uc.pubkey(c)));
  s.tool("escrow_create", "Create a 2-of-3 escrow (cap enforced)", { role: z.enum(["buyer", "seller"]), counterparty: z.string(), sats: z.number().int().positive(), deadline: z.string().describe("seconds from now or ISO time"), hash: z.string().optional(), arbiterMode: z.enum(["auto", "manual"]).optional(),
      terms: z.object({ title: z.string().max(120), description: z.string().max(4000), deliverable: z.string().max(1000).optional(), acceptance: z.string().max(2000).optional(), deliverableSha256: z.string().optional() }).describe("What is being traded; the arbiter rules disputes on this. Signed by you at create; the counterparty must escrow_accept before funding") },
    (a) => wrap(() => uc.create(c, a)));
  s.tool("escrow_reputation", "Public reputation of a pubkey on this escrow server: dealsCompleted, satsTransacted (approx, 2 significant figures), ruled disputesWon/Lost, firstSeen. Funded deals only. An indicator, not a guarantee (wash trading between one's own keys is possible). escrow_show/escrow_status/escrow_accept include the counterparty's automatically", { pubkey: z.string().describe("64-hex x-only pubkey") }, ({ pubkey }) => wrap(() => uc.reputation(c, pubkey)));
  s.tool("escrow_show", "Deal terms (what it is for), who accepted (signatures verified locally), evidence, awaiting / action_required_for / arbiterPolicy", { id: z.string() }, ({ id }) => wrap(() => uc.show(c, id)));
  s.tool("escrow_accept", "Accept the deal terms: verifies termsHash locally and signs it with this agent's key. Required from both parties before funding", { id: z.string() }, ({ id }) => wrap(() => uc.accept(c, id)));
  s.tool("escrow_evidence", "Add a signed, timestamped evidence note to a deal (seller: post the deliverable sha256 after delivering off-band; for the arbiter in a dispute)", { id: z.string(), text: z.string().max(4000).optional(), note: z.string().max(4000).optional().describe("alias of text"), sha256: z.string().optional().describe("sha256 hex of a file/log"), file: z.string().optional().describe("local file path: hashed locally (never uploaded); the sha256 is signed into the evidence and checked against the terms deliverableSha256"), url: z.string().optional() }, ({ id, note, text, ...a }) => wrap(() => uc.addEvidence(c, id, { ...a, text: text ?? note })));
  s.tool("escrow_messages", "Read a deal's support thread with the operator (signatures verified: operator against the deal's arbiter key). since = cursor from the last read", { id: z.string(), since: z.number().int().nonnegative().optional() }, ({ id, since }) => wrap(() => uc.messages(c, id, since)));
  s.tool("escrow_message", "Post a signed message to a deal's thread (ask the operator a question, explain a dispute, point to evidence). A dispute message does NOT open a dispute: use escrow_dispute for that", { id: z.string(), text: z.string().max(4000), kind: z.enum(["question", "dispute", "evidence", "info"]).optional(), replyTo: z.string().optional().describe("message id being answered") }, ({ id, text, kind, replyTo }) => wrap(() => uc.postMessage(c, id, { text, kind, replyTo })));
  s.tool("escrow_invites", "Deals created for this agent's key that wait for its accept (no id needed). all=true lists every deal this key is in; needs filters accept|fund|sign|any; state filters by deal state. Each item has awaiting, action_required_for and nextStep", { all: z.boolean().optional(), needs: z.enum(["accept", "fund", "sign", "any"]).optional(), state: z.string().optional() }, (a) => wrap(() => uc.invites(c, a)));
  s.tool("escrow_inbox", "Unread messages across this agent's deals (operator replies, system notices)", {}, () => wrap(() => uc.inbox(c)));
  s.tool("escrow_status", "Escrow state, proposals, events", { id: z.string() }, ({ id }) => wrap(() => uc.status(c, id)));
  s.tool("escrow_fund", "Get a Lightning invoice that funds the escrow (wait=true claims into escrow after payment)", { id: z.string(), wait: z.boolean().optional() }, ({ id, wait }) => wrap(() => uc.fund(c, id, { wait })));
  s.tool("escrow_quote", "Payout quote: exact payout sats, recommendedInvoiceSats (create the BOLT11 for this) and the accepted min/maxInvoiceSats range", { id: z.string(), path: z.enum(["release", "refund"]).optional(), dest: z.string().optional().describe("payee lightning address or any BOLT11 from the payee wallet, for the exact route-specific amount") }, ({ id, path, dest }) => wrap(() => uc.quote(c, id, path ?? "release", dest)));
  s.tool("escrow_limits", "Server limits: minimum deal size for Lightning and Ark payouts, platform fee schedule (free <3300, 330 flat to 33000, then 1%; ruled dispute +max(5%,330)), free tier, Satora min/max, Ark dust. With sats: upfront fee preview (platform fee, possible dispute fee, estimated swap cost, min/max deal)", { sats: z.number().int().positive().optional() }, ({ sats }) => wrap(() => uc.limits(c, sats)));
  s.tool("escrow_pending", "Pending payout proposals and their payout details (read-only). Without id: across all this agent's deals, with what each awaits and the co-sign command", { id: z.string().optional() }, ({ id }) => wrap(() => (id ? uc.pending(c, id) : uc.pendingAll(c))));
  s.tool("escrow_approve", "Sign a pending proposal, or (as payee) propose with a payout: payoutInvoice (fresh BOLT11 for the quote's recommendedInvoiceSats). A co-signer passes no payout, payoutLnaddr, or payoutArk", { id: z.string(), kind: z.enum(["release", "refund"]).optional(), with: z.enum(["counterparty", "arbiter"]).optional(), preimage: z.string().optional(), ...payout },
    ({ id, ...a }) => wrap(() => uc.approve(c, id, a)));
  s.tool("escrow_dispute", "Open a dispute (arbiter auto-signing stops; admin rules)", { id: z.string(), reason: z.string().optional() }, ({ id, reason }) => wrap(() => uc.dispute(c, id, reason)));
  s.tool("escrow_refund", "Buyer: propose refund with a fresh payout (arbiter co-signs after deadline)", { id: z.string(), ...payout }, ({ id, ...a }) => wrap(() => uc.refund(c, id, a)));
  s.tool("escrow_refund_payout", "Refund a failed Lightning payout swap to an Ark address", { id: z.string(), to: z.string().optional() }, ({ id, to }) => wrap(() => uc.refundPayout(c, id, to)));
  await s.connect(new StdioServerTransport());
}
