/** `mark swap` use-cases: BTC (Lightning or Arkade) -> USDC / USDT0 on Arbitrum through Satora. Standalone: no escrow server call,
 *  no deal. Non-custodial: the swap's claim/refund keys and preimage stay in this Mark home (encrypted swap storage). */
import { MarkError } from "../errors.js";
import { NETWORKS } from "../config.js";
import type { Ctx } from "./context.js";
import type { SwapProvider } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { ARBISCAN_TX, SWAP_MARKUP_BPS, SWAP_TARGETS, checkEvmAddress, checkMarkupBps, formatSwapQuote, swapSats, swapSource, swapTarget, units, type SwapSource } from "../swap/stable.js";

export interface SwapQuoteInput { from?: string; to?: string; sats?: number | string }
export interface SwapRunInput extends SwapQuoteInput { address?: string; confirm?: boolean; wait?: boolean; timeoutSec?: number; pollMs?: number; onProgress?: (x: unknown) => void }

/** Swap statuses: waiting for the BTC payment; ready to claim; done; failed/ended without a payout. */
const WAITING = new Set(["pending", "clientfundingseen", "clientfunded"]);
const CLAIMABLE = new Set(["serverfunded", "clientredeeming"]);
const DONE = new Set(["clientredeemed", "serverredeemed"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mainnetOnly(c: Ctx) {
  if (!NETWORKS[c.network].isMainnet) throw new MarkError("SWAP_UNSUPPORTED_NETWORK", "mark swap runs on bitcoin mainnet only: Satora has no Arbitrum stablecoin route on mutinynet. Use --network bitcoin: `mark swap quote` and a preview without --yes are free and create nothing.");
}
async function stable(c: Ctx): Promise<Required<Pick<SwapProvider, "quoteStable" | "createStable" | "getStable" | "claimStable">> & SwapProvider> {
  const s = await c.swaps();
  if (!s.quoteStable || !s.createStable || !s.getStable || !s.claimStable) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} does not support mark swap`);
  return s as any;
}
function parse(i: SwapQuoteInput) { return { from: swapSource(i.from), to: swapTarget(i.to), sats: swapSats(i.sats), bps: checkMarkupBps(SWAP_MARKUP_BPS) }; }

/** Quote only (nothing is created): rate, Satora fee, our markup, network fee, total, what you receive. */
export async function swapQuote(c: Ctx, i: SwapQuoteInput) {
  mainnetOnly(c); const p = parse(i); const s = await stable(c);
  const q = await s.quoteStable(p);
  const out = formatSwapQuote(q, p);
  const inRange = p.sats >= q.min_amount && p.sats <= q.max_amount;
  return { quote: out, ...(inRange ? {} : { note: `amount out of range: Satora accepts ${q.min_amount}..${q.max_amount} sats for this pair` }),
    next: `${mk()} swap --from ${p.from} --to ${p.to} --sats ${p.sats} --address <your 0x address on Arbitrum> previews it; add --yes to create it` };
}

function payInstructions(from: SwapSource, x: { id: string; invoice?: string; arkAddress?: string; payAmountSats: number }) {
  return from === "lightning"
    ? { invoice: x.invoice, howToPay: "Pay this Lightning invoice from any Lightning wallet, once. It is a hold invoice: it settles only when your stablecoins are claimed, else it expires and your wallet gets the sats back." }
    : { arkAddress: x.arkAddress, amountSats: x.payAmountSats, howToPay: `Send exactly amountSats to arkAddress in ONE payment from an Arkade wallet on https://arkade.computer (not Bark / Second). If the swap fails, refund it with ${mk()} swap refund ${x.id} --to <your ark address> after its timelock.` };
}

/** Preview (default) or create + run a swap. confirm: create it. wait: after payment, claim and wait for the payout tx. */
export async function swapRun(c: Ctx, i: SwapRunInput) {
  mainnetOnly(c); const p = parse(i); const address = checkEvmAddress(i.address); const t = SWAP_TARGETS[p.to]; const s = await stable(c);
  const q = await s.quoteStable(p);
  const quote = formatSwapQuote(q, p);
  if (p.sats < q.min_amount || p.sats > q.max_amount) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for ${p.from} -> ${t.symbol}`, { quote });
  if (!i.confirm) return { swap: "preview", quote, payoutAddress: address,
    notice: `REAL MONEY: this swaps ${p.sats} sats of bitcoin mainnet into about ${quote.receive} ${t.symbol} on Arbitrum, sent to ${address}. Check the address: a payout to a wrong address cannot be undone. ${quote.markupNote}`,
    next: `Nothing was created. To create it: ${mk()} swap --from ${p.from} --to ${p.to} --sats ${p.sats} --address ${address} --yes --wait` };
  const created = await s.createStable({ ...p, address });
  if (!created.id) throw new MarkError("SWAP_FAILED", "Satora returned no swap id");
  const first = { swap: "created", id: created.id, status: created.status, from: p.from, to: p.to, payoutAddress: created.targetAddress, quote, ...payInstructions(p.from, created),
    next: i.wait && i.onProgress ? "Waiting for your payment, then Mark claims the stablecoins to your address." : `After paying, run: ${mk()} swap claim ${created.id} --wait  (claims as soon as Satora funds its side)` };
  if (!i.wait || !i.onProgress) return first; // waiting is only useful once the payer has seen the invoice / address
  i.onProgress?.(first);
  return { ...(await waitAndClaim(s, created.id, { timeoutSec: i.timeoutSec, pollMs: i.pollMs })), from: p.from, to: p.to, payoutAddress: created.targetAddress };
}

async function waitAndClaim(s: Awaited<ReturnType<typeof stable>>, id: string, o: { timeoutSec?: number; pollMs?: number }) {
  const end = Date.now() + (o.timeoutSec ?? 900) * 1000; const poll = o.pollMs ?? 5000; let last = "unknown"; let claim: any;
  while (Date.now() < end) {
    let info; try { info = await s.getStable(id); } catch { await sleep(poll); continue; }
    last = info.status;
    if (DONE.has(last)) return done(id, last, info.payoutTx ?? claim?.txHash);
    if (CLAIMABLE.has(last) && !claim?.success) {
      claim = await s.claimStable(id);
      if (!claim.success) return { id, status: last, claimFailed: true, claim, note: `The swap is funded but the claim failed. Your payment is safe while status is ${last}: retry with ${mk()} swap claim ${id} (same Mark home). Do NOT pay again.` };
      if (claim.txHash) return done(id, last, claim.txHash);
    } else if (!WAITING.has(last) && !CLAIMABLE.has(last)) return { id, status: last, ended: true, note: endedNote(last, id) };
    await sleep(poll);
  }
  return { id, status: last, timeout: true, note: `timeout at swap status ${last}. Run ${mk()} swap status ${id}; once it is serverfunded run ${mk()} swap claim ${id}. Do NOT pay again.` };
}
const done = (id: string, status: string, tx?: string) => ({ id, status, swap: "done", ...(tx ? { payoutTx: tx, explorer: ARBISCAN_TX + tx } : {}), note: tx ? "Stablecoins sent to your address." : "Claimed; the payout tx id is not known yet: check mark swap status." });
function endedNote(status: string, id: string) {
  if (status === "expired") return "The swap expired without a payment. Nothing to do (a Lightning hold invoice was never settled).";
  if (/refunded/.test(status)) return `The swap was refunded (${status}).`;
  return `The swap ended without a payout (${status}). For an Arkade-funded swap, refund it after its timelock: ${mk()} swap refund ${id} --to <your ark address>.`;
}

/** Status of a swap (read-only), with the payout tx once claimed. */
export async function swapStatus(c: Ctx, id: string) {
  if (!id) throw new MarkError("USAGE", "mark swap status <id>");
  const s = await stable(c); const x = await s.getStable(id);
  const t = Object.values(SWAP_TARGETS).find((v) => v.tokenId.toLowerCase() === (x.tokenContract ?? "").toLowerCase());
  const { raw: _raw, ...info } = x;
  return { ...info, ...(t && x.targetUnits ? { receive: units(x.targetUnits, t.decimals), token: t.symbol } : {}),
    ...(x.payoutTx ? { explorer: ARBISCAN_TX + x.payoutTx } : {}),
    next: CLAIMABLE.has(x.status) ? (x.local ? `Funded: claim it with ${mk()} swap claim ${id}` : "Funded, but this Mark home does not hold the swap's claim key: run the claim from the Mark home that created it.")
      : WAITING.has(x.status) ? "Waiting for the BTC payment (or for Satora to fund its side)." : DONE.has(x.status) ? "Done." : endedNote(x.status, id) };
}

/** Claim a funded swap to the address fixed at create (gasless). Safe to repeat. wait: first wait for the payment / funding. */
export async function swapClaim(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  if (!id) throw new MarkError("USAGE", "mark swap claim <id>");
  const s = await stable(c);
  if (o.wait) return waitAndClaim(s, id, o);
  const x = await s.getStable(id);
  if (DONE.has(x.status)) return done(id, x.status, x.payoutTx);
  if (!CLAIMABLE.has(x.status)) return { id, status: x.status, claimed: false, note: WAITING.has(x.status) ? "Not funded yet: nothing to claim. Pay first, or wait for Satora to fund its side." : endedNote(x.status, id) };
  const r = await s.claimStable(id);
  if (!r.success) return { id, status: x.status, claimFailed: true, claim: r, note: "Claim failed; retry later. Do NOT pay again." };
  return done(id, x.status, r.txHash);
}

/** Refund an Arkade-funded swap that did not pay out (after its timelock) to an Ark address. Lightning swaps need no refund. */
export async function swapRefund(c: Ctx, id: string, to?: string) {
  if (!id || !to) throw new MarkError("USAGE", "mark swap refund <id> --to <ark address from an Arkade wallet on https://arkade.computer>");
  const s = await stable(c); const x = await s.getStable(id);
  if (x.direction && x.direction !== "arkade_to_evm") throw new MarkError("USAGE", "only an Arkade-funded swap is refunded with mark swap refund; a Lightning hold invoice simply expires and your wallet gets the sats back");
  // the refund address must be on the swap's Arkade server (its key is in the swap)
  const dest = checkArkadeAddress(to, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, serverPubkey: (x.raw as any)?.arkade_server_pk ?? null, what: "refund address" });
  const r = await s.refund(id, dest);
  return { id, refunded: r.success, ...(r.txid ? { txid: r.txid } : {}), ...(r.message ? { message: r.message } : {}) };
}

