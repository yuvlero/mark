/** Provider-agnostic swap interface. Selected by config.swapProvider.type. */
export interface ReceiveSwap { id: string; invoice: string; amountSats: number; status: string }
export interface PaySwap { id: string; fundAddress: string; fundAmountSats: number; status: string; invoiceAmountSats?: number }
/** invoice: the swap's BOLT11 (Lightning -> Arkade swaps), so an unpaid funding invoice can be shown again. */
export interface SwapInfo { id: string; direction: "ln_to_ark" | "ark_to_ln" | "other"; status: string; invoice?: string; raw?: unknown }
/** detail: the underlying error when the library's own message is generic (e.g. "All VTXOs have already been spent."). */
export interface ClaimResult { success: boolean; txid?: string; message?: string; detail?: string;
  /** set when Mark's workaround for the upstream resume bug was used (see swap/satoraWorkaround.ts) */ workaround?: string; workaroundApplied?: number }

export interface SwapProvider {
  readonly name: string;
  createReceive(amountSats: number, arkAddress: string): Promise<ReceiveSwap>;
  /** target: bolt11 invoice or lightning address (requires amountSats). */
  createPay(target: string, amountSats?: number, opts?: { exactSource?: boolean }): Promise<PaySwap>;
  get(id: string): Promise<SwapInfo>;
  /** Claim (or finish a claim already started) into arkAddress. Never throws for a failed claim: success false + message/detail. */
  claim(id: string, arkAddress: string): Promise<ClaimResult>;
  refund(id: string, arkAddress: string): Promise<{ success: boolean; txid?: string; message?: string }>;
}

