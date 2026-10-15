/** BOLT11 payout-invoice validation (shared by Mark and the escrow service). */
import { decode } from "light-bolt11-decoder";
import { MarkError } from "../errors.js";
import type { NetworkName } from "../config.js";

export interface DecodedInvoice { sats: number | undefined; msat: number | undefined; createdAt: number; expiresAt: number; paymentHash: string; prefix: string }

export function decodeInvoice(inv: string): DecodedInvoice {
  let d: any;
  try { d = decode(inv.trim().replace(/^lightning:/i, "")); } catch { throw new MarkError("BAD_INVOICE", "could not decode BOLT11 invoice"); }
  const g = (n: string) => d.sections.find((x: any) => x.name === n)?.value;
  const msat = g("amount") !== undefined ? Number(g("amount")) : undefined;
  const ts = Number(g("timestamp")); const exp = Number(g("expiry") ?? 3600);
  return { sats: msat === undefined ? undefined : msat / 1000, msat, createdAt: ts, expiresAt: ts + exp, paymentHash: String(g("payment_hash")), prefix: String(d.sections.find((x: any) => x.name === "lightning_network")?.letters ?? inv.slice(0, 6)) };
}

export function networkOk(inv: string, network: NetworkName) {
  const s = inv.trim().toLowerCase().replace(/^lightning:/, "");
  return network === "bitcoin" ? /^lnbc(?!rt)/.test(s) : /^ln(tbs|tb|sb)/.test(s);
}

/** Fee-drift tolerance: an invoice may request up to this many sats LESS than the exact payout. */
export const invoiceTolerance = (exactSats: number) => Math.max(10, Math.ceil(exactSats * 0.02));
/** Safety margin below the exact payout recommended for new invoices (absorbs small route-fee drift). */
export const RECOMMENDED_MARGIN_SATS = 2;
/** Max sats the payout swap may be under-sourced vs. the escrow (the excess VHTLC funding is overpay to the swap provider). */
export const maxOverpaySats = (escrowSats: number) => invoiceTolerance(escrowSats) + 5;
/** Acceptable invoice amounts for a given exact payout: [exact - tolerance, exact]. */
export function invoiceRange(exactSats: number) {
  const tol = invoiceTolerance(exactSats);
  return { minInvoiceSats: Math.max(1, exactSats - tol), maxInvoiceSats: exactSats, recommendedInvoiceSats: Math.max(1, exactSats - RECOMMENDED_MARGIN_SATS), toleranceSats: tol };
}

/**
 * Throws INVOICE_EXPIRED if the invoice expires within `minRemainingSec`, AMOUNT_MISMATCH unless it requests between
 * `exactSats - invoiceTolerance(exactSats)` and `exactSats` (inclusive), AMOUNTLESS_INVOICE_UNSUPPORTED for amountless invoices (Satora requires an amount), BAD_INVOICE for wrong-network / undecodable invoices.
 */
export function validatePayoutInvoice(inv: string, expectedSats: number, network: NetworkName, nowSec = Math.floor(Date.now() / 1000), minRemainingSec = 600) {
  if (!networkOk(inv, network)) throw new MarkError("BAD_INVOICE", `invoice is not for network ${network}`);
  const d = decodeInvoice(inv);
  if (d.msat === undefined) throw new MarkError("AMOUNTLESS_INVOICE_UNSUPPORTED", `amountless invoice: the swap provider (Satora) requires an invoice amount. Create the invoice for ${invoiceRange(expectedSats).recommendedInvoiceSats} sats (accepted ${invoiceRange(expectedSats).minInvoiceSats}..${expectedSats})`, { setInvoiceAmountSats: invoiceRange(expectedSats).recommendedInvoiceSats, ...invoiceRange(expectedSats) });
  if (d.msat % 1000 !== 0) throw new MarkError("AMOUNT_MISMATCH", "invoice amount must be whole sats");
  if (d.expiresAt - nowSec < minRemainingSec) throw new MarkError("INVOICE_EXPIRED", `invoice expired or expires in under ${minRemainingSec}s`, { expiresAt: new Date(d.expiresAt * 1000).toISOString() });
  const r = invoiceRange(expectedSats);
  if (d.sats! > r.maxInvoiceSats || d.sats! < r.minInvoiceSats) throw new MarkError("AMOUNT_MISMATCH", `invoice requests ${d.sats} sats; must be ${r.minInvoiceSats}..${r.maxInvoiceSats} sats (exact payout after fees right now is ${expectedSats}; recommended ${r.recommendedInvoiceSats})`, { invoiceSats: d.sats, expectedSats, ...r });
  return d;
}
/** true for a decodable BOLT11 without an amount. */
export function isAmountless(inv: string): boolean { try { return decodeInvoice(inv).msat === undefined; } catch { return false; } }
