/**
 * Core use-cases. CLI and MCP are thin adapters over these functions.
 * All validation, caps and safety checks live here.
 */
import fs from "node:fs";
import { signEscrowArkTx, signEscrowCheckpoints } from "@satora/swap";
import { MarkError } from "../errors.js";
import { NETWORKS, dataDir, ensureDir, defaultConfig, saveConfig, configPath, loadConfig, normalizeUrl, type NetworkName } from "../config.js";
import { createKeystore, openKeystore, resolvePassword, walletFile } from "../crypto/keystore.js";
import { escrowKey, signAuth } from "../crypto/keys.js";
import { paysTo } from "../crypto/psbt.js";
import { validatePayoutInvoice } from "../lightning/invoice.js";
import type { Escrow, Party, Payout, ProposalFull } from "../api/escrowApi.js";
import { assertEscrowCap } from "./limits.js";
import type { Ctx } from "./context.js";
import type { Role } from "./localIndex.js";

export type Kind = "release" | "refund";
export interface PayoutOpts { payoutInvoice?: string; payoutLnaddr?: string; payoutArk?: string }
export interface CreateOpts { role: Role; counterparty: string; sats: number; deadline: string | number; hash?: string; arbiterMode?: "auto" | "manual"; webhookUrl?: string }
export interface ApproveOpts extends PayoutOpts { kind?: Kind; with?: "counterparty" | "arbiter"; preimage?: string }

// ---------- shared validation ----------
const XONLY = /^[0-9a-f]{64}$/;
export function requireId(id?: string): string { if (!id) throw new MarkError("BAD_REQUEST", "escrow id required"); return id; }
export function requireRole(r?: string): Role { if (r !== "buyer" && r !== "seller") throw new MarkError("BAD_REQUEST", "role must be buyer or seller"); return r; }
export function requireKind(k?: string, fallback?: Kind): Kind { const v = k ?? fallback; if (v !== "release" && v !== "refund") throw new MarkError("BAD_REQUEST", "kind/path must be release or refund"); return v; }
function requireXonly(pk: string): string { const h = pk.toLowerCase().replace(/^0[23](?=[0-9a-f]{64}$)/, ""); if (!XONLY.test(h)) throw new MarkError("BAD_PUBKEY", "pubkey must be 32-byte x-only hex"); return h; }
function parseDeadline(d: string | number): number | string {
  if (typeof d === "number" || /^\d+$/.test(String(d))) { const n = Number(d); if (n <= 0) throw new MarkError("BAD_DEADLINE", "deadline must be in the future"); return n; }
  if (isNaN(Date.parse(String(d))) || Date.parse(String(d)) <= Date.now()) throw new MarkError("BAD_DEADLINE", "deadline must be seconds from now or a future ISO time");
  return String(d);
}
const held = (e: Escrow) => e.funding?.amount ?? e.amountSats;
export const payeeOf = (kind: Kind): Role => (kind === "release" ? "seller" : "buyer");
function myRole(c: Ctx, e: Escrow): Role {
  if (e.buyerPubkey === c.pubkey) return "buyer"; if (e.sellerPubkey === c.pubkey) return "seller";
  throw new MarkError("NOT_A_PARTY", "this wallet's pubkey is not a party to the escrow");
}

// ---------- keys ----------
export async function init(network: NetworkName, o: { escrowUrl?: string } = {}) {
  const dir = dataDir(network); ensureDir(dir);
  const fresh = !fs.existsSync(walletFile(dir));
  if (!fs.existsSync(configPath(network))) saveConfig(defaultConfig(network));
  const ks = fresh ? createKeystore(dir, resolvePassword(dir, true)) : openKeystore(dir, resolvePassword(dir, false));
  if (o.escrowUrl) { const raw = JSON.parse(fs.readFileSync(configPath(network), "utf8")); saveConfig({ ...raw, escrowUrl: normalizeUrl(o.escrowUrl) }); } // persist only the flag, never env
  const cfg = loadConfig(network);
  return { ok: true, created: fresh, network, dataDir: dir, pubkey: (await escrowKey(ks.mnemonic, NETWORKS[network].isMainnet)).xonly,
    escrowUrl: cfg.escrowUrl ?? null, limits: cfg.limits, note: fresh ? "Backup phrase: run `mark backup` in an interactive terminal." : "already initialized" };
}
export const pubkey = (c: Ctx) => ({ network: c.network, pubkey: c.pubkey });

/** Returns the phrase ONLY for an interactive TTY caller; agents/JSON get NOT_A_TTY. */
export function revealBackupPhrase(network: NetworkName, interactive: boolean): string {
  if (!interactive) throw new MarkError("NOT_A_TTY", "backup phrase is only shown on an interactive terminal");
  const dir = dataDir(network);
  return openKeystore(dir, resolvePassword(dir, false)).mnemonic;
}

