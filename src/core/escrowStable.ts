/** Escrow with stablecoins at the edges (Mark 0.7.0). The escrow itself stays 100% bitcoin (sats on Arkade); Mark wraps Satora's
 *  single-hop swaps around it:
 *  - fund --from usdc|usdt0|usdc-base: a swap from that stablecoin pays the deal's escrow address on Arkade (this Mark home holds
 *    the swap's keys and claims the sats into the escrow only while the deal still waits for funding);
 *  - approve|refund --payout-stable ... --payout-address 0x...: the payee leg pays a Satora Arkade -> stablecoin swap's VHTLC; the
 *    payee's Mark claims the stablecoins (gasless) with claim-payout. The escrow server checks the swap at propose and again right
 *    before the payout is submitted (payout.type "stable"). */
import { MarkError } from "../errors.js";
import { NETWORKS } from "../config.js";
import type { Ctx } from "./context.js";
import type { Escrow, Payout, ProposalFull } from "../api/escrowApi.js";
import type { ReverseSwapCreated, ReverseSwapInfo } from "../swap/provider.js";
import { mk } from "../invocation.js";
import { assertEscrowCap } from "./limits.js";
import { verifyDeal } from "./dealCheck.js";
import { computeFees } from "./fees.js";
import { checkArkadeAddress } from "./arkAddress.js";
import { sleep } from "../util.js";
import { SWAP_FAILED, SWAP_CLAIMABLE, SWAP_DONE } from "../swap/states.js";
import { SWAP_MARKUP_BPS, SWAP_STABLES, SWAP_TARGETS, STABLE_FLAGS, SWAP_FEE_TOTAL_NOTE, targetList, checkEvmAddress, checkMarkupBps, formatReverseQuote, formatSwapQuote, needBridgeFee, tokenLabel, units, sameHex,
  type SwapStable, type StableToken } from "../swap/stable.js";
import { reverse, readerOf, createPinnedReverse, depositInfo, gasOf, inRange, waitReverse, reverseStatus, type Parsed, type Rev } from "./swapReverse.js";
import { stable, checkCreated, swapClaim, quoteStableToCreate } from "./swap.js";
import { requireId, requireKind, submittedPayout, checkFundTerms, withFundLock, myRole, counterpartyRule, expiredNote, expiresAtMs, FUNDED_STATES, dealFee, arkadeServer, type Kind } from "./usecases.js";

/** Least time before the deal expires (deadline + grace) to start a stablecoin funding: the depositor still has to send the
 *  stablecoins, Mark to lock them and Satora to pay the escrow. USDC on Base also waits for Circle's CCTP mint (minutes). */
export const FUND_STABLE_MIN_SEC = 1800, FUND_STABLE_BRIDGED_MIN_SEC = 3600;
/** Extra deposit on top of Satora's quote for the deal's sats, so a price tick between the quote and the create still pays at
 *  least the deal amount (the few extra sats stay in the escrow). */
export const FUND_STABLE_CUSHION_BPS = 50;
/** USDC on Base (bridged over Circle CCTP): Satora's created swap paid ~0.6% below its own quote for the same deposit (live,
 *  26 Nov 2026: 925810 units -> 1498 sats, quote ~1507), so a bridged deposit carries a 1.5% cushion. */
export const FUND_STABLE_BRIDGED_CUSHION_BPS = 150;
const ROUND_TRIP = `two swaps around a bitcoin escrow (each ${SWAP_FEE_TOTAL_NOTE}): the BTC/USD price can move between funding and payout, so the USD amount paid out can differ from the USD deposited.`;
/** Shown when funding with stablecoins (the payout may be in stablecoins too) and when paying out in stablecoins. */
export const ROUND_TRIP_NOTE = `If the payout is in stablecoins too, that is ${ROUND_TRIP}`;
export const PAYOUT_ROUND_TRIP_NOTE = `If the escrow was funded with stablecoins as well, that is ${ROUND_TRIP}`;
const ESCROW_IS_BTC = "The escrow itself holds bitcoin (sats on Arkade); the stablecoins are swapped at the edges by Satora.";

