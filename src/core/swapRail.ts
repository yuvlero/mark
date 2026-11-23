/** `mark swap` Lightning ↔ Arkade through Satora. Standalone: no escrow server, no deal. Non-custodial: keys stay in this Mark home. */
import { MarkError } from "../errors.js";
import type { Ctx } from "./context.js";
import type { SwapProvider } from "../swap/provider.js";
import type { RailSwapCreated, RailSwapInfo } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { decodeInvoice, networkOk } from "../lightning/invoice.js";
import { SWAP_UNPAID, SWAP_PAID, SWAP_WAITING, SWAP_CLAIMABLE, SWAP_DONE, isRailDir, railDir } from "../swap/states.js";
import { sleep } from "../util.js";
import { SWAP_MARKUP_BPS, SWAP_MAX_SLIPPAGE_BPS, SWAP_SOURCES, checkMarkupBps, formatRailQuote, pct, swapSats, type SwapSource, type SwapRail } from "../swap/stable.js";

export interface RailInput { from: SwapSource; to: SwapRail; sats?: number | string; invoice?: string; address?: string }
export interface RailRunInput extends RailInput { confirm?: boolean; wait?: boolean; timeoutSec?: number; pollMs?: number; onProgress?: (x: unknown) => void }

const PAID_NOTE = "Your payment was seen: wait for Satora to fund its side, then claim (Lightning to Arkade) or for Satora to pay the invoice (Arkade to Lightning). Do NOT pay again.";

type Prov = Required<Pick<SwapProvider, "quoteRail" | "createRail" | "getRail" | "claim" | "refund">> & SwapProvider;
export async function rail(c: Ctx): Promise<Prov> {
  const s = await c.swaps();
  if (!s.quoteRail || !s.createRail || !s.getRail) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} does not support Lightning ↔ Arkade swaps`);
  return s as Prov;
}
export async function loadRail(c: Ctx, id: string) { const r = await rail(c); return [r, await r.getRail(id)] as const; }

function parseInvoice(c: Ctx, invoice: string) {
  const inv = invoice.trim().replace(/^lightning:/i, "");
  if (!networkOk(inv, c.network)) throw new MarkError("BAD_INVOICE", `--invoice is not a Lightning invoice for ${c.network}`);
  const d = decodeInvoice(inv);
  if (!d.sats || !Number.isSafeInteger(d.sats)) throw new MarkError("AMOUNTLESS_INVOICE_UNSUPPORTED", "--invoice needs an amount in whole sats (Satora pays out exactly the invoice)");
  if (d.expiresAt - Date.now() / 1000 < 600) throw new MarkError("INVOICE_EXPIRED", "--invoice expires in under 10 minutes: make a new one");
  return { invoice: inv, invoiceSats: d.sats };
}

export function parseRail(c: Ctx, i: RailInput, mode: "quote" | "create" = "create") {
  const bps = checkMarkupBps(SWAP_MARKUP_BPS);
  if (i.from === i.to) throw new MarkError("USAGE", `--from and --to cannot both be ${i.from}`);
  if (i.to === "lightning") {
    if (i.address !== undefined) throw new MarkError("USAGE", "--to lightning takes --invoice <bolt11 with an amount> (a Lightning address is not supported: Mark cannot check the invoice Satora would fetch for it)");
    if (i.invoice !== undefined) {
      if (i.sats !== undefined) throw new MarkError("USAGE", "--invoice pins the Lightning payout: do not add --sats (the quote shows how many sats to send)");
      return { from: i.from, to: i.to, bps, ...parseInvoice(c, String(i.invoice)) };
    }
    if (mode === "create") throw new MarkError("USAGE", "--from arkade --to lightning needs --invoice <bolt11 with an amount>");
    return { from: i.from, to: i.to, bps, sats: swapSats(i.sats) };
  }
  if (i.invoice !== undefined) throw new MarkError("USAGE", "--invoice is only for --to lightning");
  const sats = swapSats(i.sats);
  if (i.address === undefined) {
    if (mode === "create") throw new MarkError("USAGE", "--from lightning --to arkade needs --sats N --address <ark address from an Arkade wallet on https://arkade.computer>");
    return { from: i.from, to: i.to, bps, sats };
  }
  const address = checkArkadeAddress(i.address, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, what: "--address" });
  return { from: i.from, to: i.to, bps, sats, address };
}
type Parsed = ReturnType<typeof parseRail>;

function flags(p: Parsed) {
  if (p.to === "lightning") return `--from ${p.from} --to lightning ${"invoice" in p && p.invoice ? `--invoice ${p.invoice}` : "--invoice <bolt11 for the sats you want>"}`;
  return `--from ${p.from} --to arkade --sats ${p.sats} --address ${"address" in p && p.address ? p.address : "<ark address on https://arkade.computer>"}`;
}

async function quoteOf(s: Prov, p: Parsed) {
  const q = await s.quoteRail({ from: p.from, to: p.to, bps: p.bps, ...("invoice" in p && p.invoice ? { invoice: p.invoice } : { sats: p.sats }) });
  if (!/^\d+$/.test(String(q?.source_amount ?? "")) || BigInt(q.source_amount) <= 0n || !(Number(q?.net_target_amount) > 0))
    throw new MarkError("QUOTE_UNAVAILABLE", "Satora's quote has no amounts; nothing was created. Retry later.");
  return q;
}
function inRange(q: { min_amount?: number; max_amount?: number; source_amount?: string; target_amount?: string }, fromLightning: boolean) {
  if (!(Number.isSafeInteger(q.min_amount) && Number.isSafeInteger(q.max_amount))) return true;
  const n = Number(fromLightning ? q.source_amount : (q.target_amount ?? q.source_amount));
  return n >= q.min_amount! && n <= q.max_amount!;
}

export async function railQuote(c: Ctx, i: RailInput) {
  const p = parseRail(c, i, "quote"); const s = await rail(c); const q = await quoteOf(s, p);
  const out = formatRailQuote(q, p);
  const ok = inRange(q, p.from === "lightning");
  return { quote: out, ...(ok ? {} : { note: `amount out of range: Satora accepts ${q.min_amount}..${q.max_amount} sats for this pair` }),
    next: `${mk()} swap ${flags(p)} previews it; add --yes to create it` };
}

function payInstructions(p: Parsed, x: RailSwapCreated) {
  return p.from === "lightning"
    ? { invoice: x.invoice, howToPay: "Pay this Lightning invoice from any Lightning wallet, once. It is a hold invoice: it settles only when the Arkade payout is claimed, else it expires and your wallet gets the sats back." }
    : { arkAddress: x.fundArkAddress, amountSats: x.payAmountSats, howToPay: `Send exactly amountSats to arkAddress in ONE payment from an Arkade wallet on https://arkade.computer (not Bark / Second). Satora then pays the Lightning invoice. If the swap fails, refund it with ${mk()} swap refund ${x.id} --to <your ark address> after its timelock.` };
}

