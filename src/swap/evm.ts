/** EVM reads for `mark swap` from a stablecoin (Arbitrum One, and Base for USDC on Base): the token and ETH balance of the swap's
 *  deposit address, gas prices, over public JSON-RPC (Arbitrum: the endpoints the swap library uses). Read-only: no key here.
 *  The one signer (Base approve + burn, recovery sweeps) is built in viemSigner. */
import { DEFAULT_EVM_RPCS } from "@satora/swap";
import { BRIDGE_IN_TXS, GAS_PRICE_MARGIN, L1_FEE_MARGIN } from "./stable.js";

export interface EvmReader {
  tokenBalance(token: string, owner: string): Promise<bigint>;
  ethBalance(owner: string): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /** OP-stack chains (Base): upper bound of the L1 data fee for a transaction of `bytes` calldata, in wei. */
  l1Fee?(bytes: number): Promise<bigint>;
  /** Transactions `owner` has sent, counting the mempool (the pending nonce). */
  txCount?(owner: string): Promise<bigint>;
  /** Units of `token` transferred to `to` in tx (its ERC-20 Transfer logs); undefined while the receipt is not available. */
  /** undefined: no receipt yet; null: the tx reverted (nothing moved). */
  transferredTo?(txHash: string, token: string, to: string): Promise<bigint | undefined | null>;
}

const ARBITRUM = 42161;
export const BASE_CHAIN_ID = 8453;
/** Public Base JSON-RPC endpoints (the swap library ships none for Base), tried in turn. */
export const BASE_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"] as const;
const RPCS: Record<number, readonly string[]> = { [ARBITRUM]: (DEFAULT_EVM_RPCS as Record<number, string[]>)[ARBITRUM] ?? [], [BASE_CHAIN_ID]: BASE_RPCS };
const NAMES: Record<number, string> = { [ARBITRUM]: "Arbitrum", [BASE_CHAIN_ID]: "Base" };
/** Base's GasPriceOracle predeploy and getL1FeeUpperBound(uint256). */
const GAS_ORACLE = "0x420000000000000000000000000000000000000F", L1_UPPER_BOUND = "0xf1c7a58b";
/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hex32 = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** JSON-RPC over the public Arbitrum endpoints, trying each in turn; throws only when every endpoint failed. */
export function arbitrumReader(urls: readonly string[] = RPCS[ARBITRUM], fetchImpl: typeof fetch = fetch): EvmReader { return evmReader(ARBITRUM, urls, fetchImpl); }
/** The same reads on Base (plus the L1 data fee). */
export function baseReader(urls: readonly string[] = BASE_RPCS, fetchImpl: typeof fetch = fetch): EvmReader { return evmReader(BASE_CHAIN_ID, urls, fetchImpl); }
function evmReader(chainId: number, urls: readonly string[], fetchImpl: typeof fetch): EvmReader {
  const name = NAMES[chainId] ?? `chain ${chainId}`;
  async function rpcAny(method: string, params: unknown[], ok: (r: unknown) => boolean): Promise<any> {
    let last: unknown;
    for (const url of urls) {
      try {
        const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
        const j: any = await r.json();
        if (!j?.error && ok(j?.result)) return j.result;
        last = new Error(j?.error?.message ?? `bad ${method} answer`);
      } catch (x) { last = x; }
    }
    throw new Error(`${name} RPC ${method} failed: ${String((last as any)?.message ?? last).slice(0, 200)}`);
  }
  async function rpc(method: string, params: unknown[]): Promise<string> {
    let last: unknown;
    for (const url of urls) {
      try {
        const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
        const j: any = await r.json();
        if (typeof j?.result === "string" && /^0x[0-9a-f]*$/i.test(j.result)) return j.result;
        last = new Error(j?.error?.message ?? `bad ${method} answer`);
      } catch (x) { last = x; }
    }
    throw new Error(`${name} RPC ${method} failed: ${String((last as any)?.message ?? last).slice(0, 200)}`);
  }
  const big = (h: string) => (h === "0x" ? 0n : BigInt(h));
  return {
    async tokenBalance(token, owner) { return big(await rpc("eth_call", [{ to: token, data: "0x70a08231" + hex32(owner) }, "latest"])); },
    async ethBalance(owner) { return big(await rpc("eth_getBalance", [owner, "latest"])); },
    async gasPrice() { return big(await rpc("eth_gasPrice", [])); },
    ...(chainId === BASE_CHAIN_ID ? { async l1Fee(bytes: number) { return big(await rpc("eth_call", [{ to: GAS_ORACLE, data: L1_UPPER_BOUND + BigInt(bytes).toString(16).padStart(64, "0") }, "latest"])); } } : {}),
    async txCount(owner) { return big(await rpc("eth_getTransactionCount", [owner, "pending"])); },
    async transferredTo(txHash, token, to) {
      const r = await rpcAny("eth_getTransactionReceipt", [txHash], (x) => x === null || (typeof x === "object" && Array.isArray((x as any).logs)));
      if (!r) return undefined;
      if (r.status !== "0x1") return null;
      const want = "0x" + hex32(to);
      return r.logs.filter((l: any) => String(l.address).toLowerCase() === token.toLowerCase() && l.topics?.[0] === TRANSFER && String(l.topics?.[2]).toLowerCase() === want)
        .reduce((a: bigint, l: any) => a + big(l.data), 0n);
    },
  };
}

