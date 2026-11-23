/** `mark swap` use-cases: BTC (Lightning or Arkade) -> USDC / USDT0 on Arbitrum through Satora. Standalone: no escrow server call,
 *  no deal. Non-custodial: the swap's claim/refund keys and preimage stay in this Mark home (encrypted swap storage). */
import { MarkError } from "../errors.js";
import { NETWORKS } from "../config.js";
import type { Ctx } from "./context.js";
import type { SwapProvider } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { decodeInvoice, networkOk } from "../lightning/invoice.js";
import type { StableSwapCreated, StableSwapInfo } from "../swap/provider.js";
import { SWAP_UNPAID, SWAP_PAID, SWAP_WAITING, SWAP_CLAIMABLE, SWAP_DONE } from "../swap/states.js";
import { sleep } from "../util.js";
import { reverse, reverseQuote, reverseRun, reverseStatus, reverseClaim, reverseRefund, reverseFund, reverseRecover } from "./swapReverse.js";
import { ARBISCAN_TX, SWAP_MARKUP_BPS, SWAP_REFERRAL_ID, SWAP_MAX_SLIPPAGE_BPS, SWAP_SOURCES, SWAP_TARGETS, checkEvmAddress, checkMarkupBps, formatSwapQuote, pct, swapSats, swapSource, swapTarget, units, swapRoute, allSwapRoutes, type SwapSource, type SwapTarget } from "../swap/stable.js";

/** sats: BTC -> stablecoin. amount (token units like 1.5) / invoice: stablecoin -> BTC (address is the payout target there). */
export interface SwapQuoteInput { from?: string; to?: string; sats?: number | string; amount?: string | number; invoice?: string; address?: string }
export interface SwapRunInput extends SwapQuoteInput { address?: string; confirm?: boolean; wait?: boolean; timeoutSec?: number; pollMs?: number; onProgress?: (x: unknown) => void }

/** Satora locks a BTC token and swaps it into the stablecoin on a DEX when it is claimed, so what arrives can differ from the amount
 *  Satora states at create (a live test: 3.03146 USDC expected, 3.022431 arrived). Mark reports that amount as expected only and
 *  reads what arrived from the payout tx. */
const EXPECTED_NOTE = "expectedReceive is Satora's estimate: the BTC is swapped into the stablecoin on a DEX at claim, so the amount that arrives can be a little different. After the payout, `received` is read from the payout transaction.";
const PAID_NOTE = "Your payment was seen: wait for Satora to fund its side, then claim. Do NOT pay again.";

