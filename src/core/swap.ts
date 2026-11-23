/** `mark swap` use-cases: BTC (Lightning or Arkade) -> USDC / USDT0 on Arbitrum through Satora. Standalone: no escrow server call,
 *  no deal. Non-custodial: the swap's claim/refund keys and preimage stay in this Mark home (encrypted swap storage). */
import { MarkError } from "../errors.js";
import { NETWORKS } from "../config.js";
import type { Ctx } from "./context.js";
import type { SwapProvider } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { decodeInvoice, networkOk } from "../lightning/invoice.js";
import type { StableSwapCreated } from "../swap/provider.js";
import { ARBISCAN_TX, SWAP_MARKUP_BPS, SWAP_TARGETS, checkEvmAddress, checkMarkupBps, formatSwapQuote, swapSats, swapSource, swapTarget, units, type SwapSource } from "../swap/stable.js";

export interface SwapQuoteInput { from?: string; to?: string; sats?: number | string }
export interface SwapRunInput extends SwapQuoteInput { address?: string; confirm?: boolean; wait?: boolean; timeoutSec?: number; pollMs?: number; onProgress?: (x: unknown) => void }

/** Swap statuses: not paid yet; paid, waiting for Satora's side; ready to claim; done; anything else ended without a payout. */
const UNPAID = new Set(["pending"]);
const PAID_WAITING = new Set(["clientfundingseen", "clientfunded"]);
const WAITING = new Set([...UNPAID, ...PAID_WAITING]);
const PAID_NOTE = "Your payment was seen: wait for Satora to fund its side, then claim. Do NOT pay again.";
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
  checkCreated(c, p, address, created);
  const first = { swap: "created", id: created.id, status: created.status, from: p.from, to: p.to, payoutAddress: created.targetAddress, quote, ...payInstructions(p.from, created),
    next: i.wait && i.onProgress ? "Waiting for your payment, then Mark claims the stablecoins to your address." : `After paying, run: ${mk()} swap claim ${created.id} --wait  (claims as soon as Satora funds its side)` };
  if (!i.wait || !i.onProgress) return first; // waiting is only useful once the payer has seen the invoice / address
  i.onProgress?.(first);
  return { ...(await waitAndClaim(s, created.id, { timeoutSec: i.timeoutSec, pollMs: i.pollMs })), from: p.from, to: p.to, payoutAddress: created.targetAddress };
}

/** Before showing anything payable: the swap must pay out to the confirmed address, ask for exactly the requested sats, and carry a
 *  payable invoice (this network, that amount) or an Ark address for this network. Else SWAP_FAILED: do not pay (an unpaid swap
 *  simply expires). */
function checkCreated(c: Ctx, p: { from: SwapSource; sats: number }, address: string, x: StableSwapCreated) {
  const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `Satora's swap does not match what you confirmed (${why}). Do NOT pay it; nothing is lost while it is unpaid.`, { id: x?.id }); };
  if (!x?.id) bad("no swap id");
  if (String(x.targetAddress ?? "").toLowerCase() !== address.toLowerCase()) bad(`payout address ${x.targetAddress} is not ${address}`);
  if (!Number.isSafeInteger(x.payAmountSats) || x.payAmountSats !== p.sats) bad(`amount ${x.payAmountSats} sats is not ${p.sats}`);
  if (p.from === "lightning") {
    if (!x.invoice || !networkOk(x.invoice, c.network)) bad("no Lightning invoice for this network");
    let sats: number | undefined; try { sats = decodeInvoice(x.invoice!).sats; } catch { bad("undecodable invoice"); }
    if (sats !== p.sats) bad(`invoice asks for ${sats ?? "no amount"} sats, not ${p.sats}`);
  } else {
    if (!x.arkAddress) bad("no Ark address to pay");
    try { checkArkadeAddress(x.arkAddress, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, what: "swap address" }); } catch (e: any) { bad(e?.message ?? "bad Ark address"); }
  }
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
    } else if (!WAITING.has(last) && !CLAIMABLE.has(last)) return { id, status: last, ended: true, note: endedNote(last, id, info.direction) };
    await sleep(poll);
  }
  return { id, status: last, timeout: true, note: `timeout at swap status ${last}. Run ${mk()} swap status ${id}; once it is serverfunded run ${mk()} swap claim ${id}. Do NOT pay again.` };
}
const done = (id: string, status: string, tx?: string) => ({ id, status, swap: "done", ...(tx ? { payoutTx: tx, explorer: ARBISCAN_TX + tx } : {}), note: tx ? "Stablecoins sent to your address." : "Claimed; the payout tx id is not known yet: check mark swap status." });
/** Ended without a payout. Never claims "unpaid" from the status alone: a Lightning hold invoice that was paid but not settled goes
 *  back to the payer's wallet by itself; Arkade sats sent to the swap address come back only with a refund after its timelock. */
function endedNote(status: string, id: string, direction?: string) {
  const ark = `If you sent sats to its Ark address, get them back after the timelock with ${mk()} swap refund ${id} --to <your ark address>.`;
  const ln = "A paid Lightning hold invoice that was not settled returns to your wallet by itself when it times out; nothing to do.";
  const how = direction === "arkade_to_evm" ? ark : direction === "lightning_to_evm" ? ln : `${ln} ${ark}`;
  if (/clientrefunded/.test(status) && !/serverfunded$/.test(status)) return `The swap was refunded to you (${status}).`;
  return `The swap ended without a payout (${status}). ${how}`;
}

/** Status of a swap (read-only), with the payout tx once claimed. */
export async function swapStatus(c: Ctx, id: string) {
  if (!id) throw new MarkError("USAGE", "mark swap status <id>");
  const s = await stable(c); const x = await s.getStable(id);
  const t = Object.values(SWAP_TARGETS).find((v) => v.tokenId.toLowerCase() === (x.tokenContract ?? "").toLowerCase());
  const { raw: _raw, ...info } = x;
  return { ...info, ...(t && x.targetUnits ? { receive: units(x.targetUnits, t.decimals), token: t.symbol } : {}),
    ...(x.payoutTx ? { explorer: ARBISCAN_TX + x.payoutTx } : {}),
    next: CLAIMABLE.has(x.status) ? (x.local ? `Funded: claim it with ${mk()} swap claim ${id}` : "Funded, but this Mark home does not hold the swap's claim key: run the claim from the Mark home that created it. Do NOT pay again.")
      : PAID_WAITING.has(x.status) ? PAID_NOTE : UNPAID.has(x.status) ? "Waiting for your payment." : DONE.has(x.status) ? "Done." : endedNote(x.status, id, x.direction) };
}

/** Claim a funded swap to the address fixed at create (gasless). Safe to repeat. wait: first wait for the payment / funding. */
export async function swapClaim(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  if (!id) throw new MarkError("USAGE", "mark swap claim <id>");
  const s = await stable(c);
  if (o.wait) return waitAndClaim(s, id, o);
  const x = await s.getStable(id);
  if (DONE.has(x.status)) return done(id, x.status, x.payoutTx);
  if (!CLAIMABLE.has(x.status)) return { id, status: x.status, claimed: false, note: PAID_WAITING.has(x.status) ? `Nothing to claim yet. ${PAID_NOTE} (${mk()} swap claim ${id} --wait claims as soon as it is funded)`
    : UNPAID.has(x.status) ? "Not paid yet: nothing to claim. Pay the swap's invoice / Ark address once (shown when it was created)." : endedNote(x.status, id, x.direction) };
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

