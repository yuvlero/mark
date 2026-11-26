/** `mark swap` from a stablecoin: USDC / USDT0 on Arbitrum One or USDC on Base -> BTC over Lightning (a BOLT11 invoice) or to
 *  an Ark address, through Satora. The stablecoins go to this Mark home's deposit address (its own EVM key, kept in the encrypted
 *  swap storage); Mark then locks them into the swap. Arbitrum One: gasless (no wallet, no ETH). USDC on Base: Mark signs a USDC
 *  approve and a Circle CCTP burn on Base from the deposit address, which pays that gas in ETH on Base (checked before anything is
 *  signed); Circle's mint and the lock are sponsored. */
import { MarkError } from "../errors.js";
import type { Ctx } from "./context.js";
import type { ReverseSwapCreated, ReverseSwapInfo, SwapProvider } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { decodeInvoice, networkOk } from "../lightning/invoice.js";
import { SWAP_CLAIMABLE, SWAP_DONE, SWAP_FAILED, SWAP_PAID, isReverseDir, reverseDir } from "../swap/states.js";
import { pinMismatch } from "../swap/reversePin.js";
import { sleep } from "../util.js";
import { ARBISCAN_TX, SWAP_MARKUP_BPS, sameHex, stableOfReverse, txLink, SWAP_MAX_SLIPPAGE_BPS, SWAP_SOURCES, SWAP_TARGETS, checkEvmAddress, checkMarkupBps,
  formatReverseQuote, pct, tokenUnits, units, ethText, bridgeFeeUnits, needBridgeFee, tokenLabel, BRIDGE_IN_TX_NAMES, SWEEP_TX, type GasEstimate, type StableToken, type SwapRail, type SwapStable } from "../swap/stable.js";
import { gasNeedWei, type EvmReader } from "../swap/evm.js";

export interface ReverseInput { from: SwapStable; to: SwapRail; amount?: string | number; invoice?: string; address?: string }
/** What mark swap from a stablecoin needs from the swap provider. */
const REV_KEYS = ["quoteReverse", "createReverse", "getReverse", "depositAddress", "openReverse", "fundReverse", "fundAttemptedAt", "refundReverse",
  "recoverReverse", "evm", "claim", "exclusive", "pinReverse", "reversePin", "invoiceUsedBy", "fundAttemptsSince"] as const;
export type Rev = Required<Pick<SwapProvider, typeof REV_KEYS[number]>> & SwapProvider;

export async function reverse(c: Ctx): Promise<Rev> {
  const s = await c.swaps();
  for (const k of REV_KEYS) if (!(s as any)[k]) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} does not support mark swap from a stablecoin`);
  return s as Rev;
}

/** The reader for the chain the stablecoin is deposited on (Base for USDC on Base, else Arbitrum One). */
export function readerOf(s: Rev, t: StableToken): EvmReader {
  if (!t.bridge) return s.evm;
  if (!s.evmOn) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} cannot read ${t.network}`);
  return s.evmOn(Number(t.chain));
}
/** ETH the deposit address needs on the bridge chain for the approve + burn (with headroom), and a USD hint; null when unreadable. */
export async function gasOf(s: Rev, t: StableToken): Promise<GasEstimate | null> {
  if (!t.bridge) return null;
  try { const [wei, usd] = await Promise.all([gasNeedWei(readerOf(s, t)), s.ethUsd?.().catch(() => undefined)]); return { network: t.network, txs: BRIDGE_IN_TX_NAMES, wei, usdPerEth: usd }; }
  catch { return null; }
}
/** How the deposit address pays the bridge-chain gas, for deposit instructions (empty for a gasless token). */
const gasHow = (t: StableToken, dep: string | undefined, g: GasEstimate | null) => !t.bridge ? "" :
  ` Also keep at least ${g ? ethText(g.wei) : "0.0001"} ETH on ${t.network} at ${dep} for gas (Mark signs ${BRIDGE_IN_TX_NAMES} on ${t.network} from it; usually well under 0.0001 ETH; send ETH once, it stays there for later swaps).`;
/** The clear error when the deposit address lacks ETH on the bridge chain: how much is needed, how much it holds, what to send. */
function needGas(id: string, t: StableToken, dep: string, needWei: bigint, holdsWei: bigint): never {
  throw new MarkError("SWAP_NEEDS_GAS", `the deposit address ${dep} needs ${ethText(needWei)} ETH on ${t.network} for gas (${BRIDGE_IN_TX_NAMES}, with headroom) and holds ${ethText(holdsWei)} ETH. Send at least ${ethText(needWei - holdsWei)} ETH on ${t.network} (not another chain) to ${dep}, then run ${mk()} swap fund ${id}. Nothing was signed; the ${t.symbol} stays at the deposit address. ${DO_NOT_RESEND}`,
    { id, depositAddress: dep, network: t.network, needEth: ethText(needWei), holdsEth: ethText(holdsWei), sendEth: ethText(needWei - holdsWei) });
}

/** The provider and a fresh read of swap `id`. */
export async function loadReverse(c: Ctx, id: string) { const r = await reverse(c); return [r, await r.getReverse(id)] as const; }

const RECOVER_AFTER_FUND_MS = 30 * 60 * 1000;
const DO_NOT_RESEND = "Do NOT send the stablecoins again.";

/** The payout target and amount, checked before anything is sent to Satora:
 *  --to lightning: --invoice <bolt11> (its amount is the payout; Satora must pay exactly that invoice);
 *  --to arkade: --address <ark address on Satora's Arkade server> --amount <tokens>.
 *  A quote may leave the target out and give only --amount. Lightning addresses are not taken: Satora would fetch their invoice
 *  itself, and Mark could not tell that invoice from anyone else's for the same amount. */
