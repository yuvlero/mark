/** CLI usage checks (pure; tested without spawning). */
import { MarkError } from "./errors.js";
export function parseArgs(argv: string[]) {
  const pos: string[] = []; const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); if (v !== undefined) f[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith("--")) f[k] = argv[++i]; else f[k] = true; }
    else pos.push(a);
  }
  return { pos, f };
}
const s = (v: unknown) => (typeof v === "string" ? v : undefined);
/** Per-subcommand usage, shown on a usage error. */
export const ESCROW_USAGE: Record<string, string> = {
  create: "mark escrow create --role buyer|seller --counterparty <xonly pubkey> --sats N --deadline <seconds|ISO> --title <short> --description <text> [--deliverable <text>] [--acceptance <criteria>] [--deliverable-sha256 <hex>] [--terms-file <json>] [--hash <sha256hex>] [--arbiter auto|manual] [--webhook url]",
  show: "mark escrow show <id>", accept: "mark escrow accept <id>",
  evidence: "mark escrow evidence <id> [--text \"...\" (alias --note)] [--sha256 <hex> | --file <path> (hashed locally, not uploaded)] [--url <https://...>]",
  fund: "mark escrow fund <id> [--wait] [--timeout <sec>]", status: "mark escrow status <id>", limits: "mark escrow limits [--sats N]",
  quote: "mark escrow quote <id> [--path release|refund] [--dest <bolt11|lightning address>]", pending: "mark escrow pending [<id>]   (no id: all my deals)",
  approve: "mark escrow approve <id> [--payout-invoice <bolt11> | --payout-lnaddr <user@domain> | --payout-ark <ark address>] [--kind release|refund] [--with counterparty|arbiter] [--preimage <hex>]",
  dispute: "mark escrow dispute <id> [--reason \"...\"]", refund: "mark escrow refund <id> --payout-invoice <bolt11> | --payout-lnaddr <user@domain> | --payout-ark <addr> [--with arbiter|counterparty]",
  "refund-payout": "mark escrow refund-payout <id> [--to <ark address>]",
  messages: "mark escrow messages <id> [--since <cursor>]",
  message: "mark escrow message <id> --text \"...\" [--kind question|dispute|evidence|info] [--reply-to <messageId>]",
  inbox: "mark escrow inbox",
  invites: "mark escrow invites [--all] [--needs accept|fund|sign|any] [--state <state>]",
};
/** `mark demo` (house-seller demo deal). */
export const DEMO_USAGE = "mark demo [--offer summary|research] [--url <https://...> | --text \"...\"] [--words N] [--focus ...] [--language ...] [--question \"...\"] [--scope ...] [--topic ...] [--yes] [--expect-sats N] [--wait] [--timeout <sec>] [--new]   (no --yes: preview only, nothing is created)";
export function checkDemoArgs(f: Record<string, string | boolean>) {
  const usage = (msg: string) => new MarkError("USAGE", `${msg}. usage: ${DEMO_USAGE}`, { usage: DEMO_USAGE });
  for (const k of ["yes", "wait", "new"]) if (f[k] !== undefined && f[k] !== true) return usage(`--${k} takes no value`);
  for (const [k, v] of Object.entries(f)) if (v === true && !["yes", "wait", "new", "json"].includes(k)) return usage(`--${k} needs a value`);
  for (const k of ["expect-sats", "timeout"]) if (f[k] !== undefined && !/^\d+$/.test(String(f[k]))) return usage(`--${k} must be a whole number`);
  return null;
}
const NEEDS_ID = new Set(["show", "accept", "evidence", "fund", "status", "quote", "approve", "dispute", "refund", "refund-payout", "messages", "message"]);
/** Usage checks before any network/keystore access: unknown subcommand, missing id, missing/ambiguous flags. */
export function checkEscrowArgs(sub: string | undefined, id: string | undefined, f: Record<string, string | boolean>) {
  const usage = (msg: string) => new MarkError("USAGE", `${msg}. usage: ${ESCROW_USAGE[sub!] ?? Object.values(ESCROW_USAGE).join(" | ")}`, { usage: sub && ESCROW_USAGE[sub] ? ESCROW_USAGE[sub] : ESCROW_USAGE });
  if (!sub || !ESCROW_USAGE[sub]) return usage(sub ? `unknown escrow subcommand '${sub}' (one of: ${Object.keys(ESCROW_USAGE).join(", ")})` : "escrow subcommand required");
  if (NEEDS_ID.has(sub) && !id) return usage("escrow id required");
  for (const [k, v] of Object.entries(f)) if (v === true && !["wait", "json", "all"].includes(k)) return usage(`--${k} needs a value`);
  if (sub === "create") { const miss = ["role", "counterparty", "sats", "deadline"].filter((k) => !s(f[k])); if (miss.length) return usage(`missing ${miss.map((k) => "--" + k).join(", ")}`); if (!/^\d+$/.test(s(f.sats)!)) return usage("--sats must be a whole number of sats"); }
  if (sub === "limits" && f.sats !== undefined && !/^\d+$/.test(String(f.sats))) return usage("--sats must be a whole number of sats");
  if (sub === "evidence") { if (s(f.text) && s(f.note) && s(f.text) !== s(f.note)) return usage("pass --text or --note, not both"); if (!s(f.text) && !s(f.note) && !s(f.file)) return usage("evidence text required (--text or --note), or --file <path>"); }
  if (sub === "message" && !s(f.text) && !s(f.note)) return usage("message text required (--text)");
  if (sub === "message" && f.kind !== undefined && !["question", "dispute", "evidence", "info"].includes(String(f.kind))) return usage("--kind must be question|dispute|evidence|info");
  if (sub === "invites" && f.needs !== undefined && !["accept", "fund", "sign", "any"].includes(String(f.needs))) return usage("--needs must be accept|fund|sign|any");
  if (sub === "messages" && f.since !== undefined && !/^\d+$/.test(String(f.since))) return usage("--since must be a cursor (integer)");
  if (sub === "quote" && f.path !== undefined && f.path !== "release" && f.path !== "refund") return usage("--path must be release or refund");
  return null;
}

