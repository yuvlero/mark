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

/**
 * Throws INVOICE_EXPIRED if the invoice expires within `minRemainingSec`, AMOUNT_MISMATCH unless it requests exactly
 * `expectedSats`, BAD_INVOICE for amountless / wrong-network / undecodable invoices.
 */
export function validatePayoutInvoice(inv: string, expectedSats: number, network: NetworkName, nowSec = Math.floor(Date.now() / 1000), minRemainingSec = 600) {
  if (!networkOk(inv, network)) throw new MarkError("BAD_INVOICE", `invoice is not for network ${network}`);
  const d = decodeInvoice(inv);
  if (d.msat === undefined) throw new MarkError("BAD_INVOICE", "amountless invoices are not accepted");
  if (d.msat % 1000 !== 0) throw new MarkError("AMOUNT_MISMATCH", "invoice amount must be whole sats");
  if (d.expiresAt - nowSec < minRemainingSec) throw new MarkError("INVOICE_EXPIRED", `invoice expired or expires in under ${minRemainingSec}s`, { expiresAt: new Date(d.expiresAt * 1000).toISOString() });
  if (d.sats !== expectedSats) throw new MarkError("AMOUNT_MISMATCH", `invoice requests ${d.sats} sats; payout after fees is exactly ${expectedSats} sats (see quote)`, { invoiceSats: d.sats, expectedSats });
  return d;
}
