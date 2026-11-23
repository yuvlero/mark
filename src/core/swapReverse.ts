/** `mark swap` from a stablecoin: USDC / USDT0 on Arbitrum -> BTC over Lightning (a BOLT11 invoice) or to
 *  an Ark address, through Satora. Gasless: the stablecoins go to this Mark home's deposit address (its own EVM key, kept in the
 *  encrypted swap storage); Mark then signs Permit2 and Satora's relay locks them into the swap. No wallet, no ETH. */
import { MarkError } from "../errors.js";
import type { Ctx } from "./context.js";
import type { ReverseSwapCreated, ReverseSwapInfo, SwapProvider } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { decodeInvoice, networkOk } from "../lightning/invoice.js";
import { SWAP_DONE, SWAP_FAILED } from "../swap/states.js";
import { sleep } from "../util.js";
import { ARBISCAN_TX, SWAP_MARKUP_BPS, SWAP_MAX_SLIPPAGE_BPS, SWAP_SOURCES, SWAP_TARGETS, checkEvmAddress, checkMarkupBps,
  formatReverseQuote, pct, tokenUnits, units, type SwapRail, type SwapStable } from "../swap/stable.js";

export interface ReverseInput { from: SwapStable; to: SwapRail; amount?: string | number; invoice?: string; address?: string }
type Rev = Required<Pick<SwapProvider, "quoteReverse" | "createReverse" | "getReverse" | "depositAddress" | "openReverse" | "fundReverse" | "fundAttemptedAt" | "refundReverse" | "recoverReverse" | "evm" | "claim" | "exclusive" | "pinReverse" | "reversePin" | "invoiceUsedBy">> & SwapProvider;

