/** `mark swap`: BTC (Lightning or Arkade) to a stablecoin (USDC / USDT0 on Arbitrum One, USDC on Base) through Satora. Pure constants, fee math and input checks
 *  (no network, no keys), shared by the provider, the use-cases, the CLI and MCP. Standalone: nothing here touches the escrow. */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { MarkError } from "../errors.js";

/** Agent Escrow's public Satora referral ID. Sent on EVERY swap quote and swap create; public, not a secret. */
export const SWAP_REFERRAL_ID = "lnds_29617a89f8a6b5a7";
/** Agent Escrow markup in basis points (50 = 0.5%), sent to Satora as `extraFees` (bps) with the SAME value on getQuote and
 *  createSwap. The one place the markup is set. */
export const SWAP_MARKUP_BPS = 50;
/** Hard cap: Mark refuses any markup above this (Satora also caps our referral key at 100 bps). */
export const SWAP_MARKUP_CAP_BPS = 100;

/** The markup to send, checked: a whole number of bps from 0 to SWAP_MARKUP_CAP_BPS, else BAD_MARKUP (nothing is sent). */
export function checkMarkupBps(bps: number = SWAP_MARKUP_BPS): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > SWAP_MARKUP_CAP_BPS) throw new MarkError("BAD_MARKUP", `swap markup must be a whole number of bps from 0 to ${SWAP_MARKUP_CAP_BPS} (got ${bps})`);
  return bps;
}
/** The created swap may promise at most this much less than the quote just shown (price moves between the two calls); more is refused. */
export const SWAP_MAX_SLIPPAGE_BPS = 100;
/** "0.5%" for 50 bps; "1%" for 100. Trailing zeros after the decimal are dropped. */
export const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
/** "0.5%" for 0.005; "1%" for 0.01. Same formatting as pct(), from a rate rather than bps. */
export const ratePct = (rate: number) => `${+(rate * 100).toFixed(2)}%`;
/** Wording when no live quote is available for a stablecoin route (docs, MCP descriptions). Satora's pair fee on those routes is typically ~0.5%. */
export const SWAP_FEE_TOTAL_NOTE = `about 1% total (Satora ~0.5% + Agent Escrow ${pct(SWAP_MARKUP_BPS)}) plus network fee`;
/** Lightning → Arkade, no live quote. Satora's pair fee is typically ~0.15%; the live quote's network fee can differ from /network-fees. */
export const SWAP_FEE_LN_ARKADE_NOTE = `about 0.65% total (Satora ~0.15% + Agent Escrow ${pct(SWAP_MARKUP_BPS)}) plus network fee`;
/** Arkade → Lightning, no live quote. Satora's pair fee is typically ~0.30%; the Lightning network fee comes from the live quote (/network-fees can differ). */
export const SWAP_FEE_ARKADE_LN_NOTE = `about 0.80% total (Satora ~0.30% + Agent Escrow ${pct(SWAP_MARKUP_BPS)}) plus network fee`;
/** Static wording for a route when no live quote is available. */
export function routeFeeNote(route: SwapRoute): string {
  if (route.dir === "rail") return route.from === "lightning" ? SWAP_FEE_LN_ARKADE_NOTE : SWAP_FEE_ARKADE_LN_NOTE;
  if (route.dir === "to_stable" && SWAP_TARGETS[route.to].bridge) return `${SWAP_FEE_TOTAL_NOTE}; ${SWAP_FEE_BRIDGE_NOTE}`;
  if (route.dir === "to_btc" && SWAP_TARGETS[route.from].bridge) return `${SWAP_FEE_TOTAL_NOTE}; ${SWAP_FEE_BRIDGE_IN_NOTE}`;
  return SWAP_FEE_TOTAL_NOTE;
}
/** USDC on Base, no live quote: Satora bridges it from Arbitrum One over Circle CCTP; Circle's fee is taken from the payout in USDC. */
export const SWAP_FEE_BRIDGE_NOTE = "USDC on Base also pays Circle's CCTP bridge fee (about 0.05 USDC, in USDC, taken from the payout; the live quote shows it)";
/** USDC on Base -> BTC, no live quote: Circle's fast-transfer fee (IRIS: 1.3 bps, Satora caps it at +20%) comes out of the deposit;
 *  the approve + burn on Base are paid in ETH on Base by the deposit address (see BRIDGE_IN_TXS). */
