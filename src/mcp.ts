/** MCP adapter: same core use-cases as the CLI, exposed as stdio tools. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorJson, toJson } from "./errors.js";
import type { NetworkName } from "./config.js";
import { openCtx, type Ctx, type CtxOptions } from "./core/context.js";
import { updateNotice } from "./core/clientVersion.js";
import * as uc from "./core/usecases.js";
import { MARK_VERSION } from "./version.js";
import { mk, DEMO_SATS, WALLET_DOCS } from "./invocation.js";
import os from "node:os";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: toJson(o, 0) }] });
/** Adds `updateNotice` (this Mark is older than the escrow server's latestMarkVersion) to an object result, after removing any
 *  `updateNotice` already in it. `notice` is taken
 *  (demo / evidence results). A non-object result gets the notice as a second text item. */
export function withNotice(o: unknown, n: string | null) {
  // only Mark adds `updateNotice`: a top-level field of that name coming from the server's payload is dropped, so it can't pose as
  // one (nested fields of that name are plain data inside the deal and are left alone)
  if (o && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, "updateNotice")) { const { updateNotice: _drop, ...rest } = o as Record<string, unknown>; o = rest; }
  if (!n) return text(o);
  if (o && typeof o === "object" && !Array.isArray(o)) return text({ ...(o as object), updateNotice: n });
  const t = text(o); return { content: [...t.content, { type: "text" as const, text: toJson({ updateNotice: n }, 0) }] };
}
let ctx: Ctx | undefined;
/** Set when this server generated the agent key: added once, as `keyNotice`, to the first tool result (many MCP clients never show
 *  the server instructions or stderr to the model). */
let keyNotice: string | null = null;
/** Adds the one-time `keyNotice` to an object result (a top-level `keyNotice` from anywhere else is dropped first). */
export function withKeyNotice(o: unknown, n: string | null): unknown {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  const { keyNotice: _drop, ...rest } = o as Record<string, unknown>;
  return n ? { ...rest, keyNotice: n } : rest;
}
const takeKeyNotice = () => { const n = keyNotice; keyNotice = null; return n; };
const notice = (e?: any) => (ctx && e?.code !== "UPGRADE_REQUIRED" ? updateNotice(ctx, { fetch: !["ESCROW_UNREACHABLE", "ESCROW_URL_MISSING", "ESCROW_BAD_RESPONSE"].includes(e?.code) }) : Promise.resolve(null));
const wrap = (fn: () => Promise<unknown>) => fn().then(async (o) => withNotice(withKeyNotice(o, takeKeyNotice()), await notice()))
  .catch(async (e) => ({ ...withNotice(withKeyNotice(errorJson(e), takeKeyNotice()), await notice(e)), isError: true }));
/** Shown on every Ark field: the escrow runs on one Arkade server; other Ark servers' addresses (Bark / Second) do not work. */
const ARK_ONLY = "Ark address from an Arkade wallet on this escrow's Arkade server (escrow_limits arkade.url; mainnet https://arkade.computer). Bark / Second Ark addresses will NOT work: use payoutInvoice or payoutLnaddr instead. Checked before anything is signed";
const payout = { payoutInvoice: z.string().optional(), payoutLnaddr: z.string().optional(), payoutArk: z.string().optional().describe(ARK_ONLY) };

/** Server-level description that MCP clients show the model (tool search / selection). */
const MCP_BODY = "Agent Escrow (Mark): non-custodial 2-of-3 bitcoin escrow for deals between AI agents, with Lightning in and out. Use it when you pay another agent for a job or get paid by one and neither side should have to trust the other: funds are locked until delivery, released when both sign, refunded after the deadline, or ruled by a neutral arbiter on dispute. The operator holds only the arbiter key and cannot move funds alone. Start: escrow_limits (fees: free up to 33,000 sats, 1% of the whole amount above), escrow_reputation (check the counterparty), escrow_create (buyer or seller), then act on awaiting and action_required_for in each response. Mainnet is real money.";
const tilde = (d: string) => { const h = os.homedir(); return h && (d === h || d.startsWith(h + "/")) ? "~" + d.slice(h.length) : d; };
/** Server instructions: first-run guidance at the very top, then what the server is for. `keyCreated` only when this server
 *  generated the key in this session (else the generic "keys live in" line). */
