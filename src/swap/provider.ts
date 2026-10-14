/** Provider-agnostic swap interface. Selected by config.swapProvider.type. */
export interface ReceiveSwap { id: string; invoice: string; amountSats: number; status: string }
export interface PaySwap { id: string; fundAddress: string; fundAmountSats: number; status: string; invoiceAmountSats?: number }
export interface SwapInfo { id: string; direction: "ln_to_ark" | "ark_to_ln" | "other"; status: string; raw?: unknown }

export interface SwapProvider {
  readonly name: string;
  createReceive(amountSats: number, arkAddress: string): Promise<ReceiveSwap>;
  /** target: bolt11 invoice or lightning address (requires amountSats). */
  createPay(target: string, amountSats?: number, opts?: { exactSource?: boolean }): Promise<PaySwap>;
  get(id: string): Promise<SwapInfo>;
  claim(id: string, arkAddress: string): Promise<{ success: boolean; txid?: string; message?: string }>;
  refund(id: string, arkAddress: string): Promise<{ success: boolean; txid?: string; message?: string }>;
}