export function parseReverse(c: Ctx, i: ReverseInput, mode: "quote" | "create" = "create") {
  const bps = checkMarkupBps(SWAP_MARKUP_BPS); const t = SWAP_TARGETS[i.from];
  if (i.to === "lightning") {
    if (i.address !== undefined) throw new MarkError("USAGE", "--to lightning takes --invoice <bolt11 with an amount> (a Lightning address is not supported: Mark cannot check the invoice Satora would fetch for it)");
    if (i.invoice !== undefined) {
      if (i.amount !== undefined) throw new MarkError("USAGE", "--invoice fixes the payout: do not add --amount");
      const inv = String(i.invoice).trim().replace(/^lightning:/i, "");
      if (!networkOk(inv, c.network)) throw new MarkError("BAD_INVOICE", `--invoice is not a Lightning invoice for ${c.network}`);
      const d = decodeInvoice(inv);
      if (!d.sats || !Number.isSafeInteger(d.sats)) throw new MarkError("AMOUNTLESS_INVOICE_UNSUPPORTED", "--invoice needs an amount in whole sats (Satora pays out exactly the invoice)");
      if (d.expiresAt - Date.now() / 1000 < 600) throw new MarkError("INVOICE_EXPIRED", "--invoice expires in under 10 minutes: make a new one");
      return { from: i.from, to: i.to, bps, invoice: inv, invoiceSats: d.sats, token: t };
    }
    if (mode === "create") throw new MarkError("USAGE", "--to lightning needs --invoice <bolt11 with an amount>");
    return { from: i.from, to: i.to, bps, sourceUnits: tokenUnits(i.amount, t.decimals), token: t };
  }
  if (i.invoice !== undefined) throw new MarkError("USAGE", "--invoice is only for --to lightning");
  const sourceUnits = tokenUnits(i.amount, t.decimals);
  if (i.address === undefined) {
    if (mode === "create") throw new MarkError("USAGE", "--to arkade needs --address <ark address from an Arkade wallet on https://arkade.computer> --amount <tokens>");
    return { from: i.from, to: i.to, bps, sourceUnits, token: t };
  }
  const arkAddress = checkArkadeAddress(i.address, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, what: "--address" });
  return { from: i.from, to: i.to, bps, arkAddress, sourceUnits, token: t };
}
export type Parsed = ReturnType<typeof parseReverse>;
const target = (p: Parsed) => p.invoice ? { invoice: p.invoice } : { arkAddress: p.arkAddress };
/** The create command for this input; a target the quote left out is a placeholder. */
const flags = (p: Parsed) => `--from ${p.from} --to ${p.to} ${p.invoice ? `--invoice ${p.invoice}` : p.to === "lightning" ? "--invoice <bolt11 for the sats you want>" : `--address ${p.arkAddress ?? "<ark address>"} --amount ${units(p.sourceUnits!, p.token.decimals)}`}`;

async function quoteOf(s: Rev, p: Parsed) {
  const q = await s.quoteReverse({ from: p.from, to: p.to, bps: p.bps, ...(p.invoice ? { targetSats: p.invoiceSats, destination: p.invoice } : { sourceUnits: p.sourceUnits }) });
  if (!/^\d+$/.test(String(q?.source_amount ?? "")) || BigInt(q.source_amount) <= 0n || !(Number(q?.net_target_amount) > 0))
    throw new MarkError("QUOTE_UNAVAILABLE", "Satora's quote has no amounts; nothing was created. Retry later.");
  return q;
}
export function inRange(q: any) { const gross = Number(q.target_amount); return !(Number.isSafeInteger(q.min_amount) && Number.isSafeInteger(q.max_amount)) || (gross >= q.min_amount && gross <= q.max_amount); }

/** Quote only (nothing is created). */
export async function reverseQuote(c: Ctx, i: ReverseInput) {
  const p = parseReverse(c, i, "quote"); const s = await reverse(c); const [q, gas] = await Promise.all([quoteOf(s, p), gasOf(s, p.token)]);
  needBridgeFee(p.token, q);
  return { quote: formatReverseQuote(q, { ...p, gas }), ...(inRange(q) ? {} : { note: `amount out of range: Satora accepts ${q.min_amount}..${q.max_amount} sats for this route` }),
    next: `${mk()} swap ${flags(p)} previews it; add --yes to create it` };
}

export interface ReverseRunInput extends ReverseInput { confirm?: boolean; wait?: boolean; timeoutSec?: number; pollMs?: number; onProgress?: (x: unknown) => void }

/** Preview (default) or create a swap from a stablecoin. confirm: create it and show where to deposit. wait: watch the deposit
 *  address, fund the swap once the deposit is there (gasless on Arbitrum One; approve + burn on Base, after the ETH check), and wait for the payout. */
export async function reverseRun(c: Ctx, i: ReverseRunInput) {
  const p = parseReverse(c, i); const s = await reverse(c);
  // a bridged deposit needs the deposit chain's reader and the burn record (resume, recover): refuse before anything is created
  if (p.token.bridge) { readerOf(s, p.token); if (!s.cctpBurn) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} cannot track a ${p.token.bridge.via} burn; not creating a swap from ${tokenLabel(p.token)}`); }
  const [q, gas] = await Promise.all([quoteOf(s, p), gasOf(s, p.token)]); const quote = formatReverseQuote(q, { ...p, gas });
  needBridgeFee(p.token, q);
  if (!inRange(q)) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for ${p.token.symbol} -> ${p.to}`, { quote });
  const payout = p.invoice ? `the Lightning invoice you gave (${p.invoiceSats} sats)` : `the Ark address ${p.arkAddress}`;
  if (!i.confirm) return { swap: "preview", quote, payout: target(p),
    notice: `REAL MONEY: this swaps about ${quote.send} ${p.token.symbol} on ${p.token.network} into ${quote.receiveSats} sats paid to ${payout}. Check the target: a payout to a wrong target cannot be undone. ${quote.markupNote}`,
    next: `Nothing was created. To create it: ${mk()} swap ${flags(p)} --yes --wait` };
  // one open deposit at a time: every swap from a stablecoin in this Mark home shares the same deposit address. The check and the
  // create run under the Mark home's deposit lock (other processes too), so two creates cannot both see "none open".
  const created = await createPinnedReverse(c, s, p, q);
  const deposit = await depositInfo(s, created, gas);
  const how = p.token.bridge ? `Mark signs ${BRIDGE_IN_TX_NAMES} on ${p.token.network}, gas paid in ETH on ${p.token.network} by the deposit address` : "gasless";
  const first = { swap: "created", id: created.id, status: created.status, from: p.from, to: p.to, payout: { ...target(p), sats: created.targetSats }, quote, deposit,
    next: i.wait && i.onProgress ? `Waiting for the deposit; then Mark funds the swap (${how}) and waits for the payout.` : `After the deposit, run: ${mk()} swap fund ${created.id} --wait  (Mark locks the deposit; ${p.token.bridge ? how : "no ETH needed"})` };
  if (!i.wait || !i.onProgress) return first; // waiting only helps once the depositor has seen the address
  i.onProgress(first);
  return { ...(await waitReverse(s, created.id, { timeoutSec: i.timeoutSec, pollMs: i.pollMs })), from: p.from, to: p.to };
}

