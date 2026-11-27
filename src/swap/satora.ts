import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, getUsdPrices, TOKEN_MESSENGER_V2 } from "@satora/swap";
import type { SwapProvider, SwapInfo, ClaimResult, StableSwapCreated, StableSwapInfo, ReverseQuoteInput, ReverseCreateInput, ReverseSwapCreated, ReverseSwapInfo, FundResult, ReversePin, RailQuoteInput, RailCreateInput, RailSwapCreated, RailSwapInfo } from "./provider.js";
import { validPin, pinMismatch } from "./reversePin.js";
import { isReverseDir } from "./states.js";
import { arbitrumReader, baseReader, viemSigner, gasNeedWei, transferData, BASE_CHAIN_ID, type EvmReader } from "./evm.js";
import { SWAP_REFERRAL_ID, SWAP_SOURCES, SWAP_TARGETS, SWEEP_TX, checkMarkupBps, sameHex, stableOfReverse, type SatoraQuote, type SwapSource, type SwapTarget } from "./stable.js";
import { encryptWith, decryptWith } from "../crypto/keystore.js";
import { MarkError } from "../errors.js";
import { decodeInvoice } from "../lightning/invoice.js";
/** Fund only while the payout invoice has at least this long left (the swap pays it after the lock lands). */
const FUND_MIN_INVOICE_SECS = 300;
/** Exact 1.11.1 fundSwapGasless messages that mean nothing is locked, so a later fund is safe. Each pattern is the whole message, except the two HTTP prefixes (`Failed to get Permit2 funding data` and `Gasless fund relay failed: 4xx`) whose official errors append a status and body. */
function isClearFundRefusal(message: string): boolean {
  if (/^Failed to get Permit2 funding data/.test(message)) return true;
  if (/^Gasless fund relay failed: 4(00|01|03|04|22)\b/.test(message)) return true;
  if (/^Swap \S+ not found in local storage\. Cannot sign without the secret key\.$/.test(message)) return true;
  if (/^Expected an EVM-sourced swap, got \S+\. Gasless fund is for EVM-sourced swaps\.$/.test(message)) return true;
  if (message === "Sponsored funding requires swap storage") return true;
  if (message === "Previous funding operation reverted; retry funding again.") return true;
  if (/^Swap \S+ locks on chain \d+, not the sponsored chain \d+; refusing to fund it there$/.test(message)) return true;
  if (/^Swap \S+ locks on chain \d+, not \d+$/.test(message)) return true;
  if (/^Cannot fund swap \S+ sponsored: its depositor 0x[0-9a-fA-F]+ is not an SDK-controlled account\. Fund it from that wallet with fundSwap\.$/.test(message)) return true;
  return false;
}

/** Encrypted JSON file swap storage (preimages live here, so encrypt). */
class EncryptedFileSwapStorage {
  constructor(private file: string, private key: Buffer) {}
  private read(): Record<string, any> {
    if (!fs.existsSync(this.file)) return {};
    return JSON.parse(decryptWith(this.key, JSON.parse(fs.readFileSync(this.file, "utf8"))));
  }
  private write(d: Record<string, any>) {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(encryptWith(this.key, JSON.stringify(d))), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  async get(id: string) { return this.read()[id] ?? null; }
  async store(s: any) { const d = this.read(); d[s.swapId] = s; this.write(d); }
  async update(id: string, response: any) { const d = this.read(); if (d[id]) { d[id].response = response; this.write(d); } }
  async delete(id: string) { const d = this.read(); delete d[id]; this.write(d); }
  async list() { return Object.keys(this.read()); }
  async getAll() { return Object.values(this.read()); }
  async clear() { this.write({}); }
}

/** Signer storage: mnemonic held in memory only; key index persisted. */
class MemWalletStorage {
  constructor(private mnemonic: string, private idxFile: string) {}
  async getMnemonic() { return this.mnemonic; }
  async setMnemonic(_m: string) { /* mnemonic is owned by Mark's keystore */ }
  async getKeyIndex() { return fs.existsSync(this.idxFile) ? Number(fs.readFileSync(this.idxFile, "utf8")) : 0; }
  async setKeyIndex(i: number) { fs.writeFileSync(this.idxFile, String(i), { mode: 0o600 }); }
  async incrementKeyIndex() { const i = (await this.getKeyIndex()) + 1; await this.setKeyIndex(i); return i; }
  async clear() {}
}

/** The swap library prints progress with console.log; Mark's stdout is JSON (CLI) or the MCP stdio stream, so send it to stderr.
 *  One known line is swallowed: "No pending Arkade claim found; submitting a new claim" is the library's normal first-claim
 *  path (it tries to resume, finds nothing, starts a new claim). Printing it during `fund --wait` looked like an error. */
/** Claims and refunds run one at a time per process (MCP may get concurrent calls), so the console redirect is never overlapping. */
let serialTail: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const run = serialTail.then(f, f); serialTail = run.catch(() => undefined); return run;
}
const QUIET_SATORA_LOGS = new Set(["No pending Arkade claim found; submitting a new claim"]);
function stdoutToStderr<T>(f: () => Promise<T>): Promise<T> {
  return serial(async () => {
    const log = console.log, info = console.info, debug = console.debug;
    const redirect = (...a: unknown[]) => { if (QUIET_SATORA_LOGS.has(a.map(String).join(" ").trim())) return; console.error(...a); };
    console.log = console.info = console.debug = redirect;
    try { return await f(); } finally { console.log = log; console.info = info; console.debug = debug; }
  });
}
const errText = (x: unknown) => (x instanceof Error ? x.message : String(x)).slice(0, 500);

function dirOf(s: any): SwapInfo["direction"] {
  const d = s?.direction ?? "";
  if (d === "lightning_to_arkade") return "ln_to_ark";
  if (d === "arkade_to_lightning") return "ark_to_ln";
  return "other";
}