export const SWAP_FEE_BRIDGE_IN_NOTE = "USDC from Base also pays Circle's CCTP fee (about 0.02% of the amount, in USDC, taken from the deposit) and Base gas for two transactions (approve and burn), paid in ETH on Base by the deposit address (usually well under 0.0001 ETH); the live quote shows both";
/** Docs / MCP / routes summary: fees vary by route, so a single ~1% line would be wrong for Lightning ↔ Arkade. */
export const SWAP_FEE_ALL_ROUTES_NOTE = `Fees depend on the route and are shown on the live quote. Lightning or Arkade to USDC or USDT0 on Arbitrum One or USDC on Base (and back) is ${SWAP_FEE_TOTAL_NOTE}; ${SWAP_FEE_BRIDGE_NOTE}; ${SWAP_FEE_BRIDGE_IN_NOTE}. Lightning to Arkade is ${SWAP_FEE_LN_ARKADE_NOTE}. Arkade to Lightning is ${SWAP_FEE_ARKADE_LN_NOTE}`;
/** Top-level routes / docs note. `live` is used only when every listed route returned a quote and they all agreed on the same rates (unusual once Lightning ↔ Arkade is included). */
export function swapFeeSummaryNote(live?: { satoraFeeRate: number; totalFeeRate: number; markupBps?: number } | null) {
  const bps = live?.markupBps ?? SWAP_MARKUP_BPS;
  if (live) return `Every swap costs ${ratePct(live.totalFeeRate)} total (Satora ${ratePct(live.satoraFeeRate)} + Agent Escrow ${pct(bps)}) plus network fee. Paid inside the swap; nothing extra to send.`;
  return `${SWAP_FEE_ALL_ROUTES_NOTE}. Paid inside the swap; nothing extra to send.`;
}

/** Where the BTC comes from (a Satora source asset). */
export const SWAP_SOURCES = { lightning: { chain: "Lightning", tokenId: "btc" }, arkade: { chain: "Arkade", tokenId: "btc" } } as const;
/** Where a stablecoin payout ends up. bridge: Satora settles the swap on Arbitrum One (the hub: USDC there) and Circle's CCTP
 *  carries the USDC to this chain at claim; Satora's quote shows that bridge fee (bridge_fee, token units) and takes it from the payout. */
export interface StableToken { chain: string; tokenId: string; symbol: string; decimals: number; network: string;
  /** Explorer URL prefixes on the payout chain. */
  explorerTx: string; explorerAddress: string;
  bridge?: { name: string; via: string; settleChain: string; settleNetwork: string; settleToken: string } }
export const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ARBISCAN_TX = "https://arbiscan.io/tx/";
/** Arbitrum One: where every Satora stablecoin swap settles (a bridged payout too). The one place its chain id, name and explorer live. */
const ARB = { chain: "42161", network: "Arbitrum One", explorerTx: ARBISCAN_TX, explorerAddress: "https://arbiscan.io/address/" };
/** "Arbitrum One": the settlement network named in bridged-payout wording. */
export const SWAP_HUB_NETWORK = ARB.network;
/** What it turns into: USDC / USDT0 on Arbitrum One (chain 42161; USDT0 lives at the former USDT contract) or USDC on Base
 *  (chain 8453, bridged from Arbitrum over Circle CCTP). Each key names its network in `network`. */
