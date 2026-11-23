import type { SatoraQuote, SwapRail, SwapSource, SwapStable, SwapTarget } from "./stable.js";
/** Provider-agnostic swap interface. Selected by config.swapProvider.type. */
export interface ReceiveSwap { id: string; invoice: string; amountSats: number; status: string }
export interface PaySwap { id: string; fundAddress: string; fundAmountSats: number; status: string; invoiceAmountSats?: number }
/** invoice: the swap's BOLT11 (Lightning -> Arkade swaps), so an unpaid funding invoice can be shown again. */
export interface SwapInfo { id: string; direction: "ln_to_ark" | "ark_to_ln" | "other"; status: string; invoice?: string; raw?: unknown }
/** detail: the underlying error when the library's own message is generic (e.g. "All VTXOs have already been spent."). */
export interface ClaimResult { success: boolean; txid?: string; message?: string; detail?: string;
  /** set when Mark's workaround for the upstream resume bug was used (see swap/satoraWorkaround.ts) */ workaround?: string; workaroundApplied?: number }

/** `mark swap` (BTC to a stablecoin on Arbitrum). */
/** Fields are Satora's own answer (no fallback to what was requested), so Mark can check them before showing anything to pay. */
export interface StableSwapCreated { id: string; status: string; invoice?: string; arkAddress?: string; payAmountSats: number; targetAddress?: string; receiveUnits?: string;
  sourceChain?: string; targetChain?: string; tokenContract?: string; evmChainId?: number; raw?: unknown }
export interface StableSwapInfo { id: string; status: string; direction?: string; sourceAmountSats?: number; targetUnits?: string; targetAddress?: string; tokenContract?: string; tokenSymbol?: string; evmChainId?: number; payoutTx?: string; feeSats?: number; createdAt?: string; local: boolean; raw?: unknown }

/** `mark swap` from a stablecoin: Satora's own answer, checked before the deposit address is shown. depositAddress is where the
 *  stablecoins go (this Mark home's gasless depositor key, client_evm_address); sourceUnits the exact token units to deposit. */
export interface ReverseSwapCreated { id: string; status: string; gasless?: boolean; depositAddress?: string; sourceUnits?: string; tokenContract?: string;
  sourceChain?: string; evmChainId?: number; targetChain?: string; targetSats?: number; invoice?: string; arkAddress?: string; raw?: unknown }
/** fundTx: the gasless funding (relay) tx once Satora saw it. local: this Mark home holds the swap's keys. */
export interface ReverseSwapInfo extends ReverseSwapCreated { direction?: string; fundTx?: string; payoutTx?: string; lightningSettled?: boolean; createdAt?: string; local: boolean }
export interface ReversePin { invoice?: string; arkAddress?: string; depositAddress: string; tokenContract: string; sourceUnits: string }
export interface ReverseQuoteInput { from: SwapStable; to: SwapRail; bps: number; sourceUnits?: bigint; targetSats?: number; destination?: string }
export interface ReverseCreateInput { from: SwapStable; to: SwapRail; bps: number; sourceUnits?: bigint; invoice?: string; arkAddress?: string }
/** A gasless funding attempt: at most one per swap. uncertain: the relay may have submitted it (no clear refusal), so Mark does not
 *  sign again for a while. */
export interface FundResult { success: boolean; txHash?: string; message?: string; uncertain?: boolean; skipped?: string }

export interface SwapProvider {
  readonly name: string;
  createReceive(amountSats: number, arkAddress: string): Promise<ReceiveSwap>;
  /** target: bolt11 invoice or lightning address (requires amountSats). */
  createPay(target: string, amountSats?: number, opts?: { exactSource?: boolean }): Promise<PaySwap>;
  get(id: string): Promise<SwapInfo>;
  /** Claim (or finish a claim already started) into arkAddress. Never throws for a failed claim: success false + message/detail. */
  claim(id: string, arkAddress: string): Promise<ClaimResult>;
  refund(id: string, arkAddress: string): Promise<{ success: boolean; txid?: string; message?: string }>;
  /** `mark swap`: every call carries Agent Escrow's referral ID and the same checked markup (extraFees, bps). */
  quoteStable?(p: { from: SwapSource; to: SwapTarget; sats: number; bps: number }): Promise<SatoraQuote>;
  createStable?(p: { from: SwapSource; to: SwapTarget; sats: number; bps: number; address: string }): Promise<StableSwapCreated>;
  getStable?(id: string): Promise<StableSwapInfo>;
  /** Gasless claim to the address fixed at create (the preimage/claim key never leaves this Mark home). Never throws. */
  claimStable?(id: string): Promise<{ success: boolean; txHash?: string; message?: string }>;
  /** `mark swap` from a stablecoin (gasless): same referral ID and markup on the quote and the create. */
  quoteReverse?(p: ReverseQuoteInput): Promise<SatoraQuote>;
  createReverse?(p: ReverseCreateInput): Promise<ReverseSwapCreated>;
  getReverse?(id: string): Promise<ReverseSwapInfo>;
  /** This Mark home's gasless deposit address (the same for every swap from a stablecoin). */
  depositAddress?(): string;
  /** Swaps from a stablecoin in this Mark home's storage that are still waiting for their deposit (status pending). */
  openReverse?(): Promise<ReverseSwapInfo[]>;
  /** The payout target and deposit terms confirmed at create (kept in this Mark home), checked on every later read. */
  pinReverse?(id: string, pin: ReversePin): void;
  reversePin?(id: string): ReversePin | undefined;
  /** Run f alone among this Mark home's deposit-address actions (create, fund, recover), across processes too. */
  exclusive?<T>(f: () => Promise<T>): Promise<T>;
  /** Sign the permits and let Satora's relay lock the deposit into the swap. At most once per swap (see FundResult): under the
   *  deposit lock it re-checks that the swap is unfunded, the deposit is at the address and no recent attempt exists. Never throws. */
  fundReverse?(id: string): Promise<FundResult>;
  /** When a funding was last attempted for this swap (ms epoch), if ever. */
  fundAttemptedAt?(id: string): number | undefined;
  /** A locked deposit that did not pay out back to the deposit address: Satora's collaborative refund, else the sponsored timelock refund. */
  refundReverse?(id: string): Promise<{ success: boolean; txHash?: string; how?: string; message?: string }>;
  /** Sweep the swap token from the deposit address to `to` (needs a little ETH there for gas). */
  recoverReverse?(id: string, to: string): Promise<{ success: boolean; txHash?: string; amountUnits?: string; message?: string }>;
  /** Read Arbitrum balances (the deposit address). */
  evm?: import("./evm.js").EvmReader;
}