function mainnetOnly(c: Ctx) {
  if (!NETWORKS[c.network].isMainnet) throw new MarkError("SWAP_UNSUPPORTED_NETWORK", "mark swap runs on bitcoin mainnet only: Satora has no Arbitrum stablecoin route on mutinynet. Use --network bitcoin: `mark swap quote` and a preview without --yes are free and create nothing.");
}
async function stable(c: Ctx): Promise<Required<Pick<SwapProvider, "quoteStable" | "createStable" | "getStable" | "claimStable">> & SwapProvider> {
  const s = await c.swaps();
  if (!s.quoteStable || !s.createStable || !s.getStable || !s.claimStable) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} does not support mark swap`);
  return s as any;
}
/** Which direction, with the inputs that belong to the other one refused (nothing is sent to Satora). */
function route(i: SwapQuoteInput) {
  const r = swapRoute(i.from, i.to);
  if (r.dir === "to_btc" && i.sats !== undefined) throw new MarkError("USAGE", "--sats is for swaps from BTC; from a stablecoin use --amount <tokens> (or --invoice for a Lightning payout)");
  if (r.dir === "to_stable") for (const k of ["amount", "invoice"] as const) if (i[k] !== undefined) throw new MarkError("USAGE", `--${k} is only for swaps from a stablecoin (--from usdc|usdt0)`);
  return r;
}
const revIn = (r: { from: any; to: any }, i: SwapQuoteInput) => ({ from: r.from, to: r.to, amount: i.amount, invoice: i.invoice, address: i.address });
function parse(i: SwapQuoteInput) { return { from: swapSource(i.from), to: swapTarget(i.to), sats: swapSats(i.sats), bps: checkMarkupBps(SWAP_MARKUP_BPS) }; }

/** Quote only (nothing is created): rate, Satora fee, our markup, network fee, total, what you receive. */
export async function swapQuote(c: Ctx, i: SwapQuoteInput) {
  mainnetOnly(c); const r = route(i); if (r.dir === "to_btc") return reverseQuote(c, revIn(r, i));
  const p = parse(i); const s = await stable(c);
  const q = await s.quoteStable(p);
  const out = formatSwapQuote(q, p);
  const inRange = p.sats >= q.min_amount && p.sats <= q.max_amount;
  return { quote: out, ...(inRange ? {} : { note: `amount out of range: Satora accepts ${q.min_amount}..${q.max_amount} sats for this pair` }),
    next: `${mk()} swap --from ${p.from} --to ${p.to} --sats ${p.sats} --address <your 0x address on Arbitrum> previews it; add --yes to create it` };
}

/** Amounts used only to ask Satora for each route's live min / max (a quote: nothing is created). */
const ROUTE_PROBE_SATS = 100_000;
const ROUTE_PROBE_TOKEN_UNITS = 10_000_000n; // 10 USDC / USDT0
/** Every route Mark supports (allSwapRoutes: SWAP_SOURCES x SWAP_TARGETS both ways), with Satora's live min / max in sats from a
 *  quote per route. Read-only: never creates a swap. A failed lookup (or a network without Satora routes) still lists the routes,
 *  with limits unavailable. */
export async function swapRoutes(c: Ctx) {
  const mainnet = NETWORKS[c.network].isMainnet; const bps = checkMarkupBps(SWAP_MARKUP_BPS);
  const pairs = allSwapRoutes();
  let s: SwapProvider | null = null; let why = mainnet ? "" : `mark swap runs on bitcoin mainnet only (this is ${c.network})`;
  if (mainnet) { try { s = await c.swaps(); } catch (e: any) { why = String(e?.message ?? e).slice(0, 200); } }
  const quote = (p: (typeof pairs)[number]): Promise<any> => {
    if (!s) return Promise.reject(new Error(why));
    if (p.dir === "to_stable") return s.quoteStable ? s.quoteStable({ from: p.from, to: p.to, sats: ROUTE_PROBE_SATS, bps }) : Promise.reject(new Error(`swap provider ${s.name} does not support mark swap`));
    return s.quoteReverse ? s.quoteReverse({ from: p.from, to: p.to, sourceUnits: ROUTE_PROBE_TOKEN_UNITS, bps }) : Promise.reject(new Error(`swap provider ${s.name} does not support mark swap from a stablecoin`));
  };
  const live = await Promise.allSettled(pairs.map(quote));
  const routes = pairs.map((p, i) => {
    const t = SWAP_TARGETS[p.dir === "to_stable" ? p.to : p.from]; const rail = p.dir === "to_stable" ? p.from : p.to;
    const r = live[i]; const q: any = r.status === "fulfilled" ? r.value : null;
    const ok = q && Number.isSafeInteger(q.min_amount) && Number.isSafeInteger(q.max_amount) && q.min_amount > 0 && q.max_amount >= q.min_amount;
    return { from: p.from, to: p.to, direction: p.dir === "to_stable" ? "btc_to_stablecoin" : "stablecoin_to_btc", ...(p.dir === "to_stable" ? { source: SWAP_SOURCES[rail].chain } : { target: SWAP_SOURCES[rail].chain }),
      token: t.symbol, chain: t.network, chainId: Number(t.chain), contract: t.tokenId,
      limits: ok ? { minSats: q.min_amount, maxSats: q.max_amount } : "unavailable",
      ...(ok ? {} : { limitsNote: `live limits unavailable: ${r.status === "rejected" ? String((r.reason as any)?.message ?? r.reason).slice(0, 200) : "Satora's quote had no valid min/max"}` }) };
  });
  return { routes, markup: { bps, percent: pct(bps), note: `Every swap includes a ${pct(bps)} Agent Escrow fee, on top of Satora's fee. Paid inside the swap; nothing extra to send.` },
    referral: SWAP_REFERRAL_ID, limitsSource: mainnet ? "Satora live quote (nothing is created)" : "none on this network",
    next: `${mk()} swap quote --from <from> --to <to> --sats N (from BTC) or --amount <tokens> (from a stablecoin) for a priced quote` };
}

function payInstructions(from: SwapSource, x: { id: string; invoice?: string; arkAddress?: string; payAmountSats: number }) {
  return from === "lightning"
    ? { invoice: x.invoice, howToPay: "Pay this Lightning invoice from any Lightning wallet, once. It is a hold invoice: it settles only when your stablecoins are claimed, else it expires and your wallet gets the sats back." }
    : { arkAddress: x.arkAddress, amountSats: x.payAmountSats, howToPay: `Send exactly amountSats to arkAddress in ONE payment from an Arkade wallet on https://arkade.computer (not Bark / Second). If the swap fails, refund it with ${mk()} swap refund ${x.id} --to <your ark address> after its timelock.` };
}

