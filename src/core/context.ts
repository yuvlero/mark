/** Wires config, keys, API client, swap provider and local index for the use-cases. */
import { NETWORKS, configPath, dataDir, defaultConfig, ensureDir, loadConfig, type MarkConfig, type NetworkName } from "../config.js";
import { openOrCreateKeystore, walletFile, writeExclusive } from "../crypto/keystore.js";
import { escrowKey } from "../crypto/keys.js";
import { EscrowApi } from "../api/escrowApi.js";
import { makeProvider } from "../swap/index.js";
import type { SwapProvider } from "../swap/provider.js";
import { LocalIndex } from "./localIndex.js";

export interface Ctx {
  cfg: MarkConfig; network: NetworkName; dir: string;
  pubkey: string; secret: Uint8Array;
  api: EscrowApi; index: LocalIndex;
  swaps(): Promise<SwapProvider>;
}
export interface CtxOptions { escrowUrl?: string; fetchImpl?: typeof fetch; swapFactory?: () => Promise<SwapProvider> }

export async function openCtx(network: NetworkName, o: CtxOptions = {}): Promise<Ctx> {
  const dir = dataDir(network);
  ensureDir(dir);
  writeExclusive(configPath(network), JSON.stringify(defaultConfig(network), null, 2) + "\n"); // default config on first use; no-op if present
  const cfg = loadConfig(network, { escrowUrl: o.escrowUrl });
  const ks = openOrCreateKeystore(dir); // auto-create the agent key on first use; never overwrites an existing one
  const k = await escrowKey(ks.mnemonic, NETWORKS[network].isMainnet);
  if (ks.created) process.stderr.write(`mark: created new agent key at ${walletFile(dir)} (pubkey ${k.xonly}). Back up ${dir}: deleting it loses this identity.\n`);
  let sw: Promise<SwapProvider> | undefined;
  const swaps = () => (sw ??= o.swapFactory ? o.swapFactory() : makeProvider(cfg.swapProvider.type, {
    baseUrl: cfg.swapProvider.baseUrl, referralCode: cfg.swapProvider.referralCode, arkServerUrl: cfg.arkServerUrl, esploraUrl: cfg.esploraUrl,
    bitcoinNetwork: NETWORKS[network].bitcoinNetwork, mnemonic: ks.mnemonic, key: ks.key, dir,
  }));
  return { cfg, network, dir, pubkey: k.xonly, secret: k.secret, api: new EscrowApi(cfg.escrowUrl, o.fetchImpl), index: new LocalIndex(dir), swaps };
}
