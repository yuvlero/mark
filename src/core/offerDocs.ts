/** Open-offer deal links (v1): canonical signed documents, code alphabet, and public JSON shape.
 *  Shared with its counterpart in the other repo (Mark / escrow server), identical apart from the error class; a server-side parity test enforces it.
 *  v1 is auto-bind + single taker: one link = one deal; the first valid taker atomically creates a normal 2-of-3 escrow. */
import crypto from "node:crypto";
import { MarkError } from "../errors.js";
import { canonicalRule, canonicalJson, termsHash, verifyTermsSig, normalizeTerms, type Terms, type RuleDoc } from "./terms.js";

export const OFFER_V = "mark-escrow-offer/1";
export const OFFER_TAKE_V = "mark-escrow-offer-take/1";
export const OFFER_CANCEL_V = "mark-escrow-offer-cancel/1";
/** Sliding window for the ts on create / take / cancel signatures (same idea as action auth). */
export const OFFER_AUTH_WINDOW_SEC = 600;
/** Allowed clock skew between the taker's proposed absolute deadline and now + deadlineSeconds. */
export const OFFER_DEADLINE_SKEW_SEC = 120;

/** Crockford base32 without I, L, O, U (lowercase): 10 chars ≈ 50 bits, short in /o/<code>, not trivial to enumerate. */
export const OFFER_CODE_LEN = 10;
export const OFFER_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const OFFER_CODE_RE = new RegExp(`^[${OFFER_CODE_ALPHABET}]{${OFFER_CODE_LEN}}$`);

export const OFFER_DEFAULT_EXPIRES_SEC = 7 * 86_400;
export const OFFER_MIN_EXPIRES_SEC = 3_600;
export const OFFER_MAX_EXPIRES_SEC = 30 * 86_400;
export const OFFER_DEFAULT_DEADLINE_SEC = 7 * 86_400;
export const OFFER_MIN_DEADLINE_SEC = 300;

export type OfferRole = "buyer" | "seller";
export type OfferStatus = "open" | "taken" | "canceled" | "expired";

export interface OfferBinding {
  network: string;
  creatorPubkey: string;
  creatorRole: OfferRole;
  amountSats: number;
  terms: Terms;
  deadlineSeconds: number;
  /** Offer-link expiry as whole unix seconds (what the creator signs). */
  expiresAt: number;
  fees: object | null;
  rule: unknown;
  arbiterMode: "auto" | "manual";
  ts: number;
  nonce: string;
}

/** Canonical document the creator signs at POST /offers (no offer code: the server assigns it). */
export function offerDocument(o: OfferBinding) {
  if (o.creatorRole !== "buyer" && o.creatorRole !== "seller") throw new MarkError("BAD_OFFER", "creatorRole must be buyer or seller");
  if (o.arbiterMode !== "auto" && o.arbiterMode !== "manual") throw new MarkError("BAD_REQUEST", "arbiterMode must be auto or manual");
  if (!Number.isInteger(o.amountSats) || o.amountSats <= 0) throw new MarkError("BAD_AMOUNT", "amountSats must be a positive integer");
  if (!Number.isInteger(o.deadlineSeconds) || o.deadlineSeconds < OFFER_MIN_DEADLINE_SEC) throw new MarkError("BAD_DEADLINE", `deadlineSeconds must be at least ${OFFER_MIN_DEADLINE_SEC}`);
  if (!Number.isInteger(o.expiresAt) || o.expiresAt <= 0) throw new MarkError("BAD_EXPIRY", "expiresAt must be whole unix seconds");
  if (!Number.isInteger(o.ts) || o.ts <= 0) throw new MarkError("BAD_OFFER_SIGNATURE", "ts must be whole unix seconds");
  if (!/^[0-9a-f]{16,64}$/.test(o.nonce)) throw new MarkError("BAD_OFFER_SIGNATURE", "nonce must be 16-64 hex characters");
  return { v: OFFER_V, network: o.network, creatorPubkey: o.creatorPubkey, creatorRole: o.creatorRole, amountSats: o.amountSats,
    terms: normalizeTerms(o.terms), deadlineSeconds: o.deadlineSeconds, expiresAt: o.expiresAt, fees: o.fees ?? null,
    rule: canonicalRule(o.rule ?? { type: "manual" }), arbiterMode: o.arbiterMode, ts: o.ts, nonce: o.nonce.toLowerCase() };
}
export const offerHash = (o: OfferBinding) => termsHash(offerDocument(o));

