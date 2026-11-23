import fs from "node:fs";
import path from "node:path";
import { Client } from "@satora/swap";
import type { SwapProvider, SwapInfo, ClaimResult, StableSwapCreated, StableSwapInfo, ReverseQuoteInput, ReverseCreateInput, ReverseSwapCreated, ReverseSwapInfo, FundResult } from "./provider.js";
import { arbitrumReader, viemSigner, type EvmReader } from "./evm.js";
import { SWAP_REFERRAL_ID, SWAP_SOURCES, SWAP_TARGETS, checkMarkupBps, type SatoraQuote, type SwapSource, type SwapTarget } from "./stable.js";
import { encryptWith, decryptWith } from "../crypto/keystore.js";
import { MarkError } from "../errors.js";
import { WITNESS_SCRIPT_BUG, WORKAROUND_ID, libTransactionBases, withTaprootWitnessScriptFix } from "./satoraWorkaround.js";

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

/** The swap library prints progress with console.log; Mark's stdout is JSON (CLI) or the MCP stdio stream, so send it to stderr. */
/** Claims and refunds run one at a time per process (MCP may get concurrent calls): the console redirect and the resume-bug
 *  workaround patch process-global objects, and overlapping patch/restore pairs could leave either one in place. */
let serialTail: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const run = serialTail.then(f, f); serialTail = run.catch(() => undefined); return run;
}
function stdoutToStderr<T>(f: () => Promise<T>): Promise<T> {
  return serial(async () => {
    const log = console.log, info = console.info, debug = console.debug;
    console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
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

export class SatoraProvider implements SwapProvider {
  readonly name = "satora";
  /** dir: where the funding-attempt record lives (none: in memory only, tests). */
  private constructor(private c: Client, private baseUrl: string, private arkUrl: string, private dir?: string) {}
  /** Arbitrum reads (tests replace it). */
  evm: EvmReader = arbitrumReader();
  /** Where the library's bundled Transaction classes come from (tests replace it). */
  txBases: () => Promise<any[]> = () => libTransactionBases();

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
   * claimArkade first finalizes a pending claim (if one was submitted) and otherwise submits a new one. When it finds the VHTLC
   * already spent it retries the finalize internally but only reports "All VTXOs have already been spent."; ask the finalize step
   * directly so the real reason reaches the user (detail).
   */
  async claim(id: string, arkAddress: string): Promise<ClaimResult> {
    return stdoutToStderr(async () => {
      let r: any;
      try { r = await this.c.claimArkade(id, { destinationAddress: arkAddress, arkadeServerUrl: this.arkUrl }); }
      catch (x) { return { success: false, message: `claim failed: ${errText(x)}` }; }
      if (r?.success) return { success: true, txid: r.txId, message: r.message };
      const message = typeof r?.message === "string" ? r.message.slice(0, 500) : "claim failed";
      // generic "already spent" (the library swallowed the finalize error) or the resume bug itself: ask the finalize step directly
      if (!/already been spent/i.test(message) && !WITNESS_SCRIPT_BUG.test(message)) return { success: false, message };
      return this.finishPendingClaim(id, message);
    });
  }

  /** Finalize a claim that was submitted but not finalized; works around the upstream resume bug (satoraWorkaround.ts) once. */
  private async finishPendingClaim(id: string, message: string): Promise<ClaimResult> {
    const once = async () => { try { return await this.c.continueArkadeClaimSwap(id) as any; } catch (x) { return { success: false, message: errText(x) }; } };
    let k: any = await once();
    if (k?.success) return { success: true, txid: k.txId, message: k.message };
    let detail = typeof k?.message === "string" && k.message ? `finalizing the pending claim failed: ${k.message.slice(0, 500)}` : undefined;
    if (!WITNESS_SCRIPT_BUG.test(String(k?.message ?? ""))) return { success: false, message, ...(detail && k.message !== message ? { detail } : {}) };
    const bases = await this.txBases().catch(() => []);
    if (!bases.length) return { success: false, message, detail: `${detail} (upstream @satora/swap resume bug; Mark could not apply its workaround to this library version)` };
    const { result, dropped } = await withTaprootWitnessScriptFix(bases, once);
    k = result;
    if (k?.success) return { success: true, txid: k.txId, message: k.message, workaround: WORKAROUND_ID, workaroundApplied: dropped } as ClaimResult;
    return { success: false, message, detail: `${detail}; retry with Mark's workaround for the upstream resume bug (${dropped} field(s) dropped) failed: ${String(k?.message ?? "unknown error").slice(0, 500)}`, workaround: WORKAROUND_ID } as ClaimResult;
  }

  async refund(id: string, arkAddress: string) {
    const r: any = await stdoutToStderr(() => this.c.refundSwap(id, { destinationAddress: arkAddress, arkadeServerUrl: this.arkUrl } as any));
    return { success: !!r.success, txid: r.txId, message: r.message };
  }

  // ---------- `mark swap`: BTC (Lightning / Arkade) -> stablecoin on Arbitrum ----------
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
    const r: any = await stdoutToStderr(() => this.c.createSwap({ source: SWAP_SOURCES[p.from] as any, target: SWAP_TARGETS[p.to] as any, sourceAmount: p.sats, targetAddress: p.address,
      referralCode: SWAP_REFERRAL_ID, extraFees }));
    const res = r?.response ?? {};
    // Satora's answer only: never default these to the request, so a missing or different value is caught before payment
    return { id: res.id, status: res.status, invoice: res.bolt11_invoice ?? undefined, arkAddress: res.btc_vhtlc_address ?? undefined,
      payAmountSats: res.source_amount != null ? Number(res.source_amount) : NaN, targetAddress: res.target_evm_address ?? undefined,
      receiveUnits: res.target_amount != null ? String(res.target_amount) : undefined, sourceChain: res.source_token?.chain ?? undefined, targetChain: res.target_token?.chain ?? undefined,
      tokenContract: res.target_token?.token_id ?? undefined, evmChainId: res.evm_chain_id != null ? Number(res.evm_chain_id) : undefined, raw: res };
  }
  async getStable(id: string): Promise<StableSwapInfo> {
    const r: any = await this.c.getSwap(id, { updateStorage: true } as any);
    let local = false; try { local = !!(await (this.c as any).getStoredSwap?.(id)); } catch { /* unknown */ }
    return { id: r.id ?? id, status: r.status, direction: r.direction, sourceAmountSats: r.source_amount != null ? Number(r.source_amount) : undefined, targetUnits: r.target_amount != null ? String(r.target_amount) : undefined,
      targetAddress: r.target_evm_address ?? r.client_evm_address ?? undefined, tokenContract: r.target_token?.token_id ?? undefined, tokenSymbol: r.target_token?.symbol ?? undefined, evmChainId: r.evm_chain_id ?? undefined,
      payoutTx: r.evm_claim_txid ?? undefined, feeSats: r.fee_sats ?? undefined, createdAt: r.created_at ?? undefined, local, raw: r };
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
    return await this.c.getQuote({ sourceChain: s.chain as any, sourceToken: s.tokenId, targetChain: t.chain as any, targetToken: t.tokenId,
      ...(p.sourceUnits !== undefined ? { sourceAmount: p.sourceUnits.toString() as any } : { targetAmount: p.targetSats as any }),
      ...(p.destination ? { lightningDestination: p.destination } : {}), referralCode: SWAP_REFERRAL_ID, extraFees }) as any;
  }
  /** Created gasless: this Mark home's EVM key is the depositor, so no wallet or ETH is needed to fund it. Same referral ID and
   *  markup as the quote. */
  async createReverse(p: ReverseCreateInput): Promise<ReverseSwapCreated> {
    const extraFees = checkMarkupBps(p.bps);
    const targetAddress = p.to === "lightning" ? (p.invoice ?? p.lnAddress) : p.arkAddress;
    if (!targetAddress) throw new MarkError("USAGE", "a payout target is required");
    const r: any = await stdoutToStderr(() => this.c.createSwap({ source: SWAP_TARGETS[p.from] as any, target: SWAP_SOURCES[p.to] as any, targetAddress, gasless: true,
      ...(p.invoice ? {} : { sourceAmount: p.sourceUnits?.toString() as any }), referralCode: SWAP_REFERRAL_ID, extraFees } as any));
    return reverseFields(r?.response ?? {});
  }
  async getReverse(id: string): Promise<ReverseSwapInfo> {
    const r: any = await this.c.getSwap(id, { updateStorage: true } as any);
    let local = false; try { local = !!(await (this.c as any).getStoredSwap?.(id)); } catch { /* unknown */ }
    return { ...reverseFields(r), direction: r.direction, fundTx: r.evm_fund_txid ?? undefined, payoutTx: r.btc_claim_txid ?? undefined,
      lightningSettled: r.lightning_payment_settled ?? undefined, createdAt: r.created_at ?? undefined, local };
  }
  depositAddress(): string { return (this.c as any).getEvmAddress(); }
  async openReverse(): Promise<ReverseSwapInfo[]> {
    const all: any[] = (await (this.c as any).swapStorage?.getAll?.()) ?? [];
    const mine = all.map((x) => x?.response).filter((r) => r?.id && r.gasless && r.client_evm_address && r.status === "pending" && /^evm_to_/.test(r.direction ?? ""));
    const out: ReverseSwapInfo[] = [];
    for (const r of mine) { try { const x = await this.getReverse(r.id); if (x.status === "pending") out.push(x); } catch { out.push({ ...reverseFields(r), local: true }); } }
    return out;
  }
  /** Funding attempts: in memory plus a file in the swaps dir, so a second process (or a restart) does not sign again while the
   *  first relay may still land. */
  private funding = new Map<string, Promise<FundResult>>();
  private attempts: Record<string, number> = {};
  private attemptsFile() { return this.dir ? path.join(this.dir, "evm-funding.json") : undefined; }
  private readAttempts(): Record<string, number> {
    const f = this.attemptsFile(); if (!f || !fs.existsSync(f)) return this.attempts;
    try { return { ...JSON.parse(fs.readFileSync(f, "utf8")), ...this.attempts }; } catch { return this.attempts; }
  }
  private markAttempt(id: string, at: number | undefined) {
    const a = this.readAttempts(); if (at === undefined) delete a[id]; else a[id] = at; this.attempts = a;
    const f = this.attemptsFile(); if (f) { fs.writeFileSync(f + ".tmp", JSON.stringify(a), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); }
  }
  fundAttemptedAt(id: string) { return this.readAttempts()[id]; }
  fundReverse(id: string): Promise<FundResult> {
    const running = this.funding.get(id); if (running) return running;
    const run = this.fundOnce(id).finally(() => this.funding.delete(id));
    this.funding.set(id, run); return run;
  }
  private async fundOnce(id: string): Promise<FundResult> {
    const at = this.fundAttemptedAt(id);
    if (at !== undefined && Date.now() - at < FUND_RETRY_AFTER_MS) return { success: false, skipped: `a funding was already submitted at ${new Date(at).toISOString()}; Mark does not sign again for ${FUND_RETRY_AFTER_MS / 60000} minutes` };
    this.markAttempt(id, Date.now());
    try {
      const r: any = await stdoutToStderr(() => (this.c as any).fundSwapGasless(id));
      return { success: true, txHash: r?.txHash ?? undefined };
    } catch (x) {
      const message = errText(x);
      // a clear refusal before or by the relay: nothing was submitted, so a later retry is safe
      if (/^(Failed to get Permit2 funding data|Gasless fund relay failed: 4\d\d)|not found in local storage|Expected an EVM-sourced swap/.test(message)) { this.markAttempt(id, undefined); return { success: false, message }; }
      return { success: false, message, uncertain: true };
    }
  }
  async refundReverse(id: string) {
    return stdoutToStderr(async () => {
      let collab: string;
      try { const r: any = await (this.c as any).collabRefundEvmSwap(id); return { success: true, txHash: r?.txHash ?? undefined, how: "collaborative (gasless)" }; }
      catch (x) { collab = errText(x); }
      try { const r: any = await (this.c as any).refundEvmSponsored(id); return { success: true, txHash: r?.txHash ?? undefined, how: "timelock (sponsored, gasless)" }; }
      catch (x) { return { success: false, message: `collaborative refund: ${collab}; timelock refund: ${errText(x)}`.slice(0, 900) }; }
    });
  }
  async recoverReverse(id: string, to: string) {
    return stdoutToStderr(async () => {
      try {
        const k: any = await (this.c as any).getSwapDepositorKey(id);
        const signer = await this.signerFor(k.privateKey);
        const r: any = await (this.c as any).recoverGaslessFunds(id, signer, to);
        return { success: true, txHash: r?.txHash ?? undefined, amountUnits: r?.amount != null ? String(r.amount) : undefined };
      } catch (x) { return { success: false, message: errText(x) }; }
    });
  }
  /** The recovery signer (tests replace it). The key never leaves this call. */
  signerFor: (privateKey: string) => Promise<any> = (k) => viemSigner(k);
}

/** After a funding attempt that may have reached the relay, wait this long before signing again (Arbitrum confirms in seconds). */
const FUND_RETRY_AFTER_MS = 10 * 60 * 1000;
/** Satora's EVM-sourced swap answer only (never defaulted to the request), so a missing or different value is caught. */
function reverseFields(r: any): ReverseSwapCreated {
  return { id: r.id, status: r.status, gasless: r.gasless ?? undefined, depositAddress: r.client_evm_address ?? undefined,
    sourceUnits: r.source_amount != null ? String(r.source_amount) : undefined, tokenContract: r.source_token?.token_id ?? undefined,
    sourceChain: r.source_token?.chain ?? undefined, evmChainId: r.evm_chain_id != null ? Number(r.evm_chain_id) : undefined,
    targetChain: r.target_token?.chain ?? undefined, targetSats: r.target_amount != null ? Number(r.target_amount) : undefined,
    invoice: r.client_lightning_invoice ?? undefined, arkAddress: r.target_arkade_address ?? undefined, raw: r };
}