// ---------- escrow ----------
export async function create(c: Ctx, o: CreateOpts) {
  assertEscrowCap(c.cfg, o.sats);
  const role = requireRole(o.role); const other = requireXonly(o.counterparty);
  if (other === c.pubkey) throw new MarkError("BAD_PUBKEY", "counterparty must differ from this wallet");
  const e = await c.api.create({
    amountSats: o.sats, deadline: parseDeadline(o.deadline), arbiterMode: o.arbiterMode, webhookUrl: o.webhookUrl,
    buyerPubkey: role === "buyer" ? c.pubkey : other, sellerPubkey: role === "seller" ? c.pubkey : other,
    rule: o.hash ? { type: "hash", sha256: requireXonly(o.hash) } : { type: "manual" },
  });
  c.index.set(e.id, { role });
  return e;
}

export async function quote(c: Ctx, id: string, path: Kind = "release") { return c.api.quote(requireId(id), requireKind(path)); }

export async function status(c: Ctx, id: string) {
  const e = await c.api.get(requireId(id)); const l = c.index.get(id);
  const r: any = { ...e, myRole: myRole(c, e) };
  if (l.fundSwap || l.payoutSwap) {
    const s = await c.swaps();
    const look = (sid: string) => s.get(sid).catch((x: any) => ({ id: sid, error: x.message }));
    if (l.fundSwap) r.fundSwap = await look(l.fundSwap);
    if (l.payoutSwap) r.payoutSwap = await look(l.payoutSwap);
  }
  return r;
}

/** Fund via Lightning: Satora LN->Arkade swap targeting the escrow address; THIS Mark holds the claim key and claims into the escrow. */
export async function fund(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; onInvoice?: (x: unknown) => void } = {}) {
  const e = await c.api.get(requireId(id));
  assertEscrowCap(c.cfg, e.amountSats);
  if (e.state !== "created") return { escrowId: id, state: e.state, note: "already funded" };
  const s = await c.swaps(); const l = c.index.get(id);
  let swapId = l.fundSwap, invoice: string | undefined;
  if (!swapId) { const r = await s.createReceive(e.amountSats, e.address); swapId = r.id; invoice = r.invoice; c.index.set(id, { fundSwap: swapId, role: l.role ?? myRole(c, e) }); }
  const base = { escrowId: id, escrowAddress: e.address, amountSats: e.amountSats, swapId, invoice };
  if (!o.wait) return { ...base, note: `pay the invoice, then run: mark escrow fund ${id} --wait (claims into the escrow)` };
  if (invoice) o.onInvoice?.(base);
  const end = Date.now() + (o.timeoutSec ?? 900) * 1000;
  while (Date.now() < end) {
    const i = await s.get(swapId!);
    if (i.status === "serverfunded") return { ...base, claim: await s.claim(swapId!, e.address), escrow: await c.api.get(id) };
    if (i.status === "clientredeemed" || i.status === "serverredeemed") return { ...base, swapStatus: i.status, escrow: await c.api.get(id) };
    if (i.status === "expired" || i.status === "clientrefunded") return { ...base, swapStatus: i.status, note: "swap expired" };
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ...base, note: "timeout waiting for payment" };
}

/** Refuse to sign anything that does not pay the proposal's stated destination the escrowed amount. */
async function signProposal(c: Ctx, e: Escrow, p: ProposalFull, role: Role) {
  if (!p.signers.includes(role)) throw new MarkError("BAD_SIGNERS", "I am not a signer of this proposal");
  if (!paysTo(p.arkTx, p.dest, held(e))) throw new MarkError("UNSAFE_TX", "proposal tx does not pay its stated destination the escrow amount; refusing to sign");
  return c.api.sign(e.id, p.id, { party: role, arkTx: signEscrowArkTx(p.arkTx, c.secret).signedPsbt, checkpoints: signEscrowCheckpoints(p.checkpoints, c.secret) });
}