/** --from / --payout-stable: usdc | usdt0 (usdt) | usdc-base. */
export function stableToken(v: unknown, flag: string): SwapStable {
  const k = String(v ?? "").trim().toLowerCase().replace(/^usdt$/, "usdt0");
  if (!(SWAP_STABLES as readonly string[]).includes(k)) throw new MarkError("USAGE", `${flag} must be ${STABLE_FLAGS} (${targetList(SWAP_STABLES)})`);
  return k as SwapStable;
}
function mainnet(c: Ctx, what: string) {
  if (!NETWORKS[c.network].isMainnet) throw new MarkError("SWAP_UNSUPPORTED_NETWORK", `${what} runs on bitcoin mainnet only: Satora has no stablecoin route on ${c.network}. Use Lightning or Ark on this network.`);
}
/** About how many USD (the stablecoins track the dollar) `sats` are at the quote's rate; undefined without a usable rate. */
export function usdOf(sats: number, rate: unknown): string | undefined {
  const r = Number(rate); if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(sats)) return undefined;
  return `~$${((sats / 1e8) * r).toFixed(2)}`;
}
function escrowFees(e: Escrow, sats: number) {
  if (!e.fees) return { platformFeeSats: 0, possibleDisputeFeeSats: 0, note: "no platform fee (legacy deal)" };
  const n = computeFees(e.fees, sats, sats, false), d = computeFees(e.fees, sats, sats, true);
  return { platformFeeSats: n.platformFeeSats + n.dustBumpSats, possibleDisputeFeeSats: d.disputeFeeSats, note: "taken from the payout, never from the deposit; a dispute fee applies only to a ruled dispute" };
}

/** The stablecoin deposit (token units) whose swap pays at least `dealSats` into the escrow, plus the cushion. Satora's quote by
 *  target treats targetAmount as the GROSS sats (live, 26 Nov 2026: target 2000 -> a deposit that pays 1976 net once the swap fees
 *  are taken), and the swap is created from the deposit: so the deposit is priced by source, re-quoted and grossed up until its
 *  net payout covers the deal (at most 3 rounds), then the cushion is added (a price tick between this quote and the create must
 *  still pay the deal). Returns the last quote (the one the swap is created from) and the deposit. Nothing is created. */
export async function priceStableDeposit(s: Rev, from: SwapStable, dealSats: number, bps: number): Promise<{ qs: any; sourceUnits: bigint }> {
  const t = SWAP_TARGETS[from];
  const q = await s.quoteReverse({ from, to: "arkade", bps, targetSats: dealSats });
  if (!/^\d+$/.test(String(q?.source_amount ?? "")) || BigInt(q.source_amount) <= 0n || !(Number(q?.net_target_amount) > 0)) throw new MarkError("QUOTE_UNAVAILABLE", "Satora's quote has no amounts; nothing was created. Retry later.");
  needBridgeFee(t, q);
  if (!inRange(q)) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for ${tokenLabel(t)} -> Arkade; this deal is ${dealSats} sats. Use Lightning or Ark.`, { minSats: q.min_amount, maxSats: q.max_amount });
  let src = BigInt(q.source_amount), qs: any;
  for (let i = 0; ; i++) {
    qs = await s.quoteReverse({ from, to: "arkade", bps, sourceUnits: src });
    const net = Number(qs?.net_target_amount);
    if (!Number.isSafeInteger(net) || net <= 0) throw new MarkError("QUOTE_UNAVAILABLE", "Satora's quote has no payout amount; nothing was created. Retry later.");
    if (net >= dealSats) break;
    if (i >= 2) throw new MarkError("QUOTE_UNAVAILABLE", `Satora's quote for a ${tokenLabel(t)} deposit does not reach the deal's ${dealSats} sats (${net} net); nothing was created. Retry later.`, { netSats: net, dealSats });
    src = (src * BigInt(dealSats) + BigInt(net) - 1n) / BigInt(net) + 1n;
  }
  needBridgeFee(t, qs);
  if (!inRange(qs)) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${qs.min_amount}..${qs.max_amount} sats for ${tokenLabel(t)} -> Arkade; this deal needs a ${tokenLabel(t)} deposit outside that range. Use Lightning or Ark.`, { minSats: qs.min_amount, maxSats: qs.max_amount });
  return { qs, sourceUnits: (src * BigInt(10000 + (t.bridge ? FUND_STABLE_BRIDGED_CUSHION_BPS : FUND_STABLE_CUSHION_BPS)) + 9999n) / 10000n };
}

// ---------- fund --from usdc|usdt0|usdc-base ----------
export interface FundStableOpts { from: string; wait?: boolean; timeoutSec?: number; pollMs?: number; switchRail?: boolean; allowCounterpartyRule?: boolean; onInstructions?: (x: unknown) => void }

/** Fund the escrow from a stablecoin: Satora swaps it into sats paid to the escrow address on Arkade. Same checks as Lightning
 *  funding (terms, address, arbiter, rule, one rail, deadline); the swap must pay at least the deal amount. wait: watch the deposit,
 *  lock it (gasless; Base: approve + burn, ETH checked first), claim the sats into the escrow and wait until the deal is funded. */