interface BridgeSends { pre?: string; nonce?: string; burn?: string; unknown?: true }
const validSends = (v: unknown) => !!v && typeof v === "object" && Object.entries(v as object).every(([k, x]) =>
  ((k === "pre" || k === "nonce") && typeof x === "string" && /^\d+$/.test(x)) || (k === "burn" && typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x)) || (k === "unknown" && x === true));
/** A CCTP burn tx (0x + 64 hex) the swap library recorded on its swap record, if any. */
const burnOf = (st: any): string | undefined => { const b = st?.cctpBurnTxid; return typeof b === "string" && /^0x[0-9a-fA-F]{64}$/.test(b) ? b : undefined; };
/** The lock transaction the swap library recorded for a swap it funded, if any. */
const fundTxOf = (st: any): string | undefined => typeof st?.evmFundTxid === "string" && st.evmFundTxid ? st.evmFundTxid : undefined;

export class SatoraProvider implements SwapProvider {
  readonly name = "satora";
  /** dir: where the funding-attempt record lives (none: in memory only, tests). */
  private constructor(private c: Client, private baseUrl: string, private arkUrl: string, private dir?: string) {
    this.attempts = new RecordFile<number>(dir, "evm-funding.json", (v) => typeof v === "number" && Number.isFinite(v));
    this.sends = new RecordFile<BridgeSends>(dir, "bridge-sends.json", validSends);
    this.pins = new RecordFile<ReversePin>(dir, "reverse-pins.json", validPin);
  }
  /** Arbitrum reads (tests replace it). */
  evm: EvmReader = arbitrumReader();
  /** Base reads, for swaps from USDC on Base (tests replace it). */
  evmBase: EvmReader = baseReader();
  evmOn(chainId: number): EvmReader {
    if (chainId === BASE_CHAIN_ID) return this.evmBase;
    if (chainId === Number(SWAP_TARGETS.usdc.chain)) return this.evm;
    throw new MarkError("SWAP_FAILED", `Mark has no reader for chain ${chainId}`);
  }
  /** About how many USD one ETH is (CoinGecko through the swap library; best effort, 5 s). */
  async ethUsd(): Promise<number | undefined> {
    try {
      const r = await Promise.race([getUsdPrices([{ symbol: "ETH", chain: String(BASE_CHAIN_ID), token_id: "eth", name: "Ether", decimals: 18 } as any]), new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), 5000).unref?.())]);
      const v = r?.[0]?.usdPrice; return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    } catch { return undefined; }
  }
  /** The swap library's local record of a swap (null when there is none); throws when it cannot be read. */
  private async storedSwap(id: string): Promise<any> { const g = (this.c as any).getStoredSwap; return g ? (await g.call(this.c, id)) ?? null : null; }
  /** The CCTP burn the swap library recorded for a swap from USDC on Base (the USDC left Base), if any. For display and choosing a
   *  path only (undefined when unreadable): funding and recovery read the record themselves and refuse when it cannot be read. */
  async cctpBurn(id: string): Promise<string | undefined> {
    try { return burnOf(await this.storedSwap(id)); } catch { return undefined; }
  }
  /** A burn Mark's own signer sent for this swap (also when the swap library did not record it): recovery on the settlement chain. */
  sentBurn(id: string): string | undefined { return this.sends.read()[id]?.burn; }
  sentUnknown(id: string): boolean { const m = this.sends.read()[id]; return !!m?.unknown && !m.burn; }

  static async create(opts: { baseUrl: string; arkServerUrl: string; esploraUrl: string; bitcoinNetwork: "mainnet" | "signet"; mnemonic: string; key: Buffer; dir: string; referralCode?: string }) {
    const sdir = path.join(opts.dir, "swaps"); fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
    let b: any = Client.builder()
      .withBaseUrl(opts.baseUrl)
      .withArkadeServerUrl(opts.arkServerUrl)
      .withEsploraUrl(opts.esploraUrl)
      .withBitcoinNetwork(opts.bitcoinNetwork)
      .withSignerStorage(new MemWalletStorage(opts.mnemonic, path.join(sdir, "keyindex")) as any)
      .withSwapStorage(new EncryptedFileSwapStorage(path.join(sdir, "swaps.enc.json"), opts.key) as any)
      .withLogLevel?.("silent");
    if (opts.referralCode) b = b.withReferralCode(opts.referralCode);
    const c = await b.build();
    return new SatoraProvider(c, opts.baseUrl, opts.arkServerUrl, sdir);
  }

  async createReceive(amountSats: number, arkAddress: string) {
    const r: any = await this.c.createLightningToArkadeSwap({ targetAddress: arkAddress, targetAmountSats: amountSats });
    const res = r.response;
    return { id: res.id, invoice: res.bolt11_invoice, amountSats: Number(res.target_amount ?? amountSats), status: res.status };
  }

  async createPay(target: string, amountSats?: number, o: { exactSource?: boolean } = {}) {
    const isAddr = target.includes("@");
    const opts: any = isAddr ? (o.exactSource ? { lightningAddress: target, sourceAmountSats: amountSats } : { lightningAddress: target, targetAmountSats: amountSats }) : { lightningInvoice: target };
    if (isAddr && !amountSats) throw new MarkError("BAD_REQUEST", "--sats required for lightning address");
    const r: any = await this.c.createArkadeToLightningSwap(opts);
    const res = r.response;
    return { id: res.id, fundAddress: res.arkade_vhtlc_address, fundAmountSats: Number(res.source_amount), status: res.status, invoiceAmountSats: Number(res.target_amount ?? 0) || undefined };
  }

  async get(id: string): Promise<SwapInfo> {
    const s: any = await this.c.getSwap(id);
    const invoice = typeof s.bolt11_invoice === "string" ? s.bolt11_invoice : undefined;
    return { id, direction: dirOf(s), status: s.status, ...(invoice ? { invoice } : {}), raw: { status: s.status, source_amount: s.source_amount, target_amount: s.target_amount, created_at: s.created_at } };
  }

  /**
   * claimArkade first finalizes a pending claim (if one was submitted) and otherwise submits a new one.
   * @satora/swap 1.11.1+ surfaces a resume error as-is. If an older answer still says only
   * "All VTXOs have already been spent.", ask the finalize step so the real reason reaches the user (detail).
   */
  async claim(id: string, arkAddress: string): Promise<ClaimResult> {
    return stdoutToStderr(async () => {
      let r: any;
      try { r = await this.c.claimArkade(id, { destinationAddress: arkAddress, arkadeServerUrl: this.arkUrl }); }
      catch (x) { return { success: false, message: `claim failed: ${errText(x)}` }; }
      if (r?.success) return { success: true, txid: r.txId, message: r.message };
      const message = typeof r?.message === "string" ? r.message.slice(0, 500) : "claim failed";
      if (!/already been spent/i.test(message)) return { success: false, message };
      let k: any;
      try { k = await this.c.continueArkadeClaimSwap(id) as any; }
      catch (x) { k = { success: false, message: errText(x) }; }
      if (k?.success) return { success: true, txid: k.txId, message: k.message };
      const detail = typeof k?.message === "string" && k.message ? `finalizing the pending claim failed: ${k.message.slice(0, 500)}` : undefined;
      return { success: false, message, ...(detail && k.message !== message ? { detail } : {}) };
    });
  }

  async refund(id: string, arkAddress: string) {
    const r: any = await stdoutToStderr(() => this.c.refundSwap(id, { destinationAddress: arkAddress, arkadeServerUrl: this.arkUrl } as any));
    return { success: !!r.success, txid: r.txId, message: r.message };
  }

  // ---------- `mark swap`: BTC (Lightning / Arkade) -> stablecoin (on Arbitrum One, or USDC bridged to Base) ----------
  /** Satora getQuote with our referral ID and markup (extraFees in bps, checked against the cap before anything is sent). */
  async quoteStable(p: { from: SwapSource; to: SwapTarget; sats: number; bps: number }): Promise<SatoraQuote> {
    const extraFees = checkMarkupBps(p.bps); const s = SWAP_SOURCES[p.from], t = SWAP_TARGETS[p.to];
    return await this.c.getQuote({ sourceChain: s.chain as any, sourceToken: s.tokenId, targetChain: t.chain as any, targetToken: t.tokenId, sourceAmount: p.sats,
      referralCode: SWAP_REFERRAL_ID, extraFees }) as any;
  }
  /** Satora createSwap with the SAME referral ID and markup as the quote. The claim preimage and keys are kept in this Mark
   *  home's encrypted swap storage (derived from the agent key), never sent anywhere. */
  async createStable(p: { from: SwapSource; to: SwapTarget; sats: number; bps: number; address: string }): Promise<StableSwapCreated> {
    const extraFees = checkMarkupBps(p.bps);
    const t = SWAP_TARGETS[p.to];
    // a target on a bridge chain (Base) is settled on Arbitrum One and bridged at claim: the library adds the bridge itself
    const r: any = await stdoutToStderr(() => this.c.createSwap({ source: SWAP_SOURCES[p.from] as any, target: { chain: t.chain, tokenId: t.tokenId } as any, sourceAmount: p.sats, targetAddress: p.address,
      referralCode: SWAP_REFERRAL_ID, extraFees }));
    const res = r?.response ?? {};
    // Satora's answer only: never default these to the request, so a missing or different value is caught before payment
    return { id: res.id, status: res.status, invoice: res.bolt11_invoice ?? undefined, arkAddress: res.btc_vhtlc_address ?? undefined,
      payAmountSats: res.source_amount != null ? Number(res.source_amount) : NaN, targetAddress: res.target_evm_address ?? undefined,
      receiveUnits: res.target_amount != null ? String(res.target_amount) : undefined, sourceChain: res.source_token?.chain ?? undefined, targetChain: res.target_token?.chain ?? undefined,
      tokenContract: res.target_token?.token_id ?? undefined, evmChainId: res.evm_chain_id != null ? Number(res.evm_chain_id) : undefined,
      bridgeTargetChain: res.bridge_target_chain ?? undefined, bridgeTargetToken: res.bridge_target_token_address ?? undefined, raw: res };
  }
  async getStable(id: string): Promise<StableSwapInfo> {
    const r: any = await this.c.getSwap(id, { updateStorage: true } as any);
    let local = false; try { local = !!(await (this.c as any).getStoredSwap?.(id)); } catch { /* unknown */ }
    return { id: r.id ?? id, status: r.status, direction: r.direction, sourceAmountSats: r.source_amount != null ? Number(r.source_amount) : undefined, targetUnits: r.target_amount != null ? String(r.target_amount) : undefined,
      targetAddress: r.target_evm_address ?? r.client_evm_address ?? undefined, tokenContract: r.target_token?.token_id ?? undefined, tokenSymbol: r.target_token?.symbol ?? undefined, evmChainId: r.evm_chain_id ?? undefined,
      payoutTx: r.evm_claim_txid ?? undefined, feeSats: r.fee_sats ?? undefined, createdAt: r.created_at ?? undefined,
      bridgeTargetChain: r.bridge_target_chain ?? undefined, bridgeTargetToken: r.bridge_target_token_address ?? undefined, bridgeTx: r.bridge_target_txid ?? undefined, local, raw: r };
  }
  /** One claim per swap at a time: concurrent calls (MCP) share the in-flight claim instead of submitting a second one. */
  private claiming = new Map<string, Promise<{ success: boolean; txHash?: string; message?: string }>>();
  claimStable(id: string) {
    const running = this.claiming.get(id); if (running) return running;
    const run = this.claimStableOnce(id).finally(() => this.claiming.delete(id));
    this.claiming.set(id, run); return run;
  }
  /** stdoutToStderr runs through serial(): stable claims queue behind every other claim/refund in this process. */
  private async claimStableOnce(id: string) {
    try {
      const r: any = await stdoutToStderr(() => this.c.claim(id));
      return { success: !!r?.success, txHash: r?.txHash ?? undefined, message: typeof r?.message === "string" ? r.message.slice(0, 500) : undefined };
    } catch (x) { return { success: false, message: errText(x) }; }
  }

  // ---------- `mark swap` from a stablecoin: USDC / USDT0 on Arbitrum -> BTC (Lightning or Arkade), gasless ----------
  async quoteReverse(p: ReverseQuoteInput): Promise<SatoraQuote> {
    const extraFees = checkMarkupBps(p.bps); const s = SWAP_TARGETS[p.from], t = SWAP_SOURCES[p.to];
    const quote = (src: { chain: string; tokenId: string }, dest?: string) => this.c.getQuote({ sourceChain: src.chain as any, sourceToken: src.tokenId, targetChain: t.chain as any, targetToken: t.tokenId,
      ...(p.sourceUnits !== undefined ? { sourceAmount: p.sourceUnits.toString() as any } : { targetAmount: p.targetSats as any }),
      ...(dest ? { lightningDestination: dest } : {}), referralCode: SWAP_REFERRAL_ID, extraFees }) as Promise<any>;
    // A bridged source paying a Lightning invoice: Satora's exact Lightning-send quote does not take the bridge source chain (live,
    // 25 Nov 2026: "unknown variant 8453") and the swap library then falls back to an estimate (low network fee, softer rate),
    // which undershoots the swap Satora creates by ~2.5%. The swap is priced on its settlement chain, and the deposit on the
    // bridge source is burned 1:1 to it (Circle's fee is taken from the mint): so the exact quote comes from the settlement chain,
    // and Circle's fee from the composed quote on the bridge source.
    if (s.bridge && p.destination) {
      const settle = { chain: s.bridge.settleChain, tokenId: s.bridge.settleToken }; const [exact, composed] = await Promise.all([quote(settle, p.destination), quote(s)]);
      return { ...exact, bridge_fee: composed?.bridge_fee } as any;
    }
    return await quote(s, p.destination);
  }
  /** Created gasless: this Mark home's EVM key is the depositor, so no wallet or ETH is needed to fund it. Same referral ID and
   *  markup as the quote. */
  async createReverse(p: ReverseCreateInput): Promise<ReverseSwapCreated> {
    const extraFees = checkMarkupBps(p.bps);
    const targetAddress = p.to === "lightning" ? p.invoice : p.arkAddress;
    if (!targetAddress) throw new MarkError("USAGE", "a payout target is required");
    // a bridged stablecoin (USDC on Base) is minted and locked on its settlement chain by a sponsored UserOp: that plan must hold
    const t = SWAP_TARGETS[p.from]; this.assertGaslessFundingPlan(Number(t.bridge ? t.bridge.settleChain : t.chain));
    const r: any = await stdoutToStderr(() => this.c.createSwap({ source: SWAP_TARGETS[p.from] as any, target: SWAP_SOURCES[p.to] as any, targetAddress, gasless: true,
      ...(p.invoice ? {} : { sourceAmount: p.sourceUnits?.toString() as any }), referralCode: SWAP_REFERRAL_ID, extraFees } as any));
    const out = reverseFields(r?.response ?? {});
    // Satora's create response has no direction (live, 23 Nov 2026); its swap record has. Read it once, which also stores it
    // locally, so the one-open-deposit check sees this swap. Left unset when the read fails: the create check then refuses.
    if (out.id && out.direction === undefined) { try { const g: any = await this.c.getSwap(out.id, { updateStorage: true } as any); out.direction = g?.direction ?? undefined; } catch { /* refused below */ } }
    return out;
  }
  async getReverse(id: string): Promise<ReverseSwapInfo> {
    const r: any = await this.c.getSwap(id, { updateStorage: true } as any);
    let local = false; try { local = !!(await (this.c as any).getStoredSwap?.(id)); } catch { /* unknown */ }
    return { ...reverseFields(r), direction: r.direction, fundTx: r.evm_fund_txid ?? undefined, payoutTx: r.btc_claim_txid ?? undefined,
      lightningSettled: r.lightning_payment_settled ?? undefined, createdAt: r.created_at ?? undefined, local };
  }
  depositAddress(): string { return (this.c as any).getEvmAddress(); }
  /** Before creating a gasless swap: refuse if this client could not later move the deposit (no paymaster, or a self-paid plan that needs ETH). */
  assertGaslessFundingPlan(chainId: number): { mode: "sponsored" | "self-paid" | "relay" } {
    let plan: { mode: "sponsored" | "self-paid" | "relay" };
    try { plan = (this.c as any).gaslessFundingPlan(chainId); }
    catch (e) { throw new MarkError("SWAP_FAILED", `this Mark cannot fund a gasless swap on this chain (${errText(e)}). No swap was created and nothing was deposited.`); }
    if (plan?.mode === "self-paid") throw new MarkError("SWAP_FAILED", "gasless funding on this chain would need ETH on the deposit address; Mark will not create the swap or show a deposit address");
    if (plan?.mode !== "sponsored" && plan?.mode !== "relay") throw new MarkError("SWAP_FAILED", `this Mark cannot fund a gasless swap on this chain (funding plan ${String(plan?.mode)}). No swap was created.`);
    return plan;
  }
  async openReverse(): Promise<ReverseSwapInfo[]> {
    const all: any[] = (await (this.c as any).swapStorage?.getAll?.()) ?? [];
    const mine = all.map((x) => x?.response).filter((r) => r?.id && r.gasless && r.client_evm_address && r.status === "pending" && isReverseDir(r.direction));
    const out: ReverseSwapInfo[] = [];
    for (const r of mine) { try { const x = await this.getReverse(r.id); if (x.status === "pending") out.push(x); } catch { out.push({ ...reverseFields(r), local: true }); } }
    return out;
  }
  /** Funding attempts: in memory plus a file in the swaps dir, so a second process (or a restart) does not sign again while the
   *  first relay may still land. */
  private funding = new Map<string, Promise<FundResult>>();
  /** Funding attempts and create records: in memory plus files in the swaps dir, so a second process (or a restart) sees them. */
  private attempts: RecordFile<number>;
  /** Swaps from USDC on Base: what Mark's own signer sent in a funding (the burn hash, or a send of unknown outcome, marked
   *  before the send so a crash leaves it), the deposit's USDC and its expected transaction count. Kept apart from the swap library's record, so a burn it failed to record is known. */
  private sends: RecordFile<BridgeSends>;
  private pins: RecordFile<ReversePin>;
  private readAttempts() { return this.attempts.read(); }
  private readPins() { return this.pins.read(); }
  private markAttempt(id: string, at: number | undefined) { this.attempts.set(id, at); }

  // ---------- `mark swap` Lightning ↔ Arkade (same referral ID and markup as the quote) ----------
  async quoteRail(p: RailQuoteInput): Promise<SatoraQuote> {
    const extraFees = checkMarkupBps(p.bps); const s = SWAP_SOURCES[p.from], t = SWAP_SOURCES[p.to];
    return await this.c.getQuote({ sourceChain: s.chain as any, sourceToken: s.tokenId, targetChain: t.chain as any, targetToken: t.tokenId,
      ...(p.invoice ? { lightningDestination: p.invoice } : { sourceAmount: p.sats as any }),
      referralCode: SWAP_REFERRAL_ID, extraFees }) as any;
  }
  async createRail(p: RailCreateInput): Promise<RailSwapCreated> {
    const extraFees = checkMarkupBps(p.bps);
    const targetAddress = p.to === "lightning" ? p.invoice : p.address;
    if (!targetAddress) throw new MarkError("USAGE", "a payout target is required");
    // invoice pins the Lightning payout: do not also send sourceAmount (Satora rejects the combination)
    const r: any = await stdoutToStderr(() => this.c.createSwap({ source: SWAP_SOURCES[p.from] as any, target: SWAP_SOURCES[p.to] as any, targetAddress,
      ...(p.to === "lightning" ? {} : { sourceAmount: p.sats }), referralCode: SWAP_REFERRAL_ID, extraFees } as any));
    return railFields(r?.response ?? {});
  }
  async getRail(id: string): Promise<RailSwapInfo> {
    const r: any = await this.c.getSwap(id, { updateStorage: true } as any);
    let local = false; try { local = !!(await (this.c as any).getStoredSwap?.(id)); } catch { /* unknown */ }
    return { ...railFields(r), id: r.id ?? id, local, createdAt: r.created_at ?? undefined, fundTx: r.arkade_fund_txid ?? undefined, payoutTx: r.arkade_claim_txid ?? undefined };
  }
  fundAttemptedAt(id: string) { return this.readAttempts()[id]; }
  fundAttemptsSince(since: number) { return Object.entries(this.readAttempts()).filter(([, at]) => at >= since).map(([id]) => id); }
  pinReverse(id: string, pin: ReversePin) { this.pins.set(id, pin); }
  reversePin(id: string) { return this.readPins()[id]; }
  invoiceUsedBy(invoice: string) { return Object.entries(this.readPins()).find(([, p]) => sameHex(p.invoice, invoice))?.[0]; }
  fundReverse(id: string): Promise<FundResult> {
    const running = this.funding.get(id); if (running) return running;
    const run = this.fundOnce(id).finally(() => this.funding.delete(id));
    this.funding.set(id, run); return run;
  }
  private async fundOnce(id: string): Promise<FundResult> {
    return this.exclusive(async () => {
      const at = this.fundAttemptedAt(id);
      // a CCTP burn already sent (USDC on Base): funding again only resumes the settlement from that burn, it never burns again
      // (read even without a funding time in this home: a lost record must not lead to a second burn)
      // an unreadable local record is not "no burn": refuse rather than risk a second one
      let st: any; try { st = await this.storedSwap(id); } catch (e) { return { success: false, message: `could not read this Mark home's record of the swap (${errText(e)}); not funding it` }; }
      const burn = burnOf(st), ft = fundTxOf(st);
      // a submitted or uncertain funding is never signed again (only a clear refusal clears the record)
      if (at !== undefined && !burn) return { success: false, skipped: `a funding was already submitted at ${new Date(at).toISOString()}; Mark never signs it again` };
      // the resume after a burn locked it already (the swap library recorded the lock): never again, even if Satora lags
      if (burn && ft) return { success: false, skipped: `the swap was already funded (tx ${ft}); Mark never funds it again` };
      // a burn (or a send with an unknown outcome) only Mark saw: the swap library would burn again, so Mark never funds it again
      const mine = this.sends.read()[id];
      if (!burn && (mine?.burn || mine?.unknown) && at === undefined) this.markAttempt(id, Date.now()); // starts the 30-minute recover clock
      if (!burn && (mine?.burn || mine?.unknown)) return { success: false, skipped: `a funding transaction of this swap was already sent${mine.burn ? ` (burn ${mine.burn})` : " with an unknown outcome"}; Mark never signs it again. After 30 minutes, mark swap recover moves the USDC` };
      let x: ReverseSwapInfo; try { x = await this.getReverse(id); } catch (e) { return { success: false, message: `could not read the swap: ${errText(e)}` }; }
      if (x.status !== "pending" || x.fundTx) return { success: false, skipped: `the swap is already past funding (${x.status}${x.fundTx ? `, funding tx ${x.fundTx}` : ""})` };
      if (!x.tokenContract || !x.depositAddress || !/^\d+$/.test(String(x.sourceUnits ?? ""))) return { success: false, message: "the swap has no deposit terms" };
      const pin = this.reversePin(id);
      if (!pin) return { success: false, stop: true, message: "this Mark home has no record of what was confirmed when the swap was created; not funding it" };
      const why = pinMismatch(pin, x, this.depositAddress(), true);
      if (why) return { success: false, stop: true, message: `the swap no longer matches what was confirmed at create (${why}); not funding it` };
      // the deposit must not be locked behind an invoice that can no longer be paid: Satora pays it only after the lock
      if (pin.invoice) {
        let left = -1; try { left = decodeInvoice(pin.invoice).expiresAt - Date.now() / 1000; } catch { /* undecodable: refuse */ }
        if (left < FUND_MIN_INVOICE_SECS) return { success: false, stop: true, message: `the payout invoice ${left < 0 ? "has expired" : `expires in ${Math.floor(left)} s`}: Satora could not pay it after the deposit is locked, so Mark does not fund this swap` };
      }
      if (pin.bridgeSourceChain !== undefined) {
        // the swap library resumes and records burns in its own record: without it, it could not tell a burn was already sent
        if (!st) return { success: false, stop: true, message: "this Mark home has no swap-library record of this swap; not funding it" };
        return this.fundBridged(id, x, burn);
      }
      let have: bigint; try { have = await this.evm.tokenBalance(x.tokenContract, x.depositAddress); } catch (e) { return { success: false, message: `could not read the deposit address: ${errText(e)}` }; }
      if (have < BigInt(x.sourceUnits!)) return { success: false, skipped: `the deposit address holds ${have} of the ${x.sourceUnits} token units this swap needs` };
      this.markAttempt(id, Date.now());
      try {
        const r: any = await stdoutToStderr(() => (this.c as any).fundSwapGasless(id));
        return { success: true, txHash: r?.txHash ?? undefined };
      } catch (e) {
        const message = errText(e);
        // Only exact pre-submit refusals, or a previous UserOp that 1.11.1 already dropped after a revert, are safe to retry.
        // "outcome unknown", a UserOp with no transaction hash, and lookalike strings stay uncertain so Mark never signs twice.
        if (isClearFundRefusal(message)) { this.markAttempt(id, undefined); return { success: false, message }; }
        return { success: false, message, uncertain: true };
      }
    });
  }
  /** A swap from USDC on Base, under the deposit lock and after the pin checks: Mark signs USDC approve + CCTP burn on Base from the
   *  deposit key (its gas paid in ETH on Base by the deposit address), then the swap library waits for Circle's attestation and
   *  mints + locks on the settlement chain with a sponsored UserOp. Before anything is signed: the deposit address must hold the
   *  USDC and enough ETH on Base (needEth otherwise). With a burn already recorded it resumes from it (no new burn, no gas). */
  private async fundBridged(id: string, x: ReverseSwapInfo, burn: string | undefined): Promise<FundResult> {
    const t = stableOfReverse(x);
    if (!t?.bridge) return { success: false, stop: true, message: `unknown bridge source ${x.bridgeSourceChain} / ${x.bridgeSourceToken}; not funding it` };
    const r = this.evmOn(Number(t.chain)), dep = x.depositAddress!, need = BigInt(x.sourceUnits!);
    let pre: bigint | undefined;
    if (!burn) {
      let have: bigint, eth: bigint, gas: bigint;
      try { [have, eth, gas] = await Promise.all([r.tokenBalance(t.tokenId, dep), r.ethBalance(dep), gasNeedWei(r)]); }
      catch (e) { return { success: false, message: `could not read the deposit address on ${t.network}: ${errText(e)}` }; }
      if (have < need) return { success: false, skipped: `the deposit address holds ${have} of the ${need} ${t.symbol} units on ${t.network} this swap needs` };
      if (eth < gas) return { success: false, skipped: `the deposit address needs ETH on ${t.network} for gas`, needEth: { network: t.network, needWei: gas.toString(), holdsWei: eth.toString() } };
      pre = have;
    }
    this.markAttempt(id, Date.now());
    let signer: any;
    try { const k: any = await (this.c as any).getSwapDepositorKey(id); signer = await this.signerFor(k.privateKey, Number(t.chain)); }
    catch (e) { this.markAttempt(id, undefined); return { success: false, message: `could not load the deposit key: ${errText(e)}` }; }
    // every transaction the swap library sends from the deposit key goes through this counter: a failure before the first send
    // proves nothing was signed or broadcast (the mempool or a balance cannot prove that: an unrecorded burn may be mined already)
    let sends = 0; const send = signer.sendTransaction;
    // before anything is sent: the USDC and the deposit address's transaction count (the evidence a later recover needs)
    if (!burn) { let nonce: bigint | undefined; try { nonce = await r.txCount?.(dep); } catch { nonce = undefined; }
      this.sends.set(id, { ...(pre !== undefined ? { pre: pre.toString() } : {}), ...(nonce !== undefined ? { nonce: nonce.toString() } : {}) }); }
    // each send is recorded as of unknown outcome BEFORE it is handed to the signer (a crash after the broadcast leaves that
    // record); it is cleared only when the send returns: a burn records its hash, any other send moves the expected nonce on
    const counted = { ...signer, sendTransaction: async (tx: any) => {
      sends++;
      this.sends.set(id, { ...this.sends.read()[id], unknown: true });
      const h: string = await send(tx);
      const { unknown: _u, ...was } = this.sends.read()[id] ?? {};
      if (sameHex(tx?.to, TOKEN_MESSENGER_V2) && /^0x[0-9a-fA-F]{64}$/.test(String(h))) this.sends.set(id, { ...was, burn: h });
      else this.sends.set(id, { ...was, ...(was.nonce !== undefined ? { nonce: (BigInt(was.nonce) + 1n).toString() } : {}) });
      return h;
    } };
    try {
      const f: any = await stdoutToStderr(() => (this.c as any).fundSwap(id, counted));
      return { success: true, txHash: f?.txHash ?? undefined, burnTx: f?.cctp?.burnTxHash ?? burn };
    } catch (e) {
      const message = errText(e); const b = await this.cctpBurn(id);
      if (b) return { success: false, message, uncertain: true, burnTx: b };
      // retried only when nothing was ever sent in this attempt (a resume sends nothing on Base either). Anything else stays
      // uncertain: Mark never signs it again, and recover works 30 minutes later.
      if (sends === 0 && !burn) { this.markAttempt(id, undefined); this.sends.set(id, undefined); return { success: false, message }; }
      return { success: false, message, uncertain: true };
    }
  }
  /** In-process queue plus a lock file in the swaps dir (O_EXCL create; a lock older than LOCK_STALE_MS is taken over). */
  private lockTail: Promise<unknown> = Promise.resolve();
  exclusive<T>(f: () => Promise<T>): Promise<T> {
    const run = this.lockTail.then(() => this.withFileLock(f), () => this.withFileLock(f)); this.lockTail = run.catch(() => undefined); return run;
  }
  private async withFileLock<T>(f: () => Promise<T>): Promise<T> {
    if (!this.dir) return f();
    const lock = path.join(this.dir, "evm-deposit.lock"); const end = Date.now() + LOCK_WAIT_MS;
    const token = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
    for (;;) {
      try { fs.writeFileSync(lock, token, { flag: "wx", mode: 0o600 }); break; }
      catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        if (takeStale(lock)) continue;
        if (Date.now() > end) throw new MarkError("SWAP_BUSY", "another Mark process is creating, funding or recovering a swap from a stablecoin in this Mark home; retry in a minute");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    // heartbeat: a long create or funding keeps its lock fresh, so it is never taken as stale
    const beat = setInterval(() => { try { if (fs.readFileSync(lock, "utf8") === token) { const t = new Date(); fs.utimesSync(lock, t, t); } } catch { /* gone */ } }, LOCK_BEAT_MS);
    beat.unref?.();
    try { return await f(); }
    finally { clearInterval(beat); releaseLock(lock, token); }
  }
  async refundReverse(id: string) {
    return stdoutToStderr(async () => {
      let collab: string;
      try { const r: any = await (this.c as any).collabRefundEvmSwap(id); if (!r?.txHash) throw new Error("no refund transaction returned"); return { success: true, txHash: r.txHash, how: "collaborative (gasless)" }; }
      catch (x) { collab = errText(x); }
      try { const r: any = await (this.c as any).refundEvmSponsored(id); if (!r?.txHash && !r?.userOpHash) throw new Error("no refund transaction returned"); return { success: true, txHash: r.txHash ?? undefined, how: "timelock (sponsored, gasless)" }; }
      catch (x) { return { success: false, message: `collaborative refund: ${collab}; timelock refund: ${errText(x)}`.slice(0, 900) }; }
    });
  }
  async recoverReverse(id: string, to: string): Promise<{ success: boolean; txHash?: string; amountUnits?: string; message?: string; network?: string }> {
    // which path (Base sweep, post-burn recovery, Arbitrum) depends on the record: an unreadable one moves nothing, and a missing
    // local copy falls back to Satora's own record of the swap (its bridge source), never to a guess
    let st: any, resp: any;
    try { st = await this.storedSwap(id); resp = st?.response ?? (await this.c.getSwap(id)); }
    catch (e) { return { success: false, message: `could not read the swap's record (${errText(e)}); nothing was moved` }; }
    resp = resp ?? {};
    const t = resp.bridge_source_chain ? stableOfReverse({ tokenContract: resp.source_token?.token_id, bridgeSourceChain: resp.bridge_source_chain, bridgeSourceToken: resp.bridge_source_token_address }) : undefined;
    if (resp.bridge_source_chain && !t?.bridge) return { success: false, message: `unknown bridge source ${resp.bridge_source_chain}; nothing was moved` };
    if (t?.bridge) {
      const mine = this.sends.read()[id];
      if (burnOf(st)) return this.recoverBurned(id, to, t.bridge.settleNetwork);
      // a burn Mark's signer sent but the swap library did not record: recover on the settlement chain from that burn
      if (mine?.burn) return this.recoverBurned(id, to, t.bridge.settleNetwork, mine.burn);
      // a send that failed with an unknown outcome: a balance proves nothing (the address is shared, a later deposit can refill it).
      // Only the deposit address's transaction count proves it: unchanged since before the attempt means nothing of it was sent
      // Any funding record with a transaction count (a crash can leave one without the unknown mark) is checked the same way
      if (mine?.unknown || mine?.nonce !== undefined) {
        let now: bigint | undefined; try { now = await this.evmOn(Number(t.chain)).txCount?.(this.depositAddress()); }
        catch (e) { return { success: false, message: `could not read the deposit address on ${t.network} (${errText(e)}); nothing was moved`, network: t.network }; }
        if (mine.nonce === undefined || now === undefined || now !== BigInt(mine.nonce)) return { success: false, network: t.network,
          message: `a ${t.network} transaction of this swap's funding may have been sent and the deposit address has sent transactions since: a burn may have gone through. Nothing was moved. Check the deposit address on ${t.network}'s explorer for a Circle CCTP burn (depositForBurn); that burn is recovered on ${t.bridge.settleNetwork}, not by a ${t.network} sweep` };
      }
      return this.sweepOn(id, to, t.tokenId, Number(t.chain), t.network);
    }
    return stdoutToStderr(async () => {
      try {
        const k: any = await (this.c as any).getSwapDepositorKey(id);
        const signer = await this.signerFor(k.privateKey);
        const r: any = await (this.c as any).recoverGaslessFunds(id, signer, to);
        if (!r?.txHash) return { success: false, message: "the recovery returned no transaction; check the explorer before retrying" };
        return { success: true, txHash: r?.txHash ?? undefined, amountUnits: r?.amount != null ? String(r.amount) : undefined };
      } catch (x) { return { success: false, message: errText(x) }; }
    });
  }
  /** After the CCTP burn of a swap from USDC on Base: Circle mints it to the deposit account on the settlement chain if not yet, then
   *  its USDC is swept to `to` there, both as sponsored UserOps (no ETH). */
  private async recoverBurned(id: string, to: string, network: string, burnTxHash?: string) {
    return stdoutToStderr(async () => {
      try {
        const r: any = await (this.c as any).recoverCctpInboundSwap(id, to, burnTxHash ? { burnTxHash } : undefined);
        const tx = r?.sweepTxHash ?? r?.sweepUserOpHash;
        if (!tx) return { success: false, message: "the recovery returned no transaction; check the explorer before retrying", network };
        return { success: true, txHash: tx, amountUnits: r?.recoveredAmount != null ? String(r.recoveredAmount) : undefined, network };
      } catch (x) { return { success: false, message: errText(x), network }; }
    });
  }
  /** One ERC-20 transfer of the deposit address's whole `token` balance to `to` on `chainId` (gas from the deposit address). */
  private async sweepOn(id: string, to: string, token: string, chainId: number, network: string) {
    return stdoutToStderr(async () => {
      try {
        const r = this.evmOn(chainId); const k: any = await (this.c as any).getSwapDepositorKey(id);
        const signer = await this.signerFor(k.privateKey, chainId);
        const bal = await r.tokenBalance(token, signer.address);
        if (bal === 0n) return { success: false, message: "the deposit address holds none of the token; nothing was moved", network };
        const txHash: string = await signer.sendTransaction({ to: token, data: transferData(to, bal) });
        const rc: any = await signer.waitForReceipt(txHash);
        if (rc?.status !== "success") return { success: false, message: `the transfer ${txHash} reverted; nothing was moved`, network };
        return { success: true, txHash, amountUnits: bal.toString(), network };
      } catch (x) { return { success: false, message: errText(x), network }; }
    });
  }
  /** The deposit-key signer on Arbitrum One (default) or Base (tests replace it). The key never leaves this call. */
  signerFor: (privateKey: string, chainId?: number) => Promise<any> = (k, chainId) => viemSigner(k, undefined, chainId);
}