export async function reverse(c: Ctx): Promise<Rev> {
  const s = await c.swaps();
  for (const k of ["quoteReverse", "createReverse", "getReverse", "depositAddress", "openReverse", "fundReverse", "fundAttemptedAt", "refundReverse", "recoverReverse", "evm", "exclusive", "pinReverse", "reversePin", "invoiceUsedBy"] as const)
    if (!(s as any)[k]) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} does not support mark swap from a stablecoin`);
  return s as any;
}

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
type Parsed = ReturnType<typeof parseReverse>;
const target = (p: Parsed) => p.invoice ? { invoice: p.invoice } : { arkAddress: p.arkAddress };
/** The create command for this input; a target the quote left out is a placeholder. */
const flags = (p: Parsed) => `--from ${p.from} --to ${p.to} ${p.invoice ? `--invoice ${p.invoice}` : p.to === "lightning" ? "--invoice <bolt11 for the sats you want>" : `--address ${p.arkAddress ?? "<ark address>"} --amount ${units(p.sourceUnits!, p.token.decimals)}`}`;

async function quoteOf(s: Rev, p: Parsed) {
  const q = await s.quoteReverse({ from: p.from, to: p.to, bps: p.bps, ...(p.invoice ? { targetSats: p.invoiceSats, destination: p.invoice } : { sourceUnits: p.sourceUnits }) });
  if (!/^\d+$/.test(String(q?.source_amount ?? "")) || BigInt(q.source_amount) <= 0n || !(Number(q?.net_target_amount) > 0))
    throw new MarkError("QUOTE_UNAVAILABLE", "Satora's quote has no amounts; nothing was created. Retry later.");
  return q;
}
function inRange(q: any) { const gross = Number(q.target_amount); return !(Number.isSafeInteger(q.min_amount) && Number.isSafeInteger(q.max_amount)) || (gross >= q.min_amount && gross <= q.max_amount); }

/** Quote only (nothing is created). */
export async function reverseQuote(c: Ctx, i: ReverseInput) {
  const p = parseReverse(c, i, "quote"); const s = await reverse(c); const q = await quoteOf(s, p);
  return { quote: formatReverseQuote(q, p), ...(inRange(q) ? {} : { note: `amount out of range: Satora accepts ${q.min_amount}..${q.max_amount} sats for this route` }),
    next: `${mk()} swap ${flags(p)} previews it; add --yes to create it` };
}

export interface ReverseRunInput extends ReverseInput { confirm?: boolean; wait?: boolean; timeoutSec?: number; pollMs?: number; onProgress?: (x: unknown) => void }

/** Preview (default) or create a swap from a stablecoin. confirm: create it and show where to deposit. wait: watch the deposit
 *  address, fund the swap once the deposit is there (gasless), and wait for the payout. */
export async function reverseRun(c: Ctx, i: ReverseRunInput) {
  const p = parseReverse(c, i); const s = await reverse(c);
  const q = await quoteOf(s, p); const quote = formatReverseQuote(q, p);
  if (!inRange(q)) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for ${p.token.symbol} -> ${p.to}`, { quote });
  const payout = p.invoice ? `the Lightning invoice you gave (${p.invoiceSats} sats)` : `the Ark address ${p.arkAddress}`;
  if (!i.confirm) return { swap: "preview", quote, payout: target(p),
    notice: `REAL MONEY: this swaps about ${quote.send} ${p.token.symbol} on Arbitrum into ${quote.receiveSats} sats paid to ${payout}. Check the target: a payout to a wrong target cannot be undone. ${quote.markupNote}`,
    next: `Nothing was created. To create it: ${mk()} swap ${flags(p)} --yes --wait` };
  // one open deposit at a time: every swap from a stablecoin in this Mark home shares the same deposit address. The check and the
  // create run under the Mark home's deposit lock (other processes too), so two creates cannot both see "none open".
  const created = await s.exclusive(async () => {
    const open = await s.openReverse();
    if (open.length) throw new MarkError("SWAP_OPEN_DEPOSIT", `swap ${open[0].id} from this Mark home is still waiting for its deposit at the same address. Finish it (${mk()} swap fund ${open[0].id}) or let it expire before creating another.`, { open: open.map((x) => x.id) });
    const used = p.invoice ? s.invoiceUsedBy(p.invoice) : undefined;
    if (used) throw new MarkError("BAD_INVOICE", `--invoice was already used for swap ${used}: a Lightning invoice is paid once. Make a new one.`);
    return s.createReverse({ from: p.from, to: p.to, bps: p.bps, ...(p.invoice ? { invoice: p.invoice } : { sourceUnits: p.sourceUnits }), ...(p.arkAddress ? { arkAddress: p.arkAddress } : {}) });
  });
  checkReverseCreated(c, p, created, q, s.depositAddress());
  s.pinReverse(created.id, { ...(p.invoice ? { invoice: p.invoice } : { arkAddress: p.arkAddress }), depositAddress: s.depositAddress(), tokenContract: created.tokenContract!, sourceUnits: created.sourceUnits! });
  const deposit = await depositInfo(s, created);
  const first = { swap: "created", id: created.id, status: created.status, from: p.from, to: p.to, payout: { ...target(p), sats: created.targetSats }, quote, deposit,
    next: i.wait && i.onProgress ? "Waiting for the deposit; then Mark funds the swap (gasless) and waits for the payout." : `After the deposit, run: ${mk()} swap fund ${created.id} --wait  (signs the permits once; Satora's relay locks the deposit)` };
  if (!i.wait || !i.onProgress) return first; // waiting only helps once the depositor has seen the address
  i.onProgress(first);
  return { ...(await waitReverse(s, created.id, { timeoutSec: i.timeoutSec, pollMs: i.pollMs })), from: p.from, to: p.to };
}

/** Before showing a deposit address: the swap must be a new gasless swap on Arbitrum, from the chosen token, depositing to this
 *  Mark home's own address, for the confirmed amount, paying out to the confirmed target. Else SWAP_FAILED: deposit nothing (an
 *  unfunded swap simply expires). */
