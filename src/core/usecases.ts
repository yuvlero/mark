/**
 * Core use-cases. CLI and MCP are thin adapters over these functions.
 * All validation, caps and safety checks live here.
 */
import fs from "node:fs";
import { signEscrowArkTx, signEscrowCheckpoints } from "@satora/swap";
import { MarkError } from "../errors.js";
import { NETWORKS, dataDir, ensureDir, defaultConfig, saveConfig, configPath, loadConfig, normalizeUrl, type NetworkName } from "../config.js";
import { createKeystore, openKeystore, resolvePassword, walletFile } from "../crypto/keystore.js";
import { escrowKey, signAuth, signHash } from "../crypto/keys.js";
import { normalizeTerms, termsDocument, termsHash, verifyTermsSig, normalizeEvidence, evidenceHash, normalizeMessage, messageHash, type Terms } from "./terms.js";
import { arkScript, payoutOutputs } from "../crypto/psbt.js";
import { computeFees, expectedOutputs, outputsMatch, feeSchedule, feePreview, type FeeCalc } from "./fees.js";
import { validatePayoutInvoice, decodeInvoice, maxOverpaySats, isAmountless } from "../lightning/invoice.js";
import type { Escrow, Party, Payout, ProposalFull, Message, MessageList } from "../api/escrowApi.js";
import { assertEscrowCap } from "./limits.js";
import type { Ctx } from "./context.js";
import type { Role } from "./localIndex.js";

export type Kind = "release" | "refund";
export interface PayoutOpts { payoutInvoice?: string; payoutLnaddr?: string; payoutArk?: string }
export interface TermsInput { title?: string; description?: string; deliverable?: string; acceptance?: string; deliverableSha256?: string }
export interface CreateOpts { role: Role; counterparty: string; sats: number; deadline: string | number; hash?: string; arbiterMode?: "auto" | "manual"; webhookUrl?: string; terms?: TermsInput }
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
  const deadline = parseDeadline(o.deadline);
  // Terms are required for new deals: the arbiter rules disputes on what was agreed. The creator signs termsHash now.
  const terms = normalizeTerms(Object.fromEntries(Object.entries(o.terms ?? {}).filter(([, v]) => v !== undefined)));
  const buyerPubkey = role === "buyer" ? c.pubkey : other, sellerPubkey = role === "seller" ? c.pubkey : other;
  // Fee terms the server will stamp (and that I sign as part of termsHash). Old servers without /limits: no fees.
  const lim = await c.api.limits().catch((x: any) => { if (x.code === "NOT_FOUND") return null; throw x; });
  if (lim && o.sats < lim.minDealSats.enforced) throw new MarkError("AMOUNT_TOO_SMALL", `amount ${o.sats} is below the server's minimum deal size ${lim.minDealSats.enforced} sats (Lightning payout must meet Satora's minimum after fees); see mark escrow limits`, { minDealSats: lim.minDealSats.enforced });
  const fees = lim?.fees.terms ?? null;
  const h = termsHash(termsDocument(terms, { network: c.network, amountSats: o.sats, buyerPubkey, sellerPubkey, fees }));
  const e = await c.api.create({
    amountSats: o.sats, deadline, arbiterMode: o.arbiterMode, webhookUrl: o.webhookUrl, buyerPubkey, sellerPubkey,
    rule: o.hash ? { type: "hash", sha256: requireXonly(o.hash) } : { type: "manual" },
    terms, termsHash: h, creatorAcceptance: { party: role, sig: signHash(c.secret, h) },
  });
  if (e.termsHash !== h) throw new MarkError("TERMS_HASH_MISMATCH", `server recorded termsHash ${e.termsHash} but I signed ${h}; do not fund escrow ${e.id}`);
  if (JSON.stringify(e.fees ?? null) !== JSON.stringify(fees)) throw new MarkError("FEE_TERMS_MISMATCH", `server stamped different fee terms than it published; do not fund escrow ${e.id}`);
  c.index.set(e.id, { role });
  // upfront fee preview: server's (with live swap estimate) if present, else computed locally from the published terms
  const preview = (e as any).feePreview ?? (lim ? feePreview(fees, o.sats, { minDealSats: lim.minDealSats.enforced, maxDealSats: lim.maxDealSats, swapEstimateSats: null }) : null);
  return { ...e, feeTerms: fees, feeSummary: feeSummary(fees, o.sats), feePreview: preview, next: `share the escrow id with your counterparty; they must run: mark escrow show ${e.id} then mark escrow accept ${e.id}. Funding is blocked until both accepted.` };
}

