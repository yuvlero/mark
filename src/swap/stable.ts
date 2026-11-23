/** `mark swap`: BTC (Lightning or Arkade) to a stablecoin on Arbitrum through Satora. Pure constants, fee math and input checks
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
/** "0.5%" for 50 bps. */
export const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;

/** Where the BTC comes from (a Satora source asset). */
export const SWAP_SOURCES = { lightning: { chain: "Lightning", tokenId: "btc" }, arkade: { chain: "Arkade", tokenId: "btc" } } as const;
/** What it turns into: stablecoins on Arbitrum One (chain 42161). USDT0 on Arbitrum lives at the former USDT contract. */
export const SWAP_TARGETS = {
  usdc: { chain: "42161", tokenId: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6, network: "Arbitrum One" },
  usdt0: { chain: "42161", tokenId: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT0", decimals: 6, network: "Arbitrum One" },
} as const;
export type SwapSource = keyof typeof SWAP_SOURCES;
export type SwapTarget = keyof typeof SWAP_TARGETS;
export const ARBISCAN_TX = "https://arbiscan.io/tx/";

export function swapSource(v: string | undefined): SwapSource {
  const k = (v ?? "lightning").toLowerCase();
  if (!Object.hasOwn(SWAP_SOURCES, k)) throw new MarkError("USAGE", `--from must be ${Object.keys(SWAP_SOURCES).join(" or ")}`);
  return k as SwapSource;
}
export function swapTarget(v: string | undefined): SwapTarget {
  const k = (v ?? "usdc").toLowerCase().replace(/^usdt$/, "usdt0");
  if (!Object.hasOwn(SWAP_TARGETS, k)) throw new MarkError("USAGE", `--to must be ${Object.keys(SWAP_TARGETS).join(" or ")} (on Arbitrum)`);
  return k as SwapTarget;
}
export function swapSats(v: unknown): number {
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v ?? "")) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new MarkError("USAGE", "--sats must be a whole number of sats");
  return n;
}

/** EIP-55: a mixed-case address must carry a valid checksum (catches typos); all-lowercase / all-uppercase are accepted. */
export function checkEvmAddress(a: string | undefined, flag = "--address"): string {
  const x = (a ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(x)) throw new MarkError("BAD_DEST", `${flag} must be an EVM address on Arbitrum (0x followed by 40 hex characters)`);
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
  min_amount: number; max_amount: number; source_amount: string; target_amount: string; net_source_amount: string; net_target_amount: string }

/** Split Satora's protocol fee into Satora's own fee and our markup. With a referral and extraFees, Satora returns ONE protocol fee
 *  at rate (pair fee + extraFees/10000) on the swap sats; our markup is extraFees/10000 of the sats and Satora's fee is the rest.
 *  Total cost = Satora fee + markup + network fee. */
export function splitSwapFees(q: SatoraQuote, sats: number, bps: number) {
  checkMarkupBps(bps);
  const markupSats = Math.round((sats * bps) / 10000);
  const satoraFeeSats = Math.max(0, q.protocol_fee - markupSats);
  const satoraFeeRate = Math.max(0, +(q.protocol_fee_rate - bps / 10000).toFixed(6));
  const networkFeeSats = q.network_fee + (q.gasless_network_fee ?? 0);
  return { satoraFeeSats, satoraFeeRate, markupSats, markupBps: bps, networkFeeSats, totalFeeSats: satoraFeeSats + markupSats + networkFeeSats };
}

/** The quote as Mark shows it: what you pay, what you get, and every fee line, our markup named openly. */
export function formatSwapQuote(q: SatoraQuote, o: { from: SwapSource; to: SwapTarget; sats: number; bps: number }) {
  const t = SWAP_TARGETS[o.to]; const f = splitSwapFees(q, o.sats, o.bps);
  return {
    from: o.from, to: o.to, token: { symbol: t.symbol, network: t.network, chainId: Number(t.chain), contract: t.tokenId },
    payAmountSats: Number(q.net_source_amount ?? o.sats),
    rate: `${q.exchange_rate} ${t.symbol} per BTC`,
    receive: units(q.net_target_amount, t.decimals), receiveUnits: q.net_target_amount,
    fees: {
      satoraFeeSats: f.satoraFeeSats, satoraFeeRate: f.satoraFeeRate,
      agentEscrowMarkupSats: f.markupSats, agentEscrowMarkupBps: f.markupBps, agentEscrowMarkup: pct(f.markupBps),
      networkFeeSats: f.networkFeeSats, totalFeeSats: f.totalFeeSats,
    },
    markupNote: `Includes a ${pct(f.markupBps)} Agent Escrow fee (${f.markupSats} sats), on top of Satora's fee. Paid inside the swap; nothing extra to send.`,
    limits: { minSats: q.min_amount, maxSats: q.max_amount },
    referral: SWAP_REFERRAL_ID,
  };
}