const TARGETS = {
  usdc: { tokenId: ARB_USDC, symbol: "USDC", decimals: 6, ...ARB },
  usdt0: { tokenId: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT0", decimals: 6, ...ARB },
  "usdc-base": { chain: "8453", tokenId: BASE_USDC, symbol: "USDC", decimals: 6, network: "Base", explorerTx: "https://basescan.org/tx/", explorerAddress: "https://basescan.org/address/",
    bridge: { name: "Base", via: "Circle CCTP", settleChain: ARB.chain, settleNetwork: ARB.network, settleToken: ARB_USDC } },
};
export const SWAP_TARGETS: Record<keyof typeof TARGETS, StableToken> = TARGETS;
export type SwapTarget = keyof typeof TARGETS;
/** "USDC on Base", "USDT0 on Arbitrum One". */
export const tokenLabel = (t: StableToken) => `${t.symbol} on ${t.network}`;
/** Every target with its network, for usage and error text: "usdc (USDC on Arbitrum One), ...". */
export const targetList = (keys: readonly string[] = Object.keys(SWAP_TARGETS)) => keys.map((k) => `${k} (${tokenLabel(SWAP_TARGETS[k as SwapTarget])})`).join(", ");
/** Stablecoins Mark swaps back to BTC. On Arbitrum One the deposit is gasless (no ETH). USDC on Base (a bridged token): Mark signs
 *  a USDC approve and a Circle CCTP burn on Base from the deposit address, so that address needs a little ETH on Base for gas;
 *  the rest (mint and lock) is sponsored. */
export const SWAP_STABLES = ["usdc", "usdt0", "usdc-base"] as const;
/** Gas Mark pays on the bridge chain (Base) to fund a swap from a bridged stablecoin, from the deposit address: USDC approve,
 *  then CCTP depositForBurn (measured ~56k and ~110k gas on Base, Nov 2026; limits here with headroom). bytes: calldata size
 *  for the L1 data fee. The one place these numbers live (quote, fund pre-check, deposit instructions). */
export const BRIDGE_IN_TXS = [{ name: "approve", gas: 80_000n, bytes: 140 }, { name: "burn", gas: 200_000n, bytes: 330 }] as const;
/** One ERC-20 transfer out of the deposit address (recover on the bridge chain). */
export const SWEEP_TX = { name: "transfer", gas: 120_000n, bytes: 140 } as const;
/** Gas price headroom (price may rise between the check and the send) and L1 data fee headroom, for every ETH estimate. */
export const GAS_PRICE_MARGIN = 3n, L1_FEE_MARGIN = 2n;
/** "approve + burn": the bridge-chain transactions, for messages. */
export const BRIDGE_IN_TX_NAMES = BRIDGE_IN_TXS.map((t) => t.name).join(" + ");
/** ETH with at most 8 decimals, rounded up (never shows less than is needed): 5040000000000n -> "0.00000504". */
export function ethText(wei: bigint): string { const step = 10n ** 10n; return units(((wei + step - 1n) / step) * step, 18)!; }
/** "usdc|usdt0|usdc-base" and "usdc, usdt0 or usdc-base": the --from values of a swap from a stablecoin, for usage text. */
export const STABLE_FLAGS = SWAP_STABLES.join("|"), STABLE_OR = `${SWAP_STABLES.slice(0, -1).join(", ")} or ${SWAP_STABLES.at(-1)}`;
/** Every payout grouped by network, in TARGETS order: "USDC or USDT0 on Arbitrum One or USDC on Base". */
export const SWAP_PAYOUTS_TEXT = [...new Set(Object.values(TARGETS).map((t) => t.network))]
  .map((n) => `${Object.values(TARGETS).filter((t) => t.network === n).map((t) => t.symbol).join(" or ")} on ${n}`).join(" or ");
/** Where the 0x payout address must be: "Arbitrum One, or Base for usdc-base". */
export const PAYOUT_NETWORKS_TEXT = [ARB.network, ...Object.entries(TARGETS).filter(([, t]) => t.network !== ARB.network).map(([k, t]) => `or ${t.network} for ${k}`)].join(", ");
export type SwapSource = keyof typeof SWAP_SOURCES;
/** Same hex address, invoice or contract, ignoring case (a missing value never matches). */
export const sameHex = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a !== "" && a.toLowerCase() === b.toLowerCase();
/** A swap from a stablecoin's token: a bridged-in swap (bridge_source_chain set) is the bridged target with that bridge, source
 *  contract and settlement contract; otherwise the Arbitrum token by contract. A bridge Mark does not know returns undefined. */
export function stableOfReverse(x: { tokenContract?: string; bridgeSourceChain?: string; bridgeSourceToken?: string }): StableToken | undefined {
  if (x.bridgeSourceChain) return Object.values(SWAP_TARGETS).find((v) => v.bridge?.name === x.bridgeSourceChain && sameHex(v.tokenId, x.bridgeSourceToken) && sameHex(v.bridge?.settleToken, x.tokenContract));
  return targetByContract(x.tokenContract);
}
/** The swap stablecoin with this contract on Arbitrum One (not a bridged payout), if any. */
export const targetByContract = (contract: unknown) => Object.values(SWAP_TARGETS).find((v) => !v.bridge && sameHex(v.tokenId, contract));
/** A forward swap's payout token: a bridged payout (bridge_target_chain set) is the target with that bridge and destination
 *  contract; otherwise the Arbitrum token by contract. A bridge Mark does not know returns undefined. */
export function targetOfSwap(x: { tokenContract?: string; bridgeTargetChain?: string; bridgeTargetToken?: string }): StableToken | undefined {
  if (x.bridgeTargetChain) return Object.values(SWAP_TARGETS).find((v) => v.bridge?.name === x.bridgeTargetChain && sameHex(v.tokenId, x.bridgeTargetToken) && sameHex(v.bridge?.settleToken, x.tokenContract));
  return targetByContract(x.tokenContract);
}
/** `{ [key]: tx, [explorerKey]: arbiscan link }`, or nothing without a tx. Arbiscan on purpose: every Satora swap tx Mark links
 *  (claim, fund, refund) is on Arbitrum One, a bridged payout's claim too; the Base delivery uses the target's explorerTx. */
export const txLink = (tx: string | undefined, key = "txHash", explorerKey = "explorer") => tx ? { [key]: tx, [explorerKey]: ARBISCAN_TX + tx } : {};

export function swapSource(v: string | undefined): SwapSource {
  const k = (v ?? "lightning").toLowerCase();
  if (!Object.hasOwn(SWAP_SOURCES, k)) throw new MarkError("USAGE", `--from must be ${Object.keys(SWAP_SOURCES).join(" or ")}`);
  return k as SwapSource;
}
export function swapTarget(v: string | undefined): SwapTarget {
  const k = (v ?? "usdc").toLowerCase().replace(/^usdt$/, "usdt0");
  if (!Object.hasOwn(SWAP_TARGETS, k)) throw new MarkError("USAGE", `--to must be one of ${targetList()}`);
  return k as SwapTarget;
}
export function swapSats(v: unknown): number {
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v ?? "")) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new MarkError("USAGE", "--sats must be a whole number of sats");
  return n;
}

