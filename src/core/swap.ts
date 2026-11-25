/** `mark swap` use-cases: BTC (Lightning or Arkade) -> USDC / USDT0 on Arbitrum One or USDC on Base through Satora. Standalone: no escrow server call,
 *  no deal. Non-custodial: the swap's claim/refund keys and preimage stay in this Mark home (encrypted swap storage). */
import { MarkError } from "../errors.js";
import { NETWORKS } from "../config.js";
import type { Ctx } from "./context.js";
import type { SwapProvider } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { decodeInvoice, networkOk } from "../lightning/invoice.js";
import type { StableSwapCreated, StableSwapInfo } from "../swap/provider.js";
import { SWAP_UNPAID, SWAP_PAID, SWAP_WAITING, SWAP_CLAIMABLE, SWAP_DONE, isReverseDir, isRailDir } from "../swap/states.js";
import { sleep } from "../util.js";
import { reverse, loadReverse, waitReverse, reverseQuote, reverseRun, reverseStatus, reverseClaim, reverseRefund, reverseFund, reverseRecover } from "./swapReverse.js";
import { loadRail, railQuote, railRun, railStatus, railClaim, railRefund } from "./swapRail.js";
import { ARBISCAN_TX, STABLE_FLAGS, sameHex, txLink, SWAP_MARKUP_BPS, SWAP_REFERRAL_ID, SWAP_MAX_SLIPPAGE_BPS, SWAP_SOURCES, SWAP_TARGETS, checkEvmAddress, checkMarkupBps, formatSwapQuote, pct, swapFeeRates, swapFeeSummaryNote, swapSats, swapSource, swapTarget, units, swapRoute, allSwapRoutes, targetOfSwap, tokenLabel, bridgeFeeUnits, type StableToken, type SwapSource, type SwapTarget } from "../swap/stable.js";

/** sats: BTC -> stablecoin. amount (token units like 1.5) / invoice: stablecoin -> BTC (address is the payout target there). */
export interface SwapQuoteInput { from?: string; to?: string; sats?: number | string; amount?: string | number; invoice?: string; address?: string }
export interface SwapRunInput extends SwapQuoteInput { address?: string; confirm?: boolean; wait?: boolean; timeoutSec?: number; pollMs?: number; onProgress?: (x: unknown) => void }

/** Satora locks a BTC token and swaps it into the stablecoin on a DEX when it is claimed, so what arrives can differ from the amount
 *  Satora states at create (a live test: 3.03146 USDC expected, 3.022431 arrived). Mark reports that amount as expected only and
 *  reads what arrived from the payout tx. */
const EXPECTED_NOTE = "expectedReceive is Satora's estimate: the BTC is swapped into the stablecoin on a DEX at claim, so the amount that arrives can be a little different. After the payout, `received` is read from the payout transaction.";
const PAID_NOTE = "Your payment was seen: wait for Satora to fund its side, then claim. Do NOT pay again.";

function mainnetOnly(c: Ctx) {
  if (!NETWORKS[c.network].isMainnet) throw new MarkError("SWAP_UNSUPPORTED_NETWORK", "mark swap runs on bitcoin mainnet only: Satora has no working swap path on mutinynet (no stablecoin route and no Lightning ↔ Arkade route). Use --network bitcoin: `mark swap quote` and a preview without --yes are free and create nothing.");
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
  if (r.dir === "to_stable") for (const k of ["amount", "invoice"] as const) if (i[k] !== undefined) throw new MarkError("USAGE", `--${k} is only for swaps from a stablecoin (--from ${STABLE_FLAGS})`);
  if (r.dir === "rail" && i.amount !== undefined) throw new MarkError("USAGE", `--amount is only for swaps from a stablecoin (--from ${STABLE_FLAGS})`);
  return r;
}
const revIn = (r: { from: any; to: any }, i: SwapQuoteInput) => ({ from: r.from, to: r.to, amount: i.amount, invoice: i.invoice, address: i.address });
function parse(i: SwapQuoteInput) { return { from: swapSource(i.from), to: swapTarget(i.to), sats: swapSats(i.sats), bps: checkMarkupBps(SWAP_MARKUP_BPS) }; }