export function mcpInstructions(o: { keyCreated?: boolean; dir?: string; network?: string; cmd?: string } = {}) {
  const dir = tilde(o.dir ?? "~/.mark/bitcoin"), backup = `${o.cmd ?? "mark"} backup${o.network && o.network !== "bitcoin" ? ` --network ${o.network}` : ""}`;
  const key = o.keyCreated ? `First time? This server just created this agent's key in ${dir}. Tell your human to back it up (\`${backup}\` in a terminal).`
    : `This agent's keys live in ${dir}; your human can back them up with \`${backup}\` in a terminal.`;
  return `${key} No counterparty yet: call escrow_demo (free preview, nothing is created) and show your human the ${DEMO_SATS}-sat house-seller deal. Paying needs a Lightning wallet, e.g. Bark: ${WALLET_DOCS}. ${MCP_BODY}`;
}
/** The generic instructions (no key created this session, default data dir). */
export const MCP_INSTRUCTIONS = mcpInstructions();

export async function runMcp(network: NetworkName, o: CtxOptions = {}) {
  const c = (ctx = await openCtx(network, o));
  const instructions = mcpInstructions({ keyCreated: c.keyCreated, dir: c.dir, network, cmd: mk() });
  if (c.keyCreated) keyNotice = `This server just created this agent's key in ${tilde(c.dir)} (pubkey ${c.pubkey}). Tell your human to back it up now: run \`${mk()} backup${network !== "bitcoin" ? ` --network ${network}` : ""}\` in a terminal. Deleting that folder loses this identity and access to its deals.`;
  const s = new McpServer({ name: "mark", version: MARK_VERSION }, { instructions });
  s.tool("pubkey", "This agent's escrow public key (x-only hex)", {}, () => wrap(async () => uc.pubkey(c)));
  s.tool("escrow_create", "Start an escrowed deal with another agent so you can pay it (role buyer) or get paid by it (role seller) without trusting it: non-custodial 2-of-3 bitcoin escrow, funded and paid out over Lightning. Terms you write here are signed by both sides and are what the arbiter rules on. Check escrow_limits and escrow_reputation first; next the counterparty calls escrow_accept, then the buyer calls escrow_fund.", { role: z.enum(["buyer", "seller"]), counterparty: z.string(), sats: z.number().int().positive(), deadline: z.string().describe("seconds from now or ISO time"), hash: z.string().optional(), arbiterMode: z.enum(["auto", "manual"]).optional(),
      terms: z.object({ title: z.string().max(120), description: z.string().max(4000), deliverable: z.string().max(1000).optional(), acceptance: z.string().max(2000).optional(), deliverableSha256: z.string().optional() }).describe("What is being traded; the arbiter rules disputes on this. Signed by you at create; the counterparty must escrow_accept before funding") },
    (a) => wrap(() => uc.create(c, a)));
  s.tool("escrow_reputation", "Check a counterparty before you pay or accept a deal. Public reputation of a pubkey on this escrow server: dealsCompleted, satsTransacted (approx, 2 significant figures), ruled disputesWon/Lost, firstSeen (first funded deal), lastSeen (latest released/refunded deal; null if none). Funded deals only. An indicator, not a guarantee (wash trading between one's own keys is possible). escrow_show/escrow_status/escrow_accept include the counterparty's automatically", { pubkey: z.string().describe("64-hex x-only pubkey") }, ({ pubkey }) => wrap(() => uc.reputation(c, pubkey)));
  s.tool("escrow_demo", "No counterparty yet? Make a first real escrowed purchase from the always-on house seller agent (default offer: 350 sats). First real deal with the escrow server's always-on house seller agent (default offer: a Markdown summary of one public web page for 350 sats; also research for 1,500; no platform fee). REAL MONEY on mainnet, and not instant: the seller checks every few minutes and delivers within the offer's turnaround. Without confirm=true it only previews (offer, cost, inputs, exact terms) and creates nothing. Inputs become the deal description's Key: value lines (url, words, ...; validated locally). With confirm=true it creates the deal as buyer, waits for the seller's accept and returns the Lightning funding invoice; after paying, call escrow_fund with wait=true (that claims the payment into the escrow; funding stays pending until then). The seller delivers in the deal thread (escrow_messages); then release with escrow_approve. Call again to see where the demo deal stands (it resumes; fresh=true starts a new one)",
    { offer: z.string().optional().describe("offer id from GET /demo (default: the server's default, summary)"), url: z.string().optional().describe("summary: public https:// page to summarize"), text: z.string().max(3500).optional().describe("summary: pasted text instead of url"),
      words: z.number().int().positive().optional().describe("summary 50-400 (default 200); research 300-1200"), focus: z.string().optional(), language: z.string().optional(), question: z.string().optional().describe("research: the question"), scope: z.string().optional(), topic: z.string().optional().describe("title topic (default: from url/question)"),
      confirm: z.boolean().optional().describe("must be true to create the real deal; omit to preview"), expectSats: z.number().int().positive().optional().describe("the amount you previewed; refuses if the offer changed"), wait: z.boolean().optional().describe("after payment: claim the funding and wait for the delivery"), fresh: z.boolean().optional() },
    ({ offer, topic, confirm, expectSats, wait, fresh, ...inp }) => wrap(() => uc.demo(c, { offer, topic, fields: Object.fromEntries(Object.entries(uc.DEMO_INPUT_KEYS).map(([k, key]) => [key, (inp as any)[k]])), confirm: confirm === true, expectSats, wait, fresh })));
  s.tool("escrow_show", "Deal terms (what it is for), who accepted (signatures verified locally), evidence, awaiting / action_required_for / arbiterPolicy, and deadlineCountdown: the auto-refund deadline, disputeBy and secondsLeft with a note for your role (a seller who delivered to a silent buyer must dispute before disputeBy)", { id: z.string() }, ({ id }) => wrap(() => uc.show(c, id)));
  s.tool("escrow_accept", "Accept the deal terms: verifies termsHash, the escrow address and the arbiter key locally, then signs termsHash with this agent's key (terms v2: the signature also covers the release rule, arbiter mode and deadline). Required from both parties before funding. A buyer is refused (UNSAFE_RULE) when the seller chose an automatic release rule (hash lock / webhook); pass allowCounterpartyRule=true only after the user explicitly agrees", { id: z.string(), allowCounterpartyRule: z.boolean().optional() }, ({ id, allowCounterpartyRule }) => wrap(() => uc.accept(c, id, { allowCounterpartyRule })));
  s.tool("escrow_evidence", "Add a signed, timestamped evidence note to a deal (seller: post the deliverable sha256 after delivering off-band; for the arbiter in a dispute)", { id: z.string(), text: z.string().max(4000).optional(), note: z.string().max(4000).optional().describe("alias of text"), sha256: z.string().optional().describe("sha256 hex of a file/log"), file: z.string().optional().describe("local file path: hashed locally (never uploaded); the sha256 is signed into the evidence and checked against the terms deliverableSha256"), url: z.string().optional() }, ({ id, note, text, ...a }) => wrap(() => uc.addEvidence(c, id, { ...a, text: text ?? note })));
  s.tool("escrow_messages", "Read a deal's support thread with the operator (signatures verified: operator against the deal's arbiter key). since = cursor from the last read", { id: z.string(), since: z.number().int().nonnegative().optional() }, ({ id, since }) => wrap(() => uc.messages(c, id, since)));
  s.tool("escrow_message", "Post a signed message to a deal's thread (ask the operator a question, explain a dispute, point to evidence). A dispute message does NOT open a dispute: use escrow_dispute for that", { id: z.string(), text: z.string().max(4000), kind: z.enum(["question", "dispute", "evidence", "info"]).optional(), replyTo: z.string().optional().describe("message id being answered") }, ({ id, text, kind, replyTo }) => wrap(() => uc.postMessage(c, id, { text, kind, replyTo })));
  s.tool("escrow_invites", "Deals created for this agent's key that wait for its accept (no id needed). all=true lists every deal this key is in; needs filters accept|fund|sign|any; state filters by deal state. Each item has awaiting, action_required_for and nextStep (newer servers also send deadlineCountdown for your role)", { all: z.boolean().optional(), needs: z.enum(["accept", "fund", "sign", "any"]).optional(), state: z.string().optional() }, (a) => wrap(() => uc.invites(c, a)));
  s.tool("escrow_inbox", "Unread messages across this agent's deals (operator replies, system notices)", {}, () => wrap(() => uc.inbox(c)));
  s.tool("escrow_status", "Escrow state, proposals, events, and deadlineCountdown (auto-refund deadline, disputeBy, secondsLeft, a note for your role)", { id: z.string() }, ({ id }) => wrap(() => uc.status(c, id)));
  s.tool("escrow_fund", "Buyer: get the Lightning invoice that funds the escrow; after paying, call again with wait=true to lock the funds. Or rail=ark: direct Ark payment with no swap fee: returns the escrow address, the exact sats and the Arkade server (url + key); pay it in ONE payment from an Arkade wallet on that server (Bark / Second cannot pay it: use Lightning), then call with rail=ark, wait=true; smaller payments are not added up (status shows underpaid), a larger one is held whole. Switching rails after one was started needs switchRail=true (only if nothing was paid on the other rail). Refuses when the deal expires within an hour (deadline + 1 h grace); an expired deal reports state expired. Refuses (UNSAFE_RULE) a deal whose auto-release rule the seller chose (a hash lock it created, or a webhook rule): the seller could be paid without you. Pass allowCounterpartyRule=true only after the user explicitly agrees. A later call shows the same invoice again while it is unpaid, and says paymentReceived (do NOT pay again) once it is paid. If a claim fails (claimFailed, note) or times out at swap status serverfunded/clientredeeming, call again with resumeClaim=true: it finishes or retries the claim of the paid swap into the escrow and never creates an invoice.", { id: z.string(), rail: z.enum(["lightning", "ark"]).optional().describe("lightning (default, Satora swap) or ark (direct payment from an Arkade wallet on this escrow's Arkade server)"), wait: z.boolean().optional(), allowCounterpartyRule: z.boolean().optional(), switchRail: z.boolean().optional().describe("confirm switching from the other rail: nothing was paid there"), resumeClaim: z.boolean().optional().describe("lightning only: finish/retry the Arkade claim of the already paid funding swap; no new invoice") },
    ({ id, rail, wait, allowCounterpartyRule, switchRail, resumeClaim }) => wrap(() => rail === "ark" ? (resumeClaim ? Promise.reject(Object.assign(new Error("resumeClaim is for a Lightning funding swap, not rail=ark"), { code: "USAGE" })) : uc.fundArk(c, id, { wait, allowCounterpartyRule, switchRail })) : uc.fund(c, id, { wait, allowCounterpartyRule, resumeClaim, switchRail })));
  s.tool("escrow_quote", "Payout quote: exact payout sats, recommendedInvoiceSats (create the BOLT11 for this) and the accepted min/maxInvoiceSats range", { id: z.string(), path: z.enum(["release", "refund"]).optional(), dest: z.string().optional().describe("payee lightning address or any BOLT11 from the payee wallet, for the exact route-specific amount") }, ({ id, path, dest }) => wrap(() => uc.quote(c, id, path ?? "release", dest)));
  s.tool("escrow_limits", "Server limits: arkade (the Arkade server URL and key this escrow runs on; Ark addresses must come from an Arkade wallet there, not Bark/Second), minimum deal size for Lightning and Ark payouts, platform fee schedule (free up to 33000 sats, then 1% of the whole amount; ruled dispute +max(5%,330) from 3300), free tier, Satora min/max, Ark dust. With sats: upfront fee preview (platform fee, possible dispute fee, estimated swap cost, min/max deal)", { sats: z.number().int().positive().optional() }, ({ sats }) => wrap(() => uc.limits(c, sats)));
  s.tool("escrow_pending", "Pending payout proposals and their payout details (read-only). Without id: across all this agent's deals, with what each awaits and the co-sign command", { id: z.string().optional() }, ({ id }) => wrap(() => (id ? uc.pending(c, id) : uc.pendingAll(c))));
  s.tool("escrow_approve", "Sign a pending proposal, or (as payee) propose with a payout: payoutInvoice (fresh BOLT11 for the quote's recommendedInvoiceSats). A co-signer passes no payout, payoutLnaddr, or payoutArk", { id: z.string(), kind: z.enum(["release", "refund"]).optional(), with: z.enum(["counterparty", "arbiter"]).optional(), preimage: z.string().optional(), ...payout },
    ({ id, ...a }) => wrap(() => uc.approve(c, id, a)));
  s.tool("escrow_dispute", "Open a dispute (arbiter auto-signing stops; admin rules)", { id: z.string(), reason: z.string().optional() }, ({ id, reason }) => wrap(() => uc.dispute(c, id, reason)));
  s.tool("escrow_refund", "Buyer: propose refund with a fresh payout (arbiter co-signs after deadline)", { id: z.string(), ...payout }, ({ id, ...a }) => wrap(() => uc.refund(c, id, a)));
  s.tool("escrow_refund_payout", "Refund a failed Lightning payout swap to an Ark address (from an Arkade wallet on this escrow's Arkade server)", { id: z.string(), to: z.string().optional().describe(ARK_ONLY) }, ({ id, to }) => wrap(() => uc.refundPayout(c, id, to)));
  await s.connect(new StdioServerTransport());
}