function checkReverseCreated(c: Ctx, p: Parsed, x: ReverseSwapCreated, q: any, myDeposit: string) {
  const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `Satora's swap does not match what you confirmed (${why}). Do NOT deposit anything; nothing is lost while it is unfunded.`, { id: x?.id }); };
  const t = p.token, rail = SWAP_SOURCES[p.to];
  if (!x?.id) bad("no swap id");
  if (x.status !== "pending") bad(`status ${x.status}, not a new unfunded swap`);
  if (x.gasless !== true) bad("not a gasless swap");
  if (x.evmChainId !== Number(t.chain) || (x.sourceChain !== undefined && x.sourceChain !== t.chain)) bad(`chain ${x.evmChainId} (token chain ${x.sourceChain}) is not ${t.network} (${t.chain})`);
  if (String(x.tokenContract ?? "").toLowerCase() !== t.tokenId.toLowerCase()) bad(`token ${x.tokenContract} is not ${t.symbol} (${t.tokenId})`);
  if (x.targetChain !== rail.chain) bad(`payout chain ${x.targetChain} is not ${rail.chain}`);
  let dep = ""; try { dep = checkEvmAddress(x.depositAddress, "deposit address"); } catch { bad(`deposit address ${x.depositAddress} is not an EVM address`); }
  if (!myDeposit || dep.toLowerCase() !== myDeposit.toLowerCase()) bad(`deposit address ${dep} is not this Mark home's own gasless address`);
  if (!/^\d+$/.test(String(x.sourceUnits ?? "")) || BigInt(x.sourceUnits!) <= 0n) bad(`deposit amount ${x.sourceUnits} is not a positive token amount`);
  const amt = BigInt(x.sourceUnits!);
  if (p.sourceUnits !== undefined) { if (amt !== p.sourceUnits) bad(`deposit amount ${units(amt, t.decimals)} ${t.symbol} is not ${units(p.sourceUnits, t.decimals)}`); }
  else if (amt * 10000n > BigInt(q.source_amount) * BigInt(10000 + SWAP_MAX_SLIPPAGE_BPS)) bad(`deposit amount ${units(amt, t.decimals)} ${t.symbol} is more than ${pct(SWAP_MAX_SLIPPAGE_BPS)} above the quote (${units(q.source_amount, t.decimals)})`);
  if (!Number.isSafeInteger(x.targetSats) || x.targetSats! <= 0) bad(`payout ${x.targetSats} sats is not a positive amount`);
  if (x.direction !== (p.to === "lightning" ? "evm_to_lightning" : "evm_to_arkade")) bad(`direction ${x.direction}`);
  if (p.invoice) {
    if (String(x.invoice ?? "").toLowerCase() !== p.invoice.toLowerCase()) bad("the invoice Satora will pay is not the one you gave");
    if (x.targetSats! < p.invoiceSats!) bad(`payout ${x.targetSats} sats does not cover the invoice's ${p.invoiceSats}`);
  } else {
    if (x.targetSats! * 10000 < Number(q.net_target_amount) * (10000 - SWAP_MAX_SLIPPAGE_BPS)) bad(`payout ${x.targetSats} sats is more than ${pct(SWAP_MAX_SLIPPAGE_BPS)} below the quote (${q.net_target_amount})`);
    if (!p.arkAddress) bad("no payout target");
    if (String(x.arkAddress ?? "") !== p.arkAddress) bad(`payout address ${x.arkAddress} is not ${p.arkAddress}`);
    try { checkArkadeAddress(x.arkAddress, { network: c.network, arkServerUrl: c.cfg.arkServerUrl, serverPubkey: (x.raw as any)?.arkade_server_pk ?? null, what: "--address" }); } catch (e: any) { bad(e?.message ?? "bad Ark address"); }
  }
}

/** Where to deposit, how much is still missing (the deposit address may already hold some of the token), and how to send it. */
async function depositInfo(s: Rev, x: ReverseSwapCreated) {
  const t = Object.values(SWAP_TARGETS).find((v) => v.tokenId.toLowerCase() === String(x.tokenContract).toLowerCase())!;
  const need = BigInt(x.sourceUnits!); let have: bigint | undefined; try { have = await s.evm.tokenBalance(t.tokenId, x.depositAddress!); } catch { have = undefined; }
  const base = { address: x.depositAddress, token: t.symbol, contract: t.tokenId, network: t.network, chainId: Number(t.chain), amount: units(need, t.decimals), amountUnits: need.toString() };
  if (have === undefined) return { ...base, howToDeposit: `Send exactly ${units(need, t.decimals)} ${t.symbol} (the ERC-20 at ${t.tokenId} on ${t.network}) to ${x.depositAddress}, ONCE. No ETH needed. Mark could not read the address's balance just now: if you already sent it, do not send again; check ${mk()} swap status ${x.id}.` };
  if (have >= need) return { ...base, alreadyThere: units(have, t.decimals), howToDeposit: `The deposit address already holds ${units(have, t.decimals)} ${t.symbol}: send NOTHING. Run ${mk()} swap fund ${x.id} to lock it into this swap.` };
  return { ...base, ...(have > 0n ? { alreadyThere: units(have, t.decimals) } : {}), send: units(need - have, t.decimals), sendUnits: (need - have).toString(),
    howToDeposit: `Send exactly ${units(need - have, t.decimals)} ${t.symbol} (the ERC-20 at ${t.tokenId} on ${t.network}, not another chain) to ${x.depositAddress}, in ONE transfer. No ETH needed: Mark signs a permit and Satora's relay locks it into the swap.` };
}