/** Create the swap and pin what was confirmed, under the Mark home's deposit lock (one open deposit at a time; every swap from a
 *  stablecoin in this Mark home shares the same deposit address). extraCheck: more terms the caller requires of Satora's answer
 *  (escrow funding: enough sats for the deal), checked before the pin, so a refused swap is never shown and just expires. */
export async function createPinnedReverse(c: Ctx, s: Rev, p: Parsed, q: any, extraCheck?: (x: ReverseSwapCreated) => void) {
  return s.exclusive(async () => {
    // only swaps whose deposit address was shown count (a swap refused at create was never shown and just expires)
    const open = (await s.openReverse()).filter((o) => s.reversePin(o.id));
    if (open.length) throw new MarkError("SWAP_OPEN_DEPOSIT", `swap ${open[0].id} from this Mark home is still waiting for its deposit at the same address. Finish it (${mk()} swap fund ${open[0].id}) or let it expire before creating another.`, { open: open.map((x) => x.id) });
    const used = p.invoice ? s.invoiceUsedBy(p.invoice) : undefined;
    if (used) throw new MarkError("BAD_INVOICE", `--invoice was already used for swap ${used}: a Lightning invoice is paid once. Make a new one.`);
    const x = await s.createReverse({ from: p.from, to: p.to, bps: p.bps, ...(p.invoice ? { invoice: p.invoice } : { sourceUnits: p.sourceUnits }), ...(p.arkAddress ? { arkAddress: p.arkAddress } : {}) });
    // checked and recorded before the lock is released: the next create (any process) sees this swap as open and its invoice as used
    checkReverseCreated(c, p, x, q, s.depositAddress());
    extraCheck?.(x);
    s.pinReverse(x.id, { ...(p.invoice ? { invoice: p.invoice } : { arkAddress: p.arkAddress }), depositAddress: s.depositAddress(), tokenContract: x.tokenContract!, sourceUnits: x.sourceUnits!, targetSats: x.targetSats!, evmChainId: x.evmChainId!,
      ...(p.token.bridge ? { bridgeSourceChain: x.bridgeSourceChain!, bridgeSourceToken: x.bridgeSourceToken! } : {}) });
    return x;
  });
}

/** Before showing a deposit address: the swap must be a new gasless swap locked on Arbitrum One (a Base deposit is bridged there), from the chosen token, depositing to this
 *  Mark home's own address, for the confirmed amount, paying out to the confirmed target. Else SWAP_FAILED: deposit nothing (an
 *  unfunded swap simply expires). */
function checkReverseCreated(c: Ctx, p: Parsed, x: ReverseSwapCreated, q: any, myDeposit: string) {
  const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `Satora's swap does not match what you confirmed (${why}). Do NOT deposit anything; nothing is lost while it is unfunded.`, { id: x?.id }); };
  const t = p.token, rail = SWAP_SOURCES[p.to];
  if (!x?.id) bad("no swap id");
  if (x.status !== "pending") bad(`status ${x.status}, not a new unfunded swap`);
  if (x.gasless !== true) bad("not a gasless swap");
  // a bridged stablecoin (USDC on Base) is deposited on its chain and locked as the settlement token on the settlement chain
  const lockChain = t.bridge ? t.bridge.settleChain : t.chain, lockToken = t.bridge ? t.bridge.settleToken : t.tokenId;
  if (x.evmChainId !== Number(lockChain) || (x.sourceChain !== undefined && x.sourceChain !== lockChain)) bad(`chain ${x.evmChainId} (token chain ${x.sourceChain}) is not ${t.bridge ? t.bridge.settleNetwork : t.network} (${lockChain})`);
  if (!sameHex(x.tokenContract, lockToken)) bad(`token ${x.tokenContract} is not ${t.symbol} (${lockToken})`);
  if (t.bridge ? (x.bridgeSourceChain !== t.bridge.name || !sameHex(x.bridgeSourceToken, t.tokenId)) : x.bridgeSourceChain !== undefined)
    bad(`deposit chain ${x.bridgeSourceChain ?? t.network} / token ${x.bridgeSourceToken ?? x.tokenContract} is not ${t.symbol} on ${t.network}`);
  if (stableOfReverse(x) !== t) bad(`token ${x.tokenContract} is not ${t.symbol} on ${t.network}`);
  if (x.targetChain !== rail.chain) bad(`payout chain ${x.targetChain} is not ${rail.chain}`);
  let dep = ""; try { dep = checkEvmAddress(x.depositAddress, "deposit address"); } catch { bad(`deposit address ${x.depositAddress} is not an EVM address`); }
  if (!sameHex(dep, myDeposit)) bad(`deposit address ${dep} is not this Mark home's own gasless address`);
  if (!/^\d+$/.test(String(x.sourceUnits ?? "")) || BigInt(x.sourceUnits!) <= 0n) bad(`deposit amount ${x.sourceUnits} is not a positive token amount`);
  const amt = BigInt(x.sourceUnits!);
  if (p.sourceUnits !== undefined) { if (amt !== p.sourceUnits) bad(`deposit amount ${units(amt, t.decimals)} ${t.symbol} is not ${units(p.sourceUnits, t.decimals)}`); }
  else if (amt * 10000n > BigInt(q.source_amount) * BigInt(10000 + SWAP_MAX_SLIPPAGE_BPS)) bad(`deposit amount ${units(amt, t.decimals)} ${t.symbol} is more than ${pct(SWAP_MAX_SLIPPAGE_BPS)} above the quote (${units(q.source_amount, t.decimals)})`);
  if (!Number.isSafeInteger(x.targetSats) || x.targetSats! <= 0) bad(`payout ${x.targetSats} sats is not a positive amount`);
  if (x.direction !== reverseDir(p.to)) bad(`direction ${x.direction}`);
  if (p.invoice) {
    if (!sameHex(x.invoice, p.invoice)) bad("the invoice Satora will pay is not the one you gave");
    if (x.targetSats! < p.invoiceSats!) bad(`payout ${x.targetSats} sats does not cover the invoice's ${p.invoiceSats}`);
  } else {
    if (x.targetSats! * 10000 < Number(q.net_target_amount) * (10000 - SWAP_MAX_SLIPPAGE_BPS)) bad(`payout ${x.targetSats} sats is more than ${pct(SWAP_MAX_SLIPPAGE_BPS)} below the quote (${q.net_target_amount})`);
    if (!p.arkAddress) bad("no payout target");
    if (String(x.arkAddress ?? "") !== p.arkAddress) bad(`payout address ${x.arkAddress} is not ${p.arkAddress}`);
    try { checkArkadeAddress(x.arkAddress, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, serverPubkey: (x.raw as any)?.arkade_server_pk ?? null, what: "--address" }); } catch (e: any) { bad(e?.message ?? "bad Ark address"); }
  }
}

