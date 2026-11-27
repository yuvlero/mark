/** `mark offer create|show|take|cancel` and MCP offer_*: shareable one-deal links on the escrow server. */
import crypto from "node:crypto";
import { MarkError } from "../errors.js";
import type { Ctx } from "./context.js";
import { signHash } from "../crypto/keys.js";
import { requireRole } from "./usecases.js";
import { serverLimits, verifyDeal } from "./dealCheck.js";
import { normalizeTerms, termsHash, dealTermsDocument, webhookUrlHash, verifyTermsSig, type Terms } from "./terms.js";
import { mk } from "../invocation.js";
import {
  offerHash, takeHash, cancelHash, parseOfferCode,
  OFFER_DEFAULT_DEADLINE_SEC, OFFER_DEFAULT_EXPIRES_SEC, OFFER_MIN_DEADLINE_SEC, OFFER_MIN_EXPIRES_SEC, OFFER_MAX_EXPIRES_SEC,
  type OfferRole,
} from "./offerDocs.js";

const nonce = () => crypto.randomBytes(16).toString("hex");
const tsNow = () => Math.floor(Date.now() / 1000);

/** Seconds from now: a positive integer, or a shorthand like 30s, 5m, 24h, 7d. */
export function parseDuration(d: string | number, label: string): number {
  if (typeof d === "number" || /^\d+$/.test(String(d))) {
    const n = Number(d);
    if (!Number.isInteger(n) || n <= 0) throw new MarkError("BAD_DEADLINE", `${label} must be a positive number of seconds (or 30s, 5m, 24h, 7d)`);
    return n;
  }
  const m = /^(\d+)(s|m|h|d)$/i.exec(String(d).trim());
  if (!m) throw new MarkError("BAD_DEADLINE", `${label} must be seconds or a shorthand like 30s, 5m, 24h, 7d`);
  const n = Number(m[1]); const mul = { s: 1, m: 60, h: 3600, d: 86_400 }[m[2]!.toLowerCase()]!;
  const v = n * mul;
  if (!Number.isInteger(v) || v <= 0) throw new MarkError("BAD_DEADLINE", `${label} must be a positive duration`);
  return v;
}

export const parseOfferRef = (input: string) => parseOfferCode(input);

export interface OfferCreateOpts {
  role: string; amount: number; terms?: string | { title?: string; description?: string; deliverable?: string; acceptance?: string };
  title?: string; description?: string; expires?: string | number; deadline?: string | number;
}

function termsFrom(o: OfferCreateOpts): Terms {
  const t = typeof o.terms === "string" ? { description: o.terms } : (o.terms ?? {});
  const description = (o.description ?? t.description ?? "").trim();
  if (!description) throw new MarkError("BAD_TERMS", "terms are required: --terms \"...\" (or --description)");
  let title = (o.title ?? t.title ?? "").trim();
  if (!title) {
    const line = description.split(/\r?\n/).find((x) => x.trim()) || description;
    title = [...line].slice(0, 120).join("").replace(/\s+/g, " ").trim();
  }
  return normalizeTerms({ title, description, ...(t.deliverable ? { deliverable: t.deliverable } : {}), ...(t.acceptance ? { acceptance: t.acceptance } : {}) });
}