const tokenOf = (x: ReverseSwapCreated) => Object.values(SWAP_TARGETS).find((v) => v.tokenId.toLowerCase() === String(x.tokenContract ?? "").toLowerCase());
const isDone = (x: ReverseSwapInfo) => SWAP_DONE.has(x.status) || (x.targetChain === "Lightning" && x.lightningSettled === true);
const doneOut = (x: ReverseSwapInfo) => ({ id: x.id, status: x.status, swap: "done", sats: x.targetSats, ...(x.payoutTx ? { payoutTx: x.payoutTx } : {}),
  note: x.targetChain === "Lightning" ? "Paid out over Lightning." : "Paid out to your Ark address." });

/** What the swap needs next. Never asks for a deposit again once the deposit address holds it, or once a funding was submitted. */
async function fundState(s: Rev, x: ReverseSwapInfo) {
  const t = tokenOf(x); const need = BigInt(x.sourceUnits ?? "0");
  let have: bigint | undefined; try { have = t && x.depositAddress ? await s.evm.tokenBalance(t.tokenId, x.depositAddress) : undefined; } catch { have = undefined; }
  return { t, need, have, attempted: s.fundAttemptedAt(x.id) };
}

/** Lock the deposit into the swap (gasless), once. wait: first wait for the deposit, then for the payout. */
export async function reverseFund(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  if (!id) throw new MarkError("USAGE", "mark swap fund <id>");
  const s = await reverse(c);
  if (o.wait) return waitReverse(s, id, o);
  const x = pinned(s, await s.getReverse(id), "act");
  if (isDone(x)) return doneOut(x);
  if (x.status !== "pending" || x.fundTx) return { id, status: x.status, funded: false, note: x.status === "pending" ? `Funding seen (tx ${x.fundTx}). ${DO_NOT_RESEND}` : `Already past funding (${x.status}): ${nextNote(x)}` };
  const f = await fundState(s, x);
  if (f.have === undefined) return { id, status: x.status, funded: false, note: "Could not read the deposit address's balance; retry shortly. If you already sent the stablecoins, do NOT send again." };
  if (f.have < f.need && f.attempted !== undefined) return { id, status: x.status, funded: false, note: `A funding was submitted at ${new Date(f.attempted).toISOString()}; wait for Satora to see it (${mk()} swap status ${id}). ${DO_NOT_RESEND}` };
  if (f.have < f.need) return { id, status: x.status, funded: false, deposit: { address: x.depositAddress, seen: units(f.have, f.t!.decimals), required: units(f.need, f.t!.decimals) },
    note: f.have > 0n ? `The deposit address holds ${units(f.have, f.t!.decimals)} of ${units(f.need, f.t!.decimals)} ${f.t!.symbol}: only the missing ${units(f.need - f.have, f.t!.decimals)} completes it (do NOT resend the full amount), or get it back with ${mk()} swap recover ${id} --to <0x...>.` : "No deposit seen yet at the deposit address (shown when the swap was created). Run this again once it is sent." };
  return fundOut(x, await s.fundReverse(id));
}
function fundOut(x: ReverseSwapInfo, r: Awaited<ReturnType<Rev["fundReverse"]>>) {
  if (r.success) return { id: x.id, status: x.status, funded: true, ...(r.txHash ? { fundTx: r.txHash, explorer: ARBISCAN_TX + r.txHash } : {}), note: `Funded through Satora's relay. ${DO_NOT_RESEND} Watch it with ${mk()} swap status ${x.id}.` };
  if (r.skipped) return { id: x.id, status: x.status, funded: false, note: `${r.skipped}. ${DO_NOT_RESEND} Check ${mk()} swap status ${x.id}.` };
  if (r.stop) return { id: x.id, status: x.status, funded: false, fundFailed: true, message: r.message, note: `Nothing was signed or locked. If you sent the stablecoins, get them back with ${mk()} swap recover ${x.id} --to <your 0x address> (and start a new swap with a fresh invoice if you still want it). ${DO_NOT_RESEND}` };
  return { id: x.id, status: x.status, funded: false, fundFailed: true, message: r.message, note: r.uncertain
    ? `The relay may still have submitted it: Mark will not sign again for a while. ${DO_NOT_RESEND} Check ${mk()} swap status ${x.id}.`
    : `Satora's relay refused the funding; nothing was locked and your stablecoins are still at the deposit address. Retry ${mk()} swap fund ${x.id}, or get them back with ${mk()} swap recover ${x.id} --to <0x...>. ${DO_NOT_RESEND}` };
}
/** Every later read of a swap from a stablecoin is checked against what was confirmed at create: this Mark home's own deposit
 *  address, and the pinned payout target and deposit terms. act (fund, claim, refund, recover, wait): the swap must also be this
 *  home's. Returns the swap with the pinned values in place of Satora's. */