export async function railRun(c: Ctx, i: RailRunInput) {
  const p = parseRail(c, i, "create"); const s = await rail(c); const q = await quoteOf(s, p);
  const quote = formatRailQuote(q, p);
  if (!inRange(q, p.from === "lightning")) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for ${p.from} -> ${p.to}`, { quote });
  if (p.to === "lightning" && "invoiceSats" in p && p.invoiceSats !== Number(q.net_target_amount) && p.invoiceSats !== Number(q.target_amount))
    throw new MarkError("SWAP_AMOUNT", `the invoice is for ${p.invoiceSats} sats, but this quote pays ${q.net_target_amount} sats. Make an invoice for ${q.net_target_amount} sats, or quote again.`, { quote });
  if (!i.confirm) {
    const dest = p.to === "lightning" ? `Lightning invoice (${"invoiceSats" in p ? p.invoiceSats + " sats" : "the invoice"})` : `Ark address ${p.address}`;
    return { swap: "preview", quote, payout: dest,
      notice: `REAL MONEY: this swaps ${quote.payAmountSats} sats of bitcoin mainnet from ${p.from} to ${p.to}, paying out to ${dest}. Check the destination: a payout to a wrong address or invoice cannot be undone. ${quote.markupNote}`,
      next: `Nothing was created. To create it: ${mk()} swap ${flags(p)} --yes --wait` };
  }
  const created = await s.createRail({ from: p.from, to: p.to, bps: p.bps, sats: p.sats, address: "address" in p ? p.address : undefined, invoice: "invoice" in p ? p.invoice : undefined });
  checkRailCreated(c, p, created, q);
  const first = { swap: "created", id: created.id, status: created.status, from: p.from, to: p.to, expectedReceiveSats: created.receiveSats, quote, ...payInstructions(p, created),
    next: i.wait && i.onProgress
      ? (p.from === "lightning" ? "Waiting for your payment, then Mark claims the sats to your Ark address." : "Waiting for your Arkade payment, then for Satora to pay the Lightning invoice.")
      : (p.from === "lightning" ? `After paying, run: ${mk()} swap claim ${created.id} --wait  (claims as soon as Satora funds its side)` : `After sending the sats, run: ${mk()} swap status ${created.id}  (or ${mk()} swap claim ${created.id} --wait to wait for the invoice to be paid)`) };
  if (!i.wait || !i.onProgress) return first;
  i.onProgress?.(first);
  return { ...(await waitRail(s, created.id, { timeoutSec: i.timeoutSec, pollMs: i.pollMs })), from: p.from, to: p.to };
}

function checkRailCreated(c: Ctx, p: Parsed, x: RailSwapCreated, q: { net_target_amount: string; source_amount: string }) {
  const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `Satora's swap does not match what you confirmed (${why}). Do NOT pay it; nothing is lost while it is unpaid.`, { id: x?.id }); };
  const src = SWAP_SOURCES[p.from], tgt = SWAP_SOURCES[p.to];
  if (!x?.id) bad("no swap id");
  if (x.status !== "pending") bad(`status ${x.status}, not a new unpaid swap`);
  if (x.direction && x.direction !== railDir(p.from)) bad(`direction ${x.direction} is not ${railDir(p.from)}`);
  if (x.sourceChain !== src.chain) bad(`source ${x.sourceChain} is not ${src.chain}`);
  if (x.targetChain !== tgt.chain) bad(`target ${x.targetChain} is not ${tgt.chain}`);
  if (!Number.isSafeInteger(x.payAmountSats) || x.payAmountSats <= 0) bad(`amount ${x.payAmountSats} sats is not a positive whole number`);
  if (p.from === "lightning") {
    if (x.payAmountSats !== p.sats) bad(`amount ${x.payAmountSats} sats is not ${p.sats}`);
    if (!x.invoice || !networkOk(x.invoice, c.network)) bad("no Lightning invoice for this network");
    let sats: number | undefined; try { sats = decodeInvoice(x.invoice!).sats; } catch { bad("undecodable invoice"); }
    if (sats !== p.sats) bad(`invoice asks for ${sats ?? "no amount"} sats, not ${p.sats}`);
    if (!x.payoutArkAddress) bad("no Ark payout address");
    if (p.address && x.payoutArkAddress !== p.address) bad(`payout address ${x.payoutArkAddress} is not ${p.address}`);
    try { checkArkadeAddress(x.payoutArkAddress, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, serverPubkey: (x.raw as any)?.arkade_server_pk ?? null, what: "--address" }); } catch (e: any) { bad(e?.message ?? "bad Ark payout address"); }
  } else {
    if (!x.fundArkAddress) bad("no Ark address to pay");
    try { checkArkadeAddress(x.fundArkAddress, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, serverPubkey: (x.raw as any)?.arkade_server_pk ?? null, what: "swap address" }); } catch (e: any) { bad(e?.message ?? "bad Ark address"); }
    if (!x.invoice || !networkOk(x.invoice, c.network)) bad("no payout invoice for this network");
    if ("invoice" in p && p.invoice && x.invoice !== p.invoice) bad("the invoice Satora pays is not the one you confirmed");
    let got: number | undefined; try { got = decodeInvoice(x.invoice!).sats; } catch { bad("undecodable payout invoice"); }
    if ("invoiceSats" in p && got !== p.invoiceSats) bad(`payout invoice is ${got} sats, not ${p.invoiceSats}`);
    if (x.payAmountSats !== Number(q.source_amount)) bad(`lock amount ${x.payAmountSats} sats is not the quoted ${q.source_amount}`);
  }
  if (!Number.isSafeInteger(x.receiveSats) || (x.receiveSats ?? 0) <= 0) bad(`payout ${x.receiveSats} is not a positive sats amount`);
  const quoted = Number(q.net_target_amount);
  if (Number.isSafeInteger(quoted) && quoted > 0 && x.receiveSats! * 10000 < quoted * (10000 - SWAP_MAX_SLIPPAGE_BPS))
    bad(`payout ${x.receiveSats} sats is more than ${pct(SWAP_MAX_SLIPPAGE_BPS)} below the quote (${quoted})`);
}