export async function fundStable(c: Ctx, id: string, o: FundStableOpts) {
  const from = stableToken(o.from, "--from"); const t = SWAP_TARGETS[from];
  mainnet(c, `mark escrow fund --from ${from}`);
  const e = await c.api.get(requireId(id));
  assertEscrowCap(c.cfg, e.amountSats);
  const l0 = c.index.get(id);
  const recoverHint = l0.fundStableSwap ? ` If you deposited stablecoins for swap ${l0.fundStableSwap}, get them back: ${mk()} swap refund ${l0.fundStableSwap} (only if it was locked), then ${mk()} swap recover ${l0.fundStableSwap} --to <your 0x address>.` : "";
  if (e.state === "expired") return { escrowId: id, rail: "stable", state: e.state, expiredAt: e.expiredAt ?? null, note: expiredNote(e) + recoverHint, ...(l0.fundStableSwap ? { swapId: l0.fundStableSwap } : {}) };
  if (e.state !== "created") return { escrowId: id, rail: "stable", state: e.state, note: "already funded", ...(l0.fundStableSwap ? { swapId: l0.fundStableSwap } : {}) };
  const { v, l } = checkFundTerms(c, e, id);
  const s = await reverse(c);
  const otherRail = async (cur: typeof l) => {
    if (o.switchRail) return;
    if (cur.fundRail === "ark") throw new MarkError("FUNDING_IN_PROGRESS", `you chose direct Ark funding for this deal (${mk()} escrow fund ${id} --ark, ${cur.fundArkAt ?? "earlier"}). Stablecoins as well could fund it twice. If you paid the escrow address, run ${mk()} escrow fund ${id} --ark --wait. Only if you did NOT pay it and will not: ${mk()} escrow fund ${id} --from ${from} --switch-rail`, { rail: "ark" });
    if (cur.fundSwap && cur.fundRail !== "stable") {
      let st: string | undefined; try { st = (await s.get(cur.fundSwap)).status; } catch { st = undefined; }
      if (!st || !SWAP_FAILED.has(st)) throw new MarkError("FUNDING_IN_PROGRESS", `a Lightning funding invoice already exists for this deal (swap ${cur.fundSwap}, status ${st ?? "unknown"}). Stablecoins as well could fund it twice. Continue with Lightning: ${mk()} escrow fund ${id}. Only if that invoice was NOT paid and will not be: ${mk()} escrow fund ${id} --from ${from} --switch-rail`, { rail: "lightning", swapId: cur.fundSwap, swapStatus: st ?? null });
    }
  };
  await otherRail(l);
  // address = the 2-of-3 contract of the deal's keys, arbiter attested: never swap into an unchecked address
  const check = await verifyDeal(c, e);
  const risk = l.fundRail === "stable" || (v.termsVersion === 2 && v.agreed) ? null : counterpartyRule(c, e, l.role ?? myRole(c, e));
  if (risk && !o.allowCounterpartyRule) throw new MarkError("UNSAFE_RULE", `refusing to fund: ${risk.warning} To fund anyway: ${mk()} escrow fund ${id} --from ${from} --allow-counterparty-rule`, risk);
  const base = { escrowId: id, rail: "stable", from, token: tokenLabel(t), escrowAddress: e.address, amountSats: e.amountSats, dealCheck: check, ...((v as any).termsWarning ? { termsWarning: (v as any).termsWarning } : {}) };

  // an existing swap for this deal: show where it stands (or keep waiting); a new one only after an unfunded swap expired
  let existing: ReverseSwapInfo | undefined;
  if (l.fundStableSwap) {
    try { existing = await s.getReverse(l.fundStableSwap); }
    catch (x: any) { if (!o.wait) return { ...base, swapId: l.fundStableSwap, swapStatus: "unknown", note: `could not read the funding swap from Satora (${String(x?.message ?? x).slice(0, 120)}); no deposit instructions are shown. Try again: ${mk()} escrow fund ${id} --from ${from}` }; }
  }
  const fresh = !existing ? !l.fundStableSwap : existing.status === "expired" && !existing.fundTx;
  // another token while this deal's swap can still take (or holds) a deposit: refused (an expired unfunded one is replaced)
  if (l.fundStableSwap && l.fundStableFrom && l.fundStableFrom !== from && !fresh) throw new MarkError("FUNDING_IN_PROGRESS", `this deal's stablecoin funding swap ${l.fundStableSwap} is from ${l.fundStableFrom}: continue with ${mk()} escrow fund ${id} --from ${l.fundStableFrom}`, { swapId: l.fundStableSwap, from: l.fundStableFrom });
  let created: ReverseSwapCreated | undefined; let quote: ReturnType<typeof formatReverseQuote> | undefined; let gas: Awaited<ReturnType<typeof gasOf>> = null; let rate: string | undefined;
  if (fresh) {
    const left = Math.floor((expiresAtMs(e) - Date.now()) / 1000); const min = t.bridge ? FUND_STABLE_BRIDGED_MIN_SEC : FUND_STABLE_MIN_SEC;
    if (left < min) throw new MarkError("DEADLINE_TOO_CLOSE", `refusing to fund from ${tokenLabel(t)}: the deal expires in ${Math.max(0, left)} s (deadline ${e.deadline} + grace), less than the ${min} s a stablecoin funding needs (deposit, lock${t.bridge ? `, ${t.bridge.via} mint` : ""}, swap). Stablecoins that arrive later do not fund the deal and must be recovered. Use Lightning, or create a new deal with a later deadline.`, { expiresAt: new Date(expiresAtMs(e)).toISOString(), secondsLeft: Math.max(0, left), minSeconds: min });
    if (t.bridge) { readerOf(s, t); if (!s.cctpBurn) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} cannot track a ${t.bridge.via} burn; not creating a swap from ${tokenLabel(t)}`); }
    const r = await withFundLock(c, id, async () => {
      const cur = c.index.get(id);
      // rail and token are re-checked under the lock BEFORE reusing a swap another process just created
      await otherRail(cur);
      if (cur.fundStableSwap && cur.fundStableSwap !== l.fundStableSwap) {
        if (cur.fundStableFrom && cur.fundStableFrom !== from) throw new MarkError("FUNDING_IN_PROGRESS", `a stablecoin funding swap ${cur.fundStableSwap} from ${cur.fundStableFrom} was just created for this deal: continue with ${mk()} escrow fund ${id} --from ${cur.fundStableFrom}`, { swapId: cur.fundStableSwap, from: cur.fundStableFrom });
        return { reuse: cur.fundStableSwap };
      }
      const bps = checkMarkupBps(SWAP_MARKUP_BPS);
      const [{ qs, sourceUnits }, g] = await Promise.all([priceStableDeposit(s, from, e.amountSats, bps), gasOf(s, t)]);
      const p: Parsed = { from, to: "arkade", bps, arkAddress: e.address, sourceUnits, token: t } as Parsed;
      const x = await createPinnedReverse(c, s, p, qs, (x) => {
        const bad = (why: string) => { throw new MarkError("SWAP_FAILED", `Satora's swap does not fund this deal (${why}). Do NOT deposit anything; nothing is lost while it is unfunded (it just expires).`, { id: x?.id }); };
        if (!Number.isSafeInteger(x.targetSats) || x.targetSats! < e.amountSats) bad(`it pays ${x.targetSats} sats, the deal needs ${e.amountSats}`);
        if (x.targetSats! > Math.ceil(e.amountSats * 1.03)) bad(`it pays ${x.targetSats} sats, far more than the deal's ${e.amountSats}`);
        const pk = String((x.raw as any)?.arkade_server_pk ?? "").toLowerCase().slice(-64);
        if (!e.serverPubkey || pk !== String(e.serverPubkey).toLowerCase().slice(-64)) bad(`Satora's Arkade server key ${pk || "(none)"} is not this deal's Arkade server`);
      });
      c.index.set(id, { fundStableSwap: x.id, fundStableFrom: from, fundStableAt: new Date().toISOString(), fundRail: "stable", role: l.role ?? myRole(c, e) });
      return { x, q: qs, g };
    });
    if ("reuse" in r) { existing = await s.getReverse(r.reuse!); }
    else { created = r.x; gas = r.g; quote = formatReverseQuote(r.q, { from, to: "arkade", bps: SWAP_MARKUP_BPS, gas }); rate = r.q.exchange_rate; }
  } else if (l.fundRail !== "stable") {
    // resuming this deal's stable swap (allowed by the rail checks above): record the rail, so fund / fund --ark refuse while it is live
    await withFundLock(c, id, async () => { await otherRail(c.index.get(id)); c.index.set(id, { fundRail: "stable" }); });
  }
  const swapId = created?.id ?? existing?.id ?? l.fundStableSwap!;
  // the platform fee is on what the escrow will hold: the swap's payout (deal amount + cushion), which can cross a fee tier
  const fees = escrowFees(e, created?.targetSats ?? e.amountSats);
  if (created) {
    const deposit = await depositInfo(s, created, gas);
    const extra = created.targetSats! - e.amountSats;
    const first = { ...base, swapId, newSwap: true, swapStatus: created.status, deposit, swapPaysSats: created.targetSats, extraSats: extra, ...(rate ? { amountUsd: usdOf(e.amountSats, rate) } : {}), quote,
      fees: { escrow: fees, swap: quote!.fees, note: quote!.markupNote },
      disclosure: [
        `${deposit.howToDeposit}`,
        `Satora swaps it into ${created.targetSats} sats paid to the escrow address ${e.address}; the deal needs ${e.amountSats}${extra > 0 ? ` (the ${extra} extra sats cover price ticks and stay in the escrow: the payout gets them)` : ""}.`,
        `Swap fee: ${quote!.markupNote}`,
        `Escrow platform fee: ${fees.platformFeeSats} sats (${fees.note}).`,
        ...(t.bridge ? [`From ${tokenLabel(t)}: keep a little ETH on ${t.network} at ${deposit.address} for gas (${(deposit as any).gas?.needEth ?? "about 0.0001"} ETH); Mark checks it before signing.`] : []),
        ROUND_TRIP_NOTE, ESCROW_IS_BTC,
      ],
      next: o.wait && o.onInstructions ? "Waiting for the deposit; then Mark locks it, claims the sats into the escrow and waits until the deal is funded." : `After the deposit, run: ${mk()} escrow fund ${id} --from ${from} --wait  (locks it, claims the sats into the escrow). If it fails: ${mk()} swap refund ${swapId}, then ${mk()} swap recover ${swapId} --to <your 0x address>` };
    // without a way to show the deposit instructions first (MCP), never wait blind: return them; the next call with wait locks and claims
    if (!o.wait || !o.onInstructions) return first;
    o.onInstructions(first);
  } else if (!o.wait) {
    const st = await reverseStatus(s, existing!);
    const claimable = SWAP_CLAIMABLE.has(existing!.status) && existing!.targetChain === "Arkade";
    return { ...base, swapId, newSwap: false, swapStatus: existing!.status, swap: st,
      next: claimable ? `Satora funded the sats: claim them into the escrow with ${mk()} escrow fund ${id} --from ${from} --wait` : SWAP_FAILED.has(existing!.status) ? `${(st as any).next ?? ""} This deal is not funded: fund it again (${mk()} escrow fund ${id} --from ${from}) or use Lightning (--switch-rail).`
        : SWAP_DONE.has(existing!.status) ? `Paid into the escrow; check ${mk()} escrow status ${id}` : `${(st as any).next ?? ""} Then: ${mk()} escrow fund ${id} --from ${from} --wait` };
  }
  // wait: deposit -> lock -> Satora pays the VHTLC -> claim into the escrow, only while the deal still waits for funding
  const guard = async () => {
    let now_: Escrow; try { now_ = await c.api.get(id); } catch { return "could not read the deal from the escrow server just now, so nothing was claimed; run the same command again."; }
    if (now_.state === "expired") return `the deal expired before the swap paid out: NOT claimed into the escrow. The sats stay in the swap; Satora refunds the swap after its timelock, then: ${mk()} swap refund ${swapId} and ${mk()} swap recover ${swapId} --to <your 0x address>.`;
    if (FUNDED_STATES.has(now_.state)) return `the deal is already funded (another payment): NOT claimed into the escrow. Get the stablecoins back after the swap's timelock: ${mk()} swap refund ${swapId}, then ${mk()} swap recover ${swapId} --to <your 0x address>.`;
    if (now_.state !== "created") return `the deal is ${now_.state}: NOT claimed into the escrow. Check ${mk()} escrow status ${id}.`;
    // Satora may re-price an Arkade payout at funding (the swap check allows 1% below what was confirmed): it must still cover the deal
    let sw: ReverseSwapInfo; try { sw = await s.getReverse(swapId); } catch { return "could not read the funding swap from Satora just now, so nothing was claimed; run the same command again."; }
    if (!Number.isSafeInteger(sw.targetSats) || sw.targetSats! < now_.amountSats) return `the swap now pays ${sw.targetSats} sats, less than the deal's ${now_.amountSats}: NOT claimed into the escrow (it would not fund the deal). Get the stablecoins back after the swap's timelock: ${mk()} swap refund ${swapId}, then ${mk()} swap recover ${swapId} --to <your 0x address>.`;
    return undefined;
  };
  const w: any = await waitReverse(s, swapId, { timeoutSec: o.timeoutSec ?? 1800, pollMs: o.pollMs, claimGuard: guard, retryHint: `${mk()} escrow fund ${id} --from ${from} --wait` });
  let deal = await c.api.get(id).catch(() => null);
  if (w?.swap === "done" && deal?.state === "created") for (let i = 0; i < 5 && deal?.state === "created"; i++) { await sleep(o.pollMs ?? 2000); deal = await c.api.get(id).catch(() => deal); }
  const funded = !!deal && FUNDED_STATES.has(deal.state);
  // funded BY THIS SWAP only when its sats were claimed into the escrow (swap done, the guard did not stop it); a deal funded
  // by another payment while the swap timed out or failed is never reported as this swap's funding
  const bySwap = funded && w?.swap === "done" && !w?.notClaimed;
  let ledger: unknown;
  // funded by something else (the guard stopped the claim): never report this swap as the funding
  if (bySwap) { try { ledger = await c.api.reportArkFunding(id); } catch { ledger = undefined; } }
  return { ...base, swapId, swap: w, state: deal?.state ?? "unknown", funded, fundedBySwap: bySwap, ...(funded ? { funding: deal!.funding ?? null, escrow: deal } : {}), ...(ledger !== undefined ? { ledger } : {}),
    ...(w?.notClaimed ? { claimedIntoEscrow: false } : {}),
    note: w?.notClaimed ? w.note : bySwap ? "Funded: the escrow holds the sats." : funded ? `The deal is funded, but not (yet) by this swap (swap ${w?.status ?? "unknown"}): do NOT claim it into the escrow. ${w?.note ?? ""} Get the stablecoins back after the swap's timelock: ${mk()} swap refund ${swapId}, then ${mk()} swap recover ${swapId} --to <your 0x address>.` : w?.timeout ? `${w.note} Then: ${mk()} escrow fund ${id} --from ${from} --wait` : w?.note ?? `Check ${mk()} escrow status ${id}` };
}