function pinned(s: Rev, x: ReverseSwapInfo, mode: "show" | "act" | "return"): ReverseSwapInfo {
  notReverse(x);
  const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `swap ${x.id} does not match what was confirmed at create (${why}). Do NOT deposit or send anything for it.`, { id: x.id }); };
  if (mode !== "show" && !x.local) throw new MarkError("SWAP_NOT_LOCAL", "this Mark home does not hold the swap's keys: run it from the Mark home that created it");
  const mine = s.depositAddress();
  if (String(x.depositAddress ?? "").toLowerCase() !== mine.toLowerCase()) bad(`deposit address ${x.depositAddress} is not this Mark home's ${mine}`);
  const pin = s.reversePin(x.id);
  if (pin) {
    if (pin.depositAddress.toLowerCase() !== mine.toLowerCase()) bad(`confirmed deposit address ${pin.depositAddress} is not this Mark home's`);
    if (pin.tokenContract.toLowerCase() !== String(x.tokenContract ?? "").toLowerCase()) bad(`token ${x.tokenContract}`);
    if (pin.sourceUnits !== x.sourceUnits) bad(`deposit amount ${x.sourceUnits} units, confirmed ${pin.sourceUnits}`);
    const ln = !!pin.invoice, want = ln ? SWAP_SOURCES.lightning.chain : SWAP_SOURCES.arkade.chain;
    if (x.targetChain !== want) bad(`payout chain ${x.targetChain}, confirmed ${want}`);
    if (x.direction !== undefined && x.direction !== (ln ? "evm_to_lightning" : "evm_to_arkade")) bad(`direction ${x.direction}`);
    if (ln && String(x.invoice ?? "").toLowerCase() !== pin.invoice!.toLowerCase()) bad("the invoice Satora pays is not the confirmed one");
    if (!ln && x.arkAddress !== pin.arkAddress) bad(`payout address ${x.arkAddress}, confirmed ${pin.arkAddress}`);
  } else if (mode === "act") bad("this Mark home has no record of what was confirmed at create");
  // "return" (refund, recover) works without the record: it only moves funds back through this home's own key to an address you give
  return { ...x, depositAddress: mine, ...(pin?.arkAddress ? { arkAddress: pin.arkAddress } : {}) };
}
function notReverse(x: ReverseSwapInfo) { if (!/^evm_to_/.test(x.direction ?? "")) throw new MarkError("USAGE", `swap ${x.id} is not a swap from a stablecoin (${x.direction})`); }

/** After the swap stops: what to do. Funded and failed: refund it to the deposit address, then recover it; unfunded: recover any deposit. */
function nextNote(x: ReverseSwapInfo) {
  if (isDone(x)) return "Done.";
  if (SWAP_FAILED.has(x.status)) return /refunded/.test(x.status) && x.status !== "clientfundedserverrefunded"
    ? `Refunded to the deposit address: send it to your wallet with ${mk()} swap recover ${x.id} --to <your 0x address>.`
    : x.fundTx || x.status === "clientfundedserverrefunded" || x.status === "clientfundedtoolate" || x.status === "serverwontfund"
      ? `Ended without a payout after your deposit was locked: run ${mk()} swap refund ${x.id} (gasless), then ${mk()} swap recover ${x.id} --to <your 0x address>.`
      : `Ended without a payout (${x.status}). If you deposited, get it back with ${mk()} swap recover ${x.id} --to <your 0x address>.`;
  if ((x.status === "serverfunded" || x.status === "clientredeeming") && x.targetChain === "Arkade") return `Satora funded the Ark payout: claim it with ${mk()} swap claim ${x.id}.`;
  return `In progress (${x.status}). ${DO_NOT_RESEND}`;
}

