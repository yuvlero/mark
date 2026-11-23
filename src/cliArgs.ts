/** CLI usage checks (pure; tested without spawning). */
import { str as s } from "./util.js";
import { MarkError } from "./errors.js";
import { SWAP_MARKUP_BPS, pct } from "./swap/stable.js";
export function parseArgs(argv: string[]) {
  const pos: string[] = []; const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); if (v !== undefined) f[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith("--")) f[k] = argv[++i]; else f[k] = true; }
    else pos.push(a);
  }
  return { pos, f };
}
/** Per-subcommand usage, shown on a usage error. */
export const ESCROW_USAGE: Record<string, string> = {
  create: "mark escrow create --role buyer|seller --counterparty <xonly pubkey> --sats N --deadline <seconds|ISO> --title <short> --description <text> [--deliverable <text>] [--acceptance <criteria>] [--deliverable-sha256 <hex>] [--terms-file <json>] [--hash <sha256hex>] [--arbiter auto|manual] [--webhook url]",
  show: "mark escrow show <id>", accept: "mark escrow accept <id> [--allow-counterparty-rule]",
  evidence: "mark escrow evidence <id> [--text \"...\" (alias --note)] [--sha256 <hex> | --file <path> (hashed locally, not uploaded)] [--url <https://...>]",
  fund: "mark escrow fund <id> [--wait] [--timeout <sec>] [--allow-counterparty-rule] [--switch-rail]   (Lightning invoice via a Satora swap) | mark escrow fund <id> --ark [--wait] [--timeout <sec>] [--switch-rail]   (direct Ark payment, no swap fee: prints the escrow address, the exact sats and the Arkade server; pay it in ONE payment from an Arkade wallet on that server. Bark / Second Ark wallets cannot pay it: use Lightning) | mark escrow fund <id> --resume-claim   (finish or retry the claim of an already paid funding swap into the escrow; never creates an invoice)", status: "mark escrow status <id>", limits: "mark escrow limits [--sats N]   (also shows arkade: the Arkade server URL and key this escrow runs on)",
  quote: "mark escrow quote <id> [--path release|refund] [--dest <bolt11|lightning address>]", pending: "mark escrow pending [<id>]   (no id: all my deals)",
  approve: "mark escrow approve <id> [--payout-invoice <bolt11> | --payout-lnaddr <user@domain> | --payout-ark <ark address from an Arkade wallet on this escrow's Arkade server; NOT Bark/Second>] [--kind release|refund] [--with counterparty|arbiter] [--preimage <hex>]",
  dispute: "mark escrow dispute <id> [--reason \"...\"]", refund: "mark escrow refund <id> --payout-invoice <bolt11> | --payout-lnaddr <user@domain> | --payout-ark <Arkade address on this escrow's Arkade server; NOT Bark/Second> [--with arbiter|counterparty]",
  "refund-payout": "mark escrow refund-payout <id> [--to <ark address from an Arkade wallet on this escrow's Arkade server>]",
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
/** `mark swap` (BTC -> USDC / USDT0 on Arbitrum via Satora; standalone, not tied to a deal). Key "create" is plain `mark swap` (`mark swap create` is the same). */
export const SWAP_USAGE: Record<string, string> = {
  quote: `mark swap quote [--from lightning|arkade] [--to usdc|usdt0] --sats N   (rate, Satora fee, the ${pct(SWAP_MARKUP_BPS)} Agent Escrow markup, network fee, total; nothing is created)`,
  create: `mark swap [--from lightning|arkade] [--to usdc|usdt0] --sats N --address <0x... on Arbitrum> [--yes] [--wait] [--timeout <sec>]   (no --yes: preview only, nothing is created. Includes a ${pct(SWAP_MARKUP_BPS)} Agent Escrow fee)`,
  status: "mark swap status <id>",
  claim: "mark swap claim <id> [--wait] [--timeout <sec>]   (claim a paid swap's stablecoins to its address; --wait first waits for Satora to fund its side; safe to repeat)",
  refund: "mark swap refund <id> --to <ark address from an Arkade wallet on https://arkade.computer>   (Arkade-funded swap that did not pay out, after its timelock)",
};
const SWAP_SUBS = ["quote", "create", "status", "claim", "refund"];
/** `mark swap ...` usage checks before any key or network access. */
export function checkSwapArgs(sub: string | undefined, id: string | undefined, f: Record<string, string | boolean>) {
  const key = sub ?? "create";
  const usage = (msg: string) => new MarkError("USAGE", `${msg}. usage: ${SWAP_USAGE[key] ?? Object.values(SWAP_USAGE).join(" | ")}`, { usage: SWAP_USAGE[key] ?? SWAP_USAGE });
  if (sub !== undefined && !SWAP_SUBS.includes(sub)) return usage(`unknown swap subcommand '${sub}' (one of: ${SWAP_SUBS.join(", ")}; none = create)`);
  for (const k of ["yes", "wait"]) { if (f[k] !== undefined && f[k] !== true) return usage(`--${k} takes no value`); if (f[k] !== undefined && !(key === "create" || (k === "wait" && key === "claim"))) return usage(k === "wait" ? "--wait is only for mark swap (create) and mark swap claim" : "--yes is only for mark swap (create)"); }
  for (const [k, v] of Object.entries(f)) if (v === true && !["yes", "wait", "json"].includes(k)) return usage(`--${k} needs a value`);
  if ((key === "create" || key === "quote") && f.sats === undefined) return usage("--sats is required");
  if (f.sats !== undefined && !/^\d+$/.test(String(f.sats))) return usage("--sats must be a whole number of sats");
  if (f.timeout !== undefined && !/^\d+$/.test(String(f.timeout))) return usage("--timeout must be a whole number of seconds");
  if (f.timeout !== undefined && !(key === "create" || key === "claim")) return usage("--timeout is only for mark swap (create) and mark swap claim");
  if (key !== "create" && key !== "quote") for (const k of ["from", "address", "sats", ...(key === "refund" ? [] : ["to"])]) if (f[k] !== undefined) return usage(`--${k} is only for mark swap and mark swap quote`);
  if (f.from !== undefined && !["lightning", "arkade"].includes(String(f.from).toLowerCase())) return usage("--from must be lightning or arkade");
  if (key !== "refund" && f.to !== undefined && !["usdc", "usdt0", "usdt"].includes(String(f.to).toLowerCase())) return usage("--to must be usdc or usdt0");
  if (key === "create" && !s(f.address)) return usage("--address <your 0x address on Arbitrum> is required");
  if (["status", "claim", "refund"].includes(key) && !id) return usage("swap id required");
  if (key === "refund" && !s(f.to)) return usage("--to <ark address> is required");
  return null;
}
const NEEDS_ID = new Set(["show", "accept", "evidence", "fund", "status", "quote", "approve", "dispute", "refund", "refund-payout", "messages", "message"]);
/** Usage checks before any network/keystore access: unknown subcommand, missing id, missing/ambiguous flags. */
export function checkEscrowArgs(sub: string | undefined, id: string | undefined, f: Record<string, string | boolean>) {
  const usage = (msg: string) => new MarkError("USAGE", `${msg}. usage: ${ESCROW_USAGE[sub!] ?? Object.values(ESCROW_USAGE).join(" | ")}`, { usage: sub && ESCROW_USAGE[sub] ? ESCROW_USAGE[sub] : ESCROW_USAGE });
  if (!sub || !ESCROW_USAGE[sub]) return usage(sub ? `unknown escrow subcommand '${sub}' (one of: ${Object.keys(ESCROW_USAGE).join(", ")})` : "escrow subcommand required");
  if (NEEDS_ID.has(sub) && !id) return usage("escrow id required");
  for (const [k, v] of Object.entries(f)) if (v === true && !["wait", "json", "all", "allow-counterparty-rule", "resume-claim", "ark", "switch-rail"].includes(k)) return usage(`--${k} needs a value`);
  if (sub === "create") { const miss = ["role", "counterparty", "sats", "deadline"].filter((k) => !s(f[k])); if (miss.length) return usage(`missing ${miss.map((k) => "--" + k).join(", ")}`); if (!/^\d+$/.test(s(f.sats)!)) return usage("--sats must be a whole number of sats"); }
  if (sub === "limits" && f.sats !== undefined && !/^\d+$/.test(String(f.sats))) return usage("--sats must be a whole number of sats");
  if (sub === "evidence") { if (s(f.text) && s(f.note) && s(f.text) !== s(f.note)) return usage("pass --text or --note, not both"); if (!s(f.text) && !s(f.note) && !s(f.file)) return usage("evidence text required (--text or --note), or --file <path>"); }
  if (sub === "message" && !s(f.text) && !s(f.note)) return usage("message text required (--text)");
  if (sub === "message" && f.kind !== undefined && !["question", "dispute", "evidence", "info"].includes(String(f.kind))) return usage("--kind must be question|dispute|evidence|info");
  if (sub === "invites" && f.needs !== undefined && !["accept", "fund", "sign", "any"].includes(String(f.needs))) return usage("--needs must be accept|fund|sign|any");
  if (sub === "messages" && f.since !== undefined && !/^\d+$/.test(String(f.since))) return usage("--since must be a cursor (integer)");
  if (f["resume-claim"] !== undefined && sub !== "fund") return usage("--resume-claim is only for escrow fund");
  if (sub === "fund" && f["resume-claim"] !== undefined && f["resume-claim"] !== true) return usage("--resume-claim takes no value");
  if (sub === "fund" && f["resume-claim"] === true && f.wait !== undefined) return usage("--resume-claim does not wait: run it without --wait");
  for (const k of ["ark", "switch-rail"]) {
    if (f[k] !== undefined && sub !== "fund") return usage(`--${k} is only for escrow fund`);
    if (sub === "fund" && f[k] !== undefined && f[k] !== true) return usage(`--${k} takes no value (put the escrow id before it: mark escrow fund <id> --${k})`);
  }
  if (sub === "fund" && f.ark === true && f["resume-claim"] !== undefined) return usage("--resume-claim is for a Lightning funding swap, not --ark");
  if (sub === "quote" && f.path !== undefined && f.path !== "release" && f.path !== "refund") return usage("--path must be release or refund");
  return null;
}

/** `--help` / `-h` / `help` after a command: that command's usage (the CLI prints it, exit 0) before any check, key or network
 *  access. `mark escrow --help fund` (the flag took the word as its value) also works. null: not a help request, or no command
 *  (plain `mark` / `mark --help` print the full usage and quickstart). */
export function helpFor(pos: string[], f: Record<string, string | boolean>, mainUsage: string): { usage: unknown } | null {
  const word = typeof f.help === "string" ? f.help : undefined;
  if (!pos[0] || (f.help === undefined && !pos.includes("-h") && pos[1] !== "help")) return null;
  if (pos[0] === "demo") return { usage: DEMO_USAGE };
  if (pos[0] === "escrow") { const sub = [pos[1], word].find((x) => x && x !== "help" && x !== "-h" && Object.hasOwn(ESCROW_USAGE, x)); return { usage: sub ? ESCROW_USAGE[sub] : ESCROW_USAGE }; }
  if (pos[0] === "swap") { const sub = [pos[1], word].find((x) => x && x !== "help" && x !== "-h" && Object.hasOwn(SWAP_USAGE, x)); return { usage: sub ? SWAP_USAGE[sub] : SWAP_USAGE }; }
  if (pos[0] === "reputation") return { usage: "mark reputation <pubkey>  (64-hex x-only key; public aggregates from the escrow server)" };
  return { usage: mainUsage };
}