// ---------- payout in stablecoins (approve / refund --payout-stable) ----------
export interface StablePayoutOpts { payoutStable?: string; payoutAddress?: string }
/** The payee's Mark creates a Satora Arkade -> stablecoin swap asking for exactly the payee leg, paying out to the payee's EVM
 *  address; the escrow tx pays its VHTLC (on this escrow's Arkade server). Its claim key stays in this Mark home. */
export async function stablePayoutSpec(c: Ctx, e: Escrow, _kind: Kind, o: StablePayoutOpts): Promise<{ payout: Payout; authDest: string; swap: { id: string; fundAddress: string; fundAmountSats: number }; stable: Record<string, unknown> }> {
  const to = stableToken(o.payoutStable, "--payout-stable"); const t = SWAP_TARGETS[to];
  mainnet(c, "a stablecoin payout (--payout-stable)");
  const address = checkEvmAddress(o.payoutAddress, "--payout-address", t.network);
  const amount = dealFee(e).payeeSats; const bps = checkMarkupBps(SWAP_MARKUP_BPS);
  const s = await stable(c);
  const q = await quoteStableToCreate(s, { from: "arkade", to, sats: amount, bps }, t);
  if (amount < q.min_amount || amount > q.max_amount) throw new MarkError("SWAP_AMOUNT", `Satora accepts ${q.min_amount}..${q.max_amount} sats for Arkade -> ${tokenLabel(t)}; the payee leg is ${amount} sats. Use --payout-lnaddr, --payout-invoice or --payout-ark.`, { minSats: q.min_amount, maxSats: q.max_amount, payeeLegSats: amount });
  const created = await s.createStable({ from: "arkade", to, sats: amount, bps, address });
  checkCreated(c, { from: "arkade", to, sats: amount }, address, created, q.net_target_amount);
  // the escrow tx pays this VHTLC: it must be on this deal's Arkade server (key in the deal), never just "an Ark address"
  const ark = await arkadeServer(c, e);
  if (!ark.pubkey) throw new MarkError("BAD_DEST", "can't check the payout swap's Ark address right now (this deal's Arkade server key is unknown). Try again when the escrow server answers.");
  try { checkArkadeAddress(created.arkAddress, { network: c.network, serverPubkey: ark.pubkey, arkServerUrl: ark.url, what: "payout swap address" }); }
  catch (x: any) { throw new MarkError("SWAP_FAILED", `Satora's payout swap is not on this escrow's Arkade server (${x?.message ?? x}); nothing was proposed. Swap ${created.id} is unfunded and can be ignored.`, { id: created.id }); }
  const quote = formatSwapQuote(q, { from: "arkade", to, sats: amount, bps });
  const expectUnits = t.bridge && BigInt(q.net_target_amount) < BigInt(created.receiveUnits!) ? q.net_target_amount : created.receiveUnits;
  return { payout: { type: "stable", address, swapId: created.id, token: to }, authDest: `swap:${created.id}`, swap: { id: created.id, fundAddress: created.arkAddress!, fundAmountSats: created.payAmountSats },
    stable: { swapId: created.id, token: tokenLabel(t), payoutAddress: address, payoutNetwork: t.network, payeeLegSats: amount, payeeLegUsd: usdOf(amount, q.exchange_rate), expectedReceive: units(expectUnits, t.decimals),
      fees: { escrow: { platformFeeSats: dealFee(e).feeOutputSats, reason: dealFee(e).reason }, swap: quote.fees, note: quote.markupNote }, rate: quote.rate,
      receiveNote: "expectedReceive is Satora's estimate: the BTC is swapped into the stablecoin on a DEX at claim, so the amount that arrives can be a little different.",
      roundTrip: PAYOUT_ROUND_TRIP_NOTE } };
}