/** A record (id -> value) in memory, mirrored to a 0600 JSON file in the swaps dir when there is one (written atomically). */
class RecordFile<T> {
  private mem: Record<string, T> = {};
  constructor(private dir: string | undefined, private name: string, private ok: (v: unknown) => boolean) {}
  private file() { return this.dir ? path.join(this.dir, this.name) : undefined; }
  read(): Record<string, T> {
    const f = this.file(); if (!f || !fs.existsSync(f)) return this.mem;
    return { ...readRecord(f, this.name, this.ok), ...this.mem };
  }
  set(id: string, v: T | undefined) {
    const a = { ...this.read() }; if (v === undefined) delete a[id]; else a[id] = v; this.mem = a;
    const f = this.file(); if (f) { fs.writeFileSync(f + ".tmp", JSON.stringify(a), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); }
  }
}
/** A record file in the swaps dir: missing -> empty; unreadable or malformed -> refuse (never treated as empty, which would
 *  forget a funding already submitted or the terms confirmed at create). */
function readRecord(f: string, name: string, ok: (v: unknown) => boolean): Record<string, any> {
  let v: any; try { v = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e: any) { if (e?.code === "ENOENT") return {}; v = undefined; }
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.values(v).every(ok))
    throw new MarkError("SWAP_FAILED", `${name} in this Mark home's swaps folder is unreadable; Mark will not create or fund a swap from a stablecoin until it is fixed or restored`);
  return v;
}
/** The deposit lock: wait this long for another process; its owner refreshes it every LOCK_BEAT_MS, so a lock not refreshed for
 *  LOCK_STALE_MS whose owner process is gone is taken over. */
