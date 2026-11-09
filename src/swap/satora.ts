import fs from "node:fs";
import path from "node:path";
import { Client } from "@satora/swap";
import type { SwapProvider, SwapInfo, ClaimResult } from "./provider.js";
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
async function stdoutToStderr<T>(f: () => Promise<T>): Promise<T> {
  const log = console.log, info = console.info, debug = console.debug;
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  try { return await f(); } finally { console.log = log; console.info = info; console.debug = debug; }
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
  private constructor(private c: Client, private baseUrl: string, private arkUrl: string) {}
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
    return new SatoraProvider(c, opts.baseUrl, opts.arkServerUrl);
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

}