export interface TakeBinding { code: string; takerPubkey: string; offerHash: string; ts: number; nonce: string }
export function takeDocument(o: TakeBinding) {
  if (!OFFER_CODE_RE.test(o.code)) throw new MarkError("BAD_OFFER_CODE", "offer code is not a valid /o/<code> id");
  if (!/^[0-9a-f]{64}$/.test(o.takerPubkey) || !/^[0-9a-f]{64}$/.test(o.offerHash)) throw new MarkError("BAD_PUBKEY", "takerPubkey and offerHash must be 32-byte hex");
  if (!Number.isInteger(o.ts) || o.ts <= 0) throw new MarkError("BAD_OFFER_SIGNATURE", "ts must be whole unix seconds");
  if (!/^[0-9a-f]{16,64}$/.test(o.nonce)) throw new MarkError("BAD_OFFER_SIGNATURE", "nonce must be 16-64 hex characters");
  return { v: OFFER_TAKE_V, code: o.code, takerPubkey: o.takerPubkey, offerHash: o.offerHash, ts: o.ts, nonce: o.nonce.toLowerCase() };
}
export const takeHash = (o: TakeBinding) => termsHash(takeDocument(o));

export interface CancelBinding { code: string; creatorPubkey: string; ts: number; nonce: string }
export function cancelDocument(o: CancelBinding) {
  if (!OFFER_CODE_RE.test(o.code)) throw new MarkError("BAD_OFFER_CODE", "offer code is not a valid /o/<code> id");
  if (!/^[0-9a-f]{64}$/.test(o.creatorPubkey)) throw new MarkError("BAD_PUBKEY", "creatorPubkey must be 32-byte hex");
  if (!Number.isInteger(o.ts) || o.ts <= 0) throw new MarkError("BAD_OFFER_SIGNATURE", "ts must be whole unix seconds");
  if (!/^[0-9a-f]{16,64}$/.test(o.nonce)) throw new MarkError("BAD_OFFER_SIGNATURE", "nonce must be 16-64 hex characters");
  return { v: OFFER_CANCEL_V, code: o.code, creatorPubkey: o.creatorPubkey, ts: o.ts, nonce: o.nonce.toLowerCase() };
}
export const cancelHash = (o: CancelBinding) => termsHash(cancelDocument(o));

export function offerSigOk(xonly: string, hashHex: string, sig: string) { return verifyTermsSig(xonly, hashHex, sig); }

/** Fresh 10-character offer code (rejection sampling so every alphabet character is equally likely). */
export function randomOfferCode(): string {
  const a = OFFER_CODE_ALPHABET, n = a.length, out: string[] = [];
  while (out.length < OFFER_CODE_LEN) {
    const buf = crypto.randomBytes(16);
    for (const x of buf) { if (x < 256 - (256 % n)) out.push(a[x % n]!); if (out.length === OFFER_CODE_LEN) break; }
  }
  return out.join("");
}

/** Bare 10-char code, or a URL / path ending in /o/<code> (query and hash ignored). */
export function parseOfferCode(input: string): string {
  const t = String(input || "").trim();
  const m = /(?:^|\/)o\/([0-9a-hj-km-np-tv-z]{10})(?:\.md)?(?:[/?#]|$)/i.exec(t);
  const code = (m ? m[1] : t).toLowerCase();
  if (!OFFER_CODE_RE.test(code)) throw new MarkError("BAD_OFFER_CODE", "expected a 10-character offer code or an https://agentescrow.to/o/<code> link");
  return code;
}

export function offerAuthFresh(ts: number, nowSec = Math.floor(Date.now() / 1000)) {
  return Number.isInteger(ts) && Math.abs(nowSec - ts) <= OFFER_AUTH_WINDOW_SEC;
}

export interface StoredOffer {
  code: string; network: string; creatorPubkey: string; creatorRole: OfferRole; amountSats: number;
  terms: Terms; deadlineSeconds: number; expiresAt: string; status: OfferStatus;
  escrowId: string | null; takerPubkey: string | null; createdAt: string; takenAt: string | null; canceledAt: string | null;
  sig: string; nonce: string; ts: number; fees: object | null; rule: RuleDoc; arbiterMode: "auto" | "manual"; offerHash: string;
}

/** Public JSON for GET /offers/:code (and embedded in create/take/cancel replies). Never includes IPs. */
export function publicOffer(o: StoredOffer, base = "") {
  const url = `${base.replace(/\/$/, "")}/o/${o.code}`;
  return {
    code: o.code, url, status: o.status, network: o.network,
    creatorPubkey: o.creatorPubkey, creatorRole: o.creatorRole, takerRole: (o.creatorRole === "buyer" ? "seller" : "buyer") as OfferRole,
    amountSats: o.amountSats, terms: o.terms, deadlineSeconds: o.deadlineSeconds, expiresAt: o.expiresAt, createdAt: o.createdAt,
    fees: o.fees, rule: o.rule, arbiterMode: o.arbiterMode, offerHash: o.offerHash, sig: o.sig, ts: o.ts, nonce: o.nonce,
    ...(o.status === "taken" ? { escrowId: o.escrowId, takenAt: o.takenAt, takerPubkey: o.takerPubkey } : {}),
    ...(o.status === "canceled" ? { canceledAt: o.canceledAt } : {}),
  };
}

/** Re-export for callers that only import this module. */
export { canonicalJson };