/** Quote only (nothing is created): rate, Satora fee, our markup, network fee, total, what you receive. */
export async function swapQuote(c: Ctx, i: SwapQuoteInput) {
  mainnetOnly(c); const r = route(i); if (r.dir === "to_btc") return reverseQuote(c, revIn(r, i));
  if (r.dir === "rail") return railQuote(c, { from: r.from, to: r.to, sats: i.sats, invoice: i.invoice, address: i.address });
  const p = parse(i); const s = await stable(c);
  const q = await s.quoteStable(p);
  const out = formatSwapQuote(q, p);
  const inRange = p.sats >= q.min_amount && p.sats <= q.max_amount;
  return { quote: out, ...(inRange ? {} : { note: `amount out of range: Satora accepts ${q.min_amount}..${q.max_amount} sats for this pair` }),
    next: `${mk()} swap --from ${p.from} --to ${p.to} --sats ${p.sats} --address <your 0x address on ${SWAP_TARGETS[p.to].network}> previews it; add --yes to create it` };
}

/** Amounts used only to ask Satora for each route's live min / max (a quote: nothing is created). */
const ROUTE_PROBE_SATS = 100_000;
const ROUTE_PROBE_TOKEN_UNITS = 10_000_000n; // 10 USDC / USDT0
/** Every route Mark supports (BTC ↔ stablecoin, then Lightning ↔ Arkade), with Satora's live min / max in sats from a
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
    if (p.dir === "rail") return s.quoteRail ? s.quoteRail({ from: p.from, to: p.to, sats: ROUTE_PROBE_SATS, bps }) : Promise.reject(new Error(`swap provider ${s.name} does not support Lightning ↔ Arkade swaps`));
    return s.quoteReverse ? s.quoteReverse({ from: p.from, to: p.to, sourceUnits: ROUTE_PROBE_TOKEN_UNITS, bps }) : Promise.reject(new Error(`swap provider ${s.name} does not support mark swap from a stablecoin`));
  };
  const live = await Promise.allSettled(pairs.map(quote));
  const routes = pairs.map((p, i) => {
    const r = live[i]; const q: any = r.status === "fulfilled" ? r.value : null;
    const ok = q && Number.isSafeInteger(q.min_amount) && Number.isSafeInteger(q.max_amount) && q.min_amount > 0 && q.max_amount >= q.min_amount;
    const fees = q ? swapFeeRates(q, bps) : null;
    const fail = ok ? {} : { limitsNote: `live limits unavailable: ${r.status === "rejected" ? String((r.reason as any)?.message ?? r.reason).slice(0, 200) : "Satora's quote had no valid min/max"}` };
    if (p.dir === "rail") return { from: p.from, to: p.to, direction: p.from === "lightning" ? "lightning_to_arkade" : "arkade_to_lightning", source: SWAP_SOURCES[p.from].chain, target: SWAP_SOURCES[p.to].chain,
      limits: ok ? { minSats: q.min_amount, maxSats: q.max_amount } : "unavailable", ...(fees ? { fees } : {}), ...fail };
    const t = SWAP_TARGETS[p.dir === "to_stable" ? p.to : p.from]; const rail = p.dir === "to_stable" ? p.from : p.to;
    return { from: p.from, to: p.to, direction: p.dir === "to_stable" ? "btc_to_stablecoin" : "stablecoin_to_btc", ...(p.dir === "to_stable" ? { source: SWAP_SOURCES[rail].chain } : { target: SWAP_SOURCES[rail].chain }),
      token: t.symbol, chain: t.network, chainId: Number(t.chain), contract: t.tokenId,
      ...(t.bridge ? { bridge: { via: t.bridge.via, from: t.bridge.settleNetwork, note: `Satora settles on ${t.bridge.settleNetwork}; the payout is bridged to ${t.network} at claim (bridge fee in the quote)` } } : {}),
      limits: ok ? { minSats: q.min_amount, maxSats: q.max_amount } : "unavailable",
      ...(fees ? { fees } : {}), ...fail };
  });
  // a single live rate is used in the summary only when every listed route returned a quote and they all agreed
  const rates = routes.map((x) => x.fees).filter((f): f is NonNullable<typeof f> => !!f);
  const key = (f: (typeof rates)[number]) => `${f.satoraFeeRate}:${f.totalFeeRate}`;
  const agreed = rates.length === routes.length && rates.every((f) => key(f) === key(rates[0])) ? rates[0] : null;
  return { routes, markup: { bps, percent: pct(bps), note: swapFeeSummaryNote(agreed ? { satoraFeeRate: agreed.satoraFeeRate, totalFeeRate: agreed.totalFeeRate, markupBps: bps } : null) },
    referral: SWAP_REFERRAL_ID, limitsSource: mainnet ? "Satora live quote (nothing is created)" : "none on this network",
    next: `${mk()} swap quote --from <from> --to <to> --sats N (from BTC, or Lightning ↔ Arkade) or --amount <tokens> / --invoice (from a stablecoin) for a priced quote` };
}

function payInstructions(from: SwapSource, x: { id: string; invoice?: string; arkAddress?: string; payAmountSats: number }) {
  return from === "lightning"
    ? { invoice: x.invoice, howToPay: "Pay this Lightning invoice from any Lightning wallet, once. It is a hold invoice: it settles only when your stablecoins are claimed, else it expires and your wallet gets the sats back." }
    : { arkAddress: x.arkAddress, amountSats: x.payAmountSats, howToPay: `Send exactly amountSats to arkAddress in ONE payment from an Arkade wallet on https://arkade.computer (not Bark / Second). If the swap fails, refund it with ${mk()} swap refund ${x.id} --to <your ark address> after its timelock.` };
}

/** Preview (default) or create + run a swap. confirm: create it. wait: after payment, claim and wait for the payout tx. */
export async function swapRun(c: Ctx, i: SwapRunInput) {
  mainnetOnly(c); const r = route(i); if (r.dir === "to_btc") return reverseRun(c, { ...revIn(r, i), confirm: i.confirm, wait: i.wait, timeoutSec: i.timeoutSec, pollMs: i.pollMs, onProgress: i.onProgress });
  if (r.dir === "rail") return railRun(c, { from: r.from, to: r.to, sats: i.sats, invoice: i.invoice, address: i.address, confirm: i.confirm, wait: i.wait, timeoutSec: i.timeoutSec, pollMs: i.pollMs, onProgress: i.onProgress });
  const p = parse(i); const t = SWAP_TARGETS[p.to]; const address = checkEvmAddress(i.address, "--address", t.network); const s = await stable(c);
  const q = await s.quoteStable(p);
  if (!/^\d+$/.test(String(q.net_target_amount ?? "")) || BigInt(q.net_target_amount) <= 0n) throw new MarkError("QUOTE_UNAVAILABLE", "Satora's quote has no payout amount; nothing was created. Retry later.");
  // a bridged payout must show its bridge fee before anything is created (full fee disclosure)
  if (t.bridge && bridgeFeeUnits(q) === undefined) throw new MarkError("QUOTE_UNAVAILABLE", `Satora's quote has no ${t.bridge.via} bridge fee for ${tokenLabel(t)}; nothing was created. Retry later.`);
  const quote = formatSwapQuote(q, p);
  if (p.sats < q.min_amount || p.sats > q.max_amount) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for ${p.from} -> ${tokenLabel(t)}`, { quote });
  if (!i.confirm) return { swap: "preview", quote, payoutAddress: address,
    notice: `REAL MONEY: this swaps ${p.sats} sats of bitcoin mainnet into about ${quote.receive} ${tokenLabel(t)}, sent to ${address}${t.bridge ? ` (settled on ${t.bridge.settleNetwork}, then bridged to ${t.network} over ${t.bridge.via}: the same address receives it on ${t.network})` : ""}. Check the address: a payout to a wrong address cannot be undone. ${quote.markupNote}`,
    next: `Nothing was created. To create it: ${mk()} swap --from ${p.from} --to ${p.to} --sats ${p.sats} --address ${address} --yes --wait` };
  const created = await s.createStable({ ...p, address });
  checkCreated(c, p, address, created, q.net_target_amount);
  // bridged: Satora's create amount may be before the bridge fee; expect no more than the quote's net (after the fee)
  const expectUnits = t.bridge && BigInt(q.net_target_amount) < BigInt(created.receiveUnits!) ? q.net_target_amount : created.receiveUnits;
  const first = { swap: "created", id: created.id, status: created.status, from: p.from, to: p.to, payoutAddress: created.targetAddress, payoutNetwork: t.network, expectedReceive: units(expectUnits, t.decimals), receiveNote: EXPECTED_NOTE, quote, ...payInstructions(p.from, created),
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
  // a bridged payout (USDC on Base) settles in the Arbitrum token on Arbitrum One, and must name exactly that bridge and destination token
  const settleToken = tgt.bridge?.settleToken ?? tgt.tokenId, settleChain = tgt.bridge?.settleChain ?? tgt.chain;
  if (!x?.id) bad("no swap id");
  if (x.status !== "pending") bad(`status ${x.status}, not a new unpaid swap`);
  if (x.sourceChain !== src.chain) bad(`source ${x.sourceChain} is not ${src.chain}`);
  if (!sameHex(x.tokenContract, settleToken)) bad(`token ${x.tokenContract} is not ${tgt.symbol} (${settleToken})`);
  if (x.evmChainId !== Number(settleChain) || (x.targetChain !== undefined && x.targetChain !== settleChain)) bad(`chain ${x.evmChainId} (token chain ${x.targetChain}) is not ${settleChain}`);
  if (tgt.bridge) {
    if (x.bridgeTargetChain !== tgt.bridge.name || !sameHex(x.bridgeTargetToken, tgt.tokenId)) bad(`bridge ${x.bridgeTargetChain ?? "none"} / ${x.bridgeTargetToken ?? "no token"} is not ${tokenLabel(tgt)} (${tgt.tokenId})`);
  } else if (x.bridgeTargetChain) bad(`it bridges to ${x.bridgeTargetChain}, but you asked for ${tokenLabel(tgt)}`);
  if (!sameHex(x.targetAddress, address)) bad(`payout address ${x.targetAddress} is not ${address}`);
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

/** first: a read swapClaim just made, used for the first round instead of reading the swap again. */
async function waitAndClaim(s: Awaited<ReturnType<typeof stable>>, id: string, o: { timeoutSec?: number; pollMs?: number }, first?: StableSwapInfo) {
  const end = Date.now() + (o.timeoutSec ?? 900) * 1000; const poll = o.pollMs ?? 5000; let last = "unknown"; let claim: any; let pre = first;
  while (Date.now() < end) {
    let info; if (pre) { info = pre; pre = undefined; } else { try { info = await s.getStable(id); } catch { await sleep(poll); continue; } }
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
  let u: bigint | undefined | null;
  for (let i = 0; i < RECEIPT_TRIES && u === undefined && s.evm?.transferredTo; i++) { // a fresh payout tx may not be indexed yet
    if (i) await sleep(1500);
    try { u = await s.evm.transferredTo(tx, token, to); } catch { u = undefined; }
  }
  if (u === null) return { reverted: true, receivedNote: "the payout transaction failed on-chain: nothing arrived from it. Check mark swap status and the explorer link." };
  return u === undefined ? { receivedNote: "the amount that arrived could not be read yet: see the explorer link or mark swap status" } : { received: units(u, decimals) ?? "0", receivedUnits: u.toString() };
}
/** A bridged payout's claim on Arbitrum One: only whether it reverted (its token transfer goes to the bridge, not the payout
 *  address, so no amount is read from it). Never throws. */
async function bridgedClaimState(s: SwapProvider, tx: string, settleToken: string, to: string): Promise<"reverted" | "mined" | "unknown"> {
  for (let i = 0; i < RECEIPT_TRIES && s.evm?.transferredTo; i++) {
    if (i) await sleep(1500);
    try { const u = await s.evm.transferredTo(tx, settleToken, to); if (u === null) return "reverted"; if (u !== undefined) return "mined"; } catch { /* retry */ }
  }
  return "unknown";
}
/** settled() already tried reading the swap: done() must not read it again (a bounded number of reads). */
const NO_REREAD = { noReread: true } as const;
type DoneInfo = { targetAddress?: string; targetUnits?: string; tokenContract?: string; bridgeTargetChain?: string; bridgeTargetToken?: string; bridgeTx?: string; noReread?: boolean };
/** A bridged payout (USDC on Base): the payout tx is the claim on Arbitrum One that hands the USDC to the bridge; it arrives on the
 *  bridge chain in a separate delivery (bridgeTx once Satora reports it). Mark does not read that chain: it links the address. */
function bridgeInfo(t: StableToken, x: DoneInfo) {
  const bridged = /^\d+$/.test(String(x.targetUnits ?? "")) ? units(x.targetUnits, t.decimals) : undefined;
  return { bridge: { to: t.network, via: t.bridge!.via, ...(x.bridgeTx ? { deliveryTx: x.bridgeTx, deliveryExplorer: t.explorerTx + x.bridgeTx } : {}),
    ...(x.targetAddress ? { payoutAddressExplorer: t.explorerAddress + x.targetAddress } : {}),
    ...(bridged !== undefined ? { bridgedAmount: bridged } : {}),
    note: `payoutTx is the claim on ${t.bridge!.settleNetwork} that hands the ${t.symbol} to ${t.bridge!.via}; it arrives at the payout address on ${t.network} shortly after (usually within a few minutes).${bridged !== undefined ? ` bridgedAmount (and targetUnits) is what leaves ${t.bridge!.settleNetwork}: ${t.bridge!.via}'s bridge fee comes out of it, so a little less arrives on ${t.network} (the quote's receive is after that fee).` : ""} Check it with the ${t.network} explorer link. Do NOT pay again.` } };
}
async function done(s: SwapProvider, id: string, status: string, tx?: string, x?: DoneInfo) {
  let got: { reverted?: boolean; receivedUnits?: string; receivedNote?: string } = {};
  let info = x;
  if (tx && !info?.targetAddress && !info?.noReread) { try { info = await s.getStable!(id); } catch { info = undefined; } }
  const t: StableToken | undefined = info ? targetOfSwap(info) : undefined;
  if (t?.bridge && info) {
    if (!tx) return { id, status, swap: "done", ...bridgeInfo(t, info), note: `Claimed; the payout tx id is not known yet: check ${mk()} swap status ${id}. It is bridged to ${t.network} over ${t.bridge.via} after the claim.` };
    const state = await bridgedClaimState(s, tx, t.bridge.settleToken, info.targetAddress ?? "");
    if (state === "reverted") return { id, status, swap: "done", ...txLink(tx, "payoutTx"), reverted: true, payoutFailed: true,
      note: `The payout transaction reverted on ${t.bridge.settleNetwork}: nothing was bridged from it. Check mark swap status.` };
    return { id, status, swap: "done", ...txLink(tx, "payoutTx"), ...bridgeInfo(t, info),
      ...(state === "unknown" ? { receivedNote: "the claim transaction's receipt could not be read yet: check the explorer link before relying on the payout" } : {}),
      note: state === "unknown" ? `Satora reports the claim sent; its receipt could not be read yet. Once it is mined, the ${t.symbol} is bridged to ${t.network} over ${t.bridge.via}.` : `Stablecoins sent: bridging to ${t.network} over ${t.bridge.via}.` };
  }
  if (tx) got = t && info?.targetAddress ? await arrived(s, tx, t.tokenId, info.targetAddress, t.decimals) : { receivedNote: "the amount that arrived could not be read: see the explorer link" };
  return { id, status, swap: "done", ...txLink(tx, "payoutTx"), ...got, ...(got.reverted || got.receivedUnits === "0" ? { payoutFailed: true } : {}), note: got.reverted ? "The payout transaction reverted: nothing was sent from it. Check mark swap status."
    : got.receivedUnits === "0" ? "The payout transaction moved none of the token to your address: inspect it with the explorer link and mark swap status."
    : got.receivedNote ? "Satora reports the payout sent; the amount that arrived could not be read yet (explorer link)."
    : tx ? "Stablecoins sent to your address." : "Claimed; the payout tx id is not known yet: check mark swap status." };
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
  if (isReverseDir(x.direction)) { const [r, y] = await loadReverse(c, id); return reverseStatus(r, y); }
  if (isRailDir(x.direction)) { const [r, y] = await loadRail(c, id); return railStatus(r, y); }
  const t = targetOfSwap(x);
  const { raw: _raw, ...info } = x;
  const got: Record<string, unknown> = x.payoutTx && t && !t.bridge && x.targetAddress ? await arrived(s, x.payoutTx, t.tokenId, x.targetAddress, t.decimals) : {};
  const bridgedState = x.payoutTx && t?.bridge ? await bridgedClaimState(s, x.payoutTx, t.bridge.settleToken, x.targetAddress ?? "") : undefined;
  if (bridgedState === "reverted") Object.assign(got, { reverted: true, payoutFailed: true, receivedNote: `the payout transaction reverted on ${t!.bridge!.settleNetwork}: nothing was bridged from it` });
  else if (bridgedState === "unknown") got.receivedNote = "the claim transaction's receipt could not be read yet: check the explorer link";
  return { ...info, ...(t ? { token: t.symbol, payoutNetwork: t.network } : {}), ...(t && x.targetUnits && !t.bridge ? { expectedReceive: units(x.targetUnits, t.decimals) } : {}), ...got,
    ...(x.payoutTx ? { explorer: ARBISCAN_TX + x.payoutTx } : {}), ...(t?.bridge && bridgedState !== "reverted" ? bridgeInfo(t, x) : t?.bridge ? {} : x.bridgeTargetChain ? { bridge: { to: x.bridgeTargetChain, note: "bridged to a chain Mark does not list: check the payout on that chain" } } : {}),
    next: SWAP_CLAIMABLE.has(x.status) ? (x.local ? `Funded: claim it with ${mk()} swap claim ${id}` : "Funded, but this Mark home does not hold the swap's claim key: run the claim from the Mark home that created it. Do NOT pay again.")
      : SWAP_PAID.has(x.status) ? PAID_NOTE : SWAP_UNPAID.has(x.status) ? "Waiting for your payment." : SWAP_DONE.has(x.status) ? "Done." : endedNote(x.status, id, x.direction) };
}

/** Claim a funded swap to the address fixed at create (gasless). Safe to repeat. wait: first wait for the payment / funding. */
export async function swapClaim(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  if (!id) throw new MarkError("USAGE", "mark swap claim <id>");
  const s = await stable(c);
  // which direction decides the claim path: a few reads, never a guess (a failed read must not pick the forward claim)
  let x: StableSwapInfo | undefined; let err: unknown;
  for (let i = 0; i < 3 && !x; i++) { if (i) await sleep(Math.min(o.pollMs ?? 2000, 2000)); try { x = await s.getStable(id); } catch (e) { err = e; } }
  if (!x) throw err;
  if (isReverseDir(x.direction)) {
    if (o.wait) return waitReverse(await reverse(c), id, { timeoutSec: o.timeoutSec ?? 900, pollMs: o.pollMs, noFund: true });
    const [r, y] = await loadReverse(c, id); return reverseClaim(r, y);
  }
  if (isRailDir(x.direction)) { const [r, y] = await loadRail(c, id); return railClaim(r, y, o); }
  if (o.wait) return waitAndClaim(s, id, o, x);
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
  if (isReverseDir(x.direction)) {
    if (to !== undefined) throw new MarkError("USAGE", `a swap from a stablecoin refunds to its deposit address: run ${mk()} swap refund ${id} (no --to), then ${mk()} swap recover ${id} --to <your 0x address>`);
    const [r, y] = await loadReverse(c, id); return reverseRefund(r, y);
  }
  if (isRailDir(x.direction)) { const [, y] = await loadRail(c, id); return railRefund(c, y, to); }
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