function endedNote(status: string, id: string, direction?: string) {
  const ark = `If you sent sats to its Ark address, get them back after the timelock with ${mk()} swap refund ${id} --to <your ark address>.`;
  const ln = "A paid Lightning hold invoice that was not settled returns to your wallet by itself when it times out; nothing to do.";
  const how = direction === "arkade_to_lightning" ? ark : direction === "lightning_to_arkade" ? ln : `${ln} ${ark}`;
  if (/clientrefunded/.test(status) && !/serverfunded$/.test(status)) return `The swap was refunded to you (${status}).`;
  return `The swap ended without a payout (${status}). ${how}`;
}

function notRail(x: RailSwapInfo) {
  if (x.direction && !isRailDir(x.direction)) throw new MarkError("USAGE", `swap ${x.id} is not a Lightning ↔ Arkade swap (${x.direction})`);
}

function nextNote(x: RailSwapInfo) {
  if (SWAP_DONE.has(x.status)) return "Done.";
  if (SWAP_UNPAID.has(x.status)) return "Waiting for your payment.";
  if (SWAP_PAID.has(x.status)) return PAID_NOTE;
  if (SWAP_CLAIMABLE.has(x.status)) {
    if (x.direction === "lightning_to_arkade") return x.local ? `Funded: claim it with ${mk()} swap claim ${x.id}` : "Funded, but this Mark home does not hold the swap's claim key: run the claim from the Mark home that created it. Do NOT pay again.";
    return PAID_NOTE;
  }
  return endedNote(x.status, x.id, x.direction);
}