/** Recompute termsHash locally from the deal and check every recorded acceptance signature (never trust the server's word). */
function verifyDealTerms(c: Ctx, e: Escrow) {
  if (!e.terms) return { terms: null, termsHash: null, legacy: true, hashVerified: null, accepted: null, agreed: true };
  const local = termsHash(termsDocument(normalizeTerms(e.terms), { network: c.network, amountSats: e.amountSats, buyerPubkey: e.buyerPubkey, sellerPubkey: e.sellerPubkey, fees: e.fees ?? null }));
  const ok = local === e.termsHash;
  const acc = (p: "buyer" | "seller") => { const a = e.acceptances?.[p]; return a ? { accepted: true, at: a.at, signatureValid: ok && verifyTermsSig(p === "buyer" ? e.buyerPubkey : e.sellerPubkey, local, a.sig) } : { accepted: false }; };
  const accepted = { buyer: acc("buyer"), seller: acc("seller") };
  return { terms: e.terms, termsHash: local, legacy: false, hashVerified: ok, accepted, agreed: ok && accepted.buyer.signatureValid === true && accepted.seller.signatureValid === true };
}

/** Human/agent-readable deal: what it is for, who accepted, evidence. Read-only. */
export async function show(c: Ctx, id: string) {
  const e = await c.api.get(requireId(id)); const role = myRole(c, e); const v = verifyDealTerms(c, e);
  const evidence = (e.evidence ?? []).map((x) => ({ ...x, signatureValid: verifyTermsSig(x.party === "buyer" ? e.buyerPubkey : e.sellerPubkey, evidenceHash(e.id, x.party, x.ts, { text: x.text, ...(x.sha256 ? { sha256: x.sha256 } : {}), ...(x.url ? { url: x.url } : {}) }), x.sig) }));
  const iAccepted = v.accepted ? (v.accepted as any)[role].accepted : null;
  return { id: e.id, state: e.state, myRole: role, amountSats: e.amountSats, deadline: e.deadline, ...v, feeTerms: e.fees ?? null, feeSummary: feeSummary(e.fees ?? null, e.amountSats), evidence,
    dispute: e.dispute ?? null, ruling: e.ruling ?? null,
    next: v.legacy ? "legacy deal (no terms)" : !v.hashVerified ? "TERMS HASH MISMATCH: do not accept or fund" : !iAccepted ? `review the terms, then: mark escrow accept ${e.id}` : !v.agreed ? "waiting for the counterparty to accept" : e.state === "created" ? (role === "buyer" ? `both accepted; fund with: mark escrow fund ${e.id}` : "both accepted; waiting for the buyer to fund") : undefined };
}