/** Before signing its own stablecoin payout proposal, the payee checks the server returned exactly that proposal: same kind, this
 *  swap's VHTLC as destination, same swap, EVM address and token. */
export function checkOwnStableProposal(prop: ProposalFull, kind: Kind, want: Payout, vhtlc: string) {
  const po: any = prop.payout ?? {}, w: any = want;
  if (prop.kind !== kind || prop.dest !== vhtlc || po.type !== "stable" || po.swapId !== w.swapId || !sameHex(po.address, w.address) || (po.token ?? w.token) !== w.token)
    throw new MarkError("UNSAFE_TX", `the escrow server returned a proposal that is not the stablecoin payout just proposed (swap ${w.swapId} to ${w.address}); refusing to sign`, { proposalId: prop.id });
}
/** A co-signer (and the payee) checks a stablecoin payout at Satora before signing: an unfunded Arkade -> stablecoin swap asking for
 *  exactly the payee leg, paying the stated EVM address, whose VHTLC is the tx destination. Fails closed when Satora can't be read. */
export async function checkStableProposal(c: Ctx, e: Escrow, p: ProposalFull) {
  const po: any = p.payout ?? {};
  const s = await c.swaps(); if (!s.getStable) throw new MarkError("BAD_CONFIG", `swap provider ${s.name} cannot read a stablecoin payout swap; refusing to sign`);
  let x; try { x = await s.getStable(String(po.swapId ?? "")); } catch (err: any) { throw new MarkError("SWAP_UNREACHABLE", `could not check the stablecoin payout swap ${po.swapId} at Satora (${String(err?.message ?? err).slice(0, 120)}); refusing to sign. Try again shortly.`); }
  const raw: any = x.raw ?? {}; const held = dealFee(e).payeeSats;
  const why = x.direction !== "arkade_to_evm" ? `direction ${x.direction}` : x.status !== "pending" ? `status ${x.status}` : x.sourceAmountSats !== held ? `it asks for ${x.sourceAmountSats} sats, the payee leg is ${held}`
    : !sameHex(raw.target_evm_address, po.address) ? `it pays ${raw.target_evm_address}, the proposal says ${po.address}` : raw.btc_vhtlc_address !== p.dest ? "its Ark address is not the payout tx's destination" : null;
  if (why) throw new MarkError("UNSAFE_TX", `the stablecoin payout swap ${po.swapId} does not match the proposal (${why}); refusing to sign`, { swapId: po.swapId });
  const t = po.token && Object.hasOwn(SWAP_TARGETS, po.token) ? SWAP_TARGETS[po.token as SwapStable] : undefined;
  return { swapStatus: x.status, token: t ? tokenLabel(t) : po.token ?? null, evmAddress: po.address, swapAsksSats: x.sourceAmountSats };
}