/** EIP-55: a mixed-case address must carry a valid checksum (catches typos); all-lowercase / all-uppercase are accepted. */
export function checkEvmAddress(a: string | undefined, flag = "--address", network = ARB.network): string {
  const x = (a ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(x)) throw new MarkError("BAD_DEST", `${flag} must be an EVM address on ${network} (0x followed by 40 hex characters)`);
  const hex = x.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase()) {
    const h = Buffer.from(keccak_256(new TextEncoder().encode(hex.toLowerCase()))).toString("hex");
    for (let i = 0; i < 40; i++) {
      const up = parseInt(h[i], 16) >= 8;
      if (/[a-f]/i.test(hex[i]) && (hex[i] === hex[i].toUpperCase()) !== up) throw new MarkError("BAD_DEST", `${flag} has a bad EIP-55 checksum (mixed case does not match): check it for a typo`);
    }
  }
  if (/^0x0{40}$/i.test(x)) throw new MarkError("BAD_DEST", `${flag} is the zero address`);
  return x;
}

/** "60828794" (6 decimals) -> "60.828794". */
export function units(v: string | number | bigint | undefined, decimals: number): string | undefined {
  if (v === undefined || v === null || !/^\d+$/.test(String(v))) return undefined;
  const s = BigInt(String(v)).toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/** The fee fields of a Satora quote (QuoteResponse). */
export interface SatoraQuote { exchange_rate: string; network_fee: number; gasless_network_fee?: number; protocol_fee: number; protocol_fee_rate: number;
  min_amount: number; max_amount: number; source_amount: string; target_amount: string; net_source_amount: string; net_target_amount: string;
  /** Bridged payouts only (USDC on Base): Circle's CCTP fee in payout-token units, already taken from net_target_amount. */
  bridge_fee?: number | string }

/** Satora's own rate and the combined rate, from a live `protocol_fee_rate` plus our markup. Never hard-coded. */
export function feeRates(protocolFeeRate: number, bps: number) {
  checkMarkupBps(bps);
  // protocol_fee_rate is Satora's combined rate (pair + markup). Use it as the total when it is a
  // usable number; otherwise 0 so quote output never shows NaN. If it is below the markup, Satora's
  // own rate is 0 and the total stays at the quote's rate (do not invent a higher total).
  const totalFeeRate = Number.isFinite(protocolFeeRate) && protocolFeeRate >= 0 ? +protocolFeeRate.toFixed(6) : 0;
  const satoraFeeRate = Math.max(0, +(totalFeeRate - bps / 10000).toFixed(6));
  return { satoraFeeRate, satoraFeePercent: ratePct(satoraFeeRate),
    agentEscrowMarkup: pct(bps), agentEscrowMarkupBps: bps,
    totalFeeRate, totalFeePercent: ratePct(totalFeeRate) };
}
/** Rate fields from a live Satora quote, or null if the quote has no usable protocol_fee_rate (routes still list the pair). */
export function swapFeeRates(q: { protocol_fee_rate?: unknown }, bps: number) {
  if (typeof q.protocol_fee_rate !== "number" || !Number.isFinite(q.protocol_fee_rate) || q.protocol_fee_rate < 0) return null;
  return feeRates(q.protocol_fee_rate, bps);
}

/** Split Satora's protocol fee into Satora's own fee and our markup. With a referral and extraFees, Satora returns ONE protocol fee
 *  at rate (pair fee + extraFees/10000) on the swap sats; our markup is extraFees/10000 of the sats and Satora's fee is the rest.
 *  Total cost = Satora fee + markup + network fee. Rates come from the quote, never from a hard-coded 1%. */
export function splitSwapFees(q: SatoraQuote, sats: number, bps: number) {
  checkMarkupBps(bps);
  const markupSats = Math.round((sats * bps) / 10000);
  const satoraFeeSats = Math.max(0, q.protocol_fee - markupSats);
  const networkFeeSats = q.network_fee + (q.gasless_network_fee ?? 0);
  return { satoraFeeSats, markupSats, markupBps: bps, networkFeeSats,
    totalFeeSats: satoraFeeSats + markupSats + networkFeeSats, ...feeRates(q.protocol_fee_rate, bps) };
}

export type SplitFees = ReturnType<typeof splitSwapFees>;
/** Fee object + human total-fee line for a live quote. Rates and the network fee come from the quote, never hard-coded. */
export function quoteFeeView(f: SplitFees) {
  const satoraFeePercent = ratePct(f.satoraFeeRate);
  const totalFeePercent = ratePct(f.totalFeeRate);
  const markup = pct(f.markupBps);
  return {
    fees: {
      satoraFeeSats: f.satoraFeeSats, satoraFeeRate: f.satoraFeeRate, satoraFeePercent,
      agentEscrowMarkupSats: f.markupSats, agentEscrowMarkupBps: f.markupBps, agentEscrowMarkup: markup,
      networkFeeSats: f.networkFeeSats, totalFeeSats: f.totalFeeSats,
      totalFeeRate: f.totalFeeRate, totalFeePercent,
    },
    totalFeeLine: `Total fee: ${totalFeePercent} (Satora ${satoraFeePercent} + Agent Escrow ${markup}) plus ${f.networkFeeSats} sats network fee`,
  };
}

/** The quote as Mark shows it: what you pay, what you get, and every fee line, our markup named openly, plus the total rate. */
/** The bridge fee of a bridged quote in token units ("55034"), or undefined when Satora's quote has none (or a bad one). */
export function bridgeFeeUnits(q: { bridge_fee?: unknown }): string | undefined {
  const b = q.bridge_fee; const x = typeof b === "number" ? (Number.isSafeInteger(b) && b >= 0 ? String(b) : "") : typeof b === "string" ? b : "";
  return /^\d+$/.test(x) ? x : undefined;
}
export function formatSwapQuote(q: SatoraQuote, o: { from: SwapSource; to: SwapTarget; sats: number; bps: number }) {
  const t = SWAP_TARGETS[o.to]; const v = quoteFeeView(splitSwapFees(q, o.sats, o.bps));
  const bf = t.bridge ? bridgeFeeUnits(q) : undefined;
  const bridgeLine = !t.bridge ? "" : bf !== undefined ? ` plus ${units(bf, t.decimals)} ${t.symbol} ${t.bridge.via} bridge fee to ${t.bridge.name}` : ` plus a ${t.bridge.via} bridge fee to ${t.bridge.name} (not in Satora's quote)`;
  return {
    from: o.from, to: o.to, token: { symbol: t.symbol, network: t.network, chainId: Number(t.chain), contract: t.tokenId },
    payAmountSats: Number(q.net_source_amount ?? o.sats),
    rate: `${q.exchange_rate} ${t.symbol} per BTC`,
    receive: units(q.net_target_amount, t.decimals), receiveUnits: q.net_target_amount,
    fees: t.bridge ? { ...v.fees, bridgeFee: bf !== undefined ? units(bf, t.decimals) : null, bridgeFeeUnits: bf ?? null, bridgeFeeToken: t.symbol } : v.fees,
    ...(t.bridge ? { bridge: { to: t.network, via: t.bridge.via, from: t.bridge.settleNetwork, note: `Satora settles on ${t.bridge.settleNetwork}; at claim ${t.bridge.via} carries the ${t.symbol} to ${t.network} (usually within a few minutes). receive is after the bridge fee.` } } : {}),
    markupNote: `${v.totalFeeLine}${bridgeLine}. Paid inside the swap; nothing extra to send.`,
    limits: { minSats: q.min_amount, maxSats: q.max_amount },
    referral: SWAP_REFERRAL_ID,
  };
}

// ---------- the reverse direction: a stablecoin -> BTC (Lightning or Arkade) ----------
/** The same two tables, read the other way: SWAP_TARGETS are the stablecoins you send, SWAP_SOURCES the BTC rails paid out. */
export type SwapStable = (typeof SWAP_STABLES)[number];
export type SwapRail = SwapSource;
export type SwapRoute =
  | { dir: "to_stable"; from: SwapSource; to: SwapTarget }
  | { dir: "to_btc"; from: SwapStable; to: SwapRail }
  | { dir: "rail"; from: SwapSource; to: SwapRail };
const isStable = (k: string) => (SWAP_STABLES as readonly string[]).includes(k.replace(/^usdt$/, "usdt0"));
const isRail = (k: string) => Object.hasOwn(SWAP_SOURCES, k);
/** --from / --to to a route. A stablecoin --from is the reverse direction (default --to lightning). Both --from and --to a
 *  BTC rail (lightning or arkade, and different) is a Lightning ↔ Arkade swap. Anything else is BTC -> stablecoin
 *  (default --from lightning --to usdc). `--to lightning|arkade` without --from is refused (ambiguous). */
export function swapRoute(from: string | undefined, to: string | undefined): SwapRoute {
  const f = (from ?? "").toLowerCase(), t = (to ?? "").toLowerCase();
  if (f && isStable(f)) {
    const rail = (to ?? "lightning").toLowerCase();
    if (!isRail(rail)) throw new MarkError("USAGE", `--to must be ${Object.keys(SWAP_SOURCES).join(" or ")} when --from is a stablecoin`);
    return { dir: "to_btc", from: swapTarget(f) as SwapStable, to: rail as SwapRail };
  }
  if (t && isRail(t)) {
    if (!f) throw new MarkError("USAGE", `--to ${t} needs --from lightning or arkade (a Lightning ↔ Arkade swap) or --from ${STABLE_OR} (from a stablecoin)`);
    if (!isRail(f)) throw new MarkError("USAGE", `--to ${t} needs --from lightning or arkade, or a stablecoin --from (${STABLE_OR})`);
    if (f === t) throw new MarkError("USAGE", `--from and --to cannot both be ${f}`);
    return { dir: "rail", from: f as SwapSource, to: t as SwapRail };
  }
  return { dir: "to_stable", from: swapSource(from), to: swapTarget(to) };
}
/** Every route: BTC -> stablecoin, then stablecoin -> BTC, then Lightning ↔ Arkade. */
export function allSwapRoutes(): SwapRoute[] {
  const btc = Object.keys(SWAP_SOURCES) as SwapSource[], st = Object.keys(SWAP_TARGETS) as SwapTarget[];
  const rails = btc.flatMap((from) => btc.filter((to) => to !== from).map((to) => ({ dir: "rail" as const, from, to })));
  return [...btc.flatMap((from) => st.map((to) => ({ dir: "to_stable" as const, from, to }))), ...SWAP_STABLES.flatMap((from) => btc.map((to) => ({ dir: "to_btc" as const, from, to }))), ...rails];
}
/** "1.5" USDC -> 1500000n token units (at most `decimals` decimals, more than zero). */
export function tokenUnits(v: unknown, decimals: number, flag = "--amount"): bigint {
  const x = typeof v === "number" ? String(v) : String(v ?? "").trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(x);
  if (!m || (m[2] ?? "").length > decimals) throw new MarkError("USAGE", `${flag} must be a token amount like 1.5 (at most ${decimals} decimals)`);
  const n = BigInt(m[1] + (m[2] ?? "").padEnd(decimals, "0"));
  if (n <= 0n) throw new MarkError("USAGE", `${flag} must be more than zero`);
  return n;
}
/** The quote for stablecoin -> BTC as Mark shows it. Satora charges its fee and our markup in sats, on the swap's BTC amount
 *  (target_amount before fees); you send source_amount token units and receive net_target_amount sats. */
export interface GasEstimate { network: string; txs: string; wei: bigint; usdPerEth?: number }
/** A gas estimate as Mark shows it: ETH (rounded up), wei, and about how many USD when a price was available. */
export function gasView(g: GasEstimate) {
  const usd = g.usdPerEth && Number.isFinite(g.usdPerEth) && g.usdPerEth > 0 ? Math.max(0.01, +((Number(g.wei) / 1e18) * g.usdPerEth).toFixed(2)) : undefined;
  return { network: g.network, txs: g.txs, eth: ethText(g.wei), wei: g.wei.toString(), ...(usd !== undefined ? { usd: `~$${usd}` } : {}) };
}
export function formatReverseQuote(q: SatoraQuote, o: { from: SwapStable; to: SwapRail; bps: number; gas?: GasEstimate | null }) {
  const t = SWAP_TARGETS[o.from]; const gross = Number(q.target_amount); const v = quoteFeeView(splitSwapFees(q, Number.isSafeInteger(gross) ? gross : 0, o.bps));
  const bf = t.bridge ? bridgeFeeUnits(q) : undefined, gas = t.bridge && o.gas ? gasView(o.gas) : undefined;
  const bridgeLine = !t.bridge ? "" : ` Also ${bf !== undefined ? `${units(bf, t.decimals)} ${t.symbol}` : "a"} ${t.bridge.via} fee (taken from the deposit) and Base gas for ${BRIDGE_IN_TX_NAMES}, paid in ETH on ${t.network} by the deposit address: ${gas ? `about ${gas.eth} ETH${gas.usd ? ` (${gas.usd})` : ""} with headroom` : "estimate unavailable right now"}.`;
  return {
    from: o.from, to: o.to, token: { symbol: t.symbol, network: t.network, chainId: Number(t.chain), contract: t.tokenId },
    send: units(q.source_amount, t.decimals), sendUnits: q.source_amount,
    rate: `${q.exchange_rate} ${t.symbol} per BTC`,
    receiveSats: Number(q.net_target_amount),
    fees: t.bridge ? { ...v.fees, bridgeFee: bf !== undefined ? units(bf, t.decimals) : null, bridgeFeeUnits: bf ?? null, bridgeFeeToken: t.symbol } : v.fees,
    ...(t.bridge ? { gas: gas ?? null } : {}),
    markupNote: t.bridge ? `${v.totalFeeLine}. Taken inside the swap.${bridgeLine}` : `${v.totalFeeLine}. Taken inside the swap; nothing extra to send. No ETH needed: the deposit is gasless.`,
    limits: { minSats: q.min_amount, maxSats: q.max_amount },
    referral: SWAP_REFERRAL_ID,
  };
}

/** The quote for a Lightning ↔ Arkade swap as Mark shows it: sats in, sats out, every fee line, and the total rate from the quote. */
export function formatRailQuote(q: SatoraQuote, o: { from: SwapSource; to: SwapRail; bps: number; sats?: number }) {
  const pay = Number(q.net_source_amount ?? q.source_amount ?? o.sats);
  const v = quoteFeeView(splitSwapFees(q, Number.isSafeInteger(pay) ? pay : 0, o.bps));
  return {
    from: o.from, to: o.to,
    payAmountSats: pay,
    receiveSats: Number(q.net_target_amount),
    rate: "1 BTC per BTC",
    fees: v.fees,
    markupNote: `${v.totalFeeLine}. Paid inside the swap; nothing extra to send.`,
    limits: { minSats: q.min_amount, maxSats: q.max_amount },
    referral: SWAP_REFERRAL_ID,
  };
}