/** Where to deposit, how much is still missing (the deposit address may already hold some of the token), and how to send it. */
export async function depositInfo(s: Rev, x: ReverseSwapCreated, gas0?: GasEstimate | null) {
  const t = stableOfReverse(x)!; const r = readerOf(s, t);
  const need = BigInt(x.sourceUnits!); let have: bigint | undefined; try { have = await r.tokenBalance(t.tokenId, x.depositAddress!); } catch { have = undefined; }
  const g = gas0 !== undefined ? gas0 : await gasOf(s, t); let eth: bigint | undefined; if (t.bridge) { try { eth = await r.ethBalance(x.depositAddress!); } catch { eth = undefined; } }
  const gas = t.bridge ? { gas: { network: t.network, needEth: g ? ethText(g.wei) : null, holdsEth: eth !== undefined ? ethText(eth) : null, ...(g && eth !== undefined && eth < g.wei ? { sendEth: ethText(g.wei - eth) } : {}) } } : {};
  const noEth = t.bridge ? gasHow(t, x.depositAddress, g) : " No ETH needed.";
  const base = { address: x.depositAddress, token: t.symbol, contract: t.tokenId, network: t.network, chainId: Number(t.chain), amount: units(need, t.decimals), amountUnits: need.toString(), ...gas };
  if (have === undefined) return { ...base, howToDeposit: `Send exactly ${units(need, t.decimals)} ${t.symbol} (the ERC-20 at ${t.tokenId} on ${t.network}) to ${x.depositAddress}, ONCE.${noEth} Mark could not read the address's balance just now: if you already sent it, do not send again; check ${mk()} swap status ${x.id}.` };
  if (have >= need) return { ...base, alreadyThere: units(have, t.decimals), howToDeposit: `The deposit address already holds ${units(have, t.decimals)} ${t.symbol}: send NOTHING more of it. Run ${mk()} swap fund ${x.id} to lock it into this swap.${t.bridge ? noEth : ""}` };
  return { ...base, ...(have > 0n ? { alreadyThere: units(have, t.decimals) } : {}), send: units(need - have, t.decimals), sendUnits: (need - have).toString(),
    howToDeposit: `Send exactly ${units(need - have, t.decimals)} ${t.symbol} (the ERC-20 at ${t.tokenId} on ${t.network}, not another chain) to ${x.depositAddress}, in ONE transfer.${t.bridge ? noEth : " No ETH needed: Mark locks it into the swap."}` };
}

const tokenOf = (x: ReverseSwapCreated) => stableOfReverse(x);
const isDone = (x: ReverseSwapInfo) => SWAP_DONE.has(x.status) || (x.targetChain === "Lightning" && x.lightningSettled === true);
const doneOut = (x: ReverseSwapInfo) => ({ id: x.id, status: x.status, swap: "done", sats: x.targetSats, ...txLink(x.fundTx, "fundTx", "fundExplorer"), ...(x.payoutTx ? { payoutTx: x.payoutTx } : {}),
  note: x.targetChain === "Lightning" ? "Paid out over Lightning." : "Paid out to your Ark address." });

/** What the swap needs next. Never asks for a deposit again once the deposit address holds it, or once a funding was submitted. */
async function fundState(s: Rev, x: ReverseSwapInfo) {
  const t = tokenOf(x); const need = BigInt(x.sourceUnits ?? "0");
  let have: bigint | undefined; try { have = t && x.depositAddress ? await readerOf(s, t).tokenBalance(t.tokenId, x.depositAddress) : undefined; } catch { have = undefined; }
  return { t, need, have, attempted: s.fundAttemptedAt(x.id) };
}
/** A bridged stablecoin (USDC on Base): ETH the deposit address needs on that chain and holds (null when unreadable); else null. */
async function gasState(s: Rev, t: StableToken | undefined, dep: string | undefined) {
  if (!t?.bridge || !dep) return null;
  try { const r = readerOf(s, t); const [need, holds] = await Promise.all([gasNeedWei(r), r.ethBalance(dep)]); return { need, holds }; } catch { return null; }
}
/** A burn was sent and the swap waits for its settlement: funding again resumes it (no new burn). */
const resumable = async (s: Rev, x: ReverseSwapInfo) => !!x.bridgeSourceChain && x.status === "pending" && !x.fundTx && !!((await s.cctpBurn?.(x.id)) ?? s.sentBurn?.(x.id));

