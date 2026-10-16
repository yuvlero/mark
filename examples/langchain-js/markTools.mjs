// LangChain.js tools over the Mark CLI (JSON in, JSON out). npm i @langchain/core zod
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "node:child_process";

const BIN = (process.env.MARK_BIN || "npx -y @yuvlero/mark").split(" ");
/** Run `mark <args>`; resolves with the parsed JSON (errors come back as {error, code, details}). */
export function mark(args) {
  return new Promise((resolve) => execFile(BIN[0], [...BIN.slice(1), ...args], { maxBuffer: 4 << 20, timeout: 120_000 }, (_e, stdout) => {
    try { resolve(JSON.parse(stdout)); } catch { resolve({ error: String(stdout || _e?.message).slice(0, 500), code: "NOT_JSON" }); }
  }));
}
const out = async (args) => JSON.stringify(await mark(args));

export const escrowShow = tool(({ id }) => out(["escrow", "show", id]),
  { name: "escrow_show", description: "Deal terms, acceptances, evidence, awaiting and action_required_for", schema: z.object({ id: z.string() }) });
export const escrowInvites = tool(({ all }) => out(["escrow", "invites", ...(all ? ["--all"] : [])]),
  { name: "escrow_invites", description: "Deals waiting for my accept (all=true: every deal I am in)", schema: z.object({ all: z.boolean().optional() }) });
export const escrowAccept = tool(({ id }) => out(["escrow", "accept", id]),
  { name: "escrow_accept", description: "Verify and sign the deal terms", schema: z.object({ id: z.string() }) });
export const escrowEvidence = tool(({ id, file, text }) => out(["escrow", "evidence", id, ...(file ? ["--file", file] : []), ...(text ? ["--text", text] : [])]),
  { name: "escrow_evidence", description: "Seller: post the deliverable sha256 (file hashed locally) after delivering off-band", schema: z.object({ id: z.string(), file: z.string().optional(), text: z.string().optional() }) });
export const escrowApprove = tool(({ id, payoutLnaddr }) => out(["escrow", "approve", id, ...(payoutLnaddr ? ["--payout-lnaddr", payoutLnaddr] : [])]),
  { name: "escrow_approve", description: "Seller: propose payout to a Lightning address. Buyer: co-sign (no payout)", schema: z.object({ id: z.string(), payoutLnaddr: z.string().optional() }) });

export const markTools = [escrowInvites, escrowShow, escrowAccept, escrowEvidence, escrowApprove];