const LOCK_WAIT_MS = 90_000, LOCK_STALE_MS = 5 * 60 * 1000, LOCK_BEAT_MS = 30_000;
/** Take over a stale lock atomically: only one process can rename it away; if what was renamed is not the stale lock it looked
 *  at (another process took it over meanwhile), it is put back. True: retry acquiring now. */
/** Release only our own lock, atomically: rename it away first (no other process can take that file over meanwhile), then
 *  put back whatever was not ours. */
function releaseLock(lock: string, token: string) {
  const moved = `${lock}.rel-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try { fs.renameSync(lock, moved); } catch { return; }
  try { if (fs.readFileSync(moved, "utf8") !== token) { try { fs.linkSync(moved, lock); } catch { /* a newer lock is there */ } } }
  finally { fs.rmSync(moved, { force: true }); }
}
function takeStale(lock: string): boolean {
  let seen: string, st: fs.Stats;
  try { st = fs.statSync(lock); seen = fs.readFileSync(lock, "utf8"); } catch { return true; }
  if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
  const pid = Number(seen.split(":")[0]);
  if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) { try { process.kill(pid, 0); return false; } catch (e: any) { if (e?.code === "EPERM") return false; } }
  const moved = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try { fs.renameSync(lock, moved); } catch { return true; }
  try {
    if (fs.readFileSync(moved, "utf8") !== seen) { try { fs.linkSync(moved, lock); } catch { /* a newer lock is there: it wins */ } }
  } finally { fs.rmSync(moved, { force: true }); }
  return true;
}
/** Satora's Lightning ↔ Arkade answer only (never defaulted to the request). */
function railFields(r: any): RailSwapCreated {
  return { id: r.id, status: r.status, direction: r.direction ?? undefined,
    invoice: r.bolt11_invoice ?? r.client_lightning_invoice ?? undefined,
    fundArkAddress: r.arkade_vhtlc_address ?? undefined, payoutArkAddress: r.target_arkade_address ?? undefined,
    payAmountSats: r.source_amount != null ? Number(r.source_amount) : NaN,
    receiveSats: r.target_amount != null ? Number(r.target_amount) : undefined,
    sourceChain: r.source_token?.chain ?? undefined, targetChain: r.target_token?.chain ?? undefined, raw: r };
}
/** Satora's EVM-sourced swap answer only (never defaulted to the request), so a missing or different value is caught. */
function reverseFields(r: any): ReverseSwapCreated {
  return { id: r.id, status: r.status, direction: r.direction ?? undefined, gasless: r.gasless ?? undefined, depositAddress: r.client_evm_address ?? undefined,
    sourceUnits: r.source_amount != null ? String(r.source_amount) : undefined, tokenContract: r.source_token?.token_id ?? undefined,
    sourceChain: r.source_token?.chain ?? undefined, evmChainId: r.evm_chain_id != null ? Number(r.evm_chain_id) : undefined,
    targetChain: r.target_token?.chain ?? undefined, targetSats: r.target_amount != null ? Number(r.target_amount) : undefined,
    invoice: r.client_lightning_invoice ?? undefined, arkAddress: r.target_arkade_address ?? undefined,
    bridgeSourceChain: r.bridge_source_chain ?? undefined, bridgeSourceToken: r.bridge_source_token_address ?? undefined, raw: r };
}