/** Lock the deposit into the swap, once (gasless on Arbitrum One; on Base approve + CCTP burn paid in ETH, checked first). wait: first wait for the deposit, then for the payout. */
export async function reverseFund(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  if (!id) throw new MarkError("USAGE", "mark swap fund <id>");
  const s = await reverse(c);
  if (o.wait) return waitReverse(s, id, o);
  const x = pinned(s, await s.getReverse(id), "act");
  if (isDone(x)) return doneOut(x);
  if (x.status !== "pending" || x.fundTx) return { id, status: x.status, funded: false, note: x.status === "pending" ? `Funding seen (tx ${x.fundTx}). ${DO_NOT_RESEND}` : `Already past funding (${x.status}): ${nextNote(x)}` };
  if (await resumable(s, x)) return fundOut(x, await s.fundReverse(id));
  const f = await fundState(s, x);
  if (f.have === undefined) return { id, status: x.status, funded: false, note: "Could not read the deposit address's balance; retry shortly. If you already sent the stablecoins, do NOT send again." };
  if (f.have < f.need && f.attempted !== undefined) return { id, status: x.status, funded: false, note: `A funding was submitted at ${new Date(f.attempted).toISOString()}; wait for Satora to see it (${mk()} swap status ${id}). ${DO_NOT_RESEND}` };
  if (f.have < f.need) return { id, status: x.status, funded: false, deposit: { address: x.depositAddress, seen: units(f.have, f.t!.decimals), required: units(f.need, f.t!.decimals) },
    note: f.have > 0n ? `The deposit address holds ${units(f.have, f.t!.decimals)} of ${units(f.need, f.t!.decimals)} ${f.t!.symbol}: only the missing ${units(f.need - f.have, f.t!.decimals)} completes it (do NOT resend the full amount), or get it back with ${mk()} swap recover ${id} --to <0x...>.` : "No deposit seen yet at the deposit address (shown when the swap was created). Run this again once it is sent." };
  // USDC on Base: the approve + burn are paid in ETH on Base by the deposit address; check it before anything is signed
  if (f.t?.bridge && f.attempted === undefined) {
    const g = await gasState(s, f.t, x.depositAddress);
    if (!g) return { id, status: x.status, funded: false, note: `Could not read the deposit address's ETH on ${f.t.network} just now; nothing was signed. Retry shortly. ${DO_NOT_RESEND}` };
    if (g.holds < g.need) needGas(id, f.t, x.depositAddress!, g.need, g.holds);
  }
  return fundOut(x, await s.fundReverse(id));
}
function fundOut(x: ReverseSwapInfo, r: Awaited<ReturnType<Rev["fundReverse"]>>) {
  const t = tokenOf(x);
  if (r.needEth && t) needGas(x.id, t, x.depositAddress!, BigInt(r.needEth.needWei), BigInt(r.needEth.holdsWei));
  const burn = r.burnTx && t?.bridge ? { burnTx: r.burnTx, burnExplorer: t.explorerTx + r.burnTx } : {};
  if (r.success) return { id: x.id, status: x.status, funded: true, ...txLink(r.txHash, "fundTx"), ...burn, note: `The deposit is locked.${t?.bridge ? ` Its ${t.symbol} was burned on ${t.network} and carried over ${t.bridge.via}.` : ""} ${DO_NOT_RESEND} Watch it with ${mk()} swap status ${x.id}.` };
  if (r.burnTx && t?.bridge) return { id: x.id, status: x.status, funded: false, fundFailed: true, message: r.message, ...burn,
    note: `The ${t.symbol} was burned on ${t.network} (tx ${r.burnTx}) but the swap is not locked yet. Run ${mk()} swap fund ${x.id} again: it resumes from that burn (no new burn, no gas). If it never settles, after 30 minutes ${mk()} swap recover ${x.id} --to <your 0x address> sends the USDC to that address on ${t.bridge.settleNetwork} (sponsored, no ETH). ${DO_NOT_RESEND}` };
  if (r.skipped) return { id: x.id, status: x.status, funded: false, note: `${r.skipped}. ${DO_NOT_RESEND} Check ${mk()} swap status ${x.id}.` };
  if (r.stop) return { id: x.id, status: x.status, funded: false, fundFailed: true, message: r.message, note: `Nothing was signed or locked. If you sent the stablecoins, get them back with ${mk()} swap recover ${x.id} --to <your 0x address> (and start a new swap with a fresh invoice if you still want it). ${DO_NOT_RESEND}` };
  return { id: x.id, status: x.status, funded: false, fundFailed: true, message: r.message, note: r.uncertain
    ? `A funding may already have been submitted: Mark never signs this funding again. ${DO_NOT_RESEND} Check ${mk()} swap status ${x.id}; if Satora never sees it, after 30 minutes get the stablecoins back with ${mk()} swap recover ${x.id} --to <your 0x address>.`
    : `Funding was refused before anything was locked; your stablecoins are still at the deposit address. Retry ${mk()} swap fund ${x.id}, or get them back with ${mk()} swap recover ${x.id} --to <0x...>. ${DO_NOT_RESEND}` };
}
/** Every later read of a swap from a stablecoin is checked against what was confirmed at create: this Mark home's own deposit
 *  address, and the pinned payout target and deposit terms. act (fund, claim, refund, recover, wait): the swap must also be this
 *  home's. Returns the swap with the pinned values in place of Satora's. */
function pinned(s: Rev, x: ReverseSwapInfo, mode: "show" | "act" | "return"): ReverseSwapInfo {
  notReverse(x);
  const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `swap ${x.id} does not match what was confirmed at create (${why}). Do NOT deposit or send anything for it.`, { id: x.id }); };
  if (mode !== "show" && !x.local) throw new MarkError("SWAP_NOT_LOCAL", "this Mark home does not hold the swap's keys: run it from the Mark home that created it");
  const mine = s.depositAddress(); const pin = s.reversePin(x.id);
  if (pin) { const why = pinMismatch(pin, x, mine, mode === "act"); if (why) bad(why); }
  else if (!sameHex(x.depositAddress, mine)) bad(`deposit address ${x.depositAddress} is not this Mark home's ${mine}`);
  else if (mode === "act") bad("this Mark home has no record of what was confirmed at create");
  // "return" (refund, recover) works without the record: it only moves funds back through this home's own key to an address you give
  return { ...x, depositAddress: mine, ...(pin?.arkAddress ? { arkAddress: pin.arkAddress } : {}) };
}
function notReverse(x: ReverseSwapInfo) { if (!isReverseDir(x.direction)) throw new MarkError("USAGE", `swap ${x.id} is not a swap from a stablecoin (${x.direction})`); }

/** After the swap stops: what to do. Funded and failed: refund it to the deposit address, then recover it; unfunded: recover any deposit. */
function nextNote(x: ReverseSwapInfo) {
  if (isDone(x)) return "Done.";
  const t = tokenOf(x); const where = t?.bridge ? ` (after the ${t.network} burn the ${t.symbol} is recovered on ${t.bridge.settleNetwork}, to the same --to address there)` : "";
  if (SWAP_FAILED.has(x.status)) return /refunded/.test(x.status) && x.status !== "clientfundedserverrefunded"
    ? `Refunded to the deposit address: send it to your wallet with ${mk()} swap recover ${x.id} --to <your 0x address>${where}.`
    : x.fundTx || x.status === "clientfundedserverrefunded" || x.status === "clientfundedtoolate" || x.status === "serverwontfund"
      ? `Ended without a payout after your deposit was locked: run ${mk()} swap refund ${x.id} (gasless), then ${mk()} swap recover ${x.id} --to <your 0x address>${where}.`
      : `Ended without a payout (${x.status}). If you deposited, get it back with ${mk()} swap recover ${x.id} --to <your 0x address>.`;
  if (SWAP_CLAIMABLE.has(x.status) && x.targetChain === "Arkade") return `Satora funded the Ark payout: claim it with ${mk()} swap claim ${x.id}.`;
  return `In progress (${x.status}). ${DO_NOT_RESEND}`;
}

