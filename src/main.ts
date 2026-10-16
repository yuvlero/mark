/** CLI adapter (entry: cli.ts runs the Node version check first): parse argv -> core use-case -> JSON on stdout. No business logic here. */
import readline from "node:readline";
import fs from "node:fs";
import { normalizeNetwork } from "./config.js";
import { MarkError, errorJson, toJson } from "./errors.js";
import { openCtx } from "./core/context.js";
import * as uc from "./core/usecases.js";
import { checkEscrowArgs, parseArgs } from "./cliArgs.js";
export { parseArgs };

const s = (v: unknown) => (typeof v === "string" ? v : undefined);
const out = (o: unknown) => process.stdout.write(toJson(o) + "\n");
const payout = (f: Record<string, unknown>) => ({ payoutInvoice: s(f["payout-invoice"]), payoutLnaddr: s(f["payout-lnaddr"]), payoutArk: s(f["payout-ark"]) });
/** Terms from --terms-file <json> then per-field flags (flags win). */
function termsFrom(f: Record<string, string | boolean>): uc.TermsInput {
  let base: any = {};
  if (s(f["terms-file"])) { try { base = JSON.parse(fs.readFileSync(s(f["terms-file"])!, "utf8")); } catch (e: any) { throw new MarkError("BAD_TERMS", `cannot read --terms-file: ${e.message}`); } }
  const t: any = { ...base };
  for (const [flag, k] of [["title", "title"], ["description", "description"], ["deliverable", "deliverable"], ["acceptance", "acceptance"], ["deliverable-sha256", "deliverableSha256"]]) if (s(f[flag]) !== undefined) t[k] = s(f[flag]);
  return t;
}
const USAGE = "mark <init|pubkey|backup|mcp|escrow create|show|accept|evidence|fund|limits|quote|status|pending|approve|dispute|refund|refund-payout|messages|message|inbox|invites> [--network bitcoin|mutinynet] [--escrow-url URL]";
async function main(): Promise<"keep" | void> {
  const { pos, f } = parseArgs(process.argv.slice(2));
  const network = normalizeNetwork(s(f.network)); const escrowUrl = s(f["escrow-url"]);
  switch (pos[0]) {
    case "init": return void out(await uc.init(network, { escrowUrl }));
    case "pubkey": return void out(uc.pubkey(await openCtx(network, { escrowUrl })));
    case "backup": {
      const phrase = uc.revealBackupPhrase(network, !!process.stdout.isTTY && !!process.stdin.isTTY && !f.json);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans: string = await new Promise((r) => rl.question("Show backup phrase on screen? Type 'yes': ", r)); rl.close();
      process.stdout.write(ans.trim() === "yes" ? `\n${phrase}\n\nWrite it down offline. Clear your terminal scrollback.\n` : "aborted\n"); return;
    }
    case "mcp": { const { runMcp } = await import("./mcp.js"); await runMcp(network, { escrowUrl }); return "keep"; }
    case "escrow": {
      const id = pos[2] as string; const bad = checkEscrowArgs(pos[1], id, f); if (bad) throw bad;
      const c = await openCtx(network, { escrowUrl });
      switch (pos[1]) {
        case "create": {
          return void out(await uc.create(c, { role: uc.requireRole(s(f.role)), counterparty: s(f.counterparty)!, sats: Number(f.sats), deadline: s(f.deadline)!, hash: s(f.hash), arbiterMode: s(f.arbiter) as any, webhookUrl: s(f.webhook), terms: termsFrom(f) }));
        }
        case "show": return void out(await uc.show(c, id));
        case "accept": return void out(await uc.accept(c, id));
        case "evidence": return void out(await uc.addEvidence(c, id, { text: s(f.text) ?? s(f.note), sha256: s(f.sha256), url: s(f.url), file: s(f.file) }));
        case "fund": return void out(await uc.fund(c, id, { wait: !!f.wait, timeoutSec: Number(f.timeout || 900), onInvoice: out }));
        case "status": return void out(await uc.status(c, id));
        case "limits": return void out(await uc.limits(c, f.sats !== undefined ? Number(f.sats) : undefined));
        case "quote": return void out(await uc.quote(c, id, uc.requireKind(s(f.path), "release"), s(f.dest)));
        case "pending": return void out(id ? await uc.pending(c, id) : await uc.pendingAll(c));
        case "approve": return void out(await uc.approve(c, id, { kind: s(f.kind) as any, with: s(f.with) as any, preimage: s(f.preimage), ...payout(f) }));
        case "dispute": return void out(await uc.dispute(c, id, s(f.reason)));
        case "refund": return void out(await uc.refund(c, id, { with: s(f.with) as any, ...payout(f) }));
        case "messages": return void out(await uc.messages(c, id, f.since !== undefined ? Number(f.since) : undefined));
        case "message": return void out(await uc.postMessage(c, id, { text: s(f.text) ?? s(f.note), kind: s(f.kind), replyTo: s(f["reply-to"]) }));
        case "inbox": return void out(await uc.inbox(c));
        case "invites": return void out(await uc.invites(c, { all: !!f.all, needs: s(f.needs), state: s(f.state) }));
        case "refund-payout": return void out(await uc.refundPayout(c, id, s(f.to)));
      }
      throw new MarkError("USAGE", USAGE);
    }
    default: out({ usage: USAGE, defaultNetwork: normalizeNetwork() });
  }
}

main().then((r) => { if (r !== "keep") process.exit(0); }).catch((e) => { process.stdout.write(JSON.stringify(errorJson(e)) + "\n"); process.exit(1); });
