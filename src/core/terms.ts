/** Deal terms + evidence: validation, canonical JSON, hashing, BIP340 signature checks.
 *  Shared with its counterpart in the other repo (Mark / escrow server), identical apart from the error class; a server-side parity test enforces it. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { MarkError } from "../errors.js";

export interface Terms { title: string; description: string; deliverable?: string; acceptance?: string; deliverableSha256?: string }
export const TERMS_LIMITS = { title: 120, description: 4000, deliverable: 1000, acceptance: 2000 } as const;
export const EVIDENCE_LIMITS = { text: 4000, url: 500, perDeal: 200 } as const;
// allow \t \n \r; reject other C0/C1 controls and bidi overrides (spoofing in UIs)
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function str(o: any, k: string, max: number, required: boolean): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === "") { if (required) throw new MarkError("BAD_TERMS", `terms.${k} is required`); return undefined; }
  if (typeof v !== "string") throw new MarkError("BAD_TERMS", `terms.${k} must be a string`);
  const t = v.normalize("NFC").trim();
  if (!t) { if (required) throw new MarkError("BAD_TERMS", `terms.${k} is required`); return undefined; }
  if ([...t].length > max) throw new MarkError("BAD_TERMS", `terms.${k} exceeds ${max} characters`);
  if (BAD_CHARS.test(t)) throw new MarkError("BAD_TERMS", `terms.${k} contains control characters`);
  if (k === "title" && /[\r\n]/.test(t)) throw new MarkError("BAD_TERMS", "terms.title must be one line");
  return t;
}
/** Validate + normalize (NFC, trimmed, lowercase hex). Unknown keys are rejected. */
export function normalizeTerms(o: any): Terms {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new MarkError("BAD_TERMS", "terms must be an object");
  const allowed = ["title", "description", "deliverable", "acceptance", "deliverableSha256"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new MarkError("BAD_TERMS", `unknown terms field ${k}`);
  const t: Terms = { title: str(o, "title", TERMS_LIMITS.title, true)!, description: str(o, "description", TERMS_LIMITS.description, true)! };
  const d = str(o, "deliverable", TERMS_LIMITS.deliverable, false); if (d) t.deliverable = d;
  const a = str(o, "acceptance", TERMS_LIMITS.acceptance, false); if (a) t.acceptance = a;
  if (o.deliverableSha256 !== undefined && o.deliverableSha256 !== null && o.deliverableSha256 !== "") {
    const h = String(o.deliverableSha256).toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) throw new MarkError("BAD_TERMS", "terms.deliverableSha256 must be 32-byte hex"); t.deliverableSha256 = h;
  }
  return t;
}
/** Canonical JSON: keys sorted recursively, no whitespace, undefined dropped. */
export function canonicalJson(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}
/** What both parties sign: the terms bound to this deal's network, parties and amount (prevents replay onto another deal).
 *  `fees` (platform fee terms, see fees.ts) is included only when the deal has fee terms, so pre-fee deals hash exactly as before. */
export function termsDocument(t: Terms, d: { network: string; amountSats: number; buyerPubkey: string; sellerPubkey: string; fees?: object | null }) {
  return { v: "mark-escrow-terms/1", network: d.network, amountSats: d.amountSats, buyerPubkey: d.buyerPubkey, sellerPubkey: d.sellerPubkey, terms: t, ...(d.fees ? { fees: d.fees } : {}) };
}
export const termsHash = (doc: unknown) => hex.encode(sha256(new TextEncoder().encode(canonicalJson(doc))));

/** Signed terms v2: also binds everything that decides who can move the money without you. On top of v1 (network, amount,
 *  parties, terms, fees) the parties sign the auto-release rule (type + all params), the arbiter mode, the absolute deadline
 *  (unix seconds: the timeout-refund time) and sha256 of the notification webhookUrl (null = none). Any later change to one of
 *  these on the server breaks every acceptance signature. `fees` is always present (null = no fees). */