/** Watch the deposit, fund once, then wait for the payout (claiming an Ark payout when Satora has funded it). */
/** noFund (claim --wait): never funds; a swap still waiting for its funding is handed back with how to fund it. */
/** claimGuard (escrow funding): asked right before an Ark payout is claimed; a reason stops the wait unclaimed (e.g. the deal expired). */
export async function waitReverse(s: Rev, id: string, o: { timeoutSec?: number; pollMs?: number; noFund?: boolean; claimGuard?: () => Promise<string | undefined>; retryHint?: string }) {
  const end = Date.now() + (o.timeoutSec ?? 1800) * 1000; const poll = o.pollMs ?? 5000; let last = "unknown"; let fund: any; let claimed = false;
  let lowGas: { t: StableToken; dep: string; need: bigint; holds: bigint } | undefined;
  /** asked right before the deposit is locked: the guard's reason stops the wait with the deposit untouched */
  const notLocked = async (x: ReverseSwapInfo) => { const stop = await o.claimGuard?.(); return stop ? { id, status: x.status, funded: false, notClaimed: stop, note: `${stop} The deposit was NOT locked into the swap.` } : undefined; };
  while (Date.now() < end) {
    let x: ReverseSwapInfo; try { x = await s.getReverse(id); } catch { await sleep(poll); continue; }
    x = pinned(s, x, "act"); last = x.status;
    if (isDone(x)) return doneOut(x);
    if (x.status === "pending" && !x.fundTx && !fund?.success && o.noFund)
      return { id, status: x.status, funded: false, note: `Not funded yet: claim never funds a swap. Once the deposit is there, run ${mk()} swap fund ${id} --wait. If you already sent it, do NOT send again.` };
    if (x.status === "pending" && !x.fundTx && !fund?.success) {
      const f = await fundState(s, x);
      if (!fund && await resumable(s, x)) {
        const stop = await notLocked(x); if (stop) return stop;
        const r = await s.fundReverse(id); fund = r;
        if (!r.success && !r.skipped) return fundOut(x, r);
      } else if (f.have !== undefined && f.have >= f.need && f.attempted === undefined) {
        // USDC on Base: wait (do not sign) until the deposit address also holds the ETH for the approve + burn
        const g = f.t?.bridge ? await gasState(s, f.t, x.depositAddress) : undefined;
        lowGas = g && g.holds < g.need ? { t: f.t!, dep: x.depositAddress!, need: g.need, holds: g.holds } : undefined;
        if (g !== null && !lowGas) {
          const stop = await notLocked(x); if (stop) return stop;
          const r = await s.fundReverse(id); fund = r;
          if (r.needEth) { lowGas = { t: f.t!, dep: x.depositAddress!, need: BigInt(r.needEth.needWei), holds: BigInt(r.needEth.holdsWei) }; fund = undefined; }
          else if (!r.success && !r.skipped && !r.uncertain) return fundOut(x, r);
          else if (r.uncertain && r.burnTx) return fundOut(x, r);
        }
      }
    } else if (SWAP_CLAIMABLE.has(x.status) && x.targetChain === "Arkade" && !claimed) {
      const stop = await o.claimGuard?.();
      if (stop) return { id, status: x.status, claimed: false, notClaimed: stop, note: `${stop} ${DO_NOT_RESEND}` };
      const r = await s.claim(id, x.arkAddress!); claimed = r.success;
      if (!r.success) return { id, status: x.status, claimFailed: true, claim: r, note: `Satora funded the Ark payout but the claim failed: retry with ${o.retryHint ?? `${mk()} swap claim ${id}`} (same Mark home). ${DO_NOT_RESEND}` };
    } else if (SWAP_FAILED.has(x.status)) return { id, status: x.status, ended: true, note: nextNote(x) };
    await sleep(poll);
  }
  if (lowGas && last === "pending" && !fund?.success) needGas(id, lowGas.t, lowGas.dep, lowGas.need, lowGas.holds);
  return { id, status: last, timeout: true, ...(fund?.txHash ? { fundTx: fund.txHash } : {}), note: `timeout at swap status ${last}. Check ${mk()} swap status ${id}; ${last === "pending" && !fund?.success ? `once the deposit is there run ${mk()} swap fund ${id}.` : "it continues without Mark."} ${DO_NOT_RESEND}` };
}

/** A swap's state without anything one could deposit to (address, amount, token): for swaps this home cannot vouch for. */
const noDeposit = (x: ReverseSwapInfo) => ({ id: x.id, status: x.status, direction: x.direction, targetChain: x.targetChain, local: x.local,
  ...(x.fundTx ? { fundTx: x.fundTx } : {}), ...(x.payoutTx ? { payoutTx: x.payoutTx } : {}), ...(x.lightningSettled !== undefined ? { lightningSettled: x.lightningSettled } : {}) });