/** Preview (default) or create + run a swap. confirm: create it. wait: after payment, claim and wait for the payout tx. */
export async function swapRun(c: Ctx, i: SwapRunInput) {
  mainnetOnly(c); const r = route(i); if (r.dir === "to_btc") return reverseRun(c, { ...revIn(r, i), confirm: i.confirm, wait: i.wait, timeoutSec: i.timeoutSec, pollMs: i.pollMs, onProgress: i.onProgress });
  const p = parse(i); const address = checkEvmAddress(i.address); const t = SWAP_TARGETS[p.to]; const s = await stable(c);
  const q = await s.quoteStable(p);
  if (!/^\d+$/.test(String(q.net_target_amount ?? "")) || BigInt(q.net_target_amount) <= 0n) throw new MarkError("QUOTE_UNAVAILABLE", "Satora's quote has no payout amount; nothing was created. Retry later.");
  const quote = formatSwapQuote(q, p);
  if (p.sats < q.min_amount || p.sats > q.max_amount) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for ${p.from} -> ${t.symbol}`, { quote });
  if (!i.confirm) return { swap: "preview", quote, payoutAddress: address,
    notice: `REAL MONEY: this swaps ${p.sats} sats of bitcoin mainnet into about ${quote.receive} ${t.symbol} on Arbitrum, sent to ${address}. Check the address: a payout to a wrong address cannot be undone. ${quote.markupNote}`,
    next: `Nothing was created. To create it: ${mk()} swap --from ${p.from} --to ${p.to} --sats ${p.sats} --address ${address} --yes --wait` };
  const created = await s.createStable({ ...p, address });
  checkCreated(c, p, address, created, q.net_target_amount);
  const first = { swap: "created", id: created.id, status: created.status, from: p.from, to: p.to, payoutAddress: created.targetAddress, expectedReceive: units(created.receiveUnits, t.decimals), receiveNote: EXPECTED_NOTE, quote, ...payInstructions(p.from, created),
    next: i.wait && i.onProgress ? "Waiting for your payment, then Mark claims the stablecoins to your address." : `After paying, run: ${mk()} swap claim ${created.id} --wait  (claims as soon as Satora funds its side)` };
  if (!i.wait || !i.onProgress) return first; // waiting is only useful once the payer has seen the invoice / address
  i.onProgress?.(first);
  return { ...(await waitAndClaim(s, created.id, { timeoutSec: i.timeoutSec, pollMs: i.pollMs })), from: p.from, to: p.to, payoutAddress: created.targetAddress };
}

/** Before showing anything payable: the swap must pay out to the confirmed address, ask for exactly the requested sats, and carry a
 *  payable invoice (this network, that amount) or an Ark address for this network. Else SWAP_FAILED: do not pay (an unpaid swap
 *  simply expires). */
function checkCreated(c: Ctx, p: { from: SwapSource; to: SwapTarget; sats: number }, address: string, x: StableSwapCreated, quotedUnits: string) {
  const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `Satora's swap does not match what you confirmed (${why}). Do NOT pay it; nothing is lost while it is unpaid.`, { id: x?.id }); };
  const src = SWAP_SOURCES[p.from], tgt = SWAP_TARGETS[p.to];
  if (!x?.id) bad("no swap id");
  if (x.status !== "pending") bad(`status ${x.status}, not a new unpaid swap`);
  if (x.sourceChain !== src.chain) bad(`source ${x.sourceChain} is not ${src.chain}`);
  if (String(x.tokenContract ?? "").toLowerCase() !== tgt.tokenId.toLowerCase()) bad(`token ${x.tokenContract} is not ${tgt.symbol} (${tgt.tokenId})`);
  if (x.evmChainId !== Number(tgt.chain) || (x.targetChain !== undefined && x.targetChain !== tgt.chain)) bad(`chain ${x.evmChainId} (token chain ${x.targetChain}) is not ${tgt.network} (${tgt.chain})`);
  if (String(x.targetAddress ?? "").toLowerCase() !== address.toLowerCase()) bad(`payout address ${x.targetAddress} is not ${address}`);
  if (!Number.isSafeInteger(x.payAmountSats) || x.payAmountSats !== p.sats) bad(`amount ${x.payAmountSats} sats is not ${p.sats}`);
  // the stablecoin amount it promises: a whole positive number of token units, at most SWAP_MAX_SLIPPAGE_BPS below the quote shown
  if (!/^\d+$/.test(String(x.receiveUnits ?? "")) || BigInt(x.receiveUnits!) <= 0n) bad(`payout amount ${x.receiveUnits} is not a positive token amount`);
  if (!/^\d+$/.test(String(quotedUnits ?? "")) || BigInt(x.receiveUnits!) * 10000n < BigInt(quotedUnits) * BigInt(10000 - SWAP_MAX_SLIPPAGE_BPS))
    bad(`payout ${units(x.receiveUnits, tgt.decimals)} ${tgt.symbol} is more than ${pct(SWAP_MAX_SLIPPAGE_BPS)} below the quote (${units(quotedUnits, tgt.decimals)})`);
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
    if (SWAP_DONE.has(last)) return done(s, id, last, info.payoutTx ?? claim?.txHash, info);
    if (SWAP_CLAIMABLE.has(last) && !claim?.success) {
      claim = await s.claimStable(id);
      if (!claim.success) return { id, status: last, claimFailed: true, claim, note: `The swap is funded but the claim failed. Your payment is safe while status is ${last}: retry with ${mk()} swap claim ${id} (same Mark home). Do NOT pay again.` };
      if (claim.txHash) return settled(s, id, last, claim.txHash, poll);
    } else if (!SWAP_WAITING.has(last) && !SWAP_CLAIMABLE.has(last)) return { id, status: last, ended: true, note: endedNote(last, id, info.direction) };
    await sleep(poll);
  }
  return { id, status: last, timeout: true, note: `timeout at swap status ${last}. Run ${mk()} swap status ${id}; once it is serverfunded run ${mk()} swap claim ${id}. Do NOT pay again.` };
}
/** After a successful claim, re-read the swap a few times (short waits) so the output shows its final status (serverredeemed),
 *  not the claim-time one (serverfunded). Still in progress, or the read fails: the claim-time status. Never throws. */