// ---------- claim-payout ----------
/** Claim the stablecoins of this deal's payout swap (gasless, to the address fixed at create). wait: until Satora funds its side. */
export async function claimPayout(c: Ctx, id: string, o: { wait?: boolean; timeoutSec?: number; pollMs?: number } = {}) {
  const l = c.index.get(requireId(id));
  let e: Escrow | null = null; try { e = await c.api.get(id); } catch { e = null; }
  // the swap to claim is the one in the proposal that was actually submitted (a later, failed or unused proposal may have
  // created another swap); before submission, this home's latest accepted stablecoin proposal
  let swapId = l.payoutStable ? l.payoutSwap : undefined, token = l.payoutStable, address = l.payoutAddress;
  const sp = await submittedPayout(c, id, e);
  if (sp) {
    const po = sp.payout;
    if (po && po.type !== "stable") throw new MarkError("USAGE", `escrow ${id}'s submitted payout is ${po.type}, not a stablecoin payout: nothing to claim here`);
    if (!po?.swapId) throw new MarkError("ESCROW_BAD_RESPONSE", `escrow ${id}'s submitted proposal ${sp.pid} names no payout swap: not guessing which swap it paid`);
    swapId = po.swapId; token = po.token ?? token; address = po.address ?? address;
  }
  if (!swapId) {
    if (l.payoutSwap) throw new MarkError("USAGE", `escrow ${id}'s payout swap pays Lightning: Satora pays it, nothing to claim. A failed one: ${mk()} escrow refund-payout ${id} --to <ark address>`);
    throw new MarkError("NOT_FOUND", `no stablecoin payout swap recorded for escrow ${id} in this Mark home (run it from the Mark home that proposed the payout)`);
  }
  mainnet(c, "mark escrow claim-payout");
  const sent = !!e && (e.state === "released" || e.state === "refunded");
  const base = { escrowId: id, payoutSwap: swapId, payoutStable: token ?? null, payoutAddress: address ?? null, state: e?.state ?? "unknown" };
  if (!sent && !o.wait) return { ...base, claimed: false, note: `the payout tx is not submitted yet (deal ${e?.state ?? "unreadable"}): the other signer has to sign first. Then: ${mk()} escrow claim-payout ${id} --wait` };
  const r: any = await swapClaim(c, swapId, { wait: o.wait, timeoutSec: o.timeoutSec ?? 1800, pollMs: o.pollMs });
  const ended = r?.ended || (r?.status && SWAP_FAILED.has(r.status));
  return { ...base, ...r, ...(ended ? { recover: `the payout swap ended without a payout: after its timelock, get the sats back with ${mk()} escrow refund-payout ${id} --to <ark address from an Arkade wallet on this escrow's Arkade server>` } : {}) };
}