/** Status of a swap from a stablecoin (read-only), with the deposit seen so far while it waits for funding. */
export async function reverseStatus(s: Rev, x0: ReverseSwapInfo) {
  if (!x0.local) { notReverse(x0); return { ...noDeposit(x0), next: "This Mark home did not create this swap: it shows no deposit instructions for it. Check it from the Mark home that created it." }; }
  if (!s.reversePin(x0.id)) { notReverse(x0); return { ...noDeposit(x0), next: `This Mark home has no record of what was confirmed when this swap was created, so it shows no deposit instructions. If you deposited, get it back with ${mk()} swap recover ${x0.id} --to <your 0x address>.` }; }
  const x = pinned(s, x0, "show"); const { raw: _raw, ...info } = x; const t = tokenOf(x);
  const out: any = { ...info, ...(t ? { token: t.symbol, depositAmount: units(x.sourceUnits, t.decimals) } : {}), ...(x.fundTx ? { fundExplorer: ARBISCAN_TX + x.fundTx } : {}) };
  if (x.status === "pending" && !x.fundTx) {
    const f = await fundState(s, x);
    out.depositSeen = f.have === undefined ? "unknown (balance read failed)" : units(f.have, t!.decimals);
    let lowEth: { need: bigint; holds: bigint } | undefined;
    if (t?.bridge) {
      const g = await gasState(s, t, x.depositAddress); const recorded = await s.cctpBurn?.(x.id), burn = recorded ?? s.sentBurn?.(x.id); if (g && g.holds < g.need) lowEth = g;
      out.depositNetwork = t.network; out.gas = g ? { network: t.network, needEth: ethText(g.need), holdsEth: ethText(g.holds) } : "unknown (read failed)";
      if (burn) { out.burnTx = burn; out.burnExplorer = t.explorerTx + burn;
        out.next = recorded ? `The ${t.symbol} was burned on ${t.network}; the swap is not locked yet. Run ${mk()} swap fund ${x.id} to resume (no new burn, no gas). ${DO_NOT_RESEND}`
          : `The ${t.symbol} was burned on ${t.network} but the swap library did not record it, so Mark will not fund this swap again. If it does not settle, ${mk()} swap recover ${x.id} --to <your 0x address> (30 minutes after the attempt) sends it as ${t.symbol} on ${t.bridge.settleNetwork}. ${DO_NOT_RESEND}`;
        return out; }
    }
    out.next = f.attempted !== undefined ? `A funding was submitted; wait for Satora to see it. ${DO_NOT_RESEND}`
      : f.have !== undefined && f.have >= f.need ? `Deposit seen: lock it with ${mk()} swap fund ${x.id}. ${DO_NOT_RESEND}`
      : f.have !== undefined && f.have > 0n ? `Deposit partly seen (${units(f.have, t!.decimals)} of ${units(f.need, t!.decimals)}): only the missing ${units(f.need - f.have, t!.decimals)} completes it; do NOT resend the full amount.`
      : f.have === undefined ? "Could not read the deposit address; if you sent the stablecoins, do NOT send again." : `Waiting for the deposit of ${units(f.need, t!.decimals)} ${t!.symbol} to ${x.depositAddress}.`;
    if (lowEth && f.attempted === undefined) out.next += ` The deposit address also needs ${ethText(lowEth.need)} ETH on ${t!.network} for gas and holds ${ethText(lowEth.holds)}: send at least ${ethText(lowEth.need - lowEth.holds)} ETH on ${t!.network} to ${x.depositAddress}.`;
  } else out.next = nextNote(x);
  return out;
}

/** Claim an Ark payout Satora has funded (Lightning payouts need no claim). */
export async function reverseClaim(s: Rev, x0: ReverseSwapInfo) {
  const x = pinned(s, x0, "act");
  if (isDone(x)) return doneOut(x);
  if (x.targetChain !== "Arkade") return { id: x.id, status: x.status, claimed: false, note: `A Lightning payout needs no claim: Satora pays the invoice. ${nextNote(x)}` };
  if (!SWAP_CLAIMABLE.has(x.status)) return { id: x.id, status: x.status, claimed: false, note: nextNote(x) };
  const r = await s.claim(x.id, x.arkAddress!);
  return r.success ? { id: x.id, status: x.status, claimed: true, ...(r.txid ? { txid: r.txid } : {}), note: "Claimed to your Ark address." }
    : { id: x.id, status: x.status, claimFailed: true, claim: r, note: `Claim failed; retry later. ${DO_NOT_RESEND}` };
}

/** Refund a locked deposit that did not pay out, back to the deposit address (gasless), for recover to send on. */
export async function reverseRefund(s: Rev, x0: ReverseSwapInfo) {
  const x = pinned(s, x0, "return");
  if (isDone(x)) throw new MarkError("SWAP_DONE", "this swap paid out: nothing to refund");
  if (x.status === "pending" && !x.fundTx) return { id: x.id, status: x.status, refunded: false, note: `Nothing is locked yet: an unfunded deposit is recovered with ${mk()} swap recover ${x.id} --to <your 0x address>.` };
  // only while the deposit is locked and Satora is not paying out: funded-but-stuck, or ended without a payout
  if (!SWAP_PAID.has(x.status) && !SWAP_FAILED.has(x.status)) return { id: x.id, status: x.status, refunded: false, note: `Not refundable while the payout is under way (${x.status}). ${nextNote(x)}` };
  if (/refunded/.test(x.status) && x.status !== "clientfundedserverrefunded") return { id: x.id, status: x.status, refunded: false, note: nextNote(x) };
  const r = await s.refundReverse(x.id);
  return r.success ? { id: x.id, refunded: true, how: r.how, ...txLink(r.txHash), note: `Refunded to the deposit address ${x.depositAddress}. Send it to your wallet with ${mk()} swap recover ${x.id} --to <your 0x address>.` }
    : { id: x.id, status: x.status, refunded: false, message: r.message, note: "Satora would not refund it collaboratively and its timelock has not passed (or the refund failed): retry later." };
}

/** Gas for one ERC-20 transfer from the deposit address on Arbitrum One, with headroom. */
const SWEEP_GAS = SWEEP_TX.gas;
/** Send the swap token from the deposit address to `to` (the stablecoins of an unfunded, failed or refunded swap). USDC on Base:
 *  before its burn, the USDC on Base (gas in ETH on Base from the deposit address); after the burn, Circle's mint (if not yet) and
 *  a sweep on the settlement chain (sponsored, no ETH), to the same `to` address there. */