export const TERMS_V2 = "mark-escrow-terms/2";
export type RuleDoc = { type: "manual" } | { type: "hash"; sha256: string } | { type: "webhook"; url: string };
/** Canonical rule object (exactly the fields that matter; hash lowercase). */
export function canonicalRule(r: any): RuleDoc {
  const t = r?.type ?? "manual";
  if (t === "manual") return { type: "manual" };
  if (t === "hash") { const h = String(r.sha256 ?? "").toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) throw new MarkError("BAD_RULE", "rule.sha256 must be 32-byte hex"); return { type: "hash", sha256: h }; }
  if (t === "webhook") { if (typeof r.url !== "string" || !r.url) throw new MarkError("BAD_RULE", "rule.url required"); return { type: "webhook", url: r.url }; }
  throw new MarkError("BAD_RULE", `unknown rule type ${t}`);
}
/** Absolute deadline as whole unix seconds (what v2 signs). */
export function deadlineUnix(d: string | number | Date): number {
  const ms = d instanceof Date ? +d : typeof d === "number" ? d * 1000 : Date.parse(d);
  if (!Number.isFinite(ms)) throw new MarkError("BAD_DEADLINE", "deadline must be an absolute time");
  return Math.floor(ms / 1000);
}
export const webhookUrlHash = (u?: string | null) => (u ? hex.encode(sha256(new TextEncoder().encode(u))) : null);
export interface DealBinding { network: string; amountSats: number; buyerPubkey: string; sellerPubkey: string; fees?: object | null;
  rule: unknown; arbiterMode: "auto" | "manual"; deadline: number; webhookUrlSha256: string | null }
export function termsDocumentV2(t: Terms, d: DealBinding) {
  if (d.arbiterMode !== "auto" && d.arbiterMode !== "manual") throw new MarkError("BAD_REQUEST", "arbiterMode must be auto or manual");
  if (!Number.isInteger(d.deadline)) throw new MarkError("BAD_DEADLINE", "deadline must be whole unix seconds");
  if (d.webhookUrlSha256 !== null && !/^[0-9a-f]{64}$/.test(d.webhookUrlSha256)) throw new MarkError("BAD_REQUEST", "webhookUrlSha256 must be 32-byte hex or null");
  return { v: TERMS_V2, network: d.network, amountSats: d.amountSats, buyerPubkey: d.buyerPubkey, sellerPubkey: d.sellerPubkey, terms: t, fees: d.fees ?? null,
    rule: canonicalRule(d.rule), arbiterMode: d.arbiterMode, deadline: d.deadline, webhookUrlSha256: d.webhookUrlSha256 };
}
/** The document a stored deal's parties sign, by its termsVersion (absent = 1). `webhookUrlSha256` is what the public API returns. */
export function dealTermsDocument(e: { termsVersion?: number; network: string; amountSats: number; buyerPubkey: string; sellerPubkey: string; fees?: object | null;
  terms: Terms; rule?: unknown; arbiterMode?: string; deadline: string; webhookUrlSha256?: string | null }) {
  const base = { network: e.network, amountSats: e.amountSats, buyerPubkey: e.buyerPubkey, sellerPubkey: e.sellerPubkey, fees: e.fees ?? null };
  if ((e.termsVersion ?? 1) === 1) return termsDocument(normalizeTerms(e.terms), base);
  if (e.termsVersion !== 2) throw new MarkError("BAD_TERMS_VERSION", `unsupported termsVersion ${e.termsVersion}`);
  return termsDocumentV2(normalizeTerms(e.terms), { ...base, rule: e.rule ?? { type: "manual" }, arbiterMode: e.arbiterMode as any,
    deadline: deadlineUnix(e.deadline), webhookUrlSha256: e.webhookUrlSha256 ?? null });
}

/** Arbiter attestation (server identity): the server signs, with its long-lived arbiter identity key (published in GET /limits
 *  `arbiter.identityPubkey`), that this deal's per-deal arbiter key, Arkade server key, exit delay and address are its own.
 *  Clients pin the identity key per escrow URL and check every deal against it before signing or funding. */
