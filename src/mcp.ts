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
  s.tool("escrow_create", "Create a 2-of-3 escrow (cap enforced)", { role: z.enum(["buyer", "seller"]), counterparty: z.string(), sats: z.number().int().positive(), deadline: z.string().describe("seconds from now or ISO time"), hash: z.string().optional(), arbiterMode: z.enum(["auto", "manual"]).optional() },
    (a) => wrap(() => uc.create(c, a)));
  s.tool("escrow_status", "Escrow state, proposals, events", { id: z.string() }, ({ id }) => wrap(() => uc.status(c, id)));
  s.tool("escrow_fund", "Get a Lightning invoice that funds the escrow (wait=true claims into escrow after payment)", { id: z.string(), wait: z.boolean().optional() }, ({ id, wait }) => wrap(() => uc.fund(c, id, { wait })));
  s.tool("escrow_quote", "Exact sats the payout BOLT11 must request", { id: z.string(), path: z.enum(["release", "refund"]).optional() }, ({ id, path }) => wrap(() => uc.quote(c, id, path ?? "release")));
  s.tool("escrow_approve", "Sign a pending proposal, or (as payee) propose with a payout: payoutInvoice (fresh BOLT11 for the exact quote), payoutLnaddr, or payoutArk", { id: z.string(), kind: z.enum(["release", "refund"]).optional(), with: z.enum(["counterparty", "arbiter"]).optional(), preimage: z.string().optional(), ...payout },
    ({ id, ...a }) => wrap(() => uc.approve(c, id, a)));
  s.tool("escrow_dispute", "Open a dispute (arbiter auto-signing stops; admin rules)", { id: z.string(), reason: z.string().optional() }, ({ id, reason }) => wrap(() => uc.dispute(c, id, reason)));
  s.tool("escrow_refund", "Buyer: propose refund with a fresh payout (arbiter co-signs after deadline)", { id: z.string(), ...payout }, ({ id, ...a }) => wrap(() => uc.refund(c, id, a)));
  s.tool("escrow_refund_payout", "Refund a failed Lightning payout swap to an Ark address", { id: z.string(), to: z.string().optional() }, ({ id, to }) => wrap(() => uc.refundPayout(c, id, to)));
  await s.connect(new StdioServerTransport());
}