/** Watch the deposit, fund once, then wait for the payout (claiming an Ark payout when Satora has funded it). */
export async function waitReverse(s: Rev, id: string, o: { timeoutSec?: number; pollMs?: number }) {
  const end = Date.now() + (o.timeoutSec ?? 1800) * 1000; const poll = o.pollMs ?? 5000; let last = "unknown"; let fund: any; let claimed = false;
  while (Date.now() < end) {
    let x: ReverseSwapInfo; try { x = await s.getReverse(id); } catch { await sleep(poll); continue; }
    x = pinned(s, x, "act"); last = x.status;
    if (isDone(x)) return doneOut(x);
    if (x.status === "pending" && !x.fundTx && !fund?.success) {
      const f = await fundState(s, x);
      if (f.have !== undefined && f.have >= f.need && (f.attempted === undefined || Date.now() - f.attempted > 10 * 60 * 1000)) {
        const r = await s.fundReverse(id); fund = r;
        if (!r.success && !r.skipped && !r.uncertain) return fundOut(x, r);
      }
    } else if ((x.status === "serverfunded" || x.status === "clientredeeming") && x.targetChain === "Arkade" && !claimed) {
      const r = await s.claim(id, x.arkAddress!); claimed = r.success;
      if (!r.success) return { id, status: x.status, claimFailed: true, claim: r, note: `Satora funded the Ark payout but the claim failed: retry with ${mk()} swap claim ${id} (same Mark home). ${DO_NOT_RESEND}` };
    } else if (SWAP_FAILED.has(x.status)) return { id, status: x.status, ended: true, note: nextNote(x) };
    await sleep(poll);
  }
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
    out.next = f.attempted !== undefined ? `A funding was submitted; wait for Satora to see it. ${DO_NOT_RESEND}`
      : f.have !== undefined && f.have >= f.need ? `Deposit seen: lock it with ${mk()} swap fund ${x.id}. ${DO_NOT_RESEND}`
      : f.have !== undefined && f.have > 0n ? `Deposit partly seen (${units(f.have, t!.decimals)} of ${units(f.need, t!.decimals)}): only the missing ${units(f.need - f.have, t!.decimals)} completes it; do NOT resend the full amount.`
      : f.have === undefined ? "Could not read the deposit address; if you sent the stablecoins, do NOT send again." : `Waiting for the deposit of ${units(f.need, t!.decimals)} ${t!.symbol} to ${x.depositAddress}.`;
  } else out.next = nextNote(x);
  return out;
}

/** Claim an Ark payout Satora has funded (Lightning payouts need no claim). */
export async function reverseClaim(s: Rev, x0: ReverseSwapInfo) {
  if (isDone(x0)) return doneOut(x0);
  const x = pinned(s, x0, "act");
  if (x.targetChain !== "Arkade") return { id: x.id, status: x.status, claimed: false, note: `A Lightning payout needs no claim: Satora pays the invoice. ${nextNote(x)}` };
  if (x.status !== "serverfunded" && x.status !== "clientredeeming") return { id: x.id, status: x.status, claimed: false, note: nextNote(x) };
  const r = await s.claim(x.id, x.arkAddress!);
  return r.success ? { id: x.id, status: x.status, claimed: true, ...(r.txid ? { txid: r.txid } : {}), note: "Claimed to your Ark address." }
    : { id: x.id, status: x.status, claimFailed: true, claim: r, note: `Claim failed; retry later. ${DO_NOT_RESEND}` };
}

