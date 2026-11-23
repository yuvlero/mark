/** Arbitrum reads for `mark swap` from a stablecoin: the token and ETH balance of the swap's deposit address, over public JSON-RPC
 *  (the same endpoints the swap library uses). Read-only: no key here. The one signer (recovery sweep) is built in viemSigner. */
import { DEFAULT_EVM_RPCS } from "@satora/swap";

export interface EvmReader {
  tokenBalance(token: string, owner: string): Promise<bigint>;
  ethBalance(owner: string): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /** Units of `token` transferred to `to` in tx (its ERC-20 Transfer logs); undefined while the receipt is not available. */
  /** undefined: no receipt yet; null: the tx reverted (nothing moved). */
  transferredTo?(txHash: string, token: string, to: string): Promise<bigint | undefined | null>;
}

const ARBITRUM = 42161;
/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hex32 = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** JSON-RPC over the public Arbitrum endpoints, trying each in turn; throws only when every endpoint failed. */
export function arbitrumReader(urls: readonly string[] = (DEFAULT_EVM_RPCS as Record<number, string[]>)[ARBITRUM] ?? [], fetchImpl: typeof fetch = fetch): EvmReader {
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
    throw new Error(`Arbitrum RPC ${method} failed: ${String((last as any)?.message ?? last).slice(0, 200)}`);
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
    throw new Error(`Arbitrum RPC ${method} failed: ${String((last as any)?.message ?? last).slice(0, 200)}`);
  }
  const big = (h: string) => (h === "0x" ? 0n : BigInt(h));
  return {
    async tokenBalance(token, owner) { return big(await rpc("eth_call", [{ to: token, data: "0x70a08231" + hex32(owner) }, "latest"])); },
    async ethBalance(owner) { return big(await rpc("eth_getBalance", [owner, "latest"])); },
    async gasPrice() { return big(await rpc("eth_gasPrice", [])); },
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

/** An EvmSigner (the swap library's interface) for one private key on Arbitrum, used only to sweep tokens out of the deposit
 *  address (recoverGaslessFunds). The key stays in memory: never printed, logged or written. */
export async function viemSigner(privateKey: string, urls: readonly string[] = (DEFAULT_EVM_RPCS as Record<number, string[]>)[ARBITRUM] ?? []) {
  const [{ createWalletClient, createPublicClient, http, fallback }, { privateKeyToAccount }, { arbitrum }] =
    await Promise.all([import("viem"), import("viem/accounts"), import("viem/chains")]);
  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`);
  const transport = fallback(urls.map((u) => http(u)));
  const wallet = createWalletClient({ account, chain: arbitrum, transport });
  const pub = createPublicClient({ chain: arbitrum, transport });
  return {
    address: account.address, chainId: ARBITRUM,
    signTypedData: (td: any) => wallet.signTypedData({ ...td, account }),
    sendTransaction: (tx: any) => wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, chain: arbitrum, account }),
    waitForReceipt: (hash: string) => pub.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    getTransaction: (hash: string) => pub.getTransaction({ hash: hash as `0x${string}` }),
    call: async (tx: any) => (await pub.call({ to: tx.to, data: tx.data, value: tx.value, account: tx.from, blockNumber: tx.blockNumber })).data ?? "0x",
    getBalance: (a: string) => pub.getBalance({ address: a as `0x${string}` }),
  };
}