/** ETH the deposit address needs on this chain for these transactions: gas limits x gas price x GAS_PRICE_MARGIN, plus the L1 data
 *  fee upper bound x L1_FEE_MARGIN on Base. Throws when the chain cannot be read. */
export async function gasNeedWei(r: EvmReader, txs: readonly { gas: bigint; bytes: number }[] = BRIDGE_IN_TXS): Promise<bigint> {
  const gp = await r.gasPrice(); let l1 = 0n;
  if (r.l1Fee) for (const t of txs) l1 += await r.l1Fee(t.bytes);
  return txs.reduce((a, t) => a + t.gas, 0n) * gp * GAS_PRICE_MARGIN + l1 * L1_FEE_MARGIN;
}
/** ERC-20 transfer(to, amount) calldata. */
export const transferData = (to: string, amount: bigint) => "0xa9059cbb" + hex32(to) + amount.toString(16).padStart(64, "0");

/** An EvmSigner (the swap library's interface) for one private key on Arbitrum (sweeping tokens out of the deposit address,
 *  recoverGaslessFunds) or Base (the approve + CCTP burn of a swap from USDC on Base, and its sweep). The key stays in memory:
 *  never printed, logged or written. */
export async function viemSigner(privateKey: string, urls?: readonly string[], chainId: number = ARBITRUM) {
  const [{ createWalletClient, createPublicClient, http, fallback }, { privateKeyToAccount }, { arbitrum, base }] =
    await Promise.all([import("viem"), import("viem/accounts"), import("viem/chains")]);
  const chain = chainId === BASE_CHAIN_ID ? base : chainId === ARBITRUM ? arbitrum : undefined;
  if (!chain) throw new Error(`no signer for chain ${chainId}`);
  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`);
  const transport = fallback((urls ?? RPCS[chainId]).map((u) => http(u)));
  const wallet = createWalletClient({ account, chain, transport });
  const pub = createPublicClient({ chain, transport });
  return {
    address: account.address, chainId,
    signTypedData: (td: any) => wallet.signTypedData({ ...td, account }),
    sendTransaction: (tx: any) => wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, chain, account }),
    waitForReceipt: (hash: string) => pub.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    getTransaction: (hash: string) => pub.getTransaction({ hash: hash as `0x${string}` }),
    call: async (tx: any) => (await pub.call({ to: tx.to, data: tx.data, value: tx.value, account: tx.from, blockNumber: tx.blockNumber })).data ?? "0x",
    getBalance: (a: string) => pub.getBalance({ address: a as `0x${string}` }),
  };
}