/** Accept the deal terms: verify termsHash locally, then BIP340-sign it with this wallet's escrow key. */
export async function accept(c: Ctx, id: string) {
  const e = await c.api.get(requireId(id)); const role = myRole(c, e);
  if (!e.terms) throw new MarkError("NO_TERMS", "legacy deal has no terms to accept");
  const v = verifyDealTerms(c, e);
  if (!v.hashVerified) throw new MarkError("TERMS_HASH_MISMATCH", "server termsHash does not match the terms shown; refusing to sign", { serverTermsHash: e.termsHash, localTermsHash: v.termsHash });
  const r = (v.accepted as any)[role].signatureValid ? e : await c.api.accept(id, { party: role, termsHash: v.termsHash!, sig: signHash(c.secret, v.termsHash!) });
  const after = verifyDealTerms(c, r);
  const missing = (["buyer", "seller"] as const).filter((p) => !(after.accepted as any)[p].accepted);
  return { escrowId: id, myRole: role, accepted: true, alreadyAccepted: r === e, state: r.state,
    status: !after.agreed ? `you accepted; waiting for the ${missing.join(" and ") || "counterparty"}` : r.state === "created" ? "both parties accepted the terms; not funded yet (state 'created' means waiting for the buyer's funding)" : `both accepted; escrow is ${r.state}`, terms: after.terms, termsHash: after.termsHash, acceptedBy: after.accepted, agreed: after.agreed,
    next: !after.agreed ? `waiting for the ${missing.join(" and ") || "counterparty"} to accept: mark escrow accept ${id}` : r.state === "created" ? (role === "buyer" ? `both accepted; fund with: mark escrow fund ${id}` : "both accepted; waiting for the buyer to fund") : undefined };
}

/** Add a signed, timestamped evidence note (either party, any state; especially during a dispute). */
export async function addEvidence(c: Ctx, id: string, o: { text?: string; sha256?: string; url?: string }) {
  if (!o.text || !String(o.text).trim()) throw new MarkError("BAD_EVIDENCE", "evidence text required: mark escrow evidence <id> --text \"...\" (alias --note) [--sha256 <hex>] [--url <https://...>]");
  const e = await c.api.get(requireId(id)); const role = myRole(c, e);
  const ev = normalizeEvidence(o); const ts = Math.floor(Date.now() / 1000);
  const r = await c.api.evidence(id, { party: role, ts, ...ev, sig: signHash(c.secret, evidenceHash(id, role, ts, ev)) });
  return { escrowId: id, myRole: role, added: { ts, ...ev }, evidenceCount: (r.evidence ?? []).length, state: r.state };
}

export async function quote(c: Ctx, id: string, path: Kind = "release", dest?: string) { return c.api.quote(requireId(id), requireKind(path), dest); }
/** Server limits: minimum deal sizes (Lightning / Ark payout), fee rates, free threshold, Satora min/max, Ark dust.
 *  With `sats`: an upfront fee preview for that deal size (platform fee, possible dispute fee, estimated swap cost, min/max). */
export async function limits(c: Ctx, sats?: number) {
  if (sats !== undefined) assertEscrowCap(c.cfg, sats);
  const l = await c.api.limits(sats);
  const t = l.fees.terms ?? null; const at = (a: number) => { const p = feePreview(t, a, { minDealSats: l.minDealSats.enforced, maxDealSats: l.maxDealSats }); return { amountSats: a, platformFeeSats: p.platformFeeSats, possibleDisputeFeeSats: p.possibleDisputeFeeSats }; };
  const preview = sats === undefined ? undefined : (l.feePreview ?? feePreview(t, sats, { minDealSats: l.minDealSats.enforced, maxDealSats: l.maxDealSats, swapEstimateSats: null }));
  return { ...l, feeSummary: { minDealSats: l.minDealSats.enforced, maxDealSats: l.maxDealSats, schedule: t ? feeSchedule(t) : null,
      examples: [3299, 3300, 33000, 100000, 1000000].filter((a) => a >= l.minDealSats.enforced && a <= l.maxDealSats).map(at),
      swapCost: "Lightning payouts also pay the Satora swap (protocol + routing fee, a few sats); pass --sats N for an estimate" },
    ...(preview ? { feePreview: preview } : {}) };
}

