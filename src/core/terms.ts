/** Deal terms + evidence: validation, canonical JSON, hashing, BIP340 signature checks.
 *  MUST stay byte-identical with escrow-server/src/lib/terms.ts (see docs/escrow-api.md "Terms"). */
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