// ---------- the reverse direction: a stablecoin on Arbitrum -> BTC (Lightning or Arkade) ----------
/** The same two tables, read the other way: SWAP_TARGETS are the stablecoins you send, SWAP_SOURCES the BTC rails paid out. */
export type SwapStable = SwapTarget;
export type SwapRail = SwapSource;
export type SwapRoute = { dir: "to_stable"; from: SwapSource; to: SwapTarget } | { dir: "to_btc"; from: SwapStable; to: SwapRail };
const isStable = (k: string) => Object.hasOwn(SWAP_TARGETS, k.replace(/^usdt$/, "usdt0"));
/** --from / --to to a route. A stablecoin --from is the reverse direction (default --to lightning); anything else is the forward
 *  direction exactly as before (default --from lightning --to usdc). */
export function swapRoute(from: string | undefined, to: string | undefined): SwapRoute {
  const f = (from ?? "").toLowerCase();
  if (f && isStable(f)) {
    const t = (to ?? "lightning").toLowerCase();
    if (!Object.hasOwn(SWAP_SOURCES, t)) throw new MarkError("USAGE", `--to must be ${Object.keys(SWAP_SOURCES).join(" or ")} when --from is a stablecoin`);
    return { dir: "to_btc", from: swapTarget(f), to: t as SwapRail };
  }
  if (to && Object.hasOwn(SWAP_SOURCES, to.toLowerCase())) throw new MarkError("USAGE", `--to ${to.toLowerCase()} needs a stablecoin --from (${Object.keys(SWAP_TARGETS).join(" or ")})`);
  return { dir: "to_stable", from: swapSource(from), to: swapTarget(to) };
}
/** Every route, built from the same two tables: BTC -> stablecoin first (as before), then stablecoin -> BTC. */
export function allSwapRoutes(): SwapRoute[] {
  const btc = Object.keys(SWAP_SOURCES) as SwapSource[], st = Object.keys(SWAP_TARGETS) as SwapTarget[];
  return [...btc.flatMap((from) => st.map((to) => ({ dir: "to_stable" as const, from, to }))), ...st.flatMap((from) => btc.map((to) => ({ dir: "to_btc" as const, from, to })))];
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
/** A Lightning address (user@domain), lowercased; else BAD_DEST. */
export function checkLightningAddress(a: string | undefined): string {
  const x = (a ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x)) throw new MarkError("BAD_DEST", "--address for --to lightning must be a Lightning address (user@domain); or pass --invoice <bolt11>");
  return x;
}
/** The quote for stablecoin -> BTC as Mark shows it. Satora charges its fee and our markup in sats, on the swap's BTC amount
 *  (target_amount before fees); you send source_amount token units and receive net_target_amount sats. */
export function formatReverseQuote(q: SatoraQuote, o: { from: SwapStable; to: SwapRail; bps: number }) {
  const t = SWAP_TARGETS[o.from]; const gross = Number(q.target_amount); const f = splitSwapFees(q, Number.isSafeInteger(gross) ? gross : 0, o.bps);
  return {
    from: o.from, to: o.to, token: { symbol: t.symbol, network: t.network, chainId: Number(t.chain), contract: t.tokenId },
    send: units(q.source_amount, t.decimals), sendUnits: q.source_amount,
    rate: `${q.exchange_rate} ${t.symbol} per BTC`,
    receiveSats: Number(q.net_target_amount),
    fees: {
      satoraFeeSats: f.satoraFeeSats, satoraFeeRate: f.satoraFeeRate,
      agentEscrowMarkupSats: f.markupSats, agentEscrowMarkupBps: f.markupBps, agentEscrowMarkup: pct(f.markupBps),
      networkFeeSats: f.networkFeeSats, totalFeeSats: f.totalFeeSats,
    },
    markupNote: `Includes a ${pct(f.markupBps)} Agent Escrow fee (${f.markupSats} sats), on top of Satora's fee. Taken inside the swap; nothing extra to send. No ETH needed: the deposit is gasless.`,
    limits: { minSats: q.min_amount, maxSats: q.max_amount },
    referral: SWAP_REFERRAL_ID,
  };
}