export async function reverseRecover(c: Ctx, id: string, to: string | undefined) {
  if (!id || !to) throw new MarkError("USAGE", "mark swap recover <id> --to <your 0x address>");
  const dest = checkEvmAddress(to, "--to"); const s = await reverse(c);
  const first = pinned(s, await s.getReverse(id), "return"); const t = tokenOf(first);
  if (!t) throw new MarkError("SWAP_FAILED", `unknown swap token ${first.tokenContract}`);
  // under the deposit lock: no create or funding of this home can slip in between the checks and the sweep
  return s.exclusive(async () => {
    // re-read under the lock: a funding that took the lock first is seen here, before anything is swept
    const x = pinned(s, await s.getReverse(id), "return"); const at = s.fundAttemptedAt(id);
    if (tokenOf(x) !== t) throw new MarkError("SWAP_FAILED", `swap ${id} changed token while recovering (${x.tokenContract}); nothing was moved`);
    // a funding submitted in the last RECOVER_AFTER_FUND_MS may still land, whatever the status says (unless the swap ended)
    if (at !== undefined && Date.now() - at < RECOVER_AFTER_FUND_MS && !SWAP_FAILED.has(x.status) && !isDone(x)) throw new MarkError("SWAP_FUNDING", "a funding of this swap was submitted less than 30 minutes ago and may still land: wait for it (mark swap status) before recovering");
    // another swap shares this deposit balance: same token, or either one bridged (USDC on Base is minted to the same account on
    // the settlement chain), so it is treated as shared
    const shares = (y: ReverseSwapInfo) => tokenOf(y) === t || !!t.bridge || !!y.bridgeSourceChain;
    // any other swap of this home funded in the last 30 minutes may still need the shared address's balance: unless its deposit
    // is already pulled (funding tx known) or it ended, do not sweep; a failed read refuses too
    const recent = s.fundAttemptsSince(Date.now() - RECOVER_AFTER_FUND_MS).filter((o) => o !== id);
    const reads = await Promise.all(recent.map((o) => s.getReverse(o).catch(() => undefined)));
    for (const [k, o] of recent.entries()) {
      const y = reads[k];
      if (!y || (shares(y) && !y.fundTx && !SWAP_FAILED.has(y.status) && !isDone(y)))
        throw new MarkError("SWAP_FUNDING", `swap ${o} was funded from the same deposit address less than 30 minutes ago and may still need it: wait for it (${mk()} swap status ${o}) before recovering`);
    }
    const others = (await s.openReverse()).filter((o) => o.id !== id && shares(o));
    if (others.length) throw new MarkError("SWAP_OPEN_DEPOSIT", `swap ${others[0].id} is waiting for a deposit at the same address: recovering now would take its deposit too. Finish it or let it expire first.`);
    const locked = x.fundTx && !SWAP_FAILED.has(x.status) && !isDone(x);
    const done = (r: Awaited<ReturnType<Rev["recoverReverse"]>>, net: StableToken | { network: string; explorerTx: string }) => r.success
      ? { id, recovered: true, to: dest, network: net.network, amount: r.amountUnits ? units(r.amountUnits, t.decimals) : undefined, token: t.symbol, ...(r.txHash ? { txHash: r.txHash, explorer: net.explorerTx + r.txHash } : {}) }
      : { id, recovered: false, message: r.message, note: "Recovery failed; nothing was moved unless the explorer shows it. Retry later." };
    if (t.bridge) {
      if (isDone(x)) return { id, recovered: false, note: "This swap paid out: nothing to recover." };
      if (locked) return { id, recovered: false, note: `Its deposit is locked in the swap: if it does not pay out, run ${mk()} swap refund ${id} first.` };
      const burn = (await s.cctpBurn?.(id)) ?? s.sentBurn?.(id);
      // a burn with no funding time in this home (a lost record): the settlement may still be running, so resume it first;
      // that records the time, and recover works 30 minutes later
      if (burn && at === undefined && x.status === "pending" && !x.fundTx) throw new MarkError("SWAP_FUNDING", `swap ${id} has a CCTP burn (${burn}) but this Mark home has no funding time for it: run ${mk()} swap fund ${id} first (it resumes the settlement, or records the time); if it does not settle, recover works 30 minutes after that`);
      if (burn) {
        // the USDC left Base: Circle mints it to the deposit account on the settlement chain; both steps are sponsored (no ETH)
        const r = await s.recoverReverse(id, dest);
        return { ...done(r, { network: t.bridge.settleNetwork, explorerTx: ARBISCAN_TX }), burnTx: burn, ...(r.success ? { note: `Sent as ${t.symbol} on ${t.bridge.settleNetwork} to ${dest} (the burn on ${t.network} cannot be undone; your address is the same there).` } : {}) };
      }
      const r0 = readerOf(s, t); const bal = await r0.tokenBalance(t.tokenId, x.depositAddress!);
      // no USDC on Base after a send of unknown outcome: a burn may have gone through, waiting on the settlement chain
      if (bal === 0n) return { id, recovered: false, note: s.sentUnknown?.(id)
        ? `The deposit address holds no ${t.symbol} on ${t.network}, and a funding transaction of this swap was sent with an unknown outcome: a Circle CCTP burn may have gone through. Check ${x.depositAddress} on ${t.network}'s explorer for a depositForBurn; that USDC is then on ${t.bridge.settleNetwork}, not lost. Nothing was moved.`
        : `The deposit address holds no ${t.symbol} on ${t.network}. Nothing to recover.` };
      const [eth, need] = await Promise.all([r0.ethBalance(x.depositAddress!), gasNeedWei(r0, [SWEEP_TX])]);
      if (eth < need) return { id, recovered: false, holds: `${units(bal, t.decimals)} ${t.symbol}`, depositAddress: x.depositAddress, needEth: ethText(need), holdsEth: ethText(eth),
        note: `Sending the ${t.symbol} out of the deposit address costs a little ETH on ${t.network} for gas: send at least ${ethText(need - eth)} ETH on ${t.network} to ${x.depositAddress}, then run this again.` };
      return done(await s.recoverReverse(id, dest), t);
    }
    const bal = await s.evm.tokenBalance(t.tokenId, x.depositAddress!);
    if (bal === 0n) return { id, recovered: false, note: `The deposit address holds no ${t.symbol}. ${locked ? `Its deposit is locked in the swap: if it does not pay out, run ${mk()} swap refund ${id} first.` : "Nothing to recover."}` };
    const [eth, gp] = await Promise.all([s.evm.ethBalance(x.depositAddress!), s.evm.gasPrice()]);
    const needWei = SWEEP_GAS * gp * 2n;
    if (eth < needWei) return { id, recovered: false, holds: `${units(bal, t.decimals)} ${t.symbol}`, depositAddress: x.depositAddress,
      note: `Sending tokens out of the deposit address costs a little Arbitrum ETH for gas: send about ${units(needWei - eth, 18)} ETH (Arbitrum One) to ${x.depositAddress}, then run this again.` };
    const r = await s.recoverReverse(id, dest);
    return r.success ? { id, recovered: true, to: dest, amount: r.amountUnits ? units(r.amountUnits, t.decimals) : undefined, token: t.symbol, ...txLink(r.txHash) }
      : { id, recovered: false, message: r.message, note: "Recovery failed; nothing was moved unless the explorer shows it. Retry later." };
  });
}