export async function railStatus(s: Prov, x0: RailSwapInfo) {
  notRail(x0);
  const { raw: _raw, ...info } = x0;
  return { ...info, next: nextNote(x0) };
}

export async function waitRail(s: Prov, id: string, o: { timeoutSec?: number; pollMs?: number }) {
  const end = Date.now() + (o.timeoutSec ?? 900) * 1000; const poll = o.pollMs ?? 5000; let last = "unknown"; let dir: RailSwapInfo["direction"]; let claim: { success: boolean; txid?: string; message?: string } | undefined;
  while (Date.now() < end) {
    let info: RailSwapInfo; try { info = await s.getRail(id); } catch { await sleep(poll); continue; }
    last = info.status; dir = info.direction ?? dir;
    if (SWAP_DONE.has(last)) return railDone(info, claim?.txid);
    if (info.direction === "lightning_to_arkade" && SWAP_CLAIMABLE.has(last) && !claim?.success) {
      if (!info.local) return { id, status: last, claimed: false, note: "This Mark home does not hold the swap's claim key: run the claim from the Mark home that created it. Do NOT pay again." };
      if (!info.payoutArkAddress) return { id, status: last, claimFailed: true, note: `The swap is funded but has no Ark payout address. Your payment is safe while status is ${last}: retry with ${mk()} swap claim ${id} (same Mark home). Do NOT pay again.` };
      const r = await s.claim(id, info.payoutArkAddress);
      claim = r;
      if (!r.success) return { id, status: last, claimFailed: true, claim: r, note: `The swap is funded but the claim failed. Your payment is safe while status is ${last}: retry with ${mk()} swap claim ${id} (same Mark home). Do NOT pay again.` };
      if (r.txid) return railSettled(s, id, last, r.txid, poll);
    } else if (!SWAP_WAITING.has(last) && !SWAP_CLAIMABLE.has(last)) return { id, status: last, ended: true, note: endedNote(last, id, info.direction) };
    await sleep(poll);
  }
  const claimHint = last && SWAP_CLAIMABLE.has(last) && dir !== "arkade_to_lightning" ? `; once it is serverfunded run ${mk()} swap claim ${id}` : "";
  return { id, status: last, timeout: true, note: `timeout at swap status ${last}. Run ${mk()} swap status ${id}${claimHint}. Do NOT pay again.` };
}