export const ARBITER_ATTESTATION_V1 = "mark-escrow-arbiter/1";
export function arbiterAttestationHash(d: { network: string; escrowId: string; arbiterPubkey: string; serverPubkey: string; exitDelay: number; address: string }) {
  return termsHash({ v: ARBITER_ATTESTATION_V1, network: d.network, escrowId: d.escrowId, arbiterPubkey: d.arbiterPubkey, serverPubkey: d.serverPubkey, exitDelay: d.exitDelay, address: d.address });
}
/** BIP340 Schnorr signature over the 32-byte termsHash. */
export function verifyTermsSig(xonly: string, hashHex: string, sig: string) {
  try { return /^[0-9a-f]{128}$/i.test(sig) && schnorr.verify(hex.decode(sig.toLowerCase()), hex.decode(hashHex), hex.decode(xonly)); } catch { return false; }
}

export interface EvidenceIn { text: string; sha256?: string; url?: string }
export function normalizeEvidence(o: any): EvidenceIn {
  const text = typeof o?.text === "string" ? o.text.normalize("NFC").trim() : "";
  if (!text) throw new MarkError("BAD_EVIDENCE", "evidence text is required");
  if ([...text].length > EVIDENCE_LIMITS.text) throw new MarkError("BAD_EVIDENCE", `evidence text exceeds ${EVIDENCE_LIMITS.text} characters`);
  if (BAD_CHARS.test(text)) throw new MarkError("BAD_EVIDENCE", "evidence text contains control characters");
  const r: EvidenceIn = { text };
  if (o.sha256) { const h = String(o.sha256).toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) throw new MarkError("BAD_EVIDENCE", "sha256 must be 32-byte hex"); r.sha256 = h; }
  if (o.url) { const u = String(o.url).trim(); if (u.length > EVIDENCE_LIMITS.url || !/^https?:\/\/[^\s]+$/i.test(u) || BAD_CHARS.test(u)) throw new MarkError("BAD_EVIDENCE", "url must be http(s), no spaces, <= 500 chars"); r.url = u; }
  return r;
}
/** Evidence signature: BIP340 over sha256(canonical {v, escrowId, party, ts, text, sha256?, url?}). */
export function evidenceHash(escrowId: string, party: string, ts: number, ev: EvidenceIn) {
  return termsHash({ v: "mark-escrow-evidence/1", escrowId, party, ts, ...ev });
}

/** Per-deal message threads. Parties sign with their escrow key, the operator (and system messages) with the deal's arbiter key. */
export const MESSAGE_LIMITS = { body: 4000 } as const;
export const MESSAGE_KINDS = ["question", "dispute", "evidence", "info", "system"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export interface MessageIn { body: string; kind?: MessageKind; replyTo?: string }
export function normalizeMessage(o: any): MessageIn {
  const body = typeof o?.body === "string" ? o.body.normalize("NFC").trim() : "";
  if (!body) throw new MarkError("BAD_MESSAGE", "message body is required");
  if ([...body].length > MESSAGE_LIMITS.body) throw new MarkError("BAD_MESSAGE", `message body exceeds ${MESSAGE_LIMITS.body} characters`);
  if (BAD_CHARS.test(body)) throw new MarkError("BAD_MESSAGE", "message body contains control characters");
  const r: MessageIn = { body };
  if (o.kind !== undefined && o.kind !== null && o.kind !== "") { if (!MESSAGE_KINDS.includes(o.kind)) throw new MarkError("BAD_MESSAGE", `kind must be one of ${MESSAGE_KINDS.join("|")}`); r.kind = o.kind; }
  if (o.replyTo !== undefined && o.replyTo !== null && o.replyTo !== "") { const h = String(o.replyTo).toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) throw new MarkError("BAD_MESSAGE", "replyTo must be a message id (64 hex)"); r.replyTo = h; }
  return r;
}
/** Message id = signed hash: sha256(canonical {v, escrowId, author, ts, body, kind?, replyTo?}). */
export function messageHash(escrowId: string, author: string, ts: number, m: MessageIn) {
  return termsHash({ v: "mark-escrow-message/1", escrowId, author, ts, ...m });
}