const SETTLE_TRIES = 4;
async function settled(s: Awaited<ReturnType<typeof stable>>, id: string, status: string, tx: string | undefined, poll: number) {
  let last: StableSwapInfo | undefined;
  for (let i = 0; i < SETTLE_TRIES; i++) {
    if (i) await sleep(Math.min(poll, 2000));
    try { const x = await s.getStable(id); last = x; if (SWAP_DONE.has(x.status)) return done(s, id, x.status, tx ?? x.payoutTx, x); } catch { /* keep the claim-time status */ }
  }
  return done(s, id, status, tx, last ?? NO_REREAD);
}
const RECEIPT_TRIES = 3;
/** What actually arrived at the payout address in the payout tx (the token's Transfer logs). Never throws. */
async function arrived(s: SwapProvider, tx: string, token: string, to: string, decimals: number) {
  let u: bigint | undefined;
  for (let i = 0; i < RECEIPT_TRIES && u === undefined && s.evm?.transferredTo; i++) { // a fresh payout tx may not be indexed yet
    if (i) await sleep(1500);
    try { u = await s.evm.transferredTo(tx, token, to); } catch { u = undefined; }
  }
  return u === undefined ? { receivedNote: "the amount that arrived could not be read yet: see the explorer link or mark swap status" } : { received: units(u, decimals) ?? "0", receivedUnits: u.toString() };
}
/** settled() already tried reading the swap: done() must not read it again (a bounded number of reads). */
const NO_REREAD = { noReread: true } as const;
async function done(s: SwapProvider, id: string, status: string, tx?: string, x?: { targetAddress?: string; tokenContract?: string; noReread?: boolean }) {
  let got = {};
  if (tx) {
    let info = x; if (!info?.targetAddress && !info?.noReread) { try { info = await s.getStable!(id); } catch { info = undefined; } }
    const t = Object.values(SWAP_TARGETS).find((v) => v.tokenId.toLowerCase() === String(info?.tokenContract ?? "").toLowerCase());
    got = t && info?.targetAddress ? await arrived(s, tx, t.tokenId, info.targetAddress, t.decimals) : { receivedNote: "the amount that arrived could not be read: see the explorer link" };
  }
  return { id, status, swap: "done", ...(tx ? { payoutTx: tx, explorer: ARBISCAN_TX + tx } : {}), ...got, note: tx ? "Stablecoins sent to your address." : "Claimed; the payout tx id is not known yet: check mark swap status." };
}
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
  if (/^evm_to_/.test(x.direction ?? "")) { const r = await reverse(c); return reverseStatus(r, await r.getReverse(id)); }
  const t = Object.values(SWAP_TARGETS).find((v) => v.tokenId.toLowerCase() === (x.tokenContract ?? "").toLowerCase());
  const { raw: _raw, ...info } = x;
  const got = x.payoutTx && t && x.targetAddress ? await arrived(s, x.payoutTx, t.tokenId, x.targetAddress, t.decimals) : {};
  return { ...info, ...(t && x.targetUnits ? { expectedReceive: units(x.targetUnits, t.decimals), token: t.symbol } : {}), ...got,
    ...(x.payoutTx ? { explorer: ARBISCAN_TX + x.payoutTx } : {}),
    next: SWAP_CLAIMABLE.has(x.status) ? (x.local ? `Funded: claim it with ${mk()} swap claim ${id}` : "Funded, but this Mark home does not hold the swap's claim key: run the claim from the Mark home that created it. Do NOT pay again.")
      : SWAP_PAID.has(x.status) ? PAID_NOTE : SWAP_UNPAID.has(x.status) ? "Waiting for your payment." : SWAP_DONE.has(x.status) ? "Done." : endedNote(x.status, id, x.direction) };
}