/** Payout chosen at signing time. Lightning: THIS Mark creates the Satora Arkade->Lightning swap (holds its refund key). */
async function payoutSpec(c: Ctx, e: Escrow, kind: Kind, o: PayoutOpts): Promise<{ payout: Payout; authDest: string; swap?: { id: string; fundAddress: string; fundAmountSats: number } }> {
  const given = [o.payoutInvoice, o.payoutLnaddr, o.payoutArk].filter(Boolean).length;
  if (given !== 1) throw new MarkError("BAD_REQUEST", "exactly one payout required: --payout-invoice <bolt11> | --payout-lnaddr <user@domain> | --payout-ark <ark address>");
  if (o.payoutArk) { if (!/^t?ark1/.test(o.payoutArk)) throw new MarkError("BAD_DEST", "payout-ark must be an Ark address"); return { payout: { type: "ark", address: o.payoutArk }, authDest: o.payoutArk }; }
  const amount = held(e);
  if (o.payoutInvoice) {
    const q = await c.api.quote(e.id, kind);
    validatePayoutInvoice(o.payoutInvoice, q.lightning.invoiceSats, c.network); // fail fast before creating a swap
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.payoutLnaddr!)) throw new MarkError("BAD_DEST", "payout-lnaddr must be a lightning address");
  const s = await c.swaps();
  const sw = o.payoutInvoice ? await s.createPay(o.payoutInvoice) : await s.createPay(o.payoutLnaddr!, amount, { exactSource: true });
  if (sw.fundAmountSats !== amount) throw new MarkError("AMOUNT_MISMATCH", `swap needs ${sw.fundAmountSats} sats but escrow holds ${amount}; re-run quote`, { swapSourceSats: sw.fundAmountSats, escrowSats: amount });
  c.index.set(e.id, { payoutSwap: sw.id });
  const payout: Payout = o.payoutInvoice ? { type: "invoice", invoice: o.payoutInvoice, swapId: sw.id } : { type: "lnaddr", address: o.payoutLnaddr!, swapId: sw.id };
  return { payout, authDest: `swap:${sw.id}`, swap: sw };
}

/**
 * approve: with no payout given, sign the pending proposal that needs my signature.
 * With a payout, as payee for `kind` (seller->release, buyer->refund): propose, then sign.
 */
export async function approve(c: Ctx, id: string, o: ApproveOpts = {}) {
  const e = await c.api.get(requireId(id)); const role = myRole(c, e);
  const hasPayout = !!(o.payoutInvoice || o.payoutLnaddr || o.payoutArk);
  if (!hasPayout) {
    const pending = e.proposals.filter((p) => !p.submittedTxid && p.signers.includes(role) && !p.sigs.includes(role) && (!o.kind || p.kind === o.kind));
    if (pending.length) return signProposal(c, e, await c.api.proposal(id, pending[pending.length - 1].id), role);
  }
  const kind = requireKind(o.kind, role === "seller" ? "release" : "refund");
  if (role !== payeeOf(kind)) throw new MarkError("NOTHING_TO_SIGN", `no pending ${kind} proposal for me to sign; the ${payeeOf(kind)} must propose it with a payout`);
  if (!["funded", "disputed", "releasing", "refunding"].includes(e.state)) throw new MarkError("BAD_STATE", `escrow is ${e.state}`);
  const spec = await payoutSpec(c, e, kind, o);
  const signers: Party[] = o.with === "arbiter" ? [role, "arbiter"] : ["buyer", "seller"];
  const auth = { party: role, ...signAuth(c.secret, id, `propose:${kind}:${spec.authDest}`) };
  const r = await c.api.propose(id, { kind, payout: spec.payout, signers, preimage: o.preimage, auth });
  const signed = await signProposal(c, r.escrow, await c.api.proposal(id, r.proposal.id), role);
  return { ...signed, payoutSwap: spec.swap ? { id: spec.swap.id, vhtlc: spec.swap.fundAddress, sourceSats: spec.swap.fundAmountSats } : undefined };
}

export async function dispute(c: Ctx, id: string, reason?: string) {
  const e = await c.api.get(requireId(id)); const role = myRole(c, e);
  return c.api.dispute(id, { reason, auth: { party: role, ...signAuth(c.secret, id, "dispute") } });
}

/** Buyer refund; default co-signer is the arbiter (auto-signs after the deadline). */
export const refund = (c: Ctx, id: string, o: PayoutOpts & { with?: "counterparty" | "arbiter" } = {}) => approve(c, id, { ...o, kind: "refund", with: o.with ?? "arbiter" });

/** Refund a failed Lightning payout swap (Satora Arkade VHTLC) to an Ark address. */
export async function refundPayout(c: Ctx, id: string, to?: string) {
  const l = c.index.get(requireId(id)); if (!l.payoutSwap) throw new MarkError("NOT_FOUND", "no payout swap recorded for this escrow");
  const dest = to ?? c.cfg.refundArkAddress; if (!dest || !/^t?ark1/.test(dest)) throw new MarkError("BAD_DEST", "--to <ark address> (or config refundArkAddress) required");
  return (await c.swaps()).refund(l.payoutSwap, dest);
}
