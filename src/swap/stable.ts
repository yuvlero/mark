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
export function checkEvmAddress(a: string | undefined): string {
  const x = (a ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(x)) throw new MarkError("BAD_DEST", "--address must be an EVM address on Arbitrum (0x followed by 40 hex characters)");
  const hex = x.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase()) {
    const h = Buffer.from(keccak_256(new TextEncoder().encode(hex.toLowerCase()))).toString("hex");
    for (let i = 0; i < 40; i++) {
      const up = parseInt(h[i], 16) >= 8;
      if (/[a-f]/i.test(hex[i]) && (hex[i] === hex[i].toUpperCase()) !== up) throw new MarkError("BAD_DEST", "--address has a bad EIP-55 checksum (mixed case does not match): check it for a typo");
    }
  }
  if (/^0x0{40}$/i.test(x)) throw new MarkError("BAD_DEST", "--address is the zero address");
  return x;
}

/** "60828794" (6 decimals) -> "60.828794". */
export function units(v: string | number | bigint | undefined, decimals: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
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