const REFUNDABLE = new Set(["clientfundingseen", "clientfunded"]);
/** Refund a locked deposit that did not pay out, back to the deposit address (gasless), for recover to send on. */
export async function reverseRefund(s: Rev, x0: ReverseSwapInfo) {
  const x = pinned(s, x0, "return");
  if (isDone(x)) throw new MarkError("SWAP_DONE", "this swap paid out: nothing to refund");
  if (x.status === "pending" && !x.fundTx) return { id: x.id, status: x.status, refunded: false, note: `Nothing is locked yet: an unfunded deposit is recovered with ${mk()} swap recover ${x.id} --to <your 0x address>.` };
  // only while the deposit is locked and Satora is not paying out: funded-but-stuck, or ended without a payout
  if (!REFUNDABLE.has(x.status) && !SWAP_FAILED.has(x.status)) return { id: x.id, status: x.status, refunded: false, note: `Not refundable while the payout is under way (${x.status}). ${nextNote(x)}` };
  if (/refunded/.test(x.status) && x.status !== "clientfundedserverrefunded") return { id: x.id, status: x.status, refunded: false, note: nextNote(x) };
  const r = await s.refundReverse(x.id);
  return r.success ? { id: x.id, refunded: true, how: r.how, ...(r.txHash ? { txHash: r.txHash, explorer: ARBISCAN_TX + r.txHash } : {}), note: `Refunded to the deposit address ${x.depositAddress}. Send it to your wallet with ${mk()} swap recover ${x.id} --to <your 0x address>.` }
    : { id: x.id, status: x.status, refunded: false, message: r.message, note: "Satora would not refund it collaboratively and its timelock has not passed (or the refund failed): retry later." };
}

/** Gas for one ERC-20 transfer from the deposit address, with headroom. */
const SWEEP_GAS = 120_000n;
/** Send the swap token from the deposit address to `to` (the stablecoins of an unfunded, failed or refunded swap). */
export async function reverseRecover(c: Ctx, id: string, to: string | undefined) {
  if (!id || !to) throw new MarkError("USAGE", "mark swap recover <id> --to <your 0x address on Arbitrum>");
  const dest = checkEvmAddress(to, "--to"); const s = await reverse(c);
  const first = pinned(s, await s.getReverse(id), "return"); const t = tokenOf(first);
  if (!t) throw new MarkError("SWAP_FAILED", `unknown swap token ${first.tokenContract}`);
  // under the deposit lock: no create or funding of this home can slip in between the checks and the sweep
  return s.exclusive(async () => {
    // re-read under the lock: a funding that took the lock first is seen here, before anything is swept
    const x = pinned(s, await s.getReverse(id), "return"); const at = s.fundAttemptedAt(id);
    if (String(x.tokenContract ?? "").toLowerCase() !== t.tokenId.toLowerCase()) throw new MarkError("SWAP_FAILED", `swap ${id} changed token while recovering (${x.tokenContract}); nothing was moved`);
    if (x.status === "pending" && at !== undefined && Date.now() - at < 10 * 60 * 1000) throw new MarkError("SWAP_FUNDING", "a funding of this swap was just submitted: wait for it (mark swap status) before recovering");
    const others = (await s.openReverse()).filter((o) => o.id !== id && String(o.tokenContract).toLowerCase() === t.tokenId.toLowerCase());
    if (others.length) throw new MarkError("SWAP_OPEN_DEPOSIT", `swap ${others[0].id} is waiting for a ${t.symbol} deposit at the same address: recovering now would take its deposit too. Finish it or let it expire first.`);
    const bal = await s.evm.tokenBalance(t.tokenId, x.depositAddress!);
    if (bal === 0n) return { id, recovered: false, note: `The deposit address holds no ${t.symbol}. ${x.fundTx && !SWAP_FAILED.has(x.status) && !isDone(x) ? `Its deposit is locked in the swap: if it does not pay out, run ${mk()} swap refund ${id} first.` : "Nothing to recover."}` };
    const [eth, gp] = await Promise.all([s.evm.ethBalance(x.depositAddress!), s.evm.gasPrice()]);
    const needWei = SWEEP_GAS * gp * 2n;
    if (eth < needWei) return { id, recovered: false, holds: `${units(bal, t.decimals)} ${t.symbol}`, depositAddress: x.depositAddress,
      note: `Sending tokens out of the deposit address costs a little Arbitrum ETH for gas: send about ${units(needWei - eth, 18)} ETH (Arbitrum One) to ${x.depositAddress}, then run this again.` };
    const r = await s.recoverReverse(id, dest);
    return r.success ? { id, recovered: true, to: dest, amount: r.amountUnits ? units(r.amountUnits, t.decimals) : undefined, token: t.symbol, ...(r.txHash ? { txHash: r.txHash, explorer: ARBISCAN_TX + r.txHash } : {}) }
      : { id, recovered: false, message: r.message, note: "Recovery failed; nothing was moved unless the explorer shows it. Retry later." };
  });
}
