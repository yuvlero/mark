/** Config + network presets. All config loading/resolution lives here. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MarkError } from "./errors.js";

export type NetworkName = "bitcoin" | "mutinynet";
/** One-line switch for the default network. */
export const DEFAULT_NETWORK: NetworkName = "bitcoin";

export interface NetworkPreset { arkServerUrl: string; esploraUrl: string; swapBaseUrl: string; bitcoinNetwork: "mainnet" | "signet"; isMainnet: boolean }
export const NETWORKS: Record<NetworkName, NetworkPreset> = {
  bitcoin: { arkServerUrl: "https://arkade.computer", esploraUrl: "https://mempool.space/api", swapBaseUrl: "https://api.satora.io", bitcoinNetwork: "mainnet", isMainnet: true },
  mutinynet: { arkServerUrl: "https://mutinynet.arkade.sh", esploraUrl: "https://mutinynet.com/api", swapBaseUrl: "https://mutinynetswap.lendasat.com", bitcoinNetwork: "signet", isMainnet: false },
};

export function normalizeNetwork(n?: string): NetworkName {
  const v = (n || process.env.MARK_NETWORK || DEFAULT_NETWORK).toLowerCase();
  if (v === "bitcoin" || v === "mainnet") return "bitcoin";
  if (v === "mutinynet" || v === "signet" || v === "testnet") return "mutinynet";
  throw new MarkError("BAD_NETWORK", `unknown network ${n}`);
}

export interface MarkConfig {
  network: NetworkName;
  /** Escrow REST base URL. No default: set via `--escrow-url`, MARK_ESCROW_URL, or config. */
  escrowUrl?: string;
  arkServerUrl: string;
  esploraUrl: string;
  swapProvider: { type: string; baseUrl: string; referralCode?: string };
  /** Ark address that receives refunds of failed Lightning payout swaps (optional). */
  refundArkAddress?: string;
  limits: { maxEscrowSats: number };
}

export const homeDir = () => process.env.MARK_HOME || path.join(os.homedir(), ".mark");
export const dataDir = (n: NetworkName) => path.join(homeDir(), n);
export const configPath = (n: NetworkName) => path.join(dataDir(n), "config.json");
export function ensureDir(d: string) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); }

export function defaultConfig(network: NetworkName): MarkConfig {
  const p = NETWORKS[network];
  return { network, arkServerUrl: p.arkServerUrl, esploraUrl: p.esploraUrl, swapProvider: { type: "satora", baseUrl: p.swapBaseUrl }, limits: { maxEscrowSats: 5000 } };
}

export function normalizeUrl(u: string): string {
  let x: URL;
  try { x = new URL(u); } catch { throw new MarkError("BAD_ESCROW_URL", `invalid escrow URL: ${u}`); }
  if (x.protocol !== "https:" && x.protocol !== "http:") throw new MarkError("BAD_ESCROW_URL", "escrow URL must be http(s)");
  return x.toString().replace(/\/+$/, "");
}

/** Load config file merged over defaults; overrides: { escrowUrl } (flag) > MARK_ESCROW_URL > file. */
export function loadConfig(network: NetworkName, overrides: { escrowUrl?: string } = {}): MarkConfig {
  const f = configPath(network);
  if (!fs.existsSync(f)) throw new MarkError("NOT_INITIALIZED", `not initialized; run: mark init --network ${network}`);
  const d = defaultConfig(network); const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const c: MarkConfig = { ...d, ...j, swapProvider: { ...d.swapProvider, ...(j.swapProvider || {}) }, limits: { maxEscrowSats: Number(j.limits?.maxEscrowSats ?? d.limits.maxEscrowSats) } };
  const url = overrides.escrowUrl || process.env.MARK_ESCROW_URL || c.escrowUrl;
  c.escrowUrl = url ? normalizeUrl(url) : undefined;
  return c;
}

export function saveConfig(c: MarkConfig) {
  ensureDir(dataDir(c.network));
  const { ...persist } = c;
  fs.writeFileSync(configPath(c.network), JSON.stringify(persist, null, 2) + "\n", { mode: 0o600 });
}