const SETTLE_TRIES = 4;
async function railSettled(s: Prov, id: string, status: string, tx: string, poll: number) {
  let last: RailSwapInfo | undefined;
  for (let i = 0; i < SETTLE_TRIES; i++) {
    if (i) await sleep(Math.min(poll, 2000));
    try { const x = await s.getRail(id); last = x; if (SWAP_DONE.has(x.status)) return railDone(x, tx); } catch { /* keep the claim-time status */ }
  }
  return railDone(last ?? { id, status, payAmountSats: NaN, local: true }, tx);
}
function railDone(x: RailSwapInfo | { id: string; status: string; payAmountSats: number; local: boolean; receiveSats?: number; payoutTx?: string; fundTx?: string }, tx?: string) {
  const payoutTx = tx ?? ("payoutTx" in x ? x.payoutTx : undefined);
  return { id: x.id, status: x.status, swap: "done" as const, ...(payoutTx ? { payoutTx } : {}), ...(x.receiveSats != null ? { receiveSats: x.receiveSats } : {}),
    note: payoutTx ? "Sats sent to your Ark address." : (SWAP_DONE.has(x.status) && !payoutTx && !("payoutArkAddress" in x && (x as RailSwapInfo).payoutArkAddress) ? "Lightning invoice paid." : "Done.") };
}

export async function railClaim(s: Prov, x0: RailSwapInfo, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  notRail(x0);
  if (o.wait) return waitRail(s, x0.id, o);
  if (SWAP_DONE.has(x0.status)) return railDone(x0);
  if (x0.direction === "arkade_to_lightning") {
    if (!SWAP_CLAIMABLE.has(x0.status) && !SWAP_PAID.has(x0.status) && !SWAP_UNPAID.has(x0.status)) return { id: x0.id, status: x0.status, claimed: false, note: endedNote(x0.status, x0.id, x0.direction) };
    return { id: x0.id, status: x0.status, claimed: false, note: SWAP_UNPAID.has(x0.status) ? "Not paid yet: send the sats to the swap's Ark address once (shown when it was created). Satora pays the invoice; there is nothing to claim." : "Satora pays the Lightning invoice once it has the Arkade funds. There is nothing to claim. Do NOT pay again." };
  }
  if (!SWAP_CLAIMABLE.has(x0.status)) return { id: x0.id, status: x0.status, claimed: false, note: SWAP_PAID.has(x0.status) ? `Nothing to claim yet. ${PAID_NOTE} (${mk()} swap claim ${x0.id} --wait claims as soon as it is funded)`
    : SWAP_UNPAID.has(x0.status) ? "Not paid yet: nothing to claim. Pay the swap's invoice once (shown when it was created)." : endedNote(x0.status, x0.id, x0.direction) };
  if (!x0.payoutArkAddress) return { id: x0.id, status: x0.status, claimFailed: true, note: "No Ark payout address on this swap; cannot claim. Do NOT pay again." };
  if (!x0.local) return { id: x0.id, status: x0.status, claimed: false, note: "This Mark home does not hold the swap's claim key: run the claim from the Mark home that created it. Do NOT pay again." };
  const r = await s.claim(x0.id, x0.payoutArkAddress);
  if (!r.success) return { id: x0.id, status: x0.status, claimFailed: true, claim: r, note: "Claim failed; retry later. Do NOT pay again." };
  return railSettled(s, x0.id, x0.status, r.txid ?? "", o.pollMs ?? 5000);
}

export async function railRefund(c: Ctx, x0: RailSwapInfo, to?: string) {
  notRail(x0);
  if (x0.direction === "lightning_to_arkade") throw new MarkError("USAGE", "only an Arkade-funded swap is refunded with mark swap refund; a Lightning hold invoice simply expires and your wallet gets the sats back");
  if (!to) throw new MarkError("USAGE", "mark swap refund <id> --to <ark address from an Arkade wallet on https://arkade.computer>");
  const dest = checkArkadeAddress(to, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, serverPubkey: (x0.raw as any)?.arkade_server_pk ?? null, what: "refund address" });
  const s = await rail(c);
  const r = await s.refund(x0.id, dest);
  return { id: x0.id, refunded: r.success, ...(r.txid ? { txid: r.txid } : {}), ...(r.message ? { message: r.message } : {}) };
}