/** What the published fee terms mean for this amount (normal payout and a ruled dispute). */
function feeSummary(t: Escrow["fees"], amount: number) {
  if (!t) return { fees: "none (legacy / pre-fee deal)" };
  const n = computeFees(t, amount, amount, false), d = computeFees(t, amount, amount, true);
  return { termsVersion: t.v, schedule: feeSchedule(t), freeBelowSats: t.freeBelowSats, normalPayout: { feeOutputSats: n.feeOutputSats, payeeSats: n.payeeSats, reason: n.reason }, ifDisputeRuled: { feeOutputSats: d.feeOutputSats, payeeSats: d.payeeSats, reason: d.reason, note: "dispute fee is taken from the escrow before the winner's payout (economically paid by the loser)" } };
}
/** Expected fee for paying out this deal now, from the deal's PUBLISHED fee terms (never the server's word). */
export const dealFee = (e: Escrow): FeeCalc => computeFees(e.fees ?? null, e.amountSats, held(e), !!(e.dispute && e.ruling));
/** Exactly: payee leg to the proposal dest + fee output to the published fee address (if any). Nothing else. */
export function txMatchesFeeTerms(e: Escrow, arkTx: string, dest: string) {
  const fc = dealFee(e);
  try { return outputsMatch(payoutOutputs(arkTx), expectedOutputs(fc, arkScript(dest), fc.feeOutputSats > 0 ? arkScript(e.fees!.address) : null)); } catch { return false; }
}

/** Read-only: show the pending proposal(s) and their payout details, without signing. */
export async function pending(c: Ctx, id: string) {
  const e = await c.api.get(requireId(id)); const role = myRole(c, e);
  const open = e.proposals.filter((p) => !p.submittedTxid);
  const out = [];
  for (const s of open) { const p = await c.api.proposal(id, s.id); out.push({ ...payoutDetails(e, p), txMatchesFeeTerms: txMatchesFeeTerms(e, p.arkTx, p.dest), needsMySignature: p.signers.includes(role) && !p.sigs.includes(role) }); }
  return { escrowId: id, state: e.state, myRole: role, proposals: out };
}

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

/** Best-effort: tell the server which swap funded the escrow (for its fee ledger); never fails funding. */
async function reportFunding(c: Ctx, id: string, swapId: string) {
  let e = await c.api.get(id);
  for (let i = 0; i < 5 && e.state === "created"; i++) { await new Promise((r) => setTimeout(r, 2000)); e = await c.api.get(id); }
  if (e.state !== "created") await (c.api as any).reportFundingSwap?.(id, swapId)?.catch?.(() => {});
  return e;
}

/** Fund via Lightning: Satora LN->Arkade swap targeting the escrow address; THIS Mark holds the claim key and claims into the escrow. */
export async function fund(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; onInvoice?: (x: unknown) => void } = {}) {
  const e = await c.api.get(requireId(id));
  assertEscrowCap(c.cfg, e.amountSats);
  if (e.state !== "created") return { escrowId: id, state: e.state, note: "already funded" };
  const v = verifyDealTerms(c, e); // legacy deals (terms null) fund as before
  if (!v.agreed) throw new MarkError("TERMS_NOT_ACCEPTED", v.hashVerified === false ? "terms hash mismatch; refusing to fund" : `both parties must accept the terms before funding (buyer: ${(v.accepted as any).buyer.accepted}, seller: ${(v.accepted as any).seller.accepted}). Run: mark escrow accept ${id}`, { accepted: v.accepted });
  const s = await c.swaps(); const l = c.index.get(id);
  let swapId = l.fundSwap, invoice: string | undefined;
  if (!swapId) { const r = await s.createReceive(e.amountSats, e.address); swapId = r.id; invoice = r.invoice; c.index.set(id, { fundSwap: swapId, role: l.role ?? myRole(c, e) }); }
  const base = { escrowId: id, escrowAddress: e.address, amountSats: e.amountSats, swapId, invoice };
  if (!o.wait) return { ...base, note: `pay the invoice, then run: mark escrow fund ${id} --wait (claims into the escrow)` };
  if (invoice) o.onInvoice?.(base);
  const end = Date.now() + (o.timeoutSec ?? 900) * 1000;
  while (Date.now() < end) {
    const i = await s.get(swapId!);
    if (i.status === "serverfunded") { const claim = await s.claim(swapId!, e.address); return { ...base, claim, escrow: await reportFunding(c, id, swapId!) }; }
    if (i.status === "clientredeemed" || i.status === "serverredeemed") return { ...base, swapStatus: i.status, escrow: await reportFunding(c, id, swapId!) };
    if (i.status === "expired" || i.status === "clientrefunded") return { ...base, swapStatus: i.status, note: "swap expired" };
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ...base, note: "timeout waiting for payment" };
}