// ---------- quote --payout-stable ----------
/** Preview a stablecoin payout for this deal (nothing is created): the payee leg from the escrow server's quote, then Satora's
 *  live Arkade -> stablecoin quote for exactly that, with every fee. */
export async function quoteStablePayout(c: Ctx, id: string, path: Kind, payoutStable: string) {
  const to = stableToken(payoutStable, "--payout-stable"); const t = SWAP_TARGETS[to];
  mainnet(c, "a stablecoin payout quote");
  const kind = requireKind(path);
  const eq = await c.api.quote(requireId(id), kind);
  const sats = Number(eq.ark?.payoutSats); if (!Number.isSafeInteger(sats) || sats <= 0) throw new MarkError("QUOTE_UNAVAILABLE", "the escrow server's quote has no payee leg");
  const bps = checkMarkupBps(SWAP_MARKUP_BPS); const s = await stable(c);
  const q = await s.quoteStable({ from: "arkade", to, sats, bps });
  needBridgeFee(t, q, false);
  const quote = formatSwapQuote(q, { from: "arkade", to, sats, bps });
  const inRange_ = sats >= q.min_amount && sats <= q.max_amount, escrowFeeSats = Math.max(0, eq.escrowSats - sats);
  return { escrowId: id, path: kind, payoutStable: to, token: tokenLabel(t), escrowSats: eq.escrowSats, payeeLegSats: sats, escrowFeeSats, payeeLegUsd: usdOf(sats, q.exchange_rate),
    receive: quote.receive, quote, totalFees: { escrowFeeSats, swapFeeSats: quote.fees.totalFeeSats, ...(t.bridge ? { bridgeFee: `${(quote.fees as any).bridgeFee ?? "?"} ${t.symbol}` } : {}) },
    note: `${quote.markupNote} The escrow fee is taken from the escrow first (payee leg ${sats} sats); the swap converts exactly that. ${PAYOUT_ROUND_TRIP_NOTE}`,
    ...(inRange_ ? {} : { outOfRange: `Satora accepts ${q.min_amount}..${q.max_amount} sats for this route: use Lightning or Ark for this payout` }),
    next: `${mk()} escrow ${kind === "release" ? "approve" : "refund"} ${id} --payout-stable ${to} --payout-address <your 0x address on ${t.network}>` };
}
export type { StableToken };