export async function offerCreate(c: Ctx, o: OfferCreateOpts) {
  const role = requireRole(o.role);
  const amount = Number(o.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new MarkError("BAD_AMOUNT", "amount must be a positive integer (sats)");
  const terms = termsFrom(o);
  const deadlineSeconds = o.deadline !== undefined ? parseDuration(o.deadline, "deadline") : OFFER_DEFAULT_DEADLINE_SEC;
  if (deadlineSeconds < OFFER_MIN_DEADLINE_SEC) throw new MarkError("BAD_DEADLINE", `deadline must be at least ${OFFER_MIN_DEADLINE_SEC} seconds`);
  const expiresIn = o.expires !== undefined ? parseDuration(o.expires, "expires") : OFFER_DEFAULT_EXPIRES_SEC;
  if (expiresIn < OFFER_MIN_EXPIRES_SEC || expiresIn > OFFER_MAX_EXPIRES_SEC) throw new MarkError("BAD_EXPIRY", `offer expiry must be between ${OFFER_MIN_EXPIRES_SEC} and ${OFFER_MAX_EXPIRES_SEC} seconds`);
  const lim = await serverLimits(c);
  if (lim && amount < lim.minDealSats.enforced) throw new MarkError("AMOUNT_TOO_SMALL", `amount ${amount} is below the server's minimum deal size ${lim.minDealSats.enforced} sats; see ${mk()} escrow limits`, { minDealSats: lim.minDealSats.enforced });
  const fees = lim?.fees.terms ?? null;
  const ts = tsNow(); const n = nonce(); const expiresAt = ts + expiresIn;
  const binding = { network: c.network, creatorPubkey: c.pubkey, creatorRole: role, amountSats: amount, terms, deadlineSeconds, expiresAt, fees, rule: { type: "manual" as const }, arbiterMode: "auto" as const, ts, nonce: n };
  const h = offerHash(binding);
  const r = await c.api.createOffer({ ...binding, offerHash: h, sig: signHash(c.secret, h) });
  if (r.offer?.offerHash && r.offer.offerHash !== h) throw new MarkError("OFFER_HASH_MISMATCH", `server recorded offerHash ${r.offer.offerHash} but I signed ${h}; do not share this link`);
  return { ...r, next: `share this link: ${r.url}. The first taker runs: ${mk()} offer take ${r.code} (or the full URL). A normal 2-of-3 escrow is created immediately (one link = one deal). Cancel with: ${mk()} offer cancel ${r.code}` };
}

export async function offerShow(c: Ctx, ref: string) {
  const code = parseOfferRef(ref);
  const offer = await c.api.getOffer(code);
  const h = offerHash({ network: c.network, creatorPubkey: offer.creatorPubkey, creatorRole: offer.creatorRole, amountSats: offer.amountSats, terms: offer.terms, deadlineSeconds: offer.deadlineSeconds, expiresAt: Math.floor(Date.parse(offer.expiresAt) / 1000), fees: offer.fees ?? null, rule: offer.rule ?? { type: "manual" }, arbiterMode: offer.arbiterMode ?? "auto", ts: offer.ts, nonce: offer.nonce });
  const sigOk = h === offer.offerHash && verifyTermsSig(offer.creatorPubkey, h, offer.sig);
  const mine = offer.creatorPubkey === c.pubkey;
  const next = offer.status === "open"
    ? (mine ? `this is your offer. Share ${offer.url}. Cancel with: ${mk()} offer cancel ${code}. A taker runs: ${mk()} offer take ${code}`
      : `to take this offer (you become the ${offer.takerRole}): ${mk()} offer take ${code}`)
    : offer.status === "taken" ? `already taken. Escrow id: ${offer.escrowId}. Next: ${mk()} escrow show ${offer.escrowId}`
    : `this offer is ${offer.status} and can no longer be taken`;
  return { ...offer, signatureValid: sigOk, mine, next };
}

export async function offerTake(c: Ctx, ref: string) {
  const code = parseOfferRef(ref);
  const offer = await c.api.getOffer(code);
  if (offer.status !== "open") throw new MarkError(offer.status === "taken" ? "OFFER_ALREADY_TAKEN" : offer.status === "expired" ? "OFFER_EXPIRED" : offer.status === "canceled" ? "OFFER_CANCELED" : "OFFER_NOT_OPEN",
    offer.status === "taken" ? `this offer was already taken (escrow ${offer.escrowId})` : `this offer is ${offer.status} and can no longer be taken`);
  if (offer.creatorPubkey === c.pubkey) throw new MarkError("SELF_TAKE", "you cannot take your own offer");
  const h = offerHash({ network: c.network, creatorPubkey: offer.creatorPubkey, creatorRole: offer.creatorRole, amountSats: offer.amountSats, terms: offer.terms, deadlineSeconds: offer.deadlineSeconds, expiresAt: Math.floor(Date.parse(offer.expiresAt) / 1000), fees: offer.fees ?? null, rule: offer.rule ?? { type: "manual" }, arbiterMode: offer.arbiterMode ?? "auto", ts: offer.ts, nonce: offer.nonce });
  if (h !== offer.offerHash || !verifyTermsSig(offer.creatorPubkey, h, offer.sig)) throw new MarkError("BAD_OFFER_SIGNATURE", "the offer signature does not verify; refusing to take it");
  const buyerPubkey = offer.creatorRole === "buyer" ? offer.creatorPubkey : c.pubkey;
  const sellerPubkey = offer.creatorRole === "seller" ? offer.creatorPubkey : c.pubkey;
  const takerRole: OfferRole = offer.creatorRole === "buyer" ? "seller" : "buyer";
  const deadline = new Date(Math.floor((Date.now() + offer.deadlineSeconds * 1000) / 1000) * 1000).toISOString();
  const tHash = termsHash(dealTermsDocument({ termsVersion: 2, network: c.network, amountSats: offer.amountSats, buyerPubkey, sellerPubkey, fees: offer.fees ?? null, terms: offer.terms, rule: offer.rule ?? { type: "manual" }, arbiterMode: offer.arbiterMode ?? "auto", deadline, webhookUrlSha256: webhookUrlHash(null) }));
  const ts = tsNow(); const n = nonce();
  const takeH = takeHash({ code, takerPubkey: c.pubkey, offerHash: offer.offerHash, ts, nonce: n });
  const r = await c.api.takeOffer(code, { takerPubkey: c.pubkey, offerHash: offer.offerHash, ts, nonce: n, sig: signHash(c.secret, takeH), deadline, termsHash: tHash, takerAcceptance: { party: takerRole, sig: signHash(c.secret, tHash), termsHash: tHash } });
  const e = r.escrow;
  if (!e?.id) throw new MarkError("ESCROW_BAD_RESPONSE", "offer was taken but the server returned no escrow");
  if (e.termsHash !== tHash) throw new MarkError("TERMS_HASH_MISMATCH", `server recorded termsHash ${e.termsHash} but I signed ${tHash}; do not fund escrow ${e.id}`);
  c.index.set(e.id, { role: takerRole, created: false, signedTermsHash: tHash });
  const check = await verifyDeal(c, e).then((x: object) => ({ ok: true as const, ...x }), (x: any) => ({ ok: false as const, code: x?.code ?? "ERROR", error: String(x?.message ?? x) }));
  const fundOrWait = !check.ok ? `offer taken (escrow ${e.id}) but the local deal check failed (${check.code}): do not fund until this is resolved` : takerRole === "buyer"
    ? `both sides are bound; fund with: ${mk()} escrow fund ${e.id} (or --ark / --from usdc)`
    : `both sides are bound; waiting for the buyer to fund. Show: ${mk()} escrow show ${e.id}`;
  return { ...r, myRole: takerRole, dealCheck: check, next: fundOrWait };
}

export async function offerCancel(c: Ctx, ref: string) {
  const code = parseOfferRef(ref);
  const offer = await c.api.getOffer(code);
  if (offer.creatorPubkey !== c.pubkey) throw new MarkError("FORBIDDEN", "only the creator can cancel this offer");
  const ts = tsNow(); const n = nonce();
  const h = cancelHash({ code, creatorPubkey: c.pubkey, ts, nonce: n });
  const r = await c.api.cancelOffer(code, { creatorPubkey: c.pubkey, ts, nonce: n, sig: signHash(c.secret, h) });
  return { ...r, next: "this offer is canceled and can no longer be taken" };
}