/** Human-checkable payout details of a proposal (shown by a co-signer before/with signing). */
function payoutDetails(e: Escrow, p: ProposalFull) {
  const po: any = p.payout ?? {};
  const fc = dealFee(e);
  const d: any = { proposalId: p.id, kind: p.kind, escrowSats: held(e), platformFee: { feeOutputSats: fc.feeOutputSats, platformFeeSats: fc.platformFeeSats, disputeFeeSats: fc.disputeFeeSats, dustBumpSats: fc.dustBumpSats, reason: fc.reason, address: fc.feeOutputSats ? e.fees!.address : null }, payeeLegSats: fc.payeeSats, type: po.type, txDest: p.dest, signers: p.signers, alreadySigned: p.sigs };
  if (po.type === "invoice" && po.invoice) { d.invoice = po.invoice; try { const x = decodeInvoice(po.invoice); d.invoiceSats = x.sats; d.paymentHash = x.paymentHash; d.invoiceExpiresAt = new Date(x.expiresAt * 1000).toISOString(); } catch { d.invoiceSats = undefined; } }
  if (po.type === "lnaddr") d.lightningAddress = po.address;
  if (po.type === "ark") d.arkAddress = po.address;
  if (po.swapId) d.swapId = po.swapId;
  if (po.sats !== undefined) d.payeeReceivesSats = po.sats;
  if (typeof d.invoiceSats === "number") d.feesAndOverpaySats = fc.payeeSats - d.invoiceSats;
  return d;
}

/** Refuse to sign anything that does not pay the proposal's stated destination the full escrowed amount. */
async function signProposal(c: Ctx, e: Escrow, p: ProposalFull, role: Role) {
  if (!p.signers.includes(role)) throw new MarkError("BAD_SIGNERS", "I am not a signer of this proposal");
  if (e.terms && verifyDealTerms(c, e).hashVerified === false) throw new MarkError("TERMS_HASH_MISMATCH", "deal terms/fee terms do not match the signed termsHash; refusing to sign");
  if (!txMatchesFeeTerms(e, p.arkTx, p.dest)) throw new MarkError("UNSAFE_TX", "proposal tx outputs are not exactly (payee = escrow - fee) + (fee to the published fee address) per the deal's fee terms; refusing to sign", { expectedFee: dealFee(e) });
  const payout = payoutDetails(e, p);
  if (payout.type === "invoice" && (typeof payout.invoiceSats !== "number" || payout.invoiceSats > dealFee(e).payeeSats)) throw new MarkError("UNSAFE_TX", "proposal payout invoice is undecodable or exceeds the escrow amount; refusing to sign");
  const r = await c.api.sign(e.id, p.id, { party: role, arkTx: signEscrowArkTx(p.arkTx, c.secret).signedPsbt, checkpoints: signEscrowCheckpoints(p.checkpoints, c.secret) });
  return { ...r, signedPayout: payout };
}