/** Claim a funded swap to the address fixed at create (gasless). Safe to repeat. wait: first wait for the payment / funding. */
export async function swapClaim(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  if (!id) throw new MarkError("USAGE", "mark swap claim <id>");
  const s = await stable(c);
  if (o.wait) { // a read failure here must not stop the wait (waitAndClaim retries its reads)
    let d: string | undefined; try { d = (await s.getStable(id)).direction; } catch { d = undefined; }
    if (!/^evm_to_/.test(d ?? "")) return waitAndClaim(s, id, o);
  }
  const x = await s.getStable(id);
  if (/^evm_to_/.test(x.direction ?? "")) { const r = await reverse(c); return reverseClaim(r, await r.getReverse(id)); }
  if (SWAP_DONE.has(x.status)) return done(s, id, x.status, x.payoutTx, x);
  if (!SWAP_CLAIMABLE.has(x.status)) return { id, status: x.status, claimed: false, note: SWAP_PAID.has(x.status) ? `Nothing to claim yet. ${PAID_NOTE} (${mk()} swap claim ${id} --wait claims as soon as it is funded)`
    : SWAP_UNPAID.has(x.status) ? "Not paid yet: nothing to claim. Pay the swap's invoice / Ark address once (shown when it was created)." : endedNote(x.status, id, x.direction) };
  const r = await s.claimStable(id);
  if (!r.success) return { id, status: x.status, claimFailed: true, claim: r, note: "Claim failed; retry later. Do NOT pay again." };
  return settled(s, id, x.status, r.txHash, o.pollMs ?? 5000);
}

/** Refund an Arkade-funded swap that did not pay out (after its timelock) to an Ark address. Lightning swaps need no refund. */
export async function swapRefund(c: Ctx, id: string, to?: string) {
  if (!id) throw new MarkError("USAGE", "mark swap refund <id> --to <ark address from an Arkade wallet on https://arkade.computer>   (a swap from a stablecoin: mark swap refund <id>)");
  const s = await stable(c); const x = await s.getStable(id);
  if (/^evm_to_/.test(x.direction ?? "")) {
    if (to !== undefined) throw new MarkError("USAGE", `a swap from a stablecoin refunds to its deposit address: run ${mk()} swap refund ${id} (no --to), then ${mk()} swap recover ${id} --to <your 0x address>`);
    const r = await reverse(c); return reverseRefund(r, await r.getReverse(id));
  }
  if (!to) throw new MarkError("USAGE", "mark swap refund <id> --to <ark address from an Arkade wallet on https://arkade.computer>");
  if (x.direction && x.direction !== "arkade_to_evm") throw new MarkError("USAGE", "only an Arkade-funded swap is refunded with mark swap refund; a Lightning hold invoice simply expires and your wallet gets the sats back");
  // the refund address must be on the swap's Arkade server (its key is in the swap)
  const dest = checkArkadeAddress(to, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, serverPubkey: (x.raw as any)?.arkade_server_pk ?? null, what: "refund address" });
  const r = await s.refund(id, dest);
  return { id, refunded: r.success, ...(r.txid ? { txid: r.txid } : {}), ...(r.message ? { message: r.message } : {}) };
}


/** Swap from a stablecoin: lock the deposit into the swap (gasless, once). wait: wait for the deposit first, then the payout. */
export async function swapFund(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) { mainnetOnly(c); return reverseFund(c, id, o); }
/** Swap from a stablecoin: send the stablecoins at the deposit address to your own address (unfunded, failed or refunded swap). */
export async function swapRecover(c: Ctx, id: string, to?: string) { mainnetOnly(c); return reverseRecover(c, id, to); }
