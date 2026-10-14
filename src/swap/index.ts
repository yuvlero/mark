import type { SwapProvider } from "./provider.js";
import { SatoraProvider } from "./satora.js";
import { MarkError } from "../errors.js";
export type ProviderFactory = (o: any) => Promise<SwapProvider>;
/** Register providers here; selected by config.swapProvider.type. */
export const PROVIDERS: Record<string, ProviderFactory> = { satora: (o) => SatoraProvider.create(o) };
export async function makeProvider(type: string, o: any) {
  const f = PROVIDERS[type];
  if (!f) throw new MarkError("BAD_CONFIG", `unknown swap provider ${type}`);
  return f(o);
}