/** Payout chosen at signing time. Lightning: THIS Mark creates the Satora Arkade->Lightning swap (holds its refund key). */
async function payoutSpec(c: Ctx, e: Escrow, kind: Kind, o: PayoutOpts): Promise<{ payout: Payout; authDest: string; swap?: { id: string; fundAddress: string; fundAmountSats: number } }> {
  const given = [o.payoutInvoice, o.payoutLnaddr, o.payoutArk].filter(Boolean).length;
  if (given !== 1) throw new MarkError("BAD_REQUEST", "exactly one payout required: --payout-invoice <bolt11> | --payout-lnaddr <user@domain> | --payout-ark <ark address>");
  if (o.payoutArk) { if (!/^t?ark1/.test(o.payoutArk)) throw new MarkError("BAD_DEST", "payout-ark must be an Ark address"); return { payout: { type: "ark", address: o.payoutArk }, authDest: o.payoutArk }; }
  const amount = dealFee(e).payeeSats; // payee leg: escrow minus the platform fee output
  if (o.payoutInvoice) {
    const q = await c.api.quote(e.id, kind, o.payoutInvoice); // route-specific: same pricing as swap creation
    if (isAmountless(o.payoutInvoice)) throw new MarkError("AMOUNTLESS_INVOICE_UNSUPPORTED", `amountless invoices cannot be paid (Satora requires the amount). Create the invoice for ${q.amountlessInvoice?.setInvoiceAmountSats ?? q.lightning.recommendedInvoiceSats} sats (estimate with safety margin), or run: mark escrow quote ${e.id} --dest <your lightning address> for the exact value`, { setInvoiceAmountSats: q.amountlessInvoice?.setInvoiceAmountSats ?? q.lightning.recommendedInvoiceSats, quoteType: q.quoteType ?? "estimate" });
    validatePayoutInvoice(o.payoutInvoice, q.lightning.invoiceSats, c.network); // fail fast before creating a swap
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.payoutLnaddr!)) throw new MarkError("BAD_DEST", "payout-lnaddr must be a lightning address");
  const s = await c.swaps();
  const sw = o.payoutInvoice ? await s.createPay(o.payoutInvoice) : await s.createPay(o.payoutLnaddr!, amount, { exactSource: true });
  // Escrow tx pays the full amount to the VHTLC; an invoice swap sourced slightly below it is over-funded (excess = provider overpay).
  const cap = o.payoutInvoice ? maxOverpaySats(amount) : 0;
  if (!(sw.fundAmountSats <= amount && amount - sw.fundAmountSats <= cap)) throw new MarkError("AMOUNT_MISMATCH", `swap needs ${sw.fundAmountSats} sats but the payee leg (escrow minus platform fee) is ${amount} (allowed overpay ${cap}); re-run quote. Unfunded swap ${sw.id} can be ignored.`, { swapSourceSats: sw.fundAmountSats, escrowSats: amount, maxOverpaySats: cap });
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
    const open = e.proposals.filter((p) => !p.submittedTxid && (!o.kind || p.kind === o.kind));
    const why = open.length ? `open proposal(s) ${open.map((p) => `${p.kind}:${p.id} signed by [${p.sigs.join(",")}]`).join("; ")} need nothing from me (${role})` : "there is no pending proposal yet";
    throw new MarkError("NOTHING_TO_SIGN", `nothing to sign: ${why}. A co-signer needs no payout. To PROPOSE as payee (seller->release, buyer->refund), pass exactly one of --payout-invoice | --payout-lnaddr | --payout-ark.`, { state: e.state, role });
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

// ---------- per-deal message threads (support channel with the operator) ----------
/** Verify each message: id must equal messageHash(...) and the signature must verify against the author's key
 *  (operator + system messages: the deal's arbiter pubkey, i.e. the operator's key for this escrow). */
