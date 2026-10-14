/** Wires config, keys, API client, swap provider and local index for the use-cases. */
import { NETWORKS, dataDir, loadConfig, type MarkConfig, type NetworkName } from "../config.js";
import { openKeystore, resolvePassword } from "../crypto/keystore.js";
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
  const cfg = loadConfig(network, { escrowUrl: o.escrowUrl });
  const dir = dataDir(network);
  const ks = openKeystore(dir, resolvePassword(dir, false));
  const k = await escrowKey(ks.mnemonic, NETWORKS[network].isMainnet);
  let sw: Promise<SwapProvider> | undefined;
  const swaps = () => (sw ??= o.swapFactory ? o.swapFactory() : makeProvider(cfg.swapProvider.type, {
    baseUrl: cfg.swapProvider.baseUrl, referralCode: cfg.swapProvider.referralCode, arkServerUrl: cfg.arkServerUrl, esploraUrl: cfg.esploraUrl,
    bitcoinNetwork: NETWORKS[network].bitcoinNetwork, mnemonic: ks.mnemonic, key: ks.key, dir,
  }));
  return { cfg, network, dir, pubkey: k.xonly, secret: k.secret, api: new EscrowApi(cfg.escrowUrl, o.fetchImpl), index: new LocalIndex(dir), swaps };
}