export function verifyMessage(l: Pick<MessageList, "escrowId" | "arbiterPubkey" | "buyerPubkey" | "sellerPubkey">, m: Message) {
  const pk = m.author === "operator" ? l.arbiterPubkey : m.author === "buyer" ? l.buyerPubkey : m.author === "seller" ? l.sellerPubkey : null;
  if (!pk || m.pubkey !== pk) return false;
  try { const h = messageHash(l.escrowId, m.author, m.ts, { body: m.body, ...(m.kind ? { kind: m.kind as any } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}) }); return h === m.id && verifyTermsSig(pk, h, m.sig); } catch { return false; }
}
async function fetchThread(c: Ctx, id: string, since?: number) {
  const e = await c.api.get(requireId(id)); const role = myRole(c, e);
  const l = await c.api.messages(id, { party: role, ...signAuth(c.secret, id, "messages") }, since);
  // pin keys to the escrow record (not the thread response)
  const keys = { escrowId: id, arbiterPubkey: e.arbiterPubkey, buyerPubkey: e.buyerPubkey, sellerPubkey: e.sellerPubkey };
  return { e, role, l, msgs: l.messages.map((m: any) => ({ ...m, from: m.author === "operator" ? (m.kind === "system" || m.extra?.event ? "system" : "operator") : m.author, mine: m.author === role, verified: verifyMessage(keys, m), ...(m.flag ? { duplicate: m.flag.flag === "duplicate" } : {}) })) };
}
/** Read a deal's thread (since = cursor). Marks it read. Unverified messages are flagged, never trusted. */
export async function messages(c: Ctx, id: string, since?: number) {
  const { e, role, l, msgs } = await fetchThread(c, id, since);
  if (l.cursor > (c.index.get(id).msgSeen ?? 0)) c.index.set(id, { msgSeen: l.cursor, role: c.index.get(id).role ?? role });
  const bad = msgs.filter((m) => !m.verified).length;
  return { escrowId: id, state: e.state, myRole: role, cursor: l.cursor, messages: msgs, ...(bad ? { warning: `${bad} message(s) failed signature verification: ignore them` } : {}),
    next: `reply: mark escrow message ${id} --text "..." [--kind question|dispute|evidence|info] [--reply-to <messageId>]; poll: mark escrow messages ${id} --since ${l.cursor}` };
}
/** Post a signed message (kind: question|dispute|evidence|info). */
export async function postMessage(c: Ctx, id: string, o: { text?: string; kind?: string; replyTo?: string }) {
  const m = normalizeMessage({ body: o.text, kind: o.kind, replyTo: o.replyTo });
  if (m.kind === "system") throw new MarkError("BAD_MESSAGE", "kind system is reserved for the server");
  const e = await c.api.get(requireId(id)); const role = myRole(c, e); const ts = Math.floor(Date.now() / 1000);
  const r = await c.api.postMessage(id, { author: role, ts, ...m, sig: signHash(c.secret, messageHash(id, role, ts, m)) });
  return { escrowId: id, myRole: role, posted: { id: r.id, seq: r.seq, kind: r.kind ?? null, replyTo: r.replyTo ?? null, createdAt: r.createdAt },
    note: m.kind === "dispute" ? `a dispute MESSAGE does not open a dispute; to stop auto-arbitration run: mark escrow dispute ${id} --reason "..."` : "the operator replies in this thread; poll with mark escrow inbox (or use a webhook: message.created)" };
}
/** Unread messages (not mine, after my last-seen cursor) across this identity's deals (local index). Does not mark read. */
export async function inbox(c: Ctx) {
  const out: any[] = []; const errors: any[] = [];
  for (const id of c.index.ids()) {
    try { const seen = c.index.get(id).msgSeen ?? 0; const { e, msgs } = await fetchThread(c, id, seen); const unread = msgs.filter((m) => !m.mine && !m.flag);
      if (unread.length) out.push({ escrowId: id, state: e.state, unread: unread.length, fromOperator: unread.filter((m) => m.from === "operator").length,
        latest: unread.slice(-3).map((m) => ({ id: m.id, author: m.author, from: m.from, kind: m.kind ?? null, at: m.createdAt, verified: m.verified, preview: m.body.slice(0, 200) })) }); }
    catch (x: any) { errors.push({ escrowId: id, code: x.code ?? "ERROR", error: String(x.message).slice(0, 200) }); }
  }
  return { unreadDeals: out.length, unreadMessages: out.reduce((a, x) => a + x.unread, 0), deals: out, ...(errors.length ? { errors } : {}), next: out.length ? "read one with: mark escrow messages <id>" : "no unread messages" };
}
